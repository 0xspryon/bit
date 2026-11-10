/**
 * Tests both migration chains against real SQLite files.
 *
 * Nothing here checks SQL identifiers or placeholders at compile time, so every statement
 * has to be executed. Each chain has to hold up four ways:
 *
 * 1. A fresh database replays the chain and ends up with **exactly** the schema committed
 *    in `expectedSchema.hunt.txt` / `expectedSchema.control.txt` — every object, column,
 *    index and foreign key.
 * 2. Running it again applies nothing.
 * 3. The constraints the schema carries are constraints the database enforces, not
 *    properties of the statements we happen to have written.
 * 4. A migration that fails leaves neither its schema change nor its journal row, and the
 *    database is still usable afterwards.
 *
 * ## Why (1) exists, and what its absence cost
 *
 * Until the chains were collapsed to baselines there was no such test, and the gap was not
 * theoretical: `0014_attempt_harness_instance` had been inserted into the middle of the old
 * list after databases had recorded id 14 as something else, so the migrator — which skips
 * every entry at or below the highest applied id — never ran it on those files.
 * `attempts.harness_instance_id` was simply missing on a database whose journal reported
 * itself current. 1588 passing tests did not see it, because every one of them either built
 * a fresh file (where the column appears) or asserted a *subset* of the schema. The route
 * that eventually selected the column answered `500`.
 *
 * A full-schema equality check catches that class on the first run, and it catches the
 * ordinary version too: an appended migration whose effect nobody wrote down.
 *
 * **To update an expectation after appending a migration**, run the suite with
 * `BIT_UPDATE_SCHEMA_EXPECTATION=1`; the files are rewritten and the change shows up as a
 * reviewable diff. Never hand-edit them.
 *
 * Nothing here touches `apps/server/.runtime/`. Every test gets a fresh temporary file.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { SqliteMigrator } from "@effect/sql-sqlite-bun";

import { CONTROL_MIGRATIONS, migrateControl } from "./controlMigrations";
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

const tablesOf = (sql: SqlClient.SqlClient) =>
  Effect.map(
    sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'
      ORDER BY name`,
    (rows) => rows.map((row) => row.name),
  );

/**
 * The ids a chain declares, as `[id, name]`, derived rather than written out.
 *
 * Appending an entry therefore does not mean editing a full-chain assertion — the one
 * thing a derived list cannot check is the *effect* of the entries, which is what the
 * schema expectation below is for.
 */
const chainOf = (migrations: Record<string, unknown>) =>
  Object.keys(migrations).map((key) => {
    const match = /^(\d+)_(.+)$/.exec(key);
    if (match === null) throw new Error(`migration key ${key} has no id`);
    return [Number(match[1]), match[2] ?? ""] as const;
  });

const HUNT_CHAIN = chainOf(MIGRATIONS);
const CONTROL_CHAIN = chainOf(CONTROL_MIGRATIONS);
const labelsOf = (chain: ReadonlyArray<readonly [number, string]>) =>
  chain.map(([id, name]) => `${String(id)}_${name}`);

/**
 * An id far above either chain, for the deliberately broken entries.
 *
 * It has to be above every real id or the migrator would skip it (it applies only ids
 * greater than the highest applied), and it must not collide with an id a chain may grow
 * into, which is why it is 99 rather than "one more than the last one".
 */
const BROKEN_ID = "0099";

// ---------------------------------------------------------------------------
// The schema the chain produces, dumped whole and compared to a committed file
// ---------------------------------------------------------------------------

/**
 * Every schema object, column, index column list and foreign key in one text block.
 *
 * Three deliberate choices about what does and does not register as a difference:
 *
 * - `sqlite_master.sql` is normalised to single spaces and compared as text, because a
 *   `CHECK` constraint exists **only** in that text — no pragma reports one — and losing
 *   one silently is exactly what this test must refuse.
 * - Columns are listed **sorted by name**, with type, nullability, default and
 *   primary-key position. Declaration order is not semantically meaningful in SQLite and
 *   is already pinned by the `CREATE TABLE` text above.
 * - Indexes are listed by `pragma_index_xinfo` and foreign keys by
 *   `pragma_foreign_key_list`, so uniqueness, partiality, collation, direction, and the
 *   on-update/on-delete actions are checked structurally rather than through the SQL text
 *   they happen to be spelled in.
 */
const dumpSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const objects = yield* sql<{
    type: string;
    name: string;
    tbl_name: string;
    sql: string | null;
  }>`SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`;
  const out: string[] = [];
  for (const object of objects) {
    out.push(`## ${object.type} ${object.name} (on ${object.tbl_name})`);
    out.push((object.sql ?? "").replace(/\s+/g, " ").trim());
  }
  const tables = objects
    .filter((object) => object.type === "table")
    .map((object) => object.name)
    .sort();
  for (const table of tables) {
    const columns = yield* sql<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>`SELECT name, type, "notnull", dflt_value, pk
         FROM pragma_table_info(${table}) ORDER BY name`;
    out.push(`## columns ${table}`);
    for (const column of columns) {
      out.push(
        `  ${column.name} ${column.type} notnull=${String(column.notnull)}` +
          ` default=${column.dflt_value ?? "-"} pk=${String(column.pk)}`,
      );
    }
  }
  for (const table of tables) {
    const indexes = yield* sql<{
      name: string;
      unique: number;
      origin: string;
      partial: number;
    }>`SELECT name, "unique", origin, partial
         FROM pragma_index_list(${table}) ORDER BY name`;
    const foreignKeys = yield* sql<{
      table: string;
      from: string;
      to: string | null;
      on_update: string;
      on_delete: string;
      match: string;
    }>`SELECT "table", "from", "to", on_update, on_delete, "match"
         FROM pragma_foreign_key_list(${table})
         ORDER BY "table", "from", "to"`;
    if (indexes.length === 0 && foreignKeys.length === 0) continue;
    out.push(`## structure ${table}`);
    for (const index of indexes) {
      const columns = yield* sql<{
        name: string | null;
        desc: number;
        coll: string;
        key: number;
      }>`SELECT name, desc, coll, key FROM pragma_index_xinfo(${index.name})
           ORDER BY seqno`;
      out.push(
        `  index ${index.name} unique=${String(index.unique)}` +
          ` origin=${index.origin} partial=${String(index.partial)} cols=` +
          columns
            .map(
              (column) =>
                `${column.name ?? "rowid"}/${column.desc === 1 ? "desc" : "asc"}` +
                `/${column.coll}/${column.key === 1 ? "key" : "incl"}`,
            )
            .join("|"),
      );
    }
    for (const key of foreignKeys) {
      out.push(
        `  fk ${key.from} -> ${key.table}.${key.to ?? "rowid"}` +
          ` update=${key.on_update} delete=${key.on_delete} match=${key.match}`,
      );
    }
  }
  return `${out.join("\n")}\n`;
});

const expectationPath = (name: string) =>
  join(import.meta.dir, `expectedSchema.${name}.txt`);

/**
 * Replays one chain into a fresh file and compares its whole schema to the committed dump.
 *
 * The migrator's journal table is part of the dump — its *shape* is, not its rows, which
 * are the one thing about a collapsed chain that is deliberately different from what the
 * old one left behind.
 */
const expectSchemaMatches = async (
  name: string,
  chain: Effect.Effect<unknown, DatabaseError, SqlClient.SqlClient>,
) => {
  const actual = await withSql(newDatabasePath(), () =>
    Effect.flatMap(chain, () => dumpSchema),
  );
  if (process.env["BIT_UPDATE_SCHEMA_EXPECTATION"] === "1") {
    writeFileSync(expectationPath(name), actual);
  }
  expect(actual).toBe(readFileSync(expectationPath(name), "utf8"));
};

