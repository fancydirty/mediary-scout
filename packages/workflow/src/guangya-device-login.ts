import { fetchWithTimeout } from "./fetch-with-timeout.js";
import { GUANGYA_CLIENT_ID } from "./guangya-client.js";

/**
 * 光鸭扫码登录 —— 走的是 RFC 8628 设备码流程，不是自己发明的协议。
 *
 * 这**就是光鸭网页「扫码登录」按钮背后跑的东西**（2026-10-26 在真站抓包确认）：
 * 点「扫码登录」→ `POST /v1/auth/device/code` 拿到 device_code + user_code +
 * verification_url → 把 verification_url 渲染成二维码给用户扫 → 每 interval 秒
 * `POST /v1/auth/token` 轮询，未授权返回 `authorization_pending`(4050)，授权后
 * 返回 access_token / refresh_token。
 *
 * 所以「扫码」和「设备码」是同一件事的两种呈现：二维码里编的正是
 * verification_url。我们既可以把该串编码成二维码（用户用光鸭 APP 扫），也可以
 * 把它作为链接给用户点（浏览器里若已登录光鸭，打开即完成授权）。后者就是为什么
 * 这个方案比粘 token 好：不需要用户去 Console 里翻 localStorage。
 *
 * 端点都挂在 account.guangyapan.com（不是 api.），并且：
 *  - 请求体里 `scope` 一旦填了就报 `permission_denied`(7)，**必须不传 scope**；
 *  - 只有 `client_id` 是必填的，缺了报 `not_found`(5)；
 *  - 轮询的两个"继续等"信号是 `authorization_pending` 和 `slow_down`。
 */

const AUTH_HOST = "https://account.guangyapan.com";

const DEVICE_CODE_PATH = "/v1/auth/device/code";
const TOKEN_PATH = "/v1/auth/token";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const DEFAULT_HTTP_TIMEOUT_MS = 15_000;

export interface GuangYaDeviceCode {
  /** Long secret polled against /v1/auth/token. Never show this to the user. */
  deviceCode: string;
  /** Short code shown next to the QR. Not needed by the server for this brand. */
  userCode: string;
  /** What the QR encodes: an https URL the 光鸭 app (or a logged-in browser) opens. */
  verificationUrl: string;
  /** Seconds until the code dies (server says 120). */
  expiresIn: number;
  /** Minimum seconds between polls (server says 2). */
  interval: number;
}

export type GuangYaDevicePollResult =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "confirmed"; accessToken: string; refreshToken: string };

export type GuangYaDeviceFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface GuangYaDeviceLoginOptions {
  fetchImpl?: GuangYaDeviceFetch;
  clientId?: string;
  timeoutMs?: number;
}

export class GuangYaDeviceLogin {
  private readonly fetchImpl: GuangYaDeviceFetch;
  private readonly clientId: string;

  constructor(options: GuangYaDeviceLoginOptions = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetchWithTimeout(url, init, timeoutMs));
    this.clientId = options.clientId ?? GUANGYA_CLIENT_ID;
  }

  /**
   * Mint a fresh device code. Deliberately does NOT send `scope`: the server
   * rejects any scope string this client id isn't granted, including "*" and
   * "user", with permission_denied. Omitting it yields the default scopes
   * (`user profile sso offline`), which is what we need.
   */
  async start(): Promise<GuangYaDeviceCode> {
    const response = await this.fetchImpl(`${AUTH_HOST}${DEVICE_CODE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: this.clientId }),
    });
    const body = (await response.json().catch(() => null)) as unknown;
    const deviceCode = readString(body, "device_code");
    const userCode = readString(body, "user_code");
    const verificationUrl = readString(body, "verification_url");
    if (!response.ok || !deviceCode || !userCode || !verificationUrl) {
      // OAuth errors often omit error_description and carry only `error`
      // (permission_denied / not_found) — keep that code in the message.
      throw new Error(
        `GUANGYA_DEVICE_CODE_FAILED: ${
          readString(body, "error_description") || readString(body, "error") || `HTTP ${response.status}`
        }`,
      );
    }
    return {
      deviceCode,
      userCode,
      verificationUrl,
      expiresIn: readNumber(body, "expires_in") ?? 120,
      interval: readNumber(body, "interval") ?? 2,
    };
  }

  /**
   * One poll tick. `authorization_pending` and `slow_down` both mean "keep
   * waiting" — treating slow_down as an error would kill a login that is about
   * to succeed. Everything else that isn't a token is a real failure.
   */
  async poll(deviceCode: string): Promise<GuangYaDevicePollResult> {
    const response = await this.fetchImpl(`${AUTH_HOST}${TOKEN_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.clientId,
        grant_type: DEVICE_GRANT,
        device_code: deviceCode,
      }),
    });
    const body = (await response.json().catch(() => null)) as unknown;

    if (response.ok) {
      const accessToken = readString(body, "access_token");
      const refreshToken = readString(body, "refresh_token");
      if (!accessToken || !refreshToken) {
        throw new Error("GUANGYA_DEVICE_TOKEN_FAILED: response missing tokens");
      }
      return { status: "confirmed", accessToken, refreshToken };
    }

    const error = readString(body, "error");
    if (error === "authorization_pending" || error === "slow_down") {
      return { status: "pending" };
    }
    if (error === "expired_token" || error === "access_denied") {
      // access_denied = the user actively dismissed it. Both are terminal: the
      // caller must mint a NEW device code rather than keep polling this one.
      return { status: "expired" };
    }
    throw new Error(
      `GUANGYA_DEVICE_TOKEN_FAILED: ${readString(body, "error_description") || error || `HTTP ${response.status}`}`,
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown, key: string): string {
  const raw = asRecord(value)?.[key];
  return typeof raw === "string" ? raw.trim() : "";
}

function readNumber(value: unknown, key: string): number | null {
  const raw = asRecord(value)?.[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}
