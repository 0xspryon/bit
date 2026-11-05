/**
 * The Agent sessions list's words, against plain data (`src/lib/agentSessions.ts`).
 *
 * The rendered list is `test/dom/agentSessions.test.ts`; this owns the decisions that are
 * not layout: what each state is called, and when a harness counts as gone.
 */
import { describe, expect, test } from "bun:test";

import {
  doingLine,
  groupLabel,
  harnessOf,
  hiddenLine,
  lastActivityLabel,
  pagerPages,
  placeOfSession,
  rangeLabel,
  sessionName,
  stateLabel,
  tallySentence,
} from "../src/lib/agentSessions";
import { pathOf } from "../src/lib/place";

const TARGET = "acme-corp";

const LISTED = [
  { instanceId: "opencode", displayName: "OpenCode" },
  { instanceId: "claude-code", displayName: "Claude Code" },
];

describe("a session's state", () => {
  test("a session this server does not hold is 'Not running', never 'Ended'", () => {
    expect(stateLabel({ state: "dormant", detail: null })).toBe("Not running");
  });

  test("an ended session carries the kind's own reason", () => {
    expect(stateLabel({ state: "ended", detail: "failed" })).toBe(
      "Ended · failed",
    );
    expect(stateLabel({ state: "ended", detail: "open_failed" })).toBe(
      "Ended · open failed",
    );
    expect(stateLabel({ state: "ended", detail: null })).toBe("Ended");
  });
});

describe("the harness a session ran on", () => {
  test("resolves an instance to its name", () => {
    expect(harnessOf({ harnessInstanceId: "opencode" }, LISTED, true)).toEqual({
      name: "OpenCode",
      strandedOn: undefined,
    });
  });

  test("an instance this server does not run is stranded, once the listing has said what is here", () => {
    expect(harnessOf({ harnessInstanceId: "gone" }, LISTED, true)).toEqual({
      name: "gone",
      strandedOn: "gone",
    });
  });

  test("before the listing arrives an unknown instance is unknown, not gone", () => {
    expect(
      harnessOf({ harnessInstanceId: "gone" }, [], false).strandedOn,
    ).toBeUndefined();
  });

  test("a row recorded with no instance has nothing to compare and is not flagged", () => {
    expect(harnessOf({ harnessInstanceId: null }, LISTED, true)).toEqual({
      name: "Harness not recorded",
      strandedOn: undefined,
    });
  });
});

describe("the tally and where a row leads", () => {
  test("only a kind that derives a tally has one", () => {
    expect(tallySentence(null)).toBeNull();
    expect(tallySentence({ entriesIn: 2, entriesOut: 1, assets: 1 })).toBe(
      "2 in · 1 out · 1 asset",
    );
    expect(tallySentence({ entriesIn: 0, entriesOut: 0, assets: 3 })).toBe(
      "0 in · 0 out · 3 assets",
    );
  });

  test("a worker leads nowhere, so its row is inert", () => {
    // The grammar has a path for an attempt and following one opens its transcript; there
    // is nowhere to click it from, because Workers lists no attempts. Inbound only.
    expect(
      placeOfSession(
        { kind: "worker", sessionId: "ses_3", subjectId: "att_1" },
        TARGET,
      ),
    ).toBeNull();
  });

  test("an importer row is addressed by its session and a goal row by its subject", () => {
    // Two kinds, two ids, one function that decides which: the href a row carries and the
    // place its click applies are the same answer, so they cannot disagree.
    expect(
      placeOfSession(
        { kind: "importer", sessionId: "ses_1", subjectId: "imp_1" },
        TARGET,
      ),
    ).toEqual({ kind: "chat", targetId: TARGET, sessionId: "ses_1" });
    expect(
      placeOfSession(
        { kind: "goal", sessionId: "ses_2", subjectId: "goal_1" },
        TARGET,
      ),
    ).toEqual({ kind: "goal", targetId: TARGET, goalId: "goal_1" });
  });

  test("and those are the paths an operator can copy out of a row", () => {
    const chat = placeOfSession(
      { kind: "importer", sessionId: "ses_1", subjectId: "imp_1" },
      TARGET,
    );
    const goal = placeOfSession(
      { kind: "goal", sessionId: "ses_2", subjectId: "goal_1" },
      TARGET,
    );
    expect(chat === null ? "" : pathOf(chat)).toBe(
      "/t/acme-corp/assets/chat/ses_1",
    );
    expect(goal === null ? "" : pathOf(goal)).toBe("/t/acme-corp/goals/goal_1");
  });
});

/* ── A7 U8b ───────────────────────────────────────────────────────────────── */

