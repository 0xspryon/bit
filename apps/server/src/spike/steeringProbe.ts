/**
 * Spike A — can a *running* harness session be prompted again, and what happens?
 *
 * ```sh
 * cd apps/server
 * bun run src/spike/steeringProbe.ts 2>&1 | tee .runtime/steering-probe-$(date +%H%M%S).log
 * bun run src/spike/steeringProbe.ts --driver=opencode
 * bun run src/spike/steeringProbe.ts --driver=claude-code
 * ```
 *
 * `docs/design/goal-and-planner-flow.md` decision 12 says the goal agent *steers* a live
 * planner round by injecting a directive into its running session. That is a claim about
 * two drivers, and neither `harness/openCodeClient.ts` nor `harness/claudeCodeClient.ts`
 * exercises it: `AgentHarness.prompt` returns `void` because the only caller it has ever
 * had is `run/supervisor.ts`, which prompts once per session and never again. So this
 * measures the *drivers*, below our own seam, and reports what each one actually did.
 *
 * ## What "again" means on each driver, and why this probe bypasses our own client
 *
 * - **OpenCode.** `POST /api/session/:id/prompt` takes a `delivery: "steer" | "queue"`
 *   field that `AgentHarness.prompt` does not pass, so our client cannot express either
 *   answer today and the probe calls the generated client directly. The second prompt of
 *   each round is sent twice over: once with `delivery` omitted (what production sends
 *   today) and once with `delivery: "queue"`, because the difference between those two is
 *   the whole decision.
 * - **Claude Code.** There is no second call to make: the SDK takes an
 *   `AsyncIterable<SDKUserMessage>` and `claudeCodeClient.ts` already holds that iterable
 *   open for the session's whole life — a second message is a second `yield`, not a second
 *   request. Our `prompt` refuses it with a transport error anyway, so the probe records
 *   that refusal verbatim and then drives `query()` itself to find out what the driver
 *   would have done. `SDKUserMessage.priority` (`'now' | 'next' | 'later'`) is the knob,
 *   and both ends of it are measured.
 *
 * ## What is being counted
 *
 * The question is not "was the second prompt accepted" — both drivers accept it. It is
 * **whether the directive reached the model inside the run that was already going**, which
 * is what decision 12 needs and what a settlement table has to be written against. So the
 * probe counts *executions*, not prompts:
 *
 * - On OpenCode, `session.execution.started` / `.succeeded` pairs on
 *   `api.event.subscribe()`. One pair with both prompts inside it is interleaving; two
 *   pairs is queueing.
 * - On Claude Code, `result` messages on the query. One `result` whose
 *   `user_message_uuids` names both sends is interleaving; two `result`s is queueing.
 *
 * Each leg also keeps the narration it saw, in order, because "what the stream does" is
 * half of what the dispatch asked for: a steered round that produces no visible marker is
 * a round whose transcript cannot explain its own disposition (decision 17).
 *
 * ## Honesty rules this file follows
 *
 * - Nothing is simulated. A driver that will not start is reported as `UNTESTED` with the
 *   failure text, and the verdict table says so.
 * - No production code is changed. The OpenCode leg builds its own client over the same
 *   `OpenCodeServer` layer; the Claude Code leg uses the shipped `claudeCodeHarness` for
 *   the refusal and the bare SDK for the measurement.
 * - The second prompt is phrased as a *detectable* instruction ("reply with exactly
 *   STEERED"), so the verdict is read off the transcript rather than off the absence of an
 *   error.
 *
 * **Nothing may import this module.** `runMain` is called at module scope; the rule and
 * what it cost to learn are on `workerDemo.ts`.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  query as sdkQuery,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { OpenCode } from "@opencode/client/effect";
import { ID as ModelID } from "@opencode/schema/model";
import { ID as ProviderID } from "@opencode/schema/provider";
import { AbsolutePath } from "@opencode/schema/schema";
import { ID as SessionID, type Session } from "@opencode/schema/session";
import {
  Deferred,
  Effect,
  Fiber,
  Layer,
  Redacted,
  Schema,
  Stream,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { AgentHarness } from "../harness/agentHarness";
import {
  claudeCodeHarness,
  CLAUDE_CODE_DEFAULT_MODEL,
} from "../harness/claudeCodeClient";
import { OPENCODE_DEFAULT_MODEL } from "../harness/openCodeClient";
import { OpenCodeServer } from "../harness/openCodeServer";
import { runMain } from "./main";
import { RUNTIME_DIR } from "./runtime";

/* ------------------------------------------------------------------ prompts */

