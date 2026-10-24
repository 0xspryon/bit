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
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RecordObservationInput,
  dimensionAddress,
  dimensionsOf,
  parseDimensionAddress,
  unknownNumber,
  unknownString,
  type Observation,
  type RecordObservationInput as Input,
} from "@bit/contracts";
import { Effect, Schema } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/sql";

import {
  AWKWARD_TEXT,
  RUNNING_ATTEMPT_ID,
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
  // The fence a credential minted against a freshly seeded attempt carries.
  attemptFence: 0,
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

  test("an observation naming an attempt that does not exist is refused as unauthorized", async () => {
    // The authority check reaches this before the foreign key does, and says something
    // more useful: an unregistered attempt is a caller problem, not a storage fault.
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
      expect(outcome.failure.failure).toBeInstanceOf(MutationError);
      expect((outcome.failure.failure as MutationError).reason).toBe(
        "unauthorized",
      );
    }
    expect(outcome.stored).toHaveLength(0);
    // Refused before the sequence was touched, so no gap is burned on a rejected call.
    expect(outcome.sequence).toBe(0);
  });

  test("the foreign key still backs the authority check", async () => {
    // Belt and braces, and worth proving separately: the authority check is what a
    // caller sees, but `pragmaLayer`'s `foreign_keys = ON` is what makes an orphan
    // observation impossible even for a statement that bypassed it.
    const path = newDatabasePath();
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* ObservationStore;
          yield* migrated(store);
          const sql = yield* SqlClient.SqlClient;
          return yield* Effect.result(
            sql`INSERT INTO observations (
              id, sequence, record_format, target_id, intent_id, attempt_id,
              harness_session_id, worker_id, tested_claim, outcome, interpretation,
              limitations, untested_dimensions, recorded_at, setup, cases,
              summary_conditions, summary_observed_behavior, summary_evidence_refs
            ) VALUES ('orphan', 99, 'case_based', 'target-1', 'intent-1',
              'attempt-never-seeded', 's', 'w', 'c', 'positive', 'i', '[]', '[]', 1,
              'setup', '[]', NULL, NULL, NULL)`,
          );
        }).pipe(
          Effect.provide(ObservationStore.layerWithClient),
          Effect.provide(sqliteLayer(path)),
        ),
      ),
    );

    expect(outcome._tag).toBe("Failure");
    if (outcome._tag === "Failure") {
      expect(outcome.failure.reason._tag).toBe("ConstraintError");
    }
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
            // The adopted database's *running* attempt. `attempt-summary` is settled,
            // and a settled attempt is exactly what the authority check must refuse.
            callerScope: `fixture-local/${RUNNING_ATTEMPT_ID}`,
            targetId: "fixture-local",
            intentId: "intent-per-client-limiter",
            attemptId: RUNNING_ATTEMPT_ID,
            harnessSessionId: "ses_new",
            workerId: "worker-1",
            attemptFence: 0,
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
              attemptFence: 0,
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

  test("counts answer for the file they are read on, before and after a write", async () => {
    // The statement behind the hunt view's header. Seven scalar subqueries in one read,
    // so every number is from the same look at the file; executed here against a real
    // one because nothing checks a table or column name until it runs.
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        const fresh = yield* store.counts();
        yield* migrated(store);
        const seeded = yield* store.counts();
        yield* store.recordObservation(CALLER, multiCaseInput());
        const written = yield* store.counts();
        yield* store.settleAttempt("attempt-1", "succeeded");
        const settled = yield* store.counts();
        return { fresh, seeded, written, settled };
      }),
    );

    // A migrated, empty file: zeros rather than a failure, and no row invented for a
    // table that happens to be empty.
    expect(outcome.fresh).toEqual({
      goals: 0,
      intents: 0,
      attempts: 0,
      unsettledAttempts: 0,
      observations: 0,
      assets: 0,
      events: 0,
    });
    expect(outcome.seeded).toMatchObject({
      goals: 1,
      intents: 1,
      attempts: 1,
      // Seeded `running`, so it is unsettled — the one count here that can fall.
      unsettledAttempts: 1,
      observations: 0,
    });
    expect(outcome.written.observations).toBe(1);
    // The observation's own event landed in the same transaction.
    expect(outcome.written.events).toBeGreaterThan(0);
    expect(outcome.settled.unsettledAttempts).toBe(0);
    expect(outcome.settled.attempts).toBe(1);
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

/**
 * The address helpers are contract code, tested here.
 *
 * They belong to `@bit/contracts`, which deliberately cannot import `bun:test` — the
 * lint boundary that keeps that package browser-safe forbids every `bun:*` and `node:*`
 * import, and weakening it for a test file would weaken the guarantee it exists for. So
 * they are exercised in the suite that depends on them, next to the validation they
 * feed.
 */
describe("dimension addresses", () => {
  test("an address round-trips, and only in its canonical spelling", () => {
    expect(dimensionAddress("obs_000003_attempt-x", 1)).toBe(
      "obs_000003_attempt-x#u1",
    );
    expect(parseDimensionAddress("obs_000003_attempt-x#u1")).toEqual({
      observationId: "obs_000003_attempt-x",
      index: 1,
    });
    expect(parseDimensionAddress("obs_000003_attempt-x#u0")).toEqual({
      observationId: "obs_000003_attempt-x",
      index: 0,
    });
    // Two spellings of one position would be two addresses for one question.
    expect(parseDimensionAddress("obs_1#u01")).toBeUndefined();
    expect(parseDimensionAddress("obs_1#u-1")).toBeUndefined();
    expect(parseDimensionAddress("obs_1#u")).toBeUndefined();
    expect(parseDimensionAddress("obs_1")).toBeUndefined();
    expect(parseDimensionAddress("#u1")).toBeUndefined();
    expect(parseDimensionAddress("")).toBeUndefined();
  });

  test("dimensionsOf pairs each recorded dimension with its own address", () => {
    expect(
      dimensionsOf({
        observationId: "obs_000001_a",
        untestedDimensions: ["first", "second"],
      }),
    ).toEqual([
      { address: "obs_000001_a#u0", dimension: "first" },
      { address: "obs_000001_a#u1", dimension: "second" },
    ]);
  });
});

