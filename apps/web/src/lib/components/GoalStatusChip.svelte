<script lang="ts">
  /**
   * A goal's status as a chip.
   *
   * The word carries the meaning and the tint only reinforces it, so a reader who cannot
   * tell the colours apart loses nothing: "Active", "Met" and "Abandoned" are three
   * different words. Info, success and neutral rather than warning or danger — abandoning
   * a goal is a decision, not a fault, and danger is reserved for things that went wrong.
   */
  import type { GoalStatus } from "@bit/contracts";
  import { statusLabel } from "../goalFormat";

  let { status }: { status: GoalStatus } = $props();
</script>

<span class={["chip", status]}>{statusLabel(status)}</span>

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    flex: none;
    padding: 1px 8px;
    border: 1px solid var(--border-base);
    border-radius: 99px;
    font: 530 11px/var(--lh-compact) var(--font-sans);
    white-space: nowrap;
  }
  .active {
    border-color: var(--state-border-info);
    background: var(--state-bg-info);
    color: var(--state-fg-info);
  }
  .met {
    border-color: var(--state-border-success);
    background: var(--state-bg-success);
    color: var(--state-fg-success);
  }
  .abandoned {
    background: var(--bg-layer-02);
    color: var(--text-muted);
  }
</style>
