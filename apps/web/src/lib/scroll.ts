/**
 * Whether a scrolling box is at its bottom — the one decision "follow the newest" needs.
 *
 * ## Why this is a module and not three lines inside the component
 *
 * A live transcript that always scrolled to the newest item would yank the page out from
 * under an operator reading back through a tool's output, which on a busy run is every
 * second or two. A live transcript that never scrolled would stop showing what is happening
 * the moment it filled. The behaviour that is neither is **stick to the bottom only while
 * the reader is already there**, and the whole of that behaviour is this predicate plus
 * one assignment.
 *
 * It is here rather than in `LiveTranscript.svelte` because a `.svelte` file cannot be
 * imported by `bun test` — the compiler is only wired up for `.svelte.ts` modules
 * (`test/runes.ts`) — so a predicate written inside the component is a predicate nothing
 * checks. The off-by-one that matters here is exactly the kind of thing a test catches and
 * a glance does not: {@link SCROLL_SLACK} is what decides whether "one pixel from the
 * bottom after a repaint" counts as being at the bottom, and getting it wrong means the
 * view silently stops following.
 *
 * Browser-safe and DOM-free on purpose: it takes the three numbers rather than an element,
 * so the rule can be exercised without a DOM and the component stays the only thing that
 * has to know where the numbers come from.
 */

/**
 * How far from the bottom still counts as being at the bottom, in CSS pixels.
 *
 * Not zero, and that is the point of having a constant with a reason attached.
 * `scrollTop` is fractional on a zoomed or fractionally-scaled display, and
 * `scrollHeight - scrollTop - clientHeight` lands a fraction of a pixel short of zero
 * routinely; a strict `<= 0` therefore reads "the reader has scrolled up" the first time
 * the browser rounds against it, and the view stops following for no reason anybody can
 * see. Two pixels is below the smallest deliberate scroll gesture and above that noise.
 */
export const SCROLL_SLACK = 2;

/** The three numbers this rule needs, named as the DOM names them. */
export interface ScrollMetrics {
  /** How far down the box is scrolled. */
  readonly scrollTop: number;
  /** The full height of the content inside it. */
  readonly scrollHeight: number;
  /** The visible height of the box. */
  readonly clientHeight: number;
}

/**
 * Whether the box is scrolled to its bottom, within {@link SCROLL_SLACK}.
 *
 * A box whose content is shorter than itself is **at** the bottom: there is nowhere else to
 * be, and answering `false` there would mean a transcript that never follows until it has
 * overflowed once.
 */
export const atBottom = (
  metrics: ScrollMetrics,
  slack: number = SCROLL_SLACK,
): boolean =>
  metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= slack;
