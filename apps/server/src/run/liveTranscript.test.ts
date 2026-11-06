/**
 * The live transcript: what it renders, and what it promises about order.
 *
 * Three groups, and they are testing three genuinely different things:
 *
 * 1. **The projections, as pure functions.** "A recorded observation reads as recorded" and
 *    "a denied action reads as denied" are claims about one function each, and a test that
 *    needed a database and a harness to check them would be a test nobody runs. Every
 *    render kind the day asks for is asserted here by name.
 * 2. **Ordered delivery behind a cursor, against a real SQLite file.** This is the one that
 *    cannot be faked. The events are written by the real store, through the real mutation
 *    boundary, so the sequence under test is the sequence the store assigned inside its own
 *    transaction — and the read is the real `WHERE sequence > ? ORDER BY sequence`. A
 *    scripted reader here would be a test of the script. It also covers the two properties
 *    Day 7 is built on: resuming after a cursor skips nothing committed in between, and
 *    re-reading a range produces ids a client has already seen rather than new ones.
 * 3. **The two channels together**, including the real narration bus, and the attribution
 *    rule that drops a policy decision whose session cannot be placed.
 *
 * `page` and `sweep` are overridden throughout, so paging is exercised at a size a test can
 * write out by hand and a caught-up reader does not cost a real second.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bitMcpServerName,
  claudeCodeToolName,
  LiveFrame,
  LiveItem as LiveItemSchema,
  openCodeToolName,
  type LiveItem,
  type RecordedEvent,
} from "@bit/contracts";
import {
  Duration,
  Effect,
  Fiber,
  Layer,
  Queue,
  Schema,
  Stream,
  Struct,
  type Scope,
} from "effect";

import {
  ENDED_STOP_NOTE,
  liveTranscript,
  projectDecision,
  projectEvent,
  projectNarration,
  projectReplay,
  turnEndedFrame,
  type LiveTranscriptInput,
} from "./liveTranscript";
import { RunNarrations, type RunNarration } from "./narration";
import {
  NARRATION_FIELD_MAX,
  NARRATION_TRUNCATED_MARK,
  REPLY_FIELD_MAX,
  truncateNarration,
  truncateReply,
  type MessageEntry,
  type NarrationDetail,
} from "../harness/agentHarness";
import type { AnsweredDecision, PolicyDecisions } from "../policy/service";
import { FleetStore } from "../persistence/fleet";
import { AWKWARD_TEXT, multiCaseInput } from "../persistence/fixtures";
import { TargetStores } from "../persistence/targetStores";
import {
  ObservationStore,
  type AttemptCaller,
  type StoredCounts,
} from "../persistence/store";

type Store = ObservationStore["Service"];

/* ── Scratch files ───────────────────────────────────────────────────────────── */

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true });
  }
});

const newDatabasePath = () => {
  const directory = mkdtempSync(join(tmpdir(), "bit-live-"));
  directories.push(directory);
  return join(directory, "hunt.sqlite");
};

const TARGET = "target-1";

const CALLER: AttemptCaller = {
  _tag: "attempt",
  callerScope: `${TARGET}/attempt-1`,
  targetId: TARGET,
  intentId: "intent-1",
  attemptId: "attempt-1",
  harnessSessionId: "ses_abc",
  workerId: "worker-1",
  attemptFence: 0,
};

const seed = (store: Store) =>
  store.seedAttempt({
    targetId: TARGET,
    goalId: "goal-1",
    goal: `Determine whether authentication rate limits can be bypassed. ${AWKWARD_TEXT}`,
    intentId: "intent-1",
    question: "Probe the per-client limiter on POST /login.",
    attemptId: "attempt-1",
    workerId: "worker-1",
    harnessInstanceId: "opencode",
    providerId: "openai",
    modelId: "gpt-5.6-sol",
    modelOptions: null,
    harnessSessionId: "ses_abc",
  });

const assetInput = (id: string) => ({
  operationId: `asset-${id}`,
  kind: "endpoint" as const,
  url: `http://127.0.0.1:41317/${id}`,
  method: "GET",
  note: `discovered as ${id}`,
});

/**
 * Opens one real store in its own scope and runs the body against it.
 *
 * `Effect.scoped` owns the connection, as `persistence/store.test.ts` does it: the file is
 * closed on success, on failure and on interruption.
 */
const withStore = <A, E>(
  path: string,
  use: (store: Store) => Effect.Effect<A, E, never>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(ObservationStore, use).pipe(
        Effect.provide(ObservationStore.layer(path)),
        Effect.orDie,
      ),
    ),
  );

/* ── Doubles for the two activity buses ──────────────────────────────────────── */

/**
 * A narration bus that answers from a list.
 *
 * Finite and deterministic, which is the point: the real bus is a live `PubSub` and a test
 * that published into one would be racing the moment the merge establishes its
 * subscription. The real bus has its own test below — "the real narration bus reaches a
 * watching transcript" — and this is for the assertions about *what* is rendered and about
 * the target filter, neither of which is about timing.
 */
const narrationsFrom = (items: readonly RunNarration[]) =>
  ({
    publish: () => Effect.void,
    subscribe: (filter) =>
      Stream.fromArray(
        items.filter(
          (item) =>
            (filter.targetId === undefined ||
              filter.targetId === item.targetId) &&
            (filter.attemptId === undefined ||
              (item.subject._tag === "attempt" &&
                filter.attemptId === item.subject.attemptId)) &&
            (filter.roundId === undefined ||
              (item.subject._tag === "round" &&
                filter.roundId === item.subject.roundId)),
        ),
      ),
    subscriberCount: Effect.succeed(0),
    activity: () => Effect.succeed(undefined),
    waiting: () => Effect.succeed(undefined),
  }) satisfies RunNarrations["Service"];

/** A decision bus that answers from a list, for the same reason. */
const decisionsFrom = (answered: readonly AnsweredDecision[]) =>
  ({
    record: () => Effect.void,
    all: Effect.succeed([]),
    answered: Stream.fromArray(answered),
    subscriberCount: Effect.succeed(0),
    holdSession: () => Effect.void,
    endSession: () => Effect.void,
    sessionEnded: () => Effect.succeed(false),
  }) satisfies PolicyDecisions["Service"];

const NO_NARRATION = narrationsFrom([]);
const NO_DECISIONS = decisionsFrom([]);

const narration = (
  detail: NarrationDetail,
  over: Partial<Omit<RunNarration, "entry">> = {},
  at = 1_700_000_000_000,
): RunNarration => ({
  id: 1,
  targetId: TARGET,
  subject: { _tag: "attempt", attemptId: "attempt-1" },
  harnessSessionId: "ses_abc",
  ...over,
  entry: {
    type: "scripted",
    sequence: undefined,
    at,
    outcome: undefined,
    detail,
  },
});

const denial = (over: Partial<AnsweredDecision> = {}): AnsweredDecision => ({
  id: 1,
  at: 1_700_000_000_500,
  request: {
    sessionId: "ses_abc",
    tool: "bash",
    input: { command: "curl -s https://out-of-scope.test/" },
  },
  decision: {
    effect: "deny",
    reason: "host 'out-of-scope.test' is not in scope",
  },
  ...over,
});

/* ── Driving the stream ──────────────────────────────────────────────────────── */

/**
 * Collects frames until `done` says to stop, or fails rather than hanging.
 *
 * The stream is infinite by construction — a caught-up reader sleeps and reads again — so
 * every test here has to say what it is waiting for. `Effect.timeout` is what turns "the
 * frame never came" into a failed test instead of a suite that stops.
 */
const framesUntil = (
  stream: Stream.Stream<LiveFrame>,
  done: (frames: readonly LiveFrame[]) => boolean,
): Promise<readonly LiveFrame[]> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<LiveFrame>();
        const fiber = yield* Effect.forkScoped(
          Stream.runForEach(stream, (frame) => Queue.offer(queue, frame)),
        );
        const frames: LiveFrame[] = [];
        yield* Effect.timeout(
          Effect.gen(function* () {
            while (!done(frames)) frames.push(yield* Queue.take(queue));
          }),
          "10 seconds",
        ).pipe(Effect.orDie);
        yield* Fiber.interrupt(fiber);
        return frames as readonly LiveFrame[];
      }),
    ),
  );

/** True once a caught-up cursor frame has arrived: the record channel has nothing left. */
const caughtUp = (frames: readonly LiveFrame[]): boolean =>
  frames.some((frame) => frame._tag === "cursor" && frame.caughtUp);

const items = (frames: readonly LiveFrame[]): readonly LiveItem[] =>
  frames.filter((frame): frame is LiveItem => frame._tag === "item");

const records = (frames: readonly LiveFrame[]): readonly LiveItem[] =>
  items(frames).filter((item) => item.origin === "record");

/** The stream over one real store, with the two buses substitutable per test. */
const over = (
  store: Store,
  options: Partial<LiveTranscriptInput> = {},
): Stream.Stream<LiveFrame> =>
  liveTranscript({
    targetId: TARGET,
    events: (after, limit) => Effect.orDie(store.eventsAfter(after, limit)),
    latestSequence: Effect.orDie(store.currentEventSequence),
    narrations: NO_NARRATION,
    decisions: NO_DECISIONS,
    attemptForSession: () => Effect.succeed("attempt-1"),
    sweep: "5 millis",
    heartbeat: "10 seconds",
    ...options,
  });

/* ── 1. The projections ──────────────────────────────────────────────────────── */

const event = (over: Partial<RecordedEvent> = {}): RecordedEvent => ({
  eventId: "evt-1",
  sequence: 7,
  targetId: TARGET,
  kind: "observation.recorded",
  payload: {},
  callerScope: `${TARGET}/attempt-1`,
  intentId: "intent-1",
  attemptId: "attempt-1",
  operation: "record_observation",
  operationId: "op-1",
  subjectId: "obs-1",
  recordedAt: 1_700_000_000_000,
  ...over,
});

