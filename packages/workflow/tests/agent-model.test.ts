import { describe, expect, it } from "vitest";
import {
  FREE_LLM_PRESET,
  createAgentModel,
  createAgentProviderConfig,
  createAgentModelFromEnv,
  isFreeLlmPreset,
  llmConfigError,
  normalizeLlmBaseUrl,
  sanitizeLlmApiKey,
} from "../src/agent-model.js";

/**
 * The live vercel-ai model factory — RESTORED after Phase 8 (764ae19) deleted it
 * with the dead structured-output agent. It is NOT dead: apps/web `getAgentModel`
 * calls createAgentModelFromEnv for every real (vercel-ai) run, and the §6a
 * interrogation script uses it. Losing it breaks live e2e at runtime even though
 * tsc stayed green (the web typechecked against a stale dist .d.ts).
 *
 * BYO model: the factory is model-AGNOSTIC. Explicit config still requires
 * baseURL + modelId; apiKey is OPTIONAL (keyless local LLMs — ollama/LM Studio
 * — are valid). When env configures NOTHING the env-resolution layer falls back
 * to FREE_LLM_PRESET (Kilo 免费池) — an informed, explicit factory default that
 * is visible/editable in 设置 → AI 模型, not the old silent author default
 * (issue #49 反的是后者).
 */
