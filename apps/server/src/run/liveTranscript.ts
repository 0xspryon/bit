/**
 * The live transcript: the thinnest event consumer, plus what is happening right now.
 *
 * `@bit/contracts`'s `live.ts` is the contract and says what the two channels promise. This
 * is the half that produces them, and what is worth reading here is the mechanism of the
 * record channel, because that is the part Day 7's reconnect is built on.
 *
 * ## The record channel: ordered reads behind a cursor, never a pushed payload
 *
 * DECISIONS.md §8, accepted 2026-10-17: "Consumers read committed events from SQLite in
 * ascending sequence order after their cursor. PubSub carries an advisory wake-up, not the
 * authoritative event payload or delivery guarantee." That is implemented literally:
 *
 * - The only source of a record item is `ObservationStore.eventsAfter(cursor, limit)`,
 *   which is `WHERE sequence > ? ORDER BY sequence LIMIT ?`. Nothing is ever delivered
 *   from a notification, so there is no payload on a bus that could disagree with what
 *   committed.
 * - The cursor advances to the last sequence actually read, and only after that page has
 *   been handed to the stream. A connection that dies mid-page leaves the client's cursor
 *   at the last item it *received*, which is what the next connection resumes after.
 * - **Commit order is not publication order, and this is the fix for that.** A notification
 *   bus can coalesce or lose wake-ups; an ordered read of a committed table cannot. §8
 *   names ScopeWeaver's cursorless SSE broadcaster as the thing to avoid, and the property
 *   it lacks is exactly this one.
 *
 * ### The wake-up is a bounded sweep, and that is the whole of it
 *
 * There is no advisory PubSub signal here. A caught-up reader sleeps {@link LIVE_SWEEP} and
 * reads again — §8's "bounded periodic reconciliation sweep", which it requires, rather
 * than the wake-up, which it describes as advisory and therefore optional. The trade is
 * named rather than implied: latency on the record channel is up to one sweep interval,
 * and in exchange **correctness does not depend on any notification arriving**. Adding a
 * signal later can only shorten the wait; it cannot be what makes this correct, and a
 * version that depended on one would have been the version where a missed wake-up stranded
 * a committed observation until the next page-load.
 *
 * This is also why a crash between commit and notification cannot lose anything: there is
 * nothing to notify. The next read sees the row.
 *
 * ### The replay budget, and why "no cursor" does not mean "from now"
 *
 * A client with no cursor is answered from {@link LIVE_REPLAY_BUDGET} events back, not from
 * the beginning and not from the end. Not from the beginning because a target with months
 * of history would push its whole log down one SSE connection to draw one screen. Not from
 * the end, because the operator who has just pressed Start wants to see the run they
 * started, and `attempt.started` is already committed by the time the browser opens this
 * stream — a stream that began "now" would reliably miss the first item of every run.
 *
 * What it skips, it says it skipped, in the opening frame. §8 calls these "UI reconnect
 * cursors and replay budgets" and is explicit that they "are not durable business-consumer
 * acknowledgements": nothing here advances a stored cursor, writes a receipt, or marks an
 * event processed. The cursor is a *position in a durable log* that the client carries, not
 * an acknowledgement this server remembers.
 *
 * ## The activity channel: in-process, lossy, and labelled as such
 *
 * Two in-process buses, both `PubSub.sliding`, merged in beside the record channel:
 *
 * - {@link RunNarrations} — what the harness is saying. `run/narration.ts` records why this
 *   is not written to the event log and what that costs.
 * - {@link PolicyDecisions} — what the gate decided. Only **denials** are projected; the
 *   contract's `LIVE_ITEM_KINDS` says why the allow side is not.
 *
 * Every activity item carries `sequence: null`, so no item on this stream claims a position
 * it does not have. An entry dropped by a sliding buffer is gone and nothing reconciles
 * against it, which is the accepted cost of a browser tab being unable to slow a running
 * agent down.
 *
 * ## Attribution is by the keys this process owns, and an unattributable item is dropped
 *
 * Narration is published by the supervisor under the attempt whose session it opened, so a
 * narration item's target is not in question. A policy decision is different: the gate's
 * request carries a harness session id and nothing else, because the hook that calls it is
 * a plugin inside the harness process with no idea which engagement it belongs to. So a
 * decision is attributed by asking the supervisor which attempt holds that session, and a
 * decision whose session cannot be placed is **dropped rather than guessed at** — the same
 * rule `harness/openCodeClient.ts` applies to an event with no session id on it, for the
 * same reason: showing one target's refused action under another target would be worse
 * than not showing it.
 *
 * The honest consequence: a decision answered after its attempt has settled and left the
 * supervisor's map is unattributable and does not appear. The gate's audit file beside the
 * engagement still has it.
 *
 * ## `action.denied` is not every refused action
 *
 * Two refusals never reach this module at all, and neither is a bug here:
 *
 * - **Fail-closed.** `plugins/policyHook.ts` denies on its own when the policy service
 *   cannot be reached, answers badly or times out — it writes `denied_failclosed` to the
 *   engagement's audit file and the control plane is never asked, so `PolicyDecisions` has
 *   nothing to publish. That ordering is deliberate and must not change: a gate that needed
 *   this feed to exist would be a gate that fails open when the feed is down.
 * - **An undecodable request.** `policy/service.ts` answers `400` and records nothing about
 *   a request it never understood.
 *
 * So the audit file is the only record of a fail-closed denial, and a screen showing no
 * denials means "none of the kind this channel carries". `@bit/contracts`'s `live.ts` says
 * the same thing where a client reads it.
 */
