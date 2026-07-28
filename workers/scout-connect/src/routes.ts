import type { CfApi } from "./cf-api.js";
import type { AccountRow, ConnectDb } from "./db.js";
import { HttpError, handleError, htmlPage, json } from "./http.js";
import { requireAdmin } from "./auth.js";
import { provisionEndpoint } from "./provision.js";
import { revokeEndpoint } from "./revoke.js";
import { revealByCode } from "./reveal.js";
import { assertSlug } from "./slug.js";
import { homePage } from "./html/home-page.js";
import { adminPage } from "./html/admin-page.js";
import { invitePage, type InvitePageState } from "./html/invite-page.js";
import { betaPage, normalizeTurnstileSitekey } from "./html/beta-page.js";
import { compliancePage, COMPLIANCE_PAGES, type CompliancePageKey } from "./html/compliance-page.js";
import { consolePage } from "./html/console-page.js";
import { loginPage } from "./html/login-page.js";
import { EMAIL_MAX_LENGTH, EMAIL_RE } from "./validation.js";
import { newId } from "./ids.js";
import { sha256Hex } from "./crypto-token.js";
import { signToken, verifyToken } from "./signed-token.js";
import { buildSessionCookie, parseSessionCookie } from "./session.js";
import { computeExpiry } from "./entitlement.js";

// Same aperture mark as apps/web/app/icon.svg — the product brand.
const LOGO_SVG =
  '<svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><circle cx="16" cy="16" r="16" fill="#1ED760"/><g transform="translate(4,4)" fill="none" stroke="#0B3B1E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m14.31 8 5.74 9.94"/><path d="M9.69 8h11.48"/><path d="m7.38 12 5.74-9.94"/><path d="M9.69 16 3.95 6.06"/><path d="M14.31 16H2.83"/><path d="m16.62 12-5.74 9.94"/></g></svg>';

export interface RouteDeps {
  db: ConnectDb;
  cf: CfApi;
  adminToken: string;
  rootDomain: string;
  tokenWrapKeyHex: string;
  now: () => string;
  newInviteId: () => string;
  newEndpointId: () => string;
  newAuditId: () => string;
  newInviteCode: () => string;
  // Cloudflare Turnstile config for the public waitlist gate. Both optional —
  // the gate is active ONLY when both are set — the paired rule lives in
  // turnstileSitekeyIfConfigured() / turnstileGateEnabled() below;
  // either absent → no widget rendered, POST /waitlist skips verification.
  turnstileSitekey?: string | undefined;
  turnstileSecret?: string | undefined;
  // P3: 魔法链接登录
  newAccountId: () => string;
  newEntitlementId: () => string;
  sessionSecret: string;
  /** 发一封含魔法链接的邮件。注入以便测试不打真 Resend。 */
  sendMagicLink: (to: string, url: string) => Promise<void>;
}

export async function handleRequest(request: Request, deps: RouteDeps): Promise<Response> {
  try {
    return await route(request, deps);
  } catch (e) {
    return handleError(e);
  }
}

/**
 * Hard cap on any request body this Worker will buffer or parse.
 *
 * 8 KB, because every body we accept is tiny and fixed-shape: `{email}` on
 * POST /waitlist (an email is capped at 254 bytes by RFC 5321 — see
 * EMAIL_MAX_LENGTH), `{email, slug, invitee_label}` on invite creation,
 * `{slug}` on provision, and `{version, uptime_seconds}` on the status
 * heartbeat. 8 KB is ~30x the largest of those, so it cannot reject a
 * legitimate caller, while still being small enough that the worst case a
 * stranger can force is trivial.
 *
 * This matters because POST /waitlist is public and unauthenticated, and this
 * Worker shares its D1 instance with the provisioning control plane: an
 * unbounded read+JSON.parse here is free CPU/memory amplification that
 * degrades provisioning and revocation, not just the waitlist.
 */
export const MAX_JSON_BODY_BYTES = 8 * 1024;

/**
 * Cheap pre-read rejection on the DECLARED size. Costs nothing and refuses the
 * request before a single byte is buffered — but it is only half the defence,
 * because Content-Length is absent under chunked encoding and is attacker-
 * controlled besides. readBodyTextCapped() enforces the real limit.
 */
function assertDeclaredSizeWithinCap(request: Request): void {
  const declared = request.headers.get("content-length");
  if (declared === null) {
    return;
  }
  const bytes = Number(declared);
  if (Number.isFinite(bytes) && bytes > MAX_JSON_BODY_BYTES) {
    throw new HttpError(413, "body too large");
  }
}

/**
 * Reads the body with a genuine streaming cap: we stop pulling and cancel the
 * stream the moment the running total crosses MAX_JSON_BODY_BYTES, so an
 * attacker's 500 MB body costs us one chunk, not 500 MB. `await
 * request.text()` cannot do this — it buffers everything first, which is
 * exactly the amplification being fixed.
 *
 * Counts BYTES off the wire, not `String.length`: a JS string length is UTF-16
 * code units, so a multibyte payload is up to 3x larger than a post-decode
 * length check would suggest.
 */
