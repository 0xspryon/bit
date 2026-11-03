# Addressable resources: the URL as the app's place

**Status:** approved; decisions 1 and 2 taken by the operator on 2026-11-03
**Date:** 2026-11-03

## What this is for

One sentence, the operator's: _"I want to bookmark and share deeplinks with myself for
later review."_ The example given is the one that stings today — there is no way to link
to a specific AI asset chat. The comparison offered is Gmail: a resource id in the
address bar of a single-page app.

That is the whole goal, and it is worth saying what it excludes. This is not about server
rendering (the app already declares `ssr = false`), not about SEO, not about multi-user
sharing. It is one operator, one server, and a link that still lands in the right place
next week.

## State of play

Four findings from reading the code, because they decide most of the design.

**The app is already an SPA, deliberately.** `apps/web/src/routes/+layout.ts` is one line:
`export const ssr = false`. `vite.config.ts` configures `adapter-static` with
`fallback: "index.html"`. So a built app already answers any path with the shell. Nothing
has to be undone to get path URLs.

**The pattern already exists, for exactly one resource.** `+page.svelte:30-78` reflects the
open target into `?target=<id>` and reads it back at mount. It is one-way on purpose, and
the comment says why: _"state is the source of truth and the URL follows it. Reading the
URL back on every change would mean two writers for one fact and a race between them on
every click."_ It also already handles the hard case — a deep link arriving with no
session waits behind Connect and opens once there is one. This work generalises that; it
does not replace it.

**`App` is already shaped for replay** — with one exception, found during S1 and
corrected here. Every way into a resource is a method that takes an id and loads from it:
`openTarget(id)`, `toSection(id)`, `toAssetsTab(tab)`, `openGoal(goalId)`,
`loadTranscript(targetId, attemptId)`. A route handler calls the methods that are there,
outermost first; `openTarget` resets `navItem` to `"goals"`, so the order is not
incidental.

The exception is the chat, which is the row this whole document exists for.
`openImporter(sessionId)` delegates to `ImporterSessions.open`, which **silently does
nothing** for an id the index does not already hold — and on a cold load the index arrives
a round trip after the Assets section is entered, so the requested id is simply lost and
the page opens on an empty session. The remedy is not new machinery:
`App.openImporterSession(sessionId)` already reads the index, re-checks, reports a session
that is gone, and opens the one that is there. Its own comment calls it _"a stopgap: see
`AgentSessions.svelte` on the deep link this stands in for"_, and `AgentSessions.svelte`
says _"The destination of a row is a deep link, and this build cannot make one."_ Two
comments in the codebase were already waiting for this work. Replay uses that method.

**Paths 404 in development.** `curl /t/acme-corp` returns 404 against `bun run dev`. The
static fallback applies to the _built_ app; SvelteKit's dev server still routes from
files. Path URLs therefore need a route file, which is the one piece of new plumbing here.

## The constraint to protect

`+page.svelte` says it keeps the URL out of `App` because _"`$app/navigation` is
SvelteKit's, and `App` is a plain class that a test or a second shell can construct
without a router."_ That property is load-bearing: the web and DOM suites mount
screens against a bare `new App()` — 455 and 84 of them when this was written, 549 and 84
by the end of S2. A count in prose goes stale in a week; what must not change is that none
of them needs a router. Nothing in this design may put a SvelteKit import
inside `App` or require a router to construct one.

## Design

### D1 — The URL is a projection of the place, and the place is a small part of the state

`App` has well over two hundred `$state` fields. Almost none of them belong in a URL. The
distinction this design draws:

- **Place** — which resource you are looking at. Target, section, tab, record id. Goes in
  the URL.
- **View** — how you have arranged your look at it. Filters, search text, which picker is
  open, scroll offset, whether the live dock is expanded. Stays out.

The test is the operator's own words: _for later review_. A link is worth saving when it
names a thing you will come back and read.

The line is not absolute, and the operator moved it: **the estate filter is in** (decision
2 below). "Uncovered assets on acme-corp" is a thing you would come back to, not merely a
way of squinting at a list. That does not collapse the distinction, it relocates it — see
D2. Place goes in the path, a view worth keeping goes in the query, and the rest goes
nowhere.

