/// The deployment tables' rows as plain data, from the manifest copy in
/// src/data/deployment.json. Deployment.tsx renders them on the site and
/// scripts/build-ai-docs.ts writes them as Markdown for AI assistants, so a
/// page and the Markdown made from it can't say different things.

export type Deployment = {
  chain: { name: string; chainId: number; caip2: string; rpc: string };
  tokens: {
    symbol: string;
    address: string;
    decimals: number;
    currency: string;
    feeCurrency?: string | null;
    minPerRun: string;
    maxPerRun: string;
  }[];
  contracts: {
    RemessoExecutorV5: { address: string; deployBlock: number; executor: string; currentExecutorSentinel: string; feeBps: number };
    RemessoAgentAllowance: { address: string; deployBlock: number };
    ERC8004IdentityRegistry: { address: string };
  };
  functions: Record<string, string>;
};

/// A cell's text: plain strings and code spans.
export type Text = (string | { code: string })[];

export const EXPLORER = "https://celoscan.io/address/";

/// Base units as a decimal, with thousands separators: "1,500,000".
export function amount(base: string, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const value = BigInt(base);
  const whole = (value / unit).toLocaleString("en-US");
  const frac = (value % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/// Every token a schedule can pay in, with the executor's per-payment bounds.
export function tokenRows(d: Deployment) {
  return d.tokens.map((t) => ({
    symbol: t.symbol,
    currency: t.currency,
    decimals: t.decimals,
    perPayment: `${amount(t.minPerRun, t.decimals)} to ${amount(t.maxPerRun, t.decimals)}`,
    paysGas: Boolean(t.feeCurrency),
    address: t.address,
  }));
}

/// The chain the SDK signs for, and nothing else.
export function chainRows(d: Deployment): { label: string; value: Text }[] {
  const c = d.chain;
  return [
    { label: "Network", value: [`${c.name} mainnet`] },
    { label: "Chain id", value: [{ code: String(c.chainId) }, " (", { code: c.caip2 }, ")"] },
    { label: "Default RPC", value: [{ code: c.rpc }] },
  ];
}

/// The contracts and keys, with what each one does. `linked` is false for the
/// sentinel, which is a value to pass rather than an account to look up.
export function contractRows(d: Deployment): { name: string; address: string; linked: boolean; note: string }[] {
  const v5 = d.contracts.RemessoExecutorV5;
  const allowance = d.contracts.RemessoAgentAllowance;
  return [
    {
      name: "RemessoExecutorV5",
      address: v5.address,
      linked: true,
      note: `Holds every schedule. Commission ${v5.feeBps / 100}% (${v5.feeBps} bps), pinned per schedule when it is signed. ` +
        `Deployed at block ${v5.deployBlock.toLocaleString("en-US")}.`,
    },
    {
      name: "RemessoAgentAllowance",
      address: allowance.address,
      linked: true,
      note: "Agent spending policies: a cap per payment and per day, an expiry, an optional recipient list. No owner, no admin. " +
        `Deployed at block ${allowance.deployBlock.toLocaleString("en-US")}.`,
    },
    {
      name: "ERC-8004 identity registry",
      address: d.contracts.ERC8004IdentityRegistry.address,
      linked: true,
      note: "Where agents are registered; the SDK reads an agent's wallet from it.",
    },
    {
      name: "Executor key",
      address: v5.executor,
      linked: true,
      note: "Remesso's hot key, which sends each payment when it is due. It pays gas and nothing else.",
    },
    {
      name: "Trigger sentinel",
      address: v5.currentExecutorSentinel,
      linked: false,
      note: "Grant this as a schedule's trigger to let Remesso's executor, whichever key it is at the time, bring a payment forward.",
    },
  ];
}

const ENDPOINTS: Record<string, string> = {
  agent: "The capability document: identity, chain, limits, prices and refusals. Free.",
  "request-payment": "Payment requests: create, status, list, answer, decline. Free.",
  "payment-events": "Every payment to or from an address, as Remesso's indexer reads it from the chain. Free.",
  webhooks: "Subscribe an address's payments to your endpoint, signed. Free.",
  "trigger-run": "Bring one payment of a schedule forward, paid over x402.",
  "rate-service": "USDT/NGN and USDC/NGN rates, paid over x402.",
  "latam-rate": "USD to wARS and wBRL rates, paid over x402.",
  "latam-route": "A route for delivering pesos or reais, paid over x402.",
};

/// Remesso's HTTP endpoints. The SDK calls the first four for you.
export function endpointRows(d: Deployment): { url: string; note: string }[] {
  return Object.keys(ENDPOINTS)
    .filter((name) => d.functions[name])
    .map((name) => ({ url: d.functions[name], note: ENDPOINTS[name] }));
}

/// The fee as a percentage: "0.25%".
export const feePercent = (d: Deployment) => `${d.contracts.RemessoExecutorV5.feeBps / 100}%`;
