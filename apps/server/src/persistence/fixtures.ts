/**
 * Shared test data for the persistence, MCP and briefing suites. Test-only; nothing in
 * the running server imports this.
 *
 * It lives in one place because the same observation has to be expressible three ways —
 * as a domain value, as a snake_case tool payload, and as rows in a pre-change database
 * — and a drifting copy of it in each suite is how you end up testing three different
 * things while believing you tested one.
 *
 * The strings here deliberately contain single and double quotes. Every value reaches
 * SQLite as a bound parameter, and a test that only ever stores well-behaved text cannot
 * tell a parameterised statement from a concatenated one.
 */
import type { RecordObservationInput } from "@bit/contracts";

/** Text that breaks a concatenated statement and is harmless as a bound parameter. */
export const AWKWARD_TEXT = `the operator said "it's fine"); DROP TABLE observations; --" and meant it`;

/**
 * A two-case observation of one claim.
 *
 * Case 1 saturates one client identity; case 2 sends an otherwise identical request
 * under a different one. That is the shape the single `conditions` field could not
 * express without flattening two identities into one prose string.
 */
export const multiCaseInput = (
  overrides: Partial<RecordObservationInput> = {},
): RecordObservationInput => ({
  operationId: "op-1",
  testedClaim:
    "Varying the X-Client-Id header evades the 10-request per-client limit on POST /login.",
  outcome: "positive",
  setup: `Local rate-limit fixture, counters reset immediately before the run; ${AWKWARD_TEXT}`,
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
      relationships: [
        { subject: "alice", relation: "owns", object: "session-fixed-a" },
      ],
      actions: [
        {
          actorId: "fixed",
          endpoint: "http://127.0.0.1:9/login",
          method: "POST",
          description:
            "Sequential wrong-password logins until the first refusal.",
          requestCount: 11,
          observedBehavior:
            "Requests 1-10 returned 401 invalid_credentials; request 11 returned 429 rate_limited.",
          evidenceRefs: ["transcript://case-saturate"],
        },
      ],
      configuration: "per-client limit 10, per-account limit 100, independent",
      windowStart: 1_000,
      windowEnd: 2_000,
      testBounds: "11 requests, one identity, one sequential window",
      limitations: [
        "Single short window; no window-rollover behaviour measured.",
      ],
    },
    {
      id: "case-rotate",
      purpose:
        "Test whether a different identity is admitted once the first is exhausted.",
      actors: [
        {
          id: "rotated",
          account: "alice",
          role: "end-user",
          clientIdentity: "X-Client-Id request header changed to 'rotated-b'",
        },
        {
          id: "anonymous-probe",
          account: null,
          role: null,
          clientIdentity:
            "X-Client-Id request header set to 'probe-c', no credentials sent",
        },
      ],
      relationships: [],
      actions: [
        {
          actorId: "rotated",
          endpoint: "http://127.0.0.1:9/login",
          method: "POST",
          description:
            "One otherwise identical login under the new header value.",
          requestCount: 1,
          observedBehavior: "Returned 401 invalid_credentials.",
          evidenceRefs: [],
        },
        {
          actorId: "anonymous-probe",
          endpoint: "http://127.0.0.1:9/login",
          method: "POST",
          description:
            "One unauthenticated probe, issued concurrently with the step above.",
          requestCount: 1,
          observedBehavior: "Returned 401 invalid_credentials.",
          evidenceRefs: [],
        },
      ],
      configuration: "same fixture instance, counters untouched between cases",
      windowStart: 2_000,
      windowEnd: 2_500,
      testBounds: "2 requests, two identities",
      limitations: [],
    },
  ],
  interpretation:
    "The limiter keys on the header value, so rotating it admits requests the exhausted value no longer gets.",
  limitations: ["A request header is not a network address."],
  untestedDimensions: ["The per-account limit was never approached."],
  addressesDimensions: [],
  ...overrides,
});

