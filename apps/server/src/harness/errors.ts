/**
 * Harness failure taxonomy.
 *
 * The distinctions here are load-bearing, not cosmetic. A reconciling caller has to
 * tell "we could not ask" from "the harness answered something we cannot trust"
 * (DECISIONS.md §15 "Recovery"), and neither of those may be reported as a defect: both
 * are expected conditions on a local subprocess boundary.
 *
 * - {@link HarnessTransportError} — the request did not produce a usable HTTP answer, or
 *   produced a non-2xx one. Carries the status when there was one. **Does not mean
 *   remote execution stopped**: an interrupted or timed-out request says nothing about
 *   what the harness is still doing.
 * - {@link HarnessDecodeError} — the harness answered 2xx with a body that does not match
 *   the contract we decode. The status and the schema issue are both kept, because
 *   "200 with an unexpected shape" is a different diagnosis from "503".
 * - {@link HarnessProcessError} — the harness as a *program* rather than as a
 *   conversation: spawning it, waiting for it, stopping it, or finding it unfit to use.
 *   Raised while a harness layer is being built, which is why `main.ts` can catch it and
 *   serve without an agent instead of failing to boot.
 */
import { Schema } from "effect";

export class HarnessTransportError extends Schema.TaggedError<HarnessTransportError>()(
  "HarnessTransportError",
  {
    operation: Schema.String,
    /** HTTP status, or `undefined` when no response was received at all. */
    status: Schema.UndefinedOr(Schema.Int),
    /**
     * The generated client's own tag for the failure, when it had one.
     *
     * Kept because one distinction downstream genuinely needs it: "this session does
     * not exist" (`SessionNotFoundError`) is a different fact from "we could not ask",
     * and recovery maps the two to different dispositions. It is the client's
     * vocabulary, not ours — a value we recognise, never one we invent — so it is a
     * plain string rather than a union this build would have to keep in step with
     * `@opencode/protocol`, which is not a declared dependency here.
     */
    tag: Schema.UndefinedOr(Schema.String),
    detail: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `${this.operation}: ${this.status === undefined ? "no response" : `HTTP ${this.status}`} — ${this.detail}`;
  }
}

export class HarnessDecodeError extends Schema.TaggedError<HarnessDecodeError>()(
  "HarnessDecodeError",
  {
    operation: Schema.String,
    /**
     * HTTP status, when the failure carried one.
     *
     * Optional because the decode is no longer always ours: the generated OpenCode
     * client raises its own `SchemaError`, and that error does not always name the
     * response it came from. Reporting "HTTP 200" because that is the likely answer
     * would be inventing evidence.
     */
    status: Schema.UndefinedOr(Schema.Int),
    /** The schema issue, formatted. The structured cause is kept in `cause`. */
    detail: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const where =
      this.status === undefined ? "the response" : `HTTP ${this.status}`;
    return `${this.operation}: ${where} body did not match the contract — ${this.detail}`;
  }
}

export class HarnessProcessError extends Schema.TaggedError<HarnessProcessError>()(
  "HarnessProcessError",
  {
    /**
     * Which part of owning the harness failed.
     *
     * `version` is not about a process at all: it is a harness that is present and
     * runnable but **too old to make a guarantee we depend on**. It joins this error
     * rather than getting one of its own because the disposition is identical — the layer
     * does not build, `main.ts` logs it and serves without an agent — and because a
     * second error type would be a second branch there for the same outcome.
     */
    operation: Schema.Literals([
      "spawn",
      "port",
      "readiness",
      "termination",
      "version",
    ]),
    detail: Schema.String,
    /** Tail of the process's own stderr/stdout, when we have one. */
    diagnostics: Schema.String,
  },
) {
  override get message(): string {
    // No harness named: this error used to be OpenCode's alone and said so, which would
    // now be a confidently wrong prefix on a Claude Code failure.
    return `harness ${this.operation}: ${this.detail}${this.diagnostics === "" ? "" : `\n${this.diagnostics}`}`;
  }
}

/**
 * An answer or a dismissal for a question the harness is no longer waiting on (A7-Q).
 *
 * `settled` — the request was answered, dismissed or withdrawn already, or the harness never
 * held it (OpenCode's `FormAlreadySettledError` and `FormNotFoundError`, Claude Code's
 * pending map without it). `invalid` — the harness refused the answers themselves
 * (OpenCode's `FormInvalidAnswerError`); bit checks them first with
 * `questionAnswersProblem`, so this is the harness and bit disagreeing.
 */
export class QuestionNotPending extends Schema.TaggedError<QuestionNotPending>()(
  "QuestionNotPending",
  {
    questionId: Schema.String,
    reason: Schema.Literals(["settled", "invalid"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/** Anything the harness seam can fail with as an expected condition. */
export type HarnessError =
  HarnessTransportError | HarnessDecodeError | HarnessProcessError;
