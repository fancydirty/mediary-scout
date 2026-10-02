export type PaymentTierId = "quarter" | "year" | "two_years";

export interface PaymentTier {
  readonly id: PaymentTierId;
  readonly months: 3 | 12 | 24;
  readonly totalAmount: string;
  readonly label: string;
  readonly price: string;
  readonly featured: boolean;
}

export const PAYMENT_TIERS: Readonly<Record<PaymentTierId, PaymentTier>> = Object.freeze({
  quarter: Object.freeze({
    id: "quarter",
    months: 3,
    totalAmount: "45.00",
    label: "季度",
    price: "¥45",
    featured: false,
  }),
  year: Object.freeze({
    id: "year",
    months: 12,
    totalAmount: "108.00",
    label: "年度",
    price: "¥108",
    featured: true,
  }),
  two_years: Object.freeze({
    id: "two_years",
    months: 24,
    totalAmount: "188.00",
    label: "两年",
    price: "¥188",
    featured: false,
  }),
});

export function resolvePaymentTier(value: unknown): PaymentTier | null {
  if (typeof value !== "string" || !Object.hasOwn(PAYMENT_TIERS, value)) return null;
  return PAYMENT_TIERS[value as PaymentTierId];
}

export function normalizePaymentAmount(value: unknown): string | null {
  const match = typeof value === "string" ? value.trim().match(/^(\d+)(?:\.(\d{1,2}))?$/) : null;
  if (!match?.[1]) return null;
  return `${BigInt(match[1]).toString()}.${(match[2] ?? "").padEnd(2, "0")}`;
}

export type PaymentOrderStatus =
  | "created"
  | "form_issued"
  | "pending"
  | "paid"
  | "fulfilled"
  | "closed"
  | "refunded";

const PAYMENT_ORDER_TRANSITIONS: Readonly<
  Record<PaymentOrderStatus, ReadonlySet<PaymentOrderStatus>>
> = Object.freeze({
  created: new Set<PaymentOrderStatus>(["form_issued", "paid", "closed"]),
  form_issued: new Set<PaymentOrderStatus>(["pending", "paid", "closed"]),
  pending: new Set<PaymentOrderStatus>(["paid", "closed"]),
  paid: new Set<PaymentOrderStatus>(["fulfilled", "refunded"]),
  fulfilled: new Set<PaymentOrderStatus>(["refunded"]),
  closed: new Set<PaymentOrderStatus>(),
  refunded: new Set<PaymentOrderStatus>(),
});

export function canTransitionPaymentOrder(
  from: PaymentOrderStatus,
  to: PaymentOrderStatus,
): boolean {
  return from === to || PAYMENT_ORDER_TRANSITIONS[from].has(to);
}
