import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Data, Effect } from "effect";

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly operation: "open" | "query" | "transaction";
  readonly cause: unknown;
}> {}

type Client = ReturnType<typeof drizzle>;
type Transaction = Parameters<Parameters<Client["transaction"]>[0]>[0];
type Synchronous<A> = A extends
  PromiseLike<unknown> | Effect.Effect<unknown, unknown, unknown>
  ? never
  : A;

function syncResult<A>(value: A): A {
  if (
    Effect.isEffect(value) ||
    (value !== null &&
      (typeof value === "object" || typeof value === "function") &&
      "then" in value)
  ) {
    throw new TypeError(
      "Database callbacks must return synchronous values, not Promises or Effects",
    );
  }
  return value;
}

/** Owns one connection until the surrounding Effect scope closes. */
export const openDatabase = (filename: string) =>
  Effect.gen(function* () {
    const sqlite = yield* Effect.acquireRelease(
      Effect.try({
        try: () => new Database(filename, { create: true, strict: true }),
        catch: (cause) => new DatabaseError({ operation: "open", cause }),
      }),
      (connection) => Effect.sync(() => connection.close()),
    );
    const client = yield* Effect.try({
      try: () => {
        sqlite.exec(
          "PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA journal_size_limit = 33554432;",
        );
        return drizzle(sqlite);
      },
      catch: (cause) => new DatabaseError({ operation: "open", cause }),
    });
    return {
      query: <A>(
        run: (db: Client) => A & Synchronous<A>,
      ): Effect.Effect<A, DatabaseError> =>
        Effect.try({
          try: () => syncResult(run(client)),
          catch: (cause) => new DatabaseError({ operation: "query", cause }),
        }),
      transaction: <A>(
        run: (tx: Transaction) => A & Synchronous<A>,
      ): Effect.Effect<A, DatabaseError> =>
        Effect.try({
          // The complete callback executes synchronously inside Drizzle's transaction.
          try: () => client.transaction((tx) => syncResult(run(tx))),
          catch: (cause) =>
            new DatabaseError({ operation: "transaction", cause }),
        }),
    };
  });
