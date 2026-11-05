/**
 * OpenCode's event stream as the driver reads it (U13 review 5): the server-side filter, the
 * per-event bound, and a stream that breaks being made again — with the gap said, so a chat
 * can read the replay — rather than ending every later turn's narration without a word.
 */
import { describe, expect, test } from "bun:test";
import { Duration, Effect, Layer, Redacted, Stream } from "effect";
import { FetchHttpClient } from "effect/http";

import { AgentHarness, type HarnessNarration } from "./agentHarness";
import { openCodeHarness } from "./openCodeClient";
import {
  NARRATED_EVENT_TYPES,
  OPENCODE_EVENT_MAX_CHARS,
  resubscribeDelay,
  resubscribing,
  type Resubscribed,
} from "./openCodeEvents";
import { OpenCodeServer } from "./openCodeServer";

/** What one item of {@link resubscribing} reads as, for comparing whole sequences. */
const said = (item: Resubscribed): string =>
  item._tag === "event"
    ? `event ${String(item.event)}`
    : `${item.state}${item.reason === "" ? "" : ` (${item.reason})`}`;

/** A connection that delivers `events`, then fails with `error` — or ends, with none. */
const connection = (
  events: readonly string[],
  error?: string,
): Stream.Stream<unknown, Error> =>
  Stream.concat(
    Stream.fromIterable(events),
    error === undefined ? Stream.empty : Stream.fail(new Error(error)),
  );

/** `connect` answering each call with the next connection of `script`, then one left open. */
const scripted = (script: ReadonlyArray<Stream.Stream<unknown, Error>>) => {
  let calls = 0;
  return {
    calls: () => calls,
    connect: (): Stream.Stream<unknown, Error> => {
      const next = script[calls];
      calls += 1;
      return next ?? Stream.never;
    },
  };
};

const collect = (stream: Stream.Stream<Resubscribed>, count: number) =>
  Effect.runPromise(
    stream.pipe(
      Stream.take(count),
      Stream.runCollect,
      Effect.timeout("5 seconds"),
    ),
  ).then((items) => [...items].map(said));

describe("resubscribing", () => {
  test("a connection that fails mid-stream is made again, and the gap is said both ways", async () => {
    const source = scripted([
      connection(
        ["connected", "a", "b"],
        "SseError: Pending SSE event exceeded the maximum size of 10485760",
      ),
      connection(["connected", "c"]),
    ]);
    const items = await collect(
      resubscribing(source.connect, { delay: () => "1 millis" }),
      7,
    );
    expect(items).toEqual([
      "event connected",
      "event a",
      "event b",
      "reconnecting (SseError: Pending SSE event exceeded the maximum size of 10485760)",
      // Before anything of the new connection: what follows is live, what came before it
      // is what the replay has to supply.
      "restored",
      "event connected",
      "event c",
    ]);
    expect(source.calls()).toBe(2);
  });

  test("a connection that ends on its own is a break too, not the session's end", async () => {
    const source = scripted([
      connection(["connected", "a"]),
      connection(["connected", "b"]),
    ]);
    const items = await collect(
      resubscribing(source.connect, { delay: () => "1 millis" }),
      6,
    );
    expect(items).toEqual([
      "event connected",
      "event a",
      "reconnecting (the event stream ended)",
      "restored",
      "event connected",
      "event b",
    ]);
  });

  test("reconnecting is said once per break, lost once after enough failures, and a later connection still restores", async () => {
    const refused = (n: number) => connection([], `refused ${String(n)}`);
    const source = scripted([
      connection(["connected"], "gone"),
      refused(1),
      refused(2),
      refused(3),
      connection(["connected", "back"]),
    ]);
    const items = await collect(
      resubscribing(source.connect, { delay: () => "1 millis", lostAfter: 3 }),
      6,
    );
    expect(items).toEqual([
      "event connected",
      "reconnecting (gone)",
      // Three failed connections running: the first break, then two refusals.
      "lost (refused 2)",
      "restored",
      "event connected",
      "event back",
    ]);
    expect(source.calls()).toBe(5);
  });

  test("a consumer that stops reading ends it, with no connection made after", async () => {
    const source = scripted([connection(["connected", "a", "b", "c"])]);
    const items = await collect(
      resubscribing(source.connect, { delay: () => "1 millis" }),
      2,
    );
    expect(items).toEqual(["event connected", "event a"]);
    expect(source.calls()).toBe(1);
  });

  test("backs off from half a second to thirty", () => {
    expect(
      [1, 2, 3, 6, 7, 20].map((n) => Duration.toMillis(resubscribeDelay(n))),
    ).toEqual([500, 1000, 2000, 16_000, 30_000, 30_000]);
  });
});

