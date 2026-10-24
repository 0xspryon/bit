/**
 * Lets `bun test` load a `.svelte.ts` module.
 *
 * Runes are a **compiler** feature, not a runtime one. `$state` is not a function that
 * exists somewhere and could be imported — it is a marker the Svelte compiler rewrites
 * into signal plumbing, and a file full of them handed straight to a JavaScript engine
 * fails on the first one with `$state is not defined`. That is what plain `bun test`
 * does with `app.svelte.ts`, and it is the whole reason this file exists.
 *
 * It is also the whole reason this repository did not need Vitest for it. Svelte ships
 * the transform as `compileModule`, the public half of the compiler meant for exactly
 * these files, and Bun's plugin API can put a transform in front of a loader. Twenty
 * lines, no new dependency, no second test runner, and the module under test is the
 * module that ships — not a hand-copied plain-TypeScript shadow of it that can drift
 * from what the app actually runs.
 *
 * **TypeScript first, then runes.** `compileModule` parses JavaScript, so a type
 * annotation would be a syntax error to it. `Bun.Transpiler` strips the types and leaves
 * the class fields alone, which is what the rune transform needs to see.
 *
 * `dev: true` keeps the compiler's own runtime assertions — the ones that catch reading
 * a derived from outside a reactive context, or mutating state that is not proxied — so
 * a test gets told about a misuse instead of quietly getting a stale number.
 */
import { plugin } from "bun";
import { compileModule } from "svelte/compiler";

const typescript = new Bun.Transpiler({ loader: "ts" });

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
