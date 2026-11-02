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
    /*
     * The one left and right edge of the page: the title, the filter row and the body's
     * content all sit on it. It is a variable because it has two values and the three
     * places that use it must never disagree: 32px, or, with the rail hidden, whatever
     * centres a 1040px column (1104px less this same 32px on each side).
     *
     * `100%` is resolved where the variable is *used*, and all three users are block
     * children of `.main`, so it is `.main`'s width in each. Writing the centred case as a
     * `max-width` and `margin: auto` on the header and a `calc()` on the body is what let the
     * two drift 12px apart: the same column, computed twice.
     *
     * A row inside the body that has its own hover surface bleeds out of this edge with a
     * negative inline margin equal to its own padding, so that its *text* is on the edge.
     */
    --edge: 32px;
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 0;
    /* So the panel can ask how wide the *page* is, which is not the window: the rail takes
       232px of it, and hides. See the container query below. */
    container-type: inline-size;
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
    padding: 28px var(--edge) 24px;
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
    padding: 0 var(--edge) 16px;
    flex: none;
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 0 var(--edge) 28px;
  }
  /*
   * The rail is hidden: hold the header and the list to a reading width, centred, rather
   * than letting a row run 1400px from its title to its timestamp.
   */
  .centered {
    --edge: max(32px, calc((100% - 1040px) / 2));
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

  /*
   * Where even the overlay leaves nothing: the panel is 420px, and a page narrower than
   * 760px is left under 340px of what it covers — an Add form with its fields hidden and
   * its button wrapped, which is a view of the page with nothing on it to use. The panel
   * takes the whole page instead, and its close button is how back is reached.
   *
   * The page's width, not the window's: the window is 768px wide on a tablet in portrait
   * and the page is 536 of it, but it is 1000px of a 1232px window with the rail hidden.
   * A media query would be right for one of those and wrong for the other. `min(420px,
   * 100%)` would not help here at all: 100% of 536px is more than 420px.
   */
  @container (max-width: 760px) {
    .detail {
      width: 100%;
      border-left: 0;
    }
  }
</style>
