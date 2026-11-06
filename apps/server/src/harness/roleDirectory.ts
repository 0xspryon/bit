/**
 * The directory a non-worker session — a planner round's, a goal agent's, a scope
 * import's — runs in, and the path containment it is checked with.
 *
 * Until 2026-11-06 this lived in `policy/install.ts`, where the same function also put the
 * pre-execution policy gate into the directory. The gate was removed at the operator's
 * request (it is to be redone later; the plan's "Policy gate removed" entry names the last
 * commit that had it). What is left here was never the gate's alone:
 *
 * - **A role directory must not be inside the operator's workspace**, where workers run.
 *   A worker can read and change whatever is under its folder, so a planner's or an
 *   importer's machinery there would be the worker's to tamper with; and OpenCode keeps one
 *   MCP set per directory (`opencode-location-per-directory`), so a session nested in the
 *   workspace would see the workers' registrations. Spike B established that a *sibling*
 *   directory is a separate authority under OpenCode; it did not establish that a nested
 *   one is.
 * - **The containment test** (`isWithin`, through `resolveThroughSymlinks`), which
 *   `createTarget` and the upload store ask too.
 */
import { readlinkSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { Brand, Effect, Schema } from "effect";

import type { UncheckedRoleDirectory } from "../persistence/fleet";

/**
 * A role directory that may not be used: it sits inside the workspace, or its place could
 * not be resolved. Refuses the session; nothing has been created or granted yet.
 */
export class RoleDirectoryRefused extends Schema.TaggedError<RoleDirectoryRefused>()(
  "RoleDirectoryRefused",
  {
    directory: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `the session's directory ${this.directory} cannot be used: ${this.detail}`;
  }
}

/**
 * An absolute path with the symlinks in its **deepest existing ancestor** followed, for a
 * path whose final components may not exist yet.
 *
 * `realpathSync` alone is not enough: it throws when the final component is missing, and
 * a role directory or an upload may be a path nothing has created yet. Falling back to a
 * lexical `resolve` at that point (as an earlier version did) silently skips symlink
 * resolution for exactly the path that needs it, so a symlink defeated the containment
 * refusal. So this resolves the deepest ancestor that exists and appends the
 * components that do not. Two cases beyond that:
 *
 * - **A dangling symlink** is not "a missing component": creating a file through it makes
 *   the file at its target. When a component fails to resolve but is itself a symlink, its
 *   target is read and resolution continues from there.
 * - **Anything other than "does not exist"** (permissions, a loop, more than 40 hops)
 *   throws. The callers treat a path they cannot resolve as a refusal, because "cannot
 *   tell whether it is inside" must not read as "is not".
 *
 * **What this does not do, and why that was weighed rather than missed.**
 *
 * - It does not follow every symlink in the path. The first step is `resolve()`, which
 *   collapses `..` segments **lexically**, before any link is followed. A path that mixes a
 *   symlink with `..` (`link/../role/a.log`, where the filesystem would step out of the
 *   link's *target*, not out of the directory holding the link) therefore resolves to a
 *   different place than the filesystem would put it, and can be judged inside or outside
 *   wrongly. This is accepted because every path given to it here is built by the server
 *   (`fleetPaths`, a validated id, a configured workspace) and none contains `..`; a
 *   caller that passes a path from anywhere else must not rely on this function.
 * - It is a check at one moment. A symlink swapped in after the check, or a component
 *   created as a symlink later, is not seen. That is a race against somebody with write
 *   access to the fleet root, who could already edit its files directly, so it is accepted
 *   rather than defended.
 */
export const resolveThroughSymlinks = (path: string): string => {
  let pending = resolve(path);
  for (let hops = 0; hops < 40; hops += 1) {
    const rest: string[] = [];
    let probe = pending;
    for (;;) {
      try {
        return join(realpathSync(probe), ...rest);
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw cause;
      }
      const parent = dirname(probe);
      let link: string | undefined;
      try {
        link = readlinkSync(probe);
      } catch {
        // Not a symlink (or not there): an ordinary missing component.
      }
      if (link !== undefined) {
        pending = join(resolve(realpathSync(parent), link), ...rest);
        break;
      }
      if (parent === probe) return join(probe, ...rest);
      rest.unshift(basename(probe));
      probe = parent;
    }
  }
  throw new Error(`too many levels of symbolic links resolving ${path}`);
};

/**
 * Whether `child` is `parent` or lies inside it, both resolved as above.
 *
 * Exported for one caller beyond this file: `createTarget` (`http/browserApi.ts`) refuses
 * a workspace folder that contains this server's fleet root, because every role directory
 * under it would then be inside the workspace and {@link roleDirectory} below would
 * refuse every non-worker session on that target. The two checks are the same question
 * asked at two moments, so they share this one derivation of "inside" — including the
 * symlink resolution, which is where a second implementation would have drifted first.
 */
export const isWithin = (parent: string, child: string): boolean => {
  const relation = relative(
    resolveThroughSymlinks(parent),
    resolveThroughSymlinks(child),
  );
  return (
    relation === "" ||
    (relation !== ".." &&
      !relation.startsWith(`..${sep}`) &&
      !isAbsolute(relation))
  );
};

/**
 * A role directory that exists and is outside the workspace.
 *
 * Only {@link roleDirectory} produces one. It is still a string, so it can be handed to a
 * harness as one; the brand is what lets a function that creates a session ask for *this*
 * and so refuse the plain strings and the unchecked directories everything else is.
 */
export type RoleDirectory = string & Brand.Brand<"RoleDirectory">;
const asRoleDirectory = Brand.nominal<RoleDirectory>();

/** What preparing one non-worker role's directory needs. */
export interface RoleDirectoryInput<E> {
  /**
   * Makes the directory, idempotently. For the fleet that is
   * `FleetStore.ensurePlanningDirectory`, `ensureGoalDirectory` or `ensureImportDirectory`;
   * taken as an effect so this file has no runtime dependence on the persistence layer
   * (the import above is type-only). What it yields is deliberately not a string: see
   * {@link UncheckedRoleDirectory}.
   */
  readonly ensure: Effect.Effect<UncheckedRoleDirectory, E>;
  /**
   * The operator's folder, where workers run, or `undefined` for a target that has none.
   *
   * **Required, and explicitly `undefined` when there is none**: the containment check is
   * the only thing in this function that enforces the layout's central rule, and an
   * optional field is a check that silently does not run for the caller who forgets it.
   * Spelling out `undefined` makes a caller say "this target has no workspace" rather than
   * say nothing.
   */
  readonly workspace: string | undefined;
}

/**
 * Makes one non-worker role's directory and checks it is outside the workspace, or refuses.
 *
 * The check resolves symlinks, including through components that do not exist yet; see
 * {@link resolveThroughSymlinks} for what that does and does not cover. A check that
 * cannot resolve a path refuses rather than permits. Nothing here creates a session or
 * grants a credential; it is layout only. Idempotent.
 *
 * V2(chat): the pre-execution policy gate used to be installed here, into every role
 * directory, before the path was returned (removed 2026-11-06, operator's request). A
 * redone gate goes back in at this point, so no session can be created in a directory it
 * is not in.
 */
export const roleDirectory = <E>(
  input: RoleDirectoryInput<E>,
): Effect.Effect<RoleDirectory, E | RoleDirectoryRefused> =>
  Effect.gen(function* () {
    const directory = (yield* input.ensure).unsafePath();
    const workspace = input.workspace;
    if (workspace !== undefined) {
      const inWorkspace = yield* Effect.try({
        try: () => isWithin(workspace, directory),
        catch: (cause) =>
          new RoleDirectoryRefused({
            directory,
            detail: `could not resolve the workspace ${workspace} (${String(cause)}); refusing rather than guessing that ${directory} is outside it`,
          }),
      });
      if (inWorkspace) {
        return yield* new RoleDirectoryRefused({
          directory,
          detail: `${directory} is inside the workspace ${workspace}, where workers run; a session that is not a worker must run outside it. That workspace holds this target's own fleet directory, so no planner, goal or import session on it can start — re-create the target against a folder that does not contain this server's fleet root, or run the server with a HUNT_ROOT outside that folder`,
        });
      }
    }
    return asRoleDirectory(directory);
  });
