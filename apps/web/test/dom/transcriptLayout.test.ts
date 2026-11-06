/**
 * A6 U4: the importer's thread laid out as D3 and D4 draw it.
 *
 * The agent's prose full width; the operator's turn boxed with "You · 18:02"; consecutive
 * tool calls folded into one muted line ("Ran 3 commands · …") with the calls one click
 * away and what needs attention said on the line; reasoning folded to one truncated line;
 * a finished turn's footer naming the agent, the model or models that answered and how long
 * it took; a message sent mid-turn drawn as queued until the harness takes it; and a
 * harness's own error said in its own words. Live and replay go through the same rows, so
 * the same items draw the same thread either way.
 *
 * Driven against a fake server, through the real page. Every comparison is of strings:
 * a failing match against a DOM node runs away in happy-dom (AGENTS.md).
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  bitMcpServerName,
  claudeCodeToolName,
  type ImporterConversationView,
  type ImporterSessionView,
  type LiveItem,
} from "@bit/contracts";

import { App, IMPORT_POLL_MS } from "../../src/lib/app.svelte";
import TitleBar from "../../src/lib/components/TitleBar.svelte";
import { CARRIED_NOTE } from "../../src/lib/conversationChat";
import { QUEUED_NOTE, STOPPED_NOTE } from "../../src/lib/importerChat";
import { mockHarnesses } from "../../src/lib/mockImporter";
import Target from "../../src/lib/screens/Target.svelte";
import { FakeCountdown } from "../fakeCountdown";
import {
  AT,
  FakeServer,
  emptyScope,
  importerConversationView,
  importerModelView,
  importerSessionView,
  importerTurnAccepted,
  liveItem,
  liveOpened,
  ok,
  scopeImportView,
} from "../fakeServer";
import { click, mountInto, press, settle, type Mounted } from "./dom";

let mounted: Mounted[] = [];
afterEach(() => {
  for (const each of mounted) each.destroy();
  mounted = [];
});

const SESSION: ImporterSessionView = importerSessionView({
  sessionId: "ses_a",
  importId: "imp_a",
  model: "openai/gpt-5.6-sol",
});

const said = (element: Element | null | undefined): string =>
  (element?.textContent ?? "").replace(/\s+/g, " ").trim();

/** "18:02", as the page words a time. */
const clock = (at: number): string =>
  new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

/* ── Items, as the server sends them (live) or replays them ─────────────────── */

/** An item, live (`activity:<n>`) or replayed (`replay:<n>`), at `AT + seconds`. */
const at = (
  space: "activity" | "replay",
  n: number,
  seconds: number,
  over: Partial<LiveItem> & Pick<LiveItem, "kind">,
): LiveItem =>
  liveItem({
    id: `${space}:${String(n)}`,
    origin: "activity",
    sequence: null,
    at: AT + seconds * 1000,
    importId: "imp_a",
    headline: "",
    body: "",
    tool: null,
    toolName: null,
    input: null,
    output: null,
    callId: null,
    outcome: null,
    ...over,
  });

const ours = (name: string): string =>
  claudeCodeToolName(bitMcpServerName("imp_a"), name);

/**
 * One turn's worth of the importer's work, in either id space: thinking, a reply, a fetch
 * and two writes (one refused), and a closing reply. Every item names the model that wrote
 * it, `models[0]` up to the writes and `models[1]` after.
 */
const turnItems = (
  space: "activity" | "replay",
  from: number,
  models: readonly [string, string] = ["m-one", "m-one"],
): LiveItem[] => {
  const [first, second] = models;
  return [
    at(space, from, 2, {
      kind: "turn.thinking",
      headline: "Thinking",
      body: "**The program page** is authoritative, so I read it first\nthen the SOW.",
      model: first,
    }),
    at(space, from + 1, 3, {
      kind: "turn.reply",
      headline: "Reply",
      body: "Fetching the policy page.",
      model: first,
    }),
    at(space, from + 2, 4, {
      kind: "tool.call",
      headline: "fetch_page",
      tool: "fetch_page",
      toolName: "fetch_page",
      input: '{"url":"https://hackerone.com/acme/policy"}',
      callId: "f1",
      model: first,
    }),
    at(space, from + 3, 6, {
      kind: "tool.result",
      headline: "fetch_page",
      tool: "fetch_page",
      toolName: "fetch_page",
      output: "nine rows",
      callId: "f1",
      outcome: "ok",
    }),
    at(space, from + 4, 7, {
      kind: "tool.call",
      headline: "add_scope_entry",
      tool: ours("add_scope_entry"),
      toolName: "add_scope_entry",
      input: '{"effect":"in","kind":"host","value":"acme.com"}',
      callId: "w1",
      model: first,
    }),
    at(space, from + 5, 8, {
      kind: "tool.call",
      headline: "add_scope_entry",
      tool: ours("add_scope_entry"),
      toolName: "add_scope_entry",
      input: '{"effect":"in","kind":"host","value":"evil..com"}',
      callId: "w2",
      model: first,
    }),
    at(space, from + 6, 9, {
      kind: "tool.result",
      headline: "add_scope_entry",
      tool: ours("add_scope_entry"),
      toolName: "add_scope_entry",
      output: "evil..com is not a host",
      callId: "w2",
      outcome: "failed",
    }),
    at(space, from + 7, 41, {
      kind: "turn.reply",
      headline: "Reply",
      body: "One written, one refused.",
      model: second,
    }),
  ];
};

/* ── The page ─────────────────────────────────────────────────────────────── */

