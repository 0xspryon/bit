/**
 * The restart continuation, in two passes over one target: decide and queue, then dispatch
 * (S7.2–S7.4).
 *
 * `recovery/continuation.ts` holds the decisions; this holds the order they are made in and
 * the durable queue they ride. Both passes are per target, like the sweep they follow, and
 * the fleet loop is the composition root's — `main.ts` — for `reconcile.ts`'s reason: there
 * is no one `ObservationStore` in this process, so "for every unarchived target, open its
 * file" is a thing only the registry holder can write.
 *
 * ## Why two passes and not one
 *
 * **S7.1's ordering is the property this slice exists to keep**: nothing half-finished may
 * be presented as still running, so every non-terminal run is terminalized *before*
 * anything is continued. Splitting the work at the outbox is what makes that ordering
 * structural rather than a matter of statement order inside one function:
 *
 * - the sweep (`reconcileUnsettledAttempts`, `reconcileRunningRounds`) terminalizes and
 *   commits;
 * - {@link enqueueContinuations} writes an `agent.continuation.requested` event and an
 *   `agent.continue` outbox row — an obligation, not a turn;
 * - {@link dispatchContinuations} sends the turns.
 *
 * Three things fall out of that. A crash between any two of them loses nothing: an attempt
 * left `uncertain` is still swept on the next boot (`uncertain` is a question recovery
 * re-asks), and a queued continuation is still queued. The decision is **auditable** — the
 * event says what the harness answered and why a turn is owed, the row says whether it was
 * sent and, if not, why not. And the dispatcher can refuse: the cap and the operator's
 * switch are enforced where the money is spent, not where the decision was made.
 *
 * ## What the outbox contributes, concretely
 *
 * It is tempting to read "the dispatcher rides the outbox" as bookkeeping. It is not. A
 * continuation is a prompt into a model: it costs money, it is visible to an operator, and
 * the process that owes it has just proved it can die mid-turn. The `0013` columns are the
 * ones that make that safe to run unattended — `attempts` counts dispatches rather than
 * successes, the lease pair means a dispatcher that dies does not leave a row that looks
 * sendable, and `status` plus `last_error` are the only durable answer to "why did my
 * session not carry on". `recovery_policy` is `reconcile_first` for this type, and
 * {@link dispatchContinuations} is where that policy is actually implemented: a row whose
 * outcome was lost is **failed, never re-sent**, because whether the turn arrived is
 * genuinely unknown and the next boot's sweep will re-ask the harness instead of guessing.
 */
import { Effect } from "effect";

import {
  CONTINUATION_CHAIN_MAX,
  CONTINUATION_CHAIN_WINDOW,
  attemptContinuationNote,
  chainKeyFor,
  continuationMessage,
  continuationTrigger,
  decodeContinuationRequest,
  describeSubject,
  type ContinuationPolicy,
  type ContinuationRequest,
  type ContinuationSubject,
} from "./continuation";
import { HarnessSessionStatus } from "./harnessStatus";
import { ObservationStore } from "../persistence/store";
import type { Reconciliation } from "./reconcile";

/** How long a dispatcher's lease on one continuation row runs. */
export const CONTINUATION_LEASE = 120_000;

/**
 * How many of a target's conversations, per kind, the queueing pass asks the harness about.
 *
 * A bound is needed because the two conversation indexes **grow and are never pruned**: a
 * target accumulates one `import_sessions` row per authority period and one
 * `goal_sessions` row per goal, and asking the harness about each one is an HTTP round trip
 * on a boot that is holding the listener's first requests. `workerSessionsForTarget`'s
 * `WORKER_SESSIONS_LISTED` is the same argument one screen over.
 *
 * **Newest first, which makes the bound a recency rule rather than an arbitrary cut.** Both
 * reads answer newest first, so what falls outside it is the conversations nobody has
 * touched for longest — and a conversation whose turn was cut off weeks and twenty-five
 * conversations ago is not something to prompt a model about now without being asked. A
 * session that is not asked about is not continued, which is the safe direction, and the
 * count of them is reported rather than dropped silently.
 */
export const CONTINUATION_SESSIONS_ASKED = 25;

/* ── Pass one: decide, and queue ─────────────────────────────────────────────── */

/** One continuation this pass decided about, queued or not. */
export interface ContinuationDecided {
  readonly subject: ContinuationSubject;
  readonly harnessSessionId: string;
  /** The outbox row this is queued as, or `undefined` when nothing is owed. */
  readonly outboxId: string | undefined;
  readonly detail: string;
}

