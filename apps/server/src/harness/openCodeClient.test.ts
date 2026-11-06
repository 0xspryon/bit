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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import type { LiveItem } from "@bit/contracts";
import { Effect, Fiber, Layer, Redacted, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";

import {
  AgentHarness,
  lastAssistantText,
  type HarnessNarration,
  type MessageEntry,
  NARRATION_FIELD_MAX,
  NARRATION_TRUNCATED_MARK,
} from "./agentHarness";
import {
  openCodeCompactionAt,
  openCodeContext,
  openCodeHarness,
  openCodeNarration,
  openCodeQuestionOf,
  openCodeSubagents,
  outcomeIsLastTurns,
} from "./openCodeClient";
import { withAttachmentLines } from "./attachments";
import { QUESTION_DISMISSED_MESSAGE } from "./questions";

import { HarnessResolver } from "./resolver";
import { HarnessSessionStatus } from "../recovery/harnessStatus";
import { narrateCoalesced } from "../run/streamingCoalescer";
import { projectNarration, projectReplay } from "../run/liveTranscript";
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
  /** Methods as sent, so "it removed the entry" is not read off a URL alone. */
  readonly methods: string[];
  /** Request bodies as sent, so a test can assert on what reached the wire. */
  readonly bodies: string[];
}

/** Builds a client whose transport is the given fetch stub. */
const clientWith = (
  stub: (
    url: string,
    init: RequestInit | undefined,
    recorded: Recorded,
  ) => Promise<Response>,
) => {
  const recorded: Recorded = {
    signals: [],
    urls: [],
    methods: [],
    bodies: [],
  };
  const fetchStub = Object.assign(
    (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const signal =
        input instanceof Request ? input.signal : (init?.signal ?? undefined);
      // The model catalogue is read once while the layer is built — it is what the picker
      // searches, and `identity.ts` keeps it on `HarnessInstance` beside `version` for
      // that reason. It is deliberately *not* recorded here: every assertion in this file
      // is about the request one named operation makes, and a build-time read would shift
      // every index and every count without any of them being about it. The stub still
      // answers it, with whatever that test answers everything, so the degradation path —
      // an unreadable catalogue leaves the instance offering its default model and does
      // not refuse the harness — is exercised by every test in this file.
      const startup = url.includes("/api/model");
      if (!startup) {
        recorded.urls.push(url);
        recorded.methods.push(
          String(
            (input instanceof Request ? input.method : init?.method) ?? "GET",
          ).toUpperCase(),
        );
        if (signal) recorded.signals.push(signal);
        const body = input instanceof Request ? undefined : init?.body;
        if (typeof body === "string") recorded.bodies.push(body);
        else if (body instanceof Uint8Array)
          recorded.bodies.push(new TextDecoder().decode(body));
      }
      return stub(url, init ?? undefined, recorded);
    },
    // `typeof fetch` includes `preconnect`; nothing under test calls it.
    { preconnect: () => {} },
  ) satisfies typeof globalThis.fetch;
  const layer = openCodeHarness({
    timeouts: { control: "1 second", wait: "1 second" },
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

/**
 * `GET /api/session/active`'s answer: the sessions this OpenCode process is executing.
 *
 * The server's shape is a record keyed by session id whose only value is
 * `{ type: "running" }`, and *absence is the answer* — "sessions absent from the result are
 * inactive". So `activeSessions()` with no ids is a server running nothing, which is what a
 * freshly spawned one is.
 */
const activeSessions = (...ids: readonly string[]) => ({
  data: Object.fromEntries(ids.map((id) => [id, { type: "running" }])),
});

/**
 * A transport for `sessionStatus`, which asks two questions and so needs two answers.
 *
 * Routed on the URL rather than answered uniformly, because the two reads decode different
 * shapes: a `Session.Info` handed to the active-sessions decoder is a decode failure, which
 * would make every test here fail for the wrong reason.
 */
const statusStub =
  (answers: {
    readonly active?: readonly string[];
    readonly session?: Record<string, unknown>;
  }) =>
  (url: string) =>
    url.includes("/api/session/active")
      ? json(activeSessions(...(answers.active ?? [])))
      : json(sessionInfo(answers.session));

describe("session lineage", () => {
  /**
   * A planner round opened inside an existing lineage sends that session as its parent.
   *
   * This is the whole mechanism behind sharing a provider cache partition: OpenCode
   * derives its cache key from `parentID ?? fork.sessionID ?? id`, so the field either
   * reaches the wire or the rounds are routed separately however alike their prompts.
   * Asserted on the request body rather than on our own input, because that is the part
   * that can silently go missing.
   */
  test("a parent session id is sent as parentID", async () => {
    const { layer, recorded } = clientWith(() => json(sessionInfo()));
    await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.flatMap(AgentHarness, (client) =>
            client.createSession({
              title: "bit planner: fresh session",
              model: "openai/m",
              directory: "/tmp",
              parentSessionId: "ses_lineage",
            }),
          ),
          layer,
        ),
      ),
    );

    expect(recorded.bodies).toHaveLength(1);
    expect(JSON.parse(recorded.bodies[0] ?? "{}")).toMatchObject({
      parentID: "ses_lineage",
      title: "bit planner: fresh session",
    });
  });

  test("no parent is sent as an explicit null parentID", async () => {
    // Worth pinning rather than assuming: the generated client encodes every absent
    // optional as `null`, so a parentless session is a `parentID: null` on the wire
    // rather than a missing key. Worker sessions are deliberately parentless — OpenCode
    // resumes only parentless sessions after a crash.
    const { layer, recorded } = clientWith(() => json(sessionInfo()));
    await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.flatMap(AgentHarness, (client) =>
            client.createSession({
              title: "bit worker",
              model: "openai/m",
              directory: "/tmp",
            }),
          ),
          layer,
        ),
      ),
    );

    expect(recorded.bodies).toHaveLength(1);
    expect(JSON.parse(recorded.bodies[0] ?? "{}")).toMatchObject({
      parentID: null,
      title: "bit worker",
    });
  });
});

describe("cancellation", () => {
  test("the request is handed an AbortSignal", async () => {
    const { layer, recorded } = clientWith(() => json(sessionInfo()));
    await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.flatMap(AgentHarness, (client) =>
            client.createSession({
              title: "t",
              model: "openai/m",
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
            const client = yield* AgentHarness;
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
            Effect.flatMap(AgentHarness, (client) =>
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
          Effect.flatMap(AgentHarness, (client) =>
            client.createSession({
              title: "t",
              model: "openai/m",
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
    const { layer } = clientWith(
      statusStub({ session: { outcome: "probably fine" } }),
    );
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.result(
            Effect.flatMap(AgentHarness, (client) =>
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
            Effect.flatMap(AgentHarness, (client) => client.messages("ses_1")),
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
            Effect.flatMap(AgentHarness, (client) =>
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
            Effect.flatMap(AgentHarness, (client) =>
              client.registerMcpServer("ses_1", "bit-attempt-1", {
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

  /** `mcp.add` and `mcp.remove` answer `204 No Content`, which is what the client decodes. */
  const noContent = () => Promise.resolve(new Response(null, { status: 204 }));

  test("unregistering removes the entry from the directory it was added to", async () => {
    // Spike B (DECISIONS.md §24.2, caveat 3) found nothing ever calls `mcp.remove`, so a
    // revoked credential left an entry reported `connected` until the server died. This
    // is the call that takes it away, and the directory comes from the registration
    // rather than from the caller.
    const { layer, recorded } = clientWith(noContent);
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.result(
            Effect.flatMap(AgentHarness, (client) =>
              Effect.gen(function* () {
                yield* client.registerMcpServer("ses_1", "bit-attempt-1", {
                  url: "http://127.0.0.1:1234/mcp",
                  headers: { authorization: Redacted.make("Bearer s3cret") },
                  directory: "/tmp/ws",
                });
                yield* client.unregisterMcpServer("ses_1", "bit-attempt-1");
              }),
            ),
          ),
          layer,
        ),
      ),
    );

    expect(outcome._tag).toBe("Success");
    expect(recorded.urls).toHaveLength(3);
    expect(recorded.urls[1]).toContain("/api/experimental/mcp/bit-attempt-1");
    expect(recorded.methods).toEqual(["PUT", "DELETE", "DELETE"]);
    // The directory it was registered into travels with the removal, taken from the
    // registration rather than re-stated by the caller.
    expect(recorded.urls[1]).toContain(encodeURIComponent("/tmp/ws"));
    // And nothing of ours is left in it, so its Location is let go (A6 U6).
    expect(new URL(recorded.urls[2] ?? "").pathname).toBe(
      "/api/debug/location",
    );
    expect(recorded.urls[2]).toContain(encodeURIComponent("/tmp/ws"));
  });

  test("a directory's Location is let go only once its last registration is removed, and a refusal to let go fails nothing (A6 U6)", async () => {
    /*
     * OpenCode keeps one Location per directory, each with its own copy of every MCP server
     * the operator's config names, until `opencode serve` exits: measured ~500 MB a set,
     * one set left behind by every ended session. Letting it go while another registration
     * is still in it would drop that registration with it.
     */
    const { layer, recorded } = clientWith((url) =>
      new URL(url).pathname === "/api/debug/location"
        ? json({ _tag: "NotFound", message: "no such route" }, 404)
        : noContent(),
    );
    const config = {
      url: "http://127.0.0.1:1234/mcp",
      headers: { authorization: Redacted.make("Bearer s3cret") },
      directory: "/tmp/ws",
    };
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.result(
            Effect.flatMap(AgentHarness, (client) =>
              Effect.gen(function* () {
                yield* client.registerMcpServer(
                  "ses_1",
                  "bit-import-a",
                  config,
                );
                yield* client.registerMcpServer(
                  "ses_2",
                  "bit-import-b",
                  config,
                );
                yield* client.unregisterMcpServer("ses_1", "bit-import-a");
                const afterFirst = recorded.urls.length;
                yield* client.unregisterMcpServer("ses_2", "bit-import-b");
                return afterFirst;
              }),
            ),
          ),
          layer,
        ),
      ),
    );
    expect(outcome).toMatchObject({ _tag: "Success", success: 3 });
    expect(
      recorded.urls.map(
        (url, index) =>
          `${recorded.methods[index] ?? "?"} ${new URL(url).pathname}`,
      ),
    ).toEqual([
      "PUT /api/experimental/mcp/bit-import-a",
      "PUT /api/experimental/mcp/bit-import-b",
      "DELETE /api/experimental/mcp/bit-import-a",
      "DELETE /api/experimental/mcp/bit-import-b",
      "DELETE /api/debug/location",
    ]);
  });

  test("a remove that fails still lets the directory's Location go, and the caller still sees the failure (A6 U6 review 2)", async () => {
    /*
     * The registration is forgotten before the remove is sent, so nothing would ever release
     * the directory again: a refused or timed-out remove left its Location and every MCP
     * server in it (~500 MB) running for the server's life. Evicting it drops the
     * registration the remove could not.
     */
    const { layer, recorded } = clientWith((url, init) =>
      init?.method === "DELETE" &&
      new URL(url).pathname.startsWith("/api/experimental/mcp/")
        ? json({ _tag: "BadRequest", message: "no" }, 400)
        : noContent(),
    );
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.result(
            Effect.flatMap(AgentHarness, (client) =>
              Effect.gen(function* () {
                yield* client.registerMcpServer("ses_1", "bit-import-a", {
                  url: "http://127.0.0.1:1234/mcp",
                  headers: { authorization: Redacted.make("Bearer s3cret") },
                  directory: "/tmp/ws",
                });
                yield* client.unregisterMcpServer("ses_1", "bit-import-a");
              }),
            ),
          ),
          layer,
        ),
      ),
    );
    expect(outcome._tag).toBe("Failure");
    expect(
      recorded.urls.map(
        (url, index) =>
          `${recorded.methods[index] ?? "?"} ${new URL(url).pathname}`,
      ),
    ).toEqual([
      "PUT /api/experimental/mcp/bit-import-a",
      "DELETE /api/experimental/mcp/bit-import-a",
      "DELETE /api/debug/location",
    ]);
    expect(recorded.urls[2]).toContain(encodeURIComponent("/tmp/ws"));
  });

  /*
   * A6 U6 review: a resume runs in its predecessor's directory, so a session closed
   * `refused` or `open_failed` and opened again at once registers where the close is letting
   * the Location go. Interleaved here with a stub that holds one answer back.
   */
  describe("a release and a registration in the same directory", () => {
    const config = {
      url: "http://127.0.0.1:1234/mcp",
      headers: { authorization: Redacted.make("Bearer s3cret") },
      directory: "/tmp/ws",
    };
    /** An answer held until `release` is called. */
    const holdBack = () => {
      let release = (): void => {};
      const answered = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { answered, release: () => release() };
    };
    /** Resolves once `seen` is true, checked on every turn of the event loop. */
    const until = (seen: () => boolean) =>
      Effect.promise(async () => {
        for (let turn = 0; turn < 200 && !seen(); turn += 1) {
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
      });
    const requests = (recorded: { urls: string[]; methods: string[] }) =>
      recorded.urls.map(
        (url, index) =>
          `${recorded.methods[index] ?? "?"} ${new URL(url).pathname}`,
      );

    test("a release while another session's add is in flight there does not evict the Location the add went into", async () => {
      const add = holdBack();
      const { layer, recorded } = clientWith(async (url, init) => {
        if (
          init?.method === "PUT" &&
          new URL(url).pathname.endsWith("/bit-import-b")
        ) {
          await add.answered;
        }
        return noContent();
      });
      const outcome = await Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.flatMap(AgentHarness, (client) =>
              Effect.gen(function* () {
                yield* client.registerMcpServer(
                  "ses_1",
                  "bit-import-a",
                  config,
                );
                // The resume's add is out, and not answered yet.
                const adding = yield* Effect.forkChild(
                  client.registerMcpServer("ses_2", "bit-import-b", config),
                );
                yield* until(() =>
                  requests(recorded).includes(
                    "PUT /api/experimental/mcp/bit-import-b",
                  ),
                );
                // The closed session lets go of its registration meanwhile.
                const releasing = yield* Effect.forkChild(
                  client.unregisterMcpServer("ses_1", "bit-import-a"),
                );
                yield* Effect.promise(
                  () => new Promise((resolve) => setTimeout(resolve, 30)),
                );
                add.release();
                yield* Fiber.join(adding);
                yield* Fiber.join(releasing);
                return requests(recorded);
              }),
            ),
            layer,
          ),
        ),
      );
      // The add is still the directory's, so its Location stays.
      expect(outcome).toEqual([
        "PUT /api/experimental/mcp/bit-import-a",
        "PUT /api/experimental/mcp/bit-import-b",
        "DELETE /api/experimental/mcp/bit-import-a",
      ]);
    });

    test("an add while an eviction is in flight there waits for it, and goes into the fresh Location", async () => {
      const evict = holdBack();
      const { layer, recorded } = clientWith(async (url) => {
        if (new URL(url).pathname === "/api/debug/location") {
          await evict.answered;
        }
        return noContent();
      });
      const outcome = await Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.flatMap(AgentHarness, (client) =>
              Effect.gen(function* () {
                yield* client.registerMcpServer(
                  "ses_1",
                  "bit-import-a",
                  config,
                );
                const releasing = yield* Effect.forkChild(
                  client.unregisterMcpServer("ses_1", "bit-import-a"),
                );
                yield* until(() =>
                  requests(recorded).includes("DELETE /api/debug/location"),
                );
                // The resume registers while the eviction is out.
                const adding = yield* Effect.forkChild(
                  client.registerMcpServer("ses_2", "bit-import-b", config),
                );
                yield* Effect.promise(
                  () => new Promise((resolve) => setTimeout(resolve, 30)),
                );
                const whileEvicting = requests(recorded);
                evict.release();
                yield* Fiber.join(releasing);
                yield* Fiber.join(adding);
                return { whileEvicting, after: requests(recorded) };
              }),
            ),
            layer,
          ),
        ),
      );
      // Not sent while the eviction could still land after it.
      expect(outcome.whileEvicting).toEqual([
        "PUT /api/experimental/mcp/bit-import-a",
        "DELETE /api/experimental/mcp/bit-import-a",
        "DELETE /api/debug/location",
      ]);
      expect(outcome.after).toEqual([
        ...outcome.whileEvicting,
        "PUT /api/experimental/mcp/bit-import-b",
      ]);
    });

    test("an add that fails is no registration a release must keep the Location for", async () => {
      const { layer, recorded } = clientWith((url, init) =>
        init?.method === "PUT" &&
        new URL(url).pathname.endsWith("/bit-import-b")
          ? json({ _tag: "BadRequest", message: "no" }, 400)
          : noContent(),
      );
      const outcome = await Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.flatMap(AgentHarness, (client) =>
              Effect.gen(function* () {
                yield* client.registerMcpServer(
                  "ses_1",
                  "bit-import-a",
                  config,
                );
                yield* Effect.result(
                  client.registerMcpServer("ses_2", "bit-import-b", config),
                );
                yield* client.unregisterMcpServer("ses_1", "bit-import-a");
                return requests(recorded);
              }),
            ),
            layer,
          ),
        ),
      );
      expect(outcome.at(-1)).toBe("DELETE /api/debug/location");
    });
  });

  test("unregistering a name that was never registered makes no request", async () => {
    // There is no directory to guess, and OpenCode answers 404 for a server it does not
    // hold, so asking would turn tidy-up into a failure for no gain.
    const { layer, recorded } = clientWith(noContent);
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.result(
            Effect.flatMap(AgentHarness, (client) =>
              client.unregisterMcpServer("ses_1", "bit-never-registered"),
            ),
          ),
          layer,
        ),
      ),
    );

    expect(outcome._tag).toBe("Success");
    expect(recorded.urls).toEqual([]);
  });

  test("unregistering twice removes it once", async () => {
    const { layer, recorded } = clientWith(noContent);
    await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.result(
            Effect.flatMap(AgentHarness, (client) =>
              Effect.gen(function* () {
                yield* client.registerMcpServer("ses_1", "bit-attempt-1", {
                  url: "http://127.0.0.1:1234/mcp",
                  headers: { authorization: Redacted.make("Bearer s3cret") },
                  directory: "/tmp/ws",
                });
                yield* client.unregisterMcpServer("ses_1", "bit-attempt-1");
                yield* client.unregisterMcpServer("ses_1", "bit-attempt-1");
              }),
            ),
          ),
          layer,
        ),
      ),
    );

    // One removal, and the Location let go after it (A6 U6): nothing for the second.
    expect(recorded.methods).toEqual(["PUT", "DELETE", "DELETE"]);
  });

  test("a session id with URL-significant characters is encoded", async () => {
    const { layer, recorded } = clientWith(statusStub({}));
    await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.result(
            Effect.flatMap(AgentHarness, (client) =>
              client.sessionStatus("ses/../admin"),
            ),
          ),
          layer,
        ),
      ),
    );
    // `sessionStatus` reads the active set first and the session second; the id only ever
    // reaches a path in the second, and that is the one that has to be encoded.
    expect(recorded.urls).toHaveLength(2);
    expect(recorded.urls[0]).toContain("/api/session/active");
    expect(recorded.urls[0]).not.toContain("admin");
    expect(recorded.urls[1]).toContain("ses%2F..%2Fadmin");
  });
});

