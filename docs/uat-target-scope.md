# UAT — target scope and the Assets screen

> **2026-11-06:** the pre-execution policy gate this document mentions was removed at the
> operator's request, to be redone later. See the "Policy gate removed" entry in
> `docs/superpowers/plans/2026-11-03-a6-chat-revamp-breakdown.md`; the last commit with the
> gate is `635c1fc`.

> **Superseded in part.** Anything to do with the scope importer — opening a conversation,
> sending turns, narration, records, replay, resume, the Agent sessions list, or recovery after a
> restart — is in `docs/uat-importer-conversation.md`. This document still covers the scope model
> itself: entries, labels, promotion and what the agent is told.

A step-by-step script for the work in `f476cf1..HEAD`: the scope a target carries, the
estate the hunt discovers under it, and the text an agent is actually given.

**How to use this.** Work top to bottom — later parts rely on state earlier parts create.
Each step is an action and the one thing to look for. Tick as you go. If a step fails,
write what you saw next to it and carry on; later steps rarely depend on a failure.

**Time:** about 45 minutes for Parts 0–H.

**Labels:** button text is quoted as built. If a label differs slightly but the control is
obviously the one described, that is not a failure — note it and continue.

**What this is not.** Nothing here is enforced. The policy gate still permits every host;
scope tells the agent what it is authorized to test and frames what it finds. A step that
says "the agent is told" means exactly that and nothing stronger.

---

## Part 0 · Setup

**0.1** Open a terminal in the repo.

```sh
cd /run/media/hbt/work/bit
git log --oneline -1          # expect 97ca94c or later
bun install --frozen-lockfile
```

`[ ] pass  [ ] fail` ______________________________________________

**0.2** Seed the demo target. It writes through the real paths — register, `recordAsset`
under a real attempt, `addScopeEntry` as the operator — so the screen it produces is one
the application can actually reach.

```sh
cd apps/server && bun run src/fixture/scopeFixture.ts && cd ../..
```

→ It names the target it seeded. It is idempotent: run it twice and nothing duplicates.

`[ ] pass  [ ] fail` ______________________________________________

**0.3** Start the app. Set the password yourself — a generated one is printed once and is
not recoverable, and `BIT_PASSWORD` wins on every boot without being stored.

```sh
BIT_PASSWORD=uat bun run dev
```

→ The log says `server password: taken from BIT_PASSWORD`. Web on **5173**, server on
**3000**. Do not move the server off 3000 — the dev proxy expects it there.

`[ ] pass  [ ] fail` ______________________________________________

**0.4** Open <http://localhost:5173>, sign in with `uat`, open the target `scope-demo`,
then **Assets** in the rail.

`[ ] pass  [ ] fail` ______________________________________________

> **Two things that are not your bugs.** `bun run format:check` fails on
> `sprint-roadmap.html`; it predates all of this. And `typecheck`, `test` and `build`
> replay Turbo's cache and print as though they ran — add `--force` for a real run.

---

## Part A · The estate

The fixture seeds five scope entries and four hosts. You should be able to predict every
row before you look at it.

| Entry         |                    |     | Host                | Expected                   |
| ------------- | ------------------ | --- | ------------------- | -------------------------- |
| `in` subtree  | `acme.test`        |     | `app.acme.test`     | in, by that entry          |
| `in` host     | `app.partner.test` |     | `blog.acme.test`    | excluded, by entry         |
| `in` cidr     | `203.0.113.0/24`   |     | `api.acme-cdn.test` | not covered by anything    |
| `out` subtree | `labs.acme.test`   |     | `x.labs.acme.test`  | in **by hand**, overriding |
| `out` host    | `blog.acme.test`   |     |                     |                            |

**A.1** On the **Estate** tab, confirm assets are grouped under the host they were found
on, and that each host shows its own state.

`[ ] pass  [ ] fail` ______________________________________________

**A.2** Check the four hosts against the table above.

`[ ] pass  [ ] fail` ______________________________________________

**A.3** Expand `app.acme.test`. Three endpoints. `/internal/metrics` is **Excluded**
while its host is in scope — that is an asset label beating the entry.

