/**
 * The streaming coalescer (A6 F6), in isolation and on a clock the test moves.
 *
 * What is claimed: at most one update per block per {@link PARTIAL_INTERVAL}, each carrying
 * the block's whole text so far; the first words at once; the end flushes at once and is the
 * last word about its block; and what a session holds is bounded and let go of.
 */
import { describe, expect, test } from "bun:test";
import { Effect, Stream, type Scope } from "effect";
import { TestClock } from "effect/testing";

import {
  NARRATION_FIELD_MAX,
  NARRATION_TRUNCATED_MARK,
  type BlockDelta,
  type BlockPartial,
  type HarnessNarration,
  type NarrationDetail,
} from "../harness/agentHarness";
import {
  ENDED_BLOCKS_KEPT,
  OPEN_BLOCKS_MAX,
  PARTIAL_NARRATION_TYPE,
  makeStreamingCoalescer,
  narrateCoalesced,
  type StreamingCoalescer,
} from "./streamingCoalescer";

const reply = (blockId: string, text: string): BlockDelta => ({
  _tag: "delta",
  blockId,
  channel: "reply",
  text,
});

/** Runs `use` against a coalescer on a test clock, with what it published so far. */
const withCoalescer = <A>(
  use: (
    coalescer: StreamingCoalescer,
    published: readonly BlockPartial[],
  ) => Effect.Effect<A, never, Scope.Scope>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const published: BlockPartial[] = [];
        const coalescer = yield* makeStreamingCoalescer({
          publish: (partial) =>
            Effect.sync(() => {
              published.push(partial);
            }),
        });
        return yield* use(coalescer, published);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

const texts = (published: readonly BlockPartial[]) =>
  published.map((partial) => partial.text);

describe("timing", () => {
  test("the first words are published at once, and with the block's channel", async () => {
    const outcome = await withCoalescer((coalescer, published) =>
      Effect.gen(function* () {
        yield* coalescer.delta({ ...reply("b1", "Let"), channel: "thinking" });
        return [...published];
      }),
    );
    expect(outcome).toEqual([
      { _tag: "partial", blockId: "b1", channel: "thinking", text: "Let" },
    ]);
  });

  test("deltas inside one interval are one update, with the whole text so far, when it is up", async () => {
    const outcome = await withCoalescer((coalescer, published) =>
      Effect.gen(function* () {
        yield* coalescer.delta(reply("b1", "Let"));
        // Nine more pieces, 5 ms apart: all inside the 50 ms after the first update.
        for (const piece of [
          " me",
          " look",
          " at",
          " the",
          " first",
          " page",
          ".",
          " It",
          " says",
        ]) {
          yield* TestClock.adjust("5 millis");
          yield* coalescer.delta(reply("b1", piece));
        }
        const inside = texts(published);
        // 45 ms have passed. The 50th is when the held text goes.
        yield* TestClock.adjust("4 millis");
        const justBefore = texts(published);
        yield* TestClock.adjust("1 millis");
        const atInterval = texts(published);
        // Nothing more arrives, so nothing more is published, however long it waits.
        yield* TestClock.adjust("1 second");
        return { inside, justBefore, atInterval, after: texts(published) };
      }),
    );
    expect(outcome.inside).toEqual(["Let"]);
    expect(outcome.justBefore).toEqual(["Let"]);
    expect(outcome.atInterval).toEqual([
      "Let",
      "Let me look at the first page. It says",
    ]);
    expect(outcome.after).toEqual(outcome.atInterval);
  });

  test("a steady stream is at most one update per interval", async () => {
    const outcome = await withCoalescer((coalescer, published) =>
      Effect.gen(function* () {
        // 200 pieces, one every 2 ms: 400 ms of writing.
        for (let index = 0; index < 200; index += 1) {
          yield* coalescer.delta(reply("b1", "x"));
          yield* TestClock.adjust("2 millis");
        }
        yield* TestClock.adjust("100 millis");
        return texts(published);
      }),
    );
    // 400 ms at one per 50 ms, plus the leading update: nine, not two hundred.
    expect(outcome.length).toBeLessThanOrEqual(9);
    expect(outcome.length).toBeGreaterThanOrEqual(8);
    // Every update is the whole text so far, so each is longer than the last.
    for (let index = 1; index < outcome.length; index += 1) {
      expect(outcome[index]?.length ?? 0).toBeGreaterThan(
        outcome[index - 1]?.length ?? 0,
      );
    }
    expect(outcome.at(-1)).toBe("x".repeat(200));
  });

  test("a delta after a quiet interval is published at once", async () => {
    const outcome = await withCoalescer((coalescer, published) =>
      Effect.gen(function* () {
        yield* coalescer.delta(reply("b1", "One."));
        yield* TestClock.adjust("200 millis");
        yield* coalescer.delta(reply("b1", " Two."));
        return texts(published);
      }),
    );
    expect(outcome).toEqual(["One.", "One. Two."]);
  });

  test("two blocks are timed apart", async () => {
    const outcome = await withCoalescer((coalescer, published) =>
      Effect.gen(function* () {
        yield* coalescer.delta({ ...reply("t1", "Hmm"), channel: "thinking" });
        yield* coalescer.delta(reply("r1", "Yes"));
        return published.map((partial) => partial.blockId);
      }),
    );
    expect(outcome).toEqual(["t1", "r1"]);
  });
});

describe("the end of a block", () => {
  test("flushes what is held at once, without waiting out the interval", async () => {
    const outcome = await withCoalescer((coalescer, published) =>
      Effect.gen(function* () {
        yield* coalescer.delta(reply("b1", "Done"));
        yield* TestClock.adjust("10 millis");
        yield* coalescer.delta(reply("b1", " here."));
        const held = texts(published);
        yield* coalescer.end("b1");
        return { held, ended: texts(published) };
      }),
    );
    expect(outcome.held).toEqual(["Done"]);
    expect(outcome.ended).toEqual(["Done", "Done here."]);
  });

  test("publishes nothing when nothing is held", async () => {
    const outcome = await withCoalescer((coalescer, published) =>
      Effect.gen(function* () {
        yield* coalescer.delta(reply("b1", "All of it."));
        yield* coalescer.end("b1");
        return texts(published);
      }),
    );
    expect(outcome).toEqual(["All of it."]);
  });

  test("is the last word: the timer is stopped, and a late delta is dropped", async () => {
    const outcome = await withCoalescer((coalescer, published) =>
      Effect.gen(function* () {
        yield* coalescer.delta(reply("b1", "A"));
        yield* TestClock.adjust("10 millis");
        yield* coalescer.delta(reply("b1", "B"));
        yield* coalescer.end("b1");
        const ended = texts(published);
        // The timer the held "B" had scheduled would have fired at 50 ms.
        yield* TestClock.adjust("1 second");
        // A delta for the block, after its end: late, and about a block that is over.
        yield* coalescer.delta(reply("b1", "C"));
        yield* TestClock.adjust("1 second");
        return { ended, after: texts(published) };
      }),
    );
    expect(outcome.ended).toEqual(["A", "AB"]);
    expect(outcome.after).toEqual(["A", "AB"]);
  });

  test("ending a block never opened is harmless, and keeps a late first delta out", async () => {
    const outcome = await withCoalescer((coalescer, published) =>
      Effect.gen(function* () {
        yield* coalescer.end("b1");
        yield* coalescer.delta(reply("b1", "late"));
        return {
          published: texts(published),
          open: yield* coalescer.openBlocks,
        };
      }),
    );
    expect(outcome).toEqual({ published: [], open: 0 });
  });
});

describe("memory", () => {
  test("an ended block is let go of", async () => {
    const outcome = await withCoalescer((coalescer) =>
      Effect.gen(function* () {
        yield* coalescer.delta(reply("b1", "x"));
        yield* coalescer.delta(reply("b2", "y"));
        const during = yield* coalescer.openBlocks;
        yield* coalescer.end("b1");
        yield* coalescer.end("b2");
        return { during, after: yield* coalescer.openBlocks };
      }),
    );
    expect(outcome).toEqual({ during: 2, after: 0 });
  });

  test("blocks that never end are capped, oldest dropped first, and a dropped block stays dropped", async () => {
    const outcome = await withCoalescer((coalescer, published) =>
      Effect.gen(function* () {
        for (let index = 0; index <= OPEN_BLOCKS_MAX; index += 1) {
          yield* coalescer.delta(reply(`b${String(index)}`, "x"));
        }
        const open = yield* coalescer.openBlocks;
        // Room again: the dropped block must still not come back.
        yield* coalescer.end("b1");
        const before = published.length;
        // Reopening it would show "y" in place of "xy": the block losing its start.
        yield* TestClock.adjust("10 millis");
        yield* coalescer.delta(reply("b0", "y"));
        yield* TestClock.adjust("1 second");
        return {
          open,
          reopened: published.slice(before),
          after: yield* coalescer.openBlocks,
        };
      }),
    );
    expect(outcome.open).toBe(OPEN_BLOCKS_MAX);
    expect(outcome.reopened).toEqual([]);
    expect(outcome.after).toBe(OPEN_BLOCKS_MAX - 1);
  });

  test("a late delta is refused for as long as its block is remembered, a dropped block included", async () => {
    // The module header says why a delta cannot arrive later than this window; this pins
    // the window itself, for an ended block and for one dropped at the cap alike.
    const outcome = await withCoalescer((coalescer, published) =>
      Effect.gen(function* () {
        for (let index = 0; index <= OPEN_BLOCKS_MAX; index += 1) {
          yield* coalescer.delta(reply(`open${String(index)}`, "x"));
        }
        // `open0` was dropped, and is the oldest id remembered. Then `ended` ends, and as
        // many more as the memory holds beside the two of them.
        yield* coalescer.end("ended");
        for (let index = 0; index < ENDED_BLOCKS_KEPT - 2; index += 1) {
          yield* coalescer.end(`later${String(index)}`);
        }
        const before = published.length;
        yield* coalescer.delta(reply("open0", "late"));
        yield* coalescer.delta(reply("ended", "late"));
        return published.slice(before);
      }),
    );
    expect(outcome).toEqual([]);
  });

  test("U5 review: a partial names the model call its block's deltas named", async () => {
    const outcome = await withCoalescer((coalescer, published) =>
      Effect.gen(function* () {
        yield* coalescer.delta({ ...reply("m1:0", "I will"), call: "m1" });
        yield* coalescer.delta(reply("b2", "Unnamed"));
        return published.map((partial) => [partial.blockId, partial.call]);
      }),
    );
    expect(outcome).toEqual([
      ["m1:0", "m1"],
      ["b2", undefined],
    ]);
  });

  test("a block's text is capped as the finished block's is, and stops growing past it", async () => {
    const outcome = await withCoalescer((coalescer, published) =>
      Effect.gen(function* () {
        yield* coalescer.delta(reply("b1", "a".repeat(NARRATION_FIELD_MAX)));
        yield* TestClock.adjust("100 millis");
        yield* coalescer.delta(reply("b1", "bb"));
        yield* TestClock.adjust("100 millis");
        const capped = published.length;
        // Past the cap: nothing changes on screen, so nothing is published.
        yield* coalescer.delta(reply("b1", "c".repeat(10_000)));
        yield* TestClock.adjust("100 millis");
        return { texts: texts(published), capped };
      }),
    );
    expect(outcome.capped).toBe(2);
    expect(outcome.texts).toHaveLength(2);
    expect(outcome.texts[1]).toBe(
      `${"a".repeat(NARRATION_FIELD_MAX)}${NARRATION_TRUNCATED_MARK}`,
    );
  });

  test("ending every block flushes each one's held text, then refuses their late pieces", async () => {
    const outcome = await withCoalescer((coalescer, published) =>
      Effect.gen(function* () {
        yield* coalescer.delta({ ...reply("t1", "Hmm"), channel: "thinking" });
        yield* coalescer.delta(reply("b1", "Sto"));
        yield* TestClock.adjust("10 millis");
        yield* coalescer.delta(reply("b1", "pped"));
        yield* coalescer.endAll;
        const ended = published.map((partial) => [
          partial.blockId,
          partial.text,
        ]);
        const open = yield* coalescer.openBlocks;
        yield* TestClock.adjust("1 second");
        yield* coalescer.delta(reply("b1", " late"));
        yield* TestClock.adjust("1 second");
        return { ended, open, total: published.length };
      }),
    );
    expect(outcome.ended).toEqual([
      ["t1", "Hmm"],
      ["b1", "Sto"],
      // Held when the turn ended, and sent at once rather than lost.
      ["b1", "Stopped"],
    ]);
    expect(outcome.open).toBe(0);
    expect(outcome.total).toBe(3);
  });

  test("closing the scope stops every timer: nothing is published after", async () => {
    const published: BlockPartial[] = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const coalescer = yield* makeStreamingCoalescer({
              publish: (partial) =>
                Effect.sync(() => {
                  published.push(partial);
                }),
            });
            yield* coalescer.delta(reply("b1", "A"));
            yield* coalescer.delta(reply("b1", "B"));
          }),
        );
        yield* TestClock.adjust("1 second");
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(texts(published)).toEqual(["A"]);
  });
});

