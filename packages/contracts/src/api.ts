/**
 * The browser-facing HTTP API, declared once.
 *
 * This module is the *only* description of what the browser app may ask the server for.
 * The server implements it with `HttpApiBuilder` and the web app derives its client with
 * `HttpApiClient.make`, so a renamed endpoint, a changed payload or a new error member
 * is a compile error on both sides rather than a runtime 404. Writing the paths and the
 * JSON shapes twice — once in a route table and once in a `fetch` wrapper — is how the
 * two drift, and it is the single thing this file exists to prevent.
 *
 * **It describes admission, not just shape.** {@link SessionGuard} is declared here, so
 * "which endpoints need a session" is part of the contract the client is generated
 * from: the client cannot call a guarded endpoint without supplying a bearer, and the
 * server cannot serve one without implementing the guard.
 *
 * **It does not describe the three routes that were already there.** `/api/v1/health`,
 * `/api/v1/mcp` and `/api/v1/policy/decide` keep their own admission postures and their
 * own hand-written router registrations, for the reasons recorded on
 * `apps/server/src/http/controlPlane.ts`. They are served on the same listener as this
 * API and are deliberately not re-posted through it: `/api/v1/mcp` fails closed on an
 * MCP credential, and `/api/v1/policy/decide` is unauthenticated at the operator's
 * direction. Folding either into a group that carries {@link SessionGuard} would change
 * what they admit.
 *
 * **Browser-safe.** `effect/http-api` and `effect/http` contain no `node:` or `bun:`
 * imports at any depth (verified against `effect@4.0.5`'s sources), so declaring the API
 * here does not drag server code into the browser bundle. Every module under
 * `effect/http-api` is marked `@stability unstable`; the shapes used here were checked
 * against the installed types rather than against v3 examples.
 */
import { Context, Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSecurity,
} from "effect/http-api";

import { API_PREFIX, apiPath } from "./http";

/** Epoch milliseconds. `Schema.Finite` so NaN and Infinity are refused, not shipped. */
const EpochMillis = Schema.Finite.annotate({
  description: "Epoch milliseconds.",
});

/* ── Paths ───────────────────────────────────────────────────────────────────── */

/** Where a browser exchanges the server password for a session token. */
export const SESSION_PATH = apiPath("session");
/** The target registry, read and appended to. */
export const TARGETS_PATH = apiPath("targets");
/** The server-side folder picker. */
export const FOLDERS_PATH = apiPath("folders");

/* ── Session ─────────────────────────────────────────────────────────────────── */

/**
 * What a browser sends to open a session.
 *
 * The password is the one the server generated on its first boot and printed once. It
 * travels in a request body rather than a query string so it cannot land in an access
 * log, and the control plane's router is built with the request logger disabled.
 */
export const SessionRequest = Schema.Struct({
  password: Schema.String,
});
export type SessionRequest = typeof SessionRequest.Type;

/** A granted browser session. The token is a bearer for every guarded endpoint. */
export const SessionOpened = Schema.Struct({
  token: Schema.NonEmptyString,
  issuedAt: EpochMillis,
  expiresAt: EpochMillis,
});
export type SessionOpened = typeof SessionOpened.Type;

/**
 * A refused session, with the reason the Connect screen needs.
 *
 * The screen renders two different failures against two different fields: a refused
 * password belongs to the password field, and "no server answered" belongs to the URL
 * field. Only the first is a *response*, so only the first is modelled here — a server
 * that is not running cannot send a reason, and a client that invented one would be
 * guessing. The web app classifies a transport failure as unreachable itself, and that
 * division is the whole point of this being a typed refusal rather than a bare 401.
 *
 * `no_password_set` is a real fail-closed case rather than a theoretical one: if the
 * settings row is missing or unreadable the server refuses every password instead of
 * accepting any.
 */
export class SessionRefused extends Schema.TaggedError<SessionRefused>()(
  "SessionRefused",
  {
    reason: Schema.Literals(["invalid_password", "no_password_set"]),
    detail: Schema.String,
  },
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return `${this.reason}: ${this.detail}`;
  }
}

/**
 * A request that carried no usable session.
 *
 * `missing` and `expired` are distinguished because the UI treats them differently: a
 * missing token is a first visit and lands on Connect quietly, while an expired one is
 * the "your session ended" notice. `unknown` covers a token this process never issued,
 * which includes every token issued before a restart — browser sessions are held in
 * memory, deliberately, so that killing the server ends them.
 */
