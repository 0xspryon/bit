/**
 * Real-SQLite tests for the detached planner round.
 *
 * The suite `run/supervisor.test.ts` is for an attempt, read for a round, and the claims
 * are the ones that are *different* rather than a second pass over the ones that are not:
 *
 * 1. **A start returns before the round finishes**, and what it returns is a round that is
 *    already durable, gated, sessioned, credentialed and prompted.
 * 2. **One round per goal, claimed before the fork.** Two starts in the same tick: one
 *    wins and the other is refused naming the round that holds the goal. This is the half
 *    `openRound`'s own check cannot make, because both fibers would be past it.
 * 3. **A refusal leaves nothing behind.** No goal claimed, and no row that says `running`.
 * 4. **Stop settles, revokes, unregisters and frees the goal** — all four read back from
 *    the row, the credential registry and the harness recorder rather than taken from the
 *    response.
 * 5. **Shutdown settles a round in flight**, read off the file after the runtime is gone.
 * 6. **The session is created in the gated planning directory**, which is not the
 *    workspace, and the gate goes in before the session exists.
 * 7. **The lineage** is opened by a goal's first round and continued by its second.
 *
 * The sweep's side of this — a round a dead process left `running`, reconciled to
 * `uncertain` with the goal freed — is in `recovery/reconcile.test.ts`, beside the attempt
 * sweep it is a sibling of.
 *
 * ## The harness is a fake, and the fake is the point
 *
 * What is under test is everything *around* the agent: what is claimed where, what the
 * round row says afterwards, which credential still resolves, which directory the session
 * was opened in. A real harness would make each of those wait on a model and a provider
 * login, and would make "the harness cannot answer" a state a test could not produce on
 * demand. What is **not** faked: the fleet, the target database, the credential registry,
 * the policy gate's own `gatedRoleDirectory`, and the supervisor itself. The round rows
 * these tests read are rows in a file on disk, which is why this suite is part of
 * `test:persistence`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Deferred,
  Effect,
  Fiber,
  Layer,
  Logger,
  ManagedRuntime,
  Redacted,
  Stream,
  type Duration,
} from "effect";

import {
  AgentHarness,
  type HarnessNarration,
  type TerminalOutcome,
} from "../harness/agentHarness";
import { HarnessTransportError } from "../harness/errors";
import { HarnessResolver } from "../harness/resolver";
import { stubHarness } from "../harness/stubHarness";
import { McpCredentials } from "../mcp/credentials";
import { McpCallCounter } from "../mcp/server";
import { FleetStore } from "../persistence/fleet";
import { ObservationStore, operatorScope } from "../persistence/store";
import { PolicyHookNotInstalled } from "../policy/install";
import { TargetStores, withTargetStore } from "../persistence/targetStores";
import { RunNarrations, type RunNarration } from "../run/narration";
import { WorkerEndpoints } from "../run/supervisor";
import {
  GoalBriefingTooLarge,
  buildGoalBriefing,
} from "../briefing/goalBriefing";
import {
  PlanSupervisor,
  roundStopReport,
  type PlanInput,
  type PlanRefused,
} from "./planSupervisor";
import { assembleRoundPrompt, roundPromptOverhead } from "./roundPrompt";
import { renderScopeBlock } from "../scope/scopePrompt";

const directories: string[] = [];
afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true });
  }
});

const newScratch = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "bit-plan-"));
  directories.push(directory);
  return directory;
};

/* ── The fake harness ────────────────────────────────────────────────────────── */

/** What one scripted session does, and what a test can watch it do. */
interface Script {
  /** Resolved by the test to let the long poll return. Fail it to break the poll. */
  readonly settle: Deferred.Deferred<void, HarnessTransportError>;
  /** Entries the narration stream emits, then it stays open until interrupted. */
  readonly narration: readonly HarnessNarration[];
  /** What `session.get` answers. `undefined` is "no outcome on the session". */
  readonly status: TerminalOutcome | undefined;
  /** When true, `session.get` fails: the harness cannot be asked at all. */
  readonly statusUnreachable?: boolean;
  /** When true, `prompt` fails, so the round is never watched. */
  readonly promptFails?: boolean;
  /**
   * When true, a **steer** fails while the opening prompt still succeeds.
   *
   * Separate from {@link promptFails}, which refuses both: a steer the harness will not
   * take is a state the round survives — it is live, it has a turn, and the directive
   * simply did not land — and the settlement afterwards is the thing under test.
   */
  readonly steerFails?: boolean;
  /**
   * When set, a **steer** into this session parks until it is resolved.
   *
   * The only way to drive the race DECISIONS.md §24.1 consequence 5 is about: a steer that
   * is already inside the supervisor's permit while a settlement arrives. Without a way to
   * hold the delivery open, the two can only be fired in sequence and the ordering claim is
   * untestable.
   */
  readonly steerGate?: Deferred.Deferred<void> | undefined;
  /** Resolved by the fake the moment a steer reaches it, before it parks on the gate. */
  readonly steerEntered?: Deferred.Deferred<void> | undefined;
}

interface Recorder {
  /**
   * Every call the supervisor made, in order, as `kind:detail`.
   *
   * One ordered list rather than a field per call, because the **order** is half of what
   * this suite asserts: the gate before the session, the session before the registration,
   * the registration before the prompt. Separate arrays could each be right while the
   * sequence between them was wrong.
   */
  readonly order: string[];
  readonly registrations: { name: string; url: string; bearer: string }[];
  /**
   * The text of every prompt sent, kept out of {@link order}.
   *
   * The prompt is a rendered goal briefing inside the round's framing, so it is thousands
   * of characters. In `order` it would make the sequence assertion unreadable and would
   * turn a test about *when* the prompt was sent into one about its wording.
   */
  readonly prompts: string[];
  /**
   * Every steer the supervisor delivered, with its urgency and derived message id.
   *
   * Separate from {@link prompts} because the two have different recovery rules at the
   * seam — an opening prompt is never resubmitted and a steer may be retried under the
   * same id — and a suite that could not tell them apart could not assert either.
   */
  readonly steers: {
    sessionId: string;
    text: string;
    urgency: "queued" | "preemptive";
    messageId: string;
  }[];
  readonly unregistrations: { sessionId: string; name: string }[];
  readonly interrupts: string[];
  /** The `parentSessionId` each `createSession` was handed, so lineage is checkable. */
  readonly parents: (string | undefined)[];
}

/**
 * A refusal narrowed to `PlanRefused`.
 *
 * `start`'s error channel is `PlanRefused | GoalBriefingTooLarge`: a goal briefing over
 * the ceiling is refused with the two numbers on it rather than flattened into a reason
 * that has nowhere to put them. Every assertion below but the ceiling's own is about the
 * first, so this narrows in one place and throws loudly on the other rather than every
 * site carrying its own tag check.
 */
const planRefused = (
  failure: PlanRefused | GoalBriefingTooLarge,
): PlanRefused => {
  if (failure._tag !== "PlanRefused") {
    throw new Error(
      `expected a PlanRefused, got ${failure._tag}: ${failure.message}`,
    );
  }
  return failure;
};

const emptyRecorder = (): Recorder => ({
  order: [],
  registrations: [],
  prompts: [],
  steers: [],
  unregistrations: [],
  interrupts: [],
  parents: [],
});

const transport = (operation: string, detail: string) =>
  new HarnessTransportError({
    operation,
    status: undefined,
    tag: "TestError",
    detail,
    cause: detail,
  });

/**
 * Failures to inject into the steps *after* the round row is written.
 *
 * A count rather than a flag, because the tests that need one need the **first** call to
 * fail and a later call to succeed: the claim being asserted is that the goal takes another
 * round afterwards, and a fault that applied to every call could not tell "the goal was
 * freed" from "the second attempt failed the same way".
 */
interface Faults {
  /** How many `installGate` calls fail with `PolicyHookNotInstalled` before one succeeds. */
  readonly gate?: number;
  /** How many `createSession` calls fail with a transport error before one succeeds. */
  readonly createSession?: number;
  /**
   * How many `installGate` calls **die** before one succeeds.
   *
   * A defect, not a typed failure, and the distinction is the whole point of the test that
   * uses it: `Effect.result` absorbs the second and not the first, so a defect used to
   * reach the finalizer with `ending` still at its `stopped` default and be written down as
   * `interrupted`.
   */
  readonly gateDefect?: number;
}

const fakeClient = (
  scriptFor: (sessionId: string) => Script,
  recorder: Recorder,
  faults: Faults = {},
): Layer.Layer<AgentHarness> => {
  let gateFailures = faults.gate ?? 0;
  let gateDefects = faults.gateDefect ?? 0;
  let createFailures = faults.createSession ?? 0;
  /**
   * The sessions this fake actually created.
   *
   * `sessionStatus` answers from the script only for these. Without it the fake would
   * cheerfully report an outcome for a session `createSession` had just refused to make,
   * which is the one answer a real harness certainly does not give — it 404s — and it
   * would have let a strand test pass for the wrong reason.
   */
  const created = new Set<string>();
  return Layer.succeed(
    AgentHarness,
    stubHarness({
      // Records the directory it was asked to gate and writes nothing. The gate has its
      // own suite (`policy/install.test.ts`), and what this suite is about is *which*
      // directory the supervisor routed through it, and when.
      installGate: (input) =>
        Effect.suspend(() => {
          if (gateDefects > 0) {
            gateDefects -= 1;
            // `die`, not `fail`: this is the shape of a bug in a seam — a thrown
            // `TypeError`, a broken invariant — rather than an outcome the supervisor
            // declared it could receive.
            return Effect.die(
              new Error("scripted: the gate installer has a bug"),
            );
          }
          if (gateFailures > 0) {
            gateFailures -= 1;
            return Effect.fail(
              new PolicyHookNotInstalled({
                workspace: input.workspace,
                detail: "scripted: this directory's gate will not install",
              }),
            );
          }
          recorder.order.push(`gate:${input.workspace}`);
          return Effect.void;
        }),
      createSession: (input) =>
        Effect.suspend(() => {
          if (createFailures > 0) {
            createFailures -= 1;
            return Effect.fail(
              transport(
                "session.create",
                "scripted: the harness is unreachable",
              ),
            );
          }
          const id = input.sessionId ?? "ses_chosen_by_harness";
          created.add(id);
          recorder.order.push(`create:${input.directory}`);
          recorder.parents.push(input.parentSessionId);
          return Effect.succeed({ id });
        }),
      registerMcpServer: (_sessionId, name, config) =>
        Effect.sync(() => {
          recorder.order.push(`register:${name}`);
          recorder.registrations.push({
            name,
            url: config.url,
            bearer: Redacted.value(
              config.headers["authorization"] ?? Redacted.make(""),
            ),
          });
        }),
      unregisterMcpServer: (sessionId, name) =>
        Effect.sync(() => {
          recorder.unregistrations.push({ sessionId, name });
        }),
      prompt: (sessionId, text, delivery = { _tag: "open" as const }) =>
        scriptFor(sessionId).promptFails === true
          ? Effect.fail(transport("session.prompt", "the harness refused it"))
          : delivery._tag === "steer"
            ? Effect.gen(function* () {
                const script = scriptFor(sessionId);
                if (script.steerFails === true) {
                  return yield* Effect.fail(
                    transport(
                      "session.prompt",
                      "the harness would not take it",
                    ),
                  );
                }
                if (script.steerEntered !== undefined) {
                  yield* Deferred.succeed(script.steerEntered, undefined);
                }
                // Parked inside the supervisor's permit, which is the whole point: a
                // settlement arriving now has to wait behind this rather than race it.
                if (script.steerGate !== undefined) {
                  yield* Deferred.await(script.steerGate);
                }
                // In `order` as well as in `steers`, so a test can assert that the
                // settlement's interrupt came *after* the delivery rather than merely that
                // both happened.
                recorder.order.push("steer");
                recorder.steers.push({
                  sessionId,
                  text,
                  urgency: delivery.urgency,
                  messageId: delivery.messageId,
                });
                return { delivered: true };
              })
            : Effect.sync(() => {
                // The text is recorded separately from the order, because the prompt is
                // a rendered goal briefing wrapped in the round's framing — thousands of
                // characters — and an order assertion carrying it would be unreadable and
                // would be about the wording rather than the sequence.
                recorder.order.push("prompt");
                recorder.prompts.push(text);
                return { delivered: true };
              }),
      waitForIdle: (sessionId) => Deferred.await(scriptFor(sessionId).settle),
      sessionStatus: (sessionId) => {
        if (!created.has(sessionId)) {
          return Effect.fail(
            transport(
              "session.get",
              `no session ${sessionId} was ever created`,
            ),
          );
        }
        const script = scriptFor(sessionId);
        return script.statusUnreachable === true
          ? Effect.fail(transport("session.get", "the harness is unreachable"))
          : Effect.succeed(
              // `idle` either way: a supervisor asks this at settlement, after
              // `waitForIdle` has returned, so the session it asks about is never mid-turn.
              // A script with no status is a harness that stated no outcome, which is the
              // `uncertain` path — not a live turn.
              script.status === undefined
                ? { activity: "idle" as const }
                : { activity: "idle" as const, outcome: script.status },
            );
      },
      interruptSession: (sessionId) =>
        Effect.andThen(
          Effect.sync(() => {
            recorder.order.push("interrupt");
            recorder.interrupts.push(sessionId);
          }),
          Effect.succeed(true),
        ),
      sessionEvents: (sessionId) =>
        // Stays open after the scripted entries, like a real subscription does: it ends
        // when the consuming fiber is interrupted and not before.
        Stream.concat(
          Stream.fromIterable(scriptFor(sessionId).narration),
          Stream.never,
        ),
    }),
  );
};

