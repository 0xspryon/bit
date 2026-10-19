import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Effect } from "effect";
import { DatabaseError, openDatabase } from "./database";

const entries = sqliteTable("entries", {
  id: integer("id").primaryKey(),
  name: text("name").notNull().unique(),
});

test("commits survive reopening; a constraint failure rolls back every write", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bit-sqlite-"));
  const filename = join(directory, "test.sqlite");
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const database = yield* openDatabase(filename);
          yield* database.query((db) =>
            db.run(
              sql`CREATE TABLE entries (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)`,
            ),
          );
          const inserted = yield* database.transaction((tx) => {
            tx.insert(entries).values({ id: 1, name: "committed" }).run();
            return tx.select().from(entries).all();
          });
          expect(inserted).toEqual([{ id: 1, name: "committed" }]);

          const error = yield* database
            .transaction((tx) => {
              tx.insert(entries)
                .values({ id: 2, name: "must roll back" })
                .run();
              tx.insert(entries).values({ id: 3, name: "committed" }).run();
            })
            .pipe(Effect.flip);
          expect(error).toBeInstanceOf(DatabaseError);
          expect(error.operation).toBe("transaction");
          expect(error.cause).toBeDefined();
          expect(
            yield* database.query((db) => db.select().from(entries).all()),
          ).toEqual(inserted);
        }),
      ),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const database = yield* openDatabase(filename);
          expect(
            yield* database.query((db) => db.select().from(entries).all()),
          ).toEqual([{ id: 1, name: "committed" }]);
        }),
      ),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("connection is closed on scope exit", async () => {
  const database = await Effect.runPromise(
    Effect.scoped(openDatabase(":memory:")),
  );
  const error = await Effect.runPromise(
    database.query((db) => db.get(sql`SELECT 1`)).pipe(Effect.flip),
  );
  expect(error).toBeInstanceOf(DatabaseError);
  expect(error.operation).toBe("query");
});

// These compile-time checks ensure async work cannot silently escape a transaction.
function synchronousContract(
  database: Effect.Success<ReturnType<typeof openDatabase>>,
) {
  // @ts-expect-error Promises cannot be returned from synchronous callbacks.
  database.transaction(async () => 1);
  // @ts-expect-error Effects cannot be returned from synchronous callbacks.
  database.transaction(() => Effect.succeed(1));
}
void synchronousContract;
