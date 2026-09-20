import { describe, expect, it } from "vitest";
import { GuangYaAuthError, Pan115AuthError, Pan115RiskControlError } from "../src/index.js";
import { isBrandStorageAuthError } from "../src/storage-auth-error.js";

describe("isBrandStorageAuthError (品牌网盘鉴权错误 ≠ 落盘失败)", () => {
  it("is true for a 115 auth error (dead cookie)", () => {
    expect(isBrandStorageAuthError(new Pan115AuthError("PAN115_AUTH_FAILED: x", 990001))).toBe(true);
  });

  it("is true for a 光鸭 auth error (dead token)", () => {
    expect(isBrandStorageAuthError(new GuangYaAuthError("GUANGYA_AUTH_FAILED: x"))).toBe(true);
  });

  it("is false for a plain Error — an LLM `Unauthorized` must never freeze the drive", () => {
    expect(isBrandStorageAuthError(new Error("Unauthorized"))).toBe(false);
  });

  it("is false for a 115 risk-control error (budget/circuit — a soft stop, not a dead credential)", () => {
    expect(isBrandStorageAuthError(new Pan115RiskControlError("PAN115_RATE_LIMIT: x"))).toBe(false);
  });

  it("is false for non-Error values", () => {
    expect(isBrandStorageAuthError("PAN115_AUTH_FAILED: a string is not an error")).toBe(false);
    expect(isBrandStorageAuthError(null)).toBe(false);
  });
});
