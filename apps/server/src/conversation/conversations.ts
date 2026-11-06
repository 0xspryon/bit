/**
 * A long-lived conversation with an agent, for any owner: the scope importer's conversation
 * machinery (S2–S7, A6, A7-Q, A7-S), with the owner made a parameter (A6 chat generalisation,
 * slice 2).
 *
 * ## Owner, session, period
 *
 * An **owner** is what the conversation belongs to: the target's Auto-load chat today, a goal
 * or a planner stage later. It is the {@link ConversationBinding}: its rows, its credential,
 * its narration subject, its prompts and its words. A **session** is one harness session. A
 * **period** is one authority period on a session — one credential, one MCP registration,
 * one row — and its id is what everything here is keyed by: the import id for the importer.
 *
 * **A period is never revived.** Every reopen or resume mints a new id ({@link begin} with a
 * `predecessor`), and the old row's end is never cleared. {@link ConversationRow.latestId}
 * and the in-process successor links follow an old id forward, so an old tab's message, Stop
 * or switch reaches the period that holds the session now.
 *
 * ## What this owns, on top of the registry
 *
 * The registry (`harness/liveAgentSessions.ts`) owns authority and lifetime. This owns what
 * makes a registry entry a conversation an operator can talk to:
 *
 * - the opening in flight, and the link from a period to its successor;
 * - delivery: the newest-period follow, joining an open, and the reopen under the old id's
 *   own permit, which the registry's per-id permit cannot cover (the successor is a new id);
 * - the operator's messages held beside the transcript until it holds them, and the take
 *   marks on them;
 * - the settle loop, which waits for each turn to go idle;
 * - the narrator, with its take marks and its last-word `connection closed` frame;
 * - Stop, Stop all, a sub-agent's Stop, the pending question (answer, dismiss, put away,
 *   re-check), activity, the context window and the model switch.
 *
 * ## What it does not own
 *
 * What a period *means*: whether the owner has a progress view, what a message is framed
 * with, which pages it may cite, what a fresh session after a restart is opened with. The
 * binding's hooks carry those, and a binding that has none passes none.
 *
 * ## One core per owner kind
 *
 * {@link makeConversations} is called inside an owner's own layer, as
 * `makeLiveAgentSessions` is and for its reasons: ids are only unique within an owner kind,
 * and an owner's sessions close with its own layer's scope.
 */
import {
  ConversationModelRefused,
  ConversationStopRefused,
  QuestionRefused,
  questionAnswersProblem,
  SubagentStopRefused,
  type ConversationActivity,
  type ConversationContext,
  type ConversationModelDraft,
  type ConversationModelSwitched,
  type ConversationQueuedMessage,
  type ConversationStart,
  type ConversationStopped,
  type MessageAttachmentView,
  type ModelOptionSelection,
  type PendingQuestion,
  type QuestionAnswers,
  type QuestionSettled,
  type SteerUrgency,
  type SubagentStopped,
} from "@bit/contracts";
import {
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Schedule,
  Semaphore,
  type Duration,
  type Scope,
} from "effect";

import {
  truncateNarration,
  type AgentHarness,
  type HarnessFailure,
  type HarnessNarration,
  type HarnessQuestion,
} from "../harness/agentHarness";
import { attachmentView, type MessageAttachment } from "../harness/attachments";
import type { QuestionNotPending } from "../harness/errors";
import {
  makeLiveAgentSessions,
  type LiveAgentSession,
  type LiveAgentSessions,
  type LiveSessionCloseReason,
  type LiveSessionOpenFailure,
  type LiveSessionRole,
  type OpenPlan,
} from "../harness/liveAgentSessions";
import {
  checkModelSwitch,
  type CheckedModelSwitch,
  modelSwitched,
  modelSwitchRefusal,
  recordRefusal,
  sameModelChoice,
} from "../harness/modelSwitch";
import {
  pendingQuestionView,
  transcriptQuestionId,
  type QuestionSubjectIds,
} from "../harness/questions";
import type { HarnessResolver } from "../harness/resolver";
import { turnStopped, turnStopRefusal } from "../harness/turnStop";
import type { NarrationSubject, RunNarrations } from "../run/narration";
import { narrateCoalesced } from "../run/streamingCoalescer";
import type { WorkerUrls } from "../run/supervisor";
import type { ReadUpload } from "../upload/uploads";

/** A store's failure, as a binding's row reads answer it. */
export interface StoreFailure {
  readonly _tag: string;
  readonly message: string;
}

/**
 * The fields of one period's row the core reads. An owner's row may carry more (the
 * importer's pages and agent); the binding's own hooks read those.
 */
export interface ConversationRow {
  readonly targetId: string;
  readonly harnessSessionId: string;
  readonly harnessInstanceId: string | null;
  readonly model: string;
  readonly modelOptions: readonly ModelOptionSelection[] | null;
  /** Why the period ended (`0027`), or null while it has not. Only `operator` is final. */
  readonly endedReason: string | null;
  /**
   * The session's newest confirmed period, or null when none was confirmed: what an old
   * period id is followed to after a restart, when the in-process successor links are gone.
   */
  readonly latestId: string | null;
}

/**
 * Why a message was refused, in the core's words; the binding turns each into its own
 * refusal (the importer's `ImporterConversationRefused`).
 *
 * - `harness_unreachable` — the harness would not take a message, which closed the session.
 * - `upload_unwritable` — the message's files could not be stored; the session is kept.
 * - `store_unavailable` — what should be unreachable, answered rather than died on.
 * - `ended` — the operator ended this period, or stopped it before it had opened.
 */
export type ConversationRefusalReason =
  "harness_unreachable" | "upload_unwritable" | "store_unavailable" | "ended";

/** One accepted message, before the owner adds its own fields and names its period id. */
export interface ConversationAccepted {
  readonly targetId: string;
  /** The period the message landed in. */
  readonly conversationId: string;
  readonly harnessSessionId: string;
  readonly harnessInstanceId: string;
  readonly model: string;
  readonly conversation: ConversationStart;
  readonly note: string;
  readonly acceptedAt: number;
  readonly messageId?: string;
  readonly attachments?: readonly MessageAttachmentView[];
}

/** A message addressed to one period, as {@link Conversations.send} takes it. */
export interface ConversationSend {
  readonly targetId: string;
  readonly conversationId: string;
  readonly text: string;
  readonly urgency?: SteerUrgency | undefined;
  readonly uploads?: readonly ReadUpload[] | undefined;
}

/**
 * How a period's first turn says how its open went, for a caller that waits on it: the
 * entry the registry opened, or the owner's refusal.
 */
export type ConversationOpening<Meta, Refused> = Deferred.Deferred<
  LiveAgentSession<Meta>,
  Refused
>;

/**
 * How a dismissal the harness did not answer is followed up (A7-Q review 2): the harness is
 * asked again whether the question still waits, first after `first`, then backing off by
 * doubling to at most `most` between asks, for `window` in all.
 */
export interface QuestionRecheckSchedule {
  readonly first: Duration.Input;
  readonly most: Duration.Input;
  readonly window: Duration.Input;
}

/**
 * What an owner is, to the core.
 *
 * - `Meta` is what the owner keeps beside a session (the importer's agent).
 * - `Row` is the owner's row, which carries at least {@link ConversationRow}.
 * - `NotFound` is the owner's 404: a period this target does not hold.
 * - `Refused` is the owner's refusal of a message.
 * - `Extra` is what the owner adds to an accepted message, and `Accepted` its wire shape.
 */
export interface ConversationBinding<
  Meta,
  Row extends ConversationRow,
  NotFound,
  Refused,
  Extra,
  Accepted,
