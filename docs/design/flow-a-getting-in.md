# Flow A — Getting in

Design brief for the first three screens of the Hunt Platform browser app.
Covers Days 1–3 of `sprint-roadmap.html`. Written 2026-10-21.

---

## 1. What you are designing

Hunt Platform is a control plane for autonomous security testing. A security
researcher points an AI agent at a target, the agent investigates it, and
everything it learns — assets, observations, findings, evidence — is recorded in
a graph that survives restarts and informs the next investigation.

It is a **local, single-operator tool**. One person runs it on their own machine,
against targets they are authorised to test. There is no multi-tenancy, no team,
no billing, no onboarding funnel. The user is technical, works in a terminal all
day, and will be looking at this app for hours at a stretch.

**Flow A is everything before a target is open**: the front door, the list of
targets, and the way a new target comes into being.

### Vocabulary

| Term        | Means                                                                    |
| ----------- | ------------------------------------------------------------------------ |
| **Target**  | A system under test. Owns a folder on disk and its own database.         |
| **Hunt**    | One investigation session against a target. Analogous to a chat session. |
| **Finding** | A qualified security result, supported by observations and evidence.     |
| **Server**  | The local backend process. The browser app connects to it over HTTP.     |

### Heritage

The interaction model follows **OpenCode's web app** — its connect screen, its
project/session home. We are borrowing that shape deliberately, and its design
tokens are reproduced in §6 below (OpenCode is MIT-licensed).

The navigation structure inside a target is modelled on **ScopeWeaver**, which
is AGPL-licensed and which you will not have access to. §3 therefore describes
the shell from scratch, in enough detail to design from. Nothing in §3 is
copied; it is a description of the shape we want, and you should feel free to
improve on it.

---

## 2. Scope

The app shell (§3), plus three screens and every state each one can be in.

|     | Screen         | Purpose                                                 |
| --- | -------------- | ------------------------------------------------------- |
| A1  | **Connect**    | Authenticate against the local server.                  |
| A2  | **Welcome**    | See every target, and recent hunts. Choose where to go. |
| A3  | **New target** | Turn a folder on disk into a target.                    |

The shell is in scope because these three screens sit inside it and it cannot be
designed retroactively. Its _pages_ are not: no screen from Flow B onwards is in
this brief.

---

## 3. The app shell

The shell is the persistent chrome around every screen in the product. Flow A
only uses part of it, but it has to be designed once, now, because Flows B
through G all live inside it. Design the whole frame; populate only Flow A.

### 3.1 Three levels of chrome

The app has exactly three shell states, and the user moves between them in one
direction:

**Level 0 — Disconnected.** No chrome at all. The Connect screen (A1) owns the
whole viewport. There is nothing to navigate to yet, so nothing navigational is
shown. A theme toggle is the only affordance outside the form.

**Level 1 — Connected, no target open.** The Welcome screen (A2). A slim
title bar across the top, and the two-column body described in §4. There is no
left navigation at this level: the target rail _is_ the navigation, and adding a
second nav beside it would be two lists competing for the same job.

**Level 2 — Inside a target.** The full shell: title bar, a persistent left
navigation for the open target, and a content region. This is where the user
spends essentially all of their time.

### 3.2 The title bar

A single slim row across the top, present at Levels 1 and 2. It carries:

- **Open targets as tabs**, left-aligned. Each tab shows the target's colour
  badge and name, truncating to roughly 180px. The active tab is distinguished
  by background rather than by a heavy border. A close affordance appears on
  hover and on the active tab. A **+** at the end of the strip returns to
  Welcome to pick or create another target.
- A **grid affordance** at the far left that returns to Welcome without closing
  anything.
- At the far right, **connection status**. Normally absent. When the connection
  drops it becomes a visible, non-blocking indicator — this app runs unattended
  for hours and a silently dead connection is the worst failure it has.

Keep this bar genuinely slim, around 36–40px. It is a wayfinding strip, not a
toolbar; actions belong in the content region.

### 3.3 The target navigation (Level 2)

A persistent left sidebar, roughly 220px, collapsible to an icon rail of about
56px. It is scoped entirely to the open target — nothing in it is global.

It has a header, two labelled groups, and a footer.

**Header** — the open target: its colour badge, name, and scope beneath in mono.
Clicking it opens a menu (switch target, reveal folder, target settings).

