import { describe, expect, it, vi } from "vitest";
import { createPaddleApi } from "./paddle-api.js";

/**
 * getTransactionStatus 的错误分类(实测抓到的真实缺陷):
 *
 * 第一版对任何非 2xx 都返回 null —— Paddle 5xx/429 被当成"交易不存在",
 * 轮询端点据此返回 404,前端停止轮询,用户卡死。正确分类:
 *   404 → null(交易不存在,合法)
 *   其它非 2xx → throw(上游故障,端点返回 503 可重试)
 */
describe("getTransactionStatus 错误分类", () => {
  const T = "txn_aaaaaaaaaaaaaaaaaaaaaaaaaa";
  const api = (status: number, body: unknown) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status })),
    );
    return createPaddleApi({ apiKey: "k", environment: "production" });
  };

  it("404 → null(交易不存在)", async () => {
    const a = api(404, { error: "not found" });
    await expect(a.getTransactionStatus(T)).resolves.toBeNull();
  });

  it("500 → throw(上游故障,不能当交易不存在)", async () => {
    const a = api(500, { error: "boom" });
    await expect(a.getTransactionStatus(T)).rejects.toThrow("500");
  });

  it("429 → throw(限流也是可重试的)", async () => {
    const a = api(429, { error: "rate limited" });
    await expect(a.getTransactionStatus(T)).rejects.toThrow("429");
  });

  it("200 → 解析 status/billed_at/account_email", async () => {
    const a = api(200, {
      data: {
        id: T,
        status: "completed",
        billed_at: "2026-08-01T06:56:46.198368Z",
        custom_data: { account_email: "me@example.com" },
      },
    });
    await expect(a.getTransactionStatus(T)).resolves.toEqual({
      status: "completed",
      paidAt: "2026-08-01T06:56:46.198368Z",
      accountEmail: "me@example.com",
    });
  });

  it("200 但 body 畸形(无 data.id)→ null", async () => {
    const a = api(200, { data: {} });
    await expect(a.getTransactionStatus(T)).resolves.toBeNull();
  });
});
