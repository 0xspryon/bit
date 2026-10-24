/**
 * A run outlives the request that starts it.
 *
 * `spike/phases.ts`'s `runWorkerPhase` does the whole thing in one effect: seed, create,
 * mint, register, prompt, wait, reconcile, settle, revoke. That is the right shape for a
 * demo, where the program *is* the run. It is the wrong shape for a server, where the
 * thing that asked for the run is an HTTP request that must answer in milliseconds while
 * the run takes minutes or hours. This module splits that sequence in two and gives the
 * second half an owner.
 *
 * ## What owns what
 *
 * **The attempt row is the durable record. The fiber is the ephemeral one.** Everything
 * below follows from that sentence, so it is worth being precise about it.
 *
 * - {@link startRun} does the start half and returns an attempt id. By the time it
 *   returns, the attempt row exists, a credential is minted against its fence, our MCP
 *   endpoint is registered with the harness carrying that credential, and the prompt has
 *   been accepted. Nothing after that point is the request's business.
 * - A **supervisor fiber** owns the rest: drain the session's log, publish it, reconcile,
 *   settle, revoke. It is forked into the *process* scope through a {@link FiberMap}
 *   keyed by attempt id — not into the request's scope, which closes as soon as the
 *   response is written and would take the run with it. The `FiberMap.runtime` handle is
 *   captured where this service is built, so the context those fibers run in is the
 *   layer's and demonstrably not a request's.
 * - Keying by attempt id makes **"what is running right now" a query** rather than a
 *   guess ({@link RunSupervisor.running}), and gives stop a handle to interrupt.
 * - The credential, the borrowed target store and the narration all live in the *fiber's*
 *   scope. `McpCredentials.issue` is an `acquireRelease`, so the grant is revoked when
 *   that scope closes — on success, on failure, on interruption, and on process shutdown.
 *   A credential outliving the fiber that was driving its session is the one state worth
 *   designing against.
 *
 * ## The three ways a run ends
 *
 * **It finishes.** The harness writes `session.execution.succeeded`, `.failed` or
 * `.interrupted` into the session's own log; we read it, and settle to it. That is the
 * harness stating an outcome, not us inferring one from silence.
 *
 * **Stop.** {@link RunSupervisor.stop} interrupts the fiber. The fiber's finalizer asks
 * the harness to interrupt the session, settles the attempt `interrupted` and revokes
 * every grant bound to it. `interrupted` is the one status we have first-hand knowledge
 * of: we are the ones who interrupted it. Telling the harness is not in the brief for this
 * slice and is here anyway, deliberately — "stop" on a tool that points agents at other
 * people's systems has to mean the agent stops touching them, not merely that we stop
 * watching. An attempt left `running` with a live credential after a stop would be worse
 * than one never started.
 *
 * **The process shuts down cleanly.** A `SIGINT` closes the layer's scope, which runs the
 * fiber map's own finalizer, which interrupts every entry — the fibers are forked as
 * daemons so they are not *children* of whoever started them, but the map holds them and
 * is what owns their lifetime. Each interruption then runs that supervisor's finalizer,
 * so every run in flight is settled and its authority revoked before the process exits.
 * That is the difference between a restart finding settled attempts and finding a pile of
 * `running` rows for recovery to guess at, and it is covered by a test rather than
 * assumed.
 *
 * Settling during shutdown means asking the harness over HTTP at the moment the harness
 * child is also being torn down, so those asks are bounded by
 * {@link SETTLEMENT_ASK_TIMEOUT}. A harness that cannot answer in time does not delay the
 * settlement, and a run nobody interrupted would settle `uncertain` — the honest answer,
 * and one a later sweep can still refine. Shutdown stays a matter of seconds.
 *
 * **The process dies.** The fiber is gone with it and the attempt row is left `running`.
 * This is not a gap: it is exactly the state `recovery/reconcile.ts` already sweeps at
 * startup, and it reconciles it against the harness to `uncertain` — never to `failed`.
 * Nothing here invents crash recovery; what it does is make sure the thing that crashes
 * leaves behind what recovery already reads. The one window that used to exist before the
 * row was written is closed by pre-assigning the session id; see {@link startRun}.
 *
 * ## A stream ending is not an outcome (DECISIONS.md §15)
 *
 * The drain replaces `waitForIdle`'s single long poll with a subscription to the session's
 * log, and the rule that governed the poll governs the stream identically. "The stream
 * died" and "the session finished" are different signals and both are handled:
 * {@link SupervisionEnd} names the four ways the loop can stop, and
 * {@link settlementFor} is the table that turns one of them plus the harness's own answer
 * into a status. A stream that ends or fails with no terminal entry reconciles against
 * `sessionStatus` and records `uncertain` when that cannot answer either. **The prompt is
 * never resubmitted**, on any path.
 */
import {
  RunRefused,
  type RunStarted,
  type RunningAttempt,
  type RunStopped,
} from "@bit/contracts";
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  FiberMap,
  Layer,
  Option,
  Redacted,
  Stream,
  type Duration,
} from "effect";

import { AgentHarness, type TerminalOutcome } from "../harness/agentHarness";
import { ControlPlaneEndpoint } from "../http/controlPlane";
import { McpCredentials } from "../mcp/credentials";
import * as identifier from "../persistence/identifier";
import type {
  AttemptTerminalStatus,
  ObservationStore,
} from "../persistence/store";
import { TargetStores } from "../persistence/targetStores";
import { RunNarrations } from "./narration";

/**
 * Where a worker calls back into, as something that can be asked later.
 *
 * **This exists to break a real cycle, and the cycle is worth stating.** The browser API's
 * handler group needs {@link RunSupervisor}. The supervisor needs two URLs from the
 * control plane: the MCP endpoint, for the registration body it hands the harness, and
 * the policy endpoint, for the options of the gate it installs into the workspace. Both
 * belong to `ControlPlaneEndpoint`, which is the listener — and the listener is built
 * *with* the browser API's routes merged onto its router. Three layers, each needing the
 * next.
 *
 * Both URLs together in one service rather than two, because they are answerable at the
 * same instant and by the same thing: splitting them would be two gates to publish and
 * two chances to publish only one.
 *
 * The knot is only tied because of *when* the URL is needed, not whether: the supervisor
 * wants it when a run starts, which is always after the listener is up. So the service's
 * value is an `Effect<string>` rather than a `string`, and the cycle becomes an ordering
 * that a composition root states in one place.
 *
 * Two ways to provide it, for the two kinds of caller:
 *
 * - {@link fromEndpoint} for anything whose listener is already a built layer — a test, a
 *   spike demo — where there is no cycle to break and the direct dependency is clearer.
 * - {@link pending} for a composition root that is inside the cycle. It hands back a layer
 *   and the function that answers it, and the root publishes the URL as soon as the
 *   listener exists. A `start` that somehow arrived first would *wait* for it rather than
 *   fail, which is the right answer: the URL is moments away and refusing would be
 *   inventing a failure out of a startup ordering.
 */
