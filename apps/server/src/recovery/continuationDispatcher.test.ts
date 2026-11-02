/**
 * The continuation, end to end over a real database: what gets queued, in what order, and
 * everything that stops one being sent (S7.2–S7.4).
 *
 * Real SQLite, for this repository's standing reason — the outbox's claim, lease and
 * settlement statements are unchecked SQL until they run, and the whole point of a durable
 * queue is that it survives the process — and a scripted harness, because the answers that
 * decide everything here (`abandoned`, `unreachable`, a stated outcome) are the ones a live
 * harness will not produce on demand.
 *
 * The surfaces themselves are a recorded double. What is under test is the dispatcher, and
 * the three real deliveries have their own suites: `run/supervisor.test.ts` for the
 * end-of-one-attempt-and-opening-of-another handoff, `plan/goalConversation.test.ts` and
 * `import/scopeImporter.test.ts` for the resumes.
 *
 * **The first test is the ordering one**, and it is the only claim in this file that is
 * about time rather than about a decision: the double reads the attempt row *at the moment
 * it is handed the continuation* and asserts the row has already left `running`. That is
 * S7.1 checked against the database rather than against the order of two statements.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";

import { McpCredentials } from "../mcp/credentials";
import {
  ObservationStore,
  operatorScope,
  type AttemptRow,
} from "../persistence/store";
import {
  CONTINUATION_CHAIN_MAX,
  type ContinuationPolicy,
} from "./continuation";
import {
  dispatchContinuations,
  enqueueContinuations,
  type ContinuationDispatched,
  type ContinuationRouting,
} from "./continuationDispatcher";
import {
  HarnessSessionStatus,
  type HarnessObservedStatus,
} from "./harnessStatus";
import { reconcileUnsettledAttempts, type Reconciliation } from "./reconcile";

const directories: string[] = [];
afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true });
  }
});

const newDatabasePath = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "bit-continuation-"));
  directories.push(directory);
  return join(directory, "hunt.sqlite");
};

const TARGET = "target-1";
const GOAL = "goal-1";
const INTENT = "intent-1";
const SESSION = "ses_abandoned";

const ON: ContinuationPolicy = { _tag: "on" };

const seedAttempt = (
  store: ObservationStore["Service"],
  attemptId: string,
  harnessSessionId: string | null = SESSION,
) =>
  store.seedAttempt({
    targetId: TARGET,
    goalId: GOAL,
    goal: "Determine whether authentication rate limits can be bypassed.",
    intentId: INTENT,
    question: "Probe the per-client limiter on POST /login.",
    attemptId,
    workerId: "worker-1",
    harnessInstanceId: "opencode",
    providerId: "openai",
    modelId: "gpt-5.6-sol",
    modelOptions: null,
    harnessSessionId,
  });

/** What a delivery was handed, and what the row said while it was being handed it. */
interface Delivered {
  readonly subject: string;
  readonly instruction: string;
  readonly attemptStatusAtDelivery: string | undefined;
}

/**
 * A routing double that records, and reads the attempt row while it is being called.
 *
 * The read is the ordering assertion: a continuation handed over while its predecessor
 * still said `running` would be a continuation dispatched before the terminalization S7.1
 * requires, and no amount of statement ordering inside the dispatcher would prove
 * otherwise.
 *
 * It hands back a *factory* plus the list it records into, because the store only exists
 * inside the layer the boot builds and the assertions are outside it.
 */
const recordingRouting = (options?: {
  readonly refuse?: string | undefined;
  readonly summary?: string | undefined;
}): {
  readonly make: (store: ObservationStore["Service"]) => ContinuationRouting;
  readonly delivered: Delivered[];
} => {
  const delivered: Delivered[] = [];
  return {
    delivered,
    make: (store) => ({
      leaseOwner: "test",
      summarise: () => Effect.succeed(options?.summary),
      deliver: (input) =>
        Effect.gen(function* () {
          const subject = input.request.subject;
          const row: AttemptRow | undefined =
            subject.kind === "attempt"
              ? yield* store
                  .loadAttempt(subject.attemptId, TARGET)
                  .pipe(Effect.orDie)
              : undefined;
          delivered.push({
            subject:
              subject.kind === "attempt"
                ? subject.attemptId
                : subject.kind === "goal"
                  ? subject.goalId
                  : subject.importId,
            instruction: input.instruction,
            attemptStatusAtDelivery: row?.status,
          });
          return options?.refuse === undefined
            ? ({ _tag: "dispatched", detail: "the double took it" } as const)
            : ({ _tag: "refused", detail: options.refuse } as const);
        }),
    }),
  };
};

