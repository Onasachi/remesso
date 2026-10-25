/// Manage the webhooks for a receiving address: subscribe, rotate the secret,
/// revoke, replay failed deliveries (docs/agent-to-agent.md, 3c).
///
/// Public, with `verify_jwt = false`, like `request-payment`: callers are
/// agents and servers with no Supabase account. The authentication is the
/// recipient's own EIP-712 signature over the request, checked here; without
/// it anyone could fill an address's subscription slots, or point its
/// deliveries at their own server. The endpoint must also echo a challenge
/// before anything is sent to it. `deliver-webhooks` does the sending.
import { createClient } from "npm:@supabase/supabase-js@2";
import { publicClient } from "../_shared/celo.ts";
import { safeFetch } from "../_shared/safe-fetch.ts";
import { handle } from "./handler.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

Deno.serve((req) =>
  handle(req, {
    db,
    verify: (args) => publicClient.verifyTypedData(args),
    challenge: async (url, headers, body) => {
      const res = await safeFetch(url, { method: "POST", headers, body }, { timeoutMs: 10_000, maxBytes: 16 * 1024 });
      return { status: res.status, text: res.text };
    },
  })
);