import {
  LIVE_HEARTBEAT_SECONDS,
  bareToolName,
  bitMcpServerName,
  type LiveCursor,
  type LiveFrame,
  type LiveItem,
  type LiveOpened,
} from "@bit/contracts";
import type { RecordedEvent } from "@bit/contracts";
import {
  Clock,
  Duration,
  Effect,
  Filter,
  Option,
  Result,
  Stream,
} from "effect";

import { roundIdFromScope } from "../persistence/store";
import type { AnsweredDecision, PolicyDecisions } from "../policy/service";
import type { RunNarration, RunNarrations } from "./narration";

/**
 * How long a caught-up reader waits before reading the event log again.
 *
 * A second, because this is a screen a person is watching and a second is below the
 * threshold at which a UI feels stalled, while still being one `SELECT … WHERE sequence >
 * ?` per connection per second against a local SQLite file with an index on the ordering
 * column. The read takes no write lock, so a worker recording an observation is never
 * waiting on a watcher.
 */
export const LIVE_SWEEP: Duration.Input = "1 second";

/**
 * How long an idle connection goes without sending anything.
 *
 * **Derived from the contract's {@link LIVE_HEARTBEAT_SECONDS} rather than chosen here**,
 * because this number is not only the stream's business: the listener's idle timeout has to
 * be longer than it or a quiet connection is closed before the heartbeat can keep it alive,
 * and a client's patience has to be longer than it or a healthy quiet connection is read as
 * dead. Both of those live elsewhere — `http/controlPlane.ts` and the browser — and all
 * three now derive from one constant so they cannot drift apart. They had: `Bun.serve`'s
 * default `idleTimeout` is ten seconds and this was twenty, so in a browser the transcript
 * simply stopped after ten seconds on a quiet target.
 *
 * The frame it sends is a {@link LiveCursor}, so the keep-alive and the cursor are the same
 * thing rather than two mechanisms to keep in step.
 */
export const LIVE_HEARTBEAT: Duration.Input = Duration.seconds(
  LIVE_HEARTBEAT_SECONDS,
);

/** How many committed events one read takes. One screenful at a time, several times over. */
export const LIVE_PAGE = 200;

/**
 * How far back a connection with no cursor is answered from.
 *
 * Deliberately the same order as {@link LIVE_PAGE}: a client with no position gets roughly
 * one page of history, which covers the run it has just started and the one before it, and
 * learns from the opening frame that anything older was skipped.
 */
export const LIVE_REPLAY_BUDGET = 200;

/* ── Reading a payload ───────────────────────────────────────────────────────── */

/**
 * `payload` arrives as decoded JSON typed `unknown`, on purpose.
 *
 * `event.ts` is explicit that a reader tolerates fields it does not declare rather than
 * failing on an event a later build wrote, so these read defensively instead of decoding
 * against a schema per kind. The cost is that a missing field becomes a blank rather than
 * an error; the alternative is a live transcript that stops at the first event written by
 * a newer server.
 */
const field = (payload: unknown, name: string): unknown =>
  typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)[name]
    : undefined;

const text = (payload: unknown, name: string): string => {
  const value = field(payload, name);
  return typeof value === "string" ? value : "";
};

