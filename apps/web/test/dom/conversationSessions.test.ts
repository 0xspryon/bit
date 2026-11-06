/**
 * The generic chat state through an owner that is not the importer (A6 chat generalisation,
 * slice 2): a test-only **probe goal** whose frames are routed by `goalId`, over
 * `ConversationSessions`, `conversationServer` and `chatSessionOf` — the three pieces a goal
 * chat is to be built from — with fake endpoints standing in for its routes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { SvelteSet } from "svelte/reactivity";

import type {
  ConversationStopped,
  LiveConnection,
  LiveItem,
  LiveQuestion,
  QuestionAnswerability,
} from "@bit/contracts";

import type { Call } from "../../src/lib/client";
import { CARRIED_NOTE } from "../../src/lib/conversationChat";
import type { ParkedMessages } from "../../src/lib/conversationParked";
import { TAKEN_KIND } from "../../src/lib/chat";
import {
  NO_HISTORY,
  type ConversationReplayView,
  type ConversationSession,
} from "../../src/lib/conversationChat";
import {
  chatSessionOf,
  type ConversationChatWords,
} from "../../src/lib/conversationChatSession";
import {
  conversationServer,
  type ConversationEndpoints,
} from "../../src/lib/conversationServer";
import {
  ConversationSessions,
  type ConversationBinding,
} from "../../src/lib/conversationSessions.svelte";
import { usageScope } from "../../src/lib/chat";
import { IMPORTER_BINDING } from "../../src/lib/importerSessions.svelte";
import { AT, ok, refused, replayItem, unreachable } from "../fakeServer";
import { click, mountInto, press, settle as drawn, type Mounted } from "./dom";

const { default: ProbeChat } = await import("./fixtures/ProbeChat.svelte");

let mounted: Mounted[] = [];
afterEach(() => {
  for (const each of mounted) each.destroy();
  mounted = [];
});

/** The probe's accepted message on its (imaginary) wire. */
interface ProbeTurn {
  readonly periodId: string;
  readonly sessionId: string;
  readonly conversation: "opened" | "resumed" | "continued";
  readonly messageId?: string;
}

const BINDING: ConversationBinding<ConversationSession> = {
  // A goal's frames: the period is named by `goalId`, never `importId`.
  routeOf: (frame) => frame.goalId,
  connectionKey: (periodId) => `goal:${periodId}`,
  agent: "goal agent",
  emptySession: (now, id) => ({
    id: id ?? "ses_new",
    startedAt: now,
    model: "probe/model",
    harness: "Probe harness",
    history: NO_HISTORY,
    items: [],
    working: false,
    tally: { messages: 0 },
    reading: false,
  }),
};

const listed = (
  id: string,
  periodId: string,
  startedAt: number,
): ConversationSession => ({
  id,
  startedAt,
  model: "probe/model",
  harness: "Probe harness",
  history: NO_HISTORY,
  items: [],
  working: false,
  tally: { messages: null },
  reading: true,
  indexed: true,
  conversationId: periodId,
  harnessInstanceId: "probe",
});

const replay = (
  periodId: string,
  over: Partial<ConversationReplayView> = {},
): ConversationReplayView =>
  ({
    source: "harness",
    note: "From the harness.",
    truncated: false,
    items: [
      replayItem(0, "turn.operator", "What is in scope?", { goalId: periodId }),
      replayItem(1, "turn.reply", "Two hosts.", { goalId: periodId }),
    ],
    queued: [],
    question: null,
    at: AT,
    continuation: "live",
    ...over,
  }) as ConversationReplayView;

const liveItem = (
  n: number,
  body: string,
  route: Partial<LiveItem>,
): LiveItem => ({
  ...replayItem(n, "turn.reply", body, route),
  id: `activity:${String(n)}`,
});

