# Target scope — design

Written 2026-10-31. Architecture source is `DECISIONS.md`; where this document and
that one disagree about the eventual perimeter, that one wins — but see **Non-goals**,
because this work deliberately stops short of what `DECISIONS.md` §5 describes.

Reviewed once by a fresh engineer against the code it names. Eight gaps came back; the
decisions below carry the answers, and **Calls made for you** at the end lists which
were settled without the operator.

## Intent, and why now

A target today carries one free-text field. `fleet.ts` stores it as `scope_note`,
`NewTarget.svelte:133` renders it as a `Scope` input with the placeholder
`*.example.test`, and **nothing reads it.** It is a note one human wrote for another.

Two things follow from that, and both are the reason for this work.

The agent is never told what it is authorized to test. It receives an intent question
(`supervisor.ts:1686`) or a goal briefing (`roundPrompt.ts`), and neither mentions the
client's estate at all. Any boundary it respects is a boundary it inferred from the
objective's prose.

And the operator cannot watch the client's estate accumulate. The agent cannot even
record an asset: `assets` and `asset_discoveries` exist from migration `0010` and
`store.recordAsset` works, but nothing exposes it over MCP and only spike scripts have
ever written a row. Nor can anything read assets back — there is no asset read on any
MCP endpoint, and `http/browserApi.ts` exposes only `counts.assets`.

This design gives a target a **structured scope** that does exactly two jobs:

1. It tells the agent, in its prompt, what it is authorized to test.
2. It is the frame the discovered estate is displayed in — every artefact the agent
   finds lands under the scope entry that covers it, or is labelled as covered by none.

## Goals

- An operator authors in-scope and out-of-scope entries on a target, or has them
  imported from the program's own page and then reads them (D13). One list per target,
  shared by every goal ever run against it.
- Every discovered asset carries a scope state, either derived from the entries or set
  by hand.
- The agent is told the scope as part of its prompt, on the paths that act on the
  target, and can query it on demand where a prompt cannot carry it.
- A discovery no in-scope entry covers is **recorded, kept, displayed and labelled** —
  never hidden, never dropped, never refused.
- An operator promotes such a discovery by hand. Promotion brings in **that host
  alone.**

## Non-goals

These are not oversights. Each is a thing a reader will expect and not find.

- **No enforcement.** `PERMISSIVE_POLICY` in `policy/service.ts` stays permissive, and
  `HostScope` is **not** derived from these entries in this work. The comment at
  `policy/service.ts:154` anticipates that derivation; it stays anticipated. The
  operator asked for a starting point that tells the agent what it may test, explicitly
  **not** a gate that stops it testing anything else.

  One wording change is required even so. `PERMISSIVE_POLICY.because` currently asserts
  that "this installation has no structured engagement scope to derive a host allowlist
  from". That becomes false under this work while the derivation stays unbuilt, so the
  string is reworded to say the scope exists and is deliberately not enforced. The
  policy itself is untouched.

- **No gate on recording.** ScopeWeaver refuses to insert an out-of-scope asset
  (`agent/tools_insert.go:245`, "insertion prohibited"). That is deliberately not
  ported: an out-of-scope discovery must be recordable, because recording it is how the
  operator comes to know about it.
- **No candidate-promotion ceiling.** `DECISIONS.md` §5 says out-of-perimeter
  discoveries "never become testable without an operator promoting them". That is a
  denial and belongs to the Day 22 perimeter. Here, promotion changes a **label**, not
  an authorization.
- **No coverage percentage and no graph layout.** ScopeWeaver's `TaskCoverage` and its
  force-directed coverage graph are a separate feature built on top of this one. The
  **data** that feature needs is included here, in D12, because it cannot be
  reconstructed after the fact; the feature itself is not.

  A graph view **has** been designed — a banded containment layout, scope entry to host
  to endpoint, not a force-directed one, so it needs no graph library — and the operator
  deferred it on 2026-11-01. Slice 8 is the two-tab list (Estate and Scope) from that
  same design and nothing more. The graph's own open questions, listed under **Deferred**
  below, are not answered here and should not be guessed at by an implementer.

- **No per-goal narrowing.** Scope is the client's, held once per target.
- **No ports on entries.** `203.0.113.44` in scope means every port on it.

## Anti-goals

Ways this fails even if every goal above is met:

- **An entry silently covering more than its text says.** A chip reading `example.com`
  that means "and every subdomain" without saying so is the misread this whole model
  exists to prevent. ars0n keeps one renderer (`RenderScopeRule`) as the single source
  of the sentence every surface shows, for exactly this reason.
- **An agent widening the scope it is being judged against.** ScopeWeaver's
  `add_task_scope` lets a testing agent widen its own scope with no ceiling, and
  `DECISIONS.md` §5 names that as the defect. No agent that tests may write an entry or
  a label, and nothing may narrow or delete an out-entry automatically.

  The scope importer (D13) is not an exception to this, and the difference is
  structural rather than a matter of intent: it is a different role on a different MCP
  endpoint, it runs before any goal exists, it cannot test anything, and the operator
  reads what it wrote before the first goal is created. A worker or planner that could
  reach its tools would be the defect, which is why they live on one endpoint and
  nowhere else.

- **An operator's hand label erased by a recompute.** ScopeWeaver guards this with
  `assets.company_source ∈ explicit | scope`, migrating existing rows conservatively as
  `explicit` "so a scope rebuild can never erase a historical manual association".
- **Two code paths that can disagree** about whether a host is in scope.
- **An operator action that appears to work and does nothing.** A promote or exclude
  click must always change the asset's state, or be refused with a reason. D5's
  precedence ladder is what guarantees it: a label always outranks whatever would
  otherwise have decided.
- **An exclusion that does not reach what the operator meant by it.** Excluding a host
  must cover the endpoints found on it afterwards, not just the row that was on screen
  at the time (D5).

## Constraints

From `AGENTS.md`, and non-negotiable:

- Bun 1.4.3, committed `bun.lock`, `bun install --frozen-lockfile`.
- TypeScript strict and ESM. TypeScript pinned at 6.0.3. Effect v4 — verify APIs
  against installed types, v3 examples are unreliable. Effect Schema, never Zod.