describe("addressing an earlier untested dimension", () => {
  /** Writes one observation with two untested dimensions, and returns its id. */
  const withRaiser = <A, E>(
    use: (store: Store, raiserId: string) => Effect.Effect<A, E>,
  ) => {
    const path = newDatabasePath();
    return withStore(path, (store) =>
      Effect.gen(function* () {
        yield* migrated(store);
        const raiser = yield* store.recordObservation(
          CALLER,
          multiCaseInput({
            operationId: "raiser",
            untestedDimensions: ["the per-account limit", "window rollover"],
          }),
        );
        return yield* use(store, raiser.observationId);
      }),
    );
  };

  test("a valid address is recorded as a link, with the position it resolved to", async () => {
    const outcome = await withRaiser((store, raiserId) =>
      Effect.gen(function* () {
        const follow = yield* store.recordObservation(
          CALLER,
          multiCaseInput({
            operationId: "follow-up",
            addressesDimensions: [dimensionAddress(raiserId, 1)],
          }),
        );
        const dimensions = yield* store.dimensionsForIntent("intent-1");
        return {
          follow,
          dimensions,
          dimensionId:
            dimensions.find(
              (dimension) =>
                dimension.observationId === "obs_000001_attempt-1" &&
                dimension.position === 1,
            )?.dimensionId ?? "no such dimension",
          links: yield* store.dimensionLinksForIntent("intent-1"),
        };
      }),
    );

    expect(outcome.links).toEqual([
      {
        observationId: outcome.follow.observationId,
        dimensionId: outcome.dimensionId,
        address: "obs_000001_attempt-1#u1",
        addressingSequence: outcome.follow.sequence,
        addressingOutcome: "positive",
      },
    ]);
    // The link points at the dimension row the alias resolved to, and that row is the
    // one position 1 of the raising observation holds — checked through the table rather
    // than by re-deriving the address.
    expect(
      outcome.dimensions.find(
        (dimension) => dimension.dimensionId === outcome.dimensionId,
      ),
    ).toMatchObject({
      observationId: "obs_000001_attempt-1",
      position: 1,
      address: "obs_000001_attempt-1#u1",
    });
  });

  test("an address naming an observation that does not exist is refused, and nothing is written", async () => {
    const outcome = await withRaiser((store) =>
      Effect.gen(function* () {
        const refused = yield* Effect.result(
          store.recordObservation(
            CALLER,
            multiCaseInput({
              operationId: "ghost-address",
              addressesDimensions: ["obs_999999_attempt-1#u0"],
            }),
          ),
        );
        return {
          refused,
          stored: yield* store.observationsForIntent("intent-1"),
          links: yield* store.dimensionLinksForIntent("intent-1"),
          sequence: yield* store.currentSequence,
        };
      }),
    );

    expect(outcome.refused._tag).toBe("Failure");
    if (outcome.refused._tag === "Failure") {
      expect(outcome.refused.failure).toBeInstanceOf(MutationError);
      expect((outcome.refused.failure as MutationError).reason).toBe("invalid");
    }
    // Atomic: the refused call left no observation, no link and no sequence gap.
    expect(outcome.stored).toHaveLength(1);
    expect(outcome.links).toHaveLength(0);
    expect(outcome.sequence).toBe(1);
  });

  test("an address pointing past the recorded dimensions is refused", async () => {
    const outcome = await withRaiser((store, raiserId) =>
      Effect.result(
        store.recordObservation(
          CALLER,
          multiCaseInput({
            operationId: "out-of-range",
            // The raiser recorded two dimensions, so index 2 does not exist.
            addressesDimensions: [dimensionAddress(raiserId, 2)],
          }),
        ),
      ),
    );

    expect(outcome._tag).toBe("Failure");
    if (outcome._tag === "Failure") {
      expect((outcome.failure as MutationError).detail).toContain(
        "recorded 2 untested dimensions",
      );
    }
  });

  test("a malformed address is refused with the spelling it expected", async () => {
    const outcome = await withRaiser((store) =>
      Effect.result(
        store.recordObservation(
          CALLER,
          multiCaseInput({
            operationId: "malformed",
            addressesDimensions: ["the per-account limit"],
          }),
        ),
      ),
    );

    expect(outcome._tag).toBe("Failure");
    if (outcome._tag === "Failure") {
      expect((outcome.failure as MutationError).detail).toContain(
        "is not an untested-dimension address",
      );
    }
  });

  test("an address belonging to another intent is refused", async () => {
    // Addresses are not a global namespace a worker can reach across. An intent's
    // worker must not be able to claim progress on someone else's question.
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* migrated(store);
        yield* store.seedAttempt({
          targetId: "target-1",
          goalId: "goal-1",
          goal: "Determine whether authentication rate limits can be bypassed.",
          intentId: "intent-other",
          question: "A different direction entirely.",
          attemptId: "attempt-other",
          workerId: "worker-1",
          providerId: "openai",
          modelId: "gpt-5.6-sol",
          harnessSessionId: "ses_other",
        });
        const elsewhere = yield* store.recordObservation(
          {
            ...CALLER,
            callerScope: "target-1/attempt-other",
            intentId: "intent-other",
            attemptId: "attempt-other",
          },
          multiCaseInput({
            operationId: "elsewhere",
            untestedDimensions: ["a question under another intent"],
          }),
        );
        const refused = yield* Effect.result(
          store.recordObservation(
            CALLER,
            multiCaseInput({
              operationId: "cross-intent",
              addressesDimensions: [
                dimensionAddress(elsewhere.observationId, 0),
              ],
            }),
          ),
        );
        return {
          refused,
          links: yield* store.dimensionLinksForIntent("intent-1"),
        };
      }),
    );

    expect(outcome.refused._tag).toBe("Failure");
    if (outcome.refused._tag === "Failure") {
      // The refusal names what is missing rather than only what is wrong: these two
      // intents share a goal, so the one thing that would have allowed this is a
      // declaration on the caller's own intent (migration `0009`).
      expect((outcome.refused.failure as MutationError).detail).toContain(
        "was raised by intent intent-other, not intent-1",
      );
      expect((outcome.refused.failure as MutationError).detail).toContain(
        "does not declare that it addresses it",
      );
    }
    expect(outcome.links).toHaveLength(0);
  });

  test("the same address listed twice in one call is refused rather than collapsed", async () => {
    const outcome = await withRaiser((store, raiserId) =>
      Effect.result(
        store.recordObservation(
          CALLER,
          multiCaseInput({
            operationId: "duplicate-address",
            addressesDimensions: [
              dimensionAddress(raiserId, 0),
              dimensionAddress(raiserId, 0),
            ],
          }),
        ),
      ),
    );

    expect(outcome._tag).toBe("Failure");
    if (outcome._tag === "Failure") {
      expect((outcome.failure as MutationError).detail).toContain(
        "is listed twice",
      );
    }
  });

  test("an exact retry replays and writes no second link", async () => {
    // The receipt covers the whole call, links included: the hash is over the input,
    // so the address list is part of what makes a retry exact.
    const outcome = await withRaiser((store, raiserId) =>
      Effect.gen(function* () {
        const input = multiCaseInput({
          operationId: "idempotent-follow-up",
          addressesDimensions: [dimensionAddress(raiserId, 0)],
        });
        const first = yield* store.recordObservation(CALLER, input);
        const second = yield* store.recordObservation(CALLER, input);
        const conflict = yield* Effect.result(
          store.recordObservation(CALLER, {
            ...input,
            addressesDimensions: [dimensionAddress(raiserId, 1)],
          }),
        );
        return {
          first,
          second,
          conflict,
          links: yield* store.dimensionLinksForIntent("intent-1"),
        };
      }),
    );

    expect(outcome.second.replayed).toBe(true);
    expect(outcome.links).toHaveLength(1);
    // Changing the address list under the same operation ID is a conflict, like any
    // other change to the input.
    expect(outcome.conflict._tag).toBe("Failure");
    if (outcome.conflict._tag === "Failure") {
      expect((outcome.conflict.failure as MutationError).reason).toBe(
        "conflict",
      );
    }
  });

  test("links survive a reopen and come back in the order work was taken on", async () => {
    const path = newDatabasePath();
    const raiserId = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* migrated(store);
        const raiser = yield* store.recordObservation(
          CALLER,
          multiCaseInput({
            operationId: "raiser",
            untestedDimensions: ["first gap", "second gap"],
          }),
        );
        yield* store.recordObservation(
          CALLER,
          multiCaseInput({
            operationId: "follow-a",
            addressesDimensions: [dimensionAddress(raiser.observationId, 0)],
          }),
        );
        yield* store.recordObservation(
          CALLER,
          multiCaseInput({
            operationId: "follow-b",
            addressesDimensions: [dimensionAddress(raiser.observationId, 1)],
          }),
        );
        return raiser.observationId;
      }),
    );

    const links = await withStore(path, (store) =>
      store.dimensionLinksForIntent("intent-1"),
    );

    expect(links.map((link) => link.address)).toEqual([
      dimensionAddress(raiserId, 0),
      dimensionAddress(raiserId, 1),
    ]);
    expect(links.map((link) => link.observationId)).toEqual([
      "obs_000002_attempt-1",
      "obs_000003_attempt-1",
    ]);
  });
});