async function readBodyTextCapped(request: Request): Promise<string> {
  const body = request.body;
  if (body === null) {
    return "";
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }
      total += value.byteLength;
      if (total > MAX_JSON_BODY_BYTES) {
        await reader.cancel();
        throw new HttpError(413, "body too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  assertDeclaredSizeWithinCap(request);
  const text = await readBodyTextCapped(request);
  if (text.trim() === "") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid json");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "invalid body");
  }
  return parsed as Record<string, unknown>;
}

function optString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function decodeParam(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new HttpError(400, "bad encoding");
  }
}

async function route(request: Request, deps: RouteDeps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // www.* → apex, preserving path (and query).
  if (url.hostname.toLowerCase().startsWith("www.")) {
    const target = new URL(url.toString());
    target.hostname = url.hostname.slice("www.".length);
    return Response.redirect(target.toString(), 301);
  }

  if (method === "GET" && path === "/") {
    // The beta subdomain's root IS the signup page: "beta.mediaryconnect.app"
    // is the canonical marketing URL, so "beta.…/beta" would stutter. Apex
    // keeps the Mediary Connect home page; the check is host-exact so no other
    // subdomain (or the apex) accidentally gets the signup page.
    // Normalize BOTH sides: url.hostname is already lowercase, but
    // deps.rootDomain comes from env (CONNECT_ROOT_DOMAIN) untrimmed — a
    // mixed-case or space-padded value would silently break this routing.
    const betaHost = `beta.${deps.rootDomain.trim().toLowerCase()}`;
    if (url.hostname.toLowerCase() === betaHost) {
      return htmlPage(betaPage(turnstileSitekeyIfConfigured(deps)));
    }
    return htmlPage(homePage());
  }
  // 合规五页（条款/隐私/退款/定价/联系）——Paddle 域名审核硬性要求。
  // 两个 host 都放行：审核看的是 mediaryconnect.app，但 beta 页脚也要能链到。
  if (method === "GET" && path.length > 1) {
    const key = path.slice(1);
    // Object.hasOwn 而非 `in`：后者沿原型链找到 toString/valueOf，
    // 随后 compliancePage() 因内容缺失抛错变 500（round 1 评审抓到）。
    if (Object.hasOwn(COMPLIANCE_PAGES, key)) {
      return htmlPage(compliancePage(key as CompliancePageKey));
    }
  }
  if (method === "GET" && path === "/healthz") {
    return new Response("ok", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  // P3: 魔法链接登录
  if (method === "POST" && path === "/api/auth/magic") {
    return await requestMagicLink(request, deps);
  }
  if (method === "GET" && path === "/auth/callback") {
    return await magicCallback(url, deps);
  }
  if (method === "GET" && path === "/login") {
    return htmlPage(loginPage(turnstileSitekeyIfConfigured(deps)));
  }
  if (method === "GET" && path === "/console") {
    return await consoleRoute(request, deps);
  }
  // Brand logo for Access Custom Pages + invite page — self-hosted so we don't
  // depend on any external asset host.
  if (method === "GET" && path === "/logo.svg") {
    return new Response(LOGO_SVG, {
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "public, max-age=86400",
      },
    });
  }
  if (method === "GET" && path === "/admin") {
    return htmlPage(adminPage());
  }
  if (method === "GET" && path === "/beta") {
    return htmlPage(betaPage(turnstileSitekeyIfConfigured(deps)));
  }

  // ---- admin api (bearer required) ----
  if (path === "/api/admin/invites") {
    requireAdmin(request, deps.adminToken);
    if (method === "GET") {
      return json({ invites: await deps.db.listInvites() });
    }
    if (method === "POST") {
      return await createInvite(request, url, deps);
    }
    throw new HttpError(404, "not found");
  }

  if (path === "/api/admin/endpoints" && method === "GET") {
    requireAdmin(request, deps.adminToken);
    // PUBLIC shape only — token_ciphertext / token_sha256 (and CF-internal
    // resource ids besides the tunnel id) must never leave the server.
    const endpoints = (await deps.db.listEndpoints()).map((ep) => ({
      id: ep.id,
      invite_id: ep.invite_id,
      slug: ep.slug,
      hostname: ep.hostname,
      status: ep.status,
      token_shown_at: ep.token_shown_at,
      last_seen_at: ep.last_seen_at,
      created_at: ep.created_at,
      revoked_at: ep.revoked_at,
      cf_tunnel_id: ep.cf_tunnel_id,
    }));
    return json({ endpoints });
  }

  if (path === "/api/admin/waitlist" && method === "GET") {
    requireAdmin(request, deps.adminToken);
    // Queue order straight from the db
    return json({ waitlist: await deps.db.listWaitlist(WAITLIST_BATCH) });
  }

  if (path === "/api/admin/grant" && method === "POST") {
    return await adminGrant(request, deps);
  }

  if (path === "/api/admin/audits" && method === "GET") {
    requireAdmin(request, deps.adminToken);
    // Operator-facing read of the audit log (newest first, from the db).
    // detail_json may carry invitee emails — same sensitivity as the invites
    // list, and this route sits behind the same admin bearer as that one.
    return json({ audits: await deps.db.listAudits() });
  }

  const provisionMatch = path.match(/^\/api\/admin\/invites\/([^/]+)\/provision$/);
  if (provisionMatch !== null && method === "POST") {
    requireAdmin(request, deps.adminToken);
    return await provisionInvite(request, url, deps, decodeParam(provisionMatch[1] ?? ""));
  }

  const revokeMatch = path.match(/^\/api\/admin\/endpoints\/([^/]+)\/revoke$/);
  if (revokeMatch !== null && method === "POST") {
    requireAdmin(request, deps.adminToken);
    const endpointId = decodeParam(revokeMatch[1] ?? "");
    // 404 (not 500) for a missing endpoint — the admin client distinguishes
    // "already gone" from "revoke failed".
    if ((await deps.db.getEndpointById(endpointId)) === null) {
      throw new HttpError(404, "endpoint not found");
    }
    const result = await revokeEndpoint({
      endpointId,
      deps: { cf: deps.cf, db: deps.db, now: deps.now, newAuditId: deps.newAuditId },
    });
    return json({ hostname: result.hostname, revoked: true });
  }

  // ---- invitee ----
  const inviteMatch = path.match(/^\/i\/([^/]+)$/);
  if (inviteMatch !== null && method === "GET") {
    const state = await inviteState(deps, decodeParam(inviteMatch[1] ?? ""));
    return htmlPage(invitePage(state));
  }

  const revealMatch = path.match(/^\/api\/i\/([^/]+)\/reveal$/);
  if (revealMatch !== null && method === "POST") {
    return await revealInvite(deps, decodeParam(revealMatch[1] ?? ""));
  }

  // ---- public waitlist ----
  if (path === "/waitlist" && method === "POST") {
    return await addToWaitlist(request, deps);
  }
  if (path === "/waitlist/survey" && method === "POST") {
    return await saveWaitlistSurvey(request, deps);
  }

  // ---- instance status reporting (bearer token auth) ----
  if (path === "/api/instance/status" && method === "POST") {
    return await reportInstanceStatus(request, deps);
  }

  throw new HttpError(404, "not found");
}

// P3: 魔法链接登录 —— magic purpose token 有效期 30 分钟。
const MAGIC_TTL_MS = 30 * 60_000;
// session 有效期 30 天(低频访问,长会话减少重复登录摩擦)。
const SESSION_TTL_MS = 30 * 24 * 3600_000;

async function requestMagicLink(request: Request, deps: RouteDeps): Promise<Response> {
  const body = await readJsonBody(request);
  const emailRaw = body.email;
  if (typeof emailRaw !== "string") throw new HttpError(400, "email required");
  const email = emailRaw.trim().toLowerCase();
  if (email.length > EMAIL_MAX_LENGTH || !EMAIL_RE.test(email)) {
    throw new HttpError(400, "invalid email");
  }
  // 与 /waitlist 同一条防滥用规则:Turnstile 成对配置时,发信入口也要过人机
  // 校验——否则这是个公开的「触发发邮件」放大面。校验在邮箱形状之后:
  // 一次性 token 不浪费在注定 400 的请求上。
  await requireTurnstileIfEnabled(request, body, deps);
  // 注册即登录:不论邮箱是否已存在都发信,不泄露注册状态。账号在 callback
  // 落地时才创建(避免未验证邮箱污染 accounts 表)。
  const token = await signToken(
    { purpose: "magic", subject: email },
    { key: deps.sessionSecret, ttlMs: MAGIC_TTL_MS, now: Date.parse(deps.now()) },
  );
  // rootDomain 需 normalize:CONNECT_ROOT_DOMAIN 可能带空白/大小写,直拼到邮件
  // 链接里会坏掉——与路由期待的规范 host 不符(Copilot round 3)。
  const domain = deps.rootDomain.trim().toLowerCase();
  const url = `https://${domain}/auth/callback?t=${encodeURIComponent(token)}`;
  // 发信失败不改变对外结果(固定 202):既不泄露邮箱是否存在,也不让
  // Resend 的抖动变成用户可见的 500。失败在 sender 内部已 console.error。
  try {
    await deps.sendMagicLink(email, url);
  } catch {
    // swallowed — sender logs its own diagnostics
  }
  // 固定 202,无论邮箱存在与否。
  return json({ ok: true }, 202, { noStore: true });
}

/** 按 email upsert 账号,race-safe:两个并发请求可能都读到 null,第二个
 *  INSERT 撞 UNIQUE(email) —— 捕获后重读,而不是让登录 500(Copilot round 2)。 */
async function upsertAccount(email: string, deps: RouteDeps): Promise<AccountRow> {
  const existing = await deps.db.getAccountByEmail(email);
  if (existing !== null) return existing;
  try {
    return await deps.db.insertAccount({
      id: deps.newAccountId(),
      email,
      paddle_customer_id: null,
      created_at: deps.now(),
      last_login_at: null,
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // 并发对手赢了这一插:重读它插入的行。
    const raced = await deps.db.getAccountByEmail(email);
    if (raced === null) throw e; // UNIQUE 失败却读不到 → 真异常,不吞
    return raced;
  }
}

async function magicCallback(url: URL, deps: RouteDeps): Promise<Response> {
  const token = url.searchParams.get("t") ?? "";
  const result = await verifyToken(token, {
    key: deps.sessionSecret,
    now: Date.parse(deps.now()),
    expectPurpose: "magic",
  });
  if (!result.ok) throw new HttpError(400, "invalid or expired link");
  const email = result.subject;

  // 账号 upsert:首次登录建号,之后复用。
  const account = await upsertAccount(email, deps);
  await deps.db.updateAccountLastLogin(account.id, deps.now());

  const cookie = await buildSessionCookie(account.id, {
    secret: deps.sessionSecret,
    ttlMs: SESSION_TTL_MS,
    now: Date.parse(deps.now()),
  });
  return new Response(null, {
    status: 302,
    headers: { location: "/console", "set-cookie": cookie, "cache-control": "no-store" },
  });
}

async function consoleRoute(request: Request, deps: RouteDeps): Promise<Response> {
  const session = await parseSessionCookie(request.headers.get("cookie"), {
    secret: deps.sessionSecret,
    now: Date.parse(deps.now()),
  });
  if (!session.ok) {
    return new Response(null, { status: 302, headers: { location: "/login" } });
  }
  const account = await deps.db.getAccountById(session.accountId);
  if (account === null) {
    // 陈旧 cookie(账号已删)→ fail closed 回登录页。
    return new Response(null, { status: 302, headers: { location: "/login" } });
  }
  const entitlements = await deps.db.listEntitlements(account.id);
  return htmlPage(
    consolePage({ account, entitlements, now: deps.now() }),
    { noStore: true }, // 用户专属页面,不可缓存(Copilot round 3)
  );
}

/** 内测手工授予时长(admin)。P7 的 Paddle webhook 会复用同一 upsert+叠加逻辑。 */
async function adminGrant(request: Request, deps: RouteDeps): Promise<Response> {
  requireAdmin(request, deps.adminToken);
  const body = await readJsonBody(request);
  const emailRaw = body.email;
  if (typeof emailRaw !== "string") throw new HttpError(400, "email required");
  const email = emailRaw.trim().toLowerCase();
  if (email.length > EMAIL_MAX_LENGTH || !EMAIL_RE.test(email)) {
    throw new HttpError(400, "invalid email");
  }
  const months = body.months;
  if (typeof months !== "number" || !Number.isInteger(months) || months < 1 || months > 120) {
    throw new HttpError(400, "months must be an integer in [1,120]");
  }
  const source = body.source === "founding" || body.source === "manual" || body.source === "beta"
    ? body.source
    : "manual";

  // account upsert
  const account = await upsertAccount(email, deps);
  // 从当前最新到期时刻叠加
  const ents = await deps.db.listEntitlements(account.id);
  let current: string | null = null;
  for (const e of ents) {
    if (current === null || Date.parse(e.expires_at) > Date.parse(current)) current = e.expires_at;
  }
  const expiresAt = computeExpiry({ currentExpiry: current, months, now: deps.now() });
  await deps.db.insertEntitlement({
    id: deps.newEntitlementId(),
    account_id: account.id,
    expires_at: expiresAt,
    source,
    paddle_transaction_id: null,
    months,
    created_at: deps.now(),
  });
  return json({ ok: true, account_id: account.id, expires_at: expiresAt });
}

async function createInvite(request: Request, url: URL, deps: RouteDeps): Promise<Response> {
  const body = await readJsonBody(request);
  const emailRaw = body.email;
  if (typeof emailRaw !== "string") {
    throw new HttpError(400, "email required");
  }
  const email = emailRaw.trim().toLowerCase();
  if (email.length > EMAIL_MAX_LENGTH || !EMAIL_RE.test(email)) {
    throw new HttpError(400, "invalid email");
  }
  // 与 /waitlist 同一条防滥用规则:Turnstile 成对配置时,发信入口也要过人机
  // 校验——否则这是个公开的「触发发邮件」放大面(骚扰 + 成本 + 投递信誉)。
  // 校验在邮箱形状之后:一次性 token 不浪费在注定 400 的请求上。
  await requireTurnstileIfEnabled(request, body, deps);
  // Validate/normalize the slug at creation time so a bad slug fails fast
  // (400 here) instead of later at provision.
  const slugRaw = optString(body.slug);
  let slug: string | null = null;
  if (slugRaw !== null) {
    try {
      slug = assertSlug(slugRaw);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : "invalid slug");
    }
  }
  const invite = await deps.db.insertInvite({
    id: deps.newInviteId(),
    code: deps.newInviteCode(),
    invitee_label: optString(body.invitee_label),
    email,
    slug,
    status: "pending",
    created_at: deps.now(),
    provisioned_at: null,
    revoked_at: null,
  });
  await deps.db.insertAudit({
    id: deps.newAuditId(),
    at: deps.now(),
    actor: "admin",
    action: "invite.create",
    invite_id: invite.id,
    endpoint_id: null,
    detail_json: JSON.stringify({ email }),
  });
  return json(
    { id: invite.id, code: invite.code, inviteUrl: `${url.origin}/i/${invite.code}` },
    201,
  );
}

async function provisionInvite(
  request: Request,
  url: URL,
  deps: RouteDeps,
  inviteId: string,
): Promise<Response> {
  const invite = await deps.db.getInviteById(inviteId);
  if (invite === null) {
    throw new HttpError(404, "invite not found");
  }
  const body = await readJsonBody(request);
  const slugRaw = optString(body.slug) ?? invite.slug;
  if (slugRaw === null) {
    throw new HttpError(400, "slug required");
  }
  let slug: string;
  try {
    slug = assertSlug(slugRaw);
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : "invalid slug");
  }
  if (invite.status !== "pending") {
    throw new HttpError(409, "invite not pending");
  }
  let result;
  try {
    result = await provisionEndpoint({
      inviteId: invite.id,
      slug,
      deps: {
        cf: deps.cf,
        db: deps.db,
        rootDomain: deps.rootDomain,
        tokenWrapKeyHex: deps.tokenWrapKeyHex,
        now: deps.now,
        newEndpointId: deps.newEndpointId,
        newAuditId: deps.newAuditId,
      },
    });
  } catch (e) {
    // Domain conflicts (TOCTOU races past the pre-checks above) are client
    // errors, not 500s. Everything else (CF/D1 failures) stays a 500.
    // The actual race loser dies on the UNIQUE constraint — "UNIQUE
    // constraint failed: endpoints.slug" (same wording in D1 and the memory
    // mock) — which contains neither pre-check message, so map it explicitly.
    const msg = e instanceof Error ? e.message : "";
    if (msg.includes("invite not pending") || msg.includes("already in use")) {
      throw new HttpError(409, msg);
    }
    // The actual race loser dies on the UNIQUE constraint — same wording in D1
    // and the memory mock. Translate to user-facing text: echoing the raw
    // "UNIQUE constraint failed: endpoints.<column>" string would leak internal
    // schema details to the client (this file's contract is to never leak
    // internal error text) and make the response brittle across runtimes.
    // Messages match the pre-check path's format ("…: <value>") so callers see
    // the same text whether the conflict was caught by the pre-check or the race.
    if (msg.includes("UNIQUE constraint failed: endpoints.slug")) {
      throw new HttpError(409, `slug already in use: ${slug}`);
    }
    if (msg.includes("UNIQUE constraint failed: endpoints.hostname")) {
      throw new HttpError(409, `hostname already in use: ${slug}.${deps.rootDomain}`);
    }
    if (msg.includes("UNIQUE constraint failed: endpoints.invite_id")) {
      throw new HttpError(409, "invite already provisioned");
    }
    throw e;
  }
  return json(
    {
      hostname: result.hostname,
      token: result.token,
      agentPrompt: result.agentPrompt,
      inviteUrl: `${url.origin}/i/${result.inviteCode}`,
    },
    200,
    { noStore: true },
  );
}

// Read-only mirror of revealByCode's state machine: a GET page render must
// never burn the one-time ciphertext, so revealByCode is deliberately NOT
// reused here — the state is queried directly from the db.
async function inviteState(deps: RouteDeps, code: string): Promise<InvitePageState> {
  const invite = await deps.db.getInviteByCode(code);
  if (invite === null || invite.status === "revoked") {
    return { kind: "not_found" };
  }
  if (invite.status === "pending") {
    return { kind: "waiting" };
  }
  const endpoint = await deps.db.getEndpointByInviteId(invite.id);
  if (endpoint === null) {
    // provisioning half-done (invite flipped, endpoint row missing)
    return { kind: "waiting" };
  }
  // Match revealByCode: a non-active endpoint is an invalid link — never show
  // a hostname or ready/revealed state for a revoked/revoke_failed endpoint.
  if (endpoint.status !== "active") {
    return { kind: "not_found" };
  }
  if (endpoint.token_shown_at !== null || endpoint.token_ciphertext === null) {
    return { kind: "revealed", hostname: endpoint.hostname };
  }
  return { kind: "ready", code };
}

async function revealInvite(deps: RouteDeps, code: string): Promise<Response> {
  const outcome = await revealByCode({
    code,
    deps: {
      db: deps.db,
      tokenWrapKeyHex: deps.tokenWrapKeyHex,
      now: deps.now,
      newAuditId: deps.newAuditId,
    },
  });
  switch (outcome.kind) {
    case "not_found":
      throw new HttpError(404, "not found");
    case "not_ready":
      return json({ error: "not ready" }, 409);
    case "already_shown":
      return json({ hostname: outcome.hostname, alreadyShown: true });
    case "revealed":
      return json(
        {
          hostname: outcome.hostname,
          token: outcome.token,
          agentPrompt: outcome.agentPrompt,
        },
        200,
        { noStore: true },
      );
  }
}

const WAITLIST_BATCH = 1; // Fixed batch for 阶段 1.

/**
 * Founding-batch seat cap. 阶段 1 admits at most 100 signups; new emails past
 * the cap get 409. A module constant (like WAITLIST_BATCH), not an env var:
 * the cap is a product decision tied to the fixed batch, and making it
 * deploy-configurable would invite changing it without a code review.
 */
const WAITLIST_SEAT_CAP = 100;

/** The status literal for a queued signup. Must match schema.sql's DEFAULT. */
const WAITLIST_PENDING = "pending";

/**
 * True when an insert failed because the (email, batch) UNIQUE index rejected
 * it, as opposed to any other D1 failure. Deliberately narrow: a broad
 * catch-all here would convert real outages into cheerful 200s.
 */
function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
}