- `packages/contracts` stays browser-safe: no server, Bun, Node or persistence imports.
- Persistence is `effect/sql` with `@effect/sql-sqlite-bun`. No ORM. Parameterised
  tagged-template SQL, rows decoded with `SqlSchema`, never a value interpolated into
  statement text.
- Migrations are appended to `MIGRATIONS` in `persistence/migrations.ts`, statically
  imported and ordered. Never edit an applied one. No `down`.
- `bun run test:persistence` must pass as well as `typecheck`: nothing checks SQL
  identifiers or placeholders at compile time. Then `build`, `lint`, `format:check`.
  Leave `sprint-roadmap.html` alone — it already fails `format:check`.
- Tablet widths upward. Do not spend effort on phone-width layout.
- **Do not copy code or data from the reference repositories.** ScopeWeaver is
  AGPL-3.0, ars0n-framework-v2 is GPL-3.0. Every rule below is restated and
  reimplemented, and that includes test fixtures: ars0n's `scope/vectors.json` is
  **not** copied or transcribed. Slice 2 writes its own vectors from the rules in D4
  and may cite ars0n in a comment as the source of the reasoning.

## Prior art, and what is taken from each

Both references are local: `/run/media/hbt/work/scopeweaver` and
`/run/media/hbt/work/artex/ars0n-framework-v2`.

**ScopeWeaver** treats scope as bookkeeping, not a boundary. Two Postgres tables:
`company_scope` (per client, drives asset→company attribution) and `task_scope` (per
task, `kind ∈ company|root_domain|subdomain|ip|cidr|icp|keyword`, plus `source ∈
auto|agent|manual` and a `reason`). Its single consumer is one SQL predicate
(`db/task_scope.go:303`) that becomes a coverage denominator. Enforcement is absent by
its own admission (`guard/guard.go:4`: the RoE authorization-scope mechanism was
removed; `preToolUse` extracts the shell command for the audit log only). What reaches
the agent is a **prompt block** built from `task_constraints` — free text, not the
scope table — in `agent/constraints.go`.

Taken: the `source`/`reason` provenance on every entry; the explicit-versus-derived
distinction on labels; the shape of the prompt block, including its closing sentence
that discovering something outside the scope does not grant authorization.

**ars0n-framework-v2** treats scope as the authorization decision. `scope_rules` keyed
to `scope_targets`, with `effect ∈ allow|deny|auth`, `kind ∈
host|subtree|subdomains|contains|regex`, a `blast ∈ narrow|bounded|wide`
classification, and a unique index on `(scope_target_id, canonical)` making canonical
text the rule's identity. Deny wins unconditionally, default is deny, and rule ranking
exists only to choose which rule gets _named_ in the explanation.

Taken: the three-way host/subtree/subdomains distinction; deny-wins-without-precedence;
label-boundary matching; one normaliser shared by subject and rule; never applying label
arithmetic to an IP; one renderer as the single source of the displayed sentence.

Not taken: `contains` and `regex` kinds, the `blast` classification, the `auth` effect,
and the JS mirror. All of them are machinery for an enforcement boundary with
operator-authored patterns. Our entries are literal hosts, apexes and CIDRs.

## Decisions

### D1 — Scope lives in the per-target hunt database

New migration in `persistence/migrations.ts`, not `controlMigrations.ts`.

Entries describe one target's client estate and are read on the same paths as that
target's assets. Keeping them in `targets/<id>/hunt.sqlite` means one store, one
connection and one read to answer "what is the scope here", and it keeps
`DECISIONS.md` §3's deletion property intact: removing a target is still
`rm -rf targets/<id>/`, with no scope rows orphaned in the registry.

An earlier draft justified this by saying the derivation needs a SQL join across the
two files. That reasoning is wrong — D3 puts the derivation in a pure TypeScript
function, so no join is involved. The conclusion stands on the reasons above.

`scope_note` stays in the registry, unchanged, as the target card's human description.
It stops being presented as something machine-readable. `NewTarget.svelte`'s `Scope`
field is relabelled accordingly.

### D2 — An entry is two axes

```
scope_entries
  id           TEXT PRIMARY KEY
  target_id    TEXT NOT NULL
  effect       TEXT NOT NULL   -- 'in' | 'out'
  kind         TEXT NOT NULL   -- 'subtree' | 'host' | 'cidr'
  value        TEXT NOT NULL   -- normalised; the apex, the host, or the CIDR
  source       TEXT NOT NULL   -- 'operator' | 'imported'
  note         TEXT            -- for an imported entry, where on the page it came from
  created_at   INTEGER NOT NULL
  UNIQUE (target_id, effect, kind, value)
```

**Two writers, and only two.** The operator typing in the Scope tab, and the scope
importer at target creation (D13). Nothing else: not a worker, not a planner, not the
goal agent, and not promotion, which writes a label instead (D5, D8).

`source` is what makes the operator's review possible. An imported entry and a typed
one are identical to the matcher and must be distinguishable on screen, because
"read this list before you start" is only a real step if the rows that need reading
are the ones a machine wrote.

Six combinations, and they cover everything the operator described:

| Entry                               | Means                                       |
| ----------------------------------- | ------------------------------------------- |
| `in` / `subtree` / `acme.com`       | the apex **and** every subdomain            |
| `in` / `host` / `app.acme.com`      | that host alone, nothing under it           |
| `in` / `cidr` / `203.0.113.0/24`    | every address in the block                  |
| `out` / `subtree` / `labs.acme.com` | that apex and everything under it, excluded |
| `out` / `host` / `blog.acme.com`    | that host alone, excluded                   |
| `out` / `cidr` / `203.0.113.64/26`  | every address in the block, excluded        |

A typed apex is `in`/`subtree`. `in`/`host` exists because programs often authorize
specific hosts and nothing under them, so the operator needs to be able to type one
directly; it is not how promotion works.

The unique constraint makes authoring idempotent: adding an entry that already exists
is a no-op rather than a duplicate row the matcher would evaluate twice.

**Direct contradictions are refused at the write boundary.** The constraint above is
per-effect, so it would otherwise permit `in`/`host`/`blog.acme.com` to sit alongside
`out`/`host`/`blog.acme.com`. The matcher handles that fine — out wins — but the screen
cannot show it coherently, and an operator who authored both did not mean to. Writing
an entry whose kind and value already exist under the opposite effect is rejected,
naming the existing entry, so the operator removes or edits it deliberately. This is a
write-path rule, not a normalisation failure, and it needs its own refusal.

