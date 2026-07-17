import { type NextRequest } from "next/server";
import QRCode from "qrcode";

// Render the 天翼 QR PNG server-side (no third-party; the ephemeral login uuid
// never leaves this host). Unlike quark, the QR content is the BARE uuid string
// from getUUID.do (probe-verified) — NOT an open.e.189.cn URL — so validate the
// uuid SHAPE (length + charset), not a URL prefix.
const UUID_SHAPE = /^[0-9A-Za-z_-]+$/;

export async function GET(request: NextRequest): Promise<Response> {
  const content = request.nextUrl.searchParams.get("content") ?? "";
  if (content.length < 8 || content.length > 128 || !UUID_SHAPE.test(content)) {
    return new Response("missing/invalid content", { status: 400 });
  }
  const png = await QRCode.toBuffer(content, { width: 220, margin: 1 });
  return new Response(new Uint8Array(png), {
    headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
  });
}
