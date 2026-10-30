/**
 * Spike C — what token usage and which context limit reach a harness client?
 *
 * ```sh
 * cd apps/server
 * bun run src/spike/usageProbe.ts 2>&1 | tee .runtime/usage-probe-$(date +%H%M%S).log
 * bun run src/spike/usageProbe.ts --driver=opencode
 * bun run src/spike/usageProbe.ts --driver=claude-code
 * ```
 *
 * A context meter needs a numerator (tokens used) and a denominator (the context limit).
 * `agentHarness.ts` classifies "a usage update" as `opaque` and `HarnessModelView` carries
 * no limit, so neither reaches the browser today. This probe records what each driver
 * *actually emits*, so the slice that draws a meter draws only what is true.
 *
 * ## What is recorded, and why verbatim
 *
 * A figure that is cumulative rather than per-step, or that arrives on only some events, is
 * the whole finding — and both are invisible once a value has been flattened into a
 * summary. So every frame is written to a JSONL file under
 * `.runtime/usage-probe/`, unreduced, and the console shows only the frames that carry a
 * token figure, in arrival order, with their position in the stream.
 *
 * - **OpenCode.** The server-wide SSE stream (`GET /api/event`) is read *raw* with `fetch`,
 *   not through the generated client. The client decodes with Effect Schema, and a struct
 *   decode drops fields the schema does not name: the question here is what the server
 *   sent, not what the installed `@opencode/schema` 2.1.0 knows about. The same applies to
 *   `GET /api/model` and `GET /api/session/:id`, fetched raw alongside the decoded calls.
 *   Two prompts go to one session, so the second shows whether a figure restarts or keeps
 *   adding.
 * - **Claude Code.** Every `SDKMessage` from `query()`, with `includePartialMessages` on so
 *   `message_start` / `message_delta` stream events are visible too. Two turns in one
 *   query, for the same reason. `getContextUsage()` and `supportedModels()` are called and
 *   recorded as well, because they are the only candidate for a Claude Code denominator that
 *   is not read off a `result`.
 *
 * ## Honesty rules this file follows
 *
 * - Nothing is simulated. A driver that will not start is reported `UNTESTED`, with the
 *   failure text.
 * - No production code is changed. The OpenCode leg builds its own client over the same
 *   `OpenCodeServer` layer; the Claude Code leg drives the bare SDK.
 *
 * **Nothing may import this module.** `runMain` is called at module scope; the rule and
 * what it cost to learn are on `workerDemo.ts`.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  query as sdkQuery,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { OpenCode } from "@opencode/client/effect";
import { ID as ModelID } from "@opencode/schema/model";
import { ID as ProviderID } from "@opencode/schema/provider";
import { AbsolutePath } from "@opencode/schema/schema";
import { ID as SessionID, type Session } from "@opencode/schema/session";
import { Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { CLAUDE_CODE_DEFAULT_MODEL } from "../harness/claudeCodeClient";
import { OpenCodeServer } from "../harness/openCodeServer";
import { runMain } from "./main";
import { RUNTIME_DIR } from "./runtime";

/* ------------------------------------------------------------------ prompts */

/**
 * The model the operator named for this spike: free, so it cannot die on a paid account's
 * usage limit. The catalogue spells it `opencode/glm-5.3-flash-free`; the display name is
 * `GLM-5.3-Flash`-ish, and which one this machine has is printed from `GET /api/model`.
 */
const OPENCODE_MODEL = "opencode/glm-5.3-flash-free";

/**
 * Several steps and a tool call, with no permission decision in the way: `read` of a file
 * in the session's own directory. Step count is what makes per-step against cumulative
 * observable — one step could not tell them apart.
 */
const MULTI_STEP_PROMPT =
  "There are three files in this directory named note-1.txt, note-2.txt and note-3.txt. " +
  "Read them one at a time, using exactly one read call per file and never two in the " +
  "same message. After each file, say which word it contained. Use no other tool.";

const SECOND_PROMPT = "Reply with the single word DONE and nothing else.";

const NOTES: Readonly<Record<string, string>> = {
  "note-1.txt": "alpha\n",
  "note-2.txt": "bravo\n",
  "note-3.txt": "charlie\n",
};

/* ------------------------------------------------------------------- output */