### D3 — One derivation function, in contracts

A new `packages/contracts/src/scope.ts` holds the schemas and **one pure function**:

```
scopeStateOf(input: {
  readonly entries: readonly ScopeEntry[]
  readonly hostLabel?: HostScopeLabel      // the label on this subject's host, if any
  readonly assetLabel?: AssetScopeLabel    // the label on this asset, if any
  readonly subject: ScopeSubject
}): ScopeState
```

The two labels are passed **already looked up**, by host and by asset id, so the
function stays pure and cheap and the store owns the lookups.

`ScopeState` carries the verdict, what decided it, and — when a label overrode an entry
— the entry it beat, so every surface can explain itself without a second query:

```
{
  readonly state: "in" | "out"
  readonly by:
    | { _tag: "assetLabel"; label: AssetScopeLabel }
    | { _tag: "hostLabel";  label: HostScopeLabel }
    | { _tag: "entry";      entry: ScopeEntry }
    | { _tag: "default" }                       -- nothing matched; out by default
  /** The entry a label overrode, when one did. What lets the view say which. */
  readonly overrode?: ScopeEntry
}
```

`by` is a discriminated union rather than an optional entry because "excluded on
purpose", "excluded by hand" and "never covered" lead to three different sentences and
three different affordances in the view, and collapsing any two of them is how a screen
starts lying about why something is where it is.

The store calls it, the prompt renderer calls it, the Svelte view calls it. ars0n needs
`scope/vectors.json` run as a test on both sides because it has the same algorithm
hand-written twice, in Go and in JavaScript. One function in one language is the same
property, obtained structurally.

Browser-safe: Effect Schema and string operations only. CIDR matching is written by
hand — no `node:net`, nothing from Bun.

### D4 — Matching rules

Each of these is a bug one of the references already paid for.

1. **Normalise through one function, used for both the entry value and the subject.**
   Lowercase, strip a trailing dot, strip any `:port`, strip a scheme and path if
   present, and **strip the brackets an IPv6 literal carries**. An entry value is
   normalised **on write**, so the stored form is the matched form.

   The bracket rule is load-bearing and easy to miss. An asset's `host` column is
   filled by `assetIdentityOf` from `new URL(...).hostname`, which for
   `http://[::1]:8080/x` yields `[::1]` — brackets included. An operator typing `::1`
   would normalise to `::1` and never match. So the subject has already been through a
   _different_ normaliser before scope sees it, and sharing the bracket-stripping step
   with `assetIdentityOf` is what keeps D3's one-function property true in practice.

2. **Match on the label boundary, never a bare suffix.** `subtree` matches
   `host === apex || host.endsWith("." + apex)`. `notexample.com` is outside
   `example.com`. ScopeWeaver's `fuzzy_domain` is `strings.Contains` and
   `DECISIONS.md` §5 already records why that is dangerous as an allow rule.
3. **An IP never gets label arithmetic, and a name never matches a CIDR entry.** A
   `subtree` or `host` entry whose value is an address matches only an exact address
   subject. This makes the class of bug where `10.0.0.18` becomes `0.18` structurally
   impossible.
4. **`out` wins unconditionally.** No precedence, no ordering, no specificity override.
   If any `out` entry matches, the subject is out, whatever else matched. The only
   thing left to decide is _which_ entry gets named in the explanation.
5. **The default is `out`.** A subject no `in` entry covers is out.
6. **Which entry gets named,** when several of one effect match: the most specific, by
   kind (`host` before `subtree` before `cidr`) then by longer value. This affects the
   sentence shown and nothing else, which is what makes it safe to be a heuristic.

IPv4 and IPv6 are both supported, for addresses and for prefixes.

**Rules 4 and 5 are statements about the entry layer, not about the whole decision.**
Within the typed lists there is no precedence and no specificity override, which is what
makes a verdict on them explainable. A hand label sits _above_ that layer and wins in
either direction — see D5. Deny-wins is therefore the rule for what the operator typed,
and the operator's own later decision about one host is allowed to beat what they typed
earlier. Both are explicit acts by the same person, and the view names which one
applied.

### D5 — Hand labels are two layers above the entries, and they win

A label is an operator decision made from the scope view about one host or one asset.
There are two tables because an exclusion has to reach differently in each case.

```
host_scope_labels
  target_id  TEXT NOT NULL
  host       TEXT NOT NULL   -- normalised through D4.1, same as an entry value
  state      TEXT NOT NULL   -- 'in' | 'out'
  reason     TEXT
  set_by     TEXT NOT NULL   -- the operator authority from the mutation boundary
  set_at     INTEGER NOT NULL
  PRIMARY KEY (target_id, host)

asset_scope_labels
  asset_id   TEXT PRIMARY KEY REFERENCES assets(id)
  state      TEXT NOT NULL   -- 'in' | 'out'
  reason     TEXT
  set_by     TEXT NOT NULL
  set_at     INTEGER NOT NULL
```

**Precedence, highest first: asset label, host label, entries.**

A **host label covers every asset on that host, present and future.** That is the point
of it, and it closes a real hole an earlier draft had: with labels keyed only by asset,
excluding `legacy.acme.com` today would mark that one row, and
`legacy.acme.com/login` discovered tomorrow would be a different row with no label,
derive from the entries, and come back **in scope**. The operator's exclusion would
silently fail to cover the thing they meant by it. Keying on the host is what makes an
exclusion mean what it says.

An **asset label overrides its host's label** for that one row, so a single endpoint can
be excluded without excluding its host, or kept while its host is excluded. Specificity
inside the label layer is fine and expected: every row in both tables is an explicit act
by the operator, and the more specific act is the later, narrower decision.

Both tables hold **current state, not history.** Every set and clear writes to the
existing event log (migration `0012`), which is append-only and is where the history
lives. This follows the codebase's existing split rather than inventing two more
append-only tables.

A label may be set in either direction on anything, including a host that an entry
already covers in the other direction — the operator asked explicitly for
`legacy.acme.com` to be excludable while `acme.com` stays in, and for a host to be
promotable out from under an exclusion they typed earlier. `ScopeState.overrode` carries
the beaten entry so the view can say so.

This is ScopeWeaver's `company_source ∈ explicit | scope` distinction with one more
level, and it is what satisfies the anti-goal about recomputes: a recompute reads
entries, and entries cannot touch either label table.

