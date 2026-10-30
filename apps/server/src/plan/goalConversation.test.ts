/**
 * The goal conversation: one session per goal, and the four states its life has.
 *
 * Nothing about a conversation is stored but the **session id**, so almost everything
 * worth asserting here is about the seams around that one row: what the first message
 * builds, what a later message does instead, what a restart does to both, and what the
 * replay says in each case. The chat's words are the harness's and this suite does not
 * pretend otherwise — it drives a fake one.
 *
 * ## The restart is the test this file exists for
 *
 * The spec's §5 names it: "a restart with a goal session live. The grant is gone, the goal
 * row is not. The next operator message must open a new session rather than prompting a
 * dead one, and must say that the conversation before it is unavailable." A restart is
 * modelled here the way the process really loses a conversation: a **second**
 * `GoalConversations` over the same store and the same fleet, with a fresh credential
 * registry. The first one's in-memory map is gone; its row is not.
 *
 * ## What is real and what is faked
 *
 * Real: the fleet registry, the target's SQLite file, the goal row, `goal_sessions`, the
 * credential registry and the directory layout with its gate installer. Faked: the harness,
 * because what a model says is not what this file is about and a real one needs a login.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Deferred,
  Effect,
  Fiber,
  Layer,
  ManagedRuntime,
  Redacted,
  Stream,
} from "effect";

import { AgentHarness, type McpRegistration } from "../harness/agentHarness";
import { HarnessResolver } from "../harness/resolver";
import { STUB_INSTANCE, stubHarness } from "../harness/stubHarness";
import { McpCredentials } from "../mcp/credentials";
import { FleetStore } from "../persistence/fleet";
import { operatorScope } from "../persistence/store";
import { TargetStores, withTargetStore } from "../persistence/targetStores";
import { RunNarrations } from "../run/narration";
import { WorkerEndpoints } from "../run/supervisor";
import { GoalConversations } from "./goalConversation";

const TARGET = "alpha";
const GOAL = "goal_1";

const scratches: string[] = [];
const newScratch = (): string => {
  const made = mkdtempSync(join(tmpdir(), "bit-goal-chat-"));
  scratches.push(made);
  return made;
};

afterEach(() => {
  for (const scratch of scratches.splice(0)) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

/** What the fake harness was asked to do, so a test can read the seam rather than a model. */
interface Recorder {
  readonly created: {
    sessionId: string;
    directory: string;
    multiTurn: boolean;
  }[];
  readonly gated: string[];
  readonly registrations: { name: string; url: string; bearer: string }[];
  readonly unregistrations: { sessionId: string; name: string }[];
  readonly prompts: {
    sessionId: string;
    text: string;
    delivery: string;
    urgency?: string;
  }[];
}

const emptyRecorder = (): Recorder => ({
  created: [],
  gated: [],
  registrations: [],
  unregistrations: [],
  prompts: [],
});

/**
 * A harness that records what it is handed and succeeds at everything.
 *
 * `mint` is shared across every service built over one world, so two *processes* over the
 * same files mint different session ids — which is what the restart case is about: the
 * assertion that the new session is not the old one would pass vacuously if both counters
 * started at one.
 */
