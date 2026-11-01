/**
 * Which model a scope import runs on (D15).
 *
 * Reading a scope table is short structured extraction, and it should not cost what a
 * worker's model costs. So the importer does not inherit whatever the hunt's workers are
 * configured with; it gets its own choice, defaulted by the rule below and overridable on
 * the create-target screen.
 *
 * ## The rule, and why it is a rule rather than two constants
 *
 * `modelOption.ts` is explicit about the lifetimes involved: a model descriptor is
 * **observed** when the server built the harness and is replaced wholesale when it is
 * rebuilt, while a *selection* is the operator's and survives a model change, a reconnect
 * and a reload. Collapsing a descriptor into a remembered choice is "how a capability
 * starts being presented as a selection".
 *
 * A hardcoded model id would be exactly that collapse. It would be a remembered claim
 * about what a harness offers, it would outlive the catalogue entry it names, and the first
 * time the provider renamed or retired that model the importer would be started against a
 * model that does not exist — reported, if at all, as a session that failed to open.
 *
 * So both halves resolve against what the harnesses actually reported:
 *
 * 1. **The preferred model, if the catalogue has it.** {@link PREFERRED_IMPORTER_MODEL} is
 *    a *lookup key*, not a descriptor: its only job is to be present or absent in
 *    `instance.models`. Absent, nothing is assumed about it.
 * 2. **Otherwise the smallest model the other harness reports**, found by
 *    {@link smallModelOf} applying a rule to the ids a harness listed. Not a second
 *    hardcoded id — the fallback has to work on a catalogue nobody has seen.
 *
 * Both steps read `HarnessListing.instance.models`, which `harness/resolver.ts` fills at
 * layer build from `GET /api/model` on OpenCode and from the driver's own list on Claude
 * Code. If a harness could not be built, its listing carries a reason and no usable
 * catalogue, and {@link chooseImporterModel} skips it rather than preferring a model on a
 * harness that will refuse to run it.
 */
import type { ImporterModelOrigin } from "@bit/contracts";

import { isReady, type HarnessListing } from "../harness/resolver";

/**
 * The model the operator named for this work, as OpenCode's catalogue spells it.
 *
 * Free, so an import cannot die on a paid account's usage limit, and small, because
 * reading a table out of a page is not the expensive part of a hunt.
 * `spike/usageProbe.ts:75` records this spelling, having read it off a live
 * `GET /api/model` rather than off a provider's documentation.
 *
 * **It is a key this module looks up, and nothing more.** Nothing here assumes it exists,
 * nothing reports it as available, and no descriptor is remembered for it. A build whose
 * catalogue does not list it takes {@link smallModelOf}'s path, and that is a normal
 * outcome rather than a misconfiguration.
 */
export const PREFERRED_IMPORTER_MODEL = "opencode/glm-5.3-flash-free";

/**
 * Which model on a harness is the small, cheap one — by a rule over what it reported.
 *
 * **A rule, not a lookup table, and that is D15's requirement rather than a preference.**
 * The fallback has to produce an answer on a catalogue this code has never seen, including
 * one where today's model names have all been retired. So it ranks the ids the harness
 * listed by the markers that mean "small" across every provider's naming, and takes the
 * best-ranked one.
 *
 * Ordered most to least preferred. A marker matches as a substring of the lowercased id,
 * which is how every provider in the wild spells these: `claude-haiku-4-5`,
 * `glm-5.3-flash-free`, `gpt-5-mini`, `gemini-flash`.
 *
 * The honest limit, stated: this is a heuristic over names, so a harness that renamed its
 * small model to something unrecognisable gets its **default** model instead. That is the
 * right failure — the harness's own default is a claim the harness makes, where picking an
 * arbitrary unranked id would be this module guessing — and the import still runs.
 */
const SMALL_MODEL_MARKERS: readonly string[] = [
  "haiku",
  "flash",
  "mini",
  "small",
  "lite",
  "nano",
];

export const smallModelOf = (instance: {
  readonly defaultModel: string;
  readonly models: readonly { readonly id: string }[];
}): string => {
  for (const marker of SMALL_MODEL_MARKERS) {
    // Within one marker, the shortest id wins. Across `claude-haiku-4-5` and a
    // hypothetical `claude-haiku-4-5-thinking-preview`, the plain one is the one that
    // means "the small model" rather than a variant of it.
    const matched = instance.models
      .filter((model) => model.id.toLowerCase().includes(marker))
      .sort((left, right) => left.id.length - right.id.length);
    const best = matched[0];
    if (best !== undefined) return best.id;
  }
  return instance.defaultModel;
};