describe("projecting the record", () => {
  test("an attempt's own start and settle are attributed to that attempt", () => {
    // Both are host-originated — written before any credential for the attempt exists, or
    // by the sweep that reconciled the row — so the store leaves every caller-authority
    // column null and puts the attempt in `subject_id`. Reading only `attempt_id` showed a
    // run's own beginning and end with no run on them, which is the first thing a reader
    // filtering by attempt would miss. Observed against a live server.
    const started = projectEvent(
      event({
        kind: "attempt.started",
        attemptId: null,
        intentId: null,
        callerScope: null,
        subjectId: "at_live",
        payload: { providerId: "stub", modelId: "scripted/model" },
      }),
    );
    expect(started.attemptId).toBe("at_live");

    // A worker's own mutation does carry caller authority, and that is what is used: the
    // subject there is the observation row, not the attempt.
    const observation = projectEvent(
      event({ attemptId: "attempt-1", subjectId: "obs-1" }),
    );
    expect(observation.attemptId).toBe("attempt-1");
  });

  /**
   * The subject is read for those two kinds **only**, and this is why.
   *
   * A general `attemptId ?? subjectId` fallback looked harmless and was not. `subject_id`
   * is domain identity, so for a host-added intent it holds the *intent* id — and falling
   * back put an intent id into a field every reader takes to be an attempt, where a filter
   * for one run would match an item that has nothing to do with that run.
   */
  test("a host-originated intent has no attempt, and does not borrow its subject", () => {
    const item = projectEvent(
      event({
        kind: "intent.added",
        callerScope: "host",
        attemptId: null,
        intentId: null,
        subjectId: "intent-7",
        payload: { question: "Probe the account limiter." },
      }),
    );
    expect(item.kind).toBe("intent.added");
    expect(item.attemptId).toBeNull();
    expect(item.body).toBe("Probe the account limiter.");
  });

  test("an unknown kind with no caller attempt does not borrow its subject either", () => {
    const item = projectEvent(
      event({
        kind: "finding.promoted",
        attemptId: null,
        subjectId: "finding-3",
      }),
    );
    expect(item.kind).toBe("record.other");
    expect(item.attemptId).toBeNull();
  });

  test("every record item carries the store's own id and sequence", () => {
    const item = projectEvent(event({ eventId: "evt-42", sequence: 42 }));
    // The id is the store's, which is what makes it the same string on a later connection
    // — the whole reason a reconnect can re-read a range invisibly.
    expect(item.id).toBe("record:evt-42");
    expect(item.origin).toBe("record");
    expect(item.sequence).toBe(42);
    expect(item.at).toBe(1_700_000_000_000);
  });

  test("a recorded observation reads as recorded, with its claim and its outcome", () => {
    const item = projectEvent(
      event({
        kind: "observation.recorded",
        payload: {
          observationId: "obs-1",
          outcome: "negative",
          testedClaim: "Rotating X-Client-Id does not evade the limiter.",
          untestedDimensionCount: 0,
        },
      }),
    );
    expect(item.kind).toBe("observation.recorded");
    expect(item.headline).toBe("Observation recorded");
    expect(item.body).toBe("Rotating X-Client-Id does not evade the limiter.");
    // A negative result reads as a negative result and not as a failure: the two are
    // different claims and the day after this one is about keeping them apart.
    expect(item.outcome).toBe("negative");
  });

  test("an observation that left dimensions untested says how many", () => {
    const one = projectEvent(
      event({
        payload: {
          testedClaim: "Only POST /login was probed.",
          untestedDimensionCount: 1,
        },
      }),
    );
    expect(one.body).toBe(
      "Only POST /login was probed. (1 dimension left untested.)",
    );
    const several = projectEvent(
      event({
        payload: {
          testedClaim: "Only POST /login was probed.",
          untestedDimensionCount: 3,
        },
      }),
    );
    expect(several.body).toContain("3 dimensions left untested.");
  });

  test("a started run names the model it is on, and a settled one how it ended", () => {
    const started = projectEvent(
      event({
        kind: "attempt.started",
        payload: {
          providerId: "openai",
          modelId: "gpt-5.6-sol",
          intentId: "intent-1",
        },
      }),
    );
    expect(started.kind).toBe("run.started");
    expect(started.body).toContain("openai/gpt-5.6-sol");
    expect(started.outcome).toBeNull();

    const settled = projectEvent(
      event({
        kind: "attempt.settled",
        payload: { status: "uncertain", settledBy: "recovery" },
      }),
    );
    expect(settled.kind).toBe("run.settled");
    expect(settled.outcome).toBe("uncertain");
    // Who settled it is carried, because a sweep reconciling a row left behind and a
    // supervisor watching its own run mean different things by the same word.
    expect(settled.body).toContain("recovery");
  });

  test("a planner round's two records say what they are, with no attempt on them", () => {
    // Both are host-originated like the attempt pair, and the round is the subject — so
    // `attemptId` is null and stays null. A round is not an attempt, and the general
    // subject fallback this projection deliberately does not have is what keeps a round
    // id out of a field every reader takes to be an attempt's.
    const started = projectEvent(
      event({
        kind: "plan.round.started",
        attemptId: null,
        intentId: null,
        callerScope: null,
        subjectId: "rnd_live",
        payload: { roundId: "rnd_live", goalId: "goal-1", budget: 5 },
      }),
    );
    expect(started.kind).toBe("plan.round.started");
    expect(started.attemptId).toBeNull();
    // The round id is in the sentence because the contract has no field for it; see
    // `LIVE_ITEM_KINDS`.
    expect(started.body).toContain("rnd_live");
    expect(started.body).toContain("goal-1");
    expect(started.body).toContain("5 intents");
    expect(started.outcome).toBeNull();

    const settled = projectEvent(
      event({
        kind: "plan.round.settled",
        attemptId: null,
        intentId: null,
        callerScope: null,
        subjectId: "rnd_live",
        payload: {
          roundId: "rnd_live",
          status: "uncertain",
          settledBy: "recovery",
          disposition: null,
        },
      }),
    );
    expect(settled.kind).toBe("plan.round.settled");
    expect(settled.outcome).toBe("uncertain");
    expect(settled.body).toContain("recovery");
    // The absence of a disposition is said rather than left blank: it is the ordinary
    // case for an interrupted or uncertain round, and a reader must not read silence as
    // "the planner concluded nothing was worth doing", which is a disposition of its own.
    expect(settled.body).toContain("recorded no disposition");

    const concluded = projectEvent(
      event({
        kind: "plan.round.settled",
        attemptId: null,
        subjectId: "rnd_live",
        payload: {
          status: "settled",
          settledBy: "supervisor",
          disposition: "actionable",
        },
      }),
    );
    expect(concluded.body).toContain("actionable");
    // And both carry the round itself, which is the planner chat's grouping key. It is the
    // subject on these two because they are host-originated with no caller at all.
    expect(started.roundId).toBe("rnd_live");
    expect(settled.roundId).toBe("rnd_live");
  });

  test("a record a round wrote is attributed to that round from its caller scope", () => {
    // The half that matters and the one nothing else could answer: an `intent.added` the
    // planner committed carries the *intent* as its subject and says nothing about the
    // round in its payload. `events.caller_scope` is the only column that does, and slice 4
    // namespaced a round's scope so this read is unambiguous rather than a guess.
    const planned = projectEvent(
      event({
        kind: "intent.added",
        callerScope: `${TARGET}/round/rnd_live`,
        attemptId: null,
        intentId: "int_planned",
        subjectId: "int_planned",
        payload: { question: "can the limiter be bypassed?" },
      }),
    );
    expect(planned.kind).toBe("intent.added");
    expect(planned.roundId).toBe("rnd_live");
    // Still no attempt: a round is not one, and the field is not borrowed.
    expect(planned.attemptId).toBeNull();
  });

  test("an operator's own intent belongs to no round, and is not filed under one", () => {
    // The whole reason this is read from the caller rather than inferred from the goal: a
    // hand-written intent and a planner's differ in exactly this column, and guessing would
    // put an operator's intent inside whichever round happened to be open.
    const byHand = projectEvent(
      event({
        kind: "intent.added",
        callerScope: `${TARGET}/operator`,
        attemptId: null,
        intentId: "int_hand",
        subjectId: "int_hand",
        payload: { question: "what does the login page set?" },
      }),
    );
    expect(byHand.roundId).toBeNull();

    // And a worker's observation, which has a two-segment attempt scope.
    expect(projectEvent(event({})).roundId).toBeNull();
  });

  test("an asset says whether it was new or already known", () => {
    const made = projectEvent(
      event({
        kind: "asset.recorded",
        payload: {
          kind: "endpoint",
          identity: "GET http://127.0.0.1:41317/a",
          created: true,
        },
      }),
    );
    expect(made.kind).toBe("asset.recorded");
    expect(made.body).toBe("endpoint GET http://127.0.0.1:41317/a");
    expect(made.outcome).toBe("new");
    expect(
      projectEvent(
        event({ kind: "asset.recorded", payload: { created: false } }),
      ).outcome,
    ).toBe("known");
  });

  test("an importer's entry reads as D3's receipt, and is filed under its import", () => {
    const importScope = `${TARGET}/import/imp_01`;
    const entry = (over: Record<string, unknown>) =>
      projectEvent(
        event({
          kind: "scope.entry.added",
          callerScope: importScope,
          intentId: null,
          attemptId: null,
          operation: "add_scope_entry",
          operationId: null,
          subjectId: "scope_1",
          payload: {
            entryId: "scope_1",
            effect: "in",
            kind: "subtree",
            value: "acme.com",
            source: "imported",
            note: null,
            ...over,
          },
        }),
      );
    const made = entry({ created: true });
    expect(made.kind).toBe("scope.entry.added");
    expect(made.importId).toBe("imp_01");
    expect(made.goalId).toBeNull();
    expect(made.roundId).toBeNull();
    expect(made.attemptId).toBeNull();
    expect(made.headline).toBe("acme.com");
    expect(made.body).toBe(
      "entry scope_1 created · in · subtree · acme.com and every subdomain",
    );
    expect(made.outcome).toBe("new");
    // The id its call's result names as `entry_id`, so a chat joins them by content.
    expect(made.writeId).toBe("scope_1");

    // A no-op add has a record too, and it must not read as an addition.
    const again = entry({ created: false });
    expect(again.body).toBe(
      "already in scope as entry scope_1 · in · subtree · acme.com and every subdomain · nothing changed",
    );
    expect(again.outcome).toBe("known");
    expect(again.writeId).toBe("scope_1");

    // An event written before `created` existed was always a real addition.
    expect(entry({}).outcome).toBe("new");
  });

  test("an entry the operator typed is not filed under any import", () => {
    const item = projectEvent(
      event({
        kind: "scope.entry.added",
        callerScope: `${TARGET}/operator`,
        intentId: null,
        attemptId: null,
        payload: {
          entryId: "scope_2",
          effect: "out",
          kind: "host",
          value: "a.test",
        },
      }),
    );
    expect(item.kind).toBe("scope.entry.added");
    expect(item.importId).toBeNull();
  });

  test("an imported asset names its page, and says when the estate already held it", () => {
    const asset = (created: boolean) =>
      projectEvent(
        event({
          kind: "asset.imported",
          callerScope: `${TARGET}/import/imp_02`,
          intentId: null,
          attemptId: null,
          operation: "import_asset",
          operationId: "op-asset-1",
          subjectId: "asset_1",
          payload: {
            assetId: "asset_1",
            kind: "host",
            identity: "app.acme.com",
            created,
            importedAs: "https://app.acme.com",
            sourceUrl: "https://hackerone.test/acme",
          },
        }),
      );
    const made = asset(true);
    expect(made.kind).toBe("asset.imported");
    expect(made.importId).toBe("imp_02");
    expect(made.headline).toBe("app.acme.com");
    expect(made.body).toBe(
      "app.acme.com recorded as a new host asset · read off https://hackerone.test/acme",
    );
    expect(made.outcome).toBe("new");
    // The `operation_id` its call was sent with — not the asset, which two calls can share.
    expect(made.writeId).toBe("op-asset-1");
    const known = asset(false);
    expect(known.body).toContain("already on the estate");
    expect(known.outcome).toBe("known");
  });

  test("an added intent reads as its question", () => {
    const item = projectEvent(
      event({
        kind: "intent.added",
        payload: { question: "Probe the account limiter." },
      }),
    );
    expect(item.kind).toBe("intent.added");
    expect(item.body).toBe("Probe the account limiter.");
    expect("writeId" in item).toBe(false);
  });

  test("a goal being added reads as its objective, with no attempt borrowed from its subject", () => {
    const item = projectEvent(
      event({
        kind: "goal.added",
        callerScope: "host",
        attemptId: null,
        intentId: null,
        subjectId: "goal-7",
        payload: { goalId: "goal-7", name: "", description: "Map the API." },
      }),
    );
    expect(item.kind).toBe("goal.added");
    expect(item.body).toBe("Map the API.");
    // `subject_id` is the goal here, and a goal is not an attempt.
    expect(item.attemptId).toBeNull();
  });

  test("a goal being ended says how, by whom and why", () => {
    const withReason = projectEvent(
      event({
        kind: "goal.ended",
        payload: { status: "met", endedBy: "operator", reason: "Confirmed." },
      }),
    );
    expect(withReason.kind).toBe("goal.ended");
    expect(withReason.outcome).toBe("met");
    expect(withReason.body).toBe(
      "The goal ended as met, ended by operator. Confirmed.",
    );
    const bare = projectEvent(
      event({
        kind: "goal.ended",
        payload: { status: "abandoned", endedBy: "operator", reason: "" },
      }),
    );
    expect(bare.body).toBe("The goal ended as abandoned, ended by operator.");
  });

  test("an intent being abandoned says so, with the reason and no attempt borrowed from its subject", () => {
    const withReason = projectEvent(
      event({
        kind: "intent.abandoned",
        callerScope: "host",
        attemptId: null,
        intentId: null,
        subjectId: "int-9",
        payload: {
          intentId: "int-9",
          goalId: "goal-7",
          reason: "Out of scope.",
        },
      }),
    );
    expect(withReason.kind).toBe("intent.abandoned");
    // Names the intent it is about, by id (this payload carries no question).
    expect(withReason.body).toBe(
      "The intent int-9 was abandoned. Out of scope.",
    );
    expect(withReason.attemptId).toBeNull();
    const bare = projectEvent(
      event({ kind: "intent.abandoned", payload: { reason: "" } }),
    );
    // Falls back to the subject, which is the intent for this kind.
    expect(bare.body).toBe("The intent obs-1 was abandoned.");
    const named = projectEvent(
      event({
        kind: "intent.abandoned",
        subjectId: "int-9",
        payload: {
          intentId: "int-9",
          question: "Does the limiter reset?",
          reason: "",
        },
      }),
    );
    // The question and the id both: a question can repeat and an id cannot.
    expect(named.body).toBe(
      "The intent \u201cDoes the limiter reset?\u201d (int-9) was abandoned.",
    );
  });

  test("a released claim says what the sweep found, and does not borrow an attempt", () => {
    const never = projectEvent(
      event({
        kind: "intent.released",
        callerScope: null,
        intentId: null,
        attemptId: null,
        subjectId: "int-9",
        payload: {
          intentId: "int-9",
          claimedByAttemptId: "att-3",
          attemptStatus: null,
        },
      }),
    );
    expect(never.kind).toBe("intent.released");
    expect(never.body).toContain("int-9");
    expect(never.body).toContain("att-3, which was never recorded");
    expect(never.body).toContain("It is open again.");
    expect(never.attemptId).toBeNull();
    const settled = projectEvent(
      event({
        kind: "intent.released",
        subjectId: "int-9",
        payload: {
          intentId: "int-9",
          claimedByAttemptId: "att-3",
          attemptStatus: "failed",
        },
      }),
    );
    expect(settled.body).toContain("settled as failed");
  });

  test("an event kind this build has never seen still appears, by name and in place", () => {
    const item = projectEvent(
      event({
        kind: "finding.promoted",
        sequence: 9,
        payload: { whatever: true },
      }),
    );
    // Not dropped. The record channel's sequence is a contiguous claim, and a hole in it is
    // the one thing a consumer reading `WHERE sequence > cursor` cannot tell from a loss.
    expect(item.kind).toBe("record.other");
    expect(item.headline).toBe("finding.promoted");
    expect(item.sequence).toBe(9);
    expect(item.body).toContain("finding.promoted");
  });

  test("a payload missing the fields this build reads produces blanks, not a failure", () => {
    // `event.ts` is explicit that a reader tolerates what it does not declare. A live
    // transcript that stopped at the first event written by a newer server would be the
    // opposite of that.
    const item = projectEvent(event({ payload: null }));
    expect(item.kind).toBe("observation.recorded");
    expect(item.body).toBe("");
    expect(item.outcome).toBeNull();
  });
});

