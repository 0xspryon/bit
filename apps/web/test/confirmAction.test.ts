/**
 * ConfirmAction's confirm button as B6 draws it, read off the component's own stylesheet.
 *
 * What the dialog says and which of its buttons are pressable is `test/dom/confirmAction`,
 * which mounts it: `Modal` renders its panel only once its layer is at the end of `<body>`
 * (see `dialogLayer`), so a server render of it is an empty layer and has no markup to
 * read. `assetsComponent.test.ts` no longer covers the scope-entry wording either; that is
 * `test/dom/scopeDelete`.
 */
import { describe, expect, test } from "bun:test";

const source = await Bun.file(
  new URL("../src/lib/components/ConfirmAction.svelte", import.meta.url),
).text();

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
