/**
 * The scope derivation, rule by rule.
 *
 * `scopeStateOf` is the only function in this build that decides whether a subject is in
 * the client's estate, and the store, the prompt renderer and the Svelte view all call
 * it. That is the property this file protects: there is one algorithm, so there is one
 * place to assert it, and a surface cannot disagree with another about why a host is
 * where it is.
 *
 * ## The vectors are written from the rules, not transcribed
 *
 * ars0n-framework-v2 ships a `scope/vectors.json` that it runs against both of its two
 * hand-written copies of this algorithm. It is GPL-3.0 and it is **not** copied or
 * transcribed here, in whole or in part. Every case below is written from the design's
 * own rules — D4.1 to D4.6 and the D5 ladder — and the hostnames are this repo's
 * `.test` fixtures. ars0n is cited only as the source of the *reasoning* for the label
 * boundary and the no-arithmetic-on-addresses rules, both of which are bugs it already
 * paid for.
 *
 * ## No DOM, no SQL, no database
 *
 * The subject is a contract, so this needs nothing but the module: no fixture file, no
 * store, no HTTP. The CIDR matching is hand-written for the same reason the test has no
 * dependencies — `packages/contracts` must stay browser-safe, so there is no `node:net`
 * to lean on and none to trust.
 *
 * **Why it lives under `apps/server` rather than beside the module it tests.**
 * `packages/contracts` enforces browser safety twice over: its `tsconfig.json` sets
 * `"types": []`, and `eslint.config.js` restricts the import patterns that would pull a
 * runtime in. `bun:test` is one of them, so a test file in that package fails both gates
 * — correctly. Putting it here keeps the boundary intact and follows what the repo
 * already does with `assetIdentityOf` and `dimensionsOf`, which are contract functions
 * covered from the server's suite. It imports through `@bit/contracts`, so it tests the
 * published surface rather than a relative path into the package.
 */
import { describe, expect, test } from "bun:test";

import {
  assetIdentityOf,
  describeScopeEntry,
  describeScopeLabel,
  isAssetIdentityRefusal,
  isIpAddress,
  isScopeValueRefusal,
  normaliseHost,
  normaliseScopeEntry,
  scopeStateOf,
  type AssetIdentity,
  type AssetScopeLabel,
  type HostScopeLabel,
  type ScopeEntry,
  type ScopeEffect,
  type ScopeKind,
} from "@bit/contracts";

/* ── Fixtures ────────────────────────────────────────────────────────────────────── */

let nextEntry = 0;

/** One entry, with the fields the matcher ignores filled in plausibly. */
const entry = (
  effect: ScopeEffect,
  kind: ScopeKind,
  value: string,
  overrides: { readonly source?: "operator" | "imported" } = {},
): ScopeEntry => ({
  entryId: `ent_${String((nextEntry += 1)).padStart(3, "0")}`,
  targetId: "target-1",
  effect,
  kind,
  value,
  source: overrides.source ?? "operator",
  note: null,
  createdAt: 1_000 + nextEntry,
});

const hostLabel = (host: string, state: "in" | "out"): HostScopeLabel => ({
  targetId: "target-1",
  host,
  state,
  reason: null,
  setBy: "target-1/operator",
  setAt: 2_000,
});

const assetLabel = (state: "in" | "out"): AssetScopeLabel => ({
  assetId: "asset_1",
  state,
  reason: null,
  setBy: "target-1/operator",
  setAt: 3_000,
});

/** The verdict alone, for the many cases that are only about in-or-out. */
const stateOf = (entries: readonly ScopeEntry[], host: string): "in" | "out" =>
  scopeStateOf({ entries, subject: { host } }).state;

/* ── D4.1 — one normaliser, for the entry value and the subject alike ────────────── */

