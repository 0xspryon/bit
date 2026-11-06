/**
 * What a model offers beyond its name, what an operator picked of it, and the rules that
 * get from one to the other.
 *
 * ## Two sides, deliberately not one
 *
 * A **descriptor** is what the harness says a model can be asked for: an id, a label, and
 * the choices. A **selection** is what an operator picked: an id and a value. They are
 * kept apart because they have different lifetimes and different owners — a descriptor is
 * observed when the server built the harness and is replaced wholesale when it is rebuilt,
 * while a selection is the operator's and survives a model change, a reconnect and a
 * reload. Collapsing them into one "current option" object is how a remembered choice
 * starts being presented as a capability, and a capability starts being remembered as a
 * choice. The shape is T3Code's (`packages/contracts/src/model.ts`,
 * `packages/shared/src/model.ts`), adopted rather than invented, for the same reason the
 * identity triple was.
 *
 * ## Reasoning depth is not a field here, and that is the point
 *
 * There is no `reasoningLevel` on a run. Reasoning depth is **one `select` descriptor
 * among others**, and its id is the harness's rather than ours: OpenCode calls the thing
 * a model *variant* and names its levels `low`/`medium`/`high`/`xhigh`/`max` or
 * `none`/`thinking` depending on the provider protocol, while the Claude Agent SDK calls
 * it `effort` with its own five levels. T3Code enumerates six spellings in the wild
 * (`reasoningEffort`, `effort`, `reasoning`, `variant`, `reasoning_effort`, `thinking`).
 * A column named after one of them would have to be rebuilt the first time a second kind
 * of option arrives, and a general options mechanism costs the same today.
 *
 * ## Only `select`, and `type` is still on the descriptor
 *
 * Both harnesses offer enumerable levels, so `select` is the only descriptor type this
 * server can fill honestly and it is the only one defined. `type` is nonetheless a field
 * rather than an assumption: T3Code's second type is `boolean`, the Claude Agent SDK's
 * `thinking: { type: "enabled", budgetTokens }` is a *number* and not a level, and either
 * arriving should add a member to a union here rather than reinterpret what `options`
 * means. A descriptor with no type would have made that a breaking change.
 *
 * ## The rules
 *
 * Every rule below is implemented once, in this file, and used by both the picker and the
 * supervisor — because a browser that normalised differently from the server would show
 * an operator one thing and run another.
 *
 * 1. **Resolution maps over descriptors, never over selections.** A selection whose id no
 *    model descriptor matches is dropped. That is not a failure case; it is how switching
 *    to a model with different options works at all.
 * 2. **A value matching no choice falls back** to the descriptor's `currentValue`, else
 *    its default-marked choice. It is neither an error nor persisted as itself.
 * 3. **Only what the operator explicitly set is dispatched.** A descriptor's default is
 *    shown but never sent, and the selection list is *absent* rather than empty when
 *    nothing was set — "no opinion" and "an opinion that happens to match the default"
 *    reach the harness differently, and only the first lets the harness change its mind.
 * 4. **Display deliberately bypasses rule 2.** {@link displayedModelOption} shows an
 *    obsolete value *as itself*, marked unknown. Relabelling it as the catalogue default
 *    would tell an operator something false about what is about to run, and this is the
 *    one place in the pipeline where the un-normalised value is the honest one.
 *
 * What rule 1 costs is {@link droppedModelOptionIds}: the drop is silent in T3Code, which
 * makes "I chose this and the model does not offer it" indistinguishable from "I never
 * chose anything". This product loses information out loud, so the ids are returned and
 * the picker says so.
 */
import { Schema } from "effect";

/**
 * The one choice id that is not a harness value: "whatever the model would do".
 *
 * It exists because an operator who picked `high` needs a way back, and a list with no
 * row for the default state would make that an invisible gesture. Each harness translates
 * it at the edge — OpenCode's own API already uses this spelling as its no-variant
 * sentinel, and the Claude Code client drops the option rather than sending a level — so
 * the string never reaches a provider as if it were a reasoning level.
 */
