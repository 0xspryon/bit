<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    tone = "info",
    ondismiss,
    children,
  }: {
    tone?: "info" | "warning" | "danger";
    ondismiss?: () => void;
    children: Snippet;
  } = $props();
</script>

<div class={["banner", tone]} role="status">
  <span class="dot" aria-hidden="true"></span>
  <p>{@render children()}</p>
  {#if ondismiss}
    <button class="dismiss" onclick={ondismiss} aria-label="Dismiss">×</button>
  {/if}
</div>

<style>
  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border-base);
    font-size: 13px;
  }
  .banner p {
    margin: 0;
    flex: 1;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
    flex: none;
  }
  .info {
    background: var(--bg-layer-01);
    color: var(--text-muted);
  }
  .warning {
    background: var(--state-bg-warning);
    border-bottom-color: var(--state-border-warning);
    color: var(--state-fg-warning);
  }
  .danger {
    background: var(--state-bg-danger);
    border-bottom-color: var(--state-border-danger);
    color: var(--state-fg-danger);
  }
  .dismiss {
    border: 0;
    background: transparent;
    color: inherit;
    font-size: 17px;
    line-height: 1;
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .dismiss:hover {
    background: var(--overlay-hover);
  }
</style>
