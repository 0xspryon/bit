/**
 * How long a long-lived agent session's authority lives, and who can end it.
 *
 * Extracted from `plan/goalConversation.ts`, which was the only correct implementation of
 * this in the process, when the scope importer became the second surface to need it. The
 * worker attempt and the planner round are the third and fourth (the importer
 * conversation design's "generic spine"), and the point of extracting rather than copying
 * is that the fourth copy is the one nobody reconciles.
 *
 * ## What this owns, which is authority and lifetime and nothing else
 *
 * 1. **The registry.** `id → { scope, harness, sessionId, instanceId, model, narrator }`.
 *    A scope in no map is a scope nothing can close.
 * 2. **The per-id opening permit**, with the live map re-read inside it. Without it two
 *    concurrent first messages on one goal opened two sessions — a review measured exactly
 *    that against the running server — and the loser's no-expiry credential and live MCP
 *    registration stayed alive until process death, because `live.set` keeps one and the
 *    other scope was in no map.
 * 3. **The acquire order**, because each step rules out the next step's ambiguity:
 *    gated directory → session → credential → MCP registration → prompt. A failure at any
 *    step closes the scope, which revokes the credential and unregisters the server —
 *    including when the *next* step is the one that failed.
 * 4. **{@link LiveAgentSessions.closeSession}**: narrator interrupted first, so nothing is
 *    published for a session whose credential is about to go; then the scope; then a
 *    belt-and-braces revoke whose expected answer is zero and whose non-zero answer is a
 *    logged bug rather than a handled condition. Anything keyed by the id — the map entry,
 *    the id-wide revoke, `afterClose` — is touched only while the id is still this entry's.
 * 5. **The layer finalizer**, closing every session still open, which is what makes "no
 *    longer than the process" true.
 *
 * ## What it does not own
 *
 * What a session *means*. The role and its endpoint, the credential kind, the prompt
 * assemblers, the grouping rule, whether there is a settlement — those are the surface's,
 * passed in as a {@link LiveSessionRole} (fixed per surface) and an {@link OpenPlan} (per
 * open). A worker attempt is not a conversation, and an abstraction that owned both would
 * have to invent a settlement for a goal and a composer for a worker.
 *
 * ## One implementation, one registry per surface
 *
 * {@link makeLiveAgentSessions} is called once inside each surface's own layer and returns
 * that surface's registry. Not one process-wide `Context` service, for two reasons. The
 * finalizer belongs to the surface's layer scope, so a surface's sessions close when *its*
 * layer does, after its own in-flight fibers are interrupted (scope finalizers run in
 * reverse). And ids are only unique within a surface — a goal id and an import id share no
 * namespace — so a shared map would need keys nothing else uses.
 *
 * ## The `preambled` flag, and the ordering it relies on
 *
 * An entry is published into the map **before** its opening prompt is sent — it has to be,
 * because it owns the `Scope` holding the credential and the registration. So between
 * publish and acceptance there is a window in which a caller's outside-the-permit read finds
 * a live entry that has not been told what it is. {@link LiveAgentSessions.ready} only
 * returns an entry once `preambled` is true, and `preambled` is set by {@link open}
 * **after the prompt is accepted and before the permit is released** — so no interleaving
 * can observe a preambled entry that has not been preambled, and a reader that falls through
 * to the permit finds the entry either preambled or gone.
 */
import { bitMcpServerName, type ModelOptionSelection } from "@bit/contracts";
import { Effect, Exit, Fiber, Redacted, Scope, Semaphore } from "effect";

import {
  OPEN_PROMPT,
  type AgentHarness,
  type HarnessFailure,
} from "./agentHarness";
import type { HarnessNotReady } from "./resolver";
import type { CredentialRefused, IssuedCredential } from "../mcp/credentials";
import type { DatabaseError } from "../persistence/sql";
import type {
  FleetError,
  FleetStore,
  UngatedRoleDirectory,
} from "../persistence/fleet";
import {
  gatedRoleDirectory,
  POLICY_AUDIT_FILE,
  type GatedDirectory,
  type PolicyHookNotInstalled,
} from "../policy/install";
import type { WorkerUrls } from "../run/supervisor";

