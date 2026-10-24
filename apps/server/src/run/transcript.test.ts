/**
 * Real-file tests for the transcript artefact and the two ways of reading one back.
 *
 * Every claim is about a file on disk or about what the read path answers when there is
 * no file, which is why this suite is part of `test:persistence` rather than a unit test
 * over a mock filesystem: the content hash in a name, the rename out of `.partial` and the
 * directory listing that finds an attempt's file are all things nothing checks at compile
 * time.
 *
 * What is **not** real here is the harness. `messages` is a scripted answer, because what
 * is under test is the artefact and the fallback — not a harness — and because "the harness
 * has forgotten this session" is a state a live one cannot be asked to be in on demand.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, type Duration } from "effect";

import { AgentHarness, type MessageEntry } from "../harness/agentHarness";
import { HarnessTransportError } from "../harness/errors";
import { HarnessResolver } from "../harness/resolver";
import { stubHarness, STUB_INSTANCE } from "../harness/stubHarness";
import {
  TRANSCRIPT_MAX_ENTRIES,
  TRANSCRIPT_SUFFIX,
  captureTranscript,
  harnessTranscript,
  readRecordedTranscript,
  readTranscript,
  transcriptFilesFor,
  writeTranscript,
} from "./transcript";

const directories: string[] = [];
afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true });
  }
});

const newEvidence = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "bit-transcript-"));
  directories.push(directory);
  // Deliberately *not* created: `writeTranscript` makes it, the way a first run does.
  return join(directory, "targets", "alpha", "evidence");
};

const header = (attemptId = "at_1") => ({
  attemptId,
  targetId: "alpha",
  harnessSessionId: "ses_1",
  instanceId: STUB_INSTANCE.instanceId,
  driver: STUB_INSTANCE.driver,
  providerId: "stub",
  modelId: "model",
  status: "succeeded",
});

const entries = (count: number, text = "hello"): readonly MessageEntry[] =>
  Array.from({ length: count }, (_, index) => ({
    type: index % 2 === 0 ? "assistant" : "tool",
    text: `${text} ${String(index)}`,
    error: undefined,
  }));

/** A resolver over one scripted harness, which is what the read path takes. */
const resolverOver = (harness: AgentHarness["Service"]) =>
  HarnessResolver.fromEntries([{ instance: harness.instance, harness }]);

describe("writing one", () => {
  test("the file is named for the attempt and its content hash, and the directory is made", async () => {
    const directory = newEvidence();
    const written = await Effect.runPromise(
      writeTranscript({ directory, header: header(), entries: entries(3) }),
    );
    expect(written.entries).toBe(3);
    expect(written.offered).toBe(3);
    expect(written.truncated).toBe(false);
    expect(written.path).toBe(
      join(
        directory,
        `at_1-${written.contentHash.slice(0, 12)}${TRANSCRIPT_SUFFIX}`,
      ),
    );
    // One file, and no `.partial` left behind: the write lands on a dotted name and is
    // renamed once it is closed, so a reader never sees a half-written transcript.
    expect(readdirSync(directory)).toEqual([
      `at_1-${written.contentHash.slice(0, 12)}${TRANSCRIPT_SUFFIX}`,
    ]);
  });

  test("the same entries hash the same and different ones do not", async () => {
    const directory = newEvidence();
    const first = await Effect.runPromise(
      writeTranscript({ directory, header: header(), entries: entries(2) }),
    );
    const second = await Effect.runPromise(
      writeTranscript({
        directory,
        header: header(),
        entries: entries(2, "other"),
      }),
    );
    expect(second.contentHash).not.toBe(first.contentHash);
    // Two files, not one overwritten: re-settling an attempt — a recovery sweep refining
    // an `uncertain` — must not destroy the transcript the first settlement wrote.
    expect(readdirSync(directory)).toHaveLength(2);
  });

  test("the file is JSONL: a header, one line per message, a footer", async () => {
    const directory = newEvidence();
    const written = await Effect.runPromise(
      writeTranscript({ directory, header: header(), entries: entries(2) }),
    );
    const lines = (await Bun.file(written.path).text())
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({
      record: "transcript.header",
      attemptId: "at_1",
      instanceId: STUB_INSTANCE.instanceId,
      // Re-derived from the instance at write time; there is no driver column and there is
      // not going to be one.
      driver: STUB_INSTANCE.driver,
      status: "succeeded",
      entriesOffered: 2,
    });
    expect(lines[1]).toMatchObject({ record: "message", index: 0 });
    expect(lines[3]).toMatchObject({
      record: "transcript.footer",
      entriesWritten: 2,
      truncated: false,
      limit: null,
    });
  });

  /**
   * What happens at the limit, which is the decision rather than the number.
   *
   * The file is **closed and kept**, with a footer saying it was shortened and which cap
   * bit. A truncated transcript is a better artefact than none, and one that did not say
   * so would be worse than either.
   */
  test("past the entry cap the file is kept and says it was shortened", async () => {
    const directory = newEvidence();
    const written = await Effect.runPromise(
      writeTranscript({
        directory,
        header: header(),
        entries: entries(TRANSCRIPT_MAX_ENTRIES + 5),
      }),
    );
    expect(written.truncated).toBe(true);
    expect(written.entries).toBe(TRANSCRIPT_MAX_ENTRIES);
    expect(written.offered).toBe(TRANSCRIPT_MAX_ENTRIES + 5);
    const text = await Bun.file(written.path).text();
    expect(text).toContain('"truncated":true');
    expect(text).toContain('"limit":"entries"');
    // And a read of it says so too, so a reader is never shown a shortened transcript as
    // if it were whole.
    const read = await Effect.runPromise(
      readRecordedTranscript({ directory, attemptId: "at_1", limit: 10 }),
    );
    expect(read?.truncated).toBe(true);
  });
});