const row = (
  over: Partial<Parameters<typeof doingLine>[0]> = {},
): Parameters<typeof doingLine>[0] => ({
  kind: "importer",
  state: "live",
  detail: null,
  tally: { entriesIn: 3, entriesOut: 0, assets: 5 },
  activity: null,
  waiting: null,
  outcome: null,
  resumable: false,
  ...over,
});

const DOING = {
  running: true,
  calls: 14,
  lastTool: "Bash",
  subagent: null,
  text: null,
  failure: null,
  at: 1,
};

describe("a row's second line", () => {
  test("waiting is in warning and says what on, the agent's words marked as theirs", () => {
    const line = doingLine(row({ waiting: "approve a 5-step plan" }));
    expect(line.text).toBe("Waiting on you · approve a 5-step plan");
    expect(line.tone).toBe("warning");
    expect(line.parts).toEqual([
      { text: "Waiting on you", agent: false, before: "" },
      { text: "approve a 5-step plan", agent: true, before: " · " },
    ]);
  });

  test("a running turn: what it is writing, or its last tool, and the calls so far", () => {
    const running = doingLine(row({ activity: DOING }));
    expect(running.text).toBe("Running Bash · 14 tool calls so far");
    // The tool's name is the harness's: isolated, running on from "Running".
    expect(running.parts.map((part) => [part.before, part.agent])).toEqual([
      ["", false],
      [" ", true],
      [" · ", false],
    ]);
    expect(
      doingLine(row({ activity: { ...DOING, text: "Replaying the login" } }))
        .text,
    ).toBe("Replaying the login · 14 tool calls so far");
    expect(
      doingLine(
        row({
          activity: { ...DOING, calls: 1, running: false, text: "Done." },
        }),
      ).text,
    ).toBe("Last reply: Done. · 1 tool call in its last turn");
  });

  test("a sub-agent at work is named, not 'Working · 0 calls' (A7 U8b review)", () => {
    expect(
      doingLine(
        row({
          activity: { ...DOING, calls: 0, lastTool: null, subagent: "Explore" },
        }),
      ).text,
    ).toBe("Sub-agent · Explore");
    // Even after the caller wrote something: the sub-agent is what the turn is doing.
    expect(
      doingLine(
        row({
          activity: {
            ...DOING,
            calls: 2,
            text: "Let me survey it",
            subagent: "Explore",
          },
        }),
      ).text,
    ).toBe("Sub-agent · Explore · 2 tool calls so far");
  });

  test("a live session whose last turn failed says so, in the harness's words, until the next turn (A7 U8b review)", () => {
    const line = doingLine(
      row({
        activity: {
          ...DOING,
          running: false,
          calls: 0,
          lastTool: null,
          failure: "Free usage limit reached",
        },
      }),
    );
    expect(line.text).toBe("Last turn failed · Free usage limit reached");
    expect(line.tone).toBe("danger");
    expect(line.parts.at(-1)?.agent).toBe(true);
    // A running turn is the next turn: what it does, not the old failure.
    expect(
      doingLine(row({ activity: { ...DOING, failure: "old" } })).text,
    ).toBe("Running Bash · 14 tool calls so far");
  });

  test("how a finished one ended: failure alone in colour, and a message carries it on only where it would", () => {
    expect(
      doingLine(
        row({
          state: "dormant",
          outcome: "failed",
          detail: "open_failed",
          resumable: true,
        }),
      ),
    ).toMatchObject({
      text: "Failed · the session did not open · a message carries it on",
      tone: "danger",
    });
    expect(
      doingLine(
        row({
          state: "dormant",
          outcome: "failed",
          detail: "refused",
          resumable: false,
        }),
      ).text,
    ).toBe("Failed · the harness would not take the prompt");
    expect(doingLine(row({ state: "ended", outcome: "stopped" })).text).toBe(
      "Ended by you · 3 in · 0 out · 5 assets",
    );
    expect(doingLine(row({ state: "ended", outcome: "empty" })).text).toBe(
      "Ended by you · wrote nothing",
    );
    expect(
      doingLine(row({ kind: "worker", state: "ended", outcome: "stopped" }))
        .tone,
    ).toBe("muted");
  });

  test("A7 U8b review: every outcome line is true of its row", () => {
    const say = (over: Partial<Parameters<typeof doingLine>[0]>) =>
      doingLine(row(over));
    // A met goal completed; a message to it is refused, so nothing says one carries it on.
    expect(
      say({
        kind: "goal",
        tally: null,
        state: "dormant",
        outcome: "completed",
      }),
    ).toMatchObject({ text: "Completed · goal met", tone: "muted" });
    expect(
      say({ kind: "goal", tally: null, state: "dormant", outcome: "stopped" })
        .text,
    ).toBe("Stopped · the goal was abandoned");
    // An active goal's conversation this server does not hold — a restart, a turn cut short.
    expect(
      say({
        kind: "goal",
        tally: null,
        state: "dormant",
        outcome: null,
        resumable: true,
      }).text,
    ).toBe("Not running · a message carries it on");
    // An uncertain worker or round: not known, neutral, never "Failed".
    for (const kind of ["worker", "planner"] as const) {
      expect(
        say({
          kind,
          tally: null,
          state: kind === "worker" ? "ended" : "dormant",
          outcome: "unknown",
          detail: "uncertain",
        }),
      ).toMatchObject({ text: "Outcome not known", tone: "muted" });
    }
    // An importer let go with nothing written, by a shutdown or with no reason recorded.
    for (const detail of ["shutdown", null]) {
      expect(
        say({
          state: "dormant",
          outcome: null,
          detail,
          tally: { entriesIn: 0, entriesOut: 0, assets: 0 },
          resumable: true,
        }).text,
      ).toBe("Not running · wrote nothing · a message carries it on");
    }
    // One that wrote, let go the same way, says what it wrote.
    expect(say({ state: "dormant", outcome: null, resumable: true }).text).toBe(
      "Not running · 3 in · 0 out · 5 assets · a message carries it on",
    );
    // One the send would refuse (agent unavailable, harness not configured) offers nothing.
    expect(
      say({
        state: "dormant",
        outcome: null,
        tally: { entriesIn: 0, entriesOut: 0, assets: 0 },
        resumable: false,
      }).text,
    ).toBe("Not running · wrote nothing");
    // "resumable" is never the word: it was unchecked.
    expect(
      say({ state: "dormant", outcome: "failed", resumable: true }).text,
    ).not.toContain("resumable");
    // A planner that settled says its disposition; a worker's success is plain.
    expect(
      say({
        kind: "planner",
        tally: null,
        state: "dormant",
        outcome: "completed",
        detail: "proposed_intents",
      }).text,
    ).toBe("Completed · proposed intents");
    expect(
      say({ kind: "worker", tally: null, state: "ended", outcome: "completed" })
        .text,
    ).toBe("Completed");
  });
});

