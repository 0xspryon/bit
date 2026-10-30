<script lang="ts">
  /**
   * One goal: its objective, what hangs under it, and the one thing an operator can do to it.
   *
   * **The end control exists only while the goal is active.** Once a goal is `met` or
   * `abandoned` there is nothing left to do to it — ending is one-way, and a different
   * conclusion is a new goal — so the control is not disabled with no explanation, it is
   * replaced by the record of the ending: when, by whom, and why. A button that cannot be
   * pressed and does not say so is a question; a sentence about what happened is an answer.
   *
   * Ending says what it does not do before it is confirmed. It records that the goal is
   * over, which is what stops new work being started under it; it does not stop a run that
   * is already going, and an operator who ends a goal expecting the run to halt would be
   * surprised by the run, not by the page.
   *
   * The goal's intents are listed between the objective and the end control, because they
   * are what the goal is *made of* and the end control is what is done to the whole. A run
   * is started from a row of that list; the run box sits under the page (see
   * {@link ComposeBox}).
   *
   * The planner sits between the intents and the briefing, and the order is an argument.
   * "Plan next" is what *produces* intents, so it belongs beside the list it fills rather
   * than at the bottom of the page; the briefing is what the planner is given, so it reads
   * as the evidence behind the control above it rather than as a document in its own right.
   * The end control stays last, because it is what is done to the whole goal.
   *
   * The planner reads as two sections because it is two different kinds of claim.
   * {@link PlanPanel} is the **record**: every round the goal has had, its status, its
   * disposition and its budget, all from rows that survive anything. {@link PlannerChat}
   * under it is the **conversation**: what the round actually said, which this build never
   * stores and which therefore lasts exactly as long as the harness keeps it. Keeping them
   * apart is the same separation the live transcript makes between a record and activity,
   * and it is why a month-old round still shows what it concluded above a chat that says
   * the harness has forgotten its words.
   *
   * The chat is read-only. An operator may stop a round and may not prompt one — see
   * {@link PlannerChat}.
   *
   * The briefing is read-only and is the one section whose content is the server's string
   * verbatim (see {@link GoalBriefingPanel}).
   */
  import Button from "../components/Button.svelte";
  import GoalBriefingPanel from "../components/GoalBriefingPanel.svelte";
  import GoalStatusChip from "../components/GoalStatusChip.svelte";
  import IntentList from "../components/IntentList.svelte";
  import PageFrame from "../components/PageFrame.svelte";
  import PlanPanel from "../components/PlanPanel.svelte";
  import PlannerChat from "../components/PlannerChat.svelte";
  import { countsLine, goalTitle, whenText } from "../goalFormat";
  import type { App } from "../app.svelte";

  let { app }: { app: App } = $props();

  let goal = $derived(app.openGoalView);
  let endedByText = $derived(
    goal?.endedBy === "planner" ? "the planner" : "an operator",
  );
</script>

<PageFrame
  title={goal === undefined ? "Goal" : goalTitle(goal)}
  description={goal === undefined ? "" : `Created ${whenText(goal.createdAt)}`}
