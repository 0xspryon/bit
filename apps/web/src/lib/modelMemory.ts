/**
 * The harness and model the operator last picked for a new session, per owner (U8 review):
 * the importer's per target since U8, any chat's since the chat generalisation (slice 2).
 *
 * Every opening of the importer — "Auto-load…", a reload of `/assets/chat`, a deep link —
 * starts a fresh page, and a fresh page used to take D15's rule (`importerModel` on the
 * server: prefer a free model on any ready harness) every time. An operator who had picked
 * a model was put back on the free one, which is often out of quota. So the pick is kept,
 * in this browser, and used when it can still be honoured; D15's rule is what is left when
 * it cannot.
 *
 * **It is a preference, not a fact about the server.** It is checked against the catalogue
 * the server last listed ({@link usableRemembered}) every time it is used: a harness that is
 * not ready, or a model it no longer lists, is not offered, and the server's own default
 * stands. `localStorage` because a reload and a new tab should both find it; a store that
 * throws (blocked site data, a private window) remembers nothing and costs nothing.
 */
import { Option, Schema } from "effect";

import type { HarnessInstanceView } from "@bit/contracts";

/** A harness instance and a model in its catalogue. */
export interface RememberedModel {
  readonly instanceId: string;
  readonly model: string;
}

/**
 * Where picks are kept. The browser's {@link browserModelMemory}, or a test's own.
 *
 * `owner` names whose pick it is: the importer's is its **target id**, as it has been since
 * U8, so its stored key is unchanged. Another owner names itself so no target id can collide
 * with it, as `goal/<goalId>` would.
 */
export interface ModelMemory {
  read(serverUrl: string, owner: string): RememberedModel | undefined;
  write(serverUrl: string, owner: string, pick: RememberedModel): void;
}

const Remembered = Schema.Struct({
  instanceId: Schema.String,
  model: Schema.String,
});
const decodeRemembered = Schema.decodeUnknownOption(
  Schema.fromJsonString(Remembered),
);

/**
 * One key per server and owner: an owner names one chat on one server only. The prefix is the
 * importer's from before the generalisation, kept so a pick remembered then is read back.
 */
const keyOf = (serverUrl: string, owner: string): string =>
  `bit.importerModel:${JSON.stringify([serverUrl, owner])}`;

// V2(chat): V1 keeps the harness and model only. The reasoning and other options picked
// with them (`importModelOptionsByModel`) are not kept across a reload, so a remembered
// model comes back on its own defaults. V2 could keep them beside it, checked against the
// model's descriptors as `explicitModelOptionSelections` checks a send.
/** {@link ModelMemory} over `localStorage`. Every failure to read or write is a no-op. */
export const browserModelMemory: ModelMemory = {
  read(serverUrl, owner) {
    try {
      const stored = globalThis.localStorage?.getItem(keyOf(serverUrl, owner));
      if (stored === null || stored === undefined) return undefined;
      return Option.getOrUndefined(decodeRemembered(stored));
    } catch {
      return undefined;
    }
  },
  write(serverUrl, owner, pick) {
    try {
      globalThis.localStorage?.setItem(
        keyOf(serverUrl, owner),
        JSON.stringify({ instanceId: pick.instanceId, model: pick.model }),
      );
    } catch {
      // Blocked site data: the pick lasts as long as the page, as it did before.
    }
  },
};

/**
 * The remembered pick when the server can still honour it, else `undefined`: its harness is
 * listed and ready, and its model is in that harness's catalogue.
 */
export const usableRemembered = (
  remembered: RememberedModel | undefined,
  harnesses: readonly Pick<
    HarnessInstanceView,
    "instanceId" | "ready" | "models"
  >[],
): RememberedModel | undefined => {
  if (remembered === undefined || remembered.model === "") return undefined;
  const harness = harnesses.find(
    (each) => each.instanceId === remembered.instanceId,
  );
  if (harness?.ready !== true) return undefined;
  return harness.models.some((each) => each.id === remembered.model)
    ? remembered
    : undefined;
};
