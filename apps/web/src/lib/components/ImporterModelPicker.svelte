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
   * ## Two faces, because a session is pinned to its harness and not to its model
   *
   * - **A new session**: picks take effect as they are made, as before. The chip is the model
   *   the server resolved (or the operator's pick); any harness, any model.
   * - **A started session** (D6, U3): the chip still opens the picker, now with D6's footer.
   *   Picks are **staged** and applied together by "Use for this session", which asks the
   *   server to switch the session's model (A6 F4) — one call, because the server refuses a
   *   second switch while one is in flight, and a model then a reasoning level picked one
   *   after the other would otherwise be two. The dialog stays open while the call is out,
   *   so a refusal's `ErrorDialog` opens over it and closing that returns to the picker; an
   *   accepted switch closes it and the chip shows the model the server answered with.
   *   Another harness in the rail is **a new session**, and the footer says so before it is
   *   confirmed: "Open a new session" starts one on that harness, carrying the draft over.
   *
   * A started session that cannot be talked to at all — stranded, ended, refused, or with
   * no harness this page can resolve — keeps the plain label: there is nothing to switch.
   *
   * ## The Reasoning column
   *
   * D6's third column, and the same one the composer's picker renders
   * ({@link ModelOptionsColumn}). For a new session the draft carries it
   * (`ImportModelDraft.modelOptions`), from the importer's own `importModelOptionsByModel`.
   * For a started one it is what the switch sends (`ConversationModelDraft.modelOptions`):
   * the server sets exactly the options a switch names, so the column says what the
   * session will be on, and it starts from what this tab knows the session is set to.
   */
  import {
    droppedModelOptionIds,
    explicitModelOptionSelections,
    modelOptionDescriptors,
    type ModelOptionSelection,
  } from "@bit/contracts";

  import { withModelOptionPicked, type App } from "../app.svelte";
  import ErrorDialog from "./ErrorDialog.svelte";
  import ModelChip from "./ModelChip.svelte";
  import ModelSelector from "./ModelSelector.svelte";

  /** A started session, as far as its model goes. */
  interface PinnedModel {
    /** The session, whose own switch in flight is the only one this chip is about. */
    readonly sessionId: string;
    /** The harness's display name: the glyph and the footer's words. */
    readonly harness: string;
    /** The instance the session is pinned to, when the server named it. */
    readonly instanceId: string | undefined;
    readonly model: string;
    /** What the model is set to, when this tab knows. */
    readonly modelOptions: readonly ModelOptionSelection[] | undefined;
  }

  let {
    app,
    pinned,
    switchable = false,
    onNewSession,
  }: {
    app: App;
    /** A started session's model, or `null` for a new session, whose model is still open. */
    pinned: PinnedModel | null;
    /** Whether a started session can be switched at all: it is talked to, not read-only. */
    switchable?: boolean;
    /**
     * "Open a new session" was confirmed. The chip that opened the dialog goes with the
     * session it was for, so the caller says where focus lands: the composer, with the draft.
     */
    onNewSession?: () => void;
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
   *
   * A started session's dialog needs none of this: its open flag is this component's own
   * ({@link sessionOpen}), goes with it, and closes when the session on screen changes.
   */
  const closesWithBranch = (): void => {
    app.importPickerOpen = false;
  };

  let harness = $derived(
    pinned?.harness ?? app.importInstance?.displayName ?? "",
  );
  let model = $derived(pinned?.model ?? app.effectiveImportModel);

  /* ── A started session's picker: staged, then applied together ─────────────── */

  /**
   * The session's own harness instance: by the id the server named, or — for a declared
   * session in the state picker, which names none — by its harness's display name.
   */
  let sessionInstance = $derived(
    pinned === null
      ? undefined
      : pinned.instanceId !== undefined
        ? app.harnesses.find((each) => each.instanceId === pinned.instanceId)
        : app.harnesses.find((each) => each.displayName === pinned.harness),
  );
  /** The session on screen, as a value: a new `pinned` for the same session is no change. */
  let sessionKey = $derived(pinned?.sessionId);
  /**
   * Whether the started session's dialog is open: set by the chip and the dialog's buttons,
   * and **back to closed whenever the session on screen changes**, however it changes. This
   * component outlives the session — browser Back, a session opened from the crumb bar —
   * and a dialog left open over the next session would be staging the last one's pick under
   * the next one's chip, its "Use for this session" switching a session it was not opened
   * for. The staged pick goes with it: {@link openSession} stages afresh from the session
   * the dialog is opened for, so nothing staged for the last one is ever shown again.
   */
  let sessionOpen = $derived.by(() => {
    void sessionKey;
    return false;
  });
  /**
   * Which opening of the dialog is on screen, counted. A switch's answer closes the dialog
   * only if it is still the opening that sent it: an operator who cancelled while it was
   * out and opened the dialog again is making another pick, and the first answer is not a
   * reason to throw it away. Not state: nothing renders from it.
   */
  let opening = 0;
  /** The footer's note, which the confirm button is described by. */
  const noteId = $props.id();
  let stagedInstanceId = $state("");
  let stagedModel = $state("");
  /** What was set per instance and model while the dialog was open. */
  let stagedOptions = $state<Record<string, readonly ModelOptionSelection[]>>(
    {},
  );
  let query = $state("");
  /** The footer's confirm button: the refusal dialog's opener while the picker is up. */
  let confirmButton = $state<HTMLButtonElement | null>(null);

  let stagedInstance = $derived(
    app.harnesses.find((each) => each.instanceId === stagedInstanceId),
  );
  let stagedModelView = $derived(
    stagedInstance?.models.find((entry) => entry.id === stagedModel),
  );
  let stagedDescriptors = $derived(modelOptionDescriptors(stagedModelView));
  /** {@link App.modelOptionKey}'s rule, over the staged instance and model. */
  let stagedKey = $derived(`${stagedInstanceId}\u0000${stagedModel}`);
  let stagedSelections = $derived(stagedOptions[stagedKey] ?? []);
  let stagedDropped = $derived(
    droppedModelOptionIds(stagedDescriptors, stagedSelections),
  );
  /** Another harness than the session's: confirming opens a new session on it. */
  let otherHarness = $derived(
    sessionInstance !== undefined &&
      stagedInstanceId !== sessionInstance.instanceId,
  );
  /** This session's switch with the server, if any: another session's is not this chip's. */
  let switching = $derived(app.importer.switchingOf(pinned?.sessionId));
  /** This session's refused switch, not yet dismissed: another session's waits for it. */
  let failure = $derived(app.importer.switchFailureOf(pinned?.sessionId));

  function openSession(): void {
    if (pinned === null || sessionInstance === undefined) return;
    stagedInstanceId = sessionInstance.instanceId;
    stagedModel = pinned.model;
    stagedOptions = {
      [`${sessionInstance.instanceId}\u0000${pinned.model}`]:
        pinned.modelOptions ?? [],
    };
    query = "";
    opening += 1;
    sessionOpen = true;
  }

  function pickInstance(instanceId: string): void {
    stagedInstanceId = instanceId;
    // A model belongs to one catalogue: back on the session's own harness its model is the
    // session's, on another the harness's default.
    stagedModel =
      instanceId === sessionInstance?.instanceId && pinned !== null
        ? pinned.model
        : (app.harnesses.find((each) => each.instanceId === instanceId)
            ?.defaultModel ?? "");
    query = "";
  }

  function pickOption(descriptorId: string, value: string): void {
    const next = withModelOptionPicked(
      stagedOptions,
      stagedKey,
      stagedDescriptors,
      descriptorId,
      value,
    );
    if (next !== undefined) stagedOptions = next;
  }

  /**
   * "Use for this session", or "Open a new session" when another harness is staged.
   *
   * The switch is one call with the model and its options together. The dialog stays open
   * until the server answers: an accepted switch closes it, a refused one leaves it under the
   * error dialog so the operator can pick again or cancel.
   */
  async function confirm(): Promise<void> {
    if (stagedModel === "" || switching !== undefined) return;
    const options = explicitModelOptionSelections(
      stagedDescriptors,
      stagedSelections,
    );
    if (otherHarness) {
      sessionOpen = false;
      app.startImporterSessionOn(stagedInstanceId, stagedModel, options ?? []);
      onNewSession?.();
      return;
    }
    const sent = opening;
    if (await app.importer.switchModel(stagedModel, options)) {
      if (sent === opening) sessionOpen = false;
    }
  }
</script>

{#snippet sessionFooter()}
  <p class="foot-note" id={noteId}>
    {#if otherHarness}
      This session stays on {harness}. {stagedInstance?.displayName ??
        stagedInstanceId} is another harness, so this opens a new session on it and
      leaves this one as it is.
    {:else}
      This session stays on {harness} — picking another harness opens a new one. Models
      and reasoning inside it can change at any time, including mid-run.
    {/if}
  </p>
  <button
    class="foot-button"
    type="button"
    onclick={() => (sessionOpen = false)}>Cancel</button
  >
  <button
    class="foot-button primary"
    type="button"
    bind:this={confirmButton}
    aria-describedby={noteId}
    aria-disabled={stagedModel === "" || switching !== undefined}
    onclick={() => void confirm()}
  >
    {otherHarness
      ? "Open a new session"
      : switching !== undefined
        ? "Switching…"
        : "Use for this session"}
  </button>
{/snippet}

{#if pinned === null}
  <!-- A new session's model, picked as it is made: `App`'s import pick. -->
  <ModelSelector
    instances={app.harnesses}
    active={app.importInstance}
    model={app.effectiveImportModel}
    modelView={app.importModelView}
    descriptors={app.importModelDescriptors}
    selections={app.pickedImportModelOptions}
    dropped={app.droppedImportModelOptions}
    {harness}
    bind:open={app.importPickerOpen}
    bind:query={app.importModelQuery}
    bind:trigger
    onOpen={() => app.toggleImportPicker()}
    onPickInstance={(instanceId) => app.pickImportInstance(instanceId)}
    onPickModel={(modelId) => app.pickImportModel(modelId)}
    onPickOption={(descriptorId, value) =>
      app.pickImportModelOption(descriptorId, value)}
    chipLabel="Harness and model: {model}"
    onLeave={closesWithBranch}
  >
    {#snippet note()}
      A session is pinned to the harness it starts on. Changing harness starts a
      new session; it never moves this one.
    {/snippet}
  </ModelSelector>
{:else if switchable && sessionInstance !== undefined}
  <!-- A started session's model: staged in the dialog, applied together by its footer. -->
  <ModelSelector
    instances={app.harnesses}
    active={stagedInstance}
    model={stagedModel}
    modelView={stagedModelView}
    descriptors={stagedDescriptors}
    selections={stagedSelections}
    dropped={stagedDropped}
    harness={pinned.harness}
    chipModel={model}
    bind:open={sessionOpen}
    bind:query
    bind:trigger
    onOpen={openSession}
    onPickInstance={pickInstance}
    onPickModel={(modelId) => (stagedModel = modelId)}
    onPickOption={pickOption}
    switching={switching !== undefined}
    chipLabel="Model: {model}. Change this session's model"
    chipTitle="The model this session runs on. Models and reasoning can change at any time, including mid-run; the harness is fixed."
    footer={sessionFooter}
  />
{:else}
  <ModelChip
    kind="held"
    {harness}
    {model}
    title="The model this session ran on. Changing harness starts a new session; it never moves this one."
  />
{/if}

{#if pinned !== null && failure !== undefined}
  <!--
    A refused switch of the session on screen, over its picker while that is still open (it
    stays up while the call is out), so closing it puts the operator back on the choice the
    server refused. Another session's refusal is not drawn here: it waits for its session.
  -->
  <ErrorDialog
    {...failure}
    opener={sessionOpen ? confirmButton : trigger}
    ondismiss={() => app.importer.dismissSwitchFailure(pinned.sessionId)}
  />
{/if}

<style>
  /* ── D6's footer: the note, Cancel, and the one solid action ───────────────── */
  .foot-note {
    flex: 1;
    min-width: 0;
    margin: 0;
    color: var(--text-muted);
    font: 400 11px/16px var(--font-sans);
    text-wrap: pretty;
  }
  .foot-button {
    flex: none;
    height: 30px;
    padding: 0 13px;
    box-sizing: border-box;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-base);
    font: 500 12px/28px var(--font-sans);
    cursor: pointer;
  }
  .foot-button:hover {
    background: var(--overlay-hover);
  }
  /* D6's "Use for this session": the inverse fill, darkened by an inset overlay on hover. */
  .foot-button.primary {
    padding: 0 15px;
    border-color: transparent;
    background: var(--bg-inverse);
    color: var(--text-inverse);
  }
  .foot-button.primary:hover {
    background: var(--bg-inverse);
    box-shadow: inset 0 0 0 999px
      color-mix(in srgb, var(--text-inverse) 12%, transparent);
  }
  .foot-button.primary[aria-disabled="true"] {
    cursor: progress;
    opacity: 0.7;
  }
  .foot-button:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 1px;
  }
</style>
