/**
 * The server-side folder picker, and the only place a browser's path reaches the
 * filesystem.
 *
 * The roadmap's Day 3 boundary is explicit: "the folder picker runs server-side. The
 * browser never reads the filesystem." That makes this module an admission boundary
 * rather than a convenience — a browser hands it a string and it decides what, if
 * anything, that string is allowed to name. Everything here is a refusal first and a
 * listing second.
 *
 * **Five checks, in this order, and the order matters.**
 *
 * 1. **Absolute.** A relative path has no meaning without a working directory, and
 *    resolving it against one would silently pick a root nobody configured.
 * 2. **No `.` or `..` segment, refused as written.** The path is *not* normalised first.
 *    Normalising `/<root>/../../etc` and then range-checking it would pass anything that
 *    happens to land back inside the root, which makes the root a coincidence rather than
 *    a boundary; and it would accept a request whose author plainly meant to leave. A `..`
 *    is a refusal, not an input to simplify.
 * 3. **No symlink anywhere in the chain**, established by comparing `realpath` against
 *    the path as written. This is the check that stops the interesting attack: a symlink
 *    *inside* the root pointing out of it passes a prefix test on the literal string and
 *    fails this one.
 * 4. **Inside the configured root**, compared against the root's own `realpath` resolved
 *    once at startup. `startsWith(root)` alone would let `/hunts-elsewhere` in when the
 *    root is `/hunts`, so the comparison is against `root` or `root + "/"`.
 * 5. **A directory that exists.** Anything else is reported as what it is.
 *
 * **What gets listed.** Immediate subdirectories only, by name. `readdir` with
 * `withFileTypes` does not follow links, so a symlinked directory reports
 * `isSymbolicLink()` and is excluded by the `isDirectory()` filter rather than by a
 * second check — a link cannot be navigated into, and so is not offered. Hidden folders
 * *are* listed: the operator keeps work in `.config` and `.local` and a picker that
 * pretended otherwise would be lying about their disk. Files are not listed at all,
 * because nothing in this flow picks a file and listing them would widen what the browser
 * learns for no purpose.
 *
 * **What this deliberately does not do.** It does not say whether an entry has children,
 * which would cost a `readdir` per row and leak the shape of directories the operator has
 * not opened. It does not read any file. It does not resolve `~`.
 */
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";

import {
  PathNotFound,
  PathRefused,
  type FolderEntry,
  type FolderListing,
} from "@bit/contracts";
import { Effect } from "effect";

/** `ENOENT`, `EACCES` and friends, as Node reports them. */
const errorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  typeof (cause as { code: unknown }).code === "string"
    ? (cause as { code: string }).code
    : undefined;

/**
 * Resolves the configured root once, so every later comparison is against a real path.
 *
 * Called at startup rather than per request. If the root itself is a symlink — `/tmp` on
 * some systems, a bind-mounted home on others — resolving it here is what keeps check 3
 * from refusing every path inside it.
 *
 * A root that does not exist is a configuration fault and is left as written: the first
 * request against it will refuse with `not_found`, which says more to an operator than a
 * crash at startup would.
 */
export const resolveRoot = (configured: string): string => {
  try {
    return realpathSync(configured);
  } catch {
    return configured;
  }
};

/** Whether `path` is the root or sits beneath it. Never a bare `startsWith`. */
const withinRoot = (root: string, path: string): boolean =>
  path === root || path.startsWith(`${root}/`);

/**
 * Runs the five checks and returns the path, or the refusal that stopped it.
 *
 * Exported because target creation has to apply exactly these rules to the folder it is
 * handed, and a second copy of them would be a second chance to get one wrong.
 */
