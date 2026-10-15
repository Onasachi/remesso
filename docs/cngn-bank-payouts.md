# Naira bank payouts through the cNGN API

**Status: built, tested, and switched off.** This is the operating guide for
the part of Remesso that pays naira into a Nigerian bank account by redeeming
cNGN through cNGN's own API. It is off in both the app
(`NEXT_PUBLIC_ENABLE_CNGN_RAILS`) and the backend (`ENABLE_CNGN_RAILS`, read by
`supabase/functions/_shared/rails.ts`), for the reasons under
[Before switching it on](#before-switching-it-on).

Do not confuse it with what is live. Remesso pays **cNGN itself** today, on the
Direct rail: the recipient receives the token, and anyone holding cNGN can
cash it out to a bank on Textile (Withdraw NGN, paid out by Noblocks). That
needs none of the cNGN API, and none of this document.

The contract keeps both swap rails compiled in. V4 is immutable, so switching
them back on is two environment flags and the work below, not a redeploy.

| | |
|---|---|
| cNGN (Celo) | `0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f`, **6 decimals**. Mento's unrelated `NGNm` is 18dp, so confusing them is a factor of 10¹². |
| Uniswap SwapRouter02 | `0x5615CDAb10dc425a742d643d949a7F474C01abc4` |
| cNGN/USDT pool | `0x6519d56eb0a69fc0338657784c783b169b8f7d32`, 0.01% tier |

---

## Before switching it on

- **Regulatory.** `redeemAsset` puts Remesso in the business of instructing
  naira payouts to third parties. That is a money-transmission question for a
  Nigerian fintech lawyer, and it is the reason this is off.
- **The cNGN merchant account must be verified.** It costs ₦100,000 plus KYB.
  `redeemAsset` does not work until that is complete.
- **cNGN must whitelist the live executor** (V4, `0x288b…6009`) as an external
  sender, or a transfer from it will not burn. V1 had exactly this defect: a
  Uniswap swap made the *pool* the transferor. V2 onwards swaps to itself and
  forwards with `safeTransfer`, so a single address is the sender of record,
  and each new deployment needs whitelisting again.
- **Redemption-address stability is unanswered by cNGN.** `redeemAsset`
  returns a deposit address per redemption, while the contract fixes
  `destination` at signing. `execute-due-runs` aborts before spending gas if the
  two differ. If cNGN does rotate addresses, the schedule needs a
  sender-approved allowlist instead of a single address.
- **A fixed-IP egress proxy** must be running (see below).

## Why bank payouts settle in two steps

`redeemAsset` returns a deposit address; cNGN is then sent there and naira is
paid out. So an `ngn_bank` run goes `pending → swapping → redeeming → paid_out`,
and only the `redemption.completed` webhook advances the last step. A run whose
swap has settled has **not** delivered cash — showing a sender "settled" at that
point is the failure mode this schema is shaped to prevent.

---

## Liquidity for the swap rail

There is exactly **one** cNGN venue on Celo — the Uniswap V3 pool above. It
holds roughly 118M cNGN and 95k USDT. Measured via QuoterV2 on 2026-09-07:

| Trade | Slippage |
|---|---|
| $100 | 0.005% |
| $1,000 | 0.055% |
| $2,500 | 0.14% |
| $5,000 | 0.27% |
| $10,000 | 0.55% |

Re-measured via QuoterV2 on 2026-09-14: the pool held 93,611 USDT and 119.6M
cNGN, and spot was ₦1,369.28/USDT. `liquidityIsHealthy` aborts above 150bps,
which this pool does not reach until roughly $27–30k.

Spot was ₦1,368/USDT, sitting sensibly between the official NFEM rate (₦1,329)
and the parallel market (₦1,395–1,410).

For remittance-sized transfers this is effectively free. Two consequences are
baked into the code:

1. `LIMITS.maxRunAmountUsdt` caps a single run well below the point where
   slippage bites, and `liquidityIsHealthy()` aborts a run the pool cannot fill
   cheaply rather than executing it at any price.
2. **About 76% of all cNGN on Celo sits in that one pool.** One LP withdrawal
   removes the entire swap route. Treat the swap as a replaceable component:
   Textile FX (OTC, 78 onboarded Nigerian firms) is the venue for size, and
   minting cNGN directly through ASC is the endgame. Do not let the Uniswap call
   leak beyond `_shared/celo.ts`.

---

## The cNGN integration

Implemented against the published spec at `docs.cngn.co`, not against
assumptions. Four properties of that API drive the code:

**Requests are encrypted, responses are sealed.** POST and PUT bodies go out as
`{content, iv}` — AES-256-CBC under a key derived by SHA-256'ing the dashboard
encryption key. Every *successful* response comes back as
`{status, message, data}` where `data` is a base64 libsodium `crypto_box`
sealed to your Ed25519 public key: `nonce(24) || ciphertext || ephemeral pk(32)`.
It is an opaque string on the wire, so reading a field off it without opening it
first silently yields `undefined`.

`supabase/functions/_shared/cngn.test.ts` verifies both directions against the
docs' own reference implementations — our AES ciphertext is byte-identical to
what Node's `createCipheriv` produces, and the tests play the role of the cNGN
server, sealing payloads to a freshly generated `ssh-keygen` key and requiring
the client to open them. Run it with:

```bash
deno test --allow-env --allow-read --allow-write --allow-run --allow-net \
  supabase/functions/_shared/cngn.test.ts
```

**The rate limit is 20 requests per 60 seconds per API key, and breaching it
blocks the key for another 60 seconds.** That makes the limiter in `cngn.ts` a
correctness feature rather than politeness: one burst of bank-list lookups from
a signup page would otherwise strand an in-flight redemption. Banks and networks
are cached for six hours in the Edge Function and again for twelve in the Next
route handler, which is what the docs advise.

**Webhooks are delivered exactly once.** *"Deliveries are sent once, with a
10-second timeout, and are not automatically retried."* A 500 from us — a cold
start, a deploy landing mid-delivery — loses the event permanently and leaves a
run stuck in `redeeming` while the recipient has in fact been paid. So
`cngn-webhook` persists and acknowledges before doing any work, and
`reconcile-redemptions` polls `/transactions` every ten minutes for anything
still open. The webhook is the fast path; the transactions API is the authority.

**Only four endpoints are on the money path**, and they are deliberately split
by who can reach them:

| | Reachable from | Notes |
|---|---|---|
| `GET /banks` | `cngn-proxy` (signed-in senders) | Cached hard; ~900 rows |
| `POST /account/verify` | `cngn-proxy` (signed-in senders) | At onboarding only, never at payout |
| `POST /redeemAsset` | `execute-due-runs` only | Requires the "Redeem" permission |
| `GET /transactions` | `reconcile-redemptions` only | Settlement of record |

Note the path is `/account/verify`, not `/verifyAccountDetails` — an earlier
draft of this repo had the latter, which does not exist.

---

## Getting cNGN credentials

Everything below comes from the merchant dashboard, and **each environment has
its own complete set**. A `cngn_test_` key with a live encryption key fails; so
does a live key against the SSH key you uploaded for test.

1. **Onboard as a merchant.** Sandbox access needs an account. Live keys are
   issued only after KYB completes: business documents, identity verification
   for account owners, and the onboarding fee. This gates the entire live path,
   so start it early — it is not a same-day step.

2. **API key and encryption key.** Dashboard → **Settings → API Key**. Both are
   already generated; reveal with the eye icon and copy with the clipboard icon.
   The prefix picks the environment (`cngn_test_…` / `cngn_live_…`); the base
   URL is the same either way.
   → `CNGN_API_KEY`, `CNGN_ENCRYPTION_KEY`

3. **Ed25519 keypair — you generate this, not cNGN.**

   ```bash
   ssh-keygen -t ed25519 -C "api@remesso" -f cngn_api_key
   ```

   Paste `cngn_api_key.pub` into the **SSH public key** field on the same tab.
   Keep the private half. Without it every request fails with
   `No Test SSH Key found`, and nothing the API returns is readable.
   → `CNGN_SSH_PRIVATE_KEY` (the private half; escaped `\n` is fine)

   **Take the default of no passphrase.** cNGN's guide offers one, but the
   executor runs unattended and has nothing to prompt with — a passphrase
   encrypts the key body and the private key cannot be loaded at all. If you
   already set one, strip it; the public key is unchanged, so the dashboard
   needs no update:

   ```bash
   ssh-keygen -p -N "" -f cngn_api_key
   ```

   The four ways this goes wrong — passphrase, the `.pub` file pasted instead
   of the private half, an RSA key, and a truncated paste — each fail with a
   message naming the actual problem rather than a generic parse error. They
   are covered in `cngn.test.ts`, because the failure they'd otherwise produce
   is an unexplained key mismatch hours later.

4. **Permissions.** An organisation admin grants these per key. Remesso needs
   **Redeem**. Without it `redeemAsset` returns `{"status": false, "message":
   "Permission denied"}` — note that shape: the HTTP status is not the whole
   story, which is why the client checks both.

5. **IP whitelist.** Dashboard security settings. See below — this is the part
   that does not have a clean answer yet.

6. **Webhook signing secret.** Dashboard → webhooks. Set the URL to
   `https://<ref>.supabase.co/functions/v1/cngn-webhook` and subscribe to
   `redemption.completed` and `transaction.failed` at minimum.
   → `CNGN_WEBHOOK_SECRET`

```bash
# Prove the credentials before wiring anything up. /balance needs no request
# encryption, so a 200 here means the key, the IP and the SSH key are all good.
curl -s -X GET "https://api.cngn.co/v1/api/balance" \
  -H "Authorization: Bearer $CNGN_API_KEY"
```

The `data` field of that response will be an unreadable base64 string. That is
correct — it is sealed to your public key.

### cNGN egress: the IP whitelist problem

cNGN checks the source IP of every request against a dashboard whitelist and
answers `403 IP address not whitelisted` regardless of credentials. Supabase
Edge Functions run on a large, dynamic pool of addresses, so **there is nothing
stable to whitelist.** This is a deployment blocker for the live environment,
not a code problem, and it has three possible answers:

**cNGN confirmed 2026-09-10: static IP only, no CIDR.** That settles it — there
is no arrangement under which Supabase's rotating egress can be whitelisted, so
cNGN traffic has to leave from one fixed address.

1. **A fixed-IP forward proxy — the recommended path.** Set
   `CNGN_EGRESS_PROXY_URL` and `cngn.ts` routes every cNGN call through it,
   throwing a clear error rather than silently going direct if the runtime
   cannot. Verified 2026-09-10 that the Supabase Edge Runtime
   (supabase-edge-runtime-1.76.0, Deno 2.1.4) does expose
   `Deno.createHttpClient` and accepts a proxy config, so this works without
   moving anything. A small VPS running tinyproxy, a Fly.io machine with a
   dedicated IPv4, or a managed static-IP proxy all satisfy it.
2. Move the cNGN-touching functions onto a host that has a static egress IP.

The 403 was reproduced directly: `GET /balance` with the live key returns
`{"status":403,"message":"IP address not whitelisted"}`, and an empty IP Access
List blocks everything rather than allowing everything.
