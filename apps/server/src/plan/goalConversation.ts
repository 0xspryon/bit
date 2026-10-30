/**
 * One long-lived agent session per goal: the conversation the operator actually opens.
 *
 * This is the third kind of supervised agent in this process and the only one that is not
 * a unit of work. A worker attempt and a planner round each have a row, a prompt, one
 * outcome and a settlement table; a goal conversation has **none of those**. It is created
 * on the operator's first message, prompted again for every message after it, and ends when
 * the process does or when something gives up on it. Nothing settles it, because there is
 * nothing for a settlement to be about.
 *
 * ## What is stored, which is almost nothing
 *
 * Operator messages and agent turns are **not persisted** (the goal and planner flow's
 * decisions 14 and 15, and this slice's ruling 4). The chat streams onto the in-process
 * narration bus while a browser is attached and replays from the harness afterwards
 * (`plan/goalNarration.ts`). Losing it to the harness's own retention is accepted.
 *
 * One thing *is* stored, and it is not a word of the conversation: the **session id**, in
 * `goal_sessions` (migration `0021`). It is there for two things that cannot be derived —
 * asking the harness for the prose after a reload needs the id, and telling a restart from
 * a fresh start needs a durable trace of a session this process can no longer reach. See
 * {@link GoalConversations.send} on `priorUnavailable`.
 *
 * ## What bounds a credential that never expires
 *
 * The agent's credential is issued with {@link McpCredentials.issueWithoutExpiry}: no clock
 * expiry at all (decision 4). A conversation is open for as long as the operator is working
 * the goal, which may be days, and an expiry would mean a conversation that stops working
 * mid-sentence for a reason the operator cannot see. Three things bound it instead, and
 * they are the whole list:
 *
 * 1. **Scope close.** Each session owns a `Scope` of its own, and the credential and the
 *    MCP registration are both acquired in it. {@link GoalConversations.close} closes that
 *    scope, and this layer's finalizer closes every one still open.
 * 2. **`revokeGoal`.** Called after the scope closes, as the check that it did its job —
 *    see {@link closeSession} on why a non-zero count there is a bug and is logged as one.
 * 3. **Process death.** Grants live only in `mcp/credentials.ts`'s in-memory map.
 *
 * **Ending the goal is deliberately not on that list**, and this is the cascade decision
 * slice 4 left open. `store.checkGoalAuthority` already refuses every write under an ended
 * goal, so revoking would buy nothing a column does not already do — while it would take
 * away the agent's *reads*, and "summarise what we established" is a reasonable thing to
 * ask about a goal that has just been closed. For the same reason `revokeGoal` does not
 * cascade to the goal's planner **rounds**: a round holds its own credential, decision 8
 * says ending a goal interrupts nothing, and a round whose credential vanished could not
 * record the disposition that explains what it concluded. The two authorities are revoked
 * by the two things that own them.
 *
 * ## No idle timeout, and that is a decision rather than an omission
 *
 * The brief offers `GOAL_SESSION_IDLE_TIMEOUT_MS` "if you need one". Nothing here needs
 * one. An idle conversation costs an entry in two maps and, on Claude Code, one parked
 * `query()` whose generator is waiting on a promise; neither accumulates with time, and
 * both die with the process. A timeout would introduce the one failure this design is
 * built to avoid — a conversation that stops working for a reason the operator cannot see —
 * in exchange for releasing memory that is bounded by the number of goals an operator has
 * open. If a deployment ever runs out of sessions, the bound wanted is a count, not a
 * clock, and it is not needed yet.
 */
import {
  GoalConversationRefused,
  bitMcpServerName,
  type GoalConversationView,
  type GoalTurnAccepted,
} from "@bit/contracts";
import {
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Redacted,
  Scope,
  Semaphore,
  Stream,
  type Duration,
} from "effect";

