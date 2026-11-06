/**
 * Spike B: is a directory an authority boundary for an MCP registration?
 *
 * ```sh
 * cd apps/server
 * bun run src/spike/mcpIsolationProof.ts opencode 2>&1 | tee .runtime/mcp-isolation-opencode.log
 * bun run src/spike/mcpIsolationProof.ts claude   2>&1 | tee .runtime/mcp-isolation-claude.log
 * ```
 *
 * `docs/design/goal-and-planner-flow.md` decision 5 builds a three-directory layout on the
 * claim that, under OpenCode, an MCP registration belongs to a *directory* and so is
 * visible to every session in it. Until now that claim came from a comment on
 * `AgentHarness.registerMcpServer`. This measures it.
 *
 * **What is evidence and what is not.** A model's account of what it can see is never the
 * finding. The findings are read from three places the model cannot write to:
 *
 * 1. **A recording proxy in front of the MCP endpoint.** Every registration is pointed at
 *    `<proxy>/<server name>`, and the proxy notes which bearer each request carried, which
 *    JSON-RPC method it was and what the endpoint answered. So "which token did the
 *    harness present under this name" is a recorded fact and not an inference.
 * 2. **The store.** `record_observation` derives provenance from the credential, so an
 *    observation's `attemptId` says whose credential was presented, whichever session's
 *    model made the call.
 * 3. **The harness's own registry** (`api.mcp.list`, OpenCode only), asked per directory.
 *
 * **The credential shape is the real one.** Real `McpCredentials.issue`, real
 * `seedAttempt`, real `registerMcpServer` on the real driver (a real policy gate was
 * installed in every directory until it was removed, 2026-11-06). Nothing is simulated; a driver that cannot start here is reported
 * UNTESTED by its own startup failure and not stood in for.
 *
 * **Nothing may import this module.** `runMain` is called at module scope, as in every
 * other entrypoint in this directory.
 */
import {
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { OpenCode } from "@opencode/client/effect";
import { Effect, Fiber, Layer, Redacted, Result, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import {
  AgentHarness,
  finalAssistantText,
  firstError,
} from "../harness/agentHarness";
import { claudeCodeHarness } from "../harness/claudeCodeClient";
import { openCodeHarness } from "../harness/openCodeClient";
import { OpenCodeServer } from "../harness/openCodeServer";
import { ControlPlaneEndpoint } from "../http/controlPlane";
import { McpCredentials, type IssuedCredential } from "../mcp/credentials";
import { McpCallCounter } from "../mcp/server";
import { multiCaseWireArgs } from "../persistence/fixtures";
import { ObservationStore } from "../persistence/store";
import { TargetStores } from "../persistence/targetStores";
import { runMain } from "./main";
import { RUNTIME_DIR } from "./runtime";

const TARGET_ID = "isolation-target";
const GOAL_ID = "goal-isolation";
const ROOT = join(RUNTIME_DIR, "mcp-isolation");

type Driver = "opencode" | "claude";

// --------------------------------------------------------------------------------------
// The recording proxy.
// --------------------------------------------------------------------------------------

interface LedgerEntry {
  /** The registered server name, i.e. the first path segment the harness was given. */
  readonly route: string;
  /** Label of the credential the request carried, or `none` / `unknown`. */
  readonly token: string;
  readonly rpc: string;
  readonly tool: string | undefined;
  readonly status: number;
}

const bearerOf = (header: string | null): string =>
  header !== null && header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";

/**
 * Forwards to the real endpoint and notes what passed.
 *
 * `labels` maps a raw token to the name it is reported under. It is filled in as
 * credentials are issued, which is why it is a mutable map handed in and not a constant.
 */
const startProxy = (upstream: string, labels: Map<string, string>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const entries: LedgerEntry[] = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 120,
        fetch: async (request) => {
          const route = new URL(request.url).pathname.split("/")[1] ?? "";
          const text = await request.text();
          let rpc = request.headers.get("mcp-method") ?? "?";
          let tool: string | undefined;
          try {
            const parsed: unknown = JSON.parse(text);
            const first = (Array.isArray(parsed) ? parsed[0] : parsed) as {
              method?: string;
              params?: { name?: string };
            };
            rpc = first?.method ?? rpc;
            tool = first?.params?.name;
          } catch {
            // A body that is not JSON is recorded under the header's method alone.
          }
          const raw = bearerOf(request.headers.get("authorization"));
          const label = raw === "" ? "none" : (labels.get(raw) ?? "unknown");
          const headers = new Headers(request.headers);
          headers.delete("host");
          headers.delete("content-length");
          const answer = await fetch(upstream, {
            method: request.method,
            headers,
            ...(text === "" || request.method === "GET" ? {} : { body: text }),
          });
          entries.push({
            route,
            token: label,
            rpc,
            tool,
            status: answer.status,
          });
          const out = new Headers(answer.headers);
          out.delete("content-encoding");
          out.delete("content-length");
          return new Response(answer.body, {
            status: answer.status,
            headers: out,
          });
        },
      });
      return { entries, url: `http://127.0.0.1:${server.port}`, server };
    }),
    (proxy) => Effect.promise(() => proxy.server.stop(true)),
  );

