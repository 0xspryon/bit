/**
 * Asset identity for the two kinds the fixture presents (DECISIONS.md §17 "concrete
 * asset identity rules", §6 "three identities at the mutation boundary").
 *
 * This is **domain identity**: the question of when two discoveries are the same thing.
 * It is a separate question from caller authority and from retry deduplication, and §6
 * is explicit that conflating them is how all three go wrong. Two distinct operations may
 * legitimately find the same canonical asset; the rule below says when they have, and the
 * store then keeps one asset and both discovery records.
 *
 * §17 states the twin failure to avoid: duplicate representations of one host on one
 * side, and over-normalisation that merges behaviourally different endpoints on the
 * other. The rules here are deliberately the smallest pair that does the fixture's job,
 * because every normalisation that is not needed is a merge waiting to be wrong.
 *
 * Browser-safe: Effect Schema and `URL`, which is a platform standard in both runtimes.
 */
import { Schema } from "effect";

import { normaliseHost, ScopeState } from "./scope";

/**
 * The asset kinds this build knows.
 *
 * Two, not ScopeWeaver's whole catalogue. §17 says to borrow the principle of
 * type-specific uniqueness rather than the catalogue, and an asset kind nothing records
 * is an identity rule nothing has tested.
 */
export const AssetKind = Schema.Literals(["host", "endpoint"]).annotate({
  description:
    "host for a network service by address and port; endpoint for one method on one path of one host.",
});
export type AssetKind = typeof AssetKind.Type;

/** Default ports, so `http://x` and `http://x:80` cannot become two assets. */
const DEFAULT_PORTS: Record<string, number> = {
  "http:": 80,
  "https:": 443,
};

const recordAssetInputFields = {
  /**
   * Caller-owned stable operation identity. An exact retry under the same ID returns
   * the original result; reuse with conflicting input is rejected.
   */
  operationId: Schema.NonEmptyString.annotate({
    description:
      "Stable ID for this record operation. An exact retry returns the original result; reusing it with different content is rejected.",
  }),
  kind: AssetKind,
  /**
   * The asset as observed, verbatim.
   *
   * A full absolute URL for either kind. For a `host` only its scheme, host and port are
   * read; for an `endpoint` the path is read too. Whatever is sent is kept on the
   * discovery record, so nothing about how it was found is lost to normalisation.
   */
  url: Schema.NonEmptyString.annotate({
    description:
      "The asset as you observed it, as an absolute URL, for example http://127.0.0.1:8080/login.",
  }),
  /** Required for `endpoint`, and must be absent for `host`. */
  method: Schema.NullOr(Schema.NonEmptyString).annotate({
    description:
      "HTTP method, for an endpoint. Null for a host: a host has no method.",
  }),
  note: Schema.NonEmptyString.annotate({
    description:
      "How you found this and why it is in scope. Recorded with the discovery, never used as identity.",
  }),
};

/**
 * The kind/method pairing, as a cross-field check.
 *
 * On the struct rather than on `method`, because "required for one kind and forbidden for
 * the other" is not a property of the field alone. Declared contravariantly like the
 * observation checks so the domain and wire schemas enforce the same rule.
 */
const kindMatchesMethod = Schema.makeFilter<{
  readonly kind: AssetKind;
  readonly method: string | null;
}>(
  (value) => {
    if (value.kind === "endpoint" && value.method === null) {
      return {
        path: ["method"],
        issue: "an endpoint needs a method; send one, or record this as a host",
      };
    }
    if (value.kind === "host" && value.method !== null) {
      return {
        path: ["method"],
        issue:
          "a host has no method; send method: null, or record this as an endpoint",
      };
    }
    return undefined;
  },
  { expected: "an endpoint with a method, or a host without one" },
);

export const RecordAssetInput = Schema.Struct(recordAssetInputFields).check(
  kindMatchesMethod,
);
export type RecordAssetInput = typeof RecordAssetInput.Type;

/** The canonical wire encoding of {@link RecordAssetInput}. */
export const RecordAssetInputWire = Schema.Struct(recordAssetInputFields)
  .check(kindMatchesMethod)
  .pipe(Schema.encodeKeys({ operationId: "operation_id" }));

