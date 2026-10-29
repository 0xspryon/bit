/**
 * Real-SQLite tests for the detached run.
 *
 * Every claim here is a *behaviour* rather than a type, and each one was a property the
 * single-effect `runWorkerPhase` could not have:
 *
 * 1. **A start returns before the run finishes.** Asserted against a session that is still
 *    going when the start call has already answered, not against a timing measurement.
 * 2. **Two runs against two targets write to their own files, at once.** The reason this is
 *    the interesting concurrency case and not two runs against one target: it is what the
 *    pinned MCP store made impossible, so it is the thing dispatch-by-credential buys.
 * 3. **A stop settles and revokes.** Both, read back from the attempt row and the
 *    credential registry rather than taken from the response.
 * 4. **A supervisor whose stream dies reconciles rather than infers.** Three versions of
 *    it, because "nothing to infer from" has three shapes: the narration stream fails, the
 *    long poll fails, and both fail with the harness unable to say anything either.
 * 5. **Lifecycle events land in sequence order.** `attempt.started` then
 *    `attempt.settled`, in one target's own log, with the three caller-authority columns
 *    null on both.
 *
 * ## The harness is a fake, and the fake is the point
 *
 * The supervisor's job is everything *around* the agent: what is forked where, what the
 * attempt row says afterwards, which credential still resolves, what reaches the
 * narration bus. A real `opencode` would make each of those assertions wait on a model
 * and a provider login, and — worse — would make "the stream died" and "the harness cannot
 * answer" states a test could not produce on demand. So the client is a fake whose every
 * answer a test chooses, and the real harness is exercised separately against a live
 * server.
 *
 * What is **not** faked: the fleet, the two target databases, the credential registry, the
 * narration bus and the supervisor itself. The attempt rows these tests read are rows in
 * files on disk, which is why this suite is part of `test:persistence`.
 */
import type { ModelOptionSelection } from "@bit/contracts";
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
  ManagedRuntime,
  Redacted,
  Stream,
  type Duration,
} from "effect";

import {
  AgentHarness,
  type HarnessNarration,
  type NarrationDetail,
  type TerminalOutcome,
} from "../harness/agentHarness";
import { newClaudeCodeSessionId } from "../harness/claudeCodeClient";
import { HarnessTransportError } from "../harness/errors";
import { newOpenCodeSessionId } from "../harness/openCodeClient";
import {
  DriverKind,
  defaultInstanceIdForDriver,
  type HarnessInstance,
} from "../harness/identity";
import { HarnessResolver } from "../harness/resolver";
import { stubHarness, STUB_INSTANCE } from "../harness/stubHarness";
import { ControlPlaneEndpoint } from "../http/controlPlane";
import { McpCredentials } from "../mcp/credentials";
import { McpCallCounter } from "../mcp/server";
import { FleetStore } from "../persistence/fleet";
import type { ObservationStore } from "../persistence/store";
import * as identifier from "../persistence/identifier";
import { TargetStores, withTargetStore } from "../persistence/targetStores";
import {
  CLAUDE_SETTINGS_PATH,
  installClaudeCodeGate,
} from "../policy/claudeCodeGate";
import { installOpenCodeGate, POLICY_PLUGIN_PACKAGE } from "../policy/install";
import { PERMISSIVE_POLICY, PolicyDecisions } from "../policy/service";
import { RunNarrations, type RunNarration } from "./narration";
import {
  WorkerEndpoints,
  RunSupervisor,
  settlementFor,
  chooseHarness,
  type RunInput,
  type SupervisionEnd,
} from "./supervisor";
import { readRecordedTranscript, transcriptFilesFor } from "./transcript";

const directories: string[] = [];
afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true });
  }
});

const newRoot = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "bit-supervisor-"));
  directories.push(directory);
  return join(directory, "fleet");
};

/* ── The fake harness ────────────────────────────────────────────────────────── */

/**
 * What one scripted session does, and what a test can watch it do.
 *
 * `settle` is a `Deferred` the test completes to let `waitForIdle` return, which is how a
 * test holds a run open for as long as it needs to assert that the start call has already
 * come back. `narrate` is a queue the test pushes entries onto. Neither has a timer in
 * it: a test that slept would be asserting about a schedule rather than about the
 * supervisor.
 */
interface Script {
  /** Resolved by the test to let the long poll return. Fail it to break the poll. */
  readonly settle: Deferred.Deferred<void, HarnessTransportError>;
  /** Entries the narration stream emits, then it stays open until interrupted. */
  readonly narration: readonly HarnessNarration[];
  /** How the narration stream ends: `open` stays up, `fail` breaks it. */
  readonly stream: "open" | "fail";
  /** What `session.get` answers. `undefined` is "no outcome on the session". */
  readonly status: TerminalOutcome | undefined;
  /** When true, `session.get` fails: the harness cannot be asked at all. */
  readonly statusUnreachable?: boolean;
  /**
   * When true, `session.get` never answers.
   *
   * Different from `statusUnreachable` in the way that matters to a bound: a failure
   * returns, a silence does not, and only the second can hang a shutdown.
   */
  readonly statusHangs?: boolean;
}

interface Recorder {
  readonly prompts: string[];
  readonly registrations: { name: string; url: string; bearer: string }[];
  /** Registrations taken back, so "the entry went with the credential" is checkable. */
  readonly unregistrations: { sessionId: string; name: string }[];
  readonly interrupts: string[];
  readonly created: string[];
  /** What each `createSession` was handed of the model, after the supervisor resolved it. */
  readonly sessionOptions: (readonly ModelOptionSelection[] | undefined)[];
}

const transport = (operation: string, detail: string) =>
  new HarnessTransportError({
    operation,
    status: undefined,
    tag: "TestError",
    detail,
    cause: detail,
  });

const narration = (
  type: string,
  sequence: number,
  outcome?: TerminalOutcome,
  /**
   * What the entry is, as this application reads it.
   *
   * `opaque` by default, because nothing in this suite is about rendering: the supervisor
   * forwards whatever the harness says to the narration bus without reading `detail`, and
   * a test that had to name a detail per entry would be stating a dependency the
   * supervisor does not have. The suite that *is* about rendering is
   * `run/liveTranscript.test.ts`.
   */
  detail: NarrationDetail = { _tag: "opaque" },
): HarnessNarration => ({
  type,
  sequence,
  at: 1_700_000_000_000 + sequence,
  outcome,
  detail,
});

/**
 * A client that answers from a script, keyed by session id.
 *
 * `scriptFor` is a function rather than a map so a test can hand one script to every
 * session without naming the ids the supervisor is about to mint — the supervisor mints
 * them, which is the behaviour under test in §5 of the brief, so a test cannot know them
 * in advance.
 */
