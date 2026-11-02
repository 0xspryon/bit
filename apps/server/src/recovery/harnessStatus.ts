/**
 * The harness-status abstraction recovery reconciles against.
 *
 * Reconciliation needs one question answered — *what became of this session?* — and it
 * needs the answer to include the cases where there is no answer. That is why this is a
 * service with its own small vocabulary rather than a direct call into
 * {@link OpenCodeClient}: the useful distinctions are between "still going", "finished
 * like this" and "we cannot tell", and the client's error channel mixes the last of
 * those with everything else.
 *
 * **The query cannot fail.** Every failure path maps onto {@link HarnessObservedStatus}
 * instead, because a reconciler that fails when the harness is unreachable has not
 * reconciled anything — unreachability is one of the outcomes it exists to record. The
 * effect's error channel is `never` for that reason, and that is a deliberate design
 * choice rather than swallowed errors: the detail string carries what went wrong, and it
 * is persisted.
 *
 * **Nothing here reads our own store.** It must not: "we hold no observation for this
 * attempt" is not evidence that the session did nothing, and keeping the two sources
 * apart is what stops that inference being made by accident (DECISIONS.md §15).
 */
import { Context, Effect, Layer } from "effect";

import { SESSION_NOT_FOUND_TAG } from "../harness/agentHarness";
import { HarnessResolver } from "../harness/resolver";

/**
 * What the harness said about one session.
 *
 * The first four are the harness's own answers. The last three are ours, and each is a
 * different reason for not having one:
 *
 * - `unbound` — the attempt never had a session id recorded, so there is nothing to ask
 *   about. It does **not** mean no work happened: a process that died between creating
 *   a session and recording its id would leave exactly this state.
 * - `missing` — we asked, and the harness does not know this session. Its own storage
 *   may have been cleared, or this is a different machine. Says nothing about what the
 *   session did while it existed.
 * - `unreachable` — we could not get an answer at all: no harness, a transport failure,
 *   a reply we cannot decode, an attempt that ran on a harness instance this process
 *   does not configure, or one whose instance *is* configured and did not come up. The
 *   last two are why this takes an instance id at all; see {@link HarnessSessionStatus.of}.
 * - `abandoned` — we asked, the harness knows the session, and it is running no turn on
 *   it and has recorded no outcome for it. **This is the answer a restart produces**, and
 *   it is the one the vocabulary was missing: the process that started the last turn is
 *   gone, so nobody will ever write an outcome, and nothing here is entitled to say which
 *   one it would have been. Distinct from `missing` because the conversation is still
 *   there — it can be read, and on both drivers it can be carried on — and distinct from
 *   `running` because it is not.
 *
 * All four of ours mean *uncertain*. They are kept apart because the operator reading
 * the recovery record needs to know which one it was.
 */
export type HarnessObservedStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "unbound"
  | "missing"
  | "unreachable"
  | "abandoned";

export interface HarnessSessionReport {
  readonly observed: HarnessObservedStatus;
  /** What was actually seen, for the durable recovery record. Never a credential. */
  readonly detail: string;
}

export class HarnessSessionStatus extends Context.Service<
  HarnessSessionStatus,
  {
    /**
     * What became of one attempt's harness session.
     *
     * Takes the stored session id, nullable, because that is what an attempt row holds:
     * an attempt with no session id is a real state and has its own answer.
     *
     * Takes the stored **instance** id for the same reason, and it is the one thing a
     * second harness changed here. An attempt that ran on an instance this process does
     * not configure cannot be asked about — and asking the harness we *do* have would get
     * a confident `missing` for a session that may be alive somewhere else, which recovery
     * would then record as `uncertain` and fence. So a foreign instance answers
     * `unreachable` with both ids in the detail, which is the honest answer and the only
     * one an operator can act on.
     *
     * `null` is *not* foreign: it is a row written before instances were recorded, by a
     * process that had exactly one harness, so asking the one we have is the best
     * available answer rather than a guess (migration `0014_attempt_harness_instance`).
     */
    readonly of: (
      harnessSessionId: string | null,
      harnessInstanceId: string | null,
    ) => Effect.Effect<HarnessSessionReport>;
  }