/* ── What became of a session ────────────────────────────────────────────────── */

/**
 * `sessionStatus`, and the recovery defect it used to carry.
 *
 * ## The two states `idle_outcome` cannot tell apart
 *
 * `session.get`'s `outcome` is `session_v2.idle_outcome`, written by OpenCode's projector
 * (`core/src/session/projector.ts`) and only on a terminal execution event. Verified
 * against that source:
 *
 * - `projectIdle` **returns early** for `Execution.Interrupted` when
 *   `event.data.reason === "shutdown"`, writing neither `idle_outcome` nor `time_idle`.
 *   `coordinator.interrupt`'s reason defaults to `"shutdown"`, so a server tearing its
 *   executions down — which is every clean restart of the one we spawn — records nothing.
 *   An interrupt through the HTTP API passes `"user"` and does record.
 * - `Execution.Started` sets `time_busy` and leaves `idle_outcome` alone, so a session in
 *   its second turn still reports the first turn's outcome.
 *
 * So "no outcome" covered both "a turn is running" and "a turn's process is gone", and
 * this seam used to answer the first for both. `recovery/harnessStatus.ts` then recorded
 * `still_running`: the attempt row stayed `running`, the write fence never moved, and
 * nothing would look again.
 *
 * The fix is `GET /api/session/active` — *"foreground Session drains currently owned by
 * this OpenCode process; sessions absent from the result are inactive"* — which is the
 * server's own answer rather than an inference off timestamps.
 */
describe("what became of an opencode session", () => {
  const statusOf = (
    answers: {
      readonly active?: readonly string[];
      readonly session?: Record<string, unknown>;
    },
    sessionId = "ses_1",
  ) => {
    const { layer, recorded } = clientWith(statusStub(answers));
    return Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.map(
            Effect.flatMap(AgentHarness, (client) =>
              client.sessionStatus(sessionId),
            ),
            (status) => ({ status, recorded }),
          ),
          layer,
        ),
      ),
    );
  };

  /**
   * The regression. This is exactly what a restarted server answers for a session whose
   * turn it never finished: the row is found by primary key out of the one SQLite file
   * under the user's data directory, and nothing is executing it.
   */
  test("a session that exists with no outcome after a restart is idle, not running", async () => {
    const { status } = await statusOf({ active: [] });
    expect(status.activity).toBe("idle");
    expect(status.outcome).toBeUndefined();
  });

  test("a session the server is executing is running", async () => {
    const { status } = await statusOf({ active: ["ses_1"] });
    expect(status.activity).toBe("running");
  });

  /**
   * Another session being busy says nothing about this one, which is the whole point of
   * reading a record keyed by session id rather than a process-wide busy flag.
   */
  test("another session's turn does not make this one running", async () => {
    const { status } = await statusOf({ active: ["ses_other"] });
    expect(status.activity).toBe("idle");
  });

  /** `Execution.Started` never clears the column, so turn two holds turn one's answer. */
  test("a live turn's status does not report the previous turn's outcome", async () => {
    const { status } = await statusOf({
      active: ["ses_1"],
      session: { outcome: "succeeded" },
    });
    expect(status.activity).toBe("running");
    expect(status.outcome).toBeUndefined();
  });

  test("an outcome on an idle session is reported, with its cost and tokens", async () => {
    const { status } = await statusOf({
      active: [],
      session: {
        outcome: "failed",
        cost: 0.25,
        tokens: {
          input: 3,
          output: 4,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
    });
    expect(status.activity).toBe("idle");
    expect(status.outcome).toBe("failed");
    expect(status.cost).toBe(0.25);
    expect(status.tokens).toMatchObject({ input: 3, output: 4 });
  });

  /**
   * The order is load-bearing and is asserted, not assumed.
   *
   * Reading `active` *after* `get` would mean a turn that terminalises between the two
   * reads is seen as "no outcome, nothing running it" — `abandoned`, which fences a live
   * attempt. This way round the same race reads as still running, and recovery asks again.
   */
  test("the active set is read before the session row", async () => {
    const { recorded } = await statusOf({ active: [] });
    expect(recorded.urls).toHaveLength(2);
    expect(recorded.urls[0]).toContain("/api/session/active");
    expect(recorded.urls[1]).toContain("/api/session/ses_1");
  });

  /**
   * A session the server does not have is still a `SessionNotFoundError` on the *second*
   * read, and that has to survive the first one: `harnessStatus.ts` tells `missing` from
   * `unreachable` by that tag, and a 404 swallowed into the active read would have made
   * every forgotten session merely unreachable.
   */
  test("a 404 on the session row is still a SessionNotFoundError", async () => {
    const { layer } = clientWith((url) =>
      url.includes("/api/session/active")
        ? json(activeSessions())
        : json(
            { _tag: "SessionNotFoundError", message: "no such session" },
            404,
          ),
    );
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.result(
            Effect.flatMap(AgentHarness, (client) =>
              client.sessionStatus("ses_1"),
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
        expect(result.failure.status).toBe(404);
      }
    }
  });

  /* ── Which turn the outcome belongs to ─────────────────────────────────────── */

  /**
   * The defect that limited S7's continuation to conversations interrupted on their
   * **first** turn, and the reason it survived S7a.
   *
   * `Execution.Started` writes `time_busy` and never clears `idle_outcome`; `projectIdle`
   * writes `time_idle` and `idle_outcome` together. So `busy > idle` says the most recent
   * execution recorded no terminal of its own and whatever is in the column is an
   * **earlier** turn's. S7a dropped a recorded outcome while `activity` was `running`,
   * which covers the in-flight case and nothing else — after a restart nothing is running,
   * so turn one's `succeeded` was reported about an interrupted turn two, read as "the
   * harness stated how this session's last turn ended", and the turn was left alone.
   *
   * The row below is the one S7's second live demonstration read off a restarted server.
   */
  describe("which turn a recorded outcome belongs to", () => {
    /** Two reads of the session row: the generated client's, then the timestamps'. */
    const timedStub =
      (answers: {
        readonly active?: readonly string[];
        readonly session?: Record<string, unknown>;
        /** Fails the Nth read of the session row, 1-based. Nothing fails by default. */
        readonly failSessionRead?: number;
      }) =>
      () => {
        let reads = 0;
        return (url: string) => {
          if (url.includes("/api/session/active"))
            return json(activeSessions(...(answers.active ?? [])));
          // Only the session row is counted. The model catalogue is read once while the
          // layer is built and would otherwise take the first number.
          if (!url.includes("/api/session/")) return json({ data: [] });
          reads += 1;
          return reads === answers.failSessionRead
            ? json({ error: "boom" }, 503)
            : json(sessionInfo(answers.session));
        };
      };

    const statusOf = (answers: Parameters<typeof timedStub>[0]) => {
      const { layer, recorded } = clientWith(timedStub(answers)());
      return Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.map(
              Effect.flatMap(AgentHarness, (client) =>
                client.sessionStatus("ses_1"),
              ),
              (status) => ({ status, recorded }),
            ),
            layer,
          ),
        ),
      );
    };

    /** `time_idle 1793640432141`, `time_busy 1793640472326`, `idle_outcome succeeded`. */
    const interruptedSecondTurn = {
      outcome: "succeeded",
      time: {
        created: 1_793_640_000_000,
        updated: 1_793_640_472_326,
        idle: 1_793_640_432_141,
        busy: 1_793_640_472_326,
      },
    };

    test("a session interrupted on its second turn reports no outcome at all", async () => {
      const { status } = await statusOf({
        active: [],
        session: interruptedSecondTurn,
      });
      expect(status.activity).toBe("idle");
      // Not `succeeded`: that is turn one's, and turn two recorded nothing.
      expect(status.outcome).toBeUndefined();
    });

    /**
     * The same session, through the adapter the continuation decision is actually taken
     * from. `abandoned` is what makes a continuation decidable; `succeeded` is what left
     * the interrupted turn alone.
     */
    test("recovery reads that session as abandoned rather than succeeded", async () => {
      const { layer } = clientWith(
        timedStub({ active: [], session: interruptedSecondTurn })(),
      );
      const report = await Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.flatMap(HarnessSessionStatus, (service) =>
              service.of("ses_1", null),
            ),
            HarnessSessionStatus.layer.pipe(
              Layer.provide(HarnessResolver.single),
              Layer.provide(layer),
            ),
          ),
        ),
      );
      expect(report.observed).toBe("abandoned");
    });

    /**
     * A completed turn is the normal settle path and must be untouched: `waitForIdle` is
     * `session.wait`, the session has left `active`, and the terminal that wrote the
     * outcome also advanced `time_idle` past `time_busy`.
     */
    test("an outcome recorded by the most recent execution is still reported", async () => {
      const { status } = await statusOf({
        active: [],
        session: {
          outcome: "succeeded",
          time: {
            created: 1_793_640_000_000,
            updated: 1_793_640_432_141,
            busy: 1_793_640_400_000,
            idle: 1_793_640_432_141,
          },
        },
      });
      expect(status.outcome).toBe("succeeded");
    });

    /**
     * The timestamps are asked for only when they can change the answer, which keeps the
     * extra round trip off every status read rather than on it.
     */
    test("nothing extra is read when no outcome was recorded", async () => {
      const { recorded } = await statusOf({ active: [] });
      expect(recorded.urls).toHaveLength(2);
    });

    test("nothing extra is read while a turn is in flight", async () => {
      const { recorded, status } = await statusOf({
        active: ["ses_1"],
        session: interruptedSecondTurn,
      });
      expect(status.activity).toBe("running");
      expect(recorded.urls).toHaveLength(2);
    });

    /**
     * The failure direction, and it is the one thing a caller depends on here.
     *
     * An unreadable timestamp must not be evidence that a recorded outcome is stale: that
     * would let one flaky GET turn a settled attempt into `uncertain`, bump its fence and
     * revoke its credential. So the read is advisory and every failure believes the
     * outcome — back to the behaviour before the fix, which under-continues.
     */
    test("an unreadable timestamp read leaves the recorded outcome believed", async () => {
      const { status } = await statusOf({
        active: [],
        session: { outcome: "failed", time: { created: 1, updated: 2 } },
        failSessionRead: 2,
      });
      expect(status.outcome).toBe("failed");
    });

    /**
     * And the whole status read must not fail because of it, which is a different claim
     * from the one above: this read has no error channel at all.
     */
    test("a session with a stale outcome whose timestamps 404 still answers", async () => {
      const { status } = await statusOf({
        active: [],
        session: { outcome: "failed" },
        failSessionRead: 2,
      });
      expect(status.activity).toBe("idle");
    });
  });

  /**
   * The comparison on its own, including the two absences.
   *
   * `time_idle` is written as `max(event.created, time_idle + 1)` so every terminal
   * advances the column inside one millisecond, which is why equality believes the
   * outcome: a turn that started and ended in the same millisecond reads `idle === busy`.
   */
  describe("the outcome-is-current comparison", () => {
    test("a terminal at or after the last start is the current turn's", () => {
      expect(outcomeIsLastTurns({ busy: 10, idle: 11 })).toBe(true);
      expect(outcomeIsLastTurns({ busy: 10, idle: 10 })).toBe(true);
    });

    test("a start after the last terminal makes the outcome an earlier turn's", () => {
      expect(outcomeIsLastTurns({ busy: 11, idle: 10 })).toBe(false);
      // A first turn interrupted before anything terminalised: `busy` set, `idle` never
      // written. There is no outcome on such a row today, and if one appears it is not
      // this turn's.
      expect(outcomeIsLastTurns({ busy: 11 })).toBe(false);
    });

    test("no start at all believes whatever was recorded", () => {
      // Either a session that never executed — nothing to doubt — or a server that does
      // not send the field, where this must stay at the pre-fix behaviour.
      expect(outcomeIsLastTurns({})).toBe(true);
      expect(outcomeIsLastTurns({ idle: 10 })).toBe(true);
    });
  });

  /** "We could not read the active set" must not read as "nothing is running". */
  test("an unreadable active set fails rather than answering idle", async () => {
    const { layer } = clientWith((url) =>
      url.includes("/api/session/active")
        ? json({ error: "boom" }, 503)
        : json(sessionInfo()),
    );
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.result(
            Effect.flatMap(AgentHarness, (client) =>
              client.sessionStatus("ses_1"),
            ),
          ),
          layer,
        ),
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.operation).toBe("session.active");
    }
  });
});

/* ── Reading an event ────────────────────────────────────────────────────────── */

/**
 * The mapping from `opencode`'s events to what a transcript renders.
 *
 * Checked directly rather than through `sessionEvents`, because nothing here is about
 * transport: the shapes below are copied from `@opencode/protocol@2.1.0`'s generated event
 * union, and the thing most likely to break on an upgrade is the fact that a tool call is
 * **five events keyed by `data.id`, only the first of which carries the tool's name**.
 *
 * | event                        | `data` carries                |
 * | ---------------------------- | ----------------------------- |
 * | `session.tool.input.started` | `id`, `name`                  |
 * | `session.tool.input.delta`   | `id`, `delta`                 |
 * | `session.tool.input.ended`   | `id`, `text`                  |
 * | `session.tool.called`        | `id`, `input`, `executed`     |
 * | `session.tool.success`       | `id`, `content`, `metadata`   |
 * | `session.tool.failed`        | `id`, `error`, `content`      |
 */
