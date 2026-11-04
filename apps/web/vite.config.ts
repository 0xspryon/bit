import { sveltekit } from "@sveltejs/kit/vite";
import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import svg from "@poppanator/sveltekit-svg";
import { defineConfig } from "vite";

/**
 * Where this dev server forwards `/api`: the control plane, wherever it is.
 *
 * The browser reaches the control plane **same-origin** — through this proxy in
 * development, from the server itself in a packaged deployment — which is why there is a
 * proxy here at all and why `http/browserApi.ts` serves no CORS headers. The consequence
 * is that this target is the only thing that decides which fleet a dev browser is
 * talking to, and while it was a literal `http://127.0.0.1:3000` a second `bun run dev`
 * could not be pointed at its own server: both web apps proxied to whichever process got
 * port 3000 first, whatever `HUNT_ROOT` either was given.
 *
 * Two variables, in order, and the old literal when neither is set, so nothing changes
 * for a default run:
 *
 * - `BIT_SERVER_URL` — a whole origin, for a control plane on another host.
 * - `PORT` — the one the server already reads for its listener (`apps/server/src/main.ts`),
 *   so `PORT=3100 bun run dev` moves both halves together rather than moving the server
 *   and leaving the browser pointed at the old one.
 *
 * Both are in `turbo.json`'s `passThroughEnv` for the `dev` task. A variable missing from
 * that list is **silently dropped** by turbo — which is the bug commit `2ebba0e` fixed
 * for `BIT_PASSWORD`, and the reason this comment names the list.
 */
const controlPlane = (): string => {
  const url = process.env["BIT_SERVER_URL"];
  if (url !== undefined && url.trim() !== "") return url.trim();
  const port = process.env["PORT"];
  return `http://127.0.0.1:${port !== undefined && port.trim() !== "" ? port.trim() : "3000"}`;
};

export default defineConfig({
  plugins: [
    /**
     * Line Awesome ships one SVG per icon, each a bare `<path>` inside a
     * `viewBox="0 0 32 32"` with no fill. Importing one gives a Svelte
     * component; svgo adds `fill="currentColor"` so the icon takes its colour
     * from the text around it, the way a font icon would.
     *
     * Must come before `sveltekit()` — it has to claim the `.svg` import
     * before SvelteKit's asset handling does.
     */
    svg({
      // No `includePaths`: Bun resolves `line-awesome` through its global
      // store, so the on-disk path is not under this package's node_modules
      // and a path filter would never match.
      svgoOptions: {
        multipass: true,
        plugins: [
          { name: "preset-default" },
          { name: "removeDimensions" },
          {
            name: "addAttributesToSVGElement",
            params: {
              attributes: [{ fill: "currentColor" }, { "aria-hidden": "true" }],
            },
          },
        ],
      },
    }),
    sveltekit({
      preprocess: vitePreprocess(),
      adapter: adapter({ fallback: "index.html" }),
    }),
  ],
  server: { proxy: { "/api": controlPlane() } },
  /**
   * The highlighter's worker (`src/lib/highlight.worker.ts`) loads each grammar with its own
   * `import()`, and code-splitting needs ES-module output: Vite's default for a worker is
   * one IIFE, which would put every grammar into one file fetched with the first fence.
   */
  worker: { format: "es" },
});