An asset's effective state is: asset label if present, else its host's label if present,
else `scopeStateOf` over the entries. Expose this as **one** store read; no caller
should ever assemble it.

### D6 — The agent is told, from one renderer, on the paths that act on the target

Two paths prompt an agent to act on a target, and they differ today.

A planner round goes through `assembleRoundPrompt` (`plan/roundPrompt.ts:206`), which
builds a preamble and then appends the rendered briefing **verbatim** — deliberately,
so the briefing panel can claim it shows the same bytes the planner received. The
scope block therefore goes **in the preamble**, above the `THE RECORD FOLLOWS` line.
Nothing is inserted into the briefing.

A worker gets `claim.question` and nothing else (`run/supervisor.ts:1686`, sent at
`:1453`). The same block is prepended there.

One renderer produces the block for both, so the two prompts cannot drift about what
the scope is. Its shape, following `agent/constraints.go`'s framing:

```
[Authorized testing scope — highest priority]
In scope: acme.com and every subdomain; acmelabs.io and every subdomain;
  app.partner.com (that host only); 203.0.113.0/24
Explicitly OUT of scope: blog.acme.com; status.acme.com; api.acme-cdn.net

Discovering a host outside the in-scope list does not grant authorization.
Record it with record_asset and move on; do not derive intents for it.
```

Every entry is rendered with what it covers spelled out — "and every subdomain",
"that host only". This is the anti-goal about silent coverage, and it is the one place
it can be fixed for every surface at once.

Both lists are assembled from the entries **and** the host and asset labels, since from
the agent's side there is no difference between "excluded because you typed it" and
"excluded because you clicked it". A label that overrode an entry appears once, under
the effect the label gave it, and not at all under the other.

Three rules on the block itself:

- **Nothing in scope means no block.** If no `in` entry and no `in` label exist, the
  target gets the prompt it gets today, unchanged. Rendering "In scope: (nothing)"
  would tell every existing target's agent it may touch nothing, and migration `0022`
  creates these tables empty for every one of them — including the fixture targets in
  `run/supervisor.test.ts`. The block appears the moment the operator puts the first
  thing in scope. The default-is-out rule in D4.5 still holds for the labels and the
  view; it just does not get spoken aloud to an agent.
- **The planner's variant drops the `record_asset` line**, because the planner cannot
  call it (D9). The rest of the block is identical, from the same renderer.
- **The block is outside `GOAL_BRIEFING_MAX_CHARS` and is never truncated.** That
  ceiling bounds the briefing, and `roundPromptOverhead` (`roundPrompt.ts:231`) already
  measures the preamble separately — it must be updated to account for the block, which
  is variable-length. Truncating an in-scope list would be the silent-coverage
  anti-goal with extra steps, and truncating the out-list would tell an agent a host is
  fair game. If a scope list is ever large enough to matter against the context window
  that is a real problem, but it is not this one, and a silent trim would hide it.

### D7 — The block is a point-in-time copy; the tool is not

Worth stating because a reader will assume otherwise.

Derived labels in the view update the moment entries change, because they are derived
rather than stored. But an agent already holding a prompt keeps working from the scope
it was told. The next round or attempt gets the new text.

Where that staleness is not acceptable, the answer is D11's query tool rather than a
push into a live session. Making a live scope change reach a running session is a
different mechanism — it needs the steering path, and it only matters once scope is
enforced. The roadmap's Day 22 card asks for "a policy change taking effect mid-run";
that belongs there.

### D8 — Promotion is an `in` host label, and it brings in the host alone

Promoting a discovered out-of-scope asset writes one **`in` host label** for that
asset's host. It does **not** add the host's apex, and it does not write a scope entry.
The next discovery under the same apex arrives out of scope and waits for its own
promotion. The cost is clicking; the benefit is that nothing widens behind the operator.

Because a host label covers every asset on that host (D5), promoting
`api.acme-cdn.net` also covers `api.acme-cdn.net/graphql` found a week later. That is
the behaviour the operator wants from one click, and it is the mirror of what makes an
exclusion mean what it says.

**Promote and exclude are symmetric.** Both write a label — `in` or `out` — on a host
or, if the operator picks the narrower target, on one asset. Neither touches the typed
entries. An earlier draft had promotion writing an entry and exclusion writing a label,
which made the two buttons different mechanisms wearing one shape; this is simpler and
the view can present them as one control with two directions.

**Promotion works even where the operator's own exclusion covers the asset.** Promoting
`x.labs.acme.com` when `out`/`subtree` `labs.acme.com` is in the typed list succeeds: a
label beats an entry (D5), and the view states it plainly — in scope, set by hand,
overriding that exclusion, via `ScopeState.overrode`. The alternative considered was
refusing the promotion and making the operator narrow their own exclusion. It was
rejected because this is a labelling system rather than a gate, and a visible, attributed,
single-host carve-out is a better record of the decision than an edit to the list that
loses the fact a carve-out was made.

What remains forbidden is the _machine_ doing any of this. No MCP tool writes a scope
entry or a label, ever. Both are operator actions over the browser API. That is the
anti-goal about widening, and it is the specific defect `DECISIONS.md` §5 identifies in
ScopeWeaver's `AddAutoScope`.

### D9 — `record_asset` is a precondition, and it is a worker tool

Without it there are no discovered artefacts, so there is nothing to label and the
second of the two stated goals is unreachable. It is the first slice.

`store.recordAsset` and the `RecordAssetInput` contract already exist and are exercised
by `spike/persistenceProof.ts` and `spike/crashStep.ts`. The work is the MCP tool:
decode its input with the existing schema and surface the result.
`packages/contracts/src/asset.ts` already carries the identity rules and the
`kind`/`method` cross-field check.

**It goes on the worker endpoint only.** `store.recordAsset` opens with
`attemptCallerOrFail`, and migration `0010` makes `asset_discoveries.intent_id` and
`.attempt_id` `NOT NULL` with real foreign keys to `intents` and `attempts`. A planner
round has neither, and a goal conversation has neither. Registering the tool elsewhere
would not be a registration — it would be a schema change plus a relaxation of the
discovery-provenance invariant that `0010`'s own commentary argues for. `mcp/server.ts`
records the ruling that no role sees another's tools, and `plannerTools.test.ts:398`
asserts a worker attempt is offered `record_observation` and nothing else; both need
updating for the new tool, on that endpoint.