/** Lets every pending promise run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

/** A probe world: the state, fake endpoints with their calls, and the app hooks' record. */
const world = (
  options: {
    readonly leaveOut?: readonly (keyof ConversationEndpoints<ProbeTurn>)[];
    /** The owner says nothing can be sent at all, as the importer does with no model. */
    readonly unavailable?: () => boolean;
  } = {},
) => {
  const calls: string[] = [];
  const forgotten: string[] = [];
  let live: readonly LiveItem[] = [];
  let turn: "idle" | "running" = "idle";
  /** What the next open or send answers instead of `next`, once: a refusal, a lost answer. */
  let scripted: (() => Promise<Call<ProbeTurn, object>>) | undefined;
  const takeScripted = () => {
    const answer = scripted;
    scripted = undefined;
    return answer;
  };
  const parkedWrites: ParkedMessages[] = [];
  let next: ProbeTurn = {
    periodId: "gper_1",
    sessionId: "ses_1",
    conversation: "opened",
  };
  const stopped: ConversationStopped = {
    conversationId: "gper_1",
    outcome: "idle",
    working: false,
    background: false,
    detail: "Nothing was running.",
  };
  const full: ConversationEndpoints<ProbeTurn> = {
    open: async (text) => {
      calls.push(`open ${text}`);
      const answer = takeScripted();
      return { call: answer === undefined ? ok(next) : await answer() };
    },
    send: async (id, text, urgency) => {
      calls.push(`send ${id} ${text} ${urgency ?? "queued"}`);
      const answer = takeScripted();
      return answer === undefined ? ok(next) : await answer();
    },
    stopSubagent: (id, callId) => {
      calls.push(`stopSubagent ${id} ${callId}`);
      return Promise.resolve(
        ok({
          conversationId: id,
          callId,
          detail: "The sub-agent was stopped.",
        }),
      );
    },
    history: (id) => {
      calls.push(`history ${id}`);
      return Promise.resolve(ok(replay(id)));
    },
    stop: (id) => {
      calls.push(`stop ${id}`);
      return Promise.resolve(ok(stopped));
    },
    stopAll: (id) => {
      calls.push(`stopAll ${id}`);
      return Promise.resolve(ok(stopped));
    },
    activity: (id) =>
      Promise.resolve(ok({ conversationId: id, turn, background: false })),
    answerQuestion: (id, questionId) => {
      calls.push(`answer ${id} ${questionId}`);
      return Promise.resolve(ok({ questionId, settled: "answered" as const }));
    },
    dismissQuestion: (id, questionId) => {
      calls.push(`dismiss ${id} ${questionId}`);
      return Promise.resolve(ok({ questionId, settled: "dismissed" as const }));
    },
    context: (id) => {
      calls.push(`context ${id}`);
      return Promise.resolve(
        ok({
          conversationId: id,
          model: "probe/model",
          used: 10,
          usedModel: "probe/model",
          window: 100,
          reading: "measured" as const,
          breakdown: { _tag: "none" as const, reason: "unanswered" as const },
          measuredAt: AT,
        }),
      ) as Promise<Call<never, never>>;
    },
    accepted: (turn) => ({
      conversationId: turn.periodId,
      harnessSessionId: turn.sessionId,
      harnessInstanceId: "probe",
      model: "probe/model",
      conversation: turn.conversation,
      notice: "",
      acceptedAt: AT,
      ...(turn.messageId === undefined ? {} : { messageId: turn.messageId }),
    }),
    ended: "goal_ended",
  };
  const endpoints = Object.fromEntries(
    Object.entries(full).filter(
      ([key]) => !(options.leaveOut ?? []).includes(key as never),
    ),
  ) as unknown as ConversationEndpoints<ProbeTurn>;
  const server = conversationServer(
    {
      signOut: () => calls.push("signOut"),
      refusalText: (_error, fallback) => fallback,
      moved: () => undefined,
      forgetConnection: (id) => forgotten.push(id),
      highWater: () => 0,
      reread: () => {
        calls.push("reread");
        return Promise.resolve();
      },
      wait: () => Promise.resolve(),
      after: () => () => undefined,
      parked: {
        read: () => ({}),
        write: (parked) => {
          parkedWrites.push(parked);
        },
      },
      harnessName: () => "Probe harness",
      harnessDriver: () => undefined,
    },
    endpoints,
  );
  const state = new ConversationSessions(
    BINDING,
    () => AT,
    () => live,
    undefined,
    options.unavailable,
  );
  return {
    state,
    server,
    calls,
    forgotten,
    parkedWrites,
    /** The next open or send is answered by `answer` instead. */
    answerOnce: (answer: () => Promise<Call<ProbeTurn, object>>) => {
      scripted = answer;
    },
    setLive: (items: readonly LiveItem[]) => {
      live = items;
    },
    answerNext: (turn: ProbeTurn) => {
      next = turn;
    },
    /** What the activity route answers from now on: a turn running, or nothing. */
    running: (running: boolean) => {
      turn = running ? "running" : "idle";
    },
  };
};

