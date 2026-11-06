/**
 * Which configured harness a run gets, decided *in front of* {@link AgentHarness}.
 *
 * Slice B built one instance per process on purpose and recorded where the choice would
 * arrive: "as a resolver in front of `AgentHarness`, not as a change to that service"
 * (`run/model.ts`, `run/supervisor.ts`'s `RunInput.model`). This is that resolver, and
 * holding that line is what the shape below is for.
 *
 * ## What does not change
 *
 * **Nothing that drives a run can branch on a driver.** `startHalf`, the narration drain,
 * the settlement and the interrupt are all still written against one `AgentHarness` taken
 * from context — they cannot see this module, cannot enumerate instances and cannot ask
 * which driver they got. What changed is only *where the one they get comes from*: the
 * supervisor resolves once, per run, before it claims a workspace or forks anything, and
 * provides the result to the body with `Effect.provideService`. A resolver that had instead
 * been threaded through the run as a parameter would have put a second harness-shaped
 * value in reach of every function the run touches, which is the branch this avoids.
 *
 * That is also why {@link HarnessResolver.resolve} answers a whole
 * {@link ResolvedHarness} rather than, say, a driver kind: the only thing a caller can do
 * with the answer is use it, and there is no accessor here for "which kind is this" that a
 * `switch` could be hung off.
 *
 * ## Two eligibility predicates, not one
 *
 * Adopted from T3Code, which keeps *visible* and *ready* apart, and the split is not
 * ceremony:
 *
 * - **visible** is {@link isVisible} — the instance is `enabled`, meaning an operator has
 *   configured this process to drive it at all.
 * - **ready** is {@link isReady} — visible *and* `available` *and* `status === "ready"`.
 *
 * They differ because disabling is immediate while an observation lingers. An instance's
 * `status` is whatever the last look said; `enabled` is what the operator says now. One
 * predicate would have to pick which of those a screen obeys, and either choice is wrong
 * somewhere: obeying the stale status shows a harness the operator has switched off, and
 * obeying `enabled` alone offers a harness that will refuse.
 *
 * The consequence is the rule this product already follows everywhere else: **an unusable
 * harness stays visible with a reason** rather than disappearing. A picker that dropped a
 * harness an operator had configured would be a picker that answers "why is OpenCode not
 * there" with silence, and the honest answer — "it is configured and it would not start,
 * here is what it said" — is the one thing that gets it fixed.
 *
 * ## What `ready` can honestly mean here, and what it cannot
 *
 * **It cannot mean authenticated**, and that is a real limit rather than an omission.
 * Slice B set `auth: "unknown"` on both drivers with the reasoning recorded on
 * `identity.ts`: `opencode serve` starts happily with no provider credentials and only
 * fails at prompt time, and the Claude Agent SDK's `accountInfo()` needs a live session,
 * so probing either would mean starting a session and prompting nothing just to ask. A
 * `ready` that folded in `auth` would therefore be `false` for every working installation,
 * or would have to treat `unknown` as authenticated — which is the probe that lies.
 *
 * So `ready` means **this process built the harness and is holding it**: the binary is
 * there, the version floor is met, the child process (for OpenCode) came up, and a run can
 * be handed to it. {@link HarnessStatus} has exactly the two values that distinction
 * supports, and `unavailable` carries what the build failure said.
 *
 * **What that costs the setup affordance.** An instance that is enabled and installed but
 * *not logged in* is indistinguishable from a working one until something prompts it. So
 * `needsSetup` below fires for "it would not start" and never for "it is not
 * authenticated", and the first failure an unauthenticated operator sees is a refused run
 * rather than a greyed-out row. That is stated rather than papered over: the alternative
 * was a probe whose answer would be a guess, and a guess in this position would tell an
 * operator their login is fine when it is not.
 *
 * ## Instances are configuration, resolved once, and never re-pointed
 *
 * The set is fixed when this layer is built, because each entry *is* a built harness layer
 * — for OpenCode, a child process this scope owns. Adding or removing one is a restart,
 * which is what `HARNESS` already was.
 *
 * An attempt is **pinned** to the instance it started on: `persistence/migrations.ts`'s
 * `0014` stores `harness_instance_id` and nothing updates it, `recovery/harnessStatus.ts`
 * refuses to answer about a session on an instance this process does not configure, and
 * changing harness mid-engagement is a new attempt rather than a retarget
 * (DECISIONS.md §15). Nothing here offers a way to move one.
 */
import { Context, Effect, Layer, Schema } from "effect";