const OUT_DIR = join(RUNTIME_DIR, "usage-probe");

const line = (label: string, value: unknown): void => {
  console.log(`${label.padEnd(30)} ${String(value)}`);
};

const heading = (text: string): void => {
  console.log(`\n== ${text} ==`);
};

const dump = (file: string, value: unknown): void => {
  writeFileSync(join(OUT_DIR, file), `${JSON.stringify(value, null, 2)}\n`);
};

/** Depth-first search for any key named `usage`/`tokens`/`cost`, returning the path. */
const carriesFigures = (value: unknown, path = ""): string[] => {
  if (value === null || typeof value !== "object") return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const here = path === "" ? key : `${path}.${key}`;
    if (
      /^(usage|tokens|cost|modelUsage|contextWindow|context|limit)$/i.test(key)
    ) {
      found.push(here);
    }
    found.push(...carriesFigures(child, here));
  }
  return found;
};

interface LegResult {
  readonly driver: string;
  readonly status: "MEASURED" | "UNTESTED";
  readonly detail: string;
}

/* ---------------------------------------------------------------- opencode */

/**
 * The server-wide SSE stream, raw.
 *
 * Returns a stop function that resolves to the frames received, in order. Frames are also
 * appended to a JSONL file as they arrive, so a crash mid-run still leaves evidence.
 */
const readRawEvents = (input: {
  readonly baseUrl: string;
  readonly authorization: string;
  readonly file: string;
}) => {
  const controller = new AbortController();
  const frames: unknown[] = [];
  const started = Date.now();
  writeFileSync(input.file, "");
  const done = (async () => {
    try {
      const response = await fetch(`${input.baseUrl}/api/event`, {
        headers: {
          authorization: input.authorization,
          accept: "text/event-stream",
        },
        signal: controller.signal,
      });
      if (!response.ok || response.body === null) {
        frames.push({ probeError: `status ${response.status}` });
        return;
      }
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        for (;;) {
          const cut = buffer.indexOf("\n\n");
          if (cut === -1) break;
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const data = frame
            .split("\n")
            .filter((entry) => entry.startsWith("data:"))
            .map((entry) => entry.slice(5).trimStart())
            .join("\n");
          if (data === "") continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = { unparsed: data };
          }
          const stamped = { at: Date.now() - started, frame: parsed };
          frames.push(stamped);
          appendFileSync(input.file, `${JSON.stringify(stamped)}\n`);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        frames.push({ probeError: String(error) });
      }
    }
  })();
  return {
    stop: async (): Promise<unknown[]> => {
      controller.abort();
      await done;
      return frames;
    },
  };
};

const sessionOfFrame = (frame: unknown): string | undefined => {
  const record = (frame ?? {}) as {
    data?: { sessionID?: unknown } | undefined;
    durable?: { aggregateID?: unknown } | undefined;
  };
  if (typeof record.data?.sessionID === "string") return record.data.sessionID;
  if (typeof record.durable?.aggregateID === "string") {
    return record.durable.aggregateID;
  }
  return undefined;
};

