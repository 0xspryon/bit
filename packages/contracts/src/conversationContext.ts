/**
 * How full a conversation's context window is, and — where the harness says — what fills it
 * (A6 U9, the crumb bar's context meter on D3).
 *
 * **A reading, not a stream.** The server asks the harness when a screen asks: on opening
 * the conversation, after each turn, and after a model switch (the window is the model's).
 * Nothing here is pushed per model call — the live feed's `LiveUsage` frames are, and a
 * screen may draw the newer of the two — and nothing polls the harness per delta.
 *
 * **`used` is one model call, never a total.** Both harnesses publish running spend totals
 * that re-count the cached prefix on every call (DECISIONS.md §24.4; `live.ts`): `used` is
 * the last call's tokens sent plus generated, which is what fills the window now.
 *
 * Browser-safe: Effect Schema only. No server, Bun, Node or persistence imports.
 */
import { Schema } from "effect";

const EpochMillis = Schema.Finite.annotate({
  description: "Epoch milliseconds",
});

/**
 * What a category is, as Claude Code classifies its own rows: `used` occupies the window,
 * `buffer` is the reserve it keeps for compacting, `free` is what is left. Claude Code's
 * `deferred` rows (tool schemas held out of the window until called) are not in the window
 * and are not sent.
 */
export const ContextCategoryKind = Schema.Literals(["used", "buffer", "free"]);
export type ContextCategoryKind = typeof ContextCategoryKind.Type;

/** One row of what fills the window, in the harness's own words. */
export const ContextCategory = Schema.Struct({
  /**
   * The harness's stable id for the row (`system_tools`, `messages`, …), or `null` from a
   * harness version that does not send one. Match on this, never on {@link name}.
   */
  id: Schema.NullOr(Schema.String),
  /** The harness's own label: "System tools", "Messages". */
  name: Schema.String,
  tokens: Schema.Int,
  kind: ContextCategoryKind,
});
export type ContextCategory = typeof ContextCategory.Type;

/**
 * Why a reading carries no categories.
 *
 * - `harness_gives_none` — the harness has no breakdown to give (OpenCode publishes tokens
 *   per call and a window per model, and nothing per category).
 * - `not_asked` — the breakdown costs the harness a count per category, so it is given only
 *   when asked for (`breakdown=1`), which a screen does when the operator opens it.
 * - `not_live` — the breakdown is the live session's to give, and this server does not hold
 *   the session (it ended, or the server restarted). `used` is then read from the stored
 *   transcript.
 * - `unanswered` — the session was asked and did not answer in time.
 */
export const ContextBreakdownMissing = Schema.Literals([
  "harness_gives_none",
  "not_asked",
  "not_live",
  "unanswered",
]);
export type ContextBreakdownMissing = typeof ContextBreakdownMissing.Type;

export const ContextBreakdown = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("categories"),
    /**
     * The model the categories were counted on: the free space and the reserve are this
     * model's window, so a screen shows them only under a reading of the same window
     * ({@link sameModel} with {@link ConversationContext.model}).
     */
    model: Schema.String,
    /**
     * In the harness's order, used rows first. **Estimates**, counted by the harness against
     * its own idea of the prompt: their sum is close to {@link ConversationContext.used} and
     * not equal to it, and a screen says so rather than presenting either as the other.
     */
    categories: Schema.Array(ContextCategory),
  }),
  Schema.Struct({
    _tag: Schema.Literal("none"),
    reason: ContextBreakdownMissing,
  }),
]);
export type ContextBreakdown = typeof ContextBreakdown.Type;

/**
 * What {@link ConversationContext.used} is.
 *
 * - `measured` — the last model call's tokens, as the harness reported them.
 * - `no_call_yet` — the session has made no model call, so nothing fills the window yet that
 *   anyone has measured. `used` is `null`.
 * - `compacted` — the harness summarised the conversation since its last call, so the last
 *   call's size no longer describes the window, and the next call measures it again. `used`
 *   is `null`: the old figure would be a number known to be wrong.
 * - `unread` — the harness could not be asked (not reachable, or the session's record could
 *   not be read). `used` is `null`; nothing is claimed either way.
 */