// --------------------------------------------------------------------------------------
// The kit both drivers share.
// --------------------------------------------------------------------------------------

const line = (label: string, value: unknown) =>
  console.log(
    `${label.padEnd(34)} ${typeof value === "string" ? value : JSON.stringify(value)}`,
  );

const heading = (text: string) => console.log(`\n=== ${text} ===`);

const prompt = (server: string, operationId: string) =>
  [
    `This is a plumbing test of tool reachability. Do not run shell commands. Do not call`,
    `any tool other than the one described below.`,
    ``,
    `Attempt to call the \`record_observation\` tool of the MCP server named "${server}".`,
    `MCP tools may be exposed to you directly or through another mechanism, for example`,
    `namespaced under the server's name; use whatever your environment provides. Pass`,
    `exactly this JSON as the arguments:`,
    ``,
    JSON.stringify(multiCaseWireArgs({ operation_id: operationId })),
    ``,
    `If you cannot find or reach that server's tool, do NOT call any other server's tool.`,
    `Report the exact error text instead.`,
    ``,
    `Finish with exactly two lines:`,
    `CALL: <the tool's returned text verbatim, or NOT CALLED>`,
    `REASON: <one line: what you did, or the exact error or why you could not>`,
  ].join("\n");

const makeKit = (_driver: Driver) =>
  Effect.gen(function* () {
    const store = yield* ObservationStore;
    const harness = yield* AgentHarness;
    const credentials = yield* McpCredentials;
    const control = yield* ControlPlaneEndpoint;

    const labels = new Map<string, string>();
    const proxy = yield* startProxy(control.mcpUrl, labels);

    const model = harness.instance.defaultModel;

    const prepare = (directory: string) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => mkdirSync(directory, { recursive: true }));
      });

    const open = (directory: string, name: string) =>
      harness.createSession({ title: `spike B ${name}`, model, directory });

    /** A seeded attempt plus a credential for it, labelled for the ledger. */
    const credentialFor = (label: string, sessionId: string) =>
      Effect.gen(function* () {
        const attemptId = `attempt-iso-${label}`;
        const authority = yield* store.seedAttempt({
          targetId: TARGET_ID,
          goalId: GOAL_ID,
          goal: "Spike B: directory as an authority boundary.",
          intentId: `intent-iso-${label}`,
          question: `Which credential does ${label} present?`,
          attemptId,
          workerId: `worker-${label}`,
          harnessInstanceId: harness.instance.instanceId,
          providerId: "spike",
          modelId: model,
          modelOptions: null,
          harnessSessionId: sessionId,
        });
        const credential = yield* credentials.issue({
          _tag: "attempt",
          targetId: TARGET_ID,
          intentId: `intent-iso-${label}`,
          attemptId,
          harnessSessionId: sessionId,
          workerId: `worker-${label}`,
          attemptFence: authority.writeFence,
        });
        labels.set(Redacted.value(credential.token), label);
        return credential;
      });

    const register = (
      sessionId: string,
      name: string,
      credential: IssuedCredential,
      directory: string,
    ) =>
      harness.registerMcpServer(sessionId, name, {
        url: `${proxy.url}/${name}`,
        headers: {
          authorization: Redacted.make(
            `Bearer ${Redacted.value(credential.token)}`,
          ),
        },
        directory,
      });

    /** Prompts, waits, and reports what the harness and the model said. */
    const ask = (sessionId: string, text: string) =>
      Effect.gen(function* () {
        // The narration is collected as a second account of what the session said and
        // did: Claude Code's stored transcript does not always carry the final reply
        // text, and a finding that depended on it would depend on a retention detail.
        const heard: string[] = [];
        const listener = yield* Effect.forkChild(
          Stream.runForEach(harness.sessionEvents(sessionId), (entry) =>
            Effect.sync(() => {
              const detail = entry.detail;
              if (detail._tag === "reply") heard.push(`reply: ${detail.text}`);
              if (detail._tag === "toolCall")
                heard.push(
                  `call ${detail.tool ?? "?"}: ${detail.input.slice(0, 120)}`,
                );
              if (detail._tag === "toolResult")
                heard.push(
                  `result ${detail.tool ?? "?"}${detail.failed ? " FAILED" : ""}: ${detail.output.slice(0, 200)}`,
                );
            }),
          ).pipe(Effect.ignore),
        );
        yield* harness.prompt(sessionId, text);
        const waited = yield* Effect.result(
          harness.waitForIdle(sessionId).pipe(Effect.timeout("6 minutes")),
        );
        yield* Effect.sleep("500 millis");
        yield* Fiber.interrupt(listener);
        const status = yield* harness.sessionStatus(sessionId);
        const entries = yield* harness.messages(sessionId);
        const stored = finalAssistantText(entries).trim();
        return {
          waitFailed: Result.isFailure(waited),
          outcome: status.outcome ?? "unknown",
          final: stored !== "" ? stored : heard.join("\n"),
          error: firstError(entries),
        };
      });

    const observationsBy = (label: string) =>
      store.observationsForIntent(`intent-iso-${label}`).pipe(
        Effect.map((all) =>
          all.map((observation) => ({
            id: observation.observationId,
            attemptId: observation.provenance.attemptId,
            harnessSessionId: observation.provenance.harnessSessionId,
          })),
        ),
      );

    /** Ledger entries after a mark, so each step reports only its own traffic. */
    const since = (mark: number) => proxy.entries.slice(mark);
    const mark = () => proxy.entries.length;

    const show = (title: string, entries: readonly LedgerEntry[]) => {
      console.log(`  ledger: ${title} (${entries.length} requests)`);
      const counted = new Map<string, number>();
      for (const entry of entries) {
        const key = `${entry.route} token=${entry.token} ${entry.rpc}${entry.tool === undefined ? "" : `:${entry.tool}`} -> ${String(entry.status)}`;
        counted.set(key, (counted.get(key) ?? 0) + 1);
      }
      for (const [key, count] of counted)
        console.log(`    ${String(count)}x ${key}`);
    };

    return {
      store,
      harness,
      credentials,
      control,
      labels,
      proxy,
      prepare,
      open,
      credentialFor,
      register,
      ask,
      observationsBy,
      since,
      mark,
      show,
    };
  });