/**
 * {@link projectNarration}, narrowed to the transcript item it produced.
 *
 * Narration no longer projects to one frame type: a `usage` entry becomes a `LiveUsage`
 * frame rather than an item, because it is a measurement about the session and not a turn
 * in it (`live.ts`). Every assertion in the block below is about an item, so the narrowing
 * is stated once here instead of at each field read — and a mapping that started answering
 * with something else would fail loudly rather than silently reading `undefined` fields.
 */
const projectedItem = (entry: RunNarration): LiveItem | undefined => {
  const frame = projectNarration(entry);
  if (frame === undefined) return undefined;
  if (frame._tag !== "item") {
    throw new Error(`expected a transcript item, got a '${frame._tag}' frame`);
  }
  return frame;
};

describe("projecting live activity", () => {
  test("a tool of ours is reduced to its bare name, on both drivers' forms", () => {
    /*
     * The bug this is the regression test for: the planner chat's merge rule is keyed on
     * `add_intent`, and against a real round it matched nothing — a planner's tools arrive
     * over MCP, so the harness reports the name the server registered plus its own
     * separator. Every write rendered twice, no write state was computed and `unresolved`
     * was unreachable.
     *
     * The reduction is done here, where the registration's own name is derivable from the
     * narration's subject, rather than guessed at in a browser from a separator. Both wire
     * forms below are recorded: Claude Code's was read out of a live round's DOM, and
     * OpenCode's `<server>.<tool>` from the harness's own refusal message in DECISIONS.md
     * §24.2 Q1.
     */
    const roundId = "rnd_live";
    const server = bitMcpServerName(roundId);
    for (const wire of [
      claudeCodeToolName(server, "add_intent"),
      openCodeToolName(server, "add_intent"),
    ]) {
      const item = projectedItem(
        narration(
          {
            _tag: "toolCall",
            callId: "toolu_01",
            tool: wire,
            input: '{"question":"can the limiter be bypassed?"}',
          },
          { subject: { _tag: "round", roundId } },
        ),
      );
      // Raw for a reader matching it against the harness's own log…
      expect(item?.tool).toBe(wire);
      // …and reduced for anything matching it in code.
      expect(item?.toolName).toBe("add_intent");
    }
  });

  test("a harness's own tool is left alone, and another round's prefix is not stripped", () => {
    // Only the prefix *this* application chose is removed. Taking "the segment after the
    // last separator" would have worked for both forms above and would also have renamed a
    // harness's own dotted tool, which is a misattribution a reader cannot see.
    const own = projectedItem(
      narration(
        { _tag: "toolCall", callId: "c1", tool: "bash", input: "{}" },
        { subject: { _tag: "round", roundId: "rnd_live" } },
      ),
    );
    expect(own?.toolName).toBe("bash");

    const foreign = projectedItem(
      narration(
        {
          _tag: "toolCall",
          callId: "c2",
          tool: claudeCodeToolName(bitMcpServerName("rnd_other"), "add_intent"),
          input: "{}",
        },
        { subject: { _tag: "round", roundId: "rnd_live" } },
      ),
    );
    // Not reachable today — a session is registered with its own round's server only — but
    // the reduction is anchored on this round's name rather than on "any bit- prefix", so a
    // name that is not this round's survives intact rather than being claimed.
    expect(foreign?.toolName).toBe(foreign?.tool);
  });

  test("a round's narration carries the round and no attempt, and an attempt's the reverse", () => {
    // Exactly one of the two is ever set, which is what the bus's tagged subject buys: a
    // publisher that cannot name which kind it is cannot publish, so neither field is a
    // slot left unfilled. The planner chat groups on the first of them.
    const fromRound = projectedItem(
      narration(
        { _tag: "reply", text: "two dimensions are untested" },
        { subject: { _tag: "round", roundId: "rnd_live" } },
      ),
    );
    expect(fromRound?.roundId).toBe("rnd_live");
    expect(fromRound?.attemptId).toBeNull();

    const fromAttempt = projectedItem(
      narration({ _tag: "reply", text: "running the probe" }),
    );
    expect(fromAttempt?.attemptId).toBe("attempt-1");
    expect(fromAttempt?.roundId).toBeNull();
  });

  test("an importer's narration carries its import and nothing else, and its tools are reduced", () => {
    // The fourth subject (the importer conversation design, S4). The chat files an entry by
    // this id alone, so none of the other three may be set — a goal or round chat on the
    // same page would otherwise claim the importer's words.
    const importId = "imp_live";
    const reply = projectedItem(
      narration(
        { _tag: "reply", text: "Reading the policy page." },
        { subject: { _tag: "import", importId } },
      ),
    );
    expect(reply?.importId).toBe(importId);
    expect(reply?.attemptId).toBeNull();
    expect(reply?.roundId).toBeNull();
    expect(reply?.goalId).toBeNull();

    // The registration is `bit-<importId>`, so the same reduction applies.
    const call = projectedItem(
      narration(
        {
          _tag: "toolCall",
          callId: "c1",
          tool: openCodeToolName(bitMcpServerName(importId), "add_scope_entry"),
          input: "{}",
        },
        { subject: { _tag: "import", importId } },
      ),
    );
    expect(call?.toolName).toBe("add_scope_entry");
  });

  test("a reply reads as a turn, with no sequence", () => {
    const item = projectedItem(
      narration({ _tag: "reply", text: "I will probe the limiter." }),
    );
    expect(item?.kind).toBe("turn.reply");
    expect(item?.body).toBe("I will probe the limiter.");
    expect(item?.origin).toBe("activity");
    // The whole promise of the activity channel: it claims no position.
    expect(item?.sequence).toBeNull();
    expect(item?.id).toBe("activity:1");
  });

  test("a tool call shows its name and its arguments", () => {
    const item = projectedItem(
      narration({
        _tag: "toolCall",
        callId: "call-1",
        tool: "bash",
        input: '{"command":"curl -s http://127.0.0.1:41317/login"}',
      }),
    );
    expect(item?.kind).toBe("tool.call");
    expect(item?.headline).toBe("bash");
    expect(item?.tool).toBe("bash");
    expect(item?.input).toBe(
      '{"command":"curl -s http://127.0.0.1:41317/login"}',
    );
    expect(item?.output).toBeNull();
  });

  test("a tool result shows its output, and says when the harness called it a failure", () => {
    const ok = projectedItem(
      narration({
        _tag: "toolResult",
        callId: "call-1",
        tool: "bash",
        output: "HTTP/1.1 429 Too Many Requests",
        failed: false,
      }),
    );
    expect(ok?.kind).toBe("tool.result");
    expect(ok?.output).toBe("HTTP/1.1 429 Too Many Requests");
    expect(ok?.outcome).toBe("ok");

    const failed = projectedItem(
      narration({
        _tag: "toolResult",
        callId: "call-1",
        tool: "bash",
        output: "command not found",
        failed: true,
      }),
    );
    expect(failed?.outcome).toBe("failed");
  });

  /**
   * Two calls in flight, answered the other way round.
   *
   * Both harnesses run tools concurrently, so results do not arrive in call order and two
   * calls to the same tool are indistinguishable by name. `callId` is what pairs them —
   * and for Claude Code it is the *only* thing available, because a `tool_result` block
   * carries no tool name at all.
   */
  test("concurrent calls keep their own ids when their results come back reversed", () => {
    const projected = [
      narration(
        { _tag: "toolCall", callId: "c1", tool: "bash", input: '{"url":"a"}' },
        { id: 1 },
      ),
      narration(
        { _tag: "toolCall", callId: "c2", tool: "bash", input: '{"url":"b"}' },
        { id: 2 },
      ),
      narration(
        {
          _tag: "toolResult",
          callId: "c2",
          tool: "bash",
          output: "from b",
          failed: false,
        },
        { id: 3 },
      ),
      narration(
        {
          _tag: "toolResult",
          callId: "c1",
          tool: "bash",
          output: "from a",
          failed: true,
        },
        { id: 4 },
      ),
    ].map((item) => projectedItem(item));

    expect(projected.map((item) => [item?.kind, item?.callId])).toEqual([
      ["tool.call", "c1"],
      ["tool.call", "c2"],
      ["tool.result", "c2"],
      ["tool.result", "c1"],
    ]);
    // Pairing on the id gives the right answer; pairing on `tool` would give whichever call
    // to `bash` came first, which is a command's output attributed to the wrong command.
    const paired = (callId: string) =>
      projected
        .filter((item) => item?.callId === callId)
        .map((item) => item?.output ?? item?.input);
    expect(paired("c1")).toEqual(['{"url":"a"}', "from a"]);
    expect(paired("c2")).toEqual(['{"url":"b"}', "from b"]);
    // And the failure is on the right one of the two.
    expect(projected[3]?.outcome).toBe("failed");
    expect(projected[2]?.outcome).toBe("ok");
  });

  test("nothing but a tool call or its result carries a call id", () => {
    expect(
      projectedItem(narration({ _tag: "reply", text: "hello" }))?.callId,
    ).toBeNull();
    // A refusal cannot carry one: the gate's request has a session id, a tool name and the
    // arguments, and no call id — the hook is a plugin inside the harness and the harness
    // does not tell it which of its own calls this is.
    expect(projectDecision(denial(), "attempt-1")?.callId).toBeNull();
    expect(projectEvent(event()).callId).toBeNull();
  });

  test("a call the harness had not named says so rather than borrowing one", () => {
    const item = projectedItem(
      narration({
        _tag: "toolCall",
        callId: "call-1",
        tool: undefined,
        input: "{}",
      }),
    );
    expect(item?.tool).toBeNull();
    expect(item?.headline).toBe("Tool call");
    expect(item?.body).toContain("had not yet named");
    // The name is missing and the pairing is not: an unnamed call is still the call its
    // result answers.
    expect(item?.callId).toBe("call-1");
  });

  test("a result whose call was never named keeps the id that pairs it", () => {
    const item = projectedItem(
      narration({
        _tag: "toolResult",
        callId: "orphan",
        tool: undefined,
        output: "done",
        failed: false,
      }),
    );
    // The id survives even when the name does not, which is the case that matters: a reader
    // can still pair it with the call that *does* carry a name.
    expect(item?.callId).toBe("orphan");
    expect(item?.tool).toBeNull();
  });

  test("an opaque entry and an empty reply are dropped", () => {
    // Most of what a harness narrates is a token delta or a step boundary. Dropping those
    // is sound on a channel that never claims to be complete, and is what keeps one frame
    // per reply block on the wire instead of hundreds per turn.
    expect(projectedItem(narration({ _tag: "opaque" }))).toBeUndefined();
    expect(
      projectedItem(narration({ _tag: "reply", text: "   " })),
    ).toBeUndefined();
  });

  test("thinking is its own kind, carrying the text and claiming nothing", () => {
    const item = projectedItem(
      narration({ _tag: "thinking", text: "The limiter is probably per-IP." }),
    );
    expect(item?.kind).toBe("turn.thinking");
    expect(item?.headline).toBe("Thinking");
    expect(item?.body).toBe("The limiter is probably per-IP.");
    // `activity`, like every other narration item: thinking is streamed and never stored,
    // so it has no position and nothing to resume from.
    expect(item?.origin).toBe("activity");
    expect(item?.sequence).toBeNull();
    // It is not a tool call and not a result; nothing about it is a thing that happened.
    expect(item?.callId).toBeNull();
    expect(item?.tool).toBeNull();
    expect(item?.outcome).toBeNull();
  });

  test("an empty thinking block produces nothing at all", () => {
    // Both drivers close a block they put nothing in — the probe's own run produced
    // `{ type: "thinking", thinking: "" }` — and a row saying the agent thought nothing
    // would be a claim about the model rather than a fact about the stream.
    expect(
      projectedItem(narration({ _tag: "thinking", text: "" })),
    ).toBeUndefined();
    expect(
      projectedItem(narration({ _tag: "thinking", text: " \n  " })),
    ).toBeUndefined();
  });

  test("a partial is its block's kind, streaming, with the block's id under its session", () => {
    // A6 F6: the whole text so far, and the id the finished block will share.
    const partial = projectedItem(
      narration({
        _tag: "partial",
        blockId: "msg_1:0",
        channel: "reply",
        text: "I will probe",
      }),
    );
    const finished = projectedItem(
      narration(
        {
          _tag: "reply",
          text: "I will probe the limiter.",
          blockId: "msg_1:0",
        },
        { id: 2 },
      ),
    );
    const thinking = projectedItem(
      narration({
        _tag: "partial",
        blockId: "msg_1:1",
        channel: "thinking",
        text: "Per-IP?",
      }),
    );
    expect(partial).toMatchObject({
      kind: "turn.reply",
      headline: "Reply",
      body: "I will probe",
      streaming: true,
      blockId: "ses_abc:msg_1:0",
      origin: "activity",
      sequence: null,
      id: "activity:1",
    });
    // The finished block shares the block id and is not streaming: it replaces the partial.
    expect(finished?.blockId).toBe(partial?.blockId);
    expect(finished?.streaming).toBeUndefined();
    expect(finished?.id).toBe("activity:2");
    expect(thinking).toMatchObject({
      kind: "turn.thinking",
      headline: "Thinking",
      streaming: true,
    });
    // Neither carries a call where the driver named none.
    expect(partial !== undefined && "blockCall" in partial).toBe(false);
    // A block nothing streamed carries neither field, so an old reader sees what it did.
    const plain = projectedItem(narration({ _tag: "reply", text: "Done." }));
    expect(plain !== undefined && "blockId" in plain).toBe(false);
    expect(plain !== undefined && "streaming" in plain).toBe(false);
  });

  test("U5 review: a block's model call is on the wire, under its session, the same on its partial, its finished copy and its replay", () => {
    const partial = projectedItem(
      narration({
        _tag: "partial",
        blockId: "msg_1:text:0",
        call: "msg_1",
        channel: "reply",
        text: "I will",
      }),
    );
    const thought = projectedItem(
      narration(
        {
          _tag: "thinking",
          text: "Per-IP?",
          blockId: "msg_1:reasoning:0",
          call: "msg_1",
        },
        { id: 2 },
      ),
    );
    const replayed = projectReplay({
      entries: [
        {
          type: "assistant",
          text: "",
          error: undefined,
          parts: [
            {
              _tag: "reply",
              text: "I will probe.",
              blockId: "msg_1:text:0",
              call: "msg_1",
            },
          ],
          model: undefined,
          at: 1,
        },
      ],
      subject: { _tag: "import", importId: "imp_1" },
      harnessSessionId: "ses_abc",
      users: "operator",
      fallbackAt: 0,
    }).items[0];
    expect(partial?.blockCall).toBe("ses_abc:msg_1");
    expect(thought?.blockCall).toBe("ses_abc:msg_1");
    expect(replayed?.blockCall).toBe("ses_abc:msg_1");
    // And it survives the wire.
    const wire = JSON.parse(
      JSON.stringify(Schema.encodeUnknownSync(LiveFrame)(partial)),
    ) as unknown;
    expect(
      (Schema.decodeUnknownSync(LiveFrame)(wire) as LiveItem).blockCall,
    ).toBe("ses_abc:msg_1");
  });

  test("a delta is never on the wire, and an empty partial is nothing", () => {
    expect(
      projectedItem(
        narration({
          _tag: "delta",
          blockId: "b1",
          channel: "reply",
          text: "I will",
        }),
      ),
    ).toBeUndefined();
    expect(
      projectedItem(
        narration({
          _tag: "partial",
          blockId: "b1",
          channel: "reply",
          text: " ",
        }),
      ),
    ).toBeUndefined();
  });

  test("a partial decodes, and a reader one deploy behind reads it as an ordinary reply", () => {
    const partial = projectedItem(
      narration({
        _tag: "partial",
        blockId: "b1",
        channel: "reply",
        text: "I will probe",
      }),
    );
    // Through the wire's own encoding and back, as the browser decodes a frame.
    const wire = JSON.parse(
      JSON.stringify(Schema.encodeUnknownSync(LiveFrame)(partial)),
    ) as unknown;
    expect(Schema.decodeUnknownSync(LiveFrame)(wire)).toEqual(
      partial as LiveItem,
    );
    // The item as a build without the two fields declares it: they are ignored, not refused.
    const Before = Schema.Struct(
      Struct.omit(LiveItemSchema.fields, ["blockId", "streaming"]),
    );
    const old = Schema.decodeUnknownSync(Before)(wire);
    expect(old.kind).toBe("turn.reply");
    expect(old.body).toBe("I will probe");
    // A frame from a build without them still decodes on this one.
    const older = Struct.omit(wire as Record<string, unknown>, [
      "blockId",
      "streaming",
    ]);
    expect(
      Schema.decodeUnknownSync(LiveItemSchema)(older).streaming,
    ).toBeUndefined();
    // `streaming` is only ever `true`: absence, not `false`, is "finished".
    expect(() =>
      Schema.decodeUnknownSync(LiveItemSchema)({ ...older, streaming: false }),
    ).toThrow();
  });

  test("U4: a steer taken is an item carrying the message's id, and nothing to read", () => {
    const item = projectedItem(
      narration(
        { _tag: "taken", messageIds: ["aaaaaaaabbbbbbbbccccccccdddddddd"] },
        { subject: { _tag: "import", importId: "imp_1" } },
      ),
    );
    expect(item?.kind).toBe("turn.taken");
    expect(item?.messageIds).toEqual(["aaaaaaaabbbbbbbbccccccccdddddddd"]);
    expect(item?.body).toBe("");
    expect(item?.importId).toBe("imp_1");
  });

  test("U4: a harness's error is the item a replay draws for one, its sentence as the body", () => {
    const live = projectedItem(
      narration(
        { _tag: "error", message: "Free usage limit reached." },
        { subject: { _tag: "import", importId: "imp_1" } },
      ),
    );
    const replayed = projectReplay({
      entries: [
        {
          type: "assistant",
          text: "",
          error: "Free usage limit reached.",
          parts: [],
          model: undefined,
          at: 1_700_000_000_000,
        },
      ],
      subject: { _tag: "import", importId: "imp_1" },
      harnessSessionId: "ses_1",
      users: "operator",
      fallbackAt: 0,
    }).items[0];
    const drawn = (item: LiveItem | undefined) => ({
      kind: item?.kind,
      headline: item?.headline,
      body: item?.body,
      outcome: item?.outcome,
    });
    expect(drawn(live)).toEqual({
      kind: "turn.other",
      headline: "error",
      body: "Free usage limit reached.",
      outcome: "failed",
    });
    expect(drawn(replayed)).toEqual(drawn(live));
  });

  test("U4 review 2: a replayed message carries the application's ids the driver named, and only those", () => {
    const user = (text: string, ...messageIds: string[]) => ({
      type: "user",
      text,
      error: undefined,
      parts: [],
      model: undefined,
      at: 1_700_000_000_000,
      ...(messageIds.length === 0 ? {} : { messageIds }),
    });
    const items = projectReplay({
      entries: [
        user("the opening"),
        user("and the portal", "aaaaaaaabbbbbbbbccccccccdddddddd"),
        // Two steers the harness took as one and stored as one entry (review 3).
        user(
          "MG-PAGE\nMG-OTHER",
          "11111111222222223333333344444444",
          "55555555666666667777777788888888",
        ),
      ],
      subject: { _tag: "import", importId: "imp_1" },
      harnessSessionId: "ses_1",
      users: "operator",
      fallbackAt: 0,
    }).items;
    // Three messages in a row, nothing between: each but the last carried on with the next
    // (U6 review 2), the carry naming what the message it follows names.
    expect(items.map((item) => [item.kind, item.messageIds ?? null])).toEqual([
      ["turn.operator", null],
      ["turn.carried", null],
      ["turn.operator", ["aaaaaaaabbbbbbbbccccccccdddddddd"]],
      ["turn.carried", ["aaaaaaaabbbbbbbbccccccccdddddddd"]],
      [
        "turn.operator",
        [
          "11111111222222223333333344444444",
          "55555555666666667777777788888888",
        ],
      ],
    ]);
  });

  test("U6 review 2: a message stored directly before another is carried on with it; the last one, and one a Stop ended, are not", () => {
    const at = 1_700_000_000_000;
    const user = (
      text: string,
      extra: { messageIds?: string[]; marker?: "interrupted" } = {},
    ) => ({
      type: "user",
      text,
      error: undefined,
      parts: [],
      model: undefined,
      at,
      ...extra,
    });
    const reply = (text: string) => ({
      type: "assistant",
      text,
      error: undefined,
      parts: [{ _tag: "reply" as const, text }],
      model: "claude-haiku-4-5",
      at,
    });
    const drawn = (entries: Parameters<typeof projectReplay>[0]["entries"]) =>
      projectReplay({
        entries,
        subject: { _tag: "import", importId: "imp_1" },
        harnessSessionId: "ses_1",
        users: "operator",
        fallbackAt: 0,
      }).items.map((item) =>
        item.kind === "turn.carried"
          ? `carried ${(item.messageIds ?? []).join(",")}`
          : `${item.kind}: ${item.body}`,
      );
    // What Claude Code stores when a Send now cuts a turn before it wrote anything.
    expect(
      drawn([
        user("What is 2+2?", { messageIds: ["a".repeat(32)] }),
        user("Also name a colour.", { messageIds: ["b".repeat(32)] }),
        reply("Four. Blue."),
      ]),
    ).toEqual([
      "turn.operator: What is 2+2?",
      `carried ${"a".repeat(32)}`,
      "turn.operator: Also name a colour.",
      "turn.reply: Four. Blue.",
    ]);
    // The session's last message: nothing follows it, so it is still unanswered.
    expect(drawn([user("hello"), reply("hi"), user("are you there?")])).toEqual(
      [
        "turn.operator: hello",
        "turn.reply: hi",
        "turn.operator: are you there?",
      ],
    );
    // One a Stop ended: the CLI's interrupt marker is between, and the next message is a
    // turn of its own.
    expect(
      drawn([
        user("count to a hundred"),
        user("[Request interrupted by user]", { marker: "interrupted" }),
        user("never mind"),
        reply("ok"),
      ]),
    ).toEqual([
      "turn.operator: count to a hundred",
      "turn.other: [Request interrupted by user]",
      "turn.operator: never mind",
      "turn.reply: ok",
    ]);
  });

  test("U6 review 2: a turn carried on with the next message is a `turn.carried` item naming its message, with nothing to read", () => {
    const frame = projectNarration(
      narration(
        { _tag: "carried", messageIds: ["a".repeat(32)] },
        { subject: { _tag: "import", importId: "imp_1" } },
      ),
    );
    expect(frame?._tag).toBe("item");
    const item = frame as LiveItem;
    expect([item.kind, item.body, item.messageIds, item.importId]).toEqual([
      "turn.carried",
      "",
      ["a".repeat(32)],
      "imp_1",
    ]);
    // The opening prompt has no id: the item names none, and a chat places it by where it is.
    const opening = projectNarration(
      narration(
        { _tag: "carried", messageIds: [] },
        { subject: { _tag: "import", importId: "imp_1" } },
      ),
    ) as LiveItem;
    expect(opening.messageIds).toBeUndefined();
  });

  test("a usage entry is a frame of its own, not a row in the transcript", () => {
    /*
     * A measurement about the session rather than a turn in it. If this were an item it
     * would be a row per model call in every chat on the page, and the numbers would have
     * to travel in `LiveItem`'s string fields for a browser to parse back out.
     */
    const frame = projectNarration(
      narration(
        {
          _tag: "usage",
          callId: "msg_1",
          promptTokens: 13_572,
          outputTokens: 53,
          contextLimit: 200_000,
          model: "claude-sonnet-5",
          compactionAt: 170_000,
        },
        { subject: { _tag: "round", roundId: "rnd_7" } },
      ),
    );
    expect(frame).toEqual({
      _tag: "usage",
      callId: "msg_1",
      promptTokens: 13_572,
      outputTokens: 53,
      contextLimit: 200_000,
      compactionAt: 170_000,
      // The call's own model: what a meter compares figures by (U9 review 2).
      model: "claude-sonnet-5",
      // The attribution a page with two agents on it needs to tell one meter from the
      // other. Taken from the bus's own tagged subject, never from the harness's payload.
      attemptId: null,
      roundId: "rnd_7",
      goalId: null,
      importId: null,
      at: 1_700_000_000_000,
    });
  });

  test("an unstated output count and an unknown window arrive as null, not as zero", () => {
    // `undefined` on the seam becomes `null` on the wire, which is what keeps "we have not
    // been told" from arriving as a number somebody adds to a total.
    const frame = projectNarration(
      narration({
        _tag: "usage",
        callId: "msg_2",
        promptTokens: 21_388,
        outputTokens: undefined,
        contextLimit: undefined,
        model: undefined,
        compactionAt: undefined,
      }),
    );
    expect(frame?._tag).toBe("usage");
    if (frame?._tag !== "usage") throw new Error("expected a usage frame");
    expect(frame.outputTokens).toBeNull();
    expect(frame.contextLimit).toBeNull();
    // The same for the harness's own threshold: "we have not been told" must not arrive as
    // a number a bar could be marked at.
    expect(frame.compactionAt).toBeNull();
    expect(frame.model).toBeNull();
    expect(frame.promptTokens).toBe(21_388);
  });

  test("a denied action reads as denied, with the gate's own reason", () => {
    const item = projectDecision(denial(), "attempt-1");
    expect(item?.kind).toBe("action.denied");
    expect(item?.headline).toBe("Denied");
    expect(item?.outcome).toBe("denied");
    expect(item?.tool).toBe("bash");
    // The gate's sentence, unsoftened: it is the only description of this refusal there is.
    expect(item?.body).toBe("host 'out-of-scope.test' is not in scope");
    expect(item?.input).toContain("out-of-scope.test");
    expect(item?.sequence).toBeNull();
  });

  test("an allowed action is not projected at all", () => {
    // Not an omission: a permitted call is already on this stream as `tool.call`, carrying
    // the same tool and the same arguments from the harness's own narration, so the gate's
    // agreement beside it would show one tool call as two items.
    const allowed = projectDecision(
      denial({ decision: { effect: "allow", basis: "unrestricted" } }),
      "attempt-1",
    );
    expect(allowed).toBeUndefined();
  });
});

