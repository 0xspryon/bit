/**
 * The crumb bar's context meter, decided without a browser (A6 U9, D3): which figure it
 * draws when the server's reading and the live feed's call frame disagree, what the ring
 * fills to, and when it says the window shrank.
 */
import { describe, expect, test } from "bun:test";

import type { ConversationContext, LiveUsage } from "@bit/contracts";

import {
  crumbFigure,
  crumbLabel,
  crumbMeter,
  crumbSource,
  ringDash,
  shareOf,
} from "../src/lib/crumbMeter";
import type { ImporterContext } from "../src/lib/importerSessions.svelte";

const reading = (
  over: Partial<ConversationContext> = {},
): ConversationContext => ({
  conversationId: "imp_1",
  model: "claude-haiku-4-5",
  used: 24_106,
  window: 200_000,
  reading: "measured",
  breakdown: { _tag: "none", reason: "not_asked" },
  measuredAt: 1_000,
  ...over,
});

const held = (
  over: Partial<ConversationContext> = {},
  extra: Partial<ImporterContext> = {},
): ImporterContext => ({
  reading: reading(over),
  previousUsed: null,
  ...extra,
});

const live = (over: Partial<LiveUsage> = {}): LiveUsage => ({
  _tag: "usage",
  callId: "msg_1",
  promptTokens: 30_000,
  outputTokens: 120,
  contextLimit: 200_000,
  compactionAt: null,
  attemptId: null,
  roundId: null,
  goalId: null,
  importId: "imp_1",
  at: 2_000,
  ...over,
});

