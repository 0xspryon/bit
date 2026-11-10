/**
 * The importer's grouping rule, and the figures the picker prints.
 *
 * `importerChat.ts` is a plain module for `chat.ts`'s reason: every claim the importer chat
 * makes about **what happened** is decided there, and a `.svelte` file cannot be imported by
 * `bun test`. The rule under test is the one the design rests on — *one group per operator
 * message* — and the things it must never get wrong: which group a tool call lands in,
 * whether a write that produced no record is still `pending` or already `unresolved`, and
 * which of `Chat`'s prose states an empty-looking group is in.
 */
import { describe, expect, test } from "bun:test";

import {
  IMPORTER_MESSAGE_MAX_CHARS,
  bitMcpServerName,
  claudeCodeToolName,
  type LiveItem,
  type ScopeImportTool,
} from "@bit/contracts";

import {
  PARTIAL_BODY_MAX,
  callSignature,
  operatorTurn,
  resultLine,
  streamStates,
} from "../src/lib/chat";
import {
  CARRIED_NOTE,
  LOADING_HISTORY,
  MID_BLOCK_NOTE,
  NO_HISTORY,
  sessionHover,
  sessionLabel,
  sessionStarted,
  sessionWhen,
  messageTooLong,
  type ConversationHistory as ImporterHistory,
  historyOf,
  takesUnknownMessage,
  withReplay,
} from "../src/lib/conversationChat";
import {
  QUEUED_NOTE,
  STOPPED_NOTE,
  buildImporterChat,
  importerFeed,
  indexedSession,
  lastSessionSentence,
  readingNote,
  tallyLine,
  type ImporterSession,
  acceptedNotice,
} from "../src/lib/importerChat";
import {
  importerConversationView,
  importerSessionView,
  replayItem,
} from "./fakeServer";
import {
  mockCompletedSession,
  mockReloadedSession,
} from "../src/lib/mockImporter";

let order = 0;
const AT = 1_700_000_000_000;

const item = (over: Partial<LiveItem> & Pick<LiveItem, "kind">): LiveItem => {
  order += 1;
  return {
    _tag: "item",
    id: `activity:${String(order)}`,
    origin: "activity",
    sequence: null,
    at: AT + order,
    attemptId: null,
    roundId: null,
    goalId: null,
    importId: null,
    headline: "",
    body: "",
    tool: null,
    toolName: null,
    input: null,
    output: null,
    callId: null,
    outcome: null,
    ...over,
  };
};

const operator = (index: number, text: string): LiveItem =>
  operatorTurn({ index, text, at: AT + index, after: 0 });
const reply = (body: string): LiveItem =>
  item({ kind: "turn.reply", headline: "Importer", body });
/**
 * A call to one of the importer's three tools, named the way a harness names it.
 *
 * Built from `mcpToolName.ts` and typed by `ScopeImportTool`, not typed out: the merge rule
 * shipped broken once because fixtures fabricated a tool-name space the system never
 * produces, and a tool name that matches nothing in `WRITE_TOOLS` fails silently.
 */
const call = (
  name: ScopeImportTool,
  callId: string,
  input: Record<string, unknown>,
): LiveItem =>
  item({
    kind: "tool.call",
    headline: name,
    tool: claudeCodeToolName(bitMcpServerName("imp_1"), name),
    toolName: name,
    callId,
    input: JSON.stringify(input),
  });
const write = (callId: string, value: string): LiveItem =>
  call("add_scope_entry", callId, {
    effect: "in",
    kind: "host",
    value,
    source_url: "https://hackerone.com/acme/policy",
    note: "a row",
  });
const record = (kind: string, value: string): LiveItem => {
  order += 1;
  return item({
    kind,
    id: `record:evt_${String(order)}`,
    origin: "record",
    sequence: order,
    headline: value,
    body: `${value} in scope`,
  });
};
const entryRecord = (value: string): LiveItem =>
  record("scope.entry.added", value);

const history = (over: Partial<ImporterHistory>): ImporterHistory => ({
  ...NO_HISTORY,
  ...over,
});

describe("one group per operator message", () => {
  test("a reply and its tool calls belong to the message before them, not the one after", () => {
    const groups = buildImporterChat({
      history: NO_HISTORY,
      working: false,
      items: [
        operator(1, "load the policy"),
        reply("reading it"),
        write("c1", "acme.com"),
        entryRecord("acme.com"),
        operator(2, "and the portal too"),
        reply("adding it"),
        write("c2", "app.partner.com"),
        entryRecord("app.partner.com"),
      ],
    });

    expect(groups.map((group) => group.subject.message)).toEqual([
      "load the policy",
      "and the portal too",
    ]);
    // A call folds into the record it produced, so each turn is a reply and one write.
    expect(groups.map((group) => group.rows.length)).toEqual([2, 2]);
    expect(groups[0]?.rows[1]?.item.headline).toBe("acme.com");
    expect(groups[1]?.rows[1]?.item.headline).toBe("app.partner.com");
    // The operator's own row is the heading, not also a row under it.
    expect(
      groups
        .flatMap((group) => group.rows)
        .some((row) => row.item.kind === "turn.operator"),
    ).toBe(false);
  });

  test("anything before the first message is 'earlier in this session', not folded into it", () => {
    const groups = buildImporterChat({
      history: NO_HISTORY,
      working: false,
      items: [entryRecord("old.example"), operator(1, "continue")],
    });

    expect(groups.map((group) => group.key)).toEqual(["earlier", "turn:1"]);
    expect(groups[0]?.subject.message).toBeNull();
    // Said, not silent: nothing ties a record to the message it answered.
    expect(groups[0]?.prose).toMatchObject({ _tag: "none" });
    expect(groups[0]?.prose._tag === "none" && groups[0].prose.note).toContain(
      "Nothing on the record says which message",
    );
  });

  test("an absence is said before anything else, and only while there is nothing else", () => {
    /*
     * Each absence gets the leading group while the session is otherwise empty, and loses it
     * once there is a turn to speak for itself. That changed with S6: until then an indexed
     * session carried a stand-in `pending` note saying this page could not read its words,
     * and that note had to survive the first message. The page reads them now, so `pending`
     * means what the server means by it — a session that has not spoken yet — and a turn's
     * own prose says that better than a group above it.
     */
    expect(
      buildImporterChat({
        history: LOADING_HISTORY,
        working: false,
        items: [],
      }).map((group) => group.key),
    ).toEqual(["earlier"]);
    expect(
      buildImporterChat({
        history: LOADING_HISTORY,
        working: false,
        items: [operator(1, "also the staging hosts")],
      }).map((group) => group.key),
    ).toEqual(["turn:1"]);
    // And nothing is said when there is nothing to say: a plain history opens at the turn.
    expect(
      buildImporterChat({
        history: NO_HISTORY,
        working: false,
        items: [operator(1, "go")],
      }).map((group) => group.key),
    ).toEqual(["turn:1"]);
  });

  test("an import nobody ever said anything in says so, in the server's words", () => {
    // `absent` is not an absence of words but an absence of a conversation: the row was
    // written before the session existed and the session was never created. Reporting it
    // with the harness's "I no longer hold that session" would tell an operator their
    // message had been lost.
    const note = "Nothing was ever said in import imp_7.";
    const groups = buildImporterChat({
      history: history({ source: "absent", note }),
      working: false,
      items: [],
    });
    expect(groups.map((group) => group.key)).toEqual(["earlier"]);
    expect(groups[0]?.prose).toEqual({ _tag: "none", note });
  });

  test("an empty session has no groups at all", () => {
    expect(
      buildImporterChat({ history: NO_HISTORY, items: [], working: false }),
    ).toEqual([]);
  });
});

describe("the importer's three tools", () => {
  const POLICY = "https://hackerone.com/acme/policy";
  const asset = (callId: string, host: string): LiveItem =>
    call("record_imported_asset", callId, {
      url: `https://${host}`,
      kind: "host",
      method: null,
      source_url: POLICY,
      note: "named in the table",
      operation_id: `op_${host}`,
    });

  test("add_scope_entry and record_imported_asset each collapse into the record they produced", () => {
    const [group] = buildImporterChat({
      history: NO_HISTORY,
      working: false,
      items: [
        operator(1, "go"),
        write("c1", "acme.com"),
        entryRecord("acme.com"),
        asset("c2", "acme.com"),
        record("asset.imported", "acme.com"),
      ],
    });
    // Two writes, two rows: a call and its record are one row, not two.
    expect(group?.rows.map((row) => [row.item.kind, row.write])).toEqual([
      ["scope.entry.added", "recorded"],
      ["asset.imported", "recorded"],
    ]);
    expect(group?.rows.every((row) => row.proposedBy !== null)).toBe(true);
  });

  /** A result for `callId`, as the narration's `tool.result` carries one. */
  const answer = (
    callId: string,
    output: Record<string, unknown>,
    failed = false,
  ): LiveItem =>
    item({
      kind: "tool.result",
      callId,
      toolName: "add_scope_entry",
      output: JSON.stringify(output),
      outcome: failed ? "failed" : "ok",
    });
  /** A `scope.entry.added` worded as `projectEvent` words it. */
  const entryReceipt = (id: string, value: string, created: boolean) => {
    const made = record("scope.entry.added", value);
    return {
      ...made,
      body: created
        ? `entry ${id} created · in · host · ${value} (that host only)`
        : `already in scope as entry ${id} · in · host · ${value} (that host only) · nothing changed`,
      outcome: created ? "new" : "known",
    };
  };

  test("pairing holds across a no-op add: each call folds into its own record, call and result in one row", () => {
    // The case that shifted everything before S5.1: an add of an entry already in scope
    // wrote no record, so the third call here was folded into the second record and every
    // receipt after it named the wrong entry. The store now writes a `created: false`
    // record for it, and position lines up again.
    const [group] = buildImporterChat({
      history: NO_HISTORY,
      working: false,
      items: [
        operator(1, "go"),
        write("c1", "acme.com"),
        answer("c1", { entry_id: "scope_1", created: true }),
        entryReceipt("scope_1", "acme.com", true),
        write("c2", "acme.com"),
        answer("c2", { entry_id: "scope_1", created: false }),
        entryReceipt("scope_1", "acme.com", false),
        write("c3", "app.acme.com"),
        answer("c3", { entry_id: "scope_2", created: true }),
        entryReceipt("scope_2", "app.acme.com", true),
      ],
    });
    // Three calls, three rows: no result and no record left standing on its own.
    expect(group?.rows).toHaveLength(3);
    expect(
      group?.rows.map((row) => [
        row.proposedBy?.callId,
        row.result?.callId,
        row.write,
        row.item.body,
      ]),
    ).toEqual([
      [
        "c1",
        "c1",
        "recorded",
        "entry scope_1 created · in · host · acme.com (that host only)",
      ],
      [
        "c2",
        "c2",
        "recorded",
        "already in scope as entry scope_1 · in · host · acme.com (that host only) · nothing changed",
      ],
      [
        "c3",
        "c3",
        "recorded",
        "entry scope_2 created · in · host · app.acme.com (that host only)",
      ],
    ]);
  });

  test("a refused add claims no record, so the next call still gets its own", () => {
    // A refusal rolls back and writes nothing. Its failed result is the definitive answer,
    // and letting it take a place in the queue would shift every receipt after it.
    const [group] = buildImporterChat({
      history: NO_HISTORY,
      working: false,
      items: [
        operator(1, "go"),
        write("c1", "acme.com"),
        answer("c1", { reason: "conflict" }, true),
        write("c2", "app.acme.com"),
        answer("c2", { entry_id: "scope_2", created: true }),
        entryReceipt("scope_2", "app.acme.com", true),
      ],
    });
    expect(group?.rows.map((row) => [row.write, row.item.headline])).toEqual([
      ["refused", "add_scope_entry"],
      ["recorded", "app.acme.com"],
    ]);
  });

  test("an exact retry of an asset claims no record: the store replays it and writes nothing", () => {
    const [group] = buildImporterChat({
      history: NO_HISTORY,
      working: false,
      items: [
        operator(1, "go"),
        asset("c1", "acme.com"),
        answer("c1", { identity: "acme.com", replayed: false }),
        record("asset.imported", "acme.com"),
        asset("c2", "acme.com"),
        answer("c2", { identity: "acme.com", replayed: true }),
        asset("c3", "shop.acme.com"),
        answer("c3", { identity: "shop.acme.com", replayed: false }),
        record("asset.imported", "shop.acme.com"),
      ],
    });
    expect(
      group?.rows.map((row) => [
        row.proposedBy?.callId ?? row.item.callId,
        row.write,
        row.item.headline,
      ]),
    ).toEqual([
      ["c1", "recorded", "acme.com"],
      // Not a write and not unresolved: the store's answer said it wrote nothing new, so it
      // is a plain call with that answer folded in.
      ["c2", null, "record_imported_asset"],
      ["c3", "recorded", "shop.acme.com"],
    ]);
  });

  test("a pending write shows what it covers, from the argument that says so", () => {
    const [group] = buildImporterChat({
      history: NO_HISTORY,
      working: true,
      items: [
        operator(1, "go"),
        write("c1", "blog.acme.com"),
        asset("c2", "shop.acme.com"),
      ],
    });
    expect(group?.rows.map((row) => row.summary)).toEqual([
      "blog.acme.com",
      "https://shop.acme.com",
    ]);
    expect(group?.rows.map((row) => row.write)).toEqual(["pending", "pending"]);
  });

  test("read_scope is a read: a plain call with no write state, never pending or unresolved", () => {
    const [group] = buildImporterChat({
      history: NO_HISTORY,
      working: false,
      items: [operator(1, "go"), call("read_scope", "c1", {})],
    });
    expect(group?.rows).toHaveLength(1);
    expect(group?.rows[0]?.write).toBeNull();
    expect(group?.rows[0]?.summary).toBeNull();
  });
});

