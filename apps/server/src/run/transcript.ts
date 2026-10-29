/**
 * An attempt's transcript, written beside the evidence it produced.
 *
 * ## Why this is a file and not a table
 *
 * `run/narration.ts` records the argument for not putting narration in the event log: one
 * row per token-ish event, every row taking SQLite's single write lock on the same file the
 * worker is recording observations into, for something that is a transcript rather than a
 * provenance record. That argument has not changed. What has changed is that there is now
 * somewhere obvious to put it: `targets/<id>/evidence/`, which already holds
 * `policy-audit.log` and is established as where the things that are not database rows go.
 *
 * ## Written from `messages`, not from the drained stream
 *
 * The supervisor drains `sessionEvents` and publishes it, and **that is not the source
 * here.** Both implementations of `sessionEvents` have a window between the subscription
 * being asked for and it being established — the reason it is documented as live-only and
 * is not the settlement signal — and on OpenCode that window sits exactly between
 * subscribing and prompting. A transcript taken from it would be missing its beginning,
 * sometimes, unreproducibly.
 *
 * {@link AgentHarness.messages} has no such window: it is the harness's own complete log of
 * the session, asked for once, after the session has stopped. `agentHarness.ts` says it was
 * put on the seam "so the capability is not foreclosed" and read by nothing in slice B
 * precisely so this slice could choose. This is the choice.
 *
 * The cost is stated: `messages` is a reduction — `{ type, text, error }` per entry — so
 * what is written is the transcript as *this application* reads it and not the harness's
 * raw payloads. Widening it would mean widening the seam in a direction the two harnesses
 * do not agree on, which `agentHarness.ts` refuses on purpose. Part of why the harness's
 * own view is also offered ({@link harnessTranscript}) is that it stays the richer one.
 *
 * ## Settle first, then write
 *
 * The attempt row and its `attempt.settled` event are the durable record; this is an
 * artefact beside it. So {@link writeTranscript} runs **after** settlement, never inside
 * it, its failure is logged and discarded, and its absence is a normal state that
 * {@link readTranscript} reports as such rather than as an error. A transcript write that
 * could delay or prevent a settlement would have inverted the two.
 *
 * ## A transcript can be large, and here is what that means
 *
 * Two caps and an incremental write:
 *
 * - **The file is streamed, not built.** One `Bun.file(path).writer()`, one JSON line at a
 *   time, with the content hash fed the same bytes as it goes. Nothing ever holds the
 *   serialised transcript as a single string, which is the allocation that actually hurts
 *   on a long run.
 * - **{@link TRANSCRIPT_MAX_ENTRIES} entries and {@link TRANSCRIPT_MAX_BYTES} of payload**,
 *   whichever is reached first. **At the limit the file is closed and kept**, with a
 *   `transcript.footer` line recording `truncated: true` and how many entries were written
 *   of how many were offered. A truncated transcript is a better artefact than no
 *   transcript, and a truncated one that did not say so would be worse than either.
 *
 * What is *not* bounded here is the fetch. `messages` answers with an array — OpenCode's
 * `message.list` is one HTTP response and the SDK's `getSessionMessages` resolves one
 * promise — so the harness's own API buffers the whole log before this module sees a byte
 * of it. Streaming the fetch would mean a `Stream` on the seam, which neither harness can
 * honestly provide. What bounds that instead is {@link TRANSCRIPT_FETCH_TIMEOUT}: the ask
 * is cut short, the absence is recorded as normal, and the settlement it runs after has
 * already happened.
 *
 * ## Content-hashed, keyed to the attempt
 *
 * `<attemptId>-<sha256 prefix>.transcript.jsonl`. The attempt id is the prefix so the read
 * path finds it with one directory listing and no index table — and so no migration is
 * needed for an artefact that is not a row. The hash is a suffix so that re-settling an
 * attempt (a recovery sweep refining an `uncertain`) writes a *second* file rather than
 * overwriting the first, and two files with the same hash are provably the same transcript.
 *
 * The write lands on a dotted `.partial` name and is renamed once it is closed, so a
 * process that dies mid-write leaves no file under a name the read path will pick up — and
 * the hash in the final name is therefore always the hash of what is actually in it.
 */
import { mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

import { Effect, Schema, type Duration } from "effect";

import {
  AgentHarness,
  SESSION_NOT_FOUND_TAG,
  type MessageEntry,
} from "../harness/agentHarness";
import type { HarnessResolver } from "../harness/resolver";

/** How a transcript file is named, after the attempt id and the content hash. */
export const TRANSCRIPT_SUFFIX = ".transcript.jsonl";

/**
 * The most entries one transcript file holds.
 *
 * A long agent run is thousands of messages, not millions; this is roughly an order of
 * magnitude above anything observed and is here so a pathological session cannot fill a
 * disk. What happens at the limit is on this module's header.
 */
export const TRANSCRIPT_MAX_ENTRIES = 20_000;

/** The most payload bytes one transcript file holds. See the header on the limit. */
export const TRANSCRIPT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * How long the transcript fetch may take.
 *
 * Deliberately the same shape of bound, and for the same reason, as
 * `run/settlement.ts`'s `SETTLEMENT_ASK_TIMEOUT`: this ask runs after a settlement, which
 * on a shutdown path means the harness child may be dying at the same moment. Shorter than
 * the settlement bound, because by the time this runs the durable record is already
 * written and the only thing left to lose is an artefact whose absence is normal.
 */
export const TRANSCRIPT_FETCH_TIMEOUT: Duration.Input = "5 seconds";

/** How many entries a read answers with before it says it stopped. */
export const TRANSCRIPT_READ_LIMIT = 2_000;

/** The transcript could not be written. Logged and discarded; never a run's outcome. */
export class TranscriptWriteError extends Schema.TaggedError<TranscriptWriteError>()(
  "TranscriptWriteError",
  { path: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `could not write the transcript to ${this.path}: ${this.detail}`;
  }
}

/** What one written transcript is, for the log line and for a test to assert on. */
export interface TranscriptArtefact {
  /** Absolute path of the finished file. */
  readonly path: string;
  /** Full sha256 of the file's bytes. The filename carries its first 12 characters. */
  readonly contentHash: string;
  /** Entries actually written. Equal to `offered` unless `truncated`. */
  readonly entries: number;
  /** Entries the harness offered. */
  readonly offered: number;
  readonly bytes: number;
  readonly truncated: boolean;
}

/** What a transcript file says about itself, on its first line. */
export interface TranscriptHeader {
  readonly record: "transcript.header";
  readonly attemptId: string;
  readonly targetId: string;
  readonly harnessSessionId: string;
  /** The instance the attempt was pinned to, which is what the attempt row stores. */
  readonly instanceId: string;
  /** Re-derived at write time from that instance, never stored against the run. */
  readonly driver: string;
  readonly providerId: string;
  readonly modelId: string;
  /** The status the attempt settled to. */
  readonly status: string;
  readonly writtenAt: number;
  readonly entriesOffered: number;
}

const encoder = new TextEncoder();

/**
 * Writes one attempt's transcript and returns what it wrote.
 *
 * Synchronous filesystem calls for the directory and the rename, `Bun`'s sink for the
 * bytes: the same mix `policy/install.ts` already uses, and for the same reason — a
 * `mkdir` that cannot fail usefully is clearer as one line than as an effect.
 */
export const writeTranscript = Effect.fnUntraced(function* (input: {
  /** The target's own `evidence/` directory. */
  readonly directory: string;
  readonly header: Omit<
    TranscriptHeader,
    "record" | "writtenAt" | "entriesOffered"
  >;
  readonly entries: readonly MessageEntry[];
}) {
  const partial = join(
    input.directory,
    `.${input.header.attemptId}${TRANSCRIPT_SUFFIX}.partial`,
  );
  return yield* Effect.tryPromise({
    try: async (): Promise<TranscriptArtefact> => {
      mkdirSync(input.directory, { recursive: true });
      const hasher = new Bun.CryptoHasher("sha256");
      const sink = Bun.file(partial).writer();
      let bytes = 0;
      let written = 0;
      let truncated = false;

      const line = (value: unknown): void => {
        const chunk = encoder.encode(`${JSON.stringify(value)}\n`);
        hasher.update(chunk);
        sink.write(chunk);
        bytes += chunk.byteLength;
      };

      try {
        line({
          record: "transcript.header",
          ...input.header,
          writtenAt: Date.now(),
          entriesOffered: input.entries.length,
        } satisfies TranscriptHeader);

        for (const entry of input.entries) {
          if (
            written >= TRANSCRIPT_MAX_ENTRIES ||
            bytes >= TRANSCRIPT_MAX_BYTES
          ) {
            truncated = true;
            break;
          }
          line({
            record: "message",
            index: written,
            type: entry.type,
            text: entry.text,
            error: entry.error ?? null,
          });
          written += 1;
        }

        line({
          record: "transcript.footer",
          entriesWritten: written,
          entriesOffered: input.entries.length,
          truncated,
          // Named on the artefact rather than inferred from the counts, so a reader does
          // not have to know which of the two caps bit.
          limit: truncated
            ? written >= TRANSCRIPT_MAX_ENTRIES
              ? "entries"
              : "bytes"
            : null,
        });
      } finally {
        await sink.end();
      }

      const contentHash = hasher.digest("hex");
      const path = join(
        input.directory,
        `${input.header.attemptId}-${contentHash.slice(0, 12)}${TRANSCRIPT_SUFFIX}`,
      );
      // Renamed, not written in place: a process that dies mid-write leaves a dotted
      // `.partial` the read path does not look at, so a name the reader trusts always
      // holds a complete file whose hash is the hash of its bytes.
      renameSync(partial, path);
      return {
        path,
        contentHash,
        entries: written,
        offered: input.entries.length,
        bytes,
        truncated,
      };
    },
    catch: (cause) =>
      new TranscriptWriteError({ path: partial, detail: String(cause) }),
  });
});

/**
 * Fetches one session's transcript from the harness and writes it, best effort.
 *
 * **Everything about this is "best effort" in a specific sense**, and the three properties
 * are worth naming because each is a thing that must not happen:
 *
 * 1. It runs *after* the settlement, so a failure here cannot prevent or delay one.
 * 2. The fetch is bounded by {@link TRANSCRIPT_FETCH_TIMEOUT} and the whole thing is
 *    `Effect.result`-ed, so a dying harness cannot wedge a shutdown.
 * 3. An absence is logged as a normal condition, not as an error. A harness that had
 *    nothing to say about a session that never got as far as a prompt is the common case.
 *
 * Returns the artefact when one was written, and `undefined` otherwise — which the caller
 * uses for one log line and nothing else.
 */
export const captureTranscript = Effect.fnUntraced(function* (input: {
  readonly directory: string;
  readonly header: Omit<
    TranscriptHeader,
    "record" | "writtenAt" | "entriesOffered"
  >;
  readonly fetchTimeout?: Duration.Input | undefined;
}) {
  const harness = yield* AgentHarness;
  const fetched = yield* Effect.result(
    Effect.timeout(
      harness.messages(input.header.harnessSessionId),
      input.fetchTimeout ?? TRANSCRIPT_FETCH_TIMEOUT,
    ),
  );
  if (fetched._tag === "Failure") {
    yield* Effect.logInfo(
      "no transcript was written for a settled attempt: the harness could not be asked for its session log. The attempt row and its 'attempt.settled' event are the record; a transcript is an artefact beside them and its absence is normal",
      {
        attemptId: input.header.attemptId,
        harnessSessionId: input.header.harnessSessionId,
        detail: fetched.failure.message,
      },
    );
    return undefined;
  }
  if (fetched.success.length === 0) {
    yield* Effect.logInfo(
      "no transcript was written for a settled attempt: the harness holds no messages for its session",
      {
        attemptId: input.header.attemptId,
        harnessSessionId: input.header.harnessSessionId,
      },
    );
    return undefined;
  }

  const written = yield* Effect.result(
    writeTranscript({
      directory: input.directory,
      header: input.header,
      entries: fetched.success,
    }),
  );
  if (written._tag === "Failure") {
    yield* Effect.logWarning(
      "a settled attempt's transcript could not be written; the attempt itself is settled and recorded",
      {
        attemptId: input.header.attemptId,
        detail: written.failure.message,
      },
    );
    return undefined;
  }
  yield* Effect.logInfo("a settled attempt's transcript was written", {
    attemptId: input.header.attemptId,
    path: written.success.path,
    entries: written.success.entries,
    truncated: written.success.truncated,
  });
  return written.success;
});

/* ── Reading one back ────────────────────────────────────────────────────────── */

/** Where a transcript came from. Never collapsed: the two have different lifetimes. */
export type TranscriptSource = "recorded" | "harness" | "absent";

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
   * Whether what is being shown can disappear.
   *
   * `true` only for {@link TranscriptSource} `harness`. Claude Code deletes local
   * transcripts after `cleanupPeriodDays` — 30 by default — and an OpenCode session lives
   * in a server process that restarts, so for anything old an absence is the *expected*
   * answer. A reader that presented the two sources as equal-status data would be
   * promising a durability only one of them has.
   */
  readonly ephemeral: boolean;
  /** A sentence for an operator. Always set, including on a successful read. */
  readonly note: string;
  readonly entries: readonly TranscriptEntry[];
  /** Entries this read stopped short of. See {@link TRANSCRIPT_READ_LIMIT}. */
  readonly truncated: boolean;
  /** Set when {@link source} is `recorded`. */
  readonly path: string | undefined;
  readonly contentHash: string | undefined;
  readonly writtenAt: number | undefined;
}