/** The scripts a test wires in, with a settle gate per session created on demand. */
const scripts = (defaults: Omit<Script, "settle">) => {
  const held = new Map<string, Script>();
  const scriptFor = (sessionId: string): Script => {
    const existing = held.get(sessionId);
    if (existing !== undefined) return existing;
    const made: Script = {
      ...defaults,
      settle: Deferred.makeUnsafe<void, HarnessTransportError>(),
    };
    held.set(sessionId, made);
    return made;
  };
  /** Lets the long poll for one session return. Keyed, never by iteration: see below. */
  const release = (sessionId: string): Effect.Effect<void> =>
    Effect.asVoid(Deferred.succeed(scriptFor(sessionId).settle, undefined));
  /**
   * Lets every poll the supervisor has actually opened return.
   *
   * Only for teardown, where the point is to let a runtime close without interrupting a
   * live round — not to drive a settlement a test then asserts on. Iterating is safe here
   * precisely because nothing is waiting on the result.
   */
  const releaseAll = (): Effect.Effect<void> =>
    Effect.forEach(
      [...held.values()],
      (script) => Deferred.succeed(script.settle, undefined),
      { discard: true },
    );
  return { scriptFor, held, release, releaseAll };
};

/* ── The world under test ────────────────────────────────────────────────────── */

const TARGET = "alpha";

/**
 * A fleet with one target registered and swept, and a plan supervisor over it.
 *
 * A real `FleetStore`, because the planning directory this suite is about is laid out by
 * the registry and by nothing else — a resolver holding a path would be the one thing the
 * slice-3 boundary exists to prevent.
 */
const world = (
  scriptFor: (sessionId: string) => Script,
  recorder: Recorder,
  options?: {
    readonly askTimeout?: Duration.Input | undefined;
    readonly budget?: number | undefined;
    /** A resolver that is not the one harness in context, for the refusal paths. */
    readonly resolver?: Layer.Layer<HarnessResolver> | undefined;
    /** Failures to inject into the steps after the row is written. See {@link Faults}. */
    readonly faults?: Faults | undefined;
  },
) => {
  const scratch = newScratch();
  const root = join(scratch, "fleet");
  // Outside the fleet root, like a real engagement's folder: the containment check in
  // `gatedRoleDirectory` refuses a planning directory inside the workspace, and a test
  // whose workspace *was* the fleet root would be asserting against a layout nobody has.
  const workspace = join(scratch, "work");
  mkdirSync(workspace, { recursive: true });

  const fleet = FleetStore.layer(root);
  const stores = TargetStores.layer.pipe(Layer.provide(fleet));
  const credentials = McpCredentials.layer;
  /**
   * The real counter, not a stub.
   *
   * The supervisor reads it at settlement to say whether a round reached its tool surface,
   * and a stub returning a fixed number would make that assertion about the stub. This is
   * the same service the MCP middleware increments in production, and a test drives it the
   * way the middleware does — by calling `increment` for the round's own caller scope.
   */
  const calls = McpCallCounter.layer;
  /**
   * The real narration bus, merged in rather than hidden under the supervisor.
   *
   * A round publishes its narration onto this (slice 8's planner chat is the subscriber),
   * and a test that wanted to assert the publishing had to be able to subscribe to the same
   * instance. `Layer.provide` would have made it the supervisor's private dependency, which
   * is the shape that let the attempt supervisor's bus be a publisher with no reachable
   * subscriber.
   */
  const narrations = RunNarrations.layer;
  /**
   * Every log line this world wrote, so a test can assert on one.
   *
   * The only way to check a claim whose whole content *is* a log line — the settlement's
   * report that it could not read its own round, which was previously discarded in silence.
   * `mergeWithExisting` is deliberately off: the suite's output is noisy enough without
   * every line twice, and nothing here asserts on the console.
   */
  const logged: { level: string; message: string }[] = [];
  const logging = Logger.layer([
    Logger.make<unknown, void>((entry) => {
      logged.push({
        level: String(entry.logLevel),
        message: Array.isArray(entry.message)
          ? entry.message.map((part) => String(part)).join(" ")
          : String(entry.message),
      });
    }),
  ]);
  const layer = Layer.mergeAll(
    logging,
    fleet,
    stores,
    credentials,
    calls,
    narrations,
    PlanSupervisor.layerWith({
      ...(options?.askTimeout === undefined
        ? {}
        : { askTimeout: options.askTimeout }),
      ...(options?.budget === undefined ? {} : { budget: options.budget }),
    }).pipe(
      Layer.provide(logging),
      Layer.provide(options?.resolver ?? HarnessResolver.single),
      Layer.provide(fakeClient(scriptFor, recorder, options?.faults ?? {})),
      Layer.provide(stores),
      Layer.provide(fleet),
      Layer.provide(credentials),
      Layer.provide(calls),
      Layer.provide(narrations),
      Layer.provide(
        Layer.succeed(
          WorkerEndpoints,
          WorkerEndpoints.of({
            urls: Effect.succeed({
              mcp: "http://127.0.0.1:9/api/v1/mcp",
              plannerMcp: "http://127.0.0.1:9/api/v1/planner/mcp",
              goalMcp: "http://127.0.0.1:9/api/v1/goal/mcp",
              importerMcp: "http://127.0.0.1:9/api/v1/importer/mcp",
              policy: "http://127.0.0.1:9/api/v1/policy/decide",
            }),
          }),
        ),
      ),
    ),
  );
  const runtime = ManagedRuntime.make(layer);
  const ready = runtime.runPromise(
    Effect.gen(function* () {
      const registry = yield* FleetStore;
      yield* registry.register({
        targetId: TARGET,
        name: TARGET,
        scopeNote: "the local fixture only",
        workspacePath: workspace,
      });
      yield* registry.migrateFleet();
    }).pipe(Effect.orDie),
  );
  /**
   * The credential registry as a value, so a test can read it after `dispose()`.
   *
   * The service is a closure over a plain `Map`, so `resolve` keeps answering once the
   * layer's scope is gone — which is the only way to assert that a shutdown revoked what
   * it was supposed to.
   */
  const registry = runtime.runPromise(Effect.map(McpCredentials, (it) => it));
  return { root, workspace, runtime, ready, registry, logged };
};

/** A goal, made the way an operator makes one, and the round input that names it. */
const goal = (
  root: string,
  workspace: string,
  goalId: string,
  objective = "Work out whether the login limiter can be bypassed.",
) =>
  Effect.gen(function* () {
    const stores = yield* TargetStores;
    yield* withTargetStore(stores, TARGET, (store) =>
      store.openGoal(
        { callerScope: operatorScope(TARGET), targetId: TARGET },
        {
          operationId: `op_${goalId}`,
          goalId,
          name: "",
          description: objective,
        },
      ),
    ).pipe(Effect.orDie);
    return {
      targetId: TARGET,
      goalId,
      workspace,
      // Inside the target's own `evidence/`, which is a sibling of `planning/` — so it is
      // outside the directory it records, which `gatedRoleDirectory` checks rather than
      // trusts.
      auditPath: join(root, "targets", TARGET, "evidence", "policy-audit.log"),
      title: `bit planner: ${goalId}`,
    } satisfies PlanInput;
  });

/** One target's rows, read straight off the file after the runtime is gone. */
const readAfterShutdown = (root: string) => {
  const database = new Database(join(root, "targets", TARGET, "hunt.sqlite"), {
    readonly: true,
  });
  try {
    return {
      rounds: database
        .query<
          {
            id: string;
            goal_id: string;
            status: string;
            write_fence: number;
            budget: number;
            disposition: string | null;
            ended_at: number | null;
          },
          []
        >(
          "SELECT id, goal_id, status, write_fence, budget, disposition, ended_at FROM planner_rounds ORDER BY started_at",
        )
        .all(),
      events: database
        .query<{ kind: string; subject_id: string; payload: string }, []>(
          "SELECT kind, subject_id, payload FROM events WHERE kind LIKE 'plan.round.%' ORDER BY sequence",
        )
        .all(),
      lineages: database
        .query<{ goal_id: string; harness_session_id: string }, []>(
          "SELECT goal_id, harness_session_id FROM planner_lineages",
        )
        .all(),
    };
  } finally {
    database.close();
  }
};

/* ── Small waits on state, rather than on the clock ──────────────────────────── */

/**
 * Polls one effect until a predicate holds.
 *
 * `run/supervisor.test.ts`'s helper, for its reason: what is being waited for is a
 * *consequence* of a fiber the test does not own — a round's finalizer finishing — and
 * there is no handle to await. Bounded, so a broken expectation fails the test instead of
 * hanging the suite.
 */
const waitFor = <A, R>(
  read: Effect.Effect<A, never, R>,
  holds: (value: A) => boolean,
  attempts = 400,
): Effect.Effect<A, never, R> =>
  Effect.gen(function* () {
    for (let index = 0; index < attempts; index += 1) {
      const value = yield* read;
      if (holds(value)) return value;
      yield* Effect.sleep("5 millis");
    }
    return yield* read;
  });

/**
 * Waits until one round's **row** has left `running`.
 *
 * The row rather than `running`, deliberately. The finalizer removes its entry from the
 * in-memory map and releases the goal *before* it writes the settlement, so a barrier on
 * `PlanSupervisor.running` would be satisfied while the write was still in flight — and
 * every assertion after it would be racing a transaction. Waiting on the row is therefore
 * also the stronger barrier: by the time it holds, the claim is already back.
 */