The tool reports the asset's scope state in its result, so an agent that records an
out-of-scope host is told so immediately rather than finding out never.

### D10 — Scope state is never a filter on what the agent can read

When the agent lists assets, out-of-scope ones are returned, labelled.

ScopeWeaver does the opposite: `GetByIDsInScope` (`db/asset_dsl.go:607`) silently drops
out-of-scope ids from the result "so an agent cannot reach out-of-scope assets by id".
Silently is the problem. An agent that cannot see a host it already found will find it
again, and again, because nothing tells it the host is known. Returning the row with
its label costs one field and removes the rediscovery loop.

This requires a read surface that does not exist. `store.assets()` exists and is
unexposed; there is no asset read on any MCP endpoint and the browser API exposes only
`counts.assets`. Both are in scope for this work — see slices 2 and 6 — because without
them D10 constrains a tool nobody is building and the rediscovery loop it argues against
stays open.

### D11 — The goal conversation queries scope; it is not told it

The operator-facing goal conversation (`plan/goalPrompt.ts`, driven by
`plan/goalConversation.ts`) receives its preamble **exactly once**, ahead of the
operator's first message, and every later message travels verbatim — a tested property,
with the attachment block as its single deliberate exception. A scope block there would
have no refresh point at all: a conversation that runs for days would keep answering
the operator from a scope edited a week earlier, stated with the confidence of a
system-level instruction.

So that conversation gets a **read tool** on the goal endpoint instead. Pull, not push:

- Called with no argument, it returns the current entries, both effects, rendered
  through the same renderer D6 uses.
- Called with a host, an address or an asset id, it returns that subject's effective
  state and the entry or label that decided it — the full `ScopeState`, so the agent can
  say _why_, not just _whether_.

This is strictly better than any push variant. It is always current, it adds no second
exception to the verbatim-message property, and it costs the operator nothing when the
agent does not need it. `goalTools.ts:629` is explicit that `add_intent` and
`record_observation` are not reachable from the goal endpoint; this tool is additive
there and does not change that.

Whether the same tool is also offered to planner rounds and worker attempts — which
would give them a way out of D7's staleness — is left to the builder. It is safe
(read-only, no widening) and cheap; it is simply not required by anything the operator
asked for.

### D12 — An observation records which assets it tested

Every asset in the schema is reachable from exactly one place: `asset_discoveries`,
which links it to the intent and attempt that **found** it. Nothing links an asset to
evidence _about_ it. `observations_normalized` carries `intent_id` and `attempt_id` and
no asset reference, and `asset_id` appears nowhere else in the whole database.

So the question "which of this client's assets has anything actually been tested
against?" is currently unanswerable, and that is the question the scope view exists to
make askable. A scope frame that can say "47 hosts are in scope" but not "and 6 of them
have been touched" is an inventory, not a picture of an engagement.

One table, mirroring `intent_anchors` (`0011`) because it is the same kind of edge. It takes **whatever id is free when it lands**, not a reserved one: `0010`'s own commentary records what reserving costs, since the migrator skips everything at or below the highest id a database has already applied, so a lower id added later runs on fresh databases and silently never on existing ones.

```
observation_assets
  observation_id  TEXT NOT NULL REFERENCES observations(id)
  asset_id        TEXT NOT NULL REFERENCES assets(id)
  created_at      INTEGER NOT NULL
  PRIMARY KEY (observation_id, asset_id)
  -- plus an index on asset_id, which is the direction the view reads
```

Written in the same transaction as the observation, from asset ids the worker supplies
on `record_observation`. An id that is not an asset of this target is refused with the
instructive message §4 asks for, in the same style as the anchoring refusal.

**Do not derive this by joining through the discovering intent.** Asset →
`asset_discoveries.intent_id` → that intent's observations is available today and is
wrong: an intent testing host A that incidentally discovers host B would mark B tested.
That is coverage theatre, and it is worse than showing nothing, because it cannot be
told apart from the real thing by looking. ScopeWeaver pays for the honest version with
an explicit edge (`exploration_anchors`, joined against `fact` nodes) and so do we.

**What this is not.** It is not a coverage percentage, and it is not the graph — both
remain non-goals. It is the one piece of data without which neither could be built
honestly later, and it costs one table and one field on an existing tool. Recording it
now and reading it later is cheap; retrofitting an evidence edge across a hunt that has
already run is not, and §3 makes the same argument about the target registry.

### D13 — The scope importer

Creating a target takes one or more bug bounty program URLs. When at least one is
given, the target is registered and an agent is started whose only job is to read those
pages and write the program's stated scope into `scope_entries`.

**Three tools, on its endpoint and on no other** (revised 2026-11-01):

|                         |                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `add_scope_entry`       | one entry, with an `effect` argument; writes `source = 'imported'` and where on the page it came from |
| `record_imported_asset` | the hosts an entry names, over `store.importAsset` (D14)                                              |
| `read_scope`            | what it has written so far, so a second page can be read against the first                            |

**There is no `fetch_page`, deliberately.** The importer runs on a harness — OpenCode or
Claude Code — that already has a tool for reading a web page, and it is a better one than
we would write. Adding ours would be a second way to do a thing the session can already
do, and the agent would have to be told which to prefer.

Two consequences, both acceptable and neither obvious:

- The fetch goes through the **policy hook** rather than through a tool we own, so it is
  audited on the same path as every other tool call. That is better than our own tool
  would have given us. It does mean that when enforcement eventually lands, the importer
  reading `hackerone.com` is a host outside every scope, and the gate will have to
  permit the importer's own reads explicitly rather than by accident.
- Nothing we own observes the fetch, so **per-link progress is derived from the
  `source_url` on the calls the importer makes**, not from watching it read. A page that
  produced entries is a page that was read; a link with no calls against it yet has not
  been reached. That is enough for the panel and needs no extra plumbing.

**Why this is allowed when `AddAutoScope` is not.** The forbidden act is an agent
widening the authorization it is about to be judged against. This agent cannot test
anything, has no `record_asset`, no `add_intent` and no attempt behind it, and finishes
before any goal exists. It is transcription from a document the operator chose, into a
list the operator then reads.

