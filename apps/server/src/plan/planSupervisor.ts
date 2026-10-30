/**
 * A planner round outlives the request that opens it.
 *
 * This is `run/supervisor.ts`'s shape applied to the second kind of supervised work, and
 * it is deliberately a sibling rather than a variation: the round row is the durable
 * record, the fiber is the ephemeral one, the claim is taken synchronously before the fork,
 * narration is subscribed before the prompt, the credential's lifetime is the fiber's
 * scope, and the settlement table is the shared one in `run/settlement.ts`. Where this file
 * differs from that one, the difference is stated at the line that makes it.
 *
 * ## Why this is a second service and not an overloaded `RunSupervisor`
 *
 * The two supervise different things and the claims differ: a worker claims an *engagement
 * folder* because the gate and the MCP registration are per directory there, and a round
 * claims a *goal* because one planner works one goal at a time (the spec's decision 7).
 * `RunningAttempt` is a contract about attempts, `claimedWorkspaces`' reasoning is about
 * two workers in one folder, and `settleAttempt` writes to `attempts`. An overload would
 * have had to branch on which kind of work it was holding at nearly every line, and the
 * one thing the two genuinely share — the rule that turns silence into `uncertain` — is
 * now shared as code.
 *
 * ## The tools, and the endpoint they are on
 *
 * A round now has its own tool surface: `add_intent`, `record_round_disposition`, the
 * three graph reads and `list_harnesses` (`mcp/plannerTools.ts`). What is registered with
 * the harness is the **planner** MCP endpoint — `WorkerEndpoints.urls.plannerMcp`, not
 * `urls.mcp` — carrying this round's credential.
 *
 * The scoping is per grant, which is what this file's earlier note said slice 7 would have
 * to deliver, and it is per path as well. `mcp/server.ts` serves two `McpServer`s with two
 * toolkits, and each one's auth middleware refuses a credential whose tag is not the role
 * it serves: a round bearer at the worker endpoint is a `401`, and an attempt bearer here
 * is a `401`. `effect/ai` offers no hook that can filter one toolkit by the caller — the
 * `EnabledWhen` predicate sees a client profile and cannot yield `McpInvocation` — so a
 * second endpoint is how the tool *list* is made a function of the grant rather than only
 * the writes being one. The reasoning in full is on that module.
 *
 * ## What is not here yet, said plainly
 *
 * **Narration is published and never stored.** The round's harness stream is drained so a
 * terminal `session.execution.*` can be read off it, and every entry is forwarded to
 * `run/narration.ts` under this round (see {@link narrateRound}) so the planner chat can
 * watch it. That bus is in-process and sliding: an entry published with no browser attached
 * is gone, and nothing reconciles against it. What survives a reload is the pair of
 * records, `plan.round.started` and `plan.round.settled` — the spec's decision 16 — plus
 * whatever the harness still holds, which `plan/roundNarration.ts` replays and which the
 * harness may have deleted.
 *
 * **No transcript artefact.** `run/transcript.ts` captures a settled *attempt*'s transcript
 * into the target's evidence directory; nothing writes a round's. The planner view reads
 * the harness's own copy instead and says that it is the harness's — which is the whole of
 * decision 14's accepted cost, and the reason a month-old round shows its disposition and
 * not its prose.
 *
 * ## The three ways a round ends
 *
 * The same three, for the same reasons (`run/supervisor.ts`'s header is the long form).
 * **It finishes** and the harness states an outcome, which `roundSettlementFor` reads into
 * the round vocabulary. **Stop** interrupts the fiber, whose finalizer asks the harness to
 * interrupt, settles `interrupted`, revokes the grant, unregisters the server and releases
 * the goal. **The process shuts down** and the fiber map's finalizer does the same for
 * every round in flight, bounded by {@link SETTLEMENT_ASK_TIMEOUT}. And when **the process
 * dies**, the round row is left `running` for `recovery/reconcile.ts`'s round sweep, which
 * reconciles it and — by moving it out of `running` — gives the goal back.
 *
 * **The prompt is never resubmitted**, on any path. It matters more here than for a
 * worker: a re-prompted round would mint fresh operation ids and commit a second set of
 * intents that `add_intent`'s receipts could not recognise as a replay.
 *
 * ## Settlement does not count `result` messages
 *
 * DECISIONS.md §24.1 measured that Claude Code's pump stops at the first `result` and
 * closes the session, and that under a steer that first `result` is the turn the steer took
 * over from — so "the first result ends the session" is wrong for a steered round, and
 * slice 9 is what fixes that seam. Nothing here acquires a dependency on it: settlement
 * reads `waitForIdle` returning and `sessionStatus`'s answer about the *session*, which are
 * statements about the session rather than a count of turns. When that seam is fixed this
 * file does not change.
 */
import {
  PlanRefused,
  bitMcpServerName,
  type PlanRoundStarted,
  type RunningRound,
} from "@bit/contracts";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Fiber,
  FiberMap,
  Layer,
  Option,
  Redacted,
  Stream,
  type Duration,
} from "effect";

import { AgentHarness, type TerminalOutcome } from "../harness/agentHarness";
import {
  DEFAULT_GOAL_BRIEFING_MAX_CHARS,
  buildGoalBriefing,
  type GoalBriefingTooLarge,
} from "../briefing/goalBriefing";
import { assembleRoundPrompt, type AssembledRoundPrompt } from "./roundPrompt";
import { HarnessResolver, type ResolvedHarness } from "../harness/resolver";
import { FleetStore } from "../persistence/fleet";
import * as identifier from "../persistence/identifier";
import {
  ObservationStore,
  callerScopeOf,
  operatorScope,
  type RoundTerminalStatus,
} from "../persistence/store";
import { TargetStores } from "../persistence/targetStores";
import { McpCredentials } from "../mcp/credentials";
import { McpCallCounter } from "../mcp/server";
import { gatedRoleDirectory, type GatedDirectory } from "../policy/install";
import {
  SETTLEMENT_ASK_TIMEOUT,
  renderEnd,
  roundSettlementFor,
  type SupervisionEnd,
} from "../run/settlement";
import { RunNarrations } from "../run/narration";
import { WorkerEndpoints } from "../run/supervisor";

/**
 * How many intents a round may add when nothing says otherwise.
 *
 * Five, and the number is a starting point rather than a finding: it is written on the
 * round row so the limit a round was opened under is a fact about that round, and
 * `add_intent` is what enforces it in slice 7 (the spec's decision 10). `main.ts` reads
 * `PLANNER_ROUND_BUDGET` over it.
 */
export const DEFAULT_ROUND_BUDGET = 5;

/**
 * `AgentHarness.createSession`, narrowed so that the directory must be gated.
 *
 * **This exists because the brand alone guarantees nothing.** `GatedDirectory` is
 * `string & Brand<"GatedDirectory">`, and `AgentHarness.createSession` takes
 * `directory: string` — so a plain path, or an `UngatedRoleDirectory`'s `unsafePath()`,
 * compiles perfectly well at that seam. Slice 3's own comment is careful about this: the
 * brand is what *lets* a function that creates a session ask for a gated path. It is a
 * capability, and until somebody uses it nothing is enforced.
 *
 * This is the use. The one call in this file that opens a planner session goes through
 * here, so passing a path that has not been through `gatedRoleDirectory` is a compile
 * error rather than a convention, and the next role to need one (slice 9's goal agent) has
 * a pattern to copy. It is three lines and adds no behaviour: deliberately, because a
 * wrapper that did anything else would be a second place for session creation to differ.
 *
 * It does **not** cover `registerMcpServer`, whose `McpRegistration.directory` is also a
 * plain `string`. Narrowing that would mean changing a shared seam's type for one caller;
 * the registration is handed the same local the session was, which is stated where it
 * happens.
 */
const createPlannerSession = (
  harness: AgentHarness["Service"],
  input: {
    readonly title: string;
    readonly model: string;
    readonly directory: GatedDirectory;
    readonly sessionId: string;
    readonly parentSessionId?: string | undefined;
  },
) => harness.createSession(input);

/**
 * How many settled rounds are kept for a stop response to report.
 *
 * `run/supervisor.ts`'s `SETTLEMENT_MEMORY`, for its reason: a courtesy for a response
 * body and not a record. The record is the round row and its `plan.round.settled` event.
 */
const SETTLEMENT_MEMORY = 64;

