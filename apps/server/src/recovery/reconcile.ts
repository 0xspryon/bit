/**
 * Startup reconciliation of attempts no definite answer has been reached about.
 *
 * A row at `status: 'running'` after a restart is a question, not a fact: the process
 * that owned it is gone, so nothing in memory knows what became of it. Nothing used to
 * answer that question — the §20 review recorded two such rows in the development
 * database as "the largest open gap". This is the path that answers it, and those two
 * rows have since been reconciled through it (DECISIONS.md §22).
 *
 * **`uncertain` is a question too, and is asked again.** The sweep reads `running` *and*
 * `uncertain` ({@link ObservationStore} `unsettledAttempts`), because `uncertain` is an
 * admission that we could not find out and the store allows a later definite answer to
 * refine it. A sweep that read only `running` could never deliver one: the first pass
 * moved the row out of `running`, and nothing looked at it again. Final statuses are
 * never swept — an attempt that succeeded, failed or was interrupted is settled, and
 * asking again could only produce a contradiction nothing is allowed to act on.
 *
 * **What reconciliation is allowed to conclude.** Only what the harness says, mapped by
 * {@link mapObserved}. In particular:
 *
 * - An unreachable or unknown session is `uncertain`, never `failed`. "We could not ask"
 *   and "it did not work" are different facts and only one of them is in evidence.
 * - Holding no observation for an attempt is **never** grounds for concluding that the
 *   attempt had no external effect. A worker can issue requests against a target and
 *   die before recording anything, and the target does not roll back. The observation
 *   count is recorded alongside the disposition as a fact about our own store, and is
 *   not an input to it.
 * - A terminal attempt is never regressed, and a replacement is never run under an
 *   abandoned attempt's identity. Both rules live in the store, where the write happens
 *   (`persistence/store.ts` `decideRecovery`).
 *
 * **Ordering is load-bearing.** The harness is asked *before* the transaction opens, so
 * no HTTP call ever happens while SQLite's single write lock is held. One attempt is one
 * ask plus one transaction; there is no batch that would hold the lock across several.
 *
 * **Authority is revoked twice over.** The durable half is the attempt's `write_fence`,
 * bumped by the store when the attempt stops running, so a credential minted against the
 * old value is refused even after a restart. The in-memory half is the credential
 * registry, which is told to drop any live grant for the attempt — relevant when
 * reconciliation runs in a process that is also serving, so a late call from a session
 * we have just given up on cannot still write.
 */
import { Effect, Option } from "effect";

import { McpCredentials } from "../mcp/credentials";
import {
  ObservationStore,
  type AttemptExecutionStatus,
  type AttemptRow,
  type RecoveryOutcome,
  type ReleasedClaim,
} from "../persistence/store";
import {
  HarnessSessionStatus,
  type HarnessObservedStatus,
} from "./harnessStatus";

/**
 * The status one harness answer proposes for an attempt.
 *
 * The store decides what actually happens to the row — it applies the no-regression
 * rules — so this is a proposal, not a verdict. Three of the seven answers map onto
 * `uncertain`, and that is the point of the mapping: there is no path from "we do not
 * know" to a definite execution status.
 */
export const mapObserved = (
  observed: HarnessObservedStatus,
): AttemptExecutionStatus => {
  switch (observed) {
    case "running":
      return "running";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    case "unbound":
    case "missing":
    case "unreachable":
      return "uncertain";
  }
};

export interface Reconciliation {
  readonly attempt: AttemptRow;
  readonly observed: HarnessObservedStatus;
  readonly harnessDetail: string;
  readonly outcome: RecoveryOutcome;
  /** Live in-memory grants dropped for this attempt, if a registry was available. */
  readonly revokedGrants: number;
}

/**
 * Reconciles one attempt: ask, then record.
 *
 * Exported separately from the sweep because that is the unit worth testing and the
 * unit worth running by hand against a single suspect row.
 */
export const reconcileAttempt = Effect.fn("reconcileAttempt")(function* (
  attempt: AttemptRow,
) {
  const harness = yield* HarnessSessionStatus;
  const store = yield* ObservationStore;
  const credentials = yield* Effect.serviceOption(McpCredentials);

  // Outside any transaction, deliberately: this is the HTTP call.
  const report = yield* harness.of(
    attempt.harness_session_id,
    attempt.harness_instance_id,
  );
  const proposed = mapObserved(report.observed);

  const outcome = yield* store.recordRecovery({
    attemptId: attempt.id,
    observed: report.observed,
    proposedStatus: proposed,
    detail: report.detail,
  });

  // Only once the durable fence has moved. Revoking first would open a window where
  // the credential is gone but the row still says the attempt may write.
  const revokedGrants =
    outcome.status !== undefined &&
    outcome.status !== "running" &&
    Option.isSome(credentials)
      ? yield* credentials.value.revokeAttempt(attempt.id)
      : 0;

  return {
    attempt,
    observed: report.observed,
    harnessDetail: report.detail,
    outcome,
    revokedGrants,
  } satisfies Reconciliation;
});