export const checkedDirectory = Effect.fnUntraced(function* (options: {
  readonly root: string;
  readonly path: string;
}) {
  const { root, path } = options;

  if (!path.startsWith("/")) {
    return yield* new PathRefused({
      reason: "not_absolute",
      path,
      detail: "a browsed path must be absolute",
    });
  }

  const segments = path.split("/");
  if (segments.includes("..") || segments.includes(".")) {
    return yield* new PathRefused({
      reason: "traversal",
      path,
      detail:
        "a path containing '.' or '..' is refused as written and never normalised",
    });
  }

  // Trailing slashes are the one normalisation applied, and only because `/a/` and `/a`
  // name the same directory on every filesystem this runs on. It happens after the
  // traversal check so `/a/../` cannot slip through as `/a/..`.
  const written = path.length > 1 ? path.replace(/\/+$/, "") : path;

  const resolved = yield* Effect.try({
    try: () => realpathSync(written),
    catch: (cause): PathRefused | PathNotFound => {
      const code = errorCode(cause);
      if (code === "ENOENT" || code === "ENOTDIR") {
        return new PathNotFound({
          reason: "not_found",
          path: written,
          detail: "no such directory",
        });
      }
      if (code === "EACCES" || code === "EPERM") {
        return new PathRefused({
          reason: "denied",
          path: written,
          detail: "the server has no permission to read that folder",
        });
      }
      return new PathRefused({
        reason: "denied",
        path: written,
        detail: `could not resolve that folder (${code ?? "unknown error"})`,
      });
    },
  });

  if (resolved !== written) {
    return yield* new PathRefused({
      reason: "symlink",
      path: written,
      detail: `that path resolves to ${resolved}; links are not followed`,
    });
  }

  if (!withinRoot(root, resolved)) {
    return yield* new PathRefused({
      reason: "outside_root",
      path: written,
      detail: `only folders inside ${root} can be browsed`,
    });
  }

  const stats = yield* Effect.try({
    try: () => statSync(resolved),
    catch: (cause): PathRefused | PathNotFound =>
      errorCode(cause) === "EACCES" || errorCode(cause) === "EPERM"
        ? new PathRefused({
            reason: "denied",
            path: resolved,
            detail: "the server has no permission to read that folder",
          })
        : new PathNotFound({
            reason: "not_found",
            path: resolved,
            detail: "no such directory",
          }),
  });

  if (!stats.isDirectory()) {
    return yield* new PathNotFound({
      reason: "not_a_directory",
      path: resolved,
      detail: "that path is not a directory",
    });
  }

  return resolved;
});

/**
 * Lists one directory inside the root, or refuses.
 *
 * `path` is the operator's request; `undefined` means the root itself, which is what the
 * dialog asks for when it opens. `parent` is `null` at the root so the picker has no
 * affordance for leaving it — the boundary is enforced here either way, but an up-arrow
 * that always refuses is a worse interface than no up-arrow.
 */
export const listFolder = Effect.fnUntraced(function* (options: {
  readonly root: string;
  readonly path?: string | undefined;
}) {
  const root = options.root;
  const requested =
    options.path === undefined || options.path.length === 0
      ? root
      : options.path;
  const directory = yield* checkedDirectory({ root, path: requested });

  const names = yield* Effect.try({
    try: () => readdirSync(directory, { withFileTypes: true }),
    catch: (cause): PathRefused =>
      new PathRefused({
        reason: "denied",
        path: directory,
        detail:
          errorCode(cause) === "EACCES" || errorCode(cause) === "EPERM"
            ? "the server has no permission to list that folder"
            : `could not list that folder (${errorCode(cause) ?? "unknown error"})`,
      }),
  });

  const entries: FolderEntry[] = names
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: directory === "/" ? `/${entry.name}` : `${directory}/${entry.name}`,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  const parent =
    directory === root ? null : directory.slice(0, directory.lastIndexOf("/"));

  return {
    root,
    path: directory,
    parent: parent === "" ? "/" : parent,
    entries,
  } satisfies FolderListing;
});

/**
 * Whether a recorded folder is still there, for the target rail's availability.
 *
 * Deliberately tolerant where {@link checkedDirectory} is strict: this answers "can the
 * operator still see their work", and a workspace that has since been moved behind a
 * symlink is present, not refused. It is also never used to build a path to open — it
 * only decides whether a row is dimmed.
 */
export const directoryExists = (path: string): boolean => {
  try {
    return lstatSync(path).isDirectory() || statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** When a path was last written, or `undefined` if it cannot be stat'd. */
export const lastWrittenAt = (path: string): number | undefined => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
};

/** Whether a plain file is there. Used to tell "no database yet" from "no folder". */
export const fileExists = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};
