<script lang="ts">
  /**
   * The crumb bar's context meter (A6 U9, D3): a ring and a token count, clickable to show
   * what fills the window.
   *
   * D3's caption is the brief: "a ring and a token count, there because a long import is the
   * thing most likely to run the window out, and clickable to see what is holding the
   * window". The ring is the fraction, drawn only where a window is known; the count is the
   * last model call's tokens, never a spend total (`crumbMeter.ts`).
   *
   * **A button and a popover, not a `<details>`** (unlike `ContextMeter.svelte`'s in-pane
   * meter): the popover hangs off the crumb bar over the thread, so it must close on
   * Escape and on a click elsewhere, with focus back on the button, as the crumb pickers
   * beside it do. Opening it asks for the categories (`onopen`), which Claude Code counts
   * only when asked.
   */
  import {
    crumbFigure,
    crumbLabel,
    crumbSource,
    ringDash,
    shareOf,
    type CrumbMeter,
  } from "../crumbMeter";
  import { sameModel } from "@bit/contracts";
  import { groupDigits } from "../chat";
  import { whenText } from "../goalFormat";

  let {
    meter,
    harness,
    modelName = (model: string) => model,
    counting = false,
    onopen,
    onclose,
  }: {
    meter: CrumbMeter;
    /** The harness's display name, for the line saying it gives no breakdown. */
    harness: string;
    /**
     * What a model is called here (`modelNames.ts`): its label, never an alias. The meter
     * compares ids; only what it says goes through this.
     */
    modelName?: (model: string) => string;
    /** Whether the categories are being counted now. */
    counting?: boolean;
    /** Called each time the popover opens: where the caller asks for the categories. */
    onopen?: () => void;
    /**
     * Called when the open popover closes, or goes with the bar: a count it asked for is
     * no longer wanted.
     */
    onclose?: () => void;
  } = $props();

  let open = $state(false);
  let root = $state<HTMLDivElement | undefined>(undefined);
  let button = $state<HTMLButtonElement | undefined>(undefined);
  let panel = $state<HTMLDivElement | undefined>(undefined);
  const panelId = `context-meter-${String(Math.random()).slice(2, 10)}`;

  let label = $derived(crumbLabel(meter));
  let dash = $derived(ringDash(meter.fraction));
  let used = $derived(
    meter.categories?.filter((row) => row.kind === "used") ?? [],
  );
  let reserved = $derived(
    meter.categories?.filter((row) => row.kind !== "used") ?? [],
  );

  function close(refocus: boolean) {
    open = false;
    onclose?.();
    if (refocus) button?.focus();
  }

  // A popover open when the bar drops the meter (the page left) closes with it.
  $effect(() => () => {
    if (open) onclose?.();
  });

  function toggle() {
    if (open) {
      close(false);
      return;
    }
    open = true;
    onopen?.();
  }

  // Focus into the popover on opening, so a reader hears what it holds; Tab leaves it.
  $effect(() => {
    if (open) panel?.focus();
  });
</script>

<svelte:window
  onpointerdown={(event) => {
    if (!open || root === undefined) return;
    if (event.target instanceof Node && root.contains(event.target)) return;
    close(false);
  }}
  onkeydown={(event) => {
    if (open && event.key === "Escape") {
      event.preventDefault();
      close(true);
    }
  }}
/>

<div
  class="context-meter"
  bind:this={root}
  onfocusout={(event) => {
    // Tabbing out of the popover closes it, as leaving any popover does.
    const next = event.relatedTarget;
    if (open && next instanceof Node && !root?.contains(next)) close(false);
  }}
