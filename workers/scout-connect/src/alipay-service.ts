import type { AlipayApi } from "./alipay-api.js";
import { canTransitionPaymentOrder, normalizeAlipayAmount } from "./alipay-order.js";
import type { ConnectDb, PaymentOrderRow } from "./db.js";
import { grantEntitlement } from "./grant.js";
import type { CfApi } from "./cf-api.js";
import { isEntitlementActive, reconcileEntitlementLedger } from "./entitlement.js";
import { revokeEndpoint } from "./revoke.js";

export interface AlipayServiceDeps {
  db: ConnectDb;
  alipayApi: AlipayApi;
  alipayAppId: string;
  alipaySellerId: string;
  now: () => string;
  newAccountId: () => string;
  newEntitlementId: () => string;
}

export interface AlipayRefundDeps extends AlipayServiceDeps {
  cf: CfApi;
  newAuditId: () => string;
  newRefundRequestNo: () => string;
}

export interface AlipayPaymentEvidence {
  outTradeNo: string;
  tradeNo: string;
  totalAmount: string;
  notifyId?: string | null;
}

/** An authenticated message that is nevertheless not evidence for one of our exact orders. */
export class InvalidAlipayEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAlipayEvidenceError";
  }
}

export class AlipayOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlipayOperationError";
  }
}

export function isAlipayPaidStatus(status: string | null | undefined): boolean {
  return status === "TRADE_SUCCESS" || status === "TRADE_FINISHED";
}

function requireNonEmpty(value: string | null | undefined, label: string): string {
  const normalized = value?.trim() ?? "";
  if (normalized === "") throw new InvalidAlipayEvidenceError(`Alipay ${label} is missing`);
  return normalized;
}

function assertAmount(expected: string, actual: string): void {
  const normalizedExpected = normalizeAlipayAmount(expected);
  const normalizedActual = normalizeAlipayAmount(actual);
  if (
    normalizedExpected === null ||
    normalizedActual === null ||
    normalizedExpected !== normalizedActual
  ) {
    throw new InvalidAlipayEvidenceError("Alipay payment amount mismatch");
  }
}

async function requireOrder(db: ConnectDb, outTradeNo: string): Promise<PaymentOrderRow> {
  const order = await db.getPaymentOrderByOutTradeNo(outTradeNo);
  if (order === null) throw new InvalidAlipayEvidenceError("Alipay payment order not found");
  return order;
}

/**
 * Grants the ledger entry only from a durable paid order. A failed order-state update after
 * the grant is self-healing: the next call hits the provider transaction unique key, rebuilds
 * the entitlement ledger, and marks the order fulfilled.
 */
export async function fulfillAlipayOrder(
  staleOrder: PaymentOrderRow,
  deps: AlipayServiceDeps,
): Promise<PaymentOrderRow> {
  const order = await deps.db.getPaymentOrderById(staleOrder.id);
  if (order === null) throw new Error("payment order disappeared");
  if (order.status === "fulfilled") return order;
  if (order.status !== "paid") throw new Error("Alipay order has no verified paid state");

  const account = await deps.db.getAccountById(order.account_id);
  if (account === null) throw new Error("payment account missing");
  await grantEntitlement(
    {
      accountId: account.id,
      email: account.email,
      months: order.months,
      source: "alipay",
      paymentProvider: "alipay",
      paymentTransactionId: order.out_trade_no,
    },
    deps,
  );
  await deps.db.updatePaymentOrder(order.id, {
    status: "fulfilled",
    fulfilled_at: deps.now(),
  });
  const fulfilled = await deps.db.getPaymentOrderById(order.id);
  if (fulfilled === null) throw new Error("fulfilled payment order disappeared");
  return fulfilled;
}