const fakeClient = (
  scriptFor: (sessionId: string) => Script,
  recorder: Recorder,
  options?: {
    /**
     * The gate installer to use, and the only thing these tests vary per harness.
     *
     * Defaults to the stub's no-op, which is what most of this file wants: the gate has
     * its own suite and a filesystem write per test would be noise. The
     * "same supervisor, both harnesses" block below passes the two **real** installers,
     * which is how the claim that neither needs a branch here is actually checked.
     */
    readonly installGate?: AgentHarness["Service"]["installGate"];
    /** Mints ids in a given harness's format, so a test can see which one ran. */
    readonly newSessionId?: () => string;
  },
): Layer.Layer<AgentHarness> =>
  Layer.succeed(
    AgentHarness,
    stubHarness({
      ...(options?.installGate === undefined
        ? {}
        : { installGate: options.installGate }),
      ...(options?.newSessionId === undefined
        ? {}
        : { newSessionId: options.newSessionId }),
      registerMcpServer: (_sessionId, name, config) =>
        Effect.sync(() => {
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
      createSession: (input) =>
        Effect.sync(() => {
          // Honours the id it is handed, like both real harnesses were verified to do. A
          // test for the case where it does *not* is below, and overrides this.
          const id = input.sessionId ?? "ses_chosen_by_harness";
          recorder.created.push(id);
          recorder.sessionOptions.push(input.options);
          return { id };
        }),
      prompt: (sessionId, text) =>
        Effect.sync(() => {
          recorder.prompts.push(`${sessionId}:${text}`);
        }),
      waitForIdle: (sessionId) => Deferred.await(scriptFor(sessionId).settle),
      sessionStatus: (sessionId) => {
        const script = scriptFor(sessionId);
        if (script.statusHangs === true) return Effect.never;
        return script.statusUnreachable === true
          ? Effect.fail(transport("session.get", "the harness is unreachable"))
          : Effect.succeed(
              script.status === undefined ? {} : { outcome: script.status },
            );
      },
      messages: () => Effect.succeed([]),
      interruptSession: (sessionId) =>
        Effect.andThen(
          Effect.sync(() => {
            recorder.interrupts.push(sessionId);
          }),
          // A harness that will not answer `session.get` will not answer this either, so
          // the script's silence covers both asks the finalizer makes.
          scriptFor(sessionId).statusHangs === true
            ? Effect.never
            : Effect.succeed(true),
        ),
      sessionEvents: (sessionId) => {
        const script = scriptFor(sessionId);
        const emitted = Stream.fromIterable(script.narration);
        return script.stream === "fail"
          ? Stream.concat(
              emitted,
              Stream.fail(transport("event.subscribe", "the socket dropped")),
            )
          : // Stays open after the scripted entries, like a real subscription does: it
            // ends when the consuming fiber is interrupted and not before.
            Stream.concat(emitted, Stream.never);
      },
    }),
  );

/* ── The world under test ────────────────────────────────────────────────────── */

const emptyRecorder = (): Recorder => ({
  prompts: [],
  registrations: [],
  unregistrations: [],
  interrupts: [],
  created: [],
  sessionOptions: [],
});

/**
 * A fleet with the given targets registered and swept, and a supervisor over it.
 *
 * `TargetStores.layer` and a real `FleetStore`, not `ofStore`: the point of two targets is
 * that the resolver has to pick between two files, and a resolver holding one entry could
 * not be wrong in the way this is checking it is not.
 */
const world = (
  targets: readonly string[],
  scriptFor: (sessionId: string) => Script,
  recorder: Recorder,
  options?: {
    readonly askTimeout?: Duration.Input | undefined;
    /** Endpoints that are not published yet, to hold a start where `main.ts` holds one. */
    readonly endpoints?: Layer.Layer<WorkerEndpoints> | undefined;
  },
) => {
  const root = newRoot();
  const fleet = FleetStore.layer(root);
  const stores = TargetStores.layer.pipe(Layer.provide(fleet));
  const supervisor =
    options?.askTimeout === undefined
      ? RunSupervisor.layer
      : RunSupervisor.layerWith({ askTimeout: options.askTimeout });
  const layer = Layer.mergeAll(
    fleet,
    stores,
    McpCredentials.layer,
    RunNarrations.layer,
    supervisor.pipe(
      // One instance in most of this file: the resolver in front of the seam is a wrapper
      // here rather than a choice, which is the point — nothing in the supervisor changed
      // shape when the choice arrived. The two-instance cases are in their own block.
      Layer.provide(HarnessResolver.single),
      Layer.provide(fakeClient(scriptFor, recorder)),
      Layer.provide(stores),
      Layer.provide(McpCredentials.layer),
      Layer.provide(RunNarrations.layer),
      Layer.provide(
        options?.endpoints ??
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
      for (const targetId of targets) {
        yield* registry.register({
          targetId,
          name: targetId,
          scopeNote: "the local fixture only",
        });
      }
      yield* registry.migrateFleet();
    }).pipe(Effect.orDie),
  );
  /**
   * The credential registry as a value, so a test can read it after `dispose()`.
   *
   * The service is a closure over a plain `Map`, so `size` runs with no context and keeps
   * answering once the layer's scope is gone — which is the only way to assert that a
   * shutdown revoked what it was supposed to.
   */
  const registry = runtime.runPromise(Effect.map(McpCredentials, (it) => it));
  return { root, runtime, ready, registry };
};

/**
 * How many events making a run's goal and intent writes: `goal.added`, then `intent.added`.
 *
 * Named so that an assertion about an attempt's position in the log reads as "after the
 * fixture" rather than as a bare number that happens to be 3.
 */
const FIXTURE_EVENTS = 2;

/** A target's `attempt.*` events: the run's own, without the fixture's. */
const attemptEventsOf = (
  store: Pick<ObservationStore["Service"], "eventsAfter">,
) =>
  Effect.map(store.eventsAfter(), (events) =>
    events.filter((event) => event.kind.startsWith("attempt.")),
  );

/** One target's rows, read straight off the file after the runtime is gone. */
const readAfterShutdown = (root: string, targetId: string) => {
  const database = new Database(
    join(root, "targets", targetId, "hunt.sqlite"),
    {
      readonly: true,
    },
  );
  try {
    return {
      attempts: database
        .query<
          {
            id: string;
            status: string;
            ended_at: number | null;
            model_options: string | null;
          },
          []
        >(
          "SELECT id, status, ended_at, model_options FROM attempts ORDER BY started_at",
        )
        .all(),
      // The attempt's own lifecycle events. Making the goal and the intent a run claims
      // writes `goal.added` and `intent.added` ahead of them, and those are the fixture's,
      // not the run's: what these tests mean by "a run's events" is `attempt.*`.
      events: database
        .query<{ kind: string; subject_id: string }, []>(
          "SELECT kind, subject_id FROM events WHERE kind LIKE 'attempt.%' ORDER BY sequence",
        )
        .all(),
    };
  } finally {
    database.close();
  }
};

/**
 * One run's input, with a scratch workspace of its own.
 *
 * The workspace is real and per-target because starting a run now *writes* to it — the
 * pre-execution policy gate is installed there before the session is created — so a
 * shared `/tmp` would have every test in this file installing over every other, and
 * would leave a `.opencode` directory behind on the machine. `afterEach` removes the
 * whole temp root.
 *
 * The audit path sits beside the workspace rather than inside it, which is the same
 * arrangement the server uses for a real run and the same reason: a worker that can read
 * its own audit trail can read the shape of the boundary it is inside.
 */
const draft = (
  root: string,
  targetId: string,
  task: string,
  suggestion: {
    readonly suggestedInstanceId?: string;
    readonly suggestedModel?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const base = join(root, "..", "work", targetId);
    mkdirSync(base, { recursive: true });
    const stores = yield* TargetStores;
    // A run claims an intent that already exists, so the test makes one first, the way an
    // operator does: a goal, then an intent under it. The question is the prompt.
    const goalId = `goal_${identifier.prefixed("t")}`;
    const intentId = `int_${identifier.prefixed("t")}`;
    yield* withTargetStore(stores, targetId, (store) =>
      Effect.gen(function* () {
        const host = { callerScope: `${targetId}/operator`, targetId };
        yield* store.openGoal(host, {
          operationId: `op_${goalId}`,
          goalId,
          name: "",
          description: `Work out what ${targetId} does under load.`,
        });
        yield* store.addIntent(host, {
          operationId: `op_${intentId}`,
          goalId,
          intentId,
          question: task,
          anchorObservationIds: [],
          addressesDimension: null,
          ...suggestion,
        });
      }),
    ).pipe(Effect.orDie);
    return {
      targetId,
      intentId,
      workspace: base,
      auditPath: join(root, "..", "work", `${targetId}-policy-audit.log`),
      // The target's own `evidence/` directory, where a settled attempt's transcript lands.
      // Beside the workspace for the same reason the audit path is: outside it.
      evidenceDirectory: join(root, "targets", targetId, "evidence"),
      title: `bit: ${targetId}`,
    } satisfies RunInput;
  });

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

  /**
   * Lets the long poll for one session return, or fail.
   *
   * **Keyed by the session the test started, not by iterating what the map happens to
   * hold.** Iterating was a race: `scriptFor` creates an entry when the fake client is
   * first asked about a session, so a test that resolved "every script so far" could run
   * before the supervisor had asked about one — and the supervisor would then create a
   * *second*, unresolved entry and wait on it forever. Naming the session is
   * deterministic either way round, because `scriptFor` creates-or-gets.
   */
  const release = (
    sessionId: string,
    failure?: HarnessTransportError,
  ): Effect.Effect<void> =>
    Effect.asVoid(
      failure === undefined
        ? Deferred.succeed(scriptFor(sessionId).settle, undefined)
        : Deferred.fail(scriptFor(sessionId).settle, failure),
    );

  return { scriptFor, held, release };
};

/**
 * Lets every long poll the supervisor has actually opened return.
 *
 * Only for teardown, where the point is to let a runtime close without interrupting a
 * live run — not to drive a settlement a test then asserts on. Iterating is safe here
 * precisely because nothing is waiting on the result.
 */
const releaseAll = (held: ReadonlyMap<string, Script>): Effect.Effect<void> =>
  Effect.forEach(
    [...held.values()],
    (script) => Deferred.succeed(script.settle, undefined),
    { discard: true },
  );

/* ── The settlement table, on its own ────────────────────────────────────────── */

describe("what one ending settles to", () => {
  const ends: readonly SupervisionEnd[] = [
    { _tag: "waited" },
    { _tag: "waitFailed", detail: "the socket dropped" },
    { _tag: "stopped" },
    { _tag: "startFailed" },
  ];

  test("the harness's own session state wins whenever it has one", () => {
    for (const end of ends) {
      expect(
        settlementFor({ end, narrated: "failed", harness: "succeeded" }),
      ).toBe("succeeded");
    }
  });

  test("a narrated terminal event is used when the session state has none", () => {
    // Not a fallback for completeness: `opencode` 2.1.2's `session.get` carries no
    // `outcome` on a session that has not finished, so this is the common path.
    for (const end of ends) {
      expect(
        settlementFor({ end, narrated: "failed", harness: undefined }),
      ).toBe("failed");
    }
  });

  test("a stop with nothing else to go on is `interrupted`, not `failed`", () => {
    // The one status we know first-hand. `failed` would be a claim about the work.
    expect(
      settlementFor({
        end: { _tag: "stopped" },
        narrated: undefined,
        harness: undefined,
      }),
    ).toBe("interrupted");
  });

  test("everything else with nothing to go on is `uncertain`, never `failed`", () => {
    for (const end of ends) {
      if (end._tag === "stopped") continue;
      expect(
        settlementFor({ end, narrated: undefined, harness: undefined }),
      ).toBe("uncertain");
    }
  });
});

/* ── The detached run ────────────────────────────────────────────────────────── */

describe("starting a run", () => {
  test("returns while the run is still going", async () => {
    const recorder = emptyRecorder();
    const { scriptFor, held } = scripts({
      narration: [narration("session.execution.started", 1)],
      stream: "open",
      status: undefined,
    });
    const { root, runtime, ready } = world(["alpha"], scriptFor, recorder);
    await ready;

    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        const stores = yield* TargetStores;
        const credentials = yield* McpCredentials;

        const started = yield* supervisor.start(
          yield* draft(root, "alpha", "probe it"),
        );

        // The assertion that matters, and it is a state rather than a duration: nothing
        // has settled this attempt, because nothing has let the harness's long poll
        // return. If `start` had waited for the run, this row could not say `running`.
        const row = yield* withTargetStore(stores, "alpha", (store) =>
          store.loadAttempt(started.attemptId, "alpha"),
        );
        return {
          started,
          status: row?.status,
          session: row?.harness_session_id,
          supervising: yield* supervisor.running,
          liveCredentials: yield* credentials.size,
          prompts: [...recorder.prompts],
          registrations: [...recorder.registrations],
        };
      }).pipe(Effect.orDie),
    );

    expect(observed.status).toBe("running");
    expect(observed.supervising.map((entry) => entry.attemptId)).toEqual([
      observed.started.attemptId,
    ]);
    // The row names the session the harness was asked to create, which is the id we
    // minted — written before `createSession` was called, so a crash in that window
    // leaves a row pointing at a session recovery can ask about.
    expect(observed.session).toBe(observed.started.harnessSessionId);
    expect(recorder.created).toEqual([observed.started.harnessSessionId]);
    // Prompted, which is what makes this a run rather than an open session.
    expect(observed.prompts).toEqual([
      `${observed.started.harnessSessionId}:probe it`,
    ]);
    // One credential, delivered in the registration body and nowhere else.
    expect(observed.liveCredentials).toBe(1);
    expect(observed.registrations).toHaveLength(1);
    expect(observed.registrations[0]?.name).toBe(
      `bit-${observed.started.attemptId}`,
    );
    expect(observed.registrations[0]?.bearer).toMatch(/^Bearer [0-9a-f]{64}$/);

    // Let it finish, so the runtime's teardown is not interrupting a live run.
    await runtime.runPromise(releaseAll(held));
    await runtime.dispose();
  });

  test("settles from the harness once the run ends, and logs the pair in order", async () => {
    const recorder = emptyRecorder();
    const { scriptFor, release } = scripts({
      narration: [
        narration("session.execution.started", 1),
        narration("session.text.ended", 2),
        narration("session.execution.succeeded", 3, "succeeded"),
      ],
      stream: "open",
      status: "succeeded",
    });
    const { root, runtime, ready } = world(["alpha"], scriptFor, recorder);
    await ready;

    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        const stores = yield* TargetStores;
        const credentials = yield* McpCredentials;
        const started = yield* supervisor.start(
          yield* draft(root, "alpha", "probe it"),
        );

        // Let the long poll return, then wait for the supervisor to be gone from the
        // map — which only happens after its finalizer has settled and revoked.
        yield* release(started.harnessSessionId);
        yield* settled(supervisor, started.attemptId);

        const row = yield* withTargetStore(stores, "alpha", (store) =>
          store.loadAttempt(started.attemptId, "alpha"),
        );
        const events = yield* withTargetStore(stores, "alpha", (store) =>
          attemptEventsOf(store),
        );
        return {
          started,
          status: row?.status,
          ended: row?.ended_at,
          events,
          liveCredentials: yield* credentials.size,
        };
      }).pipe(Effect.orDie),
    );

    expect(observed.status).toBe("succeeded");
    expect(observed.ended).not.toBeNull();
    // Revoked by the fiber's scope closing, with no stop and nothing explicit asked for.
    expect(observed.liveCredentials).toBe(0);

    // The pair, in sequence order, in this target's own log.
    expect(observed.events.map((event) => event.kind)).toEqual([
      "attempt.started",
      "attempt.settled",
    ]);
    expect(observed.events.map((event) => event.sequence)).toEqual([
      FIXTURE_EVENTS + 1,
      FIXTURE_EVENTS + 2,
    ]);
    expect(observed.events.map((event) => event.subjectId)).toEqual([
      observed.started.attemptId,
      observed.started.attemptId,
    ]);
    // Caller authority absent on both, which is the invariant `contracts/event.ts`
    // states: neither is written by a worker presenting a credential.
    for (const event of observed.events) {
      expect(event.callerScope).toBeNull();
      expect(event.intentId).toBeNull();
      expect(event.attemptId).toBeNull();
      expect(event.targetId).toBe("alpha");
    }
    expect(observed.events[1]?.payload).toMatchObject({
      status: "succeeded",
      priorStatus: "running",
      settledBy: "supervisor",
    });
    await runtime.dispose();
  });

  test("takes the registration back when the credential is revoked", async () => {
    // DECISIONS.md §24.2, caveat 3: nothing used to call OpenCode's `mcp.remove`, so a
    // revoked credential left an entry still reported `connected`. The registration is
    // now scope-owned beside the credential, so settling a run takes both away.
    const recorder = emptyRecorder();
    const { scriptFor, release } = scripts({
      narration: [],
      stream: "open",
      status: "succeeded",
    });
    const { root, runtime, ready } = world(["alpha"], scriptFor, recorder);
    await ready;

    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        const credentials = yield* McpCredentials;
        const started = yield* supervisor.start(
          yield* draft(root, "alpha", "probe it"),
        );
        // While the run is live the registration stands: it is what the worker reaches
        // our endpoint through.
        const during = [...recorder.unregistrations];
        yield* release(started.harnessSessionId);
        yield* settled(supervisor, started.attemptId);
        return {
          started,
          during,
          after: [...recorder.unregistrations],
          liveCredentials: yield* credentials.size,
        };
      }).pipe(Effect.orDie),
    );

    expect(observed.during).toEqual([]);
    expect(observed.after).toEqual([
      {
        sessionId: observed.started.harnessSessionId,
        name: `bit-${observed.started.attemptId}`,
      },
    ]);
    // The credential went too, which is the pairing that matters: an entry without a
    // credential is misleading, and a credential without an entry is unreachable.
    expect(observed.liveCredentials).toBe(0);
    await runtime.dispose();
  });

  test("a harness that will not take the registration back does not fail the run", async () => {
    // Tidy-up must not become an outcome. A refused removal is logged and the attempt
    // still settles, because a settled attempt that reported a failure would look to the
    // operator like work that did not finish.
    const recorder = emptyRecorder();
    const { scriptFor, release } = scripts({
      narration: [],
      stream: "open",
      status: "succeeded",
    });
    const root = newRoot();
    const fleet = FleetStore.layer(root);
    const stores = TargetStores.layer.pipe(Layer.provide(fleet));
    const credentials = McpCredentials.layer;
    const stubborn = Layer.succeed(
      AgentHarness,
      AgentHarness.of({
        ...fakeHarnessShape(scriptFor, recorder),
        unregisterMcpServer: () =>
          Effect.fail(
            transport("mcp.remove", "the harness is no longer listening"),
          ),
      }),
    );
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        fleet,
        stores,
        credentials,
        RunSupervisor.layer.pipe(
          Layer.provide(HarnessResolver.single),
          Layer.provide(stubborn),
          Layer.provide(stores),
          Layer.provide(credentials),
          Layer.provide(RunNarrations.layer),
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
      ),
    );
    await runtime.runPromise(
      Effect.gen(function* () {
        const registry = yield* FleetStore;
        yield* registry.register({
          targetId: "alpha",
          name: "alpha",
          scopeNote: "",
        });
        yield* registry.migrateFleet();
      }).pipe(Effect.orDie),
    );

    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        const resolver = yield* TargetStores;
        const registry = yield* McpCredentials;
        const started = yield* supervisor.start(
          yield* draft(root, "alpha", "probe it"),
        );
        yield* release(started.harnessSessionId);
        yield* settled(supervisor, started.attemptId);
        const row = yield* withTargetStore(resolver, "alpha", (store) =>
          store.loadAttempt(started.attemptId, "alpha"),
        );
        return {
          status: row?.status,
          liveCredentials: yield* registry.size,
        };
      }).pipe(Effect.orDie),
    );

    expect(observed.status).toBe("succeeded");
    expect(observed.liveCredentials).toBe(0);
    await runtime.dispose();
  });

  test("rebinds and says so when the harness ignores the id it was handed", async () => {
    // Defence against a future harness, not against this one: `opencode` 2.1.2 honours a
    // supplied id, and the pre-assignment that closes the orphan-session window depends on
    // that. If a later build stops honouring it, the row must name the session that
    // actually exists rather than the one we asked for.
    const recorder = emptyRecorder();
    const { scriptFor, release } = scripts({
      narration: [],
      stream: "open",
      status: "succeeded",
    });
    const root = newRoot();
    const fleet = FleetStore.layer(root);
    const stores = TargetStores.layer.pipe(Layer.provide(fleet));
    const stubborn = Layer.succeed(
      AgentHarness,
      AgentHarness.of({
        ...fakeHarnessShape(scriptFor, recorder),
        createSession: () => Effect.succeed({ id: "ses_the_harness_chose" }),
      }),
    );
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        fleet,
        stores,
        RunSupervisor.layer.pipe(
          Layer.provide(HarnessResolver.single),
          Layer.provide(stubborn),
          Layer.provide(stores),
          Layer.provide(McpCredentials.layer),
          Layer.provide(RunNarrations.layer),
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
      ),
    );
    await runtime.runPromise(
      Effect.gen(function* () {
        const registry = yield* FleetStore;
        yield* registry.register({
          targetId: "alpha",
          name: "alpha",
          scopeNote: "",
        });
        yield* registry.migrateFleet();
      }).pipe(Effect.orDie),
    );

    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        const resolver = yield* TargetStores;
        const started = yield* supervisor.start(
          yield* draft(root, "alpha", "probe it"),
        );
        yield* release(started.harnessSessionId);
        yield* settled(supervisor, started.attemptId);
        const row = yield* withTargetStore(resolver, "alpha", (store) =>
          store.loadAttempt(started.attemptId, "alpha"),
        );
        return { started, bound: row?.harness_session_id };
      }).pipe(Effect.orDie),
    );

    expect(observed.started.harnessSessionId).toBe("ses_the_harness_chose");
    expect(observed.bound).toBe("ses_the_harness_chose");
    await runtime.dispose();
  });
});

