/**
 * The credential registry, on its own and against a controllable clock.
 *
 * `mcp/server.test.ts` covers the registry *through* the HTTP boundary, which is where
 * "an unknown token reaches no tool" belongs. What is here is the part that boundary
 * cannot see: which kinds of credential may exist, what bounds each of them, and what a
 * revocation does and does not reach.
 *
 * Every grant lives in a scope, so every test runs inside `Effect.scoped` and the scope
 * closing is itself the behaviour under test in one of them. `TestClock` rather than
 * sleeping, because the default lifetime is six hours.
 */
import { describe, expect, test } from "bun:test";
import { Effect, Layer, Redacted, type Scope } from "effect";
import { TestClock } from "effect/testing";

import * as identifier from "../persistence/identifier";
import { callerScopeOf, operatorScope } from "../persistence/store";
import {
  CredentialRefused,
  DEFAULT_LIFETIME_MS,
  IMPORT_LIFETIME_MS,
  McpCredentials,
  callerOf,
  type AttemptBinding,
  type CallerBinding,
  type GoalBinding,
  type ImporterBinding,
  type RoundBinding,
} from "./credentials";

const ATTEMPT: AttemptBinding = {
  _tag: "attempt",
  targetId: "target-1",
  intentId: "intent-1",
  attemptId: "att_1",
  harnessSessionId: "ses_worker",
  workerId: "worker-1",
  attemptFence: 0,
};

const ROUND: RoundBinding = {
  _tag: "round",
  targetId: "target-1",
  goalId: "goal-1",
  roundId: "rnd_1",
  roundFence: 0,
};

const GOAL: GoalBinding = {
  _tag: "goal",
  targetId: "target-1",
  goalId: "goal-1",
};

/** One registry, in one scope, against the real clock. */
const withCredentials = <A, E>(
  use: (
    credentials: McpCredentials["Service"],
  ) => Effect.Effect<A, E, Scope.Scope>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(McpCredentials, use).pipe(
        Effect.provide(McpCredentials.layer),
      ),
    ),
  );

/** The same, with a clock a test can move. */
const withTestClock = <A, E>(
  use: (
    credentials: McpCredentials["Service"],
  ) => Effect.Effect<A, E, Scope.Scope>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(McpCredentials, use).pipe(
        Effect.provide(Layer.mergeAll(McpCredentials.layer, TestClock.layer())),
      ),
    ),
  );

