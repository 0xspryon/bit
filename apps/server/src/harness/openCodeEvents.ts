/**
 * OpenCode's event stream, as this driver reads it (U13 review 5): one request per watched
 * session, filtered by the server, bounded per event, and re-made when it breaks.
 *
 * ## Why this is not `api.event.subscribe()`
 *
 * Three images of ~9 MiB in one operator message ended the live narration of every OpenCode
 * session on the server, and nothing said so: the chat stayed at "Sent. The importer has not
 * answered yet." for that turn and every later one, while a reload showed it all. The cause,
 * measured against `opencode` 2.2.5:
 *
 * - **`session.inbox.enqueued` carries the whole prompt, files inline.** The event's `item`
 *   is the inbox payload (`schema/src/session-event.ts` `InboxEnqueued`, its `item:
 *   SessionInbox.Item`), and a file part's payload is the resized image's bytes in base64
 *   (`core/src/session/prompt.ts`, `normalizeImageAttachment`). Three of them came to one
 *   event of 14,092,527 characters; every other event of that turn was under 800.
 * - **Effect's SSE decoder refuses an event over 10 MiB** (`encoding/Sse.ts`,
 *   `defaultMaxEventSize`, counted in string code units), and fails the stream with
 *   `SseError: Pending SSE event exceeded the maximum size of 10485760`.
 * - **The 2.2.5 client cannot avoid either.** Its `event.subscribe({ types })` is typed, but
 *   the client opens **one** native subscription for all of its callers, with no `types`
 *   query, and filters on its own side (`@opencode/client` 2.2.5, `src/effect/client.ts`:
 *   `raw.event.subscribe()` once, `shared.subscribe({ types })` per caller; measured: the
 *   request went out as `GET /api/event` with no parameters). So the oversized event still
 *   crosses the wire, and one failure ends every subscriber's stream at once. It offers no
 *   way to raise the decoder's bound either.
 * - **The media-uri capability does not reach this stream.** `x-opencode-capabilities:
 *   experimental-media-uri` changes only the message and inbox reads
 *   (`server/src/media-uri.ts`, used by `handlers/message.ts` and `handlers/session.ts`),
 *   and only for media admitted while the location's `experimental.media_blob` is on
 *   (`core/src/session/blob.ts`, `externalizePayload`). `/api/event` has no such switch.
 *
 * So this file makes the request itself, over the driver's own authenticated client:
 *
 * - **`types` names only the events the driver reads** ({@link NARRATED_EVENT_TYPES}), so
 *   the server never sends `session.inbox.enqueued`: nothing here reads it, since the driver
 *   narrates a message's take from `session.inbox.delivered`, which carries ids only.
 * - **The per-event bound is {@link OPENCODE_EVENT_MAX_CHARS}**, for the events that can still
 *   carry a file: a tool's result (`core/src/tool/read-filesystem.ts` reads a file back as
 *   base64; an MCP tool's image is a `data:` uri, `core/src/tool/mcp.ts`).
 * - **It is one stream per watched session**, as before the upgrade: a stream that does fail
 *   fails for one session, and is re-made for it ({@link resubscribing}).
 *
 * ## A stream that breaks is re-made, and says so
 *
 * The stream is volatile by OpenCode's own contract ("a slow consumer overflows and fails the
 * stream, and events during disconnection are missed", the route's description), so a
 * failure is expected rather than exotic. {@link resubscribing} subscribes again with
 * backoff and narrates the connection's state as a `connection` entry: `reconnecting` once
 * when it breaks, `restored` when a new connection is open, `lost` when it has failed
 * {@link RESUBSCRIBE_LOST_AFTER} times running. The chat reads the session's replay again on
 * `restored`, which is how what was said in the gap gets back on screen.
 *
 * **Not the durable session log.** OpenCode 2.2.5 has `GET
 * /api/experimental/session/:id/log?after=<seq>`, which reads "events after an exclusive
 * aggregate sequence". Measured on 2.2.5, a session that ran a full turn read back as one
 * entry, `log.synced`, from `after=0`: no narration, as 2.1.2 did (`sessionEvents`'s own
 * comment). The replay is what holds it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EventManifest } from "@opencode/schema/event-manifest";
import { Cause, Duration, Effect, Queue, Stream } from "effect";
import { Sse } from "effect/encoding";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

/**
 * The event types the driver subscribes to: exactly the ones `openCodeNarration` reads
 * (U13 review 6, A7-Q).
 *
 * It used to be every `session.*` type in the manifest but `session.inbox.enqueued`. Two
 * things were wrong with that: it left out `form.created`, `form.replied` and
 * `form.cancelled`, which are how OpenCode 2.2.5's `question` tool asks the operator
 * something (A7-Q's dock got nothing), and it named some forty types this driver reads none
 * of — and **the server refuses a subscription naming a type it does not define** (the
 * route's query is a literal union of its own definitions), so every extra name was one
 * more way for a server a version apart to refuse the stream, which then stays `lost`.
 *
 * A type left out of here is never sent, so a case in `openCodeNarration` whose type is not
 * listed would never run: `openCodeEvents.test.ts` reads the narration's `case` labels and
 * holds this list to them. Each is checked against `@opencode/schema`'s manifest at the
 * client's version too, and {@link openCodeVersionSkew} warns at boot when the server's
 * version is not the client's. The server still sends `server.connected` first, whatever
 * `types` says.
 */
