import { describe, expect, test } from "bun:test";

import type { HarnessNarration } from "./agentHarness";
import { attachmentReader } from "./attachments";
import {
  PI_INTERRUPT_MARKER_TEXT,
  PiNarrator,
  PiTranscriptError,
  lastMeasuredCall,
  parsePiSession,
  piMessageEntries,
  retryCategory,
  retryStatus,
  sessionName,
  type PiSessionFile,
} from "./piTranscript";

const header = (version: number | "absent" = 3) =>
  JSON.stringify({
    type: "session",
    ...(version === "absent" ? {} : { version }),
    id: "s1",
    timestamp: "2026-11-10T10:00:00.000Z",
    cwd: "/work",
  });

let next = 0;
const entry = (
  parentId: string | null,
  body: Record<string, unknown>,
  id = `e${String((next += 1))}`,
) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-11-10T10:00:01.000Z",
  ...body,
});

const usage = (input: number, output: number) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const assistant = (
  content: unknown[],
  extra: Record<string, unknown> = {},
) => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: "zai",
  model: "glm-5.3-flash",
  usage: usage(100, 10),
  stopReason: "stop",
  timestamp: 1,
  ...extra,
});

const file = (lines: readonly unknown[]): string =>
  [header(), ...lines.map((line) => JSON.stringify(line))].join("\n");

const parsed = (text: string): PiSessionFile => {
  const result = parsePiSession(text, "test.jsonl");
  if (result instanceof PiTranscriptError) throw result;
  return result;
};

const replayOf = (text: string) =>
  piMessageEntries(parsed(text), {
    reader: attachmentReader({ uploadsFolder: undefined }),
    steerIds: () => undefined,
  });

describe("parsePiSession", () => {
  test("refuses a session file of another version, naming it", () => {
    for (const version of ["absent", 2, 4] as const) {
      const result = parsePiSession(header(version), "old.jsonl");
      expect(result instanceof PiTranscriptError).toBe(true);
      expect((result as PiTranscriptError).detail).toContain(
        `version ${String(version === "absent" ? 1 : version)} Pi session`,
      );
    }
  });

  test("tolerates a cut last line, and nothing else", () => {
    const good = entry(null, {
      message: { role: "user", content: "hi", timestamp: 1 },
    });
    const ok = parsePiSession(
      `${header()}\n${JSON.stringify(good)}\n{"type":"mess`,
      "x",
    );
    expect(ok instanceof PiTranscriptError).toBe(false);
    const broken = parsePiSession(
      `${header()}\n{"type":"mess\n${JSON.stringify(good)}`,
      "x",
    );
    expect(broken instanceof PiTranscriptError).toBe(true);
  });
});

describe("piMessageEntries", () => {
  test("reads the active branch only, oldest first", () => {
    const root = entry(
      null,
      { message: { role: "user", content: "first", timestamp: 1 } },
      "a",
    );
    const abandoned = entry(
      "a",
      { message: assistant([{ type: "text", text: "old branch" }]) },
      "b",
    );
    const kept = entry(
      "a",
      { message: assistant([{ type: "text", text: "new branch" }]) },
      "c",
    );
    const replay = replayOf(file([root, abandoned, kept]));
    expect(replay.map((each) => each.text)).toEqual(["first", "new branch"]);
  });

  test("leaves out a retried call's failed attempts, and keeps the last error", () => {
    const user = entry(
      null,
      { message: { role: "user", content: "go", timestamp: 1 } },
      "u",
    );
    const failed = entry(
      "u",
      {
        message: assistant([], {
          stopReason: "error",
          errorMessage: "429: first",
          usage: usage(0, 0),
        }),
      },
      "f1",
    );
    const edit = {
      type: "context_edit",
      id: "x1",
      parentId: "f1",
      timestamp: "2026-11-10T10:00:02.000Z",
      targetId: "f1",
      replacement: null,
    };
    const last = entry(
      "x1",
      {
        message: assistant([], {
          stopReason: "error",
          errorMessage: "429: last",
          usage: usage(0, 0),
        }),
      },
      "f2",
    );
    const replay = replayOf(file([user, failed, edit, last]));
    expect(replay.map((each) => each.error)).toEqual([undefined, "429: last"]);
  });

  test("a stopped call is the interrupt marker, after what it had written", () => {
    const user = entry(
      null,
      { message: { role: "user", content: "go", timestamp: 1 } },
      "u",
    );
    const cut = entry(
      "u",
      {
        message: assistant([{ type: "text", text: "half a rep" }], {
          stopReason: "aborted",
          errorMessage: "This operation was aborted",
        }),
      },
      "a",
    );
    const replay = replayOf(file([user, cut]));
    expect(replay.map((each) => [each.type, each.marker, each.error])).toEqual([
      ["user", undefined, undefined],
      ["assistant", undefined, undefined],
      ["user", "interrupted", undefined],
    ]);
    expect(replay[1]?.text).toBe("half a rep");
    expect(replay[2]?.text).toBe(PI_INTERRUPT_MARKER_TEXT);
  });

  test("tool calls and results are parts, and a compaction is its summary", () => {
    const user = entry(
      null,
      {
        message: {
          role: "user",
          content: [{ type: "text", text: "go" }],
          timestamp: 1,
        },
      },
      "u",
    );
    const call = entry(
      "u",
      {
        message: assistant([
          { type: "thinking", thinking: "hmm" },
          {
            type: "toolCall",
            id: "c1",
            name: "bash",
            arguments: { command: "ls" },
          },
        ]),
      },
      "a",
    );
    const result = entry(
      "a",
      {
        message: {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "bash",
          content: [{ type: "text", text: "file.txt" }],
          isError: false,
          timestamp: 2,
        },
      },
      "r",
    );
    const compaction = {
      type: "compaction",
      id: "k",
      parentId: "r",
      timestamp: "2026-11-10T10:00:03.000Z",
      summary: "We listed files.",
      firstKeptEntryId: "r",
      tokensBefore: 1000,
    };
    const replay = replayOf(file([user, call, result, compaction]));
    expect(replay[1]?.parts).toEqual([
      { _tag: "thinking", text: "hmm", model: "zai/glm-5.3-flash" },
      {
        _tag: "toolCall",
        callId: "c1",
        tool: "bash",
        input: '{"command":"ls"}',
        model: "zai/glm-5.3-flash",
      },
    ]);
    expect(replay[2]?.parts).toEqual([
      {
        _tag: "toolResult",
        callId: "c1",
        tool: "bash",
        output: "file.txt",
        failed: false,
      },
    ]);
    expect(replay[3]).toMatchObject({
      type: "user",
      marker: "compacted",
      text: "We listed files.",
    });
    // After a compaction the last call no longer measures the window.
    expect(
      lastMeasuredCall(parsed(file([user, call, result, compaction])))?.after,
    ).toBe(true);
    expect(
      lastMeasuredCall(parsed(file([user, call, result])))?.usage.input,
    ).toBe(100);
  });

  test("names the session by its newest session_info", () => {
    const first = {
      type: "session_info",
      id: "n1",
      parentId: null,
      timestamp: "t",
      name: "one",
    };
    const second = {
      type: "session_info",
      id: "n2",
      parentId: "n1",
      timestamp: "t",
      name: "two",
    };
    expect(sessionName(parsed(file([first, second])).entries)).toBe("two");
  });
});

