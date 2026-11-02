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
 * 5. A database already at `0005`, holding recovery records written under the original
 *    three-column key, reaches the state-keyed table through `0006` with every row,
 *    `times` count and timestamp intact and a `prior_status` derived from what the row
 *    already recorded.
 * 6. A migration that fails leaves neither its schema change nor its journal row, and
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
  RUNNING_ATTEMPT_ID,
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

/** Runs one chain against a file and keeps the failure, for the rollback assertions. */
const runChain = (path: string, loader: SqliteMigrator.Loader) =>
  Effect.runPromise(
    Effect.result(
      Effect.scoped(
        runMigrations({ loader }).pipe(Effect.provide(sqliteLayer(path))),
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

/**
 * The primary key a table actually carries, in declaration order.
 *
 * Read from `PRAGMA table_info`'s `pk` column rather than from the migration text,
 * because the question is what the rebuilt table ended up with.
 */
const primaryKeyOf = (sql: SqlClient.SqlClient, table: string) =>
  Effect.map(
    sql.unsafe<{ name: string; pk: number }>(`PRAGMA table_info(${table})`),
    (rows) =>
      rows
        .filter((row) => row.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((row) => row.name),
  );

/**
 * The ids the chain declares, in order, as `[id, name]` and as plain numbers.
 *
 * Derived from {@link MIGRATIONS} rather than written out, so appending an entry does
 * not mean editing every full-chain assertion. Assertions about a *subset* — which
 * entries one upgrade applied — are still written out, because that is the part a
 * derived list could not check.
 */
const CHAIN = Object.keys(MIGRATIONS).map((key) => {
  const match = /^(\d+)_(.+)$/.exec(key);
  if (match === null) throw new Error(`migration key ${key} has no id`);
  return [Number(match[1]), match[2] ?? ""] as const;
});
const CHAIN_IDS = CHAIN.map(([id]) => id);
const CHAIN_LABELS = CHAIN.map(([id, name]) => `${String(id)}_${name}`);

/**
 * An id far above the chain, for the deliberately broken entries.
 *
 * It has to be above every real id or the migrator would skip it (it applies only ids
 * greater than the highest applied), and it must not collide with an id the chain may
 * grow into, which is why it is 99 rather than "one more than the last one".
 */
const BROKEN_ID = "0099";

/**
 * The real chain truncated at one id, as a loader.
 *
 * Needed because the migrator applies only ids *above* the highest applied one: a loader
 * built by removing one entry from the middle of {@link MIGRATIONS} would apply
 * everything after it and then never be able to apply the hole. Every "a database
 * already at NNNN" test therefore takes a file to that id and migrates forward from
 * there, which is also what a real upgrade does.
 */
const chainThrough = (highestId: number): SqliteMigrator.Loader =>
  SqliteMigrator.fromRecord(
    Object.fromEntries(
      Object.entries(MIGRATIONS).filter(
        ([key]) => Number(key.slice(0, key.indexOf("_"))) <= highestId,
      ),
    ),
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
          recoveries: yield* columnsOf(sql, "attempt_recoveries"),
          recoveryKey: yield* primaryKeyOf(sql, "attempt_recoveries"),
        };
      }),
    );

    expect(outcome.applied.map(([id, name]) => `${id}_${name}`)).toEqual(
      CHAIN_LABELS,
    );
    expect(outcome.journal.map((row) => row.migration_id)).toEqual(CHAIN_IDS);
    expect(outcome.tables).toEqual([
      "asset_discoveries",
      "asset_imports",
      "asset_scope_labels",
      "assets",
      "attempt_recoveries",
      "attempts",
      "command_receipts",
      "effect_sql_migrations",
      "events",
      "goal_sessions",
      "goals",
      "host_scope_labels",
      "import_sessions",
      "intent_anchors",
      "intents",
      "observation_dimension_links",
      "observation_dimensions",
      "observations",
      "outbox",
      "planner_lineages",
      "planner_rounds",
      "scope_entries",
      "sequence_cursor",
    ]);
    // The table `0003` left behind, not the one `0001` created or the one `0002` did.
    expect(outcome.observations).toContain("record_format");
    expect(outcome.observations).toContain("cases");
    expect(outcome.observations).toContain("summary_conditions");
    expect(outcome.observations).not.toContain("conditions");
    expect(outcome.observations).not.toContain("schema_version");
    // `0006` rebuilt this one, and a fresh replay has to end up with the rebuilt shape
    // rather than `0004`'s: the table keeps its name, so only the key and the extra
    // column distinguish them.
    expect(outcome.recoveries).toContain("prior_status");
    expect(outcome.recoveryKey).toEqual([
      "attempt_id",
      "observed_status",
      "prior_status",
      "resulting_status",
      "disposition",
      "fence_before",
      "fence_after",
    ]);
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

    expect(first).toHaveLength(Object.keys(MIGRATIONS).length);
    // Empty, not "re-applied". `0002` and `0003` each drop and rebuild a table; a second
    // run of either would destroy every observation written since the first.
    expect(second).toEqual([]);
    expect(third.applied).toEqual([]);
    expect(third.journal.map((row) => row.migration_id)).toEqual(CHAIN_IDS);
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

    // `0001` is a no-op against the existing tables; the later entries do the work.
    // Every entry is journalled, so a database created from scratch ends up identical.
    expect(outcome.applied.map(([id]) => id)).toEqual(CHAIN_IDS);
    expect(outcome.journal.map((row) => row.migration_id)).toEqual(CHAIN_IDS);

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
    // Both adopted attempts keep their status, including the one left running: nothing
    // in a migration settles an attempt, and only reconciliation may.
    expect(outcome.attempts).toEqual([
      { id: "attempt-summary", status: "succeeded" },
      { id: RUNNING_ATTEMPT_ID, status: "running" },
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

    // The two applied entries are not replayed, so the rows they carried are not
    // rebuilt a second time; everything after them is outstanding and runs in order.
    expect(outcome.applied.map(([id, name]) => `${id}_${name}`)).toEqual([
      "3_observation_record_format",
      "4_attempt_recovery",
      "5_dimension_followups",
      "6_recovery_state_key",
      "7_planner_lineage",
      "8_observation_dimensions",
      "9_intent_dimension_provenance",
      "10_assets",
      "11_intent_anchors",
      "12_event_log",
      "13_outbox",
      "14_attempt_harness_instance",
      "15_attempt_model_options",
      "16_goal_lifecycle",
      "17_intent_lifecycle",
      "18_planner_rounds",
      "19_planner_lineage_by_goal",
      "20_round_disposition_rationale",
      "21_goal_sessions",
      "22_target_scope",
      "23_asset_imports",
      "24_import_sessions",
      "25_import_session_confirmation",
    ]);
    expect(outcome.journal.map((row) => row.migration_id)).toEqual(CHAIN_IDS);
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

describe("a database already at 0005", () => {
  /**
   * Applies everything up to the recovery table as `0004` created it.
   *
   * This is the state of any database that ran the previous chain, the development file
   * included, and it is the only way to exercise `0006` against rows written under the
   * three-column key it replaces.
   */
  const upToDimensionFollowUps = SqliteMigrator.fromRecord({
    "0001_delegation_memory_slice": MIGRATIONS["0001_delegation_memory_slice"]!,
    "0002_observation_cases": MIGRATIONS["0002_observation_cases"]!,
    "0003_observation_record_format":
      MIGRATIONS["0003_observation_record_format"]!,
    "0004_attempt_recovery": MIGRATIONS["0004_attempt_recovery"]!,
    "0005_dimension_followups": MIGRATIONS["0005_dimension_followups"]!,
  });

  interface OldRecovery {
    readonly attempt: string;
    readonly observed: string;
    readonly resulting: string;
    readonly disposition: string;
    readonly fenceBefore: number;
    readonly fenceAfter: number;
    readonly times: number;
  }

  /**
   * Rows in `0004`'s vocabulary: no `prior_status`, because the column did not exist.
   *
   * One of each disposition, plus the two cases that make the derivation interesting —
   * a `uncertain` pass that moved the fence (so it came from `running`) and one that did
   * not (so the attempt was already `uncertain`) — plus a disposition nothing writes, to
   * pin what happens to a value this codebase does not recognise.
   */
  const OLD_ROWS: readonly OldRecovery[] = [
    {
      attempt: "attempt-settled",
      observed: "succeeded",
      resulting: "succeeded",
      disposition: "settled",
      fenceBefore: 0,
      fenceAfter: 1,
      // The conflated row the old key produced: the second pass was really
      // `already_final` and overwrote nothing but the detail and this counter.
      times: 2,
    },
    {
      attempt: "attempt-settled",
      observed: "running",
      resulting: "running",
      disposition: "still_running",
      fenceBefore: 0,
      fenceAfter: 0,
      times: 3,
    },
    {
      attempt: "attempt-uncertain",
      observed: "unreachable",
      resulting: "uncertain",
      disposition: "uncertain",
      fenceBefore: 0,
      fenceAfter: 1,
      times: 1,
    },
    {
      attempt: "attempt-uncertain",
      observed: "missing",
      resulting: "uncertain",
      disposition: "uncertain",
      fenceBefore: 1,
      fenceAfter: 1,
      times: 4,
    },
    {
      attempt: "attempt-uncertain",
      observed: "running",
      resulting: "uncertain",
      disposition: "unresumable",
      fenceBefore: 1,
      fenceAfter: 1,
      times: 1,
    },
    {
      attempt: "attempt-uncertain",
      observed: "interrupted",
      resulting: "interrupted",
      disposition: "refined",
      fenceBefore: 1,
      fenceAfter: 1,
      times: 1,
    },
    {
      attempt: "attempt-final",
      observed: "failed",
      resulting: "succeeded",
      disposition: "already_final",
      fenceBefore: 1,
      fenceAfter: 1,
      times: 2,
    },
    {
      attempt: "attempt-final",
      observed: "missing",
      resulting: "succeeded",
      disposition: "not_a_disposition",
      fenceBefore: 1,
      fenceAfter: 1,
      times: 1,
    },
  ];

  /** Writes the attempts those records hang off, then the records themselves. */
  const seedAtZeroFive = (path: string) =>
    withSql(path, (sql) =>
      Effect.gen(function* () {
        yield* runMigrations({ loader: upToDimensionFollowUps });
        yield* sql`INSERT INTO goals (id, target_id, description, created_at)
          VALUES ('g', 't', 'the goal', 1)`;
        yield* sql`INSERT INTO intents (id, goal_id, target_id, question, created_at)
          VALUES ('i', 'g', 't', 'the question', 1)`;
        for (const [attempt, status] of [
          ["attempt-settled", "succeeded"],
          ["attempt-uncertain", "uncertain"],
          ["attempt-final", "succeeded"],
        ] as const) {
          yield* sql`INSERT INTO attempts (id, intent_id, target_id, worker_id,
              provider_id, model_id, status, started_at, write_fence)
            VALUES (${attempt}, 'i', 't', 'w', 'p', 'm', ${status}, 1, 1)`;
        }
        let at = 100;
        for (const row of OLD_ROWS) {
          at += 10;
          yield* sql`INSERT INTO attempt_recoveries (
              attempt_id, observed_status, resulting_status, disposition, detail,
              harness_session_id, fence_before, fence_after,
              observations_at_recovery, first_reconciled_at, last_reconciled_at, times
            ) VALUES (
              ${row.attempt}, ${row.observed}, ${row.resulting}, ${row.disposition},
              ${`${row.disposition} detail`}, 'ses_old', ${row.fenceBefore},
              ${row.fenceAfter}, 0, ${at}, ${at + 1}, ${row.times}
            )`;
        }
      }),
    );

  interface NewRecovery {
    readonly attempt_id: string;
    readonly observed_status: string;
    readonly prior_status: string;
    readonly resulting_status: string;
    readonly disposition: string;
    readonly detail: string;
    readonly fence_before: number;
    readonly fence_after: number;
    readonly first_reconciled_at: number;
    readonly last_reconciled_at: number;
    readonly times: number;
  }

  const recoveriesIn = (sql: SqlClient.SqlClient) =>
    sql<NewRecovery>`SELECT attempt_id, observed_status, prior_status,
        resulting_status, disposition, detail, fence_before, fence_after,
        first_reconciled_at, last_reconciled_at, times
      FROM attempt_recoveries ORDER BY rowid`;

  test("0006 rebuilds the key and carries every record, count and timestamp across", async () => {
    const path = newDatabasePath();
    await seedAtZeroFive(path);

    const outcome = await withSql(path, (sql) =>
      Effect.gen(function* () {
        const applied = yield* migrate;
        return {
          applied,
          key: yield* primaryKeyOf(sql, "attempt_recoveries"),
          rows: yield* recoveriesIn(sql),
        };
      }),
    );

    expect(outcome.applied.map(([id, name]) => `${id}_${name}`)).toEqual([
      "6_recovery_state_key",
      "7_planner_lineage",
      "8_observation_dimensions",
      "9_intent_dimension_provenance",
      "10_assets",
      "11_intent_anchors",
      "12_event_log",
      "13_outbox",
      "14_attempt_harness_instance",
      "15_attempt_model_options",
      "16_goal_lifecycle",
      "17_intent_lifecycle",
      "18_planner_rounds",
      "19_planner_lineage_by_goal",
      "20_round_disposition_rationale",
      "21_goal_sessions",
      "22_target_scope",
      "23_asset_imports",
      "24_import_sessions",
      "25_import_session_confirmation",
    ]);
    expect(outcome.key).toEqual([
      "attempt_id",
      "observed_status",
      "prior_status",
      "resulting_status",
      "disposition",
      "fence_before",
      "fence_after",
    ]);

    // Nothing dropped, nothing merged, and insertion order preserved — which is what
    // `recoveriesForAttempt` reads as "in the order first seen".
    expect(outcome.rows).toHaveLength(OLD_ROWS.length);
    expect(
      outcome.rows.map((row) => [
        row.attempt_id,
        row.observed_status,
        row.prior_status,
        row.resulting_status,
        row.disposition,
      ]),
    ).toEqual([
      // `settled` is only reachable from `running`.
      ["attempt-settled", "succeeded", "running", "succeeded", "settled"],
      ["attempt-settled", "running", "running", "running", "still_running"],
      // The fence moved, so this `uncertain` pass left `running`.
      ["attempt-uncertain", "unreachable", "running", "uncertain", "uncertain"],
      // The fence did not, so the attempt was already `uncertain`.
      ["attempt-uncertain", "missing", "uncertain", "uncertain", "uncertain"],
      ["attempt-uncertain", "running", "uncertain", "uncertain", "unresumable"],
      [
        "attempt-uncertain",
        "interrupted",
        "uncertain",
        "interrupted",
        "refined",
      ],
      // `already_final` keeps whatever it was already in.
      ["attempt-final", "failed", "succeeded", "succeeded", "already_final"],
      // Not a disposition anything writes: marked, not filed under a guess.
      [
        "attempt-final",
        "missing",
        "unrecorded",
        "succeeded",
        "not_a_disposition",
      ],
    ]);

    // Every count, timestamp, fence and detail string is the one that was written.
    expect(outcome.rows.map((row) => row.times)).toEqual(
      OLD_ROWS.map((row) => row.times),
    );
    expect(
      outcome.rows.map((row) => [row.fence_before, row.fence_after]),
    ).toEqual(OLD_ROWS.map((row) => [row.fenceBefore, row.fenceAfter]));
    expect(
      outcome.rows.map((row) => [
        row.first_reconciled_at,
        row.last_reconciled_at,
      ]),
    ).toEqual([
      [110, 111],
      [120, 121],
      [130, 131],
      [140, 141],
      [150, 151],
      [160, 161],
      [170, 171],
      [180, 181],
    ]);
    expect(outcome.rows.map((row) => row.detail)).toEqual(
      OLD_ROWS.map((row) => `${row.disposition} detail`),
    );
  });

  test("the rebuilt key separates two passes the old one collapsed", async () => {
    const path = newDatabasePath();
    await seedAtZeroFive(path);

    const outcome = await withSql(path, (sql) =>
      Effect.gen(function* () {
        yield* migrate;
        // The pass the old key could not hold: same attempt, same observed status, same
        // resulting status as the `settled` row above, and a different decision.
        const alongside = yield* Effect.result(
          sql`INSERT INTO attempt_recoveries (
              attempt_id, observed_status, prior_status, resulting_status, disposition,
              detail, harness_session_id, fence_before, fence_after,
              observations_at_recovery, first_reconciled_at, last_reconciled_at, times
            ) VALUES ('attempt-settled', 'succeeded', 'succeeded', 'succeeded',
              'already_final', 'asked again', 'ses_old', 1, 1, 0, 200, 200, 1)`,
        );
        // And the identity still has to be an identity: the same state twice is refused
        // by the constraint rather than becoming a second row.
        const duplicate = yield* Effect.result(
          sql`INSERT INTO attempt_recoveries (
              attempt_id, observed_status, prior_status, resulting_status, disposition,
              detail, harness_session_id, fence_before, fence_after,
              observations_at_recovery, first_reconciled_at, last_reconciled_at, times
            ) VALUES ('attempt-settled', 'succeeded', 'running', 'succeeded',
              'settled', 'again', 'ses_old', 0, 1, 0, 300, 300, 1)`,
        );
        return {
          alongside,
          duplicate,
          rows: yield* recoveriesIn(sql),
        };
      }),
    );

    expect(outcome.alongside._tag).toBe("Success");
    expect(outcome.duplicate._tag).toBe("Failure");
    if (outcome.duplicate._tag === "Failure") {
      expect(outcome.duplicate.failure.reason._tag).toBe("ConstraintError");
    }
    expect(
      outcome.rows
        .filter((row) => row.attempt_id === "attempt-settled")
        .map((row) => [row.prior_status, row.disposition]),
    ).toEqual([
      ["running", "settled"],
      ["running", "still_running"],
      ["succeeded", "already_final"],
    ]);
  });

  /** The real chain plus one entry that fails, appended past the last real entry. */
  const brokenAfterRebuild = SqliteMigrator.fromRecord({
    ...MIGRATIONS,
    [`${BROKEN_ID}_broken_after_rebuild`]: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`SELECT * FROM attempt_recoveires`;
    }),
  });

  test("a migration that fails after 0006 leaves the rebuilt table and its rows", async () => {
    const path = newDatabasePath();
    await seedAtZeroFive(path);
    await withSql(path, () => migrate);

    const failure = await runChain(path, brokenAfterRebuild);
    expect(failure._tag).toBe("Failure");

    const after = await withSql(path, (sql) =>
      Effect.gen(function* () {
        return {
          journal: yield* journalOf(sql),
          key: yield* primaryKeyOf(sql, "attempt_recoveries"),
          rows: yield* recoveriesIn(sql),
        };
      }),
    );

    // The rollback takes the pending migration with it and nothing else: `0006` is
    // still journalled and the rebuilt table still holds every row.
    expect(after.journal.map((row) => row.migration_id)).toEqual(CHAIN_IDS);
    expect(after.key).toContain("prior_status");
    expect(after.rows).toHaveLength(OLD_ROWS.length);
    expect(after.rows.map((row) => row.times)).toEqual(
      OLD_ROWS.map((row) => row.times),
    );
  });
});

describe("a database already at 0006", () => {
  const runThrough = (path: string, highestId: number) =>
    Effect.runPromise(
      Effect.scoped(
        runMigrations({ loader: chainThrough(highestId) }).pipe(
          Effect.provide(sqliteLayer(path)),
        ),
      ),
    );

  test("0007 adds the lineage table and touches nothing else", async () => {
    const path = newDatabasePath();
    await runThrough(path, 6);

    const before = await withSql(path, (sql) => tablesOf(sql));
    expect(before).not.toContain("planner_lineages");

    const applied = await runThrough(path, 7);
    expect(applied.map(([id, name]) => `${id}_${name}`)).toEqual([
      "7_planner_lineage",
    ]);

    const after = await withSql(path, (sql) =>
      Effect.gen(function* () {
        return {
          tables: yield* tablesOf(sql),
          columns: yield* columnsOf(sql, "planner_lineages"),
          key: yield* primaryKeyOf(sql, "planner_lineages"),
          rows: yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM planner_lineages`,
        };
      }),
    );

    expect(after.columns).toEqual([
      "created_at",
      "harness_session_id",
      "target_id",
    ]);
    // One current lineage per target, so the target is the key and a later round
    // replaces rather than appends.
    expect(after.key).toEqual(["target_id"]);
    // It arrives empty: a lineage is recorded by the first planner round that opens
    // one, never by the migration.
    expect(after.rows[0]?.count).toBe(0);
    // Every other table is exactly as `0006` left it.
    expect(after.tables.filter((name) => name !== "planner_lineages")).toEqual(
      before,
    );
  });
});

/**
 * The pre-`0008` backfill, against a file the real migration bodies took to `0007`.
 *
 * This is the path a development database actually walks: it holds observations whose
 * untested dimensions are a JSON array inside the row, and follow-up links keyed by
 * `(address, dimension_index)`. Nothing about it can be checked against a fresh database,
 * because a fresh one has no rows to unnest — so every assertion here is about data that
 * existed before the migration ran.
 */
describe("a database already at 0007", () => {
  const runThrough = (path: string, highestId: number) =>
    Effect.runPromise(
      Effect.scoped(
        runMigrations({ loader: chainThrough(highestId) }).pipe(
          Effect.provide(sqliteLayer(path)),
        ),
      ),
    );

  const RAISER = "obs_000001_attempt-a";
  const ADDRESSER = "obs_000002_attempt-b";
  /** Three dimensions, including one whose text would break a concatenated statement. */
  const RAISED = [
    "the per-account limit was never approached",
    `a second tenant was never tried; the operator said "it's fine"); DROP TABLE x; --`,
    "no window rollover was measured",
  ];

  /** Takes a file to `0007` and fills it with the shapes `0008` has to carry across. */
  const seedAtZeroSeven = async (path: string) => {
    await runThrough(path, 7);
    await withSql(path, (sql) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO goals (id, target_id, description, created_at)
          VALUES ('goal-1', 'fixture-local', 'Can rate limits be bypassed?', 1)`;
        yield* sql`INSERT INTO intents (id, goal_id, target_id, question, created_at)
          VALUES ('intent-1', 'goal-1', 'fixture-local', 'Probe the limiter.', 1)`;
        yield* sql`INSERT INTO attempts (id, intent_id, target_id, worker_id,
            harness_session_id, provider_id, model_id, status, started_at, write_fence)
          VALUES ('attempt-a', 'intent-1', 'fixture-local', 'worker-1', 'ses_a',
                  'openai', 'gpt-5.6-sol', 'succeeded', 1, 1)`;
        yield* sql`INSERT INTO attempts (id, intent_id, target_id, worker_id,
            harness_session_id, provider_id, model_id, status, started_at, write_fence)
          VALUES ('attempt-b', 'intent-1', 'fixture-local', 'worker-1', 'ses_b',
                  'openai', 'gpt-5.6-sol', 'succeeded', 2, 1)`;
        // The raiser carries three dimensions; the addresser carries none, so the
        // backfill has to cope with an empty array as well as a populated one.
        yield* sql`INSERT INTO observations (
            id, sequence, record_format, target_id, intent_id, attempt_id,
            harness_session_id, worker_id, tested_claim, outcome, interpretation,
            limitations, untested_dimensions, recorded_at,
            summary_conditions, summary_observed_behavior, summary_evidence_refs
          ) VALUES (
            ${RAISER}, 1, 'summary', 'fixture-local', 'intent-1', 'attempt-a',
            'ses_a', 'worker-1', 'Header rotation evades the limit.', 'positive',
            'Keys on the header value.', '[]', ${JSON.stringify(RAISED)}, 1000,
            '{}', 'seen', '[]'
          )`;
        yield* sql`INSERT INTO observations (
            id, sequence, record_format, target_id, intent_id, attempt_id,
            harness_session_id, worker_id, tested_claim, outcome, interpretation,
            limitations, untested_dimensions, recorded_at,
            summary_conditions, summary_observed_behavior, summary_evidence_refs
          ) VALUES (
            ${ADDRESSER}, 2, 'summary', 'fixture-local', 'intent-1', 'attempt-b',
            'ses_b', 'worker-1', 'The account limit is 100.', 'negative',
            'Not reproduced.', '[]', '[]', 2000, '{}', 'seen', '[]'
          )`;
        // A link in `0005`'s shape: keyed by the printed address and the parsed index.
        yield* sql`INSERT INTO observation_dimension_links (
            observation_id, address, source_observation_id, dimension_index, created_at
          ) VALUES (${ADDRESSER}, ${`${RAISER}#u0`}, ${RAISER}, 0, 2000)`;
      }),
    );
  };

  test("0008 unnests every dimension in position order, with the raiser's own clock", async () => {
    const path = newDatabasePath();
    await seedAtZeroSeven(path);

    const applied = await runThrough(path, 8);
    expect(applied.map(([id, name]) => `${id}_${name}`)).toEqual([
      "8_observation_dimensions",
    ]);

    const after = await withSql(path, (sql) =>
      Effect.gen(function* () {
        return {
          dimensions: yield* sql<{
            id: string;
            observation_id: string;
            position: number;
            text: string;
            created_at: number;
          }>`SELECT id, observation_id, position, text, created_at
             FROM observation_dimensions ORDER BY observation_id, position`,
          key: yield* primaryKeyOf(sql, "observation_dimension_links"),
          links: yield* sql<{
            observation_id: string;
            dimension_id: string;
            address: string;
            created_at: number;
          }>`SELECT observation_id, dimension_id, address, created_at
             FROM observation_dimension_links`,
          columns: yield* columnsOf(sql, "observation_dimension_links"),
        };
      }),
    );

    // One row per element, in position order, with the text byte for byte.
    expect(
      after.dimensions.map((row) => [row.position, row.text] as const),
    ).toEqual(RAISED.map((text, index) => [index, text] as const));
    expect(after.dimensions.every((row) => row.observation_id === RAISER)).toBe(
      true,
    );
    // The addresser recorded an empty array, so it contributes nothing: `json_each` over
    // `[]` yields no rows rather than one null row.
    expect(after.dimensions).toHaveLength(RAISED.length);
    // Stamped with the raising observation's `recorded_at`, not the migration's clock.
    expect(after.dimensions.map((row) => row.created_at)).toEqual([
      1000, 1000, 1000,
    ]);
    // Ids are opaque: not the alias, and not anything containing the position.
    for (const row of after.dimensions) {
      expect(row.id).toMatch(/^dim_[0-9a-f]{32}$/);
      expect(row.id).not.toContain(RAISER);
      expect(row.id).not.toContain("#u");
    }
    expect(new Set(after.dimensions.map((row) => row.id)).size).toBe(
      RAISED.length,
    );

    // The link is repointed onto the dimension's id, keeps its address verbatim and its
    // own timestamp, and the parsed-position columns are gone.
    const dimensionZero = after.dimensions.find((row) => row.position === 0);
    expect(after.links).toEqual([
      {
        observation_id: ADDRESSER,
        dimension_id: dimensionZero?.id ?? "missing",
        address: `${RAISER}#u0`,
        created_at: 2000,
      },
    ]);
    expect(after.key).toEqual(["observation_id", "dimension_id"]);
    expect(after.columns).not.toContain("source_observation_id");
    expect(after.columns).not.toContain("dimension_index");
  });

  test("0009 adds a nullable dimension reference to intents and nothing else", async () => {
    const path = newDatabasePath();
    await seedAtZeroSeven(path);
    await runThrough(path, 8);

    const before = await withSql(path, (sql) => columnsOf(sql, "intents"));
    expect(before).not.toContain("addresses_dimension");

    const applied = await runThrough(path, 9);
    expect(applied.map(([id, name]) => `${id}_${name}`)).toEqual([
      "9_intent_dimension_provenance",
    ]);

    const after = await withSql(path, (sql) =>
      Effect.gen(function* () {
        const asMigrated = yield* sql<{
          addresses_dimension: string | null;
        }>`SELECT addresses_dimension FROM intents WHERE id = 'intent-1'`;
        const dimension = yield* sql<{
          id: string;
        }>`SELECT id FROM observation_dimensions WHERE position = 1`;
        const id = dimension[0]?.id ?? "missing";
        yield* sql`UPDATE intents SET addresses_dimension = ${id}
          WHERE id = 'intent-1'`;
        const refused = yield* Effect.result(
          sql`INSERT INTO intents (id, goal_id, target_id, question, created_at,
                addresses_dimension)
              VALUES ('intent-2', 'goal-1', 'fixture-local', 'q', 3, 'dim_nope')`,
        );
        return {
          columns: yield* columnsOf(sql, "intents"),
          declared: yield* sql<{
            addresses_dimension: string | null;
          }>`SELECT addresses_dimension FROM intents WHERE id = 'intent-1'`,
          refused: refused._tag,
          asMigrated:
            asMigrated[0] === undefined
              ? "row missing"
              : asMigrated[0].addresses_dimension,
          existing: yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM intents`,
          dimensionId: id,
        };
      }),
    );

    expect(after.columns).toContain("addresses_dimension");
    // The migration invented no provenance: the existing intent arrived null, and the
    // value read back here is the one this test then declared on it.
    expect(after.asMigrated).toBeNull();
    expect(after.declared[0]?.addresses_dimension).toBe(after.dimensionId);
    // The reference is a real foreign key, so an id no dimension holds is refused.
    expect(after.refused).toBe("Failure");
    expect(after.existing[0]?.count).toBe(1);
  });

  test("0008 refuses to drop a link whose dimension does not exist", async () => {
    const path = newDatabasePath();
    await seedAtZeroSeven(path);
    // An index past the end of the stored list. `0005`'s write boundary made this
    // impossible, so this is a guard against what we have not thought of — and an
    // INNER JOIN would have dropped the row silently instead of failing.
    await withSql(
      path,
      (sql) =>
        sql`INSERT INTO observation_dimension_links (
          observation_id, address, source_observation_id, dimension_index, created_at
        ) VALUES (${ADDRESSER}, ${`${RAISER}#u9`}, ${RAISER}, 9, 2000)`,
    );

    const failure = await runChain(path, chainThrough(8));
    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") {
      expect((failure.failure as DatabaseError).reason).toContain(
        "8_observation_dimensions",
      );
    }

    // Rolled back whole: no dimensions table, the old link columns intact, both links
    // still there, and the journal unchanged.
    const after = await withSql(path, (sql) =>
      Effect.gen(function* () {
        return {
          tables: yield* tablesOf(sql),
          columns: yield* columnsOf(sql, "observation_dimension_links"),
          links: yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM observation_dimension_links`,
          journal: yield* journalOf(sql),
        };
      }),
    );
    expect(after.tables).not.toContain("observation_dimensions");
    expect(after.columns).toContain("dimension_index");
    expect(after.links[0]?.count).toBe(2);
    expect(after.journal.map((row) => row.migration_id)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  test("0008 refuses an untested_dimensions column that is not a JSON array", async () => {
    const path = newDatabasePath();
    await seedAtZeroSeven(path);
    await withSql(
      path,
      (sql) =>
        sql`UPDATE observations SET untested_dimensions = '"not an array"'
        WHERE id = ${ADDRESSER}`,
    );

    const failure = await runChain(path, chainThrough(8));
    expect(failure._tag).toBe("Failure");

    const after = await withSql(path, (sql) => tablesOf(sql));
    expect(after).not.toContain("observation_dimensions");
  });
});

/**
 * The tables Day 2 adds, each checked for what it enforces rather than for existing.
 */
describe("a database already at 0009", () => {
  const runThrough = (path: string, highestId: number) =>
    Effect.runPromise(
      Effect.scoped(
        runMigrations({ loader: chainThrough(highestId) }).pipe(
          Effect.provide(sqliteLayer(path)),
        ),
      ),
    );

  test("0010 refuses an asset whose columns contradict its kind", async () => {
    const path = newDatabasePath();
    await runThrough(path, 9);
    const applied = await runThrough(path, 10);
    expect(applied.map(([id, name]) => `${id}_${name}`)).toEqual(["10_assets"]);

    const outcome = await withSql(path, (sql) =>
      Effect.gen(function* () {
        const insert = (
          id: string,
          kind: string,
          scheme: string | null,
          method: string | null,
          path_: string | null,
        ) =>
          Effect.result(
            sql`INSERT INTO assets (id, target_id, kind, identity, host, port,
                  scheme, method, path, first_seen_at)
                VALUES (${id}, 't', ${kind}, ${id}, 'h', 80, ${scheme}, ${method},
                        ${path_}, 1)`,
          );
        return {
          hostOk: (yield* insert("a", "host", null, null, null))._tag,
          hostWithMethod: (yield* insert("b", "host", null, "GET", null))._tag,
          endpointOk: (yield* insert("c", "endpoint", "http:", "GET", "/x"))
            ._tag,
          endpointWithoutMethod: (yield* insert(
            "d",
            "endpoint",
            "http:",
            null,
            "/x",
          ))._tag,
          duplicateIdentity: (yield* Effect.result(
            sql`INSERT INTO assets (id, target_id, kind, identity, host, port,
                  scheme, method, path, first_seen_at)
                VALUES ('e', 't', 'host', 'a', 'h', 80, NULL, NULL, NULL, 1)`,
          ))._tag,
          otherTargetSameIdentity: (yield* Effect.result(
            sql`INSERT INTO assets (id, target_id, kind, identity, host, port,
                  scheme, method, path, first_seen_at)
                VALUES ('f', 'other', 'host', 'a', 'h', 80, NULL, NULL, NULL, 1)`,
          ))._tag,
        };
      }),
    );

    expect(outcome.hostOk).toBe("Success");
    expect(outcome.endpointOk).toBe("Success");
    // The `CHECK` is what stops a row claiming to be a host with a method, or an
    // endpoint without one, whatever a handler believes it is writing.
    expect(outcome.hostWithMethod).toBe("Failure");
    expect(outcome.endpointWithoutMethod).toBe("Failure");
    // Identity is unique within a target and kind, which is where the domain merge
    // happens — and it does not reach across targets, which it must not.
    expect(outcome.duplicateIdentity).toBe("Failure");
    expect(outcome.otherTargetSameIdentity).toBe("Success");
  });

  test("0012 makes a recorded event immutable and undeletable in the database", async () => {
    const path = newDatabasePath();
    await runThrough(path, 12);

    const outcome = await withSql(path, (sql) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO events (id, sequence, target_id, kind, payload,
            operation, subject_id, recorded_at)
          VALUES ('evt_000001', 1, 't', 'asset.recorded', '{}', 'record_asset',
                  'asset-1', 1)`;
        const updated = yield* Effect.result(
          sql`UPDATE events SET kind = 'something.else' WHERE id = 'evt_000001'`,
        );
        const deleted = yield* Effect.result(
          sql`DELETE FROM events WHERE id = 'evt_000001'`,
        );
        const duplicateSequence = yield* Effect.result(
          sql`INSERT INTO events (id, sequence, target_id, kind, payload,
              operation, subject_id, recorded_at)
            VALUES ('evt_000002', 1, 't', 'asset.recorded', '{}', 'record_asset',
                    'asset-2', 2)`,
        );
        return {
          updated: updated._tag,
          deleted: deleted._tag,
          duplicateSequence: duplicateSequence._tag,
          rows: yield* sql<{
            id: string;
            kind: string;
          }>`SELECT id, kind FROM events`,
        };
      }),
    );

    // Not "we never wrote an UPDATE": the database refuses one.
    expect(outcome.updated).toBe("Failure");
    expect(outcome.deleted).toBe("Failure");
    expect(outcome.duplicateSequence).toBe("Failure");
    expect(outcome.rows).toEqual([
      { id: "evt_000001", kind: "asset.recorded" },
    ]);
  });

  test("0013 refuses an unknown status, an unknown policy and an orphan request", async () => {
    const path = newDatabasePath();
    await runThrough(path, 13);

    const outcome = await withSql(path, (sql) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO events (id, sequence, target_id, kind, payload,
            operation, subject_id, recorded_at)
          VALUES ('evt_000001', 1, 't', 'asset.recorded', '{}', 'record_asset',
                  'asset-1', 1)`;
        const enqueue = (
          id: string,
          sequence: number,
          status: string,
          policy: string,
          eventId: string,
        ) =>
          Effect.result(
            sql`INSERT INTO outbox (id, sequence, target_id, request_type, payload,
                  recovery_policy, caused_by_event_id, status, attempts, enqueued_at)
                VALUES (${id}, ${sequence}, 't', 'asset.enrich', '{}', ${policy},
                        ${eventId}, ${status}, 0, 1)`,
          );
        return {
          ok: (yield* enqueue(
            "out_1",
            1,
            "pending",
            "safe_to_retry",
            "evt_000001",
          ))._tag,
          badStatus: (yield* enqueue(
            "out_2",
            2,
            "queued",
            "safe_to_retry",
            "evt_000001",
          ))._tag,
          badPolicy: (yield* enqueue(
            "out_3",
            3,
            "pending",
            "just_retry",
            "evt_000001",
          ))._tag,
          orphan: (yield* enqueue(
            "out_4",
            4,
            "pending",
            "safe_to_retry",
            "evt_999999",
          ))._tag,
        };
      }),
    );

    expect(outcome.ok).toBe("Success");
    expect(outcome.badStatus).toBe("Failure");
    expect(outcome.badPolicy).toBe("Failure");
    // An obligation with no event behind it is an obligation nobody can explain.
    expect(outcome.orphan).toBe("Failure");
  });
});

describe("a database already at 0015", () => {
  /**
   * Goals as `seedAttempt` minted them before goals had a lifecycle, in a file at `0015`.
   *
   * Inserted with a plain `INSERT` that names only the four columns that existed then, so
   * the rows are what the old code wrote and the defaults are what has to supply the rest.
   * Two targets, so "every existing goal becomes active" is not satisfied by one row.
   */
  const seedGoalsAtZeroFifteen = (path: string) =>
    withSql(path, (sql) =>
      Effect.gen(function* () {
        yield* runMigrations({ loader: chainThrough(15) });
        yield* sql`INSERT INTO goals (id, target_id, description, created_at)
          VALUES ('goal_old_a', 'acme-corp', 'find auth bypasses', 100)`;
        yield* sql`INSERT INTO goals (id, target_id, description, created_at)
          VALUES ('goal_old_b', 'internal-api', 'probe tenant isolation', 200)`;
        yield* sql`INSERT INTO intents (id, goal_id, target_id, question, created_at)
          VALUES ('intent_old', 'goal_old_a', 'acme-corp', 'does login rate-limit?', 101)`;
      }),
    );

  test("leaves existing goals readable, active and unnamed", async () => {
    const path = newDatabasePath();
    await seedGoalsAtZeroFifteen(path);

    const outcome = await withSql(path, (sql) =>
      Effect.gen(function* () {
        return {
          applied: yield* migrate,
          goals: yield* sql<{
            id: string;
            description: string;
            created_at: number;
            name: string;
            status: string;
            ended_at: number | null;
            ended_by: string | null;
            end_reason: string | null;
          }>`SELECT id, description, created_at, name, status, ended_at, ended_by,
                    end_reason
             FROM goals ORDER BY id`,
          intents: yield* sql<{ goal_id: string }>`SELECT goal_id FROM intents`,
        };
      }),
    );

    // Everything above 0015 is outstanding.
    expect(outcome.applied.map(([id, name]) => `${id}_${name}`)).toEqual([
      "16_goal_lifecycle",
      "17_intent_lifecycle",
      "18_planner_rounds",
      "19_planner_lineage_by_goal",
      "20_round_disposition_rationale",
      "21_goal_sessions",
      "22_target_scope",
      "23_asset_imports",
      "24_import_sessions",
      "25_import_session_confirmation",
    ]);
    // The old columns are untouched; the new ones took the defaults the migration
    // documents: an open goal, no name, and no ending recorded.
    expect(outcome.goals).toEqual([
      {
        id: "goal_old_a",
        description: "find auth bypasses",
        created_at: 100,
        name: "",
        status: "active",
        ended_at: null,
        ended_by: null,
        end_reason: null,
      },
      {
        id: "goal_old_b",
        description: "probe tenant isolation",
        created_at: 200,
        name: "",
        status: "active",
        ended_at: null,
        ended_by: null,
        end_reason: null,
      },
    ]);
    // The goal-to-intent link is the thing a rebuilt table would lose.
    expect(outcome.intents).toEqual([{ goal_id: "goal_old_a" }]);
  });

  test("adds the index a target's goal list reads through", async () => {
    const path = newDatabasePath();
    await withSql(path, () => migrate);

    const index = await withSql(path, (sql) =>
      Effect.gen(function* () {
        const rows = yield* sql.unsafe<{ name: string }>(
          `PRAGMA index_list(goals)`,
        );
        const columns = yield* sql.unsafe<{ seqno: number; name: string }>(
          `PRAGMA index_info(goals_target_status_idx)`,
        );
        return {
          present: rows.map((row) => row.name),
          columns: [...columns]
            .sort((a, b) => a.seqno - b.seqno)
            .map((column) => column.name),
        };
      }),
    );

    expect(index.present).toContain("goals_target_status_idx");
    expect(index.columns).toEqual(["target_id", "status"]);
  });

  test("a fresh database has the same goal columns as an upgraded one", async () => {
    const upgraded = newDatabasePath();
    await seedGoalsAtZeroFifteen(upgraded);
    await withSql(upgraded, () => migrate);
    const fresh = newDatabasePath();
    await withSql(fresh, () => migrate);

    const [fromUpgrade, fromScratch] = await Promise.all([
      withSql(upgraded, (sql) => columnsOf(sql, "goals")),
      withSql(fresh, (sql) => columnsOf(sql, "goals")),
    ]);

    expect(fromScratch).toEqual(fromUpgrade);
    expect(fromScratch).toEqual(
      [
        "id",
        "target_id",
        "description",
        "created_at",
        "name",
        "status",
        "ended_at",
        "ended_by",
        "end_reason",
      ].sort(),
    );
  });
});

describe("a database already at 0016", () => {
  /**
   * Intents as the old minting path wrote them, in a file at `0016`.
   *
   * Plain `INSERT`s naming only the columns that existed then, so the defaults are what
   * has to supply the rest. One intent has an attempt, so "the attempt link survives" is
   * not satisfied by an intent nothing hangs off.
   */
  const seedIntentsAtZeroSixteen = (path: string) =>
    withSql(path, (sql) =>
      Effect.gen(function* () {
        yield* runMigrations({ loader: chainThrough(16) });
        yield* sql`INSERT INTO goals (id, target_id, description, created_at)
          VALUES ('goal_old', 'acme-corp', 'find auth bypasses', 100)`;
        yield* sql`INSERT INTO intents (id, goal_id, target_id, question, created_at)
          VALUES ('intent_old_a', 'goal_old', 'acme-corp', 'does login rate-limit?', 101)`;
        yield* sql`INSERT INTO intents (id, goal_id, target_id, question, created_at)
          VALUES ('intent_old_b', 'goal_old', 'acme-corp', 'is the token rotated?', 102)`;
        yield* sql`INSERT INTO attempts (id, intent_id, target_id, worker_id,
            provider_id, model_id, status, started_at, write_fence)
          VALUES ('att_old', 'intent_old_a', 'acme-corp', 'wk_old', 'p', 'm',
                  'succeeded', 103, 0)`;
      }),
    );

  test("existing intents become open, unclaimed and unsuggested", async () => {
    const path = newDatabasePath();
    await seedIntentsAtZeroSixteen(path);

    const outcome = await withSql(path, (sql) =>
      Effect.gen(function* () {
        return {
          applied: yield* migrate,
          intents: yield* sql<{
            id: string;
            goal_id: string;
            question: string;
            created_at: number;
            status: string;
            claimed_by_attempt_id: string | null;
            suggested_instance_id: string | null;
            suggested_model: string | null;
            suggested_model_options: string | null;
          }>`SELECT id, goal_id, question, created_at, status, claimed_by_attempt_id,
                    suggested_instance_id, suggested_model, suggested_model_options
             FROM intents ORDER BY id`,
          attempts: yield* sql<{
            intent_id: string;
          }>`SELECT intent_id FROM attempts`,
        };
      }),
    );

    expect(outcome.applied.map(([id, name]) => `${id}_${name}`)).toEqual([
      "17_intent_lifecycle",
      "18_planner_rounds",
      "19_planner_lineage_by_goal",
      "20_round_disposition_rationale",
      "21_goal_sessions",
      "22_target_scope",
      "23_asset_imports",
      "24_import_sessions",
      "25_import_session_confirmation",
    ]);
    const unchanged = {
      claimed_by_attempt_id: null,
      suggested_instance_id: null,
    };
    expect(outcome.intents).toEqual([
      {
        id: "intent_old_a",
        goal_id: "goal_old",
        question: "does login rate-limit?",
        created_at: 101,
        status: "open",
        ...unchanged,
        suggested_model: null,
        suggested_model_options: null,
      },
      {
        id: "intent_old_b",
        goal_id: "goal_old",
        question: "is the token rotated?",
        created_at: 102,
        status: "open",
        ...unchanged,
        suggested_model: null,
        suggested_model_options: null,
      },
    ]);
    // Not back-filled to `answered`, even though its attempt succeeded: the settlement
    // rule judges at the moment of settling and is not applied to rows it never saw.
    expect(outcome.attempts).toEqual([{ intent_id: "intent_old_a" }]);
  });

  test("adds the index a goal's intent list reads through", async () => {
    const path = newDatabasePath();
    await withSql(path, () => migrate);

    const index = await withSql(path, (sql) =>
      Effect.gen(function* () {
        const rows = yield* sql.unsafe<{ name: string }>(
          `PRAGMA index_list(intents)`,
        );
        const columns = yield* sql.unsafe<{ seqno: number; name: string }>(
          `PRAGMA index_info(intents_goal_status_idx)`,
        );
        return {
          present: rows.map((row) => row.name),
          columns: [...columns]
            .sort((a, b) => a.seqno - b.seqno)
            .map((column) => column.name),
        };
      }),
    );

    expect(index.present).toContain("intents_goal_status_idx");
    expect(index.columns).toEqual(["goal_id", "status"]);
  });

  test("a fresh database has the same intent columns as an upgraded one", async () => {
    const upgraded = newDatabasePath();
    await seedIntentsAtZeroSixteen(upgraded);
    await withSql(upgraded, () => migrate);
    const fresh = newDatabasePath();
    await withSql(fresh, () => migrate);

    const [fromUpgrade, fromScratch] = await Promise.all([
      withSql(upgraded, (sql) => columnsOf(sql, "intents")),
      withSql(fresh, (sql) => columnsOf(sql, "intents")),
    ]);

    expect(fromScratch).toEqual(fromUpgrade);
    expect(fromScratch).toContain("status");
    expect(fromScratch).toContain("claimed_by_attempt_id");
    expect(fromScratch).toContain("suggested_instance_id");
    expect(fromScratch).toContain("suggested_model");
    expect(fromScratch).toContain("suggested_model_options");
  });
});

describe("a database already at 0017", () => {
  /**
   * A file at `0017`, with a planner lineage keyed by target and two goals under it.
   *
   * This is the state `0019` has to re-key from, and the rows are what the migration's
   * comment makes a claim about: a target-keyed lineage cannot be re-keyed to a goal
   * without inventing which goal it belonged to, so it is dropped.
   */
  const seedLineageAtZeroSeventeen = (path: string) =>
    withSql(path, (sql) =>
      Effect.gen(function* () {
        yield* runMigrations({ loader: chainThrough(17) });
        yield* sql`INSERT INTO goals (id, target_id, description, created_at, name, status)
          VALUES ('goal_old', 'acme-corp', 'find auth bypasses', 100, '', 'active')`;
        yield* sql`INSERT INTO planner_lineages (target_id, harness_session_id, created_at)
          VALUES ('acme-corp', 'ses_old_lineage', 101)`;
      }),
    );

  test("0018 adds the round table with its own index, and nothing else moves", async () => {
    const path = newDatabasePath();
    await seedLineageAtZeroSeventeen(path);

    const outcome = await withSql(path, (sql) =>
      Effect.gen(function* () {
        const applied = yield* runMigrations({ loader: chainThrough(18) });
        return {
          applied,
          rounds: yield* columnsOf(sql, "planner_rounds"),
          key: yield* primaryKeyOf(sql, "planner_rounds"),
          indexes: yield* sql<{ name: string }>`SELECT name FROM sqlite_master
            WHERE type = 'index' AND tbl_name = 'planner_rounds' ORDER BY name`,
          // The lineage is still target-keyed at 0018: one migration, one change.
          lineageColumns: yield* columnsOf(sql, "planner_lineages"),
          goals: yield* sql<{ id: string }>`SELECT id FROM goals ORDER BY id`,
        };
      }),
    );

    expect(outcome.applied.map(([id, name]) => `${id}_${name}`)).toEqual([
      "18_planner_rounds",
    ]);
    expect(outcome.rounds).toEqual(
      [
        "id",
        "goal_id",
        "target_id",
        "status",
        "write_fence",
        "harness_session_id",
        "harness_instance_id",
        "provider_id",
        "model_id",
        "started_at_sequence",
        "budget",
        "disposition",
        "started_at",
        "ended_at",
      ].sort(),
    );
    expect(outcome.key).toEqual(["id"]);
    expect(outcome.indexes.map((row) => row.name)).toContain(
      "planner_rounds_goal_idx",
    );
    expect(outcome.lineageColumns).toContain("target_id");
    expect(outcome.goals.map((row) => row.id)).toEqual(["goal_old"]);
  });

  test("0019 re-keys the lineage to the goal over an existing database, dropping the rows it cannot re-key", async () => {
    const path = newDatabasePath();
    await seedLineageAtZeroSeventeen(path);

    const outcome = await withSql(path, (sql) =>
      Effect.gen(function* () {
        const applied = yield* migrate;
        return {
          applied,
          columns: yield* columnsOf(sql, "planner_lineages"),
          key: yield* primaryKeyOf(sql, "planner_lineages"),
          rows: yield* sql<{
            goal_id: string;
          }>`SELECT goal_id FROM planner_lineages`,
          // Everything the lineage is *not* about is untouched by the rebuild.
          goals: yield* sql<{ id: string }>`SELECT id FROM goals ORDER BY id`,
        };
      }),
    );

    expect(outcome.applied.map(([id, name]) => `${id}_${name}`)).toEqual([
      "18_planner_rounds",
      "19_planner_lineage_by_goal",
      "20_round_disposition_rationale",
      "21_goal_sessions",
      "22_target_scope",
      "23_asset_imports",
      "24_import_sessions",
      "25_import_session_confirmation",
    ]);
    expect(outcome.key).toEqual(["goal_id"]);
    expect(outcome.columns).toEqual(
      ["goal_id", "harness_session_id", "created_at"].sort(),
    );
    // The migration's own comment says these go, and why: a target-keyed row names no
    // goal, and the table holds only a prompt-cache hint. Asserted rather than described.
    expect(outcome.rows).toEqual([]);
    expect(outcome.goals.map((row) => row.id)).toEqual(["goal_old"]);
  });

  test("the re-keyed lineage takes a goal that exists and refuses one that does not", async () => {
    // The foreign key is new in `0019`: `target_id` was a bare column and `goal_id` is a
    // reference, because a goal is ours and a target folder is not.
    const path = newDatabasePath();
    await seedLineageAtZeroSeventeen(path);

    const outcome = await withSql(path, (sql) =>
      Effect.gen(function* () {
        yield* migrate;
        const accepted = yield* Effect.result(
          sql`INSERT INTO planner_lineages (goal_id, harness_session_id, created_at)
            VALUES ('goal_old', 'ses_new_lineage', 200)`,
        );
        const refused = yield* Effect.result(
          sql`INSERT INTO planner_lineages (goal_id, harness_session_id, created_at)
            VALUES ('goal_absent', 'ses_orphan', 201)`,
        );
        return { accepted, refused };
      }),
    );

    expect(outcome.accepted._tag).toBe("Success");
    expect(outcome.refused._tag).toBe("Failure");
  });

  test("the upgraded lineage table matches a fresh replay exactly", async () => {
    const upgraded = newDatabasePath();
    await seedLineageAtZeroSeventeen(upgraded);
    await withSql(upgraded, () => migrate);

    const fresh = newDatabasePath();
    await withSql(fresh, () => migrate);

    const [fromUpgrade, fromScratch] = await Promise.all([
      withSql(upgraded, (sql) =>
        Effect.all({
          lineage: columnsOf(sql, "planner_lineages"),
          lineageKey: primaryKeyOf(sql, "planner_lineages"),
          rounds: columnsOf(sql, "planner_rounds"),
        }),
      ),
      withSql(fresh, (sql) =>
        Effect.all({
          lineage: columnsOf(sql, "planner_lineages"),
          lineageKey: primaryKeyOf(sql, "planner_lineages"),
          rounds: columnsOf(sql, "planner_rounds"),
        }),
      ),
    ]);

    expect(fromUpgrade).toEqual(fromScratch);
  });
});

describe("a failing migration", () => {
  /** The real chain plus one migration that breaks part-way through. */
  const brokenLoader = SqliteMigrator.fromRecord({
    ...MIGRATIONS,
    [`${BROKEN_ID}_broken`]: Effect.gen(function* () {
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
    [`${BROKEN_ID}_broken`]: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE observations ADD COLUMN half_applied TEXT`;
    }),
  });

  test("names the migration that failed, in a typed error", async () => {
    const path = newDatabasePath();
    await withSql(path, () => migrate);
    const failure = await runChain(path, brokenLoader);

    // The migrator dies rather than failing, so without the conversion in
    // `runMigrations` this would tear the fiber down with nothing to assert on.
    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") {
      expect(failure.failure).toBeInstanceOf(DatabaseError);
      expect((failure.failure as DatabaseError).operation).toBe("migrate");
      expect((failure.failure as DatabaseError).reason).toContain("Failed");
      expect((failure.failure as DatabaseError).reason).toContain("99_broken");
    }
  });

  test("rolls back only the pending migration when earlier ones are already applied", async () => {
    const path = newDatabasePath();
    await writeFirstSliceDatabase(path);
    const applied = await withSql(path, () => migrate);
    expect(applied.map(([id]) => id)).toEqual(CHAIN_IDS);

    await runChain(path, brokenLoader);

    const after = await withSql(path, (sql) =>
      Effect.gen(function* () {
        return {
          journal: yield* journalOf(sql),
          columns: yield* columnsOf(sql, "observations"),
          rows: yield* sql<{ id: string }>`SELECT id FROM observations`,
        };
      }),
    );

    // No journal row for the broken entry, and no half-applied column.
    expect(after.journal.map((row) => row.migration_id)).toEqual(CHAIN_IDS);
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
    const failure = await runChain(path, brokenLoader);
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
    await runChain(path, brokenLoader);

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

    // Only the corrected migration is outstanding; the real chain is not re-applied.
    expect(recovered.applied.map(([id]) => id)).toEqual([Number(BROKEN_ID)]);
    expect(recovered.journal.map((row) => row.migration_id)).toEqual([
      ...CHAIN_IDS,
      Number(BROKEN_ID),
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
    const failure = await runChain(newDatabasePath(), duplicates);

    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") {
      expect((failure.failure as DatabaseError).reason).toContain("Duplicates");
    }
  });
});

describe("0025 import session confirmation", () => {
  test("a row written under 0024 upgrades unconfirmed, and can then be confirmed", async () => {
    const path = newDatabasePath();
    const outcome = await withSql(path, (sql) =>
      Effect.gen(function* () {
        yield* runMigrations({ loader: chainThrough(24) });
        yield* sql`INSERT INTO import_sessions (
            import_id, target_id, harness_session_id, harness_instance_id, model,
            caller_scope, opened_at
          ) VALUES ('imp_old', 'acme-corp', 'ses_old', 'opencode', 'p/m',
                    'acme-corp/import/imp_old', 100)`;
        const applied = yield* migrate;
        const upgraded = yield* sql<{
          session_created_at: number | null;
        }>`SELECT session_created_at FROM import_sessions`;
        yield* sql`UPDATE import_sessions SET session_created_at = 200
          WHERE import_id = 'imp_old'`;
        return {
          applied,
          upgraded,
          columns: yield* columnsOf(sql, "import_sessions"),
          confirmed: yield* sql<{
            session_created_at: number | null;
          }>`SELECT session_created_at FROM import_sessions`,
        };
      }),
    );

    expect(outcome.applied.map(([id, name]) => `${id}_${name}`)).toEqual([
      "25_import_session_confirmation",
    ]);
    expect(outcome.columns).toContain("session_created_at");
    // Not backfilled: nothing in a 0024 row says the harness ever held the session.
    expect(outcome.upgraded).toEqual([{ session_created_at: null }]);
    expect(outcome.confirmed).toEqual([{ session_created_at: 200 }]);
  });
});
