<script lang="ts">
  /**
   * "Loading the scope" (A3's C2): per-link state, running totals, three exits.
   *
   * ## It lists the MCP tool calls and nothing else (D16)
   *
   * Every line names the tool that was called and the value it wrote, so the page doubles
   * as the receipt for what landed on the target. There is no narration here and no
   * reasoning, and the reason there is none is worth stating where somebody might think to
   * add it: **the view this renders has no field for it.** `ScopeImportView` carries
   * `calls`, and the server records those as they cross its own MCP boundary — nothing in
   * the server subscribes to the importer session's narration at all. So a reasoning line
   * is not filtered out here; it was never captured, and putting one on this screen would
   * mean building a capture path first.
   *
   * The argument for that, from D16: a tool call is a fact — this entry was written, that
   * asset was recorded — where narration is the model talking about what it might do, at a
   * volume that would bury the handful of lines the operator is here to check. They are
   * here precisely because they are about to trust its output.
   *
   * The harness's own page fetches do not appear either, per D13: they are not our tool
   * calls, and nothing we own observes them. A3's mockup showed `fetch_page` lines in this
   * list, and this screen deliberately has none — see the component's own notes below.
   *
   * ## Per-link progress is derived
   *
   * Nothing we own watches the fetch, so a link's state comes from the `source_url` on the
   * calls the importer made (`scopeImportLinks` in contracts). A page that produced calls
   * was read; a link with none has not been reached. `waiting` under a finished import is
   * a page that yielded nothing, which per D15 is not a failure.
   */
  import Banner from "./Banner.svelte";
  import Button from "./Button.svelte";
  import { IconCube, IconSearch } from "../icons";
  import { SCOPE_IMPORT_MAX_LINKS } from "@bit/contracts";
  import type { App } from "../app.svelte";

  let { app }: { app: App } = $props();

  let view = $derived(app.scopeImport);
  let running = $derived(view === undefined || view.status === "running");
  /** Links the operator gave that this import is not reading. Usually none. */
  let dropped = $derived(view?.droppedLinks ?? 0);

  /** What each link's state reads as beside its URL, with what it produced. */
  const linkState = (link: {
    state: string;
    entriesIn: number;
    entriesOut: number;
    assets: number;
  }): string => {
    if (link.state === "reading") return "reading…";
    if (link.state === "read")
      return `read · ${String(link.entriesIn)} in, ${String(link.entriesOut)} out`;
    // Two situations share this word and the import's status is what tells them apart: a
    // link not yet reached, and a link that was read and yielded nothing. Saying "nothing
    // read" for the first would be inventing a result; saying "waiting" for the second
    // under a settled import reads correctly as "this gave us nothing".
    return running ? "waiting" : "nothing read";
  };

  /** The status line under the totals, in the operator's terms rather than the enum's. */
  let statusLine = $derived.by(() => {
    if (view === undefined) return "Starting the importer…";
    switch (view.status) {
      case "running":
        return "Written as it reads. Every entry and every asset is editable on the Assets page.";
      case "stopped":
        return "Stopped. Everything written up to that point is kept, and the rest is yours to add.";
      case "failed":
        return view.detail ?? "The importer could not be started.";
      case "finished":
        return view.detail === null
          ? "Finished. Every entry and every asset is editable on the Assets page."
          : view.detail;
    }
  });

  let totals = $derived(
    view === undefined
      ? { entriesIn: 0, entriesOut: 0, assets: 0 }
      : view.totals,
  );
</script>

