/**
 * The chat shell's rules, without a browser (A6 prep): when the arrow sends, when Stop is
 * drawn, and what a finished turn's footer says. The importer's DOM suites cover the same
 * rules through `ImporterChat`; these say them once for any adapter.
 */
import { describe, expect, test } from "bun:test";

import type { LiveItem } from "@bit/contracts";

import { rowsFor, type ChatGroup } from "../src/lib/chat";
import {
  composerCanSend,
  replyText,
  stopOffered,
  turnFooterText,
  type ChatSession,
  type OpenChatComposer,
  type ThreadTurn,
} from "../src/lib/chatShell";

const source = (over: Partial<OpenChatComposer> = {}): OpenChatComposer => ({
  draft: "",
  sending: false,
  blocked: false,
  placeholder: "",
  send: () => undefined,
  notices: [],
  ...over,
});

describe("composerCanSend", () => {
  test("words send; nothing, a closed box, a blocked one or one sending does not", () => {
    expect(composerCanSend(source({ draft: "In scope: *.acme.com" }))).toBe(
      true,
    );
    expect(composerCanSend(source({ draft: "   " }))).toBe(false);
    // A closed box is its reason alone (`ClosedChatComposer`), with nothing to send.
    expect(composerCanSend({ closed: "A planner takes none." })).toBe(false);
    expect(composerCanSend(source({ draft: "hi", blocked: true }))).toBe(false);
    expect(composerCanSend(source({ draft: "hi", sending: true }))).toBe(false);
  });
});

const turn = (over: Partial<ThreadTurn> = {}): ThreadTurn => ({
  message: "Load it",
  number: 1,
  at: null,
  working: false,
  queued: false,
  sentNow: false,
  startedAt: 1_000,
  midBlock: false,
  ...over,
});

const item = (over: Partial<LiveItem>): LiveItem => ({
  _tag: "item",
  id: "i1",
  origin: "activity",
  sequence: null,
  at: 42_000,
  attemptId: null,
  roundId: null,
  goalId: null,
  importId: null,
  kind: "turn.reply",
  headline: "Reply",
  body: "Done.",
  tool: null,
  toolName: null,
  input: null,
  output: null,
  callId: null,
  outcome: null,
  ...over,
});

const group = (
  subject: ThreadTurn,
  items: readonly LiveItem[],
): ChatGroup<ThreadTurn> => ({
  key: "turn:1",
  subject,
  prose: { _tag: "live" },
  rows: rowsFor(items, true),
});

describe("turnFooterText", () => {
  test("the agent, the turn's own model and how long it took", () => {
    const done = group(turn(), [item({ model: "claude-haiku-4-5" })]);
    expect(turnFooterText(done, { agent: "Planner", model: "other" })).toBe(
      "Planner · claude-haiku-4-5 · 41s",
    );
  });

  test("the session's model where the turn names none, and no duration without a start", () => {
    const done = group(turn({ startedAt: null }), [item({})]);
    expect(turnFooterText(done, { agent: "Worker", model: "glm-5.3" })).toBe(
      "Worker · glm-5.3",
    );
    expect(replyText(done)).toBe("Done.");
  });
});

describe("stopOffered", () => {
  const session = (
    over: Partial<ChatSession> & { readonly running?: boolean },
  ): ChatSession => ({
    label: "",
    empty: "",
    groups: [],
    note: "",
    connection: "",
    turn: {
      working: over.running ?? false,
      background: false,
      stopping: false,
    },
    words: {
      working: "",
      copyReply: "",
      stopTurn: "",
      stopBackground: "",
      messageLabel: "",
      sendLabel: "",
      sendTitle: "",
      sendQueuedTitle: "",
      countTitle: "",
      questionsAsked: () => "",
    },
    footer: { agent: "", model: "" },
    sentNowTitle: "",
    ...over,
  });

  test("only while something runs, and only for a chat that can stop", () => {
    const stop = (): void => undefined;
    expect(stopOffered(session({ stop, running: true }))).toBe(true);
    expect(stopOffered(session({ stop, running: false }))).toBe(false);
    expect(stopOffered(session({ running: true }))).toBe(false);
    expect(
      stopOffered(
        session({
          stop,
          turn: { working: false, background: true, stopping: false },
        }),
      ),
    ).toBe(true);
  });
});
