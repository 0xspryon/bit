/**
 * Schema migrations, run by `effect/sql`'s migrator (DECISIONS.md §3 "migrations").
 *
 * Each migration is an Effect keyed `<id>_<name>` in {@link MIGRATIONS}. They are
 * **static imports in a literal record**, not a filesystem scan: `Migrator.fromRecord`
 * (`effect/src/sql/Migrator.ts:410-423`) sorts them by id and the bundler sees every one
 * of them, so `bun build` cannot drop a migration the way a glob loader would.
 *
 * What the migrator gives us, verified against the installed 4.0.5 and the driver:
 *
 * - A journal table, `effect_sql_migrations (migration_id, name, created_at)`, created
 *   on demand.
 * - **Pending-only application.** It reads the highest applied `migration_id` and skips
 *   everything at or below it, so a repeated startup re-runs nothing. An `ALTER TABLE`
 *   that would fail on a second run therefore does not get a second run.
 * - **Transactional failure.** The whole run — journal inserts and migration bodies
 *   alike — happens inside one `sql.withTransaction` (`Migrator.ts:321`), and SQLite
 *   makes DDL transactional, so a migration that throws leaves neither its schema change
 *   nor its journal row behind.
 *
 * What it does **not** give us, stated plainly: there is no `down`, no `redo` and no
 * `undo`. `MigratorOptions` has a loader and nothing else, and `ResolvedMigration` is
 * `[id, name, load]` with a single effect — there is no reverse direction anywhere in
 * the module. Nor is one being built here. The way to retract a migration is a new
 * forward migration that corrects it; the way to check a chain still builds from nothing
 * is to replay it into a throwaway file, which `migrations.test.ts` does.
 *
 * A second honest note: a failing migration arrives as a **defect**, not a typed error.
 * `Migrator.runMigration` wraps the body in `Effect.die(new MigrationError(...))`
 * (`Migrator.ts:221-233`), so a caller that only handles the error channel will see the
 * fiber die. {@link migrate} converts that back into a typed {@link DatabaseError}.
 *
 * **Never edit an applied migration.** `0001` reproduces the superseded `CREATE TABLE IF
 * NOT EXISTS` bootstrap byte for byte, because that is what makes an existing database
 * adoptable: a file created by that bootstrap has these tables but no journal, so `0001`
 * runs against it as a no-op and only the later entries do real work. Replaying the same
 * chain into an empty file produces the same schema.
 *
 * That rule is why `0002` below still names the columns it originally created, which the
 * naming cleanup in `0003` renamed. `0002` has been applied to a development database,
 * so its body is frozen; the identifiers in it are a historical record of how that file
 * reached its current state, not the names anything reads or writes today. After `0003`
 * no database — fresh or upgraded — has a column by those names, and the active schema
 * is the one `0003` leaves behind.
 *
 * **Migration ids are not contract versions.** This chain numbers schema changes made
 * during development. The observation contract is at version 1 and has never been
 * published (`packages/contracts/src/observation.ts` `OBSERVATION_CONTRACT_VERSION`);
 * three migrations do not imply three released shapes.
 */
import { SqliteMigrator } from "@effect/sql-sqlite-bun";
import { Cause, Effect } from "effect";
import { SqlClient, type SqlError } from "effect/sql";

import { DatabaseError, asDatabaseError } from "./sql";

/**
 * Runs statements in order, leaving the driver's `SqlError` in the error channel.
 *
 * It is deliberately not `orDie`'d. `Migrator.runMigration` catches a *typed* failure
 * and replaces it with `MigrationError{ kind: "Failed", message: 'Migration "2_x"
 * failed' }` (`effect/src/sql/Migrator.ts:221-233`); a migration that dies instead
 * bypasses that and reports only SQLite's own message, with no indication of which
 * migration produced it.
 */
const statements = (
  ...sql: ReadonlyArray<string>
): Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const client = yield* SqlClient.SqlClient;
    for (const statement of sql) {
      yield* client.unsafe(statement);
    }
  });