<section class="panel" aria-label="Loading the scope">
  <header class="head">
    <span class={["pip", running && "live"]} aria-hidden="true"></span>
    <h2>Loading the scope</h2>
    <span class="target mono">
      {app.scopeImportTargetId}
    </span>
  </header>

  {#if app.scopeImportDetail !== ""}
    <Banner tone="danger">{app.scopeImportDetail}</Banner>
  {/if}

  <!-- Per link, in the order they were pasted. -->
  <ul class="links">
    {#each view?.links ?? [] as link (link.url)}
      <li class="link">
        <span class="url mono">{link.url}</span>
        <span class={["state", link.state]}>{linkState(link)}</span>
      </li>
    {/each}
  </ul>

  {#if dropped > 0}
    <!--
      One session reads every link (D15), so they share one context window and there is a
      ceiling on how many. Extra links are dropped rather than the import refused — an
      operator who pasted nine pages wants the first eight read far more than they want to
      be sent back to the form — but the dropping is said out loud here, because the rows
      above would otherwise show eight links where they typed nine. Importing the rest is
      something they can go and do.
    -->
    <Banner tone="warning">
      {dropped}
      {dropped === 1 ? "link was" : "links were"} not read: one session reads every
      page, so an import takes at most {SCOPE_IMPORT_MAX_LINKS}. The pages
      listed above are the ones it has; anything on the others is yours to add
      on this target's Scope page.
    </Banner>
  {/if}

  <div class="calls">
    <span class="calls-label">What it wrote</span>
    {#if (view?.calls ?? []).length === 0}
      <p class="calls-empty">
        {running
          ? "Nothing yet. Each line below will name a tool and the value it wrote."
          : "No tool calls — nothing was written to this target."}
      </p>
    {:else}
      <!--
        One row per call. The tool on the left and the value it wrote on the right, which
        is A3's own two-column shape — and the whole of what this panel shows. There is no
        third column for commentary because there is nothing to put in one.
      -->
      <ul class="call-list">
        {#each view?.calls ?? [] as call (call.sequence)}
          <li class="call">
            <span class="tool mono">{call.tool}</span>
            <span class="wrote">{call.wrote}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <div class="totals">
    <p class="tally">
      {totals.entriesIn} in-scope · {totals.entriesOut} out-of-scope · {totals.assets}
      {totals.assets === 1 ? "asset" : "assets"} recorded
    </p>
    <p class="note" role="status">{statusLine}</p>
  </div>

  <!--
    The three exits. All three leave the import alone: it is a server-side fiber and was
    never driven from this screen, which is what makes "Continue in background" a
    navigation rather than a mode.
  -->
  <div class="exits">
    <Button variant="outline" onclick={() => app.openImportedAssets()}>
      <IconSearch width="13" height="13" />
      Open assets
    </Button>
    {#if running}
      <Button
        variant="outline"
        onclick={() => app.continueImportInBackground()}
      >
        <IconCube width="13" height="13" />
        Continue in background
      </Button>
      <span class="spacer"></span>
      <Button variant="quiet" onclick={() => void app.stopImport()}>
        Stop
      </Button>
    {:else}
      <span class="spacer"></span>
    {/if}
  </div>
  {#if running}
    <p class="aside">
      Either way it keeps reading — nothing here is driving it, and nothing is
      waiting on you.
    </p>
  {/if}
</section>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: 22px;
    width: 100%;
    max-width: 720px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 11px;
  }
  .head h2 {
    flex: 1;
    margin: 0;
    font-size: 26px;
    line-height: 32px;
    font-weight: 530;
    letter-spacing: -0.01em;
    color: var(--text-base);
  }
  .pip {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text-faint);
  }
  .pip.live {
    background: var(--text-base);
    box-shadow: 0 0 0 3px var(--overlay-pressed);
  }
  .target {
    font-size: 12px;
    color: var(--text-muted);
  }
  .links {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .link {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    background: var(--bg-layer-01);
  }
  .url {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    color: var(--text-base);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .state {
    flex: none;
    font-size: 11px;
    color: var(--text-muted);
  }
  .state.read {
    color: var(--text-base);
  }
  .calls {
    display: flex;
    flex-direction: column;
    gap: 9px;
    padding: 13px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    background: var(--bg-base);
  }
  .calls-label {
    font-size: 10px;
    line-height: 14px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .calls-empty {
    margin: 0;
    font-size: 11px;
    line-height: 17px;
    color: var(--text-muted);
    font-style: italic;
  }
  .call-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .call {
    display: flex;
    gap: 10px;
  }
  .tool {
    flex: none;
    width: 170px;
    font-size: 11px;
    line-height: 17px;
    color: var(--text-muted);
  }
  .wrote {
    flex: 1;
    min-width: 0;
    font-size: 11px;
    line-height: 17px;
    color: var(--text-base);
    overflow-wrap: anywhere;
  }
  .totals {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .tally {
    margin: 0;
    font-size: 13px;
    line-height: 19px;
    color: var(--text-base);
  }
  .note {
    margin: 0;
    font-size: 12px;
    line-height: 18px;
    color: var(--text-muted);
    text-wrap: pretty;
  }
  .exits {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .spacer {
    flex: 1;
  }
  .aside {
    margin: -12px 0 0;
    font-size: 11px;
    line-height: 17px;
    color: var(--text-faint);
    text-wrap: pretty;
  }

  /* Tablet widths and up is the target; at the narrow end the exits stack rather than
     squeeze, and the call rows give up their fixed tool column. */
  @media (width < 700px) {
    .exits {
      flex-wrap: wrap;
    }
    .call {
      flex-direction: column;
      gap: 0;
    }
    .tool {
      width: auto;
    }
  }
</style>