const count = (payload: unknown, name: string): number => {
  const value = field(payload, name);
  return typeof value === "number" ? value : 0;
};

/* ── Projecting the record ───────────────────────────────────────────────────── */

/**
 * The event kinds whose subject *is* the attempt they are about.
 *
 * Exactly the two `appendAttemptEvent` writes. Named as a set rather than inlined in a
 * condition so that adding a third host-originated attempt event is one edit in one place,
 * and so the narrowness is visible: every other kind takes its attempt from caller
 * authority or has none.
 */
const ATTEMPT_SUBJECT_KINDS: ReadonlySet<string> = new Set([
  "attempt.started",
  "attempt.settled",
]);

/**
 * The event kinds whose subject *is* the planner round they are about.
 *
 * {@link ATTEMPT_SUBJECT_KINDS}'s counterpart, and narrow for the same reason: these two
 * are the only host-originated round events, both written by `plan/planSupervisor.ts` with
 * no caller authority at all, so the round is the `subject_id`. Every other item that
 * belongs to a round gets it from the **caller scope** instead — `intent.added` from a
 * round's `add_intent` is a round's write, and its subject is the intent.
 */
const ROUND_SUBJECT_KINDS: ReadonlySet<string> = new Set([
  "plan.round.started",
  "plan.round.settled",
]);

/**
 * How an intent event names its intent: the question when the event carries it, and always
 * the id, because a question can repeat and an id cannot. `subject_id` is the intent for
 * these kinds, so it is the fallback when a payload lacks `intentId`.
 */
const intentPhrase = (event: RecordedEvent): string => {
  const id = text(event.payload, "intentId") || event.subjectId;
  const question = text(event.payload, "question");
  return question === ""
    ? `The intent ${id}`
    : `The intent \u201c${question}\u201d (${id})`;
};

/**
 * One committed event as one transcript item.
 *
 * Pure, exported, and tested on its own: this is where "a recorded observation reads as
 * recorded" is either true or not, and a function that needs a database and a harness to
 * check that would be checked by nobody.
 *
 * **Every event produces exactly one item, including a kind this build has never seen.**
 * An unknown kind becomes `record.other` carrying its real name — it is *not* filtered out,
 * because the record channel's sequence is a contiguous claim and a silently dropped item
 * would leave a gap a client would be right to read as a loss.
 */
