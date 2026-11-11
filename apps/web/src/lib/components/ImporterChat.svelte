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
   * the third caller and the importer's own subject ({@link ThreadTurn}) and separator are
   * written here. `layout="thread"` is the one thing `Chat` was taught for it: A6 draws the
   * chat as the whole page — an 800px column, no frame, the composer at the foot of the log —
   * where the planner's and the goal agent's are panels among other things. Rows go through
   * {@link ChatItem} too, `narrated`: prose as prose and a call as a mono block, with the
   * same record/activity distinction and write states as the ledger reading.
   *
   * The composer **floats** over the log (`ChatShell`'s `floating`): the log takes the
   * page's height and runs under the box, the last message resting just above it, and a
   * docked question or a long draft covers more of the log instead of moving it. Scrolled
   * up, "↓ Latest" brings the newest message back and puts focus in the box.
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
  import type { ThreadTurn } from "../chatShell";
  import {
    chatSessionOf,
    type ConversationChatWords,
  } from "../conversationChatSession";
  import {
    ENDED_NOTE,
    readingNote,
    sendNowButtonTitle,
    sentNowTitle,
    strandedNote,
  } from "../importerChat";
  import { STARTERS, type StarterKey } from "../importerSessions.svelte";
  import { composing } from "../composing";
  import { modelNameIn } from "../modelNames";
  import {
    panelOverlays,
    railGivesWay,
    SUBAGENT_CARD_SELECTOR,
    subagentCardId,
    subagentGroups,
    subagentsIn,
  } from "../subagents";
  import AgentChip from "./AgentChip.svelte";
  import ChatShell from "./ChatShell.svelte";
  import ImporterModelPicker from "./ImporterModelPicker.svelte";
  import SubagentCard from "./SubagentCard.svelte";
  import SubagentChip from "./SubagentChip.svelte";
  import SubagentPanel from "./SubagentPanel.svelte";

  let { app }: { app: App } = $props();

  let importer = $derived(app.importer);
  let session = $derived(importer.current);
  let groups = $derived(importer.groups);
  let target = $derived(app.selected?.name ?? app.viewTargetId);

  /*
   * ── Sub-agents (A7-S, E7/E8) ─────────────────────────────────────────────────────────
   * Every sub-agent of the session, its newest view each, from the rows the shell draws:
   * the chip counts them, the panel groups them, Stop all takes Stop's place while any runs.
   *
   * V2(chat): only the importer chat draws cards and the panel. The goal, planner and worker
   * chats get them by passing the same three snippets and `stopAll` to `ChatShell` once
   * they are rebuilt on it; their servers already narrate the same `SubagentView`, but have
   * no per-sub-agent Stop route yet (`stopImporterSubagent` is the importer's).
   */
  let subagents = $derived(subagentsIn(groups));
  let subagentsBy = $derived(subagentGroups(subagents));
  /** The clock a running card's time is measured to: ticked each second while any runs. */
  let now = $state(Date.now());
  $effect(() => {
    if (subagentsBy.running.length === 0) return;
    now = Date.now();
    const ticking = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => clearInterval(ticking);
  });
  let panelOpen = $state(false);
  /**
   * The panel is a drawer over the chat, not beside it (`panelOverlays`, A7-S review 3):
   * the window is too narrow for a 560px column beside it even with the rail away. Read as
   * the panel opens and on every resize while it is open; the rail is not taken for it.
   */
  let panelOverlay = $state(false);
  let chipButton = $state<HTMLButtonElement | undefined>(undefined);
  /**
   * The rail was put away by the panel, not by the operator: given back when the panel
   * closes (the chat-shell prep's decision: at 1024px and similar the chat column would
   * otherwise be under 560px beside a 400px panel).
   */
  let railTakenByPanel = false;
  /**
   * The operator showed the rail again while the panel had put it away: it is theirs for
   * the rest of this opening, and a resize does not take it again.
   */
  let railKeptByOperator = false;
  /**
   * What the page beside the shell takes while the rail shows (the window's width less the
   * shell's), measured when the panel put the rail away: how wide the shell would be with
   * the rail back, which is what says it may come back.
   */
  let besideShell = 0;

  const shellElement = (): HTMLElement | null =>
    document.querySelector<HTMLElement>(".chat-shell.importer");

  /**
   * The 560px rule (`railGivesWay`) for the shell's width now: the rail is put away when the
   * column beside the panel would be too narrow, and given back once it no longer would be,
   * if it was the panel that put it away. Applied as the panel opens and on every resize
   * while it is open (A7-S review 1: a tablet turned from landscape to portrait, 1440 to
   * 1024, kept the rail and left a 392px column).
   */
  function fitRail(shellWidth: number): void {
    if (!app.drawerHidden) {
      if (railTakenByPanel) {
        // Shown again by the operator, not by this.
        railTakenByPanel = false;
        railKeptByOperator = true;
        return;
      }
      if (railKeptByOperator || !railGivesWay(shellWidth)) return;
      besideShell = window.innerWidth - shellWidth;
      app.drawerHidden = true;
      railTakenByPanel = true;
      return;
    }
    if (railTakenByPanel && !railGivesWay(window.innerWidth - besideShell)) {
      railTakenByPanel = false;
      app.drawerHidden = false;
    }
  }

  /**
   * Both rules for the window and shell as they are now: a drawer where even the whole
   * window leaves under 560px beside the panel — and then a rail the panel took is given
   * back, since a drawer needs no room — else the rail rule.
   */
  function fitPanel(shellWidth: number): void {
    panelOverlay = panelOverlays(window.innerWidth);
    if (!panelOverlay) {
      fitRail(shellWidth);
      return;
    }
    if (railTakenByPanel) {
      railTakenByPanel = false;
      if (app.drawerHidden) app.drawerHidden = false;
    }
  }

  function openPanel(): void {
    railKeptByOperator = false;
    fitPanel(shellElement()?.clientWidth ?? window.innerWidth);
    panelOpen = true;
  }

  // While the panel is open the rules follow the window's and the shell's widths.
  $effect(() => {
    if (!panelOpen || typeof ResizeObserver === "undefined") return;
    const shell = shellElement();
    if (shell === null) return;
    const watching = new ResizeObserver(() => {
      fitPanel(shell.clientWidth);
    });
    watching.observe(shell);
    return () => {
      watching.disconnect();
    };
  });

  /**
   * `toChip`: focus goes back to the chip wherever it was (an Esc on a card, below);
   * `"stay"`: it is left to the caller (a drawer's row, which moves it to the card).
   */
  function closePanel(toChip: boolean | "stay" = false): void {
    // Asked before the panel goes: focus in it would otherwise fall to the page's body.
    const active = document.activeElement;
    const inPanel =
      active !== null &&
      (document.getElementById("subagent-panel")?.contains(active) ?? false);
    panelOpen = false;
    if (railTakenByPanel) {
      railTakenByPanel = false;
      // Given back only if the operator did not show it again meanwhile.
      if (app.drawerHidden) app.drawerHidden = false;
    }
    if (toChip === "stay") return;
    // Back to the chip that opened it, when focus was in the panel or nowhere.
    if (toChip || inPanel || active === null || active === document.body) {
      void tick().then(() => chipButton?.focus());
    }
  }

  // A panel open as the chat goes (another page, another session's chat) gives the rail back.
  $effect(() => () => {
    if (railTakenByPanel && app.drawerHidden) app.drawerHidden = false;
  });

  /*
   * E8: Esc closes the panel from a sub-agent's card too, where a row's jump put focus (A7-S
   * review 1: the panel's own Esc no longer heard it), and focus goes back to the chip. Not
   * an Esc an input method is using, nor one something nearer already acted on.
   */
  $effect(() => {
    if (!panelOpen) return;
    const onkeydown = (event: KeyboardEvent): void => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        composing(event)
      ) {
        return;
      }
      const on = event.target instanceof Element ? event.target : null;
      if (on?.closest(SUBAGENT_CARD_SELECTOR) == null) return;
      event.preventDefault();
      closePanel(true);
    };
    document.addEventListener("keydown", onkeydown);
    return () => {
      document.removeEventListener("keydown", onkeydown);
    };
  });

  /**
   * A7-S review 4: while the panel is a drawer, Esc closes it from anywhere — the chip, the
   * composer, the transcript — not only from inside it or a card: it covers the right of
   * the chat, and the operator reaching for Esc should not first have to find it.
   *
   * That includes an Esc inside the question dock (final review, an orchestrator
   * decision): at 768 the drawer covers most of the dock, and an operator who clicked one of
   * its visible options and pressed Esc meant the drawer, not to throw the question away —
   * a dismissal cannot be undone. So the first Esc closes the drawer, and only one with the
   * drawer closed reaches the dock (whose rules, A7-Q, are then as before). Clicks on the
   * part of the dock left visible keep working; Tab cannot reach it from the drawer.
   *
   * Not an Esc that is another control's: one an input method is using (`composing`), and
   * one while a popover (a control with `aria-haspopup` that is expanded: the model, agent
   * and session pickers, the context meter, the dock's Jump to… list) or another modal
   * dialog is open, which closes that alone. Those listen on `window`, after this would
   * have, so this listens in the capture phase and asks the page rather than
   * `defaultPrevented`; the dock and the shell's dock listener do check `defaultPrevented`,
   * so the `preventDefault` here keeps this Esc from them. Focus stays where it was, unless
   * it was in the drawer, where `closePanel` sends it to the chip.
   */
  $effect(() => {
    if (!panelOpen || !panelOverlay) return;
    const onkeydown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || composing(event)) return;
      const on = event.target instanceof Element ? event.target : null;
      const drawer = document.querySelector('aside.overlay[role="dialog"]');
      const otherDialog = [
        ...document.querySelectorAll('[aria-modal="true"]'),
      ].some((dialog) => dialog !== drawer);
      if (otherDialog) return;
      if (document.querySelector('[aria-haspopup][aria-expanded="true"]')) {
        return;
      }
      event.preventDefault();
      closePanel(on?.closest(SUBAGENT_CARD_SELECTOR) != null);
    };
    window.addEventListener("keydown", onkeydown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onkeydown, { capture: true });
    };
  });

  /**
   * E8: selecting a row scrolls the transcript to its card, and focus goes with it. A
   * drawer (`panelOverlay`) closes first, since it would cover the card (A7-S review 3).
   */
  function showCard(callId: string): void {
    const card = document.getElementById(subagentCardId(callId));
    if (card === null) return;
    if (panelOverlay) closePanel("stay");
    card.scrollIntoView({ block: "center", behavior: "smooth" });
    card.focus({ preventScroll: true });
  }
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

  /**
   * Which model an import would run on could not be had, so there is nothing to talk to. Only
   * an answer counts: an import model not asked for yet is not this. Two different
   * conditions, said differently: the server answering that no harness is ready
   * (`noHarness`), and the lookup failing some other way — no server answered, say — which
   * is not a claim about harnesses at all. The state's fact (`App.importer`'s
   * `unavailable`), so the box and the dock's rule read it too.
   */
  let noModel = $derived(importer.messagesUnavailable);
  let noHarness = $derived(noModel && app.importModelNoHarness);

  /** The importer's words for the generic chat: every sentence that names it or its pages. */
  const WORDS: ConversationChatWords = {
    shell: {
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
      questionsAsked: (count) =>
        count === 1
          ? "The importer asks a question"
          : `The importer asks ${String(count)} questions`,
    },
    empty:
      "Paste the program's pages, or describe the engagement in your own words. The importer reads, narrates what it is doing, and writes scope entries and assets onto this target. You can correct it in the same thread.",
    // "Importer" where no registry has been read: the page is the importer's either way.
    agent: "Importer",
    stopAll: "Stop the importer's sub-agents, then its turn",
    placeholder: (thread) =>
      thread === "empty"
        ? "Paste a policy or scope URL, or say what is in and out of scope…"
        : "Correct it, or add what the pages do not say…",
    stranded: (instanceId) => ({
      note: strandedNote(instanceId),
      placeholder:
        "This session's harness is not on this server, so it cannot be continued.",
    }),
    ended: {
      note: ENDED_NOTE,
      placeholder: "This session was ended, so it cannot be continued.",
    },
    reading: readingNote,
    sendNow: sendNowButtonTitle,
    sentNow: sentNowTitle,
  };

  /**
   * The importer's session, as the shell draws it: the generic chat over `app.importer`
   * (`conversationChatSession.ts`), with the importer's words, and nothing to send to while
   * no model can be had.
   */
  const built = chatSessionOf({
    get state() {
      return app.importer;
    },
    words: WORDS,
    label: () => `Load the scope for ${target}`,
    endedReason: "import_ended",
    connection: (importId) =>
      app.liveConnection[importer.binding.connectionKey(importId)],
    retry: (importId) =>
      app.liveRetry[importer.binding.connectionKey(importId)],
    unavailable: () =>
      noModel
        ? {
            note: app.importModelDetail,
            placeholder: noHarness
              ? "No agent harness on this server is ready, so there is no importer to talk to."
              : "The server could not be asked which model the importer would run on, so there is nothing to send to yet.",
          }
        : undefined,
    // Only what bit can stop from here (A7-S review 2).
    stoppableSubagents: () =>
      subagentsBy.running.filter((entry) => entry.view.stop !== "none").length,
    maxChars: IMPORTER_MESSAGE_MAX_CHARS,
    // Attachment chips in this thread ask this target's server for their files (A6 U13).
    loadFile: (path) => app.loadUploadedFile(path),
    // The footer's models by their labels, never an alias (follow-ups A).
    modelName: (on, model) =>
      modelNameIn(
        app.harnesses,
        { instanceId: on.harnessInstanceId, harness: on.harness },
        model,
      ),
  });
  const chat = built.chat;
  let blocked = $derived(built.blocked());

  let shell = $state<ChatShell<ThreadTurn> | undefined>(undefined);

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

