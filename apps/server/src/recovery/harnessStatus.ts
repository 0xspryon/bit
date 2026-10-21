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

import { OpenCodeClient } from "../harness/openCodeClient";

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
 *   or a reply we cannot decode.
 *
 * All three of ours mean *uncertain*. They are kept apart because the operator reading
 * the recovery record needs to know which one it was.
 */
export type HarnessObservedStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "unbound"
  | "missing"
  | "unreachable";

export interface HarnessSessionReport {
  readonly observed: HarnessObservedStatus;
  /** What was actually seen, for the durable recovery record. Never a credential. */
  readonly detail: string;
}

/**
 * The client's tag for "no such session".
 *
 * A string compare against the generated client's own vocabulary
 * (`@opencode/protocol`'s `SessionNotFoundError`, surfaced through
 * `HarnessTransportError.tag`), checked alongside a plain `404` so either signal is
 * enough. `@opencode/protocol` is a transitive dependency of the client and not a
 * declared one here, so importing the class to compare against would mean depending on
 * hoisting.
 */
const SESSION_NOT_FOUND_TAG = "SessionNotFoundError";

export class HarnessSessionStatus extends Context.Service<
  HarnessSessionStatus,
  {
    /**
     * What became of one attempt's harness session.
     *
     * Takes the stored session id, nullable, because that is what an attempt row holds:
     * an attempt with no session id is a real state and has its own answer.
     */
    readonly of: (
      harnessSessionId: string | null,
    ) => Effect.Effect<HarnessSessionReport>;
  }
>()("bit/recovery/HarnessSessionStatus") {
  /**
   * The live adapter over a running `opencode serve`.
   *
   * Note what the three branches mean. A session that exists but reports no outcome is
   * genuinely still running, and is left alone. A session the harness has never heard
   * of is `missing` — which after a restart is the expected answer, because a new
   * server process is not guaranteed to know an old process's sessions. Anything else
   * is `unreachable`, including a decode failure: being unable to understand the answer
   * is not the same as being told nothing happened.
   */
  static readonly layer = Layer.effect(
    HarnessSessionStatus,
    Effect.gen(function* () {
      const client = yield* OpenCodeClient;
      return HarnessSessionStatus.of({
        of: Effect.fn("HarnessSessionStatus.of")(function* (harnessSessionId) {
          if (harnessSessionId === null || harnessSessionId === "") {
            return {
              observed: "unbound",
              detail:
                "the attempt has no harness session recorded, so there is nothing to query; this does not establish that no work was done",
            } satisfies HarnessSessionReport;
          }
          const result = yield* Effect.result(
            client.sessionStatus(harnessSessionId),
          );
          if (result._tag === "Success") {
            const outcome = result.success.outcome;
            return outcome === undefined
              ? ({
                  observed: "running",
                  detail: `session ${harnessSessionId} exists and has not reported a terminal outcome`,
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
        }),
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
   */
  static readonly fromAnswers = (
    answers: Readonly<Record<string, HarnessObservedStatus>>,
  ) =>
    Layer.succeed(
      HarnessSessionStatus,
      HarnessSessionStatus.of({
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