/** The same observation as a snake_case `record_observation` payload. */
export const multiCaseWireArgs = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  operation_id: "op-http-1",
  tested_claim:
    "Varying the X-Client-Id header evades the 10-request per-client limit on POST /login.",
  outcome: "positive",
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
          client_identity: "X-Client-Id request header held at 'fixed-a'",
        },
      ],
      relationships: [
        { subject: "alice", relation: "owns", object: "session-fixed-a" },
      ],
      actions: [
        {
          actor_id: "fixed",
          endpoint: "http://127.0.0.1:9/login",
          method: "POST",
          description:
            "Sequential wrong-password logins until the first refusal.",
          request_count: 11,
          observed_behavior:
            "Requests 1-10 returned 401 invalid_credentials; request 11 returned 429 rate_limited.",
          evidence_refs: ["transcript://case-saturate"],
        },
      ],
      configuration: "per-client limit 10, per-account limit 100, independent",
      window_start: 1_000,
      window_end: 2_000,
      test_bounds: "11 requests, one identity, one sequential window",
      limitations: ["Single short window."],
    },
  ],
  interpretation: "The limiter keys on the header value.",
  limitations: ["A request header is not a network address."],
  untested_dimensions: ["The per-account limit was never approached."],
  addresses_dimensions: [],
  ...overrides,
});

/**
 * A database in the first-slice shape: the original tables, real rows, and no journal.
 *
 * This is what the superseded bootstrap left behind — it ran `CREATE TABLE IF NOT EXISTS`
 * on every start and never recorded what it had applied — so it is the exact starting
 * state the adoption path has to cope with. The observation row's `conditions` is copied
 * in spirit from `apps/server/.runtime/hunt.sqlite`: one `clientIdentity` string naming
 * several identities in sequence, and one `requestCount` totalling all of them. That is
 * why it cannot be rewritten as cases without inventing an allocation, and why it reads
 * back as a summary-format observation.
 */
export const SUMMARY_CONDITIONS = {
  endpoint: "http://127.0.0.1:41317/login",
  account: "alice",
  clientIdentity:
    "Caller-supplied X-Client-Id header: fixed-client-claim1 for saturation, then rotated-client-a, rotated-client-b, and rotated-client-c",
  method: "POST",
  configuration: `Local fixture reset immediately before the run; ${AWKWARD_TEXT}`,
  windowStart: 1_792_395_926_371,
  windowEnd: 1_792_395_926_439,
  requestCount: 14,
};

export const SUMMARY_OBSERVATION_ID = "obs_000001_attempt-summary";
/** An attempt the first-slice database left running, as the real one was found. */
export const RUNNING_ATTEMPT_ID = "attempt-abandoned";
export const RUNNING_ATTEMPT_SESSION = "ses_abandoned";
export const SUMMARY_RECEIPT_KEY =
  "fixture-local/attempt-summary:record_observation:summary-op-1";

