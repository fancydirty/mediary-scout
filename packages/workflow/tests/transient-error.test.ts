import { describe, expect, it } from "vitest";
import { isTransientAcquisitionError } from "../src/acquisition-v2/transient-error.js";

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
});
