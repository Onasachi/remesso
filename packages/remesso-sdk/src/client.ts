/// `createRemesso`: one client for paying, being paid, and knowing you were.
import { type Account, type Address, createPublicClient, createWalletClient, http, type PublicClient, type Transport, type WalletClient } from "viem";
import { celo } from "viem/chains";
import { type Agents, makeAgents } from "./agents.js";
import { attributionFor } from "./attribution.js";
import { makeCtx } from "./context.js";
import { deployment, token, toUnits } from "./deployment.js";
import { RemessoError } from "./errors.js";
import { type Events, makeEvents } from "./events.js";
import { type PayLinkInput, payLink } from "./links.js";
import { makePay, type PayInput, type PaymentResult } from "./payments.js";
import { makePolicies, type Policies } from "./policies.js";
import { makeRequests, type Requests } from "./requests.js";
import { makeSchedules, type Schedules } from "./schedules.js";
import { makeReceipts, type Receipts } from "./receipts.js";
import { makeRemittances, type Remittances } from "./remittances.js";
import { memoryRemittanceStore, type RemittanceStore } from "./remittance-store.js";
import { makeWalletRemittances } from "./wallet-remittances.js";
import { makeLifecycle } from "./lifecycle.js";
import { makeQuotes } from "./quotes.js";
import { makeInvoices, type Invoices, type InvoiceStore } from "./invoices.js";
import type { SignerCoordinator } from "./coordination.js";
import { formatUnits } from "viem";
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
  publicClient?: PublicClient | PublicClient<Transport, typeof celo>;
  /** Where agent payments are recorded so a retry pays once. Default: memory; see `fileStore` in remesso-sdk/node. */
  store?: PaymentStore;
  /** Durable wallet-funded send progress. See fileRemittanceStore in remesso-sdk/node. */
  remittanceStore?: RemittanceStore;
  /** Shared lock and nonce floor for every process using this signer. */
  coordinator?: SignerCoordinator;
  /** Atomic invoice-route reservations across workers/restarts. */
  invoiceStore?: InvoiceStore;
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
  /** Exact one-off remittances funded by this wallet or a delegated policy. */
  remittances: Remittances;
  /** Independently verify recipient amounts and invoice terms against the chain. */
  receipts: Receipts;
  /** Authenticated exact invoices and receipt-bound settlement. */
  invoices: Invoices;
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
  const pub = (opts.publicClient ?? createPublicClient({ chain: celo, transport: http(rpc) })) as PublicClient;
  if (opts.publicClient?.chain && opts.publicClient.chain.id !== celo.id) {
    throw new RemessoError("wrong_chain", "publicClient must be configured for Celo mainnet");
  }
  const account = opts.walletClient?.account ?? opts.account ?? null;
  const wallet = opts.walletClient ?? (account ? createWalletClient({ account, chain: celo, transport: http(rpc) }) : null);
  const base = (opts.functionsUrl ?? deployment.functions.base).replace(/\/+$/, "");
  const appOrigin = opts.appOrigin ?? deployment.app.origin;
  const remittanceStore = opts.remittanceStore ?? memoryRemittanceStore();

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
    remittanceStore,
    coordinator: opts.coordinator,
    fetchText: opts.fetchText,
  });

  const policies = makePolicies(ctx);
  const pay = makePay(ctx, policies);
  const requests = makeRequests(ctx, { pay, policies });
  const schedules = makeSchedules(ctx, { getRequest: requests.get, answer: requests.answer });
  const walletRemittances = makeWalletRemittances(ctx, { store: remittanceStore, getRequest: requests.get, answer: requests.answer });
  const sender = makeRemittances(ctx, { pay, policies, requests, wallet: walletRemittances });
  const receipts = makeReceipts(ctx);
  const quotes = makeQuotes(ctx, { policies, requests });
  const lifecycle = makeLifecycle(ctx, { store: remittanceStore, wallet: walletRemittances, receipts, pay });
  const remittances: Remittances = {
    ...sender, ...quotes, ...lifecycle,
    async prepare(input, options) {
      if (typeof input?.idempotencyKey !== "string" || !input.idempotencyKey.trim()) throw new RemessoError("invalid", "prepare requires a nonempty idempotencyKey");
      if (input.validUntil !== undefined && !Number.isSafeInteger(input.validUntil)) throw new RemessoError("invalid", "validUntil must be an integer Unix timestamp in seconds");
      const quote = await quotes.quote(input, options);
      if (!quote.canSend) throw new RemessoError("refused", "this payment is not ready; review the quote issues", { quote });
      const maximum = input.maxDebit ?? formatUnits(quote.grossDebit, quote.decimals);
      if (toUnits(maximum, token(quote.token)) < quote.grossDebit) throw new RemessoError("refused", "the quote exceeds maxDebit", { quote });
      const validUntil = Math.min(input.validUntil ?? Number.MAX_SAFE_INTEGER, Math.floor(quote.expiresAt.getTime() / 1000));
      if (validUntil <= Math.floor(Date.now() / 1000)) throw new RemessoError("refused", "the payment intent has expired");
      const bounded = { token: quote.token, maxDebit: maximum, validUntil };
      if (input.funding === "policy") return { quote, input: { ...input, ...bounded, policyId: quote.selectedPolicyId ?? input.policyId } };
      return { quote, input: { ...input, ...bounded } };
    },
  };
  const invoices = makeInvoices(ctx, { requests, remittances, receipts, store: opts.invoiceStore });

  return {
    address: account?.address ?? null,
    publicClient: pub,
    deployment,
    schedules,
    pay,
    policies,
    remittances,
    receipts,
    invoices,
    requests,
    events: makeEvents(ctx),
    webhooks: makeWebhooks(ctx),
    agents: makeAgents(ctx, { send: remittances.send, getRequest: requests.get }),
    payLink(p) {
      const to = p.to ?? account?.address;
      if (!to) throw new Error("payLink needs to without an account");
      return payLink({ ...p, to }, appOrigin);
    },
  };
}