describe("two runs at once, against two targets", () => {
  test("each writes to its own file and neither can see the other's", async () => {
    // The case the pinned MCP store made impossible. Both runs are in flight at the same
    // time — neither has been let settle when the rows are read — and each one's attempt,
    // goal, intent and events are in that target's own database.
    const recorder = emptyRecorder();
    const { scriptFor, held } = scripts({
      narration: [narration("session.execution.started", 1)],
      stream: "open",
      status: "succeeded",
    });
    const { root, runtime, ready } = world(
      ["alpha", "beta"],
      scriptFor,
      recorder,
    );
    await ready;

    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        const stores = yield* TargetStores;
        const credentials = yield* McpCredentials;

        const [alpha, beta] = yield* Effect.all(
          [
            supervisor.start(yield* draft(root, "alpha", "probe alpha")),
            supervisor.start(yield* draft(root, "beta", "probe beta")),
          ],
          { concurrency: 2 },
        );

        const read = (targetId: string) =>
          withTargetStore(stores, targetId, (store) =>
            Effect.gen(function* () {
              return {
                counts: yield* store.counts(),
                unsettled: yield* store.unsettledAttempts(),
                events: yield* attemptEventsOf(store),
              };
            }),
          );

        return {
          alpha,
          beta,
          inAlpha: yield* read("alpha"),
          inBeta: yield* read("beta"),
          supervising: yield* supervisor.running,
          liveCredentials: yield* credentials.size,
        };
      }).pipe(Effect.orDie),
    );

    // Two distinct runs, each supervised.
    expect(observed.alpha.attemptId).not.toBe(observed.beta.attemptId);
    expect(observed.liveCredentials).toBe(2);
    expect(
      [...observed.supervising]
        .map((entry) => entry.targetId)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual(["alpha", "beta"]);

    // One attempt in each file, and it is that target's own.
    expect(observed.inAlpha.counts.attempts).toBe(1);
    expect(observed.inBeta.counts.attempts).toBe(1);
    expect(observed.inAlpha.unsettled.map((row) => row.id)).toEqual([
      observed.alpha.attemptId,
    ]);
    expect(observed.inBeta.unsettled.map((row) => row.id)).toEqual([
      observed.beta.attemptId,
    ]);
    // Both still running when the files were read, which is what makes this concurrent
    // rather than two runs in sequence.
    expect(observed.inAlpha.unsettled[0]?.status).toBe("running");
    expect(observed.inBeta.unsettled[0]?.status).toBe("running");

    // Separate sequence counters, because they are separate files. Each log holds one
    // `attempt.started` for its own attempt and nothing of the other's.
    expect(observed.inAlpha.events.map((event) => event.sequence)).toEqual([
      FIXTURE_EVENTS + 1,
    ]);
    expect(observed.inBeta.events.map((event) => event.sequence)).toEqual([
      FIXTURE_EVENTS + 1,
    ]);
    expect(observed.inAlpha.events[0]?.subjectId).toBe(
      observed.alpha.attemptId,
    );
    expect(observed.inBeta.events[0]?.subjectId).toBe(observed.beta.attemptId);

    await runtime.runPromise(releaseAll(held));
    await runtime.dispose();
  });

  test("stopping one leaves the other running", async () => {
    const recorder = emptyRecorder();
    const { scriptFor, held } = scripts({
      narration: [],
      stream: "open",
      status: undefined,
    });
    const { root, runtime, ready } = world(
      ["alpha", "beta"],
      scriptFor,
      recorder,
    );
    await ready;

    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        const stores = yield* TargetStores;
        const alpha = yield* supervisor.start(
          yield* draft(root, "alpha", "probe alpha"),
        );
        const beta = yield* supervisor.start(
          yield* draft(root, "beta", "probe beta"),
        );
        const stopped = yield* supervisor.stop(alpha.attemptId);
        return {
          alpha,
          beta,
          stopped,
          supervising: yield* supervisor.running,
          alphaRow: yield* withTargetStore(stores, "alpha", (store) =>
            store.loadAttempt(alpha.attemptId, "alpha"),
          ),
          betaRow: yield* withTargetStore(stores, "beta", (store) =>
            store.loadAttempt(beta.attemptId, "beta"),
          ),
        };
      }).pipe(Effect.orDie),
    );

    expect(observed.alphaRow?.status).toBe("interrupted");
    expect(observed.betaRow?.status).toBe("running");
    expect(observed.supervising.map((entry) => entry.attemptId)).toEqual([
      observed.beta.attemptId,
    ]);

    await runtime.runPromise(releaseAll(held));
    await runtime.dispose();
  });
});

describe("stopping a run", () => {
  test("settles the attempt, revokes its authority and tells the harness", async () => {
    const recorder = emptyRecorder();
    const { scriptFor, held } = scripts({
      narration: [],
      stream: "open",
      // The harness has nothing to say about it, which is the honest state for a session
      // that was still working when it was told to stop.
      status: undefined,
    });
    const { root, runtime, ready } = world(["alpha"], scriptFor, recorder);
    await ready;

    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        const stores = yield* TargetStores;
        const credentials = yield* McpCredentials;
        const started = yield* supervisor.start(
          yield* draft(root, "alpha", "probe it"),
        );
        const before = yield* credentials.size;

        const stopped = yield* supervisor.stop(started.attemptId);

        return {
          started,
          stopped,
          before,
          after: yield* credentials.size,
          row: yield* withTargetStore(stores, "alpha", (store) =>
            store.loadAttempt(started.attemptId, "alpha"),
          ),
          events: yield* withTargetStore(stores, "alpha", (store) =>
            attemptEventsOf(store),
          ),
          supervising: yield* supervisor.running,
        };
      }).pipe(Effect.orDie),
    );

    // Settled, honestly: we interrupted it, so `interrupted` is first-hand rather than
    // inferred — and it is not `failed`, which would be a claim about the work.
    expect(observed.row?.status).toBe("interrupted");
    expect(observed.stopped.status).toBe("interrupted");
    // Authority withdrawn. Both halves: the in-memory grant is gone, and the response
    // says how many were dropped so a caller does not have to take it on trust.
    expect(observed.before).toBe(1);
    expect(observed.after).toBe(0);
    expect(observed.stopped.credentialsRevoked).toBe(1);
    // And the harness was told to stop, so "stop" means the agent stops touching the
    // target rather than that we stopped watching it.
    expect(recorder.interrupts).toEqual([observed.started.harnessSessionId]);
    // No fiber left behind.
    expect(observed.supervising).toEqual([]);
    // Both lifecycle events, in order.
    expect(observed.events.map((event) => event.kind)).toEqual([
      "attempt.started",
      "attempt.settled",
    ]);
    expect(observed.events[1]?.payload).toMatchObject({
      status: "interrupted",
      settledBy: "supervisor",
    });

    await runtime.runPromise(releaseAll(held));
    await runtime.dispose();
  });

  test("prefers the harness's answer when the session finished just before the stop", async () => {
    const recorder = emptyRecorder();
    const { scriptFor, held } = scripts({
      narration: [],
      stream: "open",
      status: "succeeded",
    });
    const { root, runtime, ready } = world(["alpha"], scriptFor, recorder);
    await ready;

    const row = await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        const stores = yield* TargetStores;
        const started = yield* supervisor.start(
          yield* draft(root, "alpha", "probe it"),
        );
        yield* supervisor.stop(started.attemptId);
        return yield* withTargetStore(stores, "alpha", (store) =>
          store.loadAttempt(started.attemptId, "alpha"),
        );
      }).pipe(Effect.orDie),
    );

    // Not `interrupted`: the harness says it succeeded, and recording what it says is
    // more accurate than recording what we did about it.
    expect(row?.status).toBe("succeeded");

    await runtime.runPromise(releaseAll(held));
    await runtime.dispose();
  });

  test("refuses an attempt this process is not running", async () => {
    const recorder = emptyRecorder();
    const { scriptFor } = scripts({
      narration: [],
      stream: "open",
      status: undefined,
    });
    const { runtime, ready } = world(["alpha"], scriptFor, recorder);
    await ready;

    const refusal = await runtime.runPromise(
      Effect.flatMap(RunSupervisor, (supervisor) =>
        Effect.result(supervisor.stop("att_nobody_is_running")),
      ),
    );

    expect(refusal._tag).toBe("Failure");
    if (refusal._tag === "Failure") {
      expect(refusal.failure.reason).toBe("unknown_attempt");
      // Points at the sweep rather than pretending it did something, because a row left
      // `running` by a dead process is the sweep's to settle, not a stop's.
      expect(refusal.failure.detail).toContain("startup sweep");
    }
    await runtime.dispose();
  });
});

describe("when the harness stops being readable", () => {
  test("a narration stream that dies does not settle the run", async () => {
    // The clearest form of "a stream ending is not an outcome": the stream fails
    // immediately and the run carries on, settled later by the harness's own answer.
    const recorder = emptyRecorder();
    const { scriptFor, release } = scripts({
      narration: [narration("session.execution.started", 1)],
      stream: "fail",
      status: "succeeded",
    });
    const { root, runtime, ready } = world(["alpha"], scriptFor, recorder);
    await ready;

    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        const stores = yield* TargetStores;
        const started = yield* supervisor.start(
          yield* draft(root, "alpha", "probe it"),
        );
        // The stream has already failed by now. Nothing has settled.
        const during = yield* withTargetStore(stores, "alpha", (store) =>
          store.loadAttempt(started.attemptId, "alpha"),
        );
        yield* release(started.harnessSessionId);
        yield* settled(supervisor, started.attemptId);
        return {
          started,
          during: during?.status,
          after: yield* withTargetStore(stores, "alpha", (store) =>
            store.loadAttempt(started.attemptId, "alpha"),
          ),
        };
      }).pipe(Effect.orDie),
    );

    expect(observed.during).toBe("running");
    expect(observed.after?.status).toBe("succeeded");
    await runtime.dispose();
  });

  test("a wait that loses its answer reconciles against the session, not against silence", async () => {
    const recorder = emptyRecorder();
    const { scriptFor, release } = scripts({
      narration: [],
      stream: "open",
      status: "failed",
    });
    const { root, runtime, ready } = world(["alpha"], scriptFor, recorder);
    await ready;

    const row = await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        const stores = yield* TargetStores;
        const started = yield* supervisor.start(
          yield* draft(root, "alpha", "probe it"),
        );
        // Break the long poll. Our request losing its answer says nothing about the
        // harness, so the supervisor has to go and ask.
        yield* release(
          started.harnessSessionId,
          transport("session.wait", "the long poll lost its answer"),
        );
        yield* settled(supervisor, started.attemptId);
        return yield* withTargetStore(stores, "alpha", (store) =>
          store.loadAttempt(started.attemptId, "alpha"),
        );
      }).pipe(Effect.orDie),
    );

    // `failed`, because the harness said so — not because our wait broke. A broken wait
    // on its own is never grounds for `failed`; the next test is that case.
    expect(row?.status).toBe("failed");
    await runtime.dispose();
  });

  test("nothing to ask and nothing narrated records `uncertain`, never `failed`", async () => {
    const recorder = emptyRecorder();
    const { scriptFor, release } = scripts({
      narration: [],
      stream: "fail",
      status: undefined,
      statusUnreachable: true,
    });
    const { root, runtime, ready } = world(["alpha"], scriptFor, recorder);
    await ready;

    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        const stores = yield* TargetStores;
        const credentials = yield* McpCredentials;
        const started = yield* supervisor.start(
          yield* draft(root, "alpha", "probe it"),
        );
        yield* release(
          started.harnessSessionId,
          transport("session.wait", "the harness went away"),
        );
        yield* settled(supervisor, started.attemptId);
        return {
          started,
          row: yield* withTargetStore(stores, "alpha", (store) =>
            store.loadAttempt(started.attemptId, "alpha"),
          ),
          recoveries: yield* withTargetStore(stores, "alpha", (store) =>
            store.recoveriesForAttempt(started.attemptId),
          ),
          liveCredentials: yield* credentials.size,
        };
      }).pipe(Effect.orDie),
    );

    // Three sources, none of which could say anything: the stream broke, the wait broke,
    // and the harness could not be asked. `uncertain` is the only honest answer, and the
    // attempt is left where a later definite answer can still refine it.
    expect(observed.row?.status).toBe("uncertain");
    // Authority is revoked anyway, which is the half of recovery that must not wait for
    // certainty: we do not know what happened, so the credential must not keep working.
    expect(observed.liveCredentials).toBe(0);
    // And no recovery record: the supervisor settles its own attempt, and filing that as
    // a recovery would make the sweep's table over-report every run it watched.
    expect(observed.recoveries).toEqual([]);
    // The prompt is never resubmitted on any of these paths.
    expect(recorder.prompts).toHaveLength(1);
    await runtime.dispose();
  });

  test("a prompt that is refused settles the attempt rather than leaving it running", async () => {
    const recorder = emptyRecorder();
    const { scriptFor } = scripts({
      narration: [],
      stream: "open",
      status: undefined,
      statusUnreachable: true,
    });
    const root = newRoot();
    const fleet = FleetStore.layer(root);
    const stores = TargetStores.layer.pipe(Layer.provide(fleet));
    const refusing = Layer.succeed(
      AgentHarness,
      AgentHarness.of({
        ...fakeHarnessShape(scriptFor, recorder),
        prompt: () =>
          Effect.fail(
            transport("session.prompt", "the model is not available"),
          ),
      }),
    );
    const credentials = McpCredentials.layer;
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        fleet,
        stores,
        credentials,
        RunSupervisor.layer.pipe(
          Layer.provide(HarnessResolver.single),
          Layer.provide(refusing),
          Layer.provide(stores),
          Layer.provide(credentials),
          Layer.provide(RunNarrations.layer),
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
      ),
    );
    await runtime.runPromise(
      Effect.gen(function* () {
        const registry = yield* FleetStore;
        yield* registry.register({
          targetId: "alpha",
          name: "alpha",
          scopeNote: "",
        });
        yield* registry.migrateFleet();
      }).pipe(Effect.orDie),
    );

    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        const resolver = yield* TargetStores;
        const registry = yield* McpCredentials;
        const refusal = yield* Effect.result(
          supervisor.start(yield* draft(root, "alpha", "probe it")),
        );
        // The finalizer settles on its own fiber, so wait for the supervisor to let go
        // before reading the row. Not a sleep: the condition is the thing being waited
        // for, and `start` has already returned its refusal by this point.
        yield* waitFor(supervisor.running, (running) => running.length === 0);
        const rows = yield* withTargetStore(resolver, "alpha", (store) =>
          store.unsettledAttempts(),
        );
        const all = yield* withTargetStore(resolver, "alpha", (store) =>
          store.counts(),
        );
        return {
          refusal,
          rows,
          attempts: all.attempts,
          supervising: yield* supervisor.running,
          liveCredentials: yield* registry.size,
        };
      }).pipe(Effect.orDie),
    );

    expect(observed.refusal._tag).toBe("Failure");
    if (observed.refusal._tag === "Failure") {
      expect(observed.refusal.failure.reason).toBe("harness_unreachable");
    }
    // The row was written before the prompt was sent, so it exists — and it is out of
    // `running` rather than left for the sweep to find, because this process watched the
    // prompt be refused.
    //
    // `uncertain` and not `interrupted`, because nobody interrupted anything; and not
    // `failed`, because a transport failure on `prompt` genuinely leaves it unknown
    // whether the harness accepted it before the answer was lost. It is still returned by
    // `unsettledAttempts` — that sweep reads `running` *and* `uncertain` on purpose, since
    // `uncertain` is an admission a later definite answer may refine — so the claim here
    // is about the status and the end time, not about the row being invisible.
    expect(observed.attempts).toBe(1);
    expect(observed.rows.map((row) => row.status)).toEqual(["uncertain"]);
    expect(observed.rows[0]?.ended_at).not.toBeNull();
    expect(observed.supervising).toEqual([]);
    expect(observed.liveCredentials).toBe(0);
    await runtime.dispose();
  });
});

