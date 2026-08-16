import {
  importAlipayPrivateKey,
  importAlipayPublicKey,
  signAlipayParams,
  verifyAlipayContent,
  verifyAlipayParams,
} from "./alipay-crypto.js";
import { normalizeAlipayAmount } from "./alipay-order.js";

export const ALIPAY_PRODUCTION_GATEWAY = "https://openapi.alipay.com/gateway.do";
export const ALIPAY_SANDBOX_GATEWAY = "https://openapi-sandbox.dl.alipaydev.com/gateway.do";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface PagePayInput {
  outTradeNo: string;
  totalAmount: string;
  subject: string;
  notifyUrl?: string;
  returnUrl: string;
}

export interface AlipayGatewayResult {
  code: string;
  msg?: string;
  sub_code?: string;
  sub_msg?: string;
}

export interface AlipayTradeResult extends AlipayGatewayResult {
  out_trade_no: string;
  trade_no?: string;
  trade_status: string;
  total_amount?: string;
  send_pay_date?: string;
}

export interface AlipayCloseResult extends AlipayGatewayResult {
  out_trade_no?: string;
  trade_no?: string;
}

export interface AlipayRefundResult extends AlipayGatewayResult {
  out_trade_no?: string;
  trade_no?: string;
  fund_change?: "Y" | "N";
  refund_fee?: string;
}

export interface AlipayRefundQueryResult extends AlipayGatewayResult {
  out_trade_no: string;
  trade_no?: string;
  out_request_no: string;
  refund_status?: string;
  refund_amount?: string;
  total_amount?: string;
}

export interface AlipayApi {
  pagePayForm(input: PagePayInput): Promise<string>;
  queryTrade(outTradeNo: string): Promise<AlipayTradeResult | null>;
  closeTrade(outTradeNo: string): Promise<AlipayCloseResult>;
  refundTrade(input: {
    outTradeNo: string;
    outRequestNo: string;
    refundAmount: string;
  }): Promise<AlipayRefundResult>;
  queryRefund(input: {
    outTradeNo: string;
    outRequestNo: string;
  }): Promise<AlipayRefundQueryResult | null>;
  verifyNotification(params: URLSearchParams): Promise<boolean>;
}

