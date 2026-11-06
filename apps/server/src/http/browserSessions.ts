/**
 * Browser session tokens, and the server password they are exchanged for.
 *
 * **Two registries, not one with a flag.** This map and `mcp/credentials.ts`'s map are
 * separate services with separate token spaces and separate resolvers. An MCP bearer
 * cannot open a browser session and a session token cannot satisfy `/api/v1/mcp`, and
 * that is true by construction rather than by a `kind` column somebody could forget to
 * check. The two authorities are genuinely different things: an MCP credential is bound
 * to one {target, intent, attempt, worker, harness session} and carries a write fence,
 * while a browser session is one operator sitting at one machine with no attempt behind
 * it at all. Giving them one table would mean every call site had to re-derive which of
 * those it was holding.
 *
 * **Sessions are in memory, deliberately.** Nothing here is written to `control.sqlite`.
 * Killing the server ends every session, which is the behaviour a local single-operator
 * tool should have — a token that survives a restart would outlive the process that
 * minted it and the operator who was at the keyboard. The web app treats an unknown
 * token as "sign in again", so the cost is one extra sign-in after a restart and the
 * benefit is that there is no durable credential to steal from the database file.
 *
 * **The password is generated, hashed and printed once.** On the first boot against a
 * fleet root, {@link ensureServerPassword} mints a high-entropy password, stores
 * `Bun.password`'s argon2id hash of it in the `settings` table, and hands the plaintext
 * back exactly once so the entrypoint can print it. Nothing can print it again, because
 * nothing keeps it: the hash is what is stored, and there is no reverse. It is not read
 * from an environment variable, because an env var is visible to every child process the
 * harness spawns and to anybody who can read `/proc`, and the agent this server launches
 * is precisely a child process running model-chosen commands.
 *
 * Only the *hash* of a session token is held, for the same reason `credentials.ts` holds
 * only hashes: a heap dump or a log of this map should not be a set of live bearers.
 */
import { SessionRefused } from "@bit/contracts";
import { Clock, Context, Effect, Layer, Redacted } from "effect";

import { FleetStore } from "../persistence/fleet";
import type { DatabaseError } from "../persistence/sql";

/**
 * Where the password hash lives in `control.sqlite`'s `settings` table.
 *
 * The key names the algorithm because the value is self-describing only to
 * `Bun.password.verify`; a later move to a different KDF wants a different key so the
 * two cannot be confused for one another.
 */
export const PASSWORD_SETTING_KEY = "server.password.argon2id";

/** Twelve hours: long enough for a working day, short enough to not be a standing key. */
export const DEFAULT_SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

/**
 * The alphabet a generated password is drawn from.
 *
 * Lowercase letters and digits with `l`, `i`, `o`, `0` and `1` removed, because this
 * string is read off a terminal and typed into a browser by a human. 31 symbols over 25
 * characters is about 124 bits, which is why there is no complexity rule and no
 * expiry: it is a machine-generated secret, not a memorised one.
 */
const PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const PASSWORD_GROUPS = 5;
const PASSWORD_GROUP_LENGTH = 5;

const generatePassword = (): string => {
  const bytes = crypto.getRandomValues(
    new Uint8Array(PASSWORD_GROUPS * PASSWORD_GROUP_LENGTH),
  );
  const characters = Array.from(
    bytes,
    (byte) => PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length] ?? "x",
  );
  const groups: string[] = [];
  for (let index = 0; index < PASSWORD_GROUPS; index += 1) {
    groups.push(
      characters
        .slice(
          index * PASSWORD_GROUP_LENGTH,
          (index + 1) * PASSWORD_GROUP_LENGTH,
        )
        .join(""),
    );
  }
  return groups.join("-");
};

const hashToken = (token: string): string =>
  new Bun.CryptoHasher("sha256").update(token).digest("hex");

/**
 * The variable an operator may set the server password with.
 *
 * Named after this application rather than after the harness, because
 * `OPENCODE_PASSWORD` is a *different* secret that `harness/openCodeServer.ts` mints and
 * hands to the child it spawns. Two passwords in one process is already a thing to be
 * careful about, and one name covering both would be the way they got confused.
 */
export const PASSWORD_ENV_VAR = "BIT_PASSWORD";

