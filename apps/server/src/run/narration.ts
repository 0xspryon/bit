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
 * Whose session is narrating: a worker's attempt, a planner round, a goal's agent, or a
 * scope importer.
 *
 * **Tagged rather than two nullable id fields, for the reason `CallerContext` is tagged.**
 * Exactly one of the two is ever set, and a pair of nullable fields makes "neither" and
 * "both" shapes the type permits and every consumer has to re-rule-out. A publisher that
 * cannot name which kind it is cannot publish at all, which is the property wanted: the
 * supervisor publishes under the identity whose session it opened, so a misattributed
 * entry is not reachable.
 *
 * It grew a second case when the planner view arrived. Before it, a round's narration was
 * drained for its terminal outcome and thrown away, because this bus's filter was keyed by
 * attempt id and a round has no attempt — `plan/planSupervisor.ts` said so and attached the
 * widening to the slice that would have a screen to design it against. This is that
 * widening.
 */
export type NarrationSubject =
  | { readonly _tag: "attempt"; readonly attemptId: string }
  | { readonly _tag: "round"; readonly roundId: string }
  /**
   * A goal's own agent: the long-horizon conversation an operator is having.
   *
   * The third case, and unlike the first two its session is **not** one unit of work. An
   * attempt and a round each narrate once and settle; a goal conversation narrates for as
   * long as the operator keeps it open, across any number of turns, and the entries of two
   * turns are one stream here. Nothing on this bus cares — it is keyed by subject, not by
   * turn — and the chat groups by the conversation rather than by the turn for the same
   * reason: there is no durable record of a turn boundary to corroborate one.
   */
  | { readonly _tag: "goal"; readonly goalId: string }
  /**
   * A scope importer's session: the conversation an operator has on a target's Auto-load
   * page.
   *
   * The fourth case, and a conversation in the way the third is — many turns, one stream,
   * keyed by subject rather than by turn. Keyed by **import id** rather than by target,
   * because a target can have several importer sessions over its life and the chat shows
   * one of them; and rather than by harness session id, because the import id is the
   * authority period the importer's credential and its writes are filed under, so it is the
   * same key everything else about the session already uses.
   *
   * It exists because the importer stopped being a batch job. While it was one prompt with
   * nobody on the other end, its narration was deliberately never drained (D16 in the
   * target-scope design, which the importer conversation design's S4 amends): there was no
   * screen to narrate to. A chat is one.
   */
  | { readonly _tag: "import"; readonly importId: string };

/**
 * One entry of narration as a supervisor hands it over, with the things that say whose it
 * is.
 *
 * `targetId` and {@link NarrationSubject} are the keys a subscriber filters on. Both come
 * from the attempt or round the supervisor is running — never from the harness's own
 * payload.
 *
 * `harnessSessionId` is carried because it is the join to the harness's own storage, and
 * a reader comparing our narration against `opencode`'s log needs it. It is also what the
 * planner view's replay reads from, which is why a round's narration carries it too.
 */
export interface RunNarrationInput {
  readonly targetId: string;
  readonly subject: NarrationSubject;
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

/**
 * Which narration a subscriber wants. Absent means every target, or every subject.
 *
 * The subject ids are all here and all optional, and that is **not** the shape
 * {@link NarrationSubject} refused. A filter is a question and may legitimately name
 * none — the live transcript asks for a whole target — or name one of them. What it
 * cannot do is name two, which is a question with no answers and reads as one.
 */
export interface NarrationFilter {
  readonly targetId?: string | undefined;
  readonly attemptId?: string | undefined;
  readonly roundId?: string | undefined;
  readonly goalId?: string | undefined;
  readonly importId?: string | undefined;
}

const subjectMatches = (
  filter: NarrationFilter,
  subject: NarrationSubject,
): boolean =>
  (filter.attemptId === undefined ||
    (subject._tag === "attempt" && subject.attemptId === filter.attemptId)) &&
  (filter.roundId === undefined ||
    (subject._tag === "round" && subject.roundId === filter.roundId)) &&
  (filter.goalId === undefined ||
    (subject._tag === "goal" && subject.goalId === filter.goalId)) &&
  (filter.importId === undefined ||
    (subject._tag === "import" && subject.importId === filter.importId));

const matches = (filter: NarrationFilter, item: RunNarration): boolean =>
  (filter.targetId === undefined || filter.targetId === item.targetId) &&
  subjectMatches(filter, item.subject);

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
