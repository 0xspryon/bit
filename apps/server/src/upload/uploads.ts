/**
 * Files sent with a conversation message (A6 F9): read, checked, and stored.
 *
 * The one reader and validator for every route that takes files — the importer's two
 * message endpoints and a goal's message endpoint. (The goal attach route that also read
 * through it was retired in U13: a goal's files now travel with its messages.) A plain
 * module with no services in it: each claim here — that a name cannot escape the folder,
 * that a cap is checked while the bytes are read, that a refused request leaves nothing
 * behind — is worth a test that needs no harness and no listener.
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
 * `UPLOAD_MAX_BYTES` lowers both.
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
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
  constants as fsConstants,
} from "node:fs";
import { extname, isAbsolute, join, normalize, relative, sep } from "node:path";

import {
  MESSAGE_FIELD,
  MESSAGE_FILES_FIELD,
  MESSAGE_IMAGE_MIME_TYPES,
  MessageUploadRefused,
} from "@bit/contracts";
import { Data, Effect, Stream } from "effect";
import type { Multipart } from "effect/http";

import type { MessageAttachment } from "../harness/attachments";
import {
  GOAL_DIRECTORY,
  IMPORT_DIRECTORY,
  isRoleDirectoryId,
} from "../persistence/fleet";
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

/** The longest stored name, in characters: {@link UPLOAD_NAME_PATTERN}'s bound. */
const NAME_MAX = 127;

/**
 * What a stored filename looks like: every name {@link sanitiseUploadName} makes, and nothing
 * a replayed line or a request for a stored file may name beyond it.
 *
 * Letters, digits, space, `.`, `_`, `-`, `(` and `)`, starting with a letter or a digit, up
 * to 127 characters. That excludes `/` and `\`, so no name is a path; excludes a leading
 * `.`, so no name is `..`, `.` or a hidden file (an `.incoming-` temporary among them);
 * excludes control characters, newlines and quotes, so a name cannot read as two lines of a
 * prompt or close one; and excludes `:`.
 */