/**
 * A first prompt that is slow for a reason the probe controls.
 *
 * Text generation only, and deliberately so: a slow prompt built out of tool calls would
 * make the probe depend on a permission posture as well as on steering, and a denial would
 * look exactly like a refusal to steer. Length is the only thing making this slow, which
 * means the window stays open on both drivers for the same reason.
 */
const SLOW_PROMPT =
  "Count from 1 to 60. Put each number on its own line, and after each number write " +
  "one short sentence about that number. Do not use any tools. Do not stop early.";

/**
 * A first prompt that is slow *and* made of many steps.
 *
 * {@link SLOW_PROMPT} turned out not to separate OpenCode's two deliveries, and the reason
 * is worth keeping: OpenCode promotes an inbox item only at a **step** boundary, and a
 * single long text answer is one step — so a steer and a queue both land at the same
 * instant, the end of that step. A multi-step first prompt is what makes the difference
 * observable, and the todo tools are what make it multi-step without dragging a permission
 * decision into the measurement: they are not filesystem or shell tools, so no gate and no
 * default permission posture has an opinion about them.
 */
const MULTI_STEP_PROMPT =
  "There are eight files in this directory named note-1.txt through note-8.txt. " +
  "Read them one at a time, using exactly one read call per file and never two in the " +
  "same message. After each file, say which word it contained. Use no other tool.";

/** The files {@link MULTI_STEP_PROMPT} walks, one per step. */
const MULTI_STEP_FILES: Readonly<Record<string, string>> = Object.fromEntries(
  [
    "alpha",
    "bravo",
    "charlie",
    "delta",
    "echo",
    "foxtrot",
    "golf",
    "hotel",
  ].map((word, index) => [`note-${index + 1}.txt`, `${word}\n`]),
);

/**
 * The directive. Short, unmistakable, and impossible to produce by accident.
 *
 * `STEERED` is what the probe greps for, so the verdict does not rest on the second call
 * returning without an error — a prompt can be accepted, stored, and never shown to the
 * model, which is precisely the failure decision 12 would not survive.
 */
const DIRECTIVE =
  "New instruction, overriding the previous one: stop counting immediately. " +
  "Reply with exactly the single word STEERED and nothing else.";

const MARKER = "STEERED";

/**
 * The highest number {@link SLOW_PROMPT}'s answer reached, as the evidence of a cut-off.
 *
 * `result.subtype` is `success` on both ends of the Claude Code measurement, so it cannot
 * tell a turn that finished from one that was stopped part-way. How far the counting got
 * can: 60 means the turn ran to completion before the directive was taken, and anything
 * well short of it means the directive cut it off.
 */
const highestCount = (text: string): number => {
  let highest = 0;
  for (const match of text.matchAll(/^\s*(\d{1,2})[.)]/gm)) {
    const value = Number(match[1]);
    if (value > highest) highest = value;
  }
  return highest;
};

/* ------------------------------------------------------------------- output */

const line = (label: string, value: unknown): void => {
  console.log(`${label.padEnd(30)} ${String(value)}`);
};

const heading = (text: string): void => {
  console.log(`\n== ${text} ==`);
};

/** One driver's answer, as the report's verdict column. */
type Verdict = "INTERLEAVED" | "QUEUED" | "REFUSED" | "ERROR" | "UNTESTED";

interface LegResult {
  readonly driver: string;
  readonly verdict: Verdict;
  readonly detail: string;
}

/* ---------------------------------------------------------------- opencode */