/**
 * Decides what this target owes a continuation and queues each one (S7.2).
 *
 * Takes the attempt sweep's own results rather than re-reading the rows, which is the
 * ordering made unforgeable: there is no way to call this with a reconciliation that has
 * not happened, and the only thing it can act on is what the sweep concluded. Conversations
 * have no sweep of their own — a goal conversation is live or dormant and an importer
 * session's row records an *authority period*, so neither has a status a restart could
 * leave wrong — so their sessions are asked about here, after the attempt pass, through the
 * same {@link HarnessSessionStatus} the sweep used.
 *
 * ## What is skipped, and why each one is a decision rather than an omission
 *
 * - **Any answer but `abandoned`.** {@link continuationTrigger} owns that, including the
 *   recorded cost that Claude Code does not produce `abandoned` today.
 * - **An attempt that is still `running` after the sweep.** The harness says a turn is in
 *   flight; the row is correct and nothing was lost.
 * - **An attempt something already replaces** (`replacedAttemptIds`). A continued attempt
 *   keeps its `uncertain` row for ever, so without this every boot would open another
 *   replacement for a slice that is already being worked.
 * - **An import whose authority the operator ended.** `ended_reason: 'operator'` is the one
 *   ending that is final (`0027`), its tools refuse every write, and `ScopeImporter.send`
 *   refuses it — so queueing one would be queueing a refusal.
 * - **A goal that is not `active`.** Its agent's writes would all be refused
 *   (`checkGoalAuthority`), so the turn could only disappoint.
 *
 * Every skip is returned with its sentence rather than dropped, because "why did my session
 * not carry on" is the question this whole slice has to be able to answer.
 */
