/**
 * A flow figure, drawn (A6 U12).
 *
 * Three things are checked here, none of them layout — happy-dom has none, and the figure's
 * geometry is measured in a browser:
 *
 * - `MermaidBlock`'s states, against a stand-in renderer: drawn once, an error that says so
 *   and shows the source, the Show code / Show diagram toggle, and Copy.
 * - `Markdown` hands a closed fence, and only a closed fence, to the renderer — with
 *   `pele/lazy` mocked, so the real `diagramDraw.ts` and its sanitiser run on what the
 *   stand-in draws.
 * The sanitiser itself is fed a hostile SVG in `test/diagramSanitiser.test.ts`, over jsdom:
 * happy-dom's parser cannot judge one (it drops an inline `<svg>` and keeps what DOMPurify
 * removed), and it also repeats the text before a `-->` in parsed HTML, which is why no
 * source here draws an edge with one.
 *
 * Compared as strings — `textContent`, `innerHTML` — never as nodes.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { flushSync, mount, unmount } from "svelte";
import { compile } from "svelte/compiler";

import Markdown from "../../src/lib/components/Markdown.svelte";
import MermaidBlock from "../../src/lib/components/MermaidBlock.svelte";
import type { DiagramEvents, DiagramRenderer } from "../../src/lib/diagram";

import { click, mountInto, settle, type Mounted } from "./dom";
import GrowingReply from "./fixtures/GrowingReply.svelte";

/*
 * `pele/lazy`, as a stand-in: what it is asked to draw, and an SVG of the source's text.
 * A source with `broken` in it fails, as a syntax error does.
 */
const peleCalls: { source: string; options: Record<string, unknown> }[] = [];
const detected: string[] = [];
void mock.module("pele/lazy", () => ({
  detectType: (source: string) => {
    detected.push(source);
    return source.startsWith("sequenceDiagram") ? "sequence" : "flowchart";
  },
  load: () => Promise.resolve(true),
  mount: (
    element: HTMLElement,
    source: string,
    options: {
      sanitize: unknown;
      onRender: () => void;
      onError: (error: unknown) => void;
    },
  ) => {
    peleCalls.push({ source, options });
    if (source.includes("broken")) {
      options.onError(new Error("Parse error on line 2: broken"));
    } else {
      const figure = document.createElement("figure");
      figure.textContent = `drawn: ${source}`;
      element.replaceChildren(figure);
      options.onRender();
    }
    return { destroy: () => undefined };
  },
}));

let mounted: Mounted[] = [];
afterEach(() => {
  for (const each of mounted) each.destroy();
  mounted = [];
  peleCalls.length = 0;
  detected.length = 0;
});

const FLOW = "flowchart LR\n  P[Partner portal] ---|links to| S[acme.com]";

/** A renderer that does what it is told, and records each drawing. */
const standIn = (): {
  renderer: DiagramRenderer;
  draws: { into: HTMLElement; source: string; events: DiagramEvents }[];
  stopped: number;
} => {
  const made = {
    draws: [] as { into: HTMLElement; source: string; events: DiagramEvents }[],
    stopped: 0,
    renderer: ((into, source, events) => {
      made.draws.push({ into, source, events });
      return () => {
        made.stopped += 1;
      };
    }) as DiagramRenderer,
  };
  return made;
};

const block = (props: {
  source: string;
  label?: string;
  renderer: DiagramRenderer;
}): HTMLElement => {
  const one = mountInto(MermaidBlock, { label: "mermaid", ...props });
  mounted.push(one);
  return one.target;
};

const visible = (node: Element | null): boolean =>
  node !== null && !node.hasAttribute("hidden");

