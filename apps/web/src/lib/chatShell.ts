/**
 * The chat shell's adapter: what a conversation page hands {@link ChatShell} so the shell
 * can draw it without knowing whose conversation it is (A6 prep for the goal, planner and
 * worker chats).
 *
 * The importer's page was the first chat to be a page (A6 D2–D5), and everything around
 * its thread — the operator's bubble, the streaming cursor, the turn footer, Stop, the
 * composer with Send now and its files, the refusal dialogs — was written into
 * `ImporterChat.svelte` against `app.importer`. This module is the seam: a
 * {@link ChatSession} says what the shell needs in the shell's words, and each chat builds
 * one from its own state. `ImporterChat.svelte` is the first adapter; the goal chat, the
 * planner and the workers are later ones.
 *
 * **Optional is "this chat cannot", not "not yet".** A session with no `stop` draws no Stop;
 * a composer with no `sendNow` draws no Send now; no `composer` at all is a read-only
 * thread; a closed composer ({@link ClosedChatComposer}: its reason and nothing else) draws
 * that sentence where the input would be, with Stop and the elapsed time still working above
 * it; a `question` puts A7-Q's dock in the box's place until the adapter takes it away. The
 * shell never guesses a capability from a role.
 *
 * Plain TypeScript, so the rules here are tested without a browser; the shell arranges.
 */
import type {
  MessageAttachmentView,
  PendingQuestion,
  QuestionAnswers,
  SteerUrgency,
} from "@bit/contracts";

import type { AttachmentLoader } from "./attachmentFiles";
import { durationLabel, turnEndedAt, turnModels, type ChatGroup } from "./chat";
import type { ErrorNotice } from "./components/ErrorDialog.svelte";
import type { ComposerFiles } from "./composerFiles.svelte";

/**
 * One turn of a thread: the operator's message and the agent's work on it.
 *
 * The importer's shape (A6 S3–U6), and nothing in it is the importer's: a goal chat's turn
 * is the same, a planner round can be one with its prompt as `message` (or `null`), and a
 * worker run is one turn whose `message` is the intent's question. `ImporterTurn` is this.
 */
export interface ThreadTurn {
  /** The operator's words, or `null` on the "earlier in this session" group. */
  readonly message: string | null;
  /**
   * The files the message carried (A6 U13): the server's answer's while it is this tab's,
   * the transcript's after a reload. Absent, or empty, on a message with none.
   */
  readonly attachments?: readonly MessageAttachmentView[];
  /** Which operator message this is, from one. `null` on the leading group. */
  readonly number: number | null;
  /**
   * When the operator sent it, in epoch milliseconds, or `null` on the leading group.
   *
   * On a replayed turn it is the harness's own time for the message (A6 F10); on a live one,
   * this tab's clock when it was sent. Shown, never used for ordering.
   */
  readonly at: number | null;
  /** True while the agent is still working on this message. */
  readonly working: boolean;
  /**
   * True while this message waits behind a turn already running (A6 U4): it was sent
   * mid-turn and the harness has not yet said it took it (`turn.taken`). Drawn where the
   * operator sent it, marked queued; once taken it is an ordinary turn.
   */
  readonly queued: boolean;
  /**
   * True when this message was sent with D3's "Send now" while a turn ran (A6 U6): a
   * `preemptive` steer, which the harness takes at its next step, dropping the rest of the
   * work in flight. Said under the bubble while it waits and once it was taken.
   */
  readonly sentNow: boolean;
  /**
   * When the agent started on this message, on the server's clock, or `null` on the
   * leading group: when the harness took it, for a message that waited; otherwise when it
   * was accepted (live) or stored (replayed). The start of the turn footer's duration.
   */
  readonly startedAt: number | null;
  /**
   * True on the turn the agent is on when this page holds nothing of its reply but the
   * harness is still working on it (A6 U5): a reload while Claude Code is part way through
   * a block, which it writes to its transcript only once the block is complete, and whose
   * partials before the reload are not sent again — the next one, with the whole text so
   * far, comes with the block's next words (A6 U5 review: a block that has paused, a GLM
   * thought left open while nothing follows it, sends none until it finishes). Drawn as in
   * progress ("writing…") rather than as a message the harness holds no reply to.
   */
  readonly midBlock: boolean;
}

/**
 * The sentences and names the shell says about the agent, which differ per chat: "the
 * importer", "the goal agent", "the planner". Written by the adapter in full, never
 * assembled here from a noun, so each chat's wording stays its own and reads as a sentence.
 */
