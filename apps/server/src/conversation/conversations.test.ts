/**
 * The conversation core through an owner that is not the importer (A6 chat generalisation,
 * slice 2): proof that a goal, a planner stage or a worker attempt can be a binding without
 * touching the core.
 *
 * The owner here is a test-only **probe**: its rows live in a map, its credential is a
 * goal's grant for the owner {@link OWNER} — whose id is not any period's — revoked by the
 * period's own token, and its frames go out under the goal subject, keyed by period id. Everything else — the registry, the narration bus, the credentials,
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
import {
  Deferred,
  Effect,
  Fiber,
  Layer,
  Queue,
  Redacted,
  Scope,
  Stream,
  Context,
} from "effect";

import {
  makeConversations,
  type ConversationAccepted,
  type ConversationBinding,
  type ConversationRow,
  type ConversationSend,
  type Conversations,
} from "./conversations";
import {
  SESSION_NOT_FOUND_TAG,
  SESSION_PROCESS_GONE_TAG,
  type HarnessNarration,
  type HarnessQuestion,
} from "../harness/agentHarness";
import type { LiveSessionCloseReason } from "../harness/liveAgentSessions";
import { HarnessTransportError } from "../harness/errors";
import { HarnessResolver } from "../harness/resolver";
import {
  scriptedQuestions,
  STUB_INSTANCE,
  stubHarness,
} from "../harness/stubHarness";
import { McpCredentials, type IssuedCredential } from "../mcp/credentials";
import { FleetStore } from "../persistence/fleet";
import { RunNarrations, type RunNarration } from "../run/narration";

const base = mkdtempSync(join(tmpdir(), "bit-conversations-"));
const workspace = join(base, "work");
mkdirSync(workspace, { recursive: true });
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

const TARGET = "probe-target";
/** The probe owner: every period here is one of its sessions, as a goal's would be. */
const OWNER = "goal_probe";
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

/** How a world's harness is held, so a test decides when a turn ends or an open lands. */
interface WorldOptions {
  /** Every turn runs for ever (the harness never goes idle). */
  readonly holdTurns?: boolean;
  /**
   * A turn runs until the test ends its wait in failure (`dieTurn`), as a driver whose
   * process died says it: tagged {@link SESSION_PROCESS_GONE_TAG}, or untagged.
   */
  readonly dyingTurns?: boolean;
  /**
   * A turn runs until the test lets it go idle (`goIdle`) or a Stop interrupts it, which
   * the harness answers as a turn interrupted.
   */
  readonly gateTurns?: boolean;
  /** An open's harness session is created only once the test lets it (`letOpen`). */
  readonly gateOpens?: boolean;
  /**
   * An open's MCP registration — after its credential is minted — lands only once the test
   * lets it (`letRegister`), signalling `registering` on the way in.
   */
  readonly gateRegistrations?: boolean;
  /** Every MCP registration fails, so every open fails after its credential was minted. */
  readonly failRegistrations?: boolean;
  /**
   * A harness session is ended (`endSession`) only once the test lets it (`letEnd`),
   * signalling `ending` on the way in: the close is held after the revoke and before the
   * session's scope goes.
   */
  readonly gateEnds?: boolean;
  /**
   * A failed open's `failed` hook runs only once the test lets it (`letFail`), signalling
   * `failing`: the turn is still running with no session and no open in flight.
   */
  readonly gateFailed?: boolean;
}

/**
 * One world: a registered target, a stub harness with a narration queue, a probe core.
 * `holdTurns` keeps every turn running (the harness never goes idle), as a real turn is
 * while a message waits behind it.
 */
