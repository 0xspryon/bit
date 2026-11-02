<script lang="ts">
  /**
   * The scope importer's conversation (A6 D2–D5): an ordinary chat, pointed at one job.
   *
   * **Driven by mock data.** Every field it reads is on `app.importer`
   * (`importerSessions.svelte.ts`), which holds declared sessions; nothing here reaches a
   * server. See that file for the one fake in the interface (the stand-in reply to a sent
   * message) and `mockImporter.ts` for the content.
   *
   * ## It is {@link Chat}, with its own subject and its own separator
   *
   * `Chat` takes the group's subject as a type parameter it never looks inside, because
   * hard-coding the planner's round into it was the mistake it was built to undo. This is
   * the third caller and changes nothing there: {@link ImporterTurn} is the importer's own
   * subject, one group per operator message, and the `separator` snippet below renders it —
   * the operator's words as the heading of the stretch of work they asked for, or "Earlier
   * in this session" for what came before the first message this page can see.
   *
   * The five prose states are `Chat`'s and are all reachable from here: `live` (a turn the
   * importer is narrating), `pending` (sent, not answered), `replayed` (the harness's copy),
   * `forgotten` (it no longer has it, said as a note and not an alert), `loading` (opening
   * an older session) and `none` (a turn that said nothing).
   *
   * ## The composer is enabled, unlike the planner's
   *
   * Corrections are messages, not forms (D4). The box stays enabled while the importer is
   * working, because stopping it is a control and correcting it is a message, and an older
   * session opened from the picker is writeable too: its first new message resumes it.
   *
   * ## Not wired, and said
   *
   * The model and harness chips are display only. A session's model is fixed once it has
   * started — "changing harness starts a new session and never moves this one" — and a
   * new session's choice belongs to the same harness picker the other composers use,
   * which needs the server's catalogue this page does not have. Attach is inert for the
   * reason `ComposeBox`'s `+` is: nothing behind it, so it is `aria-disabled` and says why.
   */
  import { tick } from "svelte";

  import type { App } from "../app.svelte";
  import { IconArrowUp, IconPaperclip, IconPlus } from "../icons";
  import { STARTERS, type StarterKey } from "../importerSessions.svelte";
  import Button from "./Button.svelte";
  import Chat from "./Chat.svelte";

  let { app }: { app: App } = $props();

  let importer = $derived(app.importer);
  let session = $derived(importer.current);
  let groups = $derived(importer.groups);
  let target = $derived(app.selected?.name ?? app.viewTargetId);
  let canSend = $derived(importer.draft.trim() !== "");
  let working = $derived(session?.working ?? false);
  let turns = $derived(
    groups.filter((group) => group.subject.message !== null).length,
  );

  let box = $state<HTMLTextAreaElement | undefined>(undefined);

  function submit(event: Event): void {
    event.preventDefault();
    if (canSend) importer.send();
  }

  /**
   * Enter sends; Shift+Enter is a newline. {@link GoalAgentChat}'s convention, for its
   * reason: the importer is told things in sentences, often several.
   */
  function onkeydown(event: KeyboardEvent): void {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    if (canSend) importer.send();
  }

  /**
   * Fills the composer with a pre-written first message and puts the cursor after it.
   *
   * Focus, because the draft ends where the operator's own words go (a URL, a pasted
   * statement), and a click that leaves the caret on the button asks them to find the box.
   * After a `tick`: the textarea's value follows the state, not the other way round.
   */
  async function choose(key: StarterKey): Promise<void> {
    importer.useStarter(key);
    await tick();
    if (box === undefined) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }

  let placeholder = $derived(
    groups.length === 0
      ? "Paste a policy or scope URL, or say what is in and out of scope…"
      : "Correct it, or add what the pages do not say…",
  );

  function clock(at: number): string {
    return new Date(at).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
</script>

<div class="importer">
  <Chat
    label={`Load the scope for ${target}`}
    {groups}
    readonly={false}
    maxHeight="max(320px, calc(100vh - 420px))"
    count={turns === 0
      ? ""
      : `${String(turns)} ${turns === 1 ? "message" : "messages"} from you`}
    note={session?.reading
      ? "You are reading an earlier session. Your first message resumes it, with the scope as it stands now, not as it stood then."
      : ""}
    empty="Paste the program's pages, or describe the engagement in your own words. The importer reads, narrates what it is doing, and writes scope entries and assets onto this target. You can correct it in the same thread."
  >
    {#snippet separator(group)}
      <!--
        The operator's message is the heading of the stretch of work it asked for. It is the
        one part of a group that survives anything — it is in the harness's copy as a `user`
        entry, and in this tab's feed as a minted row — so a group whose words and calls
        have both gone is still legible as "this is what you asked".
      -->
      {#if group.subject.message === null}
        <span class="sep-title">Earlier in this session</span>
      {:else}
        <span class="sep-who">You</span>
        <span class="sep-said">{group.subject.message}</span>
        {#if group.subject.at !== null}
          <span class="sep-when">{clock(group.subject.at)}</span>
        {/if}
        {#if group.subject.working}
          <span class="chip" data-tint="warning">working</span>
        {/if}
      {/if}
    {/snippet}

    {#snippet footnote()}
      Rows marked <strong>record</strong> are committed events, in the order the
      store assigned them, and stay on the Assets page whatever happens to this
      thread. Rows marked <strong>activity</strong> — including your own messages
      — are the importer narrating its own calls: not stored, and gone on a reload.
      What it said comes back from the harness for as long as the harness keeps it.
    {/snippet}

    {#snippet controls()}
      {#if working}
        <span class="pulse" aria-hidden="true"></span>
        <span class="status" role="status">The importer is working…</span>
        <Button size="sm" variant="outline" onclick={() => importer.stop()}>
          Stop
        </Button>
      {/if}
    {/snippet}

    {#snippet composer()}
      <div class="stack">
        <form class="box" onsubmit={submit}>
          <label class="visually-hidden" for="importer-message"
            >Message the importer</label
          >
          <textarea
            bind:this={box}
            id="importer-message"
            rows="3"
            {placeholder}
            bind:value={importer.draft}
            {onkeydown}></textarea>
          <div class="strip">
            <button
              class="square attach"
              type="button"
              aria-disabled="true"
              aria-label="Attach files the importer can read"
              title="Attaching files is not wired to anything yet."
            >
              <IconPaperclip width="14" height="14" />
            </button>
            <span class="chip-ui" title="The agent this chat talks to.">
              Importer
            </span>
            <span
              class="chip-ui mono"
              title="The model this session runs on. Changing it starts a new session; it never moves this one."
            >
              {session?.model ?? ""}
            </span>
            {#if working}
              <span class="hint">pinned while the session is running</span>
            {:else}
              <span class="hint">Enter sends, Shift+Enter for a new line.</span>
            {/if}
            <button
              class="square submit"
              type="submit"
              disabled={!canSend}
              aria-label="Send to the importer"
              title="Send to the importer"
            >
              <IconArrowUp width="14" height="14" />
            </button>
          </div>
        </form>

        {#if groups.length === 0}
          <!--
          Two suggestions that are really just pre-written first messages (D2). They go
          away with the first message: after that the thread is the prompt.
        -->
          <ul class="starters" aria-label="Ways to start">
            {#each Object.entries(STARTERS) as [key, starter] (key)}
              <li>
                <button
                  class="starter"
                  type="button"
                  onclick={() => void choose(key as StarterKey)}
                >
                  <IconPlus width="12" height="12" />
                  <span>{starter.label}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/snippet}
  </Chat>
</div>

<style>
  .importer {
    display: flex;
    flex-direction: column;
  }
  /*
   * The separator's own type. Its layout — the rule above it — belongs to {@link Chat}. The
   * operator's words are the most prominent text in a group because they are what the group
   * is for; the agent's rows beneath are the work done about them.
   */
  .sep-title {
    font: 600 12px/var(--lh-compact) var(--font-sans);
    color: var(--text-base);
  }
  .sep-who {
    flex: none;
    font: 600 11px/var(--lh-compact) var(--font-sans);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .sep-said {
    flex: 1 1 24ch;
    min-width: 0;
    font: 500 13px/var(--lh-base) var(--font-sans);
    color: var(--text-base);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .sep-when {
    flex: none;
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

  /* The box and the starters under it as one column, inside `Chat`'s wrapping row. */
  .stack {
    display: flex;
    flex: 1 1 100%;
    min-width: 0;
    flex-direction: column;
    gap: 8px;
  }
  /* One container with the strip inside its border: `GoalAgentChat`'s arrangement. */
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
    font: 400 16px/24px var(--font-sans);
    resize: vertical;
  }
  textarea:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: -2px;
  }
  .strip {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    padding: 0 8px 0 8px;
  }
  .hint {
    flex: 1;
    min-width: 0;
    font-size: 11px;
    line-height: var(--lh-compact);
    color: var(--text-muted);
  }
  /* Read-only facts about the session, in the shape of the product's other chips. */
  .chip-ui {
    flex: none;
    max-width: 24ch;
    overflow: hidden;
    padding: 3px 8px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font: 500 11px/var(--lh-compact) var(--font-sans);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .square {
    display: inline-flex;
    flex: none;
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
  .attach {
    background: transparent;
    color: var(--text-muted);
    opacity: 0.55;
    cursor: not-allowed;
  }
  .attach:focus-visible,
  .submit:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 1px;
  }

  .starters {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .starter {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-muted);
    font: 400 12px/var(--lh-compact) var(--font-sans);
    cursor: pointer;
  }
  .starter:hover {
    background: var(--overlay-hover);
    color: var(--text-base);
  }
  .starter:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 1px;
  }

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
