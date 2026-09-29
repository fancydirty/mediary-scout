import { describe, expect, it } from "vitest";
import { normalizeCommit, shortCommit } from "./deployment-update";

const CURRENT = "1111111111111111111111111111111111111111";

describe("normalizeCommit", () => {
  it("accepts exactly 40 lowercase/uppercase hex chars", () => {
    expect(normalizeCommit(CURRENT.toUpperCase())).toBe(CURRENT);
  });

  it("rejects unknown and short build stamps", () => {
    expect(normalizeCommit("unknown")).toBeNull();
    expect(normalizeCommit("1111111")).toBeNull();
    expect(normalizeCommit(`${CURRENT}junk`)).toBeNull();
  });

  it("rejects 39-char prefix and non-hex content", () => {
    expect(normalizeCommit(CURRENT.slice(0, 39))).toBeNull();
    expect(normalizeCommit("g".repeat(40))).toBeNull();
  });
});

describe("shortCommit", () => {
  it("takes the first 7 chars, and passes null through", () => {
    expect(shortCommit(CURRENT)).toBe("1111111");
    expect(shortCommit(null)).toBeNull();
  });
});