export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()(
  "Unauthenticated",
  {
    reason: Schema.Literals(["missing", "unknown", "expired"]),
  },
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return `no session: ${this.reason}`;
  }
}

/**
 * The session the guard resolved, provided to every guarded handler.
 *
 * A handler reads its identity from here rather than from a header, so an endpoint
 * cannot accidentally trust a value the client chose.
 */
export class SessionActor extends Context.Service<
  SessionActor,
  {
    readonly sessionId: string;
    readonly issuedAt: number;
    readonly expiresAt: number;
  }
>()("bit/api/SessionActor") {}

/**
 * The guard on every endpoint a browser session is required for.
 *
 * `requiredForClient` is `true`, so the generated client will not compile without a
 * client-side middleware that attaches the token. That is deliberate: forgetting the
 * bearer should be a type error, not a 401 discovered by clicking.
 *
 * **This is not the MCP bearer.** The two registries are separate services with separate
 * token spaces (`apps/server/src/http/browserSessions.ts` and
 * `apps/server/src/mcp/credentials.ts`), and neither resolver can see the other's map, so
 * an MCP credential cannot open a browser session and a session token cannot satisfy the
 * MCP route. One registry with a kind flag would make that a code review away from being
 * untrue.
 */
export class SessionGuard extends HttpApiMiddleware.Service<
  SessionGuard,
  {
    provides: SessionActor;
    requires: never;
  }
>()("bit/api/SessionGuard", {
  requiredForClient: true,
  security: { bearer: HttpApiSecurity.bearer },
  error: Unauthenticated,
}) {}

/**
 * What a reload needs to know to stay signed in.
 *
 * The probe exists so the web app can answer "is this stored token still good?" without
 * side effects and without guessing. It also hands back the two roots the New target
 * dialog needs, so the browser does not hardcode a path it cannot verify.
 */
export const SessionProbe = Schema.Struct({
  sessionId: Schema.String,
  issuedAt: EpochMillis,
  expiresAt: EpochMillis,
  /** The only directory the folder picker will look inside. */
  workspaceRoot: Schema.String,
  /** Where `control.sqlite` and every target's directory live. */
  fleetRoot: Schema.String,
});
export type SessionProbe = typeof SessionProbe.Type;

/* ── Targets ─────────────────────────────────────────────────────────────────── */

/**
 * Why a listed target cannot be opened.
 *
 * A target is listed whether or not it is available — a registry row whose directory is
 * gone is the only remaining record that the engagement happened, so it is never hidden.
 * The reason says which of the two independent things went wrong: the filesystem
 * (`*_missing`) or the schema (`schema_unavailable`, `never_migrated`).
 */
export const TargetUnavailableReason = Schema.Literals([
  /** `<fleet root>/targets/<id>/` is not there. */
  "folder_missing",
  /** The directory is there but `hunt.sqlite` is not. */
  "database_missing",
  /** The folder the operator picked for this engagement is not there. */
  "workspace_missing",
  /** The last fleet sweep could not migrate this target's file. */
  "schema_unavailable",
  /** No sweep has ever looked at this target in this installation. */
  "never_migrated",
]);
export type TargetUnavailableReason = typeof TargetUnavailableReason.Type;

/**
 * One row of the target rail.
 *
 * Everything here is answerable from the control tier plus a `stat`, and it stays that
 * way now that the per-target store resolver exists. Counting what one target holds means
 * opening that target's file; a list of N targets would open N databases to draw one
 * screen. So the rail opens nothing, and the counts arrive with {@link TargetView} when a
 * target is actually opened.
 */
export const TargetSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  scopeNote: Schema.String,
  /** The folder the operator picked, or `null` for a target registered without one. */
  workspacePath: Schema.NullOr(Schema.String),
  /** `<fleet root>/targets/<id>` — the directory `rm -rf` deletes. */
  dataDirectory: Schema.String,
  createdAt: EpochMillis,
  archivedAt: Schema.NullOr(EpochMillis),
  /**
   * When this target's own files were last written, from the filesystem.
   *
   * Not "when the agent last did something", which would need the event log. It is the
   * honest answer available without opening the target's database, and it falls back to
   * `createdAt` when nothing can be stat'd.
   */
  lastActivityAt: EpochMillis,
  available: Schema.Boolean,
  unavailableReason: Schema.NullOr(TargetUnavailableReason),
  /** Operator-facing prose: what the last sweep, or this check, found. */
  detail: Schema.String,
  /** The highest hunt-chain migration id that target's file holds. */
  appliedThrough: Schema.NullOr(Schema.Int),
});
export type TargetSummary = typeof TargetSummary.Type;