describe("shutting the process down", () => {
  test("closing the supervisor's scope settles every run in flight and revokes it", async () => {
    /**
     * The other half of "the fiber is the ephemeral record", and the half `kill -9` does
     * not cover.
     *
     * A `SIGINT` closes the layer's scope, which runs the fiber map's finalizer, which
     * interrupts every entry; each interruption runs that supervisor's own finalizer,
     * which settles and revokes. Worth a test rather than an assumption for two reasons:
     * the fibers are forked as **daemons**, so it is not obvious they are still owned by
     * the map rather than detached from everything, and the difference it makes is a
     * restart finding settled attempts instead of a pile of `running` rows.
     *
     * Two runs, against two targets, neither let settle — so both are genuinely in flight
     * when the scope closes.
     */
    const recorder = emptyRecorder();
    const { scriptFor } = scripts({
      narration: [],
      stream: "open",
      // The harness has nothing to say: the honest state for a session that was still
      // working when the server was asked to stop.
      status: undefined,
    });
    const { root, runtime, ready, registry } = world(
      ["alpha", "beta"],
      scriptFor,
      recorder,
    );
    await ready;
    const credentials = await registry;

    const started = await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        const alpha = yield* supervisor.start(
          yield* draft(root, "alpha", "probe alpha"),
        );
        const beta = yield* supervisor.start(
          yield* draft(root, "beta", "probe beta"),
        );
        return {
          alpha,
          beta,
          supervising: (yield* supervisor.running).length,
          grants: yield* credentials.size,
        };
      }).pipe(Effect.orDie),
    );
    expect(started.supervising).toBe(2);
    expect(started.grants).toBe(2);

    // The shutdown. Bounded so a regression is a failing test rather than a hung suite.
    const began = Date.now();
    await Promise.race([
      runtime.dispose(),
      new Promise((_, reject) =>
        setTimeout(() => {
          reject(new Error("shutdown did not finish within 20s"));
        }, 20_000),
      ),
    ]);
    const took = Date.now() - began;

    // Both authorities withdrawn, read off the registry the layer is no longer holding.
    expect(await Effect.runPromise(credentials.size)).toBe(0);
    // And the harness was told to stop both sessions, because a server shutting down
    // should stop the agents it started rather than merely stop watching them.
    expect([...recorder.interrupts].sort((a, b) => a.localeCompare(b))).toEqual(
      [started.alpha.harnessSessionId, started.beta.harnessSessionId].sort(
        (a, b) => a.localeCompare(b),
      ),
    );

    for (const [targetId, run] of [
      ["alpha", started.alpha],
      ["beta", started.beta],
    ] as const) {
      const stored = readAfterShutdown(root, targetId);
      expect(stored.attempts).toHaveLength(1);
      // `interrupted`, not `running` and not `uncertain`: we interrupted it, which is
      // first-hand knowledge, and the row is settled before the process is gone.
      expect(stored.attempts[0]?.status).toBe("interrupted");
      expect(stored.attempts[0]?.id).toBe(run.attemptId);
      expect(stored.attempts[0]?.ended_at).not.toBeNull();
      // Both lifecycle events, in order, in that target's own file.
      expect(stored.events.map((event) => event.kind)).toEqual([
        "attempt.started",
        "attempt.settled",
      ]);
      expect(
        stored.events.every((event) => event.subject_id === run.attemptId),
      ).toBe(true);
    }

    // Nothing left for the sweep: a clean stop leaves no questions behind.
    expect(took).toBeLessThan(20_000);
  });

  test("a harness that will not answer during shutdown records `uncertain`, promptly", async () => {
    /**
     * The failure mode the bound exists for.
     *
     * Settling asks the harness over HTTP, and on shutdown that happens while the harness
     * child is itself being torn down — so the call may simply never come back. Without a
     * bound the client's own 30-second ceiling applies per call, per run, inside a scope
     * finalizer, and a `SIGINT` takes minutes.
     *
     * The ask is also made `interruptible` inside the finalizer, which this covers too: a
     * finalizer is an uninterruptible region, so a `timeout` that could not interrupt what
     * it bounds would not bound anything and this would hang.
     *
     * 150ms rather than the ten seconds a server uses, for the reason `layerWith` exists.
     */
    const recorder = emptyRecorder();
    const { scriptFor } = scripts({
      narration: [],
      stream: "open",
      status: undefined,
      // Never answers — not a failure, a silence, which is the harder case.
      statusHangs: true,
    });
    const { root, runtime, ready, registry } = world(
      ["alpha"],
      scriptFor,
      recorder,
      { askTimeout: "150 millis" },
    );
    await ready;
    const credentials = await registry;

    const started = await runtime.runPromise(
      Effect.flatMap(RunSupervisor, (supervisor) =>
        Effect.flatMap(draft(root, "alpha", "probe it"), (input) =>
          supervisor.start(input),
        ),
      ).pipe(Effect.orDie),
    );

    const began = Date.now();
    await Promise.race([
      runtime.dispose(),
      new Promise((_, reject) =>
        setTimeout(() => {
          reject(new Error("shutdown hung on an unanswering harness"));
        }, 10_000),
      ),
    ]);
    const took = Date.now() - began;

    const stored = readAfterShutdown(root, "alpha");
    // `interrupted` and not `uncertain`, even with the harness silent: we are the ones
    // who stopped it, so that much is first-hand. `settlementFor` only reaches
    // `uncertain` when nobody interrupted anything.
    expect(stored.attempts[0]?.id).toBe(started.attemptId);
    expect(stored.attempts[0]?.status).toBe("interrupted");
    expect(stored.attempts[0]?.ended_at).not.toBeNull();
    expect(await Effect.runPromise(credentials.size)).toBe(0);
    // Promptly: two bounded asks at 150ms each, not two unbounded ones. Generous enough
    // not to be flaky on a loaded machine, tight enough that losing the bound fails it.
    expect(took).toBeLessThan(5_000);
  });
});

describe("the narration bus", () => {
  test("publishes with no subscribers, and keyed so one attempt can be asked for", async () => {
    // Both halves of what this slice actually promises: a run narrates correctly into a
    // PubSub nobody is reading — which is the state the whole slice runs in — and a
    // subscriber asking for one attempt is handed that attempt's entries and no other's.
    const recorder = emptyRecorder();
    const { scriptFor, held } = scripts({
      narration: [
        narration("session.execution.started", 1),
        narration("session.text.ended", 2),
      ],
      stream: "open",
      status: "succeeded",
    });
    const { root, runtime, ready } = world(
      ["alpha", "beta"],
      scriptFor,
      recorder,
    );
    await ready;

    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        const narrations = yield* RunNarrations;

        // No subscribers yet, deliberately: this run's narration is published into a bus
        // nobody is listening to, and it must not fail, block or settle differently.
        const alpha = yield* supervisor.start(
          yield* draft(root, "alpha", "probe alpha"),
        );
        const unwatched = yield* narrations.subscriberCount;

        // Now one subscriber, asking for `beta` only.
        const collected = yield* Effect.forkChild(
          Stream.runCollect(
            Stream.take(narrations.subscribe({ targetId: "beta" }), 2),
          ),
        );
        // Yield until the subscription is registered, so the run below cannot publish
        // into the gap. Not a sleep: a check on the state that matters.
        yield* waitFor(narrations.subscriberCount, (n) => n === 1);

        const beta = yield* supervisor.start(
          yield* draft(root, "beta", "probe beta"),
        );
        const received: readonly RunNarration[] = yield* Fiber.join(collected);
        return { alpha, beta, unwatched, received };
      }).pipe(Effect.orDie),
    );

    expect(observed.unwatched).toBe(0);
    // Everything it got is beta's, by both keys, and in the order the harness said it.
    expect(observed.received.map((item) => item.targetId)).toEqual([
      "beta",
      "beta",
    ]);
    expect(observed.received.map((item) => item.attemptId)).toEqual([
      observed.beta.attemptId,
      observed.beta.attemptId,
    ]);
    expect(observed.received.map((item) => item.entry.type)).toEqual([
      "session.execution.started",
      "session.text.ended",
    ]);
    expect(observed.received[0]?.harnessSessionId).toBe(
      observed.beta.harnessSessionId,
    );

    await runtime.runPromise(releaseAll(held));
    await runtime.dispose();
  });
});

/* ── Small waits on state, rather than on the clock ──────────────────────────── */

/**
 * Polls one effect until a predicate holds.
 *
 * A short sleep in a loop rather than a `Deferred`, because what is being waited for is a
 * *consequence* of a fiber the test does not own — a supervisor's finalizer finishing, a
 * subscription registering — and there is no handle to await. Bounded so a broken
 * expectation fails the test instead of hanging the suite.
 */
const waitFor = <A>(
  read: Effect.Effect<A>,
  holds: (value: A) => boolean,
  attempts = 400,
): Effect.Effect<A> =>
  Effect.gen(function* () {
    for (let index = 0; index < attempts; index += 1) {
      const value = yield* read;
      if (holds(value)) return value;
      yield* Effect.sleep("5 millis");
    }
    return yield* read;
  });

/** Waits until the supervisor no longer holds a fiber for this attempt. */
const settled = (
  supervisor: RunSupervisor["Service"],
  attemptId: string,
): Effect.Effect<void> =>
  Effect.asVoid(
    waitFor(supervisor.running, (running) =>
      running.every((entry) => entry.attemptId !== attemptId),
    ),
  );

/** The fake client's methods, for a test that overrides exactly one of them. */
const fakeHarnessShape = (
  scriptFor: (sessionId: string) => Script,
  recorder: Recorder,
): AgentHarness["Service"] => {
  let captured: AgentHarness["Service"] | undefined;
  Effect.runSync(
    Effect.provide(
      Effect.map(AgentHarness, (service) => {
        captured = service;
      }),
      fakeClient(scriptFor, recorder),
    ),
  );
  if (captured === undefined) throw new Error("the fake client did not build");
  return captured;
};

/* ── One supervisor, two harnesses ───────────────────────────────────────────── */

/**
 * The claim this slice is actually making, as a test.
 *
 * Everything above drives *a* harness. This block drives **both**, through the same
 * `RunSupervisor.layer`, and the only thing that differs between the two runs is which
 * implementation of `AgentHarness` is provided. There is no parameter in the supervisor to
 * set, no `switch` to exercise and no driver kind reachable from it — the supervisor's
 * requirement is one service, so a branch on driver would have had nothing to branch on.
 *
 * Each run is asserted end to end, and the chain is the point:
 *
 * 1. the supervisor calls `installGate`, and that harness's real installer writes its real
 *    artefacts into the workspace — an OpenCode plugin plus `.opencode/opencode.json`, or a
 *    Claude Code hook script plus `.claude/settings.local.json`;
 * 2. the gate is then **invoked the way that harness invokes it** — an imported plugin
 *    module for one, a spawned process for the other — against the **real policy route on
 *    a real listener**;
 * 3. the control plane records a decision, which is what proves the gate was consulted
 *    rather than merely configured;
 * 4. the run settles, and the attempt row says `succeeded` and names the instance it ran
 *    on.
 *
 * The session id is minted by each harness in its own format, so the row also shows which
 * one ran: `ses_…` for OpenCode, a UUID for Claude Code.
 */
