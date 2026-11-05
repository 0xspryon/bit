/**
 * A file dropped outside the chat panels (U13 review 2, finding 3): on the title bar, the
 * nav rail, the status bar or a page with no composer, the browser's own drop opened the
 * file in a `file://` tab and left the app. The root layout's window handler refuses such a
 * drag; a panel that took it keeps it, and a drag carrying no files stays the browser's.
 *
 * The layout itself is mounted, with stand-ins for the page around it, and the drag events
 * carry the one property the handlers read (`dataTransfer`), since happy-dom builds none.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createRawSnippet } from "svelte";

import Layout from "../../src/routes/+layout.svelte";
import { mountInto, type Mounted } from "./dom";

let mounted: Mounted[] = [];
afterEach(() => {
  for (const each of mounted) each.destroy();
  mounted = [];
});

const page = createRawSnippet(() => ({
  render: () =>
    `<div class="page"><header class="titlebar">crumb</header><nav class="rail">Goals</nav><section class="panel">chat</section><footer class="statusbar">Live</footer></div>`,
}));

/** A `dragover` then a `drop` on `element`, carrying `types`; each event and its effect. */
const drag = (element: Element, types: readonly string[]) =>
  ["dragover", "drop"].map((kind) => {
    const event = new Event(kind, { bubbles: true, cancelable: true });
    const dataTransfer = {
      types,
      files: [],
      dropEffect: "copy",
    };
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    element.dispatchEvent(event);
    return `${kind}:${String(event.defaultPrevented)}:${dataTransfer.dropEffect}`;
  });

const at = (selector: string): Element => {
  const element = document.querySelector(selector);
  if (element === null) throw new Error(`no ${selector}`);
  return element;
};

describe("a file dragged where no chat panel takes it", () => {
  test("is refused on the title bar, the rail, the status bar and the page: no drop, and the no-drop cursor", () => {
    mounted.push(mountInto(Layout, { children: page }));
    for (const selector of [".titlebar", ".rail", ".statusbar", ".page"]) {
      expect([selector, ...drag(at(selector), ["Files"])]).toEqual([
        selector,
        "dragover:true:none",
        "drop:true:none",
      ]);
    }
  });

  test("a panel that took the drag keeps it, and its own effect", () => {
    mounted.push(mountInto(Layout, { children: page }));
    const panel = at(".panel");
    // What `panelFileDrop` does for a panel that accepts files.
    const take = (event: Event) => {
      event.preventDefault();
      const transfer = (event as DragEvent).dataTransfer;
      if (transfer !== null) transfer.dropEffect = "copy";
    };
    panel.addEventListener("dragover", take);
    panel.addEventListener("drop", take);
    expect(drag(panel, ["Files"])).toEqual([
      "dragover:true:copy",
      "drop:true:copy",
    ]);
  });

  test("a drag carrying no files (text, a link) is left to the browser", () => {
    mounted.push(mountInto(Layout, { children: page }));
    expect(drag(at(".rail"), ["text/plain", "text/uri-list"])).toEqual([
      "dragover:false:copy",
      "drop:false:copy",
    ]);
  });

  test("without the layout, nothing refuses it: the window handler is what does", () => {
    const bare = document.body.appendChild(document.createElement("div"));
    bare.className = "bare";
    try {
      expect(drag(bare, ["Files"])).toEqual([
        "dragover:false:copy",
        "drop:false:copy",
      ]);
    } finally {
      bare.remove();
    }
  });
});