**Group one — Investigation.** What the user does.

| Item         | What it holds                                           |
| ------------ | ------------------------------------------------------- |
| Hunts        | Sessions against this target. The default landing item. |
| Findings     | Qualified results, with severity and status.            |
| Observations | Everything recorded, including negative results.        |
| Assets       | Hosts, endpoints and parameters discovered.             |
| Frontier     | What has not been tested yet, and why.                  |
| Traffic      | Flows captured from the proxy.                          |
| Evidence     | Preserved artefacts.                                    |
| Reports      | Generated documents, and whether they have gone stale.  |

**Group two — Operations.** How the machinery is behaving.

| Item          | What it holds                            |
| ------------- | ---------------------------------------- |
| Workers       | Who is working on what, right now.       |
| Blockers      | Everything stuck, and what it waits for. |
| Policy        | What is permitted, and what was refused. |
| Quota         | Provider usage windows and reset times.  |
| Notifications | Outbound delivery and its failures.      |
| Event log     | The raw append-only stream.              |

**Footer** — Settings, and the theme toggle.

Each item is an icon plus a label, with an optional trailing count. Counts are
quiet by default; **Blockers and Findings may carry an attention state** — a
small dot or a coloured count — because those are the two things the user wants
to be interrupted about. Nothing else in the sidebar is allowed to demand
attention, or the signal is worthless.

Design the sidebar item in all of: rest, hover, active, active-with-count,
attention, and collapsed-to-icon.

### 3.4 The content region

Everything right of the sidebar. A consistent page frame:

- A **page header**: title, an optional one-line description, and page actions
  right-aligned. It does not scroll away.
- An optional **filter row** beneath it for list pages.
- The **body**, which scrolls independently.
- An optional **detail panel** that slides in from the right at about 420px,
  for inspecting one row without losing the list. It animates its width rather
  than overlaying, so the list reflows instead of being hidden.

Most Level 2 pages are a list, a filter row and a detail panel. Design that
pattern once and the rest of the product follows from it.

### 3.5 Responsive behaviour

Above 1280px, everything is visible. Between 1024px and 1280px the sidebar
collapses to its icon rail by default and the detail panel overlays rather than
reflows. Below 1024px the sidebar becomes a drawer over a scrim. Below 768px is
out of scope — see §10.

### 3.6 What Flow A actually needs

For this round, design the shell frame and the Level 0 and Level 1 states. The
Level 2 sidebar should be designed as a component with its full item list, so we
can see it works at that length — but no Level 2 page content is required.

---

## 4. The screens

### A1 · Connect

The first thing the user sees on launch. Nothing else in the app is reachable
until this passes.

**Content**

- Wordmark, centred, ~160px wide.
- Heading and one line of supporting text.
- Two fields: **Server URL** (defaults to `http://localhost:4096`, pre-filled)
  and **Password**.
- Primary button: _Connect_.
- A hint line below the form explaining where the password comes from.
- A footer offering a copyable command for starting the server, shown in a
  bordered inline code block the user can select in one click.

**Layout**

Single centred column, `min(100%, 360px)`, vertically centred in the viewport.
Padding `48px / 24px / 32px / 24px`, respecting safe-area insets. Gap between
blocks `16px`; gap between form fields `20px`; label-to-input gap `8px`.
Inputs and the button are both `44px` tall and full width.

**States to design**

1. **Idle** — pre-filled URL, empty password, button enabled.
2. **Submitting** — button shows progress, fields are locked, no layout shift.
3. **Wrong password** — inline error beneath the password field in danger
   colour. The field keeps its value and takes focus. No session is issued.
4. **Server unreachable** — a different error, attached to the URL field, not
   the password field. This distinction matters: the user must be able to tell
   "I typed it wrong" from "the server isn't running." Offer the start command
   prominently here.
5. **Session expired** — the user arrives back here from inside the app. Show a
   quiet banner explaining why, with the URL already filled from last time.

**Behaviour**

- Enter submits from either field.
- Success navigates to A2. The session persists across reloads.
- The password is never echoed, logged, or placed in a URL.

---

### A2 · Welcome

The home screen. Reached after connecting, and returned to whenever the user
closes a target.

**Layout** — three regions, following OpenCode's home:

