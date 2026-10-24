/**
 * Real-SQLite tests for the two-tier layout and the fleet migration runner.
 *
 * Every claim here is about files on disk, so none of it is checked against an in-memory
 * database: that a target's graph lives in its own file, that one target's connection
 * cannot read another's rows, that a target whose migration fails is marked unavailable
 * and refused by name while its neighbours are served, and that the sequence counter is
 * per file rather than shared.
 *
 * The partial-failure case is produced by breaking one target's file on purpose — a table
 * the chain is about to rebuild is replaced with one that cannot be — rather than by
 * stubbing the migrator. A policy proven against a stub migrator is a policy about the
 * stub.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { SqlClient } from "effect/sql";

import { AWKWARD_TEXT } from "./fixtures";
import {
  CONTROL_FILE,
  FleetError,
  FleetStore,
  fleetPaths,
  isTargetId,
  targetStoreLayer,
} from "./fleet";
import { ObservationStore, type CallerContext } from "./store";
import { sqliteLayer } from "./sql";

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true });
  }
});

const newRoot = () => {
  const directory = mkdtempSync(join(tmpdir(), "bit-fleet-"));
  directories.push(directory);
  return directory;
};

type Fleet = FleetStore["Service"];

const withFleet = <A, E>(
  root: string,
  use: (fleet: Fleet) => Effect.Effect<A, E, FleetStore>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(FleetStore, use).pipe(
        Effect.provide(FleetStore.layer(root)),
      ),
    ),
  );

/** Opens one target's store through the registry, as a consumer has to. */
const withTarget = <A, E>(
  root: string,
  targetId: string,
  use: (store: ObservationStore["Service"]) => Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(ObservationStore, use).pipe(
        Effect.provide(targetStoreLayer(targetId)),
        Effect.provide(FleetStore.layer(root)),
      ),
    ),
  );

const register = (fleet: Fleet, targetId: string) =>
  fleet.register({
    targetId,
    name: `Target ${targetId}`,
    scopeNote: `Only the local fixture is in scope; ${AWKWARD_TEXT}`,
  });

const callerFor = (targetId: string): CallerContext => ({
  callerScope: `${targetId}/attempt-1`,
  targetId,
  intentId: `intent-${targetId}`,
  attemptId: `attempt-${targetId}`,
  harnessSessionId: "ses_abc",
  workerId: "worker-1",
  attemptFence: 0,
});

const seed = (store: ObservationStore["Service"], targetId: string) =>
  store.seedAttempt({
    targetId,
    goalId: `goal-${targetId}`,
    goal: "Determine whether authentication rate limits can be bypassed.",
    intentId: `intent-${targetId}`,
    question: "Probe the per-client limiter on POST /login.",
    attemptId: `attempt-${targetId}`,
    workerId: "worker-1",
    harnessInstanceId: "opencode",
    providerId: "openai",
    modelId: "gpt-5.6-sol",
    modelOptions: null,
    harnessSessionId: null,
  });

describe("target ids", () => {
  test("only accept what is safe as a directory name", () => {
    for (const good of [
      "a",
      "fixture-local",
      "t1",
      "a_b-c",
      "0",
      "a".repeat(64),
    ])
      expect(isTargetId(good)).toBe(true);
    // Path traversal, absolute paths, the control file's own name, case variants that a
    // case-insensitive filesystem would fold together, and the empty string.
    for (const bad of [
      "",
      ".",
      "..",
      "../etc",
      "a/b",
      "a\\b",
      "/abs",
      "-leading",
      "_leading",
      "Fixture",
      "with space",
      "with.dot",
      "a".repeat(65),
      "control.sqlite",
    ])
      expect(isTargetId(bad)).toBe(false);
  });

  test("a path is never built from an unvalidated id", () => {
    const paths = fleetPaths("/tmp/root");
    expect(paths.huntFile("ok")).toBe("/tmp/root/targets/ok/hunt.sqlite");
    // Throws rather than returning a traversing path, because a caller that ignored a
    // typed refusal would otherwise get a working path outside the fleet.
    expect(() => paths.huntFile("../..")).toThrow();
    expect(() => paths.targetDirectory("a/b")).toThrow();
  });
});

