import { stopAgent, privy } from "@/lib/mcp/hosted";
import { hostedEnabled, supabaseServer } from "@/lib/oauth/server";
import { endAllSessions } from "@/lib/oauth/sessions";

/// The Stop page's request. The person's fresh sign-in token is what
/// authorizes removing Remesso, because Privy lets only the owner change a
/// wallet's signers; this route cannot do it on anyone's behalf without one.
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function POST(req: Request) {
  if (!hostedEnabled()) return json({ error: "hands-free payments are not open" }, 403);
  const { access_token } = (await req.json().catch(() => ({}))) as { access_token?: string };
  if (!access_token) return json({ error: "sign in with your email code first" }, 401);
  const { data, error } = await supabaseServer().auth.getUser(access_token);
  if (error || !data.user) return json({ error: "that sign-in has expired; enter a new code" }, 401);

  try {
    const r = await stopAgent(data.user.id, access_token);
    if (r.stopped) {
      const person = await privy().users().getByCustomAuthID({ custom_user_id: data.user.id });
      await endAllSessions(person.id);
    }
    return json(r);
  } catch (e) {
    console.error("stopAgent failed:", (e as Error).message);
    return json({ error: "Couldn't reach the wallet service. Try again in a minute." }, 502);
  }
}