describe("the normaliser", () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["lowercases", "APP.Acme.Test", "app.acme.test"],
    ["trims surrounding space", "  app.acme.test  ", "app.acme.test"],
    ["drops a trailing root dot", "app.acme.test.", "app.acme.test"],
    ["drops several trailing dots", "app.acme.test..", "app.acme.test"],
    ["drops a port", "app.acme.test:8443", "app.acme.test"],
    ["drops a scheme", "https://app.acme.test", "app.acme.test"],
    [
      "drops a scheme and a path",
      "https://app.acme.test/login",
      "app.acme.test",
    ],
    [
      "drops a scheme, port and path",
      "http://app.acme.test:8080/a/b",
      "app.acme.test",
    ],
    ["drops a query", "app.acme.test?x=1", "app.acme.test"],
    ["drops a fragment", "app.acme.test#top", "app.acme.test"],
    ["drops a bare path", "app.acme.test/login", "app.acme.test"],
    ["drops userinfo", "https://user:pw@app.acme.test/x", "app.acme.test"],
    ["keeps an IPv4 address", "203.0.113.44", "203.0.113.44"],
    ["drops a port from an IPv4 address", "203.0.113.44:8080", "203.0.113.44"],
  ];

  for (const [name, raw, expected] of cases) {
    test(name, () => {
      expect(normaliseHost(raw)).toBe(expected);
    });
  }

  /*
   * D4.1's bracket rule, which is the one that is load-bearing and easy to miss.
   *
   * An asset's `host` column is filled from `new URL(...).hostname`, which for
   * `http://[::1]:8080/x` yields `[::1]` — brackets included. An operator typing `::1`
   * normalises to `::1`, so without this step the two forms would never meet and an
   * entry an operator wrote in good faith would silently match nothing.
   */
  describe("the IPv6 bracket rule", () => {
    const ipv6: ReadonlyArray<readonly [string, string]> = [
      ["[::1]", "::1"],
      ["[::1]:8080", "::1"],
      ["http://[::1]:8080/x", "::1"],
      ["[2001:db8::1]", "2001:db8::1"],
      ["[2001:DB8::1]:443", "2001:db8::1"],
      // Unbracketed, which is how an operator types it. Two or more colons means a bare
      // IPv6 literal and therefore no port to strip: `::1` must not become `:`.
      ["::1", "::1"],
      ["2001:db8::1", "2001:db8::1"],
      ["2001:db8:0:0:0:0:0:1", "2001:db8:0:0:0:0:0:1"],
    ];
    for (const [raw, expected] of ipv6) {
      test(`${raw} normalises to ${expected}`, () => {
        expect(normaliseHost(raw)).toBe(expected);
      });
    }

    test("what the URL parser yields and what an operator types meet", () => {
      // The whole point of sharing the step: these two spellings arrive from different
      // places and must reduce to one string.
      expect(normaliseHost("[::1]")).toBe(normaliseHost("::1"));
      expect(normaliseHost("[2001:db8::1]:443")).toBe(
        normaliseHost("2001:db8::1"),
      );
    });

    test("a bracketed literal and its entry value actually match", () => {
      /*
       * The end-to-end form of the rule, and it has to be end-to-end to mean anything.
       *
       * An earlier version of this test wrote `stateOf(entries, normaliseHost("[::1]"))`
       * — wrapping the subject in the very normaliser the production path omitted — so it
       * asserted that `normaliseHost` works, which the table above already covers. It
       * passed while an IPv6 asset could not be in scope and could not be hand-labelled,
       * because `assetIdentityOf` filled the `host` column from `new URL().hostname` with
       * its brackets still on.
       *
       * So the subject here is derived **the way an asset row is**: through
       * `assetIdentityOf`, which is the only thing that writes `assets.host`. If that
       * function ever stops sharing the step, this fails.
       */
      const typed = normaliseScopeEntry({ kind: "host", value: "::1" });
      expect(isScopeValueRefusal(typed)).toBe(false);
      const entries = [entry("in", "host", typed as string)];

      const recorded = assetIdentityOf({
        kind: "endpoint",
        url: "http://[::1]:8080/x",
        method: "get",
      });
      expect(isAssetIdentityRefusal(recorded)).toBe(false);
      const asset = recorded as AssetIdentity;
      // The stored host column, verbatim: the matched form, not the authority form.
      expect(asset.host).toBe("::1");
      expect(stateOf(entries, asset.host)).toBe("in");

      const bareHost = assetIdentityOf({
        kind: "host",
        url: "https://[2001:DB8::1]/",
        method: null,
      }) as AssetIdentity;
      expect(bareHost.host).toBe("2001:db8::1");
      expect(stateOf([entry("in", "host", "2001:db8::1")], bareHost.host)).toBe(
        "in",
      );
      // And the identity an agent and an operator read keeps its brackets, because there
      // the host is part of an authority: `::1:8080` would be unreadable as a pair.
      expect(asset.identity).toBe("GET http://[::1]:8080/x");
      expect(bareHost.identity).toBe("[2001:db8::1]:443");
    });

    test("a hand label on an IPv6 asset is a label that applies", () => {
      /*
       * The anti-goal this closes: "an operator action that appears to work and does
       * nothing". A host label is keyed by the normalised host, and the ladder looks it
       * up by the asset's `host` column. If those two spellings differ the operator's
       * click is written, is visible in the label list, and decides nothing.
       */
      const asset = assetIdentityOf({
        kind: "endpoint",
        url: "http://[::1]:8080/x",
        method: "get",
      }) as AssetIdentity;
      const keyed = normaliseHost("::1");
      expect(asset.host).toBe(keyed);

      const state = scopeStateOf({
        entries: [entry("in", "cidr", "::/0")],
        hostLabel: hostLabel(keyed, "out"),
        subject: { host: asset.host },
      });
      expect(state.state).toBe("out");
      expect(state.by._tag).toBe("hostLabel");
    });
  });

  test("input that reduces to nothing is empty, never a wildcard", () => {
    // An empty subject must match nothing at all. A normaliser that returned something
    // matching everything would be the silent-coverage anti-goal in one line.
    expect(normaliseHost("")).toBe("");
    expect(normaliseHost("   ")).toBe("");
    expect(normaliseHost("https://")).toBe("");
    expect(stateOf([entry("in", "subtree", "acme.test")], "")).toBe("out");
  });
});

/* ── Telling an address from a name ──────────────────────────────────────────────── */

describe("address recognition", () => {
  const addresses = [
    "203.0.113.44",
    "0.0.0.0",
    "255.255.255.255",
    "::1",
    "::",
    "2001:db8::1",
    "2001:db8:0:0:0:0:0:1",
    "::ffff:203.0.113.9",
  ];
  for (const text of addresses) {
    test(`${text} is an address`, () => {
      expect(isIpAddress(text)).toBe(true);
    });
  }

  const names = [
    "acme.test",
    "app.acme.test",
    // Strictness that matters: a part above 255, a part with a leading zero (which some
    // resolvers read as octal), and the shortened forms nothing here expands.
    "256.0.113.44",
    "203.0.113.044",
    "010.0.0.1",
    "203.0.113",
    "203.0.113.44.55",
    "1.2.3.4.",
    "",
  ];
  for (const text of names) {
    test(`${text === "" ? "the empty string" : text} is not an address`, () => {
      expect(isIpAddress(text)).toBe(false);
    });
  }

  test("two colon runs are ambiguous and refused", () => {
    expect(isIpAddress("2001::db8::1")).toBe(false);
  });

  test("a :: standing for no groups at all is refused", () => {
    // Eight groups are already present, so the `::` means nothing and the text is a
    // mistake rather than a shorter spelling.
    expect(isIpAddress("1:2:3:4:5:6:7:8::")).toBe(false);
  });
});

