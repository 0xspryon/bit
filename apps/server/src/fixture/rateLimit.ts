/**
 * A bounded, deterministic local rate-limit fixture.
 *
 * It models the shape DECISIONS.md §15 lines 1484-1527 uses as its lifecycle example:
 * a small per-client limiter and a larger, independent per-account limiter. The two
 * are deliberately independent so a worker can establish something about the first
 * while the second remains genuinely untested.
 *
 * Determinism is the point. Counters never decay on a wall clock; they move only when
 * a request arrives or when the reset control is called, so a test's request budget
 * fully determines what it sees.
 *
 * **Client identity here is a request header, not a network address.** Varying it
 * simulates a client that presents a different identity to the application. It is not
 * IP rotation and must never be recorded as such.
 */

export interface RateLimitConfig {
  /** Requests per client identity before the client limiter trips. */
  readonly perClientLimit: number;
  /** Requests per account before the account limiter trips. Independent of the above. */
  readonly perAccountLimit: number;
}

export const DEFAULT_CONFIG: RateLimitConfig = {
  perClientLimit: 10,
  perAccountLimit: 100,
};

export type Decision =
  | { readonly status: 401; readonly reason: "invalid_credentials" }
  | { readonly status: 429; readonly limiter: "client"; readonly limit: number }
  | {
      readonly status: 429;
      readonly limiter: "account";
      readonly limit: number;
    };

export interface AttemptInput {
  readonly account: string;
  readonly clientId: string;
}

export interface FixtureState {
  readonly perClient: Readonly<Record<string, number>>;
  readonly perAccount: Readonly<Record<string, number>>;
  /** Admitted requests since the last reset. */
  readonly totalRequests: number;
  /**
   * Every request the fixture has ever seen, admitted or refused, across resets.
   * `reset` deliberately does not clear it: it is the host's independent record of
   * how much traffic a worker actually generated, so a worker's own claimed
   * `request_count` can be corroborated rather than taken on trust.
   */
  readonly lifetimeRequests: number;
}

/**
 * The limiter. Every authentication attempt is rejected on credentials, so a 401 means
 * "the request was admitted and the credentials were wrong" and a 429 means "the
 * request was refused before that". Keeping credentials always-invalid stops a
 * successful login from confounding the limiter observation.
 */
export class RateLimitFixture {
  private readonly perClient = new Map<string, number>();
  private readonly perAccount = new Map<string, number>();
  private total = 0;
  private lifetime = 0;

  constructor(private readonly config: RateLimitConfig = DEFAULT_CONFIG) {}

  /**
   * Checks the client limiter first, then the account limiter. A refused request does
   * not advance either counter: a limiter that counted its own rejections would make
   * the fixture's own bounds untestable.
   */
  attempt(input: AttemptInput): Decision {
    this.lifetime += 1;
    const clientCount = this.perClient.get(input.clientId) ?? 0;
    if (clientCount >= this.config.perClientLimit) {
      return {
        status: 429,
        limiter: "client",
        limit: this.config.perClientLimit,
      };
    }
    const accountCount = this.perAccount.get(input.account) ?? 0;
    if (accountCount >= this.config.perAccountLimit) {
      return {
        status: 429,
        limiter: "account",
        limit: this.config.perAccountLimit,
      };
    }
    this.perClient.set(input.clientId, clientCount + 1);
    this.perAccount.set(input.account, accountCount + 1);
    this.total += 1;
    return { status: 401, reason: "invalid_credentials" };
  }

  /** Deterministic reset control. Clears the limiter counters, not the audit total. */
  reset(): void {
    this.perClient.clear();
    this.perAccount.clear();
    this.total = 0;
  }

  /** Clears one client's counter, leaving account counters intact. */
  resetClient(clientId: string): void {
    this.perClient.delete(clientId);
  }

  state(): FixtureState {
    return {
      perClient: Object.fromEntries(this.perClient),
      perAccount: Object.fromEntries(this.perAccount),
      totalRequests: this.total,
      lifetimeRequests: this.lifetime,
    };
  }

  get limits(): RateLimitConfig {
    return this.config;
  }
}