>
  <button
    bind:this={button}
    class={["meter", open && "open"]}
    aria-label={label}
    title={label}
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-controls={open ? panelId : undefined}
    onclick={toggle}
  >
    <svg
      class="ring"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle class="track" cx="12" cy="12" r="9" />
      {#if dash !== null}
        <circle
          class={["arc", (meter.percent ?? 0) >= 80 && "high"]}
          cx="12"
          cy="12"
          r="9"
          stroke-dasharray={dash}
          transform="rotate(-90 12 12)"
        />
      {/if}
    </svg>
    <span class={["figure", meter.used === null && "none"]}>
      {crumbFigure(meter)}
    </span>
  </button>

  {#if open}
    <div
      bind:this={panel}
      id={panelId}
      class="panel"
      role="dialog"
      aria-label="What fills the context window"
      tabindex="-1"
    >
      <div class="head">
        <span class="title">Context window</span>
        {#if meter.model !== null && meter.model !== ""}
          <span class="model" title={meter.model}>{modelName(meter.model)}</span
          >
        {/if}
      </div>

      <p class="total">
        {#if meter.used !== null}
          <strong>{groupDigits(meter.used)}</strong>
          {#if meter.window !== null}
            of {groupDigits(meter.window)} tokens
            <span class="percent">
              · {meter.percent === 0 && meter.used > 0
                ? "<1"
                : String(meter.percent)}%
            </span>
          {:else}
            tokens
          {/if}
        {:else if meter.reading === "compacted"}
          Summarised. The next model call measures the window again.
        {:else if meter.reading === "unread"}
          The harness could not be asked how full the window is.
        {:else}
          No model call yet, so nothing fills the window that anyone has
          measured.
        {/if}
      </p>
      {#if meter.used === null && meter.window !== null}
        <p class="note">
          This model's window is {groupDigits(meter.window)} tokens.
        </p>
      {/if}
      {#if meter.used !== null && meter.usedModel !== null && meter.model !== null && meter.model !== "" && !sameModel(meter.usedModel, meter.model)}
        <p class="note other-model">
          Measured on <span class="mono">{modelName(meter.usedModel)}</span>'s
          last call. The next call, on {modelName(meter.model)}, measures it again
          with that model's
          own count.
        </p>
      {/if}

      {#if meter.droppedFrom !== null}
        <p class="note loud" role="status">
          Down from {groupDigits(meter.droppedFrom)} tokens: the harness summarised
          the conversation to make room, so it now carries a summary instead of the
          turns before it.
        </p>
      {/if}

      {#if meter.categories !== null}
        <ul class="rows" aria-label="What fills the window">
          {#each used as row (row.id ?? row.name)}
            <li class="row">
              <span class="name">{row.name}</span>
              <span class="tokens">{groupDigits(row.tokens)}</span>
              <span class="share">{shareOf(row.tokens, meter.window)}</span>
            </li>
          {/each}
          {#each reserved as row (row.id ?? row.name)}
            <li class={["row", "reserve", row.kind === "buffer" && "buffer"]}>
              <span class="name">{row.name}</span>
              <span class="tokens">{groupDigits(row.tokens)}</span>
              <span class="share">{shareOf(row.tokens, meter.window)}</span>
            </li>
          {/each}
        </ul>
        <p class="note">
          {harness}'s own count of each part. They add up close to the last
          model call's figure above, not exactly to it.
          {#if meter.categoriesStale && meter.categoriesAt !== null}
            Counted before the latest call, {whenText(
              meter.categoriesAt,
            )}{counting ? "; counting again…" : "."}
          {/if}
        </p>
      {:else if counting}
        <p class="note" role="status">Counting what fills the window…</p>
      {:else if meter.missing === "harness_gives_none"}
        <p class="note">
          {harness} reports the tokens of each model call and the model's window,
          but gives no breakdown of what fills it.
        </p>
      {:else if meter.missing === "not_live"}
        <p class="note">
          The breakdown comes from the running session, and this server does not
          hold this one now. The figure is the last model call in its stored
          transcript.
        </p>
      {:else if meter.missing === "unanswered" && meter.reading !== "unread"}
        <p class="note">The session did not answer for a breakdown.</p>
      {:else if meter.missing === "not_asked"}
        <p class="note">
          {harness} counts what fills the window only when asked, and has not counted
          it for {meter.model !== null && meter.model !== ""
            ? modelName(meter.model)
            : "this model"} yet. Close this panel and open it again to count.
        </p>
      {/if}

      {#if meter.used !== null && meter.window === null}
        <p class="note">
          No context window was reported for this model, so there is no fraction
          to draw: the token count is what is known.
        </p>
      {/if}

      {#if meter.at !== null && meter.at > 0}
        <p class="when">
          {crumbSource(meter, modelName)}, {whenText(meter.at)}
        </p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .context-meter {
    position: relative;
    flex: none;
  }
  /* D3: 26 px high, 9 px sides, a 7 px gap, transparent until hovered. */
  .meter {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 26px;
    padding: 0 9px;
    border: 1px solid transparent;
    border-radius: 5px;
    background: transparent;
    cursor: pointer;
  }
  .meter:hover {
    border-color: var(--border-base);
    background: var(--overlay-hover);
  }
  .meter.open {
    border-color: var(--border-strong);
    background: var(--bg-layer-02);
  }
  .meter:focus-visible {
    outline: 1px solid var(--border-focus);
    outline-offset: 1px;
  }
  .ring {
    flex: none;
  }
  .track,
  .arc {
    fill: none;
    stroke-width: 3;
  }
  .track {
    stroke: var(--border-strong);
  }
  .arc {
    stroke: var(--icon-base);
    stroke-linecap: round;
  }
  .arc.high {
    stroke: var(--state-fg-warning);
  }
  .figure {
    color: var(--text-muted);
    font: 400 12px/16px var(--font-mono);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .figure.none {
    color: var(--text-faint);
  }

  .panel {
    position: absolute;
    top: calc(100% + 9px);
    right: 0;
    z-index: 20;
    width: 340px;
    max-height: min(520px, calc(100dvh - 80px));
    overflow-y: auto;
    padding: 12px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    background: var(--bg-layer-01);
    box-shadow: 0 18px 48px #00000070;
    color: var(--text-base);
    font: 400 12px/18px var(--font-sans);
  }
  .panel:focus {
    outline: none;
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }
  .title {
    font-weight: 500;
  }
  .model {
    min-width: 0;
    overflow: hidden;
    color: var(--text-muted);
    font: 400 11px/16px var(--font-mono);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .total {
    margin: 8px 0 0;
  }
  .total strong {
    font: 500 15px/20px var(--font-mono);
    font-variant-numeric: tabular-nums;
  }
  .percent {
    color: var(--text-muted);
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 10px 0 0;
    padding: 8px 0 0;
    border-top: 1px solid var(--border-muted);
    list-style: none;
  }
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto 4ch;
    gap: 10px;
    align-items: baseline;
  }
  /* The reserve and free space after a rule: room, not content. */
  .row.reserve {
    color: var(--text-muted);
  }
  .row.reserve:first-of-type,
  .row:not(.reserve) + .row.reserve {
    margin-top: 4px;
    padding-top: 4px;
    border-top: 1px dashed var(--border-muted);
  }
  .name {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .tokens,
  .share {
    font: 400 11px/18px var(--font-mono);
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  .share {
    color: var(--text-muted);
  }
  .note {
    margin: 8px 0 0;
    color: var(--text-muted);
    font-size: 11px;
    line-height: var(--lh-compact);
  }
  .other-model .mono {
    font: 400 11px/16px var(--font-mono);
    overflow-wrap: anywhere;
  }
  .note.loud {
    color: var(--state-fg-warning);
  }
  .when {
    margin: 10px 0 0;
    color: var(--text-faint);
    font-size: 11px;
  }
</style>
