/**
 * The conversation core through an owner that is not the importer (A6 chat generalisation,
 * slice 2): proof that a goal, a planner stage or a worker attempt can be a binding without
 * touching the core.
 *
 * The owner here is a test-only **probe**: its rows live in a map, its credential is a
 * goal's (the kind a goal binding will mint), and its frames go out under the goal subject,
 * keyed by period id. Everything else — the registry, the narration bus, the credentials,
 * the role directory — is the production code, over a stub harness.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ConversationModelRefused,
  QuestionRefused,
  type ConversationQueuedMessage,
  type PendingQuestion,
} from "@bit/contracts";
import { Deferred, Effect, Layer, Queue, Scope, Stream, Context } from "effect";

import {
  makeConversations,
  type ConversationAccepted,
  type ConversationBinding,
  type ConversationRow,
  type ConversationSend,
  type Conversations,
} from "./conversations";
import type {
  HarnessNarration,
  HarnessQuestion,
} from "../harness/agentHarness";
import type { LiveSessionCloseReason } from "../harness/liveAgentSessions";
import { HarnessResolver } from "../harness/resolver";
import {
  scriptedQuestions,
  STUB_INSTANCE,
  stubHarness,
} from "../harness/stubHarness";
import { McpCredentials } from "../mcp/credentials";
import { FleetStore } from "../persistence/fleet";
import { RunNarrations, type RunNarration } from "../run/narration";

const base = mkdtempSync(join(tmpdir(), "bit-conversations-"));
const workspace = join(base, "work");
mkdirSync(workspace, { recursive: true });
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

const TARGET = "probe-target";
const URLS = {
  mcp: "http://127.0.0.1:9/mcp",
  plannerMcp: "http://127.0.0.1:9/planner",
  goalMcp: "http://127.0.0.1:9/goal",
  importerMcp: "http://127.0.0.1:9/importer",
};

/** A probe period's row: the core's fields and nothing of its own. */
interface ProbeRow extends ConversationRow {
  readonly openedAt: number;
}

/** What a probe's accepted message is on its (imaginary) wire: the core's, renamed. */
interface ProbeAccepted extends Omit<ConversationAccepted, "conversationId"> {
  readonly probeId: string;
  readonly widened: number;
}

class ProbeNotFound {
  readonly _tag = "ProbeNotFound";
  constructor(readonly detail: string) {}
}
class ProbeRefused {
  readonly _tag = "ProbeRefused";
  constructor(
    readonly reason: string,
    readonly detail: string,
  ) {}
}

type ProbeCore = Conversations<
  { readonly opener: string },
  ProbeNotFound,
  ProbeRefused,
  ProbeAccepted
>;

/**
 * One world: a registered target, a stub harness with a narration queue, a probe core.
 * `holdTurns` keeps every turn running (the harness never goes idle), as a real turn is
 * while a message waits behind it.
 */
