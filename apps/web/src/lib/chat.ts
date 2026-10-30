/**
 * The chat's grouping and merge rules, as plain functions.
 *
 * ## Why this is a module and not component code
 *
 * `scroll.ts` exists because a `.svelte` file cannot be imported by `bun test` and the
 * fraction-of-a-pixel slack in "is the reader at the bottom" is exactly the kind of thing a
 * test catches and a glance does not. This module exists for the same reason and with more
 * at stake: every claim the planner chat makes about **what happened** is decided here — a
 * tool call that produced a record, a tool call that produced nothing, a round whose prose
 * the harness has thrown away — and each of those is a sentence an operator will act on.
 * {@link Chat.svelte} renders what this returns and decides nothing.
 *
 * ## Two channels, three absences, one merge
 *
 * The chat is assembled from three sources and they are not equal-status:
 *
 * 1. **The round rows** (`PlanRoundView`), which are durable. A round's identity, status
 *    and disposition come from here and from nowhere else, which is what makes the
 *    structure of a planner session survive a reload — the spec's decision 16.
 * 2. **Live items** (`LiveItem`), which are the target's SSE feed. Within it, `record`
 *    items are committed and ordered and `activity` items are in-process, lossy and
 *    unordered; `live.ts` is where that distinction is written down and this module never
 *    collapses it.
 * 3. **The replay** (`GoalNarrationView`), which is the harness's own copy of the prose,
 *    asked for on open. Narration is never stored (decision 14), so this is the only thing
 *    a reloaded tab can show for a round it did not watch — and the harness may have
 *    deleted it, which is a state and not an error.
 *
 * The merge rule is the spec's: **a write arrives twice and must be shown once.** The
 * planner calls `add_intent`, which reaches this feed immediately as a `tool.call` on the
 * activity channel — unconfirmed, because the gate or the store may still refuse it — and
 * then again as the `intent.added` record it produced. Rendering both would show one intent
 * as two; rendering only the call would report a write that may have been refused. So the
 * call is rendered as **pending** and collapses into the record when the record arrives,
 * the record wins and carries the real id, and a call that never produces one stays
 * **visibly unresolved**. {@link WriteState} is those four answers.
 */
import type {
  GoalNarrationView,
  LiveItem,
  PlanRoundView,
} from "@bit/contracts";
import { dispositionLabel } from "./goalFormat";

/**
 * Readable text for the kinds this build knows, from `LIVE_ITEM_KINDS`.
 *
 * A lookup rather than a union-exhaustive switch, because `LiveItem.kind` is a string on
 * the wire on purpose: the set only grows, and a tab one deploy behind the server must
 * render a kind it has never seen rather than hiding the item. Hence the verbatim fallback
 * in {@link kindLabel} — an unknown kind shows as itself.
 */
const KIND_LABELS: Record<string, string | undefined> = {
  "run.started": "Run started",
  "run.settled": "Run settled",
  "observation.recorded": "Observation",
  "asset.recorded": "Asset",
  "intent.added": "Intent",
  "goal.added": "Goal",
  "goal.ended": "Goal ended",
  "intent.abandoned": "Intent abandoned",
  "intent.released": "Intent released",
  "plan.round.started": "Planner round",
  "plan.round.settled": "Planner round settled",
  "record.other": "Event",
  "turn.reply": "Reply",
  "tool.call": "Tool call",
  "tool.result": "Tool result",
  "action.denied": "Denied",
};

/** The kind as words, or the kind itself when this build has never heard of it. */
export const kindLabel = (kind: string): string => KIND_LABELS[kind] ?? kind;

/**
 * Which tint an outcome gets.
 *
 * The vocabularies are deliberately not normalised in the contract — an observation's
 * `negative` and a tool's `failed` are not the same claim — so this maps the words it knows
 * and leaves anything else plain rather than guessing at a severity.
 */
export const outcomeTint = (
  outcome: string,
): "danger" | "success" | "warning" | "plain" => {
  switch (outcome) {
    case "denied":
    case "failed":
      return "danger";
    case "succeeded":
    case "ok":
    case "positive":
    case "met":
      return "success";
    case "negative":
    case "inconclusive":
    case "uncertain":
    case "interrupted":
      return "warning";
    default:
      return "plain";
  }
};

