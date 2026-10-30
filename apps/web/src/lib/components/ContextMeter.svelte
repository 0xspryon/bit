<script lang="ts">
  /**
   * How full one agent's context is, as a figure that opens into what it is made of.
   *
   * **The shape OpenCode's own view uses**, and adopted rather than invented for the reason
   * the model-option descriptors were: a figure at the top of the pane, clicked to reveal
   * the session, the model, the window and the totals behind it. What is deliberately *not*
   * adopted is where the figure comes from — see below.
   *
   * ## The one thing this component exists to be right about
   *
   * **A context meter is a fraction of a window, and the numbers a harness publishes most
   * readily are spend totals.** DECISIONS.md §24.4 measured both drivers: OpenCode's
   * `session.usage.updated` summed to 65 838 against a real context of 13 753, and Claude
   * Code's `result.usage` to 90 784 against 23 179 — four to five times too high, because
   * the cached prefix is re-counted on every call. So the figure here is **one model call**,
   * the server publishes per-call measurements for exactly this, and nothing in the browser
   * adds two of them together. `chat.ts`'s `contextMeter` is where that is written down and
   * tested; this component arranges and says.
   *
   * ## What it will not draw
   *
   * - **No percentage without a window.** Ruling 3 of the brief: where no limit is known the
   *   figure is the token count alone. An honest "14,870 tokens" beats a fabricated "7%",
   *   and that is the ordinary state on Claude Code for a session's first moments and the
   *   permanent state when a catalogue could not be read.
   * - **No implied precision about the output side.** Claude Code's live frames carry a
   *   stale output count, so the server omits it until the turn ends; the panel says the
   *   figure is short rather than rounding the gap away.
   * - **Nothing about a session it is not given facts for.** The {@link facts} list is the
   *   caller's, because what identifies a planner round and what identifies a goal
   *   conversation are different things — and a row this component invented would be a claim
   *   about a session it cannot see.
   *
   * ## Why a `<details>`
   *
   * The same control {@link ChatItem} uses for a tool's arguments, for the same reasons:
   * collapsed by default, keyboard-reachable without a handler, and its contents are out of
   * the accessibility tree while it is shut — so a reader is not narrated eight rows of
   * numbers every time a model call lands.
   */
  import {
    contextMeterLabel,
    groupDigits,
    pastCompaction,
    type ContextMeter,
    type MeterFact,
  } from "../chat";
  import { whenText } from "../goalFormat";

  let {
    meter,
    label,
    facts = [],
  }: {
    /**
     * The latest model call this pane's session made, or `undefined` for none yet.
     *
     * `undefined` renders **nothing at all** rather than a zero or a placeholder: a session
     * that has not called a model has no context to be a fraction of, and a meter reading
     * "0" would be a measurement where there is none.
     */
    meter: ContextMeter | undefined;
    /** What this meter is of, for the control's accessible name: "Planner round context". */
    label: string;
    /** Rows only the caller can fill: the session, the harness, the model. */
    facts?: readonly MeterFact[];
  } = $props();

  let figure = $derived(meter === undefined ? "" : contextMeterLabel(meter));
  /** The bar's width, clamped, and drawn only when a window is known. */
  let filled = $derived(
    meter?.percent === null || meter?.percent === undefined
      ? null
      : Math.max(0, Math.min(100, meter.percent)),
  );
  /**
   * Whether this call has passed the harness's own compaction point.
   *
   * Changes nothing about the figure and one thing about the words. The figure itself stays
   * a true measurement of a call that really was sent at this size — the rewrite had not
   * happened when it went — so what the sentence says is about the **next** call rather
   * than this one: the harness is about to summarise, or has just summarised, and the
   * number will appear to go backwards when it does.
   */
  let compacted = $derived(meter !== undefined && pastCompaction(meter));
</script>