describe("agent-model — the live OpenAI-compatible (BYO) LanguageModel factory", () => {
  it("maps explicit options onto provider settings (no invented defaults)", () => {
    const { providerSettings, modelId } = createAgentProviderConfig({
      baseURL: "https://example.test/v1",
      modelId: "custom-model",
    });
    expect(modelId).toBe("custom-model");
    expect(providerSettings.name).toBe("agent-model");
    expect(providerSettings.baseURL).toBe("https://example.test/v1");
  });

  // #49 real root cause: the key must go out BOTH ways. Standard OpenAI-compatible
  // providers (DeepSeek/OpenAI/Groq/OpenRouter) authenticate via
  // `Authorization: Bearer <key>`, which @ai-sdk/openai-compatible emits ONLY from
  // the provider's `apiKey` field — they IGNORE the `api-key` header. MiMo/Azure
  // read the `api-key` header. Sending both = universal compatibility.
  it("sends the key BOTH ways when apiKey is set (apiKey→Bearer AND api-key header)", () => {
    const { providerSettings } = createAgentProviderConfig({
      apiKey: "secret",
      baseURL: "https://example.test/v1",
      modelId: "custom-model",
    });
    expect(providerSettings.apiKey).toBe("secret");
    expect(providerSettings.headers).toEqual({ "api-key": "secret" });
  });

  it("omits BOTH apiKey and headers for a keyless local LLM", () => {
    const { providerSettings } = createAgentProviderConfig({
      baseURL: "http://localhost:11434/v1",
      modelId: "qwen2.5",
    });
    expect(providerSettings.apiKey).toBeUndefined();
    expect(providerSettings.headers).toBeUndefined();
  });

  // C1 (Copilot #51): a blank/whitespace apiKey (e.g. AGENT_MODEL_API_KEY= in
  // .env) must NOT send a key at all — neither Bearer nor `api-key: ""` — that
  // breaks keyless local LLMs with an avoidable 401.
  it("omits BOTH apiKey and headers for an EMPTY-STRING apiKey (keyless)", () => {
    const { providerSettings } = createAgentProviderConfig({
      apiKey: "",
      baseURL: "http://localhost:11434/v1",
      modelId: "qwen2.5",
    });
    expect(providerSettings.apiKey).toBeUndefined();
    expect(providerSettings.headers).toBeUndefined();
  });

  it("omits BOTH apiKey and headers for a whitespace-only apiKey (keyless)", () => {
    const { providerSettings } = createAgentProviderConfig({
      apiKey: "   ",
      baseURL: "http://localhost:11434/v1",
      modelId: "qwen2.5",
    });
    expect(providerSettings.apiKey).toBeUndefined();
    expect(providerSettings.headers).toBeUndefined();
  });

  it("trims the key (both Bearer + header), baseURL and modelId before building provider settings", () => {
    const { providerSettings, modelId } = createAgentProviderConfig({
      apiKey: "  secret  ",
      baseURL: "  https://example.test/v1  ",
      modelId: "  custom-model  ",
    });
    expect(providerSettings.apiKey).toBe("secret");
    expect(providerSettings.headers).toEqual({ "api-key": "secret" });
    expect(providerSettings.baseURL).toBe("https://example.test/v1");
    expect(modelId).toBe("custom-model");
  });

  it("throws an agnostic error (no MiMo) when baseURL is missing", () => {
    expect(() => createAgentProviderConfig({ modelId: "x" })).toThrow();
    try {
      createAgentProviderConfig({ modelId: "x" });
    } catch (error) {
      expect((error as Error).message.toLowerCase()).not.toContain("mimo");
    }
  });

  it("throws an agnostic error when modelId is missing", () => {
    expect(() => createAgentModel({ baseURL: "https://example.test/v1" })).toThrow();
  });

  it("builds a model from AGENT_MODEL_* env", () => {
    const model = createAgentModelFromEnv({
      AGENT_MODEL_API_KEY: "k",
      AGENT_MODEL_BASE_URL: "https://example.test/v1",
      AGENT_MODEL_ID: "some-model",
    } as NodeJS.ProcessEnv);
    expect(model).toBeDefined();
    expect((model as { modelId?: string }).modelId).toBe("some-model");
  });

  it("still reads the XIAOMI_MIMO_* env fallback (back-compat for existing instances)", () => {
    const fallback = createAgentModelFromEnv({
      XIAOMI_MIMO_API_KEY: "k2",
      XIAOMI_MIMO_BASE_URL: "https://token-plan-sgp.xiaomimimo.com/v1",
      XIAOMI_MIMO_MODEL_ID: "mimo-v2.5-pro",
    } as NodeJS.ProcessEnv);
    expect((fallback as { modelId?: string }).modelId).toBe("mimo-v2.5-pro");
  });

  // Copilot r2 A：出厂 .env.example 带三个空串 AGENT_MODEL_* 键 —— 部署若同时
  // 保留有值的 XIAOMI_MIMO_*，空 modern 键不能遮蔽 legacy 值。?? 链把空串当
  // 有效值，会让「三键全空→免费预设」判定把 legacy 配置静默换成 Kilo；每对
  // modern/legacy 键必须取第一个非空白值。
  it("blank AGENT_MODEL_* strings do NOT shadow a configured XIAOMI_MIMO_* env (first non-blank wins)", () => {
    const model = createAgentModelFromEnv({
      AGENT_MODEL_BASE_URL: "",
      AGENT_MODEL_ID: "",
      XIAOMI_MIMO_BASE_URL: "https://x/v1",
      XIAOMI_MIMO_MODEL_ID: "m",
    } as NodeJS.ProcessEnv);
    expect((model as { modelId?: string }).modelId).toBe("m");
    const endpoint = (
      model as unknown as {
        config: { url: (o: { path: string }) => string };
      }
    ).config.url({ path: "/chat/completions" });
    expect(endpoint).toBe("https://x/v1/chat/completions");
  });

  // 出厂回落（免费内置模型）：env 三键全空（未设或空串）→ 不再抛「未配置」，
  // 构造 Kilo 免费池模型。@ai-sdk/openai-compatible 把 endpoint 藏在私有
  // config.url 里 —— 从 model 上取它来断言 provider baseURL 真的是 Kilo 网关。
  it("falls back to FREE_LLM_PRESET (Kilo 免费池) when env configures nothing", () => {
    const model = createAgentModelFromEnv({} as NodeJS.ProcessEnv);
    expect((model as { modelId?: string }).modelId).toBe(FREE_LLM_PRESET.modelId);
    expect((model as { modelId?: string }).modelId).toBe(
      "nvidia/nemotron-3-ultra-550b-a55b:free",
    );
    const endpoint = (
      model as unknown as {
        config: { url: (o: { path: string }) => string };
      }
    ).config.url({ path: "/chat/completions" });
    expect(endpoint).toBe("https://api.kilo.ai/api/gateway/chat/completions");
    // 免费池无 key：回落模型不能带任何鉴权头（Kilo 无 key 直连是设计前提）。
    const headers = (
      model as unknown as {
        config: { headers: () => Record<string, string> };
      }
    ).config.headers();
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["api-key"]).toBeUndefined();
  });

  // .env.example 出厂就是三个空串键 —— 复制不改的环境文件是「未配置」的
  // 最常见形态，必须同样回落（空串 = 没配置，不是半截配置）。
  it("falls back when env has the .env.example pattern: three BLANK-STRING keys", () => {
    const model = createAgentModelFromEnv({
      AGENT_MODEL_API_KEY: "",
      AGENT_MODEL_BASE_URL: "",
      AGENT_MODEL_ID: "",
    } as NodeJS.ProcessEnv);
    expect((model as { modelId?: string }).modelId).toBe(FREE_LLM_PRESET.modelId);
  });

  // Copilot r4 High：env 显式配置的 baseURL/modelId 逐字等于 FREE_LLM_PRESET
  // 且带非空 key —— 三键非全空 → 不走回落分支 → key 被拷进 options → 以
  // Authorization Bearer + api-key 两个鉴权头发给 Kilo。web 解析层
  // （resolveAgentModelConfig）已守同一不变量（生效值==预设 → 丢 key），env
  // 直连工厂服务 worker 直连 / CLI / §6a 脚本，必须同样防护：
  // preset-valued configs never carry a key。
  it("drops a residual apiKey when env EXPLICITLY equals the free preset (never send a key to the free pool)", () => {
    const model = createAgentModelFromEnv({
      AGENT_MODEL_API_KEY: "sk-residual",
      AGENT_MODEL_BASE_URL: FREE_LLM_PRESET.baseURL,
      AGENT_MODEL_ID: FREE_LLM_PRESET.modelId,
    } as NodeJS.ProcessEnv);
    expect((model as { modelId?: string }).modelId).toBe(FREE_LLM_PRESET.modelId);
    const endpoint = (
      model as unknown as {
        config: { url: (o: { path: string }) => string };
      }
    ).config.url({ path: "/chat/completions" });
    expect(endpoint).toBe(`${FREE_LLM_PRESET.baseURL}/chat/completions`);
    // 免费池无 key：残留 key 不得以任何鉴权头发给 Kilo。@ai-sdk 2.0.48 会把
    // 头名规范化为小写（authorization），大小写两种形态都要断言到。
    const headers = (
      model as unknown as {
        config: { headers: () => Record<string, string> };
      }
    ).config.headers();
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["authorization"]).toBeUndefined();
    expect(headers["api-key"]).toBeUndefined();
  });

  // 半截 env 是用户错误，不该静默变成免费池（行为与改动前一致）。
  it("still throws on a HALF-configured env (baseURL without modelId)", () => {
    expect(() =>
      createAgentModelFromEnv({
        AGENT_MODEL_BASE_URL: "https://example.test/v1",
      } as NodeJS.ProcessEnv),
    ).toThrow();
  });

  it("still throws on a HALF-configured env (only an apiKey)", () => {
    expect(() =>
      createAgentModelFromEnv({
        AGENT_MODEL_API_KEY: "sk-x",
      } as NodeJS.ProcessEnv),
    ).toThrow();
  });
});

