/**
 * Structured target scope: what the client's estate is, and what decided it.
 *
 * A target used to carry one free-text `scope_note` that nothing read. This module is
 * what replaces it as the machine-readable answer, and it does exactly two jobs: it is
 * what the agent is told it may test, and it is the frame the discovered estate is
 * displayed in.
 *
 * ## One derivation, in one place
 *
 * {@link scopeStateOf} is the **only** function that decides whether a subject is in
 * scope. The store calls it, the prompt renderer calls it, the Svelte view calls it.
 * ars0n-framework-v2 has the same algorithm hand-written twice — once in Go and once in
 * JavaScript — and keeps a vectors file run as a test on both sides to stop them drifting;
 * one function in one language is the same property obtained structurally rather than by
 * vigilance.
 *
 * The two labels are passed **already looked up**, by host and by asset id, so this stays
 * pure and cheap and the store owns the lookups. That is what lets a Svelte component
 * call it on rows it already has without a round trip.
 *
 * ## What this is not
 *
 * **It is not a gate.** Nothing here authorizes or denies anything. `PERMISSIVE_POLICY`
 * stays permissive and no host allowlist is derived from these entries. A `ScopeState` of
 * `out` means "this is labelled as outside the client's estate", not "this was blocked" —
 * the operator asked for a starting point that tells the agent what it may test,
 * explicitly not a mechanism that stops it testing anything else.
 *
 * **It never hides anything.** An artefact no in-scope entry covers is recorded, kept,
 * displayed and labelled. There is no function here that filters a list.
 *
 * ## Browser-safe
 *
 * Effect Schema and string operations only. The CIDR matching is written by hand: no
 * `node:net`, nothing from Bun, no dependency. `packages/contracts` is imported by the
 * web and that boundary is enforced by `bun run lint`.
 */
import { Schema } from "effect";

/* ── The two axes of an entry ────────────────────────────────────────────────────── */

/**
 * Whether an entry brings something in or puts it out.
 *
 * `out` wins unconditionally over `in` within the entry layer — see {@link scopeStateOf}.
 */
export const ScopeEffect = Schema.Literals(["in", "out"]).annotate({
  description:
    "in to authorize, out to exclude. An out entry always beats an in entry.",
});
export type ScopeEffect = typeof ScopeEffect.Type;

/**
 * How much of the estate one entry's value reaches.
 *
 * Three, and the three-way split is the whole point: a chip reading `example.com` that
 * silently means "and every subdomain" is the misread this model exists to prevent. The
 * reach is a property of the row rather than a convention a reader has to know.
 *
 * ars0n's `contains` and `regex` kinds are deliberately not here. They are machinery for
 * an enforcement boundary with operator-authored patterns; our entries are literal hosts,
 * apexes and CIDRs, and a `contains` rule used as an *allow* is how `notexample.com`
 * comes to be treated as part of `example.com`.
 */
export const ScopeKind = Schema.Literals(["subtree", "host", "cidr"]).annotate({
  description:
    "subtree for an apex and every subdomain; host for that host alone; cidr for an address block.",
});
export type ScopeKind = typeof ScopeKind.Type;

/**
 * Who wrote an entry.
 *
 * This is what makes the operator's review a real step. An imported entry and a typed one
 * are identical to the matcher and must be distinguishable on screen, because "read this
 * list before you start" only means something if the rows that need reading are the ones
 * a machine wrote.
 *
 * There is no `agent` source and there will not be one. No agent that tests may write an
 * entry; the importer that may is a different role on a different endpoint that runs
 * before any goal exists.
 */
export const ScopeEntrySource = Schema.Literals([
  "operator",
  "imported",
]).annotate({
  description:
    "operator for an entry a person typed; imported for one the scope importer transcribed from a program page.",
});
export type ScopeEntrySource = typeof ScopeEntrySource.Type;

/**
 * One authored scope entry.
 *
 * `value` is **already normalised** — {@link normaliseScopeEntry} runs on write, so the
 * stored form is the matched form. A reader of this type may assume it; a writer may not.
 */
export const ScopeEntry = Schema.Struct({
  entryId: Schema.String,
  targetId: Schema.String,
  effect: ScopeEffect,
  kind: ScopeKind,
  /** The apex, the host, or the CIDR, normalised. */
  value: Schema.String,
  source: ScopeEntrySource,
  /** For an imported entry, where on the page it came from. Null for a typed one. */
  note: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
});
export type ScopeEntry = typeof ScopeEntry.Type;

/* ── The two label layers ────────────────────────────────────────────────────────── */

/** What a hand label says. The same two words an entry's effect uses, deliberately. */
export const ScopeLabelState = Schema.Literals(["in", "out"]);
export type ScopeLabelState = typeof ScopeLabelState.Type;

/**
 * An operator's decision about one host, covering every asset on it.
 *
 * **Present and future, and that is the point of keying on the host.** With labels keyed
 * only by asset, excluding `legacy.acme.com` today would mark that one row, and
 * `legacy.acme.com/login` discovered tomorrow would be a different row with no label,
 * derive from the entries, and come back in scope — the operator's exclusion would
 * silently fail to cover the thing they meant by it.
 *
 * `host` is normalised through {@link normaliseHost}, the same function an entry value and
 * a subject go through, or a label would be keyed by a string the matcher never produces.
 */