/* ── 2. Ordered delivery behind a cursor, on a real file ─────────────────────── */

describe("ordered delivery behind a durable cursor", () => {
  test("committed events arrive in store-assigned order, once each, with no gaps", async () => {
    const path = newDatabasePath();
    const frames = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* seed(store);
        yield* store.recordAsset(CALLER, assetInput("a"));
        yield* store.recordObservation(
          CALLER,
          multiCaseInput({ operationId: "o-1" }),
        );
        yield* store.recordAsset(CALLER, assetInput("b"));
        return yield* Effect.promise(() =>
          framesUntil(over(store, { cursor: 0 }), caughtUp),
        );
      }),
    );

    const recorded = records(frames);
    // Ascending, contiguous, and in the order the store assigned inside its own
    // transactions. This is the day's headline claim and it is checked against real rows.
    expect(recorded.map((item) => item.sequence)).toEqual([1, 2, 3, 4]);
    expect(recorded.map((item) => item.kind)).toEqual([
      "run.started",
      "asset.recorded",
      "observation.recorded",
      "asset.recorded",
    ]);
    // Nothing appears twice.
    expect(new Set(recorded.map((item) => item.id)).size).toBe(recorded.length);
  });

  test("the opening frame says where it is reading from and what it skipped", async () => {
    const path = newDatabasePath();
    const frames = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* seed(store);
        yield* store.recordAsset(CALLER, assetInput("a"));
        yield* store.recordAsset(CALLER, assetInput("b"));
        return yield* Effect.promise(() =>
          framesUntil(over(store, { cursor: 0 }), caughtUp),
        );
      }),
    );
    const opened = frames[0];
    expect(opened?._tag).toBe("opened");
    if (opened?._tag !== "opened") throw new Error("no opening frame");
    expect(opened.targetId).toBe(TARGET);
    expect(opened.from).toBe(0);
    expect(opened.latest).toBe(3);
    // A client that passed a cursor is answered from exactly there, so nothing was withheld.
    expect(opened.skipped).toBe(0);
  });

  test("a client with no cursor is answered from the replay budget, and told what it missed", async () => {
    const path = newDatabasePath();
    const frames = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* seed(store);
        yield* store.recordAsset(CALLER, assetInput("a"));
        yield* store.recordAsset(CALLER, assetInput("b"));
        yield* store.recordAsset(CALLER, assetInput("c"));
        // Four events committed; a budget of one means only the newest is sent.
        return yield* Effect.promise(() =>
          framesUntil(over(store, { replayBudget: 1 }), caughtUp),
        );
      }),
    );
    const opened = frames[0];
    if (opened?._tag !== "opened") throw new Error("no opening frame");
    expect(opened.latest).toBe(4);
    expect(opened.from).toBe(3);
    // Said rather than swallowed: a transcript that looked complete and began part way
    // through the record would be the wrong kind of quiet.
    expect(opened.skipped).toBe(3);
    expect(records(frames).map((item) => item.sequence)).toEqual([4]);
  });

  test("a cursor is honoured exactly: only what committed after it is sent", async () => {
    const path = newDatabasePath();
    const frames = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* seed(store);
        yield* store.recordAsset(CALLER, assetInput("a"));
        yield* store.recordAsset(CALLER, assetInput("b"));
        return yield* Effect.promise(() =>
          framesUntil(over(store, { cursor: 2 }), caughtUp),
        );
      }),
    );
    expect(records(frames).map((item) => item.sequence)).toEqual([3]);
  });

  test("a nonsense cursor reads from the start rather than killing the connection", async () => {
    const path = newDatabasePath();
    const frames = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* seed(store);
        return yield* Effect.promise(() =>
          framesUntil(over(store, { cursor: -5.5 }), caughtUp),
        );
      }),
    );
    // A query string can only ask for *more* history than exists, so it is clamped. A
    // refusal here would turn a harmless URL into a dead screen.
    expect(records(frames).map((item) => item.sequence)).toEqual([1]);
  });

  test("paging does not reorder, repeat or drop anything", async () => {
    const path = newDatabasePath();
    const frames = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* seed(store);
        yield* store.recordAsset(CALLER, assetInput("a"));
        yield* store.recordAsset(CALLER, assetInput("b"));
        yield* store.recordAsset(CALLER, assetInput("c"));
        yield* store.recordAsset(CALLER, assetInput("d"));
        // One row per read, so the cursor is advanced five times rather than once.
        return yield* Effect.promise(() =>
          framesUntil(over(store, { cursor: 0, page: 1 }), caughtUp),
        );
      }),
    );
    const recorded = records(frames);
    expect(recorded.map((item) => item.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(recorded.map((item) => item.id)).size).toBe(5);
    // A full page must not claim to be caught up, or a long catch-up would look finished
    // while it was still arriving.
    const cursors = frames.filter((frame) => frame._tag === "cursor");
    expect(cursors.slice(0, 4).every((frame) => !frame.caughtUp)).toBe(true);
    expect(cursors[cursors.length - 1]?.caughtUp).toBe(true);
  });

  test("a caught-up reader picks up what commits next, without being told", async () => {
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* seed(store);
        const stream = over(store, { cursor: 0 });
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const queue = yield* Queue.unbounded<LiveFrame>();
            const fiber = yield* Effect.forkScoped(
              Stream.runForEach(stream, (frame) => Queue.offer(queue, frame)),
            );
            const collected: LiveFrame[] = [];
            const until = (done: (frames: readonly LiveFrame[]) => boolean) =>
              Effect.timeout(
                Effect.gen(function* () {
                  while (!done(collected))
                    collected.push(yield* Queue.take(queue));
                }),
                "10 seconds",
              ).pipe(Effect.orDie);

            yield* until(caughtUp);
            expect(records(collected).map((item) => item.sequence)).toEqual([
              1,
            ]);

            // Committed while the reader is sitting on a caught-up cursor. There is no
            // notification: the next bounded sweep reads the row. That is §8's guarantee —
            // a crash between commit and notification cannot strand committed work,
            // because nothing was ever notified.
            yield* store.recordAsset(CALLER, assetInput("late"));
            yield* until((frames) => records(frames).length === 2);
            yield* Fiber.interrupt(fiber);
            return records(collected).map((item) => item.sequence);
          }),
        );
      }),
    );
    expect(outcome).toEqual([1, 2]);
  });

  test("reconnecting after a cursor shows nothing the first connection already showed", async () => {
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* seed(store);
        yield* store.recordAsset(CALLER, assetInput("a"));
        yield* store.recordAsset(CALLER, assetInput("b"));

        const first = yield* Effect.promise(() =>
          framesUntil(
            over(store, { cursor: 0, page: 2 }),
            (frames) =>
              // Stopped deliberately part way through, as a dropped connection would.
              records(frames).length >= 2,
          ),
        );
        const seen = records(first);
        const cursor = seen[seen.length - 1]?.sequence ?? 0;

        yield* store.recordAsset(CALLER, assetInput("c"));
        const second = yield* Effect.promise(() =>
          framesUntil(over(store, { cursor }), caughtUp),
        );
        return {
          firstIds: seen.map((item) => item.id),
          secondIds: records(second).map((item) => item.id),
          secondSequences: records(second).map((item) => item.sequence),
        };
      }),
    );

    // The second connection resumes strictly after the last item the first one delivered,
    // so the gap is filled and nothing is repeated. This is the protocol Day 7 builds on.
    expect(outcome.secondSequences).toEqual([3, 4]);
    expect(
      outcome.secondIds.filter((id) => outcome.firstIds.includes(id)),
    ).toEqual([]);
  });

  test("an id is the same string on a second read of the same event", async () => {
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* seed(store);
        yield* store.recordAsset(CALLER, assetInput("a"));
        const once = yield* Effect.promise(() =>
          framesUntil(over(store, { cursor: 0 }), caughtUp),
        );
        const twice = yield* Effect.promise(() =>
          framesUntil(over(store, { cursor: 0 }), caughtUp),
        );
        return {
          once: records(once).map((item) => item.id),
          twice: records(twice).map((item) => item.id),
        };
      }),
    );
    // Which is the thing that makes a client's "I have shown this already" work across
    // connections — and therefore makes re-reading a range invisible to the operator.
    expect(outcome.twice).toEqual(outcome.once);
  });

  test("the counts the header shows and the record the transcript shows agree", async () => {
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* seed(store);
        yield* store.recordObservation(
          CALLER,
          multiCaseInput({ operationId: "o-1" }),
        );
        const frames = yield* Effect.promise(() =>
          framesUntil(over(store, { cursor: 0 }), caughtUp),
        );
        return { counts: yield* store.counts(), frames };
      }),
    );
    // One event per committed mutation, and the transcript shows every one of them: the
    // `events` count and the length of the record channel are the same number or something
    // is being filtered that should not be.
    const counts: StoredCounts = outcome.counts;
    expect(records(outcome.frames)).toHaveLength(counts.events);
  });
});

