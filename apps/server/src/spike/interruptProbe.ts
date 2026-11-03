/**
 * Spike F5 — what does an interrupt do to a session, and to a follow-up already queued in it?
 *
 * ```sh
 * cd apps/server
 * systemd-run --user --scope -q -p MemoryMax=2G -p MemorySwapMax=0 timeout 900 \
 *   bun run src/spike/interruptProbe.ts --driver=opencode \
 *   --model=zai-coding-plan/glm-5.3-flash
 * systemd-run --user --scope -q -p MemoryMax=2G -p MemorySwapMax=0 timeout 900 \
 *   bun run src/spike/interruptProbe.ts --driver=claude-code
 * ```
 *
 * One driver per run: an `opencode serve` child or a Claude Code CLI subprocess sits inside
 * the same scope as this process.
 *
 * A6 F5 makes Stop really interrupt the harness, and keeps the conversation going after it.
 * Two things were unmeasured (the `V2(chat):` queue note in `harness/liveAgentSessions.ts`):
 *
 * 1. **A queued follow-up.** The operator sent a second message while a turn ran — a
 *    `queued` steer, so it waits in the harness — and then pressed Stop. Does the queued
 *    message run on its own after the interrupt, wait for the next message, or vanish?
 * 2. **Promptable afterwards.** Is the same session still usable after an interrupt, or
 *    does the next message need a fresh one?
 *
 * Each leg runs one long turn (six files read one call at a time), sends a `queued`
 * follow-up ("reply QUEUED-ONE") as soon as the first tool result is seen, interrupts a
 * moment later, waits to see whether the follow-up runs on its own, and then sends a third
 * message ("reply AFTER") and waits for its answer. Every user and assistant entry is
 * listed with its time relative to the interrupt.
 *
 * ## Through what
 *
 * - **OpenCode, through bit's own seam** (`openCodeHarness`): its `interruptSession` is the
 *   bare `session.interrupt` call, so the seam is the driver here. Entries are read raw off
 *   `GET /api/session/:id/message` so the queued message's fate is visible.
 * - **Claude Code, through the bare SDK.** bit's `interruptSession` used to close the
 *   query straight after asking, so through the seam "is it promptable afterwards" could
 *   only ever answer no. The probe drives `query()` with the same held-open input iterable
 *   `claudeCodeClient.ts`'s `launch` uses, and the same `priority: "later"` a `queued`
 *   steer is sent with, and calls `Query.interrupt()` itself.
 *
 * ## Honesty rules this file follows
 *
 * - Nothing is simulated. A driver that will not start is reported `UNTESTED`.
 * - Credentials stay out of the output: the OpenCode server's Basic credential is used for
 *   the raw reads and never printed, and the Claude Code CLI uses the operator's own login.
 * - Everything lands under `.runtime/interrupt-probe/`, which is gitignored.
 *
 * **Nothing may import this module.** `runMain` is called at module scope; the rule and
 * what it cost to learn are on `workerDemo.ts`.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  query as sdkQuery,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Deferred, Effect, Layer, Redacted, Stream } from "effect";
import { FetchHttpClient } from "effect/http";

import { AgentHarness } from "../harness/agentHarness";
import { derivedMessageId } from "../harness/messageId";
import { openCodeHarness } from "../harness/openCodeClient";
import { OpenCodeServer } from "../harness/openCodeServer";
import { runMain } from "./main";
import { RUNTIME_DIR } from "./runtime";

/* ------------------------------------------------------------------ prompts */

const LONG_TURN =
  "There are six files in this directory named note-1.txt to note-6.txt. Read them one " +
  "at a time, in order, using exactly one read call per message and never two in the " +
  "same message. After each read, say in one short sentence which word the file " +
  "contained, then read the next. Use no other tool. When all six are read, list the six " +
  "words.";

const QUEUED = "Reply with the single word QUEUED-ONE and nothing else.";
const AFTER = "Reply with the single word AFTER and nothing else.";

