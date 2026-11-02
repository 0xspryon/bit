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
import { Clock, Effect, Schema } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/sql";

import {
  AWKWARD_TEXT,
  RUNNING_ATTEMPT_ID,
  SUMMARY_CONDITIONS,
  SUMMARY_OBSERVATION_ID,
  multiCaseInput,
  writeSummaryFormatDatabase,
} from "./fixtures";
import * as identifier from "./identifier";
import {
  ClaimRefused,
  MutationError,
  ObservationStore,
  StoredRowError,
  callerScopeOf,
  roundIdFromScope,
  operatorScope,
  type AttemptCaller,
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

const CALLER: AttemptCaller = {
  _tag: "attempt",
  callerScope: "target-1/attempt-1",
  targetId: "target-1",
  intentId: "intent-1",
  attemptId: "attempt-1",
  harnessSessionId: "ses_abc",
  workerId: "worker-1",
  // The fence a credential minted against a freshly seeded attempt carries.
  attemptFence: 0,
};

const OTHER_CALLER: AttemptCaller = {
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
    harnessInstanceId: "opencode",
    providerId: "openai",
    modelId: "gpt-5.6-sol",
    modelOptions: null,
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
  test("a stored summary row reads back as summary, unrewritten and labelled", async () => {
    const path = newDatabasePath();
    await writeSummaryFormatDatabase(path);

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

  test("new writes beside a summary row are case-based, and both formats coexist", async () => {
    const path = newDatabasePath();
    await writeSummaryFormatDatabase(path);

    const stored = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* store.recordObservation(
          {
            // The fixture's *running* attempt. `attempt-summary` is settled,
            // and a settled attempt is exactly what the authority check must refuse.
            _tag: "attempt",
            callerScope: `fixture-local/${RUNNING_ATTEMPT_ID}`,
            targetId: "fixture-local",
            intentId: "intent-per-client-limiter",
            attemptId: RUNNING_ATTEMPT_ID,
            harnessSessionId: "ses_new",
            workerId: "worker-1",
            attemptFence: 0,
          },
          multiCaseInput({ operationId: "op-after-summary" }),
        );
        return yield* store.observationsForIntent("intent-per-client-limiter");
      }),
    );

    expect(stored.map((item) => item._tag)).toEqual(["summary", "caseBased"]);
    // The new row takes the next sequence, so the existing cursor was respected.
    expect(stored.map((item) => item.sequence)).toEqual([1, 2]);
  });

  test("a stored receipt from another build conflicts rather than writing a duplicate", async () => {
    // The receipt's stored result names the summary observation. A retry of that
    // operation must replay it rather than write a second row under a reused ID.
    const path = newDatabasePath();
    await writeSummaryFormatDatabase(path);

    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        const conflict = yield* Effect.result(
          store.recordObservation(
            {
              _tag: "attempt",
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
          harnessInstanceId: "opencode",
          providerId: "openai",
          modelId: "gpt-5.6-sol",
          modelOptions: null,
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
  test("recent recovery reads the latest persisted outcome after reopening", async () => {
    const path = newDatabasePath();
    await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* seed(store, "attempt-recovered");
        yield* store.recordRecovery({
          attemptId: "attempt-recovered",
          observed: "missing",
          proposedStatus: "uncertain",
          detail: "session not found",
        });
      }),
    );
    const uncertain = await withStore(path, (store) =>
      store.recentRecoveries(),
    );
    expect(uncertain).toHaveLength(1);
    expect(uncertain[0]?.status).toBe("uncertain");
    await withStore(path, (store) =>
      store.recordRecovery({
        attemptId: "attempt-recovered",
        observed: "succeeded",
        proposedStatus: "succeeded",
        detail: "harness confirmed completion",
      }),
    );
    const refined = await withStore(path, (store) => store.recentRecoveries());
    expect(refined).toHaveLength(1);
    expect(refined[0]?.status).toBe("succeeded");
    expect(refined[0]?.disposition).toBe("refined");
  });

  test("a later ordinary settlement does not display a stale running recovery", async () => {
    const path = newDatabasePath();
    await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* seed(store, "attempt-later-settled");
        yield* store.recordRecovery({
          attemptId: "attempt-later-settled",
          observed: "running",
          proposedStatus: "running",
          detail: "harness still running",
        });
        yield* store.settleAttempt("attempt-later-settled", "succeeded");
      }),
    );
    const notices = await withStore(path, (store) => store.recentRecoveries());
    expect(notices).toEqual([]);
  });

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
  /**
   * The lineage is keyed by **goal** since migration `0019`, and `goal_id` is a real
   * foreign key, so these tests open the goals they record against.
   *
   * The re-key is the spec's decision 7 — one planner works one goal — and it is why the
   * assertions below name goals where they used to name targets. What is being checked is
   * unchanged: the row survives a reopen, one key has exactly one current answer, and
   * losing the table costs nothing but a cache prefix.
   */
  const HOST = { callerScope: "target-1/operator", targetId: "target-1" };

  const openGoals = (store: Store, ...goalIds: readonly string[]) =>
    Effect.forEach(goalIds, (goalId) =>
      store.openGoal(HOST, {
        operationId: `open-${goalId}`,
        goalId,
        name: "",
        description: `Establish something about ${goalId}.`,
      }),
    );

  test("a goal with no recorded lineage is undefined, not an error", async () => {
    // The first planner round on a goal has nothing to join, and that is an ordinary
    // answer rather than a missing row to report.
    const lineage = await withStore(newDatabasePath(), (store) =>
      store.plannerLineage("goal-1"),
    );
    expect(lineage).toBeUndefined();
  });

  test("a recorded lineage survives a reopen, and is per goal", async () => {
    // Surviving the process is the entire point: within one run a caller could hold the
    // session id in memory, and a hunt is not one run.
    const path = newDatabasePath();
    await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* openGoals(store, "goal-1", "goal-2");
        yield* store.recordPlannerLineage("goal-1", "ses_one");
        yield* store.recordPlannerLineage("goal-2", "ses_two");
      }),
    );

    const reopened = await withStore(path, (store) =>
      Effect.all({
        first: store.plannerLineage("goal-1"),
        second: store.plannerLineage("goal-2"),
        absent: store.plannerLineage("goal-3"),
      }),
    );

    expect(reopened).toEqual({
      first: "ses_one",
      second: "ses_two",
      absent: undefined,
    });
  });

  test("a lineage cannot be recorded for a goal that does not exist", async () => {
    // The foreign key `0019` adds. A lineage names the goal whose rounds join it, and a
    // row pointing at no goal would be a cache key nothing could ever ask for.
    const failure = await withStore(newDatabasePath(), (store) =>
      Effect.result(store.recordPlannerLineage("goal-absent", "ses_orphan")),
    );
    expect(failure._tag).toBe("Failure");
  });

  test("recording again replaces the lineage instead of adding a second one", async () => {
    // What happens when the harness has forgotten the session we recorded: the next
    // round opens a new one and this is the write that retires the old id. Two current
    // lineages for one goal would make "which session do rounds join" unanswerable.
    const path = newDatabasePath();
    const after = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* openGoals(store, "goal-1");
        yield* store.recordPlannerLineage("goal-1", "ses_gone");
        yield* store.recordPlannerLineage("goal-1", "ses_fresh");
        return yield* store.plannerLineage("goal-1");
      }),
    );
    expect(after).toBe("ses_fresh");

    const sqlite = new (await import("bun:sqlite")).Database(path);
    const rows = sqlite
      .query(
        `SELECT goal_id, harness_session_id FROM planner_lineages ORDER BY goal_id`,
      )
      .all();
    sqlite.close();
    expect(rows).toEqual([
      { goal_id: "goal-1", harness_session_id: "ses_fresh" },
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
        yield* store.recordPlannerLineage("goal-1", "ses_one");
        return yield* store.observationsForIntent("intent-1");
      }),
    );

    const sqlite = new (await import("bun:sqlite")).Database(path);
    sqlite.run(`DELETE FROM planner_lineages`);
    sqlite.close();

    const after = await withStore(path, (store) =>
      Effect.all({
        observations: store.observationsForIntent("intent-1"),
        lineage: store.plannerLineage("goal-1"),
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

  /**
   * A clock that does not move, so two writes are indistinguishable by time.
   *
   * The only way to tell a merge from a creation on this clock is to ask the schema,
   * which is what the test below exists to hold.
   */
  const FROZEN_MILLIS = 1_700_000_000_000;
  const FROZEN: Clock.Clock = {
    currentTimeMillisUnsafe: () => FROZEN_MILLIS,
    currentTimeMillis: Effect.succeed(FROZEN_MILLIS),
    currentTimeNanosUnsafe: () => 1_700_000_000_000_000_000n,
    currentTimeNanos: Effect.succeed(1_700_000_000_000_000_000n),
    monotonicTimeNanosUnsafe: () => 0n,
    monotonicTimeNanos: Effect.succeed(0n),
    sleep: () => Effect.void,
  };

  const withFrozenSeeded = <A, E>(
    use: (store: Store) => Effect.Effect<A, E>,
  ) => {
    const path = newDatabasePath();
    return Effect.runPromise(
      Effect.provideService(
        Effect.scoped(
          Effect.flatMap(ObservationStore, (store) =>
            Effect.gen(function* () {
              yield* migrated(store);
              return yield* use(store);
            }),
          ).pipe(Effect.provide(ObservationStore.layer(path))),
        ),
        Clock.Clock,
        FROZEN,
      ),
    );
  };

  test("merges rather than reporting a second creation inside one millisecond", async () => {
    // `created` is read off the insert — `ON CONFLICT DO NOTHING RETURNING id` returns a
    // row only when this statement wrote one — and never off a timestamp comparison.
    // The earlier form compared the stored `first_seen_at` to this call's own clock
    // reading, which holds only while no two writes share a millisecond; this test used
    // to fail intermittently on a fast machine for exactly that reason, and `importAsset`
    // would have had the collision as its normal case rather than as a race.
    const outcome = await withFrozenSeeded((store) =>
      Effect.gen(function* () {
        const first = yield* store.recordAsset(CALLER, assetInput());
        const second = yield* store.recordAsset(
          CALLER,
          assetInput({ operationId: "asset-2" }),
        );
        return { first, second, assets: yield* store.assets() };
      }),
    );

    expect(outcome.first.created).toBe(true);
    expect(outcome.second.assetId).toBe(outcome.first.assetId);
    expect(outcome.second.created).toBe(false);
    expect(outcome.second.discoveries).toBe(2);
    expect(outcome.assets).toHaveLength(1);
  });

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
    // Nothing written on any refusal: no asset, no obligation, and no event beyond the
    // `attempt.started` the seed wrote before any of this was attempted.
    expect(outcome.assets).toEqual([]);
    expect(outcome.events.map((event) => event.kind)).toEqual([
      "attempt.started",
    ]);
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
          harnessInstanceId: "opencode",
          providerId: "openai",
          modelId: "gpt-5.6-sol",
          modelOptions: null,
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
      context: { raiserId: string; sibling: AttemptCaller },
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
          harnessInstanceId: "opencode",
          providerId: "openai",
          modelId: "gpt-5.6-sol",
          modelOptions: null,
          harnessSessionId: "ses_sibling",
        });
        const sibling: AttemptCaller = {
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
          harnessInstanceId: "opencode",
          providerId: "openai",
          modelId: "gpt-5.6-sol",
          modelOptions: null,
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
    //
    // `attempt.started` is first because seeding the attempt is the first mutation this
    // database sees — the seed helper every test here runs is itself a mutation now, and
    // the log says so rather than starting at whatever the test happened to call next.
    expect(outcome.events.map((event) => event.kind)).toEqual([
      "attempt.started",
      "asset.recorded",
      "observation.recorded",
      "intent.added",
    ]);
    expect(outcome.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(outcome.events.map((event) => event.eventId)).toEqual([
      "evt_000001",
      "evt_000002",
      "evt_000003",
      "evt_000004",
    ]);

    // Domain identity on each event is the row it is about.
    expect(outcome.events[0]?.subjectId).toBe("attempt-1");
    expect(outcome.events[1]?.subjectId).toBe(outcome.asset.assetId);
    expect(outcome.events[2]?.subjectId).toBe(
      outcome.observation.observationId,
    );
    expect(outcome.events[3]?.subjectId).toBe("intent-2");

    // Operation identity is the pair the receipt is keyed on. An attempt's lifecycle has
    // no receipt — there is no operation id to retry it under, because starting a run is
    // not a command a worker sends — so the pair is the operation alone.
    expect(
      outcome.events.map((event) => [event.operation, event.operationId]),
    ).toEqual([
      ["seed_attempt", null],
      ["record_asset", "a-1"],
      ["record_observation", "o-1"],
      ["add_intent", "i-1"],
    ]);

    // Caller authority is separate again, and a host-created intent carries no attempt
    // rather than a fabricated one.
    expect(outcome.events[1]?.callerScope).toBe(CALLER.callerScope);
    expect(outcome.events[1]?.attemptId).toBe("attempt-1");
    expect(outcome.events[1]?.intentId).toBe("intent-1");
    expect(outcome.events[3]?.callerScope).toBe("host/target-1");
    expect(outcome.events[3]?.attemptId).toBeNull();
    expect(outcome.events[3]?.intentId).toBeNull();

    // And `attempt.started` carries none of the three, which is the invariant
    // `contracts/event.ts` states: they are caller authority, and no credential for this
    // attempt existed when its own beginning was recorded. The attempt is the event's
    // subject, above, not its author.
    expect(outcome.events[0]?.callerScope).toBeNull();
    expect(outcome.events[0]?.attemptId).toBeNull();
    expect(outcome.events[0]?.intentId).toBeNull();
    expect(outcome.events[0]?.payload).toMatchObject({
      attemptId: "attempt-1",
      intentId: "intent-1",
      replacesAttemptId: null,
    });

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
      "evt_000002",
      "evt_000003",
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
    // Three events: the attempt starting, then one per mutation. A replay hands back a
    // committed result and adds nothing to any of them.
    expect(outcome.events).toHaveLength(3);
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
    expect(outcome.events).toHaveLength(3);
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
    // 2 then 3, not 2 then 4 — the seed's own `attempt.started` is 1. A gap is the one
    // thing a consumer reading `WHERE sequence > cursor` cannot tell apart from a lost
    // event, and a refusal must not leave one.
    expect(outcome.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(outcome.events.map((event) => event.kind)).toEqual([
      "attempt.started",
      "asset.recorded",
      "asset.recorded",
    ]);
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

    expect(after.all.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(after.all.map((event) => event.kind)).toEqual([
      "attempt.started",
      "asset.recorded",
      "observation.recorded",
    ]);
    // The cursor read §8 specifies: strictly after, ascending, and bounded.
    expect(after.afterFirst.map((event) => event.sequence)).toEqual([2, 3]);
    expect(after.bounded.map((event) => event.sequence)).toEqual([1]);
    // The obligations are still undispatched, which is the crash-survival claim.
    expect(after.pending.map((entry) => entry.status)).toEqual([
      "pending",
      "pending",
    ]);
    // Payloads survive as JSON a reader can interrogate without a declared shape.
    expect(unknownString(after.all[1]?.payload, "identity")).toBe(
      "POST http://127.0.0.1:41317/login",
    );
    expect(
      unknownString(after.all[1]?.payload, "nothing_declared_this"),
    ).toBeUndefined();
    expect(unknownNumber(after.all[2]?.payload, "sequence")).toBe(1);
  });

  test("the event log's own counter is separate from the observations', and survives a reopen", async () => {
    const path = newDatabasePath();
    const written = await withSeeded(path, (store) =>
      Effect.gen(function* () {
        yield* store.recordAsset(CALLER, assetInput("a-1"));
        yield* store.recordObservation(
          CALLER,
          multiCaseInput({ operationId: "o-1" }),
        );
        return {
          events: yield* store.currentEventSequence,
          observations: yield* store.currentSequence,
        };
      }),
    );
    // Three events — the seed's `attempt.started`, the asset and the observation — against
    // one observation. The two counters advance at different rates, which is the whole
    // reason they are two counters and the reason a consumer that read the wrong one would
    // be told the event log ends wherever the observations happen to.
    expect(written.events).toBe(3);
    expect(written.observations).toBe(1);

    const reopened = await withStore(path, (store) =>
      Effect.gen(function* () {
        return {
          events: yield* store.currentEventSequence,
          last: yield* store.eventsAfter(),
        };
      }),
    );
    // And it is the end of the log rather than an in-memory count: a consumer opening a
    // cursor read after a restart has to know where the end is to say whether it is
    // showing all of it.
    expect(reopened.events).toBe(3);
    expect(reopened.last[reopened.last.length - 1]?.sequence).toBe(3);
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
    // One obligation and one asset, from before the fence moved: nothing a revoked
    // credential attempted reached the log. Three events, and none of them is a write the
    // stale credential made — the attempt starting, the one asset it recorded while it
    // still had authority, and recovery settling it, which is the mutation that moved the
    // fence in the first place.
    expect(after.events.map((event) => event.kind)).toEqual([
      "attempt.started",
      "asset.recorded",
      "attempt.settled",
    ]);
    expect(after.events[2]?.subjectId).toBe("attempt-1");
    expect(after.events[2]?.payload).toMatchObject({
      status: "uncertain",
      priorStatus: "running",
      settledBy: "recovery",
    });
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
    // Sequence 2, after the seed's own `attempt.started`: the aborted attempt's event
    // rolled back with it and left no number behind.
    expect(outcome.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(outcome.events.map((event) => event.kind)).toEqual([
      "attempt.started",
      "asset.recorded",
    ]);
    expect(outcome.pending).toHaveLength(1);
  });
});

/**
 * What an attempt row says about *how* its model was asked to work.
 *
 * `harness_instance_id` says which harness and `provider_id`/`model_id` say which model.
 * This is the third part of the same answer: an option that changes how a model reasons
 * is part of what ran, and a system whose claim is that it can say what happened cannot
 * leave it out. "The same prompt at a different effort" is a plausible explanation for
 * two attempts disagreeing, and these are what make it checkable.
 *
 * Executed against a real file, like everything else here: nothing checks a column name
 * or a placeholder at compile time, so migration `0015` and the two inserts that write
 * through it only exist once they have run.
 */
describe("what an attempt records of its model's options", () => {
  const seedWith = (
    store: Store,
    modelOptions: readonly { id: string; value: string }[] | null,
    attemptId = "attempt-1",
  ) =>
    store.seedAttempt({
      targetId: "target-1",
      goalId: "goal-1",
      goal: "Determine whether authentication rate limits can be bypassed.",
      intentId: "intent-1",
      question: "Probe the per-client limiter on POST /login.",
      attemptId,
      workerId: "worker-1",
      harnessInstanceId: "opencode",
      providerId: "openai",
      modelId: "gpt-5.6-sol",
      modelOptions,
      harnessSessionId: "ses_one",
    });

  test("what was dispatched is on the row and in the event, in one canonical order", async () => {
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        // Deliberately out of alphabetical order, and deliberately two of them: the
        // order a resolution happened to produce is not a fact about the run, so it must
        // not be what distinguishes one stored row from another.
        yield* seedWith(store, [
          { id: "variant", value: "high" },
          { id: "effort", value: "low" },
        ]);
        return {
          attempt: yield* store.loadAttempt("attempt-1", "target-1"),
          events: yield* store.eventsAfter(),
        };
      }),
    );

    expect(outcome.attempt?.model_options).toBe(
      '[{"id":"effort","value":"low"},{"id":"variant","value":"high"}]',
    );
    // The event log and the row are written from the same canonical value, so a reader
    // following the log cannot conclude something different from a reader of the row.
    expect(outcome.events[0]?.kind).toBe("attempt.started");
    expect(outcome.events[0]?.payload).toMatchObject({
      attemptId: "attempt-1",
      modelOptions: [
        { id: "effort", value: "low" },
        { id: "variant", value: "high" },
      ],
    });
  });

  test("nothing chosen is NULL, and so is an empty list", async () => {
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* seedWith(store, null, "attempt-1");
        yield* seedWith(store, [], "attempt-2");
        return {
          absent: yield* store.loadAttempt("attempt-1", "target-1"),
          empty: yield* store.loadAttempt("attempt-2", "target-1"),
          events: yield* store.eventsAfter(),
        };
      }),
    );

    // `null` and `[]` are the same fact — the operator set nothing and the harness
    // applied its own default — so they are stored the same way. An empty list on the row
    // would claim an opinion, exactly as it would on the wire.
    expect(outcome.absent?.model_options).toBeNull();
    expect(outcome.empty?.model_options).toBeNull();
    expect(outcome.events[0]?.payload).toMatchObject({ modelOptions: null });
    expect(outcome.events[1]?.payload).toMatchObject({ modelOptions: null });
  });

  test("a replacement attempt records its own, not the attempt it replaces", async () => {
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* seedWith(store, [{ id: "effort", value: "max" }]);
        // A replacement is only opened against an attempt that has stopped; this is the
        // ordinary path into one, not part of what is being asserted.
        yield* store.settleAttempt("attempt-1", "interrupted");
        yield* store.openReplacementAttempt({
          replacesAttemptId: "attempt-1",
          targetId: "target-1",
          intentId: "intent-1",
          attemptId: "attempt-2",
          workerId: "worker-2",
          harnessInstanceId: "claude-code",
          providerId: "anthropic",
          modelId: "claude-sonnet-5",
          // Lower, on another harness: carrying the abandoned attempt's choice over would
          // record something nobody chose for this one.
          modelOptions: [{ id: "effort", value: "low" }],
          harnessSessionId: null,
        });
        return {
          replaced: yield* store.loadAttempt("attempt-1", "target-1"),
          replacement: yield* store.loadAttempt("attempt-2", "target-1"),
        };
      }),
    );

    expect(outcome.replaced?.model_options).toBe(
      '[{"id":"effort","value":"max"}]',
    );
    expect(outcome.replacement?.model_options).toBe(
      '[{"id":"effort","value":"low"}]',
    );
  });
});

