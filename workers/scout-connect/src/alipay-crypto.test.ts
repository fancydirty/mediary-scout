import { describe, expect, it } from "vitest";
import {
  type AlipayCryptoKey,
  importAlipayPrivateKey,
  importAlipayPublicKey,
  signAlipayParams,
  verifyAlipayParams,
} from "./alipay-crypto.js";

function base64(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64");
}

async function rsaFixture(): Promise<{
  privateKeyText: string;
  publicKeyText: string;
  privateKey: AlipayCryptoKey;
}> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as { privateKey: AlipayCryptoKey; publicKey: AlipayCryptoKey };
  const privateKeyText = base64(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const publicKeyText = base64(await crypto.subtle.exportKey("spki", pair.publicKey));
  return { privateKeyText, publicKeyText, privateKey: pair.privateKey };
}

function paramsFromRecord(values: Record<string, string>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) params.set(key, value);
  return params;
}

describe("Alipay RSA2 parameter signing", () => {
  it("signs request parameters with sign_type and verifies the exact values", async () => {
    const keys = await rsaFixture();
    const privateKey = await importAlipayPrivateKey(keys.privateKeyText);
    const publicKey = await importAlipayPublicKey(keys.publicKeyText);
    const signed = await signAlipayParams(
      {
        method: "alipay.trade.query",
        app_id: "2026000000000000",
        biz_content: '{"out_trade_no":"MC1"}',
      },
      privateKey,
    );

    expect(signed.params.sign_type).toBe("RSA2");
    expect(signed.canonical).toBe(
      'app_id=2026000000000000&biz_content={"out_trade_no":"MC1"}&method=alipay.trade.query&sign_type=RSA2',
    );
    expect(signed.params.sign).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(await verifyAlipayParams(signed.params, publicKey)).toBe(true);

    const tampered = { ...signed.params, biz_content: '{"out_trade_no":"MC2"}' };
    expect(await verifyAlipayParams(tampered, publicKey)).toBe(false);
  });

  it("verifies the legacy notify shape that excludes sign_type from signed content", async () => {
    const keys = await rsaFixture();
    const publicKey = await importAlipayPublicKey(keys.publicKeyText);
    const values = {
      app_id: "2026000000000000",
      out_trade_no: "MC1",
      sign_type: "RSA2",
      total_amount: "45.00",
      trade_status: "TRADE_SUCCESS",
    };
    const canonical =
      "app_id=2026000000000000&out_trade_no=MC1&total_amount=45.00&trade_status=TRADE_SUCCESS";
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keys.privateKey,
      new TextEncoder().encode(canonical),
    );
    const params = paramsFromRecord({ ...values, sign: base64(signature) });

    expect(await verifyAlipayParams(params, publicKey)).toBe(true);
  });

  it("fails closed for missing RSA2 metadata and malformed signatures", async () => {
    const keys = await rsaFixture();
    const publicKey = await importAlipayPublicKey(keys.publicKeyText);

    await expect(
      verifyAlipayParams({ app_id: "app", sign_type: "RSA2", sign: "not-base64!" }, publicKey),
    ).resolves.toBe(false);
    await expect(verifyAlipayParams({ app_id: "app", sign: "AAAA" }, publicKey)).resolves.toBe(
      false,
    );
  });

  it("accepts standard PEM wrappers without persisting a transformed key", async () => {
    const keys = await rsaFixture();
    const privatePem = `-----BEGIN PRIVATE KEY-----\n${keys.privateKeyText}\n-----END PRIVATE KEY-----`;
    const publicPem = `-----BEGIN PUBLIC KEY-----\n${keys.publicKeyText}\n-----END PUBLIC KEY-----`;
    const signed = await signAlipayParams(
      { app_id: "app", method: "alipay.trade.close" },
      await importAlipayPrivateKey(privatePem),
    );

    expect(await verifyAlipayParams(signed.params, await importAlipayPublicKey(publicPem))).toBe(
      true,
    );
  });
});
