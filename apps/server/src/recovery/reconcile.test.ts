/**
 * Interrupted-attempt recovery, against real SQLite and a deterministic fake harness.
 *
 * Two reasons neither half is a double. The database is a real file, because every
 * recovery statement is unchecked SQL until it runs and because the whole point of the
 * fence is that it survives a reopen. The harness is scripted, because the answers that
 * matter most — "I have never heard of this session", "I cannot be reached" — are the
 * ones a live harness will not produce on demand, and a recovery path that is only ever
 * exercised on the answers you can arrange is the path that breaks in production.
 *
 * What is asserted here is the whole rule set, not a happy path:
 *
 * - every harness answer's mapping, including the three that mean *uncertain*;
 * - that an unknown or unreachable session is never reported as a failure;
 * - that holding no observation for an attempt is never treated as evidence it did
 *   nothing;
 * - that a terminal attempt is never regressed, and a repeat of one reconciliation
 *   state writes no second row while a different decision gets its own;
 * - that leaving `running` revokes write authority, durably, so a credential minted
 *   before the sweep is refused after it — including after a restart;
 * - that `uncertain` can be refined by a later definite answer but never reopened into
 *   `running`, and that the refinement arrives through the ordinary startup sweep
 *   across a reopen rather than through a direct `recordRecovery` call;
 * - that replacement work gets a new attempt identity and the old one keeps its
 *   history, that a replacement is refused for a running, foreign or already-used
 *   identity, and that a failure while writing one leaves nothing behind.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer, Redacted } from "effect";

import { AgentHarness } from "../harness/agentHarness";
import { HarnessResolver } from "../harness/resolver";
import { stubHarness, STUB_INSTANCE } from "../harness/stubHarness";
import {
  defaultInstanceIdForDriver,
  OPENCODE_DRIVER,
} from "../harness/identity";
import { HarnessTransportError } from "../harness/errors";
import { McpCredentials } from "../mcp/credentials";
import { multiCaseInput } from "../persistence/fixtures";
import {
  MutationError,
  ObservationStore,
  decideRecovery,
  type AttemptExecutionStatus,
  type AttemptCaller,
} from "../persistence/store";
import {
  HarnessSessionStatus,
  type HarnessObservedStatus,
} from "./harnessStatus";
import {
  mapObserved,
  reconcileUnsettledAttempts,
  releaseOrphanedClaims,
} from "./reconcile";

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true });
  }
});

const newDatabasePath = () => {
  const directory = mkdtempSync(join(tmpdir(), "bit-recovery-"));
  directories.push(directory);
  return join(directory, "hunt.sqlite");
};

const TARGET = "target-1";
const INTENT = "intent-1";
const SESSION = "ses_abandoned";

const seed = (
  store: ObservationStore["Service"],
  attemptId: string,
  harnessSessionId: string | null = SESSION,
) =>
  store.seedAttempt({
    targetId: TARGET,
    goalId: "goal-1",
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

const caller = (attemptId: string, attemptFence: number): AttemptCaller => ({
  _tag: "attempt",
  callerScope: `${TARGET}/${attemptId}`,
  targetId: TARGET,
  intentId: INTENT,
  attemptId,
  harnessSessionId: SESSION,
  workerId: "worker-1",
  attemptFence,
});

/**
 * Runs a body against one database file, with scripted harness answers.
 *
 * The credential registry is real, so "reconciliation revokes a live grant" is checked
 * against the registry the MCP transport actually resolves against.
 */
const withRecovery = <A, E>(
  path: string,
  answers: Readonly<Record<string, HarnessObservedStatus>>,
  use: (
    store: ObservationStore["Service"],
  ) => Effect.Effect<
    A,
    E,
    ObservationStore | HarnessSessionStatus | McpCredentials
  >,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(ObservationStore, use).pipe(
        Effect.provide(
          Layer.mergeAll(
            ObservationStore.layer(path),
            HarnessSessionStatus.fromAnswers(answers),
            McpCredentials.layer,
          ),
        ),
      ),
    ),
  );

describe("the mapping from a harness answer to an attempt status", () => {
  /** Pure, so the whole state space is enumerable without a connection. */
  test("three different answers all mean uncertain, and none means failed", () => {
    expect(mapObserved("running")).toBe("running");
    expect(mapObserved("succeeded")).toBe("succeeded");
    expect(mapObserved("failed")).toBe("failed");
    expect(mapObserved("interrupted")).toBe("interrupted");
    expect(mapObserved("unbound")).toBe("uncertain");
    expect(mapObserved("missing")).toBe("uncertain");
    expect(mapObserved("unreachable")).toBe("uncertain");
  });

  test("decideRecovery never moves an attempt out of a final status", () => {
    for (const current of ["succeeded", "failed", "interrupted"] as const) {
      for (const proposed of [
        "running",
        "succeeded",
        "failed",
        "interrupted",
        "uncertain",
      ] as const) {
        const decided = decideRecovery(current, proposed);
        expect(decided.status).toBe(current);
        expect(decided.disposition).toBe("already_final");
        expect(decided.revokeAuthority).toBe(false);
      }
    }
  });

  test("uncertain is refined by a definite answer and never reopened into running", () => {
    expect(decideRecovery("uncertain", "succeeded")).toEqual({
      status: "succeeded",
      disposition: "refined",
      revokeAuthority: false,
    });
    expect(decideRecovery("uncertain", "running")).toEqual({
      status: "uncertain",
      disposition: "unresumable",
      revokeAuthority: false,
    });
    expect(decideRecovery("uncertain", "uncertain")).toEqual({
      status: "uncertain",
      disposition: "uncertain",
      revokeAuthority: false,
    });
  });

  test("leaving running is the one transition that revokes authority", () => {
    expect(decideRecovery("running", "running").revokeAuthority).toBe(false);
    for (const proposed of [
      "succeeded",
      "failed",
      "interrupted",
      "uncertain",
    ] as const) {
      expect(decideRecovery("running", proposed).revokeAuthority).toBe(true);
    }
  });
});

