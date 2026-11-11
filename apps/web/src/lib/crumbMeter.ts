/**
 * The crumb bar's context meter (A6 U9, D3), decided here so it can be tested without a
 * browser: a ring and a token count, and what the popover under it says.
 *
 * Two sources, and the newer wins for the figure:
 *
 * - **The server's reading** (`ConversationContext`), asked on opening a session, after each
 *   turn and after a model switch. It has the window of the model the session is on now,
 *   and — on Claude Code, when asked — the categories.
 * - **The live feed's per-call frame** (`LiveUsage`), pushed by the server on each model
 *   call of a running turn. Newer than the reading mid-turn; never summed, only the latest.
 *
 * Neither is a spend total: both are the last model call's tokens sent plus generated
 * (DECISIONS.md §24.4), so taking the newer is choosing between two measurements of the
 * same thing at different times.
 *
 * **Each figure says which model measured it** (`usedModel` on the reading, `model` on the
 * live frame), and the meter trusts that and guesses nothing (A6 U9 review 2): two figures
 * are compared for a drop only when they were measured on one model, and the categories are
 * shown only under a reading of the window they were counted on.
 */
import type {
  ContextBreakdownMissing,
  ContextCategory,
  ContextReading,
  LiveUsage,
} from "@bit/contracts";
import { sameModel, sameWindow } from "@bit/contracts";

import type {
  ContextReadCause,
  ImporterContext,
} from "./importerSessions.svelte";
import { groupDigits } from "./chat";

/** What the meter draws. */
export interface CrumbMeter {
  /** Tokens in the window on the last measured call, or `null` when none is measured. */
  readonly used: number | null;
  /** The window of the model the session is on now, or `null` where no one said. */
  readonly window: number | null;
  /** `used` over `window`, 0–1 and clamped, or `null` without both. */
  readonly fraction: number | null;
  /** {@link fraction} as a whole percentage, or `null`. */
  readonly percent: number | null;
  /**
   * What {@link used} is: `none` for a session with no reading at all — the empty session
   * before its first message, or one whose reading has not come back yet.
   */
  readonly reading: ContextReading | "none";
  /** Where {@link used} came from: the last reading (`turn`) or a live call since (`live`). */
  readonly source: "turn" | "live" | null;
  /** The model the window belongs to, or `null` with no reading. */
  readonly model: string | null;
  /**
   * The model whose call measured {@link used}, as the harness spells it, or `null` where
   * nothing said. Another model than {@link model} after a switch, until the next call.
   */
  readonly usedModel: string | null;
  /**
   * The categories, when the harness last counted them on {@link model}'s window; `null`
   * when it never did, or counted another model's.
   */
  readonly categories: readonly ContextCategory[] | null;
  /** Whether {@link categories} were counted before {@link used} was measured. */
  readonly categoriesStale: boolean;
  /** When {@link categories} were counted, in epoch milliseconds, or `null` without them. */
  readonly categoriesAt: number | null;
  /** Why there are no categories, from the latest reading; `null` when there are some. */
  readonly missing: ContextBreakdownMissing | null;
  /**
   * The figure before a drop, when the window shrank since the figure before on the same
   * model — a compaction — or the reading says the conversation was summarised. `null`
   * otherwise.
   */
  readonly droppedFrom: number | null;
  /** When {@link used} was measured, in epoch milliseconds, or `null`. */
  readonly at: number | null;
  /** What made the tab take the reading, for a figure from one (`source` `turn`). */
  readonly cause: ContextReadCause | null;
}

/**
 * How much smaller a figure must be than the one before it to be told as a drop. Context
 * only grows within a conversation but for a compaction. Figures from two models are never
 * compared (`sameModel`): their tokenizers differ by far more than this (haiku-4-5 reads
 * about 22 % below sonnet-5 on one conversation, measured).
 */
// V2(chat): V1 tells a compaction by the reading's `compacted` or by a drop of over 10 %
// against the figure this tab last held, which a reload forgets. V2 should carry the
// harness's own compaction events (Claude Code's `compact_boundary` with its pre/post token
// counts, OpenCode's `compaction` message) on the reading, so the drop is stated, not inferred.
const DROP = 0.9;