describe("settling an attempt", () => {
  test("settlement moves a running attempt once and reports that it did", async () => {
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* migrated(store);
        const first = yield* store.settleAttempt("attempt-1", "succeeded");
        const second = yield* store.settleAttempt("attempt-1", "failed");
        return {
          first,
          second,
          attempt: yield* store.loadAttempt("attempt-1", "target-1"),
        };
      }),
    );

    expect(outcome.first).toEqual({
      requested: "succeeded",
      effective: "succeeded",
      changed: true,
    });
    // A second settlement does not overwrite the first. A worker settling late must not
    // be able to undo what reconciliation decided, and vice versa.
    expect(outcome.second).toEqual({
      requested: "failed",
      effective: "succeeded",
      changed: false,
    });
    expect(outcome.attempt?.status).toBe("succeeded");
  });

  test("settling an attempt that does not exist reports no effective status", async () => {
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* migrated(store);
        return yield* store.settleAttempt("attempt-never", "succeeded");
      }),
    );

    expect(outcome).toEqual({
      requested: "succeeded",
      effective: undefined,
      changed: false,
    });
  });

  test("the unsettled set is running and uncertain, and nothing else", async () => {
    // The statuses reconciliation has rules for, named by the query rather than derived
    // as "not final": a row holding something else is left alone instead of being fed
    // to a decision that would read it as `running` and move it.
    const path = newDatabasePath();
    await withStore(path, (store) =>
      Effect.gen(function* () {
        for (const attemptId of [
          "attempt-live",
          "attempt-unknown",
          "attempt-uncertain",
          "attempt-done",
        ]) {
          yield* seed(store, attemptId);
        }
        yield* store.settleAttempt("attempt-done", "succeeded");
        yield* store.settleAttempt("attempt-uncertain", "uncertain");
      }),
    );
    const sqlite = new (await import("bun:sqlite")).Database(path);
    sqlite.run(
      `UPDATE attempts SET status = 'something_else' WHERE id = 'attempt-unknown'`,
    );
    sqlite.close();

    const unsettled = await withStore(path, (store) =>
      store.unsettledAttempts(),
    );

    expect(
      unsettled.map((attempt) => [attempt.id, attempt.status]).sort(),
    ).toEqual([
      ["attempt-live", "running"],
      ["attempt-uncertain", "uncertain"],
    ]);
  });
});

describe("the planner session lineage", () => {
  test("a target with no recorded lineage is undefined, not an error", async () => {
    // The first planner round on a target has nothing to join, and that is an ordinary
    // answer rather than a missing row to report.
    const lineage = await withStore(newDatabasePath(), (store) =>
      store.plannerLineage("target-1"),
    );
    expect(lineage).toBeUndefined();
  });

  test("a recorded lineage survives a reopen, and is per target", async () => {
    // Surviving the process is the entire point: within one run a caller could hold the
    // session id in memory, and a hunt is not one run.
    const path = newDatabasePath();
    await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* store.recordPlannerLineage("target-1", "ses_one");
        yield* store.recordPlannerLineage("target-2", "ses_two");
      }),
    );

    const reopened = await withStore(path, (store) =>
      Effect.all({
        first: store.plannerLineage("target-1"),
        second: store.plannerLineage("target-2"),
        absent: store.plannerLineage("target-3"),
      }),
    );

    expect(reopened).toEqual({
      first: "ses_one",
      second: "ses_two",
      absent: undefined,
    });
  });

  test("recording again replaces the lineage instead of adding a second one", async () => {
    // What happens when the harness has forgotten the session we recorded: the next
    // round opens a new one and this is the write that retires the old id. Two current
    // lineages for one target would make "which session do rounds join" unanswerable.
    const path = newDatabasePath();
    const after = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* store.recordPlannerLineage("target-1", "ses_gone");
        yield* store.recordPlannerLineage("target-1", "ses_fresh");
        return yield* store.plannerLineage("target-1");
      }),
    );
    expect(after).toBe("ses_fresh");

    const sqlite = new (await import("bun:sqlite")).Database(path);
    const rows = sqlite
      .query(
        `SELECT target_id, harness_session_id FROM planner_lineages ORDER BY target_id`,
      )
      .all();
    sqlite.close();
    expect(rows).toEqual([
      { target_id: "target-1", harness_session_id: "ses_fresh" },
    ]);
  });

  test("the lineage holds no knowledge: dropping it changes no briefing", async () => {
    // Stated as a test because it is the justification for the table existing at all.
    // It is a cache hint, so losing it may cost one uncached round and must cost
    // nothing else.
    const path = newDatabasePath();
    const before = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* seed(store);
        yield* store.recordObservation(CALLER, multiCaseInput());
        yield* store.recordPlannerLineage("target-1", "ses_one");
        return yield* store.observationsForIntent("intent-1");
      }),
    );

    const sqlite = new (await import("bun:sqlite")).Database(path);
    sqlite.run(`DELETE FROM planner_lineages`);
    sqlite.close();

    const after = await withStore(path, (store) =>
      Effect.all({
        observations: store.observationsForIntent("intent-1"),
        lineage: store.plannerLineage("target-1"),
      }),
    );

    expect(after.observations).toEqual(before);
    expect(after.lineage).toBeUndefined();
  });
});

