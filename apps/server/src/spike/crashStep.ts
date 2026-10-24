/**
 * One step of the persistence proof, in a process that is killed on purpose.
 *
 * Run as a child by `persistenceProof.ts` and never imported — importing an entrypoint
 * runs it, which is the hazard §22 recorded after it cost a run. It takes its work from
 * argv so the parent can describe a step without this file knowing the proof's shape.
 *
 * ```sh
 * bun src/spike/crashStep.ts <root> <targetId> <mode>
 * ```
 *
 * Three modes, and the difference between the last two is the whole point:
 *
 * - `write` — seed an attempt and record one asset and one observation, then exit
 *   cleanly. The baseline the later steps are compared against.
 * - `between` — record one mutation, then `SIGKILL` **this process** before the second.
 *   The first must survive and the second must not exist. This is the ordinary crash.
 * - `inside` — open a transaction, run a complete mutation inside it so that every row
 *   it writes has been issued to SQLite, and then `SIGKILL` this process **before the
 *   outer transaction commits**. Nothing may survive. §4 asks for exactly this: proving
 *   nothing is half-written means killing the process mid-transaction, not asserting
 *   that SQLite is atomic.
 *
 * `process.kill(process.pid, "SIGKILL")` rather than `process.exit`, a thrown error or an
 * interrupt: all three of those run finalizers, which would close the database cleanly
 * and commit or roll back in an orderly way. `SIGKILL` cannot be caught, so no finalizer
 * runs, the file is left exactly as the operating system found it, and recovery is
 * SQLite's own journal rather than ours.
 */
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";

import { FleetStore } from "../persistence/fleet";
import { sqliteLayer } from "../persistence/sql";
import { ObservationStore, type CallerContext } from "../persistence/store";
import { runMain } from "./main";

const [root, targetId, mode] = process.argv.slice(2);
if (root === undefined || targetId === undefined || mode === undefined) {
  console.error("usage: crashStep.ts <root> <targetId> write|between|inside");
  process.exit(2);
}

export const GOAL_ID = "goal-ratelimit";
export const INTENT_ID = "intent-per-client-limiter";
export const ATTEMPT_ID = "attempt-crash";
export const SURVIVING_OPERATION = "op-survives-the-crash";
export const LOST_OPERATION = "op-never-committed";

const caller: CallerContext = {
  callerScope: `${targetId}/${ATTEMPT_ID}`,
  targetId,
  intentId: INTENT_ID,
  attemptId: ATTEMPT_ID,
  harnessSessionId: "ses_crash",
  workerId: "worker-crash",
  attemptFence: 0,
};

const assetInput = (operationId: string, path: string, method = "POST") => ({
  operationId,
  kind: "endpoint" as const,
  url: `http://127.0.0.1:41317${path}`,
  method,
  note: "Observed in the fixture's own route table.",
});

const observationInput = (operationId: string) => ({
  operationId,
  testedClaim:
    "Varying the X-Client-Id header evades the 10-request per-client limit on POST /login.",
  outcome: "positive" as const,
  setup: "Local rate-limit fixture, counters reset immediately before the run.",
  cases: [
    {
      id: "case-saturate",
      purpose: "Establish the per-client threshold under one fixed identity.",
      actors: [
        {
          id: "fixed",
          account: "alice",
          role: "end-user",
          clientIdentity: "X-Client-Id request header held at 'fixed-a'",
        },
      ],
      relationships: [],
      actions: [
        {
          actorId: "fixed",
          endpoint: "http://127.0.0.1:41317/login",
          method: "POST",
          description:
            "Sequential wrong-password logins until the first refusal.",
          requestCount: 11,
          observedBehavior:
            "Requests 1-10 returned 401 invalid_credentials; request 11 returned 429 rate_limited.",
          evidenceRefs: [],
        },
      ],
      configuration: "per-client limit 10, per-account limit 100, independent",
      windowStart: 1_000,
      windowEnd: 2_000,
      testBounds: "11 requests, one identity, one sequential window",
      limitations: ["Single short window; no window rollover measured."],
    },
  ] as const,
  interpretation:
    "The limiter keys on the header value, so rotating it admits requests the exhausted value no longer gets.",
  limitations: ["A request header is not a network address."],
  untestedDimensions: [
    "The per-account limit was never approached.",
    "No window rollover was measured.",
  ],
  addressesDimensions: [] as readonly string[],
});

