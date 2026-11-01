/**
 * The application-owned MCP server.
 *
 * Transport, protocol framing and tool dispatch are Effect's
 * (`McpServer.layerHttp`, `effect/src/ai/McpServer.ts:1649`), not ours. The ~200 lines
 * of handwritten JSON-RPC this replaces had to be read against the spec to be trusted;
 * what remains is the part that is actually ours: the auth boundary and the binding of
 * the Bun HTTP server to the Effect router.
 *
 * Shape follows T3Code (MIT) `apps/server/src/mcp/McpHttpServer.ts:183-185,861-867`.
 *
 * **Fails closed.** The auth middleware runs before any protocol handling, so a request
 * with no bearer token, an unknown token or an expired one is refused with `401` and
 * never reaches a tool, a tool list, or even `initialize`. There is no anonymous path
 * and no default caller. The resolved grant is provided as {@link McpInvocation} for the
 * duration of that request only.
 *
 * Streamable HTTP is what OpenCode's remote MCP client speaks. The revision served is
 * **`McpProtocol.v2026_07_28`, and only that one** — the single stateless adapter in
 * `effect/ai` (`effect/src/ai/McpProtocol.ts:211`; every other revision is
 * `StatefulRuntimeDescriptor`). It carries request-scoped metadata instead of an
 * `initialize` handshake and a protocol-level session, so there is no session table to
 * keep, expire or reconcile, and a request either carries everything it needs or is
 * refused.
 *
 * **The client has to be pinned to match.** OpenCode's remote MCP config has a
 * `protocol` field with three accepted values, and its default is the handshake-based
 * one, which opens with `initialize` and speaks revisions only up to 2025-11-25
 * (`@opencode/schema`'s `Mcp.Protocol`). A default-configured client against this
 * endpoint fails, by design: `openCodeClient.ts` sends `protocol: "2026-07-28"` on the
 * remote server config, and the two have to move together. Nothing is served for
 * earlier revisions — there is no fallback path to drift.
 *
 * **This module no longer serves.** It builds {@link mcpApplicationLayer} — tools,
 * handlers, protocol and the auth middleware — as routes on an ambient `HttpRouter`.
 * One listener carries those routes together with the policy route
 * (`http/controlPlane.ts`), so there is a single port and a single shutdown path. The
 * auth middleware is attached to the protocol layer rather than to the router, which is
 * what lets the two routes keep different postures on one port.
 *
 * ## Four endpoints, one per role, and why it is not one endpoint with a filter
 *
 * A worker attempt is offered `record_observation`, `record_asset` and `list_assets`; a
 * planner round is offered `add_intent`, `record_round_disposition`, the graph reads and
 * `list_harnesses`; a goal agent is offered `steer_planner`, `wake_planner`, `end_goal` and
 * reads, and **no `add_intent`**; the scope importer is offered `add_scope_entry`,
 * `record_imported_asset` and `read_scope`, and **nothing else is**. No role sees
 * another's. That is the slice-7 ruling extended to the fourth role, and the shape it takes
 * here is **one `McpServer` per path** — {@link MCP_PATH}, {@link PLANNER_MCP_PATH},
 * {@link GOAL_MCP_PATH}, {@link IMPORTER_MCP_PATH} — each with its own `Toolkit` and its own
 * auth middleware.
 *
 * The importer's exclusivity is the strongest claim of the four, because `add_scope_entry`
 * writes the list the agent is judged against. D13 permits it to the importer precisely
 * because the importer is a different role on a different endpoint that cannot test
 * anything — so a worker or planner that could reach it would not be a leak of a
 * convenience, it would be the defect the whole design is built to avoid.
 *
 * It is not a per-request filter over one toolkit because `effect/ai` does not offer one
 * that can see the caller. `McpServer.addTool` takes an `EnabledWhen` annotation whose
 * predicate is handed a *client profile* — protocol version, client capabilities, client
 * info — and nothing else (`effect/src/ai/McpServer.ts`, `isVisible`). It is a synchronous
 * predicate, so it cannot yield {@link McpInvocation}, and the credential is the only thing
 * that distinguishes a round from a worker. The alternative — a module-level "current
 * caller" the middleware sets — would be a mutable global read by concurrent requests,
 * which is not a thing to build an authority boundary on.
 *
 * **The boundary is still per grant, not per path**, which is what `plan/planSupervisor.ts`
 * said slice 7 would have to inherit. Each endpoint's middleware resolves the bearer *and*
 * checks the grant's tag against the role it serves: a round credential presented to the
 * worker endpoint is `401`, and an attempt credential presented to the planner endpoint is
 * `401`. So the path selects which toolkit is advertised and the grant decides whether the
 * request is served at all; knowing the planner URL buys nothing without a round
 * credential, and holding one buys nothing at the worker URL.
 *
 * That gives three independent layers over the same property, which is deliberate, because
 * DECISIONS.md §24.2 question 1 measured that the weakest of them is weaker than it looks:
 *
 * 1. **The directory.** Under OpenCode an MCP registration belongs to a *directory*, so a
 *    worker in `targets/<id>/workspace/` sees only the `bit-<attemptId>` servers registered
 *    there, all of which point at the worker URL. A round's registration lives in
 *    `targets/<id>/planning/<roundId>/`, which is a sibling. §24.2 also showed what this
 *    does **not** do: two workers share one workspace and can use each other's
 *    credentials, so this layer separates roles and never worker from worker.
 * 2. **The path.** A worker that somehow learned the planner URL would have to be
 *    registered against it to reach it, and nothing registers a worker there.
 * 3. **The grant.** Even registered, its credential is an attempt's and the planner
 *    endpoint refuses it before protocol dispatch.
 *
 * And behind all three, the store's own authority paths refuse the write regardless of how
 * the call arrived — which is the layer slice 4 built and the one this does not replace.
 */
