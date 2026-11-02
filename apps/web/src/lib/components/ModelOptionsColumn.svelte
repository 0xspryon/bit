<script lang="ts">
  /**
   * The Reasoning column: what the picked *model* offers, rendered into
   * {@link HarnessChoice}'s `options` snippet.
   *
   * What the model offers, which on both harnesses today is how hard it should think. Not a
   * third kind of identity — a session is pinned to an instance and a model, and this is a
   * setting *of* the model — which is why it is a column of the same popover rather than a
   * control of its own on the composer, and why it changes under the model selection rather
   * than beside it.
   *
   * **One column for every picker that sends options.** It was the run composer's markup,
   * inline in `HarnessPicker`; the importer's picker sends options too now (S3.5), and a
   * second copy of the DEFAULT marking, the stale-value rule and the "only what you set is
   * sent" sentence would be free to drift from the first. The *state* stays each caller's —
   * a run's options and an import's are kept apart on `App` — so everything arrives as a
   * prop and the one write goes out through {@link onPick}. `@bit/contracts`'s
   * `modelOption.ts` holds the rules for what is shown and what survives a model change.
   */
  import {
    displayedModelOption,
    type HarnessInstanceView,
    type HarnessModelView,
    type ModelOptionDescriptor,
    type ModelOptionSelection,
  } from "@bit/contracts";

  let {
    instance,
    model,
    modelView,
    descriptors,
    selections,
    dropped,
    onPick,
    subject = "A run",
  }: {
    /** The instance whose model this is, or `undefined` when there is none to choose from. */
    instance: HarnessInstanceView | undefined;
    /** The model id as resolved through the caller's defaults. */
    model: string;
    /** That model's catalogue entry, `undefined` when the instance does not list it. */
    modelView: HarnessModelView | undefined;
    /** What that model can be asked for. Empty for most models. */
    descriptors: readonly ModelOptionDescriptor[];
    /** What the operator has set on that model. Nothing, usually. */
    selections: readonly ModelOptionSelection[];
    /** Selection ids this model has no descriptor for, so they will not be sent. */
    dropped: readonly string[];
    onPick: (descriptorId: string, value: string) => void;
    /** What the model would carry the options into, for the sentences: "A run", "A session". */
    subject?: string;
  } = $props();
</script>

<p class="rail-label">Reasoning</p>

{#if instance === undefined}
  <p class="models-empty">Nothing to choose from.</p>
{:else if modelView === undefined}
  <!--
    A model an operator named that this instance's catalogue does not list. It may still
    run — whether a model runs is the harness's answer — but nothing is known about what it
    offers, and offering controls on a guess is the one thing this column must not do.
  -->
  <p class="models-empty">
    This server's catalogue does not list <span class="mono">{model}</span>, so
    what it offers is unknown. {subject} on it is still the harness's to accept or
    refuse.
  </p>
{:else if descriptors.length === 0}
  <p class="models-empty">
    <span class="mono">{model}</span> offers nothing to choose beyond itself.
  </p>
{:else}
  {#each descriptors as descriptor (descriptor.id)}
    {@const shown = displayedModelOption(descriptor, selections)}
    <p class="option-label">
      {descriptor.label}
      <!--
        The harness's own id for the option, shown rather than hidden: it is what travels
        with the session, and `effort` against `variant` is the difference between the two
        harnesses rather than a detail.
      -->
      <span class="option-id mono">{descriptor.id}</span>
    </p>

    {#if !shown.known}
      <!--
        Rule 4 in `modelOption.ts`: an obsolete value is shown *as itself*, marked unknown,
        and deliberately not relabelled as what would be sent instead. The fallback is stated
        separately so the operator can read both facts instead of inferring one from the
        other.
      -->
      <p class="option-stale">
        <span class="mono">{shown.label}</span> is set here and this model does
        not offer it. {subject} would use this option's default instead.
      </p>
    {/if}

    <ul class="option-list">
      {#each descriptor.options as choice (choice.id)}
        <li>
          <button
            class="option-row"
            class:selected={shown.known && choice.id === shown.value}
            type="button"
            aria-pressed={shown.known && choice.id === shown.value}
            onclick={() => onPick(descriptor.id, choice.id)}
          >
            <span class="option-name">{choice.label}</span>
            {#if choice.isDefault === true}
              <span class="model-tag">default</span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/each}

  {#if dropped.length > 0}
    <!--
      Said out loud rather than dropped quietly. T3Code's version of this resolution has no
      such signal, so a setting that stops applying is indistinguishable from one never
      made; this product loses information loudly or not at all.
    -->
    <p class="option-dropped">
      Not offered by this model, so it will not be sent:
      <span class="mono">{dropped.join(", ")}</span>.
    </p>
  {/if}

  <p class="models-note">
    Only what you set here is sent. A model left on its default is sent nothing,
    so the harness applies its own.
  </p>
{/if}

<style>
  /*
    The third column's own type. The column element and its scrolling belong to
    `HarnessChoice`; everything inside it is here.
  */
  .rail-label {
    margin: 0 0 4px 4px;
    color: var(--text-faint);
    font: 600 11px/var(--lh-compact) var(--font-sans);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .models-empty {
    margin: 0;
    padding: 4px;
    color: var(--text-faint);
    font-size: 11px;
    line-height: var(--lh-compact);
  }
  .option-label {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 6px;
    margin: 6px 0 4px 4px;
    color: var(--text-muted);
    font: 530 11px/var(--lh-compact) var(--font-sans);
  }
  .option-id {
    color: var(--text-faint);
    font-size: 10px;
  }
  .option-list {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .option-row {
    display: flex;
    width: 100%;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    padding: 5px 6px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-base);
    text-align: left;
    cursor: pointer;
    transition: background var(--dur-hover) ease-out;
  }
  .option-row:hover {
    background: var(--overlay-hover);
  }
  .option-row.selected {
    background: var(--overlay-pressed);
  }
  .option-name {
    min-width: 0;
    overflow: hidden;
    font-size: 12px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .model-tag {
    margin-left: 4px;
    color: var(--text-faint);
    font: 400 10px/var(--lh-tight) var(--font-sans);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  /*
    Amber, like an unavailable target's reason: a setting that will not take effect is the
    same kind of fact as a target that will not open, and this app spends colour only on
    state (§9). Never colour alone — both of these say what is wrong in words.
  */
  .option-stale,
  .option-dropped {
    margin: 4px 0 6px;
    padding: 6px 8px;
    border: 1px solid var(--state-border-warning);
    border-radius: var(--radius-sm);
    background: var(--state-bg-warning);
    color: var(--state-fg-warning);
    font-size: 11px;
    line-height: var(--lh-compact);
  }
  .models-note {
    margin: 6px 0 0;
    color: var(--text-faint);
    font-size: 11px;
    line-height: var(--lh-compact);
  }
</style>
