<script lang="ts">
  /**
   * The estate, inside the frame that explains it. A4's two tabs.
   *
   * Scope is a label, not a gate. Every discovered artefact is kept and shown — in scope,
   * excluded, or covered by nothing — and every verdict says who decided it: an entry the
   * operator typed, a label they set by hand, or the default. Nothing on this screen
   * hides a row.
   *
   * ## Three states, three sentences
   *
   * The filled chip is in scope, the outline chip is excluded on purpose, and the dashed
   * chip is covered by nothing. The dashed group is the only one carrying an action on its
   * header, because it is the only one asking the operator for a decision. Every chip is
   * followed by the sentence that decided it, so "excluded by you", "excluded by hand" and
   * "never covered" never collapse into one another.
   *
   * **Colour stays out of it entirely: out of scope is not an error.** The one place
   * danger red appears is the contradiction refusal on the Scope tab, which is the one
   * refusal in the flow.
   *
   * ## Where the sentences come from
   *
   * `describeScopeEntry` and `describeScopeState` are imported from `@bit/contracts` —
   * the same functions the prompt block is built from. That is the one-renderer rule
   * holding across the boundary rather than being restated here: an entry shown as bare
   * text in one place and as its reach in another is how an operator comes to believe
   * `acme.test` means one host.
   *
   * The Scope tab's preview panel does **not** re-render the block. It shows
   * `scope.promptBlock`, which the server produced from the same function both prompt
   * paths call, so what the operator checks is the bytes the agent gets.
   */
  import {
    ASSET_LABEL_REACH,
    describeScopeEntry,
    describeScopeState,
    HOST_LABEL_REACH,
    type AssetView,
    type ScopeKind,
    type ScopeState,
  } from "@bit/contracts";

  import type { App } from "../app.svelte";
  import Banner from "../components/Banner.svelte";
  import Button from "../components/Button.svelte";
  import PageFrame from "../components/PageFrame.svelte";
  import { IconClose, IconCube, IconPlus, IconSearch } from "../icons";

  let { app }: { app: App } = $props();

  /**
   * The entry field, so the empty state's button can reach it.
   *
   * The panel that carries "Add the first entry" is the Scope tab's right-hand column and
   * the field is its left-hand one, both mounted together, so the button hands the
   * operator the thing it names rather than setting a state flag. Before this it assigned
   * `entryValue = ""` to an already-empty field, which is the design's "action that
   * appears to work and does nothing" on the first screen a new target shows.
   */
  let entryField = $state<HTMLInputElement | undefined>(undefined);

  let scope = $derived(app.viewScope);
  let tally = $derived(app.estateTally);
  let groups = $derived(app.shownEstateGroups);

  /** Which chip a state gets. The three sentences, as three shapes. */
  const chipOf = (state: ScopeState): "in" | "out" | "uncovered" =>
    state.state === "in"
      ? "in"
      : state.by._tag === "default"
        ? "uncovered"
        : "out";

  const chipLabel = (state: ScopeState): string =>
    chipOf(state) === "in"
      ? "In scope"
      : chipOf(state) === "out"
        ? "Excluded"
        : "Not covered";

  /**
   * What a row shows instead of a path.
   *
   * A host row has no path, and showing an empty cell for it would make the two kinds
   * look like one with missing data. Its identity is `host:port`, which is what it is.
   */
  const rowLabel = (asset: AssetView): string =>
    asset.kind === "endpoint"
      ? `${asset.method ?? ""} ${asset.path ?? "/"}`.trim()
      : asset.identity;

  /** Who found it, for the provenance column. */
  const foundBy = (asset: AssetView): string =>
    asset.scope.by._tag === "assetLabel"
      ? "by hand"
      : asset.firstAttemptId === null
        ? "no recorded discovery"
        : `via ${asset.firstAttemptId.slice(0, 11)}`;

  const KINDS: ReadonlyArray<{
    readonly id: ScopeKind;
    readonly label: string;
  }> = [
    { id: "subtree", label: "Apex and subdomains" },
    { id: "host", label: "Host only" },
    { id: "cidr", label: "Address block" },
  ];

  const FILTERS = [
    { id: "all", label: "All" },
    { id: "in", label: "In scope" },
    { id: "out", label: "Excluded" },
    { id: "uncovered", label: "Not covered" },
  ] as const;
