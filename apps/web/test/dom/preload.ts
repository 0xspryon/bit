/**
 * Gives `bun test` a browser: a DOM, and components compiled to build one.
 *
 * Everything else in `test/` renders a component to a string on the server, and that is
 * the right tool for "what does the markup say". It cannot say what happens next — nothing
 * runs an `$effect`, nothing is clicked, nothing has focus — and that is the gap this
 * closes. A delete that left focus on `<body>` shipped through it, because the one thing
 * that would have noticed is a document with an `activeElement`.
 *
 * ## Why it is a separate run
 *
 * A `.svelte` file is compiled once per process, for one target: `generate: "server"` for
 * the markup tests, `generate: "client"` here. They cannot share a process, so `bun test`
 * (see `bunfig.toml`) ignores `test/dom/` and `bun run test:dom` runs only it, under
 * `bunfig.dom.toml`.
 *
 * ## `--conditions=browser`
 *
 * `svelte`'s package map sends the bare `svelte` import to `index-server.js` under Bun,
 * where `mount` throws `lifecycle_function_unavailable`. The `browser` condition sends it
 * to `index-client.js`, and the `test:dom` script passes it. A resolver plugin that
 * redirects the import was tried first and is never consulted for a bare package name, so
 * the flag is the way, not a shortcut.
 *
 * ## happy-dom, not a browser
 *
 * It implements focus, `activeElement`, event dispatch and bubbling, which is what is
 * asserted. It does not do layout, so nothing here can say whether a list is tall enough or
 * a panel covers a form — those are measured in a browser, and are CSS.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { beforeEach } from "bun:test";

import { installComponents, installIcons, installRunes } from "../transforms";

GlobalRegistrator.register({ width: 1024, height: 768 });

/*
 * A failing assertion prints a node as a short tag, not as its object graph.
 *
 * `bun test` prints a happy-dom node by walking it, and a node reaches its whole `window`:
 * a failing `toBe` between two bare elements printed 248 056 lines, and inside a mounted
 * app one ran the process out of memory before it reported anything — which took the
 * machine's memory with it and killed the shell running the suite. With this, the same
 * failure reads `Expected: <div>` / `Received: <button.confirm.danger>`.
 *
 * **It does not cover `toEqual`'s diff**, which walks the structure itself and ignores the
 * hook. So never `toEqual` a node or an array of nodes: map them to strings first
 * (`outerHTML`, `textContent`, an attribute), as every such assertion here does.
 */
Object.defineProperty(
  Node.prototype,
  Symbol.for("nodejs.util.inspect.custom"),
  {
    configurable: true,
    value(this: Node): string {
      if (!(this instanceof Element)) return `#${this.nodeName.toLowerCase()}`;
      const id = this.id === "" ? "" : `#${this.id}`;
      const classes = [...this.classList].map((each) => `.${each}`).join("");
      return `<${this.tagName.toLowerCase()}${id}${classes}>`;
    },
  },
);
/*
 * No `Worker`. Bun has a native one, and with it every reply in this suite with a closed
 * ` ```json ` fence would start the app's real highlighter (`highlight.ts`) — Shiki in a
 * worker — and have its code rebuilt at some later moment, in whichever test was running
 * then. Here the app's highlighter cannot start and its fences stay plain; a test of
 * highlighting passes `Markdown` a stand-in instead.
 */
Reflect.deleteProperty(globalThis, "Worker");
installRunes();
installComponents("client");
installIcons("client");

/*
 * One window for the whole run, so one `localStorage`: what a test leaves there — the
 * importer's remembered model (`importerModelMemory.ts`) — would be the next test's
 * starting state. Each test starts with none, as a first visit does.
 */
beforeEach(() => {
  localStorage.clear();
});
