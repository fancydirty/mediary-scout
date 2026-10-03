import type { InstanceCredentialRow, InstanceLinkRequestRow } from "./db.js";
import type { RouteDeps } from "./routes.js";
import { assertSameOriginRequest, readJsonBody, upsertAccount } from "./routes.js";
import { HttpError, htmlPage, json } from "./http.js";
import { checkRateLimit, SIGNUP_EMAIL_RATE_LIMIT, SIGNUP_IP_RATE_LIMIT, SIGNUP_RATE_WINDOW_MS } from "./rate-limit.js";
import { sha256Hex } from "./crypto-token.js";
import { signToken, verifyToken } from "./signed-token.js";
import { buildSessionCookie } from "./session.js";
import { EMAIL_MAX_LENGTH, EMAIL_RE } from "./validation.js";
import { instanceLinkPage } from "./html/instance-link-page.js";
import { instanceCredentialFromAuthorization } from "./account-auth.js";
import { newId } from "./ids.js";

const INSTANCE_LINK_TTL_MS = 30 * 60_000;
const INSTANCE_LINK_APPROVED_GRACE_MS = 5 * 60_000;
const VERIFY_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

function randomBytesBase64Url(size: number): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function verifyCode(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += VERIFY_ALPHABET[b % VERIFY_ALPHABET.length];
  return out;
}

function requestedIp(request: Request): string {
  return request.headers.get("cf-connecting-ip")?.trim() || "";
}

async function instanceLinkRateLimited(request: Request, email: string, deps: RouteDeps): Promise<boolean> {
  const ip = requestedIp(request);
  if (ip !== "") {
    const ipResult = await checkRateLimit({
      store: deps.db,
      bucket: "instance_link_ip",
      key: ip,
      limit: SIGNUP_IP_RATE_LIMIT,
      windowMs: SIGNUP_RATE_WINDOW_MS,
      now: () => Date.parse(deps.now()),
    });
    if (!ipResult.allowed) return true;
  }
  const emailResult = await checkRateLimit({
    store: deps.db,
    bucket: "instance_link_email",
    key: email,
    limit: SIGNUP_EMAIL_RATE_LIMIT,
    windowMs: SIGNUP_RATE_WINDOW_MS,
    now: () => Date.parse(deps.now()),
  });
  return !emailResult.allowed;
}

async function signInstanceLinkToken(id: string, deps: RouteDeps): Promise<string> {
  return signToken(
    { purpose: "instance-link", subject: id },
    { key: deps.sessionSecret, ttlMs: INSTANCE_LINK_TTL_MS, now: Date.parse(deps.now()) },
  );
}

async function verifyInstanceLinkToken(
  token: string,
  deps: RouteDeps,
): Promise<{ subject: string; expired: boolean } | null> {
  const result = await verifyToken(token, {
    key: deps.sessionSecret,
    expectPurpose: "instance-link",
    now: Date.parse(deps.now()),
  });
  if (result.ok) return { subject: result.subject, expired: false };
  if (result.reason !== "expired") return null;
  // 到期链接也要返回行级 410，但仍先验签。
  const expiredResult = await verifyToken(token, {
    key: deps.sessionSecret,
    expectPurpose: "instance-link",
    now: 0,
  });
  return expiredResult.ok ? { subject: expiredResult.subject, expired: true } : null;
}

