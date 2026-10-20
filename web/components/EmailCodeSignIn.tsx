"use client";

import { useMemo, useState } from "react";
import { createClient } from "@supabase/supabase-js";

/// Sign in with a 6-digit email code, for the connector's pages (authorize and
/// stop). The session lives only in this component's memory: no storage and no
/// automatic refresh, and it never touches the app's own anonymous session.

export type CodeSession = { access_token: string; email: string };

export function EmailCodeSignIn({ intro, onSignedIn }: { intro: string; onSignedIn: (s: CodeSession) => void }) {
  const sb = useMemo(
    () =>
      createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      }),
    [],
  );
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    onSignedIn({ access_token: data.session.access_token, email: data.session.user.email ?? email });
  }

  return (
    <>
      {step === "email" ? (
        <form
          className="mt-6"
          onSubmit={(e) => {
            e.preventDefault();
            void sendCode();
          }}
        >
          <p className="text-[16px] leading-relaxed text-ink-2">{intro}</p>
          <label className="label mt-5" htmlFor="email">Email</label>
          <input id="email" className="field" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <button className="btn-primary mt-4 w-full" disabled={busy || !email.includes("@")}>
            {busy ? "Sending…" : "Send code"}
          </button>
        </form>
      ) : (
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
      {error && <p className="mt-4 text-[14px] text-danger" role="alert">{error}</p>}
    </>
  );
}
