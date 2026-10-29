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
   * What is real in the frame itself: {@link TargetHeader} shows the open target's name,
   * its scope note and the counts read from that target's own database.
   *
   * {@link ComposeBox} sits beneath the Goals section: a run of an intent the operator has
   * aimed it at can be started, and a running one stopped, against the open target, on a
   * harness and model the operator picks. The *live*
   * transcript is here too: {@link LiveTranscript} shows the target's own event log, read
   * in store-assigned order behind a cursor, next to the harness's narration and the
   * policy gate's denials as live activity — and says which is which.
   * {@link TranscriptPanel} remains the different thing beside it: what a *settled*
   * attempt left behind, the server's own artefact when it has one, and the harness's own
   * copy, labelled as the thing that may be gone, when it does not.
   */
  import Badge from "../components/Badge.svelte";
  import Button from "../components/Button.svelte";
  import ComposeBox from "../components/ComposeBox.svelte";
  import Goal from "./Goal.svelte";
  import Goals from "./Goals.svelte";
  import LiveTranscript from "../components/LiveTranscript.svelte";
  import PageFrame from "../components/PageFrame.svelte";
  import Sidebar from "../components/Sidebar.svelte";
  import TargetHeader from "../components/TargetHeader.svelte";
  import TranscriptPanel from "../components/TranscriptPanel.svelte";
  import { IconSearch } from "../icons";
  import { navGroups } from "../mock";
  import type { App } from "../app.svelte";

  let { app }: { app: App } = $props();

  let item = $derived(
    navGroups.flatMap((g) => g.items).find((i) => i.id === app.navItem),
  );
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
  <Sidebar {app} />

  <div class="pane">
    <TargetHeader {app} />

    {#if app.navItem === "goals"}
      {#if app.openGoalId === ""}
        <Goals {app} />
      {:else}
        <Goal {app} />
      {/if}
    {:else}
      <PageFrame
        title={item?.label ?? ""}
        description="Placeholder content. This page is designed in a later flow — what Flow A settles is the frame around it."
        detailTitle="{item?.label ?? ''} detail"
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
            <input class="search" placeholder="Filter {item?.label ?? ''}" />
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
                    <Badge name={app.selected?.name ?? "?"} size={16} />
                    <span class="row-title">
                      {item?.label ?? ""} row {row.index + 1}
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
            <dd>{item?.label ?? ""}</dd>
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
      under every section would make it look like a control for Findings and Traffic too.
    -->
    {#if app.navItem === "goals"}
      <!--
        The transcripts sit above the run box and below the frame, for the same reason the
        box does: they are about the target rather than about whichever page is showing.
        The live one goes first because it is about the run happening now, while the panel
        under it is about a run that has already ended; reading top to bottom therefore reads
        from the present backwards. Each renders nothing until it has something to say — the
        settled one not until this tab has started a run here, which is the only handle a
        browser has on a settled attempt until Flow B lists them.
      -->
      <LiveTranscript {app} />
      <TranscriptPanel {app} />
      <ComposeBox {app} />
    {/if}
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
    background: var(--bg-layer-01);
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
