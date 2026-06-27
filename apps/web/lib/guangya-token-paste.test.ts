import { describe, expect, it } from "vitest";
import { parseTokenPaste, sanitizeToken } from "./guangya-token-paste";

describe("sanitizeToken", () => {
  it("strips surrounding/interior whitespace", () => {
    expect(sanitizeToken("  ey J1  ")).toBe("eyJ1");
  });

  it("strips zero-width and invisible codepoints", () => {
    // zero-width space (200b) between J and 1, BOM (feff) leading
    expect(sanitizeToken("﻿ey​J‌1‍")).toBe("eyJ1");
  });

  it("combines whitespace + zero-width stripping", () => {
    expect(sanitizeToken("  ey J​1  ")).toBe("eyJ1");
  });

  it("leaves a clean token untouched", () => {
    expect(sanitizeToken("eyJabc.def")).toBe("eyJabc.def");
  });
});

describe("parseTokenPaste", () => {
  it("splits a camelCase JSON blob into both tokens", () => {
    expect(parseTokenPaste('{"accessToken":"AT","refreshToken":"RT"}')).toEqual({
      accessToken: "AT",
      refreshToken: "RT",
    });
  });

  it("splits a snake_case JSON blob into both tokens", () => {
    expect(parseTokenPaste('{"access_token":"AT","refresh_token":"RT"}')).toEqual({
      accessToken: "AT",
      refreshToken: "RT",
    });
  });

  it("trims whitespace/newlines inside the JSON values", () => {
    expect(
      parseTokenPaste('{\n  "accessToken": "  AT  ",\n  "refreshToken": "\\nRT\\n"\n}'),
    ).toEqual({ accessToken: "AT", refreshToken: "RT" });
  });

  it("sanitizes zero-width chars inside the blob tokens", () => {
    expect(parseTokenPaste('{"accessToken":"A​T","refreshToken":"R‌T"}')).toEqual({
      accessToken: "AT",
      refreshToken: "RT",
    });
  });

  it("returns null for a bare token string (not JSON)", () => {
    expect(parseTokenPaste("eyJ1.abc.def")).toBeNull();
  });

  it("returns null when the JSON is missing refreshToken", () => {
    expect(parseTokenPaste('{"accessToken":"AT"}')).toBeNull();
  });

  it("returns null when the JSON is missing accessToken", () => {
    expect(parseTokenPaste('{"refreshToken":"RT"}')).toBeNull();
  });

  it("returns null for non-object JSON (array)", () => {
    expect(parseTokenPaste('["AT","RT"]')).toBeNull();
  });
});