import { AgentHarness } from "./agentHarness";
import type { HarnessProcessError } from "./errors";
import type { DriverKind, HarnessInstance, InstanceId } from "./identity";

/**
 * Whether this process is holding a usable harness for one configured instance.
 *
 * Two values, and the module header says why there is no third: `auth` is not observable
 * without starting a session, so "installed but not logged in" cannot be told from
 * "working" and must not be invented as a state.
 */
export type HarnessStatus = "ready" | "unavailable";

/**
 * One configured instance, as this process found it.
 *
 * `instance` is the identity and the observed capability (`identity.ts`); everything else
 * here is this module's own judgement about whether a run may be sent to it.
 */
export interface HarnessListing {
  readonly instance: HarnessInstance;
  /** The operator configured this process to drive it. See {@link isVisible}. */
  readonly enabled: boolean;
  /** This process holds a built harness for it. */
  readonly available: boolean;
  readonly status: HarnessStatus;
  /**
   * Why it is not ready, in a sentence an operator can act on.
   *
   * `undefined` exactly when {@link isReady} holds, so a row that is not offered always
   * has something to say for itself — which is the whole point of keeping it visible.
   */
  readonly reason: string | undefined;
  /** What to do about it. `undefined` when there is nothing to do. */
  readonly setup: string | undefined;
  /** Whether a run that names no instance lands here. */
  readonly isDefault: boolean;
}

/** An instance an operator has configured. The weaker predicate: what a picker shows. */
export const isVisible = (listing: HarnessListing): boolean => listing.enabled;

/** An instance a run may be sent to. The stronger one: what a picker *offers*. */
export const isReady = (listing: HarnessListing): boolean =>
  listing.enabled && listing.available && listing.status === "ready";

/** An instance that is configured, visible and wants an operator's attention. */
export const needsSetup = (listing: HarnessListing): boolean =>
  isVisible(listing) && !isReady(listing);

/** One instance's harness, plus the identity it is pinned to. */
export interface ResolvedHarness {
  readonly instance: HarnessInstance;
  readonly harness: AgentHarness["Service"];
}

/**
 * A run that cannot be given a harness, before anything has been written.
 *
 * Its own error rather than a `HarnessTransportError`, because nothing was asked: naming
 * an instance this process does not configure, or one it could not build, is a condition
 * of *our* configuration and reporting it as "the harness did not answer" would send an
 * operator to look at the wrong thing. `run/supervisor.ts` maps it to the `harness_not_ready`
 * refusal, which is the one reason an operator fixes by choosing differently or by
 * installing something.
 */
export class HarnessNotReady extends Schema.TaggedError<HarnessNotReady>()(
  "HarnessNotReady",
  {
    /** What was asked for. The empty string when a run named nothing at all. */
    instanceId: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.instanceId === ""
      ? this.detail
      : `harness '${this.instanceId}': ${this.detail}`;
  }
}

export class HarnessResolver extends Context.Service<
  HarnessResolver,
  {
    /**
     * Every instance an operator configured, ready or not, in configuration order.
     *
     * A value rather than an effect, like `AgentHarness.instance` and for the same
     * reason: it is settled while this layer is built, and a picker that could be told
     * "not yet" would be a picker that renders empty on a server that has two harnesses.
     *
     * **The visible set, already filtered.** Disabling an instance is removing it from
     * `HARNESS`, which this process does by not making it a candidate — so nothing
     * unconfigured reaches here, and `enabled` is `true` on every entry by construction.
     * The field is still on {@link HarnessListing} because `enabled` is what
     * {@link isVisible} means, and a predicate whose input could not express its own
     * false case would be a predicate nobody could test.
     */
    readonly instances: readonly HarnessListing[];
    /**
     * Which instance a run that names none lands on.
     *
     * The first *ready* one in configuration order, so `HARNESS` is also the preference
     * order. `undefined` when nothing is ready — a state this process serves in, refusing
     * every start by name, exactly as a process with no harness at all already did.
     */
    readonly defaultInstanceId: InstanceId | undefined;
    /**
     * The harness for one instance, or a refusal naming why not.
     *
     * `undefined` asks for the default. A caller that passes an id gets *that* instance or
     * a refusal — never a fallback: silently running on a different harness than the
     * operator picked would write provenance nobody could trust, which is the whole reason
     * `0014` exists.
     */
    readonly resolve: (
      instanceId: string | undefined,
    ) => Effect.Effect<ResolvedHarness, HarnessNotReady>;
  }
