/**
 * The checks and answers a model switch of a conversation shares, whichever kind it is (A6
 * F4).
 *
 * Two surfaces switch — the scope importer (`import/scopeImporter.ts`) and the goal
 * conversation (`plan/goalConversation.ts`) — and they differ only in where their row lives
 * and what makes one ended. Everything a switch *means* is here or in the spine
 * (`harness/liveAgentSessions.ts`'s `switchModel`), so the two cannot drift on which model
 * is acceptable, what an option becomes, or what an uncertain answer is called.
 */
import {
  ConversationModelRefused,
  type ConversationModelApplied,
  type ConversationModelSwitched,
  type ModelOptionSelection,
} from "@bit/contracts";
import { Effect } from "effect";

import type { AgentHarness } from "./agentHarness";
import type { ModelSwitchFailure } from "./liveAgentSessions";
import { modelOptionsFor } from "./modelOptions";
import type { HarnessResolver } from "./resolver";

/** What a switch request has been checked into: a model the pinned harness lists. */
export interface CheckedModelSwitch {
  readonly harness: AgentHarness["Service"];
  readonly instanceId: string;
  readonly model: string;
  /** Resolved against {@link model}'s descriptors; absent for nothing chosen. */
  readonly options: readonly ModelOptionSelection[] | undefined;
  /** Selection ids the request set that {@link model} does not offer. */
  readonly dropped: readonly string[];
}

/**
 * Checks a requested model against the conversation's **pinned** harness instance, and
 * resolves its options against that model's descriptors.
 *
 * The order is the brief's, and the first check is load-bearing beyond politeness: OpenCode's
 * `switchModel` decodes the model id with a decoder that **throws** on a malformed one, so a
 * model is only ever handed to a harness once it is a name that harness's own catalogue
 * listed. A model of another harness is refused by the same check: there is no way to name
 * a harness here, and the instance is the row's.
 *
 * Options a model does not offer are dropped and reported, never refused, as an open treats
 * them: a picker holding a selection made for the previous model is the expected case.
 */
export const checkModelSwitch = (input: {
  readonly resolver: HarnessResolver["Service"];
  readonly instanceId: string;
  readonly model: string;
  readonly requested: readonly ModelOptionSelection[] | undefined;
  /** "this import", "goal g_…'s conversation": the subject of the sentences. */
  readonly what: string;
}): Effect.Effect<CheckedModelSwitch, ConversationModelRefused> =>
  Effect.gen(function* () {
    const resolved = yield* input.resolver.resolve(input.instanceId).pipe(
      Effect.mapError(
        (failure) =>
          new ConversationModelRefused({
            reason: "harness_not_ready",
            detail: `${failure.message}. ${capitalised(input.what)} is pinned to that harness, so its model cannot be switched until it is usable again.`,
          }),
      ),
    );
    const harness = resolved.harness;
    const listed = harness.instance.models.map((entry) => entry.id);
    if (!listed.includes(input.model)) {
      return yield* new ConversationModelRefused({
        reason: "model_unavailable",
        detail: `'${input.model}' is not a model harness instance '${input.instanceId}' offers (${
          listed.length === 0
            ? "it reported none"
            : `it offers ${listed.map((id) => `'${id}'`).join(", ")}`
        }). ${capitalised(input.what)} is pinned to that harness; a model of another harness is a new session.`,
      });
    }
    const { options, dropped } = modelOptionsFor(
      harness,
      input.model,
      input.requested,
    );
    return {
      harness,
      instanceId: input.instanceId,
      model: input.model,
      options,
      dropped,
    };
  });

/**
 * The one order a list of options is compared in, and what "nothing chosen" is: `[]`.
 * `persistence/store.ts`'s `canonicalModelOptions`, for a comparison rather than a column.
 */
const canonical = (
  options: readonly ModelOptionSelection[] | null | undefined,
): readonly ModelOptionSelection[] =>
  [...(options ?? [])].sort((left, right) => left.id.localeCompare(right.id));

/** Whether a row already says exactly this model and these options. */
export const sameModelChoice = (
  row: {
    readonly model: string | null;
    readonly modelOptions: readonly ModelOptionSelection[] | null;
  },
  checked: CheckedModelSwitch,
): boolean => {
  if (row.model !== checked.model) return false;
  const before = canonical(row.modelOptions);
  const after = canonical(checked.options);
  return (
    before.length === after.length &&
    before.every(
      (option, index) =>
        option.id === after[index]?.id && option.value === after[index]?.value,
    )
  );
};

/** What an accepted switch answers with. */
export const modelSwitched = (input: {
  readonly conversationId: string;
  readonly checked: CheckedModelSwitch;
  readonly applied: ConversationModelApplied;
  readonly changed: boolean;
}): ConversationModelSwitched => ({
  conversationId: input.conversationId,
  harnessInstanceId: input.checked.instanceId,
  model: input.checked.model,
  modelOptions: canonical(input.checked.options),
  droppedModelOptionIds: [...input.checked.dropped],
  applied: input.applied,
  changed: input.changed,
});

/**
 * The spine's failures, in the operator's words.
 *
 * `previous` is what the row said before, for the uncertain case: the dialog has to say
 * what is still recorded, because that is what the picker will go on showing.
 */
export const modelSwitchRefusal = (
  failure: ModelSwitchFailure,
  input: {
    readonly what: string;
    readonly model: string;
    readonly previous: string | null;
  },
): ConversationModelRefused => {
  switch (failure._tag) {
    case "ModelSwitchInFlight":
      return new ConversationModelRefused({
        reason: "switch_in_flight",
        detail: `another model switch of ${input.what} has not answered yet. Switches are not queued: wait for it to finish, then pick again.`,
      });
    case "ModelSwitchUncertain":
      return new ConversationModelRefused({
        reason: "harness_unreachable",
        detail: `${failure.failure.message}. The harness did not clearly answer, so whether ${input.what} moved to '${input.model}' is uncertain; its record still says ${
          input.previous === null ? "no model" : `'${input.previous}'`
        }. Switching again settles it.`,
      });
    case "ModelSwitchStale":
      return new ConversationModelRefused({
        reason: "harness_not_ready",
        detail: `${input.what} is live on harness instance '${failure.liveInstanceId}', not on the one its record names, so the model was not switched. Reload and pick again.`,
      });
  }
};

/** The sentence for a row write that failed, said differently once the harness has moved. */
export const recordRefusal = (input: {
  readonly what: string;
  readonly model: string;
  readonly harnessMoved: boolean;
  readonly detail: string;
}): ConversationModelRefused =>
  new ConversationModelRefused({
    reason: "store_unavailable",
    detail: input.harnessMoved
      ? `the harness moved ${input.what} to '${input.model}', but its record could not be written (${input.detail}), so a reopen would still use the old model. Switching to '${input.model}' again records it.`
      : `${input.what}'s record could not be written (${input.detail}), so nothing was switched.`,
  });

const capitalised = (text: string): string =>
  text.length === 0 ? text : `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
