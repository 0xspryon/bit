/**
 * What a harness is given for the files a message carried, and how a replay reads them back
 * (A6 F9).
 *
 * ## On every harness: one line per file
 *
 * `[Attached image "<name>" is saved at: <absolute path>]` (or `file`), appended after the
 * prompt's own text, one line each — T3's line (`provider-core/src/server/attachmentPrompt.ts`)
 * with the kind in it. That is what makes a file reachable on any harness, including one
 * that takes nothing inline: the agent has a path inside its own working directory and the
 * tools to read it. Each driver appends it through {@link withAttachmentLines}, so a new
 * harness gets it by calling one function rather than by knowing the format.
 *
 * ## Inline, where a harness takes it
 *
 * - Claude Code: an image ({@link MessageAttachment.kind} `image`) as a base64 image block
 *   before the text. Nothing else (`claudeCodeClient.ts` carries the `V2(chat):` note).
 * - OpenCode: an image, `text/plain` or a PDF as a file part (`files: [{ uri }]`), up to the
 *   20 MiB OpenCode reads (`core/src/session/prompt.ts`'s `MAX_ATTACHMENT_BYTES`).
 *
 * ## Back from a transcript
 *
 * The line is in the harness's own record of the message, so a replay reads the files from
 * it ({@link splitAttachmentLines}) and takes the lines out of the words, which is what keeps
 * a path from being drawn twice — once as text and once as the chip. That record is the
 * operator's text too, so a line is read only when it names a file stored in the session's
 * own `uploads/` folder, which the caller names; anything else stays words. The type comes
 * from OpenCode's file part when it kept one, else from the stored name — never from Claude
 * Code's image block, which the CLI re-encodes (a large PNG is stored as a JPEG).
 */
import { lstatSync } from "node:fs";
import { join } from "node:path";

import { UPLOAD_NAME_PATTERN } from "../plan/goalUploads";
import { mimeTypeOfName } from "../upload/uploads";

/** One stored file, as a harness is given it. */
export interface MessageAttachment {
  /** `image` for an allow-listed image type, `file` for everything else. */
  readonly kind: "image" | "file";
  /** The name it is stored under: sanitised, so it holds no quote or newline. */
  readonly name: string;
  readonly mimeType: string;
  /** Absolute, inside the session's working directory. */
  readonly path: string;
  readonly bytes: number;
}

/** One file a replayed message carried, as a harness transcript gives it back. */
export interface ReplayedAttachment {
  readonly kind: "image" | "file";
  readonly name: string;
  readonly mimeType: string;
  readonly path: string;
}

/** The line one file adds to a prompt. */
export const attachmentLine = (
  attachment: Pick<MessageAttachment, "kind" | "name" | "path">,
): string =>
  `[Attached ${attachment.kind} "${attachment.name}" is saved at: ${attachment.path}]`;

/** `text`, with one line per file after a blank line; `text` itself when there are none. */
export const withAttachmentLines = (
  text: string,
  attachments: readonly MessageAttachment[],
): string =>
  attachments.length === 0
    ? text
    : `${text}\n\n${attachments.map(attachmentLine).join("\n")}`;

const LINE = /^\[Attached (image|file) "([^"\n]*)" is saved at: (\/.*)\]$/;

/** The most OpenCode reads inline: its `MAX_ATTACHMENT_BYTES`. A larger file is path-only. */
export const OPENCODE_INLINE_MAX_BYTES = 20 * 1024 * 1024;

/** Whether OpenCode is given this file as a file part, beside its path line. */
export const inlinesOnOpenCode = (attachment: MessageAttachment): boolean =>
  attachment.bytes <= OPENCODE_INLINE_MAX_BYTES &&
  (attachment.kind === "image" ||
    attachment.mimeType === "text/plain" ||
    attachment.mimeType === "application/pdf");

/**
 * Where a replay may find the files a message carried: the session's own `uploads/` folder,
 * named by the caller from its own record of where the session runs — never read out of
 * the transcript. Absent, nothing in a message is read as a file.
 */
export interface AttachmentReplay {
  /** `<the session's working directory>/uploads`, absolute. */
  readonly uploadsFolder: string | undefined;
  /** The harness's own type for a path, where it kept one; the name's extension otherwise. */
  readonly mimeOf?: (
    path: string,
    kind: "image" | "file",
  ) => string | undefined;
  /**
   * Whether `path` is a stored upload. A regular file, not through a link
   * (`lstat`), by default.
   */
  readonly isStored?: (path: string) => boolean;
}

const storedFile = (path: string): boolean => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * A message's words with its trailing attachment lines taken off, and the files they name.
 *
 * A line is the server's only when **everything** about it is what {@link withAttachmentLines}
 * writes, because the text is the operator's (or a client's) and can hold anything:
 *
 * - it is in the **trailing run**, and the run follows the exact `\n\n` separator — so a line
 *   typed mid-message, or at the end without the blank line, stays their words;
 * - its path is exactly `<uploadsFolder>/<name>`, the name it quotes, and that name is one
 *   {@link UPLOAD_NAME_PATTERN} admits — so a line pointing anywhere else (an SSH key, another
 *   session's folder) is not drawn as an attachment;
 * - the file is there, a regular file ({@link AttachmentReplay.isStored}) — so a forged line
 *   naming an upload that was never stored is not drawn as one either.
 *
 * The run is read from the end and stops at the first line that fails, and the whole run
 * is refused unless the separator precedes it: anything not taken stays the operator's text,
 * byte for byte.
 */
export const splitAttachmentLines = (
  text: string,
  replay: AttachmentReplay,
): {
  readonly text: string;
  readonly attachments: readonly ReplayedAttachment[];
} => {
  const unchanged = { text, attachments: [] } as const;
  const folder = replay.uploadsFolder;
  if (folder === undefined) return unchanged;
  const isStored = replay.isStored ?? storedFile;
  const read = (line: string): ReplayedAttachment | undefined => {
    const [, kind, name, path] = LINE.exec(line) ?? [];
    if (kind === undefined || name === undefined || path === undefined) {
      return undefined;
    }
    if (!UPLOAD_NAME_PATTERN.test(name) || path !== join(folder, name)) {
      return undefined;
    }
    if (!isStored(path)) return undefined;
    const k = kind === "image" ? "image" : "file";
    return {
      kind: k,
      name,
      mimeType: replay.mimeOf?.(path, k) ?? mimeTypeOfName(name),
      path,
    };
  };
  const lines = text.split("\n");
  const attachments: ReplayedAttachment[] = [];
  let start = lines.length;
  while (start > 0) {
    const file = read(lines[start - 1] ?? "");
    if (file === undefined) break;
    attachments.unshift(file);
    start -= 1;
  }
  // `${text}\n\n${lines}`: a blank line before the run, and a line (perhaps empty) before it.
  if (attachments.length === 0 || start < 2 || lines[start - 1] !== "") {
    return unchanged;
  }
  return { text: lines.slice(0, start - 1).join("\n"), attachments };
};
