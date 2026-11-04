<script lang="ts">
  /**
   * A closed ` ```mermaid ` fence, drawn as a flow figure (A6 D8, U12): the fence's own
   * frame — its name, a **Show code** / **Show diagram** toggle and **Copy** — over the
   * figure, with the source one toggle away.
   *
   * `Markdown.svelte` mounts this into a `.code-frame[data-diagram]` that `markdown.ts`
   * built, in place of the frame's contents, so it is drawn with the frame's styles and
   * its **Copy** is U10's: the reply's one click listener copies the frame's `pre > code`,
   * which is here whether or not it is shown. A fence that is not closed never reaches
   * this: it stays code.
   *
   * The figure is drawn once per source, by `renderer` (`peleRenderer` in the app, a
   * stand-in in tests), into an element nothing else writes to. If it cannot be drawn the
   * frame says so — "Unable to render diagram", with the renderer's reason — and shows the
   * source, rather than an empty box.
   *
   * Every piece of the agent's text here is drawn as text through `MarkedText`, as code:
   * the name, the source, and the renderer's reason, which can quote the source.
   */
  import { peleRenderer, type DiagramRenderer } from "../diagram";
  import { codeRuns } from "../markdown";
  import MarkedText from "./MarkedText.svelte";

  let {
    source,
    label,
    renderer = peleRenderer,
  }: {
    /** The fence's code as the agent wrote it, without the newline before its closer. */
    source: string;
    /** The fence's name as the agent wrote it: its info string after the language. */
    label: string;
    renderer?: DiagramRenderer;
  } = $props();

  let showCode = $state(false);
  /** The renderer's reason, once a drawing has failed; `null` while none has. */
  let failure: string | null = $state(null);

  /** The name with its hidden characters written out, for the button's accessible name. */
  let copyLabel = $derived(
    `Copy ${codeRuns(label)
      .map((run) => run.text)
      .join("")}`,
  );

  /**
   * The figure's element, drawn into by the renderer. Re-run only when the source or the
   * renderer changes — not on a toggle, which only hides it — so a figure is drawn once.
   */
  const draw = (into: HTMLElement): (() => void) => {
    failure = null;
    return renderer(into, source, {
      rendered: () => {
        failure = null;
      },
      failed: (message) => {
        failure = message;
      },
    });
  };
</script>

<div class="code-head">
  <span class="code-label"><MarkedText text={label} code /></span>
  <button
    type="button"
    class="code-view"
    aria-pressed={showCode}
    onclick={() => (showCode = !showCode)}
    >{showCode ? "Show diagram" : "Show code"}</button
  >
  <button type="button" class="code-copy" aria-label={copyLabel}>Copy</button>
</div>
{#if failure !== null && !showCode}
  <!--
    The renderer's reason is its own lines — the failing line, then a caret under the place
    it failed — so it keeps them, in mono, where the caret lines up.
  -->
  <div class="diagram-error" role="status">
    <p>Unable to render diagram:</p>
    <p class="reason"><MarkedText text={failure} code /></p>
  </div>
{/if}
<div class="diagram" hidden={showCode || failure !== null} {@attach draw}></div>
<pre data-language="mermaid" hidden={!showCode && failure === null}><code
    class="language-mermaid"><MarkedText text={source} code /></code
  ></pre>

<style>
  /*
   * The figure, in bit's tokens rather than pele's defaults, and in one ink: a flow figure
   * says how things sit relative to each other, and colour would be a claim it does not
   * make. The variables are read by the SVG where it is drawn, so a theme change recolours
   * it without a redraw.
   */
  .diagram {
    /* The frame's own ground, so an edge's label box hides the line under it. */
    --pele-bg: var(--bg-deep);
    --pele-fg: var(--text-base);
    --pele-muted: var(--text-muted);
    --pele-line: var(--text-muted);
    --pele-surface: var(--bg-layer-01);
    --pele-surface-alt: var(--bg-layer-02);
    --pele-border: var(--border-strong);
    --pele-accent: var(--text-base);
    --pele-critical: var(--text-base);
    --pele-series-1: var(--text-base);
    --pele-series-2: var(--text-muted);
    --pele-series-3: var(--text-faint);
    --pele-series-4: var(--icon-base);
    --pele-series-5: var(--bg-layer-03);
    --pele-series-6: var(--icon-faint);
    --pele-series-7: var(--border-strong);
    --pele-series-8: var(--bg-layer-02);
    --pele-font: var(--font-sans);
    --pele-radius: var(--radius-sm);
    /*
     * A figure is at most 640px tall, and scrolls inside its frame past that. A reply's
     * figure is the agent's, and a 3,000-node chain drew 288,064px tall (U12 review): the
     * thread is the operator's, and no one figure may take it over. Items are not stretched,
     * so a short figure keeps its own height.
     */
    display: flex;
    align-items: flex-start;
    justify-content: center;
    max-height: 640px;
    overflow: auto;
    overscroll-behavior: contain;
    padding: 12px 14px;
  }
  .diagram[hidden] {
    display: none;
  }
  .diagram :global(svg) {
    max-width: 100%;
    height: auto;
  }
  .diagram-error {
    padding: 10px 14px 0;
    color: var(--state-fg-danger);
    font: 400 12px/18px var(--font-sans);
  }
  .diagram-error p {
    margin: 0;
  }
  .diagram-error .reason {
    overflow-x: auto;
    font: 400 11px/16px var(--font-mono);
    white-space: pre;
  }
  .code-view {
    flex: none;
    height: 22px;
    padding: 0 8px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--text-muted);
    font: 400 11px/16px var(--font-sans);
    cursor: pointer;
    transition:
      background var(--dur-hover) ease-out,
      color var(--dur-hover) ease-out;
  }
  .code-view:hover {
    background: var(--overlay-hover);
    color: var(--text-base);
  }
  .code-view:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: -2px;
  }
</style>
