"use client";

import { useState } from "react";
import { EmailCodeSignIn, type CodeSession } from "@/components/EmailCodeSignIn";

/// Stop my agent: the person signs in with their email code and removes
/// Remesso as a signer from the agent they own. Only the owner can do this,
/// and Remesso cannot undo it without the person signing in again. Every Claude
/// session for them ends too. The money side is separate and already theirs:
/// the on-chain policy can be revoked from their own wallet on /agent-wallet.

export default function StopAgentPage() {
  const [session, setSession] = useState<CodeSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ address?: string; stopped: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function stop() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/agent/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ access_token: session?.access_token }),
    });
    const out = (await res.json().catch(() => ({}))) as { stopped?: boolean; address?: string; error?: string };
    setBusy(false);
    if (!res.ok) return setError(out.error ?? "Something went wrong. Try again.");
    setDone({ stopped: Boolean(out.stopped), address: out.address });
  }

  return (
    <div className="stagger mt-8 max-w-md">
      <p className="eyebrow">Remesso agent</p>
      <h1 className="mt-2 font-display text-[32px] leading-[1.08] text-ink">Stop your agent.</h1>

      {done ? (
        <div className="mt-6 space-y-4 text-[16px] leading-relaxed text-ink-2">
          {done.stopped ? (
            <>
              <p className="text-ink">Done. Remesso can no longer pay for you, and every Claude session using it has ended.</p>
              <p>
                Your agent wallet is still yours. To also cancel the spending limit you set on-chain, open{" "}
                <a className="text-clay underline" href={`/agent-wallet${done.address ? `?agent=${done.address}` : ""}`}>the setup page</a>{" "}
                in your wallet and press Stop there.
              </p>
            </>
          ) : (
            <p>There is no Remesso agent for this email, so there is nothing to stop.</p>
          )}
        </div>
      ) : !session ? (
        <EmailCodeSignIn intro="Sign in with the email you used to connect Remesso to Claude. We'll send you a 6-digit code." onSignedIn={setSession} />
      ) : (
        <div className="mt-6">
          <p className="text-[16px] leading-relaxed text-ink-2">Signed in as <span className="text-ink">{session.email}</span>.</p>
          <p className="mt-3 text-[16px] leading-relaxed text-ink-2">
            This removes Remesso from your agent, so it can no longer pay for you. To use hands-free payments again
            later, reconnect Remesso in Claude.
          </p>
          <button className="btn-danger mt-5 w-full" disabled={busy} onClick={() => void stop()}>
            {busy ? "Stopping…" : "Stop my agent"}
          </button>
          {error && <p className="mt-4 text-[14px] text-danger" role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}