export const projectEvent = (event: RecordedEvent): LiveItem => {
  const base = {
    _tag: "item" as const,
    // The store's own event id, prefixed. Stable across connections and across a restart,
    // which is what makes re-reading a range invisible to the operator.
    id: `record:${event.eventId}`,
    origin: "record" as const,
    sequence: event.sequence,
    at: event.recordedAt,
    /**
     * Which attempt this item is **about** — not whose authority wrote it.
     *
     * The two are different columns and `store.ts` keeps them apart on purpose: for a
     * worker's mutation the attempt is the caller, so `attempt_id` is it. For
     * `attempt.started` and `attempt.settled` the three caller-authority columns are all
     * `null` — both are host-originated, written before any credential for that attempt
     * exists or by the sweep that reconciled it — and the attempt is the event's
     * `subject_id`.
     *
     * So the subject is read **only for those two kinds**, by name, and not as a general
     * fallback. A general fallback looked harmless and was not: `subject_id` is domain
     * identity, so for a host-added intent it holds the *intent* id, and falling back would
     * have put an intent id in a field every reader takes to be an attempt — a filter for
     * one run would match an item that has nothing to do with it. Narrow and explicit is
     * the only version that cannot do that.
     *
     * Reading `attempt_id` alone was also wrong, in the other direction: it showed a run's
     * own beginning and end with no attempt on them, which are the two items a reader
     * filtering by attempt most wants. Observed on a live server: `attempt.started` arrived
     * as `"attemptId": null`.
     */
    attemptId: ATTEMPT_SUBJECT_KINDS.has(event.kind)
      ? event.subjectId
      : event.attemptId,
    /**
     * Which planner round this item belongs to, read the two ways a round can own an event.
     *
     * The subject for the round's own two records, and the **caller scope** for everything
     * a round wrote — which is the half that matters, because an `intent.added` the planner
     * committed carries the intent as its subject and says nothing about the round in its
     * payload. `roundIdFromScope` is `callerScopeOf`'s inverse and lives beside it, so the
     * `<targetId>/round/<roundId>` format has one home.
     *
     * Deliberately **not** inferred from anything else. An operator-added intent and a
     * planner-added one differ in exactly this column, and guessing from, say, the goal
     * would file a hand-written intent under whichever round happened to be open.
     */
    roundId:
      roundIdFromScope(event.callerScope) ??
      (ROUND_SUBJECT_KINDS.has(event.kind) ? event.subjectId : null),
    tool: null,
    // Null together with `tool`, always: a committed event is not a tool call, and the
    // record channel never names one.
    toolName: null,
    input: null,
    output: null,
    callId: null,
  };

  switch (event.kind) {
    case "attempt.started":
      return {
        ...base,
        kind: "run.started",
        headline: "Run started",
        body: `On ${text(event.payload, "providerId")}/${text(event.payload, "modelId")}, under intent ${text(event.payload, "intentId")}.`,
        outcome: null,
      };
    case "attempt.settled": {
      const status = text(event.payload, "status");
      const settledBy = text(event.payload, "settledBy");
      return {
        ...base,
        kind: "run.settled",
        headline: "Run settled",
        // `settledBy` is carried into the sentence because the two writers of this event
        // mean different things — a supervisor that watched the run, or a sweep that found
        // the row afterwards — and `store.ts` records that distinction on purpose.
        body:
          settledBy === ""
            ? `The attempt ended as ${status}.`
            : `The attempt ended as ${status}, settled by ${settledBy}.`,
        outcome: status === "" ? null : status,
      };
    }
    case "observation.recorded": {
      const untested = count(event.payload, "untestedDimensionCount");
      const claim = text(event.payload, "testedClaim");
      return {
        ...base,
        kind: "observation.recorded",
        headline: "Observation recorded",
        // The untested tail is said here rather than left for a later screen, because an
        // observation that names what it did *not* cover is the whole reason a negative
        // result is worth as much as a positive one.
        body:
          untested === 0
            ? claim
            : `${claim} (${untested} dimension${untested === 1 ? "" : "s"} left untested.)`,
        outcome: text(event.payload, "outcome") || null,
      };
    }
    case "asset.recorded":
      return {
        ...base,
        kind: "asset.recorded",
        headline: "Asset recorded",
        body: `${text(event.payload, "kind")} ${text(event.payload, "identity")}`.trim(),
        // `created: false` means the asset was already known and this was a second sighting
        // of it, which is a different fact from a new asset and must not read as one.
        outcome: field(event.payload, "created") === true ? "new" : "known",
      };
    case "intent.added":
      return {
        ...base,
        kind: "intent.added",
        headline: "Intent added",
        body: text(event.payload, "question"),
        outcome: null,
      };
    case "goal.added":
      return {
        ...base,
        kind: "goal.added",
        headline: "Goal added",
        // The objective rather than the label: the label is a handle for a list row, and
        // a transcript is read for what was being attempted. An unnamed goal is the
        // ordinary case, so the name is not worth a sentence of its own here.
        body: text(event.payload, "description"),
        outcome: null,
      };
    case "goal.ended": {
      const status = text(event.payload, "status");
      const endedBy = text(event.payload, "endedBy");
      const reason = text(event.payload, "reason");
      // Who is in the sentence for the reason `attempt.settled` carries `settledBy`: a
      // person ending a goal and the planner concluding it are different facts. The
      // reason follows when there is one, and an ending with none says nothing rather
      // than a placeholder.
      const sentence =
        endedBy === ""
          ? `The goal ended as ${status}.`
          : `The goal ended as ${status}, ended by ${endedBy}.`;
      return {
        ...base,
        kind: "goal.ended",
        headline: "Goal ended",
        body: reason === "" ? sentence : `${sentence} ${reason}`,
        outcome: status === "" ? null : status,
      };
    }
    case "intent.abandoned": {
      const reason = text(event.payload, "reason");
      // As `goal.ended` does: the act, then the operator's reason when there is one. It
      // has no attempt, and `subject_id` is the intent, so the item borrows none.
      const sentence = `${intentPhrase(event)} was abandoned.`;
      return {
        ...base,
        kind: "intent.abandoned",
        headline: "Intent abandoned",
        body: reason === "" ? sentence : `${sentence} ${reason}`,
        outcome: null,
      };
    }
    case "plan.round.started": {
      const budget = count(event.payload, "budget");
      // The round id is in the sentence because there is no field for it: `LiveItem` has
      // one domain handle, `attemptId`, and a round is not an attempt. The alternative was
      // a `roundId` on the contract, which would be designing the planner screen's filter
      // one slice before that screen exists.
      return {
        ...base,
        kind: "plan.round.started",
        headline: "Planner round started",
        body: `Round ${event.subjectId} opened on goal ${text(event.payload, "goalId")}, with a budget of ${String(budget)} intent${budget === 1 ? "" : "s"}.`,
        outcome: null,
      };
    }
    case "plan.round.settled": {
      const status = text(event.payload, "status");
      const settledBy = text(event.payload, "settledBy");
      const disposition = text(event.payload, "disposition");
      // Three facts and they are different facts, which is why all three are in the
      // sentence. The status says whether *execution* finished and how; the disposition
      // says what the planner concluded, and its absence is the ordinary case for an
      // interrupted or uncertain round rather than an error; `settledBy` says how much is
      // known, as it does on `run.settled`.
      const sentence =
        settledBy === ""
          ? `Round ${event.subjectId} ended as ${status}.`
          : `Round ${event.subjectId} ended as ${status}, settled by ${settledBy}.`;
      return {
        ...base,
        kind: "plan.round.settled",
        headline: "Planner round settled",
        body:
          disposition === ""
            ? `${sentence} It recorded no disposition.`
            : `${sentence} It concluded ${disposition}.`,
        outcome: status === "" ? null : status,
      };
    }
    case "intent.released": {
      const held = text(event.payload, "attemptStatus");
      const attempt = text(event.payload, "claimedByAttemptId");
      // What the sweep found, in the words the record uses: a claim by an attempt that was
      // never written is a crash between the claim and the row, and a claim by one that
      // had already left `running` is a stale lock. Either way nothing is known to have
      // run under it, which is why the outcome is `open` and never `answered`.
      return {
        ...base,
        kind: "intent.released",
        headline: "Intent released",
        body:
          held === ""
            ? `${intentPhrase(event)} was released: it was claimed by attempt ${attempt}, which was never recorded, so nothing is known to have run. It is open again.`
            : `${intentPhrase(event)} was released: it was still claimed by attempt ${attempt}, which had already ${held === "uncertain" ? "become uncertain" : `settled as ${held}`}. It is open again.`,
        outcome: null,
      };
    }
    default:
      return {
        ...base,
        kind: "record.other",
        headline: event.kind,
        body: `This build does not render '${event.kind}' events. It is in this target's record at sequence ${String(event.sequence)}.`,
        outcome: null,
      };
  }
};

