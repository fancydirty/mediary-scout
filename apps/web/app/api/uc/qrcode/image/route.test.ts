import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

// The real UC content shape: an unpkg-style opaque path + client_id + uc_biz_str.
const LIVE_CONTENT =
  "https://su.uc.cn/1_n0ZCv?uc_param_str=dsdnfrpfbivesscpgimibtbmnijblauputogpintnwktprchmt&token=sta32633312n4a4648fv9sw0zdndbbdn&client_id=381&uc_biz_str=S%3Acustom%7CC%3Atitlebar_fix";

function req(content?: string) {
  const url = new URL("http://localhost/api/uc/qrcode/image");
  if (content !== undefined) url.searchParams.set("content", content);
  return new NextRequest(url);
}

describe("GET /api/uc/qrcode/image — content validation", () => {
  it("renders a PNG for the REAL su.uc.cn login URL", async () => {
    const res = await GET(req(LIVE_CONTENT));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("rejects 夸克's su.quark.cn QR — scanning it opens the wrong app", async () => {
    const res = await GET(req("https://su.quark.cn/4_eMHBJ?token=abc&client_id=532&v=1.2&uc_param_str="));
    expect(res.status).toBe(400);
  });

  it("rejects other hosts (no open QR-render endpoint)", async () => {
    expect((await GET(req("https://evil.example.com/phish"))).status).toBe(400);
  });

  it("rejects missing/empty content", async () => {
    expect((await GET(req())).status).toBe(400);
    expect((await GET(req(""))).status).toBe(400);
  });

  // Regression pin: QRCode.toBuffer throws ("The amount of data is too big to be
  // stored in a QR Code") past ~2.9k chars. Without the cap that throw escapes
  // the handler as a 500 for what is plainly a bad request.
  it("returns 400 (not 500) for oversized content", async () => {
    const res = await GET(req(`https://su.uc.cn/1_n0ZCv?token=${"a".repeat(4000)}`));
    expect(res.status).toBe(400);
  });

  // The cap is measured in BYTES because QR payload limits are byte-based.
  // This size is chosen to actually distinguish the two: it ENCODES fine, so a
  // char-count cap would return 200 here — only a byte cap rejects it.
  it("caps by bytes, not characters", async () => {
    const cjk = `https://su.uc.cn/1_n0ZCv?token=${"啊".repeat(700)}`;
    expect(cjk.length).toBeLessThan(2048); // passes a char-count check
    expect(Buffer.byteLength(cjk, "utf8")).toBeGreaterThan(2048);
    expect((await GET(req(cjk))).status).toBe(400);
  });
});
