/**
 * 阿里云盘族 (Alibaba cloud-drive family) QR-code login — serves 夸克 AND UC over
 * ONE CAS flow. Originally quark-only; UC joined 2026-10-23 after live probing
 * confirmed the same protocol end to end (getTokenForQrcodeLogin →
 * getServiceTicketByQrcodeToken → a `st=` redemption at the drive host).
 *
 * The two differ ONLY in the profile: CAS host, client_id, the QR-content URL
 * template (the opaque path segment is brand-specific — using 夸克's `4_eMHBJ`
 * on UC redirects into the 夸克 app), the drive-host redemption URL, and the
 * cookie keys the session rides on.
 *
 * ⚠️ The service_ticket → cookie redemption is the FRAGILE hop on both brands:
 * it can only be confirmed by a REAL phone scan. Cookie paste stays as the
 * fallback everywhere this is used.
 */

// One-way import: quark-cookie-client imports only fetch-with-timeout, so this
// does not create a cycle.
import { parseCloudDriveUid } from "./quark-cookie-client.js";

export type QuarkQrFetchJson = (
  url: string,
  init: { method: string; headers?: Record<string, string> },
) => Promise<unknown>;

export interface QuarkQrRawResponse {
  status: number;
  headers: { getSetCookie: () => string[]; get: (name: string) => string | null };
}
export type QuarkQrRawFetch = (
  url: string,
  init: { method: string; headers?: Record<string, string>; redirect?: "manual" },
) => Promise<QuarkQrRawResponse>;

/** The per-brand half of the family CAS flow. */
export interface CloudDriveQrProfile {
  key: "quark" | "uc";
  label: string;
  /** CAS client id — 夸克 532, UC 381 (both confirmed live). */
  clientId: string;
  /** CAS endpoint base, no trailing slash (…/cas/ajax). */
  casBase: string;
  /** The URL encoded INTO the QR image. The path segment is brand-specific. */
  qrContent: (token: string, clientId: string) => string;
  /** Where the service_ticket is redeemed for drive cookies. */
  accountInfoUrl: (serviceTicket: string) => string;
  referer: string;
  userAgent: string;
  /** Cookie keys the session rides on (assembled from Set-Cookie). */
  driveCookieKeys: string[];
}

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

export const QUARK_QR_PROFILE: CloudDriveQrProfile = {
  key: "quark",
  label: "夸克",
  clientId: "532",
  casBase: "https://uop.quark.cn/cas/ajax",
  qrContent: (token, clientId) =>
    `https://su.quark.cn/4_eMHBJ?token=${encodeURIComponent(token)}&client_id=${clientId}&v=1.2&uc_param_str=`,
  accountInfoUrl: (ticket) =>
    `https://pan.quark.cn/account/info?st=${encodeURIComponent(ticket)}&fr=pc&platform=pc`,
  referer: "https://pan.quark.cn/",
  userAgent: DEFAULT_UA,
  driveCookieKeys: ["__pus", "__uid", "__kps", "__ktd", "__puus", "_UP_A4A_11_", "_UP_D_"],
};

/**
 * UC — captured live 2026-10-23.
 * - CAS lives on api.open.uc.cn (NOT uop.uc.cn, which does not resolve).
 * - The QR path segment is `1_n0ZCv`; 夸克's `4_eMHBJ` on su.uc.cn redirects into
 *   the 夸克 app, i.e. scanning it would never log into UC.
 * - client_id 381 is the one drive.uc.cn's own login page uses.
 * - UC additionally rides on `_UP_*` / `ctoken`, so those are collected too.
 */
export const UC_QR_PROFILE: CloudDriveQrProfile = {
  key: "uc",
  label: "UC网盘",
  clientId: "381",
  casBase: "https://api.open.uc.cn/cas/ajax",
  qrContent: (token, clientId) =>
    `https://su.uc.cn/1_n0ZCv?uc_param_str=dsdnfrpfbivesscpgimibtbmnijblauputogpintnwktprchmt&token=${encodeURIComponent(token)}&client_id=${clientId}&uc_biz_str=S%3Acustom%7CC%3Atitlebar_fix`,
  accountInfoUrl: (ticket) =>
    `https://drive.uc.cn/account/info?st=${encodeURIComponent(ticket)}&fr=pc&platform=pc`,
  referer: "https://drive.uc.cn",
  userAgent: DEFAULT_UA,
  driveCookieKeys: [
    "__pus",
    "__uid",
    "__kps",
    "__ktd",
    "__puus",
    "_UP_A4A_11_",
    "_UP_D_",
    "_UP_F7E_8D_",
    "_UP_RI_",
    "_UP_28A_52_",
    "_UP_6D1_64_",
    "ctoken",
  ],
};

export interface QuarkQrSession {
  token: string;
  /** String content to render as a QR; the user scans it in the brand's app. */
  qrcodeContent: string;
}
export type QuarkQrStatus = "waiting" | "scanned" | "confirmed" | "expired";
export interface QuarkQrPollResult {
  status: QuarkQrStatus;
  serviceTicket?: string;
}
export interface QuarkQrCookie {
  cookie: string;
  providerUid: string;
}

/** CAS `status` for a successful ticket — same on both brands. */
const CAS_OK = 2000000;

export class QuarkQrLoginClient {
  private readonly fetchJson: QuarkQrFetchJson;
  private readonly rawFetch: QuarkQrRawFetch;
  private readonly profile: CloudDriveQrProfile;
  private readonly userAgent: string;

