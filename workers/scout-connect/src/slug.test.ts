import { describe, it, expect } from "vitest";
import { normalizeSlug, assertSlug, RESERVED_SLUGS } from "./slug.js";

describe("slug", () => {
  it("normalizes lowercases and trims", () => {
    expect(normalizeSlug("  Alice-01 ")).toBe("alice-01");
  });

  it("accepts valid slugs", () => {
    expect(() => assertSlug("alice")).not.toThrow();
    expect(() => assertSlug("a7k2")).not.toThrow();
    expect(() => assertSlug("a")).not.toThrow();
  });

  it("rejects reserved, bad charset, length, edge hyphens", () => {
    expect(() => assertSlug("www")).toThrow(/reserved/i);
    expect(() => assertSlug("Admin")).toThrow(/reserved/i);
    expect(() => assertSlug("-ab")).toThrow();
    expect(() => assertSlug("ab-")).toThrow();
    expect(() => assertSlug("has_underscore")).toThrow();
    expect(() => assertSlug("a".repeat(33))).toThrow();
    for (const r of ["api", "admin", "mail", "connect", "status", "cdn", "static", "owner", "ftp"]) {
      expect(RESERVED_SLUGS.has(r)).toBe(true);
    }
  });

  it("returns the normalized slug", () => {
    expect(assertSlug("  Alice-01 ")).toBe("alice-01");
  });

  it("rejects empty and whitespace-only input", () => {
    expect(() => assertSlug("")).toThrow();
    expect(() => assertSlug("   ")).toThrow();
  });

  it("accepts exactly 32 characters", () => {
    expect(() => assertSlug("a".repeat(32))).not.toThrow();
  });
});
