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
import TitleBar from "../../src/lib/components/TitleBar.svelte";
import Target from "../../src/lib/screens/Target.svelte";
import { FakeCountdown } from "../fakeCountdown";
import { FakeServer, emptyScope, importerSessionView, ok } from "../fakeServer";
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
    // The page, in place of Assets: its composer is on screen and the empty state is not.
    expect(document.querySelector("#importer-message")).not.toBeNull();
    expect(hasButton("Auto-load scope…")).toBe(false);
    // The target was not asked for again.
    expect(app.viewTargetId).toBe("acme-corp");
    // Opening it starts nothing.
    expect(fake.countOf("startScopeImport")).toBe(0);
  });

  test("D1 draws no Add bar under the empty state: the button is what opens it", async () => {
    await openScope();
    // Before this the bar was always there and the button could only focus a field already
    // on screen; D1 has the empty state and the strip, and nothing else.
    expect(document.querySelector("form.add")).toBeNull();
    expect(document.querySelector(field)).toBeNull();
    // The empty state is what the tab shows.
    expect(
      document.querySelector(".scope-empty .empty-lead")?.textContent?.trim(),
    ).toBe("No scope authored for this target");
  });

  test("Add an entry by hand opens the Add bar and puts focus in its field, in the one click", async () => {
    await openScope();

    click(button("Add an entry by hand"));

    // Not a flag set somewhere: the field it names, on screen and focused — with no settle
    // between, because the click that names it is the one that has to hand it over.
    const found = document.querySelector<HTMLInputElement>(field);
    if (found === null) throw new Error("the click did not open the Add bar");
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Host, apex or address block",
    );
    // The empty state stays: the scope is still empty until something is added.
    expect(hasButton("Auto-load scope…")).toBe(true);
  });

  test("the strip spans the column alone, and takes the Add bar's width once the bar is there", async () => {
    const fake = new FakeServer();
    fake.onScope = () => ok(emptyScope({ entries: [] }));
    fake.onImporterSessions = () => ok({ sessions: [importerSessionView()] });
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

    const strip = (): string =>
      document.querySelector('[aria-label="Last importer session"]')
        ?.className ?? "no strip";
    expect(strip()).toContain("wide");
    click(button("Add an entry by hand"));
    expect(strip()).not.toContain("wide");
    expect(strip()).toContain("last-session");
  });

  test("what the operator started typing is not taken away when the last entry goes", async () => {
    // The bar is hidden on an empty scope only while it holds nothing: deleting the last
    // entry with a half-typed one in the field must not swallow it.
    const { app } = await openScope();
    expect(document.querySelector("form.add")).toBeNull();
    app.entryValue = "api.acme.test";
    await settle();
    expect(document.querySelector<HTMLInputElement>(field)?.value ?? "").toBe(
      "api.acme.test",
    );
  });
});

/** The Add bar's value field, by its accessible name. */
const field = 'input[aria-label="Host, apex or address block"]';

describe("a Scope tab with entries", () => {
  test("the importer moves into the header as Auto-load…, and the empty state is gone", async () => {
    const { app } = await openScope("acme.test");

    expect(hasButton("Auto-load scope…")).toBe(false);
    expect(hasButton("Add an entry by hand")).toBe(false);
    // With entries the Add bar is simply there, as it always was.
    expect(document.querySelector(field)).not.toBeNull();

    click(button("Auto-load…"));
    await settle();
    expect(app.importerOpen).toBe(true);
    expect(document.querySelector("#importer-message")).not.toBeNull();
  });
});

describe("the Auto-load page", () => {
  test("the page has no header of its own: A6 puts the way back in the crumb bar, as 'Assets'", async () => {
    const { app } = await openScope();
    click(button("Auto-load scope…"));
    await settle();

    expect(hasButton("Back to Assets")).toBe(false);
    expect(document.querySelector("h1")).toBeNull();
    // The bar is mounted beside the page; the rail is up, and the crumb is there anyway.
    const bar = mountInto(TitleBar, { app });
    await settle();
    expect(app.drawerHidden).toBe(false);
    expect(document.querySelector(".crumb-leaf")?.textContent?.trim()).toBe(
      "Auto-load",
    );
    bar.destroy();
  });

  test("the Assets crumb returns to the Scope tab and starts nothing", async () => {
    const { app, fake } = await openScope();
    click(button("Auto-load scope…"));
    await settle();
    const bar = mountInto(TitleBar, { app });
    await settle();

    click(button("Assets"));
    await settle();
    const option = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '[aria-label="Switch section"] button.option',
      ),
    ].find((each) => each.textContent?.includes("Assets"));
    if (option === undefined) throw new Error("no Assets in the section list");
    click(option);
    await settle();
    bar.destroy();

    expect(app.importerOpen).toBe(false);
    expect(hasButton("Auto-load scope…")).toBe(true);
    expect(fake.countOf("startScopeImport")).toBe(0);
  });
});