/** The importer page on `SESSION`, whose replay is `items`, the session `running` or not. */
const openWith = async (
  items: readonly LiveItem[],
  running = false,
  queued: ImporterConversationView["queued"] = [],
): Promise<{ app: App; fake: FakeServer }> => {
  const fake = new FakeServer();
  fake.onScope = () => ok(emptyScope());
  fake.onHarnesses = () => ok(mockHarnesses());
  fake.onImporterModel = () =>
    ok(importerModelView({ model: "openai/gpt-5.6-sol" }));
  fake.onImporterSessions = () => ok({ sessions: [{ ...SESSION, running }] });
  fake.onImporterMessages = (_baseUrl, targetId, importId) =>
    ok(
      importerConversationView({
        targetId,
        importId,
        harnessSessionId: "ses_a",
        live: true,
        continuation: "live",
        items: [...items],
        queued: [...queued],
      }),
    );
  fake.onScopeImport = (_baseUrl, targetId, importId) =>
    ok(
      scopeImportView({
        targetId,
        importId,
        status: running ? "running" : "finished",
      }),
    );
  const app = new App(fake, new FakeCountdown());
  app.password = "correct-horse";
  await app.connect();
  app.openTarget("acme-corp");
  await settle();
  app.toSection("assets");
  await settle();
  app.openImporter("ses_a");
  await settle();
  mounted.push(mountInto(TitleBar, { app }), mountInto(Target, { app }));
  await settle();
  return { app, fake };
};

const composer = (): HTMLTextAreaElement => {
  const box = document.querySelector<HTMLTextAreaElement>("#importer-message");
  if (box === null) throw new Error("no composer");
  return box;
};

const send = async (value: string): Promise<void> => {
  const box = composer();
  box.value = value;
  box.dispatchEvent(new Event("input", { bubbles: true }));
  box.focus();
  press("Enter");
  await settle();
};

/** The server says the turn is over: the session list and the import's poll agree. */
const endTurn = async (app: App, fake: FakeServer): Promise<void> => {
  fake.onImporterSessions = () =>
    ok({ sessions: [{ ...SESSION, running: false }] });
  fake.onScopeImport = (_baseUrl, targetId, importId) =>
    ok(scopeImportView({ targetId, importId, status: "finished" }));
  for (const armed of (app.countdown as FakeCountdown).live.filter(
    (each) => each.ms === IMPORT_POLL_MS,
  )) {
    armed.fire();
  }
  await settle();
};

/**
 * What the harness's transcript holds once the turn has settled (A6 U5 review 2): a
 * session whose replay was read while its turn ran reads it again then, so a fake that
 * went on answering with the replay from before the turn would wipe the turn it wrote.
 */
const transcriptOnceSettled = (
  fake: FakeServer,
  items: readonly LiveItem[],
): void => {
  fake.onImporterMessages = (_baseUrl, targetId, importId) =>
    ok(
      importerConversationView({
        targetId,
        importId,
        harnessSessionId: "ses_a",
        live: true,
        continuation: "live",
        items: [...items],
      }),
    );
};

const groups = (): Element[] => [
  ...document.querySelectorAll('.importer [role="log"] > .group'),
];

/** The folded tool lines on the page, as their summaries read. */
const toolLines = (): string[] =>
  [...document.querySelectorAll(".importer li.run > details > summary")].map(
    (each) => said(each),
  );

const footers = (): string[] =>
  [...document.querySelectorAll(".importer .foot")].map((each) => said(each));

const OPERATOR = (space: "activity" | "replay", n: number, text: string) =>
  at(space, n, 0, { kind: "turn.operator", headline: "You", body: text });

/* ── The tests ────────────────────────────────────────────────────────────── */

describe("U4: the operator's turn is boxed, with who and when under it", () => {
  test("the bubble holds the words and 'You · 18:02' sits under it, from the item's time", async () => {
    await openWith([
      OPERATOR("replay", 0, "Load the scope from the policy page"),
      ...turnItems("replay", 1),
    ]);
    const you = document.querySelector(".importer .you");
    expect(said(you?.querySelector(".bubble"))).toBe(
      "Load the scope from the policy page",
    );
    expect(said(you?.querySelector(".said .when"))).toBe(`You · ${clock(AT)}`);
    expect(
      you?.querySelector(".said button")?.getAttribute("aria-label") ?? "",
    ).toBe("Copy your message");
    // The agent's words are prose: no bubble, no label over them.
    expect(document.querySelectorAll(".importer .bubble")).toHaveLength(1);
    expect(
      [...document.querySelectorAll(".importer li.prose .reply")].map((each) =>
        said(each),
      ),
    ).toEqual(["Fetching the policy page.", "One written, one refused."]);
  });
});