/**
 * Looks for raw tokens in files this run could have caused to be written.
 *
 * Bounded by modification time rather than by path, so it covers the harness's own data
 * directories without reading a user's whole history: only files touched since the run
 * began are opened. A registration that a harness persists in clear is the thing being
 * looked for, and a credential on disk is the opposite of "memory only".
 */
const scanForTokens = (
  tokens: ReadonlyMap<string, string>,
  roots: readonly string[],
  sinceMs: number,
) => {
  const hits: string[] = [];
  let scanned = 0;
  const walk = (path: string) => {
    let info;
    try {
      info = statSync(path);
    } catch {
      return;
    }
    if (info.isDirectory()) {
      let children: string[];
      try {
        children = readdirSync(path);
      } catch {
        return;
      }
      for (const child of children) {
        if (child === "node_modules") continue;
        walk(join(path, child));
      }
      return;
    }
    if (info.mtimeMs < sinceMs || info.size > 512 * 1024 * 1024) return;
    scanned += 1;
    let content: Buffer;
    try {
      content = readFileSync(path);
    } catch {
      return;
    }
    for (const [token, label] of tokens) {
      if (content.includes(token)) hits.push(`${label} in ${path}`);
    }
  };
  for (const root of roots) walk(root);
  return { scanned, hits };
};