describe("one supervisor, two harnesses", () => {
  /**
   * A world with a real control plane, so the policy URL the gate is handed works.
   *
   * Separate from {@link world} above, which has no listener because nothing else in this
   * file needs one — and a listener per test in a suite this size would be a port per
   * test for no assertion.
   */
  const gatedWorld = (
    targetId: string,
    scriptFor: (sessionId: string) => Script,
    recorder: Recorder,
    harness: {
      readonly installGate: AgentHarness["Service"]["installGate"];
      readonly newSessionId: () => string;
    },
  ) => {
    const root = newRoot();
    const fleet = FleetStore.layer(root);
    const stores = TargetStores.layer.pipe(Layer.provide(fleet));
    const credentials = McpCredentials.layer;
    const endpoint = ControlPlaneEndpoint.layer({
      policy: PERMISSIVE_POLICY,
    }).pipe(
      Layer.provideMerge(credentials),
      Layer.provideMerge(McpCallCounter.layer),
      Layer.provideMerge(PolicyDecisions.layer),
      Layer.provide(stores),
    );
    const layer = Layer.mergeAll(
      fleet,
      stores,
      endpoint,
      RunSupervisor.layer.pipe(
        Layer.provide(HarnessResolver.single),
        Layer.provide(
          fakeClient(scriptFor, recorder, {
            installGate: harness.installGate,
            newSessionId: harness.newSessionId,
          }),
        ),
        Layer.provide(stores),
        Layer.provide(credentials),
        Layer.provide(RunNarrations.layer),
        Layer.provide(
          WorkerEndpoints.fromEndpoint.pipe(Layer.provide(endpoint)),
        ),
      ),
    );
    const runtime = ManagedRuntime.make(layer);
    const ready = runtime.runPromise(
      Effect.gen(function* () {
        const registry = yield* FleetStore;
        yield* registry.register({
          targetId,
          name: targetId,
          scopeNote: "the local fixture only",
        });
        yield* registry.migrateFleet();
      }).pipe(Effect.orDie),
    );
    return { root, runtime, ready };
  };

  /**
   * Calls the OpenCode plugin the supervisor installed, the way `opencode serve` does.
   *
   * A dynamic import of the file in the workspace — not of `plugins/policyHook.ts` — so a
   * broken copy, a bad path, or a plugin that no longer default-exports `{ id, setup }` is
   * caught here rather than silently producing an ungated run.
   */
  const invokeOpenCodeGate = async (workspace: string, tool: string) => {
    const configPath = join(workspace, ".opencode", "opencode.json");
    const config = JSON.parse(await Bun.file(configPath).text()) as {
      plugins: { package: string; options: Record<string, unknown> }[];
    };
    const entry = config.plugins.find(
      (plugin) => plugin.package === POLICY_PLUGIN_PACKAGE,
    );
    if (entry === undefined) throw new Error("no plugin entry was installed");
    const hookPath = join(workspace, ".opencode", "policy", "index.ts");
    const module = (await import(`${hookPath}?v=${String(Date.now())}`)) as {
      default: {
        setup: (ctx: {
          options: Record<string, unknown>;
          tool: {
            hook: (
              name: "execute.before",
              handler: (event: {
                tool: string;
                sessionID: string;
                input: unknown;
              }) => Promise<void>,
            ) => void;
          };
        }) => Promise<void>;
      };
    };
    let before:
      | ((event: {
          tool: string;
          sessionID: string;
          input: unknown;
        }) => Promise<void>)
      | undefined;
    await module.default.setup({
      options: entry.options,
      tool: {
        hook: (_name, handler) => {
          before = handler;
        },
      },
    });
    if (before === undefined) throw new Error("the hook registered no handler");
    // It must not throw: this scope permits.
    await before({
      tool,
      sessionID: "ses_gated",
      input: { url: "https://x.test/" },
    });
  };

  /**
   * Spawns the Claude Code hook the supervisor installed, the way the CLI does.
   *
   * The command and argv come out of the settings we wrote, so an entry pointing at a file
   * we did not write, or carrying argv the script does not parse, fails here instead of
   * producing an ungated run.
   */
  const invokeClaudeCodeGate = async (workspace: string, tool: string) => {
    const settings = JSON.parse(
      await Bun.file(join(workspace, CLAUDE_SETTINGS_PATH)).text(),
    ) as {
      hooks: { PreToolUse: { hooks: { command: string; args: string[] }[] }[] };
    };
    const entry = settings.hooks.PreToolUse[0]?.hooks[0];
    if (entry === undefined) throw new Error("no hook entry was installed");
    const child = Bun.spawn([entry.command, ...entry.args], {
      stdin: new TextEncoder().encode(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: tool,
          session_id: "11111111-0000-4000-8000-00000000gate".replace(
            "gate",
            "0001",
          ),
          tool_input: { url: "https://x.test/" },
        }),
      ),
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await child.exited;
    // 0, not 2: this scope permits, and anything but 0 would mean the gate refused.
    if (code !== 0) {
      throw new Error(
        `the installed Claude Code gate exited ${String(code)}: ${await new Response(child.stderr).text()}`,
      );
    }
  };

  const harnesses = [
    {
      driver: "opencode",
      installGate: installOpenCodeGate,
      newSessionId: newOpenCodeSessionId,
      sessionShape: /^ses_/,
      invoke: invokeOpenCodeGate,
      tool: "webfetch",
    },
    {
      driver: "claude-code",
      installGate: installClaudeCodeGate,
      newSessionId: newClaudeCodeSessionId,
      sessionShape:
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      invoke: invokeClaudeCodeGate,
      tool: "WebFetch",
    },
  ] as const;

  for (const harness of harnesses) {
    test(`a run on ${harness.driver} settles, and its gate is consulted`, async () => {
      const targetId = `target-${harness.driver}`;
      const recorder = emptyRecorder();
      const { scriptFor, release, held } = scripts({
        narration: [],
        stream: "open",
        status: "succeeded",
      });
      const { root, runtime, ready } = gatedWorld(
        targetId,
        scriptFor,
        recorder,
        harness,
      );
      await ready;
      try {
        const input = await runtime.runPromise(
          draft(root, targetId, "probe the limiter").pipe(Effect.orDie),
        );
        const started = await runtime.runPromise(
          Effect.flatMap(RunSupervisor, (supervisor) =>
            supervisor.start(input),
          ).pipe(Effect.orDie),
        );

        // The session id is the harness's own format, which is what makes "which harness
        // ran this" readable from the row rather than inferred from the configuration.
        expect(started.harnessSessionId).toMatch(harness.sessionShape);
        // And the attempt is pinned to the instance that ran it.
        expect(started.instanceId).toBe(STUB_INSTANCE.instanceId);

        // The gate the supervisor installed, invoked the way this harness invokes it,
        // against the real policy route.
        await harness.invoke(input.workspace, harness.tool);

        const decisions = await runtime.runPromise(
          Effect.flatMap(PolicyDecisions, (recorded) => recorded.all),
        );
        // A decision *row*, not a config assertion: the control plane decided this call.
        expect(decisions).toHaveLength(1);
        expect(decisions[0]).toMatchObject({
          tool: harness.tool,
          effect: "allow",
          // The same basis vocabulary from both gates, so one reader handles either trail.
          basis: "unrestricted",
        });

        // And the audit line, outside the workspace the worker runs in.
        const audit = await Bun.file(input.auditPath).text();
        expect(JSON.parse(audit.trim())).toMatchObject({
          tool: harness.tool,
          outcome: "allowed",
          basis: "unrestricted",
        });
        // Not *inside* the workspace: compared with a separator, because the audit sits
        // beside the workspace and a bare prefix check would read `…/work/t-audit.log` as
        // being under `…/work/t`.
        expect(input.auditPath.startsWith(`${input.workspace}/`)).toBe(false);

        // Settlement, from the harness's own answer.
        await runtime.runPromise(release(started.harnessSessionId));
        await runtime.runPromise(
          Effect.flatMap(RunSupervisor, (supervisor) =>
            settled(supervisor, started.attemptId),
          ),
        );
      } finally {
        await runtime.runPromise(releaseAll(held));
        await runtime.dispose();
      }

      const rows = readAfterShutdown(root, targetId);
      expect(rows.attempts).toHaveLength(1);
      expect(rows.attempts[0]?.status).toBe("succeeded");
      expect(rows.events.map((event) => event.kind)).toEqual([
        "attempt.started",
        "attempt.settled",
      ]);
    });
  }

  test("a second concurrent run in the same folder is refused, not queued", async () => {
    // Nothing else enforces one run at a time: slice A detached runs so they outlive the
    // request, and neither the route nor `start` had a guard. Two workers in one folder can
    // misattribute each other's writes — both harnesses configure the gate per folder, so
    // the second install repoints the first run's audit, and OpenCode registers its MCP
    // endpoint per folder, so each worker would see the other's. Provenance is the thing
    // this system exists to get right, so this refuses.
    const targetId = "target-busy";
    const recorder = emptyRecorder();
    const { scriptFor, release, held } = scripts({
      narration: [],
      stream: "open",
      status: "succeeded",
    });
    const { root, runtime, ready } = gatedWorld(targetId, scriptFor, recorder, {
      installGate: installOpenCodeGate,
      newSessionId: newOpenCodeSessionId,
    });
    await ready;
    try {
      const input = await runtime.runPromise(
        draft(root, targetId, "probe the limiter").pipe(Effect.orDie),
      );
      const first = await runtime.runPromise(
        Effect.flatMap(RunSupervisor, (supervisor) =>
          supervisor.start(input),
        ).pipe(Effect.orDie),
      );

      // A different intent in the same folder: the first intent is claimed, and a second
      // run of *it* would be refused for that reason, which is not what this test is about.
      const other = await runtime.runPromise(
        draft(root, targetId, "probe something else").pipe(Effect.orDie),
      );
      const second = await runtime.runPromise(
        Effect.result(
          Effect.flatMap(RunSupervisor, (supervisor) =>
            supervisor.start(other),
          ),
        ),
      );
      expect(second._tag).toBe("Failure");
      if (second._tag === "Failure") {
        expect(second.failure.reason).toBe("workspace_busy");
        // Names the run holding it and the folder, so an operator reads why rather than
        // guessing.
        expect(second.failure.detail).toContain(first.attemptId);
        expect(second.failure.detail).toContain(input.workspace);
      }
      // Nothing of the second run exists: no session created, nothing prompted, and — the
      // part that matters — no second gate installed over the first run's.
      expect(recorder.created).toHaveLength(1);
      expect(recorder.prompts).toHaveLength(1);
      // And the refused run gave its intent back: a start that refuses after the claim was
      // taken must not leave the intent `claimed` by an attempt that never existed.
      const refusedIntent = await runtime.runPromise(
        Effect.flatMap(TargetStores, (stores) =>
          withTargetStore(stores, targetId, (store) =>
            store.intent(other.intentId),
          ),
        ).pipe(Effect.orDie),
      );
      expect(refusedIntent?.status).toBe("open");
      expect(refusedIntent?.claimedByAttemptId).toBeNull();

      // Keyed on what is *running*, so settling the first frees the folder. It settles
      // `succeeded` having recorded nothing, which returns its intent to `open` rather than
      // answering it, so the third run can take the same intent again.
      await runtime.runPromise(release(first.harnessSessionId));
      await runtime.runPromise(
        Effect.flatMap(RunSupervisor, (supervisor) =>
          settled(supervisor, first.attemptId),
        ),
      );
      const third = await runtime.runPromise(
        Effect.result(
          Effect.flatMap(RunSupervisor, (supervisor) =>
            supervisor.start(input),
          ),
        ),
      );
      expect(third._tag).toBe("Success");
      if (third._tag === "Success") {
        await runtime.runPromise(release(third.success.harnessSessionId));
      }
    } finally {
      await runtime.runPromise(releaseAll(held));
      await runtime.dispose();
    }

    // Two attempt rows, not three: the refused start wrote nothing at all.
    const rows = readAfterShutdown(root, targetId);
    expect(rows.attempts).toHaveLength(2);
  });

  test("a different folder is not blocked by a run in another one", async () => {
    // The claim is on the directory, not on the process: one engagement being worked on
    // must not stop another. This is the case a guard keyed on "any run at all" would get
    // wrong.
    const recorder = emptyRecorder();
    const { scriptFor, release, held } = scripts({
      narration: [],
      stream: "open",
      status: "succeeded",
    });
    const { root, runtime, ready } = gatedWorld(
      "target-one",
      scriptFor,
      recorder,
      { installGate: installOpenCodeGate, newSessionId: newOpenCodeSessionId },
    );
    await ready;
    try {
      const registry = await runtime.runPromise(FleetStore);
      await runtime.runPromise(
        registry
          .register({
            targetId: "target-two",
            name: "target-two",
            scopeNote: "the local fixture only",
          })
          .pipe(Effect.andThen(registry.migrateFleet()), Effect.orDie),
      );
      const started = [];
      for (const targetId of ["target-one", "target-two"]) {
        const outcome = await runtime.runPromise(
          Effect.result(
            Effect.flatMap(RunSupervisor, (supervisor) =>
              // `draft` gives each target its own folder, which is the point.
              Effect.flatMap(draft(root, targetId, "probe"), (input) =>
                supervisor.start(input),
              ),
            ),
          ),
        );
        expect(outcome._tag).toBe("Success");
        if (outcome._tag === "Success") started.push(outcome.success);
      }
      expect(started).toHaveLength(2);
      for (const run of started) {
        await runtime.runPromise(release(run.harnessSessionId));
      }
    } finally {
      await runtime.runPromise(releaseAll(held));
      await runtime.dispose();
    }
  });

  test("a Claude Code workspace whose settings we cannot parse refuses the run", async () => {
    // The gate is load-bearing: a workspace that cannot be gated refuses the run rather
    // than starting an ungated worker in it. Nothing has been prompted at that point, so
    // refusing costs an error message — and because the refusal happens before
    // `seedAttempt`, it writes *nothing at all*: no row to settle and nothing for a sweep
    // to find.
    const targetId = "target-unparseable";
    const recorder = emptyRecorder();
    const { scriptFor, held } = scripts({
      narration: [],
      stream: "open",
      status: "succeeded",
    });
    const { root, runtime, ready } = gatedWorld(targetId, scriptFor, recorder, {
      installGate: installClaudeCodeGate,
      newSessionId: newClaudeCodeSessionId,
    });
    await ready;
    try {
      const input = await runtime.runPromise(
        draft(root, targetId, "probe the limiter").pipe(Effect.orDie),
      );
      mkdirSync(join(input.workspace, ".claude"), { recursive: true });
      const theirs = "{ not json, and possibly precious\n";
      await Bun.write(join(input.workspace, CLAUDE_SETTINGS_PATH), theirs);

      const refusal = await runtime.runPromise(
        Effect.result(
          Effect.flatMap(RunSupervisor, (supervisor) =>
            supervisor.start(input),
          ),
        ),
      );
      expect(refusal._tag).toBe("Failure");
      if (refusal._tag === "Failure") {
        expect(refusal.failure.reason).toBe("workspace_ungated");
      }
      // Their file is untouched, and nothing was prompted.
      expect(
        await Bun.file(join(input.workspace, CLAUDE_SETTINGS_PATH)).text(),
      ).toBe(theirs);
      expect(recorder.prompts).toEqual([]);
      expect(recorder.created).toEqual([]);
    } finally {
      await runtime.runPromise(releaseAll(held));
      await runtime.dispose();
    }

    // No attempt row at all: the refusal is earlier than the seed, deliberately.
    const rows = readAfterShutdown(root, targetId);
    expect(rows.attempts).toEqual([]);
    expect(rows.events).toEqual([]);
  });
});

