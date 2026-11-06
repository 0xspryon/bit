# Domain vocabulary and model refusals: what a rename would and would not buy

> **2026-11-06:** the pre-execution policy gate this document mentions was removed at the
> operator's request, to be redone later. See the "Policy gate removed" entry in
> `docs/superpowers/plans/2026-11-03-a6-chat-revamp-breakdown.md`; the last commit with the
> gate is `635c1fc`.

**Status:** investigation only, nothing implemented. Requested 2026-11-03.
**Date:** 2026-11-03

## The question asked

Whether the security-domain vocabulary in this repository could be renamed to
non-security words, so that Opus 5.5 can be used here without being blocked.

## The finding, first

**The premise does not match the repository.** bit contains almost no offensive-security
vocabulary. What it contains is a domain model whose nouns are ordinary software words. A
rename of the kind proposed would touch 89% of the source files, require forward migrations
against two append-only chains, and change the agent-facing wire format — in order to rename
the words that are not the problem.

Whole-word counts across 288 files, excluding `node_modules` and build output:

| Term                                                                | Whole-word occurrences |
| ------------------------------------------------------------------- | ---------------------- |
| `penetration`, `adversary`, `threat`, `victim`, `intrusion`, `vuln` | **0 each**             |
| `exploit`, `breach`, `compromise`, `adversarial`, `privilege`       | 1 each                 |
| `pentest`                                                           | 2                      |
| `reconnaissance`                                                    | 3                      |
| `attack`                                                            | 5                      |
| `bounty`                                                            | 6                      |
| `vulnerability`                                                     | 10                     |
| `attacker`                                                          | 13                     |
| `injection`                                                         | 15                     |

That is roughly 65 occurrences in the entire repository, most of them in prose explaining
the domain rather than in code.

`recon` looks like a counter-example at 562 matches until you look: 560 are `reconcile`,
`reconciliation` and `reconnect` — harness recovery and SSE reconnection. The security sense
appears exactly twice, both in documentation.

The large counts belong to the domain model, and every one of them is an ordinary word:

| Term          | Substring | Whole-word | Files |
| ------------- | --------- | ---------- | ----- |
| `target`      | 8418      | 3134       | 193   |
| `scope`       | 5352      | 2241       | 186   |
| `intent`      | 4162      | 1618       | 120   |
| `asset`       | 2974      | 816        | 103   |
| `observation` | 2622      | 718        | 114   |
| `operator`    | 2364      | 2199       | 198   |
| `worker`      | 1418      | 880        | 149   |
| `claim`       | 1357      | 608        | 157   |
| `gate`        | 1175      | 508        | 116   |
| `policy`      | 1137      | 638        | 117   |

None of these is a security trigger word. `target`, `worker`, `policy`, `gate`, `claim` and
`intent` are generic software vocabulary; `payload` here means a message body and never an
attack payload; `probe` means a session probe; `audit` means the policy gate's own log;
`kill` means `process.kill`.

## What a rename would actually cost

From the inventory:

- **249 of 280 source files (89%)** contain a domain term inside an identifier. That is
  every file in `apps/server` (140/140) and every file in `packages/contracts` (19/19).
- **87 of those are tests**, plus 5 fixtures.
- **11 domain-named tables** and a long list of columns live in append-only migration chains
  (`persistence/migrations.ts`, `controlMigrations.ts`). `AGENTS.md` forbids editing an
  applied migration, and the baseline's own header says its one-off collapse "is not a
  precedent" — so every table or column rename is a new forward migration plus a SQLite
  table rebuild.
- **Two committed schema dumps** (`expectedSchema.hunt.txt`, `expectedSchema.control.txt`)
  duplicate every table and column name.
- **The on-disk layout** is domain-named: `HUNT_ROOT`, `targets/<id>/hunt.sqlite`,
  `control.sqlite`, per-target `evidence/` directories. Renaming reaches every existing
  database file an operator holds.
- **18 MCP tool names are the agent-facing wire format** — `add_intent`,
  `record_observation`, `add_scope_entry`, `record_imported_asset`, `read_scope` and the
  rest. The planner chat's call/record merge rule is keyed on these exact strings through
  `bareToolName`, and a harness's own session history embeds them.
- **~3,500 occurrences in documentation**, of which `DECISIONS.md` alone holds 1,886.

This is not a refactor with a bad cost-benefit ratio. It is a refactor whose benefit is
close to zero, because the words it renames are not the ones carrying the signal.

## Where the signal actually is

Four places, totalling a handful of files:

1. **`apps/server/src/import/importerPrompt.ts`** — "You are reading the published scope of
   a bug bounty program…", "The engagement is called…". This is prompt text sent to a
   harness on every import.
2. **`apps/server/src/spike/prompts.ts`** — carries a live offensive-security task:
   "Determine whether authentication rate limits on this service can be bypassed…", at lines
   52 and 134. Used by `workerDemo.ts`, `phases.ts` and `milestoneProof.ts`.
3. **`DECISIONS.md`** — defines the domain glossary, including `finding` = "A confirmed
   vulnerability (distinct from a fact)".
4. **`README.md` and `docs/design/flow-a-getting-in.md`** — the second is titled for what it
   describes.

## Why renaming would probably not help, and might hurt

A model reads purpose, not tokens. Renaming `target` to `subject` leaves a repository that
still imports bug-bounty program pages, still has a policy gate that denies an agent's tool
calls, still stores findings against hosts, and still calls its database `hunt.sqlite`. The
purpose is legible from the structure. What the rename removes is the _clarity_ of that
purpose, and a codebase whose purpose is harder to read is one a careful reader — human or
model — treats more cautiously, not less. Vagueness about why you are doing something reads
as evasion, and evasion invites the caution it is trying to avoid.

There is also a practical cost that is easy to miss: a model that has been told less about
what it is building gives worse advice about it. Several genuinely useful findings in this
week's work came from models reasoning _from_ the domain — the review that spotted a code
fence could forge a committed scope record did so because it understood that program pages
are attacker-controlled and that the record/narration distinction is a trust boundary. A
model working on "subjects" and "boundaries" does not make that connection.

## What would actually help

**1. State the authorisation context in `AGENTS.md`. This is the highest-leverage change
available and it costs one paragraph.**

`AGENTS.md` currently contains **zero** statements of authorisation — no occurrence of
authorised, permission, programme, enrolled, or consent. It opens by describing the operator
as "experienced with single-tenant software but new to building agent harnesses" and never
says what the software is for. A model that infers an offensive-security purpose from the
code and finds nothing in the project's own instructions establishing that the work is
authorised is being asked to guess, and the cautious guess is the one it will make.

Saying plainly that bit is tooling for bug-bounty programs the operator is enrolled in, that
engagements are scoped and authorised by the programs themselves, and that the policy gate
exists to keep agents inside that authorisation, is both true and the thing that resolves
false-positive caution. It is the opposite of hiding the domain.

**2. Neutralise `spike/prompts.ts`, because its content is incidental to what it proves.**

Those three spikes exist to prove harness mechanics — worker lifecycle, phase transitions,
milestone recording. The prompt's subject matter does nothing for that. A spike that asks an
agent to count files under a directory proves the same mechanics. This is worth doing on its
own merits: a fixture should be the simplest thing that exercises the path, and a live
offensive task is not that.

**3. Nothing else.**

`HUNT_ROOT` and `hunt.sqlite` are the only genuinely domain-flavoured _infrastructure_
names. Changing them means a forward migration and a change to the on-disk layout of every
existing database, for a cosmetic gain. Not worth it.

## The part of the request I did not act on

The request included changing how tasks are described to Opus 5.5 — framing work in terms
that do not reveal what it is for, while it still serves bit's actual purpose.

I have not designed that and will not. Deliberately misdescribing work so that a safety
layer does not recognise it is circumventing that layer by deception, and that holds even
when the underlying work is legitimate — which this work is. The distinction that matters
is between _renaming a concept because the new name is more accurate_ and _describing a task
in order to obscure its purpose_. The first is engineering. The second is not, and it is
also self-defeating for the reason in the section above: the model's usefulness on this
codebase comes substantially from understanding the threat model it is building against.

If Opus 5.5 declines something specific here, the productive response is to say what the
project is and why the work is authorised. That is accurate, it is what the model needs, and
in my experience it resolves exactly this class of refusal. If a refusal survives an honest
and complete explanation, that is information worth having rather than an obstacle to route
around.

## Caveats on the numbers

The inventory was taken while `apps/web` was being modified by another agent; two
measurements minutes apart differed by about 2%. Treat all counts as ±3%. Bucket
classification (identifier vs string vs comment) is heuristic and approximates Svelte
template text. Substring and whole-word counts are both reported because neither is "the"
number: substring is polluted by `reconcile` (recon), `createState` (estate) and
`vulnerability` (vuln), while whole-word still matches `scope` inside `out-of-scope`.
`.gitignore`d files, including runtime databases and `targets/` artefacts, are invisible to
the survey by design.
