/**
 * A chat's state, as the shell draws it (A6 chat generalisation, slice 2): the
 * {@link ChatSession} `ChatShell` takes, built over a {@link ConversationSessions}.
 *
 * It was `ImporterChat.svelte`'s adapter. What it decides is the same for every owner with a
 * multi-session chat, so it is here once:
 *
 * - **Whether the box takes a message**: not for a session on a harness this server does not
 *   run, one the operator ended (the index row, or the replay's `ended` refusal), one the
 *   replay refused for another reason (its sentence is the placeholder and the note), or
 *   while the owner says nothing can be sent at all ({@link ChatSessionInput.unavailable}).
 * - **The sentences above the box**, in D3's order: a message waiting behind a model switch,
 *   the switch's answer, the server's word on the last message.
 * - **Stop, Stop all and the dock**, wired to the state, and offered only where the server
 *   has the ability.
 *
 * What an owner supplies is its words ({@link ConversationChatWords}): every sentence that
 * names its agent or its own pages. The importer's are in `ImporterChat.svelte`.
 */
import type { LiveConnection } from "@bit/contracts";

import type {
  ChatQuestion,
  ChatSession,
  ChatWords,
  ComposerNotice,
  OpenChatComposer,
  ThreadTurn,
} from "./chatShell";
import { connectionNote } from "./chat";
import type { LoadedFile } from "./attachmentFiles";
import type { ConversationSession, SendNowTiming } from "./conversationChat";
import type { ConversationSessions } from "./conversationSessions.svelte";

/** Every sentence a chat says that names its agent, its pages or its work. */
export interface ConversationChatWords {
  /** The shell's own words: the working line, the copy and Stop titles, the box's labels. */
  readonly shell: ChatWords;
  /** The empty page's sentence under the label. */
  readonly empty: string;
  /** The agent's label where no registry names it: D4's "Importer". */
  readonly agent: string;
  /** Stop all's title. */
  readonly stopAll: string;
  /** The box's placeholder, by whether the thread has turns yet. */
  readonly placeholder: (thread: "empty" | "continuing") => string;
  /** Over a session whose harness this server does not run: the note and the placeholder. */
  readonly stranded: (instanceId: string) => {
    readonly note: string;
    readonly placeholder: string;
  };
  /** Over a session the operator ended: the note and the placeholder. */
  readonly ended: { readonly note: string; readonly placeholder: string };
  /** Above a session being read, by what the next message will do (`readingNote`). */
  readonly reading: (
    session: ConversationSession | undefined,
    newest: boolean,
  ) => string;
  /** The Send now button's title, and a sent-now message's, by the harness's timing. */
  readonly sendNow: (timing: SendNowTiming) => string;
  readonly sentNow: (timing: SendNowTiming) => string;
}

export interface ChatSessionInput<S extends ConversationSession> {
  readonly state: ConversationSessions<S>;
  readonly words: ConversationChatWords;
  /** The chat's accessible label. */
  readonly label: () => string;
  /** The refusal reason that says the operator ended a period: `import_ended`. */
  readonly endedReason: string;
  /** The server's last word on one period's narration connection, if any. */
  readonly connection: (conversationId: string) => LiveConnection | undefined;
  /**
   * Why nothing can be sent to this owner at all, when that is so — the importer's "no
   * model to run on" — as the note and the placeholder. `undefined` when messages can go.
   */
  readonly unavailable?: () =>
    { readonly note: string; readonly placeholder: string } | undefined;
  /** How many running sub-agents bit can stop from here: Stop all takes Stop's place. */
  readonly stoppableSubagents: () => number;
  readonly maxChars: number;
  readonly loadFile: (path: string) => Promise<LoadedFile>;
}

/** What {@link chatSessionOf} builds: the shell's session and what the page reads beside it. */
export interface ChatSessionOf {
  readonly chat: ChatSession<ThreadTurn>;
  /** True when the box takes no message: the owner's chips and pickers wait too. */
  readonly blocked: () => boolean;
  /** The agent's label for the session on screen. */
  readonly agentLabel: () => string;
}