const fakeHarness = (
  recorder: Recorder,
  mint: () => string,
  options?: {
    readonly promptFails?: boolean;
    readonly messages?: readonly { type: string; text: string }[];
    /**
     * When set, `createSession` parks on it after recording that it was entered.
     *
     * The only way to make two concurrent first messages genuinely interleave in a test.
     * Every other operation in this fake is `Effect.sync`, so without a suspension point
     * inside the open path the first fiber runs it to completion before the second starts —
     * which made an earlier version of the concurrency test pass with the mutual exclusion
     * **removed**. The reviewer hit the race over real HTTP, where two requests interleave
     * on their own; this is how a test reproduces it.
     */
    readonly createGate?: Deferred.Deferred<void> | undefined;
    /** Resolved the first time `createSession` is entered, before it parks. */
    readonly createEntered?: Deferred.Deferred<void> | undefined;
  },
): AgentHarness["Service"] =>
  stubHarness({
    newSessionId: mint,
    installGate: (input) =>
      Effect.sync(() => {
        recorder.gated.push(input.workspace);
      }),
    createSession: (input) =>
      Effect.gen(function* () {
        if (options?.createEntered !== undefined) {
          yield* Deferred.succeed(options.createEntered, undefined);
        }
        if (options?.createGate !== undefined) {
          yield* Deferred.await(options.createGate);
        }
        const id = input.sessionId ?? "ses_unchosen";
        recorder.created.push({
          sessionId: id,
          directory: input.directory,
          multiTurn: input.multiTurn === true,
        });
        return { id };
      }),
    registerMcpServer: (_sessionId, name, config: McpRegistration) =>
      Effect.sync(() => {
        recorder.registrations.push({
          name,
          url: config.url,
          bearer: Redacted.value(
            config.headers["authorization"] ?? Redacted.make(""),
          ),
        });
      }),
    unregisterMcpServer: (sessionId, name) =>
      Effect.sync(() => {
        recorder.unregistrations.push({ sessionId, name });
      }),
    prompt: (sessionId, text, delivery = { _tag: "open" as const }) =>
      options?.promptFails === true
        ? Effect.fail(
            new (class {
              readonly _tag = "HarnessTransportError";
              readonly message = "scripted: the session would not take it";
            })() as never,
          )
        : Effect.sync(() => {
            recorder.prompts.push({
              sessionId,
              text,
              delivery: delivery._tag,
              ...(delivery._tag === "steer"
                ? { urgency: delivery.urgency }
                : {}),
            });
            return { delivered: true };
          }),
    messages: () =>
      Effect.succeed(
        (
          options?.messages ?? [
            { type: "user", text: "what is happening?" },
            { type: "assistant", text: "one round has run." },
          ]
        ).map((entry) => ({ ...entry, error: undefined })),
      ),
    sessionEvents: () => Stream.never,
  });

/**
 * A fleet with one target and one active goal, and a conversation service over it.
 *
 * `make` builds a *new* service over the same files, which is how a restart is modelled:
 * the map and the credential registry are per runtime, and the row is not.
 */
const world = (options?: {
  readonly promptFails?: boolean;
  readonly messages?: readonly { type: string; text: string }[];
  readonly createGate?: Deferred.Deferred<void> | undefined;
  readonly createEntered?: Deferred.Deferred<void> | undefined;
}) => {
  const scratch = newScratch();
  const root = join(scratch, "fleet");
  // Outside the fleet root, like a real engagement's folder: `gatedRoleDirectory` refuses a
  // role directory inside the workspace, and a test whose workspace *was* the fleet root
  // would be asserting against a layout nobody has.
  const workspace = join(scratch, "work");
  mkdirSync(workspace, { recursive: true });

  const fleet = FleetStore.layer(root);
  const stores = TargetStores.layer.pipe(Layer.provide(fleet));

  let minted = 0;
  const mint = (): string => {
    minted += 1;
    return `ses_${String(minted)}`;
  };

  /**
   * One service over these files. `over` is how a *second* process can be given a different
   * harness answer from the first — which is what the restart and the framing-trim cases
   * need: the second process has to be told what the harness holds for a session the first
   * one created.
   */
  const make = (over?: {
    readonly messages?: readonly { type: string; text: string }[];
  }) => {
    const recorder = emptyRecorder();
    const settings = { ...options, ...over };
    const credentials = McpCredentials.layer;
    const layer = Layer.mergeAll(
      fleet,
      stores,
      credentials,
      GoalConversations.layer.pipe(
        Layer.provide(
          Layer.succeed(
            HarnessResolver,
            HarnessResolver.fromEntries([
              {
                instance: STUB_INSTANCE,
                harness: fakeHarness(recorder, mint, settings),
              },
            ]),
          ),
        ),
        Layer.provide(stores),
        Layer.provide(fleet),
        Layer.provide(credentials),
        Layer.provide(RunNarrations.layer),
        Layer.provide(
          Layer.succeed(
            WorkerEndpoints,
            WorkerEndpoints.of({
              urls: Effect.succeed({
                mcp: "http://127.0.0.1:9/api/v1/mcp",
                plannerMcp: "http://127.0.0.1:9/api/v1/planner/mcp",
                goalMcp: "http://127.0.0.1:9/api/v1/goal/mcp",
                policy: "http://127.0.0.1:9/api/v1/policy/decide",
              }),
            }),
          ),
        ),
      ),
    );
    return { runtime: ManagedRuntime.make(layer), recorder };
  };

  const first = make();
  const ready = first.runtime.runPromise(
    Effect.gen(function* () {
      const registry = yield* FleetStore;
      yield* registry.register({
        targetId: TARGET,
        name: "Acme",
        scopeNote: "the local fixture only",
        workspacePath: workspace,
      });
      yield* registry.migrateFleet();
      const targets = yield* TargetStores;
      yield* withTargetStore(targets, TARGET, (store) =>
        store.openGoal(
          { callerScope: operatorScope(TARGET), targetId: TARGET },
          {
            operationId: "op_goal",
            goalId: GOAL,
            name: "Rate limits",
            description: "Determine whether the login limiter can be bypassed.",
          },
        ),
      );
    }).pipe(Effect.orDie),
  );

  return { root, workspace, first, make, ready };
};

