/**
 * Regression tests for the harness HTTP seam.
 *
 * These stub `FetchHttpClient.Fetch` — a `Context.Reference`, so it is substitutable
 * without a network or a server — and assert on the two things the previous
 * `Effect.promise(() => fetch(...))` client got wrong:
 *
 * 1. Interrupting the client fiber, or letting a transport bound interrupt it, actually
 *    aborts the request. The stub inspects the `AbortSignal` it was handed, so "the
 *    signal was passed" is checked rather than assumed.
 * 2. A 2xx response in an unexpected shape is a typed `HarnessDecodeError`, not a cast
 *    that lies about the value and dies later.
 *
 * What these do *not* claim: aborting our request says nothing about whether the remote
 * harness stopped working. That distinction is in the error's own detail text and is
 * asserted below.
 */
import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";

import { OpenCodeClient } from "./openCodeClient";
import { OpenCodeServer } from "./openCodeServer";

const FAKE_SERVER = {
  server: {
    baseUrl: "http://127.0.0.1:9",
    version: "2.0.32-stub",
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
};

interface Recorded {
  readonly signals: AbortSignal[];
  readonly urls: string[];
}

/** Builds a client whose transport is the given fetch stub. */
const clientWith = (
  stub: (
    url: string,
    init: RequestInit | undefined,
    recorded: Recorded,
  ) => Promise<Response>,
) => {
  const recorded: Recorded = { signals: [], urls: [] };
  const fetchStub = Object.assign(
    (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const signal =
        input instanceof Request ? input.signal : (init?.signal ?? undefined);
      recorded.urls.push(url);
      if (signal) recorded.signals.push(signal);
      return stub(url, init ?? undefined, recorded);
    },
    // `typeof fetch` includes `preconnect`; nothing under test calls it.
    { preconnect: () => {} },
  ) satisfies typeof globalThis.fetch;
  const layer = OpenCodeClient.layer({
    control: "1 second",
    wait: "1 second",
  }).pipe(
    Layer.provideMerge(Layer.succeed(OpenCodeServer, FAKE_SERVER)),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchStub)),
  );
  return { layer, recorded };
};

/**
 * A session payload shaped like the server's own.
 *
 * The envelope is still `{ data }` on the wire — the generated client decodes that and
 * hands back the inner value — but it decodes the server's whole `Session.Info`, so a
 * stub has to answer with every required field rather than the `{ data: { id } }` the
 * narrow hand-written schemas used to accept. Copied from a real `session.create`
 * response against opencode v2.1.0.
 */
const sessionInfo = (overrides: Record<string, unknown> = {}) => ({
  data: {
    id: "ses_1",
    projectID: "ad76b5c5998068fd111d95ec4f7474807abdf52e",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1_792_532_292_371, updated: 1_792_532_292_371 },
    title: "t",
    location: { directory: "/tmp" },
    ...overrides,
  },
});

const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

describe("cancellation", () => {
  test("the request is handed an AbortSignal", async () => {
    const { layer, recorded } = clientWith(() => json(sessionInfo()));
    await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.flatMap(OpenCodeClient, (client) =>
            client.createSession({
              title: "t",
              model: { providerID: "openai", id: "m" },
              directory: "/tmp",
            }),
          ),
          layer,
        ),
      ),
    );
    expect(recorded.signals).toHaveLength(1);
    expect(recorded.signals[0]).toBeInstanceOf(AbortSignal);
  });

  test("interrupting the fiber aborts the in-flight request", async () => {
    // The original defect, reproduced: with `Effect.promise(() => fetch(...))` the
    // fiber went away and the request carried on. Here the signal must abort.
    let observed: AbortSignal | undefined;
    const { layer } = clientWith(
      (_url, _init, recorded) =>
        new Promise<Response>((_resolve, reject) => {
          observed = recorded.signals.at(-1);
          observed?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );

    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            const client = yield* OpenCodeClient;
            const fiber = yield* Effect.forkChild(
              client.sessionStatus("ses_1"),
            );
            yield* Effect.sleep(50);
            yield* Fiber.interrupt(fiber);
            return yield* Fiber.await(fiber);
          }),
          layer,
        ),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(observed?.aborted).toBe(true);
  });

  test("a hung request fails on its transport bound, and says it proves nothing", async () => {
    const { layer } = clientWith(() => new Promise<Response>(() => {}));
    const started = Date.now();
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.result(
            Effect.flatMap(OpenCodeClient, (client) =>
              client.waitForIdle("ses_1"),
            ),
          ),
          layer,
        ),
      ),
    );
    const elapsed = Date.now() - started;

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("HarnessTransportError");
      // The caller must not read a cancelled request as a stopped worker.
      expect(result.failure.message).toContain(
        "does not mean the harness stopped working",
      );
    }
    expect(elapsed).toBeLessThan(5_000);
  }, 20_000);
});