describe("the schema a fresh replay produces", () => {
  test("the hunt chain matches the committed expectation exactly", async () => {
    await expectSchemaMatches("hunt", migrate);
  });

  test("the control chain matches the committed expectation exactly", async () => {
    await expectSchemaMatches("control", migrateControl);
  });

  test("a second replay changes nothing about the schema", async () => {
    // The property the equality test above cannot see on its own: it builds one file and
    // migrates once. A migration that is not idempotent across runs — a bare `ALTER TABLE`
    // the migrator did get round to skipping, say — would show up here and nowhere else.
    const path = newDatabasePath();
    const first = await withSql(path, () =>
      Effect.flatMap(migrate, () => dumpSchema),
    );
    const second = await withSql(path, () =>
      Effect.flatMap(migrate, () => dumpSchema),
    );
    expect(second).toBe(first);
  });
});

describe("a fresh database", () => {
  test("replays the whole chain and reports what it applied", async () => {
    const outcome = await withSql(newDatabasePath(), (sql) =>
      Effect.gen(function* () {
        const applied = yield* migrate;
        return {
          applied,
          journal: yield* journalOf(sql),
          tables: yield* tablesOf(sql),
        };
      }),
    );

    expect(outcome.applied.map(([id, name]) => `${id}_${name}`)).toEqual(
      labelsOf(HUNT_CHAIN),
    );
    // Guards against a key being added to the record but never reaching the loader, and
    // against the loader silently skipping a malformed key.
    expect(outcome.journal.map((row) => row.migration_id)).toEqual(
      HUNT_CHAIN.map(([id]) => id),
    );
    expect(outcome.journal).toHaveLength(Object.keys(MIGRATIONS).length);
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
  });

  test("the control chain builds the registry and nothing of the graph", async () => {
    const outcome = await withSql(newDatabasePath(), (sql) =>
      Effect.gen(function* () {
        const applied = yield* migrateControl;
        return { applied, tables: yield* tablesOf(sql) };
      }),
    );

    expect(outcome.applied.map(([id, name]) => `${id}_${name}`)).toEqual(
      labelsOf(CONTROL_CHAIN),
    );
    // The two chains must never meet in one file: this one assumes the registry and the
    // other assumes the graph, and a file holding both would be a third thing.
    expect(outcome.tables).toEqual([
      "effect_sql_migrations",
      "settings",
      "target_schema_state",
      "targets",
    ]);
  });
});