export const HostScopeLabel = Schema.Struct({
  targetId: Schema.String,
  host: Schema.String,
  state: ScopeLabelState,
  /** Why, as the operator gave it. Null when they gave none. */
  reason: Schema.NullOr(Schema.String),
  /** The operator authority from the mutation boundary. */
  setBy: Schema.String,
  setAt: Schema.Number,
});
export type HostScopeLabel = typeof HostScopeLabel.Type;

/**
 * An operator's decision about one asset, which beats its host's label.
 *
 * Specificity inside the label layer is fine and expected: every row in both label tables
 * is an explicit act by the same person, and the more specific act is the later, narrower
 * decision. So a single endpoint can be excluded without excluding its host, or kept while
 * its host is excluded.
 */
export const AssetScopeLabel = Schema.Struct({
  assetId: Schema.String,
  state: ScopeLabelState,
  reason: Schema.NullOr(Schema.String),
  setBy: Schema.String,
  setAt: Schema.Number,
});
export type AssetScopeLabel = typeof AssetScopeLabel.Type;

/* ── The verdict ─────────────────────────────────────────────────────────────────── */

/**
 * What decided a subject's scope state.
 *
 * A discriminated union rather than an optional entry, because "excluded on purpose",
 * "excluded by hand" and "never covered" lead to three different sentences and three
 * different affordances in the view, and collapsing any two of them is how a screen starts
 * lying about why something is where it is.
 */
export const ScopeDecidedBy = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("assetLabel"), label: AssetScopeLabel }),
  Schema.Struct({ _tag: Schema.Literal("hostLabel"), label: HostScopeLabel }),
  Schema.Struct({ _tag: Schema.Literal("entry"), entry: ScopeEntry }),
  /** Nothing matched. Out by default — see {@link scopeStateOf}. */
  Schema.Struct({ _tag: Schema.Literal("default") }),
]);
export type ScopeDecidedBy = typeof ScopeDecidedBy.Type;

/**
 * One subject's scope state, with what decided it and what that beat.
 *
 * Carries enough for every surface to explain itself without a second query. That is not
 * a convenience: a view that has to go back to the server to say *why* a row is excluded
 * is a view that will end up not saying it.
 */
export const ScopeState = Schema.Struct({
  state: ScopeLabelState,
  by: ScopeDecidedBy,
  /**
   * The entry a label overrode, when one did.
   *
   * Set only when a label decided *and* an entry had matched in the other direction. It
   * is what lets the view say "in scope, by hand, overriding out · labs.acme.com and
   * every subdomain" rather than merely "in scope by hand" — and it is how an operator
   * sees that a carve-out was made rather than that their typed list changed.
   *
   * Null when nothing was overridden, including when a label agrees with the entries and
   * when no entry matched at all. "Never covered" and "covered, then overridden" are
   * different facts.
   */
  overrode: Schema.NullOr(ScopeEntry),
});
export type ScopeState = typeof ScopeState.Type;

/** What the entries are matched against: one host, or one address. */
export interface ScopeSubject {
  /** Already reduced by {@link normaliseHost}. */
  readonly host: string;
}

/* ── Normalisation (D4.1) ────────────────────────────────────────────────────────── */

/**
 * Reduces a host, an address or a URL to the one form everything matches on.
 *
 * **One function for both the entry value and the subject**, which is the property that
 * makes a missed match impossible rather than unlikely. Lowercased, with a scheme and
 * path removed, a `:port` removed, a trailing dot removed, and the brackets an IPv6
 * literal carries removed.
 *
 * **The bracket rule is load-bearing and easy to miss.** An asset's `host` column is
 * filled by `assetIdentityOf` from `new URL(...).hostname`, which for
 * `http://[::1]:8080/x` yields `[::1]` — brackets included. An operator typing `::1`
 * would normalise to `::1` and the two would never meet. So the subject has already been
 * through a *different* normaliser before scope sees it, and sharing the bracket-stripping
 * step is what keeps the one-function property true in practice rather than only on paper.
 *
 * Returns the empty string for input that reduces to nothing, which callers treat as
 * "not a host" rather than as a wildcard. There is no input that normalises to something
 * matching everything.
 */
export const normaliseHost = (raw: string): string => {
  let text = hostOfAuthority(authorityOf(raw.trim().toLowerCase()));
  if (text === "") return "";

  /*
   * Brackets and the port, which have to be handled together.
   *
   * A bare IPv6 literal is full of colons, so "cut at the last colon" would turn `::1`
   * into `:` and `2001:db8::1` into `2001:db8:`. The three cases are therefore
   * distinguished rather than guessed at: a bracketed literal ends at its `]` and
   * anything after it is a port; an unbracketed string with two or more colons is a bare
   * IPv6 literal and has no port; and anything else has at most one colon, which is a
   * port if it is there.
   */
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    text = close === -1 ? text.slice(1) : text.slice(1, close);
  } else if (text.split(":").length <= 2) {
    const colon = text.indexOf(":");
    if (colon !== -1) text = text.slice(0, colon);
  }

  // A trailing dot is the root label, written explicitly. `acme.com.` is `acme.com`.
  return text.replace(/\.+$/, "");
};

