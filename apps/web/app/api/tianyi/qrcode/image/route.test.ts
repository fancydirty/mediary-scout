import { describe, expect, it } from "vitest";
import { GET } from "./route";
import { NextRequest } from "next/server";

// Regression pin for a LIVE-caught bug: real getUUID.do returns a `uuid` field
// whose VALUE is the full qrClinentLogin.do login URL; a bare-token-only shape
// check 400'd it and broke the QR image in the UI.
const LIVE_CONTENT =
  "https://open.e.189.cn/api/account/qrClinentLogin.do?paras=new_uuid%3D7e0jq3s70wi7to3g%7C8025431004";

function req(content?: string) {
  const url = new URL("http://localhost/api/tianyi/qrcode/image");
  if (content !== undefined) url.searchParams.set("content", content);
  return new NextRequest(url);
}

describe("GET /api/tianyi/qrcode/image — content validation", () => {
  it("renders a PNG for the REAL live qrClinentLogin.do URL content", async () => {
    const res = await GET(req(LIVE_CONTENT));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const bytes = new Uint8Array(await res.arrayBuffer());
    // PNG magic bytes — proves a real image came back, not an error body.
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("still accepts a bare token (defensive fallback shape)", async () => {
    const res = await GET(req("7e0jq3s70wi7to3g"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
  });

  it("rejects URLs on other hosts (no open QR-render endpoint)", async () => {
    const res = await GET(req("https://evil.example.com/phish"));
    expect(res.status).toBe(400);
  });

  it("rejects missing/empty content", async () => {
    expect((await GET(req())).status).toBe(400);
    expect((await GET(req(""))).status).toBe(400);
  });

  it("rejects a too-short or bad-charset bare token", async () => {
    expect((await GET(req("abc"))).status).toBe(400);
    expect((await GET(req("uuid with spaces"))).status).toBe(400);
  });
});