/* ── Projecting live activity ────────────────────────────────────────────────── */

/**
 * One narration entry as one transcript item, or nothing.
 *
 * `undefined` is the common answer and is the point: most of what a harness narrates is a
 * token delta, a step boundary or a usage update, and `NarrationDetail` reads those as
 * `opaque`. Dropping them here is sound in a way it would not be on the record channel —
 * this channel never claims to be complete — and it is what keeps one item on the wire per
 * reply block and per tool call instead of hundreds per turn.
 */
export const projectNarration = (item: RunNarration): LiveItem | undefined => {
  const base = {
    _tag: "item" as const,
    // This process's publish order, prefixed so it cannot collide with a record id. See
    // `RunNarration.id` for what this is not: it is not a cursor and not resumable.
    id: `activity:${String(item.id)}`,
    origin: "activity" as const,
    sequence: null,
    at: item.entry.at,
    /**
     * Whose session narrated this, projected from the bus's tagged subject.
     *
     * Exactly one of the two is set, which is what the tag buys: an attempt's narration
     * has no round and a round's has no attempt, and neither is a field left unfilled.
     * The supervisor publishes under the identity whose session it opened, so this is not
     * a guess at attribution.
     */
    attemptId: item.subject._tag === "attempt" ? item.subject.attemptId : null,
    roundId: item.subject._tag === "round" ? item.subject.roundId : null,
  };
  /**
   * The registration whose prefix this subject's tool names carry.
   *
   * Derived from the subject rather than searched for, which is what makes the reduction
   * below exact: the server was registered as `bit-<attemptId>` or `bit-<roundId>` by the
   * supervisor that opened this session, so the only prefix stripped is the one this
   * application chose. A harness's own `bash` is untouched. `mcpToolName.ts` carries the
   * two observed wire forms and the evidence for each.
   */
  const serverName = bitMcpServerName(
    item.subject._tag === "attempt"
      ? item.subject.attemptId
      : item.subject.roundId,
  );
  const detail = item.entry.detail;
  switch (detail._tag) {
    case "reply":
      // A reply with no text is the harness closing an empty block. Nothing to show, and
      // an empty bubble would read as the agent having said nothing when it said nothing
      // *yet*.
      return detail.text.trim() === ""
        ? undefined
        : {
            ...base,
            kind: "turn.reply",
            headline: "Reply",
            body: detail.text,
            tool: null,
            toolName: null,
            input: null,
            output: null,
            callId: null,
            outcome: null,
          };
    case "toolCall":
      return {
        ...base,
        kind: "tool.call",
        headline: detail.tool ?? "Tool call",
        // The name, not a sentence about it, when there is one: the arguments underneath
        // are what the operator reads. An unnamed call says so rather than being dressed up.
        body:
          detail.tool === undefined
            ? "A tool call the harness had not yet named."
            : "",
        tool: detail.tool ?? null,
        // The same name with our MCP prefix off, so a consumer can recognise `add_intent`
        // without knowing which driver reported it or which round registered it. The
        // planner chat's merge rule matches on this and shipped broken matching on `tool`.
        toolName: bareToolName(detail.tool, serverName) ?? null,
        input: detail.input === "" ? null : detail.input,
        output: null,
        // Carried through so a result can be paired with *this* call rather than with
        // whichever call to the same tool is nearest on screen. Both harnesses run tools
        // concurrently, so that is not a hypothetical ordering.
        callId: detail.callId,
        outcome: null,
      };
    case "toolResult":
      return {
        ...base,
        kind: "tool.result",
        headline: detail.tool ?? "Tool result",
        body: "",
        tool: detail.tool ?? null,
        toolName: bareToolName(detail.tool, serverName) ?? null,
        input: null,
        output: detail.output === "" ? null : detail.output,
        // The only thing that says which call this answers. Claude Code's `tool_result`
        // block carries no tool name at all, so for that harness this is the *whole*
        // pairing, and matching on the name would not merely be weaker — it would be
        // impossible.
        callId: detail.callId,
        outcome: detail.failed ? "failed" : "ok",
      };
    case "opaque":
      return undefined;
  }
};

