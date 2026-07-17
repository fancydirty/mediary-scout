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
    completeTianyiQrLogin: vi.fn(),
  };
});

import { POST } from "./route";
import { completeTianyiQrLogin } from "../../../../../lib/workflow-runtime";
import { NextRequest } from "next/server";

const fakeSession = {
  uuid: "uuid-1",
  encryuuid: "enc-1",
  paramId: "p-1",
  reqId: "r-1",
  lt: "lt-1",
  appId: "8025431004",
  clientType: "10020",
  returnUrl: "https://m.cloud.189.cn/zhuanti/2020/loginErrorPc/index.html",
  cookies: [["JSESSIONID", "abc"]] as Array<[string, string]>,
  qrcodeContent: "uuid-1",
};

function req(body: unknown) {
  return new NextRequest("http://localhost/api/tianyi/qrcode/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/tianyi/qrcode/confirm — error mapping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 409 + clean message when the drive is owned by another account", async () => {
    (completeTianyiQrLogin as ReturnType<typeof vi.fn>).mockRejectedValue(
      new StorageOwnedByOtherAccountError(),
    );
    const res = await POST(req({ session: fakeSession, redirectUrl: "https://cloud.189.cn/r?x=1" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("该网盘账号已被本实例的其他用户连接，无法重复绑定。");
    expect(body.error).not.toMatch(/Error:|Tianyi/);
  });

  it("returns 502 + bare message for other errors", async () => {
    (completeTianyiQrLogin as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("exchange failed"));
    const res = await POST(req({ session: fakeSession, redirectUrl: "https://cloud.189.cn/r?x=1" }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("exchange failed");
    expect(body.error).not.toMatch(/^Error:/);
  });

  it("passes the browser's session (with its rolling cookie jar) + redirectUrl through verbatim", async () => {
    (completeTianyiQrLogin as ReturnType<typeof vi.fn>).mockResolvedValue({ providerUid: "138****0000" });
    const res = await POST(req({ session: fakeSession, redirectUrl: "https://cloud.189.cn/r?x=1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.providerUid).toBe("138****0000");
    // The freshest jar from the last poll MUST reach the exchange untouched.
    expect(completeTianyiQrLogin).toHaveBeenCalledWith(fakeSession, "https://cloud.189.cn/r?x=1");
  });

  it("returns 400 when session is missing", async () => {
    const res = await POST(req({ redirectUrl: "https://cloud.189.cn/r?x=1" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when redirectUrl is missing", async () => {
    const res = await POST(req({ session: fakeSession }));
    expect(res.status).toBe(400);
  });

  it("returns 400 (not 502) when the request body is invalid JSON", async () => {
    const r = new NextRequest("http://localhost/api/tianyi/qrcode/confirm", {
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
