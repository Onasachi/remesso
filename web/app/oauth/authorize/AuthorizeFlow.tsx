"use client";

import { useMemo, useState } from "react";
import { createClient } from "@supabase/supabase-js";

/// Email, then the 6-digit code, then consent. The session this produces is
/// handed to the server once and never kept here: no storage and no automatic
/// refresh, so this tab never refreshes the token Claude will hold (Supabase
/// treats a second refresher as token theft and ends the session).

type Props = {
  clientId: string;
  clientHost: string;
  redirectUri: string;
  redirectHost: string;
  state: string;
  codeChallenge: string;
  scope: string;
};

type Session = { access_token: string; refresh_token: string; email: string };

export function AuthorizeFlow(p: Props) {
  const sb = useMemo(
    () =>
      createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      }),
    [],
  );
  const [step, setStep] = useState<"email" | "code" | "consent">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const app = p.clientHost.replace(/^www\./, "");

  async function sendCode() {
    setBusy(true);
    setError(null);
    const { error } = await sb.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: true } });
    setBusy(false);
    if (error) return setError(error.message);
    setStep("code");
  }

  async function checkCode() {
    setBusy(true);
    setError(null);
    const { data, error } = await sb.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "email" });
    setBusy(false);
    if (error || !data.session) return setError(error?.message ?? "That code didn't work. Check it, or send a new one.");
    setSession({ access_token: data.session.access_token, refresh_token: data.session.refresh_token, email: data.session.user.email ?? email });
    setStep("consent");
  }

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
        refresh_token: session?.refresh_token,
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
      <h1 className="mt-2 font-display text-[32px] leading-[1.08] text-ink">
        Let {app === "claude.ai" || app === "claude.com" ? "Claude" : app} use your Remesso agent.
      </h1>

      {step === "email" && (
        <form
          className="mt-6"
          onSubmit={(e) => {
            e.preventDefault();
            void sendCode();
          }}
        >
          <p className="text-[16px] leading-relaxed text-ink-2">
            Enter your email and we&apos;ll send you a 6-digit code. No password, no wallet needed here.
          </p>
          <label className="label mt-5" htmlFor="email">Email</label>
          <input id="email" className="field" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <button className="btn-primary mt-4 w-full" disabled={busy || !email.includes("@")}>
            {busy ? "Sending…" : "Send code"}
          </button>
        </form>
      )}

      {step === "code" && (
        <form
          className="mt-6"
          onSubmit={(e) => {
            e.preventDefault();
            void checkCode();
          }}
        >
          <p className="text-[16px] leading-relaxed text-ink-2">We sent a code to {email}. It can take a minute to arrive.</p>
          <label className="label mt-5" htmlFor="code">6-digit code</label>
          <input
            id="code"
            className="field mono text-[20px]"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={10}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          />
          <button className="btn-primary mt-4 w-full" disabled={busy || code.length < 6}>
            {busy ? "Checking…" : "Continue"}
          </button>
          <button type="button" className="btn-ghost mt-2 w-full" disabled={busy} onClick={() => setStep("email")}>
            Use a different email
          </button>
        </form>
      )}

      {step === "consent" && (
        <div className="mt-6">
          <p className="text-[16px] leading-relaxed text-ink-2">Signed in as <span className="text-ink">{session?.email}</span>.</p>
          <div className="card mt-5 space-y-3 text-[15px] leading-relaxed text-ink">
            <p className="font-semibold">{app} will be able to:</p>
            <ul className="list-disc space-y-1 pl-5 text-ink-2">
              <li>use an agent wallet Remesso keeps for you</li>
              <li>ask you to set its limits, which you sign in your own wallet</li>
              <li>pay people and services from your wallet, only within those limits</li>
            </ul>
            <p className="text-ink-2">
              It can never spend more than the per-payment and daily caps you set on-chain, and you can stop it any
              time from the setup page.
            </p>
          </div>
          <p className="hint">You&apos;ll go back to {p.redirectHost}.</p>
          <div className="mt-4 flex gap-2">
            <button className="btn-ghost flex-1" disabled={busy} onClick={() => void answer(false)}>Deny</button>
            <button className="btn-primary flex-1" disabled={busy} onClick={() => void answer(true)}>
              {busy ? "Connecting…" : "Allow"}
            </button>
          </div>
        </div>
      )}

      {error && <p className="mt-4 text-[14px] text-danger" role="alert">{error}</p>}
    </div>
  );
}