>()("bit/harness/HarnessResolver") {
  /**
   * A resolver over instances that are already built, named by what it takes.
   *
   * For tests and for a composition root that has the harnesses in hand. The live
   * arrangement is {@link harnessResolverLayer}, which builds each candidate and keeps the
   * ones that failed as visible-with-a-reason.
   */
  static readonly fromEntries = (
    entries: readonly {
      readonly instance: HarnessInstance;
      readonly harness: AgentHarness["Service"] | undefined;
      readonly reason?: string | undefined;
      readonly setup?: string | undefined;
    }[],
  ): HarnessResolver["Service"] => {
    const held = new Map<string, AgentHarness["Service"]>();
    for (const entry of entries) {
      if (entry.harness !== undefined)
        held.set(entry.instance.instanceId, entry.harness);
    }
    const listings = entries.map((entry): HarnessListing => {
      const available = entry.harness !== undefined;
      return {
        instance: entry.instance,
        enabled: true,
        available,
        status: available ? "ready" : "unavailable",
        reason: available
          ? undefined
          : (entry.reason ??
            `${entry.instance.displayName} is configured but this server could not bring it up`),
        setup: available ? undefined : entry.setup,
        isDefault: false,
      };
    });
    const first = listings.find(isReady);
    const withDefault = listings.map((listing): HarnessListing => ({
      ...listing,
      isDefault: listing === first,
    }));
    const defaultInstanceId = first?.instance.instanceId;
    // Keyed by plain `string`, deliberately: what a caller asks with is whatever the
    // browser sent, and branding the key would mean validating an arbitrary string into an
    // `InstanceId` before we are able to say "no such instance" about it.
    const byId = new Map<string, HarnessListing>(
      withDefault.map((listing) => [listing.instance.instanceId, listing]),
    );

    return HarnessResolver.of({
      instances: withDefault,
      defaultInstanceId,
      resolve: (instanceId) =>
        Effect.suspend(() => {
          if (instanceId === undefined || instanceId === "") {
            if (defaultInstanceId === undefined) {
              return Effect.fail(
                new HarnessNotReady({
                  instanceId: "",
                  detail: nothingReady(withDefault),
                }),
              );
            }
            return resolveById(defaultInstanceId);
          }
          return resolveById(instanceId);
        }),
    });

    function resolveById(
      instanceId: string,
    ): Effect.Effect<ResolvedHarness, HarnessNotReady> {
      const listing = byId.get(instanceId);
      if (listing === undefined) {
        return Effect.fail(
          new HarnessNotReady({
            instanceId,
            detail: `this server does not configure a harness instance by that name. It is driving ${
              withDefault.length === 0
                ? "none"
                : withDefault
                    .map((entry) => `'${entry.instance.instanceId}'`)
                    .join(", ")
            }. An attempt is pinned to the instance it started on, so a run on a different harness is a new attempt rather than a retarget.`,
          }),
        );
      }
      const harness = held.get(instanceId);
      if (!isReady(listing) || harness === undefined) {
        return Effect.fail(
          new HarnessNotReady({
            instanceId,
            detail:
              listing.reason ??
              `${listing.instance.displayName} is configured but not usable in this server`,
          }),
        );
      }
      return Effect.succeed({ instance: listing.instance, harness });
    }
  };

  /** A resolver with nothing configured. Refuses every resolution by name. */
  static readonly empty: Layer.Layer<HarnessResolver> = Layer.succeed(
    HarnessResolver,
    HarnessResolver.fromEntries([]),
  );

  /**
   * A resolver over the one {@link AgentHarness} already in context.
   *
   * For everything that genuinely drives one harness and is not about choosing between
   * them: the spike demos, and the suites whose subject is what happens *around* an agent.
   * It is also the shape every slice-B caller had, so switching those over is one layer
   * rather than a rewrite — which is the test that the resolver really is in front of the
   * seam rather than tangled into it.
   */
  static readonly single: Layer.Layer<HarnessResolver, never, AgentHarness> =
    Layer.effect(
      HarnessResolver,
      Effect.map(AgentHarness, (harness) =>
        HarnessResolver.fromEntries([{ instance: harness.instance, harness }]),
      ),
    );

  /** A resolver over harnesses a caller already holds. Used by tests and demos. */
  static readonly fromHarnesses = (
    harnesses: readonly AgentHarness["Service"][],
  ): Layer.Layer<HarnessResolver> =>
    Layer.succeed(
      HarnessResolver,
      HarnessResolver.fromEntries(
        harnesses.map((harness) => ({ instance: harness.instance, harness })),
      ),
    );
}

