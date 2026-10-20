/**
 * Tests every migration path against real SQLite files.
 *
 * The chain has to hold up five ways, and all five are exercised here rather than
 * reasoned about:
 *
 * 1. A fresh database replays the whole chain and ends up with the current schema.
 * 2. Running it again applies nothing — which is what stops the table rebuilds in `0002`
 *    and `0003` from happening twice.
 * 3. A database created by the first-slice bootstrap — original tables, real rows and
 *    receipts, no journal — upgrades with its data intact.
 * 4. A database already at `0002`, which is the state of the development file, reaches
 *    the renamed schema through `0003` with every row, receipt and cursor preserved.
 * 5. A migration that fails leaves neither its schema change nor its journal row, and
 *    the database is still usable afterwards.
 *
 * Nothing here touches `apps/server/.runtime/`. Every test gets a fresh temporary file.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { SqliteMigrator } from "@effect/sql-sqlite-bun";

import {
  SUMMARY_CONDITIONS,
  SUMMARY_OBSERVATION_ID,
  SUMMARY_RECEIPT_KEY,
  writeFirstSliceDatabase,
} from "./fixtures";
import { MIGRATIONS, migrate, runMigrations } from "./migrations";
import { DatabaseError, sqliteLayer } from "./sql";

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true });
  }
});

const newDatabasePath = () => {
  const directory = mkdtempSync(join(tmpdir(), "bit-migrate-"));
  directories.push(directory);
  return join(directory, "hunt.sqlite");
};

const withSql = <A, E>(
  path: string,
  use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, SqlClient.SqlClient>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(SqlClient.SqlClient, use).pipe(
        Effect.provide(sqliteLayer(path)),
      ),
    ),
  );

interface JournalRow {
  readonly migration_id: number;
  readonly name: string;
}

const journalOf = (sql: SqlClient.SqlClient) =>
  sql<JournalRow>`SELECT migration_id, name FROM effect_sql_migrations
    ORDER BY migration_id`;

const columnsOf = (sql: SqlClient.SqlClient, table: string) =>
  Effect.map(
    sql.unsafe<{ name: string }>(`PRAGMA table_info(${table})`),
    (rows) => rows.map((row) => row.name).sort(),
  );

const tablesOf = (sql: SqlClient.SqlClient) =>
  Effect.map(
    sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'
      ORDER BY name`,
    (rows) => rows.map((row) => row.name),
  );

describe("a fresh database", () => {
  test("replays the whole chain and reports what it applied", async () => {
    const outcome = await withSql(newDatabasePath(), (sql) =>
      Effect.gen(function* () {
        const applied = yield* migrate;
        return {
          applied,
          journal: yield* journalOf(sql),
          tables: yield* tablesOf(sql),
          observations: yield* columnsOf(sql, "observations"),
        };
      }),
    );

    expect(outcome.applied.map(([id, name]) => `${id}_${name}`)).toEqual([
      "1_delegation_memory_slice",
      "2_observation_cases",
      "3_observation_record_format",
    ]);
    expect(outcome.journal.map((row) => row.migration_id)).toEqual([1, 2, 3]);
    expect(outcome.tables).toEqual([
      "attempts",
      "command_receipts",
      "effect_sql_migrations",
      "goals",
      "intents",
      "observations",
      "sequence_cursor",
    ]);
    // The table `0003` left behind, not the one `0001` created or the one `0002` did.
    expect(outcome.observations).toContain("record_format");
    expect(outcome.observations).toContain("cases");
    expect(outcome.observations).toContain("summary_conditions");
    expect(outcome.observations).not.toContain("conditions");
    expect(outcome.observations).not.toContain("schema_version");
  });

  test("the journal records one row per migration in {@link MIGRATIONS}", async () => {
    // Guards against a key being added to the record but never reaching the loader,
    // and against the loader silently skipping a malformed key.
    const journal = await withSql(newDatabasePath(), (sql) =>
      Effect.flatMap(migrate, () => journalOf(sql)),
    );
    expect(journal).toHaveLength(Object.keys(MIGRATIONS).length);
  });

  test("the rebuilt table's CHECK refuses a row that claims both formats", async () => {
    // This constraint is the only thing standing between a hand-rolled insert and a row
    // that is a case-based and a summary observation at once.
    const refused = await withSql(newDatabasePath(), (sql) =>
      Effect.gen(function* () {
        yield* migrate;
        yield* sql`INSERT INTO goals (id, target_id, description, created_at)
          VALUES ('g', 't', 'g', 1)`;
        yield* sql`INSERT INTO intents (id, goal_id, target_id, question, created_at)
          VALUES ('i', 'g', 't', 'q', 1)`;
        yield* sql`INSERT INTO attempts (id, intent_id, target_id, worker_id,
            provider_id, model_id, status, started_at)
          VALUES ('a', 'i', 't', 'w', 'p', 'm', 'running', 1)`;
        return yield* Effect.result(
          sql`INSERT INTO observations (
              id, sequence, record_format, target_id, intent_id, attempt_id,
              harness_session_id, worker_id, tested_claim, outcome, interpretation,
              limitations, untested_dimensions, recorded_at, setup, cases,
              summary_conditions, summary_observed_behavior, summary_evidence_refs
            ) VALUES ('o', 1, 'case_based', 't', 'i', 'a', 's', 'w', 'c', 'positive',
              'i', '[]', '[]', 1, 'setup', '[]', '{}', 'behaviour', '[]')`,
        );
      }),
    );

    expect(refused._tag).toBe("Failure");
    if (refused._tag === "Failure") {
      expect(refused.failure.reason._tag).toBe("ConstraintError");
    }
  });
});

describe("a database that is already current", () => {
  test("re-running the chain applies nothing", async () => {
    const path = newDatabasePath();
    const first = await withSql(path, () => migrate);
    const second = await withSql(path, () => migrate);
    const third = await withSql(path, (sql) =>
      Effect.gen(function* () {
        const applied = yield* migrate;
        return { applied, journal: yield* journalOf(sql) };
      }),
    );

    expect(first).toHaveLength(3);
    // Empty, not "re-applied". `0002` and `0003` each drop and rebuild a table; a second
    // run of either would destroy every observation written since the first.
    expect(second).toEqual([]);
    expect(third.applied).toEqual([]);
    expect(third.journal.map((row) => row.migration_id)).toEqual([1, 2, 3]);
  });

  test("rows written after migrating survive a later migrate call", async () => {
    const path = newDatabasePath();
    await withSql(path, (sql) =>
      Effect.gen(function* () {
        yield* migrate;
        yield* sql`INSERT INTO goals (id, target_id, description, created_at)
          VALUES ('g', 't', 'the goal', 1)`;
      }),
    );
    const goals = await withSql(path, (sql) =>
      Effect.flatMap(
        migrate,
        () => sql<{ description: string }>`SELECT description FROM goals`,
      ),
    );

    expect(goals.map((row) => row.description)).toEqual(["the goal"]);
  });
});

describe("adopting a first-slice database", () => {
  test("original tables with no journal upgrade, and every row is preserved", async () => {
    // The superseded bootstrap ran `CREATE TABLE IF NOT EXISTS` on every start and
    // recorded nothing, so this is the state `.runtime/hunt.sqlite` started from.
    const path = newDatabasePath();
    await writeFirstSliceDatabase(path);

    const outcome = await withSql(path, (sql) =>
      Effect.gen(function* () {
        const applied = yield* migrate;
        return {
          applied,
          journal: yield* journalOf(sql),
          observations: yield* sql<{
            id: string;
            record_format: string;
            sequence: number;
            outcome: string;
            setup: string | null;
            cases: string | null;
            summary_conditions: string | null;
            summary_observed_behavior: string | null;
            summary_evidence_refs: string | null;
          }>`SELECT id, record_format, sequence, outcome, setup, cases,
                summary_conditions, summary_observed_behavior, summary_evidence_refs
             FROM observations`,
          receipts: yield* sql<{
            key: string;
            result: string;
          }>`SELECT key, result FROM command_receipts`,
          cursor: yield* sql<{
            value: number;
          }>`SELECT value FROM sequence_cursor WHERE name = 'observations'`,
          attempts: yield* sql<{ id: string; status: string }>`
            SELECT id, status FROM attempts`,
        };
      }),
    );

    // `0001` is a no-op against the existing tables; `0002` and `0003` do the work. All
    // three are journalled, so a database created from scratch ends up identical.
    expect(outcome.applied.map(([id]) => id)).toEqual([1, 2, 3]);
    expect(outcome.journal.map((row) => row.migration_id)).toEqual([1, 2, 3]);

    const observation = outcome.observations[0];
    expect(outcome.observations).toHaveLength(1);
    expect(observation?.id).toBe(SUMMARY_OBSERVATION_ID);
    expect(observation?.sequence).toBe(1);
    expect(observation?.outcome).toBe("positive");
    // Labelled by format and left in its original shape, not rewritten as cases.
    expect(observation?.record_format).toBe("summary");
    expect(observation?.setup).toBeNull();
    expect(observation?.cases).toBeNull();
    expect(JSON.parse(observation?.summary_conditions ?? "null")).toEqual(
      SUMMARY_CONDITIONS,
    );
    expect(observation?.summary_observed_behavior).toContain(
      "request 11 returned 429",
    );
    expect(JSON.parse(observation?.summary_evidence_refs ?? "null")).toEqual([
      "transcript://summary-run",
    ]);

    // Receipts, the sequence cursor and the attempt row are untouched, so a retry of
    // the original operation still replays rather than writing a second observation.
    expect(outcome.receipts.map((row) => row.key)).toEqual([
      SUMMARY_RECEIPT_KEY,
    ]);
    expect(
      (
        JSON.parse(outcome.receipts[0]?.result ?? "{}") as {
          observationId: string;
        }
      ).observationId,
    ).toBe(SUMMARY_OBSERVATION_ID);
    expect(outcome.cursor[0]?.value).toBe(1);
    expect(outcome.attempts).toEqual([
      { id: "attempt-summary", status: "succeeded" },
    ]);
  });

  test("an upgraded database reaches the same schema as a fresh one", async () => {
    const upgradedPath = newDatabasePath();
    await writeFirstSliceDatabase(upgradedPath);
    const upgraded = await withSql(upgradedPath, (sql) =>
      Effect.flatMap(migrate, () => columnsOf(sql, "observations")),
    );
    const fresh = await withSql(newDatabasePath(), (sql) =>
      Effect.flatMap(migrate, () => columnsOf(sql, "observations")),
    );

    expect(upgraded).toEqual(fresh);
  });

  test("adopting is idempotent: a second start applies nothing", async () => {
    const path = newDatabasePath();
    await writeFirstSliceDatabase(path);
    await withSql(path, () => migrate);
    const outcome = await withSql(path, (sql) =>
      Effect.gen(function* () {
        const applied = yield* migrate;
        const rows = yield* sql<{ id: string }>`SELECT id FROM observations`;
        return { applied, rows };
      }),
    );

    expect(outcome.applied).toEqual([]);
    // The rebuild did not run a second time, so the row is still there.
    expect(outcome.rows.map((row) => row.id)).toEqual([SUMMARY_OBSERVATION_ID]);
  });
});

describe("a database already at 0002", () => {
  /** Applies only the first two entries, which is the state the development file is in. */
  const upToObservationCases = SqliteMigrator.fromRecord({
    "0001_delegation_memory_slice": MIGRATIONS["0001_delegation_memory_slice"]!,
    "0002_observation_cases": MIGRATIONS["0002_observation_cases"]!,
  });

  test("0003 renames the schema and carries every row, receipt and cursor across", async () => {
    const path = newDatabasePath();
    await writeFirstSliceDatabase(path);
    const partial = await withSql(path, () =>
      runMigrations({ loader: upToObservationCases }),
    );
    expect(partial.map(([id]) => id)).toEqual([1, 2]);

    const outcome = await withSql(path, (sql) =>
      Effect.gen(function* () {
        const applied = yield* migrate;
        return {
          applied,
          journal: yield* journalOf(sql),
          columns: yield* columnsOf(sql, "observations"),
          observations: yield* sql<{
            id: string;
            record_format: string;
            sequence: number;
            summary_conditions: string | null;
            summary_observed_behavior: string | null;
            summary_evidence_refs: string | null;
          }>`SELECT id, record_format, sequence, summary_conditions,
                summary_observed_behavior, summary_evidence_refs
             FROM observations`,
          receipts: yield* sql<{
            key: string;
            result: string;
          }>`SELECT key, result FROM command_receipts`,
          cursor: yield* sql<{
            value: number;
          }>`SELECT value FROM sequence_cursor WHERE name = 'observations'`,
        };
      }),
    );

    // Only the rename is outstanding: the two applied entries are not replayed, so the
    // rows they carried are not rebuilt a second time.
    expect(outcome.applied.map(([id, name]) => `${id}_${name}`)).toEqual([
      "3_observation_record_format",
    ]);
    expect(outcome.journal.map((row) => row.migration_id)).toEqual([1, 2, 3]);
    expect(outcome.columns).toContain("record_format");
    expect(outcome.columns).not.toContain("schema_version");

    // `schema_version = 1` became the `summary` format, with the columns intact.
    const observation = outcome.observations[0];
    expect(outcome.observations).toHaveLength(1);
    expect(observation?.id).toBe(SUMMARY_OBSERVATION_ID);
    expect(observation?.sequence).toBe(1);
    expect(observation?.record_format).toBe("summary");
    expect(JSON.parse(observation?.summary_conditions ?? "null")).toEqual(
      SUMMARY_CONDITIONS,
    );
    expect(observation?.summary_observed_behavior).toContain(
      "request 11 returned 429",
    );
    expect(JSON.parse(observation?.summary_evidence_refs ?? "null")).toEqual([
      "transcript://summary-run",
    ]);

    // The idempotency receipt and the sequence cursor are the two things a rebuild
    // could quietly lose, and losing either would let a replayed call write twice.
    expect(outcome.receipts.map((row) => row.key)).toEqual([
      SUMMARY_RECEIPT_KEY,
    ]);
    expect(
      (
        JSON.parse(outcome.receipts[0]?.result ?? "{}") as {
          observationId: string;
        }
      ).observationId,
    ).toBe(SUMMARY_OBSERVATION_ID);
    expect(outcome.cursor[0]?.value).toBe(1);
  });

  test("a case-based row written at 0002 keeps its cases through the rename", async () => {
    const path = newDatabasePath();
    await writeFirstSliceDatabase(path);
    await withSql(path, (sql) =>
      Effect.gen(function* () {
        yield* runMigrations({ loader: upToObservationCases });
        // Written in `0002`'s vocabulary on purpose: this is the row shape the
        // development file already holds, and `0003` has to map it, not drop it.
        yield* sql`INSERT INTO observations (
            id, sequence, schema_version, target_id, intent_id, attempt_id,
            harness_session_id, worker_id, tested_claim, outcome, interpretation,
            limitations, untested_dimensions, recorded_at, setup, cases,
            legacy_conditions, legacy_observed_behavior, legacy_evidence_refs
          ) VALUES ('obs_000002_attempt-summary', 2, 2, 'fixture-local',
            'intent-per-client-limiter', 'attempt-summary', 'ses_summary', 'worker-1',
            'a claim', 'negative', 'a reading', '[]', '[]', 2, 'the setup',
            '[{"id":"case-a"}]', NULL, NULL, NULL)`;
      }),
    );

    const rows = await withSql(path, (sql) =>
      Effect.flatMap(
        migrate,
        () => sql<{
          id: string;
          record_format: string;
          setup: string | null;
          cases: string | null;
        }>`SELECT id, record_format, setup, cases FROM observations
             ORDER BY sequence`,
      ),
    );

    expect(rows.map((row) => [row.id, row.record_format])).toEqual([
      [SUMMARY_OBSERVATION_ID, "summary"],
      ["obs_000002_attempt-summary", "case_based"],
    ]);
    expect(rows[1]?.setup).toBe("the setup");
    expect(rows[1]?.cases).toBe('[{"id":"case-a"}]');
  });
});

