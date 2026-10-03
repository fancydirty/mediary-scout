import { WaffoPancake, verifyWebhook as sdkVerifyWebhook } from "@waffo/pancake-ts";

export type WaffoEnvironment = "prod" | "test";

// Same bound as the previous Alipay adapter; Waffo normally answers much faster.
export const WAFFO_REQUEST_TIMEOUT_MS = 10_000;

export interface WaffoConfig {
  merchantId: string;
  storeId: string;
  environment: WaffoEnvironment;
  privateKey: string;
  productQuarter: string;
  productYear: string;
  productTwoYears: string;
}

/** Input is deliberately optional so an Env object can be validated fail-closed. */
export interface WaffoConfigInput {
  merchantId?: string;
  storeId?: string;
  environment?: string;
  privateKey?: string;
  productQuarter?: string;
  productYear?: string;
  productTwoYears?: string;
}

export class WaffoConfigurationError extends Error {
  readonly code = "WAFFO_CONFIGURATION_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "WaffoConfigurationError";
  }
}

export class WaffoApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WaffoApiError";
    this.code = code;
  }
}

export class WaffoStoreNotApprovedError extends WaffoApiError {
  constructor() {
    super("WAFFO_STORE_NOT_APPROVED", "Waffo store is not accepting production payments");
    this.name = "WaffoStoreNotApprovedError";
  }
}

export function validateWaffoConfig(input: WaffoConfigInput): WaffoConfig {
  const required = (value: string | undefined, label: string): string => {
    const normalized = value?.trim() ?? "";
    if (normalized === "") throw new WaffoConfigurationError(`Waffo ${label} is not configured`);
    return normalized;
  };
  const environment = input.environment?.trim();
  if (environment !== "prod" && environment !== "test") {
    throw new WaffoConfigurationError("Waffo environment must be prod or test");
  }
  return {
    merchantId: required(input.merchantId, "merchant id"),
    storeId: required(input.storeId, "store id"),
    environment,
    privateKey: required(input.privateKey, "private key"),
    productQuarter: required(input.productQuarter, "quarter product id"),
    productYear: required(input.productYear, "year product id"),
    productTwoYears: required(input.productTwoYears, "two-year product id"),
  };
}

export interface WaffoCheckoutSessionInput {
  productId: string;
  /** Accepted for route-level test seams; the adapter always pins these values. */
  productType?: "onetime";
  currency?: "CNY";
  successUrl: string;
  orderMerchantExternalId: string;
  metadata: Record<string, string>;
  expiresInSeconds: number;
  language: "zh-Hans";
  buyerEmail?: string;
}

export interface WaffoCheckoutSession {
  checkoutUrl: string;
  sessionId: string;
  expiresAt: string;
}

export interface WaffoPaymentAmount {
  amount: string;
  currency: string;
  display: string;
}

export interface WaffoPayment {
  id: string;
  orderId: string;
  status: string;
  amount?: WaffoPaymentAmount;
  refundedAmount?: WaffoPaymentAmount;
  isFullyRefunded?: boolean;
  testMode?: boolean;
  orderMerchantExternalId?: string;
  createdAt?: string;
  [key: string]: unknown;
}

export interface WaffoWebhookEvent<Data extends Record<string, unknown> = Record<string, unknown>> {
  id?: string;
  timestamp?: string;
  eventType: string;
  eventId?: string;
  storeId?: string;
  mode?: string;
  data: Data;
  [key: string]: unknown;
}

export interface WaffoSdkClient {
  checkout: {
    createSession(input: Record<string, unknown>): Promise<unknown>;
  };
  graphql: {
    query(input: {
      query: string;
      variables: Record<string, unknown>;
    }): Promise<{ data?: unknown; errors?: readonly { message?: string }[] }>;
  };
}

export type WaffoWebhookVerifier = (
  rawBody: string,
  signatureHeader: string,
  options: { environment: WaffoEnvironment },
) => WaffoWebhookEvent | Promise<WaffoWebhookEvent>;

export interface CreateWaffoApiOptions extends WaffoConfigInput {
  /** Test seam. Production callers leave this unset so the SDK owns signing. */
  client?: WaffoSdkClient;
  /** Fetch seam for tests and local callers; production uses the global fetch at call time. */
  fetch?: typeof fetch;
  /** Override the request bound for tests; must be finite and positive. */
  timeoutMs?: number;
  /** Test seam for injecting a generated-key verifier; production uses the SDK verifier below. */
  verifyWebhook?: WaffoWebhookVerifier;
}

export const WAFFO_PAYMENTS_QUERY = `
  query WaffoPayments($storeId: String!, $orderMerchantExternalId: String!, $testMode: Boolean!) {
    payments(
      storeId: $storeId
      limit: 20
      offset: 0
      filter: {
        orderMerchantExternalId: { eq: $orderMerchantExternalId }
        testMode: { eq: $testMode }
      }
      orderBy: created_at_desc
    ) {
      id
      orderId
      status
      amount { amount currency display }
      refundedAmount { amount currency display }
      isFullyRefunded
      testMode
      orderMerchantExternalId
      createdAt
    }
  }
`;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WaffoApiError("WAFFO_INVALID_RESPONSE", `Waffo response ${label} is missing`);
  }
  return value;
}

function errorStatus(error: unknown): number | undefined {
  const record = asRecord(error);
  const status = record?.status;
  return typeof status === "number" ? status : undefined;
}

