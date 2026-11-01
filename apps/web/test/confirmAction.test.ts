/**
 * What the generic confirmation dialog is, independent of any one thing it confirms.
 *
 * `assetsComponent.test.ts` covers the scope-entry wording that goes *through* it. This
 * file is about the part that must be true for every future caller: nothing in it is
 * specific to a scope entry, nothing in it is focused on open, and its confirm button is
 * the five states B6 draws.
 *
 * **Server output, so no click runs.** The behaviours that need a browser — Escape
 * cancelling, the focus landing on the panel and not a button, Tab reaching Delete third —
 * are checked in one, and are not claimed here. What is checked here is what the markup
 * and the stylesheet say.
 */
import { describe, expect, test } from "bun:test";
import { createRawSnippet } from "svelte";
import { render } from "svelte/server";

import ConfirmAction from "../src/lib/components/ConfirmAction.svelte";

const source = await Bun.file(
  new URL("../src/lib/components/ConfirmAction.svelte", import.meta.url),
).text();

const body = createRawSnippet(() => ({
  render: () => "<p>Something the caller wrote.</p>",
}));

const draw = (props: Record<string, unknown> = {}): string =>
  render(ConfirmAction, {
    props: {
      title: "Archive the thing?",
      body,
      confirmLabel: "Archive",
      workingLabel: "Archiving…",
      onconfirm: () => {},
      oncancel: () => {},
      ...props,
    },
  }).body;

describe("ConfirmAction", () => {
  test("every word on it is the caller's, and none is a scope entry's", () => {
    const html = draw({ cancelLabel: "Leave it" });
    expect(html).toContain("Archive the thing?");
    expect(html).toContain("Something the caller wrote.");
    expect(html).toContain(">Archive<");
    expect(html).toContain(">Leave it<");
    // The component carries no wording of its own beyond a default for Cancel.
    expect(html).not.toMatch(/entry|scope|asset|host/i);
  });

  test("Cancel is called Cancel unless the caller says otherwise", () => {
    expect(draw()).toContain(">Cancel<");
  });

  test("the tone picks the fill, and the default is not the red one", () => {
    expect(draw({ tone: "danger" })).toContain("action confirm danger");
    expect(draw({ tone: "neutral" })).toContain("action confirm neutral");
    // A confirmation is not automatically a destructive one: red is chosen, not defaulted
    // to, because red is a severity signal.
    expect(draw()).toContain("action confirm neutral");
  });

  test("it opens with nothing focused by the markup", () => {
    expect(draw()).not.toContain("autofocus");
  });

  test("working swaps the label, withdraws Cancel and disables the confirm without dropping focus", () => {
    const html = draw({ working: true });
    expect(html).toContain("Archiving…");
    expect(html).not.toContain(">Archive<");
    // `aria-disabled`, not `disabled`: a disabled button is dropped from the tab order
    // and, in a browser, loses focus to the page behind the scrim.
    expect(html).toMatch(
      /class="action confirm [^"]*"[^>]*aria-disabled="true"/,
    );
    expect(html).not.toMatch(/class="action confirm [^"]*"[^>]*[ ]disabled/);
    expect(html).toMatch(/class="action cancel [^"]*"[^>]*disabled/);
  });

  test("at rest the confirm is pressable", () => {
    expect(draw()).toMatch(
      /class="action confirm [^"]*"[^>]*aria-disabled="false"/,
    );
  });
});

describe("ConfirmAction's confirm button, as B6 draws it", () => {
  /** One rule's declarations, from the component's own stylesheet. */
  const rule = (selector: string): string => {
    const start = source.indexOf(`${selector} {`);
    expect(start).toBeGreaterThan(-1);
    return source.slice(start, source.indexOf("}", start));
  };

  test("hover is 12% ink and pressed is 21% ink, over one fill", () => {
    expect(rule('.confirm:hover:not([aria-disabled="true"])')).toContain(
      "var(--ink) 12%",
    );
    expect(rule('.confirm:active:not([aria-disabled="true"])')).toContain(
      "var(--ink) 21%",
    );
    // The fill is set once per tone and never by a state: an overlay, not a second colour.
    expect(rule('.confirm:hover:not([aria-disabled="true"])')).not.toContain(
      "background",
    );
    expect(rule('.confirm:active:not([aria-disabled="true"])')).not.toContain(
      "background",
    );
  });

  test("the focus ring is the global one: no outline is declared here at all", () => {
    /*
     * `:focus-visible` in `tokens.css` draws the ring in `--border-focus` for every
     * control. B6: focus is never a severity signal, so a danger button must not carry
     * a red one. The way to get that wrong is to declare an outline on the button, in
     * any colour, so the stylesheet is checked for the property rather than for red.
     */
    const stylesheet = source.slice(source.indexOf("<style>"));
    expect(stylesheet).not.toMatch(/outline/);
    expect(stylesheet).not.toMatch(/:focus/);
  });

  test("working is dimmed and shows no pointer", () => {
    const working = rule('.confirm[aria-disabled="true"]');
    expect(working).toContain("opacity: 0.5");
    expect(working).toContain("not-allowed");
  });
});