/**
 * The runtime {@link world} builds, derived rather than written out.
 *
 * Spelled as a `ReturnType` chain so that adding a service to the world does not mean
 * editing a second declaration — which is how a helper's signature comes to disagree with
 * the thing it is a helper for.
 */
type ChatRuntime = ReturnType<ReturnType<typeof world>["make"]>["runtime"];

const sending = (runtime: ChatRuntime, text: string) =>
  runtime.runPromise(
    Effect.flatMap(GoalConversations, (conversations) =>
      conversations.send({ targetId: TARGET, goalId: GOAL, text }),
    ).pipe(Effect.orDie),
  );

const replaying = (runtime: ChatRuntime) =>
  runtime.runPromise(
    Effect.flatMap(GoalConversations, (conversations) =>
      conversations.replay({ targetId: TARGET, goalId: GOAL }),
    ),
  );

/* ── The first message ───────────────────────────────────────────────────────── */

describe("the first message on a goal", () => {
  test("opens a session in the goal's own gated directory, on the goal endpoint", async () => {
    const { root, workspace, first, ready } = world();
    await ready;

    const accepted = await sending(first.runtime, "what is happening?");

    expect(accepted.conversation).toBe("opened");
    // Nothing came before: the flag that would be true after a restart is false here, and
    // a flag that was always true would lose exactly that distinction.
    expect(accepted.priorUnavailable).toBe(false);
    expect(accepted.note).toContain("first message");

    const goalDirectory = join(root, "targets", TARGET, "goal", GOAL);
    // Its own directory, which is a sibling of `planning/` and of `evidence/` and is never
    // the workspace. Under OpenCode the directory is the authority boundary (§24.2), so a
    // goal session in the workers' folder would see every `bit-<attemptId>` registered
    // there — which is the whole reason the layout exists.
    expect(first.recorder.created[0]?.directory).toBe(goalDirectory);
    expect(first.recorder.gated).toEqual([goalDirectory]);
    expect(
      first.recorder.gated.some((entry) => entry.includes(workspace)),
    ).toBe(false);
    // Multi-turn, which is what keeps the session answerable from the operator's second
    // message. On Claude Code a session closed when it idled could not take one.
    expect(first.recorder.created[0]?.multiTurn).toBe(true);

    // The **goal** endpoint, which is the line that decides the tool list: each endpoint
    // refuses a grant whose tag is not its role, so a goal credential at the planner URL
    // gets a 401 rather than `add_intent`.
    expect(first.recorder.registrations[0]?.url).toBe(
      "http://127.0.0.1:9/api/v1/goal/mcp",
    );
    expect(first.recorder.registrations[0]?.name).toBe(`bit-${GOAL}`);
    expect(first.recorder.registrations[0]?.bearer).toContain("Bearer ");

    await first.runtime.dispose();
  });

  test("the prompt is the framing plus the operator's words, unaltered and last", async () => {
    const { first, ready } = world();
    await ready;

    await sending(first.runtime, "is anything running right now?");

    const prompt = first.recorder.prompts[0];
    expect(prompt?.delivery).toBe("open");
    expect(prompt?.text).toContain("You are the goal agent in bit");
    // The goal's own objective, so the agent knows what it is talking about without
    // spending a tool call on the briefing.
    expect(prompt?.text).toContain("login limiter");
    expect(prompt?.text).toContain("Rate limits");
    // The ruling, in the prompt as well as in the toolkit: it steers, it does not write.
    expect(prompt?.text).toContain("YOU CANNOT CREATE AN INTENT");
    // The operator's text is last and untouched, below the separator the framing names.
    expect(prompt?.text.endsWith("is anything running right now?")).toBe(true);

    await first.runtime.dispose();
  });

  test("the session id is recorded, so a reload can ask the harness for the words", async () => {
    const { first, ready } = world();
    await ready;

    const accepted = await sending(first.runtime, "hello");
    const recorded = await first.runtime.runPromise(
      Effect.flatMap(TargetStores, (stores) =>
        withTargetStore(stores, TARGET, (store) => store.goalSession(GOAL)),
      ).pipe(Effect.orDie),
    );

    expect(recorded?.harnessSessionId).toBe(accepted.harnessSessionId);
    expect(recorded?.harnessInstanceId).toBe(accepted.instanceId);

    await first.runtime.dispose();
  });
});

