/**
 * The crumb bar's context meter, decided without a browser (A6 U9, D3): which figure it
 * draws when the server's reading and the live feed's call frame disagree, what the ring
 * fills to, and when it says the window shrank.
 */
import { describe, expect, test } from "bun:test";

import type { ConversationContext, LiveUsage } from "@bit/contracts";
import { modelKey, sameModel, sameWindow } from "@bit/contracts";

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
  // As the API spells haiku-4-5's calls (measured, CLI 2.1.310).
  usedModel: "claude-haiku-4-5-20251001",
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
  previous: null,
  ...extra,
});

const live = (over: Partial<LiveUsage> = {}): LiveUsage => ({
  _tag: "usage",
  callId: "msg_1",
  promptTokens: 30_000,
  outputTokens: 120,
  contextLimit: 200_000,
  compactionAt: null,
  model: "claude-haiku-4-5-20251001",
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
        {
          used: null,
          usedModel: null,
          reading: "compacted",
          measuredAt: 5_000,
        },
        { previous: { used: 118_204, model: "claude-haiku-4-5-20251001" } },
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
      held(
        { used: 40_000 },
        { previous: { used: 118_204, model: "claude-haiku-4-5-20251001" } },
      ),
      undefined,
    );
    expect(after.droppedFrom).toBe(118_204);
    // A model recounting the same conversation a little smaller is not a compaction.
    expect(
      crumbMeter(
        held(
          { used: 23_500 },
          { previous: { used: 24_106, model: "claude-haiku-4-5-20251001" } },
        ),
        undefined,
      ).droppedFrom,
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
      held(
        {},
        { categories: { rows, measuredAt: 1_000, model: "claude-haiku-4-5" } },
      ),
      undefined,
    );
    expect(fresh.categories).toEqual(rows);
    expect(fresh.categoriesStale).toBe(false);
    expect(
      crumbMeter(
        held(
          {},
          {
            categories: { rows, measuredAt: 1_000, model: "claude-haiku-4-5" },
          },
        ),
        live(),
      ).categoriesStale,
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

  test("after a reload, a reading of the old model's figure is no baseline for the new model's call (U9 review 2)", () => {
    // Repro 1: sonnet-5 at 31,842, switched to haiku-4-5, reloaded before haiku's first
    // call. The reading is haiku's window over sonnet's last call; haiku then reads 25,405.
    const reloaded = held({
      model: "claude-haiku-4-5",
      used: 31_842,
      usedModel: "claude-sonnet-5",
    });
    const meter = crumbMeter(
      reloaded,
      live({ promptTokens: 25_405, outputTokens: 0 }),
    );
    expect(meter.used).toBe(25_405);
    expect(meter.droppedFrom).toBeNull();
    // And the turn-end reading after it, told against the reading before (sonnet's).
    expect(
      crumbMeter(
        held(
          { used: 25_405 },
          { previous: { used: 31_842, model: "claude-sonnet-5" } },
        ),
        undefined,
      ).droppedFrom,
    ).toBeNull();
  });

  test("a live call the old model finished after a switch is no baseline either (U9 review 2)", () => {
    // Repro 2: a sonnet-5 call running when the switch to haiku-4-5 landed ends on sonnet
    // (36,464), and the Stop's reading is labelled so; haiku's next call reads 28,406.
    const stopped = held({
      model: "claude-haiku-4-5",
      used: 36_464,
      usedModel: "claude-sonnet-5",
    });
    expect(
      crumbMeter(stopped, live({ promptTokens: 28_406, outputTokens: 0 }))
        .droppedFrom,
    ).toBeNull();
    // The late sonnet frame itself, newer than a haiku reading: not compared either.
    expect(
      crumbMeter(
        held({ used: 20_000 }),
        live({ promptTokens: 36_464, model: "claude-sonnet-5" }),
      ).droppedFrom,
    ).toBeNull();
    // A frame or reading that names no model is compared with nothing.
    expect(
      crumbMeter(held({ used: 60_000 }), live({ model: null })).droppedFrom,
    ).toBeNull();
  });

  test("a drop on one model is a compaction, however the model is spelt (U9 review 2)", () => {
    // A live call far below the reading, mid-turn: the harness compacted on its own.
    expect(
      crumbMeter(
        held({ used: 31_603 }),
        live({ promptTokens: 24_507, model: "claude-haiku-4-5" }),
      ).droppedFrom,
    ).toBe(31_603);
    // A reading told against the figure before it on the same model.
    expect(
      crumbMeter(
        held(
          { used: 40_000, usedModel: "claude-sonnet-5" },
          { previous: { used: 118_204, model: "claude-sonnet-5" } },
        ),
        undefined,
      ).droppedFrom,
    ).toBe(118_204);
  });

  test("the figure says which model measured it", () => {
    expect(crumbMeter(held(), undefined).usedModel).toBe(
      "claude-haiku-4-5-20251001",
    );
    expect(
      crumbMeter(held(), live({ model: "claude-sonnet-5" })).usedModel,
    ).toBe("claude-sonnet-5");
  });

  test("categories of another model's window are not shown (U9 review 2)", () => {
    const rows = [
      {
        id: "free_space",
        name: "Free space",
        tokens: 937_064,
        kind: "free" as const,
      },
    ];
    // Sonnet-5's rows under haiku-4-5's window: 469 % free, measured before the fix.
    const other = crumbMeter(
      held(
        {},
        { categories: { rows, measuredAt: 1_000, model: "claude-sonnet-5" } },
      ),
      undefined,
    );
    expect(other.categories).toBeNull();
    expect(other.categoriesAt).toBeNull();
    // Why there are none comes from the reading: not asked on this model yet.
    expect(other.missing).toBe("not_asked");
    // One model in another window: the `[1m]` variant's free space is not the plain one's
    // (U9 review 3). The same model's dated spelling is the same window.
    const wider = (counted: string, window: string) =>
      crumbMeter(
        held(
          { model: window },
          { categories: { rows, measuredAt: 1_000, model: counted } },
        ),
        undefined,
      ).categories;
    expect(wider("claude-sonnet-5[1m]", "claude-sonnet-5")).toBeNull();
    expect(wider("claude-sonnet-5", "claude-sonnet-5[1m]")).toBeNull();
    expect(wider("claude-sonnet-5[1m]", "claude-sonnet-5[1M]")?.length).toBe(1);
    expect(wider("claude-haiku-4-5-20251001", "claude-haiku-4-5")?.length).toBe(
      1,
    );
  });
});

