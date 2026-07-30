import type { CfApi } from "./cf-api.js";
import type { AccountRow, ConnectDb } from "./db.js";
import { HttpError, handleError, htmlPage, json } from "./http.js";
import { requireAdmin } from "./auth.js";
import { provisionEndpoint } from "./provision.js";
import { revokeEndpoint } from "./revoke.js";
import { revealByCode } from "./reveal.js";
import { assertSlug } from "./slug.js";
import { checkSlug, type IsTaken } from "./slug-availability.js";
import { homePage } from "./html/home-page.js";
import { adminPage } from "./html/admin-page.js";
import { invitePage, type InvitePageState } from "./html/invite-page.js";
import { betaPage, normalizeTurnstileSitekey } from "./html/beta-page.js";
import { CAPACITY_LIMIT, isAtCapacityError } from "./capacity.js";
import { grantEntitlement } from "./grant.js";
import { isPriceMapConfigured, parseTransactionCompleted, type PriceMonthsMap } from "./paddle-event.js";
import { isKnownPriceId, type PaddleApi } from "./paddle-api.js";
import { verifyPaddleSignature } from "./paddle-signature.js";
import { buyPage } from "./html/buy-page.js";
import { compliancePage, COMPLIANCE_PAGES, type CompliancePageKey } from "./html/compliance-page.js";
import { RAW_ASSETS } from "./html/assets.gen.js";
import { consolePage } from "./html/console-page.js";
import { loginPage } from "./html/login-page.js";
import { EMAIL_MAX_LENGTH, EMAIL_RE } from "./validation.js";
import { newId } from "./ids.js";
import { sha256Hex } from "./crypto-token.js";
import { signToken, verifyToken } from "./signed-token.js";
import { buildSessionCookie, parseSessionCookie } from "./session.js";
import { computeExpiry, isEntitlementActive, latestExpiry } from "./entitlement.js";

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
  // Paddle 结账所需的公开 client token 与环境。两者都缺 → /buy 显示
  // 「结账未开放」(见 buyPage),绝不白页。
  paddleClientToken?: string | undefined;
  paddleEnvironment?: string | undefined;
  /** notification destination 的 endpoint secret(pdl_ntfset_ 前缀)。
   *  **未配置时 webhook 一律 503**(fail closed):没有密钥就无法验签,
   *  而无法验签的 webhook 绝不能当真 —— 那等于任何人都能凭空发时长。 */
  paddleWebhookSecret?: string | undefined;
  /** price_id → 月数白名单。默认 sandbox;live 上线时换成 live 的 id。 */
  paddlePriceMonths?: PriceMonthsMap | undefined;
  /** Paddle 服务端 API(创建交易)。未配置时 /api/checkout 返回 503。 */
  paddleApi?: PaddleApi | undefined;
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
 * Paddle webhook 的 body 上限,比普通 API 请求宽。
 *
 * 真实 transaction.completed payload 粗估约 2KB,但含 receipt_data、payments
 * 数组、多 line_items 时会明显更大。**上限设太紧会拒掉真实付款通知 —— 那是
 * 直接丢钱**,所以留足余量。仍然要有上限:webhook 端点公开可打,裸
 * request.text() 会把 500MB body 全缓存进内存(readBodyTextCapped 的注释里
 * 写的正是这个放大漏洞)。
 */
export const MAX_WEBHOOK_BODY_BYTES = 128 * 1024;
/** occurred_at 与当下的最大容许偏差。超出则回落 deps.now()。
 *  7 天足够覆盖 Paddle 最长的重试退避,又不至于让一个离谱的 occurred_at
 *  把到期时刻推到很远。 */
export const OCCURRED_AT_MAX_SKEW_MS = 7 * 24 * 60 * 60_000;

/**
 * Cheap pre-read rejection on the DECLARED size. Costs nothing and refuses the
 * request before a single byte is buffered — but it is only half the defence,
 * because Content-Length is absent under chunked encoding and is attacker-
 * controlled besides. readBodyTextCapped() enforces the real limit.
 */