const world = (options: { readonly holdTurns?: boolean } = {}) =>
  Effect.gen(function* () {
    let root = 0;
    root += 1;
    const fleetRoot = join(base, `fleet-${String(Date.now())}-${String(root)}`);
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      Layer.mergeAll(
        FleetStore.layer(fleetRoot),
        McpCredentials.layer,
        RunNarrations.layer,
      ),
      scope,
    );
    const fleet = Context.get(context, FleetStore);
    const credentials = Context.get(context, McpCredentials);
    const narrations = Context.get(context, RunNarrations);
    yield* fleet.register({
      targetId: TARGET,
      name: "Probe",
      scopeNote: "",
      workspacePath: workspace,
    });
    yield* fleet.migrateTarget(TARGET);

    const events = yield* Queue.unbounded<HarnessNarration>();
    const questions = scriptedQuestions();
    const prompts: string[] = [];
    const harness = stubHarness({
      ...questions.members,
      sessionEvents: () => Stream.fromQueue(events),
      ...(options.holdTurns === true
        ? { waitForIdle: () => Effect.never }
        : {}),
      prompt: (_sessionId, text) =>
        Effect.sync(() => {
          prompts.push(text);
          return { delivered: true };
        }),
    });
    const resolver = HarnessResolver.fromEntries([
      { instance: STUB_INSTANCE, harness },
    ]);

    const rows = new Map<string, ProbeRow>();
    const ended: { id: string; reason: LiveSessionCloseReason }[] = [];
    let minted = 0;
    const reopened: string[] = [];

    // Declared before the core so the binding's reopen can name it.
    const holder: { core: ProbeCore | undefined } = { core: undefined };
    const opener = Effect.fnUntraced(function* (input: {
      readonly text: string;
      readonly predecessor?: string;
      readonly resume?: string;
    }) {
      const core = holder.core;
      if (core === undefined) return yield* Effect.die("no core");
      minted += 1;
      const id = `prb_${String(minted)}`;
      const sessionId = input.resume ?? harness.newSessionId();
      const opening = yield* Deferred.make<
        Parameters<ProbeCore["acceptedOf"]>[0],
        ProbeRefused
      >();
      yield* core.begin({
        id,
        targetId: TARGET,
        predecessor: input.predecessor,
        opening,
        before: Effect.sync(() => {
          rows.set(id, {
            targetId: TARGET,
            harnessSessionId: sessionId,
            harnessInstanceId: STUB_INSTANCE.instanceId,
            model: STUB_INSTANCE.defaultModel,
            modelOptions: null,
            endedReason: null,
            latestId: null,
            openedAt: Date.now(),
          });
          // Every row of the session now points at its newest period, as the index reads it.
          for (const [key, row] of rows) {
            if (row.harnessSessionId === sessionId) {
              rows.set(key, { ...row, latestId: id });
            }
          }
        }),
        plan: {
          targetId: TARGET,
          harness,
          model: STUB_INSTANCE.defaultModel,
          sessionId,
          ...(input.resume === undefined ? {} : { resume: input.resume }),
          title: "probe",
          ensureDirectory: fleet.ensureGoalDirectory(TARGET, id),
          operatorQuestions: true,
          workspace,
          openingPrompt: () => `open: ${input.text}`,
          meta: { opener: input.text },
        },
        failed: () => Effect.void,
      });
      const entry = yield* Deferred.await(opening);
      return { entry, core };
    });

    const binding: ConversationBinding<
      { readonly opener: string },
      ProbeRow,
      ProbeNotFound,
      ProbeRefused,
      number,
      ProbeAccepted
    > = {
      role: {
        endpoint: (urls) => urls.goalMcp,
        issue: (input) =>
          credentials.issueWithoutExpiry({
            _tag: "goal",
            targetId: input.targetId,
            goalId: input.id,
          }),
        revokeStray: credentials.revokeGoal,
        words: {
          unregisterRefused: "probe: unregister refused",
          strayCredential: "probe: stray credential",
          closed: "probe: closed",
          idKey: "probeId",
        },
      },
      // A non-importer subject: the frames say `goalId`, which is the period id here.
      subject: (id) => ({ _tag: "goal", goalId: id }),
      questionSubject: (id) => ({
        attemptId: null,
        roundId: null,
        goalId: id,
        importId: null,
      }),
      rows: {
        read: (targetId, id) =>
          Effect.sync(() => {
            const row = rows.get(id);
            return row?.targetId === targetId ? row : undefined;
          }),
        markEnded: (_targetId, id, reason) =>
          Effect.sync(() => {
            ended.push({ id, reason });
            const row = rows.get(id);
            if (row !== undefined && row.endedReason === null) {
              rows.set(id, { ...row, endedReason: reason });
            }
          }),
        recordModel: (_targetId, input) =>
          Effect.sync(() => {
            const row = rows.get(input.id);
            if (row === undefined) return false;
            rows.set(input.id, {
              ...row,
              model: input.model,
              modelOptions: input.modelOptions ?? null,
            });
            return true;
          }),
      },
      notFound: (targetId, id, clause) =>
        new ProbeNotFound(`no probe '${id}' on '${targetId}', so ${clause}`),
      openRefused: (failure) => new ProbeRefused("open", failure.message),
      refused: (reason, detail) => new ProbeRefused(reason, detail),
      followUp: (meta, text) => `follow-up to "${meta.opener}": ${text}`,
      reopen: ({ send, row }) =>
        Effect.gen(function* () {
          reopened.push(send.conversationId);
          const { entry, core } = yield* opener({
            text: send.text,
            predecessor: send.conversationId,
            resume: row.harnessSessionId,
          });
          return binding.accepted(
            core.acceptedOf(entry, "resumed", "taken back over"),
            0,
          );
        }),
      accepted: (accepted, widened) => {
        const { conversationId, ...rest } = accepted;
        return { ...rest, probeId: conversationId, widened };
      },
      words: {
        what: (id) => `probe ${id}`,
        agent: "probe agent",
        undelivered: (detail) => `${detail}; closed`,
        unwritable: (detail) => `${detail}; kept`,
        narrationFailed: "probe: narration failed",
        stoppedBeforeOpen: (id) => `probe ${id} stopped before it opened`,
        ended: (id) => `probe ${id} was ended`,
      },
      hooks: {
        delivering: (_entry, text) => Effect.succeed(text.length),
        resumed: () => Effect.succeed(true),
        idle: () => Effect.succeed("settled" as const),
        alsoRunning: () => Effect.succeed(false),
        switched: () => Effect.void,
      },
    };

    const core = yield* makeConversations(
      {
        endpoints: { urls: Effect.succeed(URLS) },
        narrations,
        resolver,
        recheck: { first: "5 millis", most: "20 millis", window: "1 second" },
        scope,
      },
      binding,
    ).pipe(Scope.provide(scope));
    holder.core = core;

    /** Collects what the bus publishes for one period, from now on. */
    const listen = (id: string) =>
      Effect.gen(function* () {
        const seen: RunNarration[] = [];
        yield* narrations.subscribe({ goalId: id }).pipe(
          Stream.runForEach((item) => Effect.sync(() => seen.push(item))),
          Effect.forkIn(scope),
        );
        // Subscribed before anything is published.
        for (let i = 0; i < 100; i += 1) {
          if ((yield* narrations.subscriberCount) > 0) break;
          yield* Effect.sleep("2 millis");
        }
        return seen;
      });

    return {
      core,
      open: (text: string) => opener({ text }),
      events,
      questions,
      prompts,
      rows,
      ended,
      reopened,
      listen,
      close: Scope.close(scope, { _tag: "Success", value: undefined } as never),
      send: (input: Omit<ConversationSend, "targetId">) =>
        core.send({ targetId: TARGET, ...input }),
    };
  });