describe("reading an opencode event", () => {
  const event = (
    type: string,
    data: Record<string, unknown>,
    created = 10,
  ) => ({
    type,
    created,
    durable: { aggregateID: "ses_1", seq: 4, version: 1 },
    data: { sessionID: "ses_1", assistantMessageID: "msg_1", ...data },
  });

  test("a tool call's name is joined to its arguments across two events", async () => {
    const names = new Map<string, string>();
    const started = openCodeNarration(
      event("session.tool.input.started", { id: "t1", name: "bash" }),
      names,
    );
    // The naming event itself has nothing to render — it is the join, not the moment.
    expect(started.detail).toEqual({ _tag: "opaque" });

    const called = openCodeNarration(
      event("session.tool.called", {
        id: "t1",
        input: { command: "curl -s http://127.0.0.1:41317/login" },
        executed: true,
      }),
      names,
    );
    expect(called.detail).toEqual({
      _tag: "toolCall",
      callId: "t1",
      tool: "bash",
      input: '{"command":"curl -s http://127.0.0.1:41317/login"}',
    });
    // The harness's own event name, unmapped, and its own cursor and clock.
    expect(called.type).toBe("session.tool.called");
    expect(called.sequence).toBe(4);
    expect(called.at).toBe(10);
  });

  test("a successful result carries the tool's name and its output, then releases the join", async () => {
    const names = new Map<string, string>();
    openCodeNarration(
      event("session.tool.input.started", { id: "t1", name: "read" }),
      names,
    );
    const success = openCodeNarration(
      event("session.tool.success", {
        id: "t1",
        content: [
          { type: "text", text: "line one" },
          { type: "file", uri: "file:///tmp/a.txt", mime: "text/plain" },
        ],
        executed: true,
      }),
      names,
    );
    // A file part is named rather than dropped: "the tool answered with a file" and "the
    // tool answered with nothing" are different results.
    expect(success.detail).toEqual({
      _tag: "toolResult",
      callId: "t1",
      tool: "read",
      output: "line one\n[file file:///tmp/a.txt]",
      failed: false,
    });
    // Released when the call resolves, so the map is bounded by the calls in flight rather
    // than by the length of the run.
    expect(names.size).toBe(0);
  });

  /**
   * Two calls in flight at once, answered in the other order.
   *
   * The join table is keyed by `data.id` precisely so this works, and this is the case that
   * would be silently wrong without it: both calls are to the same tool, so a mapping that
   * remembered "the last name seen" would attribute both results to whichever call named
   * itself most recently, and a mapping keyed on the tool name could not tell them apart at
   * all. `opencode` interleaves tool events freely, so this is the ordinary case.
   */
  test("two concurrent calls keep their own names and ids when answered out of order", async () => {
    const names = new Map<string, string>();
    openCodeNarration(
      event("session.tool.input.started", { id: "t1", name: "bash" }),
      names,
    );
    openCodeNarration(
      event("session.tool.input.started", { id: "t2", name: "read" }),
      names,
    );
    const first = openCodeNarration(
      event("session.tool.called", {
        id: "t1",
        input: { command: "curl -s http://a/" },
        executed: true,
      }),
      names,
    );
    const second = openCodeNarration(
      event("session.tool.called", {
        id: "t2",
        input: { filePath: "/tmp/b.txt" },
        executed: true,
      }),
      names,
    );
    // `t2` answers first.
    const secondResult = openCodeNarration(
      event("session.tool.success", {
        id: "t2",
        content: [{ type: "text", text: "b's contents" }],
        executed: true,
      }),
      names,
    );
    const firstResult = openCodeNarration(
      event("session.tool.success", {
        id: "t1",
        content: [{ type: "text", text: "HTTP/1.1 429" }],
        executed: true,
      }),
      names,
    );

    expect(first.detail).toEqual({
      _tag: "toolCall",
      callId: "t1",
      tool: "bash",
      input: '{"command":"curl -s http://a/"}',
    });
    expect(second.detail).toEqual({
      _tag: "toolCall",
      callId: "t2",
      tool: "read",
      input: '{"filePath":"/tmp/b.txt"}',
    });
    // Each result carries its own call's id and its own call's tool, in the order they came
    // back rather than the order they were asked for.
    expect(secondResult.detail).toEqual({
      _tag: "toolResult",
      callId: "t2",
      tool: "read",
      output: "b's contents",
      failed: false,
    });
    expect(firstResult.detail).toEqual({
      _tag: "toolResult",
      callId: "t1",
      tool: "bash",
      output: "HTTP/1.1 429",
      failed: false,
    });
    // Both joins released, so the map is bounded by what is in flight.
    expect(names.size).toBe(0);
  });

  test("a failed result carries the harness's own error text", async () => {
    const names = new Map<string, string>([["t1", "bash"]]);
    const failed = openCodeNarration(
      event("session.tool.failed", {
        id: "t1",
        error: { type: "ToolError", message: "command not found: curl" },
        executed: false,
      }),
      names,
    );
    expect(failed.detail).toEqual({
      _tag: "toolResult",
      callId: "t1",
      tool: "bash",
      output: "command not found: curl",
      // The harness's word about its own call. It says nothing about whether the action
      // was *allowed*, which is the gate's answer and arrives on its own item.
      failed: true,
    });
  });

  test("U4: a message taken off the inbox is narrated as taken, under the application's id", async () => {
    const id = "0123456789abcdef0123456789abcdef";
    const taken = openCodeNarration(
      event("session.inbox.delivered", { inboxID: `msg_${id}` }),
      new Map(),
    );
    expect(taken.detail).toEqual({ _tag: "taken", messageIds: [id] });
    // An inbox id this server did not mint — the opening prompt's, another client's — is not
    // one a chat is waiting on, and narrates nothing.
    for (const inboxID of ["msg_01JABCDEF", "msg_", "other", 7]) {
      expect(
        openCodeNarration(
          event("session.inbox.delivered", { inboxID }),
          new Map(),
        ).detail,
      ).toEqual({ _tag: "opaque" });
    }
  });

  test("U4: a turn the harness ended in its own error says the harness's sentence", async () => {
    const failed = openCodeNarration(
      event("session.execution.failed", {
        error: {
          type: "ProviderError",
          message: "Free usage limit reached. Upgrade to continue.",
        },
      }),
      new Map(),
    );
    expect(failed.detail).toEqual({
      _tag: "error",
      message: "Free usage limit reached. Upgrade to continue.",
    });
    expect(failed.outcome).toBe("failed");
    // No sentence, nothing worded here in its place.
    expect(
      openCodeNarration(
        event("session.execution.failed", {
          error: { type: "X", message: " " },
        }),
        new Map(),
      ).detail,
    ).toEqual({ _tag: "opaque" });
  });

  test("a result for a call whose name was never seen says so rather than borrowing one", async () => {
    // Reachable: a stream joined between `input.started` and the result has an id and no
    // name. Reusing the last name seen would put the wrong tool beside a real result.
    const orphan = openCodeNarration(
      event("session.tool.success", {
        id: "t9",
        content: [{ type: "text", text: "done" }],
        executed: true,
      }),
      new Map([["t1", "bash"]]),
    );
    expect(orphan.detail).toEqual({
      _tag: "toolResult",
      callId: "t9",
      tool: undefined,
      output: "done",
      failed: false,
    });
  });

  test("a text delta streams its block, and the finished reply from `ended` names the same block", async () => {
    const names = new Map<string, string>();
    // A delta is ephemeral in 2.1: no `durable`, so no sequence. Shaped as the union says.
    const delta = (text: string) => ({
      id: "evt_delta",
      created: 11,
      type: "session.text.delta",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_1",
        ordinal: 1,
        delta: text,
      },
    });
    const first = openCodeNarration(delta("Prob"), names);
    const second = openCodeNarration(delta("ing"), names);
    const ended = openCodeNarration(
      event("session.text.ended", { ordinal: 1, text: "Probing the limiter." }),
      names,
    );
    expect([first.detail, second.detail]).toEqual([
      {
        _tag: "delta",
        blockId: "msg_1:text:1",
        call: "msg_1",
        channel: "reply",
        text: "Prob",
      },
      {
        _tag: "delta",
        blockId: "msg_1:text:1",
        call: "msg_1",
        channel: "reply",
        text: "ing",
      },
    ]);
    // A finished reply keeps up to its own cap (A6 U5 review): 10,000 characters whole,
    // where a thought of the same length is cut at the field cap.
    const long = "z".repeat(10_000);
    const longReply = openCodeNarration(
      event("session.text.ended", { ordinal: 2, text: long }),
      names,
    ).detail;
    const longThought = openCodeNarration(
      event("session.reasoning.ended", { ordinal: 2, text: long }),
      names,
    ).detail;
    expect(longReply._tag === "reply" && longReply.text).toBe(long);
    expect(longThought._tag === "thinking" && longThought.text.length).toBe(
      NARRATION_FIELD_MAX + NARRATION_TRUNCATED_MARK.length,
    );
    // A delta states no outcome: the outcome watch reads `session.execution.*`.
    expect(first.outcome).toBeUndefined();
    expect(first.sequence).toBeUndefined();
    // The whole block, from `ended`, under the id its deltas carried.
    expect(ended.detail).toEqual({
      _tag: "reply",
      text: "Probing the limiter.",
      blockId: "msg_1:text:1",
      // The call on its own (A6 U5 review): the wire's `blockCall`.
      call: "msg_1",
    });
  });

  test("a block id needs both the message and the ordinal, and a delta without one is opaque", async () => {
    const names = new Map<string, string>();
    expect(
      openCodeNarration(
        {
          type: "session.text.delta",
          created: 1,
          data: { sessionID: "ses_1", assistantMessageID: "msg_1", delta: "x" },
        },
        names,
      ).detail,
    ).toEqual({ _tag: "opaque" });
    expect(
      openCodeNarration(
        {
          type: "session.reasoning.delta",
          created: 1,
          data: { sessionID: "ses_1", ordinal: 0, delta: "x" },
        },
        names,
      ).detail,
    ).toEqual({ _tag: "opaque" });
    // A finished block that cannot be named is still the finished block, without an id.
    expect(
      openCodeNarration(
        {
          type: "session.text.ended",
          created: 1,
          data: { sessionID: "ses_1", text: "Done." },
        },
        names,
      ).detail,
    ).toEqual({ _tag: "reply", text: "Done." });
  });

  test("an execution outcome is still stated, and nothing else infers one", async () => {
    const names = new Map<string, string>();
    expect(
      openCodeNarration(event("session.execution.succeeded", {}), names)
        .outcome,
    ).toBe("succeeded");
    expect(
      openCodeNarration(event("session.step.finished", {}), names).outcome,
    ).toBeUndefined();
  });

  test("an oversized tool argument is cut once, here, and says so", async () => {
    const names = new Map<string, string>([["t1", "write"]]);
    const detail = openCodeNarration(
      event("session.tool.called", {
        id: "t1",
        input: { content: "x".repeat(NARRATION_FIELD_MAX * 2) },
        executed: true,
      }),
      names,
    ).detail;
    expect(detail._tag).toBe("toolCall");
    if (detail._tag !== "toolCall") throw new Error("not a tool call");
    expect(detail.input.length).toBeLessThan(NARRATION_FIELD_MAX + 64);
    expect(detail.input.endsWith(NARRATION_TRUNCATED_MARK)).toBe(true);
  });

  test("an event with nothing we read is opaque, not an empty reply", async () => {
    // "The harness said something we do not display" must not read as "the agent replied
    // with nothing".
    expect(
      openCodeNarration({ type: "server.connected", created: 1 }, new Map())
        .detail,
    ).toEqual({ _tag: "opaque" });
    expect(openCodeNarration(undefined, new Map()).type).toBe("unknown");
  });
});

/* ── Steering a live session ─────────────────────────────────────────────────── */

describe("steering a live session", () => {
  /**
   * The inbox record a prompt answers with, shaped like the server's own.
   *
   * `SessionPromptOutput` is `SessionInbox.User`, so the generated client decodes the whole
   * thing — an envelope of `{ data: { id } }` would be a `HarnessDecodeError` rather than a
   * prompt. Copied from the schema's own `Enqueued` plus `UserItem` fields; §24.1 notes the
   * server reports back on this record which delivery it resolved, which is how the spike
   * knew an omitted `delivery` becomes `steer`.
   */
  const inbox =
    (delivery: "steer" | "queue", id = "msg_1") =>
    () =>
      json({
        data: {
          id,
          sessionID: "ses_1",
          time: { created: 1_792_532_292_371 },
          type: "user",
          payload: { text: "a directive" },
          delivery,
        },
      });

  const prompting = <A>(
    stub: Parameters<typeof clientWith>[0],
    use: (harness: AgentHarness["Service"]) => Effect.Effect<A, unknown>,
  ) => {
    const { layer, recorded } = clientWith(stub);
    return Effect.runPromise(
      Effect.scoped(
        Effect.map(
          Effect.flatMap(AgentHarness, (harness) =>
            use(harness).pipe(Effect.orDie),
          ),
          (value) => ({ value, recorded }),
        ).pipe(Effect.provide(layer)),
      ),
    );
  };

  test("an opening prompt names no delivery and no id", async () => {
    /*
     * The field is left off rather than set to the server's default, for `parentID`'s
     * reason: an absent optional *is* the server's own default, and §24.1 measured that it
     * resolves an omitted `delivery` to `steer` — which is harmless for a first prompt
     * because there is nothing in flight to cut off. Sending `queue` here would be pinning
     * the opening prompt to today's answer for no gain.
     */
    const { recorded } = await prompting(inbox("steer"), (harness) =>
      harness.prompt("ses_1", "the round's briefing"),
    );

    const body = recorded.bodies[0] ?? "";
    expect(body).toContain("the round's briefing");
    // **`null` on the wire, not an absent key**, which is the generated client's own
    // encoding of an absent optional — the same thing `parentID` does and the same reason
    // that call site spreads rather than passing `undefined`. What matters is that neither
    // field carries a *value*: the server picks its own delivery and mints its own id.
    expect(body).toContain('"delivery":null');
    expect(body).toContain('"id":null');
  });

  test("a message's files: an image and a PDF go as file parts, everything gets its path line (A6 F9; text is path-only since U13 review 3)", async () => {
    const files = [
      { kind: "image", name: "shot.png", mimeType: "image/png" },
      { kind: "file", name: "notes.txt", mimeType: "text/plain" },
      { kind: "file", name: "policy.pdf", mimeType: "application/pdf" },
      { kind: "file", name: "capture.har", mimeType: "application/json" },
    ].map((file) => ({
      ...file,
      kind: file.kind as "image" | "file",
      path: `/fleet/t/import/imp_1/uploads/${file.name}`,
      bytes: 10,
    }));
    const huge = {
      kind: "file" as const,
      name: "big.txt",
      mimeType: "text/plain",
      path: "/fleet/t/import/imp_1/uploads/big.txt",
      // Over what OpenCode reads inline: path-only, like any other file.
      bytes: 21 * 1024 * 1024,
    };
    const { recorded } = await prompting(inbox("steer"), (harness) =>
      harness.prompt("ses_1", "Read these.", undefined, {
        attachments: [...files, huge],
        uploadsFolder: "/fleet/t/import/imp_1/uploads",
      }),
    );
    const body = JSON.parse(recorded.bodies[0] ?? "{}") as {
      text?: string;
      files?: readonly { uri: string; name?: string }[];
    };
    // Not `notes.txt`: OpenCode would write its contents after the words (U13 review 3).
    expect(body.files).toEqual(
      ["shot.png", "policy.pdf"].map((name) => ({
        uri: `file:///fleet/t/import/imp_1/uploads/${name}`,
        name,
      })),
    );
    // T3 Code's lines, one per file, each after a blank line (the operator's decision).
    expect(body.text).toBe(
      withAttachmentLines(
        "Read these.",
        [...files, huge],
        "/fleet/t/import/imp_1/uploads",
      ),
    );
    expect(body.text).toContain(
      `\n\n[Attached file "policy.pdf" is saved at: /fleet/t/import/imp_1/uploads/policy.pdf]\n\n`,
    );
  });

  test("a message with no files, an operator's or bit's, is sent as its words alone, with no file parts", async () => {
    const { recorded } = await prompting(inbox("steer"), (harness) =>
      harness.prompt("ses_1", "just words", undefined, {
        attachments: [],
        uploadsFolder: "/fleet/t/import/imp_1/uploads",
      }),
    );
    const body = JSON.parse(recorded.bodies[0] ?? "{}") as {
      text?: string;
      files?: unknown;
    };
    expect(body.text).toBe("just words");
    expect(body.files ?? null).toBeNull();
    const briefing = await prompting(inbox("steer"), (harness) =>
      harness.prompt("ses_1", "the round's briefing"),
    );
    expect(
      (JSON.parse(briefing.recorded.bodies[0] ?? "{}") as { text?: string })
        .text,
    ).toBe("the round's briefing");
    // Nothing is asked of the server but the prompt itself: no active or inbox read.
    expect(
      [...recorded.urls, ...briefing.recorded.urls].filter(
        (url) => !url.endsWith("/prompt"),
      ),
    ).toEqual([]);
  });

  test("a queued steer sends delivery queue and a msg_-prefixed id", async () => {
    const { value, recorded } = await prompting(inbox("queue"), (harness) =>
      harness.prompt("ses_1", "focus on the lockout path", {
        _tag: "steer",
        urgency: "queued",
        messageId: "0123456789abcdef0123456789abcdef",
      }),
    );

    expect(value.delivered).toBe(true);
    const body = recorded.bodies[0] ?? "";
    // `queue` lets the step in flight finish, which is the default everywhere in this
    // application (ruling 5). §24.1 measured the difference: `steer` cost a round seven of
    // eight file reads.
    expect(body).toContain('"delivery":"queue"');
    // The brand's only check is the prefix, so this is the whole of what the id must be.
    expect(body).toContain('"id":"msg_0123456789abcdef0123456789abcdef"');
  });

  test("a preemptive steer sends delivery steer", async () => {
    const { recorded } = await prompting(inbox("steer"), (harness) =>
      harness.prompt("ses_1", "stop and look at this instead", {
        _tag: "steer",
        urgency: "preemptive",
        messageId: "fedcba9876543210fedcba9876543210",
      }),
    );

    expect(recorded.bodies[0] ?? "").toContain('"delivery":"steer"');
  });

  test("a retried steer makes no second request", async () => {
    /*
     * The dedupe is **ours**, not the server's, and this is where that is asserted.
     *
     * The id is passed — T3 Code derives one for this reason (§24.1) — but what OpenCode
     * does with a repeat of it is not something this build has measured, and
     * `AgentHarness.prompt` promises at-most-once delivery. So the promise is kept here,
     * where it can be checked: the second call makes no request at all.
     */
    const { value, recorded } = await prompting(inbox("queue"), (harness) =>
      Effect.gen(function* () {
        const id = "11112222333344445555666677778888";
        const first = yield* harness.prompt("ses_1", "a directive", {
          _tag: "steer",
          urgency: "queued",
          messageId: id,
        });
        const retry = yield* harness.prompt("ses_1", "a directive", {
          _tag: "steer",
          urgency: "queued",
          messageId: id,
        });
        return { first, retry };
      }),
    );

    expect(value.first.delivered).toBe(true);
    expect(value.retry.delivered).toBe(false);
    expect(recorded.bodies).toHaveLength(1);
  });

  test("the same id into a different session is delivered, because the dedupe is per session", async () => {
    // Two sessions could legitimately be steered under one derived id only if two callers
    // shared an operation id and a caller scope, which `derivedMessageId` makes impossible
    // — but keying the dedupe per session is what matches the promise the seam makes
    // ("at most once per session") rather than a wider one it does not.
    const { recorded } = await prompting(inbox("queue"), (harness) =>
      Effect.gen(function* () {
        const id = "aaaabbbbccccddddeeeeffff00001111";
        yield* harness.prompt("ses_1", "a directive", {
          _tag: "steer",
          urgency: "queued",
          messageId: id,
        });
        yield* harness.prompt("ses_2", "a directive", {
          _tag: "steer",
          urgency: "queued",
          messageId: id,
        });
      }),
    );

    expect(recorded.bodies).toHaveLength(2);
  });
});