> {
  /** The credential, endpoint and log words: the registry's role, less `afterClose`. */
  readonly role: Omit<LiveSessionRole<Meta>, "afterClose">;
  /** The narration subject a period's frames are published under. */
  readonly subject: (id: string) => NarrationSubject;
  /** The same subject, as a question's four ids. */
  readonly questionSubject: (id: string) => QuestionSubjectIds;
  readonly rows: {
    /** One period's row, or `undefined` when this target's store holds none. */
    readonly read: (
      targetId: string,
      id: string,
    ) => Effect.Effect<Row | undefined, StoreFailure>;
    /** Records why a period ended. Must not fail: log and carry on. The first end wins. */
    readonly markEnded: (
      targetId: string,
      id: string,
      reason: LiveSessionCloseReason,
    ) => Effect.Effect<void>;
    /** Writes a switched model onto a period's row; `false` when no row was written. */
    readonly recordModel: (
      targetId: string,
      input: {
        readonly id: string;
        readonly model: string;
        readonly modelOptions: readonly ModelOptionSelection[] | undefined;
      },
    ) => Effect.Effect<boolean, StoreFailure>;
  };
  /** The owner's 404, finishing "no … '<id>' is recorded on target '<t>', so <clause>". */
  readonly notFound: (targetId: string, id: string, clause: string) => NotFound;
  /** The owner's refusal for an open that failed, in the failing component's words. */
  readonly openRefused: (
    failure: LiveSessionOpenFailure | StoreFailure,
  ) => Refused;
  /** The owner's refusal for one of the core's own reasons. */
  readonly refused: (
    reason: ConversationRefusalReason,
    detail: string,
  ) => Refused;
  /** How a later message is framed for the agent: the agent's own follow-up prompt. */
  readonly followUp: (meta: Meta, text: string) => string;
  /**
   * A message to a period this process does not hold and the operator did not end: the
   * owner opens its successor (a resume or a fresh session) through {@link begin}, with
   * `predecessor` set, and answers the accepted message. Called under the old id's reopen
   * permit, with the row read inside it.
   */
  readonly reopen: (input: {
    readonly send: ConversationSend;
    readonly row: Row;
  }) => Effect.Effect<Accepted, Refused | NotFound>;
  /** The owner's wire shape for an accepted message. */
  readonly accepted: (base: ConversationAccepted, extra: Extra) => Accepted;
  readonly words: {
    /** A period, named in a sentence: `import imp_1`. */
    readonly what: (id: string) => string;
    /** The agent, by role, for a sub-agent's sentences: `importer`. */
    readonly agent: string;
    /** A message the harness refused, after the harness's own sentence. */
    readonly undelivered: (detail: string) => string;
    /** A message whose files could not be stored, after the store's own sentence. */
    readonly unwritable: (detail: string) => string;
    /** The narrator's stream failed: a log line. */
    readonly narrationFailed: string;
    /** A period stopped before its session opened. */
    readonly stoppedBeforeOpen: (id: string) => string;
    /** A message to a period the operator ended: why it is refused. */
    readonly ended: (id: string) => string;
  };
  readonly hooks: {
    /**
     * Before a later message is delivered: anything the owner widens from the operator's
     * words (the importer's citable pages). Its answer is the accepted message's `Extra`.
     */
    readonly delivering: (
      entry: LiveAgentSession<Meta>,
      text: string,
    ) => Effect.Effect<Extra>;
    /**
     * After a later message is delivered: whether the period is working again, so a settle
     * loop should run for it (the importer's progress view). `true` with no view to keep.
     */
    readonly resumed: (id: string) => Effect.Effect<boolean>;
    /**
     * The session went idle with no message delivered since the wait began, or ended.
     * `stop` — the owner already settled it (an operator stop); `again` — a message arrived
     * while the hook ran; `settled` — done. The importer reads its closing report here.
     */
    readonly idle: (input: {
      readonly id: string;
      readonly harness: AgentHarness["Service"];
      readonly sessionId: string;
      readonly failure: HarnessFailure | undefined;
      readonly more: () => boolean;
    }) => Effect.Effect<"stop" | "again" | "settled">;
    /** Whether the owner's own view says the period is running, beside the harness's. */
    readonly alsoRunning: (id: string) => Effect.Effect<boolean>;
    /** A live session moved onto `model` (the importer's progress panel names it). */
    readonly switched: (id: string, model: string) => Effect.Effect<void>;
  };
}

/** What {@link makeConversations} needs from the owner's layer. */
export interface ConversationDeps {
  readonly endpoints: { readonly urls: Effect.Effect<WorkerUrls> };
  readonly narrations: RunNarrations["Service"];
  readonly resolver: HarnessResolver["Service"];
  readonly recheck: QuestionRecheckSchedule;
  /** The owner's layer scope: every first turn and settle loop is forked into it. */
  readonly scope: Scope.Scope;
}

export interface Conversations<Meta, NotFound, Refused, Accepted> {
  /** The registry, for the owner's own reads (`ready`, `get`) and nothing that closes. */
  readonly sessions: LiveAgentSessions<Meta>;
  /**
   * Starts one period's first turn, under an id the owner minted: from this instant the
   * period is "still opening" (a message to it waits), and the predecessor, if any, is
   * linked to it. `before` runs first (the owner's row and view) and must not fail; then the
   * first turn is forked into the owner's scope and this answers. `opening`, when given,
   * hears how the open went.
   */
  readonly begin: (input: {
    readonly id: string;
    readonly targetId: string;
    readonly predecessor: string | undefined;
    readonly opening: ConversationOpening<Meta, Refused> | undefined;
    readonly before: Effect.Effect<void>;
    /** The registry's plan, built when the turn runs. `narrate` is the core's. */
    readonly plan: Omit<OpenPlan<Meta>, "narrate">;
    /** The open failed, with this sentence: the owner's view says so. Must not fail. */
    readonly failed: (detail: string) => Effect.Effect<void>;
  }) => Effect.Effect<void>;
  /** An accepted message's core fields, from the entry it landed in. */
  readonly acceptedOf: (
    entry: LiveAgentSession<Meta>,
    conversation: ConversationStart,
    note: string,
    messageId?: string,
    attachments?: readonly MessageAttachment[],
  ) => ConversationAccepted;
  /**
   * Gives one message to a period. Live: delivered as a steer under the same id. Still
   * opening: waited for, then asked again. Superseded: followed to the newest period. Not
   * held and not ended by the operator: {@link ConversationBinding.reopen}.
   */
  readonly send: (
    input: ConversationSend,
  ) => Effect.Effect<Accepted, Refused | NotFound>;
  /**
   * What a replay adds to the owner's transcript read: the messages held beside it, and
   * the question waiting now. `read` is handed the live session, if held, and is told the
   * ids its whole transcript holds.
   */
  readonly replay: <View extends { readonly live: boolean }>(input: {
    readonly id: string;
    readonly fromTranscript: (view: View) => PendingQuestion | null;
    readonly read: (
      held: LiveAgentSession<Meta> | undefined,
      onTranscript: (written: ReadonlySet<string>) => void,
    ) => Effect.Effect<View>;
  }) => Effect.Effect<{
    readonly view: View;
    readonly queued: readonly ConversationQueuedMessage[];
    readonly question: PendingQuestion | null;
  }>;
  /** The operator ends a period: revoke, record `operator`, interrupt, close. */
  readonly end: (targetId: string, id: string) => Effect.Effect<boolean>;
  readonly stopTurn: (input: {
    readonly targetId: string;
    readonly conversationId: string;
  }) => Effect.Effect<ConversationStopped, ConversationStopRefused | NotFound>;
  readonly stopSubagent: (input: {
    readonly targetId: string;
    readonly conversationId: string;
    readonly callId: string;
  }) => Effect.Effect<SubagentStopped, SubagentStopRefused | NotFound>;
  readonly stopAll: (input: {
    readonly targetId: string;
    readonly conversationId: string;
  }) => Effect.Effect<ConversationStopped, ConversationStopRefused | NotFound>;
  readonly answerQuestion: (input: {
    readonly targetId: string;
    readonly conversationId: string;
    readonly questionId: string;
    readonly answers: QuestionAnswers;
  }) => Effect.Effect<QuestionSettled, QuestionRefused | NotFound>;
  readonly dismissQuestion: (input: {
    readonly targetId: string;
    readonly conversationId: string;
    readonly questionId: string;
  }) => Effect.Effect<QuestionSettled, QuestionRefused | NotFound>;
  readonly activity: (input: {
    readonly targetId: string;
    readonly conversationId: string;
  }) => Effect.Effect<ConversationActivity, NotFound>;
  readonly context: (input: {
    readonly targetId: string;
    readonly conversationId: string;
    readonly breakdown: boolean;
  }) => Effect.Effect<ConversationContext, NotFound>;
  readonly switchModel: (
    input: {
      readonly targetId: string;
      readonly conversationId: string;
    } & ConversationModelDraft,
  ) => Effect.Effect<
    ConversationModelSwitched,
    ConversationModelRefused | NotFound
  >;
  /** Whether this process holds a session under this period id. */
  readonly holds: (id: string) => Effect.Effect<boolean>;
  /** How many messages this process holds beside one period's transcript. */
  readonly heldSteers: (id: string) => Effect.Effect<number>;
  /** Whether a first turn or settle loop of this period is still running. */
  readonly turning: (id: string) => boolean;
  /** The first turn or settle loop of this period, if one runs. */
  readonly turnOf: (id: string) => Fiber.Fiber<void> | undefined;
}

