/**
 * Shared test data for the persistence, MCP and briefing suites. Test-only; nothing in
 * the running server imports this.
 *
 * It lives in one place because the same observation has to be expressible three ways —
 * as a domain value, as a snake_case tool payload, and as rows in a database — and a
 * drifting copy of it in each suite is how you end up testing three different things
 * while believing you tested one.
 *
 * The strings here deliberately contain single and double quotes. Every value reaches
 * SQLite as a bound parameter, and a test that only ever stores well-behaved text cannot
 * tell a parameterised statement from a concatenated one.
 */
import type { RecordObservationInput } from "@bit/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

import { migrate } from "./migrations";
import { sqliteLayer } from "./sql";

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
 * A database holding one **summary-format** observation, at the current schema.
 *
 * Both observation formats are formats of contract version 1 and neither supersedes the
 * other (`OBSERVATION_CONTRACT_VERSION`), so a suite that only ever stores case-based rows
 * tests half the contract. This is the other half, and it is the only summary row anywhere
 * in the tests: the store reads it back, the briefing renders it, and both have to do so
 * without dressing one prose record up as cases.
 *
 * The `conditions` object is copied in spirit from a real development file: one
 * `clientIdentity` string naming several identities in sequence, and one `requestCount`
 * totalling all of them. That is why it cannot be expressed as cases without inventing an
 * allocation — which is exactly what `summary` exists to refuse (DECISIONS.md §21).
 *
 * The schema comes from {@link migrate}, not from DDL written out here. A fixture that
 * declared its own tables would be a second description of the schema, free to drift from
 * the baseline the moment either changed.
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
/**
 * An attempt this database leaves running, as a real one was found.
 *
 * Needed for two reasons. Write authority is checked against the attempt's status, so a
 * test that records a *new* observation here needs a live attempt to record it under —
 * `attempt-summary` is settled, and settled is exactly what must be refused. And
 * reconciliation needs a real `running` row to reconcile.
 */
export const RUNNING_ATTEMPT_ID = "attempt-abandoned";
export const RUNNING_ATTEMPT_SESSION = "ses_abandoned";
export const SUMMARY_RECEIPT_KEY =
  "fixture-local/attempt-summary:record_observation:summary-op-1";

const SUMMARY_RECORDED_AT = 1_792_395_958_800;

/**
 * The one untested dimension this observation raised, and the row's id.
 *
 * The id is opaque on purpose: a dimension's identity must not encode where it sits in
 * the submitted list, or a later edit to that list would silently re-point every address.
 * `<observationId>#u0` survives as the **wire alias** a briefing prints.
 */
export const SUMMARY_UNTESTED_DIMENSION =
  "Per-account limiting was out of scope.";
const SUMMARY_DIMENSION_ID = "dim_4f1c9a2e7b6d48f0a35c81e9d07b2f6a";

/**
 * Migrates `filename` and writes the summary observation, its receipt and its cursor.
 *
 * The receipt's `request_hash` is deliberately not one this build would compute. A retry of
 * `summary-op-1` therefore has to come back as a **conflict** — same key, different content
 * — rather than replaying, which is the behaviour `store.test.ts` pins.
 */
export const writeSummaryFormatDatabase = (filename: string): Promise<void> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* migrate;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO goals (id, target_id, description, created_at)
          VALUES ('goal-ratelimit', 'fixture-local',
                  'Can auth rate limits be bypassed?', 1)`;
        yield* sql`INSERT INTO intents (id, goal_id, target_id, question, created_at)
          VALUES ('intent-per-client-limiter', 'goal-ratelimit', 'fixture-local',
                  'Probe the per-client limiter on POST /login.', 1)`;
        yield* sql`INSERT INTO attempts (id, intent_id, target_id, worker_id,
            harness_session_id, provider_id, model_id, status, started_at, ended_at)
          VALUES ('attempt-summary', 'intent-per-client-limiter', 'fixture-local',
                  'worker-1', 'ses_summary', 'openai', 'gpt-5.6-sol', 'succeeded', 1, 2)`;
        yield* sql`INSERT INTO attempts (id, intent_id, target_id, worker_id,
            harness_session_id, provider_id, model_id, status, started_at)
          VALUES (${RUNNING_ATTEMPT_ID}, 'intent-per-client-limiter', 'fixture-local',
                  'worker-1', ${RUNNING_ATTEMPT_SESSION}, 'openai', 'gpt-5.6-sol',
                  'running', 3)`;
        yield* sql`INSERT INTO observations (
            id, sequence, record_format, target_id, intent_id, attempt_id,
            harness_session_id, worker_id, tested_claim, outcome, interpretation,
            limitations, untested_dimensions, recorded_at,
            summary_conditions, summary_observed_behavior, summary_evidence_refs
          ) VALUES (
            ${SUMMARY_OBSERVATION_ID}, 1, 'summary', 'fixture-local',
            'intent-per-client-limiter', 'attempt-summary', 'ses_summary', 'worker-1',
            'Sending a different X-Client-Id header value evades the per-client request limit.',
            'positive', 'The limiter keys on the header value.',
            ${JSON.stringify([`Tested one short window; ${AWKWARD_TEXT}`])},
            ${JSON.stringify([SUMMARY_UNTESTED_DIMENSION])},
            ${SUMMARY_RECORDED_AT},
            ${JSON.stringify(SUMMARY_CONDITIONS)},
            'Requests 1-10 returned 401; request 11 returned 429; three rotated identities then returned 401.',
            ${JSON.stringify(["transcript://summary-run"])}
          )`;
        // The untested dimension, as a row as well as in the observation's JSON. The
        // column is the submission and the row is what anything reads by: a briefing's
        // open questions come from `observation_dimensions`, and an id that encoded the
        // position would make position the identity again.
        yield* sql`INSERT INTO observation_dimensions (id, observation_id, position,
            text, created_at)
          VALUES (${SUMMARY_DIMENSION_ID}, ${SUMMARY_OBSERVATION_ID}, 0,
                  ${SUMMARY_UNTESTED_DIMENSION}, ${SUMMARY_RECORDED_AT})`;
        yield* sql`INSERT INTO command_receipts (key, caller_scope, operation,
            operation_id, request_hash, result, created_at)
          VALUES (
            ${SUMMARY_RECEIPT_KEY}, 'fixture-local/attempt-summary',
            'record_observation', 'summary-op-1', 'a-hash-from-another-build',
            ${JSON.stringify({
              observationId: SUMMARY_OBSERVATION_ID,
              sequence: 1,
              replayed: false,
              provenance: {
                targetId: "fixture-local",
                intentId: "intent-per-client-limiter",
                attemptId: "attempt-summary",
                harnessSessionId: "ses_summary",
                workerId: "worker-1",
                recordedAt: SUMMARY_RECORDED_AT,
              },
            })},
            ${SUMMARY_RECORDED_AT}
          )`;
        // The cursor the observation above consumed. A write that ignored it would reuse
        // sequence 1, and the unique index would refuse the row.
        yield* sql`INSERT INTO sequence_cursor (name, value)
          VALUES ('observations', 1)`;
      }).pipe(Effect.provide(sqliteLayer(filename))),
    ),
  ).then(() => undefined);