/**
 * One refused action as one transcript item.
 *
 * Only called for a denial; see the contract on why an allowed decision is not projected.
 * `attemptId` is what the supervisor said holds this session, and a decision that could not
 * be placed never reaches here.
 */
export const projectDecision = (
  decision: AnsweredDecision,
  attemptId: string,
): LiveItem | undefined => {
  if (decision.decision.effect !== "deny") return undefined;
  const input = ((): string | null => {
    try {
      return JSON.stringify(decision.request.input) ?? null;
    } catch {
      // A tool input the hook sent that will not round-trip. The refusal is the thing that
      // matters and it still appears; the arguments are simply unavailable.
      return null;
    }
  })();
  return {
    _tag: "item",
    id: `activity:decision:${String(decision.id)}`,
    origin: "activity",
    sequence: null,
    kind: "action.denied",
    at: decision.at,
    attemptId,
    /**
     * Null, and that is a gap worth naming rather than papering over.
     *
     * A denial is placed by **harness session id** against the attempt supervisor's map
     * (see {@link projectDecision}'s caller), and a planner round's session is not in that
     * map — so a tool call the gate refuses inside a planning directory does not reach this
     * feed at all, and nothing reaches it with a round on it. The gate still writes it to
     * the engagement's audit file, which the contract already names as the only complete
     * record of refusals. Reading that file back is its own day's work; what must not happen
     * meanwhile is a round's denial arriving filed under no round and looking like a
     * worker's.
     */
    roundId: null,
    headline: "Denied",
    // The gate's own sentence, unsoftened. It is the only description of this refusal that
    // exists, and a handler that rephrased it would be describing a rule it cannot read.
    body: decision.decision.reason,
    tool: decision.request.tool,
    // Reduced against the attempt's own registration, which is the only one a decision this
    // feed can place could have come through. A gate denial of a *round's* tool never
    // reaches here at all — see `roundId` above.
    toolName:
      bareToolName(decision.request.tool, bitMcpServerName(attemptId)) ?? null,
    input,
    output: null,
    // The gate's request carries a session id, a tool name and the arguments, and no call
    // id: the hook is a plugin inside the harness process and the harness does not tell it
    // which of its own calls this is. So a refusal cannot be paired with the `tool.call`
    // item beside it, and claiming otherwise by matching on the tool name would pair it
    // with the wrong one of two concurrent calls.
    callId: null,
    outcome: "denied",
  };
};

