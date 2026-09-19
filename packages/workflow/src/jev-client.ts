// packages/workflow/src/jev-client.ts
import { buildJevQuestions, JEV_MODEL, type JevJudge, type JevJudgeInput, type JevJudgeResult } from "./jev-judge.js";

/** OpenRouter's decisions router for TypeSafe Jev. The chat/completions endpoint
 *  rejects this model (400 "decisions model"); this alpha route speaks the native
 *  {state, questions} → {answers} shape. */
export const DEFAULT_JEV_BASE_URL = "https://openrouter.ai/api/alpha/decisions";
/** Re-exported from jev-judge.ts (its single definition) so existing importers of
 *  this module are unaffected by the move. */
export { JEV_MODEL };
/** Evals: 322 candidates in one call (~37k tokens) succeeded but sits above the
 *  documented ~32k budget; 150 (~17k) leaves headroom. Chunks run in parallel. */
export const JEV_CHUNK_SIZE = 150;
/** p90 was 0.9s over OpenRouter, 1.1s for a 322-candidate batch. 8s is a wide ceiling. */
export const JEV_TIMEOUT_MS = 8_000;

export interface JevClientConfig {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface DecisionsResponse {
  model?: unknown;
  answers?: Record<string, { noul?: unknown }>;
  usage?: { input_tokens?: unknown; cost?: unknown };
}

/** Real Jev judge. No retries by design: the provider is fail-open, and OpenRouter
 *  warns an unknown outcome may already be billed. Errors never include the key. */
export function createJevJudge(config: JevClientConfig): JevJudge {
  if (!config.apiKey || config.apiKey.trim() === "") throw new Error("Jev API key is blank");
  // Validated trimmed, so SEND trimmed: a key pasted from a settings textarea carries a
  // trailing newline, and undici rejects a header value containing one.
  const apiKey = config.apiKey.trim();
  // A whitespace-only baseUrl from a settings row must not POST to "" (same-origin).
  const baseUrl = config.baseUrl?.trim() || DEFAULT_JEV_BASE_URL;
  const fetchImpl = config.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = config.timeoutMs ?? JEV_TIMEOUT_MS;

  async function judgeChunk(input: JevJudgeInput): Promise<JevJudgeResult> {
    const keys = input.candidates.map((_, i) => `c${i}`);
    const body = {
      model: JEV_MODEL,
      state: {
        target: {
          title: input.target.title,
          type: input.target.kind,
          // Always present: the question wording references `target.year`; null = unknown
          // (the judge then has nothing to compare and the year rule stays inert).
          year: input.target.year ?? null,
          aliases: input.target.aliases,
        },
        candidates: Object.fromEntries(input.candidates.map((c, i) => [keys[i]!, c.title])),
      },
      questions: buildJevQuestions(input.target, keys),
    };
    let response: Response;
    try {
      response = await fetchImpl(baseUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // undici quotes the offending header VALUE in its message ('Headers.append: "Bearer
      // sk-…" is an invalid header value.'), and this message is persisted verbatim into
      // prefilter.reason in the DB. Only the error name is ever allowed out.
      // A timeout surfaces here too, as name "TimeoutError" (AbortSignal.timeout's reason).
      // The cause code (ECONNREFUSED/ENOTFOUND/…) is a fixed enum — it cannot carry the
      // header value — and it is the one bit that makes a transport failure diagnosable.
      const name = error instanceof Error ? error.name : "unknown";
      const cause = (error as { cause?: { code?: unknown } })?.cause;
      const code = typeof cause?.code === "string" ? ` (${cause.code})` : "";
      throw new Error(`Jev request failed: ${name}${code}`);
    }
    if (!response.ok) throw new Error(`Jev HTTP ${response.status}`);
    let parsed: DecisionsResponse;
    try {
      parsed = (await response.json()) as DecisionsResponse;
    } catch (error) {
      // Only a real parse failure is "invalid JSON". A connection dropped mid-body is a
      // TypeError("terminated"), an aborted read an AbortError — calling those bad JSON
      // sends the next reader hunting a parser bug that does not exist.
      const name = error instanceof Error ? error.name : "unknown";
      throw new Error(name === "SyntaxError" ? "Jev returned invalid JSON" : `Jev request failed: ${name}`);
    }
    // A literal `null` body parses to null; `parsed.answers` would throw a raw TypeError.
    const answers = parsed?.answers;
    if (!answers || typeof answers !== "object") throw new Error("Jev response invalid: no answers");
    const scores: Record<string, number> = {};
    input.candidates.forEach((candidate, i) => {
      const value = answers[keys[i]!]?.noul;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(`Jev response invalid: answer ${keys[i]} is not a 0..1 number`);
      }
      scores[candidate.id] = value;
    });
    const inputTokens = typeof parsed.usage?.input_tokens === "number" ? parsed.usage.input_tokens : undefined;
    const cost = typeof parsed.usage?.cost === "number" ? parsed.usage.cost : undefined;
    return {
      scores,
      model: typeof parsed.model === "string" ? parsed.model : JEV_MODEL,
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(cost === undefined ? {} : { cost }),
    };
  }

  return {
    async judgeCandidates(input) {
      if (input.candidates.length === 0) return { scores: {}, model: JEV_MODEL };
      const chunks: JevJudgeInput[] = [];
      for (let i = 0; i < input.candidates.length; i += JEV_CHUNK_SIZE) {
        chunks.push({ target: input.target, candidates: input.candidates.slice(i, i + JEV_CHUNK_SIZE) });
      }
      // allSettled, not all: a single 429'd chunk must not throw away the chunks that
      // answered. Unscored candidates are kept by the provider, so a partial result costs
      // filtering, never a wrong drop. All chunks failing is still a real failure.
      const settled = await Promise.allSettled(chunks.map((chunk) => judgeChunk(chunk)));
      const fulfilled = settled.filter(
        (s): s is PromiseFulfilledResult<JevJudgeResult> => s.status === "fulfilled",
      );
      const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
      if (fulfilled.length === 0) throw rejected[0]!.reason;
      const lost = settled.reduce(
        (sum, s, i) => (s.status === "rejected" ? sum + chunks[i]!.candidates.length : sum),
        0,
      );
      const merged: JevJudgeResult = { scores: {}, model: fulfilled[0]!.value.model };
      let tokens = 0, cost = 0, sawTokens = false, sawCost = false;
      for (const { value: r } of fulfilled) {
        Object.assign(merged.scores, r.scores);
        if (r.inputTokens !== undefined) { tokens += r.inputTokens; sawTokens = true; }
        if (r.cost !== undefined) { cost += r.cost; sawCost = true; }
      }
      if (sawTokens) merged.inputTokens = tokens;
      if (sawCost) merged.cost = cost;
      if (rejected.length > 0) merged.failedChunks = rejected.length;
      // Defensive: each chunk validates every one of its keys, so a short merge would mean
      // a chunking/merge bug silently shrinking what the agent gets to see.
      if (Object.keys(merged.scores).length !== input.candidates.length - lost) {
        throw new Error("Jev merge invariant violated");
      }
      return merged;
    },
  };
}