test("two concurrent first messages open one session, and leak no credential", async () => {
  /*
   * Important finding 2, measured by the reviewer against the running server: two
   * simultaneous `POST …/conversation` calls on a fresh goal both answered
   * `conversation: "opened"` with two different session ids. `live.set` keeps one, so the
   * loser's `Scope` was in no map — and neither `close` nor this layer's finalizer could
   * ever reach it, leaving a **no-expiry** goal credential and a live MCP registration in
   * the goal's own directory, which §24.2 establishes *is* the authority boundary under
   * OpenCode. Only process death would have ended it.
   *
   * The interleave is **forced** rather than hoped for: the first message parks inside
   * `createSession` until this test releases it, so the second is guaranteed to arrive
   * while the first is mid-open. A version of this test that merely fired two `send`s
   * concurrently passed with the mutual exclusion removed, because every other operation
   * in the fake is synchronous — so it asserted nothing.
   */
  const createGate = Deferred.makeUnsafe<void>();
  const createEntered = Deferred.makeUnsafe<void>();
  const { first, ready } = world({ createGate, createEntered });
  await ready;

  const both = await first.runtime.runPromise(
    Effect.gen(function* () {
      const conversations = yield* GoalConversations;
      const one = yield* Effect.forkChild(
        conversations.send({
          targetId: TARGET,
          goalId: GOAL,
          text: "what is happening?",
        }),
      );
      // Parked inside the open path, holding the goal's permit.
      yield* Deferred.await(createEntered);
      const two = yield* Effect.forkChild(
        conversations.send({
          targetId: TARGET,
          goalId: GOAL,
          text: "and is anything running?",
        }),
      );
      // Long enough that a second open, if one were possible, would have happened.
      yield* Effect.sleep("20 millis");
      yield* Deferred.succeed(createGate, undefined);
      return [yield* Fiber.join(one), yield* Fiber.join(two)] as const;
    }).pipe(Effect.orDie),
  );

  // One session for the goal, whichever call won the permit.
  expect(first.recorder.created).toHaveLength(1);
  expect(both[0].harnessSessionId).toBe(both[1].harnessSessionId);
  // One `opened` and one `continued`: the loser re-read the map inside the permit and
  // carried on into the session the winner had just made.
  expect([both[0].conversation, both[1].conversation].sort()).toEqual([
    "continued",
    "opened",
  ]);
  // One registration, so there is no second bearer in the goal's directory.
  expect(first.recorder.registrations).toHaveLength(1);
  // And both messages reached the one session: an `open` prompt and a queued steer.
  expect(
    first.recorder.prompts.map((prompt) => prompt.delivery).sort(),
  ).toEqual(["open", "steer"]);

  const credentials = await first.runtime.runPromise(
    Effect.map(McpCredentials, (service) => service),
  );
  await first.runtime.dispose();
  // The claim the header makes: the layer's finalizer closes **every** conversation it
  // was holding. With an orphaned scope this was 1.
  expect(await Effect.runPromise(credentials.size)).toBe(0);
});

/* ── A later message ─────────────────────────────────────────────────────────── */

