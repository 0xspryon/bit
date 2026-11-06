/**
 * Which tools a Claude Code session runs with bit's policy gate removed (2026-11-06), under
 * the operator's real settings, for each permission setup bit could pick.
 *
 * ```sh
 * cd apps/server
 * bun run src/spike/permissionProbe.ts --leg=dontask
 * ```
 *
 * Legs (`--leg=`):
 *
 * - `dontask`: `permissionMode: "dontAsk"`, as bit ran with the gate, and nothing else.
 * - `dontask-mcp`: the same plus `allowedTools: ["mcp__bit-probe"]`, bit's MCP server
 *   pre-approved and nothing else (`--allow=a,b` to say which), and `--deny=<rule>` for a
 *   deny rule of the operator's in the folder's `.claude/settings.json`.
 * - `default`: `permissionMode: "default"`, so every prompt reaches `canUseTool`.
 *
 * Each leg registers `canUseTool` as the importer does (A7-Q), refusing and logging every
 * prompt, and the plan-mode tools are disallowed as there. It uses the operator's own
 * settings (`settingSources: user, project, local`) in a scratch folder with none of its
 * own, an in-process MCP server named `bit-probe` with one `ping` tool, and asks the model
 * for one call each of Read, Glob, Bash, WebFetch, Write and `ping`. It prints each call's
 * outcome. `--fetch=agent` asks for the page through the `web-fetch` sub-agent instead, which is
 * how Claude Code 2.1.310 offers WebFetch here ("not available directly in this context").
 *
 * **Nothing may import this module.** `main` runs at module scope.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  query as sdkQuery,
  type CanUseTool,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

const leg =
  process.argv.find((arg) => arg.startsWith("--leg="))?.slice(6) ?? "dontask";
const model =
  process.argv.find((arg) => arg.startsWith("--model="))?.slice(8) ??
  "claude-haiku-4-5";

const root = mkdtempSync(join(tmpdir(), "bit-permission-probe-"));
writeFileSync(join(root, "notes.txt"), "PROBE-NOTES-CONTENT\n");
// `--deny=<rule>`: a project settings deny rule, as an operator would write one.
const deny = process.argv.find((arg) => arg.startsWith("--deny="))?.slice(7);
if (deny !== undefined) {
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(
    join(root, ".claude", "settings.json"),
    JSON.stringify({ permissions: { deny: [deny] } }),
  );
}
// `--allow=<a,b>`: what bit pre-approves, for the `dontask-mcp` leg.
const allow = (
  process.argv.find((arg) => arg.startsWith("--allow="))?.slice(8) ??
  "mcp__bit-probe"
).split(",");

const prompts: string[] = [];
const canUseTool: CanUseTool = (toolName) => {
  prompts.push(toolName);
  return Promise.resolve({
    behavior: "deny",
    message: "probe: no operator at a prompt",
  });
};

/** A stdio MCP server with one `ping` tool, written to the scratch folder. */
const serverScript = join(root, "mcp.ts");
writeFileSync(
  serverScript,
  `const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let at;
  while ((at = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
    if (line.trim() === "") continue;
    const m = JSON.parse(line);
    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "bit-probe", version: "1.0.0" } } });
    else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "ping", description: "Answers PONG-FROM-BIT.", inputSchema: { type: "object", properties: { note: { type: "string" } } } }] } });
    else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "PONG-FROM-BIT" }] } });
    else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
  }
}
`,
);

const text = `This is a harmless permission probe in a scratch folder. Make exactly these six tool calls, one each, in this order, and do not retry any that fails:
1) Read the file ${join(root, "notes.txt")}
2) Glob for "*.txt" in ${root}
3) Bash: echo PROBE-BASH
4) ${
  process.argv.includes("--fetch=agent")
    ? `the Agent tool with subagent_type "web-fetch", asking it to fetch https://example.com and report the page title`
    : `WebFetch https://example.com with the prompt "title?"`
}
5) Write the file ${join(root, "out.txt")} with the content PROBE-WRITE
6) the ping tool of the bit-probe MCP server, with note "probe"
Then reply DONE.`;

const calls = new Map<string, string>();
const outcomes: { tool: string; error: boolean; result: string }[] = [];

const run = sdkQuery({
  prompt: text,
  options: {
    cwd: root,
    model,
    settingSources: ["user", "project", "local"],
    permissionMode: leg === "default" ? "default" : "dontAsk",
    ...(leg === "dontask-mcp" ? { allowedTools: allow } : {}),
    canUseTool,
    disallowedTools: ["EnterPlanMode", "ExitPlanMode"],
    mcpServers: {
      "bit-probe": {
        type: "stdio",
        command: process.execPath,
        args: [serverScript],
      },
    },
    persistSession: false,
  },
});

for await (const message of run as AsyncIterable<SDKMessage>) {
  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "tool_use") calls.set(block.id, block.name);
    }
  }
  if (message.type === "user" && Array.isArray(message.message.content)) {
    for (const block of message.message.content) {
      if (typeof block === "object" && block.type === "tool_result") {
        const content =
          typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content);
        outcomes.push({
          tool: calls.get(block.tool_use_id) ?? block.tool_use_id,
          error: block.is_error === true,
          result: content.slice(0, 160),
        });
      }
    }
  }
  if (message.type === "result") {
    console.log(
      JSON.stringify(
        {
          leg,
          model,
          root,
          prompts,
          denials: message.permission_denials.map((denial) => denial.tool_name),
          outcomes,
        },
        null,
        2,
      ),
    );
  }
}