describe("reconciling an attempt a previous process left running", () => {
  const cases: ReadonlyArray<
    readonly [HarnessObservedStatus, AttemptExecutionStatus, string, number]
  > = [
    ["succeeded", "succeeded", "settled", 1],
    ["failed", "failed", "settled", 1],
    ["interrupted", "interrupted", "settled", 1],
    ["missing", "uncertain", "uncertain", 1],
    ["unreachable", "uncertain", "uncertain", 1],
    ["running", "running", "still_running", 0],
  ];

  for (const [observed, status, disposition, fence] of cases) {
    test(`a session the harness reports as ${observed} settles the attempt as ${status}`, async () => {
      const path = newDatabasePath();
      const outcome = await withRecovery(
        path,
        { [SESSION]: observed },
        (store) =>
          Effect.gen(function* () {
            yield* seed(store, "attempt-1");
            const reconciled = yield* reconcileUnsettledAttempts();
            return {
              reconciled,
              attempt: yield* store.loadAttempt("attempt-1", TARGET),
              records: yield* store.recoveriesForAttempt("attempt-1"),
              unsettled: yield* store.unsettledAttempts(),
            };
          }),
      );

      expect(outcome.reconciled).toHaveLength(1);
      expect(outcome.attempt?.status).toBe(status);
      expect(outcome.attempt?.write_fence).toBe(fence);
      expect(outcome.records).toHaveLength(1);
      expect(outcome.records[0]?.observed_status).toBe(observed);
      expect(outcome.records[0]?.resulting_status).toBe(status);
      expect(outcome.records[0]?.disposition).toBe(disposition);
      expect(outcome.records[0]?.harness_session_id).toBe(SESSION);
      expect(outcome.records[0]?.prior_status).toBe("running");
      // Only a definite answer settles the attempt. `running` and `uncertain` both stay
      // in the set the next sweep reads, for different reasons: the first may still be
      // executing, and the second is an admission a later answer may refine.
      expect(outcome.unsettled.map((item) => item.status)).toEqual(
        status === "succeeded" ||
          status === "failed" ||
          status === "interrupted"
          ? []
          : [status],
      );
    });
  }

  test("an attempt with no session recorded is uncertain, and says why", async () => {
    // A process that died between creating a session and recording its id leaves this.
    // There is nothing to ask, and that is not the same as nothing having happened.
    const path = newDatabasePath();
    const outcome = await withRecovery(path, {}, (store) =>
      Effect.gen(function* () {
        yield* seed(store, "attempt-1", null);
        const reconciled = yield* reconcileUnsettledAttempts();
        return {
          reconciled,
          attempt: yield* store.loadAttempt("attempt-1", TARGET),
        };
      }),
    );

    expect(outcome.reconciled[0]?.observed).toBe("unbound");
    expect(outcome.attempt?.status).toBe("uncertain");
    expect(outcome.reconciled[0]?.harnessDetail).toContain(
      "does not establish that no work was done",
    );
  });

  test("an unknown session with no observations is uncertain, never failed", async () => {
    // The inference this test exists to forbid: "we hold no evidence, so nothing
    // happened". A worker can issue requests against a target and die before recording
    // anything, and the target does not roll back.
    const path = newDatabasePath();
    const outcome = await withRecovery(
      path,
      { [SESSION]: "missing" },
      (store) =>
        Effect.gen(function* () {
          yield* seed(store, "attempt-1");
          yield* reconcileUnsettledAttempts();
          return {
            attempt: yield* store.loadAttempt("attempt-1", TARGET),
            records: yield* store.recoveriesForAttempt("attempt-1"),
            observations: yield* store.observationsForIntent(INTENT),
          };
        }),
    );

    expect(outcome.observations).toHaveLength(0);
    expect(outcome.attempt?.status).toBe("uncertain");
    // Recorded as a fact about our own store, and visibly not used as a reason.
    expect(outcome.records[0]?.observations_at_recovery).toBe(0);
    expect(outcome.records[0]?.disposition).toBe("uncertain");
  });

  test("a settled attempt is never swept, and an unsettled one is", async () => {
    const path = newDatabasePath();
    const outcome = await withRecovery(
      path,
      { [SESSION]: "missing" },
      (store) =>
        Effect.gen(function* () {
          yield* seed(store, "attempt-done");
          yield* store.settleAttempt("attempt-done", "succeeded");
          yield* seed(store, "attempt-uncertain");
          yield* store.recordRecovery({
            attemptId: "attempt-uncertain",
            observed: "unreachable",
            proposedStatus: "uncertain",
            detail: "could not ask",
          });
          yield* seed(store, "attempt-live");
          const reconciled = yield* reconcileUnsettledAttempts();
          return {
            swept: reconciled.map((entry) => entry.attempt.id),
            done: yield* store.loadAttempt("attempt-done", TARGET),
            doneRecords: yield* store.recoveriesForAttempt("attempt-done"),
          };
        }),
    );

    // The uncertain one is swept too: it is still an open question, and this is the
    // only path by which a definite answer can ever reach it.
    // Sorted, because the sweep's own order is by start time and two seeds in the same
    // millisecond are ordinary; what is asserted here is which rows it picked up.
    expect([...outcome.swept].sort()).toEqual([
      "attempt-live",
      "attempt-uncertain",
    ]);
    expect(outcome.done?.status).toBe("succeeded");
    // Not reconciled at all, so not even a record: it was never a question.
    expect(outcome.doneRecords).toHaveLength(0);
  });
});

