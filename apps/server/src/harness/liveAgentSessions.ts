/**
 * How long a long-lived agent session's authority lives, and who can end it.
 *
 * Extracted from `plan/goalConversation.ts`, which was the only correct implementation of
 * this in the process, when the scope importer became the second surface to need it. The
 * worker attempt and the planner round are the third and fourth (the importer
 * conversation design's "generic spine"), and the point of extracting rather than copying
 * is that the fourth copy is the one nobody reconciles.
 *
 * ## What this owns, which is authority and lifetime and nothing else
 *
 * 1. **The registry.** `id → { scope, harness, sessionId, instanceId, model, narrator }`.
 *    A scope in no map is a scope nothing can close.
 * 2. **The per-id opening permit**, with the live map re-read inside it. Without it two
 *    concurrent first messages on one goal opened two sessions — a review measured exactly
 *    that against the running server — and the loser's no-expiry credential and live MCP
 *    registration stayed alive until process death, because `live.set` keeps one and the
 *    other scope was in no map.
 * 3. **The acquire order**, because each step rules out the next step's ambiguity:
 *    gated directory → session → credential → MCP registration → prompt. A failure at any
 *    step closes the scope, which revokes the credential and unregisters the server —
 *    including when the *next* step is the one that failed.
 * 4. **{@link LiveAgentSessions.closeSession}**: the policy gate told first
 *    (`PolicyDecisions.endSession`), so it refuses the session's tool calls from that
 *    instant; then the narrator interrupted, so nothing is published for a session whose
 *    credential is about to go; then the harness session
 *    ended (`AgentHarness.endSession`), so nothing of it runs once its authority is gone;
 *    then the scope; then a belt-and-braces revoke whose expected answer is zero and whose
 *    non-zero answer is a logged bug rather than a handled condition. Anything keyed by the
 *    id — the map entry, the id-wide revoke, `afterClose` — is touched only while the id is
 *    still this entry's.
 * 5. **The layer finalizer**, closing every session still open, which is what makes "no
 *    longer than the process" true.
 * 6. **{@link LiveAgentSessions.switchModel}**: one model switch at a time per id, under the
 *    opening permit, and the registry's copy of the model kept in step with the harness.
 *    The row is the surface's; the order — harness, then registry, then row — is here.
 * 7. **{@link LiveAgentSessions.interrupt}**: Stop. The turn ends and the session does not,
 *    so a conversation can be stopped and carried on; a harness that will not acknowledge
 *    the stop has the session closed rather than left holding authority nobody can steer.
 *
 * ## What it does not own
 *
 * What a session *means*. The role and its endpoint, the credential kind, the prompt
 * assemblers, the grouping rule, whether there is a settlement — those are the surface's,
 * passed in as a {@link LiveSessionRole} (fixed per surface) and an {@link OpenPlan} (per
 * open). A worker attempt is not a conversation, and an abstraction that owned both would
 * have to invent a settlement for a goal and a composer for a worker.
 *
 * ## One implementation, one registry per surface
 *
 * {@link makeLiveAgentSessions} is called once inside each surface's own layer and returns
 * that surface's registry. Not one process-wide `Context` service, for two reasons. The
 * finalizer belongs to the surface's layer scope, so a surface's sessions close when *its*
 * layer does, after its own in-flight fibers are interrupted (scope finalizers run in
 * reverse). And ids are only unique within a surface — a goal id and an import id share no
 * namespace — so a shared map would need keys nothing else uses.
 *
 * ## The `preambled` flag, and the ordering it relies on
 *
 * An entry is published into the map **before** its opening prompt is sent — it has to be,
 * because it owns the `Scope` holding the credential and the registration. So between
 * publish and acceptance there is a window in which a caller's outside-the-permit read finds
 * a live entry that has not been told what it is. {@link LiveAgentSessions.ready} only
 * returns an entry once `preambled` is true, and `preambled` is set by {@link open}
 * **after the prompt is accepted and before the permit is released** — so no interleaving
 * can observe a preambled entry that has not been preambled, and a reader that falls through
 * to the permit finds the entry either preambled or gone.
 */
import { bitMcpServerName, type ModelOptionSelection } from "@bit/contracts";
import {
  type Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Redacted,
  Scope,
  Semaphore,
} from "effect";

import {
  OPEN_PROMPT,
  SESSION_NOT_FOUND_TAG,
  type AgentHarness,
  type HarnessFailure,
  type SessionRef,
  type SteerUrgency,
} from "./agentHarness";
import type { HarnessNotReady } from "./resolver";
import type { CredentialRefused, IssuedCredential } from "../mcp/credentials";
import type { DatabaseError } from "../persistence/sql";
import type { PolicyDecisions } from "../policy/service";
import type {
  FleetError,
  FleetStore,
  UngatedRoleDirectory,
} from "../persistence/fleet";
import {
  gatedRoleDirectory,
  POLICY_AUDIT_FILE,
  type GatedDirectory,
  type PolicyHookNotInstalled,
} from "../policy/install";
import type { WorkerUrls } from "../run/supervisor";
import {
  storeUploads,
  type ReadUpload,
  type UploadWriteFailed,
} from "../upload/uploads";

/**
 * `AgentHarness.createSession`, narrowed so that the directory must be gated.
 *
 * `plan/planSupervisor.ts`'s `createPlannerSession` and for its reason: `GatedDirectory` is
 * a brand, `createSession` takes `directory: string`, and a brand that is never *asked for*
 * at a call site constrains nothing. This is the one call that opens a long-lived session,
 * so passing a path that has not been through `gatedRoleDirectory` is a compile error rather
 * than a convention.
 *
 * `multiTurn: true` is set here rather than by a caller, because it is not a choice a
 * caller could sensibly make differently: every session this registry holds is prompted
 * again after its first turn, and a session closed when it went idle could not take that.
 */
const createGatedSession = (
  harness: AgentHarness["Service"],
  input: {
    readonly title: string;
    readonly model: string;
    readonly directory: GatedDirectory;
    readonly sessionId: string;
    readonly options?: readonly ModelOptionSelection[] | undefined;
    /** An existing session to continue rather than create. See {@link OpenPlan.resume}. */
    readonly resume?: string | undefined;
  },
) =>
  harness.createSession({
    title: input.title,
    model: input.model,
    directory: input.directory,
    ...(input.options === undefined ? {} : { options: input.options }),
    // One or the other, never both: the seam says `sessionId` is ignored beside `resume`,
    // and the Claude Agent SDK refuses the pair for an id that already has turns. Said
    // here, once, so no surface has to remember it.
    ...(input.resume === undefined
      ? { sessionId: input.sessionId }
      : { resume: input.resume }),
    multiTurn: true,
  });