/**
 * The canonical form of one asset: its identity string and the parts that produced it.
 *
 * The parts are kept alongside the identity rather than re-parsed from it, so a reader
 * never has to split a string to answer "which host is this".
 */
export const AssetIdentity = Schema.Struct({
  kind: AssetKind,
  /** What uniqueness is on, within one target and kind. */
  identity: Schema.String,
  /**
   * The host, reduced by `normaliseHost` — the **same** function a scope entry value and
   * a hand label key go through, which is what makes the stored form the matched form.
   *
   * It is therefore bracket-free for an IPv6 literal: `[::1]` is stored as `::1`. The
   * identity string above keeps the brackets, because there it is part of an authority
   * and `::1:8080` cannot be told from the address `::1:8080`.
   */
  host: Schema.String,
  port: Schema.Int,
  /** Null for a host. */
  scheme: Schema.NullOr(Schema.String),
  /** Null for a host. Upper-cased. */
  method: Schema.NullOr(Schema.String),
  /** Null for a host. */
  path: Schema.NullOr(Schema.String),
});
export type AssetIdentity = typeof AssetIdentity.Type;

/**
 * The host as it appears inside an identity string, which is an authority and not a key.
 *
 * `normaliseHost` strips the brackets an IPv6 literal carries, because the matched form
 * has to be the form an operator types. An identity is read rather than matched, and
 * `::1:8080` is both a plausible address and this host and port, so the brackets go back
 * on for the printed form. After normalisation a colon can only be an IPv6 literal — the
 * port is gone by then — so that is the whole test.
 */
const authorityOf = (host: string): string =>
  host.includes(":") ? `[${host}]` : host;

/** Why a submission could not be reduced to an identity. */
export interface AssetIdentityRefusal {
  readonly _tag: "refused";
  readonly detail: string;
}

/**
 * The canonical identity of one submitted asset, or an instructive refusal.
 *
 * **The host rule.** The hostname through `normaliseHost` — lowercased, trailing dot
 * removed, IPv6 brackets removed — and the port made explicit from the scheme's default
 * when it was not given. Identity is `host:port`, with an IPv6 host bracketed because
 * there it is an authority. That is the narrow answer to §17's "duplicate representations
 * of one host": the same service written three ways is one row, and the one spelling it
 * is stored under is the one the scope matcher uses.
 *
 * **The endpoint rule.** `METHOD scheme://host:port/path`, method upper-cased, scheme
 * lowercased, port explicit, path as `URL` normalised it — which resolves `.` and `..`
 * and fixes percent-encoding, so one path cannot have two spellings.
 *
 * **Query and fragment are excluded, and this is the decision most likely to bite.**
 * Including a query string mints one asset per parameter value, which turns an inventory
 * of a surface into a log of requests and makes any coverage denominator meaningless. The
 * accepted cost is the other direction of §17's warning: two endpoints that differ only
 * by a query parameter — `?action=delete` against `?action=read` — merge into one row
 * here. The full URL as submitted is kept on every discovery record, so the distinction
 * is visible in provenance even though it is not identity. ScopeWeaver's own rule is URL
 * plus method (`db/schema.sql:83-91`); this matches it.
 *
 * **Role is deliberately not part of identity.** An endpoint tested as an administrator
 * and as an anonymous caller is one endpoint. Splitting by role would double-count the
 * surface, and role is a property of the test — it is recorded on an observation's
 * actors, where a reader can see which identities actually exercised the endpoint.
 *
 * A trailing slash is **not** stripped: `/x` and `/x/` are left as two, because a server
 * is free to treat them differently and merging them would be exactly the
 * over-normalisation §17 names. A path is normalised only as far as `URL` does it.
 */