describe("U4: consecutive tool calls fold into one line", () => {
  test("the line counts the calls and names each tool once, our MCP prefix off", async () => {
    await openWith([
      OPERATOR("replay", 0, "Load the scope"),
      ...turnItems("replay", 1),
    ]);
    // fetch_page, then two add_scope_entry: three calls, one run, two names. The refused
    // write is said on the folded line.
    expect(toolLines()).toEqual([
      ">_ Ran 3 commands · fetch_page, add_scope_entry 1 refused · 1 unresolved",
    ]);
    const run = document.querySelector<HTMLDetailsElement>(
      ".importer li.run > details",
    );
    expect(run?.open).toBe(false);
  });

  test("a single call reads 'Ran 1 command'", async () => {
    await openWith([
      OPERATOR("replay", 0, "Fetch it"),
      at("replay", 1, 1, {
        kind: "tool.call",
        headline: "fetch_page",
        tool: "fetch_page",
        toolName: "fetch_page",
        input: "{}",
        callId: "f1",
      }),
      at("replay", 2, 2, { kind: "turn.reply", body: "Fetched." }),
    ]);
    expect(toolLines()).toEqual([">_ Ran 1 command · fetch_page"]);
  });

  test("opened, each call is drawn as before: its signature, its answer and each write's state", async () => {
    const { fake } = await openWith(
      [OPERATOR("replay", 0, "Load the scope"), ...turnItems("replay", 1)],
      true,
    );
    // The first write's record arrives on the record channel.
    fake.watch.send(liveOpened({ from: 0, latest: 1 }));
    fake.watch.send(
      liveItem({
        id: "record:evt_1",
        origin: "record",
        sequence: 1,
        kind: "scope.entry.added",
        at: AT + 7_500,
        importId: "imp_a",
        headline: "acme.com",
        body: "acme.com in scope",
        tool: null,
        toolName: null,
        input: null,
        callId: null,
      }),
    );
    await settle();

    const run = document.querySelector<HTMLDetailsElement>(
      ".importer li.run > details",
    );
    if (run === null) throw new Error("no folded run");
    click(run.querySelector("summary") as Element);
    await settle();
    expect(run.open).toBe(true);
    const blocks = [...run.querySelectorAll(".calls > li.block")];
    expect(blocks.map((each) => each.getAttribute("data-write") ?? "")).toEqual(
      ["", "recorded", "refused"],
    );
    expect(said(blocks[0]?.querySelector(".sig"))).toBe(
      'fetch_page(url="https://hackerone.com/acme/policy")',
    );
    expect(said(blocks[1])).toContain("acme.com in scope");
    expect(said(blocks[1])).toContain("recorded");
    expect(said(blocks[2])).toContain("refused");
    expect(said(blocks[2])).toContain("nothing was written");
    // The parameters and output are one more disclosure away, as they were.
    expect(said(blocks[0]?.querySelector("details.raw > summary"))).toBe(
      "Full call",
    );
  });

  test("an unresolved write is said on the folded line, and announced", async () => {
    await openWith([
      OPERATOR("replay", 0, "Load the scope"),
      at("replay", 1, 1, {
        kind: "tool.call",
        headline: "add_scope_entry",
        tool: ours("add_scope_entry"),
        toolName: "add_scope_entry",
        input: '{"effect":"in","kind":"host","value":"lost.com"}',
        callId: "w9",
      }),
      at("replay", 2, 2, { kind: "turn.reply", body: "Done." }),
    ]);
    expect(toolLines()).toEqual([
      ">_ Ran 1 command · add_scope_entry 1 unresolved",
    ]);
    expect(
      document
        .querySelector(".importer li.run summary .attention")
        ?.getAttribute("role"),
    ).toBe("status");
  });
});

describe("U4: reasoning folds to one truncated line", () => {
  test("its first line, markdown off, shut; opened, the whole thought as markdown", async () => {
    await openWith([
      OPERATOR("replay", 0, "Load the scope"),
      ...turnItems("replay", 1),
    ]);
    const thought = document.querySelector<HTMLDetailsElement>(
      ".importer li.reasoning > details",
    );
    if (thought === null) throw new Error("no reasoning line");
    expect(thought.open).toBe(false);
    expect(said(thought.querySelector("summary .gist"))).toBe(
      "The program page is authoritative, so I read it first",
    );
    expect(said(thought.querySelector("summary"))).toContain(
      "What it considered",
    );
    click(thought.querySelector("summary") as Element);
    await settle();
    expect(thought.open).toBe(true);
    expect(said(thought.querySelector(".thought"))).toContain("then the SOW.");
    // Drawn as markdown: the emphasis is an element, not two asterisks.
    expect(thought.querySelector(".thought strong")?.textContent).toBe(
      "The program page",
    );
  });
});

describe("U4: a finished turn's footer", () => {
  test("names the agent, the model that answered and how long the turn took", async () => {
    await openWith([
      OPERATOR("replay", 0, "Load the scope"),
      ...turnItems("replay", 1),
    ]);
    // From the message (AT) to the turn's last item (AT + 41 s).
    expect(footers()).toEqual(["Importer · m-one · 41s"]);
  });

  test("after a switch mid-turn it names both models, in the order they answered", async () => {
    await openWith([
      OPERATOR("replay", 0, "Load the scope"),
      ...turnItems("replay", 1, ["claude-sonnet-4-5", "claude-haiku-4-5"]),
    ]);
    expect(footers()).toEqual([
      "Importer · claude-sonnet-4-5 → claude-haiku-4-5 · 41s",
    ]);
  });
});