/* ── Usage, and the limit the catalogue carries ──────────────────────────────── */

/**
 * The per-call figures, the cumulative ones, and the difference between them.
 *
 * DECISIONS.md §24.4 measured both carriers on a live `opencode` 2.2.2 and they fire in
 * the same millisecond with the same field shape, which is exactly why this has tests: the
 * wrong one is as easy to read as the right one and is wrong by a factor of five. The
 * numbers below are the probe's own, from `apps/server/.runtime/usage-probe/
 * opencode-events.jsonl`, so a regression is measured against a real session rather than
 * against a shape somebody invented here.
 */
describe("reading opencode's token usage", () => {
  /**
   * What the probe's model takes: 200 000 context, and the point OpenCode compacts it.
   *
   * 170 000 is `calculateCeiling`'s own answer for a window with no `input` —
   * `200 000 − max(15 %, 16 000)` — and it is 85 % of the figure the meter divides by. It is
   * in the fixture rather than computed here so that a change to either number has to be
   * written down twice.
   */
  const WINDOW = { contextLimit: 200_000, compactionAt: 170_000 };

  const stepEnded = (
    tokens: Record<string, unknown>,
    callId = "msg_1",
  ): unknown => ({
    type: "session.step.ended",
    created: 1_793_347_011_894,
    durable: { aggregateID: "ses_1", seq: 13, version: 1 },
    data: {
      sessionID: "ses_1",
      assistantMessageID: callId,
      finish: "tool-calls",
      tokens,
      cost: 0,
    },
  });

  test("a step's end is one model call, and the prompt side is the sum of three fields", () => {
    // The probe's second call: 2 692 uncached, 10 880 read from the cache, nothing written.
    // `input` and `cache.read` are disjoint — the first is the remainder, the second the
    // cached prefix — so the prompt side is 13 572 and not 2 692.
    const entry = openCodeNarration(
      stepEnded({
        input: 2692,
        output: 25,
        reasoning: 28,
        cache: { read: 10880, write: 0 },
      }),
      new Map(),
      WINDOW,
    );
    expect(entry.detail).toEqual({
      _tag: "usage",
      callId: "msg_1",
      promptTokens: 13_572,
      // Reasoning is *beside* output on this provider, not inside it, so "everything
      // generated" is their sum. A reader that took `output` alone would under-report a
      // reasoning model by most of what it produced.
      outputTokens: 53,
      contextLimit: 200_000,
      // No `session.step.started` seen for it: nothing says which model made it.
      model: undefined,
      // Beside the window, not instead of it: where the harness will rewrite the session
      // on its own. See `openCodeCompactionAt`.
      compactionAt: 170_000,
    });
    // Durable, so a reconnect can resume past it — which is half of why this event and not
    // the ephemeral total that fires beside it.
    expect(entry.sequence).toBe(13);
  });

  test("the cumulative total that fires beside it is still opaque", () => {
    /*
     * The regression this exists for, and the easiest mistake in the slice.
     *
     * `session.usage.updated` carries the same `tokens` shape in the same millisecond, and
     * it is the **session's lifetime total**: the probe's last one summed to 65 838 against
     * a real context of 13 753, because `cache.read` re-counts the whole cached prefix on
     * every call. A meter fed from it reads 4.8 times high.
     *
     * So the figures here are deliberately the cumulative ones, and the assertion is that
     * nothing reads them. A mapping that "supported both events" would pass a test written
     * against `step.ended` alone and still ship the five-times-high meter.
     */
    const cumulative = {
      input: 14_504,
      output: 113,
      reasoning: 85,
      cache: { read: 51_136, write: 0 },
    };
    const updated = openCodeNarration(
      {
        type: "session.usage.updated",
        created: 1_793_347_011_894,
        data: { sessionID: "ses_1", tokens: cumulative, cost: 0 },
      },
      new Map(),
      WINDOW,
    );
    expect(updated.detail).toEqual({ _tag: "opaque" });
  });

  test("a step that names no message is dropped rather than carried under an invented id", () => {
    const entry = openCodeNarration(
      {
        type: "session.step.ended",
        created: 1,
        data: {
          sessionID: "ses_1",
          tokens: { input: 1, output: 1, reasoning: 0, cache: {} },
        },
      },
      new Map(),
      WINDOW,
    );
    // Without the call id there is nothing to de-duplicate it by and nothing to attribute
    // the numbers to, which is worse than having no figure.
    expect(entry.detail).toEqual({ _tag: "opaque" });
  });

  test("no limit from the catalogue means no limit on the entry, not a default", () => {
    const entry = openCodeNarration(
      stepEnded({
        input: 150,
        output: 3,
        reasoning: 0,
        cache: { read: 13_600 },
      }),
      new Map(),
      undefined,
    );
    expect(entry.detail).toEqual({
      _tag: "usage",
      callId: "msg_1",
      promptTokens: 13_750,
      outputTokens: 3,
      // A consumer draws no percentage from this, which is ruling 3: an honest token count
      // beats a fraction of a window nobody stated. And no threshold either: both numbers
      // come from the same catalogue entry, so a session with no entry has neither.
      contextLimit: undefined,
      model: undefined,
      compactionAt: undefined,
    });
  });

  test("a step's usage names the model its start named (U9 review 2)", () => {
    // A step running when a switch lands finishes on the model it started on.
    const models = new Map([["msg_1", "zai-coding-plan/glm-5.3-flash"]]);
    const entry = openCodeNarration(
      stepEnded({ input: 1, output: 1 }),
      new Map(),
      undefined,
      models,
    );
    expect(
      entry.detail._tag === "usage" ? entry.detail.model : "not usage",
    ).toBe("zai-coding-plan/glm-5.3-flash");
  });

  test("reasoning streams as thinking, and its ordinal is not the reply's", () => {
    // `session.reasoning.ended` carries `data.text`, exactly as `session.text.ended` does
    // for a reply, so thinking is one entry per block, streamed by its deltas. OpenCode
    // counts ordinals per channel, so the first thinking block and the first reply of one
    // message are both ordinal 0, and must still be two blocks.
    const names = new Map<string, string>();
    const reasoning = openCodeNarration(
      {
        id: "evt_r",
        created: 1,
        type: "session.reasoning.delta",
        data: {
          sessionID: "ses_1",
          assistantMessageID: "msg_1",
          ordinal: 0,
          delta: "The",
        },
      },
      names,
    );
    const text = openCodeNarration(
      {
        id: "evt_t",
        created: 2,
        type: "session.text.delta",
        data: {
          sessionID: "ses_1",
          assistantMessageID: "msg_1",
          ordinal: 0,
          delta: "Reading",
        },
      },
      names,
    );
    expect(reasoning.detail).toEqual({
      _tag: "delta",
      blockId: "msg_1:reasoning:0",
      call: "msg_1",
      channel: "thinking",
      text: "The",
    });
    expect(text.detail).toEqual({
      _tag: "delta",
      blockId: "msg_1:text:0",
      call: "msg_1",
      channel: "reply",
      text: "Reading",
    });

    const ended = openCodeNarration(
      {
        id: "evt_e",
        created: 3,
        type: "session.reasoning.ended",
        durable: { aggregateID: "ses_1", seq: 7, version: 1 },
        data: {
          sessionID: "ses_1",
          assistantMessageID: "msg_1",
          ordinal: 0,
          text: "The user wants three files read one at a time.",
        },
      },
      names,
    );
    expect(ended.detail).toEqual({
      _tag: "thinking",
      text: "The user wants three files read one at a time.",
      blockId: "msg_1:reasoning:0",
      call: "msg_1",
    });
  });

  test("through the coalescer: partials of the whole text, the finished block replacing them, and an interrupted block ended by the outcome", async () => {
    // What an importer conversation publishes from a real 2.1 sequence: a reply that
    // finishes, then a second turn's reply cut off by a Stop before its `ended`.
    const names = new Map<string, string>();
    const delta = (ordinal: number, text: string, message = "msg_1") => ({
      id: "evt",
      created: 1,
      type: "session.text.delta",
      data: {
        sessionID: "ses_1",
        assistantMessageID: message,
        ordinal,
        delta: text,
      },
    });
    const raw: unknown[] = [
      delta(0, "Prob"),
      delta(0, "ing."),
      {
        id: "evt_ended",
        created: 2,
        type: "session.text.ended",
        durable: { aggregateID: "ses_1", seq: 5, version: 1 },
        data: {
          sessionID: "ses_1",
          assistantMessageID: "msg_1",
          ordinal: 0,
          text: "Probing.",
        },
      },
      delta(0, "I will", "msg_2"),
      delta(0, " sto", "msg_2"),
      {
        id: "evt_interrupted",
        created: 3,
        type: "session.execution.interrupted",
        durable: { aggregateID: "ses_1", seq: 6, version: 1 },
        data: { sessionID: "ses_1" },
      },
    ];
    const published = await Effect.runPromise(
      Effect.gen(function* () {
        const out: HarnessNarration[] = [];
        yield* narrateCoalesced({
          events: Stream.fromIterable(raw).pipe(
            Stream.map((item) => openCodeNarration(item, names)),
          ),
          publish: (item) =>
            Effect.sync(() => {
              out.push(item);
            }),
        });
        return out;
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(
      published.map((item) => {
        const detail = item.detail;
        switch (detail._tag) {
          case "partial":
            return `partial ${detail.blockId} ${detail.text}`;
          case "reply":
            return `reply ${String(detail.blockId)} ${detail.text}`;
          default:
            return `${item.type} ${String(item.outcome)}`;
        }
      }),
    ).toEqual([
      "partial msg_1:text:0 Prob",
      "partial msg_1:text:0 Probing.",
      "reply msg_1:text:0 Probing.",
      "partial msg_2:text:0 I will",
      // Held when the Stop landed, and sent before the outcome rather than never.
      "partial msg_2:text:0 I will sto",
      "session.execution.interrupted interrupted",
    ]);
  });
});

/**
 * One catalogue entry, as `GET /api/model` sent it.
 *
 * Copied from the probe's own capture rather than hand-written, because the point of the
 * test below is that `limit.context` **survives the generated client's decode** — and a
 * fixture that omitted a required field would be testing the degradation path instead and
 * passing for the wrong reason.
 */
const catalogueEntry = {
  id: "glm-5.3-flash-free",
  modelID: "glm-5.3-flash-free",
  providerID: "opencode",
  family: "glm-flash",
  name: "GLM-5.3-Flash Free",
  compatibility: { reasoningField: "reasoning_content" },
  package: "@opencode/ai/providers/openai-compatible",
  capabilities: {
    tools: true,
    input: ["text", "image"],
    output: ["text"],
    temperature: true,
  },
  variants: [{ id: "low" }, { id: "high" }],
  time: { released: 1_787_702_400_000 },
  cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
  status: "active",
  enabled: true,
  limit: { context: 200_000, output: 32_000 },
};

/**
 * bit's own default model, which is the entry that makes the two numbers tell apart.
 *
 * `openai/gpt-5.6-sol` publishes **both** `context` and `input` and they differ — 400 000
 * against 272 000 — so a fixture carrying only `context` cannot distinguish `limit.context`
 * from `limit.input ?? limit.context`, and the second of those is OpenCode's own compaction
 * formula. Values from DECISIONS.md §24.4's capture of `GET /api/model`.
 */
const defaultCatalogueEntry = {
  ...catalogueEntry,
  id: "gpt-5.6-sol",
  modelID: "gpt-5.6-sol",
  providerID: "openai",
  family: "gpt-sol",
  name: "GPT-5.6 Sol",
  variants: [],
  limit: { context: 400_000, input: 272_000, output: 128_000 },
};

/**
 * The formula, directly, because its three edges are where an `opencode` upgrade shows.
 *
 * `openCodeCompactionAt` reproduces `calculateCeiling` from that project's
 * `packages/core/src/session/compaction.ts`, and the two constants and the field
 * precedence are what a release can move under this build without a word.
 */
describe("where OpenCode will compact a session", () => {
  test("it is the input limit minus the larger of 15% and 16,000", () => {
    // bit's own default model, and the number that makes the meter honest: 58% of 400 000.
    expect(openCodeCompactionAt({ context: 400_000, input: 272_000 })).toBe(
      231_200,
    );
    // The probe's model has no `input`, so the context window is the base: 85% of it.
    expect(openCodeCompactionAt({ context: 200_000 })).toBe(170_000);
  });

  test("a window too small to give up 16,000 gives up the share instead", () => {
    // OpenCode floors the reserve at `RESERVE_MIN` only for a window at least twice it,
    // so a small window is not reduced to nothing.
    expect(openCodeCompactionAt({ context: 20_000 })).toBe(17_000);
    // Exactly at twice the floor, the floor applies and the share is smaller.
    expect(openCodeCompactionAt({ context: 32_000 })).toBe(16_000);
  });

  test("an unknown limit states no threshold rather than a nonsense one", () => {
    // OpenCode reports an unknown limit as 0 and returns an infinite ceiling — it never
    // compacts. "It will not act" is not a number, so there is nothing to mark.
    expect(openCodeCompactionAt({ context: 0 })).toBeUndefined();
    // A zero `input` falls back to the context window, which is OpenCode's own `||` and
    // not a `??`: with `??` this would divide the session's threshold by nothing.
    expect(openCodeCompactionAt({ context: 200_000, input: 0 })).toBe(170_000);
  });
});

describe("the context limit the picker reads", () => {
  const instanceWith = (entries: readonly unknown[]) => {
    const { layer } = clientWith((url) =>
      url.includes("/api/model")
        ? // The envelope the server actually sends: `location` beside `data`. Taken from
          // the probe's captured response, because a stub that answered `{ data }` alone
          // fails the decode and would quietly exercise the degradation path instead.
          json({ location: { directory: "/tmp" }, data: entries })
        : json(sessionInfo()),
    );
    return Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.map(AgentHarness, (client) => client.instance),
          layer,
        ),
      ),
    );
  };

  test("a model's window comes from the catalogue, before any session exists", async () => {
    const instance = await instanceWith([catalogueEntry]);
    const model = instance.models.find(
      (entry) => entry.id === "opencode/glm-5.3-flash-free",
    );
    // `limit.context`, deliberately, and not `limit.input`: the window the provider accepts
    // is what a fullness meter is a fraction of. `limit.input` is what OpenCode's own
    // compaction measures itself against — and it *does* compact bit's sessions, by
    // default, which is why `compactionAt` exists and is asserted below rather than being
    // waved away. The discriminating fixture is two tests down.
    expect(model?.contextLimit).toBe(200_000);
    // Beside the variants rather than instead of them: both are facts about the model and
    // a side table keyed by name would be a second place to keep in step.
    expect(model?.optionDescriptors?.[0]?.id).toBe("variant");
  });

  test("the window is `limit.context` even where `limit.input` is smaller", async () => {
    /*
     * The decision this file's comments claim, finally made checkable.
     *
     * Until this fixture existed, every entry in the repository carried `context` and no
     * `input`, so `expect(contextLimit).toBe(200_000)` passed identically under
     * `model.limit.context` and under `model.limit.input ?? model.limit.context` — and the
     * second is exactly the expression OpenCode's compaction uses, i.e. the regression the
     * comment above the line warns about. A review mutated the source to it and the whole
     * file still passed.
     *
     * With `input: 272_000` in the entry, 400 000 and 272 000 are different answers and the
     * assertion names which one the meter divides by.
     */
    const instance = await instanceWith([defaultCatalogueEntry]);
    const model = instance.models.find(
      (entry) => entry.id === "openai/gpt-5.6-sol",
    );
    expect(model?.contextLimit).toBe(400_000);
    expect(model?.contextLimit).not.toBe(272_000);
  });

  test("the compaction point comes from `limit.input`, which is why the two differ", async () => {
    /*
     * The other half, and the reason the slice has both numbers: the window the meter is a
     * fraction of is what the provider accepts, and the point the **harness** acts at is
     * computed from the smaller field — OpenCode's own `(limit.input || limit.context) −
     * max(15 %, 16 000)`.
     *
     * 272 000 − 40 800 = 231 200, which is **58 %** of the 400 000 the bar is drawn
     * against. An operator who was shown only the window would watch it pass 58 % with the
     * session being rewritten underneath, which is what makes this a drawn figure rather
     * than a comment.
     */
    const instance = await instanceWith([defaultCatalogueEntry]);
    const model = instance.models.find(
      (entry) => entry.id === "openai/gpt-5.6-sol",
    );
    expect(model?.compactionAt).toBe(231_200);
    // Not the window, and not the input limit either: it is below both.
    expect(model?.compactionAt).not.toBe(400_000);
    expect(model?.compactionAt).not.toBe(272_000);
  });

  test("a model with no `limit.input` compacts against its context window", async () => {
    // The probe's own model: 200 000 context, no `input`, so the ceiling is
    // `200 000 − max(30 000, 16 000)` — 85 % of the window rather than 58 %.
    const instance = await instanceWith([catalogueEntry]);
    const model = instance.models.find(
      (entry) => entry.id === "opencode/glm-5.3-flash-free",
    );
    expect(model?.contextLimit).toBe(200_000);
    expect(model?.compactionAt).toBe(170_000);
  });

  test("a catalogue that cannot be read offers no window rather than a guessed one", async () => {
    // The degradation the catalogue read already had: the instance keeps its default model
    // and does not refuse the harness. What it must not do is fill in a limit — a
    // percentage drawn against a made-up denominator is the one output worse than none.
    const instance = await instanceWith([{ nonsense: true }]);
    expect(instance.models).toHaveLength(1);
    expect(instance.models[0]?.contextLimit).toBeUndefined();
    // And no threshold either, for the same reason: both come out of the entry that could
    // not be read, and a mark drawn at a made-up number is worse than no mark.
    expect(instance.models[0]?.compactionAt).toBeUndefined();
  });
});