export const assetIdentityOf = (
  input: Pick<RecordAssetInput, "kind" | "url" | "method">,
): AssetIdentity | AssetIdentityRefusal => {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return {
      _tag: "refused",
      detail: `'${input.url}' is not an absolute URL; send one like http://127.0.0.1:8080/login`,
    };
  }
  const scheme = parsed.protocol.toLowerCase();
  const defaultPort = DEFAULT_PORTS[scheme];
  if (parsed.port === "" && defaultPort === undefined) {
    return {
      _tag: "refused",
      detail: `'${input.url}' has scheme ${scheme} and no port, and only http and https have a default port here; include the port`,
    };
  }
  const port = parsed.port === "" ? (defaultPort ?? 0) : Number(parsed.port);
  /*
   * The host, through the scope normaliser rather than through a second one here.
   *
   * This is D4.1's whole point and it was the one step not shared. `new URL(...)
   * .hostname` yields `[::1]` for `http://[::1]:8080/x`, brackets included, while an
   * operator types `::1` and the entry stores `::1` — so an IPv6 asset could never be in
   * scope and could never be hand-labelled, because the label was keyed by one spelling
   * and the asset row by the other. Sharing the step is what makes a missed match
   * impossible rather than unlikely; normalising in the store instead would have been the
   * second code path that can disagree.
   *
   * It subsumes the lowercasing and the trailing-dot strip this line used to do itself,
   * and nothing else it does can reach a `hostname`: there is no scheme, no port, no path
   * and no userinfo left in one.
   */
  const host = normaliseHost(parsed.hostname);
  if (host === "") {
    return {
      _tag: "refused",
      detail: `'${input.url}' has no host`,
    };
  }
  if (input.kind === "host") {
    return {
      kind: "host",
      identity: `${authorityOf(host)}:${String(port)}`,
      host,
      port,
      scheme: null,
      method: null,
      path: null,
    };
  }
  const method = (input.method ?? "").toUpperCase();
  if (method === "") {
    return {
      _tag: "refused",
      detail: "an endpoint needs a method",
    };
  }
  const path = parsed.pathname === "" ? "/" : parsed.pathname;
  return {
    kind: "endpoint",
    identity: `${method} ${scheme}//${authorityOf(host)}:${String(port)}${path}`,
    host,
    port,
    scheme,
    method,
    path,
  };
};

/** Whether {@link assetIdentityOf} refused. */
export const isAssetIdentityRefusal = (
  value: AssetIdentity | AssetIdentityRefusal,
): value is AssetIdentityRefusal => "_tag" in value;

/** What `record_asset` returns. */
export const RecordAssetResult = Schema.Struct({
  assetId: Schema.String,
  kind: AssetKind,
  identity: Schema.String,
  /**
   * False when this discovery merged onto an asset that already existed.
   *
   * It is not the same as `replayed`: a *different* operation finding the same canonical
   * asset is new provenance about a known thing, and both facts are recorded.
   */
  created: Schema.Boolean,
  /** True when this call replayed an existing receipt rather than writing anew. */
  replayed: Schema.Boolean,
  /** How many separate operations have now recorded this asset. */
  discoveries: Schema.Int,
  /**
   * Whether this asset is inside the client's authorized estate.
   *
   * Reported on the write so an agent that records an out-of-scope host is **told so
   * immediately** rather than finding out never. It is not a refusal and it is not a
   * warning: the asset was recorded either way, because recording an out-of-scope
   * discovery is how the operator comes to know it exists.
   *
   * `out` with no scope authored on the target is the common early case, and it means
   * "nothing covers this yet" rather than "you were denied" — which is why
   * {@link RecordAssetResult.scopeDetail} carries the sentence rather than leaving the
   * agent to guess from one word.
   */
  scopeState: Schema.Literals(["in", "out"]),
  /** What decided {@link RecordAssetResult.scopeState}, in words the agent can act on. */
  scopeDetail: Schema.String,
});
export type RecordAssetResult = typeof RecordAssetResult.Type;

/**
 * The snake_case encoding of {@link RecordAssetResult}, for tool output.
 *
 * **Every multi-word key, not just the first one.** An earlier version encoded `assetId`
 * alone, so the result a tool returned read `asset_id` beside `scopeState` — two
 * conventions in one object, where `AssetListingWire` beside it is snake_case throughout.
 * A model reading a mixed object has to guess which convention the next field follows, and
 * the fields most worth reading here are the two that were camelCase.
 */
export const RecordAssetResultWire = RecordAssetResult.pipe(
  Schema.encodeKeys({
    assetId: "asset_id",
    scopeState: "scope_state",
    scopeDetail: "scope_detail",
  }),
);

