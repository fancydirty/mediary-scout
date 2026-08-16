import { describe, expect, it, vi } from "vitest";
import { createAlipayApi, type AlipayApiOptions } from "./alipay-api.js";
import { type AlipayCryptoKey, verifyAlipayParams } from "./alipay-crypto.js";

interface KeyFixture {
  privateKeyText: string;
  publicKeyText: string;
  privateKey: AlipayCryptoKey;
  publicKey: AlipayCryptoKey;
}

function base64(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64");
}

async function keyFixture(): Promise<KeyFixture> {
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
  return {
    privateKeyText: base64(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    publicKeyText: base64(await crypto.subtle.exportKey("spki", pair.publicKey)),
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
  };
}

async function signedGatewayResponse(
  key: AlipayCryptoKey,
  member: string,
  value: Record<string, unknown>,
): Promise<Response> {
  const content = JSON.stringify(value);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(content),
  );
  return new Response(`{"${member}":${content},"sign":"${base64(signature)}"}`, {
    status: 200,
    headers: { "content-type": "application/json;charset=utf-8" },
  });
}

async function setup(
  handler: (request: Request) => Promise<Response>,
  overrides: Partial<AlipayApiOptions> = {},
): Promise<{ api: Awaited<ReturnType<typeof createAlipayApi>>; keys: KeyFixture }> {
  const keys = await keyFixture();
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    return handler(request);
  }) as typeof fetch;
  const api = await createAlipayApi({
    appId: "2026000000000000",
    privateKeyPem: keys.privateKeyText,
    alipayPublicKeyPem: keys.publicKeyText,
    now: () => new Date("2026-08-16T00:09:10.000Z"),
    fetchImpl,
    ...overrides,
  });
  return { api, keys };
}

describe("Alipay page-pay form", () => {
  it("rejects malformed RSA bindings while payment configuration is initialized", async () => {
    await expect(
      createAlipayApi({
        appId: "2026000000000000",
        privateKeyPem: "not-a-private-key",
        alipayPublicKeyPem: "not-an-alipay-public-key",
      }),
    ).rejects.toThrow();
  });

  it("creates a signed POST form with fixed URLs, timestamp, and escaped values", async () => {
    const { api, keys } = await setup(async () => new Response("unused"));
    const html = await api.pagePayForm({
      outTradeNo: "MC0123456789ABCDEF",
      totalAmount: "45.00",
      subject: 'Mediary Connect 季度"><script>alert(1)</script>',
      notifyUrl: "https://mediaryconnect.app/api/alipay/notify",
      returnUrl: "https://mediaryconnect.app/payment-success?order=ord_abc&from=alipay",
    });

    expect(html).toContain('method="post"');
    expect(html).toContain('action="https://openapi.alipay.com/gateway.do"');
    expect(html).toContain('name="method" value="alipay.trade.page.pay"');
    expect(html).toContain("FAST_INSTANT_TRADE_PAY");
    expect(html).toContain('name="timestamp" value="2026-08-16 08:09:10"');
    expect(html).toContain('name="notify_url" value="https://mediaryconnect.app/api/alipay/notify"');
    expect(html).toContain(
      'name="return_url" value="https://mediaryconnect.app/payment-success?order=ord_abc&amp;from=alipay"',
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("document.forms[0].submit()");

    const inputMatches = [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)];
    const params = new URLSearchParams(
      inputMatches.map(
        (match): [string, string] => [
          match[1]!,
          match[2]!
            .replaceAll("&quot;", '"')
            .replaceAll("&amp;", "&")
            .replaceAll("&lt;", "<")
            .replaceAll("&gt;", ">"),
        ],
      ),
    );
    expect(await verifyAlipayParams(params, keys.publicKey)).toBe(true);
  });

  it("rejects a non-official gateway before producing a form", async () => {
    await expect(
      setup(async () => new Response("unused"), { gatewayUrl: "https://evil.example/gateway.do" }),
    ).rejects.toThrow(/gateway/i);
  });

  it("supports only the official Alipay sandbox gateway when explicitly selected", async () => {
    const { api } = await setup(async () => new Response("unused"), {
      gatewayUrl: "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
    });
    const html = await api.pagePayForm({
      outTradeNo: "MC_SANDBOX",
      totalAmount: "45.00",
      subject: "Mediary Connect 季度",
      returnUrl: "http://localhost:8787/payment-success?order=ord_sandbox",
    });
    expect(html).toContain('action="https://openapi-sandbox.dl.alipaydev.com/gateway.do"');
  });
});