{#if meter !== undefined}
  <details class="meter">
    <summary class="figure" aria-label="{label}: {figure}">
      <span class="mono">{figure}</span>
      {#if filled !== null}
        <!--
          A second rendering of the percentage already in the text beside it, so it is
          hidden from a reader rather than announced twice. It is the only thing on this
          control that is not a word, and nothing depends on seeing it.
        -->
        <span class="bar" aria-hidden="true">
          <span class="fill" style="width: {String(filled)}%"></span>
          <!--
            The harness's own compaction point, as a tick on the track. `aria-hidden` with
            the rest of the bar: the panel states the number in words, and a mark a reader
            cannot be told the value of is not an accessible control.
          -->
          {#if meter.compactionPercent !== null}
            <span class="tick" style="left: {String(meter.compactionPercent)}%"
            ></span>
          {/if}
        </span>
      {/if}
    </summary>

    <dl class="detail">
      <div class="pair">
        <dt>Context on this call</dt>
        <dd class="mono">{groupDigits(meter.tokens)} tokens</dd>
      </div>
      <div class="pair">
        <dt>Sent</dt>
        <dd class="mono">{groupDigits(meter.promptTokens)}</dd>
      </div>
      <div class="pair">
        <dt>Generated</dt>
        <dd class={["mono", !meter.outputStated && "unstated"]}>
          {meter.outputStated && meter.outputTokens !== null
            ? groupDigits(meter.outputTokens)
            : "not stated yet"}
        </dd>
      </div>
      <div class="pair">
        <dt>Window</dt>
        <dd class="mono">
          {meter.limit === null
            ? "not reported"
            : `${groupDigits(meter.limit)} tokens`}
        </dd>
      </div>
      <div class="pair">
        <dt>Summarised at</dt>
        <dd class={["mono", meter.compactionAt === null && "unstated"]}>
          {meter.compactionAt === null
            ? "not stated by this harness"
            : `${groupDigits(meter.compactionAt)} tokens`}
        </dd>
      </div>
      <div class="pair">
        <dt>Model call</dt>
        <dd class="mono id" title={meter.callId}>{meter.callId}</dd>
      </div>
      <div class="pair">
        <dt>Measured</dt>
        <dd>{whenText(meter.at)}</dd>
      </div>
      {#each facts as fact (fact.term)}
        <div class="pair">
          <dt>{fact.term}</dt>
          <dd class="mono id" title={fact.value}>{fact.value}</dd>
        </div>
      {/each}
    </dl>

    <!--
      The sentence that stops the figure from being read as something it is not. Both halves
      are things an operator would otherwise have to be told by somebody: that this is one
      call rather than a session's spend, and — when it applies — that the figure is short.
    -->
    <p class="note">
      This is <strong>one model call</strong>, not a running total: the token
      figures a harness publishes for a whole session or turn count the cached
      prompt again on every call and read several times higher than the context
      really is.
    </p>
    {#if !meter.outputStated}
      <p class="note">
        This harness states what a call generated only when the turn ends, so
        the figure above is what was <em>sent</em> and runs short by however much
        has been generated since.
      </p>
    {/if}
    {#if meter.limit === null}
      <p class="note">
        No context window was reported for this model, so there is no percentage
        to draw — the token count is what is known.
      </p>
    {/if}
    <!--
      What happens before the bar fills, which is the thing an operator would otherwise
      meet without warning. The window is what the provider accepts; the harness acts well
      below it, on its own, so this meter never reaches 100% on a session it is allowed to
      run on.
    -->
    {#if meter.compactionAt !== null}
      <p
        class={["note", compacted && "loud"]}
        role={compacted ? "status" : undefined}
      >
        {#if compacted}
          Past the point where this harness summarises a session on its own ({groupDigits(
            meter.compactionAt,
          )} tokens): the conversation behind this figure is about to be, or has already
          been, rewritten as a summary — so the next call's context may be
          <em>smaller</em> than this one's.
        {:else}
          This harness summarises a session on its own at
          <strong>{groupDigits(meter.compactionAt)}</strong> tokens — before the window
          above fills — replacing the conversation with a summary. That figure is
          read from the harness's own default policy rather than reported by it, so
          a configuration or an upgrade can move it.
        {/if}
      </p>
    {/if}
  </details>
{/if}

<style>
  .meter {
    display: block;
    min-width: 0;
  }
  /*
   * The control. It reads as metadata rather than as a button, like `ChatItem`'s disclosure
   * labels, and it carries a pointer, a hover shift and a focus ring because it is
   * clickable and keyboard-reachable — a summary with no visible focus is a control nobody
   * can find.
   */
  .figure {
    display: flex;
    align-items: center;
    gap: 6px;
    width: fit-content;
    padding: 1px 6px;
    border: 1px solid var(--border-muted);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-size: 11px;
    line-height: var(--lh-compact);
    white-space: nowrap;
    cursor: pointer;
  }
  .figure:hover {
    color: var(--text-base);
    border-color: var(--border-base);
  }
  .figure:focus-visible {
    outline: 1px solid var(--border-focus);
    outline-offset: 1px;
  }
  .bar {
    position: relative;
    display: inline-block;
    width: 48px;
    height: 4px;
    overflow: hidden;
    border-radius: 2px;
    background: var(--bg-layer-02);
  }
  /*
   * The compaction point, as a 1px rule across the track. It reads as a mark on a scale
   * rather than as a second fill, which is what it is: nothing past it is unreachable, it
   * is where the harness acts.
   */
  .tick {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--text-base);
  }
  .fill {
    display: block;
    height: 100%;
    background: var(--text-muted);
  }
  /*
   * Two columns at tablet widths and up, which is every width this app targets. The rows
   * are short pairs and a single column would make the panel twice as tall as the chat row
   * above it.
   */
  .detail {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 2px 12px;
    margin: 6px 0 0;
    padding: 6px 8px;
    border: 1px solid var(--border-muted);
    border-radius: var(--radius-sm);
    background: var(--bg-deep);
  }
  .pair {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
  }
  dt {
    color: var(--text-muted);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  dd {
    margin: 0;
    min-width: 0;
    color: var(--text-base);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  /* An id is long and is matched on by eye; the `title` carries the whole of it. */
  .id {
    max-width: 22ch;
  }
  /* Not a number, so it must not read as one. */
  .unstated {
    color: var(--text-muted);
    font-variant-numeric: normal;
  }
  .note {
    margin: 4px 0 0;
    color: var(--text-muted);
    font-size: 11px;
    line-height: var(--lh-compact);
  }
  /* Past the harness's own threshold: a state worth noticing, not an error. */
  .note.loud {
    color: var(--state-fg-warning);
  }
</style>
