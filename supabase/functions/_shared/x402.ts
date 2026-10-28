import { ATTRIBUTION_CODES } from "./attribution.ts";
import { directToken } from "./config.ts";
/// x402: charging for a call, over plain HTTP.
///
/// The protocol is three moves. A caller asks for something; we answer 402
/// with exactly what payment we would accept; they retry with a signed
/// authorisation in `X-PAYMENT`. We ask Celo's hosted facilitator to check the
/// signature (`/verify`), do the work, and only then ask it to move the money
/// (`/settle`). The facilitator submits the transfer and pays the gas, so the
/// caller needs no CELO and we run no payment infrastructure.
///
/// Hand-rolled rather than `@x402/hono`: the middleware assumes a Hono server,
/// this is one Deno handler, and the wire format is a 402 body and two
/// authenticated POSTs. Same reasoning as `cngn.ts` and `self.ts`.
///
/// Verify before the work, settle after it. A caller whose run reverts should
/// not be charged, and a caller who is charged should have had their run.
///
/// **We speak v2, and still accept v1.** The 402 we send is v2 — CAIP-2
/// network, `amount` rather than `maxAmountRequired`, a `resource` object, and
/// `accepted` echoed back in the payment. That is not cosmetic: measured on
/// 2026-10-01, `@x402/fetch` 2.28.0 built exactly as Celo's own guide
/// documents refuses a v1 response outright —
///
///   Failed to create payment payload: No client registered for x402 version: 1
///
/// — so every agent reaching for the standard SDK, which is the obvious thing
/// to do, could not pay us at all. Only our own hand-written client could,
/// which is precisely why nothing ever surfaced it.
///
/// Inbound v1 payments are still honoured, because `examples/pay-remesso.ts`
/// spoke v1 and copies of it are already in other people's hands. The
/// facilitator advertises both, so this costs one branch and strands nobody.

export const X402 = {
  get base(): string {
    return (Deno.env.get("X402_FACILITATOR") ?? "https://api.x402.celo.org").replace(/\/+$/, "");
  },
  /// `x402_…`, from the dashboard at x402.celo.org. Metering and settlement
  /// credits hang off it.
  get apiKey(): string {
    return Deno.env.get("X402_API_KEY") ?? "";
  },
  /// What one call costs, in USDC base units. 6dp, so 10_000 is one cent.
  get priceUnits(): string {
    return Deno.env.get("X402_PRICE_UNITS") ?? "10000";
  },
  /// Where the money goes. The treasury, not the hot executor key.
  get payTo(): string {
    return Deno.env.get("X402_PAY_TO") ?? "";
  },
  get isConfigured(): boolean {
    return Boolean(this.apiKey && /^0x[a-fA-F0-9]{40}$/.test(this.payTo));
  },
};

