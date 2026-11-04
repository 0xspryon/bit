/**
 * Files sent with a conversation message (A6 F9): read, checked, and stored.
 *
 * The one reader and validator for every route that takes files — the importer's two
 * message endpoints, a goal's message endpoint, and the goal attach route
 * (`plan/goalUploads.ts`, which reads through {@link readUploadParts}). A plain module with
 * no services in it, for `plan/goalUploads.ts`'s reason: each claim here — that a name
 * cannot escape the folder, that a cap is checked while the bytes are read, that a refused
 * request leaves nothing behind — is worth a test that needs no harness and no listener.
 *
 * ## The limits, and where each figure comes from
 *
 * {@link DEFAULT_UPLOAD_LIMITS} is T3's figures, decided for A6: **10 MiB per image, 50 MiB
 * per file, 100 files per message**, plus a total per request of 100 MiB that bounds what
 * one request holds in memory (the parts are read into memory before anything is written,
 * so a refused request leaves no half-stored file). Each figure can be overridden from the
 * environment — `UPLOAD_MAX_IMAGE_BYTES`, `UPLOAD_MAX_BYTES`, `UPLOAD_MAX_FILES`,
 * `UPLOAD_MAX_TOTAL_BYTES`, read by `main.ts` — and **the environment wins over the
 * default, nothing else is consulted**. Two of them meet: an image is a file too, so the
 * image cap in force is the smaller of the image cap and the file cap, and a lowered
 * `UPLOAD_MAX_BYTES` lowers both. `UPLOAD_MAX_BYTES` and `UPLOAD_MAX_FILES` are the goal
 * attach route's two variables from before A6, kept, with new defaults (they were 10 MiB and
 * 10); that route still counts `UPLOAD_MAX_FILES` against the whole goal.
 *
 * ## What is trusted
 *
 * The bytes are stored and never interpreted. The filename is **sanitised** into one the
 * folder and the prompt line can both hold ({@link sanitiseUploadName}), then checked again
 * as a resolved path. The browser's MIME type decides only whether a file goes to the model
 * as an image, after the allow-list — see the `V2(chat):` note at the message endpoints.
 */
import {
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeSync,
  constants as fsConstants,
} from "node:fs";
import { extname, isAbsolute, join, relative } from "node:path";

import {
  MESSAGE_FIELD,
  MESSAGE_FILES_FIELD,
  MESSAGE_IMAGE_MIME_TYPES,
  MessageUploadRefused,
} from "@bit/contracts";
import { Data, Effect, Stream } from "effect";
import type { Multipart } from "effect/http";

import type { MessageAttachment } from "../harness/attachments";
import { resolveThroughSymlinks } from "../policy/install";

/** The folder, inside a session's working directory, that every upload is stored in. */
export const UPLOADS_FOLDER = "uploads";

const MiB = 1024 * 1024;

/** Per image: 10 MiB (T3's `PROVIDER_SEND_TURN_MAX_IMAGE_BYTES`). */
export const DEFAULT_UPLOAD_MAX_IMAGE_BYTES = 10 * MiB;
/** Per file: 50 MiB (T3's `PROVIDER_SEND_TURN_MAX_FILE_BYTES`). */
export const DEFAULT_UPLOAD_MAX_BYTES = 50 * MiB;
/** Per message: 100 files (T3's `PROVIDER_SEND_TURN_MAX_ATTACHMENTS`). */
export const DEFAULT_UPLOAD_MAX_FILES = 100;
/**
 * Per request, all files together: 100 MiB.
 *
 * Not one of T3's figures, because T3 stages each file on disk before the message and this
 * reads a request into memory: this is the memory a request can hold. It is also under
 * Bun's own request-body ceiling of 128 MiB, which `http/controlPlane.ts` raises when an
 * operator raises this.
 */
export const DEFAULT_UPLOAD_MAX_TOTAL_BYTES = 100 * MiB;

export interface UploadLimits {
  readonly maxImageBytes: number;
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
}

export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  maxImageBytes: DEFAULT_UPLOAD_MAX_IMAGE_BYTES,
  maxFileBytes: DEFAULT_UPLOAD_MAX_BYTES,
  maxFiles: DEFAULT_UPLOAD_MAX_FILES,
  maxTotalBytes: DEFAULT_UPLOAD_MAX_TOTAL_BYTES,
};

/** The image cap in force: an image is a file too, so it is under both caps. */
export const imageCapOf = (limits: UploadLimits): number =>
  Math.min(limits.maxImageBytes, limits.maxFileBytes);

/**
 * A byte count as a person reads it, with the exact figure beside it, so a refusal is
 * checkable against a cap an operator is about to change.
 */
