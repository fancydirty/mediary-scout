import { describe, expect, it } from "vitest";

import {
  LLM_AUTH_GUIDANCE,
  LLM_RATE_LIMIT_GUIDANCE,
  describeAgentRunError,
  summarizeErrorForNotification,
} from "./agent-error.js";

describe("describeAgentRunError", () => {
  it("maps a bare 'Unauthorized' error to the actionable LLM-auth guidance", () => {
    expect(describeAgentRunError(new Error("Unauthorized"))).toBe(LLM_AUTH_GUIDANCE);
  });

  it("maps a 401 status-code APICallError-shaped error to the guidance", () => {
    const apiError = Object.assign(new Error("Request failed"), { statusCode: 401 });
    expect(describeAgentRunError(apiError)).toBe(LLM_AUTH_GUIDANCE);
  });

  it("maps a 403 'Forbidden' error to the guidance", () => {
    expect(describeAgentRunError(new Error("Forbidden"))).toBe(LLM_AUTH_GUIDANCE);
  });

  it("maps an 'invalid api key' message to the guidance", () => {
    expect(describeAgentRunError(new Error("invalid api key"))).toBe(LLM_AUTH_GUIDANCE);
  });

  it("detects an auth failure wrapped in the error cause chain (AI SDK wrapping)", () => {
    const inner = new Error("invalid api key");
    const outer = new Error("model call failed");
    (outer as Error & { cause?: unknown }).cause = inner;
    expect(describeAgentRunError(outer)).toBe(LLM_AUTH_GUIDANCE);
  });

  it("leaves a non-LLM error message unchanged (e.g. a transfer failure)", () => {
    expect(describeAgentRunError(new Error("QUARK_TRANSFER_FAILED: dead share"))).toBe(
      "QUARK_TRANSFER_FAILED: dead share",
    );
  });

  it("returns a stable string for a non-Error value", () => {
    expect(describeAgentRunError("Workflow failed")).toBe("Workflow failed");
  });

  it("maps an 'incorrect api key' message to the guidance", () => {
    expect(describeAgentRunError(new Error("Incorrect API key provided"))).toBe(LLM_AUTH_GUIDANCE);
  });

  // ---- LLM 限流(429) ----
  //
  // issue #229 的真实现场:用户的 123网盘 与 光鸭 两个任务同时报
  // 「Failed after 3 attempts. Last error: Too Many Requests」。两个独立网盘商
  // 不可能同时限流 —— 429 来自它们共同的上游:agent 调用的 LLM。AI SDK 把 429
  // 视为可重试错误(默认 maxRetries: 2 → 共 3 次尝试),全部失败后抛 RetryError,
  // message 就是那句英文。原样透传会让用户以为是网盘或本程序坏了(他因此提了
  // issue),必须给出「这是你的 LLM 渠道在限流」的可操作指引。
  it("maps the AI SDK RetryError text (429 exhausted) to the rate-limit guidance", () => {
    // 这就是 issue #229 用户界面上出现的原文
    expect(
      describeAgentRunError(new Error("Failed after 3 attempts. Last error: Too Many Requests")),
    ).toBe(LLM_RATE_LIMIT_GUIDANCE);
  });

  it("maps a 429 status-code APICallError-shaped error to the rate-limit guidance", () => {
    const apiError = Object.assign(new Error("Too Many Requests"), { statusCode: 429 });
    expect(describeAgentRunError(apiError)).toBe(LLM_RATE_LIMIT_GUIDANCE);
  });

  it("maps a 'rate limit exceeded' message to the rate-limit guidance", () => {
    expect(describeAgentRunError(new Error("Rate limit exceeded"))).toBe(LLM_RATE_LIMIT_GUIDANCE);
  });

  it("maps a 'quota exceeded' message to the rate-limit guidance", () => {
    expect(describeAgentRunError(new Error("RESOURCE_EXHAUSTED: Quota exceeded"))).toBe(
      LLM_RATE_LIMIT_GUIDANCE,
    );
  });

  it("detects a 429 wrapped in the error cause chain (AI SDK wrapping)", () => {
    const inner = Object.assign(new Error("Too Many Requests"), { statusCode: 429 });
    const outer = new Error("Failed after 3 attempts");
    (outer as { cause?: unknown }).cause = inner;
    expect(describeAgentRunError(outer)).toBe(LLM_RATE_LIMIT_GUIDANCE);
  });

  // ---- 绝不把网盘的限流当成 LLM 限流 ----
  //
  // 网盘自己也会限流(115「请求过于频繁」、夸克「访问频繁」),那是网盘侧问题,
  // 指引用户去换 LLM 渠道会把他引向完全错误的方向 —— 与 401 侧同款教训
  // (BRAND_AUTH_MARKERS 的存在原因)。
  it("never maps a 115 rate-limit error to the LLM rate-limit guidance", () => {
    const err = new Error("PAN115_TRANSFER_FAILED: 请求过于频繁，请稍后再试");
    expect(describeAgentRunError(err)).toBe(err.message);
  });

  it("never maps a Quark rate-limit error to the LLM rate-limit guidance", () => {
    const err = new Error("QUARK_TRANSFER_FAILED: 访问频繁");
    expect(describeAgentRunError(err)).toBe(err.message);
  });

  it("never maps a bare Chinese 网盘 throttle message (no brand prefix) to the LLM guidance", () => {
    // 反向验证发现的假覆盖:上面两条靠消息里的品牌名(pan115/quark)就被
    // BRAND_AUTH_MARKERS 挡住了,并没有真的测到「网盘限流短路」。网盘的
    // 转存失败常常只带中文提示、没有品牌前缀 —— 这才是 BRAND_RATE_LIMIT_MARKERS
    // 唯一负责的场景。删掉那份标记表,本用例必须转红。
    const err = new Error("转存失败:请求过于频繁，请稍后再试");
    expect(describeAgentRunError(err)).toBe(err.message);
  });

  it("never maps 「访问频繁」 (bare, no brand prefix) to the LLM guidance", () => {
    const err = new Error("访问频繁，请稍后重试");
    expect(describeAgentRunError(err)).toBe(err.message);
  });

  it("never maps a 网盘 gateway's ENGLISH 429 text to the LLM guidance", () => {
    // 探针实测的真误判:网盘网关也会返回英文 "Too Many Requests"。只看英文文案
    // 会把「转存被网盘限流」判成「你的 LLM 渠道限流」,用户照指引去换模型渠道
    // 完全无效。转存/分享类前缀必须短路 —— 删掉那些标记,本用例转红。
    const err = new Error("转存失败: Too Many Requests (drive gateway)");
    expect(describeAgentRunError(err)).toBe(err.message);
  });

  it("never maps a Chinese throttle carrying English 429 text to the LLM guidance", () => {
    // 同时含中文「频繁」与英文 429 文案 —— 这条能真正区分「中文标记短路」是否生效
    // (纯中文消息本来也不匹配英文 patterns,无法区分)。
    const err = new Error("请求过于频繁 (Too Many Requests)");
    expect(describeAgentRunError(err)).toBe(err.message);
  });

  it("never maps a brand 429 status code to the LLM rate-limit guidance", () => {
    // 网盘 API 自己返回 429 时同样不能改写(品牌标记优先)
    const err = Object.assign(new Error("Pan123AuthError: too many requests"), { statusCode: 429 });
    expect(describeAgentRunError(err)).toBe(err.message);
  });

  it("rate-limit guidance is actionable: names the LLM channel and rules out 网盘/程序", () => {
    expect(LLM_RATE_LIMIT_GUIDANCE).toContain("429");
    expect(LLM_RATE_LIMIT_GUIDANCE).toContain("AI 模型");
    expect(LLM_RATE_LIMIT_GUIDANCE).toContain("网盘");
  });

  it("auth and rate-limit guidance are distinct messages", () => {
    expect(LLM_RATE_LIMIT_GUIDANCE).not.toBe(LLM_AUTH_GUIDANCE);
  });

  it("never mentions MiMo in the auth guidance", () => {
    expect(LLM_AUTH_GUIDANCE.toLowerCase()).not.toContain("mimo");
  });

  it("uses the approved agnostic runtime-401 guidance text", () => {
    expect(LLM_AUTH_GUIDANCE).toBe(
      "AI 模型鉴权失败(401):请到 设置 → AI 模型 检查 API Key 是否有效、模型是否有权限(任意 OpenAI 兼容服务,自带 key)。",
    );
  });
});