/// The assets this seller takes, each with the EIP-712 domain its token
/// actually signs under, and how it settles. The payer needs no native CELO
/// whichever one they pick:
///
///  - USDC, USD₮ and USA₮ are 6dp and EIP-3009: the payer signs a transfer
///    authorisation and the facilitator submits it.
///  - Ripio's six wFIAT are 18dp and have no EIP-3009, so they settle through
///    Permit2 (`assetTransferMethod: "permit2"` in `extra`), and the 402
///    declares `eip2612GasSponsoring` (`gasSponsoringExtension`): the client
///    then signs an EIP-2612 permit to Permit2 as well, and the facilitator
///    lands it inside the settlement. Celo's facilitator settles all six
///    since 2026-10-27 (`/supported`; names from its token table).
///  - cNGN settles through Permit2 too, but it has no EIP-2612 `permit()`, so
///    a first-time payer must send `approve(Permit2)` themselves and pay CELO
///    for it, and Celo's guide says not to declare gas sponsoring on a cNGN
///    route. One 402 carries one set of extensions, so cNGN is not offered.
///
/// Two traps live in this table, both verified on-chain 2026-09-30:
///
///  1. **`name` is not the symbol.** USAT signs as "Tether America USD" and
///     USDT as "Tether USD". Using the symbol produces a signature that is
///     valid for a domain nobody uses, and the failure surfaces as an opaque
///     rejection rather than "wrong name".
///  2. **Each has an 18-decimal fee-currency adapter reporting the SAME
///     symbol.** USAT's is `0x0357EE22278c922e1D36cFe6b899269b161880C4` and
///     USDT's is `0x0E2A3e05bc9A16F5292A6170456A710cb89C6f72`. Quoting a price
///     against an adapter is a 10^12 error. These addresses are the tokens.
///     USDT's `symbol()` is also literally "USD₮", not "USDT" — one more
///     reason nothing here matches on a symbol.
///
/// Neither token exposes `version()` and `eip712Domain()` reverts on all of
/// them, so these values cannot be read at runtime. They come from the
/// facilitator's own asset table.
export const ASSETS = [
  {
    symbol: "USDC",
    address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as `0x${string}`,
    name: "USDC",
    version: "2",
    decimals: 6,
  },
  {
    // Most widely held of the three on Celo, and the funding asset MiniPay
    // mandates — but second here, because USDC is what the SDK treats as the
    // chain's default asset and a payer with no selector gets `accepts[0]`.
    symbol: "USDT",
    address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e" as `0x${string}`,
    name: "Tether USD",
    version: "1",
    decimals: 6,
  },
  {
    symbol: "USAT",
    address: "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771" as `0x${string}`,
    name: "Tether America USD",
    version: "1",
    decimals: 6,
  },
  // `name` is the token's EIP-712 domain, Spanish and accented: "Real
  // Brasileño" is why the 402 header is UTF-8 (`b64`), not Latin-1.
  { symbol: "wARS", address: "0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D" as `0x${string}`, name: "Peso Argentino", version: "1", decimals: 18, transfer: "permit2" },
  { symbol: "wBRL", address: "0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0" as `0x${string}`, name: "Real Brasileño", version: "1", decimals: 18, transfer: "permit2" },
  { symbol: "wCOP", address: "0x8a1D45e102e886510e891d2Ec656a708991e2D76" as `0x${string}`, name: "Peso Colombiano", version: "1", decimals: 18, transfer: "permit2" },
  { symbol: "wMXN", address: "0x337E7456B420bD3481e7FA61fA9850343d610d34" as `0x${string}`, name: "Peso Mexicano", version: "1", decimals: 18, transfer: "permit2" },
  { symbol: "wCLP", address: "0x61D450a098b6a7f69fC4b98CE68198fe59768651" as `0x${string}`, name: "Peso Chileno", version: "1", decimals: 18, transfer: "permit2" },
  { symbol: "wPEN", address: "0x4F34c8b3b5FB6D98Da888F0feA543d4d9C9F2eBE" as `0x${string}`, name: "Sol Peruano", version: "1", decimals: 18, transfer: "permit2" },
] as const satisfies readonly X402Asset[];

export type X402Asset = {
  symbol: string;
  address: `0x${string}`;
  name: string;
  version: string;
  decimals: number;
  /// Absent means EIP-3009.
  transfer?: "permit2";
};

/// A service's price is set in dollars, 6dp (`"1000"` is $0.001); this is
/// that price in `asset`'s own base units. A peso is not a dollar: 1,000
/// units of USDC are $0.001, and $0.001 in wARS is 1.5 wARS, 1.5×10^18 units.
/// The rate is the backend's own rounded-down `unitsPerUsd`, so one table
/// prices every currency and a local price is a little under the dollar one.
export function amountIn(asset: X402Asset, usdUnits: string): string {
  const rate = directToken(asset.address)?.unitsPerUsd;
  if (!rate) throw new Error(`x402: no unitsPerUsd for ${asset.symbol}; add it to DIRECT_TOKENS`);
  if (asset.decimals < 6) throw new Error(`x402: ${asset.symbol} has fewer than 6 decimals`);
  return (BigInt(usdUnits) * BigInt(rate) * 10n ** BigInt(asset.decimals - 6)).toString();
}

// Every asset must price, or every paid function fails at boot rather than
// quoting one currency at the wrong scale.
for (const a of ASSETS) amountIn(a, "1");

const assetAt = (address: string): X402Asset | undefined =>
  (ASSETS as readonly X402Asset[]).find((a) => a.address.toLowerCase() === address.toLowerCase());