function assertDeclaredSizeWithinCap(
  request: Request,
  cap: number = MAX_JSON_BODY_BYTES,
): void {
  const declared = request.headers.get("content-length");
  if (declared === null) {
    return;
  }
  const bytes = Number(declared);
  if (Number.isFinite(bytes) && bytes > cap) {
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
async function readBodyTextCapped(
  request: Request,
  cap: number = MAX_JSON_BODY_BYTES,
): Promise<string> {
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
      if (total > cap) {
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
  if (method === "POST" && path === "/api/paddle/webhook") {
    return paddleWebhook(request, deps);
  }
  if (method === "POST" && path === "/api/checkout") {
    return createCheckout(request, deps);
  }
  // /buy —— Paddle 的 default payment link 落地页(拼 ?_ptxn= 打开结账窗)。
  if (method === "GET" && path === "/buy") {
    return htmlPage(
      buyPage({
        paddleClientToken: deps.paddleClientToken,
        paddleEnvironment: deps.paddleEnvironment,
      }),
      // 唯一放行 Paddle 第三方来源的页面(见 http.ts 的 PADDLE_CSP_SOURCES)。
      // noStore:URL 带交易 ID(?_ptxn=),不该被浏览器/中间缓存落盘或复用;
      // 也避免「未配置 token → 已配置」后旧的「结账未开放」页面被缓存住。
      { paddle: true, noStore: true },
    );
  }
  // 合规五页（条款/隐私/退款/定价/联系）——Paddle 域名审核硬性要求。
  // 两个 host 都放行：审核看的是 mediaryconnect.app，但 beta 页脚也要能链到。
  if (method === "GET" && path.length > 1) {
    const key = path.slice(1);
    // Object.hasOwn 而非 `in`：后者沿原型链找到 toString/valueOf，
    // 随后 compliancePage() 因内容缺失抛错变 500（round 1 评审抓到）。
    if (Object.hasOwn(COMPLIANCE_PAGES, key)) {
      // 中文默认(受众是中文用户);?lang=en 给英文页。任何其它值(含空串、
      // 大小写变体、垃圾值)都回落中文而非报错——法律页面必须永远打得开,
      // 一个拼错的 query 不该变成 4xx。
      const lang = url.searchParams.get("lang")?.trim().toLowerCase() === "en" ? "en" : "zh";
      return htmlPage(compliancePage(key as CompliancePageKey, lang));
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
  if (method === "GET" && path === "/api/slug/check") {
    return await slugCheckRoute(url, request, deps);
  }
  if (method === "POST" && path === "/api/claim-code") {
    return await issueClaimCode(request, deps);
  }
  if (method === "POST" && path === "/api/provision") {
    return await selfServeProvision(request, deps);
  }
  if (method === "POST" && path === "/api/claim/exchange") {
    return await exchangeClaimCode(request, deps);
  }
  if (method === "GET" && path === "/connect.sh") {
    const script = RAW_ASSETS["connect.sh"];
    if (script !== undefined) {
      // 让下载到的脚本自洽于它的来源主机:把内置的生产默认 WORKER_BASE
      // 改写成当前请求的 origin。否则在 staging/preview(不同 rootDomain)下
      // 用户从该主机 curl 脚本,脚本却仍打生产 API——staging 签的取件码拿到
      // 生产去 exchange 必然失败(secret 不同)。用户仍可用 MEDIARY_CONNECT_BASE
      // 覆盖(:- 默认写法保留)。只替换首个默认值,精确匹配那一行的字面量。
      const served = script.replace(
        'WORKER_BASE="${MEDIARY_CONNECT_BASE:-https://mediaryconnect.app}"',
        `WORKER_BASE="\${MEDIARY_CONNECT_BASE:-${url.origin}}"`,
      );
      return new Response(served, {
        headers: {
          "content-type": "text/x-shellscript; charset=utf-8",
          "cache-control": "public, max-age=300",
        },
      });
    }
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
// 取件码有效期:15 分钟。够 agent 走完「SSH 到部署机 → 跑 connect.sh」,
// 又短到即便泄露也很快作废(决策 #12:能取 token 的凭据必须短命)。
const CLAIM_TTL_MS = 15 * 60_000;

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

/** 自助开通(0004,spec 2026-07-28):登录 + 有效时长的账号选 slug 给自己开
 *  endpoint。门禁次序 session → slug 形状校验 → entitlement(后两步在
 *  provisionEndpoint 内)→ slug 查重;402/409 级失败绝不烧 CF API 调用
 *  (门禁都在 CF 编排之前)。响应绝不含 token:接入唯一路径是控制台取件码
 *  (决策 #10/#12)。 */
/** 解析 session cookie,若 deps.now() 畸形则 fail-closed 而不是伪装成"未登录"。
 *  早先多处裸写 `Date.parse(deps.now())`:now 坏值 → NaN → session 总被判无效 →
 *  401 误导排障,以为用户没登录而真正的问题是服务器时钟。
 *  现在一处守卫,四处复用,与别处「non-finite now 视为过期」的守卫契约一致。 */
async function parseSessionWithValidatedNow(
  cookie: string | null,
  deps: Pick<RouteDeps, "sessionSecret" | "now">,
): Promise<{ ok: false } | { ok: true; accountId: string }> {
  const nowMs = Date.parse(deps.now());
  if (!Number.isFinite(nowMs)) throw new HttpError(500, "server time unavailable");
  return parseSessionCookie(cookie, { secret: deps.sessionSecret, now: nowMs });
}

async function selfServeProvision(request: Request, deps: RouteDeps): Promise<Response> {
  const session = await parseSessionWithValidatedNow(request.headers.get("cookie"), deps);
  if (!session.ok) throw new HttpError(401, "unauthorized");
  const body = await readJsonBody(request);
  const slugRaw = optString(body.slug);
  if (slugRaw === null) throw new HttpError(400, "slug required");
  let slug: string;
  try {
    slug = assertSlug(slugRaw);
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : "invalid slug");
  }
  try {
    const result = await provisionEndpoint({
      origin: { kind: "account", accountId: session.accountId },
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
    // 只回 hostname——token/agentPrompt 在 account 分支本就是 null,这里再
    // 显式收窄一层,响应形状永远不含敏感字段。
    return json({ hostname: result.hostname }, 200, { noStore: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    // 无有效时长:语义上最诚实的 402(前端据此引导去 /pricing 续期/开通)。
    if (msg.includes("no active entitlement")) {
      throw new HttpError(402, "no active entitlement");
    }
    // 陈旧 session(账号已删)fail closed。
    if (msg.includes("account not found")) {
      throw new HttpError(401, "unauthorized");
    }
    // 一账号一 live endpoint:预检消息 + 部分唯一索引的 UNIQUE 兜底,两条路
    // 归并为同一个 409 语义,body error 供前端区分于 slug 冲突。
    if (
      msg.includes("already provisioned") ||
      msg.includes("UNIQUE constraint failed: endpoints.account_id")
    ) {
      throw new HttpError(409, "already provisioned");
    }
    // slug/hostname 冲突:预检消息与 UNIQUE 兜底同样归并(与 provisionInvite
    // 的映射一致——绝不回显裸 UNIQUE 文本泄 schema)。
    if (
      msg.includes("already in use") ||
      msg.includes("UNIQUE constraint failed: endpoints.slug") ||
      msg.includes("UNIQUE constraint failed: endpoints.hostname")
    ) {
      throw new HttpError(409, "slug taken");
    }
    // 容量已满 → 503(共享 helper,见 capacity.ts:两条 provision 路由必须
    // 用同一个判定,否则漏掉的那条会把容量满变成 500)。
    if (isAtCapacityError(e)) {
      throw new HttpError(503, "at capacity");
    }
    throw e;
  }
}

/**
 * `POST /api/checkout` —— 登录用户发起购买。
 *
 * 由**我方**创建 Paddle 交易(而非让 Paddle 自己生成),因为只有这样才能写入
 * `custom_data.account_email` —— webhook 唯一可靠的「这笔钱属于谁」的载体。
 * 实测确认 transaction.completed 的 payload 里没有嵌套 customer 对象,
 * 只有 customer_id;而 custom_data 会原样透传。
 *
 * 返回结账 URL,前端跳过去即可(Paddle 会拼上 ?_ptxn=)。
 */
async function createCheckout(request: Request, deps: RouteDeps): Promise<Response> {
  const session = await parseSessionWithValidatedNow(request.headers.get("cookie"), deps);
  if (!session.ok) throw new HttpError(401, "unauthorized");
  const account = await deps.db.getAccountById(session.accountId);
  if (account === null) throw new HttpError(401, "unauthorized");

  const api = deps.paddleApi;
  if (api === undefined) {
    // 未配置 Paddle API key:结账尚未开放。503 而非 500 —— 这是配置缺失,
    // 不是代码故障,且配好之后同样的请求就能成功。
    return json({ error: "checkout not configured" }, 503, { noStore: true });
  }

  const body = await readJsonBody(request);
  const priceId = optString(body.price_id) ?? "";
  // **绝不能让客户端随便传 price_id**:那等于允许任何人拿一个更便宜的 price
  // 去结账。只放行白名单里的档位,与 webhook 共用同一份表。
  // 同 webhook:白名单未配置时不回落 sandbox。这里回落的后果是用户拿着 live
  // price_id 结账被判 400「未知档位」,而真正的问题是我方配置没同步。
  if (!isPriceMapConfigured(deps.paddlePriceMonths)) {
    // 空表时返回 503 而非 400:400 会让用户以为自己选错了档位,而真正的问题
    // 是我方白名单没同步。
    return json({ error: "checkout not configured" }, 503, { noStore: true });
  }
  if (!isKnownPriceId(priceId, deps.paddlePriceMonths)) {
    throw new HttpError(400, "unknown price");
  }

  try {
    const result = await api.createTransaction({
      priceId,
      // 用**登录账号**的邮箱,不是用户可填的输入:时长必须落在他登录的账号上
      // (他可能用公司卡/家人的卡付款)。
      accountEmail: account.email,
      checkoutUrl: `${new URL(request.url).origin}/buy`,
    });
    return json(
      { checkout_url: result.checkoutUrl, transaction_id: result.transactionId },
      200,
      { noStore: true },
    );
  } catch {
    // 不回显 Paddle 的响应内容。502:上游失败,可重试。
    return json({ error: "checkout unavailable" }, 502, { noStore: true });
  }
}

/**
 * `POST /api/paddle/webhook` —— Paddle 付款入账。
 *
 * 设计要点(每条都对应一种会真丢钱或真送钱的失败):
 *
 * 1. **fail closed**:未配置 secret → 503。绝不 200 —— 200 会让 Paddle 认为
 *    投递成功并停止重试,而我们压根没入账,用户付了钱拿不到时长。503 会让它重投。
 * 2. **验签用原始 body 文本**,不经 JSON.parse 再 stringify(那会改变字节)。
 * 3. **幂等靠 DB**(entitlements 的 paddle_transaction_id 偏唯一索引),不靠
 *    内存去重 —— worker 是无状态多实例的。
 * 4. **解析失败一律留审计并返回 200**:这类事件重投一万次结果也一样(未知
 *    price、月数不一致、拿不到邮箱),让 Paddle 无限重试只会淹掉日志。但
 *    `no_email` 意味着**有人付了钱而系统不知道给谁**,必须人工介入,所以审计
 *    里记全 transaction id。
 * 5. **入账失败(DB 故障)返回 503**:那是可重试的,必须让 Paddle 重投。
 */
async function paddleWebhook(request: Request, deps: RouteDeps): Promise<Response> {
  const secret = deps.paddleWebhookSecret?.trim() ?? "";
  if (secret === "") {
    // 没密钥就无法验签。返回 503 而非 200:让 Paddle 重投,等我们配好密钥后
    // 那些付款仍能入账。返回 200 会让它放弃重试 → 真丢钱。
    return json({ error: "webhook not configured" }, 503, { noStore: true });
  }

  // body 上限:webhook 端点公开可打,裸 request.text() 会把超大 body 全缓存进
  // 内存(readBodyTextCapped 的注释写的正是这个放大漏洞)。两道防线都用 webhook
  // 专用的宽上限 —— 设太紧会拒掉真实付款通知,那是直接丢钱。
  assertDeclaredSizeWithinCap(request, MAX_WEBHOOK_BODY_BYTES);
  // 必须拿**原始**文本:任何解析/重新序列化都会让签名失配。
  const rawBody = await readBodyTextCapped(request, MAX_WEBHOOK_BODY_BYTES);
  const header = request.headers.get("paddle-signature") ?? "";
  // now 只取一次并卡 finite:Date.parse 坏值会得 NaN,而
  // `Math.abs(NaN - x) > tolerance` 恒为 false —— 时间窗会被静默绕过。
  // verifyPaddleSignature 内部也有这道守卫(双层),这里提前失败以免白算 HMAC。
  const nowMs = Date.parse(deps.now());
  if (!Number.isFinite(nowMs)) {
    // 时钟坏了是我方故障且可重试 → 503 让 Paddle 重投。
    return json({ error: "clock unavailable" }, 503, { noStore: true });
  }
  const ok = await verifyPaddleSignature({ rawBody, header, secret, nowMs });
  if (!ok) {
    // 401 而非 400:这是身份问题。不回显原因(不给攻击者调试信息)。
    return json({ error: "invalid signature" }, 401, { noStore: true });
  }

  let event: { event_type?: unknown; event_id?: unknown; data?: unknown };
  try {
    const decoded: unknown = JSON.parse(rawBody);
    // **必须查 null 与非对象**:JSON.parse("null") 成功返回 null,随后
    // `event.event_type` 抛 TypeError → 500 → Paddle 无限重投一个永远处理不了
    // 的 body(实测复现)。"123"/'"s"'/[]/true 走这里也一并归到畸形分支。
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      throw new Error("payload is not a JSON object");
    }
    event = decoded as typeof event;
  } catch {
    // 验签通过却不是合法 JSON —— 理论上不该发生(说明上游异常或传输损坏)。
    // 200 避免无意义重投,但**必须留审计**:这是唯一的排障线索,否则只会看到
    // 「Paddle 说投递成功而我们没入账」却无从查起。
    // best-effort:审计写失败也不能让这个请求变 500(那会触发无意义重投)。
    try {
      await deps.db.insertAudit({
        id: deps.newAuditId(),
        at: deps.now(),
        actor: "paddle",
        action: "paddle.unprocessable.malformed_json",
        invite_id: null,
        endpoint_id: null,
        // 只留长度与开头片段:body 可能含敏感字段,且不该把整个畸形串塞进审计。
        // 用 TextEncoder 数真实字节:rawBody.length 是 UTF-16 code units,
        // 含非 ASCII 时会明显偏小,排障时按"bytes"读会被误导。
        detail_json: JSON.stringify({
          bytes: new TextEncoder().encode(rawBody).byteLength,
          head: rawBody.slice(0, 120),
        }),
      });
    } catch {
      // 审计不可用时静默继续:比让 Paddle 无限重投一个永远解析不了的 body 好。
    }
    return json({ ok: true, ignored: "malformed json" }, 200, { noStore: true });
  }
  const eventType = typeof event.event_type === "string" ? event.event_type : "";
  const eventId = typeof event.event_id === "string" ? event.event_id : "";

  // 退款/调整:释放资源。与到期路径一致 —— 退款是明确的「不要了」,若只删 DNS
  // 而留着隧道,就会出现「退了款还占着容量配额」(与售罄闸门直接冲突)。
  if (eventType === "adjustment.created") {
    // 审计必须能对应到**具体交易**:只记 event_id 的话,人工核查退款时无从
    // 关联到是哪一笔付款、退的是全额还是部分。adjustment 的 action 字段
    // (refund/chargeback/credit...)也决定后续处置是否相同。
    const adj =
      typeof event.data === "object" && event.data !== null
        ? (event.data as { id?: unknown; transaction_id?: unknown; action?: unknown; customer_id?: unknown })
        : {};
    const pick = (v: unknown): string | null => (typeof v === "string" ? v : null);
    try {
      await deps.db.insertAudit({
        id: deps.newAuditId(),
        at: deps.now(),
        actor: "paddle",
        action: "paddle.adjustment",
        invite_id: null,
        endpoint_id: null,
        detail_json: JSON.stringify({
          event_id: eventId,
          adjustment_id: pick(adj.id),
          transaction_id: pick(adj.transaction_id),
          adjustment_action: pick(adj.action),
          customer_id: pick(adj.customer_id),
        }),
      });
    } catch {
      // 与不可重试的解析失败不同:退款事件本身是**可处理**的,只是暂时写不进
      // 审计。503 让 Paddle 重投(而不是变成 unhandled 500) —— 退款审计是后续
      // 停用处置的唯一依据,丢了就查不到某人为什么被停。
      return json({ error: "temporarily unavailable" }, 503, { noStore: true });
    }
    // 实际停用在 PR-C3 的到期状态机里统一实现(它已有删 DNS + 删隧道的完整
    // 补偿逻辑)。这里先记审计:漏记等于查不到为什么某人被停用。
    return json({ ok: true, recorded: "adjustment" }, 200, { noStore: true });
  }

  if (eventType !== "transaction.completed") {
    // 我们只订了两种事件;其它一律礼貌 200(可能是后台改了订阅项)。
    return json({ ok: true, ignored: eventType }, 200, { noStore: true });
  }

  // **时间基准用事件的 occurred_at,而非投递到达时刻。**
  // Paddle 重试是指数退避,失败后可能几小时后才成功投递。若用 deps.now(),
  // 一笔"到期前 1 分钟成交"的续费在延迟投递后会被当成"已过期 → 从当下重启",
  // 用户白丢那段延迟的时长(实测:延迟 24h 就丢 24h)。
  // occurred_at 不可信时(缺失/畸形/偏离当下过远)回落 now:宁可少给一点,
  // 也不能让伪造的 occurred_at 把到期时刻推到很远的未来 —— 但注意 payload
  // 已通过 HMAC 验签,这里主要防的是上游 bug 而非攻击。
  const occurredRaw = typeof (event as { occurred_at?: unknown }).occurred_at === "string"
    ? (event as { occurred_at: string }).occurred_at
    : "";
  const occurredMs = occurredRaw === "" ? NaN : Date.parse(occurredRaw);
  const grantNow =
    Number.isFinite(occurredMs) && Math.abs(occurredMs - nowMs) <= OCCURRED_AT_MAX_SKEW_MS
      ? new Date(occurredMs).toISOString()
      : deps.now();

  // **白名单缺失必须 fail-closed(503),不能回落 sandbox。**
  // 回落的后果:live 上线后真实 price_id 被判 unknown_price → 返回 200
  // (不可重试)→ Paddle 停止重投 → 真实付款静默丢失。503 让它重投,等白名单
  // 配好后那些付款仍能入账 —— 把不可恢复的丢钱降级成可恢复的配置错误。
  // 空表也算未配置(见 isPriceMapConfigured):误注入 `{}` 会让每个真实 price_id
  // 走 unknown_price → 200(不可重试)→ 静默丢钱。
  if (!isPriceMapConfigured(deps.paddlePriceMonths)) {
    return json({ error: "price map not configured" }, 503, { noStore: true });
  }
  const parsed = parseTransactionCompleted(event.data, deps.paddlePriceMonths);
  if (!parsed.ok) {
    // 这类失败重投也不会变好(未知 price / 月数不一致 / 无邮箱),故 200。
    // 但必须留审计 —— 尤其 no_email:有人付了钱而系统不知道该给谁,要人工处理。
    // best-effort:审计写入若因 DB 故障抛错,会被 handleError 转成 500 → Paddle
    // 无限重投一个永远处理不了的事件并淹掉日志,与本分支"重投也不会变好"相悖。
    try {
      await deps.db.insertAudit({
        id: deps.newAuditId(),
        at: deps.now(),
        actor: "paddle",
        action: `paddle.unprocessable.${parsed.reason}`,
        invite_id: null,
        endpoint_id: null,
        detail_json: JSON.stringify({ event_id: eventId, detail: parsed.detail }),
      });
    } catch {
      // 同上:审计不可用不该把"不可重试的失败"变成无限重投。
    }
    return json({ ok: true, unprocessable: parsed.reason }, 200, { noStore: true });
  }

  // 入账与审计**分开 try**:早先共用一个 catch,导致审计失败也报 "grant failed"
  // 误导排障;更要紧的是入账已成功时若因审计失败返回 503,Paddle 会重投 ——
  // 虽然幂等能挡住重复入账,但语义是错的(明明成功了却说失败)。
  let granted;
  try {
    granted = await grantEntitlement(
      {
        email: parsed.grant.email,
        months: parsed.grant.months,
        source: parsed.grant.source,
        paddleTransactionId: parsed.grant.transactionId,
      },
      // 时间基准换成事件成交时刻(见上)。其余依赖不变。
      { ...deps, now: () => grantNow },
    );
  } catch {
    // 入账失败是**可重试**的:必须 503 让 Paddle 重投,否则这笔付款永久丢失。
    // 不回显内部错误文本。
    return json({ error: "grant failed" }, 503, { noStore: true });
  }

  // 到这里钱已经变成时长了。审计写不进去是遗憾但不该推翻既成事实 ——
  // best-effort,失败也返回 200(否则重投会让日志里出现一堆"重复"记录)。
  try {
    await deps.db.insertAudit({
      id: deps.newAuditId(),
      at: deps.now(),
      actor: "paddle",
      action: granted.applied ? "paddle.granted" : "paddle.replay",
      invite_id: null,
      endpoint_id: null,
      detail_json: JSON.stringify({
        event_id: eventId,
        txn: parsed.grant.transactionId,
        months: parsed.grant.months,
        expires_at: granted.expiresAt,
      }),
    });
  } catch {
    // 入账已成功,不因审计失败而让 Paddle 重投。
  }
  return json({ ok: true, applied: granted.applied, expires_at: granted.expiresAt }, 200, {
    noStore: true,
  });
}

/** 登录用户为自己的 active endpoint 签发一个短期取件码。code 是 claim purpose
 *  的 signed-token,subject=endpointId,15 分钟过期,窗口内可重复用(脚本重试/
 *  换机器)。D1 零写入——过期由签名自带。 */
async function issueClaimCode(request: Request, deps: RouteDeps): Promise<Response> {
  // now 只取一次:签名过期与返回的 expires_at 必须基于同一时刻,否则两次
  // deps.now() 之间若推进,签发的 token 过期时刻与告知用户的会漂移。
  const nowMs = Date.parse(deps.now());
  // fail-closed:now 畸形(misconfig/坏 stub)时 nowMs=NaN,后面
  // new Date(NaN).toISOString() 会抛 RangeError 变裸 500;且签出的 token
  // 过期语义不可信。与别处「non-finite now 视为过期」的守卫一致,显式拒。
  if (!Number.isFinite(nowMs)) throw new HttpError(500, "server time unavailable");
  const session = await parseSessionCookie(request.headers.get("cookie"), {
    secret: deps.sessionSecret,
    now: nowMs,
  });
  if (!session.ok) throw new HttpError(401, "unauthorized");
  const endpoint = await deps.db.getActiveEndpointByAccountId(session.accountId);
  if (endpoint === null) {
    // 还没开通(付费但未 provision,或从未开通)→ 没有可接入的实例。
    throw new HttpError(404, "no active endpoint");
  }
  const code = await signToken(
    { purpose: "claim", subject: endpoint.id },
    { key: deps.sessionSecret, ttlMs: CLAIM_TTL_MS, now: nowMs },
  );
  const expiresAt = new Date(nowMs + CLAIM_TTL_MS).toISOString();
  return json({ code, expires_at: expiresAt }, 200, { noStore: true });
}

/** 脚本凭码换 token(无 session)。验签 → 查 endpoint 仍 active → 向 CF 现取
 *  token。窗口内可重复换(脚本重试/换机器);endpoint 撤销后拒发。 */
async function exchangeClaimCode(request: Request, deps: RouteDeps): Promise<Response> {
  const body = await readJsonBody(request);
  const codeRaw = body.code;
  const code = typeof codeRaw === "string" ? codeRaw : "";
  // now 取一次 + finite 守卫,与 issueClaimCode 对称:now 畸形时若直接传给
  // verifyToken,会把 token 判成过期→400 client error,把服务端时间/配置问题
  // 误报为「码失效」。显式 500 才诚实。
  const nowMs = Date.parse(deps.now());
  if (!Number.isFinite(nowMs)) throw new HttpError(500, "server time unavailable");
  const result = await verifyToken(code, {
    key: deps.sessionSecret,
    now: nowMs,
    expectPurpose: "claim",
  });
  if (!result.ok) throw new HttpError(400, "invalid or expired code");
  const endpoint = await deps.db.getEndpointById(result.subject);
  if (endpoint === null || endpoint.status !== "active") {
    // 撤销/不存在 → 不给已死隧道取 token。403 而非 404:码本身有效,是目标失效。
    throw new HttpError(403, "endpoint not active");
  }
  const token = await deps.cf.getTunnelToken(endpoint.cf_tunnel_id);
  return json({ hostname: endpoint.hostname, token }, 200, { noStore: true });
}

/** slug 实时查重 + 相似推荐(登录后选 slug 用)。需 session。 */
async function slugCheckRoute(url: URL, request: Request, deps: RouteDeps): Promise<Response> {
  const session = await parseSessionWithValidatedNow(request.headers.get("cookie"), deps);
  if (!session.ok) throw new HttpError(401, "unauthorized");
  const slug = url.searchParams.get("s") ?? "";
  // 占用判定查所有状态的行(含 revoked/purged):slug 永久保留不释放(决策 #9)。
  // rootDomain normalize:与本文件别处一致(CONNECT_ROOT_DOMAIN 可能带空白/大小写)。
  const domain = deps.rootDomain.trim().toLowerCase();
  const isTaken: IsTaken = async (s) =>
    (await deps.db.findEndpointBySlugOrHostname(s, `${s}.${domain}`)) !== null;
  const result = await checkSlug(slug, isTaken);
  return json(result, 200, { noStore: true });
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
    headers: {
      location: "/console",
      "set-cookie": cookie,
      "cache-control": "no-store",
      // URL query 里带着 ?t=<magic token>;不加 no-referrer,浏览器会把含
      // token 的完整 referer 带到 /console 请求,进访问日志=泄露短期凭据。
      "referrer-policy": "no-referrer",
    },
  });
}

async function consoleRoute(request: Request, deps: RouteDeps): Promise<Response> {
  const session = await parseSessionWithValidatedNow(request.headers.get("cookie"), deps);
  if (!session.ok) {
    return new Response(null, { status: 302, headers: { location: "/login" } });
  }
  const account = await deps.db.getAccountById(session.accountId);
  if (account === null) {
    // 陈旧 cookie(账号已删)→ fail closed 回登录页。
    return new Response(null, { status: 302, headers: { location: "/login" } });
  }
  const entitlements = await deps.db.listEntitlements(account.id);
  // 该账号的 active endpoint(可能为 null:已付费但还没选 slug,或未开通)。
  // 控制台据此决定显示「选专属地址」入口还是「接入命令」提示词区。
  const endpoint = await deps.db.getActiveEndpointByAccountId(account.id);
  // 仅在「真的能走到 slug 表单」时才数配额,两个条件都要满足:
  //   1. 还没开通(已开通用户不受配额影响)
  //   2. 有有效时长(无时长的用户在 console-page 走早返回分支,压根用不到这个值)
  // 否则未付费/已过期用户每次进控制台都白跑一次全表 COUNT。
  // now 只取一次:同一请求里若取两次,在到期边界附近会出现「判断条件用的时刻」
  // 与「页面渲染的时刻」不一致(状态显示与实际门禁矛盾)。
  const now = deps.now();
  const eligibleToProvision =
    endpoint === null && isEntitlementActive(latestExpiry(entitlements), now);
  const atCapacity = eligibleToProvision
    ? (await deps.db.countLiveEndpoints()) >= CAPACITY_LIMIT
    : false;
  const url = new URL(request.url);
  return htmlPage(
    consolePage({
      account,
      entitlements,
      endpoint,
      baseUrl: url.origin,
      rootDomain: deps.rootDomain.trim().toLowerCase(),
      now,
      atCapacity,
    }),
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

  // 与 Paddle webhook 共用同一套发放逻辑(grant.ts):续费叠加语义、账号 upsert
  // 的竞态处理、幂等判定必须完全一致。此前这里手写了一遍「找最新到期」的 for
  // 循环,而 entitlement.ts 早就有 latestExpiry() —— 两份实现迟早漂移。
  const r = await grantEntitlement(
    { email, months, source, paddleTransactionId: null },
    deps,
  );
  return json({ ok: true, account_id: r.accountId, expires_at: r.expiresAt });
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
      origin: { kind: "invite", inviteId: invite.id },
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
    // 容量已满 → 503。**必须与自助路径用同一个判定**:provisionEndpoint 是
    // 共享函数,这条路径原先漏了映射,容量满时会变成 500(且语义不对——那不是
    // 服务器故障,而是我方配额用尽)。
    if (isAtCapacityError(e)) {
      throw new HttpError(503, "at capacity");
    }
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
      // rootDomain normalize:与 provision.ts 拼 hostname 同款(trim+lowercase),
      // 否则 env 带空白/大写时,竞态失败文案里的 hostname 与实际写入的对不上。
      throw new HttpError(409, `hostname already in use: ${slug}.${deps.rootDomain.trim().toLowerCase()}`);
    }
    if (msg.includes("UNIQUE constraint failed: endpoints.invite_id")) {
      throw new HttpError(409, "invite already provisioned");
    }
    throw e;
  }
  // 判别联合的显式收窄:invite 来源必得 invite 分支结果。这不只是取悦 TS——
  // 若未来重构把 account 分支的结果带到这里,fail-fast 500 好过把 null
  // 序列化成 "/i/null" 发给客户端(Copilot #198 round-2)。
  if (result.kind !== "invite") {
    throw new Error("provisionEndpoint returned non-invite result for an invite origin");
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
  // a hostname or ready state for a revoked/revoke_failed endpoint.
  if (endpoint.status !== "active") {
    return { kind: "not_found" };
  }
  // P4: reveal 现在幂等(token 按需向 CF 取,无一次性 burn),所以 active 的
  // endpoint 永远展示「获取接入信息」按钮——换机器/重试都能再取。不再有
  // 「已展示过」的终态。
  return { kind: "ready", code };
}

async function revealInvite(deps: RouteDeps, code: string): Promise<Response> {
  const outcome = await revealByCode({
    code,
    deps: {
      db: deps.db,
      cf: deps.cf,
      now: deps.now,
      newAuditId: deps.newAuditId,
    },
  });
  switch (outcome.kind) {
    case "not_found":
      throw new HttpError(404, "not found");
    case "not_ready":
      return json({ error: "not ready" }, 409);
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
