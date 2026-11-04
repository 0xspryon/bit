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
  import ContextMeter from "./ContextMeter.svelte";
  import { IconArrowUp, IconPaperclip } from "../icons";
  import { whenText } from "../goalFormat";
  import type { MeterFact } from "../chat";
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

  /**
   * What the context panel can say about this conversation, and only what it can.
   *
   * The session comes from the replay — which is also the thing that says whether this
   * process still holds it — and the harness and model come from the last turn this tab
   * sent, because that is the only answer that names them (`app.goalAgentRuntime`). A
   * conversation this tab has only *read* therefore shows its session and not its model,
   * which is the honest state: the model behind somebody else's session is not knowable
   * from here, and the harness's default is not an answer to it.
   */
  let meterFacts = $derived<readonly MeterFact[]>([
    ...(app.goalConversation?.harnessSessionId == null
      ? []
      : [
          {
            term: "Session",
            value: app.goalConversation.harnessSessionId,
          },
        ]),
    ...(app.goalAgentRuntime === undefined
      ? []
      : [
          { term: "Harness", value: app.goalAgentRuntime.instanceId },
          {
            term: "Model",
            value: `${app.goalAgentRuntime.providerId}/${app.goalAgentRuntime.modelId}`,
          },
        ]),
    /*
     * The brief's "message counts", with the value saying what it counts.
     *
     * The harness's **replayed** copy, which is the only count this application has: not a
     * word of the conversation is stored (rulings 4 and decision 14), so nothing knows how
     * many turns it really had — only how many the harness still holds. The operator's own
     * unreplayed turns are deliberately not added in: they are this tab's, they are gone on
     * a reload, and a single number covering both would be a count of two different things.
     */
    ...(app.goalConversation === undefined
      ? []
      : [
          {
            term: "Replayed",
            value: `${String(app.goalConversation.items.length)} ${
              app.goalConversation.items.length === 1 ? "item" : "items"
            } held by the harness${
              app.goalConversation.truncated ? ", shortened" : ""
            }`,
          },
        ]),
  ]);

  function submit(event: Event): void {
    event.preventDefault();
    if (!canSend) return;
    void app.sendGoalMessage();
  }

  /**
   * The file input, which is the only way a browser can produce bytes to upload.
   *
   * Visually hidden rather than absent, and clicked through the paperclip beside the
   * submit button: a native file control cannot be opened without a real `<input>`, and the
   * unstyled one does not sit in a composer strip. It stays in the accessibility tree with
   * its own label, so the paperclip is a convenience over a working control rather than a
   * replacement for one.
   */
  let picker = $state<HTMLInputElement | undefined>(undefined);

  /**
   * What the operator picked, handed straight to the server.
   *
   * **The input is cleared before the upload, not after.** A file input does not fire
   * `change` when the same file is picked twice in a row, so an operator who attached the
   * wrong file, fixed it on disk and picked it again would get nothing at all. Clearing
   * first makes every pick a new one.
   *
   * No size or type check here: this tab is not told the caps, and the server's refusal
   * carries the figures — see {@link App.attachGoalFiles}.
   */
  function chosen(
    event: Event & { currentTarget: EventTarget & HTMLInputElement },
  ): void {
    const files = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = "";
    if (files.length === 0) return;
    void app.attachGoalFiles(files);
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

  {#snippet meter()}
    <ContextMeter
      meter={app.goalContextMeter}
      label="Goal agent context"
      facts={meterFacts}
    />
  {/snippet}

  {#snippet footnote()}
    Rows marked <strong>record</strong> are committed events and arrive in the
    order the store assigned them. Rows marked
    <strong>activity</strong> — including your own messages — are not part of the
    record and are not stored here. On a reload the conversation — your messages,
    the agent's words and its tool calls — comes back from the harness while the harness
    keeps it.
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
      <!--
        What has been attached, above the strip and inside the composer's border.

        Named rather than counted, because the name is what the agent will see: these are
        the server's own names for the files, and an operator comparing this list against
        what the agent says it read has to be looking at the same words. Each row carries
        its size for the same reason the refusal does — it is the figure the cap is about.
      -->
      {#if app.goalAttachments.length > 0}
        <ul class="attached" aria-label="Files attached to this goal">
          {#each app.goalAttachments as file (file.name)}
            <li>
              <IconPaperclip width="10" height="10" aria-hidden="true" />
              <span class="attached-name mono">{file.name}</span>
              <span class="attached-size">{file.bytes} bytes</span>
              {#if file.replaced}
                <span class="attached-note">replaced an earlier one</span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
      <div class="strip">
        <span class="hint">
          It steers the planner; it cannot create intents itself. Enter sends,
          Shift+Enter for a new line.
        </span>
        <label class="visually-hidden" for="goal-attach"
          >Attach files to this goal</label
        >
        <input
          bind:this={picker}
          id="goal-attach"
          class="visually-hidden"
          type="file"
          multiple
          disabled={app.goalAttaching}
          onchange={chosen}
        />
        <button
          class="square attach"
          type="button"
          disabled={app.goalAttaching}
          aria-label="Attach files the goal agent can read"
          title="Attach files the goal agent can read"
          onclick={() => picker?.click()}
        >
          {#if app.goalAttaching}
            <span class="spinner" aria-hidden="true"></span>
          {:else}
            <IconPaperclip width="14" height="14" />
          {/if}
        </button>
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
    <!--
      A refused upload says why, in the server's words. `role="alert"` because the operator
      just acted and the thing they did had no effect: every reason names the figure it is
      about — this file's size against the cap, how many the goal already holds, what a
      usable filename looks like — and all of it is the server's sentence rather than this
      component's summary of it.
    -->
    {#if app.goalAttachDetail !== ""}
      <p class="error" role="alert">{app.goalAttachDetail}</p>
    {/if}
    <!--
      And an accepted one says what happens next, which is the part an operator could
      otherwise get wrong: the files are on disk and the agent has **not** been told yet.
      The server composes that sentence because only the server knows where they went and
      what the next prompt will carry.
    -->
    {#if app.goalAttachNote !== ""}
      <p class="hint" role="status">{app.goalAttachNote}</p>
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
  /*
   * The attachment list, inside the composer's border and above its strip: these files
   * belong to the message being written, so they read as part of the box rather than as a
   * panel beside it. A dashed rule separates them from the textarea without adding a second
   * solid border inside one.
   */
  .attached {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 0;
    padding: 6px 12px;
    border-top: 1px dashed var(--border-muted);
    list-style: none;
  }
  .attached li {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 6px;
    font-size: 11px;
    line-height: var(--lh-compact);
    color: var(--text-muted);
  }
  .attached-name {
    color: var(--text-base);
    overflow-wrap: anywhere;
  }
  .attached-size {
    font-variant-numeric: tabular-nums;
  }
  .attached-note {
    font-style: italic;
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
  /*
   * Quiet beside the submit button, which is the only coloured thing on this surface. An
   * attach is a step towards a message rather than the action itself, and two filled
   * buttons in one strip would read as two ways to send.
   */
  .attach {
    background: transparent;
    color: var(--text-muted);
  }
  .attach:hover:not(:disabled) {
    background: var(--bg-layer-02);
    color: var(--text-base);
  }
  .attach:focus-visible,
  .submit:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 1px;
  }
  .attach:disabled,
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
</style>
