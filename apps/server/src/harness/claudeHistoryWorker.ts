/**
 * One Claude Code history read, in a process of its own (`claudeHistory.ts`).
 *
 * Run as `bun claudeHistoryWorker.ts '<request JSON>'` with the instance's
 * `CLAUDE_CONFIG_DIR` in its environment. The SDK's history readers resolve the config
 * folder from **this process's** environment, so a read for an instance with its own folder
 * has to happen in a process started with that folder: measured on this branch
 * (`spike/ccInstancesProbe.ts`), the z.ai instance's session was "not found" in bit's own
 * process and read in full from a child started this way.
 *
 * It writes exactly one JSON line on stdout: `{ "ok": true, "value": … }`, or
 * `{ "ok": false, "error": "…" }` when the SDK threw. Anything else — a crash, a kill — is
 * the parent's to describe. Nothing else is written to stdout, so the parent can decode it
 * whole.
 *
 * Imports nothing of bit's: the bundle for this entry is the SDK and these lines.
 */
import {
  getSessionInfo,
  getSessionMessages,
  getSubagentMessages,
  listSubagents,
} from "@anthropic-ai/claude-agent-sdk";

interface Request {
  readonly op: string;
  readonly sessionId: string;
  readonly agentId?: string;
  readonly dir?: string;
}

const answer = async (request: Request): Promise<unknown> => {
  const options = request.dir === undefined ? {} : { dir: request.dir };
  switch (request.op) {
    case "sessionInfo":
      return (await getSessionInfo(request.sessionId, options)) ?? null;
    case "sessionMessages":
      return await getSessionMessages(request.sessionId, options);
    case "subagentMessages":
      return await getSubagentMessages(
        request.sessionId,
        request.agentId ?? "",
        options,
      );
    case "listSubagents":
      return await listSubagents(request.sessionId, options);
    default:
      throw new Error(`unknown history operation '${request.op}'`);
  }
};

if (import.meta.main) {
  try {
    const request = JSON.parse(process.argv[2] ?? "") as Request;
    const value = await answer(request);
    process.stdout.write(`${JSON.stringify({ ok: true, value })}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
  }
}