describe("the registry", () => {
  test("registers a target, creates its directories, and refuses the id twice", async () => {
    const root = newRoot();
    const outcome = await withFleet(root, (fleet) =>
      Effect.gen(function* () {
        const first = yield* register(fleet, "alpha");
        const again = yield* Effect.result(register(fleet, "alpha"));
        const bad = yield* Effect.result(register(fleet, "../escape"));
        return {
          first,
          again,
          bad,
          all: yield* fleet.targets(),
        };
      }),
    );

    expect(outcome.first.targetId).toBe("alpha");
    expect(outcome.all.map((row) => row.targetId)).toEqual(["alpha"]);
    expect(existsSync(join(root, "targets", "alpha"))).toBe(true);
    // Evidence has a home from the start, and it is not in SQLite.
    expect(existsSync(join(root, "targets", "alpha", "evidence"))).toBe(true);
    expect(existsSync(join(root, CONTROL_FILE))).toBe(true);

    // An id is a directory of somebody's recorded evidence. "Register" quietly meaning
    // "attach to the existing one" is how two engagements share a file.
    expect(outcome.again._tag).toBe("Failure");
    if (outcome.again._tag === "Failure") {
      expect((outcome.again.failure as FleetError).reason).toBe(
        "duplicate_target",
      );
    }
    expect(outcome.bad._tag).toBe("Failure");
    if (outcome.bad._tag === "Failure") {
      expect((outcome.bad.failure as FleetError).reason).toBe(
        "invalid_target_id",
      );
    }
  });

  test("survives a reopen, and settings round-trip", async () => {
    const root = newRoot();
    await withFleet(root, (fleet) =>
      Effect.gen(function* () {
        yield* register(fleet, "alpha");
        yield* fleet.setSetting("worker.concurrency", "1");
        yield* fleet.setSetting("worker.concurrency", "1");
      }),
    );
    const after = await withFleet(root, (fleet) =>
      Effect.gen(function* () {
        return {
          target: yield* fleet.target("alpha"),
          missing: yield* fleet.target("beta"),
          setting: yield* fleet.setting("worker.concurrency"),
          absent: yield* fleet.setting("nothing.here"),
        };
      }),
    );
    expect(after.target?.name).toBe("Target alpha");
    expect(after.target?.scopeNote).toContain(AWKWARD_TEXT);
    expect(after.missing).toBeUndefined();
    // An upsert: writing the same key twice leaves one row with the later value.
    expect(after.setting).toBe("1");
    expect(after.absent).toBeUndefined();
  });

  test("records the folder an engagement is about, or none, and keeps it", async () => {
    const root = newRoot();
    const workspace = newRoot();
    await withFleet(root, (fleet) =>
      Effect.gen(function* () {
        yield* fleet.register({
          targetId: "alpha",
          name: "Target alpha",
          scopeNote: AWKWARD_TEXT,
          workspacePath: workspace,
        });
        // No folder: the shape `main.ts` registers a fixture target with.
        yield* register(fleet, "beta");
      }),
    );
    const after = await withFleet(root, (fleet) => fleet.targets());
    expect(after.map((row) => row.targetId)).toEqual(["alpha", "beta"]);
    expect(after[0]?.workspacePath).toBe(workspace);
    // `NULL`, not `""`: "no folder was recorded" has to be distinguishable from a
    // folder whose path is the empty string, which is not a path at all.
    expect(after[1]?.workspacePath).toBeUndefined();

    // Read straight out of the file, so the column really is in the schema rather than
    // only in the decoder: a `SELECT` of a column that does not exist is a SQL error,
    // and nothing above would have caught it if the decode had defaulted.
    const database = new Database(join(root, CONTROL_FILE), { readonly: true });
    try {
      const rows = database
        .query<{ id: string; workspace_path: string | null }, []>(
          "SELECT id, workspace_path FROM targets ORDER BY id",
        )
        .all();
      expect(rows).toEqual([
        { id: "alpha", workspace_path: workspace },
        { id: "beta", workspace_path: null },
      ]);
    } finally {
      database.close();
    }
  });

  test("archiving is idempotent and keeps the row", async () => {
    const root = newRoot();
    const outcome = await withFleet(root, (fleet) =>
      Effect.gen(function* () {
        yield* register(fleet, "alpha");
        yield* fleet.archive("alpha");
        const first = yield* fleet.target("alpha");
        yield* fleet.archive("alpha");
        const second = yield* fleet.target("alpha");
        return { first, second, swept: yield* fleet.migrateFleet() };
      }),
    );
    expect(outcome.first?.archivedAt).toBeDefined();
    // `COALESCE`, so a second archive does not move the timestamp.
    expect(outcome.second?.archivedAt).toBe(outcome.first?.archivedAt);
    // An archived target is skipped: its directory may legitimately have been deleted
    // with `rm -rf`, and migrating it would recreate an empty one.
    expect(outcome.swept).toEqual([]);
  });
});