describe("repeating reconciliation", () => {
  test("three sweeps with the same answer record two states and repeat one", async () => {
    const path = newDatabasePath();
    const outcome = await withRecovery(
      path,
      { [SESSION]: "missing" },
      (store) =>
        Effect.gen(function* () {
          yield* seed(store, "attempt-1");
          const first = yield* reconcileUnsettledAttempts();
          const afterFirst = yield* store.loadAttempt("attempt-1", TARGET);
          // The attempt is `uncertain` now, so the sweep still finds it — which is the
          // point of sweeping uncertain rows, and makes the repeat a real sweep rather
          // than a direct call to `recordRecovery`.
          const second = yield* reconcileUnsettledAttempts();
          const third = yield* reconcileUnsettledAttempts();
          return {
            first: first[0]?.outcome,
            second: second[0]?.outcome,
            third: third[0]?.outcome,
            afterFirst,
            afterThird: yield* store.loadAttempt("attempt-1", TARGET),
            records: yield* store.recoveriesForAttempt("attempt-1"),
          };
        }),
    );

    // Two distinct reconciliation states, in the order they were first seen: leaving
    // `running` (which revoked authority) and then finding the row already `uncertain`
    // (which could not revoke it again). The old three-column key called these one
    // record and reported the first pass's fence movement for both.
    expect(
      outcome.records.map((record) => [
        record.prior_status,
        record.resulting_status,
        record.disposition,
        record.fence_before,
        record.fence_after,
        record.times,
      ]),
    ).toEqual([
      ["running", "uncertain", "uncertain", 0, 1, 1],
      ["uncertain", "uncertain", "uncertain", 1, 1, 2],
    ]);

    // Each pass was told what its own row holds, and the repeat incremented it.
    expect(outcome.first?.priorStatus).toBe("running");
    expect(outcome.first?.fenceBefore).toBe(0);
    expect(outcome.first?.fenceAfter).toBe(1);
    expect(outcome.first?.times).toBe(1);
    expect(outcome.second?.priorStatus).toBe("uncertain");
    expect(outcome.second?.fenceBefore).toBe(1);
    expect(outcome.second?.fenceAfter).toBe(1);
    expect(outcome.second?.times).toBe(1);
    expect(outcome.third?.times).toBe(2);

    // The fence moved exactly once, when the attempt stopped running, and no sweep
    // moved the status again.
    expect(outcome.afterFirst?.write_fence).toBe(1);
    expect(outcome.afterThird?.write_fence).toBe(1);
    expect(outcome.afterThird?.status).toBe("uncertain");
  });

  test("a settle and a later already-final pass are separate records", async () => {
    // The collision the original key allowed: both passes share an observed status and
    // a resulting status, and they decided different things. One row would have had to
    // hold both, and did — leaving `disposition = 'settled'` over a detail text that
    // said otherwise, and telling the second caller the first pass's fence movement.
    const path = newDatabasePath();
    const outcome = await withRecovery(path, {}, (store) =>
      Effect.gen(function* () {
        yield* seed(store, "attempt-1");
        const settled = yield* store.recordRecovery({
          attemptId: "attempt-1",
          observed: "succeeded",
          proposedStatus: "succeeded",
          detail: "the harness reported success",
        });
        const again = yield* store.recordRecovery({
          attemptId: "attempt-1",
          observed: "succeeded",
          proposedStatus: "succeeded",
          detail: "asked a second time",
        });
        return {
          settled,
          again,
          records: yield* store.recoveriesForAttempt("attempt-1"),
        };
      }),
    );

    expect(outcome.settled.disposition).toBe("settled");
    expect(outcome.settled.priorStatus).toBe("running");
    expect(outcome.settled.fenceAfter).toBe(1);
    expect(outcome.again.disposition).toBe("already_final");
    expect(outcome.again.priorStatus).toBe("succeeded");
    // Its own fencing, not the settle's: nothing was revoked by asking again.
    expect(outcome.again.fenceBefore).toBe(1);
    expect(outcome.again.fenceAfter).toBe(1);
    expect(outcome.again.times).toBe(1);

    expect(
      outcome.records.map((record) => [
        record.observed_status,
        record.prior_status,
        record.resulting_status,
        record.disposition,
        record.fence_before,
        record.fence_after,
        record.times,
      ]),
    ).toEqual([
      ["succeeded", "running", "succeeded", "settled", 0, 1, 1],
      ["succeeded", "succeeded", "succeeded", "already_final", 1, 1, 1],
    ]);
    // Every returned outcome names the row that holds it, and says the same thing.
    for (const outcomeAndRecord of [
      [outcome.settled, outcome.records[0]] as const,
      [outcome.again, outcome.records[1]] as const,
    ]) {
      const [returned, persisted] = outcomeAndRecord;
      expect(persisted?.disposition).toBe(returned.disposition);
      expect(persisted?.prior_status).toBe(returned.priorStatus);
      expect(persisted?.fence_before).toBe(returned.fenceBefore);
      expect(persisted?.fence_after).toBe(returned.fenceAfter);
      expect(persisted?.times).toBe(returned.times);
      expect(persisted?.detail).toBe(returned.detail);
    }
  });

  test("a terminal attempt is recorded as already final, not regressed", async () => {
    const path = newDatabasePath();
    const outcome = await withRecovery(path, {}, (store) =>
      Effect.gen(function* () {
        yield* seed(store, "attempt-1");
        yield* store.settleAttempt("attempt-1", "succeeded");
        const forced = yield* store.recordRecovery({
          attemptId: "attempt-1",
          observed: "failed",
          proposedStatus: "failed",
          detail: "the harness now claims this failed",
        });
        return {
          forced,
          attempt: yield* store.loadAttempt("attempt-1", TARGET),
          records: yield* store.recoveriesForAttempt("attempt-1"),
        };
      }),
    );

    // The contradicting answer is kept — it is worth having — but it changes nothing.
    expect(outcome.forced.status).toBe("succeeded");
    expect(outcome.forced.disposition).toBe("already_final");
    expect(outcome.attempt?.status).toBe("succeeded");
    expect(outcome.attempt?.write_fence).toBe(0);
    expect(outcome.records).toHaveLength(1);
    expect(outcome.records[0]?.observed_status).toBe("failed");
    expect(outcome.records[0]?.resulting_status).toBe("succeeded");
  });

  test("an uncertain attempt is refined by a later definite answer", async () => {
    const path = newDatabasePath();
    const outcome = await withRecovery(path, {}, (store) =>
      Effect.gen(function* () {
        yield* seed(store, "attempt-1");
        yield* store.recordRecovery({
          attemptId: "attempt-1",
          observed: "unreachable",
          proposedStatus: "uncertain",
          detail: "could not ask",
        });
        const refined = yield* store.recordRecovery({
          attemptId: "attempt-1",
          observed: "interrupted",
          proposedStatus: "interrupted",
          detail: "the harness came back and said it was interrupted",
        });
        return {
          refined,
          attempt: yield* store.loadAttempt("attempt-1", TARGET),
          records: yield* store.recoveriesForAttempt("attempt-1"),
        };
      }),
    );

    expect(outcome.refined.disposition).toBe("refined");
    expect(outcome.attempt?.status).toBe("interrupted");
    // Both answers are on the record, in the order they were first seen: the admission
    // and then the correction.
    expect(
      outcome.records.map((record) => [
        record.observed_status,
        record.prior_status,
        record.resulting_status,
        record.disposition,
      ]),
    ).toEqual([
      ["unreachable", "running", "uncertain", "uncertain"],
      ["interrupted", "uncertain", "interrupted", "refined"],
    ]);
  });

  test("unreachable then succeeded refines through two ordinary startup sweeps", async () => {
    // The gap this closes: refinement was reachable through `recordRecovery` and
    // nowhere else. A first sweep moved the attempt out of `running`, and a sweep that
    // read only running attempts never looked at it again — so a harness that came back
    // with a definite answer could not deliver it. Nothing in this test calls
    // `recordRecovery`; each leg is the sweep a process runs at startup, and the
    // database is closed and reopened between them.
    const path = newDatabasePath();
    const first = await withRecovery(
      path,
      { [SESSION]: "unreachable" },
      (store) =>
        Effect.gen(function* () {
          yield* seed(store, "attempt-1");
          const sweep = yield* reconcileUnsettledAttempts();
          return {
            dispositions: sweep.map((entry) => entry.outcome.disposition),
            attempt: yield* store.loadAttempt("attempt-1", TARGET),
          };
        }),
    );
    const second = await withRecovery(
      path,
      { [SESSION]: "succeeded" },
      (store) =>
        Effect.gen(function* () {
          const sweep = yield* reconcileUnsettledAttempts();
          return {
            swept: sweep.map((entry) => entry.attempt.id),
            outcome: sweep[0]?.outcome,
            attempt: yield* store.loadAttempt("attempt-1", TARGET),
            records: yield* store.recoveriesForAttempt("attempt-1"),
          };
        }),
    );
    // A third start, with the harness now contradicting itself. The attempt is final,
    // so it is not swept and the answer never reaches the row.
    const third = await withRecovery(path, { [SESSION]: "failed" }, (store) =>
      Effect.gen(function* () {
        const sweep = yield* reconcileUnsettledAttempts();
        return {
          swept: sweep.length,
          attempt: yield* store.loadAttempt("attempt-1", TARGET),
          records: yield* store.recoveriesForAttempt("attempt-1"),
        };
      }),
    );

    expect(first.dispositions).toEqual(["uncertain"]);
    expect(first.attempt?.status).toBe("uncertain");
    expect(first.attempt?.write_fence).toBe(1);

    expect(second.swept).toEqual(["attempt-1"]);
    expect(second.outcome?.priorStatus).toBe("uncertain");
    expect(second.outcome?.disposition).toBe("refined");
    expect(second.attempt?.status).toBe("succeeded");
    expect(second.attempt?.recovery_disposition).toBe("refined");
    // Refinement is new knowledge about an old attempt, not a new grant: the fence
    // stays where the first sweep left it.
    expect(second.attempt?.write_fence).toBe(1);
    expect(
      second.records.map((record) => [
        record.observed_status,
        record.prior_status,
        record.resulting_status,
        record.disposition,
      ]),
    ).toEqual([
      ["unreachable", "running", "uncertain", "uncertain"],
      ["succeeded", "uncertain", "succeeded", "refined"],
    ]);

    expect(third.swept).toBe(0);
    expect(third.attempt?.status).toBe("succeeded");
    expect(third.records).toHaveLength(2);
  });

  test("an uncertain attempt the harness reports live is swept but never resumed", async () => {
    const path = newDatabasePath();
    await withRecovery(path, { [SESSION]: "missing" }, (store) =>
      Effect.gen(function* () {
        yield* seed(store, "attempt-1");
        yield* reconcileUnsettledAttempts();
      }),
    );
    // The session turns out to be alive after all. That is not grounds for handing it
    // back: its authority was revoked when we gave up on it, and a write under the
    // credential it was issued is still refused.
    const outcome = await withRecovery(
      path,
      { [SESSION]: "running" },
      (store) =>
        Effect.gen(function* () {
          const sweep = yield* reconcileUnsettledAttempts();
          const write = yield* Effect.result(
            store.recordObservation(caller("attempt-1", 0), multiCaseInput()),
          );
          return {
            disposition: sweep[0]?.outcome.disposition,
            prior: sweep[0]?.outcome.priorStatus,
            attempt: yield* store.loadAttempt("attempt-1", TARGET),
            write,
            observations: yield* store.observationsForIntent(INTENT),
          };
        }),
    );

    expect(outcome.disposition).toBe("unresumable");
    expect(outcome.prior).toBe("uncertain");
    expect(outcome.attempt?.status).toBe("uncertain");
    expect(outcome.attempt?.write_fence).toBe(1);
    expect(outcome.write._tag).toBe("Failure");
    if (outcome.write._tag === "Failure") {
      expect((outcome.write.failure as MutationError).reason).toBe("stale");
    }
    expect(outcome.observations).toHaveLength(0);
  });

  test("an uncertain attempt is not reopened when the harness says it is running", async () => {
    const path = newDatabasePath();
    const outcome = await withRecovery(path, {}, (store) =>
      Effect.gen(function* () {
        yield* seed(store, "attempt-1");
        yield* store.recordRecovery({
          attemptId: "attempt-1",
          observed: "missing",
          proposedStatus: "uncertain",
          detail: "unknown session",
        });
        const late = yield* store.recordRecovery({
          attemptId: "attempt-1",
          observed: "running",
          proposedStatus: "running",
          detail: "the harness now reports the session live",
        });
        return {
          late,
          attempt: yield* store.loadAttempt("attempt-1", TARGET),
          unsettled: yield* store.unsettledAttempts(),
        };
      }),
    );

    // Its authority is already revoked, so it cannot write; resuming it would mean
    // running replacement work under an identity that has been fenced off.
    expect(outcome.late.disposition).toBe("unresumable");
    expect(outcome.attempt?.status).toBe("uncertain");
    // Still unsettled, so a later sweep will ask again — but `running` is not a status
    // it can be put back into, and nothing here restores its authority.
    expect(outcome.unsettled.map((item) => item.status)).toEqual(["uncertain"]);
  });

  test("reconciling an attempt that does not exist records nothing", async () => {
    const path = newDatabasePath();
    const outcome = await withRecovery(path, {}, (store) =>
      store.recordRecovery({
        attemptId: "attempt-never",
        observed: "missing",
        proposedStatus: "uncertain",
        detail: "no such attempt",
      }),
    );

    expect(outcome.status).toBeUndefined();
    expect(outcome.disposition).toBeUndefined();
    expect(outcome.detail).toContain("nothing was recorded");
  });
});

