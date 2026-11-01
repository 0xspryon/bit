<script lang="ts">
  /**
   * The create-target screen (A3).
   *
   * **The dialog became a page, and the folder browser is the only modal left.** A3's own
   * account of why: the picker returns a path and nothing else, so it can be modal without
   * trapping anything, while the form itself now carries a repeatable list and hands over
   * to a progress panel — neither of which fits in a 560px dialog, and the second of which
   * runs for a minute with the operator free to leave.
   *
   * **The `Scope` field is gone and its two jobs are split.** It read `Scope` with the
   * placeholder `*.example.test`, which promised a machine-readable pattern; nothing ever
   * parsed it. What replaced it: program links, which feed the importer, and a plainly
   * labelled Note for people. Links are optional and the primary button never renames, so
   * a target with no program page is still one click.
   *
   * **Nothing on this screen starts a hunt**, and that is load-bearing rather than tidy.
   * D13 records that the operator's review of an imported scope is the only control on it,
   * and that the review is a real step only because creating a target starts no work. There
   * is deliberately no "start hunting" affordance here, and adding one would mean turning
   * the review into an explicit confirmation step first.
   */
  import Button from "../components/Button.svelte";
  import Field from "../components/Field.svelte";
  import FolderPicker from "../components/FolderPicker.svelte";
  import ScopeImportPanel from "../components/ScopeImportPanel.svelte";
  import { IconClose, IconFolder, IconLink, IconPlus } from "../icons";
  import { SCOPE_IMPORT_MAX_LINKS } from "@bit/contracts";
  import type { App } from "../app.svelte";

  let { app }: { app: App } = $props();

  let canCreate = $derived(
    app.dialogChosen !== "" &&
      app.dialogName !== "" &&
      app.createState !== "duplicate" &&
      app.createState !== "denied" &&
      app.createState !== "creating",
  );

  /** The file the chosen folder and name will actually produce, restated for the operator. */
  let resolvedFile = $derived(
    app.dialogChosen === "" || app.dialogName === ""
      ? ""
      : `${app.dialogChosen}/${app.dialogName}-<id>/hunt.sqlite`,
  );

  /** Whether the autoload checkbox can be offered at all. */
  let canAutoload = $derived(app.importerModel !== undefined);
</script>

