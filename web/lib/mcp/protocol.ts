/// A stateless MCP server over Streamable HTTP, small enough to read in one go.
///
/// Why not @modelcontextprotocol/sdk: the connector needs four methods —
/// initialize, ping, tools/list, tools/call — answered as plain JSON to a POST,
/// with no session and no server-sent stream. That is the whole of what Claude's
/// hosted apps (web, desktop, iOS, Android) send a connector, and it is the same
/// shape `mcp/src/mcp.mjs` already serves over stdio for the local wallet.

export type JsonSchema = Record<string, unknown>;

export type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  /// Hints for the client: `readOnlyHint` lets Claude call a reading tool
  /// without asking each time, and `destructiveHint` makes it always ask —
  /// set on the hosted agent's payment, which cannot be taken back.
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
  run: (args: Record<string, unknown>) => Promise<ToolResult>;
};

/// An icon as MCP 2025-11-25 describes one. Claude's apps do not show it yet:
/// claude.ai draws a custom connector with Google's favicon for the URL's last
/// two labels — crackedstudios.xyz here, so the studio's green mark — whatever
/// the server sends (anthropics/claude-ai-mcp#152). Other clients read this.
export type Icon = { src: string; mimeType: string; sizes: string[] };

export type ServerInfo = { name: string; title: string; version: string; instructions: string; icons?: Icon[] };

/// Newest first. A client asking for one of these gets it back; anything else
/// gets the newest, which is what the spec tells a server to do.
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

export const text = (s: string, structured?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: s }],
  ...(structured ? { structuredContent: structured } : {}),
});
export const refuse = (s: string): ToolResult => ({ content: [{ type: "text", text: s }], isError: true });

/// One JSON-RPC message in, its response out, or `undefined` for a notification.
export async function handleRpc(msg: Rpc, tools: Tool[], info: ServerInfo): Promise<object | undefined> {
  const { id, method, params } = msg;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const error = (code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

  if (msg.jsonrpc !== "2.0" || typeof method !== "string") return error(-32600, "invalid request");
  // A notification (no id) is acknowledged by the transport, never answered.
  if (id === undefined) return undefined;

  switch (method) {
    case "initialize": {
      const asked = String(params?.protocolVersion ?? "");
      return reply({
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: info.name, title: info.title, version: info.version, icons: info.icons },
        instructions: info.instructions,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: tools.map(({ run: _run, ...t }) => t),
      });
    case "tools/call": {
      const tool = tools.find((t) => t.name === params?.name);
      if (!tool) return error(-32602, `unknown tool: ${String(params?.name)}`);
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      try {
        return reply(await tool.run(args));
      } catch (e) {
        // A tool failing is a result the model can read and explain, not a
        // protocol error that ends the conversation.
        return reply(refuse(e instanceof Error ? e.message : String(e)));
      }
    }
    default:
      return error(-32601, `method not found: ${method}`);
  }
}
