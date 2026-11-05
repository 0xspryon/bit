/**
 * The Agent sessions union's decisions, against plain data.
 *
 * The route test (`browserApi.test.ts`) runs the whole thing over real rows but cannot make
 * this process *hold* a goal conversation — its goal service is `GoalConversations.unavailable`
 * — so the one state only a held conversation can produce is asserted here: a goal that is
 * live, and what it says about its model.
 */
import { describe, expect, test } from "bun:test";

import {
  activeGroup,
  pageAgentSessions,
  unionAgentSessions,
  type AgentSessionSources,
  type AgentSessionsPageQuery,
} from "./agentSessions";

const GOAL = {
  goalId: "goal_1",
  goalName: "Billing auth",
  harnessSessionId: "ses_goal_1",
  harnessInstanceId: "claude-code",
  model: null,
  openedAt: 100,
};

const sources = (over: Partial<AgentSessionSources>): AgentSessionSources => ({
  goals: [],
  goalLive: () => undefined,
  importers: [],
  workers: { sessions: [], total: 0 },
  ...over,
});

describe("a goal conversation", () => {
  test("held by this process is live, and the registry is where its model comes from", () => {
    const [row] = unionAgentSessions(
      sources({
        goals: [GOAL],
        goalLive: () => ({
          sessionId: "ses_goal_1",
          model: "anthropic/claude-sonnet-5",
        }),
      }),
    ).rows;
    expect(row).toMatchObject({
      kind: "goal",
      state: "live",
      model: "anthropic/claude-sonnet-5",
    });
  });

  test("not held is 'dormant', and is never 'ended'; a row with no model reads null, not a guess", () => {
    const [row] = unionAgentSessions(sources({ goals: [GOAL] })).rows;
    expect(row).toMatchObject({ state: "dormant", model: null });
  });

  test("a dormant goal shows the model its row recorded", () => {
    const [row] = unionAgentSessions(
      sources({ goals: [{ ...GOAL, model: "anthropic/claude-sonnet-5" }] }),
    ).rows;
    expect(row).toMatchObject({
      state: "dormant",
      model: "anthropic/claude-sonnet-5",
    });
  });

  test("a held session that is not the one the index names is not reported live for that row", () => {
    const [row] = unionAgentSessions(
      sources({
        goals: [GOAL],
        goalLive: () => ({ sessionId: "ses_other", model: "x/y" }),
      }),
    ).rows;
    // Not the registry's model — that is another session's — and the row recorded none.
    expect(row).toMatchObject({ state: "dormant", model: null });
  });
});

describe("an importer session", () => {
  const importer = {
    harnessSessionId: "ses_i",
    harnessInstanceId: "opencode",
    model: "openai/gpt-5.6-sol",
    openedAt: 1,
    latestImportId: "imp_1",
    held: false,
    endedAt: null,
    endedReason: null,
    entriesIn: 1,
    entriesOut: 2,
    assets: 3,
  } as const;

  test("a held session is live even beside an earlier ending", () => {
    const [row] = unionAgentSessions(
      sources({
        importers: [
          { ...importer, held: true, endedAt: 5, endedReason: "shutdown" },
        ],
      }),
    ).rows;
    expect(row).toMatchObject({ state: "live", detail: null });
  });

  test("three states: the operator's end is ended; anything else this server does not hold is dormant", () => {
    const rows = unionAgentSessions(
      sources({
        importers: [
          { ...importer, openedAt: 4, endedAt: 5, endedReason: "operator" },
          { ...importer, openedAt: 3, latestImportId: "imp_2" },
          {
            ...importer,
            openedAt: 2,
            latestImportId: "imp_3",
            endedAt: 5,
            endedReason: "shutdown",
          },
          // An ending recorded before `0027` named no reason, and a message reopens it.
          { ...importer, openedAt: 1, latestImportId: "imp_4", endedAt: 5 },
        ],
      }),
    ).rows;
    expect(rows.map((r) => [r.state, r.detail])).toEqual([
      ["ended", "operator"],
      ["dormant", null],
      ["dormant", "shutdown"],
      ["dormant", null],
    ]);
  });
});

