import type { Metadata } from "next";
import Link from "next/link";
import { CopyValue } from "@/components/ui";
import { Icon } from "@/components/Icon";

export const metadata: Metadata = {
  title: "Build with Remesso · Remesso",
  description:
    "remesso-sdk for TypeScript: schedules a payer signs once, agent payments capped on-chain, payment requests, " +
    "payment events and signed webhooks on Celo. From npm install to a payment and its webhook in about 15 minutes.",
};

/// The developer page: from `npm install` to a small mainnet payment and its
/// webhook with nothing else open (docs/agent-to-agent.md, step 4). Every
/// snippet is the SDK's real API. `packages/remesso-sdk/README.md` shows the
/// same quickstart, so change the two together.
const REPO = "https://bitbucket.org/crackedstudios/remesso/src/main";

const KEYS = `import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const key = generatePrivateKey();
console.log(key, privateKeyToAccount(key).address);`;

const RECEIVER = `import { createServer } from "node:http";
import { createRemesso, formatAmount, webhookHandler } from "remesso-sdk";
import { toNodeListener } from "remesso-sdk/node";
import { privateKeyToAccount } from "viem/accounts";

const receiver = createRemesso({
  account: privateKeyToAccount(process.env.RECEIVER_KEY as \`0x\${string}\`),
});

// Remesso returns the signing secret once your endpoint has answered its
// challenge, so the handler reads it when each delivery arrives.
let secret: string | undefined;

const handler = webhookHandler({
  recipient: receiver.address,
  secret: () => secret,
  onPayment: (m) =>
    console.log(m.type, formatAmount(m.data.amount, m.data.token), m.data.final ? "final" : "not final yet", m.data.txHash),
});

const server = createServer(toNodeListener(handler));
await new Promise<void>((done) => server.listen(8787, done));`;

const SUBSCRIBE = `const sub = await receiver.webhooks.subscribe({ url: process.env.PUBLIC_URL! });
secret = sub.secret; // shown once: save it if the receiver must survive a restart
console.log("subscribed", sub.subscription, "for", receiver.address);`;

const PAY = `import { createRemesso, formatAmount } from "remesso-sdk";
import { privateKeyToAccount } from "viem/accounts";

const payer = createRemesso({
  account: privateKeyToAccount(process.env.PAYER_KEY as \`0x\${string}\`),
});

const s = await payer.schedules.create({
  to: process.env.RECEIVER!,
  amount: "1",
  token: "USDT",
  every: "week",
  runs: 1,
});
console.log("schedule", s.id, "pays", formatAmount(s.recipientGets, "USDT"), s.hash);`;

const WATCH = `for await (const e of receiver.events.watch({ role: "to", kinds: ["run", "policy_payment"] })) {
  console.log(e.kind, formatAmount(e.amount!, e.token!), e.final ? "final" : "not final yet", e.txHash);
}`;

const REQUEST = `const req = await receiver.requests.create({
  payer: "0xTheirWallet",
  amount: "50",
  token: "USDT",
  every: "month",
  runs: 12,
  from: "Ada's studio",
  note: "monthly retainer",
});
console.log(req.link); // send it however you already reach them

const paid = await receiver.requests.waitUntilPaid(req.id);
console.log(paid.payment?.txs);`;

const ANSWER = `await payer.schedules.create({ request: req.id }); // the request's terms, the fee on top`;

const POLICY = `// The person, once:
await person.policies.create({
  agent: "0xAgentAddress",
  token: "USDT",
  perPayment: "5",
  perDay: "20",
  days: 30,
  budget: "100", // added to their USDT approval for the allowance contract
});`;

const AGENT_PAY = `import { createRemesso } from "remesso-sdk";
import { fileStore } from "remesso-sdk/node";
import { privateKeyToAccount } from "viem/accounts";

const agent = createRemesso({
  account: privateKeyToAccount(process.env.AGENT_KEY as \`0x\${string}\`),
  store: fileStore(), // the record that makes a retry pay once, kept on disk
});

const r = await agent.pay({ to: "0xShop", amount: "2.50", token: "USDT", idempotencyKey: "order-1042" });
// r.status is "confirmed", or "pending": call again with the same key, never a new one

await agent.requests.pay(requestId); // its reference goes in the memo, so the requester sees it`;