</script>

<PageFrame
  title="Assets"
  description={app.assetsTab === "estate"
    ? "Everything the hunt has found on this target. Nothing here is hidden or dropped — a host no entry covers is kept and labelled, waiting for you."
    : "The client's estate, as you authored it. These entries are only ever typed by you — nothing the agent does writes here."}
  centered={app.drawerHidden}
>
  {#snippet filters()}
    <div class="tabs" role="tablist" aria-label="Assets views">
      <button
        role="tab"
        aria-selected={app.assetsTab === "estate"}
        class={["tab", app.assetsTab === "estate" && "on"]}
        onclick={() => app.toAssetsTab("estate")}>Estate</button
      >
      <button
        role="tab"
        aria-selected={app.assetsTab === "scope"}
        class={["tab", app.assetsTab === "scope" && "on"]}
        onclick={() => app.toAssetsTab("scope")}>Scope</button
      >
    </div>
  {/snippet}

  {#snippet body()}
    {#if app.assetsTab === "estate"}
      {#if app.assetsState === "failed"}
        <div class="notice">
          <Banner tone="danger">{app.assetsDetail}</Banner>
          <Button onclick={() => void app.loadAssets(app.viewTargetId)}>
            Try again
          </Button>
        </div>
      {:else if app.estateRows.length === 0 && app.assetsState !== "ready"}
        <p class="quiet" role="status">Reading this target's estate…</p>
      {:else if app.estateRows.length === 0}
        <div class="empty">
          <IconCube width="28" height="28" />
          <p class="empty-lead">Nothing found on this target yet.</p>
          <p class="empty-more">
            A worker records what it finds with <span class="mono"
              >record_asset</span
            >, and every discovery lands here — in scope, excluded, or covered
            by nothing.
          </p>
        </div>
      {:else}
        <!--
          A refused promote or exclude, beside the rows it was aimed at.

          This has to be here as well as on the Scope tab: the control that produces it
          lives on *this* tab, and a refusal rendered only on the other one would make the
          click look like it had worked and done nothing — which is the anti-goal about an
          operator action that appears to succeed. The server refused and changed nothing,
          so the list below is still correct and stays on screen.
        -->
        {#if app.scopeRefusal !== ""}
          <div
            class={[
              "refusal",
              "estate-refusal",
              app.scopeRefusalContradiction && "contradiction",
            ]}
            role="alert"
          >
            {app.scopeRefusal}
          </div>
        {/if}

        <!-- The four filters, with the count each would show. Nothing is removed from
             what was read: these change the view, not the estate. -->
        <div class="chips">
          {#each FILTERS as filter (filter.id)}
            <button
              class={[
                "filter",
                app.estateFilter === filter.id && "on",
                filter.id === "uncovered" && "dashed",
              ]}
              aria-pressed={app.estateFilter === filter.id}
              onclick={() => (app.estateFilter = filter.id)}
            >
              <span>{filter.label}</span>
              <span class="tally mono">{tally[filter.id]}</span>
            </button>
          {/each}
          <div class="spacer"></div>
          <label class="search">
            <IconSearch width="13" height="13" />
            <input
              type="text"
              bind:value={app.estateQuery}
              placeholder="Filter host or path…"
              aria-label="Filter host or path"
            />
          </label>
        </div>

        {#if groups.length === 0}
          <p class="quiet" role="status">
            No asset matches that filter. {tally.all}
            {tally.all === 1 ? "asset is" : "assets are"} recorded on this target.
          </p>
        {/if}

        <div class="groups">
          {#each groups as group (group.host)}
            <section class="group">
              <header class={["host", chipOf(group.scope)]}>
                <span class="host-name mono">{group.host}</span>
                <span class={["chip", chipOf(group.scope)]}
                  >{chipLabel(group.scope)}</span
                >
                <!-- The sentence that decided it, from the same renderer the agent's
                     prompt uses. -->
                <span class="why mono">{describeScopeState(group.scope)}</span>
                <div class="spacer"></div>
                <span class="count mono"
                  >{group.rows.length}
                  {group.rows.length === 1 ? "asset" : "assets"}</span
                >
                <!-- One control, two directions. The host option covers every asset on
                     it, now and later, which is what makes an exclusion mean what the
                     operator meant by it. -->
                <!-- Every option states what it reaches, from the same clause the Scope
                     tab's hand labels and the agent's prompt use. "And later" is the part
                     a button cannot imply on its own, and it is what makes an exclusion
                     mean what the operator meant by it. -->
                <span class="action">
                  {#if group.scope.state === "in"}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={app.scopeBusy}
                      onclick={() =>
                        void app.labelScope({
                          subject: { _tag: "host", host: group.host },
                          state: "out",
                        })}
                    >
                      Exclude host
                    </Button>
                  {:else}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={app.scopeBusy}
                      onclick={() =>
                        void app.labelScope({
                          subject: { _tag: "host", host: group.host },
                          state: "in",
                        })}
                    >
                      Promote host
                    </Button>
                  {/if}
                  <span class="reach">{HOST_LABEL_REACH}</span>
                </span>
                {#if group.scope.by._tag === "hostLabel"}
                  <Button
                    size="sm"
                    variant="quiet"
                    disabled={app.scopeBusy}
                    onclick={() =>
                      void app.labelScope({
                        subject: { _tag: "host", host: group.host },
                        state: "cleared",
                      })}
                  >
                    Clear label
                  </Button>
                {/if}
              </header>

              <ul class="rows">
                {#each group.rows as asset (asset.assetId)}
                  <li class="row">
                    <span class="what mono">{rowLabel(asset)}</span>
                    <span class="kind">{asset.kind}</span>
                    <span class="found mono">{foundBy(asset)}</span>
                    <span class="seen mono"
                      >{asset.discoveries}
                      {asset.discoveries === 1 ? "sighting" : "sightings"}</span
                    >
                    <!-- A row whose own label decided it says so, and says which entry it
                         beat. Rows that merely inherit the host's say that instead, so
                         the two are never read as the same decision. -->
                    {#if asset.scope.by._tag === "assetLabel"}
                      <span class={["chip", chipOf(asset.scope)]}
                        >{chipLabel(asset.scope)}</span
                      >
                      <span class="why mono"
                        >{describeScopeState(asset.scope)}</span
                      >
                      <Button
                        size="sm"
                        variant="quiet"
                        disabled={app.scopeBusy}
                        onclick={() =>
                          void app.labelScope({
                            subject: { _tag: "asset", assetId: asset.assetId },
                            state: "cleared",
                          })}
                      >
                        Clear
                      </Button>
                    {:else}
                      <span class="why mono">inherits host</span>
                      <span class="action">
                        <Button
                          size="sm"
                          variant="quiet"
                          disabled={app.scopeBusy}
                          onclick={() =>
                            void app.labelScope({
                              subject: {
                                _tag: "asset",
                                assetId: asset.assetId,
                              },
                              state: asset.scope.state === "in" ? "out" : "in",
                            })}
                        >
                          {asset.scope.state === "in"
                            ? "Exclude this asset"
                            : "Promote this asset"}
                        </Button>
                        <!-- The narrower of the two directions, and it says so: this row
                             alone, not the host it sits under. -->
                        <span class="reach">{ASSET_LABEL_REACH}</span>
                      </span>
                    {/if}
                  </li>
                {/each}
              </ul>
            </section>
          {/each}
        </div>
      {/if}
    {:else if app.scopeState === "failed"}
      <div class="notice">
        <Banner tone="danger">{app.scopeDetail}</Banner>
        <Button onclick={() => void app.loadScope(app.viewTargetId)}>
          Try again
        </Button>
      </div>
    {:else if scope === undefined}
      <p class="quiet" role="status">Reading this target's scope…</p>
    {:else}
      <div class="scope">
        <div class="lists">
          <!-- The two authored lists. Every row spells out what it covers, in the same
               words the agent's prompt uses, from the same renderer. -->
          {#each [{ effect: "in", heading: "In scope" }, { effect: "out", heading: "Out of scope" }] as section (section.effect)}
            {@const rows = scope.entries.filter(
              (entry) => entry.effect === section.effect,
            )}
            <div class="list">
              <div class="list-head">
                <span class="list-label">{section.heading}</span>
                <span class="mono list-count"
                  >{rows.length} {rows.length === 1 ? "entry" : "entries"}</span
                >
              </div>
              {#if rows.length === 0}
                <p class="quiet-small">None.</p>
              {:else}
                <ul class="entries">
                  {#each rows as entry (entry.entryId)}
                    <li class="entry">
                      <span class="entry-value mono">{entry.value}</span>
                      <span class="entry-covers"
                        >{describeScopeEntry(entry).slice(
                          entry.value.length + 1,
                        )}</span
                      >
                      {#if entry.source === "imported"}
                        <!-- An imported entry and a typed one are identical to the
                             matcher and must be distinguishable here, because "read this
                             list before you start" is only a real step if the rows that
                             need reading are the ones a machine wrote. -->
                        <span class="imported" title={entry.note ?? "Imported"}
                          >Imported</span
                        >
                      {/if}
                      <div class="spacer"></div>
                      <button
                        class="remove"
                        aria-label={`Remove ${entry.value}`}
                        disabled={app.scopeBusy}
                        onclick={() => void app.removeScopeEntry(entry.entryId)}
                      >
                        <IconClose width="13" height="13" />
                      </button>
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
          {/each}

          {#if scope.hostLabels.length > 0 || scope.assetLabels.length > 0}
            <div class="list">
              <div class="list-head">
                <span class="list-label">Set by hand</span>
                <span class="mono list-count"
                  >{scope.hostLabels.length + scope.assetLabels.length}</span
                >
              </div>
              <p class="quiet-small">
                These beat the lists above for the subject they name, and never
                change the lists themselves.
              </p>
              <ul class="entries">
                {#each scope.hostLabels as label (label.host)}
                  <li class="entry">
                    <span class="entry-value mono">{label.host}</span>
                    <span class="entry-covers"
                      >{label.state === "in" ? "in scope" : "excluded"} — {HOST_LABEL_REACH}</span
                    >
                    <div class="spacer"></div>
                    <button
                      class="remove"
                      aria-label={`Clear the label on ${label.host}`}
                      disabled={app.scopeBusy}
                      onclick={() =>
                        void app.labelScope({
                          subject: { _tag: "host", host: label.host },
                          state: "cleared",
                        })}
                    >
                      <IconClose width="13" height="13" />
                    </button>
                  </li>
                {/each}
                {#each scope.assetLabels as label (label.assetId)}
                  <li class="entry">
                    <span class="entry-value mono">{label.identity}</span>
                    <span class="entry-covers"
                      >{label.state === "in" ? "in scope" : "excluded"} — {ASSET_LABEL_REACH}</span
                    >
                    <div class="spacer"></div>
                    <button
                      class="remove"
                      aria-label={`Clear the label on ${label.identity}`}
                      disabled={app.scopeBusy}
                      onclick={() =>
                        void app.labelScope({
                          subject: { _tag: "asset", assetId: label.assetId },
                          state: "cleared",
                        })}
                    >
                      <IconClose width="13" height="13" />
                    </button>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}

          <form
            class="add"
            onsubmit={(event) => {
              event.preventDefault();
              void app.addScopeEntry();
            }}
          >
            <span class="list-label">Add an entry</span>
            <div class="add-row">
              <div class="toggle">
                <button
                  type="button"
                  class={["toggle-half", app.entryEffect === "in" && "on"]}
                  aria-pressed={app.entryEffect === "in"}
                  onclick={() => (app.entryEffect = "in")}>In</button
                >
                <button
                  type="button"
                  class={["toggle-half", app.entryEffect === "out" && "on"]}
                  aria-pressed={app.entryEffect === "out"}
                  onclick={() => (app.entryEffect = "out")}>Out</button
                >
              </div>
              <select
                bind:value={app.entryKind}
                aria-label="What this entry covers"
              >
                {#each KINDS as kind (kind.id)}
                  <option value={kind.id}>{kind.label}</option>
                {/each}
              </select>
              <input
                class="mono value"
                type="text"
                bind:this={entryField}
                bind:value={app.entryValue}
                placeholder="acme.test"
                aria-label="Host, apex or address block"
              />
              <Button
                type="submit"
                variant="primary"
                size="sm"
                loading={app.scopeBusy}
                disabled={app.entryValue.trim() === ""}
              >
                Add
              </Button>
            </div>
            <!-- What this entry will mean, before it is added. The same sentence the row
                 will show and the agent will read. -->
            {#if app.entryValue.trim() !== ""}
              <p class="preview-line mono">
                {describeScopeEntry({
                  kind: app.entryKind,
                  value: app.entryValue.trim(),
                })}{app.entryEffect === "out" ? " — excluded" : ""}
              </p>
            {/if}
            {#if app.scopeRefusal !== ""}
              <div
                class={[
                  "refusal",
                  app.scopeRefusalContradiction && "contradiction",
                ]}
                role="alert"
              >
                {app.scopeRefusal}
              </div>
            {/if}
          </form>
        </div>

        <aside class="preview">
          <span class="list-label">What the agent is told</span>
          {#if scope.promptBlock === null}
            <!-- A4's empty state. An empty scope says so plainly rather than showing
                 "In scope: (nothing)" — which is what the agent would otherwise be told,
                 and it would read as "you may touch nothing." -->
            <div class="preview-empty">
              <IconCube width="24" height="24" />
              <p class="empty-lead">No scope authored for this target</p>
              <p class="empty-more">
                The hunt still runs and still records everything it finds — it
                just arrives labelled <span class="mono">not covered</span>, and
                the agent is told nothing about the client's estate.
              </p>
              <Button
                variant="primary"
                size="sm"
                onclick={() => {
                  entryField?.scrollIntoView({ block: "nearest" });
                  entryField?.focus();
                }}
              >
                <IconPlus width="13" height="13" />
                Add the first entry
              </Button>
            </div>
          {:else}
            <pre class="block">{scope.promptBlock}</pre>
            <ul class="notes">
              <li>
                A planner round gets the same block without the
                <span class="mono">record_asset</span> line.
              </li>
              <li>
                An agent already running keeps the scope it was given; the next
                round gets this.
              </li>
            </ul>
          {/if}
        </aside>
      </div>
    {/if}
  {/snippet}
</PageFrame>

<style>
  /* ── The tab pair, in the filter row PageFrame already owns ────────────────── */
  .tabs {
    display: flex;
    align-items: center;
    gap: 6px;
    align-self: flex-start;
    padding: 3px;
    border: 1px solid var(--border-muted);
    border-radius: var(--radius-md);
    background: var(--bg-deep);
  }
  .tab {
    padding: 5px 12px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    font: 400 12px/16px var(--font-sans);
    cursor: pointer;
    transition: background var(--dur-hover) ease-out;
  }
  .tab:hover {
    background: var(--overlay-hover);
  }
  .tab.on {
    background: var(--bg-layer-02);
    color: var(--text-base);
    font-weight: 500;
  }

  /* ── The four filters ──────────────────────────────────────────────────────── */
  .chips {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 16px;
  }
  .filter {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 30px;
    padding: 0 11px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-muted);
    font: 400 12px/16px var(--font-sans);
    cursor: pointer;
    transition: background var(--dur-hover) ease-out;
  }
  .filter:hover {
    background: var(--overlay-hover);
  }
  /* Dashed, like the group header and the chip: covered by nothing reads as unsettled
     rather than as excluded. */
  .filter.dashed {
    border-style: dashed;
    border-color: var(--border-strong);
  }
  .filter.on {
    background: var(--bg-layer-02);
    color: var(--text-base);
    font-weight: 500;
  }
  .tally {
    color: var(--text-muted);
  }
  .spacer {
    flex: 1;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 220px;
    min-height: 30px;
    padding: 0 10px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    background: var(--bg-deep);
    color: var(--icon-muted);
  }
  .search input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--text-base);
    font: 400 12px/16px var(--font-sans);
  }
  .search input:focus {
    outline: none;
  }

  /* ── Groups and rows ───────────────────────────────────────────────────────── */
  .groups {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .group {
    display: flex;
    flex-direction: column;
  }
  .host {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
    padding: 8px 12px;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
  }
  .host:hover {
    background: var(--overlay-hover);
  }
  /* Only the group asking for a decision carries an outline on its header. */
  .host.uncovered {
    border-style: dashed;
    border-color: var(--border-strong);
  }
  .host-name {
    font: 500 14px/20px var(--font-mono);
    color: var(--text-base);
  }
  .host.out .host-name {
    color: var(--text-muted);
  }
  .why {
    font: 400 12px/16px var(--font-mono);
    color: var(--text-muted);
  }
  .count {
    font: 400 12px/16px var(--font-mono);
    color: var(--text-muted);
  }
  /* A control and the sentence saying what it reaches travel together, so neither can
     wrap away from the other and leave a bare button promising less than it does. */
  .action {
    display: inline-flex;
    align-items: center;
    flex: none;
    gap: 8px;
  }
  .reach {
    font: 400 12px/16px var(--font-sans);
    color: var(--text-muted);
  }

  /*
    Three states, three shapes, and no colour.
    Filled is in scope, outline is excluded on purpose, dashed is covered by nothing.
    Out of scope is not an error, so the state palette is deliberately not used here.
  */
  .chip {
    display: inline-flex;
    align-items: center;
    flex: none;
    padding: 2px 7px;
    border: 1px solid transparent;
    border-radius: var(--radius-xs);
    font: 500 10px/14px var(--font-sans);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .chip.in {
    background: var(--bg-layer-02);
    color: var(--text-base);
  }
  .chip.out {
    border-color: var(--border-strong);
    color: var(--text-muted);
  }
  .chip.uncovered {
    border-style: dashed;
    border-color: var(--border-strong);
    color: var(--text-muted);
  }

  .rows {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0 0 0 25px;
    list-style: none;
  }
  .row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 16px;
    padding: 9px 12px;
    border-radius: var(--radius-md);
  }
  .row:hover {
    background: var(--overlay-hover);
  }
  /*
    The identity gets a floor, and the floor is what makes the row wrap.

    `flex: 1; min-width: 0` let this column shrink to nothing. With a flex basis of zero,
    line collection measured the identity as zero-wide, so every fixed-width sibling — and
    `.action`, which carries a whole sentence — was packed onto the first line and the
    identity was handed whatever pixels were left over. It then broke one or two characters
    per line: `api.acme-cdn.test:443` stood 21 lines tall at 768px and 20 at 1280px.

    A basis with a real minimum is the floor. Line collection clamps the base size to
    `min-width`, so a sibling that would push the identity under 260px is moved to the next
    line instead of crushing it — which is flex-wrap doing the job it was already asked to
    do, at every width rather than only the ones where the columns happened to fit.
    `min(…, 100%)` keeps the floor from overflowing a container narrower than itself.
    `overflow-wrap: anywhere` stays, because a path longer than the column still has to
    break somewhere; it now breaks at thirty-odd characters rather than at one.
  */
  .what {
    flex: 1 1 260px;
    min-width: min(260px, 100%);
    font: 400 13px/18px var(--font-mono);
    color: var(--text-base);
    overflow-wrap: anywhere;
  }
  .kind {
    flex: none;
    width: 92px;
    font: 400 12px/16px var(--font-sans);
    color: var(--text-muted);
  }
  .found,
  .seen {
    flex: none;
    font: 400 12px/16px var(--font-mono);
    color: var(--text-muted);
  }

  /* ── The Scope tab ─────────────────────────────────────────────────────────── */
  .scope {
    display: flex;
    gap: 28px;
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .lists {
    flex: 1;
    min-width: 320px;
    display: flex;
    flex-direction: column;
    gap: 22px;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .list-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  .list-label {
    font: 600 10px/14px var(--font-sans);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .list-count {
    font: 400 12px/16px var(--font-mono);
    color: var(--text-muted);
  }
  .entries {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .entry {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 9px 10px;
    border-radius: var(--radius-md);
  }
  .entry:hover {
    background: var(--overlay-hover);
  }
  .entry-value {
    flex: none;
    width: 200px;
    font: 500 13px/18px var(--font-mono);
    color: var(--text-base);
    overflow-wrap: anywhere;
  }
  /* The sentence, never bare text: it is what the entry reaches, in words. */
  .entry-covers {
    flex: 1;
    font: 400 12px/18px var(--font-sans);
    color: var(--text-muted);
  }
  .imported {
    flex: none;
    padding: 1px 6px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-xs);
    font: 500 10px/14px var(--font-sans);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .remove {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--icon-faint);
    cursor: pointer;
  }
  .remove:hover:not(:disabled) {
    background: var(--overlay-pressed);
    color: var(--icon-base);
  }
  .remove:disabled {
    cursor: default;
    opacity: 0.5;
  }

  .add {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-lg);
    background: var(--bg-deep);
  }
  .add-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .toggle {
    display: flex;
    flex: none;
    gap: 3px;
    padding: 3px;
    border: 1px solid var(--border-muted);
    border-radius: var(--radius-md);
    background: var(--bg-base);
  }
  .toggle-half {
    padding: 4px 11px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    font: 400 12px/16px var(--font-sans);
    cursor: pointer;
  }
  .toggle-half:hover {
    background: var(--overlay-hover);
  }
  .toggle-half.on {
    background: var(--bg-layer-02);
    color: var(--text-base);
    font-weight: 500;
  }
  select,
  .value {
    min-height: 32px;
    padding: 0 10px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    background: var(--bg-base);
    color: var(--text-base);
    font: 400 12px/16px var(--font-sans);
  }
  .value {
    flex: 1;
    min-width: 180px;
    font-family: var(--font-mono);
    font-size: 13px;
  }
  .preview-line {
    margin: 0;
    font: 400 12px/18px var(--font-mono);
    color: var(--text-muted);
  }

  /*
    The one place danger red appears in this screen.
    A contradiction is the one refusal in the flow; everything else out of scope is a
    label rather than a fault, and colouring those would say otherwise.
  */
  .refusal {
    padding: 10px 11px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    font: 400 12px/17px var(--font-sans);
    color: var(--text-muted);
  }
  .refusal.contradiction {
    border-color: var(--state-border-danger);
    background: var(--state-bg-danger);
    color: var(--state-fg-danger);
  }
  /* On the Estate tab it sits above the filter row rather than inside a form. */
  .estate-refusal {
    margin-bottom: 16px;
  }

  /* ── The preview panel ─────────────────────────────────────────────────────── */
  .preview {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: 10px;
    width: 420px;
    max-width: 100%;
  }
  .block {
    margin: 0;
    padding: 16px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-lg);
    background: var(--bg-deep);
    color: var(--text-muted);
    font: 400 12px/18px var(--font-mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .notes {
    display: flex;
    flex-direction: column;
    gap: 7px;
    margin: 0;
    padding-left: 18px;
  }
  .notes li {
    font: 400 11px/17px var(--font-sans);
    color: var(--text-muted);
  }
  .preview-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 32px 24px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-lg);
    background: var(--bg-deep);
    color: var(--icon-faint);
    text-align: center;
  }

  /* ── Shared states ────────────────────────────────────────────────────────── */
  .notice {
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: flex-start;
  }
  .quiet {
    margin: 0;
    color: var(--text-muted);
  }
  .quiet-small {
    margin: 0;
    font-size: 12px;
    color: var(--text-muted);
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    max-width: 520px;
    margin: 48px auto;
    color: var(--icon-faint);
    text-align: center;
  }
  .empty-lead {
    margin: 0;
    font: 530 20px/28px var(--font-sans);
    color: var(--text-base);
  }
  .empty-more {
    margin: 0;
    font: 400 13px/20px var(--font-sans);
    color: var(--text-muted);
    text-wrap: pretty;
  }
</style>
