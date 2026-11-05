/**
 * Which model a scope import runs on (D15).
 *
 * Reading a scope table is short structured extraction, and it should not cost what a
 * worker's model costs. So the importer does not inherit whatever the hunt's workers are
 * configured with; it gets its own choice, defaulted by the rule below and overridable on
 * the create-target screen.
 *
 * ## The rule, in three steps and with no model id in two of them
 *
 * 1. **What the operator picked**, if they touched the picker. Taken as sent, for
 *    {@link resolveImporterModel}'s reason.
 * 2. **The preferred model, if a ready harness's catalogue offers it.**
 *    {@link PREFERRED_IMPORTER_MODEL} is a *lookup key*, not a descriptor: its only job is
 *    to be present or absent in `instance.models`. Absent, nothing is assumed about it.
 *    It is preferred because it is **free**, so an import cannot die on a paid account's
 *    usage limit, and small, because reading a table out of a page is not the expensive
 *    part of a hunt.
 * 3. **Otherwise that harness's own `defaultModel`**, which is what every run already
 *    does: `run/supervisor.ts` is `input.model ?? harness.instance.defaultModel`.
 *
 * ## Why step 3 is `defaultModel` and not a second named model
 *
 * D15 originally said "when the OpenCode catalogue does not offer it: the Claude Code
 * harness's Haiku", and this module implemented a heuristic over model *names* to find it
 * without hardcoding an id. **That was a second specific model to keep true as catalogues
 * move**, reached through a rule that guessed at provider naming, and it answered a
 * question the harness already answers for itself. `defaultModel` is a value the harness
 * *reports* — required on every instance, because an instance that could not say "which
 * model" could not run anything — and it is the value every run already trusts. Two paths
 * to "which model, when nobody said" is one too many.
 *
 * What it costs, plainly: the fallback is no longer guaranteed small or free. That is the
 * harness's own default, which is the operator's configuration rather than our guess, and
 * {@link ImporterModelChoice.detail} names the model it landed on so the create-target
 * screen shows it before anything runs.
 *
 * ## Still no hardcoded descriptor, which is the half of D15 that stands
 *
 * `modelOption.ts` is explicit about the lifetimes involved: a model descriptor is
 * **observed** when the server built the harness and is replaced wholesale when it is
 * rebuilt, while a *selection* is the operator's and survives a model change, a reconnect
 * and a reload. Collapsing a descriptor into a remembered choice is "how a capability
 * starts being presented as a selection".
 *
 * A hardcoded fallback id would be exactly that collapse: a remembered claim about what a
 * harness offers, outliving the catalogue entry it names, and the first time the provider
 * retired that model the importer would be started against one that does not exist —
 * reported, if at all, as a session that failed to open. Both steps above read what the
 * harnesses actually reported: `instance.models` for the lookup, `instance.defaultModel`
 * for the fallback. `harness/resolver.ts` fills both at layer build, from
 * `GET /api/model` on OpenCode and from the driver's own list on Claude Code.
 *
 * If a harness could not be built, its listing carries a reason and no usable catalogue,
 * and {@link chooseImporterModel} skips it rather than preferring a model on a harness
 * that will refuse to run it.
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
 * catalogue does not list it falls back to the harness's own default, and that is a normal
 * outcome rather than a misconfiguration.
 */
export const PREFERRED_IMPORTER_MODEL = "opencode/glm-5.3-flash-free";

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

  // Nothing offers the preferred model, so the harness answers "which model" itself. The
  // harness is the first ready one — `first` meaning configuration order, which
  // `harness/resolver.ts` keeps and which is also what `resolve(undefined)` would have
  // picked, so the importer lands on the same harness as everything else rather than on a
  // surprising one.
  const listing = ready[0];
  if (listing === undefined) return undefined;
  const model = listing.instance.defaultModel;
  return {
    instanceId: listing.instance.instanceId,
    model,
    origin: "fallback",
    detail: `no configured harness offers ${PREFERRED_IMPORTER_MODEL}, so this uses ${listing.instance.displayName}'s own default model, ${model}`,
  };
};

/**
 * What the operator picked, or the rule's answer, or nothing.
 *
 * An explicit pick wins without being validated against the catalogue **here**: this only
 * names the choice. A *fresh* open checks a named model against its harness's catalogue
 * once the harness is resolved (`scopeImporter.ts` `startWith`, U8 review 5) — the check a
 * model switch makes — because an unknown model was accepted and opened a real session. A
 * reopen passes the model its row recorded, and that is left unchecked: the harness's
 * answer to give rather than ours to pre-empt. An
 * explicit pick of an instance that is not ready still resolves to a choice here and is
 * refused by `HarnessResolver.resolve`, with the resolver's own sentence — never silently
 * swapped for a working one.
 *
 * **That promise is now kept for an instance the catalogue does not list either.** A
 * picked `instanceId` absent from `listings` used to fall through to the rule's answer,
 * which substituted a different harness for the one the operator named — the exact thing
 * the paragraph above says never happens. It now keeps the pick and carries an empty
 * model, which `HarnessResolver.resolve` refuses by name before any model matters.
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

  const pickedModel =
    picked.model !== undefined && picked.model !== ""
      ? picked.model
      : undefined;
  const pickedListing = input.listings.find(
    (listing) => listing.instance.instanceId === instanceId,
  );
  const model =
    pickedModel ??
    (instanceId === resolved?.instanceId
      ? resolved.model
      : // A different instance was picked and no model with it, so the rule's model —
        // which belongs to another harness's catalogue — says nothing here. The chosen
        // instance's own default is what a run would use, and it is the harness's own
        // claim rather than a guess of ours.
        (pickedListing?.instance.defaultModel ?? ""));

  return {
    instanceId,
    model,
    origin: resolved?.origin ?? "fallback",
    detail:
      pickedListing === undefined
        ? `chosen on the create-target screen: ${instanceId}, which this server does not configure`
        : resolved !== undefined &&
            instanceId === resolved.instanceId &&
            model === resolved.model
          ? resolved.detail
          : `chosen on the create-target screen: ${model} on ${instanceId}`,
  };
};
