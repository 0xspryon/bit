<script lang="ts">
  /**
   * The planner round's view: watch it think and call tools, and stop it.
   *
   * **Read-only, and that is a statement about authority rather than about this screen.**
   * An operator may not prompt a round. A round's prompt is assembled server-side from the
   * goal's objective and the goal briefing, the route that opens one takes no payload at
   * all, and the way to say something to a planner is to steer it from the goal
   * conversation — which is slice 9, and which renders {@link Chat} with its composer
   * enabled. So this passes `readonly` and a controls strip, and there is no box to type
   * in because there is nothing for it to submit.
   *
   * ## What sits where the composer would be
   *
   * Stop, and how long the round has been going — the arrangement {@link ComposeBox}'s
   * running strip has, for the same reason: the elapsed time is a fact about the request and
   * not a deadline, nothing counts down, and settlement is the harness's to decide. A
   * settled round shows what it concluded instead.
   *
   * **Stop is offered only for a round this *process* is driving**, read from
   * `app.openGoalRunningRound` rather than from a row saying `running`. A row can be one a
   * dead process left behind, which nothing will settle until the next startup sweep, and a
   * stop control over it would be a button whose only possible outcome is `unknown_round`.
   * {@link PlanPanel} makes the same distinction for the same reason.
   *
   * Stopping is not pausing. It interrupts the session, settles the round `interrupted`,
   * revokes its credential and supersedes its write fence — so a planner that tries to
   * write afterwards is refused by the store rather than ignored. There is no resume, which
   * is why there is no second control: work carried on after an interruption is a new round.
   *
   * ## Where it sits, and what it does not duplicate
   *
   * Under {@link PlanPanel}, which is the record: every round the goal has had, with its
   * disposition and its budget. This is the conversation, newest round last, and it shows
   * the most recent rounds only — each round's prose costs a request into the harness, so
   * the ones past that budget stay in the panel above rather than appearing here with
   * nothing under them.
   *
   * ## This file is the planner's half of the chat, and that is the point
   *
   * {@link Chat} knows nothing about rounds. The **separator** — the status as a word, when
   * it started, its id, whether this process is driving it, and what it concluded — is
   * rendered here from this component's own subject, and so are the count, the "older
   * rounds" sentence and the durability footnote. Slice 9's goal conversation writes its own
   * three and changes nothing in `Chat.svelte`, which is what ruling 1 asked for and what
   * this slice being sequenced first was supposed to buy.
   */
  import Button from "./Button.svelte";
  import Chat from "./Chat.svelte";
  import ContextMeter from "./ContextMeter.svelte";
  import { roundConclusion, roundStatusLabel, whenText } from "../goalFormat";
  import type { MeterFact } from "../chat";
  import type { App } from "../app.svelte";

  let { app }: { app: App } = $props();

  /**
   * A ticking clock, so the elapsed time is live rather than frozen at render.
   *
   * `$effect` with a cleanup, which is what makes this correct under Svelte 5: the interval
   * starts when the component mounts and is cleared when it unmounts, so a closed goal does
   * not leave a timer behind. One second is as often as a value in whole seconds can change.
   */
  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  });

  let inFlight = $derived(app.openGoalRunningRound);
  let latest = $derived(app.latestPlanRound);
  let rounds = $derived(app.goalChat.groups.length);
  let older = $derived(app.goalChat.older);
  let elapsed = $derived(
    inFlight === undefined
      ? ""
      : formatElapsed(Math.max(0, now - inFlight.startedAt)),
  );

  /**
   * A sentence about the read itself, kept apart from a round saying it has no prose.
   *
   * {@link App.goalNarrationDetail} is only set when no server answered or the server
   * refused the request outright. A round the harness has forgotten is a *successful* read
   * and says so on its own separator, which is why that case never reaches here.
   */
  let detail = $derived(
    app.goalNarrationDetail !== ""
      ? app.goalNarrationDetail
      : app.roundStopDetail,
  );

  /**
   * Which round the meter is about, and the facts only this screen can name.
   *
   * The same subject the strip below reports on — the round in flight if there is one, else
   * the newest — so the figure and the sentence beside it are about one round rather than
   * two. `app.plannerContextMeter` picks the same way, from the same two fields; this is
   * the identity half of it, which the meter cannot know because a round's harness session
   * and model live on the round's **row**.
   */
  let meterRoundId = $derived(inFlight?.roundId ?? latest?.roundId);
  /**
   * The round's **row**, which is the only place its harness and model are.
   *
   * Looked up rather than taken from `inFlight`: a running round arrives as a
   * `RunningRound`, which carries the ids this process needs to drive it and nothing about
   * what it is running on. The row has that, and it is also what survives a reload.
   */
  let meterRow = $derived(
    meterRoundId === undefined
      ? undefined
      : app.planRounds.find((round) => round.roundId === meterRoundId),
  );
  /**
   * How many messages the replay brought back for the round the meter is about.
   *
   * `"not read"` rather than `0`, and it covers **two** situations rather than one: a round
   * past the replay budget, which will never be read, and a round that started after the
   * replay answered — the ordinary case for the round an operator has just opened, whose
   * read is still on its way. Both are "we have not been told", which is a different fact
   * from "the harness holds none", and a bare zero would collapse all three.
   */
  let messagesHeld = $derived.by(() => {
    const replay = app.goalNarration?.rounds.find(
      (round) => round.roundId === meterRoundId,
    );
    if (replay === undefined) return "not read";
    const held = replay.items.length;
    return `${String(held)} ${held === 1 ? "item" : "items"} held by the harness${replay.truncated ? ", shortened" : ""}`;
  });

  let meterFacts = $derived<readonly MeterFact[]>(
    meterRow === undefined
      ? []
      : [
          { term: "Round", value: meterRow.roundId },
          // Each one says "not recorded" rather than being left out, because a round whose
          // row has no model is a round that never reached a harness — which is a fact
          // worth seeing beside a figure, not a row to hide.
          {
            term: "Session",
            value: meterRow.harnessSessionId ?? "not recorded",
          },
          { term: "Harness", value: meterRow.instanceId ?? "not recorded" },
          {
            term: "Model",
            value:
              meterRow.modelId === null
                ? "not recorded"
                : `${meterRow.providerId ?? "?"}/${meterRow.modelId}`,
          },
          /*
           * The brief's "message counts", and the value says what it counts.
           *
           * It is the harness's **replayed** copy for this round, which is the only
           * message count this application has: narration is not persisted (decision 14),
           * so nothing here knows how many messages a round really had — only how many the
           * harness still holds and answered with. A bare number labelled "Messages" would
           * read as the second thing, and on a round the replay has not covered — one past
           * the budget, or one still in flight — it would read as zero messages rather than
           * as no answer. See {@link messagesHeld}.
           */
          { term: "Replayed", value: messagesHeld },
        ],
  );

  function formatElapsed(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${String(seconds)}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`;
    return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
  }
</script>

<Chat
  label="Planner conversation"
  groups={app.goalChat.groups}
  readonly={true}
  count={rounds === 0
    ? ""
    : `${String(rounds)} round${rounds === 1 ? "" : "s"}`}
  note={older === 0
    ? ""
    : `This chat shows the most recent rounds only: ${String(older)} older ${older === 1 ? "round is" : "rounds are"} not here. Each is still listed above with its status and what it concluded.`}
  {detail}
  empty="No round has been opened on this goal yet. 'Plan next' above starts one, and what it says appears here as it says it."
>
  {#snippet separator(group)}
    <!--
      Every part of this comes from the round's **row**, which is why it survives a reload
      even when the prose does not — the spec's decision 16. The status is a word and not a
      colour: "Outcome unknown" is not "Failed", and a round has no word for failing.
    -->
    <span class="sep-status"
      >{roundStatusLabel(group.subject.round.status)}</span
    >
    <span class="sep-when">{whenText(group.subject.round.startedAt)}</span>
    <span class="sep-id mono" title="Planner round {group.key}"
      >{group.key}</span
    >
    {#if group.subject.inFlight}
      <span class="chip" data-tint="warning">in flight here</span>
    {/if}
    {#if group.subject.round.status !== "running"}
      <span class="sep-note">{roundConclusion(group.subject.round)}</span>
    {/if}
  {/snippet}

  {#snippet meter()}
    <ContextMeter
      meter={app.plannerContextMeter}
      label="Planner round context"
      facts={meterFacts}
    />
  {/snippet}

  {#snippet footnote()}
    Rows marked <strong>record</strong> are committed events and arrive in the
    order the store assigned them. Rows marked
    <strong>activity</strong> are what the planner is narrating in this process: they
    are not part of the record, are not stored, and are gone on a reload.
  {/snippet}

  {#snippet controls()}
    {#if inFlight !== undefined}
      <span class="pulse" aria-hidden="true"></span>
      <span class="status" role="status">
        Planning for <strong>{elapsed}</strong>
      </span>
      <Button
        size="sm"
        variant="danger"
        loading={app.roundStopping === inFlight.roundId}
        onclick={() => void app.stopRound(inFlight.roundId)}
      >
        Stop
      </Button>
      <p class="hint">
        This round is going on the server, not in this tab — closing it will not
        stop the planner. Stopping settles the round and withdraws its write
        authority; there is no resume.
      </p>
    {:else if latest !== undefined}
      <!--
        A settled round shows what it concluded where the stop control was. Not a disabled
        button: there is nothing left to do to a round that has ended, and a control that
        cannot be pressed and does not say so is a question rather than an answer.
      -->
      <span class="status">{roundConclusion(latest)}</span>
      {#if latest.endedAt !== null}
        <span class="hint">Ended {whenText(latest.endedAt)}</span>
      {/if}
    {/if}
  {/snippet}
</Chat>

<style>
  /*
   * The same pulse the run strip uses, and the same reason it is `aria-hidden`: it is a
   * second rendering of what the sentence beside it already says.
   */
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
  .status strong {
    font-variant-numeric: tabular-nums;
  }
  .hint {
    flex-basis: 100%;
    margin: 0;
    font-size: 11px;
    line-height: var(--lh-compact);
    color: var(--text-muted);
  }
  /* The separator's own type. Its layout — the rule above it — belongs to {@link Chat}. */
  .sep-status {
    font: 600 12px/var(--lh-compact) var(--font-sans);
    color: var(--text-base);
  }
  .sep-when {
    font-size: 11px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .sep-id {
    max-width: 24ch;
    overflow: hidden;
    font-size: 10px;
    color: var(--text-muted);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .sep-note {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    color: var(--text-base);
  }
  .chip {
    display: inline-block;
    padding: 1px 6px;
    border: 1px solid var(--state-border-warning);
    border-radius: var(--radius-sm);
    background: var(--state-bg-warning);
    color: var(--state-fg-warning);
    font: 600 10px/var(--lh-tight) var(--font-sans);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
</style>
