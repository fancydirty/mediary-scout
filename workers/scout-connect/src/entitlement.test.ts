import { describe, expect, it } from "vitest";
import { addMonths, computeExpiry, isEntitlementActive } from "./entitlement.js";

describe("entitlement 时长计算", () => {
  describe("addMonths", () => {
    it("adds whole months, clamping day-of-month overflow", () => {
      // 1/31 + 1 month → 2/28（不溢出到 3/3）
      expect(addMonths("2026-01-31T00:00:00.000Z", 1)).toBe("2026-02-28T00:00:00.000Z");
      expect(addMonths("2026-07-28T12:00:00.000Z", 12)).toBe("2027-07-28T12:00:00.000Z");
      expect(addMonths("2026-11-30T00:00:00.000Z", 3)).toBe("2027-02-28T00:00:00.000Z");
    });
  });

  describe("computeExpiry", () => {
    const now = "2026-07-28T00:00:00.000Z";

    it("first purchase: from now", () => {
      // 无既有时长 → 从当下起算
      expect(computeExpiry({ currentExpiry: null, months: 12, now })).toBe(
        "2027-07-28T00:00:00.000Z",
      );
    });

    it("renewal while still active: stacks on top of the existing expiry", () => {
      // 未到期续费 → 从原到期时刻叠加，不浪费剩余时长
      expect(
        computeExpiry({ currentExpiry: "2027-01-28T00:00:00.000Z", months: 12, now }),
      ).toBe("2028-01-28T00:00:00.000Z");
    });

    it("renewal after expiry: restarts from now, not from the stale expiry", () => {
      // 已过期再充 → 从现在起算，不把断掉的时间补回来
      expect(
        computeExpiry({ currentExpiry: "2026-01-28T00:00:00.000Z", months: 3, now }),
      ).toBe("2026-10-28T00:00:00.000Z");
    });

    it("expiry exactly equal to now counts as expired (restart from now)", () => {
      expect(computeExpiry({ currentExpiry: now, months: 1, now })).toBe(
        "2026-08-28T00:00:00.000Z",
      );
    });
  });

  describe("isEntitlementActive", () => {
    it("active when latest expiry is in the future", () => {
      expect(isEntitlementActive("2027-01-01T00:00:00.000Z", "2026-07-28T00:00:00.000Z")).toBe(true);
    });
    it("inactive when expiry is in the past", () => {
      expect(isEntitlementActive("2026-01-01T00:00:00.000Z", "2026-07-28T00:00:00.000Z")).toBe(false);
    });
    it("null expiry is inactive (no entitlement ever)", () => {
      expect(isEntitlementActive(null, "2026-07-28T00:00:00.000Z")).toBe(false);
    });
    it("unparseable expiry is inactive (fail closed, never grant on garbage)", () => {
      expect(isEntitlementActive("not-a-date", "2026-07-28T00:00:00.000Z")).toBe(false);
    });
  });
});