const openCodeLeg = Effect.fnUntraced(function* () {
  const workspace = join(RUNTIME_DIR, "usage-probe-opencode");
  yield* Effect.sync(() => {
    mkdirSync(workspace, { recursive: true });
  });
  yield* Effect.forEach(Object.entries(NOTES), ([name, content]) =>
    Effect.promise(() => Bun.write(join(workspace, name), content)),
  );

  const run = Effect.gen(function* () {
    const { server } = yield* OpenCodeServer;
    const authorization = Redacted.value(server.authorization);
    heading("opencode — server");
    line("version", server.version);
    line("model requested", OPENCODE_MODEL);

    const rawGet = (path: string) =>
      Effect.promise(async () => {
        const response = await fetch(`${server.baseUrl}${path}`, {
          headers: { authorization, accept: "application/json" },
        });
        const text = await response.text();
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
        return { status: response.status, body };
      });

    // ---- the catalogue, raw: is there a context limit, and where? ----
    heading("opencode — GET /api/model (raw)");
    const catalogue = yield* rawGet("/api/model");
    dump("opencode-model-list.json", catalogue);
    const entries = ((catalogue.body as { data?: unknown[] } | undefined)
      ?.data ?? []) as {
      providerID?: string;
      id?: string;
      name?: string;
    }[];
    line("status", catalogue.status);
    line("catalogue entries", entries.length);
    const wanted = entries.find(
      (entry) => `${entry.providerID}/${entry.id}` === OPENCODE_MODEL,
    );
    line("model found", wanted === undefined ? "NO" : "yes");
    console.log(JSON.stringify(wanted, null, 2));
    const gpt = entries.find(
      (entry) => `${entry.providerID}/${entry.id}` === "openai/gpt-5.6-sol",
    );
    line("bit's default model found", gpt === undefined ? "NO" : "yes");
    if (gpt !== undefined) {
      console.log(
        JSON.stringify(
          (gpt as { limit?: unknown; id?: unknown }).limit,
          null,
          2,
        ),
      );
    }
    const withoutLimit = entries.filter(
      (entry) => (entry as { limit?: unknown }).limit === undefined,
    ).length;
    line("entries with no limit key", withoutLimit);

    const http = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest((request) =>
        request.pipe(
          HttpClientRequest.setHeader("authorization", authorization),
          HttpClientRequest.acceptJson,
        ),
      ),
    );
    const api = yield* OpenCode.make({ baseUrl: server.baseUrl }).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );

    // The same call bit makes (`api.model.list()`), decoded: does the limit survive the
    // generated client's schema, i.e. is it reachable "through the API bit already calls"?
    heading("opencode — api.model.list() (bit's own call, decoded)");
    const decoded = yield* Effect.orDie(api.model.list());
    const decodedEntry = decoded.data.find(
      (entry) => `${entry.providerID}/${entry.id}` === OPENCODE_MODEL,
    );
    console.log(
      JSON.stringify(
        decodedEntry === undefined
          ? undefined
          : { id: decodedEntry.id, limit: decodedEntry.limit },
        null,
        2,
      ),
    );
    dump("opencode-model-list-decoded-entry.json", decodedEntry ?? null);

    // ---- the session ----
    const sessionId = SessionID.create();
    const eventsFile = join(OUT_DIR, "opencode-events.jsonl");
    const sse = readRawEvents({
      baseUrl: server.baseUrl,
      authorization,
      file: eventsFile,
    });
    // The stream is live-only: let the subscription establish before prompting.
    yield* Effect.sleep("1 second");

    const separator = OPENCODE_MODEL.indexOf("/");
    yield* Effect.orDie(
      api.session.create({
        title: "spike-c usage",
        model: {
          providerID: Schema.decodeUnknownSync(ProviderID)(
            OPENCODE_MODEL.slice(0, separator),
          ),
          id: Schema.decodeUnknownSync(ModelID)(
            OPENCODE_MODEL.slice(separator + 1),
          ),
        },
        location: {
          directory: Schema.decodeUnknownSync(AbsolutePath)(workspace),
        },
        id: sessionId as Session.ID,
      }),
    );

    for (const [index, text] of [MULTI_STEP_PROMPT, SECOND_PROMPT].entries()) {
      heading(`opencode — prompt ${index + 1}`);
      yield* Effect.orDie(
        api.session.prompt({ sessionID: sessionId as Session.ID, text }),
      );
      const settled = yield* Effect.result(
        Effect.timeout(
          api.session.wait({ sessionID: sessionId as Session.ID }),
          "4 minutes",
        ),
      );
      line("session.wait", settled._tag);
      // The ephemeral usage event can land just after `wait` answers.
      yield* Effect.sleep("3 seconds");
      const got = yield* rawGet(`/api/session/${sessionId}`);
      dump(`opencode-session-after-prompt-${index + 1}.json`, got);
      const session = got.body as { cost?: unknown; tokens?: unknown };
      line("GET session status", got.status);
      line(
        "session.cost / session.tokens",
        JSON.stringify({ cost: session.cost, tokens: session.tokens }),
      );
    }

    const messages = yield* rawGet(`/api/session/${sessionId}/message`);
    dump("opencode-messages.json", messages);
    const frames = yield* Effect.promise(() => sse.stop());

    heading("opencode — frames carrying figures, in arrival order");
    const mine = (frames as { at?: number; frame?: unknown }[]).filter(
      (entry) => sessionOfFrame(entry.frame) === sessionId,
    );
    line("frames for this session", mine.length);
    const types: Record<string, number> = {};
    for (const entry of mine) {
      const type = String((entry.frame as { type?: unknown }).type);
      types[type] = (types[type] ?? 0) + 1;
    }
    console.log(JSON.stringify(types, null, 2));
    for (const entry of mine) {
      const paths = carriesFigures(
        (entry.frame as { data?: unknown }).data,
        "data",
      );
      if (paths.length === 0) continue;
      const type = String((entry.frame as { type?: unknown }).type);
      console.log(`  ${String(entry.at).padStart(7)}ms ${type}`);
      console.log(`      carries: ${paths.join(", ")}`);
      console.log(`      ${JSON.stringify(entry.frame)}`);
    }

    // The assistant messages' own token fields, raw.
    heading("opencode — message list, raw token fields");
    const list = ((messages.body as { data?: unknown[] } | undefined)?.data ??
      []) as unknown[];
    line("messages", list.length);
    for (const message of list) {
      const paths = carriesFigures(message);
      if (paths.length === 0) continue;
      const record = message as { id?: unknown; type?: unknown };
      console.log(
        `  ${String(record.type)} ${String(record.id)} carries: ${paths.join(", ")}`,
      );
    }

    return {
      driver: "opencode",
      status: "MEASURED" as const,
      detail: `${mine.length} frames for the session; see ${OUT_DIR}`,
    } satisfies LegResult;
  });

  const attempt = yield* Effect.result(
    Effect.scoped(
      run.pipe(
        Effect.provide(
          OpenCodeServer.layer({ cwd: workspace }).pipe(
            Layer.provide(FetchHttpClient.layer),
          ),
        ),
        Effect.provide(FetchHttpClient.layer),
      ),
    ),
  );
  if (attempt._tag === "Failure") {
    heading("opencode — not measured");
    line("why", String(attempt.failure));
    return {
      driver: "opencode",
      status: "UNTESTED" as const,
      detail: String(attempt.failure),
    } satisfies LegResult;
  }
  return attempt.success;
});

