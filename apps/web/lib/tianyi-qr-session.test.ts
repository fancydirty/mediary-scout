import { describe, expect, it } from "vitest";
import { validateTianyiQrSession, validateTianyiRedirectUrl } from "./tianyi-qr-session";

const base = {
  uuid: "uuid-1",
  paramId: "p-1",
  reqId: "r-1",
  lt: "lt-1",
  cookies: [["JSESSIONID", "abc"]] as Array<[string, string]>,
};

describe("validateTianyiQrSession", () => {
  it("accepts a well-formed session", () => {
    expect(validateTianyiQrSession(base).ok).toBe(true);
  });

  it("rejects non-objects and arrays", () => {
    expect(validateTianyiQrSession(null).ok).toBe(false);
    expect(validateTianyiQrSession("x").ok).toBe(false);
    expect(validateTianyiQrSession([]).ok).toBe(false);
  });

  it("rejects a missing/empty required field", () => {
    expect(validateTianyiQrSession({ ...base, uuid: "" }).ok).toBe(false);
    const { lt: _lt, ...noLt } = base;
    expect(validateTianyiQrSession(noLt).ok).toBe(false);
  });

  it("rejects cookies that are not [name,value] string pairs", () => {
    expect(validateTianyiQrSession({ ...base, cookies: "nope" }).ok).toBe(false);
    expect(validateTianyiQrSession({ ...base, cookies: [["only-one"]] }).ok).toBe(false);
    expect(validateTianyiQrSession({ ...base, cookies: [[1, 2]] }).ok).toBe(false);
  });

  it("rejects a cookie carrying CR/LF (header injection) or ; (cookie separator)", () => {
    expect(validateTianyiQrSession({ ...base, cookies: [["a", "b\r\nInjected: x"]] }).ok).toBe(false);
    expect(validateTianyiQrSession({ ...base, cookies: [["a\n", "b"]] }).ok).toBe(false);
    expect(validateTianyiQrSession({ ...base, cookies: [["a", "b; c=d"]] }).ok).toBe(false);
  });

  it("rejects an oversized cookie jar", () => {
    const many = Array.from({ length: 65 }, (_, i) => [`k${i}`, "v"] as [string, string]);
    expect(validateTianyiQrSession({ ...base, cookies: many }).ok).toBe(false);
  });
});

describe("validateTianyiRedirectUrl", () => {
  it("accepts an https url within the length cap", () => {
    expect(validateTianyiRedirectUrl("https://cloud.189.cn/r?x=1").ok).toBe(true);
  });
  it("rejects non-strings, empty, non-https, and oversized", () => {
    expect(validateTianyiRedirectUrl(undefined).ok).toBe(false);
    expect(validateTianyiRedirectUrl("").ok).toBe(false);
    expect(validateTianyiRedirectUrl("http://cloud.189.cn/r").ok).toBe(false);
    expect(validateTianyiRedirectUrl("https://" + "a".repeat(2048)).ok).toBe(false);
  });
});
