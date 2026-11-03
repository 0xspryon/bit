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
import { flushSync } from "svelte";

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
const openScope = (
  ...values: string[]
): Promise<{ app: App; fake: FakeServer }> =>
  openScopeWith(values.map((value) => entry(value)));

const openScopeWith = async (
  initial: ScopeEntryView[],
): Promise<{ app: App; fake: FakeServer }> => {
  const fake = new FakeServer();
  let entries = initial;
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
    // fallback cannot be the `<ul>`. The other list still holds an entry, so the page
    // keeps both lists and this one is still there to take focus.
    await openScopeWith([entry("acme.test"), entry("blog.acme.test", "out")]);
    clickWithMouse(removeButton("acme.test"));
    await settle();

    click(confirmButton());
    await settle();

    expect(document.querySelectorAll(".entry")).toHaveLength(1);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("In scope");
  });

  test("after deleting the last entry of all, focus is on the empty state that replaces the lists", async () => {
    // Both lists go with it: the empty state ("No scope authored", with the importer's
    // button) takes their place, and the list that was the marked survivor is gone too.
    await openScope("acme.test");
    clickWithMouse(removeButton("acme.test"));
    await settle();

    click(confirmButton());
    await settle();

    expect(document.querySelectorAll(".entry")).toHaveLength(0);
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "No scope authored for this target",
    );
  });
});

/**
 * What the question says. These were server-rendered markup tests until `Modal` began
 * rendering its panel only once its layer is in `<body>`, which a server render never
 * reaches; they are the same claims, read off the mounted dialog.
 */
describe("the delete question's words", () => {
  const entries = [
    entry("acme.test"),
    { ...entry("blog.acme.test", "out"), kind: "host" as const },
  ];

  /** The question about `value`, open, as the operator's click on its × leaves it. */
  const ask = async (
    value: string,
  ): Promise<{ app: App; panel: HTMLElement }> => {
    const opened = await openScopeWith(entries);
    clickWithMouse(removeButton(value));
    await settle();
    const panel = dialog();
    if (panel === null) throw new Error(`no question about ${value}`);
    return { app: opened.app, panel };
  };

  /** The words of the dialog, with source line breaks folded to spaces. */
  const words = (panel: HTMLElement): string =>
    (panel.textContent ?? "").replace(/\s+/g, " ");

  const button = (panel: HTMLElement, label: string): HTMLButtonElement => {
    const found = [...panel.querySelectorAll<HTMLButtonElement>("button")].find(
      (each) => each.textContent?.trim() === label,
    );
    if (found === undefined) throw new Error(`no ${label} button`);
    return found;
  };

  test("no question is on screen until one is asked", async () => {
    await openScopeWith(entries);
    expect(dialog()).toBeNull();
  });

  test("an in-scope entry says what it removes, and what it leaves alone", async () => {
    const { panel } = await ask("acme.test");
    expect(panel.getAttribute("aria-label")).toBe(
      "Delete the entry acme.test?",
    );
    const dialogWords = words(panel);
    expect(dialogWords).toContain("acme.test and every subdomain");
    expect(dialogWords).toContain("from the in-scope list");
    // The delete path touches no asset and no label, and the sentence says so.
    expect(dialogWords).toContain("Nothing the hunt found is deleted");
    expect(dialogWords).toContain("Labels you set by hand are not touched");
    expect(dialogWords).toContain("not covered");
    expect(dialogWords).toContain("Delete entry");
    expect(dialogWords).toContain("Cancel");
    expect(dialogWords).not.toContain("Keep it out");
  });

  test("an out-of-scope entry warns that deleting ends the exclusion", async () => {
    const dialogWords = words((await ask("blog.acme.test")).panel);
    expect(dialogWords).toContain("from the out-of-scope list");
    // Deleting an exclusion can make a host *in* scope, if an in-scope entry also
    // covers it. That is the consequence an operator tidying the list would not guess.
    expect(dialogWords).toContain("becomes");
    expect(dialogWords).toContain("in scope");
    expect(dialogWords).toContain("does not keep a host out of the hunt");
    expect(dialogWords).toContain("Keep it out");
  });

  test("it promises no count, no undo and no alternative action", async () => {
    /*
     * B5 and B6 draw an asset count, an Undo and a "Move to out of scope instead"
     * button. None has a server behind it: no contract carries a per-entry asset
     * count, and nothing anywhere undoes a deletion. Copy that promised them would be
     * a button that appears to work and does nothing.
     */
    for (const value of ["acme.test", "blog.acme.test"]) {
      const dialogWords = words((await ask(value)).panel);
      expect(dialogWords).not.toMatch(/\d+ assets?/);
      expect(dialogWords).not.toContain("Undoable");
      expect(dialogWords).not.toContain("Move to out of scope");
      expect(dialogWords).toContain("There is no undo");
      mounted?.destroy();
      mounted = undefined;
    }
  });

  test("nothing in it is autofocused, and Delete is not disabled until it is working", async () => {
    const { panel } = await ask("acme.test");
    // Enter does nothing until the operator tabs to Delete. `autofocus` is the one
    // way the markup itself could make it do something. Svelte sets it as a property, not
    // an attribute, so the property is what is read.
    // Compared as markup, never as elements: a failing `toEqual` on a happy-dom element
    // prints its whole window, which runs this test process out of memory.
    expect(
      [...panel.querySelectorAll<HTMLElement>("*")]
        .filter((each) => each.autofocus)
        .map((each) => each.outerHTML),
    ).toEqual([]);
    expect(document.activeElement).toBe(panel);
    expect(button(panel, "Delete entry").getAttribute("aria-disabled")).toBe(
      "false",
    );
  });

  test("while it works the button says so and cannot be pressed", async () => {
    const { app, panel } = await ask("acme.test");
    app.scopeBusy = true;
    flushSync();
    expect(words(panel)).not.toContain("Delete entry");
    const confirm = button(panel, "Deleting…");
    expect(confirm.classList.contains("danger")).toBe(true);
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    // Cancel is withdrawn too: the request is already on its way.
    expect(button(panel, "Cancel").disabled).toBe(true);
  });

  test("an entry that is gone takes its question with it", async () => {
    const { app } = await openScopeWith(entries);
    app.askToRemoveScopeEntry("ent_already_deleted");
    await settle();
    expect(dialog()).toBeNull();
  });
});