/**
 * How much one target's own database holds.
 *
 * These are the numbers the hunt view's header shows, and the first numbers in this
 * application that come from a target's own `hunt.sqlite` rather than from the registry.
 * Reading them means opening that file, which is why {@link TargetSummary} — one row per
 * target in a list of all of them — still has none of them: the rail answers from
 * `control.sqlite` plus a `stat` and opens nothing, and opening N databases to draw a
 * list would make the cheap screen the expensive one.
 *
 * **Every field is named after the table it counts.** The sidebar says "Hunts" and
 * "Findings"; the schema has `intents` and no findings table at all. Which stored thing
 * those labels name is a question the flow that designs those screens answers, and a
 * field called `findings` would have to be filled with something — so there isn't one. A
 * screen showing a number it cannot source is the one failure an operator cannot see
 * through.
 *
 * A snapshot, not a subscription: a running attempt may have added to the file between
 * this being read and being rendered.
 */
export const TargetCounts = Schema.Struct({
  goals: Schema.Int,
  intents: Schema.Int,
  attempts: Schema.Int,
  /** Attempts still `running` or `uncertain` — the only count here that can fall. */
  unsettledAttempts: Schema.Int,
  observations: Schema.Int,
  assets: Schema.Int,
  events: Schema.Int,
});
export type TargetCounts = typeof TargetCounts.Type;

/**
 * One opened target: the row the rail already had, plus what its own file holds.
 *
 * The summary is repeated rather than referenced so a deep link works on a cold start.
 * Opening `?target=<id>` in a fresh tab has no rail to read a name and a scope note out
 * of, and a header that waited for the list before it could render would show an empty
 * frame first. One request answers the whole header.
 */
export const TargetView = Schema.Struct({
  target: TargetSummary,
  counts: TargetCounts,
});
export type TargetView = typeof TargetView.Type;

/**
 * No target under that id.
 *
 * `invalid_target_id` is distinguished from `unknown_target` because they are different
 * facts: the first is a string that could never name a target — a target id becomes a
 * directory name, and the rule is on `persistence/fleet.ts` — and the second is a
 * well-formed id nothing is registered under. A deep link to a target that was never
 * created and a deep link someone truncated are different mistakes.
 */
export class TargetNotFound extends Schema.TaggedError<TargetNotFound>()(
  "TargetNotFound",
  {
    reason: Schema.Literals(["unknown_target", "invalid_target_id"]),
    targetId: Schema.String,
    detail: Schema.String,
  },
  { httpApiStatus: 404 },
) {
  override get message(): string {
    return `${this.reason} (${this.targetId}): ${this.detail}`;
  }
}

/**
 * The target is registered, and it will not open.
 *
 * This is the partial-failure policy of `persistence/fleet.ts` arriving at the HTTP
 * surface: a target whose directory is gone, whose database is missing or whose schema
 * did not migrate is refused **by name, on its own route**, while every other target
 * keeps being served from the same listener. One unreadable file is one failed request,
 * never a failed process.
 *
 * `reason` is {@link TargetUnavailableReason}, the same vocabulary the rail dims a row
 * with, and `detail` is the same sentence. That is deliberate: the list and this route
 * cannot disagree about why a target cannot be opened, because they are reading the same
 * check.
 *
 * `409` rather than `404` — the row exists — and rather than `503`, which is about the
 * server rather than about one of the things it holds. It is a conflict between what the
 * registry records and what is on disk, and it is the operator's to resolve: put the
 * folder back, or restart so the next sweep re-migrates the file.
 */
export class TargetUnavailable extends Schema.TaggedError<TargetUnavailable>()(
  "TargetUnavailable",
  {
    reason: TargetUnavailableReason,
    targetId: Schema.String,
    detail: Schema.String,
  },
  { httpApiStatus: 409 },
) {
  override get message(): string {
    return `${this.reason} (${this.targetId}): ${this.detail}`;
  }
}