describe("capturing one at settlement", () => {
  const capture = (
    harness: AgentHarness["Service"],
    directory: string,
    fetchTimeout?: Duration.Input,
  ) =>
    Effect.runPromise(
      captureTranscript({
        directory,
        header: header(),
        ...(fetchTimeout === undefined ? {} : { fetchTimeout }),
      }).pipe(Effect.provideService(AgentHarness, harness)),
    );

  test("it is written from the harness's own message log", async () => {
    const directory = newEvidence();
    const written = await capture(
      stubHarness({ messages: () => Effect.succeed(entries(4)) }),
      directory,
    );
    expect(written?.entries).toBe(4);
  });

  /**
   * A fetch that fails writes nothing and raises nothing.
   *
   * The settlement has already happened by the time this runs, so a failure here must be a
   * log line and not an error channel — which is why `captureTranscript` swallows its own
   * and the supervisor does not wrap it.
   */
  test("a harness that cannot be asked produces no transcript and no failure", async () => {
    const directory = newEvidence();
    const written = await capture(
      stubHarness({
        messages: () =>
          Effect.fail(
            new HarnessTransportError({
              operation: "message.list",
              status: undefined,
              tag: "RequestError",
              detail: "connection refused",
              cause: "none",
            }),
          ),
      }),
      directory,
    );
    expect(written).toBeUndefined();
    expect(transcriptFilesFor(directory, "at_1")).toHaveLength(0);
  });

  /**
   * A fetch that never answers is cut short.
   *
   * The case the bound exists for: settlement runs in a finalizer, so on a `SIGINT` this
   * asks a harness child that is being torn down at the same moment. Without the bound a
   * shutdown would wedge on it.
   */
  test("a harness that never answers is bounded, not waited for", async () => {
    const directory = newEvidence();
    const started = Date.now();
    const written = await capture(
      stubHarness({ messages: () => Effect.never }),
      directory,
      "50 millis",
    );
    expect(written).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a session the harness holds no messages for writes nothing", async () => {
    const directory = newEvidence();
    const written = await capture(
      stubHarness({ messages: () => Effect.succeed([]) }),
      directory,
    );
    expect(written).toBeUndefined();
  });
});

