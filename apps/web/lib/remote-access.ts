/**
 * 实例侧「远程访问」状态解析。纯逻辑 + 依赖注入，node 环境可测。
 *
 * ## 为什么状态里没有 hostname / connections
 *
 * Plan 3 落地的 worker 契约（见 `workers/scout-connect/src/routes.ts` 的
 * `reportInstanceStatus` 与 `workers/scout-connect/README.md`）是：
 *
 *   POST /api/instance/status
 *   Authorization: Bearer <TUNNEL_TOKEN>       ← 头，不是 JSON body
 *   → 204 No Content（**无 body**）/ 401
 *
 * 204 无 body 是刻意的：即便持有有效 token 也拿不到任何端点元数据，
 * 于是这个公开端点无法被当作「探测某 token 对应哪个域名」的预言机。
 * 因此本模块把这次调用当作**心跳/存活探测**（它同时会在服务端更新
 * `last_seen_at`，本身有价值），而不是数据源：
 *
 *  - `connections` 直接不要了。它是运维细节，用户不需要；要拿到它就得给
 *    worker 新开一个返回元数据的端点，那等于把 Plan 3 刻意关掉的信息泄露面
 *    重新打开。
 *  - `hostname` 只可能来自**本地**。本仓库目前**没有**任何本地来源：
 *    实例只被写入 `TUNNEL_TOKEN`（见 `.env.example` / `docker-compose.yml` 的
 *    cloudflared 服务 / worker 那份 agent-prompt 生成的 .env 写入脚本——
 *    它只写 `TUNNEL_TOKEN` 与 `TUNNEL_TRANSPORT_PROTOCOL`），公网域名只存在于
 *    worker 侧的 D1 与用户自己的浏览器里。`MEDIA_TRACK_ALLOWED_ORIGINS` 是
 *    构建期 CSRF 白名单（可为空、可多值、只在反代不透传 x-forwarded-host 时才
 *    设），不是「本实例的公网域名」，拿它冒充会在多值/空值时显示错域名。
 *    所以 hostname 是 `string | null`：拿不到就是 null，UI 显示「已开启」但
 *    **不给链接**，绝不臆造一个用户点了会 404 的地址。
 *    若将来实例侧真落地了自己的域名（配置项或隧道 setup 写入），
 *    从 `resolveRemoteAccessState` 的 `hostname` 入参喂进来即可。
 */

export type RemoteAccessState =
  | { kind: "not_provisioned" }
  /**
   * `lastSeenAt`：本机上次成功打到控制面的时间（ISO 串），拿不到就是 null。
   *
   * **它证明的是「本机 → 控制面」（出站），不是「外网 → 本机」（入站）。**
   * 两个方向的失败模式完全不重叠：容器出站正常但 cloudflared 挂了，
   * 是最常见的故障，而这个时间戳在那种情况下依然显示「刚刚」。
   * 所以 UI 文案主语必须是「本机到控制面」，**绝不能写成「隧道已连接」
   * 或「远程访问正常」**。
   */
  | { kind: "active"; hostname: string | null; lastSeenAt: string | null }
  | { kind: "active_degraded" };

/** 心跳三态。ok=worker 认这个 token(204);unauthorized=worker 明确不认(401,
 *  多半是自带的旧隧道 token,不是 Mediary Connect 发的);unreachable=
 *  其余状态码/网络错误(超时、4xx、5xx 等)——拿不准,按「已开通但暂时联系不上」处理。 */
export type HeartbeatResult = "ok" | "unauthorized" | "unreachable";

const DEFAULT_WORKER_BASE = "https://mediaryconnect.app";

/**
 * 当前运行时的 worker base（唯一来源）。
 *
 * 服务端心跳与客户端 waitlist 表单**必须**用同一个值：否则把
 * `SCOUT_CONNECT_URL` 指向预发/自建 worker 时，状态卡打到新 worker，
 * 而报名表单仍写进生产队列——测试数据污染真实名单。
 *
 * 在函数里读 env 而非模块顶层常量：`cacheComponents` 下模块可能在构建期就被
 * 求值，把 build 环境的 env 值烤死进产物——docker 镜像 build/run 环境不同，
 * 那样预发/自建实例改 `SCOUT_CONNECT_URL` 会失效。
 * 这个值不敏感（就是个公开域名），可以安全下发给客户端组件。
 */
