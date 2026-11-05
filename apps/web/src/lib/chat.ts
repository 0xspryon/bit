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
  GoalConversationView,
  GoalNarrationView,
  LiveConnection,
  LiveItem,
  LiveUsage,
  MessageAttachmentView,
  PlanRoundView,
} from "@bit/contracts";
import { NARRATION_FIELD_MAX } from "@bit/contracts";
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
  /**
   * An entry written onto a target's scope: the importer's `add_scope_entry`, or an
   * operator typing one in. Only the importer's reach a chat (`LiveItem.importId`).
   */
  "scope.entry.added": "Scope entry",
  /** An asset the importer read off a program page (`record_imported_asset`, D14). */
  "asset.imported": "Asset",
  "intent.added": "Intent",
  "goal.added": "Goal",
  "goal.ended": "Goal ended",
  "intent.abandoned": "Intent abandoned",
  "intent.released": "Intent released",
  "plan.round.started": "Planner round",
  "plan.round.settled": "Planner round settled",
  "plan.round.steered": "Steered",
  "record.other": "Event",
  "turn.reply": "Reply",
  /**
   * What was considered, which is **not** a record of what happened.
   *
   * The label is a noun rather than a verb for that reason: "Thinking" is the kind of thing
   * the row holds, where "Thought" or "Decided" would read as a conclusion. `ChatItem`
   * renders it collapsed and says the rest in words.
   */
  "turn.thinking": "Thinking",
  "tool.call": "Tool call",
  /**
   * The operator's own message. Live, minted in this tab ({@link operatorTurn}) so what was
   * just typed appears; on a reload, the server's replay of the harness's copy (A6 F10).
   */
  "turn.operator": "You",
  /**
   * Something the harness holds that is neither side's words — an OpenCode `shell` entry, a
   * steer a round was sent, an error on a turn. Its `headline` is the harness's own word.
   */
  "turn.other": "Harness",
  "tool.result": "Tool result",
  /**
   * The harness took a message sent while a turn ran (A6 U4). The importer chat never draws
   * it — it only stops drawing that message as queued — so this word is the Live panel's.
   */
  "turn.taken": "Message taken",
  /**
   * A message's turn ended before it wrote anything and the harness sent the message on with
   * the next one (A6 U6 review 2). The importer chat draws it as that turn's note, never a
   * row, so this word too is the Live panel's.
   */
  "turn.carried": "Went on with the next message",
  /** A sub-agent the agent started, as one entry (A6 U14). See {@link SUBAGENT_KIND}. */
  subagent: "Sub-agent",
  "action.denied": "Denied",
};

/**
 * The kind a sub-agent's entry carries: the server's string (`live.ts`'s `subagent`).
 *
 * One state of one sub-agent: its type in `headline`, its task in `body` (both the calling
 * agent's words, drawn as plain text), and `running`, `finished`, `failed` or `stopped` in
 * `outcome`. Several share a `callId` as it starts and ends; {@link foldSubagents} makes
 * them one entry.
 */
export const SUBAGENT_KIND = "subagent";

/**
 * What a sub-agent entry says about what it does not show (A6 U14, decided by the
 * operator). The server narrates a sub-agent's own thinking, tool calls and replies as
 * nothing, live and on reload, so the entry says where they went.
 */
export const SUBAGENT_NOTE =
  "Its own messages and tool calls are not shown here: viewing a sub-agent's work is postponed to V2.";

/**
 * Each sub-agent as **one** item, at the place its first state arrived, carrying its
 * newest state (A6 U14).
 *
 * The server sends a sub-agent's states as separate items sharing the calling tool call's
 * `callId` — `running` at the call, then how it ended — live and in a replay alike. A
 * background sub-agent can end turns later, so the states of one can sit in different
 * groups of a conversation; the importer chat folds its whole list before cutting it into
 * turns, and {@link rowsFor} folds each group again, which changes nothing a second time.
 *
 * The folded item keeps the **first** state's `id` and `at` — the row's key, so the entry
 * is updated in place rather than drawn anew, and when it started — and takes everything
 * else from the newest. Newest by list order, which is arrival order live and the harness's
 * order in a replay; a replay's states come before the live tail's, so a reload's `running`
 * is overtaken by a `finished` that arrives after it. A state with no `callId` cannot be
 * joined to anything and stays an item of its own.
 */
export const foldSubagents = (
  items: readonly LiveItem[],
): readonly LiveItem[] => {
  const newest = new Map<string, LiveItem>();
  for (const item of items) {
    if (item.kind === SUBAGENT_KIND && item.callId !== null) {
      newest.set(item.callId, item);
    }
  }
  if (newest.size === 0) return items;
  const placed = new Set<string>();
  const folded: LiveItem[] = [];
  for (const item of items) {
    const callId = item.kind === SUBAGENT_KIND ? item.callId : null;
    if (callId === null) {
      folded.push(item);
      continue;
    }
    if (placed.has(callId)) continue;
    placed.add(callId);
    const last = newest.get(callId) ?? item;
    folded.push(last === item ? item : { ...last, id: item.id, at: item.at });
  }
  return folded;
};

/**
 * The kind a thinking row carries, named once so the component and the label agree.
 *
 * It is the server's string (`live.ts`'s `turn.thinking`) rather than a browser invention —
 * like {@link OPERATOR_TURN_KIND} — and it is a constant here
 * because {@link ChatItem} branches on it and a typo would silently render a model's
 * deliberation as an ordinary claim about what happened.
 */
export const THINKING_KIND = "turn.thinking";

/**
 * The kind an agent's own prose carries: the server's string (`live.ts`'s `turn.reply`).
 *
 * Named once because two things must agree on it — {@link ChatItem}'s branch that renders
 * a row as prose, and {@link lastProse}, which places a turn's footer under that row. A
 * footer hung on a row that was not drawn as prose would be a caption on the wrong thing.
 */
export const REPLY_KIND = "turn.reply";

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
    case "finished":
      return "success";
    case "negative":
    case "inconclusive":
    case "uncertain":
    case "interrupted":
    case "stopped":
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
 *
 * ## It covers **both** agents, and leaving one out shipped the same bug twice
 *
 * The planner's two tools were here and the goal agent's were not, so a steer and a goal
 * ending rendered **twice** in the goal conversation — once as the `tool.call` and once as
 * the record — while the planner's controls collapsed correctly. A whole-branch review
 * measured it: 2 rows where `add_intent` gives 1. `live.ts` already declared the pairing
 * this table did not implement, on `plan.round.steered`: "it is the record half of the
 * `steer_planner` tool call the agent made". Nothing caught it because no web test named a
 * goal-agent tool at all — which is why `chat.test.ts` and `chatComponent.test.ts` now
 * build those names through `mcpToolName.ts` rather than typing them.
 *
 * Both halves reach the goal conversation: `plan.round.steered` and `goal.ended` are
 * written under the goal agent's own caller scope, so `goalIdFromScope` sets
 * `LiveItem.goalId` and they pass `buildGoalConversation`'s filter; the calls arrive because
 * `plan/goalConversation.ts` publishes the harness's session events under the goal subject.
 */