/**
 * One boot over one database: sweep, queue, dispatch — in that order and in one borrow.
 *
 * It is written as a boot rather than as three calls because every test here is about what
 * a *restart* does, and because the sweep's own output is the only thing `enqueueContinuations`
 * will accept.
 */
const boot = <A>(input: {
  readonly path: string;
  readonly answers: Readonly<Record<string, HarnessObservedStatus>>;
  readonly routing: (store: ObservationStore["Service"]) => ContinuationRouting;
  readonly policy?: ContinuationPolicy | undefined;
  readonly before?: (
    store: ObservationStore["Service"],
  ) => Effect.Effect<unknown, never, ObservationStore>;
  readonly after: (input: {
    readonly store: ObservationStore["Service"];
    readonly swept: readonly Reconciliation[];
    readonly dispatched: readonly ContinuationDispatched[];
  }) => Effect.Effect<A, never, ObservationStore>;
}): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* ObservationStore;
        if (input.before !== undefined) yield* input.before(store);
        const swept = yield* reconcileUnsettledAttempts();
        yield* enqueueContinuations({ targetId: TARGET, attempts: swept });
        const dispatched = yield* dispatchContinuations({
          targetId: TARGET,
          policy: input.policy ?? ON,
          routing: input.routing(store),
        });
        return yield* input.after({ store, swept, dispatched });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            ObservationStore.layer(input.path),
            HarnessSessionStatus.fromAnswers(input.answers),
            McpCredentials.layer,
          ),
        ),
        Effect.orDie,
      ),
    ),
  );

/* ── The ordering, which is the property S7 exists to keep ───────────────────── */

describe("terminalize first, then continue", () => {
  /**
   * The slice's first done criterion, asserted where it can actually be wrong.
   *
   * A restart leaves the attempt row `running` and the harness answering `abandoned`. By
   * the time anything is dispatched the row must already say `uncertain`, its fence must
   * have moved, and the intent must be free — otherwise something half-finished was
   * presented as still running while a new turn was being started on top of it.
   */
  test("the attempt row has already left running by the time a continuation is handed over", async () => {
    const path = newDatabasePath();
    const double = recordingRouting();
    const outcome = await boot({
      path,
      answers: { [SESSION]: "abandoned" },
      routing: double.make,
      before: (store) =>
        Effect.gen(function* () {
          yield* seedAttempt(store, "ats_1");
          yield* store.claimIntent(
            { callerScope: operatorScope(TARGET), targetId: TARGET },
            INTENT,
            "ats_1",
          );
        }).pipe(Effect.orDie),
      after: ({ store, swept, dispatched }) =>
        Effect.gen(function* () {
          const row = yield* store
            .loadAttempt("ats_1", TARGET)
            .pipe(Effect.orDie);
          const intent = yield* store.intent(INTENT).pipe(Effect.orDie);
          return {
            swept: swept.map((entry) => entry.outcome.status),
            dispatched,
            status: row?.status,
            fence: row?.write_fence,
            intentStatus: intent?.status,
          };
        }),
    });

    // What the sweep did first: the row is terminal, its write fence has moved — so a
    // credential minted against the old one is refused — and the claim is back, which is
    // what lets the replacement claim it.
    expect(outcome.swept).toEqual(["uncertain"]);
    expect(outcome.status).toBe("uncertain");
    expect(outcome.fence).toBe(1);
    expect(outcome.intentStatus).toBe("open");

    // The ordering itself, read from the database at the moment of the handover rather
    // than inferred from the order of two statements.
    expect(double.delivered).toHaveLength(1);
    expect(double.delivered[0]?.attemptStatusAtDelivery).toBe("uncertain");
    expect(outcome.dispatched[0]?.status).toBe("succeeded");
  });
});

/* ── What is queued, and what is not ─────────────────────────────────────────── */