describe("U4: a message sent while a turn runs", () => {
  const MESSAGE_ID = "aaaaaaaabbbbbbbbccccccccdddddddd";

  test("is drawn queued, the running turn's work stays above it, and once taken it is an ordinary turn", async () => {
    const { app, fake } = await openWith(
      [OPERATOR("replay", 0, "Load the scope")],
      true,
    );
    fake.watch.send(liveOpened({ from: 0, latest: 0 }));
    fake.watch.send(
      at("activity", 1, 1, { kind: "turn.reply", body: "Reading the page." }),
    );
    await settle();
    expect(app.importer.current?.working).toBe(true);
    fake.onSendImporterMessage = (_baseUrl, targetId, importId) =>
      ok(
        importerTurnAccepted({
          targetId,
          importId,
          harnessSessionId: "ses_a",
          messageId: MESSAGE_ID,
          acceptedAt: AT + 5_000,
        }),
      );
    await send("Also the partner portal");

    // The running turn goes on after the message was sent: its call and result land.
    fake.watch.send(
      at("activity", 2, 6, {
        kind: "tool.call",
        headline: "fetch_page",
        tool: "fetch_page",
        toolName: "fetch_page",
        input: "{}",
        callId: "f1",
      }),
    );
    fake.watch.send(
      at("activity", 3, 7, { kind: "turn.reply", body: "Six rows in scope." }),
    );
    await settle();

    const [first, second] = groups();
    expect(said(second?.querySelector(".bubble"))).toBe(
      "Also the partner portal",
    );
    expect(second?.querySelector(".you")?.classList.contains("queued")).toBe(
      true,
    );
    expect(said(second?.querySelector(".said"))).toBe(
      `queued You · ${clock(AT + 5_000)}`,
    );
    expect(said(second)).toContain(QUEUED_NOTE);
    // The running turn's work is its own, above the queued message.
    expect(said(first)).toContain("Six rows in scope.");
    expect(said(first?.querySelector("li.run summary"))).toBe(
      ">_ Ran 1 command · fetch_page",
    );
    expect(said(second)).not.toContain("Six rows in scope.");

    // A result for that call lands after the harness took the message: it still folds
    // into its call's row, in the first turn.
    fake.watch.send(
      at("activity", 4, 9, {
        kind: "turn.taken",
        headline: "Taken",
        messageIds: [MESSAGE_ID],
      }),
    );
    fake.watch.send(
      at("activity", 5, 10, {
        kind: "tool.result",
        headline: "fetch_page",
        tool: "fetch_page",
        toolName: "fetch_page",
        output: "nine rows",
        callId: "f1",
        outcome: "ok",
      }),
    );
    fake.watch.send(
      at("activity", 6, 12, {
        kind: "turn.reply",
        body: "Adding the partner portal.",
        model: "m-two",
      }),
    );
    await settle();

    const [one, two] = groups();
    expect(two?.querySelector(".you")?.classList.contains("queued")).toBe(
      false,
    );
    expect(said(two?.querySelector(".said"))).toBe(
      `You · ${clock(AT + 5_000)}`,
    );
    expect(said(two)).not.toContain(QUEUED_NOTE);
    expect(said(two)).toContain("Adding the partner portal.");
    expect(said(one)).not.toContain("Adding the partner portal.");
    // The late result is in its call's row, not a row of its own under the second turn.
    expect(two?.querySelectorAll("li.run")).toHaveLength(0);
    expect(one?.querySelectorAll("li.run")).toHaveLength(1);
    expect(said(one?.querySelector("li.run .ret"))).toBe("→ nine rows");
    // The take itself is never drawn.
    expect(said(document.querySelector(".importer"))).not.toContain("Taken");

    // Its footer's duration runs from the take (AT + 9 s) to its last item (AT + 12 s).
    // The transcript stores the message when the harness takes it.
    transcriptOnceSettled(fake, [
      OPERATOR("replay", 0, "Load the scope"),
      at("replay", 1, 1, { kind: "turn.reply", body: "Reading the page." }),
      at("replay", 2, 6, {
        kind: "tool.call",
        headline: "fetch_page",
        tool: "fetch_page",
        toolName: "fetch_page",
        input: "{}",
        callId: "f1",
      }),
      at("replay", 3, 7, { kind: "turn.reply", body: "Six rows in scope." }),
      at("replay", 4, 9, {
        kind: "turn.operator",
        headline: "You",
        body: "Also the partner portal",
        messageIds: [MESSAGE_ID],
      }),
      at("replay", 5, 10, {
        kind: "tool.result",
        headline: "fetch_page",
        tool: "fetch_page",
        toolName: "fetch_page",
        output: "nine rows",
        callId: "f1",
        outcome: "ok",
      }),
      at("replay", 6, 12, {
        kind: "turn.reply",
        body: "Adding the partner portal.",
        model: "m-two",
      }),
    ]);
    await endTurn(app, fake);
    expect(footers().at(-1)).toBe("Importer · m-two · 3s");
  });

  test("a message sent while nothing runs is never drawn queued", async () => {
    const { fake } = await openWith([OPERATOR("replay", 0, "Load the scope")]);
    fake.watch.send(liveOpened({ from: 0, latest: 0 }));
    fake.onSendImporterMessage = (_baseUrl, targetId, importId) =>
      ok(
        importerTurnAccepted({
          targetId,
          importId,
          harnessSessionId: "ses_a",
          messageId: MESSAGE_ID,
        }),
      );
    await send("Also the partner portal");
    expect(document.querySelectorAll(".importer .you.queued")).toHaveLength(0);
    expect(said(document.querySelector(".importer"))).not.toContain(
      QUEUED_NOTE,
    );
  });

  /*
   * A6 U4 review 3: Claude Code takes two steers queued behind one turn as one message, and
   * answers it once. The tab drew two turns, the first "wrote nothing in reply" — which was
   * false. One bubble with both texts in order, one reply, one footer.
   */
  test("two messages the harness took as one are one turn: one bubble, one reply, one footer", async () => {
    const OTHER_ID = "11111111222222223333333344444444";
    const { app, fake } = await openWith(
      [OPERATOR("replay", 0, "Load the scope")],
      true,
    );
    fake.watch.send(liveOpened({ from: 0, latest: 0 }));
    fake.watch.send(
      at("activity", 1, 1, { kind: "turn.reply", body: "Reading the page." }),
    );
    await settle();
    let next = 0;
    fake.onSendImporterMessage = (_baseUrl, targetId, importId) => {
      next += 1;
      return ok(
        importerTurnAccepted({
          targetId,
          importId,
          harnessSessionId: "ses_a",
          messageId: next === 1 ? MESSAGE_ID : OTHER_ID,
          acceptedAt: AT + 4_000 + next * 1_000,
        }),
      );
    };
    await send("MG-PAGE");
    await send("MG-OTHER");
    fake.watch.send(
      at("activity", 2, 8, {
        kind: "turn.taken",
        headline: "Taken",
        messageIds: [MESSAGE_ID, OTHER_ID],
      }),
    );
    fake.watch.send(
      at("activity", 3, 11, {
        kind: "turn.reply",
        body: "Both noted.",
        model: "m-two",
      }),
    );
    await settle();
    // Claude Code stores the steers it took together as one entry, at the take.
    transcriptOnceSettled(fake, [
      OPERATOR("replay", 0, "Load the scope"),
      at("replay", 1, 1, { kind: "turn.reply", body: "Reading the page." }),
      at("replay", 2, 8, {
        kind: "turn.operator",
        headline: "You",
        body: "MG-PAGE\nMG-OTHER",
        messageIds: [MESSAGE_ID, OTHER_ID],
      }),
      at("replay", 3, 11, {
        kind: "turn.reply",
        body: "Both noted.",
        model: "m-two",
      }),
    ]);
    await endTurn(app, fake);

    const drawn = groups();
    expect(drawn).toHaveLength(2);
    const merged = drawn[1];
    // Both texts, in the order they were sent, a line apart (`said` folds the break).
    expect(said(merged?.querySelector(".bubble"))).toBe("MG-PAGE MG-OTHER");
    expect(said(merged)).toContain("Both noted.");
    expect(said(document.querySelector(".importer"))).not.toContain(
      "wrote nothing in reply",
    );
    // From the take (AT + 8 s) to the reply (AT + 11 s).
    expect(footers()).toEqual([
      expect.stringContaining("Importer"),
      "Importer · m-two · 3s",
    ]);
  });
});

