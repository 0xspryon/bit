<script lang="ts">
  /**
   * Level 2: the full shell inside an open target.
   *
   * The page content here is deliberately generic. Flow A's job is to prove
   * the frame — sidebar, page header, filter row, scrolling body, detail
   * panel — not to design the pages that will fill it. Those are Flows B
   * through G, and inventing them here would make them look decided.
   */
  import Badge from "../components/Badge.svelte";
  import Button from "../components/Button.svelte";
  import PageFrame from "../components/PageFrame.svelte";
  import Sidebar from "../components/Sidebar.svelte";
  import { IconSearch } from "../icons";
  import { navGroups } from "../mock";
  import type { App } from "../app.svelte";

  let { app }: { app: App } = $props();

  let item = $derived(
    navGroups.flatMap((g) => g.items).find((i) => i.id === app.navItem),
  );
  let rows = $derived(
    Array.from({ length: Math.min(item?.count ?? 0, 9) }, (_, index) => ({
      id: `${app.navItem}-${index}`,
      index,
    })),
  );
</script>

<div class="level2">
  <Sidebar {app} />

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
</div>

<style>
  .level2 {
    display: flex;
    flex: 1;
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
