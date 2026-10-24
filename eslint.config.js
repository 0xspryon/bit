import js from "@eslint/js";
import ts from "typescript-eslint";

/**
 * What browser-safe code may not reach for.
 *
 * The contracts package and the web app both run in a browser, so a Bun builtin, a Node
 * builtin, the SQL layer or anything out of the server is a build that breaks at load
 * time rather than at review time. This is the list that stops it, and it is written
 * once because the exception below has to subtract from exactly this and nothing else.
 */
const notInTheBrowser = [
  "zod",
  "zod/*",
  "bun:*",
  "node:*",
  "effect/sql",
  "effect/sql/*",
  "@effect/sql-sqlite-bun",
  "@effect/sql-sqlite-bun/*",
  "@bit/server",
  "@bit/server/*",
  "**/apps/server/**",
];

export default ts.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.svelte-kit/**",
      "**/.turbo/**",
    ],
  },
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, ...ts.configs.recommended],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      "no-restricted-imports": ["error", { patterns: ["zod", "zod/*"] }],
    },
  },
  {
    files: ["packages/contracts/**/*.ts", "apps/web/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: notInTheBrowser }],
    },
  },
  {
    /**
     * The web app's tests and their runner, which are Bun programs rather than browser
     * code and need `bun:test` and `Bun.Transpiler` to say so.
     *
     * Narrowed to the two places that can be: files whose name ends in `.test.ts`, and
     * `test/`, which holds nothing the app imports. Everything else in the list above
     * still applies here — a test is still forbidden from reaching into `apps/server`,
     * because a web test that could do that would stop being a test of the web app.
     */
    files: ["apps/web/**/*.test.ts", "apps/web/test/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: notInTheBrowser.filter((pattern) => pattern !== "bun:*") },
      ],
    },
  },
);