/**
 * What the scope importer submits for one asset it read off a program page (D14).
 *
 * **The identity-bearing fields are literally {@link RecordAssetInput}'s**, not copies of
 * them. `kind`, `url` and `method` go through `assetIdentityOf` on both paths, so a host
 * the importer reads and the same host a worker later discovers reduce to one identity and
 * merge onto one `assets` row. Re-spelling them here would be the second normalisation
 * path §17 exists to prevent, and the first thing it would do is split that row in two.
 *
 * What differs is the provenance, because the facts differ. A discovery says which attempt
 * found it; an import says which page it was read off. So this carries `sourceUrl` and no
 * attempt — the importer has an operator behind it and runs before any goal, intent or
 * attempt exists.
 */
const importAssetInputFields = {
  operationId: recordAssetInputFields.operationId,
  kind: recordAssetInputFields.kind,
  url: recordAssetInputFields.url,
  method: recordAssetInputFields.method,
  /**
   * The program page this asset was read off.
   *
   * The import's answer to "how did this come to be known", and the reason this is a
   * separate provenance table rather than a weakened `asset_discoveries`. Not identity:
   * two pages naming the same host give one asset with two import records.
   */
  sourceUrl: Schema.NonEmptyString.annotate({
    description:
      "The program page URL this asset was read off, as given to you.",
  }),
  /** Where on the page it came from, in the importer's words. */
  note: Schema.NonEmptyString.annotate({
    description:
      "Where on the page you read this, for example the row of the in-scope table it came from. Recorded with the import, never used as identity.",
  }),
};

export const ImportAssetInput = Schema.Struct(importAssetInputFields).check(
  kindMatchesMethod,
);
export type ImportAssetInput = typeof ImportAssetInput.Type;

/**
 * What an import of one asset returns.
 *
 * {@link RecordAssetResult}'s shape with one field changed, and the change is the whole
 * point: `imports` counts rows in `asset_imports`, not in `asset_discoveries`. An asset
 * both paths have touched has a count in each, and neither number is the other's.
 *
 * It is a schema rather than an interface because the store replays it out of a command
 * receipt: an exact retry decodes the stored JSON through this codec, so a result whose
 * shape has drifted from the contract is a named error rather than a value that
 * type-checks and is wrong.
 */
export const ImportAssetResult = Schema.Struct({
  assetId: Schema.String,
  kind: AssetKind,
  identity: Schema.String,
  /**
   * False when this import merged onto an asset that already existed.
   *
   * Which includes the case the identity rules exist for: a worker discovered this host
   * first, and the import adds provenance to it rather than a second row.
   */
  created: Schema.Boolean,
  /** True when this call replayed an existing receipt rather than writing anew. */
  replayed: Schema.Boolean,
  /** How many separate import operations have recorded this asset. */
  imports: Schema.Int,
  /**
   * Whether this asset is inside the client's authorized estate, as of the write.
   *
   * Reported for D9's reason, one step sharper: the importer is the thing that just
   * authored the scope, so an asset of its own that nothing covers means the entries it
   * wrote and the hosts it read disagree — which is worth knowing while the import is
   * still on screen rather than never. It is not a refusal; the rows are already written.
   */
  scopeState: Schema.Literals(["in", "out"]),
  /** What decided {@link ImportAssetResult.scopeState}, in words. */
  scopeDetail: Schema.String,
});
export type ImportAssetResult = typeof ImportAssetResult.Type;

/**
 * The canonical wire encoding of {@link ImportAssetInput}, for the importer's tool.
 *
 * {@link RecordAssetInputWire}'s sibling and built the same way, from the same field
 * record, so the two tools cannot come to disagree about what `url` or `method` mean. The
 * one extra key is `source_url`, which is the import's own provenance.
 */
export const ImportAssetInputWire = Schema.Struct(importAssetInputFields)
  .check(kindMatchesMethod)
  .pipe(
    Schema.encodeKeys({
      operationId: "operation_id",
      sourceUrl: "source_url",
    }),
  );

/**
 * The snake_case encoding of {@link ImportAssetResult}, for tool output.
 *
 * Every multi-word key, for {@link RecordAssetResultWire}'s reason: a result that read
 * `asset_id` beside `scopeState` would make a model guess which convention the next field
 * follows, and the fields most worth reading here are the ones that would have been
 * camelCase.
 */