const isPermit2 = (r: PaymentRequirements) => r.extra.assetTransferMethod === "permit2";

/// Kept for the default and for anything still naming one asset.
const USDC: `0x${string}` = ASSETS[0].address;

/// How x402 v1 names this chain: the short name, not CAIP-2.
///
/// The facilitator advertises both — `{x402Version: 1, network: "celo"}` and
/// `{x402Version: 2, network: "eip155:42220"}` — and pairing a version with
/// the other version's name is rejected as `unsupported_scheme`, which reads
/// like a scheme problem and is really a naming one. Seen 2026-09-22.
const NETWORK = Deno.env.get("X402_NETWORK") ?? "eip155:42220";

/// What v1 called this chain. Kept only to verify payments from clients built
/// against the old shape; nothing advertises it any more.
const NETWORK_V1 = "celo";

/// v2's requirements object. Four fields fewer than v1's and one renamed:
/// `amount`, not `maxAmountRequired`. `resource`, `description`, `mimeType`
/// and `outputSchema` moved out of each entry and into the one `resource`
/// object on the envelope, which is the right shape — they describe the thing
/// being sold, not the currency it is sold in.
export type PaymentRequirements = {
  scheme: "exact";
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string; assetTransferMethod?: "permit2" };
};

/// What is being sold, once, rather than repeated per currency.
export type ResourceInfo = {
  url: string;
  description?: string;
  mimeType?: string;
};

/// One entry per asset we accept, which is what the `accepts` array of a 402
/// is for: the payer picks the currency they already hold. Each `amount` is
/// the same dollar price at that asset's own scale (`amountIn`).
export function requirements(): PaymentRequirements[] {
  return (ASSETS as readonly X402Asset[]).map((a) => ({
    scheme: "exact" as const,
    network: NETWORK,
    asset: a.address,
    amount: amountIn(a, X402.priceUnits),
    payTo: X402.payTo,
    // Long enough for a signature round trip, short enough that a stale
    // authorisation cannot be replayed against a later price.
    maxTimeoutSeconds: 60,
    // The EIP-712 domain the payer signs against. Getting this wrong makes
    // every signature invalid for reasons the payer cannot see. Without
    // `assetTransferMethod` a client signs EIP-3009 for a token that has none.
    extra: a.transfer === "permit2"
      ? { name: a.name, version: a.version, assetTransferMethod: "permit2" as const }
      : { name: a.name, version: a.version },
  }));
}

/// Set one dollar price (`units`, 6dp) on every accepted asset at once.
///
/// A helper rather than a `map` at each call site, because forgetting one
/// entry publishes two different prices for the same call and the cheaper one
/// is the one a payer picks.
export function priced(reqs: PaymentRequirements[], units: string): PaymentRequirements[] {
  return reqs.map((r) => {
    const a = assetAt(r.asset);
    if (!a) throw new Error(`x402: ${r.asset} is not an asset this seller prices`);
    return { ...r, amount: amountIn(a, units) };
  });
}

/// A service's price as a document shows it: the dollar price, and the exact
/// amount in each accepted asset. What `/agent` and a service's GET publish,
/// so a payer can read the price in its own currency without a 402.
export function priceList(usdUnits: string) {
  return {
    amount: usdUnits,
    decimals: 6,
    assets: (ASSETS as readonly X402Asset[]).map((a) => ({
      symbol: a.symbol,
      address: a.address,
      decimals: a.decimals,
      amount: amountIn(a, usdUnits),
      transfer: a.transfer ?? "eip3009",
      eip712: { name: a.name, version: a.version },
    })),
  };
}