/** Persist exact paid evidence before attempting fulfillment. */
export async function acceptAlipayPayment(
  evidence: AlipayPaymentEvidence,
  deps: AlipayServiceDeps,
): Promise<PaymentOrderRow> {
  const outTradeNo = requireNonEmpty(evidence.outTradeNo, "out_trade_no");
  const tradeNo = requireNonEmpty(evidence.tradeNo, "trade_no");
  const totalAmount = requireNonEmpty(evidence.totalAmount, "total_amount");
  let order = await requireOrder(deps.db, outTradeNo);
  assertAmount(order.total_amount, totalAmount);

  if (order.trade_no !== null && order.trade_no !== tradeNo) {
    throw new InvalidAlipayEvidenceError("Alipay provider trade number mismatch");
  }
  if (order.status === "closed" || order.status === "refunded") {
    throw new InvalidAlipayEvidenceError("Alipay order is terminal and not payable");
  }
  if (order.status === "fulfilled") return order;

  if (order.status !== "paid") {
    if (!canTransitionPaymentOrder(order.status, "paid")) {
      throw new InvalidAlipayEvidenceError("Alipay paid state transition is invalid");
    }
    await deps.db.updatePaymentOrder(order.id, {
      status: "paid",
      trade_no: tradeNo,
      paid_at: deps.now(),
      ...(evidence.notifyId === undefined
        ? {}
        : { last_notify_id: evidence.notifyId?.trim() || null }),
    });
  } else if (order.trade_no === null || evidence.notifyId !== undefined) {
    await deps.db.updatePaymentOrder(order.id, {
      ...(order.trade_no === null ? { trade_no: tradeNo } : {}),
      ...(evidence.notifyId === undefined
        ? {}
        : { last_notify_id: evidence.notifyId?.trim() || null }),
    });
  }

  order = await requireOrder(deps.db, outTradeNo);
  return fulfillAlipayOrder(order, deps);
}

/** Verify and validate every merchant/order field before accepting an async form notification. */
export async function acceptAlipayNotification(
  params: URLSearchParams,
  deps: AlipayServiceDeps,
): Promise<PaymentOrderRow> {
  let verified = false;
  try {
    verified = await deps.alipayApi.verifyNotification(params);
  } catch {
    verified = false;
  }
  if (!verified) throw new InvalidAlipayEvidenceError("Alipay notification signature is invalid");
  if (params.get("app_id") !== deps.alipayAppId) {
    throw new InvalidAlipayEvidenceError("Alipay notification app mismatch");
  }
  const seller = params.get("seller_id") ?? params.get("pid");
  if (seller !== deps.alipaySellerId) {
    throw new InvalidAlipayEvidenceError("Alipay notification seller mismatch");
  }
  if (!isAlipayPaidStatus(params.get("trade_status"))) {
    throw new InvalidAlipayEvidenceError("Alipay notification is not a paid state");
  }
  return acceptAlipayPayment(
    {
      outTradeNo: requireNonEmpty(params.get("out_trade_no"), "out_trade_no"),
      tradeNo: requireNonEmpty(params.get("trade_no"), "trade_no"),
      totalAmount: requireNonEmpty(params.get("total_amount"), "total_amount"),
      notifyId: params.get("notify_id"),
    },
    deps,
  );
}

/**
 * Reconcile a local order against a signature-verified trade.query response. WAIT_BUYER_PAY is
 * deliberately queried again on every later status poll; only paid/closed become terminal.
 */
