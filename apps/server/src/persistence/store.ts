/**
 * The control-plane store for the delegation-and-memory slice.
 *
 * Every statement here is a parameterised `effect/sql` tagged template. There is no ORM
 * and no query builder: the SQL is the SQL, and every value reaches SQLite as a bound
 * parameter rather than as text spliced into a statement (DECISIONS.md §3 "`FIX` —
 * effect/sql replaces Drizzle").
 *
 * **What is and is not checked before runtime.** The result schemas below are real
 * decoders — `SqlSchema.findAll`/`findOne` encode the request and decode each returned
 * row through Effect Schema, so a column that comes back as the wrong type, or JSON that
 * no longer matches the contract, is a typed failure naming the row. What TypeScript
 * does **not** check is the SQL text: a misspelled column or table name, a wrong
 * placeholder count, or a `SELECT` that omits a field the result schema requires are all
 * accepted by the compiler and fail at execution. That is why `store.test.ts`,
 * `migrations.test.ts` and `recovery/reconcile.test.ts` execute every statement in this
 * file against a real SQLite file; the type annotations are not a substitute for that
 * and are not claimed to be.
 *
 * **Transactions.** `sql.withTransaction` holds one connection for the body, so the
 * observation row, the monotonic sequence bump, the follow-up links and the command
 * receipt commit together or not at all. The body is an ordinary Effect and may yield —
 * that is the real difference from the superseded Drizzle arrangement, which needed a
 * synchronous callback. It still performs no harness call, no HTTP request and no
 * filesystem work: SQLite's write lock is held for the duration. Reconciliation obeys
 * the same rule by asking the harness *before* it opens a transaction, never inside one.
 *
 * The failure channel names what a caller can act on:
 *
 * - {@link MutationError} — refused on domain grounds (a receipt conflict, revoked write
 *   authority, or a follow-up address that does not resolve).
 * - {@link DatabaseError} — SQLite or the driver failed.
 * - {@link StoredRowError} — a persisted row no longer matches the contract. A
 *   data-integrity signal, not a bad request.
 */
import {
  OBSERVATION_WRITE_FORMAT,
  OUTBOX_RECOVERY_POLICIES,
  Observation,
  ObservationTestCase,
  ImportAssetResult,
  RecordAssetResult,
  RecordObservationResult,
  SummaryObservationConditions,
  AbandonIntentResult,
  AddIntentResult,
  EndGoalResult,
  GoalEndedBy,
  GoalEndStatus,
  GoalStatus,
  IntentStatus,
  ModelOptionSelection,
  OpenGoalResult,
  ScopeEffect,
  ScopeEntrySource,
  ScopeKind,
  ScopeLabelState,
  assetIdentityOf,
  describeScopeState,
  dimensionAddress,
  isAssetIdentityRefusal,
  isScopeValueRefusal,
  normaliseHost,
  normaliseScopeEntry,
  parseDimensionAddress,
  scopeStateOf,
  type AbandonIntentInput,
  type AddIntentInput,
  type EndGoalInput,
  type OpenGoalInput,
  type ObservationProvenance,
  type ObservationRecordFormat,
  type OutboxEntry,
  type OutboxRequestType,
  type AssetScopeLabel,
  type HostScopeLabel,
  type ImportAssetInput,
  type RecordAssetInput,
  type RecordedEvent,
  type ScopeEntry,
  type ScopeState,
  type RecordObservationInput,
  type RoundDisposition,
  type RoundStatus,
} from "@bit/contracts";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";

import * as identifier from "./identifier";
import { migrate } from "./migrations";
import { DatabaseError, asDatabaseError, sqliteLayer } from "./sql";
import type { HarnessObservedStatus } from "../recovery/harnessStatus";

export { DatabaseError } from "./sql";

/**
 * A rejected mutation.
 *
 * - `conflict` — an operation ID was reused with different input. The caller must not
 *   retry it as-is, and we must not write a second row.
 * - `stale` — the write authority presented is no longer current: the attempt has
 *   settled, or its fence has been superseded by recovery. Nothing is written.
 * - `unauthorized` — the authenticated attempt is not registered for the target and
 *   intent it claims.
 * - `invalid` — the submission does not resolve against stored state, e.g. a follow-up
 *   address naming an observation that does not exist or belongs to another intent.
 */
export class MutationError extends Schema.TaggedError<MutationError>()(
  "MutationError",
  {
    reason: Schema.Literals(["conflict", "unauthorized", "invalid", "stale"]),
    detail: Schema.String,
    /**
     * Set when the refusal is "the row you named is not here", so a transport can say so
     * without reading the sentence.
     *
     * `reason` cannot carry this on its own: a missing row and an unparseable value are
     * both `invalid` to every caller that only has to decide between refusing and
     * failing, and splitting the literal would make every exhaustive match on it handle a
     * case it does not care about. The alternative in place before this field was
     * `browserApi.ts` matching on substrings of `detail` — "nothing was removed", "is not
     * an asset of" — which made the HTTP status a property of a sentence's wording, so
     * rewording a message for an operator silently moved a 404 to a 400.
     *
     * Optional rather than defaulted to `false`, so the dozens of refusals that are not
     * about absence say nothing about it.
     */
    absent: Schema.optional(Schema.Boolean),
  },
) {
  override get message(): string {
    return `${this.reason}: ${this.detail}`;
  }
}

/** A persisted row that no longer decodes against the contract. */
export class StoredRowError extends Schema.TaggedError<StoredRowError>()(
  "StoredRowError",
  {
    table: Schema.String,
    rowId: Schema.String,
    detail: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `${this.table}/${this.rowId} does not match the contract: ${this.detail}`;
  }
}

/**
 * An intent that could not be claimed, and exactly why.
 *
 * Its own error rather than a {@link MutationError}, because a claim has four different
 * refusals that a caller must tell apart and a bare `invalid` or `conflict` would make it
 * parse a sentence to do so. Each reason is one the store established from the row, not
 * one it inferred:
 *
 * - `no_such_intent` — nothing is stored under that id.
 * - `other_target` — the intent belongs to a different target than the caller's.
 * - `not_open` — it is `claimed`, `answered`, `abandoned` or `proposed`. `heldBy` names the
 *   attempt holding it when the status is `claimed`, and is null otherwise.
 * - `goal_not_active` — the intent is open but its goal has ended. Ending a goal blocks
 *   new dispatch under it (the spec's decision 8).
 */
export class ClaimRefused extends Schema.TaggedError<ClaimRefused>()(
  "ClaimRefused",
  {
    reason: Schema.Literals([
      "no_such_intent",
      "other_target",
      "not_open",
      "goal_not_active",
    ]),
    intentId: Schema.String,
    /** The attempt holding the claim, when that is why. Null for every other reason. */
    heldBy: Schema.NullOr(Schema.String),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `${this.reason} (${this.intentId}): ${this.detail}`;
  }
}

/**
 * An intent a *planner round* may not add, and exactly why.
 *
 * Its own error rather than three more {@link MutationError} reasons, for
 * {@link ClaimRefused}'s reason: each of these is a different correction and a planner
 * told `invalid` would have to read a sentence to work out which. They are also the three
 * refusals that exist **only** on the round path — the host's `addIntent` has no budget,
 * no live-dimension join and no goal-status check — so keeping them apart from
 * `MutationError` keeps "what the round path adds" readable as a type.
 *
 * - `budget_spent` — the round has already added as many intents as its row allows. The
 *   detail says so and says what to do instead, because a planner that reads "refused"
 *   and tries again with a new operation id has learned nothing. **A round whose budget is
 *   spent may still record its disposition**, which is the whole point of telling it.
 * - `duplicate` — another live intent of this goal already declares the same untested
 *   dimension. `duplicateOf` names it and the detail quotes its question, so the planner
 *   can choose a different dimension rather than guess what it collided with.
 * - `goal_ended` — the goal is `met` or `abandoned`. Slice 4 left `checkRoundAuthority`
 *   with four checks and deliberately no goal-status check, because ending a goal
 *   interrupts nothing: a round in flight is work an operator may have reasons to let
 *   finish. What ending a goal stops is **dispatch**, and this is the last dispatch-shaped
 *   gap — adding an intent under a goal nobody wants worked. The detail names the status.
 *
 * Nothing is written on any of the three: all are raised inside the transaction, which
 * rolls back.
 */
export class RoundIntentRefused extends Schema.TaggedError<RoundIntentRefused>()(
  "RoundIntentRefused",
  {
    reason: Schema.Literals(["budget_spent", "duplicate", "goal_ended"]),
    roundId: Schema.String,
    /** The intent this one would duplicate. Null for every other reason. */
    duplicateOf: Schema.NullOr(Schema.String),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `${this.reason} (${this.roundId}): ${this.detail}`;
  }
}

/**
 * The authenticated caller, as one of three kinds of authority.
 *
 * Every field is derived from the bearer credential the host issued before it created the
 * session, never from anything the model said. A worker cannot name a different intent,
 * attempt or target by asking; a planner round cannot name a different goal; a goal agent
 * cannot name a different target.
 *
 * **A tagged union, not one struct with optional fields** (the spec's decision 2). The
 * three kinds can make genuinely different checks — an attempt is checked against a live
 * attempt row, a round against a live round row, a goal against a goal that has not ended
 * — and a struct carrying `attemptId?` and `roundId?` would let a call site read a field
 * that is absent for the caller it is actually holding and receive `undefined` where it
 * expected an identity. With a tag, every call site has to say which kind of caller it is
 * holding and the compiler is what tells it, which is the only form of this that a
 * reviewer can check by reading types rather than by reading every write.
 *
 * What each kind may write is in {@link callerScopeOf}'s table, in one place, beside the
 * scope string it is attributed under.
 */
export type CallerContext = AttemptCaller | RoundCaller | GoalCaller;

/**
 * A worker attempt: one execution of one intent.
 *
 * `attemptFence` is the write-authority epoch the credential was minted against. It is
 * compared against the attempt's current `write_fence` on every new write, so authority
 * revoked by recovery stays revoked across a restart — unlike the in-memory credential
 * registry, which simply forgets.
 */
export interface AttemptCaller {
  readonly _tag: "attempt";
  readonly callerScope: string;
  readonly targetId: string;
  readonly intentId: string;
  readonly attemptId: string;
  readonly harnessSessionId: string;
  readonly workerId: string;
  readonly attemptFence: number;
}

/**
 * A planner round: one bounded unit of planning work on one goal.
 *
 * `roundFence` is the same mechanism as {@link AttemptCaller.attemptFence} and exists for
 * the same reason (the spec's decision 5, ruling 5 of the slice brief): a round outlives
 * the individual tool calls made under it, and a recovery sweep may supersede one while
 * its credential is still out. There is no `intentId` — a round *creates* intents rather
 * than working one — and no `harnessSessionId`, because a round's credential is minted
 * before its session is prompted and the round row is where the session id is recorded.
 */
export interface RoundCaller {
  readonly _tag: "round";
  readonly callerScope: string;
  readonly targetId: string;
  readonly goalId: string;
  readonly roundId: string;
  readonly roundFence: number;
}

/**
 * A goal agent: the long-horizon, operator-facing conversation about one goal.
 *
 * **No fence, deliberately** (ruling 4 of the slice brief, the spec's decision 4). A
 * fence defends against one thing: a credential minted before a restart being replayed
 * afterwards. Grants live only in `mcp/credentials.ts`'s in-memory map, so a goal
 * credential cannot survive a restart to be replayed — the process that could have
 * resolved it is gone. What stops a goal credential is the goal's own ending: an ended
 * goal refuses every write under it, and that is a column. This absence is recorded here
 * because it is the kind of thing a later reader would otherwise take for an oversight
 * and "fix" by adding a column nothing can use.
 */
export interface GoalCaller {
  readonly _tag: "goal";
  readonly callerScope: string;
  readonly targetId: string;
  readonly goalId: string;
}

/** An {@link AttemptCaller} before its scope is derived. What a credential is minted from. */
export type AttemptBinding = Omit<AttemptCaller, "callerScope">;
/** A {@link RoundCaller} before its scope is derived. */
export type RoundBinding = Omit<RoundCaller, "callerScope">;
/** A {@link GoalCaller} before its scope is derived. */
export type GoalBinding = Omit<GoalCaller, "callerScope">;

/**
 * What a credential may be minted against: one binding per caller tag.
 *
 * `callerScope` is absent from all three on purpose. It is **derived** from the binding by
 * {@link callerScopeOf} rather than passed in, so there is no call site that can mint a
 * credential whose scope disagrees with the identity it carries — which would be a
 * credential whose receipts and events are filed under somebody else's name.
 */
export type CallerBinding = AttemptBinding | RoundBinding | GoalBinding;

/** Just enough of a caller to name its scope. See {@link callerScopeOf}. */
export type CallerIdentity =
  | {
      readonly _tag: "attempt";
      readonly targetId: string;
      readonly attemptId: string;
    }
  | {
      readonly _tag: "round";
      readonly targetId: string;
      readonly roundId: string;
    }
  | {
      readonly _tag: "goal";
      readonly targetId: string;
      readonly goalId: string;
    };

/**
 * The host's own authority, for a mutation no agent makes.
 *
 * `openGoal`, `endGoal`, `abandonIntent`, `openRound` and the operator's own `addIntent`
 * take this — the smaller thing that is still true, which target and whose receipts —
 * supplied by the process that owns the registry and never by a payload.
 *
 * **It is not the planner's path and never was a placeholder for it.** A planner round
 * presents a {@link RoundCaller} to {@link addRoundIntent}, which is where decision 10's
 * budget and duplicate rules live; a goal agent presents a {@link GoalCaller} to
 * `recordRoundSteer` and `endGoalAsAgent`. What remains host-authorised is the work the
 * *operator* does — creating a goal, abandoning an intent, opening a round from the browser
 * — and that is a different claim rather than an unfinished one. An earlier version of this
 * comment said `add_intent` would take a round caller "in slice 7"; it does.
 */
export interface HostContext {
  readonly callerScope: string;
  readonly targetId: string;
}

/**
 * The four caller scopes, and what each may write.
 *
 * A caller scope namespaces command receipts and attributes events, so two callers cannot
 * collide on or address each other's operation ids. There are exactly four shapes, and
 * this is the one place they are defined (the spec's decision 3; ruling 2 of the slice
 * brief, which blesses the operator scope as the fourth rather than renaming it):
 *
 * | Scope                        | Caller          | May write                                        |
 * | ---------------------------- | --------------- | ------------------------------------------------ |
 * | `<targetId>/<attemptId>`     | a worker attempt | `record_observation`, `record_asset`             |
 * | `<targetId>/round/<roundId>` | a planner round  | `add_intent`, and a round disposition            |
 * | `<targetId>/goal/<goalId>`   | a goal agent     | a round steer, and the goal's own ending         |
 * | `<targetId>/operator`        | the host, acting for the operator | goals, intents, claims, abandonments |
 *
 * The right-hand column is what the **store** enforces through the authority paths, not a
 * description of a tool list: a credential of the wrong kind is refused by
 * `recordObservation` and by `recordRoundDisposition` whatever tools its session happens
 * to have been registered with. The tool lists are the second half of the same boundary
 * and are per-directory (the spec's decision 5, demonstrated in DECISIONS.md §24.2).
 *
 * **The column is the present tense and is kept that way deliberately.** It read "nothing
 * yet; steer, wake and `end_goal` in slice 9" for two slices after slice 9 shipped, so the
 * canonical reference for what each kind of caller may write said a goal agent may write
 * nothing while `recordRoundSteer` and `endGoalAsAgent` were taking goal callers. A
 * forward reference in this table is a statement about current capability to anybody
 * reading it, and on an authority boundary that is the one comment that most needs to be
 * right — so what a later slice *will* add belongs in the spec, not here.
 *
 * A **wake** is not in the goal row, and the absence is the honest one: `wake_planner`
 * opens a round through `openRound`, which takes the host's context, so nothing is written
 * under the agent's own scope by it. What the goal agent writes is the two above.
 *
 * **Why the four cannot collide.** The last three are namespaced by a reserved segment,
 * and an attempt scope is two segments. A collision would need an attempt id spelled
 * `round/…`, `goal/…` or `operator`, and every id in a scope is minted by
 * `identifier.ts` as `<prefix>_<26 chars>` — never operator-supplied, never
 * model-supplied, and never containing a `/`. `store.test.ts` asserts that over
 * constructed scopes rather than by inspection of this comment.
 *
 * It takes the **identifying** fields only, not a whole {@link CallerBinding}: a scope is
 * a target and one id, and a function that demanded a fence in order to build a string
 * would make every caller that needs a scope on its own invent one. Every binding is
 * assignable to it.
 */
export const callerScopeOf = (binding: CallerIdentity): string => {
  switch (binding._tag) {
    case "attempt":
      return `${binding.targetId}/${binding.attemptId}`;
    case "round":
      return `${binding.targetId}/round/${binding.roundId}`;
    case "goal":
      return `${binding.targetId}/goal/${binding.goalId}`;
  }
};

/** The reserved segment a round's caller scope is namespaced by. */
const ROUND_SCOPE_SEGMENT = "/round/";

/**
 * Reads the round out of a caller scope, or `undefined` when it is not a round's.
 *
 * {@link callerScopeOf}'s inverse, and it lives beside it so the format has one home. The
 * caller behind an event is the only thing that says a record was written *by a planner
 * round* — `events.caller_scope` is the column, and the payload of an `intent.added` says
 * nothing about who added it — so a planner chat that wants to show a round's own writes
 * under that round's heading has to read it from here. `run/liveTranscript.ts` is the
 * caller.
 *
 * It takes the whole scope rather than a target and a scope, and does not check the target
 * prefix. The reserved segment plus `identifier.ts`'s id alphabet is what makes the match
 * unambiguous — no minted id contains a `/` — and a reader that already has the event
 * knows its target from the row.
 */
export const roundIdFromScope = (
  callerScope: string | null,
): string | undefined => {
  if (callerScope === null) return undefined;
  const at = callerScope.indexOf(ROUND_SCOPE_SEGMENT);
  if (at < 0) return undefined;
  const roundId = callerScope.slice(at + ROUND_SCOPE_SEGMENT.length);
  return roundId === "" ? undefined : roundId;
};

/** The reserved segment a goal agent's caller scope is namespaced by. */
const GOAL_SCOPE_SEGMENT = "/goal/";

/**
 * Reads the goal out of a caller scope, or `undefined` when it is not a goal agent's.
 *
 * {@link roundIdFromScope}'s sibling, here for the same reason and with the same one
 * caller: `run/liveTranscript.ts` needs to know which items belong to a goal's
 * **conversation**, and the only thing that says a record was written by the goal agent is
 * `events.caller_scope`. A `goal.ended` says nothing in its payload about whether an
 * operator, a planner round or the goal agent wrote it beyond `endedBy`, and
 * `plan.round.steered`'s subject is the round.
 *
 * It is **not** "which goal is this event about". An `intent.added` is about a goal and is
 * not part of the conversation; a filter that read the goal out of a payload would put
 * every write under the goal chat and show it twice on one page.
 */
export const goalIdFromScope = (
  callerScope: string | null,
): string | undefined => {
  if (callerScope === null) return undefined;
  const at = callerScope.indexOf(GOAL_SCOPE_SEGMENT);
  if (at < 0) return undefined;
  const goalId = callerScope.slice(at + GOAL_SCOPE_SEGMENT.length);
  return goalId === "" ? undefined : goalId;
};

/**
 * How a caller is named in a refusal it reads.
 *
 * Says the kind first and the identity second, because the kind is the correctable part:
 * a planner round told "you are a planner round and this is a worker's write" knows what
 * to do, where a bare id tells it only that something did not match.
 */
export const describeCaller = (caller: CallerContext): string => {
  switch (caller._tag) {
    case "attempt":
      return `attempt ${caller.attemptId} (a worker)`;
    case "round":
      return `round ${caller.roundId} (a planner round on goal ${caller.goalId})`;
    case "goal":
      return `the goal agent for goal ${caller.goalId}`;
  }
};

/**
 * What the store established about a caller's authority, by kind.
 *
 * Deliberately not the rows the checks read. A handler asking "is this credential still
 * good?" wants the identity it may act under, and handing it a row would invite it to
 * read a column the authority model does not promise.
 */
export type CallerAuthority =
  | {
      readonly _tag: "attempt";
      readonly attemptId: string;
      readonly intentId: string;
      readonly targetId: string;
      /** The attempt's current `write_fence`, which equals the credential's. */
      readonly fence: number;
    }
  | {
      readonly _tag: "round";
      readonly roundId: string;
      readonly goalId: string;
      readonly targetId: string;
      /** The round's current `write_fence`, which equals the credential's. */
      readonly fence: number;
    }
  | {
      readonly _tag: "goal";
      readonly goalId: string;
      readonly targetId: string;
    };

/**
 * Who a mutation the operator makes through the browser is recorded as.
 *
 * The fourth of the four scopes in {@link callerScopeOf}'s table, and the only one with
 * no credential behind it: it is the host's own authority, supplied by the process that
 * owns the session guard and never read from a payload. It is therefore built by its own
 * function rather than from a {@link CallerBinding} — there is no binding to build, which
 * is precisely what distinguishes it from the other three.
 *
 * One definition, because the browser API and the run supervisor both act as the operator
 * and a second spelling of the string is a receipt key that stops matching.
 */
export const operatorScope = (targetId: string): string =>
  `${targetId}/operator`;

export interface SeedInput {
  readonly targetId: string;
  readonly goalId: string;
  readonly goal: string;
  readonly intentId: string;
  readonly question: string;
  readonly attemptId: string;
  readonly workerId: string;
  /**
   * Which configured harness ran this, from `harness/identity.ts`.
   *
   * An attempt is **pinned** to its instance the moment it starts: nothing updates this
   * column, and moving work to another harness means opening a replacement attempt rather
   * than retargeting this one. `null` only for a row written before instances existed;
   * see migration `0014_attempt_harness_instance` on why there is no backfill.
   */
  readonly harnessInstanceId: string | null;
  /**
   * Which provider and model ran, inside that instance.
   *
   * Still the *model's* provenance and not the harness's — `openai` / `gpt-5.6-sol`, or
   * `anthropic` / `claude-sonnet-5` — which is why it does not identify the harness and
   * {@link harnessInstanceId} is a separate column.
   */
  readonly providerId: string;
  readonly modelId: string;
  /**
   * What was chosen *of* that model, as the run actually carried it.
   *
   * The dispatched selections — already resolved against the model's descriptors by the
   * caller — and never what a picker displayed: a descriptor's default is shown and
   * deliberately not sent, so a row claiming one would be answering a question nobody
   * asked. `null` is both "the operator set nothing" and, on a row older than migration
   * `0015_attempt_model_options`, "this was not recorded"; the two are indistinguishable
   * and saying so is better than inventing an empty list for either.
   *
   * An empty array is stored as `null` for the same reason it is omitted on the wire.
   */
  readonly modelOptions: readonly ModelOptionSelection[] | null;
  readonly harnessSessionId: string | null;
}

/**
 * What opening a replacement attempt needs.
 *
 * Deliberately not {@link SeedInput}: a replacement is opened under the goal and intent
 * the abandoned attempt already belonged to, so there is no goal description and no
 * question to re-declare here. `targetId` and `intentId` are the caller's claim about
 * which slice it is replacing, and they are checked against the predecessor's own
 * columns rather than trusted.
 */
export interface ReplacementInput {
  readonly replacesAttemptId: string;
  readonly targetId: string;
  readonly intentId: string;
  readonly attemptId: string;
  readonly workerId: string;
  /** See {@link SeedInput.harnessInstanceId}. A replacement may run on another instance. */
  readonly harnessInstanceId: string | null;
  readonly providerId: string;
  readonly modelId: string;
  /**
   * See {@link SeedInput.modelOptions}. A replacement carries its own.
   *
   * Not copied from the predecessor: a replacement is a new attempt that may run on
   * another instance, another model, and at another depth, so inheriting the abandoned
   * attempt's choices would record something nobody chose.
   */
  readonly modelOptions: readonly ModelOptionSelection[] | null;
  readonly harnessSessionId: string | null;
}

/**
 * Execution status of an attempt, as persisted.
 *
 * This says whether *execution* finished and how. It is never a statement about what a
 * test established or whether anything is a vulnerability (DECISIONS.md §15, "three
 * independent answers").
 */
export type AttemptExecutionStatus =
  "running" | "succeeded" | "failed" | "interrupted" | "uncertain";

/** The statuses an attempt can be settled or reconciled into. */
export type AttemptTerminalStatus = Exclude<AttemptExecutionStatus, "running">;

/**
 * Statuses nothing may move an attempt out of.
 *
 * `uncertain` is deliberately absent. It is terminal for *authority* — the fence is
 * bumped and no further write is accepted under the old credential — but it is an
 * admission that we do not know the outcome, so a later reconciliation that gets a
 * definite answer is allowed to refine it. Refining "we could not tell" into "it
 * failed" is new knowledge; overwriting "it succeeded" would be regression.
 */
export const FINAL_ATTEMPT_STATUSES = [
  "succeeded",
  "failed",
  "interrupted",
] as const satisfies readonly AttemptTerminalStatus[];

export const isFinalAttemptStatus = (status: string): boolean =>
  (FINAL_ATTEMPT_STATUSES as readonly string[]).includes(status);

/**
 * What reconciliation did about one attempt, recorded durably.
 *
 * - `still_running` — the harness says the session is live. Nothing changed, and the
 *   attempt keeps its authority.
 * - `settled` — the harness gave a definite terminal answer and the attempt now matches
 *   it. Its authority is revoked.
 * - `uncertain` — the harness could not be asked, or does not know the session. We do
 *   **not** know whether external effects occurred. Authority is revoked anyway.
 * - `refined` — a previously `uncertain` attempt got a definite answer.
 * - `already_final` — the attempt was already final. The harness's answer is recorded;
 *   the attempt is untouched.
 * - `unresumable` — the harness reports the session live, but this attempt's authority
 *   was already revoked. It cannot write and must not be resumed; replacement work
 *   needs a new attempt identity.
 */
export type RecoveryDisposition =
  | "still_running"
  | "settled"
  | "uncertain"
  | "refined"
  | "already_final"
  | "unresumable";

export interface IntentRow {
  readonly intentId: string;
  readonly question: string;
  readonly targetId: string;
  readonly goal: string;
}

/**
 * One goal as the store reads it: the row, and how much hangs under it.
 *
 * Deliberately not the contract's `GoalView`. The store describes what the file holds and
 * the contract describes a screen; they are allowed to diverge, and the browser API maps
 * one to the other field by field so that a divergence is a compile error rather than a
 * silently missing value. Today they happen to carry the same fields.
 *
 * `status` is decoded through the contract's vocabulary, so a row holding anything else
 * is a {@link StoredRowError} naming it rather than a string the rest of the program has
 * to distrust. The three ending fields are null together, while the goal is `active`.
 */
export interface StoredGoal {
  readonly goalId: string;
  readonly targetId: string;
  readonly name: string;
  readonly description: string;
  readonly status: GoalStatus;
  readonly createdAt: number;
  readonly endedAt: number | null;
  readonly endedBy: GoalEndedBy | null;
  readonly endReason: string | null;
  readonly intentCount: number;
  readonly attemptCount: number;
  readonly observationCount: number;
}

/**
 * An intent's advisory suggestion for how to run it, as stored.
 *
 * Null is no opinion, field by field. Never provenance: `attempts` records what ran.
 */
export interface StoredIntentSuggestion {
  readonly instanceId: string | null;
  readonly model: string | null;
  /** Null, never `[]`: an empty list would claim an opinion. See `AddIntentInput`. */
  readonly modelOptions: readonly ModelOptionSelection[] | null;
}

/**
 * One intent as the store reads it, with its anchors and how many attempts it has had.
 *
 * Like {@link StoredGoal}, deliberately not the contract's `IntentView`: the browser API
 * maps one to the other field by field. `addressesDimension` is the wire alias a briefing
 * prints, derived from the dimension row at read time rather than stored a second time.
 */
export interface StoredIntent {
  readonly intentId: string;
  readonly goalId: string;
  readonly targetId: string;
  readonly question: string;
  readonly status: IntentStatus;
  readonly anchoredTo: readonly string[];
  readonly addressesDimension: string | null;
  readonly createdAt: number;
  readonly claimedByAttemptId: string | null;
  readonly suggestion: StoredIntentSuggestion;
  readonly attemptCount: number;
}

/**
 * What a successful claim hands the run: the intent as it was taken, and its goal's words.
 *
 * Everything a run needs to start comes from here and none of it from the request — the
 * prompt is `question` — so a run is exactly the intent that was claimed.
 */
export interface ClaimResult {
  readonly intentId: string;
  readonly goalId: string;
  /** The goal's objective, for the attempt's provenance text. */
  readonly goal: string;
  readonly question: string;
  readonly suggestion: StoredIntentSuggestion;
  /** The attempt now holding the claim: the one the caller named. */
  readonly claimedByAttemptId: string;
}

/**
 * One claim the startup sweep gave back, and what it found when it looked.
 *
 * `attemptStatus` is null when the attempt the claim names has no row at all — the process
 * died between taking the claim and writing the attempt — and otherwise the status that
 * row holds, which is never `running`.
 */
export interface ReleasedClaim {
  readonly intentId: string;
  readonly goalId: string;
  readonly targetId: string;
  readonly claimedByAttemptId: string;
  readonly attemptStatus: string | null;
}

/** An attempt's identity plus the write-authority epoch a credential must carry. */
export interface AttemptAuthority {
  readonly attemptId: string;
  readonly writeFence: number;
}

/**
 * The result of settling an attempt.
 *
 * `effective` is the status the row holds afterwards, which is not always the one
 * requested: settlement only moves an attempt out of `running`, so a row recovery has
 * already settled keeps what recovery decided. `undefined` means there is no such
 * attempt row. `changed` is how a caller tells "I settled it" from "it was already
 * settled" without comparing statuses and guessing.
 */
export interface AttemptSettlement {
  readonly requested: AttemptTerminalStatus;
  readonly effective: AttemptExecutionStatus | undefined;
  readonly changed: boolean;
}

/**
 * A round's execution status and its disposition, both the contract's.
 *
 * These two vocabularies were declared here while a round was not a thing a browser could
 * see. Slice 7 gives rounds a route, so they are now `@bit/contracts`'s
 * (`contracts/plan.ts`, where the prose for each value lives) and re-exported from this
 * module for its own call sites. **Aliases rather than a second copy**: two spellings of
 * one vocabulary is how a stored value and a wire value come to disagree, and the column
 * decoders below `satisfies` these types, so a value this store could write that the
 * contract does not declare is a compile error.
 */
export type { RoundDisposition, RoundStatus } from "@bit/contracts";

/** The statuses a round can be settled into. */
export type RoundTerminalStatus = Exclude<RoundStatus, "running">;

/**
 * What opening a planner round needs. Host-owned ids, like {@link SeedInput}'s.
 *
 * No `targetId`: the {@link HostContext} that opens the round carries it, and a second
 * copy here would be a field a caller could set to a different target from the one whose
 * authority it is acting under.
 */
export interface OpenRoundInput {
  readonly goalId: string;
  readonly roundId: string;
  /**
   * How many intents this round may add. Stored so the limit a round was opened under is
   * a fact about the round; `addRoundIntent` enforces it inside its own write
   * transaction (the spec's decision 10).
   */
  readonly budget: number;
  /** See {@link SeedInput.harnessInstanceId}: null until a session exists. */
  readonly harnessInstanceId: string | null;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly harnessSessionId: string | null;
}

/** A round's identity plus the write-authority epoch a credential must carry. */
export interface RoundAuthority {
  readonly roundId: string;
  readonly writeFence: number;
  /**
   * Where this target's graph stood when the round opened. **Provenance, not a snapshot.**
   *
   * The planner reads the graph live and sees its own writes inside the round (the spec's
   * decision 9), so this records only where it started. Nothing may read it as "the state
   * this round saw", and nothing compares a later read against it to decide staleness.
   */
  readonly startedAtSequence: number;
}

/**
 * One planner round as the store reads it.
 *
 * `status` and `disposition` are decoded through this module's vocabularies, like
 * {@link StoredGoal}'s are through the contract's: nothing but this store writes either
 * column, so a value outside the set is corruption and belongs in a typed error naming
 * the row.
 */
export interface StoredRound {
  readonly roundId: string;
  readonly goalId: string;
  readonly targetId: string;
  readonly status: RoundStatus;
  readonly writeFence: number;
  readonly harnessSessionId: string | null;
  readonly harnessInstanceId: string | null;
  readonly providerId: string | null;
  readonly modelId: string | null;
  /** See {@link RoundAuthority.startedAtSequence}. Provenance. */
  readonly startedAtSequence: number;
  readonly budget: number;
  readonly disposition: RoundDisposition | null;
  /**
   * Why, in the planner's own words, or null when no disposition was recorded.
   *
   * Moves with {@link disposition} and never without it (migration `0020`): a disposition
   * with no rationale is not a state this store writes. A round that predates the column
   * reads null here whatever its disposition says, which that migration records.
   */
  readonly dispositionRationale: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

/**
 * Who settled a round, and what they knew when they did.
 *
 * The same distinction `attempt.settled`'s `settledBy` carries, and the same reason for
 * carrying it: "a supervisor watched this round finish" and "a sweep found the row after
 * the process that owned it died" are different facts about how much is known, and a
 * reader of the log alone has no other way to tell them apart.
 *
 * It is a parameter of {@link ObservationStore.settleRound} rather than two functions,
 * because the write is identical. Attempts split the two paths (`settleAttempt` and
 * `recordRecovery`) only because recovery there writes an `attempt_recoveries` row as
 * well, and a round has no such table.
 *
 * **Tagged, so that `observed` is present exactly when it means something.** A sweep asked
 * the harness and has its answer; a supervisor's three sources are a `TerminalOutcome` and
 * an interruption it caused, which is not a harness observation. Carrying it durably
 * matters because the round vocabulary collapses three of those answers into one status:
 * `uncertain` from `missing` ("the session is gone") and `uncertain` from `unreachable`
 * ("we could not ask") are different facts, and without this the distinction would survive
 * only in a log line a restart loses. An optional field would have let a sweep forget to
 * say, which is the same objection that makes `settledBy` itself required.
 */
export type RoundSettler =
  | { readonly _tag: "supervisor" }
  | {
      readonly _tag: "recovery";
      /** The harness abstraction's answer, verbatim, as `RecoveryWrite.observed` is. */
      readonly observed: HarnessObservedStatus;
    };

/**
 * The result of settling a round. The shape of {@link AttemptSettlement}, for the reason
 * that one has it: a caller has to tell "I settled it" from "it was already settled"
 * without comparing statuses and guessing.
 */
export interface RoundSettlement {
  readonly requested: RoundTerminalStatus;
  readonly effective: RoundStatus | undefined;
  readonly changed: boolean;
}

/** What a reconciler asks the store to record about one attempt. */
export interface RecoveryWrite {
  readonly attemptId: string;
  /** The harness abstraction's answer, verbatim. */
  readonly observed: HarnessObservedStatus;
  /** The status this answer maps onto, before no-regression rules are applied. */
  readonly proposedStatus: AttemptExecutionStatus;
  readonly detail: string;
}

/** What the store decided, after applying the no-regression and fencing rules. */
export interface RecoveryOutcome {
  readonly attemptId: string;
  readonly observed: HarnessObservedStatus;
  /**
   * The status the attempt held when this answer arrived.
   *
   * Part of what identifies the reconciliation durably, so it is reported rather than
   * left to be inferred from `status`: "running became uncertain" and "uncertain stayed
   * uncertain" are different events that `status` alone cannot tell apart.
   */
  readonly priorStatus: AttemptExecutionStatus | undefined;
  /** Absent when no such attempt row exists; nothing was recorded in that case. */
  readonly status: AttemptExecutionStatus | undefined;
  readonly disposition: RecoveryDisposition | undefined;
  readonly fenceBefore: number;
  readonly fenceAfter: number;
  /**
   * How many times this exact reconciliation state has been recorded — the same
   * attempt, harness answer, prior status, resulting status, disposition and fence
   * movement. A different disposition or a different prior status is a different
   * record, not another count on this one.
   */
  readonly times: number;
  /**
   * Observations this store held for the attempt when it was reconciled.
   *
   * Recorded as a fact, never consulted as evidence: a session that wrote nothing here
   * may still have changed the target.
   */
  readonly observationsAtRecovery: number;
  readonly detail: string;
}

/**
 * The counter an observation's `sequence` comes from.
 *
 * Per target, because the counter lives in the target's own file (DECISIONS.md §8:
 * "cursors belong to a particular target event log, not a global sequence across
 * independent target files"). It is **not** renumbered by the two-tier split: an
 * observation's id is `obs_<sequence>_<attemptId>` and every dimension alias a briefing
 * has printed is built from it, so renumbering would rewrite primary keys and invalidate
 * addresses already in circulation. Each file carries the counter it has, forward.
 */
const SEQUENCE_NAME = "observations";

/**
 * The event log's counter, and the outbox's.
 *
 * Two counters rather than one shared with each other or with observations. Sharing would
 * mean a transaction that wrote one event and one request consumed two numbers, leaving
 * the events table with gaps — and a gap is the one thing a consumer reading
 * `WHERE sequence > cursor` cannot tell from a loss. Separate counters keep each sequence
 * dense: a rollback discards its own bump along with everything else in the transaction.
 */
const EVENT_SEQUENCE_NAME = "events";
const OUTBOX_SEQUENCE_NAME = "outbox";

/** Stable key ordering so a retry hashes identically to the original call. */
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
};