export const enqueueContinuations = Effect.fn("enqueueContinuations")(
  function* (input: {
    readonly targetId: string;
    /** The attempt sweep's results for this target, already committed. */
    readonly attempts: readonly Reconciliation[];
  }) {
    const store = yield* ObservationStore;
    const status = yield* HarnessSessionStatus;
    const decidedAt = yield* Effect.clockWith(
      (clock) => clock.currentTimeMillis,
    );
    const decided: ContinuationDecided[] = [];

    const queue = Effect.fnUntraced(function* (decision: {
      readonly subject: ContinuationSubject;
      readonly subjectId: string;
      readonly harnessSessionId: string;
      readonly harnessInstanceId: string | null;
      readonly observed: string;
      readonly detail: string;
    }) {
      const queued = yield* store.enqueueContinuation({
        targetId: input.targetId,
        subjectId: decision.subjectId,
        payload: {
          subject: decision.subject,
          targetId: input.targetId,
          harnessSessionId: decision.harnessSessionId,
          harnessInstanceId: decision.harnessInstanceId,
          observed: decision.observed,
          detail: decision.detail,
          chainKey: chainKeyFor(decision.subject, input.targetId),
          // When this pass decided, which is a hair before the row's own `enqueued_at` —
          // that one is when the transaction committed, and the cap counts it rather than
          // this. Carried anyway, because a reader of the event wants to know when the
          // decision was made and the event's `recorded_at` is the store's clock, not this
          // pass's.
          requestedAt: decidedAt,
        } satisfies Record<keyof ContinuationRequest, unknown>,
      });
      decided.push({
        subject: decision.subject,
        harnessSessionId: decision.harnessSessionId,
        outboxId: queued.outboxId,
        detail: decision.detail,
      });
    });

    /* Worker attempts, from the sweep's own answers. */
    const replaced = yield* store.replacedAttemptIds();
    for (const entry of input.attempts) {
      const attemptId = entry.attempt.id;
      const subject: ContinuationSubject = {
        kind: "attempt",
        attemptId,
        intentId: entry.attempt.intent_id,
      };
      const trigger = continuationTrigger(entry.observed, entry.harnessDetail);
      if (trigger._tag === "none") {
        decided.push({
          subject,
          harnessSessionId: entry.attempt.harness_session_id ?? "",
          outboxId: undefined,
          detail: trigger.detail,
        });
        continue;
      }
      if (entry.outcome.status === "running") {
        decided.push({
          subject,
          harnessSessionId: entry.attempt.harness_session_id ?? "",
          outboxId: undefined,
          detail: `the sweep left attempt ${attemptId} running, so nothing is continued under it`,
        });
        continue;
      }
      if (replaced.has(attemptId)) {
        decided.push({
          subject,
          harnessSessionId: entry.attempt.harness_session_id ?? "",
          outboxId: undefined,
          detail: `attempt ${attemptId} is already replaced by a later attempt, which is the continuation; a second one would put two workers on one slice`,
        });
        continue;
      }
      yield* queue({
        subject,
        subjectId: attemptId,
        harnessSessionId: entry.attempt.harness_session_id ?? "",
        harnessInstanceId: entry.attempt.harness_instance_id,
        observed: entry.observed,
        detail: trigger.detail,
      });
    }

    /*
     * The importer's conversations: one per harness session, newest period addressed, and
     * only the newest {@link CONTINUATION_SESSIONS_ASKED} of them.
     */
    const imports = yield* store.importSessions(input.targetId);
    for (const session of imports.slice(0, CONTINUATION_SESSIONS_ASKED)) {
      const subject: ContinuationSubject = {
        kind: "importer",
        importId: session.latestImportId,
      };
      if (session.endedReason === "operator") {
        decided.push({
          subject,
          harnessSessionId: session.harnessSessionId,
          outboxId: undefined,
          detail: `import ${session.latestImportId} was ended by the operator, so its authority is over and nothing is continued under it`,
        });
        continue;
      }
      const report = yield* status.of(
        session.harnessSessionId,
        session.harnessInstanceId,
      );
      const trigger = continuationTrigger(report.observed, report.detail);
      if (trigger._tag === "none") {
        decided.push({
          subject,
          harnessSessionId: session.harnessSessionId,
          outboxId: undefined,
          detail: trigger.detail,
        });
        continue;
      }
      yield* queue({
        subject,
        subjectId: session.latestImportId,
        harnessSessionId: session.harnessSessionId,
        harnessInstanceId: session.harnessInstanceId,
        observed: report.observed,
        detail: trigger.detail,
      });
    }

    /* The goal conversations: one per goal, the latest session each, same bound. */
    const goals = yield* store.goalSessionsForTarget(input.targetId);
    for (const session of goals.slice(0, CONTINUATION_SESSIONS_ASKED)) {
      const subject: ContinuationSubject = {
        kind: "goal",
        goalId: session.goalId,
      };
      if (session.goalStatus !== "active") {
        decided.push({
          subject,
          harnessSessionId: session.harnessSessionId,
          outboxId: undefined,
          detail: `goal ${session.goalId} is ${session.goalStatus}, so its agent's authority has ended and a turn into it would be refused`,
        });
        continue;
      }
      const report = yield* status.of(
        session.harnessSessionId,
        session.harnessInstanceId,
      );
      const trigger = continuationTrigger(report.observed, report.detail);
      if (trigger._tag === "none") {
        decided.push({
          subject,
          harnessSessionId: session.harnessSessionId,
          outboxId: undefined,
          detail: trigger.detail,
        });
        continue;
      }
      yield* queue({
        subject,
        subjectId: session.goalId,
        harnessSessionId: session.harnessSessionId,
        harnessInstanceId: session.harnessInstanceId,
        observed: report.observed,
        detail: trigger.detail,
      });
    }

    const notAsked =
      Math.max(0, imports.length - CONTINUATION_SESSIONS_ASKED) +
      Math.max(0, goals.length - CONTINUATION_SESSIONS_ASKED);
    if (notAsked > 0) {
      yield* Effect.logInfo(
        "older conversations were not asked about, so nothing of them was continued",
        {
          targetId: input.targetId,
          notAsked,
          askedPerKind: CONTINUATION_SESSIONS_ASKED,
        },
      );
    }
    return { decided: decided as readonly ContinuationDecided[], notAsked };
  },
);

/* ── Pass two: dispatch ──────────────────────────────────────────────────────── */

/** What a surface said when it was handed one continuation. Never a failure. */
export type ContinuationOutcome =
  | { readonly _tag: "dispatched"; readonly detail: string }
  | { readonly _tag: "refused"; readonly detail: string };

/**
 * How this process actually delivers a continuation, as a function rather than a service.
 *
 * The three surfaces live in `import/`, `plan/` and `run/`, and a dispatcher that imported
 * them would make `recovery/` depend on every one of them — and on the layer graph that
 * builds them. So the composition root passes the routing in, exactly as the importer's
 * history reader takes a resolver as a parameter instead of a context requirement.
 *
 * `instruction` is already assembled, by `recovery/continuation.ts` and nowhere else: a
 * worker's continuation block, or a conversation's synthetic message. A handler that
 * composed its own prompt would be a second author of what an agent is told after a
 * restart.
 */