/**
 * `0001` — the delegation-and-memory slice as it was first created.
 *
 * Reproduced unchanged from the superseded bootstrap so that the adoption path works:
 * on a database the old code already created, every statement here is a no-op.
 */
const createSlice = statements(
  `CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY,
    target_id TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS intents (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL REFERENCES goals(id),
    target_id TEXT NOT NULL,
    question TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS intents_goal_idx ON intents(goal_id)`,
  `CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY,
    intent_id TEXT NOT NULL REFERENCES intents(id),
    target_id TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    harness_session_id TEXT,
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS attempts_intent_idx ON attempts(intent_id)`,
  `CREATE TABLE IF NOT EXISTS observations (
    id TEXT PRIMARY KEY,
    sequence INTEGER NOT NULL,
    target_id TEXT NOT NULL,
    intent_id TEXT NOT NULL REFERENCES intents(id),
    attempt_id TEXT NOT NULL REFERENCES attempts(id),
    harness_session_id TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    tested_claim TEXT NOT NULL,
    outcome TEXT NOT NULL,
    conditions TEXT NOT NULL,
    observed_behavior TEXT NOT NULL,
    interpretation TEXT NOT NULL,
    evidence_refs TEXT NOT NULL,
    limitations TEXT NOT NULL,
    untested_dimensions TEXT NOT NULL,
    recorded_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS observations_sequence_idx ON observations(sequence)`,
  `CREATE INDEX IF NOT EXISTS observations_intent_idx ON observations(intent_id)`,
  `CREATE TABLE IF NOT EXISTS command_receipts (
    key TEXT PRIMARY KEY,
    caller_scope TEXT NOT NULL,
    operation TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS command_receipts_scope_idx ON command_receipts(caller_scope)`,
  `CREATE TABLE IF NOT EXISTS sequence_cursor (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
  )`,
);

/**
 * `0002` — observations carry several cases, and older rows stay what they are.
 *
 * Rebuilds `observations` rather than altering it in place. `ALTER TABLE ADD COLUMN`
 * cannot express what is needed: the summary columns have to become nullable (a
 * case-based row has no singular `conditions`), the case columns have to be nullable too
 * (a summary row has no `cases`), and the pairing between them has to be enforced. A
 * `CHECK` is the only thing that stops a row claiming to be both or neither, and SQLite
 * can only add one by rebuilding.
 *
 * Existing rows are carried across with their `conditions`, `observed_behavior` and
 * `evidence_refs` verbatim. Nothing is parsed, re-split or re-attributed: the stored
 * prose describes several identities in one string and a single total request count, so
 * inventing per-actor actions out of it would be fabrication (DECISIONS.md §21). The rows
 * keep their ids, sequences, outcomes and provenance, so every receipt that names them
 * still resolves.
 *
 * **Frozen.** The column and table identifiers in the statements below are the ones this
 * migration created in an already-migrated development database, and `0003` renames them
 * to the active schema. They are left spelled as applied because re-spelling them here
 * would change what a replay produces without changing what that database contains.
 */
