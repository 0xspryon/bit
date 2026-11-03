/**
 * Which clicks on one of this app's links are the app's, and which are the browser's.
 *
 * `src/lib/placeLink.ts` is a pure function, so this could have been a table of object
 * literals — except that the fields it reads are the ones a browser fills in, and a literal
 * is a claim about what a browser sends rather than a sample of it. So the events here are
 * real `MouseEvent`s, built the way the DOM builds them, which is why this sits in the DOM
 * suite: `bun test` on its own has no `MouseEvent` at all.
 *
 * What is *not* asserted here is what a modified click then does, because nothing in this
 * app does it: no `preventDefault` runs, the href stands, and the new tab is the browser's
 * own. `agentSessions.test.ts` in this directory holds that end of it, on a real row.
 */
import { describe, expect, test } from "bun:test";

import { routedInApp } from "../../src/lib/placeLink";

const clickWith = (init: MouseEventInit = {}): MouseEvent =>
  new MouseEvent("click", { bubbles: true, cancelable: true, ...init });

describe("a click on a link to a place", () => {
  test("the plain primary-button click is the app's to route", () => {
    expect(routedInApp(clickWith())).toBe(true);
    // A keyboard Enter on a focused link arrives as exactly this, which is the answer
    // wanted for it too.
    expect(routedInApp(clickWith({ detail: 0 }))).toBe(true);
  });

  test("every modifier the browser has a meaning for is left to the browser", () => {
    // New tab, new tab on macOS, new window, download. None of them are this app's to
    // redefine, and swallowing them is how an app makes "open in a new tab" do nothing.
    expect(routedInApp(clickWith({ ctrlKey: true }))).toBe(false);
    expect(routedInApp(clickWith({ metaKey: true }))).toBe(false);
    expect(routedInApp(clickWith({ shiftKey: true }))).toBe(false);
    expect(routedInApp(clickWith({ altKey: true }))).toBe(false);
  });

  test("a button that is not the primary one is left to the browser", () => {
    // A middle click reaches `auxclick` in a current browser and no `onauxclick` is
    // registered anywhere, so the href is followed natively. This covers the engines and
    // the synthetic events that deliver it as a `click` instead.
    expect(routedInApp(clickWith({ button: 1 }))).toBe(false);
    expect(routedInApp(clickWith({ button: 2 }))).toBe(false);
  });

  test("a click another handler already took is not re-decided", () => {
    const event = clickWith();
    event.preventDefault();
    expect(routedInApp(event)).toBe(false);
  });
});
