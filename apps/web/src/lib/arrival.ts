/**
 * What a URL the app was opened with means, including the one spelling it no longer writes.
 *
 * `place.ts` is the grammar of this app's URLs as approved
 * (`docs/superpowers/specs/2026-11-03-url-routing-design.md`). This module is the one thing
 * that is not that: `?target=<id>`, the single-resource link the shell wrote before there
 * were paths. A saved bookmark is a promise, so that spelling still has to land — but it is
 * a shim with an end, not part of the grammar, and keeping it out of `place.ts` is what
 * lets it be deleted in one piece without reading the grammar for traces of it.
 *
 * The translation happens **once, on arrival**. The route holds `pathOf` of whatever this
 * returns, so from the first reflection onwards the address bar carries the path form and
 * nothing downstream of here has ever heard of the query parameter.
 *
 * "On arrival" has two readers rather than one, and S4 added the second: the mount, and a
 * `popstate`. They are the same event seen twice — a URL the app did not write, arriving
 * from outside — and the only such URL a tab's history can hold is the one it was opened
 * with. The first reflection replaces that entry with the path form, so Back does not reach
 * it in practice; both readers go through this function anyway, because two readers of one
 * URL that disagreed about what it meant would be worse than a shim with one extra caller.
 */
import { parsePath, type Place } from "./place";

/** The query parameter a deep link to a target used to carry. */
const TARGET_PARAM = "target";

/**
 * The place a URL opens on, from the two halves `location` gives.
 *
 * The path is read first and the legacy parameter is consulted only when the path names no
 * target, which is the rule that makes this shim unable to misfire: a path form says where
 * it goes, and `/t/acme-corp?target=scratch` is the path's place with a stale parameter
 * riding along, not a disagreement to resolve. Total, like `parsePath` — every URL names
 * somewhere, and `?target=` with an empty value names nothing in particular.
 */
export const placeArrivedAt = (pathname: string, search: string): Place => {
  const place = parsePath(pathname + search);
  if (place.kind !== "targets") return place;
  const asked = new URLSearchParams(search).get(TARGET_PARAM);
  return asked === null || asked === ""
    ? place
    : { kind: "target", targetId: asked };
};
