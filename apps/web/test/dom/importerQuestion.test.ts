/**
 * The importer's question dock (A7-Q) on the real page: a question the replay offers or a
 * live frame brings docks in the box's place; answering, dismissing and the `message`
 * fallback reach the server under the session's import; a refusal is the F2 dialog; a
 * withdrawn question and a closed session read the replay again; and a question moves the
 * rail's count at once. Strings and booleans only.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  QuestionRefused,
  type ImporterSessionView,
  type LiveQuestion,
  type PendingQuestion,
} from "@bit/contracts";

import { App } from "../../src/lib/app.svelte";
import TitleBar from "../../src/lib/components/TitleBar.svelte";
import Target from "../../src/lib/screens/Target.svelte";
import { FakeCountdown } from "../fakeCountdown";
import {
  FakeServer,
  agentSessionsPage,
  emptyScope,
  importerConversationView,
  importerSessionView,
  importerTurnAccepted,
  liveOpened,
  ok,
  refused,
} from "../fakeServer";
import { click, mountInto, settle, type Mounted } from "./dom";

let mounted: Mounted[] = [];
afterEach(() => {
  for (const each of mounted) each.destroy();
  mounted = [];
});

const SESSIONS: ImporterSessionView[] = [
  importerSessionView({
    sessionId: "ses_newest",
    importId: "imp_newest",
    model: "anthropic/claude-newest",
    harnessInstanceId: "claude-code",
    openedAt: 1_700_000_200_000,
  }),
];

const QUESTION = (over: Partial<PendingQuestion> = {}): PendingQuestion => ({
  questionId: "toolu_1",
  harnessSessionId: "ses_newest",
  fields: [
    {
      key: "Which hosts?",
      header: "Hosts",
      question: "Which hosts?",
      kind: "one",
      options: [
        { label: "api.acme.test", description: null },
        { label: "www.acme.test", description: null },
      ],
      custom: true,
      required: false,
    },
  ],
  askedAt: 1_700_000_300_000,
  answerability: "live",
  attemptId: null,
  roundId: null,
  goalId: null,
  importId: "imp_newest",
  ...over,
});

const frame = (over: Partial<LiveQuestion>): LiveQuestion => ({
  _tag: "question",
  questionId: "toolu_1",
  question: null,
  settled: null,
  attemptId: null,
  roundId: null,
  goalId: null,
  importId: "imp_newest",
  at: Date.now(),
  ...over,
});

const button = (label: string): HTMLButtonElement => {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find(
    (each) =>
      (each.getAttribute("aria-label") ?? each.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim() === label,
  );
  if (found === undefined) throw new Error(`no "${label}" button`);
  return found;
};
const dock = () => document.querySelector(".importer .stack > .dock");
const radios = () => [
  ...document.querySelectorAll<HTMLInputElement>(
    ".importer .current input[type=radio]",
  ),
];

/** The newest session continued on the Assets page, its replay answered by `question`. */
const continueWith = async (
  fake: FakeServer,
  question: PendingQuestion | null = null,
): Promise<App> => {
  fake.onScope = () => ok(emptyScope());
  fake.onImporterSessions = () => ok({ sessions: SESSIONS });
  fake.onHarnesses = () =>
    ok([
      {
        instanceId: "claude-code",
        driver: "claude-code",
        displayName: "Claude Code",
        version: "1.0.0",
        ready: true,
        auth: "authenticated" as const,
        isDefault: true,
        defaultModel: "m",
        models: [{ id: "m" }],
      },
    ]);
  fake.onImporterMessages = (_baseUrl, targetId, importId) =>
    ok(
      importerConversationView({
        targetId,
        importId,
        live: true,
        continuation: "live",
        question,
      }),
    );
  const app = new App(fake, new FakeCountdown());
  app.password = "correct-horse";
  await app.connect();
  app.openTarget("acme-corp");
  await settle();
  app.toSection("assets");
  await settle();
  app.toAssetsTab("scope");
  await settle();
  mounted.push(mountInto(TitleBar, { app }), mountInto(Target, { app }));
  await settle();
  click(
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((each) =>
      (each.textContent ?? "").includes("Continue that session"),
    )!,
  );
  await settle();
  return app;
};

