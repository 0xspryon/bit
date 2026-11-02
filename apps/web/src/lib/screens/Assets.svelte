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
    type ScopeEntryView,
    type ScopeKind,
    type ScopeState,
  } from "@bit/contracts";

  import type { App } from "../app.svelte";
  import Banner from "../components/Banner.svelte";
  import Button from "../components/Button.svelte";
  import ConfirmAction from "../components/ConfirmAction.svelte";
  import PageFrame from "../components/PageFrame.svelte";
  import { lastSessionSentence, sessionWhen } from "../importerChat";
  import {
    IconClose,
    IconCube,
    IconDownload,
    IconHistory,
    IconPlus,
    IconScroll,
    IconSearch,
    IconTrash,
  } from "../icons";

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

  /**
   * The entry the delete dialog is asking about, read from the entries as they are now.
   * `undefined` when no question is open, and also when the entry it named has gone.
   */
  let entryToRemove = $derived(
    app.assetsTab === "scope"
      ? scope?.entries.find((entry) => entry.entryId === app.scopeEntryToRemove)
      : undefined,
  );
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

  /**
   * How this asset came to be known, for the provenance column.
   *
   * **An imported asset reads as provenance, not as an absence**, and the order of these
   * branches is what makes that true. A host the scope importer read off a program page
   * has `discoveries: 0` and `firstAttemptId: null` — both correct, because the importer
   * runs before any attempt exists (D14) — and a column that checked only those two could
   * say nothing better than "no recorded discovery". That is a sentence about a gap, and
   * there is no gap: the program's own page named the host. So `imports` is checked first,
   * and the row says where it was read off.
   *
   * A worker's later discovery of the same host wins the sentence, because by then the
   * more informative fact is that somebody has actually been there. Both provenance rows
   * are kept either way; this column has room for one.
   *
   * **A hand-written scope label is not provenance and is checked last**, which is the
   * other half of the same mistake. `scope.by._tag === "assetLabel"` means an operator
   * decided this one asset's scope state — a decision about whether it may be tested — and
   * it says nothing about where the asset came from. Read first, as it was, it erased the
   * "imported from …" sentence from every imported host the operator promoted or excluded:
   * one click on a row and its provenance read "by hand". The row already says a label
   * decided its state, in its own chip and its own "why" column, so this column does not
   * need to say it again — and when it does say it, it is because nothing else accounts
   * for the asset at all.
   */
  const foundBy = (asset: AssetView): string => {
    if (asset.firstAttemptId !== null)
      return `via ${asset.firstAttemptId.slice(0, 11)}`;
    if (asset.imports > 0)
      return asset.firstSourceUrl === null
        ? "imported from the program page"
        : `imported from ${hostOfUrl(asset.firstSourceUrl)}`;
    // No provenance row of either kind, which should not happen: both writes put their
    // provenance row in the same transaction as the asset. An operator's own label is the
    // most that can be said about such a row, and nothing at all is said if there is not
    // even one — because an asset nothing accounts for is worth noticing.
    if (asset.scope.by._tag === "assetLabel") return "by hand";
    return "no recorded provenance";
  };

  /**
   * The host of a program page URL, for the provenance column.
   *
   * The whole URL would push the scope chips off a tablet-width row, and the host is the
   * part that identifies the program. The full page is on the import row for anyone who
   * needs it, and the entries the same import wrote carry it in their note.
   */
  const hostOfUrl = (url: string): string => {
    try {
      return new URL(url).host;
    } catch {
      // Not parseable as a URL. It is still the string the importer was given, so it is
      // shown rather than replaced with a complaint about its shape.
      return url;
    }
  };

  /** How many sightings a row reports, said so that zero reads correctly. */
  const sightings = (asset: AssetView): string =>
    asset.discoveries === 0
      ? // Not "0 sightings". Zero is the normal, correct state of an imported host, and a
        // count of nothing beside a row that was legitimately recorded reads as a defect.
        asset.imports > 0
        ? "not yet seen"
        : "no sightings"
      : `${String(asset.discoveries)} ${asset.discoveries === 1 ? "sighting" : "sightings"}`;

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
    : "The client's estate, as you authored it. These entries are only ever written with your say-so."}
  centered={app.drawerHidden}
  detailTitle="What the agent is told"
  detailOpen={app.scopeBlockOpen &&
    app.assetsTab === "scope" &&
    scope !== undefined}
  onclosedetail={() => (app.scopeBlockOpen = false)}