// --------------------------------------------------------------------------------------
// OpenCode.
// --------------------------------------------------------------------------------------

const openCodeProgram = Effect.gen(function* () {
  const kit = yield* makeKit("opencode");
  const { server, diagnostics } = yield* OpenCodeServer;
  const startedAt = Date.now() - 1000;

  // A second view of the same server, for the one question the harness seam cannot ask:
  // what does this *directory* have registered. Built the way `openCodeClient.ts` builds
  // its own, because a spike that talks to a differently-configured client is measuring
  // the client.
  const http = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest((request) =>
      request.pipe(
        HttpClientRequest.setHeader(
          "authorization",
          Redacted.value(server.authorization),
        ),
        HttpClientRequest.acceptJson,
      ),
    ),
  );
  const api = yield* OpenCode.make({ baseUrl: server.baseUrl }).pipe(
    Effect.provideService(HttpClient.HttpClient, http),
  );
  const listed = (directory: string) =>
    Effect.map(api.mcp.list({ location: { directory } }), (result) =>
      result.data.map(
        (entry) =>
          `${entry.name}[${entry.status.status}${"error" in entry.status ? `: ${entry.status.error}` : ""}]`,
      ),
    ).pipe(Effect.orDie);

  const shared = join(ROOT, "opencode", "shared");
  const other = join(ROOT, "opencode", "other");
  yield* kit.prepare(shared);
  yield* kit.prepare(other);

  heading("setup");
  line("opencode version", server.version);
  line("shared directory", shared);
  line("other directory", other);
  const sa = yield* kit.open(shared, "A");
  const sb = yield* kit.open(shared, "B");
  const sc = yield* kit.open(other, "C");
  line("session A (shared)", sa.id);
  line("session B (shared)", sb.id);
  line("session C (other dir)", sc.id);
  const credA = yield* kit.credentialFor("a", sa.id);
  const credB = yield* kit.credentialFor("b", sb.id);
  line("credential a grant", credA.grant.callerScope);
  line("credential b grant", credB.grant.callerScope);

  heading("Q1a. registry visibility, no model involved");
  line("shared before any registration", yield* listed(shared));
  yield* kit.register(sa.id, "bit-iso-a", credA, shared);
  line("registered bit-iso-a for", "session A only, under credential a");
  line("shared after", yield* listed(shared));
  line("other  after", yield* listed(other));
  yield* kit.register(sb.id, "bit-iso-b", credB, shared);
  line("registered bit-iso-b for", "session B only, under credential b");
  line("shared after both", yield* listed(shared));
  line("other  after both", yield* listed(other));
  kit.show("everything the harness did on its own to connect", kit.since(0));

  // Knobs for the one ordering question the first two runs raised: whether the first
  // prompt after a registration can precede the harness exposing that server's tools.
  const settleMs = Number(process.env["SETTLE_MS"] ?? "0");
  const ownerFirst = process.env["B_FIRST"] !== "1";
  line("settle before first prompt (ms)", settleMs);
  line("owner prompted first", ownerFirst);
  if (settleMs > 0) yield* Effect.sleep(settleMs);

  let mark = kit.mark();
  if (ownerFirst) {
    heading(
      "Q1b0. positive control: session A, the OWNER, calls its own server",
    );
    const aOwn = yield* kit.ask(sa.id, prompt("bit-iso-a", "op-a-calls-a"));
    line("outcome", aOwn.outcome);
    line("harness error", aOwn.error ?? "none");
    console.log(`  model said:\n${aOwn.final.replace(/^/gm, "    ")}`);
    kit.show("traffic", kit.since(mark));
    line("observations under credential a", yield* kit.observationsBy("a"));
  }

  heading(
    "Q1b. session B is asked to call session A's server (same directory)",
  );
  mark = kit.mark();
  const bCallsA = yield* kit.ask(sb.id, prompt("bit-iso-a", "op-b-calls-a"));
  line("outcome", bCallsA.outcome);
  line("wait failed", bCallsA.waitFailed);
  line("harness error", bCallsA.error ?? "none");
  console.log(`  model said:\n${bCallsA.final.replace(/^/gm, "    ")}`);
  kit.show("traffic", kit.since(mark));
  line("observations under credential a", yield* kit.observationsBy("a"));
  line("observations under credential b", yield* kit.observationsBy("b"));

  heading("Q1c. control: a session in a DIFFERENT directory");
  const credC = yield* kit.credentialFor("c", sc.id);
  yield* kit.register(sc.id, "bit-iso-c", credC, other);
  line("registered bit-iso-c for", "session C, in the other directory");
  line("other-dir registry", yield* listed(other));
  mark = kit.mark();
  const cOwnEarly = yield* kit.ask(
    sc.id,
    prompt("bit-iso-c", "op-c-calls-c-1"),
  );
  console.log("  C asked for its OWN server at once, as a worker would be:");
  console.log(`${cOwnEarly.final.replace(/^/gm, "    ")}`);
  kit.show("traffic", kit.since(mark));
  // The registry reports every server in the directory, including the operator's own
  // global ones, which start slowly. Wait until none is pending and say how long it took.
  const waitStart = Date.now();
  let registry = yield* listed(other);
  while (
    registry.some((entry) => entry.includes("[pending]")) &&
    Date.now() - waitStart < 90_000
  ) {
    yield* Effect.sleep("1 second");
    registry = yield* listed(other);
  }
  line("other-dir settled after (ms)", Date.now() - waitStart);
  line("other-dir registry", registry);
  mark = kit.mark();
  const cOwnLate = yield* kit.ask(sc.id, prompt("bit-iso-c", "op-c-calls-c-2"));
  console.log("  C asked for its OWN server again, once the registry settled:");
  console.log(`${cOwnLate.final.replace(/^/gm, "    ")}`);
  kit.show("traffic", kit.since(mark));
  mark = kit.mark();
  const cCallsA = yield* kit.ask(sc.id, prompt("bit-iso-a", "op-c-calls-a"));
  line("outcome", cCallsA.outcome);
  line("harness error", cCallsA.error ?? "none");
  console.log("  C asked for the shared directory's bit-iso-a:");
  console.log(`${cCallsA.final.replace(/^/gm, "    ")}`);
  kit.show("traffic", kit.since(mark));
  line("observations under credential a", yield* kit.observationsBy("a"));
  line("observations under credential c", yield* kit.observationsBy("c"));

  heading(
    "Q2. re-register bit-iso-a under a NEW token (a different attempt: a2)",
  );
  const credA2 = yield* kit.credentialFor("a2", sa.id);
  mark = kit.mark();
  yield* kit.register(sa.id, "bit-iso-a", credA2, shared);
  line("registry after re-register", yield* listed(shared));
  kit.show("traffic caused by the re-register itself", kit.since(mark));
  yield* kit.credentials.revoke(credA.token);
  line("old token (a) revoked", "yes, so any use of it is a 401 in the ledger");
  mark = kit.mark();
  // A fresh session in the same directory, so the call cannot lean on anything session B
  // already learned about the old registration.
  const sd = yield* kit.open(shared, "D");
  const dCallsA = yield* kit.ask(
    sd.id,
    prompt("bit-iso-a", "op-d-calls-a-after"),
  );
  line("outcome", dCallsA.outcome);
  line("harness error", dCallsA.error ?? "none");
  console.log(`  model said:\n${dCallsA.final.replace(/^/gm, "    ")}`);
  kit.show("traffic after re-register", kit.since(mark));
  line("observations under credential a", yield* kit.observationsBy("a"));
  line("observations under credential a2", yield* kit.observationsBy("a2"));

  mark = kit.mark();
  const bAgain = yield* kit.ask(
    sb.id,
    prompt("bit-iso-a", "op-b-calls-a-after"),
  );
  line("session B (already-open) outcome", bAgain.outcome);
  console.log(`  model said:\n${bAgain.final.replace(/^/gm, "    ")}`);
  kit.show("traffic, already-open session B", kit.since(mark));
  line("observations under credential a", yield* kit.observationsBy("a"));
  line("observations under credential a2", yield* kit.observationsBy("a2"));

  heading("Persistence of the registration");
  line("shared registry at the end", yield* listed(shared));
  const tokens = new Map<string, string>();
  for (const [token, label] of kit.labels) tokens.set(token, label);
  const scan = scanForTokens(
    tokens,
    [
      ROOT,
      join(homedir(), ".local", "share", "opencode"),
      join(homedir(), ".config", "opencode"),
    ],
    startedAt,
  );
  line("files scanned (touched this run)", scan.scanned);
  line("raw tokens found on disk", scan.hits.length === 0 ? "none" : scan.hits);

  const seen = yield* diagnostics;
  if (seen.stderr.length > 0) {
    heading("harness stderr (bounded tail)");
    console.log(seen.stderr.slice(-8).join("\n"));
  }
});