**The operator's review is the control, and it rests on one property of the system:
creating a target starts no work.** `createTarget` (`http/browserApi.ts:847`) registers
the row and returns — no goal, no run, no agent. Hunting begins only when the operator
creates a goal, which is a separate action. So there is a real gap between import and
first execution, and the operator's verification sits in it.

> **This property is now load-bearing.** Anything that later starts work as part of
> creating a target — a default goal, an auto-run, a "start hunting" affordance on the
> creation screen — removes the only thing standing between a scraped page and a live
> hunt. If that is ever wanted, the review has to become an explicit confirmation step
> first.

**The pages are untrusted input.** Program scope on HackerOne or Bugcrowd is authored
by the program and rendered among other user-influenced content, and this agent is an
LLM reading it and writing to the authorization boundary. That is a prompt-injection
path whose payoff is an entry naming someone else's domain, and whose damage is legal
rather than technical. Three things contain it, and none of them is the model's
judgement: the importer can only write entries and can do nothing else; every entry it
writes carries `source = 'imported'` and the note of where on the page it came from; and
the operator reads the list before the first goal. Treat the page content as data in the
prompt, never as instruction, and say so in the importer's own framing.

### D14 — The importer records assets through its own function, not `record_asset`

The designed intake screen shows the agent recording the hosts a scope table names —
"11 assets recorded". It cannot use `record_asset` to do it. `store.recordAsset` opens
with `attemptCallerOrFail`, and `asset_discoveries.intent_id` and `.attempt_id` are
`NOT NULL` with real foreign keys to `intents` and `attempts`. The importer has an
operator behind it and no intent, no attempt and no goal — those rows do not exist yet
and will not until the operator creates one.

**Decided 2026-11-01: a dedicated store function, and a dedicated provenance table.**
Not a nullable `intent_id`.

```
asset_imports
  asset_id     TEXT NOT NULL REFERENCES assets(id)
  operation_id TEXT NOT NULL
  source_url   TEXT NOT NULL   -- the program page this host was read off
  note         TEXT NOT NULL   -- where on the page, in the importer's words
  imported_at  INTEGER NOT NULL
  PRIMARY KEY (asset_id, operation_id)
```

The `assets` row is the same row, under the same identity rules from §17 — a host the
importer reads and a host a worker later discovers are one asset, which is the whole
point of having identity rules. Only the provenance record differs, and it differs
because the facts differ: a discovery says which attempt found it, and an import says
which page it was read off.

**Why not relax `asset_discoveries`.** Making those columns nullable would weaken the
invariant for every row in the table, including the hundreds written by workers, so that
one caller with genuinely different provenance could share a shape it does not fit. Every
reader of `asset_discoveries` would then have to handle a null attempt, and the question
"which attempt found this?" would stop having an answer for reasons that have nothing to
do with the asset. `0010`'s own commentary argues for that invariant; this keeps it.

The cost is honest and small: "how did this asset come to be known" becomes a read over
two tables rather than one. A view over the union is the obvious shape if more than one
caller wants it, and is left to the builder.

### D15 — Partial results are results, total failure is a toast, and the model is picked on the screen

Decided 2026-11-01, answering the three questions A3 left open.

**One link with parseable scope is enough.** A link that 404s, needs a login, or yields
nothing a scope table can be read out of does not fail the import — the entries the other
links produced stand. There is no all-or-nothing transaction across links, and no
"partially imported" state on the target: entries are entries however many pages
contributed them, and `source = 'imported'` plus each entry's own `note` already says
where each one came from.

**If every link fails, that is not an error state either.** Show an error toast and move
the operator on to the next screen. The target was created and is entirely usable; it
simply has no scope yet, which is the same state as a target created with no links at
all, and the Assets screen already says what that means ("No scope authored for this
target"). Keeping someone on a dead progress panel to contemplate a failure they cannot
fix from there would be worse than the toast.

> Leaving the destination explicit because the A3 panel offers three exits: the toast
> hands over to the target's **Assets** screen, which is where an operator would go next
> in either case — to author the scope by hand, or to check what was imported.

**Toggling the autoload checkbox reveals a model picker**, rather than the importer
inheriting whatever the hunt's workers are configured with. Reading a scope table is
short structured extraction, and it should not cost what a worker's model costs.

- Default: **`opencode/glm-5.3-flash-free`** — the id as OpenCode's catalogue spells it
  (`spike/usageProbe.ts:75` records that spelling, with the display name beside it). It is
  preferred because it is **free**: an import should not be able to die on a paid account's
  usage limit.
- When no configured harness offers it: **that harness's own `defaultModel`**
  (`harness/identity.ts`), which is what every run already does —
  `run/supervisor.ts` is `input.model ?? harness.instance.defaultModel`.

So the order is: the operator's explicit pick, else the preferred free model if a
configured harness offers it, else the harness's own default.

> **Amended 2026-11-01. The fallback was "the Claude Code harness's Haiku"**, implemented
> as a heuristic that ranked the ids a harness reported by markers meaning "small"
> (`haiku`, `flash`, `mini`, …). Two things were wrong with it. It named **a second
> specific model**, which is a second thing to keep true as catalogues move — the very
> cost this decision's own next paragraph is about. And it answered a question the harness
> already answers: `defaultModel` is required on every instance, because an instance that
> could not say "which model" could not run anything, and it is the value runs already
> trust. Two paths to "which model, when nobody said" is one too many. In practice the old
> rule also missed its own intent: with both harnesses configured and OpenCode lacking the
> preferred model, it ran the importer on OpenCode's `gpt-5-mini` — a paid model — rather
> than on Haiku.
>
> The cost, stated: the fallback is no longer guaranteed free or small. It is the
> harness's own default, which is the operator's configuration rather than our guess, and
> the create-target screen shows which model it resolved to before anything runs. The
> preference for the free model is unchanged and keeps its reason.

**Resolve both against the live catalogue, never from a constant.** `modelOption.ts` is
explicit that a descriptor is observed when the server built the harness and replaced
wholesale when it is rebuilt, and that collapsing a descriptor into a remembered choice
is how a capability starts being presented as a selection. A hardcoded model id would be
exactly that, and would outlive the catalogue entry it names. So the preferred id is a
**lookup key** — present or absent in `instance.models`, with nothing assumed about it
when absent — and the fallback is a value the harness **reported**, not a second
hardcoded id.

The picker appears with the checkbox and hides with it, because a model choice with no
agent to run is a control for nothing.

**All the links go to one agent session, not one session per link.** A3's own copy makes
the argument: _"A scope table and a policy page often disagree. Paste both — the
disagreement is worth seeing."_ Only a reader that has seen both pages can notice a
disagreement, and a session per link structurally cannot. One session is also cheaper,
and makes the partial-failure rule above trivial rather than a merge across results.

The session reads the pages in order and writes as it goes — the entries from a page it
has already read stand whatever happens to the next one. That is what makes "one link
parsing is enough" a property of the design rather than error handling bolted on.

### D16 — The progress panel shows the tool calls, and nothing else

Decided 2026-11-01. The "Loading the scope" panel lists the importer's **MCP tool calls**
— the tool, and the value it wrote — and shows none of the agent's narration or
reasoning.

The panel is a receipt for what landed on the target, and a tool call is a fact: this
entry was written, that asset was recorded. Narration is the model talking about what it
might do, at a volume that would bury the handful of lines the operator actually needs,
and on a screen they are watching precisely because they are about to trust its output.
A reader skimming reasoning for the one line that says what was written is reading the
wrong artifact.

It also keeps the panel cheap: the calls are already crossing our MCP boundary, so
nothing extra is captured, streamed or stored to render it. `plan/` persists no narration
either, for a related reason, so this is the house position rather than a new one.

The harness's own page fetches do not appear, per D13 — they are not our tool calls. What
the operator sees is the scope being written, which is what they are there to check.

**One line of the model's prose is read, and it is not narration** (added 2026-11-01,
after the first import against a real program page). The forbidden thing above is the
model's commentary **in the call list**: the list is a receipt, each line a write that
landed, and reasoning interleaved with it would bury the handful of lines the operator is
there for. A single status line is a different artifact. The importer's prompt already ends
by asking the session to "report in a few lines: which pages you could read, what you
recorded, and anything you were unsure about" — and that report was generated and
discarded.

