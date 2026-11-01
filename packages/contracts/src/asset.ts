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

/** Why a submission could not be reduced to an identity. */
export interface AssetIdentityRefusal {
  readonly _tag: "refused";
  readonly detail: string;
}

/**
 * The canonical identity of one submitted asset, or an instructive refusal.
 *
 * **The host rule.** Lowercased hostname with a trailing dot removed, and the port made
 * explicit from the scheme's default when it was not given. Identity is `host:port`. That
 * is the narrow answer to §17's "duplicate representations of one host": the same service
 * written three ways is one row.
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
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "") {
    return {
      _tag: "refused",
      detail: `'${input.url}' has no host`,
    };
  }
  if (input.kind === "host") {
    return {
      kind: "host",
      identity: `${host}:${String(port)}`,
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
    identity: `${method} ${scheme}//${host}:${String(port)}${path}`,
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
});
export type RecordAssetResult = typeof RecordAssetResult.Type;

/** The snake_case encoding of {@link RecordAssetResult}, for tool output. */
export const RecordAssetResultWire = RecordAssetResult.pipe(
  Schema.encodeKeys({ assetId: "asset_id" }),
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
  /** How many separate operations have recorded it. Never zero in practice. */
  discoveries: Schema.Int,
  /**
   * The attempt that found it first, and the intent that attempt was working.
   *
   * Null when no discovery row exists, which `record_asset` cannot produce — it writes
   * the discovery in the same transaction as the asset — but which a row written by
   * anything else could. Reported rather than assumed.
   */
  firstAttemptId: Schema.NullOr(Schema.String),
  firstIntentId: Schema.NullOr(Schema.String),
  /** When it was most recently seen. Not the same fact as {@link firstSeenAt}. */
  lastDiscoveredAt: Schema.NullOr(Schema.Number),
});
export type AssetView = typeof AssetView.Type;