describe("what a restart owes a continuation", () => {
  /** The queue is the durable record: the event explains the row, and the row is the obligation. */
  test("an abandoned attempt is queued as an outbox row with an event behind it", async () => {
    const path = newDatabasePath();
    const queued = await boot({
      path,
      answers: { [SESSION]: "abandoned" },
      routing: recordingRouting().make,
      before: (store) => seedAttempt(store, "ats_1").pipe(Effect.orDie),
      after: ({ store }) =>
        Effect.gen(function* () {
          const rows = yield* store
            .continuationRequests({ includeCancelled: true })
            .pipe(Effect.orDie);
          const events = yield* store.eventsAfter(0, 200).pipe(Effect.orDie);
          return {
            rows: rows.map((row) => ({
              status: row.status,
              attempts: row.attempts,
              type: row.requestType,
              policy: row.recoveryPolicy,
              causedBy: row.causedByEventId,
            })),
            kinds: events.map((event) => event.kind),
            causes: events
              .filter((event) => event.kind === "agent.continuation.requested")
              .map((event) => event.subjectId),
          };
        }),
    });
    expect(queued.rows).toEqual([
      {
        status: "succeeded",
        attempts: 1,
        type: "agent.continue",
        policy: "reconcile_first",
        causedBy: queued.rows[0]?.causedBy ?? "",
      },
    ]);
    // The event that explains it, and the attempt is its subject.
    expect(queued.kinds).toContain("agent.continuation.requested");
    expect(queued.causes).toEqual(["ats_1"]);
    expect(queued.rows[0]?.causedBy).not.toBe("");
  });

  /**
   * The cost of `abandoned` being the only trigger, asserted so it cannot drift silently.
   * `unreachable` is the "never on a guess" case and is also what Claude Code produces
   * after a restart today — which is recorded on `continuationTrigger`.
   */
  test("nothing is queued when the harness could not be asked, or stated an outcome", async () => {
    for (const observed of [
      "unreachable",
      "missing",
      "succeeded",
      "interrupted",
    ] as const) {
      const path = newDatabasePath();
      const rows = await boot({
        path,
        answers: { [SESSION]: observed },
        routing: recordingRouting().make,
        before: (store) => seedAttempt(store, "ats_1").pipe(Effect.orDie),
        after: ({ store }) =>
          store
            .continuationRequests({ includeCancelled: true })
            .pipe(Effect.orDie),
      });
      expect(rows).toEqual([]);
    }
  });

  /** The harness says a turn is in flight: the row is correct and nothing was lost. */
  test("nothing is queued for an attempt the sweep left running", async () => {
    const path = newDatabasePath();
    const outcome = await boot({
      path,
      answers: { [SESSION]: "running" },
      routing: recordingRouting().make,
      before: (store) => seedAttempt(store, "ats_1").pipe(Effect.orDie),
      after: ({ store }) =>
        Effect.gen(function* () {
          const row = yield* store
            .loadAttempt("ats_1", TARGET)
            .pipe(Effect.orDie);
          const rows = yield* store
            .continuationRequests({ includeCancelled: true })
            .pipe(Effect.orDie);
          return { status: row?.status, queued: rows.length };
        }),
    });
    expect(outcome.status).toBe("running");
    expect(outcome.queued).toBe(0);
  });

  /**
   * The guard that stops a continuation being owed for ever. A continued attempt keeps its
   * `uncertain` row, so every later boot reads it again and is told the same `abandoned`;
   * without this, each one would open another replacement for a slice already being worked.
   */
  test("an attempt something already replaces is not continued a second time", async () => {
    const path = newDatabasePath();
    const outcome = await boot({
      path,
      // The replacement is live, so the only thing this test can be about is the guard on
      // the predecessor.
      answers: { [SESSION]: "abandoned", ses_replacement: "running" },
      routing: recordingRouting().make,
      before: (store) =>
        Effect.gen(function* () {
          yield* seedAttempt(store, "ats_1");
          // The sweep's work, done by hand so this test is about the guard rather than
          // about a second boot: the predecessor is terminal and a replacement exists.
          yield* store.recordRecovery({
            attemptId: "ats_1",
            observed: "abandoned",
            proposedStatus: "uncertain",
            detail: "a previous boot settled this",
          });
          yield* store.openReplacementAttempt({
            replacesAttemptId: "ats_1",
            targetId: TARGET,
            intentId: INTENT,
            attemptId: "ats_2",
            workerId: "worker-2",
            harnessInstanceId: "opencode",
            providerId: "openai",
            modelId: "gpt-5.6-sol",
            modelOptions: null,
            harnessSessionId: "ses_replacement",
          });
        }).pipe(Effect.orDie),
      after: ({ store, dispatched }) =>
        Effect.gen(function* () {
          const rows = yield* store
            .continuationRequests({ includeCancelled: true })
            .pipe(Effect.orDie);
          return { dispatched, queued: rows.length };
        }),
    });
    // Nothing: `ats_1` is already replaced, and `ats_2` is the replacement and is running.
    expect(outcome.dispatched).toEqual([]);
    expect(outcome.queued).toBe(0);
  });
});

