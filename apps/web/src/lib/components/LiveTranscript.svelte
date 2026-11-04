<script lang="ts">
  /**
   * The Live dock: a run as it happens, with its two channels kept visibly apart.
   *
   * **It is a line until asked to be more.** Collapsed, it is 44px at the foot of the
   * target: the connection's state as a word, how many committed records have arrived, the
   * newest item, and — when there is one — the one fact that needs the operator. Expanded,
   * it is the transcript. The page above it gets the viewport either way; a transcript that
   * always took 320px was a panel nobody could shut.
   *
   * **The shape of the rows is the contract's shape.** `contracts/src/live.ts` says a screen
   * watching a run is showing two different kinds of thing, and that collapsing them is the
   * one mistake to prevent:
   *
   * - **record** — a committed event from the target's own event log, arriving in the order
   *   the store assigned it inside the writing transaction. It has a position, it can be
   *   resumed from, and `app.liveCursor` is that position.
   * - **activity** — what the harness is narrating and what the policy gate refused, in
   *   this process, now. It was never written to the event log, so it has no position, no
   *   replay and no durability: both buses behind it are sliding buffers, chosen so a slow
   *   browser tab cannot slow down a running agent.
   *
   * Each row says which by its left edge — a solid rule for a record, a dashed rule and
   * italics for activity — and by the word itself, which {@link ChatItem} keeps for screen
   * readers. The ⓘ beside "Live" is where that is said in full, with the record position,
   * on demand rather than as a standing footnote.
   *
   * **It renders nothing it cannot vouch for.** Rows, counts and the newest item are shown
   * only while the live state is about the target on screen, because a stale item here
   * looks like the target in front of you doing something it did not do. `liveSkipped` is
   * shown rather than swallowed for the same reason.
   *
   * No ordering is done here. `app.liveItems` is already in arrival order and that *is* the
   * store's order on the record channel; re-sorting it in the view would either break it or
   * invent a sequence for activity items that the contract refuses to claim.
   */
  import ChatItem from "./ChatItem.svelte";
  import ScenarioBar from "./ScenarioBar.svelte";
  import { IconAngleDown, IconAngleUp, IconBlocked } from "../icons";
  import { foldSubagents, kindLabel } from "../chat";
  import type { App } from "../app.svelte";
  import { atBottom } from "../scroll";

  let { app }: { app: App } = $props();

  /** Whether the live state is about the target on screen. Nothing else is shown if not. */
  let about = $derived(app.liveTargetId === app.viewTargetId);
  /** Everything that arrived for the target on screen, in arrival order. */
  let arrived = $derived(about ? app.liveItems : []);
  /**
   * The rows: what arrived, each sub-agent as **one** row at the place it started, carrying
   * its newest state (A6 U14) — as the chat draws it, rather than a `running` row and a
   * `finished` row for the same sub-agent.
   */
  let items = $derived(foldSubagents(arrived));
  let records = $derived(
    items.filter((item) => item.origin === "record").length,
  );
  let newest = $derived(arrived.at(-1));
  /** Whether the ⓘ explanation is open. */
  let explaining = $state(false);

  /**
   * The one fact on the collapsed line that needs the operator, if any.
   *
   * In order of how much it changes what they should do next: the stream refused or broke;
   * an attempt this server could not settle; an attempt it reconciled after a restart. Only
   * one, and in words — the expanded dock has the rest.
   */
  let attention = $derived.by(() => {
    if (about && app.liveDetail !== "")
      return { tone: "danger", text: app.liveDetail };
    // From the target's own counts, which `viewCounts` already guards to this target: an
    // unsettled attempt is a fact about the file whether or not the feed is connected.
    const unsettled = app.viewCounts?.unsettledAttempts ?? 0;
    if (unsettled > 0)
      return {
        tone: "warning",
        text: `${String(unsettled)} unsettled ${unsettled === 1 ? "attempt" : "attempts"}`,
      };
    const recovered = about ? app.liveRecoveries.length : 0;
    if (recovered > 0)
      return {
        tone: "warning",
        text: `${String(recovered)} ${recovered === 1 ? "attempt" : "attempts"} reconciled`,
      };
    return undefined;
  });

  /** The connection's state as words, not only as a colour. */
  let status = $derived(
    !about
      ? "Not watching"
      : app.liveReconnecting
        ? "Reconnecting"
        : app.liveWatching
          ? app.liveCaughtUp
            ? "Live"
            : "Catching up"
          : "Stopped",
  );
  let statusTint = $derived(
    !about
      ? "plain"
      : app.liveReconnecting
        ? "warning"
        : app.liveWatching
          ? app.liveCaughtUp
            ? "success"
            : "warning"
          : "plain",
  );

  /**
   * The list element, for the one thing this component does to the DOM by hand.
   *
   * `undefined` until the dock is mounted — `bind:this` has nothing to hand over before
   * then, and the dock comes and goes with the target screen — so every read of it below
   * is guarded rather than assumed.
   */
  let list = $state<HTMLOListElement | undefined>(undefined);

  /**
   * Whether the view is following the newest item.
   *
   * What this flag and the effect below implement together is **stick to the bottom, but
   * only while the reader is already there**. A transcript that always scrolled would yank
   * the page out from under an operator reading back through a tool's output, which on a
   * busy run is every second or two; a transcript that never scrolled would stop showing
   * the run the moment it filled the box, which is the whole of what this panel is for.
   *
   * It starts `true` on purpose: that is what makes a freshly opened panel follow from its
   * first item, rather than only after the operator has once scrolled to the bottom by hand.
   */
  let pinned = $state(true);

  /**
   * Re-answer "is the reader at the bottom" from the list's own scroll events.
   *
   * **The flag is maintained here and not computed inside the effect, and that is the whole
   * subtlety of this feature.** By the time the effect runs, the newly arrived item is
   * already in the DOM and has already made `scrollHeight` taller, so the box is no longer
   * at its bottom and "was the reader at the bottom *before* this item arrived" is a
   * question the geometry can no longer answer — asking it there reads every arrival as the
   * reader having scrolled up, and the view never follows again. A scroll event only fires
   * for a position the box actually reached: either one the reader scrolled to, or the one
   * the effect's own assignment produced, which is the bottom and so leaves this `true`.
   *
   * The predicate is {@link atBottom} from `../scroll` rather than the arithmetic written
   * out here, because `scroll.ts` can be imported by `bun test` and a `.svelte` file cannot:
   * the fraction-of-a-pixel slack it hides is exactly the kind of thing a test catches and a
   * glance does not.
   */
  function trackPinned(): void {
    if (list === undefined) return;
    /* The element satisfies `ScrollMetrics` structurally, so it goes straight in. */
    pinned = atBottom(list);
  }

  /*
   * Follow the newest item, while {@link pinned}.
   *
   * `app.liveItems.length` is read first and unconditionally. An effect depends only on
   * what it read the last time it ran, so a guard placed before that read would unsubscribe
   * this from arrivals for as long as the reader stayed scrolled up — and it would then
   * never catch the arrival that should have resumed following.
   */
  $effect(() => {
    // Every arrival, a sub-agent's new state included, though it adds no row.
    const count = arrived.length;
    // Read unconditionally too: opening the dock has to land at the newest item.
    const expanded = app.liveExpanded;
    if (count === 0 || !expanded || list === undefined || !pinned) return;
    list.scrollTop = list.scrollHeight;
  });