/**
 * `AgentHarness.createSession`, narrowed so that the directory must be gated.
 *
 * `plan/planSupervisor.ts`'s `createPlannerSession` and for its reason: `GatedDirectory` is
 * a brand, `createSession` takes `directory: string`, and a brand that is never *asked for*
 * at a call site constrains nothing. This is the one call that opens a long-lived session,
 * so passing a path that has not been through `gatedRoleDirectory` is a compile error rather
 * than a convention.
 *
 * `multiTurn: true` is set here rather than by a caller, because it is not a choice a
 * caller could sensibly make differently: every session this registry holds is prompted
 * again after its first turn, and a session closed when it went idle could not take that.
 */
const createGatedSession = (
  harness: AgentHarness["Service"],
  input: {
    readonly title: string;
    readonly model: string;
    readonly directory: GatedDirectory;
    readonly sessionId: string;
    readonly options?: readonly ModelOptionSelection[] | undefined;
  },
) => harness.createSession({ ...input, multiTurn: true });

/** One session this process is holding, as the registry knows it. */
export interface LiveAgentSession<Meta> {
  /** The surface's own key: a goal id, an import id. */
  readonly id: string;
  readonly targetId: string;
  readonly sessionId: string;
  readonly instanceId: string;
  readonly model: string;
  readonly harness: AgentHarness["Service"];
  /** Owns the credential and the MCP registration. Closed by `closeSession`. */
  readonly scope: Scope.Closeable;
  /** Drains the session's narration, for a surface that has one. Interrupted first on close. */
  readonly narrator: Fiber.Fiber<void, never> | undefined;
  readonly openedAt: number;
  /** Whether the opening prompt has been accepted. See this module's header. */
  readonly preambled: boolean;
  /** What the surface keeps beside the session. Opaque here. */
  readonly meta: Meta;
}

/**
 * Why a session was closed, which is the whole list of things that close one.
 *
 * - `operator` — the surface's own intentional close: the operator ended it.
 * - `shutdown` — this registry's layer finalizer, on the way down.
 * - `refused` — the harness refused a prompt, so the session was given up on.
 * - `open_failed` — an open that published its entry and then never reached `ready`.
 *
 * Every close ends the session's authority period in this process — the credential and the
 * registration go either way. Only `operator` says the authority is *over*; the other three
 * are this process letting go. The spine passes the reason through to `afterClose` and
 * does nothing else with it; a surface that persists an ending is what gives it meaning.
 */
export type LiveSessionCloseReason =
  "operator" | "shutdown" | "refused" | "open_failed";

/** Everything opening a session can fail with, before the surface maps it to its own refusal. */
export type LiveSessionOpenFailure =
  | FleetError
  | DatabaseError
  | PolicyHookNotInstalled
  | HarnessFailure
  | HarnessNotReady
  | CredentialRefused;

/**
 * What a surface is, as far as authority goes. Fixed per surface.
 *
 * The credential pair is the one place a surface's *kind* is decided: `issue` mints the
 * grant the registration carries, and `revokeStray` is the belt-and-braces revoke for that
 * same kind, so a surface cannot issue one kind and check for another.
 */
export interface LiveSessionRole<Meta> {
  /** Which of the role endpoints this session's MCP registration points at. */
  readonly endpoint: (urls: WorkerUrls) => string;
  /** Mints the session's credential, in the session's own scope. */
  readonly issue: (input: {
    readonly id: string;
    readonly targetId: string;
  }) => Effect.Effect<IssuedCredential, CredentialRefused, Scope.Scope>;
  /** Revokes every grant of this surface's kind for one id, answering how many there were. */
  readonly revokeStray: (id: string) => Effect.Effect<number>;
  /**
   * Runs after a session is closed and its revoke checked, with why it was closed. Must
   * not fail. Not run for a stale close (see `closeSession`).
   */
  readonly afterClose?: (
    entry: LiveAgentSession<Meta>,
    reason: LiveSessionCloseReason,
  ) => Effect.Effect<void>;
  /** The log lines, in the surface's own words. */
  readonly words: {
    readonly unregisterRefused: string;
    readonly strayCredential: string;
    readonly closed: string;
    /** The annotation the surface's id is logged under: `goalId`, `importId`. */
    readonly idKey: string;
  };
}

