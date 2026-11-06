/**
 * Step 0 of A7-Q — how does Claude Code's `AskUserQuestion` reach a host that runs
 * `permissionMode: "dontAsk"` behind a `PreToolUse` gate that answers `allow`?
 *
 * ```sh
 * cd apps/server
 * bun run src/spike/askUserQuestionProbe.ts --leg=hook-allow-canusetool
 * ```
 *
 * Legs (`--leg=`):
 *
 * - `hook-allow-canusetool`: what bit runs today (`dontAsk`, a command hook that prints the
 *   gate's own `allow`), plus a `canUseTool` that answers the first question.
 * - `hook-allow-only`: the same without `canUseTool` (bit before A7-Q).
 * - `no-hook-canusetool`: `dontAsk` and `canUseTool`, no hook.
 * - `interrupt`: as the first leg, but `interrupt()` while `canUseTool` waits.
 * - `deny`: as the first leg, but `canUseTool` answers `deny` (the dock's dismiss).
 *
 * The hook is a stand-in for `plugins/claudeCodeGate.ts`: it prints the same
 * `hookSpecificOutput` the gate prints for an `allow`, and logs the tool name it saw.
 *
 * **Nothing may import this module.** `main` runs at module scope.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  query as sdkQuery,
  type CanUseTool,
  type HookCallbackMatcher,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

const leg =
  process.argv.find((arg) => arg.startsWith("--leg="))?.slice(6) ??
  "hook-allow-canusetool";
const model =
  process.argv.find((arg) => arg.startsWith("--model="))?.slice(8) ??
  "claude-haiku-4-5";

const root = mkdtempSync(join(tmpdir(), "bit-auq-probe-"));
const hookLog = join(root, "hook.log");
const withHook = leg !== "no-hook-canusetool";
if (withHook) {
  mkdirSync(join(root, ".claude"), { recursive: true });
  const hook = join(root, ".claude", "hook.ts");
  writeFileSync(
    hook,
    [
      `const raw = await Bun.stdin.text();`,
      `const event = JSON.parse(raw);`,
      `await Bun.write(${JSON.stringify(hookLog)}, ((await Bun.file(${JSON.stringify(hookLog)}).text().catch(() => "")) + JSON.stringify({ at: Date.now(), tool: event.tool_name, permission_mode: event.permission_mode }) + "\\n"));`,
      ...(process.argv.includes("--gate=deny")
        ? [
            `process.stderr.write("Denied by bit policy: probe deny"); process.exit(2);`,
          ]
        : []),
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
}

const started = Date.now();
const at = () => `+${String(Date.now() - started).padStart(6)}ms`;
const log = (...parts: unknown[]) => console.log(at(), ...parts);

const PROMPT =
  "I am testing my app's question UI. Use your AskUserQuestion tool exactly once to ask me two questions: " +
  "(1) header 'Colour', 'Which colour do you prefer?' with options Red and Blue; " +
  "(2) header 'Size', 'Which sizes do you want?' multiSelect with options Small, Medium, Large. " +
  "After I answer, reply with one sentence that repeats my answers verbatim, or says I declined.";

let interruptHere: (() => void) | null = null;

const canUseTool: CanUseTool = async (toolName, input, options) => {
  log("canUseTool", toolName, JSON.stringify(input).slice(0, 400), {
    toolUseID: options.toolUseID,
    decisionReason: options.decisionReason,
  });
  if (toolName !== "AskUserQuestion") {
    return { behavior: "allow", updatedInput: input };
  }
  if (leg === "interrupt") {
    return await new Promise((resolve) => {
      options.signal.addEventListener("abort", () => {
        log("canUseTool signal aborted", String(options.signal.reason));
        resolve({ behavior: "deny", message: "aborted" });
      });
      interruptHere?.();
    });
  }
  if (leg === "deny") {
    return {
      behavior: "deny",
      message: "The operator dismissed these questions without answering.",
    };
  }
  const questions = (input as { questions: { question: string }[] }).questions;
  const answers: Record<string, string> = {};
  if (questions[0] !== undefined) answers[questions[0].question] = "Blue";
  if (questions[1] !== undefined)
    answers[questions[1].question] = "Small, Large";
  return { behavior: "allow", updatedInput: { ...input, answers } };
};

/** A second, in-process `PreToolUse` hook that only matches `AskUserQuestion`. */
const answerHook: HookCallbackMatcher = {
  matcher: "AskUserQuestion",
  timeout: Number(
    process.argv.find((arg) => arg.startsWith("--hook-timeout="))?.slice(15) ??
      86_400,
  ),
  hooks: [
    async (hookInput, toolUseID, options) => {
      const input = (hookInput as { tool_input: Record<string, unknown> })
        .tool_input;
      log("sdk hook", hookInput.hook_event_name, toolUseID, {
        permission_mode: (hookInput as { permission_mode?: string })
          .permission_mode,
      });
      const wait = Number(
        process.argv.find((arg) => arg.startsWith("--wait="))?.slice(7) ?? 0,
      );
      if (leg === "sdk-hook-interrupt") {
        return await new Promise((resolve) => {
          options.signal.addEventListener("abort", () => {
            log("sdk hook signal aborted", String(options.signal.reason));
            resolve({});
          });
          interruptHere?.();
        });
      }
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (leg === "sdk-hook-deny") {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason:
              "The operator dismissed these questions without answering.",
          },
        };
      }
      const questions = (input as { questions: { question: string }[] })
        .questions;
      const answers: Record<string, string> = {};
      if (questions[0] !== undefined) answers[questions[0].question] = "Blue";
      if (questions[1] !== undefined)
        answers[questions[1].question] = "Small, Large";
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: "answered by the operator in bit",
          updatedInput: { ...input, answers },
        },
      };
    },
  ],
};

const main = async () => {
  log("leg", leg, "model", model, "root", root);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      message: { role: "user", content: PROMPT },
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
      persistSession: false,
      ...(leg === "hook-allow-only" || leg === "sdk-hook-only"
        ? {}
        : { canUseTool }),
      ...(leg.startsWith("sdk-hook")
        ? { hooks: { PreToolUse: [answerHook] } }
        : {}),
    },
  });
  if (leg === "interrupt" || leg === "sdk-hook-interrupt") {
    interruptHere = () => {
      setTimeout(() => {
        log("interrupt()");
        void q.interrupt().then(
          () => log("interrupt resolved"),
          (e) => log("interrupt failed", String(e)),
        );
      }, 1500);
    };
  }
  for await (const message of q as AsyncIterable<SDKMessage>) {
    const m = message as Record<string, unknown> & { type: string };
    if (m.type === "assistant" || m.type === "user") {
      const content = (m as unknown as { message: { content: unknown } })
        .message.content;
      log(m.type, JSON.stringify(content).slice(0, 700));
    } else if (m.type === "result") {
      log(
        "result",
        m.subtype,
        JSON.stringify({
          result: m.result,
          permission_denials: m.permission_denials,
          terminal_reason: m.terminal_reason,
        }).slice(0, 800),
      );
      break;
    } else if (m.type === "system") {
      log("system", m.subtype, m.permissionMode ?? "");
    } else {
      log(m.type, JSON.stringify(m).slice(0, 300));
    }
  }
  release();
  q.close();
  if (withHook) {
    log(
      "hook saw",
      readFileSync(hookLog, "utf8").trim().split("\n").join(" | "),
    );
  }
  log("done; trash", root);
};

await main();