/**
 * A scheme at the very start of the text, `https://` and its like. Only at the start: a
 * `://` later on is in a path or a query — `acme.com/?next=https://evil.com` — and reading
 * the host from after it would name evil.com. A backslash counts as a slash, as
 * `new URL()` counts one for the web's schemes.
 */
const SCHEME = /^[a-z][a-z0-9+.-]*:[/\\]{2}/iu;

/**
 * The authority of a host, an address or a URL: the text without a scheme, path, query or
 * fragment, **with any userinfo still in it** ({@link hostOfAuthority} drops that).
 *
 * **The authority ends at the first `/`, `?`, `#` or `\\` — before an `@` is looked for**,
 * as `new URL()` reads it. A review found the reverse order storing a pasted URL as a
 * different host: cut at the last `@` first, `https://acme.com/x@evil.com` was evil.com, and
 * so were `https://acme.com?next=a@evil.com` and `https://acme.com#@evil.com`;
 * `https://app.acme.com/login?u=me@victim.org` was victim.org. An `@` in a path, query or
 * fragment is a character there and says nothing about the host.
 *
 * Case-blind: every separator it cuts at is ASCII, and lowercasing never turns another
 * character into one, so it cuts the same text before lowercasing as after. That is what
 * lets {@link normaliseScopeEntry} test the kept part as the operator typed it.
 */
