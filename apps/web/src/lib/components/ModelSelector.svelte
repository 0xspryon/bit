<script lang="ts">
  /**
   * The Harness · Model · Reasoning selector: the model chip and the dialog it opens, with the
   * harness rail, the model list and the options column (A6 D6). Extracted from the
   * importer's picker (A6 chat generalisation, slice 2) so it mounts outside a chat — A9
   * H4f's Suggest-a-worker dialog, H6's planner chain rows — and the chat's own pickers are
   * built on it.
   *
   * **Controlled.** Every value is the caller's and every pick is a callback: the caller
   * holds what is picked (the importer's in `App`, a dialog's in its own state), so the same
   * control can apply picks as they are made (a new session's model) or stage them under a
   * footer that applies them together (a started session's switch). `open` and `query` are
   * bindable, and owned by the caller so they survive the dialog closing.
   */
  import type {
    HarnessInstanceView,
    HarnessModelView,
    ModelOptionDescriptor,
    ModelOptionSelection,
  } from "@bit/contracts";
  import type { Snippet } from "svelte";

  import HarnessChoice from "./HarnessChoice.svelte";
  import HarnessDialog from "./HarnessDialog.svelte";
  import ModelChip from "./ModelChip.svelte";
  import ModelOptionsColumn from "./ModelOptionsColumn.svelte";

  let {
    instances,
    active,
    model,
    modelView,
    descriptors,
    selections,
    dropped,
    harness,
    chipModel,
    open = $bindable(false),
    query = $bindable(""),
    onOpen,
    onPickInstance,
    onPickModel,
    onPickOption,
    chipLabel,
    chipTitle,
    switching = false,
    dialogTitle = "Harness, model and reasoning",
    subject = "A session",
    note,
    footer,
    onLeave,
    trigger = $bindable(null),
  }: {
    /** Every configured instance, ready or not. */
    instances: readonly HarnessInstanceView[];
    /** The instance whose models are listed. */
    active: HarnessInstanceView | undefined;
    /** The model picked (or staged). */
    model: string;
    modelView: HarnessModelView | undefined;
    descriptors: readonly ModelOptionDescriptor[];
    selections: readonly ModelOptionSelection[];
    dropped: readonly string[];
    /** The harness the chip names: the active instance's, or a pinned session's. */
    harness: string;
    /**
     * The model the chip names, when it is not the one being picked: a started session's,
     * while the dialog stages another. {@link model} when absent.
     */
    chipModel?: string;
    open?: boolean;
    query?: string;
    /** The chip was pressed. Absent: it toggles {@link open}. */
    onOpen?: () => void;
    onPickInstance: (instanceId: string) => void;
    onPickModel: (modelId: string) => void;
    onPickOption: (descriptorId: string, value: string) => void;
    chipLabel?: string;
    chipTitle?: string;
    /** A switch is with the server: the chip says so quietly. */
    switching?: boolean;
    dialogTitle?: string;
    /** What the options column says the options are of: "A session", "A worker". */
    subject?: string;
    /** A closing line under the model list, in the caller's words. */
    note?: Snippet;
    /** D6's footer, for picks staged and applied together. Absent: picks apply as made. */
    footer?: Snippet;
    /** The selector left the page (its branch changed): the caller closes what it holds. */
    onLeave?: () => void;
    /** The chip, which the dialog hands focus back to when it closes. */
    trigger?: HTMLButtonElement | null;
  } = $props();

  const leaves = () => () => {
    onLeave?.();
  };
</script>

<div class="picker" {@attach leaves}>
  <ModelChip
    {harness}
    model={chipModel ?? model}
    expanded={open}
    {switching}
    label={chipLabel}
    title={chipTitle}
    bind:trigger
    onclick={() => {
      if (onOpen === undefined) open = !open;
      else onOpen();
    }}
  />

  {#if open}
    <HarnessDialog
      opener={trigger}
      title={dialogTitle}
      onclose={() => (open = false)}
      {...footer === undefined ? {} : { footer }}
    >
      <HarnessChoice
        {instances}
        {active}
        {model}
        bind:query
        {onPickInstance}
        {onPickModel}
        {...note === undefined ? {} : { note }}
      >
        {#snippet options()}
          <ModelOptionsColumn
            instance={active}
            {model}
            {modelView}
            {descriptors}
            {selections}
            {dropped}
            onPick={onPickOption}
            {subject}
          />
        {/snippet}
      </HarnessChoice>
    </HarnessDialog>
  {/if}
</div>

<style>
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
