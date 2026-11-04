/**
 * The diagram sanitiser (A6 U12), fed a hostile SVG string directly.
 *
 * Over jsdom — DOMPurify's own test environment — rather than happy-dom, whose parser drops
 * an inline `<svg>` and hands back what DOMPurify removed. A pele figure's SVG is the
 * renderer's output from an agent's fence, and in the importer that is a program page's
 * words, so this pass is what stands between the renderer and the page.
 */
import { describe, expect, test } from "bun:test";
import type { WindowLike } from "dompurify";
import { JSDOM } from "jsdom";

import { sanitizeDiagramSvg } from "../src/lib/diagramDraw";

describe("the diagram sanitiser", () => {
  const { window } = new JSDOM("<!doctype html><body></body>");
  const view = window as unknown as WindowLike;
  const clean = (svg: string): string => {
    const holder = window.document.createElement("div");
    holder.append(sanitizeDiagramSvg(svg, view));
    return holder.innerHTML;
  };

  test("strips links, foreign HTML, style sheets, loads, handlers and javascript: URLs", () => {
    const out = clean(
      [
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="alert(1)">',
        '<a href="javascript:alert(2)"><text>link</text></a>',
        '<a xlink:href="https://attacker.example/"><text>xlink</text></a>',
        '<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml"><iframe src="https://attacker.example/"></iframe>island</div></foreignObject>',
        "<style>@import url(https://attacker.example/x.css); * { display: none }</style>",
        '<image href="https://attacker.example/p.png" />',
        '<use href="https://attacker.example/s.svg#x" />',
        '<use xlink:href="#local" />',
        "<script>alert(3)</script>",
        '<g onclick="alert(4)" onmouseover="alert(5)"><rect width="5" height="5" fill="url(https://attacker.example/f)" /></g>',
        '<rect style="fill: url(https://attacker.example/s)" width="1" height="1" />',
        '<path d="M0 0L1 1" marker-end="url(#arrow)" />',
        '<filter id="f"><feImage href="https://attacker.example/i.png" /></filter>',
        '<text x="1" y="2">kept label</text>',
        "</svg>",
      ].join(""),
    );
    for (const gone of [
      "<a",
      "foreignObject",
      "foreignobject",
      "<style",
      "<image",
      "<script",
      "iframe",
      "href",
      "onload",
      "onclick",
      "onmouseover",
      "javascript:",
      "attacker.example",
      "@import",
    ]) {
      expect(out).not.toContain(gone);
    }
    // What a figure is made of is still there.
    expect(out).toContain("<svg");
    expect(out).toContain("kept label");
    expect(out).toContain('marker-end="url(#arrow)"');
    expect(out).toContain('<path d="M0 0L1 1"');
  });

  test("drops any attribute with a backslash or an image-set( in it, and keeps its siblings", () => {
    // Defence in depth (U12 review): a CSS escape spells `url(` without the letters, and
    // `image-set` loads from a bare string. pele rejects both today; the sanitiser does too.
    const out = clean(
      [
        '<svg xmlns="http://www.w3.org/2000/svg">',
        '<rect id="a" width="1" height="1" style="fill: u\\72l(https://attacker.example/e)" />',
        '<rect id="b" width="1" height="1" fill="\\75rl(x)" />',
        '<rect id="c" width="1" height="1" style="fill: image-set(\'https://attacker.example/i.png\' 1x)" />',
        '<rect id="d" width="1" height="1" style="fill: IMAGE-SET (\'x.png\' 1x)" />',
        '<rect id="e" width="1" height="1" style="fill: #000" />',
        "</svg>",
      ].join(""),
    );
    expect(out).not.toContain("\\");
    expect(out.toLowerCase()).not.toContain("image-set");
    expect(out).not.toContain("attacker.example");
    // The rest of each rect stays: only the attribute goes.
    for (const id of ["a", "b", "c", "d"]) {
      expect(out).toContain(`<rect id="${id}" width="1" height="1"`);
    }
    expect(out).toContain('style="fill: #000"');
  });
});