/** 发起实例连接。 */
export async function startInstanceLink(request: Request, deps: RouteDeps): Promise<Response> {
  assertSameOriginRequest(request, new URL(request.url));
  const body = await readJsonBody(request);
  const raw = body.email;
  if (typeof raw !== "string") throw new HttpError(400, "email required");
  const email = raw.trim().toLowerCase();
  if (email.length > EMAIL_MAX_LENGTH || !EMAIL_RE.test(email)) {
    throw new HttpError(400, "invalid email");
  }
  if (await instanceLinkRateLimited(request, email, deps)) {
    return json({ error: "too_many_requests" }, 429, { noStore: true });
  }
  const now = deps.now();
  const expiresAt = new Date(Date.parse(now) + INSTANCE_LINK_TTL_MS).toISOString();
  const pollSecret = randomBytesBase64Url(32);
  const row: InstanceLinkRequestRow = {
    id: newId("ilr"),
    poll_secret_sha256: await sha256Hex(pollSecret),
    email,
    verify_code: verifyCode(),
    status: "pending",
    account_id: null,
    request_ip: requestedIp(request) || null,
    created_at: now,
    expires_at: expiresAt,
    approved_at: null,
    delivered_at: null,
    last_polled_at: null,
  };
  await deps.db.insertInstanceLinkRequest(row);
  const origin = deps.waffoEnvironment === "test"
    ? new URL(request.url).origin
    : `https://${deps.rootDomain.trim().toLowerCase()}`;
  const token = await signInstanceLinkToken(row.id, deps);
  const url = `${origin}/link?t=${encodeURIComponent(token)}`;
  try {
    await deps.sendInstanceLinkEmail(email, {
      url,
      verifyCode: row.verify_code,
      requestIp: row.request_ip ?? "",
      requestedAt: row.created_at,
    });
  } catch (error) {
    // 发信失败不改变 202 结果。非 2xx 由 sender 自己记日志；fetch 直接抛错（DNS、超时）只有这里
    // 能看见。日志里不放邮箱和链接。
    console.error("instance link email failed:", error instanceof Error ? `${error.name}: ${error.message}` : "unknown error");
  }
  return json({ pollSecret, verifyCode: row.verify_code, expiresAt, interval: 3 }, 202, { noStore: true });
}

/** 显示连接确认页。 */
export async function instanceLinkLanding(url: URL, deps: RouteDeps): Promise<Response> {
  const token = await verifyInstanceLinkToken(url.searchParams.get("t") ?? "", deps);
  if (token === null) return htmlPage(instanceLinkPage({ kind: "invalid" }), { noStore: true });
  const row = await deps.db.getInstanceLinkRequestById(token.subject);
  if (row === null) {
    return htmlPage(instanceLinkPage({ kind: "invalid" }), { noStore: true });
  }
  if (row.status !== "pending") {
    return htmlPage(instanceLinkPage({ kind: "confirmed" }), { noStore: true });
  }
  if (Date.parse(deps.now()) >= Date.parse(row.expires_at)) {
    return htmlPage(instanceLinkPage({ kind: "invalid" }), { noStore: true });
  }
  return htmlPage(
    instanceLinkPage({
      kind: "pending",
      email: row.email,
      verifyCode: row.verify_code,
      requestIp: row.request_ip ?? "",
      requestedAt: row.created_at,
    }),
    { noStore: true },
  );
}

/** 确认实例连接。 */
export async function confirmInstanceLink(request: Request, deps: RouteDeps): Promise<Response> {
  assertSameOriginRequest(request, new URL(request.url));
  const body = await readJsonBody(request);
  const token = typeof body.t === "string" ? body.t.trim() : "";
  const verified = await verifyInstanceLinkToken(token, deps);
  if (verified === null) throw new HttpError(400, "invalid or expired link");
  const row = await deps.db.getInstanceLinkRequestById(verified.subject);
  if (row === null) throw new HttpError(400, "invalid or expired link");
  if (row.status !== "pending") throw new HttpError(409, "already_confirmed");
  if (verified.expired || Date.parse(deps.now()) >= Date.parse(row.expires_at)) {
    throw new HttpError(410, "expired");
  }
  // 邮箱已验证，复用登录账号并建立控制台会话。
  const account = await upsertAccount(row.email, deps);
  await deps.db.updateAccountLastLogin(account.id, deps.now());
  const approved = await deps.db.approveInstanceLinkRequest(verified.subject, account.id, deps.now());
  if (!approved) {
    const latest = await deps.db.getInstanceLinkRequestById(verified.subject);
    if (latest !== null && Date.parse(deps.now()) >= Date.parse(latest.expires_at)) {
      throw new HttpError(410, "expired");
    }
    throw new HttpError(409, "already_confirmed");
  }
  const cookie = await buildSessionCookie(account.id, {
    secret: deps.sessionSecret,
    ttlMs: 30 * 24 * 3600_000,
    now: Date.parse(deps.now()),
  });
  const response = json({ ok: true }, 200, { noStore: true });
  response.headers.set("set-cookie", cookie);
  return response;
}