/** What the New target dialog submits. */
export const TargetDraft = Schema.Struct({
  /** A folder inside the configured workspace root. */
  workspacePath: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  /** Advisory prose about what is in scope. Never enforcement. */
  scopeNote: Schema.String,
});
export type TargetDraft = typeof TargetDraft.Type;

/**
 * A refused registration.
 *
 * `targetId` carries the id involved so the dialog can offer to open the target that
 * already holds the folder, which is the state the design brief calls "Already a
 * target". A duplicate is refused rather than adopted, because an id is a directory
 * full of somebody's evidence.
 */
export class TargetRefused extends Schema.TaggedError<TargetRefused>()(
  "TargetRefused",
  {
    reason: Schema.Literals([
      "duplicate_target",
      "duplicate_workspace",
      "invalid_name",
    ]),
    /** The id that was refused, or the id already holding that folder. */
    targetId: Schema.String,
    detail: Schema.String,
  },
  { httpApiStatus: 409 },
) {
  override get message(): string {
    return `${this.reason} (${this.targetId}): ${this.detail}`;
  }
}

/* ── Runs ────────────────────────────────────────────────────────────────────── */

/** Where a browser starts a run against one target, and lists what is running. */
export const RUNS_PATH = apiPath("runs");

/**
 * What the compose box submits.
 *
 * One field, and the shortfall is deliberate. A run needs a goal, an intent's question
 * and a prompt; today all three come from the one thing the operator typed, and the server
 * mints the goal, intent and attempt ids for it. Letting the browser choose which existing
 * intent a run belongs to is Flow B's work — it is the screen that shows intents in the
 * first place — and a `intentId` field here would be a contract the UI could not yet fill
 * honestly.
 *
 * Which model runs it is deliberately absent too: this server pins one, and a picker is
 * two slices away. A field the server ignored would be worse than no field.
 */
export const RunDraft = Schema.Struct({
  /** What the operator wants done. Becomes the prompt verbatim. */
  instruction: Schema.NonEmptyString,
});
export type RunDraft = typeof RunDraft.Type;

/**
 * A started run, answered before the run is anywhere near finished.
 *
 * This is the whole point of the endpoint: the response says "it is running and here is
 * its name", not "here is what it found". Everything in it is already durable by the time
 * it is sent — the attempt row exists, the harness session exists and has been prompted —
 * so an operator who reloads immediately can find the run by this `attemptId`.
 */
export const RunStarted = Schema.Struct({
  attemptId: Schema.String,
  targetId: Schema.String,
  intentId: Schema.String,
  goalId: Schema.String,
  /** The harness's own session id, which is also what observations record as provenance. */
  harnessSessionId: Schema.String,
  providerId: Schema.String,
  modelId: Schema.String,
  startedAt: EpochMillis,
});
export type RunStarted = typeof RunStarted.Type;

/**
 * One run this server is supervising right now.
 *
 * **Per process, not per database.** This is read from the supervisor's own fiber map, so
 * it answers "what is this server driving" — which is a different question from "which
 * attempt rows say `running`". A row left `running` by a process that died is not here,
 * because nothing is running it; the startup sweep is what settles those.
 */
export const RunningAttempt = Schema.Struct({
  attemptId: Schema.String,
  targetId: Schema.String,
  intentId: Schema.String,
  harnessSessionId: Schema.String,
  startedAt: EpochMillis,
});
export type RunningAttempt = typeof RunningAttempt.Type;

/**
 * A stopped run, with what stopping it actually did.
 *
 * `status` and `credentialsRevoked` are reported rather than assumed because a stop makes
 * two promises beyond "the fiber is gone": the attempt is settled, and its write authority
 * is withdrawn. An operator — and a test — can read both here instead of taking them on
 * trust.
 */
export const RunStopped = Schema.Struct({
  attemptId: Schema.String,
  targetId: Schema.String,
  harnessSessionId: Schema.String,
  /** What the attempt row holds now. `uncertain` when settling could not be confirmed. */
  status: Schema.String,
  /** Live MCP grants dropped for this attempt. Zero is normal on a second stop. */
  credentialsRevoked: Schema.Int,
  stoppedAt: EpochMillis,
});
export type RunStopped = typeof RunStopped.Type;

