/**
 * The worker attempt's toolkit: `record_observation`, and nothing else.
 *
 * **This file used to be "the domain toolkit" and is now one role's.** It held a single
 * global `Toolkit`, which meant the tool surface was the same whatever credential was
 * presented: a planner round's session could list `record_observation` and have every
 * call refused by `store.recordObservation`'s authority path. The authority boundary was
 * never the gap — the tool *list* was. `mcp/plannerTools.ts` holds the round's toolkit and
 * `mcp/server.ts` binds each to its own endpoint, so from here on a caller is offered the
 * tools its authority covers and is refused at the door if it presents the wrong kind of
 * credential for the endpoint it reached.
 *
 * `record_observation` is defined once, as an Effect `Tool` over the canonical wire
 * schema from `@bit/contracts`. Three things follow from that and used to be three
 * separate hand-maintained artefacts:
 *
 * - The advertised `inputSchema` is **derived** from the schema
 *   (`Schema.toJsonSchemaDocument` under the hood, `effect/src/ai/Tool.ts:1772-1804`),
 *   so an advertised field name is by construction a field the decoder accepts. The
 *   earlier claim that Effect 4.0.5 ships no Schema → JSON Schema conversion was simply
 *   wrong; see DECISIONS.md §16 for the correction.
 * - Arguments arrive **decoded**: snake_case on the wire, camelCase in the handler, with
 *   a typed JSON-RPC `-32602` on malformed input. No handwritten key-by-key mapper.
 * - The result is encoded through `RecordObservationResultWire`, so the worker reads
 *   snake_case fields consistent with what it sent.
 *
 * The description is part of the contract a worker reads, so it states the rules the
 * schema cannot: outcome is relative to `tested_claim` alone, a technical failure is
 * inconclusive, and provenance is not the worker's to supply.
 */