export const describeBytes = (bytes: number): string => {
  if (bytes < 1024) return `${String(bytes)} bytes`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let scaled = bytes / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${String(bytes)} bytes (${scaled.toFixed(1)} ${String(units[unit])})`;
};

const IMAGE_TYPES: ReadonlySet<string> = new Set(MESSAGE_IMAGE_MIME_TYPES);
const HEIC_TYPES: ReadonlySet<string> = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);

/**
 * Types by extension, for a file whose type the replay has to name from its path alone (a
 * path-only file on Claude Code) and for a browser that sent none. Small on purpose: what
 * is not here is `application/octet-stream`, which is the honest answer.
 */
const EXTENSION_TYPES: Readonly<Record<string, string>> = {
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".html": "text/html",
  ".xml": "application/xml",
  ".har": "application/json",
  ".zip": "application/zip",
};

/** The type a name's extension says, or `application/octet-stream`. */
export const mimeTypeOfName = (name: string): string =>
  EXTENSION_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";

/** What the browser said, lower-cased and without parameters, or the extension's. */
const mimeTypeOf = (name: string, contentType: string): string => {
  const declared = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return declared === "" || declared === "application/octet-stream"
    ? mimeTypeOfName(name)
    : declared;
};

/**
 * What one file is: an image the model sees, a file it is given the path of, or a HEIC/HEIF
 * image, which is refused.
 *
 * The browser's type decides, after the allow-list; the extension decides only when the
 * browser sent no type (or the generic one), which is how some browsers send a HEIC.
 */
export const classifyUpload = (
  name: string,
  contentType: string,
):
  | { readonly _tag: "image"; readonly mimeType: string }
  | { readonly _tag: "file"; readonly mimeType: string }
  | { readonly _tag: "heic" } => {
  const mimeType = mimeTypeOf(name, contentType);
  const extension = extname(name).toLowerCase();
  if (
    HEIC_TYPES.has(mimeType) ||
    extension === ".heic" ||
    extension === ".heif"
  ) {
    return { _tag: "heic" };
  }
  return IMAGE_TYPES.has(mimeType)
    ? { _tag: "image", mimeType }
    : { _tag: "file", mimeType };
};

/** The longest stored name, in characters: `plan/goalUploads.ts`'s pattern's bound. */
const NAME_MAX = 127;

/**
 * A filename the folder and the prompt line can both hold, made from the one the browser
 * sent. Never refuses: a pasted screenshot is called `image.png` and a macOS one carries a
 * narrow no-break space, and refusing either would make the feature useless.
 *
 * - Only the last path component is kept, so no name is a path (`../../x` is `x`).
 * - Compatibility-decomposed and its combining marks dropped (`résumé` is `resume`; a narrow
 *   no-break space is a space), then every character outside `A-Za-z0-9 ._()-` — control
 *   characters, quotes, brackets, newlines — becomes `_`, so a name cannot close the prompt
 *   line's quotes or start a line of its own.
 * - Leading dots and spaces are dropped, so no name is `.`, `..` or hidden; the result
 *   starts with a letter or digit, as `plan/goalUploads.ts`'s `UPLOAD_NAME_PATTERN` asks.
 * - Cut to 127 characters, keeping the extension.
 * - Nothing left is `upload`, with the extension the type names.
 *
 * Collisions are not this function's: {@link storeUploads} picks a free name at write time.
 */
export const sanitiseUploadName = (name: string, mimeType?: string): string => {
  const last = name.split(/[/\\]/).pop() ?? "";
  const cleaned = last
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^A-Za-z0-9 ._()-]/g, "_")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/[ .]+$/, "");
  const fallbackExtension =
    mimeType === undefined
      ? ""
      : (Object.entries(EXTENSION_TYPES).find(
          ([, type]) => type === mimeType,
        )?.[0] ?? "");
  const base = cleaned === "" ? `upload${fallbackExtension}` : cleaned;
  if (base.length <= NAME_MAX) return base;
  const extension = extname(base).slice(0, 16);
  return `${base.slice(0, NAME_MAX - extension.length)}${extension}`;
};

/** One file read off the wire and checked, before anything has been written. */
export interface ReadUpload {
  /** The name the browser sent, untouched. The goal attach route refuses on it. */
  readonly sentName: string;
  /** {@link sanitiseUploadName} of it: the name it will be stored under, collisions aside. */
  readonly name: string;
  readonly contentType: string;
  readonly kind: "image" | "file";
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

/** What {@link readUploadParts} read: the text fields asked for, and the files. */
export interface ReadParts {
  readonly fields: ReadonlyMap<string, string>;
  readonly files: readonly ReadUpload[];
}

/** Text fields past this many are refused: nothing here reads more than one or two. */
const MAX_FIELDS = 16;

const refused = (reason: MessageUploadRefused["reason"], detail: string) =>
  new MessageUploadRefused({ reason, detail });

/**
 * Reads a multipart body into memory, refusing as soon as a cap is passed.
 *
 * **Every cap is checked while reading**: the count stops the parser at the first file over
 * it, the file's own cap (image or file, by its type) stops its content stream the moment it
 * is passed, and the total stops the request the same way. So a file ten times the limit is
 * refused after the limit's worth of it, and the memory one request can hold is
 * {@link UploadLimits.maxTotalBytes}. A HEIC/HEIF image is refused before its bytes are read,
 * and an empty file once its stream ends.
 *
 * Text fields are kept when their key is in `fields` and ignored otherwise; a file under any
 * key but {@link MESSAGE_FILES_FIELD} is a file all the same, since nothing else could
 * carry one.
 */
export const readUploadParts = (
  stream: Stream.Stream<Multipart.Part, Multipart.MultipartError>,
  limits: UploadLimits,
  fields: readonly string[] = [],
): Effect.Effect<ReadParts, MessageUploadRefused> =>
  Effect.gen(function* () {
    const kept = new Map<string, string>();
    const files: ReadUpload[] = [];
    let fieldCount = 0;
    let total = 0;
    const imageCap = imageCapOf(limits);
    yield* Stream.runForEach(stream, (part) =>
      Effect.gen(function* () {
        if (part._tag === "Field") {
          fieldCount += 1;
          if (fieldCount > MAX_FIELDS) {
            return yield* refused(
              "unreadable_body",
              `that request carries more than ${String(MAX_FIELDS)} text fields, which no composer sends, so it was not read and nothing was stored or sent. A message with files is its JSON under '${MESSAGE_FIELD}' and each file under '${MESSAGE_FILES_FIELD}'.`,
            );
          }
          if (fields.includes(part.key)) kept.set(part.key, part.value);
          return;
        }
        if (files.length >= limits.maxFiles) {
          return yield* refused(
            "too_many",
            `that message carries more than ${String(limits.maxFiles)} files, which is this server's cap per message, so the rest was not read and nothing was stored or sent. Send fewer at a time, or raise UPLOAD_MAX_FILES on the server and restart it.`,
          );
        }
        const sentName = part.name;
        const kind = classifyUpload(sentName, part.contentType);
        if (kind._tag === "heic") {
          return yield* refused(
            "unsupported_image",
            `'${sentName}' is a HEIC/HEIF image. bit does not convert images, and the models take GIF, JPEG, PNG and WebP only, so it was refused and nothing in that message was stored or sent. Export it as JPEG or PNG and attach that (on an iPhone, Settings → Camera → Formats → Most Compatible makes new photos JPEG).`,
          );
        }
        const cap = kind._tag === "image" ? imageCap : limits.maxFileBytes;
        const chunks: Uint8Array[] = [];
        let size = 0;
        yield* Stream.runForEach(part.content, (chunk) =>
          Effect.suspend(() => {
            size += chunk.length;
            total += chunk.length;
            if (size > cap) {
              return Effect.fail(
                refused(
                  "too_large",
                  kind._tag === "image"
                    ? `'${sentName}' is an image over ${describeBytes(cap)}, this server's cap per image, so reading it stopped there and nothing in that message was stored or sent. bit does not compress images: attach a smaller one (a lower resolution, or a JPEG), or raise UPLOAD_MAX_IMAGE_BYTES on the server and restart it.`
                    : `'${sentName}' is over ${describeBytes(cap)}, this server's cap per file, so reading it stopped there and nothing in that message was stored or sent. Attach an extract of the part that matters, or raise UPLOAD_MAX_BYTES on the server and restart it.`,
                ),
              );
            }
            if (total > limits.maxTotalBytes) {
              return Effect.fail(
                refused(
                  "too_much",
                  `the files in that message come to more than ${describeBytes(limits.maxTotalBytes)}, this server's cap for one message, so reading stopped at '${sentName}' and nothing was stored or sent. Send them over several messages, or raise UPLOAD_MAX_TOTAL_BYTES on the server and restart it.`,
                ),
              );
            }
            chunks.push(chunk);
            return Effect.void;
          }),
        );
        if (size === 0) {
          return yield* refused(
            "empty_file",
            `'${sentName}' is empty, so it was refused and nothing in that message was stored or sent. An agent told to read a file with nothing in it would report that the evidence says nothing, which would be a false reading of an upload that went wrong.`,
          );
        }
        const bytes = new Uint8Array(size);
        let at = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, at);
          at += chunk.length;
        }
        files.push({
          sentName,
          name: sanitiseUploadName(sentName, kind.mimeType),
          contentType: part.contentType,
          kind: kind._tag,
          mimeType: kind.mimeType,
          bytes,
        });
      }),
    ).pipe(
      Effect.catchTag("MultipartError", (cause) =>
        Effect.fail(
          refused(
            "unreadable_body",
            `that request's body could not be read as multipart/form-data (${cause.message}), so nothing was stored or sent. A message with files is its JSON under '${MESSAGE_FIELD}' and each file under '${MESSAGE_FILES_FIELD}', which is what the composer sends.`,
          ),
        ),
      ),
    );
    return { fields: kept, files };
  });

