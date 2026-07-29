import { describe, expect, it } from "vitest";
import { parsePaddleSignature, verifyPaddleSignature } from "./paddle-signature.js";

const SECRET = "pdl_ntfset_test_secret_key_value";
const BODY = '{"event_type":"transaction.completed","data":{"id":"txn_1"}}';

/** 用与实现同款的算法造一个合法签名(测试专用)。 */
async function sign(ts: string, body: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}:${body}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("parsePaddleSignature", () => {
  it("解析 ts 与 h1", () => {
    const r = parsePaddleSignature("ts=1671552777;h1=abc123");
    expect(r).toEqual({ ts: 1671552777, h1: ["abc123"] });
  });

  // 密钥轮换期 Paddle 会同时发多个 h1,任一匹配即通过。
  it("支持多个 h1(密钥轮换)", () => {
    const r = parsePaddleSignature("ts=100;h1=aaa;h1=bbb");
    expect(r?.h1).toEqual(["aaa", "bbb"]);
  });

  it("顺序无关,额外字段忽略", () => {
    const r = parsePaddleSignature("h1=xyz;other=1;ts=42");
    expect(r).toEqual({ ts: 42, h1: ["xyz"] });
  });

  it.each([
    ["", "空串"],
    ["ts=abc;h1=xx", "ts 非数字"],
    ["ts=100", "缺 h1"],
    ["h1=xx", "缺 ts"],
    ["garbage", "无法解析"],
    ["ts=;h1=xx", "ts 为空"],
    ["ts=100;h1=", "h1 为空"],
  ])("畸形头返回 null:%s(%s)", (header) => {
    expect(parsePaddleSignature(header)).toBeNull();
  });
});

describe("verifyPaddleSignature", () => {
  const now = 1_700_000_000_000; // ms

  it("合法签名通过", async () => {
    const ts = String(Math.floor(now / 1000));
    const header = `ts=${ts};h1=${await sign(ts, BODY)}`;
    expect(await verifyPaddleSignature({ rawBody: BODY, header, secret: SECRET, nowMs: now })).toBe(
      true,
    );
  });

  // 签名对象是 `{ts}:{body}`。漏掉 ts: 前缀是最常见的实现错误 ——
  // HMAC 代码完全正确但签名永远对不上。
  it("签名对象必须是 ts:body,只签 body 不通过", async () => {
    const ts = String(Math.floor(now / 1000));
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const bodyOnly = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(BODY));
    const hex = [...new Uint8Array(bodyOnly)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(
      await verifyPaddleSignature({
        rawBody: BODY,
        header: `ts=${ts};h1=${hex}`,
        secret: SECRET,
        nowMs: now,
      }),
    ).toBe(false);
  });

  it("body 被改动则不通过", async () => {
    const ts = String(Math.floor(now / 1000));
    const header = `ts=${ts};h1=${await sign(ts, BODY)}`;
    expect(
      await verifyPaddleSignature({
        rawBody: BODY + " ", // 多一个空格就该失败
        header,
        secret: SECRET,
        nowMs: now,
      }),
    ).toBe(false);
  });

  it("换密钥不通过", async () => {
    const ts = String(Math.floor(now / 1000));
    const header = `ts=${ts};h1=${await sign(ts, BODY, "other_secret")}`;
    expect(await verifyPaddleSignature({ rawBody: BODY, header, secret: SECRET, nowMs: now })).toBe(
      false,
    );
  });

  it("多个 h1 中任一匹配即通过(密钥轮换)", async () => {
    const ts = String(Math.floor(now / 1000));
    const good = await sign(ts, BODY);
    const header = `ts=${ts};h1=${"0".repeat(64)};h1=${good}`;
    expect(await verifyPaddleSignature({ rawBody: BODY, header, secret: SECRET, nowMs: now })).toBe(
      true,
    );
  });

  // 时间窗防重放。放 5 分钟(官方 SDK 默认 5 秒,但 worker 冷启动 + CF 边缘
  // 排队可能有秒级延迟,5 秒太紧会误拒真实投递)。
  it("时间窗内通过,窗外拒绝", async () => {
    const tsSec = Math.floor(now / 1000);
    const header = `ts=${tsSec};h1=${await sign(String(tsSec), BODY)}`;
    const base = { rawBody: BODY, header, secret: SECRET };
    // 4 分钟前的投递仍接受
    expect(await verifyPaddleSignature({ ...base, nowMs: now + 4 * 60_000 })).toBe(true);
    // 6 分钟前的拒绝
    expect(await verifyPaddleSignature({ ...base, nowMs: now + 6 * 60_000 })).toBe(false);
    // 未来太多也拒绝(时钟漂移/伪造)
    expect(await verifyPaddleSignature({ ...base, nowMs: now - 6 * 60_000 })).toBe(false);
  });

  it("畸形头一律拒绝(不抛错)", async () => {
    for (const header of ["", "garbage", "ts=x;h1=y"]) {
      expect(
        await verifyPaddleSignature({ rawBody: BODY, header, secret: SECRET, nowMs: now }),
      ).toBe(false);
    }
  });

  // fail-closed:密钥没配时绝不能"通过验签"。调用方另有 503 处理,
  // 但这一层自身也必须安全。
  it("密钥为空时一律拒绝(fail closed,且不因 WebCrypto 抛错)", async () => {
    const ts = String(Math.floor(now / 1000));
    // 空密钥无法导入 HMAC key(WebCrypto: "Zero-length key is not supported"),
    // 所以这里也造不出合法签名 —— 而这恰恰是重点:实现必须在碰 crypto **之前**
    // 就返回 false,否则空密钥会变成 500 而不是干净的拒绝。
    const header = `ts=${ts};h1=${"a".repeat(64)}`;
    await expect(
      verifyPaddleSignature({ rawBody: BODY, header, secret: "", nowMs: now }),
    ).resolves.toBe(false);
  });

  it("h1 大小写不敏感(hex)", async () => {
    const ts = String(Math.floor(now / 1000));
    const upper = (await sign(ts, BODY)).toUpperCase();
    expect(
      await verifyPaddleSignature({
        rawBody: BODY,
        header: `ts=${ts};h1=${upper}`,
        secret: SECRET,
        nowMs: now,
      }),
    ).toBe(true);
  });
});

