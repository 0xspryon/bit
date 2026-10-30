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

import {
  AgentHarness,
  NARRATION_FIELD_MAX,
  NARRATION_TRUNCATED_MARK,
} from "./agentHarness";
import {
  openCodeCompactionAt,
  openCodeHarness,
  openCodeNarration,
} from "./openCodeClient";
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
    const { layer } = clientWith(() =>
      json(sessionInfo({ outcome: "probably fine" })),
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
    expect(recorded.urls).toHaveLength(2);
    expect(recorded.urls[1]).toContain("/api/experimental/mcp/bit-attempt-1");
    expect(recorded.methods).toEqual(["PUT", "DELETE"]);
    // The directory it was registered into travels with the removal, taken from the
    // registration rather than re-stated by the caller.
    expect(recorded.urls[1]).toContain(encodeURIComponent("/tmp/ws"));
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

  test("unregistering twice makes exactly one request", async () => {
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

    expect(recorded.methods).toEqual(["PUT", "DELETE"]);
  });

  test("a session id with URL-significant characters is encoded", async () => {
    const { layer, recorded } = clientWith(() => json(sessionInfo()));
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
    expect(recorded.urls[0]).toContain("ses%2F..%2Fadmin");
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

  test("text comes from `ended` and never from a delta", async () => {
    const names = new Map<string, string>();
    // One event per token-ish chunk. Published — the supervisor's outcome watch reads this
    // stream — but carrying nothing to render, so one frame per reply block reaches a
    // browser instead of hundreds per turn.
    expect(
      openCodeNarration(
        event("session.text.delta", { ordinal: 1, delta: "Prob" }),
        names,
      ).detail,
    ).toEqual({ _tag: "opaque" });
    expect(
      openCodeNarration(
        event("session.text.ended", {
          ordinal: 1,
          text: "Probing the limiter.",
        }),
        names,
      ).detail,
    ).toEqual({ _tag: "reply", text: "Probing the limiter." });
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
      compactionAt: undefined,
    });
  });

  test("reasoning is narrated from its end event, where the whole block is", () => {
    // `session.reasoning.ended` carries `data.text`, exactly as `session.text.ended` does
    // for a reply, so thinking is one entry per block. The deltas are opaque for the same
    // reason text deltas are: there would be hundreds of them and nothing to render.
    const names = new Map<string, string>();
    const delta = openCodeNarration(
      {
        type: "session.reasoning.delta",
        created: 1,
        data: { sessionID: "ses_1", delta: "The" },
      },
      names,
    );
    expect(delta.detail).toEqual({ _tag: "opaque" });

    const ended = openCodeNarration(
      {
        type: "session.reasoning.ended",
        created: 2,
        data: {
          sessionID: "ses_1",
          assistantMessageID: "msg_1",
          text: "The user wants three files read one at a time.",
        },
      },
      names,
    );
    expect(ended.detail).toEqual({
      _tag: "thinking",
      text: "The user wants three files read one at a time.",
    });
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
