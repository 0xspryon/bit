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
  GoalUploadRefused,
  bitMcpServerName,
  type GoalConversationView,
  type GoalTurnAccepted,
  type GoalUploadView,
  type GoalUploadsAccepted,
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

import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, relative } from "node:path";

import { AgentHarness, OPEN_PROMPT } from "../harness/agentHarness";
import { HarnessResolver } from "../harness/resolver";
import { FleetStore, type FleetPaths } from "../persistence/fleet";
import { McpCredentials } from "../mcp/credentials";
import { TargetStores } from "../persistence/targetStores";
import {
  gatedRoleDirectory,
  resolveThroughSymlinks,
  type GatedDirectory,
} from "../policy/install";
import { POLICY_AUDIT_FILE } from "../policy/install";
import { RunNarrations } from "../run/narration";
import { WorkerEndpoints } from "../run/supervisor";
import {
  assembleGoalFollowUpPrompt,
  assembleGoalOpeningPrompt,
  type PromptAttachment,
} from "./goalPrompt";
import { goalConversationNarration } from "./goalNarration";
import {
  describeBytes,
  listAttachments,
  safeUploadPath,
  unlistedEntries,
  uploadNameRefusal,
  type CollectedUpload,
} from "./goalUploads";

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

/**
 * One file as the HTTP layer hands it over: read off the wire, not yet anywhere on disk.
 *
 * `plan/goalUploads.ts`'s `CollectedUpload` — the multipart consumer's output, since the
 * pinned server's buffered multipart cannot run in this build (see the contract's
 * `GoalUploadDraft`). **Nothing here is a destination and nothing here is trusted**:
 * `name` is checked against the allow-list and then again as a resolved path,
 * `contentType` is recorded and never read, and the only place the bytes end up is a path
 * this layout built.
 */
export type IncomingUpload = CollectedUpload;

/**
 * The files a goal holds, ready for the prompt, or an empty list.
 *
 * Read from the directory on every message rather than remembered, which is the reason
 * `plan/goalPrompt.ts` carries the list on later messages too: the operator can attach
 * something mid-conversation, and a list the server remembered from the first turn would
 * be a list of what *was* there.
 *
 * `goalUploadsDirectory` throws on an id that could not name a directory, so it is guarded:
 * a goal whose id is unusable has no uploads and is told about none, rather than failing a
 * message over a directory nothing wrote to.
 */