>()("bit/recovery/HarnessSessionStatus") {
  /**
   * The live adapter over whichever harnesses this process configures.
   *
   * Note what the branches mean. **A session that exists and reports no outcome is not
   * assumed to be running**, and that sentence is the correction this function needed: it
   * used to map "no outcome" straight onto `running`, which after a restart left the
   * attempt row `running`, the write fence unmoved and the round untouched — the pile of
   * stuck `running` rows this whole file exists to prevent, reached by believing a column
   * that only a live process ever fills in. The harness now answers
   * `SessionStatus.activity` separately from the outcome, and only `activity: "running"`
   * is read as running; "idle with nothing recorded" is `abandoned`.
   *
   * **The order of the branches is part of that.** `activity` is checked first, so an
   * outcome reported beside `running` is ignored rather than believed: on both drivers
   * that outcome belongs to an earlier turn (OpenCode's `Execution.Started` never clears
   * `idle_outcome`; Claude Code's pump overwrites `record.outcome` per `result`), and both
   * drivers already drop it. Checking here as well means a third harness that forgets
   * cannot report turn one's answer about turn two through this seam.
   *
   * A session the harness has never heard of is `missing`. The two drivers reach a restart
   * from opposite sides and both end at `uncertain`: Claude Code *fails* for any session it
   * does not hold, because the SDK's live query dies with the process that spawned it, so a
   * restart there is `missing` or `unreachable`; OpenCode finds the row by primary key in
   * the user's own SQLite file, so a restart there is `abandoned`. An attempt whose instance
   * this process cannot give a harness for is `unreachable` without anything being asked.
   * Anything else is `unreachable` too, including a decode failure: being unable to
   * understand the answer is not the same as being told nothing happened.
   *
   * **The instance is resolved rather than compared**, which is the one thing more than
   * one configured instance changed here. Slice B held a single harness and could tell
   * foreign from ours with a string comparison; now `HarnessResolver` answers it, and it
   * answers two cases the comparison could not: an instance this process does not
   * configure *at all*, and one it does configure whose harness did not come up. Both are
   * `unreachable`, both carry the resolver's own sentence, and both stay apart from
   * `missing` — because asking the wrong harness would get a confident "no such session"
   * for a session that may be alive somewhere else, which recovery would then fence.
   *
   * A `null` instance is still not foreign: it is a row written before instances were
   * recorded, by a process that had exactly one harness, so the resolver's default is the
   * best available answer rather than a guess (migration `0014`).
   */
  static readonly layer = Layer.effect(
    HarnessSessionStatus,
    Effect.gen(function* () {
      const resolver = yield* HarnessResolver;
      return HarnessSessionStatus.of({
        of: Effect.fn("HarnessSessionStatus.of")(
          function* (harnessSessionId, harnessInstanceId) {
            if (harnessSessionId === null || harnessSessionId === "") {
              return {
                observed: "unbound",
                detail:
                  "the attempt has no harness session recorded, so there is nothing to query; this does not establish that no work was done",
              } satisfies HarnessSessionReport;
            }
            const resolved = yield* Effect.result(
              resolver.resolve(harnessInstanceId ?? undefined),
            );
            if (resolved._tag === "Failure") {
              return {
                observed: "unreachable",
                detail: `${resolved.failure.message} — so there is nothing here that can be asked about session ${harnessSessionId}`,
              } satisfies HarnessSessionReport;
            }
            // The resolver hands back the default when asked for `undefined`, so a row
            // naming an instance has to be checked against what came back: a default that
            // is a *different* instance must not be asked about a foreign session.
            if (
              harnessInstanceId !== null &&
              resolved.success.instance.instanceId !== harnessInstanceId
            ) {
              return {
                observed: "unreachable",
                detail: `the attempt ran on harness instance '${harnessInstanceId}' and this process resolved '${resolved.success.instance.instanceId}', so there is nothing here that can be asked about session ${harnessSessionId}`,
              } satisfies HarnessSessionReport;
            }
            const result = yield* Effect.result(
              resolved.success.harness.sessionStatus(harnessSessionId),
            );
            if (result._tag === "Success") {
              const { activity, outcome } = result.success;
              if (activity === "running") {
                return {
                  observed: "running",
                  detail: `session ${harnessSessionId} has a turn in flight in the harness process that holds it${outcome === undefined ? "" : `, so its recorded outcome '${outcome}' belongs to an earlier turn and was not read`}`,
                } satisfies HarnessSessionReport;
              }
              return outcome === undefined
                ? ({
                    observed: "abandoned",
                    detail: `session ${harnessSessionId} exists, has no turn in flight, and has never recorded a terminal outcome; the process that started its last turn is gone, so no outcome is coming and none can be inferred`,
                  } satisfies HarnessSessionReport)
                : ({
                    observed: outcome,
                    detail: `session ${harnessSessionId} reported outcome '${outcome}'`,
                  } satisfies HarnessSessionReport);
            }
            const failure = result.failure;
            const notFound =
              failure._tag === "HarnessTransportError" &&
              (failure.tag === SESSION_NOT_FOUND_TAG || failure.status === 404);
            return notFound
              ? ({
                  observed: "missing",
                  detail: `the harness does not know session ${harnessSessionId}: ${failure.message}`,
                } satisfies HarnessSessionReport)
              : ({
                  observed: "unreachable",
                  detail: `could not ask the harness about session ${harnessSessionId}: ${failure.message}`,
                } satisfies HarnessSessionReport);
          },
        ),
      });
    }),
  );

  /**
   * A fixed set of answers, for driving reconciliation deterministically.
   *
   * Exported rather than kept in the test file because the recovery demo uses it too,
   * to show the mapping for answers a live harness will not produce on demand (there is
   * no way to ask a real server to be unreachable at a chosen moment). A session id with
   * no entry answers `missing`, which is what a real harness does with an id it has
   * never seen.
   *
   * It scripts {@link HarnessObservedStatus} and not the harness's own `SessionStatus`, so
   * it bypasses the activity/outcome mapping entirely. That is deliberate — the mapping has its own
   * tests against the live layer — but it means a sweep driven from here cannot be used to
   * show what the drivers answer. `recovery/reconcile.test.ts` covers that against
   * `HarnessSessionStatus.layer`.
   */
  static readonly fromAnswers = (
    answers: Readonly<Record<string, HarnessObservedStatus>>,
  ) =>
    Layer.succeed(
      HarnessSessionStatus,
      HarnessSessionStatus.of({
        // The instance is accepted and ignored: a scripted answer is keyed by session id,
        // and a test that wants the foreign-instance branch wants the live layer.
        of: (harnessSessionId) =>
          Effect.succeed(
            harnessSessionId === null || harnessSessionId === ""
              ? {
                  observed: "unbound",
                  detail:
                    "the attempt has no harness session recorded, so there is nothing to query; this does not establish that no work was done",
                }
              : {
                  observed: answers[harnessSessionId] ?? "missing",
                  detail: `scripted answer for session ${harnessSessionId}`,
                },
          ),
      }),
    );
}
