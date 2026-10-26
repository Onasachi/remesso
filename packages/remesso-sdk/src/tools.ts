/// Framework-independent tools. Hosts may wrap these definitions for MCP,
/// Vercel AI SDK or their own agent runtime without reimplementing payments.
import { RemessoError } from "./errors.js";
import type { Invoices, SignedInvoice, PayInvoiceOptions } from "./invoices.js";
import type { Lifecycle, LifecycleOptions } from "./lifecycle.js";
import type { Quotes, QuoteRemittanceInput } from "./quotes.js";
import type { Receipts, VerifyPaymentInput } from "./receipts.js";
import type { Remittances, SendRemittanceInput } from "./remittances.js";
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type AgentToolClient = {
  remittances: Pick<Remittances, "send"> & Pick<Quotes, "quote"> & Pick<Lifecycle, "get" | "listPending" | "reconcile">;
  receipts: Pick<Receipts, "verify">;
  invoices: Pick<Invoices, "verify" | "pay">;
};
export type AgentToolResult = { ok: true; data: JsonValue; sideEffects: "none" | "possible" } | {
  ok: false;
  error: { code: string; message: string; retryable: boolean; sideEffects: "none" | "unknown"; details?: JsonValue };
};
export type AgentToolOptions = {
  /** Writes are refused unless this host policy explicitly allows the exact input. Tool text is not authorization. */
  authorizeWrite?(request: { name: string; input: Readonly<Record<string, unknown>> }): boolean | Promise<boolean>;
  /** Explicit opt-in for trusted hosts enforcing their own authorization before dispatch. */
  enableWrites?: boolean;
};
export type AgentToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean };
  execute(input: unknown): Promise<AgentToolResult>;
};
export const AGENT_TOOL_OUTPUT_SCHEMA = {
  type: "object",
  oneOf: [
    { type: "object", properties: { ok: { const: true }, data: {}, sideEffects: { type: "string", enum: ["none", "possible"] } }, required: ["ok", "data", "sideEffects"], additionalProperties: false },
    { type: "object", properties: { ok: { const: false }, error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, retryable: { type: "boolean" }, sideEffects: { type: "string", enum: ["none", "unknown"] }, details: {} }, required: ["code", "message", "retryable", "sideEffects"], additionalProperties: false } }, required: ["ok", "error"], additionalProperties: false },
  ],
} as const;
const text = (maxLength = 256) => ({ type: "string", minLength: 1, maxLength });
const address = { ...text(42), pattern: "^0x[0-9a-fA-F]{40}$" };
const hash = { ...text(66), pattern: "^0x[0-9a-fA-F]{64}$" };
const decimal = { ...text(100), pattern: "^\\d+(\\.\\d+)?$" };
const uint = { ...text(78), pattern: "^[1-9]\\d*$" };
const integer = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const funding = { type: "string", enum: ["wallet", "policy"] };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const invoiceSchema = object({ version: { const: 1 }, domain: object({ name: { const: "Remesso Invoice" }, version: { const: "1" }, chainId: { const: 42220 }, verifyingContract: address }, ["name", "version", "chainId", "verifyingContract"]),
  message: object({ issuer: address, payer: address, recipient: address, token: address, amount: uint, orderId: text(128), nonce: hash, issuedAt: integer, expiresAt: integer,
    requestId: { type: "string", pattern: "^([0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12})?$" } }, ["issuer", "payer", "recipient", "token", "amount", "orderId", "nonce", "issuedAt", "expiresAt", "requestId"]),
  signature: { ...text(16386), pattern: "^0x([0-9a-fA-F]{2})+$" },
}, ["version", "domain", "message", "signature"]);
const terms = { funding, to: address, amount: decimal, token: text(42), payer: address, policyId: uint, requestId: text(36), idempotencyKey: text(128) };
const proof = { txHash: hash, from: address, to: address, token: text(42), amount: decimal, policyId: uint, scheduleId: uint,
  memo: { type: "string", maxLength: 32 }, finality: { type: "string", enum: ["included", "finalized"] } };

