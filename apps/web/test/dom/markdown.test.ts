/**
 * Agent prose as markdown, read back as a DOM rather than as a string.
 *
 * The claims worth making here are about **elements**: that a `<script>` in agent text is
 * not one, that a `javascript:` link has no `href`, that a fence's text is exactly what the
 * agent wrote. A string match on serialised HTML can be fooled by the escaping either way,
 * so these mount `Markdown.svelte` — the `{@html}` that the live and replayed rows both
 * use — and query what a browser would have built from it.
 */
import { afterEach, describe, expect, test } from "bun:test";

import Markdown from "../../src/lib/components/Markdown.svelte";
import { memoiseByText } from "../../src/lib/markdown";
import { compile } from "svelte/compiler";

import { click, mountInto, settle, type Mounted } from "./dom";

let mounted: Mounted[] = [];
afterEach(() => {
  for (const each of mounted) each.destroy();
  mounted = [];
});

const render = (text: string): HTMLElement => {
  const one = mountInto(Markdown, { text });
  mounted.push(one);
  const root = one.target.querySelector<HTMLElement>(".markdown");
  if (root === null) throw new Error("Markdown rendered no root");
  return root;
};

describe("what an agent writes, rendered", () => {
  test("a GFM table is a table, inside a scroller of its own", () => {
    const root = render(
      [
        "| Asset | In scope |",
        "| --- | :---: |",
        "| `acme.com` | yes |",
        "| `*.dev.acme.com` | no |",
      ].join("\n"),
    );
    const table = root.querySelector("table");
    expect(table).not.toBeNull();
    // The wrapper is what keeps a wide table from setting the thread's width.
    expect(table?.parentElement?.classList.contains("table-wrap")).toBe(true);
    expect(
      [...root.querySelectorAll("th")].map((each) => each.textContent),
    ).toEqual(["Asset", "In scope"]);
    expect(root.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(root.querySelector("td code")?.textContent).toBe("acme.com");
    expect(root.textContent).not.toContain("|");
  });

  test("a fenced block keeps every newline and indent, and its language as a label", () => {
    const tree = ["src/", "├── lib/", "│   └── chat.ts", "    deep.ts"].join(
      "\n",
    );
    const root = render(`The layout:\n\n\`\`\`text\n${tree}\n\`\`\``);
    const pre = root.querySelector("pre");
    expect(pre?.dataset["language"]).toBe("text");
    // Exactly the agent's text, line breaks and leading spaces included.
    expect(pre?.querySelector("code")?.textContent).toBe(`${tree}\n`);
    expect(root.textContent).not.toContain("```");
  });

  test("a nested list nests", () => {
    const root = render("- scope\n  - acme.com\n  - api.acme.com\n- out");
    const outer = root.querySelector(":scope > ul");
    expect(outer?.children).toHaveLength(2);
    const inner = outer?.querySelector("li > ul");
    expect(
      [...(inner?.querySelectorAll("li") ?? [])].map(
        (each) => each.textContent,
      ),
    ).toEqual(["acme.com", "api.acme.com"]);
  });

  test("inline code, emphasis and a heading", () => {
    const root = render(
      "## Found\n\n**Three** are in scope — `acme.com` _and_ more.",
    );
    expect(root.querySelector("h2")?.textContent).toBe("Found");
    expect(root.querySelector("strong")?.textContent).toBe("Three");
    expect(root.querySelector("em")?.textContent).toBe("and");
    expect(root.querySelector("p code")?.textContent).toBe("acme.com");
  });

  test("a link opens elsewhere and hands over neither opener nor referrer", () => {
    const link = render(
      "See [the policy](https://acme.com/security).",
    ).querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://acme.com/security");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });
});

/*
 * The scope importer reads attacker-controlled program pages and quotes them back, so
 * agent prose on this surface is untrusted. See `markdown.ts`.
 */
describe("what a program page can put in an agent's mouth", () => {
  test("a javascript: link is a link to nowhere", () => {
    const root = render("[click](javascript:alert(document.cookie))");
    const link = root.querySelector("a");
    expect(link?.textContent).toBe("click");
    expect(link?.hasAttribute("href")).toBe(false);
    expect(root.innerHTML).not.toContain("javascript:");
  });

  test("a literal <script> is text, not an element", () => {
    const root = render(
      "The page ends with <script>alert(1)</script> inline.\n\n<script>alert(2)</script>",
    );
    expect(root.querySelector("script")).toBeNull();
    // Shown as what the agent quoted, not silently dropped.
    expect(root.textContent).toContain("<script>alert(1)</script>");
    expect(root.textContent).toContain("<script>alert(2)</script>");
  });

  test("an element with a handler is text too", () => {
    const root = render(
      '<img src=x onerror="alert(1)"> and <a href="https://x" onclick="alert(1)">x</a>',
    );
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("[onerror], [onclick]")).toBeNull();
    expect(root.textContent).toContain("onerror");
  });

  test("an image is a link to it, so rendering the reply fetches nothing", () => {
    const root = render(
      "![pixel](https://attacker.example/p.png?who=operator) ![x](javascript:alert(1))",
    );
    expect(root.querySelector("img")).toBeNull();
    const links = [...root.querySelectorAll("a")];
    expect(links.map((each) => each.getAttribute("href"))).toEqual([
      "https://attacker.example/p.png?who=operator",
    ]);
    expect(links[0]?.textContent).toBe("pixel");
    expect(root.innerHTML).not.toContain("javascript:");
  });
});

/*
 * A click on a fragment link is a same-document navigation, and a same-document navigation
 * fires `popstate` — which the shell reads as Back or Forward and answers by re-applying
 * the place, closing the importer and its draft. See `finish` in `markdown.ts`.
 */
describe("agent prose cannot move the app", () => {
  test("an in-page link is its text, and clicking it changes nothing", () => {
    const root = render(
      "Scope is [below](#scope) and noted[^1].\n\n[^1]: From the policy page.",
    );
    expect(root.querySelector('a[href^="#"]')).toBeNull();
    expect(root.querySelector("a")).toBeNull();
    expect(root.textContent).toContain("Scope is below and noted");
    // The reference is still a numbered superscript, and its note is still on screen.
    expect(root.querySelector("p sup")?.textContent).toBe("1");
    expect(root.querySelector(".footnotes li")?.textContent?.trim()).toBe(
      "From the policy page.",
    );
    // The back-reference arrow went nowhere once its target went, so it is gone too.
    expect(root.textContent).not.toContain("↩");

    const before = location.href;
    let traversals = 0;
    const counted = (): void => {
      traversals += 1;
    };
    window.addEventListener("popstate", counted);
    window.addEventListener("hashchange", counted);
    try {
      for (const each of root.querySelectorAll<HTMLElement>("*")) click(each);
    } finally {
      window.removeEventListener("popstate", counted);
      window.removeEventListener("hashchange", counted);
    }
    expect(traversals).toBe(0);
    expect(location.href).toBe(before);
  });

  test("two replies with the same footnote mint no ids to collide", () => {
    const first = render("One[^1].\n\n[^1]: First reply's note.");
    const second = render("Two[^1].\n\n[^1]: Second reply's note.");
    expect(document.querySelectorAll(".markdown [id]")).toHaveLength(0);
    expect(
      document.querySelectorAll(".markdown [aria-describedby]"),
    ).toHaveLength(0);
    // Each note is at the foot of its own reply, not shared through an id.
    expect(first.querySelector(".footnotes li")?.textContent?.trim()).toBe(
      "First reply's note.",
    );
    expect(second.querySelector(".footnotes li")?.textContent?.trim()).toBe(
      "Second reply's note.",
    );
  });
});

describe("the edges of what a reply can be", () => {
  test("an image inside a link is the link's text, not a second link", () => {
    const root = render(
      "[![alt](https://img.example/b.svg)](https://link.example/legit)",
    );
    const links = [...root.querySelectorAll("a")];
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("https://link.example/legit");
    expect(links[0]?.textContent).toBe("alt");
    expect(root.querySelector("a a")).toBeNull();
    expect(root.innerHTML).not.toContain("img.example");
  });

  test("an image inside an in-page link is still a link to the image", () => {
    const root = render("[![alt](https://img.example/b.svg)](#frag)");
    const links = [...root.querySelectorAll("a")];
    expect(links.map((each) => each.getAttribute("href"))).toEqual([
      "https://img.example/b.svg",
    ]);
  });

  test("an image whose own src is a fragment is text, not a link", () => {
    for (const [text, shown] of [
      ["![alt](#x)", "alt"],
      ["![](#)", "#"],
    ] as const) {
      const root = render(text);
      expect(root.querySelector("a")).toBeNull();
      expect(root.querySelector("img")).toBeNull();
      expect(root.textContent?.trim()).toBe(shown);
    }
    const noted = render("x[^1]\n\n[^1]: ![i](#w)");
    expect(noted.querySelector('a[href^="#"]')).toBeNull();
    expect(noted.querySelector(".footnotes li")?.textContent?.trim()).toBe("i");
  });

  test("text that renders to nothing is shown as written", () => {
    expect(render("[x]: https://acme.com/policy").textContent?.trim()).toBe(
      "[x]: https://acme.com/policy",
    );
    expect(render("[^9]: never referenced").textContent?.trim()).toBe(
      "[^9]: never referenced",
    );
  });

  test("a paragraph or heading left empty is shown as written", () => {
    expect(render("[](#x)").textContent?.trim()).toBe("[](#x)");
    expect(render("# [](#x)").textContent?.trim()).toBe("# [](#x)");
    expect(render("[](#x)").querySelector("a")).toBeNull();
  });

  test("a crafted title in the fallback stays text", () => {
    const root = render('[](#x "<img src=x onerror=alert(1)>")');
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("a")).toBeNull();
    expect(root.textContent?.trim()).toBe(
      '[](#x "<img src=x onerror=alert(1)>")',
    );
  });

  test("a horizontal rule alone is not mistaken for nothing", () => {
    const root = render("---");
    expect(root.querySelector("hr")).not.toBeNull();
    expect(root.textContent?.trim()).toBe("");
  });
});

/*
 * A6 D8, "What the transcript can render": task lists, quotes with their source line,
 * tables, and fences framed with a name and a Copy button.
 */
describe("D8's framing", () => {
  test("a task list is read-only checkboxes, done ones marked, words beside them", () => {
    const root = render(
      "- [x] Read the program policy page\n- [ ] Confirm the WordPress rule\n  - [ ] Ask the client",
    );
    const boxes = [
      ...root.querySelectorAll<HTMLInputElement>("li.task-list-item > input"),
    ];
    expect(
      boxes.map((each) => `${each.type}/${each.checked}/${each.disabled}`),
    ).toEqual([
      "checkbox/true/true",
      "checkbox/false/true",
      "checkbox/false/true",
    ]);
    expect(
      [...root.querySelectorAll(".task-text")].map((each) =>
        each.textContent?.trim(),
      ),
    ).toEqual([
      "Read the program policy page",
      "Confirm the WordPress rule",
      "Ask the client",
    ]);
    // The nested list is beside the item's words, not inside the span a strike is drawn on.
    expect(root.querySelector(".task-text ul")).toBeNull();
    // Not a control: a click changes nothing.
    for (const each of boxes) click(each);
    expect(boxes.map((each) => String(each.checked)).join()).toBe(
      "true,false,false",
    );
  });

  test("a loose task list keeps its box in the item's paragraph", () => {
    const root = render("1. [x] first\n\n2. [ ] second");
    expect(
      [...root.querySelectorAll("li > p > input + .task-text")].map(
        (each) => each.textContent,
      ),
    ).toEqual(["first", "second"]);
  });

  test("a fence is framed: its info string names it, and Copy is beside the name", () => {
    const root = render(
      [
        '```json entry-10.json\n{"host": "app.partner.com"}\n```',
        "```js\nvar=expres() + yield * expres2()\n```",
        "```\nhttps://acme.com/legacy/partner/handoff?sig=9f2c1ab7e4d05583c1f0\n```",
      ].join("\n\n"),
    );
    const frames = [...root.querySelectorAll(".code-frame")];
    expect(
      frames.map(
        (frame) =>
          `${frame.querySelector(".code-head > .code-label")?.textContent}|${frame.querySelector("pre")?.getAttribute("data-language") ?? "-"}`,
      ),
    ).toEqual(["entry-10.json|json", "js|js", "|-"]);
    expect(
      [...root.querySelectorAll(".code-head > button.code-copy")].map(
        (each) => `${each.getAttribute("type")} ${each.textContent}`,
      ),
    ).toEqual(["button Copy", "button Copy", "button Copy"]);
    // The block is still the agent's text exactly.
    expect(frames[0]?.querySelector("pre > code")?.textContent).toBe(
      '{"host": "app.partner.com"}\n',
    );
  });

  test("a table is still in its scroller, with a header row and body rows", () => {
    const root = render(
      "| Host | Dir |\n| --- | --- |\n| `*.acme.com` | in |\n| `blog.acme.com` | out |",
    );
    expect(
      root.querySelector(".table-wrap > table > thead th")?.textContent,
    ).toBe("Host");
    expect(
      [...root.querySelectorAll("tbody tr")].map((row) =>
        row.textContent?.trim(),
      ),
    ).toEqual(["*.acme.com\nin", "blog.acme.com\nout"]);
  });

  test("a quote's closing em-dash line is the line it came from, on its own line or after a blank", () => {
    for (const text of [
      '> "Testing is permitted against any Acme-owned property."\n> — hackerone.com/acme/policy · line 219',
      '> "Testing is permitted against any Acme-owned property."\n>\n> — hackerone.com/acme/policy · line 219',
    ]) {
      const quote = render(text).querySelector("blockquote");
      expect(
        [...(quote?.children ?? [])].map(
          (each) => `${each.className}:${each.textContent}`,
        ),
      ).toEqual([
        ':"Testing is permitted against any Acme-owned property."',
        "quote-source:hackerone.com/acme/policy · line 219",
      ]);
    }
  });

  test("of two dash lines, only the last is the source", () => {
    const quote = render("> a\n> — b\n> — c").querySelector("blockquote");
    expect(
      [...(quote?.children ?? [])].map(
        (each) => `${each.className}:${each.textContent}`,
      ),
    ).toEqual([":a\n— b", "quote-source:c"]);
  });

  test("a dash line with a line after it is quoted text, not the quote's source", () => {
    // Soft break, after a blank line, and a hard break (two trailing spaces): in each, the
    // dash line is followed by more of the quote, so it is not where the quote came from.
    for (const text of [
      "> line1\n> — not source\n> line3",
      "> line1\n>\n> — not source\n> line3",
      "> line1\n> — not source  \n> line3",
      "> line1\n> — not *source\nline3*",
    ]) {
      const quote = render(text).querySelector("blockquote");
      expect(quote?.querySelector(".quote-source")).toBeNull();
      expect(quote?.textContent).toContain("— not source");
      expect(quote?.textContent).toContain("line3");
    }
  });

  test("a dash alone on a line mid-quote does not make the next line the source", () => {
    // The space after a dash is not a line break: a lone `—` with more quote under it is
    // still the quote's own text, and so is the line after it.
    for (const text of [
      "> quoted\n> —\n> more quote text",
      "> quoted\n> — \t\n> more quote text",
    ]) {
      const quote = render(text).querySelector("blockquote");
      expect(quote?.querySelector(".quote-source")).toBeNull();
      expect(quote?.textContent).toContain("—");
      expect(quote?.textContent).toContain("more quote text");
    }
  });

  test("a dash that is not a closing line is left in the quote", () => {
    // Mid-line, and a quote that is nothing but the dash line: neither has a source.
    for (const text of ["> one — two", "> — only the source"]) {
      const root = render(text);
      expect(root.querySelector(".quote-source")).toBeNull();
      expect(root.querySelector("blockquote")?.textContent?.trim()).toBe(
        text.slice(2),
      );
    }
  });
});

describe("inline code", () => {
  test("is code wherever prose goes: a sentence, a heading, a list item, a cell, a link", () => {
    const root = render(
      [
        "Inline, an expression reads `var=expres() + yield * expres2()` — fenced, it keeps its own frame.",
        "## The `source` field",
        "- a `nested` item\n  - and `deeper`",
        "| Host | Note |\n| --- | --- |\n| `*.acme.com` | in |",
        "See [`policy:219`](https://hackerone.com/acme/policy).",
      ].join("\n\n"),
    );
    expect(
      [...root.querySelectorAll("code")].map(
        (each) =>
          `${each.parentElement?.tagName.toLowerCase()}:${each.textContent}`,
      ),
    ).toEqual([
      "p:var=expres() + yield * expres2()",
      "h2:source",
      "li:nested",
      "li:deeper",
      "td:*.acme.com",
      "a:policy:219",
    ]);
    expect(root.querySelector("a")?.getAttribute("href")).toBe(
      "https://hackerone.com/acme/policy",
    );
    // A span is never a block: no fence frame, no Copy.
    expect(root.querySelector(".code-frame, pre")).toBeNull();
  });

  test("is escaped text, whatever it holds", () => {
    const root = render(
      "Quoted: `<script>alert(1)</script>` and `<img src=x onerror=alert(2)>` and `[x](javascript:alert(3))`.",
    );
    expect(root.querySelector("script, img, [onerror], a")).toBeNull();
    expect(
      [...root.querySelectorAll("p > code")].map((each) => each.textContent),
    ).toEqual([
      "<script>alert(1)</script>",
      "<img src=x onerror=alert(2)>",
      "[x](javascript:alert(3))",
    ]);
    expect(
      [...root.querySelectorAll("p > code")]
        .map((each) => each.getAttributeNames().join("|"))
        .join(),
    ).toBe(",,");
  });
});

describe("D8's framing, from a program page", () => {
  test("a fence's name is text, whatever the info string says", () => {
    const root = render(
      '```js "><script>alert(1)</script><img src=x onerror=alert(2)>\nx\n```',
    );
    expect(root.querySelector("script, img, [onerror]")).toBeNull();
    const label = root.querySelector(".code-label");
    expect(label?.textContent).toBe(
      '"><script>alert(1)</script><img src=x onerror=alert(2)>',
    );
    expect(label?.getAttributeNames().join()).toBe("class");
    expect(root.querySelectorAll(".code-frame")).toHaveLength(1);
  });

  test("a fence's language cannot become an attribute or a handler", () => {
    const root = render('```x"onmouseover="alert(1)\ny\n```');
    const pre = root.querySelector("pre");
    expect(pre?.getAttributeNames().sort().join()).toBe("data-language");
    expect(root.querySelector("[onmouseover]")).toBeNull();
    expect(pre?.getAttribute("data-language")).toBe('x"onmouseover="alert(1)');
  });

  test("HTML in a task item is text, and a checkbox written as HTML is not one", () => {
    const root = render(
      "- [ ] <img src=x onerror=alert(1)> <script>alert(1)</script>\n- <input type=checkbox>",
    );
    expect(root.querySelector("script, img, [onerror]")).toBeNull();
    expect(root.querySelectorAll("input")).toHaveLength(1);
    expect(root.querySelector(".task-text")?.textContent).toBe(
      "<img src=x onerror=alert(1)> <script>alert(1)</script>",
    );
  });

  test("a javascript: link in a table cell is a link to nowhere", () => {
    const root = render(
      "| Host | Link |\n| --- | --- |\n| a | [go](javascript:alert(1)) |",
    );
    const link = root.querySelector("td a");
    expect(link?.textContent).toBe("go");
    expect(link?.hasAttribute("href")).toBe(false);
    expect(root.innerHTML).not.toContain("javascript:");
  });

  test("a quote's source line keeps HTML as text and links sanitised", () => {
    const root = render(
      "> quoted\n> — <img src=x onerror=alert(1)> [page](javascript:alert(2))",
    );
    const source = root.querySelector(".quote-source");
    expect(root.querySelector("img, [onerror]")).toBeNull();
    expect(source?.textContent).toBe("<img src=x onerror=alert(1)> page");
    expect(source?.querySelector("a")?.hasAttribute("href")).toBe(false);
  });

  test("a Copy button or a frame written as HTML is text, so every button is the pipeline's own", () => {
    const root = render(
      '<div class="code-frame"><button class="code-copy">Copy</button><pre><code>x</code></pre></div>\n\n```\nreal\n```',
    );
    // The HTML block is shown as the source it is — itself in a frame — and the frame's
    // text holds the button the agent wrote, as characters.
    const frames = [...root.querySelectorAll(".code-frame")];
    expect(frames).toHaveLength(2);
    expect(
      [...root.querySelectorAll("button")]
        .map((each) => `${each.parentElement?.className}>${each.outerHTML}`)
        .join(),
    ).toBe(
      'code-head><button type="button" class="code-copy" aria-label="Copy code">Copy</button>,code-head><button type="button" class="code-copy" aria-label="Copy code">Copy</button>',
    );
    expect(frames[0]?.querySelector("pre > code")?.textContent).toContain(
      '<button class="code-copy">Copy</button>',
    );
  });
});

describe("characters that do not show as what they are", () => {
  test("in a fence's name, a bidi override is a visible marker and the letters stay in order", () => {
    const root = render("```json \u202Enosj.live\n{}\n```");
    const label = root.querySelector(".code-label");
    expect(label?.textContent).toBe("⟨U+202E⟩nosj.live");
    expect(label?.querySelector(".char-escape")?.textContent).toBe("⟨U+202E⟩");
    expect(label?.textContent).not.toContain("\u202E");
  });

  test("in a fence and in inline code, each one is a marker; prose is left alone", () => {
    const hidden = [
      "\u202A",
      "\u202E",
      "\u2066",
      "\u2069",
      "\u200B",
      "\u200F",
      "\u2060",
      "\uFEFF",
    ];
    const root = render(
      `\`\`\`\nadmin${hidden.join("")}.acme.com\n\`\`\`\n\nSee \`a\u200Bb\` and a\u200Bb.`,
    );
    expect(root.querySelector("pre > code")?.textContent).toBe(
      "admin⟨U+202A⟩⟨U+202E⟩⟨U+2066⟩⟨U+2069⟩⟨U+200B⟩⟨U+200F⟩⟨U+2060⟩⟨U+FEFF⟩.acme.com\n",
    );
    expect(root.querySelectorAll("pre .char-escape")).toHaveLength(8);
    expect(root.querySelector("p > code")?.textContent).toBe("a⟨U+200B⟩b");
    // Prose is the agent's sentence as written: only code is escaped.
    expect(root.querySelector("p")?.textContent).toContain(" a\u200Bb.");
    expect(root.querySelector("pre")?.textContent).not.toMatch(
      /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/,
    );
  });

  test("an Arabic letter mark and a tag character are markers too; an emoji's variation selector is not", () => {
    // U+061C is a bidi control (CVE-2021-42574's list); U+E0000–E007F are tag characters,
    // invisible and outside the BMP, so their code point has five digits.
    const root = render(
      "```\nad\u061Cmin\u{E0041}\u{E007F}.acme.com \u2764\uFE0F\n```\n\nSee `a\u061Cb\u{E0001}c`.",
    );
    expect(root.querySelector("pre > code")?.textContent).toBe(
      "ad⟨U+061C⟩min⟨U+E0041⟩⟨U+E007F⟩.acme.com \u2764\uFE0F\n",
    );
    expect(root.querySelectorAll("pre .char-escape")).toHaveLength(3);
    expect(root.querySelector("p > code")?.textContent).toBe(
      "a⟨U+061C⟩b⟨U+E0001⟩c",
    );
  });

  test("Copy gives back a five-digit tag character and an Arabic letter mark as written", async () => {
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
      const source = "ad\u061Cmin\u{E0041}\u{E007F}.acme.com";
      const root = render(`\`\`\`\n${source}\n\`\`\``);
      const button = root.querySelector<HTMLButtonElement>("button.code-copy");
      if (button === null) throw new Error("no Copy button");
      click(button);
      await settle();
      expect(written).toEqual([source]);
    } finally {
      if (original === undefined) {
        Reflect.deleteProperty(navigator, "clipboard");
      } else {
        Object.defineProperty(navigator, "clipboard", original);
      }
    }
  });

  test("a marker written by the agent is text, and Copy gives it back as written", async () => {
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
      const root = render("```\nadmin\u200B.acme.com ⟨U+202E⟩ \u202Eevil\n```");
      // The agent's own "⟨U+202E⟩" is plain text, not a marker.
      expect(root.querySelectorAll(".char-escape")).toHaveLength(2);
      const button = root.querySelector<HTMLButtonElement>("button.code-copy");
      if (button === null) throw new Error("no Copy button");
      click(button);
      await settle();
      expect(written).toEqual(["admin\u200B.acme.com ⟨U+202E⟩ \u202Eevil"]);
    } finally {
      if (original === undefined) {
        Reflect.deleteProperty(navigator, "clipboard");
      } else {
        Object.defineProperty(navigator, "clipboard", original);
      }
    }
  });
});

