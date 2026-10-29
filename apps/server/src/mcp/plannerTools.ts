/**
 * The planner round's toolkit: what one bounded unit of planning may do.
 *
 * Sibling of `mcp/tools.ts`, which is the worker attempt's. The two are separate
 * `Toolkit`s bound to separate endpoints by `mcp/server.ts`, which is the whole of this
 * slice's first ruling: until now there was one global toolkit, so a round's session
 * listed `record_observation` and every call it made was refused by the store. The
 * authority boundary held and the tool surface disagreed with it.
 *
 * ## Six tools, two that write and four that read
 *
 * | Tool | Writes |
 * | --- | --- |
 * | `add_intent` | yes — wraps `store.addRoundIntent` |
 * | `record_round_disposition` | yes — and ends the goal on `objective_met` |
 * | `list_intents` | no |
 * | `list_observations` | no |
 * | `list_open_questions` | no |
 * | `list_harnesses` | no |
 *
 * **Every one of them is scoped by the credential and not by an argument.** There is no
 * `goal_id` parameter anywhere in this file. The goal comes from {@link McpInvocation},
 * which the transport's auth middleware builds from the presented bearer, so a planner
 * that named another goal would be describing a resource it has no way to address — the
 * same property `record_observation`'s provenance has, for the same reason.
 *
 * ## What the reads are for, and why they exist beside the briefing
 *
 * A round is prompted with the goal briefing at 100%: every intent and every observation,
 * in full. So the reads are not how the planner learns what happened — they are how it
 * reads the graph **live**, including its own writes within the round (the spec's decision
 * 9). The round row's `started_at_sequence` is provenance and never a snapshot, and a
 * worker settling an attempt mid-round moves the graph under the planner's feet. That is
 * also why the duplicate and budget rules are enforced at write time inside `add_intent`
 * rather than left to the planner's last read: a live read protects the planner only
 * against itself (decision 10).
 *
 * `list_observations` returns a **digest** and deliberately not the record: tested claim,
 * outcome, interpretation and the untested dimensions with their addresses. The full
 * record of every observation is in the briefing the round was prompted with, and shipping
 * a second complete copy through a tool would double the cost of the same bytes. The one
 * thing the digest carries that a planner cannot get from prose is the dimension
 * **address**, because that is what `add_intent` takes.
 *
 * ## Refusals are results, not transport errors
 *
 * Every tool uses `failureMode: "return"`, so a refusal is a tool *result* the model
 * reads rather than a torn-down turn. That matters most for the budget: "your budget is
 * spent, record your disposition" is an instruction, and a planner whose turn died on it
 * would have nothing to act on.
 */
