/**
 * The pre-execution policy service.
 *
 * The control plane owns the decision; the harness-side hook only asks and enforces.
 * Keeping the rule here, rather than in the plugin, is what makes "missing policy
 * connectivity fails closed" a real property: the hook has nothing to fall back on.
 *
 * The posture is **permissive with explicit boundaries** (DECISIONS.md §5). A worker
 * runs autonomously; `allow` is the default answer and there is no human-approval
 * path. Only a named, coded boundary produces a denial.
 */
import { apiPath } from "@bit/contracts";
import {
  Channel,
  Clock,
  Context,
  Effect,
  Layer,
  PubSub,
  Schema,
  Stream,
} from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

/**
 * What the harness-side hook sends.
 *
 * This is untrusted input from another process, so it is **decoded**, not cast. A body
 * that does not match is denied with a reason rather than silently reaching `decide`
 * with `undefined` fields — a policy gate that accepts malformed requests is not a gate.
 */
export const PolicyRequest = Schema.Struct({
  sessionId: Schema.String,
  tool: Schema.String,
  input: Schema.Unknown,
});
export type PolicyRequest = typeof PolicyRequest.Type;

const decodeRequest = Schema.decodeUnknownResult(PolicyRequest);

/**
 * Narrows one recorded entry back to just its decision.
 *
 * `record` is handed `PolicyRequest & PolicyDecision` — one flat object, which is the shape
 * the audit list has always held — and the feed carries the two apart so a reader renders
 * the gate's reason without picking it out of a merged record. Splitting them means
 * reconstructing the union, and this does it by **discriminating on `effect`** rather than
 * by stripping the request's keys and casting the remainder.
 *
 * The difference matters and the earlier version got it wrong in a way its own comment
 * denied: `const { sessionId, tool, input, ...rest } = entry` followed by `rest as
 * PolicyDecision` compiles whatever {@link PolicyDecision} gains, so a new member would have
 * been silently mis-shaped rather than caught. Returning a literal per arm is what actually
 * makes a new field a compile error here.
 */
const decisionOf = (entry: PolicyRequest & PolicyDecision): PolicyDecision =>
  entry.effect === "allow"
    ? { effect: "allow", basis: entry.basis }
    : { effect: "deny", reason: entry.reason };

/**
 * Why a call was allowed.
 *
 * Carried on the decision, in the response body, and into the hook's audit line, because
 * "allowed" on its own is three different facts wearing one word — and a screen that
 * showed them identically would be hiding the one an operator most needs to see.
 *
 * - `unrestricted` — this engagement's scope places **no** host restriction, so the host
 *   rule did not run. Permitted by configuration, not by matching anything.
 * - `hosts_allowed` — the input named one or more hosts and every one of them is in the
 *   scope's list. Permitted by matching.
 * - `no_host_named` — the input named no host at all, so the host rule had nothing to
 *   decide. Kept apart from `hosts_allowed` because "it was in scope" is a claim, and a
 *   tool call with no URL in it has not made that claim either way.
 */
export const AllowBasis = Schema.Literals([
  "unrestricted",
  "hosts_allowed",
  "no_host_named",
]);
export type AllowBasis = typeof AllowBasis.Type;

export type PolicyDecision =
  | { readonly effect: "allow"; readonly basis: AllowBasis }
  | { readonly effect: "deny"; readonly reason: string };

/**
 * Which hosts a worker may reach.
 *
 * A tagged union rather than a list, because "every host" has no honest representation as
 * a list. `allowedHosts: []` is **deny everything** — {@link decide} refuses any host not
 * in the list — so an empty list is the opposite of unrestricted, and a sentinel string
 * like `"*"` would sit in a host list waiting to be read as a hostname. Making it a tag
 * means a reader of the config, of a decision, or of an audit line can tell the two apart
 * without knowing a convention.
 */
export type HostScope =
  | {
      readonly _tag: "hosts";
      /** The hosts a worker may reach. Anything else named in a tool input is refused. */
      readonly allowed: readonly string[];
    }
  | {
      readonly _tag: "unrestricted";
      /**
       * Why this engagement has no host boundary. Recorded, not enforced.
       *
       * Required rather than optional: an unrestricted scope is a decision somebody made,
       * and a config that said so without saying why would be indistinguishable from one
       * where a list went missing.
       */
      readonly because: string;
    };