/* ── The stream ──────────────────────────────────────────────────────────────── */

/** What the record reader carries between pages. */
interface ReadState {
  /** The last sequence handed to the stream. The next read is strictly after it. */
  readonly cursor: number;
  /** When a {@link LiveCursor} was last sent, so the heartbeat is one timer and not two. */
  readonly announcedAt: number;
  /**
   * Whether the client has already been told it is caught up at this cursor.
   *
   * Carried rather than recomputed, because "caught up" is announced from two places and
   * must be announced *promptly* from both. A page shorter than the limit proves it; an
   * empty read proves it too, and is the only proof available when a catch-up happened to
   * end on an exact page boundary. Without this flag that case waited a whole heartbeat to
   * be told — a client that had been sent everything sat showing "catching up" for twenty
   * seconds.
   */
  readonly caughtUp: boolean;
}

/** What {@link liveTranscript} needs. Narrow on purpose: every part is substitutable. */
export interface LiveTranscriptInput {
  readonly targetId: string;
  /**
   * The ordered read, exactly as `ObservationStore.eventsAfter` gives it.
   *
   * A function rather than the store itself, because this module has no business holding a
   * database handle: the route borrows one from the per-target resolver for the length of
   * the connection and passes the one method this needs. It also means the ordering claim
   * can be tested against a scripted reader *and* against a real file, which are two
   * different things worth checking.
   */
  readonly events: (
    after: number,
    limit: number,
  ) => Effect.Effect<readonly RecordedEvent[]>;
  /**
   * The highest sequence the **event log** has assigned, for the opening frame and the
   * replay budget.
   *
   * `ObservationStore.currentEventSequence`, not `currentSequence` — that one is the
   * observations' own counter and the two advance at different rates. Reading the wrong one
   * is a mistake with no symptom until a target has observations and a watcher is told the
   * record ends somewhere it does not.
   */
  readonly latestSequence: Effect.Effect<number>;
  readonly narrations: RunNarrations["Service"];
  readonly decisions: PolicyDecisions["Service"];
  /**
   * Which attempt of *this* target holds a harness session, or `undefined`.
   *
   * The only way a policy decision is attributed. Returning `undefined` for a session that
   * belongs to another target is what keeps one engagement's refusals off another's
   * screen, so this must answer about this target and not about the process.
   */
  readonly attemptForSession: (
    harnessSessionId: string,
  ) => Effect.Effect<string | undefined>;
  /** Where to resume. Absent means {@link LIVE_REPLAY_BUDGET} back from the end. */
  readonly cursor?: number | undefined;
  /** Overridable so a test does not wait a real second. */
  readonly sweep?: Duration.Input | undefined;
  readonly heartbeat?: Duration.Input | undefined;
  readonly page?: number | undefined;
  readonly replayBudget?: number | undefined;
}

/**
 * One target's live transcript as a stream of frames.
 *
 * The opening frame first, then the record channel and the activity channel merged. The
 * merge is concurrent, so a reader sleeping out a sweep interval on the record side does
 * not hold up narration — and conversely a burst of narration does not delay the next
 * ordered read.
 *
 * **Record items keep their order through the merge**, because they are produced by one
 * pull on one stream in ascending sequence: `Stream.merge` interleaves the two sources but
 * never reorders within one of them. Activity items land wherever they land, which is why
 * they carry no sequence to be wrong about.
 *
 * The error channel is `never`. Every failure the read can produce is a defect here: by the
 * time this is called the route has already opened the target through the resolver, so a
 * `DatabaseError` from `SELECT … FROM events` is this server being broken, which is not a
 * state an operator can act on from a transcript. The caller dies rather than sending a
 * frame that claims the run is over.
 */