/** What opening one planner round needs. */
export interface PlanInput {
  /** Whose graph this round plans over, and whose database it writes to. */
  readonly targetId: string;
  /**
   * The goal to plan. It is **claimed**, not created: the round is refused unless the goal
   * exists in this target and is `active`, and unless no other round is working it. The
   * objective is the goal's own and is not a field here, for the reason `RunInput` has no
   * `question`: a second source for it would be two answers to "what is this about".
   */
  readonly goalId: string;
  /**
   * The engagement's own folder, where *workers* run, or `undefined` for a target that
   * has none.
   *
   * **Not where this session runs.** A round runs in `targets/<id>/planning/<roundId>/`,
   * which this supervisor obtains through `gatedRoleDirectory` and which the caller cannot
   * name. This field is here only so the containment check can refuse a planning directory
   * that lies *inside* the workspace, and it is required — explicitly `undefined` when
   * there is none — because an optional field is a check that silently does not run for
   * the caller who forgets it (`policy/install.ts`'s `GatedRoleDirectory.workspace`).
   */
  readonly workspace: string | undefined;
  /**
   * Where the harness-side policy gate appends its decisions.
   *
   * Supplied by the caller for `RunInput.auditPath`'s reason — it is a fleet-layout
   * question and this supervisor does not hold the registry's paths for it — and it must
   * be outside the planning directory, which `gatedRoleDirectory` checks rather than
   * trusts.
   */
  readonly auditPath: string;
  /** Shown as the session's title in the harness's own UI. */
  readonly title: string;
  /**
   * Which configured harness to run the round on: the operator's explicit pick, else the
   * server's default.
   *
   * **No suggestion tier, unlike a run.** An intent may suggest an instance for the worker
   * that answers it (the spec's decision 13); nothing suggests one for a planner, because
   * nothing but the operator has an opinion about where planning happens. So the two-tier
   * order here is the whole order, and an explicit pick that cannot be had is refused
   * `harness_not_ready` rather than falling back — for `chooseHarness`'s reason: the round
   * row records what actually ran.
   */
  readonly instanceId?: string | undefined;
  /** Which model, inside that instance. Absent means the instance's own default. */
  readonly model?: string | undefined;
  /**
   * The ceiling on the rendered goal briefing, in characters. Defaults to
   * `DEFAULT_GOAL_BRIEFING_MAX_CHARS`.
   *
   * Configuration the caller holds — `main.ts` reads `GOAL_BRIEFING_MAX_CHARS` and the
   * browser API passes the same figure to the briefing panel — rather than something this
   * supervisor decides, so the number an operator watched on that panel is the number a
   * round is refused against.
   *
   * **It bounds the briefing, not the prompt.** See `plan/roundPrompt.ts`: the round's
   * framing wraps the briefing, so what the model receives is larger, and both lengths are
   * reported on the started round rather than left to be inferred.
   */
  readonly briefingMaxChars?: number | undefined;
}

/**
 * What a started round answers with, and what one this process is driving looks like.
 *
 * **Both now live in `@bit/contracts`, and so does {@link PlanRefused}.** They were
 * declared here while nothing a browser could reach used them, with this file saying the
 * decision had an expiry attached to the arrival of `POST /goals/:goalId/plan`. That route
 * is this slice's, so the three moved; `contracts/plan.ts` carries the prose for every
 * field and every refusal reason. Re-exported from here so the supervisor's own call sites
 * and tests do not have to know which side of the boundary each shape sits on.
 *
 * `PlanRoundStopped` stayed behind, deliberately: nothing answers with it. Stopping a round
 * is the planner view's control and arrives with it, and publishing a shape no route
 * returns is the mistake the move corrects.
 */
export { PlanRefused } from "@bit/contracts";
export type { PlanRoundStarted, RunningRound } from "@bit/contracts";

/** What a stopped round answers with. Server-side; see above. */
export interface PlanRoundStopped {
  readonly roundId: string;
  readonly targetId: string;
  readonly harnessSessionId: string;
  readonly status: RoundTerminalStatus;
  readonly credentialsRevoked: number;
  /**
   * Authenticated MCP requests this round's credential made, from
   * {@link McpCallCounter.countFor}.
   *
   * **Zero means the round never reached its own tool surface**, which is a different fact
   * from a round that had its tools and chose to say nothing — see {@link settle}, where
   * the figure is read and where the distinction is made for every settlement path rather
   * than only for a stop.
   */
  readonly toolCallsSeen: number;
  readonly stoppedAt: number;
}

/**
 * Collapses everything the start half can fail with into one typed refusal.
 *
 * `run/supervisor.ts`'s `refuse`, with the round's own reason table. The distinctions kept
 * are the ones an operator acts on — is this the goal, the harness, the directory or the
 * database — and the ones that only matter to us go to the log with their structure
 * intact.
 */
const refuse = (error: {
  readonly _tag: string;
  readonly message?: string;
  readonly reason?: string;
  readonly detail?: string;
  readonly targetId?: string;
}): PlanRefused => {
  switch (error._tag) {
    // One reason each, taken from the one the store gave. `openRound`'s own refusals are
    // `MutationError`s and are never mapped by their sentence.
    case "MutationError": {
      const detail =
        error.detail ?? error.message ?? "no planner round could be opened";
      switch (error.reason) {
        case "unauthorized":
          return new PlanRefused({ reason: "goal_not_found", detail });
        case "invalid":
          return new PlanRefused({ reason: "goal_not_active", detail });
        case "conflict":
          return new PlanRefused({ reason: "round_conflict", detail });
        default:
          return new PlanRefused({ reason: "store_unavailable", detail });
      }
    }
    case "FleetError":
      return new PlanRefused({
        reason:
          error.reason === "invalid_role_id"
            ? "planning_directory_unusable"
            : "target_unavailable",
        detail: error.message ?? "that target could not be opened",
      });
    case "PolicyHookNotInstalled":
      return new PlanRefused({
        reason: "planning_ungated",
        detail:
          error.message ??
          "the pre-execution policy gate could not be installed into this round's directory",
      });
    case "HarnessTransportError":
    case "HarnessDecodeError":
      return new PlanRefused({
        reason: "harness_unreachable",
        detail: error.message ?? "the agent harness did not answer",
      });
    case "HarnessNotReady":
      return new PlanRefused({
        reason: "harness_not_ready",
        detail:
          error.message ?? "that harness instance is not usable on this server",
      });
    default:
      return new PlanRefused({
        reason: "store_unavailable",
        detail:
          error.message ?? "this target's database could not be written to",
      });
  }
};

export class PlanSupervisor extends Context.Service<
  PlanSupervisor,
  {
    /**
     * Opens a planner round and returns as soon as the prompt is accepted.
     *
     * Does **not** wait for the round. By the time this returns the `planner_rounds` row
     * exists, the goal claim is held, the planning directory is gated, the harness session
     * exists under the goal's lineage, a round-scoped credential is minted and registered,
     * and the prompt has been accepted. Everything after that is the fiber's.
     */
    readonly start: (
      input: PlanInput,
    ) => Effect.Effect<PlanRoundStarted, PlanRefused | GoalBriefingTooLarge>;
    /**
     * Interrupts one round, settles it and revokes its authority.
     *
     * Refuses `unknown_round` when nothing is running under that id in *this* process.
     */
    readonly stop: (
      roundId: string,
    ) => Effect.Effect<PlanRoundStopped, PlanRefused>;
    /** The rounds this process is supervising right now, from the fiber map itself. */
    readonly running: Effect.Effect<readonly RunningRound[]>;
  }
>()("bit/plan/PlanSupervisor") {
  /**
   * The plan supervisor over whichever harnesses a server configures.
   *
   * `FleetStore` is a requirement `RunSupervisor` does not have, and the reason is the
   * whole of slice 3: a worker runs in the operator's own folder, which arrives as a
   * string, and a round runs in a directory *we* lay out — so this is the first caller of
   * `ensurePlanningDirectory`, and the registry is the only thing that may answer where
   * that is.
   */
  static readonly layer: Layer.Layer<
    PlanSupervisor,
    never,
    | HarnessResolver
    | TargetStores
    | FleetStore
    | McpCredentials
    | McpCallCounter
    | WorkerEndpoints
    | RunNarrations
  > = Layer.effect(
    PlanSupervisor,
    // `Effect.suspend` for `RunSupervisor.layer`'s reason: `make` closes over this class
    // and this class's static initialiser names `make`.
    Effect.suspend(() => make()),
  );

  /**
   * The plan supervisor with the budget, or the settlement bound, set explicitly.
   *
   * `budget` is configuration `main.ts` reads from `PLANNER_ROUND_BUDGET`. `askTimeout`
   * exists for the reason `RunSupervisor.layerWith`'s does: ten seconds is right for an
   * operator and unusable for a suite that has to watch a shutdown *not* wait.
   */
  static readonly layerWith = (options: {
    readonly budget?: number | undefined;
    readonly askTimeout?: Duration.Input | undefined;
  }): Layer.Layer<
    PlanSupervisor,
    never,
    | HarnessResolver
    | TargetStores
    | FleetStore
    | McpCredentials
    | McpCallCounter
    | WorkerEndpoints
    | RunNarrations
  > =>
    Layer.effect(
      PlanSupervisor,
      Effect.suspend(() => make(options)),
    );

  /**
   * A plan supervisor for a process that has no harness to drive.
   *
   * `RunSupervisor.unavailable`'s arrangement and its reason: a server whose configured
   * harness is missing still boots, still serves the browser, still sweeps the fleet and
   * still reconciles — including the round sweep, which needs no harness to record
   * `uncertain`. `running` is empty and `stop` refuses, both of which are true.
   */
  static readonly unavailable: Layer.Layer<PlanSupervisor> = Layer.succeed(
    PlanSupervisor,
    PlanSupervisor.of({
      start: () =>
        Effect.fail(
          new PlanRefused({
            reason: "no_harness",
            detail:
              "this server has no agent harness, so there is nothing to run a planner round in: either the harness HARNESS names could not be started, or it was switched off with HARNESS=0. Check that the harness is installed and authenticated, then restart.",
          }),
        ),
      stop: (roundId) =>
        Effect.fail(
          new PlanRefused({
            reason: "unknown_round",
            detail: `nothing is running under ${roundId}: this server has no agent harness, so it has opened no rounds`,
          }),
        ),
      running: Effect.succeed([]),
    }),
  );
}

