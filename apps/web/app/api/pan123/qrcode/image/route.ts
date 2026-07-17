import { type NextRequest } from "next/server";
import QRCode from "qrcode";

// Render the 123网盘 QR PNG server-side (no third-party; the ephemeral login
// content never leaves this host). LIVE-VERIFIED against the real generate API:
// the QR content is a full login URL of the shape
//   https://yun.123pan.cn/wx-app-login.html?env=production&uniID=<36-char url-safe UUID>&source=123pan&type=login
// — host is yun.123pan.cn, NOT login.123pan.com (the API host)! 天翼 shipped a
// broken QR image because its whitelist assumed the wrong content shape — do
// NOT change these prefixes without re-probing the real generate response.
// yun.123pan.com is kept as a defensive twin (the server may flip cn↔com), and
// the bare-token shape is the last-resort fallback for a format change to a
// plain id (mirroring the tianyi image route's three-layer structure).
const BARE_TOKEN_SHAPE = /^[0-9A-Za-z_-]{8,128}$/;
const PAN123_LOGIN_URL_PREFIXES = ["https://yun.123pan.cn/", "https://yun.123pan.com/"];
const MAX_URL_CONTENT_LENGTH = 2048;

function isValidQrContent(content: string): boolean {
  if (PAN123_LOGIN_URL_PREFIXES.some((prefix) => content.startsWith(prefix))) {
    return content.length <= MAX_URL_CONTENT_LENGTH;
  }
  return BARE_TOKEN_SHAPE.test(content);
}

export async function GET(request: NextRequest): Promise<Response> {
  const content = request.nextUrl.searchParams.get("content") ?? "";
  if (!isValidQrContent(content)) {
    return new Response("missing/invalid content", { status: 400 });
  }
  const png = await QRCode.toBuffer(content, { width: 220, margin: 1 });
  return new Response(new Uint8Array(png), {
    headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
  });
}