describe("llmConfigError — agnostic, BYO required-config predicate", () => {
  it("flags a missing baseURL", () => {
    expect(llmConfigError({ modelId: "x" })).not.toBeNull();
  });

  it("flags a blank baseURL", () => {
    expect(llmConfigError({ baseURL: "  ", modelId: "x" })).not.toBeNull();
  });

  it("flags a missing modelId", () => {
    expect(llmConfigError({ baseURL: "https://x/v1" })).not.toBeNull();
  });

  it("returns null when baseURL + modelId are present and no apiKey (keyless local LLM OK)", () => {
    expect(llmConfigError({ baseURL: "http://localhost:11434/v1", modelId: "qwen" })).toBeNull();
  });

  it("returns null when all three are present", () => {
    expect(
      llmConfigError({ apiKey: "sk-x", baseURL: "https://x/v1", modelId: "gpt-4o" }),
    ).toBeNull();
  });

  it("never mentions MiMo in the message", () => {
    expect((llmConfigError({}) ?? "").toLowerCase()).not.toContain("mimo");
  });

  // C2 (Copilot #51): clean, user-facing wording.
  it("uses the approved cleaned-up wording", () => {
    expect(llmConfigError({})).toBe(
      "未配置 AI 模型。请到「设置 → AI 模型」填写 Base URL 和模型名(任意 OpenAI 兼容服务,自带);云端服务还需 API Key,本地模型可留空。",
    );
  });
});

describe("FREE_LLM_PRESET — 出厂免费预设（Kilo Code 公共免费池）", () => {
  // 逐字锁定（计划 Global Constraint）：这两个值是设计决策的产物，改动必须走
  // 设计复核并随发版更新 —— 测试钉死防止手滑改错一个字符。
  it("pins the verbatim factory values", () => {
    expect(FREE_LLM_PRESET.baseURL).toBe("https://api.kilo.ai/api/gateway");
    expect(FREE_LLM_PRESET.modelId).toBe("nvidia/nemotron-3-ultra-550b-a55b:free");
  });

  // 预设自身的 baseURL 必须已是 normalize 后形态，isFreeLlmPreset 的逐字比较才自反。
  it("matches itself via isFreeLlmPreset (reflexive)", () => {
    expect(isFreeLlmPreset(FREE_LLM_PRESET)).toBe(true);
  });
});

