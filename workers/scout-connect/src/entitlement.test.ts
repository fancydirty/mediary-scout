import { describe, expect, it } from "vitest";
import { addMonths, computeExpiry, isEntitlementActive, recomputeExpiry } from "./entitlement.js";

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

describe("recomputeExpiry 的排序稳健性", () => {
  const row = (id: string, created: string, months: number, expires = "2027-01-01T00:00:00.000Z") => ({
    id,
    created_at: created,
    months,
    expires_at: expires,
  });

  // 坏值让 Date.parse 得 NaN,比较器返回 NaN 等同返回 0 → 排序保证静默失效。
  // 实测一个坏值就能把 2026-03 排到 2026-01 前面。localeCompare 对坏值仍给
  // 确定顺序,结果可复现。
  it("created_at 含坏值时仍给确定结果(不因 NaN 乱序)", () => {
    const rows = [row("a", "2026-03-01T00:00:00.000Z", 1), row("b", "BAD", 12), row("c", "2026-01-01T00:00:00.000Z", 3)];
    const first = recomputeExpiry(rows);
    // 多次调用、不同输入顺序,结果必须一致(确定性才是这里的核心保证)
    for (const shuffled of [
      [rows[2]!, rows[0]!, rows[1]!],
      [rows[1]!, rows[2]!, rows[0]!],
    ]) {
      expect(recomputeExpiry(shuffled)).toBe(first);
    }
  });

  // 同毫秒时前两个键都可能相等 —— 尤其自愈会把同账号多行的 expires_at 写成
  // 同一个值。此时若无 id 兜底,顺序交给 DB,而月加法不满足结合律
  // (月末钳位有损),不同顺序真会差一天。
  it("同 created_at 同 expires_at 时靠 id 定序(结果与输入顺序无关)", () => {
    const same = "2026-01-31T00:00:00.000Z";
    const exp = "2027-01-31T00:00:00.000Z";
    const a = row("id_a", same, 1, exp);
    const b = row("id_b", same, 2, exp);
    expect(recomputeExpiry([a, b])).toBe(recomputeExpiry([b, a]));
  });

  it("月加法不满足结合律 —— 所以顺序保证是必需的", () => {
    // 这条是上面那个测试存在的理由:月末钳位有损,顺序真的影响结果
    expect(addMonths(addMonths("2026-01-31T00:00:00.000Z", 1), 1)).not.toBe(
      addMonths("2026-01-31T00:00:00.000Z", 2),
    );
  });

  // 坏 created_at 会让 addMonths 里的 new Date("BAD") 成为 Invalid Date,
  // toISOString() 抛 RangeError → 冒到 webhook 就是 500 → 无限重投。
  // 重算的职责是「用能用的数据算出真值」,不是整笔崩掉 ——
  // 崩掉会连带让好的那些行也拿不到时长。
  it("坏行被跳过而不抛错,好行仍正确计入", () => {
    const good = row("g", "2026-01-01T00:00:00.000Z", 12);
    const badDate = row("b", "NOT-A-DATE", 12);
    const badMonths = { ...row("m", "2026-02-01T00:00:00.000Z", 0), months: 0 };
    expect(() => recomputeExpiry([good, badDate, badMonths])).not.toThrow();
    // 只有 good 计入 → 2026-01-01 + 12 个月
    expect(recomputeExpiry([good, badDate, badMonths])).toBe("2027-01-01T00:00:00.000Z");
  });

  it("全是坏行时返回 null 而不抛错", () => {
    expect(recomputeExpiry([row("a", "BAD", 12), row("b", "", 12)])).toBeNull();
  });

  it("空账本返回 null", () => {
    expect(recomputeExpiry([])).toBeNull();
  });
});