describe("a write with no record yet", () => {
  const unfinished = [operator(1, "go"), write("c1", "blog.acme.com")];

  test("is pending while the importer is working on it", () => {
    const [group] = buildImporterChat({
      history: NO_HISTORY,
      items: unfinished,
      working: true,
    });
    expect(group?.rows[0]?.write).toBe("pending");
    expect(group?.subject.working).toBe(true);
  });

  test("is unresolved once the importer has stopped, which is the state a chat may not be quiet about", () => {
    const [group] = buildImporterChat({
      history: NO_HISTORY,
      items: unfinished,
      working: false,
    });
    expect(group?.rows[0]?.write).toBe("unresolved");
  });

  test("is unresolved in an earlier turn even while a later one is running", () => {
    const groups = buildImporterChat({
      history: NO_HISTORY,
      items: [...unfinished, operator(2, "never mind"), reply("ok")],
      working: true,
    });
    // `working` is about the latest message only: nothing more can arrive in turn one.
    expect(groups[0]?.rows[0]?.write).toBe("unresolved");
    expect(groups[0]?.subject.working).toBe(false);
    expect(groups[1]?.subject.working).toBe(true);
  });
});

describe("which prose state an empty-looking group is in", () => {
  test("a turn the importer is narrating is live", () => {
    const [group] = buildImporterChat({
      history: NO_HISTORY,
      items: [operator(1, "go"), reply("on it")],
      working: true,
    });
    expect(group?.prose._tag).toBe("live");
  });

  test("the latest message with nothing back yet is pending, and an earlier one is none", () => {
    const groups = buildImporterChat({
      history: NO_HISTORY,
      items: [operator(1, "first"), operator(2, "second")],
      working: true,
    });
    expect(groups[0]?.prose._tag).toBe("none");
    expect(groups[1]?.prose._tag).toBe("pending");
  });

  test("a session the harness has forgotten says so on the one group it can hang on, records or not", () => {
    const note = "The harness no longer has this session.";
    const withRecords = buildImporterChat({
      history: history({ source: "forgotten", note }),
      items: [entryRecord("acme.com")],
      working: false,
    });
    expect(withRecords).toHaveLength(1);
    expect(withRecords[0]?.prose).toEqual({ _tag: "forgotten", note });
    expect(withRecords[0]?.rows).toHaveLength(1);

    // And with nothing else on screen the note still has somewhere to be said.
    const bare = buildImporterChat({
      history: history({ source: "forgotten", note }),
      items: [],
      working: false,
    });
    expect(bare[0]?.prose).toEqual({ _tag: "forgotten", note });
  });

  test("a session still being read is loading, and one the harness has not flushed is pending", () => {
    const loading = buildImporterChat({
      history: history({ source: "loading" }),
      items: [],
      working: false,
    });
    expect(loading[0]?.prose._tag).toBe("loading");
    const pending = buildImporterChat({
      history: history({ source: "pending", note: "Not flushed yet." }),
      items: [],
      working: false,
    });
    expect(pending[0]?.prose).toEqual({
      _tag: "pending",
      note: "Not flushed yet.",
    });
  });
});

describe("the harness's copy is cut at each user entry", () => {
  const held = history({
    source: "harness",
    note: "The harness's copy.",
    items: [
      replayItem(0, "turn.operator", "first ask"),
      replayItem(1, "turn.reply", "first answer"),
      replayItem(2, "turn.reply", "a follow-up"),
      replayItem(3, "turn.operator", "second ask"),
    ],
  });

  test("a user entry is the heading and the assistant entries after it are that group's replay", () => {
    const groups = buildImporterChat({
      history: held,
      items: [],
      working: false,
    });
    expect(groups.map((group) => group.subject.message)).toEqual([
      "first ask",
      "second ask",
    ]);
    // The same rows a live turn has, drawn by `ChatItem` (A6 F10).
    expect(groups[0]?.rows.map((row) => row.item.body)).toEqual([
      "first answer",
      "a follow-up",
    ]);
    expect(groups[0]?.prose._tag).toBe("replayed");
  });

  test("a message the harness holds with no reply is none, not an empty replay", () => {
    const groups = buildImporterChat({
      history: held,
      items: [],
      working: false,
    });
    expect(groups[1]?.rows).toEqual([]);
    expect(groups[1]?.prose._tag).toBe("none");
  });

  test("a replayed turn has the harness's own time, and live turns come after the replayed ones and are numbered on", () => {
    const groups = buildImporterChat({
      history: held,
      items: [operator(1, "third ask"), reply("third answer")],
      working: false,
    });
    expect(groups.map((group) => group.key)).toEqual([
      "turn:1",
      "turn:2",
      "turn:3",
    ]);
    // The harness's time for the message, from the replay (A6 F10).
    expect(groups[0]?.subject.at).toBe(held.items[0]?.at ?? -1);
    expect(groups[2]?.subject.at).not.toBeNull();
    expect(groups[2]?.prose._tag).toBe("live");
  });
});

describe("the picker's second line", () => {
  test("says what was written, and nothing about messages", () => {
    expect(tallyLine({ in: 7, out: 3, assets: 14, messages: null })).toBe(
      "7 in · 3 out · 14 assets",
    );
    expect(tallyLine({ in: 7, out: 3, assets: 14, messages: 0 })).not.toContain(
      "message",
    );
  });

  test("says 'nothing written' rather than three zeros, and keeps the singular honest", () => {
    expect(tallyLine({ in: 0, out: 0, assets: 0, messages: null })).toBe(
      "nothing written",
    );
    expect(tallyLine({ in: 1, out: 0, assets: 1, messages: null })).toBe(
      "1 in · 0 out · 1 asset",
    );
  });
});

describe("a session the server lists", () => {
  test("leaves the message count off rather than printing a number it does not have", () => {
    // What the server indexes carries no prose, so it has no count of it. `null` is not
    // zero: zero is the empty thread, and printing "0 messages" of a session that wrote
    // fourteen assets would be a statement about the conversation nobody checked.
    expect(tallyLine({ in: 7, out: 3, assets: 14, messages: null })).toBe(
      "7 in · 3 out · 14 assets",
    );
    expect(tallyLine({ in: 0, out: 0, assets: 0, messages: null })).toBe(
      "nothing written",
    );
  });

  test("is held with the server's figures, its running flag, and a conversation not yet asked for", () => {
    const held = indexedSession(
      importerSessionView({
        sessionId: "ses_x",
        running: true,
        tally: { entriesIn: 7, entriesOut: 3, assets: 14 },
      }),
      "OpenCode",
    );
    expect(held).toMatchObject({
      id: "ses_x",
      harness: "OpenCode",
      working: true,
      indexed: true,
      reading: true,
      tally: { in: 7, out: 3, assets: 14, messages: null },
      items: [],
    });
    /*
     * `loading`, which is this tab having asked and not heard back — not `pending`, which is
     * the *server's* answer about a session that exists and has not spoken. The row says the
     * session exists and says nothing about what was said in it, so the words are a second
     * request (S6) and this is the page waiting for it. It carries no note: "still loading"
     * is drawn rather than written, and every sentence on this screen is the server's.
     */
    expect(held.history.source).toBe("loading");
    expect(held.history.note).toBe("");
    expect(held.loaded).toBeUndefined();
    // And an unknown count is not the empty session: it keeps a time label.
    expect(sessionLabel(held)).toMatch(/^Session /);
  });
});

describe("a session as a notice names it (U8 review 5)", () => {
  test("by when it started: today, in running words, and with the date before today", () => {
    const time = new Date(AT).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    expect(sessionStarted(AT, AT)).toBe(`today at ${time}`);
    const date = new Date(AT).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    expect(sessionStarted(AT, AT + 3 * 86_400_000)).toBe(
      `on ${date} at ${time}`,
    );
  });

  test("a message over the importer's limit is refused with both figures", () => {
    expect(messageTooLong(IMPORTER_MESSAGE_MAX_CHARS + 1)).toBe(
      "This message is 32,001 characters; the limit is 32,000. Nothing was sent: shorten it, or send it in parts.",
    );
    expect(messageTooLong(6_291_456)).toContain(
      "This message is 6,291,456 characters",
    );
  });
});

describe("a session's name (S9, U8)", () => {
  const listed = (title: string | null) =>
    indexedSession(importerSessionView({ title, openedAt: AT }), "OpenCode");

  test("is the harness's title, with the date kept beside it on hover", () => {
    const named = listed("Full policy sweep");
    expect(named.title).toBe("Full policy sweep");
    expect(sessionLabel(named)).toBe("Full policy sweep");
    // The date is bit's own and outlives the title: never replaced, only moved.
    expect(sessionHover(named, AT)).toBe(
      `\u2068Full policy sweep\u2069 · started ${sessionWhen(AT, AT)}`,
    );
  });

  test("the tooltip isolates the harness's title, so no bidi control in it reaches bit's date (U8 review)", () => {
    const when = sessionWhen(AT, AT);
    // An override, and a PDI of its own before it that would close a bare isolate early.
    const hostile = listed("Scope \u2069\u202Ereview");
    expect(sessionHover(hostile, AT)).toBe(
      `\u2068Scope ⟨U+2069⟩⟨U+202E⟩review\u2069 · started ${when}`,
    );
    // Right-to-left letters are the title's own and are kept, inside the isolate.
    expect(sessionHover(listed("סקירת היקף"), AT)).toBe(
      `\u2068סקירת היקף\u2069 · started ${when}`,
    );
    // Nothing between the isolate's end and bit's words is the harness's.
    const hover = sessionHover(hostile, AT);
    const tail = hover.slice(hover.lastIndexOf("\u2069") + 1);
    expect(tail).toBe(` · started ${when}`);
    expect(
      /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u.test(
        hover.slice(1, hover.lastIndexOf("\u2069")),
      ),
    ).toBe(false);
  });

  test("a session holding parked words quotes their start on hover, isolated, and the page's own one is named by them (U8 review 4)", () => {
    const when = sessionWhen(AT, AT);
    const words = {
      outcome: "refused" as const,
      text: "Also \u202Eload\n  the staging hosts",
    };
    expect(sessionHover(listed("Full policy sweep"), AT, words)).toBe(
      `\u2068Full policy sweep\u2069 · started ${when} · Not sent: \u2068Also ⟨U+202E⟩load the staging hosts\u2069`,
    );
    const own = {
      startedAt: AT,
      tally: { in: 0, out: 0, assets: 0, messages: 0 as const },
    };
    expect(sessionLabel(own, { outcome: "unknown" })).toBe("Not confirmed");
    expect(sessionLabel(own, { outcome: "refused" })).toBe("Not sent");
    expect(sessionHover(own, AT, { ...words, outcome: "unknown" })).toBe(
      `Not confirmed · started ${when} · words: \u2068Also ⟨U+202E⟩load the staging hosts\u2069`,
    );
  });

  test("falls back to its time where the harness has no title, or only whitespace", () => {
    for (const title of [null, "", "   "]) {
      const untitled = listed(title);
      expect(untitled.title).toBeUndefined();
      expect(sessionLabel(untitled)).toMatch(/^Session \d\d:\d\d$/u);
      expect(sessionHover(untitled, AT)).toContain("started Today");
    }
  });

  test("is New session before a word, whatever the harness says", () => {
    expect(
      sessionLabel({
        startedAt: AT,
        title: "Ignored",
        tally: { in: 0, out: 0, assets: 0, messages: 0 },
      }),
    ).toBe("New session");
  });
});