/* ── D4.2 — the label boundary, never a bare suffix ──────────────────────────────── */

describe("a subtree matches on the label boundary", () => {
  const entries = [entry("in", "subtree", "example.test")];

  const inside = ["example.test", "a.example.test", "a.b.example.test"];
  for (const host of inside) {
    test(`${host} is inside example.test`, () => {
      expect(stateOf(entries, host)).toBe("in");
    });
  }

  /*
   * The bugs this rule exists to stop.
   *
   * `notexample.test` ends with `example.test` as a *string* and is a different
   * registration owned by somebody else. ScopeWeaver's `fuzzy_domain` is
   * `strings.Contains`, and used as an allow rule that is exactly how a host nobody
   * authorized comes to be treated as part of the client's estate.
   */
  const outside = [
    "notexample.test",
    "myexample.test",
    "example.test.evil.test",
    "example.testing",
    "xexample.test",
    "test",
    "exampletest",
  ];
  for (const host of outside) {
    test(`${host} is outside example.test`, () => {
      expect(stateOf(entries, host)).toBe("out");
    });
  }
});

describe("a host entry covers that host alone", () => {
  const entries = [entry("in", "host", "app.acme.test")];

  test("the host itself is in", () => {
    expect(stateOf(entries, "app.acme.test")).toBe("in");
  });

  test("nothing under it is in", () => {
    // The distinction the three-way kind split exists for. A programme that authorizes
    // one host has not authorized what sits under it.
    expect(stateOf(entries, "a.app.acme.test")).toBe("out");
  });

  test("its parent is not in either", () => {
    expect(stateOf(entries, "acme.test")).toBe("out");
  });
});

/* ── D4.3 — an address gets no label arithmetic, a name no CIDR ──────────────────── */

describe("addresses and names do not borrow each other's rules", () => {
  test("a subtree entry whose value is an address matches only that address", () => {
    const entries = [entry("in", "subtree", "203.0.113.44")];
    expect(stateOf(entries, "203.0.113.44")).toBe("in");
    // There is nothing "under" an address, whatever kind the entry claims.
    expect(stateOf(entries, "a.203.0.113.44")).toBe("out");
    expect(stateOf(entries, "203.0.113.45")).toBe("out");
  });

  test("an address is never read as a subdomain of its own tail", () => {
    /*
     * The structural form of the bug: with label arithmetic applied to addresses,
     * `198.51.100.7` ends with `.100.7` and would be matched by a subtree entry on
     * `100.7`. Treating an address as an address makes that impossible rather than
     * unlikely.
     *
     * The addresses are this repo's own documentation-range fixtures. An earlier version
     * used the one distinctive literal pair this file shared with ars0n-framework-v2,
     * which is GPL-3.0 and is cited here only for the reasoning; the rule under test is
     * unchanged.
     */
    const entries = [entry("in", "subtree", "100.7")];
    expect(stateOf(entries, "198.51.100.7")).toBe("out");
    // The same shape one level up, so a lucky tail is not what passes it.
    expect(stateOf([entry("in", "subtree", "51.100.7")], "198.51.100.7")).toBe(
      "out",
    );
  });

  test("a name never matches a CIDR entry", () => {
    const entries = [entry("in", "cidr", "203.0.113.0/24")];
    expect(stateOf(entries, "acme.test")).toBe("out");
    // Not even a name that looks numeric but is not a valid address.
    expect(stateOf(entries, "203.0.113")).toBe("out");
  });

  test("an address never matches a name entry", () => {
    const entries = [
      entry("in", "subtree", "acme.test"),
      entry("in", "host", "app.acme.test"),
    ];
    expect(stateOf(entries, "203.0.113.44")).toBe("out");
  });
});

/* ── CIDR matching, both families ────────────────────────────────────────────────── */

describe("CIDR matching", () => {
  const within = (block: string, host: string): boolean =>
    stateOf([entry("in", "cidr", block)], host) === "in";

  test("an IPv4 /24 covers its block and nothing beside it", () => {
    expect(within("203.0.113.0/24", "203.0.113.0")).toBe(true);
    expect(within("203.0.113.0/24", "203.0.113.1")).toBe(true);
    expect(within("203.0.113.0/24", "203.0.113.255")).toBe(true);
    expect(within("203.0.113.0/24", "203.0.112.255")).toBe(false);
    expect(within("203.0.113.0/24", "203.0.114.0")).toBe(false);
  });

  test("a /32 is one address", () => {
    expect(within("203.0.113.44/32", "203.0.113.44")).toBe(true);
    expect(within("203.0.113.44/32", "203.0.113.45")).toBe(false);
  });

  test("a prefix that is not a whole number of bytes still works", () => {
    // `/26` is the design's own example, and the partial-byte path is the one a
    // byte-by-byte comparison alone would get wrong.
    expect(within("203.0.113.64/26", "203.0.113.64")).toBe(true);
    expect(within("203.0.113.64/26", "203.0.113.127")).toBe(true);
    expect(within("203.0.113.64/26", "203.0.113.63")).toBe(false);
    expect(within("203.0.113.64/26", "203.0.113.128")).toBe(false);
    // `/31`, where only the last bit is free.
    expect(within("203.0.113.44/31", "203.0.113.45")).toBe(true);
    expect(within("203.0.113.44/31", "203.0.113.46")).toBe(false);
  });

  test("a /0 covers every address of its family and no name", () => {
    /*
     * The case a 32-bit mask gets wrong. `0xff << 32` is not 0 in JavaScript — shifts are
     * modulo 32, so it is `0xff` — and the resulting bug presents as "the whole internet
     * is in scope", which is not a thing to leave to chance. Comparing bytes avoids it.
     */
    expect(within("0.0.0.0/0", "203.0.113.44")).toBe(true);
    expect(within("0.0.0.0/0", "10.0.0.1")).toBe(true);
    // Still not a name, and still not the other family.
    expect(within("0.0.0.0/0", "acme.test")).toBe(false);
    expect(within("0.0.0.0/0", "2001:db8::1")).toBe(false);
  });

  test("an IPv6 prefix covers its block", () => {
    expect(within("2001:db8::/32", "2001:db8::1")).toBe(true);
    expect(within("2001:db8::/32", "2001:db8:ffff::1")).toBe(true);
    expect(within("2001:db8::/32", "2001:db9::1")).toBe(false);
    expect(within("2001:db8::/128", "2001:db8::")).toBe(true);
    expect(within("2001:db8::/128", "2001:db8::1")).toBe(false);
    expect(within("::/0", "2001:db8::1")).toBe(true);
    // And an IPv4 address is not inside an IPv6 block.
    expect(within("::/0", "203.0.113.44")).toBe(false);
  });

  test("the families do not mix", () => {
    expect(within("2001:db8::/32", "203.0.113.44")).toBe(false);
    expect(within("203.0.113.0/24", "::ffff:203.0.113.9")).toBe(false);
  });

  test("a malformed block matches nothing rather than everything", () => {
    // A value that cannot be parsed is inert. The failure mode to avoid is a matcher
    // that treats an unparseable prefix as a wildcard.
    expect(within("not-a-block", "203.0.113.44")).toBe(false);
    expect(within("203.0.113.0/33", "203.0.113.44")).toBe(false);
    expect(within("203.0.113.0/", "203.0.113.44")).toBe(false);
  });
});