/** One session this process is holding, as the registry knows it. */
export interface LiveAgentSession<Meta> {
  /** The surface's own key: a goal id, an import id. */
  readonly id: string;
  readonly targetId: string;
  readonly sessionId: string;
  /**
   * What `createSession` answered for this opening, kept because it — not
   * {@link sessionId} — is what `AgentHarness.endSession` ends: a resume can open a newer
   * session under the same id, and ending by id would end that one.
   */
  readonly harnessSession: SessionRef;
  /**
   * The session's working directory, as the spine gated it: where the agent works, and
   * where the files a message carries are stored, under `uploads/` (A6 F9).
   */
  readonly directory: string;
  readonly instanceId: string;
  readonly model: string;
  readonly harness: AgentHarness["Service"];
  /** Owns the credential and the MCP registration. Closed by `closeSession`. */
  readonly scope: Scope.Closeable;
  /** Drains the session's narration, for a surface that has one. Interrupted first on close. */
  readonly narrator: Fiber.Fiber<void, never> | undefined;
  readonly openedAt: number;
  /** Whether the opening prompt has been accepted. See this module's header. */
  readonly preambled: boolean;
  /** What the surface keeps beside the session. Opaque here. */
  readonly meta: Meta;
}

/**
 * Why a session was closed, which is the whole list of things that close one.
 *
 * - `operator` — the surface's own intentional close: the operator ended it.
 * - `shutdown` — this registry's layer finalizer, on the way down.
 * - `refused` — the harness refused a prompt, so the session was given up on.
 * - `open_failed` — an open that published its entry and then never reached `ready`.
 *
 * Every close ends the session's authority period in this process — the credential and the
 * registration go either way. Only `operator` says the authority is *over*; the other three
 * are this process letting go. The spine passes the reason through to `afterClose` and
 * does nothing else with it; a surface that persists an ending is what gives it meaning.
 */
export type LiveSessionCloseReason =
  "operator" | "shutdown" | "refused" | "open_failed";

/** Everything opening a session can fail with, before the surface maps it to its own refusal. */
export type LiveSessionOpenFailure =
  | FleetError
  | DatabaseError
  | PolicyHookNotInstalled
  | HarnessFailure
  | HarnessNotReady
  | CredentialRefused
  | UploadWriteFailed;

/**
 * What a surface is, as far as authority goes. Fixed per surface.
 *
 * The credential pair is the one place a surface's *kind* is decided: `issue` mints the
 * grant the registration carries, and `revokeStray` is the belt-and-braces revoke for that
 * same kind, so a surface cannot issue one kind and check for another.
 */
export interface LiveSessionRole<Meta> {
  /** Which of the role endpoints this session's MCP registration points at. */
  readonly endpoint: (urls: WorkerUrls) => string;
  /** Mints the session's credential, in the session's own scope. */
  readonly issue: (input: {
    readonly id: string;
    readonly targetId: string;
  }) => Effect.Effect<IssuedCredential, CredentialRefused, Scope.Scope>;
  /** Revokes every grant of this surface's kind for one id, answering how many there were. */
  readonly revokeStray: (id: string) => Effect.Effect<number>;
  /**
   * Runs after a session is closed and its revoke checked, with why it was closed. Must
   * not fail. Not run for a stale close (see `closeSession`).
   */
  readonly afterClose?: (
    entry: LiveAgentSession<Meta>,
    reason: LiveSessionCloseReason,
  ) => Effect.Effect<void>;
  /** The log lines, in the surface's own words. */
  readonly words: {
    readonly unregisterRefused: string;
    readonly strayCredential: string;
    readonly closed: string;
    /** The annotation the surface's id is logged under: `goalId`, `importId`. */
    readonly idKey: string;
  };
}

/** What one open needs that the surface decides at the time. */
export interface OpenPlan<Meta> {
  readonly targetId: string;
  readonly harness: AgentHarness["Service"];
  readonly model: string;
  /**
   * `createSession`'s `options`: already resolved against {@link model}'s descriptors
   * (`harness/modelOptions.ts`), and absent — never `[]` — when the operator set nothing.
   */
  readonly options?: readonly ModelOptionSelection[] | undefined;
  readonly sessionId: string;
  /**
   * An existing session of this harness to **continue** instead of creating one (S6).
   *
   * The whole acquire order is unchanged — gated directory, session, credential,
   * registration, prompt — and that is the point: a resumed session gets a fresh credential
   * and a fresh registration in a scope this registry owns, so it is held and closed exactly
   * like one this process opened. What differs is only that step two creates nothing.
   *
   * **{@link ensureDirectory} must make the directory the harness itself resolves that
   * session in** (`AgentHarness.sessionContinuation`), not a new one. Both drivers need it:
   * OpenCode resolves a prompt through the session's stored directory and refuses a missing
   * one, and Claude Code finds a transcript under the project its `cwd` belongs to. More
   * importantly it is where the policy gate goes, so a resume into a directory the surface
   * did not gate would be an ungated agent — and the surface, not this module, is what can
   * tell whether the harness's path is one of ours.
   *
   * {@link sessionId} is ignored when this is set.
   */
  readonly resume?: string | undefined;
  readonly title: string;
  /** Makes the role directory. Gated by the spine and by no other code path. */
  readonly ensureDirectory: Effect.Effect<
    UngatedRoleDirectory,
    FleetError | DatabaseError
  >;
  /** The engagement folder, or `undefined` for a target with none — a statement, not an omission. */
  readonly workspace: string | undefined;
  /**
   * Runs once `createSession` has returned and before the credential is minted. Must not
   * fail: it is the importer's advisory index mark, and a surface with nothing to record
   * passes nothing.
   */
  readonly afterCreate?: (sessionId: string) => Effect.Effect<void>;
  /** Drains narration for a surface that publishes it. Forked into the session's scope. */
  readonly narrate?: (sessionId: string) => Effect.Effect<void>;
  /** Runs after publish and before the opening prompt. Must not fail. */
  readonly beforePrompt?: (
    entry: LiveAgentSession<Meta>,
  ) => Effect.Effect<void>;
  /** The opening prompt, built at the moment it is sent rather than when the plan was. */
  readonly openingPrompt: (entry: LiveAgentSession<Meta>) => string;
  /**
   * The files the opening message carried, read and checked (A6 F9). Stored in the
   * session's directory once it is gated, before anything is prompted, and handed to the
   * harness with the opening prompt. A failure to store them fails the open, so a session
   * is never prompted without the files its message named.
   */
  readonly uploads?: readonly ReadUpload[] | undefined;
  readonly meta: Meta;
}

/**
 * What a surface has decided a model switch is, once it has read its row and checked the
 * request. Built inside {@link LiveAgentSessions.switchModel}'s claim and permit, so nothing
 * it read can change under it.
 */
export interface ModelSwitchPlan<Meta, E, R> {
  /**
   * The conversation's pinned harness instance, which the model was checked against. A
   * live entry on any other instance is not switched: see {@link ModelSwitchStale}.
   */
  readonly instanceId: string;
  /** A name in that instance's catalogue: a malformed id throws in OpenCode's decoder. */
  readonly model: string;
  /** Already resolved against {@link model}'s descriptors; absent for nothing chosen. */
  readonly options: readonly ModelOptionSelection[] | undefined;
  /** The entry's meta once it is on {@link model}: the goal path's provenance, say. */
  readonly meta: (meta: Meta) => Meta;
  /**
   * The row write. **A plain write and nothing else**: it runs after the harness has
   * answered, never around it, so no transaction is held across a harness call. A surface
   * whose row already says this passes a no-op.
   */
  readonly record: (
    entry: LiveAgentSession<Meta> | undefined,
  ) => Effect.Effect<void, E, R>;
}

/** A second switch of one id while the first has not answered. Refused, never queued. */
export interface ModelSwitchInFlight {
  readonly _tag: "ModelSwitchInFlight";
}