export async function compensateAlipayOrder(
  orderId: string,
  deps: AlipayServiceDeps,
): Promise<PaymentOrderRow> {
  let order = await deps.db.getPaymentOrderById(orderId);
  if (order === null) throw new InvalidAlipayEvidenceError("Alipay payment order not found");
  if (order.status === "fulfilled" || order.status === "closed" || order.status === "refunded") {
    return order;
  }
  if (order.status === "paid") {
    try {
      return await fulfillAlipayOrder(order, deps);
    } catch {
      // The payment proof is durable even when entitlement storage is temporarily unavailable.
      // Keep exposing paid_unfulfilled and let notify/status retries repair fulfillment.
      return (await deps.db.getPaymentOrderById(order.id)) ?? order;
    }
  }

  const result = await deps.alipayApi.queryTrade(order.out_trade_no);
  if (result === null) return order;
  if (isAlipayPaidStatus(result.trade_status)) {
    try {
      return await acceptAlipayPayment(
        {
          outTradeNo: result.out_trade_no,
          tradeNo: requireNonEmpty(result.trade_no, "trade_no"),
          totalAmount: requireNonEmpty(result.total_amount, "total_amount"),
        },
        deps,
      );
    } catch (error) {
      // A grant failure happens after durable paid evidence. Preserve that state for the UI and
      // retry on the next poll; evidence-validation and query failures must still fail closed.
      const latest = await deps.db.getPaymentOrderById(order.id);
      if (latest?.status === "paid" && !(error instanceof InvalidAlipayEvidenceError)) return latest;
      throw error;
    }
  }
  if (result.trade_status === "TRADE_CLOSED") {
    order = (await deps.db.getPaymentOrderById(order.id)) ?? order;
    if (order.status === "paid") return fulfillAlipayOrder(order, deps);
    if (order.status === "fulfilled") return order;
    if (canTransitionPaymentOrder(order.status, "closed")) {
      await deps.db.updatePaymentOrder(order.id, { status: "closed", closed_at: deps.now() });
      return (await deps.db.getPaymentOrderById(order.id)) ?? order;
    }
    return order;
  }
  if (result.trade_status === "WAIT_BUYER_PAY" && order.status === "form_issued") {
    await deps.db.updatePaymentOrder(order.id, { status: "pending" });
    return (await deps.db.getPaymentOrderById(order.id)) ?? order;
  }
  return order;
}

async function revokeRefundedAccountIfNeeded(
  order: PaymentOrderRow,
  deps: AlipayRefundDeps,
): Promise<void> {
  const expiry = await reconcileEntitlementLedger(order.account_id, deps.db);
  if (isEntitlementActive(expiry, deps.now())) return;
  // Refund is rare and admin-only. listEndpoints also finds revoke_failed rows, unlike
  // getActiveEndpointByAccountId, so retrying a partial Cloudflare deletion can self-heal.
  const endpoint = (await deps.db.listEndpoints()).find(
    (candidate) =>
      candidate.account_id === order.account_id && candidate.status !== "revoked",
  );
  if (endpoint === undefined) return;
  await revokeEndpoint({
    endpointId: endpoint.id,
    deps: {
      cf: deps.cf,
      db: deps.db,
      now: deps.now,
      newAuditId: deps.newAuditId,
      actor: "admin",
    },
  });
}

async function applyConfirmedAlipayRefund(
  staleOrder: PaymentOrderRow,
  deps: AlipayRefundDeps,
): Promise<PaymentOrderRow> {
  let order = (await deps.db.getPaymentOrderById(staleOrder.id)) ?? staleOrder;
  if (order.refund_request_no === null) {
    throw new AlipayOperationError("refund request number is missing");
  }
  if (order.status !== "refunded") {
    if (!canTransitionPaymentOrder(order.status, "refunded")) {
      throw new AlipayOperationError("order cannot be refunded from its current state");
    }
    // Persist external money truth first. Any later local failure is repaired through the same
    // request number without calling the refund API twice.
    await deps.db.updatePaymentOrder(order.id, {
      status: "refunded",
      refunded_at: deps.now(),
    });
    order = (await deps.db.getPaymentOrderById(order.id)) ?? order;
  }
  await deps.db.markEntitlementRefunded("alipay", order.out_trade_no, deps.now());
  await revokeRefundedAccountIfNeeded(order, deps);
  return (await deps.db.getPaymentOrderById(order.id)) ?? order;
}

function assertRefundAmount(order: PaymentOrderRow, amount: string | undefined): void {
  if (amount === undefined) throw new AlipayOperationError("refund amount is missing");
  const expected = normalizeAlipayAmount(order.total_amount);
  const actual = normalizeAlipayAmount(amount);
  if (expected === null || actual === null || expected !== actual) {
    throw new AlipayOperationError("refund amount mismatch");
  }
}

export interface AlipayRefundOutcome {
  status: "pending" | "refunded";
  order: PaymentOrderRow;
}

