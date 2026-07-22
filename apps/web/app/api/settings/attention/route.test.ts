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
    const res = await GET(new NextRequest("http://localhost/api/settings/attention?w=cs_other"));
    expect(loadSettingsAttentionSummary).toHaveBeenCalledWith({ w: "cs_other" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ count: 1, severity: "warning", items: [] });
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
