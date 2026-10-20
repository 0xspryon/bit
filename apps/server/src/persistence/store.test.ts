/**
 * Real-SQLite tests for the mutation boundary.
 *
 * Every statement in `store.ts` is executed here against an actual file. That is not
 * belt-and-braces: a misspelled column, a wrong placeholder count, or a `SELECT` that
 * omits a field the result schema needs all compile cleanly and only fail when they run.
 * The result schemas catch the *decode* half — a column returning the wrong type, or
 * JSON that no longer matches the contract — but nothing checks the SQL text itself, so
 * each repository operation is called at least once.
 *
 * One test closes the connection and reopens the same file, because the durability and
 * receipt claims are exactly what an in-memory double would let us get wrong.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RecordObservationInput,
  type Observation,
  type RecordObservationInput as Input,
} from "@bit/contracts";
import { Effect, Schema } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/sql";

import {
  AWKWARD_TEXT,
  SUMMARY_CONDITIONS,
  SUMMARY_OBSERVATION_ID,
  multiCaseInput,
  writeFirstSliceDatabase,
} from "./fixtures";
import {
  MutationError,
  ObservationStore,
  StoredRowError,
  type CallerContext,
} from "./store";
import { DatabaseError, sqliteLayer } from "./sql";

type Store = ObservationStore["Service"];

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true });
  }
});

const newDatabasePath = () => {
  const directory = mkdtempSync(join(tmpdir(), "bit-store-"));
  directories.push(directory);
  return join(directory, "hunt.sqlite");
};

/**
 * Opens a store in its own scope, so a test can close and reopen one file.
 *
 * `Effect.scoped` owns the connection: it closes on success, on failure and on
 * interruption, with no hand-rolled `Scope.make`/`Scope.close` pair and no `as never`.
 */
const withStore = <A, E>(
  path: string,
  use: (store: Store) => Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(ObservationStore, use).pipe(
        Effect.provide(ObservationStore.layer(path)),
      ),
    ),
  );

const CALLER: CallerContext = {
  callerScope: "target-1/attempt-1",
  targetId: "target-1",
  intentId: "intent-1",
  attemptId: "attempt-1",
  harnessSessionId: "ses_abc",
  workerId: "worker-1",
};

const OTHER_CALLER: CallerContext = {
  ...CALLER,
  callerScope: "target-1/attempt-2",
  attemptId: "attempt-2",
};

const seed = (store: Store, attemptId = "attempt-1") =>
  store.seedAttempt({
    targetId: "target-1",
    goalId: "goal-1",
    goal: `Determine whether authentication rate limits can be bypassed. ${AWKWARD_TEXT}`,
    intentId: "intent-1",
    question: "Probe the per-client limiter on POST /login.",
    attemptId,
    workerId: "worker-1",
    providerId: "openai",
    modelId: "gpt-5.6-sol",
    harnessSessionId: null,
  });

const migrated = (store: Store) => seed(store);

