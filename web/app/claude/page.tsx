import type { Metadata } from "next";
import Link from "next/link";
import { CopyValue } from "@/components/ui";
import { Icon } from "@/components/Icon";

export const metadata: Metadata = {
  title: "Use Remesso in Claude · Remesso",
  description: "Send money, set up monthly payments and check what you pay, by asking Claude on your phone or computer.",
};

/// How to add Remesso to Claude. The connector URL is the one thing people
/// get wrong by retyping, so it carries a copy button; so do the commands.
const CONNECTOR = "https://remesso.xyz/mcp";

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="disc h-7 w-7 shrink-0 text-[13px] font-semibold">{n}</span>
      <div className="min-w-0 pt-0.5 text-[15px] leading-relaxed text-ink-2">{children}</div>
    </li>
  );
}

function Code({ value }: { value: string }) {
  return (
    <div className="mt-2 rounded-xl border border-line/70 bg-paper px-3 py-2">
      <CopyValue value={value} />
    </div>
  );
}

export default function ClaudePage() {
  return (
    <div className="stagger mt-6">
      <p className="eyebrow">Remesso for Claude</p>
      <h1 className="mt-2 font-display text-[36px] leading-[1.04] text-ink">
        Ask Claude to
        <br />
        <span className="text-clay">send the money.</span>
      </h1>
      <p className="mt-4 max-w-md text-[16px] leading-relaxed text-ink-2">
        &ldquo;Send Mum 20 USDT every month.&rdquo; &ldquo;What am I paying?&rdquo; Add Remesso to Claude once and ask in
        your own words, on your phone or your computer.
      </p>

      <section className="card mt-7">
        <div className="flex items-center gap-2.5">
          <span className="disc h-9 w-9"><Icon name="smartphone" /></span>
          <h2 className="text-[17px] font-semibold text-ink">The Claude app: phone, web and desktop</h2>
        </div>
        <ol className="mt-4 space-y-4">
          <Step n={1}>
            On <span className="text-ink">claude.ai</span> in a browser, open <span className="text-ink">Customize → Connectors</span>,
            then <span className="text-ink">+ → Add custom connector</span>. Connectors are added on the web and then
            appear in the iPhone and Android apps.
          </Step>
          <Step n={2}>
            Name it <span className="text-ink">Remesso</span> and paste this URL:
            <Code value={CONNECTOR} />
          </Step>
          <Step n={3}>
            Under Authentication choose <span className="text-ink">Sign in when needed</span>, then
            <span className="text-ink"> Add</span>. Nothing to sign up for yet.
          </Step>
          <Step n={4}>
            Start a new chat and ask, for example: <span className="text-ink">&ldquo;Use Remesso to send 20 USDT to
            0x… every month.&rdquo;</span> Claude prepares it and gives you a link; you check it and sign in your own
            wallet.
          </Step>
        </ol>
      </section>

      <section className="card mt-3">
        <div className="flex items-center gap-2.5">
          <span className="disc h-9 w-9"><Icon name="bolt" /></span>
          <h2 className="text-[17px] font-semibold text-ink">Hands-free payments</h2>
        </div>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
          Ask <span className="text-ink">&ldquo;Show my Remesso hands-free agent wallet.&rdquo;</span> Tap
          <span className="text-ink"> Connect</span>, sign in with a code sent to your email, and set your limits once in
          your wallet: a cap per payment, a cap per day, and how long. After that, &ldquo;Pay 5 USDT to 0x…&rdquo; just
          happens, after Claude checks with you.
        </p>
        <ul className="mt-3 space-y-1.5 text-[14px] leading-relaxed text-ink-2">
          <li className="flex gap-2"><Icon name="shield_lock" /> You own the agent. Remesso can only pay within the limits you sign.</li>
          <li className="flex gap-2"><Icon name="shield_lock" /> The money stays in your wallet until each payment.</li>
          <li className="flex gap-2">
            <Icon name="shield_lock" />
            <span>
              Stop it any time at{" "}
              <Link className="text-ink underline" href="/agent/stop">remesso.xyz/agent/stop</Link>.
            </span>
          </li>
        </ul>
      </section>

      <section className="card mt-3">
        <div className="flex items-center gap-2.5">
          <span className="disc h-9 w-9"><Icon name="auto_awesome" /></span>
          <h2 className="text-[17px] font-semibold text-ink">Claude Code, Codex and Cursor</h2>
        </div>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
          On a computer, Remesso comes as a plugin with an agent wallet that lives on your own machine. In Claude Code,
          run these one at a time:
        </p>
        <Code value="/plugin marketplace add https://bitbucket.org/crackedstudios/remesso.git" />
        <Code value="/plugin install remesso@remesso" />
        <p className="mt-4 text-[15px] leading-relaxed text-ink-2">In Codex, Cursor or any MCP app, add the wallet:</p>
        <Code value="npx -y remesso-wallet" />
      </section>

      <p className="mt-5 text-[13px] leading-relaxed text-ink-3">
        Remesso never sees your keys, and nothing moves without a limit you signed. Claude&apos;s free plan allows one
        custom connector. How we handle data is in our{" "}
        <Link className="underline" href="/privacy">Privacy Policy</Link>.
      </p>
    </div>
  );
}