/**
 * The fingerprint a retry is compared against.
 *
 * Over the caller **and** the input, not the input alone. The receipt key already
 * namespaces an operation id to one caller scope, so this is the finer check: the same
 * operation id from the same scope but under a different attempt, session or worker is a
 * different request, and answering it with the first one's result would attach provenance
 * that nothing recorded. `canonical` sorts keys so a retry that serialises its fields in
 * another order still hashes identically.
 */
/**
 * What a receipt hash covers about the caller.
 *
 * The **authority fields, not the discriminant.** `_tag` carries nothing `callerScope`
 * does not already — the four scope shapes are distinct by construction
 * ({@link callerScopeOf}) — and leaving it out keeps an attempt caller's digest
 * byte-identical to what it was before {@link CallerContext} became a union, so a receipt
 * written by an earlier build still *replays* on an upgraded database instead of reading
 * as a conflict. A receipt that stops matching is the one failure mode a worker cannot
 * tell from lost evidence, so it is worth this much care.
 *
 * Every kind's own identity fields are in the digest, which is what makes the hash a
 * statement about who asked as well as what they asked for.
 */
const callerDigest = (
  caller: CallerContext | HostContext,
): Record<string, unknown> => {
  const fields: Record<string, unknown> = { ...caller };
  delete fields["_tag"];
  return fields;
};

const hashRequest = (
  caller: CallerContext | HostContext,
  input: unknown,
): string =>
  new Bun.CryptoHasher("sha256")
    .update(canonical({ caller: callerDigest(caller), input }))
    .digest("hex");

/**
 * A dimension's id.
 *
 * Not derived from `(observation_id, position)`. An id that encoded the position would
 * reintroduce the positional identity migration `0008` exists to remove: the alias is
 * positional and resolved on the way in, and what it resolves *to* must not be. Sortable
 * by creation time is a different thing from derived-from-position, and the first is
 * useful to a reader in a way the second is dangerous.
 */
const newDimensionId = identifier.newDimensionId;

/** JSON text columns, declared once so reads and writes cannot disagree. */
const jsonList = Schema.fromJsonString(Schema.Array(Schema.String));
const jsonCases = Schema.fromJsonString(
  Schema.NonEmptyArray(ObservationTestCase),
);
const jsonConditions = Schema.fromJsonString(SummaryObservationConditions);

/**
 * The `record_format` column's values, keyed by the contract's `_tag`.
 *
 * Storage stays snake_case like every other identifier in the schema, and the domain
 * stays camelCase, so the two spellings are mapped here once rather than at each use.
 */
const STORED_FORMAT = {
  caseBased: "case_based",
  summary: "summary",
} as const satisfies Record<ObservationRecordFormat, string>;

/**
 * How an observation row is stored.
 *
 * JSON columns are declared as JSON *codecs*, so reading a row is a decode with a typed
 * failure rather than `JSON.parse(...) as string[]`. The format-specific columns are
 * nullable here because one table holds both formats; {@link toObservation} is what turns
 * `record_format` plus those nullables into the contract's discriminated union, and it
 * fails rather than guess if a row's columns do not match the format it claims. The
 * database enforces the same pairing with a `CHECK`, so this is belt and braces on
 * purpose: the constraint stops bad rows being written, and the decode stops a
 * hand-edited one being believed.
 *
 * `record_format` is read as a plain string rather than a literal union so that an
 * unrecognised value reaches {@link toObservation} and is reported against the row that
 * holds it, instead of failing as an anonymous decode error.
 */
const StoredObservationRow = Schema.Struct({
  id: Schema.String,
  sequence: Schema.Int,
  record_format: Schema.String,
  target_id: Schema.String,
  intent_id: Schema.String,
  attempt_id: Schema.String,
  harness_session_id: Schema.String,
  worker_id: Schema.String,
  tested_claim: Schema.String,
  outcome: Schema.Literals(["positive", "negative", "inconclusive"]),
  interpretation: Schema.String,
  limitations: jsonList,
  untested_dimensions: jsonList,
  recorded_at: Schema.Finite,
  setup: Schema.NullOr(Schema.String),
  cases: Schema.NullOr(jsonCases),
  summary_conditions: Schema.NullOr(jsonConditions),
  summary_observed_behavior: Schema.NullOr(Schema.String),
  summary_evidence_refs: Schema.NullOr(jsonList),
});
type StoredObservationRow = typeof StoredObservationRow.Type;

/**
 * The columns every observation read selects, derived from the row schema itself.
 *
 * `Schema.Struct` exposes its own `fields` (`effect/src/Schema.ts:3511`) and
 * `Object.keys` over them is declaration order, so a column added to
 * {@link StoredObservationRow} is selected without a second edit here. Writing the list
 * out again is the one mistake this file's result schemas cannot catch: a `SELECT` that
 * omits a required column fails at execution, and the compiler is happy either way.
 *
 * Interpolating this into statement text is safe in a way a value never is: every name
 * comes from a literal field record in this module, so there is nothing here a caller
 * can reach. Values still go in as bound parameters.
 *
 * The `INSERT` in `recordObservation` is not derived this way, because a hand-derived
 * column list has to line up positionally with a `VALUES` clause and nothing would check
 * that it still did. The library's own `sql.insert(record)` does keep the two in lockstep
 * — it walks one record's keys to build both (`effect/src/sql/Statement.ts:952`) — and is
 * the right tool if that statement is ever rewritten.
 */
const observationColumns = Object.keys(StoredObservationRow.fields).join(", ");

/**
 * A stored command receipt, with its result left as text.
 *
 * It was decoded here through `RecordObservationResult` when `record_observation` was the
 * only mutation. It cannot be now: one table holds receipts for three operations, and a
 * schema fixed at the query would fail to decode two thirds of them. The result is
 * therefore decoded by the operation that wrote it, through that operation's own schema
 * (see {@link makeStore}'s `replayResult`) — which keeps the typed boundary §20 insists
 * on. What is deliberately *not* done is `JSON.parse(text) as A`.
 */
const StoredReceipt = Schema.Struct({
  key: Schema.String,
  request_hash: Schema.String,
  result: Schema.String,
});

const SequenceRow = Schema.Struct({ value: Schema.Int });
const CountRow = Schema.Struct({ value: Schema.Int });

const IntentJoinRow = Schema.Struct({
  intent_id: Schema.String,
  question: Schema.String,
  target_id: Schema.String,
  goal: Schema.String,
});

/**
 * A goal row with its counts, as one statement returns it.
 *
 * `status` and `ended_by` are decoded through the contract's literals rather than left as
 * strings. That is the opposite choice to `AttemptRow.status`, and deliberately: an
 * attempt's status has a recovery vocabulary that an adopted database might extend, while
 * a goal's has exactly three values and nothing else writes the column — a fourth is
 * corruption, and corruption belongs in a typed error naming the row.
 */
const GoalRow = Schema.Struct({
  id: Schema.String,
  target_id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  status: GoalStatus,
  created_at: Schema.Finite,
  ended_at: Schema.NullOr(Schema.Finite),
  ended_by: Schema.NullOr(GoalEndedBy),
  end_reason: Schema.NullOr(Schema.String),
  intent_count: Schema.Int,
  attempt_count: Schema.Int,
  observation_count: Schema.Int,
});

/**
 * The columns {@link GoalRow} names, as one `SELECT` list.
 *
 * Counts are correlated subqueries rather than joins: a join across intents, attempts
 * and observations multiplies rows (three attempts under an intent with five observations
 * is fifteen), and `COUNT(DISTINCT …)` over that product is the kind of thing that is
 * right until the day it is not. Each subquery counts one table once. Observations and
 * attempts both hang off an intent, so both are reached through `intents.goal_id`.
 */
const goalSelect = `SELECT goals.id AS id, goals.target_id AS target_id, goals.name AS name,
    goals.description AS description, goals.status AS status,
    goals.created_at AS created_at, goals.ended_at AS ended_at,
    goals.ended_by AS ended_by, goals.end_reason AS end_reason,
    (SELECT COUNT(*) FROM intents WHERE intents.goal_id = goals.id) AS intent_count,
    (SELECT COUNT(*) FROM attempts INNER JOIN intents ON intents.id = attempts.intent_id
       WHERE intents.goal_id = goals.id) AS attempt_count,
    (SELECT COUNT(*) FROM observations INNER JOIN intents
         ON intents.id = observations.intent_id
       WHERE intents.goal_id = goals.id) AS observation_count
  FROM goals`;

const toStoredGoal = (row: typeof GoalRow.Type): StoredGoal => ({
  goalId: row.id,
  targetId: row.target_id,
  name: row.name,
  description: row.description,
  status: row.status,
  createdAt: row.created_at,
  endedAt: row.ended_at,
  endedBy: row.ended_by,
  endReason: row.end_reason,
  intentCount: row.intent_count,
  attemptCount: row.attempt_count,
  observationCount: row.observation_count,
});

const jsonModelOptions = Schema.fromJsonString(
  Schema.Array(ModelOptionSelection),
);

/**
 * An intent row with its attempt count and, when it addresses a dimension, the raising
 * observation and position the wire alias is built from.
 *
 * `status` is decoded through the contract's literals, like {@link GoalRow}'s: a value
 * outside the five is corruption, and corruption belongs in a typed error naming the row.
 * `suggested_model_options` is decoded from its JSON here, so a stored list that no longer
 * matches the contract fails naming the row rather than reaching a browser.
 */
const IntentRowSchema = Schema.Struct({
  id: Schema.String,
  goal_id: Schema.String,
  target_id: Schema.String,
  question: Schema.String,
  status: IntentStatus,
  created_at: Schema.Finite,
  claimed_by_attempt_id: Schema.NullOr(Schema.String),
  suggested_instance_id: Schema.NullOr(Schema.String),
  suggested_model: Schema.NullOr(Schema.String),
  suggested_model_options: Schema.NullOr(jsonModelOptions),
  dimension_observation_id: Schema.NullOr(Schema.String),
  dimension_position: Schema.NullOr(Schema.Int),
  attempt_count: Schema.Int,
});

/** One anchor link, selected beside the intents it belongs to. */
const IntentAnchorRow = Schema.Struct({
  intent_id: Schema.String,
  observation_id: Schema.String,
});

/**
 * The columns {@link IntentRowSchema} names. The attempt count is a correlated subquery for
 * the reason {@link goalSelect}'s counts are: one table counted once, no row multiplication.
 * The dimension join is `LEFT`, because most intents address none.
 */
const intentSelect = `SELECT intents.id AS id, intents.goal_id AS goal_id,
    intents.target_id AS target_id, intents.question AS question,
    intents.status AS status, intents.created_at AS created_at,
    intents.claimed_by_attempt_id AS claimed_by_attempt_id,
    intents.suggested_instance_id AS suggested_instance_id,
    intents.suggested_model AS suggested_model,
    intents.suggested_model_options AS suggested_model_options,
    dimensions.observation_id AS dimension_observation_id,
    dimensions.position AS dimension_position,
    (SELECT COUNT(*) FROM attempts WHERE attempts.intent_id = intents.id) AS attempt_count
  FROM intents
  LEFT JOIN observation_dimensions AS dimensions
    ON dimensions.id = intents.addresses_dimension`;

const toStoredIntent = (
  row: typeof IntentRowSchema.Type,
  anchors: readonly string[],
): StoredIntent => ({
  intentId: row.id,
  goalId: row.goal_id,
  targetId: row.target_id,
  question: row.question,
  status: row.status,
  anchoredTo: anchors,
  addressesDimension:
    row.dimension_observation_id === null || row.dimension_position === null
      ? null
      : dimensionAddress(row.dimension_observation_id, row.dimension_position),
  createdAt: row.created_at,
  claimedByAttemptId: row.claimed_by_attempt_id,
  suggestion: {
    instanceId: row.suggested_instance_id,
    model: row.suggested_model,
    modelOptions: row.suggested_model_options,
  },
  attemptCount: row.attempt_count,
});

/**
 * How an attempt row is stored.
 *
 * `status` is a plain string rather than a literal union for the same reason
 * `record_format` is: an unrecognised value has to be reportable against the row that
 * holds it, and an adopted database is not something we get to assume about.
 */
const AttemptRow = Schema.Struct({
  id: Schema.String,
  intent_id: Schema.String,
  target_id: Schema.String,
  worker_id: Schema.String,
  harness_session_id: Schema.NullOr(Schema.String),
  /**
   * The configured harness this attempt is pinned to. `null` before migration `0014`.
   *
   * Nullable rather than defaulted, because a row written when there was one harness does
   * not record which, and filling in a guess would be inventing provenance. Everything
   * that reads it — the API, and `recovery/harnessStatus.ts` — treats `null` as unknown.
   */
  harness_instance_id: Schema.NullOr(Schema.String),
  provider_id: Schema.String,
  model_id: Schema.String,
  /**
   * What was dispatched of the model, as canonical JSON. `null` before migration `0015`.
   *
   * Kept as the stored text rather than decoded here, like `record_format` and for the
   * same reason: this schema's job is to say what the column holds, and an adopted
   * database with something unexpected in it has to be reportable *against the row*
   * rather than failing the read of every attempt beside it.
   */
  model_options: Schema.NullOr(Schema.String),
  status: Schema.String,
  started_at: Schema.Finite,
  ended_at: Schema.NullOr(Schema.Finite),
  write_fence: Schema.Int,
  recovery_disposition: Schema.NullOr(Schema.String),
  recovered_at: Schema.NullOr(Schema.Finite),
  replaces_attempt_id: Schema.NullOr(Schema.String),
});
export type AttemptRow = typeof AttemptRow.Type;

/** Derived like {@link observationColumns}, and for the same reason. */
const attemptColumns = Object.keys(AttemptRow.fields).join(", ");

/**
 * The same columns, qualified, for the one statement that joins `attempts` to `intents`.
 *
 * Derived from the same schema rather than written out, like {@link attemptColumns}: an
 * unqualified `id` in a join against a table that also has one is ambiguous, and a hand
 * written list is a list that stops matching the row schema.
 */
const attemptColumnsQualified = Object.keys(AttemptRow.fields)
  .map((column) => `attempts.${column}`)
  .join(", ");

/**
 * How a planner round row is stored.
 *
 * `status` and `disposition` **are** decoded through their literal vocabularies, which is
 * the opposite choice to {@link AttemptRow.status} and deliberate for the reason
 * {@link GoalRow} gives: an attempt's status vocabulary is one an adopted database might
 * have extended, while `planner_rounds` was created by migration `0018` in this build and
 * nothing but this store has ever written to it. A value outside the set is corruption,
 * and corruption belongs in a typed error naming the row rather than in a string the rest
 * of the program has to distrust.
 *
 * The four harness columns are nullable because a round row exists before its session
 * does: the row is what the credential is minted against, and the credential is minted
 * before the session is prompted. A round that never reached a harness holds nulls, which
 * is the honest record rather than a hole.
 */
const RoundRow = Schema.Struct({
  id: Schema.String,
  goal_id: Schema.String,
  target_id: Schema.String,
  status: Schema.Literals([
    "running",
    "settled",
    "uncertain",
    "interrupted",
  ] as const satisfies readonly RoundStatus[]),
  write_fence: Schema.Int,
  harness_session_id: Schema.NullOr(Schema.String),
  harness_instance_id: Schema.NullOr(Schema.String),
  provider_id: Schema.NullOr(Schema.String),
  model_id: Schema.NullOr(Schema.String),
  started_at_sequence: Schema.Int,
  budget: Schema.Int,
  disposition: Schema.NullOr(
    Schema.Literals([
      "actionable",
      "waiting",
      "no_useful_next_action",
      "objective_met",
    ] as const satisfies readonly RoundDisposition[]),
  ),
  disposition_rationale: Schema.NullOr(Schema.String),
  started_at: Schema.Finite,
  ended_at: Schema.NullOr(Schema.Finite),
});

/** Derived like {@link attemptColumns}, and for the same reason. */
const roundColumns = Object.keys(RoundRow.fields).join(", ");

const toStoredRound = (row: typeof RoundRow.Type): StoredRound => ({
  roundId: row.id,
  goalId: row.goal_id,
  targetId: row.target_id,
  status: row.status,
  writeFence: row.write_fence,
  harnessSessionId: row.harness_session_id,
  harnessInstanceId: row.harness_instance_id,
  providerId: row.provider_id,
  modelId: row.model_id,
  startedAtSequence: row.started_at_sequence,
  budget: row.budget,
  disposition: row.disposition,
  dispositionRationale: row.disposition_rationale,
  startedAt: row.started_at,
  endedAt: row.ended_at,
});

/**
 * One attempt's dispatched options, in the one order they are ever stored in.
 *
 * Sorted by id, so the same two choices are the same bytes however the descriptors
 * happened to be ordered when they were resolved — which makes "did these two attempts
 * run the same way" a comparison rather than a parse. Empty becomes `null`, because an
 * empty list would claim an opinion exactly as it would on the wire.
 *
 * The column and the `attempt.started` payload are both written from this, so the event
 * log and the row cannot disagree about what ran.
 */
const canonicalModelOptions = (
  options: readonly ModelOptionSelection[] | null,
): readonly ModelOptionSelection[] | null =>
  options === null || options.length === 0
    ? null
    : [...options].sort((left, right) => left.id.localeCompare(right.id));

/**
 * One durable record of what the harness said about an attempt and what we did.
 *
 * Identity is the whole reconciliation state — attempt, harness answer, prior status,
 * resulting status, disposition and both fence values (migration `0006`). Repeating the
 * *same* state increments `times`; a state that differs in any of those is its own row.
 * That is what keeps a `settled` pass and a later `already_final` pass apart even when
 * they share an observed and a resulting status, which the original three-column key
 * could not: the second would have landed on the first row and left a disposition that
 * contradicted both its own detail text and what the caller was told.
 */
const AttemptRecoveryRow = Schema.Struct({
  attempt_id: Schema.String,
  observed_status: Schema.String,
  prior_status: Schema.String,
  resulting_status: Schema.String,
  disposition: Schema.String,
  detail: Schema.String,
  harness_session_id: Schema.NullOr(Schema.String),
  fence_before: Schema.Int,
  fence_after: Schema.Int,
  observations_at_recovery: Schema.Int,
  first_reconciled_at: Schema.Finite,
  last_reconciled_at: Schema.Finite,
  times: Schema.Int,
});
export type AttemptRecoveryRow = typeof AttemptRecoveryRow.Type;

const recoveryColumns = Object.keys(AttemptRecoveryRow.fields).join(", ");

const RecentRecoveryRow = Schema.Struct({
  attempt_id: Schema.String,
  status: Schema.String,
  disposition: Schema.String,
  observed_status: Schema.String,
  detail: Schema.String,
  last_reconciled_at: Schema.Finite,
});

/**
 * One recorded untested dimension, as a row with its own identity (migration `0008`).
 *
 * `id` is opaque on purpose. It is not derived from `(observation_id, position)`,
 * because an id that encoded the position would make position the identity again and
 * the table would be decoration — the whole reason for it is that a dimension's identity
 * stops depending on where it sits (DECISIONS.md §17, "dimensions become rows").
 *
 * The observation's `untested_dimensions` JSON column still holds the same sentences.
 * The two cannot disagree: the rows are written from the list inside the same
 * transaction as the observation, and nothing updates an observation afterwards. The
 * column is that observation's own immutable record of what it declared; these rows are
 * the addressable identities derived from it.
 */
const StoredDimensionRow = Schema.Struct({
  id: Schema.String,
  observation_id: Schema.String,
  position: Schema.Int,
  text: Schema.String,
  created_at: Schema.Finite,
});

/**
 * A dimension, with the **wire alias** a briefing prints for it.
 *
 * The alias is `<observationId>#u<position>` and is derived here rather than stored:
 * storing it would be a second spelling of the same two columns. It is what a worker
 * copies, and the write boundary resolves it back to {@link StoredDimension.dimensionId}.
 */
export interface StoredDimension {
  readonly dimensionId: string;
  readonly observationId: string;
  readonly position: number;
  readonly text: string;
  readonly address: string;
}

/**
 * One recorded "this observation took on that earlier dimension" link.
 *
 * The foreign key is the dimension's id now, not a parsed position. `address` is kept
 * verbatim as submitted so the stored link reads the way the briefing printed it;
 * which observation and position it resolved to are the dimension row's own columns,
 * read back through a join rather than duplicated here.
 */
const DimensionLinkRow = Schema.Struct({
  observation_id: Schema.String,
  dimension_id: Schema.String,
  address: Schema.String,
  created_at: Schema.Finite,
  addressing_sequence: Schema.Int,
  addressing_outcome: Schema.Literals(["positive", "negative", "inconclusive"]),
});

export interface DimensionLink {
  /** The later observation that addressed the dimension. */
  readonly observationId: string;
  /** The dimension row it addressed. */
  readonly dimensionId: string;
  /** The alias exactly as the worker submitted it. */
  readonly address: string;
  /**
   * The addressing observation's own sequence and outcome, from the same join.
   *
   * Carried on the link rather than looked up by the reader, because since the
   * same-intent rule relaxed (migration `0009`) the addressing observation may belong to
   * a *sibling* intent and so may not be among the rows a briefing for this intent
   * holds. A reader that resolved the addresser against its own list would silently drop
   * exactly the link the relaxation exists to allow — and would report the question as
   * untouched.
   */
  readonly addressingSequence: number;
  readonly addressingOutcome: "positive" | "negative" | "inconclusive";
}

/**
 * One intent's declaration that it addresses a dimension, with its work's state.
 *
 * Named `*Row` because it is a store shape, not the contract's {@link
 * DimensionSchedule}: the briefing turns `attemptsOpen` — a count — into the boolean a
 * reader needs, and that derivation belongs where the state is derived.
 */
/** One asset as stored, in the shape the table holds. */
export interface StoredAsset {
  readonly id: string;
  readonly target_id: string;
  readonly kind: string;
  readonly identity: string;
  readonly host: string;
  readonly port: number;
  readonly scheme: string | null;
  readonly method: string | null;
  readonly path: string | null;
  readonly first_seen_at: number;
}

/**
 * One asset with the provenance aggregate a reader shows beside it.
 *
 * The asset's own columns, plus what `asset_discoveries` says about how it came to be
 * known. The three nullable fields are nullable because an asset need not have been
 * *discovered*: `recordAsset` always writes a discovery in the same transaction, but
 * `importAsset` never writes one at all (D14), so an imported host reads as zero
 * discoveries and no attempt until a worker finds it. Reported as it is rather than
 * refused or filled in.
 */
export interface StoredAssetWithProvenance extends StoredAsset {
  readonly discoveries: number;
  readonly first_attempt_id: string | null;
  readonly first_intent_id: string | null;
  readonly last_discovered_at: number | null;
}

/**
 * One recorded import of an asset, which a merge never overwrites.
 *
 * {@link StoredAssetDiscovery}'s sibling, and the fields that differ are the reason there
 * are two tables (D14): a discovery names the intent and attempt that found the asset, an
 * import names the page it was read off. Neither shape has the other's fields, so no
 * reader has to ask whether this row's attempt is missing or merely null.
 */
export interface StoredAssetImport {
  readonly asset_id: string;
  readonly operation_id: string;
  readonly caller_scope: string;
  /** The program page this asset was read off. */
  readonly source_url: string;
  /** The submission verbatim, before normalisation — `discovered_as`' sibling. */
  readonly imported_as: string;
  readonly note: string;
  readonly imported_at: number;
}

/** One recorded discovery of an asset, which a merge never overwrites. */
export interface StoredAssetDiscovery {
  readonly asset_id: string;
  readonly operation_id: string;
  readonly caller_scope: string;
  readonly intent_id: string;
  readonly attempt_id: string;
  readonly discovered_as: string;
  readonly note: string;
  readonly discovered_at: number;
}

export interface DimensionScheduleRow {
  readonly dimensionId: string;
  readonly intentId: string;
  readonly question: string;
  readonly attemptsTotal: number;
  readonly attemptsOpen: number;
}

/**
 * Turns one row into the contract's observation union.
 *
 * A row whose columns contradict its `record_format` is reported, not repaired. There is
 * no fallback that invents a `setup` for a summary row or a `conditions` for a case-based
 * one, because either would be a lie about what was recorded.
 */
const toObservation = (
  row: StoredObservationRow,
): Effect.Effect<Observation, StoredRowError> => {
  const provenance: ObservationProvenance = {
    targetId: row.target_id,
    intentId: row.intent_id,
    attemptId: row.attempt_id,
    harnessSessionId: row.harness_session_id,
    workerId: row.worker_id,
    recordedAt: row.recorded_at,
  };
  const common = {
    observationId: row.id,
    sequence: row.sequence,
    testedClaim: row.tested_claim,
    outcome: row.outcome,
    interpretation: row.interpretation,
    limitations: row.limitations,
    untestedDimensions: row.untested_dimensions,
    provenance,
  };
  const malformed = (detail: string) =>
    Effect.fail(
      new StoredRowError({
        table: "observations",
        rowId: row.id,
        detail,
        cause: { recordFormat: row.record_format },
      }),
    );

  if (row.record_format === STORED_FORMAT.caseBased) {
    if (row.setup === null || row.cases === null) {
      return malformed("a case-based row is missing its setup or cases");
    }
    return Effect.succeed({
      _tag: "caseBased",
      ...common,
      setup: row.setup,
      cases: row.cases,
    });
  }
  if (row.record_format === STORED_FORMAT.summary) {
    if (
      row.summary_conditions === null ||
      row.summary_observed_behavior === null ||
      row.summary_evidence_refs === null
    ) {
      return malformed("a summary row is missing its summary columns");
    }
    return Effect.succeed({
      _tag: "summary",
      ...common,
      conditions: row.summary_conditions,
      observedBehavior: row.summary_observed_behavior,
      evidenceRefs: row.summary_evidence_refs,
    });
  }
  return malformed(`unknown observation record format ${row.record_format}`);
};

/** A decode failure against a known table and row. */
const storedRow =
  (table: string, rowId: string) =>
  (cause: { readonly message: string }): StoredRowError =>
    new StoredRowError({ table, rowId, detail: cause.message, cause });

/**
 * How much of each thing one target's file holds.
 *
 * Every field is named after the table it counts, and there is a field for each table the
 * hunt chain creates that an operator would recognise as content. Nothing here is a
 * derived or interpreted figure: the UI's own vocabulary ("hunts", "findings") is a
 * naming question the flow that designs those screens settles, and a count invented to
 * match a label the schema does not have would be the first lie on the first screen that
 * claims to show real numbers.
 *
 * `unsettledAttempts` is the one count that is a predicate rather than a table: attempts
 * still `running` or `uncertain`, which is what recovery works on and the only one of
 * these numbers that can go *down*.
 */
export interface StoredCounts {
  readonly goals: number;
  readonly intents: number;
  readonly attempts: number;
  readonly unsettledAttempts: number;
  readonly observations: number;
  readonly assets: number;
  readonly events: number;
}