/**
 * POST /waitlist — public, unauthenticated signup.
 *
 * Request: `{ email: string, turnstile_token?: string }`
 * (email ≤ EMAIL_MAX_LENGTH bytes; trimmed+lowercased. turnstile_token is
 * REQUIRED when the Turnstile gate is configured — see turnstileGateEnabled —
 * and ignored entirely when it is not.)
 *
 * Responses — `position` is present on EVERY success path, new or repeat:
 *   201 `{ id: string, position: number }`
 *   200 `{ already_exists: true, id: string, position: number }`
 *   400 `{ error: "email required" | "invalid email" | "turnstile required" }`
 *       ("turnstile required" only when the gate is on and the token is
 *        missing/blank/non-string; plus "invalid json" / "invalid body"
 *        from the shared body reader)
 *   403 `{ error: "turnstile failed" }` — gate on and siteverify did not
 *       return success (fail CLOSED: network/timeout/non-2xx count as failure)
 *   409 `{ error: "本批内测席位已满" }` — founding batch at WAITLIST_SEAT_CAP;
 *       NEW emails only, repeats still get their 200 below
 *   413 `{ error: "body too large" }`
 *
 * The 200 body is a strict superset of `{ already_exists, id }`. Any doc that
 * omits `position` there is stale — see the comment on the branch itself for
 * why it is deliberate. `position` is 1-based within the batch.
 */
