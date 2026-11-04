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
import {
  NARRATION_SHORTENED_MARK,
  REPLY_PAST_CAP_LABEL,
} from "../../src/lib/chat";
import { ENDED_NOTE, MID_BLOCK_NOTE } from "../../src/lib/importerChat";
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
    // It is read-only until the operator types, and says so.
    expect(text()).toContain("You are reading an earlier session");
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
    ).toBe("Stopped the turn import imp_newest was taking.");
  });

  test("a turn the server says is still working keeps its cursor", async () => {
    // Claude Code runs a message queued behind the stopped turn at once.
    const { app, fake } = await working();
    fake.onStopImporterTurn = (_baseUrl, _targetId, importId) =>
      ok({
        conversationId: importId,
        outcome: "interrupted",
        working: true,
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
        `${"long thought ".repeat(320)}${NARRATION_SHORTENED_MARK}`,
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
    const head = "word ".repeat(800);
    fake.watch.send(
      partial(
        "activity:44",
        "ses:msg_l:0",
        `${head}${NARRATION_SHORTENED_MARK}`,
      ),
    );
    await settle();
    expect(writing()).toEqual([REPLY_PAST_CAP_LABEL]);
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
});
