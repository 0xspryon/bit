/**
 * The resolver in front of the seam: what it offers, what it refuses, and what stays visible.
 *
 * Every claim here is a *behaviour* of the choice rather than of a harness, which is why
 * nothing in this file starts a process. The three that matter:
 *
 * 1. **An unusable instance stays visible with its reason.** A candidate whose layer fails
 *    is in the listing, not ready, carrying what it said and what to do about it. That is
 *    the rule the picker exists to make possible and the one a filter would quietly undo.
 * 2. **Resolution is never a substitution.** Naming an instance that is unconfigured, or
 *    configured and broken, is refused by name — never answered with a working harness.
 *    An attempt is pinned to the instance it starts on, so a silent swap would make the
 *    stored provenance wrong.
 * 3. **The two predicates are kept apart.** `isVisible` is `enabled`; `isReady` is
 *    `enabled && available && status === "ready"`. They are tested directly rather than
 *    through the listing, because the whole point of the split is the case where they
 *    disagree.
 */
import { describe, expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime } from "effect";

import { AgentHarness } from "./agentHarness";
import { HarnessProcessError } from "./errors";
import {
  DriverKind,
  defaultInstanceIdForDriver,
  type HarnessInstance,
} from "./identity";
import {
  HarnessResolver,
  harnessResolverLayer,
  isReady,
  isVisible,
  needsSetup,
  type HarnessCandidate,
  type HarnessListing,
} from "./resolver";
import { stubHarness, STUB_INSTANCE } from "./stubHarness";

const ALPHA = DriverKind.make("alpha");
const BETA = DriverKind.make("beta");

const instanceFor = (
  driver: DriverKind,
  overrides: Partial<HarnessInstance> = {},
): HarnessInstance => ({
  ...STUB_INSTANCE,
  instanceId: defaultInstanceIdForDriver(driver),
  driver,
  displayName: driver === ALPHA ? "Alpha harness" : "Beta harness",
  ...overrides,
});

/** A candidate whose layer builds, over a stub that reports the given instance. */
const working = (driver: DriverKind, models?: readonly string[]) =>
  ({
    driver,
    displayName: instanceFor(driver).displayName,
    layer: Layer.succeed(
      AgentHarness,
      stubHarness({
        instance: instanceFor(
          driver,
          models === undefined
            ? {}
            : {
                models: models.map((id) => ({ id })),
                defaultModel: models[0] ?? "",
              },
        ),
      }),
    ),
    setup: `install ${driver}`,
    placeholder: instanceFor(driver),
  }) satisfies HarnessCandidate;

/** A candidate whose layer refuses, the way a missing or too-old harness does. */
const broken = (driver: DriverKind, detail: string) =>
  ({
    driver,
    displayName: instanceFor(driver).displayName,
    layer: Layer.effect(
      AgentHarness,
      Effect.fail(
        new HarnessProcessError({
          operation: "spawn",
          detail,
          diagnostics: "",
        }),
      ),
    ),
    setup: `install ${driver} and log in`,
    placeholder: instanceFor(driver),
  }) satisfies HarnessCandidate;

const withResolver = async <A>(
  candidates: readonly HarnessCandidate[],
  use: (resolver: HarnessResolver["Service"]) => Promise<A> | A,
): Promise<A> => {
  const runtime = ManagedRuntime.make(harnessResolverLayer(candidates));
  try {
    const resolver = await runtime.runPromise(
      Effect.map(HarnessResolver, (it) => it),
    );
    return await use(resolver);
  } finally {
    await runtime.dispose();
  }
};

const listing = (overrides: Partial<HarnessListing> = {}): HarnessListing => ({
  instance: instanceFor(ALPHA),
  enabled: true,
  available: true,
  status: "ready",
  reason: undefined,
  setup: undefined,
  isDefault: false,
  ...overrides,
});

describe("the two eligibility predicates", () => {
  test("visible is enabled; ready is enabled and available and ready", () => {
    expect(isVisible(listing())).toBe(true);
    expect(isReady(listing())).toBe(true);
  });

  /**
   * The case the split exists for.
   *
   * Disabling is immediate and a stale probe status lingers, so a one-predicate picker has
   * to choose which of the two a screen obeys — and either choice is wrong somewhere. Here
   * the status still says `ready` and the operator has switched it off: it must be neither
   * visible nor offered.
   */
  test("a disabled instance whose status still says ready is neither", () => {
    const disabled = listing({ enabled: false });
    expect(isVisible(disabled)).toBe(false);
    expect(isReady(disabled)).toBe(false);
  });

  test("an enabled instance that is not available is visible but not ready", () => {
    const stale = listing({
      available: false,
      status: "unavailable",
      reason: "would not start",
    });
    expect(isVisible(stale)).toBe(true);
    expect(isReady(stale)).toBe(false);
    // Which is exactly the state that wants an operator's attention.
    expect(needsSetup(stale)).toBe(true);
  });

  test("a ready instance wants no setup affordance", () => {
    expect(needsSetup(listing())).toBe(false);
  });
});