describe("signed Alipay OpenAPI calls", () => {
  it("queries a trade with a signed request and verifies the exact response member", async () => {
    let keys!: KeyFixture;
    const configured = await setup(async (request) => {
      const params = new URLSearchParams(await request.text());
      expect(request.url).toBe("https://openapi.alipay.com/gateway.do");
      expect(request.method).toBe("POST");
      expect(request.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
      expect(params.get("method")).toBe("alipay.trade.query");
      expect(params.get("timestamp")).toBe("2026-08-16 08:09:10");
      expect(await verifyAlipayParams(params, keys.publicKey)).toBe(true);
      return signedGatewayResponse(keys.privateKey, "alipay_trade_query_response", {
        code: "10000",
        msg: "Success",
        out_trade_no: "MC1",
        trade_no: "2026081622000000000001",
        trade_status: "TRADE_SUCCESS",
        total_amount: "45.00",
      });
    });
    keys = configured.keys;

    await expect(configured.api.queryTrade("MC1")).resolves.toMatchObject({
      out_trade_no: "MC1",
      trade_status: "TRADE_SUCCESS",
      total_amount: "45.00",
    });
  });

  it("returns WAIT_BUYER_PAY as a verified non-terminal result", async () => {
    let keys!: KeyFixture;
    const configured = await setup(async () =>
      signedGatewayResponse(keys.privateKey, "alipay_trade_query_response", {
        code: "10000",
        msg: "Success",
        out_trade_no: "MC_WAIT",
        trade_status: "WAIT_BUYER_PAY",
        total_amount: "108.00",
      }),
    );
    keys = configured.keys;
    expect(await configured.api.queryTrade("MC_WAIT")).toMatchObject({
      trade_status: "WAIT_BUYER_PAY",
    });
  });

  it("returns null for a verified not-found business response", async () => {
    let keys!: KeyFixture;
    const configured = await setup(async () =>
      signedGatewayResponse(keys.privateKey, "alipay_trade_query_response", {
        code: "40004",
        msg: "Business Failed",
        sub_code: "ACQ.TRADE_NOT_EXIST",
        sub_msg: "Trade does not exist",
      }),
    );
    keys = configured.keys;
    await expect(configured.api.queryTrade("MC_MISSING")).resolves.toBeNull();
  });

  it("rejects malformed JSON, a bad response signature, and a mismatched order", async () => {
    const malformed = await setup(async () => new Response("not json", { status: 200 }));
    await expect(malformed.api.queryTrade("MC1")).rejects.toThrow(/JSON/i);

    const badSignature = await setup(async () =>
      new Response(
        '{"alipay_trade_query_response":{"code":"10000","out_trade_no":"MC1"},"sign":"AAAA"}',
        { status: 200 },
      ),
    );
    await expect(badSignature.api.queryTrade("MC1")).rejects.toThrow(/signature/i);

    let keys!: KeyFixture;
    const mismatch = await setup(async () =>
      signedGatewayResponse(keys.privateKey, "alipay_trade_query_response", {
        code: "10000",
        out_trade_no: "SOMEONE_ELSE",
        trade_status: "TRADE_SUCCESS",
        total_amount: "45.00",
      }),
    );
    keys = mismatch.keys;
    await expect(mismatch.api.queryTrade("MC1")).rejects.toThrow(/order mismatch/i);
  });

  it("verifies close, refund, and refund-query response contracts", async () => {
    let keys!: KeyFixture;
    const configured = await setup(async (request) => {
      const params = new URLSearchParams(await request.text());
      const method = params.get("method");
      const member = method!.replaceAll(".", "_") + "_response";
      const biz = JSON.parse(params.get("biz_content") ?? "{}") as Record<string, string>;
      if (method === "alipay.trade.close") {
        return signedGatewayResponse(keys.privateKey, member, {
          code: "10000",
          msg: "Success",
          out_trade_no: biz.out_trade_no,
          trade_no: "trade_1",
        });
      }
      if (method === "alipay.trade.refund") {
        return signedGatewayResponse(keys.privateKey, member, {
          code: "10000",
          msg: "Success",
          out_trade_no: biz.out_trade_no,
          trade_no: "trade_1",
          fund_change: "Y",
          refund_fee: biz.refund_amount,
        });
      }
      return signedGatewayResponse(keys.privateKey, member, {
        code: "10000",
        msg: "Success",
        out_trade_no: biz.out_trade_no,
        out_request_no: biz.out_request_no,
        refund_status: "REFUND_SUCCESS",
        refund_amount: "45.00",
      });
    });
    keys = configured.keys;

    await expect(configured.api.closeTrade("MC1")).resolves.toMatchObject({ code: "10000" });
    await expect(
      configured.api.refundTrade({
        outTradeNo: "MC1",
        outRequestNo: "RF1",
        refundAmount: "45.00",
      }),
    ).resolves.toMatchObject({ fund_change: "Y", refund_fee: "45.00" });
    await expect(
      configured.api.queryRefund({ outTradeNo: "MC1", outRequestNo: "RF1" }),
    ).resolves.toMatchObject({ refund_status: "REFUND_SUCCESS", out_request_no: "RF1" });
  });

  it("aborts a hung gateway call at the configured test timeout", async () => {
    const keys = await keyFixture();
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    ) as typeof fetch;
    const api = await createAlipayApi({
      appId: "2026000000000000",
      privateKeyPem: keys.privateKeyText,
      alipayPublicKeyPem: keys.publicKeyText,
      fetchImpl,
      timeoutMs: 5,
    });

    await expect(api.queryTrade("MC_TIMEOUT")).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