/* ── More than one instance, and the run pinned to the one it started on ─────── */

/**
 * Two configured harnesses, one supervisor, and nothing in the supervisor branching on them.
 *
 * This is the claim slice C makes about the picker: the choice arrives as a resolver *in
 * front of* `AgentHarness`, so the supervisor still requires one harness it cannot see a
 * second of. What the tests below check is the consequence — a run goes to the instance it
 * named, its row records that instance, and naming one this server cannot give is refused
 * before anything is written.
 */
describe("two configured instances", () => {
  const ALPHA_HARNESS = DriverKind.make("alpha");
  const BETA_HARNESS = DriverKind.make("beta");

  const instanceOf = (driver: DriverKind): HarnessInstance => ({
    ...STUB_INSTANCE,
    instanceId: defaultInstanceIdForDriver(driver),
    driver,
    displayName: `${driver} harness`,
    defaultModel: `${driver}/default`,
    models: [{ id: `${driver}/default` }, { id: `${driver}/other` }],
  });

  /** Which instance each prompt went to, which is what "pinned" has to be read off. */
  interface Routed {
    readonly prompted: { instanceId: string; model: string }[];
  }

  const harnessFor = (
    driver: DriverKind,
    scriptFor: (sessionId: string) => Script,
    recorder: Recorder,
    routed: Routed,
  ): AgentHarness["Service"] => {
    const instance = instanceOf(driver);
    const base = fakeHarnessShape(scriptFor, recorder);
    return AgentHarness.of({
      ...base,
      instance,
      // Minted in a shape that names the instance, so the attempt row and the recorder
      // both say which harness actually created the session.
      newSessionId: () => `ses_${driver}_${String(Math.random()).slice(2, 8)}`,
      modelProvenance: (model) => ({ providerId: driver, modelId: model }),
      createSession: (input) =>
        Effect.sync(() => {
          routed.prompted.push({
            instanceId: instance.instanceId,
            model: input.model,
          });
          const id = input.sessionId ?? "ses_chosen_by_harness";
          recorder.created.push(id);
          return { id };
        }),
    });
  };

  const twoInstanceWorld = (
    scriptFor: (sessionId: string) => Script,
    recorder: Recorder,
    routed: Routed,
    options?: { readonly betaBroken?: string },
  ) => {
    const root = newRoot();
    const fleet = FleetStore.layer(root);
    const stores = TargetStores.layer.pipe(Layer.provide(fleet));
    const credentials = McpCredentials.layer;
    const alpha = harnessFor(ALPHA_HARNESS, scriptFor, recorder, routed);
    const resolver = Layer.succeed(
      HarnessResolver,
      HarnessResolver.fromEntries([
        { instance: alpha.instance, harness: alpha },
        options?.betaBroken === undefined
          ? (() => {
              const beta = harnessFor(
                BETA_HARNESS,
                scriptFor,
                recorder,
                routed,
              );
              return { instance: beta.instance, harness: beta };
            })()
          : {
              instance: instanceOf(BETA_HARNESS),
              harness: undefined,
              reason: options.betaBroken,
              setup: "install beta",
            },
      ]),
    );
    const layer = Layer.mergeAll(
      fleet,
      stores,
      credentials,
      RunSupervisor.layer.pipe(
        Layer.provide(resolver),
        Layer.provide(stores),
        Layer.provide(credentials),
        Layer.provide(RunNarrations.layer),
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
        for (const targetId of ["alpha-target", "beta-target"]) {
          yield* registry.register({
            targetId,
            name: targetId,
            scopeNote: "the local fixture only",
          });
        }
        yield* registry.migrateFleet();
      }).pipe(Effect.orDie),
    );
    return { root, runtime, ready };
  };

  /**
   * A run on each instance, each pinned to the one it named.
   *
   * Read off the attempt row rather than off the start response, because the row is what
   * recovery and the transcript read path both use — and `0014` stores the instance with
   * nothing that updates it.
   */
  test("a run on each instance is pinned to it, in its row and in its provenance", async () => {
    const recorder = emptyRecorder();
    const routed: Routed = { prompted: [] };
    const { scriptFor, release } = scripts({
      narration: [],
      stream: "open",
      status: "succeeded",
    });
    const { root, runtime, ready } = twoInstanceWorld(
      scriptFor,
      recorder,
      routed,
    );
    await ready;

    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        const stores = yield* TargetStores;

        const onAlpha = yield* supervisor.start({
          ...(yield* draft(root, "alpha-target", "probe alpha")),
          instanceId: "alpha",
        });
        yield* release(onAlpha.harnessSessionId);
        const onBeta = yield* supervisor.start({
          ...(yield* draft(root, "beta-target", "probe beta")),
          instanceId: "beta",
          model: "beta/other",
        });
        yield* release(onBeta.harnessSessionId);

        const alphaRow = yield* withTargetStore(
          stores,
          "alpha-target",
          (store) => store.loadAttempt(onAlpha.attemptId, "alpha-target"),
        );
        const betaRow = yield* withTargetStore(stores, "beta-target", (store) =>
          store.loadAttempt(onBeta.attemptId, "beta-target"),
        );
        return { onAlpha, onBeta, alphaRow, betaRow };
      }).pipe(Effect.orDie),
    );

    // The response says which instance ran it, and the row agrees.
    expect(observed.onAlpha.instanceId).toBe("alpha");
    expect(observed.alphaRow?.harness_instance_id).toBe("alpha");
    expect(observed.onBeta.instanceId).toBe("beta");
    expect(observed.betaRow?.harness_instance_id).toBe("beta");

    // The session ids are in each harness's own format, so the *right* harness created
    // each session rather than one of them answering for both.
    expect(observed.onAlpha.harnessSessionId).toContain("ses_alpha_");
    expect(observed.onBeta.harnessSessionId).toContain("ses_beta_");

    // A model named goes through; a model not named takes that instance's own default,
    // and not the other instance's.
    expect(routed.prompted).toEqual([
      { instanceId: "alpha", model: "alpha/default" },
      { instanceId: "beta", model: "beta/other" },
    ]);
    expect(observed.onAlpha.providerId).toBe("alpha");
    expect(observed.onBeta.modelId).toBe("beta/other");

    await runtime.dispose();
  });

  test("a run that names no instance lands on the server's default", async () => {
    const recorder = emptyRecorder();
    const routed: Routed = { prompted: [] };
    const { scriptFor, release } = scripts({
      narration: [],
      stream: "open",
      status: "succeeded",
    });
    const { root, runtime, ready } = twoInstanceWorld(
      scriptFor,
      recorder,
      routed,
    );
    await ready;

    const started = await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        const run = yield* supervisor.start(
          yield* draft(root, "alpha-target", "probe it"),
        );
        yield* release(run.harnessSessionId);
        return run;
      }).pipe(Effect.orDie),
    );
    // The first configured instance, which is what makes `HARNESS` a preference order.
    expect(started.instanceId).toBe("alpha");
    await runtime.dispose();
  });

  /**
   * An unusable instance is refused before anything is written, with its own reason.
   *
   * **Nothing at all**: no attempt row and no workspace claim, which is why a second run
   * on the working instance in the same folder still starts. The refusal is
   * `harness_not_ready` rather than `harness_unreachable` because nothing was asked.
   */
  test("naming an instance that would not start is refused, and writes nothing", async () => {
    const recorder = emptyRecorder();
    const routed: Routed = { prompted: [] };
    const { scriptFor, release } = scripts({
      narration: [],
      stream: "open",
      status: "succeeded",
    });
    const { root, runtime, ready } = twoInstanceWorld(
      scriptFor,
      recorder,
      routed,
      { betaBroken: "beta would not start: no such binary" },
    );
    await ready;

    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        const input = yield* draft(root, "alpha-target", "probe it");
        const refused = yield* Effect.result(
          supervisor.start({ ...input, instanceId: "beta" }),
        );
        // The folder is free, so a run on the working instance in the same folder starts:
        // the refusal above claimed nothing.
        const after = yield* supervisor.start({
          ...input,
          instanceId: "alpha",
        });
        yield* release(after.harnessSessionId);
        return { refused, after };
      }).pipe(Effect.orDie),
    );

    expect(observed.refused._tag).toBe("Failure");
    if (observed.refused._tag === "Failure") {
      expect(observed.refused.failure.reason).toBe("harness_not_ready");
      expect(observed.refused.failure.detail).toContain("no such binary");
    }
    expect(observed.after.instanceId).toBe("alpha");
    // Exactly one session was created: the refused run never reached a harness.
    expect(recorder.created).toHaveLength(1);
    await runtime.dispose();
  });

  test("naming an instance this server does not configure is refused by name", async () => {
    const recorder = emptyRecorder();
    const routed: Routed = { prompted: [] };
    const { scriptFor, held } = scripts({
      narration: [],
      stream: "open",
      status: "succeeded",
    });
    const { root, runtime, ready } = twoInstanceWorld(
      scriptFor,
      recorder,
      routed,
    );
    await ready;

    const refused = await runtime.runPromise(
      Effect.result(
        Effect.flatMap(RunSupervisor, (supervisor) =>
          Effect.flatMap(draft(root, "alpha-target", "probe it"), (input) =>
            supervisor.start({ ...input, instanceId: "nonesuch" }),
          ),
        ),
      ).pipe(Effect.orDie),
    );
    expect(refused._tag).toBe("Failure");
    if (refused._tag === "Failure") {
      expect(refused.failure.reason).toBe("harness_not_ready");
      expect(refused.failure.detail).toContain("'alpha'");
      expect(refused.failure.detail).toContain("'beta'");
    }
    expect(recorder.created).toEqual([]);
    await runtime.runPromise(releaseAll(held));
    await runtime.dispose();
  });

  /**
   * A suggestion is advice. These four are the whole of decision 13: an explicit pick
   * wins and is refused if it is dead, a suggestion is used if it is alive, and a dead
   * suggestion falls back **and says so**.
   */
  const suggested = (
    suggestion: { instanceId: string; model?: string },
    betaBroken?: string,
  ) => {
    const recorder = emptyRecorder();
    const routed: Routed = { prompted: [] };
    const { scriptFor, release } = scripts({
      narration: [],
      stream: "open",
      status: "succeeded",
    });
    const built = twoInstanceWorld(
      scriptFor,
      recorder,
      routed,
      betaBroken === undefined ? undefined : { betaBroken },
    );
    const input = (task: string) =>
      draft(built.root, "alpha-target", task, {
        suggestedInstanceId: suggestion.instanceId,
        ...(suggestion.model === undefined
          ? {}
          : { suggestedModel: suggestion.model }),
      });
    return { ...built, routed, recorder, release, input };
  };

  const intentOf = (intentId: string) =>
    Effect.flatMap(TargetStores, (stores) =>
      withTargetStore(stores, "alpha-target", (store) =>
        store.intent(intentId),
      ),
    );

  test("a suggestion that can be honoured is, and nothing is reported as a fallback", async () => {
    const { runtime, ready, routed, input, release } = suggested({
      instanceId: "beta",
      model: "beta/other",
    });
    await ready;

    const started = await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        const run = yield* supervisor.start(yield* input("probe it"));
        yield* release(run.harnessSessionId);
        return run;
      }).pipe(Effect.orDie),
    );

    expect(started.instanceId).toBe("beta");
    expect(started.instanceFallback).toBeNull();
    // The suggested model reached the harness: the suggestion is used, not only stored.
    expect(routed.prompted).toEqual([
      { instanceId: "beta", model: "beta/other" },
    ]);
    await runtime.dispose();
  });

  test("a suggestion naming a dead instance falls back to the default and says so", async () => {
    const { runtime, ready, routed, input, release } = suggested(
      { instanceId: "beta", model: "beta/other" },
      "beta would not start: no such binary",
    );
    await ready;

    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        const draftInput = yield* input("probe it");
        const run = yield* supervisor.start(draftInput);
        yield* release(run.harnessSessionId);
        return { run, intent: yield* intentOf(draftInput.intentId) };
      }).pipe(Effect.orDie),
    );

    // It ran, on the default, and the response carries what was wanted and why not.
    expect(observed.run.instanceId).toBe("alpha");
    expect(observed.run.instanceFallback).toMatchObject({ requested: "beta" });
    expect(observed.run.instanceFallback?.reason).toContain("no such binary");
    // The suggested *model* belonged to the instance that fell away, so it is not carried
    // across: `beta/other` is not a name alpha knows.
    expect(routed.prompted).toEqual([
      { instanceId: "alpha", model: "alpha/default" },
    ]);
    // And the suggestion is still on the intent, untouched: advice that failed once is not
    // erased, and nothing was pinned to it.
    expect(observed.intent?.suggestion.instanceId).toBe("beta");
    await runtime.dispose();
  });

  test("an operator's explicit pick wins over a suggestion, and never falls back", async () => {
    const { runtime, ready, routed, input, release } = suggested({
      instanceId: "beta",
      model: "beta/other",
    });
    await ready;

    const started = await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        const run = yield* supervisor.start({
          ...(yield* input("probe it")),
          instanceId: "alpha",
        });
        yield* release(run.harnessSessionId);
        return run;
      }).pipe(Effect.orDie),
    );

    expect(started.instanceId).toBe("alpha");
    expect(started.instanceFallback).toBeNull();
    // The suggestion's model is for beta and is not applied to an instance it was not
    // suggested for.
    expect(routed.prompted).toEqual([
      { instanceId: "alpha", model: "alpha/default" },
    ]);
    await runtime.dispose();
  });

  test("an explicit pick that is dead is refused harness_not_ready, even beside a live suggestion, and the intent stays open", async () => {
    const { runtime, ready, recorder, input } = suggested(
      { instanceId: "alpha" },
      "beta would not start: no such binary",
    );
    await ready;

    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        const draftInput = yield* input("probe it");
        const refused = yield* Effect.result(
          supervisor.start({ ...draftInput, instanceId: "beta" }),
        );
        return { refused, intent: yield* intentOf(draftInput.intentId) };
      }).pipe(Effect.orDie),
    );

    expect(observed.refused._tag).toBe("Failure");
    if (observed.refused._tag === "Failure") {
      expect(observed.refused.failure.reason).toBe("harness_not_ready");
    }
    // Not substituted: nothing ran anywhere, and the intent can be run again.
    expect(recorder.created).toEqual([]);
    expect(observed.intent?.status).toBe("open");
    expect(observed.intent?.claimedByAttemptId).toBeNull();
    expect(observed.intent?.attemptCount).toBe(0);
    await runtime.dispose();
  });
});