export interface WorkerUrls {
  /** Where the worker's MCP client connects, carrying its attempt credential. */
  readonly mcp: string;
  /** Where the harness-side policy hook posts each decision request. */
  readonly policy: string;
}

export class WorkerEndpoints extends Context.Service<
  WorkerEndpoints,
  {
    /** Where the worker calls back into. Resolved once the listener is up. */
    readonly urls: Effect.Effect<WorkerUrls>;
  }
>()("bit/run/WorkerEndpoints") {
  /** The URLs of a listener that is already in context. */
  static readonly fromEndpoint: Layer.Layer<
    WorkerEndpoints,
    never,
    ControlPlaneEndpoint
  > = Layer.effect(
    WorkerEndpoints,
    Effect.map(ControlPlaneEndpoint, (endpoint) =>
      WorkerEndpoints.of({
        urls: Effect.succeed({
          mcp: endpoint.mcpUrl,
          policy: endpoint.policyUrl,
        }),
      }),
    ),
  );

  /**
   * A URL that is not known yet, plus the way to answer it.
   *
   * The returned `publish` is called once, by the composition root, as soon as the
   * listener is built. Calling it twice is harmless and ignored — a `Deferred` keeps its
   * first answer — so a root that is restructured later cannot silently change which URL
   * workers are told about.
   */
  static readonly pending = (): {
    readonly layer: Layer.Layer<WorkerEndpoints>;
    readonly publish: (urls: WorkerUrls) => Effect.Effect<void>;
  } => {
    const gate = Deferred.makeUnsafe<WorkerUrls>();
    return {
      layer: Layer.succeed(
        WorkerEndpoints,
        WorkerEndpoints.of({ urls: Deferred.await(gate) }),
      ),
      publish: (urls) => Effect.asVoid(Deferred.succeed(gate, urls)),
    };
  };
}

/** What starting one run needs. Every id below is minted here, not supplied. */
export interface RunInput {
  /** Whose evidence this run writes to. Dispatch is by this id, everywhere. */
  readonly targetId: string;
  /**
   * The directory the harness session runs in.
   *
   * The engagement's own folder, which the operator picked when the target was
   * registered. Per session rather than per harness process, which is what lets one
   * `opencode serve` drive two targets in two folders.
   */
  readonly workspace: string;
  /**
   * Which model, inside the harness instance this process is driving.
   *
   * A harness-scoped name (`openai/gpt-5.6-sol`, `claude-sonnet-5`) and optional: there is
   * no picker yet, so a caller that names none gets the instance's configured default.
   * The *instance* is deliberately not a parameter — this process drives one, and an
   * attempt is pinned to it the moment it starts. Choosing between instances is slice C's
   * work and would arrive as a resolver in front of {@link AgentHarness}, not as a field
   * here.
   */
  readonly model?: string | undefined;
  /** What the engagement is after. Advisory prose; never enforcement (§4). */
  readonly goal: string;
  /** The narrower question this run is against. */
  readonly question: string;
  /** The prompt text. Built by the caller; never contains a credential. */
  readonly task: string;
  /**
   * Where the harness-side policy gate appends its decisions.
   *
   * Supplied by the caller rather than derived here, because it is a *fleet layout*
   * question — the target's own `evidence/` directory — and the supervisor does not hold
   * the registry. It must be outside {@link workspace}: a worker that can read its own
   * audit trail can read the shape of the boundary it is inside.
   */
  readonly auditPath: string;
  /** Shown as the session's title in the harness's own UI. */
  readonly title: string;
}

/**
 * How the supervision loop stopped, before anything is concluded from it.
 *
 * Four cases, kept apart because collapsing any two of them is how a tool starts reporting
 * outcomes it did not observe:
 *
 * - `waited` — the harness's long poll returned. It says the session is no longer running
 *   and says nothing about how it went.
 * - `waitFailed` — our long poll lost its answer, or exceeded its transport bound. Says
 *   nothing at all: cancelling *our* request is not the harness stopping work
 *   (DECISIONS.md §15).
 * - `stopped` — we interrupted it. The only case where we are the source of the answer.
 * - `startFailed` — the run never got as far as being watched.
 */
export type SupervisionEnd =
  | { readonly _tag: "waited" }
  | { readonly _tag: "waitFailed"; readonly detail: string }
  | { readonly _tag: "stopped" }
  | { readonly _tag: "startFailed" };

/**
 * Everything the supervisor has to settle from, gathered before it decides.
 *
 * Three sources, and keeping them as three fields rather than folding them as they arrive
 * is the point: each one can be absent, and which one answered is what the log line says.
 */
export interface Settleable {
  /** How the loop stopped. */
  readonly end: SupervisionEnd;
  /**
   * A terminal `session.execution.*` the narration stream carried, if any.
   *
   * The harness stating an outcome in its own event stream. Absent when the stream was
   * never established, died early, or simply had not reached the terminal event.
   */
  readonly narrated: TerminalOutcome | undefined;
  /**
   * What `session.get` says about the session now, if it could be asked.
   *
   * Absent when the call failed, and also when it succeeded with no `outcome` on the
   * session — which `opencode` 2.1.2 does for a session that has not finished.
   */
  readonly harness: TerminalOutcome | undefined;
}