describe("the note above a session being read (U8)", () => {
  const reading = (
    continuation: "live" | "resume" | "fresh" | undefined,
    over: Partial<ImporterSession> = {},
  ) => ({
    reading: true,
    working: false,
    history: {
      ...LOADING_HISTORY,
      ...(continuation === undefined ? {} : { standing: { continuation } }),
    },
    ...over,
  });

  test("never calls a running session earlier, newest or not (found in U5's live runs)", () => {
    for (const newest of [true, false]) {
      expect(readingNote(reading("live", { working: true }), newest)).toBe("");
      expect(readingNote(reading("live", { background: true }), newest)).toBe(
        "",
      );
    }
  });

  test("the newest session: nothing while it is live, what the next message does otherwise", () => {
    expect(readingNote(reading("live"), true)).toBe("");
    expect(readingNote(reading(undefined), true)).toBe("");
    expect(readingNote(reading("resume"), true)).toContain(
      "Your next message takes it back over",
    );
    expect(readingNote(reading("fresh"), true)).toContain(
      "Your next message starts a new one",
    );
    for (const continuation of ["live", "resume", "fresh"] as const) {
      expect(readingNote(reading(continuation), true)).not.toContain("earlier");
    }
  });

  test("an older one opened from the picker is an earlier session, read-only until typed into", () => {
    expect(readingNote(reading("live"), false)).toBe(
      "You are reading an earlier session. Your next message continues it, with the scope as it stands now, not as it stood then.",
    );
    expect(readingNote(reading("resume"), false)).toContain(
      "You are reading an earlier session. Your next message takes it back over",
    );
    expect(readingNote(reading("fresh"), false)).toContain(
      "earlier session that cannot be carried on",
    );
    // Typed into: no longer being read.
    expect(readingNote(reading("live", { reading: false }), false)).toBe("");
    expect(readingNote(undefined, false)).toBe("");
  });
});

describe("the Assets strip's sentence about the last session", () => {
  test("says a session that is running is running", () => {
    expect(
      lastSessionSentence({
        running: true,
        tally: { entriesIn: 0, entriesOut: 0, assets: 0 },
      }),
    ).toBe("is still running.");
  });

  test("says a session that wrote nothing ended without writing anything", () => {
    expect(
      lastSessionSentence({
        running: false,
        tally: { entriesIn: 0, entriesOut: 0, assets: 0 },
      }),
    ).toBe("ended without writing anything.");
  });

  test("says what a session that wrote something wrote, and any one kind is something", () => {
    expect(
      lastSessionSentence({
        running: false,
        tally: { entriesIn: 7, entriesOut: 3, assets: 14 },
      }),
    ).toBe("wrote 7 in · 3 out · 14 assets.");
    // Assets alone: the session wrote no entry, and "nothing" would be a lie.
    expect(
      lastSessionSentence({
        running: false,
        tally: { entriesIn: 0, entriesOut: 0, assets: 2 },
      }),
    ).toBe("wrote 0 in · 0 out · 2 assets.");
  });
});

describe("a call as one line of the thread", () => {
  const callItem = (input: string | null): LiveItem =>
    item({
      kind: "tool.call",
      toolName: "add_scope_entry",
      headline: "add_scope_entry",
      input,
    });

  test("prints the arguments the call carried, leaves a null out, and adds nothing", () => {
    expect(
      callSignature(
        callItem(
          JSON.stringify({
            effect: "in",
            kind: "subtree",
            value: "acme.com",
            method: null,
            subdomains: true,
          }),
        ),
      ),
    ).toBe(
      'add_scope_entry(effect="in", kind="subtree", value="acme.com", subdomains=true)',
    );
    expect(callSignature(callItem(null))).toBe("add_scope_entry()");
  });

  test("never guesses at a call the server cut short", () => {
    // Arguments are capped with a marker appended, so a large one is not valid JSON.
    expect(
      callSignature(callItem('{"value":"acme.com","note":"a long no…')),
    ).toBe("add_scope_entry(…)");
  });

  test("a result prints the server's sentence when it wrote one, else its own output cut short", () => {
    const answer = (over: Partial<LiveItem>): LiveItem =>
      item({ kind: "tool.result", ...over });
    expect(resultLine(null)).toBeNull();
    expect(resultLine(answer({ body: "entry ent_1 created" }))).toBe(
      "entry ent_1 created",
    );
    expect(resultLine(answer({ output: '{ "total": 5 }' }))).toBe(
      '{"total":5}',
    );
    const long = resultLine(answer({ output: "x".repeat(400) }));
    expect(long?.endsWith("…")).toBe(true);
    expect(long?.length).toBe(161);
    expect(resultLine(answer({ body: "refused", outcome: "failed" }))).toBe(
      "failed: refused",
    );
  });
});

describe("what the composer says under an accepted message", () => {
  test("the server's note alone when no page was given", () => {
    expect(
      acceptedNotice({ note: "Opened.", pagesAdded: [], pagesNotAdded: [] }),
    ).toBe("Opened.");
    expect(
      acceptedNotice({ note: "", pagesAdded: [], pagesNotAdded: [] }),
    ).toBe("");
  });

  test("every page made citable is named, so one from a paste is not silent", () => {
    expect(
      acceptedNotice({
        note: "",
        pagesAdded: ["https://a.test/1", "https://a.test/2"],
        pagesNotAdded: [],
      }),
    ).toBe(
      "Added as pages this import may cite: https://a.test/1, https://a.test/2.",
    );
  });

  test("pages refused for the cap are said apart from those added", () => {
    const notice = acceptedNotice({
      note: "Opened.",
      pagesAdded: ["https://a.test/1"],
      pagesNotAdded: ["https://a.test/9"],
    });
    expect(notice).toStartWith(
      "Opened. Added as a page this import may cite: https://a.test/1.",
    );
    expect(notice).toEndWith(
      "Not added, because this import already holds as many pages as one session reads: https://a.test/9.",
    );
  });
});

/**
 * The importer's narration, filed and placed (the importer conversation design, S4).
 *
 * The page's own rows are the operator's messages; the importer's words come from the
 * target's live feed. These are the two rules that join them.
 */
describe("the importer's words from the live feed", () => {
  const said = (n: number, body: string, importId: string | null = "imp_1") =>
    ({
      ...item({ kind: "turn.reply", body }),
      id: `activity:${String(n)}`,
      importId,
    }) satisfies LiveItem;
  const first = operatorTurn({
    index: 1,
    text: "Read the page",
    at: AT,
    after: 0,
  });
  const second = operatorTurn({
    index: 2,
    text: "And staging",
    at: AT,
    after: 0,
  });
  const floors = { [first.id]: 10, [second.id]: 20 };

  test("are filed by import id and nothing else", () => {
    const feed = importerFeed({
      own: [first],
      floors,
      live: [
        said(11, "mine"),
        said(12, "another import's", "imp_2"),
        { ...said(13, "a goal agent's", null), goalId: "goal_1" },
      ],
      importId: "imp_1",
    });
    expect(feed.map((each) => each.body)).toEqual(["Read the page", "mine"]);
  });

  test("a session with no import yet takes nothing", () => {
    const feed = importerFeed({
      own: [first],
      floors,
      live: [said(11, "mine")],
      importId: undefined,
    });
    expect(feed).toEqual([first]);
  });

  test("are placed under the message sent before they were published, whatever order they arrived in", () => {
    const groups = buildImporterChat({
      history: NO_HISTORY,
      items: importerFeed({
        own: [first, second],
        floors,
        live: [
          said(5, "before either message"),
          said(15, "answering the first"),
          said(25, "answering the second"),
        ],
        importId: "imp_1",
      }),
      working: true,
    });
    expect(
      groups.map((group) => [
        group.subject.message,
        group.rows.map((row) => row.item.body),
      ]),
    ).toEqual([
      [null, ["before either message"]],
      ["Read the page", ["answering the first"]],
      ["And staging", ["answering the second"]],
    ]);
    // The latest turn is live: something has been said in it.
    expect(groups.at(-1)?.prose._tag).toBe("live");
  });

  /**
   * The replay/live boundary (S6), which is one comparison and has to be exactly right.
   *
   * The replay contains every word the harness held when it answered, so narration published
   * at or below the floor is on screen twice unless it is dropped — and narration published
   * *after* it is the live tail and must not be.
   */
  test("narration the replay already holds is dropped, and everything after the floor is kept", () => {
    const feed = importerFeed({
      own: [],
      floors: {},
      live: [
        said(10, "in the replay"),
        said(20, "also in the replay"),
        said(21, "arrived after the read"),
      ],
      importId: "imp_1",
      historyFloor: 20,
    });
    expect(feed.map((each) => each.body)).toEqual(["arrived after the read"]);
  });

  test("U5 review: a partial whose block began before the read is kept while the replay does not hold its block", () => {
    // `withBlock` keeps a block's first partial id on every later one, so a block that was
    // being written when the replay was asked for stays below the floor until it ends.
    const growing = {
      ...said(15, "Reading the policy page and"),
      blockId: "ses:msg_9:0",
      blockCall: "ses:msg_9",
      streaming: true as const,
    };
    const feed = importerFeed({
      own: [],
      floors: {},
      live: [said(10, "in the replay"), growing],
      importId: "imp_1",
      historyFloor: 20,
      replayed: [],
    });
    expect(feed.map((each) => each.body)).toEqual([
      "Reading the policy page and",
    ]);
    // Once the replay holds the block, its copy there is the block, and the partial goes.
    const held = importerFeed({
      own: [],
      floors: {},
      live: [growing],
      importId: "imp_1",
      historyFloor: 20,
      replayed: [
        { ...replayItem(0, "turn.reply", "Reading."), blockId: "ses:msg_9:0" },
      ],
    });
    expect(held).toEqual([]);
    // A finished block below the floor the replay holds is the replay's.
    const finished = importerFeed({
      own: [],
      floors: {},
      live: [{ ...said(15, "done"), blockId: "ses:msg_9:0" }],
      importId: "imp_1",
      historyFloor: 20,
      replayed: [
        { ...replayItem(0, "turn.reply", "done"), blockId: "ses:msg_9:0" },
      ],
    });
    expect(finished).toEqual([]);
  });

  /*
   * U5 review 2: Claude Code writes a model call's blocks to its transcript only once the
   * whole call ends. Measured: the thought's finished frame went out live at 2.1 s, and the
   * replay held only the operator's row from 2.1 s to 12.3 s, when the reply after it
   * ended. A reload or a return in between read a replay with no thought in it.
   */
  const finishedThought = {
    ...item({ kind: "turn.thinking", body: "Weighing the wildcard" }),
    id: "activity:15",
    importId: "imp_1",
    blockId: "ses:msg_9:0",
    blockCall: "ses:msg_9",
  } satisfies LiveItem;
  const replyGrowing = {
    ...said(16, "Reading the policy page and"),
    blockId: "ses:msg_9:1",
    blockCall: "ses:msg_9",
    streaming: true as const,
  };

  test("U5 review 2: a finished thought below the floor is kept while the replay holds only the operator's row", () => {
    const replayed = [replayItem(0, "turn.operator", "Read the page")];
    const feed = importerFeed({
      own: [],
      floors: {},
      live: [said(10, "an earlier turn's"), finishedThought, replyGrowing],
      importId: "imp_1",
      historyFloor: 20,
      replayed,
      callInFlight: true,
    });
    expect(feed.map((each) => each.body)).toEqual([
      "Weighing the wildcard",
      "Reading the policy page and",
    ]);
    // Drawn in the turn the replay ends on, the thought above the reply.
    const groups = buildImporterChat({
      history: history({
        source: "harness",
        note: "From the harness.",
        items: replayed,
      }),
      items: feed,
      working: true,
    });
    expect(
      groups.map((group) => [
        group.subject.message,
        group.rows.map((row) => row.item.body),
      ]),
    ).toEqual([
      [
        "Read the page",
        ["Weighing the wildcard", "Reading the policy page and"],
      ],
    ]);
    // Once the replay holds the thought, its copy there is the thought.
    expect(
      importerFeed({
        own: [],
        floors: {},
        live: [finishedThought],
        importId: "imp_1",
        historyFloor: 20,
        replayed: [
          ...replayed,
          {
            ...replayItem(1, "turn.thinking", "Weighing the wildcard"),
            blockId: "ses:msg_9:0",
          },
        ],
      }),
    ).toEqual([]);
  });

  test("U5 review 2: a finished block older than one the replay holds is not kept — the replay's window cut it", () => {
    // A long session's replay is cut to its newest items (`truncated`): a block before the
    // window is not in it either, and is no block the harness has yet to store.
    const cutAway = {
      ...said(5, "before the window"),
      blockId: "ses:msg_1:0",
      blockCall: "ses:msg_1",
    };
    const inWindow = {
      ...said(8, "in the window"),
      blockId: "ses:msg_2:0",
      blockCall: "ses:msg_2",
    };
    const feed = importerFeed({
      own: [],
      floors: {},
      live: [cutAway, inWindow, finishedThought],
      importId: "imp_1",
      historyFloor: 20,
      replayed: [
        {
          ...replayItem(0, "turn.reply", "in the window"),
          blockId: "ses:msg_2:0",
        },
      ],
      callInFlight: true,
    });
    expect(feed.map((each) => each.body)).toEqual(["Weighing the wildcard"]);
  });

  test("U5 review 3: a replay holding only tool rows still cuts the older blocks its window lost", () => {
    // A write-heavy run: two hundred calls with no prose fill the replay's newest four
    // hundred items with tool rows, so no block in the live window is one the replay
    // names. The tool rows it does name are what says how far it reaches.
    const cutAway = {
      ...said(5, "before the window"),
      blockId: "ses:msg_1:0",
      blockCall: "ses:msg_1",
    };
    const call = (n: number): LiveItem => ({
      ...item({ kind: "tool.call", toolName: "add_scope_entry" }),
      id: `activity:${String(n)}`,
      importId: "imp_1",
      callId: `toolu_${String(n)}`,
    });
    const result = (n: number): LiveItem => ({
      ...item({ kind: "tool.result", toolName: "add_scope_entry" }),
      id: `activity:${String(n + 1)}`,
      importId: "imp_1",
      callId: `toolu_${String(n)}`,
    });
    const feed = importerFeed({
      own: [],
      floors: {},
      live: [cutAway, call(6), result(6), call(8), result(8), finishedThought],
      importId: "imp_1",
      historyFloor: 20,
      replayed: [
        replayItem(0, "tool.call", "", { callId: "toolu_8" }),
        replayItem(1, "tool.result", "", { callId: "toolu_8" }),
      ],
      callInFlight: true,
    });
    expect(feed.map((each) => each.body)).toEqual(["Weighing the wildcard"]);
  });

  test("U5 review 3: a finished block below the floor is not kept once no call can still be running", () => {
    // A replay read with the session idle holds every finished block both harnesses
    // stored: one it lacks is missing for another reason, not yet to come.
    const feed = importerFeed({
      own: [],
      floors: {},
      live: [finishedThought, replyGrowing],
      importId: "imp_1",
      historyFloor: 20,
      replayed: [replayItem(0, "turn.operator", "Read the page")],
      callInFlight: false,
    });
    // The partial is still being written, whatever the session says; the finished one goes.
    expect(feed.map((each) => each.body)).toEqual([
      "Reading the policy page and",
    ]);
  });

  test("U5 review 3: a finished block above the floor the replay already holds is drawn once", () => {
    // The turn watch answered, and the settled re-read landed, before the block's last live
    // frame reached the tab: published after the floor, and in the replay too.
    const late = {
      ...item({ kind: "turn.reply", body: "Six are in scope." }),
      id: "activity:25",
      importId: "imp_1",
      blockId: "ses:msg_9:1",
      blockCall: "ses:msg_9",
    } satisfies LiveItem;
    const feed = importerFeed({
      own: [],
      floors: {},
      live: [late, said(26, "a later block")],
      importId: "imp_1",
      historyFloor: 20,
      replayed: [
        {
          ...replayItem(0, "turn.reply", "Six are in scope."),
          blockId: "ses:msg_9:1",
        },
      ],
    });
    expect(feed.map((each) => each.body)).toEqual(["a later block"]);
  });

  test("U5 review: returning to a chat mid-block draws the block in the running turn, writing", () => {
    const groups = buildImporterChat({
      history: history({
        source: "harness",
        note: "From the harness.",
        items: [replayItem(0, "turn.operator", "Read the page")],
      }),
      items: importerFeed({
        own: [],
        floors: {},
        live: [
          {
            ...said(15, "Reading the policy page and"),
            blockId: "ses:msg_9:0",
            blockCall: "ses:msg_9",
            streaming: true,
          },
        ],
        importId: "imp_1",
        historyFloor: 20,
        replayed: [replayItem(0, "turn.operator", "Read the page")],
      }),
      working: true,
    });
    expect(
      groups.map((group) => [
        group.subject.midBlock,
        group.rows.map((row) => `${row.item.body} [${String(row.stream)}]`),
      ]),
    ).toEqual([[false, ["Reading the policy page and [writing]"]]]);
  });

  test("U6: a message sent now keeps its mark when the replay's copy of it replaces this tab's row", () => {
    // Read again once the turn settles, the replay draws the harness's copy of the message,
    // which carries the id the server delivered it under, in place of the row sent here.
    const groups = buildImporterChat({
      history: history({
        source: "harness",
        note: "From the harness.",
        items: [
          replayItem(0, "turn.operator", "Read the page"),
          replayItem(1, "turn.operator", "Reply with PINEAPPLE", {
            messageIds: ["msg_now"],
          }),
        ],
      }),
      items: [],
      working: false,
      sentNow: ["msg_now"],
    });
    expect(groups.map((group) => group.subject.sentNow)).toEqual([false, true]);
  });

  test("a record is kept whatever the floor: it is durable, and the replay never holds one", () => {
    // `scope.entry.added` carries no activity order, and dropping it would lose the half of
    // the screen that survives a reload.
    const record = {
      ...item({ kind: "scope.entry.added", body: "acme.com" }),
      id: "event:7",
      origin: "record" as const,
      importId: "imp_1",
    } satisfies LiveItem;
    const feed = importerFeed({
      own: [],
      floors: {},
      live: [record, said(5, "in the replay")],
      importId: "imp_1",
      historyFloor: 99,
    });
    expect(feed).toEqual([record]);
  });

  test("no floor keeps everything: a session whose words were never asked for has no replay to collide with", () => {
    const feed = importerFeed({
      own: [],
      floors: {},
      live: [said(5, "early"), said(6, "later")],
      importId: "imp_1",
    });
    expect(feed.map((each) => each.body)).toEqual(["early", "later"]);
  });

  test("the whole boundary: a replayed turn, then a live one, and nothing in both", () => {
    const groups = buildImporterChat({
      history: history({
        source: "harness",
        note: "From the harness.",
        items: [
          replayItem(0, "turn.operator", "Read the page"),
          replayItem(1, "turn.reply", "two in, one out"),
        ],
      }),
      items: importerFeed({
        own: [second],
        floors,
        live: [
          // The same words the replay holds, as narration published before the read.
          said(10, "two in, one out"),
          said(25, "and staging is in too"),
        ],
        importId: "imp_1",
        historyFloor: 20,
      }),
      working: false,
    });
    expect(
      groups.map((group) => [
        group.subject.message,
        group.rows
          .filter((row) => row.key.startsWith("replay:"))
          .map((row) => row.item.body),
        group.rows
          .filter((row) => !row.key.startsWith("replay:"))
          .map((row) => row.item.body),
      ]),
    ).toEqual([
      // The replayed turn: the operator's own sentence, with the reply under it.
      ["Read the page", ["two in, one out"], []],
      // Then the live one. The reply is in exactly one of them.
      ["And staging", [], ["and staging is in too"]],
    ]);
  });
});