export interface PolicyConfig {
  /**
   * Path fragments that are out of scope. A tool call whose serialised input mentions
   * one is refused before the tool runs.
   *
   * **Independent of {@link hostScope}.** An unrestricted host scope does not switch this
   * off: they are two boundaries and only one of them is about hosts. A scope that wants
   * neither declares both.
   */
  readonly forbiddenPathFragments: readonly string[];
  /** Which hosts the worker may reach, as a boundary or as its documented absence. */
  readonly hostScope: HostScope;
}

/**
 * The boundaries a run enforces when the caller names none.
 *
 * Loopback only, and no out-of-scope paths declared. That is the honest default for
 * this foundation: the fixture is the only target, and inventing forbidden fragments
 * here would make a run look more constrained than it is. A demo that wants real
 * boundaries states them (`spike/policyDemo.ts`).
 *
 * **Unchanged by the permissive scope below.** The spike and its tests depend on a
 * localhost-only scope and that is still the right default for them; what a
 * browser-started run gets is a different config, chosen explicitly by `main.ts`.
 */
export const DEFAULT_POLICY: PolicyConfig = {
  forbiddenPathFragments: [],
  hostScope: { _tag: "hosts", allowed: ["127.0.0.1", "localhost"] },
};

/**
 * The scope a browser-started run is gated by today: recorded, and permitting.
 *
 * **The gate is installed and consulted; it just does not deny.** That is a deliberate
 * product decision rather than an unhooked path, and the difference matters: every tool
 * call still round-trips to the control plane before it runs, every decision is recorded,
 * and a control plane that cannot be reached still fails the call closed. What is absent
 * is a *rule*, not the mechanism.
 *
 * Why no rule yet. **A structured scope now exists and this deliberately does not read
 * it.** Migration `0022` gives a target `scope_entries` and two label tables, and
 * `contracts/scope.ts` can decide any host against them — so the old reason recorded
 * here, that there was nothing to derive an allowlist from, stopped being true. The
 * reason is now a choice: the target-scope design's Non-goals say in as many words that
 * the operator asked for a starting point that **tells the agent what it may test**, and
 * explicitly not a gate that stops it testing anything else. Scope is a label, not a
 * boundary, and deriving `hostScope` from it would turn every mislabelled discovery into
 * a blocked tool call.
 *
 * What changes when that decision is revisited: this constant gains a `hosts` scope
 * derived from the in-scope entries and the in labels, and the one thing to settle first
 * is what happens to a host the operator has not got round to promoting — which under an
 * allowlist is a denial rather than a row on a screen. Installing the hook now rather
 * than later is what makes that a **config change instead of a wiring change** — the
 * plumbing, the audit trail and the fail-closed behaviour are already in place and under
 * test.
 *
 * `forbiddenPathFragments` is empty for the same reason, and the reasoning recorded on
 * `WORKER_POLICY` applies: a constraint invented here would make a denial look like a
 * boundary when it was really a misconfiguration.
 */
export const PERMISSIVE_POLICY: PolicyConfig = {
  forbiddenPathFragments: [],
  hostScope: {
    _tag: "unrestricted",
    because:
      "this installation's engagement scope is a label rather than a boundary, and a host allowlist is deliberately not derived from it; the gate records every decision and denies on policy outage, but places no host boundary",
  },
};

/**
 * Decides one call.
 *
 * **What this actually inspects: the tool's input, as text.** That is a real
 * pre-execution gate on the arguments a model supplies, and nothing more. It does not
 * observe what a process does once started, so a command that derives a forbidden path
 * or host at runtime — through a variable, a subshell, an encoded string or a second
 * hop — is not covered. The policy demo exercises that gap deliberately rather than
 * leaving the limit implied (DECISIONS.md §13 step 1, "identify and record exactly
 * which execution/traffic paths the boundary covers").
 */