describe("recording an asset", () => {
  const HOST = "http://127.0.0.1:41317/";
  const LOGIN = "http://127.0.0.1:41317/login";

  const assetInput = (
    overrides: Partial<{
      operationId: string;
      kind: "host" | "endpoint";
      url: string;
      method: string | null;
      note: string;
    }> = {},
  ) => ({
    operationId: "asset-1",
    kind: "endpoint" as const,
    url: LOGIN,
    method: "post",
    note: `Found in the fixture's own route table; ${AWKWARD_TEXT}`,
    ...overrides,
  });

  const withSeeded = <A, E>(use: (store: Store) => Effect.Effect<A, E>) => {
    const path = newDatabasePath();
    return withStore(path, (store) =>
      Effect.gen(function* () {
        yield* migrated(store);
        return yield* use(store);
      }),
    );
  };

  test("canonicalises an endpoint, and merges a second discovery of it", async () => {
    const outcome = await withSeeded((store) =>
      Effect.gen(function* () {
        const first = yield* store.recordAsset(CALLER, assetInput());
        // The same endpoint written three other ways: a different method case, an
        // explicit default-looking port already present, a query string, and a
        // fragment. All of it is one asset.
        const second = yield* store.recordAsset(
          CALLER,
          assetInput({
            operationId: "asset-2",
            method: "POST",
            url: `${LOGIN}?attempt=3#top`,
          }),
        );
        return {
          first,
          second,
          assets: yield* store.assets(),
          discoveries: yield* store.discoveriesOfAsset(first.assetId),
        };
      }),
    );

    expect(outcome.first.identity).toBe("POST http://127.0.0.1:41317/login");
    expect(outcome.first.created).toBe(true);
    expect(outcome.first.discoveries).toBe(1);
    // A different operation that found the same canonical asset is new provenance about
    // a known thing, not a new asset and not a replay.
    expect(outcome.second.assetId).toBe(outcome.first.assetId);
    expect(outcome.second.created).toBe(false);
    expect(outcome.second.replayed).toBe(false);
    expect(outcome.second.discoveries).toBe(2);
    expect(outcome.assets).toHaveLength(1);
    expect(outcome.assets[0]).toMatchObject({
      kind: "endpoint",
      identity: "POST http://127.0.0.1:41317/login",
      host: "127.0.0.1",
      port: 41_317,
      scheme: "http:",
      method: "POST",
      path: "/login",
    });
    // Both discoveries survive the merge, each keeping the URL as submitted — so the
    // query string excluded from identity is still visible in provenance.
    expect(outcome.discoveries.map((row) => row.discovered_as)).toEqual([
      LOGIN,
      `${LOGIN}?attempt=3#top`,
    ]);
    expect(outcome.discoveries.map((row) => row.operation_id)).toEqual([
      "asset-1",
      "asset-2",
    ]);
    expect(outcome.discoveries[0]?.attempt_id).toBe("attempt-1");
  });

  test("a host is identified by host and port, with the default port made explicit", async () => {
    const outcome = await withSeeded((store) =>
      Effect.gen(function* () {
        const explicit = yield* store.recordAsset(
          CALLER,
          assetInput({
            operationId: "host-1",
            kind: "host",
            url: "http://Example.COM.:80/anything",
            method: null,
          }),
        );
        const implicit = yield* store.recordAsset(
          CALLER,
          assetInput({
            operationId: "host-2",
            kind: "host",
            url: "http://example.com/other/path",
            method: null,
          }),
        );
        const secure = yield* store.recordAsset(
          CALLER,
          assetInput({
            operationId: "host-3",
            kind: "host",
            url: "https://example.com/",
            method: null,
          }),
        );
        return {
          explicit,
          implicit,
          secure,
          assets: yield* store.assets(),
        };
      }),
    );

    // Case, the trailing dot and an omitted default port are all one host.
    expect(outcome.explicit.identity).toBe("example.com:80");
    expect(outcome.implicit.identity).toBe("example.com:80");
    expect(outcome.implicit.assetId).toBe(outcome.explicit.assetId);
    // A different port is a different host, which is the over-normalisation line.
    expect(outcome.secure.identity).toBe("example.com:443");
    expect(outcome.secure.assetId).not.toBe(outcome.explicit.assetId);
    expect(outcome.assets).toHaveLength(2);
    expect(outcome.assets.every((row) => row.method === null)).toBe(true);
  });

  test("a trailing slash is two paths, and two methods are two endpoints", async () => {
    const outcome = await withSeeded((store) =>
      Effect.gen(function* () {
        const bare = yield* store.recordAsset(
          CALLER,
          assetInput({ operationId: "p1", url: `${HOST}login` }),
        );
        const slashed = yield* store.recordAsset(
          CALLER,
          assetInput({ operationId: "p2", url: `${HOST}login/` }),
        );
        const other = yield* store.recordAsset(
          CALLER,
          assetInput({ operationId: "p3", url: `${HOST}login`, method: "GET" }),
        );
        // `URL` resolves `..` and percent-encoding, so one path cannot have two
        // spellings — that much normalisation is safe and is all there is.
        const traversed = yield* store.recordAsset(
          CALLER,
          assetInput({ operationId: "p4", url: `${HOST}x/../login` }),
        );
        return { bare, slashed, other, traversed };
      }),
    );
    expect(outcome.slashed.assetId).not.toBe(outcome.bare.assetId);
    expect(outcome.other.assetId).not.toBe(outcome.bare.assetId);
    expect(outcome.traversed.assetId).toBe(outcome.bare.assetId);
  });

  test("role is not part of identity, because role is a property of the test", async () => {
    const outcome = await withSeeded((store) =>
      Effect.gen(function* () {
        const asAdmin = yield* store.recordAsset(
          CALLER,
          assetInput({ operationId: "r1", note: "probed as administrator" }),
        );
        const asAnonymous = yield* store.recordAsset(
          CALLER,
          assetInput({ operationId: "r2", note: "probed unauthenticated" }),
        );
        return {
          asAdmin,
          asAnonymous,
          assets: yield* store.assets(),
          discoveries: yield* store.discoveriesOfAsset(asAdmin.assetId),
        };
      }),
    );
    // One endpoint, two discoveries. Splitting by role would double-count the surface
    // and make "we probed /login unauthenticated" not count as touching /login.
    expect(outcome.asAnonymous.assetId).toBe(outcome.asAdmin.assetId);
    expect(outcome.assets).toHaveLength(1);
    expect(outcome.discoveries.map((row) => row.note)).toEqual([
      "probed as administrator",
      "probed unauthenticated",
    ]);
  });

  test("an unusable URL and a kind that contradicts its method are refused", async () => {
    const outcome = await withSeeded((store) =>
      Effect.gen(function* () {
        const relative = yield* Effect.result(
          store.recordAsset(
            CALLER,
            assetInput({ operationId: "bad-1", url: "/login" }),
          ),
        );
        const noPort = yield* Effect.result(
          store.recordAsset(
            CALLER,
            assetInput({
              operationId: "bad-2",
              kind: "host",
              url: "ssh://example.com/",
              method: null,
            }),
          ),
        );
        const endpointWithoutMethod = yield* Effect.result(
          store.recordAsset(
            CALLER,
            assetInput({ operationId: "bad-3", method: null }),
          ),
        );
        return {
          relative,
          noPort,
          endpointWithoutMethod,
          assets: yield* store.assets(),
          events: yield* store.eventsAfter(),
          pending: yield* store.pendingRequests(),
        };
      }),
    );
    expect(outcome.relative._tag).toBe("Failure");
    expect(outcome.noPort._tag).toBe("Failure");
    if (outcome.noPort._tag === "Failure") {
      expect((outcome.noPort.failure as MutationError).detail).toContain(
        "include the port",
      );
    }
    expect(outcome.endpointWithoutMethod._tag).toBe("Failure");
    // Nothing written on any refusal: no asset, no event, no obligation.
    expect(outcome.assets).toEqual([]);
    expect(outcome.events).toEqual([]);
    expect(outcome.pending).toEqual([]);
  });

  test("an asset cannot be recorded under a settled attempt's revoked authority", async () => {
    const outcome = await withSeeded((store) =>
      Effect.gen(function* () {
        yield* store.settleAttempt("attempt-1", "succeeded");
        const refused = yield* Effect.result(
          store.recordAsset(CALLER, assetInput()),
        );
        return { refused, assets: yield* store.assets() };
      }),
    );
    expect(outcome.refused._tag).toBe("Failure");
    if (outcome.refused._tag === "Failure") {
      expect((outcome.refused.failure as MutationError).reason).toBe("stale");
    }
    expect(outcome.assets).toEqual([]);
  });
});