export interface ContinuationRouting {
  /**
   * Hands one continuation to its surface. Must not fail: a refusal is an answer and is
   * recorded on the row.
   */
  readonly deliver: (input: {
    readonly request: ContinuationRequest;
    readonly instruction: string;
  }) => Effect.Effect<ContinuationOutcome>;
  /**
   * A summary of one dead session's transcript, or `undefined`.
   *
   * `recovery/continuation.ts`'s `readTranscriptSummary` with a resolver bound to it.
   * Passed in for the same reason as {@link deliver}, and it is only ever asked for a
   * worker attempt — the two conversations get their real history back by resuming.
   */
  readonly summarise: (input: {
    readonly harnessSessionId: string;
    readonly harnessInstanceId: string | null;
  }) => Effect.Effect<string | undefined>;
  /** This process, for the lease. Anything that identifies one dispatcher. */
  readonly leaseOwner: string;
}

/** One dispatched row, for the operator-facing log line. */
export interface ContinuationDispatched {
  readonly outboxId: string;
  readonly subject: ContinuationSubject | undefined;
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly detail: string;
}

/**
 * Sends every continuation this target has queued, and records what became of each (S7.4).
 *
 * The order of the checks is the order of what they protect, and each one is a different
 * kind of "no":
 *
 * 1. **A lease nobody holds any more is failed, not re-sent.** An `in_flight` row means a
 *    dispatcher claimed it and never came back, so whether the turn was delivered is
 *    genuinely unknown — which is what `reconcile_first` is for and what re-sending would
 *    pretend to know. The next boot's sweep re-asks the harness and queues a fresh row if
 *    the work is still owed, which is the only honest way to recover it.
 * 2. **A payload this build cannot decode is failed.** "Never resume on a guess" (S7.4)
 *    applies to the queue as much as to the settings: a row written by a different build,
 *    or hand-edited, is not a continuation whose subject we may infer.
 * 3. **The operator's switch** ({@link ContinuationPolicy}), re-read per boot and checked
 *    here as well as before the queueing pass, so a row queued while it was on is not sent
 *    after it was turned off.
 * 4. **The chain cap** ({@link CONTINUATION_CHAIN_MAX}). Counted from the queue itself,
 *    which is the only place that survives the crash loop it exists to stop: the rows are
 *    durable, their `enqueued_at` is the clock, and a row this server cancelled does not
 *    count — a refusal must not silence the chain for ever.
 * 5. **The surface's own refusal**, recorded with its sentence. An intent something else
 *    has claimed, a goal that ended between the two passes, a harness that would not take
 *    the prompt: all of them are answers, and none of them is retried here.
 *
 * Only a worker attempt's transcript is read, and a failure to read it does not stop the
 * turn — S7.4's "a continuation with no summary is better than no continuation", and the
 * reason {@link ContinuationRouting.summarise} cannot fail.
 */
