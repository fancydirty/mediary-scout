import { describe, expect, it } from "vitest";
import {
  GRACE_PERIOD_DAYS,
  daysLeftInGrace,
  daysUntilExpiry,
  graceUntil,
  phaseOf,
  reminderKind,
} from "./expiry.js";

const T0 = "2026-07-30T12:00:00.000Z";

describe("GRACE_PERIOD_DAYS", () => {
  it("是 7 天(与条款承诺一致)", () => {
    expect(GRACE_PERIOD_DAYS).toBe(7);
  });
});

describe("phaseOf —— 三态边界(最容易算错的地方)", () => {
  it("未到期 → active", () => {
    expect(phaseOf("2026-08-01T00:00:00.000Z", T0)).toBe("active");
    expect(phaseOf("2026-07-30T12:00:00.001Z", T0)).toBe("active"); // 刚好差 1ms
  });

  it("到期瞬间起 → grace(到期当天服务仍照常)", () => {
    expect(phaseOf("2026-07-30T12:00:00.000Z", T0)).toBe("grace");
    expect(phaseOf("2026-07-30T11:00:00.000Z", T0)).toBe("grace");
  });

  it("宽限最后一天仍是 grace", () => {
    // 到期 7-29 → 宽限到 8-05 23:59:59 都算 grace
    expect(phaseOf("2026-07-29T00:00:00.000Z", "2026-08-04T23:59:59.999Z")).toBe("grace");
  });

  it("宽限期满次日 → expired", () => {
    // 到期 7-29 → 宽限 7 天 → 8-05 当天就该回收
    expect(phaseOf("2026-07-29T00:00:00.000Z", "2026-08-05T00:00:00.001Z")).toBe("expired");
  });

  // 边界必须精确:到期 + 7 天的那个时刻本身,是 grace 的最后瞬间。
  it("宽限截止的精确瞬间仍是 grace,过 1ms 即 expired", () => {
    const expiry = "2026-07-23T00:00:00.000Z";
    const boundary = graceUntil(expiry); // 2026-07-30T00:00:00.000Z
    expect(phaseOf(expiry, boundary)).toBe("grace");
    expect(phaseOf(expiry, "2026-07-30T00:00:00.001Z")).toBe("expired");
  });

  it("从未付费(null)→ expired(该回收,不算 active)", () => {
    expect(phaseOf(null, T0)).toBe("expired");
  });

  // 坏值偏保守:算不出到期却继续占着隧道,才是真的超卖。
  it.each([
    ["BAD", T0],
    [T0, "BAD"],
    ["", ""],
  ])("坏值 (%s / %s) 判 expired 而不抛错", (expiry, now) => {
    expect(() => phaseOf(expiry, now)).not.toThrow();
    expect(phaseOf(expiry, now)).toBe("expired");
  });
});

describe("daysUntilExpiry / daysLeftInGrace", () => {
  it("距到期的整天数", () => {
    expect(daysUntilExpiry("2026-08-06T12:00:00.000Z", T0)).toBe(7);
    expect(daysUntilExpiry("2026-07-31T12:00:00.000Z", T0)).toBe(1);
    expect(daysUntilExpiry("2026-07-30T12:00:01.000Z", T0)).toBe(1); // 不足一天也算 1
  });

  it("已过期返回 0", () => {
    expect(daysUntilExpiry("2026-07-29T00:00:00.000Z", T0)).toBe(0);
  });

  it("宽限期内的剩余天数", () => {
    // 到期 7-29,宽限到 8-05
    expect(daysLeftInGrace("2026-07-29T00:00:00.000Z", "2026-07-31T00:00:00.000Z")).toBe(5);
    expect(daysLeftInGrace("2026-07-29T00:00:00.000Z", "2026-08-05T00:00:00.000Z")).toBe(0);
  });
});

describe("reminderKind —— 到期前 7 天 / 1 天", () => {
  it("第 7 天提醒", () => {
    expect(reminderKind("2026-08-06T12:00:00.000Z", T0)).toBe("7d");
  });
  it("第 1 天提醒", () => {
    expect(reminderKind("2026-07-31T12:00:00.000Z", T0)).toBe("1d");
  });
  it("其它天不提醒", () => {
    expect(reminderKind("2026-08-05T12:00:00.000Z", T0)).toBeNull(); // 6 天
    expect(reminderKind("2026-07-29T00:00:00.000Z", T0)).toBeNull(); // 已过期
  });
});

describe("graceUntil", () => {
  it("到期 + 7 天", () => {
    expect(graceUntil("2026-07-23T00:00:00.000Z")).toBe("2026-07-30T00:00:00.000Z");
  });
});
