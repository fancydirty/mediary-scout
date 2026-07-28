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
  | { kind: "active"; hostname: string | null }
  | { kind: "active_degraded" };

/** 心跳三态。ok=worker 认这个 token(204);unauthorized=worker 明确不认(401,
 *  多半是自带的旧隧道 token,不是 Mediary Connect 发的);unreachable=网络
 *  抖动/超时/5xx——拿不准,按「已开通但暂时联系不上」处理。 */
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
  // 「已开通但状态未知」。其余状态码当作暂时不可达。
  if (res.status === 401) return "unauthorized";
  return "unreachable";
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
}): Promise<RemoteAccessState> {
  const token = opts.token?.trim();
  if (!token) {
    // 未开通就没身份可报——此处**必须**在心跳之前返回。
    return { kind: "not_provisioned" };
  }
  const sendHeartbeat = opts.sendHeartbeat ?? defaultSendHeartbeat;
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
      return { kind: "active_degraded" };
    }
  } catch {
    // 网络炸了按不可达处理:不劝退一个已付出配置成本的用户重新排队。
    return { kind: "active_degraded" };
  }
  return { kind: "active", hostname: opts.hostname ?? null };
}

/**
 * 内测报名站的对外地址（唯一来源）。
 *
 * 指向 worker 承载的报名页——与 /waitlist API 同部署，只换了更好记的域名。
 * 根路径即是表单（worker 对 beta 子域名的 GET / 按 Host 直接 serving 同一
 * 页面函数——不是内部转发到 /beta 路由）。不要再加 /beta 后缀——
 * "beta.…/beta" 是结巴。
 * 设置页「远程访问」tab 的跳转链接从这里取，不要在组件里另写一份。
 * 注意：没有「链接可用性」的自动探测。如果 beta 站未来下线或迁移，
 * 需要的动作是改代码——把 tab 的 not_provisioned 分支改回 return null
 * （触发 settings-tabs 的自动隐藏），而不是指望某个开关。
 */
export const BETA_SITE_URL = "https://beta.mediaryconnect.app";

/** 服务端读实例隧道 token（docker-compose 需把 `TUNNEL_TOKEN` 也传给 web 服务）。 */
export function instanceTunnelToken(): string | undefined {
  return process.env.TUNNEL_TOKEN?.trim() || undefined;
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

