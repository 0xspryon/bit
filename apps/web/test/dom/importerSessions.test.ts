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
import { click, mountInto, press, settle, type Mounted } from "./dom";

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

const harness = (instanceId: string, displayName: string) => ({
  instanceId,
  driver: "opencode" as const,
  displayName,
  version: "1.0.0",
  ready: true,
  auth: "authenticated" as const,
  isDefault: false,
  defaultModel: "m",
  models: [{ id: "m" }],
});

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
  // The harnesses the sessions above ran on are ones this server runs: a session from one it
  // does not is its own describe, below.
  fake.onHarnesses = () =>
    ok([
      harness("claude-code", "Claude Code"),
      harness("opencode", "OpenCode"),
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

  test("is there once the scope has entries, which is where a session that wrote anything leaves the target", async () => {
    // D1: "On a target that already has entries this strip is the only thing that changes;
    // the primary button moves into the Scope tab's header." A successful import writes
    // entries, entries remove the empty state, so a strip gated on the empty state could only
    // ever name a session that wrote nothing.
    await openScope(SESSIONS, ["acme.test"]);

    expect(document.querySelector(".scope-empty")).toBeNull();
    expect(strip()?.textContent?.replace(/\s+/g, " ")).toContain(
      "wrote 7 in · 3 out · 14 assets.",
    );
    // The primary button has moved to the header, and is the only door in beside the strip.
    expect(hasButton("Auto-load…")).toBe(true);
    expect(hasButton("Auto-load scope…")).toBe(false);
    // At the bottom, with the Add bar, rather than among the lists.
    const add = document.querySelector("form.add");
    const found = strip();
    if (add === null || found === null)
      throw new Error("no strip or no Add bar");
    expect(
      found.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("Continue works from a populated target, and the session it opens is the one named", async () => {
    const { app } = await openScope(SESSIONS, ["acme.test"]);

    click(button("Continue that session"));
    await settle();

    expect(app.importerOpen).toBe(true);
    expect(app.importer.currentId).toBe("ses_newest");
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

const composer = (): HTMLTextAreaElement => {
  const box = document.querySelector<HTMLTextAreaElement>("#importer-message");
  if (box === null) throw new Error("no composer");
  return box;
};

const typeInto = (box: HTMLTextAreaElement, value: string): void => {
  box.value = value;
  box.dispatchEvent(new Event("input", { bubbles: true }));
};

/** Continue the newest session of a server that lists `harnesses`, and wait for the page. */
const continueOn = async (
  sessions: ImporterSessionView[],
  harnesses: ReturnType<typeof harness>[] | "unreachable",
): Promise<{ app: App; fake: FakeServer }> => {
  const fake = new FakeServer();
  fake.onScope = () => ok(emptyScope());
  fake.onImporterSessions = () => ok({ sessions });
  fake.onHarnesses = () =>
    harnesses === "unreachable" ? unreachable("no route") : ok(harnesses);
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
  click(button("Continue that session"));
  await settle();
  return { app, fake };
};

describe("typing into a session the server lists", () => {
  test("the note that its words cannot be read stays above the first message", async () => {
    await continueOn(SESSIONS, [harness("claude-code", "Claude Code")]);
    expect(text()).toContain("does not read the session's messages");

    const box = composer();
    typeInto(box, "Also load the staging hosts");
    box.focus();
    press("Enter");
    await settle();

    // One message in, this still must not read as a brand-new session.
    expect(text()).toContain("Also load the staging hosts");
    expect(text()).toContain("does not read the session's messages");
  });

  test("a later reading of the index keeps what the operator typed and takes the server's figures", async () => {
    const { app, fake } = await continueOn(SESSIONS, [
      harness("claude-code", "Claude Code"),
    ]);
    const box = composer();
    typeInto(box, "Also load the staging hosts");
    box.focus();
    press("Enter");
    await settle();

    fake.onImporterSessions = () =>
      ok({
        sessions: [
          importerSessionView({
            sessionId: "ses_newest",
            harnessInstanceId: "claude-code",
            openedAt: 1_700_000_200_000,
            tally: { entriesIn: 9, entriesOut: 3, assets: 14 },
          }),
        ],
      });
    await app.loadImporterSessions("acme-corp");
    await settle();

    expect(text()).toContain("Also load the staging hosts");
    expect(app.importer.current?.id).toBe("ses_newest");
    expect(app.importer.current?.tally.in).toBe(9);
    expect(
      app.importer.sessions.filter((session) => session.id === "ses_newest"),
    ).toHaveLength(1);
  });

  test("a session the server stopped listing is kept while it holds the operator's words", async () => {
    const { app, fake } = await continueOn(SESSIONS, [
      harness("claude-code", "Claude Code"),
    ]);
    const box = composer();
    typeInto(box, "Also load the staging hosts");
    box.focus();
    press("Enter");
    await settle();

    fake.onImporterSessions = () => ok({ sessions: [] });
    await app.loadImporterSessions("acme-corp");
    await settle();

    expect(app.importer.currentId).toBe("ses_newest");
    expect(text()).toContain("Also load the staging hosts");
  });
});

describe("a session from a harness this server does not run", () => {
  const STRANDED = [
    importerSessionView({
      sessionId: "ses_gone",
      harnessInstanceId: "retired-harness",
      openedAt: 1_700_000_200_000,
    }),
  ];

  test("says so, and cannot be typed into", async () => {
    const { app, fake } = await continueOn(STRANDED, [
      harness("claude-code", "Claude Code"),
    ]);

    expect(app.importer.current?.strandedOn).toBe("retired-harness");
    expect(text()).toContain('ran on "retired-harness"');
    expect(composer().disabled).toBe(true);
    // The rule is in the model too, not only on the control.
    app.importer.draft = "hello";
    app.importer.send();
    expect(app.importer.current?.items).toEqual([]);
    expect(fake.countOf("startScopeImport")).toBe(0);
  });

  test("is not called gone before the harness listing has said what is here", async () => {
    const { app } = await continueOn(STRANDED, "unreachable");

    expect(app.harnessesLoaded).toBe(false);
    expect(app.importer.current?.strandedOn).toBeUndefined();
    expect(text()).not.toContain('ran on "retired-harness"');
    expect(composer().disabled).toBe(false);
  });

  test("a session whose harness this server runs is not stranded", async () => {
    const { app } = await continueOn(SESSIONS, [
      harness("claude-code", "Claude Code"),
    ]);
    expect(app.importer.current?.strandedOn).toBeUndefined();
    expect(composer().disabled).toBe(false);
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