/** A join attempt that found nothing to join. Never leaves this module. */
const NOT_LIVE = { _tag: "NotLive" } as const;

/** The newer period an id's row points at, when it is not the id itself. */
const newerRun = (
  id: string,
  row: { readonly latestId: string | null },
): string | undefined =>
  row.latestId !== null && row.latestId !== id ? row.latestId : undefined;

/**
 * Builds one owner kind's conversation core, and its registry, in the calling layer's
 * scope (the registry's finalizer closes every session still open).
 */
export const makeConversations = <
  Meta,
  Row extends ConversationRow,
  NotFound,
  Refused,
  Extra,
  Accepted,
>(
  deps: ConversationDeps,
  binding: ConversationBinding<Meta, Row, NotFound, Refused, Extra, Accepted>,
): Effect.Effect<
  Conversations<Meta, NotFound, Refused, Accepted>,
  never,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const { narrations, resolver, recheck } = deps;
    const own = deps.scope;
    const { rows, words, hooks } = binding;

    /**
     * The operator's messages each live period's harness transcript does not hold yet, by
     * period id and then by message id (A6 U4 review, review 2), and the message ids the
     * harness has said it took.
     *
     * **Why this process keeps them at all**, when it keeps no other word of a conversation
     * (DECISIONS.md §8): a steer delivered while a turn runs is queued in the harness, and
     * neither harness's transcript holds it until it is taken — so a reload in that window
     * lost the message. {@link replay} carries these beside the transcript.
     *
     * **A take does not remove one** (review 2): Claude Code narrates the take 30–130 ms
     * before its transcript holds the message. A take only marks it `taken`. Removed when a
     * replay finds it written (review 3: anywhere in the transcript), when the turn settles
     * idle, and with the session when it closes. `taken` is there for the race the other way
     * round: a take seen before `deliver` returned still marks the message when it is added.
     *
     * V2(chat): queued steers live in memory only; a server restart loses a steer that was
     * still queued (and the harness session that held it), and nothing tells the operator it
     * was never read. Proper V2: persist queued messages with the app-owned queue.
     */
    const steers = new Map<
      string,
      {
        readonly queued: Map<string, ConversationQueuedMessage>;
        /** Each message taken, to the messages taken with it when there were several. */
        readonly taken: Map<string, readonly string[] | undefined>;
      }
    >();
    const steersOf = (id: string) => {
      const held = steers.get(id);
      if (held !== undefined) return held;
      const fresh = {
        queued: new Map<string, ConversationQueuedMessage>(),
        taken: new Map<string, readonly string[] | undefined>(),
      };
      steers.set(id, fresh);
      return fresh;
    };
    /** A held message, marked taken — with the messages taken with it, if any. */
    const tookIt = (
      message: ConversationQueuedMessage,
      together: readonly string[] | undefined,
    ): ConversationQueuedMessage => ({
      messageId: message.messageId,
      text: message.text,
      acceptedAt: message.acceptedAt,
      taken: true,
      ...(together === undefined ? {} : { takenTogether: [...together] }),
    });
    /**
     * How many messages have been accepted into each period's live session, ever (A6 U4
     * review 3): what lets {@link settleTurn} tell that a message arrived while it was
     * finishing. Counted in {@link deliverTurn} **before** it asks whether the period is
     * working again.
     */
    const deliveries = new Map<string, number>();
    const deliveriesTo = (id: string): number => deliveries.get(id) ?? 0;

    const sessions = yield* makeLiveAgentSessions<Meta>(
      { endpoints: deps.endpoints },
      {
        ...binding.role,
        afterClose: (entry, reason) =>
          Effect.andThen(
            // What the session held queued went with it, and is not this process's to
            // replay. Not on the narrator's exit: a narration stream can end while the
            // session lives on.
            Effect.sync(() => {
              steers.delete(entry.id);
              deliveries.delete(entry.id);
            }),
            rows.markEnded(entry.targetId, entry.id, reason),
          ),
      },
    );

    /**
     * The first turn or the settle loop of each period still running, so an end can reach
     * the fiber a route does not hold. Separate from {@link sessions}: the turn ends when the
     * session goes idle, and the session does not.
     */
    const turns = new Map<string, Fiber.Fiber<void>>();
    /** Takes a period's fiber out of {@link turns}, only if it is the calling fiber's own. */
    const releaseTurn = (id: string) =>
      Effect.withFiber((fiber) =>
        Effect.sync(() => {
          if (turns.get(id) === fiber) turns.delete(id);
        }),
      );

    /**
     * Every period whose first turn has not yet learned how its open went.
     *
     * **What makes "still opening" visible before the registry publishes anything.** The
     * owner's row is written — and confirmed, so a picker lists it — before the credential
     * and the registration exist. A message in that window waits on this, then asks again.
     * Set the instant the id is given to {@link begin}; released by the first of: the open
     * being known, the turn ending, or `begin` failing before it forked. Releasing twice is a
     * no-op.
     */
    const inFlight = new Map<
      string,
      { readonly targetId: string; readonly known: Deferred.Deferred<void> }
    >();
    const releaseOpening = (id: string) =>
      Effect.suspend(() => {
        const held = inFlight.get(id);
        if (held === undefined) return Effect.void;
        inFlight.delete(id);
        return Deferred.succeed(held.known, undefined);
      });

    /**
     * Which period took over from one whose session this process no longer held. Written
     * **the moment the successor's id is given to {@link begin}**, not once its session has
     * opened, so a dropped request cannot skip it; taken back if that open fails.
     */
    const successors = new Map<string, string>();

    /**
     * Publishes one period's narration under its subject, for as long as the session lives.
     *
     * Forked by the registry into the session's own scope and interrupted **first** on every
     * close, so it needs no lifecycle of its own. **A stream that ends does not end the
     * conversation**: it is logged, and the next message still reaches the session.
     *
     * The narration's last word for this session (A7-Q, from the chat shell's review 2):
     * when the narrator goes, a `connection` `closed` is published, so a chat open on the
     * session learns that its authority ended here, and a docked question hears it is
     * withdrawn. Published under `ensuring`, so an interrupt still sends it.
     */
    const narrate = Effect.fnUntraced(function* (input: {
      readonly harness: AgentHarness["Service"];
      readonly targetId: string;
      readonly id: string;
      readonly sessionId: string;
    }) {
      const subject = binding.subject(input.id);
      const closed = Effect.suspend(() =>
        narrations.publish({
          targetId: input.targetId,
          subject,
          harnessSessionId: input.sessionId,
          entry: {
            type: "bit.connection.closed",
            sequence: undefined,
            at: Date.now(),
            outcome: undefined,
            detail: {
              _tag: "connection",
              state: "closed",
              reason: "this server stopped holding the session",
            },
          },
        }),
      );
      const outcome = yield* Effect.result(
        narrateCoalesced({
          events: input.harness.sessionEvents(input.sessionId),
          publish: (entry) => {
            // The harness took queued messages: they are being worked on, and stay this
            // process's to replay until the transcript holds them. Several taken as one are
            // one turn, and are held saying so (A6 U4 review 3).
            if (entry.detail._tag === "taken") {
              const held = steersOf(input.id);
              const ids = entry.detail.messageIds;
              const together = ids.length > 1 ? [...ids] : undefined;
              for (const id of ids) {
                held.taken.set(id, together);
                const message = held.queued.get(id);
                if (message !== undefined) {
                  held.queued.set(id, tookIt(message, together));
                }
              }
            }
            return narrations.publish({
              targetId: input.targetId,
              subject,
              harnessSessionId: input.sessionId,
              entry,
            });
          },
        }).pipe(Effect.ensuring(closed)),
      );
      if (outcome._tag === "Failure") {
        yield* Effect.logWarning(words.narrationFailed, {
          [binding.role.words.idKey]: input.id,
          sessionId: input.sessionId,
          detail: outcome.failure.message,
        });
      }
    });

    /**
     * Waits for one turn of a period's session to go idle, then lets the owner settle it.
     *
     * **A loop, until no message arrived since its wait began** (A6 U4 review 3). A message
     * delivered while this fiber is finishing finds it still in `turns` and starts no fiber
     * of its own, so this waits again for any message delivered since its wait began, and
     * takes itself out of `turns` in the same synchronous step as its last check.
     */
    const settleTurn = Effect.fnUntraced(function* (
      id: string,
      harness: AgentHarness["Service"],
      sessionId: string,
    ) {
      for (;;) {
        const mark = { delivered: deliveriesTo(id), at: Date.now() };
        const more = () => deliveriesTo(id) !== mark.delivered;
        const settled = yield* Effect.result(harness.waitForIdle(sessionId));
        // Idle: whatever was delivered before the wait began has been taken. A message
        // delivered after may have arrived after the idle point, and is the next pass's.
        for (const [messageId, message] of steers.get(id)?.queued ?? []) {
          if (message.acceptedAt <= mark.at) {
            steers.get(id)?.queued.delete(messageId);
          }
        }
        const ended = settled._tag === "Failure";
        if (!ended && more()) continue;
        const answer = yield* hooks.idle({
          id,
          harness,
          sessionId,
          failure: settled._tag === "Failure" ? settled.failure : undefined,
          more: () => !ended && more(),
        });
        if (answer === "stop") return;
        if (answer === "again") continue;
        // The last check and the release in one synchronous step.
        const done = yield* Effect.withFiber((fiber) =>
          Effect.sync(() => {
            if (!ended && more()) return false;
            if (turns.get(id) === fiber) turns.delete(id);
            return true;
          }),
        );
        if (done) return;
        // Delivered between the settle and the check: the period is working again.
        yield* hooks.resumed(id);
      }
    });

    /**
     * One period's first turn: open the session through the registry, tell whoever waits,
     * then settle it. **When this returns the session is still open.**
     */
    const run = Effect.fnUntraced(function* (input: {
      readonly id: string;
      readonly targetId: string;
      readonly plan: Omit<OpenPlan<Meta>, "narrate">;
      readonly opening: ConversationOpening<Meta, Refused> | undefined;
      readonly predecessor: string | undefined;
      readonly failed: (detail: string) => Effect.Effect<void>;
    }) {
      const harness = input.plan.harness;
      const opened = yield* Effect.result(
        sessions.open<
          LiveAgentSession<Meta> | undefined,
          LiveSessionOpenFailure,
          never
        >({
          id: input.id,
          // Unreachable: every open mints a fresh id, so nothing can have opened this one
          // first. Answered rather than died on, and without touching a session this run
          // did not open.
          joined: () => Effect.succeed(undefined),
          refuse: (failure) => failure,
          prepare: Effect.succeed({
            ...input.plan,
            narrate: (sessionId: string) =>
              narrate({
                harness,
                targetId: input.targetId,
                id: input.id,
                sessionId,
              }),
          }),
          opened: (entry) => Effect.succeed(entry),
        }),
      );

      // A successor that could not open is not one: the next message to the period it was
      // to replace reopens from there, under the id the operator knows.
      if (
        (opened._tag === "Failure" || opened.success === undefined) &&
        input.predecessor !== undefined &&
        successors.get(input.predecessor) === input.id
      ) {
        successors.delete(input.predecessor);
      }
      // The open is known: a message that arrived while it was in flight may now ask again.
      yield* releaseOpening(input.id);
      const alreadyOpen = `${words.what(input.id)} already had a session open in this process, so a second was not opened`;
      if (input.opening !== undefined) {
        yield* opened._tag === "Failure"
          ? Deferred.fail(input.opening, binding.openRefused(opened.failure))
          : opened.success === undefined
            ? Deferred.fail(
                input.opening,
                binding.refused("store_unavailable", alreadyOpen),
              )
            : Deferred.succeed(input.opening, opened.success);
      }
      if (opened._tag === "Failure" || opened.success === undefined) {
        const detail =
          opened._tag === "Failure" ? opened.failure.message : alreadyOpen;
        yield* input.failed(detail);
        // `open_failed` unless the registry already recorded `refused` for a prompt the
        // harness would not take: the first end wins.
        if (opened._tag === "Failure") {
          yield* rows.markEnded(input.targetId, input.id, "open_failed");
        }
        return;
      }
      yield* settleTurn(input.id, harness, opened.success.sessionId);
    });

    const begin: Conversations<Meta, NotFound, Refused, Accepted>["begin"] = (
      input,
    ) =>
      Effect.gen(function* () {
        /*
         * Still opening, from this instant, and the old id's successor — written here
         * rather than once the session opens, so a caller that stops waiting cannot lose
         * it. Both synchronous with the id existing.
         */
        yield* Effect.sync(() => {
          inFlight.set(input.id, {
            targetId: input.targetId,
            known: Deferred.makeUnsafe<void>(),
          });
          if (input.predecessor !== undefined) {
            successors.set(input.predecessor, input.id);
          }
        });
        const fiber = yield* Effect.gen(function* () {
          yield* input.before;
          // Forked into the owner's scope, so the caller answers without it; its exit
          // closes nothing — the session's scope is the registry's.
          return yield* Effect.forkIn(
            run({
              id: input.id,
              targetId: input.targetId,
              plan: input.plan,
              opening: input.opening,
              predecessor: input.predecessor,
              failed: input.failed,
            }).pipe(
              Effect.ensuring(releaseTurn(input.id)),
              Effect.ensuring(releaseOpening(input.id)),
              // A turn stopped before its open was known still answers whoever is waiting
              // on it. A no-op when the open already completed the deferred.
              Effect.ensuring(
                input.opening === undefined
                  ? Effect.void
                  : Deferred.fail(
                      input.opening,
                      binding.refused(
                        "ended",
                        words.stoppedBeforeOpen(input.id),
                      ),
                    ),
              ),
            ),
            own,
          );
        }).pipe(
          // Failed or interrupted before the turn existed — a dropped request lands here —
          // so nothing will learn how an open went: release whoever waits, and take back a
          // successor link to a period that will never open.
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : Effect.andThen(
                  Effect.sync(() => {
                    if (
                      input.predecessor !== undefined &&
                      successors.get(input.predecessor) === input.id
                    ) {
                      successors.delete(input.predecessor);
                    }
                  }),
                  releaseOpening(input.id),
                ),
          ),
        );
        turns.set(input.id, fiber);
      });

    const acceptedOf: Conversations<
      Meta,
      NotFound,
      Refused,
      Accepted
    >["acceptedOf"] = (
      entry,
      conversation,
      note,
      messageId,
      attachments = entry.openedWith,
    ) => ({
      targetId: entry.targetId,
      conversationId: entry.id,
      harnessSessionId: entry.sessionId,
      harnessInstanceId: entry.instanceId,
      model: entry.model,
      conversation,
      note,
      acceptedAt: Date.now(),
      ...(messageId === undefined ? {} : { messageId }),
      ...(attachments.length === 0
        ? {}
        : { attachments: attachments.map(attachmentView) }),
    });

    /**
     * Gives one message to a period whose session is live and preambled: the registry's
     * `deliver`, a steer at the operator's urgency, under the **same** id. The owner widens
     * what it widens first ({@link ConversationBinding.hooks}), and the period is marked
     * working again with a settle loop, unless one is already waiting.
     */
    const deliverTurn = Effect.fnUntraced(function* (
      entry: LiveAgentSession<Meta>,
      text: string,
      urgency: SteerUrgency,
      uploads?: readonly ReadUpload[],
    ) {
      const extra = yield* hooks.delivering(entry, text);
      const delivered = yield* Effect.result(
        sessions.deliver(
          entry,
          binding.followUp(entry.meta, text),
          urgency,
          uploads,
        ),
      );
      if (
        delivered._tag === "Failure" &&
        delivered.failure._tag === "UploadWriteFailed"
      ) {
        // Nothing was asked of the harness, so the session is kept.
        return yield* Effect.fail(
          binding.refused(
            "upload_unwritable",
            words.unwritable(delivered.failure.message),
          ),
        );
      }
      if (delivered._tag === "Failure") {
        return yield* Effect.fail(
          binding.refused(
            "harness_unreachable",
            words.undelivered(delivered.failure.message),
          ),
        );
      }
      const base = acceptedOf(
        entry,
        "continued",
        "",
        delivered.success.messageId,
        delivered.success.attachments,
      );
      /*
       * Held until the transcript has it, marked taken if the take came first. Only while
       * this process still holds this very session: a close that ran while the message was
       * out has already dropped the session's held messages. No yield from this check to
       * the write, so a close cannot land between them.
       */
      if (sessions.get(entry.id) === entry) {
        const held = steersOf(entry.id);
        const waiting: ConversationQueuedMessage = {
          messageId: delivered.success.messageId,
          text: truncateNarration(text),
          acceptedAt: base.acceptedAt,
          taken: false,
        };
        held.queued.set(
          delivered.success.messageId,
          held.taken.has(delivered.success.messageId)
            ? tookIt(waiting, held.taken.get(delivered.success.messageId))
            : waiting,
        );
      }
      // Counted before the period is marked working, so a settling fiber still in `turns`
      // sees it on its next check.
      deliveries.set(entry.id, deliveriesTo(entry.id) + 1);
      if ((yield* hooks.resumed(entry.id)) && !turns.has(entry.id)) {
        const fiber = yield* Effect.forkIn(
          settleTurn(entry.id, entry.harness, entry.sessionId).pipe(
            Effect.ensuring(releaseTurn(entry.id)),
          ),
          own,
        );
        turns.set(entry.id, fiber);
      }
      return binding.accepted(base, extra);
    });

    /**
     * One permit per dead period id, held while a fresh session is opened in its place: the
     * registry's per-id permit does not cover this, since the fresh session is opened under
     * a **new** id. The successor is re-read inside it.
     */
    const reopening = new Map<string, Semaphore.Semaphore>();
    const reopenLock = (id: string): Semaphore.Semaphore => {
      const held = reopening.get(id);
      if (held !== undefined) return held;
      const made = Semaphore.makeUnsafe(1);
      reopening.set(id, made);
      return made;
    };

    /**
     * The row a message to a period acts on, refused when there is nothing to say it to:
     * unknown on this target, or ended by the operator.
     */
    const recorded = (input: {
      readonly targetId: string;
      readonly conversationId: string;
    }) =>
      Effect.gen(function* () {
        const row = yield* rows
          .read(input.targetId, input.conversationId)
          .pipe(Effect.mapError(binding.openRefused));
        if (row === undefined || row.targetId !== input.targetId) {
          return yield* Effect.fail(
            binding.notFound(
              input.targetId,
              input.conversationId,
              "there is no session to say this to",
            ),
          );
        }
        // The one end that is final.
        if (row.endedReason === "operator") {
          return yield* Effect.fail(
            binding.refused("ended", words.ended(input.conversationId)),
          );
        }
        return row;
      });

    const send: Conversations<Meta, NotFound, Refused, Accepted>["send"] = (
      input,
    ) =>
      Effect.gen(function* () {
        const urgency = input.urgency ?? "queued";
        // The fast path: live, preambled, and this target's.
        const live = sessions.ready(input.conversationId);
        if (live !== undefined && live.targetId === input.targetId) {
          return yield* deliverTurn(live, input.text, urgency, input.uploads);
        }
        // Still opening: wait until the open is known, then ask again.
        const opening = inFlight.get(input.conversationId);
        if (opening !== undefined && opening.targetId === input.targetId) {
          yield* Deferred.await(opening.known);
          return yield* send(input);
        }
        const addressed = yield* recorded(input);
        const newest = newerRun(input.conversationId, addressed);
        if (newest !== undefined) {
          return yield* send({ ...input, conversationId: newest });
        }
        /*
         * Published but not yet preambled: join it, under the registry's permit. `prepare`
         * refuses rather than builds, because **nothing is ever built under a period id that
         * has been opened before**. A joiner that finds the opener's session gone falls
         * through to the reopen below.
         */
        if (sessions.get(input.conversationId) !== undefined) {
          const joined = yield* Effect.result(
            sessions.open<Accepted, Refused | typeof NOT_LIVE, never>({
              id: input.conversationId,
              joined: (entry) =>
                deliverTurn(entry, input.text, urgency, input.uploads),
              prepare: Effect.fail(NOT_LIVE),
              refuse: binding.openRefused,
              opened: () => Effect.fail(NOT_LIVE),
            }),
          );
          if (joined._tag === "Success") return joined.success;
          const failure = joined.failure;
          if (
            typeof failure !== "object" ||
            failure === null ||
            !("_tag" in failure) ||
            failure._tag !== "NotLive"
          ) {
            return yield* Effect.fail(failure as Refused);
          }
        }
        // Not live in this process and not ended by the operator: a fresh period, under a
        // **new** id, by the owner's reopen plan.
        return yield* Semaphore.withPermit(reopenLock(input.conversationId))(
          Effect.gen(function* () {
            const successor = successors.get(input.conversationId);
            if (successor !== undefined) {
              return yield* send({ ...input, conversationId: successor });
            }
            // The row again, inside the permit: a switch writes it under this same permit.
            const row = yield* recorded(input);
            const newer = newerRun(input.conversationId, row);
            if (newer !== undefined) {
              return yield* send({ ...input, conversationId: newer });
            }
            return yield* binding.reopen({ send: input, row });
          }),
        );
      });

    /** Question ids read back from a transcript that the operator put away (A7-Q). */
    // V2(chat): a restart forgets them, so a question the operator dismissed after its
    // request was already gone is offered again (as a message) until they write again.
    // Proper V2 keeps the dismissal beside the period's row.
    const putAway = new Map<string, Set<string>>();

    /**
     * The question a replay offers (A7-Q): the newest one the harness is still waiting on,
     * as `live`, when this process holds the session; otherwise what the transcript ends on,
     * unless the operator put it away.
     */
    const questionNow = Effect.fnUntraced(function* (
      id: string,
      held: LiveAgentSession<Meta> | undefined,
      fromTranscript: PendingQuestion | null,
    ) {
      if (held !== undefined) {
        const asked = yield* Effect.result(
          held.harness.pendingQuestions(held.sessionId),
        );
        const newest =
          asked._tag === "Success" ? asked.success.at(-1) : undefined;
        if (newest !== undefined) {
          return pendingQuestionView({
            question: newest,
            harnessSessionId: held.sessionId,
            subject: binding.questionSubject(id),
            answerability: "live",
          });
        }
      }
      if (fromTranscript === null) return null;
      return putAway
        .get(fromTranscript.harnessSessionId)
        ?.has(fromTranscript.questionId) === true
        ? null
        : fromTranscript;
    });

    const replay: Conversations<Meta, NotFound, Refused, Accepted>["replay"] = (
      input,
    ) =>
      Effect.gen(function* () {
        const held = sessions.get(input.id);
        // What this process holds, read **before** the transcript (A6 U4 review 2).
        const pending = [...(steers.get(input.id)?.queued.values() ?? [])];
        let written: ReadonlySet<string> = new Set();
        const view = yield* input.read(held, (ids) => {
          written = ids;
        });
        // A message a read has found written is no longer this process's to hold (review 3).
        if (view.live) {
          const holding = steers.get(input.id)?.queued;
          for (const id of written) holding?.delete(id);
        }
        return {
          view,
          queued: view.live
            ? pending
                .filter((message) => !written.has(message.messageId))
                .sort((left, right) => left.acceptedAt - right.acceptedAt)
            : [],
          question: yield* questionNow(
            input.id,
            held,
            input.fromTranscript(view),
          ),
        };
      });

    /**
     * The period holding the session now, from `from`: whatever this process has opened
     * after it. An open still in flight is waited for. The chain only runs forward.
     */
    const holdingNow = Effect.fnUntraced(function* (from: string) {
      let id = from;
      for (;;) {
        const opening = inFlight.get(id);
        if (opening !== undefined) yield* Deferred.await(opening.known);
        const next = successors.get(id);
        if (next === undefined) break;
        id = next;
      }
      return id;
    });

    /** The period ids a switch has claimed (`switchFrom`). */
    const switching = new Set<string>();

    /**
     * The period a switch addressed to `id` lands on, decided under that id's reopen
     * permit — the permit a reopen holds while it reads the row's model, so a switch can
     * never be lost behind a reopen. Claimed before the permit, and refused when another
     * switch holds it: a switch waits for a reopen and never queues behind a switch.
     */
    const switchFrom = (
      id: string,
      input: Parameters<
        Conversations<Meta, NotFound, Refused, Accepted>["switchModel"]
      >[0],
    ): ReturnType<
      Conversations<Meta, NotFound, Refused, Accepted>["switchModel"]
    > =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          if (switching.has(id)) return false;
          switching.add(id);
          return true;
        }),
        (claimed) =>
          claimed
            ? Semaphore.withPermit(reopenLock(id))(
                Effect.gen(function* () {
                  const successor = successors.get(id);
                  if (successor !== undefined) {
                    const following = inFlight.get(successor);
                    if (following !== undefined) {
                      yield* Deferred.await(following.known);
                    }
                    if (successors.get(id) === successor) {
                      return yield* switchFrom(successor, input);
                    }
                  }
                  const row = yield* rows.read(input.targetId, id).pipe(
                    Effect.mapError(
                      (failure) =>
                        new ConversationModelRefused({
                          reason: "store_unavailable",
                          detail: `${words.what(id)}'s record could not be read (${failure.message}), so nothing was switched.`,
                        }),
                    ),
                  );
                  const newer =
                    row === undefined || row.targetId !== input.targetId
                      ? undefined
                      : newerRun(id, row);
                  if (newer !== undefined) {
                    return yield* switchFrom(newer, input);
                  }
                  return yield* switchOne(id, input);
                }),
              )
            : Effect.fail(
                modelSwitchRefusal(
                  { _tag: "ModelSwitchInFlight" },
                  { what: words.what(id), model: input.model, previous: null },
                ),
              ),
        (claimed) =>
          claimed
            ? Effect.sync(() => {
                switching.delete(id);
              })
            : Effect.void,
      );

    /** One period's switch, once {@link switchFrom} has decided it is this one. */
    const switchOne = Effect.fn("Conversations.switchOne")(function* (
      id: string,
      input: Parameters<
        Conversations<Meta, NotFound, Refused, Accepted>["switchModel"]
      >[0],
    ) {
      // Still opening: wait until the open is known, as a message does.
      const opening = inFlight.get(id);
      if (opening !== undefined && opening.targetId === input.targetId) {
        yield* Deferred.await(opening.known);
      }
      const what = words.what(id);
      const decided: {
        previous: string | null;
        answer:
          | {
              readonly checked: CheckedModelSwitch;
              readonly changed: boolean;
            }
          | undefined;
      } = { previous: null, answer: undefined };
      const applied = yield* Effect.result(
        sessions.switchModel({
          id,
          prepare: Effect.gen(function* () {
            const row = yield* rows.read(input.targetId, id).pipe(
              Effect.mapError(
                (failure) =>
                  new ConversationModelRefused({
                    reason: "store_unavailable",
                    detail: `${what}'s record could not be read (${failure.message}), so nothing was switched.`,
                  }),
              ),
            );
            if (row === undefined || row.targetId !== input.targetId) {
              return yield* Effect.fail(
                binding.notFound(
                  input.targetId,
                  input.conversationId,
                  "there is no session to switch",
                ),
              );
            }
            if (row.endedReason === "operator") {
              return yield* new ConversationModelRefused({
                reason: "conversation_ended",
                detail: `${what} was ended by the operator, so nothing will run on it again and there is no model to switch. Start a new session to carry on.`,
              });
            }
            if (row.harnessInstanceId === null) {
              return yield* new ConversationModelRefused({
                reason: "no_session",
                detail: `${what} was recorded before its harness instance was, so there is no pinned harness to switch within.`,
              });
            }
            decided.previous = row.model;
            const checked = yield* checkModelSwitch({
              resolver,
              instanceId: row.harnessInstanceId,
              model: input.model,
              requested: input.modelOptions,
              what,
            });
            const changed = !sameModelChoice(row, checked);
            decided.answer = { checked, changed };
            return {
              instanceId: checked.instanceId,
              model: checked.model,
              options: checked.options,
              meta: (meta: Meta) => meta,
              record: (entry: LiveAgentSession<Meta> | undefined) =>
                Effect.gen(function* () {
                  if (entry !== undefined) {
                    yield* hooks.switched(id, checked.model);
                  }
                  if (!changed) return;
                  yield* rows
                    .recordModel(input.targetId, {
                      id,
                      model: checked.model,
                      modelOptions: checked.options,
                    })
                    .pipe(
                      Effect.mapError((failure) =>
                        recordRefusal({
                          what,
                          model: checked.model,
                          harnessMoved: entry !== undefined,
                          detail: failure.message,
                        }),
                      ),
                      // Nothing written is not a switch recorded.
                      Effect.flatMap((written) =>
                        written
                          ? Effect.void
                          : Effect.fail(
                              recordRefusal({
                                what,
                                model: checked.model,
                                harnessMoved: entry !== undefined,
                                detail: `this target's file no longer holds ${what}'s record`,
                              }),
                            ),
                      ),
                    );
                }),
            };
          }),
        }),
      );
      if (applied._tag === "Failure") {
        const failure = applied.failure;
        if (
          typeof failure === "object" &&
          failure !== null &&
          "_tag" in failure &&
          (failure._tag === "ModelSwitchInFlight" ||
            failure._tag === "ModelSwitchUncertain" ||
            failure._tag === "ModelSwitchStale")
        ) {
          return yield* Effect.fail(
            modelSwitchRefusal(
              failure as Parameters<typeof modelSwitchRefusal>[0],
              { what, model: input.model, previous: decided.previous },
            ),
          );
        }
        return yield* Effect.fail(
          failure as ConversationModelRefused | NotFound,
        );
      }
      const answer = decided.answer;
      if (answer === undefined) {
        // Unreachable: a switch that succeeded ran `prepare`.
        return yield* new ConversationModelRefused({
          reason: "store_unavailable",
          detail: `${what}'s switch answered without a plan, so nothing is known to have changed.`,
        });
      }
      return modelSwitched({
        conversationId: id,
        checked: answer.checked,
        applied: applied.success,
        changed: answer.changed,
      });
    });

    /**
     * The row of a period addressed for a read or a control, checked against the target,
     * and the period holding the session now. `refused` turns a store failure into the
     * route's own refusal; `clause` finishes the 404's sentence.
     */
    const addressedNow = <E>(
      input: { readonly targetId: string; readonly conversationId: string },
      refused: (detail: string) => E,
      clause: string,
    ) =>
      Effect.gen(function* () {
        const row = yield* rows
          .read(input.targetId, input.conversationId)
          .pipe(
            Effect.mapError((failure) =>
              refused(
                `${words.what(input.conversationId)}'s record could not be read (${failure.message})`,
              ),
            ),
          );
        if (row === undefined || row.targetId !== input.targetId) {
          return yield* Effect.fail(
            binding.notFound(input.targetId, input.conversationId, clause),
          );
        }
        const id = yield* holdingNow(
          newerRun(input.conversationId, row) ?? input.conversationId,
        );
        return { row, id };
      });

    const activity: Conversations<
      Meta,
      NotFound,
      Refused,
      Accepted
    >["activity"] = Effect.fn("Conversations.activity")(function* (input) {
      const read = yield* Effect.result(
        rows.read(input.targetId, input.conversationId),
      );
      if (read._tag === "Failure") {
        yield* Effect.logWarning(
          `${words.what(input.conversationId)}'s record could not be read for its activity; answering for the period addressed`,
          {
            [binding.role.words.idKey]: input.conversationId,
            detail: read.failure.message,
          },
        );
      }
      const row = read._tag === "Success" ? read.success : undefined;
      if (
        read._tag === "Success" &&
        (row === undefined || row.targetId !== input.targetId)
      ) {
        return yield* Effect.fail(
          binding.notFound(
            input.targetId,
            input.conversationId,
            "nothing of it is running",
          ),
        );
      }
      const id = yield* holdingNow(
        (row === undefined ? undefined : newerRun(input.conversationId, row)) ??
          input.conversationId,
      );
      const found = yield* sessions.status(id);
      if (found._tag === "not_live") {
        return { conversationId: id, turn: "not_live", background: false };
      }
      // Running while the owner's view says so too, so a screen reading both never sees
      // a list call a turn running that this calls over.
      const also = yield* hooks.alsoRunning(id);
      return {
        conversationId: id,
        turn: found.running || also ? "running" : "idle",
        background: found.background,
      };
    });

    const context: Conversations<Meta, NotFound, Refused, Accepted>["context"] =
      Effect.fn("Conversations.context")(function* (input) {
        const readRow = (id: string) =>
          Effect.result(rows.read(input.targetId, id));
        const read = yield* readRow(input.conversationId);
        const addressed = read._tag === "Success" ? read.success : undefined;
        if (
          read._tag === "Success" &&
          (addressed === undefined || addressed.targetId !== input.targetId)
        ) {
          return yield* Effect.fail(
            binding.notFound(
              input.targetId,
              input.conversationId,
              "there is no context to measure",
            ),
          );
        }
        const id = yield* holdingNow(
          (addressed === undefined
            ? undefined
            : newerRun(input.conversationId, addressed)) ??
            input.conversationId,
        );
        // The successor's own row: its harness session and model are the conversation's now.
        const row =
          id === input.conversationId
            ? addressed
            : yield* Effect.map(readRow(id), (again) =>
                again._tag === "Success" &&
                again.success?.targetId === input.targetId
                  ? again.success
                  : addressed,
              );
        // Stamped once the harness has answered, not when it was asked (A6 U9 review).
        const unread = (model: string) =>
          Effect.map(
            Clock.currentTimeMillis,
            (measuredAt): ConversationContext => ({
              conversationId: id,
              model,
              used: null,
              usedModel: null,
              window: null,
              reading: "unread",
              breakdown: { _tag: "none", reason: "unanswered" },
              measuredAt,
            }),
          );
        if (row === undefined) return yield* unread("");
        const answered = yield* Effect.result(
          Effect.flatMap(
            resolver.resolve(row.harnessInstanceId ?? undefined),
            ({ harness }) =>
              harness.contextUsage(row.harnessSessionId, {
                model: row.model,
                breakdown: input.breakdown,
              }),
          ),
        );
        if (answered._tag === "Failure") {
          yield* Effect.logDebug(
            `${words.what(id)}'s harness could not report its context; answering unread`,
            {
              [binding.role.words.idKey]: id,
              detail: answered.failure.message,
            },
          );
          return yield* unread(row.model);
        }
        const { model, ...usage } = answered.success;
        return {
          conversationId: id,
          model: model ?? row.model,
          ...usage,
          measuredAt: yield* Clock.currentTimeMillis,
        };
      });

    const notWaiting = (questionId: string): QuestionRefused =>
      new QuestionRefused({
        questionId,
        reason: "settled",
        detail:
          "The agent is no longer waiting on these questions: they were answered or dismissed, a Stop withdrew them, or the session was let go. Send your answers as a message instead.",
      });

    /** A harness's refusal of an answer or dismissal, as the route's. */
    const questionRefusal =
      (questionId: string, how: "answer" | "dismiss") =>
      (failure: HarnessFailure | QuestionNotPending): QuestionRefused =>
        failure._tag === "QuestionNotPending"
          ? failure.reason === "settled"
            ? notWaiting(questionId)
            : new QuestionRefused({
                questionId,
                reason: failure.reason,
                detail: failure.detail,
              })
          : new QuestionRefused({
              questionId,
              reason: "harness_unreachable",
              detail:
                how === "answer"
                  ? `the harness did not answer (${failure.message}), so whether it took this is not known. Your answers are kept; try again.`
                  : `the harness did not answer (${failure.message}), so whether the agent was told you declined is not known.`,
            });

    /** The row and the session a question is addressed through, as a Stop finds them. */
    const questionSession = (
      input: {
        readonly targetId: string;
        readonly conversationId: string;
        readonly questionId: string;
      },
      how: "answer" | "dismiss",
    ) =>
      Effect.map(
        addressedNow(
          input,
          (detail) =>
            new QuestionRefused({
              questionId: input.questionId,
              reason: "harness_unreachable",
              detail: `${detail}, so the question was not ${how === "answer" ? "answered" : "dismissed"}.`,
            }),
          "there is no question to answer",
        ),
        ({ row, id }) => ({
          harnessSessionId: row.harnessSessionId,
          held: sessions.get(id),
        }),
      );

    const answerQuestion: Conversations<
      Meta,
      NotFound,
      Refused,
      Accepted
    >["answerQuestion"] = Effect.fn("Conversations.answerQuestion")(
      function* (input) {
        const { held } = yield* questionSession(input, "answer");
        if (held === undefined) return yield* notWaiting(input.questionId);
        const asked = yield* held.harness
          .pendingQuestions(held.sessionId)
          .pipe(Effect.mapError(questionRefusal(input.questionId, "answer")));
        const question = asked.find(
          (candidate) => candidate.questionId === input.questionId,
        );
        if (question === undefined) return yield* notWaiting(input.questionId);
        const problem = questionAnswersProblem(question.fields, input.answers);
        if (problem !== null) {
          return yield* new QuestionRefused({
            questionId: input.questionId,
            reason: "invalid",
            detail: problem,
          });
        }
        yield* held.harness
          .answerQuestion(held.sessionId, input.questionId, input.answers)
          .pipe(Effect.mapError(questionRefusal(input.questionId, "answer")));
        return { questionId: input.questionId, settled: "answered" as const };
      },
    );

    /** The questions being asked after now (`recheckQuestion`), by session and id. */
    const rechecking = new Set<string>();

    /**
     * Asks the harness again, in the background, whether a question whose dismissal it did
     * not answer still waits, and says what it finds on the session's live stream (A7-Q
     * review 2): still listed is a `question` again; not listed, a `questionSettled`
     * (`withdrawn`). Forked into the session's scope, so its end interrupts this; one per
     * question at a time.
     *
     * V2(chat): the window is fixed. A harness paused for longer is found again only by a
     * reload's replay (or the operator writing, which the form then holds).
     */
    const recheckQuestion = (
      held: LiveAgentSession<Meta>,
      targetId: string,
      questionId: string,
    ) => {
      const key = `${held.sessionId}\u0000${questionId}`;
      // Said only while this server still holds the session (A7-S review 1).
      const say = (detail: HarnessNarration["detail"]) =>
        Effect.suspend(() =>
          sessions.get(held.id)?.scope !== held.scope
            ? Effect.logDebug(
                "a question re-checked after its session was let go of is not said again",
                { [binding.role.words.idKey]: held.id, questionId },
              )
            : narrations.publish({
                targetId,
                subject: binding.subject(held.id),
                harnessSessionId: held.sessionId,
                entry: {
                  type: "bit.question.rechecked",
                  sequence: undefined,
                  at: Date.now(),
                  outcome: undefined,
                  detail,
                },
              }),
        );
      const found = (asked: readonly HarnessQuestion[]) => {
        const question = asked.find(
          (candidate) => candidate.questionId === questionId,
        );
        return question !== undefined
          ? say({ _tag: "question", question })
          : say({
              _tag: "questionSettled",
              questionId,
              settled: "withdrawn",
            });
      };
      const asking = Effect.suspend(() => {
        if (rechecking.has(key)) return Effect.void;
        rechecking.add(key);
        return Effect.sleep(recheck.first).pipe(
          Effect.andThen(held.harness.pendingQuestions(held.sessionId)),
          Effect.retry(
            Schedule.min([
              Schedule.exponential(recheck.first, 2),
              Schedule.spaced(recheck.most),
            ]).pipe(Schedule.upTo({ duration: recheck.window })),
          ),
          Effect.flatMap(found),
          Effect.catch((failure) =>
            Effect.logWarning(
              "a question whose dismissal the harness did not answer could not be read back; the page says to reload to check",
              {
                [binding.role.words.idKey]: held.id,
                questionId,
                detail: failure.message,
              },
            ),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              rechecking.delete(key);
            }),
          ),
        );
      });
      return Effect.asVoid(Effect.forkIn(asking, held.scope));
    };

    const dismissQuestion: Conversations<
      Meta,
      NotFound,
      Refused,
      Accepted
    >["dismissQuestion"] = Effect.fn("Conversations.dismissQuestion")(
      function* (input) {
        const { harnessSessionId, held } = yield* questionSession(
          input,
          "dismiss",
        );
        // Read back from a transcript: nothing native to cancel, so it is put away.
        if (input.questionId.startsWith(transcriptQuestionId(""))) {
          const set = putAway.get(harnessSessionId) ?? new Set<string>();
          set.add(input.questionId);
          putAway.set(harnessSessionId, set);
          return {
            questionId: input.questionId,
            settled: "dismissed" as const,
          };
        }
        if (held === undefined) return yield* notWaiting(input.questionId);
        yield* held.harness
          .dismissQuestion(held.sessionId, input.questionId)
          .pipe(
            Effect.mapError(questionRefusal(input.questionId, "dismiss")),
            // Not told, perhaps: asked again until it is known.
            Effect.tapError((refusal) =>
              refusal.reason === "harness_unreachable"
                ? recheckQuestion(held, input.targetId, input.questionId)
                : Effect.void,
            ),
          );
        return { questionId: input.questionId, settled: "dismissed" as const };
      },
    );

    const stopTurn: Conversations<
      Meta,
      NotFound,
      Refused,
      Accepted
    >["stopTurn"] = Effect.fn("Conversations.stopTurn")(function* (input) {
      const { id } = yield* addressedNow(
        input,
        (detail) =>
          new ConversationStopRefused({
            reason: "store_unavailable",
            detail: `${detail}, so nothing was stopped.`,
          }),
        "there is no turn to stop",
      );
      // Named as the operator sees it from its own chat, never by its id (A6 U6 review).
      const what = "this session";
      const found = yield* sessions
        .interrupt(id)
        .pipe(Effect.mapError((failure) => turnStopRefusal(failure, what)));
      return turnStopped({ found, conversationId: id, what });
    });

    /** The period holding the session now, for a sub-agent's Stop, as a Stop finds it. */
    const subagentSession = (input: {
      readonly targetId: string;
      readonly conversationId: string;
    }) =>
      Effect.map(
        addressedNow(
          input,
          (detail) =>
            new SubagentStopRefused({
              reason: "store_unavailable",
              detail: `${detail}, so nothing was stopped.`,
            }),
          "there is no sub-agent to stop",
        ),
        ({ id }) => ({ id, held: sessions.get(id) }),
      );

    const stopSubagent: Conversations<
      Meta,
      NotFound,
      Refused,
      Accepted
    >["stopSubagent"] = Effect.fn("Conversations.stopSubagent")(
      function* (input) {
        const { id, held } = yield* subagentSession(input);
        if (held === undefined) {
          return yield* new SubagentStopRefused({
            reason: "not_live",
            detail:
              "This server does not hold the session now, so it cannot reach the sub-agent. Reload the page to see where it stands.",
          });
        }
        const answer = yield* held.harness
          .stopSubagent(held.sessionId, input.callId)
          .pipe(
            Effect.mapError(
              (failure) =>
                new SubagentStopRefused({
                  reason: "harness_unreachable",
                  detail: `The harness did not answer the Stop (${failure.message}), so whether the sub-agent stopped is not known.`,
                }),
            ),
          );
        if (answer === "not_stoppable") {
          return yield* new SubagentStopRefused({
            reason: "not_stoppable",
            detail: `This sub-agent runs inside the ${words.agent}'s turn: Stop the turn to stop it.`,
          });
        }
        if (answer === "not_running") {
          return yield* new SubagentStopRefused({
            reason: "not_running",
            detail:
              "The sub-agent is no longer running, or this session did not start it.",
          });
        }
        return {
          conversationId: id,
          callId: input.callId,
          detail: `The sub-agent was stopped. The harness tells the ${words.agent}, which may answer about it.`,
        };
      },
    );

    const stopAll: Conversations<Meta, NotFound, Refused, Accepted>["stopAll"] =
      Effect.fn("Conversations.stopAll")(function* (input) {
        const found = yield* subagentSession(input).pipe(
          Effect.mapError((failure) =>
            failure instanceof SubagentStopRefused
              ? new ConversationStopRefused({
                  reason: "store_unavailable",
                  detail: failure.detail,
                })
              : failure,
          ),
        );
        const children =
          found.held === undefined
            ? undefined
            : yield* Effect.result(
                found.held.harness.stopSubagents(found.held.sessionId),
              );
        const stopped = yield* stopTurn(input);
        if (children?._tag === "Failure") {
          return yield* new ConversationStopRefused({
            reason: "harness_unreachable",
            detail: `${stopped.detail} The harness did not answer a sub-agent's Stop (${children.failure.message}), so it may still be running.`,
          });
        }
        return stopped;
      });

    const end: Conversations<Meta, NotFound, Refused, Accepted>["end"] = (
      targetId,
      id,
    ) =>
      Effect.gen(function* () {
        const entry = sessions.get(id);
        const turn = turns.get(id);
        if (entry === undefined && turn === undefined) return false;
        // The credential first, so a session mid-call finds its next call refused.
        yield* binding.role.revokeStray(id);
        // Recorded as the operator's **here**, after the revoke and before anything is
        // interrupted: interrupting a first turn still opening makes the registry close it
        // as `open_failed`, and the first recorded end wins.
        yield* rows.markEnded(targetId, id, "operator");
        // No interrupt first: the close ends the harness session, which stops the turn and
        // drops anything queued behind it, where an interrupt would let Claude Code go on
        // to a queued message after the operator had ended the conversation.
        if (turn !== undefined) yield* Fiber.interrupt(turn);
        yield* sessions.close(id, "operator");
        return true;
      });

    const switchModel: Conversations<
      Meta,
      NotFound,
      Refused,
      Accepted
    >["switchModel"] = (input) => switchFrom(input.conversationId, input);

    return {
      sessions,
      begin,
      acceptedOf,
      send,
      replay,
      end,
      stopTurn,
      stopSubagent,
      stopAll,
      answerQuestion,
      dismissQuestion,
      activity,
      context,
      switchModel,
      holds: (id) => Effect.sync(() => sessions.get(id) !== undefined),
      heldSteers: (id) => Effect.sync(() => steers.get(id)?.queued.size ?? 0),
      turning: (id) => turns.has(id),
      turnOf: (id) => turns.get(id),
    };
  });