describe("the importer's question dock (A7-Q)", () => {
  test("a question the replay offers docks in the box's place, and an answer goes to the session's import", async () => {
    const fake = new FakeServer();
    await continueWith(fake, QUESTION());
    expect(dock()).not.toBeNull();
    expect(document.querySelector(".importer form.box")).toBeNull();
    expect(
      dock()
        ?.querySelector(".counter")
        ?.textContent?.replace(/\s+/g, " ")
        .trim(),
    ).toBe("Question 1 of 1");
    // Asked by the agent the session runs as.
    expect(dock()?.querySelector("section")?.getAttribute("aria-label")).toBe(
      "The importer's questions",
    );
    click(radios()[1]!);
    await settle();
    click(button("Send 1 answer"));
    await settle();
    const [call] = fake.calls
      .filter((each) => each.method === "answerImporterQuestion")
      .map((each) => each.args);
    expect(JSON.stringify(call?.slice(1))).toBe(
      JSON.stringify([
        "acme-corp",
        "imp_newest",
        "toolu_1",
        { "Which hosts?": ["www.acme.test"] },
      ]),
    );
    expect(dock()).toBeNull();
    expect(document.querySelector(".importer form.box")).not.toBeNull();
  });

  test("a live question docks, a settled frame gives the box back, and a withdrawn one reads the replay again", async () => {
    const fake = new FakeServer();
    const app = await continueWith(fake);
    fake.watch.send(liveOpened());
    expect(dock()).toBeNull();
    fake.watch.send(frame({ question: QUESTION() }));
    await settle();
    expect(dock()).not.toBeNull();
    // Another session's question is not this chat's.
    fake.watch.send(
      frame({
        questionId: "toolu_x",
        importId: "imp_other",
        question: QUESTION({ questionId: "toolu_x", importId: "imp_other" }),
      }),
    );
    await settle();
    expect(app.importer.question?.questionId).toBe("toolu_1");
    fake.watch.send(frame({ settled: "answered" }));
    await settle();
    expect(dock()).toBeNull();

    fake.watch.send(frame({ question: QUESTION() }));
    await settle();
    // A Stop withdrew it: the replay, read again, offers it as a message.
    fake.onImporterMessages = (_baseUrl, targetId, importId) =>
      ok(
        importerConversationView({
          targetId,
          importId,
          live: true,
          continuation: "live",
          question: QUESTION({
            questionId: "call:toolu_1",
            answerability: "message",
          }),
        }),
      );
    const asked = fake.countOf("importerMessages");
    fake.watch.send(frame({ settled: "withdrawn" }));
    await settle();
    expect(fake.countOf("importerMessages")).toBe(asked + 1);
    expect(app.importer.question?.answerability).toBe("message");
    expect(
      document.querySelector(".importer .dock .note")?.textContent,
    ).toContain("ordinary message");
  });

  test("the message fallback posts the answers as a message, and leaves the draft and files alone", async () => {
    const fake = new FakeServer();
    const app = await continueWith(
      fake,
      QUESTION({ questionId: "call:toolu_1", answerability: "message" }),
    );
    app.importer.draft = "my own half-written words";
    fake.onSendImporterMessage = (_baseUrl, targetId, importId) =>
      ok(
        importerTurnAccepted({ targetId, importId, conversation: "continued" }),
      );
    click(radios()[0]!);
    await settle();
    click(button("Send 1 answer as a message"));
    await settle();
    const [call] = fake.calls
      .filter((each) => each.method === "sendImporterMessage")
      .map((each) => each.args);
    expect(call?.[2]).toBe("imp_newest");
    expect(call?.[3]).toBe(
      "My answers to your questions:\n- Which hosts? — api.acme.test",
    );
    expect(fake.countOf("answerImporterQuestion")).toBe(0);
    expect(app.importer.draft).toBe("my own half-written words");
    expect(dock()).toBeNull();
  });

  test("a dismissal reaches the server; a refusal is the error dialog and reads the replay again", async () => {
    const fake = new FakeServer();
    await continueWith(fake, QUESTION());
    fake.onDismissImporterQuestion = (
      _baseUrl,
      _targetId,
      _importId,
      questionId,
    ) =>
      refused(
        new QuestionRefused({
          questionId,
          reason: "settled",
          detail: "The agent is no longer waiting on these questions.",
        }),
      );
    const asked = fake.countOf("importerMessages");
    click(button("Dismiss these questions"));
    await settle();
    expect(fake.countOf("dismissImporterQuestion")).toBe(1);
    const dialog = document.querySelector("[role=alertdialog]");
    expect(dialog?.textContent).toContain("Questions not dismissed");
    expect(dialog?.textContent).toContain(
      "The agent is no longer waiting on these questions.",
    );
    expect(fake.countOf("importerMessages")).toBe(asked + 1);
  });

  test("a dismissal the harness could not be told of still puts the dock away, and says the agent was not told", async () => {
    const fake = new FakeServer();
    await continueWith(fake, QUESTION());
    fake.onDismissImporterQuestion = (
      _baseUrl,
      _targetId,
      _importId,
      questionId,
    ) =>
      refused(
        new QuestionRefused({
          questionId,
          reason: "harness_unreachable",
          detail:
            "the harness did not answer (connection refused), so whether the agent was told you declined is not known.",
        }),
      );
    expect(dock()).not.toBeNull();
    click(button("Dismiss these questions"));
    await settle();
    expect(fake.countOf("dismissImporterQuestion")).toBe(1);
    // The box is back: the dock no longer holds it hostage to a harness that is down.
    expect(dock()).toBeNull();
    expect(document.querySelector(".importer .stack textarea")).not.toBeNull();
    // Said above the box, as an alert: the dock's own dialog went with the dock.
    expect(document.querySelector("[role=alertdialog]")).toBeNull();
    const said = document.querySelector(".importer .stack > .notice.refusal");
    expect(said?.getAttribute("role")).toBe("alert");
    expect(said?.textContent).toContain(
      "Questions put away, but the agent was not told: the harness did not answer (connection refused)",
    );
  });

  test("an answer the harness could not take keeps the dock and the answers", async () => {
    const fake = new FakeServer();
    await continueWith(fake, QUESTION());
    fake.onAnswerImporterQuestion = (
      _baseUrl,
      _targetId,
      _importId,
      questionId,
    ) =>
      refused(
        new QuestionRefused({
          questionId,
          reason: "harness_unreachable",
          detail:
            "the harness did not answer (x). Your answers are kept; try again.",
        }),
      );
    click(radios()[0]!);
    await settle();
    click(button("Send 1 answer"));
    await settle();
    expect(fake.countOf("answerImporterQuestion")).toBe(1);
    expect(dock()).not.toBeNull();
    expect(radios()[0]?.checked).toBe(true);
    expect(document.querySelector("[role=alertdialog]")?.textContent).toContain(
      "Answers not sent",
    );
  });

  test("a lost connection reads the rail's count again: the server no longer counts its question", async () => {
    const fake = new FakeServer();
    const app = await continueWith(fake);
    fake.watch.send(liveOpened());
    fake.onAgentSessions = () =>
      ok(
        agentSessionsPage([], {
          counts: { active: 1, ended: 0, all: 1, needsYou: 1 },
        }),
      );
    fake.watch.send(frame({ question: QUESTION() }));
    await settle();
    expect(app.agentSessionCounts?.needsYou).toBe(1);
    fake.onAgentSessions = () =>
      ok(
        agentSessionsPage([], {
          counts: { active: 1, ended: 0, all: 1, needsYou: 0 },
        }),
      );
    const reconnecting = fake.countOf("agentSessions");
    fake.watch.send({
      _tag: "connection",
      state: "reconnecting",
      detail: "socket",
      attemptId: null,
      roundId: null,
      goalId: null,
      importId: "imp_newest",
      at: Date.now(),
    });
    await settle();
    // A break alone is not a reason: the stream may be back in a moment.
    expect(fake.countOf("agentSessions")).toBe(reconnecting);
    fake.watch.send({
      _tag: "connection",
      state: "lost",
      detail: "socket",
      attemptId: null,
      roundId: null,
      goalId: null,
      importId: "imp_newest",
      at: Date.now(),
    });
    await settle();
    expect(fake.countOf("agentSessions")).toBe(reconnecting + 1);
    expect(app.agentSessionCounts?.needsYou).toBe(0);
  });

  test("a closed session's frame clears a connection notice and reads the list and the replay again", async () => {
    const fake = new FakeServer();
    const app = await continueWith(fake);
    fake.watch.send(liveOpened());
    fake.watch.send({
      _tag: "connection",
      state: "lost",
      detail: "gone",
      attemptId: null,
      roundId: null,
      goalId: null,
      importId: "imp_newest",
      at: Date.now(),
    });
    await settle();
    expect(document.body.textContent).toContain("could not be reconnected");
    const lists = fake.countOf("importerSessions");
    const replays = fake.countOf("importerMessages");
    fake.watch.send({
      _tag: "connection",
      state: "closed",
      detail: "this server stopped holding the session",
      attemptId: null,
      roundId: null,
      goalId: null,
      importId: "imp_newest",
      at: Date.now(),
    });
    await settle();
    expect(app.liveConnection["import:imp_newest"]).toBeUndefined();
    expect(document.body.textContent).not.toContain("could not be reconnected");
    expect(fake.countOf("importerSessions")).toBeGreaterThan(lists);
    expect(fake.countOf("importerMessages")).toBe(replays + 1);
  });

  test("a question asked or settled reads the rail's count at once: Needs you", async () => {
    const fake = new FakeServer();
    const app = await continueWith(fake);
    fake.watch.send(liveOpened());
    await settle();
    fake.onAgentSessions = () =>
      ok(
        agentSessionsPage([], {
          counts: { active: 1, ended: 0, all: 1, needsYou: 1 },
        }),
      );
    const before = fake.countOf("agentSessions");
    fake.watch.send(frame({ question: QUESTION() }));
    await settle();
    expect(fake.countOf("agentSessions")).toBe(before + 1);
    expect(app.agentSessionCounts?.needsYou).toBe(1);
    fake.onAgentSessions = () =>
      ok(
        agentSessionsPage([], {
          counts: { active: 1, ended: 0, all: 1, needsYou: 0 },
        }),
      );
    fake.watch.send(frame({ settled: "answered" }));
    await settle();
    expect(app.agentSessionCounts?.needsYou).toBe(0);
  });
});