>
  {#snippet actions()}
    <Button variant="quiet" onclick={() => app.closeGoal()}>All goals</Button>
  {/snippet}

  {#snippet body()}
    {#if goal === undefined}
      <p class="quiet" role="status">
        This goal is not in the open target's list. It may belong to another
        target, or the list has not been read yet.
      </p>
    {:else}
      <article class="goal">
        <div class="status-row">
          <GoalStatusChip status={goal.status} />
          <span class="counts">{countsLine(goal.counts)}</span>
        </div>

        <section aria-labelledby="goal-objective-heading">
          <h2 id="goal-objective-heading">Objective</h2>
          <p class="objective">{goal.description}</p>
        </section>

        {#if goal.name !== ""}
          <section aria-labelledby="goal-name-heading">
            <h2 id="goal-name-heading">Name</h2>
            <p>{goal.name}</p>
          </section>
        {/if}

        <IntentList {app} />

        <PlanPanel {app} />

        <PlannerChat {app} />

        <GoalBriefingPanel {app} />

        {#if goal.status === "active"}
          <section aria-labelledby="goal-end-heading">
            <h2 id="goal-end-heading">End this goal</h2>
            {#if !app.goalEndOpen}
              <p class="hint">
                Ending a goal records that it is over. Nothing new is started
                under it afterwards; a run already going is not stopped.
              </p>
              <div class="actions">
                <Button onclick={() => app.openGoalEnd()}>End goal</Button>
              </div>
            {:else}
              <form
                class="end"
                onsubmit={(event) => {
                  event.preventDefault();
                  void app.endGoal();
                }}
              >
                <fieldset disabled={app.goalEnding}>
                  <legend>End it as</legend>
                  <label class="choice">
                    <input
                      type="radio"
                      name="goal-end-status"
                      value="met"
                      bind:group={app.goalEndStatus}
                    />
                    <span>
                      <strong>Met</strong>
                      <span class="hint">The objective was established.</span>
                    </span>
                  </label>
                  <label class="choice">
                    <input
                      type="radio"
                      name="goal-end-status"
                      value="abandoned"
                      bind:group={app.goalEndStatus}
                    />
                    <span>
                      <strong>Abandoned</strong>
                      <span class="hint">
                        Stopping without establishing it: out of scope, no
                        longer wanted, or replaced.
                      </span>
                    </span>
                  </label>
                </fieldset>

                <div class="area">
                  <label for="goal-end-reason">Reason (optional)</label>
                  <textarea
                    id="goal-end-reason"
                    rows="3"
                    bind:value={app.goalEndReason}
                    disabled={app.goalEnding}></textarea>
                </div>

                <p class="hint">
                  This records that the goal is over. A run already going under
                  it keeps going until you stop it. An ended goal cannot be
                  reopened.
                </p>

                {#if app.goalEndDetail !== ""}
                  <p class="error" role="alert">{app.goalEndDetail}</p>
                {/if}

                <div class="actions">
                  <Button
                    variant="quiet"
                    disabled={app.goalEnding}
                    onclick={() => app.cancelGoalEnd()}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    type="submit"
                    loading={app.goalEnding}
                  >
                    {app.goalEnding ? "Ending…" : "End goal"}
                  </Button>
                </div>
              </form>
            {/if}
          </section>
        {:else}
          <section aria-labelledby="goal-ended-heading">
            <h2 id="goal-ended-heading">How it ended</h2>
            <dl>
              <dt>Outcome</dt>
              <dd>{goal.status === "met" ? "Met" : "Abandoned"}</dd>
              <dt>Ended</dt>
              <dd>
                {goal.endedAt === null ? "—" : whenText(goal.endedAt)}
                by {endedByText}
              </dd>
              <dt>Reason</dt>
              <dd class={[goal.endReason === "" && "none"]}>
                {goal.endReason === null || goal.endReason === ""
                  ? "No reason was given."
                  : goal.endReason}
              </dd>
            </dl>
            {#if app.goalEndDetail !== ""}
              <!-- Ended in another tab while this page was open: say so, and why. -->
              <p class="hint" role="status">{app.goalEndDetail}</p>
            {/if}
          </section>
        {/if}
      </article>
    {/if}
  {/snippet}
</PageFrame>

<style>
  .quiet {
    margin: 24px 10px;
    font-size: 13px;
    color: var(--text-faint);
  }
  .goal {
    display: flex;
    flex-direction: column;
    gap: 20px;
    max-width: 720px;
    padding: 0 8px;
  }
  .status-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
  }
  .counts {
    font-size: 12px;
    color: var(--text-muted);
  }
  h2 {
    margin: 0 0 6px;
    font: 600 11px/var(--lh-compact) var(--font-sans);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  p {
    margin: 0;
    font-size: 13px;
    line-height: var(--lh-base);
  }
  .objective {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .hint {
    font-size: 12px;
    line-height: var(--lh-compact);
    color: var(--text-muted);
  }
  .actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }
  .end {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  fieldset {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 0;
    padding: 0;
    border: 0;
  }
  legend {
    padding: 0;
    margin-bottom: 8px;
    font: 530 13px/var(--lh-compact) var(--font-sans);
  }
  .choice {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    min-height: 44px;
    padding: 10px 12px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    background: var(--bg-layer-01);
    cursor: pointer;
  }
  .choice:has(input:checked) {
    border-color: var(--border-focus);
  }
  .choice input {
    margin-top: 3px;
  }
  .choice span {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 13px;
  }
  .area {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  label[for] {
    font: 530 13px/var(--lh-compact) var(--font-sans);
  }
  textarea {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    background: var(--bg-layer-01);
    color: var(--text-base);
    font: 400 16px/24px var(--font-sans);
    resize: vertical;
  }
  textarea:disabled {
    opacity: 0.55;
  }
  .error {
    color: var(--state-fg-danger);
    font-size: 12px;
    line-height: var(--lh-compact);
  }
  dl {
    display: grid;
    grid-template-columns: 90px 1fr;
    gap: 8px 12px;
    margin: 0;
    font-size: 13px;
  }
  dt {
    color: var(--text-faint);
  }
  dd {
    margin: 0;
    color: var(--text-base);
    overflow-wrap: anywhere;
  }
  dd.none {
    color: var(--text-muted);
  }
</style>