export const decide = (
  config: PolicyConfig,
  request: PolicyRequest,
): PolicyDecision => {
  const serialised = JSON.stringify(request.input ?? "").toLowerCase();

  for (const fragment of config.forbiddenPathFragments) {
    if (serialised.includes(fragment.toLowerCase())) {
      return {
        effect: "deny",
        reason: `out-of-scope path '${fragment}' named in ${request.tool} input`,
      };
    }
  }

  // An unrestricted scope skips the host rule entirely and says so in the basis, rather
  // than running a check it would always pass. The path rule above still applied.
  if (config.hostScope._tag === "unrestricted") {
    return { effect: "allow", basis: "unrestricted" };
  }

  const authorities = hostsIn(serialised);
  for (const authority of authorities) {
    // Compare the host alone. The fixture binds to an arbitrary free port, so a port
    // is not part of host identity here; a scope that needs per-port rules would add
    // them explicitly rather than inherit this behaviour by accident.
    const host = hostOf(authority);
    if (!config.hostScope.allowed.includes(host)) {
      return {
        effect: "deny",
        reason: `host '${host}' is not in the engagement scope`,
      };
    }
  }

  return {
    effect: "allow",
    basis: authorities.length === 0 ? "no_host_named" : "hosts_allowed",
  };
};

/** Authorities appearing in `http(s)://host[:port]` form inside the input text. */
const hostsIn = (text: string): readonly string[] => {
  const matches = text.matchAll(
    /https?:\/\/(\[[0-9a-f:]+\](?::\d+)?|[a-z0-9.-]+(?::\d+)?)/g,
  );
  return [...new Set([...matches].map((match) => match[1] ?? ""))].filter(
    (authority) => authority.length > 0,
  );
};

/** Strips a trailing `:port`, leaving bracketed IPv6 literals intact. */
const hostOf = (authority: string): string => {
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    return close === -1 ? authority : authority.slice(1, close);
  }
  const colon = authority.lastIndexOf(":");
  return colon === -1 ? authority : authority.slice(0, colon);
};

/**
 * The one path the policy endpoint answers on, under the shared API prefix.
 *
 * Named once because the handler matches it and the published URL is built from it; two
 * spellings of the same route is how a caller ends up talking to a 404.
 */
export const POLICY_DECIDE_PATH = apiPath("policy/decide");

/**
 * How many decisions are held for a subscriber that is behind.
 *
 * The same shape of bound, and for the same reason, as `run/narration.ts`'s
 * `NARRATION_BUFFER`: enough that a browser repainting keeps up through a burst of tool
 * calls, small enough to be bounded memory per subscriber. A power of two because
 * `PubSub`'s atomic backing is a ring buffer.
 */
export const DECISION_BUFFER = 256;

/**
 * One answered decision, with the identity this service gives it.
 *
 * `id` is this process's answer order, and it exists for the reason `RunNarration.id`
 * does: a live consumer has to be able to say "I have already shown this", and nothing in
 * a decision's own fields can answer it — the same tool called twice with the same
 * arguments in the same millisecond is two decisions that are equal in every field.
 *
 * **It is an in-process counter and it is not a cursor.** A restart begins at zero and a
 * decision answered while nobody was listening is gone. {@link PolicyDecisions} is an
 * in-memory record, not the durable audit trail — the audit *file* the hook writes beside
 * the engagement is that (`policy/install.ts`) — and reading it back as a persisted log is
 * a later day's work.
 *
 * `sessionId` is the harness session the hook was called about, which is what lets a
 * reader attribute a decision to an attempt: the supervisor knows which session belongs to
 * which attempt. It is **not** trusted as authority for anything; it is a join key.
 */
export interface AnsweredDecision {
  /**
   * This process's answer order, counting from 1. See above for what it is not.
   *
   * It counts decisions this service *recorded*, which is the same set {@link
   * PolicyDecisions.all} holds — so `id` is the position in that list and the two cannot
   * drift. A request the route refused as undecodable is never recorded and so never
   * consumes a number: the ids on this feed are contiguous, and a gap in them would mean a
   * dropped publish rather than a refused request.
   */
  readonly id: number;
  /** When this process answered, in epoch milliseconds. */
  readonly at: number;
  readonly request: PolicyRequest;
  readonly decision: PolicyDecision;
}

/**
 * The decisions this process has answered, in order.
 *
 * A service rather than a closure because the route handler and the demo that reads the
 * audit now live on opposite sides of the shared listener. It is an in-memory record for
 * the spike's own assertions, not the durable audit trail.
 *
 * **It now also publishes**, so a live transcript can show a refused action as it is
 * refused rather than after the run. The publish is a `PubSub.sliding`, which never blocks
 * and drops the oldest buffered entry for a subscriber that is behind — because this
 * service is on the gate's own response path and a browser tab must not be able to slow
 * down the answer a worker is waiting for. A dropped decision is an accepted loss on this
 * channel and `all` still holds every one of them.
 */