export const chatSessionOf = <S extends ConversationSession>(
  input: ChatSessionInput<S>,
): ChatSessionOf => {
  // Read through `input` each time, so a caller can hand its state as a getter.
  const { words } = input;
  const session = () => input.state.current;
  const refusal = () => {
    const standing = session()?.history.standing;
    return standing?.continuation === "refused" ? standing.refusal : undefined;
  };
  /**
   * The operator ended it, from the index row or from the replay's refusal: the same fact
   * from two reads, and either is enough. **Not every `refused`**: a session whose agent
   * this server does not define is refused too, and nobody ended it.
   */
  const ended = () =>
    session()?.ended === true || refusal()?.reason === input.endedReason;
  /** The server's sentence for a refusal that is not the operator's end, as it stands. */
  const refusedBecause = () =>
    !ended() && refusal() !== undefined ? refusal()?.detail : undefined;
  const stranded = () => session()?.strandedOn;
  const unavailable = () => input.unavailable?.();
  const blocked = () =>
    stranded() !== undefined ||
    ended() ||
    refusedBecause() !== undefined ||
    unavailable() !== undefined;
  const agentLabel = () => {
    const id = session()?.agentId ?? input.state.agents?.defaultAgentId;
    return (
      input.state.agents?.agents.find((agent) => agent.id === id)?.label ??
      words.agent
    );
  };
  const placeholder = () => {
    const on = stranded();
    if (on !== undefined) return words.stranded(on).placeholder;
    if (ended()) return words.ended.placeholder;
    const refused = refusedBecause();
    if (refused !== undefined) return refused;
    const none = unavailable();
    if (none !== undefined) return none.placeholder;
    return words.placeholder(
      input.state.groups.length === 0 ? "empty" : "continuing",
    );
  };
  const notices = (): readonly ComposerNotice[] => {
    const current = session();
    const switching = input.state.switchingOf(current?.id);
    const switchNote =
      input.state.switchNotice !== undefined &&
      input.state.switchNotice.sessionId === current?.id
        ? input.state.switchNotice.text
        : "";
    return [
      ...(input.state.sending &&
      input.state.waitingForSwitch &&
      switching !== undefined
        ? [
            {
              key: "waiting",
              text: "Waiting for the model switch: this message is delivered once the switch has answered, which can take up to a minute and a half.",
              tone: "status" as const,
              kind: "waiting",
            },
          ]
        : []),
      ...(switchNote === ""
        ? []
        : [
            {
              key: "switched",
              text: switchNote,
              tone: "status" as const,
              kind: "switched",
            },
          ]),
      ...(input.state.notice === ""
        ? []
        : [
            {
              key: "server",
              text: input.state.notice,
              tone: input.state.refused
                ? ("alert" as const)
                : ("status" as const),
              kind: input.state.refused ? "refusal" : undefined,
            },
          ]),
    ];
  };

  // An open box, typed as one: every field it needs is required there.
  const composer: OpenChatComposer = {
    get draft() {
      return input.state.draft;
    },
    set draft(value: string) {
      input.state.draft = value;
    },
    get files() {
      return input.state.files;
    },
    get sending() {
      return input.state.sending;
    },
    get blocked() {
      return blocked();
    },
    get placeholder() {
      return placeholder();
    },
    maxChars: input.maxChars,
    send: (urgency) => input.state.send(urgency),
    get sendNow() {
      return {
        offered: session()?.conversationId !== undefined,
        title: words.sendNow(input.state.sendNow),
      };
    },
    get notices() {
      return notices();
    },
  };

  const chat: ChatSession<ThreadTurn> = {
    get label() {
      return input.label();
    },
    empty: words.empty,
    get groups() {
      return input.state.groups;
    },
    get note() {
      const on = stranded();
      if (on !== undefined) return words.stranded(on).note;
      if (ended()) return words.ended.note;
      const refused = refusedBecause();
      if (refused !== undefined) return refused;
      const none = unavailable();
      if (none !== undefined) return none.note;
      const current = session();
      return words.reading(
        current,
        current !== undefined && input.state.newestId === current.id,
      );
    },
    get connection() {
      const id = session()?.conversationId;
      return connectionNote(
        id === undefined ? undefined : input.connection(id),
      );
    },
    get turn() {
      const current = session();
      return {
        working: current?.working ?? false,
        background: current?.background === true,
        stopping: input.state.stopping,
      };
    },
    stop: () => void input.state.stop(),
    /*
     * E7's Stop all, in Stop's place while sub-agents run (A7-S): only what bit can stop
     * from here, so a card a replay still draws running with no Stop is not counted.
     */
    get stopAll() {
      return {
        running: input.stoppableSubagents(),
        stop: () => void input.state.stop(true),
        title: words.stopAll,
      };
    },
    get stopFailure() {
      return input.state.stopFailure;
    },
    dismissStopFailure: () => input.state.dismissStopFailure(),
    composer,
    /*
     * The question the agent waits on (A7-Q), docked in the box's place. Its answers go as
     * a message when the native request is gone, unless no message can be sent to this
     * session, when the dock reads only.
     */
    get question(): ChatQuestion | undefined {
      const pending = input.state.question;
      if (pending === undefined) return undefined;
      return {
        pending,
        asker: `The ${agentLabel().toLowerCase()}`,
        busy: input.state.questionBusy || input.state.sending,
        answer: (answers) => void input.state.answerQuestion(answers),
        sendAsMessage: blocked()
          ? undefined
          : (text) => input.state.sendAnswersAsMessage(text),
        dismiss: () => void input.state.dismissQuestion(),
        refusal: input.state.questionRefusal,
        dismissRefusal: () => input.state.dismissQuestionRefusal(),
      };
    },
    get words() {
      return words.shell;
    },
    get footer() {
      return { agent: agentLabel(), model: session()?.model ?? "" };
    },
    get sentNowTitle() {
      return words.sentNow(input.state.sendNow);
    },
    loadFile: input.loadFile,
  };

  return { chat, blocked, agentLabel };
};