export interface ChatWords {
  /** The status line a screen reader hears while a turn runs. */
  readonly working: string;
  /** The Copy under a finished reply. */
  readonly copyReply: string;
  /** Stop's title while a turn runs. */
  readonly stopTurn: string;
  /** Stop's title for background work with no turn running (A6 U6). */
  readonly stopBackground: string;
  /** The textarea's label. */
  readonly messageLabel: string;
  /** The arrow's label. */
  readonly sendLabel: string;
  /** The arrow's title while nothing runs. */
  readonly sendTitle: string;
  /** The arrow's title while a turn runs, when a message is queued behind it. */
  readonly sendQueuedTitle: string;
  /** The title on the count of characters, once a message nears its limit. */
  readonly countTitle: string;
  /**
   * The words before the elapsed clock beside Stop, for a chat with one (`turn.since`): the
   * planner's "Planning for", a worker's "Running for" (`PlannerChat`, `ComposeBox`), the
   * figure then set in bold after them. Absent: the figure alone.
   */
  readonly elapsedLead?: string | undefined;
  /**
   * What a screen reader hears when a question takes the box's slot (A7-Q review 1), by
   * how many questions it holds: the importer's "The importer asks 3 questions".
   */
  readonly questionsAsked: (count: number) => string;
}

/**
 * How the agent's turn stands, as the server last said. Drives the Stop control, the
 * elapsed clock and the arrow's title.
 */
export interface ChatTurnState {
  /** A turn is running. */
  readonly working: boolean;
  /**
   * Work the agent started in the background still running outside any turn (A6 U6). Stop
   * is offered for it too.
   */
  readonly background: boolean;
  /** A Stop is out and has not been answered. */
  readonly stopping: boolean;
  /**
   * When the running work started, in epoch milliseconds, for an elapsed clock beside Stop —
   * the planner's and a worker's strip (`PlannerChat`, `ComposeBox`). Absent draws none:
   * the importer's D3 has no clock.
   */
  readonly since?: number | undefined;
}

/** A sentence above the composer: a refusal, a note, a wait. */
export interface ComposerNotice {
  /** Stable across renders, for the keyed list. */
  readonly key: string;
  readonly text: string;
  /** `alert` for a refusal, which is announced at once; `status` for anything else. */
  readonly tone: "status" | "alert";
  /** An extra class on the sentence, for its colour (`refusal`) or a test's handle. */
  readonly kind?: string | undefined;
}

/**
 * D3's "Send now" (A6 U6), for a chat whose server can steer a running turn.
 *
 * `offered` is whether the button is drawn at all — a turn runs in a session the server
 * holds — and the shell disables it while nothing can be sent. `title` says what the
 * harness does with it (`sendNowButtonTitle`).
 */
export interface ComposerSendNow {
  readonly offered: boolean;
  readonly title: string;
}

/**
 * The composer: the operator's box, its files and what sending does.
 *
 * Absent on the session is a thread with no box at all (`Chat`'s `readonly`). Otherwise one
 * of two variants, told apart by {@link ClosedChatComposer.closed}:
 *
 * - {@link OpenChatComposer}, the box the operator writes in — the importer's, a goal
 *   chat's. Every field a box needs is required, so an adapter that forgets one fails to
 *   compile rather than drawing a box that cannot send.
 * - {@link ClosedChatComposer}, a box that says why it takes nothing — the planner's
 *   ("steered from the goal chat") and a worker's ("the prompt is the intent's question"):
 *   only the reason, which keeps the strip, the dock in its slot and Stop.
 */
export type ChatComposerSource = OpenChatComposer | ClosedChatComposer;

/** A box the operator writes in. See {@link ChatComposerSource}. */
export interface OpenChatComposer {
  /** Never set on an open box: `closed` is what tells the two variants apart. */
  readonly closed?: undefined;
  /**
   * The words being written. Read and written by the shell's textarea (`bind:value`), so an
   * adapter backs it with a getter and a setter over its own state — the importer's draft is
   * `app.importer.draft`, which parks and restores across sessions.
   */
  draft: string;
  /** The files tray (A6 U13). Absent: no `+`, no paste or drop of files, no tray. */
  readonly files?: ComposerFiles | undefined;
  /** A send is out and has not been answered. */
  readonly sending: boolean;
  /**
   * The input is drawn and disabled, its {@link placeholder} saying why (the importer's
   * stranded, ended, refused and no-harness states). Distinct from a closed box: this is a
   * conversation that cannot be continued *now*, drawn as the box it was.
   */
  readonly blocked: boolean;
  readonly placeholder: string;
  /** The most characters the server takes; the count shows past 90 % of it. */
  readonly maxChars?: number | undefined;
  /** Sends the draft and the tray, `queued` or `preemptive`. */
  readonly send: (urgency: SteerUrgency) => void;
  /** D3's Send now; absent where the server cannot steer a turn. */
  readonly sendNow?: ComposerSendNow | undefined;
  /** The sentences above the box, in order. */
  readonly notices: readonly ComposerNotice[];
}

