/**
 * Spike F: two Claude Code instances in one bit process.
 *
 * ```sh
 * cd apps/server
 * BIT_SPIKE_ZAI_CONFIG=/run/media/hbt/work/02-cc-configs/cc_z_ai \
 *   bun run src/spike/ccInstancesProbe.ts 2>&1 | tee .runtime/cc-instances.log
 * ```
 *
 * An instance is a `CLAUDE_CONFIG_DIR` (operator decision, 2026-11-10): the default one is the
 * operator's `~/.claude`, another holds a z.ai `settings.json`. Three questions:
 *
 * 1. **Side by side.** Do an Anthropic session and a z.ai session run at once in one
 *    process, each on its own instance, when the only per-instance input is `env`?
 * 2. **History.** bit reads transcripts in its own process (`getSessionInfo`,
 *    `getSessionMessages`), which take a project folder and no config folder. Does an
 *    in-process read find the z.ai instance's session, and does a child process started
 *    with the instance's `CLAUDE_CONFIG_DIR` (T3 Code's `claudeHistoryWorker.ts` shape)?
 * 3. **A refusing provider.** z.ai answers an account with no balance with HTTP 429 and
 *    code 1113, which Claude Code retries as a rate limit. What does the SDK stream while
 *    it does, and what does the turn end as? Measured against a local server that answers
 *    every request that way, with a copy of the z.ai settings pointed at it.
 *
 * The CLI's environment is this process's minus the variables of a Claude Code session the
 * spike may be running under (`CLAUDECODE`, `CLAUDE_CODE_*`, …), so each child is a fresh
 * CLI and not a nested one.
 *
 * **Nothing may import this module.**
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  getSessionInfo,
  getSessionMessages,
  query,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { RUNTIME_DIR } from "./runtime";

const ZAI_CONFIG = process.env.BIT_SPIKE_ZAI_CONFIG ?? "";
if (ZAI_CONFIG === "") {
  console.error(
    "BIT_SPIKE_ZAI_CONFIG must name the z.ai instance's config folder",
  );
  process.exit(2);
}
const ROOT = join(
  RUNTIME_DIR,
  "cc-instances",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
const WORK = join(ROOT, "work");
mkdirSync(WORK, { recursive: true });

const line = (label: string, value: unknown) =>
  console.log(
    `${label.padEnd(44)} ${typeof value === "string" ? value : JSON.stringify(value)}`,
  );
const heading = (text: string) => console.log(`\n=== ${text} ===`);

const SESSION_VARIABLES =
  /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_VERSION)$/;
const baseEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (
      value !== undefined &&
      !SESSION_VARIABLES.test(name) &&
      name !== "CLAUDE_CONFIG_DIR"
    )
      env[name] = value;
  return env;
};

interface Turn {
  sessionId: string;
  initModel: string | undefined;
  apiKeySource: string | undefined;
  result: Record<string, unknown> | undefined;
  retries: {
    attempt: number;
    max: number;
    delayMs: number;
    status: number | null;
    error: unknown;
    atMs: number;
  }[];
  ms: number;
}

const run = async (
  prompt: string,
  model: string,
  env: Record<string, string>,
  abortAfterMs?: number,
): Promise<Turn> => {
  const started = Date.now();
  const abort = new AbortController();
  const timer =
    abortAfterMs === undefined
      ? undefined
      : setTimeout(() => abort.abort(), abortAfterMs);
  const turn: Turn = {
    sessionId: "",
    initModel: undefined,
    apiKeySource: undefined,
    result: undefined,
    retries: [],
    ms: 0,
  };
  try {
    for await (const message of query({
      prompt,
      options: {
        model,
        cwd: WORK,
        env,
        maxTurns: 2,
        settingSources: ["user", "project", "local"],
        abortController: abort,
      },
    }) as AsyncIterable<SDKMessage>) {
      const record = message as unknown as Record<string, unknown>;
      if (typeof record.session_id === "string")
        turn.sessionId = record.session_id;
      if (record.type === "system" && record.subtype === "init") {
        turn.initModel = record.model as string | undefined;
        turn.apiKeySource = record.apiKeySource as string | undefined;
      }
      if (record.type === "system" && record.subtype === "api_retry")
        turn.retries.push({
          attempt: record.attempt as number,
          max: record.max_retries as number,
          delayMs: record.retry_delay_ms as number,
          status: record.error_status as number | null,
          error: record.error,
          atMs: Date.now() - started,
        });
      if (record.type === "result") turn.result = record;
    }
  } catch (error) {
    turn.result = { thrown: String(error) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  turn.ms = Date.now() - started;
  return turn;
};

const summary = (turn: Turn) => ({
  session: turn.sessionId,
  initModel: turn.initModel,
  apiKeySource: turn.apiKeySource,
  subtype: turn.result?.subtype,
  is_error: turn.result?.is_error,
  api_error_status: turn.result?.api_error_status,
  result:
    typeof turn.result?.result === "string"
      ? turn.result.result.slice(0, 80)
      : turn.result?.thrown,
  models: Object.keys(
    (turn.result?.modelUsage as Record<string, unknown> | undefined) ?? {},
  ),
  ms: turn.ms,
});

// --------------------------------------------------------------------------------------

heading("1. Anthropic and z.ai sessions at once, in one process");
const anthropicEnv = baseEnv();
const zaiEnv = { ...baseEnv(), CLAUDE_CONFIG_DIR: ZAI_CONFIG };
const [anthropic, zai] = await Promise.all([
  run("Reply with exactly one word: OK", "claude-haiku-4-5", anthropicEnv),
  run("Reply with exactly one word: OK", "sonnet", zaiEnv),
]);
line("default instance (~/.claude)", summary(anthropic));
line("z.ai instance", summary(zai));

heading("2. Reading each session's history");
const inProcess = async (sessionId: string) => ({
  info:
    (await getSessionInfo(sessionId, { dir: WORK })) === undefined
      ? "not found"
      : "found",
  messages: (await getSessionMessages(sessionId, { dir: WORK })).length,
});
line("in-process read, default session", await inProcess(anthropic.sessionId));
line("in-process read, z.ai session", await inProcess(zai.sessionId));

const childRead = (sessionId: string, configDir: string | undefined) => {
  const script = `import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
const messages = await getSessionMessages(${JSON.stringify(sessionId)}, { dir: ${JSON.stringify(WORK)} });
console.log(JSON.stringify({ messages: messages.length }));`;
  const file = join(ROOT, `read-${sessionId}.mjs`);
  writeFileSync(file, script);
  const env = {
    ...baseEnv(),
    ...(configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: configDir }),
  };
  const result = spawnSync("bun", [file], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  });
  return (result.stdout.trim() || result.stderr.trim()).slice(0, 200);
};
line(
  "child read, z.ai session, z.ai config dir",
  childRead(zai.sessionId, ZAI_CONFIG),
);
line(
  "child read, z.ai session, default dir",
  childRead(zai.sessionId, undefined),
);
line(
  "child read, default session, z.ai config dir",
  childRead(anthropic.sessionId, ZAI_CONFIG),
);

heading("3. A provider that refuses with 429 / code 1113");
let refused = 0;
const refuser = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => {
    refused += 1;
    return Response.json(
      {
        type: "error",
        error: {
          type: "rate_limit_error",
          code: "1113",
          message:
            "[1113][Insufficient balance or no resource package. Please recharge.]",
        },
      },
      { status: 429 },
    );
  },
});
const refusingConfig = join(ROOT, "refusing-config");
mkdirSync(refusingConfig, { recursive: true, mode: 0o700 });
const settings = JSON.parse(
  readFileSync(join(ZAI_CONFIG, "settings.json"), "utf8"),
) as {
  env: Record<string, string>;
};
settings.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${String(refuser.port)}`;
settings.env.ANTHROPIC_AUTH_TOKEN = "not-a-real-key";
writeFileSync(join(refusingConfig, "settings.json"), JSON.stringify(settings), {
  mode: 0o600,
});
copyFileSync(
  join(ZAI_CONFIG, ".claude.json"),
  join(refusingConfig, ".claude.json"),
);

const defaultRetries = await run(
  "Reply OK",
  "sonnet",
  { ...baseEnv(), CLAUDE_CONFIG_DIR: refusingConfig },
  90_000,
);
line("default retries: turn", summary(defaultRetries));
line("default retries: requests the provider saw", refused);
line(
  "default retries: api_retry frames",
  defaultRetries.retries.map((retry) => ({ ...retry, error: retry.error })),
);

refused = 0;
const capped = await run(
  "Reply OK",
  "sonnet",
  {
    ...baseEnv(),
    CLAUDE_CONFIG_DIR: refusingConfig,
    CLAUDE_CODE_MAX_RETRIES: "1",
  },
  90_000,
);
line("CLAUDE_CODE_MAX_RETRIES=1: turn", summary(capped));
line("CLAUDE_CODE_MAX_RETRIES=1: requests seen", refused);
line("CLAUDE_CODE_MAX_RETRIES=1: api_retry frames", capped.retries.length);
await refuser.stop(true);

heading("Cleanup list");
line("spike folder", ROOT);
line("default session transcript folder", "~/.claude/projects/<WORK encoded>");
line("work folder (encode for projects/)", WORK);