describe("intent anchoring", () => {
  const HOST_CONTEXT = { callerScope: "host/target-1", targetId: "target-1" };

  const addIntentInput = (
    overrides: Partial<{
      operationId: string;
      goalId: string;
      intentId: string;
      question: string;
      anchorObservationIds: readonly string[];
      addressesDimension: string | null;
    }> = {},
  ) => ({
    operationId: "add-1",
    goalId: "goal-1",
    intentId: "intent-2",
    question: "Measure the per-account limiter on POST /login.",
    anchorObservationIds: [] as readonly string[],
    addressesDimension: null,
    ...overrides,
  });

  /** A seeded store holding one observation with two untested dimensions. */
  const withEvidence = <A, E>(
    use: (store: Store, observationId: string) => Effect.Effect<A, E>,
  ) => {
    const path = newDatabasePath();
    return withStore(path, (store) =>
      Effect.gen(function* () {
        yield* migrated(store);
        const raiser = yield* store.recordObservation(
          CALLER,
          multiCaseInput({
            operationId: "evidence",
            untestedDimensions: [
              "the per-account limit was never approached",
              "no window rollover was measured",
            ],
          }),
        );
        return yield* use(store, raiser.observationId);
      }),
    );
  };

  test("an empty anchor list is a new top-level direction", async () => {
    const outcome = await withEvidence((store) =>
      Effect.gen(function* () {
        const added = yield* store.addIntent(HOST_CONTEXT, addIntentInput());
        return {
          added,
          anchors: yield* store.anchorsForIntent("intent-2"),
          intent: yield* store.loadIntent("intent-2"),
        };
      }),
    );
    expect(outcome.added.topLevel).toBe(true);
    expect(outcome.added.anchoredTo).toEqual([]);
    expect(outcome.anchors).toEqual([]);
    expect(outcome.intent?.question).toContain("per-account limiter");
  });

  test("an observation anchors an intent, and the order given is kept", async () => {
    const outcome = await withEvidence((store, observationId) =>
      Effect.gen(function* () {
        const second = yield* store.recordObservation(
          CALLER,
          multiCaseInput({ operationId: "evidence-2" }),
        );
        const added = yield* store.addIntent(
          HOST_CONTEXT,
          addIntentInput({
            anchorObservationIds: [second.observationId, observationId],
          }),
        );
        return {
          added,
          anchors: yield* store.anchorsForIntent("intent-2"),
          secondId: second.observationId,
          firstId: observationId,
        };
      }),
    );
    expect(outcome.added.topLevel).toBe(false);
    // Position order, not sequence order: a first parent is usually where the direction
    // came from, and the rest qualify it.
    expect(outcome.anchors).toEqual([outcome.secondId, outcome.firstId]);
  });

  test("an intent cannot anchor an intent, and the refusal says what to do instead", async () => {
    const outcome = await withEvidence((store) =>
      Effect.gen(function* () {
        const refused = yield* Effect.result(
          store.addIntent(
            HOST_CONTEXT,
            addIntentInput({ anchorObservationIds: ["intent-1"] }),
          ),
        );
        return {
          refused,
          intent: yield* store.loadIntent("intent-2"),
          events: yield* store.eventsAfter(),
        };
      }),
    );
    expect(outcome.refused._tag).toBe("Failure");
    if (outcome.refused._tag === "Failure") {
      const detail = (outcome.refused.failure as MutationError).detail;
      // Instructive, not a bare failure: what it is, why that cannot anchor, and the
      // way to express a new direction (DECISIONS.md §4).
      expect(detail).toContain("is an intent and cannot anchor an intent");
      expect(detail).toContain("Only a recorded observation may anchor one");
      expect(detail).toContain(
        "Leave anchorObservationIds empty for a new top-level direction",
      );
    }
    // Refused inside the transaction, so no intent row and no event.
    expect(outcome.intent).toBeUndefined();
    expect(outcome.events.filter((e) => e.kind === "intent.added")).toEqual([]);
  });

  test("a goal, and an id nothing recorded, are each refused by what they are", async () => {
    const outcome = await withEvidence((store) =>
      Effect.gen(function* () {
        const onGoal = yield* Effect.result(
          store.addIntent(
            HOST_CONTEXT,
            addIntentInput({ anchorObservationIds: ["goal-1"] }),
          ),
        );
        const onNothing = yield* Effect.result(
          store.addIntent(
            HOST_CONTEXT,
            addIntentInput({ anchorObservationIds: ["obs_999999_nope"] }),
          ),
        );
        return {
          onGoal,
          onNothing,
          intent: yield* store.loadIntent("intent-2"),
        };
      }),
    );
    expect(outcome.onGoal._tag).toBe("Failure");
    if (outcome.onGoal._tag === "Failure") {
      expect((outcome.onGoal.failure as MutationError).detail).toContain(
        "is a goal and cannot anchor an intent",
      );
    }
    expect(outcome.onNothing._tag).toBe("Failure");
    if (outcome.onNothing._tag === "Failure") {
      expect((outcome.onNothing.failure as MutationError).detail).toContain(
        "is nothing recorded in this target",
      );
    }
    expect(outcome.intent).toBeUndefined();
  });

  test("an anchor from another goal is refused, and a duplicate anchor is not collapsed", async () => {
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* migrated(store);
        const mine = yield* store.recordObservation(
          CALLER,
          multiCaseInput({ operationId: "mine" }),
        );
        // A second goal, with its own intent, attempt and observation.
        yield* store.seedAttempt({
          targetId: "target-1",
          goalId: "goal-other",
          goal: "A different objective entirely.",
          intentId: "intent-other",
          question: "Something else.",
          attemptId: "attempt-other",
          workerId: "worker-1",
          providerId: "openai",
          modelId: "gpt-5.6-sol",
          harnessSessionId: "ses_other",
        });
        const theirs = yield* store.recordObservation(
          {
            ...CALLER,
            callerScope: "target-1/attempt-other",
            intentId: "intent-other",
            attemptId: "attempt-other",
          },
          multiCaseInput({ operationId: "theirs" }),
        );
        const crossGoal = yield* Effect.result(
          store.addIntent(
            HOST_CONTEXT,
            addIntentInput({ anchorObservationIds: [theirs.observationId] }),
          ),
        );
        const duplicate = yield* Effect.result(
          store.addIntent(
            HOST_CONTEXT,
            addIntentInput({
              anchorObservationIds: [mine.observationId, mine.observationId],
            }),
          ),
        );
        return {
          crossGoal,
          duplicate,
          intent: yield* store.loadIntent("intent-2"),
        };
      }),
    );
    expect(outcome.crossGoal._tag).toBe("Failure");
    if (outcome.crossGoal._tag === "Failure") {
      expect((outcome.crossGoal.failure as MutationError).detail).toContain(
        "an intent anchors to evidence from its own goal",
      );
    }
    expect(outcome.duplicate._tag).toBe("Failure");
    if (outcome.duplicate._tag === "Failure") {
      expect((outcome.duplicate.failure as MutationError).detail).toContain(
        "is listed twice",
      );
    }
    expect(outcome.intent).toBeUndefined();
  });

  test("a goal from another target, and a reused intent id, are refused", async () => {
    const outcome = await withEvidence((store) =>
      Effect.gen(function* () {
        const wrongTarget = yield* Effect.result(
          store.addIntent(
            { callerScope: "host/target-2", targetId: "target-2" },
            addIntentInput(),
          ),
        );
        const reused = yield* Effect.result(
          store.addIntent(
            HOST_CONTEXT,
            addIntentInput({ intentId: "intent-1" }),
          ),
        );
        const noGoal = yield* Effect.result(
          store.addIntent(
            HOST_CONTEXT,
            addIntentInput({ goalId: "goal-missing" }),
          ),
        );
        return { wrongTarget, reused, noGoal };
      }),
    );
    expect(outcome.wrongTarget._tag).toBe("Failure");
    if (outcome.wrongTarget._tag === "Failure") {
      expect((outcome.wrongTarget.failure as MutationError).reason).toBe(
        "unauthorized",
      );
    }
    expect(outcome.reused._tag).toBe("Failure");
    if (outcome.reused._tag === "Failure") {
      expect((outcome.reused.failure as MutationError).detail).toContain(
        "already exists",
      );
    }
    expect(outcome.noGoal._tag).toBe("Failure");
  });

  test("an exact retry replays, and conflicting reuse is refused", async () => {
    const outcome = await withEvidence((store, observationId) =>
      Effect.gen(function* () {
        const first = yield* store.addIntent(
          HOST_CONTEXT,
          addIntentInput({ anchorObservationIds: [observationId] }),
        );
        const replay = yield* store.addIntent(
          HOST_CONTEXT,
          addIntentInput({ anchorObservationIds: [observationId] }),
        );
        const conflict = yield* Effect.result(
          store.addIntent(
            HOST_CONTEXT,
            addIntentInput({
              anchorObservationIds: [observationId],
              question: "A different question under the same operation id.",
            }),
          ),
        );
        return {
          first,
          replay,
          conflict,
          events: yield* store.eventsAfter(),
          anchors: yield* store.anchorsForIntent("intent-2"),
        };
      }),
    );
    expect(outcome.first.replayed).toBe(false);
    expect(outcome.replay.replayed).toBe(true);
    expect(outcome.replay.intentId).toBe(outcome.first.intentId);
    expect(outcome.conflict._tag).toBe("Failure");
    if (outcome.conflict._tag === "Failure") {
      expect((outcome.conflict.failure as MutationError).reason).toBe(
        "conflict",
      );
    }
    // One anchor row and one event, from three calls.
    expect(outcome.anchors).toHaveLength(1);
    expect(
      outcome.events.filter((e) => e.kind === "intent.added"),
    ).toHaveLength(1);
  });
});