/**
 * The status one ending plus what the harness said settles to.
 *
 * A pure function, exported so the rule can be tested without a harness, a database or a
 * fiber. Three sources ranked, then one fallback:
 *
 * 1. **`session.get`'s own `outcome`**, when it has one. The harness's current view of the
 *    session, and the most recent of the three reads.
 * 2. **A terminal event from the narration stream.** Also the harness saying so, a moment
 *    earlier. Used when `session.get` has no outcome to give, which is the common case
 *    rather than the exception.
 * 3. **`interrupted`, for a stop, and only for a stop.** This is the one status we know
 *    first-hand: the operator asked us to stop, we asked the harness to interrupt the
 *    session, and we revoked the attempt's authority. It is not an inference from silence
 *    — unlike `failed`, which would be a claim about the work.
 * 4. **Otherwise `uncertain`.** Never `failed`: "we could not find out" and "it did not
 *    work" are different facts and only one of them would be in evidence. This covers the
 *    wait returning without the harness ever saying how it went, the wait losing its
 *    answer, and a start that broke before anything was watched.
 */
export const settlementFor = (input: Settleable): AttemptTerminalStatus =>
  input.harness ??
  input.narrated ??
  (input.end._tag === "stopped" ? "interrupted" : "uncertain");

/** One line an operator or a test can read about how a run ended. */
export const renderEnd = (end: SupervisionEnd): string =>
  end._tag === "waited"
    ? "the harness reported the session is no longer running"
    : end._tag === "stopped"
      ? "stopped on request"
      : end._tag === "startFailed"
        ? "the run broke before it was being watched"
        : `our wait lost its answer, which says nothing about the session: ${end.detail}`;

/**
 * How long settlement will wait for the harness to answer, per call.
 *
 * **This is a bound on *asking*, not a deadline on the worker.** DECISIONS.md §5 rules
 * out deadline-triggered settlement, and this is not that: it never decides an outcome, it
 * only decides how long we wait before recording that we could not find one. Exceeding it
 * means `settlementFor` falls through to the narrated outcome, or to `uncertain` — the
 * same answer an unreachable harness already produces, reached sooner.
 *
 * It exists because settlement runs inside a *shutdown* path. A `SIGINT` closes the
 * supervisor's fiber map, every supervisor is interrupted, and each one's finalizer then
 * asks the harness about its session — at exactly the moment the harness child is also
 * being torn down. The client's own per-operation bound is 30 seconds, so without this a
 * server with three runs in flight could take minutes to exit, asking a dying process
 * questions. Ten seconds is generous for an HTTP call to a process on loopback and short
 * enough that shutting down stays a matter of seconds.
 *
 * The *write* is deliberately not bounded by this. It is local SQLite and the thing that
 * must not be skipped: an attempt left `running` because we gave up on a disk write is a
 * row for the next sweep to guess at.
 */
export const SETTLEMENT_ASK_TIMEOUT = "10 seconds";

/**
 * How many settled runs are kept for a stop response to report.
 *
 * A courtesy, not a record. The durable answer is the attempt row and its
 * `attempt.settled` event, and anything that needs the history reads those.
 */
const SETTLEMENT_MEMORY = 64;

/**
 * What one running attempt's supervisor is holding.
 *
 * The contract's own shape, extended rather than restated: what this process answers about
 * a run it is supervising is exactly {@link RunningAttempt}, and a second declaration of
 * those fields would be a place for the two to drift.
 *
 * The one addition is `workspace`, which is **not** on the contract and should not be. It
 * is here because {@link workspaceClaim} needs to answer "is anything already running in
 * that directory" from this map, and because publishing the server's filesystem layout to
 * a browser would be telling it something it has no use for. {@link RunSupervisor.running}
 * projects it back off.
 */
interface Supervised extends RunningAttempt {
  readonly workspace: string;
}

export class RunSupervisor extends Context.Service<
  RunSupervisor,
  {
    /**
     * Starts a run and returns as soon as the prompt is accepted.
     *
     * Does **not** wait for the run. The returned attempt id is the handle for everything
     * afterwards: `GET` it in {@link running}, `stop` it, and find its observations and
     * its two lifecycle events under it in the target's own database.
     */
    readonly start: (input: RunInput) => Effect.Effect<RunStarted, RunRefused>;
    /**
     * Interrupts one run, settles its attempt and revokes its authority.
     *
     * Refuses `unknown_attempt` when nothing is running under that id in *this* process.
     * That is deliberately not the same question as "is the attempt row `running`": a row
     * left `running` by a dead process has no fiber to interrupt, and the thing that
     * settles it is the startup sweep, not this.
     */
    readonly stop: (attemptId: string) => Effect.Effect<RunStopped, RunRefused>;
    /** The attempts this process is supervising right now, from the fiber map itself. */
    readonly running: Effect.Effect<readonly RunningAttempt[]>;
  }
>()("bit/run/RunSupervisor") {
  /**
   * The supervisor over one harness.
   *
   * Requires a client, which is what makes "this deployment can start runs" a layer
   * question rather than a runtime one. A process with no harness provides
   * {@link RunSupervisor.unavailable} instead and refuses every start by name.
   */
  static readonly layer: Layer.Layer<
    RunSupervisor,
    never,
    | AgentHarness
    | TargetStores
    | McpCredentials
    | WorkerEndpoints
    | RunNarrations
  > = Layer.effect(
    RunSupervisor,
    // `Effect.suspend` because `make` closes over this class and this class's static
    // initialiser names `make`: deferring the reference breaks a genuine circular
    // initialisation rather than papering over an ordering accident.
    Effect.suspend(() => make()),
  );

  /**
   * The supervisor with a different bound on asking the harness during settlement.
   *
   * Exists for tests that have to watch a shutdown *not* wait: ten seconds is the right
   * answer for an operator and an unusable one for a suite, and a test that waited it out
   * per in-flight run would be thirty seconds of nothing. Nothing in the server passes
   * this — the same arrangement, and the same reason, as `TargetStores.layerWith`.
   */
  static readonly layerWith = (options: {
    readonly askTimeout: Duration.Input;
  }): Layer.Layer<
    RunSupervisor,
    never,
    | AgentHarness
    | TargetStores
    | McpCredentials
    | WorkerEndpoints
    | RunNarrations
  > =>
    Layer.effect(
      RunSupervisor,
      Effect.suspend(() => make(options)),
    );

  /**
   * A supervisor for a process that has no harness to drive.
   *
   * Every start is refused `no_harness` with a sentence an operator can act on. This
   * exists so that a server whose configured harness is missing or unauthenticated still
   * boots, still serves the browser API, still sweeps the fleet and still reconciles —
   * rather than failing to start because one subsystem is unavailable. `running` is empty
   * and `stop` refuses, both of which are true.
   */
  static readonly unavailable: Layer.Layer<RunSupervisor> = Layer.succeed(
    RunSupervisor,
    RunSupervisor.of({
      start: () =>
        Effect.fail(
          new RunRefused({
            reason: "no_harness",
            detail:
              "this server has no agent harness, so there is nothing to run a worker in: either the harness HARNESS names could not be started, or it was switched off with HARNESS=0. Check that the harness is installed and authenticated, then restart.",
          }),
        ),
      stop: (attemptId) =>
        Effect.fail(
          new RunRefused({
            reason: "unknown_attempt",
            detail: `nothing is running under ${attemptId}: this server has no agent harness, so it has started nothing`,
          }),
        ),
      running: Effect.succeed([]),
    }),
  );
}

