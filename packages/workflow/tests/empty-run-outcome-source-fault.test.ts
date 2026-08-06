import { describe, expect, it } from "vitest";
import { emptyRunOutcome } from "../src/notification-report.js";

/**
 * 这是整个 PR 真正要证明的东西:源挂了的时候,用户读到的那句话变了。
 * 前面所有 task 都只是让故障「可被检测」;只有这一层改变了用户看见什么。
 */
describe("emptyRunOutcome — 搜索源故障要说真话", () => {
  it("源故障时不再说「暂未找到可用资源」", () => {
    const out = emptyRunOutcome(null, "自建搜索源 本轮连不上，没能取回任何候选。");

    expect(out.lines.join("")).not.toContain("暂未找到可用资源");
    expect(out.lines.join("")).toContain("连不上");
    // failed 而非 no_coverage:no_coverage 会把它归进「确实没有、继续等」那一桶。
    expect(out.status).toBe("failed");
  });

  it("没有任何故障时,仍然如实报「暂未找到可用资源」（关键对照组）", () => {
    // 若这条断言坏掉,产品就再也无法如实报告「确实没有」—— 那比它要修的 bug 更糟。
    const out = emptyRunOutcome(null, null);

    expect(out.status).toBe("no_coverage");
    expect(out.lines).toEqual(["暂未找到可用资源 · 将持续尝试"]);
  });

  it("空串/空白的源故障原因不算故障（不因脏数据误报）", () => {
    expect(emptyRunOutcome(null, "").status).toBe("no_coverage");
    expect(emptyRunOutcome(null, "   ").status).toBe("no_coverage");
  });

  it("转存受阻优先于搜索源故障", () => {
    // 能走到转存说明资源已经找到过了,用户的问题是配额/登录这种立刻可动手的事;
    // 报搜索源故障只会让他去查一个其实工作过的源。
    const out = emptyRunOutcome("配额不足", "搜索源连不上");

    expect(out.lines.join("")).toContain("转存失败:配额不足");
    expect(out.lines.join("")).not.toContain("搜索源");
  });

  it("转存受阻仍然照旧工作（未被新分支破坏）", () => {
    const out = emptyRunOutcome("登录过期", null);

    expect(out.status).toBe("failed");
    expect(out.lines).toEqual(["转存失败:登录过期"]);
  });
});
