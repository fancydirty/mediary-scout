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
  /** Hosts the redemption chain may touch. Cookies are bearer credentials, so a
   *  redirect off these hosts must NOT receive the jar (and must not be followed
   *  with it). Exact host or a dot-suffix match. */
  redirectHosts: string[];
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
  redirectHosts: ["pan.quark.cn", "quark.cn", "uop.quark.cn"],
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
  redirectHosts: ["drive.uc.cn", "uc.cn", "api.open.uc.cn"],
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
    //
    // Cookies are bearer credentials, so the chain is confined to the brand's
    // own hosts. A hop anywhere else means the endpoint changed — fail loud
    // instead of following it (and instead of following it without the jar).
    const jar = new Map<string, string>();
    let url: string | null = this.profile.accountInfoUrl(serviceTicket);
    for (let hop = 0; hop < 6 && url; hop++) {
      if (!isAllowedRedirectHost(url, this.profile.redirectHosts)) {
        throw new Error(
          `${this.errCode("EXCHANGE_FAILED")}: redemption left ${this.profile.label} hosts (${hostOf(url)})`,
        );
      }
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
/** Set-Cookie with an empty value is normally a DELETION (browsers see
 *  `expires=Thu, 01 Jan 1970`, which is exactly what UC returns for a spent
 *  ticket — verified live). Treating every empty value as a plain overwrite
 *  would let a later hop wipe a good cookie from an earlier one, so:
 *    - explicit epoch/past expiry → delete from the jar
 *    - empty value without a deletion marker → ignore (never clobber a good one)
 *  Non-empty values always win, in arrival order.
 */
function absorbCookie(jar: Map<string, string>, raw: string): void {
  const parts = raw.split(";");
  const pair = parts[0] ?? "";
  const eq = pair.indexOf("=");
  if (eq <= 0) return;
  const key = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (value) {
    jar.set(key, value);
    return;
  }
  if (isDeletion(parts.slice(1))) jar.delete(key);
}

/** A cookie is being deleted when its expiry is already in the past, or
 *  `max-age=0`. Browsers drop any already-expired cookie, not just the epoch
 *  ones — a server may clear with e.g. `expires=Wed, 01 Jan 2025 …`.
 *  A malformed attr (`Max-Age` with no value, `Max-Age=`) must NOT count:
 *  `Number("")` is 0, which would read as "delete" and wipe a live cookie. */
function isDeletion(attributes: string[]): boolean {
  for (const attr of attributes) {
    const [rawName, rawValue = ""] = attr.split("=");
    const name = rawName?.trim().toLowerCase();
    const value = rawValue.trim();
    if (value === "") continue;
    if (name === "max-age" && Number(value) <= 0) return true;
    if (name === "expires") {
      const at = Date.parse(value);
      if (Number.isFinite(at) && at <= Date.now()) return true;
    }
  }
  return false;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Exact host, or a dot-suffix of one of `allowed` (so `pan.quark.cn` allows
 *  `passport.quark.cn`'s parent but never `evilquark.cn`). HTTPS only: cookies
 *  are bearer credentials and a downgrade to `http:` would leak them in clear. */
function isAllowedRedirectHost(url: string, allowed: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return allowed.some((a) => host === a || host.endsWith(`.${a}`));
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