/* ── The two conversations ───────────────────────────────────────────────────── */

describe("the conversations a restart interrupted", () => {
  const withImportSession = (
    store: ObservationStore["Service"],
    options?: { readonly ended?: "operator" | "shutdown" | undefined },
  ) =>
    Effect.gen(function* () {
      yield* store.recordImportSession({
        importId: "imp_1",
        targetId: TARGET,
        harnessSessionId: SESSION,
        harnessInstanceId: "opencode",
        model: "zai/glm",
      });
      yield* store.confirmImportSession("imp_1");
      if (options?.ended !== undefined) {
        yield* store.endImportSession("imp_1", options.ended);
      }
    }).pipe(Effect.orDie);

  test("an abandoned importer session is continued, addressed to its newest import", async () => {
    const path = newDatabasePath();
    const outcome = await boot({
      path,
      answers: { [SESSION]: "abandoned" },
      routing: recordingRouting().make,
      before: (store) => withImportSession(store),
      after: ({ dispatched }) => Effect.succeed(dispatched),
    });
    expect(outcome).toHaveLength(1);
    expect(outcome[0]?.subject).toEqual({
      kind: "importer",
      importId: "imp_1",
    });
    expect(outcome[0]?.status).toBe("succeeded");
  });

  /**
   * `shutdown` is the ordinary graceful restart (`0027`) and is **not** an ending that
   * stops a continuation: it is this process letting go. Only the operator's own end is
   * final, because only then is the authority over.
   */
  test("a session this process let go of on the way down is still continued", async () => {
    const path = newDatabasePath();
    const outcome = await boot({
      path,
      answers: { [SESSION]: "abandoned" },
      routing: recordingRouting().make,
      before: (store) => withImportSession(store, { ended: "shutdown" }),
      after: ({ dispatched }) => Effect.succeed(dispatched),
    });
    expect(outcome).toHaveLength(1);
  });

  test("an import the operator ended is not continued, and says so", async () => {
    const path = newDatabasePath();
    const outcome = await boot({
      path,
      answers: { [SESSION]: "abandoned" },
      routing: recordingRouting().make,
      before: (store) => withImportSession(store, { ended: "operator" }),
      after: ({ store, dispatched }) =>
        Effect.gen(function* () {
          const rows = yield* store
            .continuationRequests({ includeCancelled: true })
            .pipe(Effect.orDie);
          return { dispatched, queued: rows.length };
        }),
    });
    expect(outcome.dispatched).toEqual([]);
    expect(outcome.queued).toBe(0);
  });

  test("an abandoned goal conversation is continued", async () => {
    const path = newDatabasePath();
    const outcome = await boot({
      path,
      answers: { [SESSION]: "abandoned" },
      routing: recordingRouting().make,
      before: (store) =>
        Effect.gen(function* () {
          // The goal itself, which `seedAttempt` creates along with its intent.
          yield* seedAttempt(store, "ats_1", null);
          yield* store.recordGoalSession({
            goalId: GOAL,
            targetId: TARGET,
            harnessSessionId: SESSION,
            harnessInstanceId: "opencode",
          });
        }).pipe(Effect.orDie),
      after: ({ dispatched }) => Effect.succeed(dispatched),
    });
    // The attempt has no session (`unbound`), so the goal conversation is the only thing
    // owed a turn.
    expect(outcome.map((entry) => entry.subject)).toEqual([
      { kind: "goal", goalId: GOAL },
    ]);
  });

  test("a goal that has ended is not continued", async () => {
    const path = newDatabasePath();
    const outcome = await boot({
      path,
      answers: { [SESSION]: "abandoned" },
      routing: recordingRouting().make,
      before: (store) =>
        Effect.gen(function* () {
          yield* seedAttempt(store, "ats_1", null);
          yield* store.recordGoalSession({
            goalId: GOAL,
            targetId: TARGET,
            harnessSessionId: SESSION,
            harnessInstanceId: "opencode",
          });
          yield* store.endGoal(
            { callerScope: operatorScope(TARGET), targetId: TARGET },
            {
              operationId: "op-end-1",
              goalId: GOAL,
              status: "abandoned",
              endedBy: "operator",
              reason: "not worth it",
            },
          );
        }).pipe(Effect.orDie),
      after: ({ dispatched }) => Effect.succeed(dispatched),
    });
    expect(outcome).toEqual([]);
  });
});

