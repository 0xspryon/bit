<script lang="ts">
  import type { Snippet } from "svelte";
  import { IconClose } from "../icons";

  let {
    title,
    onclose,
    body,
    footer,
  }: {
    title: string;
    onclose: () => void;
    body: Snippet;
    footer: Snippet;
  } = $props();

  let panel = $state<HTMLElement | null>(null);

  function onkeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      onclose();
      return;
    }
    if (event.key !== "Tab" || panel === null) return;
    const focusable = panel.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [href], input:not(:disabled), select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
</script>

<svelte:window {onkeydown} />

<div class="scrim">
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="panel"
    role="dialog"
    aria-modal="true"
    aria-label={title}
    bind:this={panel}
  >
    <header>
      <h2>{title}</h2>
      <button class="x" onclick={onclose} aria-label="Close">
        <IconClose width="12" height="12" />
      </button>
    </header>
    <div class="body">{@render body()}</div>
    <footer>{@render footer()}</footer>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 24px;
    background: var(--overlay-scrim);
    z-index: 50;
    animation: fade var(--dur-fade) ease-out;
  }
  .panel {
    width: min(100%, 560px);
    max-height: min(100%, 640px);
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-xl);
    background: var(--bg-base);
    box-shadow: var(--elevation-overlay);
    animation: rise var(--dur-panel) var(--ease-panel);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 18px;
    border-bottom: 1px solid var(--border-muted);
  }
  h2 {
    margin: 0;
    font: 530 15px/20px var(--font-sans);
  }
  .x {
    width: 26px;
    height: 26px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--icon-muted);
    font-size: 17px;
    cursor: pointer;
  }
  .x:hover {
    background: var(--overlay-hover);
    color: var(--text-base);
  }
  .body {
    padding: 18px;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 14px 18px;
    border-top: 1px solid var(--border-muted);
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.99);
    }
  }
</style>