/**
 * `messages` against a fake that pages the way OpenCode's `message.list` does.
 *
 * The fake reimplements the three behaviours of `packages/server/src/handlers/message.ts`
 * that this seam has to survive, because a stub that simply answered "the whole list" would
 * have passed against the code that shipped the defect:
 *
 * - **No `order` means newest first**, and no `limit` means 50.
 * - **The order rides in the cursor**, and a request that names both a cursor and an order
 *   is refused (`InvalidCursorError`, 400).
 * - **`cursor.next` is present on every non-empty page**, including the last, so the end of
 *   the list is an empty page rather than a missing cursor.
 *
 * Captured shapes are from a live `opencode` 2.2.5 (2026-11-02).
 */
describe("reading a session's messages", () => {
  /** Ids sort like the server's own: a fixed prefix, then a counter in a sortable form. */
  const messageId = (at: number): string =>
    `msg_${at.toString(16).padStart(12, "0")}${"A".repeat(14)}`;

  type Said = { readonly role: "user" | "assistant"; readonly text: string };

  const wire = (said: Said, at: number): Record<string, unknown> =>
    said.role === "user"
      ? {
          id: messageId(at),
          time: { created: 1_793_577_000_000 + at },
          text: said.text,
          type: "user",
        }
      : {
          id: messageId(at),
          time: {
            created: 1_793_577_000_000 + at,
            completed: 1_793_577_000_001 + at,
          },
          type: "assistant",
          agent: "build",
          model: { id: "big-pickle", providerID: "opencode" },
          content: [{ type: "text", text: said.text }],
          finish: "stop",
          rawFinish: "stop",
          cost: 0,
          tokens: {
            input: 1,
            output: 1,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        };

  interface PagingOptions {
    /** The most the server will return per page, whatever `limit` asked for. */
    readonly serverCap?: number;
    /** Hand back a cursor whose page is never empty, as a broken server would. */
    readonly neverEnds?: boolean;
  }

  /** Builds the fake: oldest-first `said`, answered the way `message.list` answers. */
  const pagingServer = (said: readonly Said[], options: PagingOptions = {}) => {
    const stored = said.map((entry, at) => wire(entry, at));
    const encode = (at: number, order: string, direction: string) =>
      Buffer.from(
        JSON.stringify({ id: messageId(at), order, direction }),
      ).toString("base64url");
    const requests: URL[] = [];
    const stub = (url: string): Promise<Response> => {
      if (!url.includes("/message")) return json({ data: [] });
      const query = new URL(url);
      requests.push(query);
      const cursor = query.searchParams.get("cursor");
      const askedOrder = query.searchParams.get("order");
      if (cursor !== null && askedOrder !== null) {
        return json(
          {
            _tag: "InvalidCursorError",
            message: "Cursor cannot be combined with order",
          },
          400,
        );
      }
      const decoded = cursor
        ? (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
            id: string;
            order: string;
          })
        : undefined;
      const order = decoded?.order ?? askedOrder ?? "desc";
      const limit = Math.min(
        Number(query.searchParams.get("limit") ?? 50),
        options.serverCap ?? Number.POSITIVE_INFINITY,
      );
      const indexes = stored.map((_, at) => at);
      const ordered = order === "asc" ? indexes : indexes.reverse();
      const from =
        decoded === undefined
          ? 0
          : ordered.findIndex((at) => messageId(at) === decoded.id) + 1;
      const page = options.neverEnds
        ? [ordered[0] ?? 0]
        : ordered.slice(from, from + limit);
      const last = page.at(-1);
      return json({
        data: page.map((at) => stored[at]),
        cursor: {
          previous:
            page[0] === undefined ? null : encode(page[0], order, "previous"),
          next: last === undefined ? null : encode(last, order, "next"),
        },
      });
    };
    return { stub, requests };
  };

  const read = (
    server: ReturnType<typeof pagingServer>,
  ): Promise<readonly MessageEntry[]> => {
    const { layer } = clientWith((url) => server.stub(url));
    return Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.flatMap(AgentHarness, (client) => client.messages("ses_1")),
          layer,
        ),
      ),
    );
  };

  /*
   * A6 U4 review 2: a steer is stored under the id it was delivered with, `msg_` plus our
   * hex, so a replay names it by the application's id — and an id OpenCode minted itself
   * (the opening prompt's, its sortable `msg_<time><random>`) names nothing.
   */
  test("a stored steer is named by the application's id; an id OpenCode minted is not", async () => {
    const OURS = "aaaaaaaabbbbbbbbccccccccdddddddd";
    const user = (id: string, text: string, at: number) => ({
      id,
      time: { created: 1_793_577_000_000 + at },
      text,
      type: "user",
    });
    const { layer } = clientWith((url) =>
      url.includes("/message")
        ? json({
            data: [
              user(messageId(0), "the opening", 0),
              user(`msg_${OURS}`, "and the portal", 1),
              // Our prefix and a hex-looking id that is not one of ours in shape.
              user("msg_abc", "too short", 2),
            ],
            cursor: { previous: null, next: null },
          })
        : json({ data: [] }),
    );
    const entries = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.flatMap(AgentHarness, (client) => client.messages("ses_1")),
          layer,
        ),
      ),
    );
    expect(
      entries.map((entry) => [entry.text, entry.messageIds ?? null]),
    ).toEqual([
      ["the opening", null],
      ["and the portal", [OURS]],
      ["too short", null],
    ]);
  });

  /** 450 messages: more than the server's 50 default and more than two 200-row pages. */
  const longSession = (): Said[] => [
    { role: "user", text: "begin" },
    { role: "assistant", text: "FIRST reply" },
    ...Array.from({ length: 445 }, (_, at): Said => ({
      role: "user",
      text: `filler ${String(at)}`,
    })),
    { role: "assistant", text: "SECOND to last reply" },
    { role: "user", text: "and now the report" },
    { role: "assistant", text: "FINAL report" },
  ];

  test("a session past one page comes back oldest first and complete", async () => {
    const said = longSession();
    const server = pagingServer(said);
    const entries = await read(server);
    // Every message, in the order it was said. Against the bare call this is the newest 50
    // reversed; against a first page only it is 200.
    expect(entries.map((entry) => entry.text)).toEqual(
      said.map((entry) => entry.text),
    );
    expect(entries.map((entry) => entry.type)).toEqual(
      said.map((entry) => entry.role),
    );
  });

  test("the first page names the order and the later pages carry only the cursor", async () => {
    const server = pagingServer(longSession());
    await read(server);
    const [first, ...rest] = server.requests;
    expect(first?.searchParams.get("order")).toBe("asc");
    expect(first?.searchParams.get("cursor")).toBeNull();
    // 450 rows at 200 a page is three full-or-part pages, and one empty page to say so.
    expect(rest.length).toBe(3);
    for (const page of rest) {
      expect(page.searchParams.get("cursor")).not.toBeNull();
      // The server refuses both together, so this is also what keeps the walk alive.
      expect(page.searchParams.get("order")).toBeNull();
    }
    // The server's own maximum, not its default of 50.
    for (const page of server.requests) {
      expect(page.searchParams.get("limit")).toBe("200");
    }
  });

  test("a page shorter than the limit is not taken for the last one", async () => {
    // A server may cap `limit` below what was asked. Reading a short page as the end would
    // stop at 120 of 450 and say nothing.
    const said = longSession();
    const entries = await read(pagingServer(said, { serverCap: 120 }));
    expect(entries).toHaveLength(said.length);
    expect(entries.at(-1)?.text).toBe("FINAL report");
  });

  test("the last thing the assistant said is found, not the oldest it said inside the window", async () => {
    const entries = await read(pagingServer(longSession()));
    // Newest-first, the newest 50 hold two replies and a scan from the end lands on the
    // earlier of them; truncated to the oldest 50 it would land on FIRST.
    expect(lastAssistantText(entries)).toBe("FINAL report");
  });

  test("a cursor that never runs out fails rather than returning a truncated list", async () => {
    const { layer } = clientWith((url) =>
      pagingServer(longSession(), { neverEnds: true }).stub(url),
    );
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.result(
            Effect.flatMap(AgentHarness, (client) => client.messages("ses_1")),
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
});

describe("what OpenCode calls a session", () => {
  const titleOf = (respond: (url: string) => Promise<Response>) => {
    const { layer, recorded } = clientWith(respond);
    return Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.map(
            Effect.result(
              Effect.flatMap(AgentHarness, (client) =>
                client.sessionTitle("ses_1"),
              ),
            ),
            (answer) => ({ answer, recorded }),
          ),
          layer,
        ),
      ),
    );
  };

  test("the session row's title is the title, read by one session.get", async () => {
    const { answer, recorded } = await titleOf(() =>
      json(sessionInfo({ title: "Acme scope: staging and API hosts" })),
    );
    expect(answer).toMatchObject({
      _tag: "Success",
      success: { _tag: "titled", title: "Acme scope: staging and API hosts" },
    });
    // One id-addressed read and nothing else: not `session.list`, which pages over every
    // session the server holds.
    expect(recorded.urls).toHaveLength(1);
    expect(recorded.urls[0]).toContain("/api/session/ses_1");
  });

  /**
   * Reported as the session's title, deliberately: it *is* the title. Recognising it as this
   * server's own name is the importer's business (`import/importerTitle.ts`), not the
   * driver's, and the driver must not guess which callers named their sessions how.
   */
  test("the name a session was created under comes back as its title", async () => {
    const { answer } = await titleOf(() =>
      json(sessionInfo({ title: "bit scope importer: Acme" })),
    );
    expect(answer).toMatchObject({
      success: { _tag: "titled", title: "bit scope importer: Acme" },
    });
  });

  test("no title, or OpenCode's own dated placeholder, is untitled", async () => {
    for (const title of [
      undefined,
      "  ",
      "New session - 2026-11-03T18:02:11.123Z",
      "Child session - 2026-11-03T18:02:11.123Z",
    ]) {
      const { answer } = await titleOf(() =>
        json(
          sessionInfo(title === undefined ? { title: undefined } : { title }),
        ),
      );
      expect(answer).toMatchObject({ success: { _tag: "untitled" } });
    }
  });

  test("a 404 is a forgotten session, any other failure is a failure", async () => {
    const gone = await titleOf(() =>
      json({ _tag: "SessionNotFoundError", message: "no such session" }, 404),
    );
    expect(gone.answer).toMatchObject({
      _tag: "Success",
      success: { _tag: "forgotten" },
    });
    const down = await titleOf(() => json({ message: "boom" }, 500));
    expect(down.answer._tag).toBe("Failure");
  });
});

/* ── Switching a session's model ─────────────────────────────────────────────── */

