<script lang="ts">
  /**
   * The scope importer's conversation (A6 D2–D5): an ordinary chat, pointed at one job.
   *
   * Every field it reads is on `app.importer` (`importerSessions.svelte.ts`). On a real
   * target that is the server's: the session list (S1), the composer (S3) and — since S4 —
   * the importer's own replies and thinking, live, from the target's narration feed. In the
   * state picker it is declared: see that file for the one fake in the interface (the
   * stand-in reply to a sent message) and `mockImporter.ts` for the content, whose narration
   * is invented. Tool rows are still declared-only (S5).
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
   * One group per operator message. The separator is the operator's bubble and nothing
   * else; what the importer said and called follows as rows, with **no label over it** —
   * OpenCode's reading (S3), where the bubble being on the right is what says who spoke.
   * The model the reply ran on is a quiet footer under the finished reply instead, and the
   * harness is the glyph on the composer's model chip, which a session never changes. The
   * five prose states are `Chat`'s and are all reachable from here: `live`, `pending`,
   * `replayed`, `forgotten`, `loading` and `none`.
   *
   * ## The composer is enabled, unlike the planner's
   *
   * Corrections are messages, not forms (D4). The box stays enabled while the importer is
   * working, because stopping it is a control and correcting it is a message, and an older
   * session opened from the picker is writeable too: its first new message resumes it.
   *
   * **It posts, on a real target** (the importer conversation design, S3): the empty
   * session's first message opens a conversation, and a listed session's goes to its import
   * as a queued message. The draft clears when the server accepts, not on submit, so a
   * refusal leaves the words in the box beside the server's sentence.
   *
   * **Every state that disables it is the server's**, never a guess from here: no harness
   * (the server answered `no_harness` to which model an import would run on), a stranded
   * session (its harness is not one the server lists), a session the operator ended
   * (`endedReason` on the server's row, or an `import_ended` refusal on its replay), and a
   * session the replay refuses for any other reason, worded in the server's sentence. A
   * session the *server* let go of is not disabled — a message to it either takes the
   * conversation back over or opens a fresh one, and `ImporterHistory.continuation` is which
   * of the two, so the note above the thread says what the next message will do rather than
   * promising a resume the driver may not give (S6).
   *
   * ## Not wired, and said
   *
   * Attach is inert for the reason `ComposeBox`'s `+` is: nothing behind it, so it is
   * `aria-disabled` and says why. The agent chip is D7's selector ({@link AgentChip}) over
   * the server's registry, pinned once the first message is sent; the model chip is the
   * real picker ({@link ImporterModelPicker}) over whatever harnesses the app holds — the
   * server's when connected, `mockHarnesses` in the state picker. Once the session has
   * started its harness is pinned and its model is not (D6): the chip switches the model of
   * the running session (A6 F4), and another harness is a new session.
   */
  import { tick } from "svelte";

  import type { App } from "../app.svelte";
  import { IconArrowUp, IconFile, IconLink, IconPlus } from "../icons";
  import {
    durationLabel,
    turnEndedAt,
    turnModels,
    type ChatGroup,
  } from "../chat";
  import type { ImporterTurn } from "../importerChat";
  import CopyButton from "./CopyButton.svelte";
  import { ENDED_NOTE, strandedNote } from "../importerChat";
  import { STARTERS, type StarterKey } from "../importerSessions.svelte";
  import AgentChip from "./AgentChip.svelte";
  import Chat from "./Chat.svelte";
  import ErrorDialog from "./ErrorDialog.svelte";
  import ImporterModelPicker from "./ImporterModelPicker.svelte";
  import MarkedText from "./MarkedText.svelte";
  import StreamCursor from "./StreamCursor.svelte";

  let { app }: { app: App } = $props();

  let importer = $derived(app.importer);
  let session = $derived(importer.current);
  let groups = $derived(importer.groups);
  let target = $derived(app.selected?.name ?? app.viewTargetId);
  /** Set when the session's harness is one this server does not run: see `strandedNote`. */
  let stranded = $derived(session?.strandedOn);
  /** The replay's refusal, when it answered `refused`: which one, and the server's sentence. */
  let refusal = $derived(
    session?.history.standing?.continuation === "refused"
      ? session.history.standing.refusal
      : undefined,
  );
  /**
   * The operator ended it: the server refuses a message to it.
   *
   * From the index row's `endedReason`, and from the replay's `import_ended` refusal once
   * that has answered — the same fact from two reads, and either is enough. The second
   * matters because a row read before the operator ended the session in another tab says
   * nothing about it, and a composer offered on that row is a message that will be refused.
   *
   * **Not every `refused`.** A session whose recorded agent this server does not define is
   * refused too, and nobody ended it; saying "ended" over it would tell the operator they
   * did something they did not. That one is {@link refusedBecause}.
   */
  let ended = $derived(
    session?.ended === true || refusal?.reason === "import_ended",
  );
  /**
   * The server's sentence for a refusal that is not the operator's end, shown as it stands:
   * the reason is the server's to give, so this page words nothing of its own over it.
   */
  let refusedBecause = $derived(
    !ended && refusal !== undefined ? refusal.detail : undefined,
  );
  /**
   * Which model an import would run on could not be had, so there is nothing to talk to. Only
   * an answer counts: an import model not asked for yet is not this. Two different
   * conditions, said differently: the server answering that no harness is ready
   * (`noHarness`), and the lookup failing some other way — no server answered, say — which
   * is not a claim about harnesses at all.
   */
  let noModel = $derived(
    app.importerModel === undefined && app.importModelDetail !== "",
  );
  let noHarness = $derived(noModel && app.importModelNoHarness);
  let blocked = $derived(
    stranded !== undefined || ended || refusedBecause !== undefined || noModel,
  );
  let canSend = $derived(
    importer.draft.trim() !== "" && !blocked && !importer.sending,
  );
  let working = $derived(session?.working ?? false);
  /**
   * A started session's harness and model: the harness is pinned to it, the model is not
   * (D6). `null` for the empty session, whose harness and model are still open.
   */
  let pinned = $derived(
    session === undefined || session.tally.messages === 0
      ? null
      : {
          sessionId: session.id,
          harness: session.harness,
          instanceId: session.harnessInstanceId,
          model: session.model,
          modelOptions: session.modelOptions,
        },
  );
  /** The model switch in flight for the session on screen, if any (A6 F4). */
  let switchingHere = $derived(importer.switchingOf(session?.id));
  /** What the server said about this session's last accepted switch. */
  let switchNote = $derived(
    importer.switchNotice !== undefined &&
      importer.switchNotice.sessionId === session?.id
      ? importer.switchNotice.text
      : "",
  );
  /**
   * The agent this session runs as, by its registry label: the first word of a turn's
   * footer (D4's "Importer · …"). The registry's default before a session has one, and
   * "Importer" where no registry has been read (the page is the importer's either way).
   */
  let agentLabel = $derived.by(() => {
    const id = session?.agentId ?? importer.agents?.defaultAgentId;
    return (
      importer.agents?.agents.find((agent) => agent.id === id)?.label ??
      "Importer"
    );
  });

  /** "18:02": when the operator's message was sent, as D3 sets it under the bubble. */
  const clock = (at: number): string =>
    new Date(at).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

  /**
   * A finished turn's footer, D4's "Importer · openai/gpt-5.6-sol · 41s" (A6 U4).
   *
   * - **The models are the turn's own** (`turnModels`, from each item's `model`), so an
   *   earlier turn keeps the model that answered it after a switch, and a turn switched
   *   mid-way names both: `claude-sonnet-4-5 → claude-haiku-4-5`. The session's current
   *   model only where the harness named none.
   * - **The duration** runs from when the importer started on the message — accepted, or
   *   taken off the queue, on the server's clock; stored, on a replay — to the turn's last
   *   item, which the server or the harness stamped. Both ends one clock, so it is a length
   *   and not a difference between two machines. Left out when the turn has no items.
   */
  const footerOf = (group: ChatGroup<ImporterTurn>): string => {
    const models = turnModels(group);
    const model =
      models.length > 0 ? models.join(" → ") : (session?.model ?? "");
    const ended = turnEndedAt(group);
    const started = group.subject.startedAt;
    const took =
      ended !== undefined && started !== null && ended >= started
        ? durationLabel(ended - started)
        : "";
    return [agentLabel, model, took].filter((part) => part !== "").join(" · ");
  };

  /** The importer's words in a turn, as the footer's Copy copies them. */
  const replyText = (group: ChatGroup<ImporterTurn>): string =>
    group.rows
      .filter((row) => row.item.kind === "turn.reply")
      .map((row) => row.item.body.trim())
      .filter((body) => body !== "")
      .join("\n\n");

  let box = $state<HTMLTextAreaElement | undefined>(undefined);
  /** Whether the focus is anywhere in the composer's box, for its strong border. */
  let focused = $state(false);
  /** The Stop pill, which focus returns to when a refused Stop's dialog closes. */
  let stopButton = $state<HTMLButtonElement | undefined>(undefined);

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
   * **Fill, never send** (D2: "really just pre-written first messages"). Each starter ends
   * where the operator's own words go — the program page's URL, the pasted statement — so
   * sending it as it stands would ask the importer to read nothing.
   *
   * Focus, because a click that leaves the caret on the button asks them to find the box.
   * After a `tick`: the textarea's value follows the state, not the other way round.
   */
  async function choose(key: StarterKey): Promise<void> {
    const caret = importer.useStarter(key);
    await tick();
    if (box === undefined) return;
    box.focus();
    box.setSelectionRange(caret, caret);
  }

  /**
   * Puts focus in the composer once the page has drawn: after the model picker opened a new
   * session on another harness, the chip that opened it is gone with the session it was
   * for, and the draft it carried over is here.
   */
  async function focusComposer(): Promise<void> {
    await tick();
    box?.focus();
  }

  /**
   * What the page says above an earlier session the operator is reading, which depends on
   * what the next message will actually do (S6).
   *
   * **The server decides, and this only words it.** `continuation` is the server's answer —
   * it knows whether this process holds the session and, for one it does not, whether the
   * harness will continue it, which is a round trip this page cannot make. Three readings,
   * because the operator's next message lands somewhere different in each, and the one thing
   * that must not happen is "resumes it" over a session that cannot be resumed.
   */
  let readingNote = $derived(
    session?.history.standing?.continuation === "resume"
      ? "You are reading an earlier session. Your next message takes it back over: the importer keeps everything above, and works against the scope as it stands now, not as it stood then."
      : session?.history.standing?.continuation === "fresh"
        ? "You are reading an earlier session that cannot be carried on. Your next message starts a new one, and the importer in it will not have read any of this — what this session wrote is on the Scope tab and in the Estate."
        : "You are reading an earlier session. Your next message continues it, with the scope as it stands now, not as it stood then.",
  );

  let placeholder = $derived(
    stranded !== undefined
      ? "This session's harness is not on this server, so it cannot be continued."
      : ended
        ? "This session was ended, so it cannot be continued."
        : refusedBecause !== undefined
          ? refusedBecause
          : noHarness
            ? "No agent harness on this server is ready, so there is no importer to talk to."
            : noModel
              ? "The server could not be asked which model the importer would run on, so there is nothing to send to yet."
              : groups.length === 0
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
    note={stranded !== undefined
      ? strandedNote(stranded)
      : ended
        ? ENDED_NOTE
        : refusedBecause !== undefined
          ? refusedBecause
          : noModel
            ? app.importModelDetail
            : session?.reading
              ? readingNote
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
          <!--
            D3's line under the bubble: who and when, and a copy of the words. A message
            still waiting behind the running turn says so here, until the harness takes it.
          -->
          <div class="said">
            {#if group.subject.queued}
              <span class="queued-mark">queued</span>
            {/if}
            <span class="when"
              >You{group.subject.at === null
                ? ""
                : ` · ${clock(group.subject.at)}`}</span
            >
            <CopyButton
              text={group.subject.message}
              label="Copy your message"
            />
          </div>
        </div>
      {/if}
    {/snippet}

    {#snippet tail(group)}
      <!--
        D3's streaming cursor: the importer is still on this message. Drawn while the turn is
        in flight — from the server accepting it until the server says the import is no
        longer running — and not while a pending write already draws its own, so a turn
        never blinks twice.

        The status line is the cursor's counterpart in words, for a reader who cannot see
        either cursor, so it follows the turn and not the cursor: it is said whichever of the
        two is drawn. It lived in the header over the reply until that header went (S3);
        here it is still inside the group it is about, and still after the operator's words.
      -->
      {#if group.subject.working}
        <span class="visually-hidden" role="status"
          >The importer is working.</span
        >
        {#if !group.rows.some((row) => row.write === "pending")}
          <div class="streaming"><StreamCursor /></div>
        {/if}
      {/if}
    {/snippet}

    {#snippet footer(group)}
      <!--
        Under the finished reply, as D4 draws it: a copy of the turn's words, then the agent,
        the model or models that answered and how long the turn took (`footerOf`). Not while
        the turn is in flight, as OpenCode's is not — the cursor is what is under a reply
        still being written, and a caption that appeared mid-stream would then move down
        with every row that landed above it.
      -->
      {#if !group.subject.working}
        <div class="foot">
          <CopyButton
            text={replyText(group)}
            label="Copy the importer's reply"
          />
          <p class="foot-text">{footerOf(group)}</p>
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
        <!--
          Stop interrupts the harness's turn and keeps the conversation (A6 F5). The cursor
          clears on the server's answer, not on the press. While the answer is coming the pill
          is aria-disabled rather than disabled, so focus stays on it.
        -->
        <button
          bind:this={stopButton}
          class="stop"
          type="button"
          aria-disabled={importer.stopping}
          onclick={() => {
            if (!importer.stopping) void importer.stop();
          }}
        >
          <span class="stop-mark" aria-hidden="true"></span>
          <span>{importer.stopping ? "Stopping…" : "Stop"}</span>
        </button>
      {/if}
    {/snippet}

    {#snippet composer()}
      <div class="stack">
        {#if importer.sending && importer.waitingForSwitch && switchingHere !== undefined}
          <!--
            A message sent behind a switch of this session: the server holds it until the
            switch has answered (F4's review measured up to ~90 s, when the switch has to
            reopen the session first). Said, so a send that sits there is not read as lost.
          -->
          <p class="notice waiting" role="status">
            Waiting for the model switch: this message is delivered once the
            switch has answered, which can take up to a minute and a half.
          </p>
        {/if}
        {#if switchNote !== ""}
          <!-- The server's answer to the last switch, in words that say when it applies. -->
          <p class="notice switched" role="status">{switchNote}</p>
        {/if}
        {#if importer.notice !== ""}
          <!--
            The server's sentence about the last message: a refusal, or the note on one it
            accepted (a session it had to open afresh says why). Its words, never ours.
          -->
          <p
            class={["notice", importer.refused && "refusal"]}
            role={importer.refused ? "alert" : "status"}
          >
            {importer.notice}
          </p>
        {/if}
        <form
          class={[
            "box",
            groups.length === 0 && "first",
            (focused || importer.draft !== "") && "in-use",
          ]}
          onfocusin={() => (focused = true)}
          onfocusout={(event) => {
            const next = event.relatedTarget;
            focused =
              next instanceof Node && event.currentTarget.contains(next);
          }}
          onsubmit={submit}
          aria-busy={importer.sending}
        >
          <label class="visually-hidden" for="importer-message"
            >Message the importer</label
          >
          <textarea
            bind:this={box}
            id="importer-message"
            rows="1"
            class={[groups.length === 0 && "first"]}
            {placeholder}
            disabled={blocked}
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
            <AgentChip
              agents={importer.agents}
              agentId={session?.agentId}
              locked={(session !== undefined && session.tally.messages !== 0) ||
                importer.sending}
              onpick={(agentId) => importer.pickAgent(agentId)}
            />
            <ImporterModelPicker
              {app}
              {pinned}
              switchable={!blocked}
              onNewSession={focusComposer}
            />
            {#if pinned !== null && !blocked}
              <!--
                D3's caption: the harness is the session's for good, its models are not. While
                a switch is out it says which model the session is moving to instead.
              -->
              {#if switchingHere !== undefined}
                <span class="hint" role="status"
                  >Switching to {switchingHere.model}…</span
                >
              {:else}
                <!-- The title is the whole caption, where a long model name ellipses it. -->
                <span
                  class="hint"
                  title="{pinned.harness} for this session · any of its models"
                  >{pinned.harness} for this session · any of its models</span
                >
              {/if}
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

{#if importer.stopFailure !== undefined}
  <ErrorDialog
    {...importer.stopFailure}
    opener={stopButton ?? null}
    ondismiss={() => importer.dismissStopFailure()}
  />
{/if}

<style>
  .importer {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
  }

  .streaming {
    padding: 4px 0 0;
  }

  /*
    ── The separator: the operator's bubble ─────────────────────────────────────
    Across the whole row, so the bubble can be pushed to its right end. The space under it
    is the gap the importer's header used to fill: with the header gone the reply would
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
  .strip {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .grow {
    flex: 1;
  }
  /*
    The strip's caption (D3: "OpenCode for this session · any of its models"). D3 sets it
    faint; muted here, as the turn footer is, because faint is below AA at 11px and this is
    a sentence the operator reads. It gives way before the chips do.
  */
  .hint {
    min-width: 0;
    overflow: hidden;
    font: 400 11px/16px var(--font-sans);
    color: var(--text-muted);
    white-space: nowrap;
    text-overflow: ellipsis;
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
  /* ── The server's sentence about the last message ──────────────────────────── */
  .notice {
    margin: 0;
    color: var(--text-muted);
    font: 400 12px/18px var(--font-sans);
    text-wrap: pretty;
    overflow-wrap: anywhere;
  }
  .notice.refusal {
    color: var(--text-danger, var(--text-base));
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
    gap: 7px;
    height: 28px;
    padding: 0 10px;
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
</style>