/** One event off `api.event.subscribe()`, reduced to what a verdict is read from. */
interface SeenEvent {
  readonly type: string;
  /** Milliseconds since the probe's own start, so the ordering is readable. */
  readonly at: number;
}

const sessionOf = (event: unknown): string | undefined => {
  const record = (event ?? {}) as {
    data?: { sessionID?: unknown } | undefined;
    durable?: { aggregateID?: unknown } | undefined;
  };
  const fromData = record.data?.sessionID;
  if (typeof fromData === "string") return fromData;
  const fromDurable = record.durable?.aggregateID;
  return typeof fromDurable === "string" ? fromDurable : undefined;
};

const typeOf = (event: unknown): string => {
  const type = (event as { type?: unknown }).type;
  return typeof type === "string" ? type : "unknown";
};

/**
 * One round of the OpenCode probe: prompt slowly, then prompt again mid-run.
 *
 * `delivery` is passed through verbatim — `undefined` is what production sends today, and
 * the inbox record the call answers with reports which delivery the *server* resolved
 * that to, which is a better answer than reading a default out of its source.
 */
const openCodeRound = Effect.fnUntraced(function* (input: {
  readonly label: string;
  readonly delivery: "steer" | "queue" | undefined;
  readonly first: string;
  readonly workspace: string;
}) {
  const { server } = yield* OpenCodeServer;
  const http = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest((request) =>
      request.pipe(
        HttpClientRequest.setHeader(
          "authorization",
          Redacted.value(server.authorization),
        ),
        HttpClientRequest.acceptJson,
      ),
    ),
  );
  const api = yield* OpenCode.make({ baseUrl: server.baseUrl }).pipe(
    Effect.provideService(HttpClient.HttpClient, http),
  );

  const sessionId = SessionID.create();
  const started = Date.now();
  const seen: SeenEvent[] = [];
  /** Completed by the collector at the first sign the model is actually working. */
  const live = yield* Deferred.make<void>();

  // Subscribed before prompting, for the same reason `run/supervisor.ts` does it: this
  // stream is live-only, so an entry published before the subscription is established is
  // simply gone, and the window is exactly where the first execution event lands.
  const collector = yield* Effect.forkScoped(
    api.event.subscribe().pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (sessionOf(event) !== sessionId) return;
          const type = typeOf(event);
          seen.push({ type, at: Date.now() - started });
          if (
            type === "session.text.delta" ||
            type === "session.step.started"
          ) {
            yield* Deferred.succeed(live, undefined);
          }
        }),
      ),
      Effect.orDie,
    ),
  );

  yield* Effect.orDie(
    api.session.create({
      title: `spike-a ${input.label}`,
      model: {
        providerID: Schema.decodeUnknownSync(ProviderID)(
          OPENCODE_DEFAULT_MODEL.slice(0, OPENCODE_DEFAULT_MODEL.indexOf("/")),
        ),
        id: Schema.decodeUnknownSync(ModelID)(
          OPENCODE_DEFAULT_MODEL.slice(OPENCODE_DEFAULT_MODEL.indexOf("/") + 1),
        ),
      },
      location: {
        directory: Schema.decodeUnknownSync(AbsolutePath)(input.workspace),
      },
      id: sessionId as Session.ID,
    }),
  );

  const first = yield* Effect.orDie(
    api.session.prompt({
      sessionID: sessionId as Session.ID,
      text: input.first,
    }),
  );
  line("first prompt admitted", (first as { id?: unknown }).id ?? "<no id>");

  // The window. A timeout rather than a fixed sleep: a model that starts producing in
  // 300ms and one that takes eight seconds should both be steered *while running*, and a
  // probe that slept a flat interval would be measuring the sleep.
  const opened = yield* Effect.result(
    Effect.timeout(Deferred.await(live), "60 seconds"),
  );
  if (opened._tag === "Failure") {
    yield* Fiber.interrupt(collector);
    return {
      verdict: "ERROR" as Verdict,
      detail:
        "the session produced no step or text event within 60s, so there was never a " +
        "running turn to prompt into",
      seen,
      executions: 0,
      stepsBefore: -1,
      totalSteps: 0,
      text: "",
      delivery: "n/a",
    };
  }

  const second = yield* Effect.result(
    api.session.prompt({
      sessionID: sessionId as Session.ID,
      text: DIRECTIVE,
      ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
    }),
  );
  if (second._tag === "Failure") {
    yield* Fiber.interrupt(collector);
    return {
      verdict: "REFUSED" as Verdict,
      detail: `the second prompt was refused: ${String(second.failure)}`,
      seen,
      executions: 0,
      stepsBefore: -1,
      totalSteps: 0,
      text: "",
      delivery: input.delivery ?? "<omitted>",
    };
  }
  const resolvedDelivery = String(
    (second.success as { delivery?: unknown }).delivery ?? "<not reported>",
  );
  line("second prompt admitted", `delivery=${resolvedDelivery}`);

  // `session.wait` blocks until the session is idle, which after a queued delivery means
  // after *both* executions: that is the point of waiting rather than sleeping.
  const settled = yield* Effect.result(
    Effect.timeout(
      api.experimental.session.wait({ sessionID: sessionId as Session.ID }),
      "4 minutes",
    ),
  );
  // The terminal execution event can land just after `wait` answers; the stream is a
  // separate socket and nothing orders the two.
  yield* Effect.sleep("2 seconds");
  yield* Fiber.interrupt(collector);

  const messages = yield* Effect.orDie(
    api.message.list({ sessionID: sessionId as Session.ID }),
  );
  const text = JSON.stringify(messages);
  const executions = seen.filter(
    (event) => event.type === "session.execution.started",
  ).length;
  // Where the directive landed, in steps. The first `inbox.delivered` is the first
  // prompt's; the second is the directive's, and counting the `step.started` events before
  // it says whether the run was interrupted part-way through its work or merely extended
  // at the point it would otherwise have ended.
  const deliveries = seen.flatMap((event, index) =>
    event.type === "session.inbox.delivered" ? [index] : [],
  );
  const directiveAt = deliveries[1];
  const stepsBefore =
    directiveAt === undefined
      ? -1
      : seen
          .slice(0, directiveAt)
          .filter((event) => event.type === "session.step.started").length;
  const totalSteps = seen.filter(
    (event) => event.type === "session.step.started",
  ).length;
  const toolCalls = seen.filter((event) =>
    event.type.startsWith("session.tool."),
  ).length;
  // A permission request would stall the run and look like a refusal to steer, so it is
  // reported rather than left to be inferred from a timeout.
  const permissions = seen.filter((event) =>
    event.type.includes("permission"),
  ).length;

  return {
    verdict:
      executions <= 1 ? ("INTERLEAVED" as Verdict) : ("QUEUED" as Verdict),
    detail:
      `${executions} execution(s) started; directive delivered after step ` +
      `${stepsBefore} of ${totalSteps}; ${toolCalls} tool event(s); ` +
      `${permissions} permission event(s); ` +
      `${settled._tag === "Failure" ? "session.wait did not answer within 4 minutes; " : ""}` +
      `marker ${text.includes(MARKER) ? "present" : "absent"} in the session's messages`,
    seen,
    executions,
    stepsBefore,
    totalSteps,
    text,
    delivery: resolvedDelivery,
  };
});