It is read because **an import that writes nothing cannot otherwise say why, and that is
the most common outcome.** The program pages on the big platforms are client-rendered: a
server-side read of `hackerone.com/<program>/policy_scopes` answers `200` with about 1800
bytes and no scope in it. Every step of the import succeeds, the model finds nothing,
nothing is written, and the operator was told "Nothing could be read from those pages" with
no status code, no byte count and no page title — because nothing we own observes the fetch
(D13), so the session's own account is the only account there is.

The boundary, stated so the next change knows which side it is on:

- **Read**: the session's **last message**, pulled from `AgentHarness.messages` _after_
  `waitForIdle` has returned, bounded, and settled into `ScopeImportView.detail` by the
  same call that sets the status. The panel renders it as its status line, and the toast
  carries it on the path where the panel is left behind.
- **Not read**: `sessionEvents`. Nothing subscribes to it, so nothing intermediate is
  captured, streamed or stored — which is what keeps "no narration" a property of the
  wiring rather than of a filter. The call list gains no field, and
  `import/scopeImporter.test.ts` drives a harness that narrates on that stream to prove
  none of it reaches the view.

A later change that wanted to show reasoning would still have to build a capture path.
This one did not.

## Build order

Each slice ends with the gates green: `typecheck`, `test`, `test:persistence`, `build`,
`lint`, `format:check`.

| #   | Slice                                                                                | Done when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `record_asset` MCP tool on the worker endpoint, over the existing store and contract | An agent records a host and an endpoint; both appear in `assets` with their discovery rows; an exact retry under one `operationId` returns the first result and writes nothing; the planner and goal endpoints still refuse it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2   | Asset reads: `list_assets` on the worker endpoint, and the browser route             | A worker lists what it recorded; the browser API returns assets for a target, not just a count                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 3   | `contracts/scope.ts` — schemas, normaliser, `scopeStateOf`                           | A table test covers every rule in D4 — label boundary, IP-versus-name, IPv6 brackets, out-wins, out-by-default, which-entry-named — **and** the full precedence ladder of D5: asset label over host label over entry, in both directions, with `overrode` set when a label beats an entry. Vectors written from those rules, not transcribed from ars0n                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 4   | Migration `0022_target_scope` + store reads and writes                               | Entries and both label tables round-trip against a real file; the effective-state read returns the D5 ladder; a host label covers an endpoint on that host recorded _afterwards_; the contradiction refusal in D2 has a test; `test:persistence` green                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 5   | The prompt block, one renderer, both act-on-target paths                             | A planner round and a worker attempt both receive the block; the planner's omits the `record_asset` line; a target with nothing in scope receives no block at all; a label that overrode an entry is listed once, under the label's effect; the briefing's bytes are unchanged; `roundPromptOverhead` accounts for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 6   | The scope query tool on the goal endpoint                                            | The goal agent answers "is `x` in scope" naming what decided it — entry, host label or asset label — and reflects an edit made seconds earlier                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 7   | `observation_assets` (next free migration id) + `record_observation` takes asset ids | An observation records the assets it tested, in its own transaction; an id belonging to another target is refused instructively; the store answers "which assets have evidence against them" from the edge, not from a join through the discovering intent; `test:persistence` green                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 8   | The scope view                                                                       | Two lists authored by hand; discovered assets with their state and what decided it; promote and exclude on any row, as one control with two directions, offering the host or the single asset; a row whose label overrode an entry says which entry it beat; imported entries are visibly imported                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 9   | Migration `0023_asset_imports` + the importer's own asset write (D14)                | The importer records a host with no intent and no attempt in sight; `asset_discoveries` keeps both columns `NOT NULL`; a host it imported and a host a worker later discovers are **one** asset with two provenance rows; `test:persistence` green                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 10  | The scope importer and the new create-target screen                                  | Creating a target with one or more program URLs registers it and runs the importer; its three tools — `add_scope_entry`, `record_imported_asset`, `read_scope` — exist on its endpoint only and a worker offered them fails the test; there is no `fetch_page` and the harness's own reader is used; every written entry carries `source = 'imported'` and where it came from; one link parsing is enough and the others failing changes nothing; every link failing leaves a usable target, an error toast, and the operator on Assets; the progress panel lists tool calls and no narration; the model picker appears with the checkbox, defaults to `opencode/glm-5.3-flash-free` and falls back to the harness's own `defaultModel`, both resolved from the live catalogue rather than from a constant; no goal is started by any of it |