const makeStore = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Both layer constructors wait for the schema before publishing the service.
  // A failed migration fails layer acquisition instead of exposing a partial store.
  const applied = yield* migrate;
  if (applied.length > 0) {
    yield* Effect.logInfo(
      `applied migrations: ${applied.map(([id, name]) => `${id}_${name}`).join(", ")}`,
    );
  }

  const selectAttemptById = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: AttemptRow,
    execute: (id) =>
      sql.unsafe(`SELECT ${attemptColumns} FROM attempts WHERE id = ?`, [id]),
  });

  /** Reads one attempt inside whatever transaction is in force, or reports the row. */
  const attemptOrFail = Effect.fnUntraced(function* (attemptId: string) {
    const row = yield* selectAttemptById(attemptId).pipe(
      Effect.mapError((error) =>
        error._tag === "SqlError"
          ? asDatabaseError("query")(error)
          : storedRow("attempts", attemptId)(error),
      ),
    );
    return Option.getOrUndefined(row);
  });

  /**
   * Gives a claimed intent back, and says what it became. **One statement.**
   *
   * The destination is the settlement rule (`contracts/intent.ts`, {@link IntentStatus}):
   * `answered` only when the attempt `succeeded` **and** at least one observation exists
   * under the intent, otherwise `open`. A `failed`, `interrupted` or `uncertain` attempt
   * never reaches `answered`, because a run that did not finish saying what it found is an
   * absence of evidence and `answered` is the one status that asserts evidence. The
   * observation test is a subquery in the same `UPDATE`, so the answer cannot be decided
   * on a count that is stale by the time it is written.
   *
   * The `WHERE` is the safety: it matches only an intent that is `claimed` **and** (when
   * `heldBy` is given) claimed by that attempt. So a settlement that fires for an attempt
   * that never held the claim — a replacement attempt opened beside an intent that is
   * `open`, a refinement of an `uncertain` attempt whose claim was released long ago, a
   * refused run's cleanup arriving after another run took the intent — changes nothing,
   * rather than freeing a claim somebody else holds.
   *
   * Transaction-local by use: {@link settleAttempt} and {@link recordRecovery} call it
   * inside their own transaction so a settled attempt and a released intent commit
   * together or not at all. Returns whether a row changed.
   */
  const releaseClaim = Effect.fnUntraced(function* (
    intentId: string,
    settledStatus: string,
    heldBy: string | null,
  ) {
    const released = yield* sql<{ id: string }>`UPDATE intents
      SET status = CASE
            WHEN ${settledStatus} = 'succeeded'
              AND EXISTS (SELECT 1 FROM observations WHERE observations.intent_id = intents.id)
            THEN 'answered' ELSE 'open' END,
          claimed_by_attempt_id = NULL
      WHERE id = ${intentId} AND status = 'claimed'
        AND (${heldBy} IS NULL OR claimed_by_attempt_id = ${heldBy})
      RETURNING id`.pipe(Effect.mapError(asDatabaseError("transaction")));
    return released.length > 0;
  });

  /**
   * Creates the goal, intent and attempt a worker will be bound to, and returns the
   * write authority a credential for it must carry.
   *
   * `ON CONFLICT DO NOTHING` keeps re-seeding the same attempt harmless, which is what
   * lets a demo be re-run against an existing database. The fence is read back rather
   * than assumed to be zero, so re-seeding an attempt that recovery has already fenced
   * hands out the *current* authority instead of a superseded one.
   *
   * **`attempt.started` is appended only when a row was really inserted.** The attempt is
   * read before the insert for exactly that reason: re-seeding is idempotent, so an
   * unconditional append would write a second `started` for an attempt that started once,
   * and a reader counting starts would over-count every re-run. Idempotence in the domain
   * table and a duplicate in the log would be the worst of both.
   */
  const seedAttempt = Effect.fn("ObservationStore.seedAttempt")(function* (
    input: SeedInput,
  ) {
    const now = yield* Clock.currentTimeMillis;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const before = yield* attemptOrFail(input.attemptId);
          yield* sql`INSERT INTO goals (id, target_id, description, created_at)
            VALUES (${input.goalId}, ${input.targetId}, ${input.goal}, ${now})
            ON CONFLICT(id) DO NOTHING`.pipe(
            Effect.mapError(asDatabaseError("transaction")),
          );
          yield* sql`INSERT INTO intents (id, goal_id, target_id, question, created_at)
            VALUES (${input.intentId}, ${input.goalId}, ${input.targetId},
                    ${input.question}, ${now})
            ON CONFLICT(id) DO NOTHING`.pipe(
            Effect.mapError(asDatabaseError("transaction")),
          );
          const modelOptions = canonicalModelOptions(input.modelOptions);
          yield* sql`INSERT INTO attempts (id, intent_id, target_id, worker_id,
              harness_session_id, harness_instance_id, provider_id, model_id,
              model_options, status, started_at, write_fence)
            VALUES (${input.attemptId}, ${input.intentId}, ${input.targetId},
                    ${input.workerId}, ${input.harnessSessionId},
                    ${input.harnessInstanceId},
                    ${input.providerId}, ${input.modelId},
                    ${modelOptions === null ? null : JSON.stringify(modelOptions)},
                    'running', ${now}, 0)
            ON CONFLICT(id) DO NOTHING`.pipe(
            Effect.mapError(asDatabaseError("transaction")),
          );
          const attempt = yield* attemptOrFail(input.attemptId);
          if (before === undefined && attempt !== undefined) {
            yield* appendAttemptEvent({
              kind: "attempt.started",
              targetId: input.targetId,
              attemptId: input.attemptId,
              operation: "seed_attempt",
              payload: {
                attemptId: input.attemptId,
                intentId: input.intentId,
                goalId: input.goalId,
                workerId: input.workerId,
                harnessInstanceId: input.harnessInstanceId,
                providerId: input.providerId,
                modelId: input.modelId,
                modelOptions,
                harnessSessionId: input.harnessSessionId,
                replacesAttemptId: null,
              },
              recordedAt: now,
            });
          }
          return {
            attemptId: input.attemptId,
            writeFence: attempt?.write_fence ?? 0,
          } satisfies AttemptAuthority;
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          error._tag === "SqlError"
            ? asDatabaseError("transaction")(error)
            : error,
        ),
      );
  });

  /**
   * Records the attempt's terminal status. This says only whether execution finished;
   * it never implies anything about what the test established (DECISIONS.md §15).
   *
   * Guarded to `status = 'running'`. A worker settling its own attempt must not be able
   * to overwrite what reconciliation already decided about it — that would be the
   * terminal-regression this milestone exists to prevent, arriving from the other
   * direction. `changed: false` tells the caller it was already settled, and by what.
   *
   * **`attempt.settled` is appended only when the status actually moved.** `changed:
   * false` means this call wrote nothing, and an event with no domain change behind it
   * would break the one property that makes the log trustworthy. The settlement that did
   * happen already has its own event, written by whoever caused it.
   */
  const settleAttempt = Effect.fn("ObservationStore.settleAttempt")(function* (
    attemptId: string,
    status: AttemptTerminalStatus,
  ) {
    const endedAt = yield* Clock.currentTimeMillis;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const before = yield* attemptOrFail(attemptId);
          if (before === undefined) {
            return {
              requested: status,
              effective: undefined,
              changed: false,
            } satisfies AttemptSettlement;
          }
          if (before.status !== "running") {
            return {
              requested: status,
              effective: before.status as AttemptExecutionStatus,
              changed: false,
            } satisfies AttemptSettlement;
          }
          yield* sql`UPDATE attempts SET status = ${status}, ended_at = ${endedAt}
            WHERE id = ${attemptId} AND status = 'running'`.pipe(
            Effect.mapError(asDatabaseError("transaction")),
          );
          // The claim goes back in the same transaction the attempt settles in, so there
          // is no instant at which an attempt has settled and its intent still says it is
          // being worked, or the reverse.
          yield* releaseClaim(before.intent_id, status, attemptId);
          yield* appendAttemptEvent({
            kind: "attempt.settled",
            targetId: before.target_id,
            attemptId,
            operation: "settle_attempt",
            payload: {
              attemptId,
              intentId: before.intent_id,
              harnessSessionId: before.harness_session_id,
              status,
              priorStatus: before.status,
              // Said plainly, because the two writers of this event mean different
              // things: a supervisor that watched the run settle it, or a sweep that
              // found the row afterwards and could only reconcile it.
              settledBy: "supervisor",
              disposition: null,
            },
            recordedAt: endedAt,
          });
          return {
            requested: status,
            effective: status,
            changed: true,
          } satisfies AttemptSettlement;
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          error._tag === "SqlError"
            ? asDatabaseError("transaction")(error)
            : error,
        ),
      );
  });

  const bindSessionToAttempt = Effect.fn(
    "ObservationStore.bindSessionToAttempt",
  )(function* (attemptId: string, harnessSessionId: string) {
    yield* sql`UPDATE attempts SET harness_session_id = ${harnessSessionId}
      WHERE id = ${attemptId}`.pipe(Effect.mapError(asDatabaseError("query")));
    return harnessSessionId;
  });

  const findReceipt = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: StoredReceipt,
    execute: (key) =>
      sql`SELECT key, request_hash, result FROM command_receipts WHERE key = ${key}`,
  });

  const bumpSequence = SqlSchema.findOne({
    Request: Schema.String,
    Result: SequenceRow,
    execute: (name) =>
      sql`INSERT INTO sequence_cursor (name, value) VALUES (${name}, 1)
        ON CONFLICT(name) DO UPDATE SET value = value + 1
        RETURNING value`,
  });

  /**
   * Decodes a stored receipt's result through the operation's own schema.
   *
   * A replay hands back a value this store already committed, so it has to come back as
   * the type the caller was promised. Decoding rather than casting means a receipt whose
   * stored JSON no longer matches the contract is a {@link StoredRowError} naming the
   * receipt, not a value that type-checks and is wrong.
   */
  const replayResult = <A, I>(
    key: string,
    codec: Schema.Codec<A, I>,
    text: string,
  ): Effect.Effect<A, StoredRowError> =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(codec))(text).pipe(
      Effect.mapError(
        (issue) =>
          new StoredRowError({
            table: "command_receipts",
            rowId: key,
            detail: `the stored result no longer matches the contract: ${String(issue)}`,
            cause: issue,
          }),
      ),
    );

  /**
   * Appends one event, allocating its sequence inside the caller's transaction.
   *
   * Transaction-local by contract: it must be yielded from inside a
   * `sql.withTransaction` body, so the sequence bump, the event row and the domain
   * change it describes commit together or not at all. There is no path that writes an
   * event on its own, which is what makes "every event has a domain change behind it"
   * true rather than intended.
   *
   * The three identities are passed separately and never merged (§6). A host-originated
   * mutation passes `null` for all of caller scope, intent and attempt, because it has
   * no attempt — inventing one so the column could be `NOT NULL` would be the conflation
   * the separation exists to prevent.
   */
  const appendEvent = Effect.fnUntraced(function* (input: {
    readonly kind: string;
    readonly targetId: string;
    readonly callerScope: string | null;
    readonly intentId: string | null;
    readonly attemptId: string | null;
    readonly operation: string;
    readonly operationId: string | null;
    readonly subjectId: string;
    readonly payload: unknown;
    readonly recordedAt: number;
  }) {
    const cursor = yield* bumpSequence(EVENT_SEQUENCE_NAME).pipe(
      Effect.mapError(lift("sequence_cursor", EVENT_SEQUENCE_NAME)),
    );
    const sequence = cursor.value;
    const eventId = `evt_${sequence.toString().padStart(6, "0")}`;
    yield* sql`INSERT INTO events (
        id, sequence, target_id, kind, payload, caller_scope, intent_id, attempt_id,
        operation, operation_id, subject_id, recorded_at
      ) VALUES (
        ${eventId}, ${sequence}, ${input.targetId}, ${input.kind},
        ${JSON.stringify(input.payload)}, ${input.callerScope}, ${input.intentId},
        ${input.attemptId}, ${input.operation}, ${input.operationId},
        ${input.subjectId}, ${input.recordedAt}
      )`.pipe(Effect.mapError(asDatabaseError("transaction")));
    return { eventId, sequence };
  });

  /**
   * Appends one attempt-lifecycle event, in the caller's transaction.
   *
   * A thin wrapper over {@link appendEvent} that exists to make one decision once instead
   * of at three call sites: **the three caller-authority columns are all `null`, and the
   * attempt id goes in `subject_id`.**
   *
   * That looks wrong at a glance — an event about an attempt with a null `attempt_id` —
   * so the reasoning is here rather than in a reviewer's head. Those three columns are
   * *whose authority wrote this*, not *what it is about* (§6, and `contracts/event.ts`
   * states the invariant: for a host-originated mutation they are absent together). Both
   * of these are host-originated. `attempt.started` is written before any credential for
   * that attempt exists — the attempt row has to be there for a credential to be minted
   * against its fence — and `attempt.settled` is written by the supervisor or by the
   * recovery sweep, neither of which presents a worker credential. Filling the columns in
   * would claim the attempt wrote the record of its own beginning and end, which is
   * exactly the conflation the separation exists to prevent.
   *
   * Nothing is lost: the attempt is the event's *subject*, which is what `subject_id` is
   * for, and the payload carries the intent and the rest. A reader asking "what happened
   * to attempt X" matches `subject_id`, and the same query finds the row whether the
   * supervisor or the sweep wrote it.
   */
  const appendAttemptEvent = Effect.fnUntraced(function* (input: {
    readonly kind: "attempt.started" | "attempt.settled";
    readonly targetId: string;
    readonly attemptId: string;
    readonly operation: string;
    readonly payload: Record<string, unknown>;
    readonly recordedAt: number;
  }) {
    return yield* appendEvent({
      kind: input.kind,
      targetId: input.targetId,
      callerScope: null,
      intentId: null,
      attemptId: null,
      operation: input.operation,
      operationId: null,
      subjectId: input.attemptId,
      payload: input.payload,
      recordedAt: input.recordedAt,
    });
  });

  /**
   * Appends one round-lifecycle event, in the caller's transaction.
   *
   * {@link appendAttemptEvent}'s decision, for the same reason and with the same shape:
   * the three caller-authority columns are null and the **round** id goes in `subject_id`.
   * A round's beginning is written before a credential for it exists — the row has to be
   * there for one to be minted against its fence — and its end is written by the plan
   * supervisor or by the startup sweep, neither of which presents a round credential.
   * Filling the columns in would claim the round wrote the record of its own beginning and
   * end.
   *
   * There is deliberately no `intentId` either, even though a round's whole purpose is to
   * create intents. A round is not *about* one intent, and `intent_id` on this table means
   * "the intent whose authority wrote this".
   */
  const appendRoundEvent = Effect.fnUntraced(function* (input: {
    readonly kind: "plan.round.started" | "plan.round.settled";
    readonly targetId: string;
    readonly roundId: string;
    readonly operation: string;
    readonly payload: Record<string, unknown>;
    readonly recordedAt: number;
  }) {
    return yield* appendEvent({
      kind: input.kind,
      targetId: input.targetId,
      callerScope: null,
      intentId: null,
      attemptId: null,
      operation: input.operation,
      operationId: null,
      subjectId: input.roundId,
      payload: input.payload,
      recordedAt: input.recordedAt,
    });
  });

  /**
   * Enqueues one side-effect request, in the same transaction as its event.
   *
   * `causedByEventId` is a real foreign key, so a request cannot exist without the event
   * that explains it. The recovery policy is not a parameter: it is looked up from
   * {@link OUTBOX_RECOVERY_POLICIES}, because §6 requires one policy per effect *type*
   * and a per-call policy would let two writers disagree about whether the same remote
   * action may be repeated.
   *
   * Every row is written `pending` with no lease and no attempt count. Nothing in this
   * sprint moves it; Sprint 03 claims and dispatches.
   */
  const enqueueRequest = Effect.fnUntraced(function* (input: {
    readonly requestType: OutboxRequestType;
    readonly targetId: string;
    readonly payload: unknown;
    readonly causedByEventId: string;
    readonly enqueuedAt: number;
  }) {
    const cursor = yield* bumpSequence(OUTBOX_SEQUENCE_NAME).pipe(
      Effect.mapError(lift("sequence_cursor", OUTBOX_SEQUENCE_NAME)),
    );
    const sequence = cursor.value;
    const outboxId = `out_${sequence.toString().padStart(6, "0")}`;
    yield* sql`INSERT INTO outbox (
        id, sequence, target_id, request_type, payload, recovery_policy,
        caused_by_event_id, status, attempts, enqueued_at
      ) VALUES (
        ${outboxId}, ${sequence}, ${input.targetId}, ${input.requestType},
        ${JSON.stringify(input.payload)},
        ${OUTBOX_RECOVERY_POLICIES[input.requestType]},
        ${input.causedByEventId}, 'pending', 0, ${input.enqueuedAt}
      )`.pipe(Effect.mapError(asDatabaseError("transaction")));
    return { outboxId, sequence };
  });

  /**
   * The dimension one alias names, with the goal and intent its observation sits under.
   *
   * A join rather than a parse of a JSON column: the alias is resolved to a
   * `dimension_id`, and the scope check needs the raising observation's intent *and*
   * that intent's goal, because the rule relaxed to "same goal, when the caller's own
   * intent declares that dimension" (DECISIONS.md §17).
   */
  const findDimensionByPosition = SqlSchema.findOneOption({
    Request: Schema.Struct({
      observationId: Schema.String,
      position: Schema.Int,
    }),
    Result: Schema.Struct({
      dimension_id: Schema.String,
      source_intent_id: Schema.String,
      source_goal_id: Schema.String,
    }),
    execute: (request) =>
      sql`SELECT dimensions.id AS dimension_id,
            source.intent_id AS source_intent_id,
            source_intent.goal_id AS source_goal_id
          FROM observation_dimensions AS dimensions
          INNER JOIN observations AS source
            ON source.id = dimensions.observation_id
          INNER JOIN intents AS source_intent
            ON source_intent.id = source.intent_id
          WHERE dimensions.observation_id = ${request.observationId}
            AND dimensions.position = ${request.position}`,
  });

  /** How many dimensions one observation holds, for the out-of-range refusal only. */
  const countDimensionsOfObservation = SqlSchema.findOne({
    Request: Schema.String,
    Result: CountRow,
    execute: (observationId) =>
      sql`SELECT COUNT(*) AS value FROM observation_dimensions
          WHERE observation_id = ${observationId}`,
  });

  const observationExists = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ id: Schema.String }),
    execute: (observationId) =>
      sql`SELECT id FROM observations WHERE id = ${observationId}`,
  });

  /** The goal an intent sits under, and the dimension it declared it addresses. */
  const findIntentLineage = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({
      goal_id: Schema.String,
      addresses_dimension: Schema.NullOr(Schema.String),
    }),
    execute: (intentId) =>
      sql`SELECT goal_id, addresses_dimension FROM intents
          WHERE id = ${intentId}`,
  });

  const countObservationsForAttempt = SqlSchema.findOne({
    Request: Schema.String,
    Result: CountRow,
    execute: (attemptId) =>
      sql`SELECT COUNT(*) AS value FROM observations WHERE attempt_id = ${attemptId}`,
  });

  /**
   * The recovery row one pass keyed, read back by that whole key.
   *
   * Every column of the key is bound, so what this returns is the row the pass just
   * wrote or incremented and not a near-neighbour that happens to share three of its
   * columns. A caller is therefore told the values that are actually persisted.
   */
  const findRecoveryRecord = SqlSchema.findOne({
    Request: Schema.Struct({
      attemptId: Schema.String,
      observed: Schema.String,
      prior: Schema.String,
      resulting: Schema.String,
      disposition: Schema.String,
      fenceBefore: Schema.Int,
      fenceAfter: Schema.Int,
    }),
    Result: Schema.Struct({
      times: Schema.Int,
      fence_before: Schema.Int,
      fence_after: Schema.Int,
      first_reconciled_at: Schema.Finite,
    }),
    execute: (request) =>
      sql`SELECT times, fence_before, fence_after, first_reconciled_at
          FROM attempt_recoveries
          WHERE attempt_id = ${request.attemptId}
            AND observed_status = ${request.observed}
            AND prior_status = ${request.prior}
            AND resulting_status = ${request.resulting}
            AND disposition = ${request.disposition}
            AND fence_before = ${request.fenceBefore}
            AND fence_after = ${request.fenceAfter}`,
  });

  /** Lifts a `SqlSchema` failure, whose error channel carries both kinds. */
  const lift =
    (table: string, rowId: string) =>
    (error: { readonly _tag: string; readonly message: string }) =>
      error._tag === "SqlError"
        ? asDatabaseError("query")(error as never)
        : storedRow(table, rowId)(error);

  /**
   * Resolves one follow-up address against stored state, or refuses it.
   *
   * Everything here is exact. The address is parsed, the observation it names is looked
   * up by primary key, its intent is compared with the caller's authenticated intent,
   * and the position is bounds-checked against the list that row actually holds. There
   * is no nearest match, no text comparison and no "probably means": an address that
   * does not resolve is a refusal the worker can read and correct.
   */
  const resolveAddress = Effect.fnUntraced(function* (
    caller: AttemptCaller,
    address: string,
  ) {
    const parsed = parseDimensionAddress(address);
    if (parsed === undefined) {
      return yield* new MutationError({
        reason: "invalid",
        detail: `'${address}' is not an untested-dimension address; use the exact address from the briefing, e.g. obs_000003_attempt-x#u1`,
      });
    }
    const found = yield* findDimensionByPosition({
      observationId: parsed.observationId,
      position: parsed.index,
    }).pipe(Effect.mapError(lift("observation_dimensions", address)));
    if (Option.isNone(found)) {
      // Two different mistakes, told apart so the refusal is correctable. Both cost an
      // extra read, and only on the failing path.
      const exists = yield* observationExists(parsed.observationId).pipe(
        Effect.mapError(lift("observations", parsed.observationId)),
      );
      if (Option.isNone(exists)) {
        return yield* new MutationError({
          reason: "invalid",
          detail: `no observation ${parsed.observationId} exists, so address '${address}' cannot be addressed`,
        });
      }
      const held = yield* countDimensionsOfObservation(
        parsed.observationId,
      ).pipe(Effect.mapError(lift("observation_dimensions", address)));
      return yield* new MutationError({
        reason: "invalid",
        detail: `observation ${parsed.observationId} recorded ${String(held.value)} untested dimensions, so index ${String(parsed.index)} in '${address}' does not exist`,
      });
    }
    const dimension = found.value;
    if (dimension.source_intent_id === caller.intentId) {
      return {
        address,
        dimensionId: dimension.dimension_id,
        ...parsed,
      };
    }
    // The relaxation, and the whole of it: a caller may reach a dimension raised under a
    // *different* intent of the same goal, and only when its own intent recorded that
    // this is the dimension it addresses (migration `0009`). Authority is still checked
    // — it is checked against recorded lineage instead of an assumption — and the
    // caller's claim about its own intent is read from the row, never from the payload.
    const lineage = yield* findIntentLineage(caller.intentId).pipe(
      Effect.mapError(lift("intents", caller.intentId)),
    );
    if (Option.isNone(lineage)) {
      return yield* new MutationError({
        reason: "invalid",
        detail: `address '${address}' belongs to intent ${dimension.source_intent_id}, not to ${caller.intentId}`,
      });
    }
    if (lineage.value.goal_id !== dimension.source_goal_id) {
      return yield* new MutationError({
        reason: "invalid",
        detail: `address '${address}' was raised under goal ${dimension.source_goal_id} and intent ${caller.intentId} sits under goal ${lineage.value.goal_id}; an observation cannot address a dimension from another goal`,
      });
    }
    if (lineage.value.addresses_dimension !== dimension.dimension_id) {
      return yield* new MutationError({
        reason: "invalid",
        detail: `address '${address}' was raised by intent ${dimension.source_intent_id}, not ${caller.intentId}, and intent ${caller.intentId} does not declare that it addresses it; an intent may answer another intent's dimension of the same goal only when it was created saying so`,
      });
    }
    return { address, dimensionId: dimension.dimension_id, ...parsed };
  });

  const selectRoundById = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: RoundRow,
    execute: (id) =>
      sql.unsafe(`SELECT ${roundColumns} FROM planner_rounds WHERE id = ?`, [
        id,
      ]),
  });

  /**
   * Every round of one goal, newest first.
   *
   * Newest first because a goal's rounds are read to answer "what did the last one
   * conclude", and the ordering is `started_at` with `id` as the tie-break — round ids are
   * monotonic within a process, so the pair is a total order even for two rounds opened in
   * one millisecond.
   */
  const selectRoundsForGoal = SqlSchema.findAll({
    Request: Schema.String,
    Result: RoundRow,
    execute: (goalId) =>
      sql.unsafe(
        `SELECT ${roundColumns} FROM planner_rounds
         WHERE goal_id = ?
         ORDER BY started_at DESC, id DESC`,
        [goalId],
      ),
  });

  /** Reads one round inside whatever transaction is in force, or reports the row. */
  const roundOrFail = Effect.fnUntraced(function* (roundId: string) {
    const row = yield* selectRoundById(roundId).pipe(
      Effect.mapError((error) =>
        error._tag === "SqlError"
          ? asDatabaseError("query")(error)
          : storedRow("planner_rounds", roundId)(error),
      ),
    );
    return Option.getOrUndefined(row);
  });

  /**
   * A goal's ownership and lifecycle, which is all an authority check needs.
   *
   * Not {@link goalSelect}: that carries three correlated count subqueries for a list
   * row, and an authority check that paid for them would be paying to count observations
   * in order to answer "is this goal yours".
   */
  const goalAuthorityRow = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({
      id: Schema.String,
      target_id: Schema.String,
      status: GoalStatus,
    }),
    execute: (goalId) =>
      sql`SELECT id, target_id, status FROM goals WHERE id = ${goalId}`,
  });

  /* ── The authority paths ──────────────────────────────────────────────────────
   *
   * One path per {@link CallerContext} tag (the spec's decision 2), each making the
   * checks that kind of authority can actually make:
   *
   * - **attempt** — the attempt is registered for this target *and* intent, it is still
   *   `running`, and its fence is the one the credential carries.
   * - **round** — the round exists, belongs to this target *and* goal, is still
   *   `running`, and its fence is the one the credential carries.
   * - **goal** — the goal exists, belongs to this target, and has not ended. There is no
   *   fence to check: an ended goal is the thing that stops a goal credential, which is
   *   why the column does not exist (see {@link GoalCaller}).
   *
   * Each path is reached through a wrapper that takes the **union** and refuses a caller
   * of the wrong kind first, naming the write it refused. That order matters: "you are
   * not that kind of caller" is a different correction from "your authority has expired",
   * and a round credential presented for an observation deserves the first, not a
   * confusing report about a round it never named.
   *
   * Refusals keep the register the existing ones use: second person, saying what was
   * refused and what that means for the write just attempted.
   */

  /** Checks a worker attempt still holds write authority over the attempt it claims. */
  const checkAttemptAuthority = Effect.fnUntraced(function* (
    caller: AttemptCaller,
  ) {
    const attempt = yield* attemptOrFail(caller.attemptId);
    if (
      attempt === undefined ||
      attempt.target_id !== caller.targetId ||
      attempt.intent_id !== caller.intentId
    ) {
      return yield* new MutationError({
        reason: "unauthorized",
        detail: `attempt ${caller.attemptId} is not registered for target ${caller.targetId} and intent ${caller.intentId}`,
      });
    }
    if (attempt.status !== "running") {
      return yield* new MutationError({
        reason: "stale",
        detail: `attempt ${caller.attemptId} is ${attempt.status}; its write authority ended when it stopped running, so this observation was NOT recorded`,
      });
    }
    if (attempt.write_fence !== caller.attemptFence) {
      return yield* new MutationError({
        reason: "stale",
        detail: `write authority for attempt ${caller.attemptId} was revoked: this credential carries fence ${String(caller.attemptFence)} and the attempt is at ${String(attempt.write_fence)}`,
      });
    }
    return attempt;
  });

  /**
   * Checks a planner round still holds write authority over the round it claims.
   *
   * Four checks and no fifth: the round exists, it is this target's and this goal's, it is
   * `running`, and its fence is the one the credential carries.
   *
   * **It does not read `goals.status`, so a round authenticated before its goal ended
   * keeps writing until it settles.** Written down because it is exactly the kind of
   * absence a later reader would take for an oversight. It is the attempt rule, not an
   * omission: ending a goal records state and interrupts nothing (the spec's decision 8),
   * and {@link settleAttempt}'s authority check does not consult the goal either. A
   * planner round in flight is the same kind of thing as an attempt in flight — work the
   * operator may have reasons to let finish — and tearing its authority out from under it
   * mid-call would make a goal ending look to the planner like a broken server.
   *
   * What stops the work is **dispatch**, not this check. {@link openRound} refuses to open
   * a round under an ended goal, `claimIntent` refuses an intent whose goal has ended, and
   * `endGoal` is what makes both true. So an ended goal takes no new rounds and no new
   * attempts; the one round that was already running finishes and settles.
   *
   * The gap that would leave is narrow and real: a running round adding intents under a
   * goal nobody wants worked. **It is closed inside {@link addRoundIntent}**, which is
   * where the budget and duplicate rules already live and the only place a round writes to
   * the graph — a round caller whose goal is not `active` is refused there with
   * `RoundIntentRefused.goal_ended`. So what reaches this check under an ended goal is
   * `recordRoundDisposition`, which records what the round concluded about a goal that has
   * ended: a true statement, and the one this check is deliberately permissive for.
   *
   * An earlier version of this comment said slice 7 *would* close it and that nothing
   * called `add_intent` with a round caller yet. Both were true when written and a reader
   * would now conclude the gap is open.
   */
  const checkRoundAuthority = Effect.fnUntraced(function* (
    caller: RoundCaller,
  ) {
    const round = yield* roundOrFail(caller.roundId);
    if (
      round === undefined ||
      round.target_id !== caller.targetId ||
      round.goal_id !== caller.goalId
    ) {
      return yield* new MutationError({
        reason: "unauthorized",
        detail: `round ${caller.roundId} is not registered for target ${caller.targetId} and goal ${caller.goalId}`,
      });
    }
    if (round.status !== "running") {
      return yield* new MutationError({
        reason: "stale",
        detail: `round ${caller.roundId} is ${round.status}; its write authority ended when it stopped running, so nothing was recorded`,
      });
    }
    if (round.write_fence !== caller.roundFence) {
      return yield* new MutationError({
        reason: "stale",
        detail: `write authority for round ${caller.roundId} was revoked: this credential carries fence ${String(caller.roundFence)} and the round is at ${String(round.write_fence)}`,
      });
    }
    return round;
  });

  /**
   * Checks a goal agent's goal still exists, is this target's, and has not ended.
   *
   * Two refusals, not three. There is no fence because a goal credential has none, and
   * the reason is {@link GoalCaller}'s: grants live in memory, so one cannot survive a
   * restart to be replayed. An ended goal is what revokes this authority durably, and
   * ending a goal is exactly the act an operator or a planner performs to do it.
   */
  const checkGoalAuthority = Effect.fnUntraced(function* (caller: GoalCaller) {
    const goal = yield* goalAuthorityRow(caller.goalId).pipe(
      Effect.mapError(lift("goals", caller.goalId)),
    );
    if (Option.isNone(goal) || goal.value.target_id !== caller.targetId) {
      return yield* new MutationError({
        reason: "unauthorized",
        detail: `goal ${caller.goalId} is not registered for target ${caller.targetId}`,
      });
    }
    if (goal.value.status !== "active") {
      return yield* new MutationError({
        reason: "stale",
        detail: `goal ${caller.goalId} is ${goal.value.status}; its authority ended when the goal ended, so nothing was recorded`,
      });
    }
    return goal.value;
  });

  /**
   * Narrows the caller to a worker attempt and checks that attempt's authority.
   *
   * `write` is the thing being attempted, in the words the refusal should use ("record an
   * observation"). The kind check happens before any read, so a caller of the wrong kind
   * costs nothing and is told the one true thing: that this is not a write its authority
   * covers.
   *
   * It runs **before** the receipt lookup in the callers below, which looks like a
   * departure from their documented "receipt first, then authority" order and is not: a
   * receipt key is namespaced to `callerScope`, and no round or goal scope can ever hold
   * an observation receipt, so there is no replay this can refuse.
   */
  const attemptCallerOrFail = Effect.fnUntraced(function* (
    caller: CallerContext,
    write: string,
  ) {
    if (caller._tag !== "attempt") {
      return yield* new MutationError({
        reason: "unauthorized",
        detail: `${describeCaller(caller)} may not ${write}: that is a worker attempt's write, and nothing was recorded`,
      });
    }
    return caller;
  });

  /** Narrows the caller to a planner round. The round's own authority is checked after. */
  const roundCallerOrFail = Effect.fnUntraced(function* (
    caller: CallerContext,
    write: string,
  ) {
    if (caller._tag !== "round") {
      return yield* new MutationError({
        reason: "unauthorized",
        detail: `${describeCaller(caller)} may not ${write}: that is a planner round's write, and nothing was recorded`,
      });
    }
    return caller;
  });

  /**
   * Narrows the caller to a goal agent. The goal's own authority is checked by the write.
   *
   * {@link roundCallerOrFail}'s sibling. The two writes a goal agent makes — recording a
   * steer and ending the goal — both resolve the goal from `caller.goalId`, so this check
   * is what makes "an agent writes only about its own goal" a property of the type rather
   * than of care at each call site.
   */
  const goalCallerOrFail = Effect.fnUntraced(function* (
    caller: CallerContext,
    write: string,
  ) {
    if (caller._tag !== "goal") {
      return yield* new MutationError({
        reason: "unauthorized",
        detail: `${describeCaller(caller)} may not ${write}: that is a goal agent's write, and nothing was recorded`,
      });
    }
    return caller;
  });

  /**
   * What kind of authority this caller holds, checked against stored state.
   *
   * The public face of the three paths above, and the one place a later slice's tool
   * handler should ask "is this credential still good?" before it does anything on the
   * caller's behalf. The answer is tagged, so a handler that wants an attempt cannot read
   * a round's answer as one.
   */
  const callerAuthority = Effect.fn("ObservationStore.callerAuthority")(
    function* (caller: CallerContext) {
      switch (caller._tag) {
        case "attempt": {
          const attempt = yield* checkAttemptAuthority(caller);
          return {
            _tag: "attempt",
            attemptId: attempt.id,
            intentId: attempt.intent_id,
            targetId: attempt.target_id,
            fence: attempt.write_fence,
          } satisfies CallerAuthority;
        }
        case "round": {
          const round = yield* checkRoundAuthority(caller);
          return {
            _tag: "round",
            roundId: round.id,
            goalId: round.goal_id,
            targetId: round.target_id,
            fence: round.write_fence,
          } satisfies CallerAuthority;
        }
        case "goal": {
          const goal = yield* checkGoalAuthority(caller);
          return {
            _tag: "goal",
            goalId: goal.id,
            targetId: goal.target_id,
          } satisfies CallerAuthority;
        }
      }
    },
  );

  /**
   * Writes one observation under the authenticated caller's identity.
   *
   * Receipt semantics, unchanged: an exact retry of `operationId` returns the original
   * result with `replayed: true` and writes nothing; the same ID with different input
   * fails as a conflict and writes nothing. The receipt key is namespaced to
   * `caller.callerScope`, so one worker's operation IDs can never collide with or
   * address another's.
   *
   * **Order: receipt first, then authority.** A matching receipt is answered before the
   * attempt's authority is consulted, and that is deliberate. A replay writes nothing
   * and creates no external effect — it hands back a result this store already
   * committed, to the only caller whose scope can name it. Refusing it would make a
   * transport retry that crossed a settlement boundary look like lost evidence, which
   * is the one thing a worker must never be told wrongly. A *new* write is where
   * authority is enforced, because that is where something would actually change.
   *
   * All of it — the receipt lookup, the authority check, the address resolution, the
   * sequence bump, the observation insert, the follow-up links and the receipt insert —
   * runs in one transaction. A refusal short-circuits by failing inside it, which rolls
   * it back; that is why the sequence cannot advance on a refused call and why a
   * half-linked observation cannot exist.
   *
   * `recordedAt` comes from the `Clock`, not `Date.now()`, so a test can fix it.
   */
  const recordObservation = Effect.fn("ObservationStore.recordObservation")(
    function* (caller: CallerContext, input: RecordObservationInput) {
      // The kind check first, so a planner round or a goal agent presenting a credential
      // here is told the one true thing: this is a worker's write. See
      // `attemptCallerOrFail` on why that may precede the receipt lookup.
      const worker = yield* attemptCallerOrFail(
        caller,
        "record an observation",
      );
      const recordedAt = yield* Clock.currentTimeMillis;
      const key = `${worker.callerScope}:record_observation:${input.operationId}`;
      const requestHash = hashRequest(worker, input);

      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const existing = yield* findReceipt(key).pipe(
              Effect.mapError(lift("command_receipts", key)),
            );

            if (Option.isSome(existing)) {
              const receipt = existing.value;
              if (receipt.request_hash !== requestHash) {
                return yield* new MutationError({
                  reason: "conflict",
                  detail: `operation ${input.operationId} was already used with different input`,
                });
              }
              const original = yield* replayResult(
                key,
                RecordObservationResult,
                receipt.result,
              );
              return { ...original, replayed: true };
            }

            yield* checkAttemptAuthority(worker);

            // Duplicates are refused rather than collapsed: the primary key would
            // swallow the second silently, and a worker that sent the same address
            // twice has made a mistake worth telling it about.
            const seen = new Set<string>();
            for (const address of input.addressesDimensions) {
              if (seen.has(address)) {
                return yield* new MutationError({
                  reason: "invalid",
                  detail: `address '${address}' is listed twice in addresses_dimensions`,
                });
              }
              seen.add(address);
            }
            const addressed = yield* Effect.forEach(
              input.addressesDimensions,
              (address) => resolveAddress(worker, address),
            );

            // Allocated inside the transaction, so a sequence gap cannot outlive a rollback.
            const cursor = yield* bumpSequence(SEQUENCE_NAME).pipe(
              Effect.mapError(lift("sequence_cursor", SEQUENCE_NAME)),
            );
            const sequence = cursor.value;

            const observationId = `obs_${sequence.toString().padStart(6, "0")}_${worker.attemptId}`;
            const provenance: ObservationProvenance = {
              targetId: worker.targetId,
              intentId: worker.intentId,
              attemptId: worker.attemptId,
              harnessSessionId: worker.harnessSessionId,
              workerId: worker.workerId,
              recordedAt,
            };

            yield* sql`INSERT INTO observations (
              id, sequence, record_format, target_id, intent_id, attempt_id,
              harness_session_id, worker_id, tested_claim, outcome, interpretation,
              limitations, untested_dimensions, recorded_at, setup, cases,
              summary_conditions, summary_observed_behavior, summary_evidence_refs
            ) VALUES (
              ${observationId}, ${sequence}, ${STORED_FORMAT[OBSERVATION_WRITE_FORMAT]},
              ${worker.targetId}, ${worker.intentId}, ${worker.attemptId},
              ${worker.harnessSessionId}, ${worker.workerId},
              ${input.testedClaim}, ${input.outcome}, ${input.interpretation},
              ${JSON.stringify(input.limitations)},
              ${JSON.stringify(input.untestedDimensions)},
              ${recordedAt}, ${input.setup}, ${JSON.stringify(input.cases)},
              NULL, NULL, NULL
            )`.pipe(Effect.mapError(asDatabaseError("transaction")));

            // This observation's own untested dimensions, as rows with their own
            // identities (migration `0008`). Written here, in the same transaction as
            // the observation and from the same list, which is what makes the JSON
            // column and these rows two views of one write rather than two records that
            // can drift. Position is the index in the submitted list, so the wire alias
            // the briefing prints resolves back to the row this loop created.
            for (const [position, text] of input.untestedDimensions.entries()) {
              yield* sql`INSERT INTO observation_dimensions (
                id, observation_id, position, text, created_at
              ) VALUES (
                ${newDimensionId()}, ${observationId}, ${position}, ${text},
                ${recordedAt}
              )`.pipe(Effect.mapError(asDatabaseError("transaction")));
            }

            // After the observation row, because both link columns are real foreign
            // keys and SQLite checks them immediately.
            for (const link of addressed) {
              yield* sql`INSERT INTO observation_dimension_links (
                observation_id, dimension_id, address, created_at
              ) VALUES (
                ${observationId}, ${link.dimensionId}, ${link.address},
                ${recordedAt}
              )`.pipe(Effect.mapError(asDatabaseError("transaction")));
            }

            const result: RecordObservationResult = {
              observationId,
              sequence,
              replayed: false,
              provenance,
            };

            yield* sql`INSERT INTO command_receipts (
              key, caller_scope, operation, operation_id, request_hash, result, created_at
            ) VALUES (
              ${key}, ${worker.callerScope}, 'record_observation',
              ${input.operationId}, ${requestHash}, ${JSON.stringify(result)},
              ${recordedAt}
            )`.pipe(Effect.mapError(asDatabaseError("transaction")));

            // The event and the obligation it implies, in this same transaction. A
            // refusal above rolled back before reaching here, which is why a conflicting
            // retry writes no event and no outbox row either — not because the code
            // checks for one, but because there is no path to this point that is not
            // committing everything.
            const event = yield* appendEvent({
              kind: "observation.recorded",
              targetId: worker.targetId,
              callerScope: worker.callerScope,
              intentId: worker.intentId,
              attemptId: worker.attemptId,
              operation: "record_observation",
              operationId: input.operationId,
              subjectId: observationId,
              payload: {
                observationId,
                sequence,
                outcome: input.outcome,
                testedClaim: input.testedClaim,
                addressedDimensionIds: addressed.map(
                  (link) => link.dimensionId,
                ),
                untestedDimensionCount: input.untestedDimensions.length,
              },
              recordedAt,
            });
            yield* enqueueRequest({
              requestType: "notification.deliver",
              targetId: worker.targetId,
              payload: {
                subject: "observation.recorded",
                observationId,
                intentId: worker.intentId,
                outcome: input.outcome,
                testedClaim: input.testedClaim,
              },
              causedByEventId: event.eventId,
              enqueuedAt: recordedAt,
            });

            return result;
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error._tag === "SqlError"
              ? asDatabaseError("transaction")(error)
              : error,
          ),
        );
    },
  );

  const findAssetByIdentity = SqlSchema.findOneOption({
    Request: Schema.Struct({
      targetId: Schema.String,
      kind: Schema.String,
      identity: Schema.String,
    }),
    Result: Schema.Struct({ id: Schema.String, first_seen_at: Schema.Finite }),
    execute: (request) =>
      sql`SELECT id, first_seen_at FROM assets
          WHERE target_id = ${request.targetId}
            AND kind = ${request.kind}
            AND identity = ${request.identity}`,
  });

  const countDiscoveries = SqlSchema.findOne({
    Request: Schema.String,
    Result: CountRow,
    execute: (assetId) =>
      sql`SELECT COUNT(*) AS value FROM asset_discoveries
          WHERE asset_id = ${assetId}`,
  });

  /**
   * Records one asset under the authenticated caller's identity, merging on domain
   * identity and keeping every discovery.
   *
   * This is the third of §6's three identities, and the only place in this store where
   * all three are visibly distinct in one call. **Caller authority** decides which target
   * the asset lands in and is read from the credential, never from the payload — a worker
   * cannot record an asset against another engagement by asking. **Operation identity**
   * is `operationId`, namespaced to the caller's scope, and an exact retry replays with
   * `replayed: true` having written nothing. **Domain identity** is the canonical form
   * from `assetIdentityOf`: a second, genuinely different operation that finds the same
   * canonical asset does *not* create a second asset and does *not* overwrite the first
   * discovery — it adds a discovery row. One asset, two provenance records, which is
   * exactly what §6 requires of a merge.
   *
   * The merge is `ON CONFLICT DO NOTHING` followed by a read, rather than a read followed
   * by a conditional insert: inside one transaction both are correct, and letting the
   * unique index decide means the schema is what enforces identity rather than this
   * function's control flow.
   *
   * `created` and `replayed` are separate booleans because they answer different
   * questions. `replayed` means this command had already been accepted. `created: false`
   * with `replayed: false` means a new command found a known asset — new knowledge about
   * where it was seen, no new asset.
   */
  /* ── Target scope: the entries, the labels, and the one effective read ─────────── */

  const ScopeEntryRow = Schema.Struct({
    id: Schema.String,
    target_id: Schema.String,
    effect: ScopeEffect,
    kind: ScopeKind,
    value: Schema.String,
    source: ScopeEntrySource,
    note: Schema.NullOr(Schema.String),
    created_at: Schema.Finite,
  });
  const scopeEntryColumns = Object.keys(ScopeEntryRow.fields).join(", ");

  const selectScopeEntries = SqlSchema.findAll({
    Request: Schema.String,
    Result: ScopeEntryRow,
    execute: (targetId) =>
      sql.unsafe(
        `SELECT ${scopeEntryColumns} FROM scope_entries WHERE target_id = ?
         ORDER BY effect, kind, value`,
        [targetId],
      ),
  });

  /**
   * One entry under the opposite effect with the same kind and value, if there is one.
   *
   * This is what makes D2's contradiction refusal possible. The unique index is per
   * effect, so the database would happily hold `in`/`host`/`blog.acme.com` beside
   * `out`/`host`/`blog.acme.com`; this read is how the write path notices.
   */
  const findOpposingScopeEntry = SqlSchema.findOneOption({
    Request: Schema.Struct({
      targetId: Schema.String,
      effect: Schema.String,
      kind: Schema.String,
      value: Schema.String,
    }),
    Result: Schema.Struct({ id: Schema.String, effect: Schema.String }),
    execute: (request) =>
      sql`SELECT id, effect FROM scope_entries
          WHERE target_id = ${request.targetId}
            AND kind = ${request.kind}
            AND value = ${request.value}
            AND effect = ${request.effect}`,
  });

  const findScopeEntryById = SqlSchema.findOneOption({
    Request: Schema.Struct({ targetId: Schema.String, entryId: Schema.String }),
    Result: ScopeEntryRow,
    execute: (request) =>
      sql.unsafe(
        `SELECT ${scopeEntryColumns} FROM scope_entries
         WHERE target_id = ? AND id = ?`,
        [request.targetId, request.entryId],
      ),
  });

  const HostLabelRow = Schema.Struct({
    target_id: Schema.String,
    host: Schema.String,
    state: ScopeLabelState,
    reason: Schema.NullOr(Schema.String),
    set_by: Schema.String,
    set_at: Schema.Finite,
  });
  const hostLabelColumns = Object.keys(HostLabelRow.fields).join(", ");

  const selectHostLabels = SqlSchema.findAll({
    Request: Schema.String,
    Result: HostLabelRow,
    execute: (targetId) =>
      sql.unsafe(
        `SELECT ${hostLabelColumns} FROM host_scope_labels WHERE target_id = ?
         ORDER BY host`,
        [targetId],
      ),
  });

  const AssetLabelRow = Schema.Struct({
    asset_id: Schema.String,
    state: ScopeLabelState,
    reason: Schema.NullOr(Schema.String),
    set_by: Schema.String,
    set_at: Schema.Finite,
  });
  const assetLabelColumns = Object.keys(AssetLabelRow.fields).join(", ");

  /**
   * Every asset label in this file, joined to `assets` only to bound it to one target.
   *
   * `asset_scope_labels` has no `target_id` of its own — its key references `assets(id)`,
   * which has one — so the target filter goes through the join rather than being a column
   * that could disagree with the asset's.
   */
  /**
   * Every asset label in this file, with the identity and host of the asset it is on.
   *
   * The join is already needed to bound the read to one target — `asset_scope_labels` has
   * no `target_id` of its own, by design, because its key references `assets(id)` which
   * has one — so the asset's `identity` and `host` come back for free. The prompt block
   * names a labelled asset by its identity, and a host-keyed lookup needs its host, so
   * carrying both here is cheaper than a second read and cannot disagree with the row.
   */
  const selectAssetLabels = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({
      ...AssetLabelRow.fields,
      identity: Schema.String,
      host: Schema.String,
    }),
    execute: (targetId) =>
      sql.unsafe(
        `SELECT ${assetLabelColumns
          .split(", ")
          .map((column) => `asset_scope_labels.${column}`)
          .join(", ")},
           assets.identity AS identity,
           assets.host AS host
         FROM asset_scope_labels
         INNER JOIN assets ON assets.id = asset_scope_labels.asset_id
         WHERE assets.target_id = ?
         ORDER BY asset_scope_labels.asset_id`,
        [targetId],
      ),
  });

  /** The asset a label is about, so a write can refuse one for another target's row. */
  const findAssetForLabel = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({
      id: Schema.String,
      target_id: Schema.String,
      host: Schema.String,
      identity: Schema.String,
    }),
    execute: (assetId) =>
      sql`SELECT id, target_id, host, identity FROM assets WHERE id = ${assetId}`,
  });

  /** One stored entry row as the contract's {@link ScopeEntry}. */
  const scopeEntryOf = (row: typeof ScopeEntryRow.Type): ScopeEntry => ({
    entryId: row.id,
    targetId: row.target_id,
    effect: row.effect,
    kind: row.kind,
    value: row.value,
    source: row.source,
    note: row.note,
    createdAt: row.created_at,
  });

  const hostLabelOf = (row: typeof HostLabelRow.Type): HostScopeLabel => ({
    targetId: row.target_id,
    host: row.host,
    state: row.state,
    reason: row.reason,
    setBy: row.set_by,
    setAt: row.set_at,
  });

  const assetLabelOf = (row: typeof AssetLabelRow.Type): AssetScopeLabel => ({
    assetId: row.asset_id,
    state: row.state,
    reason: row.reason,
    setBy: row.set_by,
    setAt: row.set_at,
  });

  /**
   * Everything the derivation needs for one target, in three statements.
   *
   * The unit of reading, because `scopeStateOf` takes the entries and the two labels
   * already looked up. A caller that wanted to decide one subject and read the entries
   * itself would be the second code path that can disagree about whether a host is in
   * scope, which is an anti-goal this design names outright.
   */
  const readScope = Effect.fnUntraced(function* (targetId: string) {
    const entries = yield* selectScopeEntries(targetId).pipe(
      Effect.mapError(lift("scope_entries", targetId)),
    );
    const hosts = yield* selectHostLabels(targetId).pipe(
      Effect.mapError(lift("host_scope_labels", targetId)),
    );
    const assets = yield* selectAssetLabels(targetId).pipe(
      Effect.mapError(lift("asset_scope_labels", targetId)),
    );
    return {
      entries: entries.map(scopeEntryOf),
      hostLabels: new Map(hosts.map((row) => [row.host, hostLabelOf(row)])),
      assetLabels: new Map(
        assets.map((row) => [row.asset_id, assetLabelOf(row)]),
      ),
      /**
       * The labelled assets with the identity the prompt block names them by.
       *
       * Kept beside the map rather than folded into it: the ladder looks a label up by
       * asset id and does not care what the asset is called, while the block has to print
       * `GET https://app.acme.test:443/internal/metrics` for a reader to act on. One read
       * answers both.
       */
      labelledAssets: assets.map((row) => ({
        label: assetLabelOf(row),
        identity: row.identity,
        host: row.host,
      })),
    };
  });

  const recordAsset = Effect.fn("ObservationStore.recordAsset")(function* (
    caller: CallerContext,
    input: RecordAssetInput,
  ) {
    const worker = yield* attemptCallerOrFail(caller, "record an asset");
    const recordedAt = yield* Clock.currentTimeMillis;
    const key = `${worker.callerScope}:record_asset:${input.operationId}`;
    const requestHash = hashRequest(worker, input);
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* findReceipt(key).pipe(
            Effect.mapError(lift("command_receipts", key)),
          );
          // Receipt before authority, for the reason recorded on `recordObservation`: a
          // replay writes nothing and creates no external effect, and refusing it would
          // make a transport retry across a settlement boundary look like lost work.
          if (Option.isSome(existing)) {
            const receipt = existing.value;
            if (receipt.request_hash !== requestHash) {
              return yield* new MutationError({
                reason: "conflict",
                detail: `operation ${input.operationId} was already used with different input`,
              });
            }
            const original = yield* replayResult(
              key,
              RecordAssetResult,
              receipt.result,
            );
            return { ...original, replayed: true };
          }

          yield* checkAttemptAuthority(worker);

          const identity = assetIdentityOf(input);
          if (isAssetIdentityRefusal(identity)) {
            return yield* new MutationError({
              reason: "invalid",
              detail: identity.detail,
            });
          }

          /*
           * `created` is read off the insert, not off a timestamp.
           *
           * `ON CONFLICT DO NOTHING RETURNING id` yields one row when this statement wrote
           * the asset and none when the unique index already held it, which is exactly
           * what `created` reports. The earlier form compared the stored `first_seen_at`
           * to this call's own clock reading, which holds only while no two writes share a
           * millisecond — so a second discovery landing in the same millisecond as the
           * first reported `created: true` and claimed a known asset was new.
           *
           * It was not theoretical: `store.test.ts`'s endpoint-merge case failed
           * intermittently on a fast machine, and `importAsset` — which records every host
           * off one page in one loop — would have had the collision as its normal case.
           */
          const inserted = yield* sql<{
            readonly id: string;
          }>`INSERT INTO assets (
              id, target_id, kind, identity, host, port, scheme, method, path,
              first_seen_at
            ) VALUES (
              ${identifier.newAssetId()}, ${worker.targetId}, ${identity.kind},
              ${identity.identity}, ${identity.host}, ${identity.port},
              ${identity.scheme}, ${identity.method}, ${identity.path},
              ${recordedAt}
            )
            ON CONFLICT(target_id, kind, identity) DO NOTHING
            RETURNING id`.pipe(Effect.mapError(asDatabaseError("transaction")));
          const created = inserted.length > 0;
          const stored = yield* findAssetByIdentity({
            targetId: worker.targetId,
            kind: identity.kind,
            identity: identity.identity,
          }).pipe(Effect.mapError(lift("assets", identity.identity)));
          if (Option.isNone(stored)) {
            // Unreachable: the insert either wrote the row or found it already there,
            // inside this transaction. Reported rather than asserted away, because an
            // `ON CONFLICT DO NOTHING` whose row then cannot be read would mean the
            // unique index and this query disagree about identity.
            return yield* new DatabaseError({
              operation: "transaction",
              reason: `asset ${identity.identity} was neither inserted nor found`,
              cause: identity,
            });
          }
          const asset = stored.value;

          yield* sql`INSERT INTO asset_discoveries (
              asset_id, operation_id, caller_scope, intent_id, attempt_id,
              discovered_as, note, discovered_at
            ) VALUES (
              ${asset.id}, ${input.operationId}, ${worker.callerScope},
              ${worker.intentId}, ${worker.attemptId}, ${input.url},
              ${input.note}, ${recordedAt}
            )`.pipe(Effect.mapError(asDatabaseError("transaction")));

          const discoveries = yield* countDiscoveries(asset.id).pipe(
            Effect.mapError(lift("asset_discoveries", asset.id)),
          );

          /*
           * The asset's scope state, reported on the write.
           *
           * D9: a worker that records an out-of-scope host is told so immediately rather
           * than finding out never. It is **not** a gate — the rows above are already
           * written and this transaction is not going to refuse them — and the sentence
           * says so, because `out` on a target with nothing authored means "nothing
           * covers this yet" rather than "you were denied".
           *
           * Read inside the same transaction as the write, so the state reported is the
           * state as of the moment the asset landed rather than a slightly later one.
           */
          const scope = yield* readScope(worker.targetId);
          const scopeState = scopeStateOf({
            entries: scope.entries,
            hostLabel: scope.hostLabels.get(identity.host),
            assetLabel: scope.assetLabels.get(asset.id),
            subject: { host: identity.host },
          });

          const result: RecordAssetResult = {
            assetId: asset.id,
            kind: identity.kind,
            identity: identity.identity,
            created,
            replayed: false,
            discoveries: discoveries.value,
            scopeState: scopeState.state,
            scopeDetail: describeScopeState(scopeState),
          };

          yield* sql`INSERT INTO command_receipts (
              key, caller_scope, operation, operation_id, request_hash, result,
              created_at
            ) VALUES (
              ${key}, ${worker.callerScope}, 'record_asset', ${input.operationId},
              ${requestHash}, ${JSON.stringify(result)}, ${recordedAt}
            )`.pipe(Effect.mapError(asDatabaseError("transaction")));

          const event = yield* appendEvent({
            kind: "asset.recorded",
            targetId: worker.targetId,
            callerScope: worker.callerScope,
            intentId: worker.intentId,
            attemptId: worker.attemptId,
            operation: "record_asset",
            operationId: input.operationId,
            subjectId: asset.id,
            payload: {
              assetId: asset.id,
              kind: identity.kind,
              identity: identity.identity,
              created,
              discoveredAs: input.url,
            },
            recordedAt,
          });
          yield* enqueueRequest({
            requestType: "asset.enrich",
            targetId: worker.targetId,
            payload: {
              assetId: asset.id,
              kind: identity.kind,
              identity: identity.identity,
              host: identity.host,
              port: identity.port,
            },
            causedByEventId: event.eventId,
            enqueuedAt: recordedAt,
          });

          return result;
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          error._tag === "SqlError"
            ? asDatabaseError("transaction")(error)
            : error,
        ),
      );
  });

  const countImports = SqlSchema.findOne({
    Request: Schema.String,
    Result: CountRow,
    execute: (assetId) =>
      sql`SELECT COUNT(*) AS value FROM asset_imports
          WHERE asset_id = ${assetId}`,
  });

  /**
   * Records one asset the scope importer read off a program page (D14).
   *
   * {@link recordAsset}'s sibling, and the differences are the decision rather than
   * convenience.
   *
   * **The caller is the operator's authority, not an attempt's.** A {@link HostContext},
   * the same thing `addScopeEntry` and `setHostScopeLabel` take, so there is no credential
   * path that reaches here at all — which is what makes this write available to the
   * importer in the first place. `recordAsset` opens with `attemptCallerOrFail` and this
   * deliberately does not: there is no attempt to authenticate, because the importer
   * finishes before any goal, intent or attempt exists. The target comes from the caller
   * and never from the payload, exactly as it does for a worker.
   *
   * **The provenance row goes in `asset_imports`, and `asset_discoveries` is untouched.**
   * Its `intent_id` and `attempt_id` stay `NOT NULL`: see `0023`'s commentary for why the
   * invariant is worth a second table, and `0010`'s for what the invariant buys.
   *
   * **The `assets` row is the same row a worker would have written.** Same
   * `assetIdentityOf`, same unique index, same `ON CONFLICT DO NOTHING` letting the index
   * decide identity rather than this function's control flow. So a host this imports and
   * the same host a worker later discovers are one asset with one row in each provenance
   * table, in either order — and `created: false` with `imports: 1` is what "the worker
   * got here first" looks like from this side.
   *
   * **Retry semantics are `recordAsset`'s**, keyed on `operationId` under the operator's
   * scope: an exact retry replays the stored result having written nothing, and the same
   * id with different input is a `conflict`. The primary key on `(asset_id, operation_id)`
   * is the schema half of the same claim.
   *
   * **It enqueues no `asset.enrich` request, and that is a decision.** `recordAsset` does,
   * because a worker's discovery happens inside a live hunt. An import happens at target
   * creation, and D13's control rests on one property: creating a target starts no work,
   * so the operator's review of the imported scope sits in a real gap before the first
   * execution. Enrichment is "resolving a name, fingerprinting a service"
   * (`contracts/event.ts`) — traffic to the client's estate. Queuing it here would put
   * work against a scraped host *before* the person reviewing the scrape saw it, which is
   * the one thing that property exists to prevent. The asset can be enriched when a hunt
   * reaches it.
   */
  const importAsset = Effect.fn("ObservationStore.importAsset")(function* (
    caller: HostContext,
    input: ImportAssetInput,
  ) {
    const importedAt = yield* Clock.currentTimeMillis;
    const key = `${caller.callerScope}:import_asset:${input.operationId}`;
    const requestHash = hashRequest(caller, input);
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* findReceipt(key).pipe(
            Effect.mapError(lift("command_receipts", key)),
          );
          if (Option.isSome(existing)) {
            const receipt = existing.value;
            if (receipt.request_hash !== requestHash) {
              return yield* new MutationError({
                reason: "conflict",
                detail: `operation ${input.operationId} was already used with different input`,
              });
            }
            const original = yield* replayResult(
              key,
              ImportAssetResult,
              receipt.result,
            );
            return { ...original, replayed: true };
          }

          const identity = assetIdentityOf(input);
          if (isAssetIdentityRefusal(identity)) {
            return yield* new MutationError({
              reason: "invalid",
              detail: identity.detail,
            });
          }

          /*
           * The merge, and **`created` read off the insert rather than off a timestamp.**
           *
           * `ON CONFLICT DO NOTHING RETURNING id` yields one row when this statement wrote
           * the asset and no rows when the unique index already held it, which is the
           * exact fact `created` is supposed to report. `recordAsset` derives the same
           * boolean by comparing the stored `first_seen_at` to its own clock reading, and
           * that is true only as long as no two writes share a millisecond. An importer is
           * precisely the caller that breaks it: it records every host off one page in one
           * loop, so same-millisecond writes are the normal case rather than a race, and a
           * second import of a host already imported would report `created: true`.
           *
           * (That derivation is `recordAsset`'s and is left alone here — it is outside this
           * slice — but it is a real latent bug there, and `store.test.ts`'s endpoint-merge
           * test fails intermittently on a fast machine because of it.)
           */
          const inserted = yield* sql<{
            readonly id: string;
          }>`INSERT INTO assets (
              id, target_id, kind, identity, host, port, scheme, method, path,
              first_seen_at
            ) VALUES (
              ${identifier.newAssetId()}, ${caller.targetId}, ${identity.kind},
              ${identity.identity}, ${identity.host}, ${identity.port},
              ${identity.scheme}, ${identity.method}, ${identity.path},
              ${importedAt}
            )
            ON CONFLICT(target_id, kind, identity) DO NOTHING
            RETURNING id`.pipe(Effect.mapError(asDatabaseError("transaction")));
          const created = inserted.length > 0;
          const stored = created
            ? undefined
            : yield* findAssetByIdentity({
                targetId: caller.targetId,
                kind: identity.kind,
                identity: identity.identity,
              }).pipe(Effect.mapError(lift("assets", identity.identity)));
          const assetId =
            inserted[0]?.id ??
            (stored !== undefined && Option.isSome(stored)
              ? stored.value.id
              : undefined);
          if (assetId === undefined) {
            // Unreachable, for `recordAsset`'s reason: the insert either wrote the row or
            // the unique index already held it, inside this transaction. Reported rather
            // than asserted away, because an `ON CONFLICT DO NOTHING` whose row then
            // cannot be read would mean the index and this query disagree about identity.
            return yield* new DatabaseError({
              operation: "transaction",
              reason: `asset ${identity.identity} was neither inserted nor found`,
              cause: identity,
            });
          }

          yield* sql`INSERT INTO asset_imports (
              asset_id, operation_id, caller_scope, source_url, imported_as, note,
              imported_at
            ) VALUES (
              ${assetId}, ${input.operationId}, ${caller.callerScope},
              ${input.sourceUrl}, ${input.url}, ${input.note}, ${importedAt}
            )`.pipe(Effect.mapError(asDatabaseError("transaction")));

          const imports = yield* countImports(assetId).pipe(
            Effect.mapError(lift("asset_imports", assetId)),
          );

          /*
           * The asset's scope state, from the one ladder read.
           *
           * `readScope` and `scopeStateOf`, the same pair `recordAsset` and
           * `assetsWithScope` use. D3 and D5 both forbid a second implementation of this,
           * and the importer is the caller with the most to lose from one: it is the thing
           * that just wrote the entries this is derived from, so a ladder that disagreed
           * with the Scope tab would be disagreeing with its own work.
           *
           * Read inside the transaction, so the state reported is the state as of the
           * moment the asset landed.
           */
          const scope = yield* readScope(caller.targetId);
          const scopeState = scopeStateOf({
            entries: scope.entries,
            hostLabel: scope.hostLabels.get(identity.host),
            assetLabel: scope.assetLabels.get(assetId),
            subject: { host: identity.host },
          });

          const result: ImportAssetResult = {
            assetId,
            kind: identity.kind,
            identity: identity.identity,
            created,
            replayed: false,
            imports: imports.value,
            scopeState: scopeState.state,
            scopeDetail: describeScopeState(scopeState),
          };

          yield* sql`INSERT INTO command_receipts (
              key, caller_scope, operation, operation_id, request_hash, result,
              created_at
            ) VALUES (
              ${key}, ${caller.callerScope}, 'import_asset', ${input.operationId},
              ${requestHash}, ${JSON.stringify(result)}, ${importedAt}
            )`.pipe(Effect.mapError(asDatabaseError("transaction")));

          yield* appendEvent({
            kind: "asset.imported",
            targetId: caller.targetId,
            callerScope: caller.callerScope,
            /*
             * Null, and honestly so (§6, and `contracts/event.ts`'s invariant). These two
             * columns are caller authority, and this caller has none of either kind:
             * inventing an intent so a column could be filled is the conflation the
             * separation exists to prevent, and is the same move a nullable
             * `asset_discoveries.intent_id` would have made in the provenance row.
             */
            intentId: null,
            attemptId: null,
            operation: "import_asset",
            operationId: input.operationId,
            subjectId: assetId,
            payload: {
              assetId,
              kind: identity.kind,
              identity: identity.identity,
              created,
              importedAs: input.url,
              sourceUrl: input.sourceUrl,
            },
            recordedAt: importedAt,
          });

          return result;
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          error._tag === "SqlError"
            ? asDatabaseError("transaction")(error)
            : error,
        ),
      );
  });

  const findGoal = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ id: Schema.String, target_id: Schema.String }),
    execute: (goalId) =>
      sql`SELECT id, target_id FROM goals WHERE id = ${goalId}`,
  });

  /** An anchor candidate, resolved to whatever kind of node it actually is. */
  const classifyAnchor = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({
      as_observation_goal: Schema.NullOr(Schema.String),
      as_intent: Schema.NullOr(Schema.String),
      as_goal: Schema.NullOr(Schema.String),
    }),
    execute: (nodeId) =>
      sql`SELECT
            (SELECT intents.goal_id FROM observations
               INNER JOIN intents ON intents.id = observations.intent_id
             WHERE observations.id = ${nodeId}) AS as_observation_goal,
            (SELECT id FROM intents WHERE id = ${nodeId}) AS as_intent,
            (SELECT id FROM goals WHERE id = ${nodeId}) AS as_goal`,
  });

  const findIntentById = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ id: Schema.String }),
    execute: (intentId) => sql`SELECT id FROM intents WHERE id = ${intentId}`,
  });

  /**
   * How many intents one caller scope has committed, from its own receipts.
   *
   * **The receipt table is the count, and it is exact rather than approximate.** A
   * receipt row is written inside the same transaction as the intent it describes, so
   * there is no window in which one exists without the other; a replayed `operation_id`
   * matches an existing receipt and writes neither, so a transport retry does not inflate
   * the number; and a refused call rolls the transaction back, so nothing is counted for an
   * intent that was not created.
   *
   * It relies on one property, stated because the count is a budget and a budget that
   * could be spent by somebody else would be a bug: **a caller scope names exactly one
   * round**. `callerScopeOf` builds it as `<targetId>/round/<roundId>` from ids minted by
   * `identifier.ts`, never from anything a model or an operator supplied, so no two rounds
   * share a scope and no other kind of caller can write an `add_intent` receipt into one.
   *
   * Preferred to a `created_by_round_id` column on `intents` because that column would be
   * written and never read: the budget is the only question anybody asks of it, the
   * receipts already answer that question exactly, and a migration for a write-only column
   * is a migration that has to be maintained for no reader.
   */
  const countScopedIntents = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({ added: Schema.Int }),
    execute: (callerScope) =>
      sql`SELECT COUNT(*) AS added FROM command_receipts
          WHERE caller_scope = ${callerScope} AND operation = 'add_intent'`,
  });

  /**
   * An intent of this goal that is already out to answer one dimension.
   *
   * The duplicate join the spec's decision 10 asks for: `addresses_dimension` against the
   * goal's intents that are **not finished**. `proposed`, `open` and `claimed` are the
   * live ones — nobody has concluded them, so a second intent on the same dimension would
   * be two runs answering one question — and `answered` and `abandoned` are deliberately
   * *not* duplicates: a question whose first attempt came back, or whose direction the
   * operator dropped, is a legitimate thing to take on again.
   *
   * Oldest first, so the refusal names the intent that got there rather than whichever row
   * the planner happened to sort to.
   */
  const findLiveIntentForDimension = SqlSchema.findOneOption({
    Request: Schema.Struct({
      goalId: Schema.String,
      dimensionId: Schema.String,
    }),
    Result: Schema.Struct({
      id: Schema.String,
      question: Schema.String,
      status: IntentStatus,
    }),
    execute: (request) =>
      sql`SELECT id, question, status FROM intents
          WHERE goal_id = ${request.goalId}
            AND addresses_dimension = ${request.dimensionId}
            AND status IN ('proposed', 'open', 'claimed')
          ORDER BY created_at, id
          LIMIT 1`,
  });

  /**
   * The round-scoped checks `add_intent` makes that the host's own path does not.
   *
   * Two hooks rather than one, because the two groups of checks can only be made at
   * different points in the write below and putting them in one place would mean doing a
   * read twice or refusing in the wrong order:
   *
   * - `beforeValidation` runs immediately after the receipt branch and before anything
   *   about the payload is checked. The round's authority, its goal's status and its budget
   *   are facts about the *caller*, and a planner whose budget is spent should be told to
   *   record its disposition rather than told that the anchor it sent was also wrong.
   * - `afterDimension` runs once the declared dimension has been resolved to a row,
   *   because the duplicate join is on the resolved id and resolving it a second time here
   *   would be a second read with a second chance to disagree.
   *
   * Both are `undefined` on the host's path, which is what makes this a widening of
   * `addIntent` rather than a second implementation of it: there is one copy of the
   * anchoring rule, the receipt semantics and the event.
   */
  interface RoundIntentChecks<E> {
    readonly beforeValidation: Effect.Effect<void, E>;
    readonly afterDimension: (
      addressesDimensionId: string | null,
    ) => Effect.Effect<void, E>;
  }

  /**
   * Creates one intent, with §4's anchoring rule enforced here rather than in a tool.
   *
   * §4 calls this the differentiator and says to implement it before anything else that
   * writes to the graph: **an intent anchors only to existing recorded evidence, never to
   * an intent, a goal or a hint, and an empty parent list means a new top-level
   * direction.** The rejection is instructive, not a bare failure — a planner that is
   * told "that is an intent, and an intent cannot anchor an intent; leave the list empty
   * for a new direction" can correct itself, where one told "invalid parent" cannot.
   *
   * **Why it is in the store and not a planner tool.** Intents are planner-generated and
   * a planner round has no execution attempt, so there is no `CallerContext` to
   * authenticate: `checkAuthority` validates against a live unsettled attempt and would
   * refuse every planner. The host creates intents, as it does today, and the
   * planner-facing surface waits for Sprint 07 when there is a loop to authenticate. What
   * this buys is that the rule cannot be bypassed by writing an intent some other way —
   * there is no other way.
   *
   * The caller's authority is still not the payload's. `host.targetId` comes from the
   * process that owns the registry, and the goal's own `target_id` is checked against it:
   * a goal from another target cannot be given an intent from here.
   *
   * Four refusals, none of which writes anything: no such goal, a goal from another
   * target, an anchor that is not recorded evidence (named by what it actually is), and an
   * anchor from a different goal. A duplicate anchor in one call is refused rather than
   * collapsed, like a duplicate dimension address, because the primary key would swallow
   * it silently and a caller that sent one twice has made a mistake worth hearing about.
   */
  const addIntentWithin = <E = never>(
    host: HostContext,
    input: AddIntentInput,
    createdAt: number,
    /**
     * Generic in its error, so the host's path does not inherit a failure it cannot
     * produce. With `checks: undefined`, `E` is inferred `never` and `addIntent`'s error
     * channel is exactly what it was before this slice — which is the property that makes
     * widening this function a safe thing to have done.
     */
    checks: RoundIntentChecks<E> | undefined,
  ) => {
    const key = `${host.callerScope}:add_intent:${input.operationId}`;
    const requestHash = hashRequest(
      { callerScope: host.callerScope, targetId: host.targetId },
      input,
    );
    return Effect.gen(function* () {
      const existing = yield* findReceipt(key).pipe(
        Effect.mapError(lift("command_receipts", key)),
      );
      if (Option.isSome(existing)) {
        const receipt = existing.value;
        if (receipt.request_hash !== requestHash) {
          return yield* new MutationError({
            reason: "conflict",
            detail: `operation ${input.operationId} was already used with different input`,
          });
        }
        const original = yield* replayResult(
          key,
          AddIntentResult,
          receipt.result,
        );
        return { ...original, replayed: true };
      }

      /**
       * The round's own checks, **after** the receipt and before anything else.
       *
       * After the receipt for the reason `recordObservation`'s order gives: a replay
       * writes nothing and hands back what this store already committed, and refusing
       * it would make a transport retry look like a refused write. It matters more here
       * than it reads — a round that adds its fifth intent and loses the response would
       * otherwise be told `budget_spent` for a write that *succeeded*, and would
       * conclude it had added four.
       *
       * Before the payload for the reason on {@link RoundIntentChecks}: a spent budget
       * and an ended goal are facts about the caller, and the correction for both is to
       * stop rather than to send a better anchor.
       */
      if (checks !== undefined) yield* checks.beforeValidation;

      const goal = yield* findGoal(input.goalId).pipe(
        Effect.mapError(lift("goals", input.goalId)),
      );
      if (Option.isNone(goal)) {
        return yield* new MutationError({
          reason: "invalid",
          detail: `no goal ${input.goalId} exists; an intent is always a direction under a goal`,
        });
      }
      if (goal.value.target_id !== host.targetId) {
        return yield* new MutationError({
          reason: "unauthorized",
          detail: `goal ${input.goalId} belongs to target ${goal.value.target_id}, not ${host.targetId}`,
        });
      }
      const clash = yield* findIntentById(input.intentId).pipe(
        Effect.mapError(lift("intents", input.intentId)),
      );
      if (Option.isSome(clash)) {
        return yield* new MutationError({
          reason: "invalid",
          detail: `intent ${input.intentId} already exists; an intent id is never reused, and a retry of this command needs the operation id, not the intent id`,
        });
      }

      const seen = new Set<string>();
      for (const anchorId of input.anchorObservationIds) {
        if (seen.has(anchorId)) {
          return yield* new MutationError({
            reason: "invalid",
            detail: `anchor '${anchorId}' is listed twice in anchorObservationIds`,
          });
        }
        seen.add(anchorId);
        const kinds = yield* classifyAnchor(anchorId).pipe(
          Effect.mapError(lift("observations", anchorId)),
        );
        if (kinds.as_observation_goal === null) {
          // The instructive refusal §4 asks for: it names what the id *is*, says why
          // that kind cannot anchor, and gives the way to express a new direction.
          const what =
            kinds.as_intent !== null
              ? "an intent"
              : kinds.as_goal !== null
                ? "a goal"
                : "nothing recorded in this target";
          return yield* new MutationError({
            reason: "invalid",
            detail: `anchor '${anchorId}' is ${what} and cannot anchor an intent. Only a recorded observation may anchor one, never an intent, a goal or a hint, because an intent anchored to another intent is speculation about speculation. Leave anchorObservationIds empty for a new top-level direction.`,
          });
        }
        if (kinds.as_observation_goal !== input.goalId) {
          return yield* new MutationError({
            reason: "invalid",
            detail: `anchor '${anchorId}' is an observation under goal ${kinds.as_observation_goal}, and this intent is under goal ${input.goalId}; an intent anchors to evidence from its own goal`,
          });
        }
      }

      let addressesDimensionId: string | null = null;
      if (input.addressesDimension !== null) {
        const parsed = parseDimensionAddress(input.addressesDimension);
        if (parsed === undefined) {
          return yield* new MutationError({
            reason: "invalid",
            detail: `'${input.addressesDimension}' is not an untested-dimension address; use the exact address from the briefing, e.g. obs_000003_attempt-x#u1`,
          });
        }
        const dimension = yield* findDimensionByPosition({
          observationId: parsed.observationId,
          position: parsed.index,
        }).pipe(
          Effect.mapError(
            lift("observation_dimensions", input.addressesDimension),
          ),
        );
        if (Option.isNone(dimension)) {
          return yield* new MutationError({
            reason: "invalid",
            detail: `no untested dimension is recorded at '${input.addressesDimension}'`,
          });
        }
        if (dimension.value.source_goal_id !== input.goalId) {
          return yield* new MutationError({
            reason: "invalid",
            detail: `dimension '${input.addressesDimension}' was raised under goal ${dimension.value.source_goal_id}, and this intent is under goal ${input.goalId}`,
          });
        }
        addressesDimensionId = dimension.value.dimension_id;
      }

      // The duplicate join, on the id the alias just resolved to rather than on the
      // alias: two briefings can print one dimension under two addresses only if the
      // row moves, and the row is what the join has to agree with. Host callers skip
      // it — an operator adding a second intent on one dimension is making a choice,
      // and a planner doing it is losing track of what it has already proposed.
      if (checks !== undefined)
        yield* checks.afterDimension(addressesDimensionId);

      // Advisory, and stored as given: nothing reads these as what ran. An empty
      // option list becomes null for the reason `canonicalModelOptions` says — it
      // would claim an opinion — and the rest is sorted so the same suggestion is the
      // same bytes.
      const suggestedOptions = canonicalModelOptions(
        input.suggestedModelOptions ?? null,
      );
      yield* sql`INSERT INTO intents (
              id, goal_id, target_id, question, created_at, addresses_dimension,
              status, suggested_instance_id, suggested_model, suggested_model_options
            ) VALUES (
              ${input.intentId}, ${input.goalId}, ${host.targetId},
              ${input.question}, ${createdAt}, ${addressesDimensionId},
              'open', ${input.suggestedInstanceId ?? null},
              ${input.suggestedModel ?? null},
              ${suggestedOptions === null ? null : JSON.stringify(suggestedOptions)}
            )`.pipe(Effect.mapError(asDatabaseError("transaction")));

      for (const [position, anchorId] of input.anchorObservationIds.entries()) {
        yield* sql`INSERT INTO intent_anchors (
                intent_id, observation_id, position, created_at
              ) VALUES (
                ${input.intentId}, ${anchorId}, ${position}, ${createdAt}
              )`.pipe(Effect.mapError(asDatabaseError("transaction")));
      }

      const result: AddIntentResult = {
        intentId: input.intentId,
        goalId: input.goalId,
        anchoredTo: input.anchorObservationIds,
        addressesDimensionId,
        topLevel: input.anchorObservationIds.length === 0,
        replayed: false,
      };

      yield* sql`INSERT INTO command_receipts (
              key, caller_scope, operation, operation_id, request_hash, result,
              created_at
            ) VALUES (
              ${key}, ${host.callerScope}, 'add_intent', ${input.operationId},
              ${requestHash}, ${JSON.stringify(result)}, ${createdAt}
            )`.pipe(Effect.mapError(asDatabaseError("transaction")));

      // An event, and deliberately **no** outbox request. A new intent implies no
      // action outside this database: the queue of intents is the database itself
      // (§4's atomic claim), not a side-effect queue. Writing a request here would
      // make the outbox look more exercised than it is, and a mutation that was
      // obliged to write one would be a design error — this is what shows it is not.
      // Caller authority is the host's own scope, and intent and attempt are null
      // because a host-created intent has no attempt: there is nothing to fabricate.
      yield* appendEvent({
        kind: "intent.added",
        targetId: host.targetId,
        callerScope: host.callerScope,
        intentId: null,
        attemptId: null,
        operation: "add_intent",
        operationId: input.operationId,
        subjectId: input.intentId,
        payload: {
          intentId: input.intentId,
          goalId: input.goalId,
          question: input.question,
          anchoredTo: input.anchorObservationIds,
          addressesDimensionId,
          topLevel: result.topLevel,
          // What the intent hoped to run on, for the record of what was asked. Not
          // what ran: that is `attempt.started`.
          suggestedInstanceId: input.suggestedInstanceId ?? null,
          suggestedModel: input.suggestedModel ?? null,
          suggestedModelOptions: suggestedOptions,
        },
        recordedAt: createdAt,
      });

      return result;
    });
  };

  /**
   * The host's own path: one intent, created by the process that owns the registry.
   *
   * Unchanged in behaviour by this slice. It is the browser's `POST /goals/:id/intents`
   * and the operator's authority, with no budget, no duplicate join and no goal-status
   * check — because an operator adding an intent to a goal they are about to end, or a
   * second intent on one dimension, is making a decision rather than losing track.
   */
  const addIntent = Effect.fn("ObservationStore.addIntent")(function* (
    host: HostContext,
    input: AddIntentInput,
  ) {
    const createdAt = yield* Clock.currentTimeMillis;
    return yield* sql
      .withTransaction(addIntentWithin(host, input, createdAt, undefined))
      .pipe(
        Effect.mapError((error) =>
          error._tag === "SqlError"
            ? asDatabaseError("transaction")(error)
            : error,
        ),
      );
  });

  /**
   * The planner round's path: the same write, under the round's own authority.
   *
   * **It wraps {@link addIntentWithin} rather than reimplementing it**, which is what
   * keeps §4's anchoring rule, the receipt semantics and the `intent.added` event in one
   * place. What this adds is the three checks on {@link RoundIntentRefused} plus the
   * authority path, and all of them run inside the one transaction the write does — which
   * is the reason the budget is enforced here and not in the round's prompt: two tool
   * calls from one turn would both read "four added" and both commit a fifth if the check
   * were outside the write.
   *
   * `host` is built from the round's own caller, so the receipt key is namespaced
   * `<targetId>/round/<roundId>` and the `intent.added` event is attributed to the round.
   * That is not a convenience — it is what makes {@link countScopedIntents} a count of
   * *this round's* writes.
   *
   * **The goal is the credential's, never the payload's.** `input.goalId` is checked
   * against the round's and refused if it differs, so a tool handler that passed the wrong
   * one writes nothing. Reads a round makes may be target-scoped; its writes are
   * goal-scoped, and this is where that is enforced.
   */
  const addRoundIntent = Effect.fn("ObservationStore.addRoundIntent")(
    function* (caller: CallerContext, input: AddIntentInput) {
      const planner = yield* roundCallerOrFail(caller, "add an intent");
      const createdAt = yield* Clock.currentTimeMillis;
      const host: HostContext = {
        callerScope: planner.callerScope,
        targetId: planner.targetId,
      };
      const checks: RoundIntentChecks<
        MutationError | RoundIntentRefused | DatabaseError | StoredRowError
      > = {
        beforeValidation: Effect.gen(function* () {
          if (input.goalId !== planner.goalId) {
            return yield* new MutationError({
              reason: "unauthorized",
              detail: `round ${planner.roundId} plans goal ${planner.goalId} and may not add an intent under goal ${input.goalId}; a round's writes are scoped to the goal its credential names, and nothing was recorded`,
            });
          }
          // The round exists, is this target's and this goal's, is still `running`, and
          // its fence is the credential's. Four checks, and the goal's status is
          // deliberately not one of them — see `RoundIntentRefused.goal_ended` for why it
          // is checked here instead.
          const round = yield* checkRoundAuthority(planner);
          const goal = yield* goalAuthorityRow(planner.goalId).pipe(
            Effect.mapError(lift("goals", planner.goalId)),
          );
          if (Option.isSome(goal) && goal.value.status !== "active") {
            return yield* new RoundIntentRefused({
              reason: "goal_ended",
              roundId: planner.roundId,
              duplicateOf: null,
              detail: `goal ${planner.goalId} is ${goal.value.status}, so no new work is dispatched under it and this intent was NOT created. You may still record this round's disposition; nothing you add now would be run.`,
            });
          }
          const counted = yield* countScopedIntents(planner.callerScope).pipe(
            Effect.mapError(lift("command_receipts", planner.callerScope)),
          );
          if (counted.added >= round.budget) {
            return yield* new RoundIntentRefused({
              reason: "budget_spent",
              roundId: planner.roundId,
              duplicateOf: null,
              detail: `this round's budget of ${String(round.budget)} intent(s) is spent — you have already added ${String(counted.added)} — so this one was NOT created. Stop adding intents and record this round's disposition: 'actionable' is the right answer when the intents you did add are worth running. The budget is a property of the round, so a new operation id will not raise it.`,
            });
          }
        }),
        afterDimension: (addressesDimensionId) =>
          Effect.gen(function* () {
            if (addressesDimensionId === null) return;
            const clash = yield* findLiveIntentForDimension({
              goalId: planner.goalId,
              dimensionId: addressesDimensionId,
            }).pipe(Effect.mapError(lift("intents", addressesDimensionId)));
            if (Option.isNone(clash)) return;
            return yield* new RoundIntentRefused({
              reason: "duplicate",
              roundId: planner.roundId,
              duplicateOf: clash.value.id,
              detail: `intent ${clash.value.id} is already ${clash.value.status} against '${input.addressesDimension ?? addressesDimensionId}' under this goal, asking: ${clash.value.question}. Two live intents on one untested dimension are two runs answering one question, so this one was NOT created. Address a different dimension, or add a top-level direction with no dimension at all.`,
            });
          }),
      };
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const result = yield* addIntentWithin(
              host,
              input,
              createdAt,
              checks,
            );
            /**
             * The budget, read back **inside the same transaction as the write**.
             *
             * Not a second call the handler makes afterwards, and the difference is not
             * tidiness: a sweep that settled this round between the write and a follow-up
             * read would make that read refuse `stale`, and the planner would be told its
             * successful `add_intent` had failed. In here the count sees the receipt this
             * transaction just wrote — and on a *replay* it sees the one the original
             * wrote — so the number is right on both paths.
             */
            const round = yield* roundOrFail(planner.roundId);
            const counted = yield* countScopedIntents(planner.callerScope).pipe(
              Effect.mapError(lift("command_receipts", planner.callerScope)),
            );
            if (round === undefined) {
              // Unreachable: the write above went through the round's authority path,
              // which reads this row. Reported rather than defaulted, because a budget
              // invented for a row that is not there is a budget nobody can check.
              return yield* new MutationError({
                reason: "stale",
                detail: `round ${planner.roundId} is no longer recorded in this target; the intent was written but its budget could not be read back`,
              });
            }
            return {
              ...result,
              budget: round.budget,
              intentsAdded: counted.added,
            };
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error._tag === "SqlError"
              ? asDatabaseError("transaction")(error)
              : error,
          ),
        );
    },
  );

  const selectGoalById = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: GoalRow,
    execute: (goalId) =>
      sql.unsafe(`${goalSelect} WHERE goals.id = ?`, [goalId]),
  });

  const selectGoals = SqlSchema.findAll({
    Request: Schema.Void,
    Result: GoalRow,
    execute: () =>
      sql.unsafe(`${goalSelect} ORDER BY goals.created_at DESC, goals.id`, []),
  });

  /**
   * Creates one goal, on purpose and as a recorded act.
   *
   * Before this a goal was a row `seedAttempt` minted as a side effect of starting a run:
   * no operation identity, no event, nothing to say who wanted it. This is the same
   * discipline `addIntent` has, applied to the node above it — and it is copied in
   * discipline rather than in text, so each rule below is here because a goal needs it:
   *
   * 1. **The receipt is read before anything else.** A retry must answer from what was
   *    committed, not from whatever the world looks like now; after the first call the
   *    goal exists, and a check for "does this goal already exist" that ran first would
   *    refuse the very retry it should replay.
   * 2. **The same operation id with different input is a `conflict`, and nothing is
   *    written.** The request hash covers the host's scope and target as well as the
   *    payload, so a retry from another scope is a different request.
   * 3. **`host.targetId` is the target, and the payload does not get a say.** The input
   *    has no target field at all: a goal belongs to the file's target by construction,
   *    and a caller that could name another one would be one typo from writing evidence
   *    into the wrong engagement.
   * 4. **A goal id is never reused.** An existing goal under that id is refused as
   *    `invalid` with a sentence pointing at the operation id, which is what a retry
   *    needs and the goal id is not.
   *
   * The goal row, the receipt and the `goal.added` event commit in one transaction, so
   * the log can never say a goal was created that is not there, nor the reverse. There
   * is no outbox request: opening a goal obliges nothing outside this database, and a
   * mutation that wrote one anyway would make the outbox look more exercised than it is.
   *
   * It is `active` from the first instant. There is no draft state to leave, and no
   * second call that makes it real.
   */
  const openGoal = Effect.fn("ObservationStore.openGoal")(function* (
    host: HostContext,
    input: OpenGoalInput,
  ) {
    const createdAt = yield* Clock.currentTimeMillis;
    const key = `${host.callerScope}:open_goal:${input.operationId}`;
    const requestHash = hashRequest(
      { callerScope: host.callerScope, targetId: host.targetId },
      input,
    );
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* findReceipt(key).pipe(
            Effect.mapError(lift("command_receipts", key)),
          );
          if (Option.isSome(existing)) {
            const receipt = existing.value;
            if (receipt.request_hash !== requestHash) {
              return yield* new MutationError({
                reason: "conflict",
                detail: `operation ${input.operationId} was already used with different input`,
              });
            }
            const original = yield* replayResult(
              key,
              OpenGoalResult,
              receipt.result,
            );
            return { ...original, replayed: true };
          }

          const clash = yield* findGoal(input.goalId).pipe(
            Effect.mapError(lift("goals", input.goalId)),
          );
          if (Option.isSome(clash)) {
            return yield* new MutationError({
              reason: "invalid",
              detail: `goal ${input.goalId} already exists; a goal id is never reused, and a retry of this command needs the operation id, not the goal id`,
            });
          }

          yield* sql`INSERT INTO goals (
              id, target_id, name, description, status, created_at
            ) VALUES (
              ${input.goalId}, ${host.targetId}, ${input.name},
              ${input.description}, 'active', ${createdAt}
            )`.pipe(Effect.mapError(asDatabaseError("transaction")));

          const result: OpenGoalResult = {
            goalId: input.goalId,
            replayed: false,
          };

          yield* sql`INSERT INTO command_receipts (
              key, caller_scope, operation, operation_id, request_hash, result,
              created_at
            ) VALUES (
              ${key}, ${host.callerScope}, 'open_goal', ${input.operationId},
              ${requestHash}, ${JSON.stringify(result)}, ${createdAt}
            )`.pipe(Effect.mapError(asDatabaseError("transaction")));

          // Intent and attempt are null because a host-originated goal has neither: an
          // honest absence, not a gap. The caller scope is the host's own.
          yield* appendEvent({
            kind: "goal.added",
            targetId: host.targetId,
            callerScope: host.callerScope,
            intentId: null,
            attemptId: null,
            operation: "open_goal",
            operationId: input.operationId,
            subjectId: input.goalId,
            payload: {
              goalId: input.goalId,
              name: input.name,
              description: input.description,
            },
            recordedAt: createdAt,
          });

          return result;
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          error._tag === "SqlError"
            ? asDatabaseError("transaction")(error)
            : error,
        ),
      );
  });

  /**
   * Ends one goal, once, and records who did it and why.
   *
   * Receipt discipline is {@link openGoal}'s, in the same order. The refusals are then
   * three, none of which writes anything, and each names what it found so the sentence
   * can be shown to an operator as written:
   *
   * - **No such goal** — `invalid`, naming the id.
   * - **A goal from another target** — `invalid`, saying so. The goal's own `target_id`
   *   is compared with `host.targetId`; the payload has no target to trust.
   * - **A goal already ended** — `conflict`, naming its current status and who ended it.
   *   Ending is a one-way door: the first ending is the record of what was concluded, and
   *   a second call that overwrote it would erase that. Someone who wants a different
   *   conclusion wants a new goal. This is a refusal and not a replay because the replay
   *   case is already handled above — an exact retry of the *same* operation finds its
   *   receipt first and answers with the original ending.
   *
   * **What ending does not do is stop anything.** It records that the goal is over, which
   * is what a dispatcher will check before it starts new work under the goal and what the
   * planner's wake-ups will check before they begin another round. It does not interrupt
   * an attempt that is running (the spec's decision 8): that work was started by an
   * operator who may want its result, and the way to stop an attempt is the stop control,
   * not a goal changing state under it. There is nothing here to cancel, and no code in
   * this function reaches for the supervisor.
   *
   * The `UPDATE` carries `AND status = 'active'` and is checked through `RETURNING`.
   * Inside this transaction the read above already established the goal is active, so
   * the guard cannot normally fail; it is there so that if a second writer ever existed,
   * the loser would refuse by name instead of overwriting the winner's ending and then
   * appending an event describing a change that did not happen.
   */
  /**
   * Ending a goal, as the body of a transaction somebody else may already have opened.
   *
   * Extracted for one caller: {@link recordRoundDisposition}, where a planner's
   * `objective_met` has to end the goal **in the same transaction** that records the
   * disposition. Two transactions would leave a window in which a round has concluded
   * `objective_met` and the goal is still `active`, and a failure in the second would make
   * that window permanent — a durable claim that the objective was met beside a goal still
   * taking new work.
   *
   * Same arrangement and same reason as {@link addIntentWithin}: one implementation of the
   * receipt semantics, the status guard and the `goal.ended` event, reachable from two
   * entry points.
   */
  const endGoalWithin = (
    host: HostContext,
    input: EndGoalInput,
    endedAt: number,
  ) => {
    const key = `${host.callerScope}:end_goal:${input.operationId}`;
    const requestHash = hashRequest(
      { callerScope: host.callerScope, targetId: host.targetId },
      input,
    );
    return Effect.gen(function* () {
      const existing = yield* findReceipt(key).pipe(
        Effect.mapError(lift("command_receipts", key)),
      );
      if (Option.isSome(existing)) {
        const receipt = existing.value;
        if (receipt.request_hash !== requestHash) {
          return yield* new MutationError({
            reason: "conflict",
            detail: `operation ${input.operationId} was already used with different input`,
          });
        }
        const original = yield* replayResult(
          key,
          EndGoalResult,
          receipt.result,
        );
        return { ...original, replayed: true };
      }

      const found = yield* selectGoalById(input.goalId).pipe(
        Effect.mapError(lift("goals", input.goalId)),
      );
      if (Option.isNone(found)) {
        return yield* new MutationError({
          reason: "invalid",
          detail: `no goal ${input.goalId} exists in this target`,
        });
      }
      const goal = found.value;
      if (goal.target_id !== host.targetId) {
        return yield* new MutationError({
          reason: "invalid",
          detail: `goal ${input.goalId} belongs to target ${goal.target_id}, not ${host.targetId}`,
        });
      }
      if (goal.status !== "active") {
        return yield* new MutationError({
          reason: "conflict",
          detail: `goal ${input.goalId} is already ${goal.status}, ended by ${goal.ended_by ?? "an unrecorded party"}; an ended goal is not ended again, and a different conclusion is a new goal`,
        });
      }

      const updated = yield* sql<{ id: string }>`UPDATE goals
            SET status = ${input.status}, ended_at = ${endedAt},
                ended_by = ${input.endedBy}, end_reason = ${input.reason}
            WHERE id = ${input.goalId} AND status = 'active'
            RETURNING id`.pipe(Effect.mapError(asDatabaseError("transaction")));
      if (updated.length === 0) {
        return yield* new MutationError({
          reason: "conflict",
          detail: `goal ${input.goalId} was ended by another call before this one could be recorded`,
        });
      }

      const result: EndGoalResult = {
        goalId: input.goalId,
        status: input.status,
        endedBy: input.endedBy,
        endedAt,
        replayed: false,
      };

      yield* sql`INSERT INTO command_receipts (
              key, caller_scope, operation, operation_id, request_hash, result,
              created_at
            ) VALUES (
              ${key}, ${host.callerScope}, 'end_goal', ${input.operationId},
              ${requestHash}, ${JSON.stringify(result)}, ${endedAt}
            )`.pipe(Effect.mapError(asDatabaseError("transaction")));

      yield* appendEvent({
        kind: "goal.ended",
        targetId: host.targetId,
        callerScope: host.callerScope,
        intentId: null,
        attemptId: null,
        operation: "end_goal",
        operationId: input.operationId,
        subjectId: input.goalId,
        payload: {
          goalId: input.goalId,
          status: input.status,
          endedBy: input.endedBy,
          reason: input.reason,
        },
        recordedAt: endedAt,
      });

      return result;
    });
  };

  /** Ends a goal once, recording who and why. Records state only: it interrupts nothing. */
  const endGoal = Effect.fn("ObservationStore.endGoal")(function* (
    host: HostContext,
    input: EndGoalInput,
  ) {
    const endedAt = yield* Clock.currentTimeMillis;
    return yield* sql
      .withTransaction(endGoalWithin(host, input, endedAt))
      .pipe(
        Effect.mapError((error) =>
          error._tag === "SqlError"
            ? asDatabaseError("transaction")(error)
            : error,
        ),
      );
  });

  /**
   * Every goal in this file, newest first, with the counts that hang under each.
   *
   * "This target's goals" is true by construction: a target's goals live in that target's
   * own `hunt.sqlite` and nowhere else, which is what the per-target file is for. The
   * rows still carry `target_id`, and the browser API checks it against the target it
   * opened rather than trusting the file — a misfiled row is then a missing goal, not
   * another engagement's objective on this one's screen.
   *
   * Read-only and transaction-free, like {@link counts}: it takes no write lock, so a
   * list refresh cannot be the thing that blocks a worker mid-write.
   */
  const goals = Effect.fn("ObservationStore.goals")(function* () {
    const rows = yield* selectGoals().pipe(Effect.mapError(lift("goals", "*")));
    return rows.map(toStoredGoal);
  });

  /** One goal by id, or `undefined`. Which target it belongs to is on the result. */
  const loadGoal = Effect.fn("ObservationStore.loadGoal")(function* (
    goalId: string,
  ) {
    const row = yield* selectGoalById(goalId).pipe(
      Effect.mapError(lift("goals", goalId)),
    );
    return Option.match(row, {
      onNone: () => undefined,
      onSome: toStoredGoal,
    });
  });

  const selectIntentById = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: IntentRowSchema,
    execute: (intentId) =>
      sql.unsafe(`${intentSelect} WHERE intents.id = ?`, [intentId]),
  });

  const selectIntentsOfGoal = SqlSchema.findAll({
    Request: Schema.String,
    Result: IntentRowSchema,
    execute: (goalId) =>
      sql.unsafe(
        `${intentSelect} WHERE intents.goal_id = ? ORDER BY intents.created_at, intents.id`,
        [goalId],
      ),
  });

  const selectAnchorsOfGoal = SqlSchema.findAll({
    Request: Schema.String,
    Result: IntentAnchorRow,
    execute: (goalId) =>
      sql`SELECT intent_anchors.intent_id AS intent_id,
            intent_anchors.observation_id AS observation_id
          FROM intent_anchors
          INNER JOIN intents ON intents.id = intent_anchors.intent_id
          WHERE intents.goal_id = ${goalId}
          ORDER BY intent_anchors.intent_id, intent_anchors.position`,
  });

  /**
   * Every intent under one goal, oldest first, each with its anchors and attempt count.
   *
   * Oldest first because an intent list reads as a queue of directions in the order they
   * were raised, where a goal list reads as a feed. Two statements (intents, then their
   * anchors) rather than a join, because a join across anchors multiplies each intent by
   * its anchor count and the grouping back is the thing that goes wrong. Read-only and
   * transaction-free, like {@link goals}.
   */
  const intentsForGoal = Effect.fn("ObservationStore.intentsForGoal")(
    function* (goalId: string) {
      const rows = yield* selectIntentsOfGoal(goalId).pipe(
        Effect.mapError(lift("intents", `goal:${goalId}`)),
      );
      const anchorRows = yield* selectAnchorsOfGoal(goalId).pipe(
        Effect.mapError(lift("intent_anchors", `goal:${goalId}`)),
      );
      const anchors = new Map<string, string[]>();
      for (const anchor of anchorRows) {
        const held = anchors.get(anchor.intent_id);
        if (held === undefined)
          anchors.set(anchor.intent_id, [anchor.observation_id]);
        else held.push(anchor.observation_id);
      }
      return rows.map((row) => toStoredIntent(row, anchors.get(row.id) ?? []));
    },
  );

  /** One intent by id, or `undefined`. Which target and goal it belongs to are on it. */
  const intent = Effect.fn("ObservationStore.intent")(function* (
    intentId: string,
  ) {
    const row = yield* selectIntentById(intentId).pipe(
      Effect.mapError(lift("intents", intentId)),
    );
    if (Option.isNone(row)) return undefined;
    const anchors = yield* anchorsForIntent(intentId);
    return toStoredIntent(row.value, anchors);
  });

  const selectClaimState = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({
      target_id: Schema.String,
      goal_id: Schema.String,
      status: Schema.String,
      claimed_by_attempt_id: Schema.NullOr(Schema.String),
      goal_status: Schema.String,
    }),
    execute: (intentId) =>
      sql`SELECT intents.target_id AS target_id, intents.goal_id AS goal_id,
            intents.status AS status,
            intents.claimed_by_attempt_id AS claimed_by_attempt_id,
            goals.status AS goal_status
          FROM intents INNER JOIN goals ON goals.id = intents.goal_id
          WHERE intents.id = ${intentId}`,
  });

  const selectClaimed = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({
      goal_description: Schema.String,
    }),
    execute: (goalId) =>
      sql`SELECT description AS goal_description FROM goals WHERE id = ${goalId}`,
  });

  /**
   * Takes an intent for one attempt, or refuses by name. **The take is one statement.**
   *
   * `UPDATE intents SET status = 'claimed', claimed_by_attempt_id = ? WHERE id = ? AND
   * status = 'open' …` is the whole claim, and a zero-row result is the refusal. There is
   * no read-then-write: two requests that both saw the intent `open` would both write, and
   * the second would silently take what the first holds. Under the single write lock the
   * statements serialise, the first matches, the second finds `status = 'claimed'` and
   * matches nothing — which is what the concurrency test asserts with two claims racing.
   *
   * The same statement carries the other two things that make an intent claimable: it
   * belongs to the caller's target (`host.targetId`, never a payload's), and its goal is
   * still `active`. Ending a goal blocks new dispatch (the spec's decision 8), and putting
   * that in the claim rather than in a check before it means a goal ended a millisecond ago
   * cannot be dispatched under by a request that read it as active.
   *
   * **The diagnosis is read after the refusal and only names it.** Once the statement has
   * matched nothing the store reads why — missing, another target's, not open (naming the
   * holder), or a goal that has ended — and that read decides no write. If it finds the
   * intent claimable after all, the state moved between the two statements, and the answer
   * is a `not_open` that says so rather than a retry here.
   *
   * No receipt and no event: a claim is not an operator command to be replayed, it is a
   * lock taken for a run that has not started, and it is followed by the `attempt.started`
   * event for the run it was taken for. A claim whose run never starts is released and
   * leaves no trace in the log, which is correct: nothing happened.
   *
   * The attempt id is the caller's and is not required to exist yet. The claim is taken
   * *before* the attempt row is written, so that a run refused for any later reason leaves
   * no attempt behind to settle; for that reason `claimed_by_attempt_id` is not a foreign
   * key.
   */
  const claimIntent = Effect.fn("ObservationStore.claimIntent")(function* (
    host: HostContext,
    intentId: string,
    attemptId: string,
  ) {
    const taken = yield* sql<{ goal_id: string }>`UPDATE intents
      SET status = 'claimed', claimed_by_attempt_id = ${attemptId}
      WHERE id = ${intentId} AND status = 'open' AND target_id = ${host.targetId}
        AND goal_id IN (SELECT id FROM goals WHERE status = 'active')
      RETURNING goal_id`.pipe(Effect.mapError(asDatabaseError("query")));

    if (taken.length === 0) {
      const state = yield* selectClaimState(intentId).pipe(
        Effect.mapError(lift("intents", intentId)),
      );
      if (Option.isNone(state)) {
        return yield* new ClaimRefused({
          reason: "no_such_intent",
          intentId,
          heldBy: null,
          detail: `no intent ${intentId} exists`,
        });
      }
      const found = state.value;
      if (found.target_id !== host.targetId) {
        return yield* new ClaimRefused({
          reason: "other_target",
          intentId,
          heldBy: null,
          detail: `intent ${intentId} belongs to target ${found.target_id}, not ${host.targetId}`,
        });
      }
      if (found.status !== "open") {
        const heldBy =
          found.status === "claimed" ? found.claimed_by_attempt_id : null;
        const why =
          found.status === "claimed"
            ? `it is claimed by attempt ${found.claimed_by_attempt_id ?? "(unrecorded)"}; wait for that attempt to settle, or stop it, and then run this intent`
            : found.status === "answered"
              ? "it is already answered, and an answered intent is not run again; a follow-up is a new intent"
              : found.status === "abandoned"
                ? "it was abandoned, and an abandoned intent is not run"
                : found.status === "proposed"
                  ? "it is only proposed, and a proposal is not run until it is accepted"
                  : `its status is ${found.status}`;
        return yield* new ClaimRefused({
          reason: "not_open",
          intentId,
          heldBy,
          detail: `intent ${intentId} cannot be claimed: ${why}`,
        });
      }
      if (found.goal_status !== "active") {
        return yield* new ClaimRefused({
          reason: "goal_not_active",
          intentId,
          heldBy: null,
          detail: `intent ${intentId} is open but its goal ${found.goal_id} is ${found.goal_status}; ending a goal blocks new dispatch under it, and a different conclusion is a new goal`,
        });
      }
      // Open, ours and under an active goal, yet the statement matched nothing: the row
      // changed between the two. Said as it is rather than guessed at.
      return yield* new ClaimRefused({
        reason: "not_open",
        intentId,
        heldBy: null,
        detail: `intent ${intentId} changed while it was being claimed; nothing was claimed, and it can be tried again`,
      });
    }

    const goalId = taken[0]!.goal_id;
    const claimed = yield* selectIntentById(intentId).pipe(
      Effect.mapError(lift("intents", intentId)),
    );
    const goal = yield* selectClaimed(goalId).pipe(
      Effect.mapError(lift("goals", goalId)),
    );
    if (Option.isNone(claimed)) {
      // Unreachable: the row was just updated. Reported as corruption, not swallowed.
      return yield* new StoredRowError({
        table: "intents",
        rowId: intentId,
        detail: "the intent was claimed and could not be read back",
        cause: undefined,
      });
    }
    const stored = toStoredIntent(claimed.value, []);
    return {
      intentId,
      goalId,
      goal: goal.goal_description,
      question: stored.question,
      suggestion: stored.suggestion,
      claimedByAttemptId: attemptId,
    } satisfies ClaimResult;
  });

  /**
   * Gives an intent back without an attempt having settled: the path a refused run takes.
   *
   * `settledStatus` is the same vocabulary {@link settleAttempt} uses and runs through the
   * same rule, so a release with anything but `succeeded` returns the intent to `open`. A
   * run that never started passes a non-`succeeded` word and the claim goes back; this is
   * not a way to mark an intent answered, because answering needs an attempt that
   * succeeded *and* an observation, and a refused run has neither.
   *
   * `heldBy`, when given, restricts the release to a claim that attempt still holds. The
   * supervisor always passes it: a cleanup that fires after another run took the intent
   * must not free that run's claim. Releasing an intent nobody claims changes nothing and
   * is not an error.
   */
  const releaseIntent = Effect.fn("ObservationStore.releaseIntent")(function* (
    intentId: string,
    settledStatus: string,
    heldBy?: string,
  ) {
    yield* releaseClaim(intentId, settledStatus, heldBy ?? null);
  });

  const selectOrphanedClaims = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({
      id: Schema.String,
      goal_id: Schema.String,
      target_id: Schema.String,
      claimed_by_attempt_id: Schema.String,
      attempt_status: Schema.NullOr(Schema.String),
    }),
    execute: () =>
      sql`SELECT intents.id AS id, intents.goal_id AS goal_id,
            intents.target_id AS target_id,
            intents.claimed_by_attempt_id AS claimed_by_attempt_id,
            attempts.status AS attempt_status
          FROM intents
          LEFT JOIN attempts ON attempts.id = intents.claimed_by_attempt_id
          WHERE intents.status = 'claimed'
            AND intents.claimed_by_attempt_id IS NOT NULL
            AND (attempts.id IS NULL OR attempts.status <> 'running')
          ORDER BY intents.id`,
  });

  /**
   * Gives back every claim whose attempt is not running and will not be: the startup
   * sweep's half of the intent lifecycle.
   *
   * A claim is released by the settlement of the attempt that holds it, in the same
   * transaction. That covers every ending but one: a process that dies **between taking the
   * claim and writing the attempt row** leaves an intent `claimed` by an attempt that does
   * not exist. Nothing else would ever see it — the attempt sweep enumerates `attempts` —
   * and it could be neither run (`claimIntent` refuses `not_open`) nor abandoned (the
   * refusal advises stopping an attempt that is not there). This finds it by the claim
   * instead.
   *
   * It also gives back a claim whose attempt exists and has already left `running`
   * (including `uncertain`, whose authority is revoked). Settlement releases in its own
   * transaction so this should not occur; if it does, nothing is working the intent either.
   * A `running` attempt is never touched here: that is the attempt sweep's, which asks the
   * harness before it concludes anything.
   *
   * **The outcome is `open`, never `answered`.** Nothing ran under a claim with no attempt,
   * so nothing is known, and for a settled one the settlement already made its decision.
   * This reconciles a lock; it does not invent a result, and it never reads observations.
   *
   * Each release is its own `intent.released` event, written in the same transaction as the
   * `UPDATE`, because it is a state change with no `attempt.settled` behind it to say so. The
   * event names the attempt the claim pointed at and what that attempt was, so an operator
   * reading the log can tell a crash from a stale row.
   *
   * **When it may run, and what that depends on.** Only at startup, before this process
   * runs anything. A claim a live `start` has taken and not yet written an attempt for is
   * `claimed` with no attempt row, which is exactly the shape of an orphan, and this query
   * cannot tell the two apart. What keeps them apart is ordering in the caller:
   * `RunSupervisor.start` waits for the worker endpoints *before* it claims, and `main.ts`
   * runs this and only then publishes them, so no start in this process can have a claim
   * while this runs. That is a guarantee of that ordering and of there being one process
   * writing the file; calling this anywhere else, or publishing the endpoints before it,
   * can return a live run's claim to `open` from under it.
   */
  const releaseOrphanedClaims = Effect.fn(
    "ObservationStore.releaseOrphanedClaims",
  )(function* () {
    const at = yield* Clock.currentTimeMillis;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const found = yield* selectOrphanedClaims().pipe(
            Effect.mapError(lift("intents", "orphaned claims")),
          );
          const released: ReleasedClaim[] = [];
          for (const row of found) {
            const updated = yield* sql<{ id: string }>`UPDATE intents
              SET status = 'open', claimed_by_attempt_id = NULL
              WHERE id = ${row.id} AND status = 'claimed'
                AND claimed_by_attempt_id = ${row.claimed_by_attempt_id}
              RETURNING id`.pipe(
              Effect.mapError(asDatabaseError("transaction")),
            );
            if (updated.length === 0) continue;
            yield* appendEvent({
              kind: "intent.released",
              targetId: row.target_id,
              callerScope: null,
              intentId: null,
              attemptId: null,
              operation: "release_orphaned_claim",
              operationId: null,
              subjectId: row.id,
              payload: {
                intentId: row.id,
                goalId: row.goal_id,
                claimedByAttemptId: row.claimed_by_attempt_id,
                attemptStatus: row.attempt_status,
                releasedBy: "recovery",
              },
              recordedAt: at,
            });
            released.push({
              intentId: row.id,
              goalId: row.goal_id,
              targetId: row.target_id,
              claimedByAttemptId: row.claimed_by_attempt_id,
              attemptStatus: row.attempt_status,
            });
          }
          return released as readonly ReleasedClaim[];
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          error._tag === "SqlError"
            ? asDatabaseError("transaction")(error)
            : error,
        ),
      );
  });

  /**
   * Drops an intent, once, as the operator, recording why.
   *
   * Receipt discipline is {@link endGoal}'s, in the same order: the receipt first, so an
   * exact retry answers from what was committed; a reused operation id with different
   * input is a `conflict`. Then the refusals, none of which writes anything:
   *
   * - **No such intent**, and **another target's** — `invalid`.
   * - **Not abandonable** — `conflict`, naming the status. Only `open` (and `proposed`)
   *   can be dropped. A `claimed` intent has a run in flight, and abandoning it from under
   *   that run would leave the attempt writing evidence under a direction the record says
   *   was dropped; stop the attempt, and when it settles the intent is open again. An
   *   `answered` intent holds evidence and is not retracted, and an `abandoned` one is
   *   already over.
   *
   * The `UPDATE` repeats the status guard and is checked through `RETURNING`, for the
   * reason {@link endGoal}'s is: a second writer would refuse by name instead of
   * overwriting.
   *
   * Abandonment is set only here, by an explicit act. A failed run is not a reason to give
   * up a direction; it is a reason the direction is open again.
   */
  const abandonIntent = Effect.fn("ObservationStore.abandonIntent")(function* (
    host: HostContext,
    input: AbandonIntentInput,
  ) {
    const at = yield* Clock.currentTimeMillis;
    const key = `${host.callerScope}:abandon_intent:${input.operationId}`;
    const requestHash = hashRequest(
      { callerScope: host.callerScope, targetId: host.targetId },
      input,
    );
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* findReceipt(key).pipe(
            Effect.mapError(lift("command_receipts", key)),
          );
          if (Option.isSome(existing)) {
            const receipt = existing.value;
            if (receipt.request_hash !== requestHash) {
              return yield* new MutationError({
                reason: "conflict",
                detail: `operation ${input.operationId} was already used with different input`,
              });
            }
            const original = yield* replayResult(
              key,
              AbandonIntentResult,
              receipt.result,
            );
            return { ...original, replayed: true };
          }

          const found = yield* selectIntentById(input.intentId).pipe(
            Effect.mapError(lift("intents", input.intentId)),
          );
          if (Option.isNone(found)) {
            return yield* new MutationError({
              reason: "invalid",
              detail: `no intent ${input.intentId} exists in this target`,
            });
          }
          const row = found.value;
          if (row.target_id !== host.targetId) {
            return yield* new MutationError({
              reason: "invalid",
              detail: `intent ${input.intentId} belongs to target ${row.target_id}, not ${host.targetId}`,
            });
          }
          if (row.status !== "open" && row.status !== "proposed") {
            const why =
              row.status === "claimed"
                ? `attempt ${row.claimed_by_attempt_id ?? "(unrecorded)"} is running it; stop that attempt, and once it settles the intent can be abandoned`
                : row.status === "answered"
                  ? "it is answered and holds evidence, which is not retracted"
                  : "it is already abandoned";
            return yield* new MutationError({
              reason: "conflict",
              detail: `intent ${input.intentId} is ${row.status} and cannot be abandoned: ${why}`,
            });
          }

          const updated = yield* sql<{ id: string }>`UPDATE intents
            SET status = 'abandoned'
            WHERE id = ${input.intentId} AND status IN ('open', 'proposed')
            RETURNING id`.pipe(Effect.mapError(asDatabaseError("transaction")));
          if (updated.length === 0) {
            return yield* new MutationError({
              reason: "conflict",
              detail: `intent ${input.intentId} was changed by another call before it could be abandoned`,
            });
          }

          const result: AbandonIntentResult = {
            intentId: input.intentId,
            replayed: false,
          };
          yield* sql`INSERT INTO command_receipts (
              key, caller_scope, operation, operation_id, request_hash, result,
              created_at
            ) VALUES (
              ${key}, ${host.callerScope}, 'abandon_intent', ${input.operationId},
              ${requestHash}, ${JSON.stringify(result)}, ${at}
            )`.pipe(Effect.mapError(asDatabaseError("transaction")));

          yield* appendEvent({
            kind: "intent.abandoned",
            targetId: host.targetId,
            callerScope: host.callerScope,
            intentId: null,
            attemptId: null,
            operation: "abandon_intent",
            operationId: input.operationId,
            subjectId: input.intentId,
            payload: {
              intentId: input.intentId,
              goalId: row.goal_id,
              // So the log names which direction was dropped, not only its id.
              question: row.question,
              reason: input.reason,
            },
            recordedAt: at,
          });

          return result;
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          error._tag === "SqlError"
            ? asDatabaseError("transaction")(error)
            : error,
        ),
      );
  });

  /**
   * Records what the harness said about one running attempt, and settles it accordingly.
   *
   * The harness has already been asked by the time this runs — asking it from inside a
   * transaction would hold SQLite's single write lock across a network round trip. What
   * happens here is only the decision and the write, and all of it is one transaction so
   * that a status change, a fence bump and the recovery record commit together.
   *
   * The rules, in the order they apply:
   *
   * 1. **No terminal regression.** An attempt that is already `succeeded`, `failed` or
   *    `interrupted` is never moved. The harness's answer is still recorded, as
   *    `already_final`, because "we asked again and it said something else" is worth
   *    having.
   * 2. **`uncertain` can be refined but not reopened.** A definite answer replaces it.
   *    An answer of "still running" does not: that attempt's authority has already been
   *    revoked, so it cannot write, and replacement work belongs under a new attempt id.
   * 3. **Leaving `running` revokes authority.** The fence is bumped exactly once, at the
   *    moment the attempt stops running, so every credential minted against the old
   *    value is refused from then on — durably, across a restart.
   * 4. **Missing or unreachable means `uncertain`, never `failed`.** We do not know
   *    whether external effects occurred, and the record says so.
   *
   * What is written is keyed by the whole reconciliation state (see
   * {@link AttemptRecoveryRow}), so a repeat of the same state increments one row and a
   * pass that decided something different gets its own. The row is then read back by
   * that same key and reported, which is why the returned outcome and the persisted
   * record always agree.
   */
  const recordRecovery = Effect.fn("ObservationStore.recordRecovery")(
    function* (write: RecoveryWrite) {
      const now = yield* Clock.currentTimeMillis;
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const attempt = yield* attemptOrFail(write.attemptId);
            if (attempt === undefined) {
              return {
                attemptId: write.attemptId,
                observed: write.observed,
                priorStatus: undefined,
                status: undefined,
                disposition: undefined,
                fenceBefore: 0,
                fenceAfter: 0,
                times: 0,
                observationsAtRecovery: 0,
                detail: `no attempt ${write.attemptId} exists; nothing was recorded`,
              } satisfies RecoveryOutcome;
            }

            const current = attempt.status as AttemptExecutionStatus;
            const decided = decideRecovery(current, write.proposedStatus);
            const fenceBefore = attempt.write_fence;
            const fenceAfter = decided.revokeAuthority
              ? fenceBefore + 1
              : fenceBefore;

            // Counted as information about our own store, never as grounds for the
            // disposition above: it is read after the decision for exactly that reason.
            const held = yield* countObservationsForAttempt(
              write.attemptId,
            ).pipe(Effect.mapError(lift("observations", write.attemptId)));

            // The sweep settles attempts a dead process left behind, so it is the other
            // writer of `attempt.settled` — without this an attempt whose supervisor was
            // killed would carry a `started` with no answer for the life of the log, and
            // "still running" and "the process died" would read the same. Only when the
            // status really moved out of `running`: a repeat pass over an `uncertain` row
            // that learns nothing new changes no state and must not append.
            if (decided.status !== current && decided.status !== "running") {
              yield* appendAttemptEvent({
                kind: "attempt.settled",
                targetId: attempt.target_id,
                attemptId: write.attemptId,
                operation: "record_recovery",
                payload: {
                  attemptId: write.attemptId,
                  intentId: attempt.intent_id,
                  harnessSessionId: attempt.harness_session_id,
                  status: decided.status,
                  priorStatus: current,
                  settledBy: "recovery",
                  disposition: decided.disposition,
                  observed: write.observed,
                },
                recordedAt: now,
              });
            }

            // The sweep is the other writer of a settlement, so it is the other releaser of
            // a claim: an attempt whose supervisor died would otherwise hold its intent for
            // the life of the file. Only when the status really left `running`; a repeat
            // pass, or a refinement of an `uncertain` attempt whose claim was released when
            // it first settled, matches no claimed row and changes nothing.
            if (decided.status !== current && decided.status !== "running") {
              yield* releaseClaim(
                attempt.intent_id,
                decided.status,
                write.attemptId,
              );
            }

            if (decided.status !== current) {
              yield* sql`UPDATE attempts
                  SET status = ${decided.status},
                      ended_at = COALESCE(ended_at, ${now}),
                      write_fence = ${fenceAfter},
                      recovery_disposition = ${decided.disposition},
                      recovered_at = ${now}
                  WHERE id = ${write.attemptId}`.pipe(
                Effect.mapError(asDatabaseError("transaction")),
              );
            } else if (fenceAfter !== fenceBefore) {
              yield* sql`UPDATE attempts
                  SET write_fence = ${fenceAfter},
                      recovery_disposition = ${decided.disposition},
                      recovered_at = ${now}
                  WHERE id = ${write.attemptId}`.pipe(
                Effect.mapError(asDatabaseError("transaction")),
              );
            } else {
              yield* sql`UPDATE attempts
                  SET recovery_disposition = ${decided.disposition},
                      recovered_at = ${now}
                  WHERE id = ${write.attemptId}`.pipe(
                Effect.mapError(asDatabaseError("transaction")),
              );
            }

            const detail = `${write.detail} [${current} -> ${decided.status}, ${decided.disposition}]`;
            // Keyed by the whole reconciliation state, so the upsert can only land on a
            // row that recorded the same thing. Two passes that differ in prior status,
            // disposition or fencing are two rows.
            yield* sql`INSERT INTO attempt_recoveries (
                attempt_id, observed_status, prior_status, resulting_status,
                disposition, detail, harness_session_id, fence_before, fence_after,
                observations_at_recovery, first_reconciled_at, last_reconciled_at, times
              ) VALUES (
                ${write.attemptId}, ${write.observed}, ${current}, ${decided.status},
                ${decided.disposition}, ${detail}, ${attempt.harness_session_id},
                ${fenceBefore}, ${fenceAfter}, ${held.value}, ${now}, ${now}, 1
              )
              ON CONFLICT(attempt_id, observed_status, prior_status, resulting_status,
                          disposition, fence_before, fence_after) DO UPDATE SET
                last_reconciled_at = excluded.last_reconciled_at,
                times = attempt_recoveries.times + 1,
                detail = excluded.detail,
                observations_at_recovery = excluded.observations_at_recovery`.pipe(
              Effect.mapError(asDatabaseError("transaction")),
            );

            const recorded = yield* findRecoveryRecord({
              attemptId: write.attemptId,
              observed: write.observed,
              prior: current,
              resulting: decided.status,
              disposition: decided.disposition,
              fenceBefore,
              fenceAfter,
            }).pipe(
              Effect.mapError(lift("attempt_recoveries", write.attemptId)),
            );

            return {
              attemptId: write.attemptId,
              observed: write.observed,
              priorStatus: current,
              status: decided.status,
              disposition: decided.disposition,
              // Read back from the row this pass keyed, and the fences are part of that
              // key, so what the caller is told and what the table holds are the same
              // values rather than two accounts that can drift apart on a repeat.
              fenceBefore: recorded.fence_before,
              fenceAfter: recorded.fence_after,
              times: recorded.times,
              observationsAtRecovery: held.value,
              detail,
            } satisfies RecoveryOutcome;
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error._tag === "SqlError"
              ? asDatabaseError("transaction")(error)
              : error,
          ),
        );
    },
  );

  /**
   * Opens a fresh attempt to carry on from an abandoned one.
   *
   * The new attempt has its own id, its own fence and no inherited harness session.
   * Nothing is resumed under the old identity: the old attempt keeps whatever status
   * recovery gave it, its observations keep naming it, and `replaces_attempt_id` is the
   * only link between the two.
   *
   * **One transaction, and one purpose-built `INSERT`.** Every check and the write
   * happen inside `sql.withTransaction`, and the link is a column of the inserted row
   * rather than a follow-up `UPDATE`. The arrangement this replaces read the
   * predecessor, called `seedAttempt`, and then linked the new row from outside that
   * transaction: a failure between the two left a replacement attempt with no record of
   * what it replaced, which is indistinguishable from a worker simply starting fresh.
   * It also went through `seedAttempt`'s `ON CONFLICT DO NOTHING`, so an `attemptId`
   * that already existed — another intent's attempt, or the predecessor of something
   * else — was treated as a successful seed and then relinked. It does not re-create the
   * goal or the intent either; the new row hangs off the predecessor's own `intent_id`,
   * which the foreign key then holds to.
   *
   * Four refusals, and none of them writes anything:
   *
   * - there is no such predecessor;
   * - the predecessor is still `running` — replacing a live attempt is how two workers
   *   end up believing they own the same slice;
   * - the predecessor belongs to a different target or intent than the replacement
   *   claims, so the link would assert a continuity that does not exist;
   * - the replacement's `attemptId` is already in use (including the predecessor's own
   *   id). An existing row is **never** adopted as an idempotent success: a replacement
   *   is new work and needs an identity nothing else has written under.
   */
  const openReplacementAttempt = Effect.fn(
    "ObservationStore.openReplacementAttempt",
  )(function* (input: ReplacementInput) {
    const now = yield* Clock.currentTimeMillis;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const replaced = yield* attemptOrFail(input.replacesAttemptId);
          if (replaced === undefined) {
            return yield* new MutationError({
              reason: "invalid",
              detail: `no attempt ${input.replacesAttemptId} to replace`,
            });
          }
          if (replaced.status === "running") {
            return yield* new MutationError({
              reason: "invalid",
              detail: `attempt ${input.replacesAttemptId} is still running; reconcile it before opening a replacement`,
            });
          }
          if (
            replaced.target_id !== input.targetId ||
            replaced.intent_id !== input.intentId
          ) {
            return yield* new MutationError({
              reason: "invalid",
              detail: `attempt ${input.replacesAttemptId} belongs to target ${replaced.target_id} and intent ${replaced.intent_id}, not to target ${input.targetId} and intent ${input.intentId}; a replacement carries on the same slice or it is not a replacement`,
            });
          }
          const clash = yield* attemptOrFail(input.attemptId);
          if (clash !== undefined) {
            return yield* new MutationError({
              reason: "invalid",
              detail:
                input.attemptId === input.replacesAttemptId
                  ? `a replacement must have its own attempt id, not ${input.attemptId} again`
                  : `attempt ${input.attemptId} already exists (intent ${clash.intent_id}, status ${clash.status}); a replacement needs an unused attempt id and this one is not adopted`,
            });
          }
          // The predecessor's own intent and target, not the caller's copy of them:
          // they have just been checked to be equal, and the stored row is the one the
          // foreign key is against.
          const modelOptions = canonicalModelOptions(input.modelOptions);
          yield* sql`INSERT INTO attempts (id, intent_id, target_id, worker_id,
              harness_session_id, harness_instance_id, provider_id, model_id,
              model_options, status, started_at, write_fence, replaces_attempt_id)
            VALUES (${input.attemptId}, ${replaced.intent_id}, ${replaced.target_id},
                    ${input.workerId}, ${input.harnessSessionId},
                    ${input.harnessInstanceId},
                    ${input.providerId}, ${input.modelId},
                    ${modelOptions === null ? null : JSON.stringify(modelOptions)},
                    'running', ${now}, 0,
                    ${input.replacesAttemptId})`.pipe(
            Effect.mapError(asDatabaseError("transaction")),
          );
          // Read back rather than assumed: the row was just inserted in this
          // transaction, and this is the fence a credential for it must carry.
          const opened = yield* attemptOrFail(input.attemptId);
          // A replacement is a new attempt and starts like any other. The predecessor is
          // named in the payload rather than left to be joined for, so a reader following
          // one slice's history does not have to know the column exists.
          yield* appendAttemptEvent({
            kind: "attempt.started",
            targetId: replaced.target_id,
            attemptId: input.attemptId,
            operation: "open_replacement_attempt",
            payload: {
              attemptId: input.attemptId,
              intentId: replaced.intent_id,
              goalId: null,
              workerId: input.workerId,
              harnessInstanceId: input.harnessInstanceId,
              providerId: input.providerId,
              modelId: input.modelId,
              modelOptions,
              harnessSessionId: input.harnessSessionId,
              replacesAttemptId: input.replacesAttemptId,
            },
            recordedAt: now,
          });
          return {
            attemptId: input.attemptId,
            writeFence: opened?.write_fence ?? 0,
          } satisfies AttemptAuthority;
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          error._tag === "SqlError"
            ? asDatabaseError("transaction")(error)
            : error,
        ),
      );
  });

  const selectForIntent = SqlSchema.findAll({
    Request: Schema.String,
    Result: StoredObservationRow,
    execute: (intentId) =>
      sql.unsafe(
        `SELECT ${observationColumns} FROM observations WHERE intent_id = ? ORDER BY sequence`,
        [intentId],
      ),
  });

  /** Observations for one intent, in store order, each in the format it was recorded in. */
  const observationsForIntent = Effect.fn(
    "ObservationStore.observationsForIntent",
  )(function* (intentId: string) {
    const rows = yield* selectForIntent(intentId).pipe(
      Effect.mapError(lift("observations", `intent:${intentId}`)),
    );
    return yield* Effect.forEach(rows, toObservation);
  });

  /**
   * Every link that addresses a dimension raised under this intent.
   *
   * Two changes from the shape `0005` supported, both from the dimension rows. The join
   * is now through `observation_dimensions`, so "which dimension" is a key rather than a
   * parsed position. And the link is selected by the *raising* side, not the addressing
   * one: since the same-intent rule relaxed to same-goal with declared provenance
   * (migration `0009`), an observation under a sibling intent can address a dimension of
   * this one, and selecting by the addressing observation's intent would have silently
   * hidden exactly the link that relaxation exists to allow.
   *
   * Ordered by the raising observation's sequence then the addressing one's, so a reader
   * sees questions in graph order and, under each, the order work landed in.
   */
  const selectLinksForIntent = SqlSchema.findAll({
    Request: Schema.String,
    Result: DimensionLinkRow,
    execute: (intentId) =>
      sql`SELECT links.observation_id, links.dimension_id, links.address,
            links.created_at,
            addressing.sequence AS addressing_sequence,
            addressing.outcome AS addressing_outcome
          FROM observation_dimension_links AS links
          INNER JOIN observation_dimensions AS dimensions
            ON dimensions.id = links.dimension_id
          INNER JOIN observations AS raising
            ON raising.id = dimensions.observation_id
          INNER JOIN observations AS addressing
            ON addressing.id = links.observation_id
          WHERE raising.intent_id = ${intentId}
          ORDER BY raising.sequence, dimensions.position, addressing.sequence`,
  });

  const dimensionLinksForIntent = Effect.fn(
    "ObservationStore.dimensionLinksForIntent",
  )(function* (intentId: string) {
    const rows = yield* selectLinksForIntent(intentId).pipe(
      Effect.mapError(
        lift("observation_dimension_links", `intent:${intentId}`),
      ),
    );
    return rows.map((row): DimensionLink => ({
      observationId: row.observation_id,
      dimensionId: row.dimension_id,
      address: row.address,
      addressingSequence: row.addressing_sequence,
      addressingOutcome: row.addressing_outcome,
    }));
  });

  const selectDimensionsForIntent = SqlSchema.findAll({
    Request: Schema.String,
    Result: StoredDimensionRow,
    execute: (intentId) =>
      sql`SELECT dimensions.id, dimensions.observation_id, dimensions.position,
            dimensions.text, dimensions.created_at
          FROM observation_dimensions AS dimensions
          INNER JOIN observations AS raising
            ON raising.id = dimensions.observation_id
          WHERE raising.intent_id = ${intentId}
          ORDER BY raising.sequence, dimensions.position`,
  });

  /**
   * Every dimension raised under one intent, in graph order.
   *
   * This is what a briefing reads, rather than re-deriving the list from each
   * observation's JSON column, so what a planner is shown is the same identity the write
   * boundary resolves an alias to. The alias is derived here from the row's own
   * observation and position.
   */
  const dimensionsForIntent = Effect.fn("ObservationStore.dimensionsForIntent")(
    function* (intentId: string) {
      const rows = yield* selectDimensionsForIntent(intentId).pipe(
        Effect.mapError(lift("observation_dimensions", `intent:${intentId}`)),
      );
      return rows.map((row): StoredDimension => ({
        dimensionId: row.id,
        observationId: row.observation_id,
        position: row.position,
        text: row.text,
        address: dimensionAddress(row.observation_id, row.position),
      }));
    },
  );

  /**
   * Intents that declared they address a dimension raised under one intent, with how
   * much of their work is still outstanding.
   *
   * `attempts_open` counts attempts in the two statuses no definite answer has been
   * reached about, which is the same pair `unsettledAttempts` sweeps. It is what keeps
   * `scheduled` from becoming a state a question enters and never leaves: when the count
   * reaches zero and no addressing observation landed, the question is open again
   * (DECISIONS.md §17). An intent with no attempt at all reports `attempts_total = 0`,
   * and the caller reads that as "nothing has been dispatched yet" rather than as
   * "everything finished" — see `scheduleOf` in the briefing.
   */
  const selectSchedulesForIntent = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({
      dimension_id: Schema.String,
      intent_id: Schema.String,
      question: Schema.String,
      attempts_total: Schema.Int,
      attempts_open: Schema.Int,
    }),
    execute: (intentId) =>
      sql`SELECT declaring.addresses_dimension AS dimension_id,
            declaring.id AS intent_id,
            declaring.question AS question,
            COUNT(attempts.id) AS attempts_total,
            COALESCE(SUM(
              CASE WHEN attempts.status IN ('running', 'uncertain') THEN 1 ELSE 0 END
            ), 0) AS attempts_open
          FROM intents AS declaring
          INNER JOIN observation_dimensions AS dimensions
            ON dimensions.id = declaring.addresses_dimension
          INNER JOIN observations AS raising
            ON raising.id = dimensions.observation_id
          LEFT JOIN attempts ON attempts.intent_id = declaring.id
          WHERE raising.intent_id = ${intentId}
          GROUP BY declaring.id, declaring.addresses_dimension, declaring.question
          ORDER BY declaring.created_at, declaring.id`,
  });

  const dimensionSchedulesForIntent = Effect.fn(
    "ObservationStore.dimensionSchedulesForIntent",
  )(function* (intentId: string) {
    const rows = yield* selectSchedulesForIntent(intentId).pipe(
      Effect.mapError(lift("intents", `addresses_dimension:${intentId}`)),
    );
    return rows.map((row): DimensionScheduleRow => ({
      dimensionId: row.dimension_id,
      intentId: row.intent_id,
      question: row.question,
      attemptsTotal: row.attempts_total,
      attemptsOpen: row.attempts_open,
    }));
  });

  /* ── The same four reads, scoped to a goal ─────────────────────────────────── */

  // A goal briefing needs every intent of the goal at once (the spec's decision 11), and
  // each of the four below is its `*ForIntent` sibling with the raising side's intent
  // joined to its goal.
  //
  // **What this does not do is find rows the per-intent reads would have missed.** All
  // four select by the *raising* side, and so do their siblings: `selectSchedulesForIntent`
  // is `WHERE raising.intent_id = ?` over *any* declaring intent, which is the design the
  // `0009` relaxation needs and which `briefing.ts` documents. Because a dimension belongs
  // to one observation and an observation to one intent, running the `*ForIntent` reads
  // over every intent of a goal and concatenating yields the same sets — including a
  // dimension raised under one intent and declared by a sibling, which is `scheduled`
  // either way.
  //
  // What the goal-scoped shape buys is the assembly, and that is worth the four statements:
  //
  // - **One statement instead of N + 1.** The caller does not have to read the intent list
  //   first and then fan out per intent, and a goal with thirty intents is four queries
  //   rather than a hundred and twenty.
  // - **One ascending order across the goal.** The observations arrive as the single
  //   sequence they were written in, not as N groups a caller would have to merge — and
  //   that ascending order is what makes a later briefing an extension of an earlier one.
  // - **One pass over a complete set.** `openQuestionsOf` is called once, over every
  //   dimension, link and declaration the goal holds, so the tail is grouped by dimension
  //   id in one place. Concatenating N partial answers would put the merge, and the
  //   question of whether it de-duplicated correctly, in the caller.

  const selectObservationsForGoal = SqlSchema.findAll({
    Request: Schema.String,
    Result: StoredObservationRow,
    execute: (goalId) =>
      sql.unsafe(
        // A subquery rather than a join: `observationColumns` is bare column names, and
        // joining `intents` would make `id`, `target_id` and `created_at` ambiguous.
        `SELECT ${observationColumns} FROM observations
          WHERE intent_id IN (SELECT id FROM intents WHERE goal_id = ?)
          ORDER BY sequence`,
        [goalId],
      ),
  });

  /**
   * Every observation under any intent of one goal, ascending by sequence.
   *
   * Ascending across the whole goal, not grouped by intent: the sequence is the target's
   * own write order, so this is the order the evidence was actually recorded in. Which
   * intent each belongs to is on the observation's provenance.
   */
  const observationsForGoal = Effect.fn("ObservationStore.observationsForGoal")(
    function* (goalId: string) {
      const rows = yield* selectObservationsForGoal(goalId).pipe(
        Effect.mapError(lift("observations", `goal:${goalId}`)),
      );
      return yield* Effect.forEach(rows, toObservation);
    },
  );

  const selectLinksForGoal = SqlSchema.findAll({
    Request: Schema.String,
    Result: DimensionLinkRow,
    execute: (goalId) =>
      sql`SELECT links.observation_id, links.dimension_id, links.address,
            links.created_at,
            addressing.sequence AS addressing_sequence,
            addressing.outcome AS addressing_outcome
          FROM observation_dimension_links AS links
          INNER JOIN observation_dimensions AS dimensions
            ON dimensions.id = links.dimension_id
          INNER JOIN observations AS raising
            ON raising.id = dimensions.observation_id
          INNER JOIN intents AS raisingIntent
            ON raisingIntent.id = raising.intent_id
          INNER JOIN observations AS addressing
            ON addressing.id = links.observation_id
          WHERE raisingIntent.goal_id = ${goalId}
          ORDER BY raising.sequence, dimensions.position, addressing.sequence`,
  });

  /**
   * Every link that addresses a dimension raised under any intent of one goal.
   *
   * Selected by the *raising* side, like {@link dimensionLinksForIntent} and for the same
   * reason: the addressing observation may sit under a sibling intent, or under another
   * goal entirely, and selecting by it would hide the link the same-intent relaxation
   * (migration `0009`) exists to allow.
   */
  const dimensionLinksForGoal = Effect.fn(
    "ObservationStore.dimensionLinksForGoal",
  )(function* (goalId: string) {
    const rows = yield* selectLinksForGoal(goalId).pipe(
      Effect.mapError(lift("observation_dimension_links", `goal:${goalId}`)),
    );
    return rows.map((row): DimensionLink => ({
      observationId: row.observation_id,
      dimensionId: row.dimension_id,
      address: row.address,
      addressingSequence: row.addressing_sequence,
      addressingOutcome: row.addressing_outcome,
    }));
  });

  const selectDimensionsForGoal = SqlSchema.findAll({
    Request: Schema.String,
    Result: StoredDimensionRow,
    execute: (goalId) =>
      sql`SELECT dimensions.id, dimensions.observation_id, dimensions.position,
            dimensions.text, dimensions.created_at
          FROM observation_dimensions AS dimensions
          INNER JOIN observations AS raising
            ON raising.id = dimensions.observation_id
          INNER JOIN intents AS raisingIntent
            ON raisingIntent.id = raising.intent_id
          WHERE raisingIntent.goal_id = ${goalId}
          ORDER BY raising.sequence, dimensions.position`,
  });

  /**
   * Every dimension raised under any intent of one goal, in graph order.
   *
   * **One row per dimension, by construction.** A dimension belongs to exactly one
   * observation and an observation to exactly one intent, so neither join can multiply a
   * row and no de-duplication step is needed or performed here. Two observations that
   * recorded the same sentence recorded two dimensions and stay two rows — see
   * `openQuestionsOf`, which is where that rule is written down.
   */
  const dimensionsForGoal = Effect.fn("ObservationStore.dimensionsForGoal")(
    function* (goalId: string) {
      const rows = yield* selectDimensionsForGoal(goalId).pipe(
        Effect.mapError(lift("observation_dimensions", `goal:${goalId}`)),
      );
      return rows.map((row): StoredDimension => ({
        dimensionId: row.id,
        observationId: row.observation_id,
        position: row.position,
        text: row.text,
        address: dimensionAddress(row.observation_id, row.position),
      }));
    },
  );

  const selectSchedulesForGoal = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({
      dimension_id: Schema.String,
      intent_id: Schema.String,
      question: Schema.String,
      attempts_total: Schema.Int,
      attempts_open: Schema.Int,
    }),
    execute: (goalId) =>
      sql`SELECT declaring.addresses_dimension AS dimension_id,
            declaring.id AS intent_id,
            declaring.question AS question,
            COUNT(attempts.id) AS attempts_total,
            COALESCE(SUM(
              CASE WHEN attempts.status IN ('running', 'uncertain') THEN 1 ELSE 0 END
            ), 0) AS attempts_open
          FROM intents AS declaring
          INNER JOIN observation_dimensions AS dimensions
            ON dimensions.id = declaring.addresses_dimension
          INNER JOIN observations AS raising
            ON raising.id = dimensions.observation_id
          INNER JOIN intents AS raisingIntent
            ON raisingIntent.id = raising.intent_id
          LEFT JOIN attempts ON attempts.intent_id = declaring.id
          WHERE raisingIntent.goal_id = ${goalId}
          GROUP BY declaring.id, declaring.addresses_dimension, declaring.question
          ORDER BY declaring.created_at, declaring.id`,
  });

  /**
   * Every intent that declared it addresses a dimension raised under this goal, with how
   * much of its work is still outstanding.
   *
   * Selected by the raising side's goal, like the three above, so a dimension raised under
   * one intent and taken on by a *sibling* intent of the same goal comes back here. So does
   * it from {@link dimensionSchedulesForIntent}, which selects by the raising side too —
   * this read is not what makes that dimension `scheduled`. What it is, is every such
   * declaration for every dimension of the goal in one answer, keyed by dimension id, which
   * is what lets the briefing's tail be grouped in a single pass.
   *
   * The declaring intent is not restricted to this goal: what the row reports is that
   * somebody declared this dimension, and `intentId` says who, so a reader can see a
   * cross-goal declaration rather than have it dropped.
   */
  const dimensionSchedulesForGoal = Effect.fn(
    "ObservationStore.dimensionSchedulesForGoal",
  )(function* (goalId: string) {
    const rows = yield* selectSchedulesForGoal(goalId).pipe(
      Effect.mapError(lift("intents", `goal:${goalId}`)),
    );
    return rows.map((row): DimensionScheduleRow => ({
      dimensionId: row.dimension_id,
      intentId: row.intent_id,
      question: row.question,
      attemptsTotal: row.attempts_total,
      attemptsOpen: row.attempts_open,
    }));
  });

  const selectSequence = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: SequenceRow,
    execute: (name) =>
      sql`SELECT value FROM sequence_cursor WHERE name = ${name}`,
  });

  const sequenceNamed = (name: string) =>
    selectSequence(name).pipe(
      Effect.map(Option.getOrElse(() => ({ value: 0 }))),
      Effect.map((row) => row.value),
      Effect.mapError((error) =>
        error._tag === "SqlError"
          ? asDatabaseError("query")(error)
          : new DatabaseError({
              operation: "query",
              reason: "sequence_cursor did not decode",
              cause: error,
            }),
      ),
    );

  const currentSequence = sequenceNamed(SEQUENCE_NAME);

  /**
   * The last sequence the event log assigned, or `0` for a file nothing has written to.
   *
   * **A separate counter from {@link currentSequence}, which is the observations'**, and the
   * two must not be confused: they advance at different rates — one mutation writes one
   * event and not necessarily an observation — so reading one for the other would be
   * reporting a position in a log that nobody is reading.
   *
   * Taken from `sequence_cursor` rather than `SELECT MAX(sequence) FROM events`, because
   * the counter is bumped *inside* the writing transaction and a rolled-back mutation
   * therefore leaves it untouched (`store.test.ts`: "a refused mutation leaves no event
   * sequence gap"). The two answers agree, and this one is a single-row lookup on a primary
   * key rather than a scan.
   *
   * What it is for: a consumer opening a cursor read needs to know where the end is, so it
   * can say whether it is showing the whole log or a bounded tail of it.
   */
  const currentEventSequence = sequenceNamed(EVENT_SEQUENCE_NAME);

  const selectIntent = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: IntentJoinRow,
    execute: (intentId) =>
      sql`SELECT intents.id AS intent_id, intents.question AS question,
            intents.target_id AS target_id, goals.description AS goal
          FROM intents
          INNER JOIN goals ON intents.goal_id = goals.id
          WHERE intents.id = ${intentId}`,
  });

  const loadIntent = Effect.fn("ObservationStore.loadIntent")(function* (
    intentId: string,
  ) {
    const row = yield* selectIntent(intentId).pipe(
      Effect.mapError((error) =>
        error._tag === "SqlError"
          ? asDatabaseError("query")(error)
          : new DatabaseError({
              operation: "query",
              reason: "intents row did not decode",
              cause: error,
            }),
      ),
    );
    return Option.match(row, {
      onNone: () => undefined,
      onSome: (value): IntentRow => ({
        intentId: value.intent_id,
        question: value.question,
        targetId: value.target_id,
        goal: value.goal,
      }),
    });
  });

  const selectAttempt = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: Schema.String, targetId: Schema.String }),
    Result: AttemptRow,
    execute: (request) =>
      sql.unsafe(
        `SELECT ${attemptColumns} FROM attempts WHERE id = ? AND target_id = ?`,
        [request.id, request.targetId],
      ),
  });

  const loadAttempt = Effect.fn("ObservationStore.loadAttempt")(function* (
    attemptId: string,
    targetId: string,
  ) {
    const row = yield* selectAttempt({ id: attemptId, targetId }).pipe(
      Effect.mapError(lift("attempts", attemptId)),
    );
    return Option.getOrUndefined(row);
  });

  const selectUnsettled = SqlSchema.findAll({
    Request: Schema.Void,
    Result: AttemptRow,
    execute: () =>
      sql.unsafe(
        `SELECT ${attemptColumns} FROM attempts
         WHERE status IN ('running', 'uncertain')
         ORDER BY started_at, id`,
        [],
      ),
  });

  /**
   * Attempts no definite answer has been reached about: `running` and `uncertain`.
   *
   * This is the recovery entry point, and it is deliberately wider than "running". A
   * `running` row after a restart means a previous process left an attempt unsettled. An
   * `uncertain` row means reconciliation already ran and could not find out — which is
   * an admission, not a conclusion, and {@link decideRecovery} allows a later definite
   * answer to refine it. Reading only `running` here is what previously made that
   * refinement unreachable in practice: the first sweep moved the row out of `running`,
   * and no later sweep ever looked at it again.
   *
   * The two statuses are named rather than derived as "not final", because they are
   * exactly the two {@link decideRecovery} has rules for. A row holding something else —
   * which nothing writes, but an adopted database is not something we get to assume
   * about — is left alone instead of being fed to a decision that would read it as
   * `running` and move it.
   */
  const unsettledAttempts = Effect.fn("ObservationStore.unsettledAttempts")(
    function* () {
      return yield* selectUnsettled().pipe(
        Effect.mapError(lift("attempts", "status:unsettled")),
      );
    },
  );

  const selectRecoveries = SqlSchema.findAll({
    Request: Schema.String,
    Result: AttemptRecoveryRow,
    execute: (attemptId) =>
      // `rowid`, not the timestamp: two reconciliations in the same millisecond are
      // ordinary, and ordering them by `first_reconciled_at` would then fall back to
      // whatever the tiebreaker column happened to sort as. `rowid` is insertion order
      // and an upsert preserves it, so this is "in the order first seen". It requires
      // the table to keep its implicit rowid — it must not become `WITHOUT ROWID`.
      sql.unsafe(
        `SELECT ${recoveryColumns} FROM attempt_recoveries WHERE attempt_id = ?
         ORDER BY rowid`,
        [attemptId],
      ),
  });

  const recoveriesForAttempt = Effect.fn(
    "ObservationStore.recoveriesForAttempt",
  )(function* (attemptId: string) {
    return yield* selectRecoveries(attemptId).pipe(
      Effect.mapError(lift("attempt_recoveries", attemptId)),
    );
  });

  const selectRecentRecoveries = SqlSchema.findAll({
    Request: Schema.Void,
    Result: RecentRecoveryRow,
    // The latest reconciliation per attempt, only while its resulting status is still
    // current. A run that later settled normally must not keep a "still running" notice.
    execute: () => sql`SELECT r.attempt_id, a.status, r.disposition,
        r.observed_status, r.detail, r.last_reconciled_at
      FROM attempt_recoveries AS r JOIN attempts AS a ON a.id = r.attempt_id
      WHERE r.rowid = (SELECT r2.rowid FROM attempt_recoveries AS r2
        WHERE r2.attempt_id = r.attempt_id
        ORDER BY r2.last_reconciled_at DESC, r2.rowid DESC LIMIT 1)
        AND a.status = r.resulting_status
      ORDER BY r.last_reconciled_at DESC, r.rowid DESC LIMIT 20`,
  });
  const recentRecoveries = Effect.fn("ObservationStore.recentRecoveries")(
    function* () {
      return yield* selectRecentRecoveries().pipe(
        Effect.mapError(lift("attempt_recoveries", "recent")),
      );
    },
  );

  const selectPlannerLineage = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ harness_session_id: Schema.String }),
    execute: (goalId) =>
      sql`SELECT harness_session_id FROM planner_lineages
          WHERE goal_id = ${goalId}`,
  });

  /**
   * The harness session later planner rounds on this **goal** should be opened under.
   *
   * Keyed by goal since migration `0019`: one planner works one goal, so one lineage per
   * goal is what the table means. A hint, not a fact — the id names a row in OpenCode's
   * storage, which can be cleared without ours changing. A caller confirms it and records
   * a replacement when it cannot; nothing in the investigation depends on the answer
   * either way.
   */
  const plannerLineage = Effect.fn("ObservationStore.plannerLineage")(
    function* (goalId: string) {
      const row = yield* selectPlannerLineage(goalId).pipe(
        Effect.mapError(lift("planner_lineages", goalId)),
      );
      return Option.match(row, {
        onNone: () => undefined,
        onSome: (value) => value.harness_session_id,
      });
    },
  );

  /**
   * Records the lineage for a goal, replacing any earlier one.
   *
   * An upsert rather than an insert: a lineage the harness has forgotten is replaced by
   * the next round, and there is exactly one current answer per goal.
   */
  const recordPlannerLineage = Effect.fn(
    "ObservationStore.recordPlannerLineage",
  )(function* (goalId: string, harnessSessionId: string) {
    const now = yield* Clock.currentTimeMillis;
    yield* sql`INSERT INTO planner_lineages (goal_id, harness_session_id, created_at)
      VALUES (${goalId}, ${harnessSessionId}, ${now})
      ON CONFLICT(goal_id) DO UPDATE SET
        harness_session_id = excluded.harness_session_id,
        created_at = excluded.created_at`.pipe(
      Effect.mapError(asDatabaseError("query")),
    );
  });

  /**
   * Opens a planner round and returns the write authority a credential for it must carry.
   *
   * The round-shaped counterpart of {@link seedAttempt}, with three differences that are
   * each a decision rather than an omission:
   *
   * - **It is not idempotent.** `seedAttempt` re-seeds harmlessly because a demo re-runs;
   *   a round id that already exists is refused as a `conflict` here, because handing back
   *   authority over somebody else's live round is the one mistake this slice exists to
   *   prevent. Ids come from `identifier.newRoundId`, so a collision is a bug, not a retry.
   * - **It refuses a second running round on the same goal, naming the holder.** One round
   *   per goal at a time (the spec's decision 7). This is the *durable* half of that claim
   *   and it holds across processes; the in-process half — claiming the goal synchronously
   *   before the fiber forks — is the `FiberMap` slice 5 adds, and it is what stops two
   *   starts in the same process racing before either row exists. Neither half replaces
   *   the other, and the index on `(goal_id, status)` is what makes this one cheap.
   * - **It appends `plan.round.started`, unconditionally.** Unlike {@link seedAttempt},
   *   which reads the row first because re-seeding is idempotent, this is not idempotent
   *   at all: a round id that already exists is refused above, so reaching the insert
   *   means a round really began and exactly one event says so. The pair matters more for
   *   a round than for an attempt — a round's prose is never persisted, so these two
   *   records are the only durable trace that it happened at all (the spec's decisions 14
   *   and 16).
   *
   * An ended goal is refused: ending a goal blocks new dispatch and planner wake-ups
   * (decision 8), and opening a round is a planner wake-up.
   *
   * `startedAtSequence` is read inside the transaction and is **provenance** — see
   * {@link RoundAuthority.startedAtSequence}. Nothing treats it as a snapshot.
   */
  const openRound = Effect.fn("ObservationStore.openRound")(function* (
    host: HostContext,
    input: OpenRoundInput,
  ) {
    const now = yield* Clock.currentTimeMillis;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const goal = yield* goalAuthorityRow(input.goalId).pipe(
            Effect.mapError(lift("goals", input.goalId)),
          );
          if (Option.isNone(goal) || goal.value.target_id !== host.targetId) {
            return yield* new MutationError({
              reason: "unauthorized",
              detail: `goal ${input.goalId} does not belong to target ${host.targetId}, so no planner round can be opened under it`,
            });
          }
          if (goal.value.status !== "active") {
            return yield* new MutationError({
              reason: "invalid",
              detail: `goal ${input.goalId} is ${goal.value.status}; ending a goal blocks new planner rounds under it, so none was opened`,
            });
          }
          const clash = yield* roundOrFail(input.roundId);
          if (clash !== undefined) {
            return yield* new MutationError({
              reason: "conflict",
              detail: `round ${input.roundId} already exists under goal ${clash.goal_id}; a round id is minted per round and is never reused`,
            });
          }
          const live = yield* selectRunningRoundOfGoal(input.goalId).pipe(
            Effect.mapError(lift("planner_rounds", input.goalId)),
          );
          if (Option.isSome(live)) {
            return yield* new MutationError({
              reason: "conflict",
              detail: `goal ${input.goalId} already has round ${live.value.id} running; one planner round works a goal at a time, so this one was not opened`,
            });
          }
          const startedAtSequence = yield* sequenceNamed(SEQUENCE_NAME);
          yield* sql`INSERT INTO planner_rounds (id, goal_id, target_id, status,
              write_fence, harness_session_id, harness_instance_id, provider_id,
              model_id, started_at_sequence, budget, disposition, started_at, ended_at)
            VALUES (${input.roundId}, ${input.goalId}, ${host.targetId}, 'running',
                    0, ${input.harnessSessionId}, ${input.harnessInstanceId},
                    ${input.providerId}, ${input.modelId}, ${startedAtSequence},
                    ${input.budget}, NULL, ${now}, NULL)`.pipe(
            Effect.mapError(asDatabaseError("transaction")),
          );
          yield* appendRoundEvent({
            kind: "plan.round.started",
            targetId: host.targetId,
            roundId: input.roundId,
            operation: "open_round",
            payload: {
              roundId: input.roundId,
              goalId: input.goalId,
              harnessSessionId: input.harnessSessionId,
              harnessInstanceId: input.harnessInstanceId,
              providerId: input.providerId,
              modelId: input.modelId,
              budget: input.budget,
              // Provenance, and said to be provenance: see
              // {@link RoundAuthority.startedAtSequence}. A reader must not take it for
              // the state the round saw.
              startedAtSequence,
            },
            recordedAt: now,
          });
          return {
            roundId: input.roundId,
            writeFence: 0,
            startedAtSequence,
          } satisfies RoundAuthority;
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          error._tag === "SqlError"
            ? asDatabaseError("transaction")(error)
            : error,
        ),
      );
  });

  const selectRunningRoundOfGoal = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ id: Schema.String }),
    execute: (goalId) =>
      sql`SELECT id FROM planner_rounds
          WHERE goal_id = ${goalId} AND status = 'running'
          ORDER BY started_at LIMIT 1`,
  });

  /** One round by id, or `undefined`. Read-only. */
  const loadRound = Effect.fn("ObservationStore.loadRound")(function* (
    roundId: string,
  ) {
    const row = yield* roundOrFail(roundId);
    return row === undefined ? undefined : toStoredRound(row);
  });

  const selectRunningRounds = SqlSchema.findAll({
    Request: Schema.Void,
    Result: RoundRow,
    execute: () =>
      sql.unsafe(
        `SELECT ${roundColumns} FROM planner_rounds
         WHERE status = 'running'
         ORDER BY started_at, id`,
        [],
      ),
  });

  /**
   * Rounds a process left `running`. The startup sweep's entry point for rounds.
   *
   * **Narrower than {@link unsettledAttempts}, deliberately, and the asymmetry is a
   * consequence rather than an oversight.** That one also reads `uncertain`, because
   * `recordRecovery` lets a later definite answer *refine* an `uncertain` attempt and a
   * sweep that read only `running` could never deliver one. A round has no such path:
   * {@link settleRound} is guarded to `status = 'running'`, there is no
   * `round_recoveries` table and nothing is allowed to move a round that has already left
   * `running`. So an `uncertain` round is final here, and reading it would be reading rows
   * the sweep could do nothing with.
   *
   * What that costs is worth stating: a round swept to `uncertain` while the harness was
   * unreachable stays `uncertain` even if the harness could answer a minute later. Its
   * authority is already gone — the fence has moved and the goal is free for another round
   * — so the cost is a less precise record and never a blocked goal.
   */
  const roundsLeftRunning = Effect.fn("ObservationStore.roundsLeftRunning")(
    function* () {
      const rows = yield* selectRunningRounds().pipe(
        Effect.mapError(lift("planner_rounds", "status:running")),
      );
      return rows.map(toStoredRound);
    },
  );

  /**
   * Points a round's row at the session the harness actually created.
   *
   * {@link bindSessionToAttempt}'s counterpart, for the same window and with the same
   * reasoning: the plan supervisor mints the session id and writes it into the round row
   * *before* the session exists, so a process that died in between leaves a row naming a
   * session that was never created — which the sweep handles by asking and being told
   * `missing` — rather than a live session no row points at. This is the repair for the
   * one case that breaks: a harness that ignores the id it was handed. Both real drivers
   * were measured to honour it, and a row naming a session nobody has would be worse than
   * a rebind plus a warning.
   */
  const bindSessionToRound = Effect.fn("ObservationStore.bindSessionToRound")(
    function* (roundId: string, harnessSessionId: string) {
      yield* sql`UPDATE planner_rounds SET harness_session_id = ${harnessSessionId}
        WHERE id = ${roundId}`.pipe(Effect.mapError(asDatabaseError("query")));
      return harnessSessionId;
    },
  );

  /**
   * Records the round's terminal status.
   *
   * Guarded to `status = 'running'`, exactly as {@link settleAttempt} is and for the same
   * reason: a round settling itself must not overwrite what a recovery sweep already
   * decided about it. `changed: false` says this call wrote nothing, and `effective` says
   * what the row holds instead.
   *
   * The disposition is **not** touched here. A round that recorded one keeps it, and a
   * round that recorded none settles with `disposition` still null — which is the honest
   * record of a round that was interrupted or could not say what it concluded. Writing a
   * disposition at settlement would be the host inventing the planner's answer. It is
   * carried into the event as a fact about the row, so a reader of the log alone can tell
   * a round that concluded something from one that did not.
   *
   * **`plan.round.settled` is appended only when the status actually moved**, which is
   * {@link settleAttempt}'s rule and the property that makes the log trustworthy: an event
   * with no domain change behind it would say something happened twice.
   *
   * `settledBy` is a parameter rather than a constant because this one function has two
   * callers that mean different things — the supervisor that watched the round, and the
   * startup sweep that found the row a dead process left. `settleAttempt` hard-codes
   * `"supervisor"` and the sweep writes its own event through `recordRecovery`; a round has
   * no `recordRecovery`, no `round_recoveries` table and no refinement path, so the one
   * place the distinction can live is here. Required rather than defaulted: a default would
   * make a sweep that forgot to say so file itself as a supervisor. It is tagged, so a
   * sweep also cannot forget to record *what the harness said*; see {@link RoundSettler}.
   */
  const settleRound = Effect.fn("ObservationStore.settleRound")(function* (
    roundId: string,
    status: RoundTerminalStatus,
    settledBy: RoundSettler,
  ) {
    const endedAt = yield* Clock.currentTimeMillis;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const before = yield* roundOrFail(roundId);
          if (before === undefined) {
            return {
              requested: status,
              effective: undefined,
              changed: false,
            } satisfies RoundSettlement;
          }
          if (before.status !== "running") {
            return {
              requested: status,
              effective: before.status,
              changed: false,
            } satisfies RoundSettlement;
          }
          yield* sql`UPDATE planner_rounds
              SET status = ${status}, ended_at = ${endedAt}
            WHERE id = ${roundId} AND status = 'running'`.pipe(
            Effect.mapError(asDatabaseError("transaction")),
          );
          yield* appendRoundEvent({
            kind: "plan.round.settled",
            targetId: before.target_id,
            roundId,
            operation: "settle_round",
            payload: {
              roundId,
              goalId: before.goal_id,
              harnessSessionId: before.harness_session_id,
              status,
              priorStatus: before.status,
              settledBy: settledBy._tag,
              // What the harness said, when the settler asked one. Null for a supervisor's
              // own settlement, which is an honest absence rather than a missing field:
              // see {@link RoundSettler}.
              observed:
                settledBy._tag === "recovery" ? settledBy.observed : null,
              // The row's own disposition, untouched by this write. Null is the honest
              // record of a round that never said what it concluded.
              disposition: before.disposition,
            },
            recordedAt: endedAt,
          });
          return {
            requested: status,
            effective: status,
            changed: true,
          } satisfies RoundSettlement;
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          error._tag === "SqlError"
            ? asDatabaseError("transaction")(error)
            : error,
        ),
      );
  });

  /**
   * Supersedes a round's write authority, returning the fence it now carries.
   *
   * The durable half of revoking a round credential, and the reason the column exists
   * (ruling 5 of the slice brief): `McpCredentials.revokeRound` forgets the grants *this*
   * process is holding, and this makes a credential minted before a restart unusable
   * after one. Both are needed because they cover different windows, which is the
   * argument `revokeAttempt` already makes for attempts.
   *
   * `undefined` for a round that does not exist: there is no authority to supersede, and
   * inventing a fence for a missing row would be reporting work that did not happen.
   * Separate from {@link settleRound} on purpose — a sweep that cannot tell how a round
   * ended still has to stop its credential, and settling it would be claiming to know.
   */
  const supersedeRound = Effect.fn("ObservationStore.supersedeRound")(
    function* (roundId: string) {
      const bumped = yield* sql<{
        write_fence: number;
      }>`UPDATE planner_rounds SET write_fence = write_fence + 1
          WHERE id = ${roundId}
          RETURNING write_fence`.pipe(
        Effect.mapError(asDatabaseError("query")),
      );
      return bumped[0]?.write_fence;
    },
  );

  /**
   * Records what one planner round concluded, under the round's own authority.
   *
   * The store half of `record_round_disposition`. A round credential can write this, and
   * an attempt or goal credential cannot.
   *
   * Two refusals beyond the authority path's own:
   *
   * - A round that already recorded a disposition is refused as a `conflict` naming it. A
   *   round concludes once; letting a second call overwrite the first would make the
   *   column the planner's latest opinion rather than the round's answer.
   * - The authority path refuses a settled round (`stale`) and a round of another goal
   *   (`unauthorized`), so a late call from a round that has already been swept records
   *   nothing.
   *
   * **A round whose budget is spent may still record a disposition**, and nothing here has
   * to do anything for that to be true: the budget lives on the `add_intent` path alone
   * (`RoundIntentRefused.budget_spent`), and this write consults it nowhere. Said plainly
   * because it is a requirement, and a requirement satisfied by an absence is one a later
   * change can break without noticing.
   *
   * No receipt key, unlike `addIntent` and `record_observation`. A disposition is
   * idempotent by its own rule — the second call is a conflict whether it is a retry or a
   * change of mind — so a receipt would add a second answer to a question the row already
   * answers. Re-confirmed now that the tool exists: the tool has no `operation_id` field,
   * so there is no retry key a planner could think it had.
   *
   * ## `objective_met` ends the goal, in this transaction
   *
   * The spec's decision 8: a goal ends when the planner records that the objective is met
   * or when the operator ends it. So this call does both writes or neither —
   * {@link endGoalWithin} runs inside the same transaction, with `endedBy: "planner"` and
   * the planner's own rationale as the reason. Two transactions would leave a window where
   * the round says `objective_met` and the goal is still taking work, and a failure in the
   * second would make that window permanent.
   *
   * The operation id handed to the ending is **derived**, not minted:
   * `round:<roundId>:objective_met`. A round concludes once, so there is one such ending
   * per round by construction, and deriving it means a retry that somehow reached the
   * ending twice replays its receipt rather than conflicting on it.
   *
   * A goal that is **already ended** is not a failure here. `endGoalWithin` refuses it as
   * a `conflict`, and that refusal is swallowed deliberately: the planner's conclusion
   * about the goal is true whether or not an operator got there first, and failing the
   * disposition would discard the round's answer over a race the planner cannot see. What
   * is not swallowed is anything else the ending fails with — those roll the whole
   * transaction back, so the disposition is not recorded either.
   */
  const recordRoundDisposition = Effect.fn(
    "ObservationStore.recordRoundDisposition",
  )(function* (
    caller: CallerContext,
    disposition: RoundDisposition,
    rationale: string,
  ) {
    const planner = yield* roundCallerOrFail(
      caller,
      "record a round disposition",
    );
    const recordedAt = yield* Clock.currentTimeMillis;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const round = yield* checkRoundAuthority(planner);
          if (round.disposition !== null) {
            return yield* new MutationError({
              reason: "conflict",
              detail: `round ${planner.roundId} already recorded the disposition '${round.disposition}'; a round concludes once, so '${disposition}' was NOT recorded`,
            });
          }
          yield* sql`UPDATE planner_rounds
              SET disposition = ${disposition},
                  disposition_rationale = ${rationale}
            WHERE id = ${planner.roundId} AND status = 'running'`.pipe(
            Effect.mapError(asDatabaseError("transaction")),
          );
          let goalEnded = false;
          if (disposition === "objective_met") {
            const ended = yield* Effect.result(
              endGoalWithin(
                {
                  callerScope: planner.callerScope,
                  targetId: planner.targetId,
                },
                {
                  operationId: `round:${planner.roundId}:objective_met`,
                  goalId: planner.goalId,
                  status: "met",
                  endedBy: "planner",
                  reason: rationale,
                },
                recordedAt,
              ),
            );
            if (ended._tag === "Success") {
              goalEnded = true;
            } else if (
              ended.failure._tag === "MutationError" &&
              ended.failure.reason === "conflict"
            ) {
              // Already ended, by an operator or by an earlier call. The round's
              // conclusion stands; see this function's header.
              yield* Effect.logInfo(
                "a planner round concluded objective_met on a goal that was already ended",
                {
                  roundId: planner.roundId,
                  goalId: planner.goalId,
                  detail: ended.failure.detail,
                },
              );
            } else {
              return yield* ended.failure;
            }
          }
          // In this transaction, for the reason `addRoundIntent`'s count is in its own:
          // a follow-up read could race a sweep and refuse a call that succeeded.
          const counted = yield* countScopedIntents(planner.callerScope).pipe(
            Effect.mapError(lift("command_receipts", planner.callerScope)),
          );
          return {
            roundId: planner.roundId,
            disposition,
            rationale,
            goalEnded,
            budget: round.budget,
            intentsAdded: counted.added,
          };
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          error._tag === "SqlError"
            ? asDatabaseError("transaction")(error)
            : error,
        ),
      );
  });

  /**
   * Every round of one goal, newest first, with how much of its budget it spent.
   *
   * `intentsAdded` comes from {@link countScopedIntents} over each round's own caller
   * scope, which is why it is here rather than on {@link loadRound}: the number is a join
   * against another table and a caller that wanted only the row should not pay for it.
   *
   * Read-only, and the rows rather than what this process is supervising. A row that says
   * `running` is not the same claim as a round in flight — see `RunningRound` in
   * `@bit/contracts` — and the two answers are deliberately two reads.
   */
  const roundsForGoal = Effect.fn("ObservationStore.roundsForGoal")(function* (
    goalId: string,
  ) {
    const rows = yield* selectRoundsForGoal(goalId).pipe(
      Effect.mapError(lift("planner_rounds", goalId)),
    );
    return yield* Effect.forEach(rows, (row) =>
      Effect.map(
        countScopedIntents(
          callerScopeOf({
            _tag: "round",
            targetId: row.target_id,
            roundId: row.id,
          }),
        ).pipe(Effect.mapError(lift("command_receipts", row.id))),
        (counted) => ({
          ...toStoredRound(row),
          intentsAdded: counted.added,
        }),
      ),
    );
  });

  /* ── The goal agent's session, and the two writes it makes ─────────────────── */

  const selectGoalSession = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({
      harness_session_id: Schema.String,
      harness_instance_id: Schema.NullOr(Schema.String),
      opened_at: Schema.Finite,
    }),
    execute: (goalId) =>
      sql`SELECT harness_session_id, harness_instance_id, opened_at
          FROM goal_sessions WHERE goal_id = ${goalId}`,
  });

  /**
   * The harness session this goal's conversation was last opened on, if any.
   *
   * **A hint about somebody else's storage, exactly as {@link plannerLineage} is**, and the
   * same caution applies twice over: the id names a session in the harness's own store,
   * which can be cleared without ours changing, and the *credential* that made that session
   * able to do anything died with the process that minted it. So a row here says "a
   * conversation was opened on this goal", never "a conversation is live".
   *
   * `undefined` means nobody has ever talked to this goal, which is a different answer from
   * a row whose session the harness has forgotten — and
   * `plan/goalConversation.ts` reports the two differently because an operator does
   * different things about them.
   */
  const goalSession = Effect.fn("ObservationStore.goalSession")(function* (
    goalId: string,
  ) {
    const row = yield* selectGoalSession(goalId).pipe(
      Effect.mapError(lift("goal_sessions", goalId)),
    );
    return Option.match(row, {
      onNone: () => undefined,
      onSome: (value) => ({
        harnessSessionId: value.harness_session_id,
        harnessInstanceId: value.harness_instance_id,
        openedAt: value.opened_at,
      }),
    });
  });

  /**
   * Records which session a goal's conversation is on, replacing any earlier one.
   *
   * An upsert for {@link recordPlannerLineage}'s reason: there is exactly one current
   * answer per goal, and a session this process can no longer reach is replaced by the one
   * the next message opens. **The replaced id is not kept**, and that is deliberate rather
   * than an omission — a history of sessions would be the first step towards storing the
   * conversation, which this build does not do (the goal and planner flow's decision 15),
   * and nothing reads it.
   */
  const recordGoalSession = Effect.fn("ObservationStore.recordGoalSession")(
    function* (input: {
      readonly goalId: string;
      readonly targetId: string;
      readonly harnessSessionId: string;
      readonly harnessInstanceId: string | null;
    }) {
      const now = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO goal_sessions (
            goal_id, target_id, harness_session_id, harness_instance_id, opened_at
          ) VALUES (
            ${input.goalId}, ${input.targetId}, ${input.harnessSessionId},
            ${input.harnessInstanceId}, ${now}
          )
          ON CONFLICT(goal_id) DO UPDATE SET
            harness_session_id = excluded.harness_session_id,
            harness_instance_id = excluded.harness_instance_id,
            opened_at = excluded.opened_at`.pipe(
        Effect.mapError(asDatabaseError("query")),
      );
    },
  );

  /** What a recorded steer answers with, and what a retry of one replays. */
  const SteerResult = Schema.Struct({
    roundId: Schema.String,
    goalId: Schema.String,
    /**
     * Which way the directive reached the planner.
     *
     * `steered` — injected into a round that was already live, which is the case that
     * appends `plan.round.steered`. `opened` — carried in the opening prompt of a round
     * opened for it, which appends nothing because the round was never redirected.
     *
     * **It is on the stored result because the retry answer depends on it**, which is the
     * whole of Important finding 1: an operation that reached the planner through a new
     * round must not reach it a second time as a steer, and a caller replaying the receipt
     * has to be told which of the two happened the first time.
     */
    how: Schema.Literals(["steered", "opened"]),
    urgency: Schema.Literals(["queued", "preemptive"]),
    messageId: Schema.String,
    steeredAt: Schema.Finite,
  });

  const selectSteerReceipt = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ result: Schema.String }),
    execute: (key) =>
      sql`SELECT result FROM command_receipts WHERE key = ${key}`,
  });

  /**
   * What one `steer_planner` operation already did, if anything.
   *
   * **A read, before either branch of the tool decides anything**, and it exists because of
   * a measured double delivery: `steer_planner` has two ways of reaching the planner, only
   * one of them used to write a receipt, and a retry that fell down the other branch
   * delivered the same directive twice — once in a round's opening prompt and once as a
   * steer into that same round, with a `plan.round.steered` event claiming a redirect that
   * never happened.
   *
   * So the receipt is the operation's whole identity: **one `operation_id`, one delivery,
   * whichever branch took it.** A retry replays this answer and sends nothing. An operation
   * first used while a round was live, retried when none is, replays `steered` rather than
   * opening a round for a directive the planner already has; and the other way round for
   * `opened`.
   *
   * It does **not** compare request hashes, and that is deliberate rather than an omission.
   * The directive text is not in the hashed input — the record carries no directive, by
   * design — so a reused id with different words is indistinguishable from a retry to
   * everything durable, and pretending otherwise is the mistake Important finding 3 names.
   * The agent is told what the id already did; the tool's description is where the rule
   * "a new directive needs a new operation id" lives.
   */
  const steerReceipt = Effect.fn("ObservationStore.steerReceipt")(function* (
    caller: CallerContext,
    operationId: string,
  ) {
    const agent = yield* goalCallerOrFail(caller, "steer a planner round");
    const key = `${agent.callerScope}:steer_planner:${operationId}`;
    const row = yield* selectSteerReceipt(key).pipe(
      Effect.mapError(lift("command_receipts", key)),
    );
    if (Option.isNone(row)) return undefined;
    return yield* replayResult(key, SteerResult, row.value.result);
  });

  /**
   * Records that the goal agent steered one of its goal's rounds.
   *
   * **The record is the whole point and it carries no directive text.** A steer is `opaque`
   * on both drivers' narration (DECISIONS.md §24.1, consequence 6), so without this event
   * a round whose framing changed mid-flight would read as having answered the question it
   * opened with. What the event holds is the round, the goal, the urgency and the derived
   * message id; the directive itself is the conversation's, and this build stores no
   * conversation.
   *
   * **It checks the round belongs to the caller's goal and nothing else about it.** Not its
   * status: by the time this is called the directive has already been delivered — see
   * `plan/planSupervisor.ts` on why delivery comes first — and refusing to record a steer
   * that landed would leave the round's transcript claiming the round was never redirected.
   * A round that settled between the delivery and this call is recorded as steered because
   * it was.
   *
   * **`how: "opened"` writes the receipt and no event.** That branch is the directive
   * travelling in a round's *opening prompt*: nothing was redirected, so an event would be
   * a false claim — and the receipt is still written, because without it a retry of the
   * same operation would deliver the directive a second time as a steer. The receipt is the
   * operation's identity on both branches; see {@link steerReceipt}, which is what a caller
   * reads before it decides which branch to take.
   */
  const recordRoundSteer = Effect.fn("ObservationStore.recordRoundSteer")(
    function* (
      caller: CallerContext,
      input: {
        readonly operationId: string;
        readonly roundId: string;
        readonly how: "steered" | "opened";
        readonly urgency: "queued" | "preemptive";
        readonly messageId: string;
      },
    ) {
      const agent = yield* goalCallerOrFail(caller, "steer a planner round");
      const key = `${agent.callerScope}:steer_planner:${input.operationId}`;
      const requestHash = hashRequest(agent, input);
      const steeredAt = yield* Clock.currentTimeMillis;
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const existing = yield* findReceipt(key).pipe(
              Effect.mapError(lift("command_receipts", key)),
            );
            if (Option.isSome(existing)) {
              const receipt = existing.value;
              if (receipt.request_hash !== requestHash) {
                return yield* new MutationError({
                  reason: "conflict",
                  detail: `operation ${input.operationId} was already used to steer with different arguments`,
                });
              }
              return {
                ...(yield* replayResult(key, SteerResult, receipt.result)),
                replayed: true,
              };
            }
            const round = yield* roundOrFail(input.roundId);
            if (
              round === undefined ||
              round.goal_id !== agent.goalId ||
              round.target_id !== agent.targetId
            ) {
              return yield* new MutationError({
                reason: "invalid",
                detail: `round ${input.roundId} is not a round of goal ${agent.goalId}, so no steer of it was recorded`,
              });
            }
            const result: typeof SteerResult.Type = {
              roundId: input.roundId,
              goalId: agent.goalId,
              how: input.how,
              urgency: input.urgency,
              messageId: input.messageId,
              steeredAt,
            };
            yield* sql`INSERT INTO command_receipts (
                  key, caller_scope, operation, operation_id, request_hash, result,
                  created_at
                ) VALUES (
                  ${key}, ${agent.callerScope}, 'steer_planner', ${input.operationId},
                  ${requestHash}, ${JSON.stringify(result)}, ${steeredAt}
                )`.pipe(Effect.mapError(asDatabaseError("transaction")));
            // The event, on the `steered` branch only: an `opened` round was not
            // redirected and an event saying it was would be the one claim a later reader
            // cannot check against anything else.
            if (input.how === "steered") {
              yield* appendEvent({
                kind: "plan.round.steered",
                targetId: agent.targetId,
                // The goal agent's own scope: a steer is the one round-related mutation an
                // authenticated agent causes rather than the host, and this column is what
                // puts the item in the goal's conversation as well as under the round.
                callerScope: agent.callerScope,
                intentId: null,
                attemptId: null,
                operation: "steer_planner",
                operationId: input.operationId,
                // The round, because that is what the event is *about*. The goal is in the
                // payload and in the scope.
                subjectId: input.roundId,
                payload: {
                  roundId: input.roundId,
                  goalId: agent.goalId,
                  urgency: input.urgency,
                  messageId: input.messageId,
                },
                recordedAt: steeredAt,
              });
            }
            return { ...result, replayed: false };
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error._tag === "SqlError"
              ? asDatabaseError("transaction")(error)
              : error,
          ),
        );
    },
  );

  /**
   * Ends a goal as its own agent, through the goal agent's credential.
   *
   * The same write {@link endGoal} makes, reached by a different authority: the goal comes
   * from the credential and is not an argument, so an agent cannot end a goal it is not
   * the agent for, and `endedBy` is `goal_agent` by construction rather than by payload —
   * exactly as the browser route's is `operator` by construction.
   *
   * **No `checkGoalAuthority` call, and the omission is deliberate.** That check would
   * refuse an already-ended goal as `stale`, where {@link endGoalWithin}'s own check
   * refuses it as a `conflict` naming what ended it — which is the better answer for an
   * agent that is about to tell an operator what happened. The two refusals cover the same
   * fact and this takes the more informative one; ownership of the goal by this target is
   * checked inside the transaction either way.
   */
  const endGoalAsAgent = Effect.fn("ObservationStore.endGoalAsAgent")(
    function* (
      caller: CallerContext,
      input: {
        readonly operationId: string;
        readonly status: GoalEndStatus;
        readonly reason: string;
      },
    ) {
      const agent = yield* goalCallerOrFail(caller, "end a goal");
      const endedAt = yield* Clock.currentTimeMillis;
      return yield* sql
        .withTransaction(
          endGoalWithin(
            { callerScope: agent.callerScope, targetId: agent.targetId },
            {
              operationId: input.operationId,
              goalId: agent.goalId,
              status: input.status,
              endedBy: "goal_agent",
              reason: input.reason,
            },
            endedAt,
          ),
        )
        .pipe(
          Effect.mapError((error) =>
            error._tag === "SqlError"
              ? asDatabaseError("transaction")(error)
              : error,
          ),
        );
    },
  );

  const selectAttemptsForGoal = SqlSchema.findAll({
    Request: Schema.String,
    Result: AttemptRow,
    execute: (goalId) =>
      sql.unsafe(
        `SELECT ${attemptColumnsQualified} FROM attempts
         INNER JOIN intents ON intents.id = attempts.intent_id
         WHERE intents.goal_id = ?
         ORDER BY attempts.started_at, attempts.id`,
        [goalId],
      ),
  });

  /**
   * Every attempt made under one goal, oldest first, across all of its intents.
   *
   * **A join rather than `attemptsForIntent` in a loop**, for the reason
   * `observationsForGoal` is one: the goal agent asks "what work has been done here" once,
   * and N+1 statements for an answer SQLite can produce in one is the kind of read that is
   * fine until a goal has forty intents.
   *
   * The rows as stored, including `status` as a plain string — `AttemptRow` says why — so a
   * reader that meets an unrecognised status reports it against the row rather than failing
   * the read of every attempt beside it.
   */
  const attemptsForGoal = Effect.fn("ObservationStore.attemptsForGoal")(
    function* (goalId: string) {
      return yield* selectAttemptsForGoal(goalId).pipe(
        Effect.mapError(lift("attempts", goalId)),
      );
    },
  );

  const EventRow = Schema.Struct({
    id: Schema.String,
    sequence: Schema.Int,
    target_id: Schema.String,
    kind: Schema.String,
    payload: Schema.String,
    caller_scope: Schema.NullOr(Schema.String),
    intent_id: Schema.NullOr(Schema.String),
    attempt_id: Schema.NullOr(Schema.String),
    operation: Schema.String,
    operation_id: Schema.NullOr(Schema.String),
    subject_id: Schema.String,
    recorded_at: Schema.Finite,
  });

  const selectEvents = SqlSchema.findAll({
    Request: Schema.Struct({ after: Schema.Int, limit: Schema.Int }),
    Result: EventRow,
    execute: (request) =>
      sql`SELECT id, sequence, target_id, kind, payload, caller_scope, intent_id,
            attempt_id, operation, operation_id, subject_id, recorded_at
          FROM events
          WHERE sequence > ${request.after}
          ORDER BY sequence
          LIMIT ${request.limit}`,
  });

  /**
   * Committed events in ascending sequence order after a cursor.
   *
   * This is the read §8 specifies, and it is here so that what Sprint 02 writes can be
   * proven readable in order — including across a restart. It is **not** the durable
   * consumer §8 describes: there is no stored cursor, no acknowledgement, no PubSub
   * wake-up and no catch-up sweep. Those are Sprint 03, and this is the query they will
   * be built on.
   *
   * `payload` is handed back as decoded JSON rather than a validated shape, because the
   * event schema is ours and grows: a reader tolerates fields it does not declare
   * (`unknownField`) instead of failing on an event a later build wrote.
   */
  const eventsAfter = Effect.fn("ObservationStore.eventsAfter")(function* (
    after = 0,
    limit = 500,
  ) {
    const rows = yield* selectEvents({ after, limit }).pipe(
      Effect.mapError(lift("events", `after:${String(after)}`)),
    );
    return yield* Effect.forEach(rows, (row) =>
      Effect.map(
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
          row.payload,
        ).pipe(
          Effect.mapError(
            (issue) =>
              new StoredRowError({
                table: "events",
                rowId: row.id,
                detail: "payload is not JSON",
                cause: issue,
              }),
          ),
        ),
        (payload): RecordedEvent => ({
          eventId: row.id,
          sequence: row.sequence,
          targetId: row.target_id,
          kind: row.kind,
          payload,
          callerScope: row.caller_scope,
          intentId: row.intent_id,
          attemptId: row.attempt_id,
          operation: row.operation,
          operationId: row.operation_id,
          subjectId: row.subject_id,
          recordedAt: row.recorded_at,
        }),
      ),
    );
  });

  const OutboxRow = Schema.Struct({
    id: Schema.String,
    sequence: Schema.Int,
    target_id: Schema.String,
    request_type: Schema.String,
    payload: Schema.String,
    recovery_policy: Schema.String,
    caused_by_event_id: Schema.String,
    status: Schema.String,
    attempts: Schema.Int,
    lease_owner: Schema.NullOr(Schema.String),
    lease_expires_at: Schema.NullOr(Schema.Finite),
    next_attempt_at: Schema.NullOr(Schema.Finite),
    last_error: Schema.NullOr(Schema.String),
    enqueued_at: Schema.Finite,
    completed_at: Schema.NullOr(Schema.Finite),
  });

  const outboxColumns = Object.keys(OutboxRow.fields).join(", ");

  const selectPending = SqlSchema.findAll({
    Request: Schema.Void,
    Result: OutboxRow,
    execute: () =>
      sql.unsafe(
        `SELECT ${outboxColumns} FROM outbox WHERE status = 'pending'
         ORDER BY sequence`,
        [],
      ),
  });

  /**
   * Undispatched side-effect requests, oldest first.
   *
   * A read, and only a read: nothing here claims a row, takes a lease or marks one
   * in flight. This sprint's claim is that a committed obligation survives a crash, and
   * this is how that is checked. Dispatching is Sprint 03.
   */
  const pendingRequests = Effect.fn("ObservationStore.pendingRequests")(
    function* () {
      const rows = yield* selectPending().pipe(
        Effect.mapError(lift("outbox", "status:pending")),
      );
      return yield* Effect.forEach(rows, (row) =>
        Effect.map(
          Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
            row.payload,
          ).pipe(
            Effect.mapError(
              (issue) =>
                new StoredRowError({
                  table: "outbox",
                  rowId: row.id,
                  detail: "payload is not JSON",
                  cause: issue,
                }),
            ),
          ),
          (payload): OutboxEntry => ({
            outboxId: row.id,
            sequence: row.sequence,
            targetId: row.target_id,
            requestType: row.request_type,
            payload,
            recoveryPolicy: row.recovery_policy,
            causedByEventId: row.caused_by_event_id,
            status: row.status,
            attempts: row.attempts,
            leaseOwner: row.lease_owner,
            leaseExpiresAt: row.lease_expires_at,
            nextAttemptAt: row.next_attempt_at,
            lastError: row.last_error,
            enqueuedAt: row.enqueued_at,
            completedAt: row.completed_at,
          }),
        ),
      );
    },
  );

  const selectAnchors = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({
      observation_id: Schema.String,
      position: Schema.Int,
    }),
    execute: (intentId) =>
      sql`SELECT observation_id, position FROM intent_anchors
          WHERE intent_id = ${intentId} ORDER BY position`,
  });

  /** The observations one intent is anchored to, in the order the caller gave. */
  const anchorsForIntent = Effect.fn("ObservationStore.anchorsForIntent")(
    function* (intentId: string) {
      const rows = yield* selectAnchors(intentId).pipe(
        Effect.mapError(lift("intent_anchors", intentId)),
      );
      return rows.map((row) => row.observation_id);
    },
  );

  const AssetRow = Schema.Struct({
    id: Schema.String,
    target_id: Schema.String,
    kind: Schema.String,
    identity: Schema.String,
    host: Schema.String,
    port: Schema.Int,
    scheme: Schema.NullOr(Schema.String),
    method: Schema.NullOr(Schema.String),
    path: Schema.NullOr(Schema.String),
    first_seen_at: Schema.Finite,
  });
  const assetColumns = Object.keys(AssetRow.fields).join(", ");

  const selectAssets = SqlSchema.findAll({
    Request: Schema.Void,
    Result: AssetRow,
    execute: () =>
      sql.unsafe(
        `SELECT ${assetColumns} FROM assets ORDER BY first_seen_at, identity`,
        [],
      ),
  });

  /** Every asset recorded in this target's file, oldest first. */
  const assets = Effect.fn("ObservationStore.assets")(function* () {
    return yield* selectAssets().pipe(Effect.mapError(lift("assets", "all")));
  });

  const DiscoveryRow = Schema.Struct({
    asset_id: Schema.String,
    operation_id: Schema.String,
    caller_scope: Schema.String,
    intent_id: Schema.String,
    attempt_id: Schema.String,
    discovered_as: Schema.String,
    note: Schema.String,
    discovered_at: Schema.Finite,
  });
  const discoveryColumns = Object.keys(DiscoveryRow.fields).join(", ");

  const selectDiscoveries = SqlSchema.findAll({
    Request: Schema.String,
    Result: DiscoveryRow,
    execute: (assetId) =>
      sql.unsafe(
        `SELECT ${discoveryColumns} FROM asset_discoveries WHERE asset_id = ?
         ORDER BY discovered_at, operation_id`,
        [assetId],
      ),
  });

  /** Every discovery of one asset, in the order they were recorded. */
  const discoveriesOfAsset = Effect.fn("ObservationStore.discoveriesOfAsset")(
    function* (assetId: string) {
      return yield* selectDiscoveries(assetId).pipe(
        Effect.mapError(lift("asset_discoveries", assetId)),
      );
    },
  );

  const ImportRow = Schema.Struct({
    asset_id: Schema.String,
    operation_id: Schema.String,
    caller_scope: Schema.String,
    source_url: Schema.String,
    imported_as: Schema.String,
    note: Schema.String,
    imported_at: Schema.Finite,
  });
  const importColumns = Object.keys(ImportRow.fields).join(", ");

  const selectImports = SqlSchema.findAll({
    Request: Schema.String,
    Result: ImportRow,
    execute: (assetId) =>
      sql.unsafe(
        `SELECT ${importColumns} FROM asset_imports WHERE asset_id = ?
         ORDER BY imported_at, operation_id`,
        [assetId],
      ),
  });

  /**
   * Every import of one asset, in the order they were recorded.
   *
   * {@link discoveriesOfAsset}'s sibling, and the second half of "how did this asset come
   * to be known" — which D14 accepts as a read over two tables rather than one, and
   * deliberately does not paper over with a union view until a caller wants it. Served by
   * the primary key, which leads with `asset_id`.
   */
  const importsOfAsset = Effect.fn("ObservationStore.importsOfAsset")(
    function* (assetId: string) {
      return yield* selectImports(assetId).pipe(
        Effect.mapError(lift("asset_imports", assetId)),
      );
    },
  );

  const AssetWithProvenanceRow = Schema.Struct({
    ...AssetRow.fields,
    /** How many separate operations have recorded this asset. */
    discoveries: Schema.Int,
    /**
     * The attempt that found it first, and the intent that attempt was working.
     *
     * Null for an asset no attempt found, which is a real and intended case rather than a
     * schema shortfall: the scope importer records its assets through `importAsset`, whose
     * provenance row is in `asset_imports` and whose authority is the operator's (D14).
     * `recordAsset` writes a discovery in the same transaction as the asset, so anything a
     * worker found has at least one.
     */
    first_attempt_id: Schema.NullOr(Schema.String),
    first_intent_id: Schema.NullOr(Schema.String),
    /** When it was most recently seen, which is not when it was first seen. */
    last_discovered_at: Schema.NullOr(Schema.Finite),
  });

  /**
   * Every asset with its discovery aggregate, in one statement.
   *
   * The aggregate is here rather than assembled by the caller because the surfaces that
   * want it — the browser's estate list and the worker's `list_assets` — both want it per
   * row, and reading it per asset would be one statement per row. Three correlated
   * subqueries over `asset_discoveries`, which is indexed by its own primary key
   * `(asset_id, operation_id)`.
   *
   * **No pagination, deliberately, and this is the design's live open question.** Its
   * Deferred section leaves per-entry aggregates and pagination to be decided together,
   * and this read is the agent-side half of that question. Returning every row matches
   * `assets()` and `list_observations`, and it is the choice that cannot be wrong about
   * *which* rows an operator sees; what it can be is slow, on a target with a very large
   * estate. That is a real limit and it is recorded rather than guessed at.
   */
  /**
   * `assetColumns`, qualified with the table.
   *
   * The statement below has correlated subqueries naming `asset_discoveries` columns, so
   * every column from `assets` is qualified rather than bare. Derived from the same
   * `Object.keys` list as `assetColumns`, so the `SELECT` cannot drift from the decoder.
   */
  const qualifiedAssetColumns = Object.keys(AssetRow.fields)
    .map((column) => `assets.${column}`)
    .join(", ");

  const selectAssetsWithProvenance = SqlSchema.findAll({
    Request: Schema.Void,
    Result: AssetWithProvenanceRow,
    execute: () =>
      sql.unsafe(
        `SELECT ${qualifiedAssetColumns},
           (SELECT COUNT(*) FROM asset_discoveries
             WHERE asset_discoveries.asset_id = assets.id) AS discoveries,
           (SELECT attempt_id FROM asset_discoveries
             WHERE asset_discoveries.asset_id = assets.id
             ORDER BY discovered_at, operation_id LIMIT 1) AS first_attempt_id,
           (SELECT intent_id FROM asset_discoveries
             WHERE asset_discoveries.asset_id = assets.id
             ORDER BY discovered_at, operation_id LIMIT 1) AS first_intent_id,
           (SELECT MAX(discovered_at) FROM asset_discoveries
             WHERE asset_discoveries.asset_id = assets.id) AS last_discovered_at
         FROM assets
         ORDER BY assets.first_seen_at, assets.identity`,
        [],
      ),
  });

  /**
   * The whole scope of one target: its entries and both label sets.
   *
   * What the prompt block is rendered from, and what the Scope tab shows. The labels come
   * with it because from the agent's side there is no difference between "excluded because
   * you typed it" and "excluded because you clicked it" — D6 assembles both lists from
   * all three sources.
   */
  const targetScope = Effect.fn("ObservationStore.targetScope")(function* (
    targetId: string,
  ) {
    const scope = yield* readScope(targetId);
    return {
      entries: scope.entries,
      hostLabels: [...scope.hostLabels.values()],
      assetLabels: scope.labelledAssets,
    };
  });

  /**
   * Every asset with its effective scope state.
   *
   * **This is the one read D5 asks for, and no caller should assemble it.** An asset's
   * state is its own label if present, else its host's label if present, else the
   * derivation over the entries — and a caller that did that join itself would be a second
   * implementation of the ladder.
   *
   * The host label is looked up by the asset's `host` column, which is why that column is
   * normalised by the same function an entry value and a label key go through. This is the
   * line where "a host label covers an endpoint recorded afterwards" is actually true: the
   * endpoint is a different row with no label of its own, and it finds the host's.
   */
  const assetsWithScope = Effect.fn("ObservationStore.assetsWithScope")(
    function* (targetId: string) {
      const rows = yield* selectAssetsWithProvenance().pipe(
        Effect.mapError(lift("assets", "all")),
      );
      const scope = yield* readScope(targetId);
      return rows
        .filter((row) => row.target_id === targetId)
        .map((row) => ({
          asset: row,
          scope: scopeStateOf({
            entries: scope.entries,
            hostLabel: scope.hostLabels.get(row.host),
            assetLabel: scope.assetLabels.get(row.id),
            subject: { host: row.host },
          }),
        }));
    },
  );

  /**
   * One subject's effective state, for a host or an address with no asset behind it.
   *
   * The same ladder minus the asset layer, which is not an omission: a bare host is not an
   * asset row, so there is no asset label for it to have. Used by the scope query tool and
   * by the view when it describes a host group rather than one of its rows.
   */
  const scopeStateOfHost = Effect.fn("ObservationStore.scopeStateOfHost")(
    function* (targetId: string, rawHost: string) {
      const host = normaliseHost(rawHost);
      const scope = yield* readScope(targetId);
      return scopeStateOf({
        entries: scope.entries,
        hostLabel: scope.hostLabels.get(host),
        subject: { host },
      });
    },
  );

  /**
   * Adds one scope entry, or refuses it.
   *
   * **Two writers reach this and only two**: the operator typing in the Scope tab, and the
   * scope importer at target creation. Not a worker, not a planner, not the goal agent,
   * and not promotion — promotion writes a label instead. The caller is a
   * {@link HostContext}, so there is no credential path that arrives here at all.
   *
   * Three outcomes, and the second is the one worth knowing about:
   *
   * - **Normalisation refuses it.** `normaliseScopeEntry` decides, and its sentence is
   *   passed through unedited, because it names the remedy.
   * - **A direct contradiction refuses it.** An entry whose kind and value already exist
   *   under the opposite effect is rejected, naming the existing row, so the operator
   *   removes or edits it deliberately. The matcher would cope — out wins — but the screen
   *   cannot show the pair coherently and an operator who authored both did not mean to.
   * - **It already exists, and that is a no-op.** The unique index makes authoring
   *   idempotent, and the result says `created: false` rather than refusing: pressing Add
   *   twice is not an error, and a duplicate row would be a second entry the matcher
   *   evaluates.
   */
  const addScopeEntry = Effect.fn("ObservationStore.addScopeEntry")(function* (
    caller: HostContext,
    input: {
      readonly effect: ScopeEffect;
      readonly kind: ScopeKind;
      readonly value: string;
      readonly source: ScopeEntrySource;
      readonly note?: string | null;
    },
  ) {
    const normalised = normaliseScopeEntry({
      kind: input.kind,
      value: input.value,
    });
    if (isScopeValueRefusal(normalised)) {
      return yield* new MutationError({
        reason: "invalid",
        detail: normalised.detail,
      });
    }
    const recordedAt = yield* Clock.currentTimeMillis;
    const opposite: ScopeEffect = input.effect === "in" ? "out" : "in";

    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const clash = yield* findOpposingScopeEntry({
            targetId: caller.targetId,
            effect: opposite,
            kind: input.kind,
            value: normalised,
          }).pipe(Effect.mapError(lift("scope_entries", normalised)));
          if (Option.isSome(clash)) {
            return yield* new MutationError({
              reason: "conflict",
              detail: `'${normalised}' is already ${opposite === "out" ? "an out-of-scope" : "an in-scope"} ${input.kind} entry (${clash.value.id}); an entry cannot be in and out at once. Remove that one first, or label the host by hand from the Estate view to carve it out without changing the list.`,
            });
          }

          const existing = yield* findOpposingScopeEntry({
            targetId: caller.targetId,
            effect: input.effect,
            kind: input.kind,
            value: normalised,
          }).pipe(Effect.mapError(lift("scope_entries", normalised)));
          if (Option.isSome(existing)) {
            // Idempotent, not refused. Nothing is written and nothing changed.
            const row = yield* findScopeEntryById({
              targetId: caller.targetId,
              entryId: existing.value.id,
            }).pipe(Effect.mapError(lift("scope_entries", existing.value.id)));
            if (Option.isNone(row)) {
              return yield* new DatabaseError({
                operation: "transaction",
                reason: `scope entry ${existing.value.id} was found and could not be read back`,
                cause: existing.value,
              });
            }
            return { entry: scopeEntryOf(row.value), created: false };
          }

          const entryId = identifier.newScopeEntryId();
          yield* sql`INSERT INTO scope_entries (
              id, target_id, effect, kind, value, source, note, created_at
            ) VALUES (
              ${entryId}, ${caller.targetId}, ${input.effect}, ${input.kind},
              ${normalised}, ${input.source}, ${input.note ?? null}, ${recordedAt}
            )`.pipe(Effect.mapError(asDatabaseError("transaction")));

          yield* appendEvent({
            kind: "scope.entry.added",
            targetId: caller.targetId,
            callerScope: caller.callerScope,
            intentId: null,
            attemptId: null,
            operation: "add_scope_entry",
            operationId: null,
            subjectId: entryId,
            payload: {
              entryId,
              effect: input.effect,
              kind: input.kind,
              value: normalised,
              source: input.source,
              note: input.note ?? null,
            },
            recordedAt,
          });

          return {
            entry: {
              entryId,
              targetId: caller.targetId,
              effect: input.effect,
              kind: input.kind,
              value: normalised,
              source: input.source,
              note: input.note ?? null,
              createdAt: recordedAt,
            } satisfies ScopeEntry,
            created: true,
          };
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          error._tag === "SqlError"
            ? asDatabaseError("transaction")(error)
            : error,
        ),
      );
  });

  /**
   * Removes one scope entry.
   *
   * A real `DELETE`, not a soft one. The entries are the operator's current statement of
   * the estate rather than a record of what they once thought, and the event log holds the
   * history — the same split both label tables use. Removing an entry an operator never
   * had is refused rather than silently succeeding, because a button that appears to work
   * and does nothing is one of this design's named anti-goals.
   */
  const removeScopeEntry = Effect.fn("ObservationStore.removeScopeEntry")(
    function* (caller: HostContext, entryId: string) {
      const recordedAt = yield* Clock.currentTimeMillis;
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const row = yield* findScopeEntryById({
              targetId: caller.targetId,
              entryId,
            }).pipe(Effect.mapError(lift("scope_entries", entryId)));
            if (Option.isNone(row)) {
              return yield* new MutationError({
                reason: "invalid",
                detail: `no scope entry '${entryId}' on target ${caller.targetId}; nothing was removed`,
                absent: true,
              });
            }
            const entry = scopeEntryOf(row.value);
            yield* sql`DELETE FROM scope_entries
                WHERE target_id = ${caller.targetId} AND id = ${entryId}`.pipe(
              Effect.mapError(asDatabaseError("transaction")),
            );
            yield* appendEvent({
              kind: "scope.entry.removed",
              targetId: caller.targetId,
              callerScope: caller.callerScope,
              intentId: null,
              attemptId: null,
              operation: "remove_scope_entry",
              operationId: null,
              subjectId: entryId,
              payload: {
                entryId,
                effect: entry.effect,
                kind: entry.kind,
                value: entry.value,
              },
              recordedAt,
            });
            return entry;
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error._tag === "SqlError"
              ? asDatabaseError("transaction")(error)
              : error,
          ),
        );
    },
  );

  /**
   * Sets or replaces the label on one host.
   *
   * An upsert, because there is exactly one current answer per host and the operator's
   * later decision replaces the earlier one. The history of what it was is in the event
   * log, which is the split `0022`'s own commentary argues for.
   *
   * The host is normalised here rather than by the caller, so a label is always keyed by a
   * string the matcher produces. A label keyed by `App.Acme.Com:443` would be a label that
   * never applies to anything, and it would look set.
   */
  const setHostScopeLabel = Effect.fn("ObservationStore.setHostScopeLabel")(
    function* (
      caller: HostContext,
      input: {
        readonly host: string;
        readonly state: ScopeLabelState;
        readonly reason?: string | null;
      },
    ) {
      const host = normaliseHost(input.host);
      if (host === "") {
        return yield* new MutationError({
          reason: "invalid",
          detail: `'${input.host}' does not name a host, so no label was set`,
        });
      }
      const recordedAt = yield* Clock.currentTimeMillis;
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO host_scope_labels (
                target_id, host, state, reason, set_by, set_at
              ) VALUES (
                ${caller.targetId}, ${host}, ${input.state},
                ${input.reason ?? null}, ${caller.callerScope}, ${recordedAt}
              )
              ON CONFLICT(target_id, host) DO UPDATE SET
                state = excluded.state,
                reason = excluded.reason,
                set_by = excluded.set_by,
                set_at = excluded.set_at`.pipe(
              Effect.mapError(asDatabaseError("transaction")),
            );
            yield* appendEvent({
              kind: "scope.host.labelled",
              targetId: caller.targetId,
              callerScope: caller.callerScope,
              intentId: null,
              attemptId: null,
              operation: "set_host_scope_label",
              operationId: null,
              subjectId: host,
              payload: {
                host,
                state: input.state,
                reason: input.reason ?? null,
              },
              recordedAt,
            });
            return {
              targetId: caller.targetId,
              host,
              state: input.state,
              reason: input.reason ?? null,
              setBy: caller.callerScope,
              setAt: recordedAt,
            } satisfies HostScopeLabel;
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error._tag === "SqlError"
              ? asDatabaseError("transaction")(error)
              : error,
          ),
        );
    },
  );

  /**
   * Clears the label on one host, so the entries decide it again.
   *
   * **A delete rather than a stored `cleared` state**, which the design leaves to the
   * builder. Either satisfies D5 because the event log holds the history regardless, and a
   * delete is chosen because the two label tables hold *current state*: a `cleared` row
   * would be a third value for a two-valued column, and every reader would have to know
   * that it means "ask the entries" rather than "out".
   */
  const clearHostScopeLabel = Effect.fn("ObservationStore.clearHostScopeLabel")(
    function* (caller: HostContext, rawHost: string) {
      const host = normaliseHost(rawHost);
      const recordedAt = yield* Clock.currentTimeMillis;
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const existing = yield* selectHostLabels(caller.targetId).pipe(
              Effect.mapError(lift("host_scope_labels", host)),
            );
            if (!existing.some((row) => row.host === host)) {
              return yield* new MutationError({
                reason: "invalid",
                detail: `no hand label on '${host}' for target ${caller.targetId}; nothing was cleared`,
                absent: true,
              });
            }
            yield* sql`DELETE FROM host_scope_labels
                WHERE target_id = ${caller.targetId} AND host = ${host}`.pipe(
              Effect.mapError(asDatabaseError("transaction")),
            );
            yield* appendEvent({
              kind: "scope.host.label.cleared",
              targetId: caller.targetId,
              callerScope: caller.callerScope,
              intentId: null,
              attemptId: null,
              operation: "clear_host_scope_label",
              operationId: null,
              subjectId: host,
              payload: { host },
              recordedAt,
            });
            return { host };
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error._tag === "SqlError"
              ? asDatabaseError("transaction")(error)
              : error,
          ),
        );
    },
  );

  /**
   * Sets or replaces the label on one asset.
   *
   * Refuses an asset that is not this target's, in the instructive register the anchoring
   * refusal uses: the foreign key would catch an id that is nothing at all, but it cannot
   * catch another engagement's asset id, and labelling one of those would be a decision
   * recorded against the wrong client.
   */
  const setAssetScopeLabel = Effect.fn("ObservationStore.setAssetScopeLabel")(
    function* (
      caller: HostContext,
      input: {
        readonly assetId: string;
        readonly state: ScopeLabelState;
        readonly reason?: string | null;
      },
    ) {
      const recordedAt = yield* Clock.currentTimeMillis;
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const asset = yield* findAssetForLabel(input.assetId).pipe(
              Effect.mapError(lift("assets", input.assetId)),
            );
            if (
              Option.isNone(asset) ||
              asset.value.target_id !== caller.targetId
            ) {
              return yield* new MutationError({
                reason: "invalid",
                detail: `asset '${input.assetId}' is not an asset of target ${caller.targetId}, so no label was set`,
                absent: true,
              });
            }
            yield* sql`INSERT INTO asset_scope_labels (
                asset_id, state, reason, set_by, set_at
              ) VALUES (
                ${input.assetId}, ${input.state}, ${input.reason ?? null},
                ${caller.callerScope}, ${recordedAt}
              )
              ON CONFLICT(asset_id) DO UPDATE SET
                state = excluded.state,
                reason = excluded.reason,
                set_by = excluded.set_by,
                set_at = excluded.set_at`.pipe(
              Effect.mapError(asDatabaseError("transaction")),
            );
            yield* appendEvent({
              kind: "scope.asset.labelled",
              targetId: caller.targetId,
              callerScope: caller.callerScope,
              intentId: null,
              attemptId: null,
              operation: "set_asset_scope_label",
              operationId: null,
              subjectId: input.assetId,
              payload: {
                assetId: input.assetId,
                identity: asset.value.identity,
                state: input.state,
                reason: input.reason ?? null,
              },
              recordedAt,
            });
            return {
              assetId: input.assetId,
              state: input.state,
              reason: input.reason ?? null,
              setBy: caller.callerScope,
              setAt: recordedAt,
            } satisfies AssetScopeLabel;
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error._tag === "SqlError"
              ? asDatabaseError("transaction")(error)
              : error,
          ),
        );
    },
  );

  /** Clears the label on one asset, so its host's label or the entries decide it again. */
  const clearAssetScopeLabel = Effect.fn(
    "ObservationStore.clearAssetScopeLabel",
  )(function* (caller: HostContext, assetId: string) {
    const recordedAt = yield* Clock.currentTimeMillis;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const asset = yield* findAssetForLabel(assetId).pipe(
            Effect.mapError(lift("assets", assetId)),
          );
          if (
            Option.isNone(asset) ||
            asset.value.target_id !== caller.targetId
          ) {
            return yield* new MutationError({
              reason: "invalid",
              detail: `asset '${assetId}' is not an asset of target ${caller.targetId}; nothing was cleared`,
              absent: true,
            });
          }
          const labels = yield* selectAssetLabels(caller.targetId).pipe(
            Effect.mapError(lift("asset_scope_labels", assetId)),
          );
          if (!labels.some((row) => row.asset_id === assetId)) {
            return yield* new MutationError({
              reason: "invalid",
              detail: `no hand label on asset '${assetId}'; nothing was cleared`,
              absent: true,
            });
          }
          yield* sql`DELETE FROM asset_scope_labels
              WHERE asset_id = ${assetId}`.pipe(
            Effect.mapError(asDatabaseError("transaction")),
          );
          yield* appendEvent({
            kind: "scope.asset.label.cleared",
            targetId: caller.targetId,
            callerScope: caller.callerScope,
            intentId: null,
            attemptId: null,
            operation: "clear_asset_scope_label",
            operationId: null,
            subjectId: assetId,
            payload: { assetId },
            recordedAt,
          });
          return { assetId };
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          error._tag === "SqlError"
            ? asDatabaseError("transaction")(error)
            : error,
        ),
      );
  });

  const CountsRow = Schema.Struct({
    goals: Schema.Int,
    intents: Schema.Int,
    attempts: Schema.Int,
    unsettled_attempts: Schema.Int,
    observations: Schema.Int,
    assets: Schema.Int,
    events: Schema.Int,
  });

  /**
   * One statement, seven scalar subqueries.
   *
   * It is one round trip rather than seven because every number is read for the same
   * screen at the same moment, and seven statements could not see the same snapshot of
   * the file without a transaction — which would take SQLite's single write lock for a
   * read nobody is writing against. `COUNT(*)` on a table with no `WHERE` is answered
   * from the table itself; the only predicate here is the unsettled one, which has
   * `attempts_status_idx` behind it.
   */
  const selectCounts = SqlSchema.findOne({
    Request: Schema.Void,
    Result: CountsRow,
    execute: () =>
      sql`SELECT
            (SELECT COUNT(*) FROM goals) AS goals,
            (SELECT COUNT(*) FROM intents) AS intents,
            (SELECT COUNT(*) FROM attempts) AS attempts,
            (SELECT COUNT(*) FROM attempts
              WHERE status IN ('running', 'uncertain')) AS unsettled_attempts,
            (SELECT COUNT(*) FROM observations) AS observations,
            (SELECT COUNT(*) FROM assets) AS assets,
            (SELECT COUNT(*) FROM events) AS events`,
  });

  /**
   * How much this target's file holds, for the header of its own screen.
   *
   * Read-only and transaction-free, which is what makes it safe to call on every open:
   * it takes no write lock, so it cannot be the thing that blocks a worker mid-write on
   * the same file. The counts are a snapshot and are not claimed to be anything else —
   * by the time they reach a browser a running attempt may have added to them.
   */
  const counts = Effect.fn("ObservationStore.counts")(function* () {
    const row = yield* selectCounts().pipe(
      Effect.mapError(lift("sqlite_schema", "counts")),
    );
    return {
      goals: row.goals,
      intents: row.intents,
      attempts: row.attempts,
      unsettledAttempts: row.unsettled_attempts,
      observations: row.observations,
      assets: row.assets,
      events: row.events,
    } satisfies StoredCounts;
  });

  return ObservationStore.of({
    counts,
    recentRecoveries,
    seedAttempt,
    recordAsset,
    importAsset,
    addIntent,
    addRoundIntent,
    openGoal,
    endGoal,
    goals,
    loadGoal,
    claimIntent,
    releaseIntent,
    intentsForGoal,
    intent,
    abandonIntent,
    releaseOrphanedClaims,
    eventsAfter,
    pendingRequests,
    anchorsForIntent,
    assets,
    assetsWithScope,
    targetScope,
    scopeStateOfHost,
    addScopeEntry,
    removeScopeEntry,
    setHostScopeLabel,
    clearHostScopeLabel,
    setAssetScopeLabel,
    clearAssetScopeLabel,
    discoveriesOfAsset,
    importsOfAsset,
    settleAttempt,
    bindSessionToAttempt,
    recordObservation,
    recordRecovery,
    openReplacementAttempt,
    observationsForIntent,
    dimensionLinksForIntent,
    dimensionsForIntent,
    dimensionSchedulesForIntent,
    observationsForGoal,
    dimensionLinksForGoal,
    dimensionsForGoal,
    dimensionSchedulesForGoal,
    currentSequence,
    currentEventSequence,
    loadIntent,
    loadAttempt,
    unsettledAttempts,
    recoveriesForAttempt,
    plannerLineage,
    recordPlannerLineage,
    callerAuthority,
    openRound,
    loadRound,
    roundsForGoal,
    roundsLeftRunning,
    bindSessionToRound,
    settleRound,
    supersedeRound,
    recordRoundDisposition,
    recordRoundSteer,
    steerReceipt,
    goalSession,
    recordGoalSession,
    endGoalAsAgent,
    attemptsForGoal,
  });
});

