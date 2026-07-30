import { describe, expect, it } from "vitest";
import {
  ISSUE_TEXT,
  SLUG_MAX_LENGTH,
  sanitizeSlug,
  slugIssues,
} from "./slug-input.js";

describe("sanitizeSlug —— 输入即净化(消灭显示值与校验值的漂移)", () => {
  // 这是原实现最核心的 bug:输 `Alice` 显示 `Alice` 却提示「✓ 可用」,
  // 实际开通的是 `alice`。iOS 默认首字母大写,这是必然触发的。
  it("大写转小写(含 iOS 首字母大写)", () => {
    expect(sanitizeSlug("Alice")).toBe("alice");
    expect(sanitizeSlug("ALICE")).toBe("alice");
    expect(sanitizeSlug("MyNas")).toBe("mynas");
  });

  // 字母数字之间的非法序列 → 单个连字符(用户意图是分隔,不是删除粘连)。
  it("非法序列转连字符(空格/下划线/点视作分隔)", () => {
    expect(sanitizeSlug("my nas")).toBe("my-nas");
    expect(sanitizeSlug("my_nas")).toBe("my-nas");
    expect(sanitizeSlug("my.nas")).toBe("my-nas");
  });

  it("非分隔用途的垃圾字符直接删(全角/首尾)", () => {
    expect(sanitizeSlug("我的nas")).toBe("nas");
    expect(sanitizeSlug("   ")).toBe("");
  });

  it("连续连字符合成一个", () => {
    expect(sanitizeSlug("my--nas")).toBe("my-nas");
    expect(sanitizeSlug("a---b")).toBe("a-b");
  });

  it("去掉首尾连字符", () => {
    expect(sanitizeSlug("-alice-")).toBe("alice");
    expect(sanitizeSlug("--alice--")).toBe("alice");
  });

  it("超长截断到 32", () => {
    expect(sanitizeSlug("a".repeat(50)).length).toBe(SLUG_MAX_LENGTH);
  });

  it("混合场景", () => {
    expect(sanitizeSlug("  My--Home_NAS-  ")).toBe("my-home-nas");
  });

  it("全非法输入 → 空串", () => {
    expect(sanitizeSlug("我的")).toBe("");
    expect(sanitizeSlug("   ")).toBe("");
  });
});

describe("slugIssues —— 「还差什么」而非「哪里错了」", () => {
  it("可直接用 → 空数组", () => {
    expect(slugIssues("alice")).toEqual([]);
    expect(slugIssues("my-nas-2024")).toEqual([]);
  });

  it("空 → empty", () => {
    expect(slugIssues("")).toContain("empty");
  });

  it("太短(1-2 字符)给提示但不硬拒", () => {
    expect(slugIssues("ab")).toContain("too_short");
    expect(slugIssues("abc")).not.toContain("too_short");
  });

  it("超长", () => {
    expect(slugIssues("a".repeat(33))).toContain("too_long");
    expect(slugIssues("a".repeat(32))).not.toContain("too_long");
  });

  it("服务端若收到未净化值,首尾连字符仍被拦", () => {
    expect(slugIssues("-abc")).toContain("edge_hyphen");
    expect(slugIssues("abc-")).toContain("edge_hyphen");
  });

  it("每个 issue 都有给用户的文案", () => {
    for (const issue of slugIssues("")) {
      expect(ISSUE_TEXT[issue]).toBeTruthy();
    }
  });
});