const WRITE_TOOLS: Record<string, string | undefined> = {
  /** One proposed intent, one `intent.added`. The planner's. */
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
  /**
   * The goal agent steering a live round, and the record that says a steer landed.
   *
   * `plan.round.steered` carries no directive text (`event.ts`), so the collapsed row is
   * the record's sentence with the agent's own arguments one disclosure away — which is the
   * only place the directive is visible at all, since a steer is `opaque` on both drivers'
   * narration (DECISIONS.md §24.1).
   *
   * **Only the `steered` branch writes it.** Decision 12's other branch opens a round
   * carrying the directive and writes no steer event by design, so that call pairs with
   * nothing and resolves through {@link unrecorded} like any other unpaired write — which
   * is why {@link GoalChatInput.conversationLive} has to be the real liveness and not
   * `true`.
   */
  steer_planner: "plan.round.steered",
  /** The agent ending its own goal, one `goal.ended`. One-way, so exactly one of each. */
  end_goal: "goal.ended",
  /**
   * The scope importer's two writes (`ScopeImportTool` in `scopeImport.ts`; D13, D14).
   *
   * **The names are the tools' real ones, and a name that matches nothing here fails
   * silently**: the call renders as an ordinary tool call and never collapses into its
   * record, which would look like a merge bug when the feed arrives. They are keyed on the
   * reduced name, as the others are.
   *
   * **Every `add_scope_entry` that was not refused writes exactly one record**, including an
   * add of an entry that already exists: that writes nothing to the scope and a
   * `scope.entry.added` carrying `created: false`, whose sentence says "already in scope".
   * It used to write no record at all, and since {@link pairWrites} pairs by position, every
   * call after a no-op was folded into the record of the call before it. The fix is in the
   * store rather than here (the importer conversation design, S5.1), so this pairing needs
   * no knowledge of it.
   *
   * `record_imported_asset` writes one record per new `operation_id`, `created` or not. An
   * exact retry of one replays the stored answer and writes nothing — idempotence, not a
   * gap the store could close — so {@link pairWrites} skips a call whose result says
   * `replayed`, as it skips a refused one.
   *
   * `read_scope` is deliberately absent: it is a read and writes nothing.
   */
  add_scope_entry: "scope.entry.added",
  record_imported_asset: "asset.imported",
  /*
   * `wake_planner` is **deliberately absent**, which is a decision rather than the
   * oversight that left the two above out.
   *
   * It writes `plan.round.started`, and that event is appended with `callerScope: null` —
   * it is a fact about a round rather than about the agent that asked for one — so
   * `goalIdFromScope` yields nothing and the record never reaches this surface. Listing it
   * here would pair the call against a record that cannot arrive: every wake would read
   * `pending` while the conversation was live and `unresolved` once it was not, which is a
   * chat claiming a write may have been lost when it is simply recorded elsewhere. Left out,
   * the call renders as what it is — a tool call with its own result — and the round it
   * opened appears in the planner chat beside this one, under its own separator.
   */
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
  /**
   * The importer's writes name what they cover: the apex, host or block an entry is about,
   * and the host URL an asset is. `read_scope` takes no arguments, so it has no summary and
   * its row is just the call and its result.
   */
  add_scope_entry: "value",
  record_imported_asset: "url",
};

/** The four the planner may record, for turning a disposition into the panel's words. */
const DISPOSITIONS: ReadonlySet<string> = new Set([
  "actionable",
  "waiting",
  "no_useful_next_action",
  "objective_met",
]);

/**
 * A tool call as one line of a transcript: `add_scope_entry(effect="in", value="acme.com")`.
 *
 * What the narrated layout prints in place of a ledger row's "Arguments" disclosure, so a
 * call reads in the stream the way the agent would say it. **It rearranges what the call
 * carried and adds nothing**: the arguments are the call's own JSON, a `null` argument is
 * left out as the absence it is, and the verbatim text is still one disclosure away on the
 * row. Arguments are capped by the server with a marker appended, so a large call arrives as
 * invalid JSON; that prints as `name(…)` and never as a guess at the missing half.
 */
export const callSignature = (
  call: Pick<LiveItem, "toolName" | "tool" | "headline" | "input">,
): string => {
  const name = call.toolName ?? call.tool ?? call.headline;
  if (call.input === null) return `${name}()`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.input);
  } catch {
    return `${name}(…)`;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return `${name}(${call.input})`;
  }
  const args = Object.entries(parsed as Record<string, unknown>)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  return `${name}(${args.join(", ")})`;
};

/** How much of a result's own text a transcript line shows before it says "…". */
const RESULT_LINE_MAX = 160;

/**
 * The one line that answers a call, or `null` when nothing has.
 *
 * **The server's sentence when it wrote one.** A `tool.result` carries a `body`, "a sentence
 * for the operator", precisely so a browser does not have to word what a payload means; that
 * is used whenever it is there. Without one the result's own output is shown as itself —
 * minified if it is JSON, cut at {@link RESULT_LINE_MAX} with a mark that it was cut. The
 * rest is in the row's disclosure; nothing is summarised in between.
 */
export const resultLine = (result: LiveItem | null): string | null => {
  if (result === null) return null;
  const failed = result.outcome === "failed" ? "failed: " : "";
  if (result.body !== "") return `${failed}${result.body}`;
  if (result.output === null) return null;
  const raw = result.output;
  const text = ((): string => {
    try {
      return JSON.stringify(JSON.parse(raw));
    } catch {
      return raw.split("\n")[0] ?? "";
    }
  })();
  return `${failed}${
    text.length > RESULT_LINE_MAX ? `${text.slice(0, RESULT_LINE_MAX)}…` : text
  }`;
};

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
  /**
   * How a block still being written stands ({@link StreamState}), on a partial reply or
   * thought (A6 U5). Absent on a finished block and on every other row.
   */
  readonly stream?: StreamState;
}

/* ── Partial blocks (A6 U5) ─────────────────────────────────────────────────── */

/**
 * The most characters a **partial** carries: the server's field cap, which the contracts
 * carry since A6 U8 review 5 (`narrationCaps.ts`). A partial is cut there with no mark (A6
 * U5 review 2), so one this long has stopped growing on screen while the agent goes on
 * writing; a finished reply is cut only at `REPLY_FIELD_MAX` (`live.ts`, "Partial
 * items").
 */
export const PARTIAL_BODY_MAX = NARRATION_FIELD_MAX;

/** Whether a partial has reached {@link PARTIAL_BODY_MAX}, so nothing more of it is drawn. */
export const pastPartialCap = (item: LiveItem): boolean =>
  item.body.length >= PARTIAL_BODY_MAX;

/**
 * Where a partial block stands, which is what its row says about it:
 *
 * - `writing` — still being written: "writing…" on a reply, a shimmer on a thought.
 * - `shortened` — past the server's 4,000-character cap for a partial, so nothing more of
 *   it is drawn until it ends ({@link pastPartialCap}); said, rather than shown as
 *   writing over text that has stopped moving (seen frozen ~30 s on a GLM thought). A reply
 *   says it is still being written and the rest shows when it finishes — its finished copy
 *   carries up to 32,000 — and a thought that it is shortened, which its finished copy is
 *   too.
 * - `done` — a thought the agent has moved on from but the harness has not closed: GLM on
 *   OpenCode ends a reasoning block only at its step's end (`session.reasoning.ended`), so
 *   its thought would read as writing for the whole reply that follows it.
 */
export type StreamState = "writing" | "shortened" | "done";

/** What a reply being written past the partial cap says (A6 U5 review). */
export const REPLY_PAST_CAP_LABEL =
  "writing… — the rest shows when it finishes";

/** Whether an item is a partial: a block still being written (`LiveItem.streaming`). */
export const isPartial = (item: LiveItem): boolean => item.streaming === true;

/**
 * Whether two items are the same model call's blocks: both name one, and it is the same
 * (`LiveItem.blockCall`, A6 U5 review). Compared, never parsed — the server names the call
 * — and an item that names none is a call of its own, which makes every rule below that
 * needs "the same call" do nothing for it.
 */
const sameCall = (a: LiveItem, b: LiveItem): boolean =>
  a.blockCall !== undefined && a.blockCall === b.blockCall;

/**
 * Whether two items were narrated about one subject — the same attempt, round, goal or
 * import — which is the one harness conversation the server narrates under it. What keeps a
 * goal agent's model call from ending an importer's partials on the same target's feed.
 */
const sameSubject = (a: LiveItem, b: LiveItem): boolean =>
  a.attemptId === b.attemptId &&
  a.roundId === b.roundId &&
  a.goalId === b.goalId &&
  a.importId === b.importId;

/**
 * How each partial in `items` stands, by item id. Only partials are in it.
 *
 * A thought is `done` once a reply of the **same model call** has started — partial or
 * finished — because a model writes one block at a time, so the thought it left is not
 * being written any more whatever the harness says. A block past the cap is `shortened`
 * whichever it is.
 */