const authorityOf = (raw: string): string => {
  let text = raw;
  const scheme = SCHEME.exec(text);
  if (scheme !== null) text = text.slice(scheme[0].length);
  const end = text.search(/[/?#\\]/u);
  return end === -1 ? text : text.slice(0, end);
};

/**
 * An authority's host and port: what follows its last `@`, as `new URL()` reads userinfo.
 * `new URL().hostname` never carries userinfo, but an operator pasting a URL from a
 * browser bar can, and no host contains an `@`.
 */
const hostOfAuthority = (authority: string): string =>
  authority.slice(authority.lastIndexOf("@") + 1);

/** Why a value could not be reduced to something the matcher can use. */
export interface ScopeValueRefusal {
  readonly _tag: "refused";
  readonly detail: string;
}

/** Whether a normalisation refused. */
export const isScopeValueRefusal = (
  value: string | ScopeValueRefusal,
): value is ScopeValueRefusal => typeof value !== "string";

/* ── Addresses and prefixes, by hand ─────────────────────────────────────────────── */

/** One parsed address: its family, and its bytes. Four for v4, sixteen for v6. */
interface Address {
  readonly family: 4 | 6;
  readonly bytes: readonly number[];
}

/**
 * One IPv4 address, or `undefined`.
 *
 * Strict on purpose. Exactly four parts, each one to three digits, each at most 255, and
 * **no leading zeros on a multi-digit part**: `010.0.0.1` is read as octal by some
 * resolvers and as decimal by others, so a value that means two things is refused rather
 * than silently assigned one of them. Nothing shortens either — `10.1` is not `10.0.0.1`
 * here, because an operator who typed it did not say which.
 */
const parseIpv4 = (text: string): Address | undefined => {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    if (part.length > 1 && part.startsWith("0")) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    bytes.push(value);
  }
  return { family: 4, bytes };
};

/**
 * One IPv6 address, or `undefined`.
 *
 * Handles the one `::` run of zeroes and a trailing embedded IPv4 (`::ffff:203.0.113.9`),
 * which are the two forms a real address arrives in. Two `::` runs are ambiguous and are
 * refused.
 */
const parseIpv6 = (text: string): Address | undefined => {
  if (text === "") return undefined;
  const runs = text.split("::");
  if (runs.length > 2) return undefined;

  const expand = (half: string): number[] | undefined => {
    if (half === "") return [];
    const bytes: number[] = [];
    const groups = half.split(":");
    for (const [index, group] of groups.entries()) {
      // A trailing dotted quad occupies the last four bytes.
      if (group.includes(".")) {
        if (index !== groups.length - 1) return undefined;
        const embedded = parseIpv4(group);
        if (embedded === undefined) return undefined;
        bytes.push(...embedded.bytes);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
      const value = Number.parseInt(group, 16);
      bytes.push((value >> 8) & 0xff, value & 0xff);
    }
    return bytes;
  };

  const head = expand(runs[0] ?? "");
  if (head === undefined) return undefined;

  if (runs.length === 1) {
    return head.length === 16 ? { family: 6, bytes: head } : undefined;
  }

  const tail = expand(runs[1] ?? "");
  if (tail === undefined) return undefined;
  const missing = 16 - head.length - tail.length;
  // `::` must stand for at least one group of zeroes, or it was written for nothing.
  if (missing < 1) return undefined;
  return {
    family: 6,
    bytes: [...head, ...Array.from({ length: missing }, () => 0), ...tail],
  };
};

/**
 * One address of either family, or `undefined` for a name.
 *
 * This is the function that decides whether a subject gets label arithmetic at all. D4.3:
 * an IP never gets it, and a name never matches a CIDR entry, which makes the class of
 * bug where `10.0.0.18` is treated as a subdomain of `0.18` structurally impossible.
 */
const parseIpAddress = (text: string): Address | undefined =>
  text.includes(":") ? parseIpv6(text) : parseIpv4(text);

/** Whether a normalised host is an address rather than a name. */
export const isIpAddress = (host: string): boolean =>
  parseIpAddress(host) !== undefined;

/** One parsed prefix: the network address, and how many bits of it are fixed. */
interface Prefix extends Address {
  readonly bits: number;
}

/** One CIDR block, or `undefined`. The prefix must suit the family. */
const parseCidr = (text: string): Prefix | undefined => {
  const slash = text.indexOf("/");
  if (slash === -1) return undefined;
  const address = parseIpAddress(text.slice(0, slash));
  if (address === undefined) return undefined;
  const suffix = text.slice(slash + 1);
  if (!/^\d{1,3}$/.test(suffix)) return undefined;
  if (suffix.length > 1 && suffix.startsWith("0")) return undefined;
  const bits = Number(suffix);
  if (bits > address.bytes.length * 8) return undefined;
  return { ...address, bits };
};

/**
 * Whether one address falls inside one prefix.
 *
 * Byte by byte, then bit by bit for the partial byte. Written over bytes rather than over
 * a 32-bit integer because the same code then serves both families, and because shifting
 * a 32-bit mask in JavaScript runs into sign extension at `/0` and `/1` — a bug that
 * presents as "the whole internet is in scope", which is not a bug to leave to a test.
 *
 * A mismatched family is never inside: an IPv4 subject is not in an IPv6 block, and the
 * IPv4-mapped form of an address is a different string that normalises to itself.
 */
const withinPrefix = (subject: Address, prefix: Prefix): boolean => {
  if (subject.family !== prefix.family) return false;
  const whole = Math.floor(prefix.bits / 8);
  for (let index = 0; index < whole; index += 1) {
    if (subject.bytes[index] !== prefix.bytes[index]) return false;
  }
  const remaining = prefix.bits % 8;
  if (remaining === 0) return true;
  const mask = 0xff << (8 - remaining);
  return (
    ((subject.bytes[whole] ?? 0) & mask) === ((prefix.bytes[whole] ?? 0) & mask)
  );
};

/* ── Entry normalisation, on write ───────────────────────────────────────────────── */

/**
 * The characters a scope entry is refused with their own sentence for, because they are not
 * drawn: bidi controls (U+061C, U+200E/U+200F, U+202A–U+202E, U+2066–U+2069), zero-width ones
 * (U+200B–U+200D, U+2060, U+FEFF) and the tag characters (U+E0000–U+E007F). "Invisible" is
 * the thing to know about them.
 *
 * **A subset of what the web app marks in code, on purpose.** The web's `HIDDEN`
 * (`apps/web/src/lib/markdown.ts`) has grown past this list — the soft hyphen, the Hangul
 * fillers, the invisible operators, the variation selectors and more — because a marker
 * there is the only defence. Here it is not: every one of those is refused anyway by
 * {@link NOT_ASCII}, just with the general sentence. So this list only chooses the wording,
 * and the two need not be kept in step; what must hold is that nothing outside printable
 * ASCII reaches a stored host, and {@link NOT_ASCII} is what holds it.
 */
const INVISIBLE =
  /[\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/u;

/**
 * Anything in an entry's value that is not printable ASCII: a space, a control, and every
 * character past U+007E. **An allowlist, not a list of the bad ones.** A review found nine
 * characters a denylist of invisible ones let through — the soft hyphen U+00AD, U+2061,
 * U+180E, the grapheme joiner U+034F, variation selectors U+FE0F and U+E0100, the Hangul
 * filler U+3164, a space and a no-break space — each drawn as nothing or as a blank, so
 * `acme\u00AD.com` was listed as `acme.com` and matched as a host nobody called that. Unicode
 * has more of them than any list will hold, so a host is written in ASCII, and a name in
 * another script is typed as its punycode (`xn--…`), which is what DNS and
 * `new URL().hostname` carry anyway. The value is tested after only ASCII blanks at either
 * end are dropped — the whole of a CIDR's, and of a host or subtree entry the part that is
 * kept: its {@link authorityOf}, before it is lowercased. A pasted URL's path, query and
 * fragment are dropped from such an entry, so `https://acme.com/über` is stored as
 * `acme.com`, as `https://acme.com/x` is, and is not told to type its path as punycode.
 * (Userinfo is refused before this, so none is left in the part tested.)
 */
const NOT_ASCII = /[^\x21-\x7E]/u;

/**
 * What a normalised host may be made of: lowercase ASCII letters and digits, `-`, `.`, `_`,
 * and `:` for an IPv6 literal (its brackets and any port are gone by now). `*` is let past
 * here only so a wildcard gets its own refusal below. Anything else — `acme.com,evil.com`,
 * `acme%2ecom` — names no host the matcher will ever see.
 */
const HOST_CHARACTER = /[a-z0-9._:*-]/u;

/** A character as its code point, `U+00AD` or the five-digit `U+E0041`. */
const codePoint = (char: string): string =>
  `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * The stored form of one authored entry value, or an instructive refusal.
 *
 * Run on write, so the stored form is the matched form and no read has to normalise
 * anything. The refusals name the remedy rather than the rule, in the register the
 * store's own refusals use.
 *
 * A `cidr` value keeps its `/bits` and is therefore **not** put through
 * {@link normaliseHost} — that function removes a path, and a prefix length sits exactly
 * where a path would.
 */
export const normaliseScopeEntry = (input: {
  readonly kind: ScopeKind;
  readonly value: string;
}): string | ScopeValueRefusal => {
  /*
   * A character that is not drawn, refused before anything else — and tested on the value
   * as given, since `trim()` would quietly drop a U+FEFF at either end.
   *
   * A bidi control reorders the letters around it on screen and not in the text, so
   * `moc.emca` behind a right-to-left override is listed as `acme.com` and matches nothing
   * called that; a zero-width or tag character puts a letter into a host that nobody can
   * see. Either way the entry would read as one host and match as another, and the
   * importer proposes entries from attacker-written program pages. No hostname, address or
   * block contains one, so nothing real is refused. The sentence names the character by its
   * code point and does not echo the value: echoed, it would reorder the sentence too.
   *
   * This and the ASCII check after it are one rule — only printable ASCII — said in two
   * sentences. The cost of the rule is that an internationalised name must be typed as
   * punycode; the refusal says so.
   */
  const invisible = INVISIBLE.exec(input.value)?.[0];
  if (invisible !== undefined) {
    return {
      _tag: "refused",
      detail: `this entry contains an invisible character (${codePoint(invisible)}) that changes how it reads, so it would be listed as one host and matched as another; type the value again without it`,
    };
  }
  /*
   * Then everything else that is not printable ASCII, on the value with only ASCII blanks
   * dropped from its ends (`trim()` would also drop a no-break space there, and the point is
   * to name it) — of a host or subtree entry, only the part it keeps ({@link NOT_ASCII}).
   * Named by code point and not echoed, for the reason above.
   */
  const blankless = input.value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/gu, "");
  /*
   * A user named before the host — `user@acme.com`, `https://user:pass@acme.com/` — is
   * refused rather than dropped. It is not part of what the entry covers, and a value that
   * carries one is likelier a URL copied with credentials, or one built to read as one host
   * and be another, than a host the operator meant; and dropping it quietly is how the
   * reverse order stored `https://acme.com/x@evil.com` as evil.com. Only the authority is
   * looked at: an `@` in a path or a query is not userinfo, and that path is dropped anyway.
   */
  if (input.kind !== "cidr" && authorityOf(blankless).includes("@")) {
    return {
      _tag: "refused",
      detail:
        "this entry names a user before the host (the part before '@'); type the host on its own",
    };
  }
  const foreign = NOT_ASCII.exec(
    input.kind === "cidr" ? blankless : authorityOf(blankless),
  )?.[0];
  if (foreign !== undefined) {
    return {
      _tag: "refused",
      detail:
        foreign <= "\u007F"
          ? `this entry contains ${foreign === " " ? "a space" : "a control character"} (${codePoint(foreign)}), which no host has; type the value again without it`
          : `this entry contains ${codePoint(foreign)}, which is not ASCII; a host is written in ASCII only, so it would be listed as one host and matched as another — type a name in another script as its punycode (xn--…) instead`,
    };
  }
  const raw = input.value.trim();
  if (raw === "") {
    return { _tag: "refused", detail: "an entry needs a value" };
  }

  /*
   * A block typed into a host or subtree field, caught **before** normalisation.
   *
   * This has to come first, because `normaliseHost` removes a path and a prefix length
   * sits exactly where a path would: `203.0.113.0/24` would reduce to `203.0.113.0` and
   * be stored as a single address. That is not a refusal the operator would ever see — it
   * is their block silently narrowed to one host of it, which is the quiet coverage
   * change this design exists to prevent. Checked on the raw value, where the `/bits` is
   * still there to be noticed.
   */
  if (input.kind !== "cidr" && parseCidr(raw.toLowerCase()) !== undefined) {
    return {
      _tag: "refused",
      detail: `'${raw}' is an address block; add it as a CIDR entry instead, or this would have been stored as the single address ${raw.slice(0, raw.indexOf("/"))}`,
    };
  }

  if (input.kind === "cidr") {
    const prefix = parseCidr(raw.toLowerCase());
    if (prefix === undefined) {
      return {
        _tag: "refused",
        detail: `'${raw}' is not an address block; write one like 203.0.113.0/24 or 2001:db8::/32`,
      };
    }
    // Re-rendered from the parse rather than echoed, so one block has one spelling: the
    // unique index is on this text, and `203.0.113.0/24` and `203.0.113.00/24` must not
    // become two rows the matcher then evaluates twice.
    return `${renderAddress(prefix)}/${String(prefix.bits)}`;
  }

  const host = normaliseHost(raw);
  if (host === "") {
    return {
      _tag: "refused",
      detail: `'${raw}' does not name a host`,
    };
  }
  const stray = [...host].find((char) => !HOST_CHARACTER.test(char));
  if (stray !== undefined) {
    return {
      _tag: "refused",
      detail: `'${raw}' contains '${stray}' (${codePoint(stray)}), which is not a character a host is written with; a host is ASCII letters, digits, '-', '.' and '_', and ':' in an IPv6 address`,
    };
  }
  const address = parseIpAddress(host);
  if (address !== undefined) {
    // An address is stored in its canonical spelling for the reason a CIDR is: one thing,
    // one row. `2001:db8::0001` and `2001:db8::1` are the same address.
    return renderAddress(address);
  }

  if (!host.includes(".")) {
    return {
      _tag: "refused",
      detail: `'${raw}' is a single label with no dot; an entry names a host or an apex like acme.com`,
    };
  }
  if (host.includes("*")) {
    return {
      _tag: "refused",
      detail: `'${raw}' contains a wildcard; a subtree entry already covers every subdomain, so write the apex alone`,
    };
  }
  return host;
};

/** One address back as text, in its canonical spelling. */
const renderAddress = (address: Address): string => {
  if (address.family === 4) return address.bytes.join(".");
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push(
      (
        ((address.bytes[index] ?? 0) << 8) |
        (address.bytes[index + 1] ?? 0)
      ).toString(16),
    );
  }
  /*
   * The longest run of zero groups is compressed, which is the canonical form RFC 5952
   * asks for and, more usefully here, the form that makes one address one string. A run
   * of one is left alone, because `::` standing for a single group is the shorter text
   * and the ambiguous one.
   */
  let bestStart = -1;
  let bestLength = 0;
  let start = -1;
  for (let index = 0; index <= groups.length; index += 1) {
    if (index < groups.length && groups[index] === "0") {
      if (start === -1) start = index;
      continue;
    }
    if (start !== -1) {
      const length = index - start;
      if (length > bestLength) {
        bestStart = start;
        bestLength = length;
      }
      start = -1;
    }
  }
  if (bestLength < 2) return groups.join(":");
  return `${groups.slice(0, bestStart).join(":")}::${groups
    .slice(bestStart + bestLength)
    .join(":")}`;
};

/* ── Matching ────────────────────────────────────────────────────────────────────── */

/** Whether one entry covers one subject. */
const entryCovers = (entry: ScopeEntry, subject: ScopeSubject): boolean => {
  const host = subject.host;
  if (host === "") return false;
  const address = parseIpAddress(host);

  if (entry.kind === "cidr") {
    // A name never matches a CIDR entry (D4.3).
    if (address === undefined) return false;
    const prefix = parseCidr(entry.value);
    return prefix === undefined ? false : withinPrefix(address, prefix);
  }

  const entryAddress = parseIpAddress(entry.value);
  if (entryAddress !== undefined) {
    /*
     * An entry whose value is an address matches only an exact address, whatever its
     * kind. A `subtree` entry on `203.0.113.44` does not mean "and everything under it":
     * there is nothing under an address, and label arithmetic on one is how `10.0.0.18`
     * comes to look like a subdomain of `0.18`.
     */
    return address !== undefined && entry.value === host;
  }

  // A name entry never matches an address subject. Exact equality would already fail, and
  // so would the suffix test; this says so rather than relying on both.
  if (address !== undefined) return false;

  if (entry.kind === "host") return host === entry.value;

  /*
   * A subtree matches on the **label boundary**, never a bare suffix.
   *
   * `notexample.com` is outside `example.com`. ScopeWeaver's `fuzzy_domain` is
   * `strings.Contains`, and used as an allow rule that is how a host nobody authorized
   * comes to be treated as part of the client's estate.
   */
  return host === entry.value || host.endsWith(`.${entry.value}`);
};

/** How specific one entry is, for choosing which gets named. Higher is more specific. */
const kindRank = (kind: ScopeKind): number =>
  kind === "host" ? 3 : kind === "subtree" ? 2 : 1;

/**
 * Which of several matching entries gets named in the explanation.
 *
 * The most specific, by kind and then by longer value. **This affects the sentence shown
 * and nothing else**, which is what makes it safe to be a heuristic: the verdict is
 * decided by `out`-wins and default-out, both of which are insensitive to ordering, so a
 * different choice here changes which true sentence is displayed and never whether the
 * subject is in scope.
 */
const mostSpecific = (
  entries: readonly ScopeEntry[],
): ScopeEntry | undefined => {
  let best: ScopeEntry | undefined;
  for (const entry of entries) {
    if (best === undefined) {
      best = entry;
      continue;
    }
    const rank = kindRank(entry.kind) - kindRank(best.kind);
    if (rank > 0 || (rank === 0 && entry.value.length > best.value.length)) {
      best = entry;
    }
  }
  return best;
};

/**
 * Whether a subject is in the client's estate, and what decided it.
 *
 * ## The ladder, highest first: asset label, host label, entries
 *
 * A hand label sits **above** the entry layer and wins in either direction. Both are
 * explicit acts by the same person, and the operator's later decision about one host is
 * allowed to beat what they typed earlier — that is what makes `legacy.acme.com`
 * excludable while `acme.com` stays in, and a single host promotable out from under an
 * exclusion typed last week. The view names which one applied, and
 * {@link ScopeState.overrode} carries the entry that was beaten.
 *
 * ## Within the entry layer there is no precedence
 *
 * `out` wins unconditionally — no ordering, no specificity override — and the default is
 * `out`. Those two rules are what make a verdict on the typed lists explainable: the only
 * thing specificity decides is which matching entry gets *named*.
 *
 * ## Why default-out is safe here when it would not be in a gate
 *
 * In ars0n, default-deny is an authorization decision. Here it is a label, and the
 * difference matters: a subject nothing covers is shown as "covered by nothing", kept, and
 * offered to the operator for promotion. It is not hidden and it is not blocked. The same
 * rule is deliberately **not** spoken aloud to an agent — a target with nothing in scope
 * gets no prompt block at all, because "In scope: (nothing)" would read as "you may touch
 * nothing".
 */
export const scopeStateOf = (input: {
  readonly entries: readonly ScopeEntry[];
  readonly hostLabel?: HostScopeLabel | undefined;
  readonly assetLabel?: AssetScopeLabel | undefined;
  readonly subject: ScopeSubject;
}): ScopeState => {
  const matched = input.entries.filter((entry) =>
    entryCovers(entry, input.subject),
  );
  const excluded = matched.filter((entry) => entry.effect === "out");
  const included = matched.filter((entry) => entry.effect === "in");

  // The entry layer's own verdict, computed first whether or not a label will beat it:
  // it is what `overrode` reports, and a label that agrees with the entries is a
  // different fact from one that overturns them.
  const entryState: ScopeLabelState = excluded.length > 0 ? "out" : "in";
  const named =
    excluded.length > 0 ? mostSpecific(excluded) : mostSpecific(included);

  const label = input.assetLabel ?? input.hostLabel;
  if (label !== undefined) {
    const by: ScopeDecidedBy =
      input.assetLabel !== undefined
        ? { _tag: "assetLabel", label: input.assetLabel }
        : // Reachable only when `assetLabel` is absent, so this is the host's.
          { _tag: "hostLabel", label: input.hostLabel as HostScopeLabel };
    return {
      state: label.state,
      by,
      // Only when an entry actually matched *and* said the opposite. A label over a
      // subject no entry covers has overridden nothing, and saying otherwise would
      // invent an exclusion the operator never typed.
      overrode:
        named !== undefined && label.state !== entryState ? named : null,
    };
  }

  if (named === undefined) {
    return { state: "out", by: { _tag: "default" }, overrode: null };
  }
  return {
    state: entryState,
    by: { _tag: "entry", entry: named },
    overrode: null,
  };
};

/* ── The one renderer ────────────────────────────────────────────────────────────── */

/**
 * What one entry covers, spelled out.
 *
 * **One renderer, and every surface uses it.** The Scope tab's rows, the prompt block the
 * agent receives, and the preview panel that claims to show the operator what the agent
 * will read all come through here. ars0n keeps one `RenderScopeRule` for exactly this
 * reason: an entry shown as bare text in one place and as a sentence in another is how an
 * operator comes to believe `example.com` means one host.
 *
 * The sentence is the interface. It says what the entry reaches, in words, so no reader
 * has to know what `subtree` means.
 */
export const describeScopeEntry = (entry: {
  readonly kind: ScopeKind;
  readonly value: string;
}): string => {
  switch (entry.kind) {
    case "subtree":
      return `${entry.value} and every subdomain`;
    case "host":
      return `${entry.value} (that host only)`;
    case "cidr":
      return `${entry.value} (every address in the block)`;
  }
};

/**
 * What a label covers, spelled out, in the same register as {@link describeScopeEntry}.
 *
 * A host label reaches every asset on that host "now and later", and saying so is what
 * makes an exclusion mean what the operator meant by it. An asset label reaches one row.
 */
export const describeScopeLabel = (
  by: Extract<ScopeDecidedBy, { _tag: "assetLabel" | "hostLabel" }>,
): string =>
  by._tag === "hostLabel"
    ? `${by.label.host} (set by hand: ${HOST_LABEL_REACH})`
    : "this asset alone (set by hand)";

/**
 * What a host label reaches, as one clause.
 *
 * Exported because three surfaces have to state it and they must state it identically:
 * {@link describeScopeLabel}'s sentence, the Scope tab's list of hand labels, and the
 * Estate tab's promote and exclude controls — which are the place it matters most,
 * because "and later" is the part an operator cannot infer from a button reading
 * *Exclude host*. D8 and the view design both require every option to say what it
 * reaches, and three copies of this clause is three chances for one of them to drift
 * into promising less than the click does.
 */
export const HOST_LABEL_REACH = "every asset on that host, now and later";

/** What an asset label reaches: the one row, and nothing else on its host. */
export const ASSET_LABEL_REACH = "that one asset";

/**
 * One subject's verdict as a sentence, naming what decided it.
 *
 * The three `out` cases are three different sentences and that is the point: "excluded on
 * purpose", "excluded by hand" and "covered by nothing" lead an operator to three
 * different next actions, and an agent reading the third as the first would stop recording
 * the discoveries that matter most.
 *
 * Used by `record_asset`'s result — so a worker is told on the write, not never — and by
 * the estate view's per-row explanation. One sentence, so the tool and the screen cannot
 * describe the same row differently.
 */
export const describeScopeState = (state: ScopeState): string => {
  const overridden =
    state.overrode === null
      ? ""
      : `, overriding ${describeScopeEntry(state.overrode)}`;
  switch (state.by._tag) {
    case "entry":
      return state.state === "in"
        ? `in scope: ${describeScopeEntry(state.by.entry)}`
        : `explicitly out of scope: ${describeScopeEntry(state.by.entry)}`;
    case "hostLabel":
      return state.state === "in"
        ? `in scope, set by hand on ${state.by.label.host}${overridden}`
        : `excluded by hand on ${state.by.label.host}${overridden}`;
    case "assetLabel":
      return state.state === "in"
        ? `in scope, set by hand on this asset alone${overridden}`
        : `excluded by hand on this asset alone${overridden}`;
    case "default":
      // Not "denied", and the wording is load-bearing for an agent reading it on a write:
      // the asset was recorded, and nothing covering it yet is a fact about the scope
      // rather than about the discovery.
      return "not covered by any in-scope entry; recorded for the operator to review";
  }
};

/* ── What the browser sends and reads ────────────────────────────────────────────── */

/**
 * What the Scope tab submits to add an entry.
 *
 * **No id and no source.** The server mints the entry id, and `source` is `operator` by
 * construction on this route — a browser that could name its own source could write
 * `imported` on a row a person typed, which would mean the operator's review of the
 * imported list was reviewing the wrong rows. The importer writes `imported` from its own
 * endpoint and nowhere else.
 *
 * `value` is sent as typed, not normalised. Normalising in the browser would be a second
 * implementation of the rule, and the refusals are worth more than the round trip saves:
 * the server's sentence names the remedy.
 */
export const ScopeEntryDraft = Schema.Struct({
  effect: ScopeEffect,
  kind: ScopeKind,
  /** As the operator typed it. The server normalises it and may refuse it. */
  value: Schema.String,
});
export type ScopeEntryDraft = typeof ScopeEntryDraft.Type;

/**
 * Which subject a label is about.
 *
 * The two layers of the ladder, as a tagged union rather than two nullable fields, so a
 * payload naming both or neither cannot be constructed.
 */
export const ScopeLabelSubject = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("host"), host: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("asset"), assetId: Schema.String }),
]);
export type ScopeLabelSubject = typeof ScopeLabelSubject.Type;

