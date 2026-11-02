<script lang="ts" generics="Subject">
  /**
   * A conversation with an agent: grouped turns, a strip of controls, and optionally a box
   * to type in.
   *
   * **Parameterised on two axes, and it needed both.** Ruling 1 says this component is
   * built for the planner view *and* reused by slice 9's goal conversation with its
   * composer enabled, which is the reason it is sequenced first. The composer half was a
   * prop from the start. The other half was not, and that was the mistake: the data model
   * was the planner's — a required `PlanRoundView` per group, and `roundStatusLabel`,
   * `roundConclusion` and "Planner round <id>" written into this file's markup — so slice 9
   * would have had to refactor the component anyway. A goal conversation has **no rounds in
   * it at all**; rendering it through a round would mean fabricating a status, a
   * disposition, a budget and an `intentsAdded` that mean nothing, under a heading naming a
   * round that does not exist.
   *
   * So the group's subject is a type parameter this component never looks inside, and the
   * caller renders its own heading through the `separator` snippet. {@link PlannerChat} is
   * the planner's; slice 9 writes its own and changes nothing here.
   *
   * **A third axis, and a small one: `layout`.** The planner's and the goal agent's chats are
   * panels on a page; the scope importer's (A6) is the page. `layout="thread"` arranges the
   * same groups as an 800px reading column with no frame, a lead when empty, the composer
   * pinned beneath and rows read as a transcript. It changes where things are put and how
   * a row reads, not what any of it means — the rules below are the same for both.
   *
   * What stays shared is everything that is genuinely about watching an agent work: the
   * grouping, the record-versus-activity distinction on every row ({@link ChatItem}), the
   * folding of a tool result into the call it answers, the pending-until-recorded merge
   * rule, the replayed-prose states, and following the newest turn only while the reader is
   * already at the bottom. All of the rules are in `chat.ts`, which is a plain module so
   * they can be tested without a browser; this component arranges and says.
   *
   * ## What it must never be quiet about
   *
   * Narration is not persisted (the goal and planner flow's decision 14), so three
   * different things look like an empty group and all three have to read differently:
   * nothing has arrived **yet**, the harness has **forgotten** it, and the subject
   * **produced none**. {@link RoundProse} is those three plus `live` and `loading`, and each
   * gets its own sentence. "The harness no longer has this" is deliberately styled as a note
   * rather than as an error: for a month-old round it is the expected answer, and an alert
   * would make the ordinary case look like a fault.
   *
   * The separator is rendered whatever the prose did, which is what makes a reloaded
   * conversation still legible — decision 16, and why a refresh degrades rather than blanks.
   */
  import type { Snippet } from "svelte";

  import ChatItem from "./ChatItem.svelte";
  import type { ChatGroup } from "../chat";
  import { atBottom } from "../scroll";

  let {
    label,
    groups,
    separator,
    tail,
    readonly,
    count = "",
    note = "",
    footnote,
    controls,
    composer,
    meter,
    detail = "",
    empty,
    layout = "panel",
  }: {
    /** The heading, and the list's accessible name. */
    label: string;
    /** Oldest first, so the newest group is at the bottom where a chat's newest turn is. */
    groups: readonly ChatGroup<Subject>[];
    /**
     * One group's heading, rendered by the caller from the caller's own subject.
     *
     * A snippet rather than fields on the group, because what a heading *says* is the one
     * thing that differs completely between a planner round and a goal conversation. See
     * this component's header.
     */
    separator: Snippet<[ChatGroup<Subject>]>;
    /**
     * What follows one group's rows, rendered by the caller from the caller's own subject.
     *
     * The importer's streaming cursor (A6 D3) is the one use: it marks a turn the agent is
     * still producing, and only the caller knows whether its subject is in flight — the
     * same reason {@link separator} is the caller's. Absent renders nothing.
     */
    tail?: Snippet<[ChatGroup<Subject>]>;
    /**
     * Whether the operator may write into this conversation.
     *
     * `true` hides the composer entirely rather than disabling it: a disabled box reads as
     * "not yet", and the planner round is "not ever" — the round's prompt is not the
     * operator's to write. The controls strip stays either way, because stopping is an
     * action on the subject rather than a message to it.
     */
    readonly: boolean;
    /** A short count beside the heading, in the caller's own words. Empty shows none. */
    count?: string;
    /** A sentence about what this chat is not showing. The caller composes it. */
    note?: string;
    /**
     * The durability footnote, which the caller owns because it is about the caller's
     * channels. Required, not optional: a chat mixing committed records with in-process
     * narration and saying nothing about the difference is the one thing `live.ts` exists
     * to prevent.
     */
    footnote: Snippet;
    /** The strip where a composer would be: the subject's own controls. */
    controls?: Snippet;
    /** The composer. Rendered only when {@link readonly} is false. */
    composer?: Snippet;
    /**
     * The context indicator, at the top of the pane beside the heading.
     *
     * A snippet for the reason {@link separator} is one: a meter is about **one agent's
     * session**, and which session that is, on what model, with what window, is the
     * caller's own fact — a goal conversation and a planner round keep it in different
     * places. This component places it and knows nothing about what is in it, which is also
     * what keeps the planner's vocabulary out of this file.
     *
     * Optional, and absent is the honest state of a pane whose session has not called a
     * model yet: `ContextMeter` renders nothing without a measurement, so there is no
     * placeholder here to render either.
     */
    meter?: Snippet;
    /** A sentence about the whole chat, when something is wrong with reading it. */
    detail?: string;
    /** What to say when there is no conversation at all. */
    empty: string;
    /**
     * How the conversation is arranged. `panel` (the default) is the planner's and the goal
     * agent's: a captioned, bordered, 420px-tall list among other things on a page.
     * `thread` is a chat that **is** the page: a reading column of 800px, no frame, the
     * newest turn at the bottom of the space the page has and the composer pinned under it.
     *
     * It is a layout and nothing else. Both arrange the same groups and run the same rules;
     * `thread` differs in that the heading, the empty sentence and the footnote are placed
     * for a page rather than a panel, a group's rows read as a transcript
     * ({@link ChatItem}'s `narrated`) rather than as a ledger, and nothing is boxed. See
     * the style block for what each does.
     */
    layout?: "panel" | "thread";
  } = $props();

  /**
   * The scroll container, for the one thing this component does to the DOM by hand.
   *
   * `undefined` until mounted, so every read of it is guarded rather than assumed.
   */
  let list = $state<HTMLOListElement | undefined>(undefined);

  /**
   * Whether the view is following the newest turn.
   *
   * {@link LiveTranscript} has the long form of this and it is worth not restating: the
   * flag is maintained from the container's own scroll events and **not** computed inside
   * the effect, because by the time the effect runs the new row is already in the DOM and
   * has already made `scrollHeight` taller — so "was the reader at the bottom *before* this
   * arrived" is a question the geometry can no longer answer. It starts `true` so a freshly
   * opened chat follows from its first row.
   */
  let pinned = $state(true);

  function trackPinned(): void {
    if (list === undefined) return;
    pinned = atBottom(list);
  }

  /** How many rows are on screen, which is what an arrival changes. */
  let rowCount = $derived(
    groups.reduce(
      (total, group) => total + group.rows.length + group.replayed.length,
      0,
    ),
  );

  /*
   * Follow the newest row, while {@link pinned}.
   *
   * The count is read first and unconditionally: an effect depends only on what it read
   * the last time it ran, so a guard before that read would unsubscribe this from arrivals
   * for as long as the reader stayed scrolled up — and it would then never catch the
   * arrival that should have resumed following.
   */
  $effect(() => {
    const arrived = rowCount;
    if (arrived === 0 || list === undefined || !pinned) return;
    list.scrollTop = list.scrollHeight;
  });

  let anything = $derived(groups.length > 0);
  let thread = $derived(layout === "thread");