describe("isFreeLlmPreset — normalize 后逐字比较；blank 输入返回 false", () => {
  it("matches the exact preset", () => {
    expect(
      isFreeLlmPreset({
        baseURL: "https://api.kilo.ai/api/gateway",
        modelId: "nvidia/nemotron-3-ultra-550b-a55b:free",
      }),
    ).toBe(true);
  });

  it("matches baseURL variants that normalize to the preset (trailing slash / /chat/completions / surrounding whitespace)", () => {
    for (const baseURL of [
      "https://api.kilo.ai/api/gateway/",
      "https://api.kilo.ai/api/gateway/chat/completions",
      "  https://api.kilo.ai/api/gateway  ",
    ]) {
      expect(isFreeLlmPreset({ baseURL, modelId: FREE_LLM_PRESET.modelId })).toBe(true);
    }
  });

  it("matches a modelId with surrounding whitespace (trim)", () => {
    expect(
      isFreeLlmPreset({ baseURL: FREE_LLM_PRESET.baseURL, modelId: `  ${FREE_LLM_PRESET.modelId}\t` }),
    ).toBe(true);
  });

  it("does NOT match a different baseURL (no fuzzy matching)", () => {
    expect(
      isFreeLlmPreset({ baseURL: "https://api.kilo.ai/api/gateway-2", modelId: FREE_LLM_PRESET.modelId }),
    ).toBe(false);
    expect(
      isFreeLlmPreset({ baseURL: "https://evil.example/api/gateway", modelId: FREE_LLM_PRESET.modelId }),
    ).toBe(false);
  });

  it("does NOT match a different modelId (no fuzzy matching)", () => {
    expect(
      isFreeLlmPreset({ baseURL: FREE_LLM_PRESET.baseURL, modelId: "kilo-auto/free" }),
    ).toBe(false);
    expect(
      isFreeLlmPreset({ baseURL: FREE_LLM_PRESET.baseURL, modelId: "nvidia/nemotron-3-ultra-550b-a55b:free-2" }),
    ).toBe(false);
  });

  it("returns false for blank input (missing fields / empty / whitespace-only)", () => {
    expect(isFreeLlmPreset({})).toBe(false);
    expect(isFreeLlmPreset({ baseURL: "", modelId: "" })).toBe(false);
    expect(isFreeLlmPreset({ baseURL: "   ", modelId: "   " })).toBe(false);
    expect(isFreeLlmPreset({ baseURL: FREE_LLM_PRESET.baseURL, modelId: "" })).toBe(false);
    expect(isFreeLlmPreset({ baseURL: "", modelId: FREE_LLM_PRESET.modelId })).toBe(false);
  });
});

describe("normalizeLlmBaseUrl — provider appends /chat/completions itself", () => {
  it.each([
    ["https://x/v1/chat/completions", "https://x/v1"],
    ["https://x/v1/chat/completions/", "https://x/v1"],
    ["https://x/v1/", "https://x/v1"],
    ["https://x/v1", "https://x/v1"],
    ["  https://x/v1  ", "https://x/v1"],
    ["", ""],
    ["   ", ""],
  ])("normalizes %j -> %j", (input, expected) => {
    expect(normalizeLlmBaseUrl(input)).toBe(expected);
  });
});

describe("sanitizeLlmApiKey — strips paste contamination (keys are whitespace-free)", () => {
  it.each([
    ["tp-abc", "tp-abc"],
    [" tp-abc ", "tp-abc"],
    ["tp- ab\tc\n", "tp-abc"],
    ["", ""],
  ])("strips ASCII whitespace from %j", (input, expected) => {
    expect(sanitizeLlmApiKey(input)).toBe(expected);
  });

  it("strips invisible chars: NBSP, zero-width space, BOM (built from codepoints)", () => {
    const nbsp = String.fromCharCode(0x00a0);
    const zwsp = String.fromCharCode(0x200b);
    const bom = String.fromCharCode(0xfeff);
    const contaminated = `tp-${nbsp}ab${zwsp}c${bom}`;
    expect(contaminated.length).toBeGreaterThan("tp-abc".length);
    expect(sanitizeLlmApiKey(contaminated)).toBe("tp-abc");
  });
});
