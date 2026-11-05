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
   * ## It is the importer's adapter over {@link ChatShell}
   *
   * The bubble, the cursor, the footer, Stop, the composer with Send now and its files, the
   * drop and the F2 dialogs are the shared shell's (A6 prep for the goal, planner and worker
   * chats), which draws them from a `ChatSession` (`chatShell.ts`). This file builds that
   * session from `app.importer` and keeps what only the importer has: the starters, the
   * agent chip, the model picker and its caption, the switch notices, and every sentence
   * that says why a session cannot be continued. Parked words, `#confirm`, opening a session
   * and the new-session flow are `importerSessions.svelte.ts`'s and `TitleBar`'s, and are
   * reached from here only through `app.importer`.
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
   * ## Files, the agent and the model
   *
   * Files come in by paste, by a drop on the box or by the `+` picker (A6 U13), wait in the
   * tray above the words ({@link ComposerTray}) and go in the message's own request; the
   * sent turn shows them as chips under the bubble ({@link AttachmentChips}), live and after
   * a reload. A file the composer will not take, and a send refused for its files, are said
   * in the F2 dialog. The agent chip is D7's selector ({@link AgentChip}) over
   * the server's registry, pinned once the first message is sent; the model chip is the
   * real picker ({@link ImporterModelPicker}) over whatever harnesses the app holds — the
   * server's when connected, `mockHarnesses` in the state picker. Once the session has
   * started its harness is pinned and its model is not (D6): the chip switches the model of
   * the running session (A6 F4), and another harness is a new session.
   */
  import { tick } from "svelte";

  import { IMPORTER_MESSAGE_MAX_CHARS } from "@bit/contracts";

  import type { App } from "../app.svelte";
  import { IconFile, IconLink } from "../icons";
  import { connectionNote } from "../chat";
  import type {
    ChatComposerSource,
    ChatSession,
    ChatWords,
    ComposerNotice,
  } from "../chatShell";
  import {
    ENDED_NOTE,
    readingNote,
    sendNowButtonTitle,
    sentNowTitle,
    strandedNote,
    type ImporterTurn,
  } from "../importerChat";
  import { STARTERS, type StarterKey } from "../importerSessions.svelte";
  import AgentChip from "./AgentChip.svelte";
  import ChatShell from "./ChatShell.svelte";
  import ImporterModelPicker from "./ImporterModelPicker.svelte";

  let { app }: { app: App } = $props();

  let importer = $derived(app.importer);
  let session = $derived(importer.current);
  /**
   * The server's connection to this session's narration, when it is down (U13 review 5):
   * said over the thread, as an alert, until it is back.
   */
  let connection = $derived(
    connectionNote(
      session?.importId === undefined
        ? undefined
        : app.liveConnection[`import:${session.importId}`],
    ),
  );
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
  let working = $derived(session?.working ?? false);
  /**
   * Work the agent started in the background still running outside any turn (A6 U6), as
   * the server last said. Stop is offered for it too: it stops that work.
   */
  let background = $derived(session?.background === true);
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

  /**
   * What the page says above a session the operator is reading and has not typed into
   * (`readingNote`): what the next message will do, and "earlier" only of a session that is
   * neither running nor the target's newest (U8). **The server decides, and this only words
   * it**: `continuation` is the server's answer, which knows whether this process holds the
   * session and, for one it does not, whether the harness will continue it.
   */
  let readingSaid = $derived(
    readingNote(
      session,
      session !== undefined && importer.newestId === session.id,
    ),
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

  /**
   * The sentences above the box, in D3's order.
   *
   * - A message sent behind a switch of this session: the server holds it until the switch
   *   has answered (F4's review measured up to ~90 s, when the switch has to reopen the
   *   session first). Said, so a send that sits there is not read as lost.
   * - The server's answer to the last switch, in words that say when it applies.
   * - The server's sentence about the last message: a refusal, or the note on one it
   *   accepted (a session it had to open afresh says why). Its words, never ours.
   */
  let notices = $derived<readonly ComposerNotice[]>([
    ...(importer.sending &&
    importer.waitingForSwitch &&
    switchingHere !== undefined
      ? [
          {
            key: "waiting",
            text: "Waiting for the model switch: this message is delivered once the switch has answered, which can take up to a minute and a half.",
            tone: "status" as const,
            kind: "waiting",
          },
        ]
      : []),
    ...(switchNote === ""
      ? []
      : [
          {
            key: "switched",
            text: switchNote,
            tone: "status" as const,
            kind: "switched",
          },
        ]),
    ...(importer.notice === ""
      ? []
      : [
          {
            key: "server",
            text: importer.notice,
            tone: importer.refused ? ("alert" as const) : ("status" as const),
            kind: importer.refused ? "refusal" : undefined,
          },
        ]),
  ]);

  const WORDS: ChatWords = {
    working: "The importer is working.",
    copyReply: "Copy the importer's reply",
    stopTurn: "Stop the importer's turn. The conversation stays open.",
    stopBackground:
      "Stop the work the importer started in the background, a sub-agent or a shell. The conversation stays open.",
    messageLabel: "Message the importer",
    sendLabel: "Send to the importer",
    sendTitle: "Send to the importer",
    sendQueuedTitle:
      "Send to the importer, queued: it reads this once it reaches a break in the work it is doing",
    countTitle: "Characters in this message, of the most the importer takes",
  };

  /**
   * The composer, over `app.importer`. The draft is the importer's own state, which parks
   * and restores across sessions, so the shell's textarea writes through to it.
   *
   * **It posts, on a real target** (S3): `importer.send` opens the empty session's
   * conversation or queues a message on a listed one. D3's "Send now" is offered while a
   * turn runs in a session the server holds: then a message can wait for the work in flight
   * (Enter, the arrow) or go ahead of every queued one — at the next step on Claude Code,
   * once the message being written ends on OpenCode (`SendNowTiming`).
   */
  const composer: ChatComposerSource = {
    get draft() {
      return importer.draft;
    },
    set draft(value: string) {
      importer.draft = value;
    },
    get files() {
      return importer.files;
    },
    get sending() {
      return importer.sending;
    },
    get blocked() {
      return blocked;
    },
    get placeholder() {
      return placeholder;
    },
    maxChars: IMPORTER_MESSAGE_MAX_CHARS,
    send: (urgency) => importer.send(urgency),
    get sendNow() {
      return {
        offered: session?.importId !== undefined,
        title: sendNowButtonTitle(importer.sendNow),
      };
    },
    get notices() {
      return notices;
    },
  };

  /** The importer's session, as the shell draws it. */
  const chat: ChatSession<ImporterTurn> = {
    get label() {
      return `Load the scope for ${target}`;
    },
    empty:
      "Paste the program's pages, or describe the engagement in your own words. The importer reads, narrates what it is doing, and writes scope entries and assets onto this target. You can correct it in the same thread.",
    get groups() {
      return groups;
    },
    get note() {
      return stranded !== undefined
        ? strandedNote(stranded)
        : ended
          ? ENDED_NOTE
          : refusedBecause !== undefined
            ? refusedBecause
            : noModel
              ? app.importModelDetail
              : readingSaid;
    },
    get connection() {
      return connection;
    },
    get turn() {
      return { working, background, stopping: importer.stopping };
    },
    stop: () => void importer.stop(),
    get stopFailure() {
      return importer.stopFailure;
    },
    dismissStopFailure: () => importer.dismissStopFailure(),
    composer,
    words: WORDS,
    get footer() {
      return { agent: agentLabel, model: session?.model ?? "" };
    },
    get sentNowTitle() {
      return sentNowTitle(importer.sendNow);
    },
    // Attachment chips in this thread ask this target's server for their files (A6 U13).
    loadFile: (path) => app.loadUploadedFile(path),
  };

  let shell = $state<ChatShell<ImporterTurn> | undefined>(undefined);

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
    shell?.focusComposer(caret);
  }

  /**
   * Puts focus in the composer once the page has drawn: after the model picker opened a new
   * session on another harness, the chip that opened it is gone with the session it was
   * for, and the draft it carried over is here.
   */
  async function focusComposer(): Promise<void> {
    await tick();
    shell?.focusComposer();
  }
