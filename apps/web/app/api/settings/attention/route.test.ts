import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, connection: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../../../../lib/settings-attention-server", () => ({
  loadSettingsAttentionSummary: vi.fn(),
}));

vi.mock("../../../../lib/workflow-runtime", () => ({
  resolveGlobalWorkspace: vi.fn(),
}));

import { GET } from "./route";
import { loadSettingsAttentionSummary } from "../../../../lib/settings-attention-server";
import { resolveGlobalWorkspace } from "../../../../lib/workflow-runtime";

describe("GET /api/settings/attention", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns summary json and forwards workspace", async () => {
    (resolveGlobalWorkspace as ReturnType<typeof vi.fn>).mockResolvedValue({
      activeStorageId: "cs_other",
    });
    (loadSettingsAttentionSummary as ReturnType<typeof vi.fn>).mockResolvedValue({
      count: 1,
      severity: "warning",
      items: [{ id: "update_available", kind: "update_available", href: "/settings?w=cs_other" }],
    });
    const res = await GET(new NextRequest("http://localhost/api/settings/attention?w=cs_other"));
    expect(resolveGlobalWorkspace).toHaveBeenCalledWith("cs_other");
    expect(loadSettingsAttentionSummary).toHaveBeenCalledWith({ activeStorageId: "cs_other" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ count: 1, severity: "warning" });
  });

  it("fails quiet to empty summary", async () => {
    (resolveGlobalWorkspace as ReturnType<typeof vi.fn>).mockResolvedValue({
      activeStorageId: undefined,
    });
    (loadSettingsAttentionSummary as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));
    const res = await GET(new NextRequest("http://localhost/api/settings/attention"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ count: 0, severity: null, items: [] });
  });
});