/**
 * Reads {@link PASSWORD_ENV_VAR} and **removes it from this process's environment**.
 *
 * The removal is the point, not a tidy-up. This server spawns an agent that runs
 * model-chosen shell commands, and a child inherits its parent's environment — so a
 * password left in `process.env` is a password the worker can read out of its own
 * environment with `env`, and from there present to our own browser API. OpenCode guards
 * the same hazard the same way (`cli/src/env.ts` filters its two password variables out
 * of the environment it hands a session, and `cli/src/server-process.ts` deletes one from
 * its own), which is where this approach comes from.
 *
 * Deleting here rather than scrubbing at each spawn site is deliberate: a list of spawn
 * sites to remember is a list somebody will fail to add to. The two that start an agent
 * today scrub as well — `openCodeServer.ts` hands its child an allowlist
 * (`HARNESS_ENVIRONMENT_ALLOWLIST`), and the Claude Code CLI gets its environment less
 * bit's own settings (`harness/agentEnvironment.ts`), this one among them — but the
 * deletion here is what covers whichever spawn site is added next. (A third, the policy
 * gate's hook, went with the gate on 2026-11-06.)
 *
 * Call this **once, at startup, before any harness is built.** Idempotent: a second call
 * finds nothing and returns `undefined`, which is also what an unset variable gives, and
 * the two are indistinguishable by design — there is nothing a caller should do
 * differently.
 */
export const takeConfiguredPassword = (): string | undefined => {
  const configured = process.env[PASSWORD_ENV_VAR];
  delete process.env[PASSWORD_ENV_VAR];
  return configured !== undefined && configured.length > 0
    ? configured
    : undefined;
};

/** What the first boot produced, if it produced anything. */
export interface ServerPasswordState {
  /**
   * The plaintext, present only on the boot that generated it.
   *
   * `undefined` on every later boot, and whenever a password was configured — there is
   * nothing to print that the operator did not already set. A caller that wants to show
   * them a generated password after the fact cannot: nothing keeps it.
   */
  readonly generated: string | undefined;
}

/**
 * Makes sure a password is in play, generating one on first boot if none is configured.
 *
 * **A configured password wins and is never stored.** It is configuration, so the
 * environment is the authority on every boot and a hash written on some earlier run must
 * not shadow it. Nothing is written to `settings`, which also means unsetting the
 * variable falls back to whatever the installation generated rather than to a stale copy
 * of a password the operator has since changed.
 *
 * Without one: idempotent as before. A second call finds the row and generates nothing.
 * There is deliberately no reset path here — regenerating a password has consequences for
 * anybody holding a session, and belongs on a settings screen rather than in a startup
 * helper that could be called twice.
 */
export const ensureServerPassword = (
  configured?: string | undefined,
): Effect.Effect<ServerPasswordState, DatabaseError, FleetStore> =>
  Effect.gen(function* () {
    // Configured wins, and nothing is written: the environment is the authority on every
    // boot, so generating a password nothing will check would leave a stored hash to
    // shadow it the day the variable is unset.
    if (configured !== undefined) {
      return { generated: undefined } satisfies ServerPasswordState;
    }
    const fleet = yield* FleetStore;
    const existing = yield* fleet.setting(PASSWORD_SETTING_KEY);
    if (existing !== undefined && existing.length > 0) {
      return { generated: undefined } satisfies ServerPasswordState;
    }
    const password = generatePassword();
    const hash = yield* Effect.promise(() =>
      Bun.password.hash(password, { algorithm: "argon2id" }),
    );
    yield* fleet.setSetting(PASSWORD_SETTING_KEY, hash);
    return { generated: password } satisfies ServerPasswordState;
  });

