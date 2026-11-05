/**
 * The Agent sessions list: one row per long-running agent session on the open target.
 *
 * `agentSessions.test.ts` (the pure one) owns the sentences; what it cannot see is that the
 * tab is in the rail under Operations, that a row says what the server said and nothing it
 * did not, that a target with none says so instead of drawing an empty frame, that a session
 * on a harness this server no longer runs is *marked rather than dropped*, and that a row
 * leads to the surface's own screen where one exists and nowhere where it does not. Each is
 * driven through `Target` the way a person reaches it: open the target, choose the tab.
 *
 * Since S3 a row is an `<a href>` rather than a button, which adds two claims only a
 * rendered row can carry: the href is the path of the place the row leads to — the link an
 * operator copies — and an ordinary click routes in the app while every modified click is
 * left to the browser with the href intact. `placeLink.test.ts` holds the rule those last
 * two follow from; this is the rule applied to a real row.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { type AgentSessionView, type AgentSessionsView } from "@bit/contracts";
import { compile } from "svelte/compiler";

import { AGENT_SESSIONS_REFRESH_MS, App } from "../../src/lib/app.svelte";
import type { AgentSessionsRequest } from "../../src/lib/client";
import Sidebar from "../../src/lib/components/Sidebar.svelte";
import TitleBar from "../../src/lib/components/TitleBar.svelte";
import Target from "../../src/lib/screens/Target.svelte";
import { FakeCountdown } from "../fakeCountdown";
import {
  FakeServer,
  agentSessionView,
  agentSessionsPage,
  importerSessionView,
  liveActivity,
  ok,
  unreachable,
} from "../fakeServer";
import { click, clickOn, mountInto, settle, type Mounted } from "./dom";

let mounted: Mounted[] = [];
afterEach(() => {
  for (const each of mounted) each.destroy();
  mounted = [];
});

const text = (): string =>
  (document.body.textContent ?? "").replace(/\s+/g, " ");

const harness = (instanceId: string, displayName: string) => ({
  instanceId,
  driver: "opencode" as const,
  displayName,
  version: "1.0.0",
  ready: true,
  auth: "authenticated" as const,
  isDefault: false,
  defaultModel: "m",
  models: [{ id: "m" }],
});

const GOAL = agentSessionView({
  startedAt: 1_700_000_300_000,
  harnessInstanceId: "claude-code",
});
const IMPORTER = agentSessionView({
  kind: "importer",
  key: "importer:imp_1",
  sessionId: "ses_import_1",
  subject: "Scope import",
  subjectId: "imp_1",
  harnessInstanceId: "opencode",
  model: "openai/gpt-5.6-sol",
  startedAt: 1_700_000_200_000,
  state: "live",
  tally: { entriesIn: 7, entriesOut: 3, assets: 1 },
  title: "Full policy sweep",
  lastActivityAt: Date.now(),
  surface: { section: "assets", place: "Auto-load", gone: false },
  activity: {
    running: true,
    calls: 14,
    lastTool: "Bash",
    subagent: null,
    text: "Testing X-Forwarded-For rotation",
    failure: null,
    at: Date.now(),
  },
  group: "running",
});
const WORKER = agentSessionView({
  kind: "worker",
  key: "worker:att_1",
  sessionId: "ses_worker_1",
  subject: "Does /invoices accept another tenant id?",
  subjectId: "att_1",
  harnessInstanceId: "opencode",
  model: "anthropic/sonnet-5",
  startedAt: 1_700_000_100_000,
  state: "ended",
  detail: "failed",
  surface: { section: "workers", place: "Attempt", gone: false },
  outcome: "failed",
});

const openList = async (
  sessions: AgentSessionView[],
  over: Partial<AgentSessionsView> = {},
): Promise<{ app: App; fake: FakeServer }> => {
  const fake = new FakeServer();
  fake.onAgentSessions = () => ok(agentSessionsPage(sessions, over));
  fake.onHarnesses = () =>
    ok([
      harness("claude-code", "Claude Code"),
      harness("opencode", "OpenCode"),
    ]);
  const app = new App(fake, new FakeCountdown());
  app.password = "correct-horse";
  await app.connect();
  app.openTarget("acme-corp");
  await settle();
  app.toSection("agent-sessions");
  await settle();
  mounted.push(mountInto(Target, { app }));
  await settle();
  return { app, fake };
};

/** The rows on screen, as text, without the group labels. */
const rowTexts = (): string[] =>
  [...document.querySelectorAll(".rows .row-item")].map((each) =>
    (each.textContent ?? "").replace(/\s+/g, " ").trim(),
  );