describe("ending an opencode session (A6 F5, from its review)", () => {
  /**
   * An inbox item shaped like the server's own `Session.Inbox.User`: the generated client
   * decodes the whole list, so a stub has to answer with every required field.
   */
  const waiting = (id: string) => ({
    id,
    sessionID: "ses_1",
    time: { created: 1_792_532_292_371 },
    type: "user",
    payload: { text: "and then the API hosts" },
    delivery: "queue",
  });

  const ending = (stub: Parameters<typeof clientWith>[0]) => {
    const { layer, recorded } = clientWith(stub);
    return Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.result(
            Effect.flatMap(AgentHarness, (harness) =>
              // A ref this process never handed out: a session opened by an earlier
              // process, which is ended as asked.
              harness.endSession({ id: "ses_1" }),
            ),
          ),
          layer,
        ),
      ),
    ).then((answer) => ({ answer, recorded }));
  };

  /** `METHOD path` for every request, so the order is asserted rather than the set. */
  const calls = (recorded: Recorded): string[] =>
    recorded.urls.map(
      (url, index) =>
        `${recorded.methods[index] ?? "?"} ${new URL(url).pathname}`,
    );

  test("every waiting message is cancelled, then the execution in flight is interrupted", async () => {
    /*
     * OpenCode keeps a session whether bit holds it or not, and an interrupt alone leaves a
     * queued message held in the inbox, to run when the session is next woken — by a resume
     * of an import the operator ended, say. Cancelled first, so a turn that ends on its own
     * between the two calls has nothing to go on to.
     */
    const { answer, recorded } = await ending((url, init) => {
      if (url.endsWith("/inbox") && (init?.method ?? "GET") === "GET") {
        return json({ data: [waiting("msg_a"), waiting("msg_b")] });
      }
      if (url.includes("/inbox/") && init?.method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url.endsWith("/interrupt")) return json({ interrupted: true });
      return json({}, 500);
    });
    expect(answer._tag).toBe("Success");
    expect(calls(recorded)).toEqual([
      "GET /api/session/ses_1/inbox",
      "DELETE /api/session/ses_1/inbox/msg_a",
      "DELETE /api/session/ses_1/inbox/msg_b",
      "POST /api/session/ses_1/interrupt",
    ]);
  });

  test("a session the server does not have is already ended, and nothing more is asked", async () => {
    const { answer, recorded } = await ending(() =>
      json({ _tag: "SessionNotFoundError", message: "no such session" }, 404),
    );
    expect(answer._tag).toBe("Success");
    expect(recorded.urls).toHaveLength(1);
  });

  test("a server that cannot be reached is a failure, not a session said to be ended", async () => {
    const { answer } = await ending(() => json({}, 500));
    expect(answer._tag).toBe("Failure");
  });
  test("an opening superseded by a resume of the same session ends nothing; the resume's own ref does", async () => {
    /*
     * OpenCode runs one execution per session, so once a resume has opened the session again
     * the execution is the resume's, and the earlier opening's close — which can land after
     * the resume has begun (A6 F5 second review) — must not empty or interrupt it.
     */
    const { layer, recorded } = clientWith((url, init) => {
      if (url.endsWith("/inbox") && (init?.method ?? "GET") === "GET") {
        return json({ data: [waiting("msg_a")] });
      }
      if (url.includes("/inbox/") && init?.method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url.endsWith("/interrupt")) return json({ interrupted: true });
      return json({}, 500);
    });
    const counts = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.flatMap(AgentHarness, (harness) =>
            Effect.gen(function* () {
              const opening = {
                title: "import",
                model: "zai/glm",
                directory: "/tmp/import",
                resume: "ses_1",
                multiTurn: true,
              };
              const first = yield* harness.createSession(opening);
              const second = yield* harness.createSession(opening);
              yield* harness.endSession(first);
              const afterFirst = recorded.urls.length;
              yield* harness.endSession(second);
              return { afterFirst, afterSecond: recorded.urls.length };
            }),
          ),
          layer,
        ),
      ),
    );
    expect(counts).toEqual({ afterFirst: 0, afterSecond: 3 });
  });

  test("whether a message is held is read from the session's inbox", async () => {
    // What a Stop asks after an interrupt (`AgentHarness.holding`): the inbox lists what was
    // admitted and not yet run, so a queued message the interrupt left behind is in it, and
    // one that had already become the stopped turn is not.
    const heldWith = (items: readonly unknown[]) => {
      const { layer } = clientWith((url) =>
        url.endsWith("/inbox") ? json({ data: items }) : json({}, 500),
      );
      return Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.flatMap(AgentHarness, (harness) => harness.holding("ses_1")),
            layer,
          ),
        ),
      );
    };
    expect(await heldWith([waiting("msg_a")])).toBe(true);
    expect(await heldWith([])).toBe(false);
  });
});

describe("switching an opencode session's model", () => {
  /**
   * A transport that answers the catalogue with two models whose windows differ, a 204 to
   * every switch, a session to every create, and whatever `rest` says to anything else.
   *
   * Two windows, because the one consequence of a switch this client owns beyond the
   * request is which window the meter is drawn against afterwards.
   */
  const switchStub =
    (rest: (url: string) => Promise<Response> = () => json(sessionInfo())) =>
    (url: string, init: RequestInit | undefined) => {
      if (url.includes("/api/model")) {
        return json({
          location: { directory: "/tmp" },
          data: [catalogueEntry, defaultCatalogueEntry],
        });
      }
      if (url.endsWith("/model") && init?.method === "POST") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return rest(url);
    };

  const switching = <A, E>(
    stub: Parameters<typeof clientWith>[0],
    use: (harness: AgentHarness["Service"]) => Effect.Effect<A, E>,
  ) => {
    const { layer, recorded } = clientWith(stub);
    return Effect.runPromise(
      Effect.scoped(
        Effect.provide(Effect.result(Effect.flatMap(AgentHarness, use)), layer),
      ),
    ).then((answer) => ({ answer, recorded }));
  };

  /** The `model` reference of each request body sent to the switch route, in order. */
  const switchBodies = (recorded: {
    readonly urls: readonly string[];
    readonly bodies: readonly string[];
    readonly methods: readonly string[];
  }) =>
    recorded.urls.flatMap((url, at) =>
      url.endsWith("/model") && recorded.methods[at] === "POST"
        ? [
            (
              JSON.parse(recorded.bodies[at] ?? "{}") as {
                model?: Record<string, unknown>;
              }
            ).model,
          ]
        : [],
    );

  test("the variant rides on the model reference sent to the session's model route", async () => {
    const { answer, recorded } = await switching(switchStub(), (harness) =>
      harness.switchModel("ses_1", "opencode/glm-5.3-flash-free", [
        { id: "variant", value: "high" },
      ]),
    );
    expect(answer._tag).toBe("Success");
    expect(recorded.urls).toEqual([
      "http://127.0.0.1:9/api/session/ses_1/model",
    ]);
    expect(recorded.methods).toEqual(["POST"]);
    expect(switchBodies(recorded)).toEqual([
      { providerID: "opencode", id: "glm-5.3-flash-free", variant: "high" },
    ]);
  });

  test("the default choice, and no choice at all, send a reference with no variant", async () => {
    /*
     * Not `variant: "default"`, which OpenCode would accept: a switch replaces the whole
     * reference, so naming no variant is what moves the session off the old model's
     * variant. And it is the honest spelling of "the operator did not pin one", as at
     * `createSession`.
     */
    const { recorded } = await switching(switchStub(), (harness) =>
      Effect.gen(function* () {
        yield* harness.switchModel("ses_1", "openai/gpt-5.6-sol", [
          { id: "variant", value: "default" },
        ]);
        yield* harness.switchModel("ses_1", "openai/gpt-5.6-sol");
      }),
    );
    const bodies = switchBodies(recorded);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body).toMatchObject({ providerID: "openai", id: "gpt-5.6-sol" });
      expect(body?.["variant"] ?? undefined).toBeUndefined();
    }
  });

  test("the same switch twice is sent twice and succeeds twice", async () => {
    // Nothing is remembered to skip a repeat: this process is not the only writer of the
    // session's model, so a skip on a stale memory would be a retry that did not apply.
    // The server's own answer to a repeat is a no-op (spike/modelSwitchProbe.ts).
    const { answer, recorded } = await switching(switchStub(), (harness) =>
      Effect.gen(function* () {
        yield* harness.switchModel("ses_1", "opencode/glm-5.3-flash-free", [
          { id: "variant", value: "low" },
        ]);
        yield* harness.switchModel("ses_1", "opencode/glm-5.3-flash-free", [
          { id: "variant", value: "low" },
        ]);
      }),
    );
    expect(answer._tag).toBe("Success");
    const bodies = switchBodies(recorded);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
  });

  test("a session OpenCode does not have fails as not found, with its 404", async () => {
    // The generated client reports this route's 404 as a bare status rather than with the
    // `SessionNotFoundError` tag, so the status is the evidence — and it is what every
    // not-found reader on this seam already accepts (`tag === SESSION_NOT_FOUND_TAG ||
    // status === 404`, in `recovery/harnessStatus.ts` and `run/transcript.ts`).
    const { answer } = await switching(
      () =>
        json({ _tag: "SessionNotFoundError", message: "no such session" }, 404),
      (harness) => harness.switchModel("ses_gone", "openai/gpt-5.6-sol"),
    );
    expect(answer._tag).toBe("Failure");
    if (answer._tag === "Failure") {
      expect(answer.failure._tag).toBe("HarnessTransportError");
      if (answer.failure._tag === "HarnessTransportError") {
        expect(answer.failure.operation).toBe("session.switchModel");
        expect(answer.failure.status).toBe(404);
      }
    }
  });

  test("a switch that hangs fails on the control bound and says it proves nothing", async () => {
    const { answer } = await switching(
      (url) =>
        url.includes("/api/model")
          ? json({ location: { directory: "/tmp" }, data: [] })
          : new Promise<Response>(() => {}),
      (harness) => harness.switchModel("ses_1", "openai/gpt-5.6-sol"),
    );
    expect(answer._tag).toBe("Failure");
    if (answer._tag === "Failure") {
      expect(answer.failure._tag).toBe("HarnessTransportError");
      if (answer.failure._tag === "HarnessTransportError") {
        expect(answer.failure.operation).toBe("session.switchModel");
        expect(answer.failure.tag).toBe("TimeoutError");
      }
    }
  }, 20_000);

  test("after a switch, a stream already open draws the next call against the new window", async () => {
    /*
     * The one piece of state this client keeps about a session's model, and the reason
     * `sessionEvents` reads it per event rather than once per stream: a stream opened
     * before a switch must not go on drawing every later call against the old window.
     *
     * The session is opened on the 200 000 model and its stream subscribed; one step ends
     * and is read; the session is switched to the 400 000 model; a second step ends. The
     * first carries 200 000 and the second 400 000 — on the same stream.
     */
    const stepEnded = (callId: string, seq: number): string =>
      `data: ${JSON.stringify({
        id: `evt_${callId}`,
        type: "session.step.ended",
        created: 1_793_347_011_894,
        durable: { aggregateID: "ses_1", seq, version: 1 },
        data: {
          sessionID: "ses_1",
          assistantMessageID: callId,
          finish: "tool-calls",
          tokens: {
            input: 10,
            output: 1,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          cost: 0,
        },
      })}\n\n`;
    let push: ((frame: string) => void) | undefined;
    const events = new ReadableStream<Uint8Array>({
      start: (controller) => {
        push = (frame) => {
          controller.enqueue(new TextEncoder().encode(frame));
        };
      },
    });
    const seen: unknown[] = [];
    const until = (done: () => boolean) =>
      Effect.gen(function* () {
        for (let tries = 0; tries < 400 && !done(); tries += 1) {
          yield* Effect.sleep("5 millis");
        }
      });
    const { answer } = await switching(
      switchStub((url) =>
        url.includes("/api/event")
          ? Promise.resolve(
              new Response(events, {
                headers: { "content-type": "text/event-stream" },
              }),
            )
          : json(sessionInfo()),
      ),
      (harness) =>
        Effect.gen(function* () {
          yield* harness.createSession({
            title: "t",
            model: "opencode/glm-5.3-flash-free",
            directory: "/tmp",
            sessionId: "ses_1",
          });
          const reading = yield* harness.sessionEvents("ses_1").pipe(
            Stream.take(2),
            Stream.runForEach((entry) =>
              Effect.sync(() => {
                seen.push(entry.detail);
              }),
            ),
            Effect.forkChild,
          );
          yield* Effect.sleep("20 millis");
          push?.(stepEnded("msg_before", 1));
          yield* until(() => seen.length >= 1);
          yield* harness.switchModel("ses_1", "openai/gpt-5.6-sol");
          push?.(stepEnded("msg_after", 2));
          yield* Fiber.join(reading);
        }),
    );
    expect(answer._tag).toBe("Success");
    expect(seen).toMatchObject([
      { callId: "msg_before", contextLimit: 200_000, compactionAt: 170_000 },
      { callId: "msg_after", contextLimit: 400_000, compactionAt: 231_200 },
    ]);
  });
});

/* ── Stored messages as the live stream's parts (A6 F10) ────────────────────── */

/**
 * A real `message.list` answer: `testdata/opencode-messages/tool-and-thinking.json`.
 *
 * Recorded 2026-11-04 from a throwaway bit server (`HARNESS=opencode`, opencode 2.2.5,
 * `zai-coding-plan/glm-5.3-flash`): an importer conversation of two turns, each reasoning,
 * a sentence and a `shell` call, then an answer — the second turn's split by the server
 * into two assistant messages. Between them OpenCode stored a `system` entry whose text is
 * the model-facing tool catalogue, and an `idle` after each turn. Sanitised: the importer's
 * framing above the operator's first message, the `system` text and every `native` blob are
 * elided, and the snapshot is gone. Times are the wire's epoch milliseconds.
 */
const storedMessages = async (): Promise<unknown[]> =>
  JSON.parse(
    await Bun.file(
      `${import.meta.dir}/testdata/opencode-messages/tool-and-thinking.json`,
    ).text(),
  ) as unknown[];

