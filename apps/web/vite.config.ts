import { sveltekit } from "@sveltejs/kit/vite";
import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import svg from "@poppanator/sveltekit-svg";
import { defineConfig } from "vite";

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
  server: { proxy: { "/api": "http://127.0.0.1:3000" } },
});