/**
 * A run this server will not start or stop.
 *
 * One error with five reasons rather than five errors, because the browser does one thing
 * with all of them — shows the sentence next to the compose box — and the reasons differ
 * only in what an operator does next:
 *
 * - `no_harness` — this server has no `opencode` to run a worker in. It still serves
 *   everything else, which is why this is a refused request rather than a server that
 *   would not boot.
 * - `target_unavailable` — that target's own database could not be opened. The same
 *   condition {@link TargetUnavailable} describes, reached from the write side.
 * - `workspace_ungated` — the pre-execution policy gate could not be installed into the
 *   engagement's folder, usually because it already holds an `opencode.json` this server
 *   will not overwrite. The run is refused rather than started ungated: a worker running
 *   against somebody's systems with no record of what it was allowed to do is worse than
 *   a run that did not start.
 * - `harness_unreachable` — the harness did not answer while the run was being set up.
 *   Nothing was prompted; if an attempt row was written it is left for the startup sweep.
 * - `store_unavailable` — the target's database could not be written to.
 * - `unknown_attempt` — nothing is running under that id *in this process*.
 *
 * `409` for all five. Each has a defensible status of its own — `503` for `no_harness`,
 * `404` for `unknown_attempt` — and a tagged error carries one, so the choice is between
 * five error types the client must handle separately and one status that is honest for
 * every case: the server is not in a state to do what was asked. The reason is in the
 * body, typed, which is what the client branches on.
 */
export class RunRefused extends Schema.TaggedError<RunRefused>()(
  "RunRefused",
  {
    reason: Schema.Literals([
      "no_harness",
      "target_unavailable",
      "workspace_ungated",
      "harness_unreachable",
      "store_unavailable",
      "unknown_attempt",
    ]),
    detail: Schema.String,
  },
  { httpApiStatus: 409 },
) {
  override get message(): string {
    return `${this.reason}: ${this.detail}`;
  }
}

/* ── Folders ─────────────────────────────────────────────────────────────────── */

export const FolderEntry = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
});
export type FolderEntry = typeof FolderEntry.Type;

/** One directory's immediate subdirectories, with the root that bounds the picker. */
export const FolderListing = Schema.Struct({
  /** The configured root. Nothing above this is reachable. */
  root: Schema.String,
  path: Schema.String,
  /** `null` at the root, so the picker cannot offer a way out of it. */
  parent: Schema.NullOr(Schema.String),
  entries: Schema.Array(FolderEntry),
});
export type FolderListing = typeof FolderListing.Type;

/**
 * A path the server will not look at.
 *
 * This endpoint hands a browser a view of the filesystem, so every refusal is explicit
 * and each one names which rule it broke. `traversal` and `symlink` are separate from
 * `outside_root` on purpose: a `..` segment and a symlink out of the root are refused
 * *before* resolution and *after* resolution respectively, and knowing which check fired
 * is the difference between a bug in the picker and an attempt to leave the root.
 */
export class PathRefused extends Schema.TaggedError<PathRefused>()(
  "PathRefused",
  {
    reason: Schema.Literals([
      /** Not an absolute path. */
      "not_absolute",
      /** Contains a `.` or `..` segment. Refused as written, never normalised. */
      "traversal",
      /** Resolves, through a link, to somewhere other than where it is written. */
      "symlink",
      /** Resolves outside the configured root. */
      "outside_root",
      /** The server has no permission to read it. */
      "denied",
    ]),
    path: Schema.String,
    detail: Schema.String,
  },
  { httpApiStatus: 403 },
) {
  override get message(): string {
    return `${this.reason} (${this.path}): ${this.detail}`;
  }
}

/** A path inside the root that is not a directory we can list. */
export class PathNotFound extends Schema.TaggedError<PathNotFound>()(
  "PathNotFound",
  {
    reason: Schema.Literals(["not_found", "not_a_directory"]),
    path: Schema.String,
    detail: Schema.String,
  },
  { httpApiStatus: 404 },
) {
  override get message(): string {
    return `${this.reason} (${this.path}): ${this.detail}`;
  }
}

/* ── Groups ──────────────────────────────────────────────────────────────────── */

/**
 * The one unguarded group: exchanging a password for a token.
 *
 * It is its own group rather than an unguarded endpoint inside the guarded one, because
 * `HttpApiGroup.middleware` applies to the endpoints added *before* it and nothing in the
 * type system would stop a later edit from adding an endpoint on the wrong side of that
 * line. Two groups make the boundary structural.
 */
