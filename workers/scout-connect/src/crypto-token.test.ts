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
    // Flip a fully-significant middle base64url char deterministically — the
    // final char carries discarded padding bits, so mutating it can be a no-op.
    const mid = Math.floor(wrapped.length / 2);
    const tampered =
      wrapped.slice(0, mid) + (wrapped[mid] === "A" ? "B" : "A") + wrapped.slice(mid + 1);
    await expect(unwrapToken(tampered, KEY_HEX)).rejects.toThrow();
  });

  it("unwrap fails with the wrong key", async () => {
    const wrapped = await wrapToken("s", KEY_HEX);
    await expect(unwrapToken(wrapped, "11".repeat(32))).rejects.toThrow();
  });

  it("wrapToken rejects non-32-byte keys", async () => {
    await expect(wrapToken("x", "00".repeat(16))).rejects.toThrow();
    await expect(wrapToken("x", "0")).rejects.toThrow(); // odd-length hex
  });
});
