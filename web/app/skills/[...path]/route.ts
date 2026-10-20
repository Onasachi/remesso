import { NextResponse } from "next/server";

/// `/skills/…` — the agent skills and their manifests, at this origin.
///
/// Same arrangement as `/skill.md`: a redirect to the canonical file in the
/// repo, never a copy, so the manifest an agent reads here is the one
/// `scripts/build-skill-manifest.ts` generated from the live 402. Allowlisted
/// rather than proxying any path: this is a set of published files, not a
/// window onto the repository.
export const dynamic = "force-static";

const RAW = "https://bitbucket.org/crackedstudios/remesso/raw/main/skills";
const PUBLISHED = new Set([
  "manifest.json",
  "manifest.schema.json",
  "remesso/SKILL.md",
  "remesso-x402/SKILL.md",
  "remesso-x402/manifest.json",
  "remesso-x402/scripts/pay.mjs",
]);

export function generateStaticParams() {
  return [...PUBLISHED].map((p) => ({ path: p.split("/") }));
}

export async function GET(_req: Request, { params }: { params: { path: string[] } }) {
  const path = params.path.join("/");
  if (!PUBLISHED.has(path)) {
    return NextResponse.json({ error: "not a published skill file", index: "/skills/manifest.json" }, { status: 404 });
  }
  // 307 for the same reason as /skill.md: a permanent redirect would outlive
  // a move of the canonical files.
  return NextResponse.redirect(`${RAW}/${path}`, {
    status: 307,
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}
