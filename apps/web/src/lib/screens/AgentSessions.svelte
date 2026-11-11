<script lang="ts">
  /**
   * Every agent session on this target, wherever in the app it lives: "what is running right
   * now, what is waiting on me, and what ran before" (A7 E1, E2, E5).
   *
   * ## The list only finds sessions; it never hosts them
   *
   * One row per session: its name and where it lives, as a breadcrumb with that section's
   * rail icon; a second line of what it is doing, what it is waiting on, or how it ended;
   * the agent, the model and its last activity. **No detail pane** — the screens that show a
   * session properly are the surfaces' own (the goal page, Auto-load), and this page's job
   * is to get you to them. Opening a row goes there.
   *
   * ## Grouped, filtered, paged — by the server
   *
   * A7 replaced this page's old "no grouping, no filters" rule. **Active** is grouped by what
   * each session needs from you — Needs you, Running, Idle — and comes in one piece; it is
   * what is running now and is never long. **Ended** is grouped by day and paged, 25 rows by
   * default (25, 50, 100); a day keeps its full count on every page and repeats its label
   * where it runs on. **All** is both. The tabs' counts never move with a filter. The
   * **Needs you** toggle narrows whichever tab is on, and a quiet line under the list says
   * what it hides; it is dimmed on Ended, where nothing can be waiting. The agent and text
   * filters narrow the tab. All of it is the server's (`pageAgentSessions`), so a page is
   * the same page whoever asks, and the browser never holds more than one.
   *
   * **Needs you is empty until A7-Q** (the question dock), which supplies a session's
   * pending question as `waiting`; the group, the toggle, the hidden line and the rail's
   * warning count already turn on it.
   *
   * ## Live, without asking a harness
   *
   * The second line comes from the server's summary of what each session narrated (last
   * tool, how many calls, the line it is writing), and the page reads the list again while
   * this target's sessions narrate — a few seconds after their frames settle
   * (`App.#agentSessionsStale`). Nothing here, or on the server for it, asks a harness.
   *
   * ## A row is a link
   *
   * The destination of a row is an **address**: "the importer, on this session" is
   * `/t/<targetId>/assets/chat/<sessionId>`; a goal's conversation or its planner is
   * `/t/<targetId>/goals/<goalId>` — the grammar in `lib/place.ts`, which `placeOfSession`
   * turns a row into. So a row is an `<a href>`: copyable, middle-clickable, openable in a
   * second tab, and Enter opens it. The ordinary click is handled here rather than followed
   * by the browser, because following the href would reload the document and throw the
   * running app away; `routedInApp` decides which clicks belong to the app.
   *
   * A worker row still has no destination — see `placeOfSession` — so it stays inert markup
   * rather than a link to a section that cannot show an attempt.
   *
   * A session whose harness this server no longer runs is **marked, not hidden**. A surface
   * that is gone is struck through and the row still opens. V2(chat): nothing in this build
   * deletes a surface — a goal cannot be deleted, and `goal_sessions` references its goal —
   * so the server never sets `surface.gone`; when deleting arrives, a gone goal's row should
   * open its transcript on its own rather than the goal page.
   */
  import {
    AGENT_SESSION_AGENT_LABEL,
    AGENT_SESSION_PAGE_SIZES,
    AGENT_SESSION_SECTION_LABEL,
    AgentSessionKind,
    type AgentSessionView,
  } from "@bit/contracts";

  import {
    doingLine,
    groupLabel,
    harnessOf,
    hiddenLine,
    lastActivityLabel,
    pagerPages,
    placeOfSession,
    rangeLabel,
    sessionName,
    stateTitle,
  } from "../agentSessions";
  import type { App } from "../app.svelte";
  import Banner from "../components/Banner.svelte";
  import Button from "../components/Button.svelte";
  import PageFrame from "../components/PageFrame.svelte";
  import {
    IconAngleDown,
    IconAngleRight,
    IconClose,
    IconCube,
    IconDownload,
    IconGoal,
    IconList,
    IconRobot,
    IconSearch,
    IconUser,
  } from "../icons";
  import { isolated } from "../conversationChat";
  import { modelNameIn } from "../modelNames";
  import { applyPlace, pathOf, type Place } from "../place";
  import { routedInApp } from "../placeLink";

  let { app }: { app: App } = $props();

  // The rows are this target's, or nothing: the list is dropped when the target changes, but
  // a render can land between the switch and that drop.
  let mine = $derived(app.agentSessionsTargetId === app.viewTargetId);
  let rows = $derived(mine ? app.agentSessions : []);
  let page = $derived(mine ? app.agentSessionsPage : undefined);
  let query = $derived(app.agentSessionsQuery);
  // Read again with every answer, so "12 min" moves on as the list refreshes.
  let now = $derived.by(() => {
    void rows;
    return Date.now();
  });

  const AGENT_ICON = {
    goal: IconGoal,
    importer: IconDownload,
    worker: IconUser,
    planner: IconList,
  } as const;
  const SECTION_ICON = {
    goals: IconGoal,
    assets: IconCube,
    workers: IconUser,
  } as const;
  const KINDS = AgentSessionKind.literals;

  /**
   * This page's rows by group, in order, each group with its full count. A group is a
   * heading and a list of its own, so a screen reader counts a list's rows and nothing else
   * (A7 U8b review): a header inside the row list was announced as one more row.
   */
  let sections = $derived.by(() => {
    const out: {
      key: string;
      count: number;
      rows: AgentSessionView[];
    }[] = [];
    for (const session of rows) {
      const last = out.at(-1);
      if (last !== undefined && last.key === session.group) {
        last.rows.push(session);
      } else {
        out.push({
          key: session.group,
          count:
            page?.groups.find((each) => each.key === session.group)?.count ?? 0,
          rows: [session],
        });
      }
    }
    return out;
  });

  const TABS = [
    ["active", "Active"],
    ["ended", "Ended"],
    ["all", "All"],
  ] as const;
  let tabButtons: HTMLButtonElement[] = $state([]);
  /**
   * The WAI-ARIA tabs pattern: one tab in the Tab order (the selected one), arrows move
   * between tabs and select as they go, Home and End go to the ends.
   */
  const onTabKey = (event: KeyboardEvent, index: number) => {
    const to =
      event.key === "ArrowRight"
        ? (index + 1) % TABS.length
        : event.key === "ArrowLeft"
          ? (index - 1 + TABS.length) % TABS.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? TABS.length - 1
              : undefined;
    if (to === undefined) return;
    event.preventDefault();
    const tab = TABS[to];
    if (tab === undefined) return;
    tabButtons[to]?.focus();
    app.setAgentSessionsQuery({ tab: tab[0] });
  };
  let pages = $derived(
    page === undefined
      ? 1
      : Math.max(1, Math.ceil(page.total / Math.max(1, page.pageSize))),
  );
  let hidden = $derived(
    page === undefined ? null : hiddenLine(page.hidden, query.tab),
  );
  let filtered = $derived(query.agent !== undefined || query.q.trim() !== "");

  /** The text filter as typed; applied once typing pauses, or at once on Enter. */
  // Writable: what was typed, until a query applied elsewhere (a cleared filter, another
  // target) replaces it with what the box should show.
  let typed = $derived(app.agentSessionsQuery.q);
  let cancelTyping: (() => void) | undefined;
  const applyText = (value: string) => {
    cancelTyping?.();
    cancelTyping = undefined;
    if (value.trim() !== app.agentSessionsQuery.q.trim()) {
      app.setAgentSessionsQuery({ q: value });
    }
  };
  const onType = (value: string) => {
    typed = value;
    cancelTyping?.();
    cancelTyping = app.countdown.after(300, () => {
      cancelTyping = undefined;
      applyText(value);
    });
  };

  /**
   * Follows a row's link in this tab, for the clicks that are this app's to follow.
   *
   * A click the browser has its own meaning for — a new tab, a new window, a download — is
   * left alone with its href intact, and lands through the cold-load path a bookmark takes.
   */
  const follow = (place: Place, event: MouseEvent) => {
    if (!routedInApp(event)) return;
    event.preventDefault();
    void applyPlace(app, place);
  };
