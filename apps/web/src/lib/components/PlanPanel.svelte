<script lang="ts">
  /**
   * "Plan next" on a goal: the control that opens a planner round, and what the last one
   * concluded.
   *
   * **It is not the round's live view.** Watching a round think, its tool calls and its
   * controls are slice 8, and this panel deliberately stops at the record: a round is in
   * flight or it is not, and a settled one has a disposition or it has not. The one thing
   * it says about a round in flight is that there is one, because that is what explains a
   * disabled button.
   *
   * ## Two sources, and the difference is why there are two
   *
   * `app.openGoalRunningRound` is what this *process* is driving, and
   * `app.latestPlanRound` is the newest row. A row saying `running` can be one a dead
   * process left behind — nothing will settle it until the next startup sweep — so a
   * control that read the rows alone would tell an operator to wait for a round nothing is
   * working. The button is disabled on the first and the history is read from the second.
   *
   * ## Refusals are sentences, not error codes
   *
   * Every reason `PlanRefused` carries is written for an operator — "a round is already
   * planning this goal", "this goal has ended, so nothing new is dispatched under it",
   * "that harness instance is not usable on this server" — and is shown as written. The
   * one refusal with numbers is a briefing over the ceiling, and that one prints both:
   * what the briefing rendered to and what the limit is. It also says the round started
   * nothing, which is the part an operator cannot infer from a size.
   *
   * ## What ending a goal does to this panel
   *
   * The control disappears rather than being disabled without explanation, the way the
   * end control does on a goal that has already ended: an ended goal takes no new rounds
   * (the spec's decision 8), and a button that cannot be pressed and does not say so is a
   * question. The rounds it already had stay on screen, because their conclusions are the
   * record of how the goal got here.
   */
  import Button from "./Button.svelte";
  import {
    budgetLine,
    roundConclusion,
    roundStatusLabel,
    whenText,
  } from "../goalFormat";
  import type { App } from "../app.svelte";

  let { app }: { app: App } = $props();

  let goal = $derived(app.openGoalView);
  let inFlight = $derived(app.openGoalRunningRound);
  let latest = $derived(app.latestPlanRound);
  let rounds = $derived(
    app.planRoundsGoalId === app.openGoalId ? app.planRounds : [],
  );
  /** Thousands separators, for the same reason the briefing panel has them. */
  let number = new Intl.NumberFormat();
</script>

<section aria-labelledby="plan-heading" class="plan">
  <div class="head">
    <h2 id="plan-heading">Planner</h2>
    {#if rounds.length > 0}
      <span class="count">
        {number.format(rounds.length)} round{rounds.length === 1 ? "" : "s"}
      </span>
    {/if}
  </div>

  <p class="hint">
    A planner round reads this goal's whole record, proposes the directions
    worth investigating next as intents, and records what it concluded. It runs
    nothing itself: each intent it adds is started from the list above.
  </p>

  {#if goal !== undefined && goal.status === "active"}
    {#if inFlight !== undefined}
      <!--
        In flight *in this process*, which is a stronger claim than a row saying
        `running` and is the only one that justifies disabling the button.
      -->
      <p class="hint" role="status">
        A round has been planning this goal since {whenText(
          inFlight.startedAt,
        )}. One planner works a goal at a time, so there is nothing to start
        until it settles.
      </p>
    {:else}
      <div class="actions">
        <Button
          variant="primary"
          loading={app.planStarting}
          onclick={() => void app.plan()}
        >
          {app.planStarting ? "Opening a round…" : "Plan next"}
        </Button>
      </div>
    {/if}
  {:else if goal !== undefined}
    <p class="hint">
      This goal has ended, so no further rounds are opened on it. The rounds it
      had are below.
    </p>
  {/if}

  {#if app.planDetail !== ""}
    <p class="error" role="alert">{app.planDetail}</p>
    {#if app.planRefusalSize !== undefined && app.planRefusalCeiling !== undefined}
      <dl class="figures">
        <dt>Briefing size</dt>
        <dd>{number.format(app.planRefusalSize)} characters</dd>
        <dt>Ceiling</dt>
        <dd>
          {number.format(app.planRefusalCeiling)} characters, from GOAL_BRIEFING_MAX_CHARS
        </dd>
      </dl>
      <p class="hint">
        No round was opened and nothing was started. A planner is never given a
        shortened briefing: it would reason from a gap it could not see.
      </p>
    {/if}
  {/if}

  {#if app.planRoundsState === "failed"}
    <p class="error" role="alert">{app.planRoundsDetail}</p>
  {:else if rounds.length === 0}
    <p class="hint" role="status">
      {app.planRoundsState === "loading"
        ? "Reading this goal's rounds…"
        : "No round has been opened on this goal yet."}
    </p>
  {:else}
    <ol class="rounds">
      {#each rounds as round (round.roundId)}
        <li class={["round", round.roundId === latest?.roundId && "latest"]}>
          <div class="row">
            <span class="status">{roundStatusLabel(round.status)}</span>
            <span class="when">{whenText(round.startedAt)}</span>
          </div>
          <p class="conclusion">{roundConclusion(round)}</p>
          {#if round.dispositionRationale !== null && round.dispositionRationale !== ""}
            <p class="rationale">{round.dispositionRationale}</p>
          {/if}
          <p class="budget">
            {budgetLine(round)}{round.intentsAdded >= round.budget
              ? " — its budget was spent"
              : ""}
          </p>
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .plan {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
  }
  h2 {
    margin: 0;
    font: 600 11px/var(--lh-compact) var(--font-sans);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .count {
    font-size: 12px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  p {
    margin: 0;
    font-size: 13px;
    line-height: var(--lh-base);
  }
  .hint {
    font-size: 12px;
    line-height: var(--lh-compact);
    color: var(--text-muted);
  }
  .error {
    color: var(--state-fg-danger);
    font-size: 12px;
    line-height: var(--lh-compact);
  }
  .actions {
    display: flex;
    gap: 8px;
    margin-top: 4px;
  }
  .figures {
    display: grid;
    grid-template-columns: 110px 1fr;
    gap: 6px 12px;
    margin: 0;
    font-size: 12px;
  }
  .figures dt {
    color: var(--text-faint);
  }
  .figures dd {
    margin: 0;
    color: var(--text-base);
    font-variant-numeric: tabular-nums;
  }
  .rounds {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 4px 0 0;
    padding: 0;
    list-style: none;
  }
  .round {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px 12px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    background: var(--bg-layer-01);
  }
  /*
    The newest round is marked by its border rather than by colour alone, so the
    distinction survives a monochrome display and does not depend on hue perception.
  */
  .round.latest {
    border-color: var(--border-focus);
  }
  .row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
  }
  .status {
    font: 530 12px/var(--lh-compact) var(--font-sans);
    color: var(--text-base);
  }
  .when {
    font-size: 12px;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }
  .conclusion {
    font-size: 13px;
    color: var(--text-base);
  }
  .rationale {
    font-size: 12px;
    line-height: var(--lh-base);
    color: var(--text-muted);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .budget {
    font-size: 12px;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }
</style>
