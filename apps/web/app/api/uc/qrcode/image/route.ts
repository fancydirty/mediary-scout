import { type NextRequest } from "next/server";
import QRCode from "qrcode";

// Render the su.uc.cn login URL to a PNG server-side (no third-party; the
// ephemeral login token never leaves this host). The UC prefix check is
// deliberate: 夸克's su.quark.cn QR would open the wrong app on scan.
export async function GET(request: NextRequest): Promise<Response> {
  const content = request.nextUrl.searchParams.get("content") ?? "";
  if (!content || !content.startsWith("https://su.uc.cn/")) {
    return new Response("missing/invalid content", { status: 400 });
  }
  const png = await QRCode.toBuffer(content, { width: 220, margin: 1 });
  return new Response(new Uint8Array(png), {
    headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
  });
}