import { AgentHarness, OPEN_PROMPT } from "../harness/agentHarness";
import { HarnessResolver } from "../harness/resolver";
import { FleetStore } from "../persistence/fleet";
import { McpCredentials } from "../mcp/credentials";
import { TargetStores } from "../persistence/targetStores";
import { gatedRoleDirectory, type GatedDirectory } from "../policy/install";
import { POLICY_AUDIT_FILE } from "../policy/install";
import { RunNarrations } from "../run/narration";
import { WorkerEndpoints } from "../run/supervisor";
import { assembleGoalOpeningPrompt } from "./goalPrompt";
import { goalConversationNarration } from "./goalNarration";

/**
 * `AgentHarness.createSession`, narrowed so that the directory must be gated.
 *
 * The same three lines `plan/planSupervisor.ts`'s `createPlannerSession` is, and here for
 * the same reason: `GatedDirectory` is a brand, `createSession` takes `directory: string`,
 * and a brand that is never *asked for* at a call site constrains nothing. This is the one
 * call in this file that opens a goal session, so passing a path that has not been through
 * `gatedRoleDirectory` is a compile error rather than a convention.
 *
 * `multiTurn: true` is set here rather than by the caller, because it is not a choice a
 * caller of this function could sensibly make differently: a goal conversation is prompted
 * again for every message the operator sends, and a session closed when it went idle could
 * not take the second one.
 */
const createGoalSession = (
  harness: AgentHarness["Service"],
  input: {
    readonly title: string;
    readonly model: string;
    readonly directory: GatedDirectory;
    readonly sessionId: string;
  },
) => harness.createSession({ ...input, multiTurn: true });

/** One goal's live conversation, as this process holds it. */
interface LiveConversation {
  readonly goalId: string;
  readonly targetId: string;
  readonly sessionId: string;
  readonly instanceId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly harness: AgentHarness["Service"];
  /** Owns the credential and the MCP registration. Closed by {@link closeSession}. */
  readonly scope: Scope.Closeable;
  /** Drains the session's narration onto the bus. Interrupted with the session. */
  readonly narrator: Fiber.Fiber<void, never>;
  readonly openedAt: number;
}

/** Collapses everything opening a conversation can fail with into one typed refusal. */
const refuse = (error: {
  readonly _tag: string;
  readonly message?: string;
  readonly reason?: string;
  readonly detail?: string;
}): GoalConversationRefused => {
  switch (error._tag) {
    case "FleetError":
      return new GoalConversationRefused({
        reason:
          error.reason === "invalid_role_id"
            ? "goal_directory_unusable"
            : "target_unavailable",
        detail: error.message ?? "that target could not be opened",
      });
    case "PolicyHookNotInstalled":
      return new GoalConversationRefused({
        reason: "goal_ungated",
        detail:
          error.message ??
          "the pre-execution policy gate could not be installed into this goal's directory, so no conversation was opened",
      });
    case "HarnessTransportError":
    case "HarnessDecodeError":
      return new GoalConversationRefused({
        reason: "harness_unreachable",
        detail: error.message ?? "the agent harness did not answer",
      });
    case "HarnessNotReady":
      return new GoalConversationRefused({
        reason: "harness_not_ready",
        detail:
          error.message ?? "that harness instance is not usable on this server",
      });
    case "CredentialRefused":
      // Unreachable through `issueWithoutExpiry`, whose parameter is a goal binding. Mapped
      // rather than died on, because a security boundary that refuses should be reported as
      // a refusal and not as a crash.
      return new GoalConversationRefused({
        reason: "store_unavailable",
        detail:
          error.message ??
          "a credential for this goal's agent could not be minted",
      });
    default:
      return new GoalConversationRefused({
        reason: "store_unavailable",
        detail:
          error.message ?? "this target's database could not be written to",
      });
  }
};

