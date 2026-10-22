/**
 * Zero-dependency web search for the two places that benefit from reading the
 * open web instead of a metadata database:
 *
 *  1. the search box — the user describes a plot or cannot recall the title, and
 *     TMDB's keyword search finds nothing;
 *  2. the acquisition agent — checking alternate/localized titles, and mapping
 *     "第二季 / 死灭回游" onto the absolute episode numbers TMDB uses for shows
 *     that its rights-holder never split into seasons.
 *
 * Two providers, both plain `fetch` (no SDK):
 *
 *  - **Parallel anonymous Search MCP** (`https://search.parallel.ai/mcp`) —
 *    keyless, JSON-RPC `tools/call`. Used when the user has no key of their own.
 *  - **DeepSeek official Search** (`POST {baseURL}/v1/tools/search`) — when the
 *    user's configured LLM endpoint IS DeepSeek's API, their own key already pays
 *    for search, so we use DeepSeek's engine and bill nobody else.
 *
 * Every path returns the same `WebSearchHit[]`; callers never branch on vendor.
 * Web evidence is REFERENCE ONLY — it is never a resource candidate and never
 * proof that a title was acquired.
 */

const PARALLEL_MCP_ENDPOINT = "https://search.parallel.ai/mcp";
const USER_AGENT = "mediary-scout (+https://github.com/fancydirty/mediary-scout)";
const DEFAULT_TIMEOUT_MS = 20_000;

export interface WebSearchHit {
  title: string;
  url: string;
  /** Model-facing excerpt: the strongest evidence for identity/title claims. */
  snippet: string;
}

export type WebSearchVendor = "deepseek" | "parallel";

export interface WebSearchOptions {
  /** The user's LLM endpoint + key (Settings → AI 模型). When the endpoint is
   *  DeepSeek's own API we use their search and their key. */
  llmBaseURL?: string;
  llmApiKey?: string;
  /** Max seconds for one search; default 20. */
  timeoutMs?: number;
  /** Max hits returned; default 6. */
  limit?: number;
  fetch?: typeof fetch;
}

/** Recognize DeepSeek's official API so its own search endpoint is used (their
 *  key, their quota). A self-hosted mirror is NOT DeepSeek — it has no
 *  `/v1/tools/search`, so the anonymous provider stays the right choice there. */
export function isDeepSeekEndpoint(baseURL: string | undefined): boolean {
  if (!baseURL) return false;
  let host: string;
  try {
    host = new URL(baseURL.trim()).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "api.deepseek.com" || host.endsWith(".deepseek.com");
}

/** Which vendor a config resolves to. Exported for the diagnostics line and tests. */
export function resolveWebSearchVendor(options: Pick<WebSearchOptions, "llmBaseURL" | "llmApiKey">): WebSearchVendor {
  const hasKey = (options.llmApiKey ?? "").trim() !== "";
  return hasKey && isDeepSeekEndpoint(options.llmBaseURL) ? "deepseek" : "parallel";
}

/**
 * Run one web search. Throws on transport/config errors — callers treat a search
 * failure as "no web evidence", never as a hard task failure.
 */
export async function webSearch(query: string, options: WebSearchOptions = {}): Promise<WebSearchHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const vendor = resolveWebSearchVendor(options);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const limit = options.limit ?? 6;
  return vendor === "deepseek"
    ? deepSeekSearch(trimmed, { ...options, fetch: fetchImpl, timeoutMs, limit })
    : parallelSearch(trimmed, { ...options, fetch: fetchImpl, timeoutMs, limit });
}

// ── Parallel (anonymous) ───────────────────────────────────────────────────

/** Parallel's MCP `web_search` returns a JSON document inside the tool's text
 *  content — parse it, but tolerate a plain-text body too. */
