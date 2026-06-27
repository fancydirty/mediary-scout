import { describe, expect, it } from "vitest";
import { parseTokenPaste, sanitizeToken } from "./guangya-token-paste";

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