/**
 * Waits until this target holds **no** round row that says `running`.
 *
 * The barrier for a start that was *refused* after its row was written: the caller never
 * learns the round id, because the refusal is all it gets, so there is nothing to name in
 * {@link awaitSettled}. It reads through `roundsLeftRunning`, which is the same statement
 * the startup sweep uses — so this also runs that SQL against a real file from this suite.
 */
const awaitNoRunningRound = (): Effect.Effect<void, never, TargetStores> =>
  Effect.asVoid(
    waitFor(
      Effect.flatMap(TargetStores, (stores) =>
        withTargetStore(stores, TARGET, (store) =>
          store.roundsLeftRunning(),
        ).pipe(Effect.orDie),
      ),
      (rows) => rows.length === 0,
    ),
  );

const awaitSettled = (
  roundId: string,
): Effect.Effect<void, never, TargetStores> =>
  Effect.asVoid(
    waitFor(
      Effect.flatMap(TargetStores, (stores) =>
        withTargetStore(stores, TARGET, (store) =>
          store.loadRound(roundId),
        ).pipe(Effect.orDie),
      ),
      (row) => row !== undefined && row.status !== "running",
    ),
  );

/* ── The prompt, and the ceiling that refuses a round before it starts ───────── */

describe("the prompt a round is opened with", () => {
  test("carries the goal briefing verbatim, and reports both lengths", async () => {
    const recorder = emptyRecorder();
    const { scriptFor } = scripts({ narration: [], status: undefined });
    const { root, workspace, runtime, ready } = world(scriptFor, recorder, {
      budget: 4,
    });
    await ready;

    const started = await runtime.runPromise(
      Effect.gen(function* () {
        const input = yield* goal(root, workspace, "goal_prompt");
        const planner = yield* PlanSupervisor;
        return yield* planner.start(input);
      }).pipe(Effect.orDie),
    );

    expect(recorder.prompts).toHaveLength(1);
    const prompt = recorder.prompts[0] ?? "";

    // The briefing is pasted in whole and nothing is inserted into it, which is what lets
    // the briefing panel claim it shows the same bytes the planner gets.
    const briefing = await runtime.runPromise(
      Effect.flatMap(TargetStores, (stores) =>
        withTargetStore(stores, TARGET, (store) =>
          buildGoalBriefing("goal_prompt").pipe(
            Effect.provideService(ObservationStore, store),
          ),
        ),
      ).pipe(Effect.orDie),
    );
    expect(prompt.endsWith(briefing.rendered)).toBe(true);
    expect(prompt).toContain(
      "Work out whether the login limiter can be bypassed.",
    );

    // **`sizeChars` bounds the briefing, not the prompt**, and the two numbers say so
    // rather than leaving it to be inferred. The difference is exactly the framing, which
    // is what `roundPromptOverhead` computes.
    expect(started.briefingChars).toBe(briefing.rendered.length);
    expect(started.promptChars).toBe(prompt.length);
    expect(started.promptChars).toBeGreaterThan(started.briefingChars);
    expect(started.promptChars - started.briefingChars).toBe(
      roundPromptOverhead({ goalId: "goal_prompt", budget: 4 }),
    );

    // The budget the round was opened under is in the text, because it is the one fact
    // about *this* round a planner cannot read out of the graph.
    expect(prompt).toContain("at most 4 intent(s)");
    // And the disposition is demanded rather than suggested.
    expect(prompt).toContain("THIS IS NOT OPTIONAL");
  });

  test("carries the authorized scope, above the briefing and outside its ceiling", async () => {
    const recorder = emptyRecorder();
    const { scriptFor } = scripts({ narration: [], status: undefined });
    const { root, workspace, runtime, ready } = world(scriptFor, recorder, {
      budget: 4,
    });
    await ready;

    const started = await runtime.runPromise(
      Effect.gen(function* () {
        const input = yield* goal(root, workspace, "goal_scope");
        // Authored before the round is opened, which is the only order that matters: the
        // block is a point-in-time copy taken when the prompt is fixed.
        yield* Effect.flatMap(TargetStores, (stores) =>
          withTargetStore(stores, TARGET, (store) =>
            Effect.gen(function* () {
              const caller = {
                callerScope: operatorScope(TARGET),
                targetId: TARGET,
              };
              yield* store.addScopeEntry(caller, {
                effect: "in",
                kind: "subtree",
                value: "acme.test",
                source: "operator",
              });
              yield* store.addScopeEntry(caller, {
                effect: "out",
                kind: "host",
                value: "blog.acme.test",
                source: "operator",
              });
            }),
          ),
        ).pipe(Effect.orDie);
        const planner = yield* PlanSupervisor;
        return yield* planner.start(input);
      }).pipe(Effect.orDie),
    );

    const prompt = recorder.prompts[0] ?? "";

    // The round is told the scope, which it never was before this slice.
    expect(prompt).toContain("[Authorized testing scope — highest priority]");
    expect(prompt).toContain("acme.test and every subdomain");
    expect(prompt).toContain("blog.acme.test (that host only)");
    // The planner's variant: it cannot call `record_asset`, so it is not told to.
    expect(prompt).not.toContain("record_asset");
    expect(prompt).toContain("does not grant authorization");

    /*
     * **Above the briefing, and the briefing's bytes are unchanged.**
     *
     * The briefing is appended verbatim so the briefing panel can claim it shows the same
     * bytes the planner received. The block goes in the preamble for exactly that reason,
     * and these two assertions are what keep the claim true: the prompt still *ends* with
     * the briefing, and the block appears before it.
     */
    const briefing = await runtime.runPromise(
      Effect.flatMap(TargetStores, (stores) =>
        withTargetStore(stores, TARGET, (store) =>
          buildGoalBriefing("goal_scope").pipe(
            Effect.provideService(ObservationStore, store),
          ),
        ),
      ).pipe(Effect.orDie),
    );
    expect(prompt.endsWith(briefing.rendered)).toBe(true);
    expect(briefing.rendered).not.toContain("Authorized testing scope");
    expect(prompt.indexOf("[Authorized testing scope")).toBeLessThan(
      prompt.indexOf("THE RECORD FOLLOWS"),
    );

    /*
     * **The block is outside the briefing ceiling, and the overhead accounts for it.**
     *
     * `briefingChars` is unchanged by the block — it bounds the briefing and the block is
     * not part of it — while `promptChars` grew. `roundPromptOverhead` is what makes that
     * checkable rather than a sentence in a comment, and it now takes the block.
     */
    expect(started.briefingChars).toBe(briefing.rendered.length);
    expect(started.promptChars).toBe(prompt.length);
    const scopeBlock = renderScopeBlock({
      scope: {
        entries: [
          {
            entryId: "ignored",
            targetId: TARGET,
            effect: "in",
            kind: "subtree",
            value: "acme.test",
            source: "operator",
            note: null,
            createdAt: 0,
          },
          {
            entryId: "ignored-2",
            targetId: TARGET,
            effect: "out",
            kind: "host",
            value: "blog.acme.test",
            source: "operator",
            note: null,
            createdAt: 0,
          },
        ],
        hostLabels: [],
        assetLabels: [],
      },
      audience: "planner",
    });
    expect(started.promptChars - started.briefingChars).toBe(
      roundPromptOverhead({
        goalId: "goal_scope",
        budget: 4,
        scopeBlock,
      }),
    );
    // And the figure genuinely moved: an overhead computed without the block would now be
    // wrong, which is the regression this guards.
    expect(
      roundPromptOverhead({ goalId: "goal_scope", budget: 4 }),
    ).toBeLessThan(
      roundPromptOverhead({ goalId: "goal_scope", budget: 4, scopeBlock }),
    );
  });

  test("tells the planner what to do if its tools have not reached it yet", async () => {
    // DECISIONS.md §24.2 caveat 1: an OpenCode registration can be connected and not yet
    // callable — in 3 of 8 first prompts after a registration the model reported the tool
    // was not exposed and the endpoint saw no call — and there is **no API to read that
    // registry**, so a round cannot confirm exposure before prompting. The prompt is never
    // resubmitted either. So the round tolerates a first-turn absence deliberately: the
    // planner is told to say so and stop rather than to improvise in prose, which leaves a
    // round an operator can simply run again.
    const assembled = assembleRoundPrompt({
      goalId: "goal_x",
      budget: 5,
      briefing: "",
    });
    expect(assembled.prompt).toContain("IF YOUR TOOLS ARE NOT THERE");
    expect(assembled.prompt).toContain("a known timing fault in the harness");
    expect(assembled.prompt).toContain(
      "Say plainly that the planner tools\nwere not available and stop",
    );
    expect(assembled.prompt).toContain("prose is not\na record");
    // Never told to retry: a resubmitted prompt would mint fresh operation ids and commit
    // a second set of intents that `add_intent`'s receipts could not recognise as a replay.
    expect(assembled.prompt).not.toContain("try again");
  });

  test("a briefing over the ceiling refuses the round and starts nothing", async () => {
    const recorder = emptyRecorder();
    const { scriptFor } = scripts({ narration: [], status: undefined });
    const { root, workspace, runtime, ready } = world(scriptFor, recorder, {
      budget: 5,
    });
    await ready;

    const refused = await runtime.runPromise(
      Effect.gen(function* () {
        const input = yield* goal(root, workspace, "goal_huge");
        const planner = yield* PlanSupervisor;
        // A ceiling of one character, so the shortest possible briefing is over it. The
        // alternative — writing 320 000 characters of observations — would test the same
        // branch and take a second to set up.
        return yield* Effect.result(
          planner.start({ ...input, briefingMaxChars: 1 }),
        );
      }),
    );

    expect(refused._tag).toBe("Failure");
    if (refused._tag !== "Failure") return;
    const failure = refused.failure;
    // **Not a `PlanRefused`**: it carries two numbers no reason on that error has a place
    // for, and it is the same error the goal-briefing route turns into the
    // `GoalBriefingRefused` the panel renders — so an operator meets one refusal for one
    // fact whichever surface they hit it on.
    expect(failure._tag).toBe("GoalBriefingTooLarge");
    if (failure._tag !== "GoalBriefingTooLarge") return;
    expect(failure.maxChars).toBe(1);
    expect(failure.sizeChars).toBeGreaterThan(1);
    expect(failure.goalId).toBe("goal_huge");

    // **Started nothing**, which is the requirement and the reason the briefing is built
    // before the goal is claimed: no row, no directory, no session, no registration, no
    // prompt. A row would have blocked every later round on this goal until a sweep.
    expect(recorder.order).toEqual([]);
    expect(recorder.registrations).toEqual([]);
    expect(recorder.prompts).toEqual([]);
    const rows = await runtime.runPromise(
      Effect.flatMap(TargetStores, (stores) =>
        withTargetStore(stores, TARGET, (store) =>
          store.roundsForGoal("goal_huge"),
        ),
      ).pipe(Effect.orDie),
    );
    expect(rows).toEqual([]);

    // And the goal is free: a second start on it is not refused `goal_busy`, which it
    // would be if the claim had leaked.
    const after = await runtime.runPromise(
      Effect.gen(function* () {
        const input = yield* goal(root, workspace, "goal_huge");
        const planner = yield* PlanSupervisor;
        return yield* Effect.result(planner.start(input));
      }),
    );
    expect(after._tag).toBe("Success");
  });

  test("a goal this target does not hold is refused goal_not_found, from the briefing read", async () => {
    const recorder = emptyRecorder();
    const { scriptFor } = scripts({ narration: [], status: undefined });
    const { root, workspace, runtime, ready } = world(scriptFor, recorder, {});
    await ready;

    const refused = await runtime.runPromise(
      Effect.gen(function* () {
        const planner = yield* PlanSupervisor;
        return yield* Effect.result(
          planner.start({
            targetId: TARGET,
            goalId: "goal_absent",
            workspace,
            auditPath: join(
              root,
              "targets",
              TARGET,
              "evidence",
              "policy-audit.log",
            ),
            title: "bit planner: absent",
          }),
        );
      }),
    );

    expect(refused._tag).toBe("Failure");
    if (refused._tag !== "Failure") return;
    // Reported from the briefing read rather than from `openRound`, because the briefing
    // is now built first — the same fact, the same reason, one step earlier.
    expect(planRefused(refused.failure).reason).toBe("goal_not_found");
    expect(recorder.order).toEqual([]);
  });
});