export class GoalConversations extends Context.Service<
  GoalConversations,
  {
    /**
     * Gives one operator message to a goal's agent, opening the conversation if needed.
     *
     * Returns as soon as the session has the message. The turn is the model's to take and
     * what it says arrives on the narration bus.
     *
     * **The first message does a great deal and the second does almost nothing**, which is
     * the shape worth knowing: message one creates the goal's directory, installs the
     * policy gate in it, resolves a harness, creates a session, mints a credential with no
     * clock expiry, registers the goal MCP endpoint under it, subscribes to narration,
     * records the session id and sends the prompt. Message two is a `prompt` into the same
     * session, queued behind whatever it is doing.
     */
    readonly send: (input: {
      readonly targetId: string;
      readonly goalId: string;
      /** The operator's words, trimmed by the payload decoder and otherwise untouched. */
      readonly text: string;
    }) => Effect.Effect<GoalTurnAccepted, GoalConversationRefused>;
    /**
     * One goal's conversation as a reloaded tab replays it, from the harness.
     *
     * Never fails: every way of having no prose is one of five sources with a sentence.
     * See `plan/goalNarration.ts`.
     */
    readonly replay: (input: {
      readonly targetId: string;
      readonly goalId: string;
      readonly limit?: number | undefined;
      readonly fetchTimeout?: Duration.Input | undefined;
    }) => Effect.Effect<GoalConversationView>;
    /**
     * Gives up on one goal's conversation: interrupts its narration, closes its scope and
     * revokes its credential. Idempotent, and safe for a goal with no live conversation.
     *
     * Nothing in this build calls it per goal yet — it is what this layer's own finalizer
     * uses for every session on shutdown — and it is on the interface rather than private
     * because "the authority ends when something closes it" is a claim a test has to be
     * able to make.
     */
    readonly close: (goalId: string) => Effect.Effect<void>;
  }
>()("bit/plan/GoalConversations") {
  static readonly layer: Layer.Layer<
    GoalConversations,
    never,
    | HarnessResolver
    | TargetStores
    | FleetStore
    | McpCredentials
    | WorkerEndpoints
    | RunNarrations
  > = Layer.effect(
    GoalConversations,
    Effect.suspend(() => make()),
  );

  /**
   * A conversation service for a process that has no harness to drive.
   *
   * `RunSupervisor.unavailable`'s arrangement and its reason: a server whose configured
   * harness is missing still boots and still serves the browser. `send` refuses
   * `no_harness` and `replay` still answers — from the store, which is why this requires
   * `TargetStores` — so a goal that has never been talked to reads as `absent` rather than
   * as a conversation the harness has forgotten. Those are different facts and a build with
   * no harness has no reason to confuse them.
   */
  static readonly unavailable: Layer.Layer<
    GoalConversations,
    never,
    TargetStores
  > = Layer.effect(
    GoalConversations,
    Effect.gen(function* () {
      const stores = yield* TargetStores;
      return GoalConversations.of({
        send: () =>
          Effect.fail(
            new GoalConversationRefused({
              reason: "no_harness",
              detail:
                "this server has no agent harness, so there is nothing to hold a conversation in: either the harness HARNESS names could not be started, or it was switched off with HARNESS=0. Check that the harness is installed and authenticated, then restart.",
            }),
          ),
        replay: (input) =>
          recordedSession(stores, input.targetId, input.goalId).pipe(
            Effect.flatMap((recorded) =>
              goalConversationNarration({
                resolver: undefined,
                targetId: input.targetId,
                goalId: input.goalId,
                recorded,
                liveSessionId: undefined,
                ...(input.limit === undefined ? {} : { limit: input.limit }),
              }),
            ),
          ),
        close: () => Effect.void,
      });
    }),
  );
}

/**
 * The session recorded for one goal, or `undefined` for a goal nobody has talked to.
 *
 * A failure to read it is **not** reported: the replay this feeds has no error channel, and
 * "the row could not be read" is indistinguishable to an operator from "there is no row"
 * — both mean this screen has no conversation to show. The failure is logged instead, and
 * the one thing that must not happen is a goal page that will not load because a side panel
 * could not answer.
 */
const recordedSession = (
  stores: TargetStores["Service"],
  targetId: string,
  goalId: string,
) =>
  stores.open(targetId).pipe(
    Effect.flatMap((store) => store.goalSession(goalId)),
    Effect.scoped,
    Effect.catchCause((cause) =>
      Effect.andThen(
        Effect.logWarning(
          "a goal's recorded conversation session could not be read; the conversation is reported as absent",
          { targetId, goalId, cause },
        ),
        Effect.succeed(undefined),
      ),
    ),
  );

