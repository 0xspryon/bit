/**
 * The server's implementation of {@link BitApi}, as routes for the one listener.
 *
 * The declaration lives in `@bit/contracts`; this file is the other half of it. Nothing
 * here chooses a path, a status code or a JSON shape — all of those come from the
 * contract, which is why the web client cannot be out of step with this file without a
 * compile error somewhere.
 *
 * **It is merged onto the existing router, not given a listener of its own.** The result
 * of {@link browserApiRoutes} needs only `HttpRouter.HttpRouter`, so
 * `ControlPlaneEndpoint` can merge it beside the three hand-registered routes. One port,
 * one origin, one shutdown path — and the three existing routes keep their own admission
 * postures untouched, because this API's guard is attached to this API's endpoints by the
 * contract rather than to the router.
 *
 * **Where a target's own database is opened, and where it is not.** The target rail is
 * answerable from `control.sqlite` plus a `stat`, and still is: `GET /targets` opens no
 * target file, because a list of N targets would otherwise open N databases to draw one
 * screen. `GET /targets/:targetId` is the one route that opens one, and it does it
 * through `persistence/targetStores.ts` — a reference-counted resolver keyed by target id,
 * borrowed for the length of the request. `ObservationStore` is deliberately **not** in
 * this file's context: the only way to reach a target's store here is to pass a target id
 * to that resolver, so "which target is this handler reading?" is answered by the type
 * rather than by care.
 *
 * **No CORS, deliberately.** The browser reaches these routes same-origin: in
 * development through the Vite dev server's `/api` proxy, and in a packaged deployment
 * from a server that also serves the built app. The alternative — `HttpRouter.cors` — is
 * `{ global: true }` and would apply to `/api/v1/mcp` and `/api/v1/policy/decide` as
 * well, changing what two routes with deliberately chosen postures will answer to a
 * cross-origin caller. A browser pointed at a different origin therefore fails as
 * unreachable, which is visible and honest, rather than being quietly permitted.
 */
import {
  AttemptNotFound,
  BitApi,
  dimensionsOf,
  GoalBriefingRefused,
  GoalNotFound,
  GoalMessageDraft,
  GoalRefused,
  ImporterConversationDraft,
  ImporterConversationRefused,
  ImporterMessageDraft,
  ImporterModelUnavailable,
  IntentNotFound,
  IntentRefused,
  MESSAGE_FIELD,
  MessageUploadRefused,
  RoundNotFound,
  RunRefused,
  ScopeImportNotFound,
  ScopeRefused,
  SessionActor,
  SessionGuard,
  TargetNotFound,
  TargetRefused,
  TargetUnavailable,
  Unauthenticated,
  type AssetScopeLabel,
  type AssetView,
  type AttemptTranscript,
  type GoalBriefingView,
  type GoalObservationView,
  type GoalView,
  type HarnessInstanceView,
  type IntentView,
  type HostScopeLabel,
  type PlanRoundView,
  type ScopeEntry,
  type ScopeImportView,
  type ScopeState,
  type ScopeView,
  type TargetCounts,
  type TargetSummary,
} from "@bit/contracts";
import {
  Clock,
  Context,
  Effect,
  Layer,
  Redacted,
  Schema,
  Stream,
  type Duration,
} from "effect";
import { HttpServer, type Multipart } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

import {
  checkedDirectory,
  directoryExists,
  fileExists,
  lastWrittenAt,
  listFolder,
} from "./folders";
import { BrowserSessions } from "./browserSessions";
import { unionAgentSessions, WORKER_SESSIONS_LISTED } from "./agentSessions";
import {
  DEFAULT_GOAL_BRIEFING_MAX_CHARS,
  buildGoalBriefing,
} from "../briefing/goalBriefing";
import {
  FleetStore,
  HUNT_FILE,
  isTargetId,
  type TargetRow,
} from "../persistence/fleet";
import * as identifier from "../persistence/identifier";
import {
  ObservationStore,
  operatorScope,
  type MutationError,
  type StoredAssetWithProvenance,
  type StoredGoal,
  type StoredIntent,
  type StoredRound,
} from "../persistence/store";
import { TargetStores, withTargetStore } from "../persistence/targetStores";
import { renderScopeBlock } from "../scope/scopePrompt";
import { isWithin, POLICY_AUDIT_FILE } from "../policy/install";
import { HarnessResolver, isReady } from "../harness/resolver";
import {
  AGENTS,
  DEFAULT_AGENT_ID,
  agentById,
  agentView,
  unknownAgentDetail,
} from "../agent/registry";
import { chooseImporterModel } from "../import/importerModel";
import { importerSessionTitles } from "../import/importerTitle";
import { ScopeImporter } from "../import/scopeImporter";
import { GoalConversations } from "../plan/goalConversation";
import { collectUploads } from "../plan/goalUploads";
import { PlanSupervisor } from "../plan/planSupervisor";
import {
  GOAL_NARRATION_ROUND_LIMIT,
  roundNarration,
} from "../plan/roundNarration";
import { liveTranscript } from "../run/liveTranscript";
import { RunNarrations } from "../run/narration";
import { RunSupervisor } from "../run/supervisor";
import { readTranscript } from "../run/transcript";
import { PolicyDecisions } from "../policy/service";
import {
  DEFAULT_UPLOAD_LIMITS,
  readUploadParts,
  type ReadUpload,
  type UploadLimits,
} from "../upload/uploads";

/** What the browser API needs to know about this installation. */
export interface BrowserApiConfig {
  /**
   * The one directory the folder picker may look inside, already `realpath`'d.
   *
   * Configuration, not a request parameter: a browser can narrow its view of the
   * filesystem but never widen it.
   */
  readonly workspaceRoot: string;
  /**
   * How long a live connection may go without sending a frame. Defaults to
   * `LIVE_HEARTBEAT`.
   *
   * **For tests, and the reason is worth stating so nobody mistakes it for a knob.** The
   * claim that needs checking is that an *idle* connection stays open past the listener's
   * own idle timeout because the heartbeat keeps it warm — the thing that was broken, and
   * broken in a way only a real socket shows. Against the real twenty-second heartbeat and
   * the real sixty-second timeout that is a minute-long test, so both are shortened
   * together and the mechanism is exercised at the same ratio. Nothing in the server passes
   * this.
   */
  readonly liveHeartbeat?: Duration.Input | undefined;
  /** How long a caught-up reader waits before reading again. Defaults to `LIVE_SWEEP`. */
  readonly liveSweep?: Duration.Input | undefined;
  /**
   * The ceiling on a rendered goal briefing, in characters. Defaults to
   * {@link DEFAULT_GOAL_BRIEFING_MAX_CHARS}.
   *
   * Real configuration, unlike the two above: `main.ts` reads
   * `GOAL_BRIEFING_MAX_CHARS` and passes it, and the number is reported back on every
   * briefing so an operator can see what is in force. A goal whose briefing exceeds it is
   * refused naming both figures, never shortened.
   */
  readonly goalBriefingMaxChars?: number | undefined;
  /**
   * The per-file ceiling on an attachment, in bytes. Defaults to 50 MiB
   * (`upload/uploads.ts`'s `DEFAULT_UPLOAD_MAX_BYTES`), for a message's files and the goal
   * attach route's alike.
   *
   * Real configuration, like {@link goalBriefingMaxChars}: `main.ts` reads
   * `UPLOAD_MAX_BYTES` and passes it, and the refusal above it names this number so an
   * operator can see what is in force and decide whether to raise it. **Enforced on this
   * side and nowhere else**: the browser is never told the figure, which is why there is no
   * second copy of it to keep in step and why a hand-made request is refused by exactly the
   * same check the composer's upload is.
   */
  readonly uploadMaxBytes?: number | undefined;
  /**
   * How many files one message may carry, and one goal hold through the attach route.
   * Defaults to 100 (`DEFAULT_UPLOAD_MAX_FILES`).
   *
   * On the attach route, per goal rather than per request, which is the only reading that
   * cannot be walked past — and a bound on the prompt there: every attached file is named
   * in every message this goal's agent is sent.
   */
  readonly uploadMaxFiles?: number | undefined;
  /** The per-image ceiling, in bytes. Defaults to 10 MiB; never above {@link uploadMaxBytes}. */
  readonly uploadMaxImageBytes?: number | undefined;
  /** The ceiling on one request's files together, in bytes. Defaults to 100 MiB. */
  readonly uploadMaxTotalBytes?: number | undefined;
}

/** The upload caps in force, each the configured figure or its default (`upload/uploads.ts`). */
const uploadLimitsOf = (config: BrowserApiConfig): UploadLimits => ({
  maxImageBytes:
    config.uploadMaxImageBytes ?? DEFAULT_UPLOAD_LIMITS.maxImageBytes,
  maxFileBytes: config.uploadMaxBytes ?? DEFAULT_UPLOAD_LIMITS.maxFileBytes,
  maxFiles: config.uploadMaxFiles ?? DEFAULT_UPLOAD_LIMITS.maxFiles,
  maxTotalBytes:
    config.uploadMaxTotalBytes ?? DEFAULT_UPLOAD_LIMITS.maxTotalBytes,
});

/**
 * A message endpoint's payload as the draft and its files (A6 F9).
 *
 * A JSON body is the draft, with no files, exactly as before. A multipart body is read
 * here, under every cap, and its `message` field decoded with **the same schema** the JSON
 * body is — so a message with files is checked exactly as one without them, and nothing
 * about the files can widen what the draft may say.
 *
 * V2(chat): uploads are one request with no lifecycle — no signed upload URLs, no pending
 * state or sweep of abandoned files (they live as long as the session's directory), the
 * browser's MIME type trusted after the allow-list, no image compression, HEIC/HEIF
 * refused. Proper V2: T3's two-step upload (signed, size-pinned URL; claim on send;
 * pending sweep), byte sniffing, compression to fit the limit, HEIC conversion if wanted.
 * And uploads are read whole into memory (bounded by UPLOAD_MAX_TOTAL_BYTES); proper
 * V2 streams each part to disk as it arrives.
 */
export const messageWithFiles = <A, I>(
  payload: A | Stream.Stream<Multipart.Part, Multipart.MultipartError>,
  draft: Schema.Codec<A, I>,
  limits: UploadLimits,
): Effect.Effect<
  { readonly draft: A; readonly uploads: readonly ReadUpload[] },
  MessageUploadRefused
> =>
  Stream.isStream(payload)
    ? Effect.gen(function* () {
        const read = yield* readUploadParts(payload, limits, [MESSAGE_FIELD]);
        const field = read.fields.get(MESSAGE_FIELD);
        if (field === undefined) {
          return yield* new MessageUploadRefused({
            reason: "no_message",
            detail: `that request carries files but no '${MESSAGE_FIELD}' field, so there was no message to send them with and nothing was stored. A message with files is the message's JSON under '${MESSAGE_FIELD}' and each file under 'files'.`,
          });
        }
        const decoded = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(draft),
        )(field).pipe(
          Effect.mapError(
            (issue) =>
              new MessageUploadRefused({
                reason: "no_message",
                detail: `that request's '${MESSAGE_FIELD}' field is not a message this endpoint takes (${issue.message}), so nothing was stored or sent.`,
              }),
          ),
        );
        return { draft: decoded, uploads: read.files };
      })
    : Effect.succeed({ draft: payload, uploads: [] });

/**
 * The configuration the handlers read, as a service.
 *
 * A service rather than a closure argument so the handler groups can be declared at
 * module scope — which is where `HttpApiBuilder.group` wants them, so the route table is
 * built once — while the root they enforce is still supplied per installation, and
 * substitutable in a test without rebuilding the group.
 */
export class BrowserApiSettings extends Context.Service<
  BrowserApiSettings,
  BrowserApiConfig
>()("bit/http/BrowserApiSettings") {}

/* ── The guard ───────────────────────────────────────────────────────────────── */

/**
 * Resolves the bearer against the browser session registry.
 *
 * `HttpApiSecurity.bearer` hands an empty redacted string when the header is absent
 * rather than failing first (`HttpApiBuilder.securityDecode`), which is what lets
 * `missing` be reported as itself instead of as an unknown token. All three reasons are
 * `401`; they differ only in what the Connect screen says, and that difference is the
 * whole reason the error is typed.
 *
 * The resolved session is provided as {@link SessionActor} so a handler reads its
 * identity from the context rather than from a header it would have to trust.
 */
export const sessionGuardLayer: Layer.Layer<
  SessionGuard,
  never,
  BrowserSessions
> = Layer.effect(
  SessionGuard,
  Effect.gen(function* () {
    const sessions = yield* BrowserSessions;
    return SessionGuard.of({
      bearer: Effect.fnUntraced(function* (httpEffect, { credential }) {
        const token = Redacted.value(credential);
        if (token.length === 0) {
          return yield* new Unauthenticated({ reason: "missing" });
        }
        const lookup = yield* sessions.resolve(token);
        if (lookup._tag === "Expired") {
          return yield* new Unauthenticated({ reason: "expired" });
        }
        if (lookup._tag === "Unknown") {
          return yield* new Unauthenticated({ reason: "unknown" });
        }
        return yield* Effect.provideService(
          httpEffect,
          SessionActor,
          lookup.session,
        );
      }),
    });
  }),
);

/* ── Describing a target ─────────────────────────────────────────────────────── */

