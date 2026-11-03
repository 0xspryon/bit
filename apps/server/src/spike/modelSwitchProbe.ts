/**
 * Spike F3 — when does a model switch take effect, mid-turn and between turns?
 *
 * ```sh
 * cd apps/server
 * systemd-run --user --scope -q -p MemoryMax=1G -p MemorySwapMax=0 timeout 900 \
 *   bun run src/spike/modelSwitchProbe.ts --driver=opencode
 * systemd-run --user --scope -q -p MemoryMax=1G -p MemorySwapMax=0 timeout 900 \
 *   bun run src/spike/modelSwitchProbe.ts --driver=claude-code
 * ```
 *
 * One driver per run, under the repository's memory cap: an `opencode serve` child or a
 * Claude Code CLI subprocess sits inside the same scope as this process.
 *
 * The OpenCode leg defaults to two free models, and `--first=` / `--second=` replace them.
 * The free tier is rate-limited per account: on 2026-11-03 every `opencode/*-free` model
 * answered 429 `provider.free-limit` before its first step, so the recorded run (see
 * `AgentHarness.switchModel`) used
 * `--first=zai-coding-plan/glm-5.3-flash --second=zai-coding-plan/glm-5.3`. A 429 shows up
 * as a turn of one failed step and no tool result, which this probe reports rather than
 * reading it as a switch result.
 *
 * `AgentHarness.switchModel` promises that a switch is applied at once and the harness takes
 * it from its next model call. T3 Code applies every in-session switch on the *next turn*,
 * so a mid-turn switch on Claude Code had never been measured, and OpenCode's behaviour was
 * known only from reading its source. This probe settles both against the real harnesses.
 *
 * ## What is done, and through what
 *
 * **Through bit's own seam**, not the bare drivers: the production `openCodeHarness` and
 * `claudeCodeHarness` layers open the session, prompt it and call `switchModel`, so what is
 * measured is what bit will actually do. Two things are added around them and nothing in
 * `src/harness` is changed:
 *
 * - **OpenCode.** Which model produced each assistant message is read raw off
 *   `GET /api/session/:id/message`, because the seam's `messages` reduces an entry to its
 *   text. Every model-ish field of each message is printed, unreduced.
 * - **Claude Code.** The SDK seam (`ClaudeCodeSdk`) is wrapped: each frame the real
 *   `query()` yields is copied, with its arrival time, so `message.model` on every
 *   `assistant` frame is visible. The wrapper also drops the setting sources and allows
 *   `Read` — the policy gate that pre-approves tools in production is not installed here,
 *   and under `dontAsk` with no gate every tool call would be denied. A denied call is
 *   still a model call, but a read that succeeds is the turn production runs.
 *
 * Each leg runs one long turn (six files read one call at a time, so six or more model
 * calls), switches model as soon as the first tool result is narrated, and lets the turn
 * finish. Then it switches again between turns, with a reasoning option this time, and runs
 * a short second turn. Every assistant message is listed with its time relative to the
 * moment the switch was acknowledged.
 *
 * ## Honesty rules this file follows
 *
 * - Nothing is simulated. A driver that will not start is reported `UNTESTED`.
 * - Credentials stay out of the output: the OpenCode server's Basic credential is used for
 *   the raw reads and never printed, and the Claude Code CLI uses the operator's own login.
 * - Everything lands under `.runtime/model-switch-probe/`, which is gitignored.
 *
 * **Nothing may import this module.** `runMain` is called at module scope; the rule and
 * what it cost to learn are on `workerDemo.ts`.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  query as sdkQuery,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ModelOptionSelection } from "@bit/contracts";
import { Deferred, Effect, Layer, Redacted, Stream } from "effect";
import { FetchHttpClient } from "effect/http";

import { AgentHarness } from "../harness/agentHarness";
import {
  claudeCodeHarness,
  liveClaudeCodeSdk,
  type ClaudeCodeSdk,
  type HarnessQuery,
} from "../harness/claudeCodeClient";
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

const SHORT_TURN = "Reply with the single word DONE and nothing else.";

const EFFORT_TURN =
  "Use the Bash tool to run exactly this command: printenv CLAUDE_EFFORT — then reply " +
  "with its output, or with the word UNSET if it printed nothing, and nothing else.";

const NOTES: Readonly<Record<string, string>> = {
  "note-1.txt": "alpha\n",
  "note-2.txt": "bravo\n",
  "note-3.txt": "charlie\n",
  "note-4.txt": "delta\n",
  "note-5.txt": "echo\n",
  "note-6.txt": "foxtrot\n",
};

/* ------------------------------------------------------------------- output */