/**
 * sitekey 只在两半齐备时下发页面（sitekey 无 secret → 铸出验不了的 token；
 * secret 无 sitekey → 没有 widget 可铸）。与 /waitlist 的门同一条规则。
 */
function turnstileSitekeyIfConfigured(deps: RouteDeps): string | undefined {
  // 与页面同一个归一化（trim + 字符集校验）：畸形 sitekey 会让页面不渲染
  // widget，此时门也必须关——否则用户没有任何途径拿到 token，报名全 400。
  const key = normalizeTurnstileSitekey(deps.turnstileSitekey);
  return key && turnstileSecretIfConfigured(deps) ? key : undefined;
}

/** 归一化后的 secret：`wrangler secret put` 从文件/echo 灌进来常带尾换行，
 *  原样用会让门「开着但永远验不过」（报名 100% 静默死）。纯空白 = 未配置。 */
function turnstileSecretIfConfigured(deps: RouteDeps): string | undefined {
  const secret = deps.turnstileSecret?.trim();
  return secret ? secret : undefined;
}

/** Turnstile 门是否启用——与 turnstileSitekeyIfConfigured 同一条「成对」规则。 */
function turnstileGateEnabled(deps: RouteDeps): boolean {
  return turnstileSitekeyIfConfigured(deps) !== undefined;
}