/* ── D4.4 and D4.5 — out wins, and the default is out ───────────────────────────── */

describe("within the entry layer there is no precedence", () => {
  test("out wins even when the in entry is more specific", () => {
    /*
     * D4.4 is unconditional: no ordering, no specificity override. A `host` entry is the
     * most specific kind there is, and it still loses to a `subtree` exclusion.
     */
    const entries = [
      entry("in", "host", "blog.acme.test"),
      entry("out", "subtree", "acme.test"),
    ];
    expect(stateOf(entries, "blog.acme.test")).toBe("out");
  });

  test("out wins whatever order the entries arrive in", () => {
    const included = entry("in", "subtree", "acme.test");
    const excluded = entry("out", "host", "blog.acme.test");
    expect(stateOf([included, excluded], "blog.acme.test")).toBe("out");
    expect(stateOf([excluded, included], "blog.acme.test")).toBe("out");
  });

  test("out wins across kinds", () => {
    const entries = [
      entry("in", "cidr", "203.0.113.0/24"),
      entry("out", "host", "203.0.113.44"),
    ];
    expect(stateOf(entries, "203.0.113.44")).toBe("out");
    expect(stateOf(entries, "203.0.113.45")).toBe("in");
  });

  test("the default is out, and it says nothing matched", () => {
    const state = scopeStateOf({
      entries: [entry("in", "subtree", "acme.test")],
      subject: { host: "api.acme-cdn.test" },
    });
    expect(state.state).toBe("out");
    // "Covered by nothing" is its own sentence, distinct from "excluded on purpose".
    expect(state.by._tag).toBe("default");
    expect(state.overrode).toBeNull();
  });

  test("an empty entry list leaves everything out by default", () => {
    const state = scopeStateOf({ entries: [], subject: { host: "acme.test" } });
    expect(state.state).toBe("out");
    expect(state.by._tag).toBe("default");
  });

  test("an exclusion that matched is not the same as nothing matching", () => {
    const excluded = entry("out", "host", "blog.acme.test");
    const state = scopeStateOf({
      entries: [excluded],
      subject: { host: "blog.acme.test" },
    });
    expect(state.state).toBe("out");
    // Both are `out`, and the view must be able to tell them apart: this one was typed.
    expect(state.by).toEqual({ _tag: "entry", entry: excluded });
  });
});

/* ── D4.6 — which entry gets named ───────────────────────────────────────────────── */

describe("which matching entry is named", () => {
  test("host beats subtree beats cidr", () => {
    const host = entry("in", "host", "203.0.113.44");
    const subtree = entry("in", "subtree", "203.0.113.44");
    const cidr = entry("in", "cidr", "203.0.113.0/24");
    const state = scopeStateOf({
      entries: [cidr, subtree, host],
      subject: { host: "203.0.113.44" },
    });
    expect(state.by).toEqual({ _tag: "entry", entry: host });

    const withoutHost = scopeStateOf({
      entries: [cidr, subtree],
      subject: { host: "203.0.113.44" },
    });
    expect(withoutHost.by).toEqual({ _tag: "entry", entry: subtree });
  });

  test("the longer value wins within one kind", () => {
    // The nearer apex is the more informative sentence: a host under
    // `labs.acme.test` is better explained by that than by `acme.test`.
    const broad = entry("in", "subtree", "acme.test");
    const narrow = entry("in", "subtree", "labs.acme.test");
    const state = scopeStateOf({
      entries: [broad, narrow],
      subject: { host: "x.labs.acme.test" },
    });
    expect(state.by).toEqual({ _tag: "entry", entry: narrow });
  });

  test("the named entry is chosen among the winning effect only", () => {
    /*
     * With an exclusion in play the verdict is `out`, so the entry named must be one of
     * the `out` entries — naming the most specific entry overall would have the view say
     * "in scope, because app.acme.test" beside a verdict of `out`.
     */
    const state = scopeStateOf({
      entries: [
        entry("in", "host", "app.acme.test"),
        entry("out", "subtree", "acme.test"),
      ],
      subject: { host: "app.acme.test" },
    });
    expect(state.state).toBe("out");
    expect(state.by._tag).toBe("entry");
    if (state.by._tag === "entry") {
      expect(state.by.entry.effect).toBe("out");
    }
  });

  test("naming is a heuristic over the sentence and never over the verdict", () => {
    // Shuffling equally specific entries cannot change in-or-out, which is what makes
    // the choice of name safe to be a heuristic at all.
    const a = entry("in", "subtree", "one.acme.test");
    const b = entry("in", "subtree", "two.acme.test");
    expect(stateOf([a, b], "x.one.acme.test")).toBe("in");
    expect(stateOf([b, a], "x.one.acme.test")).toBe("in");
  });
});