/**
 * The harness was asked and did not clearly answer, so the session's model is uncertain.
 * The row is left as it was; asking again settles it, because a switch is idempotent.
 */
export interface ModelSwitchUncertain {
  readonly _tag: "ModelSwitchUncertain";
  readonly failure: HarnessFailure;
}

/**
 * The live entry is on another harness instance than the one the plan checked the model
 * against. Unreachable while a surface reads its row inside the permit — the row and the
 * entry are written by the same open — and refused rather than sent, because a model from
 * one catalogue is not a valid id on another.
 */
export interface ModelSwitchStale {
  readonly _tag: "ModelSwitchStale";
  readonly liveInstanceId: string;
}

export type ModelSwitchFailure =
  ModelSwitchInFlight | ModelSwitchUncertain | ModelSwitchStale;

/**
 * Where a switch took effect: `live`, the harness took it; `recorded`, there was no live
 * session to tell — this process holds none, or the harness no longer has it — so only the
 * row changed, and the next resume opens on it.
 */
export type ModelSwitchApplied = "live" | "recorded";

/**
 * Whether a harness's refusal of a switch means "that session is not running here".
 *
 * Claude Code says so with {@link SESSION_NOT_FOUND_TAG} (and 404) for a query that is gone
 * or going; OpenCode's `session.switchModel` 404 carries no tag, so the status is the test,
 * as every other not-found reader on the seam already does.
 */
const switchFoundNoSession = (failure: HarnessFailure): boolean =>
  failure._tag === "HarnessTransportError" &&
  (failure.tag === SESSION_NOT_FOUND_TAG || failure.status === 404);

/**
 * What {@link LiveAgentSessions.interrupt} found.
 *
 * - `not_live` — no session is held under the id, so nothing of it runs in this process.
 * - `idle` — a session is held and the harness said nothing was running in it.
 * - `interrupted` — the harness stopped a running turn. `working` is whether the session
 *   was still busy once {@link INTERRUPT_SETTLE} had passed. `followUp` is whether a message
 *   had been delivered behind the stopped turn — sent while the conversation was busy, and
 *   the conversation not idle since — which is the message a harness then either runs at
 *   once or holds (`AgentHarness.queuedOnInterrupt`).
 * - `background` — no turn was running, but work the agent started in the background was,
 *   and the harness was asked to stop it (`AgentHarness.interruptSession`). `working` is
 *   whether the harness still reports some of it running afterwards.
 */
export type LiveInterrupt<Meta> =
  | { readonly _tag: "not_live" }
  | { readonly _tag: "idle"; readonly entry: LiveAgentSession<Meta> }
  | {
      readonly _tag: "interrupted";
      readonly entry: LiveAgentSession<Meta>;
      readonly working: boolean;
      readonly followUp: boolean;
      /**
       * Whether background work still runs after the Stop (A6 U6 review): the harness
       * stops it with the turn, and says so through its status, read after the settle.
       * `true` when that status could not be read.
       */
      readonly background: boolean;
    }
  | {
      readonly _tag: "background";
      readonly entry: LiveAgentSession<Meta>;
      readonly working: boolean;
    };

/**
 * What {@link LiveAgentSessions.status} found (A6 U6).
 *
 * - `not_live` — no session is held under the id, so nothing of it runs in this process.
 * - `live` — a session is held. `running` is whether a turn is in flight: a prompt this
 *   registry delivered and the harness has not yet gone idle after, **or** the harness saying
 *   a turn is running — which is also true of a turn the harness opened by itself (Claude
 *   Code's turn on a background task's notification), which no prompt of this registry's
 *   started. `background` is whether work the agent started in the background is still
 *   running outside any turn (`SessionStatus.background`). `uncertain` is set when the
 *   harness could not be asked, and then `running` is this registry's own account alone and
 *   `background` is `false`.
 */
export type LiveStatus =
  | { readonly _tag: "not_live" }
  | {
      readonly _tag: "live";
      readonly running: boolean;
      readonly background: boolean;
      readonly uncertain: boolean;
    };

/**
 * How long {@link LiveAgentSessions.status} waits for the harness's `sessionStatus`. A
 * screen polls it about once a second, so an answer slower than this is reported as
 * uncertain rather than queued behind.
 */
export const STATUS_ASK: Duration.Input = "3 seconds";

/**
 * What the spine knows about one session's turns, for a Stop's answer and nothing else.
 *
 * `busy` is set when a prompt is accepted and cleared when the harness next says the session
 * is idle; `followUps` counts the messages delivered while it was busy. `epoch` moves on every
 * delivery, so an idle that a watcher saw *before* a later message landed does not clear that
 * message's turn. `watching` keeps it to one `waitForIdle` per session at a time.
 */
interface TurnState {
  busy: boolean;
  followUps: number;
  epoch: number;
  watching: boolean;
}

/**
 * How long an interrupted turn is given to go idle before a Stop is answered.
 *
 * Measured at ~10 ms (Claude Code, the `result` after the acknowledgement) and ~50 ms
 * (OpenCode, `idle` after `session.interrupt`) on the interrupt probe, so two seconds is
 * generous for the turn that was stopped and short of any turn that runs after it — which
 * is the case `working: true` reports.
 */
export const INTERRUPT_SETTLE: Duration.Input = "2 seconds";

/**
 * How many sessions the layer finalizer closes at once. Enough that a shutdown against a
 * harness that has stopped answering costs one control timeout for a realistic number of
 * open conversations rather than one each; bounded so a long list is not a burst of
 * requests at a harness that is already struggling.
 */
export const SHUTDOWN_CLOSE_CONCURRENCY = 8;

