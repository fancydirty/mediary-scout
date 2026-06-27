import { describe, expect, it } from "vitest";
import { extractGuangYaTokens, parseTokenPaste, sanitizeToken } from "./guangya-token-paste";

// Invisible chars built from codepoints (reviewable + encoding-stable — never
// embed the literals in source, which is exactly what we strip).
const ZWSP = String.fromCodePoint(0x200b); // zero-width space
const ZWNJ = String.fromCodePoint(0x200c); // zero-width non-joiner
const ZWJ = String.fromCodePoint(0x200d); // zero-width joiner
const BOM = String.fromCodePoint(0xfeff); // byte-order mark

describe("sanitizeToken", () => {
  it("strips surrounding/interior whitespace", () => {
    expect(sanitizeToken("  ey J1  ")).toBe("eyJ1");
  });

  it("strips zero-width and invisible codepoints", () => {
    expect(sanitizeToken(`${BOM}ey${ZWSP}J${ZWNJ}1${ZWJ}`)).toBe("eyJ1");
  });

  it("combines whitespace + zero-width stripping", () => {
    expect(sanitizeToken(`  ey ${ZWSP}J${ZWSP}1  `)).toBe("eyJ1");
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

  it("parses a blob with leading/trailing whitespace around the braces", () => {
    expect(parseTokenPaste('  \n {"accessToken":"AT","refreshToken":"RT"}  ')).toEqual({
      accessToken: "AT",
      refreshToken: "RT",
    });
  });

  it("sanitizes zero-width chars inside the blob tokens", () => {
    expect(
      parseTokenPaste(`{"accessToken":"A${ZWSP}T","refreshToken":"R${ZWNJ}T"}`),
    ).toEqual({ accessToken: "AT", refreshToken: "RT" });
  });

  it("returns null for a bare token string (not JSON)", () => {
    expect(parseTokenPaste("eyJ1.abc.def")).toBeNull();
  });

  it("never throws on a bare (non-{) token — the hot input path", () => {
    expect(() => parseTokenPaste("eyJ1.abc.def")).not.toThrow();
    expect(() => parseTokenPaste("")).not.toThrow();
    // looks JSON-ish at start but is malformed → still no throw, returns null
    expect(() => parseTokenPaste("{not json")).not.toThrow();
    expect(parseTokenPaste("{not json")).toBeNull();
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

describe("extractGuangYaTokens", () => {
  it("handles a camelCase JSON blob", () => {
    expect(extractGuangYaTokens('{"accessToken":"eyJa.b.c","refreshToken":"gy.RT"}')).toEqual({
      accessToken: "eyJa.b.c",
      refreshToken: "gy.RT",
    });
  });

  it("handles a snake_case JSON blob", () => {
    expect(extractGuangYaTokens('{"access_token":"eyJa.b.c","refresh_token":"gy.RT"}')).toEqual({
      accessToken: "eyJa.b.c",
      refreshToken: "gy.RT",
    });
  });

  it("handles the Console-printed labeled block (with trailing noise)", () => {
    const pasted = "accessToken:\neyJabc.def.ghi\n\nrefreshToken:\ngy.RT123\n(已复制到剪贴板)";
    expect(extractGuangYaTokens(pasted)).toEqual({
      accessToken: "eyJabc.def.ghi",
      refreshToken: "gy.RT123",
    });
  });

  it("handles concatenated / newline-collapsed text via heuristic + label", () => {
    expect(extractGuangYaTokens("eyJabc.def.ghirefreshToken:gy.RT123")).toEqual({
      accessToken: "eyJabc.def.ghi",
      refreshToken: "gy.RT123",
    });
  });

  it("does not let a labeled access value swallow a following refresh label", () => {
    // Real-product shape: the onChange sanitize strips ALL whitespace from the
    // pasted Console block BEFORE extract runs, so labels+values are glued:
    // `accessToken:<JWT>refreshToken:gy.<rt>`. The access capture must stop at the
    // next `refreshToken` label, not eat it.
    expect(extractGuangYaTokens("accessToken:eyJabc.def.ghirefreshToken:gy.RT123")).toEqual({
      accessToken: "eyJabc.def.ghi",
      refreshToken: "gy.RT123",
    });
  });

  it("handles two bare lines with no labels (pure heuristic)", () => {
    expect(extractGuangYaTokens("eyJabc.def.ghi\ngy.RT123")).toEqual({
      accessToken: "eyJabc.def.ghi",
      refreshToken: "gy.RT123",
    });
  });

  it("sanitizes zero-width chars inside extracted tokens", () => {
    const pasted = `accessToken: eyJabc.def.ghi\nrefreshToken: gy.${ZWSP}RT${ZWNJ}123`;
    expect(extractGuangYaTokens(pasted)).toEqual({
      accessToken: "eyJabc.def.ghi",
      refreshToken: "gy.RT123",
    });
  });

  it("returns null when only one token is present", () => {
    expect(extractGuangYaTokens("accessToken: eyJabc.def.ghi")).toBeNull();
    expect(extractGuangYaTokens("refreshToken: gy.RT123")).toBeNull();
    expect(extractGuangYaTokens("eyJabc.def.ghi")).toBeNull();
  });

  it("returns null for garbage", () => {
    expect(extractGuangYaTokens("hello world, no tokens here")).toBeNull();
    expect(extractGuangYaTokens("")).toBeNull();
  });

  it("never throws on arbitrary input", () => {
    expect(() => extractGuangYaTokens("{not json")).not.toThrow();
    expect(() => extractGuangYaTokens("random ::: text")).not.toThrow();
  });
});
