import { describe, expect, it, vi, beforeEach } from "vitest";
import { StorageOwnedByOtherAccountError } from "../../../../../lib/workflow-runtime";

vi.mock("../../../../../lib/demo-mode", () => ({ isDemoMode: () => false }));
// Mock completePan115QrLogin so we can throw controlled errors. Keep the class
// symbol real (re-exported) so `instanceof` in the route still works.
vi.mock("../../../../../lib/workflow-runtime", async () => {
  const actual = await vi.importActual<typeof import("../../../../../lib/workflow-runtime")>(
    "../../../../../lib/workflow-runtime",
  );
  return {
    ...actual,
    StorageOwnedByOtherAccountError: actual.StorageOwnedByOtherAccountError,
    completePan115QrLogin: vi.fn(),
  };
});

import { POST } from "./route";
import { completePan115QrLogin } from "../../../../../lib/workflow-runtime";
import { NextRequest } from "next/server";

function req(body: unknown) {
  return new NextRequest("http://localhost/api/115/qrcode/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validBody = { session: { uid: "u", time: 1, sign: "s" } };

describe("POST /api/115/qrcode/confirm — error mapping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 409 + clean message when the drive is owned by another account", async () => {
    (completePan115QrLogin as ReturnType<typeof vi.fn>).mockRejectedValue(
      new StorageOwnedByOtherAccountError(),
    );
    const res = await POST(req(validBody));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("该网盘账号已被本实例的其他用户连接，无法重复绑定。");
    expect(body.error).not.toMatch(/Error:|StorageOwned/);
  });

  it("returns 502 + bare message for other (infra) errors", async () => {
    (completePan115QrLogin as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("upstream 500"));
    const res = await POST(req(validBody));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("upstream 500");
    expect(body.error).not.toMatch(/^Error:/);
  });

  it("returns 400 when session params are missing", async () => {
    const res = await POST(req({ session: {} }));
    expect(res.status).toBe(400);
  });
});
