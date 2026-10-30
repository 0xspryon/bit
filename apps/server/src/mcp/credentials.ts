/**
 * Session-scoped MCP credentials (DECISIONS.md §6 lines 693-711).
 *
 * The host mints a bearer token bound to one caller before it creates that caller's
 * session, hands it to the harness in the MCP registration body, and revokes it when the
 * caller's scope closes. The raw token is never persisted and never written to argv or to
 * the environment the agent's shell commands inherit; only its hash lives in memory for
 * lookup.
 *
 * This is what makes `record_observation`'s provenance trustworthy: the caller's
 * identity comes from the credential, so a model that claims a different intent ID is
 * simply describing a resource it cannot address.
 *
 * **There are three kinds of caller, and the binding says which** — a worker attempt, a
 * planner round, or a goal agent (the spec's decision 2;
 * `docs/design/goal-and-planner-flow.md`). `callerScope` is *derived* from the binding
 * ({@link callerScopeOf}) rather than passed in, so no call site can mint a credential
 * whose receipts are filed under a different name from the identity it carries.
 *
 * **The lifetime is owned by a scope, not by a happy path.** `issue` is an
 * `acquireRelease`, so the grant is revoked when the surrounding scope closes — whether
 * the work succeeded, failed, or was interrupted, and including the case where the
 * *next* step (registering the MCP server with the harness) is the thing that fails.
 * Revoking only after a successful run, as this previously did, leaves a live
 * credential behind on exactly the paths where you least want one.
 *
 * The token is `Redacted` so it cannot reach a log line or an error rendering by
 * accident; `Redacted.value` is required to use it, and the only place that does is the
 * single registration call that delivers it.
 *
 * **An attempt or round grant carries that row's write fence.** A credential is authority
 * *as of* a moment: the fence is read from the attempt or round row when the credential
 * is minted, and the store refuses a write whose fence has since been superseded. That is
 * what makes revocation outlive this registry — the map is per-process and a restart
 * forgets it, while the fence is a column.
 *
 * ## A goal credential has no clock expiry, and what bounds it instead
 *
 * `expiresAt` is `number | null`, and **null means no expiry at all** (the spec's
 * decision 4). Only a goal binding may be issued that way, through
 * {@link McpCredentials.issueWithoutExpiry}; an attempt or a round cannot, because its
 * row's own lifecycle is short and a clock backstop costs it nothing. `null` rather than
 * a sentinel like `Infinity`, because a sentinel in a numeric comparison is a bug waiting
 * to be written and does not survive a round trip through JSON.
 *
 * A goal conversation is long-horizon and operator-facing: it is open for as long as the
 * operator is working that goal, which may be days. An expiry would mean a conversation
 * that stops working mid-sentence for a reason the operator cannot see. So three things
 * bound it instead, and they are the whole list:
 *
 * 1. **Scope close.** `issue` is an `acquireRelease`, so the grant dies with the scope
 *    that asked for it — the goal session's scope, which ends when the goal session does.
 * 2. **{@link McpCredentials.revokeGoal}.** Ending a goal, or giving up on its session,
 *    revokes every grant bound to it explicitly.
 * 3. **Process death.** Grants live only in the map below. A restart forgets every one of
 *    them, so a goal credential cannot outlive this process however long its goal lives.
 *
 * **Why a goal therefore needs no write fence** (and has no column for one): a fence
 * defends against exactly one thing, a credential minted before a restart being presented
 * after it. Point 3 makes that unreachable — the registry that could resolve the token is
 * gone, so the token is already dead and the 401 comes from this module rather than from
 * a column. The durable thing that stops a goal credential is the goal's own ending, which
 * `store.checkGoalAuthority` reads on every write. This absence is written down because it
 * is the kind of gap a later reader would otherwise take for an oversight.
 *
 * **What is *not* covered, said plainly.** While the process lives, a goal credential that
 * has leaked is good until its scope closes or something revokes it. There is no
 * rotation: DECISIONS.md §24.2 measured that OpenCode can swap a token in place by
 * re-registering the same server name, and that **Claude Code cannot do it at all on a
 * live session** — a replacement there means a new session. The no-expiry design never
 * needs a swap, which is why none is built, and any future rotation work has to start
 * from that measurement.
 *
 * ## Why the per-role directory layout is part of this credential's containment
 *
 * Under OpenCode the **directory is the authority boundary**, and DECISIONS.md §24.2
 * (Spike B) demonstrated it rather than inferring it: two sessions in one directory, and
 * the second called the first's `bit-<id>` server successfully with the first's
 * credential — the store recorded the write under the *first* session's identity. There
 * is no per-session filter in OpenCode's MCP registry to find; tools belong to the
 * location.
 *
 * So the per-role layout from slice 3 is **load-bearing, not tidy**. What
 * `persistence/fleet.ts` lays out is `targets/<id>/planning/<roundId>/` and
 * `targets/<id>/goal/<goalId>/` — siblings of each other and of `evidence/` — while the
 * workspace a worker runs in is the operator's own folder (`workspace_path`) and is not
 * under that tree at all; `policy/install.ts` refuses a role directory inside it. Three
 * roles, three places, and no role's directory nested inside another's, which is the
 * shape the spike actually tested (siblings, never nesting).
 *
 * **What the layout does not reach, now measured one step further.** §24.2's caveat 4
 * recorded that the operator's *global* OpenCode config is visible in every directory.
 * DECISIONS.md §24.3 measured the rest: OpenCode collects `opencode.json` from **every
 * ancestor directory up to `/`**, so a role directory nested inside a git repository
 * inherits that repository's configuration and, per OpenCode's own source, its `AGENTS.md`
 * as agent instructions. Under the default `HUNT_ROOT` (`<cwd>/.runtime/hunt`) that is
 * this repository. It does not touch the authority boundary — a session's tools come from
 * the bearer it was registered with and the endpoint that bearer is accepted at, never
 * from configuration — but it is the reason "the directory is the boundary" is a statement
 * about *MCP registrations* and about nothing else.
 *
 * A goal credential with no clock expiry is containable only because the session holding
 * it is the only session in its directory: a worker cannot reach the goal agent's tools,
 * and the cross-directory control in §24.2 is what says so (the harness refused the name
 * outright, with zero requests reaching the endpoint). The same spike also recorded what
 * the layout does *not* do: concurrent attempts share the one workspace, so worker is not
 * isolated from worker, and the operator's global OpenCode config is visible in every
 * directory. Under Claude Code registration is per session (§24.2 question 3), which is a
 * stronger boundary that we do not rely on, because the weaker one has to hold anyway.
 */
