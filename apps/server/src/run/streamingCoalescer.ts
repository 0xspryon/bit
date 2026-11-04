/**
 * Live streaming of a reply or thinking block while it is being written (A6 F6).
 *
 * A driver that streams (A6 F7, F8) narrates a block as many {@link BlockDelta}s — a token
 * or a few at a time, hundreds per block — and then the finished block, a `reply` or
 * `thinking` carrying the same `blockId`. Putting every delta on the live stream would be
 * hundreds of frames per block through a sliding bus that drops the oldest when a tab is
 * behind, so this turns them into **at most one {@link BlockPartial} per block per
 * {@link PARTIAL_INTERVAL}**, each carrying the block's *whole* text so far. A reader that
 * misses one loses an intermediate frame, never text: the next carries all of it. That is
 * T3 Code's shape (full accumulated text per item, coalesced), which A6 decided on.
 *
 * ## Timing
 *
 * Leading and trailing edge, per block:
 *
 * - The first delta of a block, and any delta arriving {@link PARTIAL_INTERVAL} or more after
 *   that block's last update, is published **at once** — the first words show without a
 *   50 ms wait.
 * - A delta arriving sooner is held, and one timer per block publishes everything held when
 *   the interval since the last update is up. However many deltas arrive in between, that
 *   is one update.
 * - **The block's end flushes at once** what is still held, before the finished block is
 *   published, and nothing about that block is published afterwards: its timer is stopped,
 *   it is forgotten, and a delta for it that arrives late is dropped. The order matters to a
 *   reader that replaces by `blockId`: a partial landing *after* the finished block would
 *   put a shorter text back on screen.
 *
 * Every update and the end take one lock, so a timer that wakes while the block is ending
 * either publishes before the end does or finds the block gone.
 *
 * **The turn's end ends every block still open** ({@link StreamingCoalescer.endAll}). A
 * conversation keeps its harness session — and so this scope — open across turns and
 * across a Stop, so a block cut off by an interrupt would otherwise stay open with up to an
 * interval's text never sent. {@link narrateCoalesced} ends them all when an entry with a
 * terminal `outcome` passes, before publishing that entry. A finished block that still
 * arrives for one of them afterwards is published as usual and replaces the partial.
 *
 * ## Bounded memory
 *
 * A session holds the blocks it has open (normally one or two: a thinking block, then its
 * reply), each capped at {@link NARRATION_FIELD_MAX} characters as the finished block is,
 * at most {@link OPEN_BLOCKS_MAX} of them, and the ids of the last
 * {@link ENDED_BLOCKS_KEPT} blocks it ended, so a late delta is recognised. A block that
 * never ends is ended by its turn's end; when the session's narration ends, the scope this
 * lives in closes and drops everything.
 *
 * A block dropped at the {@link OPEN_BLOCKS_MAX} cap is **remembered as ended**, as an
 * ended block is: its later pieces are refused rather than reopening it with only the new
 * text, which a reader replacing by `blockId` would show as the block losing its start.
 *
 * ### Why a forgotten id cannot come back
 *
 * The ended memory is bounded, so after {@link ENDED_BLOCKS_KEPT} later blocks end an id is
 * forgotten, and a delta for it would open a new block. That delta cannot arrive. A
 * session's entries come from one ordered stream, handled one at a time, and both drivers
 * emit every piece of a block before its finished block: OpenCode's publisher flushes a
 * block's batched delta before it publishes `session.text.ended` / `reasoning.ended`, and
 * its deltas are ephemeral, so a resumed stream does not replay them; Claude Code's
 * `content_block_delta`s precede the `assistant` message that carries the block. So a delta
 * after its block's end is a redelivery of something recent, or a delta of a block dropped
 * at the cap or ended by its turn — both within the last few ends, and 64 is far above
 * the one or two blocks a turn ends. Remembering every id instead would make a long
 * conversation's memory grow with its length, for a case no driver produces.
 *
 * V2(chat): streaming partials are never stored and are not replayed after a reconnect — a
 * reconnect catches up from finished blocks only, so a block still being written shows
 * nothing until it ends. Proper V2: resume the in-flight block from the harness's own buffer.
 */
import {
  Clock,
  Duration,
  Effect,
  FiberMap,
  Semaphore,
  Stream,
  type Scope,
} from "effect";

import {
  NARRATION_FIELD_MAX,
  truncateNarration,
  type BlockDelta,
  type BlockPartial,
  type HarnessNarration,
} from "../harness/agentHarness";

/**
 * The least time between two updates of one block.
 *
 * T3 Code's figure: about twenty frames a second, which reads as continuous typing, and an
 * order of magnitude fewer frames than a fast model's tokens.
 */