describe("a session's stored messages, as the live stream's parts (A6 F10)", () => {
  const read = async (
    edit: (stored: unknown[]) => unknown[] = (stored) => stored,
  ): Promise<readonly MessageEntry[]> => {
    const stored = edit(await storedMessages());
    let served = false;
    const { layer } = clientWith((url) => {
      if (!url.includes("/message")) return json({ data: [] });
      const page = served ? [] : stored;
      served = true;
      return json({
        data: page,
        cursor: { previous: null, next: page.length === 0 ? null : "next" },
      });
    });
    return Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.flatMap(AgentHarness, (client) => client.messages("ses_1")),
          layer,
        ),
      ),
    );
  };

  test("an assistant message's content becomes the parts the stream narrates, with its model and time", async () => {
    const entries = await read();
    expect(
      entries.map((entry) => [
        entry.type,
        entry.parts.map((part) => part._tag).join("+"),
      ]),
    ).toEqual([
      ["user", ""],
      ["assistant", "thinking+reply+toolCall+toolResult"],
      ["system", ""],
      ["assistant", "thinking+reply"],
      ["idle", ""],
      ["user", ""],
      ["assistant", "thinking+toolCall+toolResult"],
      ["assistant", "reply"],
      ["idle", ""],
    ]);
    // `provider/model`, as this build names an OpenCode model; none on the operator's entry.
    expect(entries[1]?.model).toBe("zai-coding-plan/glm-5.3-flash");
    expect(entries[0]?.model).toBeUndefined();
    // The client decodes the wire's milliseconds into a `DateTime`, and they come back out.
    expect(entries[0]?.at).toBe(1_793_774_087_890);
    // A stored tool part is the call **and** its outcome, both named.
    expect(entries[1]?.parts.slice(2)).toEqual([
      {
        _tag: "toolCall",
        callId: "call_8037366fab464071ae906325",
        tool: "shell",
        input: '{"command":"ls -a"}',
        model: "zai-coding-plan/glm-5.3-flash",
      },
      {
        _tag: "toolResult",
        callId: "call_8037366fab464071ae906325",
        tool: "shell",
        output: ".\n..\n.opencode\n",
        failed: false,
      },
    ]);
    // A `system` entry reads as its transcript summary, not the model-facing text.
    expect(entries[2]?.text).toBe("Instructions updated: core/codemode");
  });

  test("a text or reasoning part is named as its stream named it: message, channel, ordinal", async () => {
    const entries = await read();
    expect(
      entries.flatMap((entry) =>
        entry.parts.flatMap((part) =>
          part._tag === "reply" || part._tag === "thinking"
            ? [part.blockId]
            : [],
        ),
      ),
    ).toEqual([
      "msg_1a5446ede001LFYoSkko0SOI62:reasoning:0",
      "msg_1a5446ede001LFYoSkko0SOI62:text:0",
      "msg_1a5448299001jPNuDNGU8CwiFU:reasoning:0",
      "msg_1a5448299001jPNuDNGU8CwiFU:text:0",
      expect.stringMatching(/^msg_.*:reasoning:0$/),
      expect.stringMatching(/^msg_.*:text:0$/),
    ]);
    // Each names its message as its call (A6 U5 review), as the live events do.
    for (const entry of entries) {
      for (const part of entry.parts) {
        if (part._tag === "reply" || part._tag === "thinking") {
          expect(part.blockId?.startsWith(`${String(part.call)}:`)).toBe(true);
        }
      }
    }
  });

  test("a system entry with no summary replays capped, not as the whole model-facing text", async () => {
    // The fixture's `system` entry with its `description` gone and its text the size of a
    // real tool catalogue: what the replay falls back to when OpenCode gave no summary.
    const catalogue = "tool: shell — runs a command.\n".repeat(2_000);
    const entries = await read((stored) =>
      stored.map((entry) => {
        const record = entry as Record<string, unknown>;
        if (record["type"] !== "system") return entry;
        const rest: Record<string, unknown> = { ...record, text: catalogue };
        delete rest["description"];
        return rest;
      }),
    );
    expect(entries[2]?.text).toBe(catalogue);
    const replayed = projectReplay({
      entries,
      subject: { _tag: "import", importId: "imp_1" },
      harnessSessionId: "ses_1",
      users: "operator",
      fallbackAt: 0,
    }).items;
    const system = replayed.find(
      (item) => item.kind === "turn.other" && item.headline === "system",
    );
    expect(system?.body.length).toBeLessThan(NARRATION_FIELD_MAX + 64);
    expect(system?.body.endsWith(NARRATION_TRUNCATED_MARK)).toBe(true);
  });

  test("a replayed item equals the item the live events made of the same message, but for its id and time", async () => {
    const entries = await read();
    const message = entries[1];
    if (message === undefined) throw new Error("no assistant message");
    const id = "msg_1a5446ede001LFYoSkko0SOI62";
    const call = "call_8037366fab464071ae906325";
    const reasoning = message.parts[0];
    const said = message.parts[1];
    const event = (type: string, data: Record<string, unknown>) => ({
      type,
      created: 1,
      durable: { aggregateID: "ses_1", seq: 1, version: 1 },
      data: { sessionID: "ses_1", assistantMessageID: id, ...data },
    });
    // The events OpenCode 2.2.5 publishes for that message, in its order.
    const names = new Map<string, string>();
    const models = new Map<string, string>();
    const live = [
      event("session.step.started", {
        agent: "build",
        model: { id: "glm-5.3-flash", providerID: "zai-coding-plan" },
        started: 1,
      }),
      event("session.reasoning.ended", {
        ordinal: 0,
        text: reasoning?._tag === "thinking" ? reasoning.text : "",
      }),
      event("session.text.ended", {
        ordinal: 0,
        text: said?._tag === "reply" ? said.text : "",
      }),
      event("session.tool.input.started", { id: call, name: "shell" }),
      event("session.tool.called", { id: call, input: { command: "ls -a" } }),
      event("session.tool.success", {
        id: call,
        content: [{ type: "text", text: ".\n..\n.opencode\n" }],
      }),
    ].map((each) => openCodeNarration(each, names, undefined, models));
    const subject = { _tag: "import", importId: "imp_1" } as const;
    const liveItems = live.flatMap((entry, n) => {
      const frame = projectNarration({
        id: n,
        targetId: "acme",
        subject,
        harnessSessionId: "ses_1",
        entry,
      });
      return frame?._tag === "item" ? [frame] : [];
    });
    const replayed = projectReplay({
      entries: [message],
      subject,
      harnessSessionId: "ses_1",
      users: "operator",
      fallbackAt: 0,
    }).items;
    const shape = (item: LiveItem) =>
      Object.fromEntries(
        Object.entries(item).filter(([key]) => key !== "id" && key !== "at"),
      );
    expect(replayed.map(shape)).toEqual(liveItems.map(shape));
    expect(liveItems.map((item) => [item.kind, item.model])).toEqual([
      ["turn.thinking", "zai-coding-plan/glm-5.3-flash"],
      ["turn.reply", "zai-coding-plan/glm-5.3-flash"],
      ["tool.call", "zai-coding-plan/glm-5.3-flash"],
      ["tool.result", undefined],
    ]);
  });

  /*
   * A6 U4 review: OpenCode stores one time per message, its start; a replay stamped every
   * part with it, so a turn that took 3 s live read 0 s after a reload. A finished message's
   * parts take its `time.completed`; one with none says its end is unknown.
   */
  test("a finished message's parts carry when it completed, and an unfinished one's say their end is unknown", async () => {
    const project = (entries: readonly MessageEntry[]) =>
      projectReplay({
        entries,
        subject: { _tag: "import", importId: "imp_1" },
        harnessSessionId: "ses_1",
        users: "operator",
        fallbackAt: 0,
      }).items;
    const replayed = project(await read());
    // The first turn: its operator message when it was sent, each assistant message's parts
    // when that message completed (both stored in the fixture), never when it started.
    expect(
      replayed
        .filter((item) => item.kind !== "tool.result")
        .map((item) => [item.kind, item.at, item.endUnknown ?? false])
        .slice(0, 6),
    ).toEqual([
      ["turn.operator", 1_793_774_087_890, false],
      ["turn.thinking", 1_793_774_092_936, false],
      ["turn.reply", 1_793_774_092_936, false],
      ["tool.call", 1_793_774_092_936, false],
      ["turn.other", 1_793_774_092_947, false],
      ["turn.thinking", 1_793_774_096_645, false],
    ]);

    const unfinished = project(
      await read((stored) =>
        stored.map((entry, index) =>
          index === 3
            ? {
                ...(entry as object),
                time: { created: 1_793_774_092_958 },
              }
            : entry,
        ),
      ),
    );
    const late = unfinished.filter((item) => item.endUnknown === true);
    expect(late.map((item) => [item.kind, item.at])).toEqual([
      ["turn.thinking", 1_793_774_092_958],
      ["turn.reply", 1_793_774_092_958],
    ]);
  });

  /*
   * A6 U4 review: a turn that failed in the harness is stored with its error twice — on the
   * assistant message (`step.failed`) and on the `idle` that ended the turn
   * (`execution.failed`) — and live narrates it once.
   */
  test("a turn's error stored on its assistant message and its idle entry is drawn once", async () => {
    const SAID = "Free usage limit reached. Visit ‮opencode.ai";
    const replayed = projectReplay({
      entries: await read((stored) =>
        stored.map((entry, index) =>
          index === 3
            ? {
                ...(entry as object),
                error: { type: "unknown", message: SAID },
              }
            : index === 4
              ? {
                  ...(entry as object),
                  outcome: "failed",
                  error: { type: "unknown", message: SAID },
                }
              : index === 8
                ? {
                    ...(entry as object),
                    outcome: "failed",
                    error: { type: "unknown", message: "Another failure" },
                  }
                : entry,
        ),
      ),
      subject: { _tag: "import", importId: "imp_1" },
      harnessSessionId: "ses_1",
      users: "operator",
      fallbackAt: 0,
    }).items;
    expect(
      replayed
        .filter((item) => item.headline === "error")
        .map((item) => item.body),
    ).toEqual([SAID, "Another failure"]);
  });
});

/* ── A message's files, replayed (A6 F9) ─────────────────────────────────────── */

describe("a replayed message's files", () => {
  /** One page of one stored user message, then an empty page. */
  const replayOf = async (
    text: string,
    files: readonly unknown[],
    uploadsFolder: string,
  ) => {
    let pages = 0;
    const { layer } = clientWith((url) => {
      if (!url.includes("/message")) return json({ data: [] });
      pages += 1;
      return json({
        data:
          pages > 1
            ? []
            : [
                {
                  id: `msg_${"0".repeat(12)}${"A".repeat(14)}`,
                  time: { created: 1_793_577_000_000 },
                  type: "user",
                  text,
                  files,
                },
              ],
        cursor: { previous: null, next: pages > 1 ? null : "x" },
      });
    });
    return Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.flatMap(AgentHarness, (client) =>
            client.messages("ses_1", { uploadsFolder }),
          ),
          layer,
        ),
      ),
    );
  };

  const withUploads = async <A>(
    names: readonly string[],
    body: (folder: string) => Promise<A>,
  ): Promise<A> => {
    const root = mkdtempSync(join(tmpdir(), "bit-oc-replay-"));
    const folder = join(root, "uploads");
    try {
      mkdirSync(folder);
      for (const name of names) writeFileSync(join(folder, name), "x");
      return await body(folder);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  test("an operator's message carries its files, typed from OpenCode's file parts, and its path lines are not in its words", async () => {
    await withUploads(["shot.png", "capture.har"], async (folder) => {
      const png = join(folder, "shot.png");
      const har = join(folder, "capture.har");
      const entries = await replayOf(
        withAttachmentLines(
          "What is in these?",
          [
            {
              kind: "image",
              name: "shot.png",
              mimeType: "image/png",
              path: png,
              bytes: 1,
            },
            {
              kind: "file",
              name: "capture.har",
              mimeType: "application/json",
              path: har,
              bytes: 1,
            },
          ],
          folder,
        ),
        // Only the image went inline: a HAR is path-only.
        [
          {
            data: "AA==",
            mime: "image/png",
            source: { type: "uri", uri: `file://${png}` },
            name: "shot.png",
          },
        ],
        folder,
      );
      expect(entries[0]?.text).toBe("What is in these?");
      expect(entries[0]?.attachments).toEqual([
        { kind: "image", name: "shot.png", mimeType: "image/png", path: png },
        {
          kind: "file",
          name: "capture.har",
          mimeType: "application/json",
          path: har,
        },
      ]);
      const [item] = projectReplay({
        entries,
        subject: { _tag: "import", importId: "imp_1" },
        harnessSessionId: "ses_1",
        users: "operator",
        fallbackAt: 0,
      }).items;
      expect(item?.headline).toBe("You");
      expect(item?.body).toBe("What is in these?");
      expect(item?.attachments?.length).toBe(2);
    });
  });

  test("a look-alike line naming a path outside the session's uploads folder reloads as the operator's words, with no attachment", async () => {
    await withUploads(["report.pdf"], async (folder) => {
      for (const text of [
        'Read this.\n\n[Attached file "report.pdf" is saved at: /home/op/.ssh/id_rsa]',
        // Another session's uploads folder, a file of that name stored in this one.
        'Read this.\n\n[Attached file "report.pdf" is saved at: /fleet/t/import/imp_2/uploads/report.pdf]',
      ]) {
        const entries = await replayOf(text, [], folder);
        expect(entries[0]?.text).toBe(text);
        expect(entries[0]?.attachments).toBeUndefined();
      }
    });
  });

  /*
   * OpenCode takes steers one at a time, each its own message (`claude-code-partial-stream-
   * facts`), so no entry holds two messages' lines. One reader serves the whole read, across
   * pages; a look-alike quoted in a later message stays its words.
   */
  test("across pages, each message's lines are read, and an outside look-alike in a later message stays words", async () => {
    await withUploads(["shot.png"], async (folder) => {
      const first = withAttachmentLines(
        "Here.",
        [
          {
            kind: "image",
            name: "shot.png",
            mimeType: "image/png",
            path: join(folder, "shot.png"),
            bytes: 1,
          },
        ],
        folder,
      );
      const later =
        'What was this?\n\n[Attached image "shot.png" is saved at: /tmp/elsewhere/shot.png]';
      let pages = 0;
      const { layer } = clientWith((url) => {
        if (!url.includes("/message")) return json({ data: [] });
        pages += 1;
        const text = pages === 1 ? first : pages === 2 ? later : undefined;
        return json({
          data:
            text === undefined
              ? []
              : [
                  {
                    id: `msg_${"0".repeat(12)}${String(pages).repeat(14)}`,
                    time: { created: 1_793_577_000_000 + pages },
                    type: "user",
                    text,
                    files: [],
                  },
                ],
          cursor: { previous: null, next: text === undefined ? null : "x" },
        });
      });
      const entries = await Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.flatMap(AgentHarness, (client) =>
              client.messages("ses_1", { uploadsFolder: folder }),
            ),
            layer,
          ),
        ),
      );
      expect(
        entries.map((entry) => [
          entry.text,
          (entry.attachments ?? []).map((file) => file.name),
        ]),
      ).toEqual([
        ["Here.", ["shot.png"]],
        [later, []],
      ]);
    });
  });
});

/* ── Sub-agents (A6 U14) ─────────────────────────────────────────────────────── */

/**
 * OpenCode's sub-agent tool, as 2.2.5 runs it (`packages/core/src/tool/plugin/subagent.ts`
 * in the opencode source): the tool is `subagent` (`task` before 2.2), its input
 * `{ agent, description, prompt, background? }`. The sub-agent runs as a **child session**,
 * whose events carry its own `sessionID` and never reach the parent's stream
 * (`sessionOf`). Its call's result `metadata` is `{ sessionID, status }`: `completed` when
 * it handed back, `running` when it was launched in the background, after which a
 * `session.synthetic` notice on the parent, metadata `{ source: "subagent", childID, state }`
 * (`session/subagent-completion.ts`), says it ended. Built from those sources, not
 * recorded: no live OpenCode run with a sub-agent backs these shapes.
 */
describe("sub-agents, as one entry each (A6 U14)", () => {
  const event = (type: string, data: Record<string, unknown>) => ({
    type,
    created: 10,
    durable: { aggregateID: "ses_1", seq: 4, version: 1 },
    data: { sessionID: "ses_1", assistantMessageID: "msg_1", ...data },
  });
  const states = (details: readonly { readonly _tag: string }[]) =>
    details.flatMap((detail) =>
      detail._tag === "subagent"
        ? [
            ((state: {
              callId: string;
              status: string;
              agentType: string | undefined;
              description: string;
            }) =>
              `${state.callId} ${state.status} ${String(state.agentType)} · ${state.description}`)(
              detail as never,
            ),
          ]
        : [],
    );
  const live = (events: readonly unknown[]) => {
    const names = new Map<string, string>();
    const models = new Map<string, string>();
    const subagents = openCodeSubagents();
    return events.map(
      (each) =>
        openCodeNarration(each, names, undefined, models, subagents).detail,
    );
  };
  const foreground = [
    event("session.step.started", {
      model: { providerID: "zai", id: "glm-5.3-flash" },
    }),
    event("session.tool.input.started", { id: "call_fg", name: "subagent" }),
    event("session.tool.called", {
      id: "call_fg",
      input: {
        agent: "explore",
        description: "Find the login form",
        prompt: "Look for a login form on the page and say where it posts.",
      },
      executed: true,
    }),
    event("session.tool.success", {
      id: "call_fg",
      content: [
        {
          type: "text",
          text: '<subagent sessionID="ses_child" state="completed">\nIt posts to /session.\n</subagent>',
        },
      ],
      metadata: { sessionID: "ses_child", status: "completed" },
      executed: true,
    }),
  ];

  test("live: a subagent call is one entry that runs, then finishes, and its reply is not carried", () => {
    const details = live(foreground);
    expect(states(details)).toEqual([
      "call_fg running explore · Find the login form",
      "call_fg finished explore · Find the login form",
    ]);
    expect(details.some((detail) => detail._tag === "toolCall")).toBe(false);
    expect(details.some((detail) => detail._tag === "toolResult")).toBe(false);
    expect(JSON.stringify(details)).not.toContain("It posts to /session.");
    expect(details[2]).toEqual({
      _tag: "subagent",
      callId: "call_fg",
      tool: "subagent",
      agentType: "explore",
      description: "Find the login form",
      status: "running",
      model: "zai/glm-5.3-flash",
    });
  });

  test("live: a background subagent runs until the parent's completion notice, which ends it", () => {
    const details = live([
      event("session.tool.input.started", { id: "call_bg", name: "subagent" }),
      event("session.tool.called", {
        id: "call_bg",
        input: {
          agent: "general",
          prompt: "Check robots.txt",
          background: true,
        },
        executed: true,
      }),
      event("session.tool.success", {
        id: "call_bg",
        content: [
          {
            type: "text",
            text: "The subagent is working in the background (sessionID: ses_bg).",
          },
        ],
        metadata: { sessionID: "ses_bg", status: "running" },
        executed: true,
      }),
      event("session.text.ended", { ordinal: 0, text: "Started it." }),
      event("session.synthetic", {
        text: '<subagent sessionID="ses_bg" state="completed" description="">\nrobots.txt disallows /admin\n</subagent>',
        metadata: {
          source: "subagent",
          childID: "ses_bg",
          agent: "general",
          state: "completed",
        },
      }),
    ]);
    // No description given: the prompt's start stands in for one.
    expect(states(details)).toEqual([
      "call_bg running general · Check robots.txt",
      "call_bg finished general · Check robots.txt",
    ]);
    expect(details[2]).toEqual({ _tag: "opaque" });
    expect(details[4]?._tag).toBe("subagent");
    expect(JSON.stringify(details)).not.toContain("disallows");
  });

  test("live: a failed or cancelled subagent ends its entry so; a call with the old name `task` is one too", () => {
    const failed = live([
      event("session.tool.input.started", { id: "c1", name: "task" }),
      event("session.tool.called", {
        id: "c1",
        input: { subagent_type: "general", description: "Old name" },
        executed: true,
      }),
      event("session.tool.failed", {
        id: "c1",
        error: { message: "Subagent failed (sessionID: ses_c1): boom" },
      }),
      event("session.tool.input.started", { id: "c2", name: "subagent" }),
      event("session.tool.called", {
        id: "c2",
        input: { agent: "general", description: "Cancelled one" },
        executed: true,
      }),
      event("session.tool.failed", {
        id: "c2",
        error: { message: "Subagent cancelled (sessionID: ses_c2)" },
      }),
    ]);
    expect(states(failed)).toEqual([
      "c1 running general · Old name",
      "c1 failed general · Old name",
      "c2 running general · Cancelled one",
      "c2 stopped general · Cancelled one",
    ]);
  });

  test("replay equals live: the stored tool parts and the completion notice are the same entries", async () => {
    // Shaped on the recorded answer's own entries, so the client's schema decodes them.
    const recorded = (await storedMessages()) as Record<string, unknown>[];
    const [user, assistant] = recorded;
    const tool =
      (assistant?.["content"] as Record<string, unknown>[]).find(
        (part) => part["type"] === "tool",
      ) ?? {};
    const subagentPart = (
      id: string,
      input: Record<string, unknown>,
      output: string,
      metadata: Record<string, unknown>,
    ) => ({
      ...tool,
      id,
      name: "subagent",
      state: {
        status: "completed",
        input,
        content: [{ type: "text", text: output }],
        metadata,
      },
    });
    const stored = [
      { ...user, id: "msg_u", text: "Use subagents." },
      {
        ...assistant,
        id: "msg_1",
        model: { providerID: "zai", id: "glm-5.3-flash" },
        content: [
          subagentPart(
            "call_fg",
            {
              agent: "explore",
              description: "Find the login form",
              prompt: "Look for a login form.",
            },
            "It posts to /session.",
            { sessionID: "ses_child", status: "completed" },
          ),
          subagentPart(
            "call_bg",
            { agent: "general", prompt: "Check robots.txt", background: true },
            "working in the background",
            { sessionID: "ses_bg", status: "running" },
          ),
          { type: "text", text: "Started it." },
        ],
      },
      {
        id: "msg_s",
        type: "synthetic",
        time: user?.["time"],
        text: '<subagent sessionID="ses_bg" state="completed">\nrobots.txt disallows /admin\n</subagent>',
        metadata: {
          source: "subagent",
          childID: "ses_bg",
          agent: "general",
          state: "completed",
        },
      },
    ];
    let served = false;
    const { layer } = clientWith((url) => {
      if (!url.includes("/message")) return json({ data: [] });
      const page = served ? [] : stored;
      served = true;
      return json({
        data: page,
        cursor: { previous: null, next: page.length === 0 ? null : "next" },
      });
    });
    const entries = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.flatMap(AgentHarness, (client) => client.messages("ses_1")),
          layer,
        ),
      ),
    );
    expect(states(entries.flatMap((entry) => entry.parts))).toEqual([
      "call_fg running explore · Find the login form",
      "call_fg finished explore · Find the login form",
      "call_bg running general · Check robots.txt",
      "call_bg finished general · Check robots.txt",
    ]);
    // The notice's words — the sub-agent's reply — are gone, and it is no `synthetic` note.
    const subject = { _tag: "import", importId: "imp_1" } as const;
    const replayed = projectReplay({
      entries,
      subject,
      harnessSessionId: "ses_1",
      users: "operator",
      fallbackAt: 0,
    }).items;
    expect(JSON.stringify(replayed)).not.toContain("disallows");
    expect(JSON.stringify(replayed)).not.toContain("It posts to");
    expect(replayed.some((item) => item.kind === "turn.other")).toBe(false);

    // The same events, live, project to the same sub-agent items.
    const liveDetails = live([
      event("session.step.started", {
        model: { providerID: "zai", id: "glm-5.3-flash" },
      }),
      ...foreground.slice(1),
      event("session.tool.input.started", { id: "call_bg", name: "subagent" }),
      event("session.tool.called", {
        id: "call_bg",
        input: {
          agent: "general",
          prompt: "Check robots.txt",
          background: true,
        },
        executed: true,
      }),
      event("session.tool.success", {
        id: "call_bg",
        content: [{ type: "text", text: "working in the background" }],
        metadata: { sessionID: "ses_bg", status: "running" },
        executed: true,
      }),
      event("session.synthetic", {
        text: "…",
        metadata: { source: "subagent", childID: "ses_bg", state: "completed" },
      }),
    ]);
    const liveItems = liveDetails.flatMap((detail, id) => {
      const frame = projectNarration({
        id,
        targetId: "acme",
        subject,
        harnessSessionId: "ses_1",
        entry: {
          type: "x",
          sequence: undefined,
          at: 0,
          outcome: undefined,
          detail,
        },
      });
      return frame?._tag === "item" ? [frame] : [];
    });
    const shape = (item: LiveItem) =>
      Object.fromEntries(
        Object.entries(item).filter(([key]) => key !== "id" && key !== "at"),
      );
    const agents = (items: readonly LiveItem[]) =>
      items.filter((item) => item.kind === "subagent").map(shape);
    expect(agents(liveItems)).toEqual(agents(replayed));
    expect(agents(replayed)).toHaveLength(4);
  });
});

