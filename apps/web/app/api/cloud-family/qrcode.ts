import QRCode from "qrcode";
import { NextResponse, type NextRequest } from "next/server";
import { QuarkQrLoginClient, QUARK_QR_PROFILE, UC_QR_PROFILE } from "@media-track/workflow";
import type { CloudDriveQrProfile } from "@media-track/workflow";
import { isDemoMode } from "../../../lib/demo-mode";
import {
  completeQuarkQrLogin,
  completeUcQrLogin,
  StorageOwnedByOtherAccountError,
} from "../../../lib/workflow-runtime";

/**
 * The four QR routes (token / status / image / confirm) are identical across the
 * family brands; only the profile, the QR-content prefix and the completion
 * helper differ. They live here as factories rather than as copies so that
 * validation and error mapping cannot drift between brands — the length cap
 * below had already been added to two brands and forgotten on the other two.
 */
export interface FamilyQrRoutes {
  profile: CloudDriveQrProfile;
  /** Prefix the QR content must start with. Brand-specific on purpose: 夸克's
   *  su.quark.cn QR on UC would open the wrong app. */
  qrContentPrefix: string;
  /** Redeems the service_ticket for drive cookies and binds the drive. */
  complete: (serviceTicket: string) => Promise<{ providerUid: string }>;
  /** Thrown by `complete` when the drive already belongs to another account
   *  (mapped to 409, not 502 — it's a conflict, not an infra failure). */
  storageOwnedError: abstract new () => Error;
}

/** QRCode.toBuffer throws past ~2.9k chars ("The amount of data is too big to be
 *  stored in a QR Code"), and an uncaught throw in a route handler is a 500 for
 *  what is really a bad request. */
const MAX_URL_CONTENT_LENGTH = 2048;

export function createFamilyQrRoutes(config: FamilyQrRoutes) {
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
      if (!content.startsWith(config.qrContentPrefix) || content.length > MAX_URL_CONTENT_LENGTH) {
        return new Response("missing/invalid content", { status: 400 });
      }
      const png = await QRCode.toBuffer(content, { width: 220, margin: 1 });
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
      try {
        const result = await config.complete(body.serviceTicket);
        return NextResponse.json({ ok: true, ...result });
      } catch (error) {
        if (error instanceof config.storageOwnedError) {
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

/**
 * ⚠️ Each brand is a SINGLE-USE ticket redemption, hence the two distinct
 * `complete` helpers: binding UC with 夸克's completion would store a UC cookie
 * under the 夸克 drive row.
 *
 * The values are read lazily (inside a getter) rather than at module scope: the
 * profile constants and the completion helpers both come from modules that pull
 * in the DB layer, and the image/status routes must not.
 */
export const quarkFamilyRoutes: FamilyQrRoutes = {
  profile: QUARK_QR_PROFILE,
  qrContentPrefix: "https://su.quark.cn/",
  complete: completeQuarkQrLogin,
  storageOwnedError: StorageOwnedByOtherAccountError,
};

export const ucFamilyRoutes: FamilyQrRoutes = {
  profile: UC_QR_PROFILE,
  qrContentPrefix: "https://su.uc.cn/",
  complete: completeUcQrLogin,
  storageOwnedError: StorageOwnedByOtherAccountError,
};