/**
 * How many of a goal's rounds the chat shows.
 *
 * **It mirrors the server's `GOAL_NARRATION_ROUND_LIMIT`, and the mirroring is the point.**
 * The server replays the newest eight rounds' prose because each one costs a request into
 * the harness; a chat that rendered more would have rounds it could never show prose for,
 * and the honest rendering of that is not a fifth state — it is not putting them in the
 * chat. Every round, including the ones past this, is listed with its status and its
 * disposition in the planner panel above, which reads from the rows and is cheap.
 *
 * Should the two numbers ever drift, a shown round with no replay entry reads as
 * {@link RoundProse} `unasked`, which says exactly that. It is not reachable today.
 */
export const CHAT_ROUNDS_SHOWN = 8;

/**
 * The tools whose call is a *write*, and the record kind each one produces.
 *
 * **Keyed on {@link LiveItem.toolName}, the reduced name, and that is the whole of a bug
 * this slice shipped with.** A planner's tools arrive over MCP, so `LiveItem.tool` carries
 * the driver's namespaced form — `mcp__bit-<roundId>__add_intent` under Claude Code,
 * `bit-<roundId>.add_intent` under OpenCode — and a table keyed on *that* matched nothing
 * against a real round: every write rendered twice, no write state was ever computed, and
 * `unresolved` was unreachable. The reduction is the server's, done where the registration's
 * own name is known (`mcpToolName.ts`), so this table can name the tool as the toolkit
 * declares it.
 */
const WRITE_TOOLS: Record<string, string | undefined> = {
  /** One proposed intent, one `intent.added`. */
  add_intent: "intent.added",
  /**
   * The round's conclusion, which reaches the record as part of `plan.round.settled`.
   *
   * There is no `plan.round.disposition` event: the disposition is written onto the round
   * row and appears in the record when the round settles, carrying it in the payload. So a
   * recorded disposition stays **pending** until the round ends, which is accurate — until
   * then the only evidence it took is the tool's own result.
   */
  record_round_disposition: "plan.round.settled",
};

/**
 * What became of a write a planner round attempted.
 *
 * - `recorded` — the record arrived. It is what the row shows, it carries the real id, and
 *   the call that proposed it is folded into it.
 * - `refused` — the harness reported the call failed. The write did not happen, and this is
 *   a resolved answer rather than an open question: `add_intent`'s refusals are instructive
 *   and the tool's own output is where they are.
 * - `pending` — the round is still running and neither a record nor a failure has arrived.
 *   The ordinary state of a write for the second it is in flight.
 * - `unresolved` — the round has settled and this call produced neither a record nor a
 *   stated failure. **The one state that must stay visible.** Narration is lossy and a
 *   record is not: so this is either a write whose record this tab dropped, or a call that
 *   really did nothing, and the chat is not allowed to guess which.
 */
export type WriteState = "recorded" | "refused" | "pending" | "unresolved";

/**
 * The one-line domain summary of a write the planner asked for, or `null`.
 *
 * The brief: a tool call shows "a one-line domain summary (`add_intent` → the question it
 * proposed; `record_round_disposition` → the disposition)". Without it the row is the raw
 * MCP tool name over two empty disclosure labels, and the question the planner proposed
 * reaches the screen only once the `intent.added` record arrives — which is exactly what a
 * *pending* call cannot rely on, and so exactly when the operator needs it.
 *
 * ## Why this sentence is composed in the browser when `headline` and `body` are not
 *
 * `live.ts` is explicit that the server writes those two, "because the server is where the
 * sentence can be accurate: it has the policy gate's reason, the resolver's words for a
 * harness, and the store's payload. A browser that rephrased them would be inventing
 * wording for states it cannot see." None of that applies here. A tool call's **arguments**
 * are on the item verbatim, already capped by the server, and this reads one field out of
 * them. There is no state it cannot see, and nothing is rephrased.
 *
 * ## It never guesses
 *
 * The arguments are capped at `NARRATION_FIELD_MAX` with a marker appended, so a large
 * `add_intent` arrives as invalid JSON. That returns `null` and the row simply carries no
 * summary — the arguments are still there to open. Inventing a sentence from a half-parsed
 * payload would be the one failure a summary must not have.
 */
