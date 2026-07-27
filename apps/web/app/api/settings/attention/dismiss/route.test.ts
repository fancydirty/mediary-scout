import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, connection: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../../../../../lib/demo-mode", () => ({ isDemoMode: vi.fn(() => false) }));
vi.mock("../../../../../lib/settings-attention-server", () => ({
  dismissSettingsAttentionItem: vi.fn(async () => {}),
}));
vi.mock("../../../../../lib/workflow-runtime", () => {
  class UnauthenticatedAccountError extends Error {}
  return {
    requireAuthenticatedAccountId: vi.fn(async () => "acct_default"),
    UnauthenticatedAccountError,
  };
});

import { isDemoMode } from "../../../../../lib/demo-mode";
import { dismissSettingsAttentionItem } from "../../../../../lib/settings-attention-server";
import {
  requireAuthenticatedAccountId,
  UnauthenticatedAccountError,
} from "../../../../../lib/workflow-runtime";
import { POST } from "./route";

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/settings/attention/dismiss", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/settings/attention/dismiss", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isDemoMode as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (requireAuthenticatedAccountId as ReturnType<typeof vi.fn>).mockResolvedValue("acct_default");
  });

  it("records a valid dismissal for the authenticated account", async () => {
    const res = await post({ id: "frozen:cs1" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(dismissSettingsAttentionItem).toHaveBeenCalledWith("acct_default", "frozen:cs1");
  });

  it("rejects unknown/garbage ids with 400 (bounded write surface)", async () => {
    for (const id of ["", "update_available", "../x", "frozen:", 42, undefined]) {
      const res = await post({ id });
      expect(res.status).toBe(400);
    }
    expect(dismissSettingsAttentionItem).not.toHaveBeenCalled();
  });

  it("401 when unauthenticated", async () => {
    (requireAuthenticatedAccountId as ReturnType<typeof vi.fn>).mockRejectedValue(
      new UnauthenticatedAccountError(),
    );
    const res = await post({ id: "missing_llm" });
    expect(res.status).toBe(401);
    expect(dismissSettingsAttentionItem).not.toHaveBeenCalled();
  });

  it("403 in demo mode (read-only)", async () => {
    (isDemoMode as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const res = await post({ id: "missing_llm" });
    expect(res.status).toBe(403);
    expect(dismissSettingsAttentionItem).not.toHaveBeenCalled();
  });
});
