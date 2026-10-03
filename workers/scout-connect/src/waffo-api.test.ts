import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  WaffoConfigurationError,
  createWaffoApi,
  isWaffoNotApprovedError,
  validateWaffoConfig,
  type WaffoSdkClient,
} from "./waffo-api.js";

describe("Waffo configuration", () => {
  it("requires the merchant, store, environment, private key, and product ids", () => {
    expect(() => validateWaffoConfig({})).toThrow(WaffoConfigurationError);
    expect(() => validateWaffoConfig({
      merchantId: "MER_4XNDR15LYZPCUbUPbuR6R7",
      storeId: "STO_11zoOG0p1l1qIZIQc9dH5I",
      environment: "test",
      privateKey: "key",
      productQuarter: "quarter",
      productYear: "year",
      productTwoYears: "two-years",
    })).not.toThrow();
  });

  it("accepts only test or prod environments", () => {
    expect(() => validateWaffoConfig({
      merchantId: "merchant",
      storeId: "store",
      environment: "sandbox",
      privateKey: "key",
      productQuarter: "quarter",
      productYear: "year",
      productTwoYears: "two-years",
    })).toThrow(/environment/i);
  });
});

describe("Waffo checkout adapter", () => {
  function realClientConfig() {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    return {
      merchantId: "MER_4XNDR15LYZPCUbUPbuR6R7",
      storeId: "STO_11zoOG0p1l1qIZIQc9dH5I",
      environment: "test" as const,
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      productQuarter: "PROD_Q",
      productYear: "PROD_Y",
      productTwoYears: "PROD_2Y",
    };
  }

  it("rejects a real SDK checkout request when the bounded fetch times out", async () => {
    let sawSignal: AbortSignal | null | undefined;
    const fetchImpl = vi.fn((_input: Request | string | URL, init?: RequestInit) => {
      sawSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const api = createWaffoApi({ ...realClientConfig(), fetch: fetchImpl, timeoutMs: 20 });
    await expect(api.createSession({
      productId: "PROD_Q", successUrl: "http://localhost/payment-success?order=ord_1",
      orderMerchantExternalId: "MC_TIMEOUT", metadata: { orderId: "ord_1" }, expiresInSeconds: 1800,
      language: "zh-Hans", buyerEmail: "buyer@example.com",
    })).rejects.toBeDefined();
    expect(sawSignal).toBeInstanceOf(AbortSignal);
    expect(sawSignal?.aborted).toBe(true);
  });

  it("normalizes a successful response through the real SDK client with a signal", async () => {
    let sawSignal: AbortSignal | null | undefined;
    const fetchImpl = vi.fn(async (_input: Request | string | URL, init?: RequestInit) => {
      sawSignal = init?.signal;
      return new Response(JSON.stringify({ data: {
        checkoutUrl: "https://checkout.test/real", sessionId: "cs_real", expiresAt: "2026-10-02T10:00:00.000Z",
      } }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const api = createWaffoApi({ ...realClientConfig(), fetch: fetchImpl, timeoutMs: 20 });
    await expect(api.createSession({
      productId: "PROD_Q", successUrl: "http://localhost/payment-success?order=ord_1",
      orderMerchantExternalId: "MC_REAL", metadata: { orderId: "ord_1" }, expiresInSeconds: 1800,
      language: "zh-Hans", buyerEmail: "buyer@example.com",
    })).resolves.toMatchObject({ checkoutUrl: "https://checkout.test/real", sessionId: "cs_real" });
    expect(sawSignal).toBeInstanceOf(AbortSignal);
    expect(sawSignal?.aborted).toBe(false);
  });

  it("rejects invalid request timeout values", () => {
    expect(() => createWaffoApi({ ...realClientConfig(), timeoutMs: 0 })).toThrow(WaffoConfigurationError);
    expect(() => createWaffoApi({ ...realClientConfig(), timeoutMs: Number.NaN })).toThrow(WaffoConfigurationError);
  });

  it("passes the exact one-time CNY session parameters to the SDK", async () => {
    const createSession = vi.fn(async () => ({
      checkoutUrl: "https://checkout.test/session",
      sessionId: "cs_test",
      expiresAt: "2026-10-02T10:00:00.000Z",
    }));
    const client: WaffoSdkClient = {
      checkout: { createSession },
      graphql: { query: vi.fn() },
    };
    const api = createWaffoApi({
      merchantId: "merchant",
      storeId: "store",
      environment: "test",
      privateKey: "key",
      productQuarter: "PROD_Q",
      productYear: "PROD_Y",
      productTwoYears: "PROD_2Y",
      client,
    });

    await expect(api.createSession({
      productId: "PROD_Q",
      successUrl: "http://localhost/payment-success?order=ord_1",
      orderMerchantExternalId: "MC_123",
      metadata: { orderId: "ord_1" },
      expiresInSeconds: 1800,
      language: "zh-Hans",
      buyerEmail: "buyer@example.com",
    })).resolves.toEqual({
      checkoutUrl: "https://checkout.test/session",
      sessionId: "cs_test",
      expiresAt: "2026-10-02T10:00:00.000Z",
    });
    expect(createSession).toHaveBeenCalledWith({
      productId: "PROD_Q",
      productType: "onetime",
      currency: "CNY",
      successUrl: "http://localhost/payment-success?order=ord_1",
      orderMerchantExternalId: "MC_123",
      metadata: { orderId: "ord_1" },
      expiresInSeconds: 1800,
      language: "zh-Hans",
      buyerEmail: "buyer@example.com",
    });
  });

  it("accepts only HTTPS checkout URLs from the provider response", async () => {
    const config = {
      merchantId: "merchant", storeId: "store", environment: "test" as const, privateKey: "key",
      productQuarter: "PROD_Q", productYear: "PROD_Y", productTwoYears: "PROD_2Y",
    };
    for (const checkoutUrl of ["javascript:alert(1)", "http://checkout.test/session", "not a URL"]) {
      const client: WaffoSdkClient = {
        checkout: { createSession: vi.fn(async () => ({ checkoutUrl, sessionId: "cs_bad", expiresAt: "2026-10-02T10:00:00.000Z" })) },
        graphql: { query: vi.fn() },
      };
      const api = createWaffoApi({ ...config, client });
      await expect(api.createSession({
        productId: "PROD_Q", successUrl: "http://localhost/payment-success?order=ord_1",
        orderMerchantExternalId: "MC_URL", metadata: { orderId: "ord_1" }, expiresInSeconds: 1800,
        language: "zh-Hans",
      })).rejects.toMatchObject({ code: "WAFFO_INVALID_RESPONSE" });
    }
    const goodClient: WaffoSdkClient = {
      checkout: { createSession: vi.fn(async () => ({ checkoutUrl: "https://checkout.test/session", sessionId: "cs_good", expiresAt: "2026-10-02T10:00:00.000Z" })) },
      graphql: { query: vi.fn() },
    };
    await expect(createWaffoApi({ ...config, client: goodClient }).createSession({
      productId: "PROD_Q", successUrl: "http://localhost/payment-success?order=ord_1",
      orderMerchantExternalId: "MC_URL_GOOD", metadata: { orderId: "ord_1" }, expiresInSeconds: 1800,
      language: "zh-Hans",
    })).resolves.toMatchObject({ checkoutUrl: "https://checkout.test/session" });
  });

  it("rejects a provider session whose expiresAt is not a date", async () => {
    const config = {
      merchantId: "merchant", storeId: "store", environment: "test" as const, privateKey: "key",
      productQuarter: "PROD_Q", productYear: "PROD_Y", productTwoYears: "PROD_2Y",
    };
    for (const expiresAt of ["not a date", "2026-13-45T99:00:00Z", " "]) {
      const client: WaffoSdkClient = {
        checkout: { createSession: vi.fn(async () => ({ checkoutUrl: "https://checkout.test/session", sessionId: "cs_bad", expiresAt })) },
        graphql: { query: vi.fn() },
      };
      await expect(createWaffoApi({ ...config, client }).createSession({
        productId: "PROD_Q", successUrl: "http://localhost/payment-success?order=ord_1",
        orderMerchantExternalId: "MC_EXP", metadata: { orderId: "ord_1" }, expiresInSeconds: 1800,
        language: "zh-Hans",
      })).rejects.toBeInstanceOf(Error);
    }
  });

  it("classifies an unapproved production store error", async () => {
    const error = Object.assign(new Error("Store is not approved for production payments"), {
      status: 403,
      errors: [{ message: "Store is not approved for production payments" }],
    });
    const client: WaffoSdkClient = {
      checkout: { createSession: vi.fn(async () => { throw error; }) },
      graphql: { query: vi.fn() },
    };
    const api = createWaffoApi({
      merchantId: "merchant", storeId: "store", environment: "prod", privateKey: "key",
      productQuarter: "PROD_Q", productYear: "PROD_Y", productTwoYears: "PROD_2Y", client,
    });
    await expect(api.createSession({
      productId: "PROD_Q", successUrl: "https://mediaryconnect.app/payment-success?order=ord_1",
      orderMerchantExternalId: "MC_123", metadata: { orderId: "ord_1" }, expiresInSeconds: 1800,
      language: "zh-Hans", buyerEmail: "buyer@example.com",
    })).rejects.toMatchObject({ code: "WAFFO_STORE_NOT_APPROVED" });
    expect(isWaffoNotApprovedError(error)).toBe(true);
    expect(isWaffoNotApprovedError({ code: "WAFFO_STORE_NOT_APPROVED" })).toBe(true);
  });
});

describe("Waffo webhook and payments adapter", () => {
  it("passes the configured environment explicitly to webhook verification", async () => {
    const verify = vi.fn((_raw: string, _header: string, options: { environment: "prod" | "test" }) => ({
      mode: options.environment,
      eventType: "order.completed",
    }));
    const client: WaffoSdkClient = { checkout: { createSession: vi.fn() }, graphql: { query: vi.fn() } };
    const api = createWaffoApi({
      merchantId: "merchant", storeId: "store", environment: "test", privateKey: "key",
      productQuarter: "PROD_Q", productYear: "PROD_Y", productTwoYears: "PROD_2Y", client,
      verifyWebhook: verify as never,
    });
    await expect(api.verifyWebhook("{\"ok\":1}", "t=1,v1=sig")).resolves.toMatchObject({
      mode: "test",
    });
    expect(verify).toHaveBeenCalledWith("{\"ok\":1}", "t=1,v1=sig", { environment: "test" });
  });

  it("queries payments with store and environment filters", async () => {
    const query = vi.fn(async () => ({
      data: {
        payments: [{ id: "PAY_1", orderId: "ORD_1", status: "succeeded", testMode: true }],
      },
    }));
    const client: WaffoSdkClient = { checkout: { createSession: vi.fn() }, graphql: { query } };
    const api = createWaffoApi({
      merchantId: "merchant", storeId: "store", environment: "test", privateKey: "key",
      productQuarter: "PROD_Q", productYear: "PROD_Y", productTwoYears: "PROD_2Y", client,
    });
    await expect(api.queryPayments("MC_123")).resolves.toEqual([
      { id: "PAY_1", orderId: "ORD_1", status: "succeeded", testMode: true },
    ]);
    expect(query).toHaveBeenCalledWith(expect.objectContaining({
      variables: { storeId: "store", orderMerchantExternalId: "MC_123", testMode: true },
    }));
  });
});