/** What one open needs that the surface decides at the time. */
export interface OpenPlan<Meta> {
  readonly targetId: string;
  readonly harness: AgentHarness["Service"];
  readonly model: string;
  /**
   * `createSession`'s `options`: already resolved against {@link model}'s descriptors
   * (`harness/modelOptions.ts`), and absent — never `[]` — when the operator set nothing.
   */
  readonly options?: readonly ModelOptionSelection[] | undefined;
  readonly sessionId: string;
  readonly title: string;
  /** Makes the role directory. Gated by the spine and by no other code path. */
  readonly ensureDirectory: Effect.Effect<
    UngatedRoleDirectory,
    FleetError | DatabaseError
  >;
  /** The engagement folder, or `undefined` for a target with none — a statement, not an omission. */
  readonly workspace: string | undefined;
  /**
   * Runs once `createSession` has returned and before the credential is minted. Must not
   * fail: it is the importer's advisory index mark, and a surface with nothing to record
   * passes nothing.
   */
  readonly afterCreate?: (sessionId: string) => Effect.Effect<void>;
  /** Drains narration for a surface that publishes it. Forked into the session's scope. */
  readonly narrate?: (sessionId: string) => Effect.Effect<void>;
  /** Runs after publish and before the opening prompt. Must not fail. */
  readonly beforePrompt?: (
    entry: LiveAgentSession<Meta>,
  ) => Effect.Effect<void>;
  /** The opening prompt, built at the moment it is sent rather than when the plan was. */
  readonly openingPrompt: (entry: LiveAgentSession<Meta>) => string;
  readonly meta: Meta;
}

export interface LiveAgentSessions<Meta> {
  /** The entry for one id, preambled or not. For reads that only need the session id. */
  readonly get: (id: string) => LiveAgentSession<Meta> | undefined;
  /**
   * The entry for one id **only if it has had its opening prompt**: the outside-the-permit
   * fast path. An unpreambled entry reads as absent, so its caller falls through to
   * {@link open}, whose permit the opener holds until the prompt is accepted.
   */
  readonly ready: (id: string) => LiveAgentSession<Meta> | undefined;
  /**
   * Opens a session for one id under that id's permit, or joins the one already there.
   *
   * Inside the permit the live map is read again first: a caller that waited while another
   * opened the session goes to `joined` with the winner's entry rather than building a
   * second. Otherwise `prepare` runs (the surface's own checks and harness choice, still
   * inside the permit), then the acquire order, publish, `beforePrompt`, the opening prompt,
   * and only then `preambled` — and `opened` runs last, still holding the permit.
   *
   * An acquire failure closes the scope before the entry was ever published; a prompt the
   * harness refuses closes the published session. Either is mapped through `refuse`.
   */
  readonly open: <A, E, R>(input: {
    readonly id: string;
    readonly joined: (entry: LiveAgentSession<Meta>) => Effect.Effect<A, E, R>;
    readonly prepare: Effect.Effect<OpenPlan<Meta>, E, R>;
    readonly refuse: (failure: LiveSessionOpenFailure) => E;
    readonly opened: (entry: LiveAgentSession<Meta>) => Effect.Effect<A, E, R>;
  }) => Effect.Effect<A, E, R>;
  /**
   * Gives up on one session: narration first, then its scope, then the belt-and-braces
   * revoke. See this module's header for why the order matters and why a non-zero revoke
   * is logged as a bug.
   *
   * Safe to call with a stale entry: if the map no longer holds this exact entry, only the
   * entry's own narrator and scope are closed, and nothing keyed by its id is touched.
   */
  readonly closeSession: (
    entry: LiveAgentSession<Meta>,
    reason: LiveSessionCloseReason,
  ) => Effect.Effect<void>;
  /**
   * Gives one later message to a session that has had its opening prompt.
   *
   * **A `steer` at `queued` urgency, and the spine decides that rather than each surface**
   * (DECISIONS.md §24.1): the work in flight finishes, then the message runs. `preemptive`
   * would cut off whatever the agent was in the middle of — including a tool call it was
   * about to report on — and an operator sending a second message has not asked for that.
   * Two conversations deciding delivery timing separately is the drift this module exists
   * to prevent.
   *
   * **A refusal closes the session, as `refused`**, which is the third item on the list of
   * things that close one: the session has been prompted-and-failed, this seam never
   * resubmits, and on Claude Code a refusal includes a query that has already closed. So
   * the *next* message opens a fresh session rather than failing the same way forever.
   * Closing is the spine's because it is lifetime; what the next message opens, and under
   * which id, is the surface's.
   *
   * **The message id is minted, not derived.** A derived id needs an operation identity to
   * derive from, and an operator message has none: the draft carries the operator's words
   * and nothing else, and deriving from the text would silently swallow a legitimately
   * repeated sentence. So a double-submitted "yes" is two messages, because that is what was
   * sent twice.
   *
   * The prompt is the surface's, already assembled: what a follow-up carries is what the
   * session *means*, which this module does not own.
   */
  readonly deliver: (
    entry: LiveAgentSession<Meta>,
    prompt: string,
  ) => Effect.Effect<void, HarnessFailure>;
  /** {@link closeSession} by id. Idempotent, and safe for an id with nothing live. */
  readonly close: (
    id: string,
    reason: LiveSessionCloseReason,
  ) => Effect.Effect<void>;
}