const openCodeLeg = Effect.fnUntraced(function* () {
  const workspace = join(RUNTIME_DIR, "steering-probe-opencode");
  yield* Effect.sync(() => {
    mkdirSync(workspace, { recursive: true });
  });
  yield* Effect.forEach(Object.entries(MULTI_STEP_FILES), ([name, content]) =>
    Effect.promise(() => Bun.write(join(workspace, name), content)),
  );

  const run = Effect.gen(function* () {
    const { server } = yield* OpenCodeServer;
    heading("opencode — server");
    line("version", server.version);
    line("base url", server.baseUrl);
    line("model", OPENCODE_DEFAULT_MODEL);

    const results: LegResult[] = [];
    for (const round of [
      {
        label: "one-step first prompt, default delivery",
        delivery: undefined,
        first: SLOW_PROMPT,
      },
      {
        label: "one-step first prompt, delivery=queue",
        delivery: "queue" as const,
        first: SLOW_PROMPT,
      },
      {
        label: "multi-step first prompt, delivery=steer",
        delivery: "steer" as const,
        first: MULTI_STEP_PROMPT,
      },
      {
        label: "multi-step first prompt, delivery=queue",
        delivery: "queue" as const,
        first: MULTI_STEP_PROMPT,
      },
    ]) {
      heading(`opencode — ${round.label}`);
      const outcome = yield* openCodeRound({
        label: round.label,
        delivery: round.delivery,
        first: round.first,
        workspace,
      });
      line("resolved delivery", outcome.delivery);
      line("executions started", outcome.executions);
      line(
        "directive delivered after",
        `step ${outcome.stepsBefore} of ${outcome.totalSteps}`,
      );
      line("verdict", outcome.verdict);
      line("detail", outcome.detail);
      console.log("  -- narration, in order --");
      for (const event of outcome.seen) {
        console.log(`  ${String(event.at).padStart(7)}ms  ${event.type}`);
      }
      results.push({
        driver: `opencode (${round.label})`,
        verdict: outcome.verdict,
        detail: outcome.detail,
      });
    }
    return results;
  });

  const attempt = yield* Effect.result(
    Effect.scoped(
      run.pipe(
        Effect.provide(
          OpenCodeServer.layer({ cwd: workspace }).pipe(
            Layer.provide(FetchHttpClient.layer),
          ),
        ),
        Effect.provide(FetchHttpClient.layer),
      ),
    ),
  );
  if (attempt._tag === "Failure") {
    heading("opencode — not measured");
    line("verdict", "UNTESTED");
    line("why", String(attempt.failure));
    return [
      {
        driver: "opencode",
        verdict: "UNTESTED" as Verdict,
        detail: String(attempt.failure),
      },
    ];
  }
  return attempt.success;
});