describe("a database that is already current", () => {
  test("re-running either chain applies nothing", async () => {
    const hunt = newDatabasePath();
    const first = await withSql(hunt, () => migrate);
    const second = await withSql(hunt, () => migrate);
    const third = await withSql(hunt, (sql) =>
      Effect.gen(function* () {
        const applied = yield* migrate;
        return { applied, journal: yield* journalOf(sql) };
      }),
    );
    const control = newDatabasePath();
    await withSql(control, () => migrateControl);
    const controlAgain = await withSql(control, () => migrateControl);

    expect(first).toHaveLength(Object.keys(MIGRATIONS).length);
    expect(second).toEqual([]);
    expect(third.applied).toEqual([]);
    expect(third.journal.map((row) => row.migration_id)).toEqual(
      HUNT_CHAIN.map(([id]) => id),
    );
    expect(controlAgain).toEqual([]);
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

/**
 * The constraints the baseline carries, each checked for what it *refuses*.
 *
 * A `CHECK`, a `UNIQUE` or a trigger is only worth declaring if the database enforces it
 * against a hand-rolled statement that never went through the store. That is the whole
 * point of putting them in the schema rather than in a handler, so it is what is asserted.
 */
describe("what the schema refuses", () => {
  /** A goal, an intent and a running attempt, which most inserts below hang off. */
  const seedGraph = (sql: SqlClient.SqlClient) =>
    Effect.gen(function* () {
      yield* sql`INSERT INTO goals (id, target_id, description, created_at)
        VALUES ('g', 't', 'g', 1)`;
      yield* sql`INSERT INTO intents (id, goal_id, target_id, question, created_at)
        VALUES ('i', 'g', 't', 'q', 1)`;
      yield* sql`INSERT INTO attempts (id, intent_id, target_id, worker_id,
          provider_id, model_id, status, started_at)
        VALUES ('a', 'i', 't', 'w', 'p', 'm', 'running', 1)`;
    });

  test("an observation cannot claim both record formats at once", async () => {
    // The only thing standing between a hand-rolled insert and a row that is a case-based
    // and a summary observation at the same time.
    const refused = await withSql(newDatabasePath(), (sql) =>
      Effect.gen(function* () {
        yield* migrate;
        yield* seedGraph(sql);
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

  test("an intent cannot declare a dimension no row holds", async () => {
    // `intents.addresses_dimension` is a **forward reference** in the baseline:
    // `observation_dimensions` is created after `intents`, because it references
    // `observations`, which references `intents`. SQLite resolves a foreign key at DML
    // time, so this is what proves the cycle left a live constraint rather than a dead
    // clause nothing checks.
    const outcome = await withSql(newDatabasePath(), (sql) =>
      Effect.gen(function* () {
        yield* migrate;
        yield* seedGraph(sql);
        const refused = yield* Effect.result(
          sql`INSERT INTO intents (id, goal_id, target_id, question, created_at,
                addresses_dimension)
              VALUES ('i2', 'g', 't', 'q', 2, 'dim_nope')`,
        );
        const accepted = yield* Effect.result(
          sql`INSERT INTO intents (id, goal_id, target_id, question, created_at,
                addresses_dimension)
              VALUES ('i3', 'g', 't', 'q', 3, NULL)`,
        );
        return { refused: refused._tag, accepted: accepted._tag };
      }),
    );

    // Null is the ordinary case and means only that the intent did not say.
    expect(outcome.accepted).toBe("Success");
    expect(outcome.refused).toBe("Failure");
  });

  test("a planner lineage takes a goal that exists and refuses one that does not", async () => {
    // `goal_id` is a real foreign key where a target id would have been a bare column,
    // because a goal is ours and a target folder is not.
    const outcome = await withSql(newDatabasePath(), (sql) =>
      Effect.gen(function* () {
        yield* migrate;
        yield* seedGraph(sql);
        const accepted = yield* Effect.result(
          sql`INSERT INTO planner_lineages (goal_id, harness_session_id, created_at)
            VALUES ('g', 'ses_lineage', 200)`,
        );
        const refused = yield* Effect.result(
          sql`INSERT INTO planner_lineages (goal_id, harness_session_id, created_at)
            VALUES ('goal_absent', 'ses_orphan', 201)`,
        );
        return { accepted: accepted._tag, refused: refused._tag };
      }),
    );

    expect(outcome.accepted).toBe("Success");
    expect(outcome.refused).toBe("Failure");
  });

  test("a recovery record is identified by its whole reconciliation state", async () => {
    // The key is `(attempt_id, observed_status, prior_status, resulting_status,
    // disposition, fence_before, fence_after)`. A narrower one conflates dispositions: a
    // pass that settles a running attempt and a later pass that finds it already final
    // agree on the observed and the resulting status while deciding different things.
    const insert = (
      sql: SqlClient.SqlClient,
      prior: string,
      disposition: string,
      fenceBefore: number,
      at: number,
    ) =>
      Effect.result(
        sql`INSERT INTO attempt_recoveries (
            attempt_id, observed_status, prior_status, resulting_status, disposition,
            detail, harness_session_id, fence_before, fence_after,
            observations_at_recovery, first_reconciled_at, last_reconciled_at, times
          ) VALUES ('a', 'succeeded', ${prior}, 'succeeded', ${disposition},
            ${`${disposition} detail`}, 'ses', ${fenceBefore}, 1, 0, ${at}, ${at}, 1)`,
      );

    const outcome = await withSql(newDatabasePath(), (sql) =>
      Effect.gen(function* () {
        yield* migrate;
        yield* seedGraph(sql);
        const settled = yield* insert(sql, "running", "settled", 0, 100);
        // Same attempt, same observed status, same resulting status, different decision:
        // this is the row a three-column key would have landed on top of the first.
        const alongside = yield* insert(
          sql,
          "succeeded",
          "already_final",
          1,
          200,
        );
        // And the identity still has to be an identity.
        const duplicate = yield* insert(sql, "running", "settled", 0, 300);
        return {
          settled: settled._tag,
          alongside: alongside._tag,
          duplicate,
          // `rowid` order is "the order first seen", which is what
          // `recoveriesForAttempt` reads: two reconciliations in the same millisecond
          // are ordinary and a timestamp cannot order them.
          rows: yield* sql<{
            prior_status: string;
            disposition: string;
          }>`SELECT prior_status, disposition FROM attempt_recoveries ORDER BY rowid`,
        };
      }),
    );

    expect(outcome.settled).toBe("Success");
    expect(outcome.alongside).toBe("Success");
    expect(outcome.duplicate._tag).toBe("Failure");
    if (outcome.duplicate._tag === "Failure") {
      expect(outcome.duplicate.failure.reason._tag).toBe("ConstraintError");
    }
    expect(
      outcome.rows.map((row) => [row.prior_status, row.disposition]),
    ).toEqual([
      ["running", "settled"],
      ["succeeded", "already_final"],
    ]);
  });

  test("an asset whose columns contradict its kind is refused, and identity is per target", async () => {
    const outcome = await withSql(newDatabasePath(), (sql) =>
      Effect.gen(function* () {
        yield* migrate;
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
    // The `CHECK` is what stops a row claiming to be a host with a method, or an endpoint
    // without one, whatever a handler believes it is writing.
    expect(outcome.hostWithMethod).toBe("Failure");
    expect(outcome.endpointWithoutMethod).toBe("Failure");
    // Identity is unique within a target and kind, which is where the domain merge
    // happens — and it does not reach across targets, which it must not.
    expect(outcome.duplicateIdentity).toBe("Failure");
    expect(outcome.otherTargetSameIdentity).toBe("Success");
  });

  test("a recorded event is immutable and undeletable in the database", async () => {
    const outcome = await withSql(newDatabasePath(), (sql) =>
      Effect.gen(function* () {
        yield* migrate;
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

  test("the outbox refuses an unknown status, an unknown policy and an orphan request", async () => {
    const outcome = await withSql(newDatabasePath(), (sql) =>
      Effect.gen(function* () {
        yield* migrate;
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

  test("an import session takes only the five end reasons, and null", async () => {
    const outcome = await withSql(newDatabasePath(), (sql) =>
      Effect.gen(function* () {
        yield* migrate;
        yield* sql`INSERT INTO import_sessions (
            import_id, target_id, harness_session_id, harness_instance_id, model,
            caller_scope, opened_at, session_created_at, ended_at, ended_reason
          ) VALUES ('imp_1', 'acme-corp', 'ses_1', 'opencode', 'p/m',
                    'acme-corp/import/imp_1', 100, 150, 300, 'shutdown')`;
        // Null passes the `CHECK`, which is the open row.
        const open = yield* Effect.result(
          sql`INSERT INTO import_sessions (
              import_id, target_id, harness_session_id, model, caller_scope, opened_at
            ) VALUES ('imp_2', 'acme-corp', 'ses_2', 'p/m',
                      'acme-corp/import/imp_2', 400)`,
        );
        const unknown = yield* Effect.result(
          sql`UPDATE import_sessions SET ended_reason = 'crashed'
            WHERE import_id = 'imp_1'`,
        );
        // `0004`: a session whose harness process had ended on its own.
        const gone = yield* Effect.result(
          sql`INSERT INTO import_sessions (
              import_id, target_id, harness_session_id, model, caller_scope, opened_at,
              ended_at, ended_reason
            ) VALUES ('imp_4', 'acme-corp', 'ses_4', 'p/m',
                      'acme-corp/import/imp_4', 600, 700, 'process_gone')`,
        );
        // The row is written before the session exists, so an empty session id would be
        // a row naming nothing.
        const emptySession = yield* Effect.result(
          sql`INSERT INTO import_sessions (
              import_id, target_id, harness_session_id, model, caller_scope, opened_at
            ) VALUES ('imp_3', 'acme-corp', '', 'p/m',
                      'acme-corp/import/imp_3', 500)`,
        );
        return {
          open: open._tag,
          unknown: unknown._tag,
          gone: gone._tag,
          emptySession: emptySession._tag,
          rows: yield* sql<{
            import_id: string;
            ended_reason: string | null;
          }>`SELECT import_id, ended_reason FROM import_sessions
               ORDER BY import_id`,
        };
      }),
    );

    expect(outcome.open).toBe("Success");
    expect(outcome.unknown).toBe("Failure");
    expect(outcome.gone).toBe("Success");
    expect(outcome.emptySession).toBe("Failure");
    expect(outcome.rows).toEqual([
      { import_id: "imp_1", ended_reason: "shutdown" },
      { import_id: "imp_2", ended_reason: null },
      { import_id: "imp_4", ended_reason: "process_gone" },
    ]);
  });

  test("0004 carries every import session row of a 0003 database across, column for column", async () => {
    const path = newDatabasePath();
    const before = Object.fromEntries(
      Object.entries(MIGRATIONS).filter(([key]) => Number(key.slice(0, 4)) < 4),
    );
    const upTo3 = await runChain(path, SqliteMigrator.fromRecord(before));
    expect(upTo3._tag).toBe("Success");
    const outcome = await withSql(path, (sql) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO import_sessions (
            import_id, target_id, harness_session_id, harness_instance_id, model,
            caller_scope, opened_at, session_created_at, ended_at, ended_reason,
            model_options, pages, agent_id
          ) VALUES ('imp_1', 'acme-corp', 'ses_1', 'pi', 'p/m',
                    'acme-corp/import/imp_1', 100, 150, 300, 'refused',
                    '{"effort":"high"}', '["https://a.example"]', 'importer'),
                   ('imp_2', 'acme-corp', 'ses_1', NULL, 'p/m',
                    'acme-corp/import/imp_2', 400, NULL, NULL, NULL,
                    NULL, NULL, 'importer')`;
        const all = sql<Record<string, unknown>>`SELECT * FROM import_sessions
          ORDER BY import_id`;
        const was = yield* all;
        const applied = yield* migrate;
        const now = yield* all;
        // The old `CHECK` refused it; the rebuilt table takes it.
        yield* sql`UPDATE import_sessions SET ended_at = 500,
            ended_reason = 'process_gone' WHERE import_id = 'imp_2'`;
        return {
          applied,
          was,
          now,
          left: yield* tablesOf(sql),
          ended: yield* sql<{
            ended_reason: string | null;
          }>`SELECT ended_reason FROM import_sessions WHERE import_id = 'imp_2'`,
          index: yield* sql<{
            name: string;
          }>`SELECT name FROM sqlite_master WHERE type = 'index'
               AND tbl_name = 'import_sessions' AND sql IS NOT NULL`,
        };
      }),
    );
    expect(outcome.applied).toEqual([[4, "import_session_process_gone"]]);
    expect(outcome.now).toEqual(outcome.was);
    expect(outcome.was.length).toBe(2);
    expect(outcome.left).not.toContain("import_sessions_0003");
    expect(outcome.ended).toEqual([{ ended_reason: "process_gone" }]);
    expect(outcome.index).toEqual([{ name: "import_sessions_target_idx" }]);
  });

  test("the control registry holds its per-target state to two values", async () => {
    const outcome = await withSql(newDatabasePath(), (sql) =>
      Effect.gen(function* () {
        yield* migrateControl;
        yield* sql`INSERT INTO targets (id, name, scope_note, created_at)
          VALUES ('acme-corp', 'Acme', 'a note', 1)`;
        const ready = yield* Effect.result(
          sql`INSERT INTO target_schema_state (target_id, state, applied_through,
                detail, checked_at)
              VALUES ('acme-corp', 'ready', 1, '', 2)`,
        );
        const nonsense = yield* Effect.result(
          sql`UPDATE target_schema_state SET state = 'probably_fine'
            WHERE target_id = 'acme-corp'`,
        );
        const orphan = yield* Effect.result(
          sql`INSERT INTO target_schema_state (target_id, state, applied_through,
                detail, checked_at)
              VALUES ('no-such-target', 'ready', 1, '', 2)`,
        );
        return {
          ready: ready._tag,
          nonsense: nonsense._tag,
          orphan: orphan._tag,
          // Nullable, and null is the honest state of a target with no operator-chosen
          // folder — including the one `main.ts` registers to serve a fixture.
          workspace: yield* sql<{
            workspace_path: string | null;
          }>`SELECT workspace_path FROM targets`,
        };
      }),
    );

    expect(outcome.ready).toBe("Success");
    expect(outcome.nonsense).toBe("Failure");
    expect(outcome.orphan).toBe("Failure");
    expect(outcome.workspace).toEqual([{ workspace_path: null }]);
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

  /** A goal and one observation, so a rollback has rows it could have destroyed. */
  const seedRows = (sql: SqlClient.SqlClient) =>
    Effect.gen(function* () {
      yield* sql`INSERT INTO goals (id, target_id, description, created_at)
        VALUES ('g', 't', 'the goal', 1)`;
      yield* sql`INSERT INTO intents (id, goal_id, target_id, question, created_at)
        VALUES ('i', 'g', 't', 'q', 1)`;
      yield* sql`INSERT INTO attempts (id, intent_id, target_id, worker_id,
          provider_id, model_id, status, started_at)
        VALUES ('a', 'i', 't', 'w', 'p', 'm', 'running', 1)`;
      yield* sql`INSERT INTO observations (
          id, sequence, record_format, target_id, intent_id, attempt_id,
          harness_session_id, worker_id, tested_claim, outcome, interpretation,
          limitations, untested_dimensions, recorded_at,
          summary_conditions, summary_observed_behavior, summary_evidence_refs
        ) VALUES ('obs_1', 1, 'summary', 't', 'i', 'a', 's', 'w', 'c', 'positive',
          'r', '[]', '[]', 1, '{}', 'seen', '[]')`;
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
    await withSql(path, (sql) => Effect.flatMap(migrate, () => seedRows(sql)));

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
    expect(after.journal.map((row) => row.migration_id)).toEqual(
      HUNT_CHAIN.map(([id]) => id),
    );
    expect(after.columns).not.toContain("half_applied");
    // The migration that had already succeeded is untouched, data included.
    expect(after.columns).toContain("record_format");
    expect(after.rows.map((row) => row.id)).toEqual(["obs_1"]);
  });

  test("rolls back the whole run when the failing migration is in the first batch", async () => {
    // Worth stating explicitly, because it is not what a per-migration transaction would
    // do: the migrator wraps the *entire* run in one transaction
    // (`effect/src/sql/Migrator.ts:321`), so a fresh database whose first migrate call
    // hits a bad migration is left completely empty rather than half-built. With one
    // baseline entry that is also the only shape a failure can take on a fresh file.
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
    await withSql(path, (sql) => Effect.flatMap(migrate, () => seedRows(sql)));
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

    // Only the corrected migration is outstanding; the baseline is not re-applied, which
    // matters more here than it did under a long chain: re-running it would try to create
    // every table a second time.
    expect(recovered.applied.map(([id]) => id)).toEqual([Number(BROKEN_ID)]);
    expect(recovered.journal.map((row) => row.migration_id)).toEqual([
      ...HUNT_CHAIN.map(([id]) => id),
      Number(BROKEN_ID),
    ]);
    expect(recovered.columns).toContain("half_applied");
    expect(recovered.rows.map((row) => row.id)).toEqual(["obs_1"]);
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
