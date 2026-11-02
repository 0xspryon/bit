<script lang="ts">
  /**
   * The scope importer's conversation (A6 D2–D5): an ordinary chat, pointed at one job.
   *
   * **Driven by mock data.** Every field it reads is on `app.importer`
   * (`importerSessions.svelte.ts`), which holds declared sessions; nothing here reaches a
   * server. See that file for the one fake in the interface (the stand-in reply to a sent
   * message) and `mockImporter.ts` for the content, whose narration is invented.
   *
   * ## It is {@link Chat}, laid out as a page
   *
   * `Chat` takes the group's subject as a type parameter it never looks inside, so this is
   * the third caller and the importer's own subject ({@link ImporterTurn}) and separator are
   * written here. `layout="thread"` is the one thing `Chat` was taught for it: A6 draws the
   * chat as the whole page — an 800px column, no frame, the composer pinned under the log —
   * where the planner's and the goal agent's are panels among other things. Rows go through
   * {@link ChatItem} too, `narrated`: prose as prose and a call as a mono block, with the
   * same record/activity distinction and write states as the ledger reading.
   *
   * One group per operator message. The separator is the operator's bubble and, under it,
   * the importer's header (the harness's letter, "Importer", the model); what the importer
   * said and called follows as rows. The five prose states are `Chat`'s and are all
   * reachable from here: `live`, `pending`, `replayed`, `forgotten`, `loading` and `none`.
   *
   * ## The composer is enabled, unlike the planner's
   *
   * Corrections are messages, not forms (D4). The box stays enabled while the importer is
   * working, because stopping it is a control and correcting it is a message, and an older
   * session opened from the picker is writeable too: its first new message resumes it.
   *
   * ## Not wired, and said
   *
   * Attach is inert for the reason `ComposeBox`'s `+` is: nothing behind it, so it is
   * `aria-disabled` and says why. The "Importer" chip is a label and not the agent selector
   * D7 draws: there is no second agent to select. The model chip is the real picker
   * ({@link ImporterModelPicker}) over whatever harnesses the app holds — the server's when
   * connected, `mockHarnesses` in the state picker.
   */
  import { tick } from "svelte";

  import type { App } from "../app.svelte";
  import {
    IconArrowUp,
    IconDownload,
    IconFile,
    IconLink,
    IconPlus,
  } from "../icons";
  import { STARTERS, type StarterKey } from "../importerSessions.svelte";
  import Chat from "./Chat.svelte";
  import ImporterModelPicker from "./ImporterModelPicker.svelte";

  let { app }: { app: App } = $props();

  let importer = $derived(app.importer);
  let session = $derived(importer.current);
  let groups = $derived(importer.groups);
  let target = $derived(app.selected?.name ?? app.viewTargetId);
  let canSend = $derived(importer.draft.trim() !== "");
  let working = $derived(session?.working ?? false);
  /** A session that has started keeps its model; only an empty one may choose. */
  let pinned = $derived(
    session === undefined || session.tally.messages === 0
      ? null
      : { harness: session.harness, model: session.model },
  );
  /** The importer's header in a group names the session's own harness and model. */
  let letter = $derived((session?.harness.slice(0, 1) || "?").toLowerCase());

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
</script>