export const streamStates = (
  items: readonly LiveItem[],
): ReadonlyMap<string, StreamState> => {
  const states = new Map<string, StreamState>();
  if (!items.some(isPartial)) return states;
  const replied = new Set<string>();
  for (const item of items) {
    if (item.kind === REPLY_KIND && item.blockCall !== undefined) {
      replied.add(item.blockCall);
    }
  }
  for (const item of items) {
    if (!isPartial(item)) continue;
    states.set(
      item.id,
      pastPartialCap(item)
        ? "shortened"
        : item.kind === THINKING_KIND &&
            item.blockCall !== undefined &&
            replied.has(item.blockCall)
          ? "done"
          : "writing",
    );
  }
  return states;
};

/**
 * What the operator's view should hold once a frame arrives, for a frame that is a block
 * (A6 U5), or `undefined` for one this does not apply to — everything else, appended as
 * before. The rules of `live.ts` ("Partial items"), with the client's own three on top:
 *
 * - A partial **replaces** the partial for its `blockId` where that one is, keeping its
 *   `id` — so the row's key and its place among the operator's messages (which is read
 *   from the id's publish order) are where the block began, not where it has got to — or
 *   is added at the end. A partial for a block whose finished copy is already here is
 *   dropped: that block is done.
 * - A finished block **replaces** its partial where it is, under its own id.
 * - **A finished thought with no partial here goes before its call's reply** (A6 U5
 *   review). Its partials can be gone — a reload or a reconnect drops every partial, and
 *   GLM's thought, closed only at its step's end, sends none after it — while the reply of
 *   the same call streamed in after the reconnect; added at the end, the thought would sit
 *   under the reply it led to, and under the turn's footer. A model thinks before it writes
 *   in one call, so the call's first reply on screen is where it goes. Only a thought is
 *   moved: a reply's earlier blocks of the same call are written before it, so a reply
 *   with no partial here is still added at the end.
 * - **A newer model call ends an older one's partials.** A block of a call, partial or
 *   finished, drops every partial of another call narrated about the same subject: a model
 *   writes one call at a time, so those were left unfinished — a retried API call's first
 *   attempt, which the server's turn-end flush leaves behind (A6 F8 review). Dropped here
 *   for every reader of the feed, the goal chat and the Live panel included, which have no
 *   turn end to drop them at. A block that names no call ({@link sameCall}) ends nothing.
 *
 * `items` itself, unchanged, when the frame changes nothing.
 */
export const withBlock = (
  items: readonly LiveItem[],
  frame: LiveItem,
): readonly LiveItem[] | undefined => {
  const blockId = frame.blockId;
  if (blockId === undefined) return undefined;
  if (frame.kind !== REPLY_KIND && frame.kind !== THINKING_KIND) {
    return undefined;
  }
  const stale = (item: LiveItem): boolean =>
    frame.blockCall !== undefined &&
    isPartial(item) &&
    item.blockId !== undefined &&
    item.blockId !== blockId &&
    item.blockCall !== undefined &&
    item.blockCall !== frame.blockCall &&
    sameSubject(item, frame);
  const at = items.findLastIndex((item) => item.blockId === blockId);
  const here = at === -1 ? undefined : items[at];
  // The block's finished copy is here: a partial for it is late, and changes nothing.
  if (isPartial(frame) && here !== undefined && !isPartial(here)) return items;
  const placed =
    here === undefined
      ? withNew(items, frame)
      : items.with(
          at,
          isPartial(frame) && isPartial(here)
            ? { ...frame, id: here.id }
            : frame,
        );
  return placed.some(stale) ? placed.filter((item) => !stale(item)) : placed;
};

/** A block not yet on screen: a finished thought before its call's reply, else at the end. */
const withNew = (
  items: readonly LiveItem[],
  frame: LiveItem,
): readonly LiveItem[] => {
  if (frame.kind !== THINKING_KIND || isPartial(frame))
    return [...items, frame];
  const reply = items.findIndex(
    (item) => item.kind === REPLY_KIND && sameCall(item, frame),
  );
  return reply === -1 ? [...items, frame] : items.toSpliced(reply, 0, frame);
};

/**
 * A row key per item, for one list: a reply's or a thought's `block:<blockId>`, anything
 * else its own id (A6 U5). Its partials and then its finished copy — each a frame of its
 * own id — are then one row to `{#each}`, redrawn in place rather than mounted afresh, so an
 * opened thought, a drawn figure and a highlighted fence are kept when the block finishes.
 * A key already given in this list (the same block replayed and live, say) falls back to
 * the item's own id, since two rows on one key would stop the list drawing at all. One
 * keyer per list, called on its items in order: the chat's turn and the Live panel's
 * ledger (A6 U5 review) both key this way.
 */
export const blockKeys = (): ((item: LiveItem) => string) => {
  const used = new Set<string>();
  return (item) => {
    const key =
      item.blockId !== undefined &&
      (item.kind === REPLY_KIND || item.kind === THINKING_KIND)
        ? `block:${item.blockId}`
        : item.id;
    const free = used.has(key) ? item.id : key;
    used.add(free);
    return free;
  };
};

/**
 * What a reconnected feed starts from (A6 U5): every partial dropped. Partials are never
 * replayed, and a finished block that ends one while the feed is down arrives after the
 * reconnect with no partial of this connection's to replace — so the old partial would stay
 * beside it as a second copy.
 */
export const withoutPartials = (items: readonly LiveItem[]): LiveItem[] =>
  items.some(isPartial) ? items.filter((item) => !isPartial(item)) : [...items];

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
  /**
   * The conversation's rows, oldest first: what the harness's replay holds, then what
   * arrived live after it — **one item type for both** (A6 F10), so a reloaded turn is drawn
   * by {@link ChatItem} exactly as a watched one was.
   */
  readonly rows: readonly ChatRow[];
}

/**
 * Where a turn's last piece of the agent's prose is drawn, or `null` when it has none.
 *
 * Prose means words, not a row kind — a reply with an empty body draws nothing. Replayed
 * and live rows are the same rows now (A6 F10), so there is one place to look.
 *
 * It is what {@link Chat} hangs a turn's footer on, as OpenCode does (`copyContentID`: the
 * finished turn's last non-empty text part), rather than on the group's last row: a turn
 * that says what it will write and then writes it is still captioned under its words.
 */
export type ProsePlace = { readonly _tag: "row"; readonly key: string };

export const lastProse = (
  group: Pick<ChatGroup<unknown>, "rows">,
): ProsePlace | null => {
  const row = group.rows.findLast(
    (each) => each.item.kind === REPLY_KIND && each.item.body.trim() !== "",
  );
  return row === undefined ? null : { _tag: "row", key: row.key };
};

/**
 * The model that answered in a turn, from the turn's own items: the last of the agent's
 * items that names one (`LiveItem.model`, A6 F10), or `undefined` when none does.
 *
 * What a turn's footer names, rather than the session's current model: after a switch every
 * earlier turn was still answered by the model it was answered by, and the transcript says
 * which. `undefined` is a turn whose harness did not say — a caller may fall back to the
 * session's model and should say less, not more.
 */
export const turnModel = (
  group: Pick<ChatGroup<unknown>, "rows">,
): string | undefined => {
  for (const row of [...group.rows].reverse()) {
    for (const item of [row.item, row.proposedBy]) {
      if (item?.model !== undefined) return item.model;
    }
  }
  return undefined;
};

/**
 * Every model that answered in a turn, oldest first, each once (A6 U4): the turn footer's
 * `claude-sonnet-4-5 → claude-haiku-4-5` after a switch mid-turn. Read from the agent's own
 * items (`LiveItem.model`), so a turn is named for the models that answered it rather than
 * the session's current one. Empty when the harness named none.
 */
export const turnModels = (
  group: Pick<ChatGroup<unknown>, "rows">,
): readonly string[] => {
  const models: string[] = [];
  for (const row of group.rows) {
    for (const item of [row.proposedBy, row.item]) {
      const model = item?.model;
      if (model !== undefined && !models.includes(model)) models.push(model);
    }
  }
  return models;
};