const addObservationCases = statements(
  `CREATE TABLE observations_v2 (
    id TEXT PRIMARY KEY,
    sequence INTEGER NOT NULL,
    schema_version INTEGER NOT NULL,
    target_id TEXT NOT NULL,
    intent_id TEXT NOT NULL REFERENCES intents(id),
    attempt_id TEXT NOT NULL REFERENCES attempts(id),
    harness_session_id TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    tested_claim TEXT NOT NULL,
    outcome TEXT NOT NULL,
    interpretation TEXT NOT NULL,
    limitations TEXT NOT NULL,
    untested_dimensions TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    setup TEXT,
    cases TEXT,
    legacy_conditions TEXT,
    legacy_observed_behavior TEXT,
    legacy_evidence_refs TEXT,
    CHECK (
      (schema_version = 2
        AND setup IS NOT NULL
        AND cases IS NOT NULL
        AND legacy_conditions IS NULL
        AND legacy_observed_behavior IS NULL
        AND legacy_evidence_refs IS NULL)
      OR
      (schema_version = 1
        AND setup IS NULL
        AND cases IS NULL
        AND legacy_conditions IS NOT NULL
        AND legacy_observed_behavior IS NOT NULL
        AND legacy_evidence_refs IS NOT NULL)
    )
  )`,
  `INSERT INTO observations_v2 (
    id, sequence, schema_version, target_id, intent_id, attempt_id,
    harness_session_id, worker_id, tested_claim, outcome, interpretation,
    limitations, untested_dimensions, recorded_at,
    setup, cases,
    legacy_conditions, legacy_observed_behavior, legacy_evidence_refs
  )
  SELECT
    id, sequence, 1, target_id, intent_id, attempt_id,
    harness_session_id, worker_id, tested_claim, outcome, interpretation,
    limitations, untested_dimensions, recorded_at,
    NULL, NULL,
    conditions, observed_behavior, evidence_refs
  FROM observations`,
  `DROP TABLE observations`,
  `ALTER TABLE observations_v2 RENAME TO observations`,
  `CREATE UNIQUE INDEX IF NOT EXISTS observations_sequence_idx ON observations(sequence)`,
  `CREATE INDEX IF NOT EXISTS observations_intent_idx ON observations(intent_id)`,
  `CREATE INDEX IF NOT EXISTS observations_version_idx ON observations(schema_version)`,
);

/**
 * `0003` — the stored schema says which record *format* a row is, not a version number.
 *
 * `0002` left two things that read as released version history and are not. The column
 * `schema_version` held `1` or `2`, and three columns were named for being superseded
 * rather than for what they hold. Nothing has ever been published: the observation
 * contract is at version 1, and `caseBased` and `summary` are two formats of it
 * (`packages/contracts/src/observation.ts`). So the column becomes `record_format` with
 * the format name in it, and the three columns are named after the format they belong to.
 *
 * This is a development rename, not a compatibility layer. It is a forward migration
 * because `0002` has already been applied to a development database and the append-only
 * rule holds; it carries every row, receipt and cursor across unchanged, and it is the
 * last place the old identifiers appear.
 *
 * A rebuild rather than `ALTER TABLE RENAME COLUMN` for one reason: the `CHECK` that
 * enforces the format/columns pairing names `schema_version`, and SQLite has no way to
 * replace a `CHECK` on an existing table. Renaming the column would leave a constraint
 * written in the old vocabulary behind it.
 */
const nameObservationRecordFormat = statements(
  `CREATE TABLE observations_normalized (
    id TEXT PRIMARY KEY,
    sequence INTEGER NOT NULL,
    record_format TEXT NOT NULL,
    target_id TEXT NOT NULL,
    intent_id TEXT NOT NULL REFERENCES intents(id),
    attempt_id TEXT NOT NULL REFERENCES attempts(id),
    harness_session_id TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    tested_claim TEXT NOT NULL,
    outcome TEXT NOT NULL,
    interpretation TEXT NOT NULL,
    limitations TEXT NOT NULL,
    untested_dimensions TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    setup TEXT,
    cases TEXT,
    summary_conditions TEXT,
    summary_observed_behavior TEXT,
    summary_evidence_refs TEXT,
    CHECK (
      (record_format = 'case_based'
        AND setup IS NOT NULL
        AND cases IS NOT NULL
        AND summary_conditions IS NULL
        AND summary_observed_behavior IS NULL
        AND summary_evidence_refs IS NULL)
      OR
      (record_format = 'summary'
        AND setup IS NULL
        AND cases IS NULL
        AND summary_conditions IS NOT NULL
        AND summary_observed_behavior IS NOT NULL
        AND summary_evidence_refs IS NOT NULL)
    )
  )`,
  // The two source values `0002` could have written map one-to-one onto the two format
  // names. A row holding anything else is left for the `CHECK` to refuse, rather than
  // silently filed under one of them.
  `INSERT INTO observations_normalized (
    id, sequence, record_format, target_id, intent_id, attempt_id,
    harness_session_id, worker_id, tested_claim, outcome, interpretation,
    limitations, untested_dimensions, recorded_at,
    setup, cases,
    summary_conditions, summary_observed_behavior, summary_evidence_refs
  )
  SELECT
    id, sequence,
    CASE schema_version
      WHEN 2 THEN 'case_based'
      WHEN 1 THEN 'summary'
      ELSE 'unknown_format_' || CAST(schema_version AS TEXT)
    END,
    target_id, intent_id, attempt_id,
    harness_session_id, worker_id, tested_claim, outcome, interpretation,
    limitations, untested_dimensions, recorded_at,
    setup, cases,
    legacy_conditions, legacy_observed_behavior, legacy_evidence_refs
  FROM observations`,
  `DROP TABLE observations`,
  `ALTER TABLE observations_normalized RENAME TO observations`,
  `CREATE UNIQUE INDEX IF NOT EXISTS observations_sequence_idx ON observations(sequence)`,
  `CREATE INDEX IF NOT EXISTS observations_intent_idx ON observations(intent_id)`,
  `CREATE INDEX IF NOT EXISTS observations_record_format_idx ON observations(record_format)`,
);