const make = Effect.fnUntraced(function* () {
  const resolver = yield* HarnessResolver;
  const stores = yield* TargetStores;
  const fleet = yield* FleetStore;
  const credentials = yield* McpCredentials;
  const narrations = yield* RunNarrations;
  const endpoints = yield* WorkerEndpoints;

  /**
   * One entry per goal this process is holding a conversation for.
   *
   * Not a `FiberMap`, unlike the two supervisors', and the difference is the point: there
   * is no supervising fiber here. A conversation is a session plus a credential plus a
   * narration drain, and the thing that owns its lifetime is a `Scope` — so what this map
   * holds is the scope and the handle, and closing is closing a scope rather than
   * interrupting work.
   */
  const live = new Map<string, LiveConversation>();

  /**
   * One permit per goal, held while a conversation is being opened for it.
   *
   * **Without it two concurrent first messages on one goal each opened a session**, and a
   * review measured exactly that against the running server: two `POST
   * …/conversation` calls on a fresh goal both answered `conversation: "opened"` with two
   * different session ids. `live.set` keeps one, so the loser's `Scope` is in no map and
   * neither {@link GoalConversations.close} nor this layer's finalizer can ever close it —
   * leaving a **no-expiry** goal credential and a live MCP registration in the goal's own
   * directory, which §24.2 establishes *is* the authority boundary under OpenCode. Only
   * process death would have ended it, which contradicts the list of bounds this module's
   * header gives.
   *
   * It is the same shape of claim the two supervisors already take — `claimedGoals` in
   * `plan/planSupervisor.ts`, the workspace claim in `run/supervisor.ts` — and it covers
   * the same stretch those do: the whole of "decide there is nothing, then build it", with
   * the check **re-read inside the permit** so the loser finds the winner's session and
   * carries on into it rather than opening a second one.
   *
   * It also makes the two places a new conversation is written agree: `live.set` happens
   * inside `openConversation` and `recordGoalSession` after it, and under one permit no
   * interleaving can leave the map naming one session while the row names another.
   *
   * One entry per goal ever talked to, which is bounded by the goals an operator has
   * opened — the same bound `claimedGoals` has, and for the same reason it is not swept.
   */
  const opening = new Map<string, Semaphore.Semaphore>();
  const openingLock = (goalId: string): Semaphore.Semaphore => {
    const held = opening.get(goalId);
    if (held !== undefined) return held;
    const made = Semaphore.makeUnsafe(1);
    opening.set(goalId, made);
    return made;
  };

  /**
   * Gives up on one session: narration first, then its scope, then the belt-and-braces
   * revoke.
   *
   * The order matters in one direction only. The narrator is interrupted first so that no
   * entry is published for a session whose credential is about to go — an entry arriving
   * after the registration was removed would be narration about a session nothing can
   * authorise. Closing the scope is what actually revokes: the credential and the
   * registration are both acquired in it.
   *
   * **`revokeGoal` after the close is a check, not the mechanism.** It returns how many
   * grants it found, and the expected answer is zero, because the scope has just revoked
   * this goal's. A non-zero count means a goal grant existed that no scope owned, which is
   * a bug in this file rather than a condition to handle — so it is logged as one and the
   * grant is gone either way. It is also the only thing that would bound a leaked goal
   * credential in a process that keeps running, which is why the call is here rather than
   * trusted away.
   */
  const closeSession = Effect.fnUntraced(function* (entry: LiveConversation) {
    live.delete(entry.goalId);
    yield* Fiber.interrupt(entry.narrator);
    yield* Scope.close(entry.scope, Exit.void);
    const stray = yield* credentials.revokeGoal(entry.goalId);
    if (stray > 0) {
      yield* Effect.logError(
        "a goal credential outlived its session's scope and had to be revoked explicitly; the scope that acquired it should have done that",
        { goalId: entry.goalId, sessionId: entry.sessionId, revoked: stray },
      );
    }
    yield* Effect.logInfo("a goal conversation was closed", {
      goalId: entry.goalId,
      targetId: entry.targetId,
      sessionId: entry.sessionId,
    });
  });

  /**
   * Gives one message to a conversation that is already live.
   *
   * Extracted because there are now **two** places that reach it: an operator message with
   * a live entry already in hand, and one that waited on {@link opening} and found that the
   * conversation it was about to create had been created by somebody else. A second copy of
   * this would be a second decision about delivery timing.
   *
   * Delivered as a `steer` at `queued` urgency, which is the same seam a goal agent's
   * `steer_planner` uses into a round and the same reasoning (DECISIONS.md §24.1): the work
   * in flight finishes, then the message runs. `preemptive` would cut off whatever the
   * agent was in the middle of — including a tool call it was about to report on — and an
   * operator sending a second message has not asked for that.
   *
   * **The message id is minted, not derived, and that is the one place in this slice where
   * it is.** A derived id needs an operation identity to derive from, and an operator
   * message has none: `GoalMessageDraft` carries the operator's words and nothing else,
   * deliberately, and the alternative — deriving from the text — would silently swallow a
   * legitimately repeated sentence. So a double-submitted "yes" is two messages, because
   * that is what was sent twice. `steer_planner`'s id *is* derived, from the `operation_id`
   * its own tool contract requires.
   */
  const deliverInto = Effect.fnUntraced(function* (
    entry: LiveConversation,
    text: string,
  ) {
    const accepted = yield* Effect.result(
      entry.harness.prompt(entry.sessionId, text, {
        _tag: "steer",
        urgency: "queued",
        messageId: crypto.randomUUID().replaceAll("-", ""),
      }),
    );
    if (accepted._tag === "Failure") {
      /*
       * The session would not take it. On Claude Code that includes a session whose query
       * has closed — a stream that died, or a harness that was torn down — and the honest
       * move is to give up on this conversation so the *next* message opens a new one
       * rather than failing the same way forever.
       */
      yield* closeSession(entry);
      return yield* refuse(accepted.failure);
    }
    return {
      targetId: entry.targetId,
      goalId: entry.goalId,
      harnessSessionId: entry.sessionId,
      instanceId: entry.instanceId,
      providerId: entry.providerId,
      modelId: entry.modelId,
      conversation: "continued",
      priorUnavailable: false,
      note: "",
      acceptedAt: Date.now(),
    } satisfies GoalTurnAccepted;
  });

  // Owned by this layer's scope, so a `SIGINT` closes every conversation rather than
  // dropping it with a live credential behind it.
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...live.values()], closeSession, { discard: true }),
  );

  /**
   * Publishes one session's narration under its goal, for as long as the session lives.
   *
   * `plan/planSupervisor.ts`'s `narrateRound` without the outcome half: a conversation has
   * no terminal outcome to read off the stream, because it does not settle. A failure here
   * is logged and nothing more — the stream breaking says nothing about the session, and
   * the next message will still reach it.
   *
   * **Publishing is not persisting.** An entry published with nobody listening is gone, and
   * a reload replays from the harness instead (`plan/goalNarration.ts`).
   */
  const narrate = Effect.fnUntraced(function* (input: {
    readonly harness: AgentHarness["Service"];
    readonly targetId: string;
    readonly goalId: string;
    readonly sessionId: string;
  }) {
    const outcome = yield* Effect.result(
      Stream.runForEach(input.harness.sessionEvents(input.sessionId), (entry) =>
        narrations.publish({
          targetId: input.targetId,
          subject: { _tag: "goal", goalId: input.goalId },
          harnessSessionId: input.sessionId,
          entry,
        }),
      ),
    );
    if (outcome._tag === "Failure") {
      yield* Effect.logWarning(
        "a goal conversation's narration stream ended; this says nothing about the session, and the next message still reaches it",
        {
          goalId: input.goalId,
          sessionId: input.sessionId,
          detail: outcome.failure.message,
        },
      );
    }
  });

  /**
   * Opens a conversation: the directory, the session, the credential, the registration.
   *
   * Every step can fail and the refusals are the ones an operator can act on. The order is
   * `plan/planSupervisor.ts`'s `prepareRound`, minus the row it has no equivalent of:
   *
   * **1. The directory, through `gatedRoleDirectory` and no other way.** The policy gate is
   * installed into a directory where the goal agent is not expected to run a shell command,
   * and that is the point rather than an oversight: "the goal agent does not run commands"
   * is an assumption about what a model will choose to do, and the gate is what makes it a
   * fact. Under OpenCode this directory is also the authority boundary (DECISIONS.md §24.2)
   * — the only session in it is this one, which is what makes a credential with no expiry
   * containable.
   *
   * **2. The session, with `multiTurn` set.** No lineage and no parent: the planner's
   * lineage belongs to planner rounds, and parenting a conversation onto it would hand the
   * goal agent a prompt-cache prefix built from a different role's prompts.
   *
   * **3. The credential, then the registration**, in that order and both in the session's
   * own scope — so both go when {@link closeSession} closes it.
   *
   * **4. The row, last, and only once everything above worked.** A `goal_sessions` row for
   * a session that was never registered would make the next message report
   * `priorUnavailable` about a conversation that never existed.
   */
  const openConversation = Effect.fnUntraced(function* (input: {
    readonly targetId: string;
    readonly goalId: string;
    readonly targetName: string;
    readonly workspace: string | undefined;
  }) {
    const urls = yield* endpoints.urls;
    /*
     * The harness, resolved first, so a server that cannot give this conversation one
     * leaves nothing behind: no directory, no session, no credential, no row.
     *
     * Mapped through `refuse` here rather than leaking `HarnessNotReady` out of this
     * function, for `plan/planSupervisor.ts`'s reason: every failure a caller of this
     * service can see is a `GoalConversationRefused`, and a second error type on the
     * channel would be a second thing every call site had to learn.
     */
    const chosen = yield* Effect.result(resolver.resolve(undefined));
    if (chosen._tag === "Failure") return yield* refuse(chosen.failure);
    const resolved = chosen.success;
    const harness = resolved.harness;
    const sessionId = harness.newSessionId();
    const model = harness.instance.defaultModel;
    const provenance = harness.modelProvenance(model);

    /**
     * The conversation's own scope, which outlives this request.
     *
     * `Scope.make` rather than the caller's scope, because the caller is an HTTP handler
     * that is about to answer: a credential acquired in the request's scope would be
     * revoked the moment the operator's message was accepted. Closed by
     * {@link closeSession}, and by this layer's finalizer for anything still open.
     */
    const scope = yield* Scope.make();
    const opened = yield* Effect.result(
      Effect.gen(function* () {
        const directory: GatedDirectory = yield* gatedRoleDirectory({
          ensure: fleet.ensureGoalDirectory(input.targetId, input.goalId),
          install: harness.installGate,
          policyUrl: urls.policy,
          // Outside the goal's directory, like a round's: the gate's own record must not
          // be somewhere the gated agent can read or rewrite.
          auditPath: `${fleet.paths.evidenceDirectory(input.targetId)}/${POLICY_AUDIT_FILE}`,
          // Passed so the containment check can refuse a goal directory inside the
          // engagement folder. `undefined` says this target has no folder, which is a
          // statement rather than an omission.
          workspace: input.workspace,
        });
        const created = yield* createGoalSession(harness, {
          title: `bit goal agent: ${input.targetName}`,
          model,
          directory,
          sessionId,
        });
        const credential = yield* credentials.issueWithoutExpiry({
          // A goal agent, said rather than implied: the registry takes a tagged binding,
          // and only a goal binding may be issued without a clock expiry.
          _tag: "goal",
          targetId: input.targetId,
          goalId: input.goalId,
        });
        const serverName = bitMcpServerName(input.goalId);
        yield* Effect.acquireRelease(
          harness.registerMcpServer(created.id, serverName, {
            // The **goal** endpoint. This is the line that decides which tool list this
            // session is offered: `mcp/server.ts` serves one toolkit per path, and each
            // endpoint's middleware refuses a resolved grant whose tag is not the role it
            // serves. A goal credential at the planner URL is a `401` before any tool list
            // is produced — which is what makes "no `add_intent`" a property of the
            // registration rather than of a filter.
            url: urls.goalMcp,
            headers: {
              authorization: Redacted.make(
                `Bearer ${Redacted.value(credential.token)}`,
              ),
            },
            directory,
          }),
          () =>
            harness.unregisterMcpServer(created.id, serverName).pipe(
              Effect.catch((failure) =>
                Effect.logWarning(
                  "a harness would not take back a goal agent's MCP registration; the credential behind it is revoked either way",
                  {
                    goalId: input.goalId,
                    server: serverName,
                    detail: failure.message,
                  },
                ),
              ),
            ),
        );
        return created.id;
      }).pipe(Scope.provide(scope)),
    );
    if (opened._tag === "Failure") {
      // Nothing was registered or the session could not be made: close the scope rather
      // than leave a credential behind a conversation that does not exist.
      yield* Scope.close(scope, Exit.void);
      return yield* refuse(opened.failure);
    }

    const narrator = yield* Effect.forkIn(
      narrate({
        harness,
        targetId: input.targetId,
        goalId: input.goalId,
        sessionId: opened.success,
      }),
      scope,
    );
    const entry: LiveConversation = {
      goalId: input.goalId,
      targetId: input.targetId,
      sessionId: opened.success,
      instanceId: harness.instance.instanceId,
      providerId: provenance.providerId,
      modelId: provenance.modelId,
      harness,
      scope,
      narrator,
      openedAt: Date.now(),
    };
    live.set(input.goalId, entry);
    return entry;
  });

  const send: GoalConversations["Service"]["send"] = Effect.fn(
    "GoalConversations.send",
  )(function* (input) {
    /**
     * The goal, read before anything is opened.
     *
     * Two things come from it: whether a conversation may be had at all, and the objective
     * the preamble puts in front of the agent. A goal that is `met` or `abandoned` is
     * refused — not because talking is harmful, but because an agent whose every write
     * would be refused by `checkGoalAuthority` is an agent that can only disappoint, and a
     * conversation opened on an ended goal would cost a session and a directory to say so.
     *
     * A goal that is not in this target reaches this as `goal_not_active` rather than as a
     * `404`: the route checks existence first and answers `GoalNotFound`, so this branch is
     * only reachable by a race, and `undefined` from `loadGoal` is the same fact either way.
     */
    const read = yield* Effect.result(
      stores.open(input.targetId).pipe(
        Effect.flatMap((store) =>
          Effect.all({
            goal: store.loadGoal(input.goalId),
            session: store.goalSession(input.goalId),
          }),
        ),
        Effect.scoped,
      ),
    );
    if (read._tag === "Failure") return yield* refuse(read.failure);
    const goal = read.success.goal;
    if (goal === undefined || goal.targetId !== input.targetId) {
      return yield* new GoalConversationRefused({
        reason: "goal_not_active",
        detail: `no goal ${input.goalId} is recorded in target ${input.targetId}, so there is nothing to talk about`,
      });
    }
    if (goal.status !== "active") {
      return yield* new GoalConversationRefused({
        reason: "goal_not_active",
        detail: `goal ${input.goalId} is ${goal.status}, so its agent's authority has ended: every write it made would be refused and no planner round can be opened on it. An ended goal is not reopened, and a different conclusion is a new goal.`,
      });
    }

    const existing = live.get(input.goalId);
    if (existing !== undefined) return yield* deliverInto(existing, input.text);

    /*
     * Nothing live, so one is opened — under this goal's permit, from here to the end.
     *
     * The permit covers the decision *and* the building, and the first thing inside it is
     * the same read again: a message that waited here while another opened the conversation
     * must carry on into that one rather than build a second. See {@link opening} for what
     * two sessions on one goal cost.
     */
    return yield* Semaphore.withPermit(openingLock(input.goalId))(
      Effect.gen(function* () {
        const raced = live.get(input.goalId);
        if (raced !== undefined) return yield* deliverInto(raced, input.text);

        /**
         * No live conversation, so one is opened — and whether there *was* one is the fact the
         * next few lines exist for.
         *
         * The recorded session id survives a restart and the credential does not (grants are
         * in memory only), so a row with no live entry means the previous conversation is
         * unreachable: it cannot be prompted, because its agent has no authority, and
         * prompting it anyway would produce a session with no tools answering into a chat whose
         * beginning the operator cannot see. The brief's requirement is that the next message
         * **opens a new session and says so**, and this is both halves of it.
         */
        const priorUnavailable = read.success.session !== undefined;
        const row = yield* Effect.result(fleet.target(input.targetId));
        if (row._tag === "Failure") return yield* refuse(row.failure);
        if (row.success === undefined) {
          return yield* new GoalConversationRefused({
            reason: "target_unavailable",
            detail: `no target '${input.targetId}' is registered on this server`,
          });
        }
        const entry = yield* openConversation({
          targetId: input.targetId,
          goalId: input.goalId,
          targetName: row.success.name,
          workspace: row.success.workspacePath ?? undefined,
        });

        // The row last, and only now: see `openConversation`'s step 4.
        const recorded = yield* Effect.result(
          stores.open(input.targetId).pipe(
            Effect.flatMap((store) =>
              store.recordGoalSession({
                goalId: input.goalId,
                targetId: input.targetId,
                harnessSessionId: entry.sessionId,
                harnessInstanceId: entry.instanceId,
              }),
            ),
            Effect.scoped,
          ),
        );
        if (recorded._tag === "Failure") {
          /*
           * The session exists and cannot be found again after a reload.
           *
           * Not a refusal: the conversation is open, the operator's message is about to be
           * delivered, and refusing would throw away a working session over a row that only
           * matters to a *later* page load. Logged, because the consequence is real — a reload
           * will report this conversation as absent — and the next message that opens a
           * session will try the row again.
           */
          yield* Effect.logError(
            "a goal conversation's session could not be recorded; a reload will not find it",
            {
              goalId: input.goalId,
              targetId: input.targetId,
              sessionId: entry.sessionId,
              detail: recorded.failure.message,
            },
          );
        }

        const prompted = yield* Effect.result(
          entry.harness.prompt(
            entry.sessionId,
            assembleGoalOpeningPrompt({
              goalId: input.goalId,
              targetName: row.success.name,
              name: goal.name,
              objective: goal.description,
              message: input.text,
            }),
            OPEN_PROMPT,
          ),
        );
        if (prompted._tag === "Failure") {
          // Nothing ran, and the session is useless: it has been prompted-and-failed, and this
          // seam never resubmits a prompt. Closed so the next message opens a fresh one.
          yield* closeSession(entry);
          return yield* refuse(prompted.failure);
        }

        yield* Effect.logInfo("a goal conversation was opened", {
          goalId: input.goalId,
          targetId: input.targetId,
          sessionId: entry.sessionId,
          instanceId: entry.instanceId,
          priorUnavailable,
        });
        return {
          targetId: input.targetId,
          goalId: input.goalId,
          harnessSessionId: entry.sessionId,
          instanceId: entry.instanceId,
          providerId: entry.providerId,
          modelId: entry.modelId,
          conversation: "opened",
          priorUnavailable,
          note: priorUnavailable
            ? `This goal had a conversation on session ${read.success.session?.harnessSessionId ?? "an earlier session"}, which this server process no longer holds — a restart ends a conversation, because the agent's authority lives only in memory. A new conversation has been opened and the agent in it has not read any of the previous one.`
            : "This is the first message on this goal, so a conversation was opened for it: the agent has the goal's objective and its own tools, and has not read anything else yet.",
          acceptedAt: Date.now(),
        } satisfies GoalTurnAccepted;
      }),
    );
  });

  const replay: GoalConversations["Service"]["replay"] = Effect.fn(
    "GoalConversations.replay",
  )(function* (input) {
    const recorded = yield* recordedSession(
      stores,
      input.targetId,
      input.goalId,
    );
    const here = live.get(input.goalId);
    return yield* goalConversationNarration({
      resolver,
      targetId: input.targetId,
      goalId: input.goalId,
      recorded,
      liveSessionId: here?.sessionId,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.fetchTimeout === undefined
        ? {}
        : { fetchTimeout: input.fetchTimeout }),
    });
  });

  return GoalConversations.of({
    send,
    replay,
    close: (goalId) => {
      const entry = live.get(goalId);
      return entry === undefined ? Effect.void : closeSession(entry);
    },
  });
});
