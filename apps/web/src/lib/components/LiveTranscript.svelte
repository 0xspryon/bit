<script lang="ts">
  /**
   * A run as it happens, with its two channels kept visibly apart.
   *
   * **The shape of this component is the contract's shape.** `contracts/src/live.ts` says a
   * screen watching a run is showing two different kinds of thing, and that collapsing them
   * is the one mistake to prevent. So every row here carries its origin as a word an
   * operator can read:
   *
   * - **`record`** — a committed event from the target's own event log, arriving in the
   *   order the store assigned it inside the writing transaction. It has a position, it can
   *   be resumed from, and `app.liveCursor` is that position.
   * - **`activity`** — what the harness is narrating and what the policy gate refused, in
   *   this process, now. It was never written to the event log, so it has no position, no
   *   replay and no durability: both buses behind it are sliding buffers, chosen so a slow
   *   browser tab cannot slow down a running agent.
   *
   * A tint alone would not carry that (§9): a colour nobody reads cannot say "this one is
   * not part of the record". Hence the origin tag, the status chip whose *text* is the
   * state, and the footnote at the bottom — which is not decoration. The whole reason this
   * component exists beside {@link TranscriptPanel} is to avoid promising a durability only
   * one of its two channels has.
   *
   * **It renders nothing it cannot vouch for.** The panel is gated on the live state being
   * about the target on screen, because a stale item here is actively misleading — it looks
   * like the target in front of you doing something it did not do. `liveSkipped` is shown
   * rather than swallowed for the same reason: a transcript that looked complete and began
   * part way through the record would be the wrong kind of quiet.
   *
   * No ordering is done here. `app.liveItems` is already in arrival order and that *is* the
   * store's order on the record channel; re-sorting it in the view would either break it or
   * invent a sequence for activity items that the contract refuses to claim.
   */
  import ChatItem from "./ChatItem.svelte";
  import type { App } from "../app.svelte";
  import { atBottom } from "../scroll";

  let { app }: { app: App } = $props();

  /** Whether this panel is about the target on screen, and has anything to say about it. */
  let showing = $derived(
    app.liveTargetId === app.viewTargetId &&
      (app.liveWatching ||
        app.liveReconnecting ||
        app.liveItems.length > 0 ||
        app.liveDetail !== "" ||
        app.liveRecoveries.length > 0),
  );
  /** The connection's state as words, not only as a colour. */
  let status = $derived(
    app.liveReconnecting
      ? "Reconnecting"
      : app.liveWatching
        ? app.liveCaughtUp
          ? "Live"
          : "Catching up"
        : "Stopped",
  );
  let statusTint = $derived(
    app.liveReconnecting
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
   * `undefined` until the panel is mounted — `bind:this` has nothing to hand over before
   * then, and this panel is behind an `{#if}` that mounts and unmounts it during a session
   * as {@link showing} changes — so every read of it below is guarded rather than assumed.
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
    const arrived = app.liveItems.length;
    if (arrived === 0 || list === undefined || !pinned) return;
    list.scrollTop = list.scrollHeight;
  });
</script>