/**
 * Why files could not be written into a session's `uploads/` folder. Server-side: the
 * request was fine and the disk was not, so each surface says it in its own refusal
 * (`upload_unwritable`).
 */
export class UploadWriteFailed extends Data.TaggedError("UploadWriteFailed")<{
  readonly message: string;
}> {}

/** `name` with ` (n)` before its extension. */
const numbered = (name: string, n: number): string => {
  const extension = extname(name);
  const stem = extension === "" ? name : name.slice(0, -extension.length);
  const suffix = ` (${String(n)})`;
  return `${stem.slice(0, NAME_MAX - extension.length - suffix.length)}${suffix}${extension}`;
};

/**
 * Writes one message's files into `<directory>/uploads/`, all or none, and answers what the
 * harness is to be given.
 *
 * `directory` is the session's own working directory, as the spine gated it
 * (`harness/liveAgentSessions.ts`): the files go where the agent already works and the gate
 * already audits, which is what makes this grant nothing new.
 *
 * - **The folder is checked, through symlinks**, to resolve inside `directory`: a link
 *   planted at `uploads` would otherwise carry the bytes wherever it points.
 * - **Each file is written atomically**: to a dot-named temporary in the folder
 *   (`O_CREAT|O_EXCL|O_NOFOLLOW`), then hard-linked to its name, which fails rather than
 *   replaces when the name is taken — so a reader never sees half a file, and a name already
 *   used by an earlier message is never overwritten (that message's path line still points
 *   at it). A taken name gets ` (2)`, ` (3)` … before its extension.
 * - **All or none**: a failure part-way removes what this call stored.
 */