describe("write authority after recovery", () => {
  test("an observation under a settled attempt is refused as stale, and nothing is written", async () => {
    const path = newDatabasePath();
    const outcome = await withRecovery(
      path,
      { [SESSION]: "interrupted" },
      (store) =>
        Effect.gen(function* () {
          const authority = yield* seed(store, "attempt-1");
          yield* reconcileUnsettledAttempts();
          const refused = yield* Effect.result(
            store.recordObservation(
              caller("attempt-1", authority.writeFence),
              multiCaseInput({ operationId: "after-recovery" }),
            ),
          );
          return {
            refused,
            stored: yield* store.observationsForIntent(INTENT),
            sequence: yield* store.currentSequence,
          };
        }),
    );

    expect(outcome.refused._tag).toBe("Failure");
    if (outcome.refused._tag === "Failure") {
      expect(outcome.refused.failure).toBeInstanceOf(MutationError);
      const error = outcome.refused.failure as MutationError;
      expect(error.reason).toBe("stale");
      // The worker has to be able to tell "refused" from "lost".
      expect(error.detail).toContain("was NOT recorded");
      expect(error.detail).toContain("interrupted");
    }
    expect(outcome.stored).toHaveLength(0);
    expect(outcome.sequence).toBe(0);
  });

  test("a credential minted before the fence moved is refused after it, across a restart", async () => {
    // The in-memory registry is gone after a restart, so this is the half that has to
    // be durable: a token that somehow survived still presents a superseded fence.
    const path = newDatabasePath();
    const stale = await withRecovery(path, { [SESSION]: "missing" }, (store) =>
      Effect.gen(function* () {
        const authority = yield* seed(store, "attempt-1");
        yield* reconcileUnsettledAttempts();
        return authority.writeFence;
      }),
    );

    const outcome = await withRecovery(path, {}, (store) =>
      Effect.gen(function* () {
        const attempt = yield* store.loadAttempt("attempt-1", TARGET);
        // Force the attempt back to running, so the *only* thing refusing the write is
        // the fence rather than the status.
        const reopened = yield* store.recordRecovery({
          attemptId: "attempt-1",
          observed: "running",
          proposedStatus: "running",
          detail: "scripted",
        });
        const refused = yield* Effect.result(
          store.recordObservation(
            caller("attempt-1", stale),
            multiCaseInput({ operationId: "stale-fence" }),
          ),
        );
        return { attempt, reopened, refused };
      }),
    );

    expect(stale).toBe(0);
    expect(outcome.attempt?.write_fence).toBe(1);
    // `unresumable`, so the attempt is still not running and the status check alone
    // would have refused it; the fence assertion below is the durable one.
    expect(outcome.reopened.disposition).toBe("unresumable");
    expect(outcome.refused._tag).toBe("Failure");
    if (outcome.refused._tag === "Failure") {
      expect((outcome.refused.failure as MutationError).reason).toBe("stale");
    }
  });

  test("a write presenting an out-of-date fence on a live attempt is refused", async () => {
    const path = newDatabasePath();
    const outcome = await withRecovery(path, {}, (store) =>
      Effect.gen(function* () {
        yield* seed(store, "attempt-1");
        const refused = yield* Effect.result(
          store.recordObservation(
            caller("attempt-1", 7),
            multiCaseInput({ operationId: "wrong-fence" }),
          ),
        );
        const accepted = yield* store.recordObservation(
          caller("attempt-1", 0),
          multiCaseInput({ operationId: "right-fence" }),
        );
        return { refused, accepted };
      }),
    );

    expect(outcome.refused._tag).toBe("Failure");
    if (outcome.refused._tag === "Failure") {
      const error = outcome.refused.failure as MutationError;
      expect(error.reason).toBe("stale");
      expect(error.detail).toContain("fence 7");
    }
    expect(outcome.accepted.replayed).toBe(false);
  });

  test("reconciliation revokes the attempt's live credentials as well as fencing it", async () => {
    const path = newDatabasePath();
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* ObservationStore;
          const credentials = yield* McpCredentials;
          const authority = yield* seed(store, "attempt-1");
          const issued = yield* credentials.issue({
            _tag: "attempt",
            targetId: TARGET,
            intentId: INTENT,
            attemptId: "attempt-1",
            harnessSessionId: SESSION,
            workerId: "worker-1",
            attemptFence: authority.writeFence,
          });
          const other = yield* credentials.issue({
            _tag: "attempt",
            targetId: TARGET,
            intentId: INTENT,
            attemptId: "attempt-other",
            harnessSessionId: "ses_other",
            workerId: "worker-2",
            attemptFence: 0,
          });
          const before = yield* credentials.size;
          const reconciled = yield* reconcileUnsettledAttempts();
          return {
            before,
            revoked: reconciled[0]?.revokedGrants,
            resolvesMine: yield* credentials.resolve(
              Redacted.value(issued.token),
            ),
            size: yield* credentials.size,
            // The grant is a tagged union now, so reading an attempt's id means saying
            // that is what this is. The assertion below is unchanged.
            otherAttempt:
              other.grant._tag === "attempt"
                ? other.grant.attemptId
                : undefined,
          };
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              ObservationStore.layer(path),
              HarnessSessionStatus.fromAnswers({ [SESSION]: "missing" }),
              McpCredentials.layer,
            ),
          ),
        ),
      ),
    );

    expect(outcome.before).toBe(2);
    expect(outcome.revoked).toBe(1);
    expect(outcome.resolvesMine).toBeUndefined();
    // Another attempt's credential is untouched: revocation is per attempt.
    expect(outcome.size).toBe(1);
    expect(outcome.otherAttempt).toBe("attempt-other");
  });

  test("an exact retry still replays after the attempt was settled", async () => {
    // Receipt semantics are preserved deliberately. A replay writes nothing and creates
    // no external effect; refusing it would tell a worker its evidence was lost when it
    // is stored and durable, which is the one thing it must never be told wrongly.
    const path = newDatabasePath();
    const outcome = await withRecovery(
      path,
      { [SESSION]: "succeeded" },
      (store) =>
        Effect.gen(function* () {
          const authority = yield* seed(store, "attempt-1");
          const written = yield* store.recordObservation(
            caller("attempt-1", authority.writeFence),
            multiCaseInput({ operationId: "before-recovery" }),
          );
          yield* reconcileUnsettledAttempts();
          const replay = yield* store.recordObservation(
            caller("attempt-1", authority.writeFence),
            multiCaseInput({ operationId: "before-recovery" }),
          );
          const conflict = yield* Effect.result(
            store.recordObservation(
              caller("attempt-1", authority.writeFence),
              multiCaseInput({
                operationId: "before-recovery",
                outcome: "negative",
              }),
            ),
          );
          return {
            written,
            replay,
            conflict,
            stored: yield* store.observationsForIntent(INTENT),
          };
        }),
    );

    expect(outcome.replay.replayed).toBe(true);
    expect(outcome.replay.observationId).toBe(outcome.written.observationId);
    // A *conflicting* reuse is still a conflict, not a silent second write.
    expect(outcome.conflict._tag).toBe("Failure");
    if (outcome.conflict._tag === "Failure") {
      expect((outcome.conflict.failure as MutationError).reason).toBe(
        "conflict",
      );
    }
    expect(outcome.stored).toHaveLength(1);
  });
});

