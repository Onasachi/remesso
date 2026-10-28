/// Pins our x402 builder-code declaration to the reference implementation.
///
/// `declareBuilderCodeExtension` from `@x402/extensions` is what the reference
/// middleware puts in a 402; the facilitator reads the client's echo of it to
/// write our ERC-8021 tag on settlements it submits. A shape it does not
/// recognise is silently untagged — the same failure as no declaration.
///
///   deno test --allow-env --allow-read --allow-net supabase/functions/_shared/x402.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { declareBuilderCodeExtension } from "npm:@x402/extensions@2.28.0/builder-code";
import { builderCodeExtension, paymentRequired } from "./x402.ts";

Deno.test("matches declareBuilderCodeExtension exactly", () => {
  // Compared as JSON: what matters is the document on the wire, not the
  // package's TypeScript types.
  const json = (x: unknown) => JSON.parse(JSON.stringify(x));
  assertEquals(
    json(builderCodeExtension(["remesso", "celo_5cd35ca55baf"])!["builder-code"]),
    json(declareBuilderCodeExtension("remesso", ["celo_5cd35ca55baf"])),
  );
  assertEquals(
    json(builderCodeExtension(["remesso"])!["builder-code"]),
    json(declareBuilderCodeExtension("remesso")),
  );
});

Deno.test("drops unusable codes rather than declaring them", () => {
  assertEquals(builderCodeExtension(["Bad Code"]), undefined);
  assertEquals(
    builderCodeExtension(["Bad", "remesso"])!["builder-code"].info,
    { a: "remesso" },
  );
});

Deno.test("rides in the v2 header and stays out of the v1 body", () => {
  const { body, headers } = paymentRequired([], { url: "https://x", description: "", mimeType: "" } as never);
  const v2 = JSON.parse(atob(headers["PAYMENT-REQUIRED"]));
  assertEquals(typeof v2.extensions["builder-code"].info.a, "string");
  // v1 has no extensions field; adding one would be a field a strict v1
  // client has never seen.
  assertEquals("extensions" in (body as Record<string, unknown>), false);
});

// ── Local currencies: the wFIAT settle through Permit2 ──────────────────────
// Each check below is against the reference packages, not our own reading of
// them: the official client is what a stranger's agent pays with.
import { declareEip2612GasSponsoringExtension } from "npm:@x402/extensions@2.28.0";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "npm:@x402/core@2.28.0/http";
import { ExactEvmScheme } from "npm:@x402/evm@2.28.0/exact/client";
import { privateKeyToAccount } from "npm:viem@2.38.0/accounts";
import { amountIn, ASSETS, decodePayment, gasSponsoringExtension, match, priced, priceList, requirements } from "./x402.ts";

const PAY_TO = "0xcDEA4Cc4191Ec9A5d8fD1a6B17e3F4C84E993Ae2";
Deno.env.set("X402_PAY_TO", PAY_TO);
const json = (x: unknown) => JSON.parse(JSON.stringify(x));
const at = (symbol: string) => ASSETS.find((a) => a.symbol === symbol)!;
const what = { url: "https://example.test/functions/v1/latam-rate", description: "Pesos → dollars", mimeType: "application/json" };

Deno.test("the gas-sponsoring declaration is the reference one", () => {
  assertEquals(json(gasSponsoringExtension()), json(declareEip2612GasSponsoringExtension()));
});

Deno.test("one dollar price, quoted at each asset's own scale", () => {
  const byAsset = Object.fromEntries(priced(requirements(), "1000").map((r) => [r.asset, r.amount]));
  assertEquals(byAsset[at("USDC").address], "1000");
  assertEquals(byAsset[at("USAT").address], "1000");
  // $0.001 at 1,500 ARS and 3 PEN to the dollar, 18 decimals.
  assertEquals(byAsset[at("wARS").address], "1500000000000000000");
  assertEquals(byAsset[at("wPEN").address], "3000000000000000");
  assertEquals(amountIn(at("wMXN"), "10000"), "180000000000000000");
  // The document shape: the dollar price, then each asset's exact amount.
  const list = priceList("2000");
  assertEquals([list.amount, list.decimals], ["2000", 6]);
  assertEquals(list.assets.find((a) => a.symbol === "wBRL")!.amount, "10000000000000000");
  assertEquals(list.assets.find((a) => a.symbol === "wBRL")!.transfer, "permit2");
  assertEquals(list.assets.find((a) => a.symbol === "USDT")!.transfer, "eip3009");
});

