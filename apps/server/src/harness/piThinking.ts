/**
 * Pi's thinking level as a model option (follow-ups A, 2026-11-11): which levels a model
 * offers, the descriptor the picker shows, and the value a session is started or switched
 * with.
 *
 * ## Which levels, and why they are worked out here
 *
 * Pi answers `get_available_thinking_levels` for the *current* model of a running process
 * only, so asking it per model would mean a `set_model` per catalogue entry. Its catalogue
 * (`get_available_models`) carries what that answer is computed from instead — each model's
 * `reasoning` flag and `thinkingLevelMap` — and this module applies Pi's own rule to them,
 * `getSupportedThinkingLevels` in `@earendil-works/pi-ai` (1.5.2, `dist/models.js`):
 *
 * - a model without `reasoning` offers only `off`, which is no choice at all, so it gets no
 *   descriptor;
 * - otherwise every level of the ladder whose map entry is not `null`, except that `xhigh`
 *   and `max` need an entry of their own (absent is unsupported for those two only).
 *
 * Measured against the real process (`piClient.test.ts`): a model mapped `{ off: null,
 * minimal: null, medium: null }` answers `["low", "high"]`, and so does this.
 *
 * ## The default choice
 *
 * "Pi's default" is what Pi starts a session at when told nothing: its settings'
 * per-model level, else its default level, else `medium`, clamped to what the model offers.
 * bit never reads Pi's settings, so it cannot name that level; at a start it simply passes
 * no `--thinking`. A live switch back to it asks Pi itself (`piClient.ts`, `defaultLevel`).
 */
import {
  MODEL_OPTION_DEFAULT_CHOICE,
  type ModelOptionDescriptor,
  type ModelOptionSelection,
} from "@bit/contracts";

/** The option id a selection names: Pi's own word for it (`get_state.thinkingLevel`). */
export const PI_THINKING_OPTION = "thinkingLevel";

/** Pi's ladder, lowest first (`EXTENDED_THINKING_LEVELS`). */
export const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

const LABELS: Readonly<Record<PiThinkingLevel, string>> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
};

export const isPiThinkingLevel = (value: unknown): value is PiThinkingLevel =>
  typeof value === "string" &&
  (PI_THINKING_LEVELS as readonly string[]).includes(value);

/**
 * The levels one catalogue entry offers, by Pi's rule; `[]` for a model that does not
 * reason (Pi says `["off"]`, which is nothing to choose).
 */
export const piThinkingLevels = (model: {
  readonly reasoning?: unknown;
  readonly thinkingLevelMap?: unknown;
}): readonly PiThinkingLevel[] => {
  if (model.reasoning !== true) return [];
  const map =
    typeof model.thinkingLevelMap === "object" &&
    model.thinkingLevelMap !== null
      ? (model.thinkingLevelMap as Readonly<Record<string, unknown>>)
      : {};
  return PI_THINKING_LEVELS.filter((level) => {
    const mapped = map[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
};

/** The descriptor for a model offering `levels`; `undefined` when it offers none. */
export const piThinkingDescriptor = (
  levels: readonly PiThinkingLevel[],
): ModelOptionDescriptor | undefined =>
  levels.length === 0
    ? undefined
    : {
        id: PI_THINKING_OPTION,
        label: "Thinking",
        type: "select",
        options: [
          // Never sent as a level: see this module's header.
          {
            id: MODEL_OPTION_DEFAULT_CHOICE,
            label: "Pi's default",
            isDefault: true,
          },
          ...levels.map((level) => ({ id: level, label: LABELS[level] })),
        ],
      };

/**
 * The level one session is asked to run at, from the resolved selections: `undefined` for
 * the default choice and for none, which Pi is told by being told nothing.
 */
export const piThinkingOf = (
  options: readonly ModelOptionSelection[] | undefined,
): PiThinkingLevel | undefined => {
  const value = options?.find(
    (option) => option.id === PI_THINKING_OPTION,
  )?.value;
  return isPiThinkingLevel(value) ? value : undefined;
};
