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

const DEFAULT_WORKER_BASE = "https://mediaryconnect.app";

/**
 * 心跳一次。`true` = worker 明确回了 204（契约里唯一的成功）。
 *
 * 注意读的是 `process.env`（而非模块顶层常量）：cacheComponents 下模块可能在
 * 构建期就被求值，把 build 环境的 env 值烤死进产物——docker 镜像 build/run
 * 环境不同，那样预发/自建实例改 `SCOUT_CONNECT_URL` 会失效。
 */
async function defaultSendHeartbeat(token: string): Promise<boolean> {
  const base = process.env.SCOUT_CONNECT_URL?.trim() || DEFAULT_WORKER_BASE;
  const res = await fetch(`${base.replace(/\/+$/, "")}/api/instance/status`, {
    method: "POST",
    // 契约是 Bearer 头；worker 压根不读 body（大 body 都不会被读取）。
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  // 严格判 204：契约就是 204 无 body。放宽成 res.ok 会把任何反代/门禁塞回来的
  // 200 登录页当成「隧道健康」，那是最需要被显示为降级的场景。
  return res.status === 204;
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
  sendHeartbeat?: (token: string) => Promise<boolean>;
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
    if (!(await sendHeartbeat(token))) {
      return { kind: "active_degraded" };
    }
  } catch {
    return { kind: "active_degraded" };
  }
  return { kind: "active", hostname: opts.hostname ?? null };
}

/** 服务端读实例隧道 token（docker-compose 需把 `TUNNEL_TOKEN` 也传给 web 服务）。 */
export function instanceTunnelToken(): string | undefined {
  return process.env.TUNNEL_TOKEN?.trim() || undefined;
}
