/**
 * The worker attempt's toolkit: `record_observation` and `record_asset`.
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
 * ## Why `record_asset` is here and on no other endpoint
 *
 * The target-scope design's D9 settles it on the schema rather than on taste.
 * `store.recordAsset` opens with `attemptCallerOrFail`, and migration `0010` makes
 * `asset_discoveries.intent_id` and `.attempt_id` `NOT NULL` with real foreign keys to
 * `intents` and `attempts`. A planner round has neither and a goal conversation has
 * neither, so registering this tool on those endpoints would not be a registration — it
 * would be a schema change plus a relaxation of the discovery-provenance invariant that
 * `0010`'s own commentary argues for. A discovery that cannot say which attempt found it
 * is not provenance.
 *
 * Both tools are defined once, as Effect `Tool`s over the canonical wire schemas from
 * `@bit/contracts`. Three things follow from that and used to be three separate
 * hand-maintained artefacts:
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
  AssetKind,
  describeScopeState,
  RecordAssetInputWire,
  RecordAssetResultWire,
  RecordObservationInputWire,
  RecordObservationResultWire,
} from "@bit/contracts";
import { Effect, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";

import { McpInvocation } from "./invocation";
import type { ObservationStore } from "../persistence/store";
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

export const RECORD_ASSET_DESCRIPTION = [
  "Record one asset you have discovered on this target's estate.",
  "",
  "An asset is either a host — one network service, by address and port — or an",
  "endpoint, which is one method on one path of one host. Send kind: 'host' with",
  "method: null, or kind: 'endpoint' with the method you used. A host has no method and",
  "an endpoint cannot do without one.",
  "",
  "url is the asset as you actually observed it, as an absolute URL. For a host only",
  "its scheme, host and port are read; for an endpoint the path is read too. Whatever",
  "you send is kept verbatim on the discovery record, so nothing about how you found it",
  "is lost to normalisation.",
  "",
  "Identity is canonical, and two things follow that are worth knowing before you call",
  "this a second time. The same service written three ways is one asset: host names are",
  "lowercased and a default port is made explicit, so http://x, http://X. and",
  "http://x:80 are one row. And the query string and fragment are NOT part of identity:",
  "/search?q=a and /search?q=b are one endpoint. Do not call this once per parameter",
  "value — you would be writing a request log rather than an inventory of a surface.",
  "",
  "Record what you find whether or not it is in scope. An asset outside the authorized",
  "scope is still recorded, kept and shown to the operator, because recording it is how",
  "the operator comes to know it exists. Recording is not a claim of authorization and",
  "it does not grant any: it is bookkeeping about what is out there. What you must not",
  "do is test something the scope does not cover.",
  "",
  "note is how you found this and why it matters. It is kept with the discovery and is",
  "never used as identity, so write it for the next person rather than for a matcher.",
  "",
  "Provenance (target, intent, attempt, session) is derived from your authenticated",
  "session and cannot be set here. operation_id is yours: reuse the same value to retry",
  "a call safely, and a new value for a genuinely new discovery.",
  "",
  "Two fields in the result mean different things and are easy to confuse. created is",
  "false when your discovery merged onto an asset that already existed — that is new",
  "provenance about a known thing, and both facts are kept. replayed is true only when",
  "you reused an operation_id and nothing was written at all.",
].join("\n");

/**
 * A refusal the worker is meant to read and act on.
 *
 * Same reasons and the same `failureMode: "return"` as {@link RecordObservationRefused},
 * for the same argument: a worker that cannot tell its discovery was not stored is a
 * worker that carries on as though it had. `invalid` is the one that will actually be
 * met, because it is what an unparseable `url` or a kind/method mismatch comes back as,
 * and the detail carries `assetIdentityOf`'s own sentence.
 */
