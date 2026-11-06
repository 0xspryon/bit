<script lang="ts">
  /**
   * The chat shell's composer (A6 D2–D4, U6, U13): one box with the files tray above the
   * words and a strip inside its border, driven by a {@link ChatComposerSource} rather than
   * by any one chat's state.
   *
   * Moved here from `ImporterChat.svelte` unchanged in what it draws, so the goal, planner
   * and worker chats mount the same box. What a chat adds to the strip — the importer's
   * agent chip, model picker and caption — comes in through {@link strip}. The sentences
   * above the box (an open source's `notices`) are the shell's to draw, above this box, so
   * that A7-Q's dock can take the box's slot and leave them where they are.
   *
   * ## Three states, all the source's
   *
   * - **Open:** the textarea, the `+` when the source has a tray, the arrow, and D3's Send
   *   now while a turn runs and the source offers it.
   * - **Blocked** (`blocked`): the box as it was, its input disabled and the placeholder
   *   saying why — the importer's stranded, ended and refused sessions.
   * - **Closed** (`ClosedChatComposer`): a sentence where the input would be and
   *   nothing to send with — the planner's and a worker's, whose prompt is not the
   *   operator's to write. The source is the reason alone; the strip stays, and Stop is the
   *   shell's and keeps working.
   */
  import type { Snippet } from "svelte";

  import { IconArrowUp, IconPlus } from "../icons";
  import {
    composerCanSend,
    type ChatComposerSource,
    type ChatWords,
  } from "../chatShell";
  import { filesOfPaste } from "../composerFiles.svelte";
  import ComposerTray from "./ComposerTray.svelte";

  let {
    composer,
    words,
    working,
    first,
    dropping,
    id,
    strip,
    attachButton = $bindable(),
  }: {
    composer: ChatComposerSource;
    words: ChatWords;
    /** A turn runs: Send now is drawn (if offered) and the arrow queues. */
    working: boolean;
    /** The conversation is empty: D2's taller box. */
    first: boolean;
    /** Files are dragged over the shell, which says the box will take them. */
    dropping: boolean;
    /** The prefix of the textarea's and file input's ids (`importer` → `importer-message`). */
    id: string;
    /** What the chat puts in the strip after the `+`: chips, a picker, a caption. */
    strip?: Snippet | undefined;
    /** The `+`, which a refusal's dialog returns focus to. */
    attachButton?: HTMLButtonElement | undefined;
  } = $props();

  let canSend = $derived(composerCanSend(composer));
  let canSendNow = $derived(
    canSend &&
      working &&
      composer.closed === undefined &&
      composer.sendNow?.offered === true,
  );
  let files = $derived(
    composer.closed === undefined ? composer.files : undefined,
  );
  let closed = $derived(composer.closed);

  /**
   * How long the message is, shown once it nears the limit the server takes (U8 review 5):
   * a pasted statement of work is the importer's main use, and one over the limit is
   * refused on Send with both figures. Trimmed, as the limit is counted.
   */
  /** The words in the box; none in a closed one, which has no box to hold them. */
  let draft = $derived(composer.closed === undefined ? composer.draft : "");
  let length = $derived(draft.trim().length);
  let maxChars = $derived(
    composer.closed === undefined ? composer.maxChars : undefined,
  );
  let nearLimit = $derived(maxChars !== undefined && length > maxChars * 0.9);

  let box = $state<HTMLTextAreaElement | undefined>(undefined);
  /** The file input behind the `+`. */
  let picker = $state<HTMLInputElement | undefined>(undefined);
  /** Whether the focus is anywhere in the composer's box, for its strong border. */
  let focused = $state(false);

  /**
   * Puts focus in the box, and the caret at `caret` if given: a starter filled the draft,
   * or the model picker opened a new session whose draft is here. After the caller's
   * `tick`, since the textarea's value follows the state.
   */
  export function focus(caret?: number): void {
    if (box === undefined) return;
    box.focus();
    if (caret !== undefined) box.setSelectionRange(caret, caret);
  }

  /** The textarea, which a refusal's dialog returns focus to when there is no `+`. */
  export function input(): HTMLTextAreaElement | undefined {
    return box;
  }

  function submit(event: Event): void {
    event.preventDefault();
    if (canSend && composer.closed === undefined) composer.send("queued");
  }

  /**
   * D3's "Send now": a `preemptive` steer, for a message that cannot wait (A6 U6).
   *
   * Focus goes back to the box (A6 U6 review): the click left it on this button, which is
   * disabled once the draft clears and gone once the turn ends, and either drops focus to
   * `<body>` — where the operator's next words, a correction to the one just sent, would go
   * nowhere.
   */
  function sendNow(): void {
    if (!canSendNow || composer.closed !== undefined) return;
    composer.send("preemptive");
    box?.focus();
  }

  /**
   * Enter sends; Shift+Enter is a newline. {@link GoalAgentChat}'s convention, for its
   * reason: an agent is told things in sentences, often several.
   */
  function onkeydown(event: KeyboardEvent): void {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    if (canSend && composer.closed === undefined) composer.send("queued");
  }

  /**
   * The picker's files into the tray. The input is emptied straight away: it fires no
   * `change` for the same file picked twice in a row, which removing one from the tray and
   * picking it again is.
   */
  function chosen(
    event: Event & { currentTarget: EventTarget & HTMLInputElement },
  ): void {
    const picked = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = "";
    files?.add(picked);
  }

  /** A paste of files alone attaches them; a paste with text in it is a paste of the text. */
  function onpaste(event: ClipboardEvent): void {
    if (files === undefined || composer.closed !== undefined) return;
    const pasted = filesOfPaste(event);
    if (pasted.length === 0 || composer.blocked) return;
    event.preventDefault();
    files.add(pasted);
  }