export function scoutConnectBaseUrl(): string {
  const raw = process.env.SCOUT_CONNECT_URL?.trim();
  if (!raw) return DEFAULT_WORKER_BASE;
  const trimmed = raw.replace(/\/+$/, "");
  // 必须校验协议：仅 trim + 去尾斜杠的话，误配成 "/" 或 "////" 会规范化成空串，
  // 而 "mediaryconnect.app"（漏了协议）也不是绝对 URL——两种情况都会让
  // `${base}/api/instance/status` 变成**同源相对路径**，心跳静默打到实例自己身上，
  // 而且症状是「远程访问显示降级」，排查时根本想不到是 env 配错了。
  // 校验失败宁可回落到生产默认值（可用），也不要静默走错地址。
  if (!/^https?:\/\/[^/]+/.test(trimmed)) return DEFAULT_WORKER_BASE;
  return trimmed;
}

/**
 * 心跳超时。这次 fetch 发生在 `/settings` 的 **SSR 渲染路径**上——没有超时的话，
 * worker 或网络「卡住但不报错」会把整个设置页的渲染一起挂死（不是慢，是永远不返回）。
 * 遵守项目硬规则「新外部 HTTP 一律带超时」（见 `pan123-client.ts` 的同款注释）。
 * 5s 与 `deployment-update-server.ts` 的探测保持一致：这只是个存活探针，
 * 超时即按降级处理，反正降级态本来就是「拿不到状态」。
 */
const HEARTBEAT_TIMEOUT_MS = 5_000;

/** 心跳一次。契约里 204=ok,401=unauthorized(token 不是我们发的),
 *  其余状态码/网络错误=unreachable。 */
async function defaultSendHeartbeat(token: string): Promise<HeartbeatResult> {
  const res = await fetch(`${scoutConnectBaseUrl()}/api/instance/status`, {
    method: "POST",
    // 契约是 Bearer 头；worker 压根不读 body（大 body 都不会被读取）。
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
  });
  // 严格判 204：契约就是 204 无 body。放宽成 res.ok 会把任何反代/门禁塞回来的
  // 200 登录页当成「隧道健康」，那是最需要被显示为降级的场景。
  if (res.status === 204) return "ok";
  // 401 是 worker 明确「不认这个 token」——多半是自带旧隧道的 token,不是
  // Mediary Connect 开通的。据此把状态显示为「未开通」(露出报名入口),而不是
  // 「已开通但状态未知」。其余状态码(含其它 4xx/5xx)一律当作暂时不可达。
  if (res.status === 401) return "unauthorized";
  return "unreachable";
}

/**
 * 把 ISO 时间串格成「N 分钟前」。纯函数，注入 now 便于测试。
 *
 * **只处理"过去"**：未来时间（两端时钟不同步）显示成「刚刚」而不是
 * 「-3 分钟前」—— 后者会让用户以为系统坏了，而实际上时钟偏几秒很正常。
 */
export function formatLastSeen(iso: string | null, now: number = Date.now()): string | null {
  if (iso === null) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;

  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 0) return "刚刚";
  // 取整方向要和用户直觉一致：59s 说「59 秒前」，61s 说「1 分钟前」。
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  // 超过一个月就别再算了 —— 那个精度对「上次报到」这件事没有意义。
  return "很久以前";
}

/**
 * 读 `last_seen_at`。**只读，不写** —— worker 侧 GET /api/instance/meta 刻意
 * 不更新它（一个既读又写的端点会让每次轮询都看起来像新活动）。
 *
 * 为什么不复用 POST /api/instance/status：那个端点的契约是 **204 无 body**，
 * 而且这份严格是刻意的（放宽成 res.ok 会把反代的 200 登录页当成健康）。
 * worker 与容器走独立发布通道，改 /status 会在滚动升级窗口里让所有存量容器
 * 显示成降级。所以 worker 那边新开了只读端点，代价是多一次请求。
 *
 * 旧 worker 没有这个端点 → 404 → 返回 null（UI 隐掉这一行）。这就是向后兼容：
 * 容器可以先发，worker 后发，中间不出错。
 */
async function defaultFetchLastSeenAt(token: string): Promise<string | null> {
  const res = await fetch(`${scoutConnectBaseUrl()}/api/instance/meta`, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>).last_seen_at;
  return typeof value === "string" ? value : null;
}

/**
 * `token` 有值即视为已开通（本实例被发过连接凭据）；心跳只决定 active 还是降级。
 *
 * 心跳失败**不**回落成 not_provisioned：那会把「已开通但网络抖动」显示成
 * 「未开通 + waitlist 表单」，等于劝一个已经付出配置成本的用户重新排队。
 */
