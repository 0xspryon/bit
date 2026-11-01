/**
 * Sortable identifiers for the graph's own entities.
 *
 * Adapted from OpenCode's `packages/schema/src/identifier.ts` (MIT). The shape is theirs:
 * a fixed-width string whose leading characters encode a timestamp and a per-millisecond
 * counter, followed by random characters, so ids sort lexically in creation order without
 * anything having to read a column to find out when a row appeared.
 *
 * **What this is for, and what it is not.** Three of this store's id families are
 * deliberately *not* built here:
 *
 * - `obs_`, `evt_` and `out_` are derived from the store-assigned sequence allocated
 *   inside the writing transaction. That counter is the graph's own order, not the wall
 *   clock, and an observation's id is parsed: dimension addresses are built from it and
 *   printed into briefings for a worker to copy back. A clock-derived id cannot stand in
 *   for a transactional one, and renumbering would rewrite primary keys and every address
 *   already published.
 * - Session tokens and MCP credentials are secrets, not identifiers. They want their full
 *   32 bytes of entropy with nothing predictable in front of it.
 *
 * What is left — intents, goals, attempts, dimensions and assets — is exactly the set
 * that benefits: created at a moment, wanted in creation order, and never parsed.
 *
 * **Three deliberate divergences from the original**, each because the original is a
 * filename generator used in one place and this is a primary key:
 *
 * 1. **Fourteen hex characters of time, not twelve.** The encoded value is
 *    `timestamp * 0x1000 + counter`, which for a millisecond epoch already needs 53 bits.
 *    Six bytes holds 48, so the original silently truncates the high bits and its ids
 *    wrap roughly every 2.2 years — ordering that is correct inside a window and wrong
 *    across it, with nothing to notice at the boundary. Seven bytes holds the whole value
 *    with centuries to spare. The string stays 26 characters by taking the two from the
 *    random tail, which still leaves ~71 bits.
 * 2. **Time never goes backwards.** The original resets its counter whenever the
 *    millisecond differs from the last one it saw, so a clock stepping backwards — NTP,
 *    a suspended laptop — both reverses the order and reuses counter values. Here the
 *    clock is clamped to the last value issued, so ids stay strictly increasing for the
 *    life of the process whatever the clock does.
 * 3. **No modulo bias.** `byte % 62` over 256 values favours the first 8 characters of
 *    the alphabet. Irrelevant at this width, and rejection sampling costs one loop.
 *
 * Monotonicity is per process, as it is in the original. Two processes writing the same
 * target file can interleave within a millisecond; the random tail is what keeps that a
 * tie in ordering rather than a collision. The transactional sequence is still the only
 * total order over a target's graph, and these ids do not try to replace it.
 */

/** Base62, digits before uppercase before lowercase, so ASCII order is value order. */
const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Bytes at or above this are rejected, so every character is equally likely. */
const REJECT_AT = 248; // 62 * 4

/** Seven bytes of `timestamp * 0x1000 + counter`, rendered as hex. */
const TIME_BYTES = 7;
const TIME_CHARS = TIME_BYTES * 2;

/** The rest of the 26, drawn from {@link ALPHABET}. */
const TOTAL_CHARS = 26;
const RANDOM_CHARS = TOTAL_CHARS - TIME_CHARS;

/** Twelve bits of counter, so 4095 ids can share one millisecond. */
const COUNTER_SHIFT = 0x1000n;
const MAX_COUNTER = 0xfff;

/** The widest value {@link TIME_BYTES} can hold, used to invert for descending ids. */
const TIME_MASK = (1n << BigInt(TIME_BYTES * 8)) - 1n;

let lastTimestamp = 0;
let counter = 0;

/**
 * The next strictly increasing `timestamp * 0x1000 + counter`.
 *
 * Clamped rather than reset: a timestamp older than the last one issued is treated as
 * that last one, so a backwards clock costs ordering accuracy against wall time and never
 * costs uniqueness. Exhausting a millisecond's counter borrows the next millisecond
 * instead of wrapping.
 */
const nextValue = (now: number): bigint => {
  let timestamp = now > lastTimestamp ? now : lastTimestamp;
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter += 1;
  if (counter > MAX_COUNTER) {
    timestamp = lastTimestamp + 1;
    lastTimestamp = timestamp;
    counter = 1;
  }
  return BigInt(timestamp) * COUNTER_SHIFT + BigInt(counter);
};

/** Rejection-sampled characters from {@link ALPHABET}. */
const randomTail = (length: number): string => {
  const out: string[] = [];
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length - out.length));
    for (const byte of bytes) {
      if (byte >= REJECT_AT) continue;
      out.push(ALPHABET[byte % 62] as string);
      if (out.length === length) break;
    }
  }
  return out.join("");
};

/**
 * One identifier, without a prefix.
 *
 * `descending` inverts the time field so newer ids sort first, which is what a reader
 * wants from a list that is always read newest-down. It is the same string width and the
 * same guarantees; only the direction changes.
 */
export const create = (descending = false, timestamp = Date.now()): string => {
  const value = nextValue(timestamp);
  const encoded = descending ? TIME_MASK - (value & TIME_MASK) : value;
  const time = Array.from({ length: TIME_BYTES }, (_, index) =>
    Number((encoded >> BigInt((TIME_BYTES - 1 - index) * 8)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("");
  return time + randomTail(RANDOM_CHARS);
};

/** Oldest first. The default, and what every id below uses. */
export const ascending = (): string => create(false);

/** Newest first. */
export const descending = (): string => create(true);

/**
 * `<prefix>_<identifier>`.
 *
 * The prefix is what makes a loose id self-describing in a log line or an error, and it
 * is never parsed back out: the type of a thing is known from where its id was read, not
 * from its spelling.
 */
export const prefixed = (prefix: string): string => `${prefix}_${ascending()}`;

export const newIntentId = (): string => prefixed("int");
export const newGoalId = (): string => prefixed("goal");
export const newAttemptId = (): string => prefixed("att");
/**
 * One planner round.
 *
 * `rnd` rather than `round`, so that no minted id can ever spell the reserved segment a
 * namespaced caller scope uses (`<targetId>/round/<roundId>`). See `store.ts`'s
 * {@link callerScopeOf}: the four scope shapes are distinct because every id in them is
 * minted here, with a prefix, and none of the prefixes is a reserved word.
 */
export const newRoundId = (): string => prefixed("rnd");
export const newDimensionId = (): string => prefixed("dim");
export const newAssetId = (): string => prefixed("asset");
export const newScopeEntryId = (): string => prefixed("scope");

/**
 * Resets the process-local clock and counter.
 *
 * For tests that need a known starting point. Nothing in the running server calls it —
 * resetting the counter mid-run is how you manufacture the collision the clamp exists to
 * prevent.
 */
export const resetForTesting = (): void => {
  lastTimestamp = 0;
  counter = 0;
};