function errorText(error: unknown): string {
  const record = asRecord(error);
  const messages: string[] = [];
  if (typeof error === "string") messages.push(error);
  if (error instanceof Error) messages.push(error.message);
  if (typeof record?.message === "string") messages.push(record.message);
  if (Array.isArray(record?.errors)) {
    for (const nested of record.errors) {
      const nestedRecord = asRecord(nested);
      if (typeof nestedRecord?.message === "string") messages.push(nestedRecord.message);
    }
  }
  return messages.join(" ");
}

export function isWaffoNotApprovedError(error: unknown): boolean {
  if (error instanceof WaffoStoreNotApprovedError) return true;
  const record = asRecord(error);
  if (record?.code === "WAFFO_STORE_NOT_APPROVED") return true;
  if (errorStatus(error) !== 403) return false;
  return /store is not approved for production payments|not accepting payments/i.test(errorText(error));
}

function normalizeSession(value: unknown): WaffoCheckoutSession {
  const record = asRecord(value);
  const checkoutUrl = requiredString(record?.checkoutUrl, "checkoutUrl").trim();
  try {
    if (new URL(checkoutUrl).protocol !== "https:") {
      throw new Error("not HTTPS");
    }
  } catch {
    throw new WaffoApiError("WAFFO_INVALID_RESPONSE", "Waffo response checkoutUrl must be HTTPS");
  }
  const expiresAt = requiredString(record?.expiresAt, "expiresAt").trim();
  // The local order's expiry is read back with Date.parse; a non-date would leave it pending forever.
  if (!Number.isFinite(Date.parse(expiresAt))) {
    throw new WaffoApiError("WAFFO_INVALID_RESPONSE", "Waffo response expiresAt must be a date");
  }
  return {
    checkoutUrl,
    sessionId: requiredString(record?.sessionId, "sessionId"),
    expiresAt,
  };
}

async function defaultWebhookVerifier(
  rawBody: string,
  signatureHeader: string,
  options: { environment: WaffoEnvironment },
): Promise<WaffoWebhookEvent> {
  // The production path intentionally passes only the explicit environment option. The SDK
  // owns the built-in public keys and its default replay tolerance.
  return await (sdkVerifyWebhook as unknown as WaffoWebhookVerifier)(rawBody, signatureHeader, options);
}

export function createWaffoApi(options: CreateWaffoApiOptions): WaffoApi {
  const config = validateWaffoConfig(options);
  const timeoutMs = options.timeoutMs ?? WAFFO_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new WaffoConfigurationError("Waffo request timeout must be finite and positive");
  }
  const baseFetch: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const boundedFetch: typeof fetch = (input, init) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    // init.signal is AbortSignal | null; both null and undefined mean "no caller signal".
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    return baseFetch(input, { ...init, signal });
  };
  const client = options.client ?? (new WaffoPancake({
    merchantId: config.merchantId,
    privateKey: config.privateKey,
    fetch: boundedFetch,
  }) as unknown as WaffoSdkClient);
  const verifier = options.verifyWebhook ?? defaultWebhookVerifier;

  return {
    config,
    async createSession(input): Promise<WaffoCheckoutSession> {
      const request: Record<string, unknown> = {
        productId: input.productId,
        productType: "onetime",
        currency: "CNY",
        successUrl: input.successUrl,
        orderMerchantExternalId: input.orderMerchantExternalId,
        metadata: input.metadata,
        expiresInSeconds: input.expiresInSeconds,
        language: input.language,
      };
      if (input.buyerEmail !== undefined) request.buyerEmail = input.buyerEmail;
      try {
        return normalizeSession(await client.checkout.createSession(request));
      } catch (error) {
        if (isWaffoNotApprovedError(error)) throw new WaffoStoreNotApprovedError();
        throw error;
      }
    },
    async verifyWebhook(rawBody, signatureHeader): Promise<WaffoWebhookEvent> {
      if (typeof signatureHeader !== "string" || signatureHeader.trim() === "") {
        throw new WaffoApiError("WAFFO_INVALID_SIGNATURE", "Waffo webhook signature is missing");
      }
      return verifier(rawBody, signatureHeader, { environment: config.environment });
    },
    async queryPayments(orderMerchantExternalId): Promise<WaffoPayment[]> {
      const result = await client.graphql.query({
        query: WAFFO_PAYMENTS_QUERY,
        variables: {
          storeId: config.storeId,
          orderMerchantExternalId,
          testMode: config.environment === "test",
        },
      });
      if (result.errors !== undefined && result.errors.length > 0) {
        throw new WaffoApiError("WAFFO_GRAPHQL_ERROR", "Waffo payments query failed");
      }
      if (result.data === null || result.data === undefined) {
        throw new WaffoApiError("WAFFO_INVALID_RESPONSE", "Waffo payments response is missing data");
      }
      const data = asRecord(result.data);
      return (data?.payments as WaffoPayment[] | null | undefined) ?? [];
    },
  };
}

export interface WaffoApi {
  readonly config: WaffoConfig;
  createSession(input: WaffoCheckoutSessionInput): Promise<WaffoCheckoutSession>;
  verifyWebhook(rawBody: string, signatureHeader: string): Promise<WaffoWebhookEvent>;
  queryPayments(orderMerchantExternalId: string): Promise<WaffoPayment[]>;
}