describe("a flow figure's frame", () => {
  test("draws the source once, with the code hidden, and Show code shows it", async () => {
    const stand = standIn();
    const root = block({ source: FLOW, renderer: stand.renderer });
    expect(stand.draws).toHaveLength(1);
    expect(stand.draws[0]?.source).toBe(FLOW);
    stand.draws[0]?.into.append("drawn");
    stand.draws[0]?.events.rendered();
    await settle();

    const diagram = root.querySelector(".diagram");
    const pre = root.querySelector("pre");
    const toggle = root.querySelector<HTMLButtonElement>("button.code-view");
    expect(visible(diagram)).toBe(true);
    expect(visible(pre)).toBe(false);
    expect(diagram?.textContent).toBe("drawn");
    expect(toggle?.textContent).toBe("Show code");
    expect(toggle?.getAttribute("aria-pressed")).toBe("false");

    if (toggle === null) throw new Error("no toggle");
    click(toggle);
    await settle();
    expect(visible(diagram)).toBe(false);
    expect(visible(pre)).toBe(true);
    expect(pre?.textContent).toBe(FLOW);
    expect(toggle.textContent).toBe("Show diagram");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    click(toggle);
    await settle();
    expect(visible(diagram)).toBe(true);
    expect(diagram?.textContent).toBe("drawn");
    // Toggling hides and shows the same figure: it is not drawn again.
    expect(stand.draws).toHaveLength(1);
    expect(stand.stopped).toBe(0);
  });

  test("a figure that cannot be drawn says so, with the reason and the source", async () => {
    const stand = standIn();
    const root = block({
      source: "flowchart LR\n  A ---",
      renderer: stand.renderer,
    });
    stand.draws[0]?.events.failed("Parse error on line 2 near \u202Eacme");
    await settle();
    const error = root.querySelector(".diagram-error");
    expect(error?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "Unable to render diagram: Parse error on line 2 near ⟨U+202E⟩acme",
    );
    expect(visible(root.querySelector(".diagram"))).toBe(false);
    const pre = root.querySelector("pre");
    expect(visible(pre)).toBe(true);
    expect(pre?.textContent).toBe("flowchart LR\n  A ---");

    // Show code is the source alone; Show diagram is the error and the source again.
    const toggle = root.querySelector<HTMLButtonElement>("button.code-view");
    if (toggle === null) throw new Error("no toggle");
    click(toggle);
    await settle();
    expect(root.querySelector(".diagram-error")).toBeNull();
    expect(visible(root.querySelector("pre"))).toBe(true);
    click(toggle);
    await settle();
    expect(root.querySelector(".diagram-error")).not.toBeNull();
  });

  test("its name and source are marked as code, and Copy names the fence", () => {
    const stand = standIn();
    const root = block({
      source: "flowchart LR\n  A[ac\u200Bme.com]",
      label: "portal\u202E.mmd",
      renderer: stand.renderer,
    });
    expect(root.querySelector(".code-label")?.textContent).toBe(
      "portal⟨U+202E⟩.mmd",
    );
    expect(root.querySelector("pre")?.textContent).toBe(
      "flowchart LR\n  A[ac⟨U+200B⟩me.com]",
    );
    expect(
      root.querySelector("button.code-copy")?.getAttribute("aria-label"),
    ).toBe("Copy portal⟨U+202E⟩.mmd");
  });

  test("is at most 640px tall, and scrolls inside its frame past that", async () => {
    // A 3,000-node chain drew 288,064px tall (U12 review). happy-dom has no layout, so the
    // rule is read from the component's own compiled style; the browser check measures it.
    const path = new URL(
      "../../src/lib/components/MermaidBlock.svelte",
      import.meta.url,
    ).pathname;
    const { css } = compile(await Bun.file(path).text(), {
      filename: path,
      generate: "client",
      css: "external",
      dev: true,
    });
    const sheet = document.createElement("style");
    sheet.textContent = css?.code ?? "";
    document.head.append(sheet);
    try {
      const stand = standIn();
      const root = block({ source: FLOW, renderer: stand.renderer });
      const style = getComputedStyle(root.querySelector(".diagram") ?? root);
      expect(`${style.maxHeight} ${style.overflow} ${style.alignItems}`).toBe(
        "640px auto flex-start",
      );
    } finally {
      sheet.remove();
    }
  });

  test("is taken away with its drawing", () => {
    const stand = standIn();
    block({ source: FLOW, renderer: stand.renderer });
    for (const each of mounted) each.destroy();
    mounted = [];
    expect(stand.stopped).toBe(1);
  });
});

