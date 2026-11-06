/**
 * Opening a planner round from a target and a goal, and nothing else.
 *
 * ## Why this is a service and not a second copy of four lines
 *
 * {@link PlanSupervisor.start} takes a `PlanInput`: a target, a goal, the **engagement
 * folder** the round's directory must not sit inside, the **audit path** its policy gate
 * appends to, a session title and the briefing ceiling. Those last four are facts about
 * this installation's filesystem layout and configuration, and they are assembled from the
 * fleet registry — which is why `contracts/plan.ts` is explicit that `PlanInput` is not a
 * wire shape and the `POST .../plan` route takes no payload at all.
 *
 * There are now **two** callers that have a goal and need a round: that route, and the goal
 * agent's `wake_planner` tool. The tool has strictly less context than the route — it holds
 * a goal credential, so it knows a target id and a goal id and has never heard of a
 * workspace path — and a second assembly of the four would be a second answer to "where
 * does planning happen, and where does its gate write". A drift between them would not fail
 * a test: it would put a round's audit trail somewhere nobody looks.
 *
 * So the assembly lives here, once, and both callers pass what they have.
 *
 * ## What it deliberately does not do
 *
 * It does not check the goal exists. `PlanSupervisor.start` refuses `goal_not_found` for a
 * goal this target does not hold, and the browser route checks first anyway so that a stale
 * deep link is a `404` rather than a `409` — two different answers to two different
 * mistakes, and neither is improved by a third check here.
 *
 * It does not map {@link GoalBriefingTooLarge} into anything. That error carries two
 * numbers, the browser renders it as the same refusal the briefing panel already shows, and
 * the goal agent's tool renders it as a sentence about the ceiling. Flattening it here would
 * throw away the numbers both of them print.
 */
import { Context, Effect, Layer } from "effect";

import { DEFAULT_GOAL_BRIEFING_MAX_CHARS } from "../briefing/goalBriefing";
import type { GoalBriefingTooLarge } from "../briefing/goalBriefing";
import { FleetStore } from "../persistence/fleet";
import { PlanRefused, PlanSupervisor } from "./planSupervisor";
import type { PlanRoundStarted } from "./planSupervisor";

/** What a caller of {@link RoundOpener} holds, which is only ever this much. */
export interface RoundRequest {
  readonly targetId: string;
  readonly goalId: string;
  /**
   * An instruction the round is being opened to carry out, if any.
   *
   * Absent for an operator's "Plan next". Present when the goal agent wanted to steer and
   * found no live round — decision 12's second clause — in which case it reaches the model
   * inside the round's opening prompt and is stored nowhere.
   */
  readonly directive?: string | undefined;
}

export class RoundOpener extends Context.Service<
  RoundOpener,
  {
    /**
     * Opens one round on one goal, answering as soon as it is durable and prompted.
     *
     * Every refusal is the supervisor's own, including the two that are really about this
     * installation: `planning_directory_unusable` when the round's directory could not be
     * made, and `planning_ungated` when the policy gate would not install into it. A round
     * is refused rather than run ungated.
     */
    readonly open: (
      request: RoundRequest,
    ) => Effect.Effect<PlanRoundStarted, PlanRefused | GoalBriefingTooLarge>;
  }
>()("bit/plan/RoundOpener") {
  /**
   * The opener over this server's registry and supervisor.
   *
   * `briefingMaxChars` is passed in rather than read from the environment here, for the
   * reason `BrowserApiConfig` holds the same figure: the number an operator watched on the
   * briefing panel has to be the number a round is refused against, and one process
   * reading `GOAL_BRIEFING_MAX_CHARS` in two places is two numbers waiting to differ.
   */
  static readonly layer = (options?: {
    readonly briefingMaxChars?: number | undefined;
  }): Layer.Layer<RoundOpener, never, FleetStore | PlanSupervisor> =>
    Layer.effect(
      RoundOpener,
      Effect.gen(function* () {
        const fleet = yield* FleetStore;
        const planner = yield* PlanSupervisor;
        const briefingMaxChars =
          options?.briefingMaxChars ?? DEFAULT_GOAL_BRIEFING_MAX_CHARS;
        return RoundOpener.of({
          open: Effect.fn("RoundOpener.open")(function* (request) {
            /*
             * The registry row, for the two things only it knows.
             *
             * `workspacePath` is passed so the containment check can refuse a planning
             * directory *inside* the engagement folder, and `undefined` says this target
             * has no folder — a statement rather than an omission, because the check does
             * not run for a caller who leaves the field out
             * (`harness/roleDirectory.ts`'s `RoleDirectoryInput.workspace`).
             *
             * A row that has gone missing between the caller's own checks and here is
             * `target_unavailable`: the supervisor would say the same thing a moment later
             * from `stores.open`, and saying it here keeps `PlanInput` from being built
             * from a name with no row behind it.
             */
            const row = yield* fleet
              .target(request.targetId)
              .pipe(Effect.orDie);
            if (row === undefined) {
              return yield* new PlanRefused({
                reason: "target_unavailable",
                detail: `no target '${request.targetId}' is registered on this server, so there is nowhere to open a planner round`,
              });
            }
            return yield* planner.start({
              targetId: row.targetId,
              goalId: request.goalId,
              workspace: row.workspacePath ?? undefined,
              title: `bit planner: ${row.name}`,
              briefingMaxChars,
              ...(request.directive === undefined
                ? {}
                : { directive: request.directive }),
            });
          }),
        });
      }),
    );
}