// --------------------------------------------------------------------------------------
// Claude Code.
// --------------------------------------------------------------------------------------

const claudeProgram = Effect.gen(function* () {
  const kit = yield* makeKit("claude");
  const startedAt = Date.now() - 1000;
  const shared = join(ROOT, "claude", "shared");
  yield* kit.prepare(shared);

  heading("setup");
  line("claude code", kit.harness.instance.version);
  line("shared directory", shared);
  const ca = yield* kit.open(shared, "A");
  const cb = yield* kit.open(shared, "B");
  line("session A", ca.id);
  line("session B", cb.id);
  const credA = yield* kit.credentialFor("a", ca.id);
  const credB = yield* kit.credentialFor("b", cb.id);
  yield* kit.register(ca.id, "bit-iso-a", credA, shared);
  yield* kit.register(cb.id, "bit-iso-b", credB, shared);
  line("registered bit-iso-a for", "session A only, under credential a");
  line("registered bit-iso-b for", "session B only, under credential b");

  heading("Q3. both sessions live at once, in one directory");
  console.log("  A is asked to call its own server (positive control);");
  console.log("  B is asked to call A's server (should not exist for B).");
  const mark = kit.mark();
  const [aOwn, bCallsA] = yield* Effect.all(
    [
      kit.ask(ca.id, prompt("bit-iso-a", "op-a-calls-a")),
      kit.ask(cb.id, prompt("bit-iso-a", "op-b-calls-a")),
    ],
    { concurrency: "unbounded" },
  );
  line("A outcome", aOwn.outcome);
  line("A harness error", aOwn.error ?? "none");
  console.log(`  A said:\n${aOwn.final.replace(/^/gm, "    ")}`);
  line("B outcome", bCallsA.outcome);
  line("B harness error", bCallsA.error ?? "none");
  console.log(`  B said:\n${bCallsA.final.replace(/^/gm, "    ")}`);
  kit.show("traffic", kit.since(mark));
  line("observations under credential a", yield* kit.observationsBy("a"));
  line("observations under credential b", yield* kit.observationsBy("b"));

  heading(
    "Q2. same name registered twice before the prompt, then once after it",
  );
  const cd = yield* kit.open(shared, "D");
  const credD1 = yield* kit.credentialFor("d1", cd.id);
  const credD2 = yield* kit.credentialFor("d2", cd.id);
  yield* kit.register(cd.id, "bit-iso-d", credD1, shared);
  yield* kit.register(cd.id, "bit-iso-d", credD2, shared);
  line(
    "registered bit-iso-d twice",
    "tokens d1 then d2, same session, before prompt",
  );
  const mark2 = kit.mark();
  const dCalls = yield* kit.ask(cd.id, prompt("bit-iso-d", "op-d-calls-d"));
  line("outcome", dCalls.outcome);
  line("harness error", dCalls.error ?? "none");
  console.log(`  model said:\n${dCalls.final.replace(/^/gm, "    ")}`);
  kit.show("traffic", kit.since(mark2));
  line("observations under credential d1", yield* kit.observationsBy("d1"));
  line("observations under credential d2", yield* kit.observationsBy("d2"));

  heading(
    "Q2b. registration AFTER the prompt was accepted (rotation on a live session)",
  );
  const ce = yield* kit.open(shared, "E");
  const credE = yield* kit.credentialFor("e", ce.id);
  const mark3 = kit.mark();
  yield* kit.harness.prompt(ce.id, "Reply with the single word: ready");
  const late = yield* Effect.result(
    kit.register(ce.id, "bit-iso-late", credE, shared),
  );
  line(
    "late registerMcpServer returned",
    Result.isSuccess(late)
      ? "success (no error)"
      : `failure: ${String(late.failure)}`,
  );
  yield* Effect.result(
    kit.harness.waitForIdle(ce.id).pipe(Effect.timeout("3 minutes")),
  );
  kit.show("traffic for the late server", kit.since(mark3));

  heading("Persistence of the registration");
  const tokens = new Map<string, string>();
  for (const [token, label] of kit.labels) tokens.set(token, label);
  const scan = scanForTokens(
    tokens,
    [ROOT, join(homedir(), ".claude"), join(homedir(), ".claude.json")],
    startedAt,
  );
  line("files scanned (touched this run)", scan.scanned);
  line("raw tokens found on disk", scan.hits.length === 0 ? "none" : scan.hits);
});

