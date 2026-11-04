/**
 * Which fences become flow figures (A6 U12), decided in the string pipeline.
 *
 * A closed ` ```mermaid ` fence leaves `renderMarkdown` as an ordinary framed code block
 * marked `data-diagram`; an unclosed one — a reply cut mid-stream — is the same block
 * without the mark, so it stays code. Nothing else gets the mark, and no source text can
 * put one there. And the source the renderer is handed has its hidden characters written
 * out, so a label cannot be reordered in the figure.
 */
import { describe, expect, test } from "bun:test";

import { diagramSource } from "../src/lib/diagram";
import { isClosedFence, renderMarkdown } from "../src/lib/markdown";

const FLOW = "flowchart LR\n  A[Partner portal] --> B[acme.com]";

describe("a closed fence", () => {
  const cases: ReadonlyArray<readonly [string, string, string, boolean]> = [
    ["closed with backticks", "```mermaid\nA\n```", "A\n", true],
    ["closed with tildes", "~~~mermaid\nA\n~~~", "A\n", true],
    ["closed by a longer run", "```mermaid\nA\n`````", "A\n", true],
    ["closed inside a quote", "```mermaid\n> A\n> ```", "A\n", true],
    ["cut before its closer", "```mermaid\nA\nB", "A\nB\n", false],
    ["cut partway into its closer", "```mermaid\nA\n``", "A\n``\n", false],
    ["only an opener", "```", "", false],
    ["closed by the other character", "```mermaid\nA\n~~~", "A\n~~~\n", false],
    ["closed by a shorter run", "````mermaid\nA\n```", "A\n```\n", false],
    ["a CRLF reply cut after the CR", "```mermaid\r\nA\r", "A\n", false],
  ];
  for (const [name, fence, code, closed] of cases) {
    test(`${name}: ${String(closed)}`, () => {
      expect(isClosedFence(fence, code)).toBe(closed);
    });
  }

  test("a line of many quote markers does not make the check backtrack", () => {
    const fence = `\`\`\`mermaid\n${"> ".repeat(20_000)}x`;
    const started = performance.now();
    expect(isClosedFence(fence, "x\n")).toBe(false);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("which fences are marked as figures", () => {
  test("a closed mermaid fence is marked, and is still the framed code", () => {
    const html = renderMarkdown(`Here:\n\n\`\`\`mermaid\n${FLOW}\n\`\`\`\n`);
    expect(html).toContain('<div class="code-frame" data-diagram="mermaid">');
    expect(html).toContain('<pre data-language="mermaid">');
    expect(html).toContain("Partner portal");
  });

  test("one inside a list or a quote is marked too", () => {
    expect(
      renderMarkdown(`- a figure:\n\n  \`\`\`mermaid\n  ${FLOW}\n  \`\`\`\n`),
    ).toContain("data-diagram");
    expect(
      renderMarkdown(`> \`\`\`mermaid\n> flowchart LR\n> A --> B\n> \`\`\``),
    ).toContain("data-diagram");
  });

  test("an unclosed one — a reply cut mid-stream — is not, and stays code", () => {
    const html = renderMarkdown(`Here:\n\n\`\`\`mermaid\n${FLOW}`);
    expect(html).not.toContain("data-diagram");
    expect(html).toContain('<pre data-language="mermaid">');
  });

  test("another language is not, and the source cannot add the mark", () => {
    expect(renderMarkdown(`\`\`\`js\n${FLOW}\n\`\`\``)).not.toContain(
      "data-diagram",
    );
    const raw = renderMarkdown(
      '<div class="code-frame" data-diagram="mermaid"><pre><code>x</code></pre></div>',
    );
    // Shown as the text it is, in a frame of its own with no mark.
    expect(raw).not.toMatch(/<div[^>]*data-diagram/);
    expect(raw).toContain(
      '&#x3C;div class="code-frame" data-diagram="mermaid">',
    );
  });
});

describe("the source handed to the renderer", () => {
  test("has every bidi, zero-width and tag character written out", () => {
    expect(
      diagramSource(
        "flowchart LR\n  A[\u2067com\u200F.\u200Facme\u2069] --> B[ac\u200Bme\u{E0041}]",
      ),
    ).toBe(
      "flowchart LR\n  A[⟨U+2067⟩com⟨U+200F⟩.⟨U+200F⟩acme⟨U+2069⟩] --> B[ac⟨U+200B⟩me⟨U+E0041⟩]",
    );
    // Right-to-left letters with no controls are drawn as written.
    expect(diagramSource("flowchart LR\n  A[שלום]")).toBe(
      "flowchart LR\n  A[שלום]",
    );
  });
});
