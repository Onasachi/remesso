// A minimal MCP server over stdio, and the little schema builder its tools use.
//
// Why not @modelcontextprotocol/sdk and zod: together with ajv and uri-js they
// were half of the bundled server, and the Claude plugin directory's security
// scan cannot read a bundle that large. The wallet needs three methods of the
// protocol — initialize, tools/list, tools/call — over newline-delimited
// JSON-RPC on stdin/stdout, which is all this file implements.

import { createInterface } from "node:readline";

const LATEST_PROTOCOL = "2025-06-18";

// ---- schemas: just enough of zod's surface for the tool arguments here ----

function field(json, check) {
  const f = {
    json,
    check,
    required: true,
    fallback: undefined,
    describe(d) { return field({ ...json, description: d }, check).with(this); },
    optional() { const g = field(json, check).with(this); g.required = false; return g; },
    default(v) { const g = field({ ...json, default: v }, check).with(this); g.required = false; g.fallback = v; return g; },
    with(prev) { this.required = prev.required; this.fallback = prev.fallback; return this; },
  };
  return f;
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

export const z = {
  string() {
    const base = field({ type: "string" }, (v) => (typeof v === "string" ? null : "must be a string"));
    base.url = () => field({ type: "string", format: "uri" }, (v) => {
      if (typeof v !== "string") return "must be a string";
      try { const u = new URL(v); return /^https?:$/.test(u.protocol) ? null : "must be an http(s) URL"; } catch { return "must be a URL"; }
    });
    base.max = (n) => field({ type: "string", maxLength: n }, (v) => (typeof v !== "string" ? "must be a string" : v.length > n ? `at most ${n} characters` : null));
    return base;
  },
  number() {
    const base = field({ type: "number" }, (v) => (isNum(v) ? null : "must be a number"));
    base.int = () => {
      const i = field({ type: "integer" }, (v) => (Number.isInteger(v) ? null : "must be an integer"));
      i.positive = () => field({ type: "integer", minimum: 1 }, (v) => (Number.isInteger(v) && v > 0 ? null : "must be a positive integer"));
      i.nonnegative = () => field({ type: "integer", minimum: 0 }, (v) => (Number.isInteger(v) && v >= 0 ? null : "must be a non-negative integer"));
      return i;
    };
    return base;
  },
  enum(values) {
    return field({ type: "string", enum: values }, (v) => (values.includes(v) ? null : `must be one of ${values.join(", ")}`));
  },
};

function toJsonSchema(shape) {
  const properties = {};
  const required = [];
  for (const [k, f] of Object.entries(shape)) {
    properties[k] = f.json;
    if (f.required) required.push(k);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

function parseArgs(shape, args) {
  const out = {};
  const input = args && typeof args === "object" ? args : {};
  for (const [k, f] of Object.entries(shape)) {
    const v = input[k];
    if (v === undefined || v === null) {
      if (f.fallback !== undefined) out[k] = f.fallback;
      else if (f.required) throw new Error(`${k} is required`);
      continue;
    }
    const problem = f.check(v);
    if (problem) throw new Error(`${k} ${problem}`);
    out[k] = v;
  }
  return out;
}

// ---- the server ----

export class McpServer {
  constructor(info) {
    this.info = info;
    this.tools = new Map();
  }

  tool(name, description, shape, handler) {
    this.tools.set(name, { description, shape, handler });
  }

  async handle(msg) {
    const { id, method, params } = msg;
    switch (method) {
      case "initialize":
        this.client = params?.clientInfo;
        return {
          protocolVersion: params?.protocolVersion || LATEST_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: this.info,
        };
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: [...this.tools].map(([name, t]) => ({ name, description: t.description, inputSchema: toJsonSchema(t.shape) })),
        };
      case "tools/call": {
        const t = this.tools.get(params?.name);
        if (!t) throw Object.assign(new Error(`unknown tool: ${params?.name}`), { code: -32602 });
        let args;
        try {
          args = parseArgs(t.shape, params?.arguments);
        } catch (e) {
          return { isError: true, content: [{ type: "text", text: `Invalid arguments: ${e.message}` }] };
        }
        try {
          return await t.handler(args);
        } catch (e) {
          return { isError: true, content: [{ type: "text", text: String(e?.message || e) }] };
        }
      }
      default:
        if (id === undefined) return undefined; // a notification: nothing to answer
        throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
    }
  }

  // Newline-delimited JSON-RPC on stdin/stdout. stdout carries protocol only;
  // anything for a human goes to stderr.
  async connect() {
    const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
        continue;
      }
      // Answer each request when it is ready, without holding up the next one.
      this.handle(msg).then(
        (result) => { if (msg.id !== undefined && result !== undefined) send({ jsonrpc: "2.0", id: msg.id, result }); },
        (e) => { if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: e.code ?? -32603, message: String(e?.message || e) } }); },
      );
    }
  }
}