describe("what a credential is minted from", () => {
  test("the scope is derived from the binding, per kind", async () => {
    const outcome = await withCredentials((credentials) =>
      Effect.all({
        attempt: credentials.issue(ATTEMPT),
        round: credentials.issue(ROUND),
        goal: credentials.issue(GOAL),
      }),
    );

    expect(outcome.attempt.grant.callerScope).toBe("target-1/att_1");
    expect(outcome.round.grant.callerScope).toBe("target-1/round/rnd_1");
    expect(outcome.goal.grant.callerScope).toBe("target-1/goal/goal-1");
  });

  test("no two kinds of binding produce the same scope", async () => {
    // On constructed values, over minted ids, rather than by reading the builder.
    const scopes = ["target-1", "target-2"].flatMap((targetId) => [
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
  });

  test("the token is random, redacted, and never equal to another grant's", async () => {
    const outcome = await withCredentials((credentials) =>
      Effect.all({
        first: credentials.issue(ATTEMPT),
        second: credentials.issue(ATTEMPT),
      }),
    );

    expect(Redacted.value(outcome.first.token)).not.toBe(
      Redacted.value(outcome.second.token),
    );
    // Redacted, so a log line or an error rendering cannot carry it by accident.
    expect(String(outcome.first.token)).not.toContain(
      Redacted.value(outcome.first.token),
    );
  });

  test("a grant resolves to the caller it authenticates, and nothing else", async () => {
    const outcome = await withCredentials((credentials) =>
      Effect.gen(function* () {
        const attempt = yield* credentials.issue(ATTEMPT);
        const round = yield* credentials.issue(ROUND);
        const goal = yield* credentials.issue(GOAL);
        return {
          attempt: callerOf(attempt.grant),
          round: callerOf(round.grant),
          goal: callerOf(goal.grant),
        };
      }),
    );

    // The credential's own bookkeeping does not cross into the caller: a tool handler
    // reads an identity, not an expiry it might be tempted to interpret.
    expect(outcome.attempt).toEqual({
      ...ATTEMPT,
      callerScope: "target-1/att_1",
    });
    expect(outcome.round).toEqual({
      ...ROUND,
      callerScope: "target-1/round/rnd_1",
    });
    expect(outcome.goal).toEqual({
      ...GOAL,
      callerScope: "target-1/goal/goal-1",
    });
    expect(outcome.attempt).not.toHaveProperty("issuedAt");
    expect(outcome.goal).not.toHaveProperty("expiresAt");
  });
});

describe("the clock", () => {
  test("a clock-bounded grant stops resolving once its lifetime is up", async () => {
    const outcome = await withTestClock((credentials) =>
      Effect.gen(function* () {
        const issued = yield* credentials.issue(ROUND);
        const token = Redacted.value(issued.token);
        const fresh = yield* credentials.resolve(token);
        yield* TestClock.adjust(DEFAULT_LIFETIME_MS);
        return {
          fresh,
          stale: yield* credentials.resolve(token),
          size: yield* credentials.size,
        };
      }),
    );

    expect(outcome.fresh?._tag).toBe("round");
    expect(outcome.stale).toBeUndefined();
    // The expired grant is forgotten rather than kept as a list of everything that has
    // ever timed out.
    expect(outcome.size).toBe(0);
  });

  test("a goal grant with no expiry resolves after a clock advance that would expire any other", async () => {
    // Ruling 3, and the reason `expiresAt` is `number | null` rather than a sentinel: a
    // goal conversation is open for as long as the operator is working the goal.
    const outcome = await withTestClock((credentials) =>
      Effect.gen(function* () {
        const forever = yield* credentials.issueWithoutExpiry(GOAL);
        const bounded = yield* credentials.issue(ROUND);
        yield* TestClock.adjust(DEFAULT_LIFETIME_MS * 1000);
        return {
          expiresAt: forever.grant.expiresAt,
          forever: yield* credentials.resolve(Redacted.value(forever.token)),
          bounded: yield* credentials.resolve(Redacted.value(bounded.token)),
        };
      }),
    );

    expect(outcome.expiresAt).toBeNull();
    expect(outcome.forever?._tag).toBe("goal");
    expect(outcome.bounded).toBeUndefined();
  });

  test("an attempt or round binding cannot be issued without an expiry", async () => {
    // The signature already makes this unrepresentable — `issueWithoutExpiry` takes a
    // goal binding — so the casts here are what a future caller, or a binding decoded
    // from somewhere, would have to do to get past the type. The run-time refusal is what
    // it meets. This is a security boundary, so it is defended twice.
    const outcome = await withCredentials((credentials) =>
      Effect.all({
        attempt: Effect.result(
          credentials.issueWithoutExpiry(ATTEMPT as unknown as GoalBinding),
        ),
        round: Effect.result(
          credentials.issueWithoutExpiry(ROUND as unknown as GoalBinding),
        ),
        size: credentials.size,
      }),
    );

    for (const [kind, result] of [
      ["attempt", outcome.attempt],
      ["round", outcome.round],
    ] as const) {
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        const error = result.failure as CredentialRefused;
        expect(error.reason).toBe("expiry_required");
        expect(error.detail).toContain(`a ${kind} credential must carry`);
      }
    }
    // And nothing was registered on the way to being refused.
    expect(outcome.size).toBe(0);
  });

  test("a goal grant may still be clock-bounded when a caller asks for one", async () => {
    // No expiry is a *permission*, not an obligation: `issue` is the ordinary path and
    // works for every kind.
    const outcome = await withTestClock((credentials) =>
      Effect.gen(function* () {
        const issued = yield* credentials.issue(GOAL);
        const token = Redacted.value(issued.token);
        yield* TestClock.adjust(DEFAULT_LIFETIME_MS);
        return {
          expiresAt: issued.grant.expiresAt,
          resolved: yield* credentials.resolve(token),
        };
      }),
    );

    expect(outcome.expiresAt).not.toBeNull();
    expect(outcome.resolved).toBeUndefined();
  });
});

describe("revocation", () => {
  test("each kind revokes only its own grants", async () => {
    const outcome = await withCredentials((credentials) =>
      Effect.gen(function* () {
        const attempt = yield* credentials.issue(ATTEMPT);
        const round = yield* credentials.issue(ROUND);
        const goal = yield* credentials.issueWithoutExpiry(GOAL);
        const resolveAll = Effect.all({
          attempt: credentials.resolve(Redacted.value(attempt.token)),
          round: credentials.resolve(Redacted.value(round.token)),
          goal: credentials.resolve(Redacted.value(goal.token)),
        });

        const before = yield* resolveAll;
        const revokedRound = yield* credentials.revokeRound("rnd_1");
        const afterRound = yield* resolveAll;
        const revokedGoal = yield* credentials.revokeGoal("goal-1");
        const afterGoal = yield* resolveAll;
        const revokedAttempt = yield* credentials.revokeAttempt("att_1");
        return {
          before,
          revokedRound,
          afterRound,
          revokedGoal,
          afterGoal,
          revokedAttempt,
          after: yield* resolveAll,
        };
      }),
    );

    expect(outcome.before.attempt?._tag).toBe("attempt");
    expect(outcome.before.round?._tag).toBe("round");
    expect(outcome.before.goal?._tag).toBe("goal");

    // One round revoked, and the attempt and goal under the same target untouched. The
    // goal keeps its credential on purpose: a settled round says nothing about whether
    // the operator is still working the goal.
    expect(outcome.revokedRound).toBe(1);
    expect(outcome.afterRound.round).toBeUndefined();
    expect(outcome.afterRound.attempt?._tag).toBe("attempt");
    expect(outcome.afterRound.goal?._tag).toBe("goal");

    expect(outcome.revokedGoal).toBe(1);
    expect(outcome.afterGoal.goal).toBeUndefined();
    expect(outcome.afterGoal.attempt?._tag).toBe("attempt");

    expect(outcome.revokedAttempt).toBe(1);
    expect(outcome.after.attempt).toBeUndefined();
  });

  test("an id of the wrong kind revokes nothing", async () => {
    // The ids are deliberately the same string: a revocation matches on the tag as well,
    // so "revoke the round called X" cannot reach "the goal called X".
    const shared = "shared-id";
    const outcome = await withCredentials((credentials) =>
      Effect.gen(function* () {
        yield* credentials.issue({ ...ROUND, roundId: shared });
        yield* credentials.issue({ ...GOAL, goalId: shared });
        yield* credentials.issue({ ...ATTEMPT, attemptId: shared });
        return {
          asAttemptOfARound: yield* credentials.revokeAttempt(shared),
          size: yield* credentials.size,
        };
      }),
    );

    // Exactly the one attempt grant, not the three grants that share the id.
    expect(outcome.asAttemptOfARound).toBe(1);
    expect(outcome.size).toBe(2);
  });

  test("revocation is idempotent and reports how many there were", async () => {
    const outcome = await withCredentials((credentials) =>
      Effect.gen(function* () {
        yield* credentials.issue(ROUND);
        yield* credentials.issue({ ...ROUND, roundFence: 1 });
        return {
          first: yield* credentials.revokeRound("rnd_1"),
          second: yield* credentials.revokeRound("rnd_1"),
          absent: yield* credentials.revokeGoal("goal-absent"),
        };
      }),
    );

    // Two grants for one round — a reissue against a bumped fence — and both go.
    expect(outcome.first).toBe(2);
    expect(outcome.second).toBe(0);
    expect(outcome.absent).toBe(0);
  });

  test("a no-expiry grant still dies with its scope", async () => {
    // Point 1 of what bounds a goal credential: the scope. This is the whole reason
    // `issue` is an `acquireRelease` rather than a function that returns a token.
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const credentials = yield* McpCredentials;
        const token = yield* Effect.scoped(
          Effect.gen(function* () {
            const issued = yield* credentials.issueWithoutExpiry(GOAL);
            const inside = yield* credentials.resolve(
              Redacted.value(issued.token),
            );
            expect(inside?._tag).toBe("goal");
            return Redacted.value(issued.token);
          }),
        );
        return {
          after: yield* credentials.resolve(token),
          size: yield* credentials.size,
        };
      }).pipe(Effect.provide(McpCredentials.layer)),
    );

    expect(outcome.after).toBeUndefined();
    expect(outcome.size).toBe(0);
  });

  test("revoking by token works for any kind", async () => {
    const outcome = await withCredentials((credentials) =>
      Effect.gen(function* () {
        const issued = yield* credentials.issueWithoutExpiry(GOAL);
        yield* credentials.revoke(issued.token);
        return {
          resolved: yield* credentials.resolve(Redacted.value(issued.token)),
          size: yield* credentials.size,
        };
      }),
    );
    expect(outcome.resolved).toBeUndefined();
    expect(outcome.size).toBe(0);
  });
});