export const domainSummary = (
  call: Pick<LiveItem, "toolName" | "input">,
): string | null => {
  if (call.toolName === null || call.input === null) return null;
  const field = WRITE_SUMMARY_FIELDS[call.toolName];
  if (field === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.input);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = (parsed as Record<string, unknown>)[field];
  if (typeof value !== "string" || value.trim() === "") return null;
  return call.toolName === "record_round_disposition"
    ? // The disposition in the words the panel above already uses for it, so one round does
      // not read as two different conclusions on one page. An answer outside the four is
      // shown verbatim rather than dropped: it is what the planner said.
      DISPOSITIONS.has(value)
      ? dispositionLabel(value as Parameters<typeof dispositionLabel>[0])
      : value
    : value;
};

/** Which argument carries the summary, per write tool. */
const WRITE_SUMMARY_FIELDS: Record<string, string | undefined> = {
  /** The question the round proposed. `plannerTools.ts` takes it as `question`. */
  add_intent: "question",
  /** One of the four answers. `plannerTools.ts` takes it as `disposition`. */
  record_round_disposition: "disposition",
};

/** The four the planner may record, for turning a disposition into the panel's words. */
const DISPOSITIONS: ReadonlySet<string> = new Set([
  "actionable",
  "waiting",
  "no_useful_next_action",
  "objective_met",
]);

/** One row of a round's conversation. */
export interface ChatRow {
  /** Stable key for `{#each}`. The rendered item's own id, which is already stable. */
  readonly key: string;
  /**
   * What the row renders: the **record** when a write produced one, otherwise the call or
   * the turn itself. The record wins, by the merge rule.
   */
  readonly item: LiveItem;
  /**
   * The `tool.call` that proposed this write, when the row is a collapsed pair.
   *
   * Kept rather than discarded because it is the only place the *arguments* are: a record's
   * payload is the server's sentence about what was committed, and the call is what the
   * model asked for. Null on a row that is not a collapsed pair.
   */
  readonly proposedBy: LiveItem | null;
  /** The `tool.result` paired to this call by `callId`. Null when none arrived. */
  readonly result: LiveItem | null;
  /** The write's state, or null on a row that is not a write at all. */
  readonly write: WriteState | null;
  /**
   * The call's one-line domain summary, or null.
   *
   * Taken from the **call**, which is where the arguments are — on a collapsed pair that is
   * {@link proposedBy} rather than {@link item}. {@link ChatItem} shows it only when the
   * rendered item has no body of its own, so a committed record's own sentence is never
   * doubled by a paraphrase of the request that produced it.
   */
  readonly summary: string | null;
}

/**
 * What a round's prose situation is, in the words the chat prints.
 *
 * **The three absences the spec insists on telling apart are three tags here**, and the
 * reason they cannot be one is that they call for different things from an operator:
 * `pending` is worth waiting for, `forgotten` is not, and `none` says the round really did
 * its work without narrating. A fourth, `live`, is a round this tab is watching, and
 * `loading` is the moment before the replay has answered.
 */
export type RoundProse =
  | {
      /** The replay has not answered yet and this tab has nothing of its own. */
      readonly _tag: "loading";
    }
  | {
      /**
       * This tab is watching the round and the replay holds nothing.
       *
       * Narrower than it reads: a round whose replay *does* have messages is `replayed`
       * even while live rows keep arriving, because both halves are shown. See
       * {@link proseFor}.
       */
      readonly _tag: "live";
    }
  | {
      readonly _tag: "replayed";
      readonly note: string;
      /** Always true: a replay is the harness's copy and the harness may delete it. */
      readonly ephemeral: boolean;
      readonly truncated: boolean;
    }
  | { readonly _tag: "pending"; readonly note: string }
  | { readonly _tag: "forgotten"; readonly note: string }
  | { readonly _tag: "none"; readonly note: string }
  | { readonly _tag: "unasked"; readonly note: string };