import { apiPath } from "@bit/contracts";
import { Context, Effect, Layer, type Types } from "effect";
import { McpProtocol, McpServer } from "effect/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { McpCredentials, callerOf } from "./credentials";
import {
  GoalBriefingCeiling,
  GoalPlanning,
  GoalToolkit,
  GoalToolkitLayer,
} from "./goalTools";
import { McpInvocation } from "./invocation";
import {
  PlannerHarnesses,
  PlannerToolkit,
  PlannerToolkitLayer,
} from "./plannerTools";
import { ImporterToolkit, ImporterToolkitLayer } from "./importerTools";
import { WorkerToolkit, WorkerToolkitLayer } from "./tools";
import { ScopeImportProgress } from "../import/progress";
import type { CallerContext } from "../persistence/store";

export const SERVER_NAME = "bit-control-plane";
export const SERVER_VERSION = "0.1.0";
/**
 * Where a **worker attempt**'s MCP client connects. `record_observation` lives here.
 *
 * Still `MCP_PATH` rather than something role-named, because this is the path every
 * registration already written into a harness points at and renaming it would be a
 * compatibility break for no gain. What changed is that it now serves one role's toolkit
 * and refuses every other kind of credential.
 */
export const MCP_PATH = apiPath("mcp");
/**
 * Where a **planner round**'s MCP client connects.
 *
 * A sibling path rather than a sub-path of {@link MCP_PATH}: `effect/http`'s router
 * matches literal paths, and two routes where one is a prefix of the other is the kind of
 * thing that works until somebody adds a wildcard. `planner/mcp` reads as "the planner's
 * endpoint" rather than "a variant of the MCP endpoint", which is what it is.
 */
export const PLANNER_MCP_PATH = apiPath("planner/mcp");
/**
 * Where a **goal agent**'s MCP client connects. `steer_planner` and `end_goal` live here.
 *
 * A third sibling path, for {@link PLANNER_MCP_PATH}'s reason. The three are peers rather
 * than a hierarchy because the roles are peers: no credential is a weaker form of another,
 * and a path that read as a sub-resource of the planner's would suggest the goal agent is a
 * kind of planner. It is the opposite — it is the thing that cannot write intents.
 */
