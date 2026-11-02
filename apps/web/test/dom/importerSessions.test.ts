/**
 * The importer's session index on the screens that read it: the Assets screen's "last
 * session" strip (A6 D1) and the crumb bar's session list (A6 D5).
 *
 * `importerChat.test.ts` owns the sentences against plain data. What it cannot see is that
 * the strip is *there*, under the empty state and nowhere else; that it names the newest
 * session rather than any session; that "Continue that session" puts that session on screen;
 * and that the list in the crumb bar is the server's, not the declared one. Those are the
 * claims here, and each is driven through `Target` and `TitleBar` the way a person reaches
 * it: open the target, go to Assets, click.
 *
 * Nothing here prompts a session. That is a later slice, and the first assertion about
 * Continue is that it sends nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";

import type { ImporterSessionView, ScopeEntryView } from "@bit/contracts";

import { App, scenarios } from "../../src/lib/app.svelte";
import TitleBar from "../../src/lib/components/TitleBar.svelte";
import Target from "../../src/lib/screens/Target.svelte";
import { FakeCountdown } from "../fakeCountdown";
import {
  FakeServer,
  emptyScope,
  importerSessionView,
  ok,
  unreachable,
} from "../fakeServer";
import { click, mountInto, settle, type Mounted } from "./dom";

let mounted: Mounted[] = [];
afterEach(() => {
  for (const each of mounted) each.destroy();
  mounted = [];
});

const entry = (value: string): ScopeEntryView => ({
  entryId: `ent_${value}`,
  effect: "in",
  kind: "subtree",
  value,
  source: "operator",
  note: null,
  createdAt: 1,
});

const text = (): string =>
  (document.body.textContent ?? "").replace(/\s+/g, " ");

const button = (label: string): HTMLButtonElement => {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((each) =>
    each.textContent?.replace(/\s+/g, " ").trim().startsWith(label),
  );
  if (found === undefined) throw new Error(`no "${label}" button`);
  return found;
};

const hasButton = (label: string): boolean =>
  [...document.querySelectorAll("button")].some((each) =>
    each.textContent?.replace(/\s+/g, " ").trim().startsWith(label),
  );

const strip = (): Element | null =>
  document.querySelector('[aria-label="Last importer session"]');

/** The newest session, then an older one: the shape the route answers in. */
const SESSIONS: ImporterSessionView[] = [
  importerSessionView({
    sessionId: "ses_newest",
    model: "anthropic/claude-newest",
    harnessInstanceId: "claude-code",
    openedAt: 1_700_000_200_000,
    tally: { entriesIn: 7, entriesOut: 3, assets: 14 },
  }),
  importerSessionView({
    sessionId: "ses_older",
    model: "openai/gpt-older",
    openedAt: 1_700_000_100_000,
  }),
];

/**
 * The open target's Scope tab, the title bar beside it, and what the server lists.
 *
 * `sessions` is what `importer-sessions` answers; `entries` is the scope, so a test can put
 * the strip's empty-state host in or out.
 */
const openScope = async (
  sessions: ImporterSessionView[],
  entries: string[] = [],
): Promise<{ app: App; fake: FakeServer }> => {
  const fake = new FakeServer();
  fake.onScope = () => ok(emptyScope({ entries: entries.map(entry) }));
  fake.onImporterSessions = () => ok({ sessions });
  const app = new App(fake, new FakeCountdown());
  app.password = "correct-horse";
  await app.connect();
  app.openTarget("acme-corp");
  await settle();
  app.toSection("assets");
  await settle();
  app.toAssetsTab("scope");
  await settle();
  mounted.push(mountInto(TitleBar, { app }), mountInto(Target, { app }));
  await settle();
  return { app, fake };
};

