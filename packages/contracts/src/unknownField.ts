/**
 * Reading a field out of a payload whose shape is not ours (DECISIONS.md §6 "`COPY` —
 * `unknownField.ts`": readers that decode undeclared payloads without trusting shapes,
 * returning `undefined` rather than throwing).
 *
 * It is here because of the event log. An event's `payload` is JSON written by whichever
 * build recorded it, and the set of kinds and fields only grows — so a Sprint 03 consumer
 * will meet events written by a later build, and a reader that threw on a field it did not
 * expect would turn "this event has something extra" into "this consumer is stuck". The
 * rule is the small one: a field that is absent, null, or of the wrong type reads as
 * `undefined`, and the caller decides what to do about that.
 *
 * **What this is not.** It is not a decoder and not a substitute for one. Where a shape
 * *is* ours and declared, use Effect Schema and get a typed failure naming the row — that
 * is the whole of §20's "`JSON.parse(text) as A` is not a typed boundary". This is for the
 * other case: a payload we are tolerating rather than validating, where the honest result
 * of a question we cannot answer is "I do not know".
 *
 * Browser-safe: no imports at all.
 */

/** Whether a value is a plain object that could carry named fields. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * One named field of an undeclared payload, or `undefined`.
 *
 * `undefined` covers every way the question can fail to have an answer — the payload is
 * not an object, the field is missing, or it is null — and the three are deliberately not
 * told apart. A caller that needs to distinguish "absent" from "present and null" is
 * reading a shape it should be decoding instead.
 */
export const unknownField = (
  payload: unknown,
  field: string,
): unknown | undefined => {
  if (!isRecord(payload)) return undefined;
  const value = payload[field];
  return value === null ? undefined : value;
};

/** The field as a string, or `undefined` if it is absent or not a string. */
export const unknownString = (
  payload: unknown,
  field: string,
): string | undefined => {
  const value = unknownField(payload, field);
  return typeof value === "string" ? value : undefined;
};

/**
 * The field as a finite number, or `undefined`.
 *
 * `NaN` and the infinities read as `undefined`: they are the values a number field is
 * most likely to hold when something upstream went wrong, and passing one on as a number
 * moves the failure somewhere harder to see.
 */
export const unknownNumber = (
  payload: unknown,
  field: string,
): number | undefined => {
  const value = unknownField(payload, field);
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
};

/** The field as a boolean, or `undefined` if it is absent or not a boolean. */
export const unknownBoolean = (
  payload: unknown,
  field: string,
): boolean | undefined => {
  const value = unknownField(payload, field);
  return typeof value === "boolean" ? value : undefined;
};