/* ── D5 — the ladder: asset label over host label over entries ──────────────────── */

describe("the precedence ladder", () => {
  const included = entry("in", "subtree", "acme.test");
  const excluded = entry("out", "subtree", "labs.acme.test");

  test("a host label beats an entry, out over in", () => {
    const state = scopeStateOf({
      entries: [included],
      hostLabel: hostLabel("legacy.acme.test", "out"),
      subject: { host: "legacy.acme.test" },
    });
    expect(state.state).toBe("out");
    expect(state.by._tag).toBe("hostLabel");
    // The operator asked for exactly this: `legacy.acme.test` excludable while
    // `acme.test` stays in. The view can say which entry it beat.
    expect(state.overrode).toEqual(included);
  });

  test("a host label beats an entry, in over out", () => {
    /*
     * D8's promotion case. Promoting `x.labs.acme.test` while `out`/`subtree`
     * `labs.acme.test` is in the typed list succeeds, and the view states it plainly: in
     * scope, set by hand, overriding that exclusion.
     *
     * The alternative — refusing the promotion and making the operator narrow their own
     * exclusion — was rejected because a visible, attributed, single-host carve-out is a
     * better record of the decision than an edit to the list that loses the fact a
     * carve-out was made.
     */
    const state = scopeStateOf({
      entries: [included, excluded],
      hostLabel: hostLabel("x.labs.acme.test", "in"),
      subject: { host: "x.labs.acme.test" },
    });
    expect(state.state).toBe("in");
    expect(state.by._tag).toBe("hostLabel");
    expect(state.overrode).toEqual(excluded);
  });

  test("an asset label beats a host label, in both directions", () => {
    const base = {
      entries: [included],
      hostLabel: hostLabel("app.acme.test", "out"),
      subject: { host: "app.acme.test" },
    };
    // A single endpoint kept while its host is excluded.
    const kept = scopeStateOf({ ...base, assetLabel: assetLabel("in") });
    expect(kept.state).toBe("in");
    expect(kept.by._tag).toBe("assetLabel");

    // And the mirror: one endpoint excluded while its host stays in.
    const dropped = scopeStateOf({
      entries: [included],
      hostLabel: hostLabel("app.acme.test", "in"),
      assetLabel: assetLabel("out"),
      subject: { host: "app.acme.test" },
    });
    expect(dropped.state).toBe("out");
    expect(dropped.by._tag).toBe("assetLabel");
  });

  test("an asset label beats the entries with no host label present", () => {
    const state = scopeStateOf({
      entries: [included],
      assetLabel: assetLabel("out"),
      subject: { host: "app.acme.test" },
    });
    expect(state.state).toBe("out");
    expect(state.by._tag).toBe("assetLabel");
    expect(state.overrode).toEqual(included);
  });

  test("a label that agrees with the entries overrode nothing", () => {
    // Still decided by the label — the operator's act is what is recorded — but there is
    // no beaten entry, and claiming one would describe a conflict that never happened.
    const state = scopeStateOf({
      entries: [included],
      hostLabel: hostLabel("app.acme.test", "in"),
      subject: { host: "app.acme.test" },
    });
    expect(state.state).toBe("in");
    expect(state.by._tag).toBe("hostLabel");
    expect(state.overrode).toBeNull();
  });

  test("a label over a subject no entry covers overrode nothing", () => {
    /*
     * The promotion in A4's Estate view: `api.acme-cdn.test` is covered by nothing, and
     * promoting it overrides no exclusion. "Never covered, then promoted" and "promoted
     * out from under an exclusion you typed" are different facts, and `overrode` is how
     * the view tells them apart.
     */
    const state = scopeStateOf({
      entries: [included],
      hostLabel: hostLabel("api.acme-cdn.test", "in"),
      subject: { host: "api.acme-cdn.test" },
    });
    expect(state.state).toBe("in");
    expect(state.overrode).toBeNull();
  });

  test("an asset label beats an out entry that a host label also lost to", () => {
    // All three layers in play at once, which is the case a ladder written as nested
    // conditionals tends to get wrong.
    const state = scopeStateOf({
      entries: [excluded],
      hostLabel: hostLabel("x.labs.acme.test", "in"),
      assetLabel: assetLabel("out"),
      subject: { host: "x.labs.acme.test" },
    });
    expect(state.state).toBe("out");
    expect(state.by._tag).toBe("assetLabel");
    // The asset label decided, and what it overrode is still the typed exclusion —
    // which it happens to agree with. So there is nothing overridden to report.
    expect(state.overrode).toBeNull();
  });

  test("entries cannot touch a label, which is what makes a recompute safe", () => {
    // The anti-goal about an operator's hand label erased by a recompute: adding entries
    // changes nothing about a labelled subject's verdict.
    const label = hostLabel("legacy.acme.test", "out");
    const before = scopeStateOf({
      entries: [],
      hostLabel: label,
      subject: { host: "legacy.acme.test" },
    });
    const after = scopeStateOf({
      entries: [included, entry("in", "host", "legacy.acme.test")],
      hostLabel: label,
      subject: { host: "legacy.acme.test" },
    });
    expect(before.state).toBe("out");
    expect(after.state).toBe("out");
  });
});