/// A 402 that both versions can read.
///
/// v2 does not put the price list in the body at all — it goes in a
/// `PAYMENT-REQUIRED` header as base64 JSON, and the client reads the body
/// only when that header is absent, for v1 compatibility. So one response
/// serves everyone: the header carries v2, the body carries v1, and each
/// client finds its own and ignores the other.
///
/// This is the piece that was actually wrong. Answering v1 in the body was
/// not an old dialect a modern client could still read — it was a response
/// `@x402/fetch` rejects before looking at the price.
export function paymentRequired(
  accepts: PaymentRequirements[],
  resource: ResourceInfo,
  error = "payment required",
): { body: unknown; headers: Record<string, string> } {
  const extensions = {
    ...builderCodeExtension(),
    // Only when a Permit2 asset is on offer: it is what makes the client sign
    // the permit the facilitator sponsors. Without it a payer with no Permit2
    // allowance gets `412 permit2_allowance_required` naming an allowance,
    // not the missing declaration (Celo's guide, measured on mainnet).
    ...(accepts.some(isPermit2) ? gasSponsoringExtension() : {}),
  };
  return {
    // v1 shape, because the body is where a v1 client looks. EIP-3009 assets
    // only: a v1 client predates Permit2 settlement, and a v1 payload carries
    // no asset, so every entry here is one more signature to try.
    body: {
      x402Version: 1,
      error,
      accepts: accepts.filter((a) => !isPermit2(a)).map((a) => asV1(a, resource)),
    },
    headers: {
      "PAYMENT-REQUIRED": b64(JSON.stringify({
        x402Version: 2,
        error,
        resource,
        accepts,
        ...(Object.keys(extensions).length ? { extensions } : {}),
      })),
    },
  };
}

/// Base64 of the UTF-8 bytes, as `@x402/core` encodes and decodes its headers.
/// `btoa` alone takes Latin-1, so "Real Brasileño" went out as one byte the
/// client then read as broken UTF-8, and every wBRL signature would have been
/// made for a domain name nobody uses.
function b64(text: string): string {
  return btoa(Array.from(new TextEncoder().encode(text), (b) => String.fromCharCode(b)).join(""));
}

function unb64(data: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
}

/// The EIP-2612 gas-sponsoring declaration, verbatim from
/// `declareEip2612GasSponsoringExtension()` in `@x402/extensions` 2.28.0,
/// which `x402.test.ts` checks. The facilitator advertising it in
/// `/supported` is half of the handshake; a 402 repeating it is the other.
export function gasSponsoringExtension() {
  return { eip2612GasSponsoring: { info: GAS_SPONSORING_INFO, schema: GAS_SPONSORING_SCHEMA } };
}

const GAS_SPONSORING_INFO = {
  description: "The facilitator accepts EIP-2612 gasless Permit to `Permit2` canonical contract.",
  version: "1",
};

const GAS_SPONSORING_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    from: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$", description: "The address of the sender." },
    asset: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$", description: "The address of the ERC-20 token contract." },
    spender: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$", description: "The address of the spender (Canonical Permit2)." },
    amount: { type: "string", pattern: "^[0-9]+$", description: "The amount to approve (uint256). Typically MaxUint." },
    nonce: { type: "string", pattern: "^[0-9]+$", description: "The current nonce of the sender." },
    deadline: { type: "string", pattern: "^[0-9]+$", description: "The timestamp at which the signature expires." },
    signature: { type: "string", pattern: "^0x[a-fA-F0-9]+$", description: "The 65-byte concatenated signature (r, s, v) as a hex string." },
    version: { type: "string", pattern: "^[0-9]+(\\.[0-9]+)*$", description: "Schema version identifier." },
  },
  required: ["from", "asset", "spender", "amount", "nonce", "deadline", "signature", "version"],
};

/// The ERC-8021 builder-code declaration for our 402s, the shape
/// `declareBuilderCodeExtension` from `@x402/extensions` writes.
///
/// The facilitator submits the settlement, so our own suffix can never ride on
/// it — only the facilitator can append one. The standard route is this
/// extension: we declare our code, the client echoes it in its payment, and
/// the facilitator writes a Schema 2 tag with our code as `a` and its own as
/// `w`. Celo DevRel, 2026-10-07: the Celo facilitator does not write it yet
/// (x402-rs/x402-rs#99, deploying on merge), it applies to v2 payments only —
/// v1 has no extensions field — and to USDC, USD₮ and USA₮ first. Declaring it
/// now costs nothing and means settlements tag themselves the day it ships.
///
/// `a` holds exactly one code, so the first of `ATTRIBUTION_CODES` (ours) goes
/// there and any others (the hackathon's) go in `s`; Celo's decoder lists every
/// code in the map, so each is credited. `undefined` if nothing is usable — a
/// 402 without the extension is still a valid 402.
export function builderCodeExtension(codes: readonly string[] = ATTRIBUTION_CODES) {
  const valid = codes.filter((c) => /^[a-z0-9_]{1,32}$/.test(c));
  const [a, ...rest] = valid;
  if (!a) return undefined;
  const s = rest.slice(0, 5);
  return {
    "builder-code": {
      info: s.length ? { a, s } : { a },
      schema: BUILDER_CODE_SCHEMA,
    },
  };
}