export const liveTranscript = (
  input: LiveTranscriptInput,
): Stream.Stream<LiveFrame> => {
  const page = input.page ?? LIVE_PAGE;
  const budget = input.replayBudget ?? LIVE_REPLAY_BUDGET;
  const sweep = input.sweep ?? LIVE_SWEEP;
  const heartbeat = input.heartbeat ?? LIVE_HEARTBEAT;

  const activity = Stream.merge(
    input.narrations.subscribe({ targetId: input.targetId }).pipe(
      Stream.filterMap(
        Filter.make((item: RunNarration) => {
          const projected = projectNarration(item);
          return projected === undefined
            ? Result.fail(item)
            : Result.succeed(projected);
        }),
      ),
    ),
    input.decisions.answered.pipe(
      Stream.filterMapEffect(
        Filter.makeEffect((decision: AnsweredDecision) =>
          Effect.map(
            input.attemptForSession(decision.request.sessionId),
            (attemptId) => {
              if (attemptId === undefined) return Result.fail(decision);
              const projected = projectDecision(decision, attemptId);
              return projected === undefined
                ? Result.fail(decision)
                : Result.succeed(projected);
            },
          ),
        ),
      ),
    ),
  );

  return Stream.unwrap(
    Effect.gen(function* () {
      const latest = yield* input.latestSequence;
      const now = yield* Clock.currentTimeMillis;
      // A client's cursor is honoured as given, clamped only against nonsense: a negative
      // or fractional value can ask for more history than exists, which reads from the
      // start, and refusing it would turn a harmless query string into a dead screen.
      const asked =
        input.cursor === undefined
          ? undefined
          : Math.max(0, Math.trunc(input.cursor));
      const from = asked ?? Math.max(0, latest - budget);
      const opened: LiveOpened = {
        _tag: "opened",
        targetId: input.targetId,
        from,
        latest,
        // Only a budgeted start skips anything. A client that passed a cursor is being
        // answered from exactly where it asked, so nothing was withheld from it.
        skipped: asked === undefined ? from : 0,
        at: now,
      };

      /** What one page of the record read answers with: frames, and where to read next. */
      type Page = readonly [readonly LiveFrame[], Option.Option<ReadState>];

      const records: Stream.Stream<LiveFrame> = Stream.paginate(
        { cursor: from, announcedAt: 0, caughtUp: false } satisfies ReadState,
        (state: ReadState) =>
          Effect.gen(function* () {
            const rows = yield* input.events(state.cursor, page);
            const at = yield* Clock.currentTimeMillis;
            const last = rows[rows.length - 1];
            if (last !== undefined) {
              // A full page means there is very likely more behind it, so the next pull
              // reads again immediately rather than sleeping. Saying `caughtUp` here would
              // make a long catch-up look finished while it was still arriving — and the
              // empty read that follows says so a moment later, which is the right
              // direction to be wrong in.
              const drained = rows.length < page;
              const cursor: LiveCursor = {
                _tag: "cursor",
                sequence: last.sequence,
                caughtUp: drained,
                at,
              };
              return [
                [...rows.map(projectEvent), cursor],
                Option.some({
                  cursor: last.sequence,
                  announcedAt: at,
                  caughtUp: drained,
                }),
              ] satisfies Page;
            }
            /**
             * Nothing new, so this reader is caught up — and says so **at once** if it has
             * not said so already.
             *
             * `state.caughtUp` is what makes that prompt rather than heartbeat-paced, and it
             * covers both cases that reach here: a stream opened against a quiet target,
             * and a catch-up that ended on an exact page boundary and so could not be
             * proved drained by a short page.
             *
             * Once it has been said, every empty read sleeps first and announces only when
             * a heartbeat is due — so an idle connection costs one `SELECT` per sweep and
             * one frame per heartbeat, and not one frame per sweep.
             */
            if (!state.caughtUp) {
              return [
                [
                  {
                    _tag: "cursor",
                    sequence: state.cursor,
                    caughtUp: true,
                    at,
                  } satisfies LiveCursor,
                ],
                Option.some({ ...state, announcedAt: at, caughtUp: true }),
              ] satisfies Page;
            }
            yield* Effect.sleep(sweep);
            const settled = yield* Clock.currentTimeMillis;
            if (settled - state.announcedAt >= Duration.toMillis(heartbeat)) {
              return [
                [
                  {
                    _tag: "cursor",
                    sequence: state.cursor,
                    caughtUp: true,
                    at: settled,
                  } satisfies LiveCursor,
                ],
                Option.some({ ...state, announcedAt: settled }),
              ] satisfies Page;
            }
            return [[], Option.some(state)] satisfies Page;
          }),
      );

      return Stream.concat(
        Stream.succeed<LiveFrame>(opened),
        Stream.merge(records, activity),
      );
    }),
  );
};
