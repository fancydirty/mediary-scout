import { describe, expect, it } from "vitest";
import {
  InvalidWaffoEvidenceError,
  assertWaffoCompletedEvidence,
  isWaffoFullRefund,
  normalizeWaffoAmount,
  readWaffoCompletedEvidence,
} from "./waffo-service.js";

describe("Waffo evidence", () => {
  it("normalizes display amounts without treating minor-unit amount as display amount", () => {
    expect(normalizeWaffoAmount("45")).toBe("45.00");
    expect(normalizeWaffoAmount({ amount: "4500", display: "45.00", currency: "CNY" })).toBe("45.00");
    expect(normalizeWaffoAmount({ amount: "4500", currency: "CNY" })).toBeNull();
  });

  it("extracts and validates an order.completed evidence record", () => {
    const evidence = readWaffoCompletedEvidence({
      orderId: "ORD_1",
      paymentId: "PAY_1",
      orderMerchantExternalId: "MC_1",
      currency: "CNY",
      listPrice: { total: "45.00" },
      paymentStatus: "succeeded",
    });
    expect(evidence).toMatchObject({
      orderId: "ORD_1", paymentId: "PAY_1", orderMerchantExternalId: "MC_1",
      currency: "CNY", total: "45.00", paymentStatus: "succeeded",
    });
    expect(() => assertWaffoCompletedEvidence(evidence, "MC_1", "45.00")).not.toThrow();
    expect(() => assertWaffoCompletedEvidence(evidence, "MC_1", "44.00"))
      .toThrow(InvalidWaffoEvidenceError);
  });

  it("requires a full refund amount and leaves partial refunds distinguishable", () => {
    expect(isWaffoFullRefund("45.00", { refundedAmount: "45.00" })).toBe(true);
    expect(isWaffoFullRefund("45.00", { refundedAmount: { display: "45.00" } })).toBe(true);
    expect(isWaffoFullRefund("45.00", { refundedAmount: { display: "1.00" } })).toBe(false);
    expect(isWaffoFullRefund("45.00", { isFullyRefunded: true })).toBe(true);
    expect(isWaffoFullRefund("45.00", { refundedAmount: { amount: "4500", currency: "CNY" } })).toBe(false);
  });
});
