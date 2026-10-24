/**
 * The browser session registry and the password it checks, against a real control file.
 *
 * None of this uses an in-memory database: the password hash is a row in
 * `control.sqlite`, "generated once" is a claim about what a second boot against the same
 * file does, and a decoder cannot be trusted to prove either. The expiry test drives
 * `TestClock` rather than sleeping, because the lifetime is twelve hours and a test that
 * waited for it would not be a test.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer, Redacted } from "effect";
import { TestClock } from "effect/testing";

import {
  BrowserSessions,
  DEFAULT_SESSION_LIFETIME_MS,
  PASSWORD_ENV_VAR,
  PASSWORD_SETTING_KEY,
  ensureServerPassword,
  takeConfiguredPassword,
} from "./browserSessions";
import { FleetStore } from "../persistence/fleet";

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true });
  }
});

const newRoot = () => {
  const directory = mkdtempSync(join(tmpdir(), "bit-sessions-"));
  directories.push(directory);
  return directory;
};

/** Runs against a real `control.sqlite` under `root`, with its own session registry. */
const withRoot = <A, E>(
  root: string,
  use: Effect.Effect<A, E, BrowserSessions | FleetStore>,
  options?: {
    readonly testClock?: boolean;
    /** The registry under test, when it is not the generated-password one. */
    readonly sessions?: Layer.Layer<BrowserSessions, never, FleetStore>;
  },
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      use.pipe(
        Effect.provide(
          (options?.sessions ?? BrowserSessions.layer).pipe(
            Layer.provideMerge(FleetStore.layer(root)),
          ),
        ),
        Effect.provide(
          options?.testClock === true ? TestClock.layer() : Layer.empty,
        ),
      ) as Effect.Effect<A, E, never>,
    ),
  );

describe("the server password", () => {
  test("is generated once, stored as a hash, and never handed back again", async () => {
    const root = newRoot();
    const first = await withRoot(
      root,
      Effect.gen(function* () {
        const state = yield* ensureServerPassword();
        const fleet = yield* FleetStore;
        return {
          generated: state.generated,
          stored: yield* fleet.setting(PASSWORD_SETTING_KEY),
        };
      }),
    );
    expect(first.generated).toBeString();
    // 5 groups of 5 from a 31-symbol alphabet: around 124 bits, which is why there is no
    // complexity rule and no rotation policy.
    expect(first.generated).toMatch(/^[a-z2-9]{5}(-[a-z2-9]{5}){4}$/);
    expect(first.stored).toStartWith("$argon2id$");
    // The plaintext is not what is stored. Nothing can print it a second time because
    // nothing keeps it.
    expect(first.stored).not.toContain(first.generated ?? "never");

    const second = await withRoot(
      root,
      Effect.gen(function* () {
        const state = yield* ensureServerPassword();
        const fleet = yield* FleetStore;
        return {
          generated: state.generated,
          stored: yield* fleet.setting(PASSWORD_SETTING_KEY),
        };
      }),
    );
    expect(second.generated).toBeUndefined();
    expect(second.stored).toBe(first.stored);
  });

  test("a configured password wins and is never stored", async () => {
    const root = newRoot();
    // Configuration, not state: the environment is the authority on every boot, so
    // writing a hash here would leave something to shadow it the day the variable is
    // unset — and would also mean generating a password nothing is going to check.
    const state = await withRoot(
      root,
      Effect.gen(function* () {
        const result = yield* ensureServerPassword("set-by-the-operator");
        const fleet = yield* FleetStore;
        return {
          generated: result.generated,
          stored: yield* fleet.setting(PASSWORD_SETTING_KEY),
        };
      }),
    );
    expect(state.generated).toBeUndefined();
    expect(state.stored).toBeUndefined();
  });

  test("a configured password opens a session and a wrong one is refused", async () => {
    const root = newRoot();
    const observed = await withRoot(
      root,
      Effect.gen(function* () {
        const sessions = yield* BrowserSessions;
        const refusal = yield* Effect.flip(sessions.open("not-it"));
        const issued = yield* sessions.open("set-by-the-operator");
        return {
          refusal,
          lookup: yield* sessions.resolve(Redacted.value(issued.token)),
        };
      }),
      { sessions: BrowserSessions.layerWithPassword("set-by-the-operator") },
    );
    expect(observed.refusal._tag).toBe("SessionRefused");
    expect(observed.lookup._tag).toBe("Active");
  });

  test("reading the configured password removes it from the environment", () => {
    // The removal is the whole point: this process spawns an agent that runs
    // model-chosen shell commands, a child inherits what is in `process.env` at spawn
    // time, and `env` is a command. Nothing downstream should be able to find it.
    process.env[PASSWORD_ENV_VAR] = "set-by-the-operator";
    expect(takeConfiguredPassword()).toBe("set-by-the-operator");
    expect(process.env[PASSWORD_ENV_VAR]).toBeUndefined();
    // Idempotent, and an unset variable is indistinguishable from an already-taken one.
    expect(takeConfiguredPassword()).toBeUndefined();
    // An empty value is not a password. It must not become one that opens everything.
    process.env[PASSWORD_ENV_VAR] = "";
    expect(takeConfiguredPassword()).toBeUndefined();
    expect(process.env[PASSWORD_ENV_VAR]).toBeUndefined();
  });

  test("refuses every password when no hash is recorded, rather than accepting any", async () => {
    const root = newRoot();
    // Deliberately *not* calling `ensureServerPassword`: this is the fleet root whose
    // settings row was removed by hand, and the fail-closed direction is the one that
    // matters.
    const refusal = await withRoot(
      root,
      Effect.flatMap(BrowserSessions, (sessions) =>
        Effect.flip(sessions.open("anything-at-all")),
      ),
    );
    expect(refusal._tag).toBe("SessionRefused");
    expect(refusal).toMatchObject({ reason: "no_password_set" });
  });
});