import {
  Clock,
  Context,
  Effect,
  Layer,
  Redacted,
  Schema,
  type Scope,
} from "effect";

import {
  callerScopeOf,
  type CallerBinding,
  type CallerContext,
  type GoalBinding,
} from "../persistence/store";

/**
 * Re-exported so that "what a credential is minted from" is readable from the module
 * that mints them. The definitions live beside {@link CallerContext} in
 * `persistence/store.ts`, because the caller and its binding are one idea.
 */
export type {
  AttemptBinding,
  CallerBinding,
  GoalBinding,
  RoundBinding,
} from "../persistence/store";

/**
 * One live grant: who the bearer is, and when it stops being anybody.
 *
 * An intersection rather than an interface, because {@link CallerContext} is a union: the
 * grant of an attempt carries an attempt's fields and the grant of a goal carries a
 * goal's, and a resolver that reads `attemptId` has to be made to say which kind it
 * expected.
 *
 * `expiresAt: null` means no clock expiry. See this module's header for what bounds such
 * a grant instead; it is only reachable for a goal binding.
 */
export type Grant = CallerContext & {
  readonly issuedAt: number;
  readonly expiresAt: number | null;
};

export const DEFAULT_LIFETIME_MS = 6 * 60 * 60 * 1000;

/**
 * A credential this module refused to mint.
 *
 * One reason so far, and it is ruling 3's teeth: no-expiry is a goal's property, and
 * asking for an attempt or round credential that never expires is refused rather than
 * quietly granted. The *type* of {@link McpCredentials.issueWithoutExpiry} already makes
 * it unrepresentable; this is what happens when a cast, a decoded payload or a future
 * caller gets past the type.
 */
