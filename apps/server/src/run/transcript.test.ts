/**
 * What `readTranscript` answers, in each of the states it has to tell apart.
 *
 * bit keeps no copy of an agent's conversation, so every transcript is the harness's and
 * every one of them ends in a purge. The suite is organised around the three screens that
 * implies, because collapsing any two of them is the failure it exists to catch:
 *
 * - the harness **has** it (`harness`),
 * - the harness **does not hold** it (`absent` — gone, and normal),
 * - the harness **could not be reached** (`unreachable` — says nothing about whether it
 *   still exists).
 *
 * What is not real here is the harness. `messages` is a scripted answer, because "the
 * harness has forgotten this session" is a state a live one cannot be asked to be in on
 * demand. No filesystem is involved: there is no artefact to read.
 */
import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { type AgentHarness, type MessageEntry } from "../harness/agentHarness";
import { HarnessTransportError } from "../harness/errors";
import { HarnessResolver } from "../harness/resolver";
import { stubHarness, STUB_INSTANCE } from "../harness/stubHarness";
import { readTranscript, type TranscriptRead } from "./transcript";

const entries = (count: number): readonly MessageEntry[] =>
  Array.from({ length: count }, (_, index) => ({
    type: index % 2 === 0 ? "assistant" : "tool",
    text: `message ${String(index)}`,
    error: undefined,
    parts: [],
    model: undefined,
    at: undefined,
  }));

const transport = (
  over: Partial<ConstructorParameters<typeof HarnessTransportError>[0]>,
) =>
  new HarnessTransportError({
    operation: "message.list",
    status: undefined,
    tag: "RequestError",
    detail: "connection refused",
    cause: "none",
    ...over,
  });

/** A resolver over one scripted harness, which is what the read path takes. */
const resolverOver = (harness: AgentHarness["Service"]) =>
  HarnessResolver.fromEntries([{ instance: harness.instance, harness }]);

/** One read, against a resolver, for the session this suite uses everywhere. */
const read = (
  harness: AgentHarness["Service"],
  over: Partial<Parameters<typeof readTranscript>[0]> = {},
): Promise<TranscriptRead> =>
  Effect.runPromise(
    readTranscript({
      resolver: resolverOver(harness),
      harnessSessionId: "ses_1",
      harnessInstanceId: STUB_INSTANCE.instanceId,
      ...over,
    }),
  );

describe("the harness has it", () => {
  test("its messages are shown in order, marked as the thing that can be gone", async () => {
    const asked: string[] = [];
    const answer = await read(
      stubHarness({
        messages: (sessionId) =>
          Effect.sync(() => {
            asked.push(sessionId);
            return entries(3);
          }),
      }),
    );
    expect(asked).toEqual(["ses_1"]);
    expect(answer.source).toBe("harness");
    expect(answer.ephemeral).toBe(true);
    expect(answer.entries.map((entry) => entry.index)).toEqual([0, 1, 2]);
    expect(answer.entries.map((entry) => entry.text)).toEqual([
      "message 0",
      "message 1",
      "message 2",
    ]);
    // The sentence an operator reads has to say that this is the only copy.
    expect(answer.note).toContain("may delete it");
    expect(answer.note).toContain("30 days");
    expect(answer.note).toContain("keeps no copy");
    expect(answer.truncated).toBe(false);
  });

  test("an entry's error is carried, not dropped", async () => {
    const answer = await read(
      stubHarness({
        messages: () =>
          Effect.succeed([
            {
              type: "tool",
              text: "ran it",
              error: "exit status 2",
              parts: [],
              model: undefined,
              at: undefined,
            },
          ]),
      }),
    );
    expect(answer.entries[0]?.error).toBe("exit status 2");
  });

  test("a long session is cut at the limit, in order, and says so", async () => {
    const answer = await read(
      stubHarness({ messages: () => Effect.succeed(entries(20)) }),
      { limit: 5 },
    );
    expect(answer.source).toBe("harness");
    expect(answer.entries.map((entry) => entry.text)).toEqual([
      "message 0",
      "message 1",
      "message 2",
      "message 3",
      "message 4",
    ]);
    expect(answer.truncated).toBe(true);
    expect(answer.note).toContain("Shortened");
  });
});

