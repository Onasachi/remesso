/// `createRemesso`: one client for paying, being paid, and knowing you were.
import { type Account, type Address, createPublicClient, createWalletClient, http, type PublicClient, type WalletClient } from "viem";
import { celo } from "viem/chains";
import { type Agents, makeAgents } from "./agents.js";
import { attributionFor } from "./attribution.js";
import { makeCtx } from "./context.js";
import { deployment } from "./deployment.js";
import { type Events, makeEvents } from "./events.js";
import { type PayLinkInput, payLink } from "./links.js";
import { makePay, type PayInput, type PaymentResult } from "./payments.js";
import { makePolicies, type Policies } from "./policies.js";
import { makeRequests, type Requests } from "./requests.js";
import { makeSchedules, type Schedules } from "./schedules.js";
import { memoryStore, type PaymentStore } from "./store.js";
import { makeWebhooks, type Webhooks } from "./webhooks.js";

export type RemessoOptions = {
  /**
   * The key that pays, signs and receives: `privateKeyToAccount(...)`. Agent
   * payments need a local account like this one. Leave it out to read only.
   */
  account?: Account;
  /** A wallet client instead of an account, e.g. a browser wallet on Celo. */
  walletClient?: WalletClient;
  /** Default https://forno.celo.org. */
  rpcUrl?: string;
  publicClient?: PublicClient;
  /** Where agent payments are recorded so a retry pays once. Default: memory; see `fileStore` in remesso-sdk/node. */
  store?: PaymentStore;
  /** Reads an https or ipfs registration file for `agents.find`; `safeFetchText` from remesso-sdk/node. */
  fetchText?: (url: string) => Promise<string>;
  /** Tag transactions for ERC-8021 attribution. Default true. */
  attribution?: boolean;
  /**
   * Your own ERC-8021 builder codes, up to three, carried after Remesso's on
   * every transaction this client sends. Remesso's executor also carries them
   * on every run of the schedules you create, so Celo counts that volume for
   * you. Throws on a code outside Celo's charset, one of Remesso's own, a
   * repeat, or more than three.
   */
  builderCodes?: string[];
  /** For tests: another Remesso backend, and the app origin links point at. */
  functionsUrl?: string;
  appOrigin?: string;
  fetch?: typeof fetch;
};

export type Remesso = {
  /** This client's address, or null when it only reads. */
  address: Address | null;
  publicClient: PublicClient;
  deployment: typeof deployment;
  /** Pay on a schedule: sign once, Remesso's executor sends each payment when due. */
  schedules: Schedules;
  /** As an agent, pay through a policy your person set. At most once per idempotency key. */
  pay(input: PayInput): Promise<PaymentResult>;
  /** Spending limits a person grants an agent. */
  policies: Policies;
  /** Ask to be paid, see requests sent to you, answer or decline them. */
  requests: Requests;
  /** Every payment to or from an address, as Remesso's indexer reads it from the chain. */
  events: Events;
  /** Have payments announced to your server, signed. */
  webhooks: Webhooks;
  /** Other agents in the ERC-8004 registry, and what they accept. */
  agents: Agents;
  /** The link that opens a payer's Remesso form prefilled, to this account by default. */
  payLink(p: Omit<PayLinkInput, "to"> & { to?: string }): string;
};

/// With an account, `address` is that account's.
export function createRemesso(opts: RemessoOptions & ({ account: Account } | { walletClient: WalletClient & { account: Account } })): Remesso & { address: Address };
export function createRemesso(opts?: RemessoOptions): Remesso;
export function createRemesso(opts: RemessoOptions = {}): Remesso {
  const rpc = opts.rpcUrl ?? deployment.chain.rpc;
  const pub: PublicClient = opts.publicClient ?? (createPublicClient({ chain: celo, transport: http(rpc) }) as PublicClient);
  const account = opts.walletClient?.account ?? opts.account ?? null;
  const wallet = opts.walletClient ?? (account ? createWalletClient({ account, chain: celo, transport: http(rpc) }) : null);
  const base = (opts.functionsUrl ?? deployment.functions.base).replace(/\/+$/, "");
  const appOrigin = opts.appOrigin ?? deployment.app.origin;

  const ctx = makeCtx({
    pub,
    wallet,
    account,
    endpoints: {
      requestPayment: opts.functionsUrl ? `${base}/request-payment` : deployment.functions["request-payment"],
      paymentEvents: opts.functionsUrl ? `${base}/payment-events` : deployment.functions["payment-events"],
      webhooks: opts.functionsUrl ? `${base}/webhooks` : deployment.functions.webhooks,
    },
    appOrigin,
    fetch: opts.fetch ?? globalThis.fetch.bind(globalThis),
    dataSuffix: attributionFor(opts.builderCodes, opts.attribution !== false),
    store: opts.store ?? memoryStore(),
    fetchText: opts.fetchText,
  });

  const policies = makePolicies(ctx);
  const pay = makePay(ctx, policies);
  const requests = makeRequests(ctx, { pay, policies });
  const schedules = makeSchedules(ctx, { getRequest: requests.get, answer: requests.answer });

  return {
    address: account?.address ?? null,
    publicClient: pub,
    deployment,
    schedules,
    pay,
    policies,
    requests,
    events: makeEvents(ctx),
    webhooks: makeWebhooks(ctx),
    agents: makeAgents(ctx),
    payLink(p) {
      const to = p.to ?? account?.address;
      if (!to) throw new Error("payLink needs to without an account");
      return payLink({ ...p, to }, appOrigin);
    },
  };
}
