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

import { type AgentSessionView } from "@bit/contracts";

import { App } from "../../src/lib/app.svelte";
import Sidebar from "../../src/lib/components/Sidebar.svelte";
import Target from "../../src/lib/screens/Target.svelte";
import { FakeCountdown } from "../fakeCountdown";
import {
  FakeServer,
  agentSessionView,
  importerSessionView,
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
});

const openList = async (
  sessions: AgentSessionView[],
  over: { workersOmitted?: number } = {},
): Promise<{ app: App; fake: FakeServer }> => {
  const fake = new FakeServer();
  fake.onAgentSessions = () =>
    ok({ sessions, workersOmitted: over.workersOmitted ?? 0 });
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

describe("the Agent sessions tab", () => {
  test("is in the rail under Operations, beside Workers, Blockers and Event log", async () => {
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
    expect(labels.findIndex((each) => each?.startsWith("Event log"))).toBe(
      tab - 1,
    );
    // It has a glyph: the rail draws one svg per item.
    expect(
      document.querySelectorAll(".item")[tab]?.querySelector("svg"),
    ).not.toBeNull();
  });
});

describe("the Agent sessions list", () => {
  test("says kind, subject, harness and model, state and tally for each kind of session", async () => {
    const { fake } = await openList([GOAL, IMPORTER, WORKER]);

    expect(fake.calls.filter((c) => c.method === "agentSessions")).toHaveLength(
      1,
    );
    const rows = [...document.querySelectorAll(".rows li")].map((each) =>
      (each.textContent ?? "").replace(/\s+/g, " "),
    );
    expect(rows).toHaveLength(3);
    // The goal: its harness resolved to a name, no model it can know, not held.
    expect(rows[0]).toContain("Goal");
    expect(rows[0]).toContain("Find auth bypasses");
    expect(rows[0]).toContain("Claude Code");
    expect(rows[0]).toContain("model not recorded");
    expect(rows[0]).toContain("Not running");
    // The importer: live, with the one tally a kind derives.
    expect(rows[1]).toContain("Importer");
    expect(rows[1]).toContain("Scope import");
    expect(rows[1]).toContain("openai/gpt-5.6-sol");
    expect(rows[1]).toContain("Live");
    expect(rows[1]).toContain("7 in · 3 out · 1 asset");
    // The worker: ended, with how, and no tally invented.
    expect(rows[2]).toContain("Worker");
    expect(rows[2]).toContain("Does /invoices accept another tenant id?");
    expect(rows[2]).toContain("Ended · failed");
    expect(rows[2]).not.toContain(" in · ");
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
    const rows = [...document.querySelectorAll(".rows li")];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain(
      "Harness “retired-harness” is no longer configured",
    );
    // And a session on a harness this server does run is not.
    expect(rows[1]?.textContent).not.toContain("no longer configured");
  });

  test("does not call a harness gone before the harness listing has arrived", async () => {
    const fake = new FakeServer();
    fake.onAgentSessions = () =>
      ok({
        sessions: [agentSessionView({ harnessInstanceId: "x" })],
        workersOmitted: 0,
      });
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
    expect(document.querySelectorAll(".rows li")).toHaveLength(1);
    expect(text()).not.toContain("no longer configured");
  });

  test("says how many worker sessions the bound left out", async () => {
    await openList([WORKER], { workersOmitted: 42 });
    expect(text()).toContain("42 older worker sessions are not shown");
  });
});

describe("a row that leads somewhere", () => {
  test("is a link carrying the path of the place it leads to", async () => {
    // The row the whole routing design exists for: an operator can read this href out of
    // the status bar, copy it, and send it to themselves for later review.
    await openList([IMPORTER, GOAL]);
    const links = [...document.querySelectorAll<HTMLAnchorElement>("a.row.go")];
    expect(links.map((each) => each.getAttribute("href"))).toEqual([
      "/t/acme-corp/assets/chat/ses_import_1",
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
    const { app } = await openList([IMPORTER]);
    // The importer index answers empty (the fake's default).
    clickOn(document.querySelector("a.row.go") as Element);
    await settle();

    expect(app.importerOpen).toBe(false);
    expect(app.navItem).toBe("agent-sessions");
    expect(text()).toContain("no longer in the importer's own list");
  });

  test("a goal row opens the goal", async () => {
    const { app } = await openList([GOAL]);
    clickOn(document.querySelector("a.row.go") as Element);
    await settle();

    expect(app.navItem).toBe("goals");
    expect(app.openGoalId).toBe("goal_1");
  });

  test("and following another row retires a refusal the last one left", async () => {
    const { app } = await openList([IMPORTER, GOAL]);
    const links = [...document.querySelectorAll<HTMLAnchorElement>("a.row.go")];
    // The chat row first, whose session the index does not list: it refuses, on screen.
    clickOn(links[0] as HTMLAnchorElement);
    await settle();
    expect(text()).toContain("no longer in the importer's own list");

    // Then the goal row. The refusal was about the row before it, not about the list.
    clickOn(links[1] as HTMLAnchorElement);
    await settle();
    expect(app.agentSessionsNote).toBe("");
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
