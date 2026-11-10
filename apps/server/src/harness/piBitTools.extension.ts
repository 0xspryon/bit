/**
 * The Pi extension that offers one bit MCP endpoint's tools to one Pi session as native Pi
 * tools (`bit_<tool>`). Loaded by `piClient.ts` with `pi -e <this file>`, once per Pi process,
 * and each bit session is one Pi process.
 *
 * Promoted from `spike/piBitTools.extension.ts` (spike E, 2026-11-10), with one change: the
 * credential travels on a pipe, not in the environment.
 *
 * **Pi compiles this with jiti and it imports nothing of Pi's or bit's** — not from Pi,
 * whose package names have moved before, and not from bit, whose server modules must never
 * load inside an agent process. Only Node built-ins.
 *
 * **Why not Pi's built-in MCP.** bit's endpoints serve MCP revision 2026-07-28 only: no
 * `initialize`, every request carries its own metadata (`mcp/server.ts`). Pi's MCP client
 * speaks 2025-11-25 down to 2024-11-05 and always opens with `initialize`, which bit answers
 * 400. This speaks the stateless revision itself: one `tools/list` at load, one `tools/call`
 * per call, each a single POST.
 *
 * ## Where the credential lives
 *
 * bit writes the bearer to the Pi process's **file descriptor 3**, a pipe it closes at once,
 * and names the descriptor in `BIT_MCP_TOKEN_FD`. This reads it to the end, closes the
 * descriptor, and keeps the token in this module's closure only.
 *
 * Not an environment variable, which is what the spike used. Deleting it from
 * `process.env` kept it out of the shells Pi starts, but **not out of
 * `/proc/<pi pid>/environ`**, which is the environment the process was started with and
 * which any process of the same user can read — another bit session's agent included. A
 * pipe leaves nothing to read once it is drained: not in `/proc`, not on disk.
 *
 * `BIT_MCP_URL` names the endpoint and is not a secret. Without both, no tools are offered.
 */
import { closeSync, readFileSync } from "node:fs";

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

/** The name prefix of every tool this offers: `bit_<tool>`. */
const PREFIX = "bit";

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
            version: "1",
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

/** Drains the credential's descriptor and closes it; `undefined` when none was given. */
const readToken = (): string | undefined => {
  const named = process.env.BIT_MCP_TOKEN_FD;
  delete process.env.BIT_MCP_TOKEN_FD;
  if (named === undefined || !/^\d+$/.test(named)) return undefined;
  const fd = Number(named);
  try {
    const token = readFileSync(fd, "utf8").trim();
    return token === "" ? undefined : token;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Already closed.
    }
  }
};

export default async function bitTools(pi: PiExtensionApi): Promise<void> {
  const token = readToken();
  const url = process.env.BIT_MCP_URL;
  delete process.env.BIT_MCP_URL;
  if (url === undefined || token === undefined) return;

  const listed = await rpc(url, token, "tools/list", {});
  const tools = (listed.tools ?? []) as readonly McpTool[];
  for (const tool of tools) {
    pi.registerTool({
      name: `${PREFIX}_${tool.name}`,
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
