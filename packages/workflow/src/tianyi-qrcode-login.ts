/**
 * 天翼云盘 (Tianyi Cloud / cloud.189.cn) QR-code login — the brand-4 analogue of
 * Pan115QrLoginClient / QuarkQrLoginClient. Unlike 夸克 (CAS getToken flow), 天翼
 * rides the 189 "logbox" oauth2 flow and — like 115 — has a real
 * "scanned-awaiting-confirm" state:
 *
 *   getQrSession()   unifyLoginForPC (302 → open.e.189.cn login page; regex out
 *                    lt/reqId/paramId) → getUUID.do → build the qrClinentLogin URL
 *                    the QR encodes.
 *   pollStatus()     qrcodeLoginState.do, mapping the 4 status codes
 *                    (-106 waiting / -11002 scanned / 0 confirmed / -11001 expired).
 *   exchangeSession()  after "confirmed", redeem the redirectUrl at
 *                    getSessionForPC.action for the FULL session (personal +
 *                    family credentials in one shot).
 *   loginBySson()    SSON-cookie fallback (unifyLoginForPC → loginBySsoCooike with
 *                    Cookie: SSON=… → getSessionForPC).
 *
 * ── Provenance of the exact HTTP (honesty matters; the brand's viability rode on
 *    byte-accuracy) ──────────────────────────────────────────────────────────
 * • pollStatus — PROBE-VERIFIED: form fields (appId/clientType/returnUrl/paramId/
 *   uuid/encryuuid/date `YYYY-MM-DDHH:mm:ss.SSS`/timeStamp), Referer/Reqid/lt
 *   headers, and the -106/-11002/0/-11001 status codes are from a REAL phone scan
 *   (spec §登录 line 131). This is the v1-critical piece and its test is the
 *   load-bearing one.
 * • exchangeSession (getSessionForPC) — PROBE-VERIFIED: the exact host + fixed
 *   params (appId=8025431004 / clientType=TELEPC / version=6.2 /
 *   channelId=web_cloud.189.cn / rand) are the same ones the sibling TianyiClient
 *   (Task 1, `exchangeAccessTokenForSession`) really used to mint a live session;
 *   the QR flow only swaps the `accessToken` param for `redirectURL`.
 * • getQrSession (unifyLoginForPC + getUUID) — SHAPE PROBE-VERIFIED, EXACT INIT
 *   REFERENCE-DERIVED: the sequence and the fact that getUUID's uuid becomes the
 *   qrClinentLogin login URL are from the real scan; the precise init URL/params
 *   and the lt/reqId/paramId regexes are lifted from the spec-named reference
 *   `wes-lin/cloud189-sdk`.
 * • loginBySson — REFERENCE-DERIVED, NOT PROBE-VERIFIED: spec §登录 line 133 says
 *   SSON was NOT separately tested (扫码 sufficed). Implemented faithfully from
 *   `wes-lin/cloud189-sdk`'s `loginBySsoCooike`; the later live-e2e task must
 *   exercise this path. Tested at shape level (correct endpoints/params called).
 */

const APP_ID = "8025431004";
/** logbox/oauth2 QR face clientType (distinct from getSessionForPC's TELEPC). */
const QR_CLIENT_TYPE = "10020";
const PC_CLIENT_TYPE = "TELEPC";
const PC_VERSION = "6.2";
const PC_CHANNEL_ID = "web_cloud.189.cn";
const RETURN_URL = "https://m.cloud.189.cn/zhuanti/2020/loginErrorPc/index.html";

const WEB_HOST = "https://cloud.189.cn"; // portal entry (unifyLoginForPC)
const AUTH_HOST = "https://open.e.189.cn"; // logbox oauth2 (getUUID / qrcodeLoginState / SSON)
const API_HOST = "https://api.cloud.189.cn"; // OPEN face (getSessionForPC)

const UNIFY_LOGIN_PATH = "/api/portal/unifyLoginForPC.action";
const GET_UUID_PATH = "/api/logbox/oauth2/getUUID.do";
const QR_STATE_PATH = "/api/logbox/oauth2/qrcodeLoginState.do";
const SSO_LOGIN_PATH = "/api/logbox/oauth2/loginBySsoCooike.do";
const GET_SESSION_PATH = "/getSessionForPC.action";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36";

