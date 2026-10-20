import { describe, expect, test } from "bun:test";

import { DEFAULT_CONFIG, RateLimitFixture } from "./rateLimit";

const drain = (
  fixture: RateLimitFixture,
  count: number,
  input: { account: string; clientId: string },
) => Array.from({ length: count }, () => fixture.attempt(input));

describe("RateLimitFixture", () => {
  test("admits exactly perClientLimit requests for one client identity", () => {
    const fixture = new RateLimitFixture({
      perClientLimit: 10,
      perAccountLimit: 100,
    });
    const results = drain(fixture, 11, { account: "alice", clientId: "c1" });

    expect(results.slice(0, 10).every((r) => r.status === 401)).toBe(true);
    expect(results[10]).toEqual({ status: 429, limiter: "client", limit: 10 });
  });

  test("a refused request does not advance the counters", () => {
    const fixture = new RateLimitFixture({
      perClientLimit: 2,
      perAccountLimit: 100,
    });
    drain(fixture, 5, { account: "alice", clientId: "c1" });

    // Two admitted, three refused: the account counter must show two, not five.
    expect(fixture.state().perAccount["alice"]).toBe(2);
    expect(fixture.state().totalRequests).toBe(2);
  });

  test("client limiters are independent, so a new identity gets a fresh budget", () => {
    const fixture = new RateLimitFixture({
      perClientLimit: 3,
      perAccountLimit: 100,
    });
    expect(
      drain(fixture, 4, { account: "alice", clientId: "c1" })[3]?.status,
    ).toBe(429);

    const other = fixture.attempt({ account: "alice", clientId: "c2" });
    expect(other.status).toBe(401);
  });

  test("the account limiter is independent and larger, and trips on its own", () => {
    const fixture = new RateLimitFixture({
      perClientLimit: 5,
      perAccountLimit: 12,
    });
    // Rotate client identity every 5 requests so the client limiter never interferes.
    const outcomes: number[] = [];
    for (let i = 0; i < 15; i += 1) {
      outcomes.push(
        fixture.attempt({ account: "alice", clientId: `c${Math.floor(i / 5)}` })
          .status,
      );
    }
    expect(outcomes.filter((status) => status === 401)).toHaveLength(12);
    const refusal = fixture.attempt({ account: "alice", clientId: "c9" });
    expect(refusal).toEqual({ status: 429, limiter: "account", limit: 12 });
  });

  test("account exhaustion does not bleed into a different account", () => {
    const fixture = new RateLimitFixture({
      perClientLimit: 50,
      perAccountLimit: 2,
    });
    drain(fixture, 3, { account: "alice", clientId: "c1" });

    expect(fixture.attempt({ account: "bob", clientId: "c1" }).status).toBe(
      401,
    );
  });

  test("reset is deterministic and restores the full budget", () => {
    const fixture = new RateLimitFixture({
      perClientLimit: 2,
      perAccountLimit: 4,
    });
    drain(fixture, 2, { account: "alice", clientId: "c1" });
    expect(fixture.attempt({ account: "alice", clientId: "c1" }).status).toBe(
      429,
    );

    fixture.reset();

    expect(fixture.state()).toMatchObject({
      perClient: {},
      perAccount: {},
      totalRequests: 0,
    });
    expect(fixture.attempt({ account: "alice", clientId: "c1" }).status).toBe(
      401,
    );
  });

  test("resetClient clears one client without touching account counters", () => {
    const fixture = new RateLimitFixture({
      perClientLimit: 2,
      perAccountLimit: 100,
    });
    drain(fixture, 2, { account: "alice", clientId: "c1" });

    fixture.resetClient("c1");

    expect(fixture.state().perClient["c1"]).toBeUndefined();
    expect(fixture.state().perAccount["alice"]).toBe(2);
    expect(fixture.attempt({ account: "alice", clientId: "c1" }).status).toBe(
      401,
    );
  });

  test("the lifetime counter survives reset so traffic can be corroborated", () => {
    const fixture = new RateLimitFixture({
      perClientLimit: 2,
      perAccountLimit: 100,
    });
    drain(fixture, 4, { account: "alice", clientId: "c1" });
    fixture.reset();
    drain(fixture, 2, { account: "alice", clientId: "c1" });

    // Four attempts (two refused) plus two more: six requests reached the fixture.
    expect(fixture.state().lifetimeRequests).toBe(6);
    expect(fixture.state().totalRequests).toBe(2);
  });

  test("counters never move on a wall clock", () => {
    const fixture = new RateLimitFixture({
      perClientLimit: 1,
      perAccountLimit: 10,
    });
    fixture.attempt({ account: "alice", clientId: "c1" });
    const before = fixture.state();
    // No elapsed-time decay exists, so repeated reads are identical by construction.
    expect(fixture.state()).toEqual(before);
    expect(fixture.attempt({ account: "alice", clientId: "c1" }).status).toBe(
      429,
    );
  });

  test("the shipped defaults keep the client limit far below the account limit", () => {
    // The first investigation must be able to exhaust a client budget without
    // approaching the account budget, or the two limiters are not separable.
    expect(DEFAULT_CONFIG.perClientLimit).toBeLessThan(
      DEFAULT_CONFIG.perAccountLimit,
    );
  });
});
