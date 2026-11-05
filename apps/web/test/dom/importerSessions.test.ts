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
 * Continuing a session sends nothing by itself — the first assertion about Continue is that
 * — and typing into it posts to the session's import (the importer conversation design,
 * S3): the last describes here are the composer against a fake server that answers as the
 * real one does.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  ConversationStopRefused,
  ImporterConversationRefused,
  ImporterModelUnavailable,
  type ImporterSessionView,
  type ScopeEntryView,
} from "@bit/contracts";

import { App, IMPORT_POLL_MS, scenarios } from "../../src/lib/app.svelte";
import TitleBar from "../../src/lib/components/TitleBar.svelte";
import { PARTIAL_BODY_MAX, REPLY_PAST_CAP_LABEL } from "../../src/lib/chat";
import {
  ENDED_NOTE,
  MID_BLOCK_NOTE,
  sendNowButtonTitle,
  sendingNowNote,
  sentNowTitle,
  sessionWhen,
} from "../../src/lib/importerChat";
import Target from "../../src/lib/screens/Target.svelte";
import { FakeCountdown } from "../fakeCountdown";
import {
  FakeServer,
  emptyScope,
  importerConversationView,
  importerSessionView,
  importerTurnAccepted,
  liveActivity,
  liveOpened,
  ok,
  refused,
  replayItem,
  scopeImportView,
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

const harness = (
  instanceId: string,
  displayName: string,
  driver: string = "opencode",
) => ({
  instanceId,
  driver,
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
    importId: "imp_newest",
    model: "anthropic/claude-newest",
    harnessInstanceId: "claude-code",
    openedAt: 1_700_000_200_000,
    tally: { entriesIn: 7, entriesOut: 3, assets: 14 },
  }),
  importerSessionView({
    sessionId: "ses_older",
    importId: "imp_older",
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
    // Across the column, as D1 draws it under the empty state: there is no list or Add bar
    // there for it to keep the 760px reading width of.
    expect(found?.className ?? "").toContain("wide");
    // Under the empty state, which is where D1 draws it.
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
    // Beside entries it keeps the width of the lists and the Add bar it sits between.
    expect(strip()?.className ?? "").not.toContain("wide");
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
    // It is the target's newest session, so not an "earlier" one (U8); the server let it go
    // (`resume`), so the page says what the next message does.
    expect(text()).not.toContain("earlier session");
    expect(text()).toContain(
      "This session is no longer held by the server. Your next message takes it back over",
    );
    // And its words are on screen, read back from the harness (S6): the operator's own
    // message as the heading of the turn it opened, and the importer's reply under it.
    expect(text()).toContain("Read the policy page");
    expect(text()).toContain("Two entries in, one out.");
    expect(text()).toContain("From the harness, which may delete it.");
    // Selecting a session is not reading it twice.
    expect(fake.countOf("importerMessages")).toBe(1);
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

  test("D5's rows: the harness's name and the model it ended on, then what it wrote and when (U8)", async () => {
    const titled = [
      importerSessionView({
        ...SESSIONS[0],
        title: "Full policy sweep",
      }),
      // A name an agent wrote, with markup and a bidi override in it: a plain label.
      importerSessionView({
        ...SESSIONS[1],
        title: "<b>Pass</b> \u202Eevil",
      }),
    ];
    const { app } = await openScope(titled);
    click(button("Continue that session"));
    await settle();
    app.importer.pickerOpen = true;
    await settle();
    const rows = [
      ...document.querySelectorAll<HTMLElement>(
        '[role="dialog"][aria-label="Importer sessions"] button.option',
      ),
    ];
    const lines = (row: HTMLElement | undefined) =>
      [...(row?.querySelectorAll(".session-line") ?? [])].map((line) =>
        [...line.children].map((part) => part.textContent?.trim() ?? ""),
      );
    expect(lines(rows[0])).toEqual([
      ["Full policy sweep", "anthropic/claude-newest"],
      ["7 in · 3 out · 14 assets", sessionWhen(1_700_000_200_000, Date.now())],
    ]);
    expect(rows[0]?.getAttribute("title")).toBe(
      `\u2068Full policy sweep\u2069 · started ${sessionWhen(1_700_000_200_000, Date.now())}`,
    );
    // Escaped text, never markup: no element was made of the title.
    const name = rows[1]?.querySelector(".session-name");
    expect(name?.textContent).toBe("<b>Pass</b> \u202Eevil");
    expect(name?.querySelector("b")).toBeNull();
    // The crumb names the session on screen by its title, with the date on hover.
    const crumb = document.querySelector(".crumb-session");
    expect(crumb?.textContent?.trim()).toBe("Full policy sweep");
    expect(crumb?.getAttribute("title")).toContain("started");
  });

  test("an older session opened from the picker is an earlier one, read-only until typed into (U8)", async () => {
    const { app } = await openScope(SESSIONS);
    click(button("Continue that session"));
    await settle();
    app.importer.open("ses_older");
    await settle();
    expect(text()).toContain("You are reading an earlier session");
    expect(composer().disabled).toBe(false);
    expect(app.importer.current?.reading).toBe(true);
  });

  test("a reload of the newest session while it runs: never an earlier one (U8, found in U5's live runs)", async () => {
    const running = SESSIONS.map((each, index) =>
      index === 0 ? { ...each, running: true } : each,
    );
    const { app, fake } = await openScope(running);
    fake.onImporterActivity = (_baseUrl, _targetId, importId) =>
      ok({ conversationId: importId, turn: "running", background: false });
    fake.onImporterMessages = () =>
      ok(importerConversationView({ continuation: "live", live: true }));
    app.openImporter("ses_newest");
    await settle();
    expect(app.importer.current?.working).toBe(true);
    expect(text()).not.toContain("earlier session");
    // Even an older session, while it runs, is not called earlier.
    fake.onImporterMessages = () =>
      ok(importerConversationView({ continuation: "live", live: true }));
    app.importer.open("ses_older");
    await settle();
    expect(app.importer.current?.working).toBe(true);
    expect(text()).not.toContain("earlier session");
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

/** The sentence the page sets above the thread, which is `Chat`'s first note. */
const notice = (): string =>
  document.querySelector(".importer .note")?.textContent?.trim() ?? "";

const typeInto = (box: HTMLTextAreaElement, value: string): void => {
  box.value = value;
  box.dispatchEvent(new Event("input", { bubbles: true }));
};

/**
 * Continue the newest session of a server a test has already set up, and wait for the page.
 *
 * {@link continueOn}'s tail, split out for the describes whose subject is the *replay*: they
 * have to answer `importerMessages` themselves, so they build the server rather than being
 * handed one.
 */
const continueWith = async (fake: FakeServer): Promise<App> => {
  fake.onScope = () => ok(emptyScope());
  fake.onImporterSessions = () => ok({ sessions: SESSIONS });
  fake.onHarnesses = () => ok([harness("claude-code", "Claude Code")]);
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
  return app;
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
  // As the server answers a live session: the same import, the same harness session.
  fake.onSendImporterMessage = (_baseUrl, targetId, importId) => {
    const listed = sessions.find((each) => each.importId === importId);
    return ok(
      importerTurnAccepted({
        targetId,
        importId,
        harnessSessionId: listed?.sessionId ?? "ses_unknown",
        harnessInstanceId: listed?.harnessInstanceId ?? "opencode",
        model: listed?.model ?? "m",
      }),
    );
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
  mounted.push(mountInto(TitleBar, { app }), mountInto(Target, { app }));
  await settle();
  click(button("Continue that session"));
  await settle();
  return { app, fake };
};

describe("typing into a session the server lists", () => {
  test("the replayed thread stays above the message typed under it, and nothing is shown twice", async () => {
    const { fake } = await continueOn(SESSIONS, [
      harness("claude-code", "Claude Code"),
    ]);
    expect(text()).toContain("Read the policy page");

    const box = composer();
    typeInto(box, "Also load the staging hosts");
    box.focus();
    press("Enter");
    await settle();

    // One message in, the thread above it is still there: this is a continuation and reads
    // as one, which is what the stand-in note used to have to say in words.
    const after = text();
    expect(after).toContain("Read the policy page");
    expect(after).toContain("Also load the staging hosts");
    // Once, each. The replay is read when the session is opened and never again, which is
    // what keeps the operator's own row from colliding with the `user` entry the harness
    // holds for the same sentence.
    expect(after.indexOf("Read the policy page")).toBe(
      after.lastIndexOf("Read the policy page"),
    );
    expect(fake.countOf("importerMessages")).toBe(1);
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

/** The arguments of every call one method was given, oldest first. */
const argsOf = (
  fake: FakeServer,
  method: "sendImporterMessage" | "openImporterConversation",
) =>
  fake.calls.filter((call) => call.method === method).map((call) => call.args);

describe("the composer posts to the server", () => {
  const send = async (value: string): Promise<void> => {
    const box = composer();
    typeInto(box, value);
    box.focus();
    press("Enter");
    await settle();
  };

  test("a listed session's message goes to its import, and the box clears on acceptance", async () => {
    const { app, fake } = await continueOn(SESSIONS, [
      harness("claude-code", "Claude Code"),
    ]);
    await send("Also load the staging hosts");

    expect(fake.countOf("sendImporterMessage")).toBe(1);
    expect(fake.countOf("openImporterConversation")).toBe(0);
    const [, targetId, importId, text] =
      argsOf(fake, "sendImporterMessage")[0] ?? [];
    expect([targetId, importId, text]).toEqual([
      "acme-corp",
      "imp_newest",
      "Also load the staging hosts",
    ]);
    expect(composer().value).toBe("");
    expect(app.importer.current?.id).toBe("ses_newest");
    // The session list is read again, so the server's figures follow the turn.
    expect(fake.countOf("importerSessions")).toBeGreaterThan(1);
  });

  test("a refusal keeps the words in the box and prints the server's sentence", async () => {
    const { fake } = await continueOn(SESSIONS, [
      harness("claude-code", "Claude Code"),
    ]);
    fake.onSendImporterMessage = () =>
      refused(
        new ImporterConversationRefused({
          reason: "harness_unreachable",
          detail: "the harness would not take the message",
        }),
      );
    await send("Also load the staging hosts");

    expect(composer().value).toBe("Also load the staging hosts");
    expect(text()).toContain("the harness would not take the message");
  });

  test("the empty session's first message opens a conversation, with no links", async () => {
    const { app, fake } = await continueOn(SESSIONS, [
      harness("claude-code", "Claude Code"),
    ]);
    app.importer.start();
    await settle();
    fake.onOpenImporterConversation = (_baseUrl, targetId) =>
      ok(
        importerTurnAccepted({
          targetId,
          importId: "imp_opened",
          harnessSessionId: "ses_opened",
          conversation: "opened",
          note: "A new importer session was opened for this message.",
        }),
      );
    await send("Read https://hackerone.com/acme/policy");

    expect(fake.countOf("openImporterConversation")).toBe(1);
    expect(fake.countOf("sendImporterMessage")).toBe(0);
    const draft = argsOf(fake, "openImporterConversation")[0]?.[2];
    expect(draft).toEqual({ text: "Read https://hackerone.com/acme/policy" });
    // The page's empty session became the server's, under its id and import.
    expect(app.importer.current?.id).toBe("ses_opened");
    expect(app.importer.current?.importId).toBe("imp_opened");
    expect(text()).toContain("A new importer session was opened");
  });

  /** Answers the empty session's first message as the server does, held until released. */
  const holdOpening = (fake: FakeServer): (() => void) => {
    fake.onOpenImporterConversation = (_baseUrl, targetId) =>
      ok(
        importerTurnAccepted({
          targetId,
          importId: "imp_opened",
          harnessSessionId: "ses_opened",
          conversation: "opened",
        }),
      );
    return fake.hold("openImporterConversation");
  };

  const startNewSession = async (app: App): Promise<void> => {
    app.importer.pickerOpen = true;
    await settle();
    click(button("Start a new session"));
    await settle();
  };

  test("Start a new session never lands on the empty session whose first message is out (U8 review)", async () => {
    const { app, fake } = await continueOn(SESSIONS, [
      harness("claude-code", "Claude Code"),
    ]);
    app.importer.start();
    await settle();
    const opening = app.importer.currentId;
    const release = holdOpening(fake);
    await send("Read https://hackerone.com/acme/policy");
    expect(app.importer.sending).toBe(true);
    // While the server opens the harness, the operator looks at another session…
    app.importer.open("ses_older");
    await settle();
    // …and then asks for a new one: an empty thread, not the conversation being opened.
    await startNewSession(app);
    const fresh = app.importer.currentId;
    expect(fresh).not.toBe(opening);
    expect(fresh).not.toBe("ses_older");
    expect(app.importer.current?.tally.messages).toBe(0);
    release();
    await settle();
    // The answer lands on the session it opened, and leaves the operator where they are.
    expect(app.importer.currentId).toBe(fresh);
    expect(app.importer.becameId).toBeUndefined();
    expect(app.importer.sessions.some((each) => each.id === "ses_opened")).toBe(
      true,
    );
  });

  test("Start a new session from the first message still on its way opens a fresh empty one (U8 review)", async () => {
    const { app, fake } = await continueOn(SESSIONS, [
      harness("claude-code", "Claude Code"),
    ]);
    app.importer.start();
    await settle();
    const opening = app.importer.currentId;
    const release = holdOpening(fake);
    await send("Read https://hackerone.com/acme/policy");
    expect(app.importer.sending).toBe(true);
    await startNewSession(app);
    const fresh = app.importer.currentId;
    expect(fresh).not.toBe(opening);
    expect(app.importer.current?.tally.messages).toBe(0);
    // The words on their way are that message's, not a draft for the new thread.
    expect(composer().value).toBe("");
    release();
    await settle();
    expect(app.importer.currentId).toBe(fresh);
    expect(app.importer.becameId).toBeUndefined();
    // A second ask, once nothing is out, is the empty one on screen again: not a third.
    await startNewSession(app);
    expect(app.importer.currentId).toBe(fresh);
  });

  /** The first message sent and held, then "Start a new session" while it is out. */
  const sendThenStart = async (): Promise<{
    app: App;
    fake: FakeServer;
    release: () => void;
    fresh: string;
  }> => {
    const { app, fake } = await continueOn(SESSIONS, [
      harness("claude-code", "Claude Code"),
    ]);
    app.importer.start();
    await settle();
    const release = holdOpening(fake);
    await send("Read https://hackerone.com/acme/policy");
    expect(app.importer.sending).toBe(true);
    await startNewSession(app);
    expect(composer().value).toBe("");
    return { app, fake, release, fresh: app.importer.currentId };
  };

  test("a first message refused after Start a new session comes back in the new thread's box, with why (U8 review 3)", async () => {
    const { app, fake, release, fresh } = await sendThenStart();
    fake.onOpenImporterConversation = () => unreachable("no route");
    release();
    await settle();

    expect(app.importer.currentId).toBe(fresh);
    expect(composer().value).toBe("Read https://hackerone.com/acme/policy");
    expect(text()).toContain("Your last message was not sent");
    expect(text()).toContain("No server answered at this address.");
  });

  test("…and once the new thread has words of its own, they stay, and the refused ones wait on their session (U8 review 3)", async () => {
    const { app, fake, release, fresh } = await sendThenStart();
    typeInto(composer(), "Something else entirely");
    await settle();
    fake.onOpenImporterConversation = () => unreachable("no route");
    release();
    await settle();

    expect(app.importer.currentId).toBe(fresh);
    expect(composer().value).toBe("Something else entirely");
    expect(text()).toContain("kept on “Not sent” in the session list");
    // Not the refusal itself: that would read as being about the draft beneath it.
    expect(text()).not.toContain("No server answered at this address.");
    app.importer.pickerOpen = true;
    await settle();
    // Nothing was opened on any model, so the row names none.
    expect(button("Not sent").querySelector(".session-model")).toBeNull();
    click(button("Not sent"));
    await settle();
    expect(composer().value).toBe("Read https://hackerone.com/acme/policy");
    expect(text()).toContain("No server answered at this address.");
    // Given back, it is the empty thread again, and the list no longer offers it.
    app.importer.pickerOpen = true;
    await settle();
    expect(hasButton("Not sent")).toBe(false);
  });

  test("a first message accepted after Start a new session says nothing on the new thread (U8 review 3)", async () => {
    const { app, fake, release, fresh } = await sendThenStart();
    fake.onOpenImporterConversation = (_baseUrl, targetId) =>
      ok(
        importerTurnAccepted({
          targetId,
          importId: "imp_opened",
          harnessSessionId: "ses_opened",
          conversation: "opened",
          note: "A new importer session was opened for this message.",
          pagesAdded: ["https://hackerone.com/acme/policy"],
        }),
      );
    release();
    await settle();

    expect(app.importer.currentId).toBe(fresh);
    expect(text()).not.toContain("A new importer session was opened");
    expect(text()).not.toContain("Added as a page this import may cite");
    // The answer landed on the session it opened, not on the one on screen.
    expect(app.importer.sessions.some((each) => each.id === "ses_opened")).toBe(
      true,
    );
  });

  test("a session the operator ended cannot be typed into, and says why", async () => {
    const { app, fake } = await continueOn(
      [
        importerSessionView({
          sessionId: "ses_ended",
          importId: "imp_ended",
          harnessInstanceId: "claude-code",
          endedAt: 1_700_000_300_000,
          endedReason: "operator",
        }),
      ],
      [harness("claude-code", "Claude Code")],
    );
    expect(app.importer.current?.ended).toBe(true);
    expect(composer().disabled).toBe(true);
    expect(text()).toContain("This session was ended");
    app.importer.draft = "hello";
    app.importer.send();
    await settle();
    expect(fake.countOf("sendImporterMessage")).toBe(0);
  });

  test("a session the server let go of is not disabled: a message to it is the server's to reopen", async () => {
    await continueOn(
      [
        importerSessionView({
          sessionId: "ses_shut",
          importId: "imp_shut",
          harnessInstanceId: "claude-code",
          endedAt: 1_700_000_300_000,
          endedReason: "shutdown",
        }),
      ],
      [harness("claude-code", "Claude Code")],
    );
    expect(composer().disabled).toBe(false);
  });

  test("no harness on the server disables it, in the server's words", async () => {
    const fake = new FakeServer();
    fake.onScope = () => ok(emptyScope());
    fake.onImporterModel = () =>
      refused(
        new ImporterModelUnavailable({
          reason: "no_harness",
          detail: "no agent harness on this server is ready",
        }),
      );
    const app = new App(fake, new FakeCountdown());
    app.password = "correct-horse";
    await app.connect();
    app.openTarget("acme-corp");
    await settle();
    app.toSection("assets");
    await settle();
    app.openImporter();
    await settle();
    mounted.push(mountInto(Target, { app }));
    await settle();

    expect(composer().disabled).toBe(true);
    expect(text()).toContain("no agent harness on this server is ready");
    expect(composer().placeholder).toContain("No agent harness");
  });

  test("a lookup no server answered is not called 'no harness'", async () => {
    const fake = new FakeServer();
    fake.onScope = () => ok(emptyScope());
    fake.onImporterModel = () => unreachable("no route");
    const app = new App(fake, new FakeCountdown());
    app.password = "correct-horse";
    await app.connect();
    app.openTarget("acme-corp");
    await settle();
    app.toSection("assets");
    await settle();
    app.openImporter();
    await settle();
    mounted.push(mountInto(Target, { app }));
    await settle();

    expect(composer().disabled).toBe(true);
    expect(text()).toContain("No server answered at this address.");
    // The placeholder says what happened, not a claim about harnesses nobody was asked.
    expect(composer().placeholder).not.toContain("No agent harness");
    expect(composer().placeholder).toContain("could not be asked");
  });

  test("an import_ended refusal reads the list again, and the composer then disables", async () => {
    const live = importerSessionView({
      sessionId: "ses_newest",
      importId: "imp_newest",
      harnessInstanceId: "claude-code",
    });
    const { fake } = await continueOn(
      [live],
      [harness("claude-code", "Claude Code")],
    );
    // Ended elsewhere since the list was read: the server refuses, and its row now says so.
    fake.onSendImporterMessage = () =>
      refused(
        new ImporterConversationRefused({
          reason: "import_ended",
          detail: "import imp_newest was ended by the operator",
        }),
      );
    fake.onImporterSessions = () =>
      ok({
        sessions: [
          {
            ...live,
            endedAt: 1_700_000_300_000,
            endedReason: "operator",
          },
        ],
      });
    const before = fake.countOf("importerSessions");
    await send("One more thing");

    expect(fake.countOf("importerSessions")).toBeGreaterThan(before);
    expect(composer().disabled).toBe(true);
    expect(text()).toContain("was ended by the operator");
  });

  test("an accepted message names the pages it made citable, and those it could not", async () => {
    const { fake } = await continueOn(SESSIONS, [
      harness("claude-code", "Claude Code"),
    ]);
    fake.onSendImporterMessage = (_baseUrl, targetId, importId) =>
      ok(
        importerTurnAccepted({
          targetId,
          importId,
          harnessSessionId: "ses_newest",
          pagesAdded: ["https://hackerone.com/acme/scope-update"],
          pagesNotAdded: ["https://hackerone.com/acme/ninth"],
        }),
      );
    await send("https://hackerone.com/acme/scope-update");

    expect(text()).toContain(
      "Added as a page this import may cite: https://hackerone.com/acme/scope-update.",
    );
    expect(text()).toContain("Not added");
    expect(text()).toContain("https://hackerone.com/acme/ninth");
  });
});

/**
 * What the importer says, live (the importer conversation design, S4).
 *
 * The server publishes the importer's narration on the target's live feed with `importId`
 * set, and the chat files it under the session whose import that is. Driven through the
 * real composer against a fake server: the message is posted, then frames arrive on the
 * feed exactly as the SSE route would deliver them.
 */
describe("the importer's words, as they are produced", () => {
  const send = async (value: string): Promise<void> => {
    const box = composer();
    typeInto(box, value);
    box.focus();
    press("Enter");
    await settle();
  };

  const said = (
    over: Partial<Parameters<typeof liveActivity>[0]> & { id: string },
  ) =>
    liveActivity({
      attemptId: null,
      importId: "imp_newest",
      kind: "turn.reply",
      headline: "Reply",
      outcome: null,
      ...over,
    });

  const cursor = (): Element | null =>
    document.querySelector(".importer .streaming .stream-cursor");

  test("a reply and a thought reach the chat under the message, and the cursor runs until the turn is over", async () => {
    const { app, fake } = await continueOn(SESSIONS, [
      harness("claude-code", "Claude Code"),
    ]);
    fake.watch.send(liveOpened({ from: 0, latest: 0 }));
    // Somebody else's agent on the same target: not the importer's, so not in its chat.
    fake.watch.send(
      liveActivity({
        id: "activity:1",
        attemptId: null,
        goalId: "goal_1",
        kind: "turn.reply",
        body: "the goal agent, talking",
      }),
    );
    await settle();
    // The turn is in flight from acceptance until the server says otherwise, and the
    // server says so in both places: the import's progress and the session list.
    const running = (yes: boolean) => {
      fake.onScopeImport = (_baseUrl, targetId, importId) =>
        ok(
          scopeImportView({
            targetId,
            importId,
            status: yes ? "running" : "finished",
          }),
        );
      fake.onImporterSessions = () =>
        ok({
          sessions: SESSIONS.map((each) =>
            each.importId === "imp_newest" ? { ...each, running: yes } : each,
          ),
        });
    };
    running(true);
    await send("Also load the staging hosts");
    expect(cursor()).not.toBeNull();

    fake.watch.send(
      said({
        id: "activity:2",
        kind: "turn.thinking",
        headline: "Thinking",
        body: "the staging table is on the second page",
      }),
    );
    fake.watch.send(
      said({ id: "activity:3", body: "Reading the second page." }),
    );
    await settle();

    const thread = document.querySelector(".importer");
    const words = (thread?.textContent ?? "").replace(/\s+/g, " ");
    expect(words).toContain("Also load the staging hosts");
    expect(words).toContain("Reading the second page.");
    expect(words).not.toContain("the goal agent, talking");
    // After the operator's message, not above it.
    expect(words.indexOf("Reading the second page.")).toBeGreaterThan(
      words.indexOf("Also load the staging hosts"),
    );
    // Thinking is collapsed and labelled, as the transcript renders it.
    const thought = [...document.querySelectorAll(".importer details")].find(
      (each) =>
        each.textContent?.includes("the staging table is on the second page"),
    ) as HTMLDetailsElement | undefined;
    expect(thought).toBeDefined();
    expect(thought?.open).toBe(false);
    expect(thought?.querySelector("summary")?.textContent).toContain(
      "What it considered",
    );
    // Still going while the server says the import is running.
    expect(cursor()).not.toBeNull();

    // The turn ends: the next poll is told so, and the cursor goes.
    running(false);
    // The poll's own timer, by its delay: the live feed's watchdog is armed beside it.
    const poll = (app.countdown as FakeCountdown).live.filter(
      (armed) => armed.ms === IMPORT_POLL_MS,
    );
    expect(poll).toHaveLength(1);
    poll[0]?.fire();
    await settle();
    expect(cursor()).toBeNull();
    expect(app.importer.current?.working).toBe(false);
    // And the words stay.
    expect(document.querySelector(".importer")?.textContent).toContain(
      "Reading the second page.",
    );
  });

  test("the operator's own message marks a bidi control as prose does, and leaves right-to-left letters as written", async () => {
    // The empty chat asks for the program's pages pasted in, so the operator's bubble is
    // as often a page author's words as the operator's own.
    await continueOn(SESSIONS, [harness("claude-code", "Claude Code")]);
    await send(
      "Scope: \u2067com\u200F.\u200Facme\u2069 and \u05E9\u05DC\u05D5\u05DD",
    );
    const bubble = [...document.querySelectorAll(".importer .bubble")].at(-1);
    expect(bubble?.textContent).toBe(
      "Scope: ⟨U+2067⟩com⟨U+200F⟩.⟨U+200F⟩acme⟨U+2069⟩ and \u05E9\u05DC\u05D5\u05DD",
    );
    expect(bubble?.querySelectorAll(".char-escape")).toHaveLength(4);
  });

  test("words published before the message was accepted still go under it", async () => {
    const { fake } = await continueOn(SESSIONS, [
      harness("claude-code", "Claude Code"),
    ]);
    fake.watch.send(liveOpened({ from: 0, latest: 0 }));
    fake.watch.send(said({ id: "activity:4", body: "From an earlier turn." }));
    await settle();
    // The importer can start answering before the browser hears the message was accepted:
    // the frame lands while the request is still out.
    fake.onSendImporterMessage = (_baseUrl, targetId, importId) => {
      fake.watch.send(said({ id: "activity:5", body: "Starting on it." }));
      return ok(
        importerTurnAccepted({
          targetId,
          importId,
          harnessSessionId: "ses_newest",
          harnessInstanceId: "claude-code",
        }),
      );
    };
    await send("Load the staging hosts");
    const words = (
      document.querySelector(".importer")?.textContent ?? ""
    ).replace(/\s+/g, " ");
    const message = words.indexOf("Load the staging hosts");
    expect(words.indexOf("From an earlier turn.")).toBeLessThan(message);
    expect(words.indexOf("Starting on it.")).toBeGreaterThan(message);
  });
});

/**
 * What a session from a dead process offers, which is whatever its driver can actually do
 * (S6).
 *
 * The replay carries `continuation`, and it is the one field on this screen a browser must
 * not derive for itself: it is the server's answer about whether *this process* holds the
 * session and, for one it does not, whether the harness will continue it — a round trip this
 * page cannot make. Offering a composer against a wrong guess costs the operator the message
 * they wrote, so each of the four answers is asserted here as a different screen.
 */
describe("a session this server no longer holds", () => {
  const replayed = (
    over: Partial<Parameters<typeof importerConversationView>[0]> = {},
  ) =>
    importerConversationView({
      importId: "imp_newest",
      harnessSessionId: "ses_newest",
      ...over,
    });

  test("one the harness will continue says the next message takes it back over", async () => {
    const { fake } = await continueOn(SESSIONS, [
      harness("claude-code", "Claude Code"),
    ]);
    void fake;
    expect(text()).toContain("takes it back over");
    expect(text()).not.toContain("will not have read any of this");
    // Offered, because the server said the message will land.
    expect(composer().disabled).toBe(false);
  });

  test("one the harness has swept says a new session, and why, instead of promising a resume", async () => {
    const fake = new FakeServer();
    fake.onImporterMessages = (_baseUrl, targetId, importId) =>
      ok(
        replayed({
          targetId,
          importId,
          source: "forgotten",
          continuation: "fresh",
          items: [],
          note: "Claude Code no longer holds session ses_newest.",
        }),
      );
    await continueWith(fake);

    expect(text()).toContain("cannot be carried on");
    expect(text()).toContain("will not have read any of this");
    expect(text()).toContain("no longer holds session ses_newest");
    // Still offered — a new session is a thing that works — and the sentence says what it
    // will be, which is the done criterion: never a composer that will fail, and never one
    // that claims a continuation.
    expect(composer().disabled).toBe(false);
  });

  test("one the operator ended is refused: the composer is disabled rather than offered", async () => {
    const fake = new FakeServer();
    fake.onImporterMessages = (_baseUrl, targetId, importId) =>
      ok(
        replayed({
          targetId,
          importId,
          source: "harness",
          continuation: "refused",
          refusal: {
            reason: "import_ended",
            detail:
              "You ended this import, so its authority has ended with it.",
          },
          note: "You ended this import, so its authority has ended with it.",
        }),
      );
    await continueWith(fake);

    // The row the index answered says nothing about an end — this is the replay's answer
    // alone, which is what makes a session ended in another tab safe to look at here.
    expect(composer().disabled).toBe(true);
    expect(notice()).toBe(ENDED_NOTE);
    expect(composer().placeholder).toBe(
      "This session was ended, so it cannot be continued.",
    );
  });

  test("one refused for a reason that is not an end says the server's reason, not that it was ended", async () => {
    // What a session opened as an agent a later build no longer defines answers after a
    // restart. Nobody ended it, so "This session was ended" would be a claim about something
    // the operator never did.
    const reason =
      "Import imp_newest's session runs as the agent 'retired_agent', which this server does not define as an importer, so it cannot be continued. Start a new session to carry on.";
    const fake = new FakeServer();
    fake.onImporterMessages = (_baseUrl, targetId, importId) =>
      ok(
        replayed({
          targetId,
          importId,
          source: "harness",
          continuation: "refused",
          refusal: { reason: "agent_unavailable", detail: reason },
          note: `From the harness, which may delete it. ${reason}`,
        }),
      );
    await continueWith(fake);

    expect(composer().disabled).toBe(true);
    expect(composer().placeholder).toBe(reason);
    expect(notice()).toBe(reason);
    expect(text()).not.toContain("This session was ended");
    expect(composer().placeholder).not.toContain("was ended");
  });

  test("a replay that does not answer leaves the thread alone rather than claiming silence", async () => {
    const fake = new FakeServer();
    fake.onImporterMessages = () => unreachable("no route");
    await continueWith(fake);

    // No invented sentence about the harness, and the composer still works: the server's
    // refusal is the one that counts, and this page has not had one.
    expect(text()).not.toContain("no longer holds");
    expect(composer().disabled).toBe(false);
  });
});

describe("the Stop pill (A6 F5)", () => {
  const cursor = (): Element | null =>
    document.querySelector(".importer .streaming .stream-cursor");
  const stopPill = (): HTMLButtonElement | null =>
    document.querySelector<HTMLButtonElement>(".importer button.stop");
  const dialog = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[role="alertdialog"]');

  /** A listed session with a turn the server says is running. */
  const working = async () => {
    const { app, fake } = await continueOn(SESSIONS, [
      harness("claude-code", "Claude Code"),
    ]);
    fake.watch.send(liveOpened({ from: 0, latest: 0 }));
    await settle();
    // Running in both places the server says it: the import's progress and the list.
    fake.onScopeImport = (_baseUrl, targetId, importId) =>
      ok(scopeImportView({ targetId, importId, status: "running" }));
    fake.onImporterSessions = () =>
      ok({
        sessions: SESSIONS.map((each) =>
          each.importId === "imp_newest" ? { ...each, running: true } : each,
        ),
      });
    const box = composer();
    typeInto(box, "Also load the staging hosts");
    box.focus();
    press("Enter");
    await settle();
    expect(cursor()).not.toBeNull();
    return { app, fake };
  };

  test("asks the server to stop the turn, and the cursor clears on the server's answer, not on the press", async () => {
    const { app, fake } = await working();
    const release = fake.hold("stopImporterTurn");
    const pill = stopPill();
    if (pill === null) throw new Error("no Stop pill while the turn runs");
    click(pill);
    await settle();

    const calls = fake.calls
      .filter((call) => call.method === "stopImporterTurn")
      .map((call) => call.args.slice(1));
    expect(calls).toEqual([["acme-corp", "imp_newest"]]);
    // Asked, not answered: still working, and the pill says it is stopping.
    expect(cursor()).not.toBeNull();
    expect(stopPill()?.textContent?.trim()).toBe("Stopping…");
    expect(stopPill()?.getAttribute("aria-disabled")).toBe("true");

    release();
    await settle();
    expect(cursor()).toBeNull();
    expect(app.importer.current?.working).toBe(false);
    expect(stopPill()).toBeNull();
    expect(
      document.querySelector(".importer .notice")?.textContent?.trim(),
    ).toBe("Stopped the turn running in this session.");
  });

  test("a turn the server says is still working keeps its cursor", async () => {
    // Claude Code runs a message queued behind the stopped turn at once.
    const { app, fake } = await working();
    fake.onStopImporterTurn = (_baseUrl, _targetId, importId) =>
      ok({
        conversationId: importId,
        outcome: "interrupted",
        working: true,
        background: false,
        detail: "Its harness went straight on to a message you sent.",
      });
    const pill = stopPill();
    if (pill === null) throw new Error("no Stop pill while the turn runs");
    click(pill);
    await settle();
    expect(cursor()).not.toBeNull();
    expect(app.importer.current?.working).toBe(true);
    expect(stopPill()?.textContent?.trim()).toBe("Stop");
  });

  test("a still-working Stop's sentence goes when that turn ends, with the pill; a settled one's stays", async () => {
    /*
     * "Is answering it now; stop again" is about the turn the Stop left running. Once the
     * server says the import is idle the pill goes, and a sentence still telling the operator
     * to stop again would be about a turn that is over.
     */
    const { app, fake } = await working();
    const said = "Its harness went straight on to a message you sent.";
    fake.onStopImporterTurn = (_baseUrl, _targetId, importId) =>
      ok({
        conversationId: importId,
        outcome: "interrupted",
        working: true,
        background: false,
        detail: said,
      });
    const pill = stopPill();
    if (pill === null) throw new Error("no Stop pill while the turn runs");
    click(pill);
    await settle();
    const notice = (): string =>
      document.querySelector(".importer .notice")?.textContent?.trim() ?? "";
    expect(notice()).toBe(said);

    // The follow-up's turn ends: the next poll is told so.
    fake.onScopeImport = (_baseUrl, targetId, importId) =>
      ok(scopeImportView({ targetId, importId, status: "finished" }));
    fake.onImporterSessions = () => ok({ sessions: SESSIONS });
    const poll = (app.countdown as FakeCountdown).live.filter(
      (armed) => armed.ms === IMPORT_POLL_MS,
    );
    expect(poll).toHaveLength(1);
    poll[0]?.fire();
    await settle();
    expect(stopPill()).toBeNull();
    expect(app.importer.current?.working).toBe(false);
    expect(notice()).toBe("");
  });

  test("a Stop that leaves a message held keeps saying so after the conversation is idle", async () => {
    // OpenCode holds the follow-up for the next message: that stays true after the turn.
    const { app, fake } = await working();
    const said =
      "Stopped the turn. The message you sent while it ran has not been answered.";
    fake.onStopImporterTurn = (_baseUrl, _targetId, importId) =>
      ok({
        conversationId: importId,
        outcome: "interrupted",
        working: false,
        background: false,
        detail: said,
      });
    const pill = stopPill();
    if (pill === null) throw new Error("no Stop pill while the turn runs");
    click(pill);
    await settle();
    fake.onScopeImport = (_baseUrl, targetId, importId) =>
      ok(scopeImportView({ targetId, importId, status: "finished" }));
    fake.onImporterSessions = () => ok({ sessions: SESSIONS });
    for (const armed of (app.countdown as FakeCountdown).live.filter(
      (each) => each.ms === IMPORT_POLL_MS,
    )) {
      armed.fire();
    }
    await settle();
    expect(app.importer.current?.working).toBe(false);
    expect(
      document.querySelector(".importer .notice")?.textContent?.trim(),
    ).toBe(said);
  });

  test("a refusal opens the error dialog with the server's sentence, and the turn is left as it was", async () => {
    const { fake } = await working();
    fake.onStopImporterTurn = () =>
      refused(
        new ConversationStopRefused({
          reason: "harness_unreachable",
          detail: "The harness did not acknowledge the stop.",
        }),
      );
    const pill = stopPill();
    if (pill === null) throw new Error("no Stop pill while the turn runs");
    click(pill);
    await settle();
    const shown = dialog();
    expect(shown).not.toBeNull();
    expect(shown?.textContent).toContain("Turn not stopped");
    expect(shown?.textContent).toContain(
      "The harness did not acknowledge the stop.",
    );
    expect(cursor()).not.toBeNull();
    const close = [...(shown?.querySelectorAll("button") ?? [])].find(
      (each) => each.textContent?.trim() === "Close",
    );
    if (close === undefined) throw new Error("no Close button");
    click(close);
    await settle();
    expect(dialog()).toBeNull();
  });
});

/*
 * A6 U6: Stop follows what the server says runs — a turn the harness opened by itself, and
 * background work outside any turn — and D3's "Send now" beside the queued send.
 */
describe("A6 U6: Stop when the server says something runs, and Send now", () => {
  const stopPill = (): HTMLButtonElement | null =>
    document.querySelector<HTMLButtonElement>(".importer button.stop");
  const sendNowButton = (): HTMLButtonElement | null =>
    document.querySelector<HTMLButtonElement>(".importer button.send-now");
  const noticeText = (): string =>
    document.querySelector(".importer .notice")?.textContent?.trim() ?? "";
  const cursor = (): Element | null =>
    document.querySelector(".importer .streaming .stream-cursor");
  /** The server's activity answers, changed by the test as the session's state moves. */
  const activity = (
    fake: FakeServer,
    state: { turn: "running" | "idle" | "not_live"; background: boolean },
  ) => {
    fake.onImporterActivity = (_baseUrl, _targetId, importId) =>
      ok({ conversationId: importId, ...state });
  };
  const firePolls = async (app: App): Promise<void> => {
    for (const armed of (app.countdown as FakeCountdown).live.filter(
      (each) => each.ms === IMPORT_POLL_MS,
    )) {
      armed.fire();
    }
    await settle();
  };
  const word = (id: string, body: string) =>
    liveActivity({
      id,
      attemptId: null,
      importId: "imp_newest",
      kind: "turn.reply",
      headline: "Reply",
      tool: null,
      toolName: null,
      input: null,
      callId: null,
      body,
    });

  test("a turn the harness opened by itself shows Stop once its words arrive, and Stop stops it", async () => {
    // Claude Code opens a turn of its own on a background task's notification: no message of
    // this tab's started it, and the list calls the import finished throughout.
    const { app, fake } = await continueOn(SESSIONS, [
      harness("claude-code", "Claude Code"),
    ]);
    fake.watch.send(liveOpened({ from: 0, latest: 0 }));
    await settle();
    expect(stopPill()).toBeNull();
    const asked = fake.countOf("importerActivity");

    activity(fake, { turn: "running", background: false });
    fake.watch.send(word("activity:5", "The background check came back."));
    await settle();
    expect(fake.countOf("importerActivity")).toBe(asked + 1);
    expect(app.importer.current?.working).toBe(true);
    expect(stopPill()?.textContent?.trim()).toBe("Stop");
    expect(cursor()).not.toBeNull();

    // More words while it runs ask nothing more: the watch is on it.
    fake.watch.send(word("activity:6", "It printed done."));
    await settle();
    expect(fake.countOf("importerActivity")).toBe(asked + 1);

    const pill = stopPill();
    if (pill === null) throw new Error("no Stop pill");
    click(pill);
    await settle();
    expect(
      fake.calls
        .filter((call) => call.method === "stopImporterTurn")
        .map((call) => call.args.slice(1)),
    ).toEqual([["acme-corp", "imp_newest"]]);
    expect(stopPill()).toBeNull();
  });

  test("a reading of the list that calls it finished does not take Stop away from a turn the server says runs", async () => {
    const { app, fake } = await continueOn(SESSIONS, [
      harness("claude-code", "Claude Code"),
    ]);
    fake.watch.send(liveOpened({ from: 0, latest: 0 }));
    activity(fake, { turn: "running", background: false });
    fake.watch.send(word("activity:5", "The background check came back."));
    await settle();
    await app.loadImporterSessions("acme-corp");
    await settle();
    expect(stopPill()).not.toBeNull();
    // The watch says it is over, and the pill goes.
    activity(fake, { turn: "idle", background: false });
    await firePolls(app);
    expect(stopPill()).toBeNull();
    expect(app.importer.current?.working).toBe(false);
  });

  test("background work outside any turn is offered Stop on open, and the 'may still be running' sentence goes when it is over", async () => {
    const fake = new FakeServer();
    activity(fake, { turn: "idle", background: true });
    const said =
      "No turn was running, but work it had started in the background was. It was told to stop, and some of it may still be running; stop again to ask once more.";
    fake.onStopImporterTurn = (_baseUrl, _targetId, importId) =>
      ok({
        conversationId: importId,
        outcome: "background_stopped",
        working: true,
        background: true,
        detail: said,
      });
    const app = await continueWith(fake);
    expect(app.importer.current?.working).toBe(false);
    expect(app.importer.current?.background).toBe(true);
    // No turn: no cursor, and the pill says what it stops.
    expect(cursor()).toBeNull();
    expect(stopPill()?.textContent?.trim()).toBe("Stop background work");

    const pill = stopPill();
    if (pill === null) throw new Error("no Stop pill");
    click(pill);
    await settle();
    expect(noticeText()).toBe(said);
    // Some of it still runs: the pill stays, to ask again, and so does the sentence while
    // the server says it runs — no turn ending is what it waits for.
    expect(stopPill()).not.toBeNull();
    await firePolls(app);
    expect(noticeText()).toBe(said);
    expect(stopPill()).not.toBeNull();

    // The background work ends, with no turn ending at all: the sentence goes with it, not
    // at the end of the next turn.
    activity(fake, { turn: "idle", background: false });
    await firePolls(app);
    expect(noticeText()).toBe("");
    expect(stopPill()).toBeNull();
    expect(app.importer.current?.background).toBe(false);
  });

  test("Send now is offered only while a turn runs; it sends a preemptive steer, and Enter still queues", async () => {
    const { app, fake } = await continueOn(SESSIONS, [
      harness("claude-code", "Claude Code", "claude-code"),
    ]);
    fake.watch.send(liveOpened({ from: 0, latest: 0 }));
    await settle();
    // Idle: one way to send.
    typeInto(composer(), "Also the partner portal");
    await settle();
    expect(sendNowButton()).toBeNull();

    // A turn runs (the operator's first message, queued as ever by Enter).
    composer().focus();
    press("Enter");
    await settle();
    activity(fake, { turn: "running", background: false });
    await firePolls(app);
    expect(app.importer.current?.working).toBe(true);
    const urgencies = () =>
      fake.calls
        .filter((call) => call.method === "sendImporterMessage")
        .map((call) => call.args[4] ?? "queued");
    expect(urgencies()).toEqual(["queued"]);

    // Delivered as a steer, under an id its take will name.
    fake.onSendImporterMessage = (_baseUrl, targetId, importId) =>
      ok(
        importerTurnAccepted({
          targetId,
          importId,
          harnessSessionId: "ses_newest",
          harnessInstanceId: "claude-code",
          model: "anthropic/claude-newest",
          messageId: "msg_now",
        }),
      );
    typeInto(composer(), "Stop reading the blog, it is out of scope");
    await settle();
    const now = sendNowButton();
    if (now === null) throw new Error("no Send now while a turn runs");
    expect(now.disabled).toBe(false);
    // Claude Code cuts in at its next step, and the button says so.
    expect(now.title).toBe(sendNowButtonTitle("next_step"));
    // As a pointer leaves it: the button holds the focus when it is pressed.
    now.focus();
    click(now);
    await settle();
    expect(urgencies()).toEqual(["queued", "preemptive"]);
    // The focus is back in the box (A6 U6 review), not on a button that is now disabled.
    expect(document.activeElement?.id).toBe("importer-message");
    // Waiting for the harness to take it, the bubble says it is being sent now.
    const marks = () =>
      [...document.querySelectorAll(".importer .queued-mark")].map(
        (each) => each.textContent?.trim() ?? "",
      );
    expect(marks()).toEqual(["sending now"]);
    expect(document.querySelector(".importer")?.textContent).toContain(
      sendingNowNote("next_step"),
    );
    // Empty again: Send now is there and off, like the arrow.
    expect(sendNowButton()?.disabled).toBe(true);

    // The harness takes it at its next step: the mark says what happened.
    const sent = app.importer.current?.items.at(-1);
    const messageId = sent?.messageIds?.[0];
    if (messageId === undefined) throw new Error("no message id");
    fake.watch.send(
      liveActivity({
        id: "activity:30",
        attemptId: null,
        importId: "imp_newest",
        kind: "turn.taken",
        headline: "",
        tool: null,
        toolName: null,
        input: null,
        callId: null,
        messageIds: [messageId],
      }),
    );
    await settle();
    expect(marks()).toEqual(["sent now"]);
    expect(
      document.querySelector(".importer .queued-mark")?.getAttribute("title"),
    ).toBe(sentNowTitle("next_step"));
    expect(document.querySelector(".importer")?.textContent).not.toContain(
      sendingNowNote("next_step"),
    );
  });

  test("on OpenCode, Send now says it is read once the message in flight ends, not that it cuts in (A6 U6 review)", async () => {
    // GLM finished a 77 s reply in full before it read a Send now: no step inside a message.
    const sessions = SESSIONS.map((each) =>
      each.importId === "imp_newest"
        ? { ...each, harnessInstanceId: "opencode" }
        : each,
    );
    const { app, fake } = await continueOn(sessions, [
      harness("opencode", "OpenCode", "opencode"),
    ]);
    fake.watch.send(liveOpened({ from: 0, latest: 0 }));
    await settle();
    typeInto(composer(), "Read the policy");
    await settle();
    composer().focus();
    press("Enter");
    await settle();
    activity(fake, { turn: "running", background: false });
    await firePolls(app);
    expect(app.importer.current?.working).toBe(true);

    fake.onSendImporterMessage = (_baseUrl, targetId, importId) =>
      ok(
        importerTurnAccepted({
          targetId,
          importId,
          harnessSessionId: "ses_newest",
          harnessInstanceId: "opencode",
          model: "anthropic/claude-newest",
          messageId: "msg_now",
        }),
      );
    typeInto(composer(), "Skip the blog");
    await settle();
    const now = sendNowButton();
    if (now === null) throw new Error("no Send now while a turn runs");
    expect(now.title).toBe(sendNowButtonTitle("message_end"));
    click(now);
    await settle();
    const page = document.querySelector(".importer")?.textContent ?? "";
    expect(page).toContain(sendingNowNote("message_end"));
    // Nothing on screen claims the reply in flight is cut short.
    expect(page).not.toContain(sendingNowNote("next_step"));
    expect(page).not.toContain("is dropped");

    const messageId = app.importer.current?.items.at(-1)?.messageIds?.[0];
    if (messageId === undefined) throw new Error("no message id");
    fake.watch.send(
      liveActivity({
        id: "activity:30",
        attemptId: null,
        importId: "imp_newest",
        kind: "turn.taken",
        headline: "",
        tool: null,
        toolName: null,
        input: null,
        callId: null,
        messageIds: [messageId],
      }),
    );
    await settle();
    expect(
      document.querySelector(".importer .queued-mark")?.getAttribute("title"),
    ).toBe(sentNowTitle("message_end"));
  });

  test("a turn's Stop that stopped the background work beside it takes the pill away at once, with no 'Stop background work' in between (A6 U6 review)", async () => {
    const fake = new FakeServer();
    // A turn runs and a background shell beside it.
    activity(fake, { turn: "running", background: true });
    fake.onStopImporterTurn = (_baseUrl, _targetId, importId) =>
      ok({
        conversationId: importId,
        outcome: "interrupted",
        working: false,
        background: false,
        detail: "Stopped the turn running in this session.",
      });
    const app = await continueWith(fake);
    expect(app.importer.current?.working).toBe(true);
    expect(app.importer.current?.background).toBe(true);
    expect(stopPill()?.textContent?.trim()).toBe("Stop");
    // The next activity read would still say the shell runs: only the answer clears it.
    const pill = stopPill();
    if (pill === null) throw new Error("no Stop pill");
    click(pill);
    await settle();
    expect(app.importer.current?.working).toBe(false);
    expect(app.importer.current?.background).toBe(false);
    expect(stopPill()).toBeNull();
  });

  test("a turn's Stop that left background work running offers 'Stop background work' next", async () => {
    const fake = new FakeServer();
    activity(fake, { turn: "running", background: true });
    fake.onStopImporterTurn = (_baseUrl, _targetId, importId) =>
      ok({
        conversationId: importId,
        outcome: "interrupted",
        working: false,
        background: true,
        detail: "Stopped the turn running in this session.",
      });
    const app = await continueWith(fake);
    const pill = stopPill();
    if (pill === null) throw new Error("no Stop pill");
    click(pill);
    await settle();
    expect(app.importer.current?.working).toBe(false);
    expect(stopPill()?.textContent?.trim()).toBe("Stop background work");
  });
});

/*
 * A6 U5: the importer's words while they are being written. The server sends a block's
 * partials — its whole text so far, `streaming: true` — then the finished block, all under
 * one `blockId`; the thread draws one row for it throughout. Compared as strings and by
 * `===` on elements, never with `toEqual` on a node.
 */
describe("A6 U5: a block while it is being written", () => {
  const running = (fake: FakeServer, yes: boolean) => {
    fake.onScopeImport = (_baseUrl, targetId, importId) =>
      ok(
        scopeImportView({
          targetId,
          importId,
          status: yes ? "running" : "finished",
        }),
      );
    fake.onImporterSessions = () =>
      ok({
        sessions: SESSIONS.map((each) =>
          each.importId === "imp_newest" ? { ...each, running: yes } : each,
        ),
      });
  };
  /** A session on screen with a turn in flight, its feed open. */
  const inFlight = async () => {
    const opened = await continueOn(SESSIONS, [
      harness("claude-code", "Claude Code"),
    ]);
    opened.fake.watch.send(liveOpened({ from: 0, latest: 0 }));
    running(opened.fake, true);
    const box = composer();
    typeInto(box, "Load the staging hosts");
    box.focus();
    press("Enter");
    await settle();
    return opened;
  };
  const block = (
    id: string,
    blockId: string,
    body: string,
    over: Partial<Parameters<typeof liveActivity>[0]> = {},
  ) =>
    liveActivity({
      id,
      attemptId: null,
      importId: "imp_newest",
      kind: "turn.reply",
      headline: "Reply",
      tool: null,
      toolName: null,
      input: null,
      callId: null,
      body,
      blockId,
      // The call, as the server names it beside the block (A6 U5 review).
      blockCall: blockId.replace(/:(?:text:|reasoning:)?\d+$/u, ""),
      ...over,
    });
  const partial = (
    id: string,
    blockId: string,
    body: string,
    over: Partial<Parameters<typeof liveActivity>[0]> = {},
  ) => block(id, blockId, body, { streaming: true, ...over });
  const thinking = { kind: "turn.thinking", headline: "Thinking" } as const;
  const replies = (): HTMLElement[] => [
    ...document.querySelectorAll<HTMLElement>(
      ".importer li.prose:not(.reasoning)",
    ),
  ];
  const writing = (): string[] =>
    [...document.querySelectorAll(".importer .writing")].map(
      (each) => each.textContent?.replace(/\s+/g, " ").trim() ?? "",
    );
  const cursors = (): number =>
    document.querySelectorAll(".importer .stream-cursor").length;

  test("a reply grows in one row marked writing, and its finished block replaces it in that row", async () => {
    const { fake } = await inFlight();
    const before = replies().length;
    fake.watch.send(partial("activity:10", "ses:msg_a:0", "Reading"));
    await settle();
    const row = replies().at(-1);
    expect(row?.textContent).toContain("Reading");
    expect(writing()).toEqual(["writing…"]);
    // One cursor: the reply's own, not a second at the end of the turn.
    expect(cursors()).toBe(1);
    const markdown = row?.querySelector(".markdown");

    fake.watch.send(
      partial("activity:12", "ses:msg_a:0", "Reading the policy"),
    );
    await settle();
    expect(replies()).toHaveLength(before + 1);
    expect(replies().at(-1) === row).toBe(true);
    expect(row?.querySelector(".markdown") === markdown).toBe(true);
    expect(row?.textContent).toContain("Reading the policy");

    fake.watch.send(
      block("activity:15", "ses:msg_a:0", "Reading the policy page."),
    );
    await settle();
    expect(replies()).toHaveLength(before + 1);
    // The same row and the same rendered reply, now finished: no mark on it.
    expect(replies().at(-1) === row).toBe(true);
    expect(row?.querySelector(".markdown") === markdown).toBe(true);
    expect(row?.textContent).toContain("Reading the policy page.");
    expect(writing()).toEqual([]);
    // The turn is still running, so the turn's own cursor is back.
    expect(cursors()).toBe(1);
  });

  test("a thought shimmers while it is written, keeps its row and its opened state when it finishes", async () => {
    const { fake } = await inFlight();
    fake.watch.send(
      partial("activity:20", "ses:msg_t:0", "Weighing the table", thinking),
    );
    await settle();
    const details = document.querySelector<HTMLDetailsElement>(
      ".importer .reasoning details",
    );
    expect(
      document.querySelector(".importer .reasoning .gist.shimmer"),
    ).not.toBeNull();
    expect(details?.querySelector("summary")?.textContent).toContain(
      "(being written)",
    );
    if (details !== null && details !== undefined) details.open = true;
    fake.watch.send(
      block("activity:22", "ses:msg_t:0", "Weighing the table rows.", thinking),
    );
    await settle();
    const after = document.querySelector<HTMLDetailsElement>(
      ".importer .reasoning details",
    );
    expect(after === details).toBe(true);
    expect(after?.open).toBe(true);
    expect(
      document.querySelector(".importer .reasoning .gist.shimmer"),
    ).toBeNull();
    expect(after?.textContent).toContain("Weighing the table rows.");
  });

  test("GLM: a thought stops shimmering once a reply of the same message starts", async () => {
    const { fake } = await inFlight();
    fake.watch.send(
      partial("activity:30", "ses_glm:msg_1:reasoning:0", "Weighing", thinking),
    );
    await settle();
    expect(document.querySelector(".importer .gist.shimmer")).not.toBeNull();
    fake.watch.send(
      partial("activity:31", "ses_glm:msg_1:text:0", "The answer"),
    );
    await settle();
    expect(document.querySelector(".importer .gist.shimmer")).toBeNull();
    expect(writing()).toEqual(["writing…"]);
  });

  test("a thought past the 4,000-character cap says it is shortened, and does not shimmer", async () => {
    const { fake } = await inFlight();
    fake.watch.send(
      partial(
        "activity:40",
        "ses:msg_t:0",
        "long thought ".repeat(320).slice(0, PARTIAL_BODY_MAX),
        thinking,
      ),
    );
    await settle();
    expect(document.querySelector(".importer .gist.shimmer")).toBeNull();
    expect(
      document.querySelector(".importer .reasoning .cut")?.textContent,
    ).toBe("shortened");
  });

  test("U5 review: a reply streaming past the partial cap says the rest shows when it finishes, then finishes whole", async () => {
    const { fake } = await inFlight();
    // As the server sends it: cut at the cap with no mark (A6 U5 review 2).
    const head = "word ".repeat(800);
    expect(head.length).toBe(PARTIAL_BODY_MAX);
    fake.watch.send(partial("activity:44", "ses:msg_l:0", head));
    await settle();
    expect(writing()).toEqual([REPLY_PAST_CAP_LABEL]);
    // No "(shortened)" right above "the rest shows when it finishes" while it streams.
    expect(replies().at(-1)?.textContent ?? "").not.toContain("(shortened)");
    expect(REPLY_PAST_CAP_LABEL).toBe(
      "writing… — the rest shows when it finishes",
    );
    // The finished reply carries up to 32,000 characters: it replaces the cut partial whole.
    const whole = `${head}${"more ".repeat(4_000)}the end.`;
    fake.watch.send(block("activity:45", "ses:msg_l:0", whole));
    await settle();
    expect(writing()).toEqual([]);
    const last = replies().at(-1)?.textContent ?? "";
    expect(last).toContain("the end.");
    expect(last).not.toContain("(shortened)");
  });

  test("when the turn ends, a partial that never finished is gone — a retried call's first attempt", async () => {
    const { app, fake } = await inFlight();
    fake.watch.send(partial("activity:50", "ses:msg_a:0", "Abandoned attempt"));
    await settle();
    expect(document.querySelector(".importer")?.textContent).toContain(
      "Abandoned attempt",
    );
    running(fake, false);
    const poll = (app.countdown as FakeCountdown).live.filter(
      (armed) => armed.ms === IMPORT_POLL_MS,
    );
    poll[0]?.fire();
    await settle();
    expect(app.importer.current?.working).toBe(false);
    expect(document.querySelector(".importer")?.textContent).not.toContain(
      "Abandoned attempt",
    );
    expect(writing()).toEqual([]);
  });

  test("a reload part way through a block shows the turn writing, not a message with no reply", async () => {
    const fake = new FakeServer();
    fake.onScope = () => ok(emptyScope());
    fake.onImporterSessions = () =>
      ok({
        sessions: SESSIONS.map((each) =>
          each.importId === "imp_newest" ? { ...each, running: true } : each,
        ),
      });
    fake.onHarnesses = () => ok([harness("claude-code", "Claude Code")]);
    // The harness holds the message and none of the block it is writing.
    fake.onImporterMessages = (_baseUrl, targetId, importId) =>
      ok(
        importerConversationView({
          targetId,
          importId,
          live: true,
          continuation: "live",
          items: [
            replayItem(0, "turn.operator", "Read the policy page", {
              importId,
            }),
          ],
        }),
      );
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
    const thread = document.querySelector(".importer")?.textContent ?? "";
    expect(thread).toContain(MID_BLOCK_NOTE);
    expect(thread).not.toContain(
      "The harness holds this message and no reply to it.",
    );
    expect(
      document.querySelector(".importer .streaming")?.textContent?.trim(),
    ).toBe("writing…");
  });

  test("U5 review 2: a replay read mid-reply is read again when the turn settles, and the thought it lacked is drawn", async () => {
    /*
     * Claude Code writes a model call's blocks to its transcript only when the whole call
     * ends: a reload mid-reply reads a replay with the operator's row and no thought, and
     * the new feed never gets the thought's frame, sent before the reload. Only a read
     * after the turn settles has it.
     */
    const fake = new FakeServer();
    fake.onScope = () => ok(emptyScope());
    running(fake, true);
    fake.onHarnesses = () => ok([harness("claude-code", "Claude Code")]);
    let settled = false;
    let reads = 0;
    fake.onImporterMessages = (_baseUrl, targetId, importId) => {
      reads += 1;
      return ok(
        importerConversationView({
          targetId,
          importId,
          live: true,
          continuation: "live",
          items: [
            replayItem(0, "turn.operator", "Read the policy page", {
              importId,
            }),
            ...(settled
              ? [
                  replayItem(1, "turn.thinking", "Weighing the wildcard", {
                    importId,
                    blockId: "ses:msg_9:0",
                  }),
                  replayItem(2, "turn.reply", "The policy lists two hosts.", {
                    importId,
                    blockId: "ses:msg_9:1",
                  }),
                ]
              : []),
          ],
        }),
      );
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
    mounted.push(mountInto(TitleBar, { app }), mountInto(Target, { app }));
    await settle();
    click(button("Continue that session"));
    await settle();
    const thread = () => document.querySelector(".importer")?.textContent ?? "";
    expect(thread()).not.toContain("Weighing the wildcard");
    const before = reads;

    // The call ends, its blocks are written, and the turn settles.
    settled = true;
    running(fake, false);
    const poll = (app.countdown as FakeCountdown).live.filter(
      (armed) => armed.ms === IMPORT_POLL_MS,
    );
    poll[0]?.fire();
    await settle();
    expect(app.importer.current?.working).toBe(false);
    expect(reads).toBe(before + 1);
    const text = thread();
    expect(text).toContain("Weighing the wildcard");
    expect(text).toContain("The policy lists two hosts.");
    // The thought above its reply.
    expect(text.indexOf("Weighing the wildcard")).toBeLessThan(
      text.indexOf("The policy lists two hosts."),
    );
    // Read once for the settled turn, not again on every later poll.
    for (const armed of (app.countdown as FakeCountdown).live.filter(
      (each) => each.ms === IMPORT_POLL_MS,
    )) {
      armed.fire();
    }
    await settle();
    expect(reads).toBe(before + 1);
  });
});
