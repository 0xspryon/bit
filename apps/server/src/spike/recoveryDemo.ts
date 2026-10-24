/**
 * Startup recovery against a real database and a real harness.
 *
 * ```sh
 * bun run src/spike/recoveryDemo.ts --database .runtime/hunt.sqlite
 * bun run src/spike/recoveryDemo.ts --database <path> --no-harness
 * ```
 *
 * This is the path §20 recorded as the largest open gap: two attempts in the
 * development database sat at `status: "running"` with real session IDs since an
 * interruption test, and nothing could settle them. They have since been reconciled
 * through this path (DECISIONS.md §22), so a run against that file now finds nothing to
 * do unless something has been left behind again. It reconciles whatever it finds —
 * `running` and `uncertain` rows alike, since an `uncertain` one is an admission a later
 * definite answer may refine — and it reports what the harness actually said rather
 * than assuming.
 *
 * `--no-harness` spawns nothing and answers `missing` for every session, which is what a
 * process with no harness honestly knows. It is not a shortcut to a definite answer:
 * `missing` maps to `uncertain`, so the only thing it can produce is an admission.
 *
 * **It modifies the database it is pointed at.** That is the job — the rows are stuck
 * precisely because nothing writes to them — so back up first if the file matters. It
 * only ever writes through `recordRecovery`, which refuses to regress a terminal attempt
 * and never touches an attempt the harness still reports as running.
 */
import { join } from "node:path";

import { Effect, Layer } from "effect";

import { openCodeHarness } from "../harness/openCodeClient";
import { OpenCodeServer } from "../harness/openCodeServer";
import { McpCredentials } from "../mcp/credentials";
import { ObservationStore } from "../persistence/store";
import { HarnessResolver } from "../harness/resolver";
import { HarnessSessionStatus } from "../recovery/harnessStatus";
import {
  reconcileUnsettledAttempts,
  renderReconciliation,
} from "../recovery/reconcile";
import { runMain } from "./main";
import { prepareWorkspace, RUNTIME_DIR } from "./runtime";

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const DATABASE = argument("database") ?? join(RUNTIME_DIR, "hunt.sqlite");
const WITH_HARNESS = !process.argv.includes("--no-harness");
const WORKSPACE = join(RUNTIME_DIR, "recovery-workspace");

const line = (label: string, value: unknown) =>
  console.log(`${label.padEnd(26)} ${String(value)}`);

const program = Effect.gen(function* () {
  const store = yield* ObservationStore;
  line("database", DATABASE);
  line("harness", WITH_HARNESS ? "live opencode serve" : "none (--no-harness)");

  const before = yield* store.unsettledAttempts();
  console.log(`\n-- attempts with no settled outcome (${before.length}) --`);
  for (const attempt of before) {
    console.log(
      `  ${attempt.id}  status=${attempt.status}` +
        `  session=${attempt.harness_session_id ?? "none"}` +
        `  started=${new Date(attempt.started_at).toISOString()}` +
        `  fence=${String(attempt.write_fence)}`,
    );
  }
  if (before.length === 0) {
    console.log("  nothing to reconcile");
  }

  const reconciled = yield* reconcileUnsettledAttempts();

  console.log(`\n-- reconciliation (${reconciled.length}) --`);
  for (const entry of reconciled) {
    console.log(`  ${renderReconciliation(entry)}`);
    console.log(`      harness said: ${entry.harnessDetail}`);
  }

  console.log(`\n-- durable recovery records --`);
  for (const entry of reconciled) {
    for (const record of yield* store.recoveriesForAttempt(entry.attempt.id)) {
      console.log(
        `  ${record.attempt_id}  observed=${record.observed_status}` +
          `  -> ${record.resulting_status} (${record.disposition})` +
          `  fence ${String(record.fence_before)}->${String(record.fence_after)}` +
          `  times=${String(record.times)}` +
          `  observationsHeld=${String(record.observations_at_recovery)}`,
      );
      console.log(`      ${record.detail}`);
    }
  }

  const after = yield* store.unsettledAttempts();
  console.log(
    `\nstill unsettled after reconciliation: ${String(after.length)}` +
      `${after.length === 0 ? "" : ` (${after.map((item) => item.id).join(", ")})`}`,
  );
  // The caveat is printed when it applies, not as boilerplate on every run.
  if (reconciled.some((entry) => entry.outcome.status === "uncertain")) {
    console.log(
      `\nNote: an 'uncertain' disposition is not a statement that the attempt did nothing.` +
        `\nWe could not establish what its session did, and any external effect it had on a` +
        `\ntarget is unknown and was not undone.`,
    );
  }
  console.log(
    `\nThe observation counts above are what this store holds at this moment. They are` +
      `\nnot evidence of what any attempt did: nothing here infers an absent effect from` +
      `\nabsent evidence.`,
  );
  return reconciled.length;
});

/**
 * With a harness: the live adapter over a freshly spawned server, which is exactly the
 * post-restart situation — a new `opencode serve` being asked about an old process's
 * sessions. Without one: scripted answers, all `missing`.
 */
const harnessLayer = WITH_HARNESS
  ? HarnessSessionStatus.layer.pipe(
      // One instance, so the resolver is a wrapper here rather than a choice.
      Layer.provide(HarnessResolver.single),
      Layer.provide(
        openCodeHarness().pipe(
          Layer.provideMerge(OpenCodeServer.layer({ cwd: WORKSPACE })),
          Layer.provide(
            Layer.effectDiscard(
              prepareWorkspace({ workspace: WORKSPACE, files: {} }),
            ),
          ),
        ),
      ),
    )
  : HarnessSessionStatus.fromAnswers({});

runMain(
  Effect.scoped(
    program.pipe(
      Effect.provide(
        Layer.mergeAll(
          ObservationStore.layer(DATABASE),
          harnessLayer,
          McpCredentials.layer,
        ),
      ),
    ),
  ),
);
