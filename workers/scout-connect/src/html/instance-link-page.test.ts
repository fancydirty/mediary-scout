import { describe, expect, it } from "vitest";
import { instanceLinkPage } from "./instance-link-page.js";

/** Runs the page's inline confirm script against a minimal fake DOM and one fetch answer. */
async function clickConfirm(status: number | "network-error") {
  const html = instanceLinkPage({
    kind: "pending",
    email: "a@example.com",
    verifyCode: "7K3P",
    requestIp: "192.0.2.8",
    requestedAt: "2026-10-03T00:00:00.000Z",
  });
  const script = /<script type="module">([\s\S]*?)<\/script>/.exec(html)![1]!;
  let onClick: (() => Promise<void>) | null = null;
  const button = {
    disabled: false,
    removed: false,
    addEventListener: (_type: string, handler: () => Promise<void>) => { onClick = handler; },
    remove() { this.removed = true; },
  };
  const msg = { hidden: true, textContent: "" };
  const heading = { textContent: "确认连接" };
  const document = {
    getElementById: (id: string) => (id === "btn" ? button : id === "msg" ? msg : null),
    querySelector: (selector: string) => (selector === "h1" ? heading : null),
  };
  const fetch = async () => {
    if (status === "network-error") throw new TypeError("failed");
    return { ok: status >= 200 && status < 300, status };
  };
  new Function("document", "location", "fetch", script)(document, { search: "?t=tok" }, fetch);
  await onClick!();
  return { button, msg, heading };
}

describe("instanceLinkPage confirm button", () => {
  it.each([200, 409])("shows the confirmed state and removes the button on %s", async (status) => {
    const { button, msg, heading } = await clickConfirm(status);
    expect(heading.textContent).toBe("连接已确认");
    expect(button.removed).toBe(true);
    expect(msg.hidden).toBe(false);
    expect(msg.textContent).toBe("已确认，回到实例页面即可。");
  });

  it("removes the button when the link expired, since trying again cannot work", async () => {
    const { button, msg } = await clickConfirm(410);
    expect(button.removed).toBe(true);
    expect(msg.textContent).toBe("链接已失效，请回到实例页面重新发起。");
  });

  it.each([500, "network-error"] as const)("lets the visitor try again after %s", async (status) => {
    const { button, msg } = await clickConfirm(status);
    expect(button.removed).toBe(false);
    expect(button.disabled).toBe(false);
    expect(msg.hidden).toBe(false);
  });
});

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
    expect(html).toContain("请核对实例页面上显示的核对码也是 7K3P");
    expect(html).toContain('aria-label="核对码"');
    expect(html).not.toContain("验证码");
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