const OUT_DIR = join(RUNTIME_DIR, "model-switch-probe");

const line = (label: string, value: unknown): void => {
  console.log(`${label.padEnd(34)} ${String(value)}`);
};

const heading = (text: string): void => {
  console.log(`\n== ${text} ==`);
};

const dump = (file: string, value: unknown): void => {
  writeFileSync(join(OUT_DIR, file), `${JSON.stringify(value, null, 2)}\n`);
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

/**
 * Forks a reader of the seam's own narration that completes `toolResult` on the first tool
 * result, which is the moment the turn is certainly between two model calls of one turn.
 */
const watchForFirstToolResult = (
  harness: AgentHarness["Service"],
  sessionId: string,
  toolResult: Deferred.Deferred<number>,
) =>
  Effect.forkScoped(
    Stream.runForEach(harness.sessionEvents(sessionId), (entry) =>
      Effect.sync(() => {
        appendFileSync(
          join(OUT_DIR, `narration-${sessionId}.jsonl`),
          `${JSON.stringify({ at: Date.now(), type: entry.type, detail: entry.detail._tag })}\n`,
        );
      }).pipe(
        Effect.andThen(
          entry.detail._tag === "toolResult"
            ? Deferred.succeed(toolResult, Date.now())
            : Effect.void,
        ),
      ),
    ).pipe(
      Effect.tapCause((cause) =>
        Effect.sync(() => {
          console.log(`  narration stream ended: ${String(cause)}`);
        }),
      ),
      Effect.ignore,
    ),
  );

/** One switch through the seam, timed, with the seam's own failure if it refused. */
const timedSwitch = (
  harness: AgentHarness["Service"],
  sessionId: string,
  model: string,
  options?: readonly ModelOptionSelection[],
) =>
  Effect.gen(function* () {
    const asked = Date.now();
    const outcome = yield* Effect.result(
      harness.switchModel(sessionId, model, options),
    );
    const acknowledged = Date.now();
    line(
      `switchModel → ${model}${options === undefined ? "" : ` ${JSON.stringify(options)}`}`,
      outcome._tag === "Success"
        ? `acknowledged in ${acknowledged - asked} ms`
        : `REFUSED: ${outcome.failure.message}`,
    );
    return { asked, acknowledged, ok: outcome._tag === "Success" };
  });

/* ---------------------------------------------------------------- opencode */

/** `--name=value` from argv, or the fallback. */
const flag = (name: string, fallback: string): string =>
  process.argv
    .find((argument) => argument.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ?? fallback;

/**
 * Two free models, overridable because OpenCode's free tier is rate-limited per model: a
 * 429 `provider.free-limit` on one is a reason to name another, not a measurement.
 */
const OPENCODE_FIRST = flag("first", "opencode/glm-5.3-flash-free");
const OPENCODE_SECOND = flag("second", "opencode/deepseek-v4.1-flash-free");

/** Every field of an object whose key names a model, provider or variant. */
const modelFields = (value: unknown, path = ""): Record<string, unknown> => {
  if (value === null || typeof value !== "object") return {};
  const found: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const here = path === "" ? key : `${path}.${key}`;
    if (/model|provider|variant/i.test(key)) found[here] = child;
    else if (key !== "parts" && key !== "content")
      Object.assign(found, modelFields(child, here));
  }
  return found;
};

const openCodeLeg = Effect.fnUntraced(function* () {
  const workspace = yield* prepareWorkspace("model-switch-probe-opencode");

  const run = Effect.gen(function* () {
    const { server } = yield* OpenCodeServer;
    const harness = yield* AgentHarness;
    heading("opencode");
    line("server version", server.version);
    for (const model of [OPENCODE_FIRST, OPENCODE_SECOND]) {
      const view = harness.instance.models.find((entry) => entry.id === model);
      line(
        `catalogue: ${model}`,
        view === undefined
          ? "NOT LISTED"
          : JSON.stringify(view.optionDescriptors?.[0]?.options ?? []),
      );
    }

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
      title: "spike-f3 model switch",
      model: OPENCODE_FIRST,
      directory: workspace,
      sessionId,
      multiTurn: true,
    });
    line("session", sessionId);

    const toolResult = yield* Deferred.make<number>();
    yield* watchForFirstToolResult(harness, sessionId, toolResult);
    // The stream is live-only: let the subscription establish before prompting.
    yield* Effect.sleep("1 second");

    heading("opencode — turn 1, switched mid-turn");
    const turnStarted = Date.now();
    yield* harness.prompt(sessionId, LONG_TURN);
    const firstResult = yield* Deferred.await(toolResult).pipe(
      Effect.timeoutOption("90 seconds"),
    );
    line(
      "first tool result at",
      firstResult._tag === "Some"
        ? `${firstResult.value - turnStarted} ms`
        : "NONE NARRATED within 90 s; switching anyway",
    );
    const midTurn = yield* timedSwitch(harness, sessionId, OPENCODE_SECOND);
    // Idempotence on the real server: the same switch again.
    yield* timedSwitch(harness, sessionId, OPENCODE_SECOND);
    yield* harness
      .waitForIdle(sessionId)
      .pipe(Effect.timeout("5 minutes"), Effect.ignore);

    heading("opencode — turn 2, switched between turns");
    const betweenTurns = yield* timedSwitch(
      harness,
      sessionId,
      OPENCODE_FIRST,
      [{ id: "variant", value: "high" }],
    );
    yield* harness.prompt(sessionId, SHORT_TURN, {
      _tag: "steer",
      urgency: "queued",
      messageId: derivedMessageId("spike-f3", `${sessionId}:turn-2`),
    });
    yield* harness
      .waitForIdle(sessionId)
      .pipe(Effect.timeout("3 minutes"), Effect.ignore);

    const messages = yield* rawMessages(sessionId);
    dump("opencode-messages.json", messages);
    heading("opencode — every message, with its model fields");
    console.log(
      "  times are relative to the mid-turn switch's acknowledgement " +
        `(between-turns switch at +${betweenTurns.acknowledged - midTurn.acknowledged} ms)`,
    );
    for (const message of messages.data ?? []) {
      const record = message as {
        id?: unknown;
        type?: unknown;
        role?: unknown;
        time?: { created?: unknown; completed?: unknown };
      };
      const created =
        typeof record.time?.created === "number"
          ? `${String(record.time.created - midTurn.acknowledged).padStart(8)} ms`
          : "       ?";
      console.log(
        `  ${created}  ${String(record.type ?? record.role).padEnd(10)} ${String(record.id)}  ${JSON.stringify(modelFields(message))}`,
      );
    }
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
          openCodeHarness({ defaultModel: OPENCODE_FIRST }).pipe(
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

const CLAUDE_FIRST = "claude-haiku-4-5";
const CLAUDE_SECOND = "claude-sonnet-4-5";
const CLAUDE_THIRD = "claude-sonnet-5";

/** One frame the real `query()` yielded, with when it arrived. */
interface Frame {
  readonly at: number;
  readonly message: SDKMessage;
}

/**
 * The real SDK, with every yielded frame copied out and the two probe-only options applied.
 *
 * The production options pass through untouched apart from `settingSources` (none, so the
 * operator's own hooks and permissions do not enter the measurement) and `allowedTools`
 * (`Read`, standing in for the gate's pre-approval, and `printenv` through `Bash`, which is
 * how a turn reads back the effort level it ran at). See the file header.
 */
const teeingSdk = (frames: Frame[], file: string): ClaudeCodeSdk => ({
  ...liveClaudeCodeSdk,
  query: (params) => {
    const live = sdkQuery({
      prompt: params.prompt,
      options: {
        ...params.options,
        settingSources: [],
        allowedTools: ["Read", "Bash(printenv:*)"],
      },
    });
    const wrapped: HarnessQuery = {
      setMcpServers: (servers) => live.setMcpServers(servers),
      interrupt: () => live.interrupt(),
      getContextUsage: () => live.getContextUsage(),
      setModel: (model) => live.setModel(model),
      applyFlagSettings: (settings) => live.applyFlagSettings(settings),
      close: () => {
        live.close();
      },
      [Symbol.asyncIterator]: async function* () {
        for await (const message of live) {
          const frame = { at: Date.now(), message };
          frames.push(frame);
          appendFileSync(file, `${JSON.stringify(frame)}\n`);
          yield message;
        }
      },
    };
    return wrapped;
  },
});

const claudeCodeLeg = Effect.fnUntraced(function* () {
  const workspace = yield* prepareWorkspace("model-switch-probe-claude-code");
  const frames: Frame[] = [];
  const file = join(OUT_DIR, "claude-frames.jsonl");
  writeFileSync(file, "");

  const run = Effect.gen(function* () {
    const harness = yield* AgentHarness;
    heading("claude code");
    line("build", harness.instance.version);
    const sessionId = harness.newSessionId();
    yield* harness.createSession({
      title: "spike-f3 model switch",
      model: CLAUDE_FIRST,
      directory: workspace,
      sessionId,
      multiTurn: true,
    });
    line("session", sessionId);

    const toolResult = yield* Deferred.make<number>();
    yield* watchForFirstToolResult(harness, sessionId, toolResult);

    heading("claude code — turn 1, switched mid-turn");
    const turnStarted = Date.now();
    yield* harness.prompt(sessionId, LONG_TURN);
    const firstResult = yield* Deferred.await(toolResult).pipe(
      Effect.timeoutOption("90 seconds"),
    );
    line(
      "first tool result at",
      firstResult._tag === "Some"
        ? `${firstResult.value - turnStarted} ms`
        : "NONE NARRATED within 90 s; switching anyway",
    );
    const midTurn = yield* timedSwitch(harness, sessionId, CLAUDE_SECOND);
    // Idempotence: the same switch again sends nothing on this driver.
    yield* timedSwitch(harness, sessionId, CLAUDE_SECOND);
    yield* harness
      .waitForIdle(sessionId)
      .pipe(Effect.timeout("5 minutes"), Effect.ignore);

    /*
     * Four short turns, each reading back the level it ran at.
     *
     * No frame carries the effort level, but the CLI exports it to Bash as
     * `CLAUDE_EFFORT` ("the active effort level for the current turn … after any silent
     * downgrade for the selected model", `sdk.d.ts`). So each turn prints it with
     * `printenv` — not `echo $…`, which the CLI's permission matcher will not pre-approve.
     *
     * Turn 2 moves model and level together. Turn 3 keeps the model and chooses nothing,
     * which sends `effortLevel: null` alone: right after `low`, it tells "null resets to
     * the model's default" apart from "null is ignored". Turn 4 moves the level alone.
     * Turn 5 moves to a model bit offers no level for, which sends `null` after a model
     * change.
     */
    const betweenTurns: { label: string; acknowledged: number }[] = [];
    const turns: readonly {
      readonly model: string;
      readonly options: readonly ModelOptionSelection[] | undefined;
    }[] = [
      { model: CLAUDE_THIRD, options: [{ id: "effort", value: "low" }] },
      { model: CLAUDE_THIRD, options: undefined },
      { model: CLAUDE_THIRD, options: [{ id: "effort", value: "high" }] },
      { model: CLAUDE_FIRST, options: undefined },
    ];
    for (const [index, turn] of turns.entries()) {
      heading(`claude code — turn ${index + 2}, switched between turns`);
      const switched = yield* timedSwitch(
        harness,
        sessionId,
        turn.model,
        turn.options,
      );
      betweenTurns.push({
        label: `turn ${index + 2}`,
        acknowledged: switched.acknowledged,
      });
      yield* harness.prompt(sessionId, EFFORT_TURN, {
        _tag: "steer",
        urgency: "queued",
        messageId: derivedMessageId(
          "spike-f3",
          `${sessionId}:turn-${index + 2}`,
        ),
      });
      yield* harness
        .waitForIdle(sessionId)
        .pipe(Effect.timeout("3 minutes"), Effect.ignore);
    }

    heading("claude code — every assistant and result frame, with its model");
    console.log(
      "  times are relative to the mid-turn switch's acknowledgement " +
        `(between-turns switches at ${betweenTurns.map((turn) => `${turn.label} +${turn.acknowledged - midTurn.acknowledged} ms`).join(", ")})`,
    );
    for (const frame of frames) {
      const message = frame.message as unknown as {
        type: string;
        subtype?: string;
        message?: {
          id?: string;
          model?: string;
          content?: { type?: string; name?: string }[];
        };
        modelUsage?: Record<string, unknown>;
      };
      const at = `${String(frame.at - midTurn.acknowledged).padStart(8)} ms`;
      if (message.type === "assistant") {
        const blocks = (message.message?.content ?? [])
          .map((block) =>
            block.type === "tool_use" ? `tool_use:${block.name}` : block.type,
          )
          .join(",");
        console.log(
          `  ${at}  assistant ${String(message.message?.id)}  model=${String(message.message?.model)}  [${blocks}]`,
        );
      } else if (message.type === "user") {
        const content: unknown = message.message?.content;
        const results = (
          (Array.isArray(content) ? content : []) as {
            type?: string;
            content?: unknown;
          }[]
        )
          .filter((block) => block.type === "tool_result")
          .map((block) => JSON.stringify(block.content).slice(0, 80));
        if (results.length > 0) {
          console.log(`  ${at}  tool_result ${results.join(" ")}`);
        }
      } else if (message.type === "result") {
        console.log(
          `  ${at}  result/${String(message.subtype)}  modelUsage=${JSON.stringify(Object.keys(message.modelUsage ?? {}))}`,
        );
      } else if (message.type === "system") {
        const system = message as unknown as { model?: string };
        console.log(
          `  ${at}  system/${String(message.subtype)}${system.model === undefined ? "" : `  model=${system.model}`}`,
        );
      }
    }
    return {
      driver: "claude-code",
      status: "MEASURED" as const,
      detail: `${frames.length} frames; see ${file}`,
    } satisfies LegResult;
  });

  const attempt = yield* Effect.result(
    Effect.scoped(
      run.pipe(
        Effect.provide(
          claudeCodeHarness({
            sdk: teeingSdk(frames, file),
            defaultModel: CLAUDE_FIRST,
          }),
        ),
      ),
    ),
  );
  if (attempt._tag === "Failure") {
    heading("claude code — not measured");
    line("why", String(attempt.failure));
    return {
      driver: "claude-code",
      status: "UNTESTED" as const,
      detail: String(attempt.failure),
    } satisfies LegResult;
  }
  return attempt.success;
});

/* ------------------------------------------------------------------- entry */

const WANTED = (() => {
  const flag = process.argv.find((argument) =>
    argument.startsWith("--driver="),
  );
  const value = flag?.slice("--driver=".length) ?? "all";
  return {
    openCode: value === "all" || value === "opencode",
    claudeCode: value === "all" || value === "claude-code",
  };
})();

const program = Effect.gen(function* () {
  mkdirSync(OUT_DIR, { recursive: true });
  heading("spike F3 — model switch, mid-turn and between turns");
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