export const MODEL_OPTION_DEFAULT_CHOICE = "default";

/** One thing a {@link ModelOptionDescriptor} can be set to. */
export const ModelOptionChoice = Schema.Struct({
  /** What the harness takes, verbatim. Never a display string. */
  id: Schema.NonEmptyString,
  /** What the picker shows. Never an identity. */
  label: Schema.NonEmptyString,
  /**
   * Whether this is what the model does when nothing is chosen.
   *
   * At most one choice per descriptor carries it. It drives what the picker *shows* as
   * current; it never makes a value get dispatched (rule 3).
   */
  isDefault: Schema.optional(Schema.Boolean),
});
export type ModelOptionChoice = typeof ModelOptionChoice.Type;

/**
 * One thing a model can be asked for, as the harness reported it.
 *
 * `id` is the harness's own name for the option — `variant` on OpenCode, `effort` on
 * Claude Code — and is what a selection names. Nothing in this application maps those two
 * onto a shared vocabulary: a run carries the id the harness gave, so the value cannot be
 * delivered to the wrong field by a translation layer that guessed.
 */
export const ModelOptionDescriptor = Schema.Struct({
  id: Schema.NonEmptyString,
  /** For the operator's screen: "Reasoning". */
  label: Schema.NonEmptyString,
  /** See this module's header on why a single-member union is still a union. */
  type: Schema.Literal("select"),
  options: Schema.Array(ModelOptionChoice),
  /**
   * What the harness says the model is set to now, when it says anything.
   *
   * Takes precedence over the default-marked choice in rule 2. Absent on both harnesses
   * today: neither reports a per-model current value, and a value invented here would be
   * a claim about the provider's state that nothing observed.
   */
  currentValue: Schema.optional(Schema.NonEmptyString),
});
export type ModelOptionDescriptor = typeof ModelOptionDescriptor.Type;

/** What an operator picked. One id, one value, and nothing about what was offered. */
export const ModelOptionSelection = Schema.Struct({
  id: Schema.NonEmptyString,
  value: Schema.NonEmptyString,
});
export type ModelOptionSelection = typeof ModelOptionSelection.Type;

/**
 * One model an instance offers, and what it offers about itself.
 *
 * `models` used to be an array of names. It is an array of these because the descriptors
 * belong *to the model* — OpenCode reports variants per model and two models of the same
 * provider genuinely differ — and a side table keyed by model name would have been a
 * second place to keep in step, free to hold options for a model the instance does not
 * list.
 */