```
┌──────────────────────────────────────────────────────┐
│  tab bar (optional in v1)                            │
├──────────────────┬───────────────────────────────────┤
│                  │   ⌕ Search hunts in <target>      │
│  TARGETS         │                                   │
│   ▣ acme-corp    │   Today              + New hunt   │
│   ▣ internal-api │   ▸ Rate limit probe              │
│   ▣ scratch      │   ▸ Auth surface sweep            │
│                  │                                   │
│   ⚙ Settings     │   Earlier                         │
│   ? Help         │   ▸ Initial recon                 │
└──────────────────┴───────────────────────────────────┘
```

**Left rail — targets**

- Each row: a square badge (letter-derived, coloured from the fixed avatar
  palette in §6.4), the target name, and the folder path in muted text beneath
  or trailing.
- Last-activity timestamp, quiet.
- Hover reveals row actions (open folder, rename, remove) on the right, over a
  gradient that fades the label out beneath them. Resting state shows no action
  affordances at all.
- Selected row uses a raised layer background.
- A **+** at the top of the rail opens A3.

**Right column — hunts**

- A search field pinned at the top, scoped to the selected target.
- Hunts grouped by recency: _Today_, _Yesterday_, _Earlier_. Group labels are
  small, muted, uppercase-ish.
- Each row: a small badge marking its target, the hunt title, and a trailing
  relative timestamp.
- _New hunt_ action, top-right of the column.

**States to design**

1. **Populated** — several targets, hunts across two or three groups.
2. **First run** — no targets at all. This is the user's very first screen after
   connecting, so it has to teach without a tour: explain what a target is in one
   sentence and make "add your first target" the obvious move.
3. **Target with no hunts** — target selected, right column empty, _New hunt_
   elevated to the primary action.
4. **Unavailable target** — the folder has been moved or deleted. The row stays
   visible, dimmed, with an explanatory state. It must not silently disappear;
   a target vanishing from the list is indistinguishable from data loss.
5. **Search with no results** — distinct from "no hunts", and says which term failed.
6. **Reconnecting** — the server connection dropped. A non-blocking banner; the
   list stays readable rather than being replaced by a spinner.

---

### A3 · New target

A modal over A2. Turns a folder into a target: creates its database and runs its
migrations.

**Content**

- Title: _New target_.
- A path field, editable, pre-filled with the user's home directory.
- A browsable folder tree beneath it, scrolling, with disclosure arrows. Only
  folders — no files.
- The resolved path echoed beneath the tree.
- A target **name**, defaulting to the folder's own name.
- A **scope** field: the hosts or URL patterns this target covers.
- Footer: _Cancel_ (quiet) and _Create target_ (primary), right-aligned.

**States to design**

1. **Idle** — home directory listed, nothing chosen, primary action disabled.
2. **Folder selected** — name auto-filled, primary action enabled.
3. **Creating** — migrations are running. Brief, but it touches disk and can
   fail, so it needs a real state rather than an optimistic close.
4. **Migration failed** — the target was registered but its database could not be
   prepared. It appears in the rail as unavailable with a reason. Design the
   error so it reads as _this one target is unavailable_, not _the app is broken_
   — the other targets are unaffected, and that must be legible.
5. **Already a target** — the chosen folder is already registered. Offer to open
   it rather than refusing flatly.
6. **Permission denied** — the folder cannot be read.

**Behaviour**

- The folder tree is served by the backend. The browser never touches the
  filesystem, so every tree expansion is a round trip and needs a loading state.
- Escape cancels. The scrim is `--v2-overlay-simple-overlay-scrim`.

---

## 5. Principles

**Quiet by default.** The user will stare at this for hours. Colour carries
meaning — severity, state, danger — and is not decoration. Resting screens are
near-monochrome.

**Honest emptiness.** Every empty state answers _is this broken, or is there just
nothing here?_ An unavailable target, a failed migration and an empty list must
never look alike.

**Nothing vanishes.** Things that fail stay on screen with a reason. This is a
tool for recording what is true; the UI should not quietly drop what it cannot
show.

**Density without noise.** Close to terminal density. Earn whitespace through
hierarchy, not padding.

**Keyboard first.** Everything reachable by keyboard, visible focus rings
throughout, Enter and Escape behaving as expected.

---

## 6. Design tokens

Reproduced from OpenCode's `v2` token set (MIT). Dark is the primary theme; both
must work. Semantic tokens are what components reference — never a raw ramp value.

### 6.1 Semantic tokens

