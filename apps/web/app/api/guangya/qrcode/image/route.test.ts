import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

// The exact shape the real account.guangyapan.com returned on 2026-10-26.
const LIVE_CONTENT =
  "https://account.guangyapan.com/__/auth/device/?client_id=aMe-8VSlkrbQXpUR&scope=user%20profile%20sso%20offline";

function req(content?: string) {
  const url = new URL("http://localhost/api/guangya/qrcode/image");
  if (content !== undefined) url.searchParams.set("content", content);
  return new NextRequest(url);
}

describe("GET /api/guangya/qrcode/image", () => {
  it("renders a PNG for the real verification_url", async () => {
    const res = await GET(req(LIVE_CONTENT));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const bytes = new Uint8Array(await res.arrayBuffer());
    // PNG magic — proves a real image came back, not an error body.
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  // This endpoint must not become an open QR renderer: a convincing
  // "光鸭登录" code pointing at an attacker host is exactly the phishing shape.
  it.each([
    ["another host", "https://evil.example.com/__/auth/device/?client_id=x"],
    ["lookalike host", "https://account.guangyapan.com.evil.com/x"],
    ["plain http", "http://account.guangyapan.com/__/auth/device/"],
    ["not a url", "hello"],
    ["empty", ""],
  ])("rejects %s", async (_label, content) => {
    expect((await GET(req(content))).status).toBe(400);
  });

  it("rejects a missing content param", async () => {
    expect((await GET(req())).status).toBe(400);
  });

  // QR payload limits are BYTES. A ~700-char CJK string is under any sane char
  // cap but over 2048 bytes, so only a byte cap rejects it. (The 夸克/UC route
  // shipped without this and threw inside the encoder instead.)
  it("caps by bytes, not characters", async () => {
    const cjk = `https://account.guangyapan.com/${"啊".repeat(700)}`;
    expect(cjk.length).toBeLessThan(2048);
    expect(Buffer.byteLength(cjk, "utf8")).toBeGreaterThan(2048);
    expect((await GET(req(cjk))).status).toBe(400);
  });
});