/**
 * What the promote/exclude control submits.
 *
 * One draft for all three actions, because they are one control with directions rather
 * than three mechanisms: promote is `in`, exclude is `out`, and withdrawing is `cleared`.
 * An earlier design had promotion writing a scope entry and exclusion writing a label,
 * which made two buttons different mechanisms wearing one shape.
 *
 * **`cleared` is an action, not a stored state.** Nothing in either label table ever
 * holds it: the row is deleted, and the subject goes back to being decided by the
 * entries. It is spelled here because "withdraw my label" is a thing the operator does,
 * and a route that expressed it as an absence would be a route that could not tell it
 * from "I sent you a malformed payload".
 */
export const ScopeLabelDraft = Schema.Struct({
  subject: ScopeLabelSubject,
  state: Schema.Literals(["in", "out", "cleared"]),
  /** Why, in the operator's words. Absent and empty both mean none. */
  reason: Schema.optional(Schema.Trim),
});
export type ScopeLabelDraft = typeof ScopeLabelDraft.Type;

/** One entry as the Scope tab reads it. */
export const ScopeEntryView = Schema.Struct({
  entryId: Schema.String,
  effect: ScopeEffect,
  kind: ScopeKind,
  value: Schema.String,
  source: ScopeEntrySource,
  note: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
});
export type ScopeEntryView = typeof ScopeEntryView.Type;