export class RecordAssetRefused extends Schema.TaggedError<RecordAssetRefused>()(
  "RecordAssetRefused",
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

export const RecordAsset = Tool.make("record_asset", {
  description: RECORD_ASSET_DESCRIPTION,
  parameters: RecordAssetInputWire,
  success: RecordAssetResultWire,
  failure: RecordAssetRefused,
  failureMode: "return",
}).addDependency(McpInvocation);

/**
 * One asset as `list_assets` reports it.
 *
 * snake_case, like every other MCP payload, and declared here rather than in contracts
 * because nothing in the browser reads it — the browser has its own camelCase `AssetView`
 * over the same row. Two shapes over one row is deliberate: the agent needs the identity
 * and how it came to be known, and the screen needs fields to group and sort by.
 */
export const AssetListingWire = Schema.Struct({
  asset_id: Schema.String,
  kind: AssetKind,
  identity: Schema.String,
  host: Schema.String,
  port: Schema.Int,
  method: Schema.NullOr(Schema.String),
  path: Schema.NullOr(Schema.String),
  /** How many separate operations have recorded it. */
  discoveries: Schema.Int,
  /** The attempt that found it first. Null only if no discovery row exists. */
  first_attempt_id: Schema.NullOr(Schema.String),
  /**
   * Whether this asset is inside the client's authorized estate.
   *
   * **This field is the other half of D10.** Returning an out-of-scope row is only half
   * the rule; the rule is that it comes back *labelled*. The whole argument for
   * returning it is that an agent which cannot see a host is a known one will rediscover
   * it — and an agent that can see the host but not that it is excluded will go on to
   * test it, which is worse. One field per row closes both.
   *
   * The same two fields `record_asset` reports on the write, from the same ladder and the
   * same renderer, so the answer an agent is given when it records a host and the answer
   * it is given when it lists the estate cannot differ.
   */
  scope_state: Schema.Literals(["in", "out"]),
  /** What decided `scope_state`, in words: an entry, a hand label, or nothing at all. */
  scope_detail: Schema.String,
});

export const ListAssetsOutcome = Schema.Struct({
  /** How many assets this target holds. The same number as `assets.length`. */
  total: Schema.Int,
  assets: Schema.Array(AssetListingWire),
});

export const LIST_ASSETS_DESCRIPTION = [
  "Every asset recorded on this target so far, oldest first: what the whole hunt has",
  "found, not only what you found.",
  "",
  "Read it before recording. An asset already here does not need recording again, and",
  "a host somebody else already found is a host you can start from rather than",
  "rediscover. Recording it again is harmless — a second discovery on a known asset is",
  "new provenance and is kept — but it is a call you did not need to make.",
  "",
  "Nothing is withheld from this list. An asset outside the authorized scope is",
  "returned like any other, because an agent that cannot see a host it already found",
  "will find it again, and again, with nothing telling it the host is known. Seeing an",
  "asset here is not authorization to test it: what you may test is what the authorized",
  "scope covers, and that is stated in your prompt.",
  "",
  "Every row carries scope_state and scope_detail, which say whether the operator's",
  "scope covers it and what decided that — an entry they typed, a label they set by",
  "hand, or nothing at all. Read them before you act on a row: out means recorded and",
  "known, not authorized.",
  "",
  "identity is what uniqueness is on. For a host it is host:port; for an endpoint it is",
  "METHOD scheme//host:port/path, with the query string and fragment excluded. Two URLs",
  "that differ only by a query parameter are one asset here.",
  "",
  "The whole list comes back in one answer; there is no paging and no filter.",
].join("\n");

/**
 * A refusal of the read.
 *
 * Its own class rather than {@link RecordAssetRefused}, because a read has no `conflict`
 * and no `stale`: there is no receipt to collide with and no write authority to have
 * been superseded. A reason a tool can never return is a reason a model may still plan
 * for, so the list is the list this tool can actually produce.
 */
export class ListAssetsRefused extends Schema.TaggedError<ListAssetsRefused>()(
  "ListAssetsRefused",
  {
    reason: Schema.Literals(["unauthorized", "stored", "unavailable"]),
    detail: Schema.String,
  },
) {}

export const ListAssets = Tool.make("list_assets", {
  description: LIST_ASSETS_DESCRIPTION,
  parameters: Tool.EmptyParams,
  success: ListAssetsOutcome,
  failure: ListAssetsRefused,
  failureMode: "return",
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
 *
 * `record_asset` satisfies that rule for the reason the file header gives: its write is
 * an attempt's, by the shape of `asset_discoveries`, and no other role has an attempt to
 * record one against.
 */
export const WorkerToolkit = Toolkit.make(
  RecordObservation,
  RecordAsset,
  ListAssets,
);

/** The reasons both worker tools refuse with. One list, so the two cannot diverge. */
type WorkerRefusalReason =
  "conflict" | "unauthorized" | "invalid" | "stale" | "stored" | "unavailable";

/**
 * Turns the store's failures into a refusal one worker tool can act on.
 *
 * One mapper for both handlers, because the store's vocabulary is the same under each of
 * them and a second copy is the one that drifts. `plannerTools.ts`'s `asRefusal` is the
 * sibling for the round's tools, and this is deliberately the same shape: a structurally
 * typed view of the failure, a `switch` on its tag, and no hand-narrowing of the union.
 *
 * `consequence` is what keeps the sentences specific, and it is a whole clause rather
 * than a noun because the three tools have two different consequences. A worker has to
 * read "this asset was NOT recorded" after a failed write and "nothing was read" after a
 * failed read; a shared noun would have produced "this asset was NOT recorded" for a
 * list call, which is false and is the kind of sentence that makes an agent retry a
 * write it never made.
 *
 * Two cases are not a flattening, and they are why this is a `switch` rather than a
 * passthrough. A `MutationError` keeps its own four reasons, because `conflict`,
 * `stale`, `unauthorized` and `invalid` lead a worker to four different next actions.
 * And a `DatabaseError` becomes `unavailable` with a sentence naming the consequence — a
 * worker that cannot tell its write did not land is a worker that carries on as though
 * it had.
 */
const workerRefusal = (
  failure: {
    readonly _tag: string;
    readonly reason?: string;
    readonly detail?: string;
    readonly message?: string;
    readonly targetId?: string;
  },
  consequence: string,
): { readonly reason: WorkerRefusalReason; readonly detail: string } => {
  switch (failure._tag) {
    case "MutationError": {
      const detail =
        failure.detail ?? failure.message ?? "that call was refused";
      switch (failure.reason) {
        case "conflict":
          return { reason: "conflict", detail };
        case "unauthorized":
          return { reason: "unauthorized", detail };
        case "stale":
          return { reason: "stale", detail };
        default:
          return { reason: "invalid", detail };
      }
    }
    case "StoredRowError":
      return {
        reason: "stored",
        detail:
          failure.message ?? "a stored row no longer matches the contract",
      };
    /**
     * The credential names a target this server cannot open.
     *
     * Only reachable through a credential, so it is not a model error and not an
     * argument problem: the attempt was authorised against a target whose database has
     * since become unopenable — archived, moved, or left unmigrated by the last sweep.
     * Reported with the resolver's own sentence, because the operator fixing it is the
     * one who moved the folder.
     */
    case "FleetError":
      return {
        reason: "unavailable",
        detail: `the store for target '${failure.targetId ?? "unknown"}' could not be opened, so ${consequence}: ${failure.detail ?? failure.message ?? "no detail"}`,
      };
    default:
      return {
        reason: "unavailable",
        detail: `this target's database could not be reached, so ${consequence}`,
      };
  }
};

/**
 * Borrows the caller's own target store for one tool call and maps what it refused with.
 *
 * **Only `Effect.catch`, and no `catchCause`.** A typed failure is the store's answer and
 * is mapped by {@link workerRefusal}; a *defect* is a bug here and is left to propagate,
 * where `effect/ai`'s own `internalToolError` logs it and answers with a scrubbed
 * message. Catching the cause instead would turn every typed refusal into `unavailable`,
 * so a receipt conflict and an unopenable database would read the same to a worker —
 * which is the mistake `plannerTools.ts` records having paid for.
 *
 * `unavailable` is the one reason that gets a log line, because it is the one that says
 * nothing about what the worker asked for and everything about this server.
 */
const onWorkersStore = <A, E>(
  stores: TargetStores["Service"],
  options: {
    readonly targetId: string;
    readonly tool: string;
    /** The clause the refusal ends with: what did or did not happen to the caller's call. */
    readonly consequence: string;
    readonly refuse: (input: {
      readonly reason: WorkerRefusalReason;
      readonly detail: string;
    }) => E;
  },
  body: (store: ObservationStore["Service"]) => Effect.Effect<
    A,
    {
      readonly _tag: string;
      readonly reason?: string;
      readonly detail?: string;
      readonly message?: string;
      readonly targetId?: string;
    }
  >,
): Effect.Effect<A, E> =>
  withTargetStore(stores, options.targetId, body).pipe(
    Effect.catch((error) => {
      const refusal = workerRefusal(error, options.consequence);
      return refusal.reason === "unavailable"
        ? Effect.andThen(
            Effect.logError(`${options.tool} could not reach the store`, {
              targetId: options.targetId,
              failure: error._tag,
              detail: refusal.detail,
            }),
            Effect.fail(options.refuse(refusal)),
          )
        : Effect.fail(options.refuse(refusal));
    }),
  );

/**
 * The handlers.
 *
 * Provenance comes from {@link McpInvocation}, which the transport's auth middleware
 * provides per request from the presented credential. Nothing the model sent can reach
 * it, which is the whole point of the credential boundary. That is what makes
 * `record_asset` safe to offer without a target argument: the asset lands in the file the
 * credential names, and there is no argument here that reaches the resolver.
 *
 * **Each write is dispatched to the target the credential names.** This layer used to
 * yield `ObservationStore` once, here, at construction — and that single yield *was* the
 * pin that limited the whole process to one target: every authenticated write went to
 * whichever database the entrypoint had resolved at startup, whatever the credential
 * said. What replaces it is {@link TargetStores}, yielded in the same place, with the
 * store reached inside each handler by {@link onWorkersStore}.
 *
 * Three things make that safe rather than merely more flexible:
 *
 * - **`caller.targetId` is not the model's to choose.** It comes from
 *   {@link McpInvocation}, which the auth middleware builds from the presented bearer and
 *   nothing else. A worker that names another target in its arguments is describing a
 *   resource it has no way to address.
 * - **The resolver is still one instance.** It is yielded at layer construction, not per
 *   request, so this route shares the same reference-counted handles as the browser API
 *   reading the same target — one connection and one write lock per file, rather than two
 *   contending.
 * - **The borrow is request-shaped.** `withTargetStore` holds the reference for the
 *   length of the write and returns it, which is what the resolver is for. The handle
 *   stays warm for the idle TTL, so a worker recording twenty assets opens the file once.
 */
export const WorkerToolkitLayer = WorkerToolkit.toLayer(
  Effect.gen(function* () {
    const stores = yield* TargetStores;
    return WorkerToolkit.of({
      record_observation: Effect.fn("record_observation")(function* (input) {
        const caller = yield* McpInvocation;
        return yield* onWorkersStore(
          stores,
          {
            targetId: caller.targetId,
            tool: "record_observation",
            consequence: "this observation was NOT recorded",
            refuse: (refusal) => new RecordObservationRefused(refusal),
          },
          (store) => store.recordObservation(caller, input),
        );
      }),
      record_asset: Effect.fn("record_asset")(function* (input) {
        const caller = yield* McpInvocation;
        return yield* onWorkersStore(
          stores,
          {
            targetId: caller.targetId,
            tool: "record_asset",
            consequence: "this asset was NOT recorded",
            refuse: (refusal) => new RecordAssetRefused(refusal),
          },
          (store) => store.recordAsset(caller, input),
        );
      }),
      /**
       * The estate, as the whole hunt has recorded it.
       *
       * No scope filter and no paging. D10 is explicit that scope state is never a filter
       * on what the agent can read: ScopeWeaver drops out-of-scope ids from a read
       * *silently*, and silently is the problem — an agent that cannot see a host it
       * already found will find it again, because nothing tells it the host is known.
       * Returning the row removes the rediscovery loop.
       *
       * The caller's target is the credential's, so there is no argument here that
       * reaches another engagement's estate.
       */
      list_assets: Effect.fn("list_assets")(function* () {
        const caller = yield* McpInvocation;
        const assets = yield* onWorkersStore(
          stores,
          {
            targetId: caller.targetId,
            tool: "list_assets",
            consequence: "nothing was read",
            refuse: (refusal) =>
              new ListAssetsRefused({
                // `conflict` and `stale` cannot reach a read, so they are not in this
                // tool's reason list. Mapped to `unavailable` rather than widened: a
                // reason that cannot happen is better absent than declared.
                reason:
                  refusal.reason === "unauthorized" ||
                  refusal.reason === "stored"
                    ? refusal.reason
                    : "unavailable",
                detail: refusal.detail,
              }),
          },
          /*
           * `assetsWithScope`, because the label is part of the answer.
           *
           * It is the one read that implements the D5 ladder — asset label over host
           * label over entries — and D5 says plainly that no caller should assemble it.
           * Mapping the rows here and deciding their state here would have been a second
           * implementation of the ladder on the agent's side of the house, which is the
           * anti-goal about two code paths that can disagree. It also filters to this
           * target's own rows, which is what the credential already means.
           */
          (store) => store.assetsWithScope(caller.targetId),
        );
        // Counted off the same array it returns, so `total` and `assets.length` cannot
        // disagree.
        return {
          total: assets.length,
          assets: assets.map(({ asset, scope }) => ({
            asset_id: asset.id,
            kind:
              asset.kind === "endpoint"
                ? ("endpoint" as const)
                : ("host" as const),
            identity: asset.identity,
            host: asset.host,
            port: asset.port,
            method: asset.method,
            path: asset.path,
            discoveries: asset.discoveries,
            first_attempt_id: asset.first_attempt_id,
            scope_state: scope.state,
            scope_detail: describeScopeState(scope),
          })),
        };
      }),
    });
  }),
);
