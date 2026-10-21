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
  Observation,
  ObservationTestCase,
  RecordObservationResult,
  SummaryObservationConditions,
  parseDimensionAddress,
  type ObservationProvenance,
  type ObservationRecordFormat,
  type RecordObservationInput,
} from "@bit/contracts";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";

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

export interface SeedInput {
  readonly targetId: string;
  readonly goalId: string;
  readonly goal: string;
  readonly intentId: string;
  readonly question: string;
  readonly attemptId: string;
  readonly workerId: string;
  readonly providerId: string;
  readonly modelId: string;
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
  readonly providerId: string;
  readonly modelId: string;
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

const SEQUENCE_NAME = "observations";

/** Stable key ordering so a retry hashes identically to the original call. */
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
};

const hashRequest = (
  caller: CallerContext,
  input: RecordObservationInput,
): string =>
  new Bun.CryptoHasher("sha256")
    .update(canonical({ caller, input }))
    .digest("hex");

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

const StoredReceipt = Schema.Struct({
  key: Schema.String,
  request_hash: Schema.String,
  result: Schema.fromJsonString(RecordObservationResult),
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
  provider_id: Schema.String,
  model_id: Schema.String,
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
 * One recorded "this observation took on that earlier untested dimension" link.
 *
 * `address` is kept verbatim as submitted so the stored link reads the way the briefing
 * printed it; `dimension_index` is the parsed position the write boundary resolved it to.
 */
const DimensionLinkRow = Schema.Struct({
  observation_id: Schema.String,
  address: Schema.String,
  source_observation_id: Schema.String,
  dimension_index: Schema.Int,
  created_at: Schema.Finite,
});

export interface DimensionLink {
  /** The later observation that addressed the dimension. */
  readonly observationId: string;
  readonly address: string;
  /** The observation whose `untestedDimensions` the address points into. */
  readonly sourceObservationId: string;
  readonly dimensionIndex: number;
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
   */
  const seedAttempt = Effect.fn("ObservationStore.seedAttempt")(function* (
    input: SeedInput,
  ) {
    const now = yield* Clock.currentTimeMillis;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
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
          yield* sql`INSERT INTO attempts (id, intent_id, target_id, worker_id,
              harness_session_id, provider_id, model_id, status, started_at, write_fence)
            VALUES (${input.attemptId}, ${input.intentId}, ${input.targetId},
                    ${input.workerId}, ${input.harnessSessionId},
                    ${input.providerId}, ${input.modelId}, 'running', ${now}, 0)
            ON CONFLICT(id) DO NOTHING`.pipe(
            Effect.mapError(asDatabaseError("transaction")),
          );
          const attempt = yield* attemptOrFail(input.attemptId);
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

  /** The dimension list an address points into, with the row's own intent. */
  const findDimensionSource = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({
      intent_id: Schema.String,
      untested_dimensions: jsonList,
    }),
    execute: (observationId) =>
      sql`SELECT intent_id, untested_dimensions FROM observations
          WHERE id = ${observationId}`,
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
    const source = yield* findDimensionSource(parsed.observationId).pipe(
      Effect.mapError(lift("observations", parsed.observationId)),
    );
    if (Option.isNone(source)) {
      return yield* new MutationError({
        reason: "invalid",
        detail: `no observation ${parsed.observationId} exists, so address '${address}' cannot be addressed`,
      });
    }
    if (source.value.intent_id !== caller.intentId) {
      return yield* new MutationError({
        reason: "invalid",
        detail: `address '${address}' belongs to intent ${source.value.intent_id}, not to ${caller.intentId}`,
      });
    }
    if (parsed.index >= source.value.untested_dimensions.length) {
      return yield* new MutationError({
        reason: "invalid",
        detail: `observation ${parsed.observationId} recorded ${String(source.value.untested_dimensions.length)} untested dimensions, so index ${String(parsed.index)} in '${address}' does not exist`,
      });
    }
    return { address, ...parsed };
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
              return { ...receipt.result, replayed: true };
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

            // After the observation row, because both link columns are real foreign
            // keys and SQLite checks them immediately.
            for (const link of addressed) {
              yield* sql`INSERT INTO observation_dimension_links (
                observation_id, address, source_observation_id, dimension_index,
                created_at
              ) VALUES (
                ${observationId}, ${link.address}, ${link.observationId},
                ${link.index}, ${recordedAt}
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
          yield* sql`INSERT INTO attempts (id, intent_id, target_id, worker_id,
              harness_session_id, provider_id, model_id, status, started_at,
              write_fence, replaces_attempt_id)
            VALUES (${input.attemptId}, ${replaced.intent_id}, ${replaced.target_id},
                    ${input.workerId}, ${input.harnessSessionId},
                    ${input.providerId}, ${input.modelId}, 'running', ${now}, 0,
                    ${input.replacesAttemptId})`.pipe(
            Effect.mapError(asDatabaseError("transaction")),
          );
          // Read back rather than assumed: the row was just inserted in this
          // transaction, and this is the fence a credential for it must carry.
          const opened = yield* attemptOrFail(input.attemptId);
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

  const selectLinksForIntent = SqlSchema.findAll({
    Request: Schema.String,
    Result: DimensionLinkRow,
    execute: (intentId) =>
      sql`SELECT links.observation_id, links.address, links.source_observation_id,
            links.dimension_index, links.created_at
          FROM observation_dimension_links AS links
          INNER JOIN observations AS addressing
            ON addressing.id = links.observation_id
          WHERE addressing.intent_id = ${intentId}
          ORDER BY addressing.sequence, links.address`,
  });

  /**
   * The follow-up links recorded by this intent's observations.
   *
   * Which intent a link belongs to is its addressing observation's intent, so this
   * joins rather than reading a duplicated column. Ordered by the addressing
   * observation's sequence so a reader sees the order work was taken on in.
   */
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
      address: row.address,
      sourceObservationId: row.source_observation_id,
      dimensionIndex: row.dimension_index,
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

  return ObservationStore.of({
    seedAttempt,
    settleAttempt,
    bindSessionToAttempt,
    recordObservation,
    recordRecovery,
    openReplacementAttempt,
    observationsForIntent,
    dimensionLinksForIntent,
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
    readonly seedAttempt: (
      input: SeedInput,
    ) => Effect.Effect<AttemptAuthority, DatabaseError | StoredRowError>;
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
