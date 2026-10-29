/**
 * Startup reconciliation of work no definite answer has been reached about.
 *
 * Two kinds of row, one register. An **attempt** left `running` or `uncertain` is swept by
 * {@link reconcileUnsettledAttempts}; a **planner round** left `running` is swept by
 * {@link reconcileRunningRounds}. Everything this file says about what reconciliation may
 * conclude applies to both, and the two differences are stated where they are: a round's
 * vocabulary has no `failed` to be wrong with, and a round has no recovery table, so the
 * durable trace of a swept round is its `plan.round.settled` event rather than a
 * `round_recoveries` row. The round sweep's own reason for existing is narrower and worth
 * naming here: `openRound` refuses a second running round on a goal, so a round left
 * behind by a dead process means that goal takes no further rounds until something settles
 * it.
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
  type RoundSettlement,
  type RoundTerminalStatus,
  type StoredRound,
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

/* ── Planner rounds ──────────────────────────────────────────────────────────── */

/**
 * The status one harness answer proposes for a planner round.
 *
 * {@link mapObserved}'s counterpart, read into the round vocabulary, and the reason it is
 * a second function rather than a cast is `run/settlement.ts`'s `roundSettlementFor`: a
 * round has no `succeeded` and no `failed`, because it does not pass or fail — what it
 * concluded is its `disposition` column, which recovery never writes.
 *
 * `undefined` for `running`, which is the one answer that is **not** a proposal: the
 * harness says the session is still going, so there is nothing to record and the row is
 * left exactly as it is. The other six all end the round, and three of them end it
 * `uncertain` — which is the point of the mapping: there is no path from "we do not know"
 * to a definite status.
 */
export const mapObservedRound = (
  observed: HarnessObservedStatus,
): RoundTerminalStatus | undefined => {
  switch (observed) {
    case "running":
      return undefined;
    // Both are the harness stating that execution ended, which is all a round's status
    // claims. A round whose session failed and recorded no disposition is `settled` with a
    // null disposition, and that pair is the honest record.
    case "succeeded":
    case "failed":
      return "settled";
    case "interrupted":
      return "interrupted";
    case "unbound":
    case "missing":
    case "unreachable":
      return "uncertain";
  }
};

export interface RoundReconciliation {
  readonly round: StoredRound;
  readonly observed: HarnessObservedStatus;
  readonly harnessDetail: string;
  /** Absent when the harness says the session is still running; nothing was written. */
  readonly settlement: RoundSettlement | undefined;
  /** The round's write fence after this pass, or `undefined` if nothing moved it. */
  readonly fenceAfter: number | undefined;
  /** Live in-memory grants dropped for this round, if a registry was available. */
  readonly revokedGrants: number;
}

/**
 * Reconciles one round: ask, then record.
 *
 * {@link reconcileAttempt}'s shape, with three differences that each follow from a round
 * having no recovery table of its own:
 *
 * - **There is no `recordRecovery`.** An attempt's reconciliation is one transaction that
 *   decides, writes the row, bumps the fence and files an `attempt_recoveries` record. A
 *   round has `settleRound` and `supersedeRound` and no third table, so this does the two
 *   writes in order — status first, authority second, for the reason
 *   `plan/planSupervisor.ts`'s `settle` gives: revoking first would leave the credential
 *   gone while the row still said the round may write.
 * - **The durable record of the pass is the event.** `settleRound` appends
 *   `plan.round.settled` with `settledBy: "recovery"` **and the harness's own answer**,
 *   which together are what distinguishes a swept round from one a supervisor watched and
 *   say how much was known. There is no `times` count and no stored disposition, because
 *   nothing re-sweeps a settled round: `settleRound` is guarded to `running` and
 *   `roundsLeftRunning` reads only `running`, so a round's sweep count is always one.
 * - **Settling the round is what releases the goal.** `openRound` refuses a second running
 *   round on a goal, so a round left `running` by a dead process blocks every later round
 *   on that goal until this moves it — the same class of bug slice 2 hit when an intent
 *   claim outlived the process that took it. There is no separate claim to give back: the
 *   in-process claim died with the process, and the row is the durable half.
 *
 * The harness is asked outside any transaction, deliberately: that is the HTTP call.
 */
