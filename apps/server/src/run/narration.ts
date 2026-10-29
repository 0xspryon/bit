/**
 * What a running attempt is saying, in process, to nobody in particular.
 *
 * The supervisor drains one session's log from the harness and publishes each entry here.
 * **In this slice there are no subscribers, and that is the point.** The next slice adds
 * an SSE endpoint that subscribes to exactly this, and putting the publish side in now
 * means that slice adds a route rather than reaching into the supervisor's drain loop to
 * fit a consumer into it. §8 calls this shape "advisory PubSub wake-ups", which Sprint 03
 * already anticipated.
 *
 * **Nothing here is durable, and that is an accepted risk for this slice.** A restart
 * loses whatever was in flight, and an entry published while nobody is listening is gone.
 * The alternative — writing narration to the event log — was considered and rejected: the
 * volume is one row per token-ish event, every row takes SQLite's single write lock on the
 * same file the worker is recording observations into, and the log is a provenance record
 * rather than a transcript. Persisting narration as evidence is a later slice's problem
 * and deliberately has no half-measure here.
 *
 * ## One PubSub with a key on the message, not one PubSub per key
 *
 * A subscriber can ask for one attempt or one target, which it does by filtering a stream
 * of everything rather than by being handed a topic of its own. That is a real trade and
 * worth stating:
 *
 * - **What it costs.** Every subscriber wakes for every attempt's narration and discards
 *   what is not theirs. With one operator and a handful of concurrent runs that is a
 *   predicate per message, which is nothing. It would be the wrong shape for hundreds of
 *   runs and thousands of watchers.
 * - **What it buys.** A topic per attempt is a map of PubSubs with a lifetime problem:
 *   created when a run starts or when a watcher arrives, whichever is first, and closed
 *   when the last of them leaves — a reference count over something whose whole content
 *   is disposable. A watcher that attached to a topic for an attempt that then ended
 *   would hold the topic open; one that attached before the run started would race the
 *   supervisor to create it.
 *
 * ## Sliding, so a slow reader cannot stall a run
 *
 * The strategy is {@link PubSub.sliding}, which drops the *oldest* buffered entry when a
 * subscriber is behind. Back-pressure is the wrong answer twice over here. A watcher that
 * stopped reading would otherwise block the supervisor's drain loop, which would stop it
 * reading the harness, which would eventually stall the harness's own writer — a browser
 * tab deciding how fast an agent may work. And narration is advisory: the newest entries
 * are the ones a watcher wants, so dropping the oldest is also the better answer for the
 * reader. Dropped entries are a known and accepted loss; nothing reconciles against this
 * stream, and the attempt row is what says what happened.
 *
 * With zero subscribers a publish stores nothing at all — `publish` on an atomic PubSub
 * with no subscribers returns immediately and keeps the value nowhere
 * (`effect/src/PubSub.ts`, `subscriberCount === 0`). So the no-subscriber case this slice
 * runs in costs one function call per entry.
 */
import { Channel, Context, Effect, Layer, PubSub, Stream } from "effect";

import type { HarnessNarration } from "../harness/agentHarness";

/**
 * How many entries are held for a subscriber that is behind.
 *
 * Enough that a tab repainting, or a subscriber doing one `await` per batch, keeps up
 * through a burst of tool calls; small enough that the buffer is bounded memory per
 * subscriber rather than a transcript nobody asked to keep. A power of two because
 * `PubSub`'s atomic backing is a ring buffer.
 */
export const NARRATION_BUFFER = 256;

/**
 * One entry of narration as the supervisor hands it over, with the three things that say
 * whose it is.
 *
 * `targetId` and `attemptId` are the keys a subscriber filters on. Both come from the
 * attempt the supervisor is running — never from the harness's own payload — so a
 * misattributed entry is not reachable: the supervisor publishes under the attempt whose
 * session it opened.
 *
 * `harnessSessionId` is carried because it is the join to the harness's own storage, and
 * a reader comparing our narration against `opencode`'s log needs it.
 */
export interface RunNarrationInput {
  readonly targetId: string;
  readonly attemptId: string;
  readonly harnessSessionId: string;
  readonly entry: HarnessNarration;
}

/**
 * One published entry, with the identity this bus gives it.
 *
 * `id` exists because a consumer has to be able to say "I have already shown this", and
 * nothing on {@link HarnessNarration} can answer that: `sequence` is the *harness's*
 * cursor and Claude Code has none at all, `at` collides freely — several entries derived
 * from one SDK message share a receipt time by construction — and two token deltas can be
 * identical in every field. So the bus assigns one, in publish order, and
 * {@link RunNarrations.publish} is the only thing that may.
 *
 * **It is an in-process counter and it means nothing outside this process.** It is not a
 * cursor and cannot be resumed from: a restart begins at zero, and an entry published
 * while nobody was listening is gone — see this module's header. What it is good for is
 * exactly one thing, which is the thing a live transcript needs: within one connection,
 * two frames carrying the same `id` are the same entry.
 */