/** The probe owner's words: empty but for the ones a test reads. */
const WORDS: ConversationChatWords = {
  shell: {
    working: "",
    copyReply: "",
    stopTurn: "Stop the goal agent",
    stopBackground: "",
    messageLabel: "",
    sendLabel: "",
    sendTitle: "",
    sendQueuedTitle: "",
    countTitle: "",
    questionsAsked: () => "",
  },
  empty: "",
  agent: "Goal agent",
  stopAll: "Stop every sub-agent, then the goal agent",
  placeholder: () => "",
  stranded: () => ({ note: "", placeholder: "" }),
  ended: { note: "", placeholder: "" },
  reading: () => "",
  sendNow: () => "",
  sentNow: () => "",
};

/** The probe's chat as the shell takes it, with `running` sub-agents bit can stop. */
const probeChat = (
  state: ConversationSessions<ConversationSession>,
  options: {
    readonly connection?: () => LiveConnection | undefined;
    readonly subagents?: number;
  } = {},
) =>
  chatSessionOf({
    state,
    words: WORDS,
    label: () => "Goal chat",
    endedReason: "goal_ended",
    connection: () => options.connection?.(),
    stoppableSubagents: () => options.subagents ?? 0,
    maxChars: 100,
    loadFile: () => Promise.reject(new Error("no files")),
  });

/** The probe's chat drawn by the real shell; unmounted after the test. */
const drawChat = async (
  chat: ReturnType<typeof probeChat>["chat"],
): Promise<HTMLElement> => {
  const view = mountInto(ProbeChat, { chat });
  mounted.push(view);
  await drawn();
  return view.target;
};

/** A question frame for the probe's period `gper_1`, routed by `goalId`. */
const asked = (
  answerability: QuestionAnswerability = "live",
  questionId = "q_1",
): LiveQuestion =>
  ({
    _tag: "question",
    question: {
      questionId,
      harnessSessionId: "ses_1",
      fields: [
        {
          key: "Change production?",
          header: "Critical action",
          question: "Change production?",
          kind: "one",
          options: [
            { label: "Approve once", description: null },
            { label: "Deny", description: null },
          ],
          custom: true,
          required: true,
        },
      ],
      askedAt: AT,
      answerability,
      // The A9 seam: a critical action, carried through untouched.
      tag: "critical",
      attemptId: null,
      roundId: null,
      goalId: "gper_1",
      importId: null,
    },
    questionId,
    settled: null,
    at: AT,
    attemptId: null,
    roundId: null,
    goalId: "gper_1",
    importId: null,
  }) as unknown as LiveQuestion;

const dockOf = (root: HTMLElement): HTMLElement | null =>
  root.querySelector("section.question-dock");
const named = (
  root: HTMLElement,
  name: string,
): HTMLButtonElement | undefined =>
  [...root.querySelectorAll("button")].find(
    (each) =>
      (each.getAttribute("aria-label") ?? each.textContent ?? "").trim() ===
      name,
  );