// C3 (Copilot #51): the LLM-auth classifier must NOT swallow netdisk (brand) auth
// errors. They carry "401"/"403" in their message (e.g. GUANGYA_AUTH_FAILED: 401
// after refresh) but are a 网盘 token problem, not an AI-模型 problem — showing the
// "AI 模型鉴权失败" guidance for them is misleading.
describe("describeAgentRunError — does NOT misclassify netdisk (brand) auth errors as LLM-auth", () => {
  it("leaves a GuangYa 401 auth error UNCHANGED (not the AI 模型 message)", () => {
    const msg = "GUANGYA_AUTH_FAILED: 401 after refresh (/file/list)";
    expect(describeAgentRunError(new Error(msg))).toBe(msg);
  });

  it("leaves a GuangYa validate 401 error UNCHANGED", () => {
    const msg = "GUANGYA_VALIDATE_FAILED: 401 after refresh";
    expect(describeAgentRunError(new Error(msg))).toBe(msg);
  });

  it("leaves a Quark 403 auth error UNCHANGED", () => {
    const msg = "QUARK_AUTH_FAILED: 需要验证 (code 403)";
    expect(describeAgentRunError(new Error(msg))).toBe(msg);
  });

  it("leaves a Pan115 auth error UNCHANGED", () => {
    const msg = "PAN115_AUTH_FAILED: 登录失效 401";
    expect(describeAgentRunError(new Error(msg))).toBe(msg);
  });

  it("leaves a Tianyi auth error UNCHANGED (dead session ≠ AI 模型 401)", () => {
    const msg = "TIANYI_AUTH_FAILED: InvalidSessionKey (check ip error) 401";
    expect(describeAgentRunError(new Error(msg))).toBe(msg);
  });

  it("leaves a Pan123 auth error UNCHANGED even when the upstream text says 'unauthorized'", () => {
    // Pan123Client throws `PAN123_AUTH_FAILED: ${upstream message}` — the upstream
    // text can carry LLM-looking words; the brand prefix must win.
    const msg = "PAN123_AUTH_FAILED: unauthorized (token 已失效)";
    expect(describeAgentRunError(new Error(msg))).toBe(msg);
  });

  it("leaves a Pan123AuthError with a 401 statusCode UNCHANGED (dead 90-day token ≠ AI 模型 401)", () => {
    const brand = Object.assign(new Error("PAN123_AUTH_FAILED: token expired"), {
      statusCode: 401,
      name: "Pan123AuthError",
    });
    expect(describeAgentRunError(brand)).toBe("PAN123_AUTH_FAILED: token expired");
  });

  it("leaves a TianyiAuthError with a 401 statusCode UNCHANGED (brand prefix wins)", () => {
    const brand = Object.assign(new Error("TIANYI_AUTH_FAILED: session invalid"), {
      statusCode: 401,
      name: "TianyiAuthError",
    });
    expect(describeAgentRunError(brand)).toBe("TIANYI_AUTH_FAILED: session invalid");
  });

  it("leaves a brand auth error with a 401 statusCode UNCHANGED (brand prefix wins)", () => {
    const brand = Object.assign(new Error("GUANGYA_AUTH_FAILED: 401 after refresh"), {
      statusCode: 401,
      name: "GuangYaAuthError",
    });
    expect(describeAgentRunError(brand)).toBe("GUANGYA_AUTH_FAILED: 401 after refresh");
  });

  it("still maps a real AI-SDK 401 (no brand prefix) to the guidance", () => {
    const apiError = Object.assign(new Error("Unauthorized"), { statusCode: 401 });
    expect(describeAgentRunError(apiError)).toBe(LLM_AUTH_GUIDANCE);
  });

  it("does NOT map a bare numeric 401 in an unrelated message to the guidance", () => {
    const msg = "HTTP 401 while fetching subtitle index";
    expect(describeAgentRunError(new Error(msg))).toBe(msg);
  });
});