export const storeUploads = (
  directory: string,
  files: readonly ReadUpload[],
): Effect.Effect<readonly MessageAttachment[], UploadWriteFailed> =>
  Effect.try({
    try: () => {
      const folder = join(directory, UPLOADS_FOLDER);
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const inside = relative(
        resolveThroughSymlinks(directory),
        resolveThroughSymlinks(folder),
      );
      if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
        throw new Error(
          `${folder} does not resolve to a folder inside the session's own directory: something has replaced it with a link. Remove it and send the message again`,
        );
      }
      if (!lstatSync(folder).isDirectory()) {
        throw new Error(`${folder} is not a folder`);
      }
      const stored: MessageAttachment[] = [];
      try {
        for (const file of files) {
          const temporary = join(folder, `.incoming-${crypto.randomUUID()}`);
          const handle = openSync(
            temporary,
            fsConstants.O_WRONLY |
              fsConstants.O_CREAT |
              fsConstants.O_EXCL |
              fsConstants.O_NOFOLLOW,
            0o600,
          );
          try {
            let written = 0;
            while (written < file.bytes.length) {
              written += writeSync(handle, file.bytes, written);
            }
          } finally {
            closeSync(handle);
          }
          try {
            let path: string | undefined;
            for (let n = 1; path === undefined; n += 1) {
              const name = n === 1 ? file.name : numbered(file.name, n);
              const candidate = join(folder, name);
              try {
                linkSync(temporary, candidate);
                path = candidate;
                stored.push({
                  kind: file.kind,
                  name,
                  mimeType: file.mimeType,
                  path: candidate,
                  bytes: file.bytes.length,
                });
              } catch (cause) {
                if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
                  throw cause;
                }
                if (n >= 1000) throw cause;
              }
            }
          } finally {
            unlinkSync(temporary);
          }
        }
      } catch (cause) {
        for (const done of stored) {
          try {
            unlinkSync(done.path);
          } catch {
            // Already gone; nothing else to undo.
          }
        }
        throw cause;
      }
      return stored;
    },
    catch: (cause) =>
      new UploadWriteFailed({
        message: `the files could not be written into the session's ${UPLOADS_FOLDER} folder (${cause instanceof Error ? cause.message : String(cause)}), so nothing was stored and nothing was said to the agent`,
      }),
  });
