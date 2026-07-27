import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, connection: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../../../../lib/settings-attention-server", () => ({
  loadSettingsAttentionSummary: vi.fn(),
}));

import { GET } from "./route";
import { loadSettingsAttentionSummary } from "../../../../lib/settings-attention-server";

const fullItem = {
  id: "update_available",
  kind: "update_available",
  href: "/settings?w=cs_other",
  prompt: "long prompt",
};

describe("GET /api/settings/attention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (loadSettingsAttentionSummary as ReturnType<typeof vi.fn>).mockResolvedValue({
      count: 1,
      severity: "warning",
      items: [fullItem],
    });
  });

  it("returns count/severity and omits items by default (badge poll)", async () => {
    // NextRequest 由 URL 构造时不会带上 host 头，所以这里显式给一个——
    // 否则 origin 走的是 DEFAULT_LOCAL_ORIGIN 兜底，断言看着对、其实没在
    // 验证「从请求推导 origin」这件事（无 host 的兜底另有一条测试）。
    const res = await GET(
      new NextRequest("http://localhost:3300/api/settings/attention?w=cs_other", {
        headers: { host: "localhost:3300" },
      }),
    );
    expect(loadSettingsAttentionSummary).toHaveBeenCalledWith({
      w: "cs_other",
      origin: "http://localhost:3300",
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ count: 1, severity: "warning", items: [] });
  });

  it("falls back to the compose default when the request carries no host at all", async () => {
    await GET(new NextRequest("http://localhost/api/settings/attention"));
    expect(loadSettingsAttentionSummary).toHaveBeenCalledWith({
      w: null,
      origin: "http://localhost:3300",
    });
  });

  it("derives the prompt origin from the first forwarded hop (public tunnel origin)", async () => {
    await GET(
      new NextRequest("http://localhost/api/settings/attention", {
        headers: {
          "x-forwarded-proto": "https",
          "x-forwarded-host": "mediary.example.com",
        },
      }),
    );
    expect(loadSettingsAttentionSummary).toHaveBeenCalledWith({
      w: null,
      origin: "https://mediary.example.com",
    });
  });

  it("includes full items when items=1", async () => {
    const res = await GET(
      new NextRequest("http://localhost/api/settings/attention?w=cs_other&items=1"),
    );
    await expect(res.json()).resolves.toEqual({
      count: 1,
      severity: "warning",
      items: [fullItem],
    });
  });

  it("fails quiet to empty summary", async () => {
    (loadSettingsAttentionSummary as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));
    const res = await GET(new NextRequest("http://localhost/api/settings/attention"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ count: 0, severity: null, items: [] });
  });
});
