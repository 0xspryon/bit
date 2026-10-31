<script lang="ts">
  /**
   * A goal's status as a chip.
   *
   * Monochrome, and the word carries the meaning: "Active", "Met" and "Abandoned" are three
   * different words. Open is a filled chip and ended is an outline, so the one distinction
   * a list is scanned for — still going, or over — reads at a glance without a colour.
   * Colour stays with Blockers and errors, where it means something needs you.
   */
  import type { GoalStatus } from "@bit/contracts";
  import { statusLabel } from "../goalFormat";

  let { status }: { status: GoalStatus } = $props();
</script>

<span class={["chip", status === "active" ? "open" : "ended"]}>
  {statusLabel(status)}
</span>

<style>
  .chip {
    display: inline-flex;
    flex: none;
    align-items: center;
    border-radius: 3px;
    font: 500 10px/14px var(--font-sans);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .open {
    padding: 2px 7px;
    background: var(--bg-layer-02);
    color: var(--text-base);
  }
  .ended {
    padding: 1px 6px;
    border: 1px solid var(--border-strong);
    color: var(--text-muted);
  }
</style>