describe("a worker session", () => {
  const attempt = (id: string, status: string) => ({
    attemptId: id,
    question: "q?",
    harnessSessionId: `ses_${id}`,
    harnessInstanceId: null,
    model: "a/b",
    status,
    startedAt: 1,
  });

  test("only a running attempt is live; uncertain is ended, with the word beside it", () => {
    const rows = unionAgentSessions(
      sources({
        workers: {
          sessions: [attempt("a", "running"), attempt("b", "uncertain")],
          total: 2,
        },
      }),
    ).rows;
    expect(rows.map((r) => [r.subjectId, r.state, r.detail])).toEqual([
      ["a", "live", "running"],
      ["b", "ended", "uncertain"],
    ]);
  });

  test("reports how many the bound hid", () => {
    expect(
      unionAgentSessions(
        sources({
          workers: { sessions: [attempt("a", "running")], total: 250 },
        }),
      ).workersOmitted,
    ).toBe(249);
  });
});

/* ── A7 U8b: outcomes, activity, groups and pages ─────────────────────────── */

const IMPORTER = {
  harnessSessionId: "ses_i",
  harnessInstanceId: "opencode",
  model: "openai/gpt-5.6-sol",
  openedAt: 1,
  latestImportId: "imp_1",
  held: false,
  endedAt: null,
  endedReason: null,
  entriesIn: 1,
  entriesOut: 0,
  assets: 0,
} as const;

const ATTEMPT = (id: string, status: string, startedAt = 1) => ({
  attemptId: id,
  question: `Question ${id}?`,
  harnessSessionId: `ses_${id}`,
  harnessInstanceId: null,
  model: "a/b",
  status,
  startedAt,
  endedAt: status === "running" ? null : startedAt + 1,
});

describe("how a session that is not running ended (A7 E5)", () => {
  test("an importer: a refused prompt or failed open is failed and resumable; nothing written is empty; your end is stopped", () => {
    const rows = unionAgentSessions(
      sources({
        importers: [
          {
            ...IMPORTER,
            latestImportId: "a",
            endedAt: 5,
            endedReason: "open_failed",
          },
          {
            ...IMPORTER,
            latestImportId: "b",
            entriesIn: 0,
            endedAt: 5,
            endedReason: "operator",
          },
          {
            ...IMPORTER,
            latestImportId: "c",
            endedAt: 5,
            endedReason: "operator",
          },
          {
            ...IMPORTER,
            latestImportId: "d",
            endedAt: 5,
            endedReason: "shutdown",
          },
          { ...IMPORTER, latestImportId: "e", held: true },
        ],
      }),
    ).rows;
    expect(rows.map((r) => [r.subjectId, r.outcome, r.resumable])).toEqual([
      ["a", "failed", true],
      ["b", "empty", false],
      ["c", "stopped", false],
      ["d", "completed", false],
      ["e", null, false],
    ]);
  });

  test("a worker: succeeded, interrupted, failed and uncertain", () => {
    const rows = unionAgentSessions(
      sources({
        workers: {
          sessions: ["succeeded", "interrupted", "failed", "uncertain"].map(
            (status) => ATTEMPT(status, status),
          ),
          total: 4,
        },
      }),
    ).rows;
    expect(rows.map((r) => r.outcome)).toEqual([
      "completed",
      "stopped",
      "failed",
      "failed",
    ]);
  });

  test("a planner: its latest round says; a lineage that never ran a round is empty", () => {
    const round = (status: string) => ({
      roundId: `r_${status}`,
      status,
      harnessInstanceId: "opencode",
      model: "openai/gpt-5.5",
      startedAt: 10,
      endedAt: status === "running" ? null : 20,
      disposition: status === "settled" ? "actionable" : null,
    });
    const rows = unionAgentSessions(
      sources({
        planners: [
          {
            goalId: "g1",
            goalName: "Map auth",
            harnessSessionId: "p1",
            createdAt: 1,
            round: round("running"),
          },
          {
            goalId: "g2",
            goalName: "Map auth",
            harnessSessionId: "p2",
            createdAt: 1,
            round: round("settled"),
          },
          {
            goalId: "g3",
            goalName: "Map auth",
            harnessSessionId: "p3",
            createdAt: 1,
            round: null,
          },
        ],
      }),
    ).rows;
    expect(
      rows.map((r) => [r.kind, r.state, r.outcome, r.detail, r.lastActivityAt]),
    ).toEqual([
      ["planner", "live", null, "running", 10],
      ["planner", "dormant", "completed", "actionable", 20],
      ["planner", "dormant", "empty", null, 1],
    ]);
    expect(rows[0]?.surface).toEqual({
      section: "goals",
      place: "Plan",
      gone: false,
    });
  });
});