const BUILDER_CODES = `import { createRemesso } from "remesso-sdk";
import { privateKeyToAccount } from "viem/accounts";

const payer = createRemesso({
  account: privateKeyToAccount(process.env.PAYER_KEY as \`0x\${string}\`),
  builderCodes: ["your_code"],
});
const s = await payer.schedules.create({ to: "0xRecipient", amount: "5", token: "USDT", every: "month", runs: 12 });

// A minute later, what Remesso read from the transaction that created it:
const { events } = await payer.events.list({ role: "from", kinds: ["schedule_created"] });
console.log(events.find((e) => e.refId === s.id.toString())?.details?.builderCodes); // ["your_code"]`;

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="disc h-7 w-7 shrink-0 text-[13px] font-semibold">{n}</span>
      <div className="min-w-0 flex-1 pt-0.5 text-[15px] leading-relaxed text-ink-2">{children}</div>
    </li>
  );
}

/// A one-line command, copied whole.
function Code({ value }: { value: string }) {
  return (
    <div className="mt-2 rounded-xl border border-line/70 bg-paper px-3 py-2">
      <CopyValue value={value} />
    </div>
  );
}

/// A file or a few lines. Scrolls sideways on a phone rather than wrapping,
/// because wrapped code is code people retype wrongly.
function Snippet({ code }: { code: string }) {
  return (
    <div className="mt-2 overflow-hidden rounded-xl border border-line/70 bg-paper">
      <div className="flex justify-end px-2 pt-2">
        <CopyValue value={code} display="" label="Copy code" />
      </div>
      <pre className="overflow-x-auto px-3 pb-3 font-mono text-[12px] leading-relaxed text-ink">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function Out({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a className="text-ink underline" href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

export default function DevelopersPage() {
  return (
    <div className="stagger mt-6">
      <p className="eyebrow">Remesso for developers</p>
      <h1 className="mt-2 font-display text-[36px] leading-[1.04] text-ink">
        Build with
        <br />
        <span className="text-clay">remesso-sdk.</span>
      </h1>
      <p className="mt-4 max-w-md text-[16px] leading-relaxed text-ink-2">
        Schedules a payer signs once, agent payments capped on-chain by their person, payment requests, payment events
        and signed webhooks. TypeScript, on viem. Celo mainnet only.
      </p>

      <div className="notice-warn mt-5 text-[14px]">
        <p className="font-semibold">The contracts are live and have not been audited by a person.</p>
        <p className="mt-1">
          There is no testnet: everything here moves real money on Celo mainnet. Start with small amounts, a dollar
          rather than a payroll.
        </p>
      </div>

      <section className="card mt-7">
        <div className="flex items-center gap-2.5">
          <span className="disc h-9 w-9"><Icon name="bolt" /></span>
          <h2 className="text-[17px] font-semibold text-ink">Quickstart: a payment and its webhook</h2>
        </div>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
          About 15 minutes, most of it waiting. You need Node 20 or later.
        </p>
        <ol className="mt-4 space-y-5">
          <Step n={1}>
            Install, in a new folder. The SDK is ES modules only, and <span className="text-ink">tsx</span> runs
            TypeScript without a build.
            <Code value="npm init -y && npm pkg set type=module" />
            <Code value="npm install remesso-sdk viem" />
            <Code value="npm install -D tsx" />
          </Step>
          <Step n={2}>
            Make two keys, one that pays and one that receives. Save this as <span className="text-ink">keys.ts</span>{" "}
            and run <span className="text-ink">npx tsx keys.ts</span> twice:
            <Snippet code={KEYS} />
            <p className="mt-2">
              Send the payer about <span className="text-ink">1.05 USDT</span> on Celo, and a little CELO for gas if
              you have it. With no CELO, the SDK pays gas in USDT. The receiver needs nothing. Use keys that hold only
              what you are willing to lose, and keep them in your shell:
            </p>
            <Code value="export PAYER_KEY=0x… RECEIVER_KEY=0x… RECEIVER=0x…" />
          </Step>
          <Step n={3}>
            Run a receiver. In one terminal, open a public HTTPS address to port 8787. A Cloudflare quick tunnel needs
            no account, and prints a <span className="text-ink">trycloudflare.com</span> URL:
            <Code value="cloudflared tunnel --url http://localhost:8787" />
            <p className="mt-2">
              Then save this as <span className="text-ink">receiver.ts</span>:
            </p>
            <Snippet code={RECEIVER} />
          </Step>
          <Step n={4}>
            Subscribe. Add these lines to the end of <span className="text-ink">receiver.ts</span>, and run it with the
            tunnel&apos;s URL: <span className="text-ink">PUBLIC_URL=https://….trycloudflare.com npx tsx receiver.ts</span>.
            Remesso first posts a challenge to the URL; the handler answers it for your address only, and the signing
            secret comes back once.
            <Snippet code={SUBSCRIBE} />
            <p className="mt-2">
              A quick tunnel gets a new URL each time it starts, and an address can hold 5 subscriptions: drop old ones
              with <span className="text-ink">webhooks.revoke(&#123; url &#125;)</span>.
            </p>
          </Step>
          <Step n={5}>
            Pay. In a second terminal, save this as <span className="text-ink">pay.ts</span> and run{" "}
            <span className="text-ink">npx tsx pay.ts</span>. One payment of 1 USDT, the smallest the executor sends:
            it approves the contract and creates the schedule, two transactions.
            <Snippet code={PAY} />
          </Step>
          <Step n={6}>
            Watch the receiver&apos;s terminal. Remesso finds a schedule created outside its app within about 5
            minutes, and sends the payment within a minute of that. A minute or two later the handler gets{" "}
            <span className="text-ink">payment.received</span> with <span className="text-ink">final: false</span>:
            0.9975 USDT, after the 0.25% fee. <span className="text-ink">payment.finalized</span> follows when Celo
            finalizes the block, 25 to 30 minutes later. A failed delivery is retried with the same{" "}
            <span className="text-ink">webhook-id</span> for 24 hours, so dedupe on it.
            <p className="mt-2">No public endpoint? Pull the same events instead:</p>
            <Snippet code={WATCH} />
          </Step>
        </ol>
      </section>

      <section className="card mt-3">
        <div className="flex items-center gap-2.5">
          <span className="disc h-9 w-9"><Icon name="edit_note" /></span>
          <h2 className="text-[17px] font-semibold text-ink">Getting paid by request</h2>
        </div>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
          Ask a wallet to pay you. The request lands in their Remesso inbox, and the link opens their form filled in.
          It carries <span className="text-ink">req=</span>, so the schedule they sign is reported against your
          request. Nothing is authorised until they sign in their own wallet.
        </p>
        <Snippet code={REQUEST} />
        <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
          A requested amount is what you receive: their form signs <span className="text-ink">grossFor</span> of it,
          the amount plus the fee. Accepted is not paid; <span className="text-ink">waitUntilPaid</span> waits for a
          payment with a transaction. A payer using the SDK answers with the request&apos;s own terms:
        </p>
        <Snippet code={ANSWER} />
      </section>

      <section className="card mt-3">
        <div className="flex items-center gap-2.5">
          <span className="disc h-9 w-9"><Icon name="account_balance_wallet" /></span>
          <h2 className="text-[17px] font-semibold text-ink">Agent payments</h2>
        </div>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
          A person gives their agent&apos;s key a policy: one token, a cap per payment and per day, an expiry, and
          optionally a list of the only recipients allowed. They set it at{" "}
          <Link className="text-ink underline" href="/agent-wallet">remesso.xyz/agent-wallet</Link>, or in code. The
          agent then pays from the person&apos;s wallet, and the contract refuses anything outside the policy. No fee:
          what the agent pays is what arrives.
        </p>
        <Snippet code={POLICY} />
        <Snippet code={AGENT_PAY} />
        <ul className="mt-3 space-y-1.5 text-[14px] leading-relaxed text-ink-2">
          <li className="flex gap-2">
            <Icon name="check_circle" /> A retry with the same idempotency key pays once, even when the first attempt
            timed out after it was sent.
          </li>
          <li className="flex gap-2">
            <Icon name="check_circle" /> <span><span className="text-ink">fileStore</span> keeps that record on disk, so
            it holds across restarts.</span>
          </li>
          <li className="flex gap-2">
            <Icon name="check_circle" /> Without a key, an identical payment within ten minutes is refused unless you
            pass <span className="text-ink">allowRepeat</span>.
          </li>
          <li className="flex gap-2">
            <Icon name="check_circle" /> The agent&apos;s key pays its own gas: send it a little CELO.
          </li>
        </ul>
      </section>

      <section id="builder-codes" className="card mt-3 scroll-mt-6">
        <div className="flex items-center gap-2.5">
          <span className="disc h-9 w-9"><Icon name="verified_user" /></span>
          <h2 className="text-[17px] font-semibold text-ink">Builder codes</h2>
        </div>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
          Celo credits on-chain volume to the app that caused it, by the ERC-8021 code on each transaction (
          <Out href="https://github.com/celo-org/attribution-tags">attribution tags</Out>). Pass your own, and every
          transaction this client sends carries it after Remesso&apos;s. Remesso&apos;s executor then carries it on
          every run of each schedule the client creates, so the volume a schedule moves counts for you too, for as long
          as it runs.
        </p>
        <Snippet code={BUILDER_CODES} />
        <ul className="mt-3 space-y-1.5 text-[14px] leading-relaxed text-ink-2">
          <li className="flex gap-2">
            <Icon name="check_circle" /> Up to three codes, each 1 to 32 of a-z, 0-9 and _. The SDK refuses anything
            else before signing, by the rules the executor applies.
          </li>
          <li className="flex gap-2">
            <Icon name="check_circle" /> <span>Without the SDK, tag your own createSchedule transaction with{" "}
            <span className="text-ink">toDataSuffix</span> or <span className="text-ink">withAttribution</span> from
            @celo/attribution-tags. Only Schema 0, the one they write, is read. A schedule created through an ERC-4337
            bundle isn&apos;t read yet: the codes come from the outer transaction.</span>
          </li>
          <li className="flex gap-2">
            <Icon name="check_circle" /> The suffix sits after the calldata, where the EVM ignores it. A code changes
            who is credited, never what a payment does.
          </li>
        </ul>
      </section>

      <section className="card mt-3">
        <div className="flex items-center gap-2.5">
          <span className="disc h-9 w-9"><Icon name="info" /></span>
          <h2 className="text-[17px] font-semibold text-ink">What it costs</h2>
        </div>
        <ul className="mt-3 space-y-3 text-[15px] leading-relaxed text-ink-2">
          <li>
            <span className="text-ink">0.25% of each scheduled payment</span>, taken from it and rounded up: a 1 USDT
            payment delivers 0.9975. Policy payments carry no fee. Receiving costs nothing at all.
          </li>
          <li>
            <span className="text-ink">Per payment, the executor sends the equivalent of 1 to 1,000 dollars</span>: 1
            to 1,000 USDT, USDC, USA₮ or USDm; 1,500 to 1.5 million wARS; 5 to 5,000 wBRL; 3,100 to 3.1 million wCOP;
            18 to 18,000 wMXN; 950 to 950,000 wCLP; 3 to 3,000 wPEN; 1,300 to 1.3 million cNGN. Outside that a schedule is valid on-chain and never runs, so the SDK refuses it
            before signing. <span className="text-ink">runLimits(token)</span> gives the bounds, and{" "}
            <Out href="https://engaboljiqudghvzmebq.supabase.co/functions/v1/agent">/agent</Out> publishes them under{" "}
            <span className="text-ink">limits.perRun</span>.
          </li>
          <li>
            <span className="text-ink">Gas, measured on our own transactions, not promised</span>: creating a schedule
            is about 224,000 gas (about $0.004) plus an approval, paid by the payer. Each payment is about 91,875 gas,
            paid by Remesso&apos;s executor. A policy payment is about 85,000 gas, paid by the agent. That was at 202
            gwei with CELO near $0.09; the numbers move with both.
          </li>
        </ul>
      </section>

      <section className="card mt-3">
        <div className="flex items-center gap-2.5">
          <span className="disc h-9 w-9"><Icon name="open_in_new" /></span>
          <h2 className="text-[17px] font-semibold text-ink">Reference</h2>
        </div>
        <ul className="mt-3 space-y-2 text-[15px] leading-relaxed text-ink-2">
          <li>
            <Out href="https://www.npmjs.com/package/remesso-sdk">remesso-sdk on npm</Out>, and its{" "}
            <Out href={`${REPO}/packages/remesso-sdk/`}>README</Out>: every function, every error code.
          </li>
          <li>
            <Out href={`${REPO}/docs/AGENTS.md`}>docs/AGENTS.md</Out>: the same endpoints over plain HTTP, for any
            language.
          </li>
          <li>
            Two example agents: <Out href={`${REPO}/examples/freelancer-agent.ts`}>a freelancer billing in wARS</Out>{" "}
            and <Out href={`${REPO}/examples/family-allowance-agent.ts`}>a family allowance in cNGN</Out>.
          </li>
          <li>
            <Link className="text-ink underline" href="/claude">Remesso in Claude</Link>: the connector, the plugin and
            the wallet.
          </li>
          <li>
            <a className="text-ink underline" href="/.well-known/agent.json">/.well-known/agent.json</a>: every
            endpoint, the contracts and the registrations, in one document.
          </li>
        </ul>
      </section>

      <p className="mt-5 text-[13px] leading-relaxed text-ink-3">
        Remesso never holds your keys. The contract is the authority on what moves: if an endpoint and the contract
        disagree, the contract is right. The source is on{" "}
        <a className="underline" href="https://bitbucket.org/crackedstudios/remesso" target="_blank" rel="noreferrer">
          Bitbucket
        </a>
        .
      </p>
    </div>
  );
}