`[ ] pass  [ ] fail` ______________________________________________

**A.4** Expand `blog.acme.test`. Its endpoint `/wp-login.php` is excluded too, and says it
**inherits** that from the host rather than carrying its own label.

`[ ] pass  [ ] fail` ______________________________________________

**A.5** Note that `api.acme-cdn.test` is **present**, not hidden. Out-of-scope discoveries
are kept and labelled — they are your queue, not noise.

`[ ] pass  [ ] fail` ______________________________________________

---

## Part B · Three states, three sentences

**B.1** Read the chips: `In scope`, `Excluded`, `Not covered`. Three different words.

`[ ] pass  [ ] fail` ______________________________________________

**B.2** Read the sentence under each. Each says _what decided it_, not just the verdict.
"Excluded on purpose" and "covered by nothing" must not read the same — the second is
promotable and the first is a decision you made.

`[ ] pass  [ ] fail` ______________________________________________

**B.3** Use the filters — `All`, `In scope`, `Excluded`, `Not covered`. Counts should add
up to `All`.

`[ ] pass  [ ] fail` ______________________________________________

**B.4** Find `x.labs.acme.test`. Its sentence names the entry it **overrode**
(`labs.acme.test and every subdomain`). An override that didn't say what it beat would be
the bug this line exists to prevent.

`[ ] pass  [ ] fail` ______________________________________________

---

## Part C · What a click reaches

The whole point of this control is that "this host" and "this asset" are different, and
the screen must say which you are about to do.

**C.1** On `api.acme-cdn.test` (not covered), open the label control. Every option states
its reach in words — the host option says it covers **every asset on that host, now and
later**; the asset option says **that one asset**.

`[ ] pass  [ ] fail` ______________________________________________

**C.2** Promote **the host**. The host flips to In scope, and its `/graphql` endpoint
follows without being promoted separately.

`[ ] pass  [ ] fail` ______________________________________________

**C.3** Clear that label. Both go back to Not covered.

`[ ] pass  [ ] fail` ______________________________________________

**C.4** Now promote **the asset only** (`/graphql`). The endpoint flips; the host stays
Not covered. If both move, the two options are not actually different and that is a
failure.

`[ ] pass  [ ] fail` ______________________________________________

**C.5** Clear it again.

`[ ] pass  [ ] fail` ______________________________________________

**C.6** Exclude `app.acme.test` (currently in scope by entry). All three of its endpoints
go Excluded, including ones you never touched.

`[ ] pass  [ ] fail` ______________________________________________

**C.7** Clear that label before continuing — later parts assume the seeded state.

`[ ] pass  [ ] fail` ______________________________________________

---

## Part D · One answer per host

**This part is a regression check.** A promoted host used to appear in _both_ lists of the
text handed to the agent, which read as "this host is in scope and also out of scope."

**D.1** Open the **Scope** tab and read the **What the agent is told** panel.

`[ ] pass  [ ] fail` ______________________________________________

**D.2** Find `x.labs.acme.test` — the seeded override. It appears **once**, under
`In scope`, and **not** under the out list.

`[ ] pass  [ ] fail` ______________________________________________

**D.3** Confirm `labs.acme.test and every subdomain` is still listed as out. The parent
exclusion still applies to everything else beneath it; only the one carved-out host moved.

`[ ] pass  [ ] fail` ______________________________________________

**D.4** Go back to Estate, exclude `app.partner.test` by hand (it is in scope by a host
entry), then re-read the panel. It appears once, under the out list only.

`[ ] pass  [ ] fail` ______________________________________________

**D.5** Clear that label.

`[ ] pass  [ ] fail` ______________________________________________

---

## Part E · The Scope tab

**E.1** Both authored lists are shown, and **every entry says what it covers** — "and
every subdomain", "that host only", "every address in the block". An entry rendered as a
bare domain would be the misread this whole feature exists to prevent.

`[ ] pass  [ ] fail` ______________________________________________

**E.2** Hand labels are listed separately from typed entries, under `Set by hand`.

