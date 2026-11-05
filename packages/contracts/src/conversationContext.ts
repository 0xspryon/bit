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
  /** The model the session is on now: the one {@link window} belongs to. */
  model: Schema.String,
  /** Tokens in the window on the last model call, sent plus generated. See {@link reading}. */
  used: Schema.NullOr(Schema.Int),
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
