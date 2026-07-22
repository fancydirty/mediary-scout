import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("movie synopsis mobile contract", () => {
  const component = readFileSync(
    resolve(__dirname, "../components/movie-synopsis.tsx"),
    "utf8",
  );
  const css = readFileSync(resolve(__dirname, "../app/globals.css"), "utf8");

  it("renders a button only on the mobile branch (desktop is static markup)", () => {
    expect(component).toContain('matchMedia("(max-width: 860px)")');
    expect(component).toContain("if (!mobile)");
    expect(component).toContain("aria-expanded");
    // Body inside button must be phrasing content, not <p>.
    expect(component).toMatch(/<span className="movie-synopsis-body"/);
    expect(component).not.toMatch(/<p className="movie-synopsis-body"/);
  });

  it("globals define 2-line clamp + gradient veil under 860px", () => {
    expect(css).toMatch(/\.movie-synopsis\.is-collapsed[\s\S]*-webkit-line-clamp:\s*2/);
    expect(css).toMatch(/\.movie-synopsis\.is-collapsed \.movie-synopsis-hit::after/);
    expect(css).toMatch(/@media \(max-width: 860px\)[\s\S]*flex-direction:\s*column/);
    expect(css).toMatch(/\.hub-hero \.back-link[\s\S]*white-space:\s*nowrap/);
  });
});
