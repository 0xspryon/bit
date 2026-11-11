/**
 * Where bit's Pi sessions are stored: **where Pi keeps them** (follow-ups A, 2026-11-11).
 *
 * Pi's default for a session started in directory `cwd` is
 * `<agentDir>/sessions/--<cwd with its leading slash dropped and every / \ : made ->--/`,
 * one `<timestamp>_<id>.jsonl` per session (`getDefaultSessionDirPath`, pi-coding-agent
 * 1.5.2, `dist/core/session-manager.js`; `docs/session-format.md`). bit hands Pi exactly that
 * folder as `--session-dir`, so the session lands where it would have landed had the operator
 * started Pi there, and `pi --resume` in that directory, or `pi --session <id>`, lists and
 * opens it. Named explicitly rather than left to Pi so that an operator's `sessionDir`
 * setting or `PI_CODING_AGENT_SESSION_DIR` cannot move bit's sessions somewhere bit does not
 * look; Pi treats a `--session-dir` equal to its default as its default (`findById`'s
 * `filterCwd` is false for it).
 *
 * **Retention is Pi's, which is to say the operator's.** Pi deletes nothing on its own: a
 * session stays until the operator deletes it in Pi's resume picker (Ctrl+D) or removes the
 * file. bit keeps no copy, so a deleted file is a conversation that is gone — said as such
 * by the replay, and refused as a resume — never an error.
 *
 * Before this, bit kept its sessions in a folder of its own under the fleet root
 * (`harness/pi-sessions/<instance>`). Those files are left where they are and no longer read:
 * a conversation recorded there replays as gone, and its next message opens a new session.
 */
import { closeSync, openSync, readdirSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Pi's environment variable for its agent folder. */
const AGENT_DIR_VARIABLE = "PI_CODING_AGENT_DIR";

/**
 * The agent folder a Pi process started with `environment` uses: `PI_CODING_AGENT_DIR` when
 * it is set (Pi expands a leading `~`), else `~/.pi/agent` (`getAgentDir`).
 */
export const piAgentDir = (
  environment: Readonly<Record<string, string | undefined>>,
): string => {
  const named = environment[AGENT_DIR_VARIABLE];
  if (named !== undefined && named !== "") {
    if (named === "~") return homedir();
    if (named.startsWith("~/")) return join(homedir(), named.slice(2));
    return resolve(named);
  }
  return join(homedir(), ".pi", "agent");
};

/** The folder holding every directory's sessions: `<agentDir>/sessions`. */
export const piSessionsRoot = (agentDir: string): string =>
  join(resolve(agentDir), "sessions");

/** Pi's default session folder for sessions started in `cwd`. */
export const piSessionFolder = (root: string, cwd: string): string =>
  join(
    root,
    `--${resolve(cwd)
      .replace(/^[/\\]/, "")
      .replace(/[/\\:]/g, "-")}--`,
  );

/** How much of a file's start is read for its header line. */
const HEADER_BYTES = 64 * 1024;

/** The `id` of a session file's header line, or `undefined` when it has none. */
const headerId = (path: string): string | undefined => {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(HEADER_BYTES);
    const read = readSync(fd, buffer, 0, HEADER_BYTES, 0);
    const line = buffer.subarray(0, read).toString("utf8").split("\n")[0];
    if (line === undefined || line.trim() === "") return undefined;
    const header = JSON.parse(line) as { type?: unknown; id?: unknown };
    return header.type === "session" && typeof header.id === "string"
      ? header.id
      : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

const namesIn = (folder: string): readonly string[] => {
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
};

/** Whether the file at `path` is still `sessionId`'s: its first line is that header. */
export const isPiSessionFileOf = (path: string, sessionId: string): boolean =>
  headerId(path) === sessionId;

/**
 * Where one session's file stands:
 *
 * - `found` — Pi's file for it, with its header;
 * - `headerless` — a file under its name with **no header** (follow-ups A review, L3): the
 *   operator deleted the file while a Pi process still ran the session, and that process
 *   appended the next entries to the same path, which made a new file of entries alone. Pi
 *   itself finds sessions by their header and cannot open it either: the conversation is
 *   gone, exactly as for a deleted file;
 * - `undefined` — no file at all: never written, or deleted.
 */
export type PiSessionFileState =
  | { readonly _tag: "found"; readonly path: string }
  | { readonly _tag: "headerless"; readonly path: string };

/**
 * One session's file under `root`, found by id the way Pi finds it: a file whose header
 * names the id (`findById`). Pi names a file it creates `<timestamp>_<id>.jsonl`, so only
 * files so named are opened — every one of the operator's sessions would otherwise be read
 * per lookup. `cwd`, when known, is looked in first; without it every directory's folder is
 * searched, since a replay after a restart asks by id alone. The newest wins where several
 * match. A file so named with no header is said as `headerless` only where no file with one
 * is found ({@link PiSessionFileState}).
 */
export const locatePiSessionFile = (
  root: string,
  sessionId: string,
  cwd?: string,
): PiSessionFileState | undefined => {
  const suffix = `_${sessionId}.jsonl`;
  let headerless: string | undefined;
  const inFolder = (folder: string): string | undefined => {
    for (const path of namesIn(folder)
      .filter((name) => name.endsWith(suffix))
      .sort()
      .reverse()
      .map((name) => join(folder, name))) {
      if (isPiSessionFileOf(path, sessionId)) return path;
      headerless ??= path;
    }
    return undefined;
  };
  if (cwd !== undefined) {
    const found = inFolder(piSessionFolder(root, cwd));
    if (found !== undefined) return { _tag: "found", path: found };
  }
  for (const folder of [...namesIn(root)].sort()) {
    if (!folder.startsWith("--")) continue;
    const found = inFolder(join(root, folder));
    if (found !== undefined) return { _tag: "found", path: found };
  }
  return headerless === undefined
    ? undefined
    : { _tag: "headerless", path: headerless };
};

/**
 * One session's file with its header, or `undefined`: Pi holds no such session — it was
 * never written, or it was deleted (a headerless leftover included).
 */
export const findPiSessionFile = (
  root: string,
  sessionId: string,
  cwd?: string,
): string | undefined => {
  const state = locatePiSessionFile(root, sessionId, cwd);
  return state?._tag === "found" ? state.path : undefined;
};