export interface LiveAgentSessions<Meta> {
  /** The entry for one id, preambled or not. For reads that only need the session id. */
  readonly get: (id: string) => LiveAgentSession<Meta> | undefined;
  /**
   * The entry for one id **only if it has had its opening prompt**: the outside-the-permit
   * fast path. An unpreambled entry reads as absent, so its caller falls through to
   * {@link open}, whose permit the opener holds until the prompt is accepted.
   */
  readonly ready: (id: string) => LiveAgentSession<Meta> | undefined;
  /**
   * Opens a session for one id under that id's permit, or joins the one already there.
   *
   * Inside the permit the live map is read again first: a caller that waited while another
   * opened the session goes to `joined` with the winner's entry rather than building a
   * second. Otherwise `prepare` runs (the surface's own checks and harness choice, still
   * inside the permit), then the acquire order, publish, `beforePrompt`, the opening prompt,
   * and only then `preambled` — and `opened` runs last, still holding the permit.
   *
   * An acquire failure closes the scope before the entry was ever published; a prompt the
   * harness refuses closes the published session. Either is mapped through `refuse`.
   */
  readonly open: <A, E, R>(input: {
    readonly id: string;
    readonly joined: (entry: LiveAgentSession<Meta>) => Effect.Effect<A, E, R>;
    readonly prepare: Effect.Effect<OpenPlan<Meta>, E, R>;
    readonly refuse: (failure: LiveSessionOpenFailure) => E;
    readonly opened: (entry: LiveAgentSession<Meta>) => Effect.Effect<A, E, R>;
  }) => Effect.Effect<A, E, R>;
  /**
   * Gives up on one session: narration first, then its scope, then the belt-and-braces
   * revoke. See this module's header for why the order matters and why a non-zero revoke
   * is logged as a bug.
   *
   * Safe to call with a stale entry: if the map no longer holds this exact entry, only the
   * entry's own narrator and scope are closed, and nothing keyed by its id is touched.
   */
  readonly closeSession: (
    entry: LiveAgentSession<Meta>,
    reason: LiveSessionCloseReason,
  ) => Effect.Effect<void>;
  /**
   * Gives one later message to a session that has had its opening prompt.
   *
   * **A `steer`, at the urgency the operator asked for** (DECISIONS.md §24.1). `queued` is
   * every surface's default: the work in flight finishes, then the message runs.
   * `preemptive` is "send now", and only ever an explicit choice — it cuts off whatever the
   * agent was in the middle of, and an operator who merely sent a second message has not
   * asked for that. The urgency is passed straight through; the spine owns what each one
   * means on the harness (see the V2 notes at the implementation), so two
   * conversations cannot drift apart on delivery timing.
   *
   * **A refusal closes the session, as `refused`**, which is the third item on the list of
   * things that close one: the session has been prompted-and-failed, this seam never
   * resubmits, and on Claude Code a refusal includes a query that has already closed. So
   * the *next* message opens a fresh session rather than failing the same way forever.
   * Closing is the spine's because it is lifetime; what the next message opens, and under
   * which id, is the surface's.
   *
   * **The message id is minted, not derived.** A derived id needs an operation identity to
   * derive from, and an operator message has none: the draft carries the operator's words
   * and nothing else, and deriving from the text would silently swallow a legitimately
   * repeated sentence. So a double-submitted "yes" is two messages, because that is what was
   * sent twice.
   *
   * The prompt is the surface's, already assembled: what a follow-up carries is what the
   * session *means*, which this module does not own.
   */
  readonly deliver: (
    entry: LiveAgentSession<Meta>,
    prompt: string,
    urgency: SteerUrgency,
    /**
     * The files this message carried, read and checked (A6 F9). Stored in the entry's
     * directory first; a failure to store them is {@link UploadWriteFailed}, nothing is
     * prompted, and — unlike a refused prompt — **the session is kept**, since the harness
     * was never asked.
     */
    uploads?: readonly ReadUpload[],
  ) => Effect.Effect<
    {
      /**
       * The id the steer was delivered under: what a `taken` narration names when the
       * harness takes it off its queue (A6 U4).
       */
      readonly messageId: string;
    },
    HarnessFailure | UploadWriteFailed
  >;
  /**
   * Stops the turn running in one id's session, and keeps the session (A6 F5).
   *
   * The harness's `interruptSession` and nothing more: the entry stays in the map, its
   * scope, credential and registration stay live, and the next {@link deliver} continues
   * the same session — both harnesses keep a multi-turn session promptable after an
   * interrupt (measured; `AgentHarness.interruptSession`). A session still being opened is
   * waited for under the opening permit, so its opening turn is the one stopped.
   *
   * An interrupted turn is then given {@link INTERRUPT_SETTLE} to go idle, which it does in
   * tens of milliseconds on both harnesses. `working: true` means it did not; whether that
   * is a message delivered behind the stopped turn (which Claude Code runs at once) or the
   * turn still finishing is `followUp`, which this registry tracks rather than infers.
   *
   * **A harness that will not acknowledge the interrupt has the session closed, as
   * `refused`**, and the failure returned. Whether its turn stopped is uncertain, and a
   * session this process cannot steer is one whose authority should not outlive the doubt —
   * the run and round supervisors revoke on the same uncertainty. The next message then
   * carries the conversation on in a session this process holds again.
   */
  readonly interrupt: (
    id: string,
  ) => Effect.Effect<LiveInterrupt<Meta>, HarnessFailure>;
  /**
   * What one id's session is doing now (A6 U6): whether a turn is running and whether
   * background work is, for a screen deciding whether to offer Stop. A read, and it never
   * fails: a harness that cannot answer is {@link LiveStatus} `uncertain`. A session still
   * being opened is running — its opening turn is about to be.
   */
  readonly status: (id: string) => Effect.Effect<LiveStatus>;
  /** {@link closeSession} by id. Idempotent, and safe for an id with nothing live. */
  readonly close: (
    id: string,
    reason: LiveSessionCloseReason,
  ) => Effect.Effect<void>;
  /**
   * Moves one id's session onto another model of its harness, and keeps the registry's copy
   * of the model in step (A6 F4).
   *
   * **One switch at a time per id, refused rather than queued.** A second switch while one
   * is in flight fails with {@link ModelSwitchInFlight} at once. Two concurrent OpenCode
   * switches are two HTTP calls that can reach the server in one order and complete in the
   * other, so a row written on each completion could disagree with the server; and a
   * Claude Code switch waits on a control response with no bound of its own beyond the
   * control timeout, so a queue behind a hung CLI would time out one entry after another.
   *
   * **Under the id's opening permit**, so a switch never interleaves with an open: an open
   * reads the row's model and writes the row, and a switch that landed between the two
   * would be overwritten by an open that never saw it. A switch that arrives while an open
   * is in flight waits for it, and then finds the session live. Delivery does not take the
   * permit, so messages to a live session are not held up by a switch.
   *
   * Inside both, in order:
   *
   * 1. `prepare` — the surface reads its row and checks the request. It may refuse.
   * 2. Live entry: the harness's `switchModel`. Accepted — the registry's copy is updated
   *    (if the map still holds this entry), then the row is written: `live`. A refusal that
   *    means "no such running session" ({@link switchFoundNoSession}) — the row only:
   *    `recorded`, and the next resume opens on it. Anything else — the row is not written
   *    and the failure is {@link ModelSwitchUncertain}.
   * 3. No live entry: the row only, `recorded`.
   *
   * The registry is updated before the row is written because it mirrors the harness, which
   * has already moved: a row write that then fails leaves the record behind and says so,
   * and asking again — a no-op on the harness — writes it.
   */
  readonly switchModel: <E, R>(input: {
    readonly id: string;
    readonly prepare: Effect.Effect<ModelSwitchPlan<Meta, E, R>, E, R>;
  }) => Effect.Effect<ModelSwitchApplied, E | ModelSwitchFailure, R>;
}

/**
 * Builds one surface's registry, and registers the finalizer that closes it with the
 * calling layer's scope.
 */