// --------------------------------------------------------------------------------------
// Wiring.
// --------------------------------------------------------------------------------------

const base = (driver: Driver) => {
  const store = ObservationStore.layer(join(ROOT, driver, "hunt.sqlite"));
  const resolver = TargetStores.ofStore(TARGET_ID).pipe(Layer.provide(store));
  const endpoint = ControlPlaneEndpoint.layer({}).pipe(
    Layer.provideMerge(McpCredentials.layer),
    Layer.provideMerge(McpCallCounter.layer),
    Layer.provide(resolver),
  );
  return Layer.mergeAll(store, endpoint);
};

const driver: string = process.argv[2] ?? "";

if (driver === "opencode") {
  rmSync(join(ROOT, "opencode"), { recursive: true, force: true });
  mkdirSync(join(ROOT, "opencode", "shared"), { recursive: true });
  const harness = openCodeHarness().pipe(
    Layer.provideMerge(
      OpenCodeServer.layer({ cwd: join(ROOT, "opencode", "shared") }),
    ),
  );
  runMain(
    Effect.scoped(openCodeProgram).pipe(
      Effect.provide(Layer.mergeAll(base("opencode"), harness)),
      Effect.provide(FetchHttpClient.layer),
    ),
  );
} else if (driver === "claude") {
  rmSync(join(ROOT, "claude"), { recursive: true, force: true });
  mkdirSync(join(ROOT, "claude", "shared"), { recursive: true });
  runMain(
    Effect.scoped(claudeProgram).pipe(
      Effect.provide(Layer.mergeAll(base("claude"), claudeCodeHarness())),
    ),
  );
} else {
  console.error(
    "usage: bun run src/spike/mcpIsolationProof.ts <opencode|claude>",
  );
  process.exit(2);
}