function validate(schema: Record<string, unknown>, value: unknown, path = "input"): void {
  const fail = (why: string): never => { throw new RemessoError("invalid", `${path} ${why}`); };
  if ("const" in schema && value !== schema.const) fail(`must equal ${schema.const}`);
  if (schema.enum && !(schema.enum as unknown[]).includes(value)) fail("is not an accepted value");
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("must be an object");
    const v = value as Record<string, unknown>, fields = schema.properties as Record<string, Record<string, unknown>>;
    for (const key of schema.required as string[]) if (!(key in v) || v[key] === undefined) fail(`requires ${key}`);
    for (const key of Object.keys(v)) {
      if (!Object.hasOwn(fields, key)) fail(`contains unknown field ${key}`);
      validate(fields[key], v[key], `${path}.${key}`);
    }
  } else if (schema.type === "string") {
    if (typeof value !== "string") fail("must be a string");
    const s = value as string;
    if (schema.minLength !== undefined && s.length < Number(schema.minLength) || schema.maxLength !== undefined && s.length > Number(schema.maxLength)) fail("has an invalid length");
    if (schema.pattern && !new RegExp(String(schema.pattern)).test(s)) fail("has an invalid format");
  } else if (schema.type === "integer") {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < Number(schema.minimum) || value > Number(schema.maximum)) fail("must be an integer within the allowed bounds");
  }
}
/** BigInts become decimal strings and Dates ISO strings; no wallet/account objects are exposed by tool handlers. */
export function toolJson(value: unknown): JsonValue {
  const secrets = new Set(["account", "walletclient", "publicclient", "transport", "privatekey", "apikey", "secret", "password", "mnemonic", "seed", "authorization", "accesstoken", "refreshtoken", "raw", "serializedtransaction"]);
  return value === undefined ? null : JSON.parse(JSON.stringify(value, (key, item) => {
    if (secrets.has(key.toLowerCase().replace(/[_-]/g, ""))) return undefined;
    if (typeof item === "bigint") return item.toString();
    if (typeof item === "string") return item.replace(/(https?:\/\/)[^/\s@]+@/g, "$1[redacted]@").replace(/([?&](?:api[_-]?key|token|secret|authorization)=)[^&\s]+/gi, "$1[redacted]").replace(/0x[0-9a-f]{200,}/gi, "[redacted bytes]");
    return item;
  }));
}
function toolError(error: unknown, attemptedWrite: boolean): AgentToolResult {
  const known = error instanceof RemessoError;
  const code = known ? error.code : "internal";
  const details: Record<string, unknown> = {};
  if (known && error.details) for (const key of ["hash", "txHash", "nonce", "status", "policyId", "scheduleId"]) if (error.details[key] !== undefined) details[key] = error.details[key];
  return { ok: false, error: { code, message: known ? toolJson(error.message) as string : "SDK operation failed; inspect the host's private logs for details",
    retryable: ["http", "timeout", "no_gas"].includes(code), sideEffects: attemptedWrite ? "unknown" : "none",
    ...(Object.keys(details).length ? { details: toolJson(details) } : {}) } };
}
export function createAgentTools(client: AgentToolClient, options: AgentToolOptions = {}) {
  function define(name: string, description: string, inputSchema: Record<string, unknown>, write: boolean, execute: (input: Record<string, unknown>) => Promise<unknown>): AgentToolDefinition {
    return { name, description, inputSchema, outputSchema: AGENT_TOOL_OUTPUT_SCHEMA, annotations: { readOnlyHint: !write, destructiveHint: write, idempotentHint: true },
      async execute(input) {
        let attemptedWrite = false;
        try {
          validate(inputSchema, input);
          const args = structuredClone(input) as Record<string, unknown>;
          if (write) {
            // Give the authorizer its own copy: mutation cannot redirect what gets executed.
            const authorized = options.authorizeWrite ? await options.authorizeWrite({ name, input: structuredClone(args) }) : options.enableWrites === true;
            if (authorized !== true) throw new RemessoError("refused", "the host has not authorized this payment operation");
            attemptedWrite = true;
          }
          return { ok: true, data: toolJson(await execute(args)), sideEffects: write ? "possible" : "none" };
        } catch (error) { return toolError(error, attemptedWrite); }
      },
    };
  }
  const tools: AgentToolDefinition[] = [
    define("remesso_quote", "Read-only quote and simulation. Amounts in the result are base-unit decimal strings; a quote reserves no funds.", object(terms, ["funding", "to", "amount", "token"]), false,
      async (i) => await client.remittances.quote(i as QuoteRemittanceInput)),
    define("remesso_status", "Read the durable operation for an existing key and verify its current chain state. Does not broadcast.", object({ key: text(128), funding }, ["key"]), false,
      async (i) => await client.remittances.get(i.key as string, { funding: i.funding } as LifecycleOptions)),
    define("remesso_pending", "Read saved unfinished payments for this signer. Does not create or broadcast payments.", object({ funding }), false,
      async (i) => await client.remittances.listPending(i as LifecycleOptions)),
    define("remesso_verify", "Independently verify exact payment terms and canonical on-chain evidence; finalized is recommended for fulfillment.", object(proof, ["txHash", "from", "to", "token", "amount"]), false,
      async (i) => await client.receipts.verify(i as VerifyPaymentInput)),
    define("remesso_invoice_verify", "Verify a signed invoice's recipient identity, terms, domain and expiry. This does not pay it.", object({ invoice: invoiceSchema }, ["invoice"]), false,
      async (i) => await client.invoices.verify(i.invoice as SignedInvoice)),
    define("remesso_send", "Pay exact terms from wallet or policy using one stable idempotency key. Retries MUST keep the same key and terms; requires host authorization.",
      object({ ...terms, maxDebit: decimal, validUntil: integer, waitMs: { type: "integer", minimum: 1, maximum: 120000 } }, ["funding", "to", "amount", "token", "idempotencyKey"]), true,
      async (i) => await client.remittances.send(i as SendRemittanceInput)),
    define("remesso_invoice_pay", "Verify and pay a signed invoice. Its immutable reservation pins the signer and funding route; requires host authorization.",
      object({ invoice: invoiceSchema, funding, policyId: uint, maxDebit: decimal, waitMs: { type: "integer", minimum: 1, maximum: 120000 } }, ["invoice", "funding"]), true,
      async ({ invoice, ...i }) => await client.invoices.pay(invoice as SignedInvoice, i as PayInvoiceOptions)),
    define("remesso_reconcile", "Resume only an existing saved payment key; may rebroadcast signed bytes or continue saved steps. Requires host authorization.",
      object({ key: text(128), funding, waitMs: { type: "integer", minimum: 1, maximum: 120000 } }, ["key"]), true,
      async ({ key, ...i }) => await client.remittances.reconcile(key as string, i as LifecycleOptions & { waitMs?: number })),
  ];
  return { tools, list: () => tools.map(({ execute: _execute, ...definition }) => definition),
    async call(name: string, input: unknown): Promise<AgentToolResult> {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) return toolError(new RemessoError("not_found", "unknown Remesso tool"), false);
      return await tool.execute(input);
    },
  };
}
