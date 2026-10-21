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

/** What the first boot produced, if it produced anything. */
export interface ServerPasswordState {
  /**
   * The plaintext, present only on the boot that generated it.
   *
   * `undefined` on every later boot. A caller that wants to show the operator their
   * password after the fact cannot: there is nothing to show.
   */
  readonly generated: string | undefined;
}

/**
 * Makes sure a password hash exists, generating one on first boot.
 *
 * Idempotent: a second call finds the row and generates nothing. There is deliberately
 * no reset path here — regenerating a password is an operator action with consequences
 * for anybody holding a session, and it belongs on a settings screen rather than in a
 * startup helper that could be called twice.
 */
export const ensureServerPassword: Effect.Effect<
  ServerPasswordState,
  DatabaseError,
  FleetStore
> = Effect.gen(function* () {
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

const makeSessions = Effect.fnUntraced(function* () {
  const fleet = yield* FleetStore;
  const sessions = new Map<string, BrowserSession>();

  /**
   * Verifies a password and mints a session, or refuses with a reason.
   *
   * The hash is read from the settings table on every attempt rather than cached at
   * layer construction, so the stored value stays authoritative: when something later
   * changes the password, sessions opened after that change are checked against the new
   * one without a restart.
   *
   * A missing or empty hash refuses every password rather than accepting any. That is
   * the fail-closed direction, and it is reachable — a fleet root whose `settings` row
   * was deleted by hand is exactly the case where "no password configured" must not mean
   * "no password required".
   */
  const open: BrowserSessions["Service"]["open"] = Effect.fn(
    "BrowserSessions.open",
  )(function* (password: string) {
    const hash = yield* fleet.setting(PASSWORD_SETTING_KEY);
    if (hash === undefined || hash.length === 0) {
      return yield* new SessionRefused({
        reason: "no_password_set",
        detail:
          "this installation has no server password recorded; restart the server so it can generate one",
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
}
