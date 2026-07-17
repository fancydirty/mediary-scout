import { type NextRequest } from "next/server";
import QRCode from "qrcode";

// Render the 天翼 QR PNG server-side (no third-party; the ephemeral login content
// never leaves this host). LIVE-VERIFIED against real cloud.189.cn: getUUID.do's
// `uuid` FIELD (encoded verbatim into the QR) carries a full login URL —
//   https://open.e.189.cn/api/account/qrClinentLogin.do?paras=new_uuid%3D<x>%7C<appId>
// — NOT a bare id (an earlier bare-token-only validation 400'd the real content
// and broke the QR image in the UI). Whitelist the open.e.189.cn prefix (like
// quark's su.quark.cn check); keep the bare-token shape as a defensive fallback
// so a server-side format change to a plain id doesn't break the image again.
const BARE_TOKEN_SHAPE = /^[0-9A-Za-z_-]{8,128}$/;
const TIANYI_LOGIN_URL_PREFIX = "https://open.e.189.cn/";
const MAX_URL_CONTENT_LENGTH = 2048;

function isValidQrContent(content: string): boolean {
  if (content.startsWith(TIANYI_LOGIN_URL_PREFIX)) {
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