</script>

<form
  class={[
    "box",
    first && "first",
    closed !== undefined && "closed",
    (focused || draft !== "" || (files?.items.length ?? 0) > 0) && "in-use",
    dropping && "dropping",
  ]}
  onfocusin={() => (focused = true)}
  onfocusout={(event) => {
    const next = event.relatedTarget;
    focused = next instanceof Node && event.currentTarget.contains(next);
  }}
  onsubmit={submit}
  aria-busy={composer.closed === undefined && composer.sending}
>
  {#if composer.closed !== undefined}
    <!--
      No input, and a sentence in its place: a box that took words and refused them, or a
      textarea that could never be typed in, would be a question. What the chat can still do
      is the shell's: Stop above, and a question the agent asks takes this box's place.
    -->
    <p class="closed-reason">{composer.closed}</p>
  {:else}
    <label class="visually-hidden" for="{id}-message"
      >{words.messageLabel}</label
    >
    <!-- The files this message will carry, above the words (A6 U13). -->
    {#if files !== undefined}
      <ComposerTray {files} disabled={composer.sending} />
    {/if}
    <textarea
      bind:this={box}
      id="{id}-message"
      rows="1"
      class={[first && "first"]}
      placeholder={composer.placeholder}
      disabled={composer.blocked}
      bind:value={composer.draft}
      {onkeydown}
      {onpaste}></textarea>
  {/if}
  <div class="strip">
    {#if composer.closed === undefined && files !== undefined}
      <!--
        The picker behind the `+`, out of the Tab order (chat shell review 1): it is hidden,
        so a Tab stop on it is a stop on nothing the operator can see; the `+` opens it.
      -->
      <label class="visually-hidden" for="{id}-attach"
        >Attach files to this message</label
      >
      <input
        bind:this={picker}
        id="{id}-attach"
        class="visually-hidden"
        tabindex="-1"
        type="file"
        multiple
        disabled={composer.blocked}
        onchange={chosen}
      />
      <button
        bind:this={attachButton}
        class="icon-btn"
        type="button"
        disabled={composer.blocked}
        aria-label="Attach files"
        title="Attach files: drop or paste them here, or pick them. Images go to the model as images; any file goes as its path."
        onclick={() => picker?.click()}
      >
        <IconPlus width="14" height="14" />
      </button>
    {/if}
    {@render strip?.()}
    <span class="grow"></span>
    {#if composer.closed === undefined}
      {#if nearLimit && maxChars !== undefined}
        <span
          class={["count", length > maxChars && "over"]}
          title={words.countTitle}
          >{length.toLocaleString("en-US")} / {maxChars.toLocaleString(
            "en-US",
          )}</span
        >
      {/if}
      {#if working && composer.sendNow?.offered === true}
        <!--
          D3's two ways to send while a turn runs (A6 U6). The arrow and Enter queue the
          message behind the work in flight, as a follow-up always is; this one sends it
          ahead of every queued message, when the harness lets it in
          (`sendNowButtonTitle`). No key of its own: D3 draws none, and Enter keeps its
          one meaning.
        -->
        <button
          class="send-now"
          type="button"
          disabled={!canSendNow}
          title={composer.sendNow.title}
          onclick={sendNow}>Send now</button
        >
      {/if}
      <button
        class="send"
        type="submit"
        disabled={!canSend}
        aria-label={words.sendLabel}
        title={working ? words.sendQueuedTitle : words.sendTitle}
      >
        <IconArrowUp width="14" height="14" />
      </button>
    {/if}
  </div>
</form>

<style>
  /* ── The composer: one box, the strip inside its border ──────────────────── */
  .box {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
    box-sizing: border-box;
    border: 1px solid var(--border-base);
    border-radius: 10px;
    background: var(--bg-layer-01);
  }
  textarea {
    width: 100%;
    min-height: 22px;
    max-height: 180px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text-base);
    font: 400 13px/20px var(--font-sans);
    field-sizing: content;
    resize: none;
  }
  /*
    D2's empty box is taller than D3's — room for a pasted URL before the first line.
  */
  textarea.first {
    min-height: 46px;
  }
  /*
    The strong border is the composer in use (the operator's decision): focused, as D2
    draws it, or holding words not yet sent, as D4 does. At rest and empty it is D3's base
    border, like every other box on the page. Any focus in the box, because the textarea has no
    focus style of its own (below) and the chip and the model picker are in the box too.
    Tracked from `focusin`/`focusout` rather than `:focus-within`, so the DOM suite (whose
    happy-dom has no `:focus-within`) checks the rule the browser applies.
  */
  .box.in-use {
    border-color: var(--border-strong);
  }
  textarea::placeholder {
    color: var(--text-faint);
  }
  /*
    No focus style while typing, as in OpenCode's composer: for a text field the caret is
    the indicator, and the box keeps its own border. `none` rather than no rule, because
    the global `:focus-visible` ring in tokens.css matches a textarea on click as well.
  */
  textarea:focus-visible {
    outline: none;
  }
  /*
    A closed box: its sentence in the textarea's place and type, muted, as the box at rest
    is — not the danger colour, since a planner taking no words is not a fault.
  */
  .closed-reason {
    margin: 0;
    min-height: 22px;
    color: var(--text-muted);
    font: 400 13px/20px var(--font-sans);
    text-wrap: pretty;
  }
  .strip {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .grow {
    flex: 1;
  }

  /* The message's length, once it nears the limit: a figure, so it never gives way. */
  .count {
    flex: none;
    font: 400 11px/16px var(--font-mono);
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .count.over {
    color: var(--state-fg-danger);
  }

  .icon-btn,
  .send {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: 6px;
    cursor: pointer;
  }
  .icon-btn {
    background: transparent;
    color: var(--icon-muted);
  }
  .icon-btn:hover:not(:disabled) {
    background: var(--overlay-hover);
    color: var(--text-base);
  }
  .icon-btn:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 1px;
  }
  .icon-btn:disabled {
    color: var(--text-faint);
    cursor: not-allowed;
  }
  /* A drag of files over the box: it says it will take them (A6 U13). */
  .box.dropping {
    border-style: dashed;
    border-color: var(--border-focus);
  }
  .send {
    background: var(--bg-inverse);
    color: var(--text-inverse);
  }
  .send:disabled {
    background: var(--bg-layer-02);
    color: var(--text-faint);
    cursor: default;
  }
  .send:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 1px;
  }
  /*
    "Send now" beside the arrow (A6 U6): a quiet bordered button, D3's chip height, so the
    arrow stays the composer's one primary action and the urgent send is the deliberate one.
  */
  .send-now {
    flex: none;
    height: 28px;
    padding: 0 10px;
    box-sizing: border-box;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: transparent;
    color: var(--text-base);
    font: 500 12px/26px var(--font-sans);
    white-space: nowrap;
    cursor: pointer;
  }
  .send-now:hover:not(:disabled) {
    background: var(--overlay-hover);
  }
  .send-now:disabled {
    border-color: var(--border-base);
    color: var(--text-faint);
    cursor: default;
  }
  .send-now:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 1px;
  }
</style>
