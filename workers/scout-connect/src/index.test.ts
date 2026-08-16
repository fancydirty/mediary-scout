import { describe, expect, it } from "vitest";
import { resolveAlipayEnvironment } from "./index.js";

describe("Alipay runtime environment guard", () => {
  it("defaults to production and permits sandbox only on local Worker origins", () => {
    expect(resolveAlipayEnvironment("https://mediaryconnect.app/buy", undefined)).toBe(
      "production",
    );
    expect(resolveAlipayEnvironment("http://localhost:8787/buy", "sandbox")).toBe("sandbox");
    expect(resolveAlipayEnvironment("http://127.0.0.1:8787/buy", "sandbox")).toBe("sandbox");
    expect(resolveAlipayEnvironment("https://mediaryconnect.app/buy", "sandbox")).toBeUndefined();
    expect(resolveAlipayEnvironment("https://mediaryconnect.app/buy", "typo")).toBeUndefined();
  });
});