/* ── Starting a round ────────────────────────────────────────────────────────── */

describe("opening a planner round", () => {
  test("returns while the round is still going, with everything already in place", async () => {
    const recorder = emptyRecorder();
    const { scriptFor, releaseAll } = scripts({
      narration: [],
      status: undefined,
    });
    const { root, workspace, runtime, ready, registry } = world(
      scriptFor,
      recorder,
      { budget: 7 },
    );
    await ready;

    const started = await runtime.runPromise(
      Effect.gen(function* () {
        const input = yield* goal(root, workspace, "goal_one");
        const planner = yield* PlanSupervisor;
        return yield* planner.start(input);
      }).pipe(Effect.orDie),
    );

    // The long poll has not returned, so the round is still going — and the start call has
    // already answered. That is the whole shape of this module.
    const running = await runtime.runPromise(
      Effect.flatMap(PlanSupervisor, (planner) => planner.running),
    );
    expect(running).toEqual([
      {
        roundId: started.roundId,
        targetId: TARGET,
        goalId: "goal_one",
        harnessSessionId: started.harnessSessionId,
        startedAt: started.startedAt,
      },
    ]);
    expect(started.budget).toBe(7);
    expect(started.lineage).toBe("opened");

    // Gate, then session, then registration, then prompt. The order is the claim: a
    // session created before its directory was gated is an ungated planner, and a prompt
    // sent before the registration is a planner with no endpoint to call.
    const planning = join(root, "targets", TARGET, "planning", started.roundId);
    expect(recorder.order).toEqual([
      `gate:${planning}`,
      `create:${planning}`,
      `register:bit-${started.roundId}`,
      // The real prompt now: the round's framing with the goal briefing pasted in. The
      // assertion rebuilds it from the same assembler rather than restating the text,
      // because what is being checked here is the *order* — gate, session, registration,
      // then prompt — and a literal would make this test about the wording.
      "prompt",
    ]);
    // Never the workspace. Under OpenCode the directory is the authority boundary
    // (DECISIONS.md §24.2), so a planner session in the workers' folder would see every
    // `bit-<attemptId>` registered there.
    expect(recorder.order.some((entry) => entry.includes(workspace))).toBe(
      false,
    );

    // The credential the harness was handed resolves to a *round* grant for this round,
    // and the bearer is the registration's only carrier of it.
    const registration = recorder.registrations[0];
    expect(registration?.name).toBe(`bit-${started.roundId}`);
    const bearer = (registration?.bearer ?? "").replace("Bearer ", "");
    const credentials = await registry;
    const grant = await runtime.runPromise(credentials.resolve(bearer));
    expect(grant?._tag).toBe("round");
    expect(grant).toMatchObject({
      targetId: TARGET,
      goalId: "goal_one",
      roundId: started.roundId,
      roundFence: 0,
      callerScope: `${TARGET}/round/${started.roundId}`,
    });
    // A round credential always carries a clock expiry; only a goal's may be without one.
    expect(typeof (grant?.expiresAt ?? null)).toBe("number");

    await runtime.runPromise(releaseAll());
    await runtime.dispose();

    const rows = readAfterShutdown(root);
    expect(rows.rounds).toHaveLength(1);
    expect(rows.rounds[0]).toMatchObject({
      id: started.roundId,
      goal_id: "goal_one",
      budget: 7,
      // Nothing recorded a disposition: there are no tools yet, and settlement never
      // invents the planner's answer.
      disposition: null,
    });
    expect(rows.events.map((event) => event.kind)).toEqual([
      "plan.round.started",
      "plan.round.settled",
    ]);
    expect(
      rows.events.every((event) => event.subject_id === started.roundId),
    ).toBe(true);
    // The goal's first round opened its lineage, recorded against the session it created.
    expect(rows.lineages).toEqual([
      { goal_id: "goal_one", harness_session_id: started.harnessSessionId },
    ]);
  });

  test("a round's narration reaches the bus under the round, with no attempt on it", async () => {
    /*
     * The widening slice 8 needed, and the one thing a planner chat cannot do without.
     *
     * Before this, a round's harness stream was drained only so a terminal
     * `session.execution.*` could be read off it, and the entries were thrown away: the bus
     * was keyed by attempt id and a round has no attempt. Now the subject is tagged, so an
     * entry published under a round is reachable by a subscriber filtering on it — which is
     * exactly what the live transcript does on its way to the browser.
     *
     * Publishing is still not persisting. An entry published with nobody listening is gone;
     * this test subscribes first, which is why the subscription is established before the
     * round is started and not after.
     */
    const recorder = emptyRecorder();
    const { scriptFor, releaseAll } = scripts({
      narration: [
        {
          type: "session.text.ended",
          sequence: 1,
          at: 1_700_000_000_000,
          outcome: undefined,
          detail: { _tag: "reply", text: "two dimensions are untested" },
        },
      ],
      status: undefined,
    });
    const { root, workspace, runtime, ready } = world(scriptFor, recorder);
    await ready;

    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const narrations = yield* RunNarrations;
        const collected = yield* Effect.forkChild(
          Stream.runCollect(
            Stream.take(narrations.subscribe({ targetId: TARGET }), 1),
          ),
        );
        // The bus replays nothing, so the subscription has to exist before the round is
        // prompted. `subscriberCount` moves after `PubSub.subscribe` returns, which is what
        // makes it usable as a readiness signal rather than a guess.
        yield* Effect.timeout(
          Effect.gen(function* () {
            while ((yield* narrations.subscriberCount) === 0) {
              yield* Effect.sleep("5 millis");
            }
          }),
          "10 seconds",
        );
        const input = yield* goal(root, workspace, "goal_one");
        const planner = yield* PlanSupervisor;
        const started = yield* planner.start(input);
        const received: readonly RunNarration[] = yield* Fiber.join(collected);
        return { started, received };
      }).pipe(Effect.orDie),
    );

    expect(observed.received).toHaveLength(1);
    const entry = observed.received[0];
    expect(entry?.targetId).toBe(TARGET);
    // Under the round, not under an attempt — and not under the goal: a goal's narration is
    // several rounds' worth, and the chat groups by the thing the records can corroborate.
    expect(entry?.subject).toEqual({
      _tag: "round",
      roundId: observed.started.roundId,
    });
    expect(entry?.harnessSessionId).toBe(observed.started.harnessSessionId);
    expect(entry?.entry.detail).toEqual({
      _tag: "reply",
      text: "two dimensions are untested",
    });

    await runtime.runPromise(releaseAll());
    await runtime.dispose();
  });

  test("two starts on one goal: one wins, the other is refused naming the holder", async () => {
    const recorder = emptyRecorder();
    const { scriptFor, releaseAll } = scripts({
      narration: [],
      status: undefined,
    });
    const { root, workspace, runtime, ready } = world(scriptFor, recorder);
    await ready;

    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const input = yield* goal(root, workspace, "goal_one");
        const planner = yield* PlanSupervisor;
        // Both in the same tick. This is the case `openRound`'s own check cannot refuse:
        // each fiber would be inside `startHalf` before the other had written a row, so
        // both would pass the store's "is a round already running on this goal" query.
        // What refuses one of them is the synchronous claim taken before either forks.
        return yield* Effect.all(
          [
            Effect.result(planner.start(input)),
            Effect.result(planner.start(input)),
          ],
          { concurrency: 2 },
        );
      }).pipe(Effect.orDie),
    );

    const wins = outcome.filter((result) => result._tag === "Success");
    const refusals = outcome.filter((result) => result._tag === "Failure");
    expect(wins).toHaveLength(1);
    expect(refusals).toHaveLength(1);
    const refused = refusals[0];
    if (refused?._tag !== "Failure") throw new Error("expected a refusal");
    expect(planRefused(refused.failure).reason).toBe("goal_busy");
    // Named, not merely refused: a second browser tab's operator has to be told which
    // round is holding the goal (the spec's §5, condition 3).
    const winner = wins[0];
    if (winner?._tag !== "Success") throw new Error("expected a start");
    expect(planRefused(refused.failure).detail).toContain(
      winner.success.roundId,
    );
    expect(planRefused(refused.failure).detail).toContain("goal_one");

    // And the refusal wrote nothing: one row, one session, one registration.
    expect(recorder.registrations).toHaveLength(1);

    await runtime.runPromise(releaseAll());
    await runtime.dispose();
    expect(readAfterShutdown(root).rounds).toHaveLength(1);
  });

  test("a second round on the same goal is accepted once the first has settled", async () => {
    const recorder = emptyRecorder();
    const { scriptFor, release } = scripts({
      narration: [],
      status: "succeeded",
    });
    const { root, workspace, runtime, ready } = world(scriptFor, recorder);
    await ready;

    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const input = yield* goal(root, workspace, "goal_one");
        const planner = yield* PlanSupervisor;
        const first = yield* planner.start(input);
        // Settles the first round by letting its long poll return, then waits for its row
        // to leave `running` — which is also the moment the goal claim is back.
        yield* release(first.harnessSessionId);
        yield* awaitSettled(first.roundId);
        const second = yield* planner.start(input);
        yield* release(second.harnessSessionId);
        yield* awaitSettled(second.roundId);
        return { first, second };
      }).pipe(Effect.orDie),
    );

    expect(outcome.second.roundId).not.toBe(outcome.first.roundId);
    // The second round joined the lineage the first opened, rather than starting its own
    // conversation: one planner conversation per goal is one session lineage plus N rounds.
    expect(outcome.second.lineage).toBe("continued");
    expect(recorder.parents).toEqual([
      undefined,
      outcome.first.harnessSessionId,
    ]);

    await runtime.dispose();
    const rows = readAfterShutdown(root);
    expect(rows.rounds.map((round) => round.id)).toEqual([
      outcome.first.roundId,
      outcome.second.roundId,
    ]);
    // Still one lineage row, still the first session: a replacement is what a caller
    // records when the harness has forgotten the session, which is slice 9's.
    expect(rows.lineages).toEqual([
      {
        goal_id: "goal_one",
        harness_session_id: outcome.first.harnessSessionId,
      },
    ]);
  });
});

/* ── Refusals leave nothing behind ───────────────────────────────────────────── */