export const GOAL_MCP_PATH = apiPath("goal/mcp");
/**
 * Where the **scope importer**'s MCP client connects. Its three tools live here (D13).
 *
 * A fourth sibling, for {@link PLANNER_MCP_PATH}'s reason, and the one whose exclusivity
 * is the most load-bearing of the four. `add_scope_entry` writes to the list the operator
 * is judged against; `DECISIONS.md` §5 names an agent widening its own scope as the defect
 * this whole model exists to avoid. The importer is allowed it because it is a different
 * role on a different endpoint, cannot test anything, and finishes before any goal exists
 * — and that argument holds only while a worker or planner genuinely cannot reach here.
 *
 * `importer/mcp` rather than `import/mcp`: the path names the role, as the other three do,
 * and `import` names the act.
 */
export const IMPORTER_MCP_PATH = apiPath("importer/mcp");

/**
 * Authenticated MCP requests served, in total and per caller scope.
 *
 * The total is what it always was: enough to assert a worker really reached us.
 *
 * **The per-scope tally is new, and it is there to make one invisible failure visible.**
 * DECISIONS.md §24.2 caveat 1 measured that an OpenCode registration can be connected and
 * *not yet callable*: the tool registry reloads behind a lock and a debounce, and in 3 of
 * 8 first prompts after a registration the model reported the tool was not exposed and
 * the endpoint saw no call. There is no API to read that registry, so a readiness check is
 * not available — what is available is the other side of the wire. If a round settles with
 * no disposition and this tally says its scope made **zero** requests, the round never had
 * its tools; if the tally is non-zero, the round had them and chose to say nothing. Those
 * are different facts about a planner and without this they are the same empty round.
 *
 * **Who reads it, and how far it goes.** `plan/planSupervisor.ts`'s `settle` calls
 * {@link countFor} on every settlement path and puts the figure on the
 * `a planner round settled` log line; when it is zero *and* the round recorded no
 * disposition it also logs a warning naming this caveat. `PlanRoundStopped` carries the
 * same figure for a stop. **It goes no further than that: it is not on the round row and
 * not on `plan.round.settled`.** The tally is in-process memory, so a restart forgets it
 * and a durable field would be null for every round a startup sweep settles — which is
 * why the distinction is available to an operator reading logs at the moment it matters
 * and is not recoverable from the rows afterwards. An earlier version of this comment
 * described the diagnostic without anything reading the counter at all; a review found
 * that, and this paragraph is the correction.
 *
 * Keyed by caller scope rather than by round id because the scope is what the middleware
 * has in hand (`callerOf(grant).callerScope`) and it names exactly one caller of exactly
 * one kind — `<targetId>/round/<roundId>` for a round. Counted after the bearer resolves,
 * so an unauthenticated probe cannot move anybody's number.
 *
 * In memory and unbounded for the life of the process, like the credential registry
 * itself: one entry per caller that has ever called, which is bounded by the work this
 * process has actually done.
 */
export class McpCallCounter extends Context.Service<
  McpCallCounter,
  {
    readonly increment: (callerScope: string) => Effect.Effect<void>;
    readonly count: Effect.Effect<number>;
    /** How many authenticated requests one caller scope has made. Zero if none. */
    readonly countFor: (callerScope: string) => Effect.Effect<number>;
  }
>()("bit/mcp/McpCallCounter") {
  static readonly layer = Layer.sync(McpCallCounter, () => {
    let calls = 0;
    const byScope = new Map<string, number>();
    return McpCallCounter.of({
      increment: (callerScope) =>
        Effect.sync(() => {
          calls += 1;
          byScope.set(callerScope, (byScope.get(callerScope) ?? 0) + 1);
        }),
      count: Effect.sync(() => calls),
      countFor: (callerScope) =>
        Effect.sync(() => byScope.get(callerScope) ?? 0),
    });
  });
}

const bearerOf = (header: string | undefined): string =>
  header !== undefined && header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";

/** How a refused request is described in a log line, per kind of caller. */
const ROLE_NAMES: Readonly<Record<CallerContext["_tag"], string>> = {
  attempt: "a worker attempt",
  round: "a planner round",
  goal: "a goal agent",
  importer: "the scope importer",
};

