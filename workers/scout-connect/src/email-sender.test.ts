import { describe, expect, it } from "vitest";
import { expiryReminderText } from "./email-sender.js";

describe("expiryReminderText", () => {
  it("包含到期日、剩余天数、宽限语义、续期入口", () => {
    const text = expiryReminderText({
      expiryDate: "2026-08-06",
      daysLeft: 7,
      hostname: "alice.mediaryconnect.app",
    });
    expect(text).toContain("2026-08-06");
    expect(text).toContain("还有 7 天");
    expect(text).toContain("7 天宽限期");
    // 必须写清「立即回收」与「续期需重跑接入命令」—— 与新条款措辞一致,
    // 否则用户以为续期即自动恢复。
    expect(text).toContain("回收隧道");
    expect(text).toContain("重跑一次一行接入命令");
    expect(text).toContain("alice.mediaryconnect.app");
    expect(text).toContain("/pricing");
    expect(text).toContain("/login");
    expect(text).toContain("DF Digital");
    expect(text).toContain("Paddle");
  });

  it("无 hostname(未开通)时不提专属地址", () => {
    const text = expiryReminderText({ expiryDate: "2026-08-06", daysLeft: 7, hostname: null });
    expect(text).not.toContain("专属地址");
    expect(text).toContain("/pricing");
  });

  // 纯文本是刻意的:事务性邮件带重 HTML 反而更容易被判 spam。
  it("是纯文本,不含 HTML 标签", () => {
    const text = expiryReminderText({ expiryDate: "2026-08-06", daysLeft: 1, hostname: null });
    expect(text).not.toMatch(/<a |<div|<p>|<button/);
  });
});
