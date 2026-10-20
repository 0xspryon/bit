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
 * - {@link HarnessProcessError} — the owned `opencode serve` process itself: spawn,
 *   readiness, or termination.
 */
import { Schema } from "effect";

export class HarnessTransportError extends Schema.TaggedError<HarnessTransportError>()(
  "HarnessTransportError",
  {
    operation: Schema.String,
    /** HTTP status, or `undefined` when no response was received at all. */
    status: Schema.UndefinedOr(Schema.Int),
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
    operation: Schema.Literals(["spawn", "port", "readiness", "termination"]),
    detail: Schema.String,
    /** Tail of the process's own stderr/stdout, when we have one. */
    diagnostics: Schema.String,
  },
) {
  override get message(): string {
    return `opencode ${this.operation}: ${this.detail}${this.diagnostics === "" ? "" : `\n${this.diagnostics}`}`;
  }
}

/** Anything the harness seam can fail with as an expected condition. */
export type HarnessError =
  HarnessTransportError | HarnessDecodeError | HarnessProcessError;