/* ── Everything that stops one being sent ────────────────────────────────────── */

describe("what stops a queued continuation being sent", () => {
  /**
   * The crash loop, as four boots inside the window. The first three are dispatched and
   * the fourth is cancelled — unattended spending bounded at three turns rather than at
   * however long whatever is killing the process keeps killing it.
   */
  test("a chain is continued three times in the window and then cancelled", async () => {
    const path = newDatabasePath();
    const statuses: string[] = [];
    const details: string[] = [];
    for (let boots = 0; boots < CONTINUATION_CHAIN_MAX + 1; boots += 1) {
      const dispatched = await boot({
        path,
        answers: { [SESSION]: "abandoned" },
        routing: recordingRouting().make,
        ...(boots === 0
          ? {
              before: (store) => seedAttempt(store, "ats_1").pipe(Effect.orDie),
            }
          : {}),
        after: ({ dispatched }) => Effect.succeed(dispatched),
      });
      for (const entry of dispatched) {
        statuses.push(entry.status);
        details.push(entry.detail);
      }
    }
    expect(statuses).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
      "cancelled",
    ]);
    expect(details[3]).toContain("which is the cap");
  });

  /** The operator's switch, checked again at dispatch so a row queued while it was on is not sent after it was turned off. */
  test("continuation switched off cancels the row and records why", async () => {
    const path = newDatabasePath();
    const outcome = await boot({
      path,
      answers: { [SESSION]: "abandoned" },
      routing: recordingRouting().make,
      policy: {
        _tag: "off",
        detail: "switched off by the setting 'continuation'",
      },
      before: (store) => seedAttempt(store, "ats_1").pipe(Effect.orDie),
      after: ({ store, dispatched }) =>
        Effect.gen(function* () {
          const rows = yield* store
            .continuationRequests({ includeCancelled: true })
            .pipe(Effect.orDie);
          return { dispatched, lastError: rows[0]?.lastError };
        }),
    });
    expect(outcome.dispatched[0]?.status).toBe("cancelled");
    expect(outcome.lastError).toContain("switched off");
  });

  /** "Never continue on a guess" applied to the queue itself. */
  test("a payload this build cannot read is failed, not interpreted", async () => {
    const path = newDatabasePath();
    const outcome = await boot({
      path,
      answers: {},
      routing: recordingRouting().make,
      before: (store) =>
        store
          .enqueueContinuation({
            targetId: TARGET,
            subjectId: "something",
            payload: { subject: { kind: "planner", roundId: "rnd_1" } },
          })
          .pipe(Effect.orDie),
      after: ({ store, dispatched }) =>
        Effect.gen(function* () {
          const rows = yield* store
            .continuationRequests({ includeCancelled: true })
            .pipe(Effect.orDie);
          return { dispatched, status: rows[0]?.status };
        }),
    });
    expect(outcome.dispatched[0]?.status).toBe("failed");
    expect(outcome.status).toBe("failed");
  });

  /**
   * `reconcile_first`, implemented. A row left `in_flight` means a dispatcher claimed it
   * and never recorded what became of it, so whether the turn arrived is unknown — and
   * re-sending it would be pretending to know. It is failed, and the next sweep re-asks
   * the harness instead.
   */
  test("a lease nobody holds is failed rather than re-sent", async () => {
    const path = newDatabasePath();
    const outcome = await boot({
      path,
      answers: {},
      routing: recordingRouting().make,
      before: (store) =>
        Effect.gen(function* () {
          const queued = yield* store.enqueueContinuation({
            targetId: TARGET,
            subjectId: GOAL,
            payload: {
              subject: { kind: "goal", goalId: GOAL },
              targetId: TARGET,
              harnessSessionId: SESSION,
              harnessInstanceId: null,
              observed: "abandoned",
              detail: "…",
              chainKey: `goal:${GOAL}`,
              requestedAt: 1,
            },
          });
          // A lease that has already expired, which is what a dead dispatcher leaves.
          yield* store.claimContinuation({
            outboxId: queued.outboxId,
            leaseOwner: "a process that is gone",
            leaseFor: -60_000,
          });
        }).pipe(Effect.orDie),
      after: ({ store, dispatched }) =>
        Effect.gen(function* () {
          const rows = yield* store
            .continuationRequests({ includeCancelled: true })
            .pipe(Effect.orDie);
          return {
            dispatched,
            status: rows[0]?.status,
            attempts: rows[0]?.attempts,
            lastError: rows[0]?.lastError,
          };
        }),
    });
    expect(outcome.status).toBe("failed");
    // One dispatch attempt was made — by the process that died — and this boot made none.
    expect(outcome.attempts).toBe(1);
    expect(outcome.lastError).toContain("not sent again");
    expect(outcome.dispatched.map((entry) => entry.status)).toEqual(["failed"]);
  });

  /** A surface's refusal is an answer, recorded with its sentence and not retried. */
  test("a surface that refuses is recorded as failed with what it said", async () => {
    const path = newDatabasePath();
    const outcome = await boot({
      path,
      answers: { [SESSION]: "abandoned" },
      routing: recordingRouting({ refuse: "intent_not_open: ats_9 holds it" })
        .make,
      before: (store) => seedAttempt(store, "ats_1").pipe(Effect.orDie),
      after: ({ store, dispatched }) =>
        Effect.gen(function* () {
          const rows = yield* store
            .continuationRequests({ includeCancelled: true })
            .pipe(Effect.orDie);
          return { dispatched, lastError: rows[0]?.lastError };
        }),
    });
    expect(outcome.dispatched[0]?.status).toBe("failed");
    expect(outcome.lastError).toContain("intent_not_open");
  });
});