/**
 * The status and disposition one harness answer produces for an attempt in a given
 * state, with no database access.
 *
 * Pulled out as a pure function because it is the part worth reading on its own: every
 * no-regression and fencing rule the store enforces is visible here in one place, and a
 * test can enumerate the state space without a connection.
 */
export const decideRecovery = (
  current: AttemptExecutionStatus,
  proposed: AttemptExecutionStatus,
): {
  readonly status: AttemptExecutionStatus;
  readonly disposition: RecoveryDisposition;
  readonly revokeAuthority: boolean;
} => {
  if (isFinalAttemptStatus(current)) {
    return {
      status: current,
      disposition: "already_final",
      revokeAuthority: false,
    };
  }
  if (current === "uncertain") {
    if (proposed === "running") {
      return {
        status: "uncertain",
        disposition: "unresumable",
        revokeAuthority: false,
      };
    }
    if (proposed === "uncertain") {
      return {
        status: "uncertain",
        disposition: "uncertain",
        revokeAuthority: false,
      };
    }
    return { status: proposed, disposition: "refined", revokeAuthority: false };
  }
  // current === "running"
  if (proposed === "running") {
    return {
      status: "running",
      disposition: "still_running",
      revokeAuthority: false,
    };
  }
  return {
    status: proposed,
    disposition: proposed === "uncertain" ? "uncertain" : "settled",
    revokeAuthority: true,
  };
};

