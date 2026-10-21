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
 * **What is deliberately absent.** No endpoint here opens a target's `hunt.sqlite`.
 * Everything the target rail shows is answerable from `control.sqlite` plus a `stat`,
 * which is what lets this run against a single `SqlClient` on the control file. Serving a
 * target's own graph needs a per-target store resolver at the request boundary, and that
 * is a later day's work; a field that needed one would have had to be faked, and a faked
 * count on the first screen is a lie the operator cannot see through.
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
  BitApi,
  SessionActor,
  SessionGuard,
  TargetRefused,
  Unauthenticated,
  type TargetSummary,
} from "@bit/contracts";
import { Context, Effect, Layer, Redacted } from "effect";
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

/** What the browser API needs to know about this installation. */
export interface BrowserApiConfig {
  /**
   * The one directory the folder picker may look inside, already `realpath`'d.
   *
   * Configuration, not a request parameter: a browser can narrow its view of the
   * filesystem but never widen it.
   */
  readonly workspaceRoot: string;
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
    });
  }),
);

/**
 * The browser API as routes, ready to merge onto the control plane's router.
 *
 * Requires only `HttpRouter.HttpRouter`: the platform services `HttpApiBuilder` needs
 * (`Path`, `HttpPlatform`, `FileSystem`, `Etag.Generator`) are provided here, and the
 * handler groups' own dependencies are provided by the caller through `FleetStore` and
 * `BrowserSessions`.
 */
export const browserApiRoutes = (options: BrowserApiConfig) =>
  HttpApiBuilder.layer(BitApi).pipe(
    Layer.provide([sessionHandlers, fleetHandlers]),
    Layer.provide(sessionGuardLayer),
    Layer.provide(Layer.succeed(BrowserApiSettings, options)),
    Layer.provide(HttpServer.layerServices),
  );
