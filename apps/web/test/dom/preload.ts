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

import { installComponents, installIcons, installRunes } from "../transforms";

GlobalRegistrator.register({ width: 1024, height: 768 });
installRunes();
installComponents("client");
installIcons("client");
