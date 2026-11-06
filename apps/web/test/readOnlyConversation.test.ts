/**
 * The read-only mount (A6 chat generalisation, slice 2): one session's transcript from a
 * replay plus live frames, the shape a worker attempt's "Worker transcript" (A9 H4b) and a
 * planner stage (A9 H3) need — here a worker attempt, routed by `attemptId`.
 */
import { describe, expect, test } from "bun:test";

import type { LiveItem } from "@bit/contracts";

import type { ConversationReplayView } from "../src/lib/conversationChat";
import { readOnlyChat, readOnlyGroups } from "../src/lib/readOnlyConversation";
import { AT, replayItem } from "./fakeServer";

const ATTEMPT = "att_1";

const replay = (items: readonly LiveItem[]): ConversationReplayView => ({
  source: "harness",
  note: "From the harness.",
  truncated: false,
  items,
  queued: [],
  question: null,
  at: AT,
  continuation: "refused",
  refusal: { reason: "attempt_over", detail: "The attempt is over." },
});

/** A live frame, published at `n` in this process's activity order. */
const live = (n: number, body: string, attemptId: string): LiveItem => ({
  ...replayItem(n, "turn.reply", body, { attemptId }),
  id: `activity:${String(n)}`,
  blockId: `blk_${String(n)}`,
});

const shown = (groups: ReturnType<typeof readOnlyGroups>): string =>
  JSON.stringify(groups);

describe("a read-only transcript from a replay and the live feed", () => {
  const replayed = replay([
    replayItem(0, "turn.operator", "Which account wins?", {
      attemptId: ATTEMPT,
    }),
    replayItem(1, "turn.reply", "Reading the handler.", {
      attemptId: ATTEMPT,
      blockId: "blk_2",
    }),
  ]);
  const source = {
    replay: { view: replayed, floor: 3 },
    conversationId: ATTEMPT,
    routeOf: (item: LiveItem) => item.attemptId,
    working: true,
    agent: "worker",
    live: [
      // Published before the replay was asked for: below the floor, so not twice.
      live(1, "Reading the handler.", ATTEMPT),
      // Its last frame published **after** the floor (the settled re-read landed first),
      // but the replay holds its block: the replay's, so not twice either.
      { ...live(4, "Reading the handler.", ATTEMPT), blockId: "blk_2" },
      // After the floor: the live tail.
      live(5, "The token wins over the header.", ATTEMPT),
      // Another attempt's words on the same target.
      live(6, "Somebody else's attempt.", "att_2"),
    ],
  };

  test("joins the live tail after the replay, once, and only this attempt's", () => {
    const text = shown(readOnlyGroups(source));
    expect(text).toContain("Which account wins?");
    expect(text.split("Reading the handler.").length - 1).toBe(1);
    expect(text).toContain("The token wins over the header.");
    expect(text).not.toContain("Somebody else's attempt.");
  });

  test("is loading until the replay answers, and then is the replay", () => {
    const loading = readOnlyGroups({ ...source, replay: undefined, live: [] });
    expect(shown(loading)).not.toContain("Which account wins?");
    const idle = readOnlyGroups({ ...source, working: false, live: [] });
    expect(shown(idle)).toContain("Reading the handler.");
  });

  test("is a closed thread: its sentence in the box, the marker over it, Stop only if offered", () => {
    let stops = 0;
    const words = {
      working: "The worker is working.",
      copyReply: "",
      stopTurn: "",
      stopBackground: "",
      messageLabel: "",
      sendLabel: "",
      sendTitle: "",
      sendQueuedTitle: "",
      countTitle: "",
      elapsedLead: "Running for",
      questionsAsked: () => "",
    };
    const chat = readOnlyChat({
      groups: () => readOnlyGroups(source),
      label: "Worker transcript",
      empty: "",
      closed: "The prompt is the intent's question.",
      marker: () => "Given: the intent and its conditions.",
      turn: () => ({
        working: true,
        background: false,
        stopping: false,
        since: AT,
      }),
      stop: () => {
        stops += 1;
      },
      words,
      footer: () => ({ agent: "Worker", model: "probe/model" }),
    });
    expect(chat.composer).toEqual({
      closed: "The prompt is the intent's question.",
    });
    expect(chat.note).toBe("Given: the intent and its conditions.");
    expect(chat.question).toBeUndefined();
    chat.stop?.();
    expect(stops).toBe(1);
    expect(shown(chat.groups)).toContain("The token wins over the header.");
    const unstoppable = readOnlyChat({
      groups: () => [],
      label: "Stage",
      empty: "",
      closed:
        "The planner can't be prompted. To redirect it, ask the goal agent in Chat.",
      turn: () => ({ working: false, background: false, stopping: false }),
      words,
      footer: () => ({ agent: "Planner", model: "" }),
    });
    expect(unstoppable.stop).toBeUndefined();
    expect(unstoppable.note).toBe("");
  });
});
