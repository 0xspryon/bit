/**
 * Spike E: can two Pi sessions in one folder each hold their own bit MCP tools, with
 * neither able to reach the other's?
 *
 * ```sh
 * cd apps/server
 * bun run src/spike/piMcpIsolationProof.ts 2>&1 | tee .runtime/pi-mcp-isolation.log
 * ```
 *
 * The operator's requirement (2026-11-10): two bit MCP servers registered per session
 * through an extension, and each session cannot access the other's tools.
 *
 * **What is evidence.** As in `mcpIsolationProof.ts`, nothing a model says is a finding:
 *
 * 1. **A recording proxy** in front of bit's real endpoints notes which bearer each request
 *    carried, the JSON-RPC method and tool, and the status bit answered.
 * 2. **The tool list each session offered the model**, read from the requests Pi sent to a
 *    scripted model this spike serves. The model is scripted so every tool call is decided
 *    here, not by a model's judgement: `SCRIPT:[…]` in a message is the list of calls the
 *    "model" makes in reply.
 * 3. **The store**: an observation's provenance names the attempt whose credential wrote it.
 *
 * Part 1 points Pi's built-in MCP client (`pi.registerMcpServer`) at bit, to record what
 * happens. Part 2 runs two sessions with `piBitTools.extension.ts`, which speaks bit's
 * stateless revision itself: session A holds a worker attempt's credential, session B a
 * scope import's, both processes live at once in the same folder.
 *
 * Credentials are real (`McpCredentials.issue` / `issueImport`, `seedAttempt`); the Pi
 * processes are real `pi --mode rpc`; only the model is scripted.
 *
 * **Nothing may import this module.** `runMain` is called at module scope.
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { Effect, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";

import { ControlPlaneEndpoint } from "../http/controlPlane";
import { McpCredentials } from "../mcp/credentials";
import { McpCallCounter } from "../mcp/server";
import { multiCaseWireArgs } from "../persistence/fixtures";
import { ObservationStore } from "../persistence/store";
import { TargetStores } from "../persistence/targetStores";
import { runMain } from "./main";
import { RUNTIME_DIR } from "./runtime";

const TARGET_ID = "pi-isolation-target";
const ROOT = join(
  RUNTIME_DIR,
  "pi-mcp-isolation",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
const SHARED = join(ROOT, "shared");
const AGENT_DIR = join(ROOT, "pi-agent");
const BIT_TOOLS_EXTENSION = join(import.meta.dir, "piBitTools.extension.ts");
const BUILTIN_EXTENSION = join(import.meta.dir, "piBuiltinMcp.extension.ts");

const line = (label: string, value: unknown) =>
  console.log(
    `${label.padEnd(40)} ${typeof value === "string" ? value : JSON.stringify(value)}`,
  );
const heading = (text: string) => console.log(`\n=== ${text} ===`);

// --------------------------------------------------------------------------------------
// The recording proxy: `<proxy>/<route>` forwards to the route's real endpoint.
// --------------------------------------------------------------------------------------

interface LedgerEntry {
  readonly route: string;
  readonly token: string;
  readonly rpc: string;
  readonly tool: string | undefined;
  readonly status: number;
}

const bearerOf = (header: string | null): string =>
  header !== null && header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";

const startProxy = (
  upstreams: Map<string, string>,
  labels: Map<string, string>,
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const entries: LedgerEntry[] = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 120,
        fetch: async (request) => {
          const route = new URL(request.url).pathname.split("/")[1] ?? "";
          const upstream = upstreams.get(route);
          const text = await request.text();
          let rpc = request.headers.get("mcp-method") ?? request.method;
          let tool: string | undefined;
          try {
            const parsed = JSON.parse(text) as {
              method?: string;
              params?: { name?: string };
            };
            rpc = parsed.method ?? rpc;
            tool = parsed.params?.name;
          } catch {
            // Not JSON: recorded under the header's method alone.
          }
          const raw = bearerOf(request.headers.get("authorization"));
          const token = raw === "" ? "none" : (labels.get(raw) ?? "unknown");
          if (upstream === undefined) {
            entries.push({ route, token, rpc, tool, status: 404 });
            return new Response("no such route", { status: 404 });
          }
          const headers = new Headers(request.headers);
          headers.delete("host");
          headers.delete("content-length");
          const answer = await fetch(upstream, {
            method: request.method,
            headers,
            ...(text === "" || request.method === "GET" ? {} : { body: text }),
          });
          entries.push({ route, token, rpc, tool, status: answer.status });
          const out = new Headers(answer.headers);
          out.delete("content-encoding");
          out.delete("content-length");
          return new Response(answer.body, {
            status: answer.status,
            headers: out,
          });
        },
      });
      return {
        entries,
        url: `http://127.0.0.1:${String(server.port)}`,
        server,
      };
    }),
    (proxy) => Effect.promise(() => proxy.server.stop(true)),
  );

// --------------------------------------------------------------------------------------
// The scripted model: OpenAI chat completions, decided by `SCRIPT:[…]` in the last message.
// --------------------------------------------------------------------------------------

type Step =
  { readonly tool: string; readonly args: unknown } | { readonly text: string };

interface ModelRequest {
  readonly label: string;
  readonly tools: readonly string[];
  readonly scripted: boolean;
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part) => (typeof part?.text === "string" ? part.text : ""))
          .join("")
      : "";

const startModel = () =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const requests: ModelRequest[] = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 120,
        fetch: async (request) => {
          const label = new URL(request.url).pathname.split("/")[1] ?? "";
          if (request.method === "GET")
            return Response.json({
              object: "list",
              data: [{ id: "fake-1", object: "model" }],
            });
          const body = (await request.json()) as {
            messages?: { role: string; content: unknown }[];
            tools?: { function?: { name?: string } }[];
            stream?: boolean;
          };
          const messages = body.messages ?? [];
          let start = -1;
          for (let index = messages.length - 1; index >= 0; index--) {
            const message = messages[index];
            if (
              message?.role === "user" &&
              textOf(message.content).includes("SCRIPT:")
            ) {
              start = index;
              break;
            }
          }
          let action: Step = { text: "ok" };
          if (start >= 0) {
            const raw =
              textOf(messages[start]?.content)
                .split("SCRIPT:")[1]
                ?.split("\n")[0] ?? "[]";
            const script = JSON.parse(raw) as Step[];
            const step = messages
              .slice(start + 1)
              .filter((message) => message.role === "assistant").length;
            action = script[step] ?? { text: "done" };
          }
          requests.push({
            label,
            tools: (body.tools ?? []).map((tool) => tool.function?.name ?? "?"),
            scripted: start >= 0,
          });
          const id = `chatcmpl-${String(Date.now())}`;
          const delta =
            "tool" in action
              ? {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_${id}`,
                      type: "function",
                      function: {
                        name: action.tool,
                        arguments: JSON.stringify(action.args),
                      },
                    },
                  ],
                }
              : { role: "assistant", content: action.text };
          const finish = "tool" in action ? "tool_calls" : "stop";
          const usage = {
            prompt_tokens: 100,
            completion_tokens: 10,
            total_tokens: 110,
          };
          const base = {
            id,
            object: "chat.completion.chunk",
            created: 0,
            model: "fake-1",
          };
          const frames = [
            { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
            {
              ...base,
              choices: [{ index: 0, delta: {}, finish_reason: finish }],
            },
            { ...base, choices: [], usage },
          ];
          const stream =
            frames
              .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
              .join("") + "data: [DONE]\n\n";
          return new Response(stream, {
            headers: { "content-type": "text/event-stream" },
          });
        },
      });
      return {
        requests,
        url: `http://127.0.0.1:${String(server.port)}`,
        server,
      };
    }),
    (model) => Effect.promise(() => model.server.stop(true)),
  );

// --------------------------------------------------------------------------------------
// A Pi session over RPC.
// --------------------------------------------------------------------------------------

interface PiSession {
  readonly name: string;
  readonly prompt: (steps: readonly Step[]) => Promise<readonly string[]>;
  readonly stop: () => void;
}

const startPi = (
  name: string,
  extension: string,
  env: Record<string, string>,
): PiSession => {
  const child = Bun.spawn(
    [
      "pi",
      "--mode",
      "rpc",
      "--no-session",
      "--no-context-files",
      "--model",
      `fake/${name}`,
      "-e",
      extension,
    ],
    {
      cwd: SHARED,
      env: { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR, ...env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const waiting: ((event: Record<string, unknown>) => void)[] = [];
  const decoder = new TextDecoder();
  void (async () => {
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const text = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        try {
          const event = JSON.parse(text) as Record<string, unknown>;
          for (const listener of waiting) listener(event);
        } catch {
          // Not a frame.
        }
      }
    }
  })();
  const prompt = (steps: readonly Step[]) =>
    new Promise<readonly string[]>((resolve) => {
      const seen: string[] = [];
      const timer = setTimeout(() => {
        waiting.splice(waiting.indexOf(listener), 1);
        resolve([...seen, "TIMEOUT"]);
      }, 60_000);
      const listener = (event: Record<string, unknown>) => {
        if (event.type === "tool_execution_end") {
          const result = JSON.stringify(event.result ?? null).slice(0, 220);
          seen.push(
            `${String(event.toolName)} ${event.isError === true ? "ERROR" : "ok"}: ${result}`,
          );
        }
        if (event.type === "response" && event.success === false)
          seen.push(`refused: ${JSON.stringify(event).slice(0, 200)}`);
        if (event.type === "agent_settled") {
          clearTimeout(timer);
          waiting.splice(waiting.indexOf(listener), 1);
          resolve(seen);
        }
      };
      waiting.push(listener);
      child.stdin.write(
        `${JSON.stringify({ type: "prompt", message: `Scenario. SCRIPT:${JSON.stringify(steps)}` })}\n`,
      );
      void child.stdin.flush();
    });
  return { name, prompt, stop: () => child.kill("SIGTERM") };
};

const writeAgentDir = (modelUrl: string) => {
  mkdirSync(AGENT_DIR, { recursive: true });
  mkdirSync(SHARED, { recursive: true });
  const provider = (label: string) => ({
    baseUrl: `${modelUrl}/${label}/v1`,
    api: "openai-completions",
    apiKey: "fake",
    models: [
      {
        id: label,
        name: label,
        contextWindow: 200_000,
        maxTokens: 8_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  writeFileSync(
    join(AGENT_DIR, "models.json"),
    JSON.stringify(
      {
        providers: {
          fake: {
            ...provider("A"),
            models: ["A", "B", "C"].map((label) => ({
              ...provider(label).models[0],
              id: label,
              name: label,
              baseUrl: `${modelUrl}/${label}/v1`,
            })),
          },
        },
      },
      null,
      1,
    ),
  );
};

/** Files under `dir` holding any raw token, for "did a credential land on disk". */
const scanForTokens = (tokens: readonly string[], dir: string): string[] => {
  const hits: string[] = [];
  const walk = (path: string) => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (stat.size < 20_000_000) {
        const text = readFileSync(full, "utf8");
        if (tokens.some((token) => text.includes(token))) hits.push(full);
      }
    }
  };
  walk(dir);
  return hits;
};