/** lt/reqId/paramId appear as either `lt = "…"` (page script) or `"lt":"…"` (JSON). */
const LT_PATTERNS = [/lt\s*=\s*"([^"]+)"/, /"lt"\s*:\s*"([^"]+)"/, /[?&]lt=([^&"'\s]+)/];
const REQID_PATTERNS = [/reqId\s*=\s*"([^"]+)"/, /"reqId"\s*:\s*"([^"]+)"/, /[?&]reqId=([^&"'\s]+)/];
const PARAMID_PATTERNS = [/paramId\s*=\s*"([^"]+)"/, /"paramId"\s*:\s*"([^"]+)"/, /[?&]paramId=([^&"'\s]+)/];

// ── phase-machine types ───────────────────────────────────────────────────────

export type TianyiQrStatus = "waiting" | "scanned" | "confirmed" | "expired";

export interface TianyiQrRequestInit {
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

/** JSON seam (parses the response body to an object). */
export type TianyiQrFetchJson = (url: string, init: TianyiQrRequestInit) => Promise<unknown>;

export interface TianyiQrRawResponse {
  status: number;
  text: string;
  headers: { get: (name: string) => string | null };
}

/** Raw seam (returns text + status + headers) — needed for the unifyLoginForPC
 *  HTML regex and the SSON redirect (Location / toUrl). */
export type TianyiQrRawFetch = (url: string, init: TianyiQrRequestInit) => Promise<TianyiQrRawResponse>;

/** Everything the phase machine carries across getQrSession → pollStatus. */
export interface TianyiQrSession {
  uuid: string;
  encryuuid: string;
  paramId: string;
  reqId: string;
  lt: string;
  appId: string;
  clientType: string;
  returnUrl: string;
  /** QR content: the open.e.189.cn login URL the app scans (front-end renders it). */
  qrcodeContent?: string;
}

export interface TianyiQrPollResult {
  status: TianyiQrStatus;
  redirectUrl?: string;
}

/** getSessionForPC's full payload — ONE login yields BOTH personal + family
 *  credentials (spec §session 字段: getSessionForPC). */
export interface TianyiSession {
  sessionKey: string;
  sessionSecret: string;
  accessToken: string;
  refreshToken: string;
  familySessionKey: string;
  familySessionSecret: string;
  loginName: string;
}

export interface TianyiQrLoginClientOptions {
  fetchJson?: TianyiQrFetchJson;
  rawFetch?: TianyiQrRawFetch;
  userAgent?: string;
}

export class TianyiQrLoginClient {
  private readonly fetchJson: TianyiQrFetchJson;
  private readonly rawFetch: TianyiQrRawFetch;
  private readonly userAgent: string;

  constructor(options: TianyiQrLoginClientOptions = {}) {
    this.fetchJson = options.fetchJson ?? defaultFetchJson;
    this.rawFetch = options.rawFetch ?? defaultRawFetch;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  }

  /**
   * unifyLoginForPC (regex lt/reqId/paramId) → getUUID.do → assemble the QR content.
   * SHAPE probe-verified; exact init URL/regex reference-derived (wes-lin/cloud189-sdk).
   */
  async getQrSession(): Promise<TianyiQrSession> {
    const params = await this.fetchLoginParams();
    const uuidRes = asRecord(
      await this.fetchJson(`${AUTH_HOST}${GET_UUID_PATH}`, {
        method: "POST",
        headers: {
          ...this.formHeaders(),
          Referer: `${AUTH_HOST}/`,
          Reqid: params.reqId,
          lt: params.lt,
        },
        body: new URLSearchParams({ appId: APP_ID }).toString(),
      }),
    );
    const uuid = stringValue(uuidRes["uuid"]);
    const encryuuid = stringValue(uuidRes["encryuuid"]);
    if (!uuid) {
      throw new Error("TIANYI_QR_UUID_FAILED: getUUID.do returned no uuid");
    }
    // The scanned QR encodes this login URL (spec §登录: uuid becomes qrClinentLogin URL).
    const qrcodeContent = `${AUTH_HOST}/api/account/qrClinentLogin.do?paras=new_uuid=${uuid}|${APP_ID}`;
    return {
      uuid,
      encryuuid,
      paramId: params.paramId,
      reqId: params.reqId,
      lt: params.lt,
      appId: APP_ID,
      clientType: QR_CLIENT_TYPE,
      returnUrl: params.returnUrl,
      qrcodeContent,
    };
  }

  /**
   * One qrcodeLoginState.do round. THE v1-critical 4-state mapping (probe-verified,
   * spec §登录). Unknown codes fall through to "waiting" — never a false-confirm.
   */
  async pollStatus(session: TianyiQrSession): Promise<TianyiQrPollResult> {
    const body = new URLSearchParams({
      appId: session.appId,
      clientType: session.clientType,
      returnUrl: session.returnUrl,
      paramId: session.paramId,
      uuid: session.uuid,
      encryuuid: session.encryuuid,
      date: formatTianyiDate(new Date()),
      timeStamp: String(Date.now()),
    }).toString();
    const res = asRecord(
      await this.fetchJson(`${AUTH_HOST}${QR_STATE_PATH}`, {
        method: "POST",
        headers: {
          ...this.formHeaders(),
          Referer: `${AUTH_HOST}/`,
          Reqid: session.reqId,
          lt: session.lt,
        },
        body,
      }),
    );
    const status = numberValue(res["status"]);
    if (status === 0) {
      return { status: "confirmed", redirectUrl: stringValue(res["redirectUrl"]) };
    }
    if (status === -11002) {
      return { status: "scanned" };
    }
    if (status === -11001) {
      return { status: "expired" };
    }
    return { status: "waiting" };
  }

  /**
   * Only call after pollStatus returned "confirmed". Redeems the redirectUrl at
   * getSessionForPC.action for the full session. Probe-verified params (same as
   * TianyiClient Task 1), redirectURL variant.
   */
  async exchangeSession(_session: TianyiQrSession, redirectUrl: string): Promise<TianyiSession> {
    return this.getSessionForPC({ redirectURL: redirectUrl });
  }

  /**
   * SSON-cookie fallback: unifyLoginForPC → loginBySsoCooike (Cookie: SSON=…) →
   * getSessionForPC. ⚠️ REFERENCE-DERIVED from wes-lin/cloud189-sdk, NOT
   * probe-verified (spec §登录 line 133: SSON was not separately tested). The
   * later live-e2e task must exercise this path.
   */
  async loginBySson(sson: string): Promise<TianyiSession> {
    const trimmed = sson.trim();
    if (!trimmed) {
      throw new Error("TIANYI_SSON_LOGIN_FAILED: empty SSON cookie");
    }
    const params = await this.fetchLoginParams();
    const query = new URLSearchParams({
      appId: APP_ID,
      clientType: QR_CLIENT_TYPE,
      paramId: params.paramId,
      returnUrl: params.returnUrl,
      timeStamp: String(Date.now()),
    }).toString();
    const res = await this.rawFetch(`${AUTH_HOST}${SSO_LOGIN_PATH}?${query}`, {
      method: "GET",
      headers: {
        ...this.htmlHeaders(),
        Referer: `${AUTH_HOST}/`,
        Reqid: params.reqId,
        lt: params.lt,
        Cookie: `SSON=${trimmed}`,
      },
    });
    const redirectUrl = extractSsoRedirect(res);
    if (!redirectUrl) {
      throw new Error(
        "TIANYI_SSON_LOGIN_FAILED: loginBySsoCooike returned no redirect (SSON invalid/expired or endpoint changed)",
      );
    }
    return this.getSessionForPC({ redirectURL: redirectUrl });
  }

  // ── internal ───────────────────────────────────────────────────────────────

  /** unifyLoginForPC → the open.e.189.cn login page; regex out lt/reqId/paramId. */
  private async fetchLoginParams(): Promise<{ lt: string; reqId: string; paramId: string; returnUrl: string }> {
    const query = new URLSearchParams({
      appId: APP_ID,
      clientType: QR_CLIENT_TYPE,
      returnURL: RETURN_URL,
      timeStamp: String(Date.now()),
    }).toString();
    const page = await this.rawFetch(`${WEB_HOST}${UNIFY_LOGIN_PATH}?${query}`, {
      method: "GET",
      headers: this.htmlHeaders(),
    });
    const lt = matchFirst(page.text, LT_PATTERNS);
    const reqId = matchFirst(page.text, REQID_PATTERNS);
    const paramId = matchFirst(page.text, PARAMID_PATTERNS);
    if (!lt || !paramId) {
      throw new Error("TIANYI_QR_INIT_FAILED: could not parse lt/paramId from unifyLoginForPC page");
    }
    return { lt, reqId, paramId, returnUrl: RETURN_URL };
  }

  /** getSessionForPC.action — fixed PC params + one variable (redirectURL). */
  private async getSessionForPC(extra: Record<string, string>): Promise<TianyiSession> {
    const query = new URLSearchParams({
      appId: APP_ID,
      clientType: PC_CLIENT_TYPE,
      version: PC_VERSION,
      channelId: PC_CHANNEL_ID,
      rand: String(Date.now()),
      ...extra,
    }).toString();
    const res = asRecord(
      await this.fetchJson(`${API_HOST}${GET_SESSION_PATH}?${query}`, {
        method: "POST",
        headers: { "User-Agent": this.userAgent, Accept: "application/json;charset=UTF-8" },
      }),
    );
    const sessionKey = stringValue(res["sessionKey"]);
    if (!sessionKey) {
      throw new Error(
        `TIANYI_SESSION_EXCHANGE_FAILED: getSessionForPC returned no sessionKey ` +
          `(res_code=${stringValue(res["res_code"])} ${stringValue(res["res_message"])})`,
      );
    }
    return {
      sessionKey,
      sessionSecret: stringValue(res["sessionSecret"]),
      accessToken: stringValue(res["accessToken"]),
      refreshToken: stringValue(res["refreshToken"]),
      familySessionKey: stringValue(res["familySessionKey"]),
      familySessionSecret: stringValue(res["familySessionSecret"]),
      loginName: stringValue(res["loginName"]),
    };
  }

  private htmlHeaders(): Record<string, string> {
    return {
      "User-Agent": this.userAgent,
      Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    };
  }

  private formHeaders(): Record<string, string> {
    return {
      "User-Agent": this.userAgent,
      Accept: "application/json;charset=UTF-8",
      "Content-Type": "application/x-www-form-urlencoded",
    };
  }
}

// ── module helpers ────────────────────────────────────────────────────────────

/** date format `YYYY-MM-DDHH:mm:ss.SSS` — day and time with NO separator (spec §登录). */
function formatTianyiDate(d: Date): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

function matchFirst(text: string, patterns: RegExp[]): string {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m?.[1]) {
      return m[1];
    }
  }
  return "";
}

/** Pull the post-SSON redirect (toUrl) from a Location header or JSON/HTML body. */
function extractSsoRedirect(res: TianyiQrRawResponse): string {
  const location = res.headers.get("location") ?? res.headers.get("Location");
  if (location) {
    return location;
  }
  const parsed = safeJson(res.text);
  if (parsed) {
    const record = asRecord(parsed);
    const fromJson =
      stringValue(record["toUrl"]) || stringValue(record["redirectUrl"]) || stringValue(record["redirect"]);
    if (fromJson) {
      return fromJson;
    }
  }
  return matchFirst(res.text, [/toUrl['"]?\s*[:=]\s*['"]([^'"]+)['"]/]);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function defaultFetchJson(url: string, init: TianyiQrRequestInit): Promise<unknown> {
  const res = await fetch(url, {
    method: init.method,
    ...(init.headers ? { headers: init.headers } : {}),
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`TIANYI_QR_HTTP_FAILED: ${res.status} non-JSON body`);
  }
}

async function defaultRawFetch(url: string, init: TianyiQrRequestInit): Promise<TianyiQrRawResponse> {
  const res = await fetch(url, {
    method: init.method,
    redirect: "manual",
    ...(init.headers ? { headers: init.headers } : {}),
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
  return {
    status: res.status,
    text: await res.text(),
    headers: { get: (name) => res.headers.get(name) },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}