/** 轮询连接状态。 */
export async function pollInstanceLink(request: Request, deps: RouteDeps): Promise<Response> {
  assertSameOriginRequest(request, new URL(request.url));
  const body = await readJsonBody(request);
  const secret = typeof body.pollSecret === "string" ? body.pollSecret : "";
  if (!secret || !B64URL_RE.test(secret)) return json({ status: "unknown" }, 404, { noStore: true });
  let row = await deps.db.getInstanceLinkRequestByPollSecretSha(await sha256Hex(secret));
  if (row === null) return json({ status: "unknown" }, 404, { noStore: true });
  const now = deps.now();
  // delivered 是终态，不能再返回 slow_down。
  if (row.status === "delivered") return json({ status: "delivered" }, 410, { noStore: true });
  if (row.status === "pending" && Date.parse(now) >= Date.parse(row.expires_at)) {
    return json({ status: "expired" }, 410, { noStore: true });
  }
  if (
    row.status === "approved" &&
    Date.parse(now) >= Date.parse(row.expires_at) + INSTANCE_LINK_APPROVED_GRACE_MS
  ) {
    return json({ status: "expired" }, 410, { noStore: true });
  }
  // approved 请求必须走交付 CAS，并发失败者返回 delivered。
  if (row.status === "pending") {
    const touched = await deps.db.touchInstanceLinkPoll(row.id, now);
    if (!touched) {
      const latest = await deps.db.getInstanceLinkRequestById(row.id);
      if (latest === null || latest.status === "delivered") {
        return json({ status: "delivered" }, 410, { noStore: true });
      }
      if (latest.status === "pending") {
        if (Date.parse(now) >= Date.parse(latest.expires_at)) {
          return json({ status: "expired" }, 410, { noStore: true });
        }
        return json({ status: "slow_down" }, 429, { noStore: true });
      }
      row = latest;
    } else {
      return json({ status: "pending" }, 200, { noStore: true });
    }
  }
  if (row.account_id === null) throw new HttpError(500, "instance link missing account");
  const credential = `ic_${randomBytesBase64Url(32)}`;
  const credentialId = newId("icr");
  const credentialRow: InstanceCredentialRow = {
    id: credentialId,
    account_id: row.account_id,
    credential_sha256: await sha256Hex(credential),
    link_request_id: row.id,
    created_at: now,
    last_used_at: null,
    revoked_at: null,
  };
  const delivered = await deps.db.deliverInstanceCredential({
    requestId: row.id,
    credential: credentialRow,
    nowIso: now,
  });
  if (!delivered) return json({ status: "delivered" }, 410, { noStore: true });
  return json({ status: "approved", credential, email: row.email }, 200, { noStore: true });
}

/** 吊销实例凭据。 */
export async function revokeInstanceLink(request: Request, deps: RouteDeps): Promise<Response> {
  assertSameOriginRequest(request, new URL(request.url));
  const credential = instanceCredentialFromAuthorization(request.headers.get("authorization") ?? "");
  if (credential === null) throw new HttpError(401, "unauthorized");
  const row = await deps.db.getActiveInstanceCredentialBySha(await sha256Hex(credential));
  if (row === null) throw new HttpError(401, "unauthorized");
  await deps.db.revokeInstanceCredential(row.id, deps.now());
  return json({ ok: true }, 200, { noStore: true });
}
