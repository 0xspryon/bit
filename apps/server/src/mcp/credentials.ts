/**
 * Session-scoped MCP credentials (DECISIONS.md §6 lines 693-711).
 *
 * The host mints a bearer token bound to one {target, intent, attempt, worker, harness
 * session} before it creates that session, hands it to the harness in the MCP
 * registration body, and revokes it when the attempt's scope closes. The raw token is
 * never persisted and never written to argv or to the environment the agent's shell
 * commands inherit; only its hash lives in memory for lookup.
 *
 * This is what makes `record_observation`'s provenance trustworthy: the caller's
 * identity comes from the credential, so a model that claims a different intent ID is
 * simply describing a resource it cannot address.
 *
 * **The lifetime is owned by a scope, not by a happy path.** `issue` is an
 * `acquireRelease`, so the grant is revoked when the surrounding scope closes — whether
 * the attempt succeeded, failed, or was interrupted, and including the case where the
 * *next* step (registering the MCP server with the harness) is the thing that fails.
 * Revoking only after a successful run, as this previously did, leaves a live
 * credential behind on exactly the paths where you least want one.
 *
 * The token is `Redacted` so it cannot reach a log line or an error rendering by
 * accident; `Redacted.value` is required to use it, and the only place that does is the
 * single registration call that delivers it.
 *
 * **The grant carries the attempt's write fence.** A credential is authority *as of* a
 * moment: the fence is read from the attempt row when the credential is minted, and the
 * store refuses a write whose fence has since been superseded. That is what makes
 * revocation outlive this registry — the map is per-process and a restart forgets it,
 * while the fence is a column.
 */
import { Clock, Context, Effect, Layer, Redacted, type Scope } from "effect";

import type { CallerContext } from "../persistence/store";

export interface Grant extends CallerContext {
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export const DEFAULT_LIFETIME_MS = 6 * 60 * 60 * 1000;

const hash = (token: string): string =>
  new Bun.CryptoHasher("sha256").update(token).digest("hex");

export interface IssuedCredential {
  /** Held in memory only, for the one registration call that delivers it. */
  readonly token: Redacted.Redacted<string>;
  readonly grant: Grant;
}

export class McpCredentials extends Context.Service<
  McpCredentials,
  {
    /**
     * Mints a credential for one attempt, owned by the current scope.
     *
     * `callerScope` namespaces command receipts, so two workers cannot collide on or
     * address each other's operation IDs.
     */
    readonly issue: (
      binding: Omit<CallerContext, "callerScope">,
      lifetimeMs?: number,
    ) => Effect.Effect<IssuedCredential, never, Scope.Scope>;
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
     */
    readonly revokeAttempt: (attemptId: string) => Effect.Effect<number>;
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

    const issue: McpCredentials["Service"]["issue"] = Effect.fn(
      "McpCredentials.issue",
    )(function* (binding, lifetimeMs = DEFAULT_LIFETIME_MS) {
      const issuedAt = yield* Clock.currentTimeMillis;
      return yield* Effect.acquireRelease(
        Effect.sync(() => {
          const bytes = crypto.getRandomValues(new Uint8Array(32));
          const raw = Array.from(bytes, (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join("");
          const grant: Grant = {
            ...binding,
            callerScope: `${binding.targetId}/${binding.attemptId}`,
            issuedAt,
            expiresAt: issuedAt + lifetimeMs,
          };
          grants.set(hash(raw), grant);
          return {
            token: Redacted.make(raw),
            grant,
          } satisfies IssuedCredential;
        }),
        (credential) => revoke(credential.token),
      );
    });

    const revokeAttempt: McpCredentials["Service"]["revokeAttempt"] = (
      attemptId: string,
    ) =>
      Effect.sync(() => {
        let revoked = 0;
        for (const [key, grant] of [...grants]) {
          if (grant.attemptId !== attemptId) continue;
          grants.delete(key);
          revoked += 1;
        }
        return revoked;
      });

    const resolve: McpCredentials["Service"]["resolve"] = Effect.fnUntraced(
      function* (token: string) {
        const key = hash(token);
        const grant = grants.get(key);
        if (grant === undefined) return undefined;
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
      resolve,
      revoke,
      revokeAttempt,
      size: Effect.sync(() => grants.size),
    });
  });
}
