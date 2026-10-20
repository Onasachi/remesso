/// Claude's sign-in sessions, without keeping anyone's own sign-in.
///
/// Claude's refresh token is our own JWT. Rotation and reuse detection need
/// one fact per session, the id of the newest refresh token, and that is kept
/// on the person's Privy profile (custom metadata), keyed by the client. So
/// Remesso stores no Supabase session after the moment a person taps Allow,
/// and holds nothing that could act as them in Privy afterwards.

import { createHash, randomBytes } from "node:crypto";
import { privy } from "@/lib/mcp/hosted";
import { sign, verify, type Claims } from "@/lib/oauth/tokens";

export const REFRESH_TTL = 30 * 24 * 60 * 60;

export type Refresh = Claims & { sub: string; pid: string; cid: string; email: string; jti: string };

const slot = (cid: string) => `rt_${createHash("sha256").update(cid).digest("hex").slice(0, 12)}`;

async function metadata(pid: string): Promise<Record<string, string | number | boolean>> {
  return (await privy().users()._get(pid)).custom_metadata ?? {};
}
async function setSlot(pid: string, key: string, value: string | null) {
  const md = { ...(await metadata(pid)) };
  if (value === null) delete md[key];
  else md[key] = value;
  await privy().users().setCustomMetadata(pid, { custom_metadata: md });
}

export async function newRefresh(r: { sub: string; pid: string; cid: string; email: string }): Promise<string> {
  const jti = randomBytes(16).toString("base64url");
  await setSlot(r.pid, slot(r.cid), jti);
  return sign({ typ: "rt", ...r, jti, exp: Math.floor(Date.now() / 1000) + REFRESH_TTL });
}

/// The claims of a current refresh token, or null. A replayed old token means
/// someone else holds a copy, so that session is ended for everyone.
export async function useRefresh(token: string, clientId: string): Promise<Refresh | null> {
  const r = verify<Refresh>(token, "rt");
  if (!r || r.cid !== clientId) return null;
  const current = (await metadata(r.pid))[slot(r.cid)];
  if (current !== r.jti) {
    if (current) await setSlot(r.pid, slot(r.cid), null);
    return null;
  }
  return r;
}

/// The Stop page: every Claude session for this person ends.
export async function endAllSessions(pid: string) {
  const md = await metadata(pid);
  const keep = Object.fromEntries(Object.entries(md).filter(([k]) => !k.startsWith("rt_")));
  await privy().users().setCustomMetadata(pid, { custom_metadata: keep });
}