describe("what a session is doing (A7 E1)", () => {
  test("is read from the narration summaries, the newest of an importer's import ids", () => {
    const [row] = unionAgentSessions(
      sources({
        importers: [{ ...IMPORTER, held: true, importIds: ["imp_0", "imp_1"] }],
        activity: (subject) =>
          subject._tag === "import"
            ? {
                running: subject.importId === "imp_1",
                calls: 3,
                lastTool: "Bash",
                text: null,
                at: subject.importId === "imp_1" ? 50 : 40,
              }
            : undefined,
      }),
    ).rows;
    expect(row?.activity).toMatchObject({ running: true, at: 50 });
    expect(row?.lastActivityAt).toBe(50);
  });

  test("a live row's group: waiting first, then a turn in flight; an attempt with nothing narrated runs, a held conversation idles", () => {
    const base = unionAgentSessions(
      sources({
        importers: [{ ...IMPORTER, held: true }],
        workers: { sessions: [ATTEMPT("w", "running")], total: 1 },
      }),
    ).rows;
    const [importer, worker] = base;
    if (importer === undefined || worker === undefined) throw new Error("rows");
    expect(activeGroup(importer)).toBe("idle");
    expect(activeGroup(worker)).toBe("running");
    expect(
      activeGroup({
        ...importer,
        activity: {
          running: true,
          calls: 0,
          lastTool: null,
          text: null,
          at: 1,
        },
      }),
    ).toBe("running");
    expect(activeGroup({ ...worker, waiting: "question 1 of 2" })).toBe(
      "needs_you",
    );
  });
});