/* ── Entry normalisation on write ────────────────────────────────────────────────── */

describe("normalising an entry on write", () => {
  const value = (kind: ScopeKind, raw: string): string | undefined => {
    const result = normaliseScopeEntry({ kind, value: raw });
    return isScopeValueRefusal(result) ? undefined : result;
  };

  test("a host or apex is stored in the form the matcher uses", () => {
    expect(value("subtree", "  ACME.Test.  ")).toBe("acme.test");
    expect(value("host", "https://App.Acme.Test:8443/login")).toBe(
      "app.acme.test",
    );
  });

  test("an address is stored in one canonical spelling", () => {
    // One thing, one row: the unique index is on this text, so two spellings of one
    // address would become two rows the matcher then evaluates twice.
    expect(value("host", "2001:DB8::0001")).toBe("2001:db8::1");
    expect(value("host", "[::1]:443")).toBe("::1");
    expect(value("host", "2001:db8:0:0:0:0:0:1")).toBe("2001:db8::1");
  });

  test("a CIDR keeps its prefix and is re-rendered from the parse", () => {
    expect(value("cidr", "203.0.113.0/24")).toBe("203.0.113.0/24");
    expect(value("cidr", "2001:DB8::/32")).toBe("2001:db8::/32");
    // Re-rendered rather than echoed, so one block has one spelling.
    expect(value("cidr", "2001:db8:0:0:0:0:0:0/32")).toBe("2001:db8::/32");
  });

  test("a CIDR is not put through the host normaliser", () => {
    // The host normaliser removes a path, and a prefix length sits exactly where a path
    // would. A `cidr` whose `/24` was stripped would silently become a single address.
    expect(value("cidr", "203.0.113.0/24")).toContain("/24");
  });

  test("a block typed into a host field is refused, not silently narrowed", () => {
    /*
     * The bug this guard exists for, asserted as the thing that must NOT happen.
     *
     * `normaliseHost` removes a path and a prefix length sits exactly where a path
     * would, so without a check on the *raw* value `203.0.113.0/24` reduces to
     * `203.0.113.0` and is stored as one address. The operator would see their entry
     * accepted and would have no way to tell that 255 addresses had quietly dropped out
     * of it. The refusal names what would have happened.
     */
    expect(value("host", "203.0.113.0/24")).toBeUndefined();
    const result = normaliseScopeEntry({
      kind: "host",
      value: "203.0.113.0/24",
    });
    expect(isScopeValueRefusal(result)).toBe(true);
    if (isScopeValueRefusal(result)) {
      expect(result.detail).toContain("add it as a CIDR entry instead");
      expect(result.detail).toContain("203.0.113.0");
    }
    // A URL with a real path still normalises, so the guard is specific to a prefix.
    expect(value("host", "https://app.acme.test/login")).toBe("app.acme.test");
  });

  const refusals: ReadonlyArray<readonly [ScopeKind, string, string]> = [
    ["host", "", "needs a value"],
    ["host", "   ", "needs a value"],
    ["subtree", "localhost", "single label with no dot"],
    ["subtree", "*.acme.test", "wildcard"],
    ["cidr", "203.0.113.44", "not an address block"],
    ["cidr", "acme.test/24", "not an address block"],
    ["cidr", "203.0.113.0/33", "not an address block"],
    ["host", "203.0.113.0/24", "is an address block"],
    ["subtree", "2001:db8::/32", "is an address block"],
  ];
  for (const [kind, raw, expected] of refusals) {
    test(`a ${kind} entry of '${raw}' is refused, naming the remedy`, () => {
      const result = normaliseScopeEntry({ kind, value: raw });
      expect(isScopeValueRefusal(result)).toBe(true);
      if (isScopeValueRefusal(result)) {
        expect(result.detail).toContain(expected);
      }
    });
  }

  test("an entry with an invisible character in it is refused, by code point, without echoing it", () => {
    /*
     * `moc.emca` behind a right-to-left override is listed as `acme.com` and matches
     * nothing called that; a zero-width space or a tag letter in a host is a letter nobody
     * sees. The importer proposes entries from program pages a stranger wrote, so each is
     * refused, and the sentence names the character rather than repeating the value, which
     * would reorder the sentence too.
     */
    const cases: ReadonlyArray<readonly [ScopeKind, string, string]> = [
      ["subtree", "\u202Emoc.emca", "U+202E"],
      ["host", "\u2067com\u200F.\u200Facme\u2069", "U+2067"],
      ["host", "ac\u200Bme.com", "U+200B"],
      ["subtree", "acme\u2060.com", "U+2060"],
      ["host", "acme.com\u{E0041}", "U+E0041"],
      // `trim()` would drop it at the end; the check runs on the value as given.
      ["host", "acme.com\uFEFF", "U+FEFF"],
      ["cidr", "203.0.113.0\u200E/24", "U+200E"],
    ];
    for (const [kind, raw, point] of cases) {
      const result = normaliseScopeEntry({ kind, value: raw });
      expect(isScopeValueRefusal(result)).toBe(true);
      if (isScopeValueRefusal(result)) {
        expect(result.detail).toContain(`invisible character (${point})`);
        expect(result.detail).toContain("type the value again without it");
        expect(result.detail).not.toContain(raw.trim());
        expect(
          /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u.test(
            result.detail,
          ),
        ).toBe(false);
      }
    }
    // A plain host still normalises.
    expect(value("host", "acme.com")).toBe("acme.com");
  });

  test("a host is ASCII only: every other character is refused by code point, not by a list", () => {
    /*
     * A denylist of invisible characters let each of these through (U12 review): each is
     * drawn as nothing or as a blank, so the entry was listed as `acme.com` and matched as
     * a host nobody called that. The rule is now an allowlist, and the sentence still names
     * the character rather than echoing the value.
     */
    const cases: ReadonlyArray<readonly [ScopeKind, string, string, string]> = [
      ["host", "acme\u00AD.com", "U+00AD", "not ASCII"],
      ["host", "acme\u2061.com", "U+2061", "not ASCII"],
      ["subtree", "acme\u180E.com", "U+180E", "not ASCII"],
      ["host", "acme\u034F.com", "U+034F", "not ASCII"],
      ["host", "acme.com\uFE0F", "U+FE0F", "not ASCII"],
      ["host", "acme.com\u{E0100}", "U+E0100", "not ASCII"],
      ["subtree", "acme\u3164.com", "U+3164", "not ASCII"],
      ["host", "acme\u00A0.com", "U+00A0", "not ASCII"],
      // `trim()` drops a no-break space at an end; the check does not.
      ["host", "acme.com\u00A0", "U+00A0", "not ASCII"],
      ["host", "acme .com", "U+0020", "a space"],
      ["host", "acme\t.com", "U+0009", "a control character"],
      ["cidr", "203.0.113.0 /24", "U+0020", "a space"],
      // In the host a URL names, it is still the host's character.
      ["host", "https://acme\u00AD.com/x", "U+00AD", "not ASCII"],
      ["subtree", "https://acme\u3164.com:8443/", "U+3164", "not ASCII"],
    ];
    for (const [kind, raw, point, why] of cases) {
      const result = normaliseScopeEntry({ kind, value: raw });
      expect(isScopeValueRefusal(result), JSON.stringify(raw)).toBe(true);
      if (isScopeValueRefusal(result)) {
        expect(result.detail).toContain(point);
        expect(result.detail).toContain(why);
        expect(result.detail).not.toContain(raw.trim());
        expect(/[^\x20-\x7E\u2014\u2026]/u.test(result.detail)).toBe(false);
      }
    }
    // Blanks around a value are still only blanks.
    expect(value("host", "  acme.com\t")).toBe("acme.com");
  });

  test("a character outside ASCII in a pasted URL's path or query is not the host's", () => {
    /*
     * A host or subtree entry keeps only the host a URL names, as `https://acme.com/x` is
     * stored as `acme.com`; telling the operator to type `/über` as punycode would be
     * advice about a part of the value that is thrown away.
     */
    expect(value("host", "https://acme.com/\u00FCber")).toBe("acme.com");
    expect(value("subtree", "https://acme.com/a b?q=\u00E9#\u00E9")).toBe(
      "acme.com",
    );
    // Userinfo is refused whatever it is written in (below), not told to be punycode.
    const user = normaliseScopeEntry({
      kind: "host",
      value: "https://\u00FCser@acme.com/",
    });
    expect(isScopeValueRefusal(user) ? user.detail : user).toContain(
      "names a user before the host",
    );
    // A host that is not ASCII is still refused with the hint, path or none.
    const result = normaliseScopeEntry({
      kind: "host",
      value: "https://b\u00FCcher.de/\u00FCber",
    });
    expect(isScopeValueRefusal(result)).toBe(true);
    if (isScopeValueRefusal(result)) {
      expect(result.detail).toContain("U+00FC");
      expect(result.detail).toContain("punycode (xn--");
    }
    // An invisible character is refused wherever it is: it is a sign, not a typo.
    const hidden = normaliseScopeEntry({
      kind: "host",
      value: "https://acme.com/\u202Ex",
    });
    expect(isScopeValueRefusal(hidden)).toBe(true);
  });

  test("an internationalised name is refused with the punycode hint, and its punycode is accepted", () => {
    for (const raw of [
      "b\u00FCcher.de",
      "\u05D0\u05D1.com",
      "\u0430\u0441me.com",
    ]) {
      const result = normaliseScopeEntry({ kind: "subtree", value: raw });
      expect(isScopeValueRefusal(result), raw).toBe(true);
      if (isScopeValueRefusal(result)) {
        expect(result.detail).toContain("ASCII only");
        expect(result.detail).toContain("punycode (xn--");
      }
    }
    expect(value("subtree", "xn--bcher-kva.de")).toBe("xn--bcher-kva.de");
    expect(value("host", "https://XN--Bcher-kva.DE/x")).toBe(
      "xn--bcher-kva.de",
    );
  });

  test("a normalised host holds only host characters", () => {
    for (const raw of [
      "acme.com,evil.com",
      "acme%2ecom.test",
      "acme!.com",
      "acme.com;x",
    ]) {
      const result = normaliseScopeEntry({ kind: "host", value: raw });
      expect(isScopeValueRefusal(result), raw).toBe(true);
      if (isScopeValueRefusal(result)) {
        expect(result.detail).toContain(
          "not a character a host is written with",
        );
      }
    }
    expect(value("host", "under_score.acme-corp.test")).toBe(
      "under_score.acme-corp.test",
    );
    expect(value("host", "[2001:db8::1]:8443")).toBe("2001:db8::1");
    // The refusal names every character a host may have, the IPv6 colon included.
    const refused = normaliseScopeEntry({ kind: "host", value: "acme!.com" });
    if (isScopeValueRefusal(refused)) {
      expect(refused.detail).toContain("and ':' in an IPv6 address");
    }
  });

  test("a wildcard is refused rather than quietly accepted as an apex", () => {
    /*
     * `*.acme.test` is what a programme page writes, and it is what a subtree entry on
     * `acme.test` already means. Accepting the text and storing it literally would
     * produce an entry matching nothing; silently rewriting it to the apex would widen
     * the entry past what the operator typed. Refusing it and saying so is the only
     * option that does neither.
     */
    const result = normaliseScopeEntry({
      kind: "subtree",
      value: "*.acme.test",
    });
    expect(isScopeValueRefusal(result)).toBe(true);
    if (isScopeValueRefusal(result)) {
      expect(result.detail).toContain("write the apex alone");
    }
  });
});