import {
  RecordObservationInputWire,
  RecordObservationResultWire,
} from "@bit/contracts";
import { Effect, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";

import { McpInvocation } from "./invocation";
import { TargetStores, withTargetStore } from "../persistence/targetStores";

export const RECORD_OBSERVATION_DESCRIPTION = [
  "Record one bounded observation as durable evidence.",
  "",
  "An observation speaks to exactly one narrow tested_claim. Outcome is relative to",
  "that claim alone: 'positive' supports it under the cases you recorded, 'negative'",
  "means it was not supported under those cases (never an unbounded 'not",
  "vulnerable'), and 'inconclusive' means the test could not decide it. A timeout,",
  "error or broken test is inconclusive, not negative.",
  "",
  "One claim usually needs more than one case. A case is one identity, or one",
  "ordering, or one endpoint pairing that you tested the claim under; use several",
  "when the claim needs them (owner versus other tenant, authenticated versus",
  "anonymous, before versus after a limit was hit) and one when it does not. Give",
  "each case its own id, purpose, actors, ordered actions, window and bounds.",
  "",
  "Record what you saw on the action that produced it, not once for the whole",
  "observation: every action names the actor that performed it, the endpoint, the",
  "method, its own request_count and its own observed_behavior. Keep",
  "observed_behavior free of interpretation; put your reading across the cases in the",
  "top-level interpretation. Actions are a sequence, so list them in the order you",
  "performed them; if requests genuinely overlapped in time, say so in the action's",
  "description, because a list cannot show it.",
  "",
  "An actor's account is null when it was unauthenticated, and its role is null when",
  "the role is unknown or does not apply. Never put a password, token or key",
  "anywhere. client_identity must describe what you actually varied: a request header",
  "is a request header, not an address. Use relationships for the ownership or",
  "tenancy facts a case depends on, as subject/relation/object.",
  "",
  "Record limitations and untested_dimensions honestly \u2014 the next session relies on",
  "them to pick up what you did not cover. Each untested_dimension you record becomes",
  "an addressable open question with its own address, which later work can claim.",
  "",
  "If your briefing listed open questions and this observation takes one on, put its",
  "exact address in addresses_dimensions (for example obs_000003_attempt-x#u1). Nothing",
  "is inferred from wording: a question you do not name stays open no matter how",
  "closely your claim resembles it, and an address that does not exist, or belongs to",
  "another intent, is refused and nothing is recorded. Send an empty list when this",
  "observation addresses no earlier question. Naming an address does not close the",
  "question \u2014 it records that you took it on, and your outcome says what came of that.",
  "",
  "Provenance (target, intent, attempt, session) is derived from your authenticated",
  "session and cannot be set here. operation_id is yours: reuse the same value to",
  "retry a call safely, and a new value for a genuinely new observation.",
  "",
  "A refusal of 'stale' means this attempt is no longer the live one \u2014 it was settled or",
  "recovered while you were working. Nothing you send under it will be recorded, and",
  "observations you recorded earlier are unaffected and still stored. Stop and report;",
  "do not retry under a new operation_id.",
].join("\n");

/**
 * A refusal the worker is meant to read and act on.
 *
 * `failureMode: "return"` keeps it a tool *result* rather than a transport error: a
 * receipt conflict is information the worker needs ("you already used that
 * operation_id"), not a reason to tear down its turn.
 */
export class RecordObservationRefused extends Schema.TaggedError<RecordObservationRefused>()(
  "RecordObservationRefused",
  {
    reason: Schema.Literals([
      "conflict",
      "unauthorized",
      "invalid",
      "stale",
      "stored",
      "unavailable",
    ]),
    detail: Schema.String,
  },
) {}

export const RecordObservation = Tool.make("record_observation", {
  description: RECORD_OBSERVATION_DESCRIPTION,
  parameters: RecordObservationInputWire,
  success: RecordObservationResultWire,
  failure: RecordObservationRefused,
  failureMode: "return",
  // `addDependency` makes the caller identity a *request-level* requirement rather
  // than something the handler layer closes over. The transport must supply it on
  // every call, which is precisely the property we want to be unable to forget.
}).addDependency(McpInvocation);

/**
 * The worker's toolkit, and only the worker's.
 *
 * **One tool, and the narrowness is now the point rather than an accident of there being
 * nothing else yet.** Until this slice `mcp/tools.ts` held one global toolkit, so a
 * planner round's session could list `record_observation` and every call it made was
 * refused by the store's authority path. The boundary held; the tool surface simply did
 * not match it. `mcp/plannerTools.ts` is the sibling for a round, and `mcp/server.ts` is
 * where each is bound to its own endpoint and its own caller kind.
 *
 * So the rule this name carries: **a tool goes in here only if a worker attempt's
 * credential may use it.** Anything a round or a goal agent writes belongs in that role's
 * toolkit, because an advertised tool that always refuses is a turn the model spends
 * finding that out.
 */
export const WorkerToolkit = Toolkit.make(RecordObservation);

/**
 * The handler.
 *
 * Provenance comes from {@link McpInvocation}, which the transport's auth middleware
 * provides per request from the presented credential. Nothing the model sent can reach
 * it, which is the whole point of the credential boundary.
 *
 * **The write is dispatched to the target the credential names.** This layer used to
 * yield `ObservationStore` once, here, at construction — and that single yield *was* the
 * pin that limited the whole process to one target: every authenticated write went to
 * whichever database the entrypoint had resolved at startup, whatever the credential
 * said. What replaces it is {@link TargetStores}, yielded in the same place, with the
 * store reached inside the handler by `withTargetStore(stores, caller.targetId, …)`.
 *
 * Three things make that safe rather than merely more flexible:
 *
 * - **`caller.targetId` is not the model's to choose.** It comes from
 *   {@link McpInvocation}, which the auth middleware builds from the presented bearer and
 *   nothing else. A worker that names another target in its arguments is describing a
 *   resource it has no way to address; there is no argument here that reaches the
 *   resolver.
 * - **The resolver is still one instance.** It is yielded at layer construction, not per
 *   request, so this route shares the same reference-counted handles as the browser API
 *   reading the same target — one connection and one write lock per file, rather than two
 *   contending.
 * - **The borrow is request-shaped.** `withTargetStore` holds the reference for the
 *   length of the write and returns it, which is what the resolver is for. The handle
 *   stays warm for the idle TTL, so a worker recording twenty observations opens the file
 *   once.
 *
 * It also adds a failure this handler did not have: the credential can name a target
 * whose database will not open. That is reported as `unavailable` with the resolver's own
 * words, for the reason the `DatabaseError` case below already gives — a worker that
 * cannot tell its observation was not stored is a worker that carries on as though it
 * had.
 */
export const WorkerToolkitLayer = WorkerToolkit.toLayer(
  Effect.gen(function* () {
    const stores = yield* TargetStores;
    return WorkerToolkit.of({
      record_observation: Effect.fn("record_observation")(function* (input) {
        const caller = yield* McpInvocation;
        return yield* withTargetStore(stores, caller.targetId, (store) =>
          store.recordObservation(caller, input),
        ).pipe(
          Effect.catchTag("MutationError", (error) =>
            Effect.fail(
              new RecordObservationRefused({
                reason: error.reason,
                detail: error.detail,
              }),
            ),
          ),
          Effect.catchTag("StoredRowError", (error) =>
            Effect.fail(
              new RecordObservationRefused({
                reason: "stored",
                detail: error.message,
              }),
            ),
          ),
          /**
           * A store failure is nobody's argument error, but the worker still has to
           * learn that its observation did **not** land — losing the whole turn to an
           * opaque internal error would leave it unable to tell. So it is returned as
           * a refusal and logged here, where the cause is still structured.
           */
          /**
           * The credential names a target this server cannot open.
           *
           * Only reachable through a credential, so it is not a model error and not an
           * argument problem: the attempt was authorised against a target whose database
           * has since become unopenable — archived, moved, or left unmigrated by the last
           * sweep. Reported with the resolver's own sentence, because the operator fixing
           * it is the one who moved the folder.
           */
          Effect.catchTag("FleetError", (error) =>
            Effect.logError(
              "record_observation could not resolve the caller's target",
              {
                targetId: error.targetId,
                reason: error.reason,
                detail: error.detail,
              },
            ).pipe(
              Effect.andThen(
                Effect.fail(
                  new RecordObservationRefused({
                    reason: "unavailable",
                    detail: `the store for target '${error.targetId}' could not be opened, so this observation was NOT recorded: ${error.detail}`,
                  }),
                ),
              ),
            ),
          ),
          Effect.catchTag("DatabaseError", (error) =>
            Effect.logError("record_observation could not reach the store", {
              operation: error.operation,
              reason: error.reason,
              cause: error.cause,
            }).pipe(
              Effect.andThen(
                Effect.fail(
                  new RecordObservationRefused({
                    reason: "unavailable",
                    detail:
                      "the control-plane store could not be written; this observation was NOT recorded",
                  }),
                ),
              ),
            ),
          ),
        );
      }),
    });
  }),
);