### D2 — Paths, not query parameters

`/t/acme-corp/assets/chat/is_7f3a91` rather than
`/?target=acme-corp&nav=assets&tab=scope&chat=is_7f3a91`.

A path is readable months later in a bookmark list; a four-parameter query is not. The
app's structure is already a hierarchy — target, then section, then record — so a path
mirrors something true rather than inventing an encoding. Cost is bounded: one catch-all
route, plus a parse/format pair.

**Considered and rejected: a fragment,** Gmail-style (`/#/t/acme-corp/...`). A fragment
never reaches the server, so it would work even under a host with no SPA fallback — a real
advantage, since nothing serves the production build yet. Rejected because the fallback is
already configured correctly, a fragment breaks the `goto`/`popstate` machinery SvelteKit
provides, and it reads as a workaround in a bookmark. Recorded here so the reasoning
survives if production serving later turns out to be awkward.

**Considered and rejected: query parameters for the resource itself,** which need no
route file and work in dev today. Rejected on readability, which is the stated goal.

**But the query keeps a job.** The path says which resource; the query says how you were
looking at it:

```
/t/acme-corp/assets/estate?filter=uncovered
```

This is the ordinary division of labour between a path and a query string, and it earns
its keep three ways. The path stays a clean hierarchy, with every segment a resource. A
view modifier can be added or dropped without touching the grammar — which matters,
because a bookmarked path is a promise and a bookmarked query is a convenience. And it
settles the next question before it is asked: if the estate's search text ever earns a
place, it arrives as `&q=admin` rather than as a path segment with a slash in it.

A query parameter that is absent, misspelled or impossible means the default view, never
an error. A link is a request, not an assertion.

### D3 — The grammar lives in a pure module

`apps/web/src/lib/place.ts`, browser-safe, no SvelteKit imports:

```
type Place = … // a discriminated union, one case per addressable resource
placeOf(app: App): Place        // read the place out of the state
pathOf(place: Place): string    // format
parsePath(path: string): Place  // parse, total — never throws
applyPlace(app: App, place: Place): Promise<void>  // replay, by calling App's own open* methods
```

The shell keeps owning `goto` and `popstate`; `App` keeps knowing nothing about either.
`place.ts` is unit-testable without a router or a DOM, which is where the round-trip
property tests go.

**`applyPlace` was specified as `void` here, and that was wrong.** S4 found it, and the
slice order hid it: while reflection replaced unconditionally, nothing needed to know when
a place had finished landing. Two of the eight places are reached across a round trip — a
chat reads the importer's index before it can select a session, an attempt reads its
transcript — so between the call and the answer the app stands on the page _above_ the
place that was asked for. Reflecting that was an invisible flicker when every write
replaced. Under D4's push rule it is a junk history entry per deep link, and a second one
when the real place arrives. So the replay is awaitable, and reflection is suppressed while
it runs.

### D4 — One-way, except on history navigation

The existing discipline holds: state writes the URL continuously, the URL is read only at
discrete moments. Those moments become two rather than one — at mount, and on `popstate`.
A `popstate` is a discrete event, not a continuous read, so it does not reintroduce the
race the current comment warns about. That argument is true and **not sufficient**:
discreteness stops the race, it does not stop the ratchet — an apply that reflects can
still leave one new history entry per traversal for ever. What stops that is the rule
below, named here because S4 had to invent it: **a write that would not change the address
bar is skipped.** Since `parsePath` and `pathOf` are inverses over every `Place`, a
traversal that applies successfully ends in exactly that equality, so the cycle has no
first step. Stated as two halves, neither of them a convention anyone has to remember:
the browser fires `popstate` for a traversal and never for the `pushState` a write
performs, so the writer cannot wake the reader; and skip-when-equal means the reader
cannot wake the writer.

