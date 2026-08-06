/**
 * 保存自建搜索源地址时的一次性探活。用户此前只被校验 `^https?://`，于是一个
 * 打不通的地址（或一个根本不是 PanSou 的服务）会被欣然保存，之后每一次获取
 * 都静默失败，还报成「未找到资源」——真实案例里这样活了 6 天。
 *
 * 只在**保存**时打这一次网络。设置页徽章每 8s 轮询一次，绝不能在那条路径上探活。
 */
export type PanSouProbeFailure = "unreachable" | "not_pansou" | "http_error";

export type PanSouProbeResult =
  | { ok: true }
  | { ok: false; reason: PanSouProbeFailure; message: string };

const PROBE_TIMEOUT_MS = 8000;

export async function probePanSou(
  baseURL: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<PanSouProbeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  // trim 后再拼:首尾空白会拼出非法请求地址。
  const url = `${baseURL.trim().replace(/\/+$/, "")}/api/search`;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 探活用一个无意义关键词：命中与否不重要，响应形状才重要。
      body: JSON.stringify({ kw: "__probe__", res: "all" }),
      // 与仓库其余处一致(fetch-with-timeout.ts / remote-access-probe.ts):
      // 用 AbortSignal.timeout 而不是手搓 controller + setTimeout。
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return {
        ok: false,
        reason: "http_error",
        message: `搜索源返回 HTTP ${response.status}，未保存。`,
      };
    }
    // 非 JSON（nginx 欢迎页之类）在这里变成 null，随后被判为 not_pansou。
    // 这不是「吞掉错误」：解析失败本身就是「这不是 PanSou」的证据，
    // 而它会带着可读原因回给用户，不会消失。
    const payload: unknown = await response.json().catch(() => null);
    if (!isPanSouShaped(payload)) {
      return {
        ok: false,
        reason: "not_pansou",
        message: "该地址能访问，但返回的不是 PanSou 接口格式（是不是填成了别的服务？），未保存。",
      };
    }
    return { ok: true };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      reason: "unreachable",
      message: aborted
        ? `搜索源 ${PROBE_TIMEOUT_MS / 1000} 秒内无响应，未保存；若想先跑起来，清空本项即可回落官方源。`
        : "连不上该搜索源，未保存。请检查地址、端口与容器是否在运行；若想先跑起来，清空本项即可回落官方源。",
    };
  }
}

function isPanSouShaped(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const data = (payload as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return false;
  return Array.isArray((data as { results?: unknown }).results);
}

/** 保存前的便宜格式校验。抽出来是为了两个保存入口(设置页 action / agent API)共用
 *  同一条规则并能被直接单测 —— 少了它,一个漏写 scheme 的地址会花 8s 探活然后
 *  拿到「连不上」这种含糊回复,而真正的问题是格式(Copilot 评审指出两侧不一致)。 */
export function validatePanSouBaseUrlFormat(baseURL: string): { ok: true } | { ok: false; message: string } {
  return /^https?:\/\//.test(baseURL.trim())
    ? { ok: true }
    : { ok: false, message: "地址需以 http:// 或 https:// 开头，未保存。" };
}
