/**
 * The importer's entry point on the Assets page, and the page it opens, driven the way a
 * person drives them: click the button, type a link, press Start.
 *
 * `scopeImport.test.ts` covers the state machine and what the page says; neither can see
 * that a button is *there*, that pressing it goes anywhere, or where focus is left. The
 * importer used to start from the create-target page, and that was the only place; with
 * the links gone from it, a button that does not open the page is a shipped feature with no
 * way in. So the whole route is walked through `Target`, the screen that swaps Assets for
 * the page, and not through either half alone.
 */
import { afterEach, describe, expect, test } from "bun:test";

import type { ScopeEntryView } from "@bit/contracts";

import { App } from "../../src/lib/app.svelte";
import Target from "../../src/lib/screens/Target.svelte";
import { FakeCountdown } from "../fakeCountdown";
import { FakeServer, emptyScope, ok } from "../fakeServer";
import { click, mountInto, settle, type Mounted } from "./dom";

const entry = (value: string): ScopeEntryView => ({
  entryId: `ent_${value}`,
  effect: "in",
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

/** The open target's Scope tab, with `values` as its in-scope entries. */
const openScope = async (
  ...values: string[]
): Promise<{ app: App; fake: FakeServer }> => {
  const fake = new FakeServer();
  fake.onScope = () => ok(emptyScope({ entries: values.map(entry) }));
  const app = new App(fake, new FakeCountdown());
  app.password = "correct-horse";
  await app.connect();
  app.openTarget("acme-corp");
  await settle();
  app.toSection("assets");
  await settle();
  app.toAssetsTab("scope");
  await settle();
  mounted = mountInto(Target, { app });
  await settle();
  return { app, fake };
};

/** A button by its visible text, or a failure that says what was on screen. */
const button = (label: string): HTMLButtonElement => {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")];
  const found = buttons.find((each) => each.textContent?.trim() === label);
  if (found === undefined) {
    throw new Error(
      `no "${label}" button; there are: ${buttons
        .map((each) => `"${each.textContent?.trim() ?? ""}"`)
        .join(", ")}`,
    );
  }
  return found;
};

const hasButton = (label: string): boolean =>
  [...document.querySelectorAll("button")].some(
    (each) => each.textContent?.trim() === label,
  );

/** What typing into a field does: set the value, then tell the handler. */
const type = (input: HTMLInputElement, value: string): void => {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("an empty Scope tab", () => {
  test("offers the importer first and typing an entry second, under D1's copy", async () => {
    await openScope();

    expect(document.body.textContent?.replace(/\s+/g, " ")).toContain(
      "Hand the program's pages to the importer and it drafts the in and out entries with you, or type the first entry yourself.",
    );
    const auto = button("Auto-load scope…");
    const byHand = button("Add an entry by hand");
    // Primary, then secondary: the order is the design's, and the filled button is the
    // one a person reaches for.
    expect(auto.className).toContain("primary");
    expect(byHand.className).not.toContain("primary");
    expect(
      auto.compareDocumentPosition(byHand) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // And the header's own button is not also there: two buttons for one decision.
    expect(hasButton("Auto-load…")).toBe(false);
  });

  test("Auto-load scope… opens the importer page with the target already in hand", async () => {
    const { app, fake } = await openScope();

    click(button("Auto-load scope…"));
    await settle();

    expect(app.importerOpen).toBe(true);
    // The page, in place of Assets: its form is on screen and the empty state is not.
    expect(
      document.querySelector('input[aria-label="Program link"]'),
    ).not.toBeNull();
    expect(hasButton("Auto-load scope…")).toBe(false);
    // The target was not asked for again; the page reads the model, not the target.
    expect(app.viewTargetId).toBe("acme-corp");
    expect(fake.countOf("importerModel")).toBeGreaterThan(0);
    // Opening it starts nothing.
    expect(fake.countOf("startScopeImport")).toBe(0);
  });

  test("Add an entry by hand puts focus in the entry field", async () => {
    await openScope();
    const field = document.querySelector<HTMLInputElement>(
      'input[aria-label="Host, apex or address block"]',
    );
    if (field === null) throw new Error("no entry field on the Scope tab");
    expect(document.activeElement).not.toBe(field);

    click(button("Add an entry by hand"));

    // Not a flag set somewhere: the field it names, focused.
    expect(document.activeElement).toBe(field);
  });
});

describe("a Scope tab with entries", () => {
  test("the importer moves into the header as Auto-load…, and the empty state is gone", async () => {
    const { app } = await openScope("acme.test");

    expect(hasButton("Auto-load scope…")).toBe(false);
    expect(hasButton("Add an entry by hand")).toBe(false);

    click(button("Auto-load…"));
    await settle();
    expect(app.importerOpen).toBe(true);
    expect(
      document.querySelector('input[aria-label="Program link"]'),
    ).not.toBeNull();
  });
});

describe("the Auto-load page", () => {
  test("typing a link and pressing Start starts an import on this target and shows its panel", async () => {
    const { app, fake } = await openScope();
    click(button("Auto-load scope…"));
    await settle();

    const start = button("Start import");
    expect(start.disabled).toBe(true);

    const link = document.querySelector<HTMLInputElement>(
      'input[aria-label="Program link"]',
    );
    if (link === null) throw new Error("no link field");
    type(link, "https://hackerone.com/acme/policy");
    await settle();
    expect(button("Start import").disabled).toBe(false);

    click(button("Start import"));
    await settle();

    const started = fake.calls.find(
      (each) => each.method === "startScopeImport",
    );
    expect(started?.args[1]).toBe("acme-corp");
    expect(
      (started?.args[2] as { programLinks: string[] }).programLinks,
    ).toEqual(["https://hackerone.com/acme/policy"]);
    // The form became the panel it always handed over to.
    expect(app.importerPhase).toBe("importing");
    expect(
      document.querySelector('[aria-label="Loading the scope"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('input[aria-label="Program link"]'),
    ).toBeNull();
  });

  test("Back to Assets returns to the Scope tab and starts nothing", async () => {
    const { app, fake } = await openScope();
    click(button("Auto-load scope…"));
    await settle();

    click(button("Back to Assets"));
    await settle();

    expect(app.importerOpen).toBe(false);
    expect(hasButton("Auto-load scope…")).toBe(true);
    expect(fake.countOf("startScopeImport")).toBe(0);
  });
});