This is also what makes Back work, which a deeplinking app is expected to do. The
granularity: **opening a resource pushes a history entry; everything else replaces.**
Opening three targets in a row leaves three entries, because you may want to go back
through them — **by the target crumb picker**, which is the route that walks target to
target; going out to the list and in again interleaves a `/` entry each time, correctly,
because the list is a place you really did visit. Toggling a picker leaves no entry at
all, because it is not in the URL.

The rule in the end needed no second axis over the grammar, because **it is** the grammar:
a change of _path_ pushes, a change of _query_ replaces. D2 put the resource in the path
and the view modifier in the query for exactly this reason. One extra case, which is not
obvious until a bookmark proves it: re-spelling the same place — `/t/x/goals` onto `/t/x`,
or an old `?target=x` onto `/t/x` — replaces, because pushing a re-spelling leaves an entry
whose Back lands on the same page under its old name, and with a saved `?target=` bookmark
it would do that once per attempt to leave the page.

**Three SvelteKit mechanisms for reading a traversal cannot work, and one fact kills all
three.** A shallow `goto` never advances `page.url`: `update_page` is called with the new
URL only under `shallow`, and every history entry is stamped `pageUrl: page.url.href` —
the URL the _document was loaded with_. So `page.url` is the load URL while the address
bar has moved on, and on a traversal the router sets it back to that stale value.
`afterNavigate` sees the same thing, because the popstate handler navigates to
`new URL(history_metadata.pageUrl ?? location.href)` rather than to the entry the browser
traversed to. And `page.shallow.url` _is_ correct on a traversal, but it is also written by
our own `goto`, which readmits the two-writers race through a side door. What is left is a
bare `window.addEventListener("popstate", …)`, whose contract is precisely "a traversal
happened, and `location` is now the truth". Verified against the installed SvelteKit
3.1.0 source, not from memory — this project has already been wrong once by reasoning from
SvelteKit 2.

**And nothing is written while a place is held** — the rule S2 had to invent, because D4
and D6 contradict each other without it. Connect is a gate rather than a place, so
`placeOf` reads the target list for as long as it is up; reflecting that would erase the
link the tab was opened with, and a reload at the gate would land on the list instead of
the bookmark. So reflection is suppressed from the moment a place is held until `App`
releases it, which is the same moment there is something true to write. Both ways in
release it, and an unresolvable target is dropped before anything opens, so nothing stays
suppressed past the gate.

### D5 — A link to something that is gone says so

A bookmark outlives the thing it names: a goal gets ended, a target gets removed, an
importer session falls out of the harness. `openRequested()` today drops an unknown target
_silently_, which is defensible for a stale tab and wrong for a bookmark — the operator
asked for something specific and deserves an answer.

The rule: **fall back to the nearest place that does exist, and say what was missing.**
A dead goal id lands on that target's goal list with "that goal no longer exists"; a dead
target lands on the target list with the same courtesy. Never a blank screen, never a
spinner that does not end, and never silence.

A dead **chat session** is the case most likely to happen, because a harness can let a
session go while the index still remembers it. `openImporterSession` already produces the
sentence for it — "That importer session is no longer in the importer's own list, so there
is nothing to open it on." What it does not yet get right is _where_ that sentence appears:
it writes `agentSessionsNote`, which is the Agent sessions screen's banner, and an operator
arriving from a bookmark is not on that screen. S5 owns moving it to a surface the arrival
can see.

### D6 — A deep link that arrives signed out is held, not lost

`requestTarget` / `openRequested` already do this for a target id. They generalise to a
pending `Place`: parse at mount, hold it, replay the whole thing after Connect succeeds —
by either way in, a fresh sign-in or a resumed session, because a link should land in the
same place either way. This matters more than it sounds: the browser session registry is
in memory, so a server restart invalidates it, and a bookmark opened the next morning is
_the_ common case rather than an edge one.

## The addressable inventory

