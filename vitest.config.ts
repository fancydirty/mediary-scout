import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "workers/**/*.test.ts", "site/**/*.test.mjs"],
    environment: "node",
    passWithNoTests: false,
  },
});