export const PARTIAL_INTERVAL: Duration.Input = "50 millis";

/**
 * How many blocks one session may have open at once before the oldest is dropped.
 *
 * Far above anything a driver does — one thinking block and one reply at a time — so it is
 * reached only by a driver that never ends its blocks, and is what keeps that from growing
 * without bound. A dropped block publishes nothing more; its finished block still arrives.
 */
export const OPEN_BLOCKS_MAX = 16;

/** How many ended block ids a session remembers, so a late delta for one is dropped. */
export const ENDED_BLOCKS_KEPT = 64;

/** What the `type` of a published partial says: this application's, not a harness's. */
export const PARTIAL_NARRATION_TYPE = "bit.partial";

/** Turns one session's block deltas into coalesced partial updates. See the module header. */
export interface StreamingCoalescer {
  /** Adds a piece of a block. Publishes now, later, or — for an ended block — never. */
  readonly delta: (delta: BlockDelta) => Effect.Effect<void>;
  /**
   * Ends a block: publishes what is held at once, then nothing more about it. Call it
   * **before** publishing the finished block. Ending a block never opened is harmless.
   */
  readonly end: (blockId: string) => Effect.Effect<void>;
  /**
   * Ends every open block, as {@link end} does each: what is held is published at once, then
   * nothing more about any of them. For the end of a turn. See the module header.
   */
  readonly endAll: Effect.Effect<void>;
  /** How many blocks are open. For tests: the memory claim. */
  readonly openBlocks: Effect.Effect<number>;
}

interface OpenBlock {
  readonly channel: BlockDelta["channel"];
  /** The model call, as the block's first delta named it. */
  readonly call: string | undefined;
  /** Everything so far, kept to one character past the cap so the cut can be marked. */
  text: string;
  /** Text has arrived since the last update. */
  held: boolean;
  /** When the last update was published, by {@link Clock}. */
  publishedAt: number | undefined;
  /**
   * A timer is due to publish what is held. Set and cleared under the lock, so a timer that
   * has done its work but not yet left the fiber map is not mistaken for one still due.
   */
  scheduled: boolean;
}

/**
 * A coalescer that lives as long as the scope it is made in, publishing through `publish`.
 *
 * `publish` must not fail and should not block: it is called under the coalescer's lock.
 * The narration bus's publish is both.
 */
export const makeStreamingCoalescer = (options: {
  readonly publish: (partial: BlockPartial) => Effect.Effect<void>;
  readonly interval?: Duration.Input | undefined;
}): Effect.Effect<StreamingCoalescer, never, Scope.Scope> =>
  Effect.gen(function* () {
    const interval = Duration.toMillis(options.interval ?? PARTIAL_INTERVAL);
    const lock = yield* Semaphore.make(1);
    const timers = yield* FiberMap.make<string>();
    const open = new Map<string, OpenBlock>();
    const ended = new Set<string>();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        open.clear();
        ended.clear();
      }),
    );

    /** Publishes the block's whole text so far. Under the lock. */
    const flush = (blockId: string, block: OpenBlock) =>
      Effect.gen(function* () {
        block.held = false;
        block.publishedAt = yield* Clock.currentTimeMillis;
        yield* options.publish({
          _tag: "partial",
          blockId,
          ...(block.call === undefined ? {} : { call: block.call }),
          channel: block.channel,
          text: truncateNarration(block.text),
        });
      });

    /** What a timer does when its block's interval is up. Takes the lock itself. */
    const flushLater = (blockId: string, wait: number) =>
      Effect.andThen(
        Effect.sleep(Duration.millis(wait)),
        Semaphore.withPermit(lock)(
          Effect.suspend(() => {
            const block = open.get(blockId);
            // Ended, or dropped, while this slept: nothing more about it.
            if (block === undefined) return Effect.void;
            block.scheduled = false;
            return block.held ? flush(blockId, block) : Effect.void;
          }),
        ),
      );

    const remember = (blockId: string): void => {
      ended.add(blockId);
      if (ended.size > ENDED_BLOCKS_KEPT) {
        const oldest = ended.values().next().value;
        if (oldest !== undefined) ended.delete(oldest);
      }
    };

    const delta = (piece: BlockDelta): Effect.Effect<void> =>
      Semaphore.withPermit(lock)(
        Effect.gen(function* () {
          if (ended.has(piece.blockId) || piece.text === "") return;
          let block = open.get(piece.blockId);
          if (block === undefined) {
            if (open.size >= OPEN_BLOCKS_MAX) {
              const oldest = open.keys().next().value;
              if (oldest !== undefined) {
                // Remembered as ended, so its next piece cannot reopen it with only the
                // new text.
                remember(oldest);
                open.delete(oldest);
                yield* FiberMap.remove(timers, oldest);
              }
            }
            block = {
              channel: piece.channel,
              call: piece.call,
              text: "",
              held: false,
              publishedAt: undefined,
              scheduled: false,
            };
            open.set(piece.blockId, block);
          }
          // Past the cap nothing changes on screen, so nothing is held or published.
          if (block.text.length > NARRATION_FIELD_MAX) return;
          block.text = `${block.text}${piece.text}`.slice(
            0,
            NARRATION_FIELD_MAX + 1,
          );
          block.held = true;
          const now = yield* Clock.currentTimeMillis;
          if (
            block.publishedAt === undefined ||
            now - block.publishedAt >= interval
          ) {
            if (block.scheduled) {
              block.scheduled = false;
              yield* FiberMap.remove(timers, piece.blockId);
            }
            yield* flush(piece.blockId, block);
            return;
          }
          // One timer per block: a block already waiting publishes this text with its own.
          if (block.scheduled) return;
          block.scheduled = true;
          yield* FiberMap.run(
            timers,
            piece.blockId,
          )(flushLater(piece.blockId, block.publishedAt + interval - now));
        }),
      );

    /** Ends one block. Under the lock. */
    const endLocked = (blockId: string) =>
      Effect.gen(function* () {
        remember(blockId);
        const block = open.get(blockId);
        if (block === undefined) return;
        open.delete(blockId);
        yield* FiberMap.remove(timers, blockId);
        if (block.held) yield* flush(blockId, block);
      });

    const end = (blockId: string): Effect.Effect<void> =>
      Semaphore.withPermit(lock)(endLocked(blockId));

    const endAll: Effect.Effect<void> = Semaphore.withPermit(lock)(
      Effect.suspend(() =>
        Effect.forEach([...open.keys()], endLocked, { discard: true }),
      ),
    );

    return {
      delta,
      end,
      endAll,
      openBlocks: Effect.sync(() => open.size),
    } satisfies StreamingCoalescer;
  });