describe("replacement work", () => {
  /** The replacement half of a seeded attempt's identity, minus the ids under test. */
  const replacementBase = {
    targetId: TARGET,
    intentId: INTENT,
    workerId: "worker-1",
    harnessInstanceId: "opencode",
    providerId: "openai",
    modelId: "gpt-5.6-sol",
    modelOptions: null,
    harnessSessionId: null,
  } as const;

  test("a replacement is a new attempt that links to the old one, and survives a reopen", async () => {
    const path = newDatabasePath();
    const outcome = await withRecovery(
      path,
      { [SESSION]: "interrupted" },
      (store) =>
        Effect.gen(function* () {
          yield* seed(store, "attempt-1");
          yield* reconcileUnsettledAttempts();
          const authority = yield* store.openReplacementAttempt({
            ...replacementBase,
            attemptId: "attempt-2",
            replacesAttemptId: "attempt-1",
          });
          return {
            authority,
            old: yield* store.loadAttempt("attempt-1", TARGET),
            replacement: yield* store.loadAttempt("attempt-2", TARGET),
          };
        }),
    );
    // Reopened, because the link is the only thing connecting the two attempts and a
    // column that is written outside its transaction is exactly what a crash loses.
    const reread = await withRecovery(path, {}, (store) =>
      Effect.gen(function* () {
        return {
          replacement: yield* store.loadAttempt("attempt-2", TARGET),
          // The replacement is the only unsettled attempt now.
          unsettled: yield* store.unsettledAttempts(),
        };
      }),
    );

    expect(outcome.authority).toEqual({
      attemptId: "attempt-2",
      writeFence: 0,
    });
    // The old attempt keeps what recovery decided, and its session is not inherited.
    expect(outcome.old?.status).toBe("interrupted");
    expect(outcome.replacement?.status).toBe("running");
    expect(outcome.replacement?.replaces_attempt_id).toBe("attempt-1");
    expect(outcome.replacement?.harness_session_id).toBeNull();
    // Opened under the predecessor's own goal and intent, not a re-seeded copy.
    expect(outcome.replacement?.intent_id).toBe(INTENT);
    expect(outcome.replacement?.target_id).toBe(TARGET);
    expect(reread.replacement?.replaces_attempt_id).toBe("attempt-1");
    expect(reread.replacement?.write_fence).toBe(0);
    expect(reread.unsettled.map((item) => item.id)).toEqual(["attempt-2"]);
  });

  test("an uncertain attempt can be replaced, which is how work carries on", async () => {
    const path = newDatabasePath();
    const outcome = await withRecovery(
      path,
      { [SESSION]: "unreachable" },
      (store) =>
        Effect.gen(function* () {
          yield* seed(store, "attempt-1");
          yield* reconcileUnsettledAttempts();
          const authority = yield* store.openReplacementAttempt({
            ...replacementBase,
            attemptId: "attempt-2",
            replacesAttemptId: "attempt-1",
          });
          return {
            authority,
            old: yield* store.loadAttempt("attempt-1", TARGET),
            replacement: yield* store.loadAttempt("attempt-2", TARGET),
          };
        }),
    );

    // The predecessor stays `uncertain` — the replacement does not resolve it — and the
    // new attempt gets its own authority rather than inheriting the fenced-off one.
    expect(outcome.old?.status).toBe("uncertain");
    expect(outcome.old?.write_fence).toBe(1);
    expect(outcome.replacement?.status).toBe("running");
    expect(outcome.authority.writeFence).toBe(0);
  });

  test("a running attempt cannot be replaced, and nothing may reuse its id", async () => {
    const path = newDatabasePath();
    const outcome = await withRecovery(path, {}, (store) =>
      Effect.gen(function* () {
        yield* seed(store, "attempt-1");
        const whileRunning = yield* Effect.result(
          store.openReplacementAttempt({
            ...replacementBase,
            attemptId: "attempt-2",
            replacesAttemptId: "attempt-1",
          }),
        );
        const afterRefusal = yield* store.loadAttempt("attempt-2", TARGET);
        yield* store.settleAttempt("attempt-1", "interrupted");
        const sameId = yield* Effect.result(
          store.openReplacementAttempt({
            ...replacementBase,
            attemptId: "attempt-1",
            replacesAttemptId: "attempt-1",
          }),
        );
        return {
          whileRunning,
          afterRefusal,
          sameId,
          old: yield* store.loadAttempt("attempt-1", TARGET),
        };
      }),
    );

    expect(outcome.whileRunning._tag).toBe("Failure");
    // A refusal writes nothing at all: no half-seeded attempt row to find later.
    expect(outcome.afterRefusal).toBeUndefined();
    expect(outcome.sameId._tag).toBe("Failure");
    if (outcome.sameId._tag === "Failure") {
      expect((outcome.sameId.failure as MutationError).detail).toContain(
        "its own attempt id",
      );
    }
    // And the predecessor was not relinked to itself by the refused call.
    expect(outcome.old?.replaces_attempt_id).toBeNull();
  });

  test("an attempt id already in use is refused, not adopted and relinked", async () => {
    // The hazard in the arrangement this replaces: it seeded with
    // `ON CONFLICT DO NOTHING`, so an id that already existed looked like a successful
    // seed, and the link was then written over somebody else's attempt.
    const path = newDatabasePath();
    const outcome = await withRecovery(path, {}, (store) =>
      Effect.gen(function* () {
        yield* seed(store, "attempt-1");
        yield* store.settleAttempt("attempt-1", "interrupted");
        // An unrelated attempt that already owns the id the replacement wants.
        yield* seed(store, "attempt-existing");
        const refused = yield* Effect.result(
          store.openReplacementAttempt({
            ...replacementBase,
            attemptId: "attempt-existing",
            replacesAttemptId: "attempt-1",
          }),
        );
        return {
          refused,
          existing: yield* store.loadAttempt("attempt-existing", TARGET),
          old: yield* store.loadAttempt("attempt-1", TARGET),
        };
      }),
    );

    expect(outcome.refused._tag).toBe("Failure");
    if (outcome.refused._tag === "Failure") {
      const failure = outcome.refused.failure as MutationError;
      expect(failure.reason).toBe("invalid");
      expect(failure.detail).toContain("already exists");
      expect(failure.detail).toContain("is not adopted");
    }
    // Untouched: still running, still unlinked, still its own attempt.
    expect(outcome.existing?.status).toBe("running");
    expect(outcome.existing?.replaces_attempt_id).toBeNull();
    expect(outcome.existing?.harness_session_id).toBe(SESSION);
    expect(outcome.old?.status).toBe("interrupted");
  });

  test("a predecessor from another intent or target is refused", async () => {
    const path = newDatabasePath();
    const outcome = await withRecovery(path, {}, (store) =>
      Effect.gen(function* () {
        // A second slice: its own goal, intent and target.
        yield* store.seedAttempt({
          targetId: "target-2",
          goalId: "goal-2",
          goal: "A different goal entirely.",
          intentId: "intent-2",
          question: "A different question.",
          attemptId: "other-attempt",
          workerId: "worker-9",
          harnessInstanceId: "opencode",
          providerId: "openai",
          modelId: "gpt-5.6-sol",
          modelOptions: null,
          harnessSessionId: null,
        });
        yield* store.settleAttempt("other-attempt", "interrupted");
        // Claiming the first slice's target and intent over the other slice's attempt.
        const crossSlice = yield* Effect.result(
          store.openReplacementAttempt({
            ...replacementBase,
            attemptId: "attempt-2",
            replacesAttemptId: "other-attempt",
          }),
        );
        // And the mirror image: the right intent, the wrong target.
        yield* seed(store, "attempt-1");
        yield* store.settleAttempt("attempt-1", "interrupted");
        const crossTarget = yield* Effect.result(
          store.openReplacementAttempt({
            ...replacementBase,
            targetId: "target-2",
            attemptId: "attempt-3",
            replacesAttemptId: "attempt-1",
          }),
        );
        const missing = yield* Effect.result(
          store.openReplacementAttempt({
            ...replacementBase,
            attemptId: "attempt-4",
            replacesAttemptId: "attempt-never",
          }),
        );
        return {
          crossSlice,
          crossTarget,
          missing,
          second: yield* store.loadAttempt("attempt-2", TARGET),
          third: yield* store.loadAttempt("attempt-3", "target-2"),
          fourth: yield* store.loadAttempt("attempt-4", TARGET),
        };
      }),
    );

    for (const refused of [
      outcome.crossSlice,
      outcome.crossTarget,
      outcome.missing,
    ]) {
      expect(refused._tag).toBe("Failure");
    }
    if (outcome.crossSlice._tag === "Failure") {
      expect((outcome.crossSlice.failure as MutationError).detail).toContain(
        "not to target target-1 and intent intent-1",
      );
    }
    if (outcome.crossTarget._tag === "Failure") {
      expect((outcome.crossTarget.failure as MutationError).detail).toContain(
        "carries on the same slice",
      );
    }
    if (outcome.missing._tag === "Failure") {
      expect((outcome.missing.failure as MutationError).detail).toContain(
        "no attempt attempt-never to replace",
      );
    }
    // None of the three wrote an attempt row.
    expect(outcome.second).toBeUndefined();
    expect(outcome.third).toBeUndefined();
    expect(outcome.fourth).toBeUndefined();
  });

  test("a failure writing the replacement leaves no trace of it", async () => {
    // Atomicity, against the real engine rather than by inspection. A trigger makes the
    // insert itself fail *after* it has happened, which is the shape of the hazard: the
    // arrangement this replaces seeded the attempt in one transaction and linked it in a
    // second statement outside it, so a failure in between left a replacement with no
    // record of what it replaced.
    const path = newDatabasePath();
    await withRecovery(path, {}, (store) =>
      Effect.gen(function* () {
        yield* seed(store, "attempt-1");
        yield* store.settleAttempt("attempt-1", "interrupted");
      }),
    );
    const sqlite = new (await import("bun:sqlite")).Database(path);
    sqlite.run(
      `CREATE TRIGGER refuse_new_attempts AFTER INSERT ON attempts
       BEGIN SELECT RAISE(ABORT, 'forced failure for the atomicity test'); END`,
    );
    sqlite.close();

    const failed = await withRecovery(path, {}, (store) =>
      Effect.result(
        store.openReplacementAttempt({
          ...replacementBase,
          attemptId: "attempt-2",
          replacesAttemptId: "attempt-1",
        }),
      ),
    );

    const dropped = new (await import("bun:sqlite")).Database(path);
    dropped.run(`DROP TRIGGER refuse_new_attempts`);
    dropped.close();

    const after = await withRecovery(path, {}, (store) =>
      Effect.gen(function* () {
        return {
          replacement: yield* store.loadAttempt("attempt-2", TARGET),
          old: yield* store.loadAttempt("attempt-1", TARGET),
          unsettled: yield* store.unsettledAttempts(),
          // The same call again, now that the trigger is gone.
          retried: yield* store.openReplacementAttempt({
            ...replacementBase,
            attemptId: "attempt-2",
            replacesAttemptId: "attempt-1",
          }),
          linked: yield* store.loadAttempt("attempt-2", TARGET),
        };
      }),
    );

    expect(failed._tag).toBe("Failure");
    // Not a MutationError: the refusal came from the engine, and it is reported as a
    // database failure rather than as a domain decision.
    if (failed._tag === "Failure") {
      expect((failed.failure as { _tag: string })._tag).toBe("DatabaseError");
    }
    // Nothing was left behind: no replacement row, and no attempt in a state where it
    // exists but does not say what it replaced.
    expect(after.replacement).toBeUndefined();
    expect(after.unsettled).toHaveLength(0);
    expect(after.old?.status).toBe("interrupted");
    // And the operation is still available afterwards, with the link intact.
    expect(after.retried).toEqual({ attemptId: "attempt-2", writeFence: 0 });
    expect(after.linked?.replaces_attempt_id).toBe("attempt-1");
  });
});

