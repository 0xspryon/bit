/**
 * How long one narrated text field may be, shared by the server that cuts and the browser
 * that has to recognise what was cut (A6 U8 review 5).
 *
 * The server caps every narration field where the harness's payload is read — a tool's
 * arguments can be a whole file — and marks the cut in the value itself. An operator's
 * message is a narration field too: the replay's `turn.operator` body and a queued
 * message's text are both cut here. So a browser checking whether a message over the cap
 * reached a session has to compare the server's shortened form of it, not the words it
 * sent, and it can only do that if both sides use one definition.
 *
 * Browser-safe: plain functions, no imports.
 */

/** The most characters one narration field carries: thinking, a tool field, a partial, an operator's message. */
export const NARRATION_FIELD_MAX = 4_000;

/**
 * The most characters a **finished** reply carries (A6 U5 review, the operator's decision):
 * eight times {@link NARRATION_FIELD_MAX}, since a reply is what the operator reads the
 * session for. Every partial stays at {@link NARRATION_FIELD_MAX}.
 */
export const REPLY_FIELD_MAX = 32_000;

/** The marker appended to a field one of the caps cut short. */
export const NARRATION_TRUNCATED_MARK = "\n… (shortened)";

const truncateAt = (value: string, max: number): string =>
  value.length <= max
    ? value
    : `${value.slice(0, max)}${NARRATION_TRUNCATED_MARK}`;

/** Caps one narration field at {@link NARRATION_FIELD_MAX}, saying so in the value when it cuts. */
export const truncateNarration = (value: string): string =>
  truncateAt(value, NARRATION_FIELD_MAX);

/** Caps a finished reply's text at {@link REPLY_FIELD_MAX}, saying so when it cuts. */
export const truncateReply = (value: string): string =>
  truncateAt(value, REPLY_FIELD_MAX);