import {
  ModelOptionSelection,
  ObservationOutcome,
  FollowUpStatus,
  IntentStatus,
  RoundDisposition,
  dimensionsOf,
  type Observation,
  type OpenQuestion,
} from "@bit/contracts";
import { Context, Effect, Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";

import { McpInvocation } from "./invocation";
import { openQuestionsOf } from "../briefing/briefing";
import { isReady, type HarnessListing } from "../harness/resolver";
import { TargetStores, withTargetStore } from "../persistence/targetStores";
import type { ObservationStore } from "../persistence/store";

/* ── The refusal ─────────────────────────────────────────────────────────────── */

/**
 * A planner tool call this server declined, in terms the planner can act on.
 *
 * One refusal shape across all six tools rather than one per tool, because the corrections
 * do not partition by tool: `stale` can end any of them and `unauthorized` can end any of
 * them, and a planner reading six shapes would have six places to learn the same two
 * facts.
 *
 * - `budget_spent` — this round has added as many intents as it may. **Stop adding and
 *   record a disposition**; the budget is a property of the round, so a new
 *   `operation_id` will not raise it. Recording a disposition still works.
 * - `duplicate` — another live intent of this goal already addresses the dimension this
 *   one named. {@link duplicate_of} is that intent.
 * - `goal_ended` — the goal is `met` or `abandoned`, so nothing new is dispatched under
 *   it. A disposition can still be recorded; an intent cannot be added.
 * - `anchoring` — the anchoring rule refused this intent: an anchor that is not recorded
 *   evidence, an anchor from another goal, a dimension address that does not resolve. The
 *   detail is the store's own sentence and is written to be acted on.
 * - `conflict` — an `operation_id` already used with different arguments, or a round that
 *   has already recorded a disposition. Nothing was written either way.
 * - `unauthorized` — this credential is not a planner round's, or names another goal.
 * - `stale` — this round is no longer the live one: it settled, or a sweep superseded it
 *   while the planner was working. **Nothing sent under it will be recorded, and intents
 *   already added are unaffected and still stored.** Stop and report; do not retry.
 * - `unavailable` — the target's database could not be reached. Nothing was recorded, and
 *   this is the one reason that says nothing about what the planner asked for.
 *
 * **Seven reasons and no eighth, in particular no bare `invalid`.** The store's
 * `MutationError` has an `invalid` reason and {@link asRefusal} maps it to `anchoring`
 * rather than passing the word through, because on these tools it is only ever the
 * anchoring family: the goal comes from the credential, the intent id is derived here, and
 * the anchor and dimension checks are the only other things that can produce it. A
 * declared reason nothing can produce would be a branch a planner's prompt might be
 * written against and a test could never reach.
 */
export class PlannerToolRefused extends Schema.TaggedError<PlannerToolRefused>()(
  "PlannerToolRefused",
  {
    reason: Schema.Literals([
      "budget_spent",
      "duplicate",
      "goal_ended",
      "anchoring",
      "conflict",
      "unauthorized",
      "stale",
      "unavailable",
    ]),
    detail: Schema.String,
    /**
     * The intent a `duplicate` refusal collided with. Null for every other reason.
     *
     * Spelled snake_case because this struct *is* the wire shape — a tool failure is
     * encoded through its own schema and there is no `encodeKeys` pass on it — and a
     * planner reading `duplicateOf` beside `operation_id` would be reading two
     * conventions in one payload.
     */
    duplicate_of: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return `${this.reason}: ${this.detail}`;
  }
}

/** A refusal with no duplicate to name, which is all of them but one. */
const refused = (
  reason: Exclude<PlannerToolRefused["reason"], "duplicate">,
  detail: string,
): PlannerToolRefused =>
  new PlannerToolRefused({ reason, detail, duplicate_of: null });

/* ── What a planner may suggest a run on ─────────────────────────────────────── */

/**
 * One configured harness, as a planner reads it when choosing a suggestion.
 *
 * **There is no credential, no API key and no token in this shape, and that is a property
 * of the type rather than of the mapping.** `HarnessInstanceView` carries an `auth` field,
 * which is the three-valued literal `authenticated | unauthenticated | unknown` — a
 * statement about whether the harness says it can reach its provider, never a secret — and
 * even that is left out here, because whether a harness is *usable* is `ready` and a
 * planner has nothing to do with how it authenticates. `models` is the list of model ids
 * a run names, and nothing else about them: the option descriptors a picker needs are a
 * UI concern.
 *
 * The planner is reading this to fill `suggested_instance_id` and `suggested_model`, both
 * of which are **advisory** (the spec's decision 13). An unready instance is listed with
 * its reason rather than filtered out, for the same reason the browser's picker lists it:
 * a planner that suggested an instance which is down should see that it is down, and the
 * dispatch path falls back visibly anyway.
 */
export const PlannerHarnessWire = Schema.Struct({
  instance_id: Schema.String,
  /** `opencode`, `claude-code`. Shown, never routed by. */
  driver: Schema.String,
  display_name: Schema.String,
  /** Whether a run may be sent here right now. */
  ready: Schema.Boolean,
  /** Why not, when it is not ready. Null when it is. */
  reason: Schema.NullOr(Schema.String),
  /** Whether a run that names no instance lands here. */
  is_default: Schema.Boolean,
  /** The model a run on this instance gets when it names none. Always in `models`. */
  default_model: Schema.String,
  /** Every model id this instance offers, in the form a suggestion names one. */
  models: Schema.Array(Schema.String),
});
export type PlannerHarnessWire = typeof PlannerHarnessWire.Type;

/**
 * The harness catalogue, as the planner toolkit sees it.
 *
 * **A service of its own rather than `HarnessResolver`, and the indirection is the
 * boundary.** The resolver holds built harnesses — for OpenCode, a child process and its
 * API client — and handing that to a tool layer would put a live harness in reach of a
 * handler that has no business driving one. This service answers exactly one question,
 * with exactly the fields on {@link PlannerHarnessWire}, so "no credential material
 * reaches the planner" is checkable by reading one mapping function.
 *
 * It also keeps `HarnessResolver` out of the MCP application layer's requirements, which
 * matters because that layer is built inside `HttpRouter.toWebHandler`'s own memo map: a
 * requirement there would be satisfied by a *second* resolver, which for OpenCode means a
 * second child process. `ControlPlaneEndpoint` passes an instance across that boundary
 * instead, exactly as it does for `TargetStores`.
 */
export class PlannerHarnesses extends Context.Service<
  PlannerHarnesses,
  { readonly listed: Effect.Effect<readonly PlannerHarnessWire[]> }
>()("bit/mcp/PlannerHarnesses") {
  /**
   * A server with no agent harness configured.
   *
   * An empty list is the true answer, not a missing one: `HARNESS=0`, or a build with no
   * usable driver, really does offer nowhere to run. The tool says so in its own words
   * rather than failing, because a planner cannot fix it and an intent with no suggestion
   * is perfectly runnable later.
   */
  static readonly none: Layer.Layer<PlannerHarnesses> = Layer.succeed(
    PlannerHarnesses,
    PlannerHarnesses.of({ listed: Effect.succeed([]) }),
  );

  /**
   * The catalogue of an already-built resolver, reduced to the fields above.
   *
   * `listing` rather than `of`, which `Context.Service` already defines as the way to
   * build this service's value.
   */
  static readonly listing = (
    listings: readonly PlannerHarnessWire[],
  ): Layer.Layer<PlannerHarnesses> =>
    Layer.succeed(
      PlannerHarnesses,
      PlannerHarnesses.of({ listed: Effect.succeed(listings) }),
    );
}

/**
 * The resolver's listings, reduced to what a planner may see.
 *
 * **The whole "no credential material" claim is this function, which is why it is here
 * and exported rather than inlined into a composition root.** It is a total mapping from
 * one shape to another with no spread anywhere in it: a field added to `HarnessListing` or
 * to `HarnessInstance` does not reach a planner until somebody writes a line here, and a
 * test can read every value this produces.
 *
 * The three things deliberately dropped: `instance.auth` (a three-valued statement about
 * provider reachability, not a secret, but nothing a planner acts on), `instance.installed`
 * (always true for a built instance, so it would say nothing), and each model's
 * `optionDescriptors` (a picker's concern; the planner names a model, and
 * `suggested_model_options` is forwarded unvalidated to be resolved at dispatch).
 *
 * `isReady` is imported as the pure predicate it is. That is a module dependency and not a
 * *service* one: {@link PlannerHarnesses} still carries a plain list, so the MCP
 * application layer has no `HarnessResolver` in its requirements and cannot cause a second
 * set of built harnesses to exist.
 */
export const plannerHarnessesOf = (
  listings: readonly HarnessListing[],
): readonly PlannerHarnessWire[] =>
  listings.map((listing) => ({
    instance_id: listing.instance.instanceId,
    driver: listing.instance.driver,
    display_name: listing.instance.displayName,
    ready: isReady(listing),
    reason: listing.reason ?? null,
    is_default: listing.isDefault,
    default_model: listing.instance.defaultModel,
    models: listing.instance.models.map((model) => model.id),
  }));

/* ── add_intent ──────────────────────────────────────────────────────────────── */

export const ADD_INTENT_DESCRIPTION = [
  "Create one intent: a specific direction to investigate under the goal you are",
  "planning. An intent is a question a bounded test could speak to, not a task list.",
  "",
  "ANCHORING IS THE RULE THAT MATTERS. An intent anchors only to recorded",
  "observations, and only to ones under this goal. It can never anchor to another",
  "intent, to a goal, or to a hunch: an intent anchored to another intent is",
  "speculation about speculation. Leave anchor_observation_ids empty for a new",
  "top-level direction, which is legitimate and is how a goal with no evidence yet",
  "starts.",
  "",
  "addresses_dimension takes the exact address of an untested dimension, as",
  "list_open_questions and your briefing print it (for example",
  "obs_000003_att_x#u1). Naming one does three things: the question's state becomes",
  "'scheduled' so a later round can tell 'nobody has looked' from 'work is out', an",
  "observation recorded under this intent may close that question even though",
  "another intent raised it, and this server can refuse a second live intent on the",
  "same dimension. Send null when this direction answers no recorded question.",
  "",
  "YOUR BUDGET IS FINITE AND IS A PROPERTY OF THIS ROUND. The result tells you how",
  "many intents you have added and how many remain. When it is spent this tool is",
  "refused with reason 'budget_spent', and the right response is to stop adding and",
  "call record_round_disposition — not to retry with a new operation_id, which",
  "cannot raise it.",
  "",
  "A refusal of 'duplicate' names the intent you collided with and quotes its",
  "question, so choose a different dimension or add a top-level direction instead.",
  "",
  "suggested_instance_id and suggested_model are ADVISORY and never a pin: whoever",
  "runs this intent resolves their own choice first, then yours, then the server's",
  "default, and a suggestion naming a harness that is down is replaced and said so.",
  "Read list_harnesses before suggesting either. Omit both if you have no opinion.",
  "",
  "The goal is taken from your credential and is not an argument here. operation_id",
  "is yours: reuse the same value to retry a call safely — a retry replays and does",
  "not spend budget twice — and a new value for a genuinely new intent.",
].join("\n");

export const AddIntentArgs = Schema.Struct({
  operation_id: Schema.NonEmptyString.annotate({
    description:
      "Stable operation identity. An exact retry replays and spends no budget; the same id with different arguments is refused as a conflict.",
  }),
  question: Schema.NonEmptyString.annotate({
    description:
      "The direction, as a question a bounded test could speak to. Not a task list.",
  }),
  anchor_observation_ids: Schema.Array(Schema.String).annotate({
    description:
      "Observations under this goal that this direction came out of, in order. Empty means a new top-level direction.",
  }),
  addresses_dimension: Schema.NullOr(Schema.String).annotate({
    description:
      "The exact address of the untested dimension this intent answers, or null.",
  }),
  suggested_instance_id: Schema.optional(Schema.NonEmptyString),
  suggested_model: Schema.optional(Schema.NonEmptyString),
  suggested_model_options: Schema.optional(Schema.Array(ModelOptionSelection)),
});

export const AddIntentOutcome = Schema.Struct({
  intent_id: Schema.String,
  goal_id: Schema.String,
  anchored_to: Schema.Array(Schema.String),
  /** The dimension row the address resolved to, or null when none was declared. */
  addresses_dimension_id: Schema.NullOr(Schema.String),
  top_level: Schema.Boolean,
  /** True when this call replayed an earlier one rather than writing anew. */
  replayed: Schema.Boolean,
  /** How many intents this round may add in total. */
  budget: Schema.Int,
  /** How many it has added, this one included. */
  intents_added: Schema.Int,
  /** How many more it may add. Zero means the next call is refused. */
  intents_remaining: Schema.Int,
});

export const AddIntent = Tool.make("add_intent", {
  description: ADD_INTENT_DESCRIPTION,
  parameters: AddIntentArgs,
  success: AddIntentOutcome,
  failure: PlannerToolRefused,
  failureMode: "return",
}).addDependency(McpInvocation);

/* ── record_round_disposition ────────────────────────────────────────────────── */

export const RECORD_DISPOSITION_DESCRIPTION = [
  "Record what this round of planning concluded. Call it exactly once, as the last",
  "thing you do, whether or not you added any intents.",
  "",
  "  actionable            — you added intents that are worth running now.",
  "  waiting               — there is nothing useful to add until work already out",
  "                          comes back. Say in the rationale what you are waiting",
  "                          for.",
  "  no_useful_next_action — a considered judgement that there is nothing worth",
  "                          doing here. This is not the same as recording nothing:",
  "                          it is an answer, and the rationale is what makes it one.",
  "  objective_met         — the goal's objective is established by the evidence",
  "                          already recorded. THIS ENDS THE GOAL. No further work",
  "                          is dispatched under it and no later round is opened on",
  "                          it. Use it only when the recorded observations support",
  "                          the objective, not when you have run out of ideas —",
  "                          that is no_useful_next_action.",
  "",
  "The rationale is stored with the disposition and is read by an operator rather",
  "than by a machine. Say what you concluded and from what; for objective_met it",
  "becomes the goal's own end reason.",
  "",
  "A round concludes once. A second call is refused as a conflict naming what was",
  "already recorded. This tool still works when your intent budget is spent — that",
  "is exactly when you should be calling it.",
].join("\n");

export const RecordDispositionArgs = Schema.Struct({
  disposition: RoundDisposition.annotate({
    description: "What this round concluded. See the tool description.",
  }),
  rationale: Schema.NonEmptyString.annotate({
    description:
      "Why, in your own words. For objective_met this becomes the goal's end reason.",
  }),
});

export const RecordDispositionOutcome = Schema.Struct({
  round_id: Schema.String,
  goal_id: Schema.String,
  disposition: RoundDisposition,
  /**
   * Whether this call ended the goal.
   *
   * True only for `objective_met` that found the goal still active. False for the other
   * three, and false for an `objective_met` on a goal an operator had already ended —
   * which is not an error: the round's conclusion is true either way, and the disposition
   * is recorded.
   */
  goal_ended: Schema.Boolean,
  /** How many intents this round added before concluding. */
  intents_added: Schema.Int,
});

export const RecordRoundDisposition = Tool.make("record_round_disposition", {
  description: RECORD_DISPOSITION_DESCRIPTION,
  parameters: RecordDispositionArgs,
  success: RecordDispositionOutcome,
  failure: PlannerToolRefused,
  failureMode: "return",
}).addDependency(McpInvocation);

/* ── The reads ───────────────────────────────────────────────────────────────── */

export const PlannerIntentWire = Schema.Struct({
  intent_id: Schema.String,
  question: Schema.String,
  status: IntentStatus,
  /** The observations it came out of, in order. Empty is a top-level direction. */
  anchored_to: Schema.Array(Schema.String),
  /** The dimension address it declared, or null. */
  addresses_dimension: Schema.NullOr(Schema.String),
  /** Attempts made against it so far, settled or not. */
  attempts: Schema.Int,
});

export const ListIntentsArgs = Schema.Struct({
  include_finished: Schema.optional(Schema.Boolean),
});

export const ListIntentsOutcome = Schema.Struct({
  goal_id: Schema.String,
  /** Oldest first. */
  intents: Schema.Array(PlannerIntentWire),
  /** How many of this goal's intents were left out because they are finished. */
  finished_omitted: Schema.Int,
});

export const ListIntents = Tool.make("list_intents", {
  description: [
    "The intents already under the goal you are planning, oldest first, with the",
    "state of the work on each. Read live: it includes intents you added in this",
    "round.",
    "",
    "By default it lists only the ones nobody has concluded — proposed, open and",
    "claimed — and says how many finished ones it left out. Pass",
    "include_finished: true to see answered and abandoned ones too. A status of",
    "'answered' means one attempt succeeded and recorded something; whether that",
    "something answers the question is a judgement nothing here makes.",
  ].join("\n"),
  parameters: ListIntentsArgs,
  success: ListIntentsOutcome,
  failure: PlannerToolRefused,
  failureMode: "return",
}).addDependency(McpInvocation);

export const PlannerObservationWire = Schema.Struct({
  observation_id: Schema.String,
  /** The graph's own order. Higher is later. */
  sequence: Schema.Int,
  intent_id: Schema.String,
  /** Which record format this row holds: `caseBased` or `summary`. */
  record_format: Schema.Literals(["caseBased", "summary"]),
  tested_claim: Schema.String,
  outcome: ObservationOutcome,
  interpretation: Schema.String,
  limitations: Schema.Array(Schema.String),
  /** Each with the exact address `add_intent`'s `addresses_dimension` takes. */
  untested_dimensions: Schema.Array(
    Schema.Struct({ address: Schema.String, dimension: Schema.String }),
  ),
});

export const ListObservationsOutcome = Schema.Struct({
  goal_id: Schema.String,
  /** The graph sequence this read saw. Provenance; the graph can move on. */
  graph_sequence: Schema.Int,
  /** Oldest first. */
  observations: Schema.Array(PlannerObservationWire),
});

export const ListObservations = Tool.make("list_observations", {
  description: [
    "Every observation recorded under the goal you are planning, oldest first, as a",
    "digest: what was tested, how it came out, what the worker read into it, and the",
    "untested dimensions it left with their addresses.",
    "",
    "THIS IS NOT THE RECORD. The full record of every one of these — cases, actors,",
    "ordered actions, per-action counts — is in the briefing you were prompted with,",
    "complete and with nothing omitted. Use this tool to read the graph LIVE: to see",
    "an observation a worker recorded after your briefing was built, and to get the",
    "dimension addresses you need for add_intent.",
    "",
    "An outcome is relative to its tested_claim alone. 'negative' means the claim was",
    "not supported under the cases that were run — never an unbounded 'not",
    "vulnerable' — and 'inconclusive' means the test could not decide it.",
  ].join("\n"),
  parameters: Tool.EmptyParams,
  success: ListObservationsOutcome,
  failure: PlannerToolRefused,
  failureMode: "return",
}).addDependency(McpInvocation);

export const PlannerQuestionWire = Schema.Struct({
  /** What `add_intent`'s `addresses_dimension` takes, verbatim. */
  address: Schema.String,
  /** The sentence the worker wrote. */
  dimension: Schema.String,
  status: FollowUpStatus,
  /** The observation that recorded it as untested. */
  raised_by_observation_id: Schema.String,
  /** Later observations that explicitly named this address, oldest first. */
  addressed_by_observation_ids: Schema.Array(Schema.String),
  /** Intents that declared they address it, oldest first. */
  scheduled_by_intent_ids: Schema.Array(Schema.String),
  /** True while any work on a scheduling intent could still produce an answer. */
  work_still_out: Schema.Boolean,
});

export const ListOpenQuestionsOutcome = Schema.Struct({
  goal_id: Schema.String,
  graph_sequence: Schema.Int,
  questions: Schema.Array(PlannerQuestionWire),
});

export const ListOpenQuestions = Tool.make("list_open_questions", {
  description: [
    "The untested-dimension frontier of the goal you are planning: every question an",
    "observation left open, de-duplicated across the goal's intents, with its exact",
    "address and its current state.",
    "",
    "  uninvestigated        — nobody has looked at it.",
    "  scheduled             — an intent declares it and work may still be out.",
    "  addressedInconclusive — an observation named this address and could not decide.",
    "  addressedWithEvidence — an observation named this address and decided it.",
    "",
    "status 'uninvestigated' with a non-empty scheduled_by_intent_ids means somebody",
    "tried and the question came back open, which is NOT the same fact as nobody",
    "having looked. work_still_out is what tells you whether to wait rather than to",
    "schedule again — a 'scheduled' question with work_still_out false is a question",
    "whose attempts are all finished without answering it.",
    "",
    "This is where add_intent's addresses_dimension values come from.",
  ].join("\n"),
  parameters: Tool.EmptyParams,
  success: ListOpenQuestionsOutcome,
  failure: PlannerToolRefused,
  failureMode: "return",
}).addDependency(McpInvocation);

export const ListHarnessesOutcome = Schema.Struct({
  harnesses: Schema.Array(PlannerHarnessWire),
});

export const ListHarnesses = Tool.make("list_harnesses", {
  description: [
    "Which agent harnesses this server can run a worker on, and which models each",
    "offers. Read it before you put suggested_instance_id or suggested_model on an",
    "intent, so a suggestion names something that exists.",
    "",
    "Unusable instances are listed with the reason they gave, rather than hidden: an",
    "instance that is down today may be up when the intent is run, and a suggestion",
    "that cannot be honoured is replaced by the server's default and said so.",
    "",
    "There are no credentials, keys or tokens in this answer and there is no tool",
    "here that would give you one. An empty list means this server configures no",
    "harness at all; intents are still worth adding, and whoever runs them will",
    "choose.",
  ].join("\n"),
  parameters: Tool.EmptyParams,
  success: ListHarnessesOutcome,
  failure: PlannerToolRefused,
  failureMode: "return",
}).addDependency(McpInvocation);

/**
 * The round's whole tool surface.
 *
 * A planner round's session is offered exactly these. `record_observation` is not here
 * and is not reachable: it is on the worker endpoint, which refuses a round credential at
 * the door.
 */
export const PlannerToolkit = Toolkit.make(
  AddIntent,
  RecordRoundDisposition,
  ListIntents,
  ListObservations,
  ListOpenQuestions,
  ListHarnesses,
);

/* ── Handlers ────────────────────────────────────────────────────────────────── */

/**
 * The caller, narrowed to a planner round.
 *
 * The endpoint's auth middleware already refuses a credential of another kind with a
 * `401`, so this is unreachable through the transport. It is here because the middleware
 * is a different file: a handler that read `caller.goalId` off the union would compile
 * only because the union happens to have it on two members, and this makes the
 * requirement local and explicit.
 */
const roundCaller = Effect.fnUntraced(function* () {
  const caller = yield* McpInvocation;
  if (caller._tag !== "round") {
    return yield* refused(
      "unauthorized",
      "these are a planner round's tools and this credential is not a planner round's; nothing was read or recorded",
    );
  }
  return caller;
});

/**
 * Turns the store's failures into refusals a planner can act on.
 *
 * One mapper for all six handlers, because the store's vocabulary is the same under each
 * of them. The two interesting lines are the ones that are *not* a flattening:
 * `RoundIntentRefused` keeps its own three reasons and its `duplicateOf`, and a
 * `DatabaseError` becomes `unavailable` with a sentence saying nothing was recorded —
 * because a planner that cannot tell its intent was not stored is a planner that carries
 * on as though it had.
 */
const asRefusal = (error: {
  readonly _tag: string;
  readonly reason?: string;
  readonly detail?: string;
  readonly message?: string;
  readonly duplicateOf?: string | null;
}): PlannerToolRefused => {
  switch (error._tag) {
    case "RoundIntentRefused":
      return new PlannerToolRefused({
        reason:
          error.reason === "budget_spent"
            ? "budget_spent"
            : error.reason === "duplicate"
              ? "duplicate"
              : "goal_ended",
        detail: error.detail ?? error.message ?? "that intent was refused",
        duplicate_of: error.duplicateOf ?? null,
      });
    case "MutationError": {
      const detail = error.detail ?? error.message ?? "that call was refused";
      switch (error.reason) {
        case "conflict":
          return refused("conflict", detail);
        case "unauthorized":
          return refused("unauthorized", detail);
        case "stale":
          return refused("stale", detail);
        default:
          // `invalid` from `addIntent` is the anchoring family and nothing else — see
          // `PlannerToolRefused` on why there is no bare `invalid` to fall through to.
          // Reported as `anchoring` so the planner knows which rule it broke, with the
          // store's own instructive sentence intact.
          return refused("anchoring", detail);
      }
    }
    case "FleetError":
      return refused(
        "unavailable",
        `this goal's target could not be opened, so nothing was recorded: ${error.detail ?? error.message ?? "no detail"}`,
      );
    case "StoredRowError":
      return refused(
        "unavailable",
        `a stored row no longer matches this server's contract, so this call could not be completed: ${error.message ?? "no detail"}`,
      );
    default:
      return refused(
        "unavailable",
        "this target's database could not be reached, so nothing was read or recorded",
      );
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

/**
 * Borrows the caller's own target store for the length of one tool call, and turns
 * whatever the store refused with into a refusal the planner reads.
 *
 * **Only `Effect.catch`, and no `catchCause`.** A typed failure is the store's answer and
 * is mapped by {@link asRefusal}; a *defect* is a bug here and is left to propagate, where
 * `effect/ai`'s own `internalToolError` logs it and answers with a scrubbed message.
 * Catching the cause instead — which this did in its first draft — turned every typed
 * refusal into `unavailable`, so a budget refusal and an unopenable database read the same
 * to a planner. The tests caught it; the lesson is that the two channels mean different
 * things and a handler that flattens them is throwing away the distinction the store took
 * care to make.
 *
 * `unavailable` is the one reason that gets a log line, because it is the one that says
 * nothing about what the planner asked for and everything about this server.
 */
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
      readonly duplicateOf?: string | null;
    }
  >,
): Effect.Effect<A, PlannerToolRefused> =>
  withTargetStore(stores, targetId, body).pipe(
    Effect.catch((error) => {
      const refusal = asRefusal(error);
      return refusal.reason === "unavailable"
        ? Effect.andThen(
            Effect.logError("a planner tool call could not reach the store", {
              targetId,
              failure: error._tag,
              detail: storeDetail(error),
            }),
            Effect.fail(refusal),
          )
        : Effect.fail(refusal);
    }),
  );

/**
 * One intent id per `operation_id`, derived rather than minted.
 *
 * **This is what makes `add_intent` retry-safe, and minting would have broken it.** The
 * receipt's request hash covers the whole input including the intent id, so a retry that
 * minted a *fresh* id would hash differently and be refused as a `conflict` — exactly the
 * case `operation_id` exists to make safe. Deriving the id from the round's caller scope
 * and the operation id makes the retry byte-identical, so it replays and the planner gets
 * the intent it already created.
 *
 * SHA-256 over `<callerScope>:<operationId>`, hex-truncated to 26 characters so the id has
 * the same width as `identifier.newIntentId`'s. Collision across two different operation
 * ids would need a 104-bit prefix collision; the scope prefix also means two rounds using
 * the same operation id get different intents, which they must.
 *
 * It is **not** a sortable identifier, unlike every other id in this store, and that is
 * the trade: an intent's creation order is `intents.created_at`, which is written in the
 * same transaction. Nothing parses an intent id.
 */
export const derivedIntentId = (
  callerScope: string,
  operationId: string,
): string =>
  `int_${new Bun.CryptoHasher("sha256")
    .update(`${callerScope}:${operationId}`)
    .digest("hex")
    .slice(0, 26)}`;

/** The intents a planner is shown by default: the ones nobody has concluded. */
const LIVE_INTENT_STATUSES: readonly IntentStatus[] = [
  "proposed",
  "open",
  "claimed",
];

const questionWire = (
  question: OpenQuestion,
): typeof PlannerQuestionWire.Type => ({
  address: question.address,
  dimension: question.dimension,
  status: question.status,
  raised_by_observation_id: question.raisedBy.observationId,
  addressed_by_observation_ids: question.addressedBy.map(
    (reference) => reference.observationId,
  ),
  scheduled_by_intent_ids: question.scheduledBy.map(
    (schedule) => schedule.intentId,
  ),
  work_still_out: question.scheduledBy.some(
    (schedule) => schedule.attemptsOpen,
  ),
});

const observationWire = (
  observation: Observation,
): typeof PlannerObservationWire.Type => ({
  observation_id: observation.observationId,
  sequence: observation.sequence,
  intent_id: observation.provenance.intentId,
  record_format: observation._tag,
  tested_claim: observation.testedClaim,
  outcome: observation.outcome,
  interpretation: observation.interpretation,
  limitations: observation.limitations,
  untested_dimensions: dimensionsOf(observation).map((entry) => ({
    address: entry.address,
    dimension: entry.dimension,
  })),
});

/**
 * The handlers.
 *
 * `TargetStores` and {@link PlannerHarnesses} are yielded once, here, at layer
 * construction — the arrangement `mcp/tools.ts` documents at length and for the same
 * reason: a requirement resolved per request becomes a per-request requirement of the
 * route, and the resolver yielded here shares the reference-counted handles the browser
 * API reads the same target through.
 *
 * Every handler's first two statements are the same and are the boundary: narrow the
 * caller to a round, then borrow *that caller's* target. There is no argument on any tool
 * that reaches either.
 */
export const PlannerToolkitLayer = PlannerToolkit.toLayer(
  Effect.gen(function* () {
    const stores = yield* TargetStores;
    const harnesses = yield* PlannerHarnesses;

    return PlannerToolkit.of({
      add_intent: Effect.fn("add_intent")(function* (input) {
        const caller = yield* roundCaller();
        const added = yield* onCallersStore(stores, caller.targetId, (store) =>
          store.addRoundIntent(caller, {
            operationId: input.operation_id,
            goalId: caller.goalId,
            // Derived, never minted. See `derivedIntentId` for why a fresh id would
            // make every retry a conflict.
            intentId: derivedIntentId(caller.callerScope, input.operation_id),
            question: input.question,
            anchorObservationIds: input.anchor_observation_ids,
            addressesDimension: input.addresses_dimension,
            // Forwarded only when present, so an absent suggestion stays absent in the
            // store rather than becoming an empty opinion.
            ...(input.suggested_instance_id === undefined
              ? {}
              : { suggestedInstanceId: input.suggested_instance_id }),
            ...(input.suggested_model === undefined
              ? {}
              : { suggestedModel: input.suggested_model }),
            ...(input.suggested_model_options === undefined
              ? {}
              : { suggestedModelOptions: input.suggested_model_options }),
          }),
        );
        return {
          intent_id: added.intentId,
          goal_id: added.goalId,
          anchored_to: added.anchoredTo,
          addresses_dimension_id: added.addressesDimensionId,
          top_level: added.topLevel,
          replayed: added.replayed,
          budget: added.budget,
          intents_added: added.intentsAdded,
          intents_remaining: Math.max(0, added.budget - added.intentsAdded),
        };
      }),

      record_round_disposition: Effect.fn("record_round_disposition")(
        function* (input) {
          const caller = yield* roundCaller();
          const recorded = yield* onCallersStore(
            stores,
            caller.targetId,
            (store) =>
              store.recordRoundDisposition(
                caller,
                input.disposition,
                input.rationale,
              ),
          );
          return {
            round_id: recorded.roundId,
            goal_id: caller.goalId,
            disposition: recorded.disposition,
            goal_ended: recorded.goalEnded,
            intents_added: recorded.intentsAdded,
          };
        },
      ),

      list_intents: Effect.fn("list_intents")(function* (input) {
        const caller = yield* roundCaller();
        const all = yield* onCallersStore(stores, caller.targetId, (store) =>
          store.intentsForGoal(caller.goalId),
        );
        const wanted =
          input.include_finished === true
            ? all
            : all.filter((intent) =>
                LIVE_INTENT_STATUSES.includes(intent.status),
              );
        return {
          goal_id: caller.goalId,
          intents: wanted.map((intent) => ({
            intent_id: intent.intentId,
            question: intent.question,
            status: intent.status,
            anchored_to: intent.anchoredTo,
            addresses_dimension: intent.addressesDimension,
            attempts: intent.attemptCount,
          })),
          finished_omitted: all.length - wanted.length,
        };
      }),

      list_observations: Effect.fn("list_observations")(function* () {
        const caller = yield* roundCaller();
        const read = yield* onCallersStore(stores, caller.targetId, (store) =>
          Effect.all({
            observations: store.observationsForGoal(caller.goalId),
            sequence: store.currentSequence,
          }),
        );
        return {
          goal_id: caller.goalId,
          graph_sequence: read.sequence,
          // Sorted here rather than trusted from the statement, so "oldest first" — which
          // is what a planner reads the sequence numbers against — is a property of this
          // handler.
          observations: [...read.observations]
            .sort((left, right) => left.sequence - right.sequence)
            .map(observationWire),
        };
      }),

      list_open_questions: Effect.fn("list_open_questions")(function* () {
        const caller = yield* roundCaller();
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
          // The briefing's own derivation, reused rather than reimplemented: the
          // de-duplication across a goal's intents is a join over these four reads, and a
          // second implementation of it is how a tool and a briefing come to disagree
          // about whether a question is still open. `includedIds` defaults to every
          // observation handed in, which for a goal is all of them.
          questions: openQuestionsOf(
            read.observations,
            read.dimensions,
            read.links,
            read.schedules,
          ).map(questionWire),
        };
      }),

      list_harnesses: Effect.fn("list_harnesses")(function* () {
        // Narrowed first even though this read touches no target: a tool a round may call
        // is a tool only a round may call, and the kind check is what says so.
        yield* roundCaller();
        return { harnesses: yield* harnesses.listed };
      }),
    });
  }),
);