/* ------------------------------------------------------------- claude code */

/** One `result` message, reduced to what tells a turn boundary from a fold. */
interface ClaudeResult {
  readonly subtype: string;
  readonly turns: number;
  /** How many of our sends this turn's prompt consumed; 2 means the directive folded in. */
  readonly consumed: number;
  /** Whether the directive's own uuid is among them. */
  readonly namesDirective: boolean;
  /** Assistant text seen since the previous result. */
  readonly text: string;
  /** Milliseconds from the query starting to this result. */
  readonly at: number;
}

/** What one `query()` did, as the verdict is read from it. */
interface ClaudeRound {
  readonly results: readonly ClaudeResult[];
  readonly types: readonly string[];
  /** How far into the first turn the directive was sent, in content deltas. */
  readonly injectedAfterDeltas: number;
  readonly timedOut: boolean;
}

/**
 * Drives the SDK directly: one query, two user messages, the second sent mid-turn.
 *
 * This is the shape `claudeCodeClient.ts`'s `launch` already has — an async generator held
 * open for the session's life — with the one difference that it yields again. The generator
 * waits on a queue rather than on a single `release` resolver, because a second send has to
 * be able to arrive at any time rather than once.
 */
const claudeCodeQuery = async (input: {
  readonly priority: "now" | "later";
  readonly workspace: string;
}): Promise<ClaudeRound> => {
  const pending: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  const push = (message: SDKUserMessage): void => {
    pending.push(message);
    wake?.();
  };

  const sessionId = crypto.randomUUID();
  const send = (text: string, priority?: "now" | "later"): string => {
    const uuid = crypto.randomUUID();
    push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid,
      ...(priority === undefined ? {} : { priority }),
    } as SDKUserMessage);
    return uuid;
  };

  const input$ = async function* (): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (pending.length > 0) {
        const next = pending.shift();
        if (next !== undefined) yield next;
      }
      if (done) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = undefined;
    }
  };

  send(SLOW_PROMPT);

  const live = sdkQuery({
    prompt: input$(),
    options: {
      cwd: input.workspace,
      model: CLAUDE_CODE_DEFAULT_MODEL,
      sessionId,
      // Nothing from this repository: the probe measures the driver, and a settings file
      // picked up from the working tree would be a variable in the measurement.
      settingSources: [],
      permissionMode: "dontAsk",
      // So the first sign of a live turn arrives before the whole text block is complete.
      // Production does not set this; the probe needs it to know when the window is open.
      includePartialMessages: true,
      stderr: () => undefined,
    },
  });

  const startedAt = Date.now();
  const types: string[] = [];
  const results: ClaudeResult[] = [];
  let text = "";
  let deltas = 0;
  let injectedAfterDeltas = -1;
  let directiveUuid = "";
  let timedOut = false;

  /**
   * The stream, read with a bound, because the absence of a second message is a finding.
   *
   * A folded directive produces exactly one `result` and then nothing: the input iterable
   * is still open, so the query neither ends nor speaks again. A `for await` would hang
   * there forever and the probe would report a timeout instead of "one turn". Reading the
   * iterator by hand against a deadline is what lets "no second turn arrived" be an answer
   * rather than a hang.
   */
  const iterator = (live as AsyncIterable<SDKMessage>)[Symbol.asyncIterator]();
  /** The whole first turn gets this; once a result has landed, a shorter grace applies. */
  let budget = 240_000;
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = await Promise.race([
      iterator.next(),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), budget);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (next === "timeout") {
      timedOut = results.length === 0;
      break;
    }
    if (next.done === true) break;
    const message = next.value;
    types.push(message.type);
    if (message.type === "stream_event") {
      const inner = (message as unknown as { event?: { type?: unknown } })
        .event;
      if (inner?.type === "content_block_delta") deltas += 1;
    }
    // Injected on the tenth content delta of the first turn, which is the one point the
    // probe can be sure of: the model is producing output *now*. Injecting on the first
    // stream event instead — which an earlier run of this probe did — lands in the turn's
    // startup and measures the SDK's admission path rather than a live turn.
    if (injectedAfterDeltas === -1 && deltas >= 10) {
      injectedAfterDeltas = deltas;
      directiveUuid = send(DIRECTIVE, input.priority);
    }
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") text += block.text;
      }
    }
    if (message.type === "result") {
      const record = message as unknown as {
        subtype?: string;
        num_turns?: number;
        user_message_uuids?: readonly string[];
      };
      const uuids = record.user_message_uuids ?? [];
      results.push({
        subtype: record.subtype ?? "unknown",
        turns: record.num_turns ?? -1,
        consumed: uuids.length,
        namesDirective: uuids.includes(directiveUuid),
        text,
        at: Date.now() - startedAt,
      });
      text = "";
      // Read on for a second result rather than stopping at the first the way production
      // does: a second result *is* the finding when the driver queues rather than folds,
      // and production's `break` is exactly what would have hidden it.
      if (results.length >= 2) break;
      // 60 seconds for a second turn to begin. Long enough that a slow start is not read
      // as an absence, short enough that a folded directive does not cost four minutes.
      budget = 60_000;
    }
  }
  done = true;
  wake?.();
  (live as { close?: () => void }).close?.();

  return { results, types, injectedAfterDeltas, timedOut };
};