/* ------------------------------------------------------------- claude code */

/**
 * Whether the query streams partial messages. Production's `claudeCodeClient.ts` does not
 * set `includePartialMessages`, so `--partials=off` reproduces what bit actually sees; the
 * default (on) is what exposes `message_delta`, the only frame that carries a step's final
 * `output_tokens`.
 */
const PARTIALS = !process.argv.includes("--partials=off");
const SUFFIX = PARTIALS ? "" : "-nopartials";

const claudeCodeMeasure = async (workspace: string): Promise<string> => {
  const file = join(OUT_DIR, `claude-messages${SUFFIX}.jsonl`);
  writeFileSync(file, "");

  const pending: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  const sessionId = crypto.randomUUID();
  const send = (text: string): void => {
    pending.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid: crypto.randomUUID(),
    } as SDKUserMessage);
    wake?.();
  };
  const input$ = async function* (): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (pending.length > 0) {
        const next = pending.shift();
        if (next !== undefined) yield next;
      }
      if (done) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = undefined;
    }
  };

  send(MULTI_STEP_PROMPT);
  const live = sdkQuery({
    prompt: input$(),
    options: {
      cwd: workspace,
      model: CLAUDE_CODE_DEFAULT_MODEL,
      sessionId,
      settingSources: [],
      allowedTools: ["Read"],
      permissionMode: "dontAsk",
      includePartialMessages: PARTIALS,
      stderr: () => undefined,
    },
  });

  const startedAt = Date.now();
  let results = 0;
  let sentSecond = false;
  const order: string[] = [];
  const iterator = (live as AsyncIterable<SDKMessage>)[Symbol.asyncIterator]();
  heading("claude code — frames carrying figures, in arrival order");
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = await Promise.race([
      iterator.next(),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), 240_000);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (next === "timeout" || next.done === true) break;
    const message = next.value;
    const at = Date.now() - startedAt;
    appendFileSync(file, `${JSON.stringify({ at, message })}\n`);
    const record = message as unknown as {
      type: string;
      subtype?: string;
      event?: { type?: string };
    };
    const label =
      record.type === "stream_event"
        ? `stream_event/${record.event?.type ?? "?"}`
        : record.subtype === undefined
          ? record.type
          : `${record.type}/${record.subtype}`;
    order.push(label);
    if (message.type === "system" && record.subtype === "init") {
      // Before any API response exists: is a limit reachable yet?
      try {
        const early = await live.getContextUsage({ detail: "summary" });
        console.log(
          `  getContextUsage(summary) at system/init: ` +
            JSON.stringify({
              totalTokens: early.totalTokens,
              maxTokens: early.maxTokens,
              model: early.model,
              apiUsage: (early as { apiUsage?: unknown }).apiUsage,
            }),
        );
      } catch (error) {
        console.log(`  getContextUsage at init failed: ${String(error)}`);
      }
    }
    // Partial deltas carry no figures; only show frames that do, and which paths.
    const paths = carriesFigures(message);
    if (paths.length > 0 && label !== "stream_event/content_block_delta") {
      console.log(`  ${String(at).padStart(7)}ms ${label}`);
      console.log(`      carries: ${paths.join(", ")}`);
      console.log(`      ${JSON.stringify(message)}`);
    }
    if (message.type === "result") {
      results += 1;
      // Asked while the query is idle between turns, as production would.
      try {
        const context = await live.getContextUsage({ detail: "summary" });
        dump(
          `claude-context-usage-after-turn-${results}${SUFFIX}.json`,
          context,
        );
        console.log(
          `  getContextUsage(summary) after turn ${results}: ` +
            JSON.stringify({
              totalTokens: context.totalTokens,
              maxTokens: context.maxTokens,
              rawMaxTokens: context.rawMaxTokens,
              percentage: context.percentage,
              model: context.model,
            }),
        );
      } catch (error) {
        console.log(`  getContextUsage failed: ${String(error)}`);
      }
      if (results === 1 && !sentSecond) {
        sentSecond = true;
        send(SECOND_PROMPT);
      } else {
        break;
      }
    }
  }
  try {
    dump(`claude-supported-models${SUFFIX}.json`, await live.supportedModels());
  } catch (error) {
    console.log(`supportedModels failed: ${String(error)}`);
  }
  done = true;
  wake?.();
  (live as { close?: () => void }).close?.();
  dump(`claude-message-order${SUFFIX}.json`, order);
  return `${results} result(s); ${order.length} messages; see ${OUT_DIR}`;
};

