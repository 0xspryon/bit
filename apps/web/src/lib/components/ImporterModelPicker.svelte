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
   * ## The Reasoning column
   *
   * D6's third column, and the same one the composer's picker renders
   * ({@link ModelOptionsColumn}). It is a real control because the draft carries it:
   * `ImportModelDraft.modelOptions`, `RunDraft`'s field, which the server resolves against
   * the model it actually picked and hands to `createSession`. The state behind it is the
   * importer's own (`importModelOptionsByModel`), kept apart from a run's.
   */
  import type { App } from "../app.svelte";
  import { IconAngleDown } from "../icons";
  import HarnessChoice from "./HarnessChoice.svelte";
  import ModelOptionsColumn from "./ModelOptionsColumn.svelte";

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
  /** The chip, so a picker closed by keyboard can hand focus back to what opened it. */
  let trigger = $state<HTMLButtonElement | null>(null);

  /**
   * Closes the picker and puts focus back on the chip that opened it.
   *
   * `Modal`'s rule, for the reason its tests state: a dialog dismissed by keyboard leaves
   * the keyboard nowhere, and `body` is nowhere. Escape reaches this through
   * {@link HarnessChoice}'s `onDismiss`; the scrim's click reaches it directly.
   */
  function closeToTrigger(): void {
    app.importPickerOpen = false;
    trigger?.focus();
  }

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
  <div class="picker">
    <button
      class="chip"
      type="button"
      aria-haspopup="dialog"
      aria-expanded={app.importPickerOpen}
      aria-label="Harness and model: {model}"
      bind:this={trigger}
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
        onclick={() => closeToTrigger()}
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
          onDismiss={closeToTrigger}
        >
          {#snippet note()}
            A session is pinned to the harness it starts on. Changing harness
            starts a new session; it never moves this one.
          {/snippet}

          {#snippet options()}
            <ModelOptionsColumn
              instance={app.importInstance}
              model={app.effectiveImportModel}
              modelView={app.importModelView}
              descriptors={app.importModelDescriptors}
              selections={app.pickedImportModelOptions}
              dropped={app.droppedImportModelOptions}
              onPick={(descriptorId, value) =>
                app.pickImportModelOption(descriptorId, value)}
              subject="A session"
            />
          {/snippet}
        </HarnessChoice>
      </div>
    {/if}
  </div>
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
   * The chip's own wrapper, so the panel below hangs off the chip rather than off the
   * composer's box: `position: relative` here is what `left`/`right` resolve against.
   * One flex item on the strip, exactly as the chip alone was, so wrapping it moves
   * nothing.
   */
  .picker {
    position: relative;
    display: flex;
    /* Gives way before the send button does, as every control on this strip does. */
    min-width: 0;
  }
  /*
   * The floating panel: `HarnessPicker`'s approach on this side of the composer too —
   * absolutely positioned out of a relative trigger, so opening it moves no pixel of
   * the composer's layout, and sized by the columns it holds rather than by the width
   * of whatever is under it.
   *
   * Opens leftwards from the chip, where the run composer's opens rightwards from its
   * trigger for the same reason: that is where this trigger's room is. This chip is
   * the third control on its strip, ~410px in from the left even on a 768px window,
   * so a panel lined up with the chip's *left* edge runs past the window's right edge
   * (410 + 622 > 1024); lined up with its right edge, 622px ends ~45px inside even at
   * 1024 and ~218px in at 1440.
   */
  .panel {
    position: absolute;
    right: 0;
    bottom: calc(100% + 6px);
    z-index: 2;
    display: flex;
    /* 196 + 240 + 184, plus the two 1px dividers between them. */
    width: 622px;
    /*
     * 340 is the cap the columns resolve their scrolling against, and the composer
     * picker's number. The second arm is the importer's own case, and the reason a
     * taller panel was reverted once: the picker only opens on a *new* session, whose
     * composer sits at the vertical centre of the page rather than at the bottom, and
     * the chip then holds only about half the window above it (measured: chip top ≈
     * 50vh + 34), so a 340px panel runs off the top of any window shorter than ~700px.
     * `50dvh` keeps the panel inside the room the chip actually has, and stops binding
     * — leaving the full 340 — wherever the window is tall enough to give it.
     */
    max-height: min(340px, calc(50dvh + 12px));
    overflow: hidden;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-lg);
    box-shadow: var(--elevation-floating);
    background: var(--bg-layer-01);
  }
  /*
     Narrow viewports: the composer picker's own numbers, because `HarnessChoice`
     stacks the same way for both popovers and its stacked layout was measured against
     this width. Right-aligned to the chip, the 470px cap ends well inside the window:
     the chip's right edge is ~100px in from the window's right at 768px.
   */
  @media (max-width: 920px) {
    .panel {
      width: min(92vw, clamp(360px, calc(100vw - 310px), 470px));
    }
  }
</style>