  constructor(options: {
    profile?: CloudDriveQrProfile;
    fetchJson?: QuarkQrFetchJson;
    rawFetch?: QuarkQrRawFetch;
    userAgent?: string;
  } = {}) {
    this.profile = options.profile ?? QUARK_QR_PROFILE;
    this.fetchJson = options.fetchJson ?? defaultFetchJson;
    this.rawFetch = options.rawFetch ?? defaultRawFetch;
    this.userAgent = options.userAgent ?? this.profile.userAgent;
  }

  async getToken(): Promise<QuarkQrSession> {
    const q = `client_id=${this.profile.clientId}&v=1.2&request_id=${randomId()}&uc_param_str=`;
    const res = await this.fetchJson(`${this.profile.casBase}/getTokenForQrcodeLogin?${q}`, {
      method: "GET",
      headers: this.headers(),
    });
    const token = stringValue(asRecord(asRecord(asRecord(res)["data"])["members"])["token"]);
    if (!token) {
      throw new Error(`${this.errCode("TOKEN")}: no token in response`);
    }
    return {
      token,
      qrcodeContent: this.profile.qrContent(token, this.profile.clientId),
    };
  }

  async pollStatus(session: { token: string }): Promise<QuarkQrPollResult> {
    const q = `client_id=${this.profile.clientId}&v=1.2&request_id=${randomId()}&token=${encodeURIComponent(session.token)}&uc_param_str=`;
    const res = asRecord(
      await this.fetchJson(`${this.profile.casBase}/getServiceTicketByQrcodeToken?${q}`, {
        method: "GET",
        headers: this.headers(),
      }),
    );
    const status = numberValue(res["status"]);
    const ticket = stringValue(asRecord(asRecord(res["data"])["members"])["service_ticket"]);
    if (status === CAS_OK && ticket) {
      return { status: "confirmed", serviceTicket: ticket };
    }
    // 50004002 "Token Not Found" = expired/unknown (verified live on BOTH brands;
    // 夸克 returns the identical code). 50004001 "Query result is empty" is the
    // normal not-yet-scanned state, so it must NOT be read as expired.
    if (status === 50004002 || /expire|invalid|过期|失效/i.test(stringValue(res["message"]))) {
      return { status: "expired" };
    }
    return { status: "waiting" };
  }

  async exchangeCookie(serviceTicket: string): Promise<QuarkQrCookie> {
    // The CAS service_ticket is redeemed at the brand's drive host; the drive
    // cookies are Set-Cookie'd across the redirect chain. Follow manually.
    const jar = new Map<string, string>();
    let url: string | null = this.profile.accountInfoUrl(serviceTicket);
    for (let hop = 0; hop < 6 && url; hop++) {
      const res: QuarkQrRawResponse = await this.rawFetch(url, {
        method: "GET",
        headers: this.headers(jar),
        redirect: "manual",
      });
      for (const raw of res.headers.getSetCookie()) {
        absorbCookie(jar, raw);
      }
      const loc = res.headers.get("location");
      url = res.status >= 300 && res.status < 400 && loc ? absolutize(loc, url) : null;
    }
    const cookie = this.profile.driveCookieKeys
      .filter((k) => jar.has(k) && jar.get(k))
      .map((k) => `${k}=${jar.get(k)}`)
      .join("; ");
    const providerUid = parseCloudDriveUid(cookie);
    if (!jar.get("__pus") || !providerUid) {
      throw new Error(
        `${this.errCode("EXCHANGE_FAILED")}: no drive cookie (missing __pus/__uid) — the service_ticket may be stale or the exchange endpoint changed`,
      );
    }
    return { cookie, providerUid };
  }

  private errCode(suffix: string): string {
    return `${this.profile.key === "uc" ? "UC" : "QUARK"}_QR_${suffix}`;
  }

  private headers(jar?: Map<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      "User-Agent": this.userAgent,
      Referer: this.profile.referer,
      Accept: "application/json, text/plain, */*",
    };
    if (jar && jar.size > 0) {
      headers["Cookie"] = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    return headers;
  }
}

/** Absorb one Set-Cookie line into the jar (first `k=v` pair only). */
function absorbCookie(jar: Map<string, string>, raw: string): void {
  const pair = raw.split(";")[0] ?? "";
  const eq = pair.indexOf("=");
  if (eq > 0) {
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function absolutize(loc: string, base: string): string {
  try {
    return new URL(loc, base).toString();
  } catch {
    return loc;
  }
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

async function defaultFetchJson(
  url: string,
  init: { method: string; headers?: Record<string, string> },
): Promise<unknown> {
  const res = await fetch(url, { method: init.method, ...(init.headers ? { headers: init.headers } : {}) });
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`CLOUD_QR_HTTP_FAILED: ${res.status}`);
  }
}

async function defaultRawFetch(
  url: string,
  init: { method: string; headers?: Record<string, string>; redirect?: "manual" },
): Promise<QuarkQrRawResponse> {
  const res = await fetch(url, {
    method: init.method,
    redirect: init.redirect ?? "manual",
    ...(init.headers ? { headers: init.headers } : {}),
  });
  return {
    status: res.status,
    headers: { getSetCookie: () => res.headers.getSetCookie(), get: (n) => res.headers.get(n) },
  };
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}
function stringValue(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
}
function numberValue(v: unknown): number {
  return typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
}