describe("goals", () => {
  const HOST = { callerScope: "host/target-1", targetId: "target-1" };

  const openInput = (
    overrides: Partial<{
      operationId: string;
      goalId: string;
      name: string;
      description: string;
    }> = {},
  ) => ({
    operationId: "open-1",
    goalId: "goal-new",
    name: "Auth bypass",
    description: "Determine whether the login limiter can be bypassed.",
    ...overrides,
  });

  const endInput = (
    overrides: Partial<{
      operationId: string;
      goalId: string;
      status: "met" | "abandoned";
      endedBy: "planner" | "operator";
      reason: string;
    }> = {},
  ) => ({
    operationId: "end-1",
    goalId: "goal-new",
    status: "met" as const,
    endedBy: "operator" as const,
    reason: "The limiter was shown to be bypassable.",
    ...overrides,
  });

  /** The reason a failed result carries, or fails the test if it did not fail. */
  const refusalOf = (result: {
    readonly _tag: string;
    readonly failure?: unknown;
  }): MutationError => {
    expect(result._tag).toBe("Failure");
    return result.failure as MutationError;
  };

  test("opening a goal writes the goal and a goal.added event together", async () => {
    const outcome = await withStore(newDatabasePath(), (store) =>
      Effect.gen(function* () {
        const opened = yield* store.openGoal(HOST, openInput());
        return {
          opened,
          goals: yield* store.goals(),
          loaded: yield* store.loadGoal("goal-new"),
          events: yield* store.eventsAfter(),
        };
      }),
    );

    expect(outcome.opened).toEqual({ goalId: "goal-new", replayed: false });
    expect(outcome.goals).toHaveLength(1);
    expect(outcome.loaded).toMatchObject({
      goalId: "goal-new",
      targetId: "target-1",
      name: "Auth bypass",
      description: "Determine whether the login limiter can be bypassed.",
      status: "active",
      endedAt: null,
      endedBy: null,
      endReason: null,
      intentCount: 0,
      attemptCount: 0,
      observationCount: 0,
    });
    expect(outcome.events).toHaveLength(1);
    const event = outcome.events[0];
    expect(event?.kind).toBe("goal.added");
    expect(event?.subjectId).toBe("goal-new");
    expect([event?.operation, event?.operationId]).toEqual([
      "open_goal",
      "open-1",
    ]);
    // Host-originated: the scope is the host's own, and there is no attempt or intent to
    // fabricate.
    expect(event?.callerScope).toBe("host/target-1");
    expect(event?.attemptId).toBeNull();
    expect(event?.intentId).toBeNull();
    expect(event?.payload).toMatchObject({
      goalId: "goal-new",
      name: "Auth bypass",
      description: "Determine whether the login limiter can be bypassed.",
    });
  });

  test("a goal and its event are one transaction: a failed event rolls the goal back", async () => {
    const path = newDatabasePath();
    // Create the file and schema first, then break the one thing the transaction must
    // also write. A trigger is the smallest way to make the event insert fail without
    // changing the store.
    await withStore(path, (store) => store.goals());
    const database = new Database(path);
    try {
      database.run(
        `CREATE TRIGGER no_events BEFORE INSERT ON events
         BEGIN SELECT RAISE(ABORT, 'events are closed for this test'); END`,
      );
    } finally {
      database.close();
    }

    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        const failed = yield* Effect.result(store.openGoal(HOST, openInput()));
        return {
          failed,
          goals: yield* store.goals(),
        };
      }),
    );

    expect(outcome.failed._tag).toBe("Failure");
    // Neither the goal nor its receipt survived, so a retry is a first attempt.
    expect(outcome.goals).toEqual([]);
    const after = new Database(path, { readonly: true });
    try {
      expect(
        after.query("SELECT COUNT(*) AS n FROM command_receipts").get(),
      ).toEqual({ n: 0 });
    } finally {
      after.close();
    }
  });

  test("an exact retry replays and writes nothing", async () => {
    const outcome = await withStore(newDatabasePath(), (store) =>
      Effect.gen(function* () {
        const first = yield* store.openGoal(HOST, openInput());
        const retry = yield* store.openGoal(HOST, openInput());
        return {
          first,
          retry,
          goals: yield* store.goals(),
          events: yield* store.eventsAfter(),
        };
      }),
    );

    expect(outcome.first.replayed).toBe(false);
    expect(outcome.retry).toEqual({ goalId: "goal-new", replayed: true });
    expect(outcome.goals).toHaveLength(1);
    expect(outcome.events).toHaveLength(1);
  });

  test("the same operation id with different input is a conflict and writes nothing", async () => {
    const outcome = await withStore(newDatabasePath(), (store) =>
      Effect.gen(function* () {
        yield* store.openGoal(HOST, openInput());
        const conflict = yield* Effect.result(
          store.openGoal(
            HOST,
            openInput({ description: "A different objective entirely." }),
          ),
        );
        return {
          conflict,
          goals: yield* store.goals(),
          events: yield* store.eventsAfter(),
        };
      }),
    );

    expect(refusalOf(outcome.conflict).reason).toBe("conflict");
    expect(outcome.goals).toHaveLength(1);
    expect(outcome.goals[0]?.description).toBe(
      "Determine whether the login limiter can be bypassed.",
    );
    expect(outcome.events).toHaveLength(1);
  });

  test("a goal id is never reused under a new operation id", async () => {
    const outcome = await withStore(newDatabasePath(), (store) =>
      Effect.gen(function* () {
        yield* store.openGoal(HOST, openInput());
        const reused = yield* Effect.result(
          store.openGoal(HOST, openInput({ operationId: "open-2" })),
        );
        return { reused, events: yield* store.eventsAfter() };
      }),
    );

    const refusal = refusalOf(outcome.reused);
    expect(refusal.reason).toBe("invalid");
    expect(refusal.detail).toContain("goal-new already exists");
    expect(outcome.events).toHaveLength(1);
  });

  test("ending a goal sets its status, time, ender and reason, and appends goal.ended", async () => {
    const outcome = await withStore(newDatabasePath(), (store) =>
      Effect.gen(function* () {
        yield* store.openGoal(HOST, openInput());
        const ended = yield* store.endGoal(HOST, endInput());
        return {
          ended,
          goal: yield* store.loadGoal("goal-new"),
          events: yield* store.eventsAfter(),
        };
      }),
    );

    expect(outcome.ended).toMatchObject({
      goalId: "goal-new",
      status: "met",
      endedBy: "operator",
      replayed: false,
    });
    expect(outcome.goal).toMatchObject({
      status: "met",
      endedBy: "operator",
      endReason: "The limiter was shown to be bypassable.",
      endedAt: outcome.ended.endedAt,
    });
    expect(outcome.events.map((event) => event.kind)).toEqual([
      "goal.added",
      "goal.ended",
    ]);
    const event = outcome.events[1];
    expect(event?.subjectId).toBe("goal-new");
    expect([event?.operation, event?.operationId]).toEqual([
      "end_goal",
      "end-1",
    ]);
    expect(event?.callerScope).toBe("host/target-1");
    expect(event?.attemptId).toBeNull();
    expect(event?.intentId).toBeNull();
    expect(event?.payload).toMatchObject({
      goalId: "goal-new",
      status: "met",
      endedBy: "operator",
      reason: "The limiter was shown to be bypassable.",
    });
  });

  test("an ending with no reason is stored as empty, not as absent", async () => {
    const goal = await withStore(newDatabasePath(), (store) =>
      Effect.gen(function* () {
        yield* store.openGoal(HOST, openInput());
        yield* store.endGoal(
          HOST,
          endInput({ status: "abandoned", reason: "" }),
        );
        return yield* store.loadGoal("goal-new");
      }),
    );
    expect(goal?.status).toBe("abandoned");
    expect(goal?.endReason).toBe("");
  });

  test("an exact retry of an ending replays the original, even after the goal is ended", async () => {
    const outcome = await withStore(newDatabasePath(), (store) =>
      Effect.gen(function* () {
        yield* store.openGoal(HOST, openInput());
        const first = yield* store.endGoal(HOST, endInput());
        const retry = yield* store.endGoal(HOST, endInput());
        return { first, retry, events: yield* store.eventsAfter() };
      }),
    );

    expect(outcome.retry).toEqual({ ...outcome.first, replayed: true });
    expect(outcome.events.filter((e) => e.kind === "goal.ended")).toHaveLength(
      1,
    );
  });

  test("ending an already-ended goal is a conflict that names the ending, and overwrites nothing", async () => {
    const outcome = await withStore(newDatabasePath(), (store) =>
      Effect.gen(function* () {
        yield* store.openGoal(HOST, openInput());
        yield* store.endGoal(HOST, endInput());
        const second = yield* Effect.result(
          store.endGoal(
            HOST,
            endInput({
              operationId: "end-2",
              status: "abandoned",
              endedBy: "planner",
              reason: "changed my mind",
            }),
          ),
        );
        return {
          second,
          goal: yield* store.loadGoal("goal-new"),
          events: yield* store.eventsAfter(),
        };
      }),
    );

    const refusal = refusalOf(outcome.second);
    expect(refusal.reason).toBe("conflict");
    expect(refusal.detail).toContain("already met");
    expect(refusal.detail).toContain("ended by operator");
    // The first ending stands, field for field.
    expect(outcome.goal).toMatchObject({
      status: "met",
      endedBy: "operator",
      endReason: "The limiter was shown to be bypassable.",
    });
    expect(outcome.events.filter((e) => e.kind === "goal.ended")).toHaveLength(
      1,
    );
  });

  test("the same operation id with different ending input is a conflict", async () => {
    const outcome = await withStore(newDatabasePath(), (store) =>
      Effect.gen(function* () {
        yield* store.openGoal(HOST, openInput());
        yield* store.endGoal(HOST, endInput());
        return yield* Effect.result(
          store.endGoal(HOST, endInput({ status: "abandoned" })),
        );
      }),
    );
    expect(refusalOf(outcome).detail).toContain("already used with different");
  });

  test("ending a goal that does not exist is invalid and names the id", async () => {
    const outcome = await withStore(newDatabasePath(), (store) =>
      Effect.gen(function* () {
        const missing = yield* Effect.result(
          store.endGoal(HOST, endInput({ goalId: "goal-nowhere" })),
        );
        return { missing, events: yield* store.eventsAfter() };
      }),
    );
    const refusal = refusalOf(outcome.missing);
    expect(refusal.reason).toBe("invalid");
    expect(refusal.detail).toContain("goal-nowhere");
    expect(outcome.events).toEqual([]);
  });

  test("a goal from another target cannot be ended from this one", async () => {
    const outcome = await withStore(newDatabasePath(), (store) =>
      Effect.gen(function* () {
        yield* store.openGoal(HOST, openInput());
        const crossed = yield* Effect.result(
          store.endGoal(
            { callerScope: "host/target-2", targetId: "target-2" },
            endInput(),
          ),
        );
        return {
          crossed,
          goal: yield* store.loadGoal("goal-new"),
          events: yield* store.eventsAfter(),
        };
      }),
    );

    const refusal = refusalOf(outcome.crossed);
    expect(refusal.reason).toBe("invalid");
    expect(refusal.detail).toContain("belongs to target target-1");
    expect(outcome.goal?.status).toBe("active");
    expect(outcome.events).toHaveLength(1);
  });

  test("ending a goal interrupts nothing: a running attempt under it is still running", async () => {
    const outcome = await withStore(newDatabasePath(), (store) =>
      Effect.gen(function* () {
        // The seeded goal is `goal-1`, with one intent and one running attempt.
        yield* migrated(store);
        yield* store.endGoal(HOST, endInput({ goalId: "goal-1" }));
        return {
          attempt: yield* store.loadAttempt("attempt-1", "target-1"),
          goal: yield* store.loadGoal("goal-1"),
        };
      }),
    );
    expect(outcome.goal?.status).toBe("met");
    expect(outcome.attempt?.status).toBe("running");
  });

  test("a goal that seedAttempt minted is active, unnamed, and counted", async () => {
    const goal = await withStore(newDatabasePath(), (store) =>
      Effect.gen(function* () {
        yield* migrated(store);
        yield* store.recordObservation(CALLER, multiCaseInput());
        return yield* store.loadGoal("goal-1");
      }),
    );
    expect(goal).toMatchObject({
      goalId: "goal-1",
      targetId: "target-1",
      name: "",
      status: "active",
      intentCount: 1,
      attemptCount: 1,
      observationCount: 1,
    });
  });

  test("counts are per goal, not multiplied across the tables that join them", async () => {
    const outcome = await withStore(newDatabasePath(), (store) =>
      Effect.gen(function* () {
        yield* migrated(store);
        // Two observations and a second attempt under goal-1's one intent: a join across
        // all three tables would report four of something here.
        yield* store.recordObservation(
          CALLER,
          multiCaseInput({ operationId: "o-1" }),
        );
        yield* store.recordObservation(
          CALLER,
          multiCaseInput({ operationId: "o-2" }),
        );
        yield* seed(store, "attempt-2");
        yield* store.openGoal(HOST, openInput());
        return yield* store.goals();
      }),
    );

    const byId = Object.fromEntries(outcome.map((goal) => [goal.goalId, goal]));
    expect(byId["goal-1"]).toMatchObject({
      intentCount: 1,
      attemptCount: 2,
      observationCount: 2,
    });
    // Nothing is under the new goal, and nothing leaks across from the other.
    expect(byId["goal-new"]).toMatchObject({
      intentCount: 0,
      attemptCount: 0,
      observationCount: 0,
    });
  });

  test("goals() returns this file's goals only, newest first", async () => {
    const [here, elsewhere] = await Promise.all([
      withStore(newDatabasePath(), (store) =>
        Effect.gen(function* () {
          yield* store.openGoal(HOST, openInput({ goalId: "goal-a" }));
          yield* store.openGoal(
            HOST,
            openInput({ operationId: "open-2", goalId: "goal-b" }),
          );
          return yield* store.goals();
        }),
      ),
      withStore(newDatabasePath(), (store) =>
        Effect.gen(function* () {
          yield* store.openGoal(
            { callerScope: "host/target-2", targetId: "target-2" },
            openInput({ operationId: "open-9", goalId: "goal-z" }),
          );
          return yield* store.goals();
        }),
      ),
    ]);

    // Each target's own file holds its own goals and nothing of the other's.
    expect(here.map((goal) => goal.goalId).sort()).toEqual([
      "goal-a",
      "goal-b",
    ]);
    expect(here.every((goal) => goal.targetId === "target-1")).toBe(true);
    expect(elsewhere.map((goal) => goal.goalId)).toEqual(["goal-z"]);
    expect(elsewhere[0]?.targetId).toBe("target-2");
  });

  test("a goal survives closing and reopening the file", async () => {
    const path = newDatabasePath();
    await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* store.openGoal(HOST, openInput());
        yield* store.endGoal(HOST, endInput({ status: "abandoned" }));
      }),
    );
    const goal = await withStore(path, (store) => store.loadGoal("goal-new"));
    expect(goal).toMatchObject({
      status: "abandoned",
      endedBy: "operator",
    });
  });

  test("a stored status outside the vocabulary is a typed error naming the row", async () => {
    const path = newDatabasePath();
    await withStore(path, (store) => store.openGoal(HOST, openInput()));
    const database = new Database(path);
    try {
      database.run(
        "UPDATE goals SET status = 'finished' WHERE id = 'goal-new'",
      );
    } finally {
      database.close();
    }

    const failed = await withStore(path, (store) =>
      Effect.result(store.loadGoal("goal-new")),
    );
    expect(failed._tag).toBe("Failure");
    if (failed._tag === "Failure") {
      expect(failed.failure).toBeInstanceOf(StoredRowError);
      expect((failed.failure as StoredRowError).rowId).toBe("goal-new");
    }
  });
});