Deno.test("the wFIAT ask for Permit2 and the dollars do not", () => {
  for (const r of requirements()) {
    const decimals = ASSETS.find((a) => a.address === r.asset)!.decimals;
    assertEquals(r.extra.assetTransferMethod === "permit2", decimals === 18, r.asset);
  }
});

Deno.test("the 402 reads back through the reference decoder, accents intact", () => {
  const { body, headers } = paymentRequired(priced(requirements(), "1000"), what);
  const v2 = decodePaymentRequiredHeader(headers["PAYMENT-REQUIRED"]);
  const wbrl = v2.accepts.find((a: { asset: string }) => a.asset === at("wBRL").address)!;
  assertEquals(wbrl.extra.name, "Real Brasileño");
  assertEquals(v2.resource.description, "Pesos → dollars");
  assertEquals(Object.keys(v2.extensions ?? {}).sort(), ["builder-code", "eip2612GasSponsoring"]);
  // v1 has no Permit2 and no extensions: only the three dollars go there.
  const v1 = body as { accepts: Array<{ asset: string; extra: Record<string, string> }> };
  assertEquals(v1.accepts.map((a) => a.asset), ["USDC", "USDT", "USAT"].map((s) => at(s).address));
  assertEquals(v1.accepts.some((a) => "assetTransferMethod" in a.extra), false);
});

Deno.test("no Permit2 asset on offer, no gas-sponsoring declaration", () => {
  const dollars = priced(requirements(), "1000").filter((r) => !r.extra.assetTransferMethod);
  const v2 = decodePaymentRequiredHeader(paymentRequired(dollars, what).headers["PAYMENT-REQUIRED"]);
  assertEquals(Object.keys(v2.extensions ?? {}), ["builder-code"]);
});

Deno.test("a payment the reference client encoded decodes intact", () => {
  const accepted = priced(requirements(), "1000").find((r) => r.asset === at("wBRL").address)!;
  const header = encodePaymentSignatureHeader({ x402Version: 2, accepted, payload: { signature: "0x" } } as never);
  const decoded = decodePayment(new Request("https://x", { headers: { "payment-signature": header } })) as {
    accepted: { extra: { name: string } };
  };
  assertEquals(decoded.accepted.extra.name, "Real Brasileño");
});

Deno.test("a v1 payment is tried against the dollars only; v2 picks by asset at our price", () => {
  const accepts = priced(requirements(), "1000");
  assertEquals(match({ x402Version: 1 }, accepts).candidates.map((c) => c.asset), ["USDC", "USDT", "USAT"].map((s) => at(s).address));
  // The echo selects, it never instructs: an echoed amount of 1 still meets our price.
  const { candidates } = match({ x402Version: 2, accepted: { asset: at("wARS").address, amount: "1" } }, accepts);
  assertEquals(candidates.map((c) => c.amount), ["1500000000000000000"]);
});

Deno.test("the official client signs a sponsored Permit2 payment for our wARS price", async () => {
  // What a stranger's agent does: decode our 402, pick wARS, sign. A wallet
  // with no Permit2 allowance must get the EIP-2612 permit the facilitator
  // sponsors, or it would need CELO to approve Permit2 first.
  const { headers } = paymentRequired(priced(requirements(), "1000"), what);
  const required = decodePaymentRequiredHeader(headers["PAYMENT-REQUIRED"]);
  const wars = required.accepts.find((a: { asset: string }) => a.asset === at("wARS").address)!;
  const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  const reads: string[] = [];
  const signer = {
    address: account.address,
    signTypedData: (m: never) => account.signTypedData(m),
    // No allowance to Permit2 yet, and a fresh permit nonce.
    readContract: ({ functionName }: { functionName: string }) => (reads.push(functionName), Promise.resolve(0n)),
  };
  const out = await new ExactEvmScheme(signer as never).createPaymentPayload(2, wars, { extensions: required.extensions });
  const auth = (out.payload as { permit2Authorization: { permitted: { token: string; amount: string }; witness: { to: string } } })
    .permit2Authorization;
  assertEquals([auth.permitted.token, auth.permitted.amount, auth.witness.to], [at("wARS").address, "1500000000000000000", PAY_TO]);
  const permit = (out.extensions as { eip2612GasSponsoring: { info: { asset: string; amount: string; spender: string } } })
    .eip2612GasSponsoring.info;
  assertEquals([permit.asset, permit.amount], [at("wARS").address, "1500000000000000000"]);
  assertEquals(permit.spender, "0x000000000022D473030F116dDEE9F6B43aC78BA3");
  assertEquals(reads, ["allowance", "nonces"]);
});
