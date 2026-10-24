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
  RecordAssetResult,
  RecordObservationResult,
  SummaryObservationConditions,
  AddIntentResult,
  assetIdentityOf,
  dimensionAddress,
  isAssetIdentityRefusal,
  parseDimensionAddress,
  type AddIntentInput,
  type ModelOptionSelection,
  type ObservationProvenance,
  type ObservationRecordFormat,
  type OutboxEntry,
  type OutboxRequestType,
  type RecordAssetInput,
  type RecordedEvent,
  type RecordObservationInput,
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
 * The authenticated caller. Every field is derived from the bearer credential the
 * host issued when it created the session, never from anything the model said. A
 * worker cannot name a different intent, attempt or target by asking.
 *
 * `attemptFence` is the write-authority epoch the credential was minted against. It is
 * compared against the attempt's current `write_fence` on every new write, so authority
 * revoked by recovery stays revoked across a restart — unlike the in-memory credential
 * registry, which simply forgets.
 */
export interface CallerContext {
  readonly callerScope: string;
  readonly targetId: string;
  readonly intentId: string;
  readonly attemptId: string;
  readonly harnessSessionId: string;
  readonly workerId: string;
  readonly attemptFence: number;
}

/**
 * The host's own authority, for a mutation no worker makes.
 *
 * An intent is created by the host, not by a worker: a planner round has no execution
 * attempt, so there is nothing for it to present and no {@link CallerContext} to build
 * (DECISIONS.md §4's planner-authority gap, recorded in `contracts/intent.ts`). This is
 * the smaller thing that is still true — which target, and whose receipts — and it is
 * supplied by the process that owns the registry, never by a payload.
 */