export const NARRATED_EVENT_TYPES: readonly string[] = [
  "session.step.started",
  "session.step.failed",
  "session.step.ended",
  "session.text.delta",
  "session.text.ended",
  "session.reasoning.delta",
  "session.reasoning.ended",
  "session.tool.input.started",
  "session.tool.called",
  "session.tool.progress",
  "session.tool.success",
  "session.tool.failed",
  "session.inbox.delivered",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.synthetic",
  "form.created",
  "form.replied",
  "form.cancelled",
];

/** Every event type the client's `@opencode/schema` defines: what its own server accepts. */
export const MANIFEST_EVENT_TYPES: ReadonlySet<string> = new Set(
  EventManifest.ServerDefinitions.map((definition) => definition.type),
);

/**
 * The `@opencode/client` version this build talks with, read from its `package.json`, or
 * `undefined` when it cannot be found (the package exports no version and no `package.json`
 * subpath, so it is read beside the module it resolves to).
 */
export const OPENCODE_CLIENT_VERSION: string | undefined = (() => {
  try {
    let dir = dirname(
      fileURLToPath(import.meta.resolve("@opencode/client/effect")),
    );
    for (let depth = 0; depth < 6; depth += 1) {
      try {
        const manifest = JSON.parse(
          readFileSync(join(dir, "package.json"), "utf8"),
        ) as { name?: unknown; version?: unknown };
        if (manifest.name === "@opencode/client") {
          return typeof manifest.version === "string"
            ? manifest.version
            : undefined;
        }
      } catch {
        // No `package.json` at this level; keep walking up.
      }
      dir = dirname(dir);
    }
  } catch {
    // Not resolvable here: no version to compare.
  }
  return undefined;
})();

/**
 * The sentence the server logs at boot when the OpenCode server it talks to is not the
 * client's version (U13 review 6), or `undefined` when they match or either is unknown.
 *
 * Why it is worth a warning: the event stream names its types ({@link NARRATED_EVENT_TYPES})
 * and a server that does not define one refuses the subscription, so every session's
 * narration would read `lost` with nothing else said; and the client's own decoding of every
 * other route is the client's version's.
 */
export const openCodeVersionSkew = (
  serverVersion: string,
  clientVersion: string | undefined = OPENCODE_CLIENT_VERSION,
): string | undefined =>
  clientVersion === undefined || serverVersion === clientVersion
    ? undefined
    : `the OpenCode server is version ${serverVersion} and this build's client is ${clientVersion}; the event stream names the types it reads (${NARRATED_EVENT_TYPES.length} of them), and a server that does not define one refuses it, so narration may never connect. Run the server at ${clientVersion}, or upgrade @opencode/client and @opencode/schema to ${serverVersion}.`;

/**
 * The largest event this driver reads, in string code units (Effect's measure): 16 Mi.
 *
 * Effect's default is 10 Mi. The events still able to carry a file are a tool's result, when
 * the agent reads one back: an upload is at most 10 MiB as an image
 * (`upload/uploads.ts`, `DEFAULT_UPLOAD_MAX_IMAGE_BYTES`), which is 13,981,014 characters of
 * base64 before the event's JSON around it, so 10 Mi was below what bit's own composer can
 * send. 16 Mi takes one such file whole. A bigger event — the agent reading a larger file of
 * the workspace back — still fails the stream, which is then re-made, and the gap is read
 * back from the replay. The cost is the bound itself, held at most once per stream while an
 * event is parsed.
 *
 * V2(chat): bit sizes this against a guess at what a tool may put in one event. Proper V2:
 * OpenCode sends media refs on the event stream (as `experimental-media-uri` does for message
 * and inbox reads) so no event carries file bytes, and this bound goes back to the default.
 */
export const OPENCODE_EVENT_MAX_CHARS = 16 * 1024 * 1024;

