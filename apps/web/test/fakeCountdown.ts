/**
 * A hand-driven {@link Countdown}, so a timeout can be tested without waiting for one.
 *
 * The live transcript's silence watchdog fires after forty seconds, and reconnect backs
 * off after a failure. Waiting for either would make tests slow or timing-dependent. The
 * schedule is the seam — `App` takes one, exactly as it takes a control-plane client —
 * and this implementation records what was armed and lets a test fire it on purpose.
 *
 * That makes the assertions about the watchdog deterministic rather than timing-dependent:
 * "a frame re-armed it" is a statement about which timers are still live, not about how
 * fast the machine is.
 */
import type { Countdown } from "../src/lib/app.svelte";

/** One timer this double was asked for. */
export interface Armed {
  /** The delay the app asked for, in milliseconds. */
  readonly ms: number;
  /** Whether the app has since cancelled it. */
  cancelled: boolean;
  /** Fires it, as the real timer would. */
  readonly fire: () => void;
}

export class FakeCountdown implements Countdown {
  /** Every timer ever armed, in order, cancelled ones included. */
  readonly all: Armed[] = [];

  after = (ms: number, fire: () => void): (() => void) => {
    const armed: Armed = {
      ms,
      cancelled: false,
      fire: () => {
        armed.cancelled = true;
        fire();
      },
    };
    this.all.push(armed);
    return () => {
      armed.cancelled = true;
    };
  };

  /** The timers still outstanding. A healthy watcher has exactly one. */
  get live(): readonly Armed[] {
    return this.all.filter((armed) => !armed.cancelled);
  }

  /** The newest outstanding timer, which is the one a re-arm just created. */
  get latest(): Armed {
    const live = this.live;
    const newest = live[live.length - 1];
    if (newest === undefined) throw new Error("no countdown is armed");
    return newest;
  }

  /**
   * Fires the newest outstanding timer.
   *
   * Deliberately not "fire everything": a cancelled timer firing is the bug this double
   * exists to make visible, so a test that wanted that would have to reach for `all` and
   * say so.
   */
  fire(): void {
    this.latest.fire();
  }
}
