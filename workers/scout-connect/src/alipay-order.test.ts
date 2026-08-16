import { describe, expect, it } from "vitest";
import {
  ALIPAY_TIERS,
  canTransitionPaymentOrder,
  normalizeAlipayAmount,
  resolveAlipayTier,
} from "./alipay-order.js";

describe("Alipay tier registry", () => {
  it.each([
    ["quarter", "45.00", 3],
    ["year", "108.00", 12],
    ["two_year", "188.00", 24],
  ])("maps %s to the server-owned amount and months", (id, totalAmount, months) => {
    expect(resolveAlipayTier(id)).toMatchObject({ id, totalAmount, months });
  });

  it.each([undefined, null, "", "monthly", 12, { id: "quarter" }])(
    "rejects an unregistered tier: %j",
    (value) => {
      expect(resolveAlipayTier(value)).toBeNull();
    },
  );

  it("keeps registry rows frozen so request code cannot change prices", () => {
    expect(Object.isFrozen(ALIPAY_TIERS)).toBe(true);
    expect(Object.isFrozen(ALIPAY_TIERS.quarter)).toBe(true);
  });
});

describe("normalizeAlipayAmount", () => {
  it.each([
    ["0", "0.00"],
    ["00045", "45.00"],
    ["45.1", "45.10"],
    [" 108.00 ", "108.00"],
  ])("normalizes %j to %s without floating-point math", (input, expected) => {
    expect(normalizeAlipayAmount(input)).toBe(expected);
  });

  it.each(["", ".1", "1.", "1.234", "-1", "+1", "1e2", 45, NaN, null])(
    "rejects malformed amount %j",
    (input) => {
      expect(normalizeAlipayAmount(input)).toBeNull();
    },
  );
});

describe("payment-order transitions", () => {
  it.each([
    ["created", "form_issued"],
    ["created", "paid"],
    ["created", "closed"],
    ["form_issued", "paid"],
    ["form_issued", "closed"],
    ["paid", "fulfilled"],
    ["fulfilled", "refunded"],
    ["paid", "paid"],
  ] as const)("allows %s -> %s", (from, to) => {
    expect(canTransitionPaymentOrder(from, to)).toBe(true);
  });

  it.each([
    ["closed", "paid"],
    ["refunded", "fulfilled"],
    ["fulfilled", "closed"],
    ["created", "refunded"],
  ] as const)("rejects %s -> %s", (from, to) => {
    expect(canTransitionPaymentOrder(from, to)).toBe(false);
  });
});