/* ── 3. The two channels together ────────────────────────────────────────────── */

describe("the record and live activity, together", () => {
  test("an activity item claims no position, and a record item does", async () => {
    const path = newDatabasePath();
    const frames = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* seed(store);
        return yield* Effect.promise(() =>
          framesUntil(
            over(store, {
              cursor: 0,
              narrations: narrationsFrom([
                narration({ _tag: "reply", text: "Starting." }),
                narration(
                  { _tag: "toolCall", callId: "c1", tool: "bash", input: "{}" },
                  { id: 2 },
                ),
              ]),
            }),
            (collected) =>
              items(collected).filter((item) => item.origin === "activity")
                .length >= 2 && caughtUp(collected),
          ),
        );
      }),
    );
    const all = items(frames);
    const activity = all.filter((item) => item.origin === "activity");
    expect(activity.map((item) => item.kind)).toEqual([
      "turn.reply",
      "tool.call",
    ]);
    expect(activity.every((item) => item.sequence === null)).toBe(true);
    expect(
      all
        .filter((item) => item.origin === "record")
        .every((item) => item.sequence !== null),
    ).toBe(true);
  });

  test("partials reach only a stream that asked, and move no cursor", async () => {
    // A6 F6. The record's cursor frames are the same with partials as without: a partial
    // has no position, so a reconnect resumes exactly where it would have.
    const streamed = narrationsFrom([
      narration({
        _tag: "partial",
        blockId: "b1",
        channel: "reply",
        text: "Starting",
      }),
      narration({ _tag: "reply", text: "Starting.", blockId: "b1" }, { id: 2 }),
    ]);
    const read = (partials: boolean) =>
      withStore(newDatabasePath(), (store) =>
        Effect.gen(function* () {
          yield* seed(store);
          return yield* Effect.promise(() =>
            framesUntil(
              over(store, { cursor: 0, narrations: streamed, partials }),
              (collected) =>
                items(collected).some(
                  (item) =>
                    item.body === "Starting." && item.origin === "activity",
                ) && caughtUp(collected),
            ),
          );
        }),
      );
    const without = await read(false);
    const asked = await read(true);
    const activity = (frames: readonly LiveFrame[]) =>
      items(frames)
        .filter((item) => item.origin === "activity")
        .map((item) => [item.body, item.streaming ?? false, item.sequence]);
    expect(activity(without)).toEqual([["Starting.", false, null]]);
    expect(activity(asked)).toEqual([
      ["Starting", true, null],
      ["Starting.", false, null],
    ]);
    const cursors = (frames: readonly LiveFrame[]) =>
      frames.flatMap((frame) =>
        frame._tag === "cursor" ? [frame.sequence] : [],
      );
    expect(cursors(asked)).toEqual(cursors(without));
    expect(records(asked).map((item) => item.id)).toEqual(
      records(without).map((item) => item.id),
    );
  });

  test("A7 U8b review: a turn's end is a frame of its own, after whatever its entry drew, even when that is nothing", async () => {
    // OpenCode ends a turn on an `opaque` entry and Claude Code on a `usage` one: a client
    // watching items alone never learned the turn was over.
    const ended = (detail: NarrationDetail, id: number): RunNarration => {
      const base = narration(detail, {
        id,
        subject: { _tag: "import", importId: "imp_1" },
      });
      return { ...base, entry: { ...base.entry, outcome: "succeeded" } };
    };
    const streamed = narrationsFrom([
      narration({ _tag: "reply", text: "Done." }, { id: 1 }),
      ended({ _tag: "opaque" }, 2),
      ended({ _tag: "error", message: "Free usage limit reached" }, 3),
    ]);
    const frames = await withStore(newDatabasePath(), (store) =>
      Effect.gen(function* () {
        yield* seed(store);
        return yield* Effect.promise(() =>
          framesUntil(
            over(store, { cursor: 0, narrations: streamed }),
            (collected) =>
              collected.filter((frame) => frame._tag === "turnEnded").length ===
                2 && caughtUp(collected),
          ),
        );
      }),
    );
    const activity = frames.filter(
      (frame) =>
        frame._tag === "turnEnded" ||
        (frame._tag === "item" && frame.origin === "activity"),
    );
    expect(
      activity.map((frame) =>
        frame._tag === "turnEnded"
          ? ["turnEnded", frame.importId, frame.attemptId]
          : frame._tag === "item"
            ? ["item", frame.body]
            : [frame._tag],
      ),
    ).toEqual([
      ["item", "Done."],
      ["turnEnded", "imp_1", null],
      ["item", "Free usage limit reached"],
      ["turnEnded", "imp_1", null],
    ]);
  });

  test("a turn's end decodes as a live frame, and an entry without an outcome makes none", () => {
    const base = narration({ _tag: "opaque" });
    expect(turnEndedFrame(base)).toBeUndefined();
    const frame = turnEndedFrame({
      ...base,
      entry: { ...base.entry, outcome: "interrupted" },
    });
    expect(frame).toEqual({
      _tag: "turnEnded",
      attemptId: "attempt-1",
      roundId: null,
      goalId: null,
      importId: null,
      at: base.entry.at,
    });
    expect(Schema.decodeUnknownSync(LiveFrame)(frame)).toEqual(
      frame as LiveFrame,
    );
  });

  test("a narration connection's break and return are frames about the session, not rows (U13 review 5)", () => {
    for (const state of ["reconnecting", "restored", "lost"] as const) {
      const base = narration({
        _tag: "connection",
        state,
        reason: state === "restored" ? "" : "socket closed",
      });
      const frame = projectNarration(base);
      expect(frame).toEqual({
        _tag: "connection",
        state,
        detail: state === "restored" ? "" : "socket closed",
        attemptId: "attempt-1",
        roundId: null,
        goalId: null,
        importId: null,
        at: base.entry.at,
      });
      expect(Schema.decodeUnknownSync(LiveFrame)(frame)).toEqual(
        frame as LiveFrame,
      );
      // No outcome, so no turn ends with it.
      expect(turnEndedFrame(base)).toBeUndefined();
    }
  });

  test("another target's narration does not appear", async () => {
    const path = newDatabasePath();
    const frames = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* seed(store);
        return yield* Effect.promise(() =>
          framesUntil(
            over(store, {
              cursor: 0,
              /**
               * Three entries, with the foreign one in the middle on purpose.
               *
               * The narration sub-stream is one ordered source, so waiting for the *third*
               * entry proves the second was reached and dropped. Waiting only for the first
               * would prove nothing: `Stream.merge` makes no promise about when it pulls
               * the next element, so "the other target's entry has not arrived yet" and
               * "it will never arrive" would look the same.
               */
              narrations: narrationsFrom([
                narration({ _tag: "reply", text: "mine" }),
                narration(
                  { _tag: "reply", text: "not mine" },
                  { id: 2, targetId: "another-target" },
                ),
                narration({ _tag: "reply", text: "also mine" }, { id: 3 }),
              ]),
            }),
            (collected) =>
              items(collected).filter((item) => item.origin === "activity")
                .length >= 2,
          ),
        );
      }),
    );
    const bodies = items(frames)
      .filter((item) => item.origin === "activity")
      .map((item) => item.body);
    expect(bodies).toEqual(["mine", "also mine"]);
  });

  test("a refused action appears, attributed to the attempt holding its session", async () => {
    const path = newDatabasePath();
    const frames = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* seed(store);
        return yield* Effect.promise(() =>
          framesUntil(
            over(store, {
              cursor: 0,
              decisions: decisionsFrom([denial()]),
              attemptForSession: (sessionId) =>
                Effect.succeed(
                  sessionId === "ses_abc" ? "attempt-1" : undefined,
                ),
            }),
            (collected) =>
              items(collected).some((item) => item.kind === "action.denied"),
          ),
        );
      }),
    );
    const denied = items(frames).find((item) => item.kind === "action.denied");
    expect(denied?.attemptId).toBe("attempt-1");
    expect(denied?.origin).toBe("activity");
  });

  test("a decision whose session cannot be placed is dropped, not guessed at", async () => {
    const path = newDatabasePath();
    const frames = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* seed(store);
        return yield* Effect.promise(() =>
          framesUntil(
            over(store, {
              cursor: 0,
              decisions: decisionsFrom([
                denial({
                  id: 1,
                  request: {
                    sessionId: "ses_elsewhere",
                    tool: "bash",
                    input: {},
                  },
                }),
                // A placeable one behind it, so reaching the second proves the first was
                // reached and refused rather than merely not pulled yet.
                denial({ id: 2 }),
              ]),
              attemptForSession: (sessionId) =>
                // This target holds `ses_abc` and nothing else, which is what a decision for
                // another engagement — or for an attempt that has already settled and left
                // the supervisor's map — looks like from here.
                Effect.succeed(
                  sessionId === "ses_abc" ? "attempt-1" : undefined,
                ),
            }),
            (collected) =>
              items(collected).some((item) => item.kind === "action.denied"),
          ),
        );
      }),
    );
    // Showing one target's refused action under another target would be worse than not
    // showing it, so the unplaceable one does not appear at all — and the one that follows
    // it does, which is what proves it was dropped rather than still in flight.
    const denials = items(frames).filter(
      (item) => item.kind === "action.denied",
    );
    expect(denials).toHaveLength(1);
    expect(denials[0]?.id).toBe("activity:decision:2");
  });

  test("the real narration bus reaches a watching transcript", async () => {
    const path = newDatabasePath();
    const bodies = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* ObservationStore;
          const narrations = yield* RunNarrations;
          yield* Effect.orDie(seed(store));

          const queue = yield* Queue.unbounded<LiveFrame>();
          const fiber = yield* Effect.forkScoped(
            Stream.runForEach(
              liveTranscript({
                targetId: TARGET,
                events: (after, limit) =>
                  Effect.orDie(store.eventsAfter(after, limit)),
                latestSequence: Effect.orDie(store.currentEventSequence),
                narrations,
                decisions: NO_DECISIONS,
                attemptForSession: () => Effect.succeed("attempt-1"),
                cursor: 0,
                sweep: "5 millis",
              }),
              (frame) => Queue.offer(queue, frame),
            ),
          );

          // Waited for rather than assumed. The bus replays nothing — `run/narration.ts` is
          // explicit that an entry published before a subscription exists is gone — so a
          // test that published immediately would be testing its own luck.
          yield* Effect.timeout(
            Effect.gen(function* () {
              while ((yield* narrations.subscriberCount) === 0) {
                yield* Effect.sleep("5 millis");
              }
            }),
            "10 seconds",
          ).pipe(Effect.orDie);

          yield* narrations.publish({
            targetId: TARGET,
            subject: { _tag: "attempt", attemptId: "attempt-1" },
            harnessSessionId: "ses_abc",
            entry: {
              type: "session.text.ended",
              sequence: 3,
              at: 1_700_000_000_000,
              outcome: undefined,
              detail: { _tag: "reply", text: "through the real bus" },
            },
          });

          const collected: LiveFrame[] = [];
          yield* Effect.timeout(
            Effect.gen(function* () {
              while (
                !items(collected).some((item) => item.origin === "activity")
              ) {
                collected.push(yield* Queue.take(queue));
              }
            }),
            "10 seconds",
          ).pipe(Effect.orDie);
          yield* Fiber.interrupt(fiber);
          return items(collected)
            .filter((item) => item.origin === "activity")
            .map((item) => item.body);
        }).pipe(
          Effect.provide(ObservationStore.layer(path)),
          Effect.provide(RunNarrations.layer),
          Effect.orDie,
        ),
      ),
    );
    expect(bodies).toEqual(["through the real bus"]);
  });
});