/**
 * Cloudflare Turnstile 服务端校验（siteverify）。project 硬规则：外部 HTTP
 * 一律带超时。失败一律 fail CLOSED（这是公开报名漏斗，宁误杀不放过）——
 * 但日志里绝不带 secret 与用户 token。
 */
/** 若 Turnstile 成对配置则强制校验;否则放行。发信入口(/api/auth/magic)与
 *  报名入口(/waitlist)共用,消除两处逻辑漂移。约定:调用方须先做完邮箱形状
 *  校验,不把一次性 token 浪费在注定失败的请求上。 */
async function requireTurnstileIfEnabled(
  request: Request,
  body: Record<string, unknown>,
  deps: RouteDeps,
): Promise<void> {
  if (!turnstileGateEnabled(deps)) return;
  const rawToken = body.turnstile_token;
  const token = typeof rawToken === "string" ? rawToken.trim() : "";
  if (token === "") throw new HttpError(400, "turnstile required");
  const remoteIp = request.headers.get("cf-connecting-ip")?.trim() || null;
  const secret = turnstileSecretIfConfigured(deps);
  if (!secret) throw new HttpError(500, "internal");
  const ok = await verifyTurnstile(secret, token, remoteIp);
  if (!ok) throw new HttpError(403, "turnstile failed");
}

