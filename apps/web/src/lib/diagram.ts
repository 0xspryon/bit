/**
 * A flow figure (A6 D8): an agent's ` ```mermaid ` fence, drawn as a diagram in the browser.
 *
 * The fence leaves `markdown.ts` as an ordinary framed code block — the same sanitised
 * string pipeline as every other fence — marked `data-diagram` when it is closed. Only then
 * does `Markdown.svelte` hand its source to `MermaidBlock`, which draws it through
 * {@link DiagramRenderer}. The diagram is never part of the HTML string: it is drawn into
 * the page client-side, from text, by a renderer that escapes labels, with links, images
 * and zoom off, and its SVG goes through a second, private sanitiser (`diagramDraw.ts`)
 * before it is in the document.
 *
 * Nothing here imports the renderer. `pele` and DOMPurify are loaded the first time a
 * closed mermaid fence is drawn ({@link peleRenderer}), so a thread with no diagram never
 * fetches either.
 */
import { codeRuns } from "./markdown";

/**
 * The source handed to the renderer: the fence's text with every bidi, zero-width and tag
 * character written out as its code point, as a fence shows it (`codeRuns`).
 *
 * A label is SVG `<text>`, and SVG text is laid out by the same bidi algorithm as HTML: an
 * isolate and two marks in a label draw `com.acme` as `acme.com` in the figure, as they
 * would in prose (measured in the browser, U12). The renderer cannot draw a boxed marker
 * inside a label, so the marker is the text itself, `⟨U+2067⟩`; a hidden character in the
 * diagram's syntax is then visible syntax, and at worst the figure fails to parse and its
 * source is shown instead.
 */
export const diagramSource = (source: string): string =>
  codeRuns(source)
    .map((run) => run.text)
    .join("");

/** What a drawing reports, once: drawn, or failed with a sentence. */
export interface DiagramEvents {
  readonly rendered: () => void;
  readonly failed: (message: string) => void;
}

/**
 * Draws a diagram's source into an element, and returns what takes it away again.
 *
 * Injected into `MermaidBlock` so its states can be tested without layout; the app's is
 * {@link peleRenderer}.
 */
export type DiagramRenderer = (
  into: HTMLElement,
  source: string,
  events: DiagramEvents,
) => () => void;

/**
 * `pele`, loaded on first use: the drawing module (`diagramDraw.ts`, which brings
 * DOMPurify) and then `pele/lazy`, then the one diagram type the source names. Each load is
 * remembered, and a failed one is forgotten so the next figure tries again.
 */
let drawing: Promise<typeof import("./diagramDraw")> | undefined;
export const peleRenderer: DiagramRenderer = (into, source, events) => {
  let gone = false;
  let stop: (() => void) | undefined;
  drawing ??= import("./diagramDraw");
  drawing.then(
    (module) => {
      if (gone) return;
      stop = module.drawDiagram(into, diagramSource(source), {
        rendered: () => {
          if (!gone) events.rendered();
        },
        failed: (message) => {
          if (!gone) events.failed(message);
        },
      });
    },
    () => {
      drawing = undefined;
      if (!gone) events.failed("The diagram renderer could not be loaded.");
    },
  );
  return () => {
    gone = true;
    stop?.();
  };
};