describe("a reply with a mermaid fence", () => {
  const reply = (text: string): HTMLElement => {
    const one = mountInto(Markdown, { text });
    mounted.push(one);
    return one.target;
  };
  /** Until the lazily imported drawing module has drawn. */
  const drawn = async (root: HTMLElement): Promise<void> => {
    for (let tries = 0; tries < 50; tries += 1) {
      await settle();
      if (
        root.querySelector(".diagram figure") !== null ||
        root.querySelector(".diagram-error") !== null
      ) {
        return;
      }
    }
  };

  test("draws a closed fence through pele, with a sanitiser, and links, images and zoom off", async () => {
    const root = reply(
      `How the portal sits:\n\n\`\`\`mermaid\n${FLOW}\n\`\`\`\n`,
    );
    await drawn(root);
    expect(peleCalls).toHaveLength(1);
    expect(peleCalls[0]?.source).toBe(FLOW);
    expect(peleCalls[0]?.options).toMatchObject({
      links: false,
      images: false,
      zoom: false,
    });
    expect(typeof peleCalls[0]?.options["sanitize"]).toBe("function");
    expect(root.querySelector(".diagram figure")?.textContent).toBe(
      `drawn: ${FLOW}`,
    );
    expect(root.querySelector(".code-frame .code-label")?.textContent).toBe(
      "mermaid",
    );
  });

  test("an unclosed fence — a reply cut mid-stream — stays code, and pele is not asked", async () => {
    const root = reply(`How the portal sits:\n\n\`\`\`mermaid\n${FLOW}`);
    await settle();
    await settle();
    expect(root.querySelector(".diagram")).toBeNull();
    expect(root.querySelector("pre")?.textContent).toBe(`${FLOW}\n`);
    expect(detected).toHaveLength(0);
    expect(peleCalls).toHaveLength(0);
  });

  test("a reply with no mermaid fence never asks pele anything", async () => {
    const root = reply("```js\nconsole.log(1)\n```\n\nand prose.");
    await settle();
    await settle();
    expect(root.querySelector(".diagram")).toBeNull();
    expect(detected).toHaveLength(0);
  });

  test("a label's hidden characters reach pele written out", async () => {
    const root = reply(
      "```mermaid\nflowchart LR\n  A[\u2067com\u200F.\u200Facme\u2069]\n```",
    );
    await drawn(root);
    expect(peleCalls[0]?.source).toBe(
      "flowchart LR\n  A[⟨U+2067⟩com⟨U+200F⟩.⟨U+200F⟩acme⟨U+2069⟩]",
    );
    expect(root.querySelector(".diagram figure")?.textContent).not.toMatch(
      /[\u200F\u2067\u2069]/u,
    );
  });

  test("a broken figure shows the error and its source", async () => {
    const root = reply("```mermaid\nflowchart LR\n  broken ---\n```");
    await drawn(root);
    expect(
      root
        .querySelector(".diagram-error")
        ?.textContent?.replace(/\s+/g, " ")
        .trim(),
    ).toBe("Unable to render diagram: Parse error on line 2: broken");
    expect(root.querySelector("pre")?.textContent).toBe(
      "flowchart LR\n  broken ---",
    );
  });

  test("a closed figure is not drawn again as the reply grows, and keeps its Show code", async () => {
    // Every streamed delta is a new HTML string that replaces every frame. A figure drawn
    // afresh each time was laid out again on every delta (U12 review).
    const target = document.body.appendChild(document.createElement("div"));
    const live = mount(GrowingReply, { target, props: {} });
    try {
      let text = `First:\n\n\`\`\`mermaid\n${FLOW}\n\`\`\`\n\nThen`;
      live.write(text);
      flushSync();
      await drawn(target);
      expect(peleCalls).toHaveLength(1);
      const toggle =
        target.querySelector<HTMLButtonElement>("button.code-view");
      if (toggle === null) throw new Error("no toggle");
      click(toggle);
      await settle();

      for (const delta of [" the", " portal", " links", " out.", "\n\nMore."]) {
        text += delta;
        live.write(text);
        flushSync();
        await settle();
      }
      expect(target.querySelector(".markdown")?.textContent).toContain(
        "Then the portal links out.",
      );
      expect(peleCalls).toHaveLength(1);
      expect(target.querySelectorAll(".code-frame[data-diagram]")).toHaveLength(
        1,
      );
      expect(target.querySelectorAll("button.code-view")).toHaveLength(1);
      const kept = target.querySelector("button.code-view");
      expect(kept?.textContent).toBe("Show diagram");
      expect(kept?.getAttribute("aria-pressed")).toBe("true");
      expect(
        visible(target.querySelector(".code-frame[data-diagram] pre")),
      ).toBe(true);

      // A second closed fence is drawn once, beside the first; the first is still not redrawn.
      const second = "flowchart TB\n  A --- B";
      text += `\n\n\`\`\`mermaid\n${second}\n\`\`\`\n`;
      live.write(text);
      flushSync();
      await drawn(target);
      for (let tries = 0; tries < 50 && peleCalls.length < 2; tries += 1) {
        await settle();
      }
      expect(peleCalls.map((call) => call.source)).toEqual([FLOW, second]);
      expect(target.querySelectorAll(".diagram-host")).toHaveLength(2);

      // A fence whose code changes is a new figure, and the old one is taken away.
      text = text.replace("A --- B", "A --- C");
      live.write(text);
      flushSync();
      for (let tries = 0; tries < 50 && peleCalls.length < 3; tries += 1) {
        await settle();
      }
      expect(peleCalls.map((call) => call.source)).toEqual([
        FLOW,
        second,
        "flowchart TB\n  A --- C",
      ]);
      expect(target.querySelectorAll(".diagram-host")).toHaveLength(2);
    } finally {
      void unmount(live);
      target.remove();
    }
  });

  test("Copy copies the source as the agent wrote it", async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          written.push(text);
        },
      },
    });
    try {
      const source = "flowchart LR\n  A[ac\u200Bme] --- B";
      const root = reply(`\`\`\`mermaid\n${source}\n\`\`\``);
      await drawn(root);
      const button = root.querySelector<HTMLButtonElement>("button.code-copy");
      if (button === null) throw new Error("no Copy button");
      click(button);
      await settle();
      expect(written).toEqual([source]);
      expect(button.textContent).toBe("Copied");
    } finally {
      if (original === undefined) {
        Reflect.deleteProperty(navigator, "clipboard");
      } else {
        Object.defineProperty(navigator, "clipboard", original);
      }
    }
  });
});
