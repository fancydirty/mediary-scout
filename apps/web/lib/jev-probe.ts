/**
 * Save-time liveness probe for the Jev prefilter (Settings → 资源提供商). Mirrors
 * pansou-probe: one real request on SAVE only, never on the settings-page poll.
 * A key that fails here is refused, so the prefilter can never be "enabled but
 * silently failing" — that failure mode is exactly what fail-open would hide
 * (the 自建搜索源 that "worked" for 6 days is the same story).
 */
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
        model: "jev-latest",
        state: { candidate: "都挺好 2019 全46集 国语中字 1080P" },
        questions: { probe: { type: "noul", instructions: "`candidate` 是一个中文电视剧资源标题" } },
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        reason: "auth_failed",
        message: "Jev 拒绝了这个 API Key（401/403），未保存。请检查 OpenRouter Key 是否正确、是否有余额。",
      };
    }
    if (!response.ok) {
      return { ok: false, reason: "http_error", message: `Jev 端点返回 HTTP ${response.status}，未保存。` };
    }
    // A non-JSON body (an nginx page, a chat/completions error blob) lands as null
    // and is judged not_jev below — a readable reason, not a swallowed error.
    const body = (await response.json().catch(() => null)) as
      | { model?: unknown; answers?: { probe?: { noul?: unknown } } }
      | null;
    const noul = body?.answers?.probe?.noul;
    if (typeof noul !== "number") {
      return {
        ok: false,
        reason: "not_jev",
        message:
          "这个地址返回的不是 Jev decisions 响应（缺少 answers.probe.noul），未保存。Base URL 应指向 OpenRouter 的 /api/alpha/decisions 或 TypeSafe 的 /v1/systemone。",
      };
    }
    return { ok: true, model: typeof body?.model === "string" ? body.model : "jev-latest" };
  } catch {
    // The key must never reach this message: undici quotes the offending header
    // VALUE in its own error text, and this string is shown to the user.
    return { ok: false, reason: "unreachable", message: "连不上 Jev 端点（超时或网络错误），未保存。" };
  }
}
