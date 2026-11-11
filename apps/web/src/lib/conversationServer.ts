/**
 * A chat's way to the server, for any owner (A6 chat generalisation, slice 2): the
 * {@link ConversationServer} a {@link ConversationSessions} posts through, built from an
 * owner's endpoints and the app's hooks.
 *
 * It was the importer's adapter in `app.svelte.ts`. What it does is the same for every
 * owner, so it is here once:
 *
 * - **An expired session signs out**, on every call.
 * - **A refusal is the server's sentence**, or the call's fallback, and a refusal that the
 *   period was ended (the owner's `ended` reason) says so, so the list is read again.
 * - **No answer is not a refusal**: `unanswered`, because the server may have taken the
 *   message before the answer was lost.
 * - **A `lost` notice is forgotten when it is over** (U13 review 6): a message that opened or
 *   resumed a period starts a new narration stream, so the notice about the period it was
 *   sent to and the one it landed in both go; so does one about a period the replay says was
 *   ended.
 * - **The turn watch** polls the owner's activity until nothing runs.
 *
 * What an owner supplies is {@link ConversationEndpoints}: thin calls to `client.ts`, its
 * accepted message as the chat needs it, and its `ended` reason. An ability it leaves out is
 * one the chat does not have (no `context`, no meter).
 */
import type {
  ConversationActivity,
  ConversationContext,
  ConversationModelDraft,
  ConversationModelSwitched,
  ConversationStopped,
  ModelOptionSelection,
  QuestionAnswers,
  QuestionSettled,
  SteerUrgency,
  SubagentStopped,
} from "@bit/contracts";

import type { Call } from "./client";
import type { ConversationReplayView } from "./conversationChat";
import type { ParkedMessages } from "./conversationParked";
import type {
  ConversationActivityState,
  ConversationQuestionAnswer,
  ConversationSent,
  ConversationServer,
  ConversationTurnAccepted,
} from "./conversationSessions.svelte";

/** How often the turn watch asks what is running, in ms. */
export const TURN_POLL_MS = 900;

/** What the app lends every chat's server: its session, its clock, its lists. */
export interface ConversationAppHooks {
  /** The browser session expired: sign out. */
  readonly signOut: () => void;
  /** A refusal's own sentence, or `fallback`. */
  readonly refusalText: (error: object, fallback: string) => string;
  /** Something the Agent sessions list counts moved: read it again. */
  readonly moved: () => void;
  /** Forget what the server last said about one period's narration connection. */
  readonly forgetConnection: (conversationId: string) => void;
  /** The highest activity publish order this tab has seen, or `0`. */
  readonly highWater: () => number;
  /** Read the owner's session list again. */
  readonly reread: () => Promise<void>;
  /** Resolves after `ms`: the app's countdown, so a test decides when it is up. */
  readonly wait: (ms: number) => Promise<void>;
  /** Calls `then` after `ms`, answering a cancel: the app's countdown. */
  readonly after: (ms: number, then: () => void) => () => void;
  /** This tab's parked words for the owner. */
  readonly parked: {
    readonly read: () => ParkedMessages;
    readonly write: (parked: ParkedMessages) => void;
  };
  readonly harnessName: (instanceId: string) => string;
  readonly harnessDriver: (instanceId: string) => string | undefined;
  /** What a screen calls a model of an instance; the id when absent (`modelNames.ts`). */
  readonly modelName?: (
    instanceId: string | undefined,
    model: string,
  ) => string;
}

/**
 * One owner's routes, as thin calls to `client.ts`, keyed by period id (`conversationId`).
 * `Turn` is the owner's accepted message on the wire (the importer's `ImporterTurnAccepted`).
 */
export interface ConversationEndpoints<Turn> {
  /**
   * Opens a conversation whose first message is `text`, as the agent `agentId` (or the
   * server's default). `modelOptions` is what the opening set its model's options to.
   */
  readonly open: (
    text: string,
    agentId: string | undefined,
    files?: readonly File[],
  ) => Promise<{
    readonly call: Call<Turn, object>;
    readonly modelOptions?: readonly ModelOptionSelection[];
  }>;
  readonly send: (
    conversationId: string,
    text: string,
    urgency?: SteerUrgency,
    files?: readonly File[],
  ) => Promise<Call<Turn, object>>;
  readonly history: (
    conversationId: string,
  ) => Promise<Call<ConversationReplayView, object>>;
  readonly stop: (
    conversationId: string,
  ) => Promise<Call<ConversationStopped, object>>;
  readonly activity: (
    conversationId: string,
  ) => Promise<Call<ConversationActivity, object>>;
  readonly stopAll?: (
    conversationId: string,
  ) => Promise<Call<ConversationStopped, object>>;
  readonly stopSubagent?: (
    conversationId: string,
    callId: string,
  ) => Promise<Call<SubagentStopped, object>>;
  readonly answerQuestion?: (
    conversationId: string,
    questionId: string,
    answers: QuestionAnswers,
  ) => Promise<Call<QuestionSettled, object>>;
  readonly dismissQuestion?: (
    conversationId: string,
    questionId: string,
  ) => Promise<Call<QuestionSettled, object>>;
  readonly switchModel?: (
    conversationId: string,
    draft: ConversationModelDraft,
  ) => Promise<Call<ConversationModelSwitched, object>>;
  readonly context?: (
    conversationId: string,
    breakdown: boolean,
  ) => Promise<Call<ConversationContext, object>>;
  /** The owner's accepted message as the chat needs it. */
  readonly accepted: (turn: Turn) => ConversationTurnAccepted;
  /** The refusal reason that says the period was ended: the importer's `import_ended`. */
  readonly ended: string;
}