/** Creates the first-slice database at `filename`, with one observation and its receipt. */
export const writeFirstSliceDatabase = async (
  filename: string,
): Promise<void> => {
  const { Database } = await import("bun:sqlite");
  const database = new Database(filename, { create: true, strict: true });
  try {
    database.exec("PRAGMA foreign_keys = ON");
    for (const statement of [
      `CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY, target_id TEXT NOT NULL, description TEXT NOT NULL,
        created_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS intents (
        id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id),
        target_id TEXT NOT NULL, question TEXT NOT NULL, created_at INTEGER NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS intents_goal_idx ON intents(goal_id)`,
      `CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY, intent_id TEXT NOT NULL REFERENCES intents(id),
        target_id TEXT NOT NULL, worker_id TEXT NOT NULL, harness_session_id TEXT,
        provider_id TEXT NOT NULL, model_id TEXT NOT NULL, status TEXT NOT NULL,
        started_at INTEGER NOT NULL, ended_at INTEGER)`,
      `CREATE INDEX IF NOT EXISTS attempts_intent_idx ON attempts(intent_id)`,
      `CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, target_id TEXT NOT NULL,
        intent_id TEXT NOT NULL REFERENCES intents(id),
        attempt_id TEXT NOT NULL REFERENCES attempts(id),
        harness_session_id TEXT NOT NULL, worker_id TEXT NOT NULL,
        tested_claim TEXT NOT NULL, outcome TEXT NOT NULL, conditions TEXT NOT NULL,
        observed_behavior TEXT NOT NULL, interpretation TEXT NOT NULL,
        evidence_refs TEXT NOT NULL, limitations TEXT NOT NULL,
        untested_dimensions TEXT NOT NULL, recorded_at INTEGER NOT NULL)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS observations_sequence_idx ON observations(sequence)`,
      `CREATE INDEX IF NOT EXISTS observations_intent_idx ON observations(intent_id)`,
      `CREATE TABLE IF NOT EXISTS command_receipts (
        key TEXT PRIMARY KEY, caller_scope TEXT NOT NULL, operation TEXT NOT NULL,
        operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, result TEXT NOT NULL,
        created_at INTEGER NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS command_receipts_scope_idx ON command_receipts(caller_scope)`,
      `CREATE TABLE IF NOT EXISTS sequence_cursor (
        name TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0)`,
    ]) {
      database.run(statement);
    }

    database.run(
      `INSERT INTO goals (id, target_id, description, created_at) VALUES (?, ?, ?, ?)`,
      [
        "goal-ratelimit",
        "fixture-local",
        "Can auth rate limits be bypassed?",
        1,
      ],
    );
    database.run(
      `INSERT INTO intents (id, goal_id, target_id, question, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        "intent-per-client-limiter",
        "goal-ratelimit",
        "fixture-local",
        "Probe the per-client limiter on POST /login.",
        1,
      ],
    );
    database.run(
      `INSERT INTO attempts (id, intent_id, target_id, worker_id, harness_session_id,
         provider_id, model_id, status, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "attempt-summary",
        "intent-per-client-limiter",
        "fixture-local",
        "worker-1",
        "ses_summary",
        "openai",
        "gpt-5.6-sol",
        "succeeded",
        1,
        2,
      ],
    );
    /**
     * A second attempt, still running.
     *
     * The first-slice database has to carry one, for two reasons. Write authority is
     * now checked against the attempt's status, so a test that records a *new*
     * observation against an adopted database needs a live attempt to record it under —
     * `attempt-summary` is settled, and settled is exactly what must be refused. And
     * reconciliation needs a real adopted `running` row to reconcile, which is the
     * state the development database was actually found in.
     */
    database.run(
      `INSERT INTO attempts (id, intent_id, target_id, worker_id, harness_session_id,
         provider_id, model_id, status, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        RUNNING_ATTEMPT_ID,
        "intent-per-client-limiter",
        "fixture-local",
        "worker-1",
        RUNNING_ATTEMPT_SESSION,
        "openai",
        "gpt-5.6-sol",
        "running",
        3,
        null,
      ],
    );
    database.run(
      `INSERT INTO observations (id, sequence, target_id, intent_id, attempt_id,
         harness_session_id, worker_id, tested_claim, outcome, conditions,
         observed_behavior, interpretation, evidence_refs, limitations,
         untested_dimensions, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        SUMMARY_OBSERVATION_ID,
        1,
        "fixture-local",
        "intent-per-client-limiter",
        "attempt-summary",
        "ses_summary",
        "worker-1",
        "Sending a different X-Client-Id header value evades the per-client request limit.",
        "positive",
        JSON.stringify(SUMMARY_CONDITIONS),
        "Requests 1-10 returned 401; request 11 returned 429; three rotated identities then returned 401.",
        "The limiter keys on the header value.",
        JSON.stringify(["transcript://summary-run"]),
        JSON.stringify([`Tested one short window; ${AWKWARD_TEXT}`]),
        JSON.stringify(["Per-account limiting was out of scope."]),
        1_792_395_958_800,
      ],
    );
    database.run(
      `INSERT INTO command_receipts (key, caller_scope, operation, operation_id,
         request_hash, result, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        SUMMARY_RECEIPT_KEY,
        "fixture-local/attempt-summary",
        "record_observation",
        "summary-op-1",
        "a-hash-from-the-old-build",
        JSON.stringify({
          observationId: SUMMARY_OBSERVATION_ID,
          sequence: 1,
          replayed: false,
          provenance: {
            targetId: "fixture-local",
            intentId: "intent-per-client-limiter",
            attemptId: "attempt-summary",
            harnessSessionId: "ses_summary",
            workerId: "worker-1",
            recordedAt: 1_792_395_958_800,
          },
        }),
        1_792_395_958_800,
      ],
    );
    database.run(
      `INSERT INTO sequence_cursor (name, value) VALUES ('observations', 1)`,
    );
  } finally {
    database.close();
  }
};