/**
 * One session's narration, published with its block deltas coalesced.
 *
 * What the importer and goal conversations run in place of publishing every entry as it
 * comes: a {@link BlockDelta} goes to the coalescer and is never published itself; a
 * finished `reply` or `thinking` with a `blockId` ends that block — the held text first,
 * then the finished block; an entry with a terminal `outcome` — the turn's end — ends every
 * block still open first, so an interrupted block's last text is sent; everything else is
 * published as it was. The coalescer lives as long as this does, so when the session's
 * narration ends every open block goes with it.
 *
 * **Publishing is not persisting**: `publish` is the narration bus, which nothing stores
 * (`run/narration.ts`). The replay a reload reads comes from the harness's own transcript,
 * which holds finished blocks only.
 */
export const narrateCoalesced = <E>(input: {
  readonly events: Stream.Stream<HarnessNarration, E>;
  readonly publish: (entry: HarnessNarration) => Effect.Effect<void>;
  readonly interval?: Duration.Input | undefined;
}): Effect.Effect<void, E> =>
  Effect.scoped(
    Effect.gen(function* () {
      const coalescer = yield* makeStreamingCoalescer({
        interval: input.interval,
        publish: (partial) =>
          Effect.flatMap(Clock.currentTimeMillis, (at) =>
            input.publish({
              type: PARTIAL_NARRATION_TYPE,
              sequence: undefined,
              at,
              outcome: undefined,
              detail: partial,
            }),
          ),
      });
      yield* Stream.runForEach(input.events, (entry) =>
        // The turn is over, however it ended: nothing still open will be written further.
        entry.outcome === undefined
          ? narrateOne(coalescer, input.publish, entry)
          : Effect.andThen(
              coalescer.endAll,
              narrateOne(coalescer, input.publish, entry),
            ),
      );
    }),
  );

/** What {@link narrateCoalesced} does with one entry, once the turn's end is dealt with. */
const narrateOne = (
  coalescer: StreamingCoalescer,
  publish: (entry: HarnessNarration) => Effect.Effect<void>,
  entry: HarnessNarration,
): Effect.Effect<void> => {
  const detail = entry.detail;
  switch (detail._tag) {
    case "delta":
      return coalescer.delta(detail);
    case "reply":
    case "thinking":
      return detail.blockId === undefined
        ? publish(entry)
        : Effect.andThen(coalescer.end(detail.blockId), publish(entry));
    default:
      return publish(entry);
  }
};
