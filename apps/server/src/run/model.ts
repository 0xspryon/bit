/**
 * Which harnesses a server drives, read from the environment.
 *
 * There used to be a `WORKER_MODEL` constant here: one provider-and-model pair, pinned,
 * because there was one harness and no picker. Both halves of that have moved. The model a
 * run gets when it names none belongs to the **instance** — `HarnessInstance.defaultModel`
 * — because `openai/gpt-5.6-sol` is not a thing Claude Code could run and a single
 * constant would have had to be wrong for one of them. What is left here is the smaller
 * question that is genuinely the deployment's: *which harnesses*.
 *
 * It stays a module of its own rather than an `if` in `main.ts` because the mapping from an
 * environment variable to a set of drivers is a decision with a backward-compatibility
 * obligation in it — see {@link harnessSelection} on `HARNESS=0` and on an unset variable
 * — and because the test for it should not have to build a server.
 *
 * **Which harness a *run* uses is no longer this module's business.** That is
 * `harness/resolver.ts`, in front of `AgentHarness`, and this is only the list of
 * candidates it is handed. The distinction matters: this answers "what did the operator
 * configure", and the resolver answers "which of those came up and which one does this run
 * get".
 */
import {
  CLAUDE_CODE_DRIVER,
  OPENCODE_DRIVER,
  type DriverKind,
} from "../harness/identity";

/** The slugs {@link harnessSelection} accepts, in the order a server tries them. */
export const KNOWN_DRIVERS: readonly DriverKind[] = [
  OPENCODE_DRIVER,
  CLAUDE_CODE_DRIVER,
];

/** What `HARNESS` asked for. */
export interface HarnessSelection {
  /**
   * The drivers to configure, in preference order.
   *
   * Order is load-bearing: the resolver's default instance is the first *ready* one, so
   * `HARNESS=claude-code,opencode` is how an operator says which harness an unqualified
   * run should land on.
   */
  readonly drivers: readonly DriverKind[];
  /**
   * Entries this build does not recognise, kept rather than dropped.
   *
   * A typo must be reported by name. Silently configuring the drivers that *were* spelled
   * correctly and saying nothing about the one that was not is how an operator ends up
   * reading evidence from an agent they did not name.
   */
  readonly unknown: readonly string[];
  /** `HARNESS=0`: no harness at all, and every start refused by name. */
  readonly off: boolean;
}

/**
 * Reads `HARNESS` into a selection.
 *
 * - **unset** → **every driver this build has**, which is the one deliberate change to
 *   slice B's reading of this variable. A picker over a single instance is not a picker,
 *   and the cost of configuring both is now bounded rather than fatal: a harness that will
 *   not start stays visible in the picker with its reason
 *   (`harness/resolver.ts`), so an installation with only one of the two installed behaves
 *   exactly as it did before except that the other is listed and says why it is not usable.
 *   An operator who wants only one — to avoid spawning an `opencode serve` they will not
 *   use, say — names it, which is what this variable was always for.
 * - **`0`** → no harness. Kept exactly as it was: the server boots, serves, sweeps and
 *   reconciles, and refuses every start by name.
 * - **a comma-separated list of driver slugs** → those harnesses, in that order,
 *   deduplicated. A single slug is the one-element case, so every slice-B deployment that
 *   set `HARNESS=opencode` or `HARNESS=claude-code` gets exactly what it got before.
 * - **anything unrecognised** → kept in {@link HarnessSelection.unknown} and reported. Not
 *   a silent fallback: a typo in a deployment variable that quietly ran a different agent
 *   than the operator named is the kind of thing nobody finds until they read the evidence.
 *
 * `0` anywhere in a list wins and turns the whole thing off, because "no harness" and "this
 * harness" cannot both be meant and the safe reading of a contradiction is the one that
 * runs nothing.
 */
export const harnessSelection = (
  value: string | undefined,
): HarnessSelection => {
  if (value === undefined || value.trim() === "") {
    return { drivers: KNOWN_DRIVERS, unknown: [], off: false };
  }
  const asked = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (asked.includes("0")) {
    return { drivers: [], unknown: [], off: true };
  }
  const drivers: DriverKind[] = [];
  const unknown: string[] = [];
  for (const entry of asked) {
    const known = KNOWN_DRIVERS.find((driver) => driver === entry);
    if (known === undefined) {
      if (!unknown.includes(entry)) unknown.push(entry);
    } else if (!drivers.includes(known)) {
      drivers.push(known);
    }
  }
  return { drivers, unknown, off: false };
};

/** One line for the startup log, so what a server drives is never inferred from silence. */
export const renderSelection = (selection: HarnessSelection): string =>
  selection.off
    ? "none (HARNESS=0) — every run is refused"
    : selection.drivers.length === 0
      ? `none — HARNESS names only ${selection.unknown.map((entry) => `'${entry}'`).join(", ")}, and this build has ${[...KNOWN_DRIVERS, "0"].join(", ")}`
      : `${selection.drivers.join(", ")}${
          selection.unknown.length === 0
            ? ""
            : ` (ignoring ${selection.unknown.map((entry) => `'${entry}'`).join(", ")}, which this build does not have)`
        }`;