async function verifyTurnstile(secret: string, token: string, remoteIp: string | null): Promise<boolean> {
  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", token);
  if (remoteIp) form.set("remoteip", remoteIp);
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(5_000),
    });
    // 基础设施异常必须与「正常拦截」在日志里可区分：两者对用户都是 403，
    // 若日志也一样，CF 挂掉/secret 配错会让报名漏斗静默归零且无人知情。
    if (!res.ok) {
      console.error("turnstile siteverify HTTP error, status:", res.status);
      return false;
    }
    const data = (await res.json().catch(() => null)) as TurnstileVerifyResponse | null;
    if (data === null) {
      console.error("turnstile siteverify returned a non-JSON body, status:", res.status);
      return false;
    }
    if (data.success === true) return true;
    const actionable = turnstileActionableCodes(data);
    if (actionable.length > 0) {
      // error-codes 是 CF 的固定枚举，既不含 secret 也不含用户 token。
      console.error("turnstile siteverify config/infra error:", actionable.join(","));
    }
    return false;
  } catch (e) {
    console.error("turnstile siteverify failed:", errorName(e));
    return false;
  }
}

type TurnstileVerifyResponse = { success?: boolean; "error-codes"?: unknown };

/** 需要运维介入的 siteverify error-codes（其余属于正常拦截，不该刷日志）。
 *  见 developers.cloudflare.com/turnstile/get-started/server-side-validation。
 *  刻意排除 missing/invalid-input-response 与 timeout-or-duplicate——过期、
 *  重放、机器人是这条公开漏斗的日常，报警值为零。 */
