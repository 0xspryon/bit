/**
 * One open `hunt.sqlite` per target, resolved by id, shared by reference count.
 *
 * This replaces the one thing `main.ts` used to do at startup: bind a single target's
 * store into the layer graph and serve that target only. The comment it carried said why
 * — "dispatching a request to the right target's store needs a per-target store resolver"
 * — and this is that resolver.
 *
 * ## What the problem actually is
 *
 * A target's graph is its own file (`targets/<id>/hunt.sqlite`, and the reasons are on
 * `persistence/fleet.ts`). So "open target B" means *open a database*, which is a
 * resource with a lifetime: it has to be migrated before it is read, closed when nothing
 * is using it, and must not be opened twice concurrently on the same file if that can be
 * avoided, because SQLite allows exactly one writer per file and two handles would
 * contend for it. {@link targetStoreLayer} already describes how to build one correctly.
 * What was missing is *when* to build it and when to let it go.
 *
 * Three answers that do not work, before the one that does:
 *
 * - **Open per request, close at the end.** Correct, and it pays `open + migrate + pragma`
 *   on every call — the migrator reads the journal table on each open. It also means two
 *   concurrent requests for one target hold two handles on one file and serialise against
 *   each other on the write lock.
 * - **Open everything at startup.** One file handle and one WAL per registered target,
 *   held for the life of the process, for targets nobody looked at. It also makes one
 *   unmigratable file a startup failure, which is precisely the global coupling the
 *   partial-migration policy exists to avoid.
 * - **An LRU of handles.** This is the one worth stating plainly, because it is the
 *   obvious reach: an LRU evicts by *recency of use*, which knows nothing about whether
 *   anyone is still holding what it evicts. A write in flight on the least-recently-used
 *   target is exactly the entry an LRU picks, and closing a connection under an open
 *   transaction is how a half-written attempt or a wedged lock happens.
 *
 * ## What `LayerMap` is
 *
 * `LayerMap` (`effect/LayerMap`, `@stability unstable` in 4.0.5) is a keyed cache of
 * *layers*: give it `(key) => Layer`, and it hands back, per key, the built services as
 * either a `Layer` or a scoped `Context`. Its own documentation names this use case —
 * "keyed resource families such as tenant clients" — and a target is exactly a tenant
 * here. {@link targetStoreLayer} is already a `(targetId) => Layer<ObservationStore, …>`,
 * so nothing had to be reshaped to fit.
 *
 * Underneath it is an `RcMap`, and that is the part that matters: entries are
 * **reference counted**, not LRU'd. `RcMap.get` increments a count and registers a
 * release finalizer on the *caller's* scope; the entry is dropped only when the count
 * reaches zero **and** it has then sat idle for `idleTimeToLive`
 * (`effect/src/RcMap.ts`, `release`). Nothing can take a connection away from a caller
 * that is still inside its scope — which is the property an LRU cannot offer and the
 * reason this is the right structure for a file with one write lock. A borrower holds a
 * reference for as long as its scope is open, so an in-flight write is unevictable by
 * construction rather than by timing.
 *
 * It also means two callers for the same target share one handle. The MCP route holding
 * `fixture-local` and a browser reading the same target's counts get the same connection
 * and the same write lock, instead of two handles queueing behind each other.
 *
 * ## The two numbers
 *
 * **`idleTimeToLive` — {@link TARGET_STORE_IDLE_TTL}.** This is only how long an *unused*
 * handle is kept warm; it is not a deadline on anything in use. Sixty seconds is long
 * enough to cover the way the screens actually behave — open a target, read the header,
 * click into a section, reload the tab — without re-migrating and re-opening the file for
 * each of those, and short enough that a target nobody is looking at stops holding a file
 * handle and a WAL within a minute. The WAL matters for more than tidiness: provable
 * deletion is why these are separate files at all, and `rm -rf targets/<id>/` against a
 * tree someone still has open is the one case where the operator's "it is gone" and the
 * filesystem's answer differ.
 *
 * **Capacity — deliberately none.** `LayerMap.make` exposes `idleTimeToLive` and
 * `preloadKeys`; a hard cap means dropping to `RcMap.make`, which takes `capacity`. Read
 * what capacity does there before wanting it: at the cap, `RcMap.get` **fails** with
 * `Cause.ExceededCapacityError` (`effect/src/RcMap.ts:558-562`) — it does not evict. An
 * idle entry with no borrowers still counts against the cap until its TTL expires, so the
 * failure mode is "the eleventh target an operator opens is refused, naming a limit,
 * while the entry that should have made room sits idle". That refusal is also not in this
 * module's error channel: it would reach a handler as neither {@link FleetError} nor
 * {@link DatabaseError}, so the typed-refusal-per-target discipline that lets one bad
 * target fail alone would be the first thing a cap broke. The bound that does exist is the
 * honest one: at most one handle per *registered* target, each released a minute after
 * last use. If file descriptors ever become the binding constraint, the place to say "no
 * more than N targets open" is admission — a decision with an operator-facing message —
 * and not a cache that answers with a capacity error.
 *
 * ## Why this is a service and not a bare `LayerMap`
 *
 * {@link TargetStores} exposes {@link TargetStores.open}, which takes a target id and
 * returns that target's store **in a scope**. That signature is the boundary rule the
 * slice is about: there is no way to obtain an `ObservationStore` without naming a
 * target, because `ObservationStore` is not in any handler's context — it is only ever a
 * value handed back by `open`. The `Scope` in the requirement is not noise either: it is
 * the borrow, and it is why `Effect.scoped` at the request boundary is what returns the
 * reference. A handler cannot forget to release it any more than it can forget to close a
 * `try`/`finally` the compiler wrote.
 *
 * The error channel is `FleetError | DatabaseError`, straight through from
 * {@link targetStoreLayer}: the registry is consulted, an unregistered or unmigrated
 * target is refused *by name*, and only then is a file opened. One target that will not
 * open is one failed request. Its neighbours are untouched, and the listener does not
 * care — which is the partial-failure policy `fleet.ts` settled, now reaching the HTTP
 * surface.
 *
 * ## Two traps, both found by running it
 *
 * **`RcMap` caches failures, not just resources.** An entry is created the moment a key
 * is asked for and completed with whatever the lookup produced, so a target that refused
 * to open kept its entry — and was refused *from cache*, with the stale reason, for the
 * length of the idle TTL. That turned "fix the file and retry" into "fix the file and
 * wait", and let every mistyped id in a URL hold an entry. {@link TargetStores.open}
 * clears a key whose lookup failed; `targetStores.test.ts` asserts both halves, including
 * that a target re-migrated by a later sweep opens on the very next request.
 *
 * **One shared `MemoMap` shares module-level layers.** `LayerMap` builds every entry
 * through **one `Layer.MemoMap`**
 * (`effect/src/LayerMap.ts`, `Layer.buildWithMemoMap`). A `MemoMap` memoizes by layer
 * *object identity*, so any module-level `Layer` constant inside the per-target graph is
 * built once and shared by every target. `persistence/sql.ts` had two: the pragma layer
 * and the driver's `Reactivity` layer. The first was not a theoretical problem — the
 * second target's connection came up with `foreign_keys = 0`, silently, because that
 * layer produces no service and so had nothing to re-produce. Both are per-file
 * factories now, the reasoning is recorded there, and `sql.test.ts` builds two files
 * through one `MemoMap` and reads the pragmas back off both rather than trusting this
 * paragraph.
 */