export interface AlipayApiOptions {
  appId: string;
  privateKeyPem: string;
  alipayPublicKeyPem: string;
  gatewayUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

function assertGateway(value: string): string {
  if (value !== ALIPAY_PRODUCTION_GATEWAY && value !== ALIPAY_SANDBOX_GATEWAY) {
    throw new Error("Alipay gateway must be an official HTTPS gateway");
  }
  return value;
}

function formatAlipayTimestamp(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function responseMemberFor(method: string): string {
  return `${method.replaceAll(".", "_")}_response`;
}

/** Extract a JSON object byte-for-byte so signature verification does not reserialize it. */
function extractJsonObjectMember(raw: string, key: string): string | null {
  const marker = `"${key}"`;
  const markerAt = raw.indexOf(marker);
  if (markerAt < 0) return null;
  let index = markerAt + marker.length;
  while (/\s/.test(raw[index] ?? "")) index += 1;
  if (raw[index] !== ":") return null;
  index += 1;
  while (/\s/.test(raw[index] ?? "")) index += 1;
  if (raw[index] !== "{") return null;
  const start = index;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return raw.slice(start, index + 1);
  }
  return null;
}

function assertMatchingAmount(expected: string, actual: string, label: string): void {
  const normalizedExpected = normalizeAlipayAmount(expected);
  const normalizedActual = normalizeAlipayAmount(actual);
  if (
    normalizedExpected === null ||
    normalizedActual === null ||
    normalizedExpected !== normalizedActual
  ) {
    throw new Error(`Alipay ${label} amount mismatch`);
  }
}

export async function createAlipayApi(options: AlipayApiOptions): Promise<AlipayApi> {
  const appId = options.appId.trim();
  if (appId === "") throw new Error("Alipay app id is not configured");
  const gateway = assertGateway(options.gatewayUrl?.trim() || ALIPAY_PRODUCTION_GATEWAY);
  const fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("invalid Alipay timeout");
  // Import eagerly so malformed bindings keep checkout disabled instead of failing only after
  // a durable order has been created and the browser opens the one-time form hop.
  const [privateKey, publicKey] = await Promise.all([
    importAlipayPrivateKey(options.privateKeyPem),
    importAlipayPublicKey(options.alipayPublicKeyPem),
  ]);

  const commonParams = (method: string, bizContent: Record<string, string>): Record<string, string> => ({
    app_id: appId,
    method,
    format: "JSON",
    charset: "utf-8",
    version: "1.0",
    timestamp: formatAlipayTimestamp(now()),
    biz_content: JSON.stringify(bizContent),
  });

  const call = async <T extends AlipayGatewayResult>(
    method: string,
    bizContent: Record<string, string>,
  ): Promise<T> => {
    const signed = await signAlipayParams(commonParams(method, bizContent), privateKey);
    const response = await fetchImpl(gateway, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: new URLSearchParams(signed.params).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Alipay gateway failed: ${response.status}`);
    const raw = await response.text();
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error("Alipay gateway returned invalid JSON");
    }
    const member = responseMemberFor(method);
    const result = payload[member];
    const signature = payload.sign;
    const signedContent = extractJsonObjectMember(raw, member);
    if (
      result === null ||
      typeof result !== "object" ||
      typeof signature !== "string" ||
      signedContent === null
    ) {
      throw new Error("Alipay gateway response is incomplete");
    }
    if (!(await verifyAlipayContent(signedContent, signature, publicKey))) {
      throw new Error("Alipay gateway response signature is invalid");
    }
    const typed = result as T;
    if (typeof typed.code !== "string" || typed.code === "") {
      throw new Error("Alipay gateway response code is missing");
    }
    return typed;
  };

  return {
    async pagePayForm(input) {
      const params = commonParams("alipay.trade.page.pay", {
        out_trade_no: input.outTradeNo,
        total_amount: input.totalAmount,
        subject: input.subject,
        product_code: "FAST_INSTANT_TRADE_PAY",
        timeout_express: "20m",
      });
      if (input.notifyUrl?.trim()) params.notify_url = input.notifyUrl.trim();
      params.return_url = input.returnUrl;
      const signed = await signAlipayParams(params, privateKey);
      const inputs = Object.entries(signed.params)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(
          ([key, value]) =>
            `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`,
        )
        .join("");
      return `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>正在打开支付宝</title></head><body><form method="post" action="${escapeHtml(gateway)}">${inputs}<noscript><button type="submit">打开支付宝</button></noscript></form><script>document.forms[0].submit()</script></body></html>`;
    },

    async queryTrade(outTradeNo) {
      const result = await call<AlipayTradeResult>("alipay.trade.query", {
        out_trade_no: outTradeNo,
      });
      if (result.code !== "10000") return null;
      if (result.out_trade_no !== outTradeNo) throw new Error("Alipay query order mismatch");
      if (typeof result.trade_status !== "string" || result.trade_status === "") {
        throw new Error("Alipay query trade status is missing");
      }
      return result;
    },

    async closeTrade(outTradeNo) {
      const result = await call<AlipayCloseResult>("alipay.trade.close", {
        out_trade_no: outTradeNo,
      });
      if (result.code === "10000" && result.out_trade_no !== outTradeNo) {
        throw new Error("Alipay close order mismatch");
      }
      return result;
    },

    async refundTrade(input) {
      const result = await call<AlipayRefundResult>("alipay.trade.refund", {
        out_trade_no: input.outTradeNo,
        refund_amount: input.refundAmount,
        out_request_no: input.outRequestNo,
      });
      if (result.code === "10000") {
        if (result.out_trade_no !== input.outTradeNo) throw new Error("Alipay refund order mismatch");
        if (result.refund_fee !== undefined) {
          assertMatchingAmount(input.refundAmount, result.refund_fee, "refund");
        }
      }
      return result;
    },

    async queryRefund(input) {
      const result = await call<AlipayRefundQueryResult>(
        "alipay.trade.fastpay.refund.query",
        {
          out_trade_no: input.outTradeNo,
          out_request_no: input.outRequestNo,
        },
      );
      if (result.code !== "10000") return null;
      if (result.out_trade_no !== input.outTradeNo) {
        throw new Error("Alipay refund query order mismatch");
      }
      if (result.out_request_no !== input.outRequestNo) {
        throw new Error("Alipay refund query request mismatch");
      }
      return result;
    },

    async verifyNotification(params) {
      return verifyAlipayParams(params, publicKey);
    },
  };
}
