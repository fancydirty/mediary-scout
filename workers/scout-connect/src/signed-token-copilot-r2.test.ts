import { describe, expect, it } from "vitest";
import { verifyToken, signToken } from "./signed-token.js";

const KEY = "a".repeat(64);

describe("verifyToken non-finite now must fail closed", () => {
  it("now=NaN must reject token, not make it immortal", async () => {
    const token = await signToken(
      { purpose: "magic", subject: "test@example.com" },
      { key: KEY, ttlMs: 60_000, now: Date.parse("2026-07-28T00:00:00.000Z") },
    );
    const result = await verifyToken(token, {
      key: KEY,
      now: NaN,
      expectPurpose: "magic",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  it("now=Infinity must reject", async () => {
    const token = await signToken(
      { purpose: "magic", subject: "test@example.com" },
      { key: KEY, ttlMs: 60_000, now: Date.parse("2026-07-28T00:00:00.000Z") },
    );
    const result = await verifyToken(token, {
      key: KEY,
      now: Infinity,
      expectPurpose: "magic",
    });
    expect(result.ok).toBe(false);
  });
});