async function queryRefundForOrder(
  staleOrder: PaymentOrderRow,
  deps: AlipayRefundDeps,
): Promise<AlipayRefundOutcome> {
  const order = (await deps.db.getPaymentOrderById(staleOrder.id)) ?? staleOrder;
  if (order.refund_request_no === null) {
    throw new AlipayOperationError("refund request number is missing");
  }
  if (order.status === "refunded") {
    return { status: "refunded", order: await applyConfirmedAlipayRefund(order, deps) };
  }
  const result = await deps.alipayApi.queryRefund({
    outTradeNo: order.out_trade_no,
    outRequestNo: order.refund_request_no,
  });
  if (result?.refund_status !== "REFUND_SUCCESS") return { status: "pending", order };
  assertRefundAmount(order, result.refund_amount);
  if (result.total_amount !== undefined) assertRefundAmount(order, result.total_amount);
  return { status: "refunded", order: await applyConfirmedAlipayRefund(order, deps) };
}

export async function requestFullAlipayRefund(
  orderId: string,
  deps: AlipayRefundDeps,
): Promise<AlipayRefundOutcome> {
  let order = await deps.db.getPaymentOrderById(orderId);
  if (order === null) throw new InvalidAlipayEvidenceError("Alipay payment order not found");
  if (order.status === "refunded") {
    return { status: "refunded", order: await applyConfirmedAlipayRefund(order, deps) };
  }
  if (order.status !== "paid" && order.status !== "fulfilled") {
    throw new AlipayOperationError("only a paid order can be refunded");
  }
  if (order.refund_request_no === null) {
    const requestNo = requireNonEmpty(deps.newRefundRequestNo(), "refund request number");
    await deps.db.updatePaymentOrder(order.id, { refund_request_no: requestNo });
    order = (await deps.db.getPaymentOrderById(order.id)) ?? order;
  }
  const result = await deps.alipayApi.refundTrade({
    outTradeNo: order.out_trade_no,
    outRequestNo: order.refund_request_no!,
    refundAmount: order.total_amount,
  });
  if (result.code === "10000" && result.fund_change === "Y") {
    assertRefundAmount(order, result.refund_fee);
    return { status: "refunded", order: await applyConfirmedAlipayRefund(order, deps) };
  }
  // code=10000 alone does not prove that funds changed. Persisted request identity lets query
  // distinguish a pending response from a completed full refund.
  return queryRefundForOrder(order, deps);
}

export async function queryAlipayRefund(
  requestNo: string,
  deps: AlipayRefundDeps,
): Promise<AlipayRefundOutcome> {
  const order = await deps.db.getPaymentOrderByRefundRequestNo(requestNo);
  if (order === null) throw new InvalidAlipayEvidenceError("Alipay refund request not found");
  return queryRefundForOrder(order, deps);
}

/** Close only unpaid orders. Local paid state is re-queried and fulfilled instead. */
export async function closeAlipayOrder(
  orderId: string,
  deps: AlipayServiceDeps,
): Promise<PaymentOrderRow> {
  let order = await deps.db.getPaymentOrderById(orderId);
  if (order === null) throw new InvalidAlipayEvidenceError("Alipay payment order not found");
  if (order.status === "closed" || order.status === "fulfilled" || order.status === "refunded") {
    return order;
  }
  if (order.status === "paid") {
    // A close attempt on a locally paid order is a reconciliation action, never a destructive one.
    const queried = await deps.alipayApi.queryTrade(order.out_trade_no);
    if (queried !== null && isAlipayPaidStatus(queried.trade_status)) {
      return acceptAlipayPayment(
        {
          outTradeNo: queried.out_trade_no,
          tradeNo: requireNonEmpty(queried.trade_no, "trade_no"),
          totalAmount: requireNonEmpty(queried.total_amount, "total_amount"),
        },
        deps,
      );
    }
    return compensateAlipayOrder(order.id, deps);
  }

  const result = await deps.alipayApi.closeTrade(order.out_trade_no);
  if (result.code === "10000") {
    order = (await deps.db.getPaymentOrderById(order.id)) ?? order;
    if (order.status === "paid") return compensateAlipayOrder(order.id, deps);
    if (order.status === "fulfilled") return order;
    if (canTransitionPaymentOrder(order.status, "closed")) {
      await deps.db.updatePaymentOrder(order.id, { status: "closed", closed_at: deps.now() });
      return (await deps.db.getPaymentOrderById(order.id)) ?? order;
    }
    return order;
  }
  return compensateAlipayOrder(order.id, deps);
}