| Place                     | Path                                                                                                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target list               | `/`                                                                                                                                                                                                            |
| A target (lands on Goals) | `/t/<targetId>`                                                                                                                                                                                                |
| A section                 | `/t/<targetId>/<section>`                                                                                                                                                                                      |
| A goal                    | `/t/<targetId>/goals/<goalId>`                                                                                                                                                                                 |
| Assets, one tab           | `/t/<targetId>/assets/estate` · `/t/<targetId>/assets/scope`                                                                                                                                                   |
| The estate, filtered      | `/t/<targetId>/assets/estate?filter=uncovered`                                                                                                                                                                 |
| **An AI asset chat**      | `/t/<targetId>/assets/chat/<sessionId>` — the **harness** session id (`ses_…`), which is what `AgentSessionView.sessionId` carries (`browserApi.ts`: `sessionId: session.harnessSessionId`), not the import id |
| An attempt transcript     | `/t/<targetId>/attempts/<attemptId>` — inbound only, see decision 1                                                                                                                                            |
| Settings                  | `/t/<targetId>/settings` — a `navItem` the rail's footer sets, so a section like any other                                                                                                                     |

`<section>` is a nav id from `navGroups`: `goals`, `findings`, `observations`, `assets`,
`evidence`, `workers`, `blockers`, `events`, `agent-sessions`. `attempts` is the one
second segment that is not a section — see decision 1.

Connect and the New target dialog get no URL. Connect is a gate, not a place — it is what
is shown while the app does not yet know whether it is signed in. A dialog is view state
by D1.

## Slices

Each slice ends on `main`, with gates green and the UI driven in a browser.

### S1 — The grammar

`place.ts` alone: the `Place` union, `pathOf`, `parsePath`, `placeOf`, `applyPlace`. No
wiring, nothing imports it yet.

_Done when:_ every row of the inventory round-trips `parsePath(pathOf(p)) === p`;
`parsePath` is total over garbage input (unknown section, missing id, trailing slash,
percent-encoding, an id with a slash in it, `attempts` with no id) and returns the nearest
valid place rather than throwing; an absent, misspelled or impossible `?filter` yields the
default view rather than an error; `placeOf(new App())` is the target list.

### S2 — The route, and the target link it replaces

Move `+page.svelte` under a catch-all route. Reflect `placeOf` into the path on every
change. Read the path at mount. Retire the `?target=` special case — and keep old links
working by translating `?target=<id>` into the path form once, on arrival.

**Scope note, decided during S1 — and this time actually written down.** This slice
carries the _held place_ as well: the generalisation of `requestedTargetId` from a target
id to the whole place, so a link opened before sign-in lands where it pointed rather than
on that target's Goals page. It belongs here because S2's own criteria need it, and
splitting it would leave a visibly half-working deep link on `main`. S5 keeps the
dead-resource half only.

_Done when:_ `/t/<id>` and `/t/<id>/<section>` open that place from a cold load, signed in
or signed out; navigating by clicking updates the address bar; a reload holds the place; an
existing `?target=acme-corp` bookmark still lands on that target; the web tests still
construct `App` without a router.

### S3 — Records by id

`openGoal`, `openImporterSession(sessionId)` and `loadTranscript` reachable from a path.
This is the slice that answers the original complaint, and the slice that retires the two
in-memory stopgaps in `AgentSessions.svelte` and `openImporterSession`.

`AgentSessions.svelte` lines 44-48 sketch the paths that shim was expected to become —
`/targets/:targetId/importer/:sessionId` and `/targets/:targetId/goals/:subjectId` — which
is not the grammar that was approved. That comment is helpful today and misleading the
moment the shim goes, so this slice deletes or corrects it rather than leaving a second
spelling of the URL scheme in the tree.

_Done when:_ a link to an AI asset chat opens that session, read-only until typed into,
from a cold load; a link to a goal opens it with its briefing, intents and plan rounds
read; a link to an attempt transcript opens it at `/t/<id>/attempts/<attemptId>`;
`?filter=uncovered` opens the estate filtered; the goal and the chat each update the
address bar when reached by clicking instead — the attempt does not, and cannot, for the
reason in decision 1.

### S4 — Back and forward

`popstate` applies the place. Resource navigation pushes, incidental state replaces.

_Done when:_ opening three targets and pressing Back three times walks back through them
without a page load; Back out of a goal lands on the goal list, not the previous target;
Forward returns; no history entry is created by opening a picker, switching theme, or
expanding the live dock.