describe("the intent lifecycle", () => {
  const HOST = { callerScope: "target-1/operator", targetId: "target-1" };

  /**
   * A goal and one open intent under it, made the way an operator makes them. A fresh
   * file per test, so nothing here depends on what another test left behind.
   */
  const withIntent = <A, E>(
    use: (store: Store) => Effect.Effect<A, E>,
    options: { readonly suggestion?: Record<string, unknown> } = {},
  ) =>
    withStore(newDatabasePath(), (store) =>
      Effect.gen(function* () {
        yield* store.openGoal(HOST, {
          operationId: "open-goal",
          goalId: "goal-L",
          name: "",
          description: "Work out how the limiter behaves.",
        });
        yield* store.addIntent(HOST, {
          operationId: "add-intent",
          goalId: "goal-L",
          intentId: "int-L",
          question: "Does the limiter reset on a new window?",
          anchorObservationIds: [],
          addressesDimension: null,
          ...options.suggestion,
        });
        return yield* use(store);
      }),
    );

  /** The row a run writes once it holds the claim: the attempt, under the claimed intent. */
  const startAttempt = (store: Store, attemptId: string) =>
    store.seedAttempt({
      targetId: "target-1",
      goalId: "goal-L",
      goal: "Work out how the limiter behaves.",
      intentId: "int-L",
      question: "Does the limiter reset on a new window?",
      attemptId,
      workerId: "worker-1",
      harnessInstanceId: "opencode",
      providerId: "openai",
      modelId: "gpt-5.6-sol",
      modelOptions: null,
      harnessSessionId: null,
    });

  const callerFor = (attemptId: string): AttemptCaller => ({
    _tag: "attempt",
    callerScope: `target-1/${attemptId}`,
    targetId: "target-1",
    intentId: "int-L",
    attemptId,
    harnessSessionId: "ses_abc",
    workerId: "worker-1",
    attemptFence: 0,
  });

  const statusOf = (store: Store) =>
    Effect.map(store.intent("int-L"), (intent) => ({
      status: intent?.status,
      claimedBy: intent?.claimedByAttemptId,
    }));

  /** The `ClaimRefused` a failed claim carries, or fails the test. */
  const claimRefusal = (result: {
    readonly _tag: string;
    readonly failure?: unknown;
  }): ClaimRefused => {
    expect(result._tag).toBe("Failure");
    expect(result.failure).toBeInstanceOf(ClaimRefused);
    return result.failure as ClaimRefused;
  };

  /** The `MutationError` a failed abandonment carries, or fails the test. */
  const mutationRefusal = (result: {
    readonly _tag: string;
    readonly failure?: unknown;
  }): MutationError => {
    expect(result._tag).toBe("Failure");
    expect(result.failure).toBeInstanceOf(MutationError);
    return result.failure as MutationError;
  };

  test("an intent added by hand is open, unclaimed and carries no suggestion", async () => {
    const intent = await withIntent((store) => store.intent("int-L"));
    expect(intent).toMatchObject({
      intentId: "int-L",
      goalId: "goal-L",
      targetId: "target-1",
      status: "open",
      claimedByAttemptId: null,
      attemptCount: 0,
      anchoredTo: [],
      addressesDimension: null,
      suggestion: { instanceId: null, model: null, modelOptions: null },
    });
  });

  test("a suggestion is stored as advice, an empty option list as none, and absent stays absent", async () => {
    const suggested = await withIntent((store) => store.intent("int-L"), {
      suggestion: {
        suggestedInstanceId: "claude-code",
        suggestedModel: "claude-sonnet-5",
        suggestedModelOptions: [
          { id: "effort", value: "high" },
          { id: "a-first", value: "x" },
        ],
      },
    });
    expect(suggested?.suggestion).toEqual({
      instanceId: "claude-code",
      model: "claude-sonnet-5",
      // One canonical order, so the same advice is the same bytes.
      modelOptions: [
        { id: "a-first", value: "x" },
        { id: "effort", value: "high" },
      ],
    });
    const empty = await withIntent((store) => store.intent("int-L"), {
      suggestion: { suggestedModelOptions: [] },
    });
    // An empty list would claim an opinion; it is stored as no opinion.
    expect(empty?.suggestion.modelOptions).toBeNull();
  });

  describe("claiming", () => {
    test("takes an open intent for one attempt and hands back what the run needs", async () => {
      const outcome = await withIntent((store) =>
        Effect.gen(function* () {
          const claim = yield* store.claimIntent(HOST, "int-L", "att-1");
          return { claim, after: yield* statusOf(store) };
        }),
      );
      expect(outcome.claim).toEqual({
        intentId: "int-L",
        goalId: "goal-L",
        goal: "Work out how the limiter behaves.",
        question: "Does the limiter reset on a new window?",
        suggestion: { instanceId: null, model: null, modelOptions: null },
        claimedByAttemptId: "att-1",
      });
      expect(outcome.after).toEqual({ status: "claimed", claimedBy: "att-1" });
    });

    test("two claims racing: exactly one wins, and the loser's refusal names the holder", async () => {
      const outcome = await withIntent((store) =>
        Effect.gen(function* () {
          const results = yield* Effect.all(
            [
              Effect.result(store.claimIntent(HOST, "int-L", "att-a")),
              Effect.result(store.claimIntent(HOST, "int-L", "att-b")),
            ],
            { concurrency: "unbounded" },
          );
          return { results, after: yield* statusOf(store) };
        }),
      );
      const wins = outcome.results.filter((r) => r._tag === "Success");
      const losses = outcome.results.filter((r) => r._tag === "Failure");
      expect(wins).toHaveLength(1);
      expect(losses).toHaveLength(1);
      const winner = wins[0];
      const loser = losses[0];
      if (winner?._tag !== "Success" || loser?._tag !== "Failure") {
        throw new Error("expected one success and one failure");
      }
      const refusal = claimRefusal(loser);
      expect(refusal).toMatchObject({
        reason: "not_open",
        heldBy: winner.success.claimedByAttemptId,
      });
      expect(refusal.detail).toContain(winner.success.claimedByAttemptId);
      // And the row names the winner, not whoever wrote last.
      expect(outcome.after.claimedBy).toBe(winner.success.claimedByAttemptId);
    });

    test("a second claim of a claimed intent is refused naming the first attempt", async () => {
      const refusal = await withIntent((store) =>
        Effect.gen(function* () {
          yield* store.claimIntent(HOST, "int-L", "att-1");
          return yield* Effect.result(
            store.claimIntent(HOST, "int-L", "att-2"),
          );
        }),
      );
      expect(claimRefusal(refusal)).toMatchObject({
        reason: "not_open",
        heldBy: "att-1",
      });
    });

    test("an intent that is not there, and another target's, are refused each for what it is", async () => {
      const outcome = await withIntent((store) =>
        Effect.gen(function* () {
          return {
            missing: yield* Effect.result(
              store.claimIntent(HOST, "int-nonesuch", "att-1"),
            ),
            crossed: yield* Effect.result(
              store.claimIntent(
                { callerScope: "target-2/operator", targetId: "target-2" },
                "int-L",
                "att-1",
              ),
            ),
            after: yield* statusOf(store),
          };
        }),
      );
      expect(claimRefusal(outcome.missing)).toMatchObject({
        reason: "no_such_intent",
      });
      expect(claimRefusal(outcome.crossed)).toMatchObject({
        reason: "other_target",
      });
      expect(claimRefusal(outcome.crossed).detail).toContain("target-1");
      // Neither refusal touched the row.
      expect(outcome.after).toEqual({ status: "open", claimedBy: null });
    });

    test("an intent under an ended goal is refused, naming the goal's status, and stays open", async () => {
      const outcome = await withIntent((store) =>
        Effect.gen(function* () {
          yield* store.endGoal(HOST, {
            operationId: "end-goal",
            goalId: "goal-L",
            status: "abandoned",
            endedBy: "operator",
            reason: "superseded",
          });
          return {
            refusal: yield* Effect.result(
              store.claimIntent(HOST, "int-L", "att-1"),
            ),
            after: yield* statusOf(store),
          };
        }),
      );
      expect(claimRefusal(outcome.refusal)).toMatchObject({
        reason: "goal_not_active",
      });
      expect(claimRefusal(outcome.refusal).detail).toContain("abandoned");
      expect(outcome.after).toEqual({ status: "open", claimedBy: null });
    });

    test("an answered or abandoned intent is not claimable", async () => {
      const outcome = await withIntent((store) =>
        Effect.gen(function* () {
          yield* store.abandonIntent(HOST, {
            operationId: "abandon",
            intentId: "int-L",
            reason: "",
          });
          return yield* Effect.result(
            store.claimIntent(HOST, "int-L", "att-1"),
          );
        }),
      );
      expect(claimRefusal(outcome)).toMatchObject({
        reason: "not_open",
        heldBy: null,
      });
      expect(claimRefusal(outcome).detail).toContain("abandoned");
    });
  });

  describe("settlement releases the claim in the same transaction", () => {
    /** Claim, start the attempt, optionally record an observation, then settle it. */
    const settleWith = (
      status: "succeeded" | "failed" | "interrupted" | "uncertain",
      observation: boolean,
    ) =>
      withIntent((store) =>
        Effect.gen(function* () {
          yield* store.claimIntent(HOST, "int-L", "att-1");
          yield* startAttempt(store, "att-1");
          if (observation) {
            yield* store.recordObservation(
              callerFor("att-1"),
              multiCaseInput({ operationId: "obs-1" }),
            );
          }
          const held = yield* statusOf(store);
          const settlement = yield* store.settleAttempt("att-1", status);
          return { held, settlement, after: yield* statusOf(store) };
        }),
      );

    test("succeeded with an observation under it: answered", async () => {
      const outcome = await settleWith("succeeded", true);
      expect(outcome.held.status).toBe("claimed");
      expect(outcome.settlement.changed).toBe(true);
      expect(outcome.after).toEqual({ status: "answered", claimedBy: null });
    });

    test("succeeded with nothing recorded: open, because no evidence is not an answer", async () => {
      const outcome = await settleWith("succeeded", false);
      expect(outcome.after).toEqual({ status: "open", claimedBy: null });
    });

    for (const status of ["failed", "interrupted", "uncertain"] as const) {
      test(`${status}: open, even with an observation recorded`, async () => {
        const outcome = await settleWith(status, true);
        // An attempt that did not finish saying what it found never answers the intent,
        // whatever it managed to write on the way.
        expect(outcome.after).toEqual({ status: "open", claimedBy: null });
      });
    }

    test("the intent and the attempt change together or not at all", async () => {
      const path = newDatabasePath();
      // A settlement whose event write raises must leave the claim held, not freed.
      await withStore(path, (store) =>
        Effect.gen(function* () {
          yield* store.openGoal(HOST, {
            operationId: "open-goal",
            goalId: "goal-L",
            name: "",
            description: "g",
          });
          yield* store.addIntent(HOST, {
            operationId: "add-intent",
            goalId: "goal-L",
            intentId: "int-L",
            question: "q",
            anchorObservationIds: [],
            addressesDimension: null,
          });
          yield* store.claimIntent(HOST, "int-L", "att-1");
          yield* startAttempt(store, "att-1");
        }),
      );
      const database = new Database(path);
      try {
        // The log's insert is made to fail, which is the last statement of a settlement.
        database.run(
          "CREATE TRIGGER refuse_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'no events'); END",
        );
      } finally {
        database.close();
      }
      const outcome = await withStore(path, (store) =>
        Effect.gen(function* () {
          const failed = yield* Effect.result(
            store.settleAttempt("att-1", "succeeded"),
          );
          return {
            failed,
            attempt: yield* store.loadAttempt("att-1", "target-1"),
            intent: yield* statusOf(store),
          };
        }),
      );
      expect(outcome.failed._tag).toBe("Failure");
      expect(outcome.attempt?.status).toBe("running");
      expect(outcome.intent).toEqual({ status: "claimed", claimedBy: "att-1" });
    });

    test("the recovery sweep releases a claim too, and a definite answer answers it", async () => {
      const outcome = await withIntent((store) =>
        Effect.gen(function* () {
          yield* store.claimIntent(HOST, "int-L", "att-1");
          yield* startAttempt(store, "att-1");
          yield* store.recordObservation(
            callerFor("att-1"),
            multiCaseInput({ operationId: "obs-1" }),
          );
          yield* store.recordRecovery({
            attemptId: "att-1",
            observed: "succeeded",
            proposedStatus: "succeeded",
            detail: "the harness says it finished",
          });
          return yield* statusOf(store);
        }),
      );
      expect(outcome).toEqual({ status: "answered", claimedBy: null });
    });

    test("the sweep reconciling to uncertain returns the intent to open", async () => {
      const outcome = await withIntent((store) =>
        Effect.gen(function* () {
          yield* store.claimIntent(HOST, "int-L", "att-1");
          yield* startAttempt(store, "att-1");
          yield* store.recordObservation(
            callerFor("att-1"),
            multiCaseInput({ operationId: "obs-1" }),
          );
          yield* store.recordRecovery({
            attemptId: "att-1",
            observed: "missing",
            proposedStatus: "uncertain",
            detail: "session not found",
          });
          return yield* statusOf(store);
        }),
      );
      expect(outcome).toEqual({ status: "open", claimedBy: null });
    });

    test("an attempt that never held the claim frees nothing", async () => {
      const outcome = await withIntent((store) =>
        Effect.gen(function* () {
          // att-1 holds the claim; att-2 is another attempt on the same intent that does
          // not — the shape a replacement attempt has — and settling it must not release
          // att-1's.
          yield* store.claimIntent(HOST, "int-L", "att-1");
          yield* startAttempt(store, "att-1");
          yield* startAttempt(store, "att-2");
          yield* store.settleAttempt("att-2", "failed");
          return yield* statusOf(store);
        }),
      );
      expect(outcome).toEqual({ status: "claimed", claimedBy: "att-1" });
    });
  });

  describe("releasing without a settlement", () => {
    test("gives a claimed intent back, and only to the attempt that held it", async () => {
      const outcome = await withIntent((store) =>
        Effect.gen(function* () {
          yield* store.claimIntent(HOST, "int-L", "att-1");
          yield* store.releaseIntent("int-L", "refused", "att-someone-else");
          const wrongHolder = yield* statusOf(store);
          yield* store.releaseIntent("int-L", "refused", "att-1");
          const rightHolder = yield* statusOf(store);
          // Nothing claimed any more: a further release is not an error and not a change.
          yield* store.releaseIntent("int-L", "refused", "att-1");
          return { wrongHolder, rightHolder, again: yield* statusOf(store) };
        }),
      );
      expect(outcome.wrongHolder).toEqual({
        status: "claimed",
        claimedBy: "att-1",
      });
      expect(outcome.rightHolder).toEqual({ status: "open", claimedBy: null });
      expect(outcome.again).toEqual({ status: "open", claimedBy: null });
    });

    test("is not a way to answer an intent", async () => {
      const outcome = await withIntent((store) =>
        Effect.gen(function* () {
          yield* store.claimIntent(HOST, "int-L", "att-1");
          yield* store.releaseIntent("int-L", "refused", "att-1");
          return yield* statusOf(store);
        }),
      );
      expect(outcome.status).toBe("open");
    });
  });

  describe("abandoning", () => {
    const abandon = (overrides = {}) => ({
      operationId: "abandon-1",
      intentId: "int-L",
      reason: "No longer relevant.",
      ...overrides,
    });

    test("drops an open intent, once, and records it in the log", async () => {
      const outcome = await withIntent((store) =>
        Effect.gen(function* () {
          const result = yield* store.abandonIntent(HOST, abandon());
          const replay = yield* store.abandonIntent(HOST, abandon());
          const events = yield* store.eventsAfter();
          return {
            result,
            replay,
            after: yield* statusOf(store),
            events: events.filter((e) => e.kind === "intent.abandoned"),
          };
        }),
      );
      expect(outcome.result).toEqual({ intentId: "int-L", replayed: false });
      expect(outcome.replay).toEqual({ intentId: "int-L", replayed: true });
      expect(outcome.after.status).toBe("abandoned");
      // One event, not two: the replay wrote nothing.
      expect(outcome.events).toHaveLength(1);
      expect(outcome.events[0]).toMatchObject({
        subjectId: "int-L",
        callerScope: "target-1/operator",
        attemptId: null,
        payload: {
          intentId: "int-L",
          goalId: "goal-L",
          reason: "No longer relevant.",
        },
      });
    });

    test("a claimed intent is refused, naming the attempt running it", async () => {
      const outcome = await withIntent((store) =>
        Effect.gen(function* () {
          yield* store.claimIntent(HOST, "int-L", "att-1");
          return {
            refusal: yield* Effect.result(store.abandonIntent(HOST, abandon())),
            after: yield* statusOf(store),
          };
        }),
      );
      const error = mutationRefusal(outcome.refusal);
      expect(error).toBeInstanceOf(MutationError);
      expect(error.reason).toBe("conflict");
      expect(error.detail).toContain("att-1");
      expect(outcome.after.status).toBe("claimed");
    });

    test("an answered intent is refused, and so is a second abandonment", async () => {
      const outcome = await withIntent((store) =>
        Effect.gen(function* () {
          yield* store.claimIntent(HOST, "int-L", "att-1");
          yield* startAttempt(store, "att-1");
          yield* store.recordObservation(
            callerFor("att-1"),
            multiCaseInput({ operationId: "obs-1" }),
          );
          yield* store.settleAttempt("att-1", "succeeded");
          const answered = yield* Effect.result(
            store.abandonIntent(HOST, abandon()),
          );
          return answered;
        }),
      );
      expect(mutationRefusal(outcome).detail).toContain("answered");

      const twice = await withIntent((store) =>
        Effect.gen(function* () {
          yield* store.abandonIntent(HOST, abandon());
          return yield* Effect.result(
            store.abandonIntent(HOST, abandon({ operationId: "abandon-2" })),
          );
        }),
      );
      expect(mutationRefusal(twice).detail).toContain("already abandoned");
    });

    test("a missing intent and another target's are `invalid`, and a reused operation id is a conflict", async () => {
      const outcome = await withIntent((store) =>
        Effect.gen(function* () {
          yield* store.abandonIntent(HOST, abandon());
          return {
            missing: yield* Effect.result(
              store.abandonIntent(
                HOST,
                abandon({ operationId: "abandon-3", intentId: "int-nonesuch" }),
              ),
            ),
            crossed: yield* Effect.result(
              store.abandonIntent(
                { callerScope: "target-2/operator", targetId: "target-2" },
                abandon({ operationId: "abandon-4" }),
              ),
            ),
            reused: yield* Effect.result(
              store.abandonIntent(HOST, abandon({ reason: "different" })),
            ),
          };
        }),
      );
      expect(mutationRefusal(outcome.missing).reason).toBe("invalid");
      expect(mutationRefusal(outcome.crossed).reason).toBe("invalid");
      expect(mutationRefusal(outcome.crossed).detail).toContain("target-1");
      expect(mutationRefusal(outcome.reused).reason).toBe("conflict");
    });
  });

  describe("reading a goal's intents", () => {
    test("oldest first, each with anchors, suggestion, dimension alias and attempt count", async () => {
      const outcome = await withIntent((store) =>
        Effect.gen(function* () {
          // Evidence under int-L to anchor to and to raise a dimension from.
          yield* store.claimIntent(HOST, "int-L", "att-1");
          yield* startAttempt(store, "att-1");
          const raised = yield* store.recordObservation(
            callerFor("att-1"),
            multiCaseInput({
              operationId: "obs-1",
              untestedDimensions: ["no window rollover was measured"],
            }),
          );
          yield* store.settleAttempt("att-1", "succeeded");
          yield* store.addIntent(HOST, {
            operationId: "add-2",
            goalId: "goal-L",
            intentId: "int-M",
            question: "Is rollover measured?",
            anchorObservationIds: [raised.observationId],
            addressesDimension: dimensionAddress(raised.observationId, 0),
            suggestedInstanceId: "opencode",
          });
          return {
            raised: raised.observationId,
            intents: yield* store.intentsForGoal("goal-L"),
            none: yield* store.intentsForGoal("goal-nonesuch"),
          };
        }),
      );
      expect(outcome.intents.map((i) => i.intentId)).toEqual([
        "int-L",
        "int-M",
      ]);
      expect(outcome.intents[0]).toMatchObject({
        status: "answered",
        attemptCount: 1,
        anchoredTo: [],
      });
      expect(outcome.intents[1]).toMatchObject({
        status: "open",
        attemptCount: 0,
        anchoredTo: [outcome.raised],
        addressesDimension: dimensionAddress(outcome.raised, 0),
        suggestion: { instanceId: "opencode", model: null },
      });
      expect(outcome.none).toEqual([]);
    });

    test("a stored status outside the vocabulary is a typed error naming the row", async () => {
      const path = newDatabasePath();
      await withStore(path, (store) =>
        Effect.gen(function* () {
          yield* store.openGoal(HOST, {
            operationId: "open-goal",
            goalId: "goal-L",
            name: "",
            description: "g",
          });
          yield* store.addIntent(HOST, {
            operationId: "add-intent",
            goalId: "goal-L",
            intentId: "int-L",
            question: "q",
            anchorObservationIds: [],
            addressesDimension: null,
          });
        }),
      );
      const database = new Database(path);
      try {
        database.run(
          "UPDATE intents SET status = 'finished' WHERE id = 'int-L'",
        );
      } finally {
        database.close();
      }
      const failed = await withStore(path, (store) =>
        Effect.result(store.intent("int-L")),
      );
      expect(failed._tag).toBe("Failure");
      if (failed._tag === "Failure") {
        expect(failed.failure).toBeInstanceOf(StoredRowError);
        expect((failed.failure as StoredRowError).rowId).toContain("int-L");
      }
    });
  });

  test("an intent a legacy run minted is open and its settlement frees nothing it never held", async () => {
    const outcome = await withStore(newDatabasePath(), (store) =>
      Effect.gen(function* () {
        // `seedAttempt` still mints a goal and an intent when given ids that do not
        // exist, which is what the pre-lifecycle path did. Such an intent is `open`.
        yield* seed(store);
        const before = yield* store.intent("intent-1");
        yield* store.recordObservation(CALLER, multiCaseInput());
        yield* store.settleAttempt("attempt-1", "succeeded");
        return { before, after: yield* store.intent("intent-1") };
      }),
    );
    expect(outcome.before?.status).toBe("open");
    // Never claimed, so there was no claim to turn into an answer.
    expect(outcome.after?.status).toBe("open");
  });
});

