import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, connection: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../../../../lib/settings-attention-server", () => ({
  loadSettingsAttentionSummary: vi.fn(),
}));

import { GET } from "./route";
import { loadSettingsAttentionSummary } from "../../../../lib/settings-attention-server";

describe("GET /api/settings/attention", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns summary json", async () => {
    (loadSettingsAttentionSummary as ReturnType<typeof vi.fn>).mockResolvedValue({
      count: 1,
      severity: "warning",
      items: [{ id: "update_available", kind: "update_available" }],
    });
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ count: 1, severity: "warning" });
  });

  it("fails quiet to empty summary", async () => {
    (loadSettingsAttentionSummary as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ count: 0, severity: null, items: [] });
  });
});
