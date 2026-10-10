import { createOpenAICompatible, type OpenAICompatibleProviderSettings } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

/**
 * The live acquisition agent model factory — a bare OpenAI-compatible
 * LanguageModel that drives the V2 sandbox tool-loop. This was lost in Phase 8
 * (764ae19) when the dead structured-output agent (`ai-sdk-agent.ts`) was deleted
 * wholesale; but the FACTORY is live — `apps/web`'s `getAgentModel` resolves the
 * effective config itself (resolveAgentModelConfig: DB → env → FREE_LLM_PRESET)
 * and builds the model with `createAgentModel(resolved)`; the env factory
 * (createAgentModelFromEnv) mainly serves callers that read env directly — the
 * worker/CLI paths and the §6a interrogation scripts. Restored here as a focused,
 * dependency-light module (no dead agent attached).
 *
 * BYO + model-AGNOSTIC (issue #49): the self-hoster supplies their own
 * OpenAI-compatible endpoint (Settings → AI 模型 / env). For EXPLICIT config
 * `baseURL` + `modelId` are REQUIRED — the factory invents no endpoint of its
 * own. `apiKey` is OPTIONAL: cloud services need it (sent as the `api-key`
 * header); keyless local LLMs (ollama / LM Studio) legitimately omit it.
 *
 * 出厂免费预设（FREE_LLM_PRESET，Kilo Code 公共免费池）：env 三键全空时
 * createAgentModelFromEnv 回落该预设，未配置的自部署实例开箱即用。这取代了
 * 旧的「绝不给默认值」设计（issue #49 反对的是 *静默* 作者默认）：出厂值是
 * 知情显式的 —— 设置页可见、可改、可一键换回，免费档失败文案会点名 Kilo。
 *
 * A bare model (no `response_format`) is all the V2 agent needs — it uses the AI
 * SDK tool-loop with zod inputSchemas, never structured output.
 */

const DEFAULT_PROVIDER_NAME = "agent-model";

/**
 * 出厂免费模型预设（Kilo Code 公共免费模型池，无 key 直连）。值逐字固定 ——
 * 改动要走设计复核并随发版更新（Kilo 下架该模型时换默认值即可修）。baseURL
 * 保持 normalize 后形态（无尾斜杠、无 /chat/completions 后缀），isFreeLlmPreset
 * 按此逐字比较。后续 web 层（设置页预填 / 胶囊 / 失败文案）都从这里取值。
 */
export const FREE_LLM_PRESET: { readonly baseURL: string; readonly modelId: string } = {
  baseURL: "https://api.kilo.ai/api/gateway",
  modelId: "nvidia/nemotron-3-ultra-550b-a55b:free",
};

export interface AgentModelOptions {
  apiKey?: string;
  baseURL?: string;
  modelId?: string;
  providerName?: string;
}

/**
 * Agnostic (model-vendor-neutral) error for an LLM config that cannot build a
 * model: returns a message when `baseURL` or `modelId` is missing/blank, else
 * null. `apiKey` is NOT required (keyless local LLMs are valid). PURE + exported
 * so the fail-fast upstream pre-check reuses the SAME predicate the factory
 * enforces. NEVER mentions a specific provider.
 */
export function llmConfigError(cfg: { apiKey?: string; baseURL?: string; modelId?: string }): string | null {
  const baseURL = (cfg.baseURL ?? "").trim();
  const modelId = (cfg.modelId ?? "").trim();
  if (baseURL === "" || modelId === "") {
    return "未配置 AI 模型。请到「设置 → AI 模型」填写 Base URL 和模型名(任意 OpenAI 兼容服务,自带);云端服务还需 API Key,本地模型可留空。";
  }
  return null;
}

/** Map options onto OpenAI-compatible provider settings. baseURL + modelId are
 *  REQUIRED (no invented default); apiKey is optional (keyless local LLMs). Throws
 *  the agnostic config error as a backstop — the friendly pre-check upstream
 *  catches the same gap first. */
export function createAgentProviderConfig(options: AgentModelOptions = {}): {
  providerSettings: OpenAICompatibleProviderSettings;
  modelId: string;
} {
  const configError = llmConfigError(options);
  if (configError) {
    throw new Error(configError);
  }
  // Trim before building: llmConfigError validates on trimmed values, so the
  // provider must use the trimmed values too (a pasted "  https://x/v1  " would
  // otherwise hit a malformed endpoint).
  //
  // Send the key BOTH ways when present (#49 real root cause):
  //  - `apiKey`  → the provider emits `Authorization: Bearer <key>`. This is how
  //    STANDARD OpenAI-compatible services authenticate — DeepSeek, OpenAI, Groq,
  //    OpenRouter, … — and they IGNORE a custom `api-key` header. Without this a
  //    correctly-configured DeepSeek key still 401s.
  //  - `headers: { "api-key": <key> }` → MiMo / Azure-OpenAI read this header.
  // They coexist safely: the provider merges
  // `{ ...(apiKey && { Authorization }), ...headers }`, and our header key is
  // `api-key` (not `Authorization`), so neither clobbers the other.
  //
  // A blank/whitespace key (e.g. AGENT_MODEL_API_KEY= in .env) → send NEITHER
  // (keyless local LLM — ollama/LM Studio; sending an empty key would 401) (C1).
  const key = options.apiKey?.trim();
  const providerSettings: OpenAICompatibleProviderSettings = {
    name: options.providerName ?? DEFAULT_PROVIDER_NAME,
    baseURL: options.baseURL!.trim(),
    ...(key ? { apiKey: key, headers: { "api-key": key } } : {}),
  };
  return { providerSettings, modelId: options.modelId!.trim() };
}

