/**
 * Step 0 of A7-S — what does Claude Code expose for a sub-agent (`Agent` tool), live and on
 * replay, and what do `stopTask` and `interrupt()` do to one?
 *
 * ```sh
 * cd apps/server
 * bun run src/spike/subagentProbe.ts --leg=fg
 * ```
 *
 * Legs (`--leg=`):
 *
 * - `fg`: one foreground sub-agent that runs three tool calls and hands back.
 * - `bg`: one background sub-agent (`run_in_background: true`) that sleeps, then hands back.
 * - `bg-stop`: as `bg`, and `stopTask(<its task id>)` 4 s after its `task_started`.
 * - `bg-interrupt`: as `bg`, and `interrupt()` 4 s after its `task_started`.
 * - `fg-stop`: a foreground sub-agent that sleeps, and `stopTask` on its task 4 s in.
 * - `fail`: a foreground sub-agent told to read a file that does not exist.
 * - `fail-type`: an `Agent` call naming a `subagent_type` that does not exist.
 *
 * `--summaries` turns on `agentProgressSummaries`. Every leg ends by reading the transcript
 * back (`getSessionMessages`, `listSubagents`, `getSubagentMessages`) and prints the
 * project folder to trash.
 *
 * The hook is a stand-in for `plugins/claudeCodeGate.ts` that answers `allow`, as in
 * `askUserQuestionProbe.ts`.
 *
 * **Nothing may import this module.** `main` runs at module scope.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  getSessionMessages,
  getSubagentMessages,
  listSubagents,
  query as sdkQuery,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

const leg =
  process.argv.find((arg) => arg.startsWith("--leg="))?.slice(6) ?? "fg";
const model =
  process.argv.find((arg) => arg.startsWith("--model="))?.slice(8) ??
  "claude-haiku-4-5";
const summaries = process.argv.includes("--summaries");

const root = mkdtempSync("/run/media/hbt/work/bit-subagent-probe-");
writeFileSync(join(root, "notes.txt"), "alpha line\nbeta line\ngamma line\n");
mkdirSync(join(root, ".claude"), { recursive: true });
const hook = join(root, ".claude", "hook.ts");
writeFileSync(
  hook,
  [
    `await Bun.stdin.text();`,
    `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "allowed by bit policy (probe)" } }));`,
    `process.exit(0);`,
  ].join("\n"),
);
writeFileSync(
  join(root, ".claude", "settings.local.json"),
  JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: process.execPath,
              args: [hook],
              onFailure: "block",
            },
          ],
        },
      ],
    },
  }),
);

const started = Date.now();
const at = () => `+${String(Date.now() - started).padStart(6)}ms`;
const log = (...parts: unknown[]) => console.log(at(), ...parts);

const AGENT = (background: boolean, task: string, description: string) =>
  `Call your Agent tool exactly once, with subagent_type "general-purpose", description "${description}", run_in_background ${background}, and this prompt for the sub-agent: "${task}". ` +
  (background
    ? "After launching it, reply with the single word LAUNCHED and end your turn; do not wait for it."
    : "When it hands back, reply with one sentence saying what it reported.");

const PROMPTS: Record<string, string> = {
  fg: AGENT(
    false,
    "Use the Bash tool to run `ls`. Then use the Read tool to read notes.txt. Then use the Bash tool to run `wc -l notes.txt`. Then reply with the second line of notes.txt.",
    "Inspect notes file",
  ),
  bg: AGENT(
    true,
    "Use the Bash tool to run `sleep 12 && echo slept`. Then use the Read tool to read notes.txt. Reply with its first line.",
    "Sleep then read",
  ),
  fail: AGENT(
    false,
    "Use the Read tool to read the file /nonexistent/missing-file.txt and reply with its first line.",
    "Read a missing file",
  ),
  "fg-stop": AGENT(
    false,
    "Use the Bash tool to run `sleep 20 && echo slept`. Then reply DONE.",
    "Sleep in foreground",
  ),
};
PROMPTS["fail-type"] =
  'Call your Agent tool exactly once, with subagent_type "no-such-agent-type", description "Unknown type", and the prompt "Reply OK.". If it fails, reply with the single word FAILED.';
PROMPTS["bg-stop"] = PROMPTS["bg"]!;
PROMPTS["bg-interrupt"] = PROMPTS["bg"]!;

const summary = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .map((block: Record<string, unknown>) => {
          if (block["type"] === "tool_use") {
            return `tool_use(${String(block["name"])} ${JSON.stringify(block["input"]).slice(0, 160)} id=${String(block["id"])})`;
          }
          if (block["type"] === "tool_result") {
            return `tool_result(${String(block["tool_use_id"])} err=${String(block["is_error"])} ${JSON.stringify(block["content"]).slice(0, 220)})`;
          }
          if (block["type"] === "text") {
            return `text(${JSON.stringify(block["text"]).slice(0, 160)})`;
          }
          return String(block["type"]);
        })
        .join(" ")
    : JSON.stringify(content).slice(0, 200);

const main = async () => {
  log("leg", leg, "model", model, "root", root, "summaries", summaries);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      message: { role: "user", content: PROMPTS[leg] ?? PROMPTS["fg"]! },
      parent_tool_use_id: null,
      session_id: "",
    } as SDKUserMessage;
    await gate;
  }
  const q = sdkQuery({
    prompt: prompt(),
    options: {
      cwd: root,
      model,
      permissionMode: "dontAsk",
      settingSources: ["local"],
      forwardSubagentText: true,
      includePartialMessages: true,
      ...(summaries ? { agentProgressSummaries: true } : {}),
    },
  });
  let sessionId = "";
  let results = 0;
  const tasks = new Map<string, string>();
  let acted = false;
  const settleAfter = leg.startsWith("bg") ? 2 : 1;
  let lastActivity = Date.now();
  const idle = setInterval(() => {
    if (Date.now() - lastActivity > 60_000) {
      log("idle 60 s; closing");
      release();
    }
  }, 5000);
  const act = (taskId: string) => {
    if (acted) return;
    acted = true;
    setTimeout(() => {
      if (leg === "bg-stop" || leg === "fg-stop") {
        log("stopTask", taskId);
        void q.stopTask(taskId).then(
          () => log("stopTask resolved"),
          (e) => log("stopTask failed", String(e)),
        );
      } else if (leg === "bg-interrupt") {
        log("interrupt()");
        void q.interrupt().then(
          () => log("interrupt resolved"),
          (e) => log("interrupt failed", String(e)),
        );
      }
    }, 4000);
  };
  const iterate = (async () => {
    for await (const message of q as AsyncIterable<SDKMessage>) {
      lastActivity = Date.now();
      const m = message as Record<string, unknown> & { type: string };
      if (typeof m["session_id"] === "string" && m["session_id"] !== "") {
        sessionId = m["session_id"];
      }
      const parent = m["parent_tool_use_id"];
      const sub = parent != null ? `[sub ${String(parent)}]` : "";
      if (m.type === "stream_event") {
        if (parent != null) log("stream_event", sub);
        continue;
      }
      if (m.type === "assistant" || m.type === "user") {
        const content = (m as unknown as { message: { content: unknown } })
          .message.content;
        const extra =
          m.type === "user" && m["tool_use_result"] !== undefined
            ? ` tool_use_result=${JSON.stringify(m["tool_use_result"]).slice(0, 300)}`
            : "";
        log(m.type, sub, summary(content), extra);
      } else if (m.type === "result") {
        results += 1;
        log("result", m["subtype"], JSON.stringify(m["result"]).slice(0, 200));
        if (results >= settleAfter || leg === "bg-interrupt") {
          setTimeout(() => release(), leg.startsWith("bg") ? 30_000 : 1000);
        }
      } else if (m.type === "system") {
        const subtype = String(m["subtype"]);
        if (subtype === "thinking_tokens" || subtype === "init") {
          if (subtype === "init") log("system init");
          continue;
        }
        const rest = Object.fromEntries(
          Object.entries(m).filter(
            ([key]) => key !== "uuid" && key !== "session_id",
          ),
        );
        log("system", subtype, JSON.stringify(rest).slice(0, 600));
        if (
          subtype === "task_started" &&
          typeof m["task_id"] === "string" &&
          m["task_type"] === "local_agent"
        ) {
          tasks.set(String(m["tool_use_id"]), m["task_id"]);
          act(m["task_id"]);
        }
      } else {
        log(m.type, JSON.stringify(m).slice(0, 300));
      }
    }
  })();
  await gate;
  clearInterval(idle);
  q.close();
  await Promise.race([iterate, new Promise((r) => setTimeout(r, 3000))]);
  log("session", sessionId);
  if (sessionId !== "") {
    const stored = await getSessionMessages(sessionId, { dir: root });
    log("replay entries", stored.length);
    for (const entry of stored) {
      const e = entry as unknown as Record<string, unknown> & {
        message?: { content?: unknown };
      };
      log(
        "  replay",
        e["type"],
        e["parent_tool_use_id"] != null ? "[sub]" : "",
        summary(e.message?.content).slice(0, 400),
      );
    }
    const agents = await listSubagents(sessionId, { dir: root });
    log("listSubagents", JSON.stringify(agents), "tasks", [...tasks]);
    for (const agentId of agents) {
      const own = await getSubagentMessages(sessionId, agentId, { dir: root });
      log("subagent", agentId, "entries", own.length);
      for (const entry of own) {
        const e = entry as unknown as Record<string, unknown> & {
          message?: { content?: unknown };
        };
        log(
          "  sub-replay",
          e["type"],
          String(e["timestamp"] ?? ""),
          summary(e.message?.content).slice(0, 300),
        );
      }
    }
  }
  log("done; trash", root, "and the ~/.claude/projects folder for it");
};

await main();
