/**
 * The goal agent's toolkit: what the operator's own conversation may do.
 *
 * Third sibling of `mcp/tools.ts` (a worker attempt's) and `mcp/plannerTools.ts` (a planner
 * round's), on a third endpoint, under a third kind of credential. The separation is not
 * tidiness: under OpenCode the directory is the authority boundary (DECISIONS.md §24.2), so
 * each role's tools live in that role's own directory under that role's own bearer, and
 * `mcp/server.ts` additionally refuses a credential whose tag is not the role an endpoint
 * serves.
 *
 * ## Eight tools, and the one that is deliberately absent
 *
 * | Tool | Writes |
 * | --- | --- |
 * | `steer_planner` | yes — delivers a directive into a live round, or opens one carrying it |
 * | `wake_planner` | yes — opens a planner round |
 * | `end_goal` | yes — ends the caller's own goal |
 * | `get_goal_briefing` | no |
 * | `list_intents` | no |
 * | `list_attempts` | no |
 * | `list_observations` | no |
 * | `list_open_questions` | no |
 *
 * **There is no `add_intent` here and there is no `record_observation`.** That is this
 * slice's first ruling and it is a containment property rather than a preference. Every
 * rule that makes an intent worth having — the round's budget, the anchoring rule, the
 * write-time duplicate join — lives inside `add_intent` on the planner endpoint
 * (`docs/design/goal-and-planner-flow.md` decision 10), and a goal agent that could write
 * one would make all three bypassable by asking politely. It steers; the planner commits.
 * `goalTools.test.ts` asserts that against the **toolkit this file exports**, not against
 * the store's refusal, because a tool the model can see and call is a tool it will describe
 * to the operator as available.
 *
 * ## Everything is scoped by the credential, including the goal
 *
 * There is no `goal_id` parameter anywhere in this file, exactly as there is none in
 * `plannerTools.ts`. The goal comes from {@link McpInvocation}, which the endpoint's auth
 * middleware builds from the presented bearer, so an agent naming another goal would be
 * describing a resource it has no way to address. `end_goal` in particular cannot reach a
 * goal other than its own, which is what makes it safe to expose at all.
 *
 * ## Refusals are results, not torn-down turns
 *
 * `failureMode: "return"` on every tool, for `plannerTools.ts`'s reason and one more: this
 * agent is **talking to a person**. A refusal it can read is a refusal it can explain —
 * "a round is already planning this goal, so I steered that one instead" is a sentence an
 * operator can act on, and a turn that died on a transport error is not.
 */
import {
  GoalEndStatus,
  FollowUpStatus,
  IntentStatus,
  PlanRefused,
  type Observation,
  type OpenQuestion,
} from "@bit/contracts";
import { Context, Effect, Layer, Schema, Semaphore } from "effect";
import { Tool, Toolkit } from "effect/ai";

import { McpInvocation } from "./invocation";
import {
  PlannerObservationWire,
  PlannerQuestionWire,
  observationWire,
  questionWire,
} from "./plannerTools";
import { openQuestionsOf } from "../briefing/briefing";
import {
  DEFAULT_GOAL_BRIEFING_MAX_CHARS,
  buildGoalBriefing,
} from "../briefing/goalBriefing";
import { derivedMessageId } from "../harness/messageId";
import { ObservationStore } from "../persistence/store";
import { TargetStores, withTargetStore } from "../persistence/targetStores";
/*
 * `PlanRefused` from the **contract** rather than from `plan/planSupervisor`, which
 * re-exports it, and the difference is not cosmetic: `run/supervisor.ts` imports
 * `McpCallCounter` from `mcp/server.ts`, which imports this file, so a *value* import of
 * anything in `plan/planSupervisor.ts` from here closes a module cycle
 * (`run/supervisor` → `mcp/server` → `mcp/goalTools` → `plan/planSupervisor` →
 * `run/supervisor`). Bun hoists the cycle and the losing module reads an uninitialised
 * const: three suites failed with `ReferenceError: Cannot access '' before
 * initialization` at the line in `run/supervisor.ts` that creates a session.
 *
 * The two imports below are type-only and erase, so they cost nothing at runtime. The rule
 * for this file is therefore: **types from `plan/`, values from `@bit/contracts`.**
 */
import type { PlanSupervisor, SteerAttempt } from "../plan/planSupervisor";
import type { RoundOpener } from "../plan/roundOpener";

/**
 * The two planning operations the goal agent's tools reach, and nothing else.
 *
 * **A narrow service of its own rather than {@link PlanSupervisor} and
 * {@link RoundOpener} themselves, and the indirection is load-bearing for the same reason
 * {@link PlannerHarnesses}' is.** This toolkit's layer is built inside
 * `HttpRouter.toWebHandler`'s own memo map (see `mcp/server.ts` and `main.ts`), so anything
 * *provided to* it is built a **second time** — and a second `PlanSupervisor` would be a
 * second `FiberMap`, a second set of goal claims and a second process-wide answer to "what
 * is running", none of which the first one would know about. `ControlPlaneEndpoint` passes
 * an already-built instance across the boundary instead, exactly as it does for
 * `TargetStores`.
 *
 * It is also the whole of what the goal agent may do to planning, in two function types: it
 * cannot stop a round, cannot read the fiber map and cannot reach a harness. A reviewer
 * checking "what can the goal agent do to the planner" reads this interface rather than the
 * supervisor's.
 */
export class GoalPlanning extends Context.Service<
  GoalPlanning,
  {
    readonly steer: PlanSupervisor["Service"]["steer"];
    readonly openRound: RoundOpener["Service"]["open"];
  }
