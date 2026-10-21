<script lang="ts">
  /**
   * Target badge. Neutral by design: with the monochrome direction the letter
   * and the mono path carry identity instead of a colour.
   */
  let { name, size = 24 }: { name: string; size?: number } = $props();
  let letter = $derived((name[0] ?? "?").toUpperCase());
</script>

<span class="badge" style:--size="{size}px" aria-hidden="true">{letter}</span>

<style>
  .badge {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: var(--size);
    height: var(--size);
    border: 1px solid var(--badge-border);
    border-radius: var(--radius-sm);
    background: var(--badge-bg);
    color: var(--badge-fg);
    font-family: var(--font-mono);
    font-size: calc(var(--size) * 0.46);
    line-height: 1;
    user-select: none;
  }
</style>