/*
 * A6 U6 review 2: a Send now that lands before the turn it cuts has written anything.
 * Claude Code ends that turn with only its own diagnostic, which bit drew as a red error
 * live, and after a reload as a message with no reply — while the next reply answers both.
 */
describe("U6: a message carried on with the Send now after it", () => {
  const MESSAGE_ID = "aaaaaaaabbbbbbbbccccccccdddddddd";
  const OTHER_ID = "11111111222222223333333344444444";
  const ERROR_HEAD = "The harness stopped this turn with an error";

  test("live: its turn says it was answered with the next message, with no error and no 'wrote nothing'", async () => {
    const { app, fake } = await openWith([
      OPERATOR("replay", 0, "Load the scope"),
      at("replay", 1, 1, { kind: "turn.reply", body: "Loaded." }),
    ]);
    fake.watch.send(liveOpened({ from: 0, latest: 0 }));
    await settle();
    let next = 0;
    fake.onSendImporterMessage = (_baseUrl, targetId, importId) => {
      next += 1;
      return ok(
        importerTurnAccepted({
          targetId,
          importId,
          harnessSessionId: "ses_a",
          messageId: next === 1 ? MESSAGE_ID : OTHER_ID,
          acceptedAt: AT + 4_000 + next * 300,
        }),
      );
    };
    await send("What is 2+2?");
    fake.watch.send(
      at("activity", 1, 4, {
        kind: "turn.taken",
        headline: "Taken",
        messageIds: [MESSAGE_ID],
      }),
    );
    await settle();
    await send("Also name a colour.");
    // The cut turn ends with nothing written, and its message goes on with the Send now.
    fake.watch.send(
      at("activity", 2, 5, {
        kind: "turn.carried",
        headline: "Went on with the next message",
        messageIds: [MESSAGE_ID],
      }),
    );
    fake.watch.send(
      at("activity", 3, 5, {
        kind: "turn.taken",
        headline: "Taken",
        messageIds: [OTHER_ID],
      }),
    );
    fake.watch.send(
      at("activity", 4, 7, {
        kind: "turn.reply",
        body: "Two plus two equals four. Blue.",
        model: "m-two",
      }),
    );
    await settle();
    // While it is watched, before any re-read of the settled turn.
    const watched = groups().map((group) => said(group));
    expect(watched[1]).toContain(CARRIED_NOTE);
    expect(watched[1]).not.toContain("wrote nothing in reply");
    expect(watched[2]).toContain("Two plus two equals four. Blue.");
    transcriptOnceSettled(fake, [
      OPERATOR("replay", 0, "Load the scope"),
      at("replay", 1, 1, { kind: "turn.reply", body: "Loaded." }),
      at("replay", 2, 4, {
        kind: "turn.operator",
        headline: "You",
        body: "What is 2+2?",
        messageIds: [MESSAGE_ID],
      }),
      at("replay", 3, 5, {
        kind: "turn.carried",
        headline: "Went on with the next message",
        messageIds: [MESSAGE_ID],
      }),
      at("replay", 4, 5, {
        kind: "turn.operator",
        headline: "You",
        body: "Also name a colour.",
        messageIds: [OTHER_ID],
      }),
      at("replay", 5, 7, {
        kind: "turn.reply",
        body: "Two plus two equals four. Blue.",
        model: "m-two",
      }),
    ]);
    await endTurn(app, fake);

    const drawn = groups().map((group) => said(group));
    expect(drawn).toHaveLength(3);
    expect(drawn[1]).toContain("What is 2+2?");
    expect(drawn[1]).toContain(CARRIED_NOTE);
    expect(drawn[2]).toContain("Also name a colour.");
    expect(drawn[2]).toContain("Two plus two equals four. Blue.");
    const page = said(document.querySelector(".importer"));
    expect(page).not.toContain(ERROR_HEAD);
    expect(page).not.toContain("wrote nothing in reply");
    expect(page).not.toContain("no reply to it");
    // The carry is a note, never a row of its own.
    expect(
      document.querySelectorAll(".importer li.harness-error"),
    ).toHaveLength(0);
    expect(drawn[1]).not.toContain("Went on with the next message ");
  });

  test("after a reload: the two stored messages in a row draw the first as answered with the second", async () => {
    await openWith([
      OPERATOR("replay", 0, "What is 2+2?"),
      at("replay", 1, 0, {
        kind: "turn.carried",
        headline: "Went on with the next message",
      }),
      OPERATOR("replay", 2, "Also name a colour."),
      at("replay", 3, 2, {
        kind: "turn.reply",
        body: "Two plus two equals four. Blue.",
      }),
    ]);
    const drawn = groups().map((group) => said(group));
    expect(drawn).toHaveLength(2);
    expect(drawn[0]).toContain(CARRIED_NOTE);
    expect(drawn[0]).not.toContain("no reply to it");
    expect(drawn[1]).toContain("Two plus two equals four. Blue.");
  });

  /**
   * Live, the page's own two sends: A, then B with a Send now, the server answering with
   * `MESSAGE_ID` then `OTHER_ID`; A taken, and its turn ended before it wrote anything,
   * carried on with B; B taken. What happens in B's turn is the caller's.
   */
  const sendThenSendNow = async () => {
    const opened = await openWith([
      OPERATOR("replay", 0, "Load the scope"),
      at("replay", 1, 1, { kind: "turn.reply", body: "Loaded." }),
    ]);
    const { fake } = opened;
    fake.watch.send(liveOpened({ from: 0, latest: 0 }));
    await settle();
    let next = 0;
    fake.onSendImporterMessage = (_baseUrl, targetId, importId) => {
      next += 1;
      return ok(
        importerTurnAccepted({
          targetId,
          importId,
          harnessSessionId: "ses_a",
          messageId: next === 1 ? MESSAGE_ID : OTHER_ID,
          acceptedAt: AT + 4_000 + next * 300,
        }),
      );
    };
    await send("What is 2+2?");
    fake.watch.send(
      at("activity", 1, 4, {
        kind: "turn.taken",
        headline: "Taken",
        messageIds: [MESSAGE_ID],
      }),
    );
    await settle();
    await send("Also name a colour.");
    return opened;
  };

  /** What the harness stores for that run, A's turn as `aTurn` reads it. */
  const stored = (aTurn: readonly LiveItem[], bTurn: readonly LiveItem[]) => [
    OPERATOR("replay", 0, "Load the scope"),
    at("replay", 1, 1, { kind: "turn.reply", body: "Loaded." }),
    at("replay", 2, 4, {
      kind: "turn.operator",
      headline: "You",
      body: "What is 2+2?",
      messageIds: [MESSAGE_ID],
    }),
    ...aTurn,
    at("replay", 20, 5, {
      kind: "turn.operator",
      headline: "You",
      body: "Also name a colour.",
      messageIds: [OTHER_ID],
    }),
    ...bTurn,
  ];

  const STOP_MARKER = (space: "activity" | "replay", n: number) =>
    at(space, n, 5, {
      kind: "turn.other",
      headline: "interrupted",
      body: "[Request interrupted by user]",
    });

  test("U6 review 3: A, Send now B, then a Stop — A went on with B, B reads stopped, and nothing promises a reply", async () => {
    const { app, fake } = await sendThenSendNow();
    fake.watch.send(
      at("activity", 2, 5, {
        kind: "turn.carried",
        headline: "Went on with the next message",
        messageIds: [MESSAGE_ID],
      }),
    );
    fake.watch.send(
      at("activity", 3, 5, {
        kind: "turn.taken",
        headline: "Taken",
        messageIds: [OTHER_ID],
      }),
    );
    // The Stop lands on B's turn: the CLI's marker, live.
    fake.watch.send(STOP_MARKER("activity", 4));
    await settle();
    const check = () => {
      const drawn = groups().map((group) => said(group));
      expect(drawn).toHaveLength(3);
      expect(drawn[1]).toContain(CARRIED_NOTE);
      expect(drawn[2]).toContain("Also name a colour.");
      expect(drawn[2]).toContain(STOPPED_NOTE);
      const page = said(document.querySelector(".importer"));
      expect(page).not.toMatch(/answers both|reply below/);
      expect(page).not.toContain("has not answered yet");
      expect(page).not.toContain("[Request interrupted by user]");
    };
    check();
    transcriptOnceSettled(
      fake,
      stored(
        [
          at("replay", 3, 5, {
            kind: "turn.carried",
            headline: "Went on with the next message",
            messageIds: [MESSAGE_ID],
          }),
        ],
        [STOP_MARKER("replay", 21)],
      ),
    );
    await endTurn(app, fake);
    check();
  });

  test("U6 review 3: A, Send now B, then a Stop — the same after a reload", async () => {
    await openWith(
      stored(
        [
          at("replay", 3, 5, {
            kind: "turn.carried",
            headline: "Went on with the next message",
            messageIds: [MESSAGE_ID],
          }),
        ],
        [STOP_MARKER("replay", 21)],
      ),
    );
    const drawn = groups().map((group) => said(group));
    expect(drawn).toHaveLength(3);
    expect(drawn[1]).toContain(CARRIED_NOTE);
    expect(drawn[2]).toContain(STOPPED_NOTE);
    const page = said(document.querySelector(".importer"));
    expect(page).not.toContain("no reply to it");
    expect(page).not.toContain("[Request interrupted by user]");
  });

  test("U6 review 3: a carried turn that wrote something reads as what it wrote, never as carried", async () => {
    // A carry naming a turn that has rows: a Send now taken after a tool call. The server
    // no longer sends one (it needs a turn that wrote nothing), and the page draws none.
    const { app, fake } = await sendThenSendNow();
    fake.watch.send(
      at("activity", 2, 4, { kind: "turn.reply", body: "Reading the scope." }),
    );
    fake.watch.send(
      at("activity", 3, 5, {
        kind: "turn.carried",
        headline: "Went on with the next message",
        messageIds: [MESSAGE_ID],
      }),
    );
    fake.watch.send(
      at("activity", 4, 5, {
        kind: "turn.taken",
        headline: "Taken",
        messageIds: [OTHER_ID],
      }),
    );
    fake.watch.send(
      at("activity", 5, 7, { kind: "turn.reply", body: "Blue." }),
    );
    await settle();
    const drawn = groups().map((group) => said(group));
    expect(drawn[1]).toContain("Reading the scope.");
    expect(drawn[1]).not.toContain(CARRIED_NOTE);
    expect(drawn[2]).toContain("Blue.");
    transcriptOnceSettled(
      fake,
      stored(
        [
          at("replay", 3, 4, {
            kind: "turn.reply",
            body: "Reading the scope.",
          }),
        ],
        [at("replay", 21, 7, { kind: "turn.reply", body: "Blue." })],
      ),
    );
    await endTurn(app, fake);
    const settled = groups().map((group) => said(group));
    expect(settled[1]).toContain("Reading the scope.");
    expect(settled[1]).not.toContain(CARRIED_NOTE);
  });

  test("after a reload, a last message with nothing after it still says the harness holds no reply", async () => {
    // The server writes no carry for it, and the page invents none.
    await openWith([
      OPERATOR("replay", 0, "Load the scope"),
      at("replay", 1, 1, { kind: "turn.reply", body: "Loaded." }),
      OPERATOR("replay", 2, "Are you there?"),
    ]);
    const drawn = groups().map((group) => said(group));
    expect(drawn.at(-1)).toContain(
      "The harness holds this message and no reply to it.",
    );
    expect(drawn.at(-1)).not.toContain(CARRIED_NOTE);
  });
});