describe("the subscription the driver makes", () => {
  test("names every session event but the one that carries a prompt's files", () => {
    expect(NARRATED_EVENT_TYPES).not.toContain("session.inbox.enqueued");
    for (const type of [
      "session.inbox.delivered",
      "session.execution.started",
      "session.execution.succeeded",
      "session.text.delta",
      "session.text.ended",
      "session.tool.success",
      "session.step.ended",
      "session.synthetic",
    ]) {
      expect(NARRATED_EVENT_TYPES).toContain(type);
    }
    expect(
      NARRATED_EVENT_TYPES.every((type) => type.startsWith("session.")),
    ).toBe(true);
  });

  /** A text event of `session`, as OpenCode sends it. */
  const textEnded = (session: string, text: string, seq: number): string =>
    `data: ${JSON.stringify({
      id: `evt_${String(seq)}`,
      type: "session.text.ended",
      created: 1_793_347_011_894 + seq,
      durable: { aggregateID: session, seq, version: 1 },
      data: { sessionID: session, assistantMessageID: "msg_1", text },
    })}\n\n`;
  const connected = `data: ${JSON.stringify({ id: "evt_c", type: "server.connected", data: {} })}\n\n`;

  /** A response streaming `frames`, then failing with `error` or staying open. */
  const sse = (frames: readonly string[], error?: Error) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start: (controller) => {
          // In 64 KiB pieces, as a socket delivers them: Effect's decoder checks its bound at
          // the end of each piece, so one piece holding a whole event would never meet it.
          for (const frame of frames) {
            const bytes = new TextEncoder().encode(frame);
            for (let at = 0; at < bytes.length; at += 65_536) {
              controller.enqueue(bytes.subarray(at, at + 65_536));
            }
          }
          // Later, not here: an error raised in `start` discards what is still queued.
          if (error !== undefined)
            setTimeout(() => controller.error(error), 50);
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );

  const harnessOver = (answer: (url: string, call: number) => Response) => {
    const urls: string[] = [];
    const fetchStub = Object.assign(
      (input: URL | RequestInfo) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("/api/model")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ location: { directory: "/tmp" }, data: [] }),
              {
                headers: { "content-type": "application/json" },
              },
            ),
          );
        }
        urls.push(url);
        return Promise.resolve(answer(url, urls.length));
      },
      { preconnect: () => {} },
    ) satisfies typeof globalThis.fetch;
    const layer = openCodeHarness({
      timeouts: { control: "1 second", wait: "1 second" },
    }).pipe(
      Layer.provideMerge(
        Layer.succeed(OpenCodeServer, {
          server: {
            baseUrl: "http://127.0.0.1:9",
            version: "2.2.5-stub",
            authorization: Redacted.make("Basic stub"),
          },
          diagnostics: Effect.succeed({
            stdout: [],
            stderr: [],
            dropped: 0,
            droppedCharacters: 0,
            truncatedLines: 0,
            retainedCharacters: 0,
          }),
        }),
      ),
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchStub)),
    );
    return { layer, urls };
  };

  test("a stream that breaks mid-turn narrates the break, comes back, and goes on narrating", async () => {
    const { layer, urls } = harnessOver((_url, call) =>
      call === 1
        ? sse(
            [
              connected,
              textEnded("ses_1", "before", 1),
              textEnded("ses_2", "someone else's", 2),
            ],
            new Error("socket closed"),
          )
        : sse([connected, textEnded("ses_1", "after", 3)]),
    );
    const entries = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.flatMap(AgentHarness, (harness) =>
            harness
              .sessionEvents("ses_1")
              .pipe(
                Stream.take(4),
                Stream.runCollect,
                Effect.timeout("10 seconds"),
              ),
          ),
          layer,
        ),
      ),
    );
    const read = [...entries].map((entry: HarnessNarration) =>
      entry.detail._tag === "connection"
        ? `${entry.type}: ${entry.detail.reason}`
        : entry.detail._tag === "reply"
          ? `reply: ${entry.detail.text}`
          : entry.detail._tag,
    );
    expect(read).toHaveLength(4);
    expect(read[0]).toBe("reply: before");
    expect(read[1]).toStartWith("bit.connection.reconnecting: ");
    expect(read[2]).toBe("bit.connection.restored: ");
    expect(read[3]).toBe("reply: after");
    // One request per connection, each filtered by the server rather than by the client.
    expect(urls).toHaveLength(2);
    for (const url of urls) {
      const asked = new URL(url);
      expect(asked.pathname).toBe("/api/event");
      expect(asked.searchParams.getAll("types")).toEqual([
        ...NARRATED_EVENT_TYPES,
      ]);
    }
  });

  test("an event over Effect's 10 Mi default and under the driver's bound is read, not fatal", async () => {
    // One image of bit's own largest size read back by a tool, near enough: 12 Mi characters.
    const big = "x".repeat(12 * 1024 * 1024);
    expect(big.length).toBeGreaterThan(10 * 1024 * 1024);
    expect(big.length).toBeLessThan(OPENCODE_EVENT_MAX_CHARS);
    const { layer } = harnessOver(() =>
      sse([
        connected,
        textEnded("ses_1", big, 1),
        textEnded("ses_1", "next", 2),
      ]),
    );
    const entries = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.flatMap(AgentHarness, (harness) =>
            harness
              .sessionEvents("ses_1")
              .pipe(
                Stream.take(2),
                Stream.runCollect,
                Effect.timeout("10 seconds"),
              ),
          ),
          layer,
        ),
      ),
    );
    expect([...entries].map((entry) => entry.detail._tag)).toEqual([
      "reply",
      "reply",
    ]);
  });
});