describe("PiNarrator", () => {
  const narrator = () =>
    new PiNarrator("p", {
      taken: (text) => (text === "steer" ? ["m1"] : undefined),
      window: () => 200_000,
    });
  const run = (
    subject: PiNarrator,
    events: readonly Record<string, unknown>[],
  ): HarnessNarration[] =>
    events.flatMap((event) =>
      subject.narrate(event as { type: string } & Record<string, unknown>, 0),
    );

  test("a retried refusal is a retry line, and only the final failure is the run's error", () => {
    const failedCall = [
      { type: "message_start", message: { role: "assistant" } },
      {
        type: "message_end",
        message: assistant([], {
          stopReason: "error",
          errorMessage: "429: slow down",
          usage: usage(0, 0),
        }),
      },
    ];
    const seen = run(narrator(), [
      { type: "agent_start" },
      ...failedCall,
      { type: "agent_end", willRetry: true },
      {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2000,
        errorMessage: "429: slow down",
      },
      ...failedCall,
      { type: "agent_end", willRetry: false },
      { type: "agent_settled", aborted: false },
    ]);
    expect(seen.map((each) => each.detail._tag)).toEqual([
      "retry",
      "error",
      "opaque",
    ]);
    expect(seen[0]?.detail).toEqual({
      _tag: "retry",
      attempt: 1,
      maxRetries: 3,
      delayMs: 2000,
      status: 429,
      error: "rate_limit",
    });
    expect(seen.at(-1)?.outcome).toBe("failed");
  });

  test("a block cut by a Stop is finished from the stored message, then the marker and the outcome", () => {
    const seen = run(narrator(), [
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant" } },
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "half",
        },
      },
      {
        type: "message_end",
        message: assistant([{ type: "text", text: "half" }], {
          stopReason: "aborted",
          usage: usage(0, 0),
        }),
      },
      { type: "agent_end", willRetry: false },
      { type: "agent_settled", aborted: true },
    ]);
    expect(seen.map((each) => each.detail._tag)).toEqual([
      "delta",
      "reply",
      "marker",
      "opaque",
    ]);
    expect(seen[1]?.detail).toMatchObject({
      _tag: "reply",
      text: "half",
      blockId: "p-1:0",
    });
    expect(seen.at(-1)?.outcome).toBe("interrupted");
  });

  test("a steer Pi took is named; the opening message is not", () => {
    const seen = run(narrator(), [
      {
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text: "opening" }] },
      },
      {
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text: "steer" }] },
      },
    ]);
    expect(seen.map((each) => each.detail)).toEqual([
      { _tag: "taken", messageIds: ["m1"] },
    ]);
  });

  test("retry statuses read as categories", () => {
    expect(retryStatus("429: {…}")).toBe(429);
    expect(retryStatus("terminated")).toBe(null);
    expect(retryCategory(503)).toBe("server_error");
    expect(retryCategory(null)).toBe("unknown");
  });
});
