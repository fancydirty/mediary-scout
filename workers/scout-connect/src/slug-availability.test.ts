import { describe, expect, it } from "vitest";
import { checkSlug, suggestSlugs, type IsTaken } from "./slug-availability.js";

const noneTaken: IsTaken = async () => false;
const allTaken: IsTaken = async () => true;

describe("保留字被拒时,候选名不得以该保留字为 base", () => {
  // 黑名单的目的是防商标侵权(CF Zero Trust 条款)+ 防冒充站方/钓鱼。
  // 而早先实现拒了 `admin` 却推荐 `admin1`、拒了 `paypal` 推荐 `paypal1` ——
  // 等于把风险重新递给用户,与黑名单的意图直接冲突。
  it.each(["admin", "paypal", "google", "apple", "root", "support", "help"])(
    "拒 %s 时,候选名不含 %s 前缀",
    async (reserved) => {
      const r = await checkSlug(reserved, noneTaken);
      expect(r.available).toBe(false);
      if (r.available) return;
      expect(r.reason).toBe("reserved");
      for (const sug of r.suggestions) {
        expect(sug.startsWith(reserved), `候选 ${sug} 不该以 ${reserved} 为 base`).toBe(false);
      }
    },
  );

  it("保留字被拒时仍有候选(不是空手而归)", async () => {
    const r = await checkSlug("admin", noneTaken);
    expect(r.available).toBe(false);
    if (r.available) return;
    // 给一组与被拒词无关的通用备选,帮用户起步,但不顺着被拒词的方向
    expect(r.suggestions.length).toBeGreaterThan(0);
  });
});

describe("taken(非保留字被占用)仍可以 base 为根给候选", () => {
  // taken 与 reserved 不同:`alice` 被占了,推荐 `alice1`/`alice-nas` 是合理的
  // —— 用户想要的就是这个方向,只是名字被占了。问题只在保留字分支。
  it("alice 被占 → 推荐 alice 系变体", async () => {
    const taken: IsTaken = async (s) => s === "alice";
    const r = await checkSlug("alice", taken);
    expect(r.available).toBe(false);
    if (r.available) return;
    expect(r.reason).toBe("taken");
    expect(r.suggestions.some((s) => s.startsWith("alice"))).toBe(true);
  });
});

describe("基础分支(回归护栏)", () => {
  it("合法且未占用 → available:true", async () => {
    const r = await checkSlug("alice-nas-2024", noneTaken);
    expect(r).toEqual({ available: true });
  });

  it("形状非法 → invalid,不生成候选", async () => {
    const r = await checkSlug("!!!", noneTaken);
    expect(r.available).toBe(false);
    if (r.available) return;
    expect(r.reason).toBe("invalid");
    expect(r.suggestions).toEqual([]);
  });
});

describe("suggestSlugs 本身的行为不变", () => {
  it("跳过已占用与形状不合法的候选", async () => {
    const taken: IsTaken = async (s) => s === "alice1" || s === "alice-nas";
    const out = await suggestSlugs("alice", taken, 3);
    expect(out).not.toContain("alice1");
    expect(out).not.toContain("alice-nas");
    expect(out.length).toBeLessThanOrEqual(3);
  });

  it("全部被占 → 空数组", async () => {
    expect(await suggestSlugs("alice", allTaken, 3)).toEqual([]);
  });
});