/**
 * Resolves the presented credential into the caller it authenticates, or refuses the
 * request outright.
 *
 * Note what this does *not* do: there is no fallback identity, and no path where a
 * missing credential produces an empty tool list instead of a refusal. An agent that
 * silently loses the toolkit is far harder to diagnose than one that gets a 401.
 *
 * **A grant of any of the three kinds resolves here, and {@link callerOf} is what turns
 * it into the right caller** — a worker attempt, a planner round or a goal agent, tagged,
 * with the credential's own bookkeeping (`issuedAt`, `expiresAt`) dropped. Nothing
 * downstream decides what kind of caller it has by looking at which fields are present:
 * it reads the tag.
 *
 * ## `serves` is the second half of the boundary
 *
 * Each endpoint is built with the one caller kind it serves, and a resolved grant of any
 * other kind is refused `401` **before protocol dispatch** — so a worker credential
 * presented to the planner endpoint does not get a tool list, an `initialize`, or the
 * knowledge that the path exists. This is what keeps the tool surface a function of the
 * *grant* and not merely of the URL: the path chooses which toolkit is advertised, and
 * this check is why reaching the right path with the wrong credential gets nothing.
 *
 * The refusal is deliberately the **same `401` with the same body** as an unknown token.
 * A distinct status or sentence for "valid credential, wrong endpoint" would tell a caller
 * that the credential it holds is real, which is a fact a caller at the wrong door has no
 * business learning. The distinction is in the log, where the operator is.
 *
 * It is *not* a substitute for the store's authority paths, which still refuse a caller of
 * the wrong kind for the write attempted. Those cover the writes; this covers the door.
 */
const authMiddlewareFor = (serves: CallerContext["_tag"]) =>
  HttpRouter.middleware<{ provides: McpInvocation }>()(
    Effect.gen(function* () {
      const credentials = yield* McpCredentials;
      const counter = yield* McpCallCounter;
      return Effect.fnUntraced(function* (
        httpEffect: Effect.Effect<
          HttpServerResponse.HttpServerResponse,
          Types.unhandled,
          McpInvocation
        >,
      ) {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const token = bearerOf(request.headers["authorization"]);
        const grant =
          token === "" ? undefined : yield* credentials.resolve(token);
        if (grant === undefined) {
          yield* Effect.logWarning("refused an MCP request", {
            serves,
            reason:
              token === "" ? "missing_bearer_token" : "unknown_or_expired",
          });
          return HttpServerResponse.text("unauthorized", { status: 401 });
        }
        if (grant._tag !== serves) {
          yield* Effect.logWarning(
            "refused an MCP request: the credential is not this endpoint's role",
            {
              serves,
              presented: grant._tag,
              callerScope: grant.callerScope,
              detail: `this endpoint serves ${ROLE_NAMES[serves]} and the credential is ${ROLE_NAMES[grant._tag]}`,
            },
          );
          return HttpServerResponse.text("unauthorized", { status: 401 });
        }
        const caller = callerOf(grant);
        yield* counter.increment(caller.callerScope);
        return yield* Effect.provideService(httpEffect, McpInvocation, caller);
      });
    }),
  ).layer;

/**
 * `McpInvocation` is a per-request service, so it cannot be in a registration layer's
 * requirements — the auth middleware provides it on each request instead. Same
 * assertion, and the same reason, as T3Code's `toolkitRegistration`
 * (`apps/server/src/mcp/McpHttpServer.ts:777-782`), now made four times because there are
 * four toolkits.
 */
const workerRegistration = McpServer.toolkit(WorkerToolkit);
const workerRegistered = workerRegistration as Layer.Layer<
  never,
  never,
  Exclude<Layer.Services<typeof workerRegistration>, McpInvocation>
>;

const plannerRegistration = McpServer.toolkit(PlannerToolkit);
const plannerRegistered = plannerRegistration as Layer.Layer<
  never,
  never,
  Exclude<Layer.Services<typeof plannerRegistration>, McpInvocation>
>;

const goalRegistration = McpServer.toolkit(GoalToolkit);
const goalRegistered = goalRegistration as Layer.Layer<
  never,
  never,
  Exclude<Layer.Services<typeof goalRegistration>, McpInvocation>
>;