### S5 — Links that outlive their resource

D5 alone. D6's held place shipped in S2; what is left is what a link does when the
resource it names is gone, and the surface it says so on.

_Done when:_ a path naming a deleted goal lands on that target's goal list and says the
goal is gone; a path naming an unknown target lands on the target list and says so rather
than tidying the address bar in silence, which is what S2 left it doing; a path naming a
chat session the importer no longer lists says so **on the page the link landed on** —
today `openImporterSession` writes that sentence to `agentSessionsNote`, the Agent sessions
screen's banner, which an operator arriving from a bookmark is not looking at.

## Decisions taken

**1. A transcript is `/t/<targetId>/attempts/<attemptId>`.** The resource is named, not
the rail it is reached through. I had leaned the other way, for the tidiness of every
second segment being a nav section; the operator chose the resource, and the resource is
the thing being linked to.

The consequence is worth writing down, because it is the one place the grammar is not
uniform: `attempts` is a **resource collection, not a nav section**. `parsePath` must know
the difference, and replaying `/t/x/attempts/<id>` sets `navItem` to `workers` while the
path never says so. Every other second segment is a section id. One exception, documented,
rather than a path that misnames what it points at.

**And this row is inbound only, which S1 established and I had wrong.** A transcript has no
page of its own. `TranscriptPanel` renders on the **Goals** section, and only for
`readableAttemptId` — the one attempt this tab started on this target, _"the only handle a
browser has on a settled attempt until Flow B lists them"_. So a link to an attempt opens
its transcript, but reading a transcript by clicking never produces that link, because
there is nowhere to click from. S3's criterion that every record "updates the address bar
when reached by clicking" cannot be met for attempts without building the Workers attempt
list, which is Flow B and not a routing slice.

Two alternatives were weighed and rejected. Deleting the case loses a grammar that is
already correct and will be needed. Reflecting the transcript from the Goals page, where it
actually renders, **breaks on a lifecycle bug**: `transcriptAttemptId` is cleared only by
`reset()`, so the URL would stick on `attempts/<id>` for the rest of the visit.

So: the path parses and replays, and the guard that emits it is
`navItem === "workers" && transcriptAttemptId !== ""`.

**Two claims in the paragraph above were wrong, and S3 found both.** They are corrected
here rather than quietly rewritten, because the way they were wrong is the useful part.

_"A link to an attempt opens its transcript"_ was not true when written. `applyPlace` set
the rail to Workers and read the transcript, but `TranscriptPanel` rendered only under
`{#if app.navItem === "goals"}` — so the link loaded a transcript into state that no screen
displayed, and the operator got "Workers · Placeholder content". S3 mounts the panel on
Workers too, with the attempt id passed in, so each section names the attempt it has. That
is one panel for the one attempt a URL named, not the Workers attempt list.

_"Unreachable today"_ was wrong in the other direction, and worse, because it described a
defect on `main` rather than a missing feature. `TranscriptPanel` has a "Read transcript"
button that sets `transcriptAttemptId`, and only `reset()` clears it — so reading a
transcript on Goals and then clicking Workers already satisfied the guard, and the address
bar already claimed `/t/<id>/attempts/<id>` over a placeholder page. The URL was lying
before anyone noticed it could. Mounting the panel on Workers is what makes that emission
truthful: the path is written exactly when an attempt's transcript is what is on screen.

What remains deferred is only that **nothing in the app produces such a link.** A worker row
in the Agent sessions list is the one place one could be offered, and S3 deliberately left
that row inert rather than let the list become half of the attempt list Flow B owns. So the
path works inbound, and reading a transcript reflects honestly; what is missing is somewhere
to click.

**2. The estate filter is addressable**, as `?filter=<all|in|out|uncovered>` on
`/t/<targetId>/assets/estate`. See D2 for why it is a query parameter and not a path
segment.

The estate's search text (`estateQuery`) stays out for now. It is not a principled
exclusion so much as an unproven one: free text is the kind of thing that reads as noise
in a bookmark until you have wanted it once. D2 leaves it a home — `&q=` — so adding it
later costs nothing and breaks no saved link.
