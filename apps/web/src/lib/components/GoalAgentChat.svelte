<script lang="ts">
  /**
   * The goal conversation: tell the agent what you want, watch it work, steer the planner.
   *
   * **The surface an operator actually opens**, and the only one on this page with a box to
   * type in. {@link PlannerChat} above it is read-only because a planner round's prompt is
   * not the operator's to write; this one is writeable because the goal agent is *who the
   * operator is talking to*. Both are {@link Chat}, with their own separator, count,
   * footnote and — here — composer. Nothing in `Chat.svelte` knows which is which.
   *
   * ## What it is honest about, because nothing here is stored
   *
   * Not one word of this conversation is persisted (the goal and planner flow's decisions
   * 14 and 15). Three consequences are on screen rather than in a comment:
   *
   * - **The replayed block is labelled as the harness's copy**, which it may delete. That
   *   is `Chat`'s rendering of {@link RoundProse}, and the sentence comes from the server.
   * - **What you have typed in this tab is this tab's.** `chat.ts` mints those rows
   *   locally; a reload loses them and the harness's own copy brings them back as `user`
   *   entries. They are marked `activity`, which is the truth: not part of the record.
   * - **A restart ends a conversation.** The server says so on the turn that opens a new
   *   one, and {@link App.goalSessionNote} is where that sentence goes — above the
   *   composer, where the operator is looking, rather than in a toast that disappears.
   *
   * ## Operator and agent are distinguishable without colour
   *
   * A row's own label says which it is — "You" on a minted turn, "Reply" on the agent's
   * narration — and {@link ChatItem} carries the record/activity marker as a word. The
   * composer's own strip is the only colour on this surface and it is the submit button,
   * which is the same `--bg-inverse` every primary action in this app uses. Nothing here
   * relies on a hue to tell two speakers apart.
   */
  import Button from "./Button.svelte";
  import Chat from "./Chat.svelte";
  import { IconArrowUp } from "../icons";
  import { whenText } from "../goalFormat";
  import type { App } from "../app.svelte";

  let { app }: { app: App } = $props();

  let groups = $derived(app.goalConversationChat.groups);
  let goal = $derived(app.openGoalView);
  /**
   * Whether the goal will take a message at all.
   *
   * An ended goal's agent has no authority left: every write it made would be refused by
   * the store, and the server refuses to open a conversation on one. So the composer goes
   * away rather than submitting into a refusal — and the sentence that replaces it says
   * which, because a box that is simply gone is a question.
   */
  let active = $derived(goal?.status === "active");
  let canSend = $derived(
    active && app.goalMessage.trim() !== "" && !app.goalSending,
  );
  /**
   * The sentence about the read itself, kept apart from a conversation saying it has no
   * prose.
   *
   * {@link App.goalConversationDetail} is only set when no server answered or the server
   * refused the request outright. A conversation the harness has forgotten is a
   * *successful* read and says so on its own separator, which is why that case never
   * reaches here.
   */
  let detail = $derived(app.goalConversationDetail);

  function submit(event: Event): void {
    event.preventDefault();
    if (!canSend) return;
    void app.sendGoalMessage();
  }

  /**
   * Enter sends; Shift+Enter is a newline.
   *
   * The convention every chat composer uses, and the reason it is worth the handler: a
   * multi-line directive is the normal case here — the agent is told to say things in full
   * sentences — so a textarea that could not take a newline would be the wrong control, and
   * one that needed the mouse to send would be the wrong habit.
   */
  function onkeydown(event: KeyboardEvent): void {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    if (!canSend) return;
    void app.sendGoalMessage();
  }
</script>

<Chat
  label="Goal conversation"
  {groups}
  readonly={!active}
  count={app.goalTurns.length === 0
    ? ""
    : `${String(app.goalTurns.length)} sent from this tab`}
  note={app.goalSessionNote}
  {detail}
  empty="Nobody has talked to this goal's agent yet. Say what you want investigated and it will steer the planner; it cannot create intents itself."
