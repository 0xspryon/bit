/**
 * Whether a conversation this process no longer holds can be carried on, and where.
 *
 * One function, asked by every surface that has a conversation: the scope importer (S6,
 * through `import/importerHistory.ts`'s `importerReopen`), the goal agent (S7, through
 * `plan/goalConversation.ts`), and the restart sweep that dispatches a continuation into
 * either of them (`recovery/continuation.ts`). It was the importer's alone until S7 needed
 * the same decision one surface along, and the extraction is the point: a second resume
 * would be a second place deciding whether an agent may run in a directory this server did
 * not gate, and the second one is the one nobody reviews.
 *
 * ## It never fails, and every uncertainty resolves to `fresh`
 *
 * A fresh session always works; a resume that was promised and then refused is a message
 * the operator loses. So a harness that cannot be asked, a transcript that was swept, a
 * session killed before its first prompt, and a directory this server does not gate are
 * all `fresh`, each with the reason in its own sentence.
 *
 * ## The directory check, which is about authority rather than about resuming
 *
 * Both drivers resolve a conversation through the directory the session was created in —
 * OpenCode through the session's stored directory, answering `LocationNotFoundError` for
 * one that is gone, and Claude Code through the project its `cwd` belongs to. That much is
 * S2.5's caveat, and verifying it costs one comparison.
 *
 * The *reason* to verify is stronger than the caveat. **The directory is the session's
 * authority boundary** — OpenCode keeps its MCP set per directory, and the role-directory
 * check (`harness/roleDirectory.ts`) is of this path — so a resume into a directory this
 * server did not make is an agent among registrations nobody checked. (It also held the
 * pre-execution policy gate until that was removed, 2026-11-06.)
 * The path the harness reports is therefore not merely checked for existence: it has to be
 * recognised by the caller as one of *its own* role directories, rebuilt through
 * `FleetPaths` and compared. Nothing is parsed out of the path and trusted — that is
 * {@link SessionReopenInput.gatedRoleId}'s whole contract, and a caller that cannot
 * recognise the path says so by answering `undefined`.
 *
 * A harness that reports no directory at all is `fresh` for the same reason: there is
 * nothing to match, and "we could not tell where it runs" is not permission to resume into
 * it. The directory does not have to *exist* — the caller's own `ensure…Directory` recreates
 * a swept one and reinstalls the gate, which is also the answer to OpenCode's
 * `LocationNotFoundError`.
 */
import { Effect } from "effect";

import type { AgentHarness } from "./agentHarness";

/**
 * What a message to a conversation this process does not hold will do.
 *
 * `roleId` is the id of the role directory the **harness** resolves the session in, which
 * is not necessarily the id the caller is working under: an importer's successor has a new
 * import id while the session still runs in the original import's directory. The gate goes
 * where the harness runs the session, so that is the id the caller must gate.
 */
export type SessionReopen =
  | {
      readonly _tag: "resume";
      readonly sessionId: string;
      readonly roleId: string;
      /** The harness's own sentence about what it still holds. */
      readonly detail: string;
    }
  | { readonly _tag: "fresh"; readonly detail: string };

export interface SessionReopenInput {
  readonly harness: AgentHarness["Service"];
  readonly sessionId: string;
  /**
   * The role id this directory belongs to, or `undefined` for a path this caller does not
   * recognise as one of its own gated directories.
   *
   * The caller rebuilds the path from the id it reads out and compares; it never trusts a
   * segment it merely parsed. See this module's header.
   */
  readonly gatedRoleId: (directory: string) => string | undefined;
  /**
   * What this surface's directories are called in the refusal sentence — "import
   * directories", "goal directories". Operator-facing prose, so it is the surface's word
   * rather than a generic one.
   */
  readonly directoryWords: string;
}

export const sessionReopen = Effect.fnUntraced(function* (
  input: SessionReopenInput,
) {
  const asked = yield* Effect.result(
    input.harness.sessionContinuation(input.sessionId),
  );
  if (asked._tag === "Failure") {
    return {
      _tag: "fresh",
      detail: `the harness could not be asked whether it still holds session ${input.sessionId} — ${asked.failure.message}`,
    } as const satisfies SessionReopen;
  }
  if (asked.success._tag === "unresumable") {
    return {
      _tag: "fresh",
      detail: asked.success.detail,
    } as const satisfies SessionReopen;
  }
  const directory = asked.success.directory;
  if (directory === undefined) {
    return {
      _tag: "fresh",
      detail: `the harness still holds session ${input.sessionId} but did not say which directory it resolves it in, and a session is only resumed into a directory this server has gated`,
    } as const satisfies SessionReopen;
  }
  const roleId = input.gatedRoleId(directory);
  return roleId === undefined
    ? ({
        _tag: "fresh",
        detail: `the harness still holds session ${input.sessionId}, but it resolves it in '${directory}', which is not one of this target's own ${input.directoryWords} — so it is not a directory this server gates, and the session is not resumed into it`,
      } as const satisfies SessionReopen)
    : ({
        _tag: "resume",
        sessionId: input.sessionId,
        roleId,
        detail: asked.success.detail,
      } as const satisfies SessionReopen);
});

/**
 * {@link SessionReopenInput.gatedRoleId} for a surface whose directories are
 * `<…>/<role>/<roleId>`, which is every one of them (`persistence/fleet.ts`).
 *
 * The id is taken from the last segment and then **thrown away as a string**: the path is
 * rebuilt from it through the caller's own `FleetPaths` function and compared, so a path
 * that merely looks like one of ours is refused. `isRoleDirectoryId` is checked first,
 * because `FleetPaths` throws on an id it will not build a path from.
 */
export const roleDirectoryMatcher =
  (input: {
    readonly isRoleId: (value: string) => boolean;
    readonly rebuild: (roleId: string) => string;
  }): ((directory: string) => string | undefined) =>
  (directory) => {
    const segment = directory.slice(directory.lastIndexOf("/") + 1);
    return input.isRoleId(segment) && input.rebuild(segment) === directory
      ? segment
      : undefined;
  };
