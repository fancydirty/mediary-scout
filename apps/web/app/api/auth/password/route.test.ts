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
});