describe("the generic chat state through a goal-shaped owner", () => {
  test("lists the owner's sessions newest first and replays one, routed by goalId", async () => {
    const probe = world();
    probe.state.begin(
      [listed("ses_old", "gper_0", AT - 10_000), listed("ses_1", "gper_1", AT)],
      probe.server,
    );
    expect(probe.state.listed.map((session) => session.id)).toEqual([
      "ses_1",
      "ses_old",
    ]);
    probe.state.open("ses_1");
    await settle();
    // A goal frame for this period lands in the thread; an importer's frame for the same
    // id, and another period's, do not.
    probe.setLive([
      liveItem(5, "And a third.", { goalId: "gper_1" }),
      liveItem(6, "Not mine.", { importId: "gper_1" }),
      liveItem(7, "Another period.", { goalId: "gper_0" }),
    ]);
    // Compared as a string, never as nodes (AGENTS.md).
    const drawn = JSON.stringify(probe.state.groups);
    expect(probe.calls).toContain("history gper_1");
    expect(drawn).toContain("Two hosts.");
    expect(drawn).toContain("And a third.");
    expect(drawn).not.toContain("Not mine.");
    expect(drawn).not.toContain("Another period.");
  });

  test("the first message opens a period; Send now goes to it with its urgency", async () => {
    const probe = world();
    probe.state.begin([], probe.server);
    probe.state.draft = "Start on the login flow";
    probe.state.send();
    await settle();
    expect(probe.calls).toContain("open Start on the login flow");
    // The page's empty session became the period the server opened.
    expect(probe.state.current?.conversationId).toBe("gper_1");
    expect(probe.state.current?.id).toBe("ses_1");
    probe.answerNext({
      periodId: "gper_1",
      sessionId: "ses_1",
      conversation: "continued",
      messageId: "msg_1",
    });
    probe.state.draft = "Skip the admin pages";
    probe.state.send("preemptive");
    await settle();
    expect(probe.calls).toContain(
      "send gper_1 Skip the admin pages preemptive",
    );
  });

  test("a turn's notes name the owner's agent, not the importer", async () => {
    const probe = world();
    probe.state.begin([], probe.server);
    probe.state.draft = "Start on the login flow";
    probe.state.send();
    await settle();
    probe.answerNext({
      periodId: "gper_1",
      sessionId: "ses_1",
      conversation: "continued",
      messageId: "msg_2",
    });
    probe.state.draft = "And the admin pages";
    probe.state.send();
    await settle();
    const notes = probe.state.groups.map((group) =>
      "note" in group.prose ? group.prose.note : "",
    );
    expect(notes).toEqual([
      "The goal agent wrote nothing in reply to this message.",
      "Sent. The goal agent has not answered yet.",
    ]);
  });

  test("a message that resumed a let-go period forgets both periods' lost notices", async () => {
    const probe = world();
    probe.state.begin([listed("ses_1", "gper_1", AT)], probe.server);
    probe.state.open("ses_1");
    await settle();
    probe.answerNext({
      periodId: "gper_2",
      sessionId: "ses_1",
      conversation: "resumed",
    });
    probe.state.draft = "Carry on";
    probe.state.send();
    await settle();
    expect(probe.forgotten).toEqual(["gper_1", "gper_2"]);
    expect(probe.state.current?.conversationId).toBe("gper_2");
  });

  test("a binding's connection key is what the app files the owner's frames under", () => {
    const subject = {
      attemptId: null,
      roundId: null,
      goalId: null,
      importId: null,
    };
    // The app keeps `lost` notices and model calls by `usageScope`; each owner's key for its
    // period must be that same string, or its notice is never read nor forgotten.
    expect(BINDING.connectionKey("gper_1")).toBe(
      usageScope({ ...subject, goalId: "gper_1" }) ?? "",
    );
    expect(IMPORTER_BINDING.connectionKey("imp_1")).toBe(
      usageScope({ ...subject, importId: "imp_1" }) ?? "",
    );
  });

  test("the shell's session says the owner's lost notice, and nothing once it is closed", () => {
    const probe = world();
    let frame: LiveConnection | undefined;
    probe.state.begin([listed("ses_1", "gper_1", AT)], probe.server);
    probe.state.open("ses_1");
    const { chat } = probeChat(probe.state, { connection: () => frame });
    expect(chat.connection).toBe("");
    frame = {
      _tag: "connection",
      state: "lost",
      detail: "",
      at: AT,
      attemptId: null,
      roundId: null,
      goalId: "gper_1",
      importId: null,
    } as LiveConnection;
    expect(chat.connection).toContain("could not be reconnected");
    frame = { ...frame, state: "closed" };
    expect(chat.connection).toBe("");
    expect(chat.footer.agent).toBe("Goal agent");
  });

  test("Stop goes to the period; without the Stop all ability, Stop all is never asked for", async () => {
    const probe = world({ leaveOut: ["stopAll"] });
    probe.state.begin([listed("ses_1", "gper_1", AT)], probe.server);
    probe.state.open("ses_1");
    await settle();
    await probe.state.stop();
    // Nothing falls back to a plain Stop under Stop all's name (review 1 of slice 2).
    await probe.state.stop(true);
    expect(probe.calls.filter((call) => call.startsWith("stop"))).toEqual([
      "stop gper_1",
    ]);
  });

  test("an owner without Stop all draws no Stop all: running sub-agents leave the turn's Stop", async () => {
    const probe = world({ leaveOut: ["stopAll"] });
    probe.state.begin([listed("ses_1", "gper_1", AT)], probe.server);
    probe.state.open("ses_1");
    await settle();
    probe.running(true);
    probe.state.draft = "Go on";
    probe.state.send();
    await settle();
    expect(probe.state.current?.working).toBe(true);
    const { chat } = probeChat(probe.state, { subagents: 2 });
    expect(chat.stopAll).toBeUndefined();
    const root = await drawChat(chat);
    const stop = root.querySelector<HTMLButtonElement>("button.stop");
    expect(stop?.getAttribute("title")).toBe("Stop the goal agent");
    expect(stop?.textContent ?? "").not.toContain("Stop all");
    if (stop === null) throw new Error("no Stop");
    click(stop);
    await settle();
    expect(probe.calls.filter((call) => call.startsWith("stop"))).toEqual([
      "stop gper_1",
    ]);
  });

  test("an owner with Stop all draws it in Stop's place while sub-agents run, and asks for it", async () => {
    const probe = world();
    probe.state.begin([listed("ses_1", "gper_1", AT)], probe.server);
    probe.state.open("ses_1");
    await settle();
    const root = await drawChat(probeChat(probe.state, { subagents: 2 }).chat);
    const stop = root.querySelector<HTMLButtonElement>("button.stop");
    expect(stop?.textContent ?? "").toContain("Stop all");
    if (stop === null) throw new Error("no Stop all");
    click(stop);
    await settle();
    expect(probe.calls.filter((call) => call.startsWith("stop"))).toEqual([
      "stopAll gper_1",
    ]);
  });

  test("a question routed by goalId docks, and its answer goes to the period", async () => {
    const probe = world();
    probe.state.begin([listed("ses_1", "gper_1", AT)], probe.server);
    probe.state.open("ses_1");
    await settle();
    const question = asked();
    probe.state.noteQuestion(question);
    expect(probe.state.question?.questionId).toBe("q_1");
    expect(probe.state.question?.tag).toBe("critical");
    await probe.state.answerQuestion({ "Change production?": ["Deny"] });
    expect(probe.calls).toContain("answer gper_1 q_1");
  });

  test("an owner that cannot answer has no dock: the box stays, and nothing is sent", async () => {
    const probe = world({ leaveOut: ["answerQuestion", "dismissQuestion"] });
    probe.state.begin([listed("ses_1", "gper_1", AT)], probe.server);
    probe.state.open("ses_1");
    await settle();
    probe.state.noteQuestion(asked());
    expect(probe.state.question).toBeUndefined();
    const { chat } = probeChat(probe.state);
    expect(chat.question).toBeUndefined();
    const root = await drawChat(chat);
    expect(dockOf(root)).toBeNull();
    expect(root.querySelector("textarea")).not.toBeNull();
    await probe.state.answerQuestion({ "Change production?": ["Deny"] });
    await probe.state.dismissQuestion();
    expect(
      probe.calls.filter(
        (call) => call.startsWith("answer") || call.startsWith("dismiss"),
      ),
    ).toEqual([]);
  });

  test("an owner that answers but cannot dismiss: a dock with no dismissal, and Esc does not dismiss", async () => {
    const probe = world({ leaveOut: ["dismissQuestion"] });
    probe.state.begin([listed("ses_1", "gper_1", AT)], probe.server);
    probe.state.open("ses_1");
    await settle();
    probe.state.noteQuestion(asked());
    const { chat } = probeChat(probe.state);
    expect(chat.question?.dismiss).toBeUndefined();
    const root = await drawChat(chat);
    const dock = dockOf(root);
    expect(dock).not.toBeNull();
    expect(named(root, "Dismiss these questions")).toBeUndefined();
    expect(dock?.textContent ?? "").not.toContain("reply in chat instead");
    root.querySelector<HTMLInputElement>(".current input[type=radio]")?.focus();
    press("Escape");
    await drawn();
    expect(dockOf(root)).not.toBeNull();
    await probe.state.dismissQuestion();
    expect(probe.calls.some((call) => call.startsWith("dismiss"))).toBe(false);
    expect(probe.state.question?.questionId).toBe("q_1");
  });

  test("a question no longer waiting natively, on an owner that cannot dismiss, is not docked", async () => {
    const probe = world({ leaveOut: ["dismissQuestion"] });
    probe.state.begin([listed("ses_1", "gper_1", AT)], probe.server);
    probe.state.open("ses_1");
    await settle();
    probe.state.noteQuestion(asked("not_resumable"));
    // Nothing could be sent from it and it could not be put away: it would hold the box.
    expect(probeChat(probe.state).chat.question).toBeUndefined();
  });

  /*
   * One reader of the pending question (review 2 of slice 2). The importer's title bar
   * draws its "waiting on you" dot from `state.question !== undefined`; a page doing the
   * same for this owner must not show a question its dock will not offer.
   */
  test("a question the dock will not offer is not one the page's dot shows either", async () => {
    // Reactive, as the importer's model lookup is: the state derives from it.
    const unavailable = new SvelteSet<string>();
    const probe = world({
      leaveOut: ["dismissQuestion"],
      unavailable: () => unavailable.has("no model"),
    });
    probe.state.begin([listed("ses_1", "gper_1", AT)], probe.server);
    probe.state.open("ses_1");
    await settle();
    const { chat } = probeChat(probe.state);
    /** The title bar's reading of it, as `TitleBar.svelte` draws the dot. */
    const dot = () => probe.state.question !== undefined;
    const seen = () => [dot(), chat.question !== undefined];

    probe.state.noteQuestion(asked("not_resumable"));
    const notResumable = seen();
    // A `message` one while a message can go: docked, with the send and no dismissal.
    probe.state.noteQuestion(asked("message", "q_2"));
    const sendable = seen();
    const sends = chat.question?.sendAsMessage !== undefined;
    // The same one once nothing can be sent: neither the dock nor the dot.
    unavailable.add("no model");
    const blocked = seen();
    expect(probe.state.messageBlocked).toBe(true);
    expect(chat.composer).toMatchObject({ blocked: true });

    expect(notResumable).toEqual([false, false]);
    expect(sendable).toEqual([true, true]);
    expect(sends).toBe(true);
    expect(blocked).toEqual([false, false]);
  });

  test("the state's dismissal without the ability asks the server nothing, not even a Stop", async () => {
    const probe = world({ leaveOut: ["dismissQuestion"] });
    probe.state.begin([listed("ses_1", "gper_1", AT)], probe.server);
    probe.state.open("ses_1");
    await settle();
    probe.state.noteQuestion(asked());
    const before = probe.calls.length;
    await probe.state.dismissQuestion();
    await settle();
    expect(probe.calls.slice(before)).toEqual([]);
    expect(probe.state.questionBusy).toBe(false);
    expect(probe.state.question?.questionId).toBe("q_1");
  });

  test("an owner without a meter or a switch leaves them out", async () => {
    const probe = world({ leaveOut: ["context", "switchModel"] });
    probe.state.begin([listed("ses_1", "gper_1", AT)], probe.server);
    probe.state.open("ses_1");
    await settle();
    expect(probe.server.context).toBeUndefined();
    expect(probe.server.switchModel).toBeUndefined();
    expect(probe.calls.some((call) => call.startsWith("context"))).toBe(false);
    expect(Object.keys(probe.state.contexts)).toEqual([]);
    expect(await probe.state.switchModel("probe/other", undefined)).toBe(false);
  });
  test("a refused open keeps the words in the box, with the server's sentence", async () => {
    const probe = world();
    probe.state.begin([], probe.server);
    probe.answerOnce(() =>
      Promise.resolve(refused({ _tag: "ProbeRefused", reason: "busy" })),
    );
    probe.state.draft = "Start on the login flow";
    probe.state.send();
    await settle();
    expect(probe.calls).toContain("open Start on the login flow");
    expect(probe.state.draft).toBe("Start on the login flow");
    expect(probe.state.refused).toBe(true);
    // The server's sentence (the app's refusal text; its fallback here).
    expect(probe.state.notice).toBe("That message was not delivered.");
    expect(probe.state.current?.conversationId).toBeUndefined();
  });

  test("an open with no answer is unanswered, not refused: the words come back, and the list is looked in", async () => {
    const probe = world();
    probe.state.begin([], probe.server);
    probe.answerOnce(() => Promise.resolve(unreachable("connection reset")));
    probe.state.draft = "Start on the login flow";
    probe.state.send();
    await settle();
    expect(probe.state.draft).toBe("Start on the login flow");
    expect(probe.state.notice).toContain("No server answered");
    // Whether it arrived is looked for in the list: the session it may have opened.
    expect(probe.calls).toContain("reread");
  });

  test("a reply refused once the operator went to another session is parked on its own, and given back there", async () => {
    const probe = world();
    probe.state.begin(
      [listed("ses_old", "gper_0", AT - 10_000), listed("ses_1", "gper_1", AT)],
      probe.server,
    );
    probe.state.open("ses_1");
    await settle();
    let release: () => void = () => undefined;
    probe.answerOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve(refused({ _tag: "ProbeRefused", reason: "busy" }));
        }),
    );
    probe.state.draft = "Skip the admin pages";
    probe.state.send();
    await settle();
    probe.state.open("ses_old");
    release();
    await settle();
    expect(probe.state.parked["ses_1"]?.text).toBe("Skip the admin pages");
    expect(probe.state.parked["ses_1"]?.outcome).toBe("refused");
    expect(probe.parkedWrites.at(-1)?.["ses_1"]?.text).toBe(
      "Skip the admin pages",
    );
    expect(probe.state.draft).toBe("");
    probe.state.open("ses_1");
    expect(probe.state.draft).toBe("Skip the admin pages");
  });

  test("a message sent mid-turn waits marked queued until a take routed by goalId; a carry is the turn's note", async () => {
    const probe = world();
    probe.state.begin([listed("ses_1", "gper_1", AT)], probe.server);
    probe.state.open("ses_1");
    await settle();
    probe.running(true);
    probe.answerNext({
      periodId: "gper_1",
      sessionId: "ses_1",
      conversation: "continued",
      messageId: "msg_a",
    });
    probe.state.draft = "First";
    probe.state.send();
    await settle();
    probe.answerNext({
      periodId: "gper_1",
      sessionId: "ses_1",
      conversation: "continued",
      messageId: "msg_b",
    });
    probe.state.draft = "Second";
    probe.state.send();
    await settle();
    const subjects = () =>
      probe.state.groups.map(
        (group) => `${group.subject.message}:${String(group.subject.queued)}`,
      );
    expect(subjects()).toEqual([
      "What is in scope?:false",
      "First:false",
      "Second:true",
    ]);
    // Another owner's take of the same message id is not this one's.
    const take = (route: Partial<LiveItem>): LiveItem => ({
      ...replayItem(8, TAKEN_KIND, "", { ...route, messageIds: ["msg_b"] }),
      id: "activity:8",
    });
    probe.state.noteTaken(take({ importId: "gper_1" }));
    expect(subjects().at(-1)).toBe("Second:true");
    const taken = take({ goalId: "gper_1" });
    // The harness ended the first turn before it wrote anything, and sent it on with the
    // next. (The feed is read when the state changes: the take is that change.)
    probe.setLive([
      taken,
      {
        ...replayItem(9, "turn.carried", "", {
          goalId: "gper_1",
          messageIds: ["msg_a"],
        }),
        id: "activity:9",
      },
    ]);
    probe.state.noteTaken(taken);
    expect(subjects().at(-1)).toBe("Second:false");
    const first = probe.state.groups[1]?.prose;
    expect(first !== undefined && "note" in first ? first.note : "").toBe(
      CARRIED_NOTE,
    );
  });

  test("a sub-agent's Stop goes to the period; an owner without the ability asks nothing", async () => {
    const probe = world();
    probe.state.begin([listed("ses_1", "gper_1", AT)], probe.server);
    probe.state.open("ses_1");
    await settle();
    expect(probe.state.abilities.stopSubagent).toBe(true);
    await probe.state.stopSubagent("call_7");
    expect(probe.calls).toContain("stopSubagent gper_1 call_7");
    expect(probe.state.notice).toBe("The sub-agent was stopped.");

    const without = world({ leaveOut: ["stopSubagent"] });
    without.state.begin([listed("ses_1", "gper_1", AT)], without.server);
    without.state.open("ses_1");
    await settle();
    expect(without.state.abilities.stopSubagent).toBe(false);
    await without.state.stopSubagent("call_7");
    expect(without.calls.some((call) => call.startsWith("stopSubagent"))).toBe(
      false,
    );
  });

  test("a closed frame routed by goalId reads the list and the replay again, and docks no later question", async () => {
    const probe = world();
    probe.state.begin([listed("ses_1", "gper_1", AT)], probe.server);
    probe.state.open("ses_1");
    await settle();
    const before = probe.calls.length;
    const closed = (route: Partial<LiveConnection>): LiveConnection =>
      ({
        _tag: "connection",
        state: "closed",
        detail: "",
        at: AT,
        attemptId: null,
        roundId: null,
        goalId: null,
        importId: null,
        ...route,
      }) as LiveConnection;
    // An importer's frame for the same id is not this owner's.
    probe.state.noteConnection(closed({ importId: "gper_1" }));
    await settle();
    expect(probe.calls.slice(before)).toEqual([]);
    probe.state.noteConnection(closed({ goalId: "gper_1" }));
    await settle();
    expect(probe.calls.slice(before)).toEqual(["reread", "history gper_1"]);
    probe.state.noteQuestion(asked());
    expect(probe.state.question).toBeUndefined();
  });
});
