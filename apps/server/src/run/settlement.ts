/**
 * How a supervised unit of work ended, and what that settles to.
 *
 * Extracted from `run/supervisor.ts` when a second supervisor arrived. An attempt and a
 * planner round are different claims over different rows — a workspace for a worker, a
 * goal for a round — but the question "the loop stopped; what may I now record?" is the
 * same question, and it is the one this application is least willing to answer twice. Two
 * copies of {@link settlementFor} would be two places for `uncertain` to quietly become
 * `failed`.
 *
 * **Nothing here moved in meaning, only in file**, and nothing that moved has changed
 * since: the one addition to a moved declaration is {@link SupervisionEnd}'s fifth case,
 * `crashed`, which no attempt path produces. {@link SupervisionEnd},
 * {@link Settleable}, {@link settlementFor}, {@link renderEnd} and
 * {@link SETTLEMENT_ASK_TIMEOUT} are `run/supervisor.ts`'s, verbatim, with their reasoning
 * intact; `run/supervisor.test.ts` asserts the attempt table unchanged. What is new is
 * {@link roundSettlementFor}, which is the same ranking read into the round vocabulary.
 *
 * **A stream ending is not an outcome (DECISIONS.md §15).** That rule is the whole content
 * of this module: "the stream died", "the harness said so" and "we interrupted it" are
 * three different signals, they are kept apart in {@link SupervisionEnd}, and the only
 * status this file will invent from the absence of all three is `uncertain`.
 */
import type { TerminalOutcome } from "../harness/agentHarness";
import type {
  AttemptTerminalStatus,
  RoundTerminalStatus,
} from "../persistence/store";

/**
 * How the supervision loop stopped, before anything is concluded from it.
 *
 * Four cases, kept apart because collapsing any two of them is how a tool starts reporting
 * outcomes it did not observe:
 *
 * - `waited` — the harness's long poll returned. It says the session is no longer running
 *   and says nothing about how it went.
 * - `waitFailed` — our long poll lost its answer, or exceeded its transport bound. Says
 *   nothing at all: cancelling *our* request is not the harness stopping work
 *   (DECISIONS.md §15).
 * - `stopped` — we interrupted it. The only case where we are the source of the answer.
 * - `startFailed` — the run never got as far as being watched.
 * - `crashed` — the supervising fiber died of a **defect** rather than a typed failure.
 *
 * ## Why `crashed` exists and is not folded into `stopped`
 *
 * It is the fifth case and it was added after the other four, because a review found a
 * durable record that said somebody had interrupted a round when nobody had.
 *
 * A supervisor's body wraps the failures it expects in `Effect.result`, which absorbs
 * *typed* failures and not defects. So a defect — a thrown `TypeError`, a bug in a seam, an
 * `Effect.die` — propagates out of the body, the scope closes, and the finalizer settles
 * from whatever `ending` happens to hold. That default is `stopped`, because the only
 * *expected* way out of the watching part of a body without the wait returning is an
 * interruption. A defect inherits it, and `stopped` is the one answer a supervisor may not
 * guess at: `settlementFor`'s rank 3 exists because the operator asked us to stop, we asked
 * the harness to interrupt, and we revoked the authority — first-hand knowledge. A crash
 * has none of that.
 *
 * So a defect gets its own case, and it settles `uncertain`, which is what "we cannot say
 * what happened" has always meant here. It carries the rendered cause for the log only;
 * nothing branches on the text.
 *
 * **Produced by both supervisors now.** It reached `plan/planSupervisor.ts` first, and the
 * note here recorded that `run/supervisor.ts` had the same latent inversion on a narrow
 * path — a defect after its finalizer is registered settling `interrupted` the same way —
 * left alone because the slice that extracted this module was bound to change no attempt
 * behaviour. That constraint has expired and the attempt path now carries the same
 * `catchCause` guard, in the same shape and for the same reason: one guard around the body,
 * `Cause.hasInterruptsOnly` re-raising a stop untouched, and the cause re-raised either
 * way. Writing the inversion down is what made it a five-minute fix rather than a second
 * discovery.
 *
 * The only asymmetry left is the vocabulary: an attempt's `crashed` settles `uncertain`
 * through {@link settlementFor} and a round's through {@link roundSettlementFor}, which is
 * the same answer by two tables because the two statuses are different unions.
 */
export type SupervisionEnd =
  | { readonly _tag: "waited" }
  | { readonly _tag: "waitFailed"; readonly detail: string }
  | { readonly _tag: "stopped" }
  | { readonly _tag: "startFailed" }
  | { readonly _tag: "crashed"; readonly detail: string };

/**
 * Everything the supervisor has to settle from, gathered before it decides.
 *
 * Three sources, and keeping them as three fields rather than folding them as they arrive
 * is the point: each one can be absent, and which one answered is what the log line says.
 */
export interface Settleable {
  /** How the loop stopped. */
  readonly end: SupervisionEnd;
  /**
   * A terminal `session.execution.*` the narration stream carried, if any.
   *
   * The harness stating an outcome in its own event stream. Absent when the stream was
   * never established, died early, or simply had not reached the terminal event.
   */
  readonly narrated: TerminalOutcome | undefined;
  /**
   * What `session.get` says about the session now, if it could be asked.
   *
   * Absent when the call failed, and also when it succeeded with no `outcome` on the
   * session — which `opencode` 2.1.2 does for a session that has not finished.
   */
  readonly harness: TerminalOutcome | undefined;
}