describe("a failing migration", () => {
  /** The real chain plus one migration that breaks part-way through. */
  const brokenLoader = SqliteMigrator.fromRecord({
    ...MIGRATIONS,
    "0004_broken": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Succeeds, so there is a schema change that must be rolled back.
      yield* sql`ALTER TABLE observations ADD COLUMN half_applied TEXT`;
      // Fails: no such table. A misspelled identifier is exactly the class of mistake
      // TypeScript cannot catch, which is why this test exists in this shape.
      yield* sql`SELECT * FROM observatoins`;
    }),
  });

  /** The corrective migration: forward-only, because the migrator has no `down`. */
  const fixedLoader = SqliteMigrator.fromRecord({
    ...MIGRATIONS,
    "0004_broken": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE observations ADD COLUMN half_applied TEXT`;
    }),
  });

  const run = (path: string, loader: SqliteMigrator.Loader) =>
    Effect.runPromise(
      Effect.result(
        Effect.scoped(
          runMigrations({ loader }).pipe(Effect.provide(sqliteLayer(path))),
        ),
      ),
    );

  test("names the migration that failed, in a typed error", async () => {
    const path = newDatabasePath();
    await withSql(path, () => migrate);
    const failure = await run(path, brokenLoader);

    // The migrator dies rather than failing, so without the conversion in
    // `runMigrations` this would tear the fiber down with nothing to assert on.
    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") {
      expect(failure.failure).toBeInstanceOf(DatabaseError);
      expect((failure.failure as DatabaseError).operation).toBe("migrate");
      expect((failure.failure as DatabaseError).reason).toContain("Failed");
      expect((failure.failure as DatabaseError).reason).toContain("4_broken");
    }
  });

  test("rolls back only the pending migration when earlier ones are already applied", async () => {
    const path = newDatabasePath();
    await writeFirstSliceDatabase(path);
    const applied = await withSql(path, () => migrate);
    expect(applied.map(([id]) => id)).toEqual([1, 2, 3]);

    await run(path, brokenLoader);

    const after = await withSql(path, (sql) =>
      Effect.gen(function* () {
        return {
          journal: yield* journalOf(sql),
          columns: yield* columnsOf(sql, "observations"),
          rows: yield* sql<{ id: string }>`SELECT id FROM observations`,
        };
      }),
    );

    // No journal row for 4, and no half-applied column.
    expect(after.journal.map((row) => row.migration_id)).toEqual([1, 2, 3]);
    expect(after.columns).not.toContain("half_applied");
    // The migrations that had already succeeded are untouched, data included.
    expect(after.columns).toContain("record_format");
    expect(after.rows.map((row) => row.id)).toEqual([SUMMARY_OBSERVATION_ID]);
  });

  test("rolls back the whole run when the failing migration is in the first batch", async () => {
    // Worth stating explicitly, because it is not what a per-migration transaction
    // would do: the migrator wraps the *entire* run in one transaction
    // (`effect/src/sql/Migrator.ts:321`), so a fresh database whose first migrate call
    // hits a bad migration is left completely empty rather than half-built.
    const path = newDatabasePath();
    const failure = await run(path, brokenLoader);
    expect(failure._tag).toBe("Failure");

    const after = await withSql(path, (sql) =>
      Effect.gen(function* () {
        return {
          journal: yield* journalOf(sql),
          tables: yield* tablesOf(sql),
        };
      }),
    );

    expect(after.journal).toEqual([]);
    expect(after.tables).toEqual(["effect_sql_migrations"]);
  });

  test("the database recovers once the migration is corrected", async () => {
    const path = newDatabasePath();
    await writeFirstSliceDatabase(path);
    await withSql(path, () => migrate);
    await run(path, brokenLoader);

    const recovered = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const applied = yield* runMigrations({ loader: fixedLoader });
          return {
            applied,
            journal: yield* journalOf(sql),
            columns: yield* columnsOf(sql, "observations"),
            rows: yield* sql<{ id: string }>`SELECT id FROM observations`,
          };
        }).pipe(Effect.provide(sqliteLayer(path))),
      ),
    );

    // Only the corrected migration is outstanding; 1 to 3 are not re-applied.
    expect(recovered.applied.map(([id]) => id)).toEqual([4]);
    expect(recovered.journal.map((row) => row.migration_id)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(recovered.columns).toContain("half_applied");
    expect(recovered.rows.map((row) => row.id)).toEqual([
      SUMMARY_OBSERVATION_ID,
    ]);
  });

  test("a duplicate migration id is refused rather than half-applied", async () => {
    const duplicates: SqliteMigrator.Loader = Effect.succeed([
      [1, "first", Effect.void],
      [1, "also_first", Effect.void],
    ]);
    const failure = await run(newDatabasePath(), duplicates);

    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") {
      expect((failure.failure as DatabaseError).reason).toContain("Duplicates");
    }
  });
});
