<script lang="ts">
  /**
   * The planner's input for this goal, shown exactly as the planner will receive it.
   *
   * **The text is the server's, byte for byte.** Nothing here formats, re-wraps or
   * summarises it: the panel's whole claim is that an operator is reading the string a
   * planner round is prompted with, and a browser that assembled any part of it could not
   * make that claim. It is rendered in a `<pre>` for the same reason — the briefing's
   * headings, indentation and per-case numbering are its own structure, and turning them
   * into HTML would be a second rendering to keep honest.
   *
   * **It omits nothing** (the spec's decision 11). Every intent of the goal and every
   * observation under all of them. The counts line says so, and says it in a checkable
   * form — "0 omitted" rather than silence — because an operator has no other way to tell
   * a complete briefing from one that quietly dropped the oldest evidence.
   *
   * **Over the ceiling there is no text at all, and the panel says both numbers.** The
   * server refuses to build a briefing that exceeds `GOAL_BRIEFING_MAX_CHARS` rather than
   * shortening one, so the honest thing to show is the refusal: what it rendered to, what
   * the limit is, and what can be done about it. A shortened briefing would let a planner
   * reason from a gap it cannot see, which is the failure this whole panel exists to make
   * visible before a round is ever opened.
   *
   * The size is a character count and is labelled as one. There is no tokenizer on this
   * seam, so it is an approximation of what a provider will charge for — an honest one,
   * because it is visibly not a token count rather than a token count that is quietly
   * wrong.
   */
  import type { App } from "../app.svelte";

  let { app }: { app: App } = $props();

  let briefing = $derived(app.goalBriefing);
  /** Thousands separators: a six-figure character count is unreadable without them. */
  let number = new Intl.NumberFormat();
  /**
   * How much of the ceiling the briefing uses, as a percentage, or `undefined` when there
   * is no briefing to measure. Clamped at 100 for display only; the figures beside it are
   * never clamped.
   */
  let usedPercent = $derived(
    briefing === undefined || briefing.maxChars <= 0
      ? undefined
      : Math.min(
          100,
          Math.round((briefing.sizeChars / briefing.maxChars) * 100),
        ),
  );
</script>

<section aria-labelledby="briefing-heading" class="briefing">
  <div class="head">
    <h2 id="briefing-heading">Planner briefing</h2>
    {#if briefing !== undefined}
      <span class="size">
        {number.format(briefing.sizeChars)} of {number.format(
          briefing.maxChars,
        )}
        characters{usedPercent === undefined
          ? ""
          : ` (${String(usedPercent)}%)`}
      </span>
    {/if}
  </div>

  <p class="hint">
    What a planner round is given for this goal, and nothing else: no earlier
    conversation and no summary. It omits nothing below the server's ceiling, so
    this is the whole record the planner reasons from.
  </p>

  {#if app.goalBriefingState === "failed"}
    <!--
      One block for both failures, because to a reader they are the same shape of
      answer: a sentence instead of a briefing. The two numbers are shown when the
      refusal carried them, which is what distinguishes "over the ceiling" from
      "the server did not answer".
    -->
    <p class="error" role="alert">{app.goalBriefingDetail}</p>
    {#if app.goalBriefingSize !== undefined && app.goalBriefingCeiling !== undefined}
      <dl class="figures">
        <dt>Rendered size</dt>
        <dd>{number.format(app.goalBriefingSize)} characters</dd>
        <dt>Ceiling</dt>
        <dd>
          {number.format(app.goalBriefingCeiling)} characters, from GOAL_BRIEFING_MAX_CHARS
        </dd>
        <dt>Over by</dt>
        <dd>
          {number.format(app.goalBriefingSize - app.goalBriefingCeiling)} characters
        </dd>
      </dl>
      <p class="hint">
        No briefing was built. The server never shortens one: a planner given a
        shorter brief would reason from a gap it could not see.
      </p>
    {/if}
  {:else if briefing === undefined}
    <p class="hint" role="status">
      {app.goalBriefingState === "loading"
        ? "Reading the briefing…"
        : "The briefing has not been read yet."}
    </p>
  {:else}
    <p class="counts">
      {number.format(briefing.observationCount)} observation{briefing.observationCount ===
      1
        ? ""
        : "s"}, {number.format(briefing.intentCount)} intent{briefing.intentCount ===
      1
        ? ""
        : "s"}, {briefing.omittedObservationIds.length} omitted, prepared at graph
      sequence {briefing.preparedAtSequence}.
      {briefing.truncated ? "Truncated." : "Not truncated."}
    </p>
    <pre class="rendered">{briefing.rendered}</pre>
    {#if app.goalBriefingState === "loading"}
      <p class="hint" role="status">Re-reading…</p>
    {/if}
  {/if}
</section>

<style>
  .briefing {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
  }
  h2 {
    margin: 0;
    font: 600 11px/var(--lh-compact) var(--font-sans);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .size {
    font-size: 12px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  p {
    margin: 0;
    font-size: 13px;
    line-height: var(--lh-base);
  }
  .hint {
    font-size: 12px;
    line-height: var(--lh-compact);
    color: var(--text-muted);
  }
  .counts {
    font-size: 12px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .error {
    color: var(--state-fg-danger);
    font-size: 12px;
    line-height: var(--lh-compact);
  }
  .figures {
    display: grid;
    grid-template-columns: 110px 1fr;
    gap: 6px 12px;
    margin: 0;
    font-size: 12px;
  }
  .figures dt {
    color: var(--text-faint);
  }
  .figures dd {
    margin: 0;
    color: var(--text-base);
    font-variant-numeric: tabular-nums;
  }
  /*
    A tall scroll box rather than the whole page: a briefing is routinely thousands of
    lines, and a panel that pushed the intent list and the end control off the bottom of
    the goal would make the briefing the page. `white-space: pre` keeps the server's own
    line breaks and does not wrap, because wrapping a briefing's indented case blocks
    would change how its structure reads.

    No `tabindex`, matching the transcript panels: Svelte's `a11y_no_noninteractive_tabindex`
    rejects a focusable `pre`, and there is no role that both satisfies it and is true of
    this element. The consequence is real and worth naming rather than papering over — the
    inner box is scrollable with the pointer and, in browsers that implement it, with
    caret browsing, but it is not in the tab order.
  */
  .rendered {
    max-height: 60dvh;
    overflow: auto;
    margin: 0;
    padding: 12px 14px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    background: var(--bg-layer-01);
    color: var(--text-base);
    font: 400 12px/1.55 var(--font-mono);
    white-space: pre;
    tab-size: 2;
  }
</style>
