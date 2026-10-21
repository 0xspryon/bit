<script lang="ts">
  /**
   * The content-region pattern every Level 2 page uses: a page header that
   * does not scroll away, an optional filter row, a scrolling body, and a
   * detail panel that reflows the body rather than covering it.
   *
   * Designed once here so Flows B through G inherit it.
   */
  import type { Snippet } from "svelte";
  import { IconClose } from "../icons";

  let {
    title,
    description = "",
    detailTitle = "",
    detailOpen = false,
    onclosedetail,
    actions,
    filters,
    body,
    detail,
  }: {
    title: string;
    description?: string;
    detailTitle?: string;
    detailOpen?: boolean;
    onclosedetail?: () => void;
    actions?: Snippet;
    filters?: Snippet;
    body: Snippet;
    detail?: Snippet;
  } = $props();
</script>

<div class="frame">
  <div class="main">
    <header class="page-head">
      <div class="titles">
        <h1>{title}</h1>
        {#if description !== ""}<p>{description}</p>{/if}
      </div>
      {#if actions}<div class="actions">{@render actions()}</div>{/if}
    </header>

    {#if filters}
      <div class="filters">{@render filters()}</div>
    {/if}

    <div class="body">{@render body()}</div>
  </div>

  {#if detailOpen && detail}
    <aside class="detail" aria-label={detailTitle}>
      <header class="detail-head">
        <h2>{detailTitle}</h2>
        <button class="x" onclick={onclosedetail} aria-label="Close panel">
          <IconClose width="12" height="12" />
        </button>
      </header>
      <div class="detail-body">{@render detail()}</div>
    </aside>
  {/if}
</div>

<style>
  .frame {
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
  .main {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
  .page-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding: 16px 20px 14px;
    flex: none;
  }
  .titles h1 {
    margin: 0;
    font: 530 17px/22px var(--font-sans);
  }
  .titles p {
    margin: 3px 0 0;
    font-size: 12px;
    line-height: var(--lh-compact);
    color: var(--text-muted);
  }
  .actions {
    display: flex;
    gap: 8px;
    flex: none;
  }
  .filters {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 20px 12px;
    flex: none;
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 0 12px 20px;
  }

  /* Reflows the list instead of covering it: you keep your place. */
  .detail {
    display: flex;
    flex-direction: column;
    width: 420px;
    flex: none;
    border-left: 1px solid var(--border-base);
    background: var(--bg-base);
    animation: slide var(--dur-panel) var(--ease-panel);
  }
  .detail-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border-muted);
    flex: none;
  }
  .detail-head h2 {
    margin: 0;
    font: 530 14px/18px var(--font-sans);
  }
  .x {
    width: 24px;
    height: 24px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--icon-muted);
    cursor: pointer;
  }
  .x:hover {
    background: var(--overlay-hover);
    color: var(--text-base);
  }
  .detail-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 16px;
  }
  @keyframes slide {
    from {
      width: 0;
      opacity: 0;
    }
  }

  /* Below 1280 the panel overlays rather than reflowing — there is not
     enough width left for the list to stay usable beside it. */
  @media (max-width: 1280px) {
    .frame {
      position: relative;
    }
    .detail {
      position: absolute;
      inset: 0 0 0 auto;
      box-shadow: var(--elevation-overlay);
      z-index: 5;
    }
  }
</style>