/* ── The transcript, written at settlement ───────────────────────────────────── */

/**
 * The ceiling the bounded-fetch test asserts under.
 *
 * Generous — it is a machine running a real SQLite write and a scoped teardown — and still
 * far below what an *unbounded* fetch would cost: a harness that never answers would hold
 * the finalizer open for as long as the test runner allowed.
 */
const TRANSCRIPT_WAIT_CEILING = 5_000;

/**
 * What a settled attempt leaves beside its row, and what happens when it cannot.
 *
 * The three properties the brief put above the format, each as a behaviour:
 *
 * 1. **Settle first, then write.** The row and the `attempt.settled` event are there in
 *    every case below, including the two where no transcript is.
 * 2. **The fetch is bounded and cannot block.** A harness that never answers `messages`
 *    settles anyway, promptly.
 * 3. **It comes from `messages`, not from the drained stream.** The scripted narration and
 *    the scripted message log are deliberately different here, and the file holds the
 *    second.
 */
describe("the transcript at settlement", () => {
  const transcriptWorld = (
    scriptFor: (sessionId: string) => Script,
    recorder: Recorder,
    messages: AgentHarness["Service"]["messages"],
  ) => {
    const root = newRoot();
    const fleet = FleetStore.layer(root);
    const stores = TargetStores.layer.pipe(Layer.provide(fleet));
    const credentials = McpCredentials.layer;
    const harness = Layer.succeed(
      AgentHarness,
      AgentHarness.of({ ...fakeHarnessShape(scriptFor, recorder), messages }),
    );
    const layer = Layer.mergeAll(
      fleet,
      stores,
      credentials,
      RunSupervisor.layerWith({
        askTimeout: "100 millis",
        transcriptTimeout: "100 millis",
      }).pipe(
        Layer.provide(HarnessResolver.single),
        Layer.provide(harness),
        Layer.provide(stores),
        Layer.provide(credentials),
        Layer.provide(RunNarrations.layer),
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
          targetId: "alpha",
          name: "alpha",
          scopeNote: "the local fixture only",
        });
        yield* registry.migrateFleet();
      }).pipe(Effect.orDie),
    );
    return { root, runtime, ready };
  };

  /** The evidence directory `draft` points the run at, so a test can read the artefact. */
  const evidenceOf = (root: string) =>
    join(root, "targets", "alpha", "evidence");

  test("a settled attempt's transcript is written from the harness's message log", async () => {
    const recorder = emptyRecorder();
    const { scriptFor, release } = scripts({
      // The narration says one thing and the message log says another, on purpose: the
      // file must hold the *log*, because the stream has a gap between subscribing and
      // prompting and `messages` does not.
      narration: [narration("session.text.delta", 1)],
      stream: "open",
      status: "succeeded",
    });
    const { root, runtime, ready } = transcriptWorld(scriptFor, recorder, () =>
      Effect.succeed([
        {
          type: "assistant",
          text: "what the harness retained",
          error: undefined,
        },
        { type: "tool", text: "a tool call", error: undefined },
      ]),
    );
    await ready;

    const started = await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        const run = yield* supervisor.start(
          yield* draft(root, "alpha", "probe it"),
        );
        yield* release(run.harnessSessionId);
        // Settled: `stop` awaits the finalizer, which settles and then writes.
        yield* Effect.result(supervisor.stop(run.attemptId));
        return run;
      }).pipe(Effect.orDie),
    );

    const read = await runtime.runPromise(
      readRecordedTranscript({
        directory: evidenceOf(root),
        attemptId: started.attemptId,
      }),
    );
    expect(read).toBeDefined();
    expect(read?.source).toBe("recorded");
    expect(read?.entries.map((entry) => entry.text)).toEqual([
      "what the harness retained",
      "a tool call",
    ]);

    // And the row is settled, which is the thing the transcript must never be allowed to
    // come before.
    const rows = readAfterShutdown(root, "alpha");
    expect(rows.attempts[0]?.status).toBe("succeeded");
    await runtime.dispose();
  });

  /**
   * A fetch that fails does not prevent or delay the settlement.
   *
   * The row says `succeeded`, the `attempt.settled` event is in the log, and there is no
   * transcript — which the read path reports as normal rather than as an error.
   */
  test("a settlement still happens when the transcript fetch fails", async () => {
    const recorder = emptyRecorder();
    const { scriptFor, release } = scripts({
      narration: [],
      stream: "open",
      status: "succeeded",
    });
    const { root, runtime, ready } = transcriptWorld(scriptFor, recorder, () =>
      Effect.fail(transport("message.list", "the harness is gone")),
    );
    await ready;

    const started = await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        const run = yield* supervisor.start(
          yield* draft(root, "alpha", "probe it"),
        );
        yield* release(run.harnessSessionId);
        yield* Effect.result(supervisor.stop(run.attemptId));
        return run;
      }).pipe(Effect.orDie),
    );
    await runtime.dispose();

    const rows = readAfterShutdown(root, "alpha");
    expect(rows.attempts[0]?.status).toBe("succeeded");
    expect(rows.events.map((event) => event.kind)).toEqual([
      "attempt.started",
      "attempt.settled",
    ]);
    expect(
      transcriptFilesFor(evidenceOf(root), started.attemptId),
    ).toHaveLength(0);
  });

  /**
   * A fetch that never answers is cut short, and the settlement is prompt.
   *
   * This is the shutdown case: the finalizer runs while the harness child is being torn
   * down, and an unbounded ask there would wedge the exit. The `askTimeout` above is
   * 100ms, and the transcript's own bound is separate; what is asserted is that the whole
   * settlement still finishes in well under the real five-second default.
   */
  test("a transcript fetch that never answers does not block settlement", async () => {
    const recorder = emptyRecorder();
    const { scriptFor, release } = scripts({
      narration: [],
      stream: "open",
      status: "succeeded",
    });
    const { root, runtime, ready } = transcriptWorld(
      scriptFor,
      recorder,
      () => Effect.never,
    );
    await ready;

    const started = Date.now();
    await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        const run = yield* supervisor.start(
          yield* draft(root, "alpha", "probe it"),
        );
        yield* release(run.harnessSessionId);
        yield* Effect.result(supervisor.stop(run.attemptId));
      }).pipe(Effect.orDie),
    );
    const elapsed = Date.now() - started;
    await runtime.dispose();

    // The real bound is five seconds; a settlement that waited it out per run would make
    // a shutdown with three runs in flight a quarter of a minute of nothing.
    expect(elapsed).toBeLessThan(TRANSCRIPT_WAIT_CEILING);
    const rows = readAfterShutdown(root, "alpha");
    expect(rows.attempts[0]?.status).toBe("succeeded");
  });
});

/**
 * What a run carries *of* its model, and what it refuses to carry.
 *
 * The rules themselves are `@bit/contracts`'s `modelOption.ts` and are shared with the
 * picker; what is checked here is the half only the server can be wrong about — that the
 * supervisor resolves against **this process's** catalogue rather than trusting the
 * caller, and that what survives reaches `createSession` and nothing else does.
 *
 * The scripted harness's `scripted/model` reports one `select` descriptor, `effort`, with
 * `default`/`low`/`high`; `scripted/other` reports none. That asymmetry is the fixture:
 * every case below is a selection meeting one of those two models.
 */
describe("the model options a run is dispatched with", () => {
  const dispatched = async (
    modelOptions: readonly ModelOptionSelection[],
    model?: string,
  ) => {
    const recorder = emptyRecorder();
    const { scriptFor } = scripts({
      narration: [],
      stream: "open",
      status: undefined,
    });
    const { root, runtime, ready } = world(["alpha"], scriptFor, recorder);
    await ready;
    await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        yield* supervisor.start({
          ...(yield* draft(root, "alpha", "probe it")),
          ...(model === undefined ? {} : { model }),
          modelOptions,
        });
      }).pipe(Effect.orDie),
    );
    await runtime.dispose();
    return recorder.sessionOptions[0];
  };

  test("a choice the model offers reaches the harness", async () => {
    expect(await dispatched([{ id: "effort", value: "low" }])).toEqual([
      { id: "effort", value: "low" },
    ]);
  });

  test("nothing chosen is absent rather than empty", async () => {
    // The distinction the contract insists on: a harness handed nothing applies its own
    // default and stays free to change it, and `[]` would have claimed an opinion.
    expect(await dispatched([])).toBeUndefined();
  });

  test("an option this model does not offer is dropped, not forwarded", async () => {
    // `scripted/other` reports no descriptors at all, so there is nothing for the
    // selection to resolve against. This is the ordinary case after a harness restart
    // changes a catalogue, not a client error, so the run proceeds without it.
    expect(
      await dispatched([{ id: "effort", value: "low" }], "scripted/other"),
    ).toBeUndefined();
  });

  test("an option no descriptor matches is dropped even on a model with options", async () => {
    expect(
      await dispatched([
        { id: "effort", value: "high" },
        { id: "madeUp", value: "yes" },
      ]),
    ).toEqual([{ id: "effort", value: "high" }]);
  });

  test("a value outside the choices falls back to the descriptor's default", async () => {
    // Not refused and not passed through: the caller did set this option, so it is still
    // dispatched — at the value the descriptor says it falls back to. The harness client
    // is what turns that default into "send nothing" at the edge.
    expect(await dispatched([{ id: "effort", value: "ludicrous" }])).toEqual([
      { id: "effort", value: "default" },
    ]);
  });

  test("what was dispatched is what the attempt row records", async () => {
    // The loop closed: the row an operator reads afterwards says what the run carried,
    // resolved against this process's catalogue rather than copied from the request. A
    // row is the only place this is answerable once the process is gone.
    const recorder = emptyRecorder();
    const { scriptFor } = scripts({
      narration: [],
      stream: "open",
      status: undefined,
    });
    const { root, runtime, ready } = world(["alpha"], scriptFor, recorder);
    await ready;
    await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        yield* supervisor.start({
          ...(yield* draft(root, "alpha", "probe it")),
          modelOptions: [
            { id: "effort", value: "high" },
            // Dropped on the way, and so absent from the row too: what is recorded is
            // what ran, never what was asked for.
            { id: "madeUp", value: "yes" },
          ],
        });
      }).pipe(Effect.orDie),
    );
    await runtime.dispose();

    const rows = readAfterShutdown(root, "alpha");
    expect(rows.attempts[0]?.model_options).toBe(
      '[{"id":"effort","value":"high"}]',
    );
  });

  test("a run that chose nothing records nothing, rather than a default", async () => {
    // `NULL`, not the descriptor's default: a row reading `effort: default` would be a
    // fabricated answer, and it would also be indistinguishable from an operator who
    // pinned that value on purpose.
    const recorder = emptyRecorder();
    const { scriptFor } = scripts({
      narration: [],
      stream: "open",
      status: undefined,
    });
    const { root, runtime, ready } = world(["alpha"], scriptFor, recorder);
    await ready;
    await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        yield* supervisor.start(yield* draft(root, "alpha", "probe it"));
      }).pipe(Effect.orDie),
    );
    await runtime.dispose();

    expect(
      readAfterShutdown(root, "alpha").attempts[0]?.model_options,
    ).toBeNull();
  });

  test("a model this server's catalogue does not list offers nothing", async () => {
    // An operator may name a model the catalogue has never heard of — whether it runs is
    // the harness's answer — but nothing is known about what it offers, so a selection
    // for it cannot be resolved and is not guessed at.
    expect(
      await dispatched([{ id: "effort", value: "low" }], "scripted/unlisted"),
    ).toBeUndefined();
  });
});

/* ── Choosing the harness, on its own ────────────────────────────────────────── */

