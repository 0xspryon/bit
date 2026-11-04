<script lang="ts">
  /**
   * Consecutive tool calls in a turn, folded into one muted line (A6 U4, D3): ">_ Ran 3
   * commands · write_scope_entry, record_asset". The calls themselves — their arguments,
   * what answered them, and each write's state — are one click away, drawn by
   * {@link ChatItem} exactly as they were before they were folded.
   *
   * **What needs the operator is on the folded line too.** A refused write, a write that
   * ended unresolved and a call the harness reported failed are counted beside the names,
   * and an unresolved write is announced (`role="status"`), as its row announces it: the
   * fold hides what went as expected, never what did not. A write still in flight shows D3's
   * "writing…". A recorded write is the expected outcome and is said once the run is open,
   * on its row.
   *
   * A `<details>`: the browser keeps it open across re-renders, a run that grows while open
   * stays open (its key is its first row's), and shut, its rows are out of the
   * accessibility tree, so a screen reader is not read every argument on arrival.
   */
  import type { ChatRow, ToolRunSummary } from "../chat";
  import { toolRunAttention, toolRunCount } from "../chat";
  import ChatItem from "./ChatItem.svelte";
  import MarkedText from "./MarkedText.svelte";
  import StreamCursor from "./StreamCursor.svelte";

  let { rows, summary }: { rows: readonly ChatRow[]; summary: ToolRunSummary } =
    $props();

  let attention = $derived(toolRunAttention(summary));
</script>

<li class="run" data-attention={attention.length > 0 ? "true" : undefined}>
  <details>
    <summary>
      <span class="mark mono" aria-hidden="true">&gt;_</span>
      <span class="count">{toolRunCount(summary.count)}</span>
      <span class="sep" aria-hidden="true">·</span>
      <!-- Tool names are the harness's words for its tools: marked as code, as a signature is. -->
      <span class="names mono"
        ><MarkedText text={summary.names.join(", ")} code /></span
      >
      {#if attention.length > 0}
        <span
          class="attention"
          role={summary.unresolved > 0 ? "status" : undefined}
          >{attention.join(" · ")}</span
        >
      {/if}
      {#if summary.pending}
        <span class="writing"><StreamCursor label="writing…" /></span>
      {/if}
    </summary>
    <ol class="calls">
      {#each rows as row (row.key)}
        <ChatItem
          item={row.item}
          proposedBy={row.proposedBy}
          result={row.result}
          write={row.write}
          summary={row.summary}
          narrated
        />
      {/each}
    </ol>
  </details>
</li>

<style>
  .run {
    list-style: none;
  }
  summary {
    display: flex;
    align-items: center;
    gap: 10px;
    width: fit-content;
    max-width: 100%;
    min-width: 0;
    padding: 2px 4px 2px 0;
    border-radius: var(--radius-xs);
    color: var(--text-muted);
    font: 400 12px/16px var(--font-sans);
    list-style: none;
    cursor: pointer;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary:hover {
    opacity: 0.8;
  }
  summary:focus-visible {
    outline: 1px solid var(--border-focus);
    outline-offset: 2px;
  }
  .mark {
    flex: none;
    color: var(--icon-faint);
    font-weight: 500;
  }
  .count {
    flex: none;
  }
  .sep {
    flex: none;
    margin: 0 -4px;
  }
  /*
   * D3 sets the names faint; muted here, as the turn footer is, because faint is below AA
   * at 12px and the names are what the line is for. They give way first on a narrow page.
   */
  .names {
    min-width: 0;
    overflow: hidden;
    color: var(--text-muted);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .attention {
    flex: none;
    color: var(--state-fg-warning);
  }
  .run[data-attention] .attention {
    font-weight: 500;
  }
  .writing {
    display: inline-flex;
    flex: none;
    align-items: center;
  }
  .calls {
    display: flex;
    flex-direction: column;
    margin: 8px 0 0;
    padding: 0;
    list-style: none;
  }
</style>
