import js from "@eslint/js";
import ts from "typescript-eslint";

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
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            "zod",
            "zod/*",
            "bun:*",
            "node:*",
            "drizzle-orm",
            "drizzle-orm/*",
            "@bit/server",
            "@bit/server/*",
            "**/apps/server/**",
          ],
        },
      ],
    },
  },
);
