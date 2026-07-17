import { describe, expect, it } from "vitest";
import { maskProviderUid } from "./mask-provider-uid";

describe("maskProviderUid(设置页盘卡的 uid 展示)", () => {
  it("手机号形 uid 打码中段(天翼 loginName 带 @189.cn 后缀也认,展示去后缀)", () => {
    expect(maskProviderUid("17358529532")).toBe("173****9532");
    expect(maskProviderUid("17358529532@189.cn")).toBe("173****9532");
  });

  it("长 uid 中段截断(夸克/光鸭式随机串)", () => {
    expect(maskProviderUid("AARtNzjHERIBIZ2mQ8SE5Kr2")).toBe("AARt…5Kr2");
    expect(maskProviderUid("aj6Qo5l86EF4O2AM")).toBe("aj6Q…O2AM");
  });

  it("短 uid 原样(115/123 的数字 id)", () => {
    expect(maskProviderUid("103164004")).toBe("103164004");
    expect(maskProviderUid("1843112717")).toBe("1843112717");
  });

  it("空值兜底为空串", () => {
    expect(maskProviderUid("")).toBe("");
  });
});