import {
  Context,
  Duration,
  Effect,
  Layer,
  LayerMap,
  RcMap,
  Scope,
} from "effect";

import { FleetStore, targetStoreLayer, type FleetError } from "./fleet";
import { ObservationStore } from "./store";
import type { DatabaseError } from "./sql";

/**
 * How long an unborrowed target store is kept open.
 *
 * Not a timeout on anything in use: reference counting means an entry with a borrower is
 * never released, whatever this says. The reasoning for the value is in this module's
 * header, under "The two numbers".
 */
export const TARGET_STORE_IDLE_TTL = Duration.seconds(60);

const make = Effect.fnUntraced(function* (options?: {
  readonly idleTimeToLive?: Duration.Input | undefined;
}) {
  const stores = yield* LayerMap.make(targetStoreLayer, {
    idleTimeToLive: options?.idleTimeToLive ?? TARGET_STORE_IDLE_TTL,
    // No `preloadKeys`: a store is opened when something asks for that target, which is
    // the whole point. Preloading would reintroduce "open every target at startup" for
    // whichever ids were listed, and nothing here knows which target an operator will
    // open next.
  });

  return TargetStores.of({
    open: (targetId) =>
      Effect.map(stores.contextEffect(targetId), (context) =>
        // The entry is a `Context` holding exactly what `targetStoreLayer` provides. The
        // store is pulled out here so callers deal in the service, not in a context they
        // would have to provide to something.
        Context.get(context, ObservationStore),
      ).pipe(
        // A *refusal* is not a resource, so it is not cached. `RcMap` stores an entry as
        // soon as a key is asked for and completes it with whatever the lookup produced —
        // a failure included — so without this an unopenable target would keep its entry
        // for the idle TTL and be refused from cache. Two consequences, both wrong:
        // a target fixed by a later sweep would still be refused for a minute with the
        // stale reason, and every mistyped id in a URL would hold a map entry. Clearing
        // it here also closes the entry immediately rather than at the TTL, because the
        // borrower's release then finds nothing in the map to keep warm.
        //
        // This is not a thundering herd, which is the thing to check before accepting it.
        // `RcMap` completes one entry per key through a `Deferred`: concurrent requests
        // for a key already being looked up join the existing entry and await the same
        // result, so a wave of requests for one broken target does **one** registry read
        // and one failed open between them, not one each. What this invalidate buys is
        // that the *next* wave tries again rather than being answered from a stale
        // failure — retry semantics, not an amplification of them.
        Effect.tapError(() => stores.invalidate(targetId)),
      ),
    pinnedLayerFor: (targetId, reason) =>
      stores
        .get(targetId)
        .pipe(
          Layer.tap(() =>
            Effect.logDebug(
              `pinned target store '${targetId}' for the process lifetime: ${reason}`,
            ),
          ),
        ),
    invalidate: (targetId) => stores.invalidate(targetId),
    openTargetIds: Effect.map(RcMap.keys(stores.rcMap), (keys) => [...keys]),
  });
});

