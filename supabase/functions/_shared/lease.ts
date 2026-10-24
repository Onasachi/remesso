/// The executor key, one sender at a time.
///
/// `execute-due-runs` and `trigger-run` both sign with the executor's hot key.
/// Each takes this lease before fetching a nonce and releases it once its
/// transaction is mined, so two sends can never pick the same nonce. Why it is
/// a row and not a lock: migration `20261024000002_executor_lease.sql`.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { executorAccount } from "./celo.ts";

export type ExecutorLease = {
  /// Sign at no lower nonce than this: one past the last nonce a holder saw
  /// mined. Null until some holder has released with one.
  nonceFloor: number | null;
  /// Free the lease. Pass the nonce of a transaction that was mined, whether
  /// it succeeded or reverted: either way the nonce is used.
  release(minedNonce?: number): Promise<void>;
};

const POLL_MS = 150;

/// Take the lease, waiting up to `waitMs` for the current holder to finish.
/// Null if it never came free. Throws if the database can't be asked: sending
/// without the lease is exactly what it exists to prevent.
export async function takeExecutorLease(
  db: SupabaseClient,
  who: string,
  { ttlSec, waitMs }: { ttlSec: number; waitMs: number },
): Promise<ExecutorLease | null> {
  const executor = executorAccount().address.toLowerCase();
  const holder = `${who}:${crypto.randomUUID()}`;
  const until = Date.now() + waitMs;
  for (;;) {
    const { data, error } = await db.rpc("take_executor_lease", {
      p_executor: executor,
      p_holder: holder,
      p_seconds: ttlSec,
    });
    if (error) throw new Error(`executor lease: ${error.message}`);
    const row = (data as { taken: boolean; mined_nonce: number | null }[] | null)?.[0];
    if (row?.taken) {
      return {
        nonceFloor: row.mined_nonce === null ? null : Number(row.mined_nonce) + 1,
        release: async (minedNonce?: number) => {
          const { error } = await db.rpc("release_executor_lease", {
            p_executor: executor,
            p_holder: holder,
            p_mined_nonce: minedNonce ?? null,
          });
          // Not fatal: an unreleased lease expires by itself after `ttlSec`.
          if (error) console.error("executor lease: release failed", error.message);
        },
      };
    }
    if (Date.now() + POLL_MS > until) return null;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
