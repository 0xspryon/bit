/**
 * The Agent sessions union's decisions, against plain data.
 *
 * The route test (`browserApi.test.ts`) runs the whole thing over real rows but cannot make
 * this process *hold* a goal conversation — its goal service is `GoalConversations.unavailable`
 * — so the one state only a held conversation can produce is asserted here: a goal that is
 * live, and what it says about its model.
 */
import { describe, expect, test } from "bun:test";

import { unionAgentSessions, type AgentSessionSources } from "./agentSessions";

const GOAL = {
  goalId: "goal_1",
  goalName: "Billing auth",
  harnessSessionId: "ses_goal_1",
  harnessInstanceId: "claude-code",
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
    ).sessions;
    expect(row).toMatchObject({
      kind: "goal",
      state: "live",
      model: "anthropic/claude-sonnet-5",
    });
  });

  test("not held is 'dormant' with no model, and is never 'ended'", () => {
    const [row] = unionAgentSessions(sources({ goals: [GOAL] })).sessions;
    expect(row).toMatchObject({ state: "dormant", model: null });
  });

  test("a held session that is not the one the index names is not reported live for that row", () => {
    const [row] = unionAgentSessions(
      sources({
        goals: [GOAL],
        goalLive: () => ({ sessionId: "ses_other", model: "x/y" }),
      }),
    ).sessions;
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
    running: false,
    endedAt: null,
    endedReason: null,
    entriesIn: 1,
    entriesOut: 2,
    assets: 3,
  } as const;

  test("a run in flight is live even beside an earlier ending", () => {
    const [row] = unionAgentSessions(
      sources({
        importers: [
          { ...importer, running: true, endedAt: 5, endedReason: "shutdown" },
        ],
      }),
    ).sessions;
    expect(row).toMatchObject({ state: "live", detail: null });
  });

  test("an ending carries its reason; no ending and no run is dormant, not live", () => {
    const rows = unionAgentSessions(
      sources({
        importers: [
          { ...importer, openedAt: 2, endedAt: 5, endedReason: "operator" },
          { ...importer, latestImportId: "imp_2" },
        ],
      }),
    ).sessions;
    expect(rows.map((r) => [r.state, r.detail])).toEqual([
      ["ended", "operator"],
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
    ).sessions;
    expect(rows.map((r) => [r.subjectId, r.state, r.detail])).toEqual([
      ["b", "ended", "uncertain"],
      ["a", "live", "running"],
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