function parseParallelPayload(text: string): WebSearchHit[] {
  const attempt = (raw: string): WebSearchHit[] | null => {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      const results = (parsed as { results?: unknown }).results;
      if (!Array.isArray(results)) return null;
      return results.flatMap((item): WebSearchHit[] => {
        if (!item || typeof item !== "object") return [];
        const record = item as Record<string, unknown>;
        const url = typeof record.url === "string" ? record.url : "";
        const title = typeof record.title === "string" ? record.title : url;
        const excerpts = Array.isArray(record.excerpts)
          ? record.excerpts.filter((e): e is string => typeof e === "string")
          : [];
        const single = typeof record.excerpt === "string" ? [record.excerpt] : [];
        const snippet = [...excerpts, ...single].join("\n").trim();
        return url ? [{ title, url, snippet }] : [];
      });
    } catch {
      return null;
    }
  };
  const structured = attempt(text);
  if (structured) return structured;
  // Unstructured text is still usable evidence, just without links.
  const plain = text.trim();
  return plain ? [{ title: "web search", url: "", snippet: plain }] : [];
}

async function parallelSearch(
  query: string,
  options: Required<Pick<WebSearchOptions, "fetch" | "timeoutMs" | "limit">> & WebSearchOptions,
): Promise<WebSearchHit[]> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "web_search",
      arguments: {
        objective:
          "Identify the exact film or TV/anime title (including localized and alternate names) and, when asked, which episode numbers a named season or story arc covers. Return source evidence, not download links.",
        search_queries: [query],
      },
    },
  });
  const signal = AbortSignal.timeout(options.timeoutMs);
  const response = await options.fetch(PARALLEL_MCP_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": USER_AGENT,
    },
    body,
    signal,
  });
  if (!response.ok) {
    throw new Error(`Web search unavailable (${response.status})`);
  }
  const payload = (await response.json()) as unknown;
  // MCP wraps the tool result: { result: { content: [{ type, text }], isError? } }
  const result = (payload as { result?: unknown }).result as
    | { content?: unknown; isError?: unknown }
    | undefined;
  if (result?.isError === true) {
    throw new Error("Web search returned an error");
  }
  const content = Array.isArray(result?.content) ? result!.content : [];
  const text = content
    .flatMap((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : [],
    )
    .join("\n");
  return parseParallelPayload(text).slice(0, options.limit);
}

// ── DeepSeek (user's own key) ──────────────────────────────────────────────

async function deepSeekSearch(
  query: string,
  options: Required<Pick<WebSearchOptions, "fetch" | "timeoutMs" | "limit">> & WebSearchOptions,
): Promise<WebSearchHit[]> {
  // Settings store an OpenAI-compatible base URL, which commonly already ends in
  // /v1 — the tool routes are mounted under /v1/tools, so strip it first.
  const baseURL = (options.llmBaseURL ?? "").trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
  const apiKey = (options.llmApiKey ?? "").trim();
  if (!baseURL || !apiKey) {
    throw new Error("DeepSeek search needs a base URL and API key");
  }
  const signal = AbortSignal.timeout(options.timeoutMs);
  const response = await options.fetch(`${baseURL}/v1/tools/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({ query, count: options.limit }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Web search unavailable (${response.status})`);
  }
  const payload = (await response.json()) as { results?: unknown };
  const results = Array.isArray(payload.results) ? payload.results : [];
  return results
    .flatMap((item): WebSearchHit[] => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      const url = typeof record.url === "string" ? record.url : "";
      const title = typeof record.title === "string" ? record.title : url;
      const snippet =
        [record.summary, record.snippet]
          .filter((value): value is string => typeof value === "string" && value.trim() !== "")
          .join("\n")
          .trim() || (typeof record.content === "string" ? record.content.slice(0, 2_000) : "");
      return url || snippet ? [{ title, url, snippet }] : [];
    })
    .slice(0, options.limit);
}

/** Render hits for a model prompt: compact, link-preserving, bounded. */
export function renderWebHits(hits: WebSearchHit[], maxChars = 6_000): string {
  const text = hits
    .map((hit, index) => {
      const head = hit.url ? `${index + 1}. ${hit.title} — ${hit.url}` : `${index + 1}. ${hit.title}`;
      return hit.snippet ? `${head}\n${hit.snippet}` : head;
    })
    .join("\n\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}