</script>

<section
  class={["live", app.liveExpanded && "expanded"]}
  aria-label="Live transcript"
>
  <div class="bar">
    <span class="state" data-tint={statusTint}>
      <span class="dot" aria-hidden="true"></span>
      <span class="title">{status}</span>
    </span>
    <span class="records mono">
      {records}
      {records === 1 ? "record" : "records"}
    </span>
    {#if app.liveExpanded}
      <button
        class="info"
        aria-expanded={explaining}
        aria-label="What the rows mean"
        onclick={() => (explaining = !explaining)}>i</button
      >
      <span class="grow"></span>
      <button
        class={["states", app.statesOpen && "on"]}
        aria-pressed={app.statesOpen}
        onclick={() => (app.statesOpen = !app.statesOpen)}>States</button
      >
    {:else}
      <span class="rule" aria-hidden="true"></span>
      <span class="newest">
        {#if newest !== undefined}
          {kindLabel(newest.kind)} — {newest.headline}
        {:else if about && app.liveWatching}
          Nothing yet — a run's turns, tool calls and results appear here.
        {/if}
      </span>
    {/if}
    {#if attention !== undefined}
      <span class="attention" data-tint={attention.tone} role="status">
        <IconBlocked width="12" height="12" />
        {attention.text}
      </span>
    {/if}
    <button
      class="toggle"
      aria-expanded={app.liveExpanded}
      onclick={() => (app.liveExpanded = !app.liveExpanded)}
    >
      {app.liveExpanded ? "Collapse" : "Expand"}
      {#if app.liveExpanded}
        <IconAngleDown width="13" height="13" />
      {:else}
        <IconAngleUp width="13" height="13" />
      {/if}
    </button>
  </div>

  <div class="body" hidden={!app.liveExpanded}>
    <div class="main">
      {#if explaining}
        <p class="explain">
          A <strong>solid</strong> rule is committed to the record: those rows
          arrive in the order the store assigned them, and every committed event
          up to sequence <span class="mono">{app.liveCursor}</span> has been
          delivered. A <strong>dashed</strong> rule and italics are in-process activity:
          not part of the record, not replayed on a reconnect, and can be dropped
          under load.
        </p>
      {/if}

      {#if about && app.liveSkipped > 0}
        <p class="note">
          This transcript starts part way through the record: {app.liveSkipped}
          earlier committed {app.liveSkipped === 1 ? "event is" : "events are"} not
          shown here. They are still in the target's event log.
        </p>
      {/if}

      {#if about && app.liveDetail !== ""}
        <p class="detail" role="alert">{app.liveDetail}</p>
      {/if}

      {#if about && app.liveRecoveries.length > 0}
        <div class="recovery" aria-label="Reconciled attempts">
          {#each app.liveRecoveries as recovery (recovery.attemptId)}
            <p class="note">
              Attempt <code>{recovery.attemptId}</code> reconciled:
              <strong>{recovery.status}</strong> (harness reported {recovery.observedStatus}).
              {#if recovery.status === "uncertain"}
                Outcome unknown; old write authority is fenced. No prompt was
                replayed.
              {:else if recovery.disposition === "still_running"}
                The harness still reports the session running; this process has
                not resumed its supervision.
              {:else}
                The recovered outcome is recorded; no prompt was replayed.
              {/if}
              {recovery.detail}
            </p>
          {/each}
        </div>
      {/if}

      <!--
        `role="log"`: an implicit polite live region with log semantics — append-only,
        newest last, only the addition announced. Kept mounted while the dock is collapsed
        (hidden, so silent), because a region added to the DOM at the same moment as its
        first child is not reliably announced. Payloads stay in collapsed `<details>` inside
        each row, so a reader is not narrated a tool's output on every arrival.
      -->
      <ol
        bind:this={list}
        onscroll={trackPinned}
        class="items"
        role="log"
        aria-label="Live run items, oldest first"
      >
        {#each items as item (item.id)}
          <ChatItem {item} />
        {/each}
      </ol>

      {#if items.length === 0}
        <p class="empty">
          {about && app.liveWatching
            ? "Nothing yet — a run's turns, tool calls and recorded results appear here as they happen."
            : "Not connected to this target's live feed."}
        </p>
      {/if}
    </div>

    {#if app.statesOpen}<ScenarioBar {app} docked />{/if}
  </div>
</section>

<style>
  .live {
    display: flex;
    flex: none;
    flex-direction: column;
    border-top: 1px solid var(--border-base);
    background: var(--bg-deep);
  }
  .bar {
    display: flex;
    flex: none;
    align-items: center;
    gap: 14px;
    height: 44px;
    padding: 0 32px;
  }
  .expanded .bar {
    border-bottom: 1px solid var(--border-muted);
  }
  /*
   * `--text-muted` is the floor for text in this dock; `--text-faint` is not usable here.
   * Every label is 10-12px, and `--text-faint` measures 3.4-4.0:1 against these
   * backgrounds in both themes, under WCAG AA's 4.5:1 for normal-size text.
   */
  .state {
    display: flex;
    flex: none;
    align-items: center;
    gap: 7px;
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-base);
    box-shadow: 0 0 0 3px var(--overlay-pressed);
  }
  .state[data-tint="warning"] .dot {
    background: var(--state-fg-warning);
  }
  .state[data-tint="plain"] .dot {
    background: var(--text-muted);
    box-shadow: none;
  }
  .title {
    color: var(--text-base);
    font: 500 12px/16px var(--font-sans);
  }
  .state[data-tint="warning"] .title {
    color: var(--state-fg-warning);
  }
  .records {
    flex: none;
    color: var(--text-muted);
    font-size: 12px;
    line-height: 16px;
  }
  .rule {
    flex: none;
    width: 1px;
    height: 14px;
    background: var(--border-base);
  }
  .newest {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: var(--text-muted);
    font: 400 12px/16px var(--font-sans);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .grow {
    flex: 1;
  }
  .info {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    padding: 0;
    border: 1px solid var(--border-strong);
    border-radius: 50%;
    background: transparent;
    color: var(--icon-muted);
    font: 500 10px/1 var(--font-sans);
    cursor: pointer;
  }
  .info:hover,
  .info[aria-expanded="true"] {
    color: var(--text-base);
    border-color: var(--border-focus);
  }
  .states {
    flex: none;
    height: 26px;
    padding: 0 10px;
    border: 1px solid var(--border-base);
    border-radius: 5px;
    background: transparent;
    color: var(--text-muted);
    font: 400 12px/24px var(--font-sans);
    cursor: pointer;
  }
  .states:hover,
  .states.on {
    background: var(--overlay-hover);
    color: var(--text-base);
  }
  .attention {
    display: flex;
    flex: none;
    align-items: center;
    gap: 7px;
    max-width: 40ch;
    height: 24px;
    padding: 0 9px;
    overflow: hidden;
    border: 1px solid var(--state-border-warning);
    border-radius: 5px;
    background: var(--state-bg-warning);
    color: var(--state-fg-warning);
    font: 400 12px/16px var(--font-sans);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .attention[data-tint="danger"] {
    border-color: var(--state-border-danger);
    background: var(--state-bg-danger);
    color: var(--state-fg-danger);
  }
  .toggle {
    display: flex;
    flex: none;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--text-muted);
    font: 400 12px/16px var(--font-sans);
    cursor: pointer;
  }
  .toggle:hover {
    background: var(--overlay-hover);
    color: var(--text-base);
  }

  .body {
    display: flex;
    min-height: 0;
    max-height: min(360px, 45dvh);
  }
  .body[hidden] {
    display: none;
  }
  .main {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    padding: 14px 32px 18px;
    overflow: hidden;
  }
  .explain,
  .note,
  .detail,
  .empty {
    flex: none;
    margin: 0;
    font-size: 12px;
    line-height: 18px;
  }
  .explain,
  .empty {
    color: var(--text-muted);
  }
  .explain strong {
    color: var(--text-base);
    font-weight: 500;
  }
  .note {
    color: var(--state-fg-warning);
  }
  .detail {
    color: var(--state-fg-danger);
  }
  .recovery {
    display: grid;
    flex: none;
    gap: 6px;
    max-height: 120px;
    overflow: auto;
    overflow-wrap: anywhere;
  }
  .items {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 0;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;
  }
</style>
