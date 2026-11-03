/**
 * Whether writing the place into the address bar is worth a history entry.
 *
 * The design's D4 says **opening a resource pushes a history entry; everything else
 * replaces** (`docs/superpowers/specs/2026-11-03-url-routing-design.md`). That is a rule
 * about meaning, and this module is the one place it is turned into a decision, so that
 * the route is left with `replace: write === "replace"` and nothing to reason about.
 *
 * ## The rule, concretely
 *
 * **A write pushes when the path changes, and replaces when it does not.**
 *
 * That is not a second rule bolted onto the grammar — it *is* the grammar. D2 put the
 * resource in the path and the view modifier in the query for exactly this reason: "the
 * path says which resource; the query says how you were looking at it". So a change of
 * target, section, assets tab, goal, chat session or attempt moves the path and is worth
 * going back to; a change of nothing but `?filter` moves only the query and is not,
 * because the filter is a way of squinting at a page you are already on. Everything that
 * is neither — a picker, the theme, the live dock, a scroll offset — never reaches here at
 * all, because it is not in the URL by D1 and so cannot change what {@link placeOf}
 * returns.
 *
 * ## Why it compares places and not URL text
 *
 * The address bar can hold a spelling the app does not emit. `/t/acme/goals` is the goal
 * list and so is `/t/acme`; `/?target=acme` is the link the shell wrote before there were
 * paths. Tidying either one into the canonical form changes the *text* while naming the
 * same resource, and a history entry for that would be an entry the operator cannot
 * usefully go back to — pressing Back would land on the same page under its old name, and
 * with an old bookmark it would land there again and again. So the comparison runs through
 * {@link placeArrivedAt} and {@link pathOf} first: both sides are canonicalised, and only
 * then is the path compared.
 *
 * ## Why `"skip"` is a case and not an optimisation
 *
 * A write that would not change the URL is the whole defence against the feedback loop
 * that history navigation invites. The route reads the URL on `popstate`, applies the place
 * to the state, and the state reflects back into the URL — which would be a loop, or an
 * entry per hop, except that by then the URL already says what the state says, so there is
 * nothing to write and the loop has no first step. The route's comment names this; the
 * `"skip"` case is where it is enforced.
 *
 * ## Why a failed arrival replaces
 *
 * The third input is design D5's, and it is a history rule rather than a message one. When
 * a link names something that has gone, the app falls back to the nearest place that does
 * exist — a goal list for a dead goal, the target list for a dead target — and that
 * fallback *is* a change of path, so the rule above would push. Pushing it is wrong twice
 * over. The entry the operator is standing on names nothing, so leaving it behind to go
 * Back to is leaving a trap; and going Back onto it applies it again, falls back again, and
 * pushes again — a Back button that cannot leave the page, which is what a bookmark to a
 * deleted target did on `main` before S5.
 *
 * So a fallback **corrects the entry the dead link is on** instead of adding one: the
 * address bar stops lying, history keeps its length, and Back goes to wherever the operator
 * was before they followed the link. The route knows an arrival fell back because
 * `App.arrivalNote` is standing, and the note's own lifetime is what bounds this — it is
 * cleared by the next navigation the operator chooses, so the very next write after that is
 * an ordinary push again.
 *
 * Pure, so the rule is testable without a DOM, a router or an `App` (`test/placeHistory.test.ts`).
 */
import { placeArrivedAt } from "./arrival";
import { pathOf } from "./place";

/** What the route should do with a place that is not yet in the address bar. */
export type HistoryWrite =
  /** The address bar already names this place. Writing would be a no-op with a cost. */
  | "skip"
  /** Correct the entry in place: the same resource under a new spelling, or a new view of it. */
  | "replace"
  /** A new entry: a different resource, which the operator may want to come back from. */
  | "push";

/**
 * The two halves of the address bar this rule needs.
 *
 * Shaped so that `location` itself satisfies it — the route calls `historyWrite(location,
 * …)` — and so that a test can pass a literal without a DOM.
 */
export interface Address {
  readonly pathname: string;
  readonly search: string;
}

/**
 * Whether the place on screen is the one the URL asked for, or the nearest one that exists.
 *
 * `"fell-back"` is the arrival design D5 is about: the link named a resource that has gone
 * and the app went one level out instead. The route reads it off a standing
 * `App.arrivalNote`, which is set by exactly those three fallbacks and cleared by the next
 * navigation the operator makes.
 */
export type Arrival = "landed" | "fell-back";

/**
 * How to write `next` over `here`.
 *
 * `next` is {@link pathOf} of the place the state is in, so it is always canonical. `here`
 * is whatever the address bar happens to hold, which is canonical for every entry this app
 * wrote and may not be for the one the tab was opened with.
 *
 * `arrival` defaults to `"landed"`, which is the safe default in the direction that
 * matters: a caller that forgets it gets the ordinary rule, so an omission costs a history
 * entry rather than silently eating one the operator wanted.
 */
export const historyWrite = (
  here: Address,
  next: string,
  arrival: Arrival = "landed",
): HistoryWrite => {
  if (next === here.pathname + here.search) return "skip";
  // Before the path comparison, because a fallback is a change of path by construction —
  // the place it lands on is a *container* of the one the link named — so the rule below
  // would always answer `"push"` for it.
  if (arrival === "fell-back") return "replace";
  const held = pathOf(placeArrivedAt(here.pathname, here.search));
  return pathnameOf(held) === pathnameOf(next) ? "replace" : "push";
};

/**
 * The path half of something {@link pathOf} produced.
 *
 * Split rather than parsed: `pathOf` emits at most one query parameter and never a
 * fragment, so the first `?` is the whole boundary and a `URL` would only add an origin to
 * invent.
 */
const pathnameOf = (path: string): string => path.split("?")[0] ?? "";
