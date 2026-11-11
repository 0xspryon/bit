/**
 * The provider names a Claude Code instance's sessions **reported** for its catalogue models,
 * kept across restarts (follow-ups A review, M2).
 *
 * ## Why they are kept
 *
 * An aliasing instance (a z.ai config folder mapping `opus` to `glm-5.3`) that declares no
 * `reportedAs` for a model learns the provider's name from a live session
 * (`modelSpellings.ts`): the CLI's `system/init` frame, and the context read right after a
 * switch, name the model the session was asked for in the provider's spelling. Held in
 * memory only, a restart forgot it, and until a session spoke again the picker, the chip
 * and the meter said `opus` — and the meter read the stored transcript's `glm-5.3` as a
 * model nobody picked ("Measured on glm-5.3's last call. The next call, on opus…").
 *
 * ## Why kept, rather than learned again from a replay
 *
 * A replay has the provider's name of every stored call (`message.model`) but not which
 * catalogue entry each call was asked for. The session's row names the model it is set to
 * **now**, and that is not the model of its last call whenever a switch has not been used
 * yet — a switch recorded while no process held the session, or one made live with no call
 * since. Pairing the two would teach `glm-5.3-flash` as the name of `opus` after any such
 * switch, and every frame would then be relabelled wrongly. What is kept here was learned
 * only where the harness knew both halves, so it cannot be wrong that way.
 *
 * ## Why a file, not the database
 *
 * A harness layer is built by the resolver and holds no database client: nothing of the
 * fleet store reaches it, by design. The owned-process records (`ownedProcesses.ts`) set
 * the precedent for the harness's own bookkeeping — a file under the fleet root, scoped to
 * this installation. This is a cache of something any live session reports again: a lost or
 * unreadable file costs the alias until then, never a wrong name, and is never fatal.
 *
 * One file per instance, `<fleet root>/harness/model-names/<instance id>.json`, rewritten
 * whole (to a temporary file, then renamed) when a learned name changes.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Schema } from "effect";

/** Where one installation keeps its instances' learned names. */
export const learnedModelNamesDirectory = (huntRoot: string): string =>
  join(huntRoot, "harness", "model-names");

/** One instance's file. Instance ids are slugs (`identity.ts`), so safe as a file name. */
export const learnedModelNamesFile = (
  huntRoot: string,
  instanceId: string,
): string => join(learnedModelNamesDirectory(huntRoot), `${instanceId}.json`);

const StoredNames = Schema.Struct({
  /** Catalogue id → the provider's name for it, as a session last reported it. */
  names: Schema.Record(Schema.String, Schema.String),
});

/** The names one file holds; empty when it is missing or unreadable. */
export const readLearnedModelNames = (
  path: string,
): ReadonlyMap<string, string> => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return new Map();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return new Map();
  }
  const decoded = Schema.decodeUnknownExit(StoredNames)(raw);
  if (decoded._tag === "Failure") return new Map();
  return new Map(
    Object.entries(decoded.value.names).filter(
      ([id, name]) => id.trim() !== "" && name.trim() !== "",
    ),
  );
};

/**
 * Writes one instance's names whole. `false` when the file could not be written: the names
 * are then known to this process only, as before (M2), which is said by the caller.
 */
export const writeLearnedModelNames = (
  path: string,
  names: ReadonlyMap<string, string>,
): boolean => {
  const temporary = `${path}.${String(process.pid)}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      temporary,
      `${JSON.stringify({ names: Object.fromEntries(names) }, null, 2)}\n`,
      "utf8",
    );
    renameSync(temporary, path);
    return true;
  } catch {
    return false;
  }
};