export class PolicyDecisions extends Context.Service<
  PolicyDecisions,
  {
    readonly record: (
      entry: PolicyRequest & PolicyDecision,
    ) => Effect.Effect<void>;
    readonly all: Effect.Effect<readonly (PolicyRequest & PolicyDecision)[]>;
    /**
     * Decisions answered from now on. No replay: see {@link AnsweredDecision} on why
     * there is nothing to replay from.
     */
    readonly answered: Stream.Stream<AnsweredDecision>;
    /**
     * How many subscriptions are open.
     *
     * Diagnostics, exactly as `run/narration.ts`'s counterpart is, and here for the same
     * reason: {@link answered} replays nothing, so the only way a test can state the claim
     * this makes — that a decision reaches a live reader — is to wait until a reader is
     * actually attached before answering one. Without it the test would be a sleep.
     */
    readonly subscriberCount: Effect.Effect<number>;
    /**
     * Records that `holder` holds harness session `sessionId`'s authority (A6 F5 review).
     *
     * ## Ended sessions, and why they are refused here
     *
     * The gate is the one boundary every tool call of every harness crosses before it runs,
     * so it is where "this session's authority is over" can be enforced whatever the harness
     * does next. Ending a session asks the harness to stop it, and the harness may take a
     * moment — a Claude Code CLI given `SIGTERM`, an OpenCode execution being interrupted —
     * or may not answer at all. A tool call from that session in the meantime is refused
     * here, by {@link sessionEnded}, rather than allowed because the scope happened to say
     * nothing about it.
     *
     * Kept on this service because the route and the conversation spine both have to reach
     * the **same** registry, and this is the service already handed across the listener's
     * memo-map boundary as an instance (`http/controlPlane.ts`).
     *
     * **Held by a holder, ended per holder.** A resume continues a session under the same
     * id in a fresh opening, which may start before an older opening's close has finished,
     * so "this id is ended" would refuse the newer opening's calls. A session is refused
     * once it has been ended and no holder holds it. The holder is any object the caller
     * keeps for the opening — the spine uses the session's `Scope` — compared by identity.
     *
     * Only the conversation spine holds and ends sessions. A worker's or a round's session is
     * never ended here, so its calls are decided exactly as before.
     */
    readonly holdSession: (
      sessionId: string,
      holder: object,
    ) => Effect.Effect<void>;
    /**
     * Records that `holder` has let go of `sessionId`, which is refused from now on unless
     * another holder still holds it. Idempotent.
     */
    readonly endSession: (
      sessionId: string,
      holder: object,
    ) => Effect.Effect<void>;
    /** Whether `sessionId` has been ended and nothing holds it: its tool calls are refused. */
    readonly sessionEnded: (sessionId: string) => Effect.Effect<boolean>;
  }
