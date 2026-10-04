import "server-only";

import { scoutConnectBaseUrl } from "./remote-access";
import { normalizeTunnelId } from "./connect-tunnel";

const CONNECT_TIMEOUT_MS = 10_000;
const CONNECT_PROVISION_TIMEOUT_MS = 30_000;
const UNREACHABLE_MESSAGE = "连不上 Mediary Connect，检查这台机器能不能访问外网。";
const RATE_LIMITED_MESSAGE = "请求太频繁了，过几分钟再试。";
const INVALID_RESPONSE_MESSAGE = "Mediary Connect 返回了无效响应。";

export type ConnectFailureReason =
  | "unauthorized"
  | "rate_limited"
  | "unreachable"
  | "failed"
  | "bad_email"
  | "bad_slug"
  | "pending"
  | "unknown"
  | "expired"
  | "delivered"
  | "slow_down"
  | "checkout_not_open"
  | "checkout_unavailable"
  | "invalid_code"
  | "forbidden"
  | "no_entitlement"
  | "at_capacity"
  | "already_provisioned"
  | "slug_taken"
  | "no_endpoint"
  | "not_found"
  | "restore_cleanup_failed";

export type ConnectFailure = {
  ok: false;
  reason: ConnectFailureReason;
  message: string;
};

export interface ConnectClientOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export interface ConnectTier {
  id: "quarter" | "year" | "two_years";
  label: string;
  months: number;
  price: string;
  featured: boolean;
}

export interface ConnectEndpoint {
  slug: string;
  hostname: string;
  status: string;
  /** Cloudflare tunnel id; absent from older Connect versions. */
  tunnelId?: string;
}

export interface ConnectAccount {
  email: string;
  active: boolean;
  expiresAt: string | null;
  endpoint: ConnectEndpoint | null;
  checkoutOpen: boolean;
  tiers: ConnectTier[];
  /** The address this account can get back after renewing, when it has none live. */
  restorable: { slug: string; hostname: string } | null;
}

export type StartInstanceLinkResult =
  | ConnectFailure
  | {
      ok: true;
      pollSecret: string;
      verifyCode: string;
      expiresAt: string;
      interval: number;
    };

export type PollInstanceLinkResult =
  | ConnectFailure
  | { ok: true; status: "pending" }
  | { ok: true; status: "approved"; credential: string; email: string };

export type RevokeInstanceLinkResult = ConnectFailure | { ok: true };
export type ConnectAccountResult = ConnectFailure | ({ ok: true } & ConnectAccount);
export type ConnectCheckoutResult = ConnectFailure | { ok: true; checkoutUrl: string; orderId: string };
export type ConnectOrderStatus = "pending" | "paid_unfulfilled" | "fulfilled" | "closed" | "expired";
export type ConnectOrderStatusResult = ConnectFailure | { ok: true; status: ConnectOrderStatus };

export type ConnectSlugCheckResult =
  | ConnectFailure
  | { ok: true; available: true }
  | { ok: true; available: false; reason: "invalid" | "reserved" | "taken"; suggestions: string[] };

export type ConnectProvisionResult = ConnectFailure | { ok: true; hostname: string };
export type IssueClaimCodeResult = ConnectFailure | { ok: true; code: string; expires_at: string };
export type ExchangeClaimCodeResult = ConnectFailure | { ok: true; hostname: string; token: string };

type ParsedResponse =
  | { ok: true; body: unknown }
  | { ok: false; transport: boolean };