/* ── The one renderer ────────────────────────────────────────────────────────────── */

describe("the entry renderer", () => {
  test("every kind spells out what it reaches", () => {
    /*
     * The anti-goal this answers: an entry silently covering more than its text says. A
     * chip reading `acme.test` that means "and every subdomain" without saying so is the
     * misread the whole model exists to prevent, and one renderer is how it is fixed for
     * every surface at once.
     */
    expect(describeScopeEntry({ kind: "subtree", value: "acme.test" })).toBe(
      "acme.test and every subdomain",
    );
    expect(
      describeScopeEntry({ kind: "host", value: "app.partner.test" }),
    ).toBe("app.partner.test (that host only)");
    expect(describeScopeEntry({ kind: "cidr", value: "203.0.113.0/24" })).toBe(
      "203.0.113.0/24 (every address in the block)",
    );
  });

  test("no kind renders as bare text", () => {
    // A row that showed only the value would be the silent-coverage anti-goal again.
    for (const kind of ["subtree", "host", "cidr"] as const) {
      const sentence = describeScopeEntry({ kind, value: "acme.test" });
      expect(sentence).not.toBe("acme.test");
      expect(sentence.length).toBeGreaterThan("acme.test".length);
    }
  });

  test("a label says how far it reaches, and that it was set by hand", () => {
    expect(
      describeScopeLabel({
        _tag: "hostLabel",
        label: hostLabel("api.acme-cdn.test", "in"),
      }),
    ).toBe(
      "api.acme-cdn.test (set by hand: every asset on that host, now and later)",
    );
    // "Now and later" is the part that matters: it is what makes an exclusion still
    // cover the endpoint found under it next week.
    expect(
      describeScopeLabel({ _tag: "assetLabel", label: assetLabel("out") }),
    ).toBe("this asset alone (set by hand)");
  });
});

