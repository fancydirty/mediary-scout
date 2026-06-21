// @ts-check
import tseslint from "typescript-eslint";
import nextPlugin from "@next/eslint-plugin-next";

/**
 * Focused, type-aware lint. We intentionally do NOT enable the full
 * recommendedTypeChecked preset (it would flag hundreds of pre-existing
 * stylistic issues and red the CI). Instead we enable the few rules that catch
 * REAL bugs in an async/worker-heavy codebase — chiefly unawaited promises that
 * fail silently. Production source only; tests excluded for now.
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/*.js",
      "**/*.cjs",
      "**/*.mjs",
      "apps/web/next-env.d.ts",
      "scripts/**",
      "**/*.test.ts",
      "**/*.test.tsx",
    ],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    // Register the Next plugin so the existing `// eslint-disable-next-line
    // @next/next/no-img-element` comments resolve to a real rule. We do NOT
    // enable its rules here (next build runs them separately) — registering it
    // just stops ESLint erroring on "rule definition not found".
    plugins: { "@next/next": nextPlugin },
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
      // Enabled so the existing intentional `// eslint-disable-next-line
      // @next/next/no-img-element` comments (TMDB-CDN <img> tags) are valid, and
      // any NEW undisabled <img> is caught here too (matches `next build`).
      "@next/next/no-img-element": "error",
    },
  },
);