/** One round as the chat shows it: a separator, its replayed prose, and its live rows. */
/**
 * One stretch of conversation under one heading, with its subject left opaque.
 *
 * **The subject is a type parameter and the component never looks inside it**, which is the
 * other half of ruling 1 and the half this slice first got wrong. The composer was a prop,
 * so slice 9 could turn it on; the *data* was the planner's, so slice 9 would have had to
 * refactor the component anyway — which is the work being sequenced before slice 9 was
 * supposed to prevent. A goal conversation has no rounds in it at all, and rendering it
 * through a `PlanRoundView` would have meant fabricating a status, a disposition, a budget
 * and an `intentsAdded` that mean nothing, under a separator reading "Planner round".
 *
 * So {@link Chat} takes groups and a `separator` snippet, and the caller renders its own
 * heading from its own subject. What stays shared is everything that is genuinely about a
 * conversation with an agent: the grouping, the record-versus-activity distinction, the
 * folding of a tool result into its call, the pending-until-recorded merge rule, and the
 * replayed-prose states.
 */
export interface ChatGroup<Subject> {
  /** Stable identity for `{#each}`. The round id, or whatever the caller groups by. */
  readonly key: string;
  /** Whatever the caller needs to render its own separator. Opaque here. */
  readonly subject: Subject;
  readonly prose: RoundProse;
  /** The harness's replayed messages, oldest first. Empty unless `prose` is `replayed`. */
  readonly replayed: GoalNarrationView["rounds"][number]["messages"];
  /** The live conversation, in arrival order. */
  readonly rows: readonly ChatRow[];
}

/** What a planner round's separator needs, and the whole of what the chat is given. */
export interface PlannerSubject {
  /** The row. Where the status and the disposition come from, and the only durable half. */
  readonly round: PlanRoundView;
  /** True when *this process* is driving it, which is what justifies a stop control. */
  readonly inFlight: boolean;
}

/** One planner round as a chat group. */
export type ChatRound = ChatGroup<PlannerSubject>;

/** The whole chat: rounds oldest-last, plus what is not in it. */
export interface ChatView {
  /** Oldest first, so the newest round is at the bottom where a chat's newest turn is. */
  readonly groups: readonly ChatRound[];
  /**
   * Rounds this chat is not showing, which the planner panel above still lists.
   *
   * Said rather than swallowed, for `LiveOpened.skipped`'s reason: a view that showed the
   * newest rounds as though they were all of them would be the wrong kind of quiet.
   */
  readonly older: number;
}

/**
 * This process's publish order for an activity item, or `undefined`.
 *
 * `LiveItem.id` is `activity:<n>` for a narration entry, where `n` is the server's own
 * publish counter — see `narration.ts` on what that is and is not. It is **not** a cursor
 * and means nothing across a restart; what it is good for is the one thing needed here,
 * which is telling "this entry arrived before we read the replay" from "after".
 *
 * A refused action is `activity:decision:<n>` and is counted by a different service, so it
 * deliberately does not parse: those carry no round anyway and never enter a round's rows.
 */
export const activityOrder = (item: LiveItem): number | undefined => {
  if (item.origin !== "activity") return undefined;
  const rest = item.id.startsWith("activity:") ? item.id.slice(9) : "";
  if (rest === "" || !/^\d+$/.test(rest)) return undefined;
  return Number(rest);
};

/**
 * Pairs a round's write calls to the records they produced, in order.
 *
 * **In order, and not by any shared id, because there is no shared id.** A `tool.call`
 * carries the harness's `callId` and the record it produces carries the store's own
 * subject id; nothing joins them. What is true is that a round's writes are committed in
 * the order it made them, so the i-th `add_intent` call of a round belongs with the i-th
 * `intent.added` that round wrote — and a round's records cannot be interleaved with
 * another round's here, because the rows have already been filtered to this round.
 *
 * The matching is deliberately **not** conditioned on the record arriving after the call.
 * It generally does, and the exceptions are real: the record channel is ordered and the
 * activity channel is not, so a narration entry can land after the record it describes, and
 * a reconnect replays records with no activity at all. Requiring the order would turn one
 * late narration entry into a row claiming an intent was never recorded.
 */
