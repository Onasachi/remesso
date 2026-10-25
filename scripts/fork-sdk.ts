/// The SDK's money paths on a fork of Celo mainnet: what it signs, what it
/// refuses before signing, and that an agent payment retried with its key
/// pays once, including one whose first attempt never left the machine.
///
///   anvil --fork-url https://forno.celo.org --port 8546    # the fork
///   anvil --chain-id 1337 --port 8547                      # some other chain
///   deno run --allow-all --config packages/remesso-sdk/deno.json --unstable-sloppy-imports scripts/fork-sdk.ts
///
/// Fresh keys, funded on the fork: USDT from the cNGN/USDT pool, impersonated.
/// Nothing touches mainnet: both RPCs are checked to be anvil first. The one
/// live call is `policies.find` reading payment-events for a fresh address.
import { createPublicClient, custom, encodeFunctionData, http, parseAbi, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { createRemesso, memoryStore, RemessoError } from "../packages/remesso-sdk/src/index.ts";

const FORK = "http://127.0.0.1:8546";
const OTHER = "http://127.0.0.1:8547";
const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const POOL = "0x6519d56eb0a69fc0338657784c783b169b8f7d32"; // cNGN/USDT, ~94k USDT
const EXECUTOR = "0x3C357af3300f383Ea49B6D6ED8e084199a92bEd8";
const DEST = "0xFd1a3980f7473bdFE7461e78ADDe78c33d7b006b";

async function rpc<T = unknown>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}
for (const url of [FORK, OTHER]) {
  if (!/anvil/i.test(await rpc<string>(url, "web3_clientVersion").catch(() => ""))) {
    console.error(`refusing: ${url} is not anvil. Start both anvils first (see the top of this file).`);
    Deno.exit(1);
  }
}

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}`);
  if (!ok) failures++;
};
const refusedWith = async (p: Promise<unknown>, code: string, what: string) => {
  try {
    await p;
    check(false, `${what} (it went through)`);
  } catch (e) {
    const ok = e instanceof RemessoError && e.code === code;
    check(ok, ok ? `${what}: ${(e as Error).message.slice(0, 110)}` : `${what} (got ${(e as Error).message.slice(0, 160)})`);
  }
};

const erc20 = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
]);
const chain = createPublicClient({ chain: celo, transport: http(FORK), pollingInterval: 200 });
const balance = (who: `0x${string}`) => chain.readContract({ address: USDT, abi: erc20, functionName: "balanceOf", args: [who] });

// --- the stage ---------------------------------------------------------
const payer = privateKeyToAccount(generatePrivateKey());
const agentKey = privateKeyToAccount(generatePrivateKey());
await rpc(FORK, "evm_setAutomine", [true]);
for (const who of [payer.address, agentKey.address, POOL]) await rpc(FORK, "anvil_setBalance", [who, toHex(10n ** 19n)]);
await rpc(FORK, "anvil_impersonateAccount", [POOL]);
const fund = await rpc<`0x${string}`>(FORK, "eth_sendTransaction", [{
  from: POOL, to: USDT, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [payer.address, 20_000_000n] }),
}]);
await chain.waitForTransactionReceipt({ hash: fund });
console.log(`fork: payer ${payer.address} holds ${Number(await balance(payer.address)) / 1e6} USDT; agent ${agentKey.address}`);

const store = memoryStore();
const asPayer = createRemesso({ account: payer, rpcUrl: FORK, publicClient: chain as never });
const asAgent = createRemesso({ account: agentKey, rpcUrl: FORK, publicClient: chain as never, store });

// --- 1. schedules ---------------------------------------------------------
console.log("\n1. schedules");
const nonce0 = await chain.getTransactionCount({ address: payer.address });
await refusedWith(asPayer.schedules.create({ to: DEST, amount: "0.5", token: "USDT", every: "week", runs: 2 }), "refused", "0.5 USDT a payment is under the executor's minimum, refused before signing");
check(await chain.getTransactionCount({ address: payer.address }) === nonce0, "nothing was sent for it");
await refusedWith(asPayer.schedules.create({ to: payer.address, amount: "1", runs: 1 }), "invalid", "a schedule paying itself is refused");

const s1 = await asPayer.schedules.create({ to: DEST, amount: "1", token: "USDT", every: "week", runs: 2 });
const onChain = await asPayer.schedules.get(s1.id);
check(onChain.to === DEST && onChain.amountIn === 1_000_000n && onChain.maxRuns === 2 && onChain.feeBps === 25,
  `schedule #${s1.id}: 1 USDT weekly, twice, to the recipient, 25bps pinned`);
check(s1.recipientGets === 997_500n, "the recipient gets 0.9975 a payment");
const approved1 = await chain.readContract({ address: USDT, abi: erc20, functionName: "allowance", args: [payer.address, EXECUTOR] });
check(approved1 === 2_000_000n, "approval: exactly the schedule's total, 2 USDT");