/**
 * The time of a turn's last item, in epoch milliseconds, or `undefined` for a turn with
 * none — or with an item whose end the harness did not keep (`LiveItem.endUnknown`): the
 * end of the span a turn footer's duration measures (A6 U4). A harness note other than an
 * error is not counted: it is not the agent's work, and counting a note that live never
 * narrates (OpenCode's `system` entry) made a replay longer. Every item it reads
 * is the server's or the harness's — a call, its result, the record a write produced — so
 * it is on the same clock as a start the server stamped.
 */
export const turnEndedAt = (
  group: Pick<ChatGroup<unknown>, "rows">,
): number | undefined => {
  let last: number | undefined;
  for (const row of group.rows) {
    for (const item of [row.proposedBy, row.item, row.result]) {
      if (item == null) continue;
      /*
       * A harness note is not the agent's work and does not end its turn (A6 U4 review):
       * OpenCode's `system` entry, written when the **next** turn starts and stored before
       * its message, is never narrated live, and counted it stretched a turn's replayed
       * length past what was watched. Claude Code's interrupt note is narrated live too
       * (A6 U6 review 3) but marks the Stop, not work, so it is skipped either way and live
       * and replay agree. A harness's error is counted.
       */
      if (item.kind === "turn.other" && item.outcome !== "failed") continue;
      // A replayed item whose harness kept only when its message began (A6 U4 review): the
      // turn's end is unknown, and no length is better than a wrong one.
      if (item.endUnknown === true) return undefined;
      if (last === undefined || item.at > last) last = item.at;
    }
  }
  return last;
};

