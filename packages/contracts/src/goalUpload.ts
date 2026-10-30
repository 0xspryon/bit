/**
 * Files the operator attaches to a goal conversation, so the goal agent can read them.
 *
 * ## The browser never names a place on disk
 *
 * The composer sends bytes and a filename; **where they land is the server's decision**
 * and is not expressible in this contract. That is the same boundary the folder picker
 * draws (`http/folders.ts`): a path chosen in a browser is a path the server must then
 * validate, and this project decided once not to have that conversation. So there is no
 * directory field here, no path field, and the filename that comes back is the name the
 * server chose to store under — which may differ from the one that was sent.
 *
 * ## Where they go, and why not the workspace
 *
 * `targets/<id>/goal/<goalId>/uploads/`, inside the goal agent's **own** directory and
 * never inside the engagement folder a worker runs in. DECISIONS.md §24.2 measured why
 * that matters: under OpenCode a directory is the authority boundary, so a file dropped in
 * the workspace would be readable by every worker attempt on the target, and an operator
 * attaching a client's document to a conversation has not asked for that. The directory is
 * obtained through the same gating a goal session's is — `gatedRoleDirectory`, gate first,
 * path after — so nothing is ever written into an ungated role directory.
 *
 * ## An upload is untrusted input that an agent will read
 *
 * The goal agent holds tools that write to this investigation's record. A file it reads may
 * have come from the system under test, and text inside it that reads like an instruction
 * ("ignore your rules", "end the goal") is data to report rather than a direction to
 * follow. The prompt says so every time attachments are listed
 * (`plan/goalPrompt.ts`), and the route says so where it writes
 * (`http/browserApi.ts`). It is written down in three places because it is the one property
 * of this feature that no type can carry.
 *
 * Browser-safe: Effect Schema and `effect/http`'s multipart declarations only, neither of
 * which reaches a `node:` or `bun:` builtin at any depth.
 */
import { Schema, Stream } from "effect";
import { Multipart } from "effect/http";
import { HttpApiSchema } from "effect/http-api";

/** Epoch milliseconds. `Schema.Finite` so NaN and Infinity are refused, not shipped. */
const EpochMillis = Schema.Finite.annotate({
  description: "Epoch milliseconds.",
});

/** The form field every attached file travels under. One name, used on both sides. */
export const GOAL_UPLOAD_FIELD = "files";

/**
 * A `multipart/form-data` body, handed to the server as the parser's own part stream.
 *
 * `effect@4.0.5`'s HTTP server offers two multipart shapes and this is the second of them.
 * **The first one does not work at this version**, which is why the harder one is here:
 *
 * - `HttpApiSchema.asMultipart` is the buffered form. It writes every part to a scoped
 *   temporary directory and hands the handler a {@link Multipart.PersistedFile} per file,
 *   which is much less code. It needs a working `FileSystem`, and the only one in reach is
 *   `HttpServer.layerServices`' — which is `FileSystem.layerNoop`, because `effect` core
 *   ships no real implementation and this build has no `@effect/platform-*` package. The
 *   decode is wrapped in `Effect.orDie` inside `HttpApiBuilder`, so with a no-op filesystem
 *   every upload is a `500` with nothing in it. Measured over the real listener before this
 *   shape was chosen, not reasoned about.
 * - `HttpApiSchema.asMultipartStream` is this one. The handler is handed
 *   `Stream<Part, MultipartError>` and consumes it itself, so **no filesystem is involved
 *   until the server writes where it decided to write**. The consumer is
 *   `plan/goalUploads.ts`'s `collectUploads`, and the caps are enforced *while reading* —
 *   which is strictly better than the buffered form would have been anyway: the per-file
 *   cap stops the read instead of refusing bytes that are already on disk.
 *
 * **No parser limits are set on the annotation, deliberately.** `Multipart`'s own
 * `maxFileSize` and `maxTotalSize` raise a `MultipartError`, and on this seam that would
 * reach the operator as a failed stream rather than as a sentence. Every cap in this
 * feature is a {@link GoalUploadRefused} naming its figure instead — see that error.
 *
 * The type is a declaration rather than a structure because what arrives *is* a stream:
 * the generated client's payload type is `FormData` (the brand says multipart), and the
 * handler's is the stream. The guard can only ask "is this a stream" — the parts inside it
 * are typed by the parser that produced them, and nothing on this seam could check more.
 */
const isPartStream = (
  u: unknown,
): u is Stream.Stream<Multipart.Part, Multipart.MultipartError> =>
  Stream.isStream(u);

export const GoalUploadDraft = Schema.declare<
  Stream.Stream<Multipart.Part, Multipart.MultipartError>
>(isPartStream, {
  title: "GoalUploadDraft",
  description:
    "A multipart/form-data body, as the parser's stream of parts. Files travel under the 'files' field.",
}).pipe(HttpApiSchema.asMultipartStream());
export type GoalUploadDraft = typeof GoalUploadDraft.Type;