describe("labels and the pager", () => {
  const NOW = new Date(2026, 10, 5, 15, 0).getTime();

  test("groups: Active's three, then Today, Yesterday and dates", () => {
    expect(groupLabel("needs_you", NOW)).toBe("Needs you");
    expect(groupLabel("day:2026-11-05", NOW)).toBe("Today");
    expect(groupLabel("day:2026-11-04", NOW)).toBe("Yesterday");
    expect(groupLabel("day:2026-10-24", NOW)).not.toMatch(/Today|Yesterday/);
  });

  test("last activity: relative while live, a clock time today, a date before", () => {
    expect(lastActivityLabel(NOW - 20_000, NOW, true)).toBe("now");
    expect(lastActivityLabel(NOW - 12 * 60_000, NOW, true)).toBe("12 min");
    expect(lastActivityLabel(NOW - 2 * 3_600_000, NOW, true)).toBe("2 h");
    expect(lastActivityLabel(NOW - 20 * 60_000, NOW, false)).toMatch(/14:40/);
  });

  test("what the toggle hides, and the range", () => {
    expect(hiddenLine({ running: 2, idle: 1, ended: 0 }, "active")).toBe(
      "3 more active sessions are hidden by this filter — 2 running, 1 idle.",
    );
    expect(hiddenLine({ running: 0, idle: 1, ended: 0 }, "active")).toBe(
      "1 more active session is hidden by this filter — 1 idle.",
    );
    expect(hiddenLine({ running: 0, idle: 0, ended: 0 }, "all")).toBeNull();
    expect(rangeLabel({ page: 2, pageSize: 25, total: 123 }, 25, false)).toBe(
      "26–50 of 123",
    );
    expect(rangeLabel({ page: 1, pageSize: 25, total: 2 }, 2, true)).toBe(
      "1–2 of 2 waiting",
    );
  });

  test("pages: all up to seven, else the ends and the neighbours with gaps", () => {
    expect(pagerPages(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pagerPages(1, 12)).toEqual([1, 2, null, 12]);
    expect(pagerPages(6, 12)).toEqual([1, 2, null, 5, 6, 7, null, 12]);
  });

  test("an importer session is named by its title, else when it started; the planner opens its goal", () => {
    expect(
      sessionName({
        kind: "importer",
        subject: "Scope import",
        title: " Sweep ",
        startedAt: 0,
      }),
    ).toBe("Sweep");
    expect(
      sessionName({
        kind: "importer",
        subject: "Scope import",
        title: null,
        startedAt: 0,
      }),
    ).toMatch(/^Session /);
    expect(
      placeOfSession(
        { kind: "planner", sessionId: "s", subjectId: "g" },
        TARGET,
      ),
    ).toEqual({ kind: "goal", targetId: TARGET, goalId: "g" });
  });
});