describe("one model, whatever the spelling (U9 review 2)", () => {
  test("a release date and a bracketed variant are not part of the model", () => {
    // Observed 2026-11-05, CLI 2.1.310: frames date haiku-4-5 and not sonnet-5.
    expect(sameModel("claude-haiku-4-5-20251001", "claude-haiku-4-5")).toBe(
      true,
    );
    expect(sameModel("claude-sonnet-5", "claude-sonnet-5")).toBe(true);
    expect(sameModel("claude-sonnet-5[1m]", "claude-sonnet-5")).toBe(true);
    expect(sameModel("claude-haiku-4-5@20251001", "Claude-Haiku-4-5")).toBe(
      true,
    );
    expect(modelKey("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    // OpenCode's provider/model is compared whole.
    expect(
      sameModel(
        "zai-coding-plan/glm-5.3-flash",
        "zai-coding-plan/glm-5.3-flash",
      ),
    ).toBe(true);
    expect(
      sameModel("zai-coding-plan/glm-5.3-flash", "opencode/glm-5.3-flash-free"),
    ).toBe(false);
  });

  test("different models, and a model nobody stated, are not one", () => {
    expect(sameModel("claude-haiku-4-5-20251001", "claude-sonnet-5")).toBe(
      false,
    );
    expect(sameModel("claude-sonnet-4-5", "claude-sonnet-5")).toBe(false);
    // A version number is not a date: 4-5 and 4-6 differ.
    expect(sameModel("claude-haiku-4-5", "claude-haiku-4-6")).toBe(false);
    expect(sameModel(null, "claude-sonnet-5")).toBe(false);
    expect(sameModel(undefined, undefined)).toBe(false);
    expect(sameModel("", "")).toBe(false);
  });

  test("one window: the same model, and the same bracketed variant (U9 review 3)", () => {
    expect(sameWindow("claude-sonnet-5[1m]", "claude-sonnet-5")).toBe(false);
    expect(sameWindow("claude-sonnet-5[1m]", "Claude-Sonnet-5[1M]")).toBe(true);
    expect(sameWindow("claude-haiku-4-5-20251001", "claude-haiku-4-5")).toBe(
      true,
    );
    expect(sameWindow("claude-haiku-4-5", "claude-sonnet-5")).toBe(false);
    expect(sameWindow(null, null)).toBe(false);
  });
});

describe("the crumb bar's context meter footer (A6 U9)", () => {
  test("the footer says what the reading was taken after, and a live call says it is one (A6 U9 review)", () => {
    const after = (cause: ImporterContext["cause"]) =>
      crumbSource(
        crumbMeter(held({}, cause === undefined ? {} : { cause }), undefined),
      );
    expect(after("turn")).toBe("Read after the last turn");
    expect(after("stop")).toBe("Read after the Stop");
    expect(after("switch")).toBe("Read after the model switch");
    expect(after("asked")).toBe("Read on opening this panel");
    // The open meter's own count of a window it had no rows for, after a switch.
    expect(
      crumbSource(
        crumbMeter(
          held({ model: "claude-sonnet-5" }, { cause: "recount" }),
          undefined,
        ),
      ),
    ).toBe("Recounted for claude-sonnet-5");
    expect(after("opened")).toBe("Read on opening the session");
    expect(after(undefined)).toBe("Read on opening the session");
    const fromLive = crumbMeter(held({}, { cause: "turn" }), live());
    expect(fromLive.cause).toBeNull();
    expect(crumbSource(fromLive)).toBe("From the latest model call");
  });
});