{#if app.newTargetPhase === "importing"}
  <div class="page">
    <ScopeImportPanel {app} />
  </div>
{:else}
  <div class="page">
    <form
      class="form"
      onsubmit={(event) => {
        event.preventDefault();
        if (canCreate) void app.createTarget();
      }}
    >
      <div class="titles">
        <h1>New target</h1>
        <p class="lead">
          Start from the program's own pages. The intake agent reads them and
          loads the scope and the assets they name; the Assets page is where you
          correct it.
        </p>
      </div>

      <!-- Folder: a read-only restatement plus a browse button. The path is not typed
           here any more — the picker is where a path is chosen or typed, and it validates
           server-side on every change. -->
      <div class="field">
        <div class="label-row">
          <span class="label">Folder</span>
          <span class="hint">
            where this target's hunt database is written
          </span>
        </div>
        <div class="folder-row">
          <div class="folder">
            <span class="icon"><IconFolder width="14" height="14" /></span>
            <span class="folder-path mono">
              {app.dialogChosen === "" ? "No folder chosen" : app.dialogChosen}
            </span>
          </div>
          <Button variant="outline" onclick={() => app.openFolderPicker()}>
            Browse…
          </Button>
        </div>
        {#if resolvedFile !== ""}
          <span class="resolved mono">{resolvedFile}</span>
        {/if}
      </div>

      <Field
        id="target-name"
        label="Name"
        bind:value={app.dialogName}
        disabled={app.createState === "creating"}
      />

      <!-- Program links: a repeatable optional list. -->
      <div class="field">
        <div class="label-row">
          <span class="label">Program links</span>
          <span class="hint">optional</span>
        </div>
        <ul class="links">
          {#each app.programLinks as link (link.id)}
            <li class="link-row">
              <div class="link">
                <span class="icon"><IconLink width="13" height="13" /></span>
                <input
                  class="link-input mono"
                  type="url"
                  placeholder="https://hackerone.com/acme/policy"
                  value={link.url}
                  disabled={app.createState === "creating"}
                  aria-label="Program link"
                  oninput={(event) =>
                    app.setProgramLink(link.id, event.currentTarget.value)}
                />
              </div>
              <button
                type="button"
                class="remove"
                aria-label={`Remove ${link.url === "" ? "this link" : link.url}`}
                disabled={app.createState === "creating"}
                onclick={() => app.removeProgramLink(link.id)}
              >
                <IconClose width="13" height="13" />
              </button>
            </li>
          {/each}
        </ul>
        {#if app.programLinks.length < SCOPE_IMPORT_MAX_LINKS}
          <button
            type="button"
            class="add-link"
            disabled={app.createState === "creating"}
            onclick={() => app.addProgramLink()}
          >
            <IconPlus width="13" height="13" />
            <span>Add another link</span>
          </button>
        {/if}
        <span class="hint wrap">
          A scope table and a policy page often disagree. Paste both — the
          disagreement is worth seeing.
        </span>
      </div>

      <!-- The autoload checkbox, and the model picker it reveals. -->
      <div class="autoload">
        <label class="choice">
          <input
            type="checkbox"
            checked={app.autoloadScope}
            disabled={!canAutoload || app.createState === "creating"}
            onchange={() => app.toggleAutoload()}
          />
          <span class="choice-body">
            <span class="choice-title">Read the pages and load the scope</span>
            <span class="choice-more">
              An intake agent reads each link with its own browser, writes the
              in and out lists as scope entries, and records the hosts they name
              as assets. Nothing is tested and no hunt is started — review and
              adjust anything on the Assets page afterwards.
            </span>
          </span>
        </label>

        {#if !canAutoload}
          <!-- No harness, so no import can run. Said here rather than leaving the
               checkbox enabled and letting the operator paste links nothing will read. -->
          <p class="unavailable" role="status">
            {app.importModelDetail === ""
              ? "No agent harness is ready, so program pages cannot be read."
              : app.importModelDetail}
          </p>
        {:else if app.showImportModel}
          <!--
            The picker appears with the checkbox and hides with it, because a model choice
            with no agent to run is a control for nothing (D15).

            The model it shows is the server's answer, resolved against the live catalogue.
            Nothing here holds a model id: `modelOption.ts` is explicit that a descriptor
            is observed when the server built its harnesses and replaced wholesale when
            they are rebuilt, so an id written into this bundle would outlive the catalogue
            entry it names and this control would offer a choice the server could not
            honour.
          -->
          <div class="model">
            <div class="label-row">
              <span class="label">Model</span>
              <span class="hint">
                {app.importerModel?.origin === "fallback"
                  ? "resolved by fallback"
                  : "resolved from the catalogue"}
              </span>
            </div>
            <div class="model-row">
              <button
                type="button"
                class="model-trigger"
                aria-haspopup="listbox"
                aria-expanded={app.importPickerOpen}
                onclick={() => app.toggleImportPicker()}
              >
                <span class="mono">{app.effectiveImportModel}</span>
                <span class="model-on">
                  on {app.importInstance?.displayName ??
                    app.importerModel?.instanceId}
                </span>
              </button>
            </div>
            {#if app.importPickerOpen}
              <div class="picker" role="listbox" aria-label="Importer model">
                <label class="search">
                  <input
                    class="search-input"
                    type="text"
                    placeholder="Filter models"
                    bind:value={app.importModelQuery}
                    aria-label="Filter models"
                  />
                </label>
                {#if app.harnesses.length > 1}
                  <div class="instances">
                    {#each app.harnesses as instance (instance.instanceId)}
                      <button
                        type="button"
                        class={[
                          "instance",
                          instance.instanceId ===
                            app.importInstance?.instanceId && "picked",
                        ]}
                        disabled={!instance.ready}
                        onclick={() =>
                          app.pickImportInstance(instance.instanceId)}
                      >
                        {instance.displayName}
                      </button>
                    {/each}
                  </div>
                {/if}
                <ul class="model-list">
                  {#each app.importModelOptions as model (model.id)}
                    <li>
                      <button
                        type="button"
                        class={[
                          "model-option",
                          model.id === app.effectiveImportModel && "picked",
                        ]}
                        role="option"
                        aria-selected={model.id === app.effectiveImportModel}
                        onclick={() => app.pickImportModel(model.id)}
                      >
                        <span class="mono">{model.id}</span>
                      </button>
                    </li>
                  {/each}
                  {#if app.importModelOptions.length === 0}
                    <li class="model-empty">
                      No model on this harness matches that.
                    </li>
                  {/if}
                </ul>
              </div>
            {/if}
            <span class="hint wrap">{app.importerModel?.detail}</span>
          </div>
        {/if}
      </div>

      <!--
        A note for people, and presented as one.

        It used to read `Scope` with the placeholder `*.example.test`, which promised a
        machine-readable pattern: nothing has ever parsed this field, and the structured
        scope that the agent *is* told about lives on the target's own Scope tab, typed per
        entry with what each one covers spelled out. A field shaped like a wildcard rule is
        how an operator comes to believe they have authored a boundary they have not — so it
        is plainly a description now, and not mono.
      -->
      <Field
        id="target-scope"
        label="Note"
        placeholder="Engagement window, client contacts, anything the program page does not say…"
        bind:value={app.dialogScope}
        disabled={app.createState === "creating"}
      />

      {#if app.createState === "duplicate"}
        <div class="alert warning" role="alert">
          <strong>Already a target.</strong>
          {app.createDetail}. Open it instead?
          <div class="alert-action">
            <Button
              size="sm"
              onclick={() => {
                app.select(app.duplicateOf);
                app.openTarget(app.duplicateOf);
              }}>Open {app.duplicateOf}</Button
            >
          </div>
        </div>
      {/if}

      {#if app.createState === "denied"}
        <div class="alert warning" role="alert">
          <strong>That folder cannot be used.</strong>
          {app.createDetail} Choose another folder, or grant access and try again.
        </div>
      {/if}

      {#if app.createState === "failed"}
        <div class="alert danger" role="alert">
          <strong>This target could not be prepared.</strong> It is registered
          and listed, but its database did not migrate, so it shows as
          unavailable in the rail. Your other targets are unaffected and still
          open.
          <code class="mono trace">{app.createDetail}</code>
        </div>
      {/if}

      <div class="actions">
        <Button
          variant="primary"
          type="submit"
          disabled={!canCreate}
          loading={app.createState === "creating"}
        >
          {app.createState === "creating" ? "Preparing…" : "Create target"}
        </Button>
        <Button variant="quiet" onclick={() => app.cancelNewTarget()}>
          Cancel
        </Button>
      </div>
    </form>
  </div>
{/if}

{#if app.folderPickerOpen}
  <FolderPicker {app} />
{/if}

<style>
  .page {
    flex: 1;
    min-height: 0;
    display: flex;
    justify-content: center;
    overflow: auto;
    padding: 44px 56px;
    background: var(--bg-base);
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 26px;
    width: 100%;
    max-width: 720px;
  }
  .titles {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .titles h1 {
    margin: 0;
    font-size: 28px;
    line-height: 34px;
    font-weight: 530;
    letter-spacing: -0.01em;
    color: var(--text-base);
  }
  .lead {
    margin: 0;
    font-size: 13px;
    line-height: 20px;
    color: var(--text-muted);
    text-wrap: pretty;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .label-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .label {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-base);
  }
  .hint {
    font-size: 11px;
    line-height: 16px;
    color: var(--text-faint);
  }
  .hint.wrap {
    color: var(--text-muted);
    text-wrap: pretty;
  }
  .folder-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .folder {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 9px;
    height: 44px;
    padding: 0 12px;
    box-sizing: border-box;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    background: var(--bg-deep);
  }
  .folder-path {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    color: var(--text-base);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .icon {
    display: inline-flex;
    align-items: center;
    flex: none;
    color: var(--icon-muted);
  }
  .resolved {
    font-size: 11px;
    line-height: 17px;
    color: var(--text-faint);
    overflow-wrap: anywhere;
  }
  .links {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .link-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .link {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 9px;
    height: 44px;
    padding: 0 12px;
    box-sizing: border-box;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    background: var(--bg-layer-01);
  }
  .link-input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--text-base);
    /* 16px keeps iOS from zooming, which is `Field`'s reason too. */
    font-size: 16px;
    font-family: var(--font-mono);
  }
  .link-input:focus {
    outline: none;
  }
  .link:focus-within {
    border-color: var(--border-focus);
  }
  .remove,
  .add-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--icon-faint);
    cursor: pointer;
  }
  .remove {
    flex: none;
    width: 30px;
    height: 30px;
  }
  .remove:hover:not(:disabled) {
    background: var(--overlay-pressed);
    color: var(--icon-base);
  }
  .add-link {
    gap: 9px;
    height: 44px;
    padding: 0 12px;
    box-sizing: border-box;
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-md);
    color: var(--text-muted);
    font-size: 13px;
    width: calc(100% - 36px);
  }
  .add-link:hover:not(:disabled) {
    background: var(--overlay-hover);
    color: var(--text-base);
  }
  .remove:disabled,
  .add-link:disabled {
    cursor: default;
    opacity: 0.5;
  }
  .autoload {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .choice {
    display: flex;
    gap: 11px;
    padding: 13px;
    box-sizing: border-box;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    background: var(--bg-base);
    cursor: pointer;
  }
  .choice input {
    flex: none;
    margin: 2px 0 0;
    accent-color: var(--bg-inverse);
  }
  .choice-body {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .choice-title {
    font-size: 12px;
    line-height: 17px;
    font-weight: 500;
    color: var(--text-base);
  }
  .choice-more {
    font-size: 11px;
    line-height: 17px;
    color: var(--text-muted);
    text-wrap: pretty;
  }
  .unavailable {
    margin: 0;
    font-size: 11px;
    line-height: 17px;
    color: var(--state-fg-warning);
    text-wrap: pretty;
  }
  .model {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-left: 26px;
  }
  .model-row {
    display: flex;
  }
  .model-trigger {
    display: flex;
    align-items: baseline;
    gap: 9px;
    height: 36px;
    padding: 0 12px;
    box-sizing: border-box;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    background: var(--bg-layer-01);
    color: var(--text-base);
    font-size: 13px;
    cursor: pointer;
  }
  .model-trigger:hover {
    background: var(--overlay-hover);
  }
  .model-on {
    font-size: 11px;
    color: var(--text-faint);
  }
  .picker {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--bg-deep);
  }
  .search-input {
    width: 100%;
    box-sizing: border-box;
    height: 32px;
    padding: 0 10px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-sm);
    background: var(--bg-layer-01);
    color: var(--text-base);
    font-size: 13px;
  }
  .instances {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .instance {
    padding: 4px 9px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    font-size: 11px;
    cursor: pointer;
  }
  .instance.picked {
    background: var(--bg-layer-02);
    color: var(--text-base);
  }
  .instance:disabled {
    cursor: default;
    opacity: 0.5;
  }
  .model-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin: 0;
    padding: 0;
    max-height: 200px;
    overflow: auto;
    list-style: none;
  }
  .model-option {
    width: 100%;
    display: flex;
    padding: 6px 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-base);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .model-option:hover {
    background: var(--overlay-hover);
  }
  .model-option.picked {
    background: var(--bg-layer-02);
  }
  .model-empty {
    padding: 6px 8px;
    font-size: 11px;
    color: var(--text-faint);
  }
  .alert {
    padding: 12px 14px;
    border-radius: var(--radius-md);
    font-size: 12px;
    line-height: var(--lh-base);
  }
  .alert strong {
    font-weight: 600;
  }
  .warning {
    border: 1px solid var(--state-border-warning);
    background: var(--state-bg-warning);
    color: var(--state-fg-warning);
  }
  .danger {
    border: 1px solid var(--state-border-danger);
    background: var(--state-bg-danger);
    color: var(--state-fg-danger);
  }
  .alert-action {
    margin-top: 10px;
  }
  .trace {
    display: block;
    margin-top: 8px;
    font-size: 11px;
    opacity: 0.85;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 10px;
    padding-top: 2px;
  }

  /* Tablet widths and up is the target. At the narrow end the folder row stacks rather
     than squeezing the path to nothing. */
  @media (width < 700px) {
    .page {
      padding: 24px 20px;
    }
    .folder-row {
      flex-direction: column;
      align-items: stretch;
    }
  }
</style>
