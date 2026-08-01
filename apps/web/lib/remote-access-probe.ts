/**
 * 远程访问「测试连接」探测。
 *
 * ## 探测什么
 *
 * `GET https://<hostname>/api/health` —— 实例自己的健康端点,匿名可达
 * (proxy.ts 把 /api/health 列入 bypass,connect.sh 也靠它验证隧道通没通)。
 *
 * ## 为什么用 GET 而不是 HEAD
 *
 * 区分 200/503 只需状态码,HEAD 也能拿到。真正必须 GET 的是:
 * 200 时要读 body 校验 { status: "ok" }(防反代对任何路径回 200 登录页),
 * HEAD 没有 body —— 所以用 GET(Copilot round 3 修正的注释)。
 *
 * ## 为什么走服务端而不是浏览器直接 fetch
 *
 * 跨域:实例没有 CORS 头,浏览器直连会失败。server action 代理探测。
 *
 * ## 语义(每条都是真实场景)
 *
 * - 200 + ok body → "可达":隧道通、实例健康。
 * - 503 → "隧道通但实例内部有问题":DB 挂了等。用户该去查实例,不是查隧道。
 * - 其它/超时/网络错 → "连不上":隧道断了或实例不在线。
 *
 * 超时必带(项目规则:新外部 HTTP 一律带超时) —— 探测是点击触发的同步路径,
 * 卡住会让按钮永远 pending。
 */
export type RemoteAccessProbeResult =
  | { ok: true; detail: "reachable" }
  | { ok: false; detail: "instance_problem" }   // 503:隧道通,实例内部有问题
  | { ok: false; detail: "unreachable" };       // 其它/超时/网络错

const PROBE_TIMEOUT_MS = 8_000;

export async function probeRemoteAccess(
  hostname: string,
  fetchFn: typeof fetch = fetch,
): Promise<RemoteAccessProbeResult> {
  let res: Response;
  try {
    res = await fetchFn(`https://${hostname}/api/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    // 超时/网络错/DNS 失败 → 连不上。
    return { ok: false, detail: "unreachable" };
  }
  if (res.status === 200) {
    // 200 还要求 body 是 ok —— 反代可能对任何路径都回 200 登录页(那正是
    // remote-access.ts 里"严格判 204"同一类陷阱的镜像)。
    try {
      const body: unknown = await res.json();
      const status = (body as { status?: unknown } | null)?.status;
      if (status === "ok") return { ok: true, detail: "reachable" };
    } catch {
      // body 不是 JSON → 不是健康响应,按不可达处理。
    }
    return { ok: false, detail: "unreachable" };
  }
  if (res.status === 503) {
    // 隧道通,实例内部有问题(health 路由 DB 挂时返回 503)。
    return { ok: false, detail: "instance_problem" };
  }
  // 其它 4xx/5xx:拿不准,按不可达。
  return { ok: false, detail: "unreachable" };
}