</script>

<section
  class={["chat", thread && "thread", thread && !anything && "idle"]}
  aria-label={label}
>
  {#if !thread}
    <div class="head">
      <span class="title">{label}</span>
      {#if count !== ""}
        <span class="count">{count}</span>
      {/if}
      <!--
        The context indicator, at the top of the pane. Last in the strip and pushed to the
        end, so the heading and the count stay where a reader's eye starts.
      -->
      {#if meter !== undefined}
        <div class="meter">{@render meter()}</div>
      {/if}
    </div>
  {:else if !anything}
    <!--
      A page's empty state is its lead: the label as the heading and the sentence under it,
      with the composer directly beneath, rather than a caption over an empty frame.
    -->
    <div class="hero">
      <h2 class="hero-title">{label}</h2>
      <p class="hero-text">{empty}</p>
    </div>
  {/if}

  {#if note !== ""}
    <p class="note">{note}</p>
  {/if}

  {#if detail !== ""}
    <p class="detail" role="alert">{detail}</p>
  {/if}

  <!--
    `role="log"` rather than `aria-live="polite"`: the role carries an implicit polite live
    region with log semantics — append-only, newest last, only the addition announced — which
    is what this list is. What it must not do is read the payloads out, which is why every
    tool argument and result is in a collapsed `<details>` inside {@link ChatItem}.
  -->
  <ol
    bind:this={list}
    onscroll={trackPinned}
    class={["groups", !anything && "hollow"]}
    role="log"
    aria-label="{label}, oldest first"
  >
    {#each groups as group (group.key)}
      <li class="group">
        <!--
          The caller's own heading. Every part of it that survives a reload does so because
          it comes from a row rather than from narration; this component makes no claim
          about what is in it.
        -->
        <div class="sep">{@render separator(group)}</div>

        {#if group.prose._tag === "loading"}
          <p class="note" role="status">
            Reading what the harness still has of this…
          </p>
        {:else if group.prose._tag === "replayed"}
          <!--
            Replayed, and labelled as such. It is the harness's own copy in the reduced
            shape `AgentHarness.messages` answers with, so there are no call ids and no tool
            arguments in it: a call and its result are not paired here as they are live.
            That is the cost decision 14 accepted, said rather than hidden.
          -->
          <p class="note">{group.prose.note}</p>
          <ol class="replay">
            {#each group.replayed as message (message.index)}
              <li class="replayed">
                <span class="replay-type mono">{message.type}</span>
                {#if message.text !== ""}
                  <p class="replay-text">{message.text}</p>
                {/if}
                {#if message.error !== undefined}
                  <p class="replay-error">{message.error}</p>
                {/if}
              </li>
            {/each}
          </ol>
          {#if group.prose.truncated}
            <p class="note">
              Shortened: not every message the harness holds is shown.
            </p>
          {/if}
        {:else if group.prose._tag !== "live"}
          <!--
            The three absences and the budget note, each as its own sentence from the
            server. `role="status"` only on `pending`, which is the one worth announcing as
            it changes; "the harness has forgotten this" is a fact about a finished subject
            and announcing it on arrival would interrupt a reader for no action.
          -->
          <p
            class="note"
            role={group.prose._tag === "pending" ? "status" : undefined}
          >
            {group.prose.note}
          </p>
        {/if}

        {#if group.rows.length > 0}
          <ol class="items">
            {#each group.rows as row (row.key)}
              <ChatItem
                item={row.item}
                proposedBy={row.proposedBy}
                result={row.result}
                write={row.write}
                summary={row.summary}
                narrated={thread}
              />
            {/each}
          </ol>
        {/if}

        {#if tail !== undefined}
          {@render tail(group)}
        {/if}
      </li>
    {/each}
  </ol>

  {#if !anything && !thread}
    <p class="empty" role="status">{empty}</p>
  {/if}

  <!--
    Under the composer on a page, where it reads as a footnote to the whole thread; above it
    in a panel, where the composer is the last thing. The same sentence either way, and
    required either way.
  -->
  {#if !thread}
    <p class="footnote">{@render footnote()}</p>
  {/if}

  {#if controls !== undefined}
    <div class="controls">{@render controls()}</div>
  {/if}

  {#if !readonly && composer !== undefined}
    <div class="composer">{@render composer()}</div>
  {/if}

  {#if thread}
    <p class="footnote">{@render footnote()}</p>
  {/if}
</section>

<style>
  .chat {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
  }
  .title {
    margin: 0;
    font: 600 11px/var(--lh-compact) var(--font-sans);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .count {
    font-size: 12px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  /*
   * Pushed to the end of the strip, and allowed to take the full width when its panel is
   * open: the detail is a two-column grid of pairs and a column of it squeezed beside a
   * heading would wrap every row.
   */
  .meter {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    justify-content: flex-end;
  }
  /*
   * `--text-muted` is the floor for text in here; `--text-faint` is not usable at these
   * sizes. See {@link ChatItem}'s style block for the measured ratios.
   */
  .note,
  .empty,
  .footnote,
  .detail {
    margin: 0;
    font-size: 11px;
    line-height: var(--lh-compact);
    color: var(--text-muted);
  }
  .detail {
    color: var(--state-fg-danger);
  }
  /*
   * Tall, because during a round this is the screen. Bounded, because the page under it has
   * an intent list, a briefing and an end control that must stay reachable.
   */
  .groups {
    display: flex;
    max-height: 420px;
    flex-direction: column;
    gap: 14px;
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
   * region added to the DOM at the same moment as its first child is not reliably
   * announced.
   */
  .groups.hollow {
    padding: 0;
    border: 0;
  }
  .group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  /*
   * The separator reads as a rule with words on it rather than as a heading, because it is
   * a boundary in a conversation and not a section of a document. The top border is what
   * carries the "new group" signal on a monochrome display. What is *inside* it is the
   * caller's.
   */
  .sep {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--border-strong);
  }
  .group:first-child .sep {
    padding-top: 0;
    border-top: 0;
  }
  .items,
  .replay {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  /*
   * A replayed message is visibly a thinner thing than a live row, which is accurate: it
   * has no call id, no arguments and no pairing. The dashed left rule is what says "this is
   * the harness's copy" without relying on colour.
   */
  .replayed {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-left: 8px;
    border-left: 1px dashed var(--border-muted);
  }
  .replay-type {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }
  .replay-text {
    margin: 0;
    font-size: 12px;
    line-height: var(--lh-compact);
    color: var(--text-base);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .replay-error {
    margin: 0;
    font-size: 11px;
    line-height: var(--lh-compact);
    color: var(--state-fg-danger);
    overflow-wrap: anywhere;
  }
  .controls,
  .composer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  /*
   * ── The thread layout ───────────────────────────────────────────────────────
   *
   * A chat that is the page. A6's panels D2–D4 are the spec: an 800px column, centred, the
   * log filling the height and scrolling inside it, the composer pinned beneath, and no
   * frame anywhere — a turn is told apart by what it holds and the space around it, not by
   * a rule. Everything below is under `.thread`, so the panel layout above is untouched.
   */
  .thread {
    flex: 1;
    min-height: 0;
    width: 100%;
    max-width: 800px;
    margin: 0 auto;
    gap: 10px;
    padding-top: 28px;
  }
  .thread .groups {
    flex: 1 1 auto;
    min-height: 0;
    max-height: none;
    gap: 26px;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
  }
  /* No conversation: the lead, the composer and what hangs off it, as one centred block. */
  .thread.idle {
    justify-content: center;
    padding-top: 0;
  }
  .thread.idle .groups {
    display: none;
  }
  .hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    margin-bottom: 18px;
    text-align: center;
  }
  .hero-title {
    margin: 0;
    font: 530 24px/32px var(--font-sans);
    letter-spacing: -0.01em;
    color: var(--text-base);
  }
  .hero-text {
    max-width: 620px;
    margin: 0;
    font: 400 13px/20px var(--font-sans);
    color: var(--text-muted);
    text-wrap: pretty;
  }
  /*
   * One turn: the operator's message, then the importer's header and everything under it.
   * The rule above a group is the panel's way of saying "new group"; here the operator's
   * own bubble says it, and the column's spacing does the rest.
   */
  .thread .group {
    gap: 12px;
  }
  .thread .sep {
    padding-top: 0;
    border-top: 0;
  }
  /* What the importer says sits under its header, indented past the avatar. */
  .thread .group > :not(.sep) {
    margin-left: 27px;
  }
  .thread .items {
    gap: 12px;
  }
  .thread .controls {
    justify-content: center;
  }
  .thread .composer {
    padding: 0;
  }
  .thread .footnote {
    text-align: center;
    padding-bottom: 14px;
  }
</style>