const attachmentsFor = (
  paths: FleetPaths,
  targetId: string,
  goalId: string,
): {
  readonly directory: string;
  readonly files: readonly PromptAttachment[];
  readonly unlistable: number;
} => {
  let directory: string;
  try {
    directory = paths.goalUploadsDirectory(targetId, goalId);
  } catch {
    return { directory: "", files: [], unlistable: 0 };
  }
  return {
    directory,
    files: listAttachments(directory),
    // What the directory holds that `listAttachments` will not name — a file whose name
    // could not be rendered into the prompt, or a symlink. Carried so the block can say
    // there is something it is not showing instead of quietly showing less.
    unlistable: unlistedEntries(directory),
  };
};

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
  /**
   * Whether this session has been given its opening prompt.
   *
   * **The one thing that makes the outside-the-permit fast path safe**, and it was missing.
   * `openConversation` publishes the entry into `live` before the opening prompt is sent —
   * it has to, because the entry owns the `Scope` that holds the credential and the
   * registration, and a scope in no map is a scope nothing can close. So between that
   * publish and the prompt being accepted there is a window in which `send`'s first read
   * finds a live conversation and delivers a message straight into it.
   *
   * That message reaches a session that has **not received its preamble**, and the preamble
   * is the one place the agent is told that an attached file's content and its *name* are
   * data to report and never an instruction to follow. Slice 11 put the operator's own
   * uploaded files in that session's own directory, with tools that write to the
   * investigation's record behind them, so the window stopped being a framing problem and
   * started being an injection one.
   *
   * A flag rather than a `Deferred`, because nothing has to *wait* on it here: a message
   * that finds an unpreambled entry falls through to the goal's opening permit, which the
   * opener holds until the prompt has been accepted — so by the time it is granted the
   * conversation is either preambled or gone.
   */
  readonly preambled: boolean;
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
    /**
     * Puts files where this goal's agent can read them, and tells nobody yet.
     *
     * **It does not open a conversation and does not prompt anything.** The files land on
     * disk and the agent learns about them on the operator's *next* message, as the
     * attachment block {@link assembleGoalFollowUpPrompt} puts above the delimiter. Doing
     * it the other way — attaching a file as a turn — would make an upload cost a model
     * call and would mean an operator who attached three files sent three messages.
     *
     * **It is on this service, not beside it**, because what an upload needs is exactly
     * what opening a conversation needs: the goal's row, the goal's directory *through the
     * gate*, and a harness to install that gate. A second service would be a second place
     * holding the same four dependencies and the same ordering rule. A consequence worth
     * stating: a server with no harness refuses an attachment `no_harness`, which is
     * honest — it could not run the agent that would read the file either.
     *
     * Caps are the caller's, from `UPLOAD_MAX_BYTES` and `UPLOAD_MAX_FILES`, threaded the
     * way `goalBriefingMaxChars` is: configuration belongs to the composition root, and a
     * cap read from the environment inside here would be unreachable from a test.
     *
     * `files` are the parts the HTTP layer has already read off the wire and bounded, and
     * they are bytes rather than paths: the multipart shape this build can use hands over
     * a part stream, so there is no temporary file anywhere and the first thing to touch
     * the disk is this function writing where it decided to write.
     */
    readonly attach: (input: {
      readonly targetId: string;
      readonly goalId: string;
      readonly files: readonly IncomingUpload[];
      readonly maxBytes: number;
      readonly maxFiles: number;
    }) => Effect.Effect<GoalUploadsAccepted, GoalUploadRefused>;
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
        /*
         * No harness, so no gate installer, so no directory an agent may be given files in.
         *
         * Refused rather than written anyway, and the sentence says why it is the harness
         * that is missing rather than the disk: a file put in an ungated role directory
         * would be sitting where nothing is watching what an agent does with it, and this
         * server could not run that agent in the first place.
         */
        attach: () =>
          Effect.fail(
            new GoalUploadRefused({
              reason: "no_harness",
              detail:
                "this server has no agent harness, so there is no conversation to attach anything to and no gate to install into a goal's directory: either the harness HARNESS names could not be started, or it was switched off with HARNESS=0. Check that the harness is installed and authenticated, then restart.",
            }),
          ),
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
    /*
     * The operator's words, verbatim — unless this goal has files attached, in which case
     * the list goes **above** the delimiter and the words below it are still exactly what
     * was typed. `plan/goalPrompt.ts`'s header has the two reasons the list repeats per turn
     * while the rules do not.
     */
    const prompt = assembleGoalFollowUpPrompt({
      attachments: attachmentsFor(fleet.paths, entry.targetId, entry.goalId),
      message: text,
    });
    const accepted = yield* Effect.result(
      entry.harness.prompt(entry.sessionId, prompt, {
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
      // Nothing has been said to this session yet. The entry is published anyway — its
      // `Scope` holds the credential and the registration, and a scope in no map is a scope
      // neither `close` nor this layer's finalizer can reach — so what keeps a message out
      // of it until the preamble has landed is the flag rather than the absence of a row.
      // See {@link LiveConversation.preambled}.
      preambled: false,
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

    /*
     * The fast path: a conversation that is live **and has had its preamble**.
     *
     * `preambled` is the whole of the second condition and it is not a tidying detail. The
     * entry is published before the opening prompt is sent, so without it a message
     * arriving in that window is delivered to a session that was never given the framing —
     * including the rule that an attached file's content and name are data to report and
     * never an instruction to follow. An unpreambled entry falls through to the permit
     * below, which the opener holds until the prompt has been accepted.
     */
    const existing = live.get(input.goalId);
    if (existing !== undefined && existing.preambled) {
      return yield* deliverInto(existing, input.text);
    }

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
        /*
         * The winner's session, if one was built while this message waited here.
         *
         * No `preambled` check is needed and its absence is not an oversight: the opener
         * holds this permit across the prompt, so an entry reachable from inside it has
         * either been preambled or — on a prompt that failed — closed and removed. That is
         * the invariant the flag exists to make true of the read *outside* the permit.
         */
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
              // Read now, not at upload time: a file attached before the first message is
              // one the agent must be told about in the prompt that opens the session.
              attachments: attachmentsFor(
                fleet.paths,
                input.targetId,
                input.goalId,
              ),
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
        /*
         * The preamble has landed, so the session may now be messaged from outside the
         * permit.
         *
         * Set here and nowhere else — after the prompt was *accepted* and before the permit
         * is released, so no interleaving can observe a preambled entry that has not been
         * preambled. Written as a replacement entry rather than a mutation because
         * `LiveConversation` is readonly throughout; the `Scope` and the narrator fiber are
         * the same objects, so `closeSession` closes the same things either way.
         */
        live.set(input.goalId, { ...entry, preambled: true });

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

  /**
   * Stores the operator's files under this goal, or refuses naming the figure.
   *
   * The order of the checks is the point of the function, and every one of them is on this
   * side of the wire:
   *
   * 1. **The goal.** `met` or `abandoned` takes no attachment, for the reason it takes no
   *    message: the agent that would read it has no authority left.
   * 2. **The names and the bytes**, before anything is created. A name is checked against
   *    `plan/goalUploads.ts`'s allow-list; a zero-byte file and one over `maxBytes` are
   *    refused with the size in the sentence. The bytes are already in memory — the HTTP
   *    layer handed over a part stream, not files on disk — so a request refused here has
   *    created nothing at all, not even a directory.
   * 3. **The directory, through `gatedRoleDirectory` and no other way** — the same three
   *    lines `openConversation` uses and the same reason. The gate has to be in a directory
   *    before the operator's documents are, because that gate is what records anything the
   *    agent does in there. `FleetStore.ensureGoalUploads` then takes the **gated** path, so
   *    the directory written to is derived from the directory that was gated — and the
   *    result is then resolved through symlinks and required to still be inside that
   *    directory, because `mkdir -p` is happy to accept an `uploads` that is a link
   *    somewhere else.
   * 4. **The count**, measured against the directory rather than the request, so the cap
   *    cannot be walked past `maxFiles` at a time. A name already attached is a replacement
   *    and does not count towards it.
   * 5. **The destinations**, every one of them, before any of them is written: whatever is
   *    already at each path is inspected with `lstat`, a plain file is unlinked so the write
   *    can replace it, and **anything else — a symlink above all — is refused**. The comment
   *    on that refusal says why it is a refusal and not a silent replacement, and why the
   *    pass is separate from the writes.
   * 6. **The writes**, last, each through `O_CREAT | O_EXCL | O_NOFOLLOW`, so an entry
   *    planted between step 5 and step 6 makes the write fail rather than send the
   *    operator's bytes somewhere this directory does not contain. The comment there also
   *    records the one window this does **not** close — a swap of `uploads/` itself after
   *    step 3 — with who can reach it and why that is where this stops.
   *
   * Nothing is prompted and no session is opened. The agent is told on the next message.
   */
  const attach: GoalConversations["Service"]["attach"] = Effect.fn(
    "GoalConversations.attach",
  )(function* (input) {
    if (input.files.length === 0) {
      return yield* new GoalUploadRefused({
        reason: "no_files",
        detail:
          "that request carried no file in it, so nothing was attached. Pick one or more files and attach them again.",
      });
    }

    const read = yield* Effect.result(
      stores.open(input.targetId).pipe(
        Effect.flatMap((store) => store.loadGoal(input.goalId)),
        Effect.scoped,
      ),
    );
    if (read._tag === "Failure") {
      return yield* new GoalUploadRefused({
        reason: "store_unavailable",
        detail:
          read.failure.message ??
          "this target's database could not be read, so the goal these files belong to could not be checked",
      });
    }
    const goal = read.success;
    if (goal === undefined || goal.targetId !== input.targetId) {
      return yield* new GoalUploadRefused({
        reason: "goal_not_active",
        detail: `no goal ${input.goalId} is recorded in target ${input.targetId}, so there is nothing to attach these files to`,
      });
    }
    if (goal.status !== "active") {
      return yield* new GoalUploadRefused({
        reason: "goal_not_active",
        detail: `goal ${input.goalId} is ${goal.status}, so its agent's authority has ended and nothing new is read under it. An ended goal is not reopened, and a different conclusion is a new goal.`,
      });
    }

    /* The names and the sizes, all of them, before any directory is made. */
    const measured: {
      readonly name: string;
      readonly contentType: string;
      readonly content: Uint8Array;
      readonly bytes: number;
    }[] = [];
    for (const file of input.files) {
      const unusable = uploadNameRefusal(file.name);
      if (unusable !== undefined) {
        return yield* new GoalUploadRefused({
          reason: "unsafe_name",
          detail: unusable,
        });
      }
      const bytes = file.bytes.byteLength;
      if (bytes === 0) {
        return yield* new GoalUploadRefused({
          reason: "empty_file",
          detail: `'${file.name}' is empty, so it was refused rather than attached. An agent told to read a file with nothing in it reports that the evidence says nothing, which would be a false reading of an upload that went wrong.`,
        });
      }
      if (bytes > input.maxBytes) {
        return yield* new GoalUploadRefused({
          reason: "too_large",
          detail: `'${file.name}' is ${describeBytes(bytes)}, over this server's per-file cap of ${describeBytes(input.maxBytes)}, so nothing in that request was attached. Attach a smaller file — an extract or a summary of the part that matters — or raise UPLOAD_MAX_BYTES on the server and restart it.`,
        });
      }
      measured.push({
        name: file.name,
        contentType: file.contentType,
        content: file.bytes,
        bytes,
      });
    }

    /* The harness, only now: it is needed for the gate installer and nothing else here. */
    const chosen = yield* Effect.result(resolver.resolve(undefined));
    if (chosen._tag === "Failure") {
      return yield* new GoalUploadRefused({
        reason:
          chosen.failure._tag === "HarnessNotReady"
            ? "harness_not_ready"
            : "no_harness",
        detail:
          chosen.failure.message ??
          "this server has no usable agent harness, so a goal directory cannot be gated and nothing may be written into it",
      });
    }

    const registered = yield* Effect.result(fleet.target(input.targetId));
    const row = registered._tag === "Failure" ? undefined : registered.success;
    if (row === undefined) {
      return yield* new GoalUploadRefused({
        reason: "target_unavailable",
        detail: `no target '${input.targetId}' is registered on this server`,
      });
    }
    const urls = yield* endpoints.urls;

    const prepared = yield* Effect.result(
      Effect.gen(function* () {
        const directory: GatedDirectory = yield* gatedRoleDirectory({
          ensure: fleet.ensureGoalDirectory(input.targetId, input.goalId),
          install: chosen.success.harness.installGate,
          policyUrl: urls.policy,
          auditPath: `${fleet.paths.evidenceDirectory(input.targetId)}/${POLICY_AUDIT_FILE}`,
          // Explicitly `undefined` for a target with no folder, which is what makes the
          // containment check — a goal directory, and so its `uploads/`, must never be
          // inside the workspace workers share — run rather than silently skip.
          workspace: row.workspacePath ?? undefined,
        });
        return {
          goal: directory,
          uploads: yield* fleet.ensureGoalUploads(directory, input.targetId),
        };
      }),
    );
    if (prepared._tag === "Failure") {
      const failure = prepared.failure;
      return yield* new GoalUploadRefused({
        reason:
          failure._tag === "PolicyHookNotInstalled"
            ? "goal_ungated"
            : failure._tag === "FleetError"
              ? "goal_directory_unusable"
              : "write_failed",
        detail:
          failure.message ??
          "this goal's uploads directory could not be prepared, so nothing was attached",
      });
    }
    const uploads = prepared.success.uploads;

    /*
     * The directory, resolved **through symlinks**, and required to still be inside the
     * gated goal directory.
     *
     * `ensureGoalUploads` is `mkdir -p` on `<gated>/uploads`, and `mkdir -p` succeeds
     * silently when `uploads` is already a symlink to a directory somewhere else — so the
     * path being derived from the gated string proves where it was *built*, not where it
     * *is*. `O_NOFOLLOW` on the write below covers the last component only, which is why
     * this covers the one above it. `policy/install.ts` owns `resolveThroughSymlinks` and
     * `gatedRoleDirectory` already relies on it for exactly this class of question.
     *
     * **A check at one moment, and the writes happen later.** A swap of `uploads/` after
     * this line is not seen here and is not caught by `O_NOFOLLOW` either, which has no
     * opinion about intermediate components. The window, who can reach it, and why it is
     * accepted rather than defended are written out at the `openSync` below; this comment
     * should not be read as a claim that holds for the duration of the request.
     */
    const contained = yield* Effect.result(
      Effect.try(() => {
        const real = resolveThroughSymlinks(uploads);
        const inside = relative(
          resolveThroughSymlinks(prepared.success.goal),
          real,
        );
        return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
      }),
    );
    if (contained._tag === "Failure" || !contained.success) {
      return yield* new GoalUploadRefused({
        reason: "goal_directory_unusable",
        detail: `${uploads} does not resolve to a directory inside this goal's own directory, so nothing was attached. Something has replaced it with a link or a mount; the whole point of this path is that only this goal's agent can read what is in it, and a path that resolves elsewhere cannot make that claim. Remove whatever is at that path and attach the files again.`,
      });
    }

    /*
     * The count, against the directory. A name already there is a replacement and is not
     * counted again — which is also why re-attaching a corrected file never trips the cap.
     */
    const existing = listAttachments(uploads);
    const held = new Set(existing.map((file) => file.name));
    const arriving = new Set(measured.map((file) => file.name));
    const added = [...arriving].filter((name) => !held.has(name)).length;
    if (existing.length + added > input.maxFiles) {
      return yield* new GoalUploadRefused({
        reason: "too_many",
        detail: `this goal already holds ${String(existing.length)} attached ${existing.length === 1 ? "file" : "files"} and that request would add ${String(added)} more, over this server's cap of ${String(input.maxFiles)} per goal — so nothing in it was attached. The cap counts what the goal holds rather than what one request carries, because every attached file is named in every prompt this agent is sent. Remove what is no longer needed from ${uploads}, or raise UPLOAD_MAX_FILES on the server and restart it.`,
      });
    }

    /*
     * Every destination, inspected before any of them is written.
     *
     * Two passes rather than one so the all-or-nothing property survives this check: a
     * symlink sitting at the third of five names must refuse the whole request, not leave
     * two files attached. `lstat` and not `stat`, because the question is what is *at* the
     * path and not what it points to.
     */
    const destinations: {
      readonly file: (typeof measured)[number];
      readonly path: string;
      readonly replacing: boolean;
    }[] = [];
    for (const file of measured) {
      const destination = safeUploadPath(uploads, file.name);
      if (destination === undefined) {
        // Unreachable through `uploadNameRefusal`, which has already refused every name
        // that is really a path. Kept as a refusal rather than a cast, because this is the
        // check that is about a resolved path instead of about a string, and a boundary
        // that is only enforced by the check before it is enforced once.
        return yield* new GoalUploadRefused({
          reason: "unsafe_name",
          detail: `'${file.name}' does not resolve to a file inside this goal's uploads directory, so nothing was attached`,
        });
      }
      const standing = yield* Effect.result(
        Effect.try(() => lstatSync(destination)),
      );
      if (standing._tag === "Failure") {
        // `ENOENT`: nothing is there, which is the ordinary case and the only one that needs
        // no decision. Any other `lstat` failure also lands here and is answered by the
        // `O_NOFOLLOW` open below, which cannot be made to write through anything.
        destinations.push({ file, path: destination, replacing: false });
        continue;
      }
      if (standing.success.isFile()) {
        destinations.push({ file, path: destination, replacing: true });
        continue;
      }
      /*
       * Something is at this path that is not a plain file, and a symlink is the one that
       * matters: `writeFileSync` through a link writes to the link's *target*, so the
       * operator's bytes would land outside this directory — outside the fleet root, if the
       * link says so — while the answer claimed they were "in this goal agent's own
       * directory, where no worker can read them". A durable record that lies about where a
       * file went is worse than no record, so this is a refusal.
       *
       * **Refused rather than replaced.** Unlinking the link and writing a real file in its
       * place would also be safe, and `replaced: true` would then be reported for something
       * that was never an attachment. An operator who finds this refusal has learned that
       * something put a link in their goal's uploads directory, which is worth knowing.
       */
      return yield* new GoalUploadRefused({
        reason: "write_failed",
        detail: `'${file.name}' cannot be stored: something that is not a plain file — ${standing.success.isSymbolicLink() ? "a symbolic link" : standing.success.isDirectory() ? "a directory" : "a device, socket or pipe"} — is already at that name in this goal's uploads directory, and nothing in this request was attached. Writing through it would put your file wherever it points, which is not somewhere this server can promise only this goal's agent can read. Nothing created that entry through this route; remove it and attach the files again.`,
      });
    }

    const stored: GoalUploadView[] = [];
    for (const destination of destinations) {
      const file = destination.file;
      const written = yield* Effect.result(
        Effect.try(() => {
          /*
           * `O_CREAT | O_EXCL | O_NOFOLLOW`, and the unlink above it rather than a plain
           * `writeFileSync`.
           *
           * **What this closes, exactly: the final component.** `O_NOFOLLOW` makes the open
           * fail with `EEXIST`/`ELOOP` when the last path element is a symbolic link, and
           * `O_EXCL` makes it fail when anything at all is already there — so an entry
           * planted between the `lstat` above and this line loses the race rather than
           * winning it. Without the pair, `writeFileSync` through a planted link put the
           * operator's bytes at the link's target, outside this directory and outside the
           * fleet root, while the route answered `201` claiming containment.
           *
           * That is the difference between a containment claim this server checked and one
           * the filesystem could quietly deny: `safeUploadPath` resolves `..` and separators
           * in a *string*, and this asks the same question of the filesystem.
           *
           * **What it does not close, and why that was weighed rather than missed.** The
           * directory containment check above runs **once**, before this loop, and
           * `O_NOFOLLOW` has nothing to say about an *intermediate* component — so a process
           * that can write the goal directory could replace `uploads/` with a symlink between
           * that check and this open, and this `openSync` would then create the file inside
           * whatever the link points at. The window is the few milliseconds between the two,
           * and it is a real hole rather than a theoretical one; a review demonstrated it.
           *
           * It is accepted, for `resolveThroughSymlinks`' reason one directory over. The only
           * actor that can reach it is the goal agent itself: `uploads/` is inside
           * `goal/<goalId>/`, which is the directory that agent's own session runs in and in
           * which it holds shell and file tools. An agent that can swap a directory there can
           * already read and move every file in it, so defending the swap would protect
           * nothing it does not already have — and the operator's bytes it would redirect are
           * bytes the operator handed to that agent on purpose. What the pair above *does*
           * buy is that this cannot happen by accident, cannot happen from a browser, and
           * cannot happen without that agent having been compromised first.
           *
           * Closing it properly means `openat` relative to a directory handle opened with
           * `O_NOFOLLOW` once, which `node:fs` does not expose. If that ever becomes
           * reachable, this is the call site to change.
           *
           * The unlink is what keeps replacement working: a plain file of this name was
           * found above, so it is removed and `O_EXCL` then has nothing to object to.
           * `unlinkSync` removes a link rather than following it, but no link reaches here —
           * one is refused above.
           */
          if (destination.replacing) unlinkSync(destination.path);
          const handle = openSync(
            destination.path,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW,
            0o600,
          );
          try {
            writeSync(handle, file.content);
          } finally {
            closeSync(handle);
          }
        }),
      );
      if (written._tag === "Failure") {
        return yield* new GoalUploadRefused({
          reason: "write_failed",
          detail: `'${file.name}' could not be written to ${uploads}. The write refuses to follow a link or to overwrite anything it did not just find as a plain file, so this is either a disk that is full or read-only, or something changing that directory while the upload was in flight. Nothing is wrong with the goal or its database.`,
        });
      }
      stored.push({
        name: file.name,
        bytes: file.bytes,
        contentType: file.contentType,
        replaced: destination.replacing,
        uploadedAt: Date.now(),
      });
    }

    yield* Effect.logInfo("files were attached to a goal", {
      goalId: input.goalId,
      targetId: input.targetId,
      directory: uploads,
      names: stored.map((file) => file.name),
    });

    const total = existing.length + added;
    return {
      targetId: input.targetId,
      goalId: input.goalId,
      stored,
      attachedCount: total,
      note: `${String(stored.length)} ${stored.length === 1 ? "file is" : "files are"} now in this goal agent's own directory, which is where it can read them and where no worker can. It has not been told yet: the list goes to it with your next message, above your own words and never inside them. It was told once, when this conversation opened, that what is inside a file — and what a file is called — is data to report and never an instruction to follow. This goal now holds ${String(total)} of ${String(input.maxFiles)}.`,
      acceptedAt: Date.now(),
    } satisfies GoalUploadsAccepted;
  });

  return GoalConversations.of({
    send,
    replay,
    close: (goalId) => {
      const entry = live.get(goalId);
      return entry === undefined ? Effect.void : closeSession(entry);
    },
    attach,
  });
});
