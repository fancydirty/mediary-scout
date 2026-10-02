/** Pure evidence checks shared by webhook, status compensation, and reconciliation paths. */

export class InvalidWaffoEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWaffoEvidenceError";
  }
}

export interface WaffoCompletedEvidence {
  orderId: string;
  paymentId: string;
  orderMerchantExternalId: string;
  currency: string;
  total: string;
  paymentStatus: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** Normalize a display amount. `amount` alone is deliberately rejected because Waffo returns it in minor units. */
export function normalizeWaffoAmount(value: unknown): string | null {
  if (typeof value === "string") {
    const match = value.trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
    if (!match?.[1]) return null;
    return `${BigInt(match[1]).toString()}.${(match[2] ?? "").padEnd(2, "0")}`;
  }
  const object = record(value);
  if (object === null || typeof object.display !== "string") return null;
  return normalizeWaffoAmount(object.display);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InvalidWaffoEvidenceError(`Waffo ${label} is missing`);
  }
  return value.trim();
}

export function readWaffoCompletedEvidence(data: unknown): WaffoCompletedEvidence {
  const object = record(data);
  if (object === null) throw new InvalidWaffoEvidenceError("Waffo event data is missing");
  const listPrice = record(object.listPrice);
  const total = normalizeWaffoAmount(listPrice?.total);
  if (total === null) throw new InvalidWaffoEvidenceError("Waffo list price total is missing");
  const paymentStatus = requiredString(object.paymentStatus, "payment status");
  return {
    orderId: requiredString(object.orderId, "order id"),
    paymentId: requiredString(object.paymentId, "payment id"),
    orderMerchantExternalId: requiredString(
      object.orderMerchantExternalId,
      "order merchant external id",
    ),
    currency: requiredString(object.currency, "currency"),
    total,
    paymentStatus,
  };
}

export function assertWaffoCompletedEvidence(
  evidence: WaffoCompletedEvidence,
  expectedExternalId: string,
  expectedTotal: string,
): void {
  if (evidence.orderMerchantExternalId !== expectedExternalId) {
    throw new InvalidWaffoEvidenceError("Waffo order external id mismatch");
  }
  if (evidence.currency !== "CNY") {
    throw new InvalidWaffoEvidenceError("Waffo payment currency mismatch");
  }
  if (evidence.paymentStatus.trim() !== "succeeded") {
    throw new InvalidWaffoEvidenceError("Waffo payment is not succeeded");
  }
  const expected = normalizeWaffoAmount(expectedTotal);
  if (expected === null || expected !== evidence.total) {
    throw new InvalidWaffoEvidenceError("Waffo payment amount mismatch");
  }
}

/** True only when Waffo proves the complete order amount was refunded. */
export function isWaffoFullRefund(expectedTotal: string, refund: unknown): boolean {
  const object = record(refund);
  if (object?.isFullyRefunded === true) return true;
  const expected = normalizeWaffoAmount(expectedTotal);
  const refunded = normalizeWaffoAmount(object?.refundedAmount);
  return expected !== null && refunded !== null && expected === refunded;
}