export const HarnessModelView = Schema.Struct({
  /** What a run names, in the form the harness takes it. */
  id: Schema.NonEmptyString,
  /**
   * What this model can be asked for beyond itself.
   *
   * Absent and empty mean the same thing and both are the common case: most models offer
   * nothing, and a model whose catalogue entry could not be read offers nothing *as far
   * as we know*, which is the same answer for the picker's purposes.
   */
  optionDescriptors: Schema.optional(Schema.Array(ModelOptionDescriptor)),
  /**
   * How many tokens of context this model takes, when the harness says so **before a
   * session exists**.
   *
   * The denominator of the context meter, and the whole reason it is on the model view
   * rather than on a session: OpenCode's `GET /api/model` carries `limit` on every
   * catalogue entry, and this application already reads that catalogue for the picker
   * (DECISIONS.md §24.4 measured all 27 entries), so the limit is known before anything
   * runs.
   *
   * **Absent on Claude Code, and that is a fact about Claude Code rather than a gap here.**
   * Its model list (`ModelInfo`) has no context-window field at all; the only figure is
   * `query.getContextUsage().maxTokens`, which exists once a *session* does and is this
   * account's answer for the model as that session resolved it. Writing it down here would
   * be a constant pretending to be an observation, so it rides the session instead — see
   * `NarrationDetail`'s `usage` case.
   *
   * **It is `limit.context`, deliberately, not `limit.input`.** OpenCode publishes both and
   * they differ (400 000 against 272 000 on bit's own default model): `limit.context` is
   * the window the provider accepts, which is what a *fullness* meter is a fraction of and
   * what OpenCode's own TUI meter divides by. `limit.input` is the smaller figure, and it is
   * the one OpenCode's **own compaction** measures itself against — so a meter over it would
   * be reporting how close the harness is to rewriting the session rather than how full the
   * context is, which are two different questions an operator asks at two different moments.
   *
   * **That harness does rewrite the session, and this field is not where that is said** —
   * {@link compactionAt} is. An earlier version of this comment said "this application does
   * not compact, so it has no use for the trigger", which was false in the way that matters:
   * bit never *calls* compaction and OpenCode compacts anyway, by default, well before this
   * window fills. A denominator chosen on the strength of that sentence would have been a
   * meter that implies nothing happens until it reads 100 %.
   *
   * Absent when the catalogue could not be read, for `optionDescriptors`' reason: a model
   * whose entry is unavailable states no limit *as far as we know*, and the meter then
   * shows tokens with no percentage rather than a fraction of a guess.
   */
  contextLimit: Schema.optional(Schema.Int),
  /**
   * The context size at which the **harness itself** will summarise the session, when its
   * own policy states one.
   *
   * ## Why a meter needs this to be honest
   *
   * {@link contextLimit} is how much the provider accepts; this is the point at which
   * something happens to the conversation without anybody asking. On bit's own default
   * model the two are 400 000 and ~231 200 — so a bar drawn against the window alone passes
   * **58 %** and the session is silently rewritten underneath it. A meter that showed only
   * the window would be accurate about the window and misleading about the thing an
   * operator would actually act on, which is the failure this whole slice was most at risk
   * of.
   *
   * ## It is derived from the harness's source, not reported by the harness
   *
   * Nothing on the wire states it. It is OpenCode 2.2.2's own default policy, read out of
   * `packages/core/src/session/compaction.ts` and reproduced in `openCodeClient.ts`:
   * automatic compaction starts `auto: true` (line 200) and fires when the estimated
   * context reaches `(limit.input || limit.context) − max(15 % of it, 16 000)` (line 849,
   * `RESERVE_SHARE`/`RESERVE_MIN`). bit writes no `compaction` key into any OpenCode config
   * — it writes no OpenCode config at all since the policy gate went (2026-11-06) — so the
   * default is what applies.
   *
   * **So it is an estimate of somebody else's threshold, and three things can move it
   * without moving this number:** an `opencode.json` at or above the session's directory
   * setting `compaction.auto: false` or its own `buffer` (DECISIONS.md §24.3 measured that
   * configuration is inherited from *every* ancestor directory, not just the project), and
   * an `opencode` upgrade changing either constant. A consumer must present it as "where
   * the harness says it will act", never as a measurement, and must not compute anything
   * from the difference between it and a token count.
   *
   * **Absent for Claude Code**, like {@link contextLimit} and for a sibling reason: its
   * `getContextUsage()` breakdown does carry `autocompact_buffer` and `compact_buffer`
   * categories, so a threshold exists there too — but this build reads only `maxTokens` off
   * that response and has measured nothing about when the CLI acts on those buffers.
   * Deriving a number from an unmeasured policy is the thing the paragraph above forbids.
   */
  compactionAt: Schema.optional(Schema.Int),
});
export type HarnessModelView = typeof HarnessModelView.Type;

/** The descriptors of one model, with absence and emptiness collapsed. */
export const modelOptionDescriptors = (
  model: HarnessModelView | undefined,
): readonly ModelOptionDescriptor[] => model?.optionDescriptors ?? [];

/** What the descriptor falls back to: the harness's current value, else its default. */
const fallbackChoiceId = (
  descriptor: ModelOptionDescriptor,
): string | undefined =>
  descriptor.currentValue ??
  descriptor.options.find((choice) => choice.isDefault === true)?.id;

const choiceOf = (
  descriptor: ModelOptionDescriptor,
  id: string | undefined,
): ModelOptionChoice | undefined =>
  id === undefined
    ? undefined
    : descriptor.options.find((choice) => choice.id === id);