export class CredentialRefused extends Schema.TaggedError<CredentialRefused>()(
  "CredentialRefused",
  {
    reason: Schema.Literals(["expiry_required"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `${this.reason}: ${this.detail}`;
  }
}

const hash = (token: string): string =>
  new Bun.CryptoHasher("sha256").update(token).digest("hex");

export interface IssuedCredential {
  /** Held in memory only, for the one registration call that delivers it. */
  readonly token: Redacted.Redacted<string>;
  readonly grant: Grant;
}

/**
 * The caller a grant authenticates, with the credential's own bookkeeping dropped.
 *
 * Built per tag rather than by deleting two keys, so a field added to {@link Grant}
 * cannot reach a tool handler by accident: a new field is a compile error here until
 * somebody decides which side of the boundary it belongs on.
 */
export const callerOf = (grant: Grant): CallerContext => {
  switch (grant._tag) {
    case "attempt":
      return {
        _tag: "attempt",
        callerScope: grant.callerScope,
        targetId: grant.targetId,
        intentId: grant.intentId,
        attemptId: grant.attemptId,
        harnessSessionId: grant.harnessSessionId,
        workerId: grant.workerId,
        attemptFence: grant.attemptFence,
      };
    case "round":
      return {
        _tag: "round",
        callerScope: grant.callerScope,
        targetId: grant.targetId,
        goalId: grant.goalId,
        roundId: grant.roundId,
        roundFence: grant.roundFence,
      };
    case "goal":
      return {
        _tag: "goal",
        callerScope: grant.callerScope,
        targetId: grant.targetId,
        goalId: grant.goalId,
      };
  }
};

/** A grant from a binding, with the scope derived rather than supplied. */
const grantOf = (
  binding: CallerBinding,
  issuedAt: number,
  expiresAt: number | null,
): Grant => {
  const callerScope = callerScopeOf(binding);
  switch (binding._tag) {
    case "attempt":
      return { ...binding, callerScope, issuedAt, expiresAt };
    case "round":
      return { ...binding, callerScope, issuedAt, expiresAt };
    case "goal":
      return { ...binding, callerScope, issuedAt, expiresAt };
  }
};

export class McpCredentials extends Context.Service<
  McpCredentials,
  {
    /**
     * Mints a clock-bounded credential for one caller, owned by the current scope.
     *
     * Takes a {@link CallerBinding} of any kind and derives `callerScope` from it, so
     * command receipts and event attribution cannot disagree with the identity the
     * credential carries.
     */
    readonly issue: (
      binding: CallerBinding,
      lifetimeMs?: number,
    ) => Effect.Effect<IssuedCredential, never, Scope.Scope>;
    /**
     * Mints a goal credential with **no clock expiry**, owned by the current scope.
     *
     * Separate from {@link issue}, and taking only a {@link GoalBinding}, because that is
     * what makes "no attempt or round credential may be issued without an expiry"
     * unrepresentable rather than merely checked: there is no argument a caller holding an
     * attempt binding can pass here. It still refuses one at run time — see
     * {@link CredentialRefused} — because a cast can get past a type and this is a
     * security boundary.
     *
     * See this module's header for what bounds the resulting credential.
     */
    readonly issueWithoutExpiry: (
      binding: GoalBinding,
    ) => Effect.Effect<IssuedCredential, CredentialRefused, Scope.Scope>;
    /** Resolves a bearer token to its grant, or `undefined` if unknown or expired. */
    readonly resolve: (token: string) => Effect.Effect<Grant | undefined>;
    /** Revokes early. Idempotent, and also what the scope finalizer calls. */
    readonly revoke: (token: Redacted.Redacted<string>) => Effect.Effect<void>;
    /**
     * Revokes every live grant bound to one attempt, returning how many there were.
     *
     * This is the in-memory half of fencing a recovered attempt: the durable half is
     * the attempt's `write_fence`, which survives a restart. Both exist because they
     * cover different windows — the fence stops a credential minted before a restart,
     * and this stops one still held in *this* process by a session we have just given
     * up on. Idempotent: a second call finds nothing and returns 0.
     *
     * Only attempt grants: a round or goal grant is not an attempt's, however closely
     * related the work is.
     */
    readonly revokeAttempt: (attemptId: string) => Effect.Effect<number>;
    /**
     * Revokes every live grant bound to one planner round. The round's `write_fence` is
     * the durable half, exactly as for {@link revokeAttempt}.
     *
     * Only round grants. A goal's own credential survives this, which is correct: a
     * settled round says nothing about whether the operator is still working the goal.
     */
    readonly revokeRound: (roundId: string) => Effect.Effect<number>;
    /**
     * Revokes every live grant bound to one goal agent, returning how many there were.
     *
     * The explicit half of what bounds a no-expiry credential (point 2 in this module's
     * header). **Only goal grants**: a round running under the same goal keeps its own
     * credential until its scope closes or {@link revokeRound} is called for it.
     *
     * ## It does not cascade, and slice 9 is where that was decided
     *
     * Slice 4 left the question open. The answer is **no cascade, and nothing calls this
     * when a goal ends**, for two reasons that are about what the cascade would break
     * rather than about tidiness:
     *
     * - **To the goal's rounds.** A round holds its own credential and the spec's decision
     *   8 says ending a goal interrupts nothing that is running. A round whose credential
     *   vanished could not call `record_round_disposition`, so the one write that explains
     *   what it concluded would be refused — and `add_intent` is already refused under an
     *   ended goal by `RoundIntentRefused`'s `goal_ended`, which is the dispatch-shaped gap
     *   that actually mattered. Revoking would buy nothing and cost the record.
     * - **To the goal agent itself.** `store.checkGoalAuthority` refuses every write under
     *   an ended goal, which is durable and is a column rather than a map — so revocation
     *   adds no containment. What it would take away is the agent's **reads**, and
     *   "summarise what we established" is a reasonable thing to ask about a goal that has
     *   just been closed.
     *
     * So what calls this is `plan/goalConversation.ts`, when it gives up on a session — and
     * there it is a **check** rather than the mechanism: the session's own scope has just
     * revoked the grant, and a non-zero count here means one existed that no scope owned,
     * which is a bug and is logged as one.
     */
    readonly revokeGoal: (goalId: string) => Effect.Effect<number>;
    /** Live grants. Used by tests to prove nothing outlived its scope. */
    readonly size: Effect.Effect<number>;
  }
>()("bit/mcp/McpCredentials") {
  static readonly layer = Layer.sync(McpCredentials, () => {
    const grants = new Map<string, Grant>();

    const revoke = (token: Redacted.Redacted<string>): Effect.Effect<void> =>
      Effect.sync(() => {
        grants.delete(hash(Redacted.value(token)));
      });

    /** The one place a token is minted and registered, whatever the expiry. */
    const mint = (
      binding: CallerBinding,
      issuedAt: number,
      expiresAt: number | null,
    ): Effect.Effect<IssuedCredential, never, Scope.Scope> =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const bytes = crypto.getRandomValues(new Uint8Array(32));
          const raw = Array.from(bytes, (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join("");
          const grant = grantOf(binding, issuedAt, expiresAt);
          grants.set(hash(raw), grant);
          return {
            token: Redacted.make(raw),
            grant,
          } satisfies IssuedCredential;
        }),
        (credential) => revoke(credential.token),
      );

    const issue: McpCredentials["Service"]["issue"] = Effect.fn(
      "McpCredentials.issue",
    )(function* (binding, lifetimeMs = DEFAULT_LIFETIME_MS) {
      const issuedAt = yield* Clock.currentTimeMillis;
      return yield* mint(binding, issuedAt, issuedAt + lifetimeMs);
    });

    const issueWithoutExpiry: McpCredentials["Service"]["issueWithoutExpiry"] =
      Effect.fn("McpCredentials.issueWithoutExpiry")(function* (binding) {
        // Unreachable through the signature, which takes a goal binding only. Kept
        // because the type is a compile-time claim and this is a security boundary: a
        // cast, or a binding decoded from somewhere, would otherwise be granted a
        // credential that never expires for a row whose authority is supposed to be
        // short-lived.
        const kind = (binding as CallerBinding)._tag;
        if (kind !== "goal") {
          return yield* new CredentialRefused({
            reason: "expiry_required",
            detail: `a ${kind} credential must carry a clock expiry; only a goal credential may be issued without one`,
          });
        }
        const issuedAt = yield* Clock.currentTimeMillis;
        return yield* mint(binding, issuedAt, null);
      });

    /** Revokes every grant of one kind matching one id. Returns how many there were. */
    const revokeMatching = (
      matches: (grant: Grant) => boolean,
    ): Effect.Effect<number> =>
      Effect.sync(() => {
        let revoked = 0;
        for (const [key, grant] of [...grants]) {
          if (!matches(grant)) continue;
          grants.delete(key);
          revoked += 1;
        }
        return revoked;
      });

    const revokeAttempt: McpCredentials["Service"]["revokeAttempt"] = (
      attemptId: string,
    ) =>
      revokeMatching(
        (grant) => grant._tag === "attempt" && grant.attemptId === attemptId,
      );

    const revokeRound: McpCredentials["Service"]["revokeRound"] = (
      roundId: string,
    ) =>
      revokeMatching(
        (grant) => grant._tag === "round" && grant.roundId === roundId,
      );

    const revokeGoal: McpCredentials["Service"]["revokeGoal"] = (
      goalId: string,
    ) =>
      revokeMatching(
        (grant) => grant._tag === "goal" && grant.goalId === goalId,
      );

    const resolve: McpCredentials["Service"]["resolve"] = Effect.fnUntraced(
      function* (token: string) {
        const key = hash(token);
        const grant = grants.get(key);
        if (grant === undefined) return undefined;
        // `null` is checked, never compared. A numeric comparison against a sentinel is
        // the bug this shape exists to make impossible: `Infinity <= now` is false today
        // and `JSON.parse(JSON.stringify(Infinity))` is `null` tomorrow.
        if (grant.expiresAt === null) return grant;
        const now = yield* Clock.currentTimeMillis;
        if (grant.expiresAt <= now) {
          grants.delete(key);
          return undefined;
        }
        return grant;
      },
    );

    return McpCredentials.of({
      issue,
      issueWithoutExpiry,
      resolve,
      revoke,
      revokeAttempt,
      revokeRound,
      revokeGoal,
      size: Effect.sync(() => grants.size),
    });
  });
}
