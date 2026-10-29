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
  Layer,
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
import { FleetStore } from "../persistence/fleet";
import { operatorScope } from "../persistence/store";
import { PolicyHookNotInstalled } from "../policy/install";
import { TargetStores, withTargetStore } from "../persistence/targetStores";
import { WorkerEndpoints } from "../run/supervisor";
import {
  PlanSupervisor,
  STUB_ROUND_PROMPT,
  type PlanInput,
} from "./planSupervisor";

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
  readonly unregistrations: { sessionId: string; name: string }[];
  readonly interrupts: string[];
  /** The `parentSessionId` each `createSession` was handed, so lineage is checkable. */
  readonly parents: (string | undefined)[];
}

const emptyRecorder = (): Recorder => ({
  order: [],
  registrations: [],
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
      prompt: (sessionId, text) =>
        scriptFor(sessionId).promptFails === true
          ? Effect.fail(transport("session.prompt", "the harness refused it"))
          : Effect.sync(() => {
              recorder.order.push(`prompt:${text}`);
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
              script.status === undefined ? {} : { outcome: script.status },
            );
      },
      interruptSession: (sessionId) =>
        Effect.andThen(
          Effect.sync(() => {
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
  const layer = Layer.mergeAll(
    fleet,
    stores,
    credentials,
    PlanSupervisor.layerWith({
      ...(options?.askTimeout === undefined
        ? {}
        : { askTimeout: options.askTimeout }),
      ...(options?.budget === undefined ? {} : { budget: options.budget }),
    }).pipe(
      Layer.provide(options?.resolver ?? HarnessResolver.single),
      Layer.provide(fakeClient(scriptFor, recorder, options?.faults ?? {})),
      Layer.provide(stores),
      Layer.provide(fleet),
      Layer.provide(credentials),
      Layer.provide(
        Layer.succeed(
          WorkerEndpoints,
          WorkerEndpoints.of({
            urls: Effect.succeed({
              mcp: "http://127.0.0.1:9/api/v1/mcp",
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
  return { root, workspace, runtime, ready, registry };
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
      `prompt:${STUB_ROUND_PROMPT("goal_one")}`,
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
    expect(refused.failure.reason).toBe("goal_busy");
    // Named, not merely refused: a second browser tab's operator has to be told which
    // round is holding the goal (the spec's §5, condition 3).
    const winner = wins[0];
    if (winner?._tag !== "Success") throw new Error("expected a start");
    expect(refused.failure.detail).toContain(winner.success.roundId);
    expect(refused.failure.detail).toContain("goal_one");

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
    expect(outcome.refused.failure.reason).toBe("harness_not_ready");
    if (outcome.again._tag !== "Failure") throw new Error("expected refusal");
    expect(outcome.again.failure.reason).toBe("harness_not_ready");
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
    expect(outcome.refused.failure.reason).toBe("goal_not_active");
    expect(outcome.refused.failure.detail).toContain("abandoned");
    if (outcome.again._tag !== "Failure") throw new Error("expected refusal");
    expect(outcome.again.failure.reason).toBe("goal_not_active");

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
    expect(refused.failure.reason).toBe("goal_not_found");

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
      expect(outcome.refused.failure.reason).toBe(fault.reason);
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
    expect(refused.failure.reason).toBe("store_unavailable");

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
    expect(refused.failure.reason).toBe("harness_unreachable");

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
    expect(refused.failure.reason).toBe("unknown_round");
    // The sentence has to point an operator at the sweep, because a row that still says
    // `running` after a crash has no fiber here to interrupt.
    expect(refused.failure.detail).toContain("startup sweep");
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
