/// First-payment rewards: find people whose first real payment ran, and pay
/// each one the campaign's reward, once. Every minute (cron).
///
/// Who qualifies is `_shared/rewards.ts`; this gathers the facts and moves the
/// money. The order inside a pass:
///   1. settle rewards already signed (a dead invocation leaves them);
///   2. find new qualifying payments and reserve a place under the cap
///      (`reserve_reward`, which locks the campaign row);
///   3. pay reserved rewards: sign, save the signed bytes, then broadcast.
///
/// It signs with REWARDS_PRIVATE_KEY, a wallet that holds only the reward
/// budget and gas. Never the executor key: that one runs other people's
/// mandates. The lease (the executor-lease table, keyed by this wallet's
/// address) keeps two passes from choosing one nonce.
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  type Address,
  concat,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  type Hex,
  http,
  keccak256,
  parseAbi,
  toHex,
} from "npm:viem@2";
import { privateKeyToAccount } from "npm:viem@2/accounts";
import { celo } from "npm:viem@2/chains";
import { CELO } from "../_shared/config.ts";
import { runSuffix } from "../_shared/attribution.ts";
import { decideReward, phonePersons, type RewardPayment } from "../_shared/rewards.ts";

const CAMPAIGN = Deno.env.get("REWARDS_CAMPAIGN") ?? "first-payment-2026-11";
/// Most rewards paid in one pass, and most payers looked up. Both bound the
/// RPC calls a pass makes; anything left waits for the next minute's pass.
const MAX_PAYOUTS = 5;
const MAX_LOOKUPS = 40;
/// A payer who earned nothing is looked at again after this, even without a
/// new payment: they may have verified with Self since.
const RECHECK = "1 hour";

const MINIPAY_ISSUER: Address = "0x7888612486844Bb9BE598668081c59A9f7367FBc";
const FEDERATED_ATTESTATIONS: Address = "0x0aD5b1d0C25ecF6266Dd951403723B2687d6aff2";

const faAbi = parseAbi([
  "function lookupIdentifiers(address account, address[] trustedIssuers) view returns (uint256[] countsPerIssuer, bytes32[] identifiers)",
]);
const erc20Abi = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const pc = createPublicClient({ chain: celo, transport: http(CELO.rpcUrl) });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), {
    status,
    headers: { "content-type": "application/json" },
  });

type EventRow = {
  tx_hash: string;
  log_index: number;
  kind: string;
  from_address: string;
  to_address: string | null;
  token: string | null;
  amount: string | null;
  amount_in: string | null;
  block_time: string;
  final: boolean;
  removed: boolean;
};

type Candidate = { wallet: string; first_seq: number | string; last_seq: number | string };

type RewardRow = {
  id: string;
  wallet: string;
  token: string;
  amount_units: string;
  status: string;
  tx_hash: string | null;
  nonce: number | null;
  signed_tx: string | null;
  attempts: number;
};

/// Every MiniPay phone identity attested for a wallet. An empty list is a
/// wallet with no MiniPay number; a failed read throws, so a node hiccup is
/// never read as "no identity".
async function phoneOf(wallet: string): Promise<string[]> {
  const [, ids] = await pc.readContract({
    address: FEDERATED_ATTESTATIONS,
    abi: faAbi,
    functionName: "lookupIdentifiers",
    args: [wallet as Address, [MINIPAY_ISSUER]],
  });
  return phonePersons(ids as readonly string[]);
}

/// Live Self passports bound to a wallet's sender rows. A test-key ("mock
/// passport") verification never counts.
async function passportsOf(wallet: string): Promise<string[]> {
  const { data: senders, error } = await db.from("senders").select("id").ilike("wallet_address", wallet);
  if (error) throw new Error(`senders: ${error.message}`);
  if (!senders?.length) return [];
  const { data: ver, error: vErr } = await db
    .from("identity_verifications")
    .select("nullifier")
    .in("sender_id", senders.map((s) => s.id))
    .eq("status", "valid")
    .eq("environment", "live")
    .not("nullifier", "is", null);
  if (vErr) throw new Error(`identity_verifications: ${vErr.message}`);
  return [...new Set((ver ?? []).map((v) => `self:${v.nullifier}`))];
}

async function personsOf(wallet: string): Promise<string[]> {
  const [phones, passports] = await Promise.all([phoneOf(wallet), passportsOf(wallet)]);
  return [...phones, ...passports];
}