| Token                    | Dark        | Light       |
| ------------------------ | ----------- | ----------- |
| `background-bg-base`     | `#242424`   | `#ffffff`   |
| `background-bg-deep`     | `#161616`   | `#fafafa`   |
| `background-bg-layer-01` | `#2e2e2e`   | `#fafafa`   |
| `background-bg-layer-02` | `#3a3a3a`   | `#f2f2f2`   |
| `background-bg-layer-03` | `#5c5c5c`   | `#eeeeee`   |
| `background-bg-inverse`  | `#fafafa`   | `#161616`   |
| `background-bg-accent`   | `#3b5cf6`   | `#3b5cf6`   |
| `text-text-base`         | `#f2f2f2`   | `#161616`   |
| `text-text-muted`        | `#aeaeae`   | `#5c5c5c`   |
| `text-text-faint`        | `#808080`   | `#808080`   |
| `text-text-accent`       | `#a2bcff`   | `#3b5cf6`   |
| `icon-icon-base`         | `#dbdbdb`   | `#3a3a3a`   |
| `icon-icon-muted`        | `#808080`   | `#808080`   |
| `icon-icon-faint`        | `#5c5c5c`   | `#aeaeae`   |
| `border-border-muted`    | `#ffffff14` | `#00000014` |
| `border-border-base`     | `#ffffff1a` | `#0000001a` |
| `border-border-strong`   | `#ffffff33` | `#00000033` |
| `border-border-focus`    | `#7698fd`   | `#7698fd`   |

### 6.2 State tokens

| Token                                | Dark                              | Light                               |
| ------------------------------------ | --------------------------------- | ----------------------------------- |
| `state-bg-success` / `fg` / `border` | `#14361d` / `#6bd586` / `#1d783c` | `#e7f9ea` / `#198b43` / `#b8e9c1`   |
| `state-bg-warning` / `fg` / `border` | `#4b4025` / `#f2cf76` / `#ac8833` | `#fefaec` / `#cb9f34` / `#f7e5b5`   |
| `state-bg-danger` / `fg` / `border`  | `#461516` / `#f17471` / `#97252b` | `#fcecebff` / `#b82d35` / `#f2bbb7` |
| `state-bg-info` / `fg` / `border`    | `#021945` / `#7698fd` / `#2c47c8` | `#ecf1fe` / `#3250df` / `#c3d4fd`   |

Connect errors use **danger**. An unavailable target uses **warning**, not
danger — the folder being gone is a condition to resolve, not a failure.

### 6.3 Overlays

| Token             | Dark        | Light       |
| ----------------- | ----------- | ----------- |
| `overlay-hover`   | `#ffffff0f` | `#0000000a` |
| `overlay-pressed` | `#ffffff1a` | `#00000014` |
| `overlay-scrim`   | `#ffffff4d` | `#00000066` |

### 6.4 Target badge palette

Theme-independent. Assign deterministically from the target name so a target
keeps its colour forever. Foreground is always `#ffffff`.

| Name   | Fill      | Border    |
| ------ | --------- | --------- |
| orange | `#ee7330` | `#d16427` |
| yellow | `#e7af36` | `#cb9f34` |
| cyan   | `#0096b8` | `#007d9b` |
| green  | `#2eaf5a` | `#198b43` |
| red    | `#d92e3c` | `#b82d35` |
| pink   | `#e4429e` | `#c83d8b` |
| blue   | `#3250df` | `#2c47c8` |
| purple | `#623be2` | `#5230c2` |
| gray   | `#5c5c5c` | `#3a3a3a` |

### 6.5 Typography

- **Sans:** Inter (variable, 100–900). UI text.
- **Mono:** IBM Plex Mono (weight 440) for paths, hosts, commands and IDs.
  Folder paths are always mono — they are data, not prose.

| Role          | Size / line-height / weight                             |
| ------------- | ------------------------------------------------------- |
| Screen title  | 20 / 28 / 530                                           |
| Section label | 11–12 / 16 / 600, muted                                 |
| Body          | 13 / 20 / 400                                           |
| Label         | 13 / 16 / 530                                           |
| Input text    | 16 / 24 / 400 — 16px minimum, to stop iOS zoom on focus |
| Hint / meta   | 12 / 16 / 400, muted                                    |

Line-height tokens: `tight: 12px`, `compact: 16px`, `base: 20px`.

### 6.6 Radius, elevation, spacing