/** Kills this process outright. Nothing after this line runs, by design. */
const hardKill = (why: string): never => {
  console.log(`crashStep: SIGKILL (${why})`);
  process.kill(process.pid, "SIGKILL");
  // Unreachable: SIGKILL cannot be caught or deferred. Present so the signature is
  // honest and so a reader does not look for a return value that never arrives.
  throw new Error("unreachable: SIGKILL did not take effect");
};

const program = Effect.gen(function* () {
  const store = yield* ObservationStore;
  yield* store.seedAttempt({
    targetId: targetId as string,
    goalId: GOAL_ID,
    goal: "Determine whether authentication rate limits on the fixture can be bypassed.",
    intentId: INTENT_ID,
    question:
      "Probe the per-client request limiter on POST /login; leave any per-account limit untested.",
    attemptId: ATTEMPT_ID,
    workerId: "worker-crash",
    harnessInstanceId: "opencode",
    providerId: "openai",
    modelId: "gpt-5.6-sol",
    // The spikes dispatch no model options, so there is nothing to record.
    modelOptions: null,
    harnessSessionId: "ses_crash",
  });

  if (mode === "write") {
    const asset = yield* store.recordAsset(
      caller,
      assetInput(SURVIVING_OPERATION, "/login"),
    );
    const observation = yield* store.recordObservation(
      caller,
      observationInput("op-first-observation"),
    );
    console.log(
      `crashStep: wrote asset ${asset.assetId} and observation ${observation.observationId}`,
    );
    return;
  }

  if (mode === "between") {
    const asset = yield* store.recordAsset(
      caller,
      assetInput(SURVIVING_OPERATION, "/login"),
    );
    console.log(`crashStep: committed asset ${asset.assetId}`);
    // Killed between two mutations. The first has committed and must survive; the
    // second has not started and must leave no trace.
    hardKill("between two mutations");
  }

  if (mode === "inside") {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        // A complete mutation, inside an outer transaction that will never commit. By
        // the time this returns, SQLite has been handed the asset row, its discovery
        // row, the command receipt, the event and the outbox entry.
        const asset = yield* store.recordAsset(
          caller,
          assetInput(LOST_OPERATION, "/reset"),
        );
        console.log(
          `crashStep: wrote asset ${asset.assetId} inside an uncommitted transaction`,
        );
        return hardKill("inside an uncommitted transaction");
      }),
    );
    return;
  }

  console.error(`crashStep: unknown mode ${mode}`);
  process.exit(2);
});

/**
 * The store and the raw client over **one** connection.
 *
 * `targetStoreLayer` is the ordinary way in and hides the client, which is right for
 * every other caller. The `inside` mode needs the client that the store itself uses: two
 * connections would mean two transactions, and the outer one would simply block on
 * SQLite's single write lock rather than containing the inner. `layerWithClient` builds
 * the store over a client this layer also exposes, and the registry is still what decides
 * which file is opened — the path is never assembled here.
 */
const layer = Layer.unwrap(
  Effect.gen(function* () {
    const fleet = yield* FleetStore;
    const file = yield* fleet.huntFileFor(targetId as string);
    return ObservationStore.layerWithClient.pipe(
      Layer.provideMerge(sqliteLayer(file)),
    );
  }),
).pipe(Layer.provide(FleetStore.layer(root as string)));

runMain(Effect.scoped(program.pipe(Effect.provide(layer))));