export interface HostContext {
  readonly callerScope: string;
  readonly targetId: string;
}

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
const hashRequest = (
  caller: CallerContext | HostContext,
  input: unknown,
): string =>
  new Bun.CryptoHasher("sha256")
    .update(canonical({ caller, input }))
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
    caller: CallerContext,
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

  /**
   * Checks the caller still holds write authority over the attempt it claims.
   *
   * Three separate refusals, because they mean different things to a worker: the
   * attempt is not registered for that target and intent at all; the attempt has
   * settled, so no new evidence can be filed under it; or the fence has moved, so this
   * credential's authority was explicitly revoked while it was out.
   */
  const checkAuthority = Effect.fnUntraced(function* (caller: CallerContext) {
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
      const recordedAt = yield* Clock.currentTimeMillis;
      const key = `${caller.callerScope}:record_observation:${input.operationId}`;
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
                RecordObservationResult,
                receipt.result,
              );
              return { ...original, replayed: true };
            }

            yield* checkAuthority(caller);

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
              (address) => resolveAddress(caller, address),
            );

            // Allocated inside the transaction, so a sequence gap cannot outlive a rollback.
            const cursor = yield* bumpSequence(SEQUENCE_NAME).pipe(
              Effect.mapError(lift("sequence_cursor", SEQUENCE_NAME)),
            );
            const sequence = cursor.value;

            const observationId = `obs_${sequence.toString().padStart(6, "0")}_${caller.attemptId}`;
            const provenance: ObservationProvenance = {
              targetId: caller.targetId,
              intentId: caller.intentId,
              attemptId: caller.attemptId,
              harnessSessionId: caller.harnessSessionId,
              workerId: caller.workerId,
              recordedAt,
            };

            yield* sql`INSERT INTO observations (
              id, sequence, record_format, target_id, intent_id, attempt_id,
              harness_session_id, worker_id, tested_claim, outcome, interpretation,
              limitations, untested_dimensions, recorded_at, setup, cases,
              summary_conditions, summary_observed_behavior, summary_evidence_refs
            ) VALUES (
              ${observationId}, ${sequence}, ${STORED_FORMAT[OBSERVATION_WRITE_FORMAT]},
              ${caller.targetId}, ${caller.intentId}, ${caller.attemptId},
              ${caller.harnessSessionId}, ${caller.workerId},
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
              ${key}, ${caller.callerScope}, 'record_observation',
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
              targetId: caller.targetId,
              callerScope: caller.callerScope,
              intentId: caller.intentId,
              attemptId: caller.attemptId,
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
              targetId: caller.targetId,
              payload: {
                subject: "observation.recorded",
                observationId,
                intentId: caller.intentId,
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
  const recordAsset = Effect.fn("ObservationStore.recordAsset")(function* (
    caller: CallerContext,
    input: RecordAssetInput,
  ) {
    const recordedAt = yield* Clock.currentTimeMillis;
    const key = `${caller.callerScope}:record_asset:${input.operationId}`;
    const requestHash = hashRequest(caller, input);
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

          yield* checkAuthority(caller);

          const identity = assetIdentityOf(input);
          if (isAssetIdentityRefusal(identity)) {
            return yield* new MutationError({
              reason: "invalid",
              detail: identity.detail,
            });
          }

          yield* sql`INSERT INTO assets (
              id, target_id, kind, identity, host, port, scheme, method, path,
              first_seen_at
            ) VALUES (
              ${identifier.newAssetId()}, ${caller.targetId}, ${identity.kind},
              ${identity.identity}, ${identity.host}, ${identity.port},
              ${identity.scheme}, ${identity.method}, ${identity.path},
              ${recordedAt}
            )
            ON CONFLICT(target_id, kind, identity) DO NOTHING`.pipe(
            Effect.mapError(asDatabaseError("transaction")),
          );
          const stored = yield* findAssetByIdentity({
            targetId: caller.targetId,
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
          const created = asset.first_seen_at === recordedAt;

          yield* sql`INSERT INTO asset_discoveries (
              asset_id, operation_id, caller_scope, intent_id, attempt_id,
              discovered_as, note, discovered_at
            ) VALUES (
              ${asset.id}, ${input.operationId}, ${caller.callerScope},
              ${caller.intentId}, ${caller.attemptId}, ${input.url},
              ${input.note}, ${recordedAt}
            )`.pipe(Effect.mapError(asDatabaseError("transaction")));

          const discoveries = yield* countDiscoveries(asset.id).pipe(
            Effect.mapError(lift("asset_discoveries", asset.id)),
          );
          const result: RecordAssetResult = {
            assetId: asset.id,
            kind: identity.kind,
            identity: identity.identity,
            created,
            replayed: false,
            discoveries: discoveries.value,
          };

          yield* sql`INSERT INTO command_receipts (
              key, caller_scope, operation, operation_id, request_hash, result,
              created_at
            ) VALUES (
              ${key}, ${caller.callerScope}, 'record_asset', ${input.operationId},
              ${requestHash}, ${JSON.stringify(result)}, ${recordedAt}
            )`.pipe(Effect.mapError(asDatabaseError("transaction")));

          const event = yield* appendEvent({
            kind: "asset.recorded",
            targetId: caller.targetId,
            callerScope: caller.callerScope,
            intentId: caller.intentId,
            attemptId: caller.attemptId,
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
            targetId: caller.targetId,
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
  const addIntent = Effect.fn("ObservationStore.addIntent")(function* (
    host: HostContext,
    input: AddIntentInput,
  ) {
    const createdAt = yield* Clock.currentTimeMillis;
    const key = `${host.callerScope}:add_intent:${input.operationId}`;
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
              AddIntentResult,
              receipt.result,
            );
            return { ...original, replayed: true };
          }

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

          yield* sql`INSERT INTO intents (
              id, goal_id, target_id, question, created_at, addresses_dimension
            ) VALUES (
              ${input.intentId}, ${input.goalId}, ${host.targetId},
              ${input.question}, ${createdAt}, ${addressesDimensionId}
            )`.pipe(Effect.mapError(asDatabaseError("transaction")));

          for (const [
            position,
            anchorId,
          ] of input.anchorObservationIds.entries()) {
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

  const selectSequence = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: SequenceRow,
    execute: (name) =>
      sql`SELECT value FROM sequence_cursor WHERE name = ${name}`,
  });

  const currentSequence = selectSequence(SEQUENCE_NAME).pipe(
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

  const selectPlannerLineage = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ harness_session_id: Schema.String }),
    execute: (targetId) =>
      sql`SELECT harness_session_id FROM planner_lineages
          WHERE target_id = ${targetId}`,
  });

  /**
   * The harness session later planner rounds on this target should be opened under.
   *
   * A hint, not a fact: the id names a row in OpenCode's storage, which can be cleared
   * without ours changing. A caller confirms it and records a replacement when it
   * cannot — nothing in the investigation depends on the answer either way.
   */
  const plannerLineage = Effect.fn("ObservationStore.plannerLineage")(
    function* (targetId: string) {
      const row = yield* selectPlannerLineage(targetId).pipe(
        Effect.mapError(lift("planner_lineages", targetId)),
      );
      return Option.match(row, {
        onNone: () => undefined,
        onSome: (value) => value.harness_session_id,
      });
    },
  );

  /**
   * Records the lineage for a target, replacing any earlier one.
   *
   * An upsert rather than an insert: a lineage the harness has forgotten is replaced by
   * the next round, and there is exactly one current answer per target.
   */
  const recordPlannerLineage = Effect.fn(
    "ObservationStore.recordPlannerLineage",
  )(function* (targetId: string, harnessSessionId: string) {
    const now = yield* Clock.currentTimeMillis;
    yield* sql`INSERT INTO planner_lineages (target_id, harness_session_id, created_at)
      VALUES (${targetId}, ${harnessSessionId}, ${now})
      ON CONFLICT(target_id) DO UPDATE SET
        harness_session_id = excluded.harness_session_id,
        created_at = excluded.created_at`.pipe(
      Effect.mapError(asDatabaseError("query")),
    );
  });

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
    seedAttempt,
    recordAsset,
    addIntent,
    eventsAfter,
    pendingRequests,
    anchorsForIntent,
    assets,
    discoveriesOfAsset,
    settleAttempt,
    bindSessionToAttempt,
    recordObservation,
    recordRecovery,
    openReplacementAttempt,
    observationsForIntent,
    dimensionLinksForIntent,
    dimensionsForIntent,
    dimensionSchedulesForIntent,
    currentSequence,
    loadIntent,
    loadAttempt,
    unsettledAttempts,
    recoveriesForAttempt,
    plannerLineage,
    recordPlannerLineage,
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
    readonly addIntent: (
      host: HostContext,
      input: AddIntentInput,
    ) => Effect.Effect<
      AddIntentResult,
      MutationError | DatabaseError | StoredRowError
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
    readonly discoveriesOfAsset: (
      assetId: string,
    ) => Effect.Effect<
      readonly StoredAssetDiscovery[],
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
    readonly currentSequence: Effect.Effect<number, DatabaseError>;
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
    readonly plannerLineage: (
      targetId: string,
    ) => Effect.Effect<string | undefined, DatabaseError | StoredRowError>;
    readonly recordPlannerLineage: (
      targetId: string,
      harnessSessionId: string,
    ) => Effect.Effect<void, DatabaseError>;
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
