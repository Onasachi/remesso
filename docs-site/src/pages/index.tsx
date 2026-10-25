import type { ReactNode } from "react";
import Link from "@docusaurus/Link";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import CodeBlock from "@theme/CodeBlock";
import Heading from "@theme/Heading";
import Layout from "@theme/Layout";
import deployment from "@site/src/data/deployment.json";
import styles from "./index.module.css";

const SAMPLE = `import { createRemesso } from "remesso-sdk";
import { privateKeyToAccount } from "viem/accounts";

const key = process.env.PAYER_KEY as \`0x\${string}\`;
const payer = createRemesso({ account: privateKeyToAccount(key) });

// Signed once. Remesso sends each payment when it is due.
const schedule = await payer.schedules.create({
  to: process.env.RECIPIENT!,
  receive: "250", // what arrives each month, after the fee
  token: "USDT",
  every: "month",
  runs: 12,
});`;

const BLOCKS = [
  {
    title: "Schedules",
    to: "/docs/guides/schedules",
    text: "A payer signs a fixed amount to a fixed address on a fixed cadence, once. Remesso sends each payment when it is due, and nothing can change its terms.",
  },
  {
    title: "Agent payments",
    to: "/docs/guides/agent-payments",
    text: "A person caps what their AI agent can spend: per payment, per day, until a date. The contract refuses the rest, and a retried payment pays once.",
  },
  {
    title: "Payment requests",
    to: "/docs/guides/payment-requests",
    text: "Ask a wallet to pay you, send a link that opens their form filled in, and know when the payment arrives.",
  },
  {
    title: "Events and webhooks",
    to: "/docs/guides/webhooks",
    text: "Every payment to an address, read from the chain and delivered to your server signed, with finality and reorgs handled.",
  },
];

const USE_CASES = [
  { title: "Subscriptions for your app", to: "/docs/use-cases/subscriptions" },
  { title: "Pay a team on a schedule", to: "/docs/use-cases/payroll" },
  { title: "Send money home every month", to: "/docs/use-cases/remittances" },
  { title: "Bill a client every month", to: "/docs/use-cases/freelancer-retainer" },
  { title: "A weekly allowance", to: "/docs/use-cases/family-allowance" },
  { title: "Give an AI agent a budget", to: "/docs/use-cases/ai-agent-budget" },
];

const STEPS = [
  { n: "1", title: "Sign once", text: "The payer approves the contract and creates a schedule from their own wallet." },
  { n: "2", title: "Remesso sends each payment", text: "When a payment is due, Remesso's executor asks the contract to send it. The executor pays the gas." },
  { n: "3", title: "You hear about it", text: "Your server receives a signed webhook, then a second one when Celo finalizes the block." },
];

function Hero(): ReactNode {
  return (
    <header className={styles.hero}>
      <div className={`container ${styles.heroGrid}`}>
        <div>
          <p className={styles.eyebrow}>remesso-sdk · TypeScript · Celo</p>
          <Heading as="h1" className={styles.title}>
            Recurring and agent payments, in a few lines of TypeScript.
          </Heading>
          <p className={styles.lead}>
            A payer signs once. Remesso sends each payment when it is due, and your server hears about it from a signed
            webhook. Stablecoins and local currencies, on Celo.
          </p>
          <div className={styles.actions}>
            <Link className="button button--primary button--lg" to="/docs/quickstart">
              Start the quickstart
            </Link>
            <Link className="button button--secondary button--lg" to="/docs/concepts">
              Read the concepts
            </Link>
          </div>
          <div className={styles.install}>
            <CodeBlock language="bash">npm install remesso-sdk viem</CodeBlock>
          </div>
        </div>
        <div className={styles.sample}>
          <CodeBlock language="ts" title="pay.ts">
            {SAMPLE}
          </CodeBlock>
        </div>
      </div>
    </header>
  );
}

function Blocks(): ReactNode {
  return (
    <section className={styles.section}>
      <div className="container">
        <Heading as="h2" className={styles.sectionTitle}>
          What you can build
        </Heading>
        <div className={styles.cards}>
          {BLOCKS.map((b) => (
            <Link key={b.title} to={b.to} className={styles.card}>
              <span className={styles.cardTitle}>{b.title}</span>
              <span className={styles.cardText}>{b.text}</span>
              <span className={styles.cardMore}>Read the guide</span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

function Steps(): ReactNode {
  return (
    <section className={`${styles.section} ${styles.tinted}`}>
      <div className="container">
        <Heading as="h2" className={styles.sectionTitle}>
          How a payment moves
        </Heading>
        <ol className={styles.steps}>
          {STEPS.map((s) => (
            <li key={s.n} className={styles.step}>
              <span className={styles.stepNumber}>{s.n}</span>
              <span className={styles.cardTitle}>{s.title}</span>
              <span className={styles.cardText}>{s.text}</span>
            </li>
          ))}
        </ol>
        <p className={styles.note}>
          The payer's signature is the authority: the contract checks every payment against it. Remesso can't change the
          recipient, the amount or the cadence, and can't pay early unless the payer allowed it.
        </p>
      </div>
    </section>
  );
}

function UseCases(): ReactNode {
  return (
    <section className={styles.section}>
      <div className="container">
        <Heading as="h2" className={styles.sectionTitle}>
          Use cases, built end to end
        </Heading>
        <div className={styles.useCases}>
          {USE_CASES.map((u) => (
            <Link key={u.to} to={u.to} className={styles.useCase}>
              {u.title}
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

function Facts(): ReactNode {
  const fee = deployment.contracts.RemessoExecutorV5.feeBps / 100;
  const facts = [
    { value: "Celo mainnet", label: `chain ${deployment.chain.chainId}` },
    { value: `${deployment.tokens.length} tokens`, label: deployment.tokens.map((t) => t.symbol).join(", ") },
    { value: `${fee}%`, label: "of each scheduled payment; agent payments are free" },
    { value: "No node", label: "events and webhooks come from Remesso's indexer" },
  ];
  return (
    <section className={`${styles.section} ${styles.tinted}`}>
      <div className="container">
        <div className={styles.facts}>
          {facts.map((f) => (
            <div key={f.value} className={styles.fact}>
              <span className={styles.factValue}>{f.value}</span>
              <span className={styles.factLabel}>{f.label}</span>
            </div>
          ))}
        </div>
        <div className={styles.warning}>
          <strong>Real money, unaudited contracts.</strong> There is no testnet: everything moves real money on Celo
          mainnet, and the contracts have not been audited by a person. Start with a dollar, not a payroll.
        </div>
      </div>
    </section>
  );
}

export default function Home(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout title={siteConfig.title} description="remesso-sdk: recurring and agent payments in stablecoins on Celo, in TypeScript.">
      <Hero />
      <main>
        <Blocks />
        <Steps />
        <UseCases />
        <Facts />
      </main>
    </Layout>
  );
}