describe("a refused round", () => {
  test("an instance this server cannot give it is refused before anything is claimed", async () => {
    const recorder = emptyRecorder();
    const { scriptFor } = scripts({ narration: [], status: undefined });
    const { root, workspace, runtime, ready } = world(scriptFor, recorder, {
      // Nothing configured, so every resolution is refused by name.
      resolver: HarnessResolver.empty,
    });
    await ready;

    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const input = yield* goal(root, workspace, "goal_one");
        const planner = yield* PlanSupervisor;
        const refused = yield* Effect.result(
          planner.start({ ...input, instanceId: "opencode:default" }),
        );
        // The goal is not held: a second start gets the same refusal rather than
        // `goal_busy`, which is the only way to observe a claim that was never taken.
        const again = yield* Effect.result(planner.start(input));
        return { refused, again };
      }).pipe(Effect.orDie),
    );

    if (outcome.refused._tag !== "Failure") throw new Error("expected refusal");
    expect(planRefused(outcome.refused.failure).reason).toBe(
      "harness_not_ready",
    );
    if (outcome.again._tag !== "Failure") throw new Error("expected refusal");
    expect(planRefused(outcome.again.failure).reason).toBe("harness_not_ready");
    // Nothing was asked of a harness and nothing was written.
    expect(recorder.order).toEqual([]);

    await runtime.dispose();
    expect(readAfterShutdown(root).rounds).toEqual([]);
  });

  test("an ended goal is refused, and the claim taken for it is given back", async () => {
    const recorder = emptyRecorder();
    const { scriptFor } = scripts({ narration: [], status: undefined });
    const { root, workspace, runtime, ready } = world(scriptFor, recorder);
    await ready;

    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const input = yield* goal(root, workspace, "goal_one");
        const stores = yield* TargetStores;
        yield* withTargetStore(stores, TARGET, (store) =>
          store.endGoal(
            { callerScope: operatorScope(TARGET), targetId: TARGET },
            {
              operationId: "op_end",
              goalId: "goal_one",
              status: "abandoned",
              endedBy: "operator",
              reason: "not worth pursuing",
            },
          ),
        ).pipe(Effect.orDie);
        const planner = yield* PlanSupervisor;
        const refused = yield* Effect.result(planner.start(input));
        // `goal_not_active` again rather than `goal_busy`: the claim the first start took
        // before `openRound` refused it was released on the way out.
        const again = yield* Effect.result(planner.start(input));
        return { refused, again };
      }).pipe(Effect.orDie),
    );

    if (outcome.refused._tag !== "Failure") throw new Error("expected refusal");
    expect(planRefused(outcome.refused.failure).reason).toBe("goal_not_active");
    expect(planRefused(outcome.refused.failure).detail).toContain("abandoned");
    if (outcome.again._tag !== "Failure") throw new Error("expected refusal");
    expect(planRefused(outcome.again.failure).reason).toBe("goal_not_active");

    await runtime.dispose();
    // No row at all, and in particular none that says `running` for a sweep to find.
    expect(readAfterShutdown(root).rounds).toEqual([]);
  });

  test("a goal of another target is refused as not found", async () => {
    const recorder = emptyRecorder();
    const { scriptFor } = scripts({ narration: [], status: undefined });
    const { root, workspace, runtime, ready } = world(scriptFor, recorder);
    await ready;

    const refused = await runtime.runPromise(
      Effect.gen(function* () {
        const input = yield* goal(root, workspace, "goal_one");
        const planner = yield* PlanSupervisor;
        return yield* Effect.result(
          planner.start({ ...input, goalId: "goal_nobody_has" }),
        );
      }).pipe(Effect.orDie),
    );

    if (refused._tag !== "Failure") throw new Error("expected refusal");
    expect(planRefused(refused.failure).reason).toBe("goal_not_found");

    await runtime.dispose();
    expect(readAfterShutdown(root).rounds).toEqual([]);
  });

  /**
   * The finding this slice was sent back for.
   *
   * `openRound` writes the row as its last step and four things after it can fail: the
   * gate, the session, the lineage write, the credential and the registration. If the
   * settling finalizer is registered after all of them — which is how this was first
   * written — any of those failing leaves the row `running` forever: the goal is then
   * refused `round_conflict` by a row nothing is driving, with no `plan.round.settled` in
   * the log, until the process restarts and the sweep finds it. A review proved it with a
   * scripted-failure probe while the code's own comment claimed the opposite.
   *
   * So the assertion is not "the start was refused" — that always held — but the three
   * things that did not: the row is **settled**, the log carries the **pair**, and the goal
   * **takes another round in the same process**. Two faults, because the first failing step
   * and a later one are different distances from the finalizer.
   */
  for (const fault of [
    {
      what: "the policy gate will not install",
      faults: { gate: 1 },
      // The gate is the first step after the row, so nothing else ran at all.
      reason: "planning_ungated",
    },
    {
      what: "the harness will not create the session",
      faults: { createSession: 1 },
      // One step further in: the directory was made and gated before this failed.
      reason: "harness_unreachable",
    },
  ] as const) {
    test(`a failure after the row is written (${fault.what}) settles the round and frees the goal`, async () => {
      const recorder = emptyRecorder();
      // The *second* round is scripted to succeed, so that "the goal took another round"
      // is read off a definite status rather than off a second `uncertain` that could have
      // meant anything. The first round never gets a session for the harness to have an
      // opinion about.
      const { scriptFor, release } = scripts({
        narration: [],
        status: "succeeded",
      });
      const { root, workspace, runtime, ready, registry } = world(
        scriptFor,
        recorder,
        { askTimeout: "10 millis", faults: fault.faults },
      );
      await ready;

      const outcome = await runtime.runPromise(
        Effect.gen(function* () {
          const input = yield* goal(root, workspace, "goal_one");
          const planner = yield* PlanSupervisor;
          const refused = yield* Effect.result(planner.start(input));
          // The refusal reaches the caller from inside the round's scope, so the finalizer
          // may still be running when `start` answers. Waiting on the rows is the barrier,
          // and "no row says running" is exactly the property under test.
          yield* awaitNoRunningRound();
          // The goal takes another round **in this process**: both halves of the claim had
          // to be given back for this to succeed — the in-memory one by the finalizer, and
          // the durable one by the row leaving `running`.
          const second = yield* Effect.result(planner.start(input));
          if (second._tag === "Success") {
            yield* release(second.success.harnessSessionId);
            yield* awaitSettled(second.success.roundId);
          }
          return { refused, second };
        }).pipe(Effect.orDie),
      );

      if (outcome.refused._tag !== "Failure")
        throw new Error("expected a refusal");
      expect(planRefused(outcome.refused.failure).reason).toBe(fault.reason);
      expect(outcome.second._tag).toBe("Success");

      await runtime.dispose();
      const rows = readAfterShutdown(root);
      expect(rows.rounds).toHaveLength(2);
      const stranded = rows.rounds[0];
      // Settled, not left running. `uncertain` because nothing stated an outcome and
      // nobody interrupted anything — `startFailed`, which is what keeps this out of the
      // `interrupted` bucket.
      expect(stranded?.status).toBe("uncertain");
      expect(stranded?.ended_at).not.toBeNull();
      expect(stranded?.write_fence).toBe(1);
      // The pair, which decision 16 makes the only durable trace a round happened. A
      // `started` with no `settled` would say a round began and never ended.
      expect(
        rows.events
          .filter((event) => event.subject_id === stranded?.id)
          .map((event) => event.kind),
      ).toEqual(["plan.round.started", "plan.round.settled"]);
      // And the second round really ran: its own pair, and the one registration in the
      // recorder is its, because the first round never got that far.
      expect(rows.rounds[1]?.status).toBe("settled");
      expect(recorder.registrations.map((entry) => entry.name)).toEqual([
        `bit-${rows.rounds[1]?.id ?? ""}`,
      ]);
      // Nothing is left in the registry at all: whatever the failed round had acquired went
      // with its scope, and the second round's went with its own settlement.
      const credentials = await registry;
      expect(await Effect.runPromise(credentials.size)).toBe(0);
      // Exactly one session was ever created, the second round's. In both faults the first
      // round stopped before `createSession` returned, which is what makes the stranded row
      // a row with no session behind it — the case the sweep answers with `missing`.
      expect(
        recorder.order.filter((entry) => entry.startsWith("create:")),
      ).toHaveLength(1);
    });
  }

  test("a defect while starting settles `uncertain`, never `interrupted`", async () => {
    const recorder = emptyRecorder();
    const { scriptFor } = scripts({ narration: [], status: undefined });
    const { root, workspace, runtime, ready } = world(scriptFor, recorder, {
      askTimeout: "10 millis",
      faults: { gateDefect: 1 },
    });
    await ready;

    const refused = await runtime.runPromise(
      Effect.gen(function* () {
        const input = yield* goal(root, workspace, "goal_one");
        const planner = yield* PlanSupervisor;
        const outcome = yield* Effect.result(planner.start(input));
        yield* awaitNoRunningRound();
        return outcome;
      }).pipe(Effect.orDie),
    );

    // The caller still gets an answer rather than hanging on a deferred the dead fiber will
    // never complete: that is the `ensuring` at the bottom of `supervise`.
    if (refused._tag !== "Failure") throw new Error("expected a refusal");
    expect(planRefused(refused.failure).reason).toBe("store_unavailable");

    await runtime.dispose();
    const rows = readAfterShutdown(root);
    /**
     * `uncertain`, and the status this asserts *against* is the finding.
     *
     * A defect is not caught by `Effect.result`, so it used to propagate out of the body
     * with `ending` still holding its `stopped` default — and the round was written down
     * `interrupted`, a durable claim that somebody stopped it when nobody did.
     * `interrupted` is the one status this code says it has first-hand knowledge of,
     * precisely because we are the ones who asked the harness to stop; inheriting it from a
     * default on a crash path inverts that. `uncertain` is what "we cannot say what
     * happened" has always meant here.
     */
    expect(rows.rounds[0]?.status).toBe("uncertain");
    expect(rows.rounds[0]?.status).not.toBe("interrupted");
    // The durable record says it too, not just the row.
    const settled = rows.events.find(
      (event) => event.kind === "plan.round.settled",
    );
    expect(JSON.parse(settled?.payload ?? "{}")).toMatchObject({
      status: "uncertain",
      settledBy: "supervisor",
    });
    // And the crash did not cost the round its settlement: the row is ended and the fence
    // has moved, so the goal is free and no credential minted against it would work.
    expect(rows.rounds[0]?.ended_at).not.toBeNull();
    expect(rows.rounds[0]?.write_fence).toBe(1);
    // Nothing asked the harness to interrupt a session, because nobody interrupted: the
    // finalizer's `interruptSession` is guarded on `ending._tag === "stopped"`, which is
    // the same inversion seen from the other side.
    expect(recorder.interrupts).toEqual([]);
  });

  test("a prompt the harness refuses settles the round rather than leaving it running", async () => {
    const recorder = emptyRecorder();
    const { scriptFor } = scripts({
      narration: [],
      status: undefined,
      promptFails: true,
    });
    const { root, workspace, runtime, ready, registry } = world(
      scriptFor,
      recorder,
      { askTimeout: "10 millis" },
    );
    await ready;

    const refused = await runtime.runPromise(
      Effect.gen(function* () {
        const input = yield* goal(root, workspace, "goal_one");
        const planner = yield* PlanSupervisor;
        return yield* Effect.result(planner.start(input));
      }).pipe(Effect.orDie),
    );

    if (refused._tag !== "Failure") throw new Error("expected refusal");
    expect(planRefused(refused.failure).reason).toBe("harness_unreachable");

    await runtime.dispose();
    const rows = readAfterShutdown(root);
    // The row exists, because the prompt failed after it was written — and it is
    // **settled**, by this round's own finalizer. `uncertain` rather than `interrupted`:
    // nobody interrupted anything, and `startFailed` is what keeps those apart.
    expect(rows.rounds).toHaveLength(1);
    expect(rows.rounds[0]?.status).toBe("uncertain");
    expect(rows.rounds[0]?.write_fence).toBe(1);
    // And the registration and the credential went with the scope.
    const credentials = await registry;
    expect(
      await Effect.runPromise(
        credentials.resolve(
          (recorder.registrations[0]?.bearer ?? "").replace("Bearer ", ""),
        ),
      ),
    ).toBeUndefined();
    expect(recorder.unregistrations).toHaveLength(1);
  });
});