const importerRegistration = McpServer.toolkit(ImporterToolkit);
const importerRegistered = importerRegistration as Layer.Layer<
  never,
  never,
  Exclude<Layer.Services<typeof importerRegistration>, McpInvocation>
>;

/**
 * One role's endpoint: its toolkit, on its path, behind its own auth.
 *
 * ## `Layer.fresh` around the whole pair is load-bearing, and two wrong versions of it
 * both failed in ways worth recording
 *
 * `McpServer.layerHttp` ends in `Layer.provideMerge(McpServer.layer)` and
 * `McpServer.toolkit` ends in `Layer.provide(McpServer.layer)` — the **same shared layer
 * value** in both. Layer memoisation is by reference within one build, so:
 *
 * - **With no `fresh` at all**, both roles' registrations and both transports resolved to
 *   one `McpServer`: one registry, one tool list, seven tools on both paths. The role split
 *   existed only in the auth middleware, which is exactly the half-measure this slice is
 *   supposed to remove. The test asserting a worker is offered `record_observation` and
 *   nothing else is what found it.
 * - **With `fresh` on the transport alone**, the transport got a *new* `McpServer` and each
 *   registration kept the shared one, so both paths served an **empty** tool list. The same
 *   test found that too, one line later.
 *
 * So it wraps the pair. `Layer.fresh` rebuilds its argument against a brand-new memo map
 * (`effect/src/Layer.ts`: `self.build(makeMemoMapUnsafe(), scope)`), and the pair is
 * exactly the graph that must be per-role: the registration, the transport, the protocol
 * runtime and the auth middleware. Everything this endpoint *requires* — the ambient
 * `HttpRouter`, `McpCredentials`, `McpCallCounter`, the toolkit's own services — is
 * provided from **outside** the fresh boundary and arrives as context rather than being
 * rebuilt, which is what keeps both endpoints on one router and one credential registry.
 *
 * The cost is one server fiber and one notification queue per role, which is what two
 * independent MCP servers on one listener costs.
 *
 * `Layer.provide` rather than `provideMerge`, so this layer's output is `never`: merging
 * `McpServer` out of both would be ambiguous and, worse, would invite a caller to add a
 * tool to "the" registry when there are two.
 */
const roleEndpoint = <RIn>(options: {
  readonly path: HttpRouter.PathInput;
  readonly serves: CallerContext["_tag"];
  readonly registration: Layer.Layer<never, never, RIn>;
}) =>
  options.registration
    .pipe(
      Layer.provide(
        McpServer.layerHttp({
          name: SERVER_NAME,
          version: SERVER_VERSION,
          path: options.path,
          protocols: [McpProtocol.v2026_07_28],
        }).pipe(Layer.provide(authMiddlewareFor(options.serves))),
      ),
    )
    .pipe(Layer.fresh);

/**
 * The whole MCP application: four endpoints, their tools, handlers, protocol and auth.
 *
 * A function rather than a constant because the planner's `list_harnesses` needs the
 * harness catalogue, and that has to be **passed in as a value**. The reason is on
 * `main.ts`'s `endpoint`: this layer is built inside `HttpRouter.toWebHandler`'s own memo
 * map, so anything *provided to* it is built a second time — for `HarnessResolver` that
 * would mean a second set of built harnesses, which for OpenCode means a second child
 * process. {@link PlannerHarnesses} is the small, credential-free reduction that crosses
 * the boundary instead, and {@link PlannerHarnesses.none} is the honest default for a
 * server that configures no harness.
 */