Radius: `xs 2px · sm 4px · md 6px · lg 8px · xl 10px`. Inputs and buttons `md`.
Cards and the modal `lg`–`xl`. Badges `sm`.

Elevation — three levels only:

- **raised** — `0 2px 4px #0000000a, 0 1px 2px -1px #00000014, 0 0 0 .5px #0000001f`
- **floating** — `0 8px 16px #0000000a, 0 4px 8px #00000014, 0 0 0 .5px #0000001f`
- **overlay** — `0 16px 32px #0000000a, 0 8px 16px #00000014, 0 0 0 .5px #0000001f`

Rows and rails are flat; depth comes from layer backgrounds, not shadow. The
modal is **overlay**; menus are **floating**.

Spacing: 4px base. `4 · 8 · 12 · 16 · 20 · 24 · 32 · 48`.
Touch targets never below 44px.

---

## 7. Component inventory

Flow A needs these, and they must be reusable — Flows B through G are built on them.

| Component            | Variants and states                                                      |
| -------------------- | ------------------------------------------------------------------------ |
| Text input           | default, focus, error, disabled, with leading icon                       |
| Password input       | plus reveal toggle                                                       |
| Button               | primary, neutral, quiet, danger · default/hover/pressed/loading/disabled |
| Target badge         | 24px and 16px, nine colours                                              |
| List row             | rest, hover with revealed actions, selected, dimmed, unavailable         |
| Section header       | label plus optional trailing action                                      |
| Search field         | empty, typing, no-results                                                |
| Modal                | title, body, footer actions, scrim                                       |
| Folder tree node     | collapsed, expanded, loading, permission-denied                          |
| Inline error         | field-attached and block-level                                           |
| Banner               | info, warning, reconnecting — dismissible and persistent                 |
| Empty state          | icon, one line, one action                                               |
| Inline code block    | one-click selectable                                                     |
| Target tab           | active, inactive, hover with close, overflow truncation                  |
| Sidebar item         | rest, hover, active, with count, attention, collapsed icon               |
| Sidebar group label  | with collapse affordance                                                 |
| Page header          | title, description, actions                                              |
| Detail panel         | opening, open, closing                                                   |
| Connection indicator | healthy (absent), reconnecting, disconnected                             |

---

## 8. Motion

Fast and few. `240ms cubic-bezier(0.22, 1, 0.36, 1)` for panels and the modal;
`160–200ms ease-out` for fades; hover transitions `120ms`. Row hover actions
appear without layout shift — they fade in over a gradient, they do not push
content. Honour `prefers-reduced-motion` by dropping to opacity-only.

---

## 9. Accessibility

- Visible focus ring on every interactive element, `border-border-focus`, 2px,
  offset 2px, never removed on mouse input.
- Body text meets 4.5:1; large text and icons 3:1. Check `text-text-faint` on
  `background-bg-layer-01` in both themes — it is the pairing most likely to fail.
- State is never colour alone: unavailable targets carry an icon and a label.
- Full keyboard path through all three screens, including the folder tree
  (arrow keys expand and collapse).
- The modal traps focus and restores it to the trigger on close.
- Errors are announced, not just rendered.
- The shell needs a skip link past the navigation, an accessible name on the
  collapsed icon rail, and tabs that behave as tabs for a screen reader.
- The connection indicator announces a drop. A user who has walked away still
  needs to learn the session died.

---

## 10. Out of scope

The _contents_ of any Level 2 page — hunt transcripts, finding lists, evidence,
reports, worker lanes. Settings beyond a stub. Mobile layouts below 768px.
Onboarding tours. Flow A is the shell frame and three screens.

---

## 11. What to deliver

1. The shell frame at all three levels from §3, in both themes, at 1440px and
   1024px.
2. The three screens from §4 in both themes, at the same two widths.
3. Every state listed in §4 — the error and empty states matter more here than
   the happy path, because they carry the product's honesty principle.
4. The §7 components as a reusable set, built on the §6 tokens. The sidebar item
   and target tab should be shown populated with the full §3.3 item list, so we
   can see the navigation works at that length.
5. The tokens as a usable file, named exactly as in §6 so the build can consume
   them directly.
6. A short note on anything in this brief you think is wrong. §3 in particular
   is a description of intent, not a specification — if the two-group navigation
   is the wrong shape for fourteen items, say so.