/** What the rule resolved to, and what decided it. */
export interface ImporterModelChoice {
  readonly instanceId: string;
  readonly model: string;
  readonly origin: ImporterModelOrigin;
  readonly detail: string;
}

/**
 * Applies D15's rule to the catalogue as it stands, or answers `undefined`.
 *
 * `undefined` means no harness this server configured came up, so there is no catalogue to
 * resolve against and no import can run. Reported rather than defaulted: a model id
 * invented here would put a control on the create-target screen offering a choice the
 * server cannot honour.
 *
 * Only **ready** instances are considered. An unready one is listed to the operator with
 * its reason (`harness/resolver.ts` keeps it visible on purpose), but preferring a model on
 * a harness that will refuse to open a session would turn a legible "no harness is ready"
 * into an import that fails a step later for a reason that reads like the model's fault.
 */
export const chooseImporterModel = (
  listings: readonly HarnessListing[],
): ImporterModelChoice | undefined => {
  const ready = listings.filter(isReady);
  if (ready.length === 0) return undefined;

  for (const listing of ready) {
    const offered = listing.instance.models.find(
      (model) => model.id === PREFERRED_IMPORTER_MODEL,
    );
    if (offered === undefined) continue;
    return {
      instanceId: listing.instance.instanceId,
      model: offered.id,
      origin: "preferred",
      detail: `${listing.instance.displayName} offers ${offered.id}, which is free and small enough for reading a scope table`,
    };
  }

  // Nothing offers the preferred model. The fallback is the first ready harness's own
  // small model — `first` meaning configuration order, which `harness/resolver.ts` keeps
  // and which is also what `resolve(undefined)` would have picked, so the importer lands
  // on the same harness as everything else rather than on a surprising one.
  const listing = ready[0];
  if (listing === undefined) return undefined;
  const model = smallModelOf(listing.instance);
  return {
    instanceId: listing.instance.instanceId,
    model,
    origin: "fallback",
    detail: `no configured harness offers ${PREFERRED_IMPORTER_MODEL}, so this falls back to ${listing.instance.displayName}'s ${model}`,
  };
};

/**
 * What the operator picked, or the rule's answer, or nothing.
 *
 * An explicit pick wins without being validated against the catalogue, which matches how
 * `RunDraft.model` is treated: that list is what the picker *offers*, and whether a model
 * can actually run is the harness's answer to give rather than ours to pre-empt. An
 * explicit pick of an instance that is not ready still resolves to a choice here and is
 * refused by `HarnessResolver.resolve`, with the resolver's own sentence — never silently
 * swapped for a working one.
 */
export const resolveImporterModel = (input: {
  readonly listings: readonly HarnessListing[];
  readonly choice?:
    | {
        readonly instanceId?: string | undefined;
        readonly model?: string | undefined;
      }
    | undefined;
}): ImporterModelChoice | undefined => {
  const resolved = chooseImporterModel(input.listings);
  const picked = input.choice;
  if (picked === undefined) return resolved;

  const instanceId =
    picked.instanceId !== undefined && picked.instanceId !== ""
      ? picked.instanceId
      : resolved?.instanceId;
  if (instanceId === undefined) return undefined;

  const model =
    picked.model !== undefined && picked.model !== ""
      ? picked.model
      : instanceId === resolved?.instanceId
        ? resolved.model
        : // A different instance was picked and no model with it, so the rule's model —
          // which belongs to another harness's catalogue — says nothing here. The chosen
          // instance's own small model is the closest thing to what the operator asked
          // for, and its default is `smallModelOf`'s own fallback.
          smallModelOf(
            input.listings.find(
              (listing) => listing.instance.instanceId === instanceId,
            )?.instance ?? { defaultModel: "", models: [] },
          );
  if (model === "") return resolved;

  return {
    instanceId,
    model,
    origin: resolved?.origin ?? "fallback",
    detail:
      resolved !== undefined &&
      instanceId === resolved.instanceId &&
      model === resolved.model
        ? resolved.detail
        : `chosen on the create-target screen: ${model} on ${instanceId}`,
  };
};