>()("bit/policy/PolicyDecisions") {
  static readonly layer = Layer.effect(
    PolicyDecisions,
    Effect.gen(function* () {
      const entries: (PolicyRequest & PolicyDecision)[] = [];
      const pubsub = yield* PubSub.sliding<AnsweredDecision>(DECISION_BUFFER);
      let answeredCount = 0;
      let subscribers = 0;
      // One entry per conversation session ended in this process, which is bounded by what
      // an operator has opened — the same bound the spine's per-id permits carry.
      const holders = new Map<string, Set<object>>();
      const ended = new Set<string>();
      return PolicyDecisions.of({
        record: (entry) =>
          Effect.flatMap(Clock.currentTimeMillis, (at) => {
            entries.push(entry);
            answeredCount += 1;
            return Effect.asVoid(
              PubSub.publish(pubsub, {
                id: answeredCount,
                at,
                request: {
                  sessionId: entry.sessionId,
                  tool: entry.tool,
                  input: entry.input,
                },
                decision: decisionOf(entry),
              }),
            );
          }),
        all: Effect.sync(() => [...entries]),
        /**
         * Subscribes, counts, then streams — in that order.
         *
         * `PubSub.subscribe` is the real subscription, so it is taken first and the counter
         * moves only once it has returned. That ordering is what makes
         * {@link PolicyDecisions.subscriberCount} usable as a readiness signal, which it has
         * to be: this bus replays nothing, so a test that answered a decision before a
         * subscription existed would be testing its own luck. Incrementing beside
         * `Stream.fromPubSub` and returning the stream reads as the same thing and is not —
         * the subscription is taken when the stream is first pulled, so the count could
         * lead it. `run/narration.ts` carries the same fix for the same reason.
         *
         * `Channel.fromSubscriptionArray` is the pair `Stream.fromPubSub` uses internally
         * (`effect/src/Channel.ts`'s `fromPubSubArray`), so the stream behaves identically.
         */
        answered: Stream.fromChannel(
          Channel.unwrap(
            Effect.map(
              Effect.acquireRelease(
                Effect.tap(PubSub.subscribe(pubsub), () =>
                  Effect.sync(() => {
                    subscribers += 1;
                  }),
                ),
                () =>
                  Effect.sync(() => {
                    subscribers -= 1;
                  }),
              ),
              Channel.fromSubscriptionArray,
            ),
          ),
        ),
        subscriberCount: Effect.sync(() => subscribers),
        holdSession: (sessionId, holder) =>
          Effect.sync(() => {
            const held = holders.get(sessionId) ?? new Set<object>();
            held.add(holder);
            holders.set(sessionId, held);
          }),
        endSession: (sessionId, holder) =>
          Effect.sync(() => {
            const held = holders.get(sessionId);
            held?.delete(holder);
            if (held !== undefined && held.size === 0)
              holders.delete(sessionId);
            ended.add(sessionId);
          }),
        sessionEnded: (sessionId) =>
          Effect.sync(
            () =>
              ended.has(sessionId) && (holders.get(sessionId)?.size ?? 0) === 0,
          ),
      });
    }),
  );
}

/**
 * Registers `POST {@link POLICY_DECIDE_PATH}` on the ambient router.
 *
 * This no longer owns a listener. The control plane serves one HTTP endpoint and this
 * is a route on it (`http/controlPlane.ts`), so there is one port, one origin policy
 * and one shutdown path rather than two of each.
 *
 * **Deliberately unauthenticated**, unlike the MCP route it now shares a port with.
 * The hook that calls it is a plugin inside the harness process, and keeping it
 * credential-free keeps that plugin dependency-free. What that costs is stated plainly:
 * anything that can reach loopback can submit a decision request and have it recorded.
 * It cannot force an `allow` — the answer is computed from {@link PolicyConfig}, never
 * from anything in the request — so the exposure is a polluted in-memory audit list,
 * not a bypassed gate. The MCP route's bearer middleware is scoped to the MCP protocol
 * layer and does not apply here.
 *
 * Method, content type and origin handling come from the router rather than from a
 * hand-written `if`, which is most of what the old `Bun.serve` wrapper was.
 */
export const policyRoutes = (config: PolicyConfig) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      const decisions = yield* PolicyDecisions;

      yield* router.add("POST", POLICY_DECIDE_PATH, (request) =>
        Effect.gen(function* () {
          const raw = yield* Effect.orElseSucceed(
            Effect.flatMap(request.text, (text) =>
              Effect.try(() => JSON.parse(text) as unknown),
            ),
            () => undefined,
          );
          const decoded = decodeRequest(raw);
          if (decoded._tag === "Failure") {
            // A gate that accepts a malformed request is not a gate: deny, with the
            // reason, and record nothing about a request we never understood.
            return HttpServerResponse.jsonUnsafe(
              {
                effect: "deny",
                reason: `undecodable policy request: ${decoded.failure.message}`,
              },
              { status: 400 },
            );
          }
          const body = decoded.success;
          // Before the scope is consulted: a session bit has ended has no authority for any
          // call, in scope or not. See `PolicyDecisions.holdSession`.
          const decision: PolicyDecision = (yield* decisions.sessionEnded(
            body.sessionId,
          ))
            ? {
                effect: "deny",
                reason: `session ${body.sessionId} has been ended by bit, so its authority is over and no tool of it runs`,
              }
            : decide(config, body);
          yield* decisions.record({ ...body, ...decision });
          return HttpServerResponse.jsonUnsafe(decision);
        }),
      );
    }),
  );
