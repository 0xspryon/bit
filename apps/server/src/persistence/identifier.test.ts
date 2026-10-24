/**
 * The properties an id of this shape has to have, including the three the original
 * does not.
 */
import { describe, expect, test } from "bun:test";

import * as identifier from "./identifier";

const TIME_CHARS = 14;

describe("identifier", () => {
  test("is 26 characters, hex time then base62 tail", () => {
    const id = identifier.ascending();
    expect(id).toHaveLength(26);
    expect(id.slice(0, TIME_CHARS)).toMatch(/^[0-9a-f]{14}$/);
    expect(id.slice(TIME_CHARS)).toMatch(/^[0-9A-Za-z]{12}$/);
  });

  test("sorts in creation order", () => {
    const ids = Array.from({ length: 500 }, () => identifier.ascending());
    expect([...ids].sort()).toEqual(ids);
  });

  test("descending sorts newest first", () => {
    const ids = Array.from({ length: 200 }, () => identifier.descending());
    expect([...ids].sort()).toEqual([...ids].reverse());
  });

  test("is unique across a burst inside one millisecond", () => {
    const now = Date.now();
    const ids = new Set(
      Array.from({ length: 5000 }, () => identifier.create(false, now)),
    );
    expect(ids.size).toBe(5000);
  });

  /**
   * The divergence that matters most. The original encodes the value in six bytes, which
   * cannot hold `timestamp * 0x1000` for a millisecond epoch: the high bits fall off and
   * ordering reverses at a boundary roughly every 2.2 years. Two timestamps that straddle
   * one of those boundaries must still compare correctly.
   */
  test("does not wrap across a six-byte boundary", () => {
    const WRAP_MS = 2 ** 36; // where the original's time field rolls over
    const before = identifier.create(false, WRAP_MS - 1);
    const after = identifier.create(false, WRAP_MS * 2 + 1);
    expect(before < after).toBe(true);

    // The same pair under the original's six-byte field, to show it is a real boundary
    // and not a hypothetical one.
    const sixBytes = (ms: number) => {
      const value = BigInt(ms) * 0x1000n + 1n;
      return Array.from({ length: 6 }, (_, index) =>
        Number((value >> BigInt(40 - 8 * index)) & 0xffn)
          .toString(16)
          .padStart(2, "0"),
      ).join("");
    };
    expect(sixBytes(WRAP_MS - 1) < sixBytes(WRAP_MS * 2 + 1)).toBe(false);
  });

  test("a backwards clock cannot reverse the order or repeat an id", () => {
    const now = Date.now();
    const forward = identifier.create(false, now);
    const backwards = Array.from({ length: 100 }, (_, index) =>
      identifier.create(false, now - 1000 - index),
    );
    for (const id of backwards) {
      expect(id > forward).toBe(true);
    }
    expect(new Set([forward, ...backwards]).size).toBe(101);
  });

  test("a millisecond holding more than its counter borrows the next one", () => {
    const now = Date.now();
    const ids = Array.from({ length: 4200 }, () =>
      identifier.create(false, now),
    );
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(4200);
  });

  test("every alphabet character is reachable, and none is favoured", () => {
    const counts = new Map<string, number>();
    for (let index = 0; index < 4000; index += 1) {
      for (const character of identifier.ascending().slice(TIME_CHARS)) {
        counts.set(character, (counts.get(character) ?? 0) + 1);
      }
    }
    expect(counts.size).toBe(62);

    // Per-character counts are too noisy to threshold individually: ~774 draws each has
    // a standard deviation near 28, so with 62 characters something clears any bound
    // tight enough to catch the bias. The bias is not spread evenly, though: 256 is
    // 4 * 62 + 8, so `% 62` gives the first eight characters five chances where the
    // other 54 get four — a 25% excess, measured, not estimated. So
    // compare those eight against the other 54 as groups, where the noise averages out
    // and a real bias is many standard deviations clear of it.
    const mean = (characters: readonly string[]) =>
      characters.reduce((total, c) => total + (counts.get(c) ?? 0), 0) /
      characters.length;
    const alphabet = [...counts.keys()].sort();
    const favouredByModulo = mean(alphabet.slice(0, 8));
    const rest = mean(alphabet.slice(8));

    // Clean runs land under 0.03 and a `% 62` generator lands above 0.22, so this sits
    // in the gap rather than near either side.
    expect(Math.abs(favouredByModulo / rest - 1) < 0.1).toBe(true);
  });

  test("prefixes are attached, and the body is unchanged by them", () => {
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ["int_", identifier.newIntentId()],
      ["goal_", identifier.newGoalId()],
      ["att_", identifier.newAttemptId()],
      ["dim_", identifier.newDimensionId()],
      ["asset_", identifier.newAssetId()],
    ];
    for (const [prefix, id] of pairs) {
      expect({ prefix, starts: id.startsWith(prefix) }).toEqual({
        prefix,
        starts: true,
      });
      expect(id.slice(prefix.length)).toHaveLength(26);
    }
  });
});
