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
  HttpApiSchema,
  HttpApiSecurity,
} from "effect/http-api";

import { AgentsView } from "./agents";
import {
  ConversationModelDraft,
  ConversationModelRefused,
  ConversationModelSwitched,
} from "./conversationModel";
import { AssetView } from "./asset";
import { ScopeEntryDraft, ScopeLabelDraft, ScopeView } from "./scope";
import { GoalDraft, GoalEndDraft, GoalView } from "./goal";
import {
  GoalConversationRefused,
  GoalConversationView,
  GoalMessageDraft,
  GoalTurnAccepted,
} from "./goalAgent";
import {
  GoalUploadDraft,
  GoalUploadRefused,
  GoalUploadsAccepted,
} from "./goalUpload";
import {
  GoalObservationView,
  IntentAbandonDraft,
  IntentDraft,
  IntentView,
} from "./intent";
import { API_PREFIX, apiPath } from "./http";
import {
  GoalNarrationView,
  PlanRefused,
  PlanRoundStarted,
  PlanRoundView,
  RoundNotFound,
  RunningRound,
} from "./plan";
import { AgentSessionsView } from "./agentSessions";
import { LiveFrame } from "./live";
import { HarnessModelView, ModelOptionSelection } from "./modelOption";
import {
  ImporterConversationRefused,
  ImporterConversationView,
  ImporterMessageDraft,
  ImporterModelView,
  ImporterSessionsView,
  ImporterTurnAccepted,
  ProgramLink,
  ScopeImportView,
} from "./scopeImport";

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
/** Which agent harnesses this server configures, and what each will run. */
export const HARNESSES_PATH = apiPath("harnesses");
/** Which model the scope importer will run on, resolved against the live catalogue. */
export const IMPORTER_MODEL_PATH = apiPath("importer-model");
/** The agents a conversation can run as: the registry, as a chip lists it. */
export const AGENTS_PATH = apiPath("agents");

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
 * Opening `/t/<id>` in a fresh tab has no rail to read a name and a scope note out of, and
 * a header that waited for the list before it could render would show an empty frame
 * first. One request answers the whole header.
 */
