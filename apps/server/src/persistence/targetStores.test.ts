/**
 * The per-target store resolver, against real files.
 *
 * Four claims, none of which the compiler can make and none of which a stubbed lookup
 * could establish:
 *
 * 1. **A key reaches its own file.** Two targets resolved through one resolver read their
 *    own rows, concurrently, with no leakage either way.
 * 2. **One handle per target, shared.** Two borrowers of the same target get the same
 *    connection rather than two on one file — which matters because SQLite has one write
 *    lock per file.
 * 3. **Reference counting, not eviction.** A borrowed store is not released while it is
 *    held, however long that is against the idle TTL; and it *is* released once nothing
 *    holds it and the TTL has passed.
 * 4. **One bad target fails alone.** An unusable id, an unregistered target and a target
 *    whose file will not migrate are three refusals that name the target, and a neighbour
 *    resolves immediately afterwards.
 *
 * The fleet under test is on disk, the broken target is a real file the real migrator
 * really cannot migrate, and the asymmetric fixture rows are written with `bun:sqlite`
 * because what is being tested is a read path. The TTL is 80ms here: sixty seconds is the
 * right answer for an operator and an unusable one for a test, which is why
 * {@link TargetStores.layerWith} exists.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Duration, Effect, Layer, ManagedRuntime } from "effect";

import { FleetStore, HUNT_FILE } from "./fleet";
import { TargetStores } from "./targetStores";

const scratch = mkdtempSync(join(tmpdir(), "bit-target-stores-"));
const fleetRoot = join(realpathSync(scratch), "fleet");

/** Short enough to wait out, long enough that a borrow can outlive it on purpose. */
const IDLE_TTL = Duration.millis(80);
const PAST_TTL = Duration.millis(240);

const fleet = FleetStore.layer(fleetRoot);
const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    fleet,
    TargetStores.layerWith({ idleTimeToLive: IDLE_TTL }).pipe(
      Layer.provide(fleet),
    ),
  ),
);