const TURNSTILE_ACTIONABLE_CODES = new Set([
  "missing-input-secret",
  "invalid-input-secret",
  "invalid-widget-id",
  "invalid-parsed-secret",
  "bad-request",
  "internal-error",
]);

function turnstileActionableCodes(data: TurnstileVerifyResponse): string[] {
  const raw = data["error-codes"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is string => typeof c === "string" && TURNSTILE_ACTIONABLE_CODES.has(c));
}

/** 某些运行时的 DOMException 不是 `instanceof Error`（AbortSignal.timeout 抛的
 *  就是它）——只按 instanceof 取名字会把 TimeoutError 记成 "unknown error"。 */
function errorName(e: unknown): string {
  if (typeof e === "object" && e !== null && "name" in e) {
    const n = (e as { name?: unknown }).name;
    if (typeof n === "string" && n.length > 0) return n;
  }
  return "unknown error";
}

async function addToWaitlist(request: Request, deps: RouteDeps): Promise<Response> {
  const body = await readJsonBody(request);
  const emailRaw = body.email;
  if (typeof emailRaw !== "string") {
    throw new HttpError(400, "email required");
  }
  // Normalize FIRST, then bound, then run the regex.
  //
  // The cap measures the value we actually validate and store, not the raw
  // submission: a 254-char address pasted with surrounding whitespace is a
  // legitimate address, and capping `emailRaw` rejected it on a length its
  // normalized form does not have.
  //
  // Trimming first is NOT a DoS hole, so do not "restore" a pre-trim check as
  // hardening. The raw string is already bounded far earlier and far more
  // cheaply by MAX_JSON_BODY_BYTES (8 KB, enforced as a streaming byte cap in
  // readBodyTextCapped before this function is ever entered), so `trim()` here
  // can only ever see ≤8 KB. The 200KB-address case is a 413 at the body cap.
  // The cap below still bounds what reaches EMAIL_RE and the database.
  const email = emailRaw.trim().toLowerCase();
  if (email.length > EMAIL_MAX_LENGTH || !EMAIL_RE.test(email)) {
    throw new HttpError(400, "invalid email");
  }

  // Turnstile 门(成对配置时启用)。位置刻意在邮箱形状校验之后:一次性
  // token 不浪费在注定 400 的请求上。与 /api/auth/magic 共用同一 helper。
  await requireTurnstileIfEnabled(request, body, deps);

  const batch = WAITLIST_BATCH;

  // Fast path for the common repeat submit. This is only an optimisation — the
  // INSERT below is authoritative, because a SELECT-then-INSERT pair is not
  // atomic and a double-clicked Submit used to 500.
  const existing = await deps.db.getWaitlistByEmail(email, batch);
  if (existing !== null) {
    // `position` is returned on the already-exists path INTENTIONALLY, and the
    // extra indexed read it costs is intentional too. The settings-page
    // waitlist form shows the user their rank, and a repeat submit (double
    // click, revisit, refresh) is exactly when they want to see it again.
    // Returning it on both the 201 and 200 paths keeps one response contract
    // instead of forcing the client to branch. Do not "optimise" it away.
    return json(
      { already_exists: true, id: existing.id, position: await waitlistPosition(deps, existing) },
      200,
    );
  }

  // Founding-batch seat cap — checked AFTER the repeat-submit fast path, so
  // an email already on the list keeps its 200 position lookup even when the
  // batch is full; only NEW emails are turned away.
  //
  // Like the email pre-check above, this count-then-insert pair is not
  // atomic: concurrent signups at cap-1 can all pass and overshoot the cap by
  // a little. Tolerable for a soft product cap (the founding batch is
  // hand-invited from the admin console anyway); the one hard invariant —
  // one row per (email, batch) — stays with the UNIQUE index below.
  if ((await deps.db.countWaitlist(batch)) >= WAITLIST_SEAT_CAP) {
    throw new HttpError(409, "本批内测席位已满");
  }

  const row = {
    id: newId("wl"),
    email,
    batch,
    status: WAITLIST_PENDING,
    created_at: deps.now(),
    survey_json: null,
  };
  try {
    await deps.db.insertWaitlist(row);
  } catch (e) {
    if (!isUniqueViolation(e)) {
      throw e;
    }
    // Lost the race: someone inserted this exact (email, batch) between our
    // pre-check and here. That is a successful signup, not an error — return
    // the same shape as the already-exists branch above.
    const winner = await deps.db.getWaitlistByEmail(email, batch);
    if (winner === null) {
      throw e; // UNIQUE fired but the row is not readable — genuinely broken.
    }
    // Same contract as the pre-check branch above, `position` included.
    return json(
      { already_exists: true, id: winner.id, position: await waitlistPosition(deps, winner) },
      200,
    );
  }

  return json({ id: row.id, position: await waitlistPosition(deps, row) }, 201);
}

