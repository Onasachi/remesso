#!/usr/bin/env node
// Pay one of Remesso's x402 services on Celo with the official x402 v2 client.
//
//   npm i @x402/fetch@2.28.0 @x402/evm@2.28.0 viem
//   PAYER_KEY=0x… node pay.mjs --service naira-rate                # pays in USA₮
//   PAYER_KEY=0x… node pay.mjs --service latam-rate --body '{"usd":250}'
//   PAYER_KEY=0x… node pay.mjs --service latam-route --body '{"country":"AR","amount":20000}'
//   PAYER_KEY=0x… node pay.mjs --service trigger-run --body '{"scheduleId":3}'
//   PAYER_KEY=0x… node pay.mjs --service naira-rate --asset USDC   # opt out of USA₮
//   PAYER_KEY=0x… node pay.mjs --service latam-rate --asset wARS   # pay in pesos
//
// USA₮ is the default currency. The payer needs the token and NO CELO:
//   - USDC, USD₮ and USA₮: an EIP-3009 authorisation the facilitator submits
//     and pays gas for.
//   - Ripio's wARS, wBRL, wCOP, wMXN, wCLP and wPEN: a Permit2 transfer, plus
//     an EIP-2612 permit to Permit2 the facilitator sponsors. To sign that
//     permit the client reads the wallet's allowance and permit nonce, which is
//     what `rpcUrl` is for: with a bare key it signs no permit, and a wallet
//     that never approved Permit2 is refused (412 permit2_allowance_required).
//
// Two guards, both on purpose:
//   - the asset is chosen by ADDRESS. USD₮, USDC and USA₮ each have an
//     18-decimal fee adapter on Celo reporting the same symbol(); pricing
//     against one is an error of 10^12.
//   - --max caps what one call may cost, in dollars (default 0.05) whatever
//     you pay in. The 402 is the price; a quote above your cap is refused
//     before anything is signed. For a peso the cap is converted at a rough
//     rate rounded UP, so it never refuses a fair price.
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { createPublicClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Both overridable to test against a local server or fork; Celo mainnet otherwise.
const FUNCTIONS = process.env.REMESSO_FUNCTIONS_URL ?? "https://engaboljiqudghvzmebq.supabase.co/functions/v1";
const RPC = process.env.CELO_RPC_URL ?? "https://forno.celo.org";
const SERVICES = {
  "naira-rate": "rate-service",
  "latam-rate": "latam-rate",
  "latam-route": "latam-route",
  "trigger-run": "trigger-run",
};
// `perUsd` converts --max into the token: 1 for the dollars, and for the
// wFIAT a local-per-dollar rate rounded up (2026-10-28) so the cap stays
// above a fair price. The 402 sets the price; this only bounds it.
const ASSETS = {
  USDC: { label: "USDC", address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", decimals: 6, perUsd: 1 },
  USDT: { label: "USD₮", address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", decimals: 6, perUsd: 1 },
  USAT: { label: "USA₮", address: "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771", decimals: 6, perUsd: 1 },
  WARS: { label: "wARS", address: "0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D", decimals: 18, perUsd: 1600 },
  WBRL: { label: "wBRL", address: "0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0", decimals: 18, perUsd: 6 },
  WCOP: { label: "wCOP", address: "0x8a1D45e102e886510e891d2Ec656a708991e2D76", decimals: 18, perUsd: 3300 },
  WMXN: { label: "wMXN", address: "0x337E7456B420bD3481e7FA61fA9850343d610d34", decimals: 18, perUsd: 20 },
  WCLP: { label: "wCLP", address: "0x61D450a098b6a7f69fC4b98CE68198fe59768651", decimals: 18, perUsd: 1000 },
  WPEN: { label: "wPEN", address: "0x4F34c8b3b5FB6D98Da888F0feA543d4d9C9F2eBE", decimals: 18, perUsd: 4 },
};

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const service = arg("service", "naira-rate");
const path = SERVICES[service];
const assetName = (arg("asset", "USAT") || "").toUpperCase().replace("₮", "T");
const token = ASSETS[assetName];
const body = arg("body", "{}");
const key = (process.env.PAYER_KEY ?? "").trim();

if (!path) throw new Error(`--service must be one of ${Object.keys(SERVICES).join(", ")}`);
if (!token) throw new Error(`--asset must be one of ${Object.values(ASSETS).map((a) => a.label).join(", ")}`);
const asset = token.address;
// Dollars at 6dp, then into the token's own units and scale.
const maxUnits = BigInt(Math.round(Number(arg("max", "0.05")) * 1e6)) * BigInt(token.perUsd) * 10n ** BigInt(token.decimals - 6);
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("set PAYER_KEY to a 0x-prefixed private key");

const account = privateKeyToAccount(key);

// Balance first, so a wallet without the default currency hears why before
// anything is signed — not a failed settlement after the server already ran.
// Free: one eth_call. The price is unknown until the 402, so this only checks
// the wallet holds some; the selector below checks it holds enough.
const pub = createPublicClient({ transport: http(RPC) });
const balance = await pub.readContract({
  address: asset,
  abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
  functionName: "balanceOf",
  args: [account.address],
});
if (balance === 0n) {
  console.error(`${account.address} holds no ${token.label} on Celo. Add ${token.label}, or pay in another currency with --asset USDC or --asset USDT.`);
  process.exit(1);
}
const select = (_version, accepts) => {
  const pick = accepts.find((a) => a.asset.toLowerCase() === asset.toLowerCase());
  // The spend control above drops an entry priced over --max before this
  // runs, so a missing entry is either case; the message says both.
  if (!pick) throw new Error(`no ${token.label} price within --max ${arg("max", "0.05")} dollars: the 402 does not offer ${token.label}, or asks more than that. Nothing signed.`);
  const amount = BigInt(pick.amount ?? pick.maxAmountRequired);
  if (amount > maxUnits) throw new Error(`quoted ${amount} base units, above --max ${maxUnits}; nothing signed`);
  if (amount > balance) throw new Error(`quoted ${amount} base units, wallet holds ${balance}; nothing signed`);
  return pick;
};
const client = new x402Client(select);
// The stock client signs only its default assets (USDC, USD₮, USA₮, up to $1)
// and refuses the wFIAT before signing; naming the asset with an atomic cap
// lets it through, and the cap is --max for whichever asset is chosen.
client.setSpendControls({ allowedAssets: [{ network: "eip155:42220", asset, maxAmountPerPayment: maxUnits.toString() }] });
registerExactEvmScheme(client, {
  signer: account,
  paymentRequirementsSelector: select,
  // Reads for the Permit2 path: the allowance and the permit nonce.
  schemeOptions: { rpcUrl: RPC },
});
const payFetch = wrapFetchWithPayment(fetch, client);

const res = await payFetch(`${FUNCTIONS}/${path}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body,
});
const receipt = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
console.log(JSON.stringify({
  status: res.status,
  payer: account.address,
  receipt: receipt ? decodePaymentResponseHeader(receipt) : null,
  body: await res.json().catch(() => null),
}, null, 2));
if (!res.ok) process.exit(1);