describe("recovery state survives a restart", () => {
  test("statuses, dispositions, fences and records are all still there", async () => {
    const path = newDatabasePath();
    await withRecovery(path, { [SESSION]: "missing" }, (store) =>
      Effect.gen(function* () {
        yield* seed(store, "attempt-1");
        yield* reconcileUnsettledAttempts();
      }),
    );

    const reread = await withRecovery(path, {}, (store) =>
      Effect.gen(function* () {
        return {
          attempt: yield* store.loadAttempt("attempt-1", TARGET),
          records: yield* store.recoveriesForAttempt("attempt-1"),
          unsettled: yield* store.unsettledAttempts(),
        };
      }),
    );

    expect(reread.attempt?.status).toBe("uncertain");
    expect(reread.attempt?.recovery_disposition).toBe("uncertain");
    expect(reread.attempt?.recovered_at).not.toBeNull();
    expect(reread.attempt?.ended_at).not.toBeNull();
    expect(reread.attempt?.write_fence).toBe(1);
    expect(reread.records).toHaveLength(1);
    expect(reread.records[0]?.prior_status).toBe("running");
    // Reopened, the row is still an open question rather than a settled one.
    expect(reread.unsettled.map((item) => item.id)).toEqual(["attempt-1"]);
  });
});

/**
 * The instance the seeded rows in this file name.
 *
 * The adapter refuses to ask about an attempt that ran on another instance, so a stub that
 * claimed to be `stub` while the rows said `opencode` would exercise that branch on every
 * assertion instead of the mapping these tests are about.
 */
