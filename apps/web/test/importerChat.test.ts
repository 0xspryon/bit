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

import type { LiveItem } from "@bit/contracts";

import { operatorTurn } from "../src/lib/chat";
import {
  NO_HISTORY,
  buildImporterChat,
  tallyLine,
  type ImporterHistory,
} from "../src/lib/importerChat";

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
const write = (callId: string, host: string): LiveItem =>
  item({
    kind: "tool.call",
    headline: "write_scope_entry",
    tool: "mcp__bit-importer__write_scope_entry",
    toolName: "write_scope_entry",
    callId,
    input: JSON.stringify({ host }),
  });
const entryRecord = (host: string): LiveItem => {
  order += 1;
  return item({
    kind: "scope.entry.added",
    id: `record:evt_${String(order)}`,
    origin: "record",
    sequence: order,
    headline: host,
    body: `${host} in scope`,
  });
};

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

  test("an empty session has no groups at all", () => {
    expect(
      buildImporterChat({ history: NO_HISTORY, items: [], working: false }),
    ).toEqual([]);
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
  test("says what was written", () => {
    expect(tallyLine({ in: 7, out: 3, assets: 14, messages: 4 })).toBe(
      "7 in · 3 out · 14 assets · 4 messages",
    );
  });

  test("says 'nothing written' rather than three zeros, and keeps the singular honest", () => {
    expect(tallyLine({ in: 0, out: 0, assets: 0, messages: 2 })).toBe(
      "nothing written · 2 messages",
    );
    expect(tallyLine({ in: 1, out: 0, assets: 1, messages: 1 })).toBe(
      "1 in · 0 out · 1 asset · 1 message",
    );
  });
});