/* ── One renderer for live and replay (A6 F10) ──────────────────────────────── */

describe("a reloaded session is the live one, row for row", () => {
  /** What a reader sees of each group: its heading, and each row's kind, words and state. */
  const seen = (groups: ReturnType<typeof buildImporterChat>) =>
    groups.map((group) => ({
      message: group.subject.message,
      rows: group.rows.map((row) => [
        row.item.kind,
        row.item.body,
        row.proposedBy?.callId ?? row.item.callId,
        row.write,
        row.result?.output ?? null,
      ]),
    }));

  test("the replay's items and the record channel give the turns, rows and write states live gave", () => {
    const now = 1_793_000_000_000;
    const live = mockCompletedSession(now);
    const reloaded = mockReloadedSession(now);
    const fromLive = buildImporterChat({
      history: live.history,
      items: live.items,
      working: false,
    });
    const fromReplay = buildImporterChat({
      history: reloaded.history,
      items: reloaded.items,
      working: false,
    });
    expect(seen(fromReplay)).toEqual(seen(fromLive));
    // Not vacuous: there are writes, and every one is folded into the record it produced.
    const writes = fromReplay.flatMap((group) =>
      group.rows.flatMap((row) => (row.write === null ? [] : [row.write])),
    );
    expect(writes.length).toBeGreaterThan(3);
    expect(new Set(writes)).toEqual(new Set(["recorded"]));
    expect(fromReplay.map((group) => group.prose._tag)).toEqual([
      "replayed",
      "replayed",
    ]);
  });

  test("a record no replayed call claims stays in the leading group, said as such", () => {
    const groups = buildImporterChat({
      history: history({
        source: "harness",
        note: "From the harness.",
        items: [
          replayItem(0, "turn.operator", "read the page"),
          replayItem(1, "turn.reply", "nothing to write"),
        ],
      }),
      items: [
        item({
          kind: "scope.entry.added",
          origin: "record",
          id: "record:evt-lonely",
          body: "entry ent_1 created",
        }),
      ],
      working: false,
    });
    expect(groups.map((group) => group.key)).toEqual(["earlier", "turn:1"]);
    expect(groups[0]?.rows.map((row) => row.item.id)).toEqual([
      "record:evt-lonely",
    ]);
  });
});

/* ── Pairing a reloaded write with its record when a side is cut (A6 F10 review) ── */

describe("a reloaded write and its record, when the replay or the feed is cut", () => {
  /**
   * One replayed `add_scope_entry` turn: the operator's message, the call, and its result
   * naming the entry — positions `4n` to `4n+2` of the replay, so ids stay unique.
   */
  const replayedTurn = (
    n: number,
    value: string,
    answered: boolean,
  ): LiveItem[] => [
    replayItem(4 * n, "turn.operator", `add ${value}`),
    replayItem(4 * n + 1, "tool.call", "", {
      headline: "add_scope_entry",
      toolName: "add_scope_entry",
      callId: `call_${value}`,
      input: JSON.stringify({ effect: "in", kind: "host", value }),
    }),
    ...(answered
      ? [
          replayItem(4 * n + 2, "tool.result", "", {
            callId: `call_${value}`,
            outcome: "ok",
            output: JSON.stringify({
              entry_id: `ent_${value}`,
              value,
              created: true,
            }),
          }),
        ]
      : []),
  ];
  /** The record `projectEvent` sends for that entry, carrying its `writeId`. */
  const receipt = (value: string, writeId: string | null = `ent_${value}`) => ({
    ...entryRecord(value),
    body: `entry ent_${value} created · in · host · ${value}`,
    ...(writeId === null ? {} : { writeId }),
  });
  /** Each write row as "the value its call sent → the record it shows, and its state". */
  const writes = (groups: ReturnType<typeof buildImporterChat>) =>
    groups.flatMap((group) =>
      group.rows.flatMap((row) => {
        const callItem = row.proposedBy ?? row.item;
        if (callItem.kind !== "tool.call") return [];
        const sent = (JSON.parse(callItem.input ?? "{}") as { value: string })
          .value;
        return [
          `${group.key} ${sent} → ${row.proposedBy === null ? "-" : row.item.headline} ${String(row.write)}`,
        ];
      }),
    );
  const harness = (items: LiveItem[], truncated: boolean) =>
    history({ source: "harness", note: "From the harness.", items, truncated });

  test("a replay cut short of the oldest call keeps every later write on its own record", () => {
    // Three turns wrote a.com, b.com and c.com; the replay kept only the newest two. The
    // feed holds all three records. By position, b.com's call took a.com's receipt.
    const groups = buildImporterChat({
      history: harness(
        [...replayedTurn(1, "b.com", true), ...replayedTurn(2, "c.com", true)],
        true,
      ),
      items: [receipt("a.com"), receipt("b.com"), receipt("c.com")],
      working: false,
    });
    expect(writes(groups)).toEqual([
      "turn:1 b.com → b.com recorded",
      "turn:2 c.com → c.com recorded",
    ]);
    // a.com's receipt is nobody's on this page, and is said as such rather than hung on one.
    expect(groups[0]?.key).toBe("earlier");
    expect(groups[0]?.rows.map((row) => row.item.headline)).toEqual(["a.com"]);
  });

  test("a feed opened after the oldest record leaves that write unpaired, never on the next record", () => {
    // The whole replay, but the record feed opened part way back (`skipped > 0`): a.com's
    // receipt is not here. By position a.com's call took b.com's and c.com's read unresolved.
    const groups = buildImporterChat({
      history: harness(
        [
          ...replayedTurn(0, "a.com", true),
          ...replayedTurn(1, "b.com", true),
          ...replayedTurn(2, "c.com", true),
        ],
        false,
      ),
      items: [receipt("b.com"), receipt("c.com")],
      recordsSkipped: 200,
      working: false,
    });
    expect(writes(groups)).toEqual([
      "turn:1 a.com → - unresolved",
      "turn:2 b.com → b.com recorded",
      "turn:3 c.com → c.com recorded",
    ]);
  });

  test("with no id on either side, a cut side pairs nothing by position", () => {
    // Calls whose results never came back (a Stop) and receipts from a build that sends no
    // `writeId`: only position could join them, and position is what the cut broke.
    const cutReplay = buildImporterChat({
      history: harness(
        [
          ...replayedTurn(1, "b.com", false),
          ...replayedTurn(2, "c.com", false),
        ],
        true,
      ),
      items: [receipt("a.com", null), receipt("b.com", null)],
      working: false,
    });
    expect(writes(cutReplay)).toEqual([
      "turn:1 b.com → - unresolved",
      "turn:2 c.com → - unresolved",
    ]);
    const cutFeed = buildImporterChat({
      history: harness(
        [
          ...replayedTurn(0, "a.com", false),
          ...replayedTurn(1, "b.com", false),
        ],
        false,
      ),
      items: [receipt("b.com", null)],
      recordsSkipped: 1,
      working: false,
    });
    expect(writes(cutFeed)).toEqual([
      "turn:1 a.com → - unresolved",
      "turn:2 b.com → - unresolved",
    ]);
    // Uncut, the same id-less pair still joins by position, as it always has.
    const whole = buildImporterChat({
      history: harness(replayedTurn(0, "a.com", false), false),
      items: [receipt("a.com", null)],
      working: false,
    });
    expect(writes(whole)).toEqual(["turn:1 a.com → a.com recorded"]);
  });

  test("an asset write joins its record by the operation id it was sent with", () => {
    // Two calls for the same host with different operation ids: the asset is the same, so
    // only the operation id can tell their records apart. The replay lost the first call.
    const assetCall = (index: number, op: string) =>
      replayItem(index, "tool.call", "", {
        headline: "record_imported_asset",
        toolName: "record_imported_asset",
        callId: `call_${op}`,
        input: JSON.stringify({
          url: "https://app.acme.com",
          value: `app.acme.com (${op})`,
          operation_id: op,
        }),
      });
    const assetRecord = (op: string) => ({
      ...record("asset.imported", `app.acme.com via ${op}`),
      writeId: op,
    });
    const groups = buildImporterChat({
      history: harness(
        [
          replayItem(0, "turn.operator", "record the hosts again"),
          assetCall(1, "op_2"),
        ],
        true,
      ),
      items: [assetRecord("op_1"), assetRecord("op_2")],
      working: false,
    });
    expect(writes(groups)).toEqual([
      "turn:1 app.acme.com (op_2) → app.acme.com via op_2 recorded",
    ]);
  });

  test("in the uncut stretch, an asset call whose record is not on screen takes no other operation's", () => {
    // Nothing is cut, so order pairing is allowed — but only for what carries no id. The
    // call was sent with op_x and op_x's record is not here; op_y's is, and is unclaimed.
    // Taking it would put one write's receipt on another's call.
    const groups = buildImporterChat({
      history: harness(
        [
          replayItem(0, "turn.operator", "record the host"),
          replayItem(1, "tool.call", "", {
            headline: "record_imported_asset",
            toolName: "record_imported_asset",
            callId: "call_op_x",
            input: JSON.stringify({
              url: "https://app.acme.com",
              value: "app.acme.com (op_x)",
              operation_id: "op_x",
            }),
          }),
        ],
        false,
      ),
      items: [
        {
          ...record("asset.imported", "app.acme.com via op_y"),
          writeId: "op_y",
        },
      ],
      working: false,
    });
    expect(writes(groups)).toEqual([
      "turn:1 app.acme.com (op_x) → - unresolved",
    ]);
    // op_y's receipt is nobody's on this page, and stays on screen as such.
    expect(groups[0]?.key).toBe("earlier");
    expect(groups[0]?.rows.map((row) => row.item.headline)).toEqual([
      "app.acme.com via op_y",
    ]);
  });

  test("an entry added twice keeps each call on its own receipt when the replay lost the first", () => {
    // a.com was added (created), then added again (found): two records under one entry id.
    // The replay kept only the second call; the feed kept both records.
    const found = (n: number): LiveItem[] => [
      replayItem(4 * n, "turn.operator", "add a.com again"),
      replayItem(4 * n + 1, "tool.call", "", {
        headline: "add_scope_entry",
        toolName: "add_scope_entry",
        callId: "call_again",
        input: JSON.stringify({ effect: "in", kind: "host", value: "a.com" }),
      }),
      replayItem(4 * n + 2, "tool.result", "", {
        callId: "call_again",
        outcome: "ok",
        output: JSON.stringify({
          entry_id: "ent_a.com",
          value: "a.com",
          created: false,
        }),
      }),
    ];
    const created = {
      ...receipt("a.com"),
      headline: "a.com (created)",
      outcome: "new",
    };
    const again = {
      ...receipt("a.com"),
      headline: "a.com (found)",
      body: "already in scope as entry ent_a.com · in · host · a.com · nothing changed",
      outcome: "known",
    };
    const groups = buildImporterChat({
      history: harness(found(1), true),
      items: [created, again],
      working: false,
    });
    expect(writes(groups)).toEqual(["turn:1 a.com → a.com (found) recorded"]);
    // The first add's receipt is the cut call's, and is said as nobody's on this page.
    expect(groups[0]?.key).toBe("earlier");
    expect(groups[0]?.rows.map((row) => row.item.headline)).toEqual([
      "a.com (created)",
    ]);
    // Uncut, both calls are on screen and each still takes its own.
    const whole = buildImporterChat({
      history: harness(
        [
          ...replayedTurn(0, "a.com", true).map((each) =>
            each.kind === "tool.result"
              ? { ...each, callId: "call_first" }
              : each.kind === "tool.call"
                ? { ...each, callId: "call_first" }
                : each,
          ),
          ...found(1),
        ],
        false,
      ),
      items: [created, again],
      working: false,
    });
    expect(writes(whole)).toEqual([
      "turn:1 a.com → a.com (created) recorded",
      "turn:2 a.com → a.com (found) recorded",
    ]);
  });
});