describe("a page of the list", () => {
  const DAY = 86_400_000;
  const T0 = Date.UTC(2026, 10, 5, 12); // 2026-11-05 12:00 UTC
  const query = (
    over: Partial<AgentSessionsPageQuery> = {},
  ): AgentSessionsPageQuery => ({
    tab: "ended",
    needsYou: false,
    agent: undefined,
    q: "",
    page: 1,
    pageSize: 25,
    timeZone: "UTC",
    ...over,
  });
  // 30 ended attempts: 20 today, 10 yesterday; 3 live: a waiting one, a running one, an idle one.
  const union = (() => {
    const ended = Array.from({ length: 30 }, (_, i) =>
      ATTEMPT(
        `e${String(i).padStart(2, "0")}`,
        "succeeded",
        i < 20 ? T0 - i * 1000 : T0 - DAY - i * 1000,
      ),
    );
    const { rows, workersOmitted } = unionAgentSessions(
      sources({
        importers: [
          { ...IMPORTER, latestImportId: "idle", held: true, openedAt: T0 },
        ],
        workers: {
          sessions: [...ended, ATTEMPT("run", "running", T0)],
          total: 31,
        },
        goals: [{ ...GOAL, openedAt: T0 }],
        goalLive: () => ({ sessionId: "ses_goal_1", model: "x/y" }),
      }),
    );
    // A7-Q will supply this; the plumbing is what is under test.
    const waiting = rows.map((row) =>
      row.kind === "goal" ? { ...row, waiting: "question 1 of 3" } : row,
    );
    return { rows: waiting, workersOmitted };
  })();

  test("tab counts are unfiltered, and the waiting count too", () => {
    const page = pageAgentSessions(
      union,
      query({ agent: "importer", q: "nothing matches this", needsYou: true }),
    );
    expect(page.counts).toEqual({ active: 3, ended: 30, all: 33, needsYou: 1 });
    expect(page.total).toBe(0);
  });

  test("Active is grouped Needs you, Running, Idle, and answered whole", () => {
    const page = pageAgentSessions(
      union,
      query({ tab: "active", pageSize: 25 }),
    );
    expect(page.sessions.map((r) => [r.kind, r.group])).toEqual([
      ["goal", "needs_you"],
      ["worker", "running"],
      ["importer", "idle"],
    ]);
    expect(page.groups).toEqual([
      { key: "needs_you", count: 1 },
      { key: "running", count: 1 },
      { key: "idle", count: 1 },
    ]);
  });

  test("Ended is grouped by day, newest first; a day that runs onto the next page keeps its full count and its label", () => {
    const first = pageAgentSessions(union, query({ pageSize: 25 }));
    expect(first.total).toBe(30);
    expect(first.sessions).toHaveLength(25);
    expect(first.groups).toEqual([
      { key: "day:2026-11-05", count: 20 },
      { key: "day:2026-11-04", count: 10 },
    ]);
    const second = pageAgentSessions(union, query({ page: 2, pageSize: 25 }));
    expect(second.page).toBe(2);
    expect(second.sessions).toHaveLength(5);
    expect(second.groups).toEqual([{ key: "day:2026-11-04", count: 10 }]);
  });

  test("days are the browser's: the same moments fall on other days in another zone", () => {
    // 12:00 UTC is 01:00 the next day in Auckland (UTC+13 in November).
    const page = pageAgentSessions(
      union,
      query({ pageSize: 50, timeZone: "Pacific/Auckland" }),
    );
    expect(page.groups.map((g) => g.key)).toEqual([
      "day:2026-11-06",
      "day:2026-11-05",
    ]);
    // An unknown zone is UTC, not a refusal.
    expect(
      pageAgentSessions(union, query({ timeZone: "Not/AZone" })).groups[0]?.key,
    ).toBe("day:2026-11-05");
  });

  test("a page past the end is the last page; page size 50 and 100 are honoured", () => {
    expect(pageAgentSessions(union, query({ page: 9 })).page).toBe(2);
    expect(
      pageAgentSessions(union, query({ pageSize: 50 })).sessions,
    ).toHaveLength(30);
  });

  test("the Needs you toggle narrows the tab and counts what it hides, by group", () => {
    const page = pageAgentSessions(
      union,
      query({ tab: "active", needsYou: true }),
    );
    expect(page.sessions.map((r) => r.kind)).toEqual(["goal"]);
    expect(page.hidden).toEqual({ running: 1, idle: 1, ended: 0 });
    const all = pageAgentSessions(union, query({ tab: "all", needsYou: true }));
    expect(all.hidden).toEqual({ running: 1, idle: 1, ended: 30 });
    expect(pageAgentSessions(union, query({ tab: "active" })).hidden).toEqual({
      running: 0,
      idle: 0,
      ended: 0,
    });
  });

  test("All is Active's groups first, then Ended's days", () => {
    const page = pageAgentSessions(union, query({ tab: "all", pageSize: 25 }));
    expect(page.groups.map((g) => g.key)).toEqual([
      "needs_you",
      "running",
      "idle",
      "day:2026-11-05",
      "day:2026-11-04",
    ]);
    expect(page.groups.at(-1)?.count).toBe(10);
  });

  test("the agent filter keeps one kind; the text filter matches the name, where it lives and the agent", () => {
    expect(
      pageAgentSessions(
        union,
        query({ tab: "all", agent: "importer" }),
      ).sessions.map((r) => r.kind),
    ).toEqual(["importer"]);
    expect(
      pageAgentSessions(
        union,
        query({ tab: "all", q: "auto-LOAD" }),
      ).sessions.map((r) => r.kind),
    ).toEqual(["importer"]);
    expect(
      pageAgentSessions(
        union,
        query({ tab: "all", q: "question e01" }),
      ).sessions.map((r) => r.subjectId),
    ).toEqual(["e01"]);
    expect(
      pageAgentSessions(
        union,
        query({ tab: "active", q: "conversation" }),
      ).sessions.map((r) => r.kind),
    ).toEqual(["goal"]);
  });
});