</script>

{#snippet content(session: AgentSessionView, linked: boolean)}
  {@const harness = harnessOf(session, app.harnesses, app.harnessesLoaded)}
  {@const line = doingLine(session)}
  {@const SectionGlyph = SECTION_ICON[session.surface.section]}
  {@const AgentGlyph = AGENT_ICON[session.kind]}
  {@const live = session.state === "live"}
  <span
    class={[
      "mark",
      // Prefixed: an outcome is also a word this page styles elsewhere (`.empty`).
      `is-${live ? (session.waiting !== null ? "waiting" : session.group) : (session.outcome ?? "dormant")}`,
    ]}
    data-mark={live ? session.group : (session.outcome ?? "dormant")}
    aria-hidden="true"
  >
    {#if live}
      <span class="dot"></span>
    {:else if session.outcome === "failed"}
      <IconClose width="11" height="11" />
    {:else if session.outcome === "stopped"}
      <span class="square"></span>
    {:else if session.outcome === "empty"}
      <span class="dash"></span>
    {:else if session.outcome === "unknown"}
      <!-- Not known is not failure: outlined and neutral, never the danger colour. -->
      <span class="unknown">?</span>
    {:else if session.outcome === "completed"}
      <span class="check">✓</span>
    {:else}
      <!-- Not running, not ended: the idle ring, since a message carries it on. -->
      <span class="dot"></span>
    {/if}
  </span>
  <span class="main">
    <span class="line1">
      <!-- The name is agent text (a harness title, a goal, a worker's question): its own
           isolate, so a bidi control in it cannot reorder the breadcrumb beside it. -->
      <span class="name" title={isolated(sessionName(session))}
        >{sessionName(session)}</span
      >
      <span class="divider" aria-hidden="true"></span>
      <span
        class={["crumb", session.surface.gone && "gone"]}
        title={session.surface.gone
          ? "This place no longer exists; the session still opens."
          : undefined}
      >
        <span class="crumb-glyph"><SectionGlyph width="12" height="12" /></span>
        <span class="crumb-section"
          >{AGENT_SESSION_SECTION_LABEL[session.surface.section]}</span
        >
        <span class="crumb-sep" aria-hidden="true"
          ><IconAngleRight width="9" height="9" /></span
        >
        <span class="crumb-place">{session.surface.place}</span>
      </span>
      {#if harness.strandedOn !== undefined}
        <!-- Marked, not hidden: the harness this was minted on is not one this server runs,
             so nothing here can act on the session, though it may be alive there. -->
        <span
          class="stranded"
          title="This server does not run the harness instance this session was opened on, so it cannot be asked about it. It may still be alive there."
          >Harness “{harness.strandedOn}” is no longer configured</span
        >
      {/if}
    </span>
    <span class={["line2", line.tone]} title={stateTitle(session)}
      >{#each line.parts as part, index (index)}{part.before}{#if part.agent}<span
            class="said">{part.text}</span
          >{:else}{part.text}{/if}{/each}</span
    >
  </span>
  <span class="agent">
    <span class="agent-glyph"><AgentGlyph width="13" height="13" /></span>
    {AGENT_SESSION_AGENT_LABEL[session.kind]}
  </span>
  <span class="model mono" title={session.model ?? "model not recorded"}
    >{session.model === null
      ? "—"
      : modelNameIn(
          app.harnesses,
          { instanceId: session.harnessInstanceId },
          session.model,
        )}</span
  >
  <span class="when mono">
    <span class="time"
      >{lastActivityLabel(session.lastActivityAt, now, live)}</span
    >
    {#if linked}<span class="open" aria-hidden="true">Open ↗</span>{/if}
  </span>
{/snippet}

<PageFrame
  title="Agent sessions"
  description="Every conversation an agent is having on this target, wherever in the app it lives. Opening one takes you to that place — the list only finds sessions, it never hosts them."
  centered={app.drawerHidden}
>
  {#snippet filters()}
    <div class="toolbar">
      <div class="tabs" role="tablist" aria-label="Which sessions">
        {#each TABS as [tab, label], index (tab)}
          <button
            bind:this={tabButtons[index]}
            role="tab"
            id="agent-sessions-tab-{tab}"
            aria-selected={query.tab === tab}
            aria-controls="agent-sessions-panel"
            tabindex={query.tab === tab ? 0 : -1}
            class={["tab", query.tab === tab && "on"]}
            onclick={() => app.setAgentSessionsQuery({ tab })}
            onkeydown={(event) => onTabKey(event, index)}
          >
            {label}
            <span class="tab-count">{page?.counts[tab] ?? ""}</span>
          </button>
        {/each}
      </div>
      <span class="rule" aria-hidden="true"></span>
      <!-- Dimmed on Ended, where nothing can be waiting; still says how many are. -->
      <button
        class={["needs", query.needsYou && "on"]}
        aria-pressed={query.needsYou}
        disabled={query.tab === "ended" && !query.needsYou}
        title={query.tab === "ended"
          ? "An ended session cannot be waiting on you."
          : undefined}
        onclick={() => app.setAgentSessionsQuery({ needsYou: !query.needsYou })}
      >
        <span class="needs-dot" aria-hidden="true"></span>
        Needs you
        <span class="needs-count">{page?.counts.needsYou ?? 0}</span>
        {#if query.needsYou}<span class="needs-x" aria-hidden="true"
            ><IconClose width="9" height="9" /></span
          >{/if}
      </button>
      <label class="agent-filter">
        <span class="visually-hidden">Agent</span>
        <select
          value={query.agent ?? ""}
          onchange={(event) => {
            const value = event.currentTarget.value;
            app.setAgentSessionsQuery({
              agent: KINDS.find((kind) => kind === value),
            });
          }}
        >
          <option value="">Every agent</option>
          {#each KINDS as kind (kind)}
            <option value={kind}>{AGENT_SESSION_AGENT_LABEL[kind]}</option>
          {/each}
        </select>
        <span class="select-caret" aria-hidden="true"
          ><IconAngleDown width="10" height="10" /></span
        >
      </label>
      <form
        class="search"
        role="search"
        onsubmit={(event) => {
          event.preventDefault();
          applyText(typed);
        }}
      >
        <span class="search-glyph" aria-hidden="true"
          ><IconSearch width="12" height="12" /></span
        >
        <input
          type="search"
          aria-label="Filter by name or surface"
          placeholder="Filter by name or surface"
          value={typed}
          oninput={(event) => onType(event.currentTarget.value)}
        />
      </form>
    </div>
  {/snippet}

  {#snippet body()}
    <div
      class="panel"
      role="tabpanel"
      id="agent-sessions-panel"
      aria-labelledby="agent-sessions-tab-{query.tab}"
    >
      {#if app.agentSessionsState === "failed" && rows.length === 0}
        <div class="notice">
          <Banner tone="danger">{app.agentSessionsDetail}</Banner>
          <Button onclick={() => void app.loadAgentSessions(app.viewTargetId)}>
            Try again
          </Button>
        </div>
      {:else if page === undefined}
        <p class="quiet" role="status">Reading this target's agent sessions…</p>
      {:else if page.counts.all === 0}
        <div class="empty">
          <IconRobot width="28" height="28" />
          <p class="empty-lead">No agent sessions on this target yet.</p>
          <p class="empty-more">
            A session appears here once a goal conversation is opened, a scope
            import runs, a goal is planned, or a worker attempt starts on its
            harness.
          </p>
        </div>
      {:else}
        <!--
        No banner of its own. A row whose session has gone is answered by the shell's
        arrival banner, which is on this page and on every other page such a link can land
        on; see `App.arrivalNote`.
      -->
        <div class="table" role="presentation">
          <div class="head" aria-hidden="true">
            <span class="h-session">Session · where it lives</span>
            <span>Agent</span>
            <span>Model</span>
            <span class="h-when">Last activity</span>
          </div>
          <div class="rows">
            {#each sections as section (section.key)}
              <section
                class="group-block"
                aria-labelledby="agent-sessions-group-{section.key}"
              >
                <h3
                  class="group"
                  id="agent-sessions-group-{section.key}"
                  data-group={section.key}
                >
                  <span class="group-label">{groupLabel(section.key, now)}</span
                  >
                  <span class="group-count">{section.count}</span>
                </h3>
                <ul
                  class="group-rows"
                  aria-labelledby="agent-sessions-group-{section.key}"
                >
                  {#each section.rows as session (session.key)}
                    {@const place = placeOfSession(session, app.viewTargetId)}
                    <li class="row-item" data-key={session.key}>
                      {#if place !== null}
                        <!--
                  A real href, so the operator can copy it, middle-click it, or open it beside
                  what they are reading. The handler is what keeps an ordinary click from
                  reloading the document; see `routedInApp`.
                -->
                        <a
                          class={[
                            "row",
                            "go",
                            session.waiting !== null && "waiting",
                          ]}
                          href={pathOf(place)}
                          onclick={(event) => follow(place, event)}
                        >
                          {@render content(session, true)}
                        </a>
                      {:else}
                        <!-- Inert: there is no screen for a worker attempt to open yet. -->
                        <div class="row">{@render content(session, false)}</div>
                      {/if}
                    </li>
                  {/each}
                </ul>
              </section>
            {/each}
          </div>
          {#if rows.length === 0}
            <p class="quiet none" role="status">
              {#if query.needsYou}
                Nothing in {query.tab === "all"
                  ? "these sessions"
                  : `${query.tab} sessions`}
                is waiting on you.
              {:else if filtered}
                No {query.tab === "all" ? "" : `${query.tab} `}session matches
                these filters.
              {:else if query.tab === "active"}
                Nothing is running on this target right now.
              {:else}
                No session on this target has ended yet.
              {/if}
            </p>
          {/if}
          {#if hidden !== null}
            <p class="hidden-line" role="status">
              {hidden}
              <button
                class="link"
                onclick={() => app.setAgentSessionsQuery({ needsYou: false })}
                >Clear the filter</button
              >
            </p>
          {/if}
          {#if app.agentSessionsWorkersOmitted > 0}
            <p class="quiet-small" role="status">
              {app.agentSessionsWorkersOmitted} older worker {app.agentSessionsWorkersOmitted ===
              1
                ? "session is"
                : "sessions are"} not counted here. Worker attempts accumulate with
              every intent, so the list reads the newest.
            </p>
          {/if}
        </div>
        <footer class="pager">
          <span class="range mono"
            >{rangeLabel(page, rows.length, query.needsYou)}</span
          >
          {#if query.tab !== "active"}
            <span class="pager-right">
              <label class="per-page">
                Rows per page
                <select
                  aria-label="Rows per page"
                  value={String(query.pageSize)}
                  onchange={(event) => {
                    const size = Number(event.currentTarget.value);
                    const chosen = AGENT_SESSION_PAGE_SIZES.find(
                      (each) => each === size,
                    );
                    if (chosen !== undefined)
                      app.setAgentSessionsQuery({ pageSize: chosen });
                  }}
                >
                  {#each AGENT_SESSION_PAGE_SIZES as size (size)}
                    <option value={String(size)}>{size}</option>
                  {/each}
                </select>
              </label>
              <nav class="pages" aria-label="Pages">
                <button
                  class="page-step"
                  aria-label="Previous page"
                  disabled={page.page <= 1}
                  onclick={() =>
                    app.setAgentSessionsQuery({ page: page.page - 1 })}
                  >‹</button
                >
                {#each pagerPages(page.page, pages) as number, index (index)}
                  {#if number === null}
                    <span class="gap" aria-hidden="true">…</span>
                  {:else}
                    <button
                      class={["page-number", number === page.page && "on"]}
                      aria-current={number === page.page ? "page" : undefined}
                      aria-label="Page {number}"
                      onclick={() =>
                        app.setAgentSessionsQuery({ page: number })}
                      >{number}</button
                    >
                  {/if}
                {/each}
                <button
                  class="page-step"
                  aria-label="Next page"
                  disabled={page.page >= pages}
                  onclick={() =>
                    app.setAgentSessionsQuery({ page: page.page + 1 })}
                  >›</button
                >
              </nav>
            </span>
          {/if}
        </footer>
      {/if}
    </div>
  {/snippet}
</PageFrame>

<style>
  /* ── Toolbar ──────────────────────────────────────────────────────────────── */
  .toolbar {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .tabs {
    display: flex;
    align-items: center;
    gap: 2px;
    margin-left: -4px;
    padding: 3px;
    border: 1px solid var(--border-muted);
    border-radius: var(--radius-md);
    background: var(--bg-deep);
  }
  .tab {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    padding: 5px 11px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    font: 400 12px/16px var(--font-sans);
    cursor: pointer;
    transition: background var(--dur-hover) ease-out;
  }
  .tab:hover {
    background: var(--overlay-hover);
  }
  .tab.on {
    background: var(--bg-layer-02);
    color: var(--text-base);
    font-weight: 500;
  }
  .tab-count {
    color: var(--text-faint);
    font: 400 11px/16px var(--font-mono);
    font-variant-numeric: tabular-nums;
  }
  .rule {
    width: 1px;
    height: 20px;
    background: var(--border-muted);
  }
  .needs,
  .agent-filter select,
  .search {
    height: 32px;
    border: 1px solid var(--border-muted);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-muted);
    font: 400 12px/16px var(--font-sans);
  }
  .needs {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 0 11px;
    cursor: pointer;
    transition: background var(--dur-hover) ease-out;
  }
  .needs:hover:not(:disabled) {
    background: var(--overlay-hover);
  }
  .needs:disabled {
    cursor: default;
    opacity: 0.45;
  }
  .needs-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--state-fg-warning);
  }
  .needs-count {
    color: var(--state-fg-warning);
    font: 500 11px/16px var(--font-mono);
  }
  /* On: the warning fill, cleared with its × (A7 E2). */
  .needs.on {
    border-color: var(--state-border-warning);
    background: var(--state-bg-warning);
    color: var(--state-fg-warning);
  }
  .needs-x {
    display: inline-flex;
  }
  .agent-filter {
    position: relative;
    display: inline-flex;
  }
  .agent-filter select {
    appearance: none;
    padding: 0 28px 0 11px;
    cursor: pointer;
  }
  .select-caret {
    position: absolute;
    top: 50%;
    right: 10px;
    display: inline-flex;
    transform: translateY(-50%);
    color: var(--icon-muted);
    pointer-events: none;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 240px;
    margin-left: auto;
    padding: 0 10px;
  }
  .search-glyph {
    display: inline-flex;
    color: var(--icon-muted);
  }
  .search input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--text-base);
    font: inherit;
    outline: none;
  }
  .search:focus-within {
    border-color: var(--border-strong);
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  /* ── The table ────────────────────────────────────────────────────────────── */
  .table {
    --cols: 20px minmax(0, 1fr) 112px 124px 76px;
    display: flex;
    flex-direction: column;
  }
  .head {
    display: grid;
    grid-template-columns: var(--cols);
    gap: 12px;
    align-items: end;
    padding: 0 12px 8px;
    border-bottom: 1px solid var(--border-muted);
    color: var(--text-faint);
    font: 600 10px/14px var(--font-sans);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .h-session {
    grid-column: 1 / 3;
  }
  .h-when {
    text-align: right;
  }
  .rows,
  .group-rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .group {
    margin: 0;
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 18px 12px 8px;
    color: var(--text-faint);
    font: 600 10px/14px var(--font-sans);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .group-count {
    font: 400 11px/14px var(--font-mono);
    letter-spacing: 0;
  }
  .row {
    display: grid;
    grid-template-columns: var(--cols);
    gap: 12px;
    align-items: center;
    width: 100%;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border-muted);
    color: var(--text-base);
    font: 400 13px/18px var(--font-sans);
    text-decoration: none;
    box-sizing: border-box;
  }
  .row.go {
    cursor: pointer;
    transition: background var(--dur-hover) ease-out;
  }
  .row.go:hover,
  .row.go:focus-visible {
    background: var(--overlay-hover);
  }
  .mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    align-self: start;
    height: 18px;
    color: var(--icon-muted);
  }
  .mark .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text-base);
  }
  .mark.is-idle .dot {
    background: transparent;
    box-shadow: inset 0 0 0 1.5px var(--icon-muted);
  }
  .mark.is-waiting .dot {
    background: var(--state-fg-warning);
  }
  /* Failure is the only outcome in colour (A7 E5). */
  .mark.is-failed {
    color: var(--state-fg-danger);
  }
  .mark .square {
    width: 7px;
    height: 7px;
    border: 1.5px solid var(--icon-muted);
    border-radius: 1px;
  }
  .mark .dash {
    width: 8px;
    height: 1.5px;
    background: var(--icon-muted);
  }
  .mark .check {
    font-size: 11px;
    line-height: 1;
  }
  /* Outcome not known: an outlined "?", neutral like the other marks (A7 U8b review). */
  .mark .unknown {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 11px;
    height: 11px;
    border: 1.2px solid var(--icon-muted);
    border-radius: 50%;
    font: 600 8px/1 var(--font-sans);
    box-sizing: border-box;
  }
  /* Not running and not ended (dormant): the idle ring. */
  .mark.is-dormant .dot {
    background: transparent;
    box-shadow: inset 0 0 0 1.5px var(--icon-muted);
  }
  .main {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .line1 {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  /*
   * The name keeps its room; the breadcrumb gives way first, its place cut short. Capped, so
   * a long name (a worker's question) is cut before the breadcrumb is: where it lives must
   * always show (A7 U8b review: it shrank to 0 px).
   */
  .name {
    flex: 0 1 auto;
    min-width: 12ch;
    max-width: 60%;
    overflow: hidden;
    unicode-bidi: isolate;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .divider {
    flex: none;
    width: 1px;
    height: 12px;
    background: var(--border-base);
  }
  /*
   * The floor is the place's. `--crumb-chrome` is what is not text: the glyph (12px), the
   * separator (9px) and the three 6px gaps. The place never shrinks as a flex item — even a
   * sliver of shrink would end a short place in an ellipsis — and is capped at the crumb's
   * width less that chrome instead; the section label takes all the shrink, down to nothing
   * (the glyph still says which section). So a place of 8ch or less always shows whole, and a
   * longer one keeps at least 8ch (A7 U8b review 2: "Goals › Co…" at 1024 px).
   */
  .crumb {
    --crumb-chrome: 39px;
    display: inline-flex;
    flex: 0 10 auto;
    min-width: calc(var(--crumb-chrome) + 8ch);
    overflow: hidden;
    align-items: center;
    gap: 6px;
    color: var(--text-muted);
    font-size: 12px;
  }
  .crumb-glyph,
  .crumb-sep {
    display: inline-flex;
    flex: none;
    color: var(--icon-faint);
  }
  .crumb-section {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .crumb-place {
    flex: none;
    max-width: calc(100% - var(--crumb-chrome));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-base);
    font-weight: 400;
  }
  /* A surface that is gone keeps its name, struck through; the row still opens. */
  .crumb.gone .crumb-section,
  .crumb.gone .crumb-place {
    text-decoration: line-through;
    color: var(--text-faint);
  }
  .line2 {
    min-width: 0;
    overflow: hidden;
    font-size: 12px;
    line-height: 16px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Agent text on the second line: its own isolate, like the name. */
  .said {
    unicode-bidi: isolate;
  }
  .line2.muted {
    color: var(--text-muted);
  }
  .line2.warning {
    color: var(--state-fg-warning);
  }
  .line2.danger {
    color: var(--state-fg-danger);
  }
  .agent {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    color: var(--text-base);
    font-size: 12px;
    white-space: nowrap;
  }
  .agent-glyph {
    display: inline-flex;
    color: var(--icon-muted);
  }
  .model {
    min-width: 0;
    overflow: hidden;
    color: var(--text-muted);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mono {
    font-family: var(--font-mono);
  }
  .when {
    display: flex;
    justify-content: flex-end;
    color: var(--text-muted);
    font-size: 11px;
    white-space: nowrap;
  }
  .row.waiting .time {
    color: var(--state-fg-warning);
  }
  /* Hover replaces the time with Open ↗ (A7 E1); so does keyboard focus. */
  .open {
    display: none;
    padding: 1px 8px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-sm);
    background: var(--bg-layer-02);
    color: var(--text-base);
    font: 500 11px/16px var(--font-sans);
  }
  .row.go:hover .open,
  .row.go:focus-visible .open {
    display: inline-block;
  }
  .row.go:hover .time,
  .row.go:focus-visible .time {
    display: none;
  }
  .stranded {
    flex: none;
    padding: 0 7px;
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-sm);
    color: var(--text-base);
    font-size: 11px;
  }
  .hidden-line {
    margin: 14px 12px 0;
    color: var(--text-muted);
    font-size: 12px;
  }
  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-base);
    font: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }

  /* ── Footer: range, rows per page, pages ───────────────────────────────────── */
  /* Pinned to the bottom of the scrolling body, so the range and pages are always in view. */
  .pager {
    position: sticky;
    bottom: -28px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-top: 24px;
    padding: 12px 0 16px;
    border-top: 1px solid var(--border-muted);
    background: var(--bg-base);
    color: var(--text-muted);
    font-size: 12px;
  }
  .pager-right {
    display: inline-flex;
    align-items: center;
    gap: 18px;
  }
  .per-page {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .per-page select {
    height: 28px;
    padding: 0 6px;
    border: 1px solid var(--border-muted);
    border-radius: var(--radius-sm);
    background: var(--bg-base);
    color: var(--text-base);
    font: 400 12px/16px var(--font-mono);
  }
  .pages {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .page-step,
  .page-number {
    min-width: 26px;
    height: 26px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    font: 400 12px/16px var(--font-mono);
    cursor: pointer;
  }
  .page-step:hover:not(:disabled),
  .page-number:hover {
    background: var(--overlay-hover);
  }
  .page-step:disabled {
    cursor: default;
    opacity: 0.4;
  }
  .page-number.on {
    background: var(--bg-layer-02);
    color: var(--text-base);
    font-weight: 500;
  }
  .gap {
    padding: 0 2px;
  }

  .notice {
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: flex-start;
  }
  .quiet {
    margin: 0;
    color: var(--text-muted);
  }
  .quiet.none {
    padding: 18px 12px;
  }
  .quiet-small {
    margin: 14px 12px 0;
    font-size: 12px;
    color: var(--text-muted);
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    max-width: 520px;
    margin: 48px auto;
    color: var(--icon-faint);
    text-align: center;
  }
  .empty-lead {
    margin: 0;
    font: 530 20px/28px var(--font-sans);
    color: var(--text-base);
  }
  .empty-more {
    margin: 0;
    font: 400 13px/20px var(--font-sans);
    color: var(--text-muted);
    text-wrap: pretty;
  }
</style>
