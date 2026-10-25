// (cd web && deno test --unstable-sloppy-imports lib/payee-profile.test.ts)   # from web/: needs its node_modules
//
// Pins how `find_agent` reads an agent's payee profile (docs/agent-to-agent.md,
// 3d): every kind of token URI, the `remesso` entry, and the rule that an
// unknown version is no profile. Nothing here may yield an address to pay.
import { assertEquals } from "jsr:@std/assert@1";
import { payeeProfile, uriSource } from "./payee-profile";

const ENTRY = {
  name: "remesso",
  endpoint: "https://engaboljiqudghvzmebq.supabase.co/functions/v1/request-payment",
  version: "1",
  assets: [
    { network: "eip155:42220", asset: "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e" },
    { network: "eip155:42220", asset: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" },
  ],
  reference: { required: true },
  // A field this reader doesn't know: ignored.
  colour: "teal",
};
const FILE = { type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1", name: "Payee", services: [{ name: "MCP", endpoint: "https://x/mcp" }, ENTRY] };

Deno.test("data: URIs, base64 or not; https and ipfs to fetch", () => {
  const json = JSON.stringify(FILE);
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
  assertEquals(uriSource(`data:application/json;base64,${b64}`), { kind: "inline", json });
  assertEquals(uriSource(`data:application/json,${encodeURIComponent(json)}`), { kind: "inline", json });
  assertEquals(uriSource("https://agent.example/registration.json"), { kind: "fetch", url: "https://agent.example/registration.json" });
  assertEquals(uriSource("ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/agent.json"), {
    kind: "fetch",
    url: "https://ipfs.io/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/agent.json",
  });
  assertEquals(uriSource("http://agent.example/x").kind, "unsupported");
  assertEquals(uriSource("ipfs://not a cid").kind, "unsupported");
  assertEquals(uriSource("data:application/json;base64,%%%").kind, "unsupported");
});

Deno.test("the remesso entry, with unknown fields ignored", () => {
  assertEquals(payeeProfile(FILE), {
    profile: {
      version: "1",
      endpoint: ENTRY.endpoint,
      assets: ENTRY.assets,
      reference: { required: true },
    },
  });
});

Deno.test("an unknown version is no profile, and so is no entry", () => {
  assertEquals(payeeProfile({ services: [{ ...ENTRY, version: "2" }] }).profile, null);
  assertEquals(payeeProfile({ services: [{ name: "MCP", endpoint: "https://x" }] }).profile, null);
  assertEquals(payeeProfile("not json").profile, null);
});

Deno.test("the older `endpoints` name is read too, and bad assets are dropped", () => {
  const out = payeeProfile({
    endpoints: [{ ...ENTRY, assets: [{ network: "celo", asset: "0x1" }, ENTRY.assets[0]], reference: undefined, endpoint: "http://plain" }],
  });
  assertEquals(out.profile?.assets, [ENTRY.assets[0]]);
  assertEquals(out.profile?.reference, null, "no reference: none needed");
  assertEquals(out.profile?.endpoint, null, "only an https endpoint is kept");
});

Deno.test("an address written in the file is never returned", () => {
  const out = payeeProfile({ services: [ENTRY, { name: "agentWallet", endpoint: "eip155:42220:0x000000000000000000000000000000000000dEaD" }] });
  assertEquals(JSON.stringify(out).includes("dEaD"), false);
});
