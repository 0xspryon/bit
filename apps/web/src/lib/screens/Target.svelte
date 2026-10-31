<script lang="ts">
  /**
   * Level 2: the full shell inside an open target.
   *
   * The page content here is deliberately generic for every section but one. Flow A's
   * job was to prove the frame — sidebar, page header, filter row, scrolling body,
   * detail panel — not to design the pages that will fill it, and inventing them would
   * make them look decided.
   *
   * **Goals is the exception, and the only real section.** {@link Goals} and
   * {@link Goal} read, create and end the open target's goals through the server, inside
   * the same {@link PageFrame}. Every other section keeps its placeholder rows: a count
   * there is the prototype's, and swapping in a number this screen cannot source would
   * make an undesigned page look decided.
   *
   * **There is no target header.** Which target this is is the first crumb's job, and the
   * counts it used to show are the rail's: two places counting the same things had already
   * begun to disagree. What the header said that nothing else does — that the target could
   * not be read — is a one-line notice here, shown only when it is true.
   *
   * {@link ComposeBox} sits beneath the Goals section: a run of an intent the operator has
   * aimed it at can be started, and a running one stopped, against the open target, on a
   * harness and model the operator picks. The *live*
   * transcript is the dock at the foot of every section: {@link LiveTranscript} shows the
   * target's own event log, read in store-assigned order behind a cursor, next to the
   * harness's narration and the policy gate's denials as live activity — and says which is
   * which. It is about the target rather than any one page, so it is under all of them.
   * {@link TranscriptPanel} remains the different thing beside it: what a *settled*
   * attempt left behind, the server's own artefact when it has one, and the harness's own
   * copy, labelled as the thing that may be gone, when it does not.
   */
  import Button from "../components/Button.svelte";
  import ComposeBox from "../components/ComposeBox.svelte";
  import Goal from "./Goal.svelte";
  import Goals from "./Goals.svelte";
  import LiveTranscript from "../components/LiveTranscript.svelte";
  import PageFrame from "../components/PageFrame.svelte";
  import Sidebar from "../components/Sidebar.svelte";
  import TranscriptPanel from "../components/TranscriptPanel.svelte";
  import { IconSearch } from "../icons";
  import { navItems } from "../mock";
  import type { App } from "../app.svelte";

  let { app }: { app: App } = $props();

  let item = $derived(navItems.find((i) => i.id === app.navItem));
  let label = $derived(item?.label ?? "Settings");
  /**
   * How many placeholder rows this section shows.
   *
   * Only the prototype sections reach this: Goals renders its own real rows. The count is
   * the prototype's, which is what keeps an undesigned page looking like a prototype
   * instead of like an empty real one.
   */
  let count = $derived(item?.count ?? 0);
  let rows = $derived(
    Array.from({ length: Math.min(count, 9) }, (_, index) => ({
      id: `${app.navItem}-${index}`,
      index,
    })),
  );
</script>

<div class="level2">
  {#if !app.drawerHidden}<Sidebar {app} />{/if}

  <div class="pane">
    {#if app.viewState === "unavailable" || app.viewState === "unreachable"}
      <!-- The server's own sentence, unedited: the target picker marks the row with the
           same failure, so the two cannot describe it differently. -->
      <p class="notice" role="status">{app.viewDetail}</p>
    {/if}

    {#if app.navItem === "goals"}
      {#if app.openGoalId === ""}
        <Goals {app} />
      {:else}
        <Goal {app} />
      {/if}
    {:else}
      <PageFrame
        title={label}
        description="Placeholder content. This page is designed in a later flow — what Flow A settles is the frame around it."
        centered={app.drawerHidden}
        detailTitle="{label} detail"
        detailOpen={app.detailOpen}
        onclosedetail={() => (app.detailOpen = false)}
      >
        {#snippet actions()}
          <Button size="sm">Export</Button>
          <Button size="sm" variant="primary">New</Button>
        {/snippet}

        {#snippet filters()}
          <span class="search-wrap">
            <IconSearch class="search-icon" width="13" height="13" />
            <input class="search" placeholder="Filter {label}" />
          </span>
          <Button size="sm" variant="quiet">All statuses</Button>
          <Button size="sm" variant="quiet">Any time</Button>
        {/snippet}

        {#snippet body()}
          {#if rows.length === 0}
            <p class="empty">Nothing recorded here yet.</p>
          {:else}
            <ul class="rows">
              {#each rows as row (row.id)}
                <li>
                  <button
                    class="row"
                    onclick={() => {
                      app.detailRow = row.index;
                      app.detailOpen = true;
                    }}
                  >
                    <span class="row-title">
                      {label} row {row.index + 1}
                    </span>
                    <span class="row-meta mono">placeholder</span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        {/snippet}

        {#snippet detail()}
          <p class="detail-lead">
            The panel reflows the list beside it rather than covering it, so you
            keep your place. Below 1280px it overlays instead.
          </p>
          <dl>
            <dt>Row</dt>
            <dd>{(app.detailRow ?? 0) + 1}</dd>
            <dt>Target</dt>
            <dd class="mono">{app.selected?.name ?? ""}</dd>
            <dt>Section</dt>
            <dd>{label}</dd>
          </dl>
        {/snippet}
      </PageFrame>
    {/if}

    <!--
      The run box sits under the frame rather than inside it, on the Goals section only: the
      list and an open goal alike, because a run is started from an intent and intents are
      listed on a goal's page, but a run is an action on the *target* and its strip has to be
      visible from the list too. It renders nothing until there is something to say — an
      intent aimed at, or a run going — so on the list it is usually absent. Putting it
      under every section would make it look like a control for Findings and Assets too.

      The settled transcript sits above it for the same reason, and renders nothing until
      this tab has started a run here — the only handle a browser has on a settled attempt
      until Flow B lists them.
    -->
    {#if app.navItem === "goals"}
      <TranscriptPanel {app} />
      <ComposeBox {app} />
    {/if}

    <!-- Last, so it is the foot of the window: one line until it is opened. -->
    <LiveTranscript {app} />
  </div>
</div>

<style>
  .level2 {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  /* The header does not scroll and the frame below it owns the scrolling. */
  .pane {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .notice {
    flex: none;
    margin: 0;
    padding: 10px 32px;
    border-bottom: 1px solid var(--state-border-warning);
    background: var(--state-bg-warning);
    color: var(--state-fg-warning);
    font-size: 13px;
    line-height: 18px;
  }
  .search-wrap {
    position: relative;
    display: block;
    width: 240px;
  }
  .search {
    width: 100%;
    height: 30px;
    padding: 0 12px 0 32px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    background: var(--bg-layer-01);
    color: var(--text-base);
    font: 400 12px/var(--lh-base) var(--font-sans);
  }
  .search::placeholder {
    color: var(--text-faint);
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 9px 10px;
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .row:hover {
    background: var(--overlay-hover);
  }
  .row-title {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row-meta {
    font-size: 11px;
    color: var(--text-faint);
  }
  .empty {
    margin: 24px 10px;
    font-size: 13px;
    color: var(--text-faint);
  }
  .detail-lead {
    margin: 0 0 18px;
    font-size: 12px;
    line-height: var(--lh-base);
    color: var(--text-muted);
  }
  dl {
    display: grid;
    grid-template-columns: 90px 1fr;
    gap: 8px 12px;
    margin: 0;
    font-size: 12px;
  }
  dt {
    color: var(--text-faint);
  }
  dd {
    margin: 0;
    color: var(--text-base);
  }
</style>
