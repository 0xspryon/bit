<script lang="ts">
  /**
   * The create-target screen (A3).
   *
   * **The dialog became a page, and the folder browser is the only modal left.** A3's own
   * account of why: the picker returns a path and nothing else, so it can be modal without
   * trapping anything.
   *
   * **A target is made from a folder, a name and a note, and nothing else.** It used to take
   * program links and a model for the scope importer too; A6 moved the importer to the
   * Assets page ("Auto-load scope…"), where the target already exists and a session can be
   * had with it in hand. Nothing here reads a program page.
   *
   * **The `Scope` field is gone, and its job is a plainly labelled Note for people.** It
   * read `Scope` with the placeholder `*.example.test`, which promised a machine-readable
   * pattern; nothing ever parsed it. The structured scope lives on the target's own Scope
   * tab, typed per entry.
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
  import { IconFolder } from "../icons";
  import type { App } from "../app.svelte";

  let { app }: { app: App } = $props();

  let canCreate = $derived(
    app.dialogChosen !== "" &&
      app.dialogName !== "" &&
      app.createState !== "duplicate" &&
      app.createState !== "denied" &&
      app.createState !== "unusable" &&
      app.createState !== "creating",
  );

  /**
   * The directory the hunt database actually goes in, which is **not** the chosen folder.
   *
   * This line used to preview `<chosen folder>/<name>-<id>/hunt.sqlite`, and no such file
   * has ever been written: `fleet.paths.huntFile` is `<fleet root>/targets/<id>/hunt.sqlite`
   * (`persistence/fleet.ts`), so the folder the operator nominates is left empty. The claim
   * was load-bearing rather than cosmetic. An operator who reads "the database is written
   * here" has no reason to suspect that the folder they choose has anything to do with
   * `HUNT_ROOT` — which is how one comes to nominate a folder containing it and gets a
   * target that cannot plan, converse or import, refused by the very screen that promised
   * the database would land somewhere else.
   *
   * It names the directory and not the file. The id is `toTargetId(name)`, derived on the
   * server, and the layout constants are in `persistence/fleet.ts`; spelling the whole
   * path here would mean a second implementation of both, and a second implementation of
   * this path is exactly how the first wrong preview came about. The fleet root is the
   * server's own answer (`SessionProbe.fleetRoot`), and until it arrives the sentence is
   * told without a path rather than with a guessed one.
   */
  let databaseDirectory = $derived(
    app.fleetRoot === "" ? "" : `${app.fleetRoot}/targets/`,
  );
</script>

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
        Point it at the engagement's folder and give it a name. The scope is
        loaded afterwards, from the Assets page.
      </p>
    </div>

    <!-- Folder: a read-only restatement plus a browse button. The path is not typed
           here any more — the picker is where a path is chosen or typed, and it validates
           server-side on every change. -->
    <div class="field">
      <div class="label-row">
        <span class="label">Workspace folder</span>
        <span class="hint">
          the engagement workspace: where this target's workers run
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
      <!-- Said whether or not a folder is chosen: it is a fact about the field, and the
             operator needs it *before* choosing, not after being refused. -->
      <span class="resolved">
        This target's hunt database is written
        {#if databaseDirectory === ""}
          with this server's own fleet data, not in the workspace folder.
        {:else}
          under <span class="mono">{databaseDirectory}</span>, not in the
          workspace folder.
        {/if}
      </span>
    </div>

    <Field
      id="target-name"
      label="Name"
      bind:value={app.dialogName}
      disabled={app.createState === "creating"}
    />

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

    <!--
        The folder cannot be read — and a refusal this screen has not heard of.

        It carries a way out of its own now. It did not, and `invalid_name` landed here:
        an operator who typed `###` was told three things about their folder, none of them
        the problem, with Create disabled and no button on screen. The name has its own
        state below; what still lands here is a folder the server may not read and any
        reason a newer server adds, and neither may leave the operator with nothing to
        press.
      -->
    {#if app.createState === "denied"}
      <div class="alert warning" role="alert">
        <strong>That folder cannot be used.</strong>
        {app.createDetail} Grant access to it and choose it again, or pick a different
        one.
        <div class="alert-action">
          <Button size="sm" onclick={() => app.openFolderPicker()}>
            Choose another folder
          </Button>
        </div>
      </div>
    {/if}

    <!--
        The name, reported as the name.

        Create stays enabled here, which is the whole point: the field that fixes this is
        on screen and editing it clears this state (`App`'s `dialogName` setter), so the
        operator corrects the name and creates the target. Every other refusal names a
        folder; this one must not, because nothing about the folder is wrong.
      -->
    {#if app.createState === "invalid-name"}
      <div class="alert warning" role="alert">
        <strong>That name cannot be used.</strong>
        {app.createDetail}. Edit the name above and create the target again.
      </div>
    {/if}

    <!--
        The folder is readable and still cannot host a target.

        Its own state rather than the one above, because "try again" is wrong here: the
        folder contains this server's fleet root, so every planner, goal and import
        session on the target would be refused where it starts. The server's sentence
        carries both ways out — a different folder, or a different `HUNT_ROOT` — so this
        adds no advice of its own, and the picker is reopened rather than described.
      -->
    {#if app.createState === "unusable"}
      <div class="alert warning" role="alert">
        <strong>That folder cannot hold a target.</strong>
        {app.createDetail}.
        <div class="alert-action">
          <Button size="sm" onclick={() => app.openFolderPicker()}>
            Choose another folder
          </Button>
        </div>
      </div>
    {/if}

    {#if app.createState === "failed"}
      <div class="alert danger" role="alert">
        <strong>This target could not be prepared.</strong> It is registered and
        listed, but its database did not migrate, so it shows as unavailable in
        the rail. Your other targets are unaffected and still open.
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
