/**
 * The three Bun plugin bodies that turn Svelte sources into modules `bun test` can load.
 *
 * `runes.ts` installs them for the server-rendered tests, and `dom/preload.ts` installs them
 * again for the ones that mount a component in a DOM. They differ in exactly one thing —
 * whether a component is compiled to render a string or to build and update nodes — so that
 * is the one parameter, and everything else is written once.
 */
import { plugin } from "bun";
import { compile, compileModule } from "svelte/compiler";

export type Generate = "client" | "server";

const typescript = new Bun.Transpiler({ loader: "ts" });

/**
 * `.svelte.ts`: `compileModule` after the types are stripped. Always `client`, because that
 * is the half of the compiler that rewrites `$state` into signals — the server output is
 * plain assignment, and nothing in `app.svelte.ts` would then react to anything.
 */
export const installRunes = (): void => {
  plugin({
    name: "svelte-runes",
    setup(build) {
      build.onLoad({ filter: /\.svelte\.ts$/ }, async (args) => {
        const source = await Bun.file(args.path).text();
        const compiled = compileModule(typescript.transformSync(source), {
          filename: args.path,
          generate: "client",
          dev: true,
        });
        return { contents: compiled.js.code, loader: "js" };
      });
    },
  });
};

/** `.svelte`. `css: "external"` keeps the `<style>` block out; Vite owns it in the build. */
export const installComponents = (generate: Generate): void => {
  plugin({
    name: `svelte-components-${generate}`,
    setup(build) {
      build.onLoad({ filter: /\.svelte$/ }, async (args) => {
        const source = await Bun.file(args.path).text();
        const compiled = compile(source, {
          filename: args.path,
          generate,
          css: "external",
          dev: true,
        });
        return { contents: compiled.js.code, loader: "js" };
      });
    },
  });
};

/**
 * `.svg?component`: an SVG is valid Svelte markup, so the icons the app imports as
 * components go through the same compiler. No svgo pass and no `?raw`: nothing asserts on
 * path data, only on whether a component holding an icon can be loaded at all.
 */
export const installIcons = (generate: Generate): void => {
  plugin({
    name: `svelte-svg-${generate}`,
    setup(build) {
      build.onLoad({ filter: /\.svg(\?.*)?$/ }, async (args) => {
        const file = args.path.replace(/\?.*$/, "");
        const source = await Bun.file(file).text();
        const compiled = compile(source, {
          filename: file,
          generate,
          css: "external",
        });
        return { contents: compiled.js.code, loader: "js" };
      });
    },
  });
};