describe("the fleet migration runner", () => {
  test("migrates every registered target into its own file", async () => {
    const root = newRoot();
    const outcome = await withFleet(root, (fleet) =>
      Effect.gen(function* () {
        yield* register(fleet, "alpha");
        yield* register(fleet, "beta");
        const first = yield* fleet.migrateFleet();
        const again = yield* fleet.migrateFleet();
        return {
          first,
          again,
          states: yield* Effect.forEach(["alpha", "beta"], (id) =>
            fleet.schemaState(id),
          ),
        };
      }),
    );

    expect(outcome.first.map((row) => row.targetId)).toEqual(["alpha", "beta"]);
    expect(outcome.first.every((row) => row.state === "ready")).toBe(true);
    expect(outcome.first.every((row) => row.applied.length > 0)).toBe(true);
    // Separate files, so one sweep does not satisfy the other target.
    expect(existsSync(join(root, "targets", "alpha", "hunt.sqlite"))).toBe(
      true,
    );
    expect(existsSync(join(root, "targets", "beta", "hunt.sqlite"))).toBe(true);
    // A second sweep applies nothing: pending-only application holds per file.
    expect(outcome.again.every((row) => row.applied.length === 0)).toBe(true);
    expect(outcome.again.every((row) => row.detail === "already current")).toBe(
      true,
    );
    // `applied_through` is read from each file's own journal, not assumed.
    expect(
      outcome.states.every((state) => (state?.appliedThrough ?? 0) > 0),
    ).toBe(true);
    expect(outcome.states.map((state) => state?.state)).toEqual([
      "ready",
      "ready",
    ]);
  });

  test("a target that cannot migrate is unavailable, and its neighbours are served", async () => {
    const root = newRoot();
    await withFleet(root, (fleet) =>
      Effect.gen(function* () {
        yield* register(fleet, "alpha");
        yield* register(fleet, "broken");
        yield* register(fleet, "gamma");
      }),
    );

    // Break the middle target's file for real: `observations` is left as a table whose
    // columns `0002`'s rebuild cannot select, so the chain fails inside a real migration
    // body rather than in a stub.
    const sabotaged = join(root, "targets", "broken", "hunt.sqlite");
    const database = new Database(sabotaged, { create: true, strict: true });
    database.run(`CREATE TABLE observations (id TEXT PRIMARY KEY)`);
    database.close();

    const outcome = await withFleet(root, (fleet) =>
      Effect.gen(function* () {
        const swept = yield* fleet.migrateFleet();
        return {
          swept,
          alpha: yield* Effect.result(fleet.huntFileFor("alpha")),
          broken: yield* Effect.result(fleet.huntFileFor("broken")),
          gamma: yield* Effect.result(fleet.huntFileFor("gamma")),
          unknown: yield* Effect.result(fleet.huntFileFor("delta")),
          state: yield* fleet.schemaState("broken"),
        };
      }),
    );

    // The sweep ran to the end: the failure did not stop target 3 from being migrated,
    // which is the whole of the recorded partial-failure policy.
    expect(outcome.swept.map((row) => [row.targetId, row.state])).toEqual([
      ["alpha", "ready"],
      ["broken", "unavailable"],
      ["gamma", "ready"],
    ]);
    expect(outcome.alpha._tag).toBe("Success");
    expect(outcome.gamma._tag).toBe("Success");
    // Marked unavailable is load-bearing: the target is refused by name, with the
    // migration failure quoted, rather than served as an empty graph.
    expect(outcome.broken._tag).toBe("Failure");
    if (outcome.broken._tag === "Failure") {
      const failure = outcome.broken.failure as FleetError;
      expect(failure.reason).toBe("target_unavailable");
      expect(failure.detail).toContain("did not migrate");
    }
    expect(outcome.state?.state).toBe("unavailable");
    expect(outcome.state?.detail.length).toBeGreaterThan(0);
    // An unregistered target is a different refusal from an unavailable one.
    expect(outcome.unknown._tag).toBe("Failure");
    if (outcome.unknown._tag === "Failure") {
      expect((outcome.unknown.failure as FleetError).reason).toBe(
        "unknown_target",
      );
    }
  });

  test("an unswept target is refused rather than migrated by whoever opens it", async () => {
    const root = newRoot();
    const outcome = await withFleet(root, (fleet) =>
      Effect.gen(function* () {
        yield* register(fleet, "alpha");
        return yield* Effect.result(fleet.huntFileFor("alpha"));
      }),
    );
    expect(outcome._tag).toBe("Failure");
    if (outcome._tag === "Failure") {
      const failure = outcome._tag === "Failure" ? outcome.failure : undefined;
      expect((failure as FleetError).reason).toBe("target_unavailable");
      expect((failure as FleetError).detail).toContain("has not been migrated");
    }
  });

  test("a target repaired by a later sweep becomes available again", async () => {
    const root = newRoot();
    await withFleet(root, (fleet) => register(fleet, "broken"));
    const sabotaged = join(root, "targets", "broken", "hunt.sqlite");
    const database = new Database(sabotaged, { create: true, strict: true });
    database.run(`CREATE TABLE observations (id TEXT PRIMARY KEY)`);
    database.close();
    await withFleet(root, (fleet) => fleet.migrateFleet());

    // The repair, in the only form available: there is no `down`, so the file is
    // replaced and the next sweep migrates it from nothing.
    rmSync(sabotaged);

    const outcome = await withFleet(root, (fleet) =>
      Effect.gen(function* () {
        const swept = yield* fleet.migrateFleet();
        return {
          swept,
          open: yield* Effect.result(fleet.huntFileFor("broken")),
        };
      }),
    );
    expect(outcome.swept[0]?.state).toBe("ready");
    expect(outcome.open._tag).toBe("Success");
  });
});

