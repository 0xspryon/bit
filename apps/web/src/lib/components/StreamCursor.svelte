<script lang="ts">
  /**
   * The block cursor of A6 D3: a mark that something is still being produced.
   *
   * Extracted from {@link ChatItem}'s pending write, where it first appeared beside
   * "writing…", so the importer chat's turn-level cursor is the same mark rather than a
   * second drawing of it. Two places use it and they mean two different things, which is
   * why the words are the caller's: a row says *a write is in flight*, and the end of a
   * turn says *the agent is still going*.
   *
   * Decorative to a screen reader. Whatever it stands for is said elsewhere in words — the
   * row's write state, or the importer's heading — so the blinking box adds nothing to
   * announce.
   */
  let { label = "" }: { label?: string } = $props();
</script>

<span class="stream-cursor">
  <span class="caret" aria-hidden="true"></span>
  {#if label !== ""}
    <span>{label}</span>
  {/if}
</span>

<style>
  .stream-cursor {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    color: var(--text-muted);
  }
  .caret {
    flex: none;
    width: 7px;
    height: 14px;
    background: var(--text-base);
    animation: blink 1.1s steps(2, start) infinite;
  }
  @keyframes blink {
    to {
      visibility: hidden;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .caret {
      animation: none;
    }
  }
</style>
