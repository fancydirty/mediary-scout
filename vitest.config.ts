import { defineConfig } from "vitest/config";

export default defineConfig({
  // apps/web/tsconfig.json sets jsx: "preserve" for Next; Vite 8's oxc transform
  // would then leave JSX in place and fail import analysis on any .tsx a test
  // touches. Force the automatic runtime so server components can be
  // string-rendered in tests. (Vite 8 ignores the legacy `esbuild` key.)
  oxc: { jsx: { runtime: "automatic", importSource: "react" } },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "workers/**/*.test.ts", "site/**/*.test.mjs"],
    environment: "node",
    passWithNoTests: false,
  },
});
