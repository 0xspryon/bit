<script lang="ts">
  /**
   * Level 2: the full shell inside an open target.
   *
   * The page content here is deliberately generic. Flow A's job is to prove
   * the frame — sidebar, page header, filter row, scrolling body, detail
   * panel — not to design the pages that will fill it. Those are Flows B
   * through G, and inventing them here would make them look decided.
   *
   * What is real now is the frame's header: {@link TargetHeader} shows the
   * open target's name, its scope note and the counts read from that
   * target's own database. And the hunts section's body is driven by the
   * real intent count rather than by a prototype number, so a target with
   * nothing in it shows an empty transcript — which is what every target
   * shows today, because nothing can start a run yet. The other sections
   * keep their placeholder rows: a count there is the prototype's, and
   * swapping in a number this screen cannot source would make an undesigned
   * page look decided.
   *
   * What is new is {@link ComposeBox} beneath the frame: a run can be started
   * and stopped against the open target, on a harness and model the operator
   * picks. The *live* transcript is still deliberately absent — the run narrates
   * to an in-process bus with no subscriber yet, and Day 6 owns the stream — but
   * {@link TranscriptPanel} reads back what a settled attempt left behind, which
   * is a different thing: the server's own artefact when it has one, and the
   * harness's own copy, labelled as the thing that may be gone, when it does not.
   */
  import Badge from "../components/Badge.svelte";
  import Button from "../components/Button.svelte";
  import ComposeBox from "../components/ComposeBox.svelte";
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
   * How many rows this section has, and where that number comes from.
   *
   * `hunts` is answered from the open target's own database — and only when the
   * counts on hand are that target's, so a switch cannot show the previous
   * target's length. Every other section falls back to the prototype's count,
   * which is what keeps an undesigned page looking like a prototype instead of
   * like an empty real one.
   */
  let count = $derived(
    app.navItem === "hunts"
      ? ((app.viewTargetId === app.selected?.id ? app.counts?.intents : 0) ?? 0)
      : (item?.count ?? 0),
  );
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

    <!--
      The compose box sits under the frame rather than inside it, on the Hunts section
      only. Starting a run is an action on the *target*, so it belongs to the pane and
      not to whichever page is showing; and it is only on Hunts because that is the
      section a run produces. Putting it under every section would make it look like a
      control for Findings and Traffic too.
    -->
    {#if app.navItem === "hunts"}
      <!--
        The transcript sits above the composer and below the frame, for the same reason the
        composer does: it is about the target rather than about whichever page is showing.
        It renders nothing at all until this tab has started a run here, which is the only
        handle a browser has on a settled attempt until Flow B lists them.
      -->
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