/* ── One session's narration, coalesced ──────────────────────────────────────── */

const entry = (detail: NarrationDetail): HarnessNarration => ({
  type: "test",
  sequence: undefined,
  at: 1,
  outcome: undefined,
  detail,
});

describe("narrateCoalesced", () => {
  test("deltas become partials, the finished block follows them, and the rest passes through", async () => {
    const published = await Effect.runPromise(
      Effect.gen(function* () {
        const out: HarnessNarration[] = [];
        yield* narrateCoalesced({
          events: Stream.fromIterable([
            entry({
              _tag: "toolCall",
              callId: "c1",
              tool: "bash",
              input: "{}",
            }),
            entry(reply("b1", "Hel")),
            entry(reply("b1", "lo")),
            entry({ _tag: "reply", text: "Hello", blockId: "b1" }),
            entry({ _tag: "reply", text: "Not streamed." }),
          ]),
          publish: (item) =>
            Effect.sync(() => {
              out.push(item);
            }),
        });
        return out;
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(published.map((item) => [item.type, item.detail])).toEqual([
      ["test", { _tag: "toolCall", callId: "c1", tool: "bash", input: "{}" }],
      // The first piece at once; the second held, then flushed by the end, before the block.
      [
        PARTIAL_NARRATION_TYPE,
        { _tag: "partial", blockId: "b1", channel: "reply", text: "Hel" },
      ],
      [
        PARTIAL_NARRATION_TYPE,
        { _tag: "partial", blockId: "b1", channel: "reply", text: "Hello" },
      ],
      ["test", { _tag: "reply", text: "Hello", blockId: "b1" }],
      ["test", { _tag: "reply", text: "Not streamed." }],
    ]);
    // No delta is ever published as itself.
    expect(published.some((item) => item.detail._tag === "delta")).toBe(false);
  });

  test("the turn's end ends a block cut off before its finished block, ahead of the outcome", async () => {
    // A conversation keeps its session — and this scope — open across a Stop, so without
    // this the held " sto" would never be sent and the block would stay open.
    const published = await Effect.runPromise(
      Effect.gen(function* () {
        const out: HarnessNarration[] = [];
        yield* narrateCoalesced({
          events: Stream.fromIterable([
            entry(reply("b1", "I will")),
            entry(reply("b1", " sto")),
            {
              ...entry({ _tag: "opaque" }),
              type: "session.execution.interrupted",
              outcome: "interrupted",
            },
            // The next turn's block, after the stop: the old block stays over.
            entry(reply("b1", "p")),
            entry(reply("b2", "Next")),
          ]),
          publish: (item) =>
            Effect.sync(() => {
              out.push(item);
            }),
        });
        return out;
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(
      published.map((item) =>
        item.detail._tag === "partial"
          ? `${item.detail.blockId}:${item.detail.text}`
          : item.type,
      ),
    ).toEqual([
      "b1:I will",
      "b1:I will sto",
      "session.execution.interrupted",
      "b2:Next",
    ]);
  });

  test("a stream that fails fails the narration, as it did before", async () => {
    const outcome = await Effect.runPromise(
      Effect.flip(
        narrateCoalesced({
          events: Stream.fail("dropped"),
          publish: () => Effect.void,
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
    expect(outcome).toBe("dropped");
  });
});
