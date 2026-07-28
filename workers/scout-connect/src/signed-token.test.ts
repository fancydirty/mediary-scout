import { describe, expect, it } from "vitest";
import { signToken, verifyToken } from "./signed-token.js";

const KEY = "a".repeat(64); // 32 字节 hex 测试密钥

describe("signed-token (魔法链接 + 取件码共用的 HMAC 自包含凭据)", () => {
  it("round-trips: sign then verify returns the payload", async () => {
    const now = 1_800_000_000_000; // 固定时钟
    const token = await signToken(
      { purpose: "login", subject: "user@example.com" },
      { key: KEY, ttlMs: 60_000, now },
    );
    const result = await verifyToken(token, { key: KEY, now: now + 30_000 });
    expect(result).toEqual({ ok: true, purpose: "login", subject: "user@example.com" });
  });

  it("rejects an expired token", async () => {
    const now = 1_800_000_000_000;
    const token = await signToken(
      { purpose: "login", subject: "user@example.com" },
      { key: KEY, ttlMs: 60_000, now },
    );
    const result = await verifyToken(token, { key: KEY, now: now + 60_001 });
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a tampered payload (signature mismatch)", async () => {
    const now = 1_800_000_000_000;
    const token = await signToken(
      { purpose: "login", subject: "user@example.com" },
      { key: KEY, ttlMs: 60_000, now },
    );
    // 篡改 subject 部分
    const parts = token.split(".");
    const forged = `${parts[0]}.${btoa("evil@example.com").replace(/=+$/, "")}.${parts[2]}.${parts[3]}`;
    const result = await verifyToken(forged, { key: KEY, now });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a token signed with a different key", async () => {
    const now = 1_800_000_000_000;
    const token = await signToken(
      { purpose: "login", subject: "user@example.com" },
      { key: KEY, ttlMs: 60_000, now },
    );
    const result = await verifyToken(token, { key: "b".repeat(64), now });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("purpose mismatch is a rejection — a login token can never act as a claim code", async () => {
    // 决策 #12：魔法链接与取件码共用工具但 purpose 参与签名，不可互换。
    const now = 1_800_000_000_000;
    const loginToken = await signToken(
      { purpose: "login", subject: "user@example.com" },
      { key: KEY, ttlMs: 60_000, now },
    );
    const result = await verifyToken(loginToken, { key: KEY, now, expectPurpose: "claim" });
    expect(result).toEqual({ ok: false, reason: "wrong_purpose" });
  });

  it("verifies purpose when expectPurpose matches", async () => {
    const now = 1_800_000_000_000;
    const claim = await signToken(
      { purpose: "claim", subject: "ep_abc" },
      { key: KEY, ttlMs: 900_000, now },
    );
    const result = await verifyToken(claim, { key: KEY, now, expectPurpose: "claim" });
    expect(result).toEqual({ ok: true, purpose: "claim", subject: "ep_abc" });
  });

  it("rejects a key that is not exactly 32 bytes (weak HMAC guard)", async () => {
    await expect(
      signToken({ purpose: "login", subject: "x" }, { key: "abcd", ttlMs: 1000 }),
    ).rejects.toThrow(/32 bytes/);
  });

  it("rejects a malformed token (wrong part count)", async () => {
    const result = await verifyToken("garbage", { key: KEY, now: 1_800_000_000_000 });
    expect(result).toEqual({ ok: false, reason: "malformed" });
  });

  it("subject with dots survives round-trip (base64url encoded, not naively split)", async () => {
    const now = 1_800_000_000_000;
    const weird = "a.b.c@例子.example";
    const token = await signToken(
      { purpose: "login", subject: weird },
      { key: KEY, ttlMs: 60_000, now },
    );
    const result = await verifyToken(token, { key: KEY, now });
    expect(result).toEqual({ ok: true, purpose: "login", subject: weird });
  });
});