/**
 * The per-target store resolver.
 *
 * One instance per process, owned by the layer's scope: when that scope closes every
 * cached store closes with it, in reverse, like any other scoped resource.
 */
export class TargetStores extends Context.Service<
  TargetStores,
  {
    /**
     * Borrows one target's store for the current scope.
     *
     * The id is checked and the registry consulted before any file is opened, so the
     * failures are the registry's own: an unusable id, an unregistered target, or one
     * whose last migration did not succeed. The reference is returned when the scope
     * closes; the handle itself stays open for {@link TARGET_STORE_IDLE_TTL} after the
     * last borrower leaves, so the next request for the same target reuses it.
     */
    readonly open: (
      targetId: string,
    ) => Effect.Effect<
      ObservationStore["Service"],
      FleetError | DatabaseError,
      Scope.Scope
    >;
    /**
     * **Pins** one target's store for the lifetime of the returned layer's scope.
     *
     * For a consumer whose requirement is `ObservationStore` and whose lifetime is a
     * layer rather than a request — today, only the MCP route, which is pinned to one
     * target until the mutation boundary learns to dispatch by credential. The reference
     * is held for as long as the layer is alive, so this entry is never idle and never
     * released while the process runs. That is the reference count doing its job, not a
     * leak — but it *is* a pin, and a pin is a decision rather than a detail.
     *
     * The name says "pinned" and `reason` is required for that: this used to be
     * `layerFor`, and the only thing standing between it and a request-shaped caller
     * pinning one target for the process was a paragraph of documentation. A caller now
     * has to state why a process-lifetime borrow is the right shape, and the reason is
     * logged when the pin is taken, so `openTargetIds` showing a target that nobody
     * appears to be using has an explanation in the log rather than in someone's memory.
     *
     * Prefer {@link open} for anything request-shaped: a pinned borrow cannot be keyed by
     * what a particular request is about.
     */
    readonly pinnedLayerFor: (
      targetId: string,
      reason: string,
    ) => Layer.Layer<ObservationStore, FleetError | DatabaseError>;
    /**
     * Drops the cached entry for a target, so the next {@link open} re-reads the registry
     * and re-opens the file.
     *
     * Borrowers are not interrupted — an invalidated entry stays alive until the last of
     * them leaves, it is merely no longer handed to anyone new. This is what a caller
     * wants after archiving a target or after a later sweep changes its schema state.
     */
    readonly invalidate: (targetId: string) => Effect.Effect<void>;
    /**
     * Which targets have a file open right now.
     *
     * Diagnostics, and the only honest way for a test to assert that a handle was
     * released rather than merely unreferenced.
     */
    readonly openTargetIds: Effect.Effect<readonly string[]>;
  }