>
  {#snippet separator(group)}
    <!--
      The heading. Everything in it is a fact the server stated: which session this is, and
      whether this process is still holding it. A conversation whose words came back from a
      session nobody holds is readable and not continuable, and that is the one thing a
      reader must not have to infer.
    -->
    <span class="sep-title">Goal agent</span>
    {#if group.subject.conversation?.harnessSessionId}
      <span
        class="sep-id mono"
        title="Harness session {group.subject.conversation.harnessSessionId}"
        >{group.subject.conversation.harnessSessionId}</span
      >
      <span class="sep-when"
        >read {whenText(group.subject.conversation.at)}</span
      >
    {/if}
    {#if group.subject.conversation !== undefined && !group.subject.conversation.live}
      <span class="chip">not this process's</span>
    {/if}
    {#if group.subject.awaiting}
      <span class="chip" data-tint="warning">waiting</span>
    {/if}
  {/snippet}

  {#snippet footnote()}
    Rows marked <strong>record</strong> are committed events and arrive in the
    order the store assigned them. Rows marked
    <strong>activity</strong> — including your own messages — are not part of the
    record, are not stored, and are gone on a reload. What the agent said comes back
    from the harness while the harness keeps it.
  {/snippet}

  {#snippet composer()}
    <form class="box" onsubmit={submit}>
      <label class="visually-hidden" for="goal-message"
        >Say something to this goal's agent</label
      >
      <textarea
        id="goal-message"
        rows="3"
        placeholder="What should be investigated next?"
        bind:value={app.goalMessage}
        disabled={app.goalSending}
        {onkeydown}></textarea>
      <div class="strip">
        <span class="hint">
          It steers the planner; it cannot create intents itself. Enter sends,
          Shift+Enter for a new line.
        </span>
        <button
          class="square submit"
          type="submit"
          disabled={!canSend}
          aria-label="Send to the goal agent"
          title="Send to the goal agent"
        >
          {#if app.goalSending}
            <span class="spinner" aria-hidden="true"></span>
          {:else}
            <IconArrowUp width="14" height="14" />
          {/if}
        </button>
      </div>
    </form>
    {#if app.goalSendDetail !== ""}
      <p class="error" role="alert">{app.goalSendDetail}</p>
    {/if}
  {/snippet}

  {#snippet controls()}
    {#if !active}
      <!--
        No composer, and a sentence instead of a disabled box. An ended goal's agent has no
        authority left, so a box that submitted into a refusal would be worse than one that
        explains itself — the same argument the end control on this page makes.
      -->
      <p class="hint">
        This goal has ended, so its agent has no authority left: nothing new is
        dispatched under it and no planner round is opened on it. What was said
        is above for as long as the harness keeps it.
      </p>
    {:else if app.goalAwaiting}
      <span class="pulse" aria-hidden="true"></span>
      <span class="status" role="status">Waiting for the agent…</span>
      <Button
        size="sm"
        variant="quiet"
        onclick={() => void app.loadGoalConversation(app.openGoalId)}
      >
        Re-read
      </Button>
    {/if}
  {/snippet}
</Chat>

<style>
  /* The separator's own type. Its layout — the rule above it — belongs to {@link Chat}. */
  .sep-title {
    font: 600 12px/var(--lh-compact) var(--font-sans);
    color: var(--text-base);
  }
  .sep-id {
    max-width: 24ch;
    overflow: hidden;
    font-size: 10px;
    color: var(--text-muted);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .sep-when {
    font-size: 11px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .chip {
    display: inline-block;
    padding: 1px 6px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-sm);
    background: var(--bg-layer-01);
    color: var(--text-muted);
    font: 600 10px/var(--lh-tight) var(--font-sans);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .chip[data-tint="warning"] {
    border-color: var(--state-border-warning);
    background: var(--state-bg-warning);
    color: var(--state-fg-warning);
  }
  /*
   * One container with the control strip inside its border, which is {@link ComposeBox}'s
   * arrangement and is deliberately the same: these are the only two places in this app
   * where something is submitted, and two different-looking composers would read as two
   * different kinds of action.
   */
  .box {
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    background: var(--bg-layer-01);
  }
  textarea {
    width: 100%;
    padding: 10px 12px;
    border: 0;
    border-radius: var(--radius-md) var(--radius-md) 0 0;
    background: transparent;
    color: var(--text-base);
    /* 16px, so iOS and Android do not zoom the page on focus at tablet widths. */
    font: 400 16px/24px var(--font-sans);
    resize: vertical;
  }
  textarea:disabled {
    opacity: 0.55;
  }
  textarea:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: -2px;
  }
  .strip {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    /* 44px, the minimum comfortable target height, like the run composer's strip. */
    min-height: 44px;
    padding: 0 8px 0 12px;
  }
  .hint {
    flex: 1;
    min-width: 0;
    font-size: 11px;
    line-height: var(--lh-compact);
    color: var(--text-muted);
  }
  .square {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .submit {
    background: var(--bg-inverse);
    color: var(--text-inverse);
  }
  .submit:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .spinner {
    width: 12px;
    height: 12px;
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }
  /* The same pulse the run strip uses, and `aria-hidden` for the same reason: it is a
     second rendering of what the sentence beside it already says. */
  .pulse {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-muted);
    animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 0.35;
    }
    50% {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .pulse {
      animation: none;
      opacity: 0.7;
    }
  }
  .status {
    font-size: 12px;
    color: var(--text-base);
  }
  .error {
    margin: 0;
    font-size: 12px;
    line-height: var(--lh-compact);
    color: var(--state-fg-danger);
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
</style>