export const mcpApplicationLayer = (options?: {
  readonly harnesses?: Layer.Layer<PlannerHarnesses> | undefined;
  /**
   * The two planning operations the goal agent's tools reach, as an already-built value.
   *
   * Passed in rather than required for {@link PlannerHarnesses}' reason, and the cost of
   * getting it wrong is higher: this layer is built inside `HttpRouter.toWebHandler`'s own
   * memo map, so a `PlanSupervisor` *required* here would be built a second time — a second
   * fiber map, a second set of goal claims, and two processes' worth of supervision inside
   * one process. {@link GoalPlanning.unavailable} is the honest default for a server with
   * no harness.
   */
  readonly planning?: Layer.Layer<GoalPlanning> | undefined;
  /**
   * The ceiling `get_goal_briefing` bounds its read by, from `GOAL_BRIEFING_MAX_CHARS`.
   *
   * A third value across this boundary, and the reason it is here rather than read inside
   * the toolkit is the reason the other two are: `main.ts` is the one place this process's
   * configuration is read. Omitted, the toolkit uses
   * {@link GoalBriefingCeiling.default} — which is what every other call site falls back to
   * for an operator who has configured nothing, and is therefore a true answer rather than
   * a convenient one.
   */
  readonly briefingCeiling?: Layer.Layer<GoalBriefingCeiling> | undefined;
  /**
   * The registry the importer's tool calls are recorded into, as an already-built value.
   *
   * A fourth value across this boundary, for {@link planning}'s reason and with a failure
   * that is quiet in the same way: the "Loading the scope" panel reads this registry
   * through the browser API, and the importer's toolkit writes to it. If it were
   * *required* here it would be built a second time inside `HttpRouter.toWebHandler`'s own
   * memo map, and the two halves would be looking at different maps — so every call would
   * land, every entry would be written, and the panel would show an import that had made
   * no calls at all. Nothing would fail; the receipt would just be blank.
   *
   * Omitted, {@link ScopeImportProgress.none} answers every read `undefined`, which the
   * browser route reports as `ScopeImportNotFound`. That is the honest default for a
   * server with no harness, because such a server starts no imports.
   */
  readonly scopeImports?: Layer.Layer<ScopeImportProgress> | undefined;
}) =>
  Layer.mergeAll(
    roleEndpoint({
      path: MCP_PATH,
      serves: "attempt",
      registration: workerRegistered.pipe(Layer.provide(WorkerToolkitLayer)),
    }),
    roleEndpoint({
      path: PLANNER_MCP_PATH,
      serves: "round",
      registration: plannerRegistered.pipe(
        Layer.provide(PlannerToolkitLayer),
        Layer.provide(options?.harnesses ?? PlannerHarnesses.none),
      ),
    }),
    /**
     * The goal agent's endpoint.
     *
     * The third `Layer.fresh` pair, and the trap this module's header records applies to it
     * exactly as to the other two: without `fresh` around the registration-and-transport
     * pair all three paths would serve one merged toolkit, and with `fresh` on the
     * transport alone all three would serve an empty one.
     *
     * **What catches either is `plannerTools.test.ts` and `goalTools.test.ts`**, each of
     * which reads `tools/list` off its own endpoint and asserts the whole list. Not
     * `server.test.ts`: that file drives {@link MCP_PATH} only and never names the other
     * two paths, so it would pass with all three toolkits merged. An earlier version of
     * this comment named it, which is the kind of claim that makes a protection look
     * tested when the test is somewhere else.
     */
    roleEndpoint({
      path: GOAL_MCP_PATH,
      serves: "goal",
      registration: goalRegistered.pipe(
        Layer.provide(GoalToolkitLayer),
        Layer.provide(options?.planning ?? GoalPlanning.unavailable),
        Layer.provide(options?.briefingCeiling ?? GoalBriefingCeiling.default),
      ),
    }),
    /**
     * The scope importer's endpoint: `add_scope_entry`, `record_imported_asset`,
     * `read_scope`, and nothing else anywhere else (D13).
     *
     * The fourth `Layer.fresh` pair. This module's header records what happens without it
     * — one merged toolkit on every path — and that failure mode is worse here than for
     * the other three, because the tool it would leak is the one that writes to the
     * authorization boundary. A worker offered `add_scope_entry` is the exact defect
     * `DECISIONS.md` §5 identifies in ScopeWeaver's `AddAutoScope`, and it would arrive
     * not as a decision but as a layer that was not wrapped.
     *
     * `importerTools.test.ts` reads `tools/list` off this path and off the other three, and
     * drives this credential at theirs, which is what catches it.
     */
    roleEndpoint({
      path: IMPORTER_MCP_PATH,
      serves: "importer",
      registration: importerRegistered.pipe(
        Layer.provide(ImporterToolkitLayer),
        Layer.provide(options?.scopeImports ?? ScopeImportProgress.none),
      ),
    }),
  );