/** One host label as the Scope tab reads it. */
export const HostScopeLabelView = Schema.Struct({
  host: Schema.String,
  state: ScopeLabelState,
  reason: Schema.NullOr(Schema.String),
  setBy: Schema.String,
  setAt: Schema.Number,
});
export type HostScopeLabelView = typeof HostScopeLabelView.Type;

/** One asset label as the Scope tab reads it, named by the asset it sits on. */
export const AssetScopeLabelView = Schema.Struct({
  assetId: Schema.String,
  /** The asset's canonical identity, so the row says what it is about. */
  identity: Schema.String,
  state: ScopeLabelState,
  reason: Schema.NullOr(Schema.String),
  setBy: Schema.String,
  setAt: Schema.Number,
});
export type AssetScopeLabelView = typeof AssetScopeLabelView.Type;

/**
 * One target's whole scope, as the Scope tab reads it.
 *
 * `promptBlock` is the thing that makes this view worth having. It is **the bytes an
 * agent would be given right now**, rendered server-side by the same function both prompt
 * paths use — not a reconstruction the browser assembled from the lists above it. A4 is
 * explicit that the preview panel is not decoration: it is the only place an operator can
 * check what their list actually says before an agent acts on it, and a preview built by
 * a second renderer would be exactly the drift the one-renderer rule exists to stop.
 *
 * Null when nothing is in scope, which is the state A4's empty screen describes: the hunt
 * still runs and still records everything, it just arrives labelled "not covered", and
 * the agent is told nothing about the estate.
 */
export const ScopeView = Schema.Struct({
  entries: Schema.Array(ScopeEntryView),
  hostLabels: Schema.Array(HostScopeLabelView),
  assetLabels: Schema.Array(AssetScopeLabelView),
  promptBlock: Schema.NullOr(Schema.String),
});
export type ScopeView = typeof ScopeView.Type;
