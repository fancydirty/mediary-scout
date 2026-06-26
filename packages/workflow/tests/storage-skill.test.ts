import { describe, expect, it } from "vitest";
import { getStorageSkill, readSkillSection } from "../src/index.js";

describe("brand-aware storage skill", () => {
  it("getStorageSkill('quark') teaches 转存分享, 无磁力, and fail-loud codes", () => {
    const quark = getStorageSkill("quark");
    expect(quark).toContain("转存分享");
    expect(quark).toMatch(/无磁力|NO magnet|没有.*磁力/i);
    expect(quark).toContain("41006"); // 分享不存在 fail-loud code
    expect(quark).toContain("夸克");
  });

  it("getStorageSkill('pan115') keeps the 115 transfer model (秒传/magnet)", () => {
    const pan115 = getStorageSkill("pan115");
    expect(pan115).toContain("115");
    expect(pan115).toMatch(/秒传/);
    expect(pan115).toMatch(/magnet/i);
    expect(pan115).not.toContain("41006"); // 115 has no quark codes
  });

  it("getStorageSkill('guangya') teaches the magnet/offline-task model and does NOT throw", () => {
    const guangya = getStorageSkill("guangya");
    expect(guangya).toBeTruthy();
    expect(guangya.length).toBeGreaterThan(0);
    // magnet/offline drive: candidates are magnets resolved → offline task → poll
    expect(guangya).toMatch(/磁力|magnet/i);
    expect(guangya).toMatch(/光鸭/);
    // a 115/quark/光鸭 SHARE link is rejected loud on this magnet-only drive
    expect(guangya).toContain("GUANGYA_ONLY_MAGNET");
    // must NOT mislead with 115-only 秒传 wording
    expect(guangya).not.toMatch(/秒传/);
    // must NOT carry quark fail-loud codes
    expect(guangya).not.toContain("41006");
  });

  it("getStorageSkill throws for an unknown brand", () => {
    expect(() => getStorageSkill("baidu")).toThrowError(/unknown storage brand/i);
  });

  it.each(["pan115", "quark", "guangya"])(
    "%s teaches the systemic-block STOP rule (quota/auth = account problem, not a dead link)",
    (brand) => {
      const skill = getStorageSkill(brand);
      // distinguishes a systemic ACCOUNT block from an ordinary dead link
      expect(skill).toMatch(/系统性|systemic|账号|account/i);
      expect(skill).toMatch(/配额|额度|VIP|登录|鉴权/);
      // it must tell the agent to STOP, not keep grinding every candidate
      expect(skill).toMatch(/立即停|STOP|不要(再|继续)|别(再|继续)/i);
      expect(skill).toContain("systemicBlock"); // the surfaced tool field
      // and NOT report "no resource" (the resource exists)
      expect(skill).toMatch(/资源.*(存在|有)|不是.*没有?资源|别甩锅/);
    },
  );

  it("readSkillSection selects the brand variant for dead-links-black-box", () => {
    expect(readSkillSection("dead-links-black-box", "quark")).toBe(getStorageSkill("quark"));
    expect(readSkillSection("dead-links-black-box", "pan115")).toBe(getStorageSkill("pan115"));
    expect(readSkillSection("dead-links-black-box", "guangya")).toBe(getStorageSkill("guangya"));
    // defaults to 115 when no brand is given (single-user / legacy)
    expect(readSkillSection("dead-links-black-box")).toBe(getStorageSkill("pan115"));
  });

  it("readSkillSection still serves shared sections regardless of brand", () => {
    expect(readSkillSection("protocol", "quark")).toContain("Evidence");
    expect(readSkillSection("dedup", "quark")).toContain("larger");
    expect(readSkillSection("nope", "quark")).toContain("Unknown skill section");
  });
});