/* ── Sub-agents (A6 U14) ─────────────────────────────────────────────────────── */

describe("a sub-agent is one entry, where it started, in its newest state", () => {
  const subagent = (
    callId: string,
    outcome: string,
    over: Partial<LiveItem> = {},
  ): LiveItem =>
    item({
      kind: "subagent",
      headline: "general-purpose",
      body: "Say PONG",
      tool: "Agent",
      toolName: "Agent",
      callId,
      outcome,
      ...over,
    });
  const rows = (groups: ReturnType<typeof buildImporterChat>) =>
    groups.map((group) =>
      group.rows.map((row) =>
        row.item.kind === "subagent"
          ? `${row.key} subagent ${String(row.item.callId)} ${String(row.item.outcome)}`
          : `${row.item.kind} ${row.item.body}`,
      ),
    );

  test("live: running then finished is one entry, keyed by the first, finished", () => {
    const started = subagent("toolu_fg", "running");
    const ended = subagent("toolu_fg", "finished");
    const groups = buildImporterChat({
      history: NO_HISTORY,
      items: [
        operator(1, "use a sub-agent"),
        started,
        ended,
        reply("It said PONG."),
      ],
      working: false,
    });
    expect(rows(groups)).toEqual([
      [`${started.id} subagent toolu_fg finished`, "turn.reply It said PONG."],
    ]);
  });

  test("a background sub-agent that ends after the next message stays one entry, in the turn it started", () => {
    const started = subagent("toolu_bg", "running", { body: "Say PING later" });
    const groups = buildImporterChat({
      history: NO_HISTORY,
      items: [
        operator(1, "start one in the background"),
        started,
        reply("Started."),
        operator(2, "anything else?"),
        reply("Not yet."),
        subagent("toolu_bg", "finished", { body: "Say PING later" }),
      ],
      working: false,
    });
    expect(rows(groups)).toEqual([
      [`${started.id} subagent toolu_bg finished`, "turn.reply Started."],
      ["turn.reply Not yet."],
    ]);
  });

  test("a reload mid-run: the replay's running entry is finished by the live tail's state", () => {
    const groups = buildImporterChat({
      history: history({
        source: "harness",
        note: "From the harness.",
        items: [
          replayItem(0, "turn.operator", "start one in the background"),
          replayItem(1, "subagent", "Say PING later", {
            headline: "general-purpose",
            tool: "Agent",
            toolName: "Agent",
            callId: "toolu_bg",
            outcome: "running",
          }),
          replayItem(2, "turn.reply", "Started."),
        ],
      }),
      items: [subagent("toolu_bg", "finished", { body: "Say PING later" })],
      working: false,
    });
    expect(rows(groups)).toEqual([
      ["replay:1 subagent toolu_bg finished", "turn.reply Started."],
    ]);
  });

  test("a reload equals the live session, row for row", () => {
    const states = (ids: () => string) => [
      { ...operator(1, "use two"), id: ids() },
      { ...subagent("a", "running"), id: ids() },
      { ...subagent("b", "running", { headline: "explore" }), id: ids() },
      { ...subagent("a", "failed"), id: ids() },
      { ...reply("One failed."), id: ids() },
      { ...subagent("b", "stopped", { headline: "explore" }), id: ids() },
    ];
    let n = 0;
    const liveItems = states(() => `activity:${String((n += 1))}`);
    let r = 0;
    const replayed = states(() => `replay:${String(r++)}`);
    const view = (groups: ReturnType<typeof buildImporterChat>) =>
      groups.map((group) =>
        group.rows.map((row) => [
          row.item.kind,
          row.item.headline,
          row.item.body,
          row.item.callId,
          row.item.outcome,
        ]),
      );
    const fromLive = buildImporterChat({
      history: NO_HISTORY,
      items: liveItems,
      working: false,
    });
    const fromReplay = buildImporterChat({
      history: history({
        source: "harness",
        note: "From the harness.",
        items: replayed,
      }),
      items: [],
      working: false,
    });
    expect(view(fromReplay)).toEqual(view(fromLive));
    expect(view(fromLive)).toEqual([
      [
        ["subagent", "general-purpose", "Say PONG", "a", "failed"],
        ["subagent", "explore", "Say PONG", "b", "stopped"],
        ["turn.reply", "Importer", "One failed.", null, null],
      ],
    ]);
  });
});

/*
 * A6 U4: a message sent while a turn runs waits behind it, and the running turn's work stays
 * the running turn's until the harness takes the message.
 */
describe("U4: a steer sent mid-turn", () => {
  const MESSAGE = "aaaaaaaabbbbbbbbccccccccdddddddd";
  const live = (n: number, over: Partial<LiveItem> & Pick<LiveItem, "kind">) =>
    item({ id: `activity:${String(n)}`, importId: "imp_1", ...over });
  const first = operator(1, "load the policy");
  const steer = { ...operator(2, "and the portal"), messageIds: [MESSAGE] };
  const own = [first, steer];
  const floors = { [first.id]: 0, [steer.id]: 5 };
  const before = [
    live(6, { kind: "turn.reply", body: "reading it" }),
    live(7, {
      kind: "tool.call",
      headline: "fetch_page",
      toolName: "fetch_page",
      callId: "f1",
    }),
  ];
  const take = live(8, { kind: "turn.taken", messageIds: [MESSAGE] });
  const after = [
    live(9, {
      kind: "tool.result",
      headline: "fetch_page",
      toolName: "fetch_page",
      callId: "f1",
      output: "nine rows",
      outcome: "ok",
    }),
    live(10, { kind: "turn.reply", body: "adding the portal" }),
  ];
  const chat = (
    liveItems: readonly LiveItem[],
    working: boolean,
    taken?: Readonly<Record<string, LiveItem>>,
  ) =>
    buildImporterChat({
      history: NO_HISTORY,
      working,
      midTurn: [steer.id],
      ...(taken === undefined ? {} : { taken }),
      items: importerFeed({
        own,
        floors,
        live: liveItems,
        importId: "imp_1",
        midTurn: [steer.id],
        working,
        taken,
      }),
    });
  const read = (groups: ReturnType<typeof chat>) =>
    groups.map((group) => ({
      message: group.subject.message,
      queued: group.subject.queued,
      working: group.subject.working,
      rows: group.rows.map((row) =>
        row.item.kind === "tool.call"
          ? `${row.item.toolName ?? ""}→${row.result?.output ?? "…"}`
          : row.item.body,
      ),
    }));

  test("waits at the end, queued, while the turn before it does the work", () => {
    const groups = chat(before, true);
    expect(read(groups)).toEqual([
      {
        message: "load the policy",
        queued: false,
        working: true,
        rows: ["reading it", "fetch_page→…"],
      },
      { message: "and the portal", queued: true, working: false, rows: [] },
    ]);
    expect(groups[1]?.prose).toEqual({ _tag: "pending", note: QUEUED_NOTE });
  });

  test("once taken it opens its own turn there, and a late result still folds into its call", () => {
    const groups = chat([...before, take, ...after], true);
    expect(read(groups)).toEqual([
      {
        message: "load the policy",
        queued: false,
        working: false,
        rows: ["reading it", "fetch_page→nine rows"],
      },
      {
        message: "and the portal",
        queued: false,
        working: true,
        rows: ["adding the portal"],
      },
    ]);
    // Its turn starts when the harness took it, on the server's clock.
    expect(groups[1]?.subject.startedAt).toBe(take.at);
    // The take itself is no row.
    expect(
      groups.flatMap((group) => group.rows.map((row) => row.item.kind)),
    ).not.toContain("turn.taken");
  });

  test("a take recorded on the session still holds once it has slid out of the live window (A6 U4 review)", () => {
    // The feed keeps only its newest items (`App.LIVE_KEPT`): the take is gone from it, and
    // the session's record of it is what still says where the steer was taken.
    const groups = chat([...before, ...after], true, { [MESSAGE]: take });
    expect(read(groups)).toEqual([
      {
        message: "load the policy",
        queued: false,
        working: false,
        rows: ["reading it", "fetch_page→nine rows"],
      },
      {
        message: "and the portal",
        queued: false,
        working: true,
        rows: ["adding the portal"],
      },
    ]);
    expect(groups[1]?.subject.startedAt).toBe(take.at);
  });

  test("a session gone idle with no take places it where it was sent, as before", () => {
    const groups = chat([...before, ...after], false);
    expect(read(groups).map((group) => [group.message, group.queued])).toEqual([
      ["load the policy", false],
      ["and the portal", false],
    ]);
    // Sent at floor 5, and nothing said where the harness took it: everything published
    // after the send is under it, as every row was placed before U4 (the take may have been
    // dropped from the lossy channel).
    expect(read(groups)[1]?.rows).toEqual([
      "reading it",
      "fetch_page→nine rows",
      "adding the portal",
    ]);
    expect(read(groups)[0]?.rows).toEqual([]);
  });
});

