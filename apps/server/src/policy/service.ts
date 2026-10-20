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
import { Context, Effect, Layer, Schema } from "effect";
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

export type PolicyDecision =
  | { readonly effect: "allow" }
  | { readonly effect: "deny"; readonly reason: string };

export interface PolicyConfig {
  /**
   * Path fragments that are out of scope. A tool call whose serialised input mentions
   * one is refused before the tool runs.
   */
  readonly forbiddenPathFragments: readonly string[];
  /** Hosts the worker may reach. Anything else named in a tool input is refused. */
  readonly allowedHosts: readonly string[];
}

/**
 * The boundaries a run enforces when the caller names none.
 *
 * Loopback only, and no out-of-scope paths declared. That is the honest default for
 * this foundation: the fixture is the only target, and inventing forbidden fragments
 * here would make a run look more constrained than it is. A demo that wants real
 * boundaries states them (`spike/policyDemo.ts`).
 */
export const DEFAULT_POLICY: PolicyConfig = {
  forbiddenPathFragments: [],
  allowedHosts: ["127.0.0.1", "localhost"],
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

  for (const authority of hostsIn(serialised)) {
    // Compare the host alone. The fixture binds to an arbitrary free port, so a port
    // is not part of host identity here; a scope that needs per-port rules would add
    // them explicitly rather than inherit this behaviour by accident.
    const host = hostOf(authority);
    if (!config.allowedHosts.includes(host)) {
      return {
        effect: "deny",
        reason: `host '${host}' is not in the engagement scope`,
      };
    }
  }

  return { effect: "allow" };
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
 * The decisions this process has answered, in order.
 *
 * A service rather than a closure because the route handler and the demo that reads the
 * audit now live on opposite sides of the shared listener. It is an in-memory record for
 * the spike's own assertions, not the durable audit trail.
 */
export class PolicyDecisions extends Context.Service<
  PolicyDecisions,
  {
    readonly record: (
      entry: PolicyRequest & PolicyDecision,
    ) => Effect.Effect<void>;
    readonly all: Effect.Effect<readonly (PolicyRequest & PolicyDecision)[]>;
  }
>()("bit/policy/PolicyDecisions") {
  static readonly layer = Layer.sync(PolicyDecisions, () => {
    const entries: (PolicyRequest & PolicyDecision)[] = [];
    return PolicyDecisions.of({
      record: (entry) =>
        Effect.sync(() => {
          entries.push(entry);
        }),
      all: Effect.sync(() => [...entries]),
    });
  });
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
          const decision = decide(config, body);
          yield* decisions.record({ ...body, ...decision });
          return HttpServerResponse.jsonUnsafe(decision);
        }),
      );
    }),
  );
