// packages/workflow/src/jev-client.ts
import { buildJevQuestions, type JevJudge, type JevJudgeInput, type JevJudgeResult } from "./jev-judge.js";

/** OpenRouter's decisions router for TypeSafe Jev. The chat/completions endpoint
 *  rejects this model (400 "decisions model"); this alpha route speaks the native
 *  {state, questions} → {answers} shape. */
export const DEFAULT_JEV_BASE_URL = "https://openrouter.ai/api/alpha/decisions";
export const JEV_MODEL = "jev-latest";
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
  const baseUrl = (config.baseUrl ?? DEFAULT_JEV_BASE_URL).trim();
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
    const response = await fetchImpl(baseUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Jev HTTP ${response.status}`);
    let parsed: DecisionsResponse;
    try {
      parsed = (await response.json()) as DecisionsResponse;
    } catch {
      throw new Error("Jev returned invalid JSON");
    }
    const answers = parsed.answers;
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
      const results = await Promise.all(chunks.map(judgeChunk));
      const merged: JevJudgeResult = { scores: {}, model: results[0]!.model };
      let tokens = 0, cost = 0, sawTokens = false, sawCost = false;
      for (const r of results) {
        Object.assign(merged.scores, r.scores);
        if (r.inputTokens !== undefined) { tokens += r.inputTokens; sawTokens = true; }
        if (r.cost !== undefined) { cost += r.cost; sawCost = true; }
      }
      if (sawTokens) merged.inputTokens = tokens;
      if (sawCost) merged.cost = cost;
      return merged;
    },
  };
}