</script>

<ChatShell bind:this={shell} session={chat} id="importer" rootClass="importer">
  {#snippet footnote()}
    A call marked <strong>recorded</strong> is a committed event and stays on the
    Assets page. A dashed call, the importer's words and your messages are narration:
    not stored, and gone on a reload unless the harness still has them.
  {/snippet}

  {#snippet strip()}
    <AgentChip
      agents={importer.agents}
      agentId={session?.agentId}
      locked={(session !== undefined && session.tally.messages !== 0) ||
        importer.sending}
      onpick={(agentId) => importer.pickAgent(agentId)}
    />
    <!--
      V2(chat): the model picker reads and writes `app`'s importer fields directly
      (`importPickerOpen`, `importInstance`, `importer.switchModel`…), so it is mounted here
      and not by the shell. The goal chat has a switch route (`switchGoalModel`) and no
      picker; a shared one takes the adapter's model, catalogue and `switchModel` instead.
    -->
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
  {/snippet}

  {#snippet below()}
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
  {/snippet}
</ChatShell>

<style>
  /*
    The strip's caption (D3: "OpenCode for this session · any of its models"). D3 sets it
    faint; muted here, as the turn footer is, because faint is below AA at 11px and this is
    a sentence the operator reads. It gives way before the chips do.
  */
  .hint {
    /*
     * Gives way first, and wholly, before any chip does: the chips and the send buttons are
     * controls, this is a caption. A basis of nothing and the strip's free space to grow
     * into (A6 U6 review) — not a large `flex-shrink`, which shrinks every item in
     * proportion, so the model chip still lost a few pixels, and ellipsed its name, the
     * moment "Send now" appeared beside a caption that had room to spare.
     */
    flex: 1000 1 0;
    min-width: 0;
    overflow: hidden;
    font: 400 11px/16px var(--font-sans);
    color: var(--text-muted);
    white-space: nowrap;
    text-overflow: ellipsis;
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