export const reconcileRound = Effect.fn("reconcileRound")(function* (
  round: StoredRound,
) {
  const harness = yield* HarnessSessionStatus;
  const store = yield* ObservationStore;
  const credentials = yield* Effect.serviceOption(McpCredentials);

  const report = yield* harness.of(
    round.harnessSessionId,
    round.harnessInstanceId,
  );
  const proposed = mapObservedRound(report.observed);
  if (proposed === undefined) {
    // The harness says the session is live. Left alone, authority intact — this is the
    // whole reason the sweep does not simply mark what it finds as interrupted. The round
    // has no fiber in this process driving it, so nothing will settle it until it stops
    // running and a later sweep asks again.
    return {
      round,
      observed: report.observed,
      harnessDetail: report.detail,
      settlement: undefined,
      fenceAfter: undefined,
      revokedGrants: 0,
    } satisfies RoundReconciliation;
  }

  const settlement = yield* store.settleRound(round.roundId, proposed, {
    _tag: "recovery",
    // The harness's answer, carried into the `plan.round.settled` payload rather than
    // only into the log line below. Three of the seven answers map onto `uncertain`, so
    // without this the durable record could not tell "the session is gone" (`missing`)
    // from "we could not ask" (`unreachable`) — a distinction the attempt path keeps on
    // its own recovery row and a round has no table for. `RoundSettler` is tagged so a
    // sweep cannot forget to say.
    observed: report.observed,
  });
  // Only once the status has moved. `changed: false` means another writer settled it
  // between the read and this call, and superseding then would bump a fence for a round
  // somebody else has already finished accounting for.
  const fenceAfter = settlement.changed
    ? yield* store.supersedeRound(round.roundId)
    : undefined;
  const revokedGrants =
    settlement.changed && Option.isSome(credentials)
      ? yield* credentials.value.revokeRound(round.roundId)
      : 0;

  return {
    round,
    observed: report.observed,
    harnessDetail: report.detail,
    settlement,
    fenceAfter,
    revokedGrants,
  } satisfies RoundReconciliation;
});

/**
 * Reconciles every planner round a process left `running`.
 *
 * Run at startup beside {@link reconcileUnsettledAttempts}, and safe to run repeatedly: a
 * round this pass settles is no longer `running`, so the next pass does not see it.
 *
 * What each row can become:
 *
 * - the harness still reports it live → left alone, authority intact.
 * - a definite answer → `settled` or `interrupted`, authority revoked, the goal free.
 * - no answer → `uncertain`, authority revoked anyway, the goal free. Never `failed`:
 *   a round has no such status to reach for, which is the vocabulary doing the work the
 *   attempt sweep does with a rule.
 */
export const reconcileRunningRounds = Effect.fn("reconcileRunningRounds")(
  function* () {
    const store = yield* ObservationStore;
    const running = yield* store.roundsLeftRunning();
    if (running.length === 0) return [];
    yield* Effect.logInfo(
      `reconciling ${String(running.length)} planner round(s) left running: ` +
        running.map((round) => `${round.roundId}:${round.goalId}`).join(", "),
    );
    return yield* Effect.forEach(running, reconcileRound);
  },
);

/** One line per reconciled round, in the register of {@link renderReconciliation}. */
export const renderRoundReconciliation = (entry: RoundReconciliation): string =>
  [
    entry.round.roundId,
    `goal=${entry.round.goalId}`,
    `session=${entry.round.harnessSessionId ?? "none"}`,
    `harness=${entry.observed}`,
    `status=running->${entry.settlement?.effective ?? "left running"}`,
    `disposition=${entry.round.disposition ?? "none"}`,
    `fence=${String(entry.round.writeFence)}->${entry.fenceAfter === undefined ? String(entry.round.writeFence) : String(entry.fenceAfter)}`,
    `grantsRevoked=${String(entry.revokedGrants)}`,
    `goal=${entry.settlement?.changed === true ? "released" : "still held"}`,
  ].join("  ");

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