/**
 * The status one ending plus what the harness said settles to.
 *
 * A pure function, exported so the rule can be tested without a harness, a database or a
 * fiber. Three sources ranked, then one fallback:
 *
 * 1. **`session.get`'s own `outcome`**, when it has one. The harness's current view of the
 *    session, and the most recent of the three reads.
 * 2. **A terminal event from the narration stream.** Also the harness saying so, a moment
 *    earlier. Used when `session.get` has no outcome to give, which is the common case
 *    rather than the exception.
 * 3. **`interrupted`, for a stop, and only for a stop.** This is the one status we know
 *    first-hand: the operator asked us to stop, we asked the harness to interrupt the
 *    session, and we revoked the attempt's authority. It is not an inference from silence
 *    — unlike `failed`, which would be a claim about the work.
 * 4. **Otherwise `uncertain`.** Never `failed`: "we could not find out" and "it did not
 *    work" are different facts and only one of them would be in evidence. This covers the
 *    wait returning without the harness ever saying how it went, the wait losing its
 *    answer, a start that broke before anything was watched, and a supervisor that died of
 *    a defect — the last of which reaches this line by *not* being `stopped`, which is the
 *    whole reason `crashed` is a case of its own.
 */
export const settlementFor = (input: Settleable): AttemptTerminalStatus =>
  input.harness ??
  input.narrated ??
  (input.end._tag === "stopped" ? "interrupted" : "uncertain");

/**
 * The same table, read into a planner round's vocabulary.
 *
 * It is a second function rather than a cast because the two vocabularies differ by more
 * than a type: `RoundStatus` has no `succeeded` and no `failed`, deliberately, since a
 * round does not pass or fail — what it concluded is its `disposition` column, which only
 * the planner writes and which settlement never touches (`persistence/store.ts`'s
 * `settleRound`). So the ranking is {@link settlementFor}'s, and the last step maps the
 * harness's three answers onto the three a round can hold:
 *
 * - `succeeded` and `failed` both become **`settled`**. Both are the harness stating that
 *   the session's execution ended, which is the only thing a round's status claims. A
 *   failed execution that recorded no disposition is a `settled` round with a null
 *   disposition, and that pair is the honest record: the work stopped, and the planner
 *   never said what it concluded. Reading `failed` as `uncertain` would be the worse
 *   error in the other direction — claiming we could not find out when we were told.
 * - `interrupted` stays `interrupted`, from the harness or from a stop, for
 *   {@link settlementFor}'s reason: it is the one status we have first-hand. A `crashed`
 *   ending is **not** a stop and does not reach it.
 * - Everything else is `uncertain`, never anything stronger.
 */
export const roundSettlementFor = (input: Settleable): RoundTerminalStatus => {
  const stated = input.harness ?? input.narrated;
  if (stated === "succeeded" || stated === "failed") return "settled";
  if (stated === "interrupted") return "interrupted";
  return input.end._tag === "stopped" ? "interrupted" : "uncertain";
};

/**
 * One line an operator or a test can read about how a run ended.
 *
 * A `switch` rather than the chain of ternaries this was, because the chain's last branch
 * was an `else` that read `end.detail` — so adding `crashed` to {@link SupervisionEnd}
 * would have silently printed a wait that lost its answer. An exhaustive `switch` over the
 * tag is a compile error when the next case arrives instead.
 */
export const renderEnd = (end: SupervisionEnd): string => {
  switch (end._tag) {
    case "waited":
      return "the harness reported the session is no longer running";
    case "stopped":
      return "stopped on request";
    case "startFailed":
      return "the run broke before it was being watched";
    case "waitFailed":
      return `our wait lost its answer, which says nothing about the session: ${end.detail}`;
    case "crashed":
      return `the supervisor itself died, which says nothing about the session: ${end.detail}`;
  }
};

/**
 * How long settlement will wait for the harness to answer, per call.
 *
 * **This is a bound on *asking*, not a deadline on the worker.** DECISIONS.md §5 rules
 * out deadline-triggered settlement, and this is not that: it never decides an outcome, it
 * only decides how long we wait before recording that we could not find one. Exceeding it
 * means {@link settlementFor} falls through to the narrated outcome, or to `uncertain` —
 * the same answer an unreachable harness already produces, reached sooner.
 *
 * It exists because settlement runs inside a *shutdown* path. A `SIGINT` closes the
 * supervisor's fiber map, every supervisor is interrupted, and each one's finalizer then
 * asks the harness about its session — at exactly the moment the harness child is also
 * being torn down. The client's own per-operation bound is 30 seconds, so without this a
 * server with three runs in flight could take minutes to exit, asking a dying process
 * questions. Ten seconds is generous for an HTTP call to a process on loopback and short
 * enough that shutting down stays a matter of seconds.
 *
 * The *write* is deliberately not bounded by this. It is local SQLite and the thing that
 * must not be skipped: a row left `running` because we gave up on a disk write is a row
 * for the next sweep to guess at. That holds for a round exactly as it does for an
 * attempt, which is why both supervisors take their bound from here.
 */
export const SETTLEMENT_ASK_TIMEOUT = "10 seconds";
