/**
 * The drawing half of a flow figure: `pele` and a private DOMPurify. Loaded only by
 * `peleRenderer` in `diagram.ts`, the first time a closed mermaid fence is drawn, so
 * neither library is in a bundle that never draws one.
 *
 * ## Why the SVG is sanitised again
 *
 * `pele` escapes label text and is mounted with links, images and zoom off. Its SVG is
 * still put into the page as markup, and its source is an agent's fence, which in the
 * importer is a program page's words. So what it produces is treated as untrusted too and
 * passes {@link sanitizeDiagramSvg} before it is in the document: anything that could
 * navigate, run script or fetch from elsewhere is removed even if the renderer let it
 * through. OpenCode skips this pass; T3 Code has it, and this is the same configuration
 * plus one hook.
 */
import DOMPurify, { type WindowLike } from "dompurify";
import type { DiagramType, Mounted } from "pele/lazy";

import type { DiagramEvents } from "./diagram";

type Purifier = ReturnType<typeof DOMPurify>;
/** One private instance per window: the page's, or a test's. */
const purifiers = new WeakMap<WindowLike, Purifier>();

/**
 * A `url(…)` that points anywhere but into the same SVG. `url(#arrow)` is how a marker or a
 * gradient is referenced and stays; `url(https://…)` in a `style` or a `fill` is a fetch
 * the moment the figure is drawn, telling a page author when it was read.
 */
const FOREIGN_URL = /url\s*\(\s*(?!['"]?#)/i;

/**
 * Two more ways a value could reach a URL past {@link FOREIGN_URL}, dropped as defence in
 * depth (U12 review): a CSS escape, `u\72l(…)`, which spells `url(` without the letters,
 * and `image-set(…)`, which loads an image from a bare string. Neither is exploitable
 * today — pele rejects both — and no figure pele draws needs a backslash in an attribute.
 */
const ESCAPED_OR_IMAGE_SET = /\\|image-set\s*\(/i;

/**
 * The private instance, built on first use with its one hook: an attribute whose value
 * reaches outside the SVG through `url(…)`, or holds a backslash or an `image-set(…)`, is
 * removed. A private instance, because a hook
 * on the global DOMPurify would apply to every other caller in the page.
 *
 * **An instance that is not supported is refused.** DOMPurify built over a window it
 * cannot work in reports `isSupported: false` and then hands its input back unsanitised;
 * a figure is not worth that, so it fails instead, and the frame shows the source.
 */
const purify = (view: WindowLike): Purifier => {
  const kept = purifiers.get(view);
  if (kept !== undefined) return kept;
  const made = DOMPurify(view);
  if (!made.isSupported) {
    throw new Error("The diagram sanitiser cannot run in this browser.");
  }
  made.addHook("uponSanitizeAttribute", (_node, data) => {
    if (
      FOREIGN_URL.test(data.attrValue) ||
      ESCAPED_OR_IMAGE_SET.test(data.attrValue)
    ) {
      data.keepAttr = false;
    }
  });
  purifiers.set(view, made);
  return made;
};

/**
 * A diagram's SVG, as the nodes that may go into the page.
 *
 * - `USE_PROFILES: { svg, svgFilters }` — SVG and its filters, and no HTML: nothing in a
 *   figure is a form, a frame or a script.
 * - `FORBID_TAGS: a, image, foreignObject, style` — a link to follow, an image to fetch, an
 *   HTML island inside the SVG, and a style sheet that could restyle the page around it.
 * - `FORBID_ATTR: href, xlink:href, src, srcset` — the attributes that load or navigate,
 *   whatever element carries them (`<use href>`, `<feImage>`).
 * - Event handlers (`onclick`, `onload`) and `javascript:` URLs are DOMPurify's defaults.
 *
 * Accepted for V1: a fence can restyle its own figure (`style X fill:#f00,font-size:400px`),
 * and what it draws stays clipped inside the SVG and its frame.
 */
export const sanitizeDiagramSvg = (
  svg: string,
  view: WindowLike = window,
): DocumentFragment =>
  purify(view).sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["a", "image", "foreignObject", "style"],
    FORBID_ATTR: ["href", "xlink:href", "src", "srcset"],
    RETURN_DOM_FRAGMENT: true,
  });

type Pele = typeof import("pele/lazy");
let core: Promise<Pele> | undefined;
/** One load per diagram type: a thread with one flowchart fetches only the flowchart. */
const types = new Map<DiagramType, Promise<boolean>>();

const message = (error: unknown): string =>
  error instanceof Error && error.message !== ""
    ? error.message
    : "The diagram could not be drawn.";

/**
 * Draws `source` into `into`, and returns what takes it away again. `source` has already
 * had its hidden characters written out (`diagramSource`).
 *
 * `autoDirection: false` keeps the direction the agent wrote: a wide figure scales down to
 * the thread instead of turning on its side.
 */
export const drawDiagram = (
  into: HTMLElement,
  source: string,
  events: DiagramEvents,
): (() => void) => {
  let gone = false;
  let mounted: Mounted | undefined;
  void (async () => {
    core ??= import("pele/lazy");
    let pele: Pele;
    try {
      pele = await core;
    } catch {
      core = undefined;
      events.failed("The diagram renderer could not be loaded.");
      return;
    }
    let type: DiagramType | null;
    try {
      type = pele.detectType(source);
    } catch (error) {
      events.failed(message(error));
      return;
    }
    if (type === null) {
      events.failed("This is not a kind of diagram the renderer knows.");
      return;
    }
    let load = types.get(type);
    if (load === undefined) {
      load = pele.load(type);
      types.set(type, load);
    }
    const loaded = await load.catch(() => false);
    if (!loaded) {
      types.delete(type);
      events.failed("The diagram renderer could not be loaded.");
      return;
    }
    if (gone) return;
    try {
      purify(window);
    } catch (error) {
      events.failed(message(error));
      return;
    }
    mounted = pele.mount(into, source, {
      links: false,
      images: false,
      zoom: false,
      autoDirection: false,
      sanitize: (svg) => sanitizeDiagramSvg(svg),
      onRender: () => events.rendered(),
      onError: (error) => events.failed(message(error)),
    });
  })();
  return () => {
    gone = true;
    mounted?.destroy();
  };
};
