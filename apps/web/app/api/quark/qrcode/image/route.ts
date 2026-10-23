import { type NextRequest } from "next/server";
import QRCode from "qrcode";

// Render the su.quark.cn login URL to a PNG server-side (no third-party; the
// ephemeral login token never leaves this host).
//
// The length cap is not cosmetic: QRCode.toBuffer throws past ~2.9k chars, and
// an uncaught throw in a route handler is a 500 for what is really a bad
// request. pan123/tianyi cap at 2048; match them.
const MAX_URL_CONTENT_LENGTH = 2048;

export async function GET(request: NextRequest): Promise<Response> {
  const content = request.nextUrl.searchParams.get("content") ?? "";
  if (!content.startsWith("https://su.quark.cn/") || content.length > MAX_URL_CONTENT_LENGTH) {
    return new Response("missing/invalid content", { status: 400 });
  }
  const png = await QRCode.toBuffer(content, { width: 220, margin: 1 });
  return new Response(new Uint8Array(png), {
    headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
  });
}