/**
 * Turns one registry row into a rail row, with real availability.
 *
 * The registry service is a parameter rather than something this reads out of the
 * context, and that is not style: a requirement yielded inside an `HttpApi` handler
 * becomes a *per-request* requirement of the route, which the web handler would then
 * demand a context for on every call. Captured once when the handler group is built, it
 * is a layer requirement and stays one.
 *
 * Availability is two independent questions and this answers both, because the UI has
 * one dimmed state and needs to say which one fired:
 *
 * - **The filesystem.** Is `targets/<id>/` there, is `hunt.sqlite` inside it, and — when
 *   the operator recorded one — is the engagement's own folder still there? A target
 *   whose directory was deleted stays listed and dimmed. It is never dropped: the
 *   registry row is the last remaining record that the engagement happened, and a list
 *   that silently shrinks is how an operator loses track of what they tested.
 * - **The schema.** Did the last sweep migrate that file? `never_migrated` is separate
 *   from `schema_unavailable` because they need different answers: one has not been
 *   looked at, the other was looked at and refused.
 *
 * The filesystem is checked first. A missing folder explains a missing schema, so
 * reporting the schema state of a directory that is not there would be misleading.
 *
 * `lastActivityAt` is the newest mtime of the target's database or its directory. That is
 * the honest meaning of "last activity" without opening the file: when something last
 * wrote to this target. It falls back to `createdAt` so the column is never blank.
 */
export const describeTarget = Effect.fnUntraced(function* (
  fleet: FleetStore["Service"],
  row: TargetRow,
) {
  const dataDirectory = fleet.paths.targetDirectory(row.targetId);
  const huntFile = `${dataDirectory}/${HUNT_FILE}`;
  const state = yield* fleet.schemaState(row.targetId);

  const folderPresent = directoryExists(dataDirectory);
  const databasePresent = fileExists(huntFile);
  const workspacePresent =
    row.workspacePath === undefined ? true : directoryExists(row.workspacePath);

  const lastActivityAt = Math.max(
    row.createdAt,
    lastWrittenAt(huntFile) ?? 0,
    lastWrittenAt(dataDirectory) ?? 0,
  );

  const base = {
    id: row.targetId,
    name: row.name,
    scopeNote: row.scopeNote,
    workspacePath: row.workspacePath ?? null,
    dataDirectory,
    createdAt: row.createdAt,
    archivedAt: row.archivedAt ?? null,
    lastActivityAt,
    appliedThrough: state?.appliedThrough ?? null,
  };

  if (!folderPresent) {
    return {
      ...base,
      available: false,
      unavailableReason: "folder_missing",
      detail: `${dataDirectory} is not on disk. Nothing has been deleted from the registry; this target becomes readable again as soon as the folder is back.`,
    } satisfies TargetSummary;
  }
  if (!databasePresent) {
    return {
      ...base,
      available: false,
      unavailableReason: "database_missing",
      detail: `${huntFile} is not there. The target's folder exists but holds no database.`,
    } satisfies TargetSummary;
  }
  if (!workspacePresent) {
    return {
      ...base,
      available: false,
      unavailableReason: "workspace_missing",
      detail: `${row.workspacePath ?? ""} is not on disk. What this target recorded is intact; the folder it was about is gone.`,
    } satisfies TargetSummary;
  }
  if (state === undefined) {
    return {
      ...base,
      available: false,
      unavailableReason: "never_migrated",
      detail:
        "no fleet sweep has looked at this target in this installation; restart the server to sweep it",
    } satisfies TargetSummary;
  }
  if (state.state !== "ready") {
    return {
      ...base,
      available: false,
      unavailableReason: "schema_unavailable",
      detail: state.detail,
    } satisfies TargetSummary;
  }
  return {
    ...base,
    available: true,
    unavailableReason: null,
    detail: state.detail,
  } satisfies TargetSummary;
});

/**
 * The registry row for a target that can be opened, or the refusal that says why not.
 *
 * Extracted because two routes now have to agree about it — `GET /targets/:id` and
 * `POST /targets/:id/runs` — and "reading a target is refused for these reasons but
 * writing to it is refused for those" is a divergence nobody would notice until an
 * operator hit it. The order is the one recorded on the `target` handler: the id before
 * any path is built, the registry before the filesystem, and {@link describeTarget}'s own
 * answer before anything is opened.
 */
/**
 * The goal this target holds under that id, or {@link GoalNotFound}.
 *
 * Extracted for the two conversation routes, which both need exactly this check and nothing
 * else from the store. Every other goal route reads something *with* the goal and does the
 * ownership check inside that read; these two read nothing from the target's own database —
 * the conversation lives in a harness and in this process's memory — so without this they
 * would answer `200` for a goal id that belongs to another target.
 *
 * `orDie` for the store itself, like every other goal route here: a target the rail said
 * was openable whose database then will not answer is not a condition a browser can act on.
 */
const ownedGoal = Effect.fnUntraced(function* (
  stores: TargetStores["Service"],
  targetId: string,
  goalId: string,
) {
  const goal = yield* withTargetStore(stores, targetId, (store) =>
    store.loadGoal(goalId),
  ).pipe(Effect.orDie);
  if (goal === undefined || goal.targetId !== targetId) {
    return yield* new GoalNotFound({
      targetId,
      goalId,
      detail: `no goal '${goalId}' is recorded in this target`,
    });
  }
  return goal;
});

const openableTarget = Effect.fnUntraced(function* (
  fleet: FleetStore["Service"],
  targetId: string,
) {
  if (!isTargetId(targetId)) {
    return yield* new TargetNotFound({
      reason: "invalid_target_id",
      targetId,
      detail:
        "a target id is 1-64 characters of lowercase a-z, 0-9, '-' or '_', starting with a letter or digit; this cannot name a target",
    });
  }
  const row = yield* fleet.target(targetId).pipe(Effect.orDie);
  if (row === undefined) {
    return yield* new TargetNotFound({
      reason: "unknown_target",
      targetId,
      detail: `no target '${targetId}' is registered on this server`,
    });
  }
  const described = yield* describeTarget(fleet, row).pipe(Effect.orDie);
  if (!described.available) {
    return yield* new TargetUnavailable({
      reason: described.unavailableReason ?? "schema_unavailable",
      targetId,
      detail: described.detail,
    });
  }
  return row;
});

/* ── Goals ───────────────────────────────────────────────────────────────────── */

// `operatorScope` — who a mutation made through the browser is recorded as — is defined
// beside `HostContext` in the store, because the run supervisor acts as the operator too.

/**
 * One stored goal as the contract's view of it, field by field.
 *
 * Not a spread: the store describes what a file holds and the contract describes a
 * screen, and a field added to either should be a compile error here instead of a number
 * that silently never arrives.
 */
const goalView = (goal: StoredGoal): GoalView => ({
  goalId: goal.goalId,
  targetId: goal.targetId,
  name: goal.name,
  description: goal.description,
  status: goal.status,
  createdAt: goal.createdAt,
  endedAt: goal.endedAt,
  endedBy: goal.endedBy,
  endReason: goal.endReason,
  counts: {
    intents: goal.intentCount,
    attempts: goal.attemptCount,
    observations: goal.observationCount,
  },
});

/**
 * One stored asset as the Assets screen reads it.
 *
 * Field by field rather than by spreading the row, for `goalView`'s reason: the store
 * describes a table and the contract describes a screen, and this is where a divergence
 * becomes a compile error instead of a silently missing field. It is also where the
 * snake_case the file holds becomes the camelCase the browser API speaks.
 */
const assetView = (
  asset: StoredAssetWithProvenance,
  scope: ScopeState,
): AssetView => ({
  scope,
  assetId: asset.id,
  // The column is `TEXT` with a `CHECK`, so the store types it as `string`; the contract
  // narrows it to the two kinds. A third value in the column would be a row the schema
  // already refuses, and this cast is what keeps the view's type honest about that.
  kind: asset.kind === "endpoint" ? "endpoint" : "host",
  identity: asset.identity,
  host: asset.host,
  port: asset.port,
  scheme: asset.scheme,
  method: asset.method,
  path: asset.path,
  firstSeenAt: asset.first_seen_at,
  discoveries: asset.discoveries,
  firstAttemptId: asset.first_attempt_id,
  firstIntentId: asset.first_intent_id,
  lastDiscoveredAt: asset.last_discovered_at,
  imports: asset.imports,
  firstSourceUrl: asset.first_source_url,
});

/**
 * One target's scope as the Scope tab reads it, with the block the agent would get.
 *
 * `promptBlock` comes from `renderScopeBlock` — the same function both prompt paths call
 * — rather than from anything assembled here. That is what makes the preview panel's
 * claim true: it is the bytes an agent would be given, not a second rendering of the same
 * lists. The `worker` variant is previewed because it is the longer of the two; the
 * planner's differs only in dropping the `record_asset` line.
 */
const scopeView = (scope: {
  readonly entries: readonly ScopeEntry[];
  readonly hostLabels: readonly HostScopeLabel[];
  readonly assetLabels: readonly {
    readonly label: AssetScopeLabel;
    readonly identity: string;
    readonly host: string;
  }[];
}): ScopeView => ({
  entries: scope.entries.map((entry) => ({
    entryId: entry.entryId,
    effect: entry.effect,
    kind: entry.kind,
    value: entry.value,
    source: entry.source,
    note: entry.note,
    createdAt: entry.createdAt,
  })),
  hostLabels: scope.hostLabels.map((label) => ({
    host: label.host,
    state: label.state,
    reason: label.reason,
    setBy: label.setBy,
    setAt: label.setAt,
  })),
  assetLabels: scope.assetLabels.map((labelled) => ({
    assetId: labelled.label.assetId,
    identity: labelled.identity,
    state: labelled.label.state,
    reason: labelled.label.reason,
    setBy: labelled.label.setBy,
    setAt: labelled.label.setAt,
  })),
  promptBlock:
    renderScopeBlock({
      scope: {
        entries: scope.entries,
        hostLabels: scope.hostLabels,
        assetLabels: scope.assetLabels,
      },
      audience: "worker",
    }) ?? null,
});

/**
 * What a refused scope change becomes at the HTTP surface.
 *
 * The store's `MutationError` reasons do not map one-to-one, and the translation is the
 * point rather than an inconvenience: `conflict` from `addScopeEntry` is always D2's
 * contradiction, and it becomes its own reason so the Scope tab can give it the one
 * danger-red banner in the screen. An `invalid` that names a missing row becomes
 * `not_found`, because "you typed something unparseable" and "that entry is gone" are
 * different problems with different next actions.
 *
 * **Which of the two it is comes off `MutationError.absent`, not out of the sentence.**
 * This function used to sniff `detail` for "nothing was removed" and "is not an asset
 * of", which made the HTTP status a property of the store's prose: rewording a refusal
 * for an operator would silently have moved a 404 to a 400, with nothing failing
 * anywhere. The store sets a typed field on the refusals that are about a row that is not
 * there, and this reads that.
 */
const scopeRefusal = (error: MutationError): ScopeRefused => {
  if (error.reason === "conflict") {
    return new ScopeRefused({
      reason: "contradiction",
      detail: error.detail,
    });
  }
  return new ScopeRefused({
    reason: error.absent === true ? "not_found" : "invalid",
    detail: error.detail,
  });
};

/**
 * What a refused mutation becomes at the HTTP surface, for the goal routes.
 *
 * `invalid` is "no such goal here" — a missing id or one from another target.
 *
 * `conflict` is **not** taken to mean "already ended", because the store raises it for two
 * different things: a goal that is already `met` or `abandoned`, and an operation id
 * reused with different input. The error carries only a reason and a sentence, and
 * matching on the sentence would be the kind of check that rots silently, so the claim is
 * checked against the row instead: the goal is read again, and `already_ended` is said
 * only if it really is no longer active (ending is one-way, so a conflict that was about
 * the ending is always still true when it is re-read). The other `conflict` is unreachable
 * today, because the handler mints a fresh operation id for every request; if that ever
 * stops being true it arrives here as a defect, which is honest, rather than as a 409 that
 * tells an operator their goal was already ended when it was not.
 *
 * The other two reasons cannot be reached from these routes: `unauthorized` and `stale`
 * are about a worker's credential, and a browser has none. They are defects if they ever
 * appear, because mapping them to a refusal an operator can act on would be inventing a
 * situation.
 *
 * Exported for its test: the unreachable branch cannot be driven over HTTP.
 */
export const goalRefusal = (
  store: Pick<ObservationStore["Service"], "loadGoal">,
  targetId: string,
  goalId: string,
  error: MutationError,
) =>
  Effect.gen(function* () {
    if (error.reason === "invalid") {
      return yield* new GoalNotFound({
        targetId,
        goalId,
        detail: error.detail,
      });
    }
    if (error.reason === "conflict") {
      const goal = yield* store.loadGoal(goalId);
      if (goal !== undefined && goal.status !== "active") {
        return yield* new GoalRefused({
          reason: "already_ended",
          goalId,
          detail: error.detail,
        });
      }
    }
    return yield* Effect.die(error);
  });

/**
 * One stored intent as the contract's view of it, field by field.
 *
 * Not a spread, for the reason {@link goalView} is not. The suggestion is carried as a
 * suggestion — its own sub-object, every field nullable — so a client has no way to
 * mistake it for what ran; that is the attempt's.
 */
const intentView = (intent: StoredIntent): IntentView => ({
  intentId: intent.intentId,
  goalId: intent.goalId,
  question: intent.question,
  status: intent.status,
  anchoredTo: intent.anchoredTo,
  addressesDimension: intent.addressesDimension,
  createdAt: intent.createdAt,
  claimedByAttemptId: intent.claimedByAttemptId,
  suggestion: {
    instanceId: intent.suggestion.instanceId,
    model: intent.suggestion.model,
    modelOptions: intent.suggestion.modelOptions,
  },
  attempts: intent.attemptCount,
});

/**
 * One stored round as the contract's view of it, field by field.
 *
 * Not a spread, for {@link goalView}'s reason. `intentsAdded` is not a column — the store
 * counts the round's own `add_intent` receipts — which is why it arrives beside the row
 * rather than on it.
 */