/** One connection to `/api/event`, filtered and bounded; it ends or fails when the connection does. */
export const subscribeOpenCodeEvents = (
  http: HttpClient.HttpClient,
  baseUrl: string,
): Stream.Stream<unknown, unknown> =>
  HttpClientResponse.stream(
    HttpClient.filterStatusOk(http).execute(
      HttpClientRequest.get(new URL("/api/event", baseUrl).href).pipe(
        HttpClientRequest.appendUrlParams(
          NARRATED_EVENT_TYPES.map((type) => ["types", type] as const),
        ),
        HttpClientRequest.setHeader("accept", "text/event-stream"),
      ),
    ),
  ).pipe(
    Stream.decodeText,
    Stream.pipeThroughChannel(
      Sse.decode({ maxEventSize: OPENCODE_EVENT_MAX_CHARS }),
    ),
    Stream.mapEffect((event) =>
      Effect.try({
        try: () => JSON.parse(event.data) as unknown,
        catch: (cause) => cause,
      }),
    ),
  );

/** Where a re-made stream stands, as {@link resubscribing} narrates it. */
export type ConnectionState = "reconnecting" | "restored" | "lost";

/** One item of {@link resubscribing}: an event, or a change in the connection's state. */
export type Resubscribed =
  | { readonly _tag: "event"; readonly event: unknown }
  | {
      readonly _tag: "connection";
      readonly state: ConnectionState;
      /** Why the last connection ended, in the transport's words; `""` on `restored`. */
      readonly reason: string;
    };

/**
 * Failed connections in a row before the stream is said to be `lost`: ~30 s of backoff.
 *
 * The waits before the second to the seventh attempt are 0.5, 1, 2, 4, 8 and 16 s
 * ({@link resubscribeDelay}), so the seventh failure comes about 31.5 s after the first,
 * plus however long each attempt took to fail. Six said `lost` at 15.5 s (U13 review 6).
 */
export const RESUBSCRIBE_LOST_AFTER = 7;

/** 0.5 s, doubling, at most 30 s. */
export const resubscribeDelay = (failures: number): Duration.Duration =>
  Duration.millis(Math.min(500 * 2 ** Math.max(0, failures - 1), 30_000));

/**
 * `connect`'s events, for as long as the consumer reads, through any number of connections.
 *
 * - **A connection that ends or fails is made again**, after {@link resubscribeDelay} of the
 *   failures in a row. Ending counts: the stream is meant to stay open, so an end is the
 *   connection going, not the session.
 * - **`reconnecting` once per break**, with the first failure's reason; **`restored`** when a
 *   later connection delivers its first event (OpenCode's `server.connected`, sent first on
 *   every connection), so whatever follows it is live and what came before it is what the
 *   gap lost; **`lost`** once, after {@link RESUBSCRIBE_LOST_AFTER} failed connections
 *   running, and the attempts go on at the longest delay — a server that comes back is
 *   still `restored`.
 * - **It never fails, and it ends only when its consumer stops reading** (interruption).
 * - **Backpressure is kept**: a bounded buffer that suspends, as the connection's own
 *   stream would.
 */
// V2(chat): no stall timer. OpenCode sends a heartbeat on the stream every 15 s, but a
// connection that stays open and goes quiet — a hung server, a proxy holding the socket — is
// neither an end nor a failure here, so it is never `reconnecting` and the chat shows no
// notice while narration has stopped. V2 should treat ~2 missed heartbeats as a break:
// close the connection and make it again, which narrates it as one (U13 review 6).
export const resubscribing = <E>(
  connect: () => Stream.Stream<unknown, E>,
  options: {
    readonly delay?: (failures: number) => Duration.Input;
    readonly lostAfter?: number;
  } = {},
): Stream.Stream<Resubscribed> => {
  const delay = options.delay ?? resubscribeDelay;
  const lostAfter = options.lostAfter ?? RESUBSCRIBE_LOST_AFTER;
  return Stream.callback<Resubscribed>(
    (queue) =>
      Effect.gen(function* () {
        let failures = 0;
        let down = false;
        let lost = false;
        for (;;) {
          let open = false;
          const exit = yield* connect().pipe(
            Stream.runForEach((event) =>
              Effect.gen(function* () {
                if (!open) {
                  open = true;
                  failures = 0;
                  if (down) {
                    down = false;
                    lost = false;
                    yield* Queue.offer(queue, {
                      _tag: "connection",
                      state: "restored",
                      reason: "",
                    });
                  }
                }
                yield* Queue.offer(queue, { _tag: "event", event });
              }),
            ),
            Effect.exit,
          );
          if (exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause)) {
            return;
          }
          failures += 1;
          const reason =
            exit._tag === "Success"
              ? "the event stream ended"
              : describeCause(exit.cause);
          if (!down) {
            down = true;
            yield* Queue.offer(queue, {
              _tag: "connection",
              state: "reconnecting",
              reason,
            });
          }
          if (!lost && failures >= lostAfter) {
            lost = true;
            yield* Queue.offer(queue, {
              _tag: "connection",
              state: "lost",
              reason,
            });
          }
          yield* Effect.sleep(delay(failures));
        }
      }),
    { bufferSize: 256, strategy: "suspend" },
  );
};

/** A failure's first error, in its own words, capped for a log line and a chat note. */
const describeCause = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(error);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
};