describe("契约:任何失败返回 false,绝不抛错", () => {
  const BODY2 = '{"a":1}';

  // Math.abs(NaN - x) > tolerance 恒为 false → 时间窗被静默跳过,重放放行。
  // 这是最隐蔽的一类漏洞:代码看着有检查,实际等于没有。
  it("nowMs 为 NaN 时拒绝(而不是绕过时间窗)", async () => {
    const ts = "1700000000";
    const header = `ts=${ts};h1=${await sign(ts, BODY2)}`;
    expect(
      await verifyPaddleSignature({ rawBody: BODY2, header, secret: SECRET, nowMs: NaN }),
    ).toBe(false);
  });

  it.each([Infinity, -Infinity])("nowMs 为 %s 时拒绝", async (nowMs) => {
    const ts = "1700000000";
    const header = `ts=${ts};h1=${await sign(ts, BODY2)}`;
    expect(await verifyPaddleSignature({ rawBody: BODY2, header, secret: SECRET, nowMs })).toBe(
      false,
    );
  });

  it("toleranceMs 畸形时拒绝(不可放大成无限窗)", async () => {
    const nowMs = 1_700_000_000_000;
    const ts = String(Math.floor(nowMs / 1000));
    const header = `ts=${ts};h1=${await sign(ts, BODY2)}`;
    for (const toleranceMs of [NaN, Infinity, -1]) {
      expect(
        await verifyPaddleSignature({ rawBody: BODY2, header, secret: SECRET, nowMs, toleranceMs }),
        `tolerance=${toleranceMs}`,
      ).toBe(false);
    }
  });

  // 契约是"不抛错"。WebCrypto 对某些输入会抛,必须被吞成 false。
  it("超长密钥等 WebCrypto 异常输入不抛错", async () => {
    const nowMs = 1_700_000_000_000;
    const ts = String(Math.floor(nowMs / 1000));
    const header = `ts=${ts};h1=${"f".repeat(64)}`;
    await expect(
      verifyPaddleSignature({
        rawBody: BODY2,
        header,
        secret: "\u0000".repeat(10),
        nowMs,
      }),
    ).resolves.toBe(false);
  });
});