{#snippet subagentPanel()}
  <SubagentPanel
    groups={subagentsBy}
    {now}
    agent="the importer"
    stopping={importer.subagentStopping}
    onstop={(callId) => void importer.stopSubagent(callId)}
    onselect={showCard}
    onclose={closePanel}
  />
{/snippet}

<!-- E8's panel is the shell's `aside` while it is open, and nothing otherwise. -->
<ChatShell
  bind:this={shell}
  session={chat}
  id="importer"
  rootClass="importer"
  floating
  aside={panelOpen ? subagentPanel : undefined}
  asideOverlay={panelOverlay}
  asideLabelledBy="subagent-panel-heading"
>
  {#snippet subagent(row)}
    {#if row.item.subagent !== undefined}
      <SubagentCard
        view={row.item.subagent}
        {now}
        agent="the importer"
        stopping={importer.subagentStopping.includes(row.item.subagent.callId)}
        onstop={(callId) => void importer.stopSubagent(callId)}
      />
    {:else}
      <!-- A server from before A7-S sends no view: its type and task, as U14 drew them. -->
      <p class="old-subagent">
        Sub-agent {row.item.headline}: {row.item.body} ({row.item.outcome ??
          "running"})
      </p>
    {/if}
  {/snippet}

  {#snippet chip()}
    <SubagentChip
      groups={subagentsBy}
      open={panelOpen}
      bind:button={chipButton}
      ontoggle={() => (panelOpen ? closePanel() : openPanel())}
    />
  {/snippet}

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
          >Switching to {modelNameIn(
            app.harnesses,
            { instanceId: session?.harnessInstanceId, harness: session?.harness },
            switchingHere.model,
          )}…</span
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
  .old-subagent {
    margin: 0;
    color: var(--text-muted);
    font: 400 12px/18px var(--font-sans);
  }
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