const planRoundView = (
  round: StoredRound & { readonly intentsAdded: number },
): PlanRoundView => ({
  roundId: round.roundId,
  goalId: round.goalId,
  targetId: round.targetId,
  status: round.status,
  disposition: round.disposition,
  dispositionRationale: round.dispositionRationale,
  budget: round.budget,
  intentsAdded: round.intentsAdded,
  harnessSessionId: round.harnessSessionId,
  instanceId: round.harnessInstanceId,
  providerId: round.providerId,
  modelId: round.modelId,
  startedAtSequence: round.startedAtSequence,
  startedAt: round.startedAt,
  endedAt: round.endedAt,
});

/**
 * What a refused `addIntent` becomes at the HTTP surface.
 *
 * The handler has already established that the goal exists in this target, so the refusals
 * left are the store's anchoring rule's, and they arrive as `invalid`: "the submission does
 * not resolve against stored state". That is all `IntentRefused.reason` claims, and the
 * store's sentence — which names what the offending id actually is and how to correct it —
 * is passed through unchanged for the operator to read.
 *
 * `conflict` (an operation id reused), `unauthorized` (a goal from another target) and
 * `stale` (a worker's revoked credential) cannot be reached from this route: the handler
 * mints a fresh operation id, checks the goal against the target first, and a browser holds
 * no credential. They are defects if they ever appear, because a refusal an operator could
 * act on would be an invented one. Exported for its test; the unreachable branch cannot be
 * driven over HTTP.
 */
export const addIntentRefusal = (error: MutationError) =>
  error.reason === "invalid"
    ? Effect.fail(
        new IntentRefused({ reason: "invalid", detail: error.detail }),
      )
    : Effect.die(error);

/**
 * What a refused `abandonIntent` becomes, for the abandon route.
 *
 * `invalid` is "no such intent here" — a missing id or another target's, the only two
 * things the store gives it for on this operation.
 *
 * `conflict` is **not** taken to mean "not abandonable", for the reason {@link goalRefusal}
 * gives: the store raises it for an operation id reused with different input as well. So
 * the claim is checked against the row — `not_abandonable` is said only if the intent is
 * really no longer `open` or `proposed` when re-read. Anything else is a defect.
 */
export const abandonRefusal = (
  store: Pick<ObservationStore["Service"], "intent">,
  targetId: string,
  intentId: string,
  error: MutationError,
) =>
  Effect.gen(function* () {
    if (error.reason === "invalid") {
      return yield* new IntentNotFound({
        targetId,
        intentId,
        detail: error.detail,
      });
    }
    if (error.reason === "conflict") {
      const intent = yield* store.intent(intentId);
      if (
        intent !== undefined &&
        intent.status !== "open" &&
        intent.status !== "proposed"
      ) {
        return yield* new IntentRefused({
          reason: "not_abandonable",
          detail: error.detail,
        });
      }
    }
    return yield* Effect.die(error);
  });

/* ── Deriving an id ──────────────────────────────────────────────────────────── */

/**
 * Turns an operator's name into a target id, or returns `undefined` if it cannot.
 *
 * A target id is a directory name and `isTargetId` is the only gate on it, so this
 * produces a *candidate* and lets that gate decide. Lowercasing and replacing runs of
 * anything else with a single `-` is enough for the names people actually type; what it
 * deliberately does not do is silently fall back to a generated id, because an operator
 * who typed `../etc` should be told their name was refused rather than handed a target
 * called `target-7`.
 */
export const toTargetId = (name: string): string | undefined => {
  const candidate = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return isTargetId(candidate) ? candidate : undefined;
};

/* ── Handlers ────────────────────────────────────────────────────────────────── */

const sessionHandlers = HttpApiBuilder.group(
  BitApi,
  "session",
  Effect.fn(function* (handlers) {
    const sessions = yield* BrowserSessions;
    return handlers.handleAll({
      /**
       * A refused password is a typed `401`; a database fault is a `500`.
       *
       * `Effect.catchTag` rather than `orDie` over the whole effect, because the two
       * failures must not collapse into one: the first is an answer the Connect screen
       * renders against the password field, and the second is this server being broken,
       * which no field on that screen can usefully describe.
       */
      open: ({ payload }) =>
        sessions.open(payload.password).pipe(
          Effect.map((issued) => ({
            token: Redacted.value(issued.token),
            issuedAt: issued.session.issuedAt,
            expiresAt: issued.session.expiresAt,
          })),
          Effect.catchTag("DatabaseError", Effect.die),
        ),
    });
  }),
);