>()("bit/persistence/TargetStores") {
  /** The resolver over one fleet. */
  static readonly layer: Layer.Layer<TargetStores, never, FleetStore> =
    Layer.effect(TargetStores, make());

  /**
   * Pins one target's store, resolved from whichever resolver is in context.
   *
   * The convenience form of {@link TargetStores.pinnedLayerFor} for a composition root,
   * where the resolver is a layer rather than a value in hand. It carries the same
   * `reason` requirement and the same warning: this is a process-lifetime borrow, and
   * anything request-shaped wants {@link TargetStores.open} instead.
   */
  static readonly pinned = (
    targetId: string,
    reason: string,
  ): Layer.Layer<ObservationStore, FleetError | DatabaseError, TargetStores> =>
    Layer.unwrap(
      Effect.map(TargetStores, (stores) =>
        stores.pinnedLayerFor(targetId, reason),
      ),
    );

  /**
   * The resolver with a different idle TTL.
   *
   * Exists for tests that have to watch an idle handle go: sixty seconds is the right
   * answer for an operator and the wrong one for a test suite, and a test that waited it
   * out would be sixty seconds of nothing. Nothing in the server passes this.
   */
  static readonly layerWith = (options: {
    readonly idleTimeToLive: Duration.Input;
  }): Layer.Layer<TargetStores, never, FleetStore> =>
    Layer.effect(TargetStores, make(options));
}

/**
 * Runs one effect against one target's store, and returns the borrow.
 *
 * The shape every request-scoped caller wants: name a target, use its store, release.
 * `Effect.scoped` is inside, so the reference is given back when `use` finishes however
 * it finishes, and the result carries no `Scope` requirement outwards — which is what
 * lets an `HttpApi` handler call it without the route acquiring a per-request scope
 * requirement of its own.
 *
 * The resolver is a parameter rather than something this reads from the context, for the
 * reason recorded on `http/browserApi.ts`'s `describeTarget`: a requirement yielded
 * *inside* a handler becomes a per-request requirement of the route. Captured once when
 * the handler group is built, it stays a layer requirement.
 */
export const withTargetStore = <A, E>(
  stores: TargetStores["Service"],
  targetId: string,
  use: (store: ObservationStore["Service"]) => Effect.Effect<A, E>,
): Effect.Effect<A, E | FleetError | DatabaseError> =>
  Effect.scoped(Effect.flatMap(stores.open(targetId), use));
