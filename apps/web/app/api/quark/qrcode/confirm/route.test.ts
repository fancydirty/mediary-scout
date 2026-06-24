import { describe, expect, it, vi, beforeEach } from "vitest";
import { StorageOwnedByOtherAccountError } from "../../../../../lib/workflow-runtime";

vi.mock("../../../../../lib/demo-mode", () => ({ isDemoMode: () => false }));
vi.mock("../../../../../lib/workflow-runtime", async () => {
  const actual = await vi.importActual<typeof import("../../../../../lib/workflow-runtime")>(
    "../../../../../lib/workflow-runtime",
  );
  return {
    ...actual,
    StorageOwnedByOtherAccountError: actual.StorageOwnedByOtherAccountError,
    completeQuarkQrLogin: vi.fn(),
  };
});

import { POST } from "./route";
import { completeQuarkQrLogin } from "../../../../../lib/workflow-runtime";
import { NextRequest } from "next/server";

function req(body: unknown) {
  return new NextRequest("http://localhost/api/quark/qrcode/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/quark/qrcode/confirm — error mapping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 409 + clean message when the drive is owned by another account", async () => {
    (completeQuarkQrLogin as ReturnType<typeof vi.fn>).mockRejectedValue(
      new StorageOwnedByOtherAccountError(),
    );
    const res = await POST(req({ serviceTicket: "st" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("该网盘账号已被本实例的其他用户连接，无法重复绑定。");
    expect(body.error).not.toMatch(/Error:|Quark/);
  });

  it("returns 502 + bare message for other errors", async () => {
    (completeQuarkQrLogin as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("exchange failed"));
    const res = await POST(req({ serviceTicket: "st" }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("exchange failed");
    expect(body.error).not.toMatch(/^Error:/);
  });

  it("returns 400 when serviceTicket is missing", async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
  });

  it("returns 400 (not 502) when the request body is invalid JSON", async () => {
    const r = new NextRequest("http://localhost/api/quark/qrcode/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const res = await POST(r);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });
});
