/**
 * Tests the `effect/sql` connection itself against real SQLite files.
 *
 * These are the claims the store's correctness rests on and that no amount of
 * TypeScript can establish: that the pragmas actually applied, that `REFERENCES` is
 * enforced rather than decorative, that a failed transaction leaves nothing behind, that
 * values arrive as bound parameters, and that the connection dies with its scope.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Fiber, Latch } from "effect";
import { SqlClient } from "effect/sql";

import { AWKWARD_TEXT } from "./fixtures";
import { DatabaseError, currentPragmas, sqliteLayer } from "./sql";

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true });
  }
});

const newDatabasePath = () => {
  const directory = mkdtempSync(join(tmpdir(), "bit-sql-"));
  directories.push(directory);
  return join(directory, "test.sqlite");
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

test("the pragmas the schema depends on are actually in force", async () => {
  // The driver sets busy_timeout and WAL; `pragmaLayer` sets the other two. Asserting
  // the live connection rather than the call that configured it is the point: a pragma
  // that failed to apply is invisible until a constraint quietly stops being enforced.
  const pragmas = await withSql(newDatabasePath(), () => currentPragmas);

  expect(pragmas.foreignKeys).toBe(1);
  expect(pragmas.journalMode).toBe("wal");
  expect(pragmas.busyTimeout).toBe(5_000);
  expect(pragmas.journalSizeLimit).toBe(33_554_432);
});

test("a foreign key violation is a typed failure, not an accepted row", async () => {
  const path = newDatabasePath();
  const outcome = await withSql(path, (sql) =>
    Effect.gen(function* () {
      yield* sql`CREATE TABLE parent (id TEXT PRIMARY KEY)`;
      yield* sql`CREATE TABLE child (
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL REFERENCES parent(id)
      )`;
      const refused = yield* Effect.result(
        sql`INSERT INTO child (id, parent_id) VALUES ('c1', 'no-such-parent')`,
      );
      const rows = yield* sql<{ id: string }>`SELECT id FROM child`;
      return { refused, rows };
    }),
  );

  expect(outcome.refused._tag).toBe("Failure");
  if (outcome.refused._tag === "Failure") {
    expect(outcome.refused.failure.reason._tag).toBe("ConstraintError");
  }
  expect(outcome.rows).toHaveLength(0);
});

test("values reach SQLite as bound parameters, including quotes and statement breaks", async () => {
  // Stored and read back unchanged, and the table it tries to drop is still there.
  const path = newDatabasePath();
  const outcome = await withSql(path, (sql) =>
    Effect.gen(function* () {
      yield* sql`CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)`;
      yield* sql`INSERT INTO notes (id, body) VALUES (1, ${AWKWARD_TEXT})`;
      const rows = yield* sql<{ body: string }>`
        SELECT body FROM notes WHERE body = ${AWKWARD_TEXT}`;
      const tables = yield* sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notes'`;
      return { rows, tables };
    }),
  );

  expect(outcome.rows).toHaveLength(1);
  expect(outcome.rows[0]?.body).toBe(AWKWARD_TEXT);
  expect(outcome.tables).toHaveLength(1);
});

test("a failed transaction commits none of its statements", async () => {
  const path = newDatabasePath();
  const outcome = await withSql(path, (sql) =>
    Effect.gen(function* () {
      yield* sql`CREATE TABLE entries (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE
      )`;
      yield* sql`INSERT INTO entries (id, name) VALUES (1, 'committed')`;

      const rolled = yield* Effect.result(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO entries (id, name) VALUES (2, 'must roll back')`;
            // Duplicate of row 1: the unique index refuses it and the whole
            // transaction goes, including the insert that had already succeeded.
            yield* sql`INSERT INTO entries (id, name) VALUES (3, 'committed')`;
          }),
        ),
      );
      const rows = yield* sql<{
        id: number;
      }>`SELECT id FROM entries ORDER BY id`;
      return { rolled, rows };
    }),
  );

  expect(outcome.rolled._tag).toBe("Failure");
  expect(outcome.rows.map((row) => row.id)).toEqual([1]);
});

test("an interrupted transaction body also rolls back", async () => {
  // Interruption is not a typed failure, so this has to be a real interrupt of a real
  // fiber rather than `Effect.result` over `Effect.interrupt`. The transaction's body is
  // interruptible by design; its commit and rollback are not.
  const path = newDatabasePath();
  const rows = await withSql(path, (sql) =>
    Effect.gen(function* () {
      yield* sql`CREATE TABLE entries (id INTEGER PRIMARY KEY)`;
      const started = yield* Latch.make();
      const fiber = yield* Effect.forkChild(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO entries (id) VALUES (1)`;
            yield* started.open;
            yield* Effect.never;
          }),
        ),
      );
      yield* started.await;
      yield* Fiber.interrupt(fiber);
      return yield* sql<{ id: number }>`SELECT id FROM entries`;
    }),
  );

  expect(rows).toHaveLength(0);
});

test("committed rows survive the connection going away and coming back", async () => {
  const path = newDatabasePath();
  await withSql(path, (sql) =>
    Effect.gen(function* () {
      yield* sql`CREATE TABLE entries (id INTEGER PRIMARY KEY, body TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries (id, body) VALUES (1, ${AWKWARD_TEXT})`;
    }),
  );

  const rows = await withSql(path, (sql) =>
    Effect.gen(function* () {
      return yield* sql<{ body: string }>`SELECT body FROM entries`;
    }),
  );

  expect(rows.map((row) => row.body)).toEqual([AWKWARD_TEXT]);
});

test("the connection is closed when its scope closes", async () => {
  // Holding the client past its scope must not leave a usable handle on the file.
  const sql = await Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(SqlClient.SqlClient, Effect.succeed).pipe(
        Effect.provide(sqliteLayer(newDatabasePath())),
      ),
    ),
  );

  const failure = await Effect.runPromise(Effect.result(sql`SELECT 1 AS one`));
  expect(failure._tag).toBe("Failure");
});

test("a path that cannot be opened is a typed DatabaseError", async () => {
  const failure = await Effect.runPromise(
    Effect.result(
      Effect.scoped(
        Effect.flatMap(SqlClient.SqlClient, Effect.succeed).pipe(
          Effect.provide(
            sqliteLayer(
              join(newDatabasePath(), "no", "such", "dir", "x.sqlite"),
            ),
          ),
        ),
      ),
    ),
  );

  expect(failure._tag).toBe("Failure");
  if (failure._tag === "Failure") {
    expect(failure.failure).toBeInstanceOf(DatabaseError);
    expect((failure.failure as DatabaseError).operation).toBe("open");
  }
});