/*
 * A6 U6 review: a "Send now" sent after a queued message is taken before it — both
 * harnesses jump a preemptive steer ahead of queued ones (measured on haiku and GLM) — so
 * the tab's own rows are not in the order their takes are.
 */
describe("U6 review: a Send now taken ahead of a message queued before it", () => {
  const QUEUED = "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
  const NOW = "nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn";
  const live = (n: number, over: Partial<LiveItem> & Pick<LiveItem, "kind">) =>
    item({ id: `activity:${String(n)}`, importId: "imp_1", ...over });
  const first = operator(1, "a glossary of sixty scope terms");
  const queued = { ...operator(2, "QUEUED"), messageIds: [QUEUED] };
  const now = { ...operator(3, "NOW"), messageIds: [NOW] };
  // Sent in this order: the glossary, then the queued one, then the Send now.
  const own = [first, queued, now];
  const floors = { [first.id]: 0, [queued.id]: 5, [now.id]: 6 };
  const feed = [
    live(3, { kind: "turn.reply", body: "the glossary" }),
    live(7, { kind: "turn.taken", messageIds: [NOW] }),
    live(8, { kind: "turn.reply", body: "answering NOW" }),
    live(9, { kind: "turn.taken", messageIds: [QUEUED] }),
    live(10, { kind: "turn.reply", body: "answering QUEUED" }),
  ];
  const read = (working: boolean) =>
    buildImporterChat({
      history: NO_HISTORY,
      working,
      midTurn: [queued.id, now.id],
      sentNow: [NOW],
      items: importerFeed({
        own,
        floors,
        live: feed,
        importId: "imp_1",
        midTurn: [queued.id, now.id],
        working,
      }),
    }).map((group) => ({
      message: group.subject.message,
      rows: group.rows.map((row) => row.item.body),
      ...(group.prose?._tag === "none" ? { none: true } : {}),
    }));

  test("each reply is under the message it answers, in the order the harness took them", () => {
    for (const working of [true, false]) {
      expect(read(working)).toEqual([
        { message: "a glossary of sixty scope terms", rows: ["the glossary"] },
        { message: "NOW", rows: ["answering NOW"] },
        { message: "QUEUED", rows: ["answering QUEUED"] },
      ]);
    }
  });

  test("before either is taken, both wait at the end in the order they were sent", () => {
    const groups = buildImporterChat({
      history: NO_HISTORY,
      working: true,
      midTurn: [queued.id, now.id],
      sentNow: [NOW],
      items: importerFeed({
        own,
        floors,
        live: feed.slice(0, 1),
        importId: "imp_1",
        midTurn: [queued.id, now.id],
        working: true,
      }),
    });
    expect(
      groups.map((group) => [group.subject.message, group.subject.queued]),
    ).toEqual([
      ["a glossary of sixty scope terms", false],
      ["QUEUED", true],
      ["NOW", true],
    ]);
    expect(groups[0]?.rows.map((row) => row.item.body)).toEqual([
      "the glossary",
    ]);
  });
});

/*
 * A6 U4 review: a message still queued in the live session is in no transcript, so the
 * server's replay carries it beside the transcript, and the page draws it as its own row.
 */
describe("a replay's queued messages, and a replay read again", () => {
  const MESSAGE = "aaaaaaaabbbbbbbbccccccccdddddddd";
  const session = (over: Partial<ImporterSession> = {}): ImporterSession => ({
    ...indexedSession(
      importerSessionView({ importId: "imp_1" }),
      "Claude Code",
    ),
    working: true,
    ...over,
  });
  const view = (over: Parameters<typeof importerConversationView>[0] = {}) =>
    importerConversationView({
      importId: "imp_1",
      live: true,
      continuation: "live",
      at: AT + 10_000,
      ...over,
    });

  test("slice 3 fix: a message the harness's process never took is drawn not delivered, never sent now or queued", () => {
    // Sent with Send now; Pi died before it read it.
    const installed = withReplay(
      session({ working: false, sentNow: [MESSAGE] }),
      {
        view: view({
          queued: [
            {
              messageId: MESSAGE,
              text: "read this next",
              acceptedAt: AT + 5_000,
              taken: false,
              lost: true,
            },
          ],
        }),
        floor: 7,
      },
    );
    expect(installed.history.lost).toEqual([MESSAGE]);
    // It waits on nothing: the process it was queued in is gone.
    expect(installed.midTurn).toEqual([]);
    for (const working of [false, true]) {
      const groups = buildImporterChat({
        history: installed.history,
        working,
        midTurn: [`operator:queued:${MESSAGE}`],
        sentNow: [MESSAGE],
        items: importerFeed({
          own: installed.items,
          floors: installed.floors,
          live: [],
          importId: "imp_1",
          historyFloor: installed.historyFloor,
          midTurn: installed.midTurn,
          working,
        }),
      });
      const lost = groups.find(
        (group) => group.subject.message === "read this next",
      );
      expect([
        lost?.subject.undelivered,
        lost?.subject.sentNow,
        lost?.subject.queued,
      ]).toEqual([true, false, false]);
      expect(lost?.prose).toEqual({
        _tag: "none",
        // It says how long the mark lasts (slice 3 fix 2, L1): the next message closes the
        // dead period, and the server's queue that held it goes with it.
        note: "Not delivered: the importer's process ended before it read this message. Send it again if it still matters; this mark goes with your next message.",
      });
    }
    // A message not lost keeps its marks.
    const kept = withReplay(session(), {
      view: view({
        queued: [
          {
            messageId: MESSAGE,
            text: "and the portal",
            acceptedAt: AT + 5_000,
            taken: false,
          },
        ],
      }),
      floor: 7,
    });
    expect(kept.history.lost).toBeUndefined();
  });

  test("a queued message is a row of its own at the end, waiting, until its take", () => {
    const installed = withReplay(session(), {
      view: view({
        queued: [
          {
            messageId: MESSAGE,
            text: "and the portal",
            acceptedAt: AT + 5_000,
            taken: false,
          },
        ],
      }),
      floor: 7,
    });
    expect(
      installed.items.map((row) => [row.kind, row.body, row.messageIds]),
    ).toEqual([["turn.operator", "and the portal", [MESSAGE]]]);
    expect(installed.midTurn).toEqual([`operator:queued:${MESSAGE}`]);
    expect(installed.historyFloor).toBe(7);
    expect(installed.loaded).toBe(true);

    const groups = (live: readonly LiveItem[]) =>
      buildImporterChat({
        history: installed.history,
        working: true,
        midTurn: installed.midTurn ?? [],
        items: importerFeed({
          own: installed.items,
          floors: installed.floors,
          live,
          importId: "imp_1",
          historyFloor: installed.historyFloor,
          midTurn: installed.midTurn,
          working: true,
        }),
      });
    const tail = item({
      id: "activity:8",
      importId: "imp_1",
      kind: "turn.reply",
      body: "still on it",
    });
    const waiting = groups([tail]);
    expect(
      waiting.map((group) => [group.subject.message, group.subject.queued]),
    ).toEqual([
      ["Read the policy page", false],
      ["and the portal", true],
    ]);
    // The work before the take is the replayed turn's, not the queued message's.
    expect(waiting[0]?.rows.map((row) => row.item.body)).toContain(
      "still on it",
    );

    const take = item({
      id: "activity:9",
      importId: "imp_1",
      kind: "turn.taken",
      messageIds: [MESSAGE],
    });
    const answer = item({
      id: "activity:10",
      importId: "imp_1",
      kind: "turn.reply",
      body: "adding the portal",
    });
    const taken = groups([tail, take, answer]);
    expect(
      taken.map((group) => [group.subject.message, group.subject.queued]),
    ).toEqual([
      ["Read the policy page", false],
      ["and the portal", false],
    ]);
    expect(taken[1]?.rows.map((row) => row.item.body)).toEqual([
      "adding the portal",
    ]);
  });

  test("read again, rows are joined to the answer by message id, never by time (U4 review 2)", () => {
    const own = (
      index: number,
      text: string,
      at: number,
      messageId: string,
    ) => ({
      ...operatorTurn({ index, text, at, after: index + 2 }),
      messageIds: [messageId],
    });
    const before = session({
      items: [
        // Held when the read was asked: its message is in the answer's transcript.
        own(1, "written", AT + 1_000, "m1"),
        // Held when asked, still waiting in the live session: this tab's row is kept.
        own(2, "waiting", AT + 2_000, "m2"),
        // Sent while the read was out, accepted before the answer's stamp and in neither
        // half of it: a cut at `view.at` dropped it.
        own(3, "during the read", AT + 9_000, "m3"),
        // Sent while the read was out, accepted after the stamp, and in the answer's
        // `queued` (read after the stamp): a cut at `view.at` drew it twice.
        own(4, "after the stamp", AT + 11_000, "m4"),
      ],
      floors: {
        "operator:1": 3,
        "operator:2": 4,
        "operator:3": 5,
        "operator:4": 6,
      },
      midTurn: ["operator:2", "operator:3", "operator:4"],
      loaded: true,
      historyFloor: 1,
    });
    const again = withReplay(
      before,
      {
        view: view({
          at: AT + 10_000,
          items: [
            replayItem(0, "turn.operator", "written", {
              importId: "imp_1",
              messageIds: ["m1"],
            }),
          ],
          queued: [
            {
              messageId: "m2",
              text: "waiting",
              acceptedAt: AT + 2_000,
              taken: false,
            },
            {
              messageId: "m4",
              text: "after the stamp",
              acceptedAt: AT + 11_000,
              taken: false,
            },
          ],
        }),
        floor: 9,
      },
      new Set(["operator:1", "operator:2"]),
    );
    expect(again.items.map((row) => row.body)).toEqual([
      "waiting",
      "during the read",
      "after the stamp",
    ]);
    expect(again.items.map((row) => row.id)).toEqual([
      "operator:2",
      "operator:3",
      "operator:4",
    ]);
    expect(again.floors).toEqual({
      "operator:2": 4,
      "operator:3": 5,
      "operator:4": 6,
    });
    expect(again.midTurn).toEqual(["operator:2", "operator:3", "operator:4"]);
    expect(again.historyFloor).toBe(9);
    // "written" is drawn once, from the transcript.
    const groups = buildImporterChat({
      history: again.history,
      items: again.items,
      working: true,
      midTurn: again.midTurn ?? [],
    });
    expect(groups.map((group) => group.subject.message)).toEqual([
      "written",
      "waiting",
      "during the read",
      "after the stamp",
    ]);
  });

  test("a row held when the read was asked, with no id, is the transcript's; one sent after it is kept", () => {
    const before = session({
      items: [
        operatorTurn({ index: 1, text: "opened it", at: AT, after: 2 }),
        operatorTurn({
          index: 2,
          text: "reopened it",
          at: AT + 20_000,
          after: 8,
        }),
      ],
      floors: { "operator:1": 2, "operator:2": 8 },
      loaded: true,
      historyFloor: 1,
    });
    const again = withReplay(
      before,
      {
        view: view({
          at: AT + 30_000,
          items: [
            replayItem(0, "turn.operator", "opened it", { importId: "imp_1" }),
          ],
        }),
        floor: 9,
      },
      new Set(["operator:1"]),
    );
    expect(again.items.map((row) => row.body)).toEqual(["reopened it"]);
  });

  test("a message the harness took and has not written yet is drawn as its own turn with its reply (U4 review 2)", () => {
    /*
     * Claude Code narrates the take 30–130 ms before its transcript holds the message, and a
     * tab that saw the take of a message it had no row for reads the replay in that gap: the
     * message is not in `items`, and the server now still holds it, marked taken.
     */
    const loaded = session({ loaded: true, historyFloor: 5, items: [] });
    const take = item({
      id: "activity:6",
      importId: "imp_1",
      kind: "turn.taken",
      messageIds: [MESSAGE],
    });
    expect(takesUnknownMessage(loaded, take)).toBe(true);
    const again = withReplay(
      loaded,
      {
        view: view({
          queued: [
            {
              messageId: MESSAGE,
              text: "from the other tab",
              acceptedAt: AT + 5_000,
              taken: true,
            },
          ],
        }),
        floor: 6,
      },
      new Set(),
    );
    // A row for it now, so the next sighting of its take asks for nothing.
    expect(takesUnknownMessage(again, take)).toBe(false);
    // Not queued: the harness has it.
    expect(again.midTurn).toEqual([]);
    const reply7 = item({
      id: "activity:7",
      importId: "imp_1",
      kind: "turn.reply",
      body: "on it",
    });
    const groups = buildImporterChat({
      history: again.history,
      working: true,
      midTurn: again.midTurn ?? [],
      items: importerFeed({
        own: again.items,
        floors: again.floors,
        live: [take, reply7],
        importId: "imp_1",
        historyFloor: again.historyFloor,
        midTurn: again.midTurn,
        working: true,
      }),
    });
    expect(
      groups.map((group) => [group.subject.message, group.subject.queued]),
    ).toEqual([
      ["Read the policy page", false],
      ["from the other tab", false],
    ]);
    expect(groups[1]?.rows.map((row) => row.item.body)).toEqual(["on it"]);
  });

  test("the harness's note on its copy is said once a thread, not under every replayed turn", () => {
    const replayed = historyOf(
      view({
        note: "From Claude Code, which may delete it.",
        items: [
          replayItem(0, "turn.operator", "first", { importId: "imp_1" }),
          replayItem(1, "turn.reply", "one", { importId: "imp_1" }),
          replayItem(2, "turn.operator", "second", { importId: "imp_1" }),
          replayItem(3, "turn.reply", "two", { importId: "imp_1" }),
          replayItem(4, "turn.operator", "third", { importId: "imp_1" }),
          replayItem(5, "turn.reply", "three", { importId: "imp_1" }),
        ],
      }),
    );
    const groups = buildImporterChat({
      history: replayed,
      items: [],
      working: false,
    });
    expect(
      groups.map((group) =>
        group.prose._tag === "replayed" ? group.prose.note : group.prose._tag,
      ),
    ).toEqual(["From Claude Code, which may delete it.", "", ""]);
  });

  test("a take for a message the transcript holds by id asks for nothing", () => {
    const loaded = session({
      loaded: true,
      historyFloor: 5,
      history: historyOf(
        view({
          items: [
            replayItem(0, "turn.operator", "theirs", {
              importId: "imp_1",
              messageIds: ["theirs"],
            }),
          ],
        }),
      ),
    });
    expect(
      takesUnknownMessage(
        loaded,
        item({
          id: "activity:6",
          importId: "imp_1",
          kind: "turn.taken",
          messageIds: ["theirs"],
        }),
      ),
    ).toBe(false);
  });

  test("a take for a message with no row asks for the replay again; one for a known row, or under the floor, does not", () => {
    const loaded = session({
      loaded: true,
      historyFloor: 5,
      items: [
        {
          ...operatorTurn({ index: 1, text: "mine", at: AT, after: 5 }),
          messageIds: ["mine"],
        },
      ],
    });
    const take = (n: number, messageId: string) =>
      item({
        id: `activity:${String(n)}`,
        importId: "imp_1",
        kind: "turn.taken",
        messageIds: [messageId],
      });
    expect(takesUnknownMessage(loaded, take(6, "theirs"))).toBe(true);
    expect(takesUnknownMessage(loaded, take(6, "mine"))).toBe(false);
    // At or under the floor: the replay was built after it, and holds the message.
    expect(takesUnknownMessage(loaded, take(5, "theirs"))).toBe(false);
    // A session whose replay has not been read reads it anyway.
    expect(
      takesUnknownMessage({ ...loaded, loaded: false }, take(6, "theirs")),
    ).toBe(false);
  });
});