/* ── Round identity and the three authority paths ────────────────────────────── */

/**
 * Slice 4's whole subject: a planner round is a row, and the store can tell three kinds
 * of caller apart.
 *
 * Nothing here creates a session or calls a tool. What is checked is the part a later
 * slice would otherwise find out the hard way: that a credential of one kind cannot write
 * as another, that a round's authority ends when the round does, and that a goal's ends
 * when the goal does.
 */
describe("a planner round", () => {
  const HOST = { callerScope: operatorScope("target-1"), targetId: "target-1" };
  const OTHER_HOST = {
    callerScope: operatorScope("target-2"),
    targetId: "target-2",
  };

  const openRoundInput = (
    overrides: Partial<{
      goalId: string;
      roundId: string;
      budget: number;
    }> = {},
  ) => ({
    goalId: "goal-1",
    roundId: "rnd-1",
    budget: 3,
    harnessInstanceId: null,
    providerId: null,
    modelId: null,
    harnessSessionId: null,
    ...overrides,
  });

  /** A seeded target, goal and attempt, so every id these tests name exists. */
  const withSeeded = <A, E>(use: (store: Store) => Effect.Effect<A, E>) =>
    withStore(newDatabasePath(), (store) =>
      Effect.gen(function* () {
        yield* seed(store);
        return yield* use(store);
      }),
    );

  const roundCallerFor = (
    roundId: string,
    roundFence = 0,
    goalId = "goal-1",
    targetId = "target-1",
  ): CallerContext => ({
    _tag: "round",
    callerScope: callerScopeOf({ _tag: "round", targetId, roundId }),
    targetId,
    goalId,
    roundId,
    roundFence,
  });

  test("opens as a row with its own identity, fence and budget", async () => {
    const outcome = await withSeeded((store) =>
      Effect.gen(function* () {
        const authority = yield* store.openRound(HOST, openRoundInput());
        return { authority, round: yield* store.loadRound("rnd-1") };
      }),
    );

    expect(outcome.authority).toEqual({
      roundId: "rnd-1",
      writeFence: 0,
      startedAtSequence: 0,
    });
    expect(outcome.round).toMatchObject({
      roundId: "rnd-1",
      goalId: "goal-1",
      targetId: "target-1",
      status: "running",
      writeFence: 0,
      budget: 3,
      // Null until the planner says, which is a different fact from any of the four
      // dispositions — including `no_useful_next_action`, which is a considered answer.
      disposition: null,
      endedAt: null,
      harnessSessionId: null,
    });
  });

  test("records where the graph stood as provenance, not as a snapshot", async () => {
    // `started_at_sequence` is the sequence when the round opened. The planner reads the
    // graph live and sees writes that land after it — including its own — so this test
    // asserts both halves: the recorded number does not move, and a read taken after a
    // later write returns the later write.
    const outcome = await withSeeded((store) =>
      Effect.gen(function* () {
        yield* store.recordObservation(CALLER, multiCaseInput());
        const authority = yield* store.openRound(HOST, openRoundInput());
        const atOpen = yield* store.currentSequence;
        yield* store.recordObservation(
          CALLER,
          multiCaseInput({ operationId: "after-the-round-opened" }),
        );
        return {
          authority,
          atOpen,
          later: yield* store.currentSequence,
          round: yield* store.loadRound("rnd-1"),
          live: yield* store.observationsForIntent("intent-1"),
        };
      }),
    );

    expect(outcome.authority.startedAtSequence).toBe(1);
    expect(outcome.atOpen).toBe(1);
    expect(outcome.later).toBe(2);
    // Unmoved by the write that followed it.
    expect(outcome.round?.startedAtSequence).toBe(1);
    // And the graph a round reads is the current one, which is the point of saying this
    // column is provenance rather than a consistency boundary.
    expect(outcome.live).toHaveLength(2);
  });

  test("a second running round on one goal is refused, naming the holder", async () => {
    const failure = await withSeeded((store) =>
      Effect.gen(function* () {
        yield* store.openRound(HOST, openRoundInput());
        return yield* Effect.result(
          store.openRound(HOST, openRoundInput({ roundId: "rnd-2" })),
        );
      }),
    );

    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") {
      const error = failure.failure as MutationError;
      expect(error.reason).toBe("conflict");
      expect(error.detail).toContain("rnd-1");
      expect(error.detail).toContain(
        "one planner round works a goal at a time",
      );
    }
  });

  test("a settled round's goal can take another round", async () => {
    // The exclusivity is about *running* rounds. A goal is worked over many rounds.
    const outcome = await withSeeded((store) =>
      Effect.gen(function* () {
        yield* store.openRound(HOST, openRoundInput());
        yield* store.settleRound("rnd-1", "settled", { _tag: "supervisor" });
        const second = yield* store.openRound(
          HOST,
          openRoundInput({ roundId: "rnd-2" }),
        );
        return { second, round: yield* store.loadRound("rnd-2") };
      }),
    );
    expect(outcome.second.roundId).toBe("rnd-2");
    expect(outcome.round?.status).toBe("running");
  });

  test("a round id is never reused", async () => {
    const failure = await withSeeded((store) =>
      Effect.gen(function* () {
        yield* store.openRound(HOST, openRoundInput());
        yield* store.settleRound("rnd-1", "settled", { _tag: "supervisor" });
        return yield* Effect.result(store.openRound(HOST, openRoundInput()));
      }),
    );

    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") {
      const error = failure.failure as MutationError;
      expect(error.reason).toBe("conflict");
      expect(error.detail).toContain("already exists");
    }
  });

  test("an ended goal takes no new round, and the refusal names its status", async () => {
    // Decision 8: ending a goal blocks new dispatch and planner wake-ups. Opening a
    // round is a planner wake-up.
    const failure = await withSeeded((store) =>
      Effect.gen(function* () {
        yield* store.endGoal(HOST, {
          operationId: "end-1",
          goalId: "goal-1",
          status: "met",
          endedBy: "operator",
          reason: "the objective was established",
        });
        return yield* Effect.result(store.openRound(HOST, openRoundInput()));
      }),
    );

    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") {
      const error = failure.failure as MutationError;
      expect(error.reason).toBe("invalid");
      expect(error.detail).toContain("is met");
    }
  });

  test("a host cannot open a round on another target's goal", async () => {
    const failure = await withSeeded((store) =>
      Effect.result(store.openRound(OTHER_HOST, openRoundInput())),
    );

    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") {
      const error = failure.failure as MutationError;
      expect(error.reason).toBe("unauthorized");
      expect(error.detail).toContain("does not belong to target target-2");
    }
  });

  test("records a disposition once, and refuses a second", async () => {
    const outcome = await withSeeded((store) =>
      Effect.gen(function* () {
        yield* store.openRound(HOST, openRoundInput());
        const first = yield* store.recordRoundDisposition(
          roundCallerFor("rnd-1"),
          "actionable",
          "because the test said so",
        );
        const second = yield* Effect.result(
          store.recordRoundDisposition(
            roundCallerFor("rnd-1"),
            "waiting",
            "because the test said so",
          ),
        );
        return { first, second, round: yield* store.loadRound("rnd-1") };
      }),
    );

    expect(outcome.first).toMatchObject({
      roundId: "rnd-1",
      disposition: "actionable",
      rationale: "because the test said so",
      // `actionable` is not `objective_met`, so no goal was ended by it.
      goalEnded: false,
    });
    expect(outcome.round?.disposition).toBe("actionable");
    expect(outcome.second._tag).toBe("Failure");
    if (outcome.second._tag === "Failure") {
      const error = outcome.second.failure as MutationError;
      expect(error.reason).toBe("conflict");
      expect(error.detail).toContain("already recorded the disposition");
      expect(error.detail).toContain("NOT recorded");
    }
  });

  test("settling leaves a recorded disposition alone and does not invent one", async () => {
    const outcome = await withSeeded((store) =>
      Effect.gen(function* () {
        yield* store.openRound(HOST, openRoundInput());
        // `waiting` rather than `objective_met`: this test is about settlement leaving a
        // disposition alone, and `objective_met` also *ends the goal*, which would make
        // the second `openRound` below refuse `goal_not_active` for an entirely correct
        // reason that has nothing to do with what is being checked. The ending itself is
        // asserted in its own test.
        yield* store.recordRoundDisposition(
          roundCallerFor("rnd-1"),
          "waiting",
          "because the test said so",
        );
        const settled = yield* store.settleRound("rnd-1", "settled", {
          _tag: "supervisor",
        });
        yield* store.openRound(HOST, openRoundInput({ roundId: "rnd-2" }));
        const interrupted = yield* store.settleRound("rnd-2", "interrupted", {
          _tag: "supervisor",
        });
        return {
          settled,
          interrupted,
          first: yield* store.loadRound("rnd-1"),
          second: yield* store.loadRound("rnd-2"),
        };
      }),
    );

    expect(outcome.settled).toEqual({
      requested: "settled",
      effective: "settled",
      changed: true,
    });
    expect(outcome.first?.disposition).toBe("waiting");
    // A round that never concluded settles with none, which is the honest record.
    expect(outcome.second?.status).toBe("interrupted");
    expect(outcome.second?.disposition).toBeNull();
  });

  test("settling twice changes nothing and says so", async () => {
    const outcome = await withSeeded((store) =>
      Effect.gen(function* () {
        yield* store.openRound(HOST, openRoundInput());
        yield* store.settleRound("rnd-1", "uncertain", { _tag: "supervisor" });
        return {
          again: yield* store.settleRound("rnd-1", "settled", {
            _tag: "supervisor",
          }),
          missing: yield* store.settleRound("rnd-absent", "settled", {
            _tag: "supervisor",
          }),
          round: yield* store.loadRound("rnd-1"),
        };
      }),
    );

    expect(outcome.again).toEqual({
      requested: "settled",
      effective: "uncertain",
      changed: false,
    });
    expect(outcome.missing).toEqual({
      requested: "settled",
      effective: undefined,
      changed: false,
    });
    expect(outcome.round?.status).toBe("uncertain");
  });

  test("superseding bumps the fence and answers nothing for a round that does not exist", async () => {
    const outcome = await withSeeded((store) =>
      Effect.gen(function* () {
        yield* store.openRound(HOST, openRoundInput());
        return {
          first: yield* store.supersedeRound("rnd-1"),
          second: yield* store.supersedeRound("rnd-1"),
          absent: yield* store.supersedeRound("rnd-absent"),
          round: yield* store.loadRound("rnd-1"),
        };
      }),
    );

    expect(outcome.first).toBe(1);
    expect(outcome.second).toBe(2);
    expect(outcome.absent).toBeUndefined();
    expect(outcome.round?.writeFence).toBe(2);
    // Superseding is not settling: a sweep that cannot tell how a round ended still has
    // to stop its credential, and claiming it settled would be claiming to know.
    expect(outcome.round?.status).toBe("running");
  });
});

