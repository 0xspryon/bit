/**
 * When a click on one of this app's own links belongs to the app, and when it belongs to the
 * browser.
 *
 * A row that leads somewhere has to be an `<a href>`: that is the only thing an operator can
 * copy, middle-click, or open in a second tab, and copying a link is the whole requirement
 * this routing work exists for (`docs/superpowers/specs/2026-11-03-url-routing-design.md`).
 * But a plain anchor the browser follows would reload the document and throw the running app
 * away — the session, the live feed, every read already in hand — for a navigation that moves
 * one section. So the href is real and the ordinary click is handled here instead: the app
 * changes state, and the route's reflection writes the same path into the address bar that
 * the href already held.
 *
 * **The modified click is the part worth getting right.** Ctrl, Cmd, Shift and Alt on a link
 * are the browser's own vocabulary — new tab, new window, save — and they are not this app's
 * to redefine. An app that calls `preventDefault` on every click swallows all of them, and
 * the operator who tried to open a chat beside the one they are reading gets nothing instead,
 * with no error to explain it. So this predicate is false for every click that carries a
 * meaning of the browser's, and the handler leaves such a click alone: the href is a true URL
 * and the new tab cold-loads it through the same path a bookmark does.
 *
 * It is a pure function of the event so that the rule is one place and is testable without a
 * browser (`test/placeLink.test.ts`). Nothing here imports SvelteKit, `App`, or the grammar.
 */

/**
 * Whether the app should route this click itself, rather than let the browser follow.
 *
 * `true` only for the unmodified primary-button click, which is the one that means "go there,
 * here". Everything else is the browser's:
 *
 * - **A modifier key.** Ctrl or Cmd opens a new tab, Shift a new window (and in Firefox,
 *   Shift on a link is also a new window), Alt downloads it on most platforms. All four are
 *   the operator asking the *browser* for something.
 * - **A button that is not the primary one.** A middle click in a modern browser reaches an
 *   `auxclick` listener rather than a `click` one, so this branch is mostly unreachable —
 *   which is exactly why it is worth writing down: no `onauxclick` is registered anywhere, a
 *   middle click is therefore never intercepted at all, and the browser opens the href in a
 *   background tab on its own. The check stands for the engines and the synthetic events that
 *   do deliver button 1 or 2 as a `click`.
 * - **A click something else already handled.** `defaultPrevented` means a handler closer to
 *   the element has spoken, and re-deciding over it would make the outcome depend on listener
 *   order.
 *
 * A keyboard Enter on a focused link arrives as an unmodified primary click, so it routes in
 * the app like a mouse click, which is the right answer for both.
 */
export const routedInApp = (event: MouseEvent): boolean =>
  !event.defaultPrevented &&
  event.button === 0 &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey;