>()("bit/mcp/GoalPlanning") {
  /**
   * A server with no agent harness, so no round can be opened and none is ever live.
   *
   * `steer` answers `noLiveRound` — true, and what makes the tool take its other branch —
   * and that branch then refuses with `no_harness`, which is where the fact belongs. The
   * same arrangement `PlanSupervisor.unavailable` makes, said once here so a build with
   * `HARNESS=0` still serves the goal endpoint's reads.
   */
  static readonly unavailable: Layer.Layer<GoalPlanning> = Layer.succeed(
    GoalPlanning,
    GoalPlanning.of({
      steer: () =>
        Effect.succeed({ _tag: "noLiveRound" } satisfies SteerAttempt),
      openRound: () =>
        Effect.fail(
          new PlanRefused({
            reason: "no_harness",
            detail:
              "this server has no agent harness, so there is nothing to run a planner round in: either the harness HARNESS names could not be started, or it was switched off with HARNESS=0",
          }),
        ),
    }),
  );
}

/* ── The refusal ─────────────────────────────────────────────────────────────── */

/**
 * A goal-agent tool call this server declined, in terms the agent can tell the operator.
 *
 * One shape across all eight tools for {@link PlannerToolRefused}'s reason: the
 * corrections do not partition by tool.
 *
 * - `goal_ended` — the goal is `met` or `abandoned`. Nothing is dispatched under it and no
 *   round is opened on it; the reads still work, because the record of a finished goal is
 *   worth reading.
 * - `planner_busy` — a round is already working this goal. One planner works a goal at a
 *   time, so the answer is to **steer that round** rather than open a second one.
 * - `briefing_too_large` — the goal's briefing is over this server's ceiling, so no round
 *   can be opened on it. The detail names both numbers; a planner is never given a
 *   shortened briefing.
 * - `harness_unavailable` — there is no agent harness, or it would not take a session, or
 *   the round's directory could not be made or gated. A round is refused rather than run
 *   ungated.
 * - `conflict` — an `operation_id` already used with different arguments, or a goal that
 *   something else ended first. Nothing was written either way.
 * - `unauthorized` — this credential is not a goal agent's, or names another goal.
 * - `unavailable` — the target's database could not be reached. Nothing was read or
 *   recorded, and this is the one reason that says nothing about what was asked for.
 */
