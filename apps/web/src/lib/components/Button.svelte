<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    variant = "neutral",
    size = "md",
    loading = false,
    disabled = false,
    full = false,
    expanded,
    onclick,
    type = "button",
    children,
  }: {
    variant?: "primary" | "neutral" | "quiet" | "outline" | "danger";
    /** `page` is a page header's action: shorter than `md`, beside a 32px title. */
    size?: "sm" | "md" | "page";
    loading?: boolean;
    disabled?: boolean;
    full?: boolean;
    /** For a button that opens and closes a panel: reported as `aria-expanded`. */
    expanded?: boolean;
    onclick?: () => void;
    type?: "button" | "submit";
    children: Snippet;
  } = $props();
</script>

<button
  {type}
  {onclick}
  aria-expanded={expanded}
  disabled={disabled || loading}
  class={["btn", variant, size, full && "full", loading && "loading"]}
>
  {#if loading}<span class="spinner" aria-hidden="true"></span>{/if}
  <span class="label">{@render children()}</span>
</button>

<style>
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    font: 530 13px/var(--lh-compact) var(--font-sans);
    cursor: pointer;
    transition:
      background var(--dur-hover) ease-out,
      border-color var(--dur-hover) ease-out;
  }
  .md {
    min-height: 44px;
    padding: 0 16px;
  }
  .page {
    min-height: 34px;
    padding: 0 14px;
    font-weight: 500;
  }
  .sm {
    min-height: 28px;
    padding: 0 10px;
    font-size: 12px;
  }
  .full {
    width: 100%;
  }
  .btn:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  /* Monochrome: the primary action is a light fill on dark, and the reverse on light. */
  .primary {
    background: var(--bg-inverse);
    color: var(--text-inverse);
  }
  .primary:hover:not(:disabled) {
    opacity: 0.88;
  }

  .neutral {
    background: var(--bg-layer-01);
    border-color: var(--border-base);
    color: var(--text-base);
  }
  .neutral:hover:not(:disabled) {
    background: var(--bg-layer-02);
  }

  .outline {
    background: transparent;
    border-color: var(--border-strong);
    color: var(--text-muted);
    font-weight: 400;
  }
  .outline:hover:not(:disabled) {
    background: var(--overlay-hover);
    color: var(--text-base);
  }

  .quiet {
    background: transparent;
    color: var(--text-muted);
  }
  .quiet:hover:not(:disabled) {
    background: var(--overlay-hover);
    color: var(--text-base);
  }

  .danger {
    background: var(--state-bg-danger);
    border-color: var(--state-border-danger);
    color: var(--state-fg-danger);
  }

  .label {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .loading .label {
    opacity: 0.7;
  }

  .spinner {
    width: 13px;
    height: 13px;
    border: 1.5px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 700ms linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