describe("the last-session strip", () => {
  test("names the newest session by what it wrote, under the empty state", async () => {
    await openScope(SESSIONS);

    const found = strip();
    expect(found).not.toBeNull();
    const said = found?.textContent?.replace(/\s+/g, " ") ?? "";
    expect(said).toContain("Last importer session");
    // The newest one's tally, not the older one's "wrote nothing".
    expect(said).toContain("wrote 7 in · 3 out · 14 assets.");
    expect(said).not.toContain("ended without");
    // Under the empty state and above the form, which is where D1 draws it.
    const empty = document.querySelector(".scope-empty");
    expect(
      empty !== null &&
        found !== null &&
        empty.compareDocumentPosition(found) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("says a session that wrote nothing ended without writing anything", async () => {
    await openScope([SESSIONS[1] as ImporterSessionView]);
    expect(strip()?.textContent?.replace(/\s+/g, " ")).toContain(
      "ended without writing anything.",
    );
  });

  test("says a session that is still running is running, not that it ended", async () => {
    await openScope([importerSessionView({ running: true })]);
    const said = strip()?.textContent?.replace(/\s+/g, " ") ?? "";
    expect(said).toContain("is still running.");
    expect(said).not.toContain("ended without");
  });

  test("is not there when the target has never had a session", async () => {
    await openScope([]);
    expect(strip()).toBeNull();
    // The empty state itself is untouched.
    expect(hasButton("Auto-load scope…")).toBe(true);
  });

  test("is not there once the scope has entries: D1 draws it under the empty state", async () => {
    await openScope(SESSIONS, ["acme.test"]);
    expect(strip()).toBeNull();
  });

  test("a failed read of the index leaves the empty state exactly as it was", async () => {
    const fake = new FakeServer();
    fake.onImporterSessions = () => unreachable("no route");
    const app = new App(fake, new FakeCountdown());
    app.password = "correct-horse";
    await app.connect();
    app.openTarget("acme-corp");
    await settle();
    app.toSection("assets");
    await settle();
    app.toAssetsTab("scope");
    await settle();
    mounted.push(mountInto(Target, { app }));
    await settle();

    expect(strip()).toBeNull();
    expect(hasButton("Auto-load scope…")).toBe(true);
  });
});

describe("Continue that session", () => {
  test("opens the importer on that session and prompts nothing", async () => {
    const { app, fake } = await openScope(SESSIONS);

    click(button("Continue that session"));
    await settle();

    expect(app.importerOpen).toBe(true);
    // The newest, selected: the one the strip named.
    expect(app.importer.currentId).toBe("ses_newest");
    expect(app.importer.current?.indexed).toBe(true);
    expect(document.querySelector("#importer-message")).not.toBeNull();
    // It is read-only until the operator types, and says why there is no conversation.
    expect(text()).toContain("You are reading an earlier session");
    expect(text()).toContain("does not read the session's messages");
    // Selecting a session is not starting or prompting one.
    expect(fake.countOf("startScopeImport")).toBe(0);
  });

  test("the crumb names the session it opened, and lists the server's sessions with their tallies", async () => {
    const { app } = await openScope(SESSIONS);
    click(button("Continue that session"));
    await settle();

    app.importer.pickerOpen = true;
    await settle();
    const rows = [
      ...document.querySelectorAll(
        '[role="dialog"][aria-label="Importer sessions"] button.option',
      ),
    ];
    const said = rows.map((row) => row.textContent?.replace(/\s+/g, " ") ?? "");

    // The server's two, newest first, and nothing declared: no mock model is in the list.
    expect(said).toHaveLength(2);
    expect(said[0]).toContain("anthropic/claude-newest");
    expect(said[0]).toContain("7 in · 3 out · 14 assets");
    expect(said[1]).toContain("openai/gpt-older");
    expect(said[1]).toContain("nothing written");
    expect(said.join(" ")).not.toContain("anthropic/claude-code");
    // No message count is printed for a session whose messages this page cannot count.
    expect(said.join(" ")).not.toContain("message");
    expect(rows[0]?.getAttribute("aria-current")).toBe("true");
  });

  test("opening the importer without continuing starts on an empty session beside the server's", async () => {
    const { app } = await openScope(SESSIONS);

    click(button("Auto-load scope…"));
    await settle();

    expect(app.importer.current?.tally.messages).toBe(0);
    expect(app.importer.current?.indexed).toBeUndefined();
    expect(app.importer.listed.map((session) => session.id)).toEqual([
      "ses_newest",
      "ses_older",
    ]);
  });

  test("the harness is named once the listing arrives, not left as an instance id", async () => {
    const fake = new FakeServer();
    fake.onScope = () => ok(emptyScope());
    fake.onImporterSessions = () => ok({ sessions: SESSIONS });
    fake.onHarnesses = () =>
      ok([
        {
          instanceId: "claude-code",
          driver: "claude_code",
          displayName: "Claude Code",
          version: "2.1.310",
          ready: true,
          auth: "authenticated",
          isDefault: false,
          defaultModel: "claude-sonnet-5",
          models: [{ id: "claude-sonnet-5" }],
        },
      ]);
    const app = new App(fake, new FakeCountdown());
    app.password = "correct-horse";
    await app.connect();
    app.openTarget("acme-corp");
    await settle();
    app.toSection("assets");
    await settle();
    app.toAssetsTab("scope");
    await settle();
    mounted.push(mountInto(Target, { app }));
    await settle();

    click(button("Continue that session"));
    await settle();

    expect(app.importer.current?.harness).toBe("Claude Code");
  });
});

describe("the nine importer states are still the declared ones", () => {
  test("the state picker's list is its own, and the server is never asked", async () => {
    const fake = new FakeServer();
    const app = new App(fake, new FakeCountdown());
    const scenario = scenarios.find((each) => each.id === "importer-picker");
    scenario?.apply(app);
    mounted.push(mountInto(TitleBar, { app }), mountInto(Target, { app }));
    await settle();

    expect(app.importer.listed).toHaveLength(3);
    expect(
      app.importer.listed.every((session) => session.indexed !== true),
    ).toBe(true);
    expect(fake.countOf("importerSessions")).toBe(0);
  });

  test("the strip has a scenario of its own, and Continue works on its declared index", async () => {
    const fake = new FakeServer();
    // A scenario has no server to ask, so the read it triggers on Continue finds none and
    // must leave the declared index where it is.
    fake.onImporterSessions = () => unreachable("no server in a scenario");
    const app = new App(fake, new FakeCountdown());
    scenarios.find((each) => each.id === "importer-strip")?.apply(app);
    mounted.push(mountInto(TitleBar, { app }), mountInto(Target, { app }));
    await settle();

    expect(strip()?.textContent?.replace(/\s+/g, " ")).toContain(
      "ended without writing anything.",
    );
    click(button("Continue that session"));
    await settle();
    expect(app.importer.currentId).toBe("ses_indexed_quiet");
  });
});