const claudeCodeLeg = Effect.fnUntraced(function* () {
  const workspace = join(RUNTIME_DIR, "usage-probe-claude-code");
  yield* Effect.sync(() => {
    mkdirSync(workspace, { recursive: true });
  });
  yield* Effect.forEach(Object.entries(NOTES), ([name, content]) =>
    Effect.promise(() => Bun.write(join(workspace, name), content)),
  );
  heading("claude code — query");
  line("model", CLAUDE_CODE_DEFAULT_MODEL);
  const attempt = yield* Effect.result(
    Effect.tryPromise({
      try: () => claudeCodeMeasure(workspace),
      catch: (error) => error,
    }),
  );
  if (attempt._tag === "Failure") {
    heading("claude code — not measured");
    line("why", String(attempt.failure));
    return {
      driver: "claude-code",
      status: "UNTESTED" as const,
      detail: String(attempt.failure),
    } satisfies LegResult;
  }
  return {
    driver: "claude-code",
    status: "MEASURED" as const,
    detail: attempt.success,
  } satisfies LegResult;
});

/* ------------------------------------------------------------------- entry */

const WANTED = (() => {
  const flag = process.argv.find((argument) =>
    argument.startsWith("--driver="),
  );
  const value = flag?.slice("--driver=".length) ?? "all";
  return {
    openCode: value === "all" || value === "opencode",
    claudeCode: value === "all" || value === "claude-code",
  };
})();

const program = Effect.gen(function* () {
  mkdirSync(OUT_DIR, { recursive: true });
  heading("spike C — usage and context limits");
  const results: LegResult[] = [];
  if (WANTED.openCode) results.push(yield* openCodeLeg());
  if (WANTED.claudeCode) results.push(yield* claudeCodeLeg());
  heading("verdicts");
  for (const result of results) {
    console.log(`  ${result.driver.padEnd(14)} ${result.status}`);
    console.log(`      ${result.detail}`);
  }
});

runMain(program);