/** A turn's length as a footer says it: `41s`, `2m 05s`, `1h 02m`. */
export const durationLabel = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${String(minutes)}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60).padStart(2, "0")}m`;
};

/**
 * What a run of tool calls folded into one line says about itself (A6 U4, D3): how many
 * calls, which tools, and what among them needs the operator — the rest is one click away.
 */
export interface ToolRunSummary {
  /** Calls in the run, each once: a write folded into its record is one call. */
  readonly count: number;
  /** The distinct tool names, in the order first called, our MCP prefix already off. */
  readonly names: readonly string[];
  /** Writes the harness reported failed: nothing was written. */
  readonly refused: number;
  /** Writes that ended with neither a record nor a stated failure. Must stay visible. */
  readonly unresolved: number;
  /** Calls that are not writes whose result the harness reported failed. */
  readonly failed: number;
  /** A write still in flight: the line says "writing…", as D3 draws it. */
  readonly pending: boolean;
}

/**
 * One line of a thread (A6 U4): a row drawn as itself, or consecutive tool calls folded into
 * one muted line — D3's ">_ Ran 3 commands · write_scope_entry" — with their rows, drawn as
 * they always were, one click away.
 */
export type ThreadEntry =
  | { readonly _tag: "row"; readonly key: string; readonly row: ChatRow }
  | {
      readonly _tag: "tools";
      /** The first row's key, so a run that grows keeps its place and its open state. */
      readonly key: string;
      readonly rows: readonly ChatRow[];
      readonly summary: ToolRunSummary;
    };

/**
 * Whether a row is a tool call: a call, a write folded into the record it produced, or a
 * result whose call is not here. A record no call claims is not — it is something that was
 * committed, not something the agent ran — and stays a row of its own, as does a
 * sub-agent, a refused action and a harness note.
 */
const isToolRow = (row: ChatRow): boolean =>
  row.proposedBy !== null ||
  row.item.kind === "tool.call" ||
  row.item.kind === "tool.result";

/** The name a tool row's line gives it: the call's reduced name, as its signature does. */
const toolRowName = (row: ChatRow): string => {
  const call = row.proposedBy ?? row.item;
  return call.toolName ?? call.tool ?? call.headline;
};

/** What a run of tool rows says when folded: see {@link ToolRunSummary}. */
export const toolRunSummary = (rows: readonly ChatRow[]): ToolRunSummary => {
  const names: string[] = [];
  let refused = 0;
  let unresolved = 0;
  let failed = 0;
  for (const row of rows) {
    const name = toolRowName(row);
    if (!names.includes(name)) names.push(name);
    if (row.write === "refused") refused += 1;
    else if (row.write === "unresolved") unresolved += 1;
    else if (
      row.write === null &&
      (row.result ?? (row.item.kind === "tool.result" ? row.item : null))
        ?.outcome === "failed"
    ) {
      failed += 1;
    }
  }
  return {
    count: rows.length,
    names,
    refused,
    unresolved,
    failed,
    pending: rows.some((row) => row.write === "pending"),
  };
};

/** "Ran 1 command", "Ran 3 commands": the folded line's count, as D3 words it. */
export const toolRunCount = (count: number): string =>
  `Ran ${String(count)} ${count === 1 ? "command" : "commands"}`;

/**
 * What the folded line says needs attention, each as a short phrase: refused and failed
 * calls and unresolved writes. Recorded writes and ordinary results are the expected
 * outcome and are said only once the run is opened.
 */
export const toolRunAttention = (summary: ToolRunSummary): readonly string[] =>
  [
    summary.refused > 0 ? `${String(summary.refused)} refused` : "",
    summary.unresolved > 0 ? `${String(summary.unresolved)} unresolved` : "",
    summary.failed > 0 ? `${String(summary.failed)} failed` : "",
  ].filter((part) => part !== "");

/**
 * A group's rows as a thread draws them: each run of consecutive tool rows folded into one
 * entry, everything else as itself. A single call is a run too ("Ran 1 command").
 */
export const threadEntries = (
  rows: readonly ChatRow[],
): readonly ThreadEntry[] => {
  const entries: ThreadEntry[] = [];
  let run: ChatRow[] = [];
  const close = (): void => {
    const first = run[0];
    if (first !== undefined) {
      entries.push({
        _tag: "tools",
        key: `tools:${first.key}`,
        rows: run,
        summary: toolRunSummary(run),
      });
    }
    run = [];
  };
  for (const row of rows) {
    if (isToolRow(row)) {
      run.push(row);
      continue;
    }
    close();
    entries.push({ _tag: "row", key: row.key, row });
  }
  close();
  return entries;
};

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
 * The id a write call's record is known by, read off the call itself, or `undefined`.
 *
 * The other half of `LiveItem.writeId` (A6 F10 review): `add_scope_entry`'s **result** names
 * the entry it wrote or found (`entry_id`), and a `record_imported_asset` call is **sent**
 * with the `operation_id` its record carries. So an asset call is keyed from the moment it
 * is made and an entry call from the moment its result arrives. The planner's and goal
 * agent's writes have no such id — nothing joins an `add_intent` call to its intent — and
 * pair by order alone, as they always have.
 *
 * Read from capped JSON, so a field cut off by the server's cap reads as no id, and the
 * call falls back to order where order is allowed — never to another call's record.
 */
const callWriteId = (
  call: LiveItem,
  result: LiveItem | undefined,
): string | undefined => {
  switch (call.toolName) {
    case "add_scope_entry":
      return stringField(result?.output ?? null, "entry_id");
    case "record_imported_asset":
      return stringField(call.input, "operation_id");
    default:
      return undefined;
  }
};

/**
 * What a write call's result says its record will say — `new` or `known`, in the record's
 * own `outcome` words — or `undefined` where it does not say.
 *
 * Only `add_scope_entry` needs it: its id is the **entry's**, so adding an entry that is
 * already there writes a second record under the same id, `created: false`
 * (`scope.entry.added`'s `known`). An asset's id is the operation's, one record each. Read
 * from capped JSON like {@link callWriteId}, so a cut field reads as "does not say" and the
 * call takes any record under its id, as it did before; so does a record with no `outcome`.
 */
const callWriteOutcome = (
  call: LiveItem,
  result: LiveItem | undefined,
): "new" | "known" | undefined => {
  if (
    call.toolName !== "add_scope_entry" ||
    result === undefined ||
    result.output === null
  ) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(result.output);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const created = (parsed as Record<string, unknown>)["created"];
    return created === true ? "new" : created === false ? "known" : undefined;
  } catch {
    return undefined;
  }
};

/** A top-level string field of a JSON object's text, or `undefined` for anything else. */
const stringField = (json: string | null, key: string): string | undefined => {
  if (json === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const value = (parsed as Record<string, unknown>)[key];
    return typeof value === "string" && value !== "" ? value : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Pairs write calls to the records they produced: by content where both sides carry the
 * write's id, and by order otherwise — but only among items at or after `orderFrom`.
 *
 * **By id first.** A call whose id is known ({@link callWriteId}) takes the record carrying
 * the same `writeId`, and only that one: if that record is not in `items`, the call is
 * unpaired, which is the honest rendering of "its record is not on this page". It never
 * takes the next record in line, which would be another call's. An entry added twice has
 * two records under one id — `created`, then `found` — so a call whose result says which
 * it was ({@link callWriteOutcome}) takes only a record that says the same: with the
 * oldest call cut from a replay, the next one would otherwise take the `created` receipt
 * and leave its own to drop into an earlier group.
 *
 * **By order for the rest**, as this function always paired: a round's writes are committed
 * in the order it made them, so the i-th unpaired `add_intent` call belongs with the i-th
 * unclaimed `intent.added`. A keyed call that found no match may still take a record that
 * carries no id at all (a frame from a build without `writeId`); it never takes one carrying
 * a different id. An unkeyed call — an entry write whose result has not arrived yet — may
 * take any unclaimed record of its kind, which is the ordinary in-flight case.
 *
 * Order is only sound over a stretch where neither side has been cut, which is what
 * `orderFrom` is for: `importerChat.ts` pairs a whole session at once, from a replay that
 * keeps the newest items and a record feed that opens part way back, cut independently. In
 * a long session the i-th call left on screen is then not the i-th record's writer, and
 * pairing them by position would put one write's receipt on another's call. Calls and
 * records before `orderFrom` pair by id or not at all.
 *
 * The matching is deliberately **not** conditioned on the record arriving after the call.
 * It generally does, and the exceptions are real: the record channel is ordered and the
 * activity channel is not, so a narration entry can land after the record it describes, and
 * a reconnect replays records with no activity at all. Requiring the order would turn one
 * late narration entry into a row claiming an intent was never recorded.
 */
const pairWrites = (
  items: readonly LiveItem[],
  results: ReadonlyMap<string, LiveItem>,
  orderFrom = 0,
): ReadonlyMap<string, LiveItem> => {
  /** Records by kind and write id, oldest first: an entry found twice has two records. */
  const byId = new Map<string, LiveItem[]>();
  /** Every record of each kind that order may hand out, oldest first. */
  const inOrder = new Map<string, LiveItem[]>();
  const keyOf = (kind: string, id: string) => `${kind}\u0000${id}`;
  items.forEach((item, position) => {
    if (item.origin !== "record") return;
    if (item.writeId !== undefined) {
      const key = keyOf(item.kind, item.writeId);
      const queue = byId.get(key);
      if (queue === undefined) byId.set(key, [item]);
      else queue.push(item);
    }
    if (position < orderFrom) return;
    const queue = inOrder.get(item.kind);
    if (queue === undefined) inOrder.set(item.kind, [item]);
    else queue.push(item);
  });
  const taken = new Set<string>();
  const paired = new Map<string, LiveItem>();
  /** Calls left for the order pass, with the id each was looking for. */
  const leftover: { call: LiveItem; kind: string; id: string | undefined }[] =
    [];
  items.forEach((item, position) => {
    if (item.kind !== "tool.call" || item.toolName === null) return;
    const wanted = WRITE_TOOLS[item.toolName];
    if (wanted === undefined) return;
    /*
     * A call whose result says it wrote nothing takes no record.
     *
     * Under order pairing, a call that claims a record it did not write hands every later
     * call the record of the one before it. Two results say so definitively: a **failed**
     * one (a refused write rolled back — the store commits a record in the same transaction
     * as the write or not at all), and a **replayed** one (an exact retry, answered from its
     * receipt). A call whose result has not arrived yet still claims the next record: that
     * is the ordinary in-flight case, and the result arriving re-derives this.
     */
    const result = item.callId === null ? undefined : results.get(item.callId);
    if (result !== undefined && wroteNothing(result)) return;
    const id = callWriteId(item, result);
    if (id !== undefined) {
      const outcome = callWriteOutcome(item, result);
      const record = byId.get(keyOf(wanted, id))?.find(
        (each) =>
          !taken.has(each.id) &&
          // A record that does not say either way is not ruled out by it.
          (outcome === undefined ||
            each.outcome === null ||
            each.outcome === outcome),
      );
      if (record !== undefined) {
        paired.set(item.id, record);
        taken.add(record.id);
        return;
      }
    }
    if (position >= orderFrom) leftover.push({ call: item, kind: wanted, id });
  });
  for (const { call, kind, id } of leftover) {
    const record = inOrder
      .get(kind)
      ?.find(
        (each) =>
          !taken.has(each.id) &&
          (id === undefined || each.writeId === undefined),
      );
    if (record === undefined) continue;
    paired.set(call.id, record);
    taken.add(record.id);
  }
  return paired;
};

/**
 * Which record each write call in `items` produced, by the call's item id — the pairing
 * {@link rowsFor} folds by, over a whole list. Exported for `importerChat.ts`, which pairs
 * across a whole session before cutting it into turns (A6 F10), and hands the result back
 * to {@link rowsFor} for each turn so a turn never re-pairs by order what the session
 * pairing deliberately left apart. `orderFrom` is {@link pairWrites}'.
 */
export const claimedRecords = (
  items: readonly LiveItem[],
  orderFrom = 0,
): ReadonlyMap<string, LiveItem> => {
  const results = new Map<string, LiveItem>();
  for (const item of items) {
    if (item.kind === "tool.result" && item.callId !== null) {
      results.set(item.callId, item);
    }
  }
  return pairWrites(items, results, orderFrom);
};

/**
 * Whether a write's result says no record was produced: refused, or an exact replay.
 *
 * `replayed` is read from the result's own JSON, and only a literal `true` counts. A result
 * cut at the server's field cap is invalid JSON and reads as "wrote something", which is the
 * reading every result had before this existed — so a parse failure can leave a pairing
 * where it was, never move one.
 */
const wroteNothing = (result: LiveItem): boolean =>
  result.outcome === "failed" || replayed(result);

/**
 * Whether a result is an exact retry answered from its receipt (`replayed: true`).
 *
 * Such a call is rendered as a plain call with its answer rather than as a write: it is not
 * `unresolved` — the store said plainly that it wrote nothing — and not `refused` either.
 */
const replayed = (result: LiveItem): boolean => {
  if (result.output === null) return false;
  try {
    const parsed: unknown = JSON.parse(result.output);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as Record<string, unknown>)["replayed"] === true
    );
  } catch {
    return false;
  }
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
 *
 * Exported for `importerChat.ts`, which cuts a conversation into groups by a rule of its
 * own and then needs exactly this per group. `roundRunning` is whether anything more can
 * still arrive *in this group*, which is what separates a `pending` write from an
 * `unresolved` one. `pairing` is a pairing made over more than this group
 * ({@link claimedRecords}); without one, the group is paired on its own.
 */
export const rowsFor = (
  group: readonly LiveItem[],
  roundRunning: boolean,
  pairing?: ReadonlyMap<string, LiveItem>,
): readonly ChatRow[] => {
  // A sub-agent's states, as the one entry it is drawn as (A6 U14).
  const items = foldSubagents(group);
  /** Results by the call they answer. A result with no `callId` cannot be paired at all. */
  const results = new Map<string, LiveItem>();
  for (const item of items) {
    if (item.kind === "tool.result" && item.callId !== null) {
      results.set(item.callId, item);
    }
  }
  const paired = pairing ?? pairWrites(items, results);
  /**
   * Records claimed by a call **in this group**, so they are not also rendered alone. A
   * record whose call is elsewhere stays a row of its own rather than vanishing.
   */
  const here = new Set(items.map((item) => item.id));
  const claimed = new Set(
    [...paired.entries()]
      .filter(([callId]) => here.has(callId))
      .map(([, record]) => record.id),
  );
  const rows: ChatRow[] = [];
  const states = streamStates(items);
  // A block's row is keyed by its `blockId` (A6 U5): see `blockKeys`.
  const keyOf = blockKeys();
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
        item.toolName !== null &&
        WRITE_TOOLS[item.toolName] !== undefined &&
        !(result !== null && replayed(result));
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
    const stream = states.get(item.id);
    rows.push({
      key: keyOf(item),
      item,
      proposedBy: null,
      result: null,
      write: null,
      summary: null,
      ...(stream === undefined ? {} : { stream }),
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
  if (replayed !== undefined && replayed.items.length > 0) {
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
    // A take (A6 U4) only tells the importer's chat a queued message was read; not a row.
    // Nor is a carry (U6 review 2).
    const mine = input.items.filter(
      (item) => item.roundId === round.roundId && drawnAsRow(item),
    );
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
      // The replay's items first, then the live tail: one list, so a write call the replay
      // holds pairs with the record the live feed brought (`rowsFor`).
      rows: rowsFor(
        [
          ...(prose._tag === "replayed" ? (replayed?.items ?? []) : []),
          ...live,
        ],
        round.status === "running",
      ),
    };
  });
  return { groups, older: input.rounds.length - shown.length };
};

/* ── The goal conversation ───────────────────────────────────────────────────── */

/**
 * One message this tab has sent to a goal's agent and has not been told to forget.
 *
 * **Local, and the reason it has to be local is ruling 4.** Operator messages are not
 * stored anywhere: not in the graph, not on the narration bus, and the harness's own copy
 * is only readable on a *later* page load. So between typing and reloading, the only place
 * what you said exists is here — and a chat that showed the agent's half of a conversation
 * and not yours would read as though the agent were talking to itself.
 *
 * `after` is the activity publish order at the moment the message was sent, which is the
 * same join {@link buildChat}'s `narrationFloor` uses and not a second mechanism: it is
 * what lets {@link buildGoalConversation} place a turn before the narration that answered
 * it without comparing two clocks that are not the same clock.
 */
export interface SentTurn {
  /** This tab's own order, from one. A render key and a tiebreak, nothing else. */
  readonly index: number;
  readonly text: string;
  /** Epoch milliseconds, from this tab. Shown, never used for ordering. */
  readonly at: number;
  /** The activity high-water mark when it was sent. See above. */
  readonly after: number;
  /**
   * The files it carried, as the server stored them (A6 U13): the accepted answer's, so the
   * turn shows each with its path before any replay could.
   */
  readonly attachments?: readonly MessageAttachmentView[];
}

/**
 * The kind of an operator's message: the one {@link operatorTurn} mints, and the one a
 * conversation's replay carries for a `user` entry (A6 F10).
 */
export const OPERATOR_TURN_KIND = "turn.operator";

/**
 * The kind a harness's "took a queued message" item carries (`live.ts`, A6 U4). Never drawn
 * as a row by any chat: the importer's reads it to stop drawing a message as queued, and the
 * goal and planner panels drop it.
 */
export const TAKEN_KIND = "turn.taken";

/**
 * The kind the harness's "this message went on with the next one" item carries (`live.ts`,
 * A6 U6 review 2): a turn ended before it wrote anything, and the next message's turn reads
 * both. Never drawn as a row by any chat: the importer's draws its turn as gone on with the
 * next message, and the goal and planner panels drop it.
 */
export const CARRIED_KIND = "turn.carried";

/**
 * Whether an item is one a chat draws as a row at all: not a take ({@link TAKEN_KIND}) nor a
 * carry ({@link CARRIED_KIND}), which only say something about the operator's messages.
 */
export const drawnAsRow = (item: LiveItem): boolean =>
  item.kind !== TAKEN_KIND && item.kind !== CARRIED_KIND;

/**
 * One operator message as a chat row.
 *
 * **Minted in the browser, which is a thing this file does exactly once and says so.**
 * `LiveItem.kind` is a plain string on the wire precisely so a reader tolerates a kind it
 * has never seen, and this is the other side of that: a row the *server* has never seen.
 * It is marked `activity` rather than `record` because that is the truth — it is not part
 * of the record, it is not stored, and it is gone on a reload (it comes back from the
 * harness's own copy, as a `user` entry in the replay).
 *
 * `id` is namespaced away from both id spaces the server uses (`record:` and `activity:`)
 * so nothing can collide with it and {@link activityOrder} cannot read an order out of it.
 */
export const operatorTurn = (turn: SentTurn): LiveItem => ({
  _tag: "item",
  id: `operator:${String(turn.index)}`,
  origin: "activity",
  sequence: null,
  kind: OPERATOR_TURN_KIND,
  at: turn.at,
  attemptId: null,
  roundId: null,
  goalId: null,
  importId: null,
  headline: "You",
  body: turn.text,
  tool: null,
  toolName: null,
  input: null,
  output: null,
  callId: null,
  outcome: null,
  ...(turn.attachments === undefined || turn.attachments.length === 0
    ? {}
    : { attachments: turn.attachments }),
});

/** What a goal conversation's separator needs, and the whole of what the chat is given. */
export interface GoalSubject {
  /**
   * The replay the server answered with, or `undefined` while it has not answered.
   *
   * The separator reads the session id and `live` off it: after a restart the words can be
   * here and the conversation still not be continuable, which is the one thing a reader
   * has to be told rather than left to infer from an empty composer.
   */
  readonly conversation: GoalConversationView | undefined;
  /** True between a message being sent and anything arriving in answer to it. */
  readonly awaiting: boolean;
}

/** One goal conversation as a chat group. */
export type GoalConversationGroup = ChatGroup<GoalSubject>;

/** The goal conversation, as the chat renders it. */
export interface GoalChatView {
  /**
   * One group, or none at all.
   *
   * **None is the "nobody has said anything" state**, and leaving the group out is how it
   * is rendered: {@link Chat} shows its `empty` sentence when there are no groups, which is
   * the right shape for "there is no conversation" — as against the three ways a
   * conversation that exists can have no prose, which are {@link RoundProse}'s and are
   * shown inside the group.
   */
  readonly groups: readonly GoalConversationGroup[];
}

/**
 * What to say about a goal conversation's prose, from the server's five answers.
 *
 * `absent` has no case here and cannot reach this function: {@link buildGoalConversation}
 * renders no group at all for it. Everything else maps onto the same five states a round's
 * prose has, because they are the same five facts about the same kind of absence.
 */
const goalProseFor = (
  conversation: GoalConversationView | undefined,
  hasLive: boolean,
): RoundProse => {
  if (conversation === undefined) {
    return hasLive ? { _tag: "live" } : { _tag: "loading" };
  }
  if (conversation.items.length > 0) {
    return {
      _tag: "replayed",
      note: conversation.note,
      ephemeral: conversation.ephemeral,
      truncated: conversation.truncated,
    };
  }
  if (hasLive) return { _tag: "live" };
  switch (conversation.source) {
    case "harness":
      // The harness answered and held only tool calls and results, which the reduced shape
      // carries no text for. Its own note says so; this is not the absence of a session.
      return { _tag: "none", note: conversation.note };
    case "pending":
      return { _tag: "pending", note: conversation.note };
    case "forgotten":
      return { _tag: "forgotten", note: conversation.note };
    case "none":
    case "absent":
      return { _tag: "none", note: conversation.note };
  }
};

/** What the goal conversation is assembled from. */
export interface GoalChatInput {
  readonly goalId: string;
  /** The target's live feed, in arrival order. Filtered to this goal here. */
  readonly items: readonly LiveItem[];
  readonly conversation: GoalConversationView | undefined;
  /** The activity publish order when the replay answered. See {@link buildChat}. */
  readonly narrationFloor: number | undefined;
  /** What this tab has sent, oldest first. */
  readonly sent: readonly SentTurn[];
  /**
   * How many of {@link sent} had been sent when the replay was **asked for**. Zero when no
   * replay has been asked for at all.
   *
   * The bound on which local turns the replay may cancel, and it is a count rather than a
   * timestamp on purpose: the turn's `at` comes from this tab's clock and the replay's from
   * the server's, and a cancellation that depended on which was ahead would lose a message
   * for no visible reason. A turn numbered above this was sent after the request left, so no
   * answer to that request can contain it.
   */
  readonly replayedThrough: number;
  readonly awaiting: boolean;
  /**
   * Whether anything more can still arrive in this conversation.
   *
   * **What `roundRunning` is to a planner round, and it used to be a hardcoded `true`.**
   * {@link WriteState} is the reason it has to be real: a write with no record is `pending`
   * while something may still arrive and `unresolved` once nothing can, and an ended goal's
   * conversation is in the second state. Hardcoded `true`, a steer whose record this tab
   * dropped read as `pending` for as long as the page stayed open — a chat waiting forever
   * on a write that will never resolve, which is the one thing `unresolved` exists to say.
   *
   * The caller owns it because the fact is the **goal's status**, which is a row this module
   * is not given: `app.svelte.ts` passes `openGoalView?.status === "active"`, and `true`
   * while the goal row has not loaded — a brief `pending` is honest about an unknown, where
   * `unresolved` would claim a finality nobody has established.
   */
  readonly conversationLive: boolean;
}

/**
 * Builds a goal's conversation from the live feed, the replay and what this tab has sent.
 *
 * ## One group, and why there is no second grouping to make
 *
 * A planner chat groups by round because a round is a durable record with a status and a
 * disposition — the structure survives a reload even when the prose does not (decision 16).
 * A conversation has **no such boundary**: a turn is not a row, nothing records where one
 * ended, and inventing a separator per turn would be claiming a structure the records
 * cannot corroborate. So the conversation is one stretch under one heading, which is also
 * what it is.
 *
 * ## Where an operator's own message goes
 *
 * Each {@link SentTurn} is placed **before the first live narration that arrived after it**,
 * using the activity publish order it was sent at. That is the same join the replay uses
 * and deliberately not a timestamp comparison: the browser's clock and the server's are not
 * the same clock, and a conversation whose order depended on which was ahead would reorder
 * itself for no visible reason. Record items carry no activity order and keep their arrival
 * position, which is the store's own order.
 */
export const buildGoalConversation = (input: GoalChatInput): GoalChatView => {
  // A take (A6 U4) only tells the importer's chat a queued message was read; it is not a row.
  // Nor is a carry (U6 review 2), live or replayed.
  // V2(chat): the goal chat drops a carry rather than drawing its turn as answered with the
  // next message, as the importer's does; a goal has no Send now yet, so only a replay of
  // two stored messages in a row can carry one here.
  const mine = input.items.filter(
    (item) => item.goalId === input.goalId && drawnAsRow(item),
  );
  const live = mine.filter((item) => {
    const order = activityOrder(item);
    if (order === undefined) return true;
    return input.narrationFloor === undefined || order > input.narrationFloor;
  });
  const hasLive = live.some((item) => item.origin === "activity");
  const replayed = (input.conversation?.items ?? []).filter(drawnAsRow);

  if (
    live.length === 0 &&
    replayed.length === 0 &&
    input.sent.length === 0 &&
    (input.conversation === undefined || input.conversation.source === "absent")
  ) {
    // Nothing at all: no conversation, nothing sent, nothing replayed. The chat says so in
    // its own words rather than showing an empty group with a heading.
    return { groups: [] };
  }

  /**
   * What this tab has sent, minus anything the replay has already brought back.
   *
   * **Only turns the replay could possibly contain are candidates, and that bound is the
   * whole correctness of this.** The operator's first message reaches the replay as a `user`
   * entry — the harness stores it, and `goalNarration.ts` trims this server's framing off
   * it — so without some cancellation the same sentence appears twice on one screen.
   *
   * Matching on the text alone was the first attempt and it was **wrong in the one
   * direction that loses data**. The replay is read on open and re-read only after a send
   * that *opens* a conversation, so it is usually stale; an operator who re-sent a sentence
   * already in the history — "ok", "continue", "yes" — had the new turn cancelled against
   * the old entry and saw it **nowhere at all** until a reload. A review measured it: a
   * replay of `[user "ok", assistant "done"]` plus a newly sent "ok" rendered zero operator
   * rows. A chat that silently swallows what was just typed is worse than one that shows it
   * twice, because the operator cannot tell whether it was sent.
   *
   * {@link GoalChatInput.replayedThrough} is the fix and it is a count, not a clock: how
   * many of this tab's turns had been sent at the moment the replay was **asked for**. A
   * turn numbered above it cannot be in that answer, whatever it says, so it is never a
   * candidate. Within the bound the match is still text, one-for-one and counted rather
   * than filtered, so two "ok"s with one of them replayed still show one local row.
   *
   * Nothing is dropped on the strength of a replay that does not contain it: a turn the
   * replay was asked for but had not caught up with stays on screen until a later read
   * brings it back, and then it is cancelled.
   */
  const replayedUser = new Map<string, number>();
  for (const item of replayed) {
    if (item.kind !== OPERATOR_TURN_KIND) continue;
    replayedUser.set(item.body, (replayedUser.get(item.body) ?? 0) + 1);
  }
  const unreplayed = input.sent.filter((turn) => {
    if (turn.index > input.replayedThrough) return true;
    const left = replayedUser.get(turn.text) ?? 0;
    if (left === 0) return true;
    replayedUser.set(turn.text, left - 1);
    return false;
  });
  const pending = [...unreplayed].sort(
    (left, right) => left.after - right.after || left.index - right.index,
  );
  const ordered: LiveItem[] = [];
  for (const item of live) {
    const order = activityOrder(item);
    if (order !== undefined) {
      while (pending.length > 0 && (pending[0]?.after ?? 0) < order) {
        const turn = pending.shift();
        if (turn !== undefined) ordered.push(operatorTurn(turn));
      }
    }
    ordered.push(item);
  }
  for (const turn of pending) ordered.push(operatorTurn(turn));

  const prose = goalProseFor(input.conversation, hasLive);
  return {
    groups: [
      {
        // The session id would change under the operator on a restart and take the whole
        // group's identity with it; the goal does not.
        key: input.goalId,
        subject: {
          conversation: input.conversation,
          awaiting: input.awaiting,
        },
        prose,
        /*
         * The writes on this surface are a steer and an ending, and they pair with the
         * records {@link WRITE_TOOLS} names — `plan.round.steered` and `goal.ended`, both
         * written under the agent's own caller scope and so both on this feed. A wake does
         * not pair, deliberately; the table says why.
         *
         * `conversationLive` rather than the `true` this argument used to be: a conversation
         * is not a round, but it does end, and after it has nothing a chat is waiting for
         * can arrive. See {@link GoalChatInput.conversationLive}.
         */
        /*
         * Partials (A6 U5) are drawn as the importer's are — replaced by `blockId` in the
         * feed, one row per block, "writing…" on a block being written.
         *
         * V2(chat): this page has no turn end for the goal agent, so a partial left by a
         * model call that is never followed by another — a cut block with no finished copy —
         * stays "writing…" until the next call's first block, or a reconnect, drops it. The
         * importer drops one when its session goes idle. Proper V2: the server narrates the
         * goal conversation's turn end, and this drops the turn's unfinished partials there.
         */
        rows: rowsFor(
          [...(prose._tag === "replayed" ? replayed : []), ...ordered],
          input.conversationLive,
        ),
      },
    ],
  };
};

/* ── The context meter ───────────────────────────────────────────────────────── */

/**
 * Which session a {@link LiveUsage} frame measures, as one map key.
 *
 * The frame carries the same four nullable ids a {@link LiveItem} does and exactly one of
 * them is set, so this is the join between "a measurement arrived" and "which pane it
 * belongs to". A page showing a planner round above a goal conversation has **two** meters
 * on it: two agents, two sessions, two models, two windows, and nothing but this key says
 * which figure is which.
 *
 * `undefined` for a frame naming none, which the server does not send. It is dropped rather
 * than shown against whichever pane is open, because a context figure attributed to the
 * wrong agent is worse than no figure at all — the whole point of the thing is to be
 * trusted at a glance.
 */
export const usageScope = (
  usage: Pick<
    LiveUsage | LiveConnection,
    "attemptId" | "roundId" | "goalId" | "importId"
  >,
): string | undefined => {
  if (usage.roundId !== null) return `round:${usage.roundId}`;
  if (usage.goalId !== null) return `goal:${usage.goalId}`;
  // Kept, though no importer pane draws a meter yet: dropping the frame would make the
  // importer's model calls the one agent on a page whose figures vanish unexplained.
  if (usage.importId !== null) return `import:${usage.importId}`;
  if (usage.attemptId !== null) return `attempt:${usage.attemptId}`;
  return undefined;
};

/**
 * What a chat says while the server's connection to its harness's narration is down (U13
 * review 5, `LiveConnection`), or `""` when it is up or was never down.
 *
 * Words for the operator, not the transport's: the frame's `detail` is a decoder's message
 * and says nothing they can act on. `restored` says nothing, because by then the chat is
 * reading the session's replay again, which is the whole of what it missed.
 */
export const connectionNote = (
  frame: Pick<LiveConnection, "state"> | undefined,
): string =>
  frame === undefined || frame.state === "restored"
    ? ""
    : frame.state === "reconnecting"
      ? "The harness's live narration was cut off; reconnecting. What it says meanwhile is read back from its transcript once the connection is up again."
      : "The harness's live narration could not be reconnected, and is still being retried. The agent may be working all the same: reload the page to see what its transcript holds.";

/** The key a pane asks the usage map for. See {@link usageScope}. */
export const roundUsageScope = (roundId: string): string => `round:${roundId}`;
/** The key a pane asks the usage map for. See {@link usageScope}. */
export const goalUsageScope = (goalId: string): string => `goal:${goalId}`;

/**
 * A figure with thousands separators, so 13753 reads as 13,753.
 *
 * Grouped here rather than through `toLocaleString`, so the same input produces the same
 * string in a test as on a screen: the runner's default locale is not the browser's, and a
 * meter asserted against "13,753" that renders "13.753" somewhere else would be a test
 * passing for the wrong reason.
 */
export const groupDigits = (value: number): string =>
  String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");

/**
 * One row of the meter's detail panel that only the caller can fill.
 *
 * The component owns the figures — tokens, window, percentage, the call's id — and the
 * caller owns the identity, because what identifies a planner round and what identifies a
 * goal conversation are different facts held in different places. A row the component
 * invented would be a claim about a session it cannot see.
 */
export interface MeterFact {
  readonly term: string;
  readonly value: string;
}

/** What the meter draws, decided here so it can be tested without a browser. */
export interface ContextMeter {
  /** The model call this measures. Shown, because it is what the harness's log calls it. */
  readonly callId: string;
  /**
   * The context this call carried: what was sent, plus what it generated.
   *
   * The same sum OpenCode's own meter uses for the last assistant message
   * (`input + output + reasoning + cache.read + cache.write`). **Never a session or turn
   * total** — see `live.ts` on the figures this is not built from.
   */
  readonly tokens: number;
  readonly promptTokens: number;
  /** `null` where the driver has not stated it. See {@link outputStated}. */
  readonly outputTokens: number | null;
  /**
   * Whether this call's output count is known.
   *
   * False on Claude Code until the turn ends: its `assistant` frames carry a stale count,
   * so the server omits it rather than publishing a 1. {@link tokens} is then the prompt
   * side alone and runs short by tens to hundreds of tokens, which the meter says in words
   * instead of implying a precision it does not have.
   */
  readonly outputStated: boolean;
  readonly limit: number | null;
  /**
   * How full the window is, 0–100, or `null` when no limit is known.
   *
   * Ruling 3: **a percentage is drawn only when a limit is known.** An honest "14,870
   * tokens" beats a fabricated "7%", so where this is `null` the meter shows the figure and
   * nothing else — and that is the ordinary state on Claude Code for the first moments of a
   * session, and the permanent state when a catalogue could not be read.
   */
  readonly percent: number | null;
  /**
   * Where the harness will summarise this session on its own, or `null`.
   *
   * **Not a second limit, and the meter must not read as if it were.** It is the point at
   * which the conversation is rewritten without anybody asking, and it sits far below the
   * window: OpenCode compacts bit's default model at about 58 % of the figure the bar is
   * drawn against. A meter that showed only the window would be telling an operator that
   * nothing happens until it reads full.
   *
   * `null` where the driver states no threshold this build has measured, which is every
   * Claude Code session.
   */
  readonly compactionAt: number | null;
  /**
   * {@link compactionAt} as a fraction of the window, 0–100, or `null`.
   *
   * `null` whenever either number is missing — there is no fraction to draw without both —
   * and clamped to the bar, because a harness whose threshold sits above the window it is
   * measured against is a configuration this build cannot predict rather than a mark to
   * draw off the end of a track.
   */
  readonly compactionPercent: number | null;
  /** When the call was measured, in epoch milliseconds. */
  readonly at: number;
}

/**
 * The meter for one pane, from the latest measurement its session produced.
 *
 * **One call, not a sum**, which is the whole correctness of this: both drivers publish
 * running totals that re-count the cached prefix on every call, and a meter built by adding
 * these frames up would read four to five times high (`live.ts` has the measured figures).
 * So the caller keeps the latest frame per session — `app.svelte.ts` does, keyed by
 * {@link usageScope} — and this turns that one frame into what is drawn.
 *
 * `undefined` for a session that has not made a model call yet, which is every session for
 * its first second or two.
 */
export const contextMeter = (
  usage: LiveUsage | undefined,
): ContextMeter | undefined => {
  if (usage === undefined) return undefined;
  const tokens = usage.promptTokens + (usage.outputTokens ?? 0);
  // A limit of zero or less is not a denominator. Neither driver has produced one; the
  // guard is here so a nonsense catalogue entry costs a percentage rather than an Infinity.
  const limit =
    usage.contextLimit !== null && usage.contextLimit > 0
      ? usage.contextLimit
      : null;
  // A threshold is only a threshold of something: without a window there is no fraction to
  // place it at, and the panel shows the token figure instead.
  const compactionAt =
    usage.compactionAt !== null && usage.compactionAt > 0
      ? usage.compactionAt
      : null;
  return {
    callId: usage.callId,
    tokens,
    promptTokens: usage.promptTokens,
    outputTokens: usage.outputTokens,
    outputStated: usage.outputTokens !== null,
    limit,
    percent: limit === null ? null : Math.round((tokens / limit) * 100),
    compactionAt,
    compactionPercent:
      limit === null || compactionAt === null
        ? null
        : Math.max(0, Math.min(100, Math.round((compactionAt / limit) * 100))),
    at: usage.at,
  };
};

/**
 * The meter's own one-line figure.
 *
 * Three shapes, and each says exactly what is known: tokens over a limit with a percentage;
 * tokens alone where no limit is; and `<1%` where a real fraction of a large window rounds
 * to nothing, because "0%" of 1,500 tokens reads as "nothing has been used".
 */
export const contextMeterLabel = (meter: ContextMeter): string => {
  const used = groupDigits(meter.tokens);
  if (meter.limit === null) return `${used} tokens`;
  const percent =
    meter.percent === 0 && meter.tokens > 0
      ? "<1%"
      : `${String(meter.percent)}%`;
  return `${used} / ${groupDigits(meter.limit)} · ${percent}`;
};

/**
 * Whether this call has passed the point at which the harness rewrites the session.
 *
 * Worth its own answer rather than a comparison at the call site, because what it means is
 * not "the meter is nearly full". It is a statement about the **next** call, and the tense
 * matters: this call was *sent* at this size, before anything was summarised, so the figure
 * is a true measurement and nothing here is retracting it. What is true past this point is
 * that the harness is about to rewrite the conversation, or has just done so — after which
 * the next call's context is smaller and the figure appears to go backwards. A pane that
 * did not say so would look like it had lost count.
 */
export const pastCompaction = (meter: ContextMeter): boolean =>
  meter.compactionAt !== null && meter.tokens >= meter.compactionAt;