/** Whether a refusal is about the message's files (A6 U13): said in the F2 dialog. */
export const isFilesRefusal = (error: object): boolean =>
  "_tag" in error &&
  (error._tag === "MessageUploadRefused" ||
    error._tag === "RequestTooLarge" ||
    (("reason" in error && error.reason === "upload_unwritable") as boolean));

const isUnauthenticated = (error: object): boolean =>
  "_tag" in error && error._tag === "Unauthenticated";

/** Builds an owner's {@link ConversationServer}. */
export const conversationServer = <Turn>(
  app: ConversationAppHooks,
  endpoints: ConversationEndpoints<Turn>,
): ConversationServer => {
  const refusedOf = (error: object): void => {
    if (isUnauthenticated(error)) app.signOut();
  };
  const answer = (
    call: Call<Turn, object>,
    /** The period the message was addressed to, for a follow-up; absent for an opening. */
    addressed?: string,
  ): ConversationSent => {
    // A message opens a session, or reopens one this server had let go (A7 U8b review).
    app.moved();
    if (call._tag === "Ok") {
      const turn = endpoints.accepted(call.value);
      // Opened or resumed: a new narration stream, which has not broken (U13 review 6). The
      // notice standing is the one about the period the message was sent to: a resume or a
      // reopen answers with a **new** period id, so both go (chat shell review 2).
      if (turn.conversation !== "continued") {
        if (addressed !== undefined) app.forgetConnection(addressed);
        app.forgetConnection(turn.conversationId);
      }
      return { _tag: "accepted", turn };
    }
    if (call._tag === "Refused") {
      refusedOf(call.error);
      return {
        _tag: "refused",
        detail: app.refusalText(call.error, "That message was not delivered."),
        ...("reason" in call.error && call.error.reason === endpoints.ended
          ? { ended: true }
          : {}),
        ...(isFilesRefusal(call.error) ? { files: true } : {}),
      };
    }
    // Not a refusal: the server may have taken it before the answer was lost (U8 review 4).
    return { _tag: "unanswered" };
  };
  /** An answer or a dismissal's call, as the chat's state reads it (A7-Q). */
  const questionAnswer = (
    call: Call<QuestionSettled, object>,
    fallback: string,
  ): ConversationQuestionAnswer => {
    app.moved();
    if (call._tag === "Ok") return { _tag: "settled" };
    if (call._tag === "Refused") {
      refusedOf(call.error);
      const reason =
        "_tag" in call.error &&
        call.error._tag === "QuestionRefused" &&
        "reason" in call.error &&
        (call.error.reason === "settled" ||
          call.error.reason === "invalid" ||
          call.error.reason === "harness_unreachable")
          ? call.error.reason
          : "other";
      return {
        _tag: "refused",
        reason,
        detail: app.refusalText(call.error, fallback),
      };
    }
    return { _tag: "unanswered" };
  };
  /** A Stop's call, as the chat reads it: the server's answer or a sentence. */
  const stopAnswer = (
    call: Call<ConversationStopped, object>,
    fallback: string,
    unreachable: string,
  ) => {
    app.moved();
    if (call._tag === "Ok") {
      return { _tag: "stopped" as const, stopped: call.value };
    }
    if (call._tag === "Refused") {
      refusedOf(call.error);
      return {
        _tag: "refused" as const,
        detail: app.refusalText(call.error, fallback),
      };
    }
    return { _tag: "refused" as const, detail: unreachable };
  };

  /**
   * Polls what is running in one period (A6 U6), handing each answer to `update`, until
   * nothing is: no turn and no background work. **The harness's account**: a turn the
   * harness opened by itself runs with nothing the operator sent, and background work runs
   * outside any turn. **Anything that is not an answer is the end**: a cursor left blinking
   * over a conversation that has stopped would be a claim the chat cannot back.
   */
  const watchTurn = (
    conversationId: string,
    update: (activity: ConversationActivityState) => void,
  ): (() => void) => {
    let stopped = false;
    let cancelNext: (() => void) | undefined;
    const loop = async (): Promise<void> => {
      if (stopped) return;
      const call = await endpoints.activity(conversationId);
      if (stopped) return;
      if (call._tag === "Ok") {
        const activity = {
          running: call.value.turn === "running",
          background: call.value.background,
        };
        const going = activity.running || activity.background;
        if (going) {
          cancelNext = app.after(TURN_POLL_MS, () => void loop());
        } else {
          stopped = true;
        }
        update(activity);
        return;
      }
      if (call._tag === "Refused") refusedOf(call.error);
      stopped = true;
      update({ running: false, background: false });
    };
    void loop();
    return () => {
      stopped = true;
      cancelNext?.();
      cancelNext = undefined;
    };
  };

  const { stopAll, stopSubagent, answerQuestion, dismissQuestion } = endpoints;
  const { switchModel, context } = endpoints;
  return {
    open: async (text, agentId, files) => {
      const opened = await endpoints.open(text, agentId, files);
      const sent = answer(opened.call);
      return sent._tag === "accepted" && opened.modelOptions !== undefined
        ? { ...sent, modelOptions: opened.modelOptions }
        : sent;
    },
    send: async (conversationId, text, urgency, files) =>
      answer(
        await endpoints.send(conversationId, text, urgency, files),
        conversationId,
      ),
    stop: async (conversationId) =>
      stopAnswer(
        await endpoints.stop(conversationId),
        "The turn was not stopped.",
        "No server answered at this address, so the turn may still be running.",
      ),
    ...(stopAll === undefined
      ? {}
      : {
          stopAll: async (conversationId: string) =>
            stopAnswer(
              await stopAll(conversationId),
              "The turn and its sub-agents were not stopped.",
              "No server answered at this address, so the turn and its sub-agents may still be running.",
            ),
        }),
    ...(stopSubagent === undefined
      ? {}
      : {
          stopSubagent: async (conversationId: string, callId: string) => {
            const call = await stopSubagent(conversationId, callId);
            if (call._tag === "Ok") {
              return { _tag: "stopped" as const, detail: call.value.detail };
            }
            if (call._tag === "Refused") {
              refusedOf(call.error);
              return {
                _tag: "refused" as const,
                detail: app.refusalText(
                  call.error,
                  "The sub-agent was not stopped.",
                ),
              };
            }
            return {
              _tag: "refused" as const,
              detail:
                "No server answered at this address, so the sub-agent may still be running.",
            };
          },
        }),
    ...(answerQuestion === undefined
      ? {}
      : {
          answerQuestion: async (
            conversationId: string,
            questionId: string,
            answers: QuestionAnswers,
          ) =>
            questionAnswer(
              await answerQuestion(conversationId, questionId, answers),
              "The answers were not sent.",
            ),
        }),
    ...(dismissQuestion === undefined
      ? {}
      : {
          dismissQuestion: async (conversationId: string, questionId: string) =>
            questionAnswer(
              await dismissQuestion(conversationId, questionId),
              "The questions were not dismissed.",
            ),
        }),
    ...(switchModel === undefined
      ? {}
      : {
          /**
           * Moves one period onto another model of its harness (A6 F4). An expired session
           * signs out; any other refusal, or no server answering, is a sentence for the
           * error dialog.
           */
          switchModel: async (
            conversationId: string,
            draft: ConversationModelDraft,
          ) => {
            const call = await switchModel(conversationId, draft);
            if (call._tag === "Ok") {
              return { _tag: "switched" as const, switched: call.value };
            }
            if (call._tag === "Refused") {
              refusedOf(call.error);
              return {
                _tag: "refused" as const,
                detail: app.refusalText(
                  call.error,
                  "The model was not switched.",
                ),
              };
            }
            return {
              _tag: "refused" as const,
              detail:
                "No server answered at this address, so whether the model was switched is not known. Pick it again once the server is back.",
            };
          },
        }),
    /**
     * One period's conversation, with the floor the live tail is joined at (S6). **The
     * floor is taken before the request leaves**: narration published during the round trip
     * is the live tail and must not be dropped against it. Anything but an answer is
     * `undefined`, which leaves the thread as it was.
     */
    history: async (conversationId) => {
      const floor = app.highWater();
      const call = await endpoints.history(conversationId);
      if (call._tag === "Ok") {
        // Ended, by the replay's word: its stream is gone with it (U13 review 6).
        if (
          call.value.continuation === "refused" &&
          call.value.refusal.reason === endpoints.ended
        ) {
          app.forgetConnection(conversationId);
        }
        return { view: call.value, floor };
      }
      if (call._tag === "Refused") refusedOf(call.error);
      return undefined;
    },
    reread: app.reread,
    wait: app.wait,
    parked: app.parked,
    harnessName: app.harnessName,
    harnessDriver: app.harnessDriver,
    ...(app.modelName === undefined ? {} : { modelName: app.modelName }),
    highWater: app.highWater,
    watchTurn,
    ...(context === undefined
      ? {}
      : {
          /** One period's context reading (A6 U9); anything unanswered leaves the meter. */
          context: async (conversationId: string, breakdown: boolean) => {
            const call = await context(conversationId, breakdown);
            if (call._tag === "Ok") return call.value;
            if (call._tag === "Refused") refusedOf(call.error);
            return undefined;
          },
        }),
  };
};
