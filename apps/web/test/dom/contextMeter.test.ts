/**
 * The crumb bar's context meter on the importer page (A6 U9, D3), as the operator meets it:
 * a labelled button with a ring and a count, a popover with what fills the window — Claude
 * Code's categories, or OpenCode's line saying it gives none — that Escape closes with focus
 * back on the button, and readings asked on opening, after a turn and after a model switch.
 */
import { afterEach, describe, expect, test } from "bun:test";

import type { ConversationContext, ImporterSessionView } from "@bit/contracts";

import { App, IMPORT_POLL_MS } from "../../src/lib/app.svelte";
import { crumbMeter } from "../../src/lib/crumbMeter";
import TitleBar from "../../src/lib/components/TitleBar.svelte";
import Target from "../../src/lib/screens/Target.svelte";
import { FakeCountdown } from "../fakeCountdown";
import {
  FakeServer,
  emptyScope,
  importerSessionView,
  liveActivity,
  liveOpened,
  ok,
} from "../fakeServer";
import { click, mountInto, press, settle, type Mounted } from "./dom";

let mounted: Mounted[] = [];
afterEach(() => {
  for (const each of mounted) each.destroy();
  mounted = [];
});

const said = (element: Element | null | undefined): string =>
  (element?.textContent ?? "").replace(/\s+/g, " ").trim();

const meterButton = (): HTMLButtonElement => {
  const button = document.querySelector<HTMLButtonElement>(
    ".context-meter button.meter",
  );
  if (button === null) throw new Error("no context meter");
  return button;
};

const panel = (): HTMLElement | null =>
  document.querySelector<HTMLElement>(
    '[role="dialog"][aria-label="What fills the context window"]',
  );

const harnessOf = (driver: "claude-code" | "opencode") => ({
  instanceId: driver,
  driver,
  displayName: driver === "opencode" ? "OpenCode" : "Claude Code",
  version: "1.0.0",
  ready: true,
  auth: "authenticated" as const,
  isDefault: true,
  defaultModel: "m",
  models: [{ id: "m" }],
});

/** Claude Code's reading after a turn, with the categories when they are asked for. */
const claudeReading =
  (over: Partial<ConversationContext> = {}) =>
  (breakdown: boolean): ConversationContext => ({
    conversationId: "imp_1",
    model: "claude-haiku-4-5",
    used: 24_106,
    window: 200_000,
    reading: "measured",
    breakdown: breakdown
      ? {
          _tag: "categories",
          categories: [
            {
              id: "system_tools",
              name: "System tools",
              tokens: 10_722,
              kind: "used",
            },
            { id: "messages", name: "Messages", tokens: 3_331, kind: "used" },
            {
              id: "free_space",
              name: "Free space",
              tokens: 182_699,
              kind: "free",
            },
          ],
        }
      : { _tag: "none", reason: "not_asked" },
    measuredAt: Date.now(),
    ...over,
  });

/** A real target's importer page on `session`, its context answered by `answer`. */
const openOn = async (
  session: ImporterSessionView,
  driver: "claude-code" | "opencode",
  answer: (breakdown: boolean) => ConversationContext,
): Promise<{ app: App; fake: FakeServer }> => {
  const fake = new FakeServer();
  fake.onScope = () => ok(emptyScope());
  fake.onImporterSessions = () => ok({ sessions: [session] });
  fake.onHarnesses = () => ok([harnessOf(driver)]);
  fake.onImporterContext = (_baseUrl, _targetId, _importId, breakdown) =>
    ok(answer(breakdown));
  const app = new App(fake, new FakeCountdown());
  app.password = "correct-horse";
  await app.connect();
  app.openTarget("acme-corp");
  await settle();
  app.toSection("assets");
  await settle();
  app.openImporter(session.sessionId);
  await settle();
  mounted.push(mountInto(TitleBar, { app }), mountInto(Target, { app }));
  await settle();
  return { app, fake };
};

const contextCalls = (fake: FakeServer) =>
  fake.calls
    .filter((call) => call.method === "importerContext")
    .map((call) => `${String(call.args[2])} ${String(call.args[3])}`);

