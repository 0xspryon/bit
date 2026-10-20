/**
 * The HTTP surface's version prefix.
 *
 * Every endpoint this application *serves* lives under {@link API_PREFIX}, so a client
 * never has to know which subsystem answers a given path, and a future version can be
 * introduced alongside rather than by rewriting callers.
 *
 * The constant lives in contracts because both sides need the same answer: the web app
 * builds request URLs from it and the server matches incoming paths against it. A
 * hand-written string on either side is how the two drift.
 *
 * **This covers endpoints we own, not endpoints we talk to.** A simulated target under
 * test keeps whatever paths it is imitating — putting someone else's `POST /login` under
 * our API namespace would misdescribe what it is.
 *
 * Browser-safe: no server, Bun, Node or persistence imports.
 */

/** The only version currently served. Nothing has been published under another. */
export const API_VERSION = "v1" as const;

/** The prefix every served endpoint sits under, with no trailing slash. */
export const API_PREFIX = `/api/${API_VERSION}` as const;

/**
 * Builds a served endpoint's path.
 *
 * Accepts segments with or without a leading slash so a caller cannot produce
 * `/api/v1//health` by being careful in the wrong direction.
 *
 * The return type is the literal template rather than `string` so a router that demands
 * an absolute path — `effect/http`'s `PathInput` is `` `/${string}` ``
 * (`effect/src/http/HttpRouter.ts:785`) — accepts the result without a cast.
 *
 * @example
 * apiPath("health") // "/api/v1/health"
 * apiPath("/policy/decide") // "/api/v1/policy/decide"
 */
export const apiPath = (path: string): `${typeof API_PREFIX}/${string}` =>
  `${API_PREFIX}/${path.replace(/^\/+/, "")}`;