const make = Effect.fnUntraced(function* (options?: {
  readonly budget?: number | undefined;
  readonly askTimeout?: Duration.Input | undefined;
}) {
  const budget = options?.budget ?? DEFAULT_ROUND_BUDGET;
  const askTimeout = options?.askTimeout ?? SETTLEMENT_ASK_TIMEOUT;
  /**
   * The only thing in this file that knows there is more than one harness.
   *
   * Read here, used in exactly one place — {@link start}, before the goal is claimed — and
   * the harness it answers with is provided to the round's body, so every step below is
   * written against a single {@link AgentHarness} it cannot branch on.
   */
  const resolver = yield* HarnessResolver;
  const stores = yield* TargetStores;
  const fleet = yield* FleetStore;
  const credentials = yield* McpCredentials;
  /**
   * The in-process narration bus, which a round now publishes onto.
   *
   * **It is the planner view's live channel, and it is not durable.** Nothing here writes
   * narration anywhere (the spec's decision 14): what a round says reaches a browser only
   * while a browser is attached, and the pair of records this file does write —
   * `plan.round.started` and `plan.round.settled` — is what survives a reload. The bus is
   * sliding, so a slow tab drops entries rather than slowing the round down.
   */
  const narrations = yield* RunNarrations;
  /**
   * The MCP endpoint's own request tally, read at settlement.
   *
   * **A requirement rather than something optional, because a diagnostic nobody reads is
   * not a diagnostic.** `McpCallCounter` counts authenticated requests per caller scope,
   * and a round's scope names exactly one round — so the figure answers the one question
   * Spike B's tool-exposure lag makes unanswerable from anything else: did this round's
   * session ever reach its tools? See {@link settle}.
   *
   * It has to be the **same instance** the MCP middleware increments. `main.ts` provides
   * one `McpCallCounter.layer` reference to this graph and to the listener's, so layer
   * memoisation gives both the same map — the argument `McpCredentials` already makes
   * there, with the same consequence if it were ever two: a count that is always zero
   * because the middleware is incrementing somebody else's.
   */
  const calls = yield* McpCallCounter;
  const endpoints = yield* WorkerEndpoints;

  /**
   * One entry per running round, owned by this layer's scope.
   *
   * Closing that scope interrupts every entry, so a `SIGINT` runs each round's finalizer —
   * settle, revoke, release — rather than dropping it with a live credential behind it.
   * `unknown` as the error channel for the reason `RunSupervisor`'s map gives: typing it
   * `never` would force a `catchCause` that also swallows interruption, which is the one
   * cause these fibers must be allowed to complete with.
   */
  const fibers = yield* FiberMap.make<string, void, unknown>();
  /** Forks into the fiber map with **this layer's** context, captured here. */
  const fork = yield* FiberMap.runtime(fibers)<never>();

  /** What each round registers so `running` can answer without asking a fiber. */
  const supervised = new Map<string, RunningRound>();

  /**
   * The goals a round is in flight on, so a second one can be refused.
   *
   * ## Why a goal can hold only one round at a time
   *
   * One planner works one goal (the spec's decision 7). The reason is not the directory —
   * each round gets `planning/<roundId>/` of its own, so two rounds would not see each
   * other's MCP registrations the way two workers in one workspace do (DECISIONS.md
   * §24.2, question 1). It is the *graph*: both rounds would read the same goal live, both
   * would propose intents against the same untested dimensions, and only `add_intent`'s
   * write-time join would stop the duplicates — which the spec's §5 already names as the
   * condition most likely to bite. A planner that races itself produces work an operator
   * has to un-dispatch.
   *
   * ## Claimed before anything is forked, and why the durable check is not enough
   *
   * `openRound` already refuses a second running round on a goal, and it holds across
   * processes. It is not sufficient on its own: two `start` calls arriving in the same tick
   * would both be inside their fibers before either had written a row, so both would pass
   * the store's check. This map closes that, and {@link goalClaim} takes it with
   * `Effect.sync`, which does not yield — so the check and the claim are one indivisible
   * step. Neither half replaces the other; `claimedWorkspaces` in `run/supervisor.ts`
   * makes the same argument for the same reason.
   *
   * **By what is actually running**, which is this map, rather than by rows saying
   * `running`: a row left behind by a process that died has no round in flight, and
   * refusing on its account here would be the *store's* refusal reported as ours. The
   * startup sweep is what settles those, and it is `round_conflict` rather than
   * `goal_busy` that an operator sees in the meantime.
   */
  const claimedGoals = new Map<
    string,
    { readonly roundId: string; readonly targetId: string }
  >();

  /**
   * Claims a goal for one round, or reports which round already holds it.
   *
   * Returns `undefined` on success. Releasing is {@link releaseGoal}, which the round's
   * own finalizer calls on every exit.
   */
  const goalClaim = (
    goalId: string,
    claim: { readonly roundId: string; readonly targetId: string },
  ): Effect.Effect<PlanRefused | undefined> =>
    Effect.sync(() => {
      const held = claimedGoals.get(goalId);
      if (held !== undefined) {
        return new PlanRefused({
          reason: "goal_busy",
          detail: `round ${held.roundId} is already planning goal ${goalId} (target '${held.targetId}'). One planner round works a goal at a time: two rounds reading the same goal live would propose the same intents against the same untested dimensions. Stop that round, or wait for it to settle, and open this one after.`,
        });
      }
      claimedGoals.set(goalId, claim);
      return undefined;
    });

  /** Gives a goal back. Idempotent, and safe to call for a claim we never made. */
  const releaseGoal = (goalId: string, roundId: string): Effect.Effect<void> =>
    Effect.sync(() => {
      // Only our own claim: a release that fired late must not hand away a goal a *later*
      // round has since claimed.
      if (claimedGoals.get(goalId)?.roundId === roundId) {
        claimedGoals.delete(goalId);
      }
    });

  /**
   * What each round settled to, written by its finalizer.
   *
   * Exists so {@link stop} can report the settlement it caused without re-reading the row:
   * `Fiber.interrupt` awaits the finalizer, so by the time stop looks here the entry is
   * there. Bounded by {@link SETTLEMENT_MEMORY}, because this is a courtesy for a response
   * body and not a record.
   */
  const settlements = new Map<
    string,
    { status: RoundTerminalStatus; grants: number; toolCallsSeen: number }
  >();
  const remember = (
    roundId: string,
    outcome: {
      status: RoundTerminalStatus;
      grants: number;
      toolCallsSeen: number;
    },
  ): void => {
    settlements.set(roundId, outcome);
    while (settlements.size > SETTLEMENT_MEMORY) {
      const oldest = settlements.keys().next().value;
      if (oldest === undefined) break;
      settlements.delete(oldest);
    }
  };

  /**
   * Step one of the start: the row, and nothing that can fail after it.
   *
   * **The split between this and {@link prepareRound} is the only reason it is two
   * functions, and it is worth the paragraph.** Everything after `openRound` can fail —
   * the gate, the session, the lineage, the credential, the registration — and a failure
   * there leaves a row that says `running` under a goal that `openRound` will then refuse
   * a second round on, for the life of the process. `supervise` therefore registers the
   * settling finalizer *between* these two calls, so the first thing that is true after
   * the row exists is that something will settle it. Writing this as one function put the
   * finalizer after every failure it needed to cover, which left the round stranded and
   * the goal blocked; a review's scripted-failure probe is what found that, and the split
   * is the fix.
   *
   * So the rule for this function is: **it must not do anything that can fail after
   * `openRound` returns.** `openRound` is its last statement for that reason.
   *
   * ## The order, and why each step is where it is
   *
   * The harness is resolved before this function is reached — see {@link start} — so a
   * round naming an instance this server cannot give it leaves nothing behind at all.
   *
   * **1. The session id, minted before the row is written.** `startHalf` in
   * `run/supervisor.ts` closes a window by pre-assigning it, and the window is the same
   * here: a row written with `harnessSessionId: null` and bound afterwards means a process
   * that died in between left a live harness session no row pointed at, and the sweep reads
   * rows. Naming the session first makes the worst case a row pointing at a session that
   * was never created, which the sweep already handles by asking, being told `missing`, and
   * recording `uncertain`.
   *
   * **2. The row, before the directory.** This is the one ordering that differs from a
   * worker's, where the gate goes in first so a refusal writes nothing. The reason it is
   * the other way round here is that the directory does not already exist: a worker's gate
   * is a file written into the operator's own folder, and a round's directory is *created
   * by us*, under `targets/<id>/planning/`. `openRound` is the authoritative refusal — an
   * ended goal, a goal of another target, a second running round — and it is a local
   * transaction, so taking it first means a refused round leaves no directory tree behind
   * for a round that never happened. What that order costs is the finalizer ordering above,
   * which is why these are two functions.
   */
  const openRoundRow = Effect.fnUntraced(function* (
    input: PlanInput,
    ids: { readonly roundId: string },
  ) {
    // From context, not from a parameter and not from the layer: `supervise` provides the
    // one instance this round was resolved to.
    const harness = yield* AgentHarness;
    const store = yield* stores.open(input.targetId);

    // Minted by the harness, in the harness's own format, and written into the row below
    // before the session exists. See this function's header, step 1.
    const harnessSessionId = harness.newSessionId();
    const model = input.model ?? harness.instance.defaultModel;
    const provenance = harness.modelProvenance(model);

    const authority = yield* store.openRound(
      // The host's own authority. A round is opened by whoever asked for it — the operator
      // today, the goal agent's `wake_planner` in slice 9 — and never by a round
      // credential: minting one needs the row this call creates.
      { callerScope: operatorScope(input.targetId), targetId: input.targetId },
      {
        goalId: input.goalId,
        roundId: ids.roundId,
        budget,
        harnessInstanceId: harness.instance.instanceId,
        providerId: provenance.providerId,
        modelId: provenance.modelId,
        harnessSessionId,
      },
    );

    return { store, harnessSessionId, model, provenance, authority };
  });

  /**
   * Step two of the start: everything up to, but not including, the prompt.
   *
   * Every statement here can fail, and by the time it runs the round is already covered by
   * {@link supervise}'s finalizer — so a failure settles the round `uncertain` and gives the
   * goal back rather than stranding either. That is the whole point of the split; see
   * {@link openRoundRow}.
   *
   * The prompt is one step further out still, in {@link supervise}, because the narration
   * subscription has to be opened first — `event.subscribe()` is live-only, so prompting
   * before subscribing throws away the beginning of the round. Everything here is what has
   * to be true *before* a prompt is a defensible thing to send: the directory is gated, the
   * session exists in it, a credential is bound to the round's fence, and our endpoint is
   * registered under that credential.
   *
   * **3. The directory, through `gatedRoleDirectory` and no other way.**
   * `ensurePlanningDirectory` hands back an opaque `UngatedRoleDirectory`, and the single
   * conversion installs the policy gate and runs both containment checks before branding
   * the path `GatedDirectory`. A session created in a directory obtained any other way
   * would defeat slice 3 entirely. {@link createPlannerSession} is what makes that a
   * compile error rather than a convention: `AgentHarness.createSession` takes a plain
   * `string`, so the brand constrains nothing on its own — it had to be narrowed at a call
   * site to mean anything, and it is.
   *
   * **4. The session, under the goal's lineage.** One planner conversation per goal is one
   * session lineage plus N round records, so a goal that has a lineage gets this round's
   * session parented onto it (provider prompt caching, which is all `parentSessionId` is
   * for) and a goal that has none records this one as its first. The id the harness returns
   * is compared against the one it was handed, and a harness that ignored it is rebound
   * through `bindSessionToRound` with a warning — into `session.id` as well, so the
   * finalizer settles against the session that exists rather than the one we asked for.
   *
   * **5. The credential, then the registration.** In that order and both in this scope, so
   * the grant is revoked and the entry removed when the fiber ends — on success, failure,
   * interruption and shutdown.
   */
  const prepareRound = Effect.fnUntraced(function* (
    input: PlanInput,
    ids: { readonly roundId: string },
    opened: {
      readonly store: ObservationStore["Service"];
      readonly model: string;
      readonly authority: { readonly writeFence: number };
    },
    /**
     * The session this round is on, as a mutable holder.
     *
     * A holder rather than a return value because {@link supervise}'s finalizer closes over
     * it and may run *during* this function — the rebind below and every failure after it
     * have to leave the finalizer looking at the session that actually exists. Same shape
     * and same reason as the `narrated` report.
     */
    session: { id: string },
  ) {
    const harness = yield* AgentHarness;
    const urls = yield* endpoints.urls;
    const store = opened.store;

    /**
     * The round's own directory, made and gated in that order, or the round is refused.
     *
     * The gate goes into a directory where the planner is not expected to act, and that is
     * the point rather than an oversight: "the planner does not run shell commands" is an
     * assumption about what a model will choose to do, and the gate is what turns it into
     * a fact. `policy/install.ts` carries the long form, including why the audit path is
     * refused if it is inside this directory.
     */
    const planning: GatedDirectory = yield* gatedRoleDirectory({
      ensure: fleet.ensurePlanningDirectory(input.targetId, ids.roundId),
      install: harness.installGate,
      policyUrl: urls.policy,
      auditPath: input.auditPath,
      // The workspace is passed so the containment check can run, not because the round
      // goes anywhere near it. `undefined` says this target has no folder, which is a
      // statement rather than an omission; see {@link PlanInput.workspace}.
      workspace: input.workspace,
    });

    const lineageBefore = yield* store.plannerLineage(input.goalId);
    // Through the narrowed wrapper, which is the one call in this file that will not take
    // an ungated path. See step 3 on this function.
    const created = yield* createPlannerSession(harness, {
      title: input.title,
      model: opened.model,
      directory: planning,
      sessionId: session.id,
      ...(lineageBefore === undefined
        ? {}
        : { parentSessionId: lineageBefore }),
    });
    if (created.id !== session.id) {
      yield* Effect.logWarning(
        "the harness did not honour the session id it was handed; rebinding the round to the id it chose",
        { asked: session.id, got: created.id },
      );
      yield* store.bindSessionToRound(ids.roundId, created.id);
      session.id = created.id;
    }
    if (lineageBefore === undefined) {
      // The goal's first round, so this session becomes the lineage later rounds are
      // opened under. Recorded only when there is none: replacing a lineage is what a
      // caller does when the harness has forgotten the session it names, and confirming
      // that is slice 9's, not ours (`store.plannerLineage`: "a hint, not a fact").
      yield* store.recordPlannerLineage(input.goalId, created.id);
    }

    const credential = yield* credentials.issue({
      // A planner round, said rather than implied: the registry takes a tagged binding, so
      // this call site has to name which kind of authority it is minting and cannot
      // produce an attempt's or a goal's by leaving a field out.
      _tag: "round",
      targetId: input.targetId,
      goalId: input.goalId,
      roundId: ids.roundId,
      // Authority as of now. If the sweep supersedes this round while the planner is out,
      // the credential stops working even though the registry still holds it.
      roundFence: opened.authority.writeFence,
    });

    // One builder; see `run/supervisor.ts`'s call and `mcpToolName.ts`.
    const serverName = bitMcpServerName(ids.roundId);
    // An `acquireRelease`, so the registration is taken away when this scope closes — the
    // same scope that revokes the credential, and for the same reason: a revoked credential
    // that leaves a registration behind is an entry that still reads as connected
    // (DECISIONS.md §24.2, caveat 3). A round's directory is its own, so the entry goes
    // with the round rather than accumulating the way the shared workspace's do.
    //
    // The release cannot fail the round. Tidy-up that reported an outcome would make a
    // settled round look unsettled.
    yield* Effect.acquireRelease(
      harness.registerMcpServer(created.id, serverName, {
        // The **planner** endpoint, not the worker's. This is the line that decides which
        // tool list this session is offered: `mcp/server.ts` serves one toolkit per path,
        // and each endpoint's middleware refuses a resolved grant whose tag is not the role
        // it serves. So a round registered against `urls.mcp` would get a `401` on
        // `tools/list` — before any tool list is produced — and would have no tools at all
        // rather than the wrong ones. `server.test.ts` asserts that refusal.
        url: urls.plannerMcp,
        // Unwrapped and immediately re-wrapped: the one place the raw token is touched, to
        // put it in the header of the one request that delivers it. It never reaches the
        // harness's argv or the environment a shell would inherit (DECISIONS.md §6).
        headers: {
          authorization: Redacted.make(
            `Bearer ${Redacted.value(credential.token)}`,
          ),
        },
        // The same branded value `createPlannerSession` was given. The registration seam
        // takes a plain `string`, so this one is a convention rather than a type — it is
        // the same local, which is as much as can be said without widening `McpRegistration`.
        directory: planning,
      }),
      () =>
        harness.unregisterMcpServer(created.id, serverName).pipe(
          Effect.catch((failure) =>
            Effect.logWarning(
              "a harness would not take back a round's MCP registration; the credential behind it is revoked either way",
              {
                roundId: ids.roundId,
                server: serverName,
                detail: failure.message,
              },
            ),
          ),
        ),
    );

    return {
      planning,
      lineage:
        lineageBefore === undefined
          ? ("opened" as const)
          : ("continued" as const),
    };
  });

  /**
   * Reads one round's narration until it is interrupted or the stream dies.
   *
   * Runs as a child fiber of the round's supervisor and is **not** what decides the
   * outcome. It records any terminal `session.execution.*` it sees into `report.narrated`,
   * which `roundSettlementFor` ranks second behind `session.get`, for the reasons
   * `run/supervisor.ts`'s `narrateSession` sets out: `event.subscribe()` is live-only, so
   * a terminal event landing in the subscription window would leave the round with none —
   * and because the stream does not end when a session settles, taking settlement from
   * here would hang rather than answer wrongly.
   *
   * **It publishes onto `run/narration.ts`'s bus, under the round.** It used to publish
   * nothing, because that bus's subject was an attempt id and a round has no attempt; the
   * planner view is the screen that made widening it worth doing, and the subject is now
   * tagged. The entries are keyed by this round, not by the goal: a goal's narration is
   * several rounds' worth and the chat groups them by round, which is the only grouping
   * the records can corroborate after a reload.
   *
   * **Publishing is not persisting.** An entry published with nobody listening is gone,
   * and a reload replays from the harness instead (`plan/roundNarration.ts`). The durable
   * record of a round is still its two events.
   *
   * A failure here is logged and nothing more. The stream breaking is not an outcome, and
   * the supervisor that outlives it still settles from the wait and from `session.get`.
   */
  const narrateRound = Effect.fnUntraced(function* (
    roundId: string,
    targetId: string,
    harnessSessionId: string,
    report: { narrated: TerminalOutcome | undefined },
  ) {
    const harness = yield* AgentHarness;
    const outcome = yield* Effect.result(
      Stream.runForEach(harness.sessionEvents(harnessSessionId), (entry) =>
        Effect.andThen(
          narrations.publish({
            targetId,
            subject: { _tag: "round", roundId },
            harnessSessionId,
            entry,
          }),
          Effect.sync(() => {
            if (entry.outcome !== undefined) report.narrated = entry.outcome;
          }),
        ),
      ),
    );
    if (outcome._tag === "Failure") {
      yield* Effect.logWarning(
        "a round's narration stream ended; this says nothing about the session and the round is still settled from the harness's own answer",
        { roundId, harnessSessionId, detail: outcome.failure.message },
      );
    }
  });

  /**
   * Reconcile, settle, supersede, revoke — in that order, and the order is load-bearing.
   *
   * The harness is asked **before** the transaction opens, because `settleRound` takes
   * SQLite's single write lock and an HTTP round trip inside it would hold that lock for
   * the length of someone else's network. `recovery/reconcile.ts` states the same rule for
   * the same reason.
   *
   * Authority is revoked **after** the status has moved, in both its halves: the durable
   * fence (`supersedeRound`) and the in-memory grants (`revokeRound`). Revoking first
   * would open a window where the credential is gone and the row still says the round may
   * write, which is the wrong way round — a planner refused `unauthorized` while the row
   * says `running` cannot tell a settled round from a broken server.
   *
   * **A round that cannot be settled honestly settles `uncertain`, never `failed`**, which
   * is `roundSettlementFor`'s rule and not this function's; there is no `failed` in a
   * round's vocabulary to reach for.
   */
  const settle = Effect.fnUntraced(function* (
    store: ObservationStore["Service"],
    input: {
      readonly roundId: string;
      readonly targetId: string;
      readonly harnessSessionId: string;
      readonly end: SupervisionEnd;
      readonly narrated: TerminalOutcome | undefined;
    },
  ) {
    const harness = yield* AgentHarness;
    // Best effort, bounded, and outside any transaction. A failure here is not an outcome;
    // it means the harness's own view is unavailable, which `roundSettlementFor` reads as
    // "no answer" and resolves from the narration, or to `uncertain`.
    const asked = yield* Effect.result(
      Effect.timeout(harness.sessionStatus(input.harnessSessionId), askTimeout),
    );
    const harnessSaid =
      asked._tag === "Success" ? asked.success.outcome : undefined;
    const status = roundSettlementFor({
      end: input.end,
      narrated: input.narrated,
      harness: harnessSaid,
    });

    const settlement = yield* Effect.result(
      // `supervisor`, because this one watched the round: the sweep passes `recovery` plus
      // the harness answer it got, and the `plan.round.settled` event keeps them apart.
      // There is nothing to put in `observed` here — this path's sources are a
      // `TerminalOutcome` and an interruption we caused, not a harness observation — which
      // is why `RoundSettler` is tagged rather than a string beside an optional field.
      store.settleRound(input.roundId, status, { _tag: "supervisor" }),
    );
    /**
     * The fence, moved only when this call is the one that settled the round.
     *
     * **What it is and is not for, because the honest version is narrower than it looks.**
     * `checkRoundAuthority` already refuses a credential whose round is not `running`, so
     * the status change above is what stops the planner writing, and this is not the thing
     * that does it. What it buys is that the column means one thing whichever writer
     * settled the round: `recovery/reconcile.ts` moves it too, and a reader who saw `0` on
     * a cleanly settled round and `1` on a swept one would have to know which path wrote
     * the row before the number meant anything.
     *
     * Guarded on `changed` for the reason that is the guard's own: `changed: false` means
     * somebody else settled this round between the read and now — a sweep, in practice —
     * and bumping then would move a fence for a round whose accounting is already done.
     */
    const fence =
      settlement._tag === "Success" && settlement.success.changed
        ? yield* Effect.result(store.supersedeRound(input.roundId))
        : undefined;
    const grants = yield* credentials.revokeRound(input.roundId);

    /**
     * Whether this round's session ever reached its own tool surface.
     *
     * **This is the one place the per-scope tally is read, and it is read on every
     * settlement path** — a natural finish, a stop, a shutdown and a start that failed all
     * come through here. The scope is derived the same way the credential's was
     * (`callerScopeOf`), so the number is this round's requests and nobody else's.
     *
     * It exists because of a measured condition with no other symptom. DECISIONS.md §24.2
     * caveat 1: an OpenCode MCP registration can be connected and **not yet callable** —
     * the tool registry reloads behind a lock and a debounce, and in 3 of 8 first prompts
     * after a registration the model reported the tool was not exposed and the endpoint saw
     * no call — and there is no API to read that registry, so the round cannot confirm
     * exposure before prompting and the prompt is never resubmitted. A round that never had
     * its tools therefore settles exactly like a round that had them and chose to say
     * nothing: `settled`, `disposition: null`. **Zero requests is what tells them apart.**
     *
     * **Where it goes, said precisely: the log line below, and `PlanRoundStopped` for a
     * stop. It does not reach the durable record.** `plan.round.settled`'s payload is
     * written by `store.settleRound`, which takes a status and a settler and nothing else;
     * putting the figure there would mean widening that signature and the event shape, and
     * the tally is in-process memory anyway — a restart forgets it, so a durable field
     * would be null for every round a sweep settles. So the distinction is available to an
     * operator reading logs at the moment it matters, and is **not** recoverable
     * afterwards from the rows. That is the honest extent of it.
     */
    const roundScope = callerScopeOf({
      _tag: "round",
      targetId: input.targetId,
      roundId: input.roundId,
    });
    const toolCallsSeen = yield* calls.countFor(roundScope);
    /**
     * The row, read back for its disposition, so the zero case can be reported as the
     * thing it actually is.
     *
     * One statement, once per round, outside any transaction. `settleRound` does not
     * answer with the disposition — it answers with the status change — and "settled with
     * no disposition **and** no tool calls" is the conjunction worth a warning. A read that
     * fails leaves `disposition` unknown, and an unknown disposition is not warned about:
     * a warning about a round whose row could not be read would be a claim nobody checked.
     */
    const row = yield* Effect.result(store.loadRound(input.roundId));
    const disposition =
      row._tag === "Success" && row.success !== undefined
        ? row.success.disposition
        : undefined;
    if (toolCallsSeen === 0 && disposition === null) {
      yield* Effect.logWarning(
        "a planner round settled having concluded nothing and having made no authenticated tool call: its tool surface was never reached, so this is not a planner with nothing to say",
        {
          roundId: input.roundId,
          callerScope: roundScope,
          harnessSessionId: input.harnessSessionId,
          status,
          // Named so an operator reading this line once has the reference without
          // grepping for it.
          cause:
            "DECISIONS.md §24.2 caveat 1: an OpenCode registration can be connected and not yet callable. Open another round on this goal.",
        },
      );
    }

    if (settlement._tag === "Failure") {
      // The row could not be written, so the round is left `running` with its authority
      // revoked in memory only. That is exactly the state the startup sweep exists for,
      // and saying so here is the difference between a gap and a known handover.
      yield* Effect.logError(
        "a round could not be settled; its row is left for the startup sweep to reconcile",
        {
          roundId: input.roundId,
          wanted: status,
          detail: settlement.failure.message,
        },
      );
    }
    yield* Effect.logInfo("a planner round settled", {
      roundId: input.roundId,
      harnessSessionId: input.harnessSessionId,
      end: renderEnd(input.end),
      harnessSaid: harnessSaid ?? "nothing definite",
      narrationSaid: input.narrated ?? "nothing definite",
      status,
      changed:
        settlement._tag === "Success" ? settlement.success.changed : "unknown",
      fenceNow:
        fence === undefined
          ? "unchanged"
          : fence._tag === "Success"
            ? (fence.success ?? "no row")
            : "unknown",
      grantsRevoked: grants,
      // Zero is the Spike B condition; the warning above says so when it coincides with no
      // disposition. Carried on every settled line either way, because the figure is only
      // useful if it is there before anybody suspects they need it.
      toolCallsSeen,
    });
    return { status, grants, toolCallsSeen };
  });

  /**
   * One supervised round, start to settlement, as the fiber sees it.
   *
   * `Effect.scoped` around the whole body is what makes the credential's lifetime the
   * round's, and `Effect.addFinalizer` rather than a step at the end of the happy path is
   * what makes the settlement happen on every exit — success, failure, and the interruption
   * {@link PlanSupervisor.stop} and a shutdown both cause. Finalizers run uninterruptibly,
   * so a stop cannot interrupt the settlement it asked for.
   *
   * ## Two finalizers, one body, and why it is not one finalizer
   *
   * The round is concluded by {@link conclude}, which is registered **twice** and guarded
   * so it acts once. That is not belt-and-braces; it is the only arrangement that satisfies
   * two requirements that pull against each other, and both are requirements this file
   * already states elsewhere.
   *
   * 1. **Everything after the row exists must be covered.** `openRoundRow` writes the row
   *    as its last step and every step of `prepareRound` can fail. Registered after the
   *    whole start half — which is how this was first written — a gate, session, credential
   *    or registration failure left the row `running` with no `plan.round.settled`, and a
   *    goal `openRound` would refuse every later round on until the process restarted. A
   *    review proved that with a scripted-failure probe.
   * 2. **On the paths that matter, the settlement must run before the credential's own
   *    release.** `credentials.issue` and `registerMcpServer` are `acquireRelease`s in this
   *    scope, and scope finalizers run in reverse acquisition order. So a single finalizer
   *    registered *early* would run **after** the grant was revoked and the registration
   *    removed — which is the window `settle` explicitly argues against: a credential gone
   *    while the row still says the round may write, and a `stop` reporting
   *    `credentialsRevoked: 0` because the scope had already taken them.
   *
   * The second registration, after `prepareRound`, is therefore the one that fires on every
   * path where the round really started — stop, shutdown, natural settlement — and because
   * it was acquired last it runs first, before the credential goes. The first registration
   * is the net: it runs last, finds `concluded` already true on those paths, and acts only
   * when `prepareRound` failed and the later registration never happened. On *that* path
   * the ordering is reversed and that is acceptable, said rather than glossed: nothing is
   * running to be refused, and `revokeRound` returning 0 because the scope got there first
   * is accurate rather than a lost count.
   *
   * **The one window a `running` row can still survive this process**, stated so that no
   * comment elsewhere has to guess at it: the stretch between `openRound` committing and
   * the first `addFinalizer` being reached. An interruption delivered in there — a
   * `SIGINT` landing in those few ops — leaves the row with nothing registered to settle
   * it, and the startup sweep is what reconciles it. Closing that would mean making the
   * stretch `Effect.uninterruptible`, which is a restructure this slice is not taking;
   * `PlanRefused`'s reasons and the `ensuring` detail below both name this window rather
   * than claiming the sweep is the general answer.
   *
   * ## Defects
   *
   * A defect anywhere in the body is caught by the guard at the bottom of the generator,
   * which records `crashed` so the round settles `uncertain` instead of inheriting
   * `stopped`. That guard is one place rather than one per statement, and the reasoning is
   * on it and on `SupervisionEnd`'s `crashed` case.
   *
   * `resolved` is where the one harness comes in, and it comes in once:
   * `Effect.provideService` at the bottom hands this round's instance to the whole body,
   * so no step below has a second harness-shaped value in reach.
   */
  const supervise = (
    input: PlanInput,
    ids: { readonly roundId: string },
    gate: Deferred.Deferred<PlanRoundStarted, PlanRefused>,
    resolved: ResolvedHarness,
    /**
     * The prompt, already assembled, and the two lengths that describe it.
     *
     * Passed in rather than built here because it is built before the goal is claimed —
     * see {@link start} on why a briefing over the ceiling has to leave no row behind.
     */
    assembled: AssembledRoundPrompt,
  ) => {
    /**
     * What the finalizer will settle from, if the wait never gets to say.
     *
     * `stopped` is the right default for the *watching* part of the body below: the only
     * expected way out of that without the wait returning is an interruption, and the only
     * thing that interrupts this fiber is a stop or the process's scope closing — both of
     * which are us stopping the round. The paths that leave before the round is being
     * watched set `startFailed` explicitly, which is what keeps them out of the
     * `interrupted` bucket: nobody interrupted anything.
     *
     * **Declared out here, one per call, so the defect guard below can reach it.** That
     * guard is the reason this is not a `let` inside the generator any more; see it for
     * what it is for.
     */
    let ending: SupervisionEnd = { _tag: "stopped" };
    return Effect.scoped(
      Effect.gen(function* () {
        /**
         * The row first, and on its own.
         *
         * A failure here is the only one that writes nothing at all — an ended goal, a
         * goal of another target, a second running round, a database that will not open —
         * so it is also the only one that needs no finalizer. The goal claim is given back
         * by this function's own `ensuring`.
         */
        const opened = yield* Effect.result(openRoundRow(input, ids));
        if (opened._tag === "Failure") {
          yield* Deferred.fail(gate, refuse(opened.failure));
          return;
        }

        const { store, provenance, authority } = opened.success;
        const startedAt = Date.now();
        /**
         * The session this round is on, as a mutable holder shared with the finalizer.
         *
         * Mutable because `prepareRound` rebinds it if the harness refuses the id it was
         * handed, and the finalizer has to settle against the session that exists rather
         * than the one we asked for. It is read only after this fiber has stopped.
         */
        const session = { id: opened.success.harnessSessionId };

        /**
         * Where the narration fiber leaves a terminal outcome it saw.
         *
         * A mutable record shared with a child fiber rather than a `Ref`: the only writer
         * is that fiber and the only reader is this one's finalizer, after it has been
         * interrupted.
         */
        const report: { narrated: TerminalOutcome | undefined } = {
          narrated: undefined,
        };

        /**
         * Whether the round has been concluded, so that two registrations act once.
         *
         * A plain flag rather than a `Ref`: finalizers in one scope run sequentially on one
         * fiber, so there is no contention to protect against. See this function's header
         * for why there are two registrations at all.
         */
        let concluded = false;
        const conclude = Effect.suspend(() => {
          if (concluded) return Effect.void;
          concluded = true;
          return Effect.gen(function* () {
            supervised.delete(ids.roundId);
            // Given back here rather than in `start`, because the claim has to outlive the
            // request: it is held for as long as a planner is working that goal, and this
            // finalizer runs on every exit. The *durable* half of the claim is released by
            // the settlement below moving the row out of `running`.
            yield* releaseGoal(input.goalId, ids.roundId);
            // Only when we are the reason it is over. A session that reported its own
            // outcome has already stopped, and asking it to stop again would be a
            // pointless round trip on every clean round.
            if (ending._tag === "stopped") {
              const harness = yield* AgentHarness;
              const interrupted = yield* Effect.result(
                // Bounded for the reason the `sessionStatus` ask in `settle` is: this also
                // runs in a finalizer, and a dying harness answers neither.
                Effect.timeout(
                  harness.interruptSession(session.id),
                  askTimeout,
                ),
              );
              yield* Effect.logInfo(
                "asked the harness to interrupt a planner session",
                {
                  roundId: ids.roundId,
                  harnessSessionId: session.id,
                  // A refusal here is reported, not acted on: the round's authority is
                  // revoked below either way, so a session we could not reach cannot
                  // record anything even if it carries on working.
                  harnessInterrupted:
                    interrupted._tag === "Success"
                      ? interrupted.success
                      : `could not ask: ${interrupted.failure.message}`,
                },
              );
            }
            const settled = yield* settle(store, {
              roundId: ids.roundId,
              targetId: input.targetId,
              harnessSessionId: session.id,
              end: ending,
              narrated: report.narrated,
            });
            remember(ids.roundId, settled);
          });
        });

        // The net. Registered first, so it runs *last*, and guarded so it does nothing on
        // every path where the registration below already concluded the round. Its one job
        // is the strand described in this function's header.
        yield* Effect.addFinalizer(() => conclude);

        /**
         * The rest of the start, now that something will settle the row whatever it does.
         *
         * A failure is `startFailed`, so the finalizer settles the round `uncertain` — not
         * `interrupted`, because nobody interrupted anything, and never `failed`, which a
         * round has no word for. The goal is given back in the same finalizer, so the next
         * round on it is accepted rather than refused `round_conflict` by a row nothing is
         * driving.
         */
        const prepared = yield* Effect.result(
          prepareRound(input, ids, opened.success, session),
        );
        if (prepared._tag === "Failure") {
          ending = { _tag: "startFailed" };
          yield* Deferred.fail(gate, refuse(prepared.failure));
          return;
        }
        const { lineage } = prepared.success;
        const harnessSessionId = session.id;

        // The real one. Registered *after* the credential and the registration were
        // acquired, so it runs before their releases and the settlement precedes the
        // revocation — see requirement 2 in this function's header.
        yield* Effect.addFinalizer(() => conclude);

        const started: PlanRoundStarted = {
          roundId: ids.roundId,
          targetId: input.targetId,
          goalId: input.goalId,
          harnessSessionId,
          instanceId: resolved.instance.instanceId,
          providerId: provenance.providerId,
          modelId: provenance.modelId,
          budget,
          startedAtSequence: authority.startedAtSequence,
          lineage,
          // Measured on the string that was actually sent, not computed from the ceiling.
          // See `plan/roundPrompt.ts`: the briefing is what the ceiling bounds and the
          // prompt is what the model received, and the two are different numbers.
          briefingChars: assembled.briefingChars,
          promptChars: assembled.promptChars,
          startedAt,
        };
        supervised.set(ids.roundId, {
          roundId: ids.roundId,
          targetId: input.targetId,
          goalId: input.goalId,
          harnessSessionId,
          startedAt,
        });
        // Subscribed before prompted, which is the whole reason the prompt is here and not
        // in `prepareRound`. `event.subscribe()` replays nothing, so a terminal event
        // published before the subscription exists is one nobody will ever see. A child
        // fiber rather than one in the map: it belongs to this round and is interrupted
        // with it.
        const narrator = yield* Effect.forkChild(
          narrateRound(ids.roundId, input.targetId, harnessSessionId, report),
        );

        const harness = yield* AgentHarness;
        const prompted = yield* Effect.result(
          harness.prompt(harnessSessionId, assembled.prompt),
        );
        if (prompted._tag === "Failure") {
          // Nothing ran. The round row exists and is `running`, so the honest thing is to
          // let the finalizer settle it rather than leaving it for a sweep — and
          // `startFailed` is what keeps that settlement out of the `interrupted` bucket,
          // because nobody interrupted anything.
          ending = { _tag: "startFailed" };
          yield* Deferred.fail(gate, refuse(prompted.failure));
          return;
        }

        // The request is let go here, and not before: everything above had to succeed for
        // the round to be a real, authorised, prompted round.
        yield* Deferred.succeed(gate, started);

        /**
         * The long poll the harness answers when the session stops running.
         *
         * This is what says the round is over, and the narration stream is what says what
         * happened along the way. A failure here is **not** a failed round: it means our
         * request lost its answer, which says nothing about the harness, and it resolves
         * through `session.get` or to `uncertain` (DECISIONS.md §15). **The prompt is never
         * resubmitted**, on this path or any other.
         */
        const waited = yield* Effect.result(
          harness.waitForIdle(harnessSessionId),
        );
        ending =
          waited._tag === "Failure"
            ? { _tag: "waitFailed", detail: waited.failure.message }
            : { _tag: "waited" };

        // The session is no longer running, so there is nothing left to narrate. Stopping
        // the fiber here rather than leaving it to the scope means `report.narrated` is
        // final by the time the finalizer reads it.
        yield* Fiber.interrupt(narrator);
      }).pipe(
        /**
         * A defect anywhere in the body above must not be recorded as an interruption.
         *
         * **This is one guard for the whole body rather than one per statement, and that is
         * the point.** The body wraps the failures it expects in `Effect.result`, which
         * absorbs *typed* failures and not defects — so a thrown `TypeError` in a seam, or
         * an `Effect.die`, propagates straight out, the scope closes, and the finalizer
         * settles from whatever `ending` holds. That default is `stopped`, so a crash was
         * being written down as `interrupted`: a durable claim that somebody stopped this
         * round when nobody did, and `interrupted` is the one status this file says is
         * first-hand. A review caught it; `SupervisionEnd`'s `crashed` case carries the
         * long form.
         *
         * **Interrupts are re-raised untouched**, which is why the predicate is
         * `hasInterruptsOnly` rather than "is there a defect". A stop and a shutdown both
         * arrive as interruptions and `stopped` is correct for them; a cause carrying a
         * defect *and* an interrupt is a crash we then interrupted, and `uncertain` is the
         * honest answer for it.
         *
         * The cause is **re-raised either way.** Swallowing it would hide a bug: the fiber
         * should die, `tapCause` below should log it, and the `ensuring` that completes the
         * gate should answer the caller. All this does is correct the record on the way out.
         */
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.andThen(
                Effect.sync(() => {
                  ending = { _tag: "crashed", detail: Cause.pretty(cause) };
                }),
                Effect.failCause(cause),
              ),
        ),
      ),
    ).pipe(
      Effect.tapCause((cause) =>
        Effect.logError("a planner round supervisor ended abnormally", {
          roundId: ids.roundId,
          cause,
        }),
      ),
      // The gate is completed on every successful path above. This covers the one path
      // that is not: an interruption or a defect during the start half, where the caller
      // would otherwise wait on a deferred nothing will ever complete. Completing an
      // already-completed deferred is a no-op that returns `false`, so this cannot
      // overwrite a real answer.
      Effect.ensuring(
        Deferred.fail(
          gate,
          new PlanRefused({
            reason: "store_unavailable",
            detail:
              "the round was torn down before it started and nothing was prompted. Its row, if one was written, has been settled 'uncertain' by the round's own finalizer — unless this process was interrupted in the moment between that row being committed and the finalizer being registered, which is the one window a 'running' row can survive this process, and the startup sweep is what reconciles that.",
          }),
        ),
      ),
      // The goal claim, for the one path the body never reached — where the finalizer above
      // never ran. Idempotent, and it cannot free a claim a later round has taken.
      Effect.ensuring(releaseGoal(input.goalId, ids.roundId)),
      // The one harness this round was resolved to, handed to everything above. Provided
      // here rather than passed down, so no step has a second harness-shaped value in
      // reach.
      Effect.provideService(AgentHarness, resolved.harness),
    );
  };

  const start: PlanSupervisor["Service"]["start"] = Effect.fn(
    "PlanSupervisor.start",
  )(function* (input) {
    const roundId = identifier.newRoundId();

    /**
     * Wait for the endpoints **before** claiming the goal.
     *
     * A weaker reason than the one on `RunSupervisor.start`'s matching line, and worth
     * separating from it. There, waiting after the claim would let `releaseOrphanedClaims`
     * take a live start's intent claim out from under it, because a durable claim with no
     * attempt row is indistinguishable from an orphan. A round's claim has no such hazard:
     * the in-process half is this map and the sweep cannot see it, and the durable half is
     * the row, which the sweep only settles when the harness says the session is not
     * running. So this is housekeeping rather than safety — a start that parked while
     * holding a goal would block every other round on that goal for the length of a boot,
     * and the wait costs nothing that was not already paid (`prepareRound` awaits the same
     * `Deferred`, so every later read is immediate).
     */
    yield* endpoints.urls;

    /**
     * Which harness this round gets, decided **before** anything is claimed or written.
     *
     * First, so a round naming an instance this server cannot give it leaves nothing
     * behind: no goal claimed, no row, no directory. An explicit pick that cannot be had is
     * refused `harness_not_ready` naming the instance, and never falls back — the round row
     * records which instance ran it, and quietly substituting another would make that
     * record wrong. There is no suggestion tier; see {@link PlanInput.instanceId}.
     */
    const chosen = yield* Effect.result(resolver.resolve(input.instanceId));
    if (chosen._tag === "Failure") return yield* refuse(chosen.failure);
    const resolved = chosen.success;

    /**
     * The prompt, assembled **before** the goal is claimed and before any row is written.
     *
     * The ordering is the requirement: a briefing over the ceiling must refuse the round
     * and **start nothing**. Built here, a refusal leaves no `planner_rounds` row, no
     * claimed goal, no planning directory and no harness session — there is nothing for a
     * sweep to find and nothing blocking the next round on this goal. Built inside
     * `supervise`, as every other step is, the row would already exist.
     *
     * It costs a read of the whole goal before the claim, which is the trade: another
     * round could claim the goal while this one is rendering. That is a race the claim
     * below resolves by refusing `goal_busy`, and the loser has still written nothing.
     *
     * **A missing goal surfaces as `goal_not_found` from here rather than from
     * `openRound`.** The briefing builder resolves the goal id against the target's own
     * file and answers `unknown_goal`, which is the same fact `openRound`'s `unauthorized`
     * reports a moment later, so it is mapped to the same refusal with the same shape of
     * sentence. An *ended* goal still reaches `openRound`, which is the authoritative
     * refusal for it: the briefing is perfectly renderable for a goal that is over.
     *
     * `GoalBriefingTooLarge` is **not** mapped into {@link PlanRefused}. It carries two
     * numbers that no reason on that error has a place for, and it is already the error
     * the goal-briefing route turns into the `GoalBriefingRefused` the panel renders — so
     * the plan route turns it into the same one, and an operator sees one refusal for one
     * fact whichever surface they hit it on.
     */
    const prepared = yield* Effect.result(
      stores.open(input.targetId).pipe(
        Effect.flatMap((store) =>
          buildGoalBriefing(
            input.goalId,
            input.briefingMaxChars ?? DEFAULT_GOAL_BRIEFING_MAX_CHARS,
          ).pipe(Effect.provideService(ObservationStore, store)),
        ),
        Effect.scoped,
      ),
    );
    if (prepared._tag === "Failure") {
      const failure = prepared.failure;
      if (failure._tag === "GoalBriefingTooLarge") return yield* failure;
      if (failure._tag === "GoalBriefingError") {
        return yield* new PlanRefused({
          reason: "goal_not_found",
          detail: `no goal ${input.goalId} is recorded in target ${input.targetId}, so there is nothing to plan`,
        });
      }
      return yield* refuse(failure);
    }
    const assembled = assembleRoundPrompt({
      goalId: input.goalId,
      budget,
      briefing: prepared.success.rendered,
    });

    /**
     * Made **before** the claim, which narrows the window rather than closing it.
     *
     * With the deferred already in hand there is no `yield*` between the claim and the
     * fork, so this is strictly tighter than `RunSupervisor.start`, which does yield at its
     * own `Deferred.make` between claiming a workspace and forking. **It is not an atomicity
     * guarantee, and an earlier version of this comment claimed it was.** Effect 4.0.5's
     * `runLoop` checks `_deferredInterrupt` at the top of every iteration and may insert a
     * `yieldNow` between any two ops when the scheduler asks for one, so the resumption
     * after `goalClaim`'s `Effect.sync` is itself an interruptible boundary. A caller
     * interrupted there — an HTTP handler whose client disconnected, once slice 7 gives this
     * a route — would have claimed the goal and never forked the fiber whose `ensuring`
     * gives it back.
     *
     * So the window is closed by {@link handedOver} and the `ensuring` at the bottom, which
     * is `RunSupervisor`'s pattern and is here for the same reason it is there. What the
     * ordering above still buys is that the window is as small as this runtime allows.
     *
     * Why it is worth three lines for an in-memory map: a leaked goal claim is
     * **unrecoverable while the process lives**. Nothing sweeps `claimedGoals`, and
     * `releaseGoal` is keyed by a round id that no longer exists anywhere, so the goal
     * would take no further rounds until a restart.
     */
    const gate = yield* Deferred.make<PlanRoundStarted, PlanRefused>();

    /**
     * Whether the fiber that owns the claim exists yet.
     *
     * False until `fork` has returned. Until then the `ensuring` below is what releases the
     * goal; after it, the fiber's own finalizer and `ensuring` do. The two cannot both act:
     * `releaseGoal` only releases a claim held by *this* round id.
     */
    let handedOver = false;

    return yield* Effect.gen(function* () {
      /**
       * The goal, claimed synchronously, immediately before the fork.
       *
       * The reasoning is on {@link claimedGoals}. Refusing here means a second concurrent
       * round on one goal writes *nothing at all* — no row, no directory, nothing for a
       * sweep to find — and it is refused naming the round that holds it.
       */
      const busy = yield* goalClaim(input.goalId, {
        roundId,
        targetId: input.targetId,
      });
      // The `ensuring` below fires for this path too and does nothing, because the claim it
      // would release is the winner's and is keyed to the winner's round id.
      if (busy !== undefined) return yield* busy;

      // Forked, not run: this is the line that detaches the round from the caller. The
      // fiber is a daemon of the layer's scope rather than a child of this fiber, so
      // answering the caller cannot interrupt it.
      const fiber = fork(
        roundId,
        supervise(input, { roundId }, gate, resolved, assembled),
      );
      handedOver = true;
      /**
       * Wait for the gate, but never longer than the fiber lives.
       *
       * `supervise`'s own `ensuring` completes the gate on every path its body reaches, so in
       * normal operation the first branch wins immediately. The second exists for the one
       * path the body never reaches: a {@link FiberMap} whose scope has closed hands back an
       * already-interrupted fiber without running anything (`effect/src/FiberMap.ts`,
       * `constInterruptedFiber`), and a caller waiting on that gate would wait for the life
       * of the process.
       *
       * `Deferred.isDone` rather than letting the race decide, because the two branches
       * can become ready in the same tick when a round settles very fast.
       */
      return yield* Effect.raceFirst(
        Deferred.await(gate),
        Effect.andThen(
          Fiber.await(fiber),
          Effect.flatMap(Deferred.isDone(gate), (done) =>
            done
              ? Deferred.await(gate)
              : // The one path `supervise`'s body never reached, so its finalizer never
                // ran and the goal claim is still held. Given back here, or a
                // shutting-down server would leave the goal claimed by a round that never
                // started.
                Effect.andThen(
                  releaseGoal(input.goalId, roundId),
                  Effect.fail(
                    new PlanRefused({
                      reason: "store_unavailable",
                      detail:
                        "this server is shutting down and is no longer opening planner rounds; nothing was prompted",
                    }),
                  ),
                ),
          ),
        ),
      );
    }).pipe(
      // The claim, if no fiber ever came to own it. `Effect.suspend` so the flag is read
      // when the finalizer runs rather than when it is built, and `ensuring` so it fires on
      // a refusal, a defect and the interruption this exists for alike.
      Effect.ensuring(
        Effect.suspend(() =>
          handedOver ? Effect.void : releaseGoal(input.goalId, roundId),
        ),
      ),
    );
  });

  const stop: PlanSupervisor["Service"]["stop"] = Effect.fn(
    "PlanSupervisor.stop",
  )(function* (roundId) {
    const fiber = yield* FiberMap.get(fibers, roundId);
    if (Option.isNone(fiber)) {
      return yield* new PlanRefused({
        reason: "unknown_round",
        detail: `nothing is running under ${roundId} in this process. If its row still says 'running' it was left by a process that is gone, and the startup sweep is what settles it.`,
      });
    }
    const held = supervised.get(roundId);
    // Awaits the interruption, which awaits the finalizer, which settles the round and
    // revokes its authority. So by the time this returns, the things a stop promises have
    // happened — rather than having been scheduled.
    yield* Fiber.interrupt(fiber.value);
    const settled = settlements.get(roundId);
    return {
      roundId,
      targetId: held?.targetId ?? "",
      harnessSessionId: held?.harnessSessionId ?? "",
      // Absent only if the finalizer could not settle, which it reports in the log. The
      // response says `uncertain` there rather than claiming a status, which is the same
      // answer the row would carry.
      status: settled?.status ?? "uncertain",
      credentialsRevoked: settled?.grants ?? 0,
      // From the same `settle` call that wrote the log line, so a stop reports the figure
      // the log carries rather than re-reading a counter that has moved on.
      toolCallsSeen: settled?.toolCallsSeen ?? 0,
      stoppedAt: Date.now(),
    } satisfies PlanRoundStopped;
  });

  return PlanSupervisor.of({
    start,
    stop,
    // Returned whole rather than projected: unlike `Supervised`, this holds nothing that is
    // only the server's business — a round's goal and target are the two things a caller
    // asking "what is planning right now" wants, and there is no filesystem layout in it.
    running: Effect.sync(() => [...supervised.values()]),
  });
});