describe("the crumb bar's context meter (A6 U9)", () => {
  test("the empty session before its first message reads 0, with no tokens used yet", async () => {
    const fake = new FakeServer();
    fake.onScope = () => ok(emptyScope());
    fake.onImporterSessions = () => ok({ sessions: [] });
    fake.onHarnesses = () => ok([harnessOf("opencode")]);
    const app = new App(fake, new FakeCountdown());
    app.password = "correct-horse";
    await app.connect();
    app.openTarget("acme-corp");
    await settle();
    app.toSection("assets");
    await settle();
    app.openImporter();
    await settle();
    mounted.push(mountInto(TitleBar, { app }), mountInto(Target, { app }));
    await settle();
    expect(meterButton().getAttribute("aria-label")).toBe(
      "Session context · no tokens used yet",
    );
    expect(said(meterButton())).toBe("0");
    // No arc without a measurement: the track alone.
    expect(meterButton().querySelectorAll("circle").length).toBe(1);
    expect(contextCalls(fake)).toEqual([]);
  });

  test("Claude Code: the count and arc, a popover with the categories asked for on opening, and Escape back to the button", async () => {
    const { fake } = await openOn(
      importerSessionView({ harnessInstanceId: "claude-code" }),
      "claude-code",
      claudeReading(),
    );
    // Read once on opening the session, without the categories.
    expect(contextCalls(fake)).toEqual(["imp_1 false"]);
    const button = meterButton();
    expect(button.getAttribute("aria-label")).toBe(
      "Session context · 24,106 of 200,000 tokens",
    );
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(said(button)).toBe("24,106");
    expect(
      button.querySelector("circle.arc")?.getAttribute("stroke-dasharray"),
    ).toBe("6.8 49.7");

    click(button);
    await settle();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    // Opening asks for the categories, which Claude Code counts only when asked.
    expect(contextCalls(fake)).toEqual(["imp_1 false", "imp_1 true"]);
    const open = panel();
    expect(said(open)).toContain("24,106 of 200,000 tokens · 12%");
    expect(
      [...(open?.querySelectorAll(".row") ?? [])].map((row) => said(row)),
    ).toEqual([
      "System tools 10,722 5%",
      "Messages 3,331 2%",
      "Free space 182,699 91%",
    ]);
    expect(said(open)).toContain("Claude Code's own count of each part");

    press("Escape");
    await settle();
    expect(panel()).toBeNull();
    expect(document.activeElement === meterButton()).toBe(true);
    expect(meterButton().getAttribute("aria-expanded")).toBe("false");
  });

  test("OpenCode: tokens and window only, with the line saying it gives no breakdown; a click elsewhere closes it", async () => {
    await openOn(importerSessionView(), "opencode", () => ({
      conversationId: "imp_1",
      model: "openai/gpt-5.6-sol",
      used: 13_765,
      window: 400_000,
      reading: "measured",
      breakdown: { _tag: "none", reason: "harness_gives_none" },
      measuredAt: Date.now(),
    }));
    click(meterButton());
    await settle();
    const open = panel();
    expect(open?.querySelectorAll(".row").length).toBe(0);
    expect(said(open)).toContain("13,765 of 400,000 tokens · 3%");
    expect(said(open)).toContain(
      "OpenCode reports the tokens of each model call and the model's window, but gives no breakdown of what fills it.",
    );
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await settle();
    expect(panel()).toBeNull();
  });

  test("no window, compacted, and a session not held each say so", async () => {
    await openOn(
      importerSessionView({ harnessInstanceId: "claude-code" }),
      "claude-code",
      claudeReading({
        window: null,
        breakdown: { _tag: "none", reason: "not_live" },
      }),
    );
    expect(meterButton().getAttribute("aria-label")).toBe(
      "Session context · 24,106 tokens",
    );
    expect(meterButton().querySelector("circle.arc")).toBeNull();
    click(meterButton());
    await settle();
    expect(said(panel())).toContain("No context window was reported");
    expect(said(panel())).toContain("this server does not hold this one now");
  });

  test("a model switch reads the new model's window; a compaction reads as a drop", async () => {
    let answer = claudeReading();
    const { app, fake } = await openOn(
      importerSessionView({ harnessInstanceId: "claude-code" }),
      "claude-code",
      (breakdown) => answer(breakdown),
    );
    answer = claudeReading({ model: "claude-sonnet-5", window: 1_000_000 });
    // An indexed session counts as started (`tally.messages` is `null`): it can switch.
    expect(await app.importer.switchModel("claude-sonnet-5", undefined)).toBe(
      true,
    );
    await settle();
    expect(contextCalls(fake).at(-1)).toBe("imp_1 false");
    expect(meterButton().getAttribute("aria-label")).toBe(
      "Session context · 24,106 of 1,000,000 tokens",
    );
    // The next turn is the new model's count; a compaction after it is told against that.
    const sonnet = { model: "claude-sonnet-5", window: 1_000_000 };
    answer = claudeReading({ ...sonnet, used: 32_000 });
    await app.importer.readContext("imp_1", false, "turn");
    answer = claudeReading({ ...sonnet, used: null, reading: "compacted" });
    await app.importer.readContext("imp_1", false, "turn");
    await settle();
    expect(said(meterButton())).toBe("0");
    click(meterButton());
    await settle();
    expect(said(panel())).toContain("Summarised.");
    expect(said(panel())).toContain("Down from 32,000 tokens");
  });

  test("a turn's end reads the window again, and its live calls move the figure meanwhile", async () => {
    let answer = claudeReading();
    const { app, fake } = await openOn(
      importerSessionView({ harnessInstanceId: "claude-code" }),
      "claude-code",
      (breakdown) => answer(breakdown),
    );
    fake.watch.send(liveOpened({ from: 0, latest: 0 }));
    await settle();
    const before = contextCalls(fake).length;
    // A turn runs (its words arrive while the tab thought nothing ran), and calls the model.
    fake.onImporterActivity = (_baseUrl, _targetId, importId) =>
      ok({ conversationId: importId, turn: "running", background: false });
    fake.watch.send(
      liveActivity({
        id: "activity:5",
        attemptId: null,
        importId: "imp_1",
        kind: "turn.reply",
        headline: "Reply",
        tool: null,
        toolName: null,
        input: null,
        callId: null,
        body: "Reading the page.",
      }),
    );
    fake.watch.send({
      _tag: "usage",
      callId: "msg_2",
      promptTokens: 31_000,
      outputTokens: null,
      contextLimit: 200_000,
      compactionAt: null,
      attemptId: null,
      roundId: null,
      goalId: null,
      importId: "imp_1",
      at: Date.now() + 1_000,
    });
    await settle();
    expect(app.importer.current?.working).toBe(true);
    // The live call is newer than the reading: the figure follows it, and nothing was asked.
    expect(said(meterButton())).toBe("31,000");
    expect(contextCalls(fake).length).toBe(before);
    // The turn ends: one read, never one per call.
    answer = claudeReading({ used: 31_450, measuredAt: Date.now() + 2_000 });
    fake.onImporterActivity = (_baseUrl, _targetId, importId) =>
      ok({ conversationId: importId, turn: "idle", background: false });
    for (const armed of (app.countdown as FakeCountdown).live.filter(
      (each) => each.ms === IMPORT_POLL_MS,
    )) {
      armed.fire();
    }
    await settle();
    expect(contextCalls(fake).length).toBe(before + 1);
    expect(said(meterButton())).toBe("31,450");
  });

  test("a switch between models is never told as a drop; a real one after it still is (A6 U9 review)", async () => {
    let at = Date.now();
    let answer = claudeReading({
      model: "claude-sonnet-5",
      used: 31_603,
      window: 1_000_000,
      measuredAt: at,
    });
    const { app, fake } = await openOn(
      importerSessionView({ harnessInstanceId: "claude-code" }),
      "claude-code",
      (breakdown) => answer(breakdown),
    );
    const dropTold = async (): Promise<boolean> => {
      click(meterButton());
      await settle();
      const told = said(panel()).includes("Down from");
      press("Escape");
      await settle();
      return told;
    };
    const dropNow = () =>
      crumbMeter(app.importer.contexts["imp_1"], app.liveUsage["import:imp_1"])
        .droppedFrom;
    // Haiku counts the same conversation about a quarter lower than sonnet-5 (measured).
    // The switch's own reading is held: haiku's first call lands before it.
    answer = claudeReading({ used: 31_603, measuredAt: (at += 1_000) });
    const release = fake.holdOne("importerContext");
    expect(await app.importer.switchModel("claude-haiku-4-5", undefined)).toBe(
      true,
    );
    await settle();
    fake.watch.send(liveOpened({ from: 0, latest: 0 }));
    fake.watch.send({
      _tag: "usage",
      callId: "msg_haiku",
      promptTokens: 24_507,
      outputTokens: null,
      contextLimit: 200_000,
      compactionAt: null,
      attemptId: null,
      roundId: null,
      goalId: null,
      importId: "imp_1",
      at: at + 500,
    });
    await settle();
    expect(said(meterButton())).toBe("24,507");
    expect(dropNow()).toBeNull();
    // The switch's reading lands: the old model's figure under the new model's window.
    release();
    await settle();
    expect(app.importer.contexts["imp_1"]?.reading.model).toBe(
      "claude-haiku-4-5",
    );
    expect(dropNow()).toBeNull();
    expect(said(meterButton())).toBe("24,507");
    answer = claudeReading({ used: 24_507, measuredAt: (at += 1_000) });
    expect(await dropTold()).toBe(false);
    await app.importer.readContext("imp_1", false, "turn");
    await settle();
    expect(await dropTold()).toBe(false);
    // Back on the same model, a real compaction is told against haiku's own figure.
    answer = claudeReading({ used: 12_000, measuredAt: at + 1_000 });
    await app.importer.readContext("imp_1", false, "turn");
    await settle();
    click(meterButton());
    await settle();
    expect(said(panel())).toContain("Down from 24,507 tokens");
  });

  test("a reading on another model than the one held, switched from elsewhere, is not a drop (A6 U9 review)", async () => {
    let answer = claudeReading({
      model: "claude-sonnet-5",
      used: 31_603,
      window: 1_000_000,
    });
    const { app } = await openOn(
      importerSessionView({ harnessInstanceId: "claude-code" }),
      "claude-code",
      (breakdown) => answer(breakdown),
    );
    // Another tab switched the session, and its next turn ran on haiku.
    answer = claudeReading({ used: 24_507 });
    await app.importer.readContext("imp_1", false, "turn");
    await settle();
    click(meterButton());
    await settle();
    expect(said(panel())).toContain("24,507 of 200,000 tokens");
    expect(said(panel())).not.toContain("Down from");
  });

  test("opening the meter after a compaction keeps its drop note (A6 U9 review)", async () => {
    let at = Date.now();
    let answer = claudeReading({ used: 50_000, measuredAt: at });
    const { app } = await openOn(
      importerSessionView({ harnessInstanceId: "claude-code" }),
      "claude-code",
      (breakdown) => answer(breakdown),
    );
    answer = claudeReading({ used: 20_000, measuredAt: (at += 1_000) });
    await app.importer.readContext("imp_1", false, "turn");
    await settle();
    // The breakdown read on opening finds the same figure: the drop is still the news.
    answer = claudeReading({ used: 20_000, measuredAt: (at += 1_000) });
    click(meterButton());
    await settle();
    expect(said(panel())).toContain("System tools");
    expect(said(panel())).toContain("Down from 50,000 tokens");
    // A later figure that rose is the next baseline, and the note goes.
    press("Escape");
    await settle();
    answer = claudeReading({ used: 22_000, measuredAt: at + 1_000 });
    await app.importer.readContext("imp_1", false, "turn");
    await settle();
    click(meterButton());
    await settle();
    expect(said(panel())).not.toContain("Down from");
  });

  test("a breakdown that lands after a newer figure keeps its categories, marked with their own time (A6 U9 review)", async () => {
    const at = Date.now();
    let answer = claudeReading({ measuredAt: at });
    const { app, fake } = await openOn(
      importerSessionView({ harnessInstanceId: "claude-code" }),
      "claude-code",
      (breakdown) => answer(breakdown),
    );
    // A slow count asked mid-turn, and the turn's end read that overtakes it.
    answer = (breakdown) =>
      breakdown
        ? claudeReading({ measuredAt: at + 1_000 })(true)
        : claudeReading({ used: 31_450, measuredAt: at + 2_000 })(false);
    const release = fake.holdOne("importerContext");
    click(meterButton());
    await settle();
    await app.importer.readContext("imp_1", false, "turn");
    await settle();
    release();
    await settle();
    const open = panel();
    // The newer figure, and the count that came with the older one.
    expect(said(open)).toContain("31,450 of 200,000 tokens");
    expect(
      [...(open?.querySelectorAll(".row") ?? [])].map((row) => said(row)),
    ).toEqual([
      "System tools 10,722 5%",
      "Messages 3,331 2%",
      "Free space 182,699 91%",
    ]);
    expect(said(open)).toContain("Counted before the latest call,");
  });

  test("toggling the meter asks for one count; closing it drops the answer unless it is opened again (A6 U9 review)", async () => {
    const { app, fake } = await openOn(
      importerSessionView({ harnessInstanceId: "claude-code" }),
      "claude-code",
      claudeReading(),
    );
    const counts = () =>
      contextCalls(fake).filter((call) => call === "imp_1 true").length;
    const counting = () => app.importer.countingBreakdown.has("imp_1");
    // Opened and closed before the count lands: nothing reads as counting, and its
    // answer is not put up.
    let release = fake.hold("importerContext");
    click(meterButton());
    await settle();
    expect(counts()).toBe(1);
    expect(counting()).toBe(true);
    click(meterButton());
    await settle();
    expect(counting()).toBe(false);
    release();
    await settle();
    expect(app.importer.contexts["imp_1"]?.categories).toBeUndefined();
    // Toggled five and a half times while one count is out: that one count.
    release = fake.hold("importerContext");
    for (let toggles = 0; toggles < 11; toggles += 1) {
      click(meterButton());
      await settle();
      expect(counting()).toBe(toggles % 2 === 0);
    }
    expect(counts()).toBe(2);
    expect(said(panel())).toContain("Counting what fills the window");
    release();
    await settle();
    expect(counting()).toBe(false);
    expect(panel()?.querySelectorAll(".row").length).toBe(3);
  });

  test("opening another session drops the count asked for the one left (A6 U9 review)", async () => {
    const first = importerSessionView({ harnessInstanceId: "claude-code" });
    const second = importerSessionView({
      harnessInstanceId: "claude-code",
      sessionId: "ses_2",
      importId: "imp_2",
    });
    const { app, fake } = await openOn(first, "claude-code", claudeReading());
    fake.onImporterSessions = () => ok({ sessions: [first, second] });
    await app.loadImporterSessions("acme-corp");
    await settle();
    const release = fake.hold("importerContext");
    click(meterButton());
    await settle();
    expect(app.importer.countingBreakdown.has("imp_1")).toBe(true);
    app.importer.open("ses_2");
    await settle();
    expect(app.importer.countingBreakdown.size).toBe(0);
    release();
    await settle();
    expect(app.importer.contexts["imp_1"]?.categories).toBeUndefined();
  });

  test("a Stop reads the window again, and the footer says what each reading was taken after (A6 U9 review)", async () => {
    let at = Date.now();
    let answer = claudeReading({ measuredAt: at });
    const { app, fake } = await openOn(
      importerSessionView({ harnessInstanceId: "claude-code" }),
      "claude-code",
      (breakdown) => answer(breakdown),
    );
    const footer = () => said(panel()?.querySelector(".when"));
    // Opened while the count is out: the figure is the session's opening read.
    const release = fake.hold("importerContext");
    click(meterButton());
    await settle();
    expect(footer()).toMatch(/^Read on opening the session, /);
    answer = claudeReading({ measuredAt: (at += 1_000) });
    release();
    await settle();
    expect(footer()).toMatch(/^Read on opening this panel, /);
    const before = contextCalls(fake).length;
    answer = claudeReading({ used: 26_000, measuredAt: (at += 1_000) });
    await app.importer.stop();
    await settle();
    expect(contextCalls(fake).slice(before)).toEqual(["imp_1 false"]);
    expect(said(meterButton())).toBe("26,000");
    expect(footer()).toMatch(/^Read after the Stop, /);
    answer = claudeReading({ used: 27_000, measuredAt: at + 1_000 });
    await app.importer.readContext("imp_1", false, "turn");
    await settle();
    expect(footer()).toMatch(/^Read after the last turn, /);
  });

  test("a turn the list finds over, which the turn watch did not see end, reads the window again (A6 U9 review)", async () => {
    const running = importerSessionView({
      harnessInstanceId: "claude-code",
      running: true,
    });
    const fake = new FakeServer();
    fake.onScope = () => ok(emptyScope());
    fake.onImporterSessions = () => ok({ sessions: [running] });
    fake.onHarnesses = () => ok([harnessOf("claude-code")]);
    fake.onImporterContext = () => ok(claudeReading()(false));
    // The turn watch never answers: only the list can say the turn is over.
    fake.hold("importerActivity");
    const app = new App(fake, new FakeCountdown());
    app.password = "correct-horse";
    await app.connect();
    app.openTarget("acme-corp");
    await settle();
    app.toSection("assets");
    await settle();
    app.openImporter(running.sessionId);
    await settle();
    expect(app.importer.current?.working).toBe(true);
    const before = contextCalls(fake).length;
    fake.onImporterSessions = () =>
      ok({ sessions: [{ ...running, running: false }] });
    await app.loadImporterSessions("acme-corp");
    await settle();
    expect(app.importer.current?.working).toBe(false);
    expect(contextCalls(fake).slice(before)).toEqual(["imp_1 false"]);
    expect(app.importer.contexts["imp_1"]?.cause).toBe("turn");
  });
});