describe("what a binding cannot do", () => {
  test("a caller cannot supply its own scope", async () => {
    // Not a run-time check: `CallerBinding` has no `callerScope` field, so a credential
    // whose receipts are filed under a name other than its identity cannot be asked for.
    // Asserted as a compile-time claim with a cast, so the test fails if the field is
    // ever added back.
    const binding = {
      ...ROUND,
      callerScope: "target-1/att_pretending",
    } as unknown as RoundBinding;
    const grant = await withCredentials((credentials) =>
      Effect.map(credentials.issue(binding), (issued) => issued.grant),
    );
    expect(grant.callerScope).toBe("target-1/round/rnd_1");
  });

  /**
   * The importer's mint takes importer bindings and nothing else.
   *
   * `issue` used to take a `CallerBinding` of any kind, so any holder of this service
   * could mint `{ _tag: "importer" }` — and the importer is the one role whose capability
   * is *writing a target's authorization boundary*: scope entries and imported assets,
   * which every later judgement about what may be tested is made against. The module
   * already established the stronger pattern for goals and no-expiry; this is the same
   * pattern applied to the same kind of claim.
   *
   * **The first half of it is not testable here and is checked by `typecheck`**: `issue`'s
   * parameter is `Exclude<CallerBinding, ImporterBinding>`, so a call site passing an
   * importer binding does not compile — which is how `scopeImporter.ts` came to be the
   * only caller of `issueImport`. What is testable is the run-time backstop, below.
   */
  test("`issueImport` refuses a binding of another kind at run time", async () => {
    // Unreachable through the signature. Kept because a cast or a decoded payload can get
    // past a type, and this is the role that writes the boundary.
    const refused = await withCredentials((credentials) =>
      Effect.result(
        credentials.issueImport(ROUND as unknown as ImporterBinding),
      ),
    );
    expect(refused._tag).toBe("Failure");
    if (refused._tag === "Failure") {
      expect(refused.failure.reason).toBe("wrong_kind");
      expect(refused.failure.detail).toContain("round");
    }
  });

  test("an import's credential expires in minutes, not a worker's six hours", async () => {
    // An import is one session reading at most eight pages, and `createTarget` answers
    // without waiting for it. A worker's window is sized for a hunt that runs that long;
    // handing it to a session whose work is minutes leaves a live credential nobody is
    // watching, for no gain — the import's own scope revokes it when the fiber ends.
    const grant = await withCredentials((credentials) =>
      Effect.map(
        credentials.issueImport({
          _tag: "importer",
          targetId: "target-1",
          importId: "imp_1",
        }),
        (issued) => issued.grant,
      ),
    );
    expect(grant.expiresAt).not.toBeNull();
    expect((grant.expiresAt ?? 0) - grant.issuedAt).toBe(IMPORT_LIFETIME_MS);
    expect(IMPORT_LIFETIME_MS).toBeLessThan(DEFAULT_LIFETIME_MS);
  });
});