const OPENCODE_INSTANCE = defaultInstanceIdForDriver(OPENCODE_DRIVER);

describe("the live harness adapter's own mapping", () => {
  /** A client that answers one way, so the adapter's branches are the thing under test. */
  const clientLayer = (
    answer: Effect.Effect<
      { readonly outcome?: "succeeded" | "failed" | "interrupted" | undefined },
      HarnessTransportError
    >,
  ) =>
    Layer.succeed(
      AgentHarness,
      // Only `sessionStatus` is scripted: what is under test is the adapter's mapping of
      // one answer, and every other member answering dully is what makes that legible.
      stubHarness({
        instance: { ...STUB_INSTANCE, instanceId: OPENCODE_INSTANCE },
        sessionStatus: () => answer,
      }),
    );

  const observe = (
    answer: Effect.Effect<
      { readonly outcome?: "succeeded" | "failed" | "interrupted" | undefined },
      HarnessTransportError
    >,
  ) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(HarnessSessionStatus, (harness) =>
          harness.of("ses_old", "opencode"),
        ).pipe(
          Effect.provide(
            HarnessSessionStatus.layer.pipe(
              // One configured instance, which is what the slice-B comparison was; the
              // foreign-instance case now goes through the resolver and is covered in
              // `harness/resolver.test.ts`.
              Layer.provide(HarnessResolver.single),
              Layer.provide(clientLayer(answer)),
            ),
          ),
        ),
      ),
    );

  test("a session with no terminal outcome is still running", async () => {
    const report = await observe(Effect.succeed({ outcome: undefined }));
    expect(report.observed).toBe("running");
  });

  test("a reported outcome is carried through verbatim", async () => {
    const report = await observe(Effect.succeed({ outcome: "interrupted" }));
    expect(report.observed).toBe("interrupted");
  });

  test("the client's SessionNotFoundError means missing, not unreachable", async () => {
    const report = await observe(
      Effect.fail(
        new HarnessTransportError({
          operation: "session.get",
          status: 404,
          tag: "SessionNotFoundError",
          detail: "SessionNotFoundError: no such session",
          cause: "none",
        }),
      ),
    );
    expect(report.observed).toBe("missing");
    expect(mapObserved(report.observed)).toBe("uncertain");
  });

  test("a transport failure with no status is unreachable", async () => {
    // "We could not ask" must never collapse into "it does not exist", because the two
    // are the same disposition for different reasons and the operator needs to know
    // which.
    const report = await observe(
      Effect.fail(
        new HarnessTransportError({
          operation: "session.get",
          status: undefined,
          tag: "RequestError",
          detail: "connection refused",
          cause: "none",
        }),
      ),
    );
    expect(report.observed).toBe("unreachable");
    expect(report.detail).toContain("could not ask the harness");
  });
});