/**
 * Builds one surface's registry, and registers the finalizer that closes it with the
 * calling layer's scope.
 */
export const makeLiveAgentSessions = <Meta>(
  deps: {
    readonly fleet: FleetStore["Service"];
    readonly endpoints: { readonly urls: Effect.Effect<WorkerUrls> };
  },
  role: LiveSessionRole<Meta>,
): Effect.Effect<LiveAgentSessions<Meta>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { fleet, endpoints } = deps;

    /**
     * One entry per id this process is holding a session for.
     *
     * Not a `FiberMap`, unlike the supervisors', and the difference is the point: there is no
     * supervising fiber here. A session is a harness session plus a credential plus maybe a
     * narration drain, and the thing that owns its lifetime is a `Scope` — so what this map
     * holds is the scope and the handle, and closing is closing a scope rather than
     * interrupting work.
     */
    const live = new Map<string, LiveAgentSession<Meta>>();

    /**
     * One permit per id, held while a session is being opened for it.
     *
     * It covers the whole of "decide there is nothing, then build it", with the check
     * re-read inside the permit — the same shape of claim `claimedGoals` in
     * `plan/planSupervisor.ts` and the workspace claim in `run/supervisor.ts` take. One entry
     * per id ever opened, bounded by what an operator has opened, and not swept for the same
     * reason `claimedGoals` is not.
     */
    const opening = new Map<string, Semaphore.Semaphore>();
    const openingLock = (id: string): Semaphore.Semaphore => {
      const held = opening.get(id);
      if (held !== undefined) return held;
      const made = Semaphore.makeUnsafe(1);
      opening.set(id, made);
      return made;
    };

    const annotate = (entry: LiveAgentSession<Meta>) => ({
      [role.words.idKey]: entry.id,
      targetId: entry.targetId,
      sessionId: entry.sessionId,
    });

    /**
     * How many times an open has started building for each id.
     *
     * Read by {@link closeSession} and nothing else, to tell whether a newer session for the
     * same id began acquiring while this close was suspended — see there.
     */
    const builds = new Map<string, number>();

    /*
     * **Only the entry the map still holds is the id's to close.** A close can be stale: two
     * messages took the fast path into one session and both prompts failed; the first failure
     * closed it, a third message opened a fresh session under the same id, and the second
     * failure then arrives holding the *old* entry. Deleting by id there would drop the new
     * session from the map — its scope then in no map, its registration and narrator alive
     * until process death — and the belt-and-braces revoke, which works by id, would kill the
     * new session's credential and log it as a stray. So the map and the id-wide revoke are
     * touched only when the map still holds this exact entry, compared by its `Scope` (the
     * preambled replacement is a different object over the same scope). The entry's own
     * narrator and scope are closed either way: they are this entry's, and must go.
     *
     * The check is made before the first suspension, so nothing can interleave between
     * reading the map and deleting from it.
     *
     * **The same revoke can also hit a session that is not yet in any map.** Once this close
     * has deleted the entry, a message that arrives while the scope is still closing (an
     * unregister is a round trip to the harness) finds nothing live, takes the permit, and
     * mints a credential for the same id. So the revoke runs only if no open has started
     * building for this id since the close began; if one has, the revoke is skipped, which
     * gives up the bug detector for that one close rather than revoking a credential this
     * close does not own.
     */
    const closeSession = Effect.fnUntraced(function* (
      entry: LiveAgentSession<Meta>,
      reason: LiveSessionCloseReason,
    ) {
      const current = live.get(entry.id)?.scope === entry.scope;
      if (current) live.delete(entry.id);
      const buildsAtClose = builds.get(entry.id) ?? 0;
      if (entry.narrator !== undefined) yield* Fiber.interrupt(entry.narrator);
      yield* Scope.close(entry.scope, Exit.void);
      if (!current) {
        yield* Effect.logDebug(
          "a stale close found a newer session, or none, under the same id; only its own scope was closed",
          annotate(entry),
        );
        return;
      }
      if ((builds.get(entry.id) ?? 0) === buildsAtClose) {
        const stray = yield* role.revokeStray(entry.id);
        if (stray > 0) {
          yield* Effect.logError(role.words.strayCredential, {
            [role.words.idKey]: entry.id,
            sessionId: entry.sessionId,
            revoked: stray,
          });
        }
      } else {
        yield* Effect.logInfo(
          "a newer session for the same id began opening while this one was closing, so the belt-and-braces revoke was skipped rather than run against its credential",
          annotate(entry),
        );
      }
      if (role.afterClose !== undefined) yield* role.afterClose(entry, reason);
      yield* Effect.logInfo(role.words.closed, annotate(entry));
    });

    // Owned by the calling layer's scope, so a `SIGINT` closes every session rather than
    // dropping it with a live credential behind it.
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        [...live.values()],
        (entry) => closeSession(entry, "shutdown"),
        { discard: true },
      ),
    );

    /**
     * The acquire order, inside the session's own scope, and nothing published yet.
     *
     * **1. The directory, through `gatedRoleDirectory` and no other way.** The gate goes in a
     * directory where the agent is not expected to run a shell command, which is the point:
     * the gate is what turns that expectation into a fact. Under OpenCode the directory is
     * also the authority boundary (DECISIONS.md §24.2) — the only session in it is this one,
     * which is what makes a credential with no expiry containable.
     *
     * **2. The session, `multiTurn`.** Set here rather than by the plan, because a session
     * this registry holds is by definition one that outlives a turn; a session closed when it
     * went idle could not take the second message.
     *
     * **3. The credential, then the registration**, both in the session's scope, so both go
     * when {@link closeSession} closes it.
     */
    const acquire = (plan: OpenPlan<Meta>, urls: WorkerUrls) =>
      Effect.gen(function* () {
        const harness = plan.harness;
        const directory: GatedDirectory = yield* gatedRoleDirectory({
          ensure: plan.ensureDirectory,
          install: harness.installGate,
          policyUrl: urls.policy,
          // Outside the role directory: the gate's own record must not be somewhere the
          // gated agent can read or rewrite. `gatedRoleDirectory` refuses the nesting.
          auditPath: `${fleet.paths.evidenceDirectory(plan.targetId)}/${POLICY_AUDIT_FILE}`,
          workspace: plan.workspace,
        });
        const created = yield* createGatedSession(harness, {
          title: plan.title,
          model: plan.model,
          directory,
          sessionId: plan.sessionId,
          ...(plan.options === undefined ? {} : { options: plan.options }),
        });
        if (plan.afterCreate !== undefined) yield* plan.afterCreate(created.id);
        return { created, directory };
      });

    const register = (
      plan: OpenPlan<Meta>,
      id: string,
      urls: WorkerUrls,
      created: { readonly id: string },
      directory: GatedDirectory,
    ) =>
      Effect.gen(function* () {
        const harness = plan.harness;
        const credential = yield* role.issue({ id, targetId: plan.targetId });
        const serverName = bitMcpServerName(id);
        yield* Effect.acquireRelease(
          harness.registerMcpServer(created.id, serverName, {
            // The role's endpoint. This line decides which tool list the session is
            // offered: `mcp/server.ts` serves one toolkit per path, and each endpoint's
            // middleware refuses a grant whose tag is not the role it serves — so "which
            // tools" is a property of the registration rather than of a filter.
            url: role.endpoint(urls),
            headers: {
              authorization: Redacted.make(
                `Bearer ${Redacted.value(credential.token)}`,
              ),
            },
            directory,
          }),
          () =>
            harness.unregisterMcpServer(created.id, serverName).pipe(
              Effect.catch((failure) =>
                Effect.logWarning(role.words.unregisterRefused, {
                  [role.words.idKey]: id,
                  server: serverName,
                  detail: failure.message,
                }),
              ),
            ),
        );
      });

    const ready: LiveAgentSessions<Meta>["ready"] = (id) => {
      const entry = live.get(id);
      return entry !== undefined && entry.preambled ? entry : undefined;
    };

    const open: LiveAgentSessions<Meta>["open"] = (input) =>
      Semaphore.withPermit(openingLock(input.id))(
        Effect.gen(function* () {
          // The winner's session, if one was built while this caller waited. No `preambled`
          // check, and its absence is not an oversight: the opener holds this permit across
          // the prompt, so an entry reachable from in here is preambled or already gone.
          const raced = live.get(input.id);
          if (raced !== undefined) return yield* input.joined(raced);

          const plan = yield* input.prepare;
          /*
           * Counted once `prepare` has said this open will build, and before anything is
           * acquired, so a close already in flight for this id sees it. Not before `prepare`:
           * a surface may come in here only to join, with a `prepare` that refuses rather than
           * builds — the importer does, because nothing is ever built under an import id that
           * has been opened before — and counting that would make a concurrent close skip its
           * belt-and-braces revoke for a build that never happened. `prepare` acquires
           * nothing by contract (the surface's checks and its harness choice), so nothing it
           * does can be what the revoke would wrongly hit.
           */
          builds.set(input.id, (builds.get(input.id) ?? 0) + 1);
          const urls = yield* endpoints.urls;
          const harness = plan.harness;

          /*
           * The session's own scope, which outlives the caller.
           *
           * `Scope.make` rather than the caller's scope, because the caller is an HTTP handler
           * about to answer or a fiber about to finish its first turn: a credential acquired
           * in either would be revoked the moment the caller moved on. Made under
           * `uninterruptibleMask`, so there is no instant at which it exists and the
           * exit handler below does not cover it.
           *
           * How far this open got, for the exit handler below and nothing else.
           *
           * An opener can end without reaching `ready` in two ways the typed-failure paths
           * do not see. It can be **interrupted** — an HTTP handler whose client went away,
           * an importer's first-turn fiber the operator stopped. Or it can **die** — a
           * harness, a surface callback or a prompt assembler throwing — and a defect passes
           * through `Effect.result` exactly as an interrupt does. Either way: ended while
           * `building`, the scope is in no map and nothing else could ever close it; ended
           * while `published`, the entry is in the map unpreambled, the permit is released,
           * and the next caller *inside* the permit — which does not check the flag — would
           * deliver into a session that was never framed. So the handler acts on every exit
           * that is not a success, which keeps "an entry reachable inside the permit is
           * preambled or gone" true on every path. The typed-failure paths close what they
           * built themselves and then say so by moving to `closed`, so nothing is closed
           * twice.
           */
          let stage:
            | { readonly _tag: "building" }
            | {
                readonly _tag: "published";
                readonly entry: LiveAgentSession<Meta>;
              }
            | { readonly _tag: "closed" }
            | { readonly _tag: "ready" } = { _tag: "building" };

          const preambledEntry = yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const scope = yield* Scope.make();
              return yield* restore(
                Effect.gen(function* () {
                  const opened = yield* Effect.result(
                    Effect.gen(function* () {
                      const { created, directory } = yield* acquire(plan, urls);
                      yield* register(plan, input.id, urls, created, directory);
                      return created.id;
                    }).pipe(Scope.provide(scope)),
                  );
                  if (opened._tag === "Failure") {
                    // Nothing was registered or the session could not be made: close
                    // the scope rather than leave a credential behind a session that
                    // does not exist.
                    yield* Scope.close(scope, Exit.void);
                    stage = { _tag: "closed" };
                    return yield* Effect.fail(input.refuse(opened.failure));
                  }

                  const narrate = plan.narrate;
                  const narrator =
                    narrate === undefined
                      ? undefined
                      : yield* Effect.forkIn(narrate(opened.success), scope);
                  const entry: LiveAgentSession<Meta> = {
                    id: input.id,
                    targetId: plan.targetId,
                    sessionId: opened.success,
                    instanceId: harness.instance.instanceId,
                    model: plan.model,
                    harness,
                    scope,
                    narrator,
                    openedAt: Date.now(),
                    // Nothing has been said to this session yet. Published anyway — a
                    // scope in no map is a scope nothing can close — so what keeps a
                    // message out of it until the opening prompt has landed is this
                    // flag rather than the absence of an entry.
                    preambled: false,
                    meta: plan.meta,
                  };
                  live.set(input.id, entry);
                  stage = { _tag: "published", entry };

                  if (plan.beforePrompt !== undefined)
                    yield* plan.beforePrompt(entry);

                  const prompted = yield* Effect.result(
                    harness.prompt(
                      entry.sessionId,
                      plan.openingPrompt(entry),
                      OPEN_PROMPT,
                    ),
                  );
                  if (prompted._tag === "Failure") {
                    // Nothing ran, and the session is useless: it has been
                    // prompted-and-failed, and this seam never resubmits a prompt. Closed
                    // so the next open builds a fresh one.
                    yield* closeSession(entry, "refused");
                    stage = { _tag: "closed" };
                    return yield* Effect.fail(input.refuse(prompted.failure));
                  }
                  /*
                   * The opening prompt has landed, so the session may be reached from
                   * outside the permit. Set here and nowhere else — after acceptance and
                   * before the permit is released. A replacement entry rather than a
                   * mutation, because the entry is readonly; the `Scope` and the narrator
                   * are the same objects, so `closeSession` closes the same things either
                   * way.
                   */
                  const preambledEntry: LiveAgentSession<Meta> = {
                    ...entry,
                    preambled: true,
                  };
                  live.set(input.id, preambledEntry);
                  stage = { _tag: "ready" };
                  return preambledEntry;
                }),
              ).pipe(
                // Every exit, not only an interrupt: see `stage` above for why a defect
                // needs exactly what an interrupt does.
                Effect.onExit((exit) => {
                  if (Exit.isSuccess(exit)) return Effect.void;
                  const reached = stage;
                  return reached._tag === "building"
                    ? Scope.close(scope, Exit.void)
                    : reached._tag === "published"
                      ? closeSession(reached.entry, "open_failed")
                      : Effect.void;
                }),
              );
            }),
          );
          return yield* input.opened(preambledEntry);
        }),
      );

    const deliver: LiveAgentSessions<Meta>["deliver"] = (entry, prompt) =>
      Effect.gen(function* () {
        const accepted = yield* Effect.result(
          entry.harness.prompt(entry.sessionId, prompt, {
            _tag: "steer",
            urgency: "queued",
            messageId: crypto.randomUUID().replaceAll("-", ""),
          }),
        );
        if (accepted._tag === "Failure") {
          yield* closeSession(entry, "refused");
          return yield* Effect.fail(accepted.failure);
        }
      });

    return {
      get: (id) => live.get(id),
      ready,
      open,
      closeSession,
      deliver,
      close: (id, reason) => {
        const entry = live.get(id);
        return entry === undefined ? Effect.void : closeSession(entry, reason);
      },
    } satisfies LiveAgentSessions<Meta>;
  });
