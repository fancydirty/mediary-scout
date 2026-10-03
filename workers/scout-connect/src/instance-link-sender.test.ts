import { describe, expect, it, vi } from "vitest";
import { createInstanceLinkSender } from "./instance-link-sender.js";

describe("createInstanceLinkSender", () => {
  it("posts the confirmation message with escaped URL and metadata", async () => {
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.signal).toBeDefined();
      const payload = JSON.parse(String(init?.body));
      expect(payload.from).toContain("Mediary Connect");
      expect(payload.to).toEqual(["alice@example.com"]);
      expect(payload.subject).toBe("确认连接你的 Mediary Scout 实例");
      expect(payload.text).toContain("验证码：7K3P");
      expect(payload.text).toContain("192.0.2.8");
      expect(payload.html).toContain("&lt;script&gt;");
      expect(payload.html).not.toContain('<script>');
      expect(payload.html).toContain("7K3P");
      return new Response(null, { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await createInstanceLinkSender("resend-secret")("alice@example.com", {
      url: "https://mediaryconnect.app/link?t=\"><script>",
      verifyCode: "7K3P",
      requestIp: "192.0.2.8",
      requestedAt: "2026-10-03T00:00:00.000Z",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("logs and throws on a non-2xx response", async () => {
    const fetchMock = vi.fn(async () => new Response("no", { status: 503 }));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      createInstanceLinkSender("secret")("a@example.com", {
        url: "https://mediaryconnect.app/link?t=x",
        verifyCode: "7K3P",
        requestIp: "",
        requestedAt: "now",
      }),
    ).rejects.toThrow("resend failed: 503");
    expect(error).toHaveBeenCalledWith("resend instance link failed, status:", 503);
    error.mockRestore();
    vi.unstubAllGlobals();
  });
});