describe("a later message in the same process", () => {
  test("is queued into the same session rather than opening another", async () => {
    const { first, ready } = world();
    await ready;

    const opened = await sending(first.runtime, "what is happening?");
    const next = await sending(first.runtime, "then steer the planner to it");

    expect(next.conversation).toBe("continued");
    expect(next.priorUnavailable).toBe(false);
    expect(next.harnessSessionId).toBe(opened.harnessSessionId);
    // One session, two messages: the second is a second prompt into the first's session.
    expect(first.recorder.created).toHaveLength(1);
    expect(first.recorder.prompts).toHaveLength(2);
    /*
     * Queued, not pre-emptive. §24.1 measured what the other timing costs — a round lost
     * seven of eight file reads to it — and an operator sending a second message has not
     * asked for whatever the agent was in the middle of to be thrown away.
     */
    expect(first.recorder.prompts[1]?.delivery).toBe("steer");
    expect(first.recorder.prompts[1]?.urgency).toBe("queued");
    // No framing on a later message: the session already has it, which is the whole reason
    // this is a session rather than a prompt per turn.
    expect(first.recorder.prompts[1]?.text).toBe(
      "then steer the planner to it",
    );

    await first.runtime.dispose();
  });
});

/* ── The restart ─────────────────────────────────────────────────────────────── */

describe("a restart with a goal conversation live", () => {
  test("the next message opens a new session and says the old one is unreachable", async () => {
    const { first, make, ready } = world();
    await ready;

    const before = await sending(first.runtime, "what is happening?");
    // The process ends. The map and the credential registry go with it; the row does not.
    await first.runtime.dispose();

    const second = make();
    const after = await sending(second.runtime, "are you still there?");

    expect(after.conversation).toBe("opened");
    /*
     * The requirement, and both halves of it.
     *
     * The grant lives only in `mcp/credentials.ts`'s in-memory map, so the recorded session
     * is one nothing can authorise: prompting it would produce an agent with no tools
     * answering into a conversation whose beginning the operator cannot see. So a new
     * session is opened — and the operator is told, because a silent second conversation on
     * the same goal is the one outcome that looks like nothing happened.
     */
    expect(after.priorUnavailable).toBe(true);
    expect(after.note).toContain("restart");
    expect(after.note).toContain(before.harnessSessionId);
    expect(after.harnessSessionId).not.toBe(before.harnessSessionId);
    // A new session, prompted from the start: the second process did not try to continue
    // the first one's.
    expect(second.recorder.prompts[0]?.delivery).toBe("open");
    expect(second.recorder.created).toHaveLength(1);

    // And the row now names the new one, so the next reload replays this conversation.
    const recorded = await second.runtime.runPromise(
      Effect.flatMap(TargetStores, (stores) =>
        withTargetStore(stores, TARGET, (store) => store.goalSession(GOAL)),
      ).pipe(Effect.orDie),
    );
    expect(recorded?.harnessSessionId).toBe(after.harnessSessionId);

    await second.runtime.dispose();
  });

  test("the framing above the operator's first message is not replayed as a turn", async () => {
    /*
     * Important finding 6, observed in the browser: the `GOAL CONVERSATION` block's first
     * row was the entire `goalAgentPreamble` — about 2.4 KB of "You are the goal agent in
     * bit…" — presented as a conversation turn, with the operator's own sentence at the
     * bottom of it.
     *
     * The harness stores the opening prompt as one `user` message, so a replay cannot drop
     * it (those are the operator's words) and must not show it whole (most of it is this
     * server's). `goalPrompt.ts` ends the framing with a fixed delimiter it writes itself,
     * so the split is exact — the same technique `isRoundPromptText` uses for a round's
     * prompt, one file over.
     */
    const { first, make, ready } = world();
    await ready;
    await sending(first.runtime, "is anything running right now?");
    // What the harness really holds for a first message: the whole assembled prompt.
    const stored = first.recorder.prompts[0]?.text ?? "";
    expect(stored).toContain("You are the goal agent in bit");
    await first.runtime.dispose();

    const second = make({ messages: [{ type: "user", text: stored }] });
    const view = await replaying(second.runtime);

    expect(view.messages).toHaveLength(1);
    // The operator's words, exactly as they wrote them.
    expect(view.messages[0]?.text).toBe("is anything running right now?");
    expect(view.messages[0]?.text).not.toContain("You are the goal agent");
    // And said, rather than silently shorter than the thing the agent was given.
    expect(view.note).toContain("shown as you wrote it");

    await second.runtime.dispose();
  });

  test("a later message has no framing and is replayed untouched", async () => {
    // Only the opening prompt carries the preamble; a second message travels verbatim, so
    // there is nothing to split and nothing is claimed about one.
    const { first, ready } = world({
      messages: [{ type: "user", text: "and the admin console?" }],
    });
    await ready;
    await sending(first.runtime, "hello");
    const view = await replaying(first.runtime);

    expect(view.messages[0]?.text).toBe("and the admin console?");
    expect(view.note).not.toContain("shown as you wrote it");

    await first.runtime.dispose();
  });

  test("the replay before that message says the conversation is readable, not continuable", async () => {
    const { first, make, ready } = world();
    await ready;
    await sending(first.runtime, "what is happening?");
    await first.runtime.dispose();

    const second = make();
    const view = await replaying(second.runtime);

    // The harness still has the words — Claude Code keeps its transcripts on disk for about
    // thirty days — so the prose comes back.
    expect(view.source).toBe("harness");
    expect(view.messages.map((message) => message.text)).toEqual([
      "what is happening?",
      "one round has run.",
    ]);
    /*
     * And `live` is false, which is a separate question from whether the words are here.
     * Collapsing the two would make a readable conversation look resumable, and the note is
     * what tells an operator the next message starts a new one.
     */
    expect(view.live).toBe(false);
    expect(view.note).toContain("no longer running");
    expect(view.note).toContain("starts a new conversation");

    await second.runtime.dispose();
  });
});

