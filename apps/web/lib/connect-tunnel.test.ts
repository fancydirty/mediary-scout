import { describe, expect, it } from "vitest";
import { tunnelIdFromToken } from "./connect-tunnel";

const ID = "6f5a3c2e-1b4d-4e8f-9a0b-1c2d3e4f5a6b";
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

describe("tunnelIdFromToken", () => {
  it("reads the tunnel id from a cloudflared token", () => {
    expect(tunnelIdFromToken(encode({ a: "acct", t: ID, s: "c2VjcmV0" }))).toBe(ID);
  });

  it("accepts url-safe base64 and surrounding whitespace", () => {
    const token = encode({ a: "acct", t: ID, s: "c2VjcmV0" }).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(tunnelIdFromToken(`  ${token}\n`)).toBe(ID);
  });

  it("normalizes the id to lower case", () => {
    expect(tunnelIdFromToken(encode({ t: ID.toUpperCase() }))).toBe(ID);
  });

  it("returns null for anything else", () => {
    for (const bad of [undefined, null, "", "not base64 !!", encode({ t: "nope" }), encode({ a: "x" }), encode("str"), Buffer.from("{").toString("base64")]) {
      expect(tunnelIdFromToken(bad)).toBeNull();
    }
  });
});
