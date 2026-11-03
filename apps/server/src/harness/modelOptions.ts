/**
 * What a session on one harness's model is actually handed as `createSession`'s `options`.
 *
 * The server's half of `@bit/contracts`'s `modelOption.ts`, and the one place it is applied:
 * a run (`run/supervisor.ts`) and an importer session (`import/scopeImporter.ts`) both open
 * a session on a model an operator may have set options on, and `createSession`'s contract
 * is that what it is handed is already resolved against that model's descriptors. Two
 * callers resolving separately is how one of them would start forwarding a value the other
 * drops.
 */
import {
  droppedModelOptionIds,
  explicitModelOptionSelections,
  modelOptionDescriptors,
  type ModelOptionSelection,
} from "@bit/contracts";
import { Effect } from "effect";

import type { AgentHarness } from "./agentHarness";

/**
 * Resolves what the operator asked for against what `model` offers on `harness`.
 *
 * Against *this* model's descriptors, from the catalogue this process observed. A model the
 * catalogue does not list offers nothing as far as we can tell, so every selection for it is
 * dropped — which is the honest answer rather than forwarding a value to a harness that never
 * said it would take one. A drop is logged, never refused: a browser holding a stale
 * catalogue is the expected case, not a client error.
 *
 * `undefined` when nothing survives, and a caller passes it on as *absent* rather than `[]`:
 * a harness told nothing applies its own default, and one told the default explicitly has
 * been pinned to today's answer.
 */
export const resolveSessionModelOptions = (
  harness: AgentHarness["Service"],
  model: string,
  requested: readonly ModelOptionSelection[] | undefined,
  what: string,
): Effect.Effect<readonly ModelOptionSelection[] | undefined> =>
  Effect.gen(function* () {
    const { options, dropped } = modelOptionsFor(harness, model, requested);
    if (dropped.length > 0) {
      yield* Effect.logWarning(
        `${what} named model options this model does not offer; they were dropped rather than forwarded`,
        { model, dropped: dropped.join(", ") },
      );
    }
    return options;
  });

/**
 * {@link resolveSessionModelOptions} without the log, answering what was dropped as well.
 *
 * For a caller that tells the operator rather than the log: a model switch answers
 * `droppedModelOptionIds` so the picker can say what the new model does not offer
 * (`harness/modelSwitch.ts`). The same resolution, so a switch and an open cannot disagree
 * about what a selection becomes.
 */
export const modelOptionsFor = (
  harness: AgentHarness["Service"],
  model: string,
  requested: readonly ModelOptionSelection[] | undefined,
): {
  readonly options: readonly ModelOptionSelection[] | undefined;
  readonly dropped: readonly string[];
} => {
  const descriptors = modelOptionDescriptors(
    harness.instance.models.find((entry) => entry.id === model),
  );
  const selections = requested ?? [];
  return {
    options: explicitModelOptionSelections(descriptors, selections),
    dropped: droppedModelOptionIds(descriptors, selections),
  };
};
