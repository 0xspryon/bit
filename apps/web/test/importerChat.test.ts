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
  bitMcpServerName,
  claudeCodeToolName,
  type LiveItem,
  type ScopeImportTool,
} from "@bit/contracts";

import {
  callSignature,
  operatorTurn,
  resultLine,
  splitCode,
} from "../src/lib/chat";
import {
  INDEXED_HISTORY,
  NO_HISTORY,
  buildImporterChat,
  importerFeed,
  indexedSession,
  lastSessionSentence,
  sessionLabel,
  tallyLine,
  type ImporterHistory,
  acceptedNotice,
} from "../src/lib/importerChat";
import { importerSessionView } from "./fakeServer";

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

  test("a history this page cannot read is still said once a message has been typed into it", () => {
    // `INDEXED_HISTORY` is the page saying it cannot read this session's words. That does not
    // stop being true after one message, and without it the continuation of an old session
    // looks exactly like a brand-new one.
    const groups = buildImporterChat({
      history: INDEXED_HISTORY,
      working: false,
      items: [operator(1, "also the staging hosts")],
    });

    expect(groups.map((group) => group.key)).toEqual(["earlier", "turn:1"]);
    expect(groups[0]?.prose).toEqual({
      _tag: "pending",
      note: INDEXED_HISTORY.note,
    });
    // And it is not said when there is nothing to say: a plain history opens at the turn.
    expect(
      buildImporterChat({
        history: NO_HISTORY,
        working: false,
        items: [operator(1, "go")],
      }).map((group) => group.key),
    ).toEqual(["turn:1"]);
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
    messages: [
      { index: 0, type: "user", text: "first ask" },
      { index: 1, type: "assistant", text: "first answer" },
      { index: 2, type: "assistant", text: "a follow-up" },
      { index: 3, type: "user", text: "second ask" },
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
    expect(groups[0]?.replayed.map((message) => message.text)).toEqual([
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
    expect(groups[1]?.replayed).toEqual([]);
    expect(groups[1]?.prose._tag).toBe("none");
  });

  test("a replayed turn has no time, and live turns come after the replayed ones and are numbered on", () => {
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
    expect(groups[0]?.subject.at).toBeNull();
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

  test("is held with the server's figures, its running flag, and no invented conversation", () => {
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
    // It says why there is no conversation, rather than showing the empty thread.
    expect(held.history.source).toBe("pending");
    expect(held.history.note).toContain("does not read the session's messages");
    // And an unknown count is not the empty session: it keeps a time label.
    expect(sessionLabel(held)).toMatch(/^Session /);
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

describe("prose with code in it", () => {
  test("splits at backticks into runs, as data, so nothing the agent wrote is read as markup", () => {
    expect(
      splitCode("Three are in scope — `acme.com` and `<b>x</b>`."),
    ).toEqual([
      { code: false, text: "Three are in scope — " },
      { code: true, text: "acme.com" },
      { code: false, text: " and " },
      { code: true, text: "<b>x</b>" },
      { code: false, text: "." },
    ]);
  });

  test("leaves an unmatched backtick as typed", () => {
    expect(splitCode("a ` b")).toEqual([{ code: false, text: "a ` b" }]);
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
});