describe("Copy", () => {
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  let written: string[] = [];
  const clipboard = (writeText: (text: string) => Promise<void>): void => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  };
  afterEach(() => {
    written = [];
    if (original === undefined) {
      Reflect.deleteProperty(navigator, "clipboard");
    } else {
      Object.defineProperty(navigator, "clipboard", original);
    }
  });

  test("puts the fence's text on the clipboard exactly, and says it did", async () => {
    clipboard(async (text) => {
      written.push(text);
    });
    const json =
      '{\n  "host":       "app.partner.com",\n  "subdomains": false\n}';
    const root = render(
      `\`\`\`json entry-10.json\n${json}\n\`\`\`\n\n\`\`\`js\nvar=1\n\`\`\``,
    );
    const buttons = [
      ...root.querySelectorAll<HTMLButtonElement>("button.code-copy"),
    ];
    const first = buttons[0];
    const second = buttons[1];
    if (first === undefined || second === undefined) {
      throw new Error("expected two Copy buttons");
    }
    click(first);
    await settle();
    expect(written).toEqual([json]);
    expect(first.textContent).toBe("Copied");
    expect(second.textContent).toBe("Copy");

    // Each button copies its own frame.
    click(second);
    await settle();
    expect(written).toEqual([json, "var=1"]);
  });

  test("each button names its fence, as text", () => {
    const root = render(
      [
        "```json entry-10.json\n{}\n```",
        "```js\nx\n```",
        "```\nx\n```",
        '```js "><script>alert(1)</script>\nx\n```',
        "```json \u202Enosj.live\n{}\n```",
      ].join("\n\n"),
    );
    expect(root.querySelector("script")).toBeNull();
    expect(
      [...root.querySelectorAll("button.code-copy")].map((each) =>
        each.getAttribute("aria-label"),
      ),
    ).toEqual([
      "Copy entry-10.json",
      "Copy js",
      "Copy code",
      'Copy "><script>alert(1)</script>',
      "Copy ⟨U+202E⟩nosj.live",
    ]);
  });

  test("the result is announced, once, outside the agent's markup", async () => {
    clipboard(async (text) => {
      written.push(text);
    });
    const one = mountInto(Markdown, { text: "```\nx\n```" });
    mounted.push(one);
    const live = one.target.querySelectorAll('[aria-live="polite"]');
    expect(live).toHaveLength(1);
    const region = live[0];
    if (region === undefined) throw new Error("no live region");
    expect(region.closest(".markdown")).toBeNull();
    expect(region.textContent).toBe("");
    const button =
      one.target.querySelector<HTMLButtonElement>("button.code-copy");
    if (button === null) throw new Error("no Copy button");
    click(button);
    await settle();
    expect(region.textContent).toBe("Copied");

    clipboard(() => Promise.reject(new Error("denied")));
    click(button);
    await settle();
    expect(region.textContent).toBe("Copy failed");
  });

  test("a second Copy inside the 1.5 s is announced again", async () => {
    // A polite region speaks when its text changes. Setting "Copied" over "Copied" changes
    // nothing, so the second copy would go unheard; each one has to be a new change.
    clipboard(async (text) => {
      written.push(text);
    });
    const one = mountInto(Markdown, { text: "```\nx\n```" });
    mounted.push(one);
    const region = one.target.querySelector('[aria-live="polite"]');
    const button =
      one.target.querySelector<HTMLButtonElement>("button.code-copy");
    if (region === null || button === null) {
      throw new Error("no live region or Copy button");
    }
    const heard: string[] = [];
    let last = region.textContent ?? "";
    const observer = new MutationObserver(() => {
      const now = region.textContent ?? "";
      if (now !== last && now !== "") heard.push(now);
      last = now;
    });
    observer.observe(region, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    const frame = (): Promise<void> =>
      new Promise((resolve) => requestAnimationFrame(() => resolve()));
    try {
      click(button);
      await settle();
      await frame();
      await settle();
      click(button);
      await settle();
      await frame();
      await settle();
      expect(heard).toEqual(["Copied", "Copied"]);
      expect(region.textContent).toBe("Copied");
    } finally {
      observer.disconnect();
    }
  });

  test("a reply taken away mid-'Copied' leaves no timer behind", async () => {
    clipboard(async (text) => {
      written.push(text);
    });
    const one = mountInto(Markdown, { text: "```\nx\n```" });
    const button =
      one.target.querySelector<HTMLButtonElement>("button.code-copy");
    if (button === null) throw new Error("no Copy button");
    click(button);
    await settle();
    expect(button.textContent).toBe("Copied");
    one.destroy();
    // Had the reset timer survived, it would write "Copy" into the detached button.
    await new Promise((resolve) => setTimeout(resolve, 1700));
    expect(button.textContent).toBe("Copied");
  });

  test("says so when the clipboard refuses, rather than claiming a copy", async () => {
    clipboard(() => Promise.reject(new Error("denied")));
    const button =
      render("```\nx\n```").querySelector<HTMLButtonElement>(
        "button.code-copy",
      );
    if (button === null) throw new Error("no Copy button");
    click(button);
    await settle();
    expect(button.textContent).toBe("Copy failed");
  });
});