/**
 * Collapses everything the start half can fail with into one typed refusal.
 *
 * The call sites below produce four error types from three subsystems, and the HTTP
 * surface needs one. The mapping keeps the distinction that matters to an operator — is
 * this target's database the problem, or the harness, or my request — and discards the
 * ones that only matter to us, which go to the log with their structure intact.
 */
const refuse = (error: {
  readonly _tag: string;
  readonly message?: string;
}): RunRefused => {
  switch (error._tag) {
    case "FleetError":
      return new RunRefused({
        reason: "target_unavailable",
        detail: error.message ?? "that target's database could not be opened",
      });
    case "PolicyHookNotInstalled":
      return new RunRefused({
        reason: "workspace_ungated",
        detail:
          error.message ??
          "the pre-execution policy gate could not be installed into this engagement's folder",
      });
    case "HarnessTransportError":
    case "HarnessDecodeError":
      return new RunRefused({
        reason: "harness_unreachable",
        detail: error.message ?? "the agent harness did not answer",
      });
    default:
      return new RunRefused({
        reason: "store_unavailable",
        detail:
          error.message ?? "this target's database could not be written to",
      });
  }
};

const make = Effect.fnUntraced(function* (options?: {
  readonly askTimeout?: Duration.Input | undefined;
}) {
  const askTimeout = options?.askTimeout ?? SETTLEMENT_ASK_TIMEOUT;
  const harness = yield* AgentHarness;
  const stores = yield* TargetStores;
  const credentials = yield* McpCredentials;
  const endpoints = yield* WorkerEndpoints;
  const narrations = yield* RunNarrations;

  /**
   * One entry per running attempt, owned by this layer's scope.
   *
   * Closing that scope interrupts every entry, so a `SIGINT` runs each supervisor's
   * finalizer — settle, revoke — rather than dropping the run on the floor with a live
   * credential behind it.
   *
   * `unknown` as the error type rather than `never`: a supervisor fiber's failures are
   * logged inside it, but typing the map's channel as `never` would force an
   * `Effect.catchCause` that also swallows interruption, which is the one cause this
   * fiber must be allowed to complete with.
   */
  const fibers = yield* FiberMap.make<string, void, unknown>();
  /**
   * Forks into the fiber map with **this layer's** context, captured here.
   *
   * `FiberMap.runtime` reads `Effect.context` at the point it is yielded
   * (`effect/src/FiberMap.ts`), which is here, inside the layer's construction. That is
   * the mechanism behind the sentence at the top of this file: a supervisor does not
   * inherit the request fiber's context or its scope, so there is no way for a response
   * being written to interrupt a run.
   */
  const fork = yield* FiberMap.runtime(fibers)<never>();

  /** What each supervisor registers so `running` can answer without asking a fiber. */
  const supervised = new Map<string, Supervised>();
  /**
   * The engagement folders runs are in flight in, so a second one can be refused.
   *
   * ## Why a directory can hold only one run at a time
   *
   * **Both harnesses configure their pre-execution gate per workspace, not per attempt.**
   * `installGate` writes `.opencode/opencode.json` or `.claude/settings.local.json` in the
   * session's directory, carrying that run's policy URL and *that target's* audit path. A
   * second run installing into the same folder replaces those options — so the first run's
   * tool calls start being audited into a different target's file, and the audit stops
   * being a record of what that worker was allowed to do.
   *
   * **And on OpenCode the MCP registration is per directory too.** `api.mcp.add` takes a
   * `location: { directory }`, so two attempts in one folder each register
   * `bit-<attemptId>` into it and **both workers see both servers**. A tool call through
   * the wrong one writes under the wrong attempt's credential: an observation attributed
   * to an attempt that never made it. Provenance is the thing this system exists to get
   * right, so a path that can silently misattribute a write is worse than one that
   * refuses.
   *
   * **One rule, both harnesses, deliberately.** Claude Code's MCP registration *is* per
   * session — `claudeCodeClient.ts` has a test proving one session's registration is not
   * reachable from another's — so the second hazard is OpenCode's alone and the refusal
   * could have been scoped to it. It is not, because the *first* hazard is not: the gate's
   * audit path is per workspace on both. Two rules where one will do is two things to
   * reason about, and here the single rule is also the correct one for each.
   *
   * Two workers cooperating on one engagement is later work. Until the gate and the MCP
   * registration are per attempt, refusing is the honest answer.
   *
   * ## Keyed by workspace, and claimed before anything is forked
   *
   * **By workspace, not by target.** The hazard is the shared directory. A target's
   * workspace comes from its registry row, so same target implies same workspace — but a
   * target registered without a folder falls back to the picker root, and two of those
   * would collide while being different targets. Keying on the directory covers both; the
   * refusal still names the target holding it, because that is what an operator
   * recognises.
   *
   * **By what is actually running**, which is this map, rather than by rows saying
   * `running`: a row left behind by a process that died has no worker in that folder, and
   * refusing on its account would make a crash permanently block an engagement. The
   * startup sweep is what settles those.
   *
   * **Claimed in `start`, synchronously, before the fiber is forked.** Checking
   * `supervised` would be a race: a supervisor registers itself *inside* the forked fiber,
   * so two starts arriving in the same tick would both look, both see nothing and both
   * proceed. `Effect.sync` does not yield, so the check and the claim below are one
   * indivisible step.
   *
   * Path comparison is textual. Two registry rows naming one directory by different paths
   * — through a symlink, say — would not collide here. Registration already refuses a
   * folder that is some other target's, and `realpath`ing on every start would be
   * filesystem work on the request path to close a case the registry has already closed.
   */
  const claimedWorkspaces = new Map<
    string,
    { readonly attemptId: string; readonly targetId: string }
  >();

  /**
   * Claims a workspace for one attempt, or reports who already holds it.
   *
   * Returns `undefined` on success. Releasing is {@link releaseWorkspace}, which the
   * supervisor's own finalizer calls on every exit.
   */
  const workspaceClaim = (
    workspace: string,
    claim: { readonly attemptId: string; readonly targetId: string },
  ): Effect.Effect<RunRefused | undefined> =>
    Effect.sync(() => {
      const held = claimedWorkspaces.get(workspace);
      if (held !== undefined) {
        return new RunRefused({
          reason: "workspace_busy",
          detail: `attempt ${held.attemptId} is already running in ${workspace} (target '${held.targetId}'). Only one run at a time may use an engagement's folder: both harnesses configure their pre-execution policy gate per folder, and OpenCode registers its MCP endpoint per folder, so a second worker there could be audited against the wrong target or record an observation under the wrong attempt. Stop that run, or wait for it to settle, and start this one after.`,
        });
      }
      claimedWorkspaces.set(workspace, claim);
      return undefined;
    });

  /** Gives a workspace back. Idempotent, and safe to call for a claim we never made. */
  const releaseWorkspace = (
    workspace: string,
    attemptId: string,
  ): Effect.Effect<void> =>
    Effect.sync(() => {
      // Only our own claim: a release that fired late must not hand away a folder a
      // *later* run has since claimed.
      if (claimedWorkspaces.get(workspace)?.attemptId === attemptId) {
        claimedWorkspaces.delete(workspace);
      }
    });
  /**
   * What each run settled to, written by the supervisor's finalizer.
   *
   * Exists so {@link stop} can report the settlement it caused without re-reading the
   * row: `Fiber.interrupt` awaits the finalizer, so by the time stop looks here the entry
   * is there. Bounded by keeping only the last {@link SETTLEMENT_MEMORY} runs, because
   * this is a courtesy for a response body and not a record — the record is the attempt
   * row and its `attempt.settled` event.
   */
  const settlements = new Map<
    string,
    { status: AttemptTerminalStatus; grants: number }
  >();
  const remember = (
    attemptId: string,
    outcome: { status: AttemptTerminalStatus; grants: number },
  ): void => {
    settlements.set(attemptId, outcome);
    while (settlements.size > SETTLEMENT_MEMORY) {
      const oldest = settlements.keys().next().value;
      if (oldest === undefined) break;
      settlements.delete(oldest);
    }
  };

  /**
   * The start half: everything up to, but not including, the prompt.
   *
   * The prompt is one step further out, in {@link supervise}, because the narration
   * subscription has to be opened first — `event.subscribe()` is live-only, so prompting
   * before subscribing throws away the beginning of the run. Everything here is the part
   * that has to be true *before* a prompt is a defensible thing to send: the row exists,
   * the session exists, a credential is bound to its fence, and our endpoint is registered
   * on the harness under that credential.
   *
   * The order is the one `runWorkerPhase`'s header states, with one change —
   * **the session id is minted here and written before the session exists.**
   *
   * `openWorkerSession` seeds the attempt with `harnessSessionId: null`, creates the
   * session, then binds the real id. A process that died between the second and third
   * steps left a live harness session that no attempt row pointed at: recovery sweeps
   * attempt rows, so nothing would ever look at it again. `SessionCreateInput` in
   * `@opencode/client@2.1.0` accepts an `id`, and `opencode` 2.1.2 was checked to return
   * the id it is handed, so the window closes: the row names the session first, and the
   * worst case becomes an attempt pointing at a session that was never created — which
   * recovery already handles by asking the harness, being told `missing`, and recording
   * `uncertain`.
   *
   * The returned id is compared against the one we asked for anyway. If a future harness
   * silently ignores `id` this rebinds to the real one and says so in the log, rather
   * than leaving the database naming a session nobody has.
   *
   * Everything after the seed is in the fiber's scope, which is why this runs inside the
   * supervisor rather than in the request: the credential is an `acquireRelease`, and
   * issuing it into the request's scope would revoke it the moment the response was
   * written.
   */
  const startHalf = Effect.fnUntraced(function* (
    input: RunInput,
    ids: {
      readonly goalId: string;
      readonly intentId: string;
      readonly attemptId: string;
      readonly workerId: string;
    },
  ) {
    const store = yield* stores.open(input.targetId);
    const urls = yield* endpoints.urls;

    /**
     * The pre-execution gate, into the workspace, before the session exists.
     *
     * **First, before even the attempt row.** Two reasons, and they are different. The
     * gate is loaded from the session's own directory, so installing it after
     * `createSession` would leave a window — possibly the whole run — in which the worker
     * executed tools no gate had seen. And doing it before `seedAttempt` means a refusal
     * writes *nothing at all*: no row to settle, nothing for a sweep to find, no record
     * of a run that never happened.
     *
     * A failure here **refuses the run**. A workspace whose configuration we will not
     * overwrite is a reason not to start an ungated worker in it, not a reason to start
     * one and hope: nothing has been prompted at this point, so refusing costs an error
     * message, and permitting would cost a worker running against somebody's systems with
     * no record of what it was allowed to do.
     *
     * **The harness installs it, and that is why this line has no `switch` in it.**
     * OpenCode's gate is a plugin in `.opencode/opencode.json`; Claude Code's is a
     * `PreToolUse` command hook in `.claude/settings.local.json`, with a different
     * payload, a different way of saying "deny" and a different failure default. The one
     * thing they share is this call. `policy/install.ts` records the six properties every
     * implementation of it has to keep.
     */
    yield* harness.installGate({
      workspace: input.workspace,
      policyUrl: urls.policy,
      auditPath: input.auditPath,
      // Appended to, not emptied: the audit belongs to the target and accumulates across
      // runs, unlike the spike's, which describes one scope and is read back immediately.
      freshAudit: false,
    });

    // Minted by the harness, in the harness's own format: OpenCode brands a `ses_`-prefixed
    // id and the Claude Agent SDK requires a UUID. Neither is ours to invent, and the
    // decision to mint one *before* the row is written is what closes the window below.
    const harnessSessionId = harness.newSessionId();
    const model = input.model ?? harness.instance.defaultModel;
    // Which provider and model the evidence records. Harness-specific — OpenCode routes a
    // model through a named provider of its own, Claude Code has one — and asked here
    // rather than taken from `createSession`'s answer because the row is written first.
    const provenance = harness.modelProvenance(model);

    const authority = yield* store.seedAttempt({
      targetId: input.targetId,
      goalId: ids.goalId,
      goal: input.goal,
      intentId: ids.intentId,
      question: input.question,
      attemptId: ids.attemptId,
      workerId: ids.workerId,
      // Pinned here and never updated: moving work to another harness is a replacement
      // attempt, not a retarget.
      harnessInstanceId: harness.instance.instanceId,
      providerId: provenance.providerId,
      modelId: provenance.modelId,
      harnessSessionId,
    });

    const session = yield* harness.createSession({
      title: input.title,
      model,
      directory: input.workspace,
      sessionId: harnessSessionId,
    });
    if (session.id !== harnessSessionId) {
      yield* Effect.logWarning(
        "the harness did not honour the session id it was handed; rebinding the attempt to the id it chose",
        { asked: harnessSessionId, got: session.id },
      );
      yield* store.bindSessionToAttempt(ids.attemptId, session.id);
    }

    const credential = yield* credentials.issue({
      targetId: input.targetId,
      intentId: ids.intentId,
      attemptId: ids.attemptId,
      harnessSessionId: session.id,
      workerId: ids.workerId,
      // Authority as of now. If recovery fences this attempt while the worker is out,
      // the credential stops working even though the registry still holds it.
      attemptFence: authority.writeFence,
    });

    yield* harness.registerMcpServer(session.id, `bit-${ids.attemptId}`, {
      url: urls.mcp,
      // Unwrapped and immediately re-wrapped: this is the one place the raw token is
      // touched, to put it in the header of the one request that delivers it. It never
      // reaches the harness's argv or the environment the agent's shells inherit
      // (DECISIONS.md §6, "credentials off argv").
      headers: {
        authorization: Redacted.make(
          `Bearer ${Redacted.value(credential.token)}`,
        ),
      },
      directory: input.workspace,
    });

    return { store, harnessSessionId: session.id, provenance };
  });

  /**
   * Publishes one session's narration until it is interrupted or the stream dies.
   *
   * Runs as a child fiber of the supervisor for its whole life, and is **not** what
   * decides the outcome. It records any terminal `session.execution.*` it sees into
   * `report.narrated`, which {@link settlementFor} ranks second behind `session.get`.
   *
   * **Why this is not also the settlement signal.** `event.subscribe()` is live-only, so
   * there is a window between the subscription being asked for and it being established
   * on the wire. Taking settlement from this stream would mean a run whose terminal event
   * landed in that window had no terminal event at all — and because the stream does not
   * end when a session settles, the supervisor would not finish either: a hang rather than
   * a wrong answer, which is worse. `waitForIdle` has no such window: it is a request the
   * harness answers when the session stops running. So the stream narrates and the wait
   * says when it is over, and both of them are read before anything is concluded.
   *
   * A failure here is logged and nothing more. The stream breaking is not an outcome —
   * the probe that chose this stream saw it die with an `ECONNRESET` at teardown — and
   * the supervisor that outlives it still settles from the wait and from `session.get`.
   *
   * **In practice the narrated outcome usually loses a race, and that is fine.** The
   * harness answers `waitForIdle` and emits `session.execution.succeeded` at about the
   * same moment, and the wait returning is what stops this fiber — so against a live
   * server `report.narrated` was typically still empty at settlement, and every run
   * settled from `session.get`, which answers reliably for a finished session. This is a
   * backstop for the case where `session.get` cannot be asked at all, not the usual path.
   * Widening the race with a grace period here would be a timer deciding an outcome,
   * which is the thing DECISIONS.md §5 rules out.
   */
  const narrateSession = Effect.fnUntraced(function* (
    targetId: string,
    attemptId: string,
    harnessSessionId: string,
    report: { narrated: TerminalOutcome | undefined },
  ) {
    const outcome = yield* Effect.result(
      Stream.runForEach(harness.sessionEvents(harnessSessionId), (entry) =>
        Effect.andThen(
          narrations.publish({
            targetId,
            attemptId,
            harnessSessionId,
            entry,
          }),
          Effect.sync(() => {
            if (entry.outcome !== undefined) report.narrated = entry.outcome;
          }),
        ),
      ),
    );
    if (outcome._tag === "Failure") {
      yield* Effect.logWarning(
        "a run's narration stream ended; this says nothing about the session and the run is still settled from the harness's own answer",
        {
          attemptId,
          harnessSessionId,
          detail: outcome.failure.message,
        },
      );
    }
  });

  /**
   * Reconcile, settle, revoke — in that order, and the order is load-bearing.
   *
   * The harness is asked **before** the transaction opens, because `settleAttempt` takes
   * SQLite's single write lock and an HTTP round trip inside it would hold that lock for
   * the length of someone else's network. `recovery/reconcile.ts` states the same rule
   * for the same reason.
   *
   * Authority is revoked **after** the status has moved. Revoking first would open a
   * window where the credential is gone but the row still says the attempt may write,
   * which is the wrong way round: a worker refused with `unauthorized` when the row still
   * says `running` is a worker that cannot tell a settled attempt from a broken server.
   *
   * `settleAttempt` and not `recordRecovery`, deliberately. `recordRecovery` writes an
   * `attempt_recoveries` row, and that table answers "which attempts needed reconciling
   * after a process died". A live supervisor settling the attempt it has been watching all
   * along is not recovery, and filing it as recovery would make that table over-report
   * every clean run.
   */
  const settle = Effect.fnUntraced(function* (
    store: ObservationStore["Service"],
    input: {
      readonly attemptId: string;
      readonly harnessSessionId: string;
      readonly end: SupervisionEnd;
      readonly narrated: TerminalOutcome | undefined;
    },
  ) {
    // Best effort, bounded, and outside any transaction. A failure here is not an
    // outcome; it just means the harness's own view is unavailable, which
    // `settlementFor` reads as "no answer" and resolves from the narration, or to
    // `uncertain`. The bound is why a shutdown cannot wedge on a dying harness; see
    // {@link SETTLEMENT_ASK_TIMEOUT}.
    const asked = yield* Effect.result(
      // The bound holds here even though this runs inside a scope finalizer, which is an
      // uninterruptible region: `Effect.timeout` still cuts the call short. That was
      // checked rather than assumed — removing the bound makes
      // "a harness that will not answer during shutdown" hang, which is the point of
      // that test.
      Effect.timeout(harness.sessionStatus(input.harnessSessionId), askTimeout),
    );
    // Named `harnessSaid` rather than `harness`, which is the service: what the harness
    // *said* and the harness itself are different things and the shadowing read badly.
    const harnessSaid =
      asked._tag === "Success" ? asked.success.outcome : undefined;
    const status = settlementFor({
      end: input.end,
      narrated: input.narrated,
      harness: harnessSaid,
    });

    const settlement = yield* Effect.result(
      store.settleAttempt(input.attemptId, status),
    );
    const grants = yield* credentials.revokeAttempt(input.attemptId);

    if (settlement._tag === "Failure") {
      // The row could not be written, so the attempt is left `running` with its authority
      // revoked in memory only. That is exactly the state the startup sweep exists for,
      // and saying so here is the difference between a gap and a known handover.
      yield* Effect.logError(
        "a run could not be settled; its row is left for the startup sweep to reconcile",
        {
          attemptId: input.attemptId,
          wanted: status,
          detail: settlement.failure.message,
        },
      );
    }
    yield* Effect.logInfo("a run settled", {
      attemptId: input.attemptId,
      harnessSessionId: input.harnessSessionId,
      end: renderEnd(input.end),
      harnessSaid: harnessSaid ?? "nothing definite",
      narrationSaid: input.narrated ?? "nothing definite",
      status,
      changed:
        settlement._tag === "Success" ? settlement.success.changed : "unknown",
      grantsRevoked: grants,
    });
    return { status, grants };
  });

  /**
   * One supervised run, start to settlement, as the fiber sees it.
   *
   * `Effect.scoped` around the whole body is what makes the credential's lifetime the
   * run's: `credentials.issue` registers its revocation in this scope, and the borrowed
   * target store is returned when it closes.
   *
   * `Effect.addFinalizer` rather than a step at the end of the happy path. Finalizers run
   * on every exit — success, failure, and the interruption that {@link RunSupervisor.stop}
   * causes — and they run uninterruptibly, so a stop cannot interrupt the settlement it
   * asked for. `ending` is a mutable local because the finalizer has to see what the drain
   * concluded, and the drain may never have run.
   */
  const supervise = (
    input: RunInput,
    ids: {
      readonly goalId: string;
      readonly intentId: string;
      readonly attemptId: string;
      readonly workerId: string;
    },
    gate: Deferred.Deferred<RunStarted, RunRefused>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const opened = yield* Effect.result(startHalf(input, ids));
        if (opened._tag === "Failure") {
          yield* Deferred.fail(gate, refuse(opened.failure));
          return;
        }
        const { store, harnessSessionId, provenance } = opened.success;
        const startedAt = Date.now();

        /**
         * What the finalizer will settle from, if the wait never gets to say.
         *
         * `stopped` is the right default because the only way out of the body below
         * without the wait returning is an interruption, and the only thing that
         * interrupts this fiber is a stop or the process's scope closing — both of which
         * are us stopping the run.
         */
        let ending: SupervisionEnd = { _tag: "stopped" };
        /**
         * Where the narration fiber leaves a terminal outcome it saw.
         *
         * A mutable record shared with a child fiber rather than a `Ref`, because the
         * only writer is that one fiber and the only reader is this one's finalizer, after
         * it has been interrupted. A `Ref` would be ceremony around a single field with no
         * contention on it.
         */
        const report: { narrated: TerminalOutcome | undefined } = {
          narrated: undefined,
        };

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            supervised.delete(ids.attemptId);
            // Given back here rather than in `start`, because the claim has to outlive the
            // request: it is held for as long as a worker is in that folder, and this
            // finalizer runs on every exit — success, failure and the interruption a stop
            // or a shutdown causes.
            yield* releaseWorkspace(input.workspace, ids.attemptId);
            // Only when we are the reason it is over. A session that reported its own
            // outcome has already stopped, and asking it to stop again would be a
            // pointless round trip on every clean run.
            if (ending._tag === "stopped") {
              const interrupted = yield* Effect.result(
                // Bounded for the reason on the `sessionStatus` ask in `settle`: this
                // also runs in a finalizer, and a dying harness answers neither.
                Effect.timeout(
                  harness.interruptSession(harnessSessionId),
                  askTimeout,
                ),
              );
              yield* Effect.logInfo(
                "asked the harness to interrupt a session",
                {
                  attemptId: ids.attemptId,
                  harnessSessionId,
                  // A refusal here is reported, not acted on: the attempt's authority is
                  // revoked below either way, so a session we could not reach cannot
                  // record anything even if it carries on working.
                  harnessInterrupted:
                    interrupted._tag === "Success"
                      ? interrupted.success
                      : `could not ask: ${interrupted.failure.message}`,
                },
              );
            }
            remember(
              ids.attemptId,
              yield* settle(store, {
                attemptId: ids.attemptId,
                harnessSessionId,
                end: ending,
                narrated: report.narrated,
              }),
            );
          }),
        );

        const started: RunStarted = {
          attemptId: ids.attemptId,
          targetId: input.targetId,
          intentId: ids.intentId,
          goalId: ids.goalId,
          harnessSessionId,
          instanceId: harness.instance.instanceId,
          providerId: provenance.providerId,
          modelId: provenance.modelId,
          startedAt,
        };
        supervised.set(ids.attemptId, {
          attemptId: ids.attemptId,
          targetId: input.targetId,
          intentId: ids.intentId,
          harnessSessionId,
          startedAt,
          workspace: input.workspace,
        });
        // Subscribed before prompted, which is the whole reason the prompt is here and
        // not in `startHalf`. `event.subscribe()` replays nothing, so narration published
        // before the subscription exists is narration nobody will ever see. A child fiber
        // rather than one in the map: it belongs to this run and is interrupted with it.
        const narrator = yield* Effect.forkChild(
          narrateSession(
            input.targetId,
            ids.attemptId,
            harnessSessionId,
            report,
          ),
        );

        const prompted = yield* Effect.result(
          harness.prompt(harnessSessionId, input.task),
        );
        if (prompted._tag === "Failure") {
          // Nothing ran. The attempt row exists and is `running`, so the honest thing is
          // to let the finalizer settle it rather than leaving it for a sweep — and
          // `startFailed` is what keeps that settlement out of the `interrupted` bucket,
          // because nobody interrupted anything.
          ending = { _tag: "startFailed" };
          yield* Deferred.fail(gate, refuse(prompted.failure));
          return;
        }

        // The request is let go here, and not before: everything above had to succeed for
        // the attempt to be a real, authorised, prompted run.
        yield* Deferred.succeed(gate, started);

        /**
         * The long poll the harness answers when the session stops running.
         *
         * This is what says the run is over, and the narration stream is what says what
         * happened along the way; the reasoning for using both is on
         * {@link narrateSession}. A failure here is **not** a failed attempt: it means our
         * request lost its answer, which says nothing about the harness, and it resolves
         * through `session.get` or to `uncertain` (DECISIONS.md §15). **The prompt is
         * never resubmitted**, on this path or any other.
         */
        const waited = yield* Effect.result(
          harness.waitForIdle(harnessSessionId),
        );
        ending =
          waited._tag === "Failure"
            ? { _tag: "waitFailed", detail: waited.failure.message }
            : { _tag: "waited" };

        // The session is no longer running, so there is nothing left to narrate. Stopping
        // the fiber here rather than leaving it to the scope means the socket is closed
        // before the settlement round trips, and `report.narrated` is final by the time
        // the finalizer reads it.
        yield* Fiber.interrupt(narrator);
      }),
    ).pipe(
      Effect.tapCause((cause) =>
        Effect.logError("a run supervisor ended abnormally", {
          attemptId: ids.attemptId,
          cause,
        }),
      ),
      // The gate is completed on every successful path above. This covers the one path
      // that is not: an interruption or a defect during the start half, where the request
      // would otherwise wait on a deferred nothing will ever complete. Completing an
      // already-completed deferred is a no-op that returns `false`, so this cannot
      // overwrite a real answer.
      Effect.ensuring(
        Deferred.fail(
          gate,
          new RunRefused({
            reason: "store_unavailable",
            detail:
              "the run was torn down before it started; nothing was prompted and the attempt, if a row was written, is left for the startup sweep to reconcile",
          }),
        ),
      ),
    );

  const start: RunSupervisor["Service"]["start"] = Effect.fn(
    "RunSupervisor.start",
  )(function* (input) {
    const ids = {
      goalId: identifier.newGoalId(),
      intentId: identifier.newIntentId(),
      attemptId: identifier.newAttemptId(),
      workerId: identifier.prefixed("wk"),
    };
    /**
     * The folder, claimed before anything else happens.
     *
     * First, and synchronously: the reasoning is on {@link claimedWorkspaces}. Refusing
     * here means a second concurrent run in one engagement's folder writes *nothing at
     * all* — no gate installed over the first run's, no attempt row, nothing for a sweep
     * to find.
     */
    const busy = yield* workspaceClaim(input.workspace, {
      attemptId: ids.attemptId,
      targetId: input.targetId,
    });
    if (busy !== undefined) return yield* busy;

    const gate = yield* Deferred.make<RunStarted, RunRefused>();
    // Forked, not run: this is the line that detaches the run from the request. The
    // fiber is a daemon of the layer's scope rather than a child of this fiber, so
    // writing the response below cannot interrupt it.
    const fiber = fork(ids.attemptId, supervise(input, ids, gate));
    /**
     * Wait for the gate, but never longer than the fiber lives.
     *
     * `supervise`'s own `ensuring` completes the gate on every path its body reaches, so
     * in normal operation the first branch wins immediately. The second exists for the
     * one path the body never reaches: a {@link FiberMap} whose scope has closed hands
     * back an already-interrupted fiber without running anything
     * (`effect/src/FiberMap.ts`, `constInterruptedFiber`), and a request waiting on that
     * gate would wait for the life of the process. Which is a shutting-down server
     * answering nothing instead of answering honestly.
     *
     * `Deferred.isDone` rather than letting the race decide, because the two branches can
     * become ready in the same tick when a run settles very fast: checking the gate means
     * a completed start is always reported as one, however the race lands.
     */
    return yield* Effect.raceFirst(
      Deferred.await(gate),
      Effect.andThen(
        Fiber.await(fiber),
        Effect.flatMap(Deferred.isDone(gate), (done) =>
          done
            ? Deferred.await(gate)
            : // The one path `supervise`'s body never reached, so its finalizer never ran
              // and the claim above is still held. Given back here, or a shutting-down
              // server would leave the folder claimed by a run that never started.
              Effect.andThen(
                releaseWorkspace(input.workspace, ids.attemptId),
                Effect.fail(
                  new RunRefused({
                    reason: "store_unavailable",
                    detail:
                      "this server is shutting down and is no longer starting runs; nothing was prompted",
                  }),
                ),
              ),
        ),
      ),
    );
  });

  const stop: RunSupervisor["Service"]["stop"] = Effect.fn(
    "RunSupervisor.stop",
  )(function* (attemptId) {
    const fiber = yield* FiberMap.get(fibers, attemptId);
    if (Option.isNone(fiber)) {
      return yield* new RunRefused({
        reason: "unknown_attempt",
        detail: `nothing is running under ${attemptId} in this process. If its row still says 'running' it was left by a process that is gone, and the startup sweep is what settles it.`,
      });
    }
    const held = supervised.get(attemptId);
    // Awaits the interruption, which awaits the finalizer, which settles the attempt and
    // revokes its authority. So by the time this returns, the two things a stop promises
    // have happened — rather than having been scheduled.
    yield* Fiber.interrupt(fiber.value);
    const settled = settlements.get(attemptId);
    return {
      attemptId,
      targetId: held?.targetId ?? "",
      harnessSessionId: held?.harnessSessionId ?? "",
      // Absent only if the finalizer could not settle, which it reports in the log. The
      // response says `uncertain` there rather than claiming a status, which is the same
      // answer the row would carry.
      status: settled?.status ?? "uncertain",
      credentialsRevoked: settled?.grants ?? 0,
      stoppedAt: Date.now(),
    } satisfies RunStopped;
  });

  return RunSupervisor.of({
    start,
    stop,
    running: Effect.sync(() =>
      // Projected rather than returned whole: `Supervised` carries the workspace, which is
      // this process's filesystem layout and not something a browser has any use for.
      [...supervised.values()].map((held): RunningAttempt => ({
        attemptId: held.attemptId,
        targetId: held.targetId,
        intentId: held.intentId,
        harnessSessionId: held.harnessSessionId,
        startedAt: held.startedAt,
      })),
    ),
  });
});