describe("per-target isolation", () => {
  test("two targets keep their own rows, and their own sequence counters", async () => {
    const root = newRoot();
    await withFleet(root, (fleet) =>
      Effect.gen(function* () {
        yield* register(fleet, "alpha");
        yield* register(fleet, "beta");
        yield* fleet.migrateFleet();
      }),
    );

    const alpha = await withTarget(root, "alpha", (store) =>
      Effect.gen(function* () {
        yield* seed(store, "alpha");
        const first = yield* store.recordObservation(
          callerFor("alpha"),
          observationInput("alpha-1"),
        );
        const second = yield* store.recordObservation(
          callerFor("alpha"),
          observationInput("alpha-2"),
        );
        return { first, second, sequence: yield* store.currentSequence };
      }),
    );

    const beta = await withTarget(root, "beta", (store) =>
      Effect.gen(function* () {
        yield* seed(store, "beta");
        const only = yield* store.recordObservation(
          callerFor("beta"),
          observationInput("beta-1"),
        );
        return {
          only,
          sequence: yield* store.currentSequence,
          // Target alpha's intent is not reachable from this connection at all.
          alphaIntent: yield* store.loadIntent("intent-alpha"),
          alphaObservations: yield* store.observationsForIntent("intent-alpha"),
          events: yield* store.eventsAfter(),
        };
      }),
    );

    // Each file counts from 1. Writing twice in alpha did not move beta's counter, which
    // is the coupling §22 flagged and the file split removes.
    expect([alpha.first.sequence, alpha.second.sequence]).toEqual([1, 2]);
    expect(alpha.sequence).toBe(2);
    expect(beta.only.sequence).toBe(1);
    expect(beta.sequence).toBe(1);
    // Two files, so ids collide across targets and that is correct: an observation id is
    // unique within the target it belongs to, which is the file it lives in.
    expect(beta.only.observationId).toBe("obs_000001_attempt-beta");
    expect(alpha.first.observationId).toBe("obs_000001_attempt-alpha");

    // Not "a WHERE clause filtered it out": there is no row to filter.
    expect(beta.alphaIntent).toBeUndefined();
    expect(beta.alphaObservations).toEqual([]);
    // Two events in beta's file, both beta's: its attempt starting and its one
    // observation. Nothing alpha wrote is reachable from this connection.
    expect(beta.events.map((event) => event.targetId)).toEqual([
      "beta",
      "beta",
    ]);
    expect(beta.events.map((event) => event.kind)).toEqual([
      "attempt.started",
      "observation.recorded",
    ]);

    // And alpha still holds exactly its own two, read back after beta's writes.
    const alphaAgain = await withTarget(root, "alpha", (store) =>
      store.observationsForIntent("intent-alpha"),
    );
    expect(alphaAgain.map((row) => row.observationId)).toEqual([
      "obs_000001_attempt-alpha",
      "obs_000002_attempt-alpha",
    ]);
  });

  test("deleting a target's directory leaves the other target intact", async () => {
    const root = newRoot();
    await withFleet(root, (fleet) =>
      Effect.gen(function* () {
        yield* register(fleet, "alpha");
        yield* register(fleet, "beta");
        yield* fleet.migrateFleet();
      }),
    );
    await withTarget(root, "beta", (store) =>
      Effect.gen(function* () {
        yield* seed(store, "beta");
        yield* store.recordObservation(
          callerFor("beta"),
          observationInput("beta-1"),
        );
      }),
    );
    await withTarget(root, "alpha", (store) => seed(store, "alpha"));

    // §3's provable deletion, performed.
    rmSync(join(root, "targets", "alpha"), { recursive: true, force: true });
    expect(existsSync(join(root, "targets", "alpha"))).toBe(false);

    const beta = await withTarget(root, "beta", (store) =>
      store.observationsForIntent("intent-beta"),
    );
    expect(beta).toHaveLength(1);
  });

  test("the control database holds no graph table", async () => {
    const root = newRoot();
    await withFleet(root, (fleet) =>
      Effect.gen(function* () {
        yield* register(fleet, "alpha");
        yield* fleet.migrateFleet();
      }),
    );
    const tables = await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          Effect.map(
            sql<{
              name: string;
            }>`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
            (rows) => rows.map((row) => row.name),
          ),
        ).pipe(Effect.provide(sqliteLayer(join(root, CONTROL_FILE)))),
      ),
    );
    expect(tables).toEqual([
      "effect_sql_migrations",
      "settings",
      "target_schema_state",
      "targets",
    ]);
    // The two chains are separate and must never meet: no graph, no events, no outbox.
    for (const absent of [
      "observations",
      "events",
      "outbox",
      "attempts",
      "intents",
    ])
      expect(tables).not.toContain(absent);
  });
});

/** A minimal case-based observation, enough to exercise a write. */
const observationInput = (operationId: string) => ({
  operationId,
  testedClaim: "Header rotation evades the per-client limit on POST /login.",
  outcome: "positive" as const,
  setup: "Local rate-limit fixture, counters reset before the run.",
  cases: [
    {
      id: "case-1",
      purpose: "Establish the threshold under one identity.",
      actors: [
        {
          id: "fixed",
          account: "alice",
          role: "end-user",
          clientIdentity: "X-Client-Id held at 'fixed-a'",
        },
      ],
      relationships: [],
      actions: [
        {
          actorId: "fixed",
          endpoint: "http://127.0.0.1:9/login",
          method: "POST",
          description: "Sequential wrong-password logins until the refusal.",
          requestCount: 11,
          observedBehavior: "1-10 returned 401; 11 returned 429.",
          evidenceRefs: [],
        },
      ],
      configuration: "per-client limit 10",
      windowStart: 1_000,
      windowEnd: 2_000,
      testBounds: "11 requests, one identity",
      limitations: [],
    },
  ] as const,
  interpretation: "The limiter keys on the header value.",
  limitations: ["A request header is not a network address."],
  untestedDimensions: ["The per-account limit was never approached."],
  addressesDimensions: [],
});
