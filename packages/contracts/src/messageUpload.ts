/**
 * Files sent **with** a conversation message (A6 F9): the importer's and a goal agent's.
 *
 * ## One request, carrying the message and its files
 *
 * A message endpoint that takes files takes them in the same request as the words, as a
 * `multipart/form-data` body: the message under {@link MESSAGE_FIELD} as the very JSON the
 * endpoint's JSON body would be, and each file under {@link MESSAGE_FILES_FIELD}. There is
 * no upload step, no id a file is known by before the message is sent, and nothing pending
 * on the server between the two: the files are stored, then the message is delivered with
 * them, or the request is refused and nothing was stored. The same endpoint still takes a
 * JSON body, which is what a message without files is.
 *
 * ## Where they go
 *
 * Into an `uploads/` folder **inside the session's own working directory** — the import's
 * directory for the importer, `goal/<goalId>/` for a goal agent — which the server
 * chooses, never the browser. The policy gate already covers that directory, so the agent
 * reading a file there is nothing it could not already do: no new filesystem authority is
 * granted to anyone by this feature.
 *
 * ## What the agent is given
 *
 * On every harness a line per file is appended to the prompt,
 * `[Attached image "<name>" is saved at: <absolute path>]` (or `file`). An image in
 * {@link MESSAGE_IMAGE_MIME_TYPES} also goes inline — a Claude Code image block, an
 * OpenCode file part — and on OpenCode so do `text/plain` and PDF. Everything else is the
 * path only, and the agent reads it with its own tools if it decides to.
 *
 * Browser-safe: Effect Schema and `effect/http`'s multipart declarations only.
 */
import { Schema, Stream } from "effect";
import { Multipart } from "effect/http";
import { HttpApiSchema } from "effect/http-api";

/** The form field the message itself travels under, as the endpoint's JSON body. */
export const MESSAGE_FIELD = "message";

/** The form field every file travels under. The goal attach route's field, too. */
export const MESSAGE_FILES_FIELD = "files";

/**
 * The image types that reach a model as an image: GIF, JPEG, PNG, WebP.
 *
 * The types both harnesses' vision paths take. Any other file is a file (path only), except
 * HEIC/HEIF — an image the operator would expect the model to see and that neither harness
 * can show it — which is refused with the reason ({@link MessageUploadRefused}).
 */
export const MESSAGE_IMAGE_MIME_TYPES = [
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

const isPartStream = (
  u: unknown,
): u is Stream.Stream<Multipart.Part, Multipart.MultipartError> =>
  Stream.isStream(u);

/**
 * A message and its files, as the parser's stream of parts.
 *
 * The streaming multipart shape, for `GoalUploadDraft`'s measured reason: the buffered one
 * needs a real `FileSystem` and this build has none, so it answers an empty `500`. No
 * parser limits are set here: every cap is a {@link MessageUploadRefused} naming its
 * figure, enforced while the parts are read.
 */
export const MessageWithFilesDraft = Schema.declare<
  Stream.Stream<Multipart.Part, Multipart.MultipartError>
>(isPartStream, {
  title: "MessageWithFilesDraft",
  description:
    "A multipart/form-data body: the message as JSON under 'message', each file under 'files'.",
}).pipe(HttpApiSchema.asMultipartStream());
export type MessageWithFilesDraft = typeof MessageWithFilesDraft.Type;

/**
 * One file an operator's message carried, as a replayed conversation shows it.
 *
 * Read back from the harness's own transcript — the path line the prompt carried and the
 * image block or file part beside it — and never from a table of this server's: a
 * conversation is the harness's to keep (DECISIONS.md §8).
 */
export const MessageAttachmentView = Schema.Struct({
  /** `image` when it went to the model as one; `file` when it went as a path. */
  kind: Schema.Literals(["image", "file"]),
  /** The name it is stored under, which is what the agent was told. */
  name: Schema.String,
  /**
   * The image block's or file part's own type when the harness kept one, else the type its
   * extension names, else `application/octet-stream`.
   */
  mimeType: Schema.String,
  /** The absolute path it is saved at, for the chip's copy-path button. */
  path: Schema.String,
});
export type MessageAttachmentView = typeof MessageAttachmentView.Type;

/**
 * Why a message's files were refused. Nothing was stored and nothing was said to the agent.
 *
 * Each reason is a sentence naming the file and the figure it is about:
 *
 * - `unreadable_body` — the body could not be read as multipart.
 * - `no_message` — no `message` field, or one that is not the endpoint's message JSON.
 * - `unsupported_image` — a HEIC/HEIF image, which is refused rather than converted.
 * - `empty_file` — a zero-byte file.
 * - `too_large` — one file over its cap: the image cap for an image, the file cap otherwise.
 * - `too_many` — more files than one message may carry.
 * - `too_much` — the files together over the per-message total.
 *
 * `409` like every refusal on this API: a conflict with the server's caps, said in words
 * the F2 error dialog prints.
 */
export class MessageUploadRefused extends Schema.TaggedError<MessageUploadRefused>()(
  "MessageUploadRefused",
  {
    reason: Schema.Literals([
      "unreadable_body",
      "no_message",
      "unsupported_image",
      "empty_file",
      "too_large",
      "too_many",
      "too_much",
    ]),
    detail: Schema.String,
  },
  { httpApiStatus: 409 },
) {
  override get message(): string {
    return `${this.reason}: ${this.detail}`;
  }
}
