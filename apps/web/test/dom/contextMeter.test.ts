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
import CrumbContextMeter from "../../src/lib/components/CrumbContextMeter.svelte";
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

/** How the API spells each model's calls (measured, CLI 2.1.310). */
const CALL_MODEL: Record<string, string> = {
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
  "claude-sonnet-5": "claude-sonnet-5",
};

/**
 * Claude Code's reading after a turn, with the categories when they are asked for. The
 * figure is labelled with the window's model's call unless `over` says otherwise, and the
 * categories with the window's model, as the server labels them.
 */
const claudeReading =
  (over: Partial<ConversationContext> = {}) =>
  (breakdown: boolean): ConversationContext => ({
    conversationId: "imp_1",
    model: "claude-haiku-4-5",
    used: 24_106,
    usedModel: CALL_MODEL[over.model ?? "claude-haiku-4-5"] ?? null,
    window: 200_000,
    reading: "measured",
    breakdown: breakdown
      ? {
          _tag: "categories",
          model: over.model ?? "claude-haiku-4-5",
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
    // The call's dated `claude-haiku-4-5-20251001` is the window's `claude-haiku-4-5`: no
    // line saying the figure is another model's.
    expect(open?.querySelector(".other-model")).toBeNull();

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
      usedModel: "openai/gpt-5.6-sol",
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
      model: "claude-haiku-4-5-20251001",
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

  test("categories counted on another model are not shown under this one's window, and the open meter counts this one once (U9 review 2)", async () => {
    let at = Date.now();
    let answer = claudeReading({ measuredAt: at });
    const { app, fake } = await openOn(
      importerSessionView({ harnessInstanceId: "claude-code" }),
      "claude-code",
      (breakdown) => answer(breakdown),
    );
    // Haiku's categories are held; then the meter is opened just as a switch to sonnet-5
    // is sent, so the count is still haiku's and lands after the switch's own reading.
    click(meterButton());
    await settle();
    expect(panel()?.querySelectorAll(".row").length).toBe(3);
    press("Escape");
    await settle();
    const counting = at + 1_000;
    const sonnet = { model: "claude-sonnet-5", window: 1_000_000 };
    let firstCount = true;
    answer = (breakdown) => {
      if (breakdown && firstCount) {
        firstCount = false;
        return claudeReading({ measuredAt: counting })(true);
      }
      return claudeReading({ ...sonnet, measuredAt: (at += 2_000) })(breakdown);
    };
    const release = fake.holdOne("importerContext");
    click(meterButton());
    await settle();
    expect(await app.importer.switchModel("claude-sonnet-5", undefined)).toBe(
      true,
    );
    await settle();
    release();
    await settle();
    expect(said(panel())).toContain("24,106 of 1,000,000 tokens");
    // Neither haiku's held rows nor the late haiku count, and the open meter counts once
    // more, on sonnet-5: its rows are shares of sonnet-5's window.
    const sonnetCounts = contextCalls(fake).filter(
      (call) => call === "imp_1 true",
    );
    expect(sonnetCounts.length).toBe(3);
    expect(
      [...(panel()?.querySelectorAll(".row") ?? [])].map((row) => said(row)),
    ).toEqual([
      "System tools 10,722 1%",
      "Messages 3,331 <1%",
      "Free space 182,699 18%",
    ]);
    expect(app.importer.contexts["imp_1"]?.categories?.model).toBe(
      "claude-sonnet-5",
    );
  });

  test("a count of the model before a switch made elsewhere is not shown, and counted again once (U9 review 2)", async () => {
    const at = Date.now();
    let answer = claudeReading({ measuredAt: at });
    const { app, fake } = await openOn(
      importerSessionView({ harnessInstanceId: "claude-code" }),
      "claude-code",
      (breakdown) => answer(breakdown),
    );
    const sonnet = { model: "claude-sonnet-5", window: 1_000_000 };
    let firstCount = true;
    let later = at + 2_000;
    answer = (breakdown) => {
      if (breakdown && firstCount) {
        firstCount = false;
        return claudeReading({ measuredAt: at + 1_000 })(true);
      }
      return claudeReading({ ...sonnet, measuredAt: (later += 1_000) })(
        breakdown,
      );
    };
    // The count goes out on haiku; another tab switches to sonnet-5, and a turn's reading
    // says so before the count lands.
    const release = fake.holdOne("importerContext");
    click(meterButton());
    await settle();
    await app.importer.readContext("imp_1", false, "turn");
    await settle();
    release();
    await settle();
    expect(app.importer.contexts["imp_1"]?.categories?.model).toBe(
      "claude-sonnet-5",
    );
    expect(panel()?.querySelectorAll(".row").length).toBe(3);
  });

  /** A live call frame for `imp_1` on `model`. */
  const callOn = (
    model: string,
    promptTokens: number,
    at: number,
    callId = `msg_${String(at)}`,
  ) => ({
    _tag: "usage" as const,
    callId,
    promptTokens,
    outputTokens: null,
    contextLimit: 200_000,
    compactionAt: null,
    model,
    attemptId: null,
    roundId: null,
    goalId: null,
    importId: "imp_1",
    at,
  });

  const dropOf = (app: App) =>
    crumbMeter(app.importer.contexts["imp_1"], app.liveUsage["import:imp_1"])
      .droppedFrom;

  test("repro 1: reloaded after a switch, the old model's figure is no baseline for the new model's call (U9 review 2)", async () => {
    // Sonnet-5 at 31,842, switched to haiku-4-5, reloaded before haiku's first call: a
    // fresh tab whose first reading is haiku's window over sonnet's last call.
    const at = Date.now();
    let answer = claudeReading({
      used: 31_842,
      usedModel: "claude-sonnet-5",
      measuredAt: at,
    });
    const { app, fake } = await openOn(
      importerSessionView({ harnessInstanceId: "claude-code" }),
      "claude-code",
      (breakdown) => answer(breakdown),
    );
    fake.watch.send(liveOpened({ from: 0, latest: 0 }));
    fake.watch.send(callOn("claude-haiku-4-5-20251001", 25_405, at + 1_000));
    await settle();
    expect(said(meterButton())).toBe("25,405");
    expect(dropOf(app)).toBeNull();
    // The turn's end reading, on haiku, told against sonnet's figure before it: no drop.
    answer = claudeReading({ used: 25_405, measuredAt: at + 2_000 });
    await app.importer.readContext("imp_1", false, "turn");
    await settle();
    click(meterButton());
    await settle();
    expect(said(panel())).toContain("25,405 of 200,000 tokens");
    expect(said(panel())).not.toContain("Down from");
  });

  test("repro 2: a call the old model finishes after a switch, then a Stop, is no baseline either (U9 review 2)", async () => {
    let at = Date.now();
    let answer = claudeReading({
      model: "claude-sonnet-5",
      used: 30_000,
      window: 1_000_000,
      measuredAt: at,
    });
    const { app, fake } = await openOn(
      importerSessionView({ harnessInstanceId: "claude-code" }),
      "claude-code",
      (breakdown) => answer(breakdown),
    );
    fake.watch.send(liveOpened({ from: 0, latest: 0 }));
    // Switched to haiku while a sonnet call streams: the server labels the figure sonnet's.
    answer = claudeReading({
      used: 30_000,
      usedModel: "claude-sonnet-5",
      measuredAt: (at += 1_000),
    });
    expect(await app.importer.switchModel("claude-haiku-4-5", undefined)).toBe(
      true,
    );
    await settle();
    // Sonnet's call lands two seconds after the switch, on sonnet.
    fake.watch.send(callOn("claude-sonnet-5", 36_464, (at += 2_000)));
    await settle();
    expect(said(meterButton())).toBe("36,464");
    // The Stop's reading: haiku's window, sonnet's last call.
    answer = claudeReading({
      used: 36_464,
      usedModel: "claude-sonnet-5",
      measuredAt: (at += 500),
    });
    await app.importer.stop();
    await settle();
    expect(dropOf(app)).toBeNull();
    // Haiku's next call counts the same conversation lower: not a compaction.
    fake.watch.send(callOn("claude-haiku-4-5-20251001", 28_406, at + 1_000));
    await settle();
    expect(said(meterButton())).toBe("28,406");
    expect(dropOf(app)).toBeNull();
    click(meterButton());
    await settle();
    expect(said(panel())).not.toContain("Down from");
  });

  test("a real drop on one model is still told, live and read (U9 review 2)", async () => {
    let at = Date.now();
    let answer = claudeReading({ used: 60_000, measuredAt: at });
    const { app, fake } = await openOn(
      importerSessionView({ harnessInstanceId: "claude-code" }),
      "claude-code",
      (breakdown) => answer(breakdown),
    );
    fake.watch.send(liveOpened({ from: 0, latest: 0 }));
    fake.watch.send(callOn("claude-haiku-4-5-20251001", 20_000, (at += 1_000)));
    await settle();
    expect(dropOf(app)).toBe(60_000);
    answer = claudeReading({ used: 20_100, measuredAt: at + 1_000 });
    await app.importer.readContext("imp_1", false, "turn");
    await settle();
    click(meterButton());
    await settle();
    expect(said(panel())).toContain("Down from 60,000 tokens");
  });

  test("a switch with the meter open counts the new model's rows once (U9 review 2)", async () => {
    let at = Date.now();
    let answer = claudeReading({ measuredAt: at });
    const { app, fake } = await openOn(
      importerSessionView({ harnessInstanceId: "claude-code" }),
      "claude-code",
      (breakdown) => answer(breakdown),
    );
    const counts = () =>
      contextCalls(fake).filter((call) => call === "imp_1 true").length;
    click(meterButton());
    await settle();
    expect(counts()).toBe(1);
    expect(panel()?.querySelectorAll(".row").length).toBe(3);
    // The switch's reading carries no rows; haiku's rows are not sonnet's window's.
    answer = claudeReading({
      model: "claude-sonnet-5",
      usedModel: "claude-haiku-4-5-20251001",
      window: 1_000_000,
      measuredAt: (at += 1_000),
    });
    const release = fake.hold("importerContext");
    expect(await app.importer.switchModel("claude-sonnet-5", undefined)).toBe(
      true,
    );
    await settle();
    // While the switch's reading is out, haiku's rows are still the window's.
    expect(panel()?.querySelectorAll(".row").length).toBe(3);
    release();
    await settle();
    expect(counts()).toBe(2);
    expect(said(panel())).toContain("24,106 of 1,000,000 tokens");
    expect(
      [...(panel()?.querySelectorAll(".row") ?? [])].map((row) => said(row)),
    ).toEqual([
      "System tools 10,722 1%",
      "Messages 3,331 <1%",
      "Free space 182,699 18%",
    ]);
    // The figure is haiku's last call, and the popover says so.
    expect(said(panel())).toContain(
      "Measured on claude-haiku-4-5-20251001's last call",
    );
    // A later reading on the same model asks nothing more.
    answer = claudeReading({
      model: "claude-sonnet-5",
      used: 31_000,
      window: 1_000_000,
      measuredAt: at + 1_000,
    });
    await app.importer.readContext("imp_1", false, "turn");
    await settle();
    expect(counts()).toBe(2);
  });

  test("a count that keeps coming back on another model is asked again only once (U9 review 2)", async () => {
    let at = Date.now();
    // A harness whose rows are always haiku's, whatever window it reads: the guard holds.
    const answer = (breakdown: boolean): ConversationContext => {
      const base = claudeReading({
        model: "claude-sonnet-5",
        window: 1_000_000,
        measuredAt: (at += 1_000),
      })(breakdown);
      return base.breakdown._tag === "categories"
        ? {
            ...base,
            breakdown: { ...base.breakdown, model: "claude-haiku-4-5" },
          }
        : base;
    };
    const { fake } = await openOn(
      importerSessionView({ harnessInstanceId: "claude-code" }),
      "claude-code",
      (breakdown) => answer(breakdown),
    );
    click(meterButton());
    await settle();
    await settle();
    await settle();
    expect(
      contextCalls(fake).filter((call) => call === "imp_1 true").length,
    ).toBe(2);
    expect(panel()?.querySelectorAll(".row").length).toBe(0);
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

describe("the meter's popover on its own (U9 review 2)", () => {
  const reading = (
    over: Partial<ConversationContext> = {},
  ): ConversationContext => ({
    conversationId: "imp_1",
    model: "claude-sonnet-5",
    used: 24_106,
    usedModel: "claude-sonnet-5",
    window: 1_000_000,
    reading: "measured",
    breakdown: { _tag: "none", reason: "not_asked" },
    measuredAt: Date.now(),
    ...over,
  });

  test("not asked: a sentence, never an empty panel", async () => {
    mounted.push(
      mountInto(CrumbContextMeter, {
        meter: crumbMeter({ reading: reading(), previous: null }, undefined),
        harness: "Claude Code",
      }),
    );
    click(meterButton());
    await settle();
    expect(said(panel())).toContain(
      "Claude Code counts what fills the window only when asked, and has not counted it for claude-sonnet-5 yet.",
    );
  });

  test("rows counted on another model are not drawn; the figure says when it is another model's", async () => {
    mounted.push(
      mountInto(CrumbContextMeter, {
        meter: crumbMeter(
          {
            reading: reading({ usedModel: "claude-haiku-4-5-20251001" }),
            previous: null,
            categories: {
              rows: [
                {
                  id: "free_space",
                  name: "Free space",
                  tokens: 175_000,
                  kind: "free",
                },
              ],
              measuredAt: Date.now(),
              model: "claude-haiku-4-5",
            },
          },
          undefined,
        ),
        harness: "Claude Code",
      }),
    );
    click(meterButton());
    await settle();
    expect(panel()?.querySelectorAll(".row").length).toBe(0);
    expect(said(panel())).toContain(
      "Measured on claude-haiku-4-5-20251001's last call. The next call, on claude-sonnet-5, measures it again",
    );
  });
});
