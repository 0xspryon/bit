/**
 * Step 0 of A7-S, OpenCode 2.2.5 — what reaches a host for a sub-agent (the `subagent` tool,
 * a child session with `parentID`), live and on replay, and what an interrupt of the child
 * does to the parent?
 *
 * ```sh
 * cd apps/server
 * bun run src/spike/openCodeSubagentProbe.ts --leg=fg
 * ```
 *
 * Legs (`--leg=`): `fg`, `bg`, `fg-interrupt`, `bg-interrupt`, `fail` (an unknown agent).
 *
 * Starts its own `opencode serve` on `--port=` (default 4791) in a fresh directory, reads
 * `GET /api/event` **unfiltered**, and prints every event naming the parent or a child
 * session (and, once per type, any other). Ends by reading both transcripts back, then
 * stops the server by its PID.
 *
 * **Nothing may import this module.** `main` runs at module scope.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const leg =
  process.argv.find((arg) => arg.startsWith("--leg="))?.slice(6) ?? "fg";
const port = Number(
  process.argv.find((arg) => arg.startsWith("--port="))?.slice(7) ?? 4791,
);
const [providerID, modelID] = (
  process.argv.find((arg) => arg.startsWith("--model="))?.slice(8) ??
  "zai-coding-plan/glm-5.3-flash"
).split("/") as [string, string];

const root = mkdtempSync("/run/media/hbt/work/bit-oc-subagent-probe-");
writeFileSync(join(root, "notes.txt"), "alpha line\nbeta line\ngamma line\n");
const password = crypto.randomUUID();
const auth = `Basic ${btoa(`opencode:${password}`)}`;
const base = `http://127.0.0.1:${port}`;

const started = Date.now();
const at = () => `+${String(Date.now() - started).padStart(6)}ms`;
const log = (...parts: unknown[]) => console.log(at(), ...parts);

const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: auth,
      "content-type": "application/json",
      accept: "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, text };
};

const SUB = (background: boolean, task: string, description: string) =>
  `Call your subagent tool exactly once, with agent "general", description "${description}", background ${background}, and this prompt: "${task}". ` +
  (background
    ? "After launching it, reply with the single word LAUNCHED and end your turn; do not wait for it."
    : "When it hands back, reply with one sentence saying what it reported.");

const PROMPTS: Record<string, string> = {
  fg: SUB(
    false,
    "Use the shell tool to run `ls`. Then use the read tool to read notes.txt. Then use the shell tool to run `wc -l notes.txt`. Then reply with the second line of notes.txt.",
    "Inspect notes file",
  ),
  bg: SUB(
    true,
    "Use the shell tool to run `sleep 12 && echo slept`. Then use the read tool to read notes.txt. Reply with its first line.",
    "Sleep then read",
  ),
  "fg-interrupt": SUB(
    false,
    "Use the shell tool to run `sleep 25 && echo slept`. Then reply DONE.",
    "Sleep in foreground",
  ),
  fail: 'Call your subagent tool exactly once, with agent "no-such-agent", description "Unknown agent", and the prompt "Reply OK.". If it fails, reply with the single word FAILED.',
};
PROMPTS["bg-interrupt"] = PROMPTS["bg"]!;

const short = (value: unknown, max = 500) => {
  const text = JSON.stringify(value);
  return text.length <= max ? text : `${text.slice(0, max)}…`;
};

const main = async () => {
  log("leg", leg, "model", providerID, modelID, "root", root);
  const server = Bun.spawn(
    ["opencode", "serve", "--port", String(port), "--hostname", "127.0.0.1"],
    {
      cwd: root,
      env: { ...process.env, OPENCODE_PASSWORD: password },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  log("server pid", server.pid);
  try {
    for (let i = 0; i < 60; i += 1) {
      try {
        const health = await call("GET", "/api/session");
        if (health.status < 500) break;
      } catch {
        // not up yet
      }
      await Bun.sleep(500);
    }
    const created = await call("POST", "/api/session", {
      model: { providerID, id: modelID },
      location: { directory: root },
    });
    const parent = (JSON.parse(created.text) as { data: { id: string } }).data
      .id;
    log("parent", parent);
    const children = new Set<string>();
    const seenOther = new Set<string>();
    let childFirstTool = false;
    let parentIdle = 0;
    let lastEvent = Date.now();
    const abort = new AbortController();
    const events = (async () => {
      const response = await fetch(`${base}/api/event`, {
        headers: { authorization: auth, accept: "text/event-stream" },
        signal: abort.signal,
      });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut = buffer.indexOf("\n\n");
        while (cut >= 0) {
          const chunk = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          cut = buffer.indexOf("\n\n");
          const data = chunk
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data === "") continue;
          const event = JSON.parse(data) as {
            type: string;
            data?: Record<string, unknown>;
          };
          lastEvent = Date.now();
          const d = event.data ?? {};
          const sid =
            typeof d["sessionID"] === "string"
              ? d["sessionID"]
              : ((d["form"] as { sessionID?: string } | undefined)?.sessionID ??
                (event as { durable?: { aggregateID?: string } }).durable
                  ?.aggregateID);
          if (
            event.type === "session.created" ||
            event.type === "session.updated"
          ) {
            const info = (d["info"] ?? d) as {
              id?: string;
              parentID?: string;
            };
            if (info.parentID === parent && typeof info.id === "string") {
              children.add(info.id);
            }
          }
          if (
            event.type === "session.tool.progress" ||
            event.type === "session.tool.success"
          ) {
            const meta = d["metadata"] as { sessionID?: string } | undefined;
            if (sid === parent && typeof meta?.sessionID === "string") {
              children.add(meta.sessionID);
            }
          }
          const who =
            sid === parent
              ? "PARENT"
              : sid !== undefined && children.has(sid)
                ? `CHILD ${sid}`
                : undefined;
          if (event.type.endsWith(".delta")) continue;
          if (who === undefined) {
            if (!seenOther.has(event.type)) {
              seenOther.add(event.type);
              log("other", event.type, short(d, 300));
            }
            continue;
          }
          log(who, event.type, short(d));
          if (
            who.startsWith("CHILD") &&
            event.type === "session.tool.called" &&
            !childFirstTool &&
            (leg === "fg-interrupt" || leg === "bg-interrupt")
          ) {
            childFirstTool = true;
            const child = sid!;
            setTimeout(() => {
              log("POST interrupt child", child);
              void call("POST", `/api/session/${child}/interrupt`).then((r) =>
                log("interrupt answered", r.status, r.text),
              );
            }, 3000);
          }
          if (
            who === "PARENT" &&
            (event.type === "session.execution.succeeded" ||
              event.type === "session.execution.failed" ||
              event.type === "session.execution.interrupted")
          ) {
            parentIdle += 1;
          }
        }
      }
    })().catch((e) => log("events ended", String(e)));
    await Bun.sleep(500);
    const sent = await call("POST", `/api/session/${parent}/prompt`, {
      text: PROMPTS[leg] ?? PROMPTS["fg"]!,
    });
    log("prompt", sent.status);
    const want = leg.startsWith("bg") ? 2 : 1;
    for (;;) {
      await Bun.sleep(1000);
      if (parentIdle >= want && Date.now() - lastEvent > 5000) break;
      if (Date.now() - lastEvent > 60_000) {
        log("quiet 60 s");
        break;
      }
      if (Date.now() - started > 240_000) {
        log("timeout");
        break;
      }
    }
    abort.abort();
    await Promise.race([events, Bun.sleep(1000)]);
    log("children", [...children]);
    const parentMessages = await call("GET", `/api/session/${parent}/message`);
    log("parent messages", parentMessages.status);
    for (const message of (
      JSON.parse(parentMessages.text) as { data?: unknown[] }
    ).data ?? []) {
      log("  parent msg", short(message, 900));
    }
    for (const child of children) {
      const info = await call("GET", `/api/session/${child}`);
      log("child info", short(JSON.parse(info.text), 600));
      const own = await call("GET", `/api/session/${child}/message`);
      for (const message of (JSON.parse(own.text) as { data?: unknown[] })
        .data ?? []) {
        log("  child msg", short(message, 600));
      }
    }
    const listed = await call(
      "GET",
      `/api/session?parentID=${parent}&directory=${encodeURIComponent(root)}`,
    );
    log("list by parentID", listed.status, short(listed.text, 800));
  } finally {
    server.kill("SIGTERM");
    await Promise.race([server.exited, Bun.sleep(5000)]);
    log("server exited", server.exitCode, "trash", root);
  }
};

await main();
