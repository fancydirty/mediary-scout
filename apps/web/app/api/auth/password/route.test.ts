import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("../../../../lib/demo-mode", () => ({ isDemoMode: () => false }));
vi.mock("../../../../lib/workflow-runtime", async () => {
  const actual = await vi.importActual<typeof import("../../../../lib/workflow-runtime")>(
    "../../../../lib/workflow-runtime",
  );
  return {
    isRemoteRequest: actual.isRemoteRequest,
    isMultiUserEnabled: vi.fn(() => false),
    hasLoginPassword: vi.fn(),
    setSingleUserPassword: vi.fn(async () => ({ ok: true })),
    clearSingleUserPassword: vi.fn(async () => undefined),
    requireAuthenticatedAccountId: vi.fn(async () => "acct_default"),
    UnauthenticatedAccountError: actual.UnauthenticatedAccountError,
  };
});

import { POST } from "./route";
import * as runtime from "../../../../lib/workflow-runtime";

// A request that came in through the Cloudflare tunnel (<slug>.mediaryconnect.app or
// the owner's own tunnel) carries Cloudflare headers; a LAN request has none.
const TUNNEL = { "cf-ray": "8f3-abc", "cf-connecting-ip": "203.0.113.7" };

function post(headers: Record<string, string> = {}, body: unknown = { password: "correct horse" }): NextRequest {
  return new NextRequest("http://localhost:3000/api/auth/password", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/password", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses to set the first password over the tunnel", async () => {
    // Until the owner sets one, anyone who finds the public hostname could set it
    // and sign in with the owner's drives and model keys.
    vi.mocked(runtime.hasLoginPassword).mockResolvedValue(false);
    const res = await POST(post(TUNNEL));
    expect(res.status).toBe(403);
    expect(runtime.setSingleUserPassword).not.toHaveBeenCalled();
  });

  it("sets the first password from the LAN", async () => {
    vi.mocked(runtime.hasLoginPassword).mockResolvedValue(false);
    const res = await POST(post());
    expect(res.status).toBe(200);
    expect(runtime.setSingleUserPassword).toHaveBeenCalledWith("correct horse");
  });

  it("lets a signed-in owner change an existing password over the tunnel", async () => {
    vi.mocked(runtime.hasLoginPassword).mockResolvedValue(true);
    const res = await POST(post(TUNNEL));
    expect(res.status).toBe(200);
    expect(runtime.requireAuthenticatedAccountId).toHaveBeenCalled();
    expect(runtime.setSingleUserPassword).toHaveBeenCalledWith("correct horse");
  });

  it("answers 401, not 500, when an existing password is changed or cleared without signing in", async () => {
    vi.mocked(runtime.hasLoginPassword).mockResolvedValue(true);
    vi.mocked(runtime.requireAuthenticatedAccountId).mockRejectedValue(new runtime.UnauthenticatedAccountError());
    const change = await POST(post(TUNNEL));
    const clear = await POST(post(TUNNEL, { clear: true }));
    expect([change.status, clear.status]).toEqual([401, 401]);
    expect(runtime.setSingleUserPassword).not.toHaveBeenCalled();
    expect(runtime.clearSingleUserPassword).not.toHaveBeenCalled();
  });

  it("still fails loudly on an unexpected error from the session check", async () => {
    vi.mocked(runtime.hasLoginPassword).mockResolvedValue(true);
    vi.mocked(runtime.requireAuthenticatedAccountId).mockRejectedValue(new Error("db down"));
    await expect(POST(post(TUNNEL))).rejects.toThrow("db down");
    expect(runtime.setSingleUserPassword).not.toHaveBeenCalled();
  });
});