>
  {#snippet actions()}
    <!-- The block the agent is given is behind a button rather than beside the lists: it
         is the thing to check before a hunt, not the thing to read on every visit, and a
         column of its own took the width the entries need. -->
    {#if app.assetsTab === "scope" && scope !== undefined}
      <!-- With entries, the importer's entry point lives here (A6 D1); with none it is
           the empty state's primary button, and a second one up here would be two
           buttons for the one decision. -->
      {#if scope.entries.length > 0}
        <Button
          variant="outline"
          size="page"
          onclick={() => app.openImporter()}
        >
          <IconDownload width="13" height="13" />
          Auto-load…
        </Button>
      {/if}
      <Button
        variant="outline"
        size="page"
        expanded={app.scopeBlockOpen}
        onclick={() => (app.scopeBlockOpen = !app.scopeBlockOpen)}
      >
        <IconScroll width="13" height="13" />
        What the agent is told
      </Button>
    {/if}
  {/snippet}

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
                    <span class="seen mono">{sightings(asset)}</span>
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
          {#if scope.entries.length === 0}
            <!--
              A6 D1's empty state: no entry at all, in either list. Two lists reading "None."
              and a form are what an empty scope looked like before, and said nothing about
              how to get one.

              Both buttons are the same decision made two ways. The importer is a page; the
              hand entry is the form beside this, so that button hands the operator the
              field it names rather than describing it. `data-focus-fallback` because
              deleting the last entry lands here: the lists it was in are gone with it.
            -->
            <div
              class="empty scope-empty"
              role="group"
              aria-label="No scope authored for this target"
              tabindex="-1"
              data-focus-fallback
            >
              <IconCube width="28" height="28" />
              <p class="empty-lead">No scope authored for this target</p>
              <p class="empty-more">
                Hand the program's pages to the importer and it drafts the in
                and out entries with you, or type the first entry yourself.
              </p>
              <div class="empty-actions">
                <Button
                  variant="primary"
                  size="page"
                  onclick={() => app.openImporter()}
                >
                  <IconDownload width="14" height="14" />
                  Auto-load scope…
                </Button>
                <Button
                  size="page"
                  variant="outline"
                  onclick={() => {
                    entryField?.scrollIntoView({ block: "nearest" });
                    entryField?.focus();
                  }}
                >
                  <IconPlus width="14" height="14" />
                  Add an entry by hand
                </Button>
              </div>
            </div>
          {:else}
            {#each [{ effect: "in", heading: "In scope" }, { effect: "out", heading: "Out of scope" }] as section (section.effect)}
              {@const rows = scope.entries.filter(
                (entry) => entry.effect === section.effect,
              )}
              <!-- `data-focus-fallback`: this list outlives any one of its rows, so it is
                 where focus lands when the `×` that opened the delete question is
                 deleted along with its row. See Modal. -->
              <div
                class={["list", rows.length === 0 && "none"]}
                style:--rows={Math.min(rows.length, 2)}
                role="group"
                aria-label={section.heading}
                tabindex="-1"
                data-focus-fallback
              >
                <div class="list-head">
                  <span class="list-label">{section.heading}</span>
                  <span class="mono list-count"
                    >{rows.length}
                    {rows.length === 1 ? "entry" : "entries"}</span
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
                          <span
                            class="imported"
                            title={entry.note ?? "Imported"}>Imported</span
                          >
                        {/if}
                        <div class="spacer"></div>
                        <button
                          class="remove"
                          aria-label={`Remove ${entry.value}`}
                          disabled={app.scopeBusy}
                          onclick={() =>
                            app.askToRemoveScopeEntry(entry.entryId)}
                        >
                          <IconClose width="13" height="13" />
                        </button>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </div>
            {/each}
          {/if}

          {#if scope.hostLabels.length > 0 || scope.assetLabels.length > 0}
            <div
              class="list by-hand"
              style:--rows={Math.min(
                scope.hostLabels.length + scope.assetLabels.length,
                2,
              )}
            >
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
        </div>

        {#if app.lastImporterSession !== undefined}
          {@const last = app.lastImporterSession}
          <!--
            A6 D1's strip, at the bottom of the tab beside the Add bar, **whether or not the
            scope has entries**. D1's caption: "On a target that already has entries this
            strip is the only thing that changes; the primary button moves into the Scope
            tab's header." It is not inside the empty state, because a session that wrote
            anything has removed the empty state, and a strip behind it could then only name
            a session that wrote nothing.

            Sessions are sticky per target, so an abandoned one is named here rather than
            left for the operator to start a second beside it. What it says is about what
            the session did (running, wrote nothing, wrote this much) and never about what
            was said: the server keeps none of that.

            "Continue" selects the session and opens the page; it does not prompt it.
          -->
          <div
            class="last-session"
            role="group"
            aria-label="Last importer session"
          >
            <IconHistory width="14" height="14" />
            <span class="last-text"
              >Last importer session
              <span class="mono last-when"
                >{sessionWhen(last.openedAt, Date.now())}</span
              >
              {lastSessionSentence(last)}</span
            >
            <Button
              variant="outline"
              size="sm"
              onclick={() => app.openImporter(last.sessionId)}
            >
              Continue that session
            </Button>
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
    {/if}
  {/snippet}

  {#snippet detail()}
    {#if scope !== undefined}
      {#if scope.promptBlock === null}
        <!-- A4's empty state. An empty scope says so plainly rather than showing
             "In scope: (nothing)" — which is what the agent would otherwise be told,
             and it would read as "you may touch nothing." -->
        <div class="preview-empty">
          <IconCube width="24" height="24" />
          <p class="empty-lead">No scope authored for this target</p>
          <p class="empty-more">
            The hunt still runs and still records everything it finds — it just
            arrives labelled <span class="mono">not covered</span>, and the
            agent is told nothing about the client's estate.
          </p>
          <Button
            variant="primary"
            size="sm"
            onclick={() => {
              // The panel overlays the page below 1280px, so it has to get out of the
              // way of the field this button names before the field is focused.
              app.scopeBlockOpen = false;
              entryField?.scrollIntoView({ block: "nearest" });
              entryField?.focus();
            }}
          >
            <IconPlus width="13" height="13" />
            Add the first entry
          </Button>
        </div>
      {:else}
        <div class="preview">
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
        </div>
      {/if}
    {/if}
  {/snippet}
</PageFrame>

{#if entryToRemove !== undefined}
  {@const entry = entryToRemove}
  <ConfirmAction
    title={`Delete the entry ${entry.value}?`}
    tone="danger"
    confirmLabel="Delete entry"
    workingLabel="Deleting…"
    cancelLabel={entry.effect === "out" ? "Keep it out" : "Cancel"}
    working={app.scopeBusy}
    onconfirm={() => void app.confirmRemoveScopeEntry()}
    oncancel={() => app.cancelRemoveScopeEntry()}
  >
    {#snippet icon()}
      <IconTrash width="13" height="13" />
    {/snippet}
    {#snippet body()}
      {@render removeConsequences(entry)}
    {/snippet}
  </ConfirmAction>
{/if}

<!--
  What deleting an entry does, and nothing it does not.

  Every sentence here is checked against the delete path: `DELETE FROM scope_entries`, one
  `scope.entry.removed` event, and a re-derived prompt block. No asset row, host label or
  asset label is written, and a verdict is derived at read time by `scopeStateOf`, so the
  consequences are the ladder's: a hand label beats the entries, `out` beats `in`, and a
  subject nothing covers is "not covered". There is deliberately no count of the assets
  affected and no promise of an undo, because no contract carries either.
-->
{#snippet removeConsequences(entry: ScopeEntryView)}
  <p class="lead">
    {#if entry.effect === "in"}
      This removes <span class="mono">{describeScopeEntry(entry)}</span> from the
      in-scope list. Nothing the hunt found is deleted — every asset stays recorded
      — and what the agent is told is rewritten from the entries that remain.
    {:else}
      This removes <span class="mono">{describeScopeEntry(entry)}</span> from the
      out-of-scope list. Nothing the hunt found is deleted, and what the agent is
      told no longer names it as excluded.
    {/if}
  </p>
  <p class="consequence">
    {#if entry.effect === "in"}
      A host only this entry covered becomes <span class="mono"
        >not covered</span
      >
      — which is not the same as out of scope. A host another entry still covers is
      unaffected.
    {:else}
      Whatever it excluded stops being excluded: anything an in-scope entry also
      covers becomes <span class="mono">in scope</span>, and anything else
      becomes
      <span class="mono">not covered</span>. Deleting it ends the exclusion; it
      does not keep a host out of the hunt.
    {/if}
  </p>
  <p class="aside">
    Labels you set by hand are not touched, and still beat the lists. There is
    no undo here: adding the same entry again restores what it covered.
  </p>
{/snippet}

<style>
  /* ── The tab pair, in the filter row PageFrame already owns ────────────────── */
  .tabs {
    display: flex;
    align-items: center;
    gap: 6px;
    align-self: flex-start;
    padding: 3px;
    /*
     * Pulled out of the page edge by its own chrome, so the *label* lands on it.
     *
     * The same trick `.entries` uses, and for the same reason: this control's visible
     * left edge is "Estate", not the group's border, and 3px of padding plus a 1px
     * border put that text 4px inside the edge every other line of the page sits on —
     * the title, the section labels, the entry values. Four pixels is enough to read as
     * a wobble when they are stacked vertically. Padding the group to zero would do it
     * too, and would put the selected pill's background hard against the border.
     */
    margin-left: -4px;
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
    /* The host header's hover surface bleeds out of the page's edge by its padding and its
       transparent border, so the host's name is on the edge. */
    margin-inline: -13px;
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
  /*
   * The tab fills the body PageFrame gives it, so the lists can scroll inside it and the
   * Add form can stay under them. PageFrame's body is itself the scroller, and a tab that
   * only grew to its content would push "Add an entry" off the bottom of a long list.
   */
  .scope {
    display: flex;
    flex-direction: column;
    gap: 22px;
    height: 100%;
    min-height: 0;
    max-width: 760px;
  }
  /* The lists share whatever height is left, each scrolling on its own. */
  .lists {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 22px;
    min-height: 0;
  }
  /*
   * Every list is floored at what it needs to show *itself*: its heading, whatever sits
   * between the heading and the rows, and up to two rows.
   *
   * Shrinking is proportional to length, so without a floor a two-entry list is squeezed
   * to one row beside a sixteen-entry one. A single number for all three lists was not
   * enough, because they do not hold the same things: "Set by hand" has a sentence under
   * its heading, and its rows run to two lines. The parts are named here and the template
   * says how many rows a list has (`--rows`, 0 to 2) and whether it has a lead (`--lead`),
   * so the floor follows the content instead of a measurement of one of the lists.
   *
   * A list with fewer than two rows is floored at the rows it has, so a one-entry list is
   * not padded to the height of two.
   */
  .list {
    --head: 16px;
    --gap: 8px;
    /* One row: 9px of padding above and below an 18px line. */
    --row: 42px;
    --row-gap: 2px;
    --rows: 2;
    /* Height of what sits between the heading and the rows, with the gap that follows it. */
    --lead: 0px;
    display: flex;
    flex: 0 1 auto;
    flex-direction: column;
    gap: var(--gap);
    min-height: calc(
      var(--head) + var(--gap) + var(--lead) + var(--rows) * var(--row) +
        max(var(--rows) - 1, 0) * var(--row-gap)
    );
  }
  /* A row of "Set by hand" is longer than the ones above and wraps to two lines. */
  .list.by-hand {
    --row: 54px;
    /* The 20px sentence, and the gap before the rows. */
    --lead: 28px;
  }
  /* "None." is the whole body of an empty list: a 20px line and its gap, not a row. */
  .list.none {
    --rows: 0;
    --lead: 28px;
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
    min-height: 0;
    /* The rows' hover surface bleeds out of the page's edge by their own padding, so their
       text is on it. It is on this list rather than on each row because the list scrolls,
       and a scroller clips whatever a child pushes outside of it. */
    margin: 0 -10px;
    padding: 0;
    overflow-y: auto;
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
    flex: none;
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

  /* ── The panel holding the block the agent is given ────────────────────────── */
  .preview {
    display: flex;
    flex-direction: column;
    gap: 10px;
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

  /* ── The delete dialog's body ──────────────────────────────────────────────── */
  .lead,
  .consequence,
  .aside {
    margin: 0;
    font: 400 13px/20px var(--font-sans);
    color: var(--text-muted);
    text-wrap: pretty;
  }
  .lead .mono {
    color: var(--text-base);
  }
  .consequence {
    padding: 11px 12px;
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-md);
    font-size: 12px;
    line-height: 18px;
  }
  .consequence .mono {
    color: var(--text-base);
  }
  .aside {
    font-size: 12px;
    line-height: 18px;
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
  /* The Scope tab's empty state sits in the lists column, and takes focus when the last
     entry is deleted from under the delete question: no outline for a programmatic one. */
  .scope-empty {
    flex: 1;
    justify-content: center;
    margin: 24px auto;
  }
  .scope-empty:focus {
    outline: none;
  }
  /* D1's strip: a bordered bar under the empty state, text first and the button at the end. */
  .last-session {
    display: flex;
    flex: none;
    align-items: center;
    gap: 10px;
    padding: 11px 13px;
    box-sizing: border-box;
    border: 1px solid var(--border-base);
    border-radius: 7px;
    background: var(--bg-deep);
    color: var(--icon-muted);
  }
  .last-text {
    flex: 1;
    font: 400 12px/18px var(--font-sans);
    color: var(--text-muted);
    text-wrap: pretty;
  }
  .last-when {
    color: var(--text-base);
  }
  .empty-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 4px;
  }
</style>
