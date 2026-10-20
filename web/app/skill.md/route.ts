import { NextResponse } from "next/server";

/// `/skill.md` — the integration guide, at the URL the convention expects.
///
/// Celo serves theirs at `x402.celo.org/skill.md`, and an agent told to "read
/// <origin>/skill.md" should not have to be told anything else. This is that
/// URL for Remesso.
///
/// A redirect rather than a copy, deliberately. The canonical file is
/// `skills/remesso/SKILL.md` in the repo, because that is where
/// the repo and the remesso-wallet npm package ship it. Serving a second copy
/// from here would mean two files saying what the prices are, and the stale
/// ERC-8004 entry was the lesson about what happens to the copy nobody
/// remembers to update. One file, two addresses to reach it.
export const dynamic = "force-static";

const CANONICAL =
  "https://bitbucket.org/crackedstudios/remesso/raw/main/skills/remesso/SKILL.md";

export async function GET() {
  // 307, not 301: if the canonical location ever moves — a docs site, a
  // domain of our own — a permanent redirect would already be cached in
  // clients we cannot reach.
  return NextResponse.redirect(CANONICAL, {
    status: 307,
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}