// --------------------------------------------------------------------------------------
// The run.
// --------------------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const store = yield* ObservationStore;
  const credentials = yield* McpCredentials;
  const control = yield* ControlPlaneEndpoint;

  const labels = new Map<string, string>();
  const upstreams = new Map<string, string>([
    ["worker-a", control.mcpUrl],
    ["importer-b", control.importerMcpUrl],
    ["builtin-c", control.mcpUrl],
  ]);
  const proxy = yield* startProxy(upstreams, labels);
  const model = yield* startModel();
  writeAgentDir(model.url);

  const attempt = (label: string) =>
    Effect.gen(function* () {
      const attemptId = `attempt-pi-${label}`;
      const authority = yield* store.seedAttempt({
        targetId: TARGET_ID,
        goalId: "goal-pi-isolation",
        goal: "Spike E: Pi session isolation.",
        intentId: `intent-pi-${label}`,
        question: `Which credential does ${label} present?`,
        attemptId,
        workerId: `worker-${label}`,
        harnessInstanceId: "pi",
        providerId: "spike",
        modelId: label,
        modelOptions: null,
        harnessSessionId: `pi-${label}`,
      });
      const credential = yield* credentials.issue({
        _tag: "attempt",
        targetId: TARGET_ID,
        intentId: `intent-pi-${label}`,
        attemptId,
        harnessSessionId: `pi-${label}`,
        workerId: `worker-${label}`,
        attemptFence: authority.writeFence,
      });
      labels.set(Redacted.value(credential.token), label);
      return Redacted.value(credential.token);
    });

  const tokenA = yield* attempt("a");
  const tokenC = yield* attempt("c");
  const importer = yield* credentials.issueImport({
    _tag: "importer",
    targetId: TARGET_ID,
    importId: "import-pi-b",
  });
  const tokenB = Redacted.value(importer.token);
  labels.set(tokenB, "b");

  const mark = () => proxy.entries.length;
  const show = (from: number) => {
    const counted = new Map<string, number>();
    for (const entry of proxy.entries.slice(from)) {
      const key = `${entry.route} token=${entry.token} ${entry.rpc}${entry.tool === undefined ? "" : `:${entry.tool}`} -> ${String(entry.status)}`;
      counted.set(key, (counted.get(key) ?? 0) + 1);
    }
    for (const [key, count] of counted)
      console.log(`    ${String(count)}x ${key}`);
  };
  const offered = (label: string) =>
    [
      ...new Set(
        model.requests
          .filter((request) => request.label === label)
          .flatMap((request) => request.tools),
      ),
    ].sort();

  heading("Part 1: Pi's built-in MCP client against bit (session C)");
  let from = mark();
  const c = startPi("C", BUILTIN_EXTENSION, {
    BIT_MCP_URL: `${proxy.url}/builtin-c`,
    BIT_MCP_TOKEN: tokenC,
    BIT_MCP_SERVER: "bit-c",
  });
  yield* Effect.sleep("6 seconds");
  const cSaid = yield* Effect.promise(() =>
    c.prompt([
      {
        tool: "mcp__bit_c__record_observation",
        args: multiCaseWireArgs({ operation_id: "op-c" }),
      },
    ]),
  );
  line("tools offered to C's model", offered("C"));
  line("C's calls", cSaid);
  console.log("  ledger (C):");
  show(from);
  c.stop();

  heading(
    "Part 2: bit's tools as native Pi tools, sessions A (worker) and B (importer) live together",
  );
  from = mark();
  const a = startPi("A", BIT_TOOLS_EXTENSION, {
    BIT_MCP_URL: `${proxy.url}/worker-a`,
    BIT_MCP_TOKEN: tokenA,
  });
  const b = startPi("B", BIT_TOOLS_EXTENSION, {
    BIT_MCP_URL: `${proxy.url}/importer-b`,
    BIT_MCP_TOKEN: tokenB,
  });
  yield* Effect.sleep("6 seconds");

  const aOwn = yield* Effect.promise(() =>
    a.prompt([
      {
        tool: "bit_record_observation",
        args: multiCaseWireArgs({ operation_id: "op-a" }),
      },
    ]),
  );
  const bOwn = yield* Effect.promise(() =>
    b.prompt([{ tool: "bit_read_scope", args: {} }]),
  );
  const aCross = yield* Effect.promise(() =>
    a.prompt([{ tool: "bit_read_scope", args: {} }]),
  );
  const bCross = yield* Effect.promise(() =>
    b.prompt([
      {
        tool: "bit_record_observation",
        args: multiCaseWireArgs({ operation_id: "op-b" }),
      },
    ]),
  );
  const aShell = yield* Effect.promise(() =>
    a.prompt([
      {
        tool: "bash",
        args: { command: "env | grep -c '^BIT_MCP_TOKEN=' || true" },
      },
    ]),
  );
  line("tools offered to A's model", offered("A"));
  line("tools offered to B's model", offered("B"));
  line("A calls its own tool", aOwn);
  line("B calls its own tool", bOwn);
  line("A calls B's tool (bit_read_scope)", aCross);
  line("B calls A's tool (bit_record_observation)", bCross);
  line("A's shell: BIT_MCP_TOKEN lines in env", aShell);
  console.log("  ledger (A and B):");
  show(from);
  line(
    "observations stored for intent a",
    (yield* store.observationsForIntent("intent-pi-a")).map(
      (o) => o.provenance.attemptId,
    ),
  );
  a.stop();
  b.stop();
  yield* Effect.sleep("1 second");

  heading("Credentials on disk");
  line(
    "files under the spike folder holding a token",
    scanForTokens([tokenA, tokenB, tokenC], ROOT),
  );
  line("spike folder", ROOT);
});

const store = ObservationStore.layer(join(ROOT, "hunt.sqlite"));
const resolver = TargetStores.ofStore(TARGET_ID).pipe(Layer.provide(store));
const endpoint = ControlPlaneEndpoint.layer({}).pipe(
  Layer.provideMerge(McpCredentials.layer),
  Layer.provideMerge(McpCallCounter.layer),
  Layer.provide(resolver),
);

mkdirSync(ROOT, { recursive: true });
runMain(
  Effect.scoped(program).pipe(
    Effect.provide(Layer.mergeAll(store, endpoint)),
    Effect.provide(FetchHttpClient.layer),
  ),
);