export class GoalToolRefused extends Schema.TaggedError<GoalToolRefused>()(
  "GoalToolRefused",
  {
    reason: Schema.Literals([
      "goal_ended",
      "planner_busy",
      "briefing_too_large",
      "harness_unavailable",
      "conflict",
      "unauthorized",
      "unavailable",
    ]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `${this.reason}: ${this.detail}`;
  }
}

const refused = (
  reason: GoalToolRefused["reason"],
  detail: string,
): GoalToolRefused => new GoalToolRefused({ reason, detail });

/* ── steer_planner ───────────────────────────────────────────────────────────── */

export const STEER_PLANNER_DESCRIPTION = [
  "Tell the planner what to take into account. This is how anything the operator",
  "wants investigated actually becomes work: you do not create intents yourself.",
  "",
  "If a planner round is working this goal right now, the directive is injected into",
  "that round's own session, so it keeps everything it already has — the briefing it",
  "was given, the intents it has added, its budget. If no round is running, a new one",
  "is opened and your directive is part of the prompt it starts with. The result says",
  "which of the two happened; both are a real answer and neither needs a follow-up.",
  "",
  "urgency decides what happens to work already in flight.",
  "  queued     — the default. The round finishes the tool call or the reasoning it is",
  "               in the middle of, then takes your directive into account.",
  "  preemptive — the round's work in flight is CUT OFF. Use this only when the",
  "               operator has asked for a redirect and finishing would be wasted",
  "               effort; it has been measured to cost a round most of a multi-step",
  "               task.",
  "",
  "WHAT THIS DOES NOT DO. It does not create an intent, it does not guarantee the",
  "planner will agree with you, and it does not change the round's budget or the",
  "anchoring rule. The planner decides what to add; a directive it judges unfounded is",
  "one it may decline in its disposition, and that is a legitimate outcome to report.",
  "",
  "Say the directive in your own words, in full sentences. It is read by a model that",
  "has the goal's whole record in front of it and has never seen your conversation:",
  "'the operator says the login flow is out of scope, so drop anything about it' is",
  "actionable, 'as discussed' is not.",
  "",
  "The directive itself is NOT recorded anywhere. What is recorded is that a steer",
  "happened, with its timing, so the round's conclusion is not read as answering the",
  "question it opened with.",
  "",
  "operation_id is yours and it is the identity of one delivery. Reuse the same value to",
  "retry this call safely: a retry sends nothing a second time and answers with what that",
  "id already did, whichever of the two ways it reached the planner. A genuinely new",
  "directive needs a NEW value — the same id with different words is a retry as far as",
  "this server can tell, because the directive itself is not stored, and it will deliver",
  "nothing.",
].join("\n");

export const SteerPlannerArgs = Schema.Struct({
  operation_id: Schema.NonEmptyString.annotate({
    description:
      "Stable operation identity. An exact retry delivers nothing a second time.",
  }),
  directive: Schema.NonEmptyString.annotate({
    description:
      "What the planner should take into account, in full sentences.",
  }),
  urgency: Schema.optional(
    Schema.Literals(["queued", "preemptive"]).annotate({
      description:
        "queued (default) lets work in flight finish; preemptive cuts it off.",
    }),
  ),
});

export const SteerPlannerOutcome = Schema.Struct({
  /** The round the directive reached, whether it was live or opened for it. */
  round_id: Schema.String,
  goal_id: Schema.String,
  /**
   * Which branch was taken.
   *
   * `steered` — a round was live and the directive went into its session.
   * `opened` — no round was live, so one was opened whose prompt carries the directive.
   */
  how: Schema.Literals(["steered", "opened"]),
  urgency: Schema.Literals(["queued", "preemptive"]),
  /**
   * False when this `operation_id` had already reached the planner: nothing was sent again.
   *
   * Reachable on **both** branches, because the operation's identity is its receipt rather
   * than the message id alone: a retry replays what the id already did — whether that was a
   * steer into a live round or a round opened carrying the directive — and `how` and
   * `round_id` are the first call's answer.
   */
  delivered: Schema.Boolean,
  /**
   * Whether this operation reached the record.
   *
   * Almost always true, and it means two slightly different things per branch. On `steered`,
   * false means the directive **did** land in the round and the `plan.round.steered` event
   * could not be written, so the round's transcript will not explain its own change of
   * direction. On `opened` no event is written by design — the round was never redirected —
   * and false means the *receipt* could not be written, so **this operation id is no longer
   * safe to retry**: a second call under it would steer the round it just opened. Either way
   * it is worth telling the operator.
   */
  recorded: Schema.Boolean,
});

export const SteerPlanner = Tool.make("steer_planner", {
  description: STEER_PLANNER_DESCRIPTION,
  parameters: SteerPlannerArgs,
  success: SteerPlannerOutcome,
  failure: GoalToolRefused,
  failureMode: "return",
}).addDependency(McpInvocation);

/* ── wake_planner ────────────────────────────────────────────────────────────── */

export const WAKE_PLANNER_DESCRIPTION = [
  "Open a round of planning on this goal, with no directive attached.",
  "",
  "Use it when the operator wants work started or continued and has said nothing in",
  "particular about what to look at: the round is given the goal's whole record and",
  "decides for itself. If you do have something specific to pass on, call steer_planner",
  "instead — it opens a round too when none is running, and the round starts with your",
  "directive in front of it, which is strictly better than opening one blind and",
  "steering it a second later.",
  "",
  "ONE ROUND WORKS A GOAL AT A TIME. If one is already running this is refused with",
  "reason 'planner_busy', and the right response is steer_planner, not waiting.",
  "",
  "A round takes minutes. This returns as soon as it has started, and what it does",
  "arrives in the operator's view as it happens — you do not wait for it and you cannot",
  "read its conclusion from here. list_intents is how you see what it added.",
].join("\n");

export const WakePlannerOutcome = Schema.Struct({
  round_id: Schema.String,
  goal_id: Schema.String,
  /** How many intents this round may add. A property of the round; it cannot be raised. */
  budget: Schema.Int,
  /** Which configured harness and model are running it. */
  instance_id: Schema.String,
  model_id: Schema.String,
  /** The rendered briefing's length, so the agent can say how much the round was given. */
  briefing_chars: Schema.Int,
});

export const WakePlanner = Tool.make("wake_planner", {
  description: WAKE_PLANNER_DESCRIPTION,
  parameters: Tool.EmptyParams,
  success: WakePlannerOutcome,
  failure: GoalToolRefused,
  failureMode: "return",
}).addDependency(McpInvocation);

/* ── end_goal ────────────────────────────────────────────────────────────────── */

export const END_GOAL_DESCRIPTION = [
  "End this goal. It is one-way: an ended goal is never reopened, and a different",
  "conclusion later is a new goal.",
  "",
  "  met       — the objective is established by the evidence already recorded. Not",
  "              'we think it probably is': the observations have to support it.",
  "  abandoned — stopping without establishing it: out of scope, no longer wanted,",
  "              superseded by something else.",
  "",
  "ONLY AT THE OPERATOR'S REQUEST, or when they have agreed to it in this",
  "conversation. You are the surface they talk to, and ending their goal because you",
  "judged it finished is a decision that is theirs to make.",
  "",
  "WHAT ENDING DOES: no further work is dispatched under the goal and no later planner",
  "round is opened on it. WHAT IT DOES NOT DO: it does not stop an attempt that is",
  "already running. That work was started and may still record something; stopping it",
  "is a control the operator has and you do not.",
  "",
  "The reason is stored with the ending and is read by a person. Say what was",
  "established, or why the goal is being dropped.",
  "",
  "This also ends your own authority: the goal's credential is refused by every write",
  "after this, so end_goal is the last tool call you make. You can still talk.",
].join("\n");

export const EndGoalArgs = Schema.Struct({
  operation_id: Schema.NonEmptyString.annotate({
    description: "Stable operation identity. An exact retry replays.",
  }),
  status: GoalEndStatus.annotate({
    description: "met or abandoned. See the tool description.",
  }),
  reason: Schema.NonEmptyString.annotate({
    description:
      "Why, in your own words. Stored with the ending and read by a person.",
  }),
});

export const EndGoalOutcome = Schema.Struct({
  goal_id: Schema.String,
  status: GoalEndStatus,
  /** Always `goal_agent` from this tool: who ended it is not an argument. */
  ended_by: Schema.String,
  ended_at: Schema.Finite,
  /** True when this call replayed an earlier one rather than ending anything now. */
  replayed: Schema.Boolean,
});

export const EndGoal = Tool.make("end_goal", {
  description: END_GOAL_DESCRIPTION,
  parameters: EndGoalArgs,
  success: EndGoalOutcome,
  failure: GoalToolRefused,
  failureMode: "return",
}).addDependency(McpInvocation);

/* ── The reads ───────────────────────────────────────────────────────────────── */

export const GoalBriefingOutcome = Schema.Struct({
  goal_id: Schema.String,
  /** The goal's own objective, as the operator wrote it. */
  objective: Schema.String,
  /** The exact text a planner round is prompted with, with nothing left out. */
  rendered: Schema.String,
  /** Its length. The same figure the ceiling bounds. */
  size_chars: Schema.Int,
  /** The graph sequence it was built at. Provenance, never a snapshot guarantee. */
  prepared_at_sequence: Schema.Int,
});

export const GetGoalBriefing = Tool.make("get_goal_briefing", {
  description: [
    "The whole record of this goal, rendered exactly as a planner round is given it:",
    "every intent, every observation under all of them, in full, with nothing omitted.",
    "",
    "Read it before you steer. It is the only way to say something to the planner that",
    "takes account of what has already been established — and it is what the planner",
    "will have in front of it when your directive arrives, so a directive that",
    "contradicts it will read to the planner exactly as it reads to you now.",
    "",
    "It is LARGE for a goal with history: this is the complete record and not a summary.",
    "Read it once and work from it rather than calling this between every message.",
    "",
    "If it is over this server's ceiling the call is refused naming both numbers, and no",
    "planner round can be opened on the goal either — the operator has to split it. Say",
    "so plainly if that happens; it is a configuration fact, not something you can work",
    "around.",
  ].join("\n"),
  parameters: Tool.EmptyParams,
  success: GoalBriefingOutcome,
  failure: GoalToolRefused,
  failureMode: "return",
}).addDependency(McpInvocation);

export const GoalIntentWire = Schema.Struct({
  intent_id: Schema.String,
  question: Schema.String,
  status: IntentStatus,
  anchored_to: Schema.Array(Schema.String),
  addresses_dimension: Schema.NullOr(Schema.String),
  attempts: Schema.Int,
  created_at: Schema.Finite,
});

export const ListIntentsOutcome = Schema.Struct({
  goal_id: Schema.String,
  /** Oldest first. */
  intents: Schema.Array(GoalIntentWire),
});

export const ListIntents = Tool.make("list_intents", {
  description: [
    "Every intent under this goal, oldest first, with the state of the work on each.",
    "",
    "  proposed — created and nobody has run it yet.",
    "  open     — available to run.",
    "  claimed  — an attempt is holding it right now.",
    "  answered — an attempt succeeded and recorded something under it. Whether that",
    "             something answers the question is a judgement nothing here makes.",
    "  abandoned — dropped without being answered.",
    "",
    "This is live, including intents a round added in the last second. It is how you",
    "tell the operator what the planner actually committed to after you steered it.",
    "",
    "You cannot create one of these. If something is missing, steer the planner.",
  ].join("\n"),
  parameters: Tool.EmptyParams,
  success: ListIntentsOutcome,
  failure: GoalToolRefused,
  failureMode: "return",
}).addDependency(McpInvocation);

export const GoalAttemptWire = Schema.Struct({
  attempt_id: Schema.String,
  intent_id: Schema.String,
  /**
   * `running`, `succeeded`, `failed`, `interrupted`, `uncertain`.
   *
   * A plain string rather than a union, because the stored column is one: an adopted
   * database is not something this build gets to assume about, and an unrecognised status
   * must reach the reader as itself rather than failing the read of every attempt beside
   * it.
   */
  status: Schema.String,
  /** Which harness and model ran it. Provenance, never a suggestion. */
  provider_id: Schema.String,
  model_id: Schema.String,
  started_at: Schema.Finite,
  ended_at: Schema.NullOr(Schema.Finite),
  /**
   * What recovery concluded about it, when it had to. Null for an attempt nothing swept.
   *
   * Present because `uncertain` is the one status that is not a result: it means no
   * definite answer could be reached, and an operator asking "did that run work" is owed
   * the difference between that and a failure.
   */
  recovery_disposition: Schema.NullOr(Schema.String),
});

export const ListAttemptsOutcome = Schema.Struct({
  goal_id: Schema.String,
  /** Oldest first, across every intent of the goal. */
  attempts: Schema.Array(GoalAttemptWire),
});

export const ListAttempts = Tool.make("list_attempts", {
  description: [
    "Every attempt made under this goal, oldest first: one row per execution of one",
    "intent by one worker.",
    "",
    "This is the only thing that tells you whether work is OUT. An intent with status",
    "'claimed' and a running attempt is being worked right now; an intent that is still",
    "open with three failed attempts behind it is something nobody has managed to run.",
    "A status of 'uncertain' means a process died and no definite answer could be",
    "reached — not that the work failed.",
    "",
    "An attempt that succeeded recorded an observation; list_observations is where those",
    "are. Use these two together before telling the operator that nothing has happened.",
  ].join("\n"),
  parameters: Tool.EmptyParams,
  success: ListAttemptsOutcome,
  failure: GoalToolRefused,
  failureMode: "return",
}).addDependency(McpInvocation);

export const ListObservationsOutcome = Schema.Struct({
  goal_id: Schema.String,
  /** The graph sequence this read saw. Provenance; the graph can move on. */
  graph_sequence: Schema.Int,
  /** Oldest first. */
  observations: Schema.Array(PlannerObservationWire),
});

export const ListObservations = Tool.make("list_observations", {
  description: [
    "Every observation recorded under this goal, oldest first, as a digest: what was",
    "tested, how it came out, what the worker read into it, and the untested dimensions",
    "it left behind.",
    "",
    "THIS IS NOT THE RECORD. The full record — cases, actors, ordered actions,",
    "per-action counts — is in get_goal_briefing. Use this when you want the shape of",
    "what has been established without reading the whole thing, and when you want it",
    "LIVE: an observation recorded since you last read the briefing is here.",
    "",
    "An outcome is relative to its tested_claim alone. 'negative' means the claim was",
    "not supported under the cases that were run — never an unbounded 'not vulnerable' —",
    "and 'inconclusive' means the test could not decide it. Repeating either to the",
    "operator as a clean bill of health would be the worst mistake available here.",
  ].join("\n"),
  parameters: Tool.EmptyParams,
  success: ListObservationsOutcome,
  failure: GoalToolRefused,
  failureMode: "return",
}).addDependency(McpInvocation);

export const ListOpenQuestionsOutcome = Schema.Struct({
  goal_id: Schema.String,
  graph_sequence: Schema.Int,
  questions: Schema.Array(PlannerQuestionWire),
});

export const ListOpenQuestions = Tool.make("list_open_questions", {
  description: [
    "The untested-dimension frontier of this goal: every question an observation left",
    "open, de-duplicated across the goal's intents, with its current state.",
    "",
    "  uninvestigated        — nobody has looked at it.",
    "  scheduled             — an intent declares it and work may still be out.",
    "  addressedInconclusive — an observation named it and could not decide.",
    "  addressedWithEvidence — an observation named it and decided it.",
    "",
    "work_still_out is what tells you whether to wait rather than to steer again. A",
    "'scheduled' question with work_still_out false is one somebody tried and did not",
    "answer, which is a different thing from one nobody has looked at — and it is the",
    "single most useful thing to tell an operator who is asking what is left.",
  ].join("\n"),
  parameters: Tool.EmptyParams,
  success: ListOpenQuestionsOutcome,
  failure: GoalToolRefused,
  failureMode: "return",
}).addDependency(McpInvocation);

/**
 * The goal agent's whole tool surface.
 *
 * **`add_intent` and `record_observation` are not here and are not reachable.** They are on
 * the round and worker endpoints, each of which refuses a goal credential at the door
 * (`mcp/server.ts`), and the store's own authority paths refuse the write regardless of how
 * a call arrived. This list is the half an operator can see in the model's own tool list,
 * and it is asserted directly in `goalTools.test.ts`.
 */
export const GoalToolkit = Toolkit.make(
  SteerPlanner,
  WakePlanner,
  EndGoal,
  GetGoalBriefing,
  ListIntents,
  ListAttempts,
  ListObservations,
  ListOpenQuestions,
);

/* ── Handlers ────────────────────────────────────────────────────────────────── */

/**
 * The caller, narrowed to a goal agent.
 *
 * Unreachable through the transport — the endpoint's middleware refuses any other kind of
 * credential with a `401` — and here because that middleware is a different file:
 * `plannerTools.ts` makes the same argument for the same reason.
 */
const goalCaller = Effect.fnUntraced(function* () {
  const caller = yield* McpInvocation;
  if (caller._tag !== "goal") {
    return yield* refused(
      "unauthorized",
      "these are a goal agent's tools and this credential is not a goal agent's; nothing was read or recorded",
    );
  }
  return caller;
});

/** Turns the store's failures into refusals this agent can explain to a person. */
const asRefusal = (error: {
  readonly _tag: string;
  readonly reason?: string;
  readonly detail?: string;
  readonly message?: string;
}): GoalToolRefused => {
  const detail = error.detail ?? error.message ?? "that call was refused";
  switch (error._tag) {
    case "MutationError":
      switch (error.reason) {
        case "conflict":
          return refused("conflict", detail);
        case "unauthorized":
          return refused("unauthorized", detail);
        case "stale":
          // A goal agent's `stale` has one cause: the goal has ended, so its authority
          // ended with it. `checkGoalAuthority` has no fence to be stale against.
          return refused("goal_ended", detail);
        default:
          return refused("conflict", detail);
      }
    case "GoalBriefingError":
      return refused(
        "unavailable",
        `this goal is not recorded in its target, so nothing could be read for it: ${detail}`,
      );
    case "GoalBriefingTooLarge":
      return refused("briefing_too_large", detail);
    case "FleetError":
      return refused(
        "unavailable",
        `this goal's target could not be opened, so nothing was read or recorded: ${detail}`,
      );
    case "StoredRowError":
      return refused(
        "unavailable",
        `a stored row no longer matches this server's contract, so this call could not be completed: ${detail}`,
      );
    default:
      return refused(
        "unavailable",
        "this target's database could not be reached, so nothing was read or recorded",
      );
  }
};

/** Turns a round refusal into one the agent can act on. */
const asPlanRefusal = (error: {
  readonly _tag: string;
  readonly reason?: string;
  readonly detail?: string;
  readonly message?: string;
}): GoalToolRefused => {
  if (error._tag !== "PlanRefused") return asRefusal(error);
  const detail = error.detail ?? error.message ?? "no round could be opened";
  switch (error.reason) {
    case "goal_busy":
    case "round_conflict":
      return refused("planner_busy", detail);
    case "goal_not_active":
      return refused("goal_ended", detail);
    case "no_harness":
    case "harness_not_ready":
    case "harness_unreachable":
    case "planning_directory_unusable":
    case "planning_ungated":
      return refused("harness_unavailable", detail);
    case "goal_not_found":
    case "target_unavailable":
    case "store_unavailable":
      return refused("unavailable", detail);
    default:
      return refused("unavailable", detail);
  }
};

/** Whatever the store said, for a log line, without narrowing its union by hand. */
const storeDetail = (error: { readonly _tag: string }): string => {
  const described = error as {
    readonly detail?: unknown;
    readonly message?: unknown;
  };
  if (typeof described.detail === "string") return described.detail;
  if (typeof described.message === "string") return described.message;
  return "no detail";
};

/** Borrows the caller's own target store for one tool call. */
const onCallersStore = <A>(
  stores: TargetStores["Service"],
  targetId: string,
  body: (store: ObservationStore["Service"]) => Effect.Effect<
    A,
    {
      readonly _tag: string;
      readonly reason?: string;
      readonly detail?: string;
      readonly message?: string;
    }
  >,
): Effect.Effect<A, GoalToolRefused> =>
  withTargetStore(stores, targetId, body).pipe(
    Effect.catch((error) => {
      const refusal = asRefusal(error);
      return refusal.reason === "unavailable"
        ? Effect.andThen(
            Effect.logError("a goal tool call could not reach the store", {
              targetId,
              failure: error._tag,
              // Through the same widening `plannerTools.ts` uses, and for the same reason:
              // the union here includes the store's own errors, which do not all carry
              // both fields, and narrowing it by hand at a log line would be a switch over
              // every failure the store has for one string.
              detail: storeDetail(error),
            }),
            Effect.fail(refusal),
          )
        : Effect.fail(refusal);
    }),
  );

const LIVE_INTENT_STATUSES: readonly IntentStatus[] = [
  "proposed",
  "open",
  "claimed",
];
// Declared so the unused-import rule and a future reader both see that this file
// deliberately lists *every* intent rather than the live ones: an operator asking "what
// has been tried" needs the abandoned and answered ones most of all. The planner's own
// `list_intents` filters because a planner is choosing what to do next.
void LIVE_INTENT_STATUSES;
void FollowUpStatus;

/**
 * The handlers.
 *
 * `TargetStores`, {@link PlanSupervisor} and {@link RoundOpener} are yielded once, here, at
 * layer construction — `plannerTools.ts` documents the arrangement at length and for the
 * same reason: a requirement resolved per request becomes a per-request requirement of the
 * route.
 *
 * Every handler's first statement is the same and is the boundary: narrow the caller to a
 * goal agent. There is no argument on any tool that names a goal or a target.
 */
export const GoalToolkitLayer = GoalToolkit.toLayer(
  Effect.gen(function* () {
    const stores = yield* TargetStores;
    const planning = yield* GoalPlanning;

    /**
     * One permit per `(caller scope, operation id)`, held for the length of one steer.
     *
     * **This closes the window the receipt alone leaves open**, which a re-review measured
     * and which the comment on `steer_planner` used to describe wrongly. The receipt is
     * what makes a *sequential* retry safe; it cannot make a **concurrent** one safe,
     * because there is a gap between the round going live and the receipt committing:
     * `plan/planSupervisor.ts` publishes a round as steerable before the start's gate
     * completes, so a retry arriving in that gap finds no receipt, finds a live round, and
     * steers the same directive into a session that already has it in its opening prompt.
     * The derived message id cannot help there — that session has never been offered it.
     *
     * **In-process mutual exclusion is sufficient only because this build is one process,
     * and that is an assumption rather than a property of anything here.** It is the same
     * assumption the rest of this slice already rests on — `claimedGoals` and the round
     * `FiberMap` in `plan/planSupervisor.ts`, the `opening` permits in
     * `plan/goalConversation.ts`, the credential registry itself — and it is named here
     * because this is the one place a reader is deciding whether a process-local lock is
     * enough.
     *
     * An earlier version of this comment justified it with "two processes cannot hold the
     * same goal agent", which is **false** and was caught in review. `callerScope` is
     * `<targetId>/goal/<goalId>`: it is derived from the goal, not from the token, so a
     * second process over the same fleet directory would mint its own grant under the *same*
     * scope and its own steers would key into its own copy of this map. Nothing enforces one
     * process per data directory. What would be needed for two is a durable claim — the
     * receipt is the only thing in this path that crosses a process — and that is a
     * different design than this slice has.
     *
     * Reference-counted and deleted at zero, so this is bounded by the steers **in flight**
     * rather than by the steers ever served. Deleting while a waiter held the key would let
     * a third caller make a fresh permit and run beside it, which is the bug the count
     * exists to prevent.
     */
    const steering = new Map<
      string,
      { readonly lock: Semaphore.Semaphore; holders: number }
    >();
    const perOperation = <A, E>(key: string, body: Effect.Effect<A, E>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const held = steering.get(key) ?? {
            lock: Semaphore.makeUnsafe(1),
            holders: 0,
          };
          held.holders += 1;
          steering.set(key, held);
          return held;
        }),
        (held) => Semaphore.withPermit(held.lock)(body),
        (held) =>
          Effect.sync(() => {
            held.holders -= 1;
            if (held.holders === 0) steering.delete(key);
          }),
      );

    /** Opens a round, with or without a directive, and maps the refusals once. */
    const openRound = Effect.fnUntraced(function* (input: {
      readonly targetId: string;
      readonly goalId: string;
      readonly directive?: string | undefined;
    }) {
      const started = yield* Effect.result(
        planning.openRound({
          targetId: input.targetId,
          goalId: input.goalId,
          ...(input.directive === undefined
            ? {}
            : { directive: input.directive }),
        }),
      );
      if (started._tag === "Failure") {
        return yield* asPlanRefusal(started.failure);
      }
      return started.success;
    });

    return GoalToolkit.of({
      /**
       * Delivers a directive, and three orderings in it are decisions rather than code.
       *
       * ## 1. The receipt is read **before** either branch is chosen
       *
       * `steer_planner` has two ways of reaching the planner — into a live round, or in the
       * opening prompt of a round opened for it — and one `operation_id` must reach it
       * **once, whichever way**. A review measured what the absence of this read cost: an
       * operation that opened a round, retried a moment later when that round was live,
       * delivered the same directive a second time *as a steer* and wrote a
       * `plan.round.steered` event claiming the round had changed direction when it had
       * started that way. `harness/messageId.ts`'s dedupe cannot help — the new round's
       * session has never been offered that id — so the identity has to be the receipt, and
       * the receipt has to be consulted before a round is opened.
       *
       * A retry therefore replays: the answer names the round the operation really reached
       * and says `delivered: false`.
       *
       * **A receipt cannot make a concurrent retry safe, and an earlier version of this
       * comment claimed it degraded to a refusal. It did not.** The gap is on the `opened`
       * side: `plan/planSupervisor.ts` publishes a round as steerable *before* the start's
       * gate completes, so from that moment until the first call's receipt commits — the
       * remainder of `openRound` plus one transaction, milliseconds — a second call with the
       * same id would pass the receipt read, find a live round, and steer the directive into
       * the session that already has it in its opening prompt. Nothing downstream catches
       * that: the derived message id has never been offered to that session, so the harness's
       * own dedupe has nothing to match.
       *
       * So the window is closed here instead, with a permit per `(caller scope, operation
       * id)` held across all three steps — see {@link steering}, including why in-process
       * exclusion is sufficient for this particular authority rather than a best effort.
       *
       * ## 2. Deliver, then record
       *
       * The two cannot be atomic — one is a prompt into a harness and the other is a
       * transaction — so one of them is going to be able to happen without the other, and
       * which way round that is is a decision. Recording first would mean a delivery
       * failure left an event for a steer that never reached the round: a false record, and
       * the kind that is impossible to detect later. Delivering first means a record
       * failure leaves a round that really was steered with nothing in its transcript to
       * say so — reported to the agent as `recorded: false` so it can tell the operator,
       * and logged. The directive being in the session is the primary fact; the record is
       * what explains it.
       *
       * ## 3. A record failure is never reported as a refusal
       *
       * **Not even a `conflict`,** and an earlier version of this comment had that exactly
       * wrong in both directions. It claimed a reused `operation_id` with different words
       * reached this branch; it does not — the directive is deliberately not in the hashed
       * input, so such a call is indistinguishable from a retry and is now answered by the
       * receipt read above, before anything is delivered. And it mis-described the case that
       * *does* reach here: a store `invalid` (a round that is not this goal's) arrives as
       * `conflict` through `asRefusal`'s default, and refusing with "nothing was recorded"
       * would tell the agent nothing happened **after the directive had already landed**.
       * So every failure from here on is `recorded: false` plus an error log, which is the
       * one description that is true of all of them.
       */
      steer_planner: Effect.fn("steer_planner")(function* (input) {
        const caller = yield* goalCaller();
        const urgency = input.urgency ?? "queued";
        const messageId = derivedMessageId(
          caller.callerScope,
          input.operation_id,
        );
        // Everything from the receipt read to the record, under this operation's own
        // permit. See {@link steering} for the window that leaves open without it.
        return yield* perOperation(
          `${caller.callerScope}:${input.operation_id}`,
          Effect.gen(function* () {
            /*
             * What this operation id already did, if anything. See part 1 above.
             *
             * A read failure is **not** treated as "no receipt": that would be the double
             * delivery again, reached by a database that could not be opened. It is refused
             * with the store's own `unavailable`, which says nothing was read or recorded.
             */
            const prior = yield* onCallersStore(
              stores,
              caller.targetId,
              (store) => store.steerReceipt(caller, input.operation_id),
            );
            if (prior !== undefined) {
              return {
                round_id: prior.roundId,
                goal_id: caller.goalId,
                how: prior.how,
                urgency: prior.urgency,
                // Nothing was sent again, which is the whole point of the id being derived
                // from the operation rather than minted per attempt.
                delivered: false,
                recorded: true,
              };
            }

            const attempt = yield* Effect.result(
              planning.steer({
                goalId: caller.goalId,
                directive: input.directive,
                urgency,
                messageId,
              }),
            );
            if (attempt._tag === "Failure") {
              return yield* asPlanRefusal(attempt.failure);
            }

            /**
             * Writes the receipt, and the event only for a round that was really redirected.
             *
             * One function for both branches so that the receipt cannot be written on one and
             * forgotten on the other, which is the shape of the defect this fixes. A failure is
             * reported rather than raised; the caller decides what to say about it.
             */
            const record = (how: "steered" | "opened", roundId: string) =>
              Effect.result(
                onCallersStore(stores, caller.targetId, (store) =>
                  store.recordRoundSteer(caller, {
                    operationId: input.operation_id,
                    roundId,
                    how,
                    urgency,
                    messageId,
                  }),
                ),
              );

            if (attempt.success._tag === "noLiveRound") {
              // Decision 12's second clause. The directive is in the new round's own opening
              // prompt, so nothing was redirected and no `plan.round.steered` is written — but
              // the receipt is, because without it the retry above has nothing to replay.
              const started = yield* openRound({
                targetId: caller.targetId,
                goalId: caller.goalId,
                directive: input.directive,
              });
              const recorded = yield* record("opened", started.roundId);
              if (recorded._tag === "Failure") {
                /*
                 * The round is open and carrying the directive, and this operation is now
                 * unprotected against a retry: there is no receipt to replay, so a second call
                 * under the same id would steer the round it just opened. Said to the agent as
                 * `recorded: false` — whose field doc is what tells it not to retry blindly —
                 * and logged, because the consequence is a double delivery rather than a
                 * missing sentence.
                 */
                yield* Effect.logError(
                  "a round was opened carrying a directive and the operation could not be recorded; a retry under the same operation id would deliver it again",
                  {
                    roundId: started.roundId,
                    goalId: caller.goalId,
                    operationId: input.operation_id,
                    reason: recorded.failure.reason,
                    detail: recorded.failure.detail,
                  },
                );
              }
              return {
                round_id: started.roundId,
                goal_id: caller.goalId,
                how: "opened" as const,
                urgency,
                delivered: true,
                recorded: recorded._tag === "Success",
              };
            }

            const steered = attempt.success;
            const recorded = yield* record("steered", steered.roundId);
            if (recorded._tag === "Failure") {
              yield* Effect.logError(
                "a steer was delivered into a live round and could not be recorded; the round's transcript will not explain its change of direction",
                {
                  roundId: steered.roundId,
                  goalId: caller.goalId,
                  urgency,
                  reason: recorded.failure.reason,
                  detail: recorded.failure.detail,
                },
              );
            }
            return {
              round_id: steered.roundId,
              goal_id: caller.goalId,
              how: "steered" as const,
              urgency,
              delivered: steered.delivered,
              recorded: recorded._tag === "Success",
            };
          }),
        );
      }),

      wake_planner: Effect.fn("wake_planner")(function* () {
        const caller = yield* goalCaller();
        const started = yield* openRound({
          targetId: caller.targetId,
          goalId: caller.goalId,
        });
        return {
          round_id: started.roundId,
          goal_id: caller.goalId,
          budget: started.budget,
          instance_id: started.instanceId,
          model_id: started.modelId,
          briefing_chars: started.briefingChars,
        };
      }),

      end_goal: Effect.fn("end_goal")(function* (input) {
        const caller = yield* goalCaller();
        const ended = yield* onCallersStore(stores, caller.targetId, (store) =>
          store.endGoalAsAgent(caller, {
            operationId: input.operation_id,
            status: input.status,
            reason: input.reason,
          }),
        );
        return {
          goal_id: ended.goalId,
          status: ended.status,
          ended_by: ended.endedBy,
          ended_at: ended.endedAt,
          replayed: ended.replayed,
        };
      }),

      get_goal_briefing: Effect.fn("get_goal_briefing")(function* () {
        const caller = yield* goalCaller();
        const prepared = yield* onCallersStore(
          stores,
          caller.targetId,
          (store) =>
            buildGoalBriefing(
              caller.goalId,
              DEFAULT_GOAL_BRIEFING_MAX_CHARS,
            ).pipe(Effect.provideService(ObservationStore, store)),
        );
        return {
          goal_id: prepared.briefing.goalId,
          objective: prepared.briefing.description,
          rendered: prepared.rendered,
          size_chars: prepared.briefing.sizeChars,
          prepared_at_sequence: prepared.briefing.preparedAtSequence,
        };
      }),

      list_intents: Effect.fn("list_intents")(function* () {
        const caller = yield* goalCaller();
        const intents = yield* onCallersStore(
          stores,
          caller.targetId,
          (store) => store.intentsForGoal(caller.goalId),
        );
        return {
          goal_id: caller.goalId,
          // Every intent, including the finished ones: see `LIVE_INTENT_STATUSES` above
          // on why this does not filter where the planner's own `list_intents` does.
          intents: intents.map((intent) => ({
            intent_id: intent.intentId,
            question: intent.question,
            status: intent.status,
            anchored_to: intent.anchoredTo,
            addresses_dimension: intent.addressesDimension,
            attempts: intent.attemptCount,
            created_at: intent.createdAt,
          })),
        };
      }),

      list_attempts: Effect.fn("list_attempts")(function* () {
        const caller = yield* goalCaller();
        const attempts = yield* onCallersStore(
          stores,
          caller.targetId,
          (store) => store.attemptsForGoal(caller.goalId),
        );
        return {
          goal_id: caller.goalId,
          attempts: attempts.map((attempt) => ({
            attempt_id: attempt.id,
            intent_id: attempt.intent_id,
            status: attempt.status,
            provider_id: attempt.provider_id,
            model_id: attempt.model_id,
            started_at: attempt.started_at,
            ended_at: attempt.ended_at,
            recovery_disposition: attempt.recovery_disposition,
          })),
        };
      }),

      list_observations: Effect.fn("list_observations")(function* () {
        const caller = yield* goalCaller();
        const read = yield* onCallersStore(stores, caller.targetId, (store) =>
          Effect.all({
            observations: store.observationsForGoal(caller.goalId),
            sequence: store.currentSequence,
          }),
        );
        return {
          goal_id: caller.goalId,
          graph_sequence: read.sequence,
          observations: [...read.observations]
            .sort(
              (left: Observation, right: Observation) =>
                left.sequence - right.sequence,
            )
            .map(observationWire),
        };
      }),

      list_open_questions: Effect.fn("list_open_questions")(function* () {
        const caller = yield* goalCaller();
        const read = yield* onCallersStore(stores, caller.targetId, (store) =>
          Effect.all({
            observations: store.observationsForGoal(caller.goalId),
            dimensions: store.dimensionsForGoal(caller.goalId),
            links: store.dimensionLinksForGoal(caller.goalId),
            schedules: store.dimensionSchedulesForGoal(caller.goalId),
            sequence: store.currentSequence,
          }),
        );
        return {
          goal_id: caller.goalId,
          graph_sequence: read.sequence,
          // The briefing's own derivation, reused rather than reimplemented — the same
          // join the planner's tool uses, for the same reason.
          questions: openQuestionsOf(
            read.observations,
            read.dimensions,
            read.links,
            read.schedules,
          ).map((question: OpenQuestion) => questionWire(question)),
        };
      }),
    });
  }),
);