describe("the crumb bar's context meter (A6 U9)", () => {
  test("a session with no reading: an empty ring and 0, as D3's first screen", () => {
    const meter = crumbMeter(undefined, undefined);
    expect(meter.reading).toBe("none");
    expect(crumbFigure(meter)).toBe("0");
    expect(crumbLabel(meter)).toBe("Session context · no tokens used yet");
    expect(ringDash(meter.fraction)).toBeNull();
  });

  test("a measured reading: the count, the fraction of the window, D3's arc and tooltip", () => {
    const meter = crumbMeter(held(), undefined);
    expect(crumbFigure(meter)).toBe("24,106");
    expect(meter.percent).toBe(12);
    expect(crumbLabel(meter)).toBe(
      "Session context · 24,106 of 200,000 tokens",
    );
    // D3 draws 12 % as `6.8 49.7`.
    expect(ringDash(meter.fraction)).toBe("6.8 49.7");
    expect(meter.source).toBe("turn");
  });

  test("no window: the count and no arc, since there is no fraction", () => {
    const meter = crumbMeter(held({ window: null }), undefined);
    expect(meter.fraction).toBeNull();
    expect(ringDash(meter.fraction)).toBeNull();
    expect(crumbLabel(meter)).toBe("Session context · 24,106 tokens");
  });

  test("a live call newer than the reading is the figure; an older one is not", () => {
    const newer = crumbMeter(held(), live());
    expect(newer.used).toBe(30_120);
    expect(newer.source).toBe("live");
    expect(newer.at).toBe(2_000);
    // A call whose output is not stated yet counts what was sent.
    expect(crumbMeter(held(), live({ outputTokens: null })).used).toBe(30_000);
    const older = crumbMeter(held({ measuredAt: 3_000 }), live());
    expect(older.used).toBe(24_106);
    expect(older.source).toBe("turn");
    // Before any reading came back, the live frame alone, with its window.
    expect(crumbMeter(undefined, live()).fraction).toBeCloseTo(0.1506, 3);
  });

  test("after a model switch the reading's window is the meter's, not an older call's", () => {
    // The switch's reading: the new model's window, the figure still the last call's.
    const switched = held({ model: "claude-sonnet-5", window: 1_000_000 });
    const meter = crumbMeter(switched, live({ contextLimit: 200_000 }));
    expect(meter.window).toBe(1_000_000);
    expect(meter.model).toBe("claude-sonnet-5");
  });

  test("a compaction: the reading says so with the figure before it; a large drop says it too; a recount does not", () => {
    const compacted = crumbMeter(
      held(
        { used: null, reading: "compacted", measuredAt: 5_000 },
        { previousUsed: 118_204 },
      ),
      // A call from before the compaction is older than the reading and does not count.
      live({ at: 4_000 }),
    );
    expect(compacted.used).toBeNull();
    expect(compacted.droppedFrom).toBe(118_204);
    expect(crumbLabel(compacted)).toBe(
      "Session context · summarised, measured again on the next model call",
    );
    // The next call measures it again, and the drop is still told against the old figure.
    const after = crumbMeter(
      held({ used: 40_000 }, { previousUsed: 118_204 }),
      undefined,
    );
    expect(after.droppedFrom).toBe(118_204);
    // A model recounting the same conversation a little smaller is not a compaction.
    expect(
      crumbMeter(held({ used: 23_500 }, { previousUsed: 24_106 }), undefined)
        .droppedFrom,
    ).toBeNull();
    // A live call far below the reading, mid-turn: the harness compacted on its own.
    expect(
      crumbMeter(held({ used: 160_000 }), live({ promptTokens: 30_000 }))
        .droppedFrom,
    ).toBe(160_000);
  });

  test("categories counted before the latest figure are marked stale; a reason without them", () => {
    const rows = [
      {
        id: "messages",
        name: "Messages",
        tokens: 3_331,
        kind: "used" as const,
      },
    ];
    const fresh = crumbMeter(
      held({}, { categories: { rows, measuredAt: 1_000 } }),
      undefined,
    );
    expect(fresh.categories).toEqual(rows);
    expect(fresh.categoriesStale).toBe(false);
    expect(
      crumbMeter(held({}, { categories: { rows, measuredAt: 1_000 } }), live())
        .categoriesStale,
    ).toBe(true);
    expect(
      crumbMeter(
        held({ breakdown: { _tag: "none", reason: "harness_gives_none" } }),
        undefined,
      ).missing,
    ).toBe("harness_gives_none");
  });

  test("a category's share is of the window, and nothing without one", () => {
    expect(shareOf(10_722, 200_000)).toBe("5%");
    expect(shareOf(108, 200_000)).toBe("<1%");
    expect(shareOf(108, null)).toBe("");
  });

  test("a reading's figure that may be the model before a switch is no baseline for a live call (A6 U9 review)", () => {
    // Sonnet-5's 31,603, read back under haiku's window, then haiku's own first call.
    const switched = held(
      { used: 31_603 },
      { previousUsed: null, usedBeforeSwitch: true },
    );
    expect(
      crumbMeter(switched, live({ promptTokens: 24_507, outputTokens: 0 }))
        .droppedFrom,
    ).toBeNull();
    // The same drop on one model is a compaction.
    expect(
      crumbMeter(held({ used: 31_603 }), live({ promptTokens: 24_507 }))
        .droppedFrom,
    ).toBe(31_603);
  });

  test("the footer says what the reading was taken after, and a live call says it is one (A6 U9 review)", () => {
    const after = (cause: ImporterContext["cause"]) =>
      crumbSource(
        crumbMeter(held({}, cause === undefined ? {} : { cause }), undefined),
      );
    expect(after("turn")).toBe("Read after the last turn");
    expect(after("stop")).toBe("Read after the Stop");
    expect(after("switch")).toBe("Read after the model switch");
    expect(after("asked")).toBe("Read on opening this panel");
    expect(after("opened")).toBe("Read on opening the session");
    expect(after(undefined)).toBe("Read on opening the session");
    const fromLive = crumbMeter(held({}, { cause: "turn" }), live());
    expect(fromLive.cause).toBeNull();
    expect(crumbSource(fromLive)).toBe("From the latest model call");
  });
});