/**
 * The harness was asked, answered, and does not hold it. This is *gone*: Claude Code
 * deletes local transcripts after `cleanupPeriodDays` (30 by default), so for anything old
 * it is the expected answer and must read as normal. None of these is a conversation with
 * no entries, and none of them is a failure to ask.
 */
describe("the harness does not hold it", () => {
  test.each([
    ["by its not-found tag", { tag: "SessionNotFoundError", status: 500 }],
    ["by a 404", { tag: "RequestError", status: 404 }],
  ])("a forgotten session is gone, %s", async (_name, failure) => {
    const answer = await read(
      stubHarness({
        messages: () => Effect.fail(transport(failure)),
      }),
    );
    expect(answer.source).toBe("absent");
    expect(answer.ephemeral).toBe(false);
    expect(answer.entries).toEqual([]);
    expect(answer.note).toContain("No longer available");
    expect(answer.note).toContain("normal answer");
  });

  /**
   * A session the harness still knows but holds nothing under is gone, not an empty
   * conversation: `harness` with no entries would draw a transcript with nothing in it,
   * which is a claim that the agent said nothing.
   */
  test("a session with no messages is gone, not an empty conversation", async () => {
    const answer = await read(
      stubHarness({ messages: () => Effect.succeed([]) }),
    );
    expect(answer.source).toBe("absent");
    expect(answer.ephemeral).toBe(false);
    expect(answer.entries).toEqual([]);
    expect(answer.note).toContain("holds no messages");
  });

  test.each([null, ""])(
    "an attempt that never had a session (%p) is gone without asking anything",
    async (sessionId) => {
      const asked: string[] = [];
      const answer = await read(
        stubHarness({
          messages: (id) =>
            Effect.sync(() => {
              asked.push(id);
              return entries(1);
            }),
        }),
        { harnessSessionId: sessionId },
      );
      expect(answer.source).toBe("absent");
      expect(answer.note).toContain("no harness session recorded");
      expect(asked).toEqual([]);
    },
  );
});

/**
 * The harness could not be asked. That tells us **nothing** about whether the transcript
 * still exists, so it must not read as gone — and it must not read as an empty
 * conversation either. Each of these used to be indistinguishable from the case above
 * except by a sentence.
 */
describe("the harness could not be reached", () => {
  test("a transport failure that is not a missing session is unreachable, not gone", async () => {
    const answer = await read(
      stubHarness({
        messages: () =>
          Effect.fail(transport({ detail: "connection refused" })),
      }),
    );
    expect(answer.source).toBe("unreachable");
    expect(answer.ephemeral).toBe(false);
    expect(answer.entries).toEqual([]);
    expect(answer.note).toContain("connection refused");
    expect(answer.note).toContain("may still exist");
  });

  test("an unusable instance is unreachable, with the resolver's reason", async () => {
    const answer = await Effect.runPromise(
      readTranscript({
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
    expect(answer.source).toBe("unreachable");
    expect(answer.note).toContain("the harness would not start");
  });

  /**
   * A foreign instance is not asked, which is the same honesty `harnessStatus.ts` keeps.
   * Asking the harness we *do* have would get a confident "no such session" for a session
   * that may be alive somewhere else — and reporting that as gone would be the lie.
   */
  test("a session on an instance this server does not configure is not asked, and not called gone", async () => {
    const asked: string[] = [];
    const answer = await read(
      stubHarness({
        messages: (sessionId) =>
          Effect.sync(() => {
            asked.push(sessionId);
            return [];
          }),
      }),
      { harnessInstanceId: "some-other-instance" },
    );
    expect(answer.source).toBe("unreachable");
    expect(answer.note).toContain("some-other-instance");
    expect(asked).toEqual([]);
  });

  /**
   * The ask is bounded. A harness child may be dying at the moment it is asked, and a read
   * that waited on it would hang the request instead of saying it could not ask.
   */
  test("a harness that never answers is bounded, and unreachable", async () => {
    const started = Date.now();
    const answer = await read(stubHarness({ messages: () => Effect.never }), {
      fetchTimeout: "50 millis",
    });
    expect(answer.source).toBe("unreachable");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