/** One granted session. Holds no password and no secret beyond its own id. */
export interface BrowserSession {
  readonly sessionId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/**
 * What resolving a bearer found.
 *
 * `Expired` is distinguished from `Unknown` so the Connect screen can say "your session
 * ended" rather than showing a bare form, which is the difference between the design
 * brief's `expired` state and its idle one. An expired entry is removed when it is
 * resolved, so the second lookup of the same token reports `Unknown` — the registry does
 * not keep a list of everybody who has ever timed out.
 */
export type SessionLookup =
  | { readonly _tag: "Active"; readonly session: BrowserSession }
  | { readonly _tag: "Expired" }
  | { readonly _tag: "Unknown" };

export interface IssuedSession {
  /** Held in memory only, for the one response that delivers it. */
  readonly token: Redacted.Redacted<string>;
  readonly session: BrowserSession;
}

const makeSessions = Effect.fnUntraced(function* (
  configuredHash?: string | undefined,
) {
  const fleet = yield* FleetStore;
  const sessions = new Map<string, BrowserSession>();

  /**
   * Verifies a password and mints a session, or refuses with a reason.
   *
   * **A configured password is held here; a generated one is read fresh each time.** The
   * difference follows from which is authoritative. `BIT_PASSWORD` is settled at startup
   * and changing it means restarting, so caching its hash costs nothing and keeps the
   * plaintext from living any longer than one hash call. The stored hash is state
   * something else may change, so it is read from `settings` on every attempt and a
   * change takes effect without a restart.
   *
   * A missing or empty hash refuses every password rather than accepting any. That is
   * the fail-closed direction, and it is reachable — a fleet root whose `settings` row
   * was deleted by hand is exactly the case where "no password configured" must not mean
   * "no password required".
   */
  const open: BrowserSessions["Service"]["open"] = Effect.fn(
    "BrowserSessions.open",
  )(function* (password: string) {
    const hash = configuredHash ?? (yield* fleet.setting(PASSWORD_SETTING_KEY));
    if (hash === undefined || hash.length === 0) {
      return yield* new SessionRefused({
        reason: "no_password_set",
        detail:
          "this installation has no server password recorded; restart the server so it can generate one, or set BIT_PASSWORD",
      });
    }
    const accepted = yield* Effect.promise(() =>
      Bun.password.verify(password, hash).catch(() => false),
    );
    if (!accepted) {
      return yield* new SessionRefused({
        reason: "invalid_password",
        detail: "that password was refused and no session was created",
      });
    }
    const issuedAt = yield* Clock.currentTimeMillis;
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const raw = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const session: BrowserSession = {
      sessionId: `ses_${raw.slice(0, 16)}`,
      issuedAt,
      expiresAt: issuedAt + DEFAULT_SESSION_LIFETIME_MS,
    };
    sessions.set(hashToken(raw), session);
    return { token: Redacted.make(raw), session } satisfies IssuedSession;
  });

  const resolve: BrowserSessions["Service"]["resolve"] = Effect.fnUntraced(
    function* (token: string) {
      if (token.length === 0) return { _tag: "Unknown" } as const;
      const key = hashToken(token);
      const session = sessions.get(key);
      if (session === undefined) return { _tag: "Unknown" } as const;
      const now = yield* Clock.currentTimeMillis;
      if (session.expiresAt <= now) {
        sessions.delete(key);
        return { _tag: "Expired" } as const;
      }
      return { _tag: "Active", session } as const;
    },
  );

  const close: BrowserSessions["Service"]["close"] = (token) =>
    Effect.sync(() => {
      sessions.delete(hashToken(Redacted.value(token)));
    });

  return BrowserSessions.of({
    open,
    resolve,
    close,
    size: Effect.sync(() => sessions.size),
  });
});

export class BrowserSessions extends Context.Service<
  BrowserSessions,
  {
    /** Exchanges the server password for a session, or refuses with a typed reason. */
    readonly open: (
      password: string,
    ) => Effect.Effect<IssuedSession, SessionRefused | DatabaseError>;
    /** Resolves a bearer, distinguishing an expired session from an unknown one. */
    readonly resolve: (token: string) => Effect.Effect<SessionLookup>;
    /** Ends one session early. Idempotent. */
    readonly close: (token: Redacted.Redacted<string>) => Effect.Effect<void>;
    /** Live sessions. Used by tests to prove nothing outlived its welcome. */
    readonly size: Effect.Effect<number>;
  }
>()("bit/http/BrowserSessions") {
  static readonly layer: Layer.Layer<BrowserSessions, never, FleetStore> =
    Layer.effect(BrowserSessions, makeSessions());

  /**
   * The registry over a password supplied by configuration rather than generated.
   *
   * Hashes once here, at layer construction, and holds only the hash — so the plaintext
   * `takeConfiguredPassword` read stops being reachable as soon as the graph is built,
   * and `open` has one verification path whatever the password's source.
   */
  static readonly layerWithPassword = (
    password: string,
  ): Layer.Layer<BrowserSessions, never, FleetStore> =>
    Layer.effect(
      BrowserSessions,
      Effect.promise(() =>
        Bun.password.hash(password, { algorithm: "argon2id" }),
      ).pipe(Effect.flatMap((hash) => makeSessions(hash))),
    );
}