/**
 * A box that takes no message at all. See {@link ChatComposerSource}.
 *
 * The reason is drawn where the input would be; the input, the `+`, the send buttons and the
 * sentences above the box are not. The strip, the dock and Stop are.
 */
export interface ClosedChatComposer {
  /** Why this chat takes no message, as a sentence. */
  readonly closed: string;
}

/**
 * A question the agent is waiting on (A7-Q, E3/E4): what the dock draws and what it does.
 *
 * **Present is "the dock holds the composer's slot".** While it is set, the shell draws the
 * question dock *in place of* the box — open or closed — in the same column, at the same
 * width, with Stop and the elapsed clock where they were (E3: "the composer's slot becomes
 * the question dock … nothing above it moves"). The adapter takes it away to give the
 * composer back: when the question is answered or dismissed, or the agent stops waiting.
 *
 * Generic on purpose: the shell's own dock (`QuestionDock`) is drawn for any chat whose
 * adapter sets this, so the goal, planner and worker chats get it by supplying a question.
 */
export interface ChatQuestion {
  /** The question, as the server says it, with whether it can still be answered. */
  readonly pending: PendingQuestion;
  /** Who asks, as a sentence's subject: "The importer". */
  readonly asker: string;
  /** True while an answer or a dismissal is with the server: the dock's controls wait. */
  readonly busy: boolean;
  /** Sends the answers (`live`). The adapter says a refusal through {@link refusal}. */
  readonly answer: (answers: QuestionAnswers) => void;
  /**
   * Sends the answers as an ordinary message (`message`): absent where this chat takes no
   * message, and then a question no longer waiting can only be dismissed.
   */
  readonly sendAsMessage?: ((text: string) => void) | undefined;
  /**
   * Dismisses the question: Esc in the dock, or its own control. `live`: the agent is told
   * the operator declined. Otherwise the question is put away. The shell then puts focus in
   * the box. Absent where the owner cannot dismiss: no dismiss control, and Esc does not
   * dismiss.
   */
  readonly dismiss?: (() => void) | undefined;
  /** An answer or a dismissal the server refused, for the F2 dialog. */
  readonly refusal?: ErrorNotice | undefined;
  readonly dismissRefusal?: (() => void) | undefined;
}

/**
 * Everything {@link ChatShell} draws a conversation from.
 *
 * `Subject` is the group's subject, a {@link ThreadTurn} or a chat's own extension of one,
 * so a chat that needs more on its separator passes its own snippet and keeps its fields.
 */
export interface ChatSession<Subject extends ThreadTurn = ThreadTurn> {
  /** The chat's name: its accessible label and the empty page's heading. */
  readonly label: string;
  /** The empty page's lead sentence. */
  readonly empty: string;
  /** The turns, live and replayed, oldest first. */
  readonly groups: readonly ChatGroup<Subject>[];
  /** A sentence over the thread about what it is not showing, or `""`. */
  readonly note: string;
  /**
   * The connection to the session's narration, when it is down (U13 review 5,
   * `connectionNote`), or `""`. Said over the thread as an alert.
   */
  readonly connection: string;
  readonly turn: ChatTurnState;
  /** Interrupts the running turn or background work. Absent: no Stop. */
  readonly stop?: (() => void) | undefined;
  /**
   * **E7's Stop all** (A7-S), drawn **in Stop's place** while `running` sub-agents run: the
   * pill reads "Stop all" and asks this instead of {@link stop} — the session's sub-agents,
   * then its turn and background work — with the same elapsed clock and the same stopping
   * state. Offered even with no turn running, since a sub-agent can outlive the turn that
   * started it (an OpenCode background child is no harness "background work"). Absent, or
   * `running: 0`: Stop is as it was. Needs {@link stop}: a chat that cannot stop cannot stop
   * all.
   */
  readonly stopAll?:
    | {
        readonly running: number;
        readonly stop: () => void;
        /** The pill's title: what Stop all stops, in the chat's words. */
        readonly title: string;
      }
    | undefined;
  /** A Stop the server refused, for the F2 dialog. */
  readonly stopFailure?: ErrorNotice | undefined;
  readonly dismissStopFailure?: (() => void) | undefined;
  /** The box. Absent: a read-only thread. */
  readonly composer?: ChatComposerSource | undefined;
  /**
   * A question the agent waits on, while it holds the composer's slot (A7-Q). Absent: the
   * box is drawn. See {@link ChatQuestion}.
   */
  readonly question?: ChatQuestion | undefined;
  readonly words: ChatWords;
  /**
   * The first word of a finished turn's footer, the agent's label (D4's "Importer · …"), and
   * the model said where a turn's items name none.
   */
  readonly footer: { readonly agent: string; readonly model: string };
  /** The title on a bubble's "sent now" mark: what the harness cut (`sentNowTitle`). */
  readonly sentNowTitle: string;
  /**
   * A file chip's bytes, from the server that stored them (A6 U13). Set in context by the
   * shell for every chip in the thread.
   */
  readonly loadFile?: AttachmentLoader | undefined;
}

