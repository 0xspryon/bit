/**
 * The Agent sessions list's second line, folded from narration (A7 U8b): what a turn is
 * doing, when it ends, and that the store stays bounded.
 */
import { describe, expect, test } from "bun:test";

import type { HarnessNarration } from "../harness/agentHarness";
import { claudeCodeToolName, openCodeToolName } from "@bit/contracts";

import {
  ACTIVITY_FAILURE_MAX,
  ACTIVITY_TEXT_MAX,
  failureLine,
  foldActivity,
  foldActivityState,
  lastLine,
  listedToolName,
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
      subagent: null,
      text: "Checking the header",
      failure: null,
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

describe("a tool's name on the list (A7 U8b review)", () => {
  test("an MCP tool is named without its server's namespacing; a harness's own tool is untouched", () => {
    expect(
      listedToolName(claudeCodeToolName("bit-imp_4f2a", "read_scope")),
    ).toBe("read_scope");
    expect(listedToolName(claudeCodeToolName("playwright", "click"))).toBe(
      "click",
    );
    expect(listedToolName(openCodeToolName("bit-imp_4f2a", "read_scope"))).toBe(
      "read_scope",
    );
    // A dotted name that is not bit's server keeps its dot: no guessing.
    expect(listedToolName("files.read")).toBe("files.read");
    expect(listedToolName("Bash")).toBe("Bash");
    expect(
      fold([call(1, claudeCodeToolName("bit-imp_1", "add_scope_entry"))])
        ?.lastTool,
    ).toBe("add_scope_entry");
  });
});

describe("a sub-agent at work (A7 U8b review)", () => {
  const subagent = (
    at: number,
    callId: string,
    status: "running" | "finished" | "failed" | "stopped",
    agentType: string | undefined,
    description = "Survey the login flow",
  ) =>
    entry(at, {
      _tag: "subagent",
      callId,
      tool: "Agent",
      agentType: agentType ?? null,
      description,
      task: "",
      background: false,
      status,
      startedAt: null,
      endedAt: null,
      calls: null,
      lines: [],
      activity: null,
      result: null,
      failure: null,
      stop: "none",
    });

  // The store's fold, which keeps the running sub-agents by call id.
  const foldState = (entries: readonly HarnessNarration[]) =>
    entries.reduce<ReturnType<typeof foldActivityState> | undefined>(
      (before, each) => foldActivityState(before, each),
      undefined,
    );

  test("is named by its type, else its task, while it runs; the latest of several shows", () => {
    const one = foldState([subagent(1, "a", "running", "Explore")]);
    expect(one?.view).toMatchObject({ running: true, subagent: "Explore" });
    const two = foldState([
      subagent(1, "a", "running", "Explore"),
      subagent(2, "b", "running", undefined, "Read  the\nscope"),
    ]);
    expect(two?.view.subagent).toBe("Read the scope");
    // The second finishing leaves the first named.
    const back = foldActivityState(
      two,
      subagent(3, "b", "finished", undefined),
    );
    expect(back.view.subagent).toBe("Explore");
  });

  test("is cleared when it finishes, and when its turn ends", () => {
    expect(
      foldState([
        subagent(1, "a", "running", "Explore"),
        subagent(2, "a", "finished", "Explore"),
      ])?.view.subagent,
    ).toBeNull();
    expect(
      foldState([
        subagent(1, "a", "running", "Explore"),
        entry(2, { _tag: "opaque" }, "succeeded"),
      ])?.view.subagent,
    ).toBeNull();
  });

  test("the store names it from what it was narrated", () => {
    const store = new SessionActivities();
    const subject = { _tag: "goal", goalId: "g" } as const;
    store.record(subject, subagent(1, "a", "running", "Explore"));
    store.record(subject, subagent(2, "b", "running", "Plan"));
    store.record(subject, subagent(3, "b", "finished", "Plan"));
    expect(store.get(subject)?.subagent).toBe("Explore");
  });
});

describe("a turn that failed (A7 U8b review)", () => {
  const error = (at: number, message: string, outcome?: "failed") =>
    entry(at, { _tag: "error", message }, outcome);

  test("keeps the harness's sentence after the turn ends, even when the error is the turn's only entry", () => {
    // OpenCode's out-of-quota turn: the failure is the turn's first and last entry.
    const idle = fold([
      reply(1, "Done."),
      entry(2, { _tag: "opaque" }, "succeeded"),
      error(3, "Free usage limit reached", "failed"),
    ]);
    expect(idle).toMatchObject({
      running: false,
      failure: "Free usage limit reached",
    });
    // And after a turn that ran.
    expect(
      fold([call(1, "Read"), error(2, "Provider refused the call", "failed")]),
    ).toMatchObject({ running: false, failure: "Provider refused the call" });
  });

  test("is cleared when the next turn starts", () => {
    const failed = fold([error(1, "Free usage limit reached", "failed")]);
    expect(foldActivity(failed, call(2, "Read")).failure).toBeNull();
  });

  test("is one short line: controls and bidi overrides dropped, capped", () => {
    expect(failureLine("\n  Rate\u202e limited\t now \nsecond line")).toBe(
      "Rate limited now",
    );
    expect(failureLine("\u2067\u0007")).toBe("the harness gave no reason");
    const long = failureLine("e".repeat(1_000));
    expect(long.length).toBe(ACTIVITY_FAILURE_MAX);
    expect(long.endsWith("…")).toBe(true);
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