Slices 1 and 2 are independently useful and can ship alone. Slices 3–6 are the scope
itself. Slice 7 is independent of all of them and could move earlier — it is recorded
here because it is the one thing a later graph cannot be built honestly without, not
because the scope needs it. Slice 8 is what the operator actually asked to see.

**Slices 1–8 shipped on 2026-11-01** (`f476cf1..97ca94c`), reviewed and fixed; see
`docs/uat-target-scope.md` for the acceptance script.

Slices 9 and 10 are how a real engagement's scope gets in without being typed by hand.
9 is D14's provenance table and must land before 10, which is the importer that needs it;
both depend on 3 and 4 for the entries and on 8 for the screen the operator reviews them
on.

**Slice 10 shipped on 2026-11-01** (`2289d76..e2f23d8`). What it settled in building, each
of which is a departure from what this document or A3 said and is recorded because a
reader will otherwise meet the difference and assume a mistake:

- **The importer is a fourth `CallerContext` kind**, with its own caller scope
  (`<targetId>/import/<importId>`), its own credential, its own gated role directory and
  its own MCP endpoint. D13 said "on its endpoint and on no other" without saying how; a
  fourth role is what makes it structural rather than a filter, because `mcp/server.ts`
  already refuses a grant whose kind is not the one an endpoint serves. The store's two
  writes still take a `HostContext`, so what the scope buys is the _receipt and event
  namespace_ — which is what keeps an imported `scope.entry.added` distinguishable in the
  log from one the operator typed, and that distinction is what D13's review step reads.
- **D16 is implemented by not capturing narration at all**, rather than by filtering it.
  The importer's own toolkit records each call as it crosses our MCP boundary, after the
  write lands; nothing in the server subscribes to the importer session's `sessionEvents`.
  So the panel cannot show reasoning, and `ScopeImportView` has no field one could go in.
  ~~The cost is honest: when an import settles having written nothing, this process cannot
  say why the model wrote nothing.~~ **That cost was not acceptable and has been paid off**:
  the session's closing report is read once from `messages` after it settles and becomes
  the import's `detail`. See the paragraph added to D16, which draws the line between a
  status line and narration in the call list.
- **A3's progress panel showed `fetch_page` rows and a `record_asset` row.** Both are
  overridden here — there is no `fetch_page` (D13) and the importer's asset write is
  `record_imported_asset` (D14) — so the panel lists only the three tools that exist.
- **A3 showed no model picker.** D15 added it, and it is revealed by the autoload checkbox
  and hidden with it. The model is read from `GET /importer-model`, which applies D15's
  rule on the server over the catalogue it observed; nothing in the browser bundle holds a
  model id, for the reason `modelOption.ts` argues at length.
- **Creation answers `TargetCreated`**, a wrapper around `TargetSummary` carrying the
  import handle, because that handle exists only at the moment of creation and would be
  null on every row of the target list.
- **The Estate screen's imported row was reading as an absence.** `discoveries: 0` with a
  null attempt is correct for an imported host, but a screen with only those two fields can
  say nothing better than "no recorded discovery". `imports` and `first_source_url` now
  come off `asset_imports` in the same provenance statement and reach both `AssetView` and
  `list_assets`.
- **Links are bounded at `SCOPE_IMPORT_MAX_LINKS` (8) and extras are dropped with a
  warning** rather than the import refused. One session reads every link (D15), so they
  share one context window; an operator who pasted nine pages wants the first eight read
  far more than they want to be sent back to the form.

## Calls made for you

Settled without the operator, each recoverable if wrong:

- `record_asset` is worker-only, and the planner's block drops its line (D9, D6).
- The block sits outside the briefing ceiling and is never truncated (D6).
- IPv6 is supported, and the normaliser strips the brackets `new URL().hostname` leaves
  (D4.1).
- ars0n's vectors are rewritten from our own rules, not copied (Constraints).
- Contradictory entry pairs are refused at the write boundary (D2).
- D1's stated rationale was wrong and is corrected; its conclusion stands (D1).
- `PERMISSIVE_POLICY.because` is reworded without touching the policy (Non-goals).

## Deferred

Raised by the mockups on 2026-11-01, deliberately not settled here.

- **The graph view.** Deferred by the operator. See the Non-goals note above.
- **A `service` asset kind — raised, then withdrawn.** An early mockup of the Estate
  view carried a row typed `service` (`203.0.113.44:8443`) nested under a host with a
  different name. It was not a decision, and the operator removed it from the final
  design on 2026-11-01. Recorded only so a reader who meets an old mockup does not
  reopen it: `AssetKind` stays `Literals(["host", "endpoint"])`, and slice 8 builds
  those two.
- **Per-entry aggregates and pagination, together.** The designed view shows counts per
  scope entry ("22 hosts · 198 endpoints", "145 in · 8 excluded · 31 not covered"),
  each of which means running `scopeStateOf` across every host and grouping by the
  deciding entry. That is a server-side aggregate the browser route returns, not
  something a page of rows can yield — and the same view carries a filter box, a sort
  toggle and a truncated tail. Decide the aggregate and the pagination in one go; the
  "whether `list_assets` paginates" item below is the same question from the agent's
  side.
- **"Frontier" as a navigation section.** Removed from the rail on 2026-11-01 as empty
  text. Its count matched "covered by nothing" exactly; if a promotion queue wants its
  own section later, it should be named for what it holds.

## Left to the builder

- Table and column naming beyond the three sketched above, and whether the effective
  state is better exposed as a SQL view over them than assembled in the store read.
- Whether clearing a label is a delete or a stored `cleared` state. Either satisfies
  D5, since the event log holds the history regardless.
- Whether the scope view's promote/exclude control defaults to the host or the single
  asset, and how it offers the other.
- The browser API routes and their payload shapes; follow `http/browserApi.ts`'s
  existing conventions.
- Which event types the label changes and entry changes emit, and their payload shape
  under `unknownField.ts`'s tolerant-reader rule.
- The scope view's layout within the target screen — a tab, a panel, or its own route —
  and whether it reuses `IntentList.svelte`'s row idiom.
- How an invalid or contradictory entry is reported in the view. The normaliser and D2
  decide what is refused; the presentation is open.
- Whether the D11 query tool is also offered to planner rounds and worker attempts.
- Whether `list_assets` paginates, and on what.
