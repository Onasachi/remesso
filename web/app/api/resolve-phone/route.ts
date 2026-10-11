import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import "server-only";
import { OdisQuotaExhausted, resolveMiniPayPhone } from "@/lib/odis";
import { maskPhone, toE164 } from "@/lib/phone";

export const dynamic = "force-dynamic";
// web3 1.x and the BLS blinding in @celo/identity need Node, not the edge.
export const runtime = "nodejs";

/// Phone number in, MiniPay wallet out — for the MiniPay send form, where
/// typing an address is not allowed.
///
/// The address IS returned to the browser: the sender's wallet has to put it
/// in `createSchedule`, and the contract pins it. What MiniPay forbids is
/// showing it, and the form does not. The full number is not stored anywhere;
/// the masked form comes back for the form to show and save.
///
/// Metered per session (`note_phone_lookup`, 20 a day) before ODIS is asked,
/// because each lookup spends quota we paid for and reveals whether a number
/// has a wallet.
export async function POST(req: Request) {
  const authorization = req.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "sign in to continue" }, { status: 401 });
  }

  let phone: string | undefined;
  try {
    ({ phone } = await req.json());
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
  const e164 = toE164(phone ?? "");
  if (!e164) {
    return NextResponse.json(
      { error: "Enter the full number with its country code, like +234 803 123 4567." },
      { status: 400 },
    );
  }

  // The caller's own JWT, so auth.uid() inside the function is them.
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } },
  );
  const { error: meterErr } = await sb.rpc("note_phone_lookup", { p_daily_limit: 20 });
  if (meterErr) {
    const limited = /limit/i.test(meterErr.message);
    return NextResponse.json(
      { error: limited ? "You have looked up a lot of numbers today. Try again tomorrow." : "sign in to continue" },
      { status: limited ? 429 : 401 },
    );
  }

  try {
    const address = await resolveMiniPayPhone(e164);
    return NextResponse.json({ found: Boolean(address), address, masked: maskPhone(e164) });
  } catch (e) {
    // Logged with the reason, never the number.
    console.error("phone lookup failed:", (e as Error).message);
    if (e instanceof OdisQuotaExhausted) {
      return NextResponse.json(
        { error: "Phone lookup is unavailable right now. Please try again later." },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: "Could not look up that number. Try again." }, { status: 502 });
  }
}
