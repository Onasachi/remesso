"use client";

import { useState } from "react";
import { EmailCodeSignIn, type CodeSession } from "@/components/EmailCodeSignIn";

/// Email code, then consent. The session's access token goes to the server
/// once, to set up the person's own agent, and nothing is stored or refreshed.

type Props = {
  clientId: string;
  clientHost: string;
  redirectUri: string;
  redirectHost: string;
  state: string;
  codeChallenge: string;
  scope: string;
};

export function AuthorizeFlow(p: Props) {
  const [session, setSession] = useState<CodeSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const app = p.clientHost.replace(/^www\./, "");
  const name = app === "claude.ai" || app === "claude.com" ? "Claude" : app;

  async function answer(allow: boolean) {
    if (!allow) {
      const u = new URL(p.redirectUri);
      u.searchParams.set("error", "access_denied");
      u.searchParams.set("error_description", "the person declined");
      if (p.state) u.searchParams.set("state", p.state);
      window.location.assign(u.toString());
      return;
    }
    setBusy(true);
    setError(null);
    const res = await fetch("/api/oauth/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: p.clientId,
        redirect_uri: p.redirectUri,
        state: p.state,
        code_challenge: p.codeChallenge,
        code_challenge_method: "S256",
        scope: p.scope,
        access_token: session?.access_token,
      }),
    });
    const out = (await res.json().catch(() => ({}))) as { redirect?: string; error?: string };
    if (!res.ok || !out.redirect) {
      setBusy(false);
      return setError(out.error ?? "Something went wrong. Try again.");
    }
    window.location.assign(out.redirect);
  }

  return (
    <div className="stagger mt-8 max-w-md">
      <p className="eyebrow">Sign in to Remesso</p>
      <h1 className="mt-2 font-display text-[32px] leading-[1.08] text-ink">Let {name} use your Remesso agent.</h1>

      {!session ? (
        <EmailCodeSignIn intro="Enter your email and we'll send you an 8-digit code. No password, no wallet needed here." onSignedIn={setSession} />
      ) : (
        <div className="mt-6">
          <p className="text-[16px] leading-relaxed text-ink-2">Signed in as <span className="text-ink">{session.email}</span>.</p>
          <div className="card mt-5 space-y-3 text-[15px] leading-relaxed text-ink">
            <p className="font-semibold">{name} will be able to:</p>
            <ul className="list-disc space-y-1 pl-5 text-ink-2">
              <li>use an agent wallet that you own, with Remesso as its only signer</li>
              <li>ask you to set its limits, which you sign in your own wallet</li>
              <li>pay people and services from your wallet, only within those limits</li>
            </ul>
            <p className="text-ink-2">
              It can never spend more than the per-payment and daily caps you set on-chain. You can remove Remesso
              from your agent any time at remesso.xyz/agent/stop, and only you can.
            </p>
          </div>
          <p className="hint">You&apos;ll go back to {p.redirectHost}.</p>
          <div className="mt-4 flex gap-2">
            <button className="btn-ghost flex-1" disabled={busy} onClick={() => void answer(false)}>Deny</button>
            <button className="btn-primary flex-1" disabled={busy} onClick={() => void answer(true)}>
              {busy ? "Setting up your agent…" : "Allow"}
            </button>
          </div>
          {error && <p className="mt-4 text-[14px] text-danger" role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}
