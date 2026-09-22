/**
 * Save-time liveness probe for the Jev prefilter (Settings → AI 模型). Mirrors
 * pansou-probe: one real request on SAVE only, never on the settings-page poll.
 * A key that fails here is refused, so the prefilter can never be "enabled but
 * silently failing" — that failure mode is exactly what fail-open would hide
 * (the 自建搜索源 that "worked" for 6 days is the same story).
 */
import { JEV_MODEL } from "@media-track/workflow";

export type JevProbeFailure = "unreachable" | "auth_failed" | "http_error" | "not_jev";

export type JevProbeResult =
  | { ok: true; model: string }
  | { ok: false; reason: JevProbeFailure; message: string };

const PROBE_TIMEOUT_MS = 8000;

export async function probeJev(
  config: { apiKey: string; baseUrl: string },
  options: { fetchImpl?: typeof fetch } = {},
): Promise<JevProbeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(config.baseUrl.trim(), {
      method: "POST",
      // trim: a key pasted into a settings field carries a trailing newline and
      // undici rejects a header value containing one (same rule as jev-client).
      headers: { Authorization: `Bearer ${config.apiKey.trim()}`, "Content-Type": "application/json" },
      // One fixed noul question — the answer's VALUE is irrelevant, its shape is
      // the whole point: only a real decisions endpoint returns answers.probe.noul.
      body: JSON.stringify({
        // The same constant jev-client sends: probing a model the client never
        // asks for would certify an endpoint the real搜索 doesn't exercise.
        model: JEV_MODEL,
        state: { candidate: "都挺好 2019 全46集 国语中字 1080P" },
        questions: { probe: { type: "noul", instructions: "`candidate` 是一个中文电视剧资源标题" } },
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        reason: "auth_failed",
        message: "这个 Jev API Key 被拒绝（401/403），未保存。请检查 Key 是否正确、账户是否有余额（OpenRouter 或 TypeSafe 官方的 Key 都可以）。",
      };
    }
    if (!response.ok) {
      return { ok: false, reason: "http_error", message: `Jev 端点返回 HTTP ${response.status}，未保存。` };
    }
    // A non-JSON body (an nginx page, a chat/completions error blob) lands as null
    // and is judged not_jev below — a readable reason, not a swallowed error. Only a
    // parse failure means that: a body read that DIES (connection dropped → TypeError
    // "terminated", the 8s signal firing mid-body → TimeoutError) says nothing about
    // what the endpoint is, so it goes to the transport handler below like any other.
    const body = (await response.json().catch((error: unknown) => {
      if (error instanceof SyntaxError) return null;
      throw error;
    })) as { model?: unknown; answers?: { probe?: { noul?: unknown } } } | null;
    const noul = body?.answers?.probe?.noul;
    // Same acceptance rule as the real client (jev-client: finite, 0..1). An answer the
    // client would reject must fail HERE, or the endpoint is saved healthy and every
    // real search then fails open without a word.
    if (typeof noul !== "number" || !Number.isFinite(noul) || noul < 0 || noul > 1) {
      return {
        ok: false,
        reason: "not_jev",
        message:
          "这个地址返回的不是 Jev decisions 响应（缺少 answers.probe.noul），未保存。Base URL 应指向 OpenRouter 的 /api/alpha/decisions 或 TypeSafe 的 /v1/systemone。",
      };
    }
    return { ok: true, model: typeof body?.model === "string" ? body.model : JEV_MODEL };
  } catch (error) {
    // AbortSignal.timeout rejects with TimeoutError (AbortError when something
    // else aborts). Folding both into the generic 「网络错误」 text hides the one
    // actionable fact — the endpoint answered nothing inside the budget.
    const timedOut =
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      ok: false,
      reason: "unreachable",
      // NEVER interpolate `error`: undici quotes the offending header VALUE —
      // i.e. the API key — in its own message, and this string is shown to the user.
      message: timedOut
        ? `Jev 端点 ${PROBE_TIMEOUT_MS / 1000} 秒内没有响应，未保存。`
        : "连不上 Jev 端点（网络错误），未保存。",
    };
  }
}

/** 保存前的便宜格式校验（同 pansou-probe.validatePanSouBaseUrlFormat）。少了它，
 *  一个漏写 scheme 的地址要先花 8s 探活，再拿到含糊的「连不上」，而真正的问题是格式。
 *  Key 放在 Authorization 头里：http:// 会让它明文出去。主机名证明不了它解析到哪
 *  （搜索域、会劫持 NXDOMAIN 的解析器、mDNS 伪造），所以 http:// 只认 localhost 和
 *  字面的回环 / 私网 / 链路本地 IP；其余一律要 https://。 */
export function validateJevBaseUrlFormat(url: string): { ok: true } | { ok: false; message: string } {
  const trimmed = url.trim();
  if (/^https:\/\//i.test(trimmed)) return { ok: true };
  if (/^http:\/\//i.test(trimmed) && isLocalHost(hostnameOf(trimmed))) return { ok: true };
  return {
    ok: false,
    message: "Base URL 必须以 https:// 开头（http:// 只能用于 localhost 或局域网 IP 地址：Key 会随请求明文发出），未保存。",
  };
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return "";
  }
}

/** localhost, IPv6 loopback, and literal loopback / RFC 1918 / link-local IPv4 —
 *  addresses, not names: a name's resolution is not something this check can vouch for. */
function isLocalHost(host: string): boolean {
  if (host === "localhost" || host === "::1") return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  // The WHATWG URL parser already refuses an out-of-range octet (ERR_INVALID_URL), but
  // this check must not depend on its caller having parsed the host that way.
  if (!ipv4 || ipv4.slice(1).some((octet) => Number(octet) > 255)) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}