describe("answering another intent's dimension", () => {
  const HOST_CONTEXT = { callerScope: "host/target-1", targetId: "target-1" };

  /**
   * One raising observation under `intent-1`, plus a sibling intent of the same goal
   * with its own running attempt. The sibling declares the dimension or does not,
   * depending on what each test needs.
   */
  const withSibling = <A, E>(
    declare: boolean,
    use: (
      store: Store,
      context: { raiserId: string; sibling: CallerContext },
    ) => Effect.Effect<A, E>,
  ) => {
    const path = newDatabasePath();
    return withStore(path, (store) =>
      Effect.gen(function* () {
        yield* migrated(store);
        const raiser = yield* store.recordObservation(
          CALLER,
          multiCaseInput({
            operationId: "raiser",
            untestedDimensions: [
              "the per-account limit was never approached",
              "no window rollover was measured",
            ],
          }),
        );
        yield* store.addIntent(HOST_CONTEXT, {
          operationId: "add-sibling",
          goalId: "goal-1",
          intentId: "intent-sibling",
          question: "Measure the per-account limiter directly.",
          anchorObservationIds: [raiser.observationId],
          addressesDimension: declare
            ? dimensionAddress(raiser.observationId, 0)
            : null,
        });
        yield* store.seedAttempt({
          targetId: "target-1",
          goalId: "goal-1",
          goal: "Determine whether authentication rate limits can be bypassed.",
          intentId: "intent-sibling",
          question: "Measure the per-account limiter directly.",
          attemptId: "attempt-sibling",
          workerId: "worker-1",
          providerId: "openai",
          modelId: "gpt-5.6-sol",
          harnessSessionId: "ses_sibling",
        });
        const sibling: CallerContext = {
          ...CALLER,
          callerScope: "target-1/attempt-sibling",
          intentId: "intent-sibling",
          attemptId: "attempt-sibling",
        };
        return yield* use(store, { raiserId: raiser.observationId, sibling });
      }),
    );
  };

  test("a declaring intent may answer it; an undeclared sibling may not", async () => {
    const allowed = await withSibling(true, (store, { raiserId, sibling }) =>
      Effect.gen(function* () {
        const answered = yield* store.recordObservation(
          sibling,
          multiCaseInput({
            operationId: "answer",
            addressesDimensions: [dimensionAddress(raiserId, 0)],
          }),
        );
        return {
          answered,
          links: yield* store.dimensionLinksForIntent("intent-1"),
          questions: yield* store.dimensionsForIntent("intent-1"),
        };
      }),
    );
    // The relaxation, in one assertion: the link exists even though the addressing
    // observation belongs to a different intent of the same goal.
    expect(allowed.links).toHaveLength(1);
    expect(allowed.links[0]?.observationId).toBe(
      allowed.answered.observationId,
    );
    expect(allowed.links[0]?.address).toBe(`${allowed.questions[0]?.address}`);

    const refused = await withSibling(false, (store, { raiserId, sibling }) =>
      Effect.gen(function* () {
        const outcome = yield* Effect.result(
          store.recordObservation(
            sibling,
            multiCaseInput({
              operationId: "answer",
              addressesDimensions: [dimensionAddress(raiserId, 0)],
            }),
          ),
        );
        return {
          outcome,
          links: yield* store.dimensionLinksForIntent("intent-1"),
        };
      }),
    );
    expect(refused.outcome._tag).toBe("Failure");
    if (refused.outcome._tag === "Failure") {
      expect((refused.outcome.failure as MutationError).detail).toContain(
        "does not declare that it addresses it",
      );
    }
    expect(refused.links).toEqual([]);
  });

  test("the declaration authorises exactly one dimension, not the sibling beside it", async () => {
    const outcome = await withSibling(true, (store, { raiserId, sibling }) =>
      Effect.gen(function* () {
        const refused = yield* Effect.result(
          store.recordObservation(
            sibling,
            multiCaseInput({
              operationId: "answer-other",
              // Position 1, where the declaration named position 0.
              addressesDimensions: [dimensionAddress(raiserId, 1)],
            }),
          ),
        );
        return {
          refused,
          links: yield* store.dimensionLinksForIntent("intent-1"),
        };
      }),
    );
    expect(outcome.refused._tag).toBe("Failure");
    if (outcome.refused._tag === "Failure") {
      expect((outcome.refused.failure as MutationError).detail).toContain(
        "does not declare that it addresses it",
      );
    }
    expect(outcome.links).toEqual([]);
  });

  test("a declaration cannot be made for a dimension of another goal", async () => {
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* migrated(store);
        const raiser = yield* store.recordObservation(
          CALLER,
          multiCaseInput({
            operationId: "raiser",
            untestedDimensions: ["a question under goal-1"],
          }),
        );
        yield* store.seedAttempt({
          targetId: "target-1",
          goalId: "goal-other",
          goal: "A different objective.",
          intentId: "intent-other",
          question: "Something else.",
          attemptId: "attempt-other",
          workerId: "worker-1",
          providerId: "openai",
          modelId: "gpt-5.6-sol",
          harnessSessionId: "ses_other",
        });
        return yield* Effect.result(
          store.addIntent(
            { callerScope: "host/target-1", targetId: "target-1" },
            {
              operationId: "add-cross",
              goalId: "goal-other",
              intentId: "intent-cross",
              question: "Answer goal-1's question from goal-other.",
              anchorObservationIds: [],
              addressesDimension: dimensionAddress(raiser.observationId, 0),
            },
          ),
        );
      }),
    );
    expect(outcome._tag).toBe("Failure");
    if (outcome._tag === "Failure") {
      expect((outcome.failure as MutationError).detail).toContain(
        "was raised under goal goal-1",
      );
    }
  });

  test("a declaration naming no recorded dimension is refused", async () => {
    const outcome = await withEvidenceless((store) =>
      Effect.result(
        store.addIntent(
          { callerScope: "host/target-1", targetId: "target-1" },
          {
            operationId: "add-ghost",
            goalId: "goal-1",
            intentId: "intent-ghost",
            question: "Answer a question nobody raised.",
            anchorObservationIds: [],
            addressesDimension: "obs_999999_attempt-1#u0",
          },
        ),
      ),
    );
    expect(outcome._tag).toBe("Failure");
    if (outcome._tag === "Failure") {
      expect((outcome.failure as MutationError).detail).toContain(
        "no untested dimension is recorded at",
      );
    }
  });
});