beforeAll(async () => {
  // A file the hunt chain cannot migrate, in the directory `broken` is about to get. A
  // policy proven against a stubbed migrator is a policy about the stub.
  mkdirSync(join(fleetRoot, "targets", "broken"), { recursive: true });
  const corrupt = new Database(
    join(fleetRoot, "targets", "broken", HUNT_FILE),
    {
      create: true,
    },
  );
  corrupt.run("CREATE TABLE observations (id TEXT)");
  corrupt.close();

  await runtime.runPromise(
    Effect.gen(function* () {
      const store = yield* FleetStore;
      for (const targetId of ["alpha", "beta", "broken"]) {
        yield* store.register({
          targetId,
          name: targetId,
          scopeNote: `${targetId} scope`,
        });
      }
      // The sweep is what records each target's schema state, and the resolver refuses a
      // target no sweep has looked at — so this is not setup noise, it is the ordering
      // `main.ts` has to observe too.
      yield* store.migrateFleet();
    }).pipe(Effect.orDie),
  );

  // Asymmetric rows: `alpha` holds a goal and an intent, `beta` holds nothing. With both
  // files empty, reading the wrong one would look exactly like reading the right one.
  const alpha = new Database(join(fleetRoot, "targets", "alpha", HUNT_FILE));
  try {
    alpha.run(
      "INSERT INTO goals (id, target_id, description, created_at) VALUES (?, ?, ?, ?)",
      ["goal_a", "alpha", "alpha's goal", 1],
    );
    alpha.run(
      `INSERT INTO intents (id, goal_id, target_id, question, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      ["intent_a", "goal_a", "alpha", "alpha's question", 2],
    );
  } finally {
    alpha.close();
  }
});

afterAll(async () => {
  await runtime.dispose();
  rmSync(scratch, { recursive: true, force: true });
});

describe("resolving a target", () => {
  test("each key reads its own file", async () => {
    const counts = await runtime.runPromise(
      Effect.gen(function* () {
        const stores = yield* TargetStores;
        const read = (targetId: string) =>
          Effect.scoped(
            Effect.flatMap(stores.open(targetId), (store) => store.counts()),
          );
        return {
          alpha: yield* read("alpha"),
          beta: yield* read("beta"),
        };
      }).pipe(Effect.orDie),
    );

    expect(counts.alpha.goals).toBe(1);
    expect(counts.alpha.intents).toBe(1);
    // Read second, through the same resolver, after `alpha`'s entry was cached. A
    // resolver keyed by anything other than the target would answer 1 and 1 here.
    expect(counts.beta.goals).toBe(0);
    expect(counts.beta.intents).toBe(0);
  });

  test("two targets held at once stay separate", async () => {
    const held = await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const stores = yield* TargetStores;
          const [alpha, beta] = yield* Effect.all(
            [stores.open("alpha"), stores.open("beta")],
            { concurrency: 2 },
          );
          return {
            alpha: yield* alpha.counts(),
            beta: yield* beta.counts(),
            open: [...(yield* stores.openTargetIds)].sort(),
            sameService: alpha === beta,
          };
        }),
      ).pipe(Effect.orDie),
    );

    expect(held.open).toEqual(["alpha", "beta"]);
    expect(held.sameService).toBe(false);
    expect(held.alpha.intents).toBe(1);
    expect(held.beta.intents).toBe(0);
  });

  test("two borrowers of one target share one connection", async () => {
    const shared = await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const stores = yield* TargetStores;
          const first = yield* stores.open("alpha");
          const second = yield* stores.open("alpha");
          return {
            same: first === second,
            // Filtered to the key under test: an entry released by an earlier test is
            // still warm — which is the TTL working, not a leak.
            alphaEntries: [...(yield* stores.openTargetIds)].filter(
              (id) => id === "alpha",
            ),
          };
        }),
      ).pipe(Effect.orDie),
    );

    // One entry, two references. The alternative — a handle per borrower — would put two
    // connections on one file, which SQLite serialises behind a single write lock.
    expect(shared.same).toBe(true);
    expect(shared.alphaEntries).toEqual(["alpha"]);
  });
});

describe("the lifetime of a handle", () => {
  test("a held store is not released, however long it is held", async () => {
    const observed = await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const stores = yield* TargetStores;
          const store = yield* stores.open("alpha");
          // Three times the idle TTL, with the borrow open. This is the property an LRU
          // cannot offer: nothing can take a connection away from a caller that is still
          // inside its scope, so a write in flight is unevictable by construction.
          yield* Effect.sleep(PAST_TTL);
          return {
            open: [...(yield* stores.openTargetIds)],
            // Still usable, not merely still listed.
            counts: yield* store.counts(),
          };
        }),
      ).pipe(Effect.orDie),
    );

    expect(observed.open).toEqual(["alpha"]);
    expect(observed.counts.intents).toBe(1);
  });

  test("a pinned layer holds its borrow for the layer's scope, not the request's", async () => {
    // What `pinnedLayerFor` is *for*, asserted rather than documented: the MCP route takes
    // its store as a layer requirement, and the entry has to survive past the idle TTL
    // because the layer is alive, not because anyone is currently reading. The borrow ends
    // with the layer's scope and not before.
    const pinned = await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const stores = yield* TargetStores;
          const scope = yield* Effect.scope;
          yield* Layer.buildWithScope(
            stores.pinnedLayerFor("alpha", "test: a layer-shaped consumer"),
            scope,
          );
          yield* Effect.sleep(PAST_TTL);
          return [...(yield* stores.openTargetIds)];
        }),
      ).pipe(Effect.orDie),
    );
    expect(pinned).toEqual(["alpha"]);

    // And released once that scope closes, after the idle TTL — a pin is a long borrow,
    // not an exemption from reference counting.
    const afterwards = await runtime.runPromise(
      Effect.gen(function* () {
        const stores = yield* TargetStores;
        yield* Effect.sleep(PAST_TTL);
        return [...(yield* stores.openTargetIds)];
      }),
    );
    expect(afterwards).toEqual([]);
  });

  test("a released store is kept warm, then closed once the TTL passes", async () => {
    const timeline = await runtime.runPromise(
      Effect.gen(function* () {
        const stores = yield* TargetStores;
        yield* Effect.scoped(Effect.asVoid(stores.open("beta")));
        // Released, not closed: the next request for this target within the TTL reuses
        // the open file instead of re-opening and re-migrating it.
        const warm = [...(yield* stores.openTargetIds)];
        yield* Effect.sleep(PAST_TTL);
        const cold = [...(yield* stores.openTargetIds)];
        return { warm, cold };
      }).pipe(Effect.orDie),
    );

    expect(timeline.warm).toContain("beta");
    // Gone, so the file handle and its WAL are gone too — which is what keeps
    // `rm -rf targets/<id>/` from racing a connection nobody is using.
    expect(timeline.cold).not.toContain("beta");
  });

  test("invalidate drops an idle entry at once", async () => {
    const after = await runtime.runPromise(
      Effect.gen(function* () {
        const stores = yield* TargetStores;
        yield* Effect.scoped(Effect.asVoid(stores.open("beta")));
        yield* stores.invalidate("beta");
        return [...(yield* stores.openTargetIds)];
      }).pipe(Effect.orDie),
    );

    expect(after).not.toContain("beta");
  });
});

describe("a target that will not open", () => {
  /** The failure, or `undefined` if the target opened. */
  const refusalFor = (targetId: string) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const stores = yield* TargetStores;
        const outcome = yield* Effect.result(
          Effect.scoped(Effect.asVoid(stores.open(targetId))),
        );
        return outcome._tag === "Failure" ? outcome.failure : undefined;
      }),
    );

  test("an id that cannot name a target is refused before a path is built", async () => {
    const failure = await refusalFor("../etc");
    expect(failure?._tag).toBe("FleetError");
    expect(failure).toMatchObject({
      reason: "invalid_target_id",
      targetId: "../etc",
    });
  });

  test("an unregistered id is refused as unknown, not as empty", async () => {
    const failure = await refusalFor("nothing-here");
    expect(failure).toMatchObject({
      reason: "unknown_target",
      targetId: "nothing-here",
    });
  });

  test("a target whose file did not migrate is refused by name", async () => {
    const failure = await refusalFor("broken");
    expect(failure).toMatchObject({
      reason: "target_unavailable",
      targetId: "broken",
    });
    // The failure text is the migrator's own, so an operator reads what actually broke
    // rather than "unavailable".
    expect(
      failure !== undefined && failure._tag === "FleetError"
        ? failure.detail
        : "",
    ).toContain("Migration");
  });

  test("its neighbours keep resolving", async () => {
    // The whole partial-failure policy, through the resolver: three refusals above, and
    // the fourth target in the same fleet opens and answers.
    const counts = await runtime.runPromise(
      Effect.gen(function* () {
        const stores = yield* TargetStores;
        return yield* Effect.scoped(
          Effect.flatMap(stores.open("alpha"), (store) => store.counts()),
        );
      }).pipe(Effect.orDie),
    );

    expect(counts.intents).toBe(1);
  });

  test("a refused target leaves nothing cached to retry against", async () => {
    const open = await runtime.runPromise(
      Effect.flatMap(TargetStores, (stores) => stores.openTargetIds),
    );
    // This failed when it was written, and the resolver was wrong rather than the test:
    // `RcMap` caches whatever a lookup produced, failures included, so all three refused
    // keys above were holding entries and would have been refused *from cache* for the
    // next minute — including after a sweep fixed the file. `open` clears a key whose
    // lookup failed, which is why these are gone.
    expect(open).not.toContain("broken");
    expect(open).not.toContain("nothing-here");
    expect(open).not.toContain("../etc");
  });

  test("a target fixed by a later sweep opens without a restart", async () => {
    // What the uncached refusal buys. The corrupt file is replaced, one target is
    // re-migrated — `migrateTarget` recreates the directory and runs the chain, which is
    // also why a data directory deleted out from under a live server comes back empty —
    // and the very next resolution succeeds. With the failure cached this would have kept
    // refusing for the idle TTL, reporting a migration error about a file that no longer
    // exists.
    rmSync(join(fleetRoot, "targets", "broken"), {
      recursive: true,
      force: true,
    });

    const counts = await runtime.runPromise(
      Effect.gen(function* () {
        const fleetStore = yield* FleetStore;
        const stores = yield* TargetStores;
        const outcome = yield* fleetStore.migrateTarget("broken");
        const reopened = yield* Effect.scoped(
          Effect.flatMap(stores.open("broken"), (store) => store.counts()),
        );
        return { state: outcome.state, reopened };
      }).pipe(Effect.orDie),
    );

    expect(counts.state).toBe("ready");
    expect(counts.reopened.observations).toBe(0);
  });
});