const NOTES: Readonly<Record<string, string>> = {
  "note-1.txt": "alpha\n",
  "note-2.txt": "bravo\n",
  "note-3.txt": "charlie\n",
  "note-4.txt": "delta\n",
  "note-5.txt": "echo\n",
  "note-6.txt": "foxtrot\n",
};

/** How long a queued follow-up gets to run on its own after the interrupt. */
const QUIET_WINDOW_MS = 30_000;

/* ------------------------------------------------------------------- output */

const OUT_DIR = join(RUNTIME_DIR, "interrupt-probe");

const line = (label: string, value: unknown): void => {
  console.log(`${label.padEnd(34)} ${String(value)}`);
};

const heading = (text: string): void => {
  console.log(`\n== ${text} ==`);
};

interface LegResult {
  readonly driver: string;
  readonly status: "MEASURED" | "UNTESTED";
  readonly detail: string;
}

const prepareWorkspace = (name: string) =>
  Effect.gen(function* () {
    const workspace = join(RUNTIME_DIR, name);
    yield* Effect.sync(() => {
      mkdirSync(workspace, { recursive: true });
    });
    yield* Effect.forEach(Object.entries(NOTES), ([file, content]) =>
      Effect.promise(() => Bun.write(join(workspace, file), content)),
    );
    return workspace;
  });

