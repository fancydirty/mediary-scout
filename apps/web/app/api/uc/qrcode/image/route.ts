import { type NextRequest } from "next/server";
import QRCode from "qrcode";

// Render the su.uc.cn login URL to a PNG server-side (no third-party; the
// ephemeral login token never leaves this host). The UC prefix check is
// deliberate: 夸克's su.quark.cn QR would open the wrong app on scan.
//
// The length cap is not cosmetic: QRCode.toBuffer throws past ~2.9k chars
// ("The amount of data is too big to be stored in a QR Code"), and an uncaught
// throw in a route handler is a 500 for what is really a bad request.
// pan123/tianyi already cap at 2048; match them.
const MAX_URL_CONTENT_LENGTH = 2048;

export async function GET(request: NextRequest): Promise<Response> {
  const content = request.nextUrl.searchParams.get("content") ?? "";
  if (!content.startsWith("https://su.uc.cn/") || content.length > MAX_URL_CONTENT_LENGTH) {
    return new Response("missing/invalid content", { status: 400 });
  }
  const png = await QRCode.toBuffer(content, { width: 220, margin: 1 });
  return new Response(new Uint8Array(png), {
    headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
  });
}
