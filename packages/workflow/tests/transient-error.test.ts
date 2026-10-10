import { describe, expect, it } from "vitest";
import {
  extractHttpStatus,
  isTransientAcquisitionError,
} from "../src/acquisition-v2/transient-error.js";

describe("isTransientAcquisitionError", () => {
  it("matches connection-class errors", () => {
    for (const msg of [
      "Cannot connect to API: Client network socket disconnected before secure TLS connection was established",
      "fetch failed",
      "read ECONNRESET",
      "connect ETIMEDOUT 1.2.3.4:443",
      "connect ECONNREFUSED",
      "getaddrinfo ENOTFOUND webapi.115.com",
      "getaddrinfo EAI_AGAIN api.example.com",
      "socket hang up",
    ]) {
      expect(isTransientAcquisitionError(new Error(msg)), msg).toBe(true);
    }
  });

  it("matches AI SDK RetryError wrapping a connection error", () => {
    const err = new Error(
      "Failed after 3 attempts. Last error: Cannot connect to API: Client network socket disconnected",
    );
    err.name = "AI_RetryError";
    expect(isTransientAcquisitionError(err)).toBe(true);
  });

  it("recurses into error.cause", () => {
    const inner = new Error("read ECONNRESET");
    const outer = new Error("acquisition step failed");
    (outer as Error & { cause?: unknown }).cause = inner;
    expect(isTransientAcquisitionError(outer)).toBe(true);
  });

  it("is false for non-transient failures", () => {
    expect(isTransientAcquisitionError(new Error("no coverage found"))).toBe(false);
    expect(isTransientAcquisitionError(new Error("validation failed: bad title"))).toBe(false);
    expect(isTransientAcquisitionError(new Error("agent gave up after max steps"))).toBe(false);
    expect(isTransientAcquisitionError("a plain string")).toBe(false);
    expect(isTransientAcquisitionError(undefined)).toBe(false);
  });

  // ---- HTTP 限流/服务端波动（免费池 Kilo 高峰 429/5xx，2026-10）----
  //
  // 免费池高峰的 429/5xx 会以传输层错误冒出来（AI SDK RetryError 的 message、
  // 网关直出的状态码短语）。它们与 socket 断连同类：等 1/5/15 分钟再跑大概率
  // 就好，所以必须走自动退避重排，而不是终止失败。
  it("matches HTTP throttle / server-fluctuation errors (429 / 5xx)", () => {
    for (const msg of [
      "Request failed with status code 429",
      "Failed after 3 attempts. Last error: Too Many Requests",
      "rate limit exceeded, retry after 60s",
      "Service Unavailable (HTTP 503)",
      "503 Bad Gateway from upstream",
      "Request failed with status code 500",
      "502 Bad Gateway from upstream",
      "504 Gateway Timeout",
    ]) {
      expect(isTransientAcquisitionError(new Error(msg)), msg).toBe(true);
    }
  });

  it("detects a 429 wrapped in the error cause chain (AI SDK wrapping)", () => {
    const inner = new Error("Too Many Requests");
    const outer = new Error("Failed after 3 attempts");
    (outer as { cause?: unknown }).cause = inner;
    expect(isTransientAcquisitionError(outer)).toBe(true);
  });

  // Copilot r2 D：AI SDK 的 APICallError 把 HTTP 状态码放在数值字段 statusCode
  // 上，message 可能完全不含数字（如 "Request failed"）—— 只扫文本会漏退避。
  it("matches a numeric statusCode even when the message has no code (AI SDK APICallError shape)", () => {
    expect(isTransientAcquisitionError({ statusCode: 503, message: "Request failed" })).toBe(true);
    const err = new Error("Request failed");
    (err as Error & { statusCode?: number }).statusCode = 503;
    expect(isTransientAcquisitionError(err)).toBe(true);
    const responseStatusOnly = new Error("Request failed");
    (responseStatusOnly as Error & { responseStatus?: number }).responseStatus = 429;
    expect(isTransientAcquisitionError(responseStatusOnly)).toBe(true);
  });

  it("is FALSE for a numeric statusCode that is not transient (404 model retired)", () => {
    expect(isTransientAcquisitionError({ statusCode: 404, message: "Request failed" })).toBe(false);
    const err = new Error("Request failed");
    (err as Error & { statusCode?: number }).statusCode = 404;
    expect(isTransientAcquisitionError(err)).toBe(false);
  });

  it("checks the numeric statusCode at every cause-chain node", () => {
    const inner = new Error("Request failed");
    (inner as Error & { statusCode?: number }).statusCode = 429;
    const outer = new Error("AI_CallError: request aborted");
    (outer as { cause?: unknown }).cause = inner;
    expect(isTransientAcquisitionError(outer)).toBe(true);
  });

  // 404 / model-not-found 绝不是瞬时错：模型下架（免费池换模型）重试也不会好，
  // 必须终止失败走 fail-loud 文案（worker 侧另有「内置免费模型已失效」指引）。
  it("is FALSE for 404 / model-not-found (model retired is not transient)", () => {
    for (const msg of [
      "Model not found: nvidia/nemotron-3-ultra-550b-a55b:free",
      "Request failed with status code 404",
      "no such model on this gateway",
    ]) {
      expect(isTransientAcquisitionError(new Error(msg)), msg).toBe(false);
    }
  });

  // ---- Copilot r3 A：501（Not Implemented）是服务端配置/实现问题，永久错误 ——
  //
  // 数值分支原来写成 500≤code<600，把 501 也吞进去 —— 同一个 501，带在
  // statusCode 上进退避队列、写在 message 里却终止，同错不同形不同命。现在
  // 数值与文本两侧都排除 501。
  it("is FALSE for a numeric statusCode 501 (Not Implemented is permanent, never requeued)", () => {
    expect(isTransientAcquisitionError({ statusCode: 501, message: "Not Implemented" })).toBe(false);
    const err = new Error("Request failed");
    (err as Error & { statusCode?: number }).statusCode = 501;
    expect(isTransientAcquisitionError(err)).toBe(false);
  });

  it("still requeues numeric statusCode 503 (regression: the 501 carve-out must not swallow the 5xx band)", () => {
    expect(isTransientAcquisitionError({ statusCode: 503, message: "Request failed" })).toBe(true);
    const responseStatusOnly = new Error("Request failed");
    (responseStatusOnly as Error & { responseStatus?: number }).responseStatus = 503;
    expect(isTransientAcquisitionError(responseStatusOnly)).toBe(true);
  });

  // ---- Copilot r3 B：message-only 5xx 全段（Cloudflare 520/522/524 带）——
  //
  // 文本匹配原来只枚举 "500"/"502"/"503"/"504" 子串，message 含 "HTTP 520"
  // （Cloudflare 网关常见 520/522/524）不匹配 → 不退避。现在改为词边界正则
  // 提取独立三位 5xx token，同样排除 501。
  it("matches any standalone 3-digit 5xx token in the message (520/522/524 Cloudflare band)", () => {
    for (const msg of [
      "HTTP 520 from gateway",
      "HTTP 522 Connection timed out (Cloudflare)",
      "Origin error 524",
    ]) {
      expect(isTransientAcquisitionError(new Error(msg)), msg).toBe(true);
    }
  });

  it("is FALSE for a message whose only 5xx token is 501 (message side mirrors the numeric carve-out)", () => {
    expect(isTransientAcquisitionError(new Error("HTTP 501"))).toBe(false);
  });

  it("is FALSE for longer numbers that merely contain 5xx digits (word boundaries)", () => {
    expect(isTransientAcquisitionError(new Error("fileId 50345 not found"))).toBe(false);
    expect(isTransientAcquisitionError(new Error("任务 5030 号处理失败"))).toBe(false);
  });

  it("treats a standalone 503 inside business text as transient — the documented bounded cost", () => {
    // 有界代价的如实断言：「任务 503 处理失败」的 503 是独立三位 token → 退避。
    // 最多多吃 3 次 1/5/15min 退避后仍会终止失败，不会把失败藏成永久重试
    // （见实现侧注释的保守性论证）。
    expect(isTransientAcquisitionError(new Error("任务 503 处理失败"))).toBe(true);
  });

  // ---- Copilot r3 C：状态提取 helper 的契约（transient 与 agent-error 共用）----
  it("extractHttpStatus reads statusCode and responseStatus (statusCode wins), null otherwise", () => {
    expect(extractHttpStatus({ statusCode: 503 })).toBe(503);
    expect(extractHttpStatus({ responseStatus: 429 })).toBe(429);
    expect(extractHttpStatus({ statusCode: 503, responseStatus: 500 })).toBe(503);
    expect(extractHttpStatus(new Error("no status fields"))).toBeNull();
    expect(extractHttpStatus("HTTP 500")).toBeNull();
    expect(extractHttpStatus(null)).toBeNull();
    expect(extractHttpStatus(undefined)).toBeNull();
  });
});
