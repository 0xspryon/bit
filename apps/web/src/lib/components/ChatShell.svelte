<script lang="ts" generics="Subject extends ThreadTurn">
  /**
   * A conversation drawn as the page (A6 D2–D5), around one {@link ChatSession} adapter:
   * the thread, the operator's bubbles, the streaming cursor and turn footer, Stop, the
   * composer, the file drop and the F2 dialogs.
   *
   * **Extracted from `ImporterChat.svelte`**, where all of it was written against
   * `app.importer`, so the goal chat, the planner chat and the worker chats can mount the
   * same shell with an adapter of their own (A6 prep). Nothing here names the importer: the
   * words it says about the agent are the adapter's ({@link ChatWords}), and what only one
   * chat has comes in through a snippet.
   *
   * ## The regions a chat fills
   *
   * - `strip` — the composer's strip after the `+`: the importer's agent chip, model picker
   *   and caption. A model switch is a picker over the app's harnesses, so it stays the
   *   chat's (see the plan note for what the other roles need).
   * - `below` — under the composer: the importer's starters.
   * - `dock` — **A7-Q's question dock** (E3/E4), drawn **in the composer's slot** while the
   *   session has a `question`: the box — open, blocked or closed — is not drawn, and the
   *   dock is, in the same column at the same width, with Stop and the elapsed clock where
   *   they were and the sentences above the box kept. E3: "the composer's slot becomes the
   *   question dock — same width, same border, nothing above it moves; Esc gives the
   *   composer back". Esc in the dock asks the adapter to dismiss the question
   *   (`ChatQuestion.dismiss`); once the adapter takes `question` away — dismissed, or
   *   answered — the box is drawn again and, if focus went with the dock, gets it back.
   *   Empty until A7-Q.
   * - `controls` — beside Stop: **E7's "Stop all"** for a session's sub-agents. Drawn
   *   whether or not Stop is; the chat decides when its control applies. Empty until A7-S.
   * - `chip` — **E8's sub-agents chip**, which is not drawn in the chat at all: it is
   *   placed in the app's title bar beside the session chip (`titleBarChips.svelte.ts`) for
   *   as long as this shell is mounted. Empty until A7-S.
   * - `aside` — **E8's 400px panel** of sub-agents, beside the chat column and narrowing it
   *   rather than covering it. The thread's 800px column gives way first (`Chat`'s
   *   `--column`). Empty until A7-S.
   * - `subagent` — **A7-S's card** (E7) in place of a sub-agent's U14 entry, per row.
   *   Absent until A7-S, so the entry is drawn as before.
   * - `separator`, `tail`, `footer` — a turn's bubble, cursor and footer, the shell's own
   *   unless a chat needs a heading of its own (a planner round's status, say).
   *
   * ## What the shell never decides
   *
   * Whether Stop, Send now, files or a box exist at all: the adapter says, by leaving a
   * field out. Whether a turn runs: the server says, through the adapter's `turn`. A Stop
   * is drawn while the server says something runs — a turn, or background work with no
   * turn (A6 U6) — and keeps working above a closed composer, with its elapsed clock.
   */
  import { tick, type Snippet } from "svelte";

  import {
    durationLabel,
    lastProse,
    type ChatGroup,
    type ChatRow,
  } from "../chat";
  import {
    clockLabel,
    openComposer,
    replyText,
    stopOffered,
    turnFooterText,
    type ChatQuestion,
    type ChatSession,
    type ThreadTurn,
  } from "../chatShell";
  import { titleBarChips } from "../titleBarChips.svelte";
  import { setAttachmentLoader } from "../attachmentFiles";
  import { panelFileDrop } from "../composerFiles.svelte";
  import AttachmentChips from "./AttachmentChips.svelte";
  import Chat from "./Chat.svelte";
  import ChatComposer from "./ChatComposer.svelte";
  import CopyButton from "./CopyButton.svelte";
  import ErrorDialog from "./ErrorDialog.svelte";
  import MarkedText from "./MarkedText.svelte";
  import StreamCursor from "./StreamCursor.svelte";

  let {
    session,
    id,
    rootClass = "",
    footnote,
    separator,
    tail,
    footer,
    strip,
    below,
    dock,
    controls: chatControls,
    chip,
    aside,
    subagent,
  }: {
    session: ChatSession<Subject>;
    /** The prefix of the composer's ids: `importer` → `#importer-message`. */
    id: string;
    /** A class on the shell's root, the chat's handle on its page (`importer`). */
    rootClass?: string;
    /** The durability footnote, which only the chat can word: see {@link Chat}. */
    footnote: Snippet;
    separator?: Snippet<[ChatGroup<Subject>]> | undefined;
    tail?: Snippet<[ChatGroup<Subject>]> | undefined;
    footer?: Snippet<[ChatGroup<Subject>]> | undefined;
    strip?: Snippet | undefined;
    below?: Snippet | undefined;
    /** A7-Q's dock, drawn in the box's place while `session.question` is set. */
    dock?: Snippet<[ChatQuestion]> | undefined;
    /** Beside Stop: E7's "Stop all". */
    controls?: Snippet | undefined;
    /** E8's sub-agents chip, placed in the app's title bar. */
    chip?: Snippet | undefined;
    /** E8's 400px panel beside the chat column. */
    aside?: Snippet | undefined;
    subagent?: Snippet<[ChatRow]> | undefined;
  } = $props();

  // Attachment chips in this thread ask the chat's server for their files (A6 U13).
  // Once, at initialisation, as context must be: the adapter's loader is read when called.
  // V2(chat): a chat with no loader says so on the chip rather than hiding chips; the
  // upload route is per target, so every role can pass `app.loadUploadedFile` today.
  setAttachmentLoader((path) =>
    session.loadFile === undefined
      ? Promise.resolve({
          _tag: "none",
          detail: "This chat cannot fetch stored files.",
        })
      : session.loadFile(path),
  );

  let groups = $derived(session.groups);
  let source = $derived(session.composer);
  /** The box the operator writes in, when there is one: not closed, not absent. */
  let open = $derived(openComposer(session));
  /** The question holding the composer's slot (A7-Q), when there is a dock to draw it in. */
  let question = $derived(dock === undefined ? undefined : session.question);
  let turn = $derived(session.turn);
  let working = $derived(turn.working);

  /** The composer, for focus; the `+`, and the Stop pill, which dialogs return focus to. */
  let composerView = $state<ChatComposer | undefined>(undefined);
  let attachButton = $state<HTMLButtonElement | undefined>(undefined);
  let stopButton = $state<HTMLButtonElement | undefined>(undefined);

  /**
   * Puts focus in the composer, the caret at `caret` if given. For the chat's own controls:
   * a starter that filled the draft, a picker that opened a new session.
   */
  export function focusComposer(caret?: number): void {
    composerView?.focus(caret);
  }

  /** True while files are dragged over the shell, which says it will take them. */
  let dropping = $state(false);
  const fileDrop = panelFileDrop({
    accepting: () =>
      open?.files !== undefined && !open.blocked && question === undefined,
    take: (files) => open?.files?.add(files),
    dropping: (over) => (dropping = over),
  });

  /**
   * An elapsed clock beside Stop, for a chat whose adapter gives the work's start (the
   * planner's strip). Ticks only while there is one, so a chat without it holds no timer.
   */
  let now = $state(Date.now());
  $effect(() => {
    if (turn.since === undefined) return;
    now = Date.now();
    const timer = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => clearInterval(timer);
  });
  /**
   * The composer given back (A7-Q): a question that held its slot is dismissed or answered.
   * Focus that was in the dock went to `<body>` with it, so it goes to the box — where the
   * operator's reply in the chat, E3's "reply in chat instead", is written. Focus the
   * operator has put elsewhere meanwhile is left where it is.
   */
  let wasDocked = false;
  $effect(() => {
    const docked = question !== undefined;
    if (wasDocked && !docked) {
      void tick().then(() => {
        const at = document.activeElement;
        if (at === null || at === document.body) composerView?.focus();
      });
    }
    wasDocked = docked;
  });

  /** Esc in the dock gives the composer back, unless the dock's own control used it. */
  function ondockkeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    question?.dismiss();
  }

  // E8's chip goes in the app's title bar, for as long as this chat is on screen.
  const chips = titleBarChips();
  $effect(() => {
    if (chip === undefined || chips === undefined) return;
    return chips.place(chip);
  });

  let elapsed = $derived(
    turn.since === undefined
      ? ""
      : durationLabel(Math.max(0, now - turn.since)),
  );