/**
 * The ordered chain. Append only; never edit an entry that has shipped.
 *
 * The key's numeric prefix is the id the journal records, and the rest is its name, so
 * renaming a key changes what the journal reports for an already-applied migration.
 */
export const MIGRATIONS: Record<
  string,
  Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient>
> = {
  "0001_delegation_memory_slice": createSlice,
  "0002_observation_cases": addObservationCases,
  "0003_observation_record_format": nameObservationRecordFormat,
};

/** The migrator's loader over {@link MIGRATIONS}. */
export const migrationLoader = SqliteMigrator.fromRecord(MIGRATIONS);

/**
 * Applies pending migrations, returning the `[id, name]` pairs this call applied.
 *
 * An empty array means the database was already current — which is the normal result of
 * every startup after the first, and what proves nothing re-ran.
 *
 * The defect-to-failure conversion is the point of this wrapper. `Migrator` dies on a
 * failed migration, so without it a bad migration would tear down the fiber with no
 * typed error for a caller to report or a test to assert on.
 */
export const migrate: Effect.Effect<
  ReadonlyArray<readonly [id: number, name: string]>,
  DatabaseError,
  SqlClient.SqlClient
> = runMigrations({ loader: migrationLoader });

/**
 * Runs an arbitrary migration chain with the typed-failure conversion.
 *
 * Exported for the tests, which need to drive deliberately broken and deliberately
 * partial chains through exactly the same code path the real one uses — a rollback
 * assertion against a different runner would prove nothing about this one.
 */
export function runMigrations<R = never>(
  options: SqliteMigrator.MigratorOptions<R>,
): Effect.Effect<
  ReadonlyArray<readonly [id: number, name: string]>,
  DatabaseError,
  SqlClient.SqlClient | R
> {
  return SqliteMigrator.run(options).pipe(
    Effect.catchCause((cause) =>
      Effect.fail(migrationFailure(cause as Cause.Cause<unknown>)),
    ),
  );
}

/** Renders whichever channel the migrator actually used as one typed failure. */
const migrationFailure = (cause: Cause.Cause<unknown>): DatabaseError => {
  for (const reason of cause.reasons) {
    const value = Cause.isFailReason(reason)
      ? reason.error
      : Cause.isDieReason(reason)
        ? reason.defect
        : undefined;
    if (value === undefined) continue;
    if (value instanceof DatabaseError) return value;
    const tagged = value as { _tag?: string; kind?: string; message?: string };
    if (tagged._tag === "MigrationError") {
      return new DatabaseError({
        operation: "migrate",
        reason: `${tagged.kind}: ${tagged.message}`,
        cause: value,
      });
    }
    if (tagged._tag === "SqlError") {
      return asDatabaseError("migrate")(value as never);
    }
  }
  return new DatabaseError({
    operation: "migrate",
    reason: Cause.pretty(cause),
    cause,
  });
};