/** `--name=value` from argv, or the fallback. */
const flag = (name: string, fallback: string): string =>
  process.argv
    .find((argument) => argument.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ?? fallback;

/** Which of the probe's three marker words a piece of text contains. */
const markers = (text: string): string =>
  ["QUEUED-ONE", "AFTER", "foxtrot"]
    .filter((word) => text.includes(word))
    .join(",");

/* ---------------------------------------------------------------- opencode */

const OPENCODE_MODEL = flag("model", "opencode/glm-5.3-flash-free");

const openCodeLeg = Effect.fnUntraced(function* () {
  const workspace = yield* prepareWorkspace("interrupt-probe-opencode");

  const run = Effect.gen(function* () {
    const { server } = yield* OpenCodeServer;
    const harness = yield* AgentHarness;
    heading("opencode");
    line("server version", server.version);
    line("model", OPENCODE_MODEL);

    const rawMessages = (sessionId: string) =>
      Effect.promise(async () => {
        const response = await fetch(
          `${server.baseUrl}/api/session/${sessionId}/message?order=asc&limit=200`,
          {
            headers: {
              authorization: Redacted.value(server.authorization),
              accept: "application/json",
            },
          },
        );
        return (await response.json()) as { data?: unknown[] };
      });

    const sessionId = harness.newSessionId();
    yield* harness.createSession({
      title: "spike-f5 interrupt",
      model: OPENCODE_MODEL,
      directory: workspace,
      sessionId,
      multiTurn: true,
    });
    line("session", sessionId);

    const toolResult = yield* Deferred.make<number>();
    yield* Effect.forkScoped(
      Stream.runForEach(harness.sessionEvents(sessionId), (entry) =>
        Effect.sync(() => {
          appendFileSync(
            join(OUT_DIR, `opencode-narration.jsonl`),
            `${JSON.stringify({ at: Date.now(), type: entry.type, outcome: entry.outcome, detail: entry.detail._tag })}\n`,
          );
        }).pipe(
          Effect.andThen(
            entry.detail._tag === "toolResult"
              ? Deferred.succeed(toolResult, Date.now())
              : Effect.void,
          ),
        ),
      ).pipe(Effect.ignore),
    );
    yield* Effect.sleep("1 second");

    const steer = (text: string, key: string) =>
      harness.prompt(sessionId, text, {
        _tag: "steer",
        urgency: "queued",
        messageId: derivedMessageId("spike-f5", `${sessionId}:${key}`),
      });

    heading("opencode — long turn, a queued follow-up, then an interrupt");
    yield* harness.prompt(sessionId, LONG_TURN);
    const first = yield* Deferred.await(toolResult).pipe(
      Effect.timeoutOption("90 seconds"),
    );
    line(
      "first tool result",
      first._tag === "Some" ? "seen" : "NONE within 90 s; going on anyway",
    );
    yield* steer(QUEUED, "queued");
    line("queued follow-up", "accepted");
    yield* Effect.sleep("500 millis");
    const interruptedAt = Date.now();
    const interrupted = yield* Effect.result(
      harness.interruptSession(sessionId),
    );
    line(
      "interruptSession",
      interrupted._tag === "Success"
        ? `answered ${String(interrupted.success)} in ${Date.now() - interruptedAt} ms`
        : `FAILED: ${interrupted.failure.message}`,
    );
    const idle = yield* Effect.result(
      harness.waitForIdle(sessionId).pipe(Effect.timeout("60 seconds")),
    );
    line(
      "waitForIdle after interrupt",
      idle._tag === "Success"
        ? `idle after ${Date.now() - interruptedAt} ms`
        : `did not answer: ${String(idle.failure)}`,
    );
    const status = yield* Effect.result(harness.sessionStatus(sessionId));
    line(
      "sessionStatus after interrupt",
      status._tag === "Success"
        ? JSON.stringify({
            activity: status.success.activity,
            outcome: status.success.outcome,
          })
        : status.failure.message,
    );
    line("quiet window", `${QUIET_WINDOW_MS / 1000} s`);
    yield* Effect.sleep(`${QUIET_WINDOW_MS} millis`);
    const quiet = yield* rawMessages(sessionId);

    heading("opencode — a third message after the interrupt");
    const afterAt = Date.now();
    const after = yield* Effect.result(steer(AFTER, "after"));
    line(
      "third message",
      after._tag === "Success"
        ? `accepted (delivered: ${String(after.success.delivered)})`
        : `REFUSED: ${after.failure.message}`,
    );
    yield* harness
      .waitForIdle(sessionId)
      .pipe(Effect.timeout("3 minutes"), Effect.ignore);
    line("third turn idle after", `${Date.now() - afterAt} ms`);

    const messages = yield* rawMessages(sessionId);
    writeFileSync(
      join(OUT_DIR, "opencode-messages.json"),
      `${JSON.stringify({ quiet, final: messages }, null, 2)}\n`,
    );
    heading("opencode — every entry, relative to the interrupt");
    const quietIds = new Set(
      (quiet.data ?? []).map((entry) => (entry as { id?: unknown }).id),
    );
    for (const message of messages.data ?? []) {
      const record = message as {
        id?: unknown;
        type?: unknown;
        text?: unknown;
        outcome?: unknown;
        time?: { created?: unknown };
        content?: { type?: string; text?: string }[];
      };
      const created =
        typeof record.time?.created === "number"
          ? `${String(record.time.created - interruptedAt).padStart(8)} ms`
          : "       ?";
      const text =
        typeof record.text === "string"
          ? record.text
          : (record.content ?? [])
              .filter((part) => part.type === "text")
              .map((part) => part.text ?? "")
              .join(" ");
      console.log(
        `  ${created}  ${quietIds.has(record.id) ? "     " : "LATER"}  ${String(record.type).padEnd(10)} ${record.outcome === undefined ? "" : `outcome=${String(record.outcome)} `}[${markers(text)}] ${JSON.stringify(text.slice(0, 70))}`,
      );
    }
    console.log(
      "  LATER marks an entry that was not there at the end of the quiet window.",
    );
    return {
      driver: "opencode",
      status: "MEASURED" as const,
      detail: `see ${OUT_DIR}/opencode-messages.json`,
    } satisfies LegResult;
  });

  const attempt = yield* Effect.result(
    Effect.scoped(
      run.pipe(
        Effect.provide(
          openCodeHarness({ defaultModel: OPENCODE_MODEL }).pipe(
            Layer.provideMerge(OpenCodeServer.layer({ cwd: workspace })),
            Layer.provide(FetchHttpClient.layer),
          ),
        ),
      ),
    ),
  );
  if (attempt._tag === "Failure") {
    heading("opencode — not measured");
    line("why", String(attempt.failure));
    return {
      driver: "opencode",
      status: "UNTESTED" as const,
      detail: String(attempt.failure),
    } satisfies LegResult;
  }
  return attempt.success;
});

/* ------------------------------------------------------------- claude code */

const CLAUDE_MODEL = flag("claude-model", "claude-haiku-4-5");

/** One frame the real `query()` yielded, with when it arrived. */
interface Frame {
  readonly at: number;
  readonly message: SDKMessage;
}

const claudeCodeLeg = Effect.fnUntraced(function* () {
  const workspace = yield* prepareWorkspace("interrupt-probe-claude-code");
  const file = join(OUT_DIR, "claude-frames.jsonl");
  writeFileSync(file, "");

  const measured = yield* Effect.result(
    Effect.tryPromise(() => claudeCodeRun(workspace, file)),
  );
  if (measured._tag === "Failure") {
    heading("claude code — not measured");
    line("why", String(measured.failure));
    return {
      driver: "claude-code",
      status: "UNTESTED" as const,
      detail: String(measured.failure),
    } satisfies LegResult;
  }
  return measured.success;
});

/**
 * The SDK, driven as `claudeCodeClient.ts`'s `launch` drives it: an input iterable held
 * open on a queue, so a message can be offered at any time.
 */
const claudeCodeRun = async (
  workspace: string,
  file: string,
): Promise<LegResult> => {
  heading("claude code");
  line("model", CLAUDE_MODEL);
  const pending: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  const sessionId = crypto.randomUUID();
  const uuids = new Map<string, string>();
  const send = (label: string, text: string): void => {
    const uuid = crypto.randomUUID();
    uuids.set(uuid, label);
    pending.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid,
      // A `queued` steer, as `userMessage` sends it. The opening prompt carries none.
      ...(label === "long" ? {} : { priority: "later" }),
    } as SDKUserMessage);
    const waiting = wake;
    wake = undefined;
    waiting?.();
  };
  const input = async function* (): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = pending.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (done) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  };

  send("long", LONG_TURN);
  const live = sdkQuery({
    prompt: input(),
    options: {
      cwd: workspace,
      model: CLAUDE_MODEL,
      sessionId,
      settingSources: [],
      permissionMode: "dontAsk",
      allowedTools: ["Read"],
      stderr: () => undefined,
    },
  });
  line("session", sessionId);

  const frames: Frame[] = [];
  const iterator = (live as AsyncIterable<SDKMessage>)[Symbol.asyncIterator]();
  let interruptedAt = 0;
  let sentAfter = false;
  let quietEndsAt = Number.POSITIVE_INFINITY;
  let deadline = Date.now() + 240_000;
  let resultsAfterAfter = 0;
  let afterSentAt = 0;

  for (;;) {
    // The quiet window ends on a timer, not on a frame: an interrupted turn whose queued
    // follow-up never runs produces no frame at all to wake this loop.
    const now = Date.now();
    const until = Math.min(deadline, quietEndsAt) - now;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = await Promise.race([
      iterator.next(),
      new Promise<"tick">((resolve) => {
        timer = setTimeout(() => resolve("tick"), Math.max(until, 0));
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (next === "tick") {
      if (!sentAfter && Date.now() >= quietEndsAt) {
        sentAfter = true;
        quietEndsAt = Number.POSITIVE_INFINITY;
        afterSentAt = Date.now();
        heading("claude code — a third message after the interrupt");
        send("after", AFTER);
        deadline = Date.now() + 120_000;
        continue;
      }
      line("stopped reading", "deadline reached");
      break;
    }
    if (next.done === true) {
      line("stream", "ENDED (the query finished on its own)");
      break;
    }
    const message = next.value;
    const frame = { at: Date.now(), message };
    frames.push(frame);
    appendFileSync(file, `${JSON.stringify(frame)}\n`);

    const isToolResult =
      message.type === "user" &&
      Array.isArray(message.message.content) &&
      message.message.content.some(
        (block) =>
          typeof block === "object" &&
          (block as { type?: unknown }).type === "tool_result",
      );
    if (isToolResult && interruptedAt === 0) {
      heading("claude code — long turn, a queued follow-up, then an interrupt");
      send("queued", QUEUED);
      line("queued follow-up", "offered");
      await new Promise((resolve) => setTimeout(resolve, 500));
      interruptedAt = Date.now();
      let interruptAnswer: string;
      try {
        await live.interrupt();
        interruptAnswer = `acknowledged in ${Date.now() - interruptedAt} ms`;
      } catch (cause) {
        interruptAnswer = `REFUSED: ${String(cause)}`;
      }
      line("interrupt()", interruptAnswer);
      quietEndsAt = Date.now() + QUIET_WINDOW_MS;
      line("quiet window", `${QUIET_WINDOW_MS / 1000} s`);
    }
    if (message.type === "result" && sentAfter) {
      resultsAfterAfter += 1;
      // The third message's own `result`, or one for the queued follow-up running late:
      // read on briefly for the other.
      deadline = Math.min(deadline, Date.now() + 20_000);
      if (resultsAfterAfter >= 2) break;
    }
  }
  done = true;
  const waiting = wake;
  wake = undefined;
  waiting?.();
  live.close();

  heading("claude code — every frame, relative to the interrupt");
  for (const { at, message } of frames) {
    const time = `${String(at - interruptedAt).padStart(8)} ms`;
    if (message.type === "assistant") {
      const text = message.message.content
        .map((block) =>
          block.type === "text"
            ? block.text
            : block.type === "tool_use"
              ? `tool_use:${block.name}`
              : block.type,
        )
        .join(" ");
      console.log(
        `  ${time}  assistant  [${markers(text)}] ${JSON.stringify(text.slice(0, 70))}`,
      );
    } else if (message.type === "result") {
      const record = message as unknown as {
        subtype?: string;
        num_turns?: number;
        user_message_uuids?: readonly string[];
        result?: string;
      };
      const named = (record.user_message_uuids ?? []).map(
        (uuid) => uuids.get(uuid) ?? `?${uuid.slice(0, 8)}`,
      );
      console.log(
        `  ${time}  result/${String(record.subtype)}  turns=${String(record.num_turns)}  for=[${named.join(",")}]  [${markers(record.result ?? "")}]`,
      );
    } else if (message.type === "user") {
      const content = message.message.content;
      const text =
        typeof content === "string"
          ? content
          : content
              .map((block) =>
                block.type === "text"
                  ? block.text
                  : block.type === "tool_result"
                    ? "tool_result"
                    : block.type,
              )
              .join(" ");
      console.log(`  ${time}  user       ${JSON.stringify(text.slice(0, 70))}`);
    } else if (message.type === "system") {
      console.log(`  ${time}  system/${String(message.subtype)}`);
    }
  }
  if (afterSentAt > 0) {
    line(
      "third message sent at",
      `${String(afterSentAt - interruptedAt)} ms after the interrupt`,
    );
  }
  return {
    driver: "claude-code",
    status: "MEASURED",
    detail: `${frames.length} frames; see ${file}`,
  };
};

/* ------------------------------------------------------------------- entry */

const WANTED = (() => {
  const value = flag("driver", "all");
  return {
    openCode: value === "all" || value === "opencode",
    claudeCode: value === "all" || value === "claude-code",
  };
})();

const program = Effect.gen(function* () {
  mkdirSync(OUT_DIR, { recursive: true });
  heading("spike F5 — an interrupt, a queued follow-up, and the next message");
  line("date", new Date().toISOString());
  const results: LegResult[] = [];
  if (WANTED.openCode) results.push(yield* openCodeLeg());
  if (WANTED.claudeCode) results.push(yield* claudeCodeLeg());
  heading("verdicts");
  for (const result of results) {
    console.log(`  ${result.driver.padEnd(14)} ${result.status}`);
    console.log(`      ${result.detail}`);
  }
});

runMain(program);
