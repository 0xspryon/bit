/**
 * The generic chat state through an owner that is not the importer (A6 chat generalisation,
 * slice 2): a test-only **probe goal** whose frames are routed by `goalId`, over
 * `ConversationSessions`, `conversationServer` and `chatSessionOf` — the three pieces a goal
 * chat is to be built from — with fake endpoints standing in for its routes.
 */
import { describe, expect, test } from "bun:test";

import type {
  ConversationStopped,
  LiveConnection,
  LiveItem,
  LiveQuestion,
} from "@bit/contracts";

import type { Call } from "../../src/lib/client";
import {
  NO_HISTORY,
  type ConversationReplayView,
  type ConversationSession,
} from "../../src/lib/conversationChat";
import { chatSessionOf } from "../../src/lib/conversationChatSession";
import {
  conversationServer,
  type ConversationEndpoints,
} from "../../src/lib/conversationServer";
import {
  ConversationSessions,
  type ConversationBinding,
} from "../../src/lib/conversationSessions.svelte";
import { AT, ok, replayItem } from "../fakeServer";

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
  } = {},
) => {
  const calls: string[] = [];
  const forgotten: string[] = [];
  let live: readonly LiveItem[] = [];
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
    open: (text) => {
      calls.push(`open ${text}`);
      return Promise.resolve({ call: ok(next) });
    },
    send: (id, text, urgency) => {
      calls.push(`send ${id} ${text} ${urgency ?? "queued"}`);
      return Promise.resolve(ok(next));
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
      Promise.resolve(
        ok({ conversationId: id, turn: "idle" as const, background: false }),
      ),
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
      reread: () => Promise.resolve(),
      wait: () => Promise.resolve(),
      after: () => () => undefined,
      parked: { read: () => ({}), write: () => undefined },
      harnessName: () => "Probe harness",
      harnessDriver: () => undefined,
    },
    endpoints,
  );
  const state = new ConversationSessions(
    BINDING,
    () => AT,
    () => live,
  );
  return {
    state,
    server,
    calls,
    forgotten,
    setLive: (items: readonly LiveItem[]) => {
      live = items;
    },
    answerNext: (turn: ProbeTurn) => {
      next = turn;
    },
  };
};

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

  test("the shell's session says the owner's lost notice, and nothing once it is closed", () => {
    const probe = world();
    let frame: LiveConnection | undefined;
    probe.state.begin([listed("ses_1", "gper_1", AT)], probe.server);
    probe.state.open("ses_1");
    const { chat } = chatSessionOf({
      state: probe.state,
      words: {
        shell: {
          working: "",
          copyReply: "",
          stopTurn: "",
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
        stopAll: "",
        placeholder: () => "",
        stranded: () => ({ note: "", placeholder: "" }),
        ended: { note: "", placeholder: "" },
        reading: () => "",
        sendNow: () => "",
        sentNow: () => "",
      },
      label: () => "Goal chat",
      endedReason: "goal_ended",
      connection: (id) => (id === "gper_1" ? frame : undefined),
      stoppableSubagents: () => 0,
      maxChars: 100,
      loadFile: () => Promise.reject(new Error("no files")),
    });
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

  test("Stop goes to the period; Stop all without the ability falls back to Stop", async () => {
    const probe = world({ leaveOut: ["stopAll"] });
    probe.state.begin([listed("ses_1", "gper_1", AT)], probe.server);
    probe.state.open("ses_1");
    await settle();
    await probe.state.stop();
    await probe.state.stop(true);
    expect(probe.calls.filter((call) => call.startsWith("stop"))).toEqual([
      "stop gper_1",
      "stop gper_1",
    ]);
  });

  test("a question routed by goalId docks, and its answer goes to the period", async () => {
    const probe = world();
    probe.state.begin([listed("ses_1", "gper_1", AT)], probe.server);
    probe.state.open("ses_1");
    await settle();
    const question: LiveQuestion = {
      _tag: "question",
      question: {
        questionId: "q_1",
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
        answerability: "live",
        // The A9 seam: a critical action, carried through untouched.
        tag: "critical",
        attemptId: null,
        roundId: null,
        goalId: "gper_1",
        importId: null,
      },
      questionId: "q_1",
      settled: null,
      at: AT,
      attemptId: null,
      roundId: null,
      goalId: "gper_1",
      importId: null,
    } as unknown as LiveQuestion;
    probe.state.noteQuestion(question);
    expect(probe.state.question?.questionId).toBe("q_1");
    expect(probe.state.question?.tag).toBe("critical");
    await probe.state.answerQuestion({ "Change production?": ["Deny"] });
    expect(probe.calls).toContain("answer gper_1 q_1");
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
});