export const UPLOAD_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,126}$/;

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
 *   starts with a letter or digit, as {@link UPLOAD_NAME_PATTERN} asks.
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
  /** The name the browser sent, untouched: what a refusal names. */
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
 * Reads a multipart body into memory, keeping nothing past a cap.
 *
 * **Every cap is checked while reading**: the count at the first file over it, the file's
 * own cap (image or file, by its type) the moment its content passes it, the total the same
 * way. From then on nothing more is kept — no part, no chunk — so the memory one request can
 * hold is {@link UploadLimits.maxTotalBytes}; a HEIC/HEIF image is refused before any of its
 * bytes are kept, and an empty file once its stream ends.
 *
 * **But the rest of the body is still read, and thrown away, before the refusal is
 * answered** (U13, measured). A server that answers while the body is still arriving closes
 * a socket with unread data in it, which resets the connection: the browser straight to Bun
 * copes, but Vite's dev proxy — the way the operator's browser reaches this server — answers
 * `502` instead of the refusal, and the composer read that as "no server answered". How much
 * can be read is bounded by the listener's body ceiling (`http/controlPlane.ts`), above which
 * Bun answers its own empty `413` without this ever running.
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
    /** The first cap passed: from here the body is only read to its end, never kept. */
    let refusal: MessageUploadRefused | undefined;
    const imageCap = imageCapOf(limits);
    yield* Stream.runForEach(stream, (part) =>
      Effect.gen(function* () {
        if (part._tag === "Field") {
          if (refusal !== undefined) return;
          fieldCount += 1;
          if (fieldCount > MAX_FIELDS) {
            refusal = refused(
              "unreadable_body",
              `that request carries more than ${String(MAX_FIELDS)} text fields, which no composer sends, so it was not kept and nothing was stored or sent. A message with files is its JSON under '${MESSAGE_FIELD}' and each file under '${MESSAGE_FILES_FIELD}'.`,
            );
            return;
          }
          if (fields.includes(part.key)) kept.set(part.key, part.value);
          return;
        }
        if (refusal === undefined && files.length >= limits.maxFiles) {
          refusal = refused(
            "too_many",
            `that message carries more than ${String(limits.maxFiles)} files, which is this server's cap per message, so none of it was kept and nothing was stored or sent. Send fewer at a time, or raise UPLOAD_MAX_FILES on the server and restart it.`,
          );
        }
        const sentName = part.name;
        const kind = classifyUpload(sentName, part.contentType);
        if (refusal === undefined && kind._tag === "heic") {
          refusal = refused(
            "unsupported_image",
            `'${sentName}' is a HEIC/HEIF image. bit does not convert images, and the models take GIF, JPEG, PNG and WebP only, so it was refused and nothing in that message was stored or sent. Export it as JPEG or PNG and attach that (on an iPhone, Settings → Camera → Formats → Most Compatible makes new photos JPEG).`,
          );
        }
        if (refusal !== undefined || kind._tag === "heic") {
          yield* Stream.runDrain(part.content);
          return;
        }
        const cap = kind._tag === "image" ? imageCap : limits.maxFileBytes;
        const chunks: Uint8Array[] = [];
        let size = 0;
        yield* Stream.runForEach(part.content, (chunk) =>
          Effect.sync(() => {
            if (refusal !== undefined) return;
            size += chunk.length;
            total += chunk.length;
            if (size > cap) {
              refusal = refused(
                "too_large",
                kind._tag === "image"
                  ? `'${sentName}' is an image over ${describeBytes(cap)}, this server's cap per image, so it was not kept and nothing in that message was stored or sent. bit does not compress images: attach a smaller one (a lower resolution, or a JPEG), or raise UPLOAD_MAX_IMAGE_BYTES on the server and restart it.`
                  : `'${sentName}' is over ${describeBytes(cap)}, this server's cap per file, so it was not kept and nothing in that message was stored or sent. Attach an extract of the part that matters, or raise UPLOAD_MAX_BYTES on the server and restart it.`,
              );
              chunks.length = 0;
              return;
            }
            if (total > limits.maxTotalBytes) {
              refusal = refused(
                "too_much",
                `the files in that message come to more than ${describeBytes(limits.maxTotalBytes)}, this server's cap for one message, so they were not kept (the cap was passed at '${sentName}') and nothing was stored or sent. Send them over several messages, or raise UPLOAD_MAX_TOTAL_BYTES on the server and restart it.`,
              );
              chunks.length = 0;
              return;
            }
            chunks.push(chunk);
          }),
        );
        if (refusal !== undefined) return;
        if (size === 0) {
          refusal = refused(
            "empty_file",
            `'${sentName}' is empty, so it was refused and nothing in that message was stored or sent. An agent told to read a file with nothing in it would report that the evidence says nothing, which would be a false reading of an upload that went wrong.`,
          );
          return;
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
    if (refusal !== undefined) return yield* refusal;
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

/** Which file an entry is: its device and inode. */
interface Entry {
  readonly dev: number;
  readonly ino: number;
}

/** Whether `found` is the file `entry` (a hard link to it counts: that is the same file). */
const sameEntry = (found: Entry | undefined, entry: Entry): boolean =>
  found !== undefined && found.dev === entry.dev && found.ino === entry.ino;

/** `path`'s device and inode, not through a link, or `undefined` when it is not there. */
const statOrUndefined = (path: string): Entry | undefined => {
  try {
    const { dev, ino } = lstatSync(path);
    return { dev, ino };
  } catch {
    return undefined;
  }
};

/** `name` with ` (n)` before its extension. */
const numbered = (name: string, n: number): string => {
  const extension = extname(name);
  const stem = extension === "" ? name : name.slice(0, -extension.length);
  const suffix = ` (${String(n)})`;
  return `${stem.slice(0, NAME_MAX - extension.length - suffix.length)}${suffix}${extension}`;
};

/**
 * Moments inside {@link storeUploads} a test can act in, to swap the folder for a link at
 * the two places a concurrent agent could. Never passed outside tests.
 */
export interface StoreUploadsProbe {
  /** After the folder was checked, before any file is opened in it. */
  readonly afterCheck?: () => void;
  /**
   * After a file's temporary was created through the held folder, before its path is
   * checked and before a byte is written to it.
   */
  readonly afterOpen?: (temporary: string) => void;
  /**
   * Writes bytes to the temporary in place of `writeSync`, so a test can make a write fail
   * part-way (a full disk, a quota) after some of the bytes have landed.
   */
  readonly write?: (handle: number, bytes: Uint8Array, at: number) => number;
  /** After a file's bytes were written to its temporary, before it is linked to its name. */
  readonly afterWrite?: (temporary: string) => void;
}

/**
 * Writes one message's files into `<directory>/uploads/`, all or none, and answers what the
 * harness is to be given.
 *
 * `directory` is the session's own working directory, as the spine gated it
 * (`harness/liveAgentSessions.ts`): the files go where the agent already works and the gate
 * already audits, which is what makes this grant nothing new.
 *
 * - **The folder is opened once, and every entry is made and removed through that open
 *   folder.** It is opened `O_DIRECTORY|O_NOFOLLOW`, so a link planted at `uploads` is
 *   refused, and the open folder is then checked to resolve inside `directory`. From there
 *   each create, link and unlink names its entry as `/proc/self/fd/<n>/<name>`: the kernel
 *   resolves that prefix to the folder this call holds, not to whatever `uploads` names by
 *   then. The agent works in `directory` and can swap `uploads` for a link at any moment —
 *   `O_NOFOLLOW` guards only a path's last component — but a swap can no longer carry a
 *   write, or a cleanup's unlink, into the folder the link points at.
 * - **And the path handed on is checked around every file**, because the harness is given
 *   `<directory>/uploads/<name>`, and that is still a path the agent can swap. Before a byte
 *   is written the temporary's path, and once linked each stored name's path, must resolve
 *   to the checked folder and name the very file this call holds (device and inode); either
 *   failing fails the call, so no path outside the folder is handed to the harness.
 * - **Nothing is removed that this call did not make.** Every entry it creates — each
 *   temporary, each stored name — has its device and inode recorded, and an unlink (of a
 *   temporary, of a name whose check failed, of what was stored before a failure) is made
 *   only while the entry in the held folder is still that file. A file the agent put in its
 *   place is left alone.
 * - **Each file is written atomically**: to a dot-named temporary in the folder
 *   (`O_CREAT|O_EXCL|O_NOFOLLOW`), then hard-linked to its name, which fails rather than
 *   replaces when the name is taken — so a reader never sees half a file, and a name already
 *   used by an earlier message is never overwritten (that message's path line still points
 *   at it). A taken name gets ` (2)`, ` (3)` … before its extension.
 * - **All or none**: a failure part-way removes what this call stored.
 *
 * `/proc/self/fd` makes this Linux-only, as the server already is (`harness/ownedProcesses.ts`
 * reads `/proc/<pid>/stat`).
 */
export const storeUploads = (
  directory: string,
  files: readonly ReadUpload[],
  probe: StoreUploadsProbe = {},
): Effect.Effect<readonly MessageAttachment[], UploadWriteFailed> =>
  Effect.try({
    try: () => {
      const folder = join(directory, UPLOADS_FOLDER);
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      let folderHandle: number;
      try {
        folderHandle = openSync(
          folder,
          fsConstants.O_RDONLY |
            fsConstants.O_DIRECTORY |
            fsConstants.O_NOFOLLOW,
        );
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        if (code !== "ELOOP" && code !== "ENOTDIR") throw cause;
        throw new Error(
          `${folder} is not a folder inside the session's own directory: something has replaced it with a link or a file. Remove it and send the message again`,
          { cause },
        );
      }
      try {
        /** The folder this call holds, whatever `uploads` names by now. */
        const held = `/proc/self/fd/${String(folderHandle)}`;
        const inHeld = (name: string) => `${held}/${name}`;
        const real = realpathSync(held);
        const inside = relative(resolveThroughSymlinks(directory), real);
        if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
          throw new Error(
            `${folder} does not resolve to a folder inside the session's own directory: something has replaced it with a link. Remove it and send the message again`,
          );
        }
        const moved = (path: string) =>
          new Error(
            `${path} resolved outside ${real} while it was being written: something replaced ${folder} with a link. Remove it and send the message again`,
          );
        if (!sameEntry(statOrUndefined(folder), fstatSync(folderHandle))) {
          throw moved(folder);
        }
        /**
         * Whether `path` — the path the harness would be given — still resolves to `name`
         * directly in the checked folder, and is the file `entry`.
         */
        const namesEntry = (path: string, name: string, entry: Entry) => {
          try {
            if (realpathSync(path) !== join(real, name)) return false;
          } catch {
            return false;
          }
          return sameEntry(statOrUndefined(path), entry);
        };
        /** Unlinks `name` from the held folder only while it is still `entry`. */
        const removeOwn = (name: string, entry: Entry) => {
          const at = inHeld(name);
          if (!sameEntry(statOrUndefined(at), entry)) return;
          try {
            unlinkSync(at);
          } catch {
            // Already gone; nothing else to undo.
          }
        };
        probe.afterCheck?.();
        const stored: MessageAttachment[] = [];
        const made: { readonly name: string; readonly entry: Entry }[] = [];
        try {
          for (const file of files) {
            const temporaryName = `.incoming-${crypto.randomUUID()}`;
            const temporary = join(folder, temporaryName);
            const handle = openSync(
              inHeld(temporaryName),
              fsConstants.O_WRONLY |
                fsConstants.O_CREAT |
                fsConstants.O_EXCL |
                fsConstants.O_NOFOLLOW,
              0o600,
            );
            let written: Entry;
            try {
              const { dev, ino } = fstatSync(handle);
              written = { dev, ino };
              probe.afterOpen?.(temporary);
              // Before a byte is written: the temporary's path is the file this handle holds.
              if (!namesEntry(temporary, temporaryName, written)) {
                removeOwn(temporaryName, written);
                throw moved(temporary);
              }
              const write = probe.write ?? writeSync;
              let at = 0;
              try {
                while (at < file.bytes.length) {
                  at += write(handle, file.bytes, at);
                }
              } catch (cause) {
                // A write that failed part-way (a full disk) left a partial temporary that
                // is in no list yet: removed here, through the held folder, while it is
                // still the file this handle made (U13).
                removeOwn(temporaryName, written);
                throw cause;
              }
            } finally {
              closeSync(handle);
            }
            probe.afterWrite?.(temporary);
            try {
              let path: string | undefined;
              for (let n = 1; path === undefined; n += 1) {
                const name = n === 1 ? file.name : numbered(file.name, n);
                try {
                  linkSync(inHeld(temporaryName), inHeld(name));
                } catch (cause) {
                  if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
                    throw cause;
                  }
                  if (n >= 1000) throw cause;
                  continue;
                }
                // The link made a name for the bytes written above, in the held folder.
                made.push({ name, entry: written });
                const candidate = join(folder, name);
                // And the path handed on is that name.
                if (!namesEntry(candidate, name, written)) {
                  throw moved(candidate);
                }
                path = candidate;
                stored.push({
                  kind: file.kind,
                  name,
                  mimeType: file.mimeType,
                  path: candidate,
                  bytes: file.bytes.length,
                });
              }
            } finally {
              removeOwn(temporaryName, written);
            }
          }
        } catch (cause) {
          for (const { name, entry } of made) removeOwn(name, entry);
          throw cause;
        }
        return stored;
      } finally {
        closeSync(folderHandle);
      }
    },
    catch: (cause) =>
      new UploadWriteFailed({
        message: `the files could not be written into the session's ${UPLOADS_FOLDER} folder (${cause instanceof Error ? cause.message : String(cause)}), so nothing was stored and nothing was said to the agent`,
      }),
  });

/** Why a stored file was not served: `missing` when nothing is there, else `not_an_upload`. */
export type StoredUploadRefusal = {
  readonly _tag: "refused";
  readonly reason: "not_an_upload" | "missing";
  readonly detail: string;
};

/**
 * One stored upload's bytes, for a browser that has a replayed attachment's path and no bytes
 * (A6 U13) — or why not.
 *
 * **The path is the browser's, so nothing about it is trusted; it is re-derived.** A replayed
 * path is read out of a harness transcript, which is the operator's text and the agent's
 * record, so it is only a request: this answers only when
 *
 * - it is absolute and already normal (no `.`, `..` or doubled separator), and inside this
 *   target's own directory, lexically, as `<kind>/<id>/uploads/<name>`: `kind` an import's or
 *   a goal's folder, `id` a role id ({@link isRoleDirectoryId}), `name` one
 *   {@link UPLOAD_NAME_PATTERN} admits — so no `.incoming-` temporary, no hidden file;
 * - its real path is exactly that path under the target's real directory, so no component —
 *   the session folder, `uploads`, the file — is a link to anywhere, inside or out;
 * - and it is a regular file, opened `O_NOFOLLOW`, and the file opened is the one checked
 *   (device and inode), so a swap between the check and the open is refused too.
 *
 * A file over `maxBytes` (the per-file cap, which every stored upload is under) is refused
 * rather than read into memory: the agent works in that folder and can put anything there.
 *
 * V2(chat): the whole file is read into memory and sent in one response, and the browser
 * holds it as a blob. Proper V2 streams it with range requests and serves a thumbnail for an
 * image instead of its full bytes.
 */
export const readStoredUpload = (
  targetDirectory: string,
  path: string,
  maxBytes: number,
):
  | { readonly _tag: "file"; readonly bytes: Uint8Array }
  | StoredUploadRefusal => {
  const refuse = (detail: string): StoredUploadRefusal => ({
    _tag: "refused",
    reason: "not_an_upload",
    detail: `${detail}, so it is not served. Only a file the operator sent with a message, as stored in a session's own uploads folder on this target, is.`,
  });
  if (!isAbsolute(path) || path.includes("\0") || normalize(path) !== path) {
    return refuse(`'${path}' is not an absolute, normal path`);
  }
  /** `<kind>/<id>/uploads/<name>` under one spelling of the target's directory, or nothing. */
  const partsUnder = (root: string) => {
    const inside = relative(root, path);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
      return undefined;
    }
    const parts = inside.split(sep);
    return parts.length === 4 ? parts : undefined;
  };
  let realTarget: string;
  try {
    realTarget = realpathSync(targetDirectory);
  } catch {
    return refuse(`this target's directory cannot be read`);
  }
  const parts = partsUnder(targetDirectory) ?? partsUnder(realTarget);
  const [kind, id, folder, name] = parts ?? [];
  if (
    kind === undefined ||
    id === undefined ||
    folder === undefined ||
    name === undefined
  ) {
    return refuse(
      `'${path}' is not inside a session's uploads folder on this target`,
    );
  }
  if (
    (kind !== IMPORT_DIRECTORY && kind !== GOAL_DIRECTORY) ||
    !isRoleDirectoryId(id) ||
    folder !== UPLOADS_FOLDER ||
    !UPLOAD_NAME_PATTERN.test(name)
  ) {
    return refuse(
      `'${path}' is not inside a session's uploads folder on this target`,
    );
  }
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return {
      _tag: "refused",
      reason: "missing",
      detail: `no file is stored at '${path}' any more: it was removed from the session's uploads folder, or the session's directory was swept.`,
    };
  }
  if (real !== join(realTarget, kind, id, folder, name)) {
    return refuse(`'${path}' resolves through a link, to '${real}'`);
  }
  let handle: number;
  try {
    handle = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return refuse(`'${path}' could not be opened as a plain file`);
  }
  try {
    const opened = fstatSync(handle);
    const named = statOrUndefined(path);
    if (!opened.isFile() || named === undefined || !sameEntry(named, opened)) {
      return refuse(
        `'${path}' is not a regular file, or changed while it was opened`,
      );
    }
    if (opened.size > maxBytes) {
      return refuse(
        `'${path}' is ${describeBytes(opened.size)}, over ${describeBytes(maxBytes)}, the most any upload is stored at`,
      );
    }
    const bytes = new Uint8Array(opened.size);
    let at = 0;
    while (at < bytes.length) {
      const read = readSync(handle, bytes, at, bytes.length - at, at);
      if (read === 0) break;
      at += read;
    }
    return {
      _tag: "file",
      bytes: at === bytes.length ? bytes : bytes.slice(0, at),
    };
  } finally {
    closeSync(handle);
  }
};