`[ ] pass  [ ] fail` ______________________________________________

**E.3** The agent panel is the **server's** text, not a reconstruction the browser
assembled. Compare it against the lists above it: same hosts, same wording.

`[ ] pass  [ ] fail` ______________________________________________

**E.4** Add an entry: `in`, host only, `shop.acme.test`. It appears in the list and in the
agent panel.

`[ ] pass  [ ] fail` ______________________________________________

**E.5** Now try to add `out` / host / `shop.acme.test`. **Refused**, naming the existing
entry. An entry cannot be in and out at once.

`[ ] pass  [ ] fail` ______________________________________________

**E.6** Try the same in the other direction: remove `shop.acme.test`, add it as `out`
first, then try `in`. Also refused.

`[ ] pass  [ ] fail` ______________________________________________

**E.7** Remove `shop.acme.test`.

`[ ] pass  [ ] fail` ______________________________________________

---

## Part F · A target with no scope

**F.1** Create a second target (any folder). Open **Assets** → **Scope**.

→ `No scope authored for this target`, and copy explaining the hunt still runs and still
records everything, labelled `not covered`.

`[ ] pass  [ ] fail` ______________________________________________

**F.2** Click **Add the first entry**. It must _do_ something — put you in the entry
field. A button that looks like it worked and did nothing is the specific failure this
step checks.

`[ ] pass  [ ] fail` ______________________________________________

**F.3** Confirm the agent panel shows **no block at all** — not `In scope: (nothing)`.
An agent on an unauthored target gets the prompt it always got, unchanged.

`[ ] pass  [ ] fail` ______________________________________________

**F.4** Add one entry. The block now appears.

`[ ] pass  [ ] fail` ______________________________________________

**F.5** Remove it again. The block disappears.

`[ ] pass  [ ] fail` ______________________________________________

---

## Part G · Width and theme

**This part is a regression check.** Asset identities used to shred into one- and
two-character-per-line ribbons between 768px and 1280px.

**G.1** Back on `scope-demo`'s Estate tab, resize to **768px**. Every host and path stays
on one line and stays readable.

`[ ] pass  [ ] fail` ______________________________________________

**G.2** Sweep 834, 900, 1024, 1180, 1280, 1440. No width shreds the identity column, and
nothing overflows horizontally.

`[ ] pass  [ ] fail` ______________________________________________

**G.3** Switch to the light theme. Every state is still distinguishable and no text
disappears into its background.

`[ ] pass  [ ] fail` ______________________________________________

**G.4** Below 768 is deliberately out of scope — do not report it.

`[ ] n/a` ______________________________________________

---

## Part H · What the agent sees

**H.1** Worth knowing rather than clicking: `record_asset` and `list_assets` exist on the
**worker** endpoint only. A planner round or the goal conversation asking for them finds
no such tool. Covered by tests; no UI step.

`[ ] n/a` ______________________________________________

**H.2** When a worker records a host no entry covers, the tool's own result tells it so
immediately, and `list_assets` returns every asset **with its state** — so an agent can
tell a host is already known-and-out instead of rediscovering it forever.

`[ ] n/a` ______________________________________________

---

## What this script does not cover

Say so rather than assuming these work.

- **IPv6.** A bracket-stripping bug meant an IPv6 asset could never match an entry or a
  hand label. It is fixed and tested end to end, but the fixture seeds no IPv6 asset, so
  nothing here exercises it by hand.
- **Enforcement.** There is none, by design. The gate records and permits.
- **The intake agent and the new target screen** (A3). Not built — Phase 2.
- **The asset graph** (A5). Deferred.
- **Tested vs untested assets.** The schema cannot answer it yet; `observation_assets`
  (slice 7) is the table that would, and it is not built.
- **Imported entries.** The `source` column exists and the screen can show it, but nothing
  writes an imported entry until the intake agent lands, so you will only see `operator`.

## If you want to start over

```sh
rm -rf apps/server/.runtime/hunt/targets/scope-demo/
```

That is the whole of the demo target's state. Re-run the fixture from 0.2.
