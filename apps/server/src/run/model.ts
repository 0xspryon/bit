/**
 * The provider and model a worker runs on.
 *
 * One constant, in one place, because two places that pinned a model would be two
 * deployments disagreeing about what ran — and the provider and model are recorded on
 * every attempt row as provenance, so a disagreement would be written into the evidence.
 * It lived on `spike/runtime.ts` while the spike was the only thing that started a run;
 * the server starts runs now, and the server importing from `spike/` would be the wrong
 * direction.
 *
 * `openai` here is OpenCode's OAuth-authenticated ChatGPT subscription provider, which
 * the spawned server reads from the user's own stored credentials. No API key is read,
 * passed or held by this process.
 *
 * Verified on 2026-10-19 against opencode v2.0.32, and again on 2026-10-24 against
 * v2.1.2: `gpt-5.6-sol` and `gpt-6-astra` complete; `gpt-5.5` and `gpt-5.3-codex-spark`
 * are refused by the provider with "not supported when using Codex with a ChatGPT
 * account", so model availability is narrower than the catalogue suggests.
 *
 * **This is a pin, not a choice, and it is temporary.** Letting an operator pick a
 * provider, an instance and a model is the work of a later slice; until then a server that
 * offered a picker would be offering a field it ignores.
 */
import type { ModelRef } from "../harness/openCodeClient";

export const WORKER_MODEL: ModelRef = {
  providerID: "openai",
  id: "gpt-5.6-sol",
};