export const makeLiveAgentSessions = <Meta>(
  deps: {
    readonly fleet: FleetStore["Service"];
    readonly endpoints: { readonly urls: Effect.Effect<WorkerUrls> };
    /**
     * The policy gate's record of which sessions are held and which have ended
     * (`PolicyDecisions.holdSession`): every session this registry opens is held from the
     * moment it exists and ended the moment it is closed, so the gate refuses its tool
     * calls whatever its harness is still doing.
     */
    readonly gate: Pick<
      PolicyDecisions["Service"],
      "holdSession" | "endSession"
    >;
  },
  role: LiveSessionRole<Meta>,
): Effect.Effect<LiveAgentSessions<Meta>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { fleet, endpoints, gate } = deps;

    /**
     * One entry per id this process is holding a session for.
     *
     * Not a `FiberMap`, unlike the supervisors', and the difference is the point: there is no
     * supervising fiber here. A session is a harness session plus a credential plus maybe a
     * narration drain, and the thing that owns its lifetime is a `Scope` — so what this map
     * holds is the scope and the handle, and closing is closing a scope rather than
     * interrupting work.
     */
    const live = new Map<string, LiveAgentSession<Meta>>();

    /**
     * One permit per id, held while a session is being opened for it.
     *
     * It covers the whole of "decide there is nothing, then build it", with the check
     * re-read inside the permit — the same shape of claim `claimedGoals` in
     * `plan/planSupervisor.ts` and the workspace claim in `run/supervisor.ts` take. One entry
     * per id ever opened, bounded by what an operator has opened, and not swept for the same
     * reason `claimedGoals` is not.
     */
    const opening = new Map<string, Semaphore.Semaphore>();
    const openingLock = (id: string): Semaphore.Semaphore => {
      const held = opening.get(id);
      if (held !== undefined) return held;
      const made = Semaphore.makeUnsafe(1);
      opening.set(id, made);
      return made;
    };

    const annotate = (entry: LiveAgentSession<Meta>) => ({
      [role.words.idKey]: entry.id,
      targetId: entry.targetId,
      sessionId: entry.sessionId,
    });

    /**
     * How many times an open has started building for each id.
     *
     * Read by {@link closeSession} and nothing else, to tell whether a newer session for the
     * same id began acquiring while this close was suspended — see there.
     */
    const builds = new Map<string, number>();

    /*
     * **Only the entry the map still holds is the id's to close.** A close can be stale: two
     * messages took the fast path into one session and both prompts failed; the first failure
     * closed it, a third message opened a fresh session under the same id, and the second
     * failure then arrives holding the *old* entry. Deleting by id there would drop the new
     * session from the map — its scope then in no map, its registration and narrator alive
     * until process death — and the belt-and-braces revoke, which works by id, would kill the
     * new session's credential and log it as a stray. So the map and the id-wide revoke are
     * touched only when the map still holds this exact entry, compared by its `Scope` (the
     * preambled replacement is a different object over the same scope). The entry's own
     * narrator and scope are closed either way: they are this entry's, and must go.
     *
     * The check is made before the first suspension, so nothing can interleave between
     * reading the map and deleting from it.
     *
     * **The same revoke can also hit a session that is not yet in any map.** Once this close
     * has deleted the entry, a message that arrives while the scope is still closing (an
     * unregister is a round trip to the harness) finds nothing live, takes the permit, and
     * mints a credential for the same id. So the revoke runs only if no open has started
     * building for this id since the close began; if one has, the revoke is skipped, which
     * gives up the bug detector for that one close rather than revoking a credential this
     * close does not own.
     */
    const closeSession = Effect.fnUntraced(function* (
      entry: LiveAgentSession<Meta>,
      reason: LiveSessionCloseReason,
    ) {
      const current = live.get(entry.id)?.scope === entry.scope;
      if (current) live.delete(entry.id);
      const buildsAtClose = builds.get(entry.id) ?? 0;
      // The gate first, before anything suspends: from here every tool call of this opening
      // is refused, whatever the harness does in the time it takes to stop it.
      yield* gate.endSession(entry.sessionId, entry.scope);
      if (entry.narrator !== undefined) yield* Fiber.interrupt(entry.narrator);
      /*
       * The harness session is ended **before** the scope is closed, so the agent has stopped
       * before its registration and credential go, rather than running on for however long
       * an unregister round trip takes. The scope's own release (see `acquire`) would end it
       * too, last; this one is first, and the guard makes the second a no-op.
       *
       * By the opening's own ref, so a stale entry whose id a resumed open now holds ends
       * its own session and not the newer one: the harness tells them apart
       * (`AgentHarness.endSession`), which this registry cannot — a resumed open is not in
       * the map until it publishes.
       */
      yield* endHarnessSession(
        entry.harness,
        entry.harnessSession,
        entry.scope,
        {
          [role.words.idKey]: entry.id,
        },
      );
      yield* Scope.close(entry.scope, Exit.void);
      if (!current) {
        yield* Effect.logDebug(
          "a stale close found a newer session, or none, under the same id; only its own scope was closed",
          annotate(entry),
        );
        return;
      }
      if ((builds.get(entry.id) ?? 0) === buildsAtClose) {
        const stray = yield* role.revokeStray(entry.id);
        if (stray > 0) {
          yield* Effect.logError(role.words.strayCredential, {
            [role.words.idKey]: entry.id,
            sessionId: entry.sessionId,
            revoked: stray,
          });
        }
      } else {
        yield* Effect.logInfo(
          "a newer session for the same id began opening while this one was closing, so the belt-and-braces revoke was skipped rather than run against its credential",
          annotate(entry),
        );
      }
      if (role.afterClose !== undefined) yield* role.afterClose(entry, reason);
      yield* Effect.logInfo(role.words.closed, annotate(entry));
    });

    /**
     * The scopes whose harness session has been ended, so that ending is done once.
     *
     * Both `closeSession` and the scope's own release (registered in `acquire`) end it, and
     * the first one wins: `closeSession` for every published entry, so the agent stops before
     * its authority goes; the release for an open that built a session and never published
     * it — an acquire step that failed after `createSession`, or an opener interrupted or
     * killed while `building`.
     */
    const ended = new WeakSet<Scope.Closeable>();

    /**
     * Ends one harness session (`AgentHarness.endSession`), once per scope, and logs a
     * failure rather than raising it: a close cannot fail, and its authority goes either way.
     * A harness that could not be reached leaves an agent whose state is uncertain, which is
     * worth a warning and not worth keeping the credential alive for.
     */
    const endHarnessSession = (
      harness: AgentHarness["Service"],
      session: SessionRef,
      scope: Scope.Closeable,
      annotations: Record<string, string>,
    ): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (ended.has(scope)) return Effect.void;
        ended.add(scope);
        const sessionId = session.id;
        return gate
          .endSession(sessionId, scope)
          .pipe(Effect.andThen(harness.endSession(session)), Effect.asVoid)
          .pipe(
            Effect.catch((failure) =>
              Effect.logWarning(
                "the harness could not be reached to end a closed session, so whether it is still running is uncertain; its credential is revoked either way",
                { ...annotations, sessionId, detail: failure.message },
              ),
            ),
          );
      });

    /** Per session, by its scope, which every copy of an entry shares. */
    const turns = new WeakMap<Scope.Closeable, TurnState>();
    const turnsOf = (scope: Scope.Closeable): TurnState => {
      const held = turns.get(scope);
      if (held !== undefined) return held;
      const made: TurnState = {
        busy: false,
        followUps: 0,
        epoch: 0,
        watching: false,
      };
      turns.set(scope, made);
      return made;
    };

    /**
     * Records that a prompt was accepted into one session, and watches for it going idle.
     *
     * The watcher waits for idle and clears the state only if nothing was delivered while it
     * waited; otherwise it waits again, for the later message's turn. Forked into the
     * session's scope, so a close interrupts it. A wait that fails is read as idle: the
     * state only words a Stop, and "still finishing" is the safer thing to say than a
     * message that may not exist.
     */
    const promptAccepted = (entry: LiveAgentSession<Meta>) =>
      Effect.gen(function* () {
        const state = turnsOf(entry.scope);
        if (state.busy) state.followUps += 1;
        state.busy = true;
        state.epoch += 1;
        if (state.watching) return;
        state.watching = true;
        yield* Effect.forkIn(
          Effect.gen(function* () {
            for (;;) {
              const epoch = state.epoch;
              yield* Effect.result(entry.harness.waitForIdle(entry.sessionId));
              if (state.epoch === epoch) {
                state.busy = false;
                state.followUps = 0;
                state.watching = false;
                return;
              }
            }
          }),
          entry.scope,
        );
      });

    // Owned by the calling layer's scope, so a `SIGINT` closes every session rather than
    // dropping it with a live credential behind it.
    // Concurrently, and bounded: each close waits on its harness's `endSession`, which is
    // bounded by the control timeout, and a shutdown against a harness that has stopped
    // answering would otherwise wait for that timeout once per session (A6 F5 review).
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        [...live.values()],
        (entry) => closeSession(entry, "shutdown"),
        { concurrency: SHUTDOWN_CLOSE_CONCURRENCY, discard: true },
      ),
    );

    /**
     * The acquire order, inside the session's own scope, and nothing published yet.
     *
     * **1. The directory, through `gatedRoleDirectory` and no other way.** The gate goes in a
     * directory where the agent is not expected to run a shell command, which is the point:
     * the gate is what turns that expectation into a fact. Under OpenCode the directory is
     * also the authority boundary (DECISIONS.md §24.2) — the only session in it is this one,
     * which is what makes a credential with no expiry containable.
     *
     * **2. The session, `multiTurn`** — or, with {@link OpenPlan.resume}, the session the
     * harness already has, named rather than created. `multiTurn` is set here rather than by
     * the plan, because a session this registry holds is by definition one that outlives a
     * turn; a session closed when it went idle could not take the second message.
     *
     * **3. The credential, then the registration**, both in the session's scope, so both go
     * when {@link closeSession} closes it.
     *
     * The session itself is released with the scope too (`AgentHarness.endSession`), which
     * is what ends a session an open built and never published. A published one is ended
     * earlier, by {@link closeSession}; see {@link ended}.
     */
    const acquire = (
      plan: OpenPlan<Meta>,
      urls: WorkerUrls,
      id: string,
      scope: Scope.Closeable,
    ) =>
      Effect.gen(function* () {
        const harness = plan.harness;
        const directory: GatedDirectory = yield* gatedRoleDirectory({
          ensure: plan.ensureDirectory,
          install: harness.installGate,
          policyUrl: urls.policy,
          // Outside the role directory: the gate's own record must not be somewhere the
          // gated agent can read or rewrite. `gatedRoleDirectory` refuses the nesting.
          auditPath: `${fleet.paths.evidenceDirectory(plan.targetId)}/${POLICY_AUDIT_FILE}`,
          workspace: plan.workspace,
        });
        const created = yield* Effect.acquireRelease(
          createGatedSession(harness, {
            title: plan.title,
            model: plan.model,
            directory,
            sessionId: plan.sessionId,
            ...(plan.options === undefined ? {} : { options: plan.options }),
            ...(plan.resume === undefined ? {} : { resume: plan.resume }),
          }).pipe(
            // Held from the moment it exists, so the gate allows it — including when an
            // older opening of the same id ends while this one is still being built.
            Effect.tap((made) => gate.holdSession(made.id, scope)),
          ),
          (made) =>
            endHarnessSession(harness, made, scope, {
              [role.words.idKey]: id,
            }),
        );
        if (plan.afterCreate !== undefined) yield* plan.afterCreate(created.id);
        return { created, directory };
      });

    const register = (
      plan: OpenPlan<Meta>,
      id: string,
      urls: WorkerUrls,
      created: { readonly id: string },
      directory: GatedDirectory,
    ) =>
      Effect.gen(function* () {
        const harness = plan.harness;
        const credential = yield* role.issue({ id, targetId: plan.targetId });
        const serverName = bitMcpServerName(id);
        yield* Effect.acquireRelease(
          harness.registerMcpServer(created.id, serverName, {
            // The role's endpoint. This line decides which tool list the session is
            // offered: `mcp/server.ts` serves one toolkit per path, and each endpoint's
            // middleware refuses a grant whose tag is not the role it serves — so "which
            // tools" is a property of the registration rather than of a filter.
            url: role.endpoint(urls),
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
                Effect.logWarning(role.words.unregisterRefused, {
                  [role.words.idKey]: id,
                  server: serverName,
                  detail: failure.message,
                }),
              ),
            ),
        );
      });

    const ready: LiveAgentSessions<Meta>["ready"] = (id) => {
      const entry = live.get(id);
      return entry !== undefined && entry.preambled ? entry : undefined;
    };

    const open: LiveAgentSessions<Meta>["open"] = (input) =>
      Semaphore.withPermit(openingLock(input.id))(
        Effect.gen(function* () {
          // The winner's session, if one was built while this caller waited. No `preambled`
          // check, and its absence is not an oversight: the opener holds this permit across
          // the prompt, so an entry reachable from in here is preambled or already gone.
          const raced = live.get(input.id);
          if (raced !== undefined) return yield* input.joined(raced);

          const plan = yield* input.prepare;
          /*
           * Counted once `prepare` has said this open will build, and before anything is
           * acquired, so a close already in flight for this id sees it. Not before `prepare`:
           * a surface may come in here only to join, with a `prepare` that refuses rather than
           * builds — the importer does, because nothing is ever built under an import id that
           * has been opened before — and counting that would make a concurrent close skip its
           * belt-and-braces revoke for a build that never happened. `prepare` acquires
           * nothing by contract (the surface's checks and its harness choice), so nothing it
           * does can be what the revoke would wrongly hit.
           */
          builds.set(input.id, (builds.get(input.id) ?? 0) + 1);
          const urls = yield* endpoints.urls;
          const harness = plan.harness;

          /*
           * The session's own scope, which outlives the caller.
           *
           * `Scope.make` rather than the caller's scope, because the caller is an HTTP handler
           * about to answer or a fiber about to finish its first turn: a credential acquired
           * in either would be revoked the moment the caller moved on. Made under
           * `uninterruptibleMask`, so there is no instant at which it exists and the
           * exit handler below does not cover it.
           *
           * How far this open got, for the exit handler below and nothing else.
           *
           * An opener can end without reaching `ready` in two ways the typed-failure paths
           * do not see. It can be **interrupted** — an HTTP handler whose client went away,
           * an importer's first-turn fiber the operator stopped. Or it can **die** — a
           * harness, a surface callback or a prompt assembler throwing — and a defect passes
           * through `Effect.result` exactly as an interrupt does. Either way: ended while
           * `building`, the scope is in no map and nothing else could ever close it; ended
           * while `published`, the entry is in the map unpreambled, the permit is released,
           * and the next caller *inside* the permit — which does not check the flag — would
           * deliver into a session that was never framed. So the handler acts on every exit
           * that is not a success, which keeps "an entry reachable inside the permit is
           * preambled or gone" true on every path. The typed-failure paths close what they
           * built themselves and then say so by moving to `closed`, so nothing is closed
           * twice.
           */
          let stage:
            | { readonly _tag: "building" }
            | {
                readonly _tag: "published";
                readonly entry: LiveAgentSession<Meta>;
              }
            | { readonly _tag: "closed" }
            | { readonly _tag: "ready" } = { _tag: "building" };

          const preambledEntry = yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const scope = yield* Scope.make();
              return yield* restore(
                Effect.gen(function* () {
                  const opened = yield* Effect.result(
                    Effect.gen(function* () {
                      const { created, directory } = yield* acquire(
                        plan,
                        urls,
                        input.id,
                        scope,
                      );
                      yield* register(plan, input.id, urls, created, directory);
                      // The opening message's files, into the directory now gated (A6 F9).
                      const attachments =
                        plan.uploads === undefined || plan.uploads.length === 0
                          ? []
                          : yield* storeUploads(directory, plan.uploads);
                      return { created, directory, attachments };
                    }).pipe(Scope.provide(scope)),
                  );
                  if (opened._tag === "Failure") {
                    // Nothing was registered or the session could not be made: close
                    // the scope rather than leave a credential behind a session that
                    // does not exist.
                    yield* Scope.close(scope, Exit.void);
                    stage = { _tag: "closed" };
                    return yield* Effect.fail(input.refuse(opened.failure));
                  }

                  const narrate = plan.narrate;
                  const narrator =
                    narrate === undefined
                      ? undefined
                      : yield* Effect.forkIn(
                          narrate(opened.success.created.id),
                          scope,
                        );
                  const entry: LiveAgentSession<Meta> = {
                    id: input.id,
                    targetId: plan.targetId,
                    sessionId: opened.success.created.id,
                    harnessSession: opened.success.created,
                    directory: opened.success.directory,
                    instanceId: harness.instance.instanceId,
                    model: plan.model,
                    harness,
                    scope,
                    narrator,
                    openedAt: Date.now(),
                    // Nothing has been said to this session yet. Published anyway — a
                    // scope in no map is a scope nothing can close — so what keeps a
                    // message out of it until the opening prompt has landed is this
                    // flag rather than the absence of an entry.
                    preambled: false,
                    meta: plan.meta,
                  };
                  live.set(input.id, entry);
                  stage = { _tag: "published", entry };

                  if (plan.beforePrompt !== undefined)
                    yield* plan.beforePrompt(entry);

                  const prompted = yield* Effect.result(
                    harness.prompt(
                      entry.sessionId,
                      plan.openingPrompt(entry),
                      OPEN_PROMPT,
                      opened.success.attachments,
                    ),
                  );
                  if (prompted._tag === "Failure") {
                    // Nothing ran, and the session is useless: it has been
                    // prompted-and-failed, and this seam never resubmits a prompt. Closed
                    // so the next open builds a fresh one.
                    yield* closeSession(entry, "refused");
                    stage = { _tag: "closed" };
                    return yield* Effect.fail(input.refuse(prompted.failure));
                  }
                  /*
                   * The opening prompt has landed, so the session may be reached from
                   * outside the permit. Set here and nowhere else — after acceptance and
                   * before the permit is released. A replacement entry rather than a
                   * mutation, because the entry is readonly; the `Scope` and the narrator
                   * are the same objects, so `closeSession` closes the same things either
                   * way.
                   */
                  const preambledEntry: LiveAgentSession<Meta> = {
                    ...entry,
                    preambled: true,
                  };
                  live.set(input.id, preambledEntry);
                  stage = { _tag: "ready" };
                  yield* promptAccepted(preambledEntry);
                  return preambledEntry;
                }),
              ).pipe(
                // Every exit, not only an interrupt: see `stage` above for why a defect
                // needs exactly what an interrupt does.
                Effect.onExit((exit) => {
                  if (Exit.isSuccess(exit)) return Effect.void;
                  const reached = stage;
                  return reached._tag === "building"
                    ? Scope.close(scope, Exit.void)
                    : reached._tag === "published"
                      ? closeSession(reached.entry, "open_failed")
                      : Effect.void;
                }),
              );
            }),
          );
          return yield* input.opened(preambledEntry);
        }),
      );

    /*
     * V2(chat): follow-ups are queued *in the harness*, not here. Each one goes straight to
     * the session as a `queued` steer (OpenCode `delivery: "queue"`, Claude Code
     * `priority: "later"`), so once sent it cannot be edited, cancelled or reordered; a
     * Claude Code message queued but not yet run lives in the CLI's input stream and is lost
     * if bit restarts (OpenCode keeps its queue in its own database). And a Stop treats it
     * differently on each harness (measured 2026-11-04, `AgentHarness.interruptSession`):
     * Claude Code runs a message queued behind the interrupted turn at once, as a turn of its
     * own, so the conversation answers it straight after the Stop; OpenCode holds it in the
     * session's inbox, out of the transcript, and runs it ahead of the operator's next
     * message in the same execution. Proper V2: an app-owned queue (T3's model) that the
     * operator can edit, cancel and reorder, that survives a restart, that a Stop holds back
     * on both harnesses alike, and from which a message can be promoted to an immediate steer.
     */
    const deliver: LiveAgentSessions<Meta>["deliver"] = (
      entry,
      prompt,
      urgency,
      uploads,
    ) =>
      Effect.gen(function* () {
        // Stored before the harness is asked, and a failure here closes nothing.
        const attachments =
          uploads === undefined || uploads.length === 0
            ? []
            : yield* storeUploads(entry.directory, uploads);
        const messageId = crypto.randomUUID().replaceAll("-", "");
        const accepted = yield* Effect.result(
          entry.harness.prompt(
            entry.sessionId,
            prompt,
            {
              _tag: "steer",
              /*
               * V2(chat): "send now" is a preemptive steer — it lands at the harness's next
               * step boundary, so a tool call already running finishes first and the rest of
               * the work in flight is discarded. Proper V2: a combined "stop and send" that
               * interrupts the turn and then opens the next one, once interrupt-with-queued-
               * messages behaviour is measured.
               */
              urgency,
              messageId,
            },
            attachments,
          ),
        );
        if (accepted._tag === "Failure") {
          yield* closeSession(entry, "refused");
          return yield* Effect.fail(accepted.failure);
        }
        if (accepted.success.delivered) yield* promptAccepted(entry);
        return { messageId };
      });

    const interrupt: LiveAgentSessions<Meta>["interrupt"] = (id) =>
      Effect.gen(function* () {
        // Published and not yet preambled: its opener holds the permit until the opening
        // prompt has landed, so waiting for the permit is waiting for the turn to exist.
        if (ready(id) === undefined && live.get(id) !== undefined) {
          yield* Semaphore.withPermit(openingLock(id))(Effect.void);
        }
        const entry = ready(id);
        if (entry === undefined) return { _tag: "not_live" } as const;
        // Read before the harness is asked: on Claude Code the follow-up starts running the
        // moment the turn ahead of it is interrupted, and is then the turn, not a follow-up.
        const state = turnsOf(entry.scope);
        const followUp = state.followUps > 0;
        const asked = yield* Effect.result(
          entry.harness.interruptSession(entry.sessionId),
        );
        if (asked._tag === "Failure") {
          yield* closeSession(entry, "refused");
          return yield* Effect.fail(asked.failure);
        }
        if (!asked.success) return { _tag: "idle", entry } as const;
        if (asked.success === "background") {
          /*
           * No turn was stopped, so there is no idle to wait for and no follow-up to
           * account for. The harness has already waited for its tasks to say they are over;
           * whether any still runs is its status to report, and a status it cannot give is
           * read as "may still be running", never as stopped.
           */
          const status = yield* Effect.result(
            entry.harness.sessionStatus(entry.sessionId),
          );
          return {
            _tag: "background",
            entry,
            working:
              status._tag === "Failure" || status.success.background === true,
          } as const;
        }
        // Run at once or held, the message is no longer queued behind a turn: a second Stop
        // stops the turn it became, or finds the conversation idle.
        state.followUps = 0;
        // A wait that fails is a stream that ended, which is not a session still working.
        const settled = yield* Effect.result(
          entry.harness
            .waitForIdle(entry.sessionId)
            .pipe(Effect.timeoutOption(INTERRUPT_SETTLE)),
        );
        /*
         * On a harness that holds a queued message, whether one is held is the harness's to
         * say, not this registry's to infer: OpenCode starts a queued message the moment the
         * turn ahead of it finishes, with no idle between, so `followUp` is still counted
         * for the message that became the turn just stopped (A6 F5 review). Asked after the
         * settle, when the interrupt has done what it does to the inbox. A harness that
         * cannot be asked leaves the inference standing, which is all there is.
         */
        const held =
          entry.harness.queuedOnInterrupt === "held"
            ? yield* entry.harness
                .holding(entry.sessionId)
                .pipe(
                  Effect.catch((failure) =>
                    Effect.as(
                      Effect.logWarning(
                        "the harness would not say whether it holds a message after a Stop; the answer is inferred from what this server delivered",
                        { ...annotate(entry), detail: failure.message },
                      ),
                      followUp,
                    ),
                  ),
                )
            : followUp;
        /*
         * A Stop of a running turn stops the background work too (Claude Code's
         * `interruptSession` stops every task listed when it began), and the screen that
         * offered "Stop background work" beside the turn must hear that it did, or it goes
         * on offering it until its next activity read (A6 U6 review). Read after the
         * settle, as `background` is for a Stop with no turn; one that cannot be read is
         * "may still be running".
         */
        const after = yield* Effect.result(
          entry.harness.sessionStatus(entry.sessionId),
        );
        return {
          _tag: "interrupted",
          entry,
          working: settled._tag === "Success" && Option.isNone(settled.success),
          followUp: held,
          background:
            after._tag === "Failure" || after.success.background === true,
        } as const;
      });

    const status: LiveAgentSessions<Meta>["status"] = (id) =>
      Effect.gen(function* () {
        if (live.get(id) === undefined) return { _tag: "not_live" } as const;
        const entry = ready(id);
        // Published and not yet preambled: its opener is sending the opening prompt.
        if (entry === undefined) {
          return {
            _tag: "live",
            running: true,
            background: false,
            uncertain: false,
          } as const;
        }
        const busy = turnsOf(entry.scope).busy;
        const asked = yield* Effect.result(
          entry.harness
            .sessionStatus(entry.sessionId)
            .pipe(Effect.timeout(STATUS_ASK)),
        );
        if (asked._tag === "Failure") {
          return {
            _tag: "live",
            running: busy,
            background: false,
            uncertain: true,
          } as const;
        }
        return {
          _tag: "live",
          running: busy || asked.success.activity === "running",
          background: asked.success.background === true,
          uncertain: false,
        } as const;
      });

    /**
     * The ids with a model switch in flight. A set rather than a permit, because the second
     * switch is refused rather than made to wait; checked and added in one synchronous step,
     * so two switches cannot both see it free.
     */
    const switching = new Set<string>();

    const switchModel: LiveAgentSessions<Meta>["switchModel"] = <E, R>(input: {
      readonly id: string;
      readonly prepare: Effect.Effect<ModelSwitchPlan<Meta, E, R>, E, R>;
    }): Effect.Effect<ModelSwitchApplied, E | ModelSwitchFailure, R> =>
      /*
       * The claim is an acquire and its release is attached by the same operator, so there
       * is no instant between the id entering `switching` and its release being owed: an
       * interrupt that lands anywhere after the claim still takes the id back out, and the
       * conversation is never left refusing every switch as `switch_in_flight`.
       */
      Effect.acquireUseRelease(
        Effect.sync(() => {
          if (switching.has(input.id)) return false;
          switching.add(input.id);
          return true;
        }),
        (claimed) =>
          claimed
            ? Semaphore.withPermit(openingLock(input.id))(
                Effect.gen(function* () {
                  const plan = yield* input.prepare;
                  // Inside the permit an entry is preambled or gone (this module's
                  // header), so `get` and `ready` agree here.
                  const entry = live.get(input.id);
                  if (entry === undefined) {
                    yield* plan.record(undefined);
                    return "recorded" as const;
                  }
                  if (entry.instanceId !== plan.instanceId) {
                    return yield* Effect.fail<ModelSwitchFailure>({
                      _tag: "ModelSwitchStale",
                      liveInstanceId: entry.instanceId,
                    });
                  }
                  return yield* Effect.uninterruptible(
                    switchLive(input.id, entry, plan),
                  );
                }),
              )
            : Effect.fail<ModelSwitchFailure>({ _tag: "ModelSwitchInFlight" }),
        (claimed) =>
          claimed
            ? Effect.sync(() => {
                switching.delete(input.id);
              })
            : Effect.void,
      );

    /*
     * The harness call and the row write, **uninterruptible together**: a caller that goes
     * away (an HTTP client that disconnected) must not leave a harness that has moved and a
     * row that was never told. Both ends are bounded — the harness call by its control
     * timeout, the write by SQLite — so this cannot hang a fiber that is being interrupted.
     */
    const switchLive = <E, R>(
      id: string,
      entry: LiveAgentSession<Meta>,
      plan: ModelSwitchPlan<Meta, E, R>,
    ): Effect.Effect<ModelSwitchApplied, E | ModelSwitchFailure, R> =>
      Effect.gen(function* () {
        const switched = yield* Effect.result(
          entry.harness.switchModel(entry.sessionId, plan.model, plan.options),
        );
        if (switched._tag === "Failure") {
          if (!switchFoundNoSession(switched.failure)) {
            return yield* Effect.fail<ModelSwitchFailure>({
              _tag: "ModelSwitchUncertain",
              failure: switched.failure,
            });
          }
          // Not running in the harness: the entry is a handle on a session that is
          // gone or going, and the next message closes it as `refused` and reopens
          // from the row. So the row is what changes, and the entry keeps the model
          // its dead session was on.
          yield* plan.record(undefined);
          return "recorded" as const;
        }
        // Only the entry the map still holds, compared by scope as `closeSession` does:
        // a session closed and reopened under the same id while this waited is not the
        // one that was switched.
        const current = live.get(id);
        if (current !== undefined && current.scope === entry.scope) {
          live.set(id, {
            ...current,
            model: plan.model,
            meta: plan.meta(current.meta),
          });
        }
        yield* plan.record(entry);
        return "live" as const;
      });

    return {
      get: (id) => live.get(id),
      ready,
      open,
      closeSession,
      deliver,
      interrupt,
      status,
      switchModel,
      close: (id, reason) => {
        const entry = live.get(id);
        return entry === undefined ? Effect.void : closeSession(entry, reason);
      },
    } satisfies LiveAgentSessions<Meta>;
  });