/*
 * happy-dom does no layout — every `scrollWidth` and `clientWidth` is 0 — so whether a long
 * line widens the thread is measured in a browser (the slice's CDP check). What can be
 * checked here is the contract that measurement rests on, under the component's own
 * compiled stylesheet: the line is in a block that scrolls, and prose around it wraps.
 */
describe("what cannot wrap scrolls in its own block", () => {
  const path = new URL(
    "../../src/lib/components/Markdown.svelte",
    import.meta.url,
  ).pathname;
  let sheet: HTMLStyleElement | undefined;
  afterEach(() => {
    sheet?.remove();
    sheet = undefined;
  });

  test("a long unbroken token is in a scrolling pre, and prose wraps anywhere", async () => {
    // The same options as the test transform, so the scoping hash matches the mounted DOM.
    const { css } = compile(await Bun.file(path).text(), {
      filename: path,
      generate: "client",
      css: "external",
      dev: true,
    });
    sheet = document.createElement("style");
    sheet.textContent = css?.code ?? "";
    document.head.append(sheet);

    const token = `https://acme.com/legacy/partner/handoff?redirect=${"a".repeat(400)}`;
    const root = render(
      `Prose with ${token} in it.\n\n\`\`\`\n${token}\n\`\`\``,
    );
    const pre = root.querySelector("pre");
    if (pre === null) throw new Error("no pre");
    const frame = getComputedStyle(pre.parentElement ?? pre);
    const block = getComputedStyle(pre);
    expect(
      `${block.overflowX} ${block.whiteSpace} ${frame.maxWidth} ${frame.minWidth}`,
    ).toBe("auto pre 100% 0");
    expect(getComputedStyle(root).overflowWrap).toBe("anywhere");
  });

  test("a long inline span wraps with its sentence, and a header's capitals leave code alone", async () => {
    const { css } = compile(await Bun.file(path).text(), {
      filename: path,
      generate: "client",
      css: "external",
      dev: true,
    });
    sheet = document.createElement("style");
    sheet.textContent = css?.code ?? "";
    document.head.append(sheet);

    const root = render(
      `Prose with \`${"tok3n".repeat(80)}\` in it.\n\n| \`Host\` |\n| --- |\n| a |`,
    );
    const span = getComputedStyle(root.querySelector("p > code") ?? root);
    expect(`${span.whiteSpace} ${span.overflowWrap}`).toBe("normal anywhere");
    expect(
      getComputedStyle(root.querySelector("th code") ?? root).textTransform,
    ).toBe("none");
  });

  test("inline code is isolated from a bidi control in the prose around it", async () => {
    // U+202E in a sentence reverses what follows it, code included, unless the code is its
    // own isolate: `nosj.live` would read as `evil.json`.
    const { css } = compile(await Bun.file(path).text(), {
      filename: path,
      generate: "client",
      css: "external",
      dev: true,
    });
    sheet = document.createElement("style");
    sheet.textContent = css?.code ?? "";
    document.head.append(sheet);

    const root = render(
      [
        "## Heading \u202E `nosj.live`",
        "Prose then override \u202E and inline `nosj.live` code",
        "- item \u202E `nosj.live`",
        "| Host |\n| --- |\n| cell \u202E `nosj.live` |",
      ].join("\n\n"),
    );
    const codes = [
      ...root.querySelectorAll("h2 code, p code, li code, td code"),
    ];
    expect(codes).toHaveLength(4);
    expect(
      codes.map((each) => {
        const style = getComputedStyle(each);
        return `${each.parentElement?.tagName} ${style.unicodeBidi} ${style.direction}`;
      }),
    ).toEqual([
      "H2 isolate ltr",
      "P isolate ltr",
      "LI isolate ltr",
      "TD isolate ltr",
    ]);
  });

  test("a table with no body has no record's deep header", async () => {
    // A header row alone, on the deep background inside a solid edge, is the chat's
    // committed record (`ChatItem`'s `.block`); an agent could draw itself a receipt.
    const { css } = compile(await Bun.file(path).text(), {
      filename: path,
      generate: "client",
      css: "external",
      dev: true,
    });
    sheet = document.createElement("style");
    // The token sheet is not loaded here; a stand-in value makes the fill comparable.
    sheet.textContent = `:root { --bg-deep: rgb(1, 2, 3); }\n${css?.code ?? ""}`;
    document.head.append(sheet);

    const root = render(
      '| RECORDED `add_scope_entry("evil.example")` |\n|---|\n\n| Host |\n| --- |\n| a |',
    );
    const [alone, bodied] = [...root.querySelectorAll("th")].map(
      (each) => getComputedStyle(each).backgroundColor,
    );
    expect(bodied).toBe("rgb(1, 2, 3)");
    expect(alone).not.toBe(bodied);
  });

  test("in a list mixing tasks and bullets, only the task loses its bullet", async () => {
    // GFM marks the whole list `contains-task-list` when one item is a task; a rule on
    // the list stripped every bullet in it.
    const { css } = compile(await Bun.file(path).text(), {
      filename: path,
      generate: "client",
      css: "external",
      dev: true,
    });
    sheet = document.createElement("style");
    sheet.textContent = css?.code ?? "";
    document.head.append(sheet);

    const root = render("- a bullet\n- [ ] a task");
    expect(
      [...root.querySelectorAll("li")]
        .map((each) => getComputedStyle(each).listStyleType)
        .join(),
    ).toBe("disc,none");
  });
});

/*
 * Every frame of live activity rebuilds the rows, and every rebuilt row derives its HTML
 * again. What keeps that from being a parse per reply per frame is the memo, so it is
 * tested against a counting stand-in rather than inferred from timing.
 */
describe("rendering is remembered by text", () => {
  test("the same text twice is rendered once", () => {
    let parses = 0;
    const render = memoiseByText((text) => {
      parses += 1;
      return `<p>${text}</p>`;
    }, 4);
    expect(render("a")).toBe("<p>a</p>");
    expect(render("a")).toBe("<p>a</p>");
    expect(render("b")).toBe("<p>b</p>");
    expect(render("a")).toBe("<p>a</p>");
    expect(parses).toBe(2);
  });

  test("it is bounded, and evicts the least recently used", () => {
    const seen: string[] = [];
    const render = memoiseByText((text) => {
      seen.push(text);
      return text;
    }, 2);
    render("a");
    render("b");
    render("a"); // a is now the most recent
    render("c"); // evicts b
    render("a"); // still kept
    render("b"); // gone, rendered again
    expect(seen).toEqual(["a", "b", "c", "b"]);
  });
});
