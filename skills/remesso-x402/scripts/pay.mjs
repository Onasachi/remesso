#!/usr/bin/env node
// Pay one of Remesso's x402 services on Celo with the official x402 v2 client.
//
//   npm i @x402/fetch@2.28.0 @x402/evm@2.28.0 viem
//   PAYER_KEY=0x… node pay.mjs --service naira-rate --asset USAT
//   PAYER_KEY=0x… node pay.mjs --service trigger-run --asset USDC --body '{"scheduleId":3}'
//
// The payer needs the token (USDC, USD₮ or USA₮) and NO CELO: the payment is an
// EIP-3009 authorisation the facilitator submits and pays gas for.
//
// Two guards, both on purpose:
//   - the asset is chosen by ADDRESS. Each of these tokens has an 18-decimal
//     fee adapter on Celo reporting the same symbol(); pricing against one is
//     an error of 10^12.
//   - --max caps what one call may cost (default 0.05). The 402 is the price;
//     a quote above your cap is refused before anything is signed.
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const FUNCTIONS = "https://engaboljiqudghvzmebq.supabase.co/functions/v1";
const SERVICES = { "naira-rate": "rate-service", "trigger-run": "trigger-run" };
const ASSETS = {
  USDC: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
  USDT: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
  USAT: "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771",
};

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const service = arg("service", "naira-rate");
const path = SERVICES[service];
const asset = ASSETS[(arg("asset", "USDC") || "").toUpperCase().replace("₮", "T")];
const maxUnits = BigInt(Math.round(Number(arg("max", "0.05")) * 1e6)); // all three are 6dp
const body = arg("body", "{}");
const key = (process.env.PAYER_KEY ?? "").trim();

if (!path) throw new Error(`--service must be one of ${Object.keys(SERVICES).join(", ")}`);
if (!asset) throw new Error(`--asset must be one of ${Object.keys(ASSETS).join(", ")}`);
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("set PAYER_KEY to a 0x-prefixed private key");

const account = privateKeyToAccount(key);
const select = (_version, accepts) => {
  const pick = accepts.find((a) => a.asset.toLowerCase() === asset.toLowerCase());
  if (!pick) throw new Error(`the 402 does not offer ${asset}; it offers ${accepts.map((a) => a.asset).join(", ")}`);
  const amount = BigInt(pick.amount ?? pick.maxAmountRequired);
  if (amount > maxUnits) throw new Error(`quoted ${amount} base units, above --max ${maxUnits}; nothing signed`);
  return pick;
};
const client = new x402Client(select);
registerExactEvmScheme(client, { signer: account, paymentRequirementsSelector: select });
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
