<script lang="ts">
  /**
   * The hunt view's header: which target you are in, and what it holds.
   *
   * Three things it is careful about:
   *
   * 1. **It shows this target's numbers or none at all.** The counts are rendered only
   *    when the target they were read for is the target on screen, so switching targets
   *    cannot leave the previous one's figures under the new one's name for a round trip.
   *    `app.viewTargetId` is the id those counts belong to; `app.selected` is where the
   *    operator is.
   * 2. **Zero and "not read yet" are different.** A fresh target holds zero of
   *    everything, so `0` cannot double as "waiting" — the reading state says so in
   *    words instead.
   * 3. **The labels are the stored vocabulary.** "Intents", not "Hunts": the schema has
   *    intents and no findings table, and which stored thing the sidebar's labels name is
   *    a question the flow that designs those pages answers. A header that relabelled
   *    them here would be inventing the answer in the one place that claims to show real
   *    data.
   */
  import Badge from "./Badge.svelte";
  import type { App } from "../app.svelte";

  let { app }: { app: App } = $props();

  let target = $derived(app.selected);
  /** The counts, only if they are this target's. */
  let counts = $derived(
    app.viewTargetId === target?.id ? app.counts : undefined,
  );
  let figures = $derived(
    counts === undefined
      ? []
      : [
          { label: "Intents", value: counts.intents },
          { label: "Observations", value: counts.observations },
          { label: "Assets", value: counts.assets },
          { label: "Events", value: counts.events },
        ],
  );
</script>

<header class="head">
  <Badge name={target?.name ?? "?"} size={30} />

  <span class="ident">
    <span class="name">{target?.name ?? ""}</span>
    <!-- Advisory prose, never enforcement: scope is a note the operator wrote. -->
    <span class="scope mono">{target?.scope ?? "—"}</span>
  </span>

  {#if counts !== undefined}
    <dl class="counts">
      {#each figures as figure (figure.label)}
        <div class="figure">
          <dt>{figure.label}</dt>
          <dd class="mono">{figure.value}</dd>
        </div>
      {/each}
      {#if counts.unsettledAttempts > 0}
        <!-- Only shown when there is one. A standing "0 unsettled" is noise. -->
        <div class="figure unsettled">
          <dt>Unsettled</dt>
          <dd class="mono">{counts.unsettledAttempts}</dd>
        </div>
      {/if}
    </dl>
  {:else if app.viewState === "loading"}
    <p class="note">Reading this target's database…</p>
  {:else if app.viewState === "unavailable"}
    <!-- The server's own sentence, unedited: the rail dims the row with these words too,
         so the two cannot describe the same failure differently. -->
    <p class="note warn">{app.viewDetail}</p>
  {:else if app.viewState === "unreachable"}
    <p class="note warn">{app.viewDetail}</p>
  {/if}
</header>

<style>
  .head {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: none;
    padding: 12px 18px;
    border-bottom: 1px solid var(--border-base);
    background: var(--bg-base);
  }
  .ident {
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: 2px;
  }
  .name {
    font-size: 14px;
    color: var(--text-base);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .scope {
    font-size: 11px;
    color: var(--text-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .counts {
    display: flex;
    align-items: center;
    gap: 18px;
    margin: 0 0 0 auto;
    padding: 0;
  }
  .figure {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 1px;
  }
  dt {
    font: 600 9px/var(--lh-compact) var(--font-sans);
    letter-spacing: 0.11em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  dd {
    margin: 0;
    font-size: 13px;
    color: var(--text-base);
    font-variant-numeric: tabular-nums;
  }
  .unsettled dd {
    color: var(--state-fg-warning);
  }
  .note {
    margin: 0 0 0 auto;
    font-size: 12px;
    color: var(--text-faint);
  }
  .note.warn {
    max-width: 52ch;
    text-align: right;
    color: var(--state-fg-warning);
  }
</style>