/** The query of every page read of the list (the rail's count reads are not the page's). */
const pageReads = (fake: FakeServer) =>
  fake.calls
    .filter((call) => call.method === "agentSessions")
    .map((call) => call.args[2] as AgentSessionsRequest)
    .filter((query) => query.titles !== undefined);

const buttonNamed = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find((each) =>
    (each.textContent ?? "").replace(/\s+/g, " ").includes(name),
  );
  if (found === undefined) throw new Error(`no button "${name}"`);
  return found;
};

const choose = (select: HTMLSelectElement, value: string) => {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
};

describe("the Agent sessions tab", () => {
  test("is in the rail under Operations, between Workers and Blockers (A7 E6)", async () => {
    const fake = new FakeServer();
    const app = new App(fake, new FakeCountdown());
    app.password = "correct-horse";
    await app.connect();
    app.openTarget("acme-corp");
    await settle();
    mounted.push(mountInto(Sidebar, { app }));
    await settle();

    const labels = [...document.querySelectorAll(".item")].map((each) =>
      each.textContent?.replace(/\s+/g, " ").trim(),
    );
    const tab = labels.findIndex((each) => each?.startsWith("Agent sessions"));
    expect(tab).toBeGreaterThan(-1);
    expect(labels[tab - 1]?.startsWith("Workers")).toBe(true);
    expect(labels[tab + 1]?.startsWith("Blockers")).toBe(true);
    // It has a glyph: the rail draws one svg per item.
    expect(
      document.querySelectorAll(".item")[tab]?.querySelector("svg"),
    ).not.toBeNull();
  });

  const railWith = async (counts: { active: number; needsYou: number }) => {
    const fake = new FakeServer();
    fake.onAgentSessions = () =>
      ok(
        agentSessionsPage([], {
          counts: {
            active: counts.active,
            ended: 4,
            all: counts.active + 4,
            needsYou: counts.needsYou,
          },
        }),
      );
    const app = new App(fake, new FakeCountdown());
    app.password = "correct-horse";
    await app.connect();
    app.openTarget("acme-corp");
    await settle();
    mounted.push(mountInto(Sidebar, { app }), mountInto(TitleBar, { app }));
    await settle();
    const item = document.querySelector('.item[data-item="agent-sessions"]');
    return { app, item };
  };

  test("with nothing active it has no count: ended sessions are history", async () => {
    const { item } = await railWith({ active: 0, needsYou: 0 });
    expect(item?.querySelector(".count")).toBeNull();
  });

  test("with sessions active and nobody waiting, a quiet count of them", async () => {
    const { item } = await railWith({ active: 3, needsYou: 0 });
    const count = item?.querySelector(".count");
    expect(count?.textContent?.trim()).toBe("3");
    expect(count?.classList.contains("waiting")).toBe(false);
    expect(item?.querySelector(".dot")).toBeNull();
  });

  test("with sessions waiting, the number waiting, with a dot, in warning; the hidden rail keeps the dot", async () => {
    const { app, item } = await railWith({ active: 3, needsYou: 2 });
    const count = item?.querySelector(".count");
    expect(count?.textContent?.trim()).toBe("2");
    expect(count?.classList.contains("waiting")).toBe(true);
    expect(item?.querySelector(".dot")).not.toBeNull();
    expect(item?.getAttribute("aria-label")).toBe(
      "Agent sessions, 2 waiting on you",
    );
    expect(document.querySelector(".drawer .waiting-dot")).toBeNull();
    app.drawerHidden = true;
    await settle();
    const drawer = document.querySelector(".drawer");
    expect(drawer?.querySelector(".waiting-dot")).not.toBeNull();
    expect(drawer?.getAttribute("aria-label")).toBe(
      "Show panel — 2 agent sessions are waiting on you",
    );
  });
});