const fleetHandlers = HttpApiBuilder.group(
  BitApi,
  "fleet",
  Effect.fn(function* (handlers) {
    const fleet = yield* FleetStore;
    const config = yield* BrowserApiSettings;
    // Yielded once, here, where the group is built — not inside a handler. A requirement
    // resolved per request becomes a per-request requirement of the route; resolved here
    // it is a layer requirement, which is what the caller provides once at startup.
    const stores = yield* TargetStores;
    // Same reason, same place: the supervisor holds the fiber map for the whole process,
    // so resolving it per request would be asking for a second one.
    const supervisor = yield* RunSupervisor;
    // And the resolver holds the built harnesses — for OpenCode, a child process. One per
    // process, resolved here, for exactly the reason the two above are.
    const harnesses = yield* HarnessResolver;
    // The plan supervisor, for the same reason and in the same place as `RunSupervisor`
    // above: it holds the fiber map for the whole process, and `main.ts` hands this layer
    // the instance the rest of the program uses rather than letting a second one be built
    // inside the router's own memo map — which would be a second credential registry and a
    // round whose bearer the MCP endpoint rejects.
    const planner = yield* PlanSupervisor;
    // The two in-process buses the live transcript's activity channel reads. Same place,
    // same reason — and for these two it is load-bearing beyond tidiness: each is a single
    // `PubSub` that the supervisor and the policy route publish into, so a second instance
    // would be a bus with a publisher and no subscriber on one side and a subscriber and no
    // publisher on the other. `main.ts` records how instances are handed across the
    // router's own memo map, and this is the second pair that depends on it.
    const narrations = yield* RunNarrations;
    const decisions = yield* PolicyDecisions;
    // The goal conversations, for the reason `PlanSupervisor` is here: it holds every live
    // goal session in this process, each with a credential that has no clock expiry, and a
    // second instance built inside the router's memo map would be a second set of sessions
    // whose grants the first one could not close.
    const conversations = yield* GoalConversations;
    // The scope importer, in the same place and for the same reason as the supervisors
    // above: it holds every live import's fiber, scope and credential, and a second
    // instance built inside the router's own memo map would mint importer credentials into
    // a registry the MCP middleware does not read — a session with a perfectly good token
    // and no tools, which is the failure `main.ts`'s header records having been observed
    // for workers.
    const importer = yield* ScopeImporter;

    /**
     * Reads or stops one import, after checking it belongs to the target in the path.
     *
     * **The target check is this function's whole reason to exist.** The progress registry
     * is keyed by import id alone, because an import id is minted here and is never
     * operator-supplied — so the registry does not need the target to find an entry, and
     * a route that passed the id straight through would answer one target's screen with
     * another target's receipt. An import whose `targetId` does not match the path is
     * reported as unknown rather than as a mismatch: a caller holding an id for a target
     * they are not asking about has no business learning that the id is real.
     */
    const readImport = Effect.fnUntraced(function* (
      targetId: string,
      importId: string,
      read: (importId: string) => Effect.Effect<ScopeImportView | undefined>,
    ) {
      if (!isTargetId(targetId)) {
        return yield* new ScopeImportNotFound({
          reason: "invalid_target_id",
          importId,
          detail:
            "a target id is 1-64 characters of lowercase a-z, 0-9, '-' or '_', starting with a letter or digit; this cannot name a target",
        });
      }
      const view = yield* read(importId);
      if (view === undefined || view.targetId !== targetId) {
        return yield* new ScopeImportNotFound({
          reason: "unknown_import",
          importId,
          detail: `no scope import '${importId}' is in progress on target '${targetId}'. An import's progress lives in this server's memory for the life of the import, so a restart forgets it — what it wrote is on the target's Assets screen either way.`,
        });
      }
      return view;
    });

    const summaries = Effect.fnUntraced(function* () {
      const rows = yield* fleet.targets();
      const summaries: TargetSummary[] = [];
      for (const row of rows) summaries.push(yield* describeTarget(fleet, row));
      return summaries;
    });

    return handlers.handleAll({
      /**
       * Confirms a session is still good, and says where the picker may look.
       *
       * The guard has already resolved the bearer by the time this runs, so reaching
       * the body at all is the answer. It exists because the web app keeps its token in
       * `sessionStorage` and has to distinguish "still signed in" from "this token is
       * stale" on a reload, and guessing from a cached screen is how an app shows an
       * operator a target list that is no longer theirs.
       */
      probe: () =>
        Effect.map(SessionActor, (actor) => ({
          sessionId: actor.sessionId,
          issuedAt: actor.issuedAt,
          expiresAt: actor.expiresAt,
          workspaceRoot: config.workspaceRoot,
          fleetRoot: fleet.paths.root,
        })),

      /** Every registered target, archived ones included, with real availability. */
      targets: () => summaries().pipe(Effect.orDie),

      /**
       * Opens one target and reads what its own database holds.
       *
       * The order is the point of this handler, and each step rules out the next step's
       * ambiguity:
       *
       * 1. **The id, before any path exists.** `isTargetId` is the only gate on a string
       *    that is about to become a directory name, and it runs here so nothing — not
       *    even a `stat` — is attempted against whatever arrived in the URL.
       * 2. **The registry.** A well-formed id nothing is registered under is a `404`
       *    naming the id, which is what a stale deep link deserves.
       * 3. **Availability, from the same check the rail uses.** {@link describeTarget}
       *    answers the filesystem and the schema questions, and an unavailable target is
       *    refused with *that* reason and *that* sentence. The list and this route cannot
       *    disagree about why a target will not open, because there is one check.
       * 4. **Then, and only then, a file is opened** — through the resolver, keyed by this
       *    target, borrowed for the length of the read and returned when it finishes.
       *
       * Step 4 can still fail: the registry can change between step 3 and step 4, and
       * `huntFileFor` re-checks. That race is reported as `schema_unavailable` with the
       * resolver's own words rather than as a `500`, because from the operator's seat it
       * is the same situation step 3 reports, discovered a moment later.
       *
       * A `DatabaseError` from the *read* is a different thing and is a defect: the file
       * opened, migrated and then failed to answer `SELECT COUNT(*)`. Nothing an operator
       * can do with that belongs on this screen.
       */
      target: Effect.fn(function* ({ params }) {
        const targetId = params.targetId;
        if (!isTargetId(targetId)) {
          return yield* new TargetNotFound({
            reason: "invalid_target_id",
            targetId,
            detail:
              "a target id is 1-64 characters of lowercase a-z, 0-9, '-' or '_', starting with a letter or digit; this cannot name a target",
          });
        }

        const row = yield* fleet.target(targetId).pipe(Effect.orDie);
        if (row === undefined) {
          return yield* new TargetNotFound({
            reason: "unknown_target",
            targetId,
            detail: `no target '${targetId}' is registered on this server`,
          });
        }

        const target = yield* describeTarget(fleet, row).pipe(Effect.orDie);
        if (!target.available) {
          return yield* new TargetUnavailable({
            // `describeTarget` sets a reason whenever it sets `available: false`; the
            // fallback keeps the two in step without a non-null assertion.
            reason: target.unavailableReason ?? "schema_unavailable",
            targetId,
            detail: target.detail,
          });
        }

        const counts = yield* withTargetStore(stores, targetId, (store) =>
          store.counts(),
        ).pipe(
          Effect.catchTag("FleetError", (error) =>
            Effect.fail(
              new TargetUnavailable({
                reason:
                  error.reason === "unknown_target"
                    ? "database_missing"
                    : "schema_unavailable",
                targetId,
                detail: error.detail,
              }),
            ),
          ),
          Effect.catchTag("DatabaseError", Effect.die),
          Effect.catchTag("StoredRowError", Effect.die),
        );

        const recoveries = yield* withTargetStore(stores, targetId, (store) =>
          store.recentRecoveries(),
        ).pipe(Effect.orDie);

        return {
          target,
          // Field by field rather than by spreading the store's own shape. The contract
          // and the store are allowed to diverge — the store counts tables, the contract
          // describes a screen — and this is where a divergence becomes a compile error
          // instead of a silently missing number.
          counts: {
            goals: counts.goals,
            intents: counts.intents,
            attempts: counts.attempts,
            unsettledAttempts: counts.unsettledAttempts,
            observations: counts.observations,
            assets: counts.assets,
            events: counts.events,
          } satisfies TargetCounts,
          recoveries: recoveries.map((recovery) => ({
            attemptId: recovery.attempt_id,
            status: recovery.status,
            disposition: recovery.disposition,
            observedStatus: recovery.observed_status,
            detail: recovery.detail,
            reconciledAt: recovery.last_reconciled_at,
          })),
        };
      }),

      /**
       * Registers a target, migrates its file, and reports what that produced.
       *
       * The order is: check the folder with the picker's own rules, derive and check the
       * id, refuse a folder that cannot host this target at all, refuse a folder that is
       * already somebody's target, register, migrate, then describe. The folder is
       * checked *first* so a permission problem is reported as a permission problem
       * rather than as a failed registration — that is the dialog's "that folder cannot
       * be read" state, and it must not be reachable only after a row has been written.
       *
       * A failed migration is **not** an error here. The row stays, the target is listed
       * as unavailable with the failure text, and its neighbours keep serving. That is
       * the fleet's partial-failure policy, ratified for creation; the reasoning is
       * recorded on `persistence/fleet.ts`.
       */
      createTarget: Effect.fn(function* ({ payload }) {
        const workspacePath = yield* checkedDirectory({
          root: config.workspaceRoot,
          path: payload.workspacePath,
        });

        const targetId = toTargetId(payload.name);
        if (targetId === undefined) {
          return yield* new TargetRefused({
            reason: "invalid_name",
            targetId: payload.name,
            // A sentence, capitalised: it is shown to the operator after a lead-in of its
            // own ("That name cannot be used."), and a lower-case fragment there read as
            // a fragment of someone else's sentence.
            detail:
              "A target's name becomes a directory name: it needs at least one letter or digit, and only a-z, 0-9, '-' and '_' are kept",
          });
        }

        /*
         * A workspace folder that would hold this target's own fleet directory.
         *
         * **Refused here because every session on such a target is refused later.** The
         * target's data lives at `fleet.paths.targetDirectory(targetId)`, and every
         * non-worker role directory — a planner round's, a goal agent's, a scope
         * import's — is made under it. `gatedRoleDirectory` (`policy/install.ts`) refuses
         * to install the gate into a role directory inside the workspace, for the reason
         * recorded there: a worker that can reach a planner's directory can tamper with
         * what constrains it. So a folder that contains this target's fleet directory
         * produces a target that cannot plan, cannot converse and cannot import — the
         * operator finds out one session at a time, starting with whichever they open
         * first, and nothing they do on the target changes the answer.
         *
         * **The containment test is `isWithin`, imported from the installer**, not a
         * prefix comparison written here. The two checks are one question asked at two
         * moments, and the failure mode of two implementations is a folder that passes
         * creation and fails every session — exactly what this refusal exists to stop.
         * `isWithin` also resolves symlinks, which a second implementation would have
         * got wrong first.
         *
         * **Only this direction is refused.** A workspace *inside* the fleet root is a
         * supported layout and the scope fixture uses it (`fixture/scopeFixture.ts`
         * nominates `<hunt root>/workspaces/<id>`): the role directories are siblings of
         * the workspace there, not inside it, and every session starts. What is refused
         * is exactly `dataDirectory` and the folders above it: a workspace above the fleet
         * root (the reported case), the fleet root itself, and the two folders inside the
         * fleet root that still hold this target's data — `<root>/targets` and
         * `<root>/targets/<id>`. "Inside the fleet root" is neither the test nor a
         * description of it, and the refusal's own sentence must not claim it is.
         *
         * **Here and not in `fleet.register`, on layering rather than on the fixtures.**
         * The registry stores a workspace path; it does not own the rule that relates one
         * to the fleet layout, and the rule needs `targetDirectory(targetId)`, which is
         * the registry's own layout being compared against its caller's argument.
         * `createTarget` is the only production caller of `register`, and `workspace_path`
         * is write-once, so the only path that can record a doomed workspace is the one
         * checked here. It is *not* true that a check in `register` would refuse the
         * fixtures: `fixture/scopeFixture.ts` nominates `<hunt root>/workspaces/<id>`,
         * which this check allows, and `spike/persistenceProof.ts` registers with no
         * `workspacePath` at all. The reason is the layering, and the fixtures are
         * evidence about neither.
         */
        const dataDirectory = fleet.paths.targetDirectory(targetId);
        const fleetInside = yield* Effect.try({
          try: () => isWithin(workspacePath, dataDirectory),
          // A path that cannot be resolved refuses rather than permits, as it does in the
          // installer: "cannot tell whether it is inside" must not read as "is not".
          catch: (cause) =>
            new TargetRefused({
              reason: "workspace_contains_fleet_root",
              targetId,
              detail: `${workspacePath} could not be compared with ${dataDirectory}, the directory this server would record this target in (${String(cause)}); refusing rather than registering a target whose sessions may all be refused later`,
            }),
        });
        if (fleetInside) {
          /*
           * The sentence says what was tested, which is **not** "inside the fleet root".
           *
           * The test is containment of this target's own directory, and the three shapes
           * that fire it do not share a simpler description: a folder above the fleet
           * root (the reported case) *contains* it, `<root>/targets` is *inside* it, and
           * the fleet root itself *is* it. The first wording said "contains this server's
           * fleet root" and advised "pick a folder outside" it, so on the reported case it
           * advised the folder it had just refused, on `<root>/targets` it asserted
           * something false, and on the fleet root it said that root contains itself. Both
           * halves are now stated against `dataDirectory`, which is the thing compared.
           *
           * The advice is necessary *and* sufficient, where "outside the fleet root" was
           * neither: the refused set is exactly `dataDirectory` and its ancestors, so a
           * folder elsewhere inside the root — `<root>/workspaces/<id>`, which the scope
           * fixture uses and which this check deliberately allows — is named as fine. The
           * `HUNT_ROOT` clause is correct for every case and is kept as it was.
           */
          return yield* new TargetRefused({
            reason: "workspace_contains_fleet_root",
            targetId,
            detail: `${workspacePath} is ${dataDirectory} — the directory this server would record this target in — or one of the folders above it, so that directory would sit inside the very folder where this target's workers run. Every planner, goal and import session runs in a directory under ${dataDirectory}, and the policy gate refuses to install into one that sits inside the workspace, so the target could be created and then do nothing. Pick a folder that is neither ${dataDirectory} nor one of the folders above it — a folder elsewhere inside ${fleet.paths.root}, such as ${fleet.paths.root}/workspaces/${targetId}, is fine — or restart this server with HUNT_ROOT set outside the folder you want to use`,
          });
        }

        const registered = yield* fleet.targets().pipe(Effect.orDie);
        const holder = registered.find(
          (row) => row.workspacePath === workspacePath,
        );
        if (holder !== undefined) {
          return yield* new TargetRefused({
            reason: "duplicate_workspace",
            targetId: holder.targetId,
            detail: `${workspacePath} is already registered as '${holder.name}'`,
          });
        }
        if (registered.some((row) => row.targetId === targetId)) {
          return yield* new TargetRefused({
            reason: "duplicate_target",
            targetId,
            detail: `a target is already registered under the id '${targetId}'; an id names a directory of recorded evidence and is never reused`,
          });
        }

        const row = yield* fleet
          .register({
            targetId,
            name: payload.name,
            scopeNote: payload.scopeNote,
            workspacePath,
          })
          .pipe(
            // `register` re-checks the id and the duplicate, so these are races rather
            // than the common path: two dialogs submitted at once. Reported as the same
            // refusals the checks above would have given.
            Effect.catchTag("FleetError", (error) =>
              error.reason === "duplicate_target"
                ? new TargetRefused({
                    reason: "duplicate_target",
                    targetId,
                    detail: error.detail,
                  })
                : error.reason === "invalid_target_id"
                  ? new TargetRefused({
                      reason: "invalid_name",
                      targetId,
                      detail: error.detail,
                    })
                  : Effect.die(error),
            ),
            Effect.catchTag("DatabaseError", Effect.die),
          );

        yield* fleet.migrateTarget(targetId).pipe(Effect.orDie);
        const target = yield* describeTarget(fleet, row).pipe(Effect.orDie);

        /*
         * The import, when links were given — and nothing else, ever.
         *
         * **This is the point where D13's load-bearing property is kept or lost.**
         * Creating a target starts no hunt: no goal, no intent, no attempt, no run. The
         * operator's review of what the importer wrote is the only control on a scope
         * scraped off a page they did not author, and that review is a real step only
         * because there is a genuine gap between the import finishing and the first
         * execution starting. Anything added here that began work — a default goal, an
         * auto-run, a "start hunting" affordance — would close that gap, and the review
         * would have to become an explicit confirmation step first.
         *
         * What is started is one agent session whose entire tool surface is three writes
         * to this target's scope and estate. It cannot test anything.
         */
        const started = yield* importer.start({
          targetId,
          targetName: payload.name,
          workspacePath,
          links: payload.programLinks ?? [],
          ...(payload.importModel === undefined
            ? {}
            : { choice: payload.importModel }),
        });
        return {
          target,
          scopeImport:
            started._tag === "started"
              ? {
                  importId: started.importId,
                  harnessInstanceId: started.harnessInstanceId,
                  model: started.model,
                }
              : null,
          importDetail: started._tag === "refused" ? started.detail : null,
        };
      }),

      /**
       * Lists one folder inside the configured root.
       *
       * The query parameter is optional and absent means the root, which is what the
       * dialog asks for when it opens. Every refusal comes straight from `folders.ts`;
       * nothing is softened here.
       */
      folders: ({ query }) =>
        listFolder({
          root: config.workspaceRoot,
          ...(query.path === undefined ? {} : { path: query.path }),
        }),

      /**
       * Starts a run against one target, and answers without waiting for it.
       *
       * The checks before the supervisor is asked are the *same* checks `target` runs,
       * in the same order and with the same words: a string that cannot name a target, a
       * well-formed id nothing is registered under, and a target the filesystem or the
       * schema says cannot be opened. Writing to a target has to be refused for exactly
       * the reasons reading it is refused, or the compose box and the rail disagree about
       * whether an engagement can be worked on.
       *
       * The engagement's own folder is where the harness session runs. It is read from the
       * registry row rather than taken from the request — the folder is a fact about the
       * target, recorded when the operator picked it — and a target registered without one
       * falls back to the picker's root, which is the only other directory this server has
       * been told it may look at.
       *
       * Everything after that belongs to {@link RunSupervisor}: by the time it returns,
       * the pre-execution policy gate is installed in the workspace, and the attempt row,
       * the harness session, the credential and the prompt are all in place, with a fiber
       * in the server's own scope owning the rest. This handler has no part in how the
       * run ends.
       *
       * **One run per engagement folder.** A second concurrent start against a folder a
       * run is already in is refused `workspace_busy`. The guard is in the supervisor
       * rather than here, because it has to hold for every caller and because it must key
       * off what is actually running rather than off rows saying so; the reasoning is on
       * `RunSupervisor`'s `claimedWorkspaces`.
       *
       * **The harness and the model are the operator's now, and both are optional.**
       * Passed through verbatim rather than validated here: whether an instance can be run
       * on is the resolver's answer (`harness_not_ready`, naming what it said) and whether
       * a model exists is the harness's, and a second copy of either check in this handler
       * would be a second thing to keep in step. Absent means the server's own default
       * instance and that instance's default model, and the response says which were used
       * either way — so a client that sends neither still gets provenance back.
       */
      startRun: Effect.fn(function* ({ params, payload }) {
        const row = yield* openableTarget(fleet, params.targetId);
        const started = yield* supervisor.start({
          targetId: row.targetId,
          workspace: row.workspacePath ?? config.workspaceRoot,
          // The intent to claim. Everything the run is *about* — the prompt, the goal, the
          // question — comes from that intent, which is why none of them is below.
          intentId: payload.intentId,
          ...(payload.instanceId === undefined
            ? {}
            : { instanceId: payload.instanceId }),
          ...(payload.model === undefined ? {} : { model: payload.model }),
          // Forwarded as sent and resolved by the supervisor against the model's own
          // descriptors, not here: this route has no harness and so cannot know what the
          // named model offers. Absent stays absent, which is how a harness is told to
          // apply its own default rather than one we chose for it.
          ...(payload.modelOptions === undefined
            ? {}
            : { modelOptions: payload.modelOptions }),
          // The target's own `evidence/` directory, which the registry already creates
          // for things that are not database rows — and which is deliberately *outside*
          // the workspace the worker runs in, so the worker cannot read the record of
          // what it was allowed to do.
          auditPath: `${fleet.paths.evidenceDirectory(row.targetId)}/${POLICY_AUDIT_FILE}`,
          title: `bit: ${row.name}`,
        });
        return started;
      }),

      /**
       * Stops one run.
       *
       * The target id in the path is checked against the run the supervisor is holding
       * rather than used to find it. Attempt ids are unique across targets, so the path
       * does not need it to resolve the run — but a stop aimed at the wrong target is a
       * mistake worth refusing rather than silently honouring, because the two ids
       * together are what a browser tab believes it is looking at.
       */
      stopRun: Effect.fn(function* ({ params }) {
        const stopped = yield* supervisor.stop(params.attemptId);
        if (stopped.targetId !== "" && stopped.targetId !== params.targetId) {
          return yield* new RunRefused({
            reason: "unknown_attempt",
            detail: `${params.attemptId} is running against target '${stopped.targetId}', not '${params.targetId}'`,
          });
        }
        return stopped;
      }),

      /** Every run this process is supervising. See the contract for why it is not scoped. */
      runs: () => supervisor.running,

      /**
       * Which harnesses this server configures, ready or not.
       *
       * Straight off the resolver, which settled the list when the layer was built: it is
       * configuration plus what this process observed bringing each one up, so there is
       * nothing to ask and no failure mode.
       *
       * **Unusable instances are included, with their reason.** `isReady` decides the
       * `ready` flag and nothing filters on it, which is the point: a picker that dropped
       * a configured harness would leave an operator with no way to find out why it is
       * missing. The `reason` is the harness's own sentence about why it would not start.
       */
      /**
       * Which model an import would run on right now (D15).
       *
       * **The rule runs here and only here**, over `harnesses.instances` — the catalogue
       * this server actually observed when it built them. `modelOption.ts`'s doctrine is
       * why it is not a constant the browser holds: a descriptor is observed at build and
       * replaced wholesale on rebuild, so a model id compiled into the create-target screen
       * would outlive the catalogue entry it names and keep offering a choice the server
       * could not honour. The picker preselects this answer instead of deriving its own,
       * which is also what keeps the screen and the import from disagreeing about what the
       * default is.
       */
      importerModel: () => {
        const choice = chooseImporterModel(harnesses.instances);
        return choice === undefined
          ? Effect.fail(
              new ImporterModelUnavailable({
                reason: "no_harness",
                detail:
                  "no agent harness on this server is ready, so there is no catalogue to resolve a model against and no import can run",
              }),
            )
          : Effect.succeed(choice);
      },

      /**
       * The agents a conversation can run as: the registry, as the chip lists it. Never
       * fails — the registry is this build's own, and it always has the importer.
       */
      agents: () =>
        Effect.succeed({
          agents: AGENTS.map(agentView),
          defaultAgentId: DEFAULT_AGENT_ID,
        }),

      /**
       * Starts one import against a target that already exists.
       *
       * The Auto-load page's write, and `createTarget`'s import step lifted out of it: the
       * same `importer.start`, on the same inputs, so an import started here is
       * indistinguishable from one started at creation. What changed is only who asks and
       * when — the operator, from the Assets page, with the target open.
       *
       * The target is checked with {@link openableTarget}, the check every other write to a
       * target's database goes through, so this refuses for the reasons reading the target
       * does. Empty links are answered as a refusal *value*, not passed through: the
       * importer's own answer to none is `none`, which on the create path means "nothing was
       * asked for" and here would be a click that appears to do nothing.
       *
       * D13 holds, for the same reason it does on `createTarget`: this starts one session
       * whose only tools write scope entries and assets. No goal, no intent, no attempt.
       */
      startScopeImport: Effect.fn(function* ({ params, payload }) {
        const row = yield* openableTarget(fleet, params.targetId);
        const links = payload.programLinks;
        if (links.length === 0) {
          return {
            scopeImport: null,
            importDetail:
              "no program links were given, so there was nothing to read",
          };
        }
        const started = yield* importer.start({
          targetId: row.targetId,
          targetName: row.name,
          workspacePath: row.workspacePath ?? null,
          links,
          ...(payload.importModel === undefined
            ? {}
            : { choice: payload.importModel }),
        });
        return {
          scopeImport:
            started._tag === "started"
              ? {
                  importId: started.importId,
                  harnessInstanceId: started.harnessInstanceId,
                  model: started.model,
                }
              : null,
          importDetail: started._tag === "refused" ? started.detail : null,
        };
      }),

      /**
       * One import's progress, for the "Loading the scope" panel.
       *
       * The id is checked against the target before anything is looked up, and an import
       * belonging to another target is `unknown_import` rather than returned — the
       * registry is keyed by import id alone, so this route is the only thing that keeps
       * one target's panel from reading another's receipt.
       */
      scopeImport: Effect.fn(function* ({ params }) {
        return yield* readImport(params.targetId, params.importId, (importId) =>
          importer.view(importId),
        );
      }),

      /**
       * The harness sessions this target's imports have run on, newest first.
       *
       * The tallies come from the target's own file, counted on read (`0024`); `running` is
       * the one field this process answers itself, from the live registry. A session counts
       * as running if **any** of its runs is: the figure is for the session, and a session
       * continued under a fresh import id is still one session.
       *
       * The registry is keyed by import id and `readImport` checks an id against its target
       * before answering. This does not need that check: the ids it asks about were read off
       * this target's own rows, so they cannot belong to another.
       */
      importerSessions: Effect.fn(function* ({ params }) {
        const row = yield* openableTarget(fleet, params.targetId);
        const sessions = yield* withTargetStore(stores, row.targetId, (store) =>
          store.importSessions(row.targetId),
        ).pipe(Effect.orDie);
        // Asked of the harness, after the rows and never instead of them: this never fails
        // and is held to a short budget, so a harness that is down costs the list its
        // titles and nothing else. `import/importerTitle.ts` says why the list waits at all.
        const titles = yield* importerSessionTitles({
          resolver: harnesses,
          sessions,
        });
        return {
          sessions: yield* Effect.forEach(sessions, (session) =>
            Effect.map(
              Effect.forEach(session.importIds, (importId) =>
                importer.view(importId),
              ),
              (views) => ({
                sessionId: session.harnessSessionId,
                harnessInstanceId: session.harnessInstanceId,
                model: session.model,
                openedAt: session.openedAt,
                title: titles.get(session.harnessSessionId) ?? null,
                running: views.some((view) => view?.status === "running"),
                endedAt: session.endedAt,
                endedReason: session.endedReason,
                importId: session.latestImportId,
                agentId: session.agentId,
                tally: {
                  entriesIn: session.entriesIn,
                  entriesOut: session.entriesOut,
                  assets: session.assets,
                },
              }),
            ),
          ),
        };
      }),

      /**
       * Opens a conversation with the importer, its first turn the operator's message.
       *
       * **Not `startScopeImport` with empty links**, which that route answers "nothing was
       * asked for". The operator's message is what was asked for here, and the importer's
       * `start` treats it so (the importer conversation design, S3.4). The model pick is
       * passed exactly as `startScopeImport` passes it.
       */
      openImporterConversation: Effect.fn(function* ({ params, payload }) {
        const row = yield* openableTarget(fleet, params.targetId);
        // The target first, so a request for one this server does not hold is a 404 before
        // a byte of its body is read.
        const { draft, uploads } = yield* messageWithFiles(
          payload,
          ImporterConversationDraft,
          uploadLimitsOf(config),
        );
        /*
         * The agent the chip chose, resolved here where its id was read, so one this server
         * does not define is refused before anything is opened — never quietly opened as the
         * default. Its authority is checked by the importer's `startWith`, on every open path.
         */
        const agent =
          draft.agentId === undefined ? undefined : agentById(draft.agentId);
        if (draft.agentId !== undefined && agent === undefined) {
          return yield* new ImporterConversationRefused({
            reason: "agent_unavailable",
            detail: unknownAgentDetail(draft.agentId),
          });
        }
        return yield* importer.converse({
          targetId: row.targetId,
          targetName: row.name,
          workspacePath: row.workspacePath ?? null,
          text: draft.text,
          ...(agent === undefined ? {} : { agent }),
          ...(uploads.length === 0 ? {} : { uploads }),
          ...(draft.importModel === undefined
            ? {}
            : { choice: draft.importModel }),
        });
      }),

      /**
       * Says something to one import's session (S3).
       *
       * The target is checked first, as every route here checks it; the import is checked
       * against the target by the importer, which reads its row from this target's own file
       * — so an id belonging to another target is `unknown_import`, never delivered.
       */
      sendImporterMessage: Effect.fn(function* ({ params, payload }) {
        const row = yield* openableTarget(fleet, params.targetId);
        const { draft, uploads } = yield* messageWithFiles(
          payload,
          ImporterMessageDraft,
          uploadLimitsOf(config),
        );
        return yield* importer.send({
          targetId: row.targetId,
          importId: params.importId,
          text: draft.text,
          ...(uploads.length === 0 ? {} : { uploads }),
          ...(draft.urgency === undefined ? {} : { urgency: draft.urgency }),
        });
      }),

      /**
       * Stops the turn running in one import's session, and keeps the conversation (A6 F5).
       *
       * The target is checked here and the import inside the importer, against this target's
       * own file, as a message is: an id of another target is a `404`, never stopped. Not
       * `stopScopeImport`, which ends the import's authority; this leaves it open.
       */
      stopImporterTurn: Effect.fn(function* ({ params }) {
        const row = yield* openableTarget(fleet, params.targetId);
        return yield* importer.stopTurn({
          targetId: row.targetId,
          importId: params.importId,
        });
      }),

      /**
       * Whether a turn, or background work, is running in one import's session (A6 U6). The
       * target is checked here and the import inside the importer, as a Stop's are.
       */
      importerActivity: Effect.fn(function* ({ params }) {
        const row = yield* openableTarget(fleet, params.targetId);
        return yield* importer.activity({
          targetId: row.targetId,
          importId: params.importId,
        });
      }),

      /**
       * One import session's conversation, replayed from the harness (S6).
       *
       * The target is checked here and the import inside the importer — which reads the row
       * from this target's own file — so a stale deep link, or an id belonging to another
       * target, is a `404` rather than a `200` about somebody else's session. After that
       * this route **cannot fail**: every way of having no prose is one of
       * `ImporterConversationSource`'s five answers with a sentence, and for a session last
       * opened weeks ago "the harness has deleted it" is the expected answer rather than a
       * fault.
       *
       * Three things it says that no other route can. `live` is whether *this process* holds
       * the session. `continuation` is whether the next message will continue it, resume it,
       * open a new one, or be refused — asked of the harness, with the same function `send`
       * acts on, so the composer this enables is one that will work. And `source: "absent"`
       * is an import whose session was never created, which is a different fact from a
       * conversation whose words are gone.
       */
      /**
       * Moves one import's session onto another model of its harness (A6 F4).
       *
       * The target is checked here and everything else in the importer, which reads the
       * import's row from this target's own file: an id of another target is a `404`, and a
       * model outside the row's harness instance's catalogue is refused before the harness
       * is asked anything.
       */
      switchImporterModel: Effect.fn(function* ({ params, payload }) {
        const row = yield* openableTarget(fleet, params.targetId);
        return yield* importer.switchModel({
          targetId: row.targetId,
          importId: params.importId,
          model: payload.model,
          ...(payload.modelOptions === undefined
            ? {}
            : { modelOptions: payload.modelOptions }),
        });
      }),

      importerMessages: Effect.fn(function* ({ params }) {
        const row = yield* openableTarget(fleet, params.targetId);
        /*
         * The import's own row, read here rather than inside the importer.
         *
         * `transcript`'s arrangement one route up, and for its two reasons. It is where the
         * harness session id and the pinned instance live, which is what the read needs. And
         * it is what tells an import this target does not hold — a genuine mistake, refused —
         * from an import whose prose is gone, which is the *normal* end state of anything old
         * enough and answers `200` with a sentence. The row also carries a third thing
         * neither of those is: `confirmedAt`, which is null for an import whose session was
         * never created, where nothing was ever said.
         */
        const session = yield* withTargetStore(stores, row.targetId, (store) =>
          store.importSession(params.importId),
        ).pipe(Effect.orDie);
        if (session === undefined || session.targetId !== row.targetId) {
          return yield* new ScopeImportNotFound({
            reason: "unknown_import",
            importId: params.importId,
            detail: `no scope import '${params.importId}' is recorded on target '${row.targetId}', so there is no conversation to read`,
          });
        }
        return yield* importer.replay({
          targetId: row.targetId,
          importId: params.importId,
          recorded: {
            harnessSessionId: session.harnessSessionId,
            harnessInstanceId: session.harnessInstanceId,
            endedReason: session.endedReason,
            confirmedAt: session.confirmedAt,
            agentId: session.agentId,
          },
        });
      }),

      /**
       * Stops one import, keeping everything it has already written.
       *
       * The same target check, and the same refusal for an import of another target: a
       * stop is a mutation, and a route that would stop any import given its id would let
       * one target's screen reach into another's work.
       */
      stopScopeImport: Effect.fn(function* ({ params }) {
        return yield* readImport(params.targetId, params.importId, (importId) =>
          importer.stop(importId),
        );
      }),

      harnesses: () =>
        Effect.succeed(
          harnesses.instances.map((listing): HarnessInstanceView => ({
            instanceId: listing.instance.instanceId,
            driver: listing.instance.driver,
            displayName: listing.instance.displayName,
            version: listing.instance.version,
            ready: isReady(listing),
            ...(listing.reason === undefined ? {} : { reason: listing.reason }),
            ...(listing.setup === undefined ? {} : { setup: listing.setup }),
            auth: listing.instance.auth,
            isDefault: listing.isDefault,
            defaultModel: listing.instance.defaultModel,
            models: listing.instance.models,
          })),
        ),

      /**
       * One past attempt's transcript, asked of the harness now. This server keeps no copy.
       *
       * The attempt row is read first, for two reasons that are not the same. It is where
       * the harness session id and the pinned instance live, which is what the read needs.
       * And it is what tells an attempt this target does not hold — a genuine mistake,
       * refused — from an attempt whose transcript is gone, which is the *normal* end state
       * of anything old enough and answers 200 with `source: "absent"`.
       *
       * Everything after that is `run/transcript.ts`, which keeps three answers apart: the
       * harness has it (`harness`), the harness does not hold it (`absent`), and the harness
       * could not be asked (`unreachable`).
       */
      transcript: Effect.fn(function* ({ params }) {
        const row = yield* openableTarget(fleet, params.targetId);
        const attempt = yield* withTargetStore(stores, row.targetId, (store) =>
          store.loadAttempt(params.attemptId, row.targetId),
        ).pipe(Effect.orDie);
        if (attempt === undefined) {
          return yield* new AttemptNotFound({
            targetId: row.targetId,
            attemptId: params.attemptId,
          });
        }
        const read = yield* readTranscript({
          resolver: harnesses,
          harnessSessionId: attempt.harness_session_id,
          harnessInstanceId: attempt.harness_instance_id,
        });
        return {
          attemptId: params.attemptId,
          targetId: row.targetId,
          source: read.source,
          ephemeral: read.ephemeral,
          note: read.note,
          entries: read.entries.map((entry) => ({
            index: entry.index,
            type: entry.type,
            text: entry.text,
            ...(entry.error === undefined ? {} : { error: entry.error }),
          })),
          truncated: read.truncated,
        } satisfies AttemptTranscript;
      }),

      /**
       * Every long-running agent session on this target, of every kind that has an index.
       *
       * **A read-time union** (`http/agentSessions.ts`): the goal, importer and worker indexes
       * are read from this target's own file and folded into one shape, and what this process
       * holds is asked of its own registries — the goal conversations' and the importer's —
       * because liveness is stored nowhere. An importer session is live when this process
       * **holds** it, between turns as well as during one. All three ids a registry is asked
       * about were read off this target's rows, so no other target's session can be answered
       * for.
       */
      agentSessions: Effect.fn(function* ({ params }) {
        const row = yield* openableTarget(fleet, params.targetId);
        const read = yield* withTargetStore(stores, row.targetId, (store) =>
          Effect.all({
            goals: store.goalSessionsForTarget(row.targetId),
            importers: store.importSessions(row.targetId),
            workers: store.workerSessionsForTarget(
              row.targetId,
              WORKER_SESSIONS_LISTED,
            ),
          }),
        ).pipe(Effect.orDie);
        // "Held", not "a run is in flight": a session is open between turns (S2), and the
        // registry is the only thing that knows. Asked of every import id the session has had.
        const importers = yield* Effect.forEach(read.importers, (session) =>
          Effect.map(
            Effect.forEach(session.importIds, (importId) =>
              importer.holds(importId),
            ),
            (holds) => ({ ...session, held: holds.some(Boolean) }),
          ),
        );
        return unionAgentSessions({
          goals: read.goals,
          goalLive: conversations.live,
          importers,
          workers: read.workers,
        });
      }),

      /**
       * The open target's goals, newest first.
       *
       * Filtered by `targetId` after the read, not trusted from the file. A target's goals
       * live in that target's own database, so the filter removes nothing on a healthy
       * file; what it guards is a misfiled row, which becomes a missing goal rather than
       * another engagement's objective on this engagement's screen.
       */
      goals: Effect.fn(function* ({ params }) {
        const row = yield* openableTarget(fleet, params.targetId);
        const goals = yield* withTargetStore(stores, row.targetId, (store) =>
          store.goals(),
        ).pipe(Effect.orDie);
        return {
          goals: goals
            .filter((goal) => goal.targetId === row.targetId)
            .map(goalView),
        };
      }),

      /**
       * Every asset recorded on the open target, oldest first.
       *
       * Filtered by `targetId` after the read for the same reason the goals route is:
       * a target's assets live in that target's own database, so the filter removes
       * nothing on a healthy file; what it guards is a misfiled row, which becomes a
       * missing asset rather than another engagement's estate on this engagement's
       * screen.
       *
       * **No scope filtering, and that is the behaviour rather than an omission.** An
       * asset no in-scope entry covers is returned like any other. Hiding it is what the
       * design's goals rule out — a discovery is recorded, kept, displayed and labelled —
       * and a route that dropped rows would make the Assets screen quietly disagree with
       * `counts.assets`.
       */
      assets: Effect.fn(function* ({ params }) {
        const row = yield* openableTarget(fleet, params.targetId);
        // `assetsWithScope` is the one read that implements the D5 ladder, and it already
        // filters to this target. A handler that read the assets and the scope separately
        // and joined them here would be a second implementation of the ladder.
        const assets = yield* withTargetStore(stores, row.targetId, (store) =>
          store.assetsWithScope(row.targetId),
        ).pipe(Effect.orDie);
        return {
          assets: assets.map((entry) => assetView(entry.asset, entry.scope)),
        };
      }),

      /** One target's authored scope, and the block an agent would be given now. */
      scope: Effect.fn(function* ({ params }) {
        const row = yield* openableTarget(fleet, params.targetId);
        const scope = yield* withTargetStore(stores, row.targetId, (store) =>
          store.targetScope(row.targetId),
        ).pipe(Effect.orDie);
        return scopeView(scope);
      }),

      /**
       * Adds one entry, as the operator.
       *
       * `source: "operator"` is set here and is not in the payload: a browser that could
       * name its own source could mark a row it typed as `imported`, and the operator's
       * review of the imported list would then be reviewing the wrong rows.
       */
      addScopeEntry: Effect.fn(function* ({ params, payload }) {
        const row = yield* openableTarget(fleet, params.targetId);
        const scope = yield* withTargetStore(stores, row.targetId, (store) =>
          Effect.gen(function* () {
            yield* store
              .addScopeEntry(
                {
                  callerScope: operatorScope(row.targetId),
                  targetId: row.targetId,
                },
                {
                  effect: payload.effect,
                  kind: payload.kind,
                  value: payload.value,
                  source: "operator",
                },
              )
              .pipe(
                Effect.catchTag("MutationError", (error) =>
                  Effect.fail(scopeRefusal(error)),
                ),
              );
            return yield* store.targetScope(row.targetId);
          }),
        ).pipe(
          // Not `orDie` over the whole thing: that would turn the refusal just produced
          // into a defect. What is left to die is what an operator can do nothing about.
          Effect.catchTag("FleetError", Effect.die),
          Effect.catchTag("DatabaseError", Effect.die),
          Effect.catchTag("StoredRowError", Effect.die),
        );
        return scopeView(scope);
      }),

      removeScopeEntry: Effect.fn(function* ({ params }) {
        const row = yield* openableTarget(fleet, params.targetId);
        const scope = yield* withTargetStore(stores, row.targetId, (store) =>
          Effect.gen(function* () {
            yield* store
              .removeScopeEntry(
                {
                  callerScope: operatorScope(row.targetId),
                  targetId: row.targetId,
                },
                params.entryId,
              )
              .pipe(
                Effect.catchTag("MutationError", (error) =>
                  Effect.fail(scopeRefusal(error)),
                ),
              );
            return yield* store.targetScope(row.targetId);
          }),
        ).pipe(
          Effect.catchTag("FleetError", Effect.die),
          Effect.catchTag("DatabaseError", Effect.die),
          Effect.catchTag("StoredRowError", Effect.die),
        );
        return scopeView(scope);
      }),

      /**
       * Promotes, excludes or withdraws one label.
       *
       * Six combinations over one route — two subjects crossed with three directions —
       * dispatched here rather than at six endpoints, because the operator is using one
       * control and a route per combination would be six places for the authority
       * argument to be got wrong.
       *
       * `cleared` deletes the row. Nothing stores a cleared state: the subject goes back
       * to being decided by the entries, and the event log keeps the fact that a label was
       * withdrawn.
       */
      labelScope: Effect.fn(function* ({ params, payload }) {
        const row = yield* openableTarget(fleet, params.targetId);
        const caller = {
          callerScope: operatorScope(row.targetId),
          targetId: row.targetId,
        };
        const reason =
          payload.reason === undefined || payload.reason === ""
            ? null
            : payload.reason;
        const scope = yield* withTargetStore(stores, row.targetId, (store) =>
          Effect.gen(function* () {
            /*
             * Four branches rather than a nested conditional building one Effect.
             *
             * The two subjects' store methods answer with different shapes, so a ternary
             * chain over them produces a union of two unrelated `Effect` types that
             * inference cannot reconcile against one `catchTag`. Yielding inside each
             * branch keeps each call's own type local, and the handler's own answer —
             * the refreshed scope — is read once at the end regardless of which ran.
             */
            const subject = payload.subject;
            if (subject._tag === "host") {
              if (payload.state === "cleared") {
                yield* store
                  .clearHostScopeLabel(caller, subject.host)
                  .pipe(
                    Effect.catchTag("MutationError", (error) =>
                      Effect.fail(scopeRefusal(error)),
                    ),
                  );
              } else {
                yield* store
                  .setHostScopeLabel(caller, {
                    host: subject.host,
                    state: payload.state,
                    reason,
                  })
                  .pipe(
                    Effect.catchTag("MutationError", (error) =>
                      Effect.fail(scopeRefusal(error)),
                    ),
                  );
              }
            } else if (payload.state === "cleared") {
              yield* store
                .clearAssetScopeLabel(caller, subject.assetId)
                .pipe(
                  Effect.catchTag("MutationError", (error) =>
                    Effect.fail(scopeRefusal(error)),
                  ),
                );
            } else {
              yield* store
                .setAssetScopeLabel(caller, {
                  assetId: subject.assetId,
                  state: payload.state,
                  reason,
                })
                .pipe(
                  Effect.catchTag("MutationError", (error) =>
                    Effect.fail(scopeRefusal(error)),
                  ),
                );
            }
            return yield* store.targetScope(row.targetId);
          }),
        ).pipe(
          Effect.catchTag("FleetError", Effect.die),
          Effect.catchTag("DatabaseError", Effect.die),
          Effect.catchTag("StoredRowError", Effect.die),
        );
        return scopeView(scope);
      }),

      /**
       * Creates a goal, minting both of the identities the store needs.
       *
       * The goal id and the operation id are generated here, not taken from the request:
       * see `GoalDraft`. Because the operation id is fresh per request, the store's
       * receipt protects against a transaction being applied twice, not against an
       * operator pressing the button twice — which is two goals, as it should be.
       *
       * A refusal from the store is a defect here. The only ones it can give a freshly
       * minted id are a collision with an existing goal id (never reused, and
       * time-sortable ids do not repeat) or a receipt conflict (the operation id is also
       * fresh), so either one is this server being broken rather than anything the
       * operator did.
       */
      createGoal: Effect.fn(function* ({ params, payload }) {
        const row = yield* openableTarget(fleet, params.targetId);
        const goalId = identifier.newGoalId();
        const created = yield* withTargetStore(stores, row.targetId, (store) =>
          Effect.gen(function* () {
            yield* store.openGoal(
              {
                callerScope: operatorScope(row.targetId),
                targetId: row.targetId,
              },
              {
                operationId: identifier.prefixed("op"),
                goalId,
                name: payload.name ?? "",
                description: payload.description,
              },
            );
            return yield* store.loadGoal(goalId);
          }),
        ).pipe(Effect.orDie);
        if (created === undefined) {
          return yield* Effect.die(
            new Error(`goal ${goalId} was written and could not be read back`),
          );
        }
        return goalView(created);
      }),

      /** One goal. A goal another target holds is not found here. */
      goal: Effect.fn(function* ({ params }) {
        const row = yield* openableTarget(fleet, params.targetId);
        const goal = yield* withTargetStore(stores, row.targetId, (store) =>
          store.loadGoal(params.goalId),
        ).pipe(Effect.orDie);
        if (goal === undefined || goal.targetId !== row.targetId) {
          return yield* new GoalNotFound({
            targetId: row.targetId,
            goalId: params.goalId,
            detail: `no goal '${params.goalId}' is recorded in this target`,
          });
        }
        return goalView(goal);
      }),

      /**
       * Ends a goal as the operator.
       *
       * `endedBy` is the literal `"operator"` and nothing in the payload can change it:
       * the planner's way of ending a goal arrives with the planner and does not go through
       * this route. The store does the refusing — missing goal, another target's goal,
       * already ended — and this handler only translates, so the three can never drift
       * from what the store enforces.
       *
       * Nothing here touches the supervisor. Ending a goal records that it is over; a run
       * already going under it is left alone, and stopping one is `stopRun`'s job.
       */
      endGoal: Effect.fn(function* ({ params, payload }) {
        const row = yield* openableTarget(fleet, params.targetId);
        const ended = yield* withTargetStore(stores, row.targetId, (store) =>
          Effect.gen(function* () {
            yield* store
              .endGoal(
                {
                  callerScope: operatorScope(row.targetId),
                  targetId: row.targetId,
                },
                {
                  operationId: identifier.prefixed("op"),
                  goalId: params.goalId,
                  status: payload.status,
                  endedBy: "operator",
                  reason: payload.reason,
                },
              )
              .pipe(
                Effect.catchTag("MutationError", (error) =>
                  goalRefusal(store, row.targetId, params.goalId, error),
                ),
              );
            return yield* store.loadGoal(params.goalId);
          }),
        ).pipe(
          // Not `orDie`: that would turn the two refusals just produced into defects too.
          // What is left to die is what an operator can do nothing about — the target's
          // file failing to open or to answer, after `openableTarget` said it could.
          Effect.catchTag("FleetError", Effect.die),
          Effect.catchTag("DatabaseError", Effect.die),
          Effect.catchTag("StoredRowError", Effect.die),
        );
        if (ended === undefined) {
          return yield* Effect.die(
            new Error(
              `goal ${params.goalId} was ended and could not be read back`,
            ),
          );
        }
        return goalView(ended);
      }),

      /** The intents under one goal. A goal another target holds is not found here. */
      intents: Effect.fn(function* ({ params }) {
        const row = yield* openableTarget(fleet, params.targetId);
        const found = yield* withTargetStore(stores, row.targetId, (store) =>
          Effect.gen(function* () {
            const goal = yield* store.loadGoal(params.goalId);
            if (goal === undefined || goal.targetId !== row.targetId) {
              return undefined;
            }
            return yield* store.intentsForGoal(params.goalId);
          }),
        ).pipe(Effect.orDie);
        if (found === undefined) {
          return yield* new GoalNotFound({
            targetId: row.targetId,
            goalId: params.goalId,
            detail: `no goal '${params.goalId}' is recorded in this target`,
          });
        }
        return { intents: found.map(intentView) };
      }),

      /**
       * The digest of every observation under one goal, for choosing an anchor from.
       *
       * Read per intent and merged, because the store reads observations by intent and an
       * anchor may be any of the goal's. The merge is by the store's own sequence, so the
       * order is the order they were recorded in whichever intent they sit under. Only the
       * fields a choice needs are mapped (see `GoalObservationView`): this is not a second
       * way to read an observation.
       */
      goalObservations: Effect.fn(function* ({ params }) {
        const row = yield* openableTarget(fleet, params.targetId);
        const found = yield* withTargetStore(stores, row.targetId, (store) =>
          Effect.gen(function* () {
            const goal = yield* store.loadGoal(params.goalId);
            if (goal === undefined || goal.targetId !== row.targetId) {
              return undefined;
            }
            const intents = yield* store.intentsForGoal(params.goalId);
            const lists = yield* Effect.forEach(intents, (intent) =>
              store.observationsForIntent(intent.intentId),
            );
            return lists.flat().sort((a, b) => a.sequence - b.sequence);
          }),
        ).pipe(Effect.orDie);
        if (found === undefined) {
          return yield* new GoalNotFound({
            targetId: row.targetId,
            goalId: params.goalId,
            detail: `no goal '${params.goalId}' is recorded in this target`,
          });
        }
        return {
          observations: found.map((observation): GoalObservationView => ({
            observationId: observation.observationId,
            intentId: observation.provenance.intentId,
            testedClaim: observation.testedClaim,
            outcome: observation.outcome,
            untestedDimensions: dimensionsOf(observation).map((entry) => ({
              address: entry.address,
              text: entry.dimension,
            })),
          })),
        };
      }),

      /**
       * The briefing a planner round would be given for this goal.
       *
       * Three answers, and each is the one the caller can act on. A goal this target does
       * not hold is {@link GoalNotFound}, decided here before the briefing is built so the
       * builder's own `unknown_goal` is unreachable from this route. A briefing over the
       * ceiling is {@link GoalBriefingRefused} with both numbers and **no briefing**.
       * Otherwise it is the rendered text with its size and the ceiling beside it.
       *
       * `ObservationStore` is provided from the borrowed handle rather than read from this
       * file's context, which is the arrangement the module header describes: the only way
       * to reach a target's store here is to pass a target id to the resolver, so which
       * target a handler reads is answered by the type.
       */
      goalBriefing: Effect.fn(function* ({ params }) {
        const row = yield* openableTarget(fleet, params.targetId);
        const maxChars =
          config.goalBriefingMaxChars ?? DEFAULT_GOAL_BRIEFING_MAX_CHARS;
        const built = yield* withTargetStore(stores, row.targetId, (store) =>
          Effect.gen(function* () {
            const goal = yield* store.loadGoal(params.goalId);
            if (goal === undefined || goal.targetId !== row.targetId) {
              return undefined;
            }
            return yield* buildGoalBriefing(params.goalId, maxChars).pipe(
              Effect.map((prepared) => ({ _tag: "built", prepared }) as const),
              // Kept as a value so this route can turn it into the contract's refusal.
              // Everything else stays on the error channel for the `orDie` below, which
              // is what the sibling goal routes do with the store's own failures.
              Effect.catchTag("GoalBriefingTooLarge", (refusal) =>
                Effect.succeed({ _tag: "tooLarge", refusal } as const),
              ),
              Effect.provideService(ObservationStore, store),
            );
          }),
        ).pipe(Effect.orDie);
        if (built === undefined) {
          return yield* new GoalNotFound({
            targetId: row.targetId,
            goalId: params.goalId,
            detail: `no goal '${params.goalId}' is recorded in this target`,
          });
        }
        if (built._tag === "tooLarge") {
          const { sizeChars } = built.refusal;
          return yield* new GoalBriefingRefused({
            reason: "too_large",
            goalId: params.goalId,
            sizeChars,
            maxChars,
            detail:
              `This goal's briefing renders to ${String(sizeChars)} characters, over the ` +
              `${String(maxChars)}-character ceiling, so none was built. A planner is never ` +
              `given a shortened briefing: it would reason from a gap it could not see. ` +
              `Either raise GOAL_BRIEFING_MAX_CHARS on the server, or split this goal into ` +
              `narrower ones.`,
          });
        }
        const { briefing, rendered } = built.prepared;
        return {
          targetId: briefing.targetId,
          goalId: briefing.goalId,
          rendered,
          sizeChars: briefing.sizeChars,
          maxChars,
          preparedAtSequence: briefing.preparedAtSequence,
          intentCount: briefing.intents.length,
          observationCount: briefing.observations.length,
          omittedObservationIds: briefing.omittedObservationIds,
          truncated: briefing.truncated,
        } satisfies GoalBriefingView;
      }),

      /**
       * Adds an intent under a goal, minting both identities the store needs.
       *
       * The write is the store's existing `addIntent`: its goal and target ownership check,
       * its anchoring rule, its receipt and its event. Nothing of that is restated here.
       * The goal is looked up first only so that "no such goal" is a `GoalNotFound` before
       * the store is asked, which leaves its `invalid` meaning the anchoring family and
       * nothing else (see {@link addIntentRefusal}).
       *
       * The intent id and the operation id are minted here for the reason `createGoal`'s
       * are. The suggestion fields are forwarded only when present, so an absent one stays
       * absent in the store rather than becoming an empty opinion.
       */
      createIntent: Effect.fn(function* ({ params, payload }) {
        const row = yield* openableTarget(fleet, params.targetId);
        const intentId = identifier.newIntentId();
        const created = yield* withTargetStore(stores, row.targetId, (store) =>
          Effect.gen(function* () {
            const goal = yield* store.loadGoal(params.goalId);
            if (goal === undefined || goal.targetId !== row.targetId) {
              return undefined;
            }
            yield* store
              .addIntent(
                {
                  callerScope: operatorScope(row.targetId),
                  targetId: row.targetId,
                },
                {
                  operationId: identifier.prefixed("op"),
                  goalId: params.goalId,
                  intentId,
                  question: payload.question,
                  anchorObservationIds: payload.anchorObservationIds,
                  addressesDimension: payload.addressesDimension,
                  ...(payload.suggestedInstanceId === undefined
                    ? {}
                    : { suggestedInstanceId: payload.suggestedInstanceId }),
                  ...(payload.suggestedModel === undefined
                    ? {}
                    : { suggestedModel: payload.suggestedModel }),
                  ...(payload.suggestedModelOptions === undefined
                    ? {}
                    : {
                        suggestedModelOptions: payload.suggestedModelOptions,
                      }),
                },
              )
              .pipe(Effect.catchTag("MutationError", addIntentRefusal));
            return yield* store.intent(intentId);
          }),
        ).pipe(
          Effect.catchTag("FleetError", Effect.die),
          Effect.catchTag("DatabaseError", Effect.die),
          Effect.catchTag("StoredRowError", Effect.die),
        );
        if (created === undefined) {
          // Reached for the missing-goal case (the `undefined` above) and, in principle,
          // for an intent that was written and could not be read back; the goal is read
          // again to tell which, so the 404 is only ever said of a goal that is not there.
          const goal = yield* withTargetStore(stores, row.targetId, (store) =>
            store.loadGoal(params.goalId),
          ).pipe(Effect.orDie);
          if (goal === undefined || goal.targetId !== row.targetId) {
            return yield* new GoalNotFound({
              targetId: row.targetId,
              goalId: params.goalId,
              detail: `no goal '${params.goalId}' is recorded in this target`,
            });
          }
          return yield* Effect.die(
            new Error(
              `intent ${intentId} was written and could not be read back`,
            ),
          );
        }
        return intentView(created);
      }),

      /**
       * Abandons an open intent as the operator. The store does the refusing — missing,
       * another target's, claimed, answered, already abandoned — and this handler only
       * translates, through {@link abandonRefusal}, so the two cannot drift.
       */
      abandonIntent: Effect.fn(function* ({ params, payload }) {
        const row = yield* openableTarget(fleet, params.targetId);
        const abandoned = yield* withTargetStore(
          stores,
          row.targetId,
          (store) =>
            Effect.gen(function* () {
              yield* store
                .abandonIntent(
                  {
                    callerScope: operatorScope(row.targetId),
                    targetId: row.targetId,
                  },
                  {
                    operationId: identifier.prefixed("op"),
                    intentId: params.intentId,
                    reason: payload.reason,
                  },
                )
                .pipe(
                  Effect.catchTag("MutationError", (error) =>
                    abandonRefusal(store, row.targetId, params.intentId, error),
                  ),
                );
              return yield* store.intent(params.intentId);
            }),
        ).pipe(
          Effect.catchTag("FleetError", Effect.die),
          Effect.catchTag("DatabaseError", Effect.die),
          Effect.catchTag("StoredRowError", Effect.die),
        );
        if (abandoned === undefined) {
          return yield* Effect.die(
            new Error(
              `intent ${params.intentId} was abandoned and could not be read back`,
            ),
          );
        }
        return intentView(abandoned);
      }),

      /**
       * Opens one planner round on a goal, and answers without waiting for it.
       *
       * The checks before the supervisor is asked are `startRun`'s, in the same order and
       * for the same reason: writing to a target is refused exactly where reading it is.
       * The goal is then checked here so that "no such goal in this target" is a
       * {@link GoalNotFound} before anything is claimed — the supervisor's own
       * `goal_not_found` covers the same case, and having it decided here keeps the 404
       * and the 409 from both being plausible answers to one mistake.
       *
       * Everything after that is {@link PlanSupervisor}: by the time it returns, the goal
       * briefing has been rendered and measured against the ceiling, the `planner_rounds`
       * row exists, the goal claim is held, the round's own directory is gated, a
       * round-scoped credential is minted and the **planner** MCP endpoint is registered
       * under it, and the prompt has been accepted. This handler has no part in how the
       * round ends.
       *
       * **Nothing in the request chooses where the round runs.** The planning directory
       * comes from the registry, keyed by the round id the supervisor mints; the audit path
       * is the target's `evidence/` directory, which is deliberately outside it; and the
       * workspace is passed only so the containment check can refuse a planning directory
       * inside the engagement folder. `row.workspacePath ?? undefined` is explicit because
       * that check does not run for a caller who omits the field — `undefined` here says
       * "this target has no folder", which is a statement rather than an omission.
       *
       * `GoalBriefingTooLarge` is turned into the same {@link GoalBriefingRefused} the
       * briefing route answers with, so an operator meets one refusal for one fact; the
       * round started nothing when it is raised. `FleetError`'s `invalid_role_id` reaches
       * here already mapped — the supervisor's own `refuse` turns it into
       * `planning_directory_unusable` rather than letting it default to a missing target —
       * which matters because this file routes an unhandled reason to `Effect.die`.
       */
      plan: Effect.fn(function* ({ params }) {
        const row = yield* openableTarget(fleet, params.targetId);
        const goal = yield* withTargetStore(stores, row.targetId, (store) =>
          store.loadGoal(params.goalId),
        ).pipe(Effect.orDie);
        if (goal === undefined || goal.targetId !== row.targetId) {
          return yield* new GoalNotFound({
            targetId: row.targetId,
            goalId: params.goalId,
            detail: `no goal '${params.goalId}' is recorded in this target`,
          });
        }
        return yield* planner
          .start({
            targetId: row.targetId,
            goalId: params.goalId,
            workspace: row.workspacePath ?? undefined,
            auditPath: `${fleet.paths.evidenceDirectory(row.targetId)}/${POLICY_AUDIT_FILE}`,
            title: `bit planner: ${row.name}`,
            briefingMaxChars:
              config.goalBriefingMaxChars ?? DEFAULT_GOAL_BRIEFING_MAX_CHARS,
          })
          .pipe(
            Effect.catchTag("GoalBriefingTooLarge", (refusal) =>
              Effect.fail(
                new GoalBriefingRefused({
                  reason: "too_large",
                  goalId: params.goalId,
                  sizeChars: refusal.sizeChars,
                  maxChars: refusal.maxChars,
                  detail:
                    `This goal's briefing renders to ${String(refusal.sizeChars)} characters, over the ` +
                    `${String(refusal.maxChars)}-character ceiling, so no planner round was opened and ` +
                    `nothing was started. A planner is never given a shortened briefing: it would reason ` +
                    `from a gap it could not see. Either raise GOAL_BRIEFING_MAX_CHARS on the server, or ` +
                    `split this goal into narrower ones.`,
                }),
              ),
            ),
          );
      }),

      /**
       * The planner rounds of one goal, newest first, with what each concluded.
       *
       * The rows, read through the same goal-ownership check the sibling goal routes use.
       * `intentsAdded` comes with each row from the store, which counts the round's own
       * `add_intent` receipts — so a round that stopped because its budget ran out is
       * distinguishable from one that stopped because it had nothing more to say.
       */
      goalRounds: Effect.fn(function* ({ params }) {
        const row = yield* openableTarget(fleet, params.targetId);
        const found = yield* withTargetStore(stores, row.targetId, (store) =>
          Effect.gen(function* () {
            const goal = yield* store.loadGoal(params.goalId);
            if (goal === undefined || goal.targetId !== row.targetId) {
              return undefined;
            }
            return yield* store.roundsForGoal(params.goalId);
          }),
        ).pipe(Effect.orDie);
        if (found === undefined) {
          return yield* new GoalNotFound({
            targetId: row.targetId,
            goalId: params.goalId,
            detail: `no goal '${params.goalId}' is recorded in this target`,
          });
        }
        return { rounds: found.map(planRoundView) };
      }),

      /**
       * One goal's planner narration, replayed from the harness.
       *
       * The other half of `goalRounds`, and the half this build cannot promise: narration
       * is never stored (the spec's decision 14), so the prose comes from the harness's own
       * retention and each round says which of the four answers it got
       * (`plan/roundNarration.ts`). Nothing here is an error — a goal whose rounds the
       * harness has entirely deleted is a `200` with four `forgotten` rounds and four
       * sentences saying so.
       *
       * **Newest rounds first into the budget, oldest first out of it.** The rows arrive
       * newest first, the newest `GOAL_NARRATION_ROUND_LIMIT` of them are the ones worth a
       * harness call, and the answer is reversed so it reads in the order the chat renders
       * them. `skipped` is the rest, which still have their separators and dispositions
       * from `goalRounds`.
       *
       * The reads run concurrently and each is bounded by its own fetch timeout, so eight
       * rounds cost one slow harness rather than eight. `Effect.forEach` with
       * `concurrency: "unbounded"` is safe at this width because the width *is* the limit
       * above.
       */
      goalNarration: Effect.fn(function* ({ params }) {
        const row = yield* openableTarget(fleet, params.targetId);
        const found = yield* withTargetStore(stores, row.targetId, (store) =>
          Effect.gen(function* () {
            const goal = yield* store.loadGoal(params.goalId);
            if (goal === undefined || goal.targetId !== row.targetId) {
              return undefined;
            }
            return yield* store.roundsForGoal(params.goalId);
          }),
        ).pipe(Effect.orDie);
        if (found === undefined) {
          return yield* new GoalNotFound({
            targetId: row.targetId,
            goalId: params.goalId,
            detail: `no goal '${params.goalId}' is recorded in this target`,
          });
        }
        const asked = found.slice(0, GOAL_NARRATION_ROUND_LIMIT);
        const replayed = yield* Effect.forEach(
          asked,
          (round) => roundNarration({ resolver: harnesses, round }),
          { concurrency: "unbounded" },
        );
        return {
          goalId: params.goalId,
          targetId: row.targetId,
          rounds: [...replayed].reverse(),
          skipped: found.length - asked.length,
          at: yield* Clock.currentTimeMillis,
        };
      }),

      /**
       * One goal's conversation, replayed from the harness.
       *
       * The goal is checked here so a stale deep link is a `404` rather than a `200` with
       * an empty conversation, exactly as `goalNarration` does. After that this route
       * **cannot fail**: every way of having no prose is one of
       * {@link GoalConversationSource}'s five answers with a sentence, and for a
       * conversation last opened weeks ago "the harness has deleted it" is the expected
       * answer rather than a fault.
       *
       * Two things it says that no other route can. `live` is whether *this process* holds
       * the session, which is false after a restart even when the words come back — so the
       * view can say the conversation is readable and not continuable. And `source:
       * "absent"` is a goal nobody has talked to, which is a different fact from a
       * conversation whose words are gone.
       */
      goalConversation: Effect.fn(function* ({ params }) {
        const row = yield* openableTarget(fleet, params.targetId);
        yield* ownedGoal(stores, row.targetId, params.goalId);
        return yield* conversations.replay({
          targetId: row.targetId,
          goalId: params.goalId,
        });
      }),

      /**
       * Says something to one goal's agent.
       *
       * `202` and no waiting: the turn is the model's to take, and what the agent says
       * arrives on the `live` stream carrying {@link LiveItem.goalId}. The same shape as
       * `plan` and `startRun` — this route makes something durable happen and answers
       * before the work it started is done.
       *
       * **The first message is the one that does the work**, and all of it is
       * {@link GoalConversations}: the goal's own directory under
       * `targets/<id>/goal/<goalId>/`, the policy gate installed into it, a session on the
       * default harness, a credential with **no clock expiry** (the spec's decision 4), the
       * goal MCP endpoint registered under that credential, and the operator's words below
       * a preamble. A later message is a second prompt into the same session, queued behind
       * whatever it is doing rather than cutting it off.
       *
       * Nothing in the request chooses any of that. The payload is the operator's text —
       * see {@link GoalMessageDraft} on why no model, harness, session or directory is
       * nameable here — and a goal this target does not hold is a `404` before a session is
       * opened for it.
       */
      sendGoalMessage: Effect.fn(function* ({ params, payload }) {
        const row = yield* openableTarget(fleet, params.targetId);
        yield* ownedGoal(stores, row.targetId, params.goalId);
        const { draft, uploads } = yield* messageWithFiles(
          payload,
          GoalMessageDraft,
          uploadLimitsOf(config),
        );
        return yield* conversations.send({
          targetId: row.targetId,
          goalId: params.goalId,
          text: draft.text,
          ...(uploads.length === 0 ? {} : { uploads }),
          ...(draft.urgency === undefined ? {} : { urgency: draft.urgency }),
        });
      }),

      /**
       * Stops the turn running in one goal's conversation, and keeps it (A6 F5).
       *
       * A goal this target does not hold is a `404` before anything is asked; the rest is
       * {@link GoalConversations.stopTurn}'s.
       */
      stopGoalTurn: Effect.fn(function* ({ params }) {
        const row = yield* openableTarget(fleet, params.targetId);
        yield* ownedGoal(stores, row.targetId, params.goalId);
        return yield* conversations.stopTurn({
          targetId: row.targetId,
          goalId: params.goalId,
        });
      }),

      /**
       * Moves one goal's conversation onto another model of its harness (A6 F4).
       *
       * A goal this target does not hold is a `404` before anything is read; the rest —
       * the pinned harness, the catalogue, the live session, the row — is
       * {@link GoalConversations.switchModel}'s.
       */
      switchGoalModel: Effect.fn(function* ({ params, payload }) {
        const row = yield* openableTarget(fleet, params.targetId);
        yield* ownedGoal(stores, row.targetId, params.goalId);
        return yield* conversations.switchModel({
          targetId: row.targetId,
          goalId: params.goalId,
          model: payload.model,
          ...(payload.modelOptions === undefined
            ? {}
            : { modelOptions: payload.modelOptions }),
        });
      }),

      /**
       * Attaches files to one goal, where its agent can read them.
       *
       * **The one route on this API whose body is not JSON.** It is `multipart/form-data`,
       * and the `asMultipartStream` declaration on {@link GoalUploadDraft} means `payload`
       * is the parser's own `Stream<Multipart.Part, MultipartError>` — **nothing has been
       * read, and nothing is anywhere on disk, when this handler starts**. `collectUploads`
       * below is the consumer, and it is hand-written because it has to be: the buffered
       * `asMultipart` shape stages every part in a temporary directory and needs a real
       * `FileSystem`, which this build has no implementation of, so it answers an empty
       * `500`. That contract records the measurement. The shape this one forces is better
       * anyway — the per-file cap stops the read instead of refusing bytes already written.
       *
       * **Everything the browser sent is input, not instruction.** There is no path in the
       * request and none in the answer: the bytes go under
       * `targets/<id>/goal/<goalId>/uploads/`, which {@link GoalConversations.attach}
       * obtains through `gatedRoleDirectory` — gate first, path after — and which is
       * deliberately not the engagement folder, because concurrent workers share that one
       * (DECISIONS.md §24.2). The filename is checked against an allow-list and then again
       * as a resolved absolute path; the content type is recorded and never read.
       *
       * **And the files themselves are untrusted input that an agent will read.** The goal
       * agent opens these in a directory where it holds tools that write to the
       * investigation's record, and a document that came off the system under test can
       * contain text shaped like an instruction to it. Nothing on this seam can prevent
       * that. What the server does is state the rule in the agent's framing —
       * `plan/goalPrompt.ts`'s `GOAL_ATTACHMENT_RULE`, sent once — and name the files in a
       * block above the delimiter on every turn that has any, which is also why the list is
       * never spliced into the operator's own message. A filename is data too, and is
       * checked against an allow-list on the way out of the directory as well as in.
       *
       * **Both caps are enforced twice, on this side both times, and the two are different
       * questions.** `collectUploads` below bounds what is *read* — the count stops the
       * parser and the byte cap stops a part's content stream — so a hostile body cannot
       * fill memory. {@link GoalConversations.attach} then bounds what is *stored*, with
       * the count measured against the whole goal rather than this request. This handler's
       * part is to pass the configured figures to both.
       */
      uploadGoalFiles: Effect.fn(function* ({ params, payload }) {
        const row = yield* openableTarget(fleet, params.targetId);
        yield* ownedGoal(stores, row.targetId, params.goalId);
        const limits = uploadLimitsOf(config);
        const maxBytes = limits.maxFileBytes;
        const maxFiles = limits.maxFiles;
        /*
         * The body, read here and bounded while it is read.
         *
         * The goal is checked **first**, above, so a request aimed at a goal this target
         * does not hold is a 404 before a byte of its body is consumed. Only then is the
         * parser's stream drained, with both caps applied as it goes.
         */
        const files = yield* collectUploads(payload, {
          maxBytes,
          maxFiles,
          maxImageBytes: limits.maxImageBytes,
          maxTotalBytes: limits.maxTotalBytes,
        });
        return yield* conversations.attach({
          targetId: row.targetId,
          goalId: params.goalId,
          files,
          maxBytes,
          maxFiles,
        });
      }),

      /**
       * Stops one planner round.
       *
       * Two checks before the supervisor is asked, and they answer two different questions.
       * The **row** says whether this goal has such a round at all — a `RoundNotFound` if
       * not, which is a request built from the wrong pieces. The **fiber map** says whether
       * this process is driving it, and that is the supervisor's own `unknown_round`: the
       * ordinary answer for a round that already settled, and for a row a dead process left
       * for the startup sweep. Deciding the first here keeps the 404 and the 409 from both
       * being plausible answers to one mistake, exactly as `plan` does for the goal.
       *
       * The row is re-read **after** the stop rather than before, because the stop is what
       * makes it true: by the time the supervisor returns, the harness has been asked to
       * interrupt, the status is `interrupted`, the credential is revoked and the write
       * fence is superseded. A row read before would be the running one.
       */
      stopRound: Effect.fn(function* ({ params }) {
        const row = yield* openableTarget(fleet, params.targetId);
        const before = yield* withTargetStore(stores, row.targetId, (store) =>
          store.loadRound(params.roundId),
        ).pipe(Effect.orDie);
        if (
          before === undefined ||
          before.targetId !== row.targetId ||
          before.goalId !== params.goalId
        ) {
          return yield* new RoundNotFound({
            targetId: row.targetId,
            goalId: params.goalId,
            roundId: params.roundId,
            detail: `no planner round '${params.roundId}' is recorded under goal '${params.goalId}' in this target`,
          });
        }
        yield* planner.stop(params.roundId);
        const settled = yield* withTargetStore(stores, row.targetId, (store) =>
          store.roundsForGoal(params.goalId),
        ).pipe(Effect.orDie);
        const found = settled.find((round) => round.roundId === params.roundId);
        if (found === undefined) {
          // The row was there a moment ago and the stop succeeded, so its disappearance is
          // not something an operator can act on. Nothing deletes a round row.
          return yield* Effect.die(
            new Error(
              `planner round ${params.roundId} was stopped and could not be read back`,
            ),
          );
        }
        return planRoundView(found);
      }),

      /**
       * Every planner round this process is supervising. See the contract for why it is
       * not scoped to a target and why it is not the same question as `goalRounds`.
       */
      rounds: () => planner.running,

      /**
       * One target's live transcript, as Server-Sent Events.
       *
       * The handler is three steps and the order is the same one every other route on this
       * target uses, for the same reason:
       *
       * 1. {@link openableTarget} — the id, the registry, then availability, with the
       *    rail's own words. Watching a target is reading it, so it is refused for exactly
       *    the reasons opening it is refused.
       * 2. The store is borrowed **for the length of the connection**, not of the request.
       *    `Stream.unwrap` is what does that: it takes the scope the borrow needs and ties
       *    it to the stream's own lifetime, so the handle is returned when the browser
       *    disconnects and not a moment before. A per-request `Effect.scoped` here would
       *    have released the reference while the stream was still reading through it.
       * 3. `run/liveTranscript.ts` does the rest. It is handed one read method rather than
       *    the store, which is why its ordering claim can be tested without a listener.
       *
       * **The second open is `orDie` and that is a narrowing, not a shrug.** Step 1 has
       * already asked the registry and the filesystem; what is left is the registry
       * changing between step 1 and step 2, which `GET /targets/:id` reports as
       * `schema_unavailable` because it can still answer with a body. This endpoint cannot:
       * by the time a frame could say so the response is a 200 with an open stream, and a
       * transcript that reported a resolver race as though it were the run's own news would
       * be worse than a connection that fails.
       *
       * **Attribution for the policy gate's decisions is done here**, because this is where
       * the target is known. The gate's request carries a harness session id and nothing
       * else — the hook is a plugin inside the harness process — so a decision is matched
       * against the runs this supervisor is holding *for this target*, and one whose
       * session does not appear there is dropped rather than attributed to a guess. That
       * also means a decision answered after its attempt settled does not appear; the
       * audit file beside the engagement still has it.
       */
      live: Effect.fn(function* ({ params, query }) {
        const row = yield* openableTarget(fleet, params.targetId);
        return Stream.unwrap(
          Effect.map(
            // See the handler's note: the typed refusals are step 1's, and a failure here
            // is the resolver racing itself.
            Effect.orDie(stores.open(row.targetId)),
            (store) =>
              liveTranscript({
                targetId: row.targetId,
                // `orDie` on the read for the reason `run/liveTranscript.ts` records on its
                // error channel: the file is open and migrated by now, so a failing
                // `SELECT … FROM events` is this server being broken rather than anything a
                // transcript can usefully say.
                events: (after, limit) =>
                  Effect.orDie(store.eventsAfter(after, limit)),
                // The *event log's* counter. `currentSequence` is the observations' own and
                // would report the record as ending wherever the observations do.
                latestSequence: Effect.orDie(store.currentEventSequence),
                narrations,
                decisions,
                attemptForSession: (harnessSessionId) =>
                  Effect.map(
                    supervisor.running,
                    (running) =>
                      running.find(
                        (held) =>
                          held.targetId === row.targetId &&
                          held.harnessSessionId === harnessSessionId,
                      )?.attemptId,
                  ),
                ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
                // Only a client that asked: `live.ts`, "Partial items".
                partials: query.partials === "1",
                // Both default inside `liveTranscript`; an installation passes neither.
                ...(config.liveHeartbeat === undefined
                  ? {}
                  : { heartbeat: config.liveHeartbeat }),
                ...(config.liveSweep === undefined
                  ? {}
                  : { sweep: config.liveSweep }),
              }),
          ),
        );
      }),
    });
  }),
);

/**
 * The browser API as routes, ready to merge onto the control plane's router.
 *
 * Requires only `HttpRouter.HttpRouter`: the platform services `HttpApiBuilder` needs
 * (`Path`, `HttpPlatform`, `FileSystem`, `Etag.Generator`) are provided here, and the
 * handler groups' own dependencies are provided by the caller through `FleetStore`,
 * `BrowserSessions` and `TargetStores`.
 *
 * {@link TargetStores} is a requirement rather than something built here, because the
 * resolver caches open database handles and must therefore be *one* instance owned by the
 * process's scope. Building it inside this function would give the HTTP layer a private
 * set of handles on the same files as everyone else's — two writers per target, which is
 * the one thing a single-writer database makes expensive.
 */
export const browserApiRoutes = (options: BrowserApiConfig) =>
  HttpApiBuilder.layer(BitApi).pipe(
    Layer.provide([sessionHandlers, fleetHandlers]),
    Layer.provide(sessionGuardLayer),
    Layer.provide(Layer.succeed(BrowserApiSettings, options)),
    Layer.provide(HttpServer.layerServices),
  );
