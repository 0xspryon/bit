<script lang="ts">
  /**
   * The content-region pattern every Level 2 page uses: a page header that
   * does not scroll away, an optional filter row, a scrolling body, and a
   * detail panel that reflows the body rather than covering it.
   *
   * Designed once here so Flows B through G inherit it.
   *
   * The header starts at the page title: which target this is is the first crumb's job,
   * and a header that said it again would be the third statement of one fact. `heading`
   * replaces the default title block for a page whose title carries more than words — a
   * goal and its status chip. `centered` holds the content to a reading width, for when the
   * rail is hidden and the page would otherwise run the whole width of the window.
   */
  import type { Snippet } from "svelte";
  import { IconClose } from "../icons";

  let {
    title,
    description = "",
    centered = false,
    detailTitle = "",
    detailOpen = false,
    onclosedetail,
    heading,
    actions,
    filters,
    body,
    detail,
  }: {
    title: string;
    description?: string;
    centered?: boolean;
    detailTitle?: string;
    detailOpen?: boolean;
    onclosedetail?: () => void;
    heading?: Snippet;
    actions?: Snippet;
    filters?: Snippet;
    body: Snippet;
    detail?: Snippet;
  } = $props();
</script>

<div class={["frame", centered && "centered"]}>
  <div class="main">
    <header class="page-head">
      {#if heading}
        <div class="titles">{@render heading()}</div>
      {:else}
        <div class="titles">
          <h1>{title}</h1>
          {#if description !== ""}<p>{description}</p>{/if}
        </div>
      {/if}
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
    gap: 32px;
    padding: 28px 32px 24px;
    flex: none;
  }
  .titles {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    max-width: 640px;
  }
  .titles h1,
  .titles :global(h1) {
    margin: 0;
    font: 530 26px/32px var(--font-sans);
    letter-spacing: -0.01em;
    color: var(--text-base);
  }
  .titles p {
    margin: 0;
    font-size: 13px;
    line-height: 19px;
    color: var(--text-muted);
    text-wrap: pretty;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
  }
  .filters {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 32px 16px;
    flex: none;
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 0 20px 28px;
  }
  /*
   * The rail is hidden: hold the header and the list to a reading width, centred, rather
   * than letting a row run 1400px from its title to its timestamp.
   */
  .centered .page-head,
  .centered .filters {
    width: 100%;
    max-width: 1104px;
    margin: 0 auto;
  }
  .centered .body {
    padding-inline: max(20px, calc((100% - 1088px) / 2));
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
