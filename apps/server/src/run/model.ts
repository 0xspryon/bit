/**
 * Which harness a server drives, read from the environment.
 *
 * There used to be a `WORKER_MODEL` constant here: one provider-and-model pair, pinned,
 * because there was one harness and no picker. Both halves of that have moved. The model a
 * run gets when it names none now belongs to the **instance** — `HarnessInstance.
 * defaultModel`, set by whichever harness layer the composition root builds — because
 * `openai/gpt-5.6-sol` is not a thing Claude Code could run and a single constant would
 * have had to be wrong for one of them. What is left here is the smaller question that is
 * genuinely the deployment's: *which harness*.
 *
 * It stays a module of its own rather than an `if` in `main.ts` because the mapping from an
 * environment variable to a driver is a decision with a backward-compatibility obligation
 * in it — see {@link harnessSelection} on `HARNESS=0` — and because the test for it should
 * not have to build a server.
 *
 * **This is not a picker.** An operator cannot choose per run; slice C owns that, and it
 * will arrive as a resolver in front of `AgentHarness` rather than as a second environment
 * variable. Until then a server drives one harness, and an attempt records which.
 */
import {
  CLAUDE_CODE_DRIVER,
  OPENCODE_DRIVER,
  type DriverKind,
} from "../harness/identity";

/** What `HARNESS` asked for. */
export type HarnessSelection =
  | { readonly _tag: "none" }
  | { readonly _tag: "driver"; readonly driver: DriverKind }
  | { readonly _tag: "unknown"; readonly value: string };

/**
 * Reads `HARNESS` into a selection.
 *
 * - **unset** → OpenCode, because that is what every existing deployment is running and a
 *   slice that silently switched their harness would be changing what their evidence says
 *   ran, retroactively and without being asked.
 * - **`0`** → no harness. Kept exactly as it was: the server boots, serves, sweeps and
 *   reconciles, and refuses every start by name.
 * - **a driver slug** → that harness. Matched against the drivers this build has, by slug,
 *   so adding a third is a new case in one `switch` here and nothing anywhere else.
 * - **anything else** → `unknown`, which the composition root reports and then treats as
 *   no harness. Not a silent fallback to OpenCode: a typo in a deployment variable that
 *   quietly ran a different agent than the operator named is the kind of thing nobody
 *   finds until they read the evidence.
 */
export const harnessSelection = (
  value: string | undefined,
): HarnessSelection => {
  if (value === undefined || value === "") {
    return { _tag: "driver", driver: OPENCODE_DRIVER };
  }
  if (value === "0") return { _tag: "none" };
  switch (value) {
    case OPENCODE_DRIVER:
      return { _tag: "driver", driver: OPENCODE_DRIVER };
    case CLAUDE_CODE_DRIVER:
      return { _tag: "driver", driver: CLAUDE_CODE_DRIVER };
    default:
      return { _tag: "unknown", value };
  }
};

/** The slugs {@link harnessSelection} accepts, for an error message that can list them. */
export const KNOWN_DRIVERS: readonly DriverKind[] = [
  OPENCODE_DRIVER,
  CLAUDE_CODE_DRIVER,
];
