import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("../../../../lib/demo-mode", () => ({ isDemoMode: () => false }));
vi.mock("../../../../lib/workflow-runtime", async () => {
  const actual = await vi.importActual<typeof import("../../../../lib/workflow-runtime")>(
    "../../../../lib/workflow-runtime",
  );
  return {
    isRemoteRequest: actual.isRemoteRequest,
    SESSION_COOKIE_NAME: "mt_session",
    isMultiUserEnabled: vi.fn(() => true),
    isCookieSecure: vi.fn(() => false),
    getBootstrapState: vi.fn(),
    registerAccount: vi.fn(async () => ({ ok: true, accountId: "acct_default", signedCookie: "signed" })),
  };
});

import { POST } from "./route";
import * as runtime from "../../../../lib/workflow-runtime";

const TUNNEL = { "cf-ray": "8f3-abc", "cf-connecting-ip": "203.0.113.7" };

function post(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost:3000/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ username: "owner", password: "correct horse" }),
  });
}

describe("POST /api/auth/register", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses to claim an unclaimed instance over the tunnel", async () => {
    // Claiming takes over the existing library and drives as the instance owner.
    vi.mocked(runtime.getBootstrapState).mockResolvedValue({ needsClaim: true, hasExistingLibrary: true });
    const res = await POST(post(TUNNEL));
    expect(res.status).toBe(403);
    expect(runtime.registerAccount).not.toHaveBeenCalled();
  });

  it("claims from the LAN", async () => {
    vi.mocked(runtime.getBootstrapState).mockResolvedValue({ needsClaim: true, hasExistingLibrary: true });
    const res = await POST(post());
    expect(res.status).toBe(200);
    expect(runtime.registerAccount).toHaveBeenCalled();
  });

  it("still lets family members register their own accounts over the tunnel once claimed", async () => {
    vi.mocked(runtime.getBootstrapState).mockResolvedValue({ needsClaim: false, hasExistingLibrary: true });
    const res = await POST(post(TUNNEL));
    expect(res.status).toBe(200);
    expect(runtime.registerAccount).toHaveBeenCalled();
  });
});