describe("summarizeErrorForNotification", () => {
  it("keeps a short human provider message intact (the whole point: show the real cause)", () => {
    expect(summarizeErrorForNotification("QUARK_TRANSFER_FAILED: 分享已取消")).toBe(
      "QUARK_TRANSFER_FAILED: 分享已取消",
    );
    expect(summarizeErrorForNotification("夸克登录超时,请重新登录")).toBe("夸克登录超时,请重新登录");
  });

  it("collapses newlines/whitespace into a single line", () => {
    expect(summarizeErrorForNotification("line one\n\n  line   two\t")).toBe("line one line two");
  });

  it("redacts URL userinfo credentials", () => {
    const out = summarizeErrorForNotification("fetch failed https://alice:s3cretPass@drive.quark.cn/x");
    expect(out).toContain("https://***@drive.quark.cn/x");
    expect(out).not.toContain("s3cretPass");
  });

  it("redacts cookie/token/key style assignments but keeps the field name", () => {
    const out = summarizeErrorForNotification("QuarkAuthError access_token=abcdef123456ghijkl");
    expect(out).not.toContain("abcdef123456ghijkl");
    expect(out).toContain("access_token=***");
  });

  it("redacts a bare long opaque secret (>=32 chars)", () => {
    const secret = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const out = summarizeErrorForNotification(`transfer rejected token ${secret} invalid`);
    expect(out).not.toContain(secret);
    expect(out).toContain("***");
    // surrounding human words survive
    expect(out).toContain("transfer rejected token");
    expect(out).toContain("invalid");
  });

  it("truncates an over-long message with an ellipsis (after redaction, never mid-secret)", () => {
    const long = `网络中断 ${"很".repeat(200)}`;
    const out = summarizeErrorForNotification(long);
    expect(out.length).toBeLessThanOrEqual(140);
    expect(out.endsWith("…")).toBe(true);
  });
});