describe("U4: a harness's own error", () => {
  test("is the harness's sentence in the thread, marked, not 'wrote nothing in reply'", async () => {
    const { app, fake } = await openWith([
      OPERATOR("replay", 0, "Load the scope"),
    ]);
    fake.watch.send(liveOpened({ from: 0, latest: 0 }));
    await send("Try again");
    fake.watch.send(
      at("activity", 1, 1, {
        kind: "turn.other",
        headline: "error",
        body: "Free usage limit reached. Visit ‮opencode.ai",
        outcome: "failed",
      }),
    );
    await settle();
    await endTurn(app, fake);
    const error = document.querySelector(".importer li.harness-error");
    expect(said(error)).toBe(
      "activity The harness stopped this turn with an error: Free usage limit reached. Visit ⟨U+202E⟩opencode.ai",
    );
    expect(error?.querySelectorAll(".char-escape")).toHaveLength(1);
    expect(said(document.querySelector(".importer"))).not.toContain(
      "wrote nothing in reply",
    );
    // A turn with no reply text still gets its footer (A6 U4 review): it ran on a model and
    // took time. No Copy, since there are no words to copy.
    expect(footers().at(-1)).toMatch(/^Importer · openai\/gpt-5\.6-sol/u);
    expect(
      [...document.querySelectorAll(".importer .foot")]
        .at(-1)
        ?.querySelectorAll("button"),
    ).toHaveLength(0);
  });

  test("a turn stopped after a tool call, before it answered, gets its footer too", async () => {
    await openWith([
      OPERATOR("replay", 0, "Load the scope"),
      at("replay", 1, 3, {
        kind: "tool.call",
        headline: "fetch_page",
        tool: "fetch_page",
        toolName: "fetch_page",
        input: "{}",
        callId: "f1",
        model: "m-one",
      }),
      at("replay", 2, 5, {
        kind: "turn.other",
        headline: "interrupted",
        body: "[Request interrupted by user for tool use]",
      }),
    ]);
    // Ends at the call (3 s): the interrupt note is the harness's, and live draws none.
    expect(footers()).toEqual(["Importer · m-one · 3s"]);
  });
});