describe("opening a session", () => {
  test("the right password issues a token; a wrong one issues nothing", async () => {
    const root = newRoot();
    const outcome = await withRoot(
      root,
      Effect.gen(function* () {
        const sessions = yield* BrowserSessions;
        const password = (yield* ensureServerPassword()).generated ?? "";
        const refusal = yield* Effect.flip(sessions.open(`${password}x`));
        const afterRefusal = yield* sessions.size;
        const issued = yield* sessions.open(password);
        return {
          refusal,
          afterRefusal,
          size: yield* sessions.size,
          token: Redacted.value(issued.token),
          session: issued.session,
          lookup: yield* sessions.resolve(Redacted.value(issued.token)),
        };
      }),
    );
    expect(outcome.refusal).toMatchObject({ reason: "invalid_password" });
    // "issues no session" is the claim Day 1 is tested by, so it is asserted as the
    // absence of a registry entry rather than as the presence of an error.
    expect(outcome.afterRefusal).toBe(0);
    expect(outcome.size).toBe(1);
    expect(outcome.token).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.session.expiresAt - outcome.session.issuedAt).toBe(
      DEFAULT_SESSION_LIFETIME_MS,
    );
    expect(outcome.lookup).toMatchObject({ _tag: "Active" });
  });

  test("an empty token and an unrecognised one are both unknown, not active", async () => {
    const root = newRoot();
    const outcome = await withRoot(
      root,
      Effect.gen(function* () {
        const sessions = yield* BrowserSessions;
        yield* ensureServerPassword();
        return {
          empty: yield* sessions.resolve(""),
          unrecognised: yield* sessions.resolve("f".repeat(64)),
          size: yield* sessions.size,
        };
      }),
    );
    // An empty bearer is what a request with no `Authorization` header decodes to, so it
    // has to be a lookup that fails rather than one that happens to miss the map.
    expect(outcome.empty._tag).toBe("Unknown");
    expect(outcome.unrecognised._tag).toBe("Unknown");
    expect(outcome.size).toBe(0);
  });

  test("an empty password is refused like any other wrong one", async () => {
    const root = newRoot();
    const outcome = await withRoot(
      root,
      Effect.gen(function* () {
        const sessions = yield* BrowserSessions;
        yield* ensureServerPassword();
        return {
          refusal: yield* Effect.flip(sessions.open("")),
          size: yield* sessions.size,
        };
      }),
    );
    expect(outcome.refusal).toMatchObject({ reason: "invalid_password" });
    expect(outcome.size).toBe(0);
  });
});

describe("a session's lifetime", () => {
  test("expires on its own clock, and reports expiry before it forgets", async () => {
    const root = newRoot();
    const outcome = await withRoot(
      root,
      Effect.gen(function* () {
        const sessions = yield* BrowserSessions;
        const password = (yield* ensureServerPassword()).generated ?? "";
        const issued = yield* sessions.open(password);
        const token = Redacted.value(issued.token);
        const fresh = yield* sessions.resolve(token);
        yield* TestClock.adjust(DEFAULT_SESSION_LIFETIME_MS);
        const stale = yield* sessions.resolve(token);
        // A second lookup of the same token: the first one removed it, so the registry
        // does not keep a list of everybody who has ever timed out.
        const again = yield* sessions.resolve(token);
        return { fresh, stale, again, size: yield* sessions.size };
      }),
      { testClock: true },
    );
    expect(outcome.fresh._tag).toBe("Active");
    expect(outcome.stale._tag).toBe("Expired");
    expect(outcome.again._tag).toBe("Unknown");
    expect(outcome.size).toBe(0);
  });

  test("closing a session ends it, and is idempotent", async () => {
    const root = newRoot();
    const outcome = await withRoot(
      root,
      Effect.gen(function* () {
        const sessions = yield* BrowserSessions;
        const password = (yield* ensureServerPassword()).generated ?? "";
        const issued = yield* sessions.open(password);
        yield* sessions.close(issued.token);
        const first = yield* sessions.resolve(Redacted.value(issued.token));
        yield* sessions.close(issued.token);
        return { first, size: yield* sessions.size };
      }),
    );
    expect(outcome.first._tag).toBe("Unknown");
    expect(outcome.size).toBe(0);
  });

  test("two sessions from one password are independent tokens", async () => {
    const root = newRoot();
    const outcome = await withRoot(
      root,
      Effect.gen(function* () {
        const sessions = yield* BrowserSessions;
        const password = (yield* ensureServerPassword()).generated ?? "";
        const one = yield* sessions.open(password);
        const two = yield* sessions.open(password);
        yield* sessions.close(one.token);
        return {
          distinct: Redacted.value(one.token) !== Redacted.value(two.token),
          closed: yield* sessions.resolve(Redacted.value(one.token)),
          open: yield* sessions.resolve(Redacted.value(two.token)),
        };
      }),
    );
    expect(outcome.distinct).toBe(true);
    expect(outcome.closed._tag).toBe("Unknown");
    expect(outcome.open._tag).toBe("Active");
  });
});