/** Our own files for one attempt, newest first. Exported for the tests. */
export const transcriptFilesFor = (
  directory: string,
  attemptId: string,
): readonly { readonly path: string; readonly modifiedAt: number }[] => {
  let names: readonly string[];
  try {
    names = readdirSync(directory);
  } catch {
    // No evidence directory yet is the same answer as no transcript in it.
    return [];
  }
  const prefix = `${attemptId}-`;
  return names
    .filter(
      (name) => name.startsWith(prefix) && name.endsWith(TRANSCRIPT_SUFFIX),
    )
    .map((name) => {
      const path = join(directory, name);
      let modifiedAt = 0;
      try {
        modifiedAt = statSync(path).mtimeMs;
      } catch {
        /* vanished between the listing and the stat: treat it as oldest. */
      }
      return { path, modifiedAt };
    })
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
};

const parseLine = (line: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const text = (value: unknown): string =>
  typeof value === "string" ? value : "";

/**
 * Reads our own artefact for one attempt, if there is one.
 *
 * Tolerant of a line it cannot parse rather than refusing the file: a transcript is an
 * artefact and half of one is more use than none. Nothing reconciles against it, so there
 * is no decision a malformed line could corrupt.
 */
export const readRecordedTranscript = Effect.fnUntraced(function* (input: {
  readonly directory: string;
  readonly attemptId: string;
  readonly limit?: number | undefined;
}) {
  const limit = input.limit ?? TRANSCRIPT_READ_LIMIT;
  const files = transcriptFilesFor(input.directory, input.attemptId);
  const newest = files[0];
  if (newest === undefined) return undefined;
  const read = yield* Effect.result(
    Effect.tryPromise(() => Bun.file(newest.path).text()),
  );
  if (read._tag === "Failure") return undefined;

  const entries: TranscriptEntry[] = [];
  let header: Record<string, unknown> | undefined;
  let footerTruncated = false;
  let stopped = false;
  for (const line of read.success.split("\n")) {
    if (line === "") continue;
    const record = parseLine(line);
    if (record === undefined) continue;
    if (record["record"] === "transcript.header") {
      header = record;
      continue;
    }
    if (record["record"] === "transcript.footer") {
      footerTruncated = record["truncated"] === true;
      continue;
    }
    if (record["record"] !== "message") continue;
    if (entries.length >= limit) {
      stopped = true;
      continue;
    }
    entries.push({
      index: entries.length,
      type: text(record["type"]),
      text: text(record["text"]),
      error: typeof record["error"] === "string" ? record["error"] : undefined,
    });
  }

  // The hash in the name is the hash of the bytes, so it is read off the name rather than
  // recomputed: re-hashing on every read would be work to confirm something the rename
  // already guarantees.
  const name = newest.path.slice(newest.path.lastIndexOf("/") + 1);
  const hash = name
    .slice(input.attemptId.length + 1)
    .replace(TRANSCRIPT_SUFFIX, "");

  const truncated = stopped || footerTruncated;
  return {
    source: "recorded" as const,
    ephemeral: false,
    note: truncated
      ? "Recorded by this server when the attempt settled. Shortened: not every message is shown."
      : "Recorded by this server when the attempt settled.",
    entries,
    truncated,
    path: newest.path,
    contentHash: hash,
    writtenAt:
      typeof header?.["writtenAt"] === "number"
        ? (header["writtenAt"] as number)
        : newest.modifiedAt,
  } satisfies TranscriptRead;
});

/**
 * Asks the harness for a past session's transcript.
 *
 * **Offered as the lesser-status source, on purpose.** It is the richer view while it
 * lasts — the harness's own log, including whatever it retains that our reduction drops —
 * and it lasts exactly as long as the harness feels like keeping it. Claude Code deletes
 * local transcripts after `cleanupPeriodDays`, 30 by default, and OpenCode answers from a
 * running server's store. So for anything old, *gone* is the normal answer, and this
 * reports it as "no longer available" rather than as a failure.
 *
 * The instance matters and is honoured. A session recorded against an instance this process
 * does not configure is **not** asked about: asking the harness we do have would get a
 * confident "no such session" for a session that may be alive somewhere else, which is the
 * same mistake `recovery/harnessStatus.ts` refuses to make.
 */
export const harnessTranscript = Effect.fnUntraced(function* (input: {
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
}) {
  const limit = input.limit ?? TRANSCRIPT_READ_LIMIT;
  const absent = (note: string): TranscriptRead => ({
    source: "absent",
    ephemeral: false,
    note,
    entries: [],
    truncated: false,
    path: undefined,
    contentHash: undefined,
    writtenAt: undefined,
  });

  if (input.harnessSessionId === null || input.harnessSessionId === "") {
    return absent(
      "This attempt has no harness session recorded, so there is nothing to ask about. It does not establish that no work was done.",
    );
  }
  const resolved = yield* Effect.result(
    input.resolver.resolve(input.harnessInstanceId ?? undefined),
  );
  if (resolved._tag === "Failure") {
    return absent(
      `No longer available: ${resolved.failure.message} The server's own copy, if it wrote one, is the record.`,
    );
  }
  // A row written before instances were recorded (`null`) resolves to the default, which
  // is the best available answer rather than a guess — the same reading
  // `recovery/harnessStatus.ts` gives it. A row naming a *different* instance is foreign
  // and was refused above.
  if (
    input.harnessInstanceId !== null &&
    resolved.success.instance.instanceId !== input.harnessInstanceId
  ) {
    return absent(
      `No longer available: this attempt ran on harness instance '${input.harnessInstanceId}', which this server does not configure.`,
    );
  }

  const fetched = yield* Effect.result(
    Effect.timeout(
      resolved.success.harness.messages(input.harnessSessionId),
      TRANSCRIPT_FETCH_TIMEOUT,
    ),
  );
  if (fetched._tag === "Failure") {
    const failure = fetched.failure;
    const forgotten =
      failure._tag === "HarnessTransportError" &&
      (failure.tag === SESSION_NOT_FOUND_TAG || failure.status === 404);
    return absent(
      forgotten
        ? `No longer available: ${resolved.success.instance.displayName} no longer holds session ${input.harnessSessionId}. Harnesses keep their own transcripts for a while and then delete them, so this is the normal answer for an older attempt.`
        : `No longer available: ${resolved.success.instance.displayName} could not be asked about session ${input.harnessSessionId} — ${failure.message}`,
    );
  }
  if (fetched.success.length === 0) {
    return absent(
      `No longer available: ${resolved.success.instance.displayName} holds no messages for session ${input.harnessSessionId}.`,
    );
  }

  const kept = fetched.success.slice(0, limit);
  return {
    source: "harness",
    ephemeral: true,
    note: `From ${resolved.success.instance.displayName}, which may delete it: harnesses keep their own transcripts for a while — Claude Code for 30 days by default — so this view can be gone tomorrow.${
      fetched.success.length > kept.length
        ? " Shortened: not every message is shown."
        : ""
    }`,
    entries: kept.map((entry, index) => ({
      index,
      type: entry.type,
      text: entry.text,
      error: entry.error,
    })),
    truncated: fetched.success.length > kept.length,
    path: undefined,
    contentHash: undefined,
    writtenAt: undefined,
  } satisfies TranscriptRead;
});

/**
 * One attempt's transcript: ours if we have it, the harness's if we do not.
 *
 * **Ours is the system of record and is preferred**, because it is the one that is still
 * there in a year. The harness's is the fallback and the live-poking view, and
 * {@link TranscriptRead.ephemeral} is what keeps a reader from presenting them as the same
 * kind of thing.
 */
export const readTranscript = Effect.fnUntraced(function* (input: {
  readonly resolver: HarnessResolver["Service"];
  readonly directory: string;
  readonly attemptId: string;
  readonly harnessSessionId: string | null;
  readonly harnessInstanceId: string | null;
  readonly limit?: number | undefined;
}) {
  const ours = yield* readRecordedTranscript({
    directory: input.directory,
    attemptId: input.attemptId,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  if (ours !== undefined) return ours;
  return yield* harnessTranscript({
    resolver: input.resolver,
    harnessSessionId: input.harnessSessionId,
    harnessInstanceId: input.harnessInstanceId,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
});