/* ── What the worker is handed ───────────────────────────────────────────────── */

describe("what a continued worker is handed", () => {
  /**
   * The summary reaches the prompt, and only the worker's does: the two conversations get
   * their real history back by resuming, so reading a transcript for them would be paying
   * for something the agent is about to be given anyway.
   */
  test("the dead attempt's summary is in the instruction, and a conversation gets a message instead", async () => {
    const path = newDatabasePath();
    const double = recordingRouting({ summary: "It got as far as /login." });
    const dispatched = await boot({
      path,
      answers: { [SESSION]: "abandoned", ses_goal: "abandoned" },
      routing: double.make,
      before: (store) =>
        Effect.gen(function* () {
          yield* seedAttempt(store, "ats_1");
          yield* store.recordGoalSession({
            goalId: GOAL,
            targetId: TARGET,
            harnessSessionId: "ses_goal",
            harnessInstanceId: "opencode",
          });
        }).pipe(Effect.orDie),
      after: ({ dispatched }) => Effect.succeed(dispatched),
    });
    expect(dispatched.map((entry) => entry.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);

    const worker = double.delivered.find((entry) => entry.subject === "ats_1");
    expect(worker?.instruction).toContain("CARRYING ON FROM AN INTERRUPTED");
    expect(worker?.instruction).toContain("It got as far as /login.");

    // The goal's is the synthetic message, marked as this server speaking, and it carries
    // no transcript: a resumed conversation has its own history above it.
    const goal = double.delivered.find((entry) => entry.subject === GOAL);
    expect(goal?.instruction.startsWith("[bit] ")).toBe(true);
    expect(goal?.instruction).not.toContain("It got as far as /login.");
  });
});