describe("which harness, model and options a run gets", () => {
  const instanceOf = (id: string): HarnessInstance => ({
    ...STUB_INSTANCE,
    instanceId: defaultInstanceIdForDriver(DriverKind.make(id)),
    driver: DriverKind.make(id),
    displayName: id,
    defaultModel: `${id}/default`,
    models: [{ id: `${id}/default` }],
  });
  const harnessOf = (id: string) => {
    const { scriptFor } = scripts({
      narration: [],
      stream: "open",
      status: undefined,
    });
    return AgentHarness.of({
      ...fakeHarnessShape(scriptFor, emptyRecorder()),
      instance: instanceOf(id),
    });
  };
  const resolver = (deadBeta = false) =>
    HarnessResolver.fromEntries([
      { instance: instanceOf("alpha"), harness: harnessOf("alpha") },
      deadBeta
        ? {
            instance: instanceOf("beta"),
            harness: undefined,
            reason: "beta is down",
          }
        : { instance: instanceOf("beta"), harness: harnessOf("beta") },
    ]);
  const idOf = (chosen: { resolved: { instance: { instanceId: string } } }) =>
    String(chosen.resolved.instance.instanceId);
  const none = { instanceId: null, model: null, modelOptions: null };
  const run = (
    explicit: Parameters<typeof chooseHarness>[1],
    suggestion: Parameters<typeof chooseHarness>[2],
    deadBeta = false,
  ) =>
    Effect.runPromise(chooseHarness(resolver(deadBeta), explicit, suggestion));

  test("explicit, then suggestion, then default", async () => {
    expect(idOf(await run({}, none))).toBe("alpha");
    expect(idOf(await run({}, { ...none, instanceId: "beta" }))).toBe("beta");
    expect(
      idOf(await run({ instanceId: "alpha" }, { ...none, instanceId: "beta" })),
    ).toBe("alpha");
  });

  test("a dead suggestion falls back with a reason; a dead explicit pick fails", async () => {
    const chosen = await run({}, { ...none, instanceId: "beta" }, true);
    expect(idOf(chosen)).toBe("alpha");
    expect(chosen.fallback?.requested).toBe("beta");
    expect(chosen.fallback?.reason).toContain("beta is down");

    const refused = await Effect.runPromise(
      Effect.result(
        chooseHarness(resolver(true), { instanceId: "beta" }, none),
      ),
    );
    expect(refused._tag).toBe("Failure");
  });

  test("a suggestion's model and options apply only where they were suggested", async () => {
    const suggestion = {
      instanceId: "beta",
      model: "beta/default",
      modelOptions: [{ id: "effort", value: "high" }],
    };
    // On the instance it was suggested for: used.
    const used = await run({}, suggestion);
    expect(used.model).toBe("beta/default");
    expect(used.modelOptions).toEqual([{ id: "effort", value: "high" }]);
    // The instance fell away: neither carries over.
    const fellBack = await run({}, suggestion, true);
    expect(fellBack.model).toBeUndefined();
    expect(fellBack.modelOptions).toBeUndefined();
    // The operator chose another instance: neither applies.
    const elsewhere = await run({ instanceId: "alpha" }, suggestion);
    expect(elsewhere.model).toBeUndefined();
    expect(elsewhere.modelOptions).toBeUndefined();
    // The operator chose another model on the right instance: the options were for the
    // model that was suggested, so they are dropped with it.
    const otherModel = await run(
      { instanceId: "beta", model: "beta/other" },
      suggestion,
    );
    expect(otherModel.model).toBe("beta/other");
    expect(otherModel.modelOptions).toBeUndefined();
    // And the operator's explicit options beat the suggestion's.
    const explicit = await run(
      { modelOptions: [{ id: "effort", value: "low" }] },
      suggestion,
    );
    expect(explicit.modelOptions).toEqual([{ id: "effort", value: "low" }]);
  });
});

/* ── Running an intent that already exists ───────────────────────────────────── */

describe("running an existing intent", () => {
  const quiet = () =>
    scripts({ narration: [], stream: "open", status: "succeeded" });

  /** Counts straight off the target's file: goals, intents, attempts. */
  const countsOf = (targetId: string) =>
    Effect.flatMap(TargetStores, (stores) =>
      withTargetStore(stores, targetId, (store) => store.counts()),
    );
  const intentIn = (targetId: string, intentId: string) =>
    Effect.flatMap(TargetStores, (stores) =>
      withTargetStore(stores, targetId, (store) => store.intent(intentId)),
    );

  test("mints nothing: the attempt is the only new row, and the intent is claimed by it", async () => {
    const recorder = emptyRecorder();
    const { scriptFor, held } = quiet();
    const { root, runtime, ready } = world(["alpha"], scriptFor, recorder);
    await ready;

    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        const input = yield* draft(root, "alpha", "does login rate-limit?");
        const before = yield* countsOf("alpha");
        const run = yield* supervisor.start(input);
        return {
          input,
          before,
          after: yield* countsOf("alpha"),
          run,
          intent: yield* intentIn("alpha", input.intentId),
        };
      }).pipe(Effect.orDie),
    );

    // Exactly one new row, and it is the attempt. A run that minted a goal or an intent
    // would move one of the other two.
    expect(observed.after.goals).toBe(observed.before.goals);
    expect(observed.after.intents).toBe(observed.before.intents);
    expect(observed.after.attempts).toBe(observed.before.attempts + 1);
    // The run is against the intent it was given, and its prompt is that intent's question.
    expect(observed.run.intentId).toBe(observed.input.intentId);
    expect([...recorder.prompts]).toEqual([
      `${observed.run.harnessSessionId}:does login rate-limit?`,
    ]);
    // Held by the attempt that is running it, and counted.
    expect(observed.intent?.status).toBe("claimed");
    expect(observed.intent?.claimedByAttemptId).toBe(observed.run.attemptId);
    expect(observed.intent?.attemptCount).toBe(1);

    await runtime.runPromise(releaseAll(held));
    await runtime.dispose();
  });

  test("a second run of a claimed intent is refused, naming the attempt holding it", async () => {
    const recorder = emptyRecorder();
    const { scriptFor, held, release } = quiet();
    const { root, runtime, ready } = world(["alpha"], scriptFor, recorder);
    await ready;

    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        const input = yield* draft(root, "alpha", "probe it");
        const first = yield* supervisor.start(input);
        const second = yield* Effect.result(supervisor.start(input));
        yield* release(first.harnessSessionId);
        yield* settled(supervisor, first.attemptId);
        return {
          first,
          second,
          settledIntent: yield* intentIn("alpha", input.intentId),
          counts: yield* countsOf("alpha"),
        };
      }).pipe(Effect.orDie),
    );

    expect(observed.second._tag).toBe("Failure");
    if (observed.second._tag === "Failure") {
      expect(observed.second.failure.reason).toBe("intent_not_open");
      expect(observed.second.failure.detail).toContain(
        observed.first.attemptId,
      );
    }
    // The refused one wrote no attempt, and the first run's settlement gave the intent
    // back: it succeeded having recorded nothing, which is an absence of evidence and so
    // returns the intent to `open` rather than answering it.
    expect(observed.counts.attempts).toBe(1);
    expect(observed.settledIntent?.status).toBe("open");
    expect(observed.settledIntent?.claimedByAttemptId).toBeNull();

    await runtime.runPromise(releaseAll(held));
    await runtime.dispose();
  });

  test("two starts of one intent racing: exactly one wins, and the loser names it", async () => {
    const recorder = emptyRecorder();
    const { scriptFor, held } = quiet();
    const { root, runtime, ready } = world(["alpha"], scriptFor, recorder);
    await ready;

    const results = await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        const input = yield* draft(root, "alpha", "probe it");
        return yield* Effect.all(
          [
            Effect.result(supervisor.start(input)),
            Effect.result(supervisor.start(input)),
          ],
          { concurrency: "unbounded" },
        );
      }).pipe(Effect.orDie),
    );

    const wins = results.filter((result) => result._tag === "Success");
    const losses = results.filter((result) => result._tag === "Failure");
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    const winner = wins[0];
    const loser = losses[0];
    if (winner?._tag === "Success" && loser?._tag === "Failure") {
      expect(loser.failure.reason).toBe("intent_not_open");
      expect(loser.failure.detail).toContain(winner.success.attemptId);
    }
    // One session, one prompt: the loser never reached a harness.
    expect(recorder.created).toHaveLength(1);
    expect(recorder.prompts).toHaveLength(1);

    await runtime.runPromise(releaseAll(held));
    await runtime.dispose();
  });

  test("a stopped run gives its intent back, `open`", async () => {
    const recorder = emptyRecorder();
    const { scriptFor, held } = quiet();
    const { root, runtime, ready } = world(["alpha"], scriptFor, recorder);
    await ready;

    const intent = await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        const input = yield* draft(root, "alpha", "probe it");
        const run = yield* supervisor.start(input);
        yield* supervisor.stop(run.attemptId);
        return yield* intentIn("alpha", input.intentId);
      }).pipe(Effect.orDie),
    );

    // `interrupted` never produces `answered`.
    expect(intent?.status).toBe("open");
    expect(intent?.claimedByAttemptId).toBeNull();
    expect(intent?.attemptCount).toBe(1);

    await runtime.runPromise(releaseAll(held));
    await runtime.dispose();
  });

  test("an intent whose goal has ended is refused by name, and stays open", async () => {
    const recorder = emptyRecorder();
    const { scriptFor } = quiet();
    const { root, runtime, ready } = world(["alpha"], scriptFor, recorder);
    await ready;

    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        const stores = yield* TargetStores;
        const input = yield* draft(root, "alpha", "probe it");
        const before = yield* intentIn("alpha", input.intentId);
        yield* withTargetStore(stores, "alpha", (store) =>
          store.endGoal(
            { callerScope: "alpha/operator", targetId: "alpha" },
            {
              operationId: "op-end",
              goalId: before?.goalId ?? "",
              status: "abandoned",
              endedBy: "operator",
              reason: "out of scope",
            },
          ),
        );
        const refused = yield* Effect.result(supervisor.start(input));
        return {
          refused,
          intent: yield* intentIn("alpha", input.intentId),
          counts: yield* countsOf("alpha"),
        };
      }).pipe(Effect.orDie),
    );

    expect(observed.refused._tag).toBe("Failure");
    if (observed.refused._tag === "Failure") {
      expect(observed.refused.failure.reason).toBe("goal_not_active");
      // Names the status, so the operator reads why.
      expect(observed.refused.failure.detail).toContain("abandoned");
    }
    expect(observed.intent?.status).toBe("open");
    expect(observed.counts.attempts).toBe(0);
    expect(recorder.created).toEqual([]);
  });

  test("an intent that does not exist, or is another target's, is refused by name", async () => {
    const recorder = emptyRecorder();
    const { scriptFor } = quiet();
    const { root, runtime, ready } = world(
      ["alpha", "beta"],
      scriptFor,
      recorder,
    );
    await ready;

    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        const alphas = yield* draft(root, "alpha", "probe it");
        const betas = yield* draft(root, "beta", "probe it");
        return {
          missing: yield* Effect.result(
            supervisor.start({ ...alphas, intentId: "int_nonesuch" }),
          ),
          // Alpha's intent id, presented against beta's target: beta's file does not hold
          // it, so it is not found there. A target's file is the boundary.
          crossed: yield* Effect.result(
            supervisor.start({ ...betas, intentId: alphas.intentId }),
          ),
        };
      }).pipe(Effect.orDie),
    );

    expect(observed.missing._tag).toBe("Failure");
    if (observed.missing._tag === "Failure") {
      expect(observed.missing.failure.reason).toBe("intent_not_found");
    }
    expect(observed.crossed._tag).toBe("Failure");
    if (observed.crossed._tag === "Failure") {
      expect(observed.crossed.failure.reason).toBe("intent_not_found");
    }
    expect(recorder.created).toEqual([]);
    await runtime.dispose();
  });

  test("a start held for the worker endpoints holds no claim, so the startup sweep has nothing of its live work to take", async () => {
    // `main.ts` runs the orphan sweep and only then publishes the endpoints. The sweep cannot
    // tell a live start's claim from an orphan, so the guarantee is that a start waiting for
    // the endpoints has not claimed anything yet. Parked here exactly where it parks at boot.
    const recorder = emptyRecorder();
    const { scriptFor, held } = quiet();
    const pending = WorkerEndpoints.pending();
    const { root, runtime, ready } = world(["alpha"], scriptFor, recorder, {
      endpoints: pending.layer,
    });
    await ready;

    const input = await runtime.runPromise(
      draft(root, "alpha", "probe it").pipe(Effect.orDie),
    );
    // The request arrives while the sweep is still walking the fleet.
    const starting = runtime.runPromise(
      Effect.flatMap(RunSupervisor, (supervisor) => supervisor.start(input)),
    );
    // Long enough for a start that was going to claim to have claimed.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const during = await runtime.runPromise(
      Effect.gen(function* () {
        const before = yield* intentIn("alpha", input.intentId);
        // The sweep, exactly as `main.ts` runs it.
        const swept = yield* Effect.flatMap(TargetStores, (stores) =>
          withTargetStore(stores, "alpha", (store) =>
            store.releaseOrphanedClaims(),
          ),
        );
        return {
          before,
          swept,
          after: yield* intentIn("alpha", input.intentId),
          counts: yield* countsOf("alpha"),
        };
      }).pipe(Effect.orDie),
    );
    // The start is parked, and it has taken nothing: no claim, no attempt.
    expect(during.before?.status).toBe("open");
    expect(during.before?.claimedByAttemptId).toBeNull();
    expect(during.counts.attempts).toBe(0);
    // So the sweep found nothing, and the intent is untouched.
    expect(during.swept).toEqual([]);
    expect(during.after).toEqual(during.before);

    // Published after the sweep, as `main.ts` does: the start proceeds and owns its claim.
    await Effect.runPromise(
      pending.publish({
        mcp: "http://127.0.0.1:9/api/v1/mcp",
        policy: "http://127.0.0.1:9/api/v1/policy/decide",
      }),
    );
    const started = await starting;
    const afterStart = await runtime.runPromise(
      intentIn("alpha", input.intentId).pipe(Effect.orDie),
    );
    expect(afterStart?.status).toBe("claimed");
    expect(afterStart?.claimedByAttemptId).toBe(started.attemptId);

    await runtime.runPromise(releaseAll(held));
    await runtime.dispose();
  });
});