/* ── The replay's own states ─────────────────────────────────────────────────── */

describe("what the replay says when there is nothing to show", () => {
  test("a goal nobody has talked to is `absent`, not forgotten", async () => {
    const { first, ready } = world();
    await ready;

    const view = await replaying(first.runtime);

    /*
     * The fourth state a round cannot be in. A round always has a row saying it happened;
     * a conversation has nothing until the first message, and reporting that with the
     * harness's "I no longer hold that session" sentence would tell an operator their first
     * message had been lost.
     */
    expect(view.source).toBe("absent");
    expect(view.harnessSessionId).toBeNull();
    expect(view.live).toBe(false);
    expect(view.messages).toEqual([]);
    expect(view.note).toContain("Nobody has talked to this goal's agent yet");

    await first.runtime.dispose();
  });

  test("a live conversation the harness holds nothing for yet is `pending`", async () => {
    // The harness knows the session and holds nothing under it: the first second of the
    // first message, which is a moment worth waiting for rather than an absence.
    const { first, ready } = world({ messages: [] });
    await ready;
    await sending(first.runtime, "hello");

    const view = await replaying(first.runtime);

    expect(view.source).toBe("pending");
    expect(view.live).toBe(true);
    expect(view.messages).toEqual([]);
    expect(view.note).toContain("holds nothing for this conversation yet");
    // No restart sentence: this session is ours, so nothing is unreachable.
    expect(view.note).not.toContain("no longer running");

    await first.runtime.dispose();
  });

  test("a conversation that is over and said nothing is `none`, not forgotten", async () => {
    const { first, make, ready } = world({ messages: [] });
    await ready;
    await sending(first.runtime, "hello");
    await first.runtime.dispose();

    const second = make();
    const view = await replaying(second.runtime);

    /*
     * The harness still knows the session and holds nothing under it, which is a different
     * fact from the harness having deleted it — and the two call for different things from
     * an operator. `forgotten` says there is nothing to wait for and nothing to read;
     * `none` says this conversation genuinely produced nothing.
     */
    expect(view.source).toBe("none");
    expect(view.live).toBe(false);
    expect(view.note).toContain("produced nothing");
    expect(view.note).toContain("not the same as the harness having forgotten");

    await second.runtime.dispose();
  });

  test("a server with no harness refuses a message and still replays honestly", async () => {
    /*
     * The `HARNESS=0` build, which still boots, still serves the browser and still sweeps
     * the fleet. Two claims, and the second is why this variant reads the store rather than
     * refusing both operations: a goal nobody has talked to must read as `absent` and not
     * as a conversation something forgot, because those are different facts and a build
     * with no harness has no reason to confuse them.
     */
    const { root, workspace, first, ready } = world();
    await ready;
    await sending(first.runtime, "hello");
    await first.runtime.dispose();
    void workspace;

    const fleet = FleetStore.layer(root);
    const bare = ManagedRuntime.make(
      GoalConversations.unavailable.pipe(
        Layer.provide(TargetStores.layer.pipe(Layer.provide(fleet))),
      ),
    );
    const refusal = await bare.runPromise(
      Effect.result(
        Effect.flatMap(GoalConversations, (conversations) =>
          conversations.send({
            targetId: TARGET,
            goalId: GOAL,
            text: "anyone there?",
          }),
        ),
      ),
    );
    const view = await bare.runPromise(
      Effect.flatMap(GoalConversations, (conversations) =>
        conversations.replay({ targetId: TARGET, goalId: GOAL }),
      ),
    );

    expect(refusal._tag).toBe("Failure");
    if (refusal._tag === "Failure") {
      expect(refusal.failure.reason).toBe("no_harness");
      expect(refusal.failure.detail).toContain("HARNESS=0");
    }
    // The row is still there, so this is not `absent` — it is a session that cannot be
    // asked about, said as a note rather than as an error.
    expect(view.source).toBe("forgotten");
    expect(view.live).toBe(false);
    expect(view.note).toContain("no agent harness configured");
    expect(view.note).toContain("starts a new conversation");

    await bare.dispose();
  });
});

