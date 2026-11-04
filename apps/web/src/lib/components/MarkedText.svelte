<script lang="ts">
  /**
   * Untrusted plain text, with the characters that would change how it reads written out as
   * `⟨U+202E⟩` markers — the plain-text counterpart of what `markdown.ts` does to a reply.
   *
   * Two rules, the same two the markdown pipeline has:
   *
   * - **prose** (`proseRuns`, the default): every bidi control. A thought, a sub-agent's
   *   task, the operator's own message. The zero-width joiners stay, because they are how
   *   joined scripts are written.
   * - **code** (`codeRuns`): every bidi, zero-width and tag character. A tool call's
   *   signature and result line, a verbatim payload, a ledger line, a transcript entry —
   *   places where the exact characters are the point, as in a fence.
   *
   * Text only: each run is a text node or a marker span with a constant class, so nothing
   * here can become markup. Whitespace is the caller's: inside a `<pre>` it is kept.
   */
  import { codeRuns, proseRuns } from "../markdown";

  let { text, code = false }: { text: string; code?: boolean } = $props();

  let runs = $derived(code ? codeRuns(text) : proseRuns(text));
</script>

{#each runs as run, index (index)}{#if run.escape}<span class="char-escape"
      >{run.text}</span
    >{:else}{run.text}{/if}{/each}

<style>
  /* A marker reads as a note about the text rather than as part of it, as in `Markdown`. */
  .char-escape {
    margin: 0 1px;
    padding: 0 2px;
    border: 1px solid var(--border-muted);
    border-radius: 3px;
    color: var(--text-faint);
    font-size: 0.85em;
    font-style: normal;
    letter-spacing: normal;
    text-transform: none;
    white-space: nowrap;
  }
</style>