describe("the Agent sessions list", () => {
  test("each row reads name · where it lives, what it is doing, the agent, the model and when (A7 E1)", async () => {
    const { fake } = await openList([IMPORTER, GOAL, WORKER]);

    expect(pageReads(fake)).toHaveLength(1);
    expect(pageReads(fake)[0]).toMatchObject({
      tab: "active",
      page: 1,
      pageSize: 25,
      titles: true,
    });
    const rows = rowTexts();
    expect(rows).toHaveLength(3);
    // The importer: its harness title, its surface, what it is doing now, live.
    expect(rows[0]).toContain("Full policy sweep");
    expect(rows[0]).toContain("Assets");
    expect(rows[0]).toContain("Auto-load");
    expect(rows[0]).toContain(
      "Testing X-Forwarded-For rotation · 14 tool calls so far",
    );
    expect(rows[0]).toContain("openai/gpt-5.6-sol");
    expect(rows[0]).toContain("now");
    // The goal: dormant, its conversation on the goal page, no model it can know.
    expect(rows[1]).toContain("Find auth bypasses");
    expect(rows[1]).toContain("Goals");
    expect(rows[1]).toContain("Conversation");
    expect(rows[1]).toContain("Goal agent");
    // A dormant goal recorded as completed is a met goal: no message carries it on.
    expect(rows[1]).toContain("Completed · goal met");
    expect(rows[1]).not.toContain("carries it on");
    expect(rows[1]).toContain("—");
    // The worker: failed, the one outcome in colour.
    expect(rows[2]).toContain("Failed");
    expect(rows[2]).not.toContain("Failed · failed");
    const line = document.querySelectorAll(".rows .row-item .line2")[2];
    expect(line?.classList.contains("danger")).toBe(true);
    expect(
      document
        .querySelectorAll(".rows .row-item .mark")[2]
        ?.getAttribute("data-mark"),
    ).toBe("failed");
  });

  test("Active is grouped Needs you, Running, Idle, each label with its count", async () => {
    const waiting = agentSessionView({
      kind: "importer",
      key: "importer:imp_w",
      sessionId: "ses_w",
      state: "live",
      surface: { section: "assets", place: "Auto-load", gone: false },
      waiting: "question 2 of 3 — how far the WordPress rule reaches",
      group: "needs_you",
    });
    const idle = agentSessionView({
      key: "goal:goal_2",
      subjectId: "goal_2",
      state: "live",
      group: "idle",
    });
    await openList([waiting, IMPORTER, idle]);
    const groups = [...document.querySelectorAll(".rows .group")].map((each) =>
      (each.textContent ?? "").replace(/\s+/g, " ").trim(),
    );
    expect(groups).toEqual(["Needs you 1", "Running 1", "Idle 1"]);
    // A waiting row says what it waits on, in warning.
    const line = document.querySelector(".rows .row-item .line2");
    expect(line?.textContent).toBe(
      "Waiting on you · question 2 of 3 — how far the WordPress rule reaches",
    );
    expect(line?.classList.contains("warning")).toBe(true);
  });

  test("an Ended day keeps its full count on every page, and a day that runs on is named again (A7 E5)", async () => {
    const today = new Date();
    const key = `day:${String(today.getFullYear())}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const ended = [
      WORKER,
      { ...WORKER, key: "worker:att_2", subjectId: "att_2" },
    ].map((row) => ({ ...row, group: key }));
    await openList(ended, {
      groups: [{ key, count: 30 }],
      counts: { active: 0, ended: 31, all: 31, needsYou: 0 },
      total: 31,
      page: 2,
      pageSize: 25,
    });
    const group = document.querySelector(".rows .group");
    expect((group?.textContent ?? "").replace(/\s+/g, " ").trim()).toBe(
      "Today 30",
    );
  });

  test("an outcome's mark never wears a class the page styles for itself (an empty session is not the empty page)", async () => {
    await openList([agentSessionView({ outcome: "empty" })]);
    const mark = document.querySelector(".rows .row-item .mark");
    expect(mark?.getAttribute("data-mark")).toBe("empty");
    expect(mark?.classList.contains("is-empty")).toBe(true);
    // `.empty` is the no-sessions block, 48 px of margin: on a mark it made the row 135 px tall.
    expect(mark?.classList.contains("empty")).toBe(false);
  });

  test("a surface that is gone is struck through, and its row still opens", async () => {
    await openList([
      agentSessionView({
        surface: { section: "goals", place: "Conversation", gone: true },
      }),
    ]);
    expect(document.querySelector(".crumb.gone")).not.toBeNull();
    expect(document.querySelector("a.row.go")?.getAttribute("href")).toBe(
      "/t/acme-corp/goals/goal_1",
    );
  });

  test("a target with no sessions says so instead of drawing an empty frame", async () => {
    await openList([]);
    expect(text()).toContain("No agent sessions on this target yet.");
    expect(document.querySelector(".rows")).toBeNull();
  });

  test("says it is reading before the first answer, not that there are none", async () => {
    const fake = new FakeServer();
    const release = fake.hold("agentSessions");
    const app = new App(fake, new FakeCountdown());
    app.password = "correct-horse";
    await app.connect();
    app.openTarget("acme-corp");
    await settle();
    app.toSection("agent-sessions");
    mounted.push(mountInto(Target, { app }));
    await settle();
    expect(text()).toContain("Reading this target's agent sessions…");
    expect(text()).not.toContain("No agent sessions");
    release();
  });

  test("a failed read says so and offers another go, rather than claiming there are none", async () => {
    const fake = new FakeServer();
    fake.onAgentSessions = () => unreachable("no route");
    const app = new App(fake, new FakeCountdown());
    app.password = "correct-horse";
    await app.connect();
    app.openTarget("acme-corp");
    await settle();
    app.toSection("agent-sessions");
    mounted.push(mountInto(Target, { app }));
    await settle();
    expect(text()).toContain("No server answered at this address.");
    expect(text()).not.toContain("No agent sessions on this target yet.");
    expect(
      [...document.querySelectorAll("button")].some((b) =>
        b.textContent?.includes("Try again"),
      ),
    ).toBe(true);
  });

  test("a session whose harness is no longer configured is marked, not hidden", async () => {
    await openList([
      agentSessionView({ harnessInstanceId: "retired-harness" }),
      IMPORTER,
    ]);
    const rows = rowTexts();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain(
      "Harness “retired-harness” is no longer configured",
    );
    // And a session on a harness this server does run is not.
    expect(rows[1]).not.toContain("no longer configured");
  });

  test("does not call a harness gone before the harness listing has arrived", async () => {
    const fake = new FakeServer();
    fake.onAgentSessions = () =>
      ok(agentSessionsPage([agentSessionView({ harnessInstanceId: "x" })]));
    // The listing never arrives: `harnessesLoaded` stays false.
    fake.onHarnesses = () => unreachable("no route");
    const app = new App(fake, new FakeCountdown());
    app.password = "correct-horse";
    await app.connect();
    app.openTarget("acme-corp");
    await settle();
    app.toSection("agent-sessions");
    mounted.push(mountInto(Target, { app }));
    await settle();
    expect(rowTexts()).toHaveLength(1);
    expect(text()).not.toContain("no longer configured");
  });

  test("says how many worker sessions the bound left out", async () => {
    await openList([WORKER], { workersOmitted: 42 });
    expect(text()).toContain("42 older worker sessions are not counted here");
  });
});

describe("tabs and filters (A7 E1, E2)", () => {
  test("the tabs carry the server's unfiltered counts, and choosing one asks for it from page 1", async () => {
    const { app, fake } = await openList([IMPORTER], {
      counts: { active: 5, ended: 123, all: 128, needsYou: 2 },
    });
    const tabs = [...document.querySelectorAll('[role="tab"]')].map((each) =>
      (each.textContent ?? "").replace(/\s+/g, " ").trim(),
    );
    expect(tabs).toEqual(["Active 5", "Ended 123", "All 128"]);
    click(buttonNamed("Ended"));
    await settle();
    expect(app.agentSessionsQuery.tab).toBe("ended");
    expect(pageReads(fake).at(-1)).toMatchObject({ tab: "ended", page: 1 });
  });

  test("the Needs you toggle narrows the tab, and the line under the list says what it hides, with a way back", async () => {
    const { app, fake } = await openList([], {
      counts: { active: 3, ended: 0, all: 3, needsYou: 0 },
      hidden: { running: 2, idle: 1, ended: 0 },
    });
    click(buttonNamed("Needs you"));
    await settle();
    expect(pageReads(fake).at(-1)).toMatchObject({ needsYou: true });
    expect(app.agentSessionsQuery.needsYou).toBe(true);
    expect(text()).toContain(
      "3 more active sessions are hidden by this filter — 2 running, 1 idle.",
    );
    expect(text()).toContain("Nothing in active sessions is waiting on you.");
    click(buttonNamed("Clear the filter"));
    await settle();
    expect(pageReads(fake).at(-1)).toMatchObject({ needsYou: false });
  });

  test("on Ended the toggle is dimmed: an ended session cannot be waiting", async () => {
    const { app } = await openList([WORKER]);
    app.setAgentSessionsQuery({ tab: "ended" });
    await settle();
    expect(buttonNamed("Needs you").disabled).toBe(true);
  });

  test("the agent filter asks for one kind; the text filter asks once typing pauses", async () => {
    const { app, fake } = await openList([IMPORTER]);
    const agent = document.querySelector(
      ".agent-filter select",
    ) as HTMLSelectElement;
    expect([...agent.options].map((option) => option.textContent)).toEqual([
      "Every agent",
      "Goal agent",
      "Auto-load",
      "Worker",
      "Planner",
    ]);
    choose(agent, "planner");
    await settle();
    expect(pageReads(fake).at(-1)).toMatchObject({ agent: "planner" });

    const box = document.querySelector(".search input") as HTMLInputElement;
    box.value = "policy";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    const before = pageReads(fake).length;
    // Nothing yet: the read waits for typing to pause.
    expect(pageReads(fake)).toHaveLength(before);
    const countdown = app.countdown as FakeCountdown;
    countdown.live.find((armed) => armed.ms === 300)?.fire();
    await settle();
    expect(pageReads(fake).at(-1)).toMatchObject({ q: "policy", page: 1 });
  });
});

describe("pages (A7 E5)", () => {
  test("Ended shows the range and total, rows per page, and the pages; choosing either reads again", async () => {
    const { app, fake } = await openList([WORKER], {
      counts: { active: 0, ended: 123, all: 123, needsYou: 0 },
      total: 123,
    });
    // The server answers the page it was asked for, as the real one does within range.
    fake.onAgentSessions = (_baseUrl, _targetId, query) =>
      ok(
        agentSessionsPage([WORKER], {
          counts: { active: 0, ended: 123, all: 123, needsYou: 0 },
          total: 123,
          page: query?.page ?? 1,
        }),
      );
    app.setAgentSessionsQuery({ tab: "ended" });
    await settle();
    expect(document.querySelector(".range")?.textContent?.trim()).toBe(
      "1–1 of 123",
    );
    const numbers = [...document.querySelectorAll(".pages button")].map(
      (each) => each.getAttribute("aria-label"),
    );
    expect(numbers).toEqual([
      "Previous page",
      "Page 1",
      "Page 2",
      "Page 3",
      "Page 4",
      "Page 5",
      "Next page",
    ]);
    click(document.querySelector('[aria-label="Next page"]') as Element);
    await settle();
    expect(pageReads(fake).at(-1)).toMatchObject({ tab: "ended", page: 2 });
    expect(app.agentSessionsQuery.page).toBe(2);
    choose(
      document.querySelector(
        'select[aria-label="Rows per page"]',
      ) as HTMLSelectElement,
      "50",
    );
    await settle();
    expect(pageReads(fake).at(-1)).toMatchObject({ pageSize: 50, page: 1 });
  });

  test("Active comes in one piece: a range, no pager", async () => {
    await openList([IMPORTER]);
    expect(document.querySelector(".range")?.textContent?.trim()).toBe(
      "1–1 of 1",
    );
    expect(document.querySelector(".pages")).toBeNull();
  });
});

describe("live, without asking a harness (A7 U8b)", () => {
  test("a session's narration reads the list again once its frames settle, once, keeping the titles it has", async () => {
    const { app, fake } = await openList([IMPORTER]);
    const before = pageReads(fake).length;
    // The next read asks for no titles, and the server answers none.
    fake.onAgentSessions = () =>
      ok(agentSessionsPage([{ ...IMPORTER, title: null }]));
    for (let index = 0; index < 5; index += 1) {
      app.applyLiveFrame(
        "acme-corp",
        liveActivity({
          id: `activity:${String(index)}`,
          attemptId: null,
          importId: "imp_1",
        }),
      );
    }
    await settle();
    const countdown = app.countdown as FakeCountdown;
    const armed = countdown.live.filter(
      (each) => each.ms === AGENT_SESSIONS_REFRESH_MS,
    );
    expect(armed).toHaveLength(1);
    armed[0]?.fire();
    await settle();
    expect(pageReads(fake)).toHaveLength(before + 1);
    expect(pageReads(fake).at(-1)).toMatchObject({ titles: false });
    expect(rowTexts()[0]).toContain("Full policy sweep");
  });
});

describe("A7 U8b review: the rail and the list follow what changed", () => {
  test("a turn's end reads the list again, even after the last scheduled read has gone", async () => {
    const { app, fake } = await openList([IMPORTER]);
    const countdown = app.countdown as FakeCountdown;
    const before = pageReads(fake).length;
    app.applyLiveFrame(
      "acme-corp",
      liveActivity({ id: "activity:1", attemptId: null, importId: "imp_1" }),
    );
    countdown.live
      .filter((each) => each.ms === AGENT_SESSIONS_REFRESH_MS)
      .at(0)
      ?.fire();
    await settle();
    expect(pageReads(fake)).toHaveLength(before + 1);
    // The turn ends on an entry nothing renders: its frame alone has to arm a read.
    app.applyLiveFrame("acme-corp", {
      _tag: "turnEnded",
      attemptId: null,
      roundId: null,
      goalId: null,
      importId: "imp_1",
      at: Date.now(),
    });
    const armed = countdown.live.filter(
      (each) => each.ms === AGENT_SESSIONS_REFRESH_MS,
    );
    expect(armed).toHaveLength(1);
    armed[0]?.fire();
    await settle();
    expect(pageReads(fake)).toHaveLength(before + 2);
  });

  test("a stop from this tab reads the rail's count at once, with no frame to prompt it", async () => {
    const fake = new FakeServer();
    let active = 2;
    fake.onAgentSessions = () =>
      ok(
        agentSessionsPage([], {
          counts: { active, ended: 0, all: active, needsYou: 0 },
        }),
      );
    const app = new App(fake, new FakeCountdown());
    app.password = "correct-horse";
    await app.connect();
    app.openTarget("acme-corp");
    await settle();
    expect(app.navCount("agent-sessions")).toBe(2);
    active = 1;
    app.openGoalId = "goal_1";
    await app.stopRound("rnd_1");
    await settle();
    expect(app.navCount("agent-sessions")).toBe(1);
  });

  test("an older rail read landing after a newer page read does not put its counts back", async () => {
    const { app, fake } = await openList([IMPORTER]);
    // The rail's read asks for no titles; the page's asks for them, or not, explicitly.
    fake.onAgentSessions = (_base, _target, query) =>
      ok(
        agentSessionsPage([IMPORTER], {
          counts:
            query?.titles === undefined
              ? { active: 7, ended: 0, all: 7, needsYou: 0 }
              : { active: 3, ended: 0, all: 3, needsYou: 0 },
        }),
      );
    const release = fake.holdOne("agentSessions");
    const rail = app.loadAgentSessionCounts("acme-corp");
    await app.loadAgentSessions("acme-corp");
    expect(app.navCount("agent-sessions")).toBe(3);
    release();
    await rail;
    await settle();
    expect(app.navCount("agent-sessions")).toBe(3);
  });
});

describe("A7 U8b review: marks, agent text and long names", () => {
  test("an outcome not known has its own neutral mark; a session not running has the idle ring", async () => {
    await openList([
      agentSessionView({
        kind: "worker",
        key: "worker:u",
        state: "ended",
        detail: "uncertain",
        outcome: "unknown",
      }),
      agentSessionView({
        key: "goal:g2",
        subjectId: "g2",
        outcome: null,
        resumable: true,
      }),
    ]);
    const marks = [...document.querySelectorAll(".rows .row-item .mark")];
    expect(marks.map((mark) => mark.getAttribute("data-mark"))).toEqual([
      "unknown",
      "dormant",
    ]);
    expect(marks[0]?.querySelector(".unknown")?.textContent).toBe("?");
    // Failure is the only outcome in colour, and the unknown line is muted.
    expect(marks[0]?.classList.contains("is-failed")).toBe(false);
    const lines = [...document.querySelectorAll(".rows .row-item .line2")];
    expect(lines[0]?.classList.contains("muted")).toBe(true);
    expect(lines[0]?.textContent).toBe("Outcome not known");
    expect(lines[1]?.textContent).toBe("Not running · a message carries it on");
  });

  test("the agent's words are each in an isolate of their own; bit's beside them are not", async () => {
    const said = "\u202eesrever ni";
    await openList([
      {
        ...IMPORTER,
        title: "\u202eTitle",
        activity: {
          running: true,
          calls: 2,
          lastTool: "Bash",
          subagent: null,
          text: said,
          failure: null,
          at: Date.now(),
        },
      },
    ]);
    const line = document.querySelector(".rows .row-item .line2");
    const isolates = [...(line?.querySelectorAll(".said") ?? [])];
    expect(isolates.map((each) => each.textContent)).toEqual([said]);
    expect(line?.textContent).toBe(`${said} · 2 tool calls so far`);
    // The name's tooltip is a plain string: isolated with FSI … PDI.
    const name = document.querySelector(".rows .row-item .name");
    expect(name?.getAttribute("title")?.startsWith("\u2068")).toBe(true);
    expect(name?.getAttribute("title")?.endsWith("\u2069")).toBe(true);
  });

  test("a long name is capped, so where it lives keeps its room", async () => {
    await openList([
      agentSessionView({
        kind: "worker",
        key: "worker:long",
        subject: "Does ".repeat(80),
        state: "ended",
        outcome: "completed",
      }),
    ]);
    const name = document.querySelector(".rows .row-item .name");
    const crumb = document.querySelector(".rows .row-item .crumb");
    if (name === null || crumb === null) throw new Error("no row");
    // The DOM suite injects no component CSS: compile the page's and apply it.
    const path = new URL(
      "../../src/lib/screens/AgentSessions.svelte",
      import.meta.url,
    ).pathname;
    const { css } = compile(await Bun.file(path).text(), {
      filename: path,
      generate: "client",
      css: "external",
      dev: true,
    });
    const sheet = document.createElement("style");
    sheet.textContent = css?.code ?? "";
    document.head.append(sheet);
    mounted.push({ target: sheet, destroy: () => sheet.remove() });
    expect(getComputedStyle(name).maxWidth).toBe("60%");
    expect(getComputedStyle(name).unicodeBidi).toBe("isolate");
    expect(getComputedStyle(crumb).minWidth).toBe("9ch");
  });
});

describe("A7 U8b review: tabs and groups for assistive technology", () => {
  test("the tabs follow the WAI-ARIA pattern: one in the Tab order, arrows and Home/End move and select, each controls the panel", async () => {
    const { app } = await openList([IMPORTER]);
    const tabs = () => [
      ...document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ];
    expect(tabs().map((tab) => tab.getAttribute("tabindex"))).toEqual([
      "0",
      "-1",
      "-1",
    ]);
    const panel = document.getElementById(
      tabs()[0]?.getAttribute("aria-controls") ?? "",
    );
    expect(panel?.getAttribute("role")).toBe("tabpanel");
    expect(panel?.getAttribute("aria-labelledby")).toBe(tabs()[0]?.id);
    const press = (key: string) => {
      const on = tabs().find((tab) => tab.getAttribute("tabindex") === "0");
      on?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    };
    press("ArrowRight");
    await settle();
    expect(app.agentSessionsQuery.tab).toBe("ended");
    expect(document.activeElement?.textContent).toContain("Ended");
    press("End");
    await settle();
    expect(app.agentSessionsQuery.tab).toBe("all");
    press("ArrowRight");
    await settle();
    expect(app.agentSessionsQuery.tab).toBe("active");
    press("ArrowLeft");
    await settle();
    expect(app.agentSessionsQuery.tab).toBe("all");
    press("Home");
    await settle();
    expect(app.agentSessionsQuery.tab).toBe("active");
    expect(tabs()[0]?.getAttribute("tabindex")).toBe("0");
  });

  test("a group's header is a heading over its own list, never an item of the rows", async () => {
    const idle = agentSessionView({
      key: "goal:goal_2",
      subjectId: "goal_2",
      state: "live",
      group: "idle",
    });
    await openList([IMPORTER, idle]);
    const lists = [...document.querySelectorAll(".rows ul")];
    expect(lists).toHaveLength(2);
    for (const list of lists) {
      const items = [...list.querySelectorAll("li")];
      expect(items.every((item) => item.classList.contains("row-item"))).toBe(
        true,
      );
      const heading = document.getElementById(
        list.getAttribute("aria-labelledby") ?? "",
      );
      expect(heading?.tagName).toBe("H3");
      expect(heading?.closest("li")).toBeNull();
    }
    expect(
      lists.map((list) =>
        (
          document.getElementById(list.getAttribute("aria-labelledby") ?? "")
            ?.textContent ?? ""
        )
          .replace(/\s+/g, " ")
          .trim(),
      ),
    ).toEqual(["Running 1", "Idle 1"]);
  });
});

describe("a row that leads somewhere", () => {
  test("is a link carrying the path of the place it leads to", async () => {
    // The row the whole routing design exists for: an operator can read this href out of
    // the status bar, copy it, and send it to themselves for later review.
    await openList([
      IMPORTER,
      GOAL,
      agentSessionView({
        kind: "planner",
        key: "planner:goal_1",
        surface: { section: "goals", place: "Plan", gone: false },
      }),
    ]);
    const links = [...document.querySelectorAll<HTMLAnchorElement>("a.row.go")];
    // The planner lives on its goal's page, beside the conversation.
    expect(links.map((each) => each.getAttribute("href"))).toEqual([
      "/t/acme-corp/assets/chat/ses_import_1",
      "/t/acme-corp/goals/goal_1",
      "/t/acme-corp/goals/goal_1",
    ]);
  });

  test("a worker row is inert: not a link, and a click changes nothing", async () => {
    // There is a path for an attempt, and nothing to click it from until Workers lists
    // attempts. A row that linked there would lead to a section that shows the operator
    // their own transcript and nothing else.
    const { app } = await openList([WORKER]);
    expect(document.querySelector(".rows .row.go")).toBeNull();
    expect(document.querySelector(".rows a")).toBeNull();
    click(document.querySelector(".rows .row") as Element);
    await settle();
    expect(app.navItem).toBe("agent-sessions");
  });
});

describe("clicking a row", () => {
  test("an importer row opens the importer on that session, without following the href", async () => {
    const { app, fake } = await openList([IMPORTER]);
    fake.onImporterSessions = () =>
      ok({
        sessions: [
          importerSessionView({
            sessionId: "ses_import_1",
            importId: "imp_1",
          }),
        ],
      });

    const row = document.querySelector<HTMLAnchorElement>("a.row.go");
    expect(row).not.toBeNull();
    const event = clickOn(row as HTMLAnchorElement);
    await settle();

    // `preventDefault` ran, so the browser never navigated: the app is still the app it
    // was, with the session open in it.
    expect(event.defaultPrevented).toBe(true);
    expect(app.navItem).toBe("assets");
    expect(app.importerOpen).toBe(true);
    expect(app.importer.current?.id).toBe("ses_import_1");
  });

  test("an importer row whose session the importer's own index lacks goes nowhere, and says so", async () => {
    /*
     * The sentence is no longer in *this* screen's DOM, and that is design D5's point. It
     * used to be: a row that went nowhere wrote `agentSessionsNote` and this list rendered
     * it, which told the operator who clicked a row and told the operator who opened the
     * same link in a second tab nothing at all. It is `App.arrivalNote` now, which the
     * shell renders above whatever screen the arrival reached — so the assertion is on the
     * state, and the browser run is what shows the banner.
     *
     * The rail staying on Agent sessions is not an accident of this test: the fallback for
     * a dead chat *is* this list, so a click from it moves nothing and a cold arrival from
     * a URL ends up here.
     */
    const { app } = await openList([IMPORTER]);
    // The importer index answers empty (the fake's default).
    clickOn(document.querySelector("a.row.go") as Element);
    await settle();

    expect(app.importerOpen).toBe(false);
    expect(app.navItem).toBe("agent-sessions");
    expect(app.arrivalNote).toContain("no longer in the importer's own list");
  });

  test("a goal row opens the goal", async () => {
    const { app } = await openList([GOAL]);
    clickOn(document.querySelector("a.row.go") as Element);
    await settle();

    expect(app.navItem).toBe("goals");
    expect(app.openGoalId).toBe("goal_1");
  });

  test("and following another row retires a note the last one left", async () => {
    const { app } = await openList([IMPORTER, GOAL]);
    const links = [...document.querySelectorAll<HTMLAnchorElement>("a.row.go")];
    // The chat row first, whose session the index does not list: it goes nowhere, and says so.
    clickOn(links[0] as HTMLAnchorElement);
    await settle();
    expect(app.arrivalNote).toContain("no longer in the importer's own list");

    // Then the goal row, which lands. The note was about the row before it, and the
    // navigation methods `applyPlace` calls are what retire it — so the operator is never
    // left reading a sentence about a link they have already moved on from.
    clickOn(links[1] as HTMLAnchorElement);
    await settle();
    expect(app.arrivalNote).toBe("");
  });
});

describe("a modified click on a row", () => {
  /*
   * The half that makes a row worth being a link. Ctrl, Cmd, Shift and Alt are the
   * browser's own vocabulary for "open this somewhere else", and an app that calls
   * `preventDefault` on every click swallows all four: the operator asks for a second tab
   * and gets nothing, with no error to explain it.
   *
   * What is asserted is what this app does — nothing. The event is left unprevented and no
   * state moves, so the href stands and the browser is free to act on it. The new tab
   * itself is the browser's, and happy-dom does not open one.
   */
  test("ctrl or cmd is left to the browser, and the app does not move", async () => {
    const { app } = await openList([IMPORTER]);
    const row = document.querySelector("a.row.go") as Element;

    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
      const event = clickOn(row, modifier);
      await settle();
      expect(event.defaultPrevented).toBe(false);
      expect(app.navItem).toBe("agent-sessions");
      expect(app.importerOpen).toBe(false);
    }
  });

  test("so are shift and alt, and a middle button", async () => {
    const { app } = await openList([GOAL]);
    const row = document.querySelector("a.row.go") as Element;

    for (const modifier of [
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
    ]) {
      const event = clickOn(row, modifier);
      await settle();
      expect(event.defaultPrevented).toBe(false);
      expect(app.openGoalId).toBe("");
      expect(app.navItem).toBe("agent-sessions");
    }
  });
});