export async function resolveRemoteAccessState(opts: {
  token: string | undefined;
  /** 本地已知的公网域名（当前无来源，见文件头注释）。 */
  hostname?: string | null;
  sendHeartbeat?: (token: string) => Promise<HeartbeatResult>;
  /**
   * 读 `last_seen_at`（GET /api/instance/meta）。**注意这是心跳之前的值** ——
   * 心跳本身会把它更新成"现在"，所以必须先读再报到，否则永远显示「刚刚」，
   * 那就成了一个恒真的假指标。
   */
  fetchLastSeenAt?: (token: string) => Promise<string | null>;
}): Promise<RemoteAccessState> {
  const token = opts.token?.trim();
  if (!token) {
    // 未开通就没身份可报——此处**必须**在心跳之前返回。
    return { kind: "not_provisioned" };
  }
  const sendHeartbeat = opts.sendHeartbeat ?? defaultSendHeartbeat;
  // 注入 sendHeartbeat 但没注入 fetchLastSeenAt 时，**不要**回落到真实网络请求。
  // 那会让「我已经把网络打桩掉了」的调用方（测试、离线渲染）意外发出跨公网
  // 请求并各卡 5 秒超时。两者要么都是真的，要么都是假的 —— 打桩一半最难查。
  const fetchLastSeenAt =
    opts.fetchLastSeenAt ??
    (opts.sendHeartbeat ? async () => null : defaultFetchLastSeenAt);
  // 先读后报到：心跳会把 last_seen_at 写成"现在"，读晚了就永远是「刚刚」。
  // 失败不影响主流程 —— 它只是个附加信息，不能让它决定开通状态。
  let lastSeenAt: string | null = null;
  try {
    lastSeenAt = await fetchLastSeenAt(token);
  } catch {
    lastSeenAt = null;
  }
  try {
    // 捕获一切：这是在渲染路径上做的一次网络调用，worker 挂了不该炸掉设置页。
    // 也刻意不把 error 放进返回值——报错串里可能带着 token（见测试）。
    const result = await sendHeartbeat(token);
    if (result === "unauthorized") {
      // worker 不认这个 token = 不是 Mediary Connect 开通的(如自带旧隧道)。
      // 显示未开通,露出报名入口,而不是把用户卡在「已开通但状态未知」。
      return { kind: "not_provisioned" };
    }
    if (result === "unreachable") {
      // 其余状态码/网络错误:拿不准,保持「已开通但联系不上」。
      return { kind: "active_degraded" };
    }
  } catch {
    // 网络炸了按不可达处理:不劝退一个已付出配置成本的用户重新排队。
    return { kind: "active_degraded" };
  }
  return { kind: "active", hostname: opts.hostname ?? null, lastSeenAt };
}

/**
 * Mediary Connect 官网地址（唯一来源）。
 *
 * 指向 **apex**：内测报名页(beta 子域)已退役并 301 到这里 —— apex 现在有
 * 完整的登录+购买路径，用户不需要先「报名内测」再等邀请。
 *
 * 无尾斜杠、无路径。设置页「远程访问」的跳转链接从这里取，
 * 不要在组件里另写一份。
 *
 * 注意：没有「链接可用性」的自动探测。若这个站未来下线/迁移，需要的动作是
 * 改代码 —— 把 not_provisioned 分支改回 return null（触发 settings-tabs 的
 * 自动隐藏），而不是指望某个开关。
 */
export const CONNECT_SITE_URL = "https://mediaryconnect.app";

/** 服务端读实例隧道 token（docker-compose 需把 `TUNNEL_TOKEN` 也传给 web 服务）。 */
export function instanceTunnelToken(): string | undefined {
  return process.env.TUNNEL_TOKEN?.trim() || undefined;
}

/**
 * 用户控制台入口（登录页即入口，魔法链接无密码）。
 *
 * 从 `scoutConnectBaseUrl()` 派生而非再写死一个生产域名：本模块的既定设计就是
 * 「worker base 只有一个来源」（见上），`SCOUT_CONNECT_URL` 指向预发/自建 worker
 * 时若控制台链接仍钉在生产，用户会被从预发实例送去生产控制台——那里没有他这台
 * 机器的记录，看起来就是「开通了但控制台查不到」。
 *
 * 必须是函数而非常量：顶层求值在 `cacheComponents` 下会把构建期 env 烤死进产物。
 */
