/**
 * An attempt's transcript, read from the harness and from nowhere else.
 *
 * ## There is no copy
 *
 * This application does not keep its own record of an agent's conversation. It used to
 * write one beside the evidence at settlement; the operator decided against it. What an
 * attempt *did* is the attempt row, its `attempt.settled` event and the observations it
 * recorded. What the agent *said* is the harness's, read on demand and gone when the
 * harness purges it.
 *
 * That makes the purge the normal end of every transcript, not a fault. Claude Code deletes
 * local transcripts after `cleanupPeriodDays` — 30 by default — and an OpenCode session lives
 * in a server process that restarts. So for anything old, *gone* is the expected answer, and
 * the one thing this module must never do is blur the three answers it can give:
 *
 * - **`harness`** — the harness answered with messages. Shown, and labelled as the thing
 *   that can be gone tomorrow.
 * - **`absent`** — the harness was asked and does not hold it: it has forgotten the
 *   session, holds nothing under it, or this attempt never had a session to ask about. That
 *   is *gone*, and it is normal.
 * - **`unreachable`** — the harness could not be asked: it will not start, the instance is
 *   not one this server configures, the request failed or timed out. That says **nothing**
 *   about whether the transcript still exists, so it must not read as gone — and it is not
 *   an empty conversation either.
 *
 * ## Transcript files written by earlier versions are ignored
 *
 * Earlier versions wrote `<attemptId>-<hash>.transcript.jsonl` into `targets/<id>/evidence/`.
 * Nothing reads or removes them now. A reader that could still find one would answer for an
 * attempt from a copy the operator has decided not to keep, and a startup sweep would
 * delete operator data on the strength of a code change. They are inert; remove them by hand
 * if they are unwanted.
 */
import { Effect, type Duration } from "effect";

import { SESSION_NOT_FOUND_TAG } from "../harness/agentHarness";
import type { HarnessResolver } from "../harness/resolver";

/**
 * How long the harness may take to answer for a transcript.
 *
 * Deliberately the same shape of bound, and for the same reason, as
 * `run/settlement.ts`'s `SETTLEMENT_ASK_TIMEOUT`: a harness child may be dying at the same
 * moment it is asked, and a read that waited on it would hang the request. Also what bounds
 * `plan/roundNarration.ts`'s replay.
 */
export const TRANSCRIPT_FETCH_TIMEOUT: Duration.Input = "5 seconds";

/** How many entries a read answers with before it says it stopped. */
export const TRANSCRIPT_READ_LIMIT = 2_000;

/** What a read found, told apart on purpose. See the module header for the three. */
export type TranscriptSource = "harness" | "absent" | "unreachable";

/** One entry of a transcript, as a reader gets it. */
export interface TranscriptEntry {
  readonly index: number;
  readonly type: string;
  readonly text: string;
  readonly error: string | undefined;
}

export interface TranscriptRead {
  readonly source: TranscriptSource;
  /**
   * Whether what is being shown can disappear. `true` exactly when {@link source} is
   * `harness`: the harness decides how long it keeps its log.
   */
  readonly ephemeral: boolean;
  /** A sentence for an operator. Always set, including on a successful read. */
  readonly note: string;
  /** Empty unless {@link source} is `harness`. */
  readonly entries: readonly TranscriptEntry[];
  /** Entries this read stopped short of. See {@link TRANSCRIPT_READ_LIMIT}. */
  readonly truncated: boolean;
}

/**
 * Asks the harness for a past session's transcript.
 *
 * The instance matters and is honoured. A session recorded against an instance this process
 * does not configure is **not** asked about: asking the harness we do have would get a
 * confident "no such session" for a session that may be alive somewhere else, which is the
 * same mistake `recovery/harnessStatus.ts` refuses to make. The resolver refuses it, and
 * that is `unreachable`, not `absent`: we did not learn that it is gone.
 */
export const readTranscript = Effect.fnUntraced(function* (input: {
  /**
   * The resolver, as a parameter rather than from the context.
   *
   * The reason is `persistence/targetStores.ts`'s, verbatim: a requirement yielded inside
   * an HTTP handler becomes a per-request requirement of the *route*, and the handler group
   * resolves this once where it is built. Taking it here keeps that true.
   */
  readonly resolver: HarnessResolver["Service"];
  readonly harnessSessionId: string | null;
  readonly harnessInstanceId: string | null;
  readonly limit?: number | undefined;
  /** Replaces {@link TRANSCRIPT_FETCH_TIMEOUT}. For a test that must not sit out five seconds. */
  readonly fetchTimeout?: Duration.Input | undefined;
}) {
  const limit = input.limit ?? TRANSCRIPT_READ_LIMIT;
  const without = (
    source: "absent" | "unreachable",
    note: string,
  ): TranscriptRead => ({
    source,
    ephemeral: false,
    note,
    entries: [],
    truncated: false,
  });

  if (input.harnessSessionId === null || input.harnessSessionId === "") {
    return without(
      "absent",
      "This attempt has no harness session recorded, so there is no transcript to ask for. It does not establish that no work was done.",
    );
  }
  const resolved = yield* Effect.result(
    input.resolver.resolve(input.harnessInstanceId ?? undefined),
  );
  if (resolved._tag === "Failure") {
    return without(
      "unreachable",
      `Could not ask the harness: ${resolved.failure.message} The transcript may still exist there.`,
    );
  }
  // A row written before instances were recorded (`null`) resolves to the default, which
  // is the best available answer rather than a guess — the same reading
  // `recovery/harnessStatus.ts` gives it. A row naming an instance this server does not
  // configure never gets here: the resolver refuses it above, which is what keeps us from
  // asking the harness we *do* have and getting a confident "no such session".

  const name = resolved.success.instance.displayName;
  const fetched = yield* Effect.result(
    Effect.timeout(
      resolved.success.harness.messages(input.harnessSessionId),
      input.fetchTimeout ?? TRANSCRIPT_FETCH_TIMEOUT,
    ),
  );
  if (fetched._tag === "Failure") {
    const failure = fetched.failure;
    const forgotten =
      failure._tag === "HarnessTransportError" &&
      (failure.tag === SESSION_NOT_FOUND_TAG || failure.status === 404);
    return forgotten
      ? without(
          "absent",
          `No longer available: ${name} no longer holds session ${input.harnessSessionId}. Harnesses delete their own transcripts after a while — Claude Code after 30 days by default — so this is the normal answer for an older attempt.`,
        )
      : without(
          "unreachable",
          `Could not ask ${name} about session ${input.harnessSessionId}: ${failure.message} The transcript may still exist there.`,
        );
  }
  if (fetched.success.length === 0) {
    return without(
      "absent",
      `No longer available: ${name} holds no messages for session ${input.harnessSessionId}.`,
    );
  }

  const kept = fetched.success.slice(0, limit);
  const truncated = fetched.success.length > kept.length;
  return {
    source: "harness",
    ephemeral: true,
    note: `From ${name}, which may delete it: harnesses keep their own transcripts for a while — Claude Code for 30 days by default — and bit keeps no copy, so this can be gone tomorrow.${
      truncated ? " Shortened: not every message is shown." : ""
    }`,
    entries: kept.map((entry, index) => ({
      index,
      type: entry.type,
      text: entry.text,
      error: entry.error,
    })),
    truncated,
  } satisfies TranscriptRead;
});