export const dispatchContinuations = Effect.fn("dispatchContinuations")(
  function* (input: {
    readonly targetId: string;
    readonly policy: ContinuationPolicy;
    readonly routing: ContinuationRouting;
  }) {
    const store = yield* ObservationStore;
    const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
    const done: ContinuationDispatched[] = [];

    /* 1. Leases nobody holds. */
    for (const stale of yield* store.continuationRequests({
      status: "in_flight",
    })) {
      if (stale.leaseExpiresAt !== null && stale.leaseExpiresAt > now) continue;
      const detail =
        "the dispatcher that claimed this continuation did not record what became of it, so whether the turn was delivered is unknown; it is not sent again, and the next startup sweep asks the harness instead";
      yield* store.settleContinuation({
        outboxId: stale.outboxId,
        status: "failed",
        detail,
      });
      done.push({
        outboxId: stale.outboxId,
        subject: undefined,
        status: "failed",
        detail,
      });
    }

    const settle = Effect.fnUntraced(function* (entry: {
      readonly outboxId: string;
      readonly subject: ContinuationSubject | undefined;
      readonly status: "succeeded" | "failed" | "cancelled";
      readonly detail: string;
    }) {
      yield* store.settleContinuation({
        outboxId: entry.outboxId,
        status: entry.status,
        ...(entry.status === "succeeded" ? {} : { detail: entry.detail }),
      });
      done.push(entry);
    });

    /* 2–5. The queue. */
    for (const row of yield* store.continuationRequests({
      status: "pending",
    })) {
      const claimed = yield* store.claimContinuation({
        outboxId: row.outboxId,
        leaseOwner: input.routing.leaseOwner,
        leaseFor: CONTINUATION_LEASE,
      });
      // Something else took it between the read and the claim. Not an error and not ours
      // to report: whoever holds the lease will record what became of it.
      if (!claimed) continue;

      const decoded = decodeContinuationRequest(row.payload);
      if (decoded._tag === "Failure") {
        yield* settle({
          outboxId: row.outboxId,
          subject: undefined,
          status: "failed",
          detail: `this continuation's payload could not be read, so nothing was dispatched for it: ${String(decoded.failure)}`,
        });
        continue;
      }
      const request = decoded.success;

      if (input.policy._tag === "off") {
        yield* settle({
          outboxId: row.outboxId,
          subject: request.subject,
          status: "cancelled",
          detail: input.policy.detail,
        });
        continue;
      }

      const chain = (yield* store.continuationRequests({
        since: now - CONTINUATION_CHAIN_WINDOW,
      })).filter(
        (other) =>
          other.outboxId !== row.outboxId &&
          decodeChainKey(other.payload) === request.chainKey,
      );
      if (chain.length >= CONTINUATION_CHAIN_MAX) {
        yield* settle({
          outboxId: row.outboxId,
          subject: request.subject,
          status: "cancelled",
          // The *chain* and not the subject, and the key is named: for a worker and a goal
          // they are nearly the same thing, but every importer conversation on one target
          // shares one chain (`chainKeyFor`), so saying "this conversation has already been
          // continued three times" would be wrong about which thing hit the cap.
          detail: `the continuation chain '${request.chainKey}' has already been continued ${String(chain.length)} time(s) in the last ${String(Math.round(CONTINUATION_CHAIN_WINDOW / 60_000))} minutes, which is the cap (${String(CONTINUATION_CHAIN_MAX)}); nothing further is dispatched for ${describeSubject(request.subject)}, because a process that keeps dying mid-turn would otherwise keep prompting a model unattended`,
        });
        continue;
      }

      /*
       * The summary, for a worker attempt and only for one. The two conversations get
       * their real history back by resuming, so reading a transcript for them would be
       * paying for something the agent is about to be handed anyway.
       */
      const instruction =
        request.subject.kind === "attempt"
          ? attemptContinuationNote({
              replacesAttemptId: request.subject.attemptId,
              summary: yield* input.routing.summarise({
                harnessSessionId: request.harnessSessionId,
                harnessInstanceId: request.harnessInstanceId,
              }),
            })
          : continuationMessage(request.subject);

      const outcome = yield* input.routing.deliver({ request, instruction });
      yield* settle({
        outboxId: row.outboxId,
        subject: request.subject,
        status: outcome._tag === "dispatched" ? "succeeded" : "failed",
        detail: outcome.detail,
      });
    }

    return done as readonly ContinuationDispatched[];
  },
);

/**
 * The chain key out of a queued row, for the cap's count.
 *
 * A deliberately narrow read: the row may have been written by another build, and the one
 * field the cap needs is a string. A payload it cannot find one in counts as a different
 * chain rather than failing the pass — the alternative is one unreadable row stopping every
 * continuation on the target, which is a worse failure than one uncounted row.
 */
const decodeChainKey = (payload: unknown): string | undefined =>
  typeof payload === "object" &&
  payload !== null &&
  "chainKey" in payload &&
  typeof (payload as { readonly chainKey: unknown }).chainKey === "string"
    ? (payload as { readonly chainKey: string }).chainKey
    : undefined;

/** One line per decided continuation, in `renderReconciliation`'s register. */
export const renderContinuationDecided = (entry: ContinuationDecided): string =>
  [
    describeSubject(entry.subject),
    `session=${entry.harnessSessionId === "" ? "none" : entry.harnessSessionId}`,
    entry.outboxId === undefined
      ? "continuation=not owed"
      : `continuation=queued as ${entry.outboxId}`,
    entry.detail,
  ].join("  ");

/** One line per dispatched continuation. */
export const renderContinuationDispatched = (
  entry: ContinuationDispatched,
): string =>
  [
    entry.outboxId,
    entry.subject === undefined
      ? "subject=unreadable"
      : describeSubject(entry.subject),
    `outcome=${entry.status}`,
    entry.detail,
  ].join("  ");