/* ── Stopping, and shutting down ─────────────────────────────────────────────── */

describe("whether a round ever reached its tool surface", () => {
  /**
   * The condition this exists for has no other symptom.
   *
   * DECISIONS.md §24.2 caveat 1 measured that an OpenCode MCP registration can be
   * connected and **not yet callable**, and that there is no API to read the tool registry
   * — so the round cannot confirm exposure before prompting, and the prompt is never
   * resubmitted. A round that never had its tools settles exactly like a round that had
   * them and chose to say nothing: `settled`, `disposition: null`. The only thing that
   * tells them apart is whether the MCP endpoint ever saw a request under the round's own
   * caller scope.
   *
   * These two tests exist because the figure previously had **no reader at all** — the
   * module documented the diagnostic and nothing consulted the counter, so the distinction
   * the comment promised was one nobody could make. A review found that. What is asserted
   * here is that `settle` really reads it, on the one settlement path whose answer a caller
   * can see; the log line it also writes comes from the same call.
   */
  const scopeOf = (roundId: string) => `${TARGET}/round/${roundId}`;

  test("a round whose session called the endpoint reports the calls it made", async () => {
    const recorder = emptyRecorder();
    const { scriptFor } = scripts({ narration: [], status: undefined });
    const { root, workspace, runtime, ready } = world(scriptFor, recorder, {
      askTimeout: "10 millis",
    });
    await ready;

    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const input = yield* goal(root, workspace, "goal_one");
        const planner = yield* PlanSupervisor;
        const started = yield* planner.start(input);
        // Driven the way the MCP auth middleware drives it: `increment` for the round's own
        // caller scope, after the bearer has resolved. Three calls, so the assertion is
        // about the number rather than about zero-versus-not.
        const calls = yield* McpCallCounter;
        yield* calls.increment(scopeOf(started.roundId));
        yield* calls.increment(scopeOf(started.roundId));
        yield* calls.increment(scopeOf(started.roundId));
        // Somebody else's scope, so the count is provably this round's and not the total.
        yield* calls.increment(`${TARGET}/attempt-elsewhere`);
        return yield* planner.stop(started.roundId);
      }).pipe(Effect.orDie),
    );

    expect(outcome.toolCallsSeen).toBe(3);
  });

  test("a round that never called reports zero, which is the Spike B condition", async () => {
    const recorder = emptyRecorder();
    const { scriptFor } = scripts({ narration: [], status: undefined });
    const { root, workspace, runtime, ready } = world(scriptFor, recorder, {
      askTimeout: "10 millis",
    });
    await ready;

    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const input = yield* goal(root, workspace, "goal_one");
        const planner = yield* PlanSupervisor;
        const started = yield* planner.start(input);
        const stopped = yield* planner.stop(started.roundId);
        const stores = yield* TargetStores;
        const round = yield* withTargetStore(stores, TARGET, (store) =>
          store.loadRound(started.roundId),
        );
        return { stopped, round };
      }).pipe(Effect.orDie),
    );

    // Zero, and it is a **measured** zero: this process settled the round and read the
    // counter. The case that must not read the same is below.
    expect(outcome.stopped.toolCallsSeen).toBe(0);
    // Zero **and** no disposition is the conjunction the settlement warns about. The row
    // half of it is asserted here; the warning itself is a log line, which is the honest
    // extent of where this figure goes — it is not on the round row and not on
    // `plan.round.settled`, and `settle`'s own comment says so.
    expect(outcome.round?.disposition).toBeNull();
  });

  test("the zero-call warning blames the tool-exposure lag only when it fits", async () => {
    /*
     * The warning's **wording**, which used to be one sentence for four endings.
     *
     * Zero calls plus no disposition is worth saying, but why depends on how the round
     * ended. A round that ran to its own finish and never reached its tools is
     * DECISIONS.md §24.2 caveat 1 — the measured case where an OpenCode registration is
     * connected and not yet callable — and that is a harness fault an operator should act
     * on by opening another round. A round an operator **stopped** ten seconds in has made
     * no call because nobody gave it time, and a start that failed never had a session at
     * all. Naming the exposure lag for those is a line that blames the wrong thing, which
     * is worse than no line: this figure is the whole mitigation for that condition and a
     * diagnostic that cries wolf is one nobody reads.
     */
    const recorder = emptyRecorder();
    const { scriptFor } = scripts({ narration: [], status: undefined });
    const { root, workspace, runtime, ready, logged } = world(
      scriptFor,
      recorder,
      { askTimeout: "10 millis" },
    );
    await ready;

    await runtime.runPromise(
      Effect.gen(function* () {
        const input = yield* goal(root, workspace, "goal_one");
        const planner = yield* PlanSupervisor;
        const started = yield* planner.start(input);
        return yield* planner.stop(started.roundId);
      }).pipe(Effect.orDie),
    );

    const warned = logged.filter(
      (line) =>
        line.level === "Warn" &&
        line.message.includes("made no authenticated tool call"),
    );
    // It still fires: zero and null is still the conjunction worth reporting.
    expect(warned).toHaveLength(1);
    // And it says what is true of a stop rather than reaching for the spike's finding.
    expect(warned[0]?.message).toContain("expected for how it ended");
    expect(warned[0]?.message).not.toContain("tool surface was never reached");

    await runtime.dispose();
  });

  test("a settlement that cannot read its own round says so", async () => {
    /*
     * The swallowed read, which is what this asserts the absence of.
     *
     * `settle` reads the round back for its disposition, so that "zero calls" can be
     * reported as the thing it actually is. That read was wrapped in `Effect.result` and the
     * failure case discarded with no log line at all — a settlement that could not read its
     * own round said **nothing** about it, on the one path every recovery story depends on.
     *
     * The fault is injected the only way it is reachable: the round's own table is taken out
     * from under the connection after the row exists. Both reads in the settlement path go
     * through it, so this also exercises the settlement-failure line beside it, and the two
     * together are the honest picture — the row is left for the startup sweep, and this
     * process says which parts of its own accounting it could not do.
     */
    const recorder = emptyRecorder();
    const { scriptFor } = scripts({ narration: [], status: undefined });
    const { root, workspace, runtime, ready, logged } = world(
      scriptFor,
      recorder,
      { askTimeout: "10 millis" },
    );
    await ready;

    const stopped = await runtime.runPromise(
      Effect.gen(function* () {
        const input = yield* goal(root, workspace, "goal_one");
        const planner = yield* PlanSupervisor;
        const started = yield* planner.start(input);
        // The row is written and the round is running; now the table goes.
        yield* Effect.sync(() => {
          const database = new Database(
            join(root, "targets", TARGET, "hunt.sqlite"),
          );
          try {
            database.run(
              "ALTER TABLE planner_rounds RENAME TO planner_rounds_gone",
            );
          } finally {
            database.close();
          }
        });
        return yield* planner.stop(started.roundId);
      }).pipe(Effect.orDie),
    );

    // The read failed, and the settlement says which part of its own accounting it lost.
    const unread = logged.filter((line) =>
      line.message.includes("could not be read back at settlement"),
    );
    expect(unread).toHaveLength(1);
    expect(unread[0]?.level).toBe("Warn");
    // Beside it, the write that failed first — so the pair reads as one known handover to
    // the sweep rather than as a silent gap.
    expect(
      logged.some((line) => line.message.includes("could not be settled")),
    ).toBe(true);
    /*
     * The stop still answers, and what it answers is worth being precise about: `status` is
     * the status this settlement **decided**, which is `interrupted` because the operator
     * stopped the round — first-hand knowledge, unaffected by the row read failing. What
     * could not be written is the row, and that is the line beside it rather than a
     * different status here.
     */
    expect(stopped.status).toBe("interrupted");
    // A settlement *was* recorded, so the count is a measured `0` rather than a `null`.
    expect(stopped.toolCallsSeen).toBe(0);

    await runtime.dispose();
  });

  test("a stop with no settlement to report says it does not know, not zero", () => {
    /*
     * The other half of the figure, and the reason it is nullable.
     *
     * `toolCallsSeen` exists for one purpose: to separate "this round never reached its
     * tools" (DECISIONS.md §24.2 caveat 1, measured in 3 of 8 first prompts) from "it had
     * its tools and chose to say nothing". A stop that has no settlement recorded knows
     * neither — and answering `0` made it indistinguishable from the first, which is a
     * false negative on the only diagnostic that condition has.
     *
     * Asserted over the rule rather than over a run, because the window it covers is one
     * this process cannot be driven into from outside: the stretch between a round's row
     * committing and its first finalizer being registered, where a `stop` finds a fiber and
     * no settlement. The rule is what `stop` returns, so this is the same answer either
     * way, and the window is documented on `supervise` rather than asserted through it.
     */
    const unknown = roundStopReport({
      roundId: "rnd_unsettled",
      held: undefined,
      settled: undefined,
      stoppedAt: 1_700_000_000_000,
    });

    // `null`, not `0`: nothing was measured.
    expect(unknown.toolCallsSeen).toBeNull();
    // And the companions take the same care: a status this process did not observe is
    // `uncertain` rather than a claim.
    expect(unknown.status).toBe("uncertain");
    expect(unknown.credentialsRevoked).toBe(0);

    const known = roundStopReport({
      roundId: "rnd_settled",
      held: { targetId: TARGET, harnessSessionId: "ses_1" },
      settled: { status: "interrupted", grants: 1, toolCallsSeen: 0 },
      stoppedAt: 1_700_000_000_000,
    });

    // The contrast that makes the `null` mean something: a measured zero is still zero.
    expect(known.toolCallsSeen).toBe(0);
    expect(known.status).toBe("interrupted");
    expect(known.harnessSessionId).toBe("ses_1");
  });
});