/*
 * A6 U4 review 3: Claude Code takes every steer waiting behind a turn at once, names them all
 * on one frame, and stores them as ONE user entry (texts a line apart, under the last one's
 * uuid). They are one message to the agent, with one reply — so one turn here, live and
 * after a reload alike. OpenCode takes them one at a time: a take of one is unchanged.
 */
describe("U4 review 3: steers the harness took as one", () => {
  const PAGE = "11111111222222223333333344444444";
  const OTHER = "55555555666666667777777788888888";
  const live = (n: number, over: Partial<LiveItem> & Pick<LiveItem, "kind">) =>
    item({ id: `activity:${String(n)}`, importId: "imp_1", ...over });
  const own = (index: number, text: string, messageId?: string): LiveItem => ({
    ...operatorTurn({ index, text, at: AT + index * 1_000, after: index }),
    ...(messageId === undefined ? {} : { messageIds: [messageId] }),
  });
  const view = (over: Parameters<typeof importerConversationView>[0] = {}) =>
    importerConversationView({
      importId: "imp_1",
      live: true,
      continuation: "live",
      at: AT + 10_000,
      ...over,
    });
  const session = (over: Partial<ImporterSession> = {}): ImporterSession => ({
    ...indexedSession(
      importerSessionView({ importId: "imp_1" }),
      "Claude Code",
    ),
    working: true,
    ...over,
  });
  /** The groups the page draws for a session and the live feed, as `App` builds them. */
  const drawn = (current: ImporterSession, feed: readonly LiveItem[]) =>
    buildImporterChat({
      history: current.history,
      working: current.working,
      ...(current.midTurn === undefined ? {} : { midTurn: current.midTurn }),
      ...(current.taken === undefined ? {} : { taken: current.taken }),
      items: importerFeed({
        own: current.items,
        floors: current.floors,
        live: feed,
        importId: "imp_1",
        historyFloor: current.historyFloor,
        midTurn: current.midTurn,
        working: current.working,
        taken: current.taken,
      }),
    }).map((group) => ({
      message: group.subject.message,
      queued: group.subject.queued,
      prose: group.prose._tag,
      rows: group.rows.map((row) => row.item.body),
    }));
  const take = live(8, { kind: "turn.taken", messageIds: [PAGE, OTHER] });
  const answer = live(9, { kind: "turn.reply", body: "Both noted." });

  test("live, two of this tab's messages taken as one are one turn with one reply", () => {
    const first = own(1, "load the policy");
    const page = own(2, "MG-PAGE", PAGE);
    const other = own(3, "MG-OTHER", OTHER);
    const current = session({
      working: false,
      loaded: true,
      items: [first, page, other],
      floors: { [first.id]: 0, [page.id]: 6, [other.id]: 7 },
      midTurn: [page.id, other.id],
      taken: { [PAGE]: take, [OTHER]: take },
    });
    expect(
      drawn(current, [
        live(5, { kind: "turn.reply", body: "reading it" }),
        take,
        answer,
      ]),
    ).toEqual([
      {
        message: "load the policy",
        queued: false,
        prose: "live",
        rows: ["reading it"],
      },
      {
        message: "MG-PAGE\nMG-OTHER",
        queued: false,
        prose: "live",
        rows: ["Both noted."],
      },
    ]);
  });

  test("U4 step 0: two takes sharing an id across a server restart are two turns, not one", () => {
    const THIRD = "99999999aaaaaaaabbbbbbbbcccccccc";
    const FOURTH = "ddddddddeeeeeeeeffffffff00000000";
    // Recorded before the restart, and seen after it under the same publish-order id.
    const before = live(8, { kind: "turn.taken", messageIds: [PAGE, OTHER] });
    const after = live(8, { kind: "turn.taken", messageIds: [FOURTH, THIRD] });
    const rows = [
      own(1, "MG-PAGE", PAGE),
      own(2, "MG-OTHER", OTHER),
      own(3, "MG-THIRD", THIRD),
      own(4, "MG-FOURTH", FOURTH),
    ];
    const current = session({
      working: false,
      loaded: true,
      items: rows,
      floors: Object.fromEntries(rows.map((row, at) => [row.id, at])),
      taken: {
        [PAGE]: before,
        [OTHER]: before,
        [THIRD]: after,
        [FOURTH]: after,
      },
    });
    expect(drawn(current, [after]).map((group) => group.message)).toEqual([
      "MG-PAGE\nMG-OTHER",
      "MG-THIRD\nMG-FOURTH",
    ]);
  });

  test("a take naming one row of this tab's and one from another tab asks for the replay, and draws one turn", () => {
    const first = own(1, "load the policy");
    const page = own(2, "MG-PAGE", PAGE);
    const loaded = session({
      loaded: true,
      historyFloor: 4,
      items: [first, page],
      floors: { [first.id]: 0, [page.id]: 6 },
      midTurn: [page.id],
      taken: { [PAGE]: take, [OTHER]: take },
    });
    // The other tab's message has no row here: read again.
    expect(takesUnknownMessage(loaded, take)).toBe(true);
    expect(
      takesUnknownMessage(
        { ...loaded, items: [...loaded.items, own(3, "MG-OTHER", OTHER)] },
        take,
      ),
    ).toBe(false);

    // Read in the gap: both held by the server, taken together, neither written yet.
    const held = new Set(loaded.items.map((row) => row.id));
    const gap = withReplay(
      loaded,
      {
        view: view({
          items: [
            replayItem(0, "turn.operator", "load the policy", {
              importId: "imp_1",
            }),
          ],
          queued: [
            {
              messageId: PAGE,
              text: "MG-PAGE",
              acceptedAt: AT + 2_000,
              taken: true,
              takenTogether: [PAGE, OTHER],
            },
            {
              messageId: OTHER,
              text: "MG-OTHER",
              acceptedAt: AT + 3_000,
              taken: true,
              takenTogether: [PAGE, OTHER],
            },
          ],
        }),
        floor: 7,
      },
      held,
    );
    expect(drawn({ ...gap, working: false }, [take, answer])).toEqual([
      {
        message: "load the policy",
        queued: false,
        prose: "none",
        rows: [],
      },
      {
        message: "MG-PAGE\nMG-OTHER",
        queued: false,
        prose: "live",
        rows: ["Both noted."],
      },
    ]);

    // Read once written: Claude Code's one entry, named as both. This tab's row goes.
    const written = withReplay(
      loaded,
      {
        view: view({
          items: [
            replayItem(0, "turn.operator", "load the policy", {
              importId: "imp_1",
            }),
            replayItem(1, "turn.operator", "MG-PAGE\nMG-OTHER", {
              importId: "imp_1",
              messageIds: [PAGE, OTHER],
            }),
          ],
        }),
        floor: 8,
      },
      held,
    );
    expect(written.items).toEqual([]);
    expect(
      drawn({ ...written, working: false }, [take, answer]).map(
        (group) => group.message,
      ),
    ).toEqual(["load the policy", "MG-PAGE\nMG-OTHER"]);
  });

  test("a reload while they are taken and not yet written draws them as one row, not queued", () => {
    const reloaded = withReplay(session(), {
      view: view({
        queued: [
          {
            messageId: PAGE,
            text: "MG-PAGE",
            acceptedAt: AT + 2_000,
            taken: true,
            takenTogether: [PAGE, OTHER],
          },
          {
            messageId: OTHER,
            text: "MG-OTHER",
            acceptedAt: AT + 3_000,
            taken: true,
            takenTogether: [PAGE, OTHER],
          },
        ],
      }),
      floor: 7,
    });
    expect(
      reloaded.items.map((row) => [row.body, row.messageIds ?? null]),
    ).toEqual([["MG-PAGE\nMG-OTHER", [PAGE, OTHER]]]);
    expect(reloaded.midTurn).toEqual([]);
  });

  test("OpenCode's takes of one each stay two turns", () => {
    const first = own(1, "load the policy");
    const page = own(2, "MG-PAGE", PAGE);
    const other = own(3, "MG-OTHER", OTHER);
    const takePage = live(8, { kind: "turn.taken", messageIds: [PAGE] });
    const takeOther = live(10, { kind: "turn.taken", messageIds: [OTHER] });
    const current = session({
      working: false,
      loaded: true,
      items: [first, page, other],
      floors: { [first.id]: 0, [page.id]: 6, [other.id]: 7 },
      midTurn: [page.id, other.id],
    });
    expect(
      drawn(current, [
        takePage,
        live(9, { kind: "turn.reply", body: "page noted" }),
        takeOther,
        live(11, { kind: "turn.reply", body: "other noted" }),
      ]).map((group) => [group.message, group.rows]),
    ).toEqual([
      ["load the policy", []],
      ["MG-PAGE", ["page noted"]],
      ["MG-OTHER", ["other noted"]],
    ]);
  });
});

/*
 * A6 U5: a block while it is being written. The feed's partials are applied by `blockId`
 * before they reach here (`App.applyLiveFrame`, `withBlock`); what is decided here is which
 * of them a turn draws, and how each stands.
 */
