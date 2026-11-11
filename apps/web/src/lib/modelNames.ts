/**
 * What the web calls a model (follow-ups A, 2026-11-11): the one place a screen turns a
 * model id into the words it shows.
 *
 * A z.ai Claude Code instance runs `sonnet` as `glm-5.3-flash`, and its catalogue says
 * "GLM-5.3 Flash"; every place that names a model — a turn's footer, the context meter, the
 * picker, the session lists, a switch's notice — says the label, else the provider's own
 * name, else the id (`modelDisplayName` in `@bit/contracts`). The id stays what is sent,
 * stored and compared: this module only words it.
 */
import {
  catalogueEntryOf,
  modelDisplayName,
  modelOptionDescriptors,
  modelOptionsSummary,
  type HarnessInstanceView,
  type ModelOptionDescriptor,
  type ModelOptionSelection,
} from "@bit/contracts";

/** Which instance a model belongs to, as a caller knows it: by id, or by display name. */
export interface ModelHome {
  readonly instanceId?: string | null | undefined;
  /** The instance's display name, for a caller that holds no id. */
  readonly harness?: string | undefined;
}

/** The instance `home` names, if this server lists it. */
export const instanceOf = (
  harnesses: readonly HarnessInstanceView[],
  home: ModelHome | undefined,
): HarnessInstanceView | undefined => {
  if (home === undefined) return undefined;
  if (home.instanceId !== undefined && home.instanceId !== null) {
    const byId = harnesses.find(
      (entry) => entry.instanceId === home.instanceId,
    );
    if (byId !== undefined) return byId;
  }
  return home.harness === undefined || home.harness === ""
    ? undefined
    : harnesses.find((entry) => entry.displayName === home.harness);
};

/**
 * What a screen calls `model`. Looked up in its own instance's catalogue when the caller
 * knows the instance; otherwise in the first catalogue that lists it — an id is the same
 * model wherever two instances both list it unless one of them labels it.
 */
export const modelNameIn = (
  harnesses: readonly HarnessInstanceView[],
  home: ModelHome | undefined,
  model: string,
): string => {
  const own = instanceOf(harnesses, home);
  if (own !== undefined) return modelDisplayName(own.models, model);
  const named = harnesses.find((entry) => {
    const found = catalogueEntryOf(entry.models, model);
    return found?.label !== undefined || found?.reportedAs !== undefined;
  });
  return modelDisplayName(named?.models, model);
};

/**
 * What `model` offers in its own instance's catalogue: the descriptors a sentence names its
 * options by ("Thinking: High"). Empty where the catalogue does not list it.
 */
export const modelDescriptorsIn = (
  harnesses: readonly HarnessInstanceView[],
  home: ModelHome | undefined,
  model: string,
): readonly ModelOptionDescriptor[] =>
  modelOptionDescriptors(
    catalogueEntryOf(instanceOf(harnesses, home)?.models, model),
  );

/**
 * A model as a session's chip and lists say it: its name, and what was chosen of it —
 * "GLM-5.3 Flash · High". Nothing chosen (or the default chosen) is just the name.
 */
export const modelWithOptions = (
  harnesses: readonly HarnessInstanceView[],
  home: ModelHome | undefined,
  model: string,
  selections: readonly ModelOptionSelection[] | undefined,
): string => {
  const name = modelNameIn(harnesses, home, model);
  const own = instanceOf(harnesses, home);
  const summary = modelOptionsSummary(
    modelOptionDescriptors(catalogueEntryOf(own?.models, model)),
    selections,
  );
  return summary === "" ? name : `${name} · ${summary}`;
};

/**
 * A model as a provenance row recorded it (`provider/model`), as a detail panel says it:
 * its name where the instance's catalogue names it, else `provider/model` as recorded.
 */
export const provenanceModelIn = (
  harnesses: readonly HarnessInstanceView[],
  instanceId: string | null | undefined,
  providerId: string | null | undefined,
  modelId: string,
): string => {
  const name = modelNameIn(harnesses, { instanceId }, modelId);
  return name !== modelId ? name : `${providerId ?? "?"}/${modelId}`;
};