/** A seeded store with a goal, intent and attempt but no observation. */
const withEvidenceless = <A, E>(use: (store: Store) => Effect.Effect<A, E>) => {
  const path = newDatabasePath();
  return withStore(path, (store) =>
    Effect.gen(function* () {
      yield* migrated(store);
      return yield* use(store);
    }),
  );
};

describe("one transaction per mutation", () => {
  const HOST_CONTEXT = { callerScope: "host/target-1", targetId: "target-1" };

  const assetInput = (
    operationId: string,
    note = "the fixture's login route",
  ) => ({
    operationId,
    kind: "endpoint" as const,
    url: "http://127.0.0.1:41317/login",
    method: "POST",
    note,
  });

  const withSeeded = <A, E>(
    path: string,
    use: (store: Store) => Effect.Effect<A, E>,
  ) =>
    withStore(path, (store) =>
      Effect.gen(function* () {
        yield* migrated(store);
        return yield* use(store);
      }),
    );

  test("every mutation writes its domain row, receipt and event together", async () => {
    const outcome = await withSeeded(newDatabasePath(), (store) =>
      Effect.gen(function* () {
        const asset = yield* store.recordAsset(CALLER, assetInput("a-1"));
        const observation = yield* store.recordObservation(
          CALLER,
          multiCaseInput({ operationId: "o-1" }),
        );
        const intent = yield* store.addIntent(HOST_CONTEXT, {
          operationId: "i-1",
          goalId: "goal-1",
          intentId: "intent-2",
          question: "Measure the per-account limiter.",
          anchorObservationIds: [observation.observationId],
          addressesDimension: null,
        });
        return {
          asset,
          observation,
          intent,
          events: yield* store.eventsAfter(),
          pending: yield* store.pendingRequests(),
        };
      }),
    );

    // One event per mutation, in commit order, with a dense sequence starting at 1.
    expect(outcome.events.map((event) => event.kind)).toEqual([
      "asset.recorded",
      "observation.recorded",
      "intent.added",
    ]);
    expect(outcome.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(outcome.events.map((event) => event.eventId)).toEqual([
      "evt_000001",
      "evt_000002",
      "evt_000003",
    ]);

    // Domain identity on each event is the row it is about.
    expect(outcome.events[0]?.subjectId).toBe(outcome.asset.assetId);
    expect(outcome.events[1]?.subjectId).toBe(
      outcome.observation.observationId,
    );
    expect(outcome.events[2]?.subjectId).toBe("intent-2");

    // Operation identity is the pair the receipt is keyed on.
    expect(
      outcome.events.map((event) => [event.operation, event.operationId]),
    ).toEqual([
      ["record_asset", "a-1"],
      ["record_observation", "o-1"],
      ["add_intent", "i-1"],
    ]);

    // Caller authority is separate again, and a host-created intent carries no attempt
    // rather than a fabricated one.
    expect(outcome.events[0]?.callerScope).toBe(CALLER.callerScope);
    expect(outcome.events[0]?.attemptId).toBe("attempt-1");
    expect(outcome.events[0]?.intentId).toBe("intent-1");
    expect(outcome.events[2]?.callerScope).toBe("host/target-1");
    expect(outcome.events[2]?.attemptId).toBeNull();
    expect(outcome.events[2]?.intentId).toBeNull();

    // Two of the three kinds carry an obligation; adding an intent carries none,
    // because a new intent implies no action outside this database.
    expect(
      outcome.pending.map((entry) => [
        entry.requestType,
        entry.recoveryPolicy,
        entry.status,
        entry.attempts,
      ]),
    ).toEqual([
      ["asset.enrich", "safe_to_retry", "pending", 0],
      ["notification.deliver", "reconcile_first", "pending", 0],
    ]);
    // Each request names the event that explains it.
    expect(outcome.pending.map((entry) => entry.causedByEventId)).toEqual([
      "evt_000001",
      "evt_000002",
    ]);
    // Nothing in this sprint claims a row.
    expect(
      outcome.pending.every(
        (entry) => entry.leaseOwner === null && entry.completedAt === null,
      ),
    ).toBe(true);
  });

  test("an exact retry replays and writes no second event and no second request", async () => {
    const outcome = await withSeeded(newDatabasePath(), (store) =>
      Effect.gen(function* () {
        const first = yield* store.recordObservation(
          CALLER,
          multiCaseInput({ operationId: "once" }),
        );
        const asset = yield* store.recordAsset(
          CALLER,
          assetInput("asset-once"),
        );
        const replayObservation = yield* store.recordObservation(
          CALLER,
          multiCaseInput({ operationId: "once" }),
        );
        const replayAsset = yield* store.recordAsset(
          CALLER,
          assetInput("asset-once"),
        );
        return {
          first,
          asset,
          replayObservation,
          replayAsset,
          events: yield* store.eventsAfter(),
          pending: yield* store.pendingRequests(),
          observations: yield* store.observationsForIntent("intent-1"),
          assets: yield* store.assets(),
          discoveries: yield* store.discoveriesOfAsset(asset.assetId),
          sequence: yield* store.currentSequence,
        };
      }),
    );

    expect(outcome.replayObservation).toEqual({
      ...outcome.first,
      replayed: true,
    });
    expect(outcome.replayAsset).toEqual({ ...outcome.asset, replayed: true });
    // One of everything. A replay hands back a committed result and writes nothing:
    // not a row, not an event, not an obligation, and not a sequence number.
    expect(outcome.observations).toHaveLength(1);
    expect(outcome.assets).toHaveLength(1);
    expect(outcome.discoveries).toHaveLength(1);
    expect(outcome.events).toHaveLength(2);
    expect(outcome.pending).toHaveLength(2);
    expect(outcome.sequence).toBe(1);
  });

  test("a conflicting retry is refused and writes no event and no request either", async () => {
    const outcome = await withSeeded(newDatabasePath(), (store) =>
      Effect.gen(function* () {
        yield* store.recordObservation(
          CALLER,
          multiCaseInput({ operationId: "clash" }),
        );
        yield* store.recordAsset(CALLER, assetInput("asset-clash"));
        const before = {
          events: yield* store.eventsAfter(),
          pending: yield* store.pendingRequests(),
        };
        const observationConflict = yield* Effect.result(
          store.recordObservation(
            CALLER,
            multiCaseInput({
              operationId: "clash",
              interpretation:
                "A different reading under the same operation id.",
            }),
          ),
        );
        const assetConflict = yield* Effect.result(
          store.recordAsset(
            CALLER,
            assetInput("asset-clash", "a different note"),
          ),
        );
        return {
          before,
          observationConflict,
          assetConflict,
          events: yield* store.eventsAfter(),
          pending: yield* store.pendingRequests(),
          observations: yield* store.observationsForIntent("intent-1"),
          sequence: yield* store.currentSequence,
        };
      }),
    );

    expect(outcome.observationConflict._tag).toBe("Failure");
    expect(outcome.assetConflict._tag).toBe("Failure");
    if (outcome.observationConflict._tag === "Failure") {
      expect(
        (outcome.observationConflict.failure as MutationError).reason,
      ).toBe("conflict");
    }
    // The point of the single transaction: a refusal that happens *after* the receipt
    // check and before the commit leaves nothing behind on any of the four writes.
    expect(outcome.events).toEqual(outcome.before.events);
    expect(outcome.pending).toEqual(outcome.before.pending);
    expect(outcome.events).toHaveLength(2);
    expect(outcome.pending).toHaveLength(2);
    expect(outcome.observations).toHaveLength(1);
    // And no sequence gap, because the bump is inside the rolled-back transaction.
    expect(outcome.sequence).toBe(1);
  });

  test("a refused mutation leaves no event sequence gap for the next one to skip", async () => {
    const outcome = await withSeeded(newDatabasePath(), (store) =>
      Effect.gen(function* () {
        yield* store.recordAsset(CALLER, assetInput("first"));
        yield* Effect.result(
          store.recordAsset(CALLER, { ...assetInput("bad"), url: "not a url" }),
        );
        yield* store.recordAsset(CALLER, {
          ...assetInput("second"),
          url: "http://127.0.0.1:41317/health",
          method: "GET",
        });
        return { events: yield* store.eventsAfter() };
      }),
    );
    // 1 then 2, not 1 then 3. A gap is the one thing a consumer reading
    // `WHERE sequence > cursor` cannot tell apart from a lost event.
    expect(outcome.events.map((event) => event.sequence)).toEqual([1, 2]);
  });

  test("events and obligations read back in order after the file is closed and reopened", async () => {
    const path = newDatabasePath();
    await withSeeded(path, (store) =>
      Effect.gen(function* () {
        yield* store.recordAsset(CALLER, assetInput("a-1"));
        yield* store.recordObservation(
          CALLER,
          multiCaseInput({ operationId: "o-1" }),
        );
      }),
    );

    const after = await withStore(path, (store) =>
      Effect.gen(function* () {
        return {
          all: yield* store.eventsAfter(),
          afterFirst: yield* store.eventsAfter(1),
          bounded: yield* store.eventsAfter(0, 1),
          pending: yield* store.pendingRequests(),
        };
      }),
    );

    expect(after.all.map((event) => event.sequence)).toEqual([1, 2]);
    // The cursor read §8 specifies: strictly after, ascending, and bounded.
    expect(after.afterFirst.map((event) => event.sequence)).toEqual([2]);
    expect(after.bounded.map((event) => event.sequence)).toEqual([1]);
    // The obligations are still undispatched, which is the crash-survival claim.
    expect(after.pending.map((entry) => entry.status)).toEqual([
      "pending",
      "pending",
    ]);
    // Payloads survive as JSON a reader can interrogate without a declared shape.
    expect(unknownString(after.all[0]?.payload, "identity")).toBe(
      "POST http://127.0.0.1:41317/login",
    );
    expect(
      unknownString(after.all[0]?.payload, "nothing_declared_this"),
    ).toBeUndefined();
    expect(unknownNumber(after.all[1]?.payload, "sequence")).toBe(1);
  });

  test("a superseded attempt cannot write, across a restart, and writes no event", async () => {
    const path = newDatabasePath();
    await withSeeded(path, (store) =>
      Effect.gen(function* () {
        yield* store.recordAsset(CALLER, assetInput("before-fence"));
        // Reconciliation revokes authority by moving the fence, which is a column and
        // therefore survives the process that wrote it.
        yield* store.recordRecovery({
          attemptId: "attempt-1",
          observed: "missing",
          proposedStatus: "uncertain",
          detail: "the harness has never heard of this session",
        });
      }),
    );

    const after = await withStore(path, (store) =>
      Effect.gen(function* () {
        const attempt = yield* store.loadAttempt("attempt-1", "target-1");
        const asset = yield* Effect.result(
          store.recordAsset(CALLER, assetInput("after-fence")),
        );
        const observation = yield* Effect.result(
          store.recordObservation(
            CALLER,
            multiCaseInput({ operationId: "after-fence" }),
          ),
        );
        // The same credential, reissued against the *current* fence, is still refused:
        // the attempt is no longer running, which is a separate rule from the fence.
        const refreshed = yield* Effect.result(
          store.recordAsset(
            { ...CALLER, attemptFence: attempt?.write_fence ?? 0 },
            assetInput("refreshed"),
          ),
        );
        // A replay of the operation that committed *before* the fence moved is still
        // answered, because it writes nothing and creates no external effect.
        const replay = yield* store.recordAsset(
          CALLER,
          assetInput("before-fence"),
        );
        return {
          fence: attempt?.write_fence,
          status: attempt?.status,
          asset,
          observation,
          refreshed,
          replay,
          events: yield* store.eventsAfter(),
          pending: yield* store.pendingRequests(),
          assets: yield* store.assets(),
        };
      }),
    );

    expect(after.fence).toBe(1);
    expect(after.status).toBe("uncertain");
    expect(after.asset._tag).toBe("Failure");
    if (after.asset._tag === "Failure") {
      expect((after.asset.failure as MutationError).reason).toBe("stale");
      expect((after.asset.failure as MutationError).detail).toContain(
        "its write authority ended",
      );
    }
    expect(after.observation._tag).toBe("Failure");
    expect(after.refreshed._tag).toBe("Failure");
    expect(after.replay.replayed).toBe(true);
    // One event and one obligation, from before the fence moved. Nothing a revoked
    // credential attempted reached the log.
    expect(after.events).toHaveLength(1);
    expect(after.pending).toHaveLength(1);
    expect(after.assets).toHaveLength(1);
  });

  test("a failure inside the transaction takes the whole mutation with it", async () => {
    const path = newDatabasePath();
    await withSeeded(path, () => Effect.void);
    // A trigger that aborts the receipt insert, which is the *last* write in the
    // mutation. So the asset, its discovery, the event and the outbox row have all been
    // written by the time it fires — and must all disappear. Installed from outside the
    // store's own connection, so nothing about the store is special-cased for the test.
    const sqlite = new Database(path);
    sqlite.run(
      `CREATE TRIGGER no_receipts BEFORE INSERT ON command_receipts
       BEGIN SELECT RAISE(ABORT, 'forced failure for the atomicity test'); END`,
    );
    sqlite.close();

    const refused = await withStore(path, (store) =>
      Effect.result(store.recordAsset(CALLER, assetInput("aborted"))),
    );

    const dropped = new Database(path);
    dropped.run(`DROP TRIGGER no_receipts`);
    dropped.close();

    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        const afterRepair = yield* store.recordAsset(
          CALLER,
          assetInput("aborted"),
        );
        return {
          refused,
          afterRepair,
          assets: yield* store.assets(),
          events: yield* store.eventsAfter(),
          pending: yield* store.pendingRequests(),
        };
      }),
    );

    expect(outcome.refused._tag).toBe("Failure");
    // Not a half-written mutation: the asset that was inserted before the abort is gone
    // along with its event and its obligation, and the same call then succeeds.
    expect(outcome.afterRepair.created).toBe(true);
    expect(outcome.afterRepair.discoveries).toBe(1);
    expect(outcome.assets).toHaveLength(1);
    expect(outcome.events.map((event) => event.sequence)).toEqual([1]);
    expect(outcome.pending).toHaveLength(1);
  });
});
