import { describe, expect, it } from "vitest";

import { LLM_AUTH_GUIDANCE, describeAgentRunError } from "./agent-error.js";

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

  it("never mentions MiMo in the auth guidance", () => {
    expect(LLM_AUTH_GUIDANCE.toLowerCase()).not.toContain("mimo");
  });

  it("uses the approved agnostic 401 guidance text", () => {
    expect(LLM_AUTH_GUIDANCE).toBe(
      "AI 模型鉴权失败(401):请到 设置 → AI 模型 检查 API Key 是否有效、模型是否有权限(任意 OpenAI 兼容服务,自带 key)。",
    );
  });
});