export const TargetView = Schema.Struct({
  target: TargetSummary,
  counts: TargetCounts,
  /**
   * Up to 20 latest persisted reconciliation outcomes whose status is still current.
   * A normal settlement after a `still_running` sweep removes that stale notice. This
   * is not the full recovery audit history, which remains in the target database.
   */
  recoveries: Schema.Array(
    Schema.Struct({
      attemptId: Schema.String,
      status: Schema.String,
      disposition: Schema.String,
      observedStatus: Schema.String,
      detail: Schema.String,
      reconciledAt: EpochMillis,
    }),
  ),
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

/**
 * Which harness and model an import runs on, when the operator picked one (D15).
 *
 * **{@link RunDraft}'s instance, model and options fields, spelled the same way and meaning
 * the same things**, rather than a new shape: the picker on the create-target screen is the
 * picker in the composer, and a second vocabulary for "which model" would be a second
 * resolution path. All are optional and so is the whole struct, so a draft that says nothing about
 * the model gets D15's rule applied to the live catalogue — which is the common case,
 * because the screen preselects what that rule already answered.
 *
 * **`modelOptions` is `RunDraft`'s too, and means the same thing.** The importer is a
 * conversation now (S2), so reasoning depth on it is a control for something: the session
 * reads the program's pages and then takes the operator's follow-ups, and a second turn on
 * a hard page is where thinking harder pays. The same {@link ModelOptionSelection}s, the
 * same resolution rules in `modelOption.ts`, and the same load-bearing absence: a
 * selection is here only if the operator *set* it, so an empty list would claim an opinion
 * and stop the harness applying its own default. Options the resolved model does not offer
 * are dropped on arrival, as a run's are.
 */
export const ImportModelDraft = Schema.Struct({
  instanceId: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  modelOptions: Schema.optional(Schema.Array(ModelOptionSelection)),
});
export type ImportModelDraft = typeof ImportModelDraft.Type;

/** What the New target screen submits. */
export const TargetDraft = Schema.Struct({
  /** A folder inside the configured workspace root. */
  workspacePath: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  /**
   * A note for people, not for the agent.
   *
   * Still `scope_note` in the registry and still the target card's human description. It
   * stopped being presented as something machine-readable when the structured scope
   * landed, and the field that replaced its old job is {@link programLinks} below.
   */
  scopeNote: Schema.String,
  /**
   * The program's own pages, for the scope importer to read (D13).
   *
   * **Empty is the normal case and is not a degraded one.** A target with no program page
   * is still one click: the links are optional, the primary button never renames, and a
   * target created with none is identical to one whose every link yielded nothing — both
   * have no scope yet and the Assets screen says what that means.
   *
   * **Not bounded here, and the ceiling is applied rather than enforced.** One session
   * reads all of them (D15), so they share one context window and there has to be a limit
   * — but a draft carrying nine links is accepted and the first `SCOPE_IMPORT_MAX_LINKS`
   * are read, with the rest reported on `ScopeImportView.droppedLinks` and shown on the
   * panel. An operator who pasted nine pages wants the first eight read far more than they
   * want the creation refused for a bound they cannot see from the form.
   *
   * Each link is a {@link ProgramLink}: an absolute `http` or `https` URL, checked on the
   * server rather than trusted from the browser's `type="url"`, because
   * `importerPrompt.ts` interpolates these into the prompt and says of itself that
   * everything in it is this application's own words or a URL the operator typed.
   *
   * **Optional, and absent means the same as empty**, which is the opposite of how
   * {@link RunDraft}'s `modelOptions` treats the distinction. There the difference is
   * load-bearing: an empty list of options would claim an opinion where there is none and
   * would stop a model applying its own default. Here there is no third thing an absent
   * list could mean — no links and zero links are both "import nothing" — so demanding the
   * field would be demanding that every caller say "nothing" out loud.
   */
  programLinks: Schema.optional(Schema.Array(ProgramLink)),
  /**
   * Which model the importer runs on, when the operator chose.
   *
   * Absent means "resolve the default against the live catalogue", which is what the
   * screen sends when the operator leaves the picker alone. It is meaningless without
   * {@link programLinks}: no links means no importer, and a model choice with no agent to
   * run is a control for nothing — so a draft carrying one and no links is accepted and the
   * choice is simply never used, rather than refused for a contradiction the operator
   * cannot see.
   */
  importModel: Schema.optional(ImportModelDraft),
});
export type TargetDraft = typeof TargetDraft.Type;

/**
 * A registered target, and the import that was started alongside it.
 *
 * **A wrapper rather than two more fields on {@link TargetSummary}**, because that struct
 * is one row of the target list and an `importId` on every row would be a field that is
 * null for every target but the one just created. Creation is the only moment an import
 * handle exists, so it belongs on creation's own answer.
 *
 * {@link scopeImport} being null is not a failure. It is what "no program links" looks
 * like, and per D15 it is also what "links were given and this server has no harness to
 * read them with" looks like — in which case {@link importDetail} says so and the operator
 * lands on a target that is created, registered and entirely usable with no scope.
 */
export const TargetCreated = Schema.Struct({
  target: TargetSummary,
  /** The import to watch, when one started. */
  scopeImport: Schema.NullOr(
    Schema.Struct({
      importId: Schema.String,
      /** As resolved, never as asked: the picker's choice may have been a dead instance. */
      harnessInstanceId: Schema.String,
      model: Schema.String,
    }),
  ),
  /**
   * Why no import is running, when links were given and one could not start.
   *
   * Null when {@link scopeImport} is set, and null when no links were given — there is
   * nothing to explain about an import nobody asked for.
   */
  importDetail: Schema.NullOr(Schema.String),
});
export type TargetCreated = typeof TargetCreated.Type;

/**
 * What the Auto-load page submits: the program's pages for one import on a target that
 * already exists.
 *
 * The same two fields {@link TargetDraft} carries for the same job, and the same rules —
 * each link an absolute `http` or `https` URL checked on the server, the model absent unless
 * the operator overrode it. This is the only way to start an import: the create-target
 * screen no longer sends them, and a target is created from a folder, a name and a note.
 */
export const ScopeImportDraft = Schema.Struct({
  programLinks: Schema.Array(ProgramLink),
  importModel: Schema.optional(ImportModelDraft),
});
export type ScopeImportDraft = typeof ScopeImportDraft.Type;

/**
 * The import that started against an existing target, or why none did.
 *
 * The same two fields {@link TargetCreated} answers with, for the same reason: a refusal to
 * *start* an import (no harness, a picked instance that is not ready, no links) is a value
 * the page can print beside the form rather than an error that unmounts it. The target is
 * untouched either way.
 */
export const ScopeImportStartResult = Schema.Struct({
  scopeImport: TargetCreated.fields.scopeImport,
  importDetail: TargetCreated.fields.importDetail,
});
export type ScopeImportStartResult = typeof ScopeImportStartResult.Type;

/**
 * What the Auto-load page's composer sends to open a conversation with the importer.
 *
 * The operator's first message, and the model pick exactly as {@link ScopeImportDraft}
 * carries it — absent unless the operator overrode something, so the server applies D15's
 * rule to the catalogue it observed. **No links**: a conversation opened here may have
 * none, and a page the operator wants read is one they type into the message, where the
 * server finds it (the importer conversation design, S3.4).
 */
export const ImporterConversationDraft = Schema.Struct({
  text: ImporterMessageDraft.fields.text,
  importModel: Schema.optional(ImportModelDraft),
});
export type ImporterConversationDraft = typeof ImporterConversationDraft.Type;

/**
 * A scope import this server cannot show.
 *
 * In-process and not a row, which is what makes `unknown_import` the common reason rather
 * than an exotic one: the importer's progress lives in this process's memory for the life
 * of the import, so a restart forgets it. That is deliberate — what the import *wrote* is
 * durable in `scope_entries` and `asset_imports`, and the panel is a receipt for a write
 * that has already landed rather than the record of it. An operator who reloads onto a
 * forgotten import is sent to Assets, where the entries are.
 */
export class ScopeImportNotFound extends Schema.TaggedError<ScopeImportNotFound>()(
  "ScopeImportNotFound",
  {
    reason: Schema.Literals(["unknown_import", "invalid_target_id"]),
    importId: Schema.String,
    detail: Schema.String,
  },
  { httpApiStatus: 404 },
) {
  override get message(): string {
    return `${this.reason} (${this.importId}): ${this.detail}`;
  }
}

/**
 * No model this server can run an import on.
 *
 * Reached when no harness came up at all, so there is no catalogue to resolve D15's rule
 * against. Reported rather than answered with a guess: a model id this server invented
 * would be a control that offers the operator a choice the server cannot honour, and the
 * create-target screen's checkbox is better disabled than lying.
 */
export class ImporterModelUnavailable extends Schema.TaggedError<ImporterModelUnavailable>()(
  "ImporterModelUnavailable",
  {
    reason: Schema.Literals(["no_harness"]),
    detail: Schema.String,
  },
  { httpApiStatus: 409 },
) {
  override get message(): string {
    return `${this.reason}: ${this.detail}`;
  }
}

/**
 * A refused registration.
 *
 * `targetId` carries the id involved so the dialog can offer to open the target that
 * already holds the folder, which is the state the design brief calls "Already a
 * target". A duplicate is refused rather than adopted, because an id is a directory
 * full of somebody's evidence.
 *
 * `workspace_contains_fleet_root` is the one reason here that is about the *layout*
 * rather than about the registry, and it is a refusal at creation because the
 * alternative is a target that cannot do anything. Every non-worker session on a target
 * — planner round, goal agent, scope importer — runs in a directory under this server's
 * fleet root, and the policy gate refuses to install into a directory inside the folder
 * where that target's workers run. So a workspace folder that *contains* the fleet root
 * is a target whose first planner round, first conversation and first import are all
 * refused for the same reason, discovered one at a time. `targetId` is the id that would
 * have been registered: there is nothing to open instead.
 */
export class TargetRefused extends Schema.TaggedError<TargetRefused>()(
  "TargetRefused",
  {
    reason: Schema.Literals([
      "duplicate_target",
      "duplicate_workspace",
      "invalid_name",
      "workspace_contains_fleet_root",
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
 * What the run control submits: which existing intent to run, and optionally how.
 *
 * **A run claims an intent that already exists; it does not mint one.** Until the goal
 * lifecycle, one typed instruction became a goal, an intent and an attempt all at once, and
 * that 1:1:1 minting is exactly what this contract no longer does. The prompt the worker
 * receives is the intent's own `question`, so there is no free text here to disagree with
 * it. An intent is added under a goal first ({@link IntentDraft}); starting a run is
 * choosing one.
 *
 * The server refuses, naming the reason ({@link RunRefused}), an intent that does not
 * exist, belongs to another target, is not `open` (naming the attempt holding it, when
 * that is why), or whose goal has ended.
 *
 * Which agent runs it is still the operator's to say, and both fields below are optional
 * and mean the same thing when absent: "whatever this server would pick" — except that an
 * intent may now carry a *suggestion*. The order is the operator's explicit pick, then the
 * intent's suggestion, then the server's default. The server's default is the first ready
 * instance in its own configuration order and that instance's default model, and the
 * response says which it actually used, so a client that sends neither still gets
 * provenance back.
 */
export const RunDraft = Schema.Struct({
  /** The intent to run. It must be `open`, in this target, under an active goal. */
  intentId: Schema.NonEmptyString,
  /**
   * Which configured harness to run on. Absent means the intent's suggestion, then the
   * server's default.
   *
   * The id from {@link HarnessInstanceView}, never a driver slug: a driver names an
   * implementation and an instance names a configuration of one, and only the second is
   * something a run can be pinned to. An id this server does not configure, or one whose
   * harness did not come up, is refused `harness_not_ready` — never silently swapped for a
   * working one, because an attempt records which instance ran it and a quiet substitution
   * would make that record a lie. **This applies to an explicit pick only**: a dead
   * *suggestion* on the intent falls back to the default and the response says so
   * ({@link RunStarted.instanceFallback}).
   */
  instanceId: Schema.optional(Schema.String),
  /**
   * Which model, inside that instance. Absent means the instance's default.
   *
   * Meaningful only against an instance: `gpt-5.6-sol` is a name OpenCode's catalogue
   * gives and `claude-sonnet-5` is one Claude Code's does, and neither resolves without
   * knowing which harness was asked. Not validated against the instance's listed models —
   * that list is what the picker *offers*, and whether a model can run is the harness's
   * answer to give.
   */
  model: Schema.optional(Schema.String),
  /**
   * What was chosen *of* that model: reasoning depth, and whatever else a model offers.
   *
   * Each entry names an option by the harness's own id — `variant` on OpenCode, `effort`
   * on Claude Code — and carries one value. `@bit/contracts`'s `modelOption.ts` holds the
   * shapes and the resolution rules, and both this field's producer and its consumer use
   * them, so a browser cannot normalise a value differently from the server that runs it.
   *
   * **Absent rather than `[]` when nothing was chosen**, and that distinction is
   * load-bearing: a selection is only here if an operator *set* it, so an empty list would
   * claim an opinion where there is none and would stop a model from applying its own
   * default. Options the named model does not offer are dropped on arrival rather than
   * refused — a browser holding a stale catalogue is the expected case, not a client
   * error — and a value outside a descriptor's choices falls back to that descriptor's
   * default.
   */
  modelOptions: Schema.optional(Schema.Array(ModelOptionSelection)),
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
  /**
   * Which configured harness ran it — one account or configuration of one agent harness.
   *
   * The identity everything routes by, and what the attempt row is pinned to: changing
   * harness is a new attempt, not a retarget. The *driver* (`opencode`, `claude-code`) is
   * deliberately not here and is not stored either; it is derived from this id against the
   * server's current configuration, so a reconfigured instance cannot leave two copies of
   * the same fact disagreeing.
   *
   * A stock single-account installation reports the driver's own slug here, which is why
   * this reads as `opencode` or `claude-code` today.
   */
  instanceId: Schema.String,
  /**
   * The *model's* provider and the model, inside that instance.
   *
   * Not the harness: OpenCode can route Anthropic models too, so `anthropic` here does not
   * mean Claude Code ran it. `instanceId` is the field that says which harness did.
   */
  providerId: Schema.String,
  modelId: Schema.String,
  startedAt: EpochMillis,
  /**
   * Non-null only when the intent *suggested* an instance this server could not give it.
   *
   * The run went ahead on the server's default and this says what was wanted and why it was
   * not honoured, so the substitution is visible rather than silent. Null in every other
   * case, including an intent with no suggestion: it is an account of a suggestion that
   * failed, never a restatement of a choice that worked. An operator's explicit
   * `instanceId` never produces it — that is refused `harness_not_ready` instead, because
   * running somewhere the operator did not pick is not something to report after the fact.
   */
  instanceFallback: Schema.NullOr(
    Schema.Struct({
      /** The instance id the intent suggested. */
      requested: Schema.String,
      /** Why it could not be used, in the resolver's own sentence. */
      reason: Schema.String,
    }),
  ),
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
 * One error with several reasons rather than one error type each, because the browser does one thing
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
 * - `harness_not_ready` — the instance the run named is not configured on this server, or
 *   is configured and would not start. Nothing at all was written: not a folder claim, not
 *   a row. The operator picks a different harness, or installs the one they picked.
 * - `harness_unreachable` — the harness did not answer while the run was being set up.
 *   Nothing was prompted; if an attempt row was written it is left for the startup sweep.
 * - `store_unavailable` — the target's database could not be written to.
 * - `unknown_attempt` — nothing is running under that id *in this process*.
 * - `intent_not_found`, `intent_wrong_target`, `intent_not_open`, `goal_not_active` — the
 *   intent a run named cannot be claimed, each for the reason it says. The store established
 *   each from the row; none is inferred. Nothing was written and the intent is left as it
 *   was.
 *
 * `409` for all of them. Each has a defensible status of its own — `503` for `no_harness`,
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
      /**
       * Another run is already going in this engagement's folder.
       *
       * **Refused rather than queued, and refused rather than permitted**, because two
       * workers in one directory can misattribute each other's writes. Both harnesses
       * configure their pre-execution gate *per workspace*, so a second run's gate
       * installation repoints the first run's audit at a different target's file; and
       * OpenCode registers an MCP server per *directory*, so each worker would see the
       * other's `bit-<attemptId>` server and a call through the wrong one would record an
       * observation under an attempt that never made it. Provenance is the thing this
       * system exists to get right, so a path that can silently misattribute a write is
       * worse than one that refuses.
       *
       * Two workers cooperating on one engagement is later work. Until the gate and the
       * MCP registration are per attempt, this is the honest answer.
       */
      "workspace_busy",
      /**
       * The harness instance this run named is not one this server can give it.
       *
       * Kept apart from `harness_unreachable` because **nothing was asked**. That one
       * means a harness was there and did not answer while a run was being set up; this
       * one means the instance is not configured here at all, or is configured and did not
       * come up — a fact about this server's configuration, with a different fix. The
       * detail names the instance and lists the ones this server is driving.
       *
       * Never a fallback onto a working harness. An attempt records the instance that ran
       * it, and quietly substituting another would make that record wrong.
       */
      "harness_not_ready",
      "harness_unreachable",
      "store_unavailable",
      "unknown_attempt",
      /** Nothing is stored under that intent id. Nothing was claimed or written. */
      "intent_not_found",
      /** The intent exists in a different target. A run cannot cross targets. */
      "intent_wrong_target",
      /**
       * The intent is not `open`: it is claimed (the detail names the attempt holding it),
       * answered, abandoned or only proposed. This is also what a second tab gets when it
       * runs an intent the first already started.
       */
      "intent_not_open",
      /**
       * The intent's goal has ended. Ending a goal blocks new dispatch under it, though it
       * does not interrupt a run already going; the detail names the goal's status.
       */
      "goal_not_active",
    ]),
    detail: Schema.String,
  },
  { httpApiStatus: 409 },
) {
  override get message(): string {
    return `${this.reason}: ${this.detail}`;
  }
}

/* ── Goals ───────────────────────────────────────────────────────────────────── */

/**
 * No goal under that id in this target.
 *
 * One refusal for the two ways a goal can fail to be there, because to a browser they are
 * the same answer: the id names nothing *in the target it asked about*. A goal that exists
 * in another target's file is not found here — a goal id is a handle into one target's
 * evidence, and a request that crossed targets has been built from the wrong pieces, not
 * from a goal the operator should be told about.
 *
 * `404`, with the sentence the store or the handler produced in `detail`.
 */
export class GoalNotFound extends Schema.TaggedError<GoalNotFound>()(
  "GoalNotFound",
  { targetId: Schema.String, goalId: Schema.String, detail: Schema.String },
  { httpApiStatus: 404 },
) {
  override get message(): string {
    return `no goal '${this.goalId}' in target '${this.targetId}': ${this.detail}`;
  }
}

/**
 * A goal change the server will not make.
 *
 * - `already_ended` — the goal is `met` or `abandoned` already. Ending is one-way, so this
 *   is a refusal and never an overwrite; `detail` names the status it holds and who ended
 *   it, which is the sentence a second tab's operator needs to see.
 *
 * `409`, like {@link RunRefused}: the request is well formed and the state of the world is
 * what stops it.
 */
export class GoalRefused extends Schema.TaggedError<GoalRefused>()(
  "GoalRefused",
  {
    reason: Schema.Literals(["already_ended"]),
    goalId: Schema.String,
    detail: Schema.String,
  },
  { httpApiStatus: 409 },
) {
  override get message(): string {
    return `${this.reason} (${this.goalId}): ${this.detail}`;
  }
}

/**
 * A refused scope change.
 *
 * Three reasons, because they lead the operator to three different actions and the Scope
 * tab shows them differently:
 *
 * - `invalid` — the value is not a host, an apex or a block. The normaliser's own
 *   sentence comes through in `detail`, naming the remedy rather than the rule, so the
 *   form can show it verbatim.
 * - `contradiction` — the entry's kind and value already exist under the opposite
 *   effect. An entry cannot be in and out at once; `detail` names the existing row. This
 *   is the one refusal in the whole flow, and A4 gives it the only danger-red in the
 *   screen for that reason.
 * - `not_found` — the entry or asset named is not this target's. A control that appears to
 *   work and does nothing is an anti-goal, so this is a refusal rather than a shrug.
 *
 * `409` rather than `400`, because `contradiction` is a conflict with stored state rather
 * than a malformed request, and one status for one error keeps the client's branching on
 * `reason` where the three sentences are.
 */
export class ScopeRefused extends Schema.TaggedError<ScopeRefused>()(
  "ScopeRefused",
  {
    reason: Schema.Literals(["invalid", "contradiction", "not_found"]),
    detail: Schema.String,
  },
  { httpApiStatus: 409 },
) {
  override get message(): string {
    return `${this.reason}: ${this.detail}`;
  }
}

/**
 * The briefing a planner round would be given for one goal, and how big it is.
 *
 * **The rendered text, not the structured briefing.** A planner round is prompted with
 * `rendered` and nothing else, so that string is what "exactly what the planner will be
 * given" means and what the panel shows. The structured `GoalBriefing` is not on the wire
 * beside it: it would roughly double a payload that is allowed to reach `maxChars`, to
 * carry the same facts a second time for a reader that renders text. The few structured
 * fields a reader has to be able to *check* rather than read are here as fields.
 *
 * `sizeChars` is `rendered.length` and `maxChars` is this installation's ceiling, so a
 * panel can show how close a goal is to it without a second request.
 */
export const GoalBriefingView = Schema.Struct({
  targetId: Schema.String,
  goalId: Schema.String,
  /** The exact text a planner round receives. */
  rendered: Schema.String,
  /** Its length in characters. An approximation of cost: see the server's module note. */
  sizeChars: Schema.Int,
  /** The ceiling in force, from `GOAL_BRIEFING_MAX_CHARS`. Over it, this is a refusal. */
  maxChars: Schema.Int,
  /** The graph sequence it was prepared at. Provenance, not a snapshot. */
  preparedAtSequence: Schema.Number,
  /** How many intents the text carries. */
  intentCount: Schema.Int,
  /** How many observations it carries, which is every one the goal holds. */
  observationCount: Schema.Int,
  /**
   * Always empty, and on the wire for that reason: an empty list is the checkable form of
   * "nothing was dropped", where an absent field would make completeness unfalsifiable.
   */
  omittedObservationIds: Schema.Array(Schema.String),
  /** Always false, kept for the same reason. */
  truncated: Schema.Boolean,
});
export type GoalBriefingView = typeof GoalBriefingView.Type;

/**
 * The goal's briefing is too big to hand a planner, so none was built.
 *
 * **A refusal rather than a shorter briefing, which is the whole point.** A planner given
 * a silently-shortened brief would reason from a gap it cannot see, so the server returns
 * nothing and names both numbers: what the briefing rendered to, and the ceiling it went
 * over. An operator can then raise `GOAL_BRIEFING_MAX_CHARS`, or split the goal, with the
 * actual figures in hand rather than a guess.
 *
 * `409`, like {@link GoalRefused}: the request is well formed and the state of the world
 * is what stops it. Not a `413`, which is about a request body, and not a `500`, which
 * would claim the server is broken when it is working exactly as configured.
 */
export class GoalBriefingRefused extends Schema.TaggedError<GoalBriefingRefused>()(
  "GoalBriefingRefused",
  {
    reason: Schema.Literals(["too_large"]),
    goalId: Schema.String,
    /** What the briefing rendered to, in characters. */
    sizeChars: Schema.Int,
    /** The ceiling it exceeded. */
    maxChars: Schema.Int,
    detail: Schema.String,
  },
  { httpApiStatus: 409 },
) {
  override get message(): string {
    return `${this.reason} (${this.goalId}): ${this.detail}`;
  }
}

/* ── Intents ─────────────────────────────────────────────────────────────────── */

/**
 * No intent under that id in this target. One refusal for a missing id and another
 * target's, for the reason {@link GoalNotFound} gives. `404`.
 */
export class IntentNotFound extends Schema.TaggedError<IntentNotFound>()(
  "IntentNotFound",
  { targetId: Schema.String, intentId: Schema.String, detail: Schema.String },
  { httpApiStatus: 404 },
) {
  override get message(): string {
    return `no intent '${this.intentId}' in target '${this.targetId}': ${this.detail}`;
  }
}

/**
 * An intent change the server will not make.
 *
 * - `invalid` — the submission does not resolve against stored state: an anchor that is an
 *   intent, a goal or nothing recorded, an anchor from another goal, a dimension address
 *   that names nothing. `detail` is the store's own sentence and **is written to teach**
 *   (what the id actually is, why that cannot anchor an intent, how to express a new
 *   direction); a client shows it as written. This is the only thing `invalid` is claimed
 *   to mean — the store gives no finer reason.
 * - `not_abandonable` — the intent is not `open`: a run holds it, or it is answered or
 *   already abandoned. `detail` says which and what to do about it.
 *
 * `409`, like {@link GoalRefused}.
 */
export class IntentRefused extends Schema.TaggedError<IntentRefused>()(
  "IntentRefused",
  {
    reason: Schema.Literals(["invalid", "not_abandonable"]),
    detail: Schema.String,
  },
  { httpApiStatus: 409 },
) {
  override get message(): string {
    return `${this.reason}: ${this.detail}`;
  }
}

/* ── Harnesses ───────────────────────────────────────────────────────────────── */

/**
 * One configured harness instance, as the picker sees it.
 *
 * ## The two eligibility predicates, and why this carries both answers
 *
 * `enabled` and `ready` are kept apart on the server (`harness/resolver.ts`, adopted from
 * T3Code) because disabling is immediate while an observation lingers: `enabled` is what
 * the operator says now, `ready` folds in what the last look said. The server already
 * applies the weaker one — every row here is one it is *configured* to drive — so what
 * travels is the stronger answer plus its reason.
 *
 * **The consequence is the rule: an unusable instance stays listed.** A picker that dropped
 * a harness the operator had configured would answer "why is OpenCode missing?" with
 * silence. So an instance that will not start is here, not offered, and says what it said.
 *
 * ## What `ready` can honestly mean
 *
 * **Not "authenticated".** `opencode serve` starts with no provider credentials and only
 * fails at prompt time; the Claude Agent SDK's `accountInfo()` needs a live session. So
 * `auth` is `unknown` on every instance today and folding it into `ready` would make every
 * working installation read as broken. `ready` means the server built the harness and is
 * holding it: the binary is there, the version floor is met, and a run can be handed over.
 *
 * The cost is stated rather than hidden: **an instance that is installed but not logged in
 * reads as ready**, and the first thing an operator sees is a refused run. The alternative
 * was a probe whose answer would be a guess, and a guess here would say a login is fine
 * when it is not.
 */
export const HarnessInstanceView = Schema.Struct({
  /** What a run names, and what an attempt row is pinned to. */
  instanceId: Schema.String,
  /**
   * Which implementation this is a configuration of: `opencode`, `claude-code`.
   *
   * Shown, never routed by. It is re-derived from the instance against this server's
   * current configuration and is deliberately not stored against a run (migration `0014`),
   * so a browser that dispatched on it would be dispatching on something the server has
   * refused to persist.
   */
  driver: Schema.String,
  /** For the operator's screen. Never an identity. */
  displayName: Schema.String,
  /** The harness's own version string, as it reported it. */
  version: Schema.String,
  /** Whether a run may be sent here. See this struct's header on what it means. */
  ready: Schema.Boolean,
  /**
   * Why not, when it is not ready. Always set when `ready` is false.
   *
   * The harness's own words about why it would not start, so a row that is visible always
   * has something to say for itself.
   */
  reason: Schema.optional(Schema.String),
  /** What to do about it: install something, upgrade something. */
  setup: Schema.optional(Schema.String),
  /**
   * Whether the harness says it can reach its provider.
   *
   * `unknown` is the answer on every instance today and is a real answer rather than a
   * missing one — see this struct's header.
   */
  auth: Schema.Literals(["authenticated", "unauthenticated", "unknown"]),
  /** Whether a run that names no instance lands here. */
  isDefault: Schema.Boolean,
  /** The model a run on this instance gets when it names none. Always in `models`. */
  defaultModel: Schema.String,
  /**
   * Every model this instance offers, in the form a run names one.
   *
   * What the picker searches. Observed when the server built the harness, so a model added
   * to the harness's catalogue since then is not here until a restart — and an operator may
   * still name one that is not listed, because whether a model runs is the harness's answer
   * rather than this list's.
   *
   * Each entry carries its own `optionDescriptors`: what that model can be asked for
   * beyond itself. They are per *model* rather than per instance because that is where
   * they come from — OpenCode reports a variant list per model and two models of one
   * provider genuinely differ — see `modelOption.ts`.
   */
  models: Schema.Array(HarnessModelView),
});
export type HarnessInstanceView = typeof HarnessInstanceView.Type;

/* ── Transcripts ─────────────────────────────────────────────────────────────── */

/**
 * What asking the harness for one attempt's transcript found. Never collapsed into "we have
 * a transcript" — and, now that the harness is the only source, never collapsed into "we do
 * not" either. This application keeps no copy of an agent's conversation.
 *
 * - `harness` — the harness answered with its log of that session. Real, and it lasts
 *   exactly as long as the harness feels like keeping it.
 * - `absent` — the harness was asked and does not hold it: it has forgotten the session,
 *   holds nothing under it, or the attempt never had a session. **Gone**, and for an older
 *   attempt that is the expected answer, not a fault.
 * - `unreachable` — the harness could not be asked: it will not start, the instance is not
 *   one this server configures, or the request failed or timed out. This says **nothing**
 *   about whether the transcript still exists, so it must not be shown as gone.
 */
export const TranscriptSource = Schema.Literals([
  "harness",
  "absent",
  "unreachable",
]);
export type TranscriptSource = typeof TranscriptSource.Type;

/** One message of a transcript, as this application reads one. */
export const TranscriptEntry = Schema.Struct({
  index: Schema.Int,
  /** The harness's own entry type, unmapped: `assistant`, `tool`, `result`. */
  type: Schema.String,
  text: Schema.String,
  error: Schema.optional(Schema.String),
});
export type TranscriptEntry = typeof TranscriptEntry.Type;

/**
 * One attempt's transcript, with what asking for it found attached.
 *
 * **The harness is the only source, and it deletes.** Claude Code removes its local
 * transcripts after `cleanupPeriodDays` — 30 by default — and an OpenCode session lives in
 * a server process that restarts. This application keeps no copy, so for any old attempt
 * the transcript is simply gone and that is the ordinary end of every attempt. {@link
 * ephemeral} is the field that keeps a screen from presenting what is shown as permanent.
 *
 * So a `harness` transcript must read as **"from the harness, may be gone"**; an `absent`
 * one must read as **gone, and normal** — not as a failure and not as an empty
 * conversation; and an `unreachable` one must read as **"could not ask"**, which is neither.
 * That is why this is a 200 for all three and not a 404: "the harness has forgotten it" is
 * the ordinary end state of every attempt old enough, and an error status would make a
 * browser treat the common case as a fault.
 */
export const AttemptTranscript = Schema.Struct({
  attemptId: Schema.String,
  targetId: Schema.String,
  source: TranscriptSource,
  /** True only for `harness`: what is shown can disappear. */
  ephemeral: Schema.Boolean,
  /** A sentence for the operator, set on every source including a successful read. */
  note: Schema.String,
  /** Empty unless `source` is `harness`. */
  entries: Schema.Array(TranscriptEntry),
  /** Entries this answer stopped short of. A transcript can be very long. */
  truncated: Schema.Boolean,
});
export type AttemptTranscript = typeof AttemptTranscript.Type;

/**
 * An attempt that is not in the target this request named.
 *
 * Its own refusal rather than an empty transcript, because the two are different mistakes:
 * a transcript nobody kept is normal, and an attempt id that does not belong to this target
 * is a request built from the wrong pieces.
 */
export class AttemptNotFound extends Schema.TaggedError<AttemptNotFound>()(
  "AttemptNotFound",
  { targetId: Schema.String, attemptId: Schema.String },
  { httpApiStatus: 404 },
) {
  override get message(): string {
    return `no attempt '${this.attemptId}' is recorded in target '${this.targetId}'`;
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
    /**
     * Registers a target, and starts the scope importer when links were given.
     *
     * **It still starts no hunt, and that is load-bearing** (D13). It registers the row,
     * migrates the file, and — when {@link TargetDraft.programLinks} is non-empty — starts
     * one agent session whose only tools write scope entries and assets. No goal, no
     * intent, no attempt, no run. The operator's review of what the importer wrote is the
     * only control on it, and that review rests entirely on there being a real gap between
     * the import and the first execution. A default goal, an auto-run or a "start hunting"
     * affordance here would remove the one thing standing between a scraped page and a
     * live hunt.
     */
    HttpApiEndpoint.post("createTarget", "/targets", {
      payload: TargetDraft,
      success: TargetCreated,
      error: [TargetRefused, PathRefused, PathNotFound],
    }),
    /**
     * Starts one scope import against a target that already exists, and answers at once.
     *
     * **The Auto-load page's only write.** Creating a target no longer takes program links;
     * the importer is started from the Assets page, with the target already in hand. The
     * target must be one this server can open — the same `TargetNotFound` and
     * `TargetUnavailable` as reading it — because an import writes into its database.
     *
     * It starts nothing but the importer, for `createTarget`'s reason (D13): no goal, no
     * intent, no attempt, no run. Nothing here is idempotent. Two requests start two imports
     * writing into one scope, and the server does not tell them apart — the page holds the
     * running one's id and shows its panel instead of its form, which is the only thing
     * between an operator and a second session.
     *
     * A refusal to start (no harness, a dead picked instance, no links) is a value on the
     * answer, not an error, so the form stays on screen beside the sentence.
     */
    HttpApiEndpoint.post(
      "startScopeImport",
      "/targets/:targetId/scope-import",
      {
        params: { targetId: Schema.String },
        payload: ScopeImportDraft,
        success: ScopeImportStartResult,
        error: [TargetNotFound, TargetUnavailable],
      },
    ),
    /**
     * One scope import's progress: its links, its tool calls and its totals.
     *
     * A read the panel polls rather than a stream, because the import outlives the panel.
     * "Continue in background" is a navigation away from a screen, not a change of mode:
     * the session keeps reading and keeps writing whether or not anybody has this open.
     *
     * The import is under its target in the path because that is the file it writes to and
     * the target it is scoped by, and the id is checked against the target before anything
     * is looked up.
     */
    HttpApiEndpoint.get(
      "scopeImport",
      "/targets/:targetId/scope-import/:importId",
      {
        params: { targetId: Schema.String, importId: Schema.String },
        success: ScopeImportView,
        error: [ScopeImportNotFound],
      },
    ),
    /**
     * Stops one import, keeping everything it has already written.
     *
     * A `POST` to a sub-resource rather than a `DELETE`, for the reason `stopRun` is: it
     * removes nothing. Every entry and every asset written before the stop stays, which is
     * what makes stopping early a decision rather than a loss — the design's own copy says
     * so, and D15 makes it a property of the design by having the session write as it
     * reads rather than at the end.
     *
     * Answers with the import as it stands at the stop, so the panel's last render is the
     * receipt for exactly what landed.
     */
    HttpApiEndpoint.post(
      "stopScopeImport",
      "/targets/:targetId/scope-import/:importId/stop",
      {
        params: { targetId: Schema.String, importId: Schema.String },
        success: ScopeImportView,
        error: [ScopeImportNotFound],
      },
    ),
    /**
     * The harness sessions this target's scope imports have run on, newest first, each with
     * what it wrote.
     *
     * **An index and not a history.** Nothing said in a session is stored or returned here;
     * a row is the harness's id for a session this server opened, with the figures counted
     * from what that session left on the target. Reading the conversation is the harness's
     * to answer. The figures are counted on read rather than kept, so they cannot be wrong
     * about a session that is still writing.
     */
    HttpApiEndpoint.get(
      "importerSessions",
      "/targets/:targetId/importer-sessions",
      {
        params: { targetId: Schema.String },
        success: ImporterSessionsView,
        error: [TargetNotFound, TargetUnavailable],
      },
    ),
    /**
     * Every long-running agent session this target has, of any kind, newest first.
     *
     * **A read-time union** of the goal, importer and worker indexes; there is no table behind
     * it. See {@link AgentSessionsView}.
     */
    HttpApiEndpoint.get("agentSessions", "/targets/:targetId/agent-sessions", {
      params: { targetId: Schema.String },
      success: AgentSessionsView,
      error: [TargetNotFound, TargetUnavailable],
    }),
    /**
     * Opens a conversation with the importer: a new session, the operator's message its
     * first turn. Answers once the session has the message, with the new import's id.
     *
     * **It does not need links**, unlike {@link startScopeImport}, whose empty list is
     * answered "nothing was asked for". Here the operator's message is the thing asked
     * for. It starts nothing but the importer (D13): no goal, no intent, no attempt, no run.
     */
    HttpApiEndpoint.post(
      "openImporterConversation",
      "/targets/:targetId/importer-sessions",
      {
        params: { targetId: Schema.String },
        payload: ImporterConversationDraft,
        success: ImporterTurnAccepted.pipe(HttpApiSchema.status(202)),
        error: [ImporterConversationRefused, TargetNotFound, TargetUnavailable],
      },
    ),
    /**
     * Says something to one import's session, and answers without waiting for the turn.
     *
     * A live session is given the message as a queued steer: work in flight finishes, then
     * the message runs (DECISIONS.md §24.1). An import the operator ended is refused, because
     * its authority is over. An import whose session this server no longer holds — closed
     * after a refused prompt, or lost to a restart — gets a fresh session under a **new
     * import id**, which the answer carries and says so. An id this target does not hold is a
     * `404`.
     */
    HttpApiEndpoint.post(
      "sendImporterMessage",
      "/targets/:targetId/importer-sessions/:importId/messages",
      {
        params: { targetId: Schema.String, importId: Schema.String },
        payload: ImporterMessageDraft,
        success: ImporterTurnAccepted.pipe(HttpApiSchema.status(202)),
        error: [
          ImporterConversationRefused,
          ScopeImportNotFound,
          TargetNotFound,
          TargetUnavailable,
        ],
      },
    ),
    /**
     * One importer session's conversation, replayed from the harness (S6).
     *
     * **Oldest first and all of them**, which is what `AgentHarness.messages` promises after
     * the `openCodeClient` fix (`order: "asc"`, following the cursor): a conversation is read
     * to pick up where it left off, and a replay that started at the newest would hand an
     * operator the end of a thread with no beginning. `truncated` says when the answer
     * stopped short, and it stops short of the **oldest**.
     *
     * Reduced to the `{ type, text, error }` shape the goal replay already answers with, so
     * the chat needs no second renderer. A `user` entry is the operator's own words, with
     * this server's framing trimmed off at the delimiter it wrote itself.
     *
     * The import is checked against the target first, so a stale deep link is a `404` rather
     * than a `200` about somebody else's session. After that this **cannot fail**: every way
     * of having no prose is one of {@link ImporterConversationSource}'s five answers with a
     * sentence of its own.
     */
    HttpApiEndpoint.get(
      "importerMessages",
      "/targets/:targetId/importer-sessions/:importId/messages",
      {
        params: { targetId: Schema.String, importId: Schema.String },
        success: ImporterConversationView,
        error: [ScopeImportNotFound, TargetNotFound, TargetUnavailable],
      },
    ),
    /**
     * Moves one import's session onto another model of its harness, or other options of
     * its model (A6 F4).
     *
     * The harness is the import's own, read from its row: a model that instance's catalogue
     * does not list is refused, so a model of another harness always is. A live session is
     * switched at once and takes it from its next model call; one this server does not hold
     * has only its record changed, and the next message reopens it on the new model. The
     * record changes only after the harness accepted — an uncertain answer leaves it as it
     * was. One switch at a time per import; a second while one is in flight is refused, not
     * queued. An id this target does not hold is a `404`.
     */
    HttpApiEndpoint.post(
      "switchImporterModel",
      "/targets/:targetId/importer-sessions/:importId/model",
      {
        params: { targetId: Schema.String, importId: Schema.String },
        payload: ConversationModelDraft,
        success: ConversationModelSwitched,
        error: [
          ConversationModelRefused,
          ScopeImportNotFound,
          TargetNotFound,
          TargetUnavailable,
        ],
      },
    ),
    /**
     * Which model an import would run on right now (D15).
     *
     * **A request rather than a constant in the browser bundle**, and `modelOption.ts`'s
     * doctrine is the reason: a descriptor is observed when the server built the harness
     * and replaced wholesale when it is rebuilt. A preferred model id compiled into the
     * create-target screen would outlive the catalogue entry it names, and the screen would
     * go on offering a choice the server could not honour.
     *
     * So the rule — the preferred free model, or the other harness's small one when the
     * catalogue does not offer it — runs once, on the server, over what the harnesses
     * actually reported, and the picker preselects the answer instead of re-deriving it.
     */
    HttpApiEndpoint.get("importerModel", "/importer-model", {
      success: ImporterModelView,
      error: [ImporterModelUnavailable],
    }),
    /**
     * The agents a conversation can run as, for the agent chip.
     *
     * A request rather than a list in the browser bundle, for `importerModel`'s reason: the
     * registry is the server's, and a list compiled into the screen would go on offering an
     * agent after the server stopped defining it. Each entry is its label and what it can
     * write; its prompt and its grant stay on the server, which applies them.
     */
    HttpApiEndpoint.get("agents", "/agents", {
      success: AgentsView,
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
    /**
     * Which agent harnesses this server configures, ready or not.
     *
     * A fact about the *process* and not about any target, like `runs`: the picker on every
     * open target's composer shows the same list, and one request answers all of them.
     *
     * **It lists unusable instances too**, with their reason — see
     * {@link HarnessInstanceView}. A client filters by `ready` to decide what to offer and
     * shows the rest with what they said, which is the one behaviour this endpoint exists
     * to make possible.
     */
    HttpApiEndpoint.get("harnesses", "/harnesses", {
      success: Schema.Array(HarnessInstanceView),
    }),
    /**
     * One past attempt's transcript: ours if we kept one, the harness's if we did not.
     *
     * The attempt is under its target in the path because that is where it is recorded —
     * attempt rows live in the target's own `hunt.sqlite` and our transcript artefact lives
     * in that target's `evidence/` directory, so neither is findable without the target id.
     *
     * **Answers 200 with `source: "absent"` rather than 404 when there is nothing.** For an
     * attempt old enough that is the expected end state: we may not have written one, and
     * the harness deletes its own. `AttemptNotFound` is reserved for the different mistake
     * of naming an attempt this target does not hold.
     */
    HttpApiEndpoint.get(
      "transcript",
      "/targets/:targetId/attempts/:attemptId/transcript",
      {
        params: { targetId: Schema.String, attemptId: Schema.String },
        success: AttemptTranscript,
        error: [AttemptNotFound, TargetNotFound, TargetUnavailable],
      },
    ),
    /**
     * The goals of one target, newest first, each with what hangs under it.
     *
     * Wrapped in an object rather than a bare array so a field can be added beside `goals`
     * without breaking every client. Read-only and cheap: one statement over the target's
     * own file, so a list refresh costs a worker nothing.
     */
    HttpApiEndpoint.get("goals", "/targets/:targetId/goals", {
      params: { targetId: Schema.String },
      success: Schema.Struct({ goals: Schema.Array(GoalView) }),
      error: [TargetNotFound, TargetUnavailable],
    }),
    /**
     * Every asset the hunt has recorded on one target, oldest first.
     *
     * The read the Assets screen is built on. Until this existed the browser could see
     * only `counts.assets` — a number with nothing behind it — so an operator could watch
     * the estate's size change and never see what was in it.
     *
     * **Nothing is filtered out.** An asset no in-scope entry covers is returned like any
     * other, because the whole point of the estate view is that a discovery is recorded,
     * kept, displayed and labelled rather than hidden. The scope state each row is shown
     * under is a separate question, answered where the entries are.
     *
     * Wrapped in an object rather than a bare array, so a field can be added beside
     * `assets` — a per-host aggregate, say — without breaking every client. Read-only and
     * one statement over the target's own file.
     */
    HttpApiEndpoint.get("assets", "/targets/:targetId/assets", {
      params: { targetId: Schema.String },
      success: Schema.Struct({ assets: Schema.Array(AssetView) }),
      error: [TargetNotFound, TargetUnavailable],
    }),
    /**
     * One target's authored scope, and the block an agent would be given right now.
     *
     * Read-only. `promptBlock` is rendered by the same function both prompt paths use, so
     * the preview an operator checks is the bytes an agent gets rather than a second
     * renderer's impression of them.
     */
    HttpApiEndpoint.get("scope", "/targets/:targetId/scope", {
      params: { targetId: Schema.String },
      success: ScopeView,
      error: [TargetNotFound, TargetUnavailable],
    }),
    /**
     * Adds one scope entry.
     *
     * `201` would be wrong here: adding an entry that already exists is a deliberate
     * no-op rather than a conflict, so this is not reliably a creation. It answers with
     * the whole scope instead of the new row, because every scope change moves the
     * prompt block the operator is reading beside the list.
     *
     * Refused as {@link ScopeRefused} when the value cannot be normalised, or when it
     * would contradict an entry that already exists under the opposite effect.
     */
    HttpApiEndpoint.post("addScopeEntry", "/targets/:targetId/scope/entries", {
      params: { targetId: Schema.String },
      payload: ScopeEntryDraft,
      success: ScopeView,
      error: [ScopeRefused, TargetNotFound, TargetUnavailable],
    }),
    /**
     * Removes one scope entry.
     *
     * A `POST` to a sub-resource rather than a `DELETE`, which is this API's convention
     * throughout. Removing an entry that is not there is refused rather than answered
     * cheerfully: a control that appears to work and does nothing is one of the scope
     * design's named anti-goals.
     */
    HttpApiEndpoint.post(
      "removeScopeEntry",
      "/targets/:targetId/scope/entries/:entryId/remove",
      {
        params: { targetId: Schema.String, entryId: Schema.String },
        success: ScopeView,
        error: [ScopeRefused, TargetNotFound, TargetUnavailable],
      },
    ),
    /**
     * Promotes, excludes, or withdraws a label on one host or one asset.
     *
     * One route for all three, because they are one control with two directions plus an
     * undo — which is how the scope view presents them, and how the store implements
     * them. **It never touches the typed entries**, and no amount of labelling can widen
     * or narrow the list the operator authored: a label beats an entry for one subject and
     * leaves the entry exactly as written, which is what lets the view say which entry was
     * overridden rather than losing the fact a carve-out was made.
     *
     * Answers with the whole scope, because a label changes what the agent is told and the
     * preview beside the list has to move with it.
     */
    HttpApiEndpoint.post("labelScope", "/targets/:targetId/scope/labels", {
      params: { targetId: Schema.String },
      payload: ScopeLabelDraft,
      success: ScopeView,
      error: [ScopeRefused, TargetNotFound, TargetUnavailable],
    }),
    /**
     * Creates a goal under one target.
     *
     * `201`, because a resource now exists that did not. The body is {@link GoalDraft}: a
     * browser sends the objective and an optional label, and **the server mints the goal
     * id and the operation id** — see the draft for why neither is the browser's to name.
     * An objective that is empty after trimming is refused by the payload decoder before
     * a handler runs, so nothing is written for it.
     */
    HttpApiEndpoint.post("createGoal", "/targets/:targetId/goals", {
      params: { targetId: Schema.String },
      payload: GoalDraft,
      success: GoalView.pipe(HttpApiSchema.status(201)),
      error: [TargetNotFound, TargetUnavailable],
    }),
    /** One goal, with its counts. Refused as {@link GoalNotFound} if this target lacks it. */
    HttpApiEndpoint.get("goal", "/targets/:targetId/goals/:goalId", {
      params: { targetId: Schema.String, goalId: Schema.String },
      success: GoalView,
      error: [GoalNotFound, TargetNotFound, TargetUnavailable],
    }),
    /**
     * Ends a goal as `met` or `abandoned`, as the operator.
     *
     * A `POST` to a sub-resource rather than a `DELETE` or a `PATCH`, for the reason
     * {@link stopRun} is one: nothing is removed, and this is a recorded act with a reason
     * rather than an edit of a field. The ender is not in the body — this route is the
     * operator's, so `endedBy` is `operator` by construction.
     *
     * **It stops nothing.** An attempt already running under the goal keeps running; ending
     * blocks new dispatch and planner wake-ups, and the stop control remains the only way to
     * stop an attempt. A goal that is already ended is refused as {@link GoalRefused}, naming
     * what ended it.
     */
    HttpApiEndpoint.post("endGoal", "/targets/:targetId/goals/:goalId/end", {
      params: { targetId: Schema.String, goalId: Schema.String },
      payload: GoalEndDraft,
      success: GoalView,
      error: [GoalNotFound, GoalRefused, TargetNotFound, TargetUnavailable],
    }),
    /**
     * The intents under one goal, oldest first, each with its anchors, status and attempt
     * count.
     *
     * Wrapped in an object for the reason `goals` is. A goal another target holds is not
     * found here ({@link GoalNotFound}).
     */
    HttpApiEndpoint.get("intents", "/targets/:targetId/goals/:goalId/intents", {
      params: { targetId: Schema.String, goalId: Schema.String },
      success: Schema.Struct({ intents: Schema.Array(IntentView) }),
      error: [GoalNotFound, TargetNotFound, TargetUnavailable],
    }),
    /**
     * The observations recorded under one goal, as a digest an anchor can be chosen from.
     *
     * In store order, oldest first. Read-only, and **not the record**: see
     * {@link GoalObservationView}. It exists so the add-intent form can offer real evidence
     * to anchor to and real untested dimensions to address, rather than asking an operator
     * to type an id nobody can be expected to remember.
     */
    HttpApiEndpoint.get(
      "goalObservations",
      "/targets/:targetId/goals/:goalId/observations",
      {
        params: { targetId: Schema.String, goalId: Schema.String },
        success: Schema.Struct({
          observations: Schema.Array(GoalObservationView),
        }),
        error: [GoalNotFound, TargetNotFound, TargetUnavailable],
      },
    ),
    /**
     * The briefing a planner round would be given for one goal.
     *
     * Read-only, and the planner's input object built before anything consumes it: an
     * operator can see exactly what a round will be prompted with, and how close it is to
     * the ceiling, rather than finding out when a round refuses.
     *
     * **It omits nothing** (the spec's decision 11). Every intent of the goal and every
     * observation under all of them, in full. Over `GOAL_BRIEFING_MAX_CHARS` it is
     * {@link GoalBriefingRefused} naming both numbers and carrying no briefing at all,
     * because a shortened brief is the failure this route exists to make impossible.
     */
    HttpApiEndpoint.get(
      "goalBriefing",
      "/targets/:targetId/goals/:goalId/briefing",
      {
        params: { targetId: Schema.String, goalId: Schema.String },
        success: GoalBriefingView,
        error: [
          GoalBriefingRefused,
          GoalNotFound,
          TargetNotFound,
          TargetUnavailable,
        ],
      },
    ),
    /**
     * Adds an intent under a goal, by hand.
     *
     * `201`. The body is {@link IntentDraft}; **the server mints the intent id and the
     * operation id**, and the write is the store's existing `addIntent`, so its anchoring
     * rule is enforced there and not restated here. A refusal of that rule comes back as
     * {@link IntentRefused} with the store's sentence, which is meant to be read.
     */
    HttpApiEndpoint.post(
      "createIntent",
      "/targets/:targetId/goals/:goalId/intents",
      {
        params: { targetId: Schema.String, goalId: Schema.String },
        payload: IntentDraft,
        success: IntentView.pipe(HttpApiSchema.status(201)),
        error: [GoalNotFound, IntentRefused, TargetNotFound, TargetUnavailable],
      },
    ),
    /**
     * Abandons an open intent, as the operator.
     *
     * A `POST` to a sub-resource for the reason `endGoal` is. Refused as
     * {@link IntentRefused} when the intent is claimed, answered or already abandoned, and
     * as {@link IntentNotFound} when this target has no such intent. It stops nothing: a
     * claimed intent is refused, because stopping its attempt is the stop control's job.
     */
    HttpApiEndpoint.post(
      "abandonIntent",
      "/targets/:targetId/intents/:intentId/abandon",
      {
        params: { targetId: Schema.String, intentId: Schema.String },
        payload: IntentAbandonDraft,
        success: IntentView,
        error: [
          IntentNotFound,
          IntentRefused,
          TargetNotFound,
          TargetUnavailable,
        ],
      },
    ),
    /**
     * Opens one planner round on a goal, and answers without waiting for it.
     *
     * **No payload at all, and that is the interesting part of this endpoint.** A round's
     * directory, the audit path its policy gate writes to, and the engagement folder it
     * must not sit inside are facts about this installation's filesystem layout; a browser
     * that could name any of them would be choosing where an agent runs. Even the harness
     * and the model are absent, unlike `startRun`: nothing but the operator has an opinion
     * about where planning happens, and that opinion is server configuration today rather
     * than a per-round pick.
     *
     * The prompt is the goal's objective plus the goal briefing, assembled server-side. It
     * answers as soon as the round is durable and prompted, exactly as {@link startRun}
     * does — a round takes minutes, and a request that waited for it would time out.
     *
     * Four refusals and each is a different thing to do about it.
     * {@link GoalBriefingRefused} is the same error the briefing panel already renders,
     * with the same two numbers, because "this goal's brief is over the ceiling" is one
     * fact and the round is refused on it **having started nothing** — no round row, no
     * directory, no session. {@link PlanRefused} is everything else about the round, the
     * goal or the harness. The other two are the target.
     */
    HttpApiEndpoint.post("plan", "/targets/:targetId/goals/:goalId/plan", {
      params: { targetId: Schema.String, goalId: Schema.String },
      success: PlanRoundStarted.pipe(HttpApiSchema.status(201)),
      error: [
        PlanRefused,
        GoalBriefingRefused,
        GoalNotFound,
        TargetNotFound,
        TargetUnavailable,
      ],
    }),
    /**
     * The planner rounds of one goal, newest first, each with what it concluded.
     *
     * The **rows**, which is what makes this a different question from {@link rounds}: a
     * row that says `running` is a round nothing settled, and a process that died leaves
     * exactly that. This is where a disposition is read from, and it is the only place a
     * settled round's answer survives a refresh.
     *
     * Wrapped in an object for the reason `goals` is.
     */
    HttpApiEndpoint.get(
      "goalRounds",
      "/targets/:targetId/goals/:goalId/rounds",
      {
        params: { targetId: Schema.String, goalId: Schema.String },
        success: Schema.Struct({ rounds: Schema.Array(PlanRoundView) }),
        error: [GoalNotFound, TargetNotFound, TargetUnavailable],
      },
    ),
    /**
     * One goal's planner narration, replayed from the harness.
     *
     * **The other half of {@link goalRounds}, and the halves are not interchangeable.**
     * That one answers from our rows: a round's status and what it concluded, which
     * survive anything. This one answers from the harness's own retention: the prose, which
     * this build never persisted (the goal and planner flow's decision 14) and therefore
     * cannot promise. A planner chat shows both, with each round's row as its heading and
     * this as what is under it.
     *
     * `200` in every case, including a goal whose rounds the harness has entirely
     * forgotten, for the reason the `transcript` route is a 200 with `source: "absent"`:
     * "gone" is the ordinary end state of anything old enough, and an error status would
     * make a browser treat the common case as a fault. Each round says for itself which of
     * {@link RoundNarrationSource}'s four answers it got.
     *
     * Read-only and makes no claim to be live: a round in flight narrates onto the
     * `live` stream, where the items carry {@link LiveItem.roundId}. This is what a
     * **refresh** gets, and joining the two is the client's job.
     *
     * **That join is by the client's own arrival order, not by any index on this shape.**
     * There is no index the two channels share: `AgentHarness.messages` carries none at
     * all, so {@link RoundNarrationMessage.index} is a position in *this answer* and a
     * render key — see that field, which says what it is not. The browser instead records
     * the in-process narration publish counter before this request leaves and treats live
     * narration at or below it as already replayed. The residual overlap is accepted and
     * disclosed: the replayed block is labelled a replay rather than claiming completeness.
     *
     * Each round also says what it left out — {@link RoundNarration.omittedBlank} and
     * {@link RoundNarration.promptOmitted} — because an omission a reader cannot count is
     * indistinguishable from a round that said less than it did.
     */
    HttpApiEndpoint.get(
      "goalNarration",
      "/targets/:targetId/goals/:goalId/narration",
      {
        params: { targetId: Schema.String, goalId: Schema.String },
        success: GoalNarrationView,
        error: [GoalNotFound, TargetNotFound, TargetUnavailable],
      },
    ),
    /**
     * One goal's conversation, replayed from the harness.
     *
     * The goal agent's half of what {@link goalNarration} does for planner rounds, and it
     * is the **only** way a reloaded tab sees a word of it: operator messages and agent
     * turns are not stored (the goal and planner flow's decision 15). What is durable is
     * the graph the conversation moved — the rounds it woke, the intents those added, the
     * goal's own ending — and every one of those is on the same page from rows.
     *
     * `200` in every case. A goal nobody has talked to answers `source: "absent"`, and a
     * conversation the harness has deleted answers `source: "forgotten"` with a sentence,
     * because for a goal last opened weeks ago that is the expected answer and not a
     * fault. {@link GoalConversationSource} is the five answers, and three of them are
     * empty for different reasons the view must not flatten.
     *
     * The join with the live tail is {@link goalNarration}'s: the browser records the
     * in-process narration publish counter before this request leaves and drops live
     * narration at or below it. There is no index the two channels share.
     */
    HttpApiEndpoint.get(
      "goalConversation",
      "/targets/:targetId/goals/:goalId/conversation",
      {
        params: { targetId: Schema.String, goalId: Schema.String },
        success: GoalConversationView,
        error: [GoalNotFound, TargetNotFound, TargetUnavailable],
      },
    ),
    /**
     * Says something to one goal's agent, and answers without waiting for the turn.
     *
     * `202`: the message has been given to a live session and the turn is the model's to
     * take. The agent's reply arrives on the {@link live} feed as activity, carrying
     * {@link LiveItem.goalId}; what it *does* arrives there too, as records.
     *
     * **The first message creates the session**, in `targets/<id>/goal/<goalId>/` under a
     * credential with no clock expiry, with the goal toolkit registered on it — and a
     * later message is delivered into that same session, queued behind whatever it is
     * doing rather than cutting it off. {@link GoalTurnAccepted.conversation} says which
     * of the two happened, and `priorUnavailable` is how a first message *after a restart*
     * is told from a first message ever.
     *
     * The payload is the operator's words and nothing else: see {@link GoalMessageDraft}
     * on why no model, harness, session or directory is nameable here.
     */
    HttpApiEndpoint.post(
      "sendGoalMessage",
      "/targets/:targetId/goals/:goalId/conversation",
      {
        params: { targetId: Schema.String, goalId: Schema.String },
        payload: GoalMessageDraft,
        success: GoalTurnAccepted.pipe(HttpApiSchema.status(202)),
        error: [
          GoalConversationRefused,
          GoalNotFound,
          TargetNotFound,
          TargetUnavailable,
        ],
      },
    ),
    /**
     * Moves one goal's conversation onto another model of its harness, or other options of
     * its model (A6 F4).
     *
     * `switchImporterModel` for a goal, with the same rules: the harness is the one the
     * conversation's row records and is never changed here, a model outside its catalogue
     * is refused, a live session is switched at once, and one this server does not hold has
     * its record changed for the next message to reopen on. A goal nobody has talked to has
     * no harness yet and is refused as `no_session`.
     */
    HttpApiEndpoint.post(
      "switchGoalModel",
      "/targets/:targetId/goals/:goalId/conversation/model",
      {
        params: { targetId: Schema.String, goalId: Schema.String },
        payload: ConversationModelDraft,
        success: ConversationModelSwitched,
        error: [
          ConversationModelRefused,
          GoalNotFound,
          TargetNotFound,
          TargetUnavailable,
        ],
      },
    ),
    /**
     * Attaches files to one goal's conversation, where its agent can read them.
     *
     * **The only endpoint on this API that is not JSON.** The body is
     * `multipart/form-data` and the payload declaration is what makes both halves of it:
     * the server is handed the parser's stream of parts and consumes it itself, and
     * `HttpApiClient` takes a `FormData` — see {@link GoalUploadDraft} on why the streaming
     * shape and not the buffered one, which cannot work at this version, and why no parser
     * limits are set on it.
     *
     * `201`: the files exist on disk under the goal's own directory by the time this
     * answers, and nothing has been said to the agent. The attachment list reaches it on
     * the **next** message, as a block above the delimiter — never spliced into the
     * operator's own words. {@link GoalUploadsAccepted.note} is the sentence that says so.
     *
     * **Nothing in the request chooses where the bytes go.** There is no path in
     * {@link GoalUploadDraft} and no path in the answer: the server writes under
     * `targets/<id>/goal/<goalId>/uploads/`, obtained through the same gating a goal
     * session's directory is, and never under the engagement folder a worker runs in.
     *
     * Both caps — `UPLOAD_MAX_BYTES` per file and `UPLOAD_MAX_FILES` per goal — are
     * enforced on the server, answered as {@link GoalUploadRefused} naming the figure, and
     * are **not sent to the browser at all**: a client that knew them would be a second
     * copy to keep in step, and a client that did not would be refused by the same check.
     */
    HttpApiEndpoint.post(
      "uploadGoalFiles",
      "/targets/:targetId/goals/:goalId/uploads",
      {
        params: { targetId: Schema.String, goalId: Schema.String },
        payload: GoalUploadDraft,
        success: GoalUploadsAccepted.pipe(HttpApiSchema.status(201)),
        error: [
          GoalUploadRefused,
          GoalNotFound,
          TargetNotFound,
          TargetUnavailable,
        ],
      },
    ),
    /**
     * Stops one planner round, settling it and withdrawing its authority.
     *
     * The round is in the path under its goal, which is what makes the two refusals
     * different questions. {@link RoundNotFound} is the row: no such round in this goal.
     * {@link PlanRefused} with `unknown_round` is the fiber map: the row is here and *this
     * process is not driving it* — a round that already settled, or one a dead process left
     * behind for the startup sweep. Neither is actionable in the same way, so neither is
     * answered with the other.
     *
     * Answers with the round's own row, re-read after the stop, rather than with a shape of
     * its own — see `plan.ts`'s header. By the time it returns the harness has been asked to
     * interrupt, the row is `interrupted`, the round's credential is revoked and its write
     * fence is superseded. **The prompt is never resubmitted** and there is no resume: work
     * carried on after an interruption is a new round.
     */
    HttpApiEndpoint.post(
      "stopRound",
      "/targets/:targetId/goals/:goalId/rounds/:roundId/stop",
      {
        params: {
          targetId: Schema.String,
          goalId: Schema.String,
          roundId: Schema.String,
        },
        success: PlanRoundView,
        error: [
          PlanRefused,
          RoundNotFound,
          GoalNotFound,
          TargetNotFound,
          TargetUnavailable,
        ],
      },
    ),
    /**
     * Every planner round this server is supervising right now, across all targets.
     *
     * The sibling of {@link runs}, for the same reason and with the same shape: it is a
     * fact about the *process*, the supervisor holds one fiber map for the whole server,
     * and a reloaded tab has no other way to find a round it started — the start response
     * is the only other place a round id appears.
     *
     * **Not answerable from {@link goalRounds}.** A round in flight and a row saying
     * `running` are different claims, and the difference is exactly what decides which
     * refusal "Plan next" would get: `goal_busy` when a fiber holds the goal, and
     * `round_conflict` when only a row does. A control that guessed from the rows would
     * tell an operator to wait for a round that nothing is driving.
     */
    HttpApiEndpoint.get("rounds", "/rounds", {
      success: Schema.Array(RunningRound),
    }),
    /**
     * One target's live transcript, as Server-Sent Events.
     *
     * **This is not the `transcript` endpoint above with a stream bolted on, and the two
     * are not interchangeable.** That one answers with the artefact a *settled* attempt
     * left behind — our content-hashed file, or the harness's own copy while it lasts —
     * and it answers once, after the fact. This one is the target's event log being read
     * in store-assigned order behind a cursor, with what the harness and the policy gate
     * are saying right now merged alongside it. One is a document; this is a position in a
     * log plus a live feed. `@bit/contracts`'s `live.ts` is where the two channels and
     * what each promises are written down.
     *
     * **Per target, not per attempt.** The cursor belongs to a target's event log — §8:
     * "cursors belong to a particular target event log, not a global sequence across
     * independent target files" — and an attempt's own events are a subset of that log, so
     * a per-attempt stream would be a filter over this one with a cursor that could not be
     * resumed. A client that wants one attempt filters on {@link LiveItem.attemptId}.
     *
     * `cursor` is optional and its absence is **not** "from now": absent means the server
     * picks a start far enough back to fill a screen and says in the opening frame how
     * much it skipped. A client that has a cursor passes it and is answered from exactly
     * there. A negative or fractional value is clamped rather than refused — it can only
     * ask for *more* history than exists, which reads from the beginning.
     *
     * The refusals are the same three the rest of this target's routes give, from the same
     * check, because watching a target is reading it: a stream that opened against a
     * target the rail says is unavailable would be the one place those two disagree.
     */
    HttpApiEndpoint.get("live", "/targets/:targetId/live", {
      params: { targetId: Schema.String },
      query: { cursor: Schema.optional(Schema.FiniteFromString) },
      success: HttpApiSchema.StreamSse({ data: LiveFrame }),
      error: [TargetNotFound, TargetUnavailable],
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