describe("reading one back", () => {
  /** Ours is the record, so it wins even when the harness still has its own copy. */
  test("our own artefact is preferred over the harness's", async () => {
    const directory = newEvidence();
    await Effect.runPromise(
      writeTranscript({
        directory,
        header: header(),
        entries: [
          { type: "assistant", text: "from our file", error: undefined },
        ],
      }),
    );
    const read = await Effect.runPromise(
      readTranscript({
        resolver: resolverOver(
          stubHarness({
            messages: () =>
              Effect.succeed([
                {
                  type: "assistant",
                  text: "from the harness",
                  error: undefined,
                },
              ]),
          }),
        ),
        directory,
        attemptId: "at_1",
        harnessSessionId: "ses_1",
        harnessInstanceId: STUB_INSTANCE.instanceId,
      }),
    );
    expect(read.source).toBe("recorded");
    expect(read.ephemeral).toBe(false);
    expect(read.entries[0]?.text).toBe("from our file");
    expect(read.contentHash).toBeDefined();
  });

  /**
   * An attempt whose transcript we wrote is readable after the harness session is gone.
   *
   * The whole point of writing one: the harness answers `SessionNotFoundError` and the
   * transcript is still there, from our own file, as the record.
   */
  test("our artefact outlives the harness session", async () => {
    const directory = newEvidence();
    await Effect.runPromise(
      writeTranscript({
        directory,
        header: header(),
        entries: entries(2),
      }),
    );
    const forgetful = stubHarness({
      messages: () =>
        Effect.fail(
          new HarnessTransportError({
            operation: "message.list",
            status: 404,
            tag: "SessionNotFoundError",
            detail: "no such session",
            cause: "none",
          }),
        ),
    });
    const read = await Effect.runPromise(
      readTranscript({
        resolver: resolverOver(forgetful),
        directory,
        attemptId: "at_1",
        harnessSessionId: "ses_1",
        harnessInstanceId: STUB_INSTANCE.instanceId,
      }),
    );
    expect(read.source).toBe("recorded");
    expect(read.entries).toHaveLength(2);
  });

  /** With no artefact, the harness's copy is offered — labelled as the thing that goes. */
  test("with no artefact the harness's copy is offered and marked as ephemeral", async () => {
    const directory = newEvidence();
    const read = await Effect.runPromise(
      readTranscript({
        resolver: resolverOver(
          stubHarness({
            messages: () =>
              Effect.succeed([
                {
                  type: "assistant",
                  text: "still in the harness",
                  error: undefined,
                },
              ]),
          }),
        ),
        directory,
        attemptId: "at_1",
        harnessSessionId: "ses_1",
        harnessInstanceId: STUB_INSTANCE.instanceId,
      }),
    );
    expect(read.source).toBe("harness");
    expect(read.ephemeral).toBe(true);
    expect(read.note).toContain("may delete it");
    expect(read.entries[0]?.text).toBe("still in the harness");
  });

  /**
   * A session the harness has forgotten answers "no longer available" rather than erroring.
   *
   * Claude Code deletes local transcripts after `cleanupPeriodDays`, 30 by default, so for
   * anything old this is the *expected* answer and has to read as normal.
   */
  test("a forgotten session is absent and normal, not an error", async () => {
    const read = await Effect.runPromise(
      harnessTranscript({
        resolver: resolverOver(
          stubHarness({
            messages: () =>
              Effect.fail(
                new HarnessTransportError({
                  operation: "message.list",
                  status: 404,
                  tag: "SessionNotFoundError",
                  detail: "no such session",
                  cause: "none",
                }),
              ),
          }),
        ),
        harnessSessionId: "ses_gone",
        harnessInstanceId: STUB_INSTANCE.instanceId,
      }),
    );
    expect(read.source).toBe("absent");
    expect(read.note).toContain("No longer available");
    expect(read.note).toContain("normal answer");
  });

  test("an attempt that never had a session says so without asking anything", async () => {
    const asked: string[] = [];
    const read = await Effect.runPromise(
      harnessTranscript({
        resolver: resolverOver(
          stubHarness({
            messages: (sessionId) =>
              Effect.sync(() => {
                asked.push(sessionId);
                return [];
              }),
          }),
        ),
        harnessSessionId: null,
        harnessInstanceId: STUB_INSTANCE.instanceId,
      }),
    );
    expect(read.source).toBe("absent");
    expect(read.note).toContain("no harness session recorded");
    expect(asked).toHaveLength(0);
  });

  /**
   * A foreign instance is not asked, which is the same honesty `harnessStatus.ts` keeps.
   *
   * Asking the harness we *do* have would get a confident "no such session" for a session
   * that may be alive somewhere else.
   */
  test("a session on an instance this server does not configure is not asked about", async () => {
    const asked: string[] = [];
    const read = await Effect.runPromise(
      harnessTranscript({
        resolver: resolverOver(
          stubHarness({
            messages: (sessionId) =>
              Effect.sync(() => {
                asked.push(sessionId);
                return [];
              }),
          }),
        ),
        harnessSessionId: "ses_elsewhere",
        harnessInstanceId: "some-other-instance",
      }),
    );
    expect(read.source).toBe("absent");
    expect(read.note).toContain("No longer available");
    expect(asked).toHaveLength(0);
  });

  test("a line that will not parse is skipped rather than refusing the file", async () => {
    const directory = newEvidence();
    const written = await Effect.runPromise(
      writeTranscript({ directory, header: header(), entries: entries(1) }),
    );
    // A transcript is an artefact and half of one is more use than none; nothing
    // reconciles against it, so there is no decision a bad line could corrupt.
    writeFileSync(
      written.path,
      `${await Bun.file(written.path).text()}{not json\n`,
    );
    const read = await Effect.runPromise(
      readRecordedTranscript({ directory, attemptId: "at_1" }),
    );
    expect(read?.entries).toHaveLength(1);
  });

  test("a read is capped, and says it stopped", async () => {
    const directory = newEvidence();
    await Effect.runPromise(
      writeTranscript({ directory, header: header(), entries: entries(20) }),
    );
    const read = await Effect.runPromise(
      readRecordedTranscript({ directory, attemptId: "at_1", limit: 5 }),
    );
    expect(read?.entries).toHaveLength(5);
    expect(read?.truncated).toBe(true);
  });

  test("a directory that does not exist is no transcript, not a failure", async () => {
    const read = await Effect.runPromise(
      readRecordedTranscript({
        directory: join(tmpdir(), "bit-no-such-evidence-directory"),
        attemptId: "at_1",
      }),
    );
    expect(read).toBeUndefined();
  });

  test("an unusable instance's session is absent with the resolver's reason", async () => {
    const read = await Effect.runPromise(
      harnessTranscript({
        resolver: HarnessResolver.fromEntries([
          {
            instance: STUB_INSTANCE,
            harness: undefined,
            reason: "the harness would not start",
          },
        ]),
        harnessSessionId: "ses_1",
        harnessInstanceId: STUB_INSTANCE.instanceId,
      }),
    );
    expect(read.source).toBe("absent");
    expect(read.note).toContain("the harness would not start");
  });
});