/* ── 4. What a connection holds, and gives back ──────────────────────────────── */

/**
 * The borrowed store's lifetime, which is the live route's one resource claim.
 *
 * `http/browserApi.ts` opens a target's store **for the length of the connection** rather
 * than of the request, and `Stream.unwrap` is what makes that true: it takes the scope the
 * borrow needs and ties it to the stream's own lifetime. That is worth a test of its own
 * because both ways of getting it wrong are invisible until they hurt. A borrow released
 * too early — a per-request `Effect.scoped` — would hand the handle back while the stream
 * was still reading through it. A borrow never released leaks a SQLite connection and its
 * WAL per browser tab that ever watched a run, and `rm -rf targets/<id>/` then races a
 * connection nobody is using, which is the one case where an operator's "it is gone" and
 * the filesystem's answer differ.
 *
 * The composition under test is the route's own, not a lookalike: the real
 * {@link liveTranscript} over a real reference-counted {@link TargetStores}, with the TTL
 * shortened because sixty seconds is the right answer for an operator and an unusable one
 * for a test.
 */
describe("what a live connection borrows", () => {
  /** Short enough to wait out; long enough that a borrow can outlive it on purpose. */
  const IDLE_TTL = Duration.millis(80);
  const PAST_TTL = Duration.millis(240);

  const withFleet = <A>(
    use: (
      stores: TargetStores["Service"],
    ) => Effect.Effect<A, never, Scope.Scope>,
  ): Promise<A> => {
    const root = join(mkdtempSync(join(tmpdir(), "bit-live-fleet-")), "fleet");
    directories.push(root);
    const fleet = FleetStore.layer(root);
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* FleetStore;
          yield* registry.register({
            targetId: TARGET,
            name: TARGET,
            scopeNote: "",
          });
          // The sweep is what records a target's schema state, and the resolver refuses a
          // target no sweep has looked at. Not setup noise: it is the ordering `main.ts`
          // observes too.
          yield* registry.migrateFleet();
          const stores = yield* TargetStores;
          return yield* use(stores);
        }).pipe(
          Effect.provide(
            TargetStores.layerWith({ idleTimeToLive: IDLE_TTL }).pipe(
              Layer.provide(fleet),
            ),
          ),
          Effect.provide(fleet),
          Effect.orDie,
        ),
      ),
    );
  };

  /** The route's own composition: the borrow's scope is the stream's, through `unwrap`. */
  const connection = (
    stores: TargetStores["Service"],
  ): Stream.Stream<LiveFrame> =>
    Stream.unwrap(
      Effect.map(Effect.orDie(stores.open(TARGET)), (store) =>
        liveTranscript({
          targetId: TARGET,
          events: (after, limit) =>
            Effect.orDie(store.eventsAfter(after, limit)),
          latestSequence: Effect.orDie(store.currentEventSequence),
          narrations: NO_NARRATION,
          decisions: NO_DECISIONS,
          attemptForSession: () => Effect.succeed(undefined),
          cursor: 0,
          sweep: "5 millis",
        }),
      ),
    );

  test("the handle is held for as long as the connection reads, past the idle TTL", async () => {
    const observed = await withFleet((stores) =>
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<LiveFrame>();
        const fiber = yield* Effect.forkScoped(
          Stream.runForEach(connection(stores), (frame) =>
            Queue.offer(queue, frame),
          ),
        );
        // Read something, so the borrow is demonstrably in use rather than merely taken.
        yield* Effect.timeout(Queue.take(queue), "10 seconds").pipe(
          Effect.orDie,
        );
        // Three times the TTL with the connection open. Reference counting is what makes
        // this safe: nothing can take the handle from a caller still inside its scope.
        yield* Effect.sleep(PAST_TTL);
        const held = [...(yield* stores.openTargetIds)];
        yield* Fiber.interrupt(fiber);
        return held;
      }),
    );
    expect(observed).toEqual([TARGET]);
  });

  test("the handle is given back when the connection is interrupted, and then closed", async () => {
    const timeline = await withFleet((stores) =>
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<LiveFrame>();
        const fiber = yield* Effect.forkScoped(
          Stream.runForEach(connection(stores), (frame) =>
            Queue.offer(queue, frame),
          ),
        );
        yield* Effect.timeout(Queue.take(queue), "10 seconds").pipe(
          Effect.orDie,
        );
        // What a browser closing its tab does: the stream is interrupted mid-read, with no
        // chance to finish tidily.
        yield* Fiber.interrupt(fiber);
        // Released, not closed: within the TTL the handle stays warm so the next watcher
        // of the same target reuses it instead of re-opening and re-migrating the file.
        const warm = [...(yield* stores.openTargetIds)];
        yield* Effect.sleep(PAST_TTL);
        const cold = [...(yield* stores.openTargetIds)];
        return { warm, cold };
      }),
    );

    expect(timeline.warm).toEqual([TARGET]);
    // Gone, so the file handle and its WAL are gone with it. This is the half that would
    // have leaked one connection per tab that ever watched a run.
    expect(timeline.cold).toEqual([]);
  });

  test("two watchers of one target share a handle, and the last one out releases it", async () => {
    const timeline = await withFleet((stores) =>
      Effect.gen(function* () {
        const run = () =>
          Effect.forkScoped(
            Stream.runForEach(connection(stores), () => Effect.void),
          );
        const first = yield* run();
        const second = yield* run();
        yield* Effect.sleep(Duration.millis(30));
        const both = [...(yield* stores.openTargetIds)];

        yield* Fiber.interrupt(first);
        yield* Effect.sleep(PAST_TTL);
        // Still open, because the second watcher is still holding it: the TTL applies to an
        // *unborrowed* handle, which is the distinction reference counting buys.
        const stillHeld = [...(yield* stores.openTargetIds)];

        yield* Fiber.interrupt(second);
        yield* Effect.sleep(PAST_TTL);
        return { both, stillHeld, after: [...(yield* stores.openTargetIds)] };
      }),
    );

    // One handle for two watchers, which matters because SQLite has one write lock per
    // file: two connections would queue behind each other for nothing.
    expect(timeline.both).toEqual([TARGET]);
    expect(timeline.stillHeld).toEqual([TARGET]);
    expect(timeline.after).toEqual([]);
  });
});

