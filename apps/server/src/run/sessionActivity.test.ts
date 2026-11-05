/**
 * The Agent sessions list's second line, folded from narration (A7 U8b): what a turn is
 * doing, when it ends, and that the store stays bounded.
 */
import { describe, expect, test } from "bun:test";

import type { HarnessNarration } from "../harness/agentHarness";
import {
  ACTIVITY_TEXT_MAX,
  foldActivity,
  lastLine,
  SessionActivities,
} from "./sessionActivity";

const entry = (
  at: number,
  detail: HarnessNarration["detail"],
  outcome?: HarnessNarration["outcome"],
): HarnessNarration => ({
  type: "test",
  sequence: undefined,
  at,
  outcome,
  detail,
});

const call = (at: number, tool: string | undefined) =>
  entry(at, { _tag: "toolCall", callId: `c${String(at)}`, tool, input: "{}" });
const reply = (at: number, text: string) => entry(at, { _tag: "reply", text });

const fold = (entries: readonly HarnessNarration[]) =>
  entries.reduce<ReturnType<typeof foldActivity> | undefined>(
    (before, each) => foldActivity(before, each),
    undefined,
  );

describe("one session's activity", () => {
  test("counts the turn's tool calls and names the last tool, while the turn runs", () => {
    expect(
      fold([call(1, "Read"), call(2, "Bash"), reply(3, "Checking the header")]),
    ).toEqual({
      running: true,
      calls: 2,
      lastTool: "Bash",
      text: "Checking the header",
      at: 3,
    });
  });

  test("a partial of a reply is what it is writing now; thinking is not", () => {
    const now = fold([
      reply(1, "Earlier."),
      entry(2, {
        _tag: "partial",
        blockId: "b",
        channel: "thinking",
        text: "secret",
      }),
      entry(3, {
        _tag: "partial",
        blockId: "c",
        channel: "reply",
        text: "First line\n\nTesting X-Forwarded-For rotation",
      }),
    ]);
    expect(now?.text).toBe("Testing X-Forwarded-For rotation");
  });

  test("the entry with an outcome ends the turn, and the next thing the agent does starts a new one", () => {
    const ended = fold([
      call(1, "Read"),
      entry(2, { _tag: "opaque" }, "succeeded"),
    ]);
    expect(ended).toMatchObject({ running: false, calls: 1, lastTool: "Read" });
    // Bookkeeping after the outcome does not reopen it.
    const after = foldActivity(
      ended,
      entry(3, { _tag: "usage" } as unknown as HarnessNarration["detail"]),
    );
    expect(after).toMatchObject({ running: false, calls: 1, at: 3 });
    const next = foldActivity(after, call(4, "Grep"));
    expect(next).toMatchObject({ running: true, calls: 1, lastTool: "Grep" });
  });

  test("a tool the harness has not named yet counts, and keeps the last name", () => {
    expect(fold([call(1, "Read"), call(2, undefined)])).toMatchObject({
      calls: 2,
      lastTool: "Read",
    });
  });

  test("a line is collapsed and shortened to one line on the list", () => {
    expect(lastLine("  a\n\n  b   c  \n")).toBe("b c");
    expect(lastLine("\n \n")).toBeNull();
    expect(lastLine("- **No issues:** read `http://a/` again")).toBe(
      "No issues: read http://a/ again",
    );
    const long = lastLine("x".repeat(500));
    expect(long?.length).toBe(ACTIVITY_TEXT_MAX);
    expect(long?.endsWith("…")).toBe(true);
  });
});

describe("the store", () => {
  test("keeps each subject apart and drops the one narrated longest ago past its bound", () => {
    const store = new SessionActivities(2);
    store.record({ _tag: "import", importId: "a" }, call(1, "Read"));
    store.record({ _tag: "goal", goalId: "a" }, call(2, "Bash"));
    store.record({ _tag: "import", importId: "a" }, call(3, "Grep"));
    store.record({ _tag: "attempt", attemptId: "x" }, call(4, "Edit"));
    expect(store.size).toBe(2);
    // The goal was narrated longest ago; the import, touched again at 3, was kept.
    expect(store.get({ _tag: "goal", goalId: "a" })).toBeUndefined();
    expect(store.get({ _tag: "import", importId: "a" })).toMatchObject({
      calls: 2,
      lastTool: "Grep",
    });
  });
});