type RequestSuccess = { ok: true; response: Response; body: unknown; bodyError?: "failed" | "unreachable" };

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isoDate(value: unknown): value is string {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function baseUrl(options: ConnectClientOptions): string {
  return (options.baseUrl?.trim() || scoutConnectBaseUrl()).replace(/\/+$/, "");
}

function messageFor(reason: ConnectFailureReason): string {
  switch (reason) {
    case "unreachable":
      return UNREACHABLE_MESSAGE;
    case "rate_limited":
    case "slow_down":
      return RATE_LIMITED_MESSAGE;
    case "pending":
      return "正在等待确认。";
    case "unknown":
      return "这次连接请求不存在，请重新发起。";
    case "expired":
      return "这次连接请求已过期，请重新发起。";
    case "delivered":
      return "这次连接请求已经处理，请重新发起。";
    case "unauthorized":
      return "Mediary Connect 连接已失效，请重新连接。";
    case "bad_email":
      return "请输入有效的邮箱地址。";
    case "bad_slug":
      return "这个名字格式不对，请换一个。";
    case "checkout_not_open":
      return "购买暂时没有开放。";
    case "checkout_unavailable":
      return "现在打不开支付页面，请稍后再试。";
    case "invalid_code":
      return "接入码无效或已过期，请重新接入。";
    case "forbidden":
      return "接入码被拒绝，请重新接入。";
    case "no_entitlement":
      return "请先购买有效时长。";
    case "at_capacity":
      return "暂时售罄，请稍后再试。";
    case "restore_cleanup_failed":
      return "暂时恢复不了，请过几分钟再试；一直不行请联系我们。";
    case "already_provisioned":
      return "这个账号已经有一个域名。";
    case "slug_taken":
      return "这个名字已被占用，请换一个。";
    case "no_endpoint":
      return "还没有可接入的域名。";
    case "failed":
    default:
      return INVALID_RESPONSE_MESSAGE;
  }
}

function failure(reason: ConnectFailureReason, message = messageFor(reason)): ConnectFailure {
  return { ok: false, reason, message };
}

async function parseJson(response: Response): Promise<ParsedResponse> {
  try {
    return { ok: true, body: await response.json() };
  } catch (error) {
    // A malformed JSON response is an ordinary failed response. A body read that
    // was interrupted by the network or timeout is unreachable, just like fetch.
    const transport =
      error instanceof TypeError ||
      (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
    return { ok: false, transport };
  }
}

async function request(
  path: string,
  init: RequestInit,
  options: ConnectClientOptions,
): Promise<RequestSuccess | ConnectFailure> {
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`${baseUrl(options)}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(CONNECT_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    return failure("unreachable");
  }

  const parsed = await parseJson(response);
  if (!parsed.ok) {
    // Preserve the status code even when an error response has no JSON body.
    // 401 and generic 429 handling does not depend on a body; successful
    // responses still fail closed below.
    return { ok: true, response, body: undefined, bodyError: parsed.transport ? "unreachable" : "failed" };
  }
  return { ok: true, response, body: parsed.body };
}

function bodyFailure(result: RequestSuccess): ConnectFailure | null {
  return result.bodyError ? failure(result.bodyError) : null;
}

function jsonPost(body: unknown, credential?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
    },
    body: JSON.stringify(body),
  };
}

function bearerGet(credential: string): RequestInit {
  return { method: "GET", headers: { Authorization: `Bearer ${credential}` } };
}

function bearerPost(credential: string): RequestInit {
  return { method: "POST", headers: { Authorization: `Bearer ${credential}` } };
}

function statusFailure(response: Response, body: unknown, allowed: readonly string[] = []): ConnectFailure {
  if (response.status === 401) return failure("unauthorized");
  if (response.status === 429) return failure("rate_limited");
  if (allowed.includes(response.status.toString())) return failure("failed");
  return failure("failed");
}

function isStartBody(value: unknown): value is { pollSecret: string; verifyCode: string; expiresAt: string; interval: number } {
  return (
    record(value) &&
    nonEmptyString(value.pollSecret) &&
    nonEmptyString(value.verifyCode) &&
    isoDate(value.expiresAt) &&
    typeof value.interval === "number" &&
    Number.isInteger(value.interval) &&
    value.interval > 0
  );
}

function isPollApproved(value: unknown): value is { status: "approved"; credential: string; email: string } {
  return record(value) && value.status === "approved" && nonEmptyString(value.credential) && nonEmptyString(value.email);
}

function isPollPending(value: unknown): value is { status: "pending" } {
  return record(value) && value.status === "pending";
}

function isAccount(value: unknown): value is Omit<ConnectAccount, "restorable"> & { restorable?: unknown } {
  if (!record(value) || !nonEmptyString(value.email) || typeof value.active !== "boolean" || typeof value.checkoutOpen !== "boolean") {
    return false;
  }
  if (!(value.expiresAt === null || isoDate(value.expiresAt))) return false;
  if (value.endpoint !== null) {
    if (
      !record(value.endpoint) ||
      !nonEmptyString(value.endpoint.slug) ||
      !isConnectHostname(value.endpoint.hostname) ||
      !nonEmptyString(value.endpoint.status)
    ) {
      return false;
    }
  }
  if (!Array.isArray(value.tiers)) return false;
  return value.tiers.every(
    (tier) =>
      record(tier) &&
      (tier.id === "quarter" || tier.id === "year" || tier.id === "two_years") &&
      nonEmptyString(tier.label) &&
      typeof tier.months === "number" &&
      Number.isInteger(tier.months) &&
      tier.months > 0 &&
      nonEmptyString(tier.price) &&
      typeof tier.featured === "boolean",
  );
}

function isCheckout(value: unknown): value is { checkoutUrl: string; orderId: string } {
  if (!record(value) || !nonEmptyString(value.orderId) || !nonEmptyString(value.checkoutUrl)) return false;
  try {
    const url = new URL(value.checkoutUrl);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isOrder(value: unknown): value is { status: ConnectOrderStatus } {
  return (
    record(value) &&
    (value.status === "pending" ||
      value.status === "paid_unfulfilled" ||
      value.status === "fulfilled" ||
      value.status === "closed" ||
      value.status === "expired")
  );
}

function isSlugCheck(value: unknown): value is { available: true } | { available: false; reason: "invalid" | "reserved" | "taken"; suggestions: string[] } {
  if (!record(value) || typeof value.available !== "boolean") return false;
  if (value.available) return true;
  return (
    (value.reason === "invalid" || value.reason === "reserved" || value.reason === "taken") &&
    Array.isArray(value.suggestions) &&
    value.suggestions.every((suggestion) => typeof suggestion === "string")
  );
}

function isHostname(value: unknown): value is string {
  return isConnectHostname(value);
}

/** Same hostname contract as remote-access and the updater: DNS labels, alphabetic TLD. */
function isConnectHostname(value: unknown): value is string {
  if (!nonEmptyString(value)) return false;
  const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  return new RegExp(`^(?:${label}\\.)+[a-z]{2,63}$`).test(value);
}

function apiErrorReason(value: unknown): ConnectFailureReason | null {
  if (!record(value) || typeof value.error !== "string") return null;
  const reasons: Record<string, ConnectFailureReason> = {
    checkout_not_open: "checkout_not_open",
    checkout_unavailable: "checkout_unavailable",
    no_entitlement: "no_entitlement",
    "at capacity": "at_capacity",
    bad_email: "bad_email",
    "bad email": "bad_email",
    invalid_email: "bad_email",
    "invalid email": "bad_email",
    bad_slug: "bad_slug",
    "bad slug": "bad_slug",
    "already provisioned": "already_provisioned",
    "slug taken": "slug_taken",
    "restore cleanup failed": "restore_cleanup_failed",
  };
  return reasons[value.error] ?? null;
}

function pollErrorReason(response: Response, body: unknown): ConnectFailureReason | null {
  if (response.status === 401) return "unauthorized";
  if (response.status === 429) return record(body) && body.status === "slow_down" ? "slow_down" : "rate_limited";
  if (response.status === 404) return record(body) && body.status === "unknown" ? "unknown" : null;
  if (response.status === 410) {
    if (record(body) && body.status === "expired") return "expired";
    if (record(body) && body.status === "delivered") return "delivered";
  }
  return null;
}

export async function startInstanceLink(email: string, options: ConnectClientOptions = {}): Promise<StartInstanceLinkResult> {
  const result = await request("/api/instance-link/start", jsonPost({ email }), options);
  if (!result.ok) return result;
  if (result.response.status === 401) return failure("unauthorized");
  if (result.response.status === 429) return failure("rate_limited");
  if (result.response.status === 400) {
    return failure("bad_email");
  }
  const bodyError = bodyFailure(result);
  if (bodyError) return bodyError;
  if (result.response.status !== 202) return statusFailure(result.response, result.body);
  return isStartBody(result.body) ? { ok: true, ...result.body } : failure("failed");
}

export async function pollInstanceLink(pollSecret: string, options: ConnectClientOptions = {}): Promise<PollInstanceLinkResult> {
  const result = await request("/api/instance-link/poll", jsonPost({ pollSecret }), options);
  if (!result.ok) return result;
  if (result.response.status === 200) {
    const bodyError = bodyFailure(result);
    if (bodyError) return bodyError;
    if (isPollPending(result.body)) return { ok: true, status: "pending" };
    if (isPollApproved(result.body)) return { ok: true, ...result.body };
    return failure("failed");
  }
  const reason = pollErrorReason(result.response, result.body);
  if (reason === "slow_down" || reason === "rate_limited" || reason === "unauthorized") return failure(reason);
  const bodyError = bodyFailure(result);
  if (bodyError) return bodyError;
  return reason ? failure(reason) : statusFailure(result.response, result.body);
}

export async function revokeInstanceLink(credential: string, options: ConnectClientOptions = {}): Promise<RevokeInstanceLinkResult> {
  const result = await request("/api/instance-link/revoke", bearerPost(credential), options);
  if (!result.ok) return result;
  if (result.response.status === 401) return failure("unauthorized");
  if (result.response.status === 429) return failure("rate_limited");
  const bodyError = bodyFailure(result);
  if (bodyError) return bodyError;
  if (result.response.status === 200 && record(result.body) && result.body.ok === true) return { ok: true };
  return statusFailure(result.response, result.body);
}

export async function getConnectAccount(credential: string, options: ConnectClientOptions = {}): Promise<ConnectAccountResult> {
  const result = await request("/api/account", bearerGet(credential), options);
  if (!result.ok) return result;
  if (result.response.status === 401) return failure("unauthorized");
  if (result.response.status === 429) return failure("rate_limited");
  const bodyError = bodyFailure(result);
  if (bodyError) return bodyError;
  if (result.response.status === 200 && isAccount(result.body)) {
    const { endpoint, restorable } = result.body;
    const normalizedEndpoint = endpoint === null ? null : { ...endpoint };
    if (normalizedEndpoint) {
      const tunnelId = normalizeTunnelId(normalizedEndpoint.tunnelId);
      if (tunnelId) normalizedEndpoint.tunnelId = tunnelId;
      else delete normalizedEndpoint.tunnelId;
    }
    return {
      ok: true,
      ...result.body,
      endpoint: normalizedEndpoint,
      restorable: record(restorable) && nonEmptyString(restorable.slug) && isConnectHostname(restorable.hostname)
        ? { slug: restorable.slug, hostname: restorable.hostname }
        : null,
    };
  }
  return statusFailure(result.response, result.body);
}

export async function createConnectCheckout(
  credential: string,
  tier: ConnectTier["id"],
  returnUrl: string | undefined,
  options: ConnectClientOptions = {},
): Promise<ConnectCheckoutResult> {
  const result = await request("/api/checkout", jsonPost({ tier, ...(returnUrl === undefined ? {} : { returnUrl }) }, credential), options);
  if (!result.ok) return result;
  if (result.response.status === 401 || result.response.status === 429) return failure(result.response.status === 401 ? "unauthorized" : "rate_limited");
  const bodyError = bodyFailure(result);
  if (bodyError) return bodyError;
  if (result.response.status === 200 && isCheckout(result.body)) return { ok: true, ...result.body };
  if (result.response.status === 503) {
    const reason = apiErrorReason(result.body);
    if (reason === "checkout_not_open" || reason === "checkout_unavailable") return failure(reason);
  }
  return statusFailure(result.response, result.body);
}

export async function getConnectOrderStatus(
  credential: string,
  orderId: string,
  options: ConnectClientOptions = {},
): Promise<ConnectOrderStatusResult> {
  const result = await request(`/api/orders/${encodeURIComponent(orderId)}/status`, bearerGet(credential), options);
  if (!result.ok) return result;
  if (result.response.status === 401) return failure("unauthorized");
  // Not an order of this account (e.g. one created before another account was linked).
  if (result.response.status === 404) return failure("not_found");
  if (result.response.status === 429) return failure("rate_limited");
  const bodyError = bodyFailure(result);
  if (bodyError) return bodyError;
  if (result.response.status === 200 && isOrder(result.body)) return { ok: true, ...result.body };
  return statusFailure(result.response, result.body);
}

export async function checkConnectSlug(
  credential: string,
  slug: string,
  options: ConnectClientOptions = {},
): Promise<ConnectSlugCheckResult> {
  const result = await request(`/api/slug/check?s=${encodeURIComponent(slug)}`, bearerGet(credential), options);
  if (!result.ok) return result;
  if (result.response.status === 401 || result.response.status === 429) return failure(result.response.status === 401 ? "unauthorized" : "rate_limited");
  const bodyError = bodyFailure(result);
  if (bodyError) return bodyError;
  if (result.response.status === 200 && isSlugCheck(result.body)) return { ok: true, ...result.body };
  return statusFailure(result.response, result.body);
}

export async function provisionConnectSlug(
  credential: string,
  slug: string,
  options: ConnectClientOptions = {},
): Promise<ConnectProvisionResult> {
  // Provisioning creates the Cloudflare tunnel and DNS record before it answers: give it longer
  // than the other calls, so a slow Cloudflare does not turn into a lost answer.
  const result = await request(
    "/api/provision",
    { ...jsonPost({ slug }, credential), signal: AbortSignal.timeout(CONNECT_PROVISION_TIMEOUT_MS) },
    options,
  );
  if (!result.ok) return result;
  if (result.response.status === 401) return failure("unauthorized");
  if (result.response.status === 429) return failure("rate_limited");
  if (result.response.status === 400) return failure("bad_slug");
  if (result.response.status === 402) return failure("no_entitlement");
  const bodyError = bodyFailure(result);
  if (bodyError) return bodyError;
  if (result.response.status === 200 && record(result.body) && isHostname(result.body.hostname)) {
    return { ok: true, hostname: result.body.hostname };
  }
  if (result.response.status === 409) {
    const reason = apiErrorReason(result.body);
    if (reason === "already_provisioned" || reason === "slug_taken") return failure(reason);
  }
  if (result.response.status === 503) {
    const reason = apiErrorReason(result.body);
    if (reason === "at_capacity" || reason === "restore_cleanup_failed") return failure(reason);
  }
  return statusFailure(result.response, result.body);
}

export async function issueClaimCode(credential: string, options: ConnectClientOptions = {}): Promise<IssueClaimCodeResult> {
  const result = await request("/api/claim-code", bearerPost(credential), options);
  if (!result.ok) return result;
  if (result.response.status === 401) return failure("unauthorized");
  if (result.response.status === 429) return failure("rate_limited");
  const bodyError = bodyFailure(result);
  if (bodyError) return bodyError;
  if (
    result.response.status === 200 &&
    record(result.body) &&
    nonEmptyString(result.body.code) &&
    isoDate(result.body.expires_at)
  ) {
    return { ok: true, code: result.body.code, expires_at: result.body.expires_at };
  }
  if (result.response.status === 404) {
    // The route uses a status code for the only expected 404, but still accept
    // only a JSON error body so an HTML proxy page is treated as a failed call.
    if (record(result.body) && result.body.error === "no active endpoint") return failure("no_endpoint");
  }
  return statusFailure(result.response, result.body);
}

export async function exchangeClaimCode(code: string, options: ConnectClientOptions = {}): Promise<ExchangeClaimCodeResult> {
  const result = await request("/api/claim/exchange", jsonPost({ code }), options);
  if (!result.ok) return result;
  if (result.response.status === 401) return failure("unauthorized");
  if (result.response.status === 403) return failure("forbidden");
  if (result.response.status === 400) return failure("invalid_code");
  if (result.response.status === 429) return failure("rate_limited");
  const bodyError = bodyFailure(result);
  if (bodyError) return bodyError;
  if (
    result.response.status === 200 &&
    record(result.body) &&
    isHostname(result.body.hostname) &&
    nonEmptyString(result.body.token)
  ) {
    return { ok: true, hostname: result.body.hostname, token: result.body.token };
  }
  return statusFailure(result.response, result.body);
}
