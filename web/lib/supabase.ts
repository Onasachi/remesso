"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (!client) {
    client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: true, autoRefreshToken: true } },
    );
  }
  return client;
}

/// A session, creating one if there is none.
///
/// Anonymous sign-in is how this app has a session at all, and `ensureSender`
/// only runs it once a wallet is connected. Anything that calls an API before
/// that — or on a fresh origin, where the previous origin's stored session
/// does not exist — would otherwise send no token and be told to "sign in",
/// which is not an instruction anyone can follow: there is no sign-in screen.
///
/// Returns null only if sign-in genuinely fails, which the caller surfaces.
export async function ensureSession(): Promise<string | null> {
  const sb = supabase();
  const { data: { session } } = await sb.auth.getSession();
  if (session) return session.access_token;

  const { data, error } = await sb.auth.signInAnonymously();
  if (error) {
    console.error("anonymous sign-in failed:", error.message);
    return null;
  }
  return data.session?.access_token ?? null;
}

/// Bind a connected wallet to a Supabase session.
///
/// This is anonymous auth, not proof of wallet ownership, and the reason is
/// MiniPay: it does not support message signing, so SIWE — the normal way to
/// prove an address — is unavailable to most of this audience.
///
/// What that does and does not cost us:
///   - It does NOT weaken the money path. The contract checks `msg.sender`
///     against the schedule owner for pause and cancel, and the executor can
///     only ever pay the destination the sender signed. Nothing in this
///     database can move funds.
///   - It DOES mean the `senders` row is a claim rather than a proof, and the
///     unique constraint on `wallet_address` makes claiming first-come. A
///     squatter could block an address from being registered.
///
/// See README "Sender identity" for the fix once a signing path exists.
export async function ensureSender(walletAddress: string) {
  const sb = supabase();
  if (!(await ensureSession())) throw new Error("could not start a session");

  // One round trip, and it is the database's job because only it can see rows
  // this session does not own. A wallet already bound to another anonymous
  // session — a different origin, cleared storage, a new phone — is re-bound
  // here rather than colliding with the unique constraint and stranding the
  // app with no sender row. See the 20260924 migration for what that trades.
  const { data, error } = await sb.rpc("claim_sender", {
    p_wallet: walletAddress.toLowerCase(),
  });
  if (error) throw new Error(claimMessage(error.message));
  return data as string;
}

function claimMessage(msg: string): string {
  return /not signed in/i.test(msg)
    ? "Couldn't start a session. Check your connection and reopen Remesso."
    : msg;
}

/// The reason an Edge Function gave, rather than supabase-js's generic
/// "Edge Function returned a non-2xx status code". The body is ours and
/// carries `{ error, detail? }`.
export async function functionError(e: unknown): Promise<string> {
  const ctx = (e as { context?: unknown }).context;
  if (ctx instanceof Response) {
    try {
      const b = await ctx.clone().json();
      if (b && typeof b.error === "string") return b.detail ? `${b.error}: ${b.detail}` : b.error;
    } catch {
      // Not JSON; fall through.
    }
  }
  return (e as Error).message ?? String(e);
}