describe("telling three kinds of caller apart", () => {
  const HOST = { callerScope: operatorScope("target-1"), targetId: "target-1" };

  const roundCaller = (roundFence = 0, roundId = "rnd-1"): CallerContext => ({
    _tag: "round",
    callerScope: callerScopeOf({
      _tag: "round",
      targetId: "target-1",
      roundId,
    }),
    targetId: "target-1",
    goalId: "goal-1",
    roundId,
    roundFence,
  });

  const goalCaller = (goalId = "goal-1"): CallerContext => ({
    _tag: "goal",
    callerScope: callerScopeOf({ _tag: "goal", targetId: "target-1", goalId }),
    targetId: "target-1",
    goalId,
  });

  const withRound = <A, E>(use: (store: Store) => Effect.Effect<A, E>) =>
    withStore(newDatabasePath(), (store) =>
      Effect.gen(function* () {
        yield* seed(store);
        yield* store.openRound(HOST, {
          goalId: "goal-1",
          roundId: "rnd-1",
          budget: 3,
          harnessInstanceId: null,
          providerId: null,
          modelId: null,
          harnessSessionId: null,
        });
        return yield* use(store);
      }),
    );

  const refusal = (result: {
    _tag: string;
    failure?: unknown;
  }): MutationError => result.failure as MutationError;

  test("an attempt credential is refused for a round write", async () => {
    const failure = await withRound((store) =>
      Effect.result(
        store.recordRoundDisposition(
          CALLER,
          "actionable",
          "because the test said so",
        ),
      ),
    );

    expect(failure._tag).toBe("Failure");
    const error = refusal(failure);
    expect(error.reason).toBe("unauthorized");
    expect(error.detail).toContain("attempt attempt-1 (a worker)");
    expect(error.detail).toContain("may not record a round disposition");
    expect(error.detail).toContain("nothing was recorded");
  });

  test("a round credential is refused for an observation", async () => {
    const failure = await withRound((store) =>
      Effect.result(store.recordObservation(roundCaller(), multiCaseInput())),
    );

    expect(failure._tag).toBe("Failure");
    const error = refusal(failure);
    expect(error.reason).toBe("unauthorized");
    expect(error.detail).toContain(
      "round rnd-1 (a planner round on goal goal-1)",
    );
    expect(error.detail).toContain("may not record an observation");
  });

  test("a round credential is refused for an asset", async () => {
    const failure = await withRound((store) =>
      Effect.result(
        store.recordAsset(roundCaller(), {
          operationId: "asset-round",
          kind: "endpoint",
          url: "http://127.0.0.1:41317/login",
          method: "post",
          note: "a planner has no business recording this",
        }),
      ),
    );

    expect(failure._tag).toBe("Failure");
    expect(refusal(failure).reason).toBe("unauthorized");
    expect(refusal(failure).detail).toContain("may not record an asset");
  });

  test("a goal credential is refused everything a goal may not write", async () => {
    const outcome = await withRound((store) =>
      Effect.all({
        observation: Effect.result(
          store.recordObservation(goalCaller(), multiCaseInput()),
        ),
        disposition: Effect.result(
          store.recordRoundDisposition(
            goalCaller(),
            "actionable",
            "because the test said so",
          ),
        ),
        asset: Effect.result(
          store.recordAsset(goalCaller(), {
            operationId: "asset-goal",
            kind: "host",
            url: "http://127.0.0.1:41317/",
            method: null,
            note: "nor this",
          }),
        ),
      }),
    );

    for (const result of [
      outcome.observation,
      outcome.disposition,
      outcome.asset,
    ]) {
      expect(result._tag).toBe("Failure");
      const error = refusal(result);
      expect(error.reason).toBe("unauthorized");
      expect(error.detail).toContain("the goal agent for goal goal-1");
    }
  });

  test("nothing a refused caller sent reaches the graph", async () => {
    // The refusals above are only worth having if they are also writes that did not
    // happen: no observation, no disposition, and no sequence consumed.
    const outcome = await withRound((store) =>
      Effect.gen(function* () {
        yield* Effect.result(
          store.recordObservation(roundCaller(), multiCaseInput()),
        );
        yield* Effect.result(
          store.recordRoundDisposition(
            goalCaller(),
            "actionable",
            "because the test said so",
          ),
        );
        return {
          observations: yield* store.observationsForIntent("intent-1"),
          sequence: yield* store.currentSequence,
          round: yield* store.loadRound("rnd-1"),
        };
      }),
    );

    expect(outcome.observations).toEqual([]);
    expect(outcome.sequence).toBe(0);
    expect(outcome.round?.disposition).toBeNull();
  });

  test("each kind's authority is answered in the kind it was asked", async () => {
    const outcome = await withRound((store) =>
      Effect.all({
        attempt: store.callerAuthority(CALLER),
        round: store.callerAuthority(roundCaller()),
        goal: store.callerAuthority(goalCaller()),
      }),
    );

    expect(outcome.attempt).toEqual({
      _tag: "attempt",
      attemptId: "attempt-1",
      intentId: "intent-1",
      targetId: "target-1",
      fence: 0,
    });
    expect(outcome.round).toEqual({
      _tag: "round",
      roundId: "rnd-1",
      goalId: "goal-1",
      targetId: "target-1",
      fence: 0,
    });
    expect(outcome.goal).toEqual({
      _tag: "goal",
      goalId: "goal-1",
      targetId: "target-1",
    });
  });

  test("a settled round's credential is refused as stale, naming the status", async () => {
    const failure = await withRound((store) =>
      Effect.gen(function* () {
        yield* store.settleRound("rnd-1", "settled", { _tag: "supervisor" });
        return yield* Effect.result(
          store.recordRoundDisposition(
            roundCaller(),
            "actionable",
            "because the test said so",
          ),
        );
      }),
    );

    expect(failure._tag).toBe("Failure");
    const error = refusal(failure);
    expect(error.reason).toBe("stale");
    expect(error.detail).toContain("round rnd-1 is settled");
    expect(error.detail).toContain(
      "its write authority ended when it stopped running",
    );
  });

  test("a superseded round's credential is refused as stale, naming both fences", async () => {
    const failure = await withRound((store) =>
      Effect.gen(function* () {
        yield* store.supersedeRound("rnd-1");
        // The credential still carries fence 0, which is what a grant minted before the
        // sweep would hold. The round is at 1.
        return yield* Effect.result(
          store.recordRoundDisposition(
            roundCaller(0),
            "actionable",
            "because the test said so",
          ),
        );
      }),
    );

    expect(failure._tag).toBe("Failure");
    const error = refusal(failure);
    expect(error.reason).toBe("stale");
    expect(error.detail).toContain(
      "write authority for round rnd-1 was revoked",
    );
    expect(error.detail).toContain("carries fence 0");
    expect(error.detail).toContain("the round is at 1");
  });

  test("a credential reissued against the current fence works again", async () => {
    // The fence is an epoch, not a kill switch: a replacement round credential minted
    // against the bumped fence is live authority.
    const outcome = await withRound((store) =>
      Effect.gen(function* () {
        const fence = yield* store.supersedeRound("rnd-1");
        return yield* store.recordRoundDisposition(
          roundCaller(fence ?? 0),
          "waiting",
          "because the test said so",
        );
      }),
    );
    expect(outcome.disposition).toBe("waiting");
  });

  test("a round credential naming another goal is refused as unauthorized", async () => {
    const failure = await withRound((store) =>
      Effect.result(
        store.recordRoundDisposition(
          {
            _tag: "round",
            callerScope: "target-1/round/rnd-1",
            targetId: "target-1",
            goalId: "goal-elsewhere",
            roundId: "rnd-1",
            roundFence: 0,
          },
          "actionable",
          "because the test said so",
        ),
      ),
    );

    expect(failure._tag).toBe("Failure");
    const error = refusal(failure);
    expect(error.reason).toBe("unauthorized");
    expect(error.detail).toContain(
      "round rnd-1 is not registered for target target-1 and goal goal-elsewhere",
    );
  });

  test("an ended goal's credential is refused, naming the status", async () => {
    const failure = await withRound((store) =>
      Effect.gen(function* () {
        yield* store.endGoal(HOST, {
          operationId: "end-1",
          goalId: "goal-1",
          status: "abandoned",
          endedBy: "operator",
          reason: "out of scope",
        });
        return yield* Effect.result(store.callerAuthority(goalCaller()));
      }),
    );

    expect(failure._tag).toBe("Failure");
    const error = refusal(failure);
    expect(error.reason).toBe("stale");
    expect(error.detail).toContain("goal goal-1 is abandoned");
    expect(error.detail).toContain("its authority ended when the goal ended");
  });

  test("a goal credential for another target's goal is refused", async () => {
    const failure = await withRound((store) =>
      Effect.result(
        store.callerAuthority({
          _tag: "goal",
          callerScope: "target-2/goal/goal-1",
          targetId: "target-2",
          goalId: "goal-1",
        }),
      ),
    );

    expect(failure._tag).toBe("Failure");
    const error = refusal(failure);
    expect(error.reason).toBe("unauthorized");
    expect(error.detail).toContain(
      "goal goal-1 is not registered for target target-2",
    );
  });

  test("no two kinds of caller can produce the same scope string", async () => {
    // Asserted on constructed scopes rather than by reading the builder: the claim is
    // about the strings, and every id in one is minted by `identifier.ts`.
    const targets = ["target-1", "target-2"];
    const scopes = targets.flatMap((targetId) => [
      callerScopeOf({
        _tag: "attempt",
        targetId,
        attemptId: identifier.newAttemptId(),
      }),
      callerScopeOf({
        _tag: "round",
        targetId,
        roundId: identifier.newRoundId(),
      }),
      callerScopeOf({
        _tag: "goal",
        targetId,
        goalId: identifier.newGoalId(),
      }),
      operatorScope(targetId),
    ]);

    expect(new Set(scopes).size).toBe(scopes.length);
    // And the shapes are what the table in `callerScopeOf` says, so a receipt key read
    // out of the database can be attributed to a kind of caller by eye.
    expect(scopes[0]).toMatch(/^target-1\/att_[0-9a-zA-Z]+$/);
    expect(scopes[1]).toMatch(/^target-1\/round\/rnd_[0-9a-zA-Z]+$/);
    expect(scopes[2]).toMatch(/^target-1\/goal\/goal_[0-9a-zA-Z]+$/);
    expect(scopes[3]).toBe("target-1/operator");
    // The two reserved segments cannot be mistaken for an attempt id: a minted attempt
    // id is `att_…` and contains no `/`, so an attempt scope is always two segments.
    expect(identifier.newAttemptId()).not.toContain("/");
    expect(identifier.newRoundId().startsWith("rnd_")).toBe(true);
  });

  test("a round can be read back out of its scope, and only a round's", async () => {
    // `roundIdFromScope` is what attributes a record to the planner round that wrote it —
    // `events.caller_scope` is the only column that says so, since an `intent.added`
    // carries the intent as its subject. The inverse lives beside the builder so the format
    // has one home, and this asserts the pair actually round-trips.
    const roundId = identifier.newRoundId();
    expect(
      roundIdFromScope(
        callerScopeOf({ _tag: "round", targetId: "target-1", roundId }),
      ),
    ).toBe(roundId);

    // And nothing else is read as a round. An attempt scope, a goal scope, the operator's
    // and a null caller all answer `undefined`, which is what keeps a hand-written intent
    // out of whichever round happened to be open.
    for (const scope of [
      callerScopeOf({
        _tag: "attempt",
        targetId: "target-1",
        attemptId: identifier.newAttemptId(),
      }),
      callerScopeOf({
        _tag: "goal",
        targetId: "target-1",
        goalId: identifier.newGoalId(),
      }),
      operatorScope("target-1"),
      null,
    ]) {
      expect(roundIdFromScope(scope)).toBeUndefined();
    }
  });

  test("a worker's own writes are unaffected by any of this", async () => {
    // The regression this slice must not have, asserted here as well as in the suites
    // above: an attempt credential still records an observation under its own identity.
    const outcome = await withRound((store) =>
      Effect.gen(function* () {
        const recorded = yield* store.recordObservation(
          CALLER,
          multiCaseInput(),
        );
        return {
          recorded,
          stored: yield* store.observationsForIntent("intent-1"),
        };
      }),
    );

    expect(outcome.recorded.replayed).toBe(false);
    expect(outcome.stored).toHaveLength(1);
    expect(outcome.stored[0]?.provenance.attemptId).toBe("attempt-1");
  });
});