/** The meter for one session, from its reading and the newest live call frame. */
export const crumbMeter = (
  context: ImporterContext | undefined,
  live: LiveUsage | undefined,
): CrumbMeter => {
  const reading = context?.reading;
  const liveNewer =
    live !== undefined &&
    (reading === undefined || live.at > reading.measuredAt);
  const used = liveNewer
    ? live.promptTokens + (live.outputTokens ?? 0)
    : (reading?.used ?? null);
  /*
   * A live call on a model the reading knows nothing of: the session was moved to it after
   * the reading, from another client (A6 U9 review 4), so the reading's window and model are
   * the old model's. Not a late frame of the call that was running when this tab's own
   * switch landed: that one is on the model the reading's figure was measured on
   * (`usedModel`), and the reading — asked again on the switch — has the new window.
   */
  const movedSince =
    liveNewer &&
    reading !== undefined &&
    live.model !== null &&
    live.model !== "" &&
    !sameModel(live.model, reading.model) &&
    !sameModel(live.model, reading.usedModel);
  // The reading's window first: it is asked again on a switch, so it is the new model's.
  const window = movedSince
    ? positive(live.contextLimit)
    : (positive(reading?.window ?? null) ??
      (live === undefined ? null : positive(live.contextLimit)));
  const model = movedSince ? live.model : (reading?.model ?? null);
  const fraction =
    used === null || window === null ? null : clamp(used / window);
  // V2(chat): after a switch V1 draws the old model's last call over the new model's
  // window until the next call, and says so in the popover (`usedModel`): the ring is off
  // by the tokenizers' gap (~22 % between haiku-4-5 and sonnet-5) for that while. V2 could
  // have the harness count the window on the new model at the switch, where it can.
  const usedModel = liveNewer ? live.model : (reading?.usedModel ?? null);
  // The figure before this one: the reading's, under a newer live call, else the one the
  // tab held before the reading. Whatever its model — it is compared only on the same one.
  const prior =
    liveNewer && reading !== undefined && reading.used !== null
      ? { used: reading.used, model: reading.usedModel }
      : (context?.previous ?? null);
  const kind: CrumbMeter["reading"] = liveNewer
    ? "measured"
    : (reading?.reading ?? "none");
  const droppedFrom =
    prior !== null &&
    (kind === "compacted" ||
      (used !== null &&
        sameModel(usedModel, prior.model) &&
        used < prior.used * DROP))
      ? prior.used
      : null;
  // The newest count, only under a reading of the window it was counted on.
  const categories = sameWindow(context?.categories?.model, model)
    ? context?.categories
    : undefined;
  const at = liveNewer ? live.at : (reading?.measuredAt ?? null);
  return {
    used,
    window,
    fraction,
    percent: fraction === null ? null : Math.round(fraction * 100),
    reading: kind,
    source: liveNewer ? "live" : reading === undefined ? null : "turn",
    model,
    usedModel,
    categories: categories?.rows ?? null,
    categoriesStale:
      categories !== undefined && at !== null && categories.measuredAt < at,
    categoriesAt: categories?.measuredAt ?? null,
    missing:
      reading === undefined || reading.breakdown._tag === "categories"
        ? null
        : reading.breakdown.reason,
    droppedFrom,
    at,
    cause: liveNewer || reading === undefined ? null : (context?.cause ?? null),
  };
};

/**
 * The popover's footer, before the time: where the figure came from. A reading is worded
 * by what made the tab take it, so one taken on opening the meter mid-turn does not claim
 * a turn ended (A6 U9 review).
 */
export const crumbSource = (
  meter: CrumbMeter,
  /** What a model is called on screen (`modelNames.ts`); the id when absent. */
  name: (model: string) => string = (model) => model,
): string => {
  if (meter.source === "live") return "From the latest model call";
  switch (meter.cause) {
    case "turn":
      return "Read after the last turn";
    case "stop":
      return "Read after the Stop";
    case "switch":
      return "Read after the model switch";
    case "asked":
      return "Read on opening this panel";
    case "recount":
      return meter.model === null || meter.model === ""
        ? "Recounted after the model switch"
        : `Recounted for ${name(meter.model)}`;
    default:
      return "Read on opening the session";
  }
};

const positive = (value: number | null): number | null =>
  value !== null && Number.isFinite(value) && value > 0 ? value : null;

const clamp = (value: number): number => Math.max(0, Math.min(1, value));

/** The count beside the ring: the figure, or `0` where nothing is measured yet (D3's D1). */
export const crumbFigure = (meter: CrumbMeter): string =>
  meter.used === null ? "0" : groupDigits(meter.used);

/**
 * The button's accessible name and title, as D3 words its tooltip: "Session context ·
 * 24,106 of 200,000 tokens". Says in words what the ring only draws.
 */
export const crumbLabel = (meter: CrumbMeter): string => {
  const what = "Session context";
  if (meter.used === null) {
    switch (meter.reading) {
      case "compacted":
        return `${what} · summarised, measured again on the next model call`;
      case "unread":
        return `${what} · not measured`;
      case "gone":
        return `${what} · session gone`;
      default:
        return `${what} · no tokens used yet`;
    }
  }
  const used = groupDigits(meter.used);
  return meter.window === null
    ? `${what} · ${used} tokens`
    : `${what} · ${used} of ${groupDigits(meter.window)} tokens`;
};

/** The ring's circumference at D3's radius of 9 on a 24-unit box. */
const RING = 2 * Math.PI * 9;

/**
 * The filled arc as a `stroke-dasharray`: D3's `6.8 49.7` for 12 %. `null` draws the track
 * alone — no window, or nothing measured — because an arc is a fraction and there is none.
 * A real figure too small to see still gets a sliver, so "used" never reads as "empty".
 */
export const ringDash = (fraction: number | null): string | null => {
  if (fraction === null) return null;
  const filled = fraction === 0 ? 0 : Math.max(0.8, fraction * RING);
  return `${filled.toFixed(1)} ${(RING - filled).toFixed(1)}`;
};

/**
 * One category's share, as the popover writes it: of the window where there is one, else
 * nothing (a share of an unknown is not a number).
 */
export const shareOf = (tokens: number, window: number | null): string => {
  if (window === null) return "";
  const share = (tokens / window) * 100;
  if (share > 0 && share < 1) return "<1%";
  return `${String(Math.round(share))}%`;
};