const pairWrites = (
  items: readonly LiveItem[],
): ReadonlyMap<string, LiveItem> => {
  /** Unclaimed records per kind, oldest first. */
  const unclaimed = new Map<string, LiveItem[]>();
  for (const item of items) {
    if (item.origin !== "record") continue;
    const queue = unclaimed.get(item.kind);
    if (queue === undefined) unclaimed.set(item.kind, [item]);
    else queue.push(item);
  }
  const paired = new Map<string, LiveItem>();
  for (const item of items) {
    if (item.kind !== "tool.call" || item.toolName === null) continue;
    const wanted = WRITE_TOOLS[item.toolName];
    if (wanted === undefined) continue;
    const record = unclaimed.get(wanted)?.shift();
    if (record !== undefined) paired.set(item.id, record);
  }
  return paired;
};

/** Which write state a call with no record is in. */
const unrecorded = (
  result: LiveItem | null,
  roundRunning: boolean,
): WriteState =>
  result?.outcome === "failed"
    ? "refused"
    : roundRunning
      ? "pending"
      : "unresolved";

/**
 * One round's live rows, with results folded into their calls and writes collapsed into
 * their records.
 *
 * Arrival order is kept and nothing is re-sorted: `liveItems` is already in arrival order
 * and on the record channel that *is* the store's order, so re-sorting would either break
 * it or invent a sequence for activity items the contract refuses to claim.
 */
const rowsFor = (
  items: readonly LiveItem[],
  roundRunning: boolean,
): readonly ChatRow[] => {
  const paired = pairWrites(items);
  /** Results by the call they answer. A result with no `callId` cannot be paired at all. */
  const results = new Map<string, LiveItem>();
  for (const item of items) {
    if (item.kind === "tool.result" && item.callId !== null) {
      results.set(item.callId, item);
    }
  }
  /** Records that have been claimed by a call, so they are not also rendered alone. */
  const claimed = new Set([...paired.values()].map((record) => record.id));
  const rows: ChatRow[] = [];
  for (const item of items) {
    // Folded into the call it answers. One that names no call stays a row of its own —
    // falling back to the tool name would attribute one command's output to another.
    if (
      item.kind === "tool.result" &&
      item.callId !== null &&
      items.some(
        (other) => other.kind === "tool.call" && other.callId === item.callId,
      )
    ) {
      continue;
    }
    if (item.kind === "tool.call") {
      const result =
        (item.callId === null ? undefined : results.get(item.callId)) ?? null;
      const isWrite =
        item.toolName !== null && WRITE_TOOLS[item.toolName] !== undefined;
      const summary = domainSummary(item);
      const record = paired.get(item.id);
      if (record !== undefined) {
        rows.push({
          key: record.id,
          item: record,
          proposedBy: item,
          result,
          write: "recorded",
          summary,
        });
        continue;
      }
      rows.push({
        key: item.id,
        item,
        proposedBy: null,
        result,
        write: isWrite ? unrecorded(result, roundRunning) : null,
        summary,
      });
      continue;
    }
    if (claimed.has(item.id)) continue;
    rows.push({
      key: item.id,
      item,
      proposedBy: null,
      result: null,
      write: null,
      summary: null,
    });
  }
  return rows;
};

/**
 * What to say about a round's prose, from the replay and from what this tab holds.
 *
 * **A replay with messages in it is shown even when live rows arrive after it**, and that
 * is the join the spec asks for rather than a choice between the two halves. The replay is
 * the harness's copy of what was said *before this page connected*; the live rows are what
 * arrived after. Hiding the replay the moment one live entry landed would make a refresh
 * mid-round lose everything the round had already said — the opposite of degrading
 * honestly.
 *
 * What makes showing both safe is the floor in {@link buildChat}, and it is worth being
 * precise about what that is: nothing can dedupe the two *by content*. The replay is the
 * reduced `{ type, text, error }` shape with no call ids, and a `LiveItem` carries this
 * process's publish counter rather than the harness's cursor — Claude Code has no cursor at
 * all — so "the harness's own message index" the spec names is not on both sides. The
 * dedupe is by *our* arrival order instead, and the replayed block says it is a replay
 * rather than claiming completeness, which is why a residual overlap is tolerable where a
 * silent guess by tool name would not be.
 *
 * `live` is therefore the narrower case it should always have been: a round this tab is
 * watching whose replay holds nothing — either because the harness had not flushed it yet,
 * or because the round started after the replay was read.
 */
