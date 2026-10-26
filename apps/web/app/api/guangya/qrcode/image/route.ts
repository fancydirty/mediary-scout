import { type NextRequest } from "next/server";
import QRCode from "qrcode";

/** Byte cap for the content we encode. QR payload limits are BYTES, not
 *  characters — a char-count cap lets multi-byte input through only to throw
 *  inside the encoder (the 夸克/UC image route learned this the hard way).
 *  2048 bytes is far above the real 光鸭 verification_url (~130 chars). */
const MAX_URL_CONTENT_LENGTH_BYTES = 2048;

/** The 光鸭 verification_url lives on account.guangyapan.com. Confining it there
 *  keeps this from becoming an open QR renderer that could mint a convincing
 *  「光鸭登录」 code pointing at an attacker host. */
const ALLOWED_PREFIX = "https://account.guangyapan.com/";

/** GET ?content= — render the verification_url as a PNG, server-side, so the
 *  login URL never passes through a third-party QR service. */
export async function GET(request: NextRequest): Promise<Response> {
  const content = request.nextUrl.searchParams.get("content") ?? "";
  const tooLong = Buffer.byteLength(content, "utf8") > MAX_URL_CONTENT_LENGTH_BYTES;
  if (!content.startsWith(ALLOWED_PREFIX) || tooLong) {
    return new Response("missing/invalid content", { status: 400 });
  }
  let png: Buffer;
  try {
    png = await QRCode.toBuffer(content, { width: 220, margin: 1 });
  } catch {
    // The caps above should make this unreachable; if the encoder still refuses
    // the input it is a bad request, not an infrastructure failure.
    return new Response("failed to render qr code", { status: 400 });
  }
  return new Response(new Uint8Array(png), {
    headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
  });
}
