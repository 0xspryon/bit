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
  GoalNotFound,
  GoalRefused,
  RunRefused,
  SessionActor,
  SessionGuard,
  TargetNotFound,
  TargetRefused,
  TargetUnavailable,
  Unauthenticated,
  type AttemptTranscript,
  type GoalView,
  type HarnessInstanceView,
  type TargetCounts,
  type TargetSummary,
} from "@bit/contracts";
import {
  Context,
  Effect,
  Layer,
  Redacted,
  Stream,
  type Duration,
} from "effect";
import { HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

import {
  checkedDirectory,
  directoryExists,
  fileExists,
  lastWrittenAt,
  listFolder,
} from "./folders";
import { BrowserSessions } from "./browserSessions";
import {
  FleetStore,
  HUNT_FILE,
  isTargetId,
  type TargetRow,
} from "../persistence/fleet";
import * as identifier from "../persistence/identifier";
import type {
  MutationError,
  ObservationStore,
  StoredGoal,
} from "../persistence/store";
import { TargetStores, withTargetStore } from "../persistence/targetStores";
import { POLICY_AUDIT_FILE } from "../policy/install";
import { HarnessResolver, isReady } from "../harness/resolver";
import { liveTranscript } from "../run/liveTranscript";
import { RunNarrations } from "../run/narration";
import { RunSupervisor } from "../run/supervisor";
import { readTranscript } from "../run/transcript";
import { PolicyDecisions } from "../policy/service";

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
}

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

/**
 * Who a goal mutation made through the browser is recorded as.
 *
 * `<targetId>/operator` follows the scope namespacing the spec settles — `targetId/<attemptId>`
 * for a worker, and later `targetId/round/…` and `targetId/goal/…` for the planner and the
 * goal agent — so the operator is one more author in the same space and cannot collide with
 * an attempt: attempt ids are `att_…`. It is the host's own authority and is supplied here,
 * by the process that owns the session guard, never read from a payload.
 */
const operatorScope = (targetId: string): string => `${targetId}/operator`;

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
    // The two in-process buses the live transcript's activity channel reads. Same place,
    // same reason — and for these two it is load-bearing beyond tidiness: each is a single
    // `PubSub` that the supervisor and the policy route publish into, so a second instance
    // would be a bus with a publisher and no subscriber on one side and a subscriber and no
    // publisher on the other. `main.ts` records how instances are handed across the
    // router's own memo map, and this is the second pair that depends on it.
    const narrations = yield* RunNarrations;
    const decisions = yield* PolicyDecisions;

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
       * id, refuse a folder that is already somebody's target, register, migrate, then
       * describe. The folder is checked *first* so a permission problem is reported as a
       * permission problem rather than as a failed registration — that is the dialog's
       * "that folder cannot be read" state, and it must not be reachable only after a
       * row has been written.
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
            detail:
              "a target's name becomes a directory name: it needs at least one letter or digit, and only a-z, 0-9, '-' and '_' are kept",
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
        return yield* describeTarget(fleet, row).pipe(Effect.orDie);
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
          // Where the settled attempt's transcript lands. The same directory the audit
          // file below sits in, and outside the workspace for the same reason.
          evidenceDirectory: fleet.paths.evidenceDirectory(row.targetId),
          // The target's own `evidence/` directory, which the registry already creates
          // for things that are not database rows — and which is deliberately *outside*
          // the workspace the worker runs in, so the worker cannot read the record of
          // what it was allowed to do.
          auditPath: `${fleet.paths.evidenceDirectory(row.targetId)}/${POLICY_AUDIT_FILE}`,
          // One instruction becomes all three, because that is all the operator has given
          // us. The shortfall is recorded on the contract's `RunDraft`: choosing which
          // intent a run belongs to is the work of the flow that shows intents.
          goal: payload.instruction,
          question: payload.instruction,
          task: payload.instruction,
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
       * One past attempt's transcript: ours if we kept one, the harness's if we did not.
       *
       * The attempt row is read first, for two reasons that are not the same. It is where
       * the harness session id and the pinned instance live, which is what the fallback
       * needs. And it is what tells an attempt this target does not hold — a genuine
       * mistake, refused — from an attempt with no transcript, which is the *normal* end
       * state of anything old enough and answers 200 with `source: "absent"`.
       *
       * Everything after that is `run/transcript.ts`: prefer our own artefact, fall back to
       * the harness and label it as the thing that may be gone, and never present the two
       * as equal-status data.
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
          directory: fleet.paths.evidenceDirectory(row.targetId),
          attemptId: params.attemptId,
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
          ...(read.path === undefined ? {} : { path: read.path }),
          ...(read.contentHash === undefined
            ? {}
            : { contentHash: read.contentHash }),
          ...(read.writtenAt === undefined
            ? {}
            : { writtenAt: read.writtenAt }),
        } satisfies AttemptTranscript;
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
