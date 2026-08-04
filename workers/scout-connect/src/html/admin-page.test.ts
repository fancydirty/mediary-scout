import { describe, expect, it } from "vitest";
import { adminPage } from "./admin-page.js";

describe("admin page", () => {
  // SEO 审计 P0(真实发现):/admin 未登录即返回完整管理页 HTML(标题
  // 「Mediary Connect Admin」、含「邀请/token」字样),且**没有任何 noindex**。
  // 数据本身有 API 鉴权,但页面进索引等于对外公布管理入口 —— 搜一下就能发现。
  it("有 noindex —— 管理页绝不能进搜索索引(P0)", () => {
    // 用正则而不是精确字符串:content 里还有 nofollow/noarchive,
    // 精确匹配会在加指令时误红(而加指令是更严格、不是更宽松)。
    expect(adminPage()).toMatch(/name="robots" content="noindex\b/);
  });

  it("noindex 同时禁止跟随链接与快照(nofollow/noarchive)", () => {
    // 管理页里的链接不该被爬,历史快照也不该被留存。
    const html = adminPage();
    expect(html).toMatch(/name="robots" content="[^"]*nofollow/);
    expect(html).toMatch(/name="robots" content="[^"]*noarchive/);
  });
});