<div class="importer">
  <Chat
    label={`Load the scope for ${target}`}
    {groups}
    readonly={false}
    layout="thread"
    note={session?.reading
      ? "You are reading an earlier session. Your first message resumes it, with the scope as it stands now, not as it stood then."
      : ""}
    empty="Paste the program's pages, or describe the engagement in your own words. The importer reads, narrates what it is doing, and writes scope entries and assets onto this target. You can correct it in the same thread."
  >
    {#snippet separator(group)}
      {#if group.subject.message === null}
        <!--
          What came before the first message this page can see: a hairline and a few faint
          words, as D4 draws the seam between what scrolled away and what is here.
        -->
        <div class="earlier"><span>earlier in this session</span></div>
      {:else}
        <!--
          The operator's message is the heading of the stretch of work it asked for, set as
          D3 draws it: right-aligned in a bubble, with the importer's header beneath. It is
          the one part of a group that survives anything — it is in the harness's copy as a
          `user` entry and in this tab's feed as a minted row — so a group whose words and
          calls have both gone is still legible as "this is what you asked".
        -->
        <div class="turn">
          <div class="you">
            <div class="bubble">{group.subject.message}</div>
          </div>
          <div class="agent">
            <span class="avatar" aria-hidden="true">{letter}</span>
            <span class="who">Importer</span>
            <span class="model">{session?.model ?? ""}</span>
            {#if group.subject.working}
              <span class="visually-hidden" role="status"
                >The importer is working.</span
              >
            {/if}
          </div>
        </div>
      {/if}
    {/snippet}

    {#snippet footnote()}
      A call marked <strong>recorded</strong> is a committed event and stays on the
      Assets page. A dashed call, the importer's words and your messages are narration:
      not stored, and gone on a reload unless the harness still has them.
    {/snippet}

    {#snippet controls()}
      {#if working}
        <button class="stop" type="button" onclick={() => importer.stop()}>
          <span class="stop-mark" aria-hidden="true"></span>
          <span>Stop</span>
        </button>
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
            rows="1"
            class={[groups.length === 0 && "first"]}
            {placeholder}
            bind:value={importer.draft}
            {onkeydown}></textarea>
          <div class="strip">
            <button
              class="icon-btn"
              type="button"
              aria-disabled="true"
              aria-label="Attach"
              title="Attaching files is not wired to anything yet."
            >
              <IconPlus width="14" height="14" />
            </button>
            <span class="agent-chip" title="The agent this chat talks to.">
              <IconDownload width="12" height="12" aria-hidden="true" />
              Importer
            </span>
            <ImporterModelPicker {app} {pinned} dimmed={working} />
            {#if working}
              <span class="hint">pinned while the session is running</span>
            {/if}
            <span class="grow"></span>
            <button
              class="send"
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
            <li>
              <button
                class="starter"
                type="button"
                onclick={() => void choose("program")}
              >
                <IconLink width="12" height="12" aria-hidden="true" />
                <span>{STARTERS.program.label}</span>
              </button>
            </li>
            <li>
              <button
                class="starter"
                type="button"
                onclick={() => void choose("sow")}
              >
                <IconFile width="12" height="12" aria-hidden="true" />
                <span>{STARTERS.sow.label}</span>
              </button>
            </li>
          </ul>
        {/if}
      </div>
    {/snippet}
  </Chat>
</div>

<style>
  .importer {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
    padding: 0 32px;
  }

  /* ── The separator: the operator's bubble, then the importer's header ──────── */
  .turn {
    display: flex;
    flex: 1 1 100%;
    min-width: 0;
    flex-direction: column;
    gap: 26px;
  }
  .you {
    display: flex;
    justify-content: flex-end;
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
  .agent {
    display: flex;
    align-items: center;
    gap: 9px;
  }
  .avatar {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 5px;
    background: var(--bg-layer-03);
    color: var(--text-base);
    font: 500 10px/18px var(--font-mono);
  }
  .who {
    font: 500 12px/16px var(--font-sans);
    color: var(--text-muted);
  }
  .model {
    font: 400 11px/16px var(--font-mono);
    /* Faint is below AA at this size; this is decoration beside "Importer", which says it. */
    color: var(--text-muted);
    opacity: 0.8;
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

  /* ── The composer: one box, the strip inside its border ──────────────────── */
  .stack {
    display: flex;
    flex: 1 1 100%;
    min-width: 0;
    flex-direction: column;
    gap: 10px;
  }
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
  /* D2's empty box is taller than D3's: room for a pasted URL before the first line. */
  textarea.first {
    min-height: 46px;
  }
  textarea::placeholder {
    color: var(--text-faint);
  }
  textarea:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 4px;
    border-radius: 2px;
  }
  .strip {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .grow {
    flex: 1;
  }
  .hint {
    font: 400 11px/16px var(--font-sans);
    color: var(--text-muted);
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
    cursor: not-allowed;
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
  .agent-chip {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 7px;
    height: 28px;
    padding: 0 9px;
    box-sizing: border-box;
    border: 1px solid var(--border-base);
    border-radius: 6px;
    color: var(--text-base);
    font: 500 12px/16px var(--font-sans);
  }
  .agent-chip :global(svg) {
    color: var(--icon-muted);
  }

  /* ── The two starters: dashed pills under the box ─────────────────────────── */
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
    height: 28px;
    padding: 0 12px;
    box-sizing: border-box;
    border: 1px dashed var(--border-strong);
    border-radius: 14px;
    background: transparent;
    color: var(--text-muted);
    font: 400 12px/16px var(--font-sans);
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