export const ContextReading = Schema.Literals([
  "measured",
  "no_call_yet",
  "compacted",
  "unread",
]);
export type ContextReading = typeof ContextReading.Type;

/** One conversation's context, as its harness answered just now. */
export const ConversationContext = Schema.Struct({
  /**
   * The conversation the answer is about: for an importer, the import holding the session
   * now, as `ConversationActivity.conversationId` is.
   */
  conversationId: Schema.String,
  /**
   * The model the session is on now: the one {@link window} belongs to. Where the harness
   * says which model it answered for (Claude Code's `getContextUsage().model`), that one;
   * otherwise the model the server recorded the session on.
   */
  model: Schema.String,
  /** Tokens in the window on the last model call, sent plus generated. See {@link reading}. */
  used: Schema.NullOr(Schema.Int),
  /**
   * The model whose call measured {@link used}, in the harness's own spelling (Claude
   * Code's `message.model`, which dates some models: `claude-haiku-4-5-20251001`), or
   * `null` where `used` is, or where the harness did not say.
   *
   * **Not always {@link model}.** A switch moves the window at once and the figure only at
   * the next call, and a call already running when the switch lands finishes on the old
   * model. Two figures are comparable — a drop between them is a compaction — only when
   * {@link sameModel} says they were measured on one model: each model counts the same
   * conversation with its own tokenizer (haiku-4-5 about 22 % below sonnet-5, measured).
   */
  usedModel: Schema.NullOr(Schema.String),
  /**
   * The window of {@link model}, or `null` where the harness has not said. A screen draws a
   * fraction only when this is set.
   */
  window: Schema.NullOr(Schema.Int),
  reading: ContextReading,
  breakdown: ContextBreakdown,
  /** When the server asked. */
  measuredAt: EpochMillis,
});
export type ConversationContext = typeof ConversationContext.Type;

/**
 * A model id as one model, whatever the spelling: lower case, with a trailing release date
 * (`-20251001`, `@20251001`) and a bracketed variant (`[1m]`) taken off.
 *
 * Measured 2026-11-05 on Claude Code (CLI 2.1.310): a call's `message.model` reads
 * `claude-haiku-4-5-20251001` for the catalogue's `claude-haiku-4-5`, and `claude-sonnet-5`
 * for `claude-sonnet-5`; `getContextUsage().model` and the `/model` echo use the catalogue's
 * spelling. OpenCode names a call's model as the catalogue does, `provider/model`.
 */
export const modelKey = (model: string): string =>
  model
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/[-@]\d{8}$/, "");

/**
 * Whether two model ids name one model ({@link modelKey}), so figures measured on them were
 * counted by one tokenizer. `null` — a model nobody stated — matches nothing.
 */
// V2(chat): a provider prefix (Bedrock's `us.anthropic.…-v1:0`, Vertex's region forms) is not
// taken off: V1 runs Claude Code on Anthropic's own API, which spells neither. V2 should map
// a call's model to the catalogue entry it was asked as, where the harness gives the mapping.
export const sameModel = (
  a: string | null | undefined,
  b: string | null | undefined,
): boolean =>
  a !== null &&
  a !== undefined &&
  b !== null &&
  b !== undefined &&
  a !== "" &&
  b !== "" &&
  modelKey(a) === modelKey(b);

/** A model id's bracketed variant (`[1m]`), lower case, or `""` without one. */
const variantOf = (model: string): string =>
  /\[[^\]]*\]$/.exec(model.trim().toLowerCase())?.[0] ?? "";

/**
 * Whether two model ids name one model **and one window** (A6 U9 review 3): {@link
 * sameModel} with the bracketed variant kept. A `[1m]` variant counts with the same tokenizer
 * — so its figures compare — but its window is another, and so are the free space and the
 * reserve a count of it states. What a count's categories are shown under.
 */
export const sameWindow = (
  a: string | null | undefined,
  b: string | null | undefined,
): boolean =>
  sameModel(a, b) &&
  a !== null &&
  a !== undefined &&
  b !== null &&
  b !== undefined &&
  variantOf(a) === variantOf(b);