describe("stopping a round", () => {
  test("settles `interrupted`, revokes the grant, unregisters and frees the goal", async () => {
    const recorder = emptyRecorder();
    const { scriptFor } = scripts({ narration: [], status: undefined });
    const { root, workspace, runtime, ready, registry } = world(
      scriptFor,
      recorder,
      { askTimeout: "10 millis" },
    );
    await ready;

    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const input = yield* goal(root, workspace, "goal_one");
        const planner = yield* PlanSupervisor;
        const started = yield* planner.start(input);
        const stopped = yield* planner.stop(started.roundId);
        return {
          started,
          stopped,
          // By the time `stop` returns the finalizer has run, so the goal is already free.
          // Asserted by starting another round rather than by reading a private map.
          next: yield* Effect.result(planner.start(input)),
          running: yield* planner.running,
        };
      }).pipe(Effect.orDie),
    );

    expect(outcome.stopped.status).toBe("interrupted");
    /**
     * One, and this number is the ordering guard.
     *
     * `credentials.issue` is an `acquireRelease` in the round's scope, so if the settling
     * finalizer were registered *before* it, scope finalizers running in reverse
     * acquisition order would revoke the grant first and `settle` would find none — which
     * is both a `stop` response that under-reports what it did and the window `settle`
     * argues against, a dead credential while the row still says `running`. A regression
     * that did exactly that was caught by this assertion.
     */
    expect(outcome.stopped.credentialsRevoked).toBe(1);
    expect(outcome.stopped.roundId).toBe(outcome.started.roundId);
    // We asked the harness to stop, which is what makes `interrupted` first-hand rather
    // than an inference from silence.
    expect(recorder.interrupts).toContain(outcome.started.harnessSessionId);
    expect(recorder.unregistrations.map((entry) => entry.name)).toContain(
      `bit-${outcome.started.roundId}`,
    );
    expect(outcome.next._tag).toBe("Success");
    // The stopped round is gone from `running` and the new one is there.
    expect(outcome.running).toHaveLength(1);

    const credentials = await registry;
    const stoppedBearer = (recorder.registrations[0]?.bearer ?? "").replace(
      "Bearer ",
      "",
    );
    expect(
      await Effect.runPromise(credentials.resolve(stoppedBearer)),
    ).toBeUndefined();

    await runtime.dispose();
    const rows = readAfterShutdown(root);
    expect(rows.rounds[0]).toMatchObject({
      id: outcome.started.roundId,
      status: "interrupted",
      // Authority revoked durably as well as in memory, so a credential minted against
      // fence 0 is refused even after a restart.
      write_fence: 1,
    });
    expect(rows.rounds[0]?.ended_at).not.toBeNull();
    // The settled record is the supervisor's, with no harness answer on it. `observed` is
    // the sweep's field and null here is an honest absence rather than a missing one: this
    // path's sources are a `TerminalOutcome` and an interruption we caused, neither of
    // which is a harness observation. `RoundSettler` is tagged so the two cannot be mixed.
    const settled = rows.events.find(
      (event) => event.kind === "plan.round.settled",
    );
    expect(JSON.parse(settled?.payload ?? "{}")).toMatchObject({
      roundId: outcome.started.roundId,
      goalId: "goal_one",
      status: "interrupted",
      priorStatus: "running",
      settledBy: "supervisor",
      observed: null,
      disposition: null,
    });
  });

  test("a round nothing is driving is refused by name rather than guessed at", async () => {
    const recorder = emptyRecorder();
    const { scriptFor } = scripts({ narration: [], status: undefined });
    const { runtime, ready } = world(scriptFor, recorder);
    await ready;

    const refused = await runtime.runPromise(
      Effect.flatMap(PlanSupervisor, (planner) =>
        Effect.result(planner.stop("rnd_nobody_has")),
      ),
    );
    if (refused._tag !== "Failure") throw new Error("expected refusal");
    expect(planRefused(refused.failure).reason).toBe("unknown_round");
    // The sentence has to point an operator at the sweep, because a row that still says
    // `running` after a crash has no fiber here to interrupt.
    expect(planRefused(refused.failure).detail).toContain("startup sweep");
    await runtime.dispose();
  });

  test("a shutdown settles a round in flight", async () => {
    const recorder = emptyRecorder();
    const { scriptFor } = scripts({ narration: [], status: undefined });
    const { root, workspace, runtime, ready, registry } = world(
      scriptFor,
      recorder,
      // Bounded short, because this is the path where the ask happens while the harness
      // child would also be being torn down. Ten seconds is right for an operator and
      // unusable for a suite.
      { askTimeout: "10 millis" },
    );
    await ready;

    const started = await runtime.runPromise(
      Effect.gen(function* () {
        const input = yield* goal(root, workspace, "goal_one");
        const planner = yield* PlanSupervisor;
        return yield* planner.start(input);
      }).pipe(Effect.orDie),
    );

    // Nothing released the long poll, so the round is live when the layer's scope closes.
    // Closing it interrupts the fiber map, which runs each round's finalizer.
    await runtime.dispose();

    const rows = readAfterShutdown(root);
    expect(rows.rounds[0]).toMatchObject({
      id: started.roundId,
      // `interrupted` rather than `uncertain`: a shutdown is us stopping the round, which
      // is the one status we have first-hand. A row left `running` here is the thing this
      // test exists to prevent — it would be a goal blocked until the next sweep.
      status: "interrupted",
      write_fence: 1,
    });
    expect(rows.events.map((event) => event.kind)).toEqual([
      "plan.round.started",
      "plan.round.settled",
    ]);
    const credentials = await registry;
    expect(
      await Effect.runPromise(
        credentials.resolve(
          (recorder.registrations[0]?.bearer ?? "").replace("Bearer ", ""),
        ),
      ),
    ).toBeUndefined();
  });

  test("a harness that stated its own outcome settles to it, and is not interrupted again", async () => {
    const recorder = emptyRecorder();
    const { scriptFor, release } = scripts({
      narration: [],
      status: "succeeded",
    });
    const { root, workspace, runtime, ready } = world(scriptFor, recorder, {
      askTimeout: "10 millis",
    });
    await ready;

    const started = await runtime.runPromise(
      Effect.gen(function* () {
        const input = yield* goal(root, workspace, "goal_one");
        const planner = yield* PlanSupervisor;
        const round = yield* planner.start(input);
        yield* release(round.harnessSessionId);
        // The round ends by itself, so there is no `stop` to await: by the time it has
        // settled its fiber is gone from the map and a stop would be `unknown_round`.
        yield* awaitSettled(round.roundId);
        return round;
      }).pipe(Effect.orDie),
    );

    // A session that reported its own outcome has already stopped, so nothing asked it to
    // stop again: that would be a pointless round trip on every clean round.
    expect(recorder.interrupts).toEqual([]);

    await runtime.dispose();
    const rows = readAfterShutdown(root);
    // `settled`, not `succeeded`: a round does not pass or fail, and what it concluded is
    // its disposition, which is null because nothing recorded one.
    expect(rows.rounds[0]).toMatchObject({
      id: started.roundId,
      status: "settled",
      disposition: null,
    });
  });

  test("a harness that cannot be asked settles `uncertain`, never `failed`", async () => {
    const recorder = emptyRecorder();
    const { scriptFor, release } = scripts({
      narration: [],
      status: undefined,
      statusUnreachable: true,
    });
    const { root, workspace, runtime, ready } = world(scriptFor, recorder, {
      askTimeout: "10 millis",
    });
    await ready;

    await runtime.runPromise(
      Effect.gen(function* () {
        const input = yield* goal(root, workspace, "goal_one");
        const planner = yield* PlanSupervisor;
        const round = yield* planner.start(input);
        // The wait returns, saying the session is no longer running and nothing about how
        // it went; `session.get` then fails. Two absences, and the only honest answer.
        yield* release(round.harnessSessionId);
        yield* awaitSettled(round.roundId);
        return round;
      }).pipe(Effect.orDie),
    );

    await runtime.dispose();
    expect(readAfterShutdown(root).rounds[0]?.status).toBe("uncertain");
  });
});

/* ── Steering a live round ───────────────────────────────────────────────────── */