/** The sentence a server with nothing usable gives for every start it refuses. */
const nothingReady = (listings: readonly HarnessListing[]): string =>
  listings.length === 0
    ? "this server has no agent harness configured, so there is nothing to run a worker in. Name one in HARNESS and restart."
    : `none of the harness instances this server configures is usable right now: ${listings
        .map(
          (listing) =>
            `'${listing.instance.instanceId}' — ${listing.reason ?? "unavailable"}`,
        )
        .join("; ")}`;

/**
 * One harness this process will try to bring up.
 *
 * `layer` is already provided with whatever that driver needs — OpenCode's child process,
 * for instance — so this module never knows what a driver depends on, only that building
 * it may fail with a {@link HarnessProcessError}.
 */
export interface HarnessCandidate {
  readonly driver: DriverKind;
  /** For the log line and for the refusal, before the instance exists to ask. */
  readonly displayName: string;
  readonly layer: Layer.Layer<AgentHarness, HarnessProcessError>;
  /**
   * What an operator does if it will not build.
   *
   * Per candidate rather than derived from the failure, because the failure says what went
   * wrong and this says what to do about it — and only the composition root knows which
   * binary or which package a given candidate came from.
   */
  readonly setup: string;
  /**
   * The instance the candidate is, when it cannot be asked.
   *
   * A harness that builds reports its own {@link HarnessInstance}, which is the one to
   * trust. A harness that does *not* build still has to appear in the picker with a
   * reason, and it never got far enough to report anything — so the candidate carries a
   * placeholder for exactly that case. Nothing routes by it except the row the operator
   * reads, and a run against it is refused before it is used for anything.
   */
  readonly placeholder: HarnessInstance;
}

/**
 * Brings up every candidate, keeps the ones that worked, and remembers why the rest did not.
 *
 * **A harness that will not start is not fatal, per instance now rather than per process.**
 * `main.ts` already made that decision for its one harness: `opencode` may be missing, the
 * Claude Agent SDK's CLI may not start (it once could also be a build too old to fail the
 * policy gate's hook closed, before the gate was removed), and a server that refused to
 * boot over either would be a server that cannot show what earlier runs
 * recorded. What is new is that one failing candidate no longer takes the *other* down
 * with it — which is the only way a two-instance installation is usable on a machine that
 * has one of the two installed.
 *
 * Only typed failures are kept as reasons. A **defect** in a harness build is a bug in our
 * spawn path rather than a missing binary, and it still takes the process down: there is
 * nothing an operator can do about it and a server that hid it would be harder to diagnose
 * than one that stopped. That is `main.ts`'s rule, unchanged.
 *
 * `Layer.build` acquires into this layer's own build scope — `Layer.effect` satisfies the
 * `Scope` requirement from it (`effect/src/Layer.ts`, `effect`: `Exclude<R, Scope.Scope>`)
 * — so each harness's lifetime is this layer's. For OpenCode that scope owns a child
 * process; for Claude Code it owns the open sessions' queries. The memo map is forked from
 * the ambient one, so nothing shared is built twice.
 */
export const harnessResolverLayer = (
  candidates: readonly HarnessCandidate[],
): Layer.Layer<HarnessResolver> =>
  Layer.effect(
    HarnessResolver,
    Effect.gen(function* () {
      const entries: {
        instance: HarnessInstance;
        harness: AgentHarness["Service"] | undefined;
        reason?: string | undefined;
        setup?: string | undefined;
      }[] = [];
      for (const candidate of candidates) {
        const built = yield* Effect.result(Layer.build(candidate.layer));
        if (built._tag === "Failure") {
          yield* Effect.logWarning(
            "a configured harness instance would not start; it stays visible in the picker with its reason and every run against it is refused",
            {
              driver: candidate.driver,
              instanceId: candidate.placeholder.instanceId,
              detail: built.failure.message,
            },
          );
          entries.push({
            instance: candidate.placeholder,
            harness: undefined,
            reason: built.failure.message,
            setup: candidate.setup,
          });
          continue;
        }
        const harness = Context.get(built.success, AgentHarness);
        yield* Effect.logInfo("a harness instance is ready", {
          instanceId: harness.instance.instanceId,
          driver: harness.instance.driver,
          version: harness.instance.version,
          defaultModel: harness.instance.defaultModel,
          models: harness.instance.models.length,
        });
        entries.push({ instance: harness.instance, harness });
      }
      return HarnessResolver.fromEntries(entries);
    }),
  );