describe("an intent claim a dead process left behind", () => {
  const HOST = { callerScope: `${TARGET}/operator`, targetId: TARGET };

  /** A goal and one open intent under it, written and then left behind by "the old process". */
  const operatorMadeIntent = (store: ObservationStore["Service"]) =>
    Effect.gen(function* () {
      yield* store.openGoal(HOST, {
        operationId: "open-goal",
        goalId: "goal-1",
        name: "",
        description:
          "Determine whether authentication rate limits can be bypassed.",
      });
      yield* store.addIntent(HOST, {
        operationId: "add-intent",
        goalId: "goal-1",
        intentId: INTENT,
        question: "Probe the per-client limiter on POST /login.",
        anchorObservationIds: [],
        addressesDimension: null,
      });
    });

  const intentState = (store: ObservationStore["Service"]) =>
    Effect.map(store.intent(INTENT), (intent) => ({
      status: intent?.status,
      claimedBy: intent?.claimedByAttemptId,
    }));

  test("a claim with no attempt row is neither runnable nor abandonable, until the sweep gives it back", async () => {
    const path = newDatabasePath();
    // The old process: claims the intent, then dies before writing the attempt.
    await withRecovery(path, {}, (store) =>
      Effect.gen(function* () {
        yield* operatorMadeIntent(store);
        yield* store.claimIntent(HOST, INTENT, "att-never-written");
      }),
    );

    // The new process.
    const outcome = await withRecovery(path, {}, (store) =>
      Effect.gen(function* () {
        const stuckRun = yield* Effect.result(
          store.claimIntent(HOST, INTENT, "att-retry"),
        );
        const stuckAbandon = yield* Effect.result(
          store.abandonIntent(HOST, {
            operationId: "abandon-stuck",
            intentId: INTENT,
            reason: "",
          }),
        );
        // The attempt sweep cannot see it: there is no row for it to enumerate.
        const attemptSweep = yield* reconcileUnsettledAttempts();

        const released = yield* releaseOrphanedClaims();
        const afterRelease = yield* intentState(store);
        const events = yield* store.eventsAfter();
        // Repeating it finds nothing: the claim it gave back is gone.
        const again = yield* releaseOrphanedClaims();
        // Runnable again, which is the whole point.
        const rerun = yield* store.claimIntent(HOST, INTENT, "att-retry");
        return {
          stuckRun,
          stuckAbandon,
          attemptSweep,
          released,
          afterRelease,
          events: events.filter((event) => event.kind === "intent.released"),
          rerun,
          again,
          afterRerun: yield* intentState(store),
        };
      }),
    );

    // The two ways out that did not work.
    expect(outcome.stuckRun._tag).toBe("Failure");
    expect(outcome.stuckAbandon._tag).toBe("Failure");
    expect(outcome.attemptSweep).toEqual([]);

    expect(outcome.released).toEqual([
      {
        intentId: INTENT,
        goalId: "goal-1",
        targetId: TARGET,
        claimedByAttemptId: "att-never-written",
        attemptStatus: null,
      },
    ]);
    // `open`, never `answered`: nothing ran, so nothing is known.
    expect(outcome.afterRelease).toEqual({ status: "open", claimedBy: null });
    expect(outcome.rerun.claimedByAttemptId).toBe("att-retry");
    expect(outcome.afterRerun).toEqual({
      status: "claimed",
      claimedBy: "att-retry",
    });
    // Recorded as the sweep records its other work: an event naming what it found.
    expect(outcome.events).toHaveLength(1);
    expect(outcome.events[0]).toMatchObject({
      subjectId: INTENT,
      callerScope: null,
      payload: {
        claimedByAttemptId: "att-never-written",
        attemptStatus: null,
        releasedBy: "recovery",
      },
    });
    expect(outcome.again).toEqual([]);
  });

  test("a claim held by a running attempt is not an orphan; the attempt sweep gives it back when it settles the attempt", async () => {
    const path = newDatabasePath();
    const outcome = await withRecovery(
      path,
      { [SESSION]: "missing" },
      (store) =>
        Effect.gen(function* () {
          yield* operatorMadeIntent(store);
          yield* store.claimIntent(HOST, INTENT, "attempt-1");
          yield* seed(store, "attempt-1");
          const released = yield* releaseOrphanedClaims();
          const whileRunning = yield* intentState(store);
          yield* reconcileUnsettledAttempts();
          return { released, whileRunning, after: yield* intentState(store) };
        }),
    );
    // Left to the sweep that asks the harness.
    expect(outcome.released).toEqual([]);
    expect(outcome.whileRunning).toEqual({
      status: "claimed",
      claimedBy: "attempt-1",
    });
    // The harness could not find the session: `uncertain`, so the intent is open, not answered.
    expect(outcome.after).toEqual({ status: "open", claimedBy: null });
  });

  test("a claim whose attempt has already settled is given back as open, even with an observation under it", async () => {
    const path = newDatabasePath();
    await withRecovery(path, {}, (store) =>
      Effect.gen(function* () {
        yield* operatorMadeIntent(store);
        yield* store.claimIntent(HOST, INTENT, "attempt-1");
        yield* seed(store, "attempt-1");
        yield* store.recordObservation(
          caller("attempt-1", 0),
          multiCaseInput(),
        );
      }),
    );
    // A stale lock the settlement should have released and did not, written directly: the
    // transactional path cannot produce it, which is why this is a repair and not a rule.
    const database = new Database(path);
    try {
      database.run(
        "UPDATE attempts SET status = 'succeeded', ended_at = 1 WHERE id = 'attempt-1'",
      );
    } finally {
      database.close();
    }

    const outcome = await withRecovery(path, {}, (store) =>
      Effect.gen(function* () {
        const released = yield* releaseOrphanedClaims();
        return { released, after: yield* intentState(store) };
      }),
    );
    expect(outcome.released.map((claim) => claim.attemptStatus)).toEqual([
      "succeeded",
    ]);
    // It does not read observations: reconciling a lock is not judging the work.
    expect(outcome.after).toEqual({ status: "open", claimedBy: null });
  });
});