/** "18:02": when the operator's message was sent, as D3 sets it under the bubble. */
export const clockLabel = (at: number): string =>
  new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

/**
 * A finished turn's footer, D4's "Importer · openai/gpt-5.6-sol · 41s" (A6 U4).
 *
 * - **The models are the turn's own** (`turnModels`, from each item's `model`), so an
 *   earlier turn keeps the model that answered it after a switch, and a turn switched
 *   mid-way names both: `claude-sonnet-4-5 → claude-haiku-4-5`. The session's current
 *   model only where the harness named none.
 * - **The duration** runs from when the agent started on the message — accepted, or
 *   taken off the queue, on the server's clock; stored, on a replay — to the turn's last
 *   item, which the server or the harness stamped. Both ends one clock, so it is a length
 *   and not a difference between two machines. Left out when the turn has no items.
 */
export const turnFooterText = (
  group: ChatGroup<ThreadTurn>,
  footer: { readonly agent: string; readonly model: string },
): string => {
  const models = turnModels(group);
  const model = models.length > 0 ? models.join(" → ") : footer.model;
  const ended = turnEndedAt(group);
  const started = group.subject.startedAt;
  const took =
    ended !== undefined && started !== null && ended >= started
      ? durationLabel(ended - started)
      : "";
  return [footer.agent, model, took].filter((part) => part !== "").join(" · ");
};

/** The agent's words in a turn, as the footer's Copy copies them. */
export const replyText = (group: ChatGroup<ThreadTurn>): string =>
  group.rows
    .filter((row) => row.item.kind === "turn.reply")
    .map((row) => row.item.body.trim())
    .filter((body) => body !== "")
    .join("\n\n");

/**
 * Whether the arrow sends: words, or files — a message of files alone is let through to
 * Send, which refuses it in the dialog with the reason (A6 U13) rather than leaving the
 * arrow dead without one. Never while closed, blocked or sending.
 */
export const composerCanSend = (composer: ChatComposerSource): boolean =>
  composer.closed === undefined &&
  !composer.blocked &&
  !composer.sending &&
  (composer.draft.trim() !== "" || (composer.files?.items.length ?? 0) > 0);

/**
 * Whether Stop is drawn: the session can stop, and the server says something runs — a
 * turn, or background work with no turn (A6 U6).
 */
export const stopOffered = (session: ChatSession<ThreadTurn>): boolean =>
  session.stop !== undefined &&
  (session.turn.working || session.turn.background || stopsAll(session));

/** Whether the Stop pill is E7's Stop all now: sub-agents run (A7-S). */
export const stopsAll = (session: ChatSession<ThreadTurn>): boolean =>
  session.stop !== undefined && (session.stopAll?.running ?? 0) > 0;

/** The longest draft, in lines and in characters, a floating box still rests with. */
export const RESTING_DRAFT = { lines: 3, chars: 240 } as const;

/**
 * Whether the composer is at rest, for a floating chat (`Chat`'s `composerResting`): no
 * question holds its slot and the draft is short. Only a resting box's height becomes the
 * log's bottom padding, so a dock or a long draft covers more of the log rather than moving
 * every message up. Characters as well as lines, because the box grows with a draft that
 * wraps as much as with one that breaks: about three lines of the 800px column.
 */
export const composerResting = (session: ChatSession<ThreadTurn>): boolean => {
  if (session.question !== undefined) return false;
  const open = openComposer(session);
  if (open === undefined) return true;
  return (
    open.draft.split("\n").length <= RESTING_DRAFT.lines &&
    open.draft.length <= RESTING_DRAFT.chars
  );
};

/** The session's box when the operator can write in it, or `undefined`. */
export const openComposer = (
  session: ChatSession<ThreadTurn>,
): OpenChatComposer | undefined =>
  session.composer === undefined || session.composer.closed !== undefined
    ? undefined
    : session.composer;