/* ── The replay's own bodies (A6 F10 review) ─────────────────────────────────── */

describe("projecting a replay", () => {
  const long = "x".repeat(NARRATION_FIELD_MAX * 3);
  const entry = (over: Partial<MessageEntry>): MessageEntry => ({
    type: "user",
    text: "",
    error: undefined,
    parts: [],
    model: undefined,
    at: 1,
    ...over,
  });
  const replay = (
    entries: readonly MessageEntry[],
    users: "operator" | "other" = "operator",
  ) =>
    projectReplay({
      entries,
      subject: { _tag: "import", importId: "imp_1" },
      harnessSessionId: "ses_1",
      users,
      fallbackAt: 0,
    }).items;
  const capped = (body: string | undefined) =>
    body !== undefined &&
    body.length === NARRATION_FIELD_MAX + NARRATION_TRUNCATED_MARK.length &&
    body.endsWith(NARRATION_TRUNCATED_MARK);

  test("A7-S review 2: a stop the harness recorded in the last turn of a session the operator ended is that end's: said neutrally, once; an earlier turn's, or any when the operator did not end it, is the harness's error", () => {
    const entries = [
      entry({ text: "first" }),
      entry({ type: "assistant", error: "Step interrupted", aborted: true }),
      entry({ text: "second" }),
      entry({ type: "assistant", text: "", parts: [] }),
      entry({ type: "assistant", error: "Step interrupted", aborted: true }),
      entry({ type: "idle", error: "Step interrupted", aborted: true }),
      // A real failure in the same turn is still the harness's.
      entry({ type: "assistant", error: "429 from the provider" }),
    ];
    const lines = (endedByOperator: boolean) =>
      projectReplay({
        entries,
        subject: { _tag: "import", importId: "imp_1" },
        harnessSessionId: "ses_1",
        users: "operator",
        fallbackAt: 0,
        endedByOperator,
      }).items.map((item) =>
        [item.kind, item.headline, item.body, item.outcome].join(" | "),
      );
    expect(lines(true)).toEqual([
      "turn.operator | You | first | ",
      "turn.other | error | Step interrupted | failed",
      "turn.operator | You | second | ",
      `turn.other | interrupted | ${ENDED_STOP_NOTE} | `,
      "turn.other | error | 429 from the provider | failed",
    ]);
    expect(lines(false)).toEqual([
      "turn.operator | You | first | ",
      "turn.other | error | Step interrupted | failed",
      "turn.operator | You | second | ",
      "turn.other | error | Step interrupted | failed",
      "turn.other | error | 429 from the provider | failed",
    ]);
  });

  test("every body a stored entry supplies is capped as a live part's is, and says so", () => {
    const items = replay([
      entry({ text: long }),
      entry({ type: "system", text: long }),
      entry({ type: "assistant", text: long }),
      entry({ type: "assistant", error: long }),
    ]);
    expect(
      items.map((item) => [item.kind, item.headline, capped(item.body)]),
    ).toEqual([
      ["turn.operator", "You", true],
      ["turn.other", "system", true],
      // A finished reply has its own, larger cap (A6 U5 review): 12,000 characters is whole.
      ["turn.reply", "Reply", false],
      ["turn.other", "error", true],
    ]);
    expect(items[2]?.body).toBe(long);
    // A planner round's `user` entry, the other way a `user` entry is drawn.
    expect(capped(replay([entry({ text: long })], "other")[0]?.body)).toBe(
      true,
    );
    // And a short one is untouched.
    expect(replay([entry({ text: "add acme.com" })])[0]?.body).toBe(
      "add acme.com",
    );
  });

  test("U5 review: a finished reply keeps up to 32,000 characters, replayed as live, and says where it cut", () => {
    const huge = "y".repeat(REPLY_FIELD_MAX + 500);
    const fromText = replay([entry({ type: "assistant", text: huge })])[0];
    const fromPart = replay([
      entry({
        type: "assistant",
        parts: [{ _tag: "reply", text: truncateReply(huge), blockId: "m:0" }],
      }),
    ])[0];
    for (const item of [fromText, fromPart]) {
      expect(item?.body.length).toBe(
        REPLY_FIELD_MAX + NARRATION_TRUNCATED_MARK.length,
      );
      expect(item?.body.endsWith(NARRATION_TRUNCATED_MARK)).toBe(true);
    }
    // Thinking is not a reply: it keeps the field cap.
    expect(truncateNarration("t".repeat(REPLY_FIELD_MAX)).length).toBe(
      NARRATION_FIELD_MAX + NARRATION_TRUNCATED_MARK.length,
    );
  });

  test("a user entry the harness wrote itself is drawn as what it marks, never as the operator", () => {
    const note = "[Request interrupted by user for tool use]";
    for (const users of ["operator", "other"] as const) {
      expect(
        replay([entry({ text: note, marker: "interrupted" })], users).map(
          (item) => [item.kind, item.headline, item.body],
        ),
      ).toEqual([["turn.other", "interrupted", note]]);
    }
  });
});