describe("the listing", () => {
  test("two working candidates are both listed, the first is the default", async () => {
    await withResolver([working(ALPHA), working(BETA)], (resolver) => {
      expect(
        resolver.instances.map((entry) => String(entry.instance.instanceId)),
      ).toEqual(["alpha", "beta"]);
      expect(String(resolver.defaultInstanceId)).toBe("alpha");
      expect(
        resolver.instances.filter((entry) => entry.isDefault),
      ).toHaveLength(1);
    });
  });

  /**
   * Configuration order is preference order.
   *
   * `HARNESS=beta,alpha` is how an operator says which harness an unqualified run lands
   * on, so the resolver must not sort or prefer by driver.
   */
  test("the order candidates are given in is the order they are preferred in", async () => {
    await withResolver([working(BETA), working(ALPHA)], (resolver) => {
      expect(String(resolver.defaultInstanceId)).toBe("beta");
    });
  });

  /**
   * The rule the picker exists for: visible with a reason, not gone.
   *
   * A candidate that would not build is listed, not ready, and carries both the harness's
   * own words and the setup line. Dropping it would answer "why is Alpha missing?" with
   * silence.
   */
  test("a candidate that will not build stays listed with its reason and its setup", async () => {
    await withResolver(
      [broken(ALPHA, "no such binary on PATH"), working(BETA)],
      (resolver) => {
        expect(resolver.instances).toHaveLength(2);
        const alpha = resolver.instances.find(
          (entry) => entry.instance.instanceId === "alpha",
        );
        expect(alpha).toBeDefined();
        expect(isVisible(alpha!)).toBe(true);
        expect(isReady(alpha!)).toBe(false);
        expect(alpha?.reason).toContain("no such binary on PATH");
        expect(alpha?.setup).toContain("install alpha");
        // And the one that *did* build is the default, so a broken first candidate does
        // not leave the server with no default at all.
        expect(String(resolver.defaultInstanceId)).toBe("beta");
      },
    );
  });

  test("a server whose every candidate is broken has no default and lists both", async () => {
    await withResolver(
      [broken(ALPHA, "missing"), broken(BETA, "too old")],
      (resolver) => {
        expect(resolver.instances).toHaveLength(2);
        expect(resolver.instances.every((entry) => !isReady(entry))).toBe(true);
        expect(resolver.defaultInstanceId).toBeUndefined();
      },
    );
  });

  test("a working candidate reports its own models, not the placeholder's", async () => {
    await withResolver([working(ALPHA, ["a/one", "a/two"])], (resolver) => {
      expect(resolver.instances[0]?.instance.models).toEqual([
        { id: "a/one" },
        { id: "a/two" },
      ]);
      expect(resolver.instances[0]?.instance.defaultModel).toBe("a/one");
    });
  });
});

describe("resolution", () => {
  test("no instance named resolves to the default", async () => {
    await withResolver([working(ALPHA), working(BETA)], async (resolver) => {
      const resolved = await Effect.runPromise(resolver.resolve(undefined));
      expect(String(resolved.instance.instanceId)).toBe("alpha");
    });
  });

  test("an instance named resolves to that one", async () => {
    await withResolver([working(ALPHA), working(BETA)], async (resolver) => {
      const resolved = await Effect.runPromise(resolver.resolve("beta"));
      expect(String(resolved.instance.instanceId)).toBe("beta");
    });
  });

  /**
   * A name this server does not configure is refused, and the refusal lists what it has.
   *
   * Never a fallback. An attempt records the instance that ran it, so answering with a
   * working harness would make that record wrong — and the operator would have no way to
   * know their choice was ignored.
   */
  test("an unconfigured instance is refused by name and never substituted", async () => {
    await withResolver([working(ALPHA)], async (resolver) => {
      const result = await Effect.runPromise(
        Effect.result(resolver.resolve("gamma")),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") return;
      expect(result.failure.instanceId).toBe("gamma");
      expect(result.failure.message).toContain("'alpha'");
      expect(result.failure.message).toContain("pinned");
    });
  });

  /** Configured and broken is also a refusal, and carries what the harness said. */
  test("an instance that would not build is refused with its own reason", async () => {
    await withResolver(
      [working(ALPHA), broken(BETA, "the version floor is not met")],
      async (resolver) => {
        const result = await Effect.runPromise(
          Effect.result(resolver.resolve("beta")),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag !== "Failure") return;
        expect(result.failure.message).toContain(
          "the version floor is not met",
        );
      },
    );
  });

  test("a server with nothing usable refuses an unqualified resolve too", async () => {
    await withResolver([broken(ALPHA, "missing")], async (resolver) => {
      const result = await Effect.runPromise(
        Effect.result(resolver.resolve(undefined)),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") return;
      // Names the instance and its reason rather than claiming there is no harness: the
      // operator configured one, and "none of them is usable" is the honest answer.
      expect(result.failure.message).toContain("'alpha'");
      expect(result.failure.message).toContain("missing");
    });
  });

  test("an empty resolver refuses everything and says to name one", async () => {
    const result = await Effect.runPromise(
      Effect.result(
        Effect.flatMap(HarnessResolver, (resolver) =>
          resolver.resolve(undefined),
        ).pipe(Effect.provide(HarnessResolver.empty)),
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    expect(result.failure.message).toContain("HARNESS");
  });

  /**
   * The one-instance resolver every slice-B caller now goes through.
   *
   * It is the shape the spike demos and the suites that are not about choosing use, and it
   * answering the harness in context is what makes switching them over one layer rather
   * than a rewrite.
   */
  test("the single-instance resolver answers the harness in context", async () => {
    const harness = stubHarness();
    const resolved = await Effect.runPromise(
      Effect.flatMap(HarnessResolver, (resolver) =>
        resolver.resolve(undefined),
      ).pipe(
        Effect.provide(
          HarnessResolver.single.pipe(
            Layer.provide(Layer.succeed(AgentHarness, harness)),
          ),
        ),
        Effect.scoped,
      ),
    );
    expect(String(resolved.instance.instanceId)).toBe(
      String(STUB_INSTANCE.instanceId),
    );
  });
});
