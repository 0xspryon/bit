/**
 * How Claude Code escapes the text of a stored `<task-notification>` (A7-S review 4: a
 * stopped task's note showed "sleep 40 &amp;&amp; echo").
 *
 * ```sh
 * cd apps/server
 * bun run src/spike/taskNotificationProbe.ts
 * ```
 *
 * One `claude-haiku-4-5` session in a scratch folder: a background Bash whose description
 * and command hold `&&`, `<` and quotes, and a background agent whose final words hold the
 * same. The query's input stays open until both notifications have arrived (or 120 s), then
 * every `<task-notification>` the SDK forwarded and the transcript stored is printed raw.
 * Bash is pre-approved for this session only (`allowedTools`), as the probe needs it to run.
 *
 * **Nothing may import this module.** `main` runs at module scope.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getSessionMessages,
  query as sdkQuery,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

const root = mkdtempSync(join(tmpdir(), "bit-task-notification-probe-"));
const sessionId = crypto.randomUUID();

const text = `This is a harmless probe of how background task notifications are written. Make exactly these two tool calls in one go, then reply OK:
1) Bash with run_in_background: true, description: 'Wait a<b && say "hi"', command: sleep 3 && echo "a<b && 'q'"
2) Agent with run_in_background: true, subagent_type "general-purpose", description "Echo x&y", prompt: "Reply with exactly this line and nothing else: R1 && R2 <tag> \\"quoted\\" 'single' a&amp;b"`;

let release: () => void = () => undefined;
const held = new Promise<void>((resolve) => {
  release = resolve;
});
async function* input(): AsyncGenerator<SDKUserMessage> {
  yield {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    session_id: sessionId,
  };
  await held;
}

const forwarded: string[] = [];
const deadline = setTimeout(() => release(), 120_000);
const run = sdkQuery({
  prompt: input(),
  options: {
    cwd: root,
    model: "claude-haiku-4-5",
    sessionId,
    settingSources: ["user", "project", "local"],
    permissionMode: "dontAsk",
    allowedTools: ["Bash", "Agent"],
    persistSession: true,
  },
});

let notified = 0;
for await (const message of run as AsyncIterable<SDKMessage>) {
  const raw = JSON.stringify(message);
  if (raw.includes("task-notification") || message.type === "system") {
    if (raw.includes("task-notification")) forwarded.push(raw.slice(0, 1500));
  }
  if (
    message.type === "system" &&
    (message as { subtype?: string }).subtype === "task_notification"
  ) {
    notified += 1;
    console.log("task_notification frame:", raw.slice(0, 800));
    if (notified >= 2) setTimeout(() => release(), 15_000);
  }
  if (message.type === "result" && notified >= 2) break;
}
clearTimeout(deadline);

console.log("\n== forwarded frames naming task-notification ==");
for (const each of forwarded) console.log(each, "\n");
console.log("\n== stored transcript entries holding <task-notification> ==");
const stored = await getSessionMessages(sessionId, { dir: root });
for (const entry of stored) {
  const raw = JSON.stringify(entry);
  if (raw.includes("<task-notification>"))
    console.log(raw.slice(0, 2500), "\n");
}
process.exit(0);