/// Verbatim from `@x402/extensions` 2.28.0, so a strict client validating the
/// declaration against its own copy finds the same document.
const BUILDER_CODE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    a: { type: "string", pattern: "^[a-z0-9_]{1,32}$", description: "App builder code" },
    w: { type: "string", pattern: "^[a-z0-9_]{1,32}$", description: "Wallet builder code" },
    s: {
      type: "array",
      maxItems: 11,
      items: { type: "string", pattern: "^[a-z0-9_]{1,32}$" },
      description: "Service builder codes",
    },
  },
  additionalProperties: false,
};

/// The same price list in v1's shape, for a client that only speaks v1.
///
/// Not advertised anywhere — this exists so that a v1 payment can be verified
/// and settled against requirements the facilitator will recognise. The
/// numbers are the same; only the field names and the network string differ.
function asV1(r: PaymentRequirements, resource: ResourceInfo) {
  return {
    scheme: r.scheme,
    network: NETWORK_V1,
    resource: resource.url,
    description: resource.description ?? "",
    mimeType: resource.mimeType ?? "application/json",
    payTo: r.payTo,
    maxAmountRequired: r.amount,
    asset: r.asset,
    maxTimeoutSeconds: r.maxTimeoutSeconds,
    outputSchema: {},
    extra: r.extra,
  };
}

async function facilitator(path: string, body: unknown): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${X402.base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The dashboard key meters settlement credits; without it the
        // facilitator answers 401 and nothing settles.
        "X-API-Key": X402.apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error("x402", path, res.status, JSON.stringify(json).slice(0, 300));
      // A rejected payment is a 400 carrying `invalidReason` — the useful
      // half of the answer. Discarding it as "unavailable" tells a payer
      // nothing, when the facilitator just told them their balance is short.
      const judged = json as { isValid?: unknown; invalidReason?: unknown; success?: unknown };
      if (judged.isValid !== undefined || judged.success !== undefined) {
        return judged as Record<string, unknown>;
      }
      return null;
    }
    return json as Record<string, unknown>;
  } catch (e) {
    console.error("x402 facilitator unreachable:", (e as Error).message);
    return null;
  }
}

/// Which version did this payer speak, and which of OUR entries did they pay?
///
/// v2 echoes the chosen requirements back as `accepted`, which is how a seller
/// learns the currency without guessing. But it is the PAYER's copy, so it is
/// used only to pick which of our own advertised entries to act on — never
/// passed through. A payload echoing `amount: "1"` must not become a request
/// to charge one unit; it matches nothing of ours, or it matches the entry
/// whose asset it names and that entry's real price is what we verify. The
/// echo selects, it does not instruct.
///
/// v1 carried no asset at all, so there the only honest move is to try each
/// candidate and let the facilitator say which signature is good.
export function match(payment: unknown, accepts: PaymentRequirements[]): {
  version: 1 | 2;
  candidates: PaymentRequirements[];
} {
  const p = payment as { x402Version?: unknown; accepted?: { asset?: unknown } };
  // The v1 body offers EIP-3009 assets only, so those are all a v1 payer can
  // have signed for.
  if (p?.x402Version === 1) return { version: 1, candidates: accepts.filter((a) => !isPermit2(a)) };

  const asset = String(p?.accepted?.asset ?? "").toLowerCase();
  const mine = accepts.filter((a) => a.asset.toLowerCase() === asset);
  // An unrecognised asset leaves the list empty, and an empty list fails
  // verification rather than falling back to "charge them for something".
  return { version: 2, candidates: mine };
}