const run = <A, E>(
  body: (
    probe: Effect.Success<ReturnType<typeof world>>,
  ) => Effect.Effect<A, E>,
  options: { readonly holdTurns?: boolean } = {},
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const probe = yield* world(options);
      return yield* body(probe).pipe(Effect.ensuring(probe.close));
    }).pipe(Effect.orDie),
  );

const question = (id: string): HarnessQuestion => ({
  questionId: id,
  fields: [
    {
      key: "Include staging?",
      header: "Scope",
      question: "Include staging?",
      kind: "one",
      options: [
        { label: "Yes", description: null },
        { label: "No", description: null },
      ],
      custom: false,
      required: true,
    },
  ],
  askedAt: 1,
  callId: id,
});

describe("the conversation core through a non-importer owner", () => {
  test("open, then a live message is delivered under the same period, held until written", async () => {
    const result = await run(
      (probe) =>
        Effect.gen(function* () {
          const { entry } = yield* probe.open("hello");
          const sent = yield* probe.send({
            conversationId: entry.id,
            text: "and then?",
            urgency: "preemptive",
          });
          const held = yield* probe.core.heldSteers(entry.id);
          // The take marks the held message taken; the replay carries it beside a transcript
          // that does not hold it yet.
          yield* Queue.offer(probe.events, {
            type: "taken",
            sequence: undefined,
            at: Date.now(),
            outcome: undefined,
            detail: { _tag: "taken", messageIds: [sent.messageId ?? ""] },
          });
          let queued: readonly ConversationQueuedMessage[] = [];
          for (let i = 0; i < 100; i += 1) {
            const replayed = yield* probe.core.replay({
              id: entry.id,
              fromTranscript: () => null,
              read: (live) =>
                Effect.succeed({ live: live !== undefined, question: null }),
            });
            queued = replayed.queued;
            if (queued[0]?.taken === true) break;
            yield* Effect.sleep("5 millis");
          }
          // A replay that finds it written lets it go.
          yield* probe.core.replay({
            id: entry.id,
            fromTranscript: () => null,
            read: (_live, onTranscript) =>
              Effect.sync(() => {
                onTranscript(new Set([sent.messageId ?? ""]));
                return { live: true, question: null };
              }),
          });
          return {
            sent,
            held,
            queued,
            after: yield* probe.core.heldSteers(entry.id),
            prompts: probe.prompts,
          };
        }),
      { holdTurns: true },
    );
    expect(result.sent.conversation).toBe("continued");
    expect(result.sent.probeId).toBe("prb_1");
    expect(result.sent.widened).toBe("and then?".length);
    expect(result.sent.messageId).toBeString();
    expect(result.held).toBe(1);
    expect(result.queued.map((each) => [each.text, each.taken])).toEqual([
      ["and then?", true],
    ]);
    expect(result.after).toBe(0);
    expect(result.prompts).toEqual([
      "open: hello",
      'follow-up to "hello": and then?',
    ]);
  });

  test("a period this process let go of is reopened under a new id, and an old id follows it", async () => {
    const result = await run((probe) =>
      Effect.gen(function* () {
        const { entry } = yield* probe.open("first");
        // The server let go (not the operator): a restart, a refused prompt.
        yield* probe.core.sessions.close(entry.id, "shutdown");
        const reopened = yield* probe.send({
          conversationId: entry.id,
          text: "still there?",
        });
        // An old tab's message to the first id lands in the successor, live.
        const followed = yield* probe.send({
          conversationId: entry.id,
          text: "again",
        });
        return {
          reopened,
          followed,
          reopens: probe.reopened,
          rows: [...probe.rows.entries()].map(([id, row]) => [
            id,
            row.harnessSessionId,
            row.endedReason,
            row.latestId,
          ]),
        };
      }),
    );
    expect(result.reopened.conversation).toBe("resumed");
    expect(result.reopened.probeId).toBe("prb_2");
    expect(result.followed.conversation).toBe("continued");
    expect(result.followed.probeId).toBe("prb_2");
    expect(result.reopens).toEqual(["prb_1"]);
    // One session, two periods: the old one's end kept, both pointing at the newest.
    expect(result.rows).toEqual([
      ["prb_1", "ses_stub_1", "shutdown", "prb_2"],
      ["prb_2", "ses_stub_1", null, "prb_2"],
    ]);
  });

  test("an ended period refuses a message; an unknown one is the owner's 404", async () => {
    const result = await run((probe) =>
      Effect.gen(function* () {
        const { entry } = yield* probe.open("first");
        const listened = yield* probe.listen(entry.id);
        yield* probe.core.end(TARGET, entry.id);
        const refused = yield* Effect.flip(
          probe.send({ conversationId: entry.id, text: "hello?" }),
        );
        const unknown = yield* Effect.flip(
          probe.send({ conversationId: "prb_nope", text: "hello?" }),
        );
        for (let i = 0; i < 100 && listened.length === 0; i += 1) {
          yield* Effect.sleep("5 millis");
        }
        return { refused, unknown, ended: probe.ended, listened };
      }),
    );
    expect(result.refused).toMatchObject({
      _tag: "ProbeRefused",
      reason: "ended",
      detail: "probe prb_1 was ended",
    });
    expect(result.unknown).toMatchObject({ _tag: "ProbeNotFound" });
    expect(result.ended[0]).toEqual({ id: "prb_1", reason: "operator" });
    // The narrator's last word, under the owner's subject: what clears a chat's notice.
    const closed = result.listened.find(
      (item) => item.entry.type === "bit.connection.closed",
    );
    expect(closed?.subject).toEqual({ _tag: "goal", goalId: "prb_1" });
  });

  test("Stop, Stop all and activity answer for the period holding the session", async () => {
    const result = await run((probe) =>
      Effect.gen(function* () {
        const { entry } = yield* probe.open("first");
        const stopped = yield* probe.core.stopTurn({
          targetId: TARGET,
          conversationId: entry.id,
        });
        const all = yield* probe.core.stopAll({
          targetId: TARGET,
          conversationId: entry.id,
        });
        const activity = yield* probe.core.activity({
          targetId: TARGET,
          conversationId: entry.id,
        });
        const subagent = yield* Effect.flip(
          probe.core.stopSubagent({
            targetId: TARGET,
            conversationId: entry.id,
            callId: "call_1",
          }),
        );
        return { stopped, all, activity, subagent };
      }),
    );
    expect(result.stopped).toMatchObject({
      conversationId: "prb_1",
      outcome: "idle",
    });
    expect(result.all).toMatchObject({
      conversationId: "prb_1",
      outcome: "idle",
    });
    // Held by this process, so live: idle or running depending on whether the registry's
    // idle watch has run yet, never `not_live`.
    expect(result.activity.conversationId).toBe("prb_1");
    expect(result.activity.turn).not.toBe("not_live");
    expect(result.activity.background).toBe(false);
    expect(result.subagent).toMatchObject({ reason: "not_running" });
  });

  test("a question is offered live under the owner's subject, answered once, then settled", async () => {
    const result = await run((probe) =>
      Effect.gen(function* () {
        const { entry } = yield* probe.open("first");
        probe.questions.ask(entry.sessionId, question("q_1"));
        const replayed = yield* probe.core.replay({
          id: entry.id,
          fromTranscript: () => null,
          read: () => Effect.succeed({ live: true }),
        });
        const answered = yield* probe.core.answerQuestion({
          targetId: TARGET,
          conversationId: entry.id,
          questionId: "q_1",
          answers: { "Include staging?": ["Yes"] },
        });
        const again = yield* Effect.flip(
          probe.core.answerQuestion({
            targetId: TARGET,
            conversationId: entry.id,
            questionId: "q_1",
            answers: { "Include staging?": ["Yes"] },
          }),
        );
        // One read back from a transcript: put away, and no longer offered.
        const asked = question("call:toolu_1");
        const fromTranscript: PendingQuestion = {
          questionId: asked.questionId,
          fields: asked.fields as PendingQuestion["fields"],
          askedAt: asked.askedAt ?? null,
          harnessSessionId: entry.sessionId,
          answerability: "message",
          attemptId: null,
          roundId: null,
          goalId: entry.id,
          importId: null,
        };
        const dismissed = yield* probe.core.dismissQuestion({
          targetId: TARGET,
          conversationId: entry.id,
          questionId: "call:toolu_1",
        });
        const after = yield* probe.core.replay({
          id: entry.id,
          fromTranscript: () => fromTranscript,
          read: () => Effect.succeed({ live: true }),
        });
        return { replayed, answered, again, dismissed, after };
      }),
    );
    expect(result.replayed.question).toMatchObject({
      questionId: "q_1",
      answerability: "live",
      goalId: "prb_1",
      importId: null,
    });
    expect(result.answered).toEqual({
      questionId: "q_1",
      settled: "answered",
    });
    expect(result.again).toBeInstanceOf(QuestionRefused);
    expect(result.again).toMatchObject({ reason: "settled" });
    expect(result.dismissed.settled).toBe("dismissed");
    expect(result.after.question).toBeNull();
  });

  test("a model switch is checked against the period's harness and written to its row", async () => {
    const result = await run((probe) =>
      Effect.gen(function* () {
        const { entry } = yield* probe.open("first");
        const other = STUB_INSTANCE.models.find(
          (model) => model.id !== STUB_INSTANCE.defaultModel,
        );
        const switched = yield* probe.core.switchModel({
          targetId: TARGET,
          conversationId: entry.id,
          model: other?.id ?? "",
        });
        const refused = yield* Effect.flip(
          probe.core.switchModel({
            targetId: TARGET,
            conversationId: entry.id,
            model: "nobody/nothing",
          }),
        );
        return {
          switched,
          refused,
          row: probe.rows.get(entry.id),
          other: other?.id,
        };
      }),
    );
    expect(result.switched).toMatchObject({
      conversationId: "prb_1",
      applied: "live",
    });
    expect(result.row?.model).toBe(result.other ?? "");
    expect(result.refused).toBeInstanceOf(ConversationModelRefused);
  });
});
