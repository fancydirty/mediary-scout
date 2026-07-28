import { describe, expect, it } from "vitest";
import { checkSlug, suggestSlugs } from "./slug-availability.js";

describe("checkSlug", () => {
  const taken = new Set(["alice", "bob", "reserved-ish"]);
  const isTaken = async (s: string) => taken.has(s);

  it("available when valid and not taken", async () => {
    expect(await checkSlug("charlie", isTaken)).toEqual({ available: true });
  });

  it("unavailable + suggestions when taken", async () => {
    const r = await checkSlug("alice", isTaken);
    expect(r.available).toBe(false);
    if (!r.available) {
      expect(r.suggestions.length).toBeGreaterThan(0);
      for (const s of r.suggestions) expect(taken.has(s)).toBe(false);
    }
  });

  it("invalid slug → available:false with reason, no suggestions from garbage", async () => {
    const r = await checkSlug("A B!", isTaken);
    expect(r.available).toBe(false);
    if (!r.available) expect(r.reason).toBe("invalid");
  });

  it("reserved slug → unavailable with reason", async () => {
    const r = await checkSlug("admin", isTaken);
    expect(r.available).toBe(false);
    if (!r.available) expect(r.reason).toBe("reserved");
  });
});

describe("suggestSlugs", () => {
  it("appends numbers and skips taken ones", async () => {
    const taken = new Set(["alice", "alice1", "alice2"]);
    const out = await suggestSlugs("alice", async (s) => taken.has(s), 3);
    expect(out).not.toContain("alice");
    expect(out).not.toContain("alice1");
    expect(out).not.toContain("alice2");
    expect(out.length).toBe(3);
    // 全部可用且形状合法
    for (const s of out) {
      expect(taken.has(s)).toBe(false);
      expect(s.startsWith("alice")).toBe(true);
    }
  });

  it("normalizes the base before suggesting (trims/lowercases)", async () => {
    const out = await suggestSlugs("  Alice  ", async () => false, 2);
    for (const s of out) expect(s).toMatch(/^alice/);
  });

  it("gives up gracefully if everything is taken (bounded attempts)", async () => {
    const out = await suggestSlugs("x", async () => true, 3);
    expect(Array.isArray(out)).toBe(true); // 不死循环;可能空或少于 3
    expect(out.length).toBeLessThanOrEqual(3);
  });
});
