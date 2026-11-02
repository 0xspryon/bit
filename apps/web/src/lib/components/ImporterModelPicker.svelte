<script lang="ts">
  /**
   * The model chip on the importer's composer, and the picker it opens (A6 D2, D6).
   *
   * **The picker the operator already has.** D6 is explicit that the harness and model
   * picker is "lifted as-is and anchored to the composer chip — the importer is just another
   * place a model runs, and nothing about it earns a second picker". So the columns are
   * {@link HarnessChoice}, the same component the run composer's popover and the old
   * Auto-load form used, and the state behind it is the importer's own that already existed
   * (`pickedImportInstanceId`, `pickedImportModel`, `importPickerOpen`, `importModelQuery`).
   * Its one importer-specific line is the pinning note, which talks about sessions where the
   * composer's talks about attempts.
   *
   * ## Three states, because a session's model is not always the operator's to change
   *
   * - **A new session**: a real control. The chip is the model the server resolved (or the
   *   operator's pick) and opens the picker, which is the only time a choice means anything.
   * - **A session with messages**: the model it ran on, shown and not editable ("changing
   *   harness starts a new session and never moves this one"). A span, not a button — a
   *   disabled control reads as "not yet", and this one is "not ever".
   * - **A session that is working**: the same, dimmed, with the composer's hint beside it.
   *
   * ## What is not in it, and why
   *
   * The Reasoning column D6 draws is not here. `ScopeImportDraft` carries a model and no
   * options, so a reasoning control would be a setting nothing sends. The composer's own
   * picker has it because a run does carry `RunDraft`'s options.
   */
  import type { App } from "../app.svelte";
  import { IconAngleDown } from "../icons";
  import HarnessChoice from "./HarnessChoice.svelte";

  let {
    app,
    pinned,
    dimmed = false,
  }: {
    app: App;
    /**
     * The `provider/model` a started session ran on, or `null` for a new session, whose
     * model is still the operator's to choose.
     */
    pinned: { readonly harness: string; readonly model: string } | null;
    /** The session is mid-turn, so its model is held and shown quietly. */
    dimmed?: boolean;
  } = $props();

  let panel = $state<HTMLElement | null>(null);

  let harness = $derived(
    pinned?.harness ?? app.importInstance?.displayName ?? "",
  );
  let model = $derived(pinned?.model ?? app.effectiveImportModel);
  let letter = $derived((harness.slice(0, 1) || "?").toLowerCase());

  /**
   * Tab wraps inside the panel, as the composer's picker does and for its reason: a popover
   * that let focus out while open would leave the keyboard somewhere the operator cannot
   * see. Escape and the row walking are `HarnessChoice`'s.
   */
  function onkeydown(event: KeyboardEvent) {
    if (!app.importPickerOpen || event.key !== "Tab" || panel === null) return;
    const focusable = panel.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
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

{#if pinned === null}
  <button
    class="chip"
    type="button"
    aria-haspopup="dialog"
    aria-expanded={app.importPickerOpen}
    aria-label="Harness and model: {model}"
    onclick={() => app.toggleImportPicker()}
  >
    <span class="glyph" aria-hidden="true">{letter}</span>
    <span class="model">{model === "" ? "No model" : model}</span>
    <IconAngleDown class="caret" width="11" height="11" />
  </button>

  {#if app.importPickerOpen}
    <!-- Transparent, under the panel, only to catch the click that closes it. -->
    <button
      class="dismiss"
      type="button"
      tabindex="-1"
      aria-label="Close the harness picker"
      onclick={() => (app.importPickerOpen = false)}
    ></button>
    <div
      class="panel"
      role="dialog"
      aria-label="Choose a harness and model"
      bind:this={panel}
    >
      <HarnessChoice
        instances={app.harnesses}
        active={app.importInstance}
        model={app.effectiveImportModel}
        bind:query={app.importModelQuery}
        onPickInstance={(instanceId) => app.pickImportInstance(instanceId)}
        onPickModel={(modelId) => app.pickImportModel(modelId)}
        onDismiss={() => (app.importPickerOpen = false)}
      >
        {#snippet note()}
          A session is pinned to the harness it starts on. Changing harness
          starts a new session; it never moves this one.
        {/snippet}
      </HarnessChoice>
    </div>
  {/if}
{:else}
  <span
    class={["chip", "held", dimmed && "dim"]}
    title="The model this session runs on. Changing harness starts a new session; it never moves this one."
  >
    <span class="glyph" aria-hidden="true">{letter}</span>
    <span class="model">{model}</span>
  </span>
{/if}

<style>
  /* A6's chip: 28px, a hairline border, a letter for the harness and the model in mono. */
  .chip {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 8px;
    max-width: 280px;
    height: 28px;
    padding: 0 9px;
    box-sizing: border-box;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-base);
    font: 400 12px/var(--lh-compact) var(--font-mono);
  }
  button.chip {
    cursor: pointer;
  }
  button.chip:hover,
  button.chip[aria-expanded="true"] {
    background: var(--overlay-hover);
  }
  button.chip:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 1px;
  }
  .chip.held {
    cursor: default;
  }
  .chip.dim {
    opacity: 0.55;
  }
  .glyph {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 15px;
    height: 15px;
    border-radius: 4px;
    background: var(--bg-layer-03);
    color: var(--text-base);
    font: 500 9px/15px var(--font-mono);
  }
  .model {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .chip :global(.caret) {
    flex: none;
    color: var(--icon-muted);
  }
  .dismiss {
    position: fixed;
    inset: 0;
    border: 0;
    background: transparent;
    cursor: default;
  }
  /*
   * Anchored to the composer's box, not to the chip: D6 draws the panel as wide as the
   * composer and lined up with its left edge. The box is `position: relative` and this
   * chip's wrapper is not, so `left`/`right` resolve against the box.
   */
  .panel {
    position: absolute;
    right: 0;
    bottom: calc(100% + 6px);
    left: 0;
    z-index: 2;
    display: flex;
    max-height: 340px;
    overflow: hidden;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-lg);
    box-shadow: var(--elevation-floating);
    background: var(--bg-layer-01);
  }
</style>