/** One file the server stored, described in the server's own terms. */
export const GoalUploadView = Schema.Struct({
  /**
   * The name it is stored under, which is the name that was sent once it has passed the
   * allow-list on {@link GoalUploadRefused}'s `unsafe_name`. Nothing is stripped or
   * rewritten to make a name storable — a name that would not do is refused instead, so
   * the operator knows which file the agent will not have. The composer shows this one,
   * which is what the agent will see.
   */
  name: Schema.String,
  /** Its size on disk, so the composer can show it without measuring anything itself. */
  bytes: Schema.Int,
  /** What the browser said it was. Recorded, never trusted, and never used to pick a path. */
  contentType: Schema.String,
  /**
   * Whether a file of this name was already attached to this goal and has been replaced.
   *
   * Replaced rather than renamed, and said rather than silent: an operator re-attaching a
   * corrected file means the new one, and a server that had quietly stored
   * `report (2).pdf` would leave the agent with two documents and no way to tell which was
   * meant.
   */
  replaced: Schema.Boolean,
  uploadedAt: EpochMillis,
});
export type GoalUploadView = typeof GoalUploadView.Type;

/**
 * One attach request, accepted.
 *
 * `stored` is what *this* request wrote. `attachedCount` is how many files the goal holds
 * afterwards, which is the number the count cap is measured against — so an operator who
 * is near it can see that from the answer instead of inferring it from a refusal.
 */
export const GoalUploadsAccepted = Schema.Struct({
  targetId: Schema.String,
  goalId: Schema.String,
  stored: Schema.Array(GoalUploadView),
  attachedCount: Schema.Int,
  /**
   * A sentence for the operator about what the agent was told.
   *
   * The server's words, for {@link GoalTurnAccepted.note}'s reason: only the server knows
   * that the list reaches the agent on the *next* message rather than now, and a browser
   * composing that sentence would be inventing wording for a mechanism it cannot see.
   */
  note: Schema.String,
  acceptedAt: EpochMillis,
});
export type GoalUploadsAccepted = typeof GoalUploadsAccepted.Type;

/**
 * Why files could not be attached to a goal.
 *
 * Each reason is a sentence the composer prints beside itself, and each of the four
 * upload-specific ones names the figure it is about — the brief's requirement, and the
 * reason a rejected upload here does not say only "failed":
 *
 * - `no_files` — the request carried no file part at all. A browser bug or a hand-made
 *   request; said plainly rather than answered with an empty success.
 * - `too_large` — one file is over `UPLOAD_MAX_BYTES`. The sentence names **its** size and
 *   the cap, because "too large" without both numbers tells an operator nothing about
 *   whether to split the file or raise the limit.
 * - `too_many` — this request would put the goal over `UPLOAD_MAX_FILES`. Measured against
 *   the **directory** rather than the request, so a cap cannot be walked past ten files at
 *   a time; the sentence says how many are already there.
 * - `empty_file` — a zero-byte file. Refused rather than stored: an agent told to read a
 *   file that has nothing in it will report that the evidence says nothing, which is a
 *   false reading of an upload that went wrong.
 * - `unsafe_name` — a name that could not be stored safely: `..`, a path separator, a
 *   leading dot, or any character outside `A-Za-z0-9`, space, `.`, `_`, `-`, `(`, `)`.
 *   **Refused rather than normalised into something storable.** Stripping a directory off
 *   `../../etc/passwd` and quietly keeping `passwd` would store a file nobody asked for
 *   under a name nobody chose, and every browser sends a bare filename anyway — so a name
 *   with a separator in it is a request worth answering rather than tidying.
 * - `write_failed` — the directory exists, the gate is in it, and the bytes would not go to
 *   disk. A full or read-only filesystem, said as itself rather than folded into
 *   `store_unavailable`, because nothing about the target's database is wrong and an
 *   operator told to check their database would be looking in the wrong place.
 *
 * The rest are the states {@link GoalConversationRefused} already names, and they are the
 * same facts for the same reason: an upload needs the goal's directory *gated* before
 * anything is written into it, and the gate installer belongs to a harness. A server with
 * no harness therefore cannot take an attachment — which is honest, since it could not run
 * the agent that would read it either.
 *
 * `409` for {@link GoalConversationRefused}'s reason: every one is a conflict with the
 * state of the goal, the caps or the installation rather than a malformed request.
 */
export class GoalUploadRefused extends Schema.TaggedError<GoalUploadRefused>()(
  "GoalUploadRefused",
  {
    reason: Schema.Literals([
      "no_files",
      "too_large",
      "too_many",
      "empty_file",
      "unsafe_name",
      "write_failed",
      "no_harness",
      "harness_not_ready",
      "goal_not_active",
      "goal_directory_unusable",
      "goal_ungated",
      "target_unavailable",
      "store_unavailable",
    ]),
    detail: Schema.String,
  },
  { httpApiStatus: 409 },
) {
  override get message(): string {
    return `${this.reason}: ${this.detail}`;
  }
}
