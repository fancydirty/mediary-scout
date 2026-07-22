import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("movie synopsis mobile contract", () => {
  it("uses expandable hit target with collapsed/expanded classes", () => {
    const src = readFileSync(
      resolve(__dirname, "../components/movie-synopsis.tsx"),
      "utf8",
    );
    expect(src).toContain("is-collapsed");
    expect(src).toContain("is-expanded");
    expect(src).toContain("aria-expanded");
    expect(src).toContain("轻触展开全文");
  });

  it("globals define 2-line clamp + gradient veil under 860px", () => {
    const css = readFileSync(resolve(__dirname, "../app/globals.css"), "utf8");
    expect(css).toMatch(/\.movie-synopsis\.is-collapsed[\s\S]*-webkit-line-clamp:\s*2/);
    expect(css).toMatch(/\.movie-synopsis\.is-collapsed \.movie-synopsis-hit::after/);
    expect(css).toMatch(/@media \(max-width: 860px\)/);
  });
});