</script>

{#snippet bubble(group: ChatGroup<Subject>)}
  {#if group.subject.message === null}
    <!--
      What came before the first message this page can see: a hairline and a few faint
      words, as D4 draws the seam between what scrolled away and what is here.
    -->
    <div class="earlier"><span>earlier in this session</span></div>
  {:else}
    <!--
      The operator's message is the heading of the stretch of work it asked for, set as
      D3 draws it: right-aligned in a bubble. It is the one part of a group that
      survives anything — it is in the harness's copy as a `user` entry and in this
      tab's feed as a minted row — so a group whose words and calls have both gone is
      still legible as "this is what you asked".

      It is marked as prose is (`MarkedText`): the operator's own words, but the empty
      chat asks them to paste the program's pages, so it is as often a page author's
      words, and a bidi control in a pasted host reorders it here as in a reply.
    -->
    <div class={["you", group.subject.queued && "queued"]}>
      <div class="bubble"><MarkedText text={group.subject.message} /></div>
      {#if group.subject.attachments !== undefined && group.subject.attachments.length > 0}
        <!--
          The files the message carried (A6 U13), right-aligned under it: live from the
          server's answer, after a reload from the harness's transcript.
        -->
        <AttachmentChips attachments={group.subject.attachments} align="end" />
      {/if}
      <!--
        D3's line under the bubble: who and when, and a copy of the words. A message
        still waiting behind the running turn says so here, until the harness takes it.
      -->
      <div class="said">
        {#if group.subject.queued}
          <span class="queued-mark"
            >{group.subject.sentNow ? "sending now" : "queued"}</span
          >
        {:else if group.subject.sentNow}
          <!--
            Taken (A6 U6): the harness read it ahead of any queued message, which is why
            the turn before ends where this one begins. What it cut of that turn is the
            harness's (`sentNowTitle`).
          -->
          <span class="queued-mark" title={session.sentNowTitle}>sent now</span>
        {/if}
        <span class="when"
          >You{group.subject.at === null
            ? ""
            : ` · ${clockLabel(group.subject.at)}`}</span
        >
        <CopyButton text={group.subject.message} label="Copy your message" />
      </div>
    </div>
  {/if}
{/snippet}

{#snippet cursor(group: ChatGroup<Subject>)}
  <!--
    D3's streaming cursor: the agent is still on this message. Drawn while the turn is
    in flight — from the server accepting it until the server says it is no longer
    running — and not while a pending write already draws its own, so a turn never
    blinks twice.

    The status line is the cursor's counterpart in words, for a reader who cannot see
    either cursor, so it follows the turn and not the cursor: it is said whichever of the
    two is drawn.
  -->
  {#if group.subject.working}
    <span class="visually-hidden" role="status">{session.words.working}</span>
    {#if group.subject.midBlock}
      <!--
        Reloaded part way through a block (A6 U5): the harness is writing, and its words
        so far are not sent again, so the turn says so rather than "no reply".
      -->
      <div class="streaming"><StreamCursor label="writing…" /></div>
    {:else if !group.rows.some((row) => row.write === "pending" || row.stream === "writing" || row.stream === "shortened")}
      <!-- A reply being written draws its own mark (`ChatItem`), so not a second here. -->
      <div class="streaming"><StreamCursor /></div>
    {/if}
  {/if}
{/snippet}

{#snippet closing(group: ChatGroup<Subject>)}
  <!--
    Under the finished reply, as D4 draws it: a copy of the turn's words, then the agent,
    the model or models that answered and how long the turn took (`turnFooterText`). Not
    while the turn is in flight, as OpenCode's is not — the cursor is what is under a reply
    still being written, and a caption that appeared mid-stream would then move down with
    every row that landed above it.
  -->
  {@const words = replyText(group)}
  {#if !group.subject.working && !group.subject.queued && (group.subject.number !== null || lastProse(group) !== null)}
    <!--
      Also under a turn with no reply text (A6 U4 review): one that ended in the
      harness's error, or was stopped before it answered, still ran on a model and took
      time. Its Copy is left out, as there are no words to copy. Not on a message still
      queued, nor on the leading group unless it holds replayed words of its own.
    -->
    <div class="foot">
      {#if words !== ""}
        <CopyButton text={words} label={session.words.copyReply} />
      {/if}
      <p class="foot-text">{turnFooterText(group, session.footer)}</p>
    </div>
  {/if}
{/snippet}

<!--
  A drag of files anywhere over the panel is the panel's (U13 review 1): dropped on the box
  or beside it, the files go into the tray, and never into a `file://` tab.
-->
<div
  class={["chat-shell", rootClass]}
  ondragover={fileDrop.ondragover}
  ondragleave={fileDrop.ondragleave}
  ondrop={fileDrop.ondrop}
  role="presentation"
>
  <!-- The chat's column, which E8's panel (`aside`) narrows rather than covers. -->
  <div class="column">
    <Chat
      label={session.label}
      {groups}
      readonly={source === undefined &&
        question === undefined &&
        below === undefined}
      layout="thread"
      note={session.note}
      detail={session.connection}
      empty={session.empty}
      separator={separator ?? bubble}
      tail={tail ?? cursor}
      footer={footer ?? closing}
      {footnote}
      {subagent}
    >
      {#snippet controls()}
        {#if stopOffered(session)}
          <!--
          Stop interrupts the agent's turn and keeps the conversation (A6 F5). The cursor
          clears on the server's answer, not on the press. While the answer is coming the pill
          is aria-disabled rather than disabled, so focus stays on it.

          Drawn whenever the server says something runs (A6 U6): a turn, including one the
          harness opened itself on a background task's notification, or — with no turn —
          background work the agent started, which the pill then names, since nothing else on
          screen says it is running. Above the composer whatever its state, a closed one too.
        -->
          <button
            bind:this={stopButton}
            class="stop"
            type="button"
            aria-disabled={turn.stopping}
            title={working
              ? session.words.stopTurn
              : session.words.stopBackground}
            onclick={() => {
              if (!turn.stopping) session.stop?.();
            }}
          >
            <span class="stop-mark" aria-hidden="true"></span>
            <span
              >{turn.stopping
                ? "Stopping…"
                : working
                  ? "Stop"
                  : "Stop background work"}</span
            >
          </button>
          {#if elapsed !== ""}
            <!-- How long it has run: a fact about the request, not a deadline. -->
            <span class="elapsed" role="timer"
              >{#if session.words.elapsedLead !== undefined}{session.words
                  .elapsedLead}
                <strong>{elapsed}</strong>{:else}{elapsed}{/if}</span
            >
          {/if}
        {/if}
        <!-- The chat's own controls beside Stop: E7's "Stop all" (A7-S). -->
        {@render chatControls?.()}
      {/snippet}

      {#snippet composer()}
        <div class="stack">
          {#each open?.notices ?? [] as notice (notice.key)}
            <!--
            The sentences above the box, in the chat's order: a refusal, the note on a
            message the server accepted, a wait. Their words are the server's or the chat's,
            never the shell's. Kept while a question holds the box's slot: they are about
            the last message, which a question does not unsay.
          -->
            <p
              class={["notice", notice.kind]}
              role={notice.tone === "alert" ? "alert" : "status"}
            >
              {notice.text}
            </p>
          {/each}
          {#if question !== undefined && dock !== undefined}
            <!--
            A7-Q's question dock (E3/E4), in the box's slot: the box is not drawn while the
            agent waits on a question, open or closed alike — a planner or a worker can ask
            one too. Esc gives the composer back (`ondockkeydown`).
          -->
            <div class="dock" role="presentation" onkeydown={ondockkeydown}>
              {@render dock(question)}
            </div>
          {:else if session.composer !== undefined}
            <ChatComposer
              bind:this={composerView}
              bind:attachButton
              composer={session.composer}
              words={session.words}
              {working}
              first={groups.length === 0}
              {dropping}
              {id}
              {strip}
            />
          {/if}
          {@render below?.()}
        </div>
      {/snippet}
    </Chat>
  </div>
  {#if aside !== undefined}
    <!--
      E8's panel (A7-S): 400px beside the chat, which reflows to the width left. Its
      heading, close and contents are the chat's.
    -->
    <aside class="aside">{@render aside()}</aside>
  {/if}
</div>

{#if open?.files?.refusal !== undefined}
  <!-- A file the composer would not take, or a message refused for its files (A6 U13). -->
  <ErrorDialog
    {...open.files.refusal}
    opener={attachButton ?? composerView?.input() ?? null}
    ondismiss={() => open?.files?.dismiss()}
  />
{/if}

{#if session.stopFailure !== undefined}
  <ErrorDialog
    {...session.stopFailure}
    opener={stopButton ?? null}
    ondismiss={() => session.dismissStopFailure?.()}
  />
{/if}

<style>
  /*
    A row: the chat's column, and E8's panel beside it when there is one. The column is the
    flex column the chat was always drawn in, so without a panel nothing moves.
  */
  .chat-shell {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .column {
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
  }
  /*
    E8: 400px, the height of the page under the title bar, scrolling on its own, a hairline
    between it and the chat. What is inside — the heading, the groups — is A7-S's.
  */
  .aside {
    flex: 0 0 400px;
    min-height: 0;
    overflow-y: auto;
    box-sizing: border-box;
    border-left: 1px solid var(--border-muted);
  }

  .streaming {
    padding: 4px 0 0;
  }

  /*
    ── The separator: the operator's bubble ─────────────────────────────────────
    Across the whole row, so the bubble can be pushed to its right end. The space under it
    is the gap the agent's header used to fill: with the header gone the reply would
    otherwise sit 12px under the question, closer than turns sit to each other, and the
    question would read as the caption of the answer.
  */
  .you {
    display: flex;
    flex: 1 1 100%;
    min-width: 0;
    flex-direction: column;
    align-items: flex-end;
    gap: 7px;
    padding-bottom: 8px;
  }
  /* D3's "You · 18:02" and its copy glyph, right-aligned under the bubble. */
  .said {
    display: flex;
    align-items: center;
    gap: 9px;
    color: var(--text-muted);
    font: 400 11px/16px var(--font-mono);
  }
  /*
    A message still waiting behind the running turn: its bubble dashed and its words
    muted, so it reads as sent and not yet read, and a word beside the time that says so.
  */
  .queued .bubble {
    border: 1px dashed var(--border-strong);
    background: transparent;
    color: var(--text-muted);
  }
  .queued-mark {
    padding: 0 6px;
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-sm);
    font: 500 10px/16px var(--font-sans);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .bubble {
    max-width: 560px;
    padding: 11px 14px;
    box-sizing: border-box;
    border-radius: 10px;
    background: var(--bg-layer-02);
    color: var(--text-base);
    font: 400 13px/20px var(--font-sans);
    text-wrap: pretty;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  /*
    The turn's footer. Muted and not faint: faint is below AA at 11px, and this is now the
    only place on the turn the model is said, not decoration beside a label that said it.
  */
  .foot {
    display: flex;
    align-items: center;
    gap: 9px;
    margin: 14px 0 0;
  }
  .foot-text {
    margin: 0;
    font: 400 11px/16px var(--font-mono);
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }
  .earlier {
    display: flex;
    flex: 1 1 100%;
    align-items: center;
    gap: 12px;
    color: var(--text-muted);
    font: 400 11px/16px var(--font-sans);
  }
  .earlier::before,
  .earlier::after {
    flex: 1;
    height: 1px;
    background: var(--border-muted);
    content: "";
  }

  /* ── Stop: a pill above the composer, centred ─────────────────────────────── */
  .stop {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 28px;
    padding: 0 12px;
    box-sizing: border-box;
    border: 1px solid var(--border-strong);
    border-radius: 14px;
    background: var(--bg-layer-01);
    color: var(--text-base);
    font: 500 12px/26px var(--font-sans);
    cursor: pointer;
  }
  .stop:hover {
    background: var(--overlay-pressed);
  }
  .stop[aria-disabled="true"] {
    color: var(--text-muted);
    cursor: progress;
  }
  .stop:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 1px;
  }
  .stop-mark {
    width: 8px;
    height: 8px;
    border: 1.5px solid currentColor;
    border-radius: 2px;
  }
  .elapsed {
    font: 400 11px/16px var(--font-mono);
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
  }

  /* ── The composer's column: the sentences, the box or the dock, what hangs under it ── */
  .stack {
    display: flex;
    flex: 1 1 100%;
    min-width: 0;
    flex-direction: column;
    gap: 10px;
  }
  .dock {
    display: flex;
    flex-direction: column;
  }
  /* ── The sentences about the last message ──────────────────────────────────── */
  .notice {
    margin: 0;
    color: var(--text-muted);
    font: 400 12px/18px var(--font-sans);
    text-wrap: pretty;
    overflow-wrap: anywhere;
  }
  .notice.refusal {
    color: var(--state-fg-danger);
  }
</style>
