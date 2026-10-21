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
 * Everything here is answerable from the control tier plus a `stat`, which is why no
 * field counts hunts or findings: those live in the target's own `hunt.sqlite`, opening
 * one per request needs the per-target store resolver, and that is a later day's work.
 * A field that would have to lie until then is better absent.
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