export class SessionApiGroup extends HttpApiGroup.make("session").add(
  HttpApiEndpoint.post("open", "/session", {
    payload: SessionRequest,
    success: SessionOpened,
    error: SessionRefused,
  }),
) {}

/** Everything a signed-in browser may ask for. Guarded as a whole. */
export class FleetApiGroup extends HttpApiGroup.make("fleet")
  .add(
    HttpApiEndpoint.get("probe", "/session", {
      success: SessionProbe,
    }),
    HttpApiEndpoint.get("targets", "/targets", {
      success: Schema.Array(TargetSummary),
    }),
    /**
     * One target, with what its own database holds.
     *
     * The id is a path parameter rather than a query one because it identifies the
     * resource rather than filtering it, and because that is the URL a deep link to a
     * target is built from. `params` is where `effect/http-api` declares a path
     * parameter's schema (`HttpApiEndpoint.make`'s options in `effect@4.0.5`), and the
     * generated client takes it as `{ params: { targetId } }` — so a caller cannot build
     * this URL by string concatenation and cannot omit the id.
     *
     * It is in the guarded group with everything else: opening a target reads an
     * engagement's recorded evidence, which is the last thing that should answer without
     * a session.
     */
    HttpApiEndpoint.get("target", "/targets/:targetId", {
      params: { targetId: Schema.String },
      success: TargetView,
      error: [TargetNotFound, TargetUnavailable],
    }),
    HttpApiEndpoint.post("createTarget", "/targets", {
      payload: TargetDraft,
      success: TargetSummary,
      error: [TargetRefused, PathRefused, PathNotFound],
    }),
    HttpApiEndpoint.get("folders", "/folders", {
      query: { path: Schema.optional(Schema.String) },
      success: FolderListing,
      error: [PathRefused, PathNotFound],
    }),
    /**
     * Starts a run against one target, and answers immediately.
     *
     * **The response must not wait for the run**, which is the property this endpoint
     * exists to have. A run takes minutes or hours; the request returns as soon as the
     * attempt row, the harness session, the credential and the prompt are all in place,
     * and a supervisor fiber in the server's own scope owns everything after that.
     *
     * The target is a path parameter for the same reason as `target` above: it identifies
     * the resource the run writes to, and it is the id the write boundary dispatches on.
     * `TargetNotFound` and `TargetUnavailable` are the same refusals opening the target
     * gives, from the same checks, so the compose box cannot disagree with the rail about
     * whether a target can be worked on.
     */
    HttpApiEndpoint.post("startRun", "/targets/:targetId/runs", {
      params: { targetId: Schema.String },
      payload: RunDraft,
      success: RunStarted,
      error: [RunRefused, TargetNotFound, TargetUnavailable],
    }),
    /**
     * Stops one run: interrupts it, settles its attempt, revokes its authority.
     *
     * A `POST` to a sub-resource rather than a `DELETE` on the run, because it does not
     * remove anything — the attempt row and everything the run recorded stay, settled.
     * Deleting evidence is not a thing this API does.
     */
    HttpApiEndpoint.post("stopRun", "/targets/:targetId/runs/:attemptId/stop", {
      params: { targetId: Schema.String, attemptId: Schema.String },
      success: RunStopped,
      error: [RunRefused],
    }),
    /**
     * Every run this server is supervising, across all targets.
     *
     * Not under `/targets/:id` because it is a fact about the *process*: the supervisor
     * holds one fiber map for the whole server, and a browser showing two open targets
     * wants both answered in one request rather than one per tab. A client that wants one
     * target's runs filters by `targetId`.
     *
     * It is what lets a reloaded tab find the run it started: the start response is the
     * only other place an `attemptId` appears, and a browser that lost it would otherwise
     * have no way back to a run that is still going.
     */
    HttpApiEndpoint.get("runs", "/runs", {
      success: Schema.Array(RunningAttempt),
    }),
  )
  .middleware(SessionGuard) {}

/**
 * The browser-facing API, under the one served version prefix.
 *
 * `prefix` is applied to the whole API rather than written into each path so
 * {@link API_PREFIX} stays the single answer to "where do our endpoints live", shared
 * with the three hand-registered routes through `apiPath`.
 */
export class BitApi extends HttpApi.make("bit")
  .add(SessionApiGroup, FleetApiGroup)
  .prefix(API_PREFIX) {}