/* ── The context meter's reading (A6 U9) ───────────────────────────────────────── */

describe("how full a session's window is (A6 U9)", () => {
  const assistantWith = (tokens: unknown) => ({
    type: "assistant",
    model: { id: "glm-5.3-flash-free", providerID: "opencode" },
    tokens,
  });
  const TOKENS = {
    input: 150,
    output: 3,
    reasoning: 12,
    cache: { read: 13_600, write: 0 },
  };

  test("the newest call, summed as OpenCode's own meter sums it; a completed compaction after it", () => {
    // Newest first. DECISIONS.md §24.4's fifth call plus some reasoning: 13 765.
    expect(
      openCodeContext([
        { type: "user", text: "go on" },
        assistantWith(TOKENS),
        assistantWith({ ...TOKENS, input: 99_999 }),
      ]),
    ).toEqual({
      used: 150 + 3 + 12 + 13_600,
      // The call's own model, as the catalogue names it.
      usedModel: "opencode/glm-5.3-flash-free",
      reading: "measured",
    });
    // A call with no tokens yet (still streaming) is passed over for the one before it.
    expect(
      openCodeContext([assistantWith(undefined), assistantWith(TOKENS)])?.used,
    ).toBe(13_765);
    expect(
      openCodeContext([
        { type: "compaction", status: "completed", summary: "…" },
        assistantWith(TOKENS),
      ]),
    ).toEqual({ used: null, usedModel: null, reading: "compacted" });
    // Running or failed: nothing was rewritten yet.
    for (const status of ["running", "failed"]) {
      expect(
        openCodeContext([{ type: "compaction", status }, assistantWith(TOKENS)])
          ?.reading,
      ).toBe("measured");
    }
    expect(openCodeContext([{ type: "user", text: "hi" }])).toBeUndefined();
  });

  test("a session's reading: one newest-first page, and the window of the model the caller names", async () => {
    const pages: URL[] = [];
    const { layer } = clientWith((url) => {
      if (url.includes("/api/model")) {
        return json({
          location: { directory: "/tmp" },
          data: [catalogueEntry, defaultCatalogueEntry],
        });
      }
      if (url.includes("/message")) {
        pages.push(new URL(url));
        // Shapes the client decodes, as a live 2.2.5 answers them (newest first).
        return json({
          data: [
            {
              id: "msg_000000000002AAAAAAAAAAAAAA",
              time: { created: 1_793_577_000_002 },
              text: "go",
              type: "user",
            },
            {
              id: "msg_000000000001AAAAAAAAAAAAAA",
              time: {
                created: 1_793_577_000_001,
                completed: 1_793_577_000_002,
              },
              type: "assistant",
              agent: "build",
              model: { id: "glm-5.3-flash-free", providerID: "opencode" },
              content: [{ type: "text", text: "hi" }],
              finish: "stop",
              rawFinish: "stop",
              cost: 0,
              tokens: TOKENS,
            },
          ],
          cursor: { previous: null, next: "c2" },
        });
      }
      return json(sessionInfo());
    });
    const read = (model: string) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.flatMap(AgentHarness, (client) =>
              client.contextUsage("ses_1", { model, breakdown: true }),
            ),
            layer,
          ),
        ),
      );
    expect(await read("opencode/glm-5.3-flash-free")).toEqual({
      used: 13_765,
      usedModel: "opencode/glm-5.3-flash-free",
      window: 200_000,
      reading: "measured",
      breakdown: { _tag: "none", reason: "harness_gives_none" },
    });
    // Switched: the same last call, against the new model's window, and still labelled
    // with the model that made it.
    const switched = await read("openai/gpt-5.6-sol");
    expect(switched.window).toBe(400_000);
    expect(switched.usedModel).toBe("opencode/glm-5.3-flash-free");
    // A model the catalogue does not list states no window.
    expect((await read("opencode/unlisted")).window).toBeNull();
    expect(pages.map((page) => page.searchParams.get("order"))).toEqual([
      "desc",
      "desc",
      "desc",
    ]);
  });
});

/* ── Questions: OpenCode's forms (A7-Q) ──────────────────────────────────────── */

describe("the question dock's OpenCode half: forms (A7-Q)", () => {
  /** A form the 2.2.5 `question` tool opens: one field per question, `q0…qN`. */
  const questionForm = (id = "frm_1", session = "ses_1") => ({
    id,
    sessionID: session,
    title: "Questions",
    metadata: { kind: "question", tool: { messageID: "msg_1", id: "call_1" } },
    fields: [
      {
        key: "q0",
        type: "string",
        title: "Colour",
        description: "Which colour do you prefer?",
        options: [
          { value: "Red", label: "Red", description: "warm" },
          { value: "Blue", label: "Blue" },
        ],
        custom: true,
      },
      {
        key: "q1",
        type: "multiselect",
        title: "Sizes",
        description: "Which sizes do you want?",
        options: [
          { value: "S", label: "S" },
          { value: "L", label: "L" },
        ],
        custom: true,
      },
      {
        key: "q2",
        type: "string",
        description: "Anything else?",
        required: true,
      },
    ],
  });
  /** An MCP elicitation's form: not a question this build draws. */
  const otherForm = {
    id: "frm_other",
    sessionID: "ses_1",
    title: "Sign in",
    fields: [{ key: "ok", type: "boolean" }],
  };

  test("a question form is the question it asks: kinds, options, keys and the required flag", () => {
    const question = openCodeQuestionOf(questionForm());
    expect(question?.questionId).toBe("frm_1");
    expect(question?.callId).toBe("call_1");
    expect(
      question?.fields.map(
        (field) =>
          `${field.key} ${field.kind} ${field.header ?? "-"} | ${field.question} | ${field.options.map((option) => option.label).join(",")} | ${String(field.custom)} ${String(field.required)}`,
      ),
    ).toEqual([
      "q0 one Colour | Which colour do you prefer? | Red,Blue | true false",
      "q1 any Sizes | Which sizes do you want? | S,L | true false",
      "q2 text - | Anything else? |  | true true",
    ]);
    expect(question?.fields[0].options[0]?.description).toBe("warm");
    expect(openCodeQuestionOf(otherForm)).toBeUndefined();
    expect(
      openCodeQuestionOf({ ...questionForm(), metadata: { kind: "auth" } }),
    ).toBeUndefined();
  });

  test("the three form events narrate a question asked, and how it stopped waiting", () => {
    const names = new Map<string, string>();
    const asked = openCodeNarration(
      { type: "form.created", created: 5, data: { form: questionForm() } },
      names,
    );
    expect(asked.detail._tag).toBe("question");
    const other = openCodeNarration(
      { type: "form.created", data: { form: otherForm } },
      names,
    );
    expect(other.detail._tag).toBe("opaque");
    const settled = (
      type: string,
      here: ReadonlyMap<string, never> | Map<string, "dismissed">,
    ) =>
      openCodeNarration(
        { type, data: { id: "frm_1", sessionID: "ses_1", answer: {} } },
        names,
        undefined,
        new Map(),
        undefined,
        here,
      ).detail;
    expect(settled("form.replied", new Map())).toEqual({
      _tag: "questionSettled",
      questionId: "frm_1",
      settled: "answered",
    });
    // A cancel says nothing of who cancelled: this process's own dismissal, or a withdrawal.
    expect(
      settled("form.cancelled", new Map([["frm_1", "dismissed" as const]])),
    ).toMatchObject({ settled: "dismissed" });
    expect(settled("form.cancelled", new Map())).toMatchObject({
      settled: "withdrawn",
    });
  });

  const asking = <A>(
    stub: Parameters<typeof clientWith>[0],
    use: (harness: AgentHarness["Service"]) => Effect.Effect<A, unknown>,
  ) => {
    const { layer, recorded } = clientWith(stub);
    return Effect.runPromise(
      Effect.scoped(
        Effect.provide(Effect.result(Effect.flatMap(AgentHarness, use)), layer),
      ),
    ).then((answer) => ({ answer, recorded }));
  };
  const listing = (url: string, init: RequestInit | undefined) =>
    url.endsWith("/api/session/ses_1/form") &&
    (init?.method ?? "GET") === "GET";

  test("pending questions are the session's question forms, read from the server; a session it does not have waits on nothing", async () => {
    const { answer } = await asking(
      (url, init) =>
        listing(url, init)
          ? json({ data: [questionForm(), otherForm] })
          : json({}, 500),
      (harness) => harness.pendingQuestions("ses_1"),
    );
    expect(answer._tag).toBe("Success");
    if (answer._tag !== "Success") return;
    expect(answer.success.map((question) => question.questionId)).toEqual([
      "frm_1",
    ]);
    const gone = await asking(
      () =>
        json({ _tag: "SessionNotFoundError", message: "no such session" }, 404),
      (harness) => harness.pendingQuestions("ses_1"),
    );
    expect(gone.answer).toMatchObject({ _tag: "Success", success: [] });
  });

  test("an answer is the form's reply: a choose-one as its string, a choose-any as its list, a skipped one left out", async () => {
    const { answer, recorded } = await asking(
      (url, init) =>
        listing(url, init)
          ? json({ data: [questionForm()] })
          : url.endsWith("/form/frm_1/reply")
            ? Promise.resolve(new Response(null, { status: 204 }))
            : json({}, 500),
      (harness) =>
        harness.answerQuestion("ses_1", "frm_1", {
          q0: ["Blue"],
          q1: ["S", "L"],
          q2: ["nothing"],
        }),
    );
    expect(answer._tag).toBe("Success");
    expect(recorded.bodies.map((body) => JSON.parse(body) as unknown)).toEqual([
      { answer: { q0: "Blue", q1: ["S", "L"], q2: "nothing" } },
    ]);
    const skipped = await asking(
      (url, init) =>
        listing(url, init)
          ? json({ data: [questionForm()] })
          : Promise.resolve(new Response(null, { status: 204 })),
      (harness) =>
        harness.answerQuestion("ses_1", "frm_1", { q0: [], q2: ["x"] }),
    );
    expect(JSON.parse(skipped.recorded.bodies[0] ?? "{}")).toEqual({
      answer: { q2: "x" },
    });
  });

  test("a dismissal cancels the form with the sentence the agent is told", async () => {
    const { answer, recorded } = await asking(
      (url, init) =>
        init?.method === "DELETE"
          ? Promise.resolve(new Response(null, { status: 204 }))
          : json({}, 500),
      (harness) => harness.dismissQuestion("ses_1", "frm_1"),
    );
    expect(answer._tag).toBe("Success");
    const asked = new URL(recorded.urls[0] ?? "http://x/");
    expect(`${recorded.methods[0] ?? ""} ${asked.pathname}`).toBe(
      "DELETE /api/session/ses_1/form/frm_1",
    );
    expect(asked.searchParams.get("message")).toBe(QUESTION_DISMISSED_MESSAGE);
  });

  test("a form the server no longer waits on is refused as settled — FormAlreadySettledError, FormNotFoundError — and refused answers as invalid", async () => {
    const replyWith = (body: unknown, status: number) =>
      asking(
        (url, init) =>
          listing(url, init)
            ? json({ data: [questionForm()] })
            : json(body, status),
        (harness) => harness.answerQuestion("ses_1", "frm_1", { q2: ["x"] }),
      );
    const settled = await replyWith(
      { _tag: "FormAlreadySettledError", id: "frm_1", message: "settled" },
      409,
    );
    expect(settled.answer).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "QuestionNotPending", reason: "settled" },
    });
    const invalid = await replyWith(
      { _tag: "FormInvalidAnswerError", id: "frm_1", message: "bad" },
      400,
    );
    expect(invalid.answer).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "QuestionNotPending", reason: "invalid" },
    });
    const forgotten = await asking(
      () =>
        json({ _tag: "FormNotFoundError", id: "frm_1", message: "gone" }, 404),
      (harness) => harness.dismissQuestion("ses_1", "frm_1"),
    );
    expect(forgotten.answer).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "QuestionNotPending", reason: "settled" },
    });
    // Not listed any more (an OpenCode restart forgot it): refused before any reply is sent.
    const restarted = await asking(
      (url, init) => (listing(url, init) ? json({ data: [] }) : json({}, 500)),
      (harness) => harness.answerQuestion("ses_1", "frm_1", { q2: ["x"] }),
    );
    expect(restarted.answer).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "QuestionNotPending", reason: "settled" },
    });
    expect(restarted.recorded.urls).toHaveLength(1);
  });

  test("a server that cannot be reached is a harness failure, not a settled question", async () => {
    const { answer } = await asking(
      () => json({ message: "boom" }, 500),
      (harness) => harness.dismissQuestion("ses_1", "frm_1"),
    );
    expect(answer).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "HarnessTransportError" },
    });
  });
});