/*
 * A6 U4 review: a message the harness has not taken is in no transcript, so a reload drew
 * it nowhere and its reply joined the turn before. The server's replay carries it now.
 */
describe("U4 review: a queued message across a reload", () => {
  const MESSAGE_ID = "aaaaaaaabbbbbbbbccccccccdddddddd";

  test("a reload while it waits draws it queued; once taken it is its own turn", async () => {
    const { fake } = await openWith(
      [OPERATOR("replay", 0, "Load the scope"), ...turnItems("replay", 1)],
      true,
      [
        {
          messageId: MESSAGE_ID,
          text: "Also the partner portal",
          acceptedAt: AT + 50_000,
          taken: false,
        },
      ],
    );
    fake.watch.send(liveOpened({ from: 0, latest: 0 }));
    fake.watch.send(
      at("activity", 101, 52, {
        kind: "turn.reply",
        body: "Still on the policy.",
      }),
    );
    await settle();
    const [first, second] = groups();
    expect(said(second?.querySelector(".bubble"))).toBe(
      "Also the partner portal",
    );
    expect(second?.querySelector(".you")?.classList.contains("queued")).toBe(
      true,
    );
    expect(said(second)).toContain(QUEUED_NOTE);
    expect(said(first)).toContain("Still on the policy.");

    fake.watch.send(
      at("activity", 102, 55, {
        kind: "turn.taken",
        headline: "Taken",
        messageIds: [MESSAGE_ID],
      }),
    );
    fake.watch.send(
      at("activity", 103, 58, {
        kind: "turn.reply",
        body: "Adding the partner portal.",
        model: "m-two",
      }),
    );
    await settle();
    const [one, two] = groups();
    expect(two?.querySelector(".you")?.classList.contains("queued")).toBe(
      false,
    );
    expect(said(two?.querySelector(".said"))).toBe(
      `You · ${clock(AT + 50_000)}`,
    );
    expect(said(two)).toContain("Adding the partner portal.");
    expect(said(one)).not.toContain("Adding the partner portal.");
  });

  test("a take naming a message this tab has no row for reads the replay again", async () => {
    const { fake } = await openWith(
      [OPERATOR("replay", 0, "Load the scope"), ...turnItems("replay", 1)],
      true,
    );
    let reads = 0;
    // Sent from another tab: the harness took it, and the transcript holds it now.
    fake.onImporterMessages = (_baseUrl, targetId, importId) => {
      reads += 1;
      return ok(
        importerConversationView({
          targetId,
          importId,
          harnessSessionId: "ses_a",
          live: true,
          continuation: "live",
          items: [
            OPERATOR("replay", 0, "Load the scope"),
            ...turnItems("replay", 1),
            OPERATOR("replay", 20, "From the other tab"),
          ],
        }),
      );
    };
    fake.watch.send(liveOpened({ from: 0, latest: 0 }));
    fake.watch.send(
      at("activity", 201, 60, {
        kind: "turn.taken",
        headline: "Taken",
        messageIds: [MESSAGE_ID],
      }),
    );
    fake.watch.send(
      at("activity", 202, 62, {
        kind: "turn.reply",
        body: "On the other tab's message.",
      }),
    );
    await settle();
    expect(reads).toBe(1);
    const all = groups();
    expect(all.map((group) => said(group.querySelector(".bubble")))).toEqual([
      "Load the scope",
      "From the other tab",
    ]);
    expect(said(all[1])).toContain("On the other tab's message.");
    expect(said(all[0])).not.toContain("On the other tab's message.");
  });

  test("a take read before the harness has written the message still draws it, as its own turn with its reply (U4 review 2)", async () => {
    // A busy session: the turn before is still running when the other tab's steer is taken.
    const { fake } = await openWith(
      [OPERATOR("replay", 0, "Load the scope"), ...turnItems("replay", 1)],
      true,
    );
    let reads = 0;
    /*
     * Claude Code narrates the take 30–130 ms before its transcript holds the message, so a
     * read on the take finds it not in `items`: the server still holds it, marked taken.
     */
    fake.onImporterMessages = (_baseUrl, targetId, importId) => {
      reads += 1;
      return ok(
        importerConversationView({
          targetId,
          importId,
          harnessSessionId: "ses_a",
          live: true,
          continuation: "live",
          items: [
            OPERATOR("replay", 0, "Load the scope"),
            ...turnItems("replay", 1),
          ],
          queued: [
            {
              messageId: MESSAGE_ID,
              text: "From the other tab",
              acceptedAt: AT + 59_000,
              taken: true,
            },
          ],
        }),
      );
    };
    fake.watch.send(liveOpened({ from: 0, latest: 0 }));
    fake.watch.send(
      at("activity", 300, 58, {
        kind: "turn.reply",
        body: "Last words of the turn before.",
      }),
    );
    fake.watch.send(
      at("activity", 301, 60, {
        kind: "turn.taken",
        headline: "Taken",
        messageIds: [MESSAGE_ID],
      }),
    );
    await settle();
    fake.watch.send(
      at("activity", 302, 62, {
        kind: "turn.reply",
        body: "On the other tab's message.",
      }),
    );
    // The same take seen again (another frame naming it) asks for nothing more.
    fake.watch.send(
      at("activity", 303, 63, {
        kind: "turn.taken",
        headline: "Taken",
        messageIds: [MESSAGE_ID],
      }),
    );
    await settle();
    expect(reads).toBe(1);
    const all = groups();
    expect(all.map((group) => said(group.querySelector(".bubble")))).toEqual([
      "Load the scope",
      "From the other tab",
    ]);
    expect(all[1]?.querySelector(".you")?.classList.contains("queued")).toBe(
      false,
    );
    expect(said(all[1])).toContain("On the other tab's message.");
    expect(said(all[0])).not.toContain("On the other tab's message.");
  });

  test("a take that slides out of the live window does not put its message back in the queue", async () => {
    const { app, fake } = await openWith(
      [OPERATOR("replay", 0, "Load the scope")],
      true,
    );
    fake.watch.send(liveOpened({ from: 0, latest: 0 }));
    fake.onSendImporterMessage = (_baseUrl, targetId, importId) =>
      ok(
        importerTurnAccepted({
          targetId,
          importId,
          harnessSessionId: "ses_a",
          messageId: MESSAGE_ID,
          acceptedAt: AT + 5_000,
        }),
      );
    await send("Also the partner portal");
    fake.watch.send(
      at("activity", 1, 9, {
        kind: "turn.taken",
        headline: "Taken",
        messageIds: [MESSAGE_ID],
      }),
    );
    fake.watch.send(
      at("activity", 2, 10, {
        kind: "turn.reply",
        body: "Adding the partner portal.",
      }),
    );
    // Another import's chatter, enough to push both out of the tab's window.
    for (let n = 0; n < App.LIVE_KEPT; n += 1) {
      fake.watch.send(
        at("activity", 1_000 + n, 11, {
          kind: "turn.reply",
          body: "elsewhere",
          importId: "imp_other",
        }),
      );
    }
    await settle();
    expect(app.liveItems.some((item) => item.kind === "turn.taken")).toBe(
      false,
    );
    const [, second] = groups();
    expect(second?.querySelector(".you")?.classList.contains("queued")).toBe(
      false,
    );
    expect(said(second)).not.toContain(QUEUED_NOTE);
  });
});