describe("automatic store migrations", () => {
  test("both layer constructors expose a ready store and reopening preserves data", async () => {
    const path = newDatabasePath();
    await withStore(path, seed);
    const attempt = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* ObservationStore;
          return yield* store.loadAttempt("attempt-1", "target-1");
        }).pipe(
          Effect.provide(ObservationStore.layerWithClient),
          Effect.provide(sqliteLayer(path)),
        ),
      ),
    );
    expect(attempt?.id).toBe("attempt-1");
  });

  test("a migration failure prevents the consumer from running", async () => {
    const path = newDatabasePath();
    // An incompatible old table makes the real migration's index creation fail.
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE intents (id TEXT PRIMARY KEY)`;
        }).pipe(Effect.provide(sqliteLayer(path))),
      ),
    );
    let consumed = false;
    const result = await Effect.runPromise(
      Effect.result(
        Effect.scoped(
          Effect.gen(function* () {
            yield* ObservationStore;
            consumed = true;
          }).pipe(Effect.provide(ObservationStore.layer(path))),
        ),
      ),
    );
    expect(consumed).toBe(false);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(DatabaseError);
      expect(result.failure.operation).toBe("migrate");
    }
  });
});

/** Narrows to the case-based arm, failing the test rather than silently skipping. */
const caseBased = (observation: Observation | undefined) => {
  expect(observation?._tag).toBe("caseBased");
  if (observation?._tag !== "caseBased") throw new Error("not case-based");
  return observation;
};

describe("recordObservation", () => {
  test("writes one observation with server-derived provenance", async () => {
    const path = newDatabasePath();
    const result = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* migrated(store);
        return yield* store.recordObservation(CALLER, multiCaseInput());
      }),
    );

    expect(result.replayed).toBe(false);
    expect(result.sequence).toBe(1);
    // Provenance comes from the caller context, never from the submitted payload.
    expect(result.provenance).toMatchObject({
      targetId: "target-1",
      intentId: "intent-1",
      attemptId: "attempt-1",
      harnessSessionId: "ses_abc",
      workerId: "worker-1",
    });
  });

  test("an exact retry replays the original result and writes nothing new", async () => {
    const path = newDatabasePath();
    const { first, second, stored, sequence } = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* migrated(store);
        const first = yield* store.recordObservation(CALLER, multiCaseInput());
        const second = yield* store.recordObservation(CALLER, multiCaseInput());
        const stored = yield* store.observationsForIntent("intent-1");
        const sequence = yield* store.currentSequence;
        return { first, second, stored, sequence };
      }),
    );

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.observationId).toBe(first.observationId);
    expect(second.sequence).toBe(first.sequence);
    expect(stored).toHaveLength(1);
    // The sequence must not advance on a replay, or a retry would burn a cursor slot.
    expect(sequence).toBe(1);
  });

  test("reusing an operation ID with different input is rejected as a conflict", async () => {
    const path = newDatabasePath();
    const { failure, stored, sequence } = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* migrated(store);
        yield* store.recordObservation(CALLER, multiCaseInput());
        const failure = yield* Effect.result(
          store.recordObservation(
            CALLER,
            multiCaseInput({
              outcome: "negative",
              testedClaim: "something else entirely",
            }),
          ),
        );
        const stored = yield* store.observationsForIntent("intent-1");
        const sequence = yield* store.currentSequence;
        return { failure, stored, sequence };
      }),
    );

    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") {
      expect(failure.failure).toBeInstanceOf(MutationError);
      expect((failure.failure as MutationError).reason).toBe("conflict");
    }
    // The conflicting call must not have written a second row, and the refusal happens
    // inside the transaction, so the sequence cursor must not have moved either.
    expect(stored).toHaveLength(1);
    expect(sequence).toBe(1);
  });

  test("a changed case alone is enough to count as different input", async () => {
    // The request hash covers the whole payload, so editing one action's observed
    // behaviour under a reused operation ID is a conflict rather than a silent replay.
    const path = newDatabasePath();
    const failure = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* migrated(store);
        const original = multiCaseInput();
        yield* store.recordObservation(CALLER, original);
        const edited: Input = {
          ...original,
          cases: [
            {
              ...original.cases[0],
              actions: [
                {
                  ...original.cases[0].actions[0],
                  observedBehavior: "Something entirely different happened.",
                },
              ],
            },
            ...original.cases.slice(1),
          ] as Input["cases"],
        };
        return yield* Effect.result(store.recordObservation(CALLER, edited));
      }),
    );

    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") {
      expect((failure.failure as MutationError).reason).toBe("conflict");
    }
  });

  test("operation IDs are namespaced per caller, so two workers cannot collide", async () => {
    const path = newDatabasePath();
    const { second, stored } = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* migrated(store);
        yield* seed(store, "attempt-2");
        const first = yield* store.recordObservation(CALLER, multiCaseInput());
        // Same operationId, different authenticated caller: a distinct operation.
        const second = yield* store.recordObservation(
          OTHER_CALLER,
          multiCaseInput(),
        );
        const stored = yield* store.observationsForIntent("intent-1");
        return { first, second, stored };
      }),
    );

    expect(second.replayed).toBe(false);
    expect(second.provenance.attemptId).toBe("attempt-2");
    expect(stored).toHaveLength(2);
  });

  test("sequence is monotonic across many writes", async () => {
    const path = newDatabasePath();
    const sequences = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* migrated(store);
        const collected: number[] = [];
        for (let index = 0; index < 5; index += 1) {
          const result = yield* store.recordObservation(
            CALLER,
            multiCaseInput({ operationId: `op-${index}` }),
          );
          collected.push(result.sequence);
        }
        return collected;
      }),
    );

    expect(sequences).toEqual([1, 2, 3, 4, 5]);
  });

  test("an observation naming an attempt that does not exist is refused", async () => {
    // The foreign keys in the migration are only worth having if they are enforced;
    // `pragmaLayer` is what makes this a refusal rather than an orphan row.
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* migrated(store);
        const failure = yield* Effect.result(
          store.recordObservation(
            { ...CALLER, attemptId: "attempt-never-seeded" },
            multiCaseInput(),
          ),
        );
        const stored = yield* store.observationsForIntent("intent-1");
        const sequence = yield* store.currentSequence;
        return { failure, stored, sequence };
      }),
    );

    expect(outcome.failure._tag).toBe("Failure");
    if (outcome.failure._tag === "Failure") {
      expect(outcome.failure.failure._tag).toBe("DatabaseError");
    }
    expect(outcome.stored).toHaveLength(0);
    // The sequence bump happened before the refused insert, in the same transaction.
    expect(outcome.sequence).toBe(0);
  });
});

describe("multi-case round trip", () => {
  test("cases, actors, relationships and ordered actions survive storage", async () => {
    const path = newDatabasePath();
    const stored = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* migrated(store);
        yield* store.recordObservation(CALLER, multiCaseInput());
        return yield* store.observationsForIntent("intent-1");
      }),
    );

    const observation = caseBased(stored[0]);
    expect(observation.setup).toContain(AWKWARD_TEXT);
    expect(observation.cases.map((item) => item.id)).toEqual([
      "case-saturate",
      "case-rotate",
    ]);

    const saturate = observation.cases[0];
    expect(saturate.actors).toHaveLength(1);
    expect(saturate.actors[0]?.account).toBe("alice");
    expect(saturate.relationships[0]).toEqual({
      subject: "alice",
      relation: "owns",
      object: "session-fixed-a",
    });
    expect(saturate.actions[0]?.requestCount).toBe(11);
    expect(saturate.actions[0]?.observedBehavior).toContain("429 rate_limited");
    expect(saturate.actions[0]?.evidenceRefs).toEqual([
      "transcript://case-saturate",
    ]);

    // Two actors and two actions, in order, each still bound to the actor that acted.
    const rotate = observation.cases[1];
    expect(rotate?.actions.map((action) => action.actorId)).toEqual([
      "rotated",
      "anonymous-probe",
    ]);
    // A null account means unauthenticated; a null role means unknown or not applicable.
    const anonymous = rotate?.actors.find(
      (actor) => actor.id === "anonymous-probe",
    );
    expect(anonymous?.account).toBeNull();
    expect(anonymous?.role).toBeNull();
    // Concurrency is described, not inferred from the ordering.
    expect(rotate?.actions[1]?.description).toContain("concurrently");

    // Observation and interpretation stay in separate fields.
    expect(observation.interpretation).toContain("keys on the header value");
    expect(
      observation.cases.flatMap((item) =>
        item.actions.map((action) => action.observedBehavior),
      ),
    ).not.toContain(observation.interpretation);
  });

  test("outcome round-trips through the contract schema", async () => {
    const path = newDatabasePath();
    const stored = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* migrated(store);
        yield* store.recordObservation(
          CALLER,
          multiCaseInput({ outcome: "inconclusive" }),
        );
        return yield* store.observationsForIntent("intent-1");
      }),
    );

    expect(stored[0]?.outcome).toBe("inconclusive");
  });

  test("observations survive the server going away and coming back", async () => {
    const path = newDatabasePath();

    const written = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* migrated(store);
        const positive = yield* store.recordObservation(
          CALLER,
          multiCaseInput(),
        );
        const negative = yield* store.recordObservation(
          CALLER,
          multiCaseInput({
            operationId: "op-2",
            outcome: "negative",
            testedClaim: "Varying only User-Agent evades the per-client limit.",
          }),
        );
        yield* store.settleAttempt("attempt-1", "succeeded");
        return [positive.observationId, negative.observationId];
      }),
    );

    // Second scope: a brand new connection to the same file, as after a restart.
    const reread = await withStore(path, (store) =>
      Effect.gen(function* () {
        const stored = yield* store.observationsForIntent("intent-1");
        const sequence = yield* store.currentSequence;
        const attempt = yield* store.loadAttempt("attempt-1", "target-1");
        return { stored, sequence, attempt };
      }),
    );

    expect(reread.stored.map((o) => o.observationId)).toEqual(written);
    expect(reread.sequence).toBe(2);
    expect(reread.stored.map((o) => o.outcome)).toEqual([
      "positive",
      "negative",
    ]);
    expect(caseBased(reread.stored[1]).cases).toHaveLength(2);
    expect(reread.attempt?.status).toBe("succeeded");
    expect(reread.attempt?.ended_at).not.toBeNull();
  });

  test("a receipt also survives a restart, so a retry after one is still safe", async () => {
    const path = newDatabasePath();

    await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* migrated(store);
        return yield* store.recordObservation(CALLER, multiCaseInput());
      }),
    );

    const { replay, stored } = await withStore(path, (store) =>
      Effect.gen(function* () {
        const replay = yield* store.recordObservation(CALLER, multiCaseInput());
        const stored = yield* store.observationsForIntent("intent-1");
        return { replay, stored };
      }),
    );

    expect(replay.replayed).toBe(true);
    expect(stored).toHaveLength(1);
  });
});

describe("contract validation", () => {
  const decode = Schema.decodeUnknownResult(RecordObservationInput);
  const base = multiCaseInput();

  const expectRejected = (value: unknown, expected: string): void => {
    const result = decode(value);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.message).toContain(expected);
    }
  };

  test("an empty cases list is refused", () => {
    expectRejected({ ...base, cases: [] }, "cases");
  });

  test("a case with no actions is refused", () => {
    expectRejected(
      { ...base, cases: [{ ...base.cases[0], actions: [] }] },
      "actions",
    );
  });

  test("duplicate case ids are refused", () => {
    expectRejected(
      { ...base, cases: [base.cases[0], { ...base.cases[0] }] },
      "duplicate case ids",
    );
  });

  test("duplicate actor ids within a case are refused", () => {
    expectRejected(
      {
        ...base,
        cases: [
          {
            ...base.cases[0],
            actors: [base.cases[0].actors[0], base.cases[0].actors[0]],
          },
        ],
      },
      "duplicate actor ids",
    );
  });

  test("an action naming an undeclared actor is refused", () => {
    expectRejected(
      {
        ...base,
        cases: [
          {
            ...base.cases[0],
            actions: [{ ...base.cases[0].actions[0], actorId: "ghost" }],
          },
        ],
      },
      'no actor with id "ghost"',
    );
  });

  test("a window that ends before it starts is refused", () => {
    expectRejected(
      {
        ...base,
        cases: [{ ...base.cases[0], windowStart: 5_000, windowEnd: 1_000 }],
      },
      "must not end before it starts",
    );
  });

  test("a non-finite window bound is refused rather than stored", () => {
    expectRejected(
      { ...base, cases: [{ ...base.cases[0], windowStart: Number.NaN }] },
      "windowStart",
    );
  });

  test("a negative request count is refused", () => {
    expectRejected(
      {
        ...base,
        cases: [
          {
            ...base.cases[0],
            actions: [{ ...base.cases[0].actions[0], requestCount: -1 }],
          },
        ],
      },
      "requestCount",
    );
  });

  test("a fractional request count is refused", () => {
    expectRejected(
      {
        ...base,
        cases: [
          {
            ...base.cases[0],
            actions: [{ ...base.cases[0].actions[0], requestCount: 1.5 }],
          },
        ],
      },
      "requestCount",
    );
  });

  test("an empty required string is refused", () => {
    expectRejected({ ...base, setup: "" }, "setup");
    expectRejected({ ...base, testedClaim: "" }, "testedClaim");
    expectRejected(
      { ...base, cases: [{ ...base.cases[0], purpose: "" }] },
      "purpose",
    );
  });

  test("a zero request count is accepted, because a step may send none", () => {
    const result = decode({
      ...base,
      cases: [
        {
          ...base.cases[0],
          actions: [{ ...base.cases[0].actions[0], requestCount: 0 }],
        },
      ],
    });
    expect(result._tag).toBe("Success");
  });

  test("a null account and a null role are accepted", () => {
    const result = decode({
      ...base,
      cases: [
        {
          ...base.cases[0],
          actors: [{ ...base.cases[0].actors[0], account: null, role: null }],
        },
      ],
    });
    expect(result._tag).toBe("Success");
  });
});

describe("summary-format observations", () => {
  test("a first-slice row reads back as summary, unrewritten and labelled", async () => {
    const path = newDatabasePath();
    await writeFirstSliceDatabase(path);

    const stored = await withStore(path, (store) =>
      store.observationsForIntent("intent-per-client-limiter"),
    );

    expect(stored).toHaveLength(1);
    const observation = stored[0];
    expect(observation?._tag).toBe("summary");
    if (observation?._tag !== "summary") return;
    expect(observation.observationId).toBe(SUMMARY_OBSERVATION_ID);
    expect(observation.conditions).toEqual(SUMMARY_CONDITIONS);
    // Nothing invented: the prose naming four identities stays one string, and the
    // request count stays one total.
    expect(observation.conditions.clientIdentity).toContain("rotated-client-c");
    expect(observation.conditions.requestCount).toBe(14);
    expect(observation.observedBehavior).toContain("request 11 returned 429");
    expect(observation.limitations[0]).toContain(AWKWARD_TEXT);
  });

  test("new writes against an upgraded database are case-based, and both formats coexist", async () => {
    const path = newDatabasePath();
    await writeFirstSliceDatabase(path);

    const stored = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* store.recordObservation(
          {
            callerScope: "fixture-local/attempt-summary",
            targetId: "fixture-local",
            intentId: "intent-per-client-limiter",
            attemptId: "attempt-summary",
            harnessSessionId: "ses_new",
            workerId: "worker-1",
          },
          multiCaseInput({ operationId: "op-after-upgrade" }),
        );
        return yield* store.observationsForIntent("intent-per-client-limiter");
      }),
    );

    expect(stored.map((item) => item._tag)).toEqual(["summary", "caseBased"]);
    // The new row takes the next sequence, so the existing cursor was respected.
    expect(stored.map((item) => item.sequence)).toEqual([1, 2]);
  });

  test("the original receipt still replays after the upgrade, so no duplicate is written", async () => {
    // The receipt's stored result names the summary observation. A retry of that
    // operation must replay it rather than write a second row under a reused ID.
    const path = newDatabasePath();
    await writeFirstSliceDatabase(path);

    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        const conflict = yield* Effect.result(
          store.recordObservation(
            {
              callerScope: "fixture-local/attempt-summary",
              targetId: "fixture-local",
              intentId: "intent-per-client-limiter",
              attemptId: "attempt-summary",
              harnessSessionId: "ses_new",
              workerId: "worker-1",
            },
            multiCaseInput({ operationId: "summary-op-1" }),
          ),
        );
        const stored = yield* store.observationsForIntent(
          "intent-per-client-limiter",
        );
        return { conflict, stored };
      }),
    );

    // The old receipt's hash was computed by a build that no longer exists, so the
    // content cannot match: the correct answer is a conflict, not a second write.
    expect(outcome.conflict._tag).toBe("Failure");
    if (outcome.conflict._tag === "Failure") {
      expect((outcome.conflict.failure as MutationError).reason).toBe(
        "conflict",
      );
    }
    expect(outcome.stored).toHaveLength(1);
    expect(outcome.stored[0]?.observationId).toBe(SUMMARY_OBSERVATION_ID);
  });
});

describe("persisted row decoding", () => {
  /** Edits the file behind the store's back, on one connection. */
  const corrupt = async (path: string, ...statements: readonly string[]) => {
    const sqlite = new (await import("bun:sqlite")).Database(path);
    for (const statement of statements) sqlite.run(statement);
    sqlite.close();
  };

  test("a corrupted JSON column is a typed StoredRowError, not a thrown defect", async () => {
    const path = newDatabasePath();
    await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* migrated(store);
        yield* store.recordObservation(CALLER, multiCaseInput());
      }),
    );
    await corrupt(
      path,
      `UPDATE observations SET limitations = '{"not":"a list"}'`,
    );

    const failure = await withStore(path, (store) =>
      Effect.result(store.observationsForIntent("intent-1")),
    );

    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") {
      expect(failure.failure).toBeInstanceOf(StoredRowError);
      expect((failure.failure as StoredRowError).table).toBe("observations");
    }
  });

  test("cases that no longer match the contract are reported, not handed on", async () => {
    // A case array whose action lost its `actorId` would otherwise be returned as a
    // value whose type is a lie.
    const path = newDatabasePath();
    await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* migrated(store);
        yield* store.recordObservation(CALLER, multiCaseInput());
      }),
    );
    await corrupt(path, `UPDATE observations SET cases = '[{"id":"x"}]'`);

    const failure = await withStore(path, (store) =>
      Effect.result(store.observationsForIntent("intent-1")),
    );

    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") {
      expect(failure.failure).toBeInstanceOf(StoredRowError);
    }
  });

  test("a row whose columns contradict its record format is reported by id", async () => {
    const path = newDatabasePath();
    await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* migrated(store);
        yield* store.recordObservation(CALLER, multiCaseInput());
      }),
    );
    // The CHECK stops this happening through the store, so it is forced directly. Both
    // statements have to share one connection: `ignore_check_constraints` is per
    // connection, so setting it and then reconnecting would simply hit the constraint.
    await corrupt(
      path,
      `PRAGMA ignore_check_constraints = ON`,
      `UPDATE observations SET record_format = 'not_a_format'`,
    );

    const failure = await withStore(path, (store) =>
      Effect.result(store.observationsForIntent("intent-1")),
    );

    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") {
      expect(failure.failure).toBeInstanceOf(StoredRowError);
      const error = failure.failure as StoredRowError;
      expect(error.rowId).toContain("obs_000001");
      expect(error.detail).toContain(
        "unknown observation record format not_a_format",
      );
    }
  });

  test("a receipt whose stored result is corrupt fails the replay rather than inventing one", async () => {
    const path = newDatabasePath();
    await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* migrated(store);
        yield* store.recordObservation(CALLER, multiCaseInput());
      }),
    );
    await corrupt(
      path,
      `UPDATE command_receipts SET result = 'not json at all'`,
    );

    const failure = await withStore(path, (store) =>
      Effect.result(store.recordObservation(CALLER, multiCaseInput())),
    );

    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") {
      expect(failure.failure).toBeInstanceOf(StoredRowError);
      expect((failure.failure as StoredRowError).table).toBe(
        "command_receipts",
      );
    }
  });
});

describe("the remaining repository operations", () => {
  test("loadIntent joins the goal, and an unknown intent is undefined", async () => {
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* migrated(store);
        return {
          known: yield* store.loadIntent("intent-1"),
          unknown: yield* store.loadIntent("intent-nope"),
        };
      }),
    );

    expect(outcome.known).toEqual({
      intentId: "intent-1",
      question: "Probe the per-client limiter on POST /login.",
      targetId: "target-1",
      // Joined from `goals`, quotes and all.
      goal: `Determine whether authentication rate limits can be bypassed. ${AWKWARD_TEXT}`,
    });
    expect(outcome.unknown).toBeUndefined();
  });

  test("loadAttempt is scoped to the target, so another target's id does not resolve", async () => {
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* migrated(store);
        return {
          mine: yield* store.loadAttempt("attempt-1", "target-1"),
          theirs: yield* store.loadAttempt("attempt-1", "someone-else"),
        };
      }),
    );

    expect(outcome.mine?.id).toBe("attempt-1");
    expect(outcome.mine?.provider_id).toBe("openai");
    expect(outcome.mine?.harness_session_id).toBeNull();
    expect(outcome.mine?.ended_at).toBeNull();
    expect(outcome.theirs).toBeUndefined();
  });

  test("bindSessionToAttempt and settleAttempt both persist", async () => {
    const path = newDatabasePath();
    const attempt = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* migrated(store);
        yield* store.bindSessionToAttempt("attempt-1", "ses_bound");
        yield* store.settleAttempt("attempt-1", "uncertain");
        return yield* store.loadAttempt("attempt-1", "target-1");
      }),
    );

    expect(attempt?.harness_session_id).toBe("ses_bound");
    expect(attempt?.status).toBe("uncertain");
  });

  test("re-seeding the same attempt is harmless", async () => {
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* migrated(store);
        yield* store.bindSessionToAttempt("attempt-1", "ses_first");
        yield* seed(store);
        return yield* store.loadAttempt("attempt-1", "target-1");
      }),
    );

    // `ON CONFLICT DO NOTHING`, so the bound session is not reset to null.
    expect(outcome?.harness_session_id).toBe("ses_first");
  });

  test("currentSequence is 0 on a database with no observations", async () => {
    const path = newDatabasePath();
    const sequence = await withStore(path, (store) =>
      Effect.flatMap(migrated(store), () => store.currentSequence),
    );
    expect(sequence).toBe(0);
  });

  test("observationsForIntent returns nothing for an intent with no observations", async () => {
    const path = newDatabasePath();
    const stored = await withStore(path, (store) =>
      Effect.flatMap(migrated(store), () =>
        store.observationsForIntent("intent-1"),
      ),
    );
    expect(stored).toEqual([]);
  });
});

describe("recorded time", () => {
  test("recordedAt comes from the Clock, so a test can fix it", async () => {
    // A wall clock would make this a range assertion. Reading time through the `Clock`
    // service instead of `Date.now()` is what makes it an equality.
    const path = newDatabasePath();
    const stored = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* ObservationStore;
          yield* migrated(store);
          yield* TestClock.setTime(1_700_000_000_000);
          yield* store.recordObservation(CALLER, multiCaseInput());
          return yield* store.observationsForIntent("intent-1");
        }).pipe(
          Effect.provide(ObservationStore.layer(path)),
          Effect.provide(TestClock.layer()),
        ),
      ),
    );

    expect(stored[0]?.provenance.recordedAt).toBe(1_700_000_000_000);
  });
});
