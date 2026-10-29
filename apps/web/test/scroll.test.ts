/**
 * The one decision "follow the newest" rests on.
 *
 * `atBottom` lives in its own module precisely so this file can exist — see `scroll.ts` on
 * why a predicate written inside `LiveTranscript.svelte` is a predicate nothing checks.
 * What is asserted here is the boundary, because the boundary is the whole behaviour: one
 * pixel either side of it is the difference between a transcript that follows a run and one
 * that silently stops the first time the browser rounds a fractional `scrollTop` against
 * it.
 *
 * What is **not** asserted here is the component's use of it — that a scroll handler sets
 * the flag and an effect acts on it. That needs a DOM, and the division is the one
 * `app.test.ts` records: these are tests of the rule, not of the screen.
 */
import { describe, expect, test } from "bun:test";

import { SCROLL_SLACK, atBottom } from "../src/lib/scroll";

/** A box 100 tall holding 500 of content: 400 of scrollable travel. */
const box = (scrollTop: number) => ({
  scrollTop,
  scrollHeight: 500,
  clientHeight: 100,
});

describe("atBottom", () => {
  test("scrolled fully down is at the bottom", () => {
    expect(atBottom(box(400))).toBe(true);
  });

  test("scrolled to the top is not", () => {
    expect(atBottom(box(0))).toBe(false);
  });

  test("a deliberate scroll up of one line is not", () => {
    // The case the whole flag exists for: an operator reading back through a tool's output
    // must not have the view yanked to the newest item under them.
    expect(atBottom(box(380))).toBe(false);
  });

  test("a fraction of a pixel short still counts, and that is why there is slack", () => {
    // `scrollTop` is fractional on a zoomed or fractionally-scaled display, so
    // `scrollHeight - scrollTop - clientHeight` lands just short of zero routinely. A
    // strict `<= 0` reads that as "the reader scrolled up" and stops following for a reason
    // nobody can see.
    expect(atBottom(box(399.5))).toBe(true);
    expect(atBottom(box(400 - SCROLL_SLACK))).toBe(true);
  });

  test("just outside the slack does not count", () => {
    expect(atBottom(box(400 - SCROLL_SLACK - 1))).toBe(false);
  });

  test("content shorter than the box is at the bottom", () => {
    // There is nowhere else to be. Answering `false` here would mean a fresh transcript
    // never follows until it has overflowed once — which is exactly when a reader is most
    // likely to be watching a run start.
    expect(
      atBottom({ scrollTop: 0, scrollHeight: 40, clientHeight: 100 }),
    ).toBe(true);
  });

  test("the slack is overridable, so the rule can be tightened without being rewritten", () => {
    expect(atBottom(box(399), 0)).toBe(false);
    expect(atBottom(box(399), 10)).toBe(true);
  });
});