const proseFor = (
  replayed: GoalNarrationView["rounds"][number] | undefined,
  hasLive: boolean,
): RoundProse => {
  if (replayed !== undefined && replayed.messages.length > 0) {
    return {
      _tag: "replayed",
      note: replayed.note,
      ephemeral: replayed.ephemeral,
      truncated: replayed.truncated,
    };
  }
  if (hasLive) return { _tag: "live" };
  if (replayed === undefined) return { _tag: "loading" };
  switch (replayed.source) {
    case "harness":
      // The server does not produce this: `harness` means it had messages, and the branch
      // above has already taken that case. Treated as the absence it would be rather than
      // as an empty success.
      return { _tag: "none", note: replayed.note };
    case "pending":
      return { _tag: "pending", note: replayed.note };
    case "forgotten":
      return { _tag: "forgotten", note: replayed.note };
    case "none":
      return { _tag: "none", note: replayed.note };
  }
};

/**
 * Builds the chat from the rows, the live feed and the replay.
 *
 * `narrationFloor` is the activity publish order at the moment the replay answered — see
 * {@link activityOrder}. Narration at or below it is already in the replayed block, so it
 * is dropped from the live rows; above it is this tab's own tail. `undefined` means no
 * replay has landed, in which case every live item this tab holds is its own.
 *
 * Records are **never** filtered by that floor. They are durable, ordered and deduplicated
 * by stable id, so a reconnect that re-reads a range shows nothing twice — and a record is
 * the only evidence a write took, which is the one thing a chat must not drop to tidy up an
 * overlap.
 */
export const buildChat = (input: {
  /** Newest first, as the server orders them. */
  readonly rounds: readonly PlanRoundView[];
  readonly items: readonly LiveItem[];
  readonly narration: GoalNarrationView | undefined;
  readonly narrationFloor: number | undefined;
  /** Round ids this process is driving right now. */
  readonly inFlight: ReadonlySet<string>;
}): ChatView => {
  const shown = input.rounds.slice(0, CHAT_ROUNDS_SHOWN);
  const replays = new Map(
    (input.narration?.rounds ?? []).map((round) => [round.roundId, round]),
  );
  const narration = input.narration;
  const groups = [...shown].reverse().map((round): ChatRound => {
    const mine = input.items.filter((item) => item.roundId === round.roundId);
    const live = mine.filter((item) => {
      const order = activityOrder(item);
      if (order === undefined) return true;
      return input.narrationFloor === undefined || order > input.narrationFloor;
    });
    const hasLive = live.some((item) => item.origin === "activity");
    const replayed = replays.get(round.roundId);
    /**
     * A round the replay has no entry for is one of two different things, and the
     * replay's own timestamp is what tells them apart.
     *
     * A round that **started after** the replay answered is simply newer than it — the
     * ordinary case for the round an operator has just opened from this page — and the
     * read that will cover it is already on its way, so it reads as `loading` rather
     * than as something that was never asked for. A round older than the replay and
     * absent from it is past the budget: the chat says so, and the planner panel above
     * still has its status and its disposition.
     */
    const prose =
      replayed === undefined && narration !== undefined && !hasLive
        ? round.startedAt > narration.at
          ? ({ _tag: "loading" } satisfies RoundProse)
          : ({
              _tag: "unasked",
              note: "This round's narration was not read: only the most recent rounds are replayed from the harness. Its status and what it concluded are above.",
            } satisfies RoundProse)
        : proseFor(replayed, hasLive);
    return {
      key: round.roundId,
      subject: { round, inFlight: input.inFlight.has(round.roundId) },
      prose,
      replayed: prose._tag === "replayed" ? (replayed?.messages ?? []) : [],
      rows: rowsFor(live, round.status === "running"),
    };
  });
  return { groups, older: input.rounds.length - shown.length };
};
