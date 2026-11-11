<script lang="ts">
  /**
   * Run the intent the operator has aimed it at, and stop the run that is going.
   *
   * **It is not a chat box, and the difference is the whole design.** Submitting does not
   * add a message to a conversation; it starts an *attempt* — a durable row with its own
   * identity, its own credential and its own place in the target's event log. So there is
   * one of them at a time per target, the control flips to Stop while it runs, and nothing
   * here pretends to show what the agent is doing.
   *
   * **There is nothing to type, and that is the change.** A run claims an intent that
   * already exists, and the prompt the worker receives is that intent's question. So the
   * box shows the question it is about to send — read-only, as a quotation — instead of a
   * field, and the only inputs left are the ones that are really the operator's to give:
   * which harness, which model, and whether to go. "Run this intent" on a row of the goal's
   * list is what puts an intent here ({@link IntentList}); with nothing aimed at and no run
   * going, the box renders nothing at all rather than a control with no subject.
   *
   * **There is deliberately no *live* transcript.** The run narrates — the server publishes
   * every step of it onto an in-process bus — and nothing subscribes yet; the stream is
   * Day 6's. What a *settled* attempt left behind is readable, and that is a different
   * thing: {@link TranscriptPanel} asks the harness for its own log of the session, and the
   * server keeps no copy. What this box shows while a run is going is still the honest
   * minimum: that it is going, how long it has been going, and the attempt it is going
   * under.
   *
   * **The harness and the model are chosen here.** {@link HarnessPicker} is a popover on
   * this row, which is why it is here rather than in the shell: the choice belongs to the
   * thing being submitted, and it must not disturb the Level 2 frame behind it.
   *
   * **The elapsed time is a fact about the request, not a deadline.** Nothing counts down
   * and nothing settles when it runs out: settlement is the harness's to decide
   * (DECISIONS.md §5), and a progress bar would be an invented estimate of something
   * genuinely unbounded.
   *
   * ## One box, with the controls inside it
   *
   * The arrangement is OpenCode's composer (MIT), measured rather than approximated: a
   * single bordered container, the text filling it, and a 44px control strip along the
   * bottom *inside* the same border — `+` and the model selector from the left, the
   * submit arrow in a 28px square against the right edge. The numbers that carry the
   * look are in the style block with the OpenCode measurement each one came from.
   *
   * What was deliberately **not** taken is everything above the geometry. OpenCode's
   * composer is coloured — an accent submit, syntax colours on mentions, a provider
   * glyph per model — and this app is monochrome by decision: colour here means state,
   * and a composer is not a state. So the submit is `--bg-inverse` on `--text-inverse`
   * like every other primary action in {@link Button}, the radii come from our scale
   * (10px, not their 12px), and the type is ours. Their drag-and-drop, slash-command
   * popover, shell mode, mention parsing, attachment rail and queue/steer delivery are
   * features rather than shape, and this composer has none of them. (The chats have some
   * of their own: files dropped, pasted or picked into a tray in the importer's and a
   * goal's composer, A6 U13's `ComposerTray`, and steer and queue for a message sent
   * while the agent works.)
   *
   * ## One control with nothing behind it
   *
   * `+` is rendered, positioned, and unavailable. A **run** takes no attachment — files
   * go with a chat message, never with a run: a run carries an intent, and optionally
   * which harness and which model (`RunDraft` in `@bit/contracts`). Rendering it as a
   * live control would be a promise nothing keeps, and leaving it out would make the composer's shape a lie about
   * what is coming — so it is here, dimmed, with the reason readable by pointer and by
   * screen reader.
   *
   * **Reasoning depth is not one of these.** It started as a second dead control and is
   * now real: it is a `select` option a model reports, it reaches the harness, and it
   * lives in {@link HarnessPicker}'s third column because it is a setting *of the model*
   * rather than of the composer — see that component's header.
   *
   * `+` is `aria-disabled` rather than `disabled`, which is the same choice the picker
   * makes for an unusable harness instance: the row stays visible, stays reachable, and
   * carries the sentence that says why. A `disabled` attribute would take it out of the
   * tab order and — in Chrome — suppress the `title` tooltip along with every other
   * pointer event, so the reason would be unreadable by exactly the two routes it has to
   * be readable by. Nothing is wired to it, so activating it does nothing at all.
   */
  import Button from "./Button.svelte";
  import HarnessPicker from "./HarnessPicker.svelte";
  import { IconArrowUp, IconPlus } from "../icons";
  import { notRunnableBecause, suggestionText } from "../goalFormat";
  import type { App } from "../app.svelte";
  import { modelNameIn } from "../modelNames";

  let { app }: { app: App } = $props();

  /**
   * Why the one placeholder control will not do anything, in the product's own terms.
   *
   * It reads as a fact about this server rather than as an apology, and it names the
   * thing that is missing: an operator who reads it knows there is nothing to look for.
   */
  const attachUnavailable =
    "Attachments are not supported yet: a run carries the intent's question and nothing else.";

  /**
   * A ticking clock, so the elapsed time is live rather than frozen at render.
   *
   * `$effect` with a cleanup, which is what makes this correct under Svelte 5: the
   * interval is started when the component mounts and cleared when it unmounts, so a
   * closed target does not leave a timer behind. One second is as often as a value in
   * whole seconds can change.
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

  let running = $derived(app.activeRun);
  let elapsed = $derived(
    running === undefined
      ? ""
      : formatElapsed(Math.max(0, now - running.startedAt)),
  );
  /**
   * Whether this target can be run against at all.
   *
   * A target that will not open cannot be written to, so offering a box that submits into
   * a refusal would be worse than showing the refusal the header already carries.
   */
  let ready = $derived(app.viewState === "ready");
  /**
   * Whether the harness the operator picked will take a run.
   *
   * Read off the picker's own answer rather than guessed: an instance that is configured
   * and unusable is *visible* and not *ready*, and submitting into it would produce a
   * refusal the server has already told us about. The sentence under the box says which,
   * so the disabled button is never unexplained.
   */
  let harnessReady = $derived(app.pickedInstance?.ready === true);
  /** The intent being aimed at, with the status the server last gave it. */
  let intent = $derived(app.runIntent);
  /**
   * Why this intent cannot be run right now, or `null`.
   *
   * The list row's own function, so the row and the box cannot disagree about whether an
   * intent is runnable: an intent another tab has since started, or whose goal has just
   * ended, reads that way here instead of offering a run the server will refuse.
   */
  let blocked = $derived(
    intent === undefined
      ? null
      : notRunnableBecause(intent, app.openGoalView?.status),
  );
  let suggested = $derived(
    intent === undefined
      ? null
      : suggestionText(intent.suggestion, (instanceId, model) =>
          modelNameIn(app.harnesses, { instanceId }, model),
        ),
  );
  let canSubmit = $derived(
    ready &&
      harnessReady &&
      running === undefined &&
      !app.starting &&
      intent !== undefined &&
      blocked === null,
  );
  /**
   * Why the box will not submit, when the reason is the harness rather than the text.
   *
   * The picked instance's own reason when there is one, the server's "nothing configured"
   * when there is not. Never a generic "cannot run": a refusal an operator cannot act on
   * is the thing this product keeps refusing to render.
   */
  let harnessNote = $derived(
    harnessReady
      ? ""
      : app.harnesses.length === 0
        ? "This server configures no agent harness, so it will refuse every run."
        : (app.pickedInstance?.reason ??
          "The harness this run would use is not usable on this server."),
  );

  function formatElapsed(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${String(seconds)}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`;
    return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
  }
</script>

{#if running !== undefined || intent !== undefined || app.runFallback !== null || app.runDetail !== ""}
  <section class="compose" aria-label="Run an intent">
    {#if running !== undefined}
      <div class="status" role="status">
        <span class="pulse" aria-hidden="true"></span>
        <span class="status-text">
          Running for <strong>{elapsed}</strong>
        </span>
        <span class="attempt mono" title="Attempt {running.attemptId}">
          {running.attemptId}
        </span>
        <Button
          size="sm"
          variant="danger"
          loading={app.stopping}
          onclick={() => void app.stopRun()}
        >
          Stop
        </Button>
      </div>
      <p class="note">
        This run is going on the server, not in this tab — closing it will not
        stop the agent. Stopping settles the attempt and withdraws its write
        authority.
      </p>
      {#if app.runFallback !== null}
        <!--
          A suggestion that could not be honoured, said once the run exists. The run went
          ahead on the default and this is why; nothing about it is hidden in a log.
        -->
        <p class="note" role="status">
          The intent suggested <strong>{app.runFallback.requested}</strong>,
          which could not be used ({app.runFallback.reason}). This run is on
          <strong>{app.runFallback.ranOn}</strong> instead.
        </p>
      {/if}
    {:else if intent !== undefined}
      <!--
        One container. The prompt is a quotation and not a field, and the strip has no
        background of its own: the border below belongs to the box, and everything inside
        it reads as one control. `overflow` is deliberately not clipped here — the harness
        picker's popover rises out of the strip, and clipping the box would cut it off.
      -->
      <div class="box">
        <div class="prompt">
          <span class="prompt-label">Run this intent</span>
          <blockquote class="question">{intent.question}</blockquote>
          {#if suggested !== null}
            <p class="note">
              This intent suggests <strong>{suggested}</strong>. Unless you pick
              a harness below, the run goes there; if that cannot be used, the
              server's default runs instead and the run says so.
            </p>
          {/if}
        </div>

        <div class="strip">
          <div class="strip-controls">
            <!--
              Rendered, positioned, and honest about being unavailable: the sentence is the
              `title` for a pointer and the accessible description for a screen reader, and
              the control keeps its place in the tab order so both routes reach it.
            -->
            <button
              class="square ghost unavailable"
              type="button"
              aria-disabled="true"
              aria-label="Attach a file"
              aria-describedby="compose-attach-why"
              title={attachUnavailable}
            >
              <IconPlus width="13" height="13" />
            </button>
            <span id="compose-attach-why" class="visually-hidden"
              >{attachUnavailable}</span
            >

            <!--
              Reasoning depth is not a control here. It is the picker's third column: it is
              a setting *of the model*, so it belongs where the model is chosen and has to
              change when the model does. A separate strip control would have had to be
              cleared, restored and relabelled in step with this one anyway.
            -->
            <HarnessPicker {app} />
          </div>

          <Button
            size="sm"
            variant="quiet"
            disabled={app.starting}
            onclick={() => app.clearRunChoice()}
          >
            Cancel
          </Button>
          <button
            class="square submit"
            type="button"
            disabled={!canSubmit}
            aria-label="Start run"
            title="Start run"
            onclick={() => void app.startRun()}
          >
            {#if app.starting}
              <span class="spinner" aria-hidden="true"></span>
            {:else}
              <IconArrowUp width="14" height="14" />
            {/if}
          </button>
        </div>
      </div>
      {#if blocked !== null}
        <p class="note" role="status">{blocked}</p>
      {/if}
    {/if}

    {#if harnessNote !== "" && running === undefined && intent !== undefined}
      <!--
        Not `role="alert"`: this is a standing condition of the server rather than a response
        to something the operator just did, and announcing it on every repaint would be
        noise. The refusal below *is* an alert, because it is an answer.
      -->
      <p class="note">{harnessNote}</p>
    {/if}

    {#if app.runDetail !== ""}
      <p class="refusal" role="alert">{app.runDetail}</p>
    {/if}
  </section>
{/if}

<style>
  .compose {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--border-base);
    background: var(--bg-layer-01);
  }

  /**
   * The box. OpenCode: `rounded-xl` on a 12px scale; ours tops out at 10px, which is the
   * token rather than their number because the radius is part of the design language and
   * the proportion is what was borrowed. No explicit minimum height: the field's 60px
   * floor and the strip's 44px already set it, which is also true of OpenCode's inert
   * `min-h-[96px]`.
   */
  .box {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-xl);
    background: var(--bg-base);
    transition:
      border-color var(--dur-hover) ease-out,
      box-shadow var(--dur-hover) ease-out;
  }
  /*
    The focus ring is the box's, not the textarea's: an outline drawn inside a border
    1px away from it reads as a mistake. Border and ring together, so the indicator
    survives a forced-colours or high-contrast rendering of one of them.
  */
  .box:focus-within {
    border-color: var(--border-focus);
    box-shadow: 0 0 0 1px var(--border-focus);
  }

  /**
   * The prompt the run will send, as a quotation. OpenCode's composer gives its text field
   * `px-4 pt-4 pb-2` (16px sides, 16px above, 8px below), so the same padding keeps the box
   * the shape it was; the 180px cap and the scroll are for a long question, which is
   * ordinary.
   */
  .prompt {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-height: 60px;
    padding: 16px 16px 8px;
  }
  .prompt-label {
    font: 600 11px/var(--lh-compact) var(--font-sans);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .question {
    margin: 0;
    max-height: 180px;
    overflow-y: auto;
    color: var(--text-base);
    font: 400 13px/var(--lh-base) var(--font-sans);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  /**
   * The control strip, inside the same border. OpenCode: `h-11 items-center px-2` — 44px
   * tall, 8px from each edge — with 4px between the controls on the left and 12px of
   * clear space (`me-3`) before the submit button.
   */
  .strip {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 44px;
    padding: 0 8px;
  }
  .strip-controls {
    display: flex;
    flex: 1;
    min-width: 0;
    align-items: center;
    gap: 4px;
  }

  /* 28px square, 6px radius: OpenCode's `size-7 rounded-md`, and their large icon button. */
  .square {
    display: inline-flex;
    width: 28px;
    height: 28px;
    flex: none;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    border-radius: var(--radius-md);
    cursor: pointer;
    transition:
      background var(--dur-hover) ease-out,
      opacity var(--dur-hover) ease-out;
  }
  .ghost {
    background: transparent;
    color: var(--icon-muted);
  }
  .ghost:hover:not(.unavailable) {
    background: var(--overlay-hover);
    color: var(--icon-base);
  }
  /*
    Visibly unavailable: dimmed to the same degree as a disabled Button, and the cursor
    says so before the tooltip arrives. Still focusable, still readable — see the note at
    the top for why that is `aria-disabled` and not `disabled`.
  */
  .unavailable {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /*
    Monochrome primary, exactly as `Button`'s: a light fill on dark and the reverse on
    light. OpenCode's submit is an accent colour, which is the one thing about it that
    could not come across.
  */
  .submit {
    background: var(--bg-inverse);
    color: var(--text-inverse);
  }
  .submit:hover:not(:disabled) {
    opacity: 0.88;
  }
  .submit:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .status {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .status-text {
    font-size: 13px;
    color: var(--text-base);
  }
  .attempt {
    flex: 1;
    min-width: 0;
    font-size: 11px;
    color: var(--text-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pulse {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent-base, currentColor);
    animation: pulse 1.6s ease-in-out infinite;
  }
  /* Respects a reduced-motion preference: the dot is still there, it just stops. */
  @media (prefers-reduced-motion: reduce) {
    .pulse {
      animation: none;
    }
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.35;
    }
  }
  /* The same spinner as `Button`'s, because this is the same waiting. */
  .spinner {
    width: 13px;
    height: 13px;
    border: 1.5px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 700ms linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .note,
  .refusal {
    margin: 0;
    font-size: 11px;
    line-height: var(--lh-base);
  }
  .note {
    color: var(--text-faint);
  }
  .refusal {
    color: var(--state-fg-danger);
  }
</style>