/** What a selection names for one descriptor, un-normalised. */
export const selectedModelOptionValue = (
  selections: readonly ModelOptionSelection[],
  id: string,
): string | undefined =>
  selections.find((selection) => selection.id === id)?.value;

/**
 * Rule 2: the value a raw one resolves to against one descriptor.
 *
 * A descriptor with no choices accepts whatever it is given — that is an open option the
 * harness validates, not a closed list we can check against — and anything else outside
 * the list falls back rather than failing.
 */
export const resolveModelOptionValue = (
  descriptor: ModelOptionDescriptor,
  raw: string | undefined,
): string | undefined => {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return fallbackChoiceId(descriptor);
  if (descriptor.options.length === 0) return trimmed;
  return descriptor.options.some((choice) => choice.id === trimmed)
    ? trimmed
    : fallbackChoiceId(descriptor);
};

/**
 * Rules 1, 2 and 3 together: what a run should carry.
 *
 * Mapped over the *descriptors*, so a selection the model knows nothing about never
 * reaches the harness (1). Each surviving value is normalised (2). A descriptor the
 * operator did not set is skipped rather than filled with its default (3), and an empty
 * result is `undefined` rather than `[]` so "nothing was set" is absent on the wire.
 */
export const explicitModelOptionSelections = (
  descriptors: readonly ModelOptionDescriptor[],
  selections: readonly ModelOptionSelection[],
): readonly ModelOptionSelection[] | undefined => {
  const dispatched: ModelOptionSelection[] = [];
  for (const descriptor of descriptors) {
    const raw = selectedModelOptionValue(selections, descriptor.id);
    if (raw === undefined) continue;
    const value = resolveModelOptionValue(descriptor, raw);
    if (value !== undefined) dispatched.push({ id: descriptor.id, value });
  }
  return dispatched.length === 0 ? undefined : dispatched;
};

/** What the picker shows for one descriptor. See rule 4. */
export interface ModelOptionDisplay {
  /** The value to mark as current in the list, which may be in no choice. */
  readonly value: string | undefined;
  /** What to render: the choice's label, or the stale value as itself. */
  readonly label: string;
  /** Whether {@link value} is a choice this model offers. */
  readonly known: boolean;
  /** Whether the operator set this, as opposed to the model's own default. */
  readonly explicit: boolean;
}

/**
 * Rule 4: what to show, which is deliberately *not* what would be dispatched.
 *
 * An operator who picked `xhigh` on a model that offered it, and is now looking at a model
 * or a rebuilt harness that does not, is shown `xhigh` and told it is unknown. The
 * alternative — showing `medium` because that is what the run would normalise to — reads
 * as if the choice were still in effect under a different name.
 */
export const displayedModelOption = (
  descriptor: ModelOptionDescriptor,
  selections: readonly ModelOptionSelection[],
): ModelOptionDisplay => {
  const raw = selectedModelOptionValue(selections, descriptor.id);
  if (raw === undefined) {
    const value = fallbackChoiceId(descriptor);
    return {
      value,
      label: choiceOf(descriptor, value)?.label ?? "Default",
      known: true,
      explicit: false,
    };
  }
  const choice = choiceOf(descriptor, raw);
  return choice === undefined
    ? { value: raw, label: raw, known: false, explicit: true }
    : { value: raw, label: choice.label, known: true, explicit: true };
};

/**
 * What rule 1 threw away: selection ids this model has no descriptor for.
 *
 * The signal T3Code does not have. A picker that renders these says "this model does not
 * offer X" instead of leaving the operator to notice that a setting they made has stopped
 * having an effect.
 */
export const droppedModelOptionIds = (
  descriptors: readonly ModelOptionDescriptor[],
  selections: readonly ModelOptionSelection[],
): readonly string[] =>
  selections
    .filter(
      (selection) =>
        !descriptors.some((descriptor) => descriptor.id === selection.id),
    )
    .map((selection) => selection.id);
