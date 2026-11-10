/**
 * Spike E: a Pi extension that offers one bit MCP endpoint's tools as native Pi tools.
 *
 * Loaded by `piMcpIsolationProof.ts` with `pi -e <this file>`; Pi compiles it with jiti, so
 * it imports nothing — not from Pi (whose package names have moved before) and not from
 * bit (whose server modules must never load inside an agent process).
 *
 * **Why not Pi's built-in MCP.** bit's endpoints serve MCP revision 2026-07-28 only: no
 * `initialize`, every request carries its own metadata (`mcp/server.ts`). Pi's MCP client
 * speaks 2025-11-25 down to 2024-11-05 and always opens with `initialize`
 * (`@earendil-works/pi-mcp`, `protocol/types.ts`), so `pi.registerMcpServer` cannot reach
 * bit. This extension speaks the stateless revision itself: one `tools/list` at load, one
 * `tools/call` per call, each a single POST.
 *
 * **Where the credential lives.** The bearer arrives in `BIT_MCP_TOKEN` and is deleted from
 * `process.env` before any tool runs, so the shells Pi starts for the model (`bash`) do not
 * inherit it. It stays in this module's closure only. One Pi process is one bit session,
 * so the credential and the tools it reaches belong to that process alone.
 */

interface McpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
}

interface ToolContent {
  readonly type: string;
  readonly text?: string;
}

interface CallResult {
  readonly content?: readonly ToolContent[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

/** The part of Pi's extension API this uses (`docs/extensions.md`, `pi.registerTool`). */
interface PiExtensionApi {
  registerTool(definition: {
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
    ) => Promise<{ content: readonly ToolContent[]; details: unknown }>;
  }): void;
}

const PROTOCOL = "2026-07-28";

const parseBody = (text: string): unknown => {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  // An event-stream answer: the last `data:` line carrying a JSON-RPC response.
  let found: unknown;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload.startsWith("{")) found = JSON.parse(payload);
  }
  if (found === undefined)
    throw new Error("bit MCP: no JSON-RPC response in the answer");
  return found;
};

const rpc = async (
  url: string,
  token: string,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  const name = typeof params.name === "string" ? params.name : undefined;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "mcp-method": method,
      "mcp-protocol-version": PROTOCOL,
      ...(name === undefined ? {} : { "mcp-name": name }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": PROTOCOL,
          "io.modelcontextprotocol/clientInfo": {
            name: "bit-pi-extension",
            version: "0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
    ...(signal === undefined ? {} : { signal }),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(
      `bit MCP ${method}: HTTP ${String(response.status)} ${text.slice(0, 200)}`,
    );
  const body = parseBody(text) as {
    result?: Record<string, unknown>;
    error?: { message?: string };
  };
  if (body.error !== undefined)
    throw new Error(`bit MCP ${method}: ${body.error.message ?? "error"}`);
  return body.result ?? {};
};

export default async function bitTools(pi: PiExtensionApi): Promise<void> {
  const url = process.env.BIT_MCP_URL;
  const token = process.env.BIT_MCP_TOKEN;
  const prefix = process.env.BIT_MCP_PREFIX ?? "bit";
  delete process.env.BIT_MCP_TOKEN;
  if (url === undefined || token === undefined) return;

  const listed = await rpc(url, token, "tools/list", {});
  const tools = (listed.tools ?? []) as readonly McpTool[];
  for (const tool of tools) {
    pi.registerTool({
      name: `${prefix}_${tool.name}`,
      label: tool.name,
      description: tool.description ?? tool.name,
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
      execute: async (_toolCallId, params, signal) => {
        const result = (await rpc(
          url,
          token,
          "tools/call",
          { name: tool.name, arguments: params ?? {} },
          signal,
        )) as CallResult;
        const content = result.content ?? [
          {
            type: "text",
            text: JSON.stringify(result.structuredContent ?? {}),
          },
        ];
        if (result.isError === true) {
          throw new Error(content.map((part) => part.text ?? "").join("\n"));
        }
        return { content, details: result.structuredContent ?? {} };
      },
    });
  }
}
