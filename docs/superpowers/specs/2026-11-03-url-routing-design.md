# Addressable resources: the URL as the app's place

**Status:** approved; decisions 1 and 2 taken by the operator on 2026-11-03
**Date:** 2026-11-03

## What this is for

One sentence, the operator's: *"I want to bookmark and share deeplinks with myself for
later review."* The example given is the one that stings today — there is no way to link
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
the comment says why: *"state is the source of truth and the URL follows it. Reading the
URL back on every change would mean two writers for one fact and a race between them on
every click."* It also already handles the hard case — a deep link arriving with no
session waits behind Connect and opens once there is one. This work generalises that; it
does not replace it.

**`App` is already shaped for replay.** Every way into a resource is a method that takes
an id and loads everything from it: `openTarget(id)`, `toSection(id)`,
`toAssetsTab(tab)`, `openGoal(goalId)`, `openImporter(sessionId?)`,
`loadTranscript(targetId, attemptId)`. A route handler does not need new data loading. It
needs to call the methods that are there, outermost first. `openTarget` resets `navItem`
to `"goals"`, so the order is not incidental.

**Paths 404 in development.** `curl /t/acme-corp` returns 404 against `bun run dev`. The
static fallback applies to the *built* app; SvelteKit's dev server still routes from
files. Path URLs therefore need a route file, which is the one piece of new plumbing here.

## The constraint to protect

`+page.svelte` says it keeps the URL out of `App` because *"`$app/navigation` is
SvelteKit's, and `App` is a plain class that a test or a second shell can construct
without a router."* That property is load-bearing: 455 web tests and 84 DOM tests mount
screens against a bare `new App()`. Nothing in this design may put a SvelteKit import
inside `App` or require a router to construct one.

## Design

### D1 — The URL is a projection of the place, and the place is a small part of the state

`App` has well over two hundred `$state` fields. Almost none of them belong in a URL. The
distinction this design draws:

- **Place** — which resource you are looking at. Target, section, tab, record id. Goes in
  the URL.
- **View** — how you have arranged your look at it. Filters, search text, which picker is
  open, scroll offset, whether the live dock is expanded. Stays out.

The test is the operator's own words: *for later review*. A link is worth saving when it
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
applyPlace(app: App, place: Place): void  // replay, by calling App's own open* methods
```

The shell keeps owning `goto` and `popstate`; `App` keeps knowing nothing about either.
`place.ts` is unit-testable without a router or a DOM, which is where the round-trip
property tests go.

### D4 — One-way, except on history navigation

The existing discipline holds: state writes the URL continuously, the URL is read only at
discrete moments. Those moments become two rather than one — at mount, and on `popstate`.
A `popstate` is a discrete event, not a continuous read, so it does not reintroduce the
race the current comment warns about.

This is also what makes Back work, which a deeplinking app is expected to do. The
granularity: **opening a resource pushes a history entry; everything else replaces.**
Opening three targets in a row leaves three entries, because you may want to go back
through them. Toggling a picker leaves none, because it is not in the URL at all.

### D5 — A link to something that is gone says so

A bookmark outlives the thing it names: a goal gets ended, a target gets removed, an
importer session falls out of the harness. `openRequested()` today drops an unknown target
*silently*, which is defensible for a stale tab and wrong for a bookmark — the operator
asked for something specific and deserves an answer.

The rule: **fall back to the nearest place that does exist, and say what was missing.**
A dead goal id lands on that target's goal list with "that goal no longer exists"; a dead
target lands on the target list with the same courtesy. Never a blank screen, never a
spinner that does not end, and never silence.

### D6 — A deep link that arrives signed out is held, not lost

`requestTarget` / `openRequested` already do this for a target id. They generalise to a
pending `Place`: parse at mount, hold it, replay the whole thing after Connect succeeds —
by either way in, a fresh sign-in or a resumed session, because a link should land in the
same place either way. This matters more than it sounds: the browser session registry is
in memory, so a server restart invalidates it, and a bookmark opened the next morning is
*the* common case rather than an edge one.

## The addressable inventory

| Place | Path |
| --- | --- |
| Target list | `/` |
| A target (lands on Goals) | `/t/<targetId>` |
| A section | `/t/<targetId>/<section>` |
| A goal | `/t/<targetId>/goals/<goalId>` |
| Assets, one tab | `/t/<targetId>/assets/estate` · `/t/<targetId>/assets/scope` |
| The estate, filtered | `/t/<targetId>/assets/estate?filter=uncovered` |
| **An AI asset chat** | `/t/<targetId>/assets/chat/<sessionId>` |
| An attempt transcript | `/t/<targetId>/attempts/<attemptId>` |
| Settings | `/t/<targetId>/settings` |

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

*Done when:* every row of the inventory round-trips `parsePath(pathOf(p)) === p`;
`parsePath` is total over garbage input (unknown section, missing id, trailing slash,
percent-encoding, an id with a slash in it, `attempts` with no id) and returns the nearest
valid place rather than throwing; an absent, misspelled or impossible `?filter` yields the
default view rather than an error; `placeOf(new App())` is the target list.

### S2 — The route, and the target link it replaces

Move `+page.svelte` under a catch-all route. Reflect `placeOf` into the path on every
change. Read the path at mount. Retire the `?target=` special case — and keep old links
working by translating `?target=<id>` into the path form once, on arrival.

*Done when:* `/t/<id>` and `/t/<id>/<section>` open that place from a cold load;
navigating by clicking updates the address bar; a reload holds the place; an existing
`?target=acme-corp` bookmark still lands on that target; the 455 + 84 web tests still
construct `App` without a router.

### S3 — Records by id

`openGoal`, `openImporter(sessionId)`, `loadTranscript` reachable from a path. This is the
slice that answers the original complaint.

*Done when:* a link to an AI asset chat opens that session, read-only until typed into,
from a cold load; a link to a goal opens it with its briefing, intents and plan rounds
read; a link to an attempt transcript opens it at `/t/<id>/attempts/<attemptId>`, with the
rail on Workers; `?filter=uncovered` opens the estate filtered; each of those updates the
address bar when reached by clicking instead.

### S4 — Back and forward

`popstate` applies the place. Resource navigation pushes, incidental state replaces.

*Done when:* opening three targets and pressing Back three times walks back through them
without a page load; Back out of a goal lands on the goal list, not the previous target;
Forward returns; no history entry is created by opening a picker, switching theme, or
expanding the live dock.

### S5 — Links that outlive their resource, and links that arrive early

D5 and D6: the nearest-valid-place fallback with a message, and the held place replayed
after Connect.

*Done when:* a path naming a deleted goal lands on that target's goal list and says the
goal is gone; a path naming an unknown target lands on the target list and says so; a deep
link opened with no browser session shows Connect, then lands on the full place — record
and all — after signing in; the same holds for a resumed session.

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

**2. The estate filter is addressable**, as `?filter=<all|in|out|uncovered>` on
`/t/<targetId>/assets/estate`. See D2 for why it is a query parameter and not a path
segment.

The estate's search text (`estateQuery`) stays out for now. It is not a principled
exclusion so much as an unproven one: free text is the kind of thing that reads as noise
in a bookmark until you have wanted it once. D2 leaves it a home — `&q=` — so adding it
later costs nothing and breaks no saved link.
