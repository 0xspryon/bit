<script lang="ts">
  /**
   * Auto-load scope: the importer's page, reached from Assets (A6 D1).
   *
   * **A page, not a dialog.** D1 is explicit that it "opens a full importer session with
   * the target already in hand", so this is a sub-page of the Assets section — the target,
   * its rail and its crumbs are all still there, and nothing about the target is asked for
   * again. It is not a screen of its own: that would be a second place the target could be
   * half-open in.
   *
   * ## What it is today, and what it is for
   *
   * The form and the panel the create-target page used to carry, relocated and pointed at a
   * target that already exists: the program links, the model, and then the "Loading the
   * scope" panel once the import is going. **Nothing here is a chat.** A6 D2–D5 turn this
   * page into one — multi-turn, streaming, with a session picker — and that waits on how a
   * session's history can be read back. Until then the importer is single-turn and polled,
   * exactly as it was, and the one thing this slice changes about it is where it starts.
   *
   * ## Why the links and the model moved with it
   *
   * They were on the create-target page because the import could only be started by
   * creating a target. The server now starts one against an existing target
   * (`POST /targets/:id/scope-import`), so the create-target page asks for a folder, a name
   * and a note, and an operator reaches the importer by choosing to — from an empty Scope
   * tab, or from the Scope tab's header once it has entries.
   *
   * **Starting it starts no hunt**, for the reason on the create-target page (D13): the
   * operator's review of what the importer wrote is the only control on it, and that review
   * is a real step only because an import never begins work.
   */
  import { SCOPE_IMPORT_MAX_LINKS } from "@bit/contracts";

  import type { App } from "../app.svelte";
  import Banner from "../components/Banner.svelte";
  import Button from "../components/Button.svelte";
  import HarnessChoice from "../components/HarnessChoice.svelte";
  import PageFrame from "../components/PageFrame.svelte";
  import ScopeImportPanel from "../components/ScopeImportPanel.svelte";
  import { IconClose, IconLink, IconPlus } from "../icons";

  let { app }: { app: App } = $props();

  /** Whether an import can be started at all: the server named a model it would run on. */
  let canImport = $derived(app.importerModel !== undefined);
  let target = $derived(app.selected?.name ?? app.viewTargetId);
</script>

<PageFrame
  title="Auto-load scope"
  description={app.importerPhase === "importing"
    ? `The importer is reading the program's pages for ${target}.`
    : `Hand the program's pages to the importer. It reads each one with its own browser, writes the in and out lists as scope entries, and records the hosts they name as assets on ${target}.`}
  centered={app.drawerHidden}
>
  {#snippet actions()}
    <Button
      variant="outline"
      size="page"
      onclick={() => app.toSection("assets")}
    >
      Back to Assets
    </Button>
  {/snippet}

  {#snippet body()}
    {#if app.importerPhase === "importing"}
      <ScopeImportPanel {app} />
    {:else}
      <form
        class="form"
        onsubmit={(event) => {
          event.preventDefault();
          if (canImport && app.usableLinks.length > 0) {
            void app.startScopeImport();
          }
        }}
      >
        <div class="field">
          <div class="label-row">
            <span class="label">Program links</span>
            <span class="hint">one or more pages</span>
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
                    disabled={app.importStarting}
                    aria-label="Program link"
                    oninput={(event) =>
                      app.setProgramLink(link.id, event.currentTarget.value)}
                  />
                </div>
                <button
                  type="button"
                  class="remove"
                  aria-label={`Remove ${link.url === "" ? "this link" : link.url}`}
                  disabled={app.importStarting}
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
              disabled={app.importStarting}
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

        {#if !canImport}
          <!-- No harness, so no import can run. Said here rather than leaving Start
               enabled and letting the operator paste links nothing will read. -->
          <p class="unavailable" role="status">
            {app.importModelDetail === ""
              ? "No agent harness is ready, so program pages cannot be read."
              : app.importModelDetail}
          </p>
        {:else}
          <!--
            The model the import will run on.

            It is the server's answer, resolved against the live catalogue (D15). Nothing
            here holds a model id: `modelOption.ts` is explicit that a descriptor is
            observed when the server built its harnesses and replaced wholesale when they
            are rebuilt, so an id written into this bundle would outlive the catalogue
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
              <!-- The same columns the composer's picker has, from one component. -->
              <HarnessChoice
                layout="inline"
                instances={app.harnesses}
                active={app.importInstance}
                model={app.effectiveImportModel}
                bind:query={app.importModelQuery}
                onPickInstance={(instanceId) =>
                  app.pickImportInstance(instanceId)}
                onPickModel={(modelId) => app.pickImportModel(modelId)}
                onDismiss={() => (app.importPickerOpen = false)}
              >
                {#snippet note()}
                  An import is pinned to the harness it starts on, like a run.
                  Nothing here starts one.
                {/snippet}
              </HarnessChoice>
            {/if}
            <span class="hint wrap">{app.importerModel?.detail}</span>
          </div>
        {/if}

        {#if app.importStartDetail !== ""}
          <!-- Why nothing started, in the server's words. The form stays, so the links
               are still there to fix or try again. -->
          <Banner tone="danger">{app.importStartDetail}</Banner>
        {/if}

        <p class="aside">
          Nothing is tested and no hunt is started. Review and adjust anything
          on the Assets page afterwards.
        </p>

        <div class="actions">
          <Button
            variant="primary"
            type="submit"
            disabled={!canImport || app.usableLinks.length === 0}
            loading={app.importStarting}
          >
            {app.importStarting ? "Starting…" : "Start import"}
          </Button>
        </div>
      </form>
    {/if}
  {/snippet}
</PageFrame>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 22px;
    max-width: 720px;
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
  .icon {
    display: inline-flex;
    align-items: center;
    flex: none;
    color: var(--icon-muted);
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
    font-size: 13px;
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
  .aside {
    margin: 0;
    font-size: 12px;
    line-height: 18px;
    color: var(--text-muted);
    text-wrap: pretty;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 10px;
  }
</style>
