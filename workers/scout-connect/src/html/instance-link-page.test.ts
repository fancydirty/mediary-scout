import { describe, expect, it } from "vitest";
import { instanceLinkPage } from "./instance-link-page.js";

describe("instanceLinkPage", () => {
  it("renders the pending confirmation details without a form or token", () => {
    const html = instanceLinkPage({
      kind: "pending",
      email: 'a<img src=x onerror=alert(1)>@example.com',
      verifyCode: "7K3P",
      requestIp: "192.0.2.8",
      requestedAt: "2026-10-03T00:00:00.000Z",
    });
    expect(html).toContain("a&lt;img src=x onerror=alert(1)&gt;@example.com");
    expect(html).toContain("请核对实例页面上显示的也是 7K3P");
    expect(html).toContain("只有你自己刚在实例的「设置 → 远程访问」里点了连接");
    expect(html).toContain("2026-10-03 08:00（北京时间）");
    expect(html).toContain('id="msg" role="status" aria-live="polite"');
    expect(html).toContain('fetch("/link",{method:"POST"');
    expect(html).not.toContain("<form");
    expect(html).not.toContain("secret-token");
  });

  it("renders expired and confirmed states", () => {
    expect(instanceLinkPage({ kind: "invalid" })).toContain("链接已失效，请回到实例页面重新发起。");
    expect(instanceLinkPage({ kind: "confirmed" })).toContain("已确认，回到实例页面即可。");
  });
});