const claudeCodeLeg = Effect.fnUntraced(function* () {
  const workspace = join(RUNTIME_DIR, "steering-probe-claude-code");
  yield* Effect.sync(() => {
    mkdirSync(workspace, { recursive: true });
  });

  const results: LegResult[] = [];

  // ---- what our own seam does with a second prompt, verbatim ----
  heading("claude code — bit's own AgentHarness.prompt, called twice");
  const refusal = yield* Effect.result(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* AgentHarness;
        line("instance version", harness.instance.version);
        const session = yield* harness.createSession({
          title: "spike-a refusal",
          model: CLAUDE_CODE_DEFAULT_MODEL,
          directory: workspace,
        });
        yield* harness.prompt(session.id, SLOW_PROMPT);
        const again = yield* Effect.result(
          harness.prompt(session.id, DIRECTIVE),
        );
        // Stopped rather than waited out: the refusal is the measurement, and letting the
        // slow prompt run to completion would burn a minute of tokens for nothing.
        yield* Effect.result(harness.interruptSession(session.id));
        return again._tag === "Failure"
          ? `${again.failure._tag}: ${again.failure.detail}`
          : "accepted (no refusal)";
      }).pipe(Effect.provide(claudeCodeHarness())),
    ),
  );
  if (refusal._tag === "Failure") {
    line("verdict", "UNTESTED");
    line("why", String(refusal.failure));
    results.push({
      driver: "claude-code (bit's seam)",
      verdict: "UNTESTED",
      detail: String(refusal.failure),
    });
  } else {
    line("second prompt", refusal.success);
    results.push({
      driver: "claude-code (bit's seam)",
      verdict: refusal.success.startsWith("accepted") ? "ERROR" : "REFUSED",
      detail: refusal.success,
    });
  }

  // ---- what the driver does, measured on the bare SDK ----
  for (const priority of ["now", "later"] as const) {
    heading(`claude code — SDK, second message at priority '${priority}'`);
    const round = yield* Effect.result(
      Effect.tryPromise(() => claudeCodeQuery({ priority, workspace })),
    );
    if (round._tag === "Failure") {
      line("verdict", "UNTESTED");
      line("why", String(round.failure));
      results.push({
        driver: `claude-code (priority '${priority}')`,
        verdict: "UNTESTED",
        detail: String(round.failure),
      });
      continue;
    }
    const outcome = round.success;
    const first = outcome.results[0];
    const folded =
      first !== undefined && (first.namesDirective || first.consumed >= 2);
    const verdict: Verdict = outcome.timedOut
      ? "ERROR"
      : folded
        ? "INTERLEAVED"
        : outcome.results.length >= 2
          ? "QUEUED"
          : "ERROR";
    line("injected after deltas", outcome.injectedAfterDeltas);
    line("result messages", outcome.results.length);
    for (const [index, entry] of outcome.results.entries()) {
      line(
        `  result ${index + 1}`,
        `at=${entry.at}ms subtype=${entry.subtype} num_turns=${entry.turns} ` +
          `consumed=${entry.consumed} namesDirective=${entry.namesDirective} ` +
          `marker=${entry.text.includes(MARKER)} chars=${entry.text.length} ` +
          `countedTo=${highestCount(entry.text)}`,
      );
      line(
        `  result ${index + 1} tail`,
        JSON.stringify(entry.text.slice(-120)),
      );
    }
    line("verdict", verdict);
    console.log("  -- message types, in order --");
    console.log(`  ${outcome.types.join(" ")}`);
    results.push({
      driver: `claude-code (priority '${priority}')`,
      verdict,
      detail:
        `${outcome.results.length} result(s); ` +
        outcome.results
          .map(
            (entry, index) =>
              `#${index + 1} at=${entry.at}ms subtype=${entry.subtype} ` +
              `num_turns=${entry.turns} consumed=${entry.consumed} ` +
              `namesDirective=${entry.namesDirective} ` +
              `marker=${entry.text.includes(MARKER)} ` +
              `countedTo=${highestCount(entry.text)}`,
          )
          .join("; ") +
        (outcome.timedOut ? "; the first turn never produced a result" : ""),
    });
  }

  return results;
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
  mkdirSync(RUNTIME_DIR, { recursive: true });
  heading("spike A — mid-run prompt injection");
  line("drivers requested", process.argv.slice(2).join(" ") || "all");

  const verdicts: LegResult[] = [];
  if (WANTED.openCode) verdicts.push(...(yield* openCodeLeg()));
  if (WANTED.claudeCode) verdicts.push(...(yield* claudeCodeLeg()));

  heading("verdicts");
  for (const verdict of verdicts) {
    console.log(`  ${verdict.driver.padEnd(34)} ${verdict.verdict}`);
    console.log(`      ${verdict.detail}`);
  }
});

runMain(program);