describe("A6 U5: blocks still being written", () => {
  const partial = (
    body: string,
    blockId: string,
    kind: "turn.reply" | "turn.thinking" = "turn.reply",
  ): LiveItem =>
    item({
      kind,
      headline: "",
      body,
      blockId,
      // The call, as the server names it beside the block (A6 U5 review).
      blockCall: blockId.replace(/:(?:text:|reasoning:)?\d+$/u, ""),
      streaming: true,
      importId: "imp_1",
    });
  const rowsOf = (input: Parameters<typeof buildImporterChat>[0]) =>
    buildImporterChat(input).map((group) =>
      group.rows.map(
        (row) =>
          `${row.item.body}${row.stream === undefined ? "" : ` [${row.stream}]`}`,
      ),
    );

  test("the turn being worked on draws its partial as writing", () => {
    expect(
      rowsOf({
        history: NO_HISTORY,
        items: [operator(1, "load it"), partial("Reading", "s:m1:0")],
        working: true,
      }),
    ).toEqual([["Reading [writing]"]]);
  });

  test("once the session is idle, a partial that never got its finished block is gone", () => {
    expect(
      rowsOf({
        history: NO_HISTORY,
        items: [
          operator(1, "load it"),
          partial("First try", "s:m1:0"),
          reply("Second try, finished."),
        ],
        working: false,
      }),
    ).toEqual([["Second try, finished."]]);
  });

  test("a partial left in an earlier turn is gone while a later turn is worked on", () => {
    expect(
      rowsOf({
        history: NO_HISTORY,
        items: [
          operator(1, "load it"),
          partial("Left behind", "s:m1:0"),
          operator(2, "and the portal"),
          partial("Now writing", "s:m2:0"),
        ],
        working: true,
      }),
    ).toEqual([[], ["Now writing [writing]"]]);
  });

  test("GLM: a thought is no longer writing once a reply of the same message has started", () => {
    const thought = partial(
      "Weighing it",
      "s:msg_1:reasoning:0",
      "turn.thinking",
    );
    const other = partial(
      "An older step",
      "s:msg_0:reasoning:0",
      "turn.thinking",
    );
    const answer = partial("The answer", "s:msg_1:text:0");
    expect([...streamStates([other, thought, answer]).values()]).toEqual([
      "writing",
      "done",
      "writing",
    ]);
    // Alone, it is still being written.
    expect([...streamStates([thought]).values()]).toEqual(["writing"]);
  });

  test("U5 review: the same call is the server's `blockCall`, never read out of `blockId`", () => {
    // Block ids shaped alike, calls the server says differ: the thought is still writing.
    const thought = {
      ...partial("Weighing it", "s:msg_1:reasoning:0", "turn.thinking"),
      blockCall: "s:call_a",
    };
    const answer = {
      ...partial("The answer", "s:msg_1:text:0"),
      blockCall: "s:call_b",
    };
    expect([...streamStates([thought, answer]).values()]).toEqual([
      "writing",
      "writing",
    ]);
    // Ids that share nothing, one call: the thought is done.
    expect(
      [
        ...streamStates([
          { ...thought, blockId: "x" },
          { ...answer, blockId: "y", blockCall: "s:call_a" },
        ]).values(),
      ][0],
    ).toBe("done");
    // No call named: nothing is decided from the id.
    const unnamed = (each: LiveItem): LiveItem =>
      Object.fromEntries(
        Object.entries(each).filter(([key]) => key !== "blockCall"),
      ) as LiveItem;
    const unnamedThought = unnamed(thought);
    const unnamedAnswer = unnamed(answer);
    expect([...streamStates([unnamedThought, unnamedAnswer]).values()][0]).toBe(
      "writing",
    );
  });

  test("a thought past the 4,000-character cap is shortened, not writing", () => {
    const long = partial(
      "x".repeat(PARTIAL_BODY_MAX),
      "s:m1:0",
      "turn.thinking",
    );
    expect([...streamStates([long]).values()]).toEqual(["shortened"]);
  });

  test("U5 review 2: a partial is past the cap by its length, as the server cuts it with no mark", () => {
    // The server's cut partial is exactly the cap long (`streamingCoalescer`'s `flush`).
    const under = partial("x".repeat(PARTIAL_BODY_MAX - 1), "s:m1:0");
    const at = partial("x".repeat(PARTIAL_BODY_MAX), "s:m2:0");
    expect([...streamStates([under]).values()]).toEqual(["writing"]);
    expect([...streamStates([at]).values()]).toEqual(["shortened"]);
    expect(PARTIAL_BODY_MAX).toBe(4_000);
  });

  test("a block's row keeps one key from its first partial to its finished copy", () => {
    const keys = (items: LiveItem[]) =>
      buildImporterChat({ history: NO_HISTORY, items, working: true }).flatMap(
        (group) => group.rows.map((row) => row.key),
      );
    const first = partial("Read", "s:m1:0");
    const finished = { ...reply("Read it."), blockId: "s:m1:0" };
    expect(keys([operator(1, "go"), first])).toEqual(
      keys([operator(1, "go"), finished]),
    );
  });

  test("a reload while the harness is part way through a block shows the turn in progress", () => {
    const history = {
      ...NO_HISTORY,
      source: "harness" as const,
      items: [replayItem(0, "turn.operator", "load it", { importId: "imp_1" })],
    };
    const working = buildImporterChat({ history, items: [], working: true });
    expect(
      working.map((group) => [group.subject.midBlock, group.prose]),
    ).toEqual([[true, { _tag: "pending", note: MID_BLOCK_NOTE }]]);
    // Idle, it is the harness holding a message with no reply, as before.
    const idle = buildImporterChat({ history, items: [], working: false });
    expect(
      idle.map((group) => [group.subject.midBlock, group.prose._tag]),
    ).toEqual([[false, "none"]]);
  });
});

/*
 * A6 U6 review 2: a Send now that lands before the turn it cuts has written anything. Claude
 * Code ends that turn with only its own diagnostic and sends its message on with the Send
 * now; one reply answers both. The server says so with a `turn.carried` item, live and in a
 * replay of the two stored messages in a row.
 */
describe("a message carried on with the next one", () => {
  const A = "a".repeat(32);
  const B = "b".repeat(32);
  const carried = (ids: readonly string[], space = "activity:9"): LiveItem => ({
    ...item({
      kind: "turn.carried",
      headline: "Went on with the next message",
    }),
    id: space,
    importId: "imp_1",
    ...(ids.length === 0 ? {} : { messageIds: [...ids] }),
  });
  const mine = (index: number, text: string, id: string): LiveItem => ({
    ...operator(index, text),
    messageIds: [id],
  });
  const notes = (groups: ReturnType<typeof buildImporterChat>) =>
    groups.map((group) =>
      group.prose._tag === "none" || group.prose._tag === "pending"
        ? group.prose.note
        : group.prose._tag,
    );

  test("live: its turn says it was answered with the next, not that it wrote nothing; the carry is no row", () => {
    const groups = buildImporterChat({
      history: NO_HISTORY,
      items: [
        mine(0, "What is 2+2?", A),
        carried([A]),
        mine(1, "Also name a colour.", B),
        reply("Four. Blue."),
      ],
      working: false,
    });
    expect(notes(groups)).toEqual([CARRIED_NOTE, "live"]);
    expect(groups[0]?.rows).toHaveLength(0);
  });

  test("after a reload: the replay's carry draws the same", () => {
    const groups = buildImporterChat({
      history: history({
        source: "harness",
        note: "From the harness.",
        items: [
          replayItem(0, "turn.operator", "What is 2+2?", { messageIds: [A] }),
          replayItem(1, "turn.carried", "", { messageIds: [A] }),
          replayItem(2, "turn.operator", "Also name a colour.", {
            messageIds: [B],
          }),
          replayItem(3, "turn.reply", "Four. Blue."),
        ],
      }),
      items: [],
      working: false,
    });
    expect(notes(groups)).toEqual([CARRIED_NOTE, "replayed"]);
    // The replay's one note goes on the turn that has words, not on the carried one.
    expect(groups[1]?.prose).toMatchObject({ note: "From the harness." });
  });

  test("a carry finds its message by id wherever it sorted, and a message no carry names keeps its own note", () => {
    // A live carry kept below a replay's floor sorts after the replay, so after a message
    // the server holds outside it (B, from another tab): it still marks A, never B.
    const groups = buildImporterChat({
      history: history({
        source: "harness",
        note: "From the harness.",
        items: [
          replayItem(0, "turn.operator", "What is 2+2?", { messageIds: [A] }),
          replayItem(1, "turn.operator", "Also name a colour.", {
            id: "operator:queued:b",
            messageIds: [B],
          }),
        ],
      }),
      items: [carried([A])],
      working: true,
    });
    expect(notes(groups)[0]).toBe(CARRIED_NOTE);
    expect(notes(groups)[1]).not.toBe(CARRIED_NOTE);
  });

  test("a carry naming no message (the opening prompt's) marks the turn it lands in", () => {
    const groups = buildImporterChat({
      history: NO_HISTORY,
      items: [
        operator(0, "Load the scope."),
        carried([]),
        operator(1, "Skip the blog."),
        reply("Loading, without the blog."),
      ],
      working: false,
    });
    expect(notes(groups)).toEqual([CARRIED_NOTE, "live"]);
  });

  /** The CLI's interrupt marker where a Stop landed, live (A6 U6 review 3). */
  const marker = (): LiveItem =>
    item({
      kind: "turn.other",
      headline: "interrupted",
      body: "[Request interrupted by user]",
      importId: "imp_1",
    });

  test("U6 review 3: the carry note promises no reply", () => {
    // A Stop just after the Send now can end the next turn before it answers: the note
    // must be true then too.
    expect(CARRIED_NOTE).not.toMatch(/answer|reply|below/i);
  });

  test("U6 review 3: A, Send now B, Stop — A went on with B, and B reads stopped, live", () => {
    const groups = buildImporterChat({
      history: NO_HISTORY,
      items: [
        mine(0, "What is 2+2?", A),
        carried([A]),
        mine(1, "Also name a colour.", B),
        marker(),
      ],
      working: false,
    });
    expect(notes(groups)).toEqual([CARRIED_NOTE, STOPPED_NOTE]);
    // The marker is said in B's note, not drawn as a row beside it.
    expect(groups.map((group) => group.rows.length)).toEqual([0, 0]);
  });

  test("U6 review 3: A, Send now B, Stop — the same after a reload", () => {
    const groups = buildImporterChat({
      history: history({
        source: "harness",
        note: "From the harness.",
        items: [
          replayItem(0, "turn.operator", "What is 2+2?", { messageIds: [A] }),
          replayItem(1, "turn.carried", "", { messageIds: [A] }),
          replayItem(2, "turn.operator", "Also name a colour.", {
            messageIds: [B],
          }),
          replayItem(3, "turn.other", "[Request interrupted by user]", {
            headline: "interrupted",
          }),
        ],
      }),
      items: [],
      working: false,
    });
    expect(notes(groups)).toEqual([CARRIED_NOTE, STOPPED_NOTE]);
    expect(groups.map((group) => group.rows.length)).toEqual([0, 0]);
  });

  test("U6 review 3: a Stop in a turn that wrote something keeps its marker as a row, where the Stop landed", () => {
    const groups = buildImporterChat({
      history: NO_HISTORY,
      items: [mine(0, "List the glossary.", A), reply("ASN — "), marker()],
      working: false,
    });
    expect(notes(groups)).toEqual(["live"]);
    expect(groups[0]?.rows.map((row) => row.item.headline)).toEqual([
      "Importer",
      "interrupted",
    ]);
  });

  test("U6 review 3: a carried turn that has rows is drawn by its rows, never as carried", () => {
    // A live carry naming a turn that wrote something (a Send now taken after a tool call):
    // the turn reads as what it wrote, live and with its rows from a replay.
    const live = buildImporterChat({
      history: NO_HISTORY,
      items: [
        mine(0, "Read the scope.", A),
        reply("Reading it."),
        carried([A]),
        mine(1, "Also name a colour.", B),
        reply("Blue."),
      ],
      working: false,
    });
    expect(notes(live)).toEqual(["live", "live"]);
    expect(live[0]?.rows).toHaveLength(1);
    const reloaded = buildImporterChat({
      history: history({
        source: "harness",
        note: "From the harness.",
        items: [
          replayItem(0, "turn.operator", "Read the scope.", {
            messageIds: [A],
          }),
          replayItem(1, "turn.reply", "Reading it."),
          replayItem(2, "turn.operator", "Also name a colour.", {
            messageIds: [B],
          }),
          replayItem(3, "turn.reply", "Blue."),
        ],
      }),
      items: [carried([A], "activity:5")],
      working: false,
    });
    expect(notes(reloaded)[0]).toBe("replayed");
    expect(notes(reloaded)).not.toContain(CARRIED_NOTE);
  });

  test("a live carry below the floor is kept while the replay holds its message and no carry for it, and only then", () => {
    // Claude Code writes the Send now's message 30-130 ms after taking it: a re-read in that
    // gap ends on A alone, while the live carry is already under its floor.
    const gap = [
      replayItem(0, "turn.operator", "What is 2+2?", { messageIds: [A] }),
    ];
    const kept = importerFeed({
      own: [],
      floors: {},
      live: [carried([A], "activity:5")],
      importId: "imp_1",
      historyFloor: 20,
      replayed: gap,
      callInFlight: true,
    });
    expect(kept.map((each) => each.kind)).toEqual(["turn.carried"]);
    // The replay holds its own carry: the live one is the replay's, as a block is.
    const both = importerFeed({
      own: [],
      floors: {},
      live: [carried([A], "activity:5")],
      importId: "imp_1",
      historyFloor: 20,
      replayed: [
        ...gap,
        replayItem(1, "turn.carried", "", { messageIds: [A] }),
      ],
      callInFlight: true,
    });
    expect(both).toHaveLength(0);
    // Read idle, the replay holds everything stored: nothing is still to come.
    const idle = importerFeed({
      own: [],
      floors: {},
      live: [carried([A], "activity:5")],
      importId: "imp_1",
      historyFloor: 20,
      replayed: gap,
      callInFlight: false,
    });
    expect(idle).toHaveLength(0);
  });
});