const s2 = await asPayer.schedules.create({ to: DEST, receive: "5", token: "USDT", every: "month", runs: 1 });
check(s2.amountIn === 5_012_532n && s2.recipientGets >= 5_000_000n, "receive 5: sends 5.012532 so 5 arrives");
const approved2 = await chain.readContract({ address: USDT, abi: erc20, functionName: "allowance", args: [payer.address, EXECUTOR] });
check(approved2 === 2_000_000n + 5_012_532n, "approval added on top of the first schedule's, not replacing it");

const st = await asPayer.schedules.status(s1.id);
check(st.due && st.funded && st.approved, "runnability: due now, funded, approved");
check((await asPayer.schedules.list()).includes(s1.id), "list: the payer's schedules include it");
await asPayer.schedules.cancel(s2.id);
check((await asPayer.schedules.get(s2.id)).cancelled, "cancel: the second schedule is cancelled");

// --- 2. a policy and an agent's payments ----------------------------------
console.log("\n2. policies and payments");
const pol = await asPayer.policies.create({ agent: agentKey.address, token: "USDT", perPayment: "0.05", perDay: "0.10", days: 1, budget: "0.10" });
const p = await asPayer.policies.get(pol.id);
check(p.agent === agentKey.address && p.perPayment === 50_000n && p.spendable === 50_000n, `policy #${pol.id}: 0.05 a payment, 0.10 a day; 0.05 spendable`);
check((await asAgent.policies.find()).includes(pol.id), "the agent finds its policy without being told the id");

let before = await balance(DEST);
const paid = await asAgent.pay({ to: DEST, amount: "0.02", idempotencyKey: "invoice-1", memo: "invoice 1" });
check(paid.status === "confirmed" && (await balance(DEST)) - before === 20_000n, "pay 0.02 with a key: confirmed, 0.02 arrived");
before = await balance(DEST);
const again = await asAgent.pay({ to: DEST, amount: "0.02", idempotencyKey: "invoice-1", memo: "invoice 1" });
check(again.repeat === true && again.hash === paid.hash && (await balance(DEST)) === before, "the same key again: the first payment's hash, nothing new sent");
await refusedWith(asAgent.pay({ to: DEST, amount: "0.03", idempotencyKey: "invoice-1", memo: "invoice 1" }), "key_reused", "the key reused for another amount is refused");
await refusedWith(asAgent.pay({ to: DEST, amount: "0.02", memo: "invoice 1" }), "repeat", "an identical payment without a key, minutes later, is refused");
await refusedWith(asAgent.pay({ to: DEST, amount: "0.06", idempotencyKey: "big" }), "refused", "over the per-payment cap, refused before signing");

// The first attempt is signed and recorded, and the broadcast is lost.
let drop = true;
const flaky = createPublicClient({
  chain: celo,
  pollingInterval: 200,
  transport: custom({
    request: async ({ method, params }) => {
      if (method === "eth_sendRawTransaction" && drop) {
        drop = false;
        throw new Error("the network dropped it");
      }
      return await rpc(FORK, method, params as unknown[]);
    },
  }),
});
const lossy = createRemesso({ account: agentKey, rpcUrl: FORK, publicClient: flaky as never, store });
before = await balance(DEST);
const lost = await lossy.pay({ to: DEST, amount: "0.01", idempotencyKey: "invoice-2", waitMs: 1500 });
check(lost.status === "pending" && (await balance(DEST)) === before, "a broadcast lost on the way: pending, nothing paid yet");
const resent = await asAgent.pay({ to: DEST, amount: "0.01", idempotencyKey: "invoice-2" });
check(resent.status === "confirmed" && resent.hash === lost.hash && (await balance(DEST)) - before === 10_000n,
  "retried with its key: the recorded bytes go out, same hash, paid once");

await asPayer.policies.revoke(pol.id);
await refusedWith(asAgent.pay({ to: DEST, amount: "0.01", idempotencyKey: "after-revoke", policyId: pol.id }), "refused", "after the owner revokes, the agent is refused");

// --- 3. the wrong chain ------------------------------------------------------
console.log("\n3. the wrong chain");
const elsewhere = createRemesso({ account: payer, rpcUrl: OTHER });
await refusedWith(elsewhere.schedules.create({ to: DEST, amount: "1", runs: 1 }), "wrong_chain", "an RPC on chain 1337: nothing signed");
const elsewhereAgent = createRemesso({ account: agentKey, rpcUrl: OTHER });
await refusedWith(elsewhereAgent.pay({ to: DEST, amount: "0.01", idempotencyKey: "x" }), "wrong_chain", "an agent payment there: nothing signed");

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
Deno.exit(failures ? 1 : 0);
