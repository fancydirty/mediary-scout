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
  const url = `${baseURL.replace(/\/+$/, "")}/api/search`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 探活用一个无意义关键词：命中与否不重要，响应形状才重要。
      body: JSON.stringify({ kw: "__probe__", res: "all" }),
      signal: controller.signal,
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
        ? `搜索源 ${PROBE_TIMEOUT_MS / 1000} 秒内无响应，未保存。`
        : "连不上该搜索源，未保存。请检查地址、端口与容器是否在运行。",
    };
  } finally {
    clearTimeout(timer);
  }
}

function isPanSouShaped(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const data = (payload as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return false;
  return Array.isArray((data as { results?: unknown }).results);
}