describe("the four goal-scoped reads", () => {
  const HOST = { callerScope: operatorScope("target-1"), targetId: "target-1" };

  /**
   * One goal with two intents, each with its own attempt, and a second goal beside it.
   *
   * The second goal exists so every assertion below is also a statement that the reads
   * are scoped: a statement that forgot its `goal_id` would pass against one goal.
   */
  const withTwoGoals = <A, E>(
    use: (
      store: Store,
      callers: {
        first: AttemptCaller;
        second: AttemptCaller;
        other: AttemptCaller;
      },
    ) => Effect.Effect<A, E>,
  ) =>
    withStore(newDatabasePath(), (store) =>
      Effect.gen(function* () {
        yield* migrated(store);
        yield* store.seedAttempt({
          targetId: "target-1",
          goalId: "goal-1",
          goal: "Determine whether authentication rate limits can be bypassed.",
          intentId: "intent-2",
          question: "Probe the per-account limiter on POST /login.",
          attemptId: "attempt-2",
          workerId: "worker-1",
          harnessInstanceId: "opencode",
          providerId: "openai",
          modelId: "gpt-5.6-sol",
          modelOptions: null,
          harnessSessionId: null,
        });
        yield* store.seedAttempt({
          targetId: "target-1",
          goalId: "goal-2",
          goal: "An unrelated objective in the same target.",
          intentId: "intent-9",
          question: "Something else entirely.",
          attemptId: "attempt-9",
          workerId: "worker-1",
          harnessInstanceId: "opencode",
          providerId: "openai",
          modelId: "gpt-5.6-sol",
          modelOptions: null,
          harnessSessionId: null,
        });
        return yield* use(store, {
          first: CALLER,
          second: {
            ...CALLER,
            callerScope: "target-1/attempt-2",
            intentId: "intent-2",
            attemptId: "attempt-2",
          },
          other: {
            ...CALLER,
            callerScope: "target-1/attempt-9",
            intentId: "intent-9",
            attemptId: "attempt-9",
          },
        });
      }),
    );

  test("observationsForGoal spans every intent of the goal, ascending, and no other goal's", async () => {
    const outcome = await withTwoGoals((store, callers) =>
      Effect.gen(function* () {
        // Interleaved across the two intents, so "ascending by sequence" is a different
        // answer from "grouped by intent".
        const written: string[] = [];
        for (const [caller, tag] of [
          [callers.first, "a"],
          [callers.second, "b"],
          [callers.first, "c"],
        ] as const) {
          const recorded = yield* store.recordObservation(
            caller,
            multiCaseInput({ operationId: `op-${tag}` }),
          );
          written.push(recorded.observationId);
        }
        yield* store.recordObservation(
          callers.other,
          multiCaseInput({ operationId: "op-other" }),
        );
        return {
          written,
          forGoal: yield* store.observationsForGoal("goal-1"),
          forOther: yield* store.observationsForGoal("goal-2"),
          forMissing: yield* store.observationsForGoal("goal-nonesuch"),
        };
      }),
    );

    expect(outcome.forGoal.map((item) => item.observationId)).toEqual(
      outcome.written,
    );
    expect(outcome.forGoal.map((item) => item.provenance.intentId)).toEqual([
      "intent-1",
      "intent-2",
      "intent-1",
    ]);
    const sequences = outcome.forGoal.map((item) => item.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(outcome.forOther).toHaveLength(1);
    expect(outcome.forMissing).toEqual([]);
  });

  test("dimensionsForGoal is one row per dimension across the goal, and links follow the raising side", async () => {
    const outcome = await withTwoGoals((store, callers) =>
      Effect.gen(function* () {
        const raiser = yield* store.recordObservation(
          callers.first,
          multiCaseInput({
            operationId: "raise",
            untestedDimensions: ["left untested one", "left untested two"],
          }),
        );
        const address = `${raiser.observationId}#u0`;
        // Addressed from a *sibling* intent of the same goal, which is the case a read
        // selected by the addressing side would have dropped. The sibling has to have been
        // created declaring the address — the write boundary refuses it otherwise — so it
        // is added through `addIntent` and then given an attempt of its own.
        yield* store.addIntent(HOST, {
          operationId: "declare-addresser",
          goalId: "goal-1",
          intentId: "intent-3",
          question: "Take on the dimension the first intent left open.",
          anchorObservationIds: [],
          addressesDimension: address,
        });
        yield* store.seedAttempt({
          targetId: "target-1",
          goalId: "goal-1",
          goal: "Determine whether authentication rate limits can be bypassed.",
          intentId: "intent-3",
          question: "Take on the dimension the first intent left open.",
          attemptId: "attempt-3",
          workerId: "worker-1",
          harnessInstanceId: "opencode",
          providerId: "openai",
          modelId: "gpt-5.6-sol",
          modelOptions: null,
          harnessSessionId: null,
        });
        const addresser = yield* store.recordObservation(
          {
            ...callers.first,
            callerScope: "target-1/attempt-3",
            intentId: "intent-3",
            attemptId: "attempt-3",
          },
          multiCaseInput({
            operationId: "address",
            outcome: "negative",
            // Raises nothing of its own, so the count below is only the first
            // observation's two.
            untestedDimensions: [],
            addressesDimensions: [address],
          }),
        );
        return {
          raiserId: raiser.observationId,
          addresserId: addresser.observationId,
          address,
          dimensions: yield* store.dimensionsForGoal("goal-1"),
          links: yield* store.dimensionLinksForGoal("goal-1"),
          otherDimensions: yield* store.dimensionsForGoal("goal-2"),
        };
      }),
    );

    // Two dimensions, each exactly once: a dimension belongs to one observation and an
    // observation to one intent, so neither join can multiply a row.
    expect(outcome.dimensions).toHaveLength(2);
    expect(outcome.dimensions.map((item) => item.address)).toEqual([
      `${outcome.raiserId}#u0`,
      `${outcome.raiserId}#u1`,
    ]);
    expect(
      new Set(outcome.dimensions.map((item) => item.dimensionId)).size,
    ).toBe(2);
    expect(outcome.links).toHaveLength(1);
    expect(outcome.links[0]).toMatchObject({
      observationId: outcome.addresserId,
      address: outcome.address,
      addressingOutcome: "negative",
    });
    expect(outcome.otherDimensions).toEqual([]);
  });

  test("dimensionSchedulesForGoal finds a declaration from any intent of the goal", async () => {
    const outcome = await withTwoGoals((store, callers) =>
      Effect.gen(function* () {
        const raiser = yield* store.recordObservation(
          callers.first,
          multiCaseInput({
            operationId: "raise",
            untestedDimensions: ["left untested one"],
          }),
        );
        const address = `${raiser.observationId}#u0`;
        yield* store.addIntent(HOST, {
          operationId: "declare",
          goalId: "goal-1",
          intentId: "intent-3",
          question: "Take on the dimension the first intent left open.",
          anchorObservationIds: [],
          addressesDimension: address,
        });
        return {
          schedules: yield* store.dimensionSchedulesForGoal("goal-1"),
          perIntent: yield* store.dimensionSchedulesForIntent("intent-1"),
          otherGoal: yield* store.dimensionSchedulesForGoal("goal-2"),
        };
      }),
    );

    expect(outcome.schedules).toHaveLength(1);
    expect(outcome.schedules[0]).toMatchObject({
      intentId: "intent-3",
      attemptsTotal: 0,
      attemptsOpen: 0,
    });
    // The goal-scoped read is a superset of the per-intent one by construction: this
    // dimension was raised under `intent-1`, so both see it. What the goal read adds is
    // every *other* intent's dimensions in the same answer.
    expect(outcome.perIntent).toHaveLength(1);
    expect(outcome.otherGoal).toEqual([]);
  });
});