describe("U4 review 2: the harness's note on a replay", () => {
  test("is said once a thread, not under every replayed turn", async () => {
    await openWith([
      OPERATOR("replay", 0, "Load the scope"),
      at("replay", 1, 1, { kind: "turn.reply", body: "Loaded." }),
      OPERATOR("replay", 2, "And the portal"),
      at("replay", 3, 3, { kind: "turn.reply", body: "Added." }),
      OPERATOR("replay", 4, "And the API"),
      at("replay", 5, 5, { kind: "turn.reply", body: "Added too." }),
    ]);
    expect(groups().length).toBe(3);
    const notes = [
      ...document.querySelectorAll('.importer [role="log"] .note'),
    ].filter((each) => said(each).includes("which may delete it"));
    expect(notes.length).toBe(1);
    expect(said(groups()[0])).toContain("which may delete it");
  });
});

describe("U4: live and replay draw the same thread", () => {
  /** Each group as strings: the bubble and its line, then each entry's kind and words. */
  const digest = (): string[][] =>
    groups().map((group) => [
      said(group.querySelector(".bubble")),
      said(group.querySelector(".said")),
      ...[...group.querySelectorAll(":scope > .items > li")].map(
        (each) =>
          `${[...each.classList].filter((name) => !name.startsWith("svelte-")).join(".")}: ${said(each)}`,
      ),
    ]);

  test("the same items, replayed or arriving live, are the same rows, lines and footer", async () => {
    const replayed = await openWith([
      OPERATOR("replay", 0, "Load the scope"),
      ...turnItems("replay", 1, ["m-one", "m-two"]),
    ]);
    const fromReplay = digest();
    for (const each of mounted) each.destroy();
    mounted = [];
    void replayed;

    const { app, fake } = await openWith([]);
    fake.watch.send(liveOpened({ from: 0, latest: 0 }));
    fake.onSendImporterMessage = (_baseUrl, targetId, importId) =>
      ok(
        importerTurnAccepted({
          targetId,
          importId,
          harnessSessionId: "ses_a",
          acceptedAt: AT,
        }),
      );
    await send("Load the scope");
    for (const item of turnItems("activity", 1, ["m-one", "m-two"])) {
      fake.watch.send(item);
    }
    await settle();
    await endTurn(app, fake);

    expect(fromReplay.length).toBe(1);
    expect(digest()).toEqual(fromReplay);
  });
});
