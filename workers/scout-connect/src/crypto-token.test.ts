import { describe, it, expect } from "vitest";
import { sha256Hex, wrapToken, unwrapToken } from "./crypto-token.js";

const KEY_HEX = "00".repeat(32); // test only

describe("crypto-token", () => {
  it("sha256Hex is stable", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("wrap/unwrap roundtrips", async () => {
    const plain = "eyJtest-tunnel-token-value";
    const wrapped = await wrapToken(plain, KEY_HEX);
    expect(wrapped).not.toContain(plain);
    expect(await unwrapToken(wrapped, KEY_HEX)).toBe(plain);
  });

  it("unwrap fails on tamper", async () => {
    const wrapped = await wrapToken("secret", KEY_HEX);
    await expect(unwrapToken(wrapped.slice(0, -2) + "ff", KEY_HEX)).rejects.toThrow();
  });

  it("wrapToken rejects non-32-byte keys", async () => {
    await expect(wrapToken("x", "00".repeat(16))).rejects.toThrow();
    await expect(wrapToken("x", "0")).rejects.toThrow(); // odd-length hex
  });
});
