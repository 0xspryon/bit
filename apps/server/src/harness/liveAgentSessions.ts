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
 *    logged bug rather than a handled condition.
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
import { bitMcpServerName } from "@bit/contracts";
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
  /** Runs after a session is closed and its revoke checked. Must not fail. */
  readonly afterClose?: (entry: LiveAgentSession<Meta>) => Effect.Effect<void>;
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
   */
  readonly closeSession: (entry: LiveAgentSession<Meta>) => Effect.Effect<void>;
  /** {@link closeSession} by id. Idempotent, and safe for an id with nothing live. */
  readonly close: (id: string) => Effect.Effect<void>;
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

    const closeSession = Effect.fnUntraced(function* (
      entry: LiveAgentSession<Meta>,
    ) {
      live.delete(entry.id);
      if (entry.narrator !== undefined) yield* Fiber.interrupt(entry.narrator);
      yield* Scope.close(entry.scope, Exit.void);
      const stray = yield* role.revokeStray(entry.id);
      if (stray > 0) {
        yield* Effect.logError(role.words.strayCredential, {
          [role.words.idKey]: entry.id,
          sessionId: entry.sessionId,
          revoked: stray,
        });
      }
      if (role.afterClose !== undefined) yield* role.afterClose(entry);
      yield* Effect.logInfo(role.words.closed, annotate(entry));
    });

    // Owned by the calling layer's scope, so a `SIGINT` closes every session rather than
    // dropping it with a live credential behind it.
    yield* Effect.addFinalizer(() =>
      Effect.forEach([...live.values()], closeSession, { discard: true }),
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
          const urls = yield* endpoints.urls;
          const harness = plan.harness;

          /*
           * The session's own scope, which outlives the caller.
           *
           * `Scope.make` rather than the caller's scope, because the caller is an HTTP handler
           * about to answer or a fiber about to finish its first turn: a credential acquired
           * in either would be revoked the moment the caller moved on.
           */
          const scope = yield* Scope.make();

          const opened = yield* Effect.result(
            Effect.gen(function* () {
              const { created, directory } = yield* acquire(plan, urls);
              yield* register(plan, input.id, urls, created, directory);
              return created.id;
            }).pipe(Scope.provide(scope)),
          );
          if (opened._tag === "Failure") {
            // Nothing was registered or the session could not be made: close the scope
            // rather than leave a credential behind a session that does not exist.
            yield* Scope.close(scope, Exit.void);
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
            // Nothing has been said to this session yet. Published anyway — a scope in no
            // map is a scope nothing can close — so what keeps a message out of it until the
            // opening prompt has landed is this flag rather than the absence of an entry.
            preambled: false,
            meta: plan.meta,
          };
          live.set(input.id, entry);

          if (plan.beforePrompt !== undefined) yield* plan.beforePrompt(entry);

          const prompted = yield* Effect.result(
            harness.prompt(
              entry.sessionId,
              plan.openingPrompt(entry),
              OPEN_PROMPT,
            ),
          );
          if (prompted._tag === "Failure") {
            // Nothing ran, and the session is useless: it has been prompted-and-failed, and
            // this seam never resubmits a prompt. Closed so the next open builds a fresh one.
            yield* closeSession(entry);
            return yield* Effect.fail(input.refuse(prompted.failure));
          }
          /*
           * The opening prompt has landed, so the session may be reached from outside the
           * permit. Set here and nowhere else — after acceptance and before the permit is
           * released. A replacement entry rather than a mutation, because the entry is
           * readonly; the `Scope` and the narrator are the same objects, so `closeSession`
           * closes the same things either way.
           */
          const preambledEntry: LiveAgentSession<Meta> = {
            ...entry,
            preambled: true,
          };
          live.set(input.id, preambledEntry);
          return yield* input.opened(preambledEntry);
        }),
      );

    return {
      get: (id) => live.get(id),
      ready,
      open,
      closeSession,
      close: (id) => {
        const entry = live.get(id);
        return entry === undefined ? Effect.void : closeSession(entry);
      },
    } satisfies LiveAgentSessions<Meta>;
  });
