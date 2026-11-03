/**
 * What the generic confirmation dialog is, independent of any one thing it confirms.
 *
 * `scopeDelete.test.ts` covers the scope-entry wording that goes *through* it. This file is
 * about the part that must be true for every future caller: nothing in it is specific to a
 * scope entry, nothing in it is focused by its markup, and its confirm button is the five
 * states B6 draws. How those states look is `test/confirmAction.test.ts`, from the
 * stylesheet.
 *
 * These were server-rendered markup tests. `Modal` now renders its panel only once its
 * layer is at the end of `<body>`, which a server render never reaches, so they read the
 * mounted dialog instead — the same claims, and the app has SSR off in any case.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createRawSnippet } from "svelte";

import ConfirmAction from "../../src/lib/components/ConfirmAction.svelte";
import { mountInto, settle, type Mounted } from "./dom";

let mounted: Mounted | undefined;
afterEach(() => {
  mounted?.destroy();
  mounted = undefined;
});

const body = createRawSnippet(() => ({
  render: () => "<p>Something the caller wrote.</p>",
}));

/** The dialog, mounted with `props` over the defaults, and its panel. */
const draw = async (
  props: Record<string, unknown> = {},
): Promise<HTMLElement> => {
  mounted = mountInto(ConfirmAction, {
    title: "Archive the thing?",
    body,
    confirmLabel: "Archive",
    workingLabel: "Archiving…",
    onconfirm: () => {},
    oncancel: () => {},
    ...props,
  });
  await settle();
  const panel = document.querySelector<HTMLElement>('[role="dialog"]');
  if (panel === null) throw new Error("no dialog");
  return panel;
};

const button = (panel: HTMLElement, kind: "confirm" | "cancel") => {
  const found = panel.querySelector<HTMLButtonElement>(`button.action.${kind}`);
  if (found === null) throw new Error(`no ${kind} button`);
  return found;
};

const label = (element: HTMLElement): string =>
  (element.textContent ?? "").trim();

describe("ConfirmAction", () => {
  test("every word on it is the caller's, and none is a scope entry's", async () => {
    const panel = await draw({ cancelLabel: "Leave it" });
    expect(panel.getAttribute("aria-label")).toBe("Archive the thing?");
    expect(panel.querySelector("h2")?.textContent).toBe("Archive the thing?");
    expect(panel.textContent).toContain("Something the caller wrote.");
    expect(label(button(panel, "confirm"))).toBe("Archive");
    expect(label(button(panel, "cancel"))).toBe("Leave it");
    // The component carries no wording of its own beyond a default for Cancel.
    expect(panel.textContent).not.toMatch(/entry|scope|asset|host/i);
  });

  test("Cancel is called Cancel unless the caller says otherwise", async () => {
    expect(label(button(await draw(), "cancel"))).toBe("Cancel");
  });

  test("the tone picks the fill, and the default is not the red one", async () => {
    expect([
      ...button(await draw({ tone: "danger" }), "confirm").classList,
    ]).toContain("danger");
    mounted?.destroy();
    expect([
      ...button(await draw({ tone: "neutral" }), "confirm").classList,
    ]).toContain("neutral");
    mounted?.destroy();
    // A confirmation is not automatically a destructive one: red is chosen, not defaulted
    // to, because red is a severity signal.
    const confirm = button(await draw(), "confirm");
    expect([...confirm.classList]).toContain("neutral");
    expect([...confirm.classList]).not.toContain("danger");
  });

  test("it opens with nothing focused by the markup", async () => {
    const panel = await draw();
    expect(panel.querySelector("[autofocus]")).toBeNull();
    // Focus is on the panel itself, so Enter presses nothing until Tab reaches a button.
    expect(document.activeElement).toBe(panel);
  });

  test("working swaps the label, withdraws Cancel and disables the confirm without dropping focus", async () => {
    const panel = await draw({ working: true });
    const confirm = button(panel, "confirm");
    expect(label(confirm)).toBe("Archiving…");
    expect([...panel.querySelectorAll("button")].map(label)).not.toContain(
      "Archive",
    );
    // `aria-disabled`, not `disabled`: a disabled button is dropped from the tab order
    // and, in a browser, loses focus to the page behind the scrim.
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    expect(confirm.disabled).toBe(false);
    expect(button(panel, "cancel").disabled).toBe(true);
  });

  test("at rest the confirm is pressable", async () => {
    const confirm = button(await draw(), "confirm");
    expect(confirm.getAttribute("aria-disabled")).toBe("false");
    expect(confirm.disabled).toBe(false);
  });
});