/// Is this signed authorisation good for this price? Nothing has moved yet.
///
/// Tries the candidates in order and reports which one verified, because
/// settlement has to reuse that exact entry: settling against a different one
/// asks the facilitator to move a token the signature does not authorise.
export async function verify(
  payment: unknown,
  accepts: PaymentRequirements[],
  resource: ResourceInfo,
): Promise<{ ok: boolean; reason?: string; payer?: string; matched?: PaymentRequirements; version: 1 | 2 }> {
  const { version, candidates } = match(payment, accepts);
  if (!candidates.length) {
    return { ok: false, version, reason: "that asset is not one this service accepts" };
  }

  let lastReason: string | undefined;
  for (const candidate of candidates) {
    const out = await facilitator("/verify", {
      x402Version: version,
      paymentPayload: payment,
      paymentRequirements: version === 1 ? asV1(candidate, resource) : candidate,
    });
    if (!out) return { ok: false, version, reason: "payment verification unavailable" };
    if (out.isValid === true) {
      return {
        ok: true,
        version,
        payer: typeof out.payer === "string" ? out.payer : undefined,
        matched: candidate,
      };
    }
    // Keep the most specific complaint. "insufficient_funds" against the asset
    // they actually signed for is useful; a mismatch from a candidate they did
    // not choose is noise.
    lastReason = typeof out.invalidReason === "string" ? out.invalidReason : lastReason;
  }
  return { ok: false, version, reason: lastReason };
}

/// Move the money. Called only after the work succeeded, against the entry
/// that verified.
export async function settle(
  payment: unknown,
  matched: PaymentRequirements,
  resource: ResourceInfo,
): Promise<{ ok: boolean; txHash?: string }> {
  const { version } = match(payment, [matched]);
  const out = await facilitator("/settle", {
    x402Version: version,
    paymentPayload: payment,
    paymentRequirements: version === 1 ? asV1(matched, resource) : matched,
  });
  if (!out) return { ok: false };
  return {
    ok: out.success === true,
    txHash: typeof out.transaction === "string" ? out.transaction : undefined,
  };
}

/// The payment, from whichever header the client used.
///
/// v2 sends `PAYMENT-SIGNATURE`, v1 sent `X-PAYMENT`. Both are base64 JSON,
/// and the payload itself says which version it is, so the header only has to
/// be found rather than interpreted.
export function decodePayment(req: Request): unknown | null {
  const raw = req.headers.get("payment-signature") ?? req.headers.get("x-payment");
  if (!raw) return null;
  try {
    // UTF-8, as `@x402/core` encodes it: a v2 payment echoes our requirements,
    // and wBRL's are "Real Brasileño".
    return JSON.parse(unb64(raw));
  } catch {
    console.error("x402: the payment header is not base64 JSON");
    return null;
  }
}

/// What the caller gets back so they can find the settlement on-chain.
///
/// Under both names: v2 reads `PAYMENT-RESPONSE` and falls back to
/// `X-PAYMENT-RESPONSE`, and v1 only knows the latter. Sending both costs a
/// few bytes and means no client has to be the right vintage to get a receipt.
/// `version` is the payer's, not ours. A v1 client was promised `network:
/// "celo"` and may check it; handing it the CAIP-2 name because our own
/// default changed is us renaming the chain under a client that never asked
/// for v2. One response, two vocabularies — the receipt speaks whichever the
/// payment did.
export function settlementHeaders(
  txHash: string | undefined,
  version: 1 | 2,
): Record<string, string> {
  const encoded = b64(JSON.stringify({
    success: true,
    transaction: txHash ?? null,
    network: version === 1 ? NETWORK_V1 : NETWORK,
  }));
  return { "PAYMENT-RESPONSE": encoded, "X-PAYMENT-RESPONSE": encoded };
}

/// Header names a caller may send us, and the ones they must be allowed to
/// read back. A browser-side agent that cannot read `PAYMENT-REQUIRED` cannot
/// discover the price, and CORS hides it by default.
export const X402_CORS = {
  "Access-Control-Allow-Headers": "content-type, payment-signature, x-payment",
  "Access-Control-Expose-Headers": "payment-required, payment-response, x-payment-response",
};
