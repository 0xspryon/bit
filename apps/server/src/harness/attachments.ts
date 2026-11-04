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
 * a path from being drawn twice — once as text and once as the chip. The type comes from the
 * harness's own block when it kept one, else from the name.
 */
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
 * A message's words with its trailing attachment lines taken off, and the files they name.
 *
 * Only the **trailing run** of lines in the exact format is read — the place
 * {@link withAttachmentLines} puts them — so a line an operator typed in the middle of a
 * message stays their words. `mimeOf` is the harness's own type for a path, where it kept
 * one; the name's extension otherwise.
 */
export const splitAttachmentLines = (
  text: string,
  mimeOf: (path: string, kind: "image" | "file") => string | undefined = () =>
    undefined,
): {
  readonly text: string;
  readonly attachments: readonly ReplayedAttachment[];
} => {
  const lines = text.split("\n");
  let start = lines.length;
  while (start > 0 && LINE.test(lines[start - 1] ?? "")) start -= 1;
  if (start === lines.length) return { text, attachments: [] };
  const attachments = lines.slice(start).map((line): ReplayedAttachment => {
    const [, kind, name, path] = LINE.exec(line) ?? [];
    const k = kind === "image" ? "image" : "file";
    const p = path ?? "";
    return {
      kind: k,
      name: name ?? "",
      mimeType: mimeOf(p, k) ?? mimeTypeOfName(name ?? ""),
      path: p,
    };
  });
  return {
    text: lines.slice(0, start).join("\n").replace(/\s+$/, ""),
    attachments,
  };
};