describe("steering the round that is live on a goal", () => {
  test("a steer reaches it, wrapped so the planner knows who is speaking", async () => {
    const recorder = emptyRecorder();
    const { scriptFor, releaseAll } = scripts({
      narration: [],
      status: undefined,
    });
    const { root, workspace, runtime, ready } = world(scriptFor, recorder);
    await ready;

    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const input = yield* goal(root, workspace, "goal_steer");
        const planner = yield* PlanSupervisor;
        const round = yield* planner.start(input);
        const steered = yield* planner.steer({
          goalId: "goal_steer",
          directive: "The operator says the admin console is out of scope.",
          urgency: "queued",
          messageId: "aaaa0000bbbb1111cccc2222dddd3333",
        });
        return { round, steered };
      }).pipe(Effect.orDie),
    );

    expect(outcome.steered._tag).toBe("steered");
    if (outcome.steered._tag === "steered") {
      expect(outcome.steered.roundId).toBe(outcome.round.roundId);
      expect(outcome.steered.harnessSessionId).toBe(
        outcome.round.harnessSessionId,
      );
      expect(outcome.steered.delivered).toBe(true);
    }
    expect(recorder.steers).toHaveLength(1);
    // Queued by default and the urgency is carried through, not re-decided here.
    expect(recorder.steers[0]?.urgency).toBe("queued");
    // Wrapped, not bare: the planner has to be able to tell "the operator's agent is
    // redirecting me" from "the operator is talking to me" — it is talking to neither.
    expect(recorder.steers[0]?.text).toContain(
      "A DIRECTIVE FROM THE GOAL AGENT",
    );
    expect(recorder.steers[0]?.text).toContain("admin console");
    // And the session's rules are not restated: this is the same session, which is the
    // whole reason steering beats opening a round.
    expect(recorder.steers[0]?.text).not.toContain("THE RECORD FOLLOWS");

    await runtime.runPromise(releaseAll());
    await runtime.dispose();
  });

  /**
   * The settlement defect S7a recorded one rank down from the harness's answer, and did
   * not fix.
   *
   * `report.narrated` is per-*stream*, not per-turn: the narration fiber records the last
   * terminal `session.execution.*` the subscription has seen, and the subscription spans
   * the whole round. So a round whose first turn terminalised and was then steered held
   * turn one's event while turn two ran, and `roundSettlementFor` ranks it **second** — so
   * a settlement that got nothing out of `sessionStatus` asserted turn one's outcome about
   * turn two. Here that is a `settled` round for a turn nothing ever said anything about.
   *
   * `status: undefined` is what makes the rank visible rather than hidden behind rank 1:
   * the harness has no outcome to give, which is the common case on a session whose turn
   * was interrupted. `uncertain` is the right answer — "we could not find out" — and it is
   * never `failed`.
   *
   * **Two narration entries, and the second one is the synchronisation.** `narrateRound`
   * publishes an entry and *then* records its outcome, in that order, and
   * `Stream.runForEach` processes entries one at a time — so receiving the second entry
   * over the bus proves the first one's outcome has already landed in `report.narrated`.
   * Waiting for the terminal entry alone would leave a window in which the steer cleared a
   * field nothing had written yet, and the test would pass for the wrong reason.
   */
  test("a steered round does not settle from the previous turn's terminal event", async () => {
    const recorder = emptyRecorder();
    const { scriptFor, release } = scripts({
      narration: [
        {
          type: "session.execution.succeeded",
          sequence: 1,
          at: 1_700_000_000_000,
          // Turn one's, and the only outcome anything in this test states.
          outcome: "succeeded",
          detail: { _tag: "opaque" },
        },
        {
          type: "session.text.ended",
          sequence: 2,
          at: 1_700_000_000_001,
          outcome: undefined,
          detail: { _tag: "reply", text: "turn one is done" },
        },
      ],
      status: undefined,
    });
    const { root, workspace, runtime, ready } = world(scriptFor, recorder);
    await ready;

    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const narrations = yield* RunNarrations;
        const collected = yield* Effect.forkChild(
          Stream.runCollect(
            Stream.take(narrations.subscribe({ targetId: TARGET }), 2),
          ),
        );
        yield* Effect.timeout(
          Effect.gen(function* () {
            while ((yield* narrations.subscriberCount) === 0) {
              yield* Effect.sleep("5 millis");
            }
          }),
          "10 seconds",
        );
        const input = yield* goal(root, workspace, "goal_steered");
        const planner = yield* PlanSupervisor;
        const round = yield* planner.start(input);
        // Both entries seen, so turn one's outcome is in the report before the steer.
        yield* Fiber.join(collected);
        const steered = yield* planner.steer({
          goalId: "goal_steered",
          directive: "Carry on with the second dimension.",
          urgency: "queued",
          messageId: "cccc0000dddd1111eeee2222ffff3333",
        });
        // Turn two's long poll returns having said nothing about how it went, which is
        // what an interrupted or a dropped turn leaves behind.
        yield* release(round.harnessSessionId);
        yield* awaitSettled(round.roundId);
        const stores = yield* TargetStores;
        const row = yield* withTargetStore(stores, TARGET, (store) =>
          store.loadRound(round.roundId),
        );
        return { steered, row };
      }).pipe(Effect.orDie),
    );

    expect(observed.steered._tag).toBe("steered");
    expect(recorder.steers).toHaveLength(1);
    // Not `settled`: that would be turn one's `succeeded` read as the round's answer.
    expect(observed.row?.status).toBe("uncertain");
    // And the round concluded nothing, which the honest record says alongside it.
    expect(observed.row?.disposition).toBeNull();

    await runtime.dispose();
  });

  /**
   * The other order, which must not change: a steer the harness **refused** started no new
   * turn, so the terminal event the stream carried is still the last turn's and still the
   * right thing to settle from. Clearing before the prompt rather than after acceptance
   * would have lost it.
   */
  test("a refused steer leaves the terminal event it has not superseded", async () => {
    const recorder = emptyRecorder();
    const { scriptFor, release } = scripts({
      narration: [
        {
          type: "session.execution.succeeded",
          sequence: 1,
          at: 1_700_000_000_000,
          outcome: "succeeded",
          detail: { _tag: "opaque" },
        },
        {
          type: "session.text.ended",
          sequence: 2,
          at: 1_700_000_000_001,
          outcome: undefined,
          detail: { _tag: "reply", text: "turn one is done" },
        },
      ],
      status: undefined,
      steerFails: true,
    });
    const { root, workspace, runtime, ready } = world(scriptFor, recorder);
    await ready;

    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const narrations = yield* RunNarrations;
        const collected = yield* Effect.forkChild(
          Stream.runCollect(
            Stream.take(narrations.subscribe({ targetId: TARGET }), 2),
          ),
        );
        yield* Effect.timeout(
          Effect.gen(function* () {
            while ((yield* narrations.subscriberCount) === 0) {
              yield* Effect.sleep("5 millis");
            }
          }),
          "10 seconds",
        );
        const input = yield* goal(root, workspace, "goal_refused");
        const planner = yield* PlanSupervisor;
        const round = yield* planner.start(input);
        yield* Fiber.join(collected);
        const refused = yield* Effect.result(
          planner.steer({
            goalId: "goal_refused",
            directive: "A directive the harness will not take.",
            urgency: "queued",
            messageId: "eeee0000ffff11112222333344445555",
          }),
        );
        yield* release(round.harnessSessionId);
        yield* awaitSettled(round.roundId);
        const stores = yield* TargetStores;
        const row = yield* withTargetStore(stores, TARGET, (store) =>
          store.loadRound(round.roundId),
        );
        return { refused, row };
      }).pipe(Effect.orDie),
    );

    expect(observed.refused._tag).toBe("Failure");
    // Turn one's event, still the only turn there was, still the round's answer.
    expect(observed.row?.status).toBe("settled");

    await runtime.dispose();
  });

  test("a round's block deltas stay off the bus; its finished block and outcome do not", async () => {
    // A round has no live partial view, so a streaming driver's deltas would only crowd a
    // slow subscriber's sliding buffer. The first two entries on the bus are the terminal
    // event and the finished block; the round still settles from that event.
    const recorder = emptyRecorder();
    const delta = (sequence: number, text: string): HarnessNarration => ({
      type: "session.text.delta",
      sequence,
      at: 1_700_000_000_000 + sequence,
      outcome: undefined,
      detail: { _tag: "delta", blockId: "prt_1", channel: "reply", text },
    });
    const { scriptFor, release } = scripts({
      narration: [
        delta(1, "round "),
        delta(2, "done"),
        {
          type: "session.execution.succeeded",
          sequence: 3,
          at: 1_700_000_000_003,
          outcome: "succeeded",
          detail: { _tag: "opaque" },
        },
        // After the outcome, so receiving it proves the outcome was recorded (the steered
        // test above says why).
        {
          type: "session.text.ended",
          sequence: 4,
          at: 1_700_000_000_004,
          outcome: undefined,
          detail: { _tag: "reply", text: "round done", blockId: "prt_1" },
        },
      ],
      status: undefined,
    });
    const { root, workspace, runtime, ready } = world(scriptFor, recorder);
    await ready;

    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const narrations = yield* RunNarrations;
        const collected = yield* Effect.forkChild(
          Stream.runCollect(
            Stream.take(narrations.subscribe({ targetId: TARGET }), 2),
          ),
        );
        yield* Effect.timeout(
          Effect.gen(function* () {
            while ((yield* narrations.subscriberCount) === 0) {
              yield* Effect.sleep("5 millis");
            }
          }),
          "10 seconds",
        );
        const input = yield* goal(root, workspace, "goal_deltas");
        const planner = yield* PlanSupervisor;
        const round = yield* planner.start(input);
        const received = yield* Fiber.join(collected);
        yield* release(round.harnessSessionId);
        yield* awaitSettled(round.roundId);
        const stores = yield* TargetStores;
        const row = yield* withTargetStore(stores, TARGET, (store) =>
          store.loadRound(round.roundId),
        );
        return { received, row };
      }).pipe(Effect.orDie),
    );

    expect(observed.received.map((item) => item.entry.type)).toEqual([
      "session.execution.succeeded",
      "session.text.ended",
    ]);
    // The narrated outcome still reached the settlement.
    expect(observed.row?.status).toBe("settled");

    await runtime.dispose();
  });

  test("a goal with nothing live answers noLiveRound and delivers nothing", async () => {
    const recorder = emptyRecorder();
    const { scriptFor } = scripts({ narration: [], status: undefined });
    const { root, workspace, runtime, ready } = world(scriptFor, recorder);
    await ready;

    const answer = await runtime.runPromise(
      Effect.gen(function* () {
        // A goal that exists and has never had a round: there is nothing to steer, and the
        // caller takes decision 12's other branch.
        yield* goal(root, workspace, "goal_quiet");
        const planner = yield* PlanSupervisor;
        return yield* planner.steer({
          goalId: "goal_quiet",
          directive: "Anything at all.",
          urgency: "queued",
          messageId: "11112222333344445555666677778888",
        });
      }).pipe(Effect.orDie),
    );

    expect(answer._tag).toBe("noLiveRound");
    expect(recorder.steers).toEqual([]);
    await runtime.dispose();
  });

  test("a steer that lost the race against settlement starts no unsupervised work", async () => {
    /*
     * DECISIONS.md §24.1, consequence 5, and the reason this method exists at all.
     *
     * OpenCode never refuses a prompt — not for being busy and not for being finished — so
     * prompting the session of a round that has just settled starts a **new execution**,
     * with no supervisor watching it, no round record and no disposition. The supervisor
     * therefore has to refuse to deliver rather than let the harness decide, and the
     * assertion that matters is not the answer: it is that `prompt` was never called.
     */
    const recorder = emptyRecorder();
    const { scriptFor, release } = scripts({
      narration: [],
      status: "succeeded",
    });
    const { root, workspace, runtime, ready } = world(scriptFor, recorder);
    await ready;

    const answer = await runtime.runPromise(
      Effect.gen(function* () {
        const input = yield* goal(root, workspace, "goal_late");
        const planner = yield* PlanSupervisor;
        const round = yield* planner.start(input);
        yield* release(round.harnessSessionId);
        yield* awaitSettled(round.roundId);
        return yield* planner.steer({
          goalId: "goal_late",
          directive: "Too late to matter.",
          urgency: "queued",
          messageId: "99998888777766665555444433332222",
        });
      }).pipe(Effect.orDie),
    );

    expect(answer._tag).toBe("noLiveRound");
    expect(recorder.steers).toEqual([]);
    await runtime.dispose();
  });

  test("a settlement waits behind a steer that is already in flight", async () => {
    /*
     * The other half of the same race, and the half a sequence of calls cannot show.
     *
     * The window the claim is about is between the supervisor deciding the round is live
     * and the prompt landing: if a settlement could run inside it, the directive would
     * arrive at a session whose credential had just been revoked and whose round row had
     * left `running` — which on OpenCode is new, unsupervised work. The one permit is what
     * closes it, so a steer that is parked inside the harness holds the settlement off
     * until it has been delivered.
     *
     * Read off `recorder.order`: `steer` before `interrupt` is the ordering, and the
     * settlement's interrupt is the first thing `conclude` does after taking the permit.
     */
    const steerGate = Deferred.makeUnsafe<void>();
    const steerEntered = Deferred.makeUnsafe<void>();
    const recorder = emptyRecorder();
    const { scriptFor } = scripts({
      narration: [],
      status: undefined,
      steerGate,
      steerEntered,
    });
    const { root, workspace, runtime, ready } = world(scriptFor, recorder);
    await ready;

    await runtime.runPromise(
      Effect.gen(function* () {
        const input = yield* goal(root, workspace, "goal_race");
        const planner = yield* PlanSupervisor;
        const round = yield* planner.start(input);

        // In flight and parked inside the harness, holding the round's permit.
        const steering = yield* Effect.forkChild(
          planner.steer({
            goalId: "goal_race",
            directive: "Mid-settlement.",
            urgency: "queued",
            messageId: "0f0f0f0f1e1e1e1e2d2d2d2d3c3c3c3c",
          }),
        );
        yield* Deferred.await(steerEntered);

        // The stop arrives now. It must not interrupt the session until the steer is done.
        const stopping = yield* Effect.forkChild(planner.stop(round.roundId));
        yield* Effect.sleep("20 millis");
        expect(recorder.interrupts).toEqual([]);

        yield* Deferred.succeed(steerGate, undefined);
        const steered = yield* Fiber.join(steering);
        const stopped = yield* Fiber.join(stopping);
        return { steered, stopped };
      }).pipe(Effect.orDie),
    );

    expect(recorder.steers).toHaveLength(1);
    // The ordering, which is the claim: delivered, then the settlement's interrupt.
    const steerAt = recorder.order.indexOf("steer");
    const interruptAt = recorder.order.indexOf("interrupt");
    expect(steerAt).toBeGreaterThanOrEqual(0);
    expect(interruptAt).toBeGreaterThan(steerAt);

    await runtime.dispose();
  });

  test("a directive with no round to steer is carried into the next round's prompt", async () => {
    /*
     * Decision 12's second clause, at this seam: the supervisor does not open the fallback
     * round — the goal agent's tool does, through `RoundOpener` — but the directive has to
     * reach the model, and the only place it can is the round's **opening prompt**. There is
     * no directive storage anywhere (decision 12: the goal agent's own session is the
     * memory), so if `PlanInput.directive` did not reach the prompt there would be nothing
     * left of it at all.
     */
    const recorder = emptyRecorder();
    const { scriptFor, releaseAll } = scripts({
      narration: [],
      status: undefined,
    });
    const { root, workspace, runtime, ready } = world(scriptFor, recorder);
    await ready;

    await runtime.runPromise(
      Effect.gen(function* () {
        const input = yield* goal(root, workspace, "goal_carried");
        const planner = yield* PlanSupervisor;
        return yield* planner.start({
          ...input,
          directive: "Start with the lockout path; the operator asked for it.",
        });
      }).pipe(Effect.orDie),
    );

    const prompt = recorder.prompts[0] ?? "";
    expect(prompt).toContain("A DIRECTIVE FROM THE GOAL AGENT");
    expect(prompt).toContain("Start with the lockout path");
    // Below the rules and above the briefing: a directive is not permission to ignore the
    // budget, the anchoring rule or the disposition, all of which are stated before it.
    expect(prompt.indexOf("THIS IS NOT OPTIONAL")).toBeLessThan(
      prompt.indexOf("A DIRECTIVE FROM THE GOAL AGENT"),
    );
    expect(prompt.indexOf("A DIRECTIVE FROM THE GOAL AGENT")).toBeLessThan(
      prompt.indexOf("THE RECORD FOLLOWS"),
    );

    await runtime.runPromise(releaseAll());
    await runtime.dispose();
  });
});