const world = (options: WorldOptions = {}) =>
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
    /** How each later message was delivered: a steer's urgency. */
    const urgencies: string[] = [];
    const interrupts: string[] = [];
    /*
     * The turn running now goes idle when this is done. A prompt to a session that has gone
     * idle starts a new turn, with a new gate; one steered into a running turn joins it.
     */
    let idle = Deferred.makeUnsafe<void>();
    const opens = Deferred.makeUnsafe<void>();
    const registering = Deferred.makeUnsafe<void>();
    const registrations = Deferred.makeUnsafe<void>();
    const ending = Deferred.makeUnsafe<void>();
    const ends = Deferred.makeUnsafe<void>();
    const failing = Deferred.makeUnsafe<void>();
    const fails = Deferred.makeUnsafe<void>();
    const goIdle = Effect.suspend(() => Deferred.succeed(idle, undefined));
    /** The turn's wait, for `dyingTurns`: failed by `dieTurn`. */
    const dying = Deferred.makeUnsafe<void, HarnessTransportError>();
    const dieTurn = (tag: string | undefined) =>
      Deferred.fail(
        dying,
        new HarnessTransportError({
          operation: "stub.process",
          status: undefined,
          tag,
          detail: "the stub's process exited mid-turn",
          cause: undefined,
        }),
      );
    /** When set, a steer is refused with it: the harness holds no live session. */
    const steerRefusal: { now: HarnessTransportError | undefined } = {
      now: undefined,
    };
    const harness = stubHarness({
      ...questions.members,
      sessionEvents: () => Stream.fromQueue(events),
      ...(options.holdTurns === true
        ? { waitForIdle: () => Effect.never }
        : {}),
      ...(options.dyingTurns === true
        ? { waitForIdle: () => Deferred.await(dying) }
        : {}),
      ...(options.gateTurns === true
        ? {
            waitForIdle: () => Effect.suspend(() => Deferred.await(idle)),
            interruptSession: (sessionId) =>
              Effect.gen(function* () {
                interrupts.push(sessionId);
                yield* goIdle;
                return true;
              }),
          }
        : {}),
      ...(options.gateOpens === true
        ? {
            createSession: (input) =>
              Effect.as(Deferred.await(opens), {
                id: input.resume ?? input.sessionId ?? "ses_unnamed",
              }),
          }
        : {}),
      ...(options.gateRegistrations === true
        ? {
            registerMcpServer: () =>
              Effect.andThen(
                Deferred.succeed(registering, undefined),
                Deferred.await(registrations),
              ),
          }
        : {}),
      ...(options.failRegistrations === true
        ? {
            registerMcpServer: () =>
              Effect.fail(
                new HarnessTransportError({
                  operation: "mcp.add",
                  status: undefined,
                  tag: undefined,
                  detail: "no answer",
                  cause: undefined,
                }),
              ),
          }
        : {}),
      ...(options.gateEnds === true
        ? {
            endSession: () =>
              Effect.andThen(
                Deferred.succeed(ending, undefined),
                Deferred.await(ends),
              ),
          }
        : {}),
      prompt: (_sessionId, text, delivery) =>
        delivery?._tag === "steer" && steerRefusal.now !== undefined
          ? Effect.fail(steerRefusal.now)
          : Effect.sync(() => {
              if (Deferred.isDoneUnsafe(idle))
                idle = Deferred.makeUnsafe<void>();
              prompts.push(text);
              if (delivery?._tag === "steer") urgencies.push(delivery.urgency);
              return { delivered: true };
            }),
    });
    const resolver = HarnessResolver.fromEntries([
      { instance: STUB_INSTANCE, harness },
    ]);

    const rows = new Map<string, ProbeRow>();
    /** Each period's credential, as the probe minted it. */
    const issued = new Map<string, IssuedCredential>();
    /** Every period `revokePeriod` was asked to revoke, in order. */
    const revokes: string[] = [];
    /**
     * What each period's credential resolved to at the instant its operator's end was
     * recorded: after the end's revoke, before anything is interrupted or closed.
     */
    const atOperatorEnd = new Map<string, unknown>();
    /** What a period's credential resolves to now; `undefined` once refused. */
    const authorityOf = (id: string) =>
      Effect.suspend(() => {
        const credential = issued.get(id);
        return credential === undefined
          ? Effect.die(`no credential was issued for ${id}`)
          : credentials.resolve(Redacted.value(credential.token));
      });
    const ended: { id: string; reason: LiveSessionCloseReason }[] = [];
    let minted = 0;
    const reopened: string[] = [];
    /**
     * Whether a new period's open points the session's older rows at it at once. Off, it
     * is a successor whose confirmation has not been written yet: an old id is followed to
     * it by the core's in-process successor link alone.
     */
    const confirming = { now: true };

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
          if (!confirming.now) return;
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
        failed: () =>
          options.gateFailed === true
            ? Effect.andThen(
                Deferred.succeed(failing, undefined),
                Deferred.await(fails),
              )
            : Effect.void,
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
        // A goal grant names the goal, not the period: the owner's id, never the period's.
        issue: (period) =>
          credentials
            .issueWithoutExpiry({
              _tag: "goal",
              targetId: period.targetId,
              goalId: period.ownerId,
            })
            .pipe(
              Effect.tap((credential) =>
                Effect.sync(() => issued.set(period.periodId, credential)),
              ),
            ),
        // By the period's own token: `revokeGoal` would take every period of the owner.
        revokePeriod: (period) =>
          Effect.gen(function* () {
            revokes.push(period.periodId);
            const credential = issued.get(period.periodId);
            if (credential === undefined) return 0;
            const live = yield* credentials.resolve(
              Redacted.value(credential.token),
            );
            if (live === undefined) return 0;
            yield* credentials.revoke(credential.token);
            return 1;
          }),
        words: {
          unregisterRefused: "probe: unregister refused",
          strayCredential: "probe: stray credential",
          closed: "probe: closed",
          idKey: "probeId",
        },
      },
      ownerOf: () => OWNER,
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
          Effect.gen(function* () {
            if (reason === "operator" && issued.has(id)) {
              atOperatorEnd.set(id, yield* authorityOf(id));
            }
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
        period: "probe",
        aPeriod: "a probe",
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
      urgencies,
      interrupts,
      goIdle,
      dieTurn,
      steerRefusal,
      letOpen: Deferred.succeed(opens, undefined),
      registering: Deferred.await(registering),
      letRegister: Deferred.succeed(registrations, undefined),
      ending: Deferred.await(ending),
      letEnd: Deferred.succeed(ends, undefined),
      failing: Deferred.await(failing),
      letFail: Deferred.succeed(fails, undefined),
      revokes,
      atOperatorEnd,
      authorityOf,
      confirming,
      rows,
      ended,
      reopened,
      issued,
      credentials,
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
  options: WorldOptions = {},
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

  test("ending one of an owner's periods revokes its credential only; the other keeps its authority", async () => {
    const result = await run((probe) =>
      Effect.gen(function* () {
        const first = (yield* probe.open("first")).entry;
        const second = (yield* probe.open("second")).entry;
        const tokenOf = (id: string) => {
          const credential = probe.issued.get(id);
          return credential === undefined
            ? ""
            : Redacted.value(credential.token);
        };
        const before = {
          first: yield* probe.credentials.resolve(tokenOf(first.id)),
          second: yield* probe.credentials.resolve(tokenOf(second.id)),
        };
        yield* probe.core.end(TARGET, first.id);
        return {
          ids: [first.id, second.id],
          before,
          first: yield* probe.credentials.resolve(tokenOf(first.id)),
          second: yield* probe.credentials.resolve(tokenOf(second.id)),
          live: yield* probe.core.holds(second.id),
        };
      }),
    );
    expect(result.ids).toEqual(["prb_1", "prb_2"]);
    // Both grants are the owner's, under its own id, not either period's.
    expect(result.before.first).toMatchObject({ _tag: "goal", goalId: OWNER });
    expect(result.before.second).toMatchObject({ _tag: "goal", goalId: OWNER });
    expect(result.first).toBeUndefined();
    expect(result.second).toMatchObject({ _tag: "goal", goalId: OWNER });
    expect(result.live).toBe(true);
  });

  /*
   * The end's own revoke (review 2 of slice 2). A closing session's scope revokes too, so a
   * test that looks once the end has returned cannot tell the two apart: these look while
   * the end is still under way, before anything the end interrupts or closes has gone.
   */
  test("an end refuses the period's credential before its session is closed", async () => {
    const result = await run(
      (probe) =>
        Effect.gen(function* () {
          const { entry } = yield* probe.open("first");
          const before = yield* probe.authorityOf(entry.id);
          const ending = yield* Effect.forkChild(
            probe.core.end(TARGET, entry.id),
          );
          // The close is held at the harness's `endSession`: the session's scope, and its
          // revoke, are still to come.
          yield* probe.ending;
          const whileClosing = yield* probe.authorityOf(entry.id);
          yield* probe.letEnd;
          return {
            before,
            whileClosing,
            atEnd: probe.atOperatorEnd.get(entry.id),
            revokes: [...probe.revokes],
            ended: yield* Fiber.join(ending),
          };
        }),
      { gateEnds: true },
    );
    expect(result.before).toMatchObject({ _tag: "goal", goalId: OWNER });
    expect(result.atEnd).toBeUndefined();
    expect(result.whileClosing).toBeUndefined();
    expect(result.revokes[0]).toBe("prb_1");
    expect(result.ended).toBe(true);
  });

  test("an end while the open is still in flight refuses the credential that open minted", async () => {
    const result = await run(
      (probe) =>
        Effect.gen(function* () {
          const opening = yield* Effect.forkChild(
            Effect.result(probe.open("first")),
          );
          // Minted, and not yet registered: no session is published, the open is in flight.
          yield* probe.registering;
          const before = yield* probe.authorityOf("prb_1");
          const ending = yield* Effect.forkChild(
            probe.core.end(TARGET, "prb_1"),
          );
          // The end's interrupt waits on the open, which the registry runs uninterruptibly
          // and which is held at its registration: the end has recorded itself and is
          // still under way.
          for (let i = 0; i < 100 && probe.ended.length === 0; i += 1) {
            yield* Effect.sleep("2 millis");
          }
          const whileOpening = yield* probe.authorityOf("prb_1");
          const stillEnding = ending.pollUnsafe() === undefined;
          yield* probe.letRegister;
          const ended = yield* Fiber.join(ending);
          const opened = yield* Fiber.join(opening);
          return {
            before,
            whileOpening,
            stillEnding,
            ended,
            atEnd: probe.atOperatorEnd.get("prb_1"),
            revokes: [...probe.revokes],
            reasons: probe.ended.map((each) => each.reason),
            opened: opened._tag,
          };
        }),
      { gateRegistrations: true },
    );
    expect(result.before).toMatchObject({ _tag: "goal", goalId: OWNER });
    // Refused by the end itself, named by the open in flight, before the open was cut.
    expect(result.atEnd).toBeUndefined();
    expect(result.stillEnding).toBe(true);
    expect(result.whileOpening).toBeUndefined();
    expect(result.revokes[0]).toBe("prb_1");
    expect(result.ended).toBe(true);
    expect(result.reasons[0]).toBe("operator");
    expect(result.opened).toBe("Failure");
  });

  test("an end after a failed open, its turn still running, revokes nothing and is the operator's", async () => {
    const result = await run(
      (probe) =>
        Effect.gen(function* () {
          const opened = yield* Effect.result(probe.open("first"));
          // The open failed and its scope took the credential; the turn is held in the
          // binding's `failed`: no session, no open in flight, a turn still running.
          yield* probe.failing;
          const ended = yield* probe.core.end(TARGET, "prb_1");
          return {
            opened: opened._tag,
            ended,
            authority: yield* probe.authorityOf("prb_1"),
            revokes: [...probe.revokes],
            reasons: probe.ended.map((each) => each.reason),
            again: yield* probe.core.end(TARGET, "prb_1"),
          };
        }),
      { failRegistrations: true, gateFailed: true },
    );
    expect(result.opened).toBe("Failure");
    expect(result.ended).toBe(true);
    expect(result.authority).toBeUndefined();
    // Nothing named the period, so nothing was asked to revoke.
    expect(result.revokes).toEqual([]);
    // The operator's end is the first recorded; the interrupted turn wrote no `open_failed`.
    expect(result.reasons).toEqual(["operator"]);
    // With the turn gone too, there is nothing left to end.
    expect(result.again).toBe(false);
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
  test("a message with no urgency is a queued steer; Send now is a preemptive one", async () => {
    const result = await run(
      (probe) =>
        Effect.gen(function* () {
          const { entry } = yield* probe.open("first");
          const queued = yield* probe.send({
            conversationId: entry.id,
            text: "when you are done",
          });
          const now = yield* probe.send({
            conversationId: entry.id,
            text: "read this first",
            urgency: "preemptive",
          });
          return {
            queued,
            now,
            urgencies: probe.urgencies,
            held: yield* probe.core.heldSteers(entry.id),
          };
        }),
      { holdTurns: true },
    );
    expect(result.queued.conversation).toBe("continued");
    expect(result.now.conversation).toBe("continued");
    expect(result.urgencies).toEqual(["queued", "preemptive"]);
    // Both wait beside the transcript while the turn runs.
    expect(result.held).toBe(2);
  });

  test("the messages held beside a turn are let go once the session goes idle", async () => {
    const result = await run(
      (probe) =>
        Effect.gen(function* () {
          const { entry } = yield* probe.open("first");
          yield* probe.send({ conversationId: entry.id, text: "and then?" });
          yield* Effect.sleep("20 millis");
          const whileRunning = yield* probe.core.heldSteers(entry.id);
          yield* probe.goIdle;
          let after = whileRunning;
          for (let i = 0; i < 100 && after > 0; i += 1) {
            yield* Effect.sleep("5 millis");
            after = yield* probe.core.heldSteers(entry.id);
          }
          return { whileRunning, after };
        }),
      { gateTurns: true },
    );
    expect(result.whileRunning).toBe(1);
    expect(result.after).toBe(0);
  });

  test("slice 3 fix: a message the harness says reaches no session is carried on by a reopen at once, not refused", async () => {
    const result = await run((probe) =>
      Effect.gen(function* () {
        const { entry } = yield* probe.open("first");
        // The session's process died between turns: the harness holds no live session.
        probe.steerRefusal.now = new HarnessTransportError({
          operation: "stub.prompt",
          status: 404,
          tag: SESSION_NOT_FOUND_TAG,
          detail: "the stub's process is gone",
          cause: undefined,
        });
        const sent = yield* probe.send({
          conversationId: entry.id,
          text: "are you back?",
        });
        const ended = [...probe.ended];
        // Any other refusal is still a refusal.
        probe.steerRefusal.now = new HarnessTransportError({
          operation: "stub.prompt",
          status: undefined,
          tag: undefined,
          detail: "no answer",
          cause: undefined,
        });
        const refused = yield* Effect.flip(
          probe.send({ conversationId: sent.probeId, text: "and again" }),
        );
        return {
          sent,
          reopened: probe.reopened,
          ended,
          refused,
        };
      }),
    );
    expect(result.sent.conversation).toBe("resumed");
    expect(result.sent.probeId).toBe("prb_2");
    expect(result.reopened).toEqual(["prb_1"]);
    // Let go because its process is gone (slice 3 fix 2, L2): not a refusal, and not
    // ended by the operator.
    expect(result.ended).toEqual([{ id: "prb_1", reason: "process_gone" }]);
    expect(result.refused).toMatchObject({
      _tag: "ProbeRefused",
      reason: "harness_unreachable",
    });
  });

  test("slice 3 fix: a message a dead process never took is held as lost; a wait that failed otherwise loses nothing", async () => {
    const replayQueued = (
      probe: Effect.Success<ReturnType<typeof world>>,
      id: string,
    ) =>
      Effect.map(
        probe.core.replay({
          id,
          fromTranscript: () => null,
          read: (live) =>
            Effect.succeed({ live: live !== undefined, question: null }),
        }),
        (replayed) =>
          replayed.queued.map((each) => [each.text, each.taken, each.lost]),
      );
    const gone = await run(
      (probe) =>
        Effect.gen(function* () {
          const { entry } = yield* probe.open("first");
          yield* probe.send({
            conversationId: entry.id,
            text: "read this next",
            urgency: "preemptive",
          });
          const before = yield* replayQueued(probe, entry.id);
          yield* probe.dieTurn(SESSION_PROCESS_GONE_TAG);
          let after = before;
          for (let i = 0; i < 100; i += 1) {
            yield* Effect.sleep("5 millis");
            after = yield* replayQueued(probe, entry.id);
            if (after[0]?.[2] === true) break;
          }
          return { before, after };
        }),
      { dyingTurns: true },
    );
    expect(gone.before).toEqual([["read this next", false, undefined]]);
    expect(gone.after).toEqual([["read this next", false, true]]);

    const broken = await run(
      (probe) =>
        Effect.gen(function* () {
          const { entry } = yield* probe.open("first");
          // After the settle's wait began, so the idle rule does not take it as read.
          yield* Effect.sleep("20 millis");
          yield* probe.send({ conversationId: entry.id, text: "later" });
          yield* probe.dieTurn(undefined);
          yield* Effect.sleep("50 millis");
          return yield* replayQueued(probe, entry.id);
        }),
      { dyingTurns: true },
    );
    // Accepted after the wait began, and not lost: whether it runs is not known.
    expect(broken).toEqual([["later", false, undefined]]);
  });

  test("a message to a period still opening waits for the open, then lands in that period", async () => {
    const result = await run(
      (probe) =>
        Effect.gen(function* () {
          const opening = yield* Effect.forkChild(probe.open("first"));
          // The row is written before the harness session exists, so a picker lists it.
          for (let i = 0; i < 100 && !probe.rows.has("prb_1"); i += 1) {
            yield* Effect.sleep("2 millis");
          }
          let answered = false;
          const sending = yield* Effect.forkChild(
            probe
              .send({ conversationId: "prb_1", text: "while you open" })
              .pipe(Effect.tap(() => Effect.sync(() => (answered = true)))),
          );
          yield* Effect.sleep("20 millis");
          const early = answered;
          yield* probe.letOpen;
          const sent = yield* Fiber.join(sending);
          yield* Fiber.join(opening);
          return {
            early,
            sent,
            reopened: probe.reopened,
            prompts: probe.prompts,
          };
        }),
      { gateOpens: true },
    );
    expect(result.early).toBe(false);
    expect(result.sent.conversation).toBe("continued");
    expect(result.sent.probeId).toBe("prb_1");
    // Waited for, not reopened under a new id.
    expect(result.reopened).toEqual([]);
    expect(result.prompts).toEqual([
      "open: first",
      'follow-up to "first": while you open',
    ]);
  });

  test("an old period id is followed by its row's latest period to the one live now", async () => {
    const result = await run((probe) =>
      Effect.gen(function* () {
        const { entry } = yield* probe.open("first");
        // An older period of the same session, from before a restart: no in-process link
        // leads from it, only its row's latest period.
        probe.rows.set("prb_0", {
          targetId: TARGET,
          harnessSessionId: entry.sessionId,
          harnessInstanceId: STUB_INSTANCE.instanceId,
          model: STUB_INSTANCE.defaultModel,
          modelOptions: null,
          endedReason: "shutdown",
          latestId: entry.id,
          openedAt: Date.now() - 1000,
        });
        const sent = yield* probe.send({
          conversationId: "prb_0",
          text: "from an old tab",
        });
        const stopped = yield* probe.core.stopTurn({
          targetId: TARGET,
          conversationId: "prb_0",
        });
        return { sent, stopped, reopened: probe.reopened };
      }),
    );
    expect(result.sent.conversation).toBe("continued");
    expect(result.sent.probeId).toBe("prb_1");
    expect(result.stopped.conversationId).toBe("prb_1");
    expect(result.reopened).toEqual([]);
  });

  test("a Stop or activity addressed to an old id reaches a successor whose row is not yet confirmed", async () => {
    const result = await run((probe) =>
      Effect.gen(function* () {
        const { entry } = yield* probe.open("first");
        yield* probe.core.sessions.close(entry.id, "shutdown");
        // The successor's confirmation is not written: only the in-process link leads to it.
        probe.confirming.now = false;
        const reopened = yield* probe.send({
          conversationId: entry.id,
          text: "still there?",
        });
        const activity = yield* probe.core.activity({
          targetId: TARGET,
          conversationId: entry.id,
        });
        const stopped = yield* probe.core.stopTurn({
          targetId: TARGET,
          conversationId: entry.id,
        });
        return {
          reopened,
          latest: probe.rows.get(entry.id)?.latestId,
          activity,
          stopped,
        };
      }),
    );
    expect(result.reopened.probeId).toBe("prb_2");
    // Still naming itself, not the successor.
    expect(result.latest).toBe("prb_1");
    expect(result.activity.conversationId).toBe("prb_2");
    expect(result.activity.turn).not.toBe("not_live");
    expect(result.stopped.conversationId).toBe("prb_2");
    expect(result.stopped.outcome).not.toBe("not_live");
  });

  test("Stop and Stop all on a busy period interrupt its running turn", async () => {
    const result = await run(
      (probe) =>
        Effect.gen(function* () {
          const { entry } = yield* probe.open("first");
          const target = { targetId: TARGET, conversationId: entry.id };
          const busy = yield* probe.core.activity(target);
          const stopped = yield* probe.core.stopTurn(target);
          yield* probe.send({ conversationId: entry.id, text: "go on" });
          const busyAgain = yield* probe.core.activity(target);
          const all = yield* probe.core.stopAll(target);
          return {
            busy,
            stopped,
            busyAgain,
            all,
            interrupts: probe.interrupts,
            sessionId: entry.sessionId,
          };
        }),
      { gateTurns: true },
    );
    expect(result.busy.turn).toBe("running");
    expect(result.stopped).toMatchObject({
      conversationId: "prb_1",
      outcome: "interrupted",
      working: false,
    });
    expect(result.busyAgain.turn).toBe("running");
    expect(result.all).toMatchObject({
      conversationId: "prb_1",
      outcome: "interrupted",
      working: false,
    });
    expect(result.interrupts).toEqual([result.sessionId, result.sessionId]);
  });
});