describe("typed decoding", () => {
  test("a 200 with an unexpected body is a HarnessDecodeError, not a defect", async () => {
    // The parent's probe: a stub answering HTTP 200 `{unexpected:true}` to
    // `createSession` produced an `Effect.Cause.Die` from `body.data.id`, because the
    // body was cast with `JSON.parse(text) as A`.
    const { layer } = clientWith(() => json({ unexpected: true }));
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.provide(
          Effect.flatMap(OpenCodeClient, (client) =>
            client.createSession({
              title: "t",
              model: { providerID: "openai", id: "m" },
              directory: "/tmp",
            }),
          ),
          layer,
        ),
      ),
    );

    expect(exit._tag).toBe("Failure");
    const rendered = JSON.stringify(exit);
    expect(rendered).toContain("HarnessDecodeError");
    // Not a defect: a typed failure a caller can branch on.
    expect(rendered).not.toContain('"Die"');
    expect(rendered).toContain("session.create");
    // The status is *not* asserted here any more, and that is the honest position: the
    // decode is the generated client's, and its `SchemaError` does not name the
    // response it came from, so `status` is `undefined`. Reporting 200 because that is
    // the likely answer would be inventing evidence (see `HarnessDecodeError.status`).
    // The generated client's `SchemaError` is preserved as the cause, so the issue is
    // still diagnosable from the failure alone.
    expect(rendered).toContain("SchemaError");
    expect(rendered).toContain("Missing key");
  });

  test("a malformed outcome value in a status body is rejected", async () => {
    const { layer } = clientWith(() =>
      json(sessionInfo({ outcome: "probably fine" })),
    );
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.result(
            Effect.flatMap(OpenCodeClient, (client) =>
              client.sessionStatus("ses_1"),
            ),
          ),
          layer,
        ),
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("HarnessDecodeError");
    }
  });

  test("a non-2xx answer is a HarnessTransportError carrying the status", async () => {
    const { layer } = clientWith(() => json({ error: "boom" }, 503));
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.result(
            Effect.flatMap(OpenCodeClient, (client) =>
              client.messages("ses_1"),
            ),
          ),
          layer,
        ),
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("HarnessTransportError");
      if (result.failure._tag === "HarnessTransportError") {
        expect(result.failure.status).toBe(503);
      }
    }
  });

  test("a 204 with no body is accepted by the wait route", async () => {
    const { layer } = clientWith(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.result(
            Effect.flatMap(OpenCodeClient, (client) =>
              client.waitForIdle("ses_1"),
            ),
          ),
          layer,
        ),
      ),
    );
    expect(result._tag).toBe("Success");
  });
});

describe("requests", () => {
  test("the bearer credential for MCP registration travels in the body, not the URL", async () => {
    let seenBody = "";
    const { layer, recorded } = clientWith((_url, init) => {
      seenBody = String(init?.body ?? "");
      return json({ ok: true });
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.result(
            Effect.flatMap(OpenCodeClient, (client) =>
              client.registerMcpServer("bit-attempt-1", {
                url: "http://127.0.0.1:1234/mcp",
                headers: { authorization: Redacted.make("Bearer s3cret") },
                directory: "/tmp/ws",
              }),
            ),
          ),
          layer,
        ),
      ),
    );
    expect(seenBody).toContain("Bearer s3cret");
    // The pin travels with it, typed by the client's own schema.
    expect(seenBody).toContain('"protocol":"2026-07-28"');
    // Credentials must never be in a URL: those land in logs and process listings.
    expect(recorded.urls[0]).not.toContain("s3cret");
    expect(recorded.urls[0]).toContain("/api/experimental/mcp/bit-attempt-1");
  });

  test("a session id with URL-significant characters is encoded", async () => {
    const { layer, recorded } = clientWith(() => json(sessionInfo()));
    await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.result(
            Effect.flatMap(OpenCodeClient, (client) =>
              client.sessionStatus("ses/../admin"),
            ),
          ),
          layer,
        ),
      ),
    );
    expect(recorded.urls[0]).toContain("ses%2F..%2Fadmin");
  });
});