export class ObservationStore extends Context.Service<
  ObservationStore,
  {
    /** How much this file holds. One read-only statement, no transaction. */
    readonly counts: () => Effect.Effect<
      StoredCounts,
      DatabaseError | StoredRowError
    >;
    readonly seedAttempt: (
      input: SeedInput,
    ) => Effect.Effect<AttemptAuthority, DatabaseError | StoredRowError>;
    readonly recordAsset: (
      caller: CallerContext,
      input: RecordAssetInput,
    ) => Effect.Effect<
      RecordAssetResult,
      MutationError | DatabaseError | StoredRowError
    >;
    /**
     * Records one asset the scope importer read off a program page, under the operator's
     * own authority and with no intent or attempt in sight (D14).
     *
     * Same asset identity as {@link recordAsset} and a provenance row in `asset_imports`
     * instead of `asset_discoveries`. `conflict` is the reused `operationId`, `invalid` is
     * an identity refusal; see the implementation for why it queues no enrichment.
     */
    readonly importAsset: (
      caller: HostContext,
      input: ImportAssetInput,
    ) => Effect.Effect<
      ImportAssetResult,
      MutationError | DatabaseError | StoredRowError
    >;
    readonly addIntent: (
      host: HostContext,
      input: AddIntentInput,
    ) => Effect.Effect<
      AddIntentResult,
      MutationError | DatabaseError | StoredRowError
    >;
    /**
     * The same write under a planner round's own authority, with the three refusals only
     * a round can earn. Wraps {@link addIntent}'s transaction body; see the
     * implementation.
     */
    readonly addRoundIntent: (
      caller: CallerContext,
      input: AddIntentInput,
    ) => Effect.Effect<
      AddIntentResult & {
        /** The round's budget, from its row. */
        readonly budget: number;
        /** How many intents it has now added, this one included. */
        readonly intentsAdded: number;
      },
      MutationError | RoundIntentRefused | DatabaseError | StoredRowError
    >;
    /**
     * Creates a goal, receipt-keyed like {@link addIntent}. See the implementation for
     * the refusals.
     */
    readonly openGoal: (
      host: HostContext,
      input: OpenGoalInput,
    ) => Effect.Effect<
      OpenGoalResult,
      MutationError | DatabaseError | StoredRowError
    >;
    /**
     * Ends a goal once, recording who and why. Records state only: it interrupts nothing.
     */
    readonly endGoal: (
      host: HostContext,
      input: EndGoalInput,
    ) => Effect.Effect<
      EndGoalResult,
      MutationError | DatabaseError | StoredRowError
    >;
    /** Every goal in this file with its counts, newest first. Read-only. */
    readonly goals: () => Effect.Effect<
      readonly StoredGoal[],
      DatabaseError | StoredRowError
    >;
    readonly loadGoal: (
      goalId: string,
    ) => Effect.Effect<StoredGoal | undefined, DatabaseError | StoredRowError>;
    /**
     * Takes an open intent for one attempt in a single statement, or refuses naming why.
     * The refusal names the attempt already holding it. See the implementation.
     */
    readonly claimIntent: (
      host: HostContext,
      intentId: string,
      attemptId: string,
    ) => Effect.Effect<
      ClaimResult,
      ClaimRefused | DatabaseError | StoredRowError
    >;
    /**
     * Gives a claimed intent back for a run that never settled an attempt. `heldBy`
     * restricts it to a claim that attempt still holds.
     */
    readonly releaseIntent: (
      intentId: string,
      settledStatus: string,
      heldBy?: string,
    ) => Effect.Effect<void, DatabaseError | StoredRowError>;
    /** Every intent under a goal, oldest first, with anchors and attempt counts. Read-only. */
    readonly intentsForGoal: (
      goalId: string,
    ) => Effect.Effect<readonly StoredIntent[], DatabaseError | StoredRowError>;
    /** One intent by id, or `undefined`. */
    readonly intent: (
      intentId: string,
    ) => Effect.Effect<
      StoredIntent | undefined,
      DatabaseError | StoredRowError
    >;
    /**
     * Drops an open intent once, as the operator, recording why. Refuses a claimed or
     * answered one.
     */
    readonly abandonIntent: (
      host: HostContext,
      input: AbandonIntentInput,
    ) => Effect.Effect<
      AbandonIntentResult,
      MutationError | DatabaseError | StoredRowError
    >;
    /**
     * Startup only: gives back claims held by an attempt that does not exist or is not
     * running, as `open`, with an `intent.released` event each. See the implementation for
     * why it may not run while starts are in flight.
     */
    readonly releaseOrphanedClaims: () => Effect.Effect<
      readonly ReleasedClaim[],
      DatabaseError | StoredRowError
    >;
    readonly eventsAfter: (
      after?: number,
      limit?: number,
    ) => Effect.Effect<
      readonly RecordedEvent[],
      DatabaseError | StoredRowError
    >;
    readonly pendingRequests: () => Effect.Effect<
      readonly OutboxEntry[],
      DatabaseError | StoredRowError
    >;
    readonly anchorsForIntent: (
      intentId: string,
    ) => Effect.Effect<readonly string[], DatabaseError | StoredRowError>;
    readonly assets: () => Effect.Effect<
      readonly StoredAsset[],
      DatabaseError | StoredRowError
    >;
    /**
     * Every asset with its effective scope state: the D5 ladder, in one read.
     *
     * The only read that answers "is this in scope", and no caller should assemble the
     * ladder from the parts. A second implementation of it is the anti-goal about two
     * code paths that can disagree.
     */
    readonly assetsWithScope: (targetId: string) => Effect.Effect<
      readonly {
        readonly asset: StoredAssetWithProvenance;
        readonly scope: ScopeState;
      }[],
      DatabaseError | StoredRowError
    >;
    /** One target's entries and both label sets, for the prompt block and the view. */
    readonly targetScope: (targetId: string) => Effect.Effect<
      {
        readonly entries: readonly ScopeEntry[];
        readonly hostLabels: readonly HostScopeLabel[];
        /**
         * Each asset label with the identity and host of the asset it sits on.
         *
         * The prompt block names a labelled asset by its identity, and the join that
         * bounds this read to one target already carries both, so neither needs a second
         * read and neither can disagree with the row.
         */
        readonly assetLabels: readonly {
          readonly label: AssetScopeLabel;
          readonly identity: string;
          readonly host: string;
        }[];
      },
      DatabaseError | StoredRowError
    >;
    /** One host's or address's effective state, where there is no asset row for it. */
    readonly scopeStateOfHost: (
      targetId: string,
      host: string,
    ) => Effect.Effect<ScopeState, DatabaseError | StoredRowError>;
    /**
     * Adds one entry, idempotently, or refuses it.
     *
     * `invalid` is a normalisation refusal and `conflict` is D2's direct contradiction.
     * An entry that already exists returns `created: false` and writes nothing.
     */
    readonly addScopeEntry: (
      caller: HostContext,
      input: {
        readonly effect: ScopeEffect;
        readonly kind: ScopeKind;
        readonly value: string;
        readonly source: ScopeEntrySource;
        readonly note?: string | null;
      },
    ) => Effect.Effect<
      { readonly entry: ScopeEntry; readonly created: boolean },
      MutationError | DatabaseError | StoredRowError
    >;
    readonly removeScopeEntry: (
      caller: HostContext,
      entryId: string,
    ) => Effect.Effect<
      ScopeEntry,
      MutationError | DatabaseError | StoredRowError
    >;
    /** Sets or replaces one host's label. Covers every asset on it, now and later. */
    readonly setHostScopeLabel: (
      caller: HostContext,
      input: {
        readonly host: string;
        readonly state: ScopeLabelState;
        readonly reason?: string | null;
      },
    ) => Effect.Effect<
      HostScopeLabel,
      MutationError | DatabaseError | StoredRowError
    >;
    readonly clearHostScopeLabel: (
      caller: HostContext,
      host: string,
    ) => Effect.Effect<
      { readonly host: string },
      MutationError | DatabaseError | StoredRowError
    >;
    /** Sets or replaces one asset's label, which beats its host's. */
    readonly setAssetScopeLabel: (
      caller: HostContext,
      input: {
        readonly assetId: string;
        readonly state: ScopeLabelState;
        readonly reason?: string | null;
      },
    ) => Effect.Effect<
      AssetScopeLabel,
      MutationError | DatabaseError | StoredRowError
    >;
    readonly clearAssetScopeLabel: (
      caller: HostContext,
      assetId: string,
    ) => Effect.Effect<
      { readonly assetId: string },
      MutationError | DatabaseError | StoredRowError
    >;
    readonly discoveriesOfAsset: (
      assetId: string,
    ) => Effect.Effect<
      readonly StoredAssetDiscovery[],
      DatabaseError | StoredRowError
    >;
    /** Every import of one asset: the other half of its provenance (D14). */
    readonly importsOfAsset: (
      assetId: string,
    ) => Effect.Effect<
      readonly StoredAssetImport[],
      DatabaseError | StoredRowError
    >;
    readonly settleAttempt: (
      attemptId: string,
      status: AttemptTerminalStatus,
    ) => Effect.Effect<AttemptSettlement, DatabaseError | StoredRowError>;
    readonly bindSessionToAttempt: (
      attemptId: string,
      harnessSessionId: string,
    ) => Effect.Effect<string, DatabaseError>;
    readonly recordObservation: (
      caller: CallerContext,
      input: RecordObservationInput,
    ) => Effect.Effect<
      RecordObservationResult,
      MutationError | DatabaseError | StoredRowError
    >;
    readonly recordRecovery: (
      write: RecoveryWrite,
    ) => Effect.Effect<RecoveryOutcome, DatabaseError | StoredRowError>;
    readonly openReplacementAttempt: (
      input: ReplacementInput,
    ) => Effect.Effect<
      AttemptAuthority,
      MutationError | DatabaseError | StoredRowError
    >;
    readonly observationsForIntent: (
      intentId: string,
    ) => Effect.Effect<readonly Observation[], DatabaseError | StoredRowError>;
    readonly dimensionLinksForIntent: (
      intentId: string,
    ) => Effect.Effect<
      readonly DimensionLink[],
      DatabaseError | StoredRowError
    >;
    readonly dimensionsForIntent: (
      intentId: string,
    ) => Effect.Effect<
      readonly StoredDimension[],
      DatabaseError | StoredRowError
    >;
    readonly dimensionSchedulesForIntent: (
      intentId: string,
    ) => Effect.Effect<
      readonly DimensionScheduleRow[],
      DatabaseError | StoredRowError
    >;
    /**
     * The same four reads over every intent of one goal, for the goal briefing.
     *
     * Not the `*ForIntent` reads in a loop: `dimensionSchedulesForGoal` is what makes a
     * dimension's state derivable across the goal rather than per intent, and
     * `observationsForGoal` returns one ascending sequence rather than N groups. See the
     * block comment above the statements.
     */
    readonly observationsForGoal: (
      goalId: string,
    ) => Effect.Effect<readonly Observation[], DatabaseError | StoredRowError>;
    readonly dimensionLinksForGoal: (
      goalId: string,
    ) => Effect.Effect<
      readonly DimensionLink[],
      DatabaseError | StoredRowError
    >;
    readonly dimensionsForGoal: (
      goalId: string,
    ) => Effect.Effect<
      readonly StoredDimension[],
      DatabaseError | StoredRowError
    >;
    readonly dimensionSchedulesForGoal: (
      goalId: string,
    ) => Effect.Effect<
      readonly DimensionScheduleRow[],
      DatabaseError | StoredRowError
    >;
    readonly currentSequence: Effect.Effect<number, DatabaseError>;
    /** The event log's own last-assigned sequence. Not {@link currentSequence}. */
    readonly currentEventSequence: Effect.Effect<number, DatabaseError>;
    readonly loadIntent: (
      intentId: string,
    ) => Effect.Effect<IntentRow | undefined, DatabaseError>;
    readonly loadAttempt: (
      attemptId: string,
      targetId: string,
    ) => Effect.Effect<AttemptRow | undefined, DatabaseError | StoredRowError>;
    readonly unsettledAttempts: () => Effect.Effect<
      readonly AttemptRow[],
      DatabaseError | StoredRowError
    >;
    readonly recoveriesForAttempt: (
      attemptId: string,
    ) => Effect.Effect<
      readonly AttemptRecoveryRow[],
      DatabaseError | StoredRowError
    >;
    readonly recentRecoveries: () => Effect.Effect<
      readonly (typeof RecentRecoveryRow.Type)[],
      DatabaseError | StoredRowError
    >;
    /** The harness session this **goal**'s rounds should be opened under. A hint. */
    readonly plannerLineage: (
      goalId: string,
    ) => Effect.Effect<string | undefined, DatabaseError | StoredRowError>;
    readonly recordPlannerLineage: (
      goalId: string,
      harnessSessionId: string,
    ) => Effect.Effect<void, DatabaseError>;
    /**
     * What kind of authority this caller holds, checked against stored state.
     *
     * The public face of the three authority paths. A caller of one kind cannot be read
     * as another: the answer is tagged like the question.
     */
    readonly callerAuthority: (
      caller: CallerContext,
    ) => Effect.Effect<
      CallerAuthority,
      MutationError | DatabaseError | StoredRowError
    >;
    /**
     * Opens a planner round and returns the authority a credential must carry. Refuses a
     * reused id, a second running round on the goal, and an ended goal. See the
     * implementation.
     */
    readonly openRound: (
      host: HostContext,
      input: OpenRoundInput,
    ) => Effect.Effect<
      RoundAuthority,
      MutationError | DatabaseError | StoredRowError
    >;
    /** One round by id, or `undefined`. Read-only. */
    readonly loadRound: (
      roundId: string,
    ) => Effect.Effect<StoredRound | undefined, DatabaseError | StoredRowError>;
    /**
     * Rounds a process left `running`, for the startup sweep. Narrower than
     * `unsettledAttempts`: see the implementation for why an `uncertain` round is final.
     */
    readonly roundsLeftRunning: () => Effect.Effect<
      readonly StoredRound[],
      DatabaseError | StoredRowError
    >;
    /** Points a round at the session the harness created, when it ignored ours. */
    readonly bindSessionToRound: (
      roundId: string,
      harnessSessionId: string,
    ) => Effect.Effect<string, DatabaseError>;
    /**
     * Records a round's terminal status. Guarded to `running`, like `settleAttempt`, and
     * appends `plan.round.settled` only when the status really moved.
     */
    readonly settleRound: (
      roundId: string,
      status: RoundTerminalStatus,
      settledBy: RoundSettler,
    ) => Effect.Effect<RoundSettlement, DatabaseError | StoredRowError>;
    /**
     * Supersedes a round's write authority and returns its new fence. `undefined` when
     * there is no such round.
     */
    readonly supersedeRound: (
      roundId: string,
    ) => Effect.Effect<number | undefined, DatabaseError>;
    /**
     * Records what a round concluded, under the round's own authority. Refuses a caller
     * of any other kind, and a round that already concluded.
     *
     * `objective_met` also ends the goal `met`, `endedBy: "planner"`, in the same
     * transaction. `goalEnded` says whether this call was the one that did it — false when
     * the goal had already been ended, which is not an error. See the implementation.
     */
    readonly recordRoundDisposition: (
      caller: CallerContext,
      disposition: RoundDisposition,
      /** Why, in the planner's own words. Stored as given; empty is accepted. */
      rationale: string,
    ) => Effect.Effect<
      {
        readonly roundId: string;
        readonly disposition: RoundDisposition;
        readonly rationale: string;
        readonly goalEnded: boolean;
        readonly budget: number;
        readonly intentsAdded: number;
      },
      MutationError | DatabaseError | StoredRowError
    >;
    /**
     * Records that the goal agent steered one of its goal's rounds, carrying no directive.
     *
     * Receipt-keyed, so a retried steer replays and appends one `plan.round.steered` event
     * rather than two. Refuses `invalid` for a round that is not this goal's and
     * `unauthorized` for a caller that is not a goal agent; it deliberately does **not**
     * refuse a round that has since settled — see the implementation on why a steer that
     * was delivered is recorded whatever the round did next.
     */
    readonly recordRoundSteer: (
      caller: CallerContext,
      input: {
        readonly operationId: string;
        readonly roundId: string;
        /**
         * Which way the directive reached the planner.
         *
         * `steered` appends `plan.round.steered`; `opened` appends nothing and writes only
         * the receipt, because a round that started with the directive in its prompt was
         * never redirected. Both are the operation's one delivery.
         */
        readonly how: "steered" | "opened";
        readonly urgency: "queued" | "preemptive";
        readonly messageId: string;
      },
    ) => Effect.Effect<
      {
        readonly roundId: string;
        readonly goalId: string;
        readonly how: "steered" | "opened";
        readonly urgency: "queued" | "preemptive";
        readonly messageId: string;
        readonly steeredAt: number;
      },
      MutationError | DatabaseError | StoredRowError
    >;
    /**
     * What one `steer_planner` operation already did, or `undefined` for a new one.
     *
     * Read **before** either of the tool's branches decides anything: one `operation_id` is
     * one delivery, whichever way it reached the planner, and a retry replays this rather
     * than delivering again. See the implementation on why it compares no request hash.
     */
    readonly steerReceipt: (
      caller: CallerContext,
      operationId: string,
    ) => Effect.Effect<
      | {
          readonly roundId: string;
          readonly goalId: string;
          readonly how: "steered" | "opened";
          readonly urgency: "queued" | "preemptive";
          readonly messageId: string;
          readonly steeredAt: number;
        }
      | undefined,
      MutationError | DatabaseError | StoredRowError
    >;
    /**
     * The harness session this goal's conversation was last opened on.
     *
     * A hint about the harness's storage, never a claim that a conversation is live: the
     * credential that made the session able to act died with the process that minted it.
     */
    readonly goalSession: (goalId: string) => Effect.Effect<
      | {
          readonly harnessSessionId: string;
          readonly harnessInstanceId: string | null;
          readonly openedAt: number;
        }
      | undefined,
      DatabaseError | StoredRowError
    >;
    /** Records which session a goal's conversation is on, replacing any earlier one. */
    readonly recordGoalSession: (input: {
      readonly goalId: string;
      readonly targetId: string;
      readonly harnessSessionId: string;
      readonly harnessInstanceId: string | null;
    }) => Effect.Effect<void, DatabaseError>;
    /**
     * Ends the caller's own goal, recorded as `endedBy: "goal_agent"`.
     *
     * The goal comes from the credential and is not an argument, so this cannot reach
     * another goal. Records state only: it interrupts nothing that is running.
     */
    readonly endGoalAsAgent: (
      caller: CallerContext,
      input: {
        readonly operationId: string;
        readonly status: GoalEndStatus;
        readonly reason: string;
      },
    ) => Effect.Effect<
      EndGoalResult & { readonly replayed: boolean },
      MutationError | DatabaseError | StoredRowError
    >;
    /**
     * Every attempt made under one goal, oldest first, as one join.
     *
     * The rows as stored. What reads it is the goal agent's `list_attempts`, which is the
     * one thing on its tool surface that neither the briefing nor the intent list answers:
     * what has actually been *run*.
     */
    readonly attemptsForGoal: (
      goalId: string,
    ) => Effect.Effect<readonly AttemptRow[], DatabaseError | StoredRowError>;
    /**
     * Every round of one goal, newest first, each with how many intents it added.
     *
     * The rows, not what this process is supervising: `running` here means the row was
     * never settled, which a dead process can leave behind.
     */
    readonly roundsForGoal: (
      goalId: string,
    ) => Effect.Effect<
      readonly (StoredRound & { readonly intentsAdded: number })[],
      DatabaseError | StoredRowError
    >;
  }
>()("bit/persistence/ObservationStore") {
  /** Opens and migrates the database before exposing the store for this scope. */
  static readonly layer = (filename: string) =>
    Layer.effect(ObservationStore, makeStore()).pipe(
      Layer.provide(sqliteLayer(filename)),
    );

  /** Migrates an already-provided `SqlClient` before exposing the store over it. */
  static readonly layerWithClient = Layer.effect(ObservationStore, makeStore());
}