/**
 * Reconciles every attempt that is neither settled nor concluded: `running` and
 * `uncertain`.
 *
 * Run at startup, before any new work is dispatched. It is safe to run repeatedly: a
 * recovery record is keyed by the whole reconciliation state, so repeating the same one
 * increments `times` on one row rather than writing another, and a final attempt is not
 * swept at all.
 *
 * What each kind of row can become here:
 *
 * - `running` + the harness still reports it live → left alone (`still_running`). This
 *   is the whole reason the sweep does not simply mark what it finds as interrupted.
 * - `running` + a definite answer → settled, authority revoked.
 * - `running` + no answer → `uncertain`, authority revoked anyway.
 * - `uncertain` + a definite answer → `refined`. This is the case the previous
 *   running-only sweep could not reach.
 * - `uncertain` + the harness reporting it live → `unresumable`, and nothing is
 *   restored: the fence has already moved, so that session cannot write, and carrying
 *   the work on means a new attempt identity (`openReplacementAttempt`).
 */
export const reconcileUnsettledAttempts = Effect.fn(
  "reconcileUnsettledAttempts",
)(function* () {
  const store = yield* ObservationStore;
  const unsettled = yield* store.unsettledAttempts();
  if (unsettled.length === 0) return [];
  yield* Effect.logInfo(
    `reconciling ${String(unsettled.length)} attempt(s) with no settled outcome: ` +
      unsettled.map((attempt) => `${attempt.id}:${attempt.status}`).join(", "),
  );
  return yield* Effect.forEach(unsettled, reconcileAttempt);
});

/**
 * Gives back the intent claims a dead process left behind that no attempt can settle.
 *
 * {@link reconcileUnsettledAttempts} enumerates `attempts`, so it can only see a claim that
 * has an attempt row. A process that died after claiming an intent and before writing the
 * attempt leaves a claim with none, and that intent could then be neither run nor abandoned.
 * This finds it by the claim and returns it to `open`: nothing ran, so nothing is known, and
 * like the attempt sweep it **reconciles rather than guesses** — it asks no one, concludes
 * nothing about the work, and never marks an intent `answered`. A claim whose attempt exists
 * and has already left `running` is given back the same way; a `running` attempt is left to
 * the attempt sweep, which asks the harness first.
 *
 * Each release is written to the event log (`intent.released`) by the store, in the same
 * transaction as the change, and returned here so the caller can print it like the attempt
 * sweep prints its own.
 *
 * **It is a separate step, and the order around it is what makes it safe.** A claim a live
 * `start` took a moment ago has no attempt row yet either and looks exactly like an orphan,
 * so this can only run while no start in this process can hold a claim. That is arranged by
 * ordering and not by anything here: `RunSupervisor.start` waits for the worker endpoints
 * before it claims, and `main.ts` runs this and only then publishes them. It is not folded
 * into the attempt sweep, which runs after publication and can spend a long time asking a
 * harness. A root that published first, or ran this later, would lose the guarantee; nothing
 * in this function can detect that.
 */
export const releaseOrphanedClaims = Effect.fn("releaseOrphanedClaims")(
  function* () {
    const store = yield* ObservationStore;
    const released = yield* store.releaseOrphanedClaims();
    if (released.length > 0) {
      yield* Effect.logInfo(
        `released ${String(released.length)} intent claim(s) no running attempt holds: ` +
          released.map((claim) => claim.intentId).join(", "),
      );
    }
    return released;
  },
);

/** One line per released claim, in the register of {@link renderReconciliation}. */
export const renderReleasedClaim = (claim: ReleasedClaim): string =>
  [
    claim.intentId,
    `goal=${claim.goalId}`,
    `claimedBy=${claim.claimedByAttemptId}`,
    `attempt=${claim.attemptStatus ?? "never recorded"}`,
    "intent=claimed->open",
  ].join("  ");

/** One line per reconciled attempt, for an operator reading a console or a log file. */
export const renderReconciliation = (entry: Reconciliation): string =>
  [
    `${entry.attempt.id}`,
    `session=${entry.attempt.harness_session_id ?? "none"}`,
    `harness=${entry.observed}`,
    `status=${entry.outcome.priorStatus ?? "?"}->${entry.outcome.status ?? "no such attempt"}`,
    `disposition=${entry.outcome.disposition ?? "none"}`,
    `fence=${String(entry.outcome.fenceBefore)}->${String(entry.outcome.fenceAfter)}`,
    `grantsRevoked=${String(entry.revokedGrants)}`,
    `observationsHeld=${String(entry.outcome.observationsAtRecovery)}`,
    `seen=${String(entry.outcome.times)}x`,
  ].join("  ");