/* ── Refusals, and giving up on a conversation ───────────────────────────────── */

describe("when a conversation may not be had", () => {
  test("an ended goal is refused by name, with nothing opened for it", async () => {
    const { first, ready } = world();
    await ready;
    await first.runtime.runPromise(
      Effect.flatMap(TargetStores, (stores) =>
        withTargetStore(stores, TARGET, (store) =>
          store.endGoal(
            { callerScope: operatorScope(TARGET), targetId: TARGET },
            {
              operationId: "op_end",
              goalId: GOAL,
              status: "abandoned",
              // The operator ending it through the browser, which is the ordinary way a
              // goal ends under a conversation that is open.
              endedBy: "operator",
              reason: "Out of scope.",
            },
          ),
        ),
      ).pipe(Effect.orDie),
    );

    const refusal = await first.runtime.runPromise(
      Effect.result(
        Effect.flatMap(GoalConversations, (conversations) =>
          conversations.send({
            targetId: TARGET,
            goalId: GOAL,
            text: "anything",
          }),
        ),
      ),
    );

    expect(refusal._tag).toBe("Failure");
    if (refusal._tag === "Failure") {
      expect(refusal.failure.reason).toBe("goal_not_active");
      expect(refusal.failure.detail).toContain("abandoned");
    }
    // Nothing was built for it: no session, no directory, no credential.
    expect(first.recorder.created).toEqual([]);

    await first.runtime.dispose();
  });

  test("closing a conversation takes the registration away and revokes the grant", async () => {
    const { first, ready } = world();
    await ready;
    const accepted = await sending(first.runtime, "hello");

    const grants = await first.runtime.runPromise(
      Effect.gen(function* () {
        const conversations = yield* GoalConversations;
        const credentials = yield* McpCredentials;
        const before = yield* credentials.size;
        yield* conversations.close(GOAL);
        const after = yield* credentials.size;
        return { before, after };
      }),
    );

    // The credential's lifetime is the session's scope, and closing is what ends it. That
    // is point 1 of the three things that bound a credential with no clock expiry.
    expect(grants.before).toBe(1);
    expect(grants.after).toBe(0);
    expect(first.recorder.unregistrations).toEqual([
      { sessionId: accepted.harnessSessionId, name: `bit-${GOAL}` },
    ]);

    await first.runtime.dispose();
  });

  test("the layer's own shutdown closes every conversation it was holding", async () => {
    const { first, ready } = world();
    await ready;
    await sending(first.runtime, "hello");

    // The registry is a closure over a plain `Map`, so it keeps answering after the
    // runtime's scope is gone — which is the only way to assert that a shutdown revoked
    // what it was supposed to.
    const credentials = await first.runtime.runPromise(
      Effect.map(McpCredentials, (service) => service),
    );
    await first.runtime.dispose();

    expect(await Effect.runPromise(credentials.size)).toBe(0);
    expect(first.recorder.unregistrations).toHaveLength(1);
  });
});