/**
 * Position of `row` in its batch, via an indexed count rather than by pulling
 * every row and scanning in JS. The old implementation made TWO full table
 * scans per request — O(n) per call and O(n^2) cumulatively on an
 * unauthenticated endpoint that shares its D1 instance with `endpoints`, so
 * filling the waitlist degraded provisioning and revocation.
 *
 * Ranks on the composite (created_at, id). created_at alone is not a total
 * order — it is a whole-second ISO string, so every signup in the same second
 * used to collapse to one shared position (measured: three same-second rows
 * all reported position 3). `id` is the PRIMARY KEY, which makes the order
 * total and every position distinct.
 *
 * Caveat worth knowing: ids are random (see newId), not monotonic, so within a
 * single second the tiebreak is arbitrary-but-stable rather than true arrival
 * order. Distinctness and stability are what the UI needs; exact sub-second
 * arrival ordering would require a monotonic key we do not currently store.
 */
async function waitlistPosition(
  deps: RouteDeps,
  row: { batch: number; created_at: string; id: string },
): Promise<number> {
  return deps.db.waitlistRankOf(row.batch, row.created_at, row.id);
}

/** Server-side twin of the /beta textarea's maxlength="500". */
const SURVEY_FEEDBACK_MAX = 500;

/**
 * POST /waitlist/survey — the optional post-signup survey from the beta page
 * (served at GET /beta, and at GET / on the beta subdomain).
 * Public and unauthenticated like POST /waitlist; the same 8 KB capped body
 * reader applies.
 *
 * Request: `{ id: string, willing_to_pay?: string, price_point?: string,
 *            use_cases?: string[], donate?: boolean, feedback?: string }`
 *
 * Responses:
 *   204 — stored (or nothing to store); no body
 *   400 `{ error: "id required" }` (plus "invalid json" / "invalid body"
 *        from the shared body reader)
 *   404 `{ error: "waitlist entry not found" }`
 *   413 `{ error: "body too large" }`
 *   503 `{ error: "survey temporarily unavailable" }` — only in the migration
 *        window (survey_json column missing); any other db error stays a
 *        generic 500 and must never be masked as a 503
 *
 * Only keys actually answered are persisted, under their contract names —
 * unknown body keys are dropped, wrong-typed values are dropped, and
 * `feedback` is capped at SURVEY_FEEDBACK_MAX chars. A submit with zero
 * answered fields is a 204 WITHOUT touching survey_json, so a skipped/empty
 * re-submit can never clobber answers already stored.
 */
async function saveWaitlistSurvey(request: Request, deps: RouteDeps): Promise<Response> {
  const body = await readJsonBody(request);
  const id = optString(body.id);
  if (id === null) {
    throw new HttpError(400, "id required");
  }
  if ((await deps.db.getWaitlistById(id)) === null) {
    throw new HttpError(404, "waitlist entry not found");
  }

  const survey: Record<string, unknown> = {};
  const willingToPay = optString(body.willing_to_pay);
  if (willingToPay !== null) {
    survey.willing_to_pay = willingToPay;
  }
  const pricePoint = optString(body.price_point);
  if (pricePoint !== null) {
    survey.price_point = pricePoint;
  }
  if (Array.isArray(body.use_cases)) {
    const useCases = body.use_cases.filter((u): u is string => typeof u === "string");
    if (useCases.length > 0) {
      survey.use_cases = useCases;
    }
  }
  if (typeof body.donate === "boolean") {
    survey.donate = body.donate;
  }
  const feedback = optString(body.feedback);
  if (feedback !== null) {
    survey.feedback = feedback.slice(0, SURVEY_FEEDBACK_MAX);
  }

  if (Object.keys(survey).length > 0) {
    try {
      await deps.db.updateWaitlistSurvey(id, JSON.stringify(survey));
    } catch (e) {
      // Migration window: 0002 not yet applied → the column doesn't exist and
      // the raw D1 error would surface as an unobservable 500 outside this
      // route's declared contract. Answer in-contract instead: 503 tells the
      // client "not you, us, try later" (the signup itself already succeeded).
      const msg = e instanceof Error ? e.message : "";
      const isMissingColumn =
        msg.includes("survey_json") &&
        (msg.includes("no such column") || msg.includes("no column named"));
      if (!isMissingColumn) throw e;
      throw new HttpError(503, "survey temporarily unavailable");
    }
  }
  return new Response(null, { status: 204 });
}

async function reportInstanceStatus(request: Request, deps: RouteDeps): Promise<Response> {
  // Extract Bearer token from Authorization header
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    throw new HttpError(401, "unauthorized");
  }
  const token = authHeader.slice("bearer ".length).trim();
  if (token === "") {
    throw new HttpError(401, "unauthorized");
  }

  // Hash the token and look up the endpoint
  const tokenHash = await sha256Hex(token);
  const endpoint = await deps.db.getEndpointByTokenSha256(tokenHash);

  // Endpoint must exist and be active
  if (endpoint === null || endpoint.status !== "active") {
    throw new HttpError(401, "unauthorized");
  }

  // Update last_seen_at
  await deps.db.updateEndpointLastSeen(endpoint.id, deps.now());

  // Return 204 No Content
  return new Response(null, { status: 204 });
}