{#if showing}
  <section class="live" aria-label="Live transcript">
    <div class="head">
      <span class="title">Live</span>
      <span class="chip status" data-tint={statusTint}>{status}</span>
      <!--
        Labelled `record to` rather than `seq`, because the number is a *position in the
        record* and not a count of anything on screen. A bare `seq 42` beside a list of
        twelve items reads as though it were about those items; what it actually says is
        that every committed event up to sequence 42 has been delivered, which is also the
        point a reconnect would resume after. Activity items are not in it at all.
      -->
      <span
        class="cursor mono"
        title="Every committed event up to this store-assigned sequence has been delivered. Live activity has no position and is not counted here."
      >
        record to {app.liveCursor}
      </span>
    </div>

    {#if app.liveSkipped > 0}
      <p class="note">
        This transcript starts part way through the record: {app.liveSkipped}
        earlier committed {app.liveSkipped === 1 ? "event is" : "events are"} not
        shown here. They are still in the target's event log.
      </p>
    {/if}

    {#if app.liveDetail !== ""}
      <p class="detail" role="alert">{app.liveDetail}</p>
    {/if}

    {#if app.liveRecoveries.length > 0}
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
      `role="log"` rather than `aria-live="polite"`. The role carries an implicit polite
      live region with log semantics — append-only, newest last, and only the addition
      announced — which is exactly what this list is, so a screen reader is still told as
      items arrive rather than only when something moves focus here.

      What it must *not* do is read the payload out. `input` and `output` are capped by the
      server but still run to thousands of characters, and a reader being narrated a whole
      tool result aloud on every arrival cannot use this screen at all. That is why both are
      in collapsed `<details>` below: shut, their bulk is not in the accessibility tree, and
      it is not in the 320px box either.
    -->
    <ol
      bind:this={list}
      onscroll={trackPinned}
      class={["items", app.liveItems.length === 0 && "hollow"]}
      role="log"
      aria-label="Live run items, oldest first"
    >
      {#each app.liveItems as item (item.id)}
        <!--
          The row itself is {@link ChatItem}, shared with the planner chat. Nothing is
          grouped, paired or folded here: `app.liveItems` is in arrival order, and on the
          record channel that *is* the store's order (see this component's header), so this
          panel passes each item through on its own. The chat's merge rule is the chat's.
        -->
        <ChatItem {item} />
      {/each}
    </ol>

    {#if app.liveWatching && app.liveItems.length === 0}
      <p class="empty">
        Nothing yet — a run's turns, tool calls and recorded results appear here
        as they happen.
      </p>
    {/if}

    <!--
      Required, not decorative: the component exists to keep the two channels apart, and
      this is where it says in words what the tags above mean.
    -->
    <p class="footnote">
      Items marked <strong>record</strong> are committed, and arrive in the
      order the store assigned them. Items marked
      <strong>activity</strong> are in-process only: they are not part of the record,
      are not replayed on a reconnect, and can be dropped under load.
    </p>
  </section>
{/if}

<style>
  .live {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 16px;
    border-top: 1px solid var(--border-muted);
    background: var(--bg-layer-01);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .title {
    color: var(--text-base);
    font-size: 12px;
    font-weight: 600;
  }
  /*
   * `--text-muted` is the floor for text in this panel; `--text-faint` is not usable here.
   *
   * Every label below is 10-11px, and `--text-faint` measures 3.4-4.0:1 against both of
   * this panel's backgrounds (`--bg-layer-01` on the section, `--bg-base` on the list) in
   * both themes, which is under WCAG AA's 4.5:1 for normal-size text. `--text-muted` is
   * 6.1-7.0:1 across those same four pairings. So however secondary a piece of text is --
   * a cursor readout, a channel tag, the footnote -- it gets `--text-muted` or stronger.
   */
  .cursor {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: var(--text-muted);
    font-size: 11px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  /* One chip rule, tinted by `data-tint`, so every state reads as the same kind of thing. */
  .chip {
    display: inline-block;
    padding: 1px 6px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-sm);
    background: var(--bg-layer-02);
    color: var(--text-base);
    font: 600 10px/var(--lh-tight) var(--font-sans);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .chip[data-tint="success"] {
    border-color: var(--state-border-success);
    background: var(--state-bg-success);
    color: var(--state-fg-success);
  }
  .chip[data-tint="warning"] {
    border-color: var(--state-border-warning);
    background: var(--state-bg-warning);
    color: var(--state-fg-warning);
  }
  .chip[data-tint="danger"] {
    border-color: var(--state-border-danger);
    background: var(--state-bg-danger);
    color: var(--state-fg-danger);
  }
  .note,
  .detail,
  .empty,
  .footnote {
    margin: 0;
    font-size: 11px;
    line-height: var(--lh-compact);
  }
  .note {
    color: var(--state-fg-warning);
  }
  .recovery {
    display: grid;
    gap: 6px;
    max-height: 120px;
    overflow: auto;
    overflow-wrap: anywhere;
  }
  .detail {
    color: var(--state-fg-danger);
  }
  .empty,
  .footnote {
    color: var(--text-muted);
  }
  .footnote strong {
    color: var(--text-muted);
    font-weight: 600;
  }
  /* Bounded like `TranscriptPanel`'s entries, but taller: during a run this is the screen. */
  .items {
    display: flex;
    max-height: 320px;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 8px;
    overflow-y: auto;
    border: 1px solid var(--border-muted);
    border-radius: var(--radius-md);
    background: var(--bg-base);
    list-style: none;
  }
  /*
   * Empty, the box collapses rather than unmounting: the `<ol>` is the live region, and a
   * region added to the DOM at the same moment as its first child is not reliably announced.
   */
  .items.hollow {
    padding: 0;
    border: 0;
  }
</style>