/** Build the live LanguageModel from explicit options (DB settings). Honors the
 *  user's Settings → AI 模型 config (BYO self-host). Throws the agnostic config
 *  error when baseURL/modelId are missing. */
export function createAgentModel(options: AgentModelOptions = {}): LanguageModel {
  const { providerSettings, modelId } = createAgentProviderConfig(options);
  return createOpenAICompatible(providerSettings)(modelId);
}

/** An env value counts as「没配置」when it is unset OR blank — the shipped
 *  .env.example has three EMPTY-STRING AGENT_MODEL_* keys, and a copied-verbatim
 *  env file must still fall back to the free preset (not throw「未配置」). */
function isBlankEnvValue(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

/**
 * Build the live LanguageModel from env. Reads AGENT_MODEL_* with XIAOMI_MIMO_*
 * as the fallback (back-compat: existing instances that set the legacy keys keep
 * working). Same precedence the web/worker and interrogation use.
 *
 * 出厂回落：三键全空（未设或空串，含 .env.example 形态）时回落
 * FREE_LLM_PRESET（Kilo 免费池），不再抛「未配置」。半截 env（如有 baseURL
 * 没 modelId、或只有 apiKey）行为不变 —— 照旧触发 llmConfigError：那是用户
 * 错误，不该静默变成免费池。回落发生在 llmConfigError 调用之前，后者本体
 * 不动（显式 options 缺值仍 fail-fast）。
 */
export function createAgentModelFromEnv(env: NodeJS.ProcessEnv = process.env): LanguageModel {
  const apiKey = env.AGENT_MODEL_API_KEY ?? env.XIAOMI_MIMO_API_KEY;
  const baseURL = env.AGENT_MODEL_BASE_URL ?? env.XIAOMI_MIMO_BASE_URL;
  const modelId = env.AGENT_MODEL_ID ?? env.XIAOMI_MIMO_MODEL_ID;
  if (isBlankEnvValue(apiKey) && isBlankEnvValue(baseURL) && isBlankEnvValue(modelId)) {
    return createAgentModel(FREE_LLM_PRESET);
  }
  const options: AgentModelOptions = {};
  if (apiKey !== undefined) options.apiKey = apiKey;
  if (baseURL !== undefined) options.baseURL = baseURL;
  if (modelId !== undefined) options.modelId = modelId;
  const { providerSettings, modelId: id } = createAgentProviderConfig(options);
  return createOpenAICompatible(providerSettings)(id);
}

/**
 * Normalize a user-entered OpenAI-compatible base URL. The provider appends
 * `/chat/completions` itself, so a pasted full endpoint (or trailing slashes)
 * must be stripped — otherwise requests hit `…/chat/completions/chat/completions`
 * (404). Empty / whitespace-only → "".
 */
export function normalizeLlmBaseUrl(raw: string): string {
  let s = raw.trim();
  if (!s) return "";
  s = s.replace(/\/+$/, "");
  s = s.replace(/\/chat\/completions$/i, "");
  s = s.replace(/\/+$/, "");
  return s;
}

/**
 * 判定一份 LLM 配置是否（等价于）出厂免费预设：baseURL 过 normalizeLlmBaseUrl、
 * modelId 过 trim 后与 FREE_LLM_PRESET 逐字比较 —— 不做模糊/近名匹配，判定
 * 「免费用了 Kilo」必须精确（它决定胶囊、失败文案、换回按钮的呈现）。任一
 * 输入 blank → false：blank 不是任何确定的配置。设置页与 worker 失败文案
 * （后续任务）都用它区分免费档与用户自带模型。
 */
export function isFreeLlmPreset(cfg: { baseURL?: string; modelId?: string }): boolean {
  const baseURL = normalizeLlmBaseUrl(cfg.baseURL ?? "");
  const modelId = (cfg.modelId ?? "").trim();
  if (baseURL === "" || modelId === "") {
    return false;
  }
  return baseURL === FREE_LLM_PRESET.baseURL && modelId === FREE_LLM_PRESET.modelId;
}

// Invisible codepoints not covered by the regex \s class: zero-width space,
// zero-width non-joiner, zero-width joiner. (NBSP U+00A0 and BOM U+FEFF ARE in \s.)
const INVISIBLE_CODEPOINTS = new Set([0x200b, 0x200c, 0x200d, 0xfeff]);

/**
 * Strip ALL whitespace + invisible characters from a pasted API key (keys are
 * whitespace-free tokens). Defends against web-copy contamination — spaces,
 * tabs, newlines, NBSP, zero-width chars, BOM — that would otherwise silently
 * store a wrong value and make the user think their key is bad. Built from
 * codepoints (no invisible literals in source — those are exactly what we strip).
 */
export function sanitizeLlmApiKey(raw: string): string {
  let out = "";
  for (const ch of raw) {
    if (/\s/.test(ch)) continue;
    if (INVISIBLE_CODEPOINTS.has(ch.codePointAt(0) ?? -1)) continue;
    out += ch;
  }
  return out;
}