export function consoleUrl(): string {
  return `${scoutConnectBaseUrl()}/login`;
}

/**
 * 实例的公网域名——connect.sh 接入时写进 .env 的本地来源
 * (MEDIARY_CONNECT_HOSTNAME=dirtyfancy.mediaryconnect.app)。这正是本文件
 * 头注释预留的「隧道 setup 写入」来源:有了它,远程访问 tab 就能显示专属
 * 地址与控制台链接,而不用碰 worker 元数据(204 无 body 的刻意设计不变)。
 *
 * 早期接入的实例 .env 里没这行(connect.sh 后加的)——返回 null,UI 回落到
 * 旧的「已开启但不给链接」文案,绝不臆造。
 * 在函数里读 env(cacheComponents 下模块顶层求值会把构建期 env 烤进产物)。
 * 校验成 hostname 形状(DNS 字符集,无协议无路径)防 env 被塞怪东西。 */
export function instanceConnectHostname(): string | null {
  const raw = process.env.MEDIARY_CONNECT_HOSTNAME?.trim().toLowerCase();
  if (!raw) return null;
  // 逐 label 校验:每段以字母数字开头结尾、中间可含连字符,最后一段是 TLD。
  // 宽松的 /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/ 会放过 `a..b.com`、`a-.b.com`
  // 这类非法 DNS 形状——虽然不危险,但会渲染出点了就坏的链接。
  const LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
  const HOSTNAME_RE = new RegExp(`^(?:${LABEL}\\.)+[a-z]{2,}$`);
  return HOSTNAME_RE.test(raw) ? raw : null;
}

/**
 * 「去设置密码」链接。
 *
 * 必须保留 `?w` 工作区深链参数：从非默认工作区进设置页时，硬编码
 * `/settings?tab=account` 会把用户静默踢回默认工作区上下文。
 * （`settings/page.tsx` 已经在 `SettingsSidebar` / `SettingsAttentionSection`
 * 里透传同一个 `w`，这里跟随同一约定。）
 */
export function accountPasswordHref(w?: string): string {
  const params = new URLSearchParams({ tab: "account" });
  if (w) params.set("w", w);
  return `/settings?${params.toString()}#password`;
}

// ─────────────────────────────────────────────────────────────────────────
// 在设置页内发起 Mediary Connect 登录
// ─────────────────────────────────────────────────────────────────────────

export interface ConnectLoginResult {
  ok: boolean;
  /** 面向用户的中文提示。ok 时是「已发送」,否则是可操作的失败原因。 */
  message: string;
}

/**
 * 代实例向 worker 请求一封魔法链接邮件。
 *
 * **为什么走服务端而不是浏览器直接 fetch**:worker 不发 CORS 头,
 * 浏览器跨域 POST 会被拦(实测 OPTIONS 预检 404)。而给 worker 加 CORS
 * 等于为了一个入口放宽整站跨域策略 —— 不值得。现有心跳
 * (defaultSendHeartbeat)本来也是服务端 fetch,这里沿用同一条路子。
 *
 * **不判断邮箱是否已注册**:worker 恒返回 202(不泄露注册状态),
 * 所以这里也只能说「已发送」。
 */
export async function requestConnectLogin(
  email: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectLoginResult> {
  const trimmed = email.trim();
  // 只做最粗的形状检查:真正的校验在 worker(EMAIL_RE)。这里拦一下是为了
  // 省一次跨网请求,不是安全边界。
  if (trimmed.length < 3 || trimmed.length > 254 || !trimmed.includes("@")) {
    return { ok: false, message: "请输入一个有效的邮箱地址。" };
  }
  try {
    const res = await fetchImpl(`${scoutConnectBaseUrl()}/api/auth/magic`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: trimmed }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 202) {
      return { ok: true, message: `已发送到 ${trimmed}。点邮件里的链接就能登录并开通。` };
    }
    // 429 是发信入口的限流,要给可操作的话而不是「稍后重试」。
    if (res.status === 429) {
      return { ok: false, message: "请求太频繁了,过几分钟再试。" };
    }
    if (res.status === 400) {
      return { ok: false, message: "这个请求没被接受。检查邮箱地址后再试。" };
    }
    return { ok: false, message: "发送失败了,请稍后再试。" };
  } catch {
    // 超时/DNS/网络不通都落这里。实例可能在没有外网的内网里 —— 这句要说清。
    return { ok: false, message: "连不上 Mediary Connect。检查这台机器能不能访问外网。" };
  }
}