async function paidBack(payer: string, recipient: string): Promise<boolean> {
  const { data, error } = await db
    .from("payment_events")
    .select("tx_hash")
    .eq("from_address", recipient)
    .eq("to_address", payer)
    .in("kind", ["run", "policy_payment"])
    .eq("removed", false)
    .limit(1);
  if (error) throw new Error(`payment_events: ${error.message}`);
  return Boolean(data?.length);
}

/// A transaction's receipt, or null only when the chain has no sign of it.
/// Forno misses receipts of mined transactions (about 2 lookups in 5, measured
/// 2026-10-26), so a miss is asked again, then answered from the block's own
/// receipts when the transaction itself shows a block.
async function receiptOf(hash: Hex) {
  for (let i = 0; i < 3; i++) {
    const r = await pc.getTransactionReceipt({ hash }).catch(() => null);
    if (r) return r;
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  const tx = await pc.getTransaction({ hash }).catch(() => null);
  if (!tx?.blockNumber) return null;
  const all = await pc.request({
    method: "eth_getBlockReceipts" as never,
    params: [toHex(tx.blockNumber)] as never,
  }).catch(() => null) as { transactionHash: string; status: string }[] | null;
  const found = all?.find((x) => x.transactionHash.toLowerCase() === hash.toLowerCase());
  if (!found) throw new Error(`${hash} is in block ${tx.blockNumber} but its receipt can't be read`);
  return { status: found.status === "0x1" ? "success" as const : "reverted" as const };
}

async function takeLease(address: string, holder: string) {
  const { data, error } = await db.rpc("take_executor_lease", {
    p_executor: address.toLowerCase(),
    p_holder: holder,
    p_seconds: 300,
  });
  if (error) throw new Error(`lease: ${error.message}`);
  const row = (data as { taken: boolean; mined_nonce: number | null }[] | null)?.[0];
  if (!row?.taken) return null;
  return {
    floor: row.mined_nonce === null ? 0 : Number(row.mined_nonce) + 1,
    release: async (minedNonce: number | null) => {
      const { error } = await db.rpc("release_executor_lease", {
        p_executor: address.toLowerCase(),
        p_holder: holder,
        p_mined_nonce: minedNonce,
      });
      if (error) console.error("pay-rewards: lease release failed", error.message);
    },
  };
}

async function update(id: string, fields: Record<string, unknown>, onlyIfStatus?: string): Promise<boolean> {
  let q = db.from("rewards").update({ ...fields, updated_at: new Date().toISOString() }).eq("id", id);
  if (onlyIfStatus) q = q.eq("status", onlyIfStatus);
  const { data, error } = await q.select("id");
  if (error) throw new Error(`rewards update: ${error.message}`);
  return Boolean(data?.length);
}

/// A reverted or lost payout goes back to `reserved` to be paid again, until
/// its third attempt, when it is given up and its place under the cap freed.
async function retryOrFail(r: RewardRow, why: string) {
  const attempts = r.attempts + 1;
  await update(r.id, {
    status: attempts >= 3 ? "failed" : "reserved",
    attempts,
    error: why.slice(0, 300),
    tx_hash: null,
    nonce: null,
    signed_tx: null,
    signed_at: null,
  });
}

Deno.serve(async (req) => {
  // `?dry=1`: decide and report who would be reserved, and write and send
  // nothing. The settle and pay steps are skipped entirely.
  const dry = new URL(req.url).searchParams.get("dry") === "1";
  const pk = Deno.env.get("REWARDS_PRIVATE_KEY") ?? "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) return json({ skipped: "REWARDS_PRIVATE_KEY is not set" });
  const account = privateKeyToAccount(pk as Hex);
  const wc = createWalletClient({ account, chain: celo, transport: http(CELO.rpcUrl) });
  const me = account.address.toLowerCase();

  const { data: campaign, error: cErr } = await db
    .from("reward_campaigns").select("*").eq("id", CAMPAIGN).maybeSingle();
  if (cErr) return json({ error: cErr.message }, 500);
  if (!campaign) return json({ skipped: `no campaign ${CAMPAIGN}` });

  const lease = dry
    ? { floor: 0, release: async (_n: number | null) => {} }
    : await takeLease(me, `pay-rewards:${crypto.randomUUID()}`);
  if (!lease) return json({ skipped: "another pass holds the rewards wallet" });

  let mined: number | null = null;
  const report = {
    dry,
    settled: 0,
    reserved: 0,
    paid: 0,
    wouldReserve: [] as { wallet: string; tx: string }[],
    refused: {} as Record<string, number>,
    notes: [] as string[],
  };

  try {
    // 1. Settle what an earlier pass signed.
    const { data: signed, error: sErr } = dry ? { data: [], error: null } : await db
      .from("rewards").select("*").eq("campaign_id", CAMPAIGN).eq("status", "signed");
    if (sErr) throw new Error(sErr.message);
    let unsettled = 0;
    for (const r of (signed ?? []) as RewardRow[]) {
      const receipt = await receiptOf(r.tx_hash as Hex);
      if (receipt) {
        mined = Math.max(mined ?? -1, Number(r.nonce));
        if (receipt.status === "success") await update(r.id, { status: "paid", error: null });
        else await retryOrFail(r, `reverted in ${r.tx_hash}`);
        report.settled++;
        continue;
      }
      const used = await pc.getTransactionCount({ address: account.address, blockTag: "latest" });
      if (used > Number(r.nonce)) {
        // Its nonce is spent, yet neither its receipt nor the transaction can
        // be found. Forno does lose receipts of mined transactions, so this is
        // not proof it wasn't paid. Never re-sign on a guess: give it up
        // (freeing its place) and leave the hash for a person to check.
        await update(r.id, {
          status: "failed",
          error: `nonce ${r.nonce} is used but ${r.tx_hash} wasn't found; check on Celoscan before paying by hand`,
        });
        report.notes.push(`payout ${r.tx_hash} is unclear; marked failed for a manual check`);
        report.settled++;
        continue;
      }
      // Still unmined: send its own bytes again. Never re-sign: a second
      // signature is a second payment.
      await pc.sendRawTransaction({ serializedTransaction: r.signed_tx as Hex }).catch(() => {});
      unsettled++;
    }
    if (unsettled > 0) {
      report.notes.push(`${unsettled} payout(s) still pending; no new ones this pass`);
      return json(report);
    }

    // 2. Find new qualifying payments. The database picks the payers worth a
    // look (reward_candidates): not yet rewarded, not ours, and not checked
    // since their last payment unless an hour has passed. So a payer who
    // can't qualify is not looked up on every pass, and nobody waits behind
    // them.
    const { data: ex, error: xErr } = await db.from("reward_exclusions").select("address");
    if (xErr) throw new Error(xErr.message);
    const excluded = new Set([...(ex ?? []).map((e) => e.address), me]);

    const { data: candidates, error: cErr } = await db.rpc("reward_candidates", {
      p_campaign: CAMPAIGN,
      p_limit: MAX_LOOKUPS,
      p_recheck: RECHECK,
    });
    if (cErr) throw new Error(`reward_candidates: ${cErr.message}`);

    const tally = (reason: string) => (report.refused[reason] = (report.refused[reason] ?? 0) + 1);
    // What a payer's check found, remembered so the next pass skips them
    // until they pay again or RECHECK passes. Not written in a dry run.
    const checked = async (wallet: string, lastSeq: string | number, reason: string) => {
      if (dry) return;
      const { error } = await db.from("reward_checks").upsert({
        campaign_id: CAMPAIGN,
        wallet,
        last_seq: String(lastSeq),
        checked_at: new Date().toISOString(),
        reason,
      });
      if (error) throw new Error(`reward_checks: ${error.message}`);
    };

    payers: for (const cand of (candidates ?? []) as Candidate[]) {
      const payer = cand.wallet;
      const { data: rows, error: eErr } = await db
        .from("payment_events")
        .select("tx_hash,log_index,kind,from_address,to_address,token,amount,amount_in,block_time,final,removed")
        .eq("from_address", payer)
        .in("kind", ["run", "policy_payment"])
        .eq("final", true)
        .eq("removed", false)
        .gte("block_time", campaign.starts_at)
        .order("seq", { ascending: true })
        .limit(50);
      if (eErr) throw new Error(eErr.message);
      const list = (rows ?? []) as EventRow[];

      const payerPersons = await personsOf(payer);
      let last = "no_payment";
      for (const e of list) {
        const payment: RewardPayment = {
          kind: e.kind,
          from: e.from_address,
          to: e.to_address,
          token: e.token,
          amount: e.amount === null ? null : BigInt(e.amount),
          amountIn: e.amount_in === null ? null : BigInt(e.amount_in),
          blockTime: new Date(e.block_time),
          final: e.final,
          removed: e.removed,
        };
        const recipientPersons = e.to_address && payerPersons.length ? await personsOf(e.to_address) : [];
        const back = e.to_address && payerPersons.length ? await paidBack(payer, e.to_address) : false;
        const d = decideReward({
          payment,
          campaign: { startsAt: new Date(campaign.starts_at), endsAt: campaign.ends_at ? new Date(campaign.ends_at) : null },
          excluded,
          payerPerson: payerPersons[0] ?? null,
          recipientPersons,
          paidBack: back,
        });
        if (!d.ok) {
          tally(d.reason);
          last = d.reason;
          if (d.reason === "no_identity") break; // the same for every payment of theirs
          continue;
        }
        if (dry) {
          report.wouldReserve.push({ wallet: payer, tx: e.tx_hash });
          continue payers;
        }
        const { data: res, error: rErr } = await db.rpc("reserve_reward", {
          p_campaign: CAMPAIGN,
          p_person: d.personKey,
          p_wallet: payer,
          p_tx: e.tx_hash,
          p_log_index: e.log_index,
        });
        if (rErr) throw new Error(`reserve_reward: ${rErr.message}`);
        const outcome = (res as { outcome: string }[])[0]?.outcome;
        if (outcome === "reserved") report.reserved++;
        else tally(outcome ?? "unknown");
        if (outcome === "full" || outcome === "closed") break payers;
        // "duplicate": this person already has one through another wallet.
        // Remember it, or this wallet would come back every hour.
        if (outcome !== "reserved") await checked(payer, cand.last_seq, outcome ?? "unknown");
        continue payers; // one reward per payer, whatever the outcome
      }
      // Nothing of theirs qualified this time.
      await checked(payer, cand.last_seq, last);
    }

    // 3. Pay what is reserved.
    if (dry) return json(report);
    const { data: open, error: oErr } = await db
      .from("rewards").select("*").eq("campaign_id", CAMPAIGN).eq("status", "reserved")
      .order("created_at", { ascending: true }).limit(MAX_PAYOUTS);
    if (oErr) throw new Error(oErr.message);
    if (!open?.length) return json(report);

    const gas = await pc.getBalance({ address: account.address });
    if (gas === 0n) {
      report.notes.push("rewards wallet has no CELO for gas");
      return json(report);
    }

    for (const r of open as RewardRow[]) {
      const amount = BigInt(r.amount_units);
      const balance = await pc.readContract({
        address: r.token as Address, abi: erc20Abi, functionName: "balanceOf", args: [account.address],
      });
      if (balance < amount) {
        report.notes.push("rewards wallet is out of the reward token; top it up");
        break;
      }
      const pending = await pc.getTransactionCount({ address: account.address, blockTag: "pending" });
      const nonce = Math.max(pending, lease.floor, mined === null ? 0 : mined + 1);
      const call = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [r.wallet as Address, amount] });
      const suffix = runSuffix([]); // our attribution tag, as on every transaction we cause
      const request = await wc.prepareTransactionRequest({
        to: r.token as Address,
        nonce,
        data: suffix ? concat([call, suffix]) : call,
      });
      const serialized = await wc.signTransaction(request);
      const hash = keccak256(serialized);

      // Saved before it is sent: a pass that dies after this line leaves bytes
      // the next pass resends, never a payment nobody recorded.
      const saved = await update(r.id, {
        status: "signed", tx_hash: hash, nonce, signed_tx: serialized, signed_at: new Date().toISOString(),
      }, "reserved");
      if (!saved) continue;

      await pc.sendRawTransaction({ serializedTransaction: serialized }).catch((e) =>
        console.error("pay-rewards: broadcast", (e as Error).message)
      );
      const receipt = await pc.waitForTransactionReceipt({ hash, timeout: 20_000 }).catch(() => null);
      if (!receipt) {
        report.notes.push(`payout ${hash} not mined yet; the next pass settles it`);
        break; // don't sign above a nonce that may not land
      }
      mined = nonce;
      if (receipt.status === "success") {
        await update(r.id, { status: "paid", error: null });
        report.paid++;
      } else {
        await retryOrFail(r, `reverted in ${hash}`);
      }
    }
    return json(report);
  } catch (e) {
    console.error("pay-rewards:", (e as Error).message);
    return json({ ...report, error: (e as Error).message }, 500);
  } finally {
    await lease.release(mined);
  }
});