export const ImportAssetResultWire = ImportAssetResult.pipe(
  Schema.encodeKeys({
    assetId: "asset_id",
    scopeState: "scope_state",
    scopeDetail: "scope_detail",
  }),
);

/**
 * One recorded asset, as a browser reads it.
 *
 * camelCase, because this is the browser API's shape and that API is camelCase
 * throughout; the MCP tools get the `*Wire` siblings above. The parts of the identity are
 * carried beside it rather than re-parsed from it, for the reason {@link AssetIdentity}
 * gives: a reader should never have to split a string to answer "which host is this".
 *
 * `host` is the field the estate view groups on, and it is also the field a host label is
 * keyed by — which is why it is here as its own column and not left implicit in
 * `identity`. Grouping by host is the only grouping that matches what a label reaches.
 */
export const AssetView = Schema.Struct({
  assetId: Schema.String,
  kind: AssetKind,
  /** What uniqueness is on, within one target and kind. */
  identity: Schema.String,
  host: Schema.String,
  port: Schema.Int,
  /** Null for a host, and only for a host. */
  scheme: Schema.NullOr(Schema.String),
  /** Null for a host. Upper-cased. */
  method: Schema.NullOr(Schema.String),
  /** Null for a host. */
  path: Schema.NullOr(Schema.String),
  /** When this asset was first recorded. */
  firstSeenAt: Schema.Number,
  /**
   * How many separate worker operations have discovered it.
   *
   * **Zero is a real answer, and D14 is what made it one.** An asset the scope importer
   * read off a program page has an `asset_imports` row and no discovery row at all, until
   * a worker finds the same host and merges onto it. So this is a count of discoveries
   * rather than of provenance, and an asset nobody has discovered yet is not an asset
   * nobody knows about.
   */
  discoveries: Schema.Int,
  /**
   * The attempt that found it first, and the intent that attempt was working.
   *
   * Null when no discovery row exists. `record_asset` cannot produce that — it writes the
   * discovery in the same transaction as the asset — but the scope importer's own write
   * does, deliberately and for every asset it records (D14): it has an operator behind it
   * and no attempt to name. Read together with {@link imports}, which is what tells an
   * imported asset apart from one nothing knows anything about.
   */
  firstAttemptId: Schema.NullOr(Schema.String),
  firstIntentId: Schema.NullOr(Schema.String),
  /** When it was most recently seen. Not the same fact as {@link firstSeenAt}. */
  lastDiscoveredAt: Schema.NullOr(Schema.Number),
  /**
   * How many separate import operations recorded it (D14).
   *
   * **This field exists so that an imported asset reads as provenance rather than as an
   * absence.** With only {@link discoveries} and {@link firstAttemptId}, a host the scope
   * importer read off a program page — `0` and `null`, both correct — is indistinguishable
   * from a row nobody can account for, and the best sentence a screen could write was "no
   * recorded discovery". That is a statement about a gap, and there is no gap: the host was
   * named on the program's own page, which is how it came to be known.
   *
   * Zero for an asset only a worker found. An asset both paths have touched has a non-zero
   * count here *and* a non-null attempt, which is the two-provenance-tables shape D14
   * chose over relaxing `asset_discoveries` — and a reader never has to ask whether a null
   * attempt means "imported" or "unexplained".
   */
  imports: Schema.Int,
  /**
   * The program page it was first read off, or null if it was never imported.
   *
   * The page rather than the note, because the page is the part an operator can go and
   * check for themselves — which is the point of the whole review step D13 rests on.
   */
  firstSourceUrl: Schema.NullOr(Schema.String),
  /**
   * Whether this asset is in the client's estate, and what decided it.
   *
   * The whole state rather than one word, so the screen can say *why* without a second
   * query — "excluded on purpose", "excluded by hand" and "covered by nothing" are three
   * different sentences with three different affordances, and a view that had to ask the
   * server which one applied is a view that would end up not saying.
   *
   * Computed by the server from the one store read that implements the D5 ladder, so a
   * row's state here cannot disagree with what the agent was told.
   */
  scope: ScopeState,
});
export type AssetView = typeof AssetView.Type;
