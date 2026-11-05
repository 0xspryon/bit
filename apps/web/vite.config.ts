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

/**
 * Bun's own ceiling on a request body, which the server raises only past it
 * (`apps/server/src/main.ts`, `maxRequestBodySize`).
 */
const BUN_BODY_CEILING = 128 * 1024 * 1024;

/**
 * An upload the control plane's listener refused before reading it, said as the `413` it
 * was (A6 U13).
 *
 * Bun answers a body over its ceiling with an empty `413` and closes the socket with the
 * rest of the body unread, which resets the connection: this proxy, still writing the body,
 * sees the reset and — left alone — answers `502`, which the composer could only read as
 * "no server answered". The browser straight to Bun gets the `413` (measured). So a reset
 * while forwarding a body over that ceiling is answered `413` here, before Vite's own
 * handler writes its `502`; the client words it (`RequestTooLarge`). Refusals the server's
 * handler makes itself read the whole body first (`upload/uploads.ts`) and pass through.
 *
 * V2(chat): a guess from the request's declared length and the error code: a server that
 * died mid-upload of a body that size would be reported as too large. Proper V2 is T3's
 * two-step upload, whose size-pinned URL is refused before any body is sent.
 */
const tooLargeOnReset = (proxy: {
  on: (
    event: "error",
    listener: (
      error: Error & { code?: string },
      request: { headers: Record<string, string | string[] | undefined> },
      response: unknown,
    ) => void,
  ) => unknown;
}): void => {
  proxy.on("error", (error, request, response) => {
    const declared = Number(request.headers["content-length"] ?? 0);
    if (
      declared <= BUN_BODY_CEILING ||
      (error.code !== "ECONNRESET" && error.code !== "EPIPE")
    ) {
      return;
    }
    const res = response as {
      headersSent?: boolean;
      writableEnded?: boolean;
      writeHead?: (status: number) => { end: () => void };
    };
    if (res.writeHead !== undefined && !res.headersSent && !res.writableEnded) {
      res.writeHead(413).end();
    }
  });
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
  server: {
    proxy: {
      "/api": {
        target: controlPlane(),
        changeOrigin: true,
        configure: tooLargeOnReset,
      },
    },
  },
  /**
   * The highlighter's worker (`src/lib/highlight.worker.ts`) loads each grammar with its own
   * `import()`, and code-splitting needs ES-module output: Vite's default for a worker is
   * one IIFE, which would put every grammar into one file fetched with the first fence.
   */
  worker: { format: "es" },
});