/*
 * A pasted URL is read as `new URL()` reads it: the authority ends at the first `/`, `?`,
 * `#` or `\`, and only then is userinfo looked for. A review found the reverse order —
 * userinfo cut at the last `@` anywhere — storing each of the URLs below as the host after
 * the `@`, which is a different host from the one the URL names: an entry the operator
 * reads as acme.com that covers evil.com, and a subject on acme.com scored as victim.org.
 */
describe("a pasted URL names the host new URL() names", () => {
  const value = (kind: ScopeKind, raw: string): string => {
    const result = normaliseScopeEntry({ kind, value: raw });
    return isScopeValueRefusal(result) ? `refused: ${result.detail}` : result;
  };
  const pasted: ReadonlyArray<readonly [string, string]> = [
    ["https://acme.com/x@evil.com", "acme.com"],
    ["https://acme.com?next=a@evil.com", "acme.com"],
    ["https://acme.com#@evil.com", "acme.com"],
    ["https://app.acme.com/login?u=me@victim.org", "app.acme.com"],
    ["https://acme.com\\@evil.com", "acme.com"],
    ["acme.com/x@evil.com", "acme.com"],
    // A `://` past the start is in a path or query, not a scheme.
    ["acme.com/?next=https://evil.com", "acme.com"],
    ["https://acme.com/?next=https://evil.com/", "acme.com"],
    ["HTTPS://ACME.com/x@Evil.com", "acme.com"],
  ];

  for (const [raw, host] of pasted) {
    test(`${raw} is ${host}, as subject and as entry`, () => {
      if (/^[a-z]+:\/\//iu.test(raw)) {
        expect(new URL(raw).hostname).toBe(host);
      }
      expect(normaliseHost(raw)).toBe(host);
      expect(value("host", raw)).toBe(host);
      expect(value("subtree", raw)).toBe(host);
      // And the matcher agrees: an entry from the URL covers the host it names, only.
      const entries = [entry("in", "host", value("host", raw))];
      expect(stateOf(entries, host)).toBe("in");
      for (const other of ["evil.com", "victim.org"]) {
        expect(stateOf(entries, normaliseHost(other))).toBe("out");
      }
    });
  }

  test("a host or subtree entry that names a user before the host is refused", () => {
    for (const kind of ["host", "subtree"] as const) {
      for (const raw of [
        "https://user@acme.com",
        "https://user:pass@acme.com/",
        "user@acme.com",
        "user:pass@acme.com:8443",
        "https://evil.com@acme.com/x",
        "https://a@b@acme.com",
      ]) {
        const result = normaliseScopeEntry({ kind, value: raw });
        expect(isScopeValueRefusal(result), `${kind} ${raw}`).toBe(true);
        if (isScopeValueRefusal(result)) {
          expect(result.detail).toBe(
            "this entry names a user before the host (the part before '@'); type the host on its own",
          );
          // Not echoed: the part before the `@` may be a password.
          expect(result.detail).not.toContain("pass");
        }
      }
    }
    // An `@` past the authority is not userinfo: the path is dropped, the host is kept.
    expect(value("host", "https://acme.com/a@b")).toBe("acme.com");
  });

  test("a subject's host still drops userinfo, as new URL().hostname does", () => {
    // Subjects and labels are read, not authored: the host a URL names is the host.
    expect(normaliseHost("https://user:pw@acme.com/x@evil.com")).toBe(
      "acme.com",
    );
    expect(new URL("https://user:pw@acme.com/x@evil.com").hostname).toBe(
      "acme.com",
    );
  });
});
