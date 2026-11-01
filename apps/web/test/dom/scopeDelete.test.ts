/**
 * Deleting a scope entry, driven the way a person drives it: click the `×`, read the
 * question, answer it, and see where focus is left.
 *
 * `assetsComponent.test.ts` renders this screen on the server, where no click runs, and
 * `assets.test.ts` tests the state machine with no component at all. Neither could see that
 * focus went to `<body>` after a delete — the `×` is removed with its row, so the dialog's
 * "return focus to the opener" had nothing to return to — and that shipped. These tests are
 * the tier that can.
 *
 * Mounted against a real `App` over the hand-written control plane, so a click goes through
 * the app's own handlers, the dialog, the double, and back into the DOM.
 */
import { afterEach, describe, expect, test } from "bun:test";

import type { ScopeEntryView } from "@bit/contracts";

import { App } from "../../src/lib/app.svelte";
import Assets from "../../src/lib/screens/Assets.svelte";
import { FakeCountdown } from "../fakeCountdown";
import { FakeServer, emptyScope, ok } from "../fakeServer";
import { click, mountInto, press, settle, type Mounted } from "./dom";

const entry = (value: string, effect: "in" | "out" = "in"): ScopeEntryView => ({
  entryId: `ent_${value}`,
  effect,
  kind: "subtree",
  value,
  source: "operator",
  note: null,
  createdAt: 1,
});

let mounted: Mounted | undefined;
afterEach(() => {
  mounted?.destroy();
  mounted = undefined;
});

/**
 * The Scope tab, mounted, with `values` as the in-scope entries.
 *
 * The control plane's `removeScopeEntry` answers with the list *without* the entry it was
 * asked about, the way the real one does — which is the whole point: the row, and the `×`
 * that opened the dialog, are gone by the time the dialog closes.
 */
const openScope = async (
  ...values: string[]
): Promise<{ app: App; fake: FakeServer }> => {
  const fake = new FakeServer();
  let entries = values.map((value) => entry(value));
  const scope = () =>
    ok(emptyScope({ entries, promptBlock: "[Authorized testing scope]" }));
  fake.onScope = scope;
  fake.onRemoveScopeEntry = (_baseUrl, _targetId, entryId) => {
    entries = entries.filter((each) => each.entryId !== entryId);
    return scope();
  };
  const app = new App(fake, new FakeCountdown());
  app.password = "correct-horse";
  await app.connect();
  app.openTarget("acme-corp");
  await settle();
  app.toSection("assets");
  await settle();
  app.toAssetsTab("scope");
  await settle();
  mounted = mountInto(Assets, { app });
  await settle();
  return { app, fake };
};

const removeButton = (value: string): HTMLButtonElement => {
  const button = document.querySelector<HTMLButtonElement>(
    `button[aria-label="Remove ${value}"]`,
  );
  if (button === null) throw new Error(`no × for ${value} on screen`);
  return button;
};

const dialog = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="dialog"]');

const confirmButton = (): HTMLButtonElement => {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
  ].find((each) => each.textContent?.includes("Delete entry"));
  if (button === undefined) throw new Error("no Delete entry button");
  return button;
};

/** What a mouse does to a button: focus it, then click it. */
const clickWithMouse = (button: HTMLElement): void => {
  button.focus();
  click(button);
};

describe("the × on a scope entry", () => {
  test("opens the question and deletes nothing", async () => {
    const { fake } = await openScope("acme.test", "api.acme.test");
    expect(dialog()).toBeNull();

    clickWithMouse(removeButton("acme.test"));
    await settle();

    // The click that opens the question is not the click that deletes.
    expect(dialog()).not.toBeNull();
    expect(dialog()?.getAttribute("aria-label")).toBe(
      "Delete the entry acme.test?",
    );
    expect(fake.countOf("removeScopeEntry")).toBe(0);
    expect(document.querySelectorAll(".entry")).toHaveLength(2);
  });
});

describe("the delete question", () => {
  test("does not put focus on the confirm button", async () => {
    await openScope("acme.test");
    clickWithMouse(removeButton("acme.test"));
    await settle();

    // The Enter that opened the dialog must not be able to finish it.
    expect(document.activeElement).toBe(dialog());
    expect(document.activeElement).not.toBe(confirmButton());
  });

  test("Escape cancels: nothing is deleted, the question closes, focus goes back to the ×", async () => {
    const { app, fake } = await openScope("acme.test");
    const x = removeButton("acme.test");
    clickWithMouse(x);
    await settle();
    expect(dialog()).not.toBeNull();

    press("Escape");
    await settle();

    expect(dialog()).toBeNull();
    expect(app.scopeEntryToRemove).toBe("");
    expect(fake.countOf("removeScopeEntry")).toBe(0);
    // The opener still exists, so it is what gets focus back.
    expect(document.activeElement).toBe(x);
  });

  test("Cancel closes it the same way", async () => {
    const { fake } = await openScope("acme.test");
    const x = removeButton("acme.test");
    clickWithMouse(x);
    await settle();

    const cancel = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
    ].find((each) => each.textContent?.trim() === "Cancel");
    if (cancel === undefined) throw new Error("no Cancel button");
    click(cancel);
    await settle();

    expect(dialog()).toBeNull();
    expect(fake.countOf("removeScopeEntry")).toBe(0);
    expect(document.activeElement).toBe(x);
  });

  test("after a successful delete, focus is on the list the row was in, not <body>", async () => {
    const { fake } = await openScope("acme.test", "api.acme.test");
    clickWithMouse(removeButton("acme.test"));
    await settle();

    click(confirmButton());
    await settle();

    expect(fake.countOf("removeScopeEntry")).toBe(1);
    expect(dialog()).toBeNull();
    // The row, and the × that opened the dialog, are gone: it is a different row count and
    // a different element, and `isConnected` on the old one is what used to end the story.
    expect(document.querySelectorAll(".entry")).toHaveLength(1);
    expect(document.activeElement).not.toBe(document.body);
    // A stable neighbour that survives the delete: the "In scope" list itself.
    expect(document.activeElement?.getAttribute("aria-label")).toBe("In scope");
    expect(document.activeElement?.hasAttribute("data-focus-fallback")).toBe(
      true,
    );
  });

  test("after deleting the last entry of a list, focus is still on that list", async () => {
    // The list's `<ul>` goes with its last row and "None." takes its place, so the
    // fallback cannot be the `<ul>`.
    await openScope("acme.test");
    clickWithMouse(removeButton("acme.test"));
    await settle();

    click(confirmButton());
    await settle();

    expect(document.querySelectorAll(".entry")).toHaveLength(0);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("In scope");
  });
});