export interface RunNarration extends RunNarrationInput {
  /** This process's publish order. See above for what it is not. */
  readonly id: number;
}

/** Which narration a subscriber wants. Absent means every target, or every attempt. */
export interface NarrationFilter {
  readonly targetId?: string | undefined;
  readonly attemptId?: string | undefined;
}

const matches = (filter: NarrationFilter, item: RunNarration): boolean =>
  (filter.targetId === undefined || filter.targetId === item.targetId) &&
  (filter.attemptId === undefined || filter.attemptId === item.attemptId);

/**
 * The one in-process narration bus.
 *
 * Owned by the layer's scope, like every other resource in this process: when that scope
 * closes the PubSub shuts down and every subscription with it.
 */
export class RunNarrations extends Context.Service<
  RunNarrations,
  {
    /**
     * Publishes one entry. Never fails and never blocks.
     *
     * The return value of `PubSub.publish` — whether the entry was accepted — is
     * deliberately discarded. A dropped entry is not an error the supervisor can act on:
     * it must not retry (narration is not an obligation), must not log per entry (that
     * would turn a dropped line into a written one at a worse volume), and certainly must
     * not slow down to accommodate a reader.
     */
    readonly publish: (item: RunNarrationInput) => Effect.Effect<void>;
    /**
     * A stream of the narration matching `filter`, from now on.
     *
     * No replay: a subscriber sees what is published after it subscribes. There is
     * nothing to replay from — see the module header on why none of this is durable — so
     * a late subscriber has genuinely missed what it missed, and a stream that pretended
     * otherwise would be inventing the transcript this slice is not allowed to decide.
     */
    readonly subscribe: (
      filter: NarrationFilter,
    ) => Stream.Stream<RunNarration>;
    /**
     * How many subscriptions are **established**.
     *
     * Diagnostics, and the only way a test can state the claim this slice actually makes:
     * that the supervisor publishes correctly with **no** subscribers, and that a
     * subscriber attached to one attempt is not handed another's entries.
     *
     * **Counted after the `PubSub` subscription exists, not before**, which is what makes
     * it usable as a readiness signal — and it is used as one: this bus replays nothing, so
     * a test that published before a subscription was established would be testing its own
     * luck. An earlier version incremented a counter beside `Stream.fromPubSub` and
     * returned the stream, which reads as the same thing and is not: the subscription is
     * taken when the stream is first *pulled*, so the count could lead it. It happened to
     * hold in practice and that is exactly the kind of thing that stops holding.
     */
    readonly subscriberCount: Effect.Effect<number>;
  }
>()("bit/run/RunNarrations") {
  static readonly layer: Layer.Layer<RunNarrations> = Layer.effect(
    RunNarrations,
    Effect.gen(function* () {
      const pubsub = yield* PubSub.sliding<RunNarration>(NARRATION_BUFFER);
      // Assigned here, in publish order, and nowhere else. See `RunNarration.id`.
      let published = 0;
      // Counted here rather than read off the PubSub, whose subscriber count is an
      // internal field of its backing ring buffer. A cast into someone else's internals
      // to satisfy a diagnostic is a cast that breaks on a patch release. See `subscribe`
      // for *when* this moves, which is the part that makes it meaningful.
      let subscribers = 0;
      return RunNarrations.of({
        publish: (item) =>
          Effect.suspend(() => {
            published += 1;
            return Effect.asVoid(
              PubSub.publish(pubsub, { ...item, id: published }),
            );
          }),
        /**
         * Subscribes, counts, then streams — in that order, which is the point.
         *
         * `PubSub.subscribe` is the real subscription and it is scoped, so it is taken here
         * and the counter moves *after* it returns. `Channel.fromSubscriptionArray` is then
         * what `Stream.fromPubSub` would have used internally anyway
         * (`effect/src/Channel.ts`'s `fromPubSubArray` is that exact pair), so nothing about
         * the stream's behaviour changes — only when the count becomes true.
         *
         * The release decrements. It is attached with `acquireRelease` around the already
         * scoped subscribe, so both land in the same scope and a stream that is interrupted
         * mid-pull still gives the count back.
         */
        subscribe: (filter) =>
          Stream.filter(
            Stream.fromChannel(
              Channel.unwrap(
                Effect.map(
                  Effect.acquireRelease(
                    Effect.tap(PubSub.subscribe(pubsub), () =>
                      Effect.sync(() => {
                        subscribers += 1;
                      }),
                    ),
                    () =>
                      Effect.sync(() => {
                        subscribers -= 1;
                      }),
                  ),
                  Channel.fromSubscriptionArray,
                ),
              ),
            ),
            (item) => matches(filter, item),
          ),
        subscriberCount: Effect.sync(() => subscribers),
      });
    }),
  );
}
