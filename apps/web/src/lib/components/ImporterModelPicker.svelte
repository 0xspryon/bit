<script lang="ts">
  /**
   * The model chip on the importer's composer, and the picker it opens (A6 D2, D6).
   *
   * **The picker the operator already has.** D6 is explicit that the harness and model
   * picker is "lifted as-is" — the importer is just another place a model runs, and nothing
   * about it earns a second picker. So the columns are {@link HarnessChoice}, the same
   * component the run composer's popover and the old Auto-load form used, and the state
   * behind it is the importer's own that already existed (`pickedImportInstanceId`,
   * `pickedImportModel`, `importPickerOpen`, `importModelQuery`). Its one importer-specific
   * line is the pinning note, which talks about sessions where the composer's talks about
   * attempts.
   *
   * **A modal, where D6 anchored it to the chip.** The operator asked for it on 2026-11-03
   * with the design otherwise unchanged, so the columns are untouched and only their shell
   * moved: {@link HarnessDialog} centres them over a scrim, rendered out of the composer's
   * form so that Enter in its filter is not a submission of the draft. The run composer's
   * picker is still a popover; that was not asked for.
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
  import type { Attachment } from "svelte/attachments";

  import type { App } from "../app.svelte";
  import { IconAngleDown } from "../icons";
  import HarnessChoice from "./HarnessChoice.svelte";
  import HarnessDialog from "./HarnessDialog.svelte";
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

  /** The chip, which the dialog hands focus back to when it closes. */
  let trigger = $state<HTMLButtonElement | null>(null);

  /**
   * Closes the picker whenever the branch that renders it goes, however it goes.
   *
   * **The invariant: `importPickerOpen` may not stay true across a teardown of that
   * branch.** The flag is on `App` and outlives this markup, so a flag left true is an
   * instruction to reopen the dialog the next time the branch renders — with no operator
   * action, its old filter query, and focus taken into it. The branch goes when the session
   * gains messages (`pinned` is no longer `null`) and when the importer is left altogether,
   * and the next "Start a new session" or visit renders it again.
   *
   * On the branch rather than at each way of reaching it: `importer.start()`, navigating
   * away, a session opened from the crumb bar and whatever comes next would each need
   * remembering, and the one forgotten is the one that reopens it. The chip's own button
   * does not need this: it lives in the same branch as the dialog, so the dialog's opener
   * cannot be gone while the dialog is open.
   */
  const closesWithBranch: Attachment = () => () => {
    app.importPickerOpen = false;
  };

  let harness = $derived(
    pinned?.harness ?? app.importInstance?.displayName ?? "",
  );
  let model = $derived(pinned?.model ?? app.effectiveImportModel);
  let letter = $derived((harness.slice(0, 1) || "?").toLowerCase());
</script>

{#if pinned === null}
  <div class="picker" {@attach closesWithBranch}>
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
      <HarnessDialog
        opener={trigger}
        onclose={() => (app.importPickerOpen = false)}
      >
        <HarnessChoice
          instances={app.harnesses}
          active={app.importInstance}
          model={app.effectiveImportModel}
          bind:query={app.importModelQuery}
          onPickInstance={(instanceId) => app.pickImportInstance(instanceId)}
          onPickModel={(modelId) => app.pickImportModel(modelId)}
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
      </HarnessDialog>
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
  /*
   * The chip's own wrapper, which once anchored a popover and now only keeps the chip one
   * flex item on the strip, exactly as the chip alone was. The dialog is not in it:
   * `HarnessDialog` leaves only an empty, `hidden` origin here and renders at the end of
   * `<body>`, out of the composer's form.
   */
  .picker {
    display: flex;
    /* Gives way before the send button does, as every control on this strip does. */
    min-width: 0;
  }
</style>
