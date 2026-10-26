import QRCode from "qrcode";
import { NextResponse, type NextRequest } from "next/server";
import { QuarkQrLoginClient, QUARK_QR_PROFILE, UC_QR_PROFILE } from "@media-track/workflow";
import type { CloudDriveQrProfile } from "@media-track/workflow";
import { isDemoMode } from "../../../lib/demo-mode";

/**
 * The four QR routes (token / status / image / confirm) are identical across the
 * family brands; only the profile, the QR-content prefix and the completion
 * helper differ. They live here as factories rather than as copies so that
 * validation and error mapping cannot drift between brands — the length cap
 * below had already been added to two brands and forgotten on the other two.
 */
export type FamilyQrBrand = "quark" | "uc";

export interface FamilyQrRoutesConfig {
  brand: FamilyQrBrand;
  profile: CloudDriveQrProfile;
  /** Prefix the QR content must start with. Brand-specific on purpose: 夸克's
   *  su.quark.cn QR on UC would open the wrong app. */
  qrContentPrefix: string;
}

/** Byte cap for the content we are willing to encode. QR payload limits are
 *  measured in BYTES, not characters, so a char-count cap lets ~6000 bytes of
 *  CJK through only to throw inside the encoder. 2048 bytes is far above any
 *  real brand login URL (~180 chars) while staying well clear of the limit. */
const MAX_URL_CONTENT_LENGTH_BYTES = 2048;

export function createFamilyQrRoutes(config: FamilyQrRoutesConfig) {
  const client = () => new QuarkQrLoginClient({ profile: config.profile });

  return {
    /** POST — mint a fresh login session + the content to encode. */
    async token(): Promise<NextResponse> {
      if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
      try {
        const session = await client().getToken();
        return NextResponse.json({ ok: true, session });
      } catch (error) {
        return NextResponse.json({ ok: false, error: String(error) }, { status: 502 });
      }
    },

    /** GET ?token= — one poll tick. `waiting` | `scanned` | `confirmed` | `expired`. */
    async status(request: NextRequest): Promise<NextResponse> {
      const token = request.nextUrl.searchParams.get("token") ?? "";
      if (!token) {
        return NextResponse.json({ ok: false, error: "missing token" }, { status: 400 });
      }
      try {
        const result = await client().pollStatus({ token });
        return NextResponse.json({ ok: true, ...result });
      } catch (error) {
        return NextResponse.json({ ok: false, error: String(error) }, { status: 502 });
      }
    },

    /** GET ?content= — render the QR server-side so the ephemeral login token
     *  never leaves this host. */
    async image(request: NextRequest): Promise<Response> {
      const content = request.nextUrl.searchParams.get("content") ?? "";
      const tooLong = Buffer.byteLength(content, "utf8") > MAX_URL_CONTENT_LENGTH_BYTES;
      if (!content.startsWith(config.qrContentPrefix) || tooLong) {
        return new Response("missing/invalid content", { status: 400 });
      }
      let png: Buffer;
      try {
        png = await QRCode.toBuffer(content, { width: 220, margin: 1 });
      } catch {
        // The cap above should make this unreachable; if the encoder still
        // refuses the input it is a bad request, not an infrastructure failure.
        return new Response("failed to render qr code", { status: 400 });
      }
      return new Response(new Uint8Array(png), {
        headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
      });
    },

    /** POST — redeem the scanned service_ticket and bind the drive.
     *  ⚠️ The ticket is SINGLE-USE: redeeming it twice yields empty cookies. */
    async confirm(request: NextRequest): Promise<NextResponse> {
      if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
      // Parse the body OUTSIDE the business try/catch: invalid/missing JSON is a
      // client error (400), not an infra failure (502).
      const body = (await request.json().catch(() => null)) as { serviceTicket?: string } | null;
      if (!body?.serviceTicket) {
        return NextResponse.json({ ok: false, error: "missing serviceTicket" }, { status: 400 });
      }

      // Loaded here, not at module scope: workflow-runtime pulls in the DB
      // layer, and token/status/image have no business loading it.
      let runtime: typeof import("../../../lib/workflow-runtime");
      try {
        runtime = await import("../../../lib/workflow-runtime");
      } catch (error) {
        return NextResponse.json({ ok: false, error: String(error) }, { status: 502 });
      }

      // Binding UC with 夸克's helper would store a UC cookie under the 夸克 row.
      const complete = config.brand === "uc" ? runtime.completeUcQrLogin : runtime.completeQuarkQrLogin;
      try {
        const result = await complete(body.serviceTicket);
        return NextResponse.json({ ok: true, ...result });
      } catch (error) {
        if (error instanceof runtime.StorageOwnedByOtherAccountError) {
          return NextResponse.json({ ok: false, error: error.message }, { status: 409 });
        }
        return NextResponse.json(
          { ok: false, error: (error as Error)?.message || "登录失败" },
          { status: 502 },
        );
      }
    },
  };
}

/** Brand wiring. Only pure data here — the completion helpers are imported
 *  lazily inside `confirm` so the other three routes never load the DB layer. */
export const quarkFamilyRoutes: FamilyQrRoutesConfig = {
  brand: "quark",
  profile: QUARK_QR_PROFILE,
  qrContentPrefix: "https://su.quark.cn/",
};

export const ucFamilyRoutes: FamilyQrRoutesConfig = {
  brand: "uc",
  profile: UC_QR_PROFILE,
  qrContentPrefix: "https://su.uc.cn/",
};
