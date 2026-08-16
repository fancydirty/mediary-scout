# Mediary Connect Alipay-Only Checkout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Mediary Connect's complete Paddle checkout service with Alipay AI web application payment while preserving the existing 3/12/24-month entitlement behavior.

**Architecture:** The Cloudflare Worker owns Alipay RSA2 signing, order persistence, notify/query reconciliation, close/refund operations, and entitlement fulfillment. Browser code only selects a server-owned tier, follows a same-origin checkout capability to an auto-submitted Alipay page-pay form, and polls a session-bound order status. Existing Paddle entitlements remain historical ledger rows; no new Paddle runtime path remains.

**Tech Stack:** TypeScript, Cloudflare Workers Web Crypto/fetch, D1, Vitest, existing HTML string renderers, `alipay.trade.page.pay` and related OpenAPI methods.

## Global Constraints

- All languages and all three tiers use Alipay; no runtime Paddle fallback.
- Fixed mappings: `quarter -> { months: 3, totalAmount: "45.00" }`, `year -> { months: 12, totalAmount: "108.00" }`, `two_year -> { months: 24, totalAmount: "188.00" }`.
- Existing entitlement stacking, expiry restart, 7-day grace, slug ownership, provisioning, and tunnel behavior must remain unchanged.
- Preserve all historical rows, including the two production `source=paddle` entitlements; do not delete production data.
- Never read, print, copy, commit, or test with production private keys. Tests generate ephemeral RSA keys.
- A synchronous Alipay return is never payment proof. Only verified notify or verified `alipay.trade.query` can fulfill.
- Implement page pay, trade query, trade close, refund, refund query, and async notify.
- Every production code change follows RED -> verify RED -> GREEN -> verify GREEN -> refactor.
- Changes go through commit -> push -> PR -> CI -> Copilot review on current HEAD -> merge -> deploy.
- Do not claim production acceptance until a non-merchant payer completes a real payment and entitlement delivery is observed.

---

## File Structure

| File | Responsibility |
|---|---|
| `workers/scout-connect/src/alipay-crypto.ts` | PEM import, canonical parameter encoding, RSA2 sign and verify |
| `workers/scout-connect/src/alipay-order.ts` | Tier registry, amount normalization, order state types and transition checks |
| `workers/scout-connect/src/alipay-api.ts` | Page-pay form and signed OpenAPI calls for query/close/refund/refund-query |
| `workers/scout-connect/src/alipay-service.ts` | Accept verified payment, idempotently grant, compensate query, refund reconciliation |
| `workers/scout-connect/src/db.ts` | Payment order and provider-neutral entitlement persistence for D1 and memory backends |
| `workers/scout-connect/src/grant.ts` | Provider-neutral idempotency input and entitlement ledger convergence |
| `workers/scout-connect/src/entitlement.ts` | Effective-ledger reconciliation after grants/refunds |
| `workers/scout-connect/src/routes.ts` | HTTP authentication, body limits, endpoint routing and response shaping |
| `workers/scout-connect/src/html/buy-page.ts` | Alipay-only tier selection and checkout hop |
| `workers/scout-connect/src/html/payment-success-page.ts` | Return page status polling and final redirect |

---

### Task 1: Alipay protocol primitives and fixed tier registry

**Files:**
- Create: `workers/scout-connect/src/alipay-crypto.ts`
- Create: `workers/scout-connect/src/alipay-crypto.test.ts`
- Create: `workers/scout-connect/src/alipay-order.ts`
- Create: `workers/scout-connect/src/alipay-order.test.ts`

**Interfaces:**
- Produces: `importAlipayPrivateKey(pem: string): Promise<CryptoKey>`
- Produces: `importAlipayPublicKey(pem: string): Promise<CryptoKey>`
- Produces: `signAlipayParams(params: Record<string,string>, key: CryptoKey): Promise<SignedAlipayParams>`
- Produces: `verifyAlipayParams(params: URLSearchParams | Record<string,string>, key: CryptoKey): Promise<boolean>`
- Produces: `normalizeAlipayAmount(value: unknown): string | null`
- Produces: `ALIPAY_TIERS`, `resolveAlipayTier(id: unknown): AlipayTier | null`
- Produces: `canTransitionPaymentOrder(from, to): boolean`

- [ ] **Step 1: Write failing crypto and registry tests**

```ts
it("signs and verifies RSA2 with sign_type included", async () => {
  const keys = await testRsaKeys();
  const signed = await signAlipayParams({ app_id: "app", method: "alipay.trade.query" }, keys.privateKey);
  expect(signed.params.sign_type).toBe("RSA2");
  expect(await verifyAlipayParams(signed.params, keys.publicKey)).toBe(true);
});

it.each([
  ["quarter", "45.00", 3],
  ["year", "108.00", 12],
  ["two_year", "188.00", 24],
])("maps %s to immutable amount and months", (id, totalAmount, months) => {
  expect(resolveAlipayTier(id)).toMatchObject({ id, totalAmount, months });
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `npx vitest run workers/scout-connect/src/alipay-crypto.test.ts workers/scout-connect/src/alipay-order.test.ts`

Expected: FAIL because the modules and exported functions do not exist.

- [ ] **Step 3: Implement minimal RSA2 and tier behavior**

```ts
export const ALIPAY_TIERS = Object.freeze({
  quarter: Object.freeze({ id: "quarter", months: 3, totalAmount: "45.00", label: "季度", price: "¥45", featured: false }),
  year: Object.freeze({ id: "year", months: 12, totalAmount: "108.00", label: "年度", price: "¥108", featured: true }),
  two_year: Object.freeze({ id: "two_year", months: 24, totalAmount: "188.00", label: "两年", price: "¥188", featured: false }),
});

export function normalizeAlipayAmount(value: unknown): string | null {
  const match = typeof value === "string" ? value.trim().match(/^(\d+)(?:\.(\d{1,2}))?$/) : null;
  return match ? `${BigInt(match[1]!).toString()}.${(match[2] ?? "").padEnd(2, "0")}` : null;
}
```

The RSA canonical string sorts non-empty keys, excludes `sign`, includes `sign_type=RSA2` for OpenAPI request signing, and verifies both documented notify shapes without logging content or signature.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npx vitest run workers/scout-connect/src/alipay-crypto.test.ts workers/scout-connect/src/alipay-order.test.ts`

Expected: PASS with no warnings.

- [ ] **Step 5: Commit**

```bash
git add workers/scout-connect/src/alipay-crypto.ts workers/scout-connect/src/alipay-crypto.test.ts workers/scout-connect/src/alipay-order.ts workers/scout-connect/src/alipay-order.test.ts
git commit -m "feat(connect): add Alipay protocol primitives"
```

---

### Task 2: Provider-neutral entitlement ledger and payment-order persistence

**Files:**
- Create: `workers/scout-connect/migrations/0006-alipay-payment-orders.sql`
- Modify: `workers/scout-connect/schema.sql`
- Modify: `workers/scout-connect/src/db.ts`
- Modify: `workers/scout-connect/src/db.test.ts`
- Modify: `workers/scout-connect/src/schema.test.ts`
- Modify: `workers/scout-connect/src/entitlement.ts`
- Modify: `workers/scout-connect/src/entitlement.test.ts`
- Modify: `workers/scout-connect/src/grant.ts`
- Modify: `workers/scout-connect/src/grant.test.ts`

**Interfaces:**
- Consumes: `PaymentOrderStatus` and `AlipayTier` from Task 1
- Produces: `PaymentOrderRow`
- Produces: `insertPaymentOrder`, `getPaymentOrderById`, `getPaymentOrderByCheckoutHash`, `getPaymentOrderByOutTradeNo`, `updatePaymentOrder`
- Produces: `getEntitlementByPayment(provider, transactionId)`, `markEntitlementRefunded`, `reconcileEntitlementLedger`
- Changes: `GrantInput` to `{ accountId?: string; email: string; months: number; source: EntitlementRow["source"]; paymentProvider: "alipay" | "paddle" | null; paymentTransactionId: string | null }`

- [ ] **Step 1: Write failing schema and memory/D1 parity tests**

```ts
it("backfills Paddle transaction ids into provider-neutral columns", () => {
  expect(migration).toContain("payment_provider");
  expect(migration).toContain("payment_transaction_id");
  expect(migration).toContain("UPDATE entitlements");
  expect(migration).toContain("payment_provider = 'paddle'");
});

it("deduplicates one provider transaction without colliding with manual grants", async () => {
  expect(await db.insertEntitlement(alipayEntitlement("MC1"))).toBe(true);
  expect(await db.insertEntitlement(alipayEntitlement("MC1"))).toBe(false);
  expect(await db.insertEntitlement(manualEntitlement())).toBe(true);
});
```

Add order CRUD parity assertions for D1 SQL and `createMemoryConnectDb()`.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run workers/scout-connect/src/schema.test.ts workers/scout-connect/src/db.test.ts workers/scout-connect/src/entitlement.test.ts workers/scout-connect/src/grant.test.ts`

Expected: FAIL on missing migration, columns, interfaces, and reconciliation behavior.

- [ ] **Step 3: Implement migration and repository surface**

```sql
ALTER TABLE entitlements ADD COLUMN payment_provider TEXT;
ALTER TABLE entitlements ADD COLUMN payment_transaction_id TEXT;
ALTER TABLE entitlements ADD COLUMN refunded_at TEXT;
UPDATE entitlements
SET payment_provider = 'paddle', payment_transaction_id = paddle_transaction_id
WHERE paddle_transaction_id IS NOT NULL;
CREATE UNIQUE INDEX idx_ent_payment
ON entitlements(payment_provider, payment_transaction_id)
WHERE payment_provider IS NOT NULL AND payment_transaction_id IS NOT NULL;

CREATE TABLE payment_orders (
  id TEXT PRIMARY KEY,
  checkout_token_sha256 TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  provider TEXT NOT NULL CHECK(provider = 'alipay'),
  out_trade_no TEXT NOT NULL UNIQUE,
  trade_no TEXT UNIQUE,
  months INTEGER NOT NULL CHECK(months IN (3,12,24)),
  total_amount TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  paid_at TEXT,
  fulfilled_at TEXT,
  closed_at TEXT,
  refunded_at TEXT,
  refund_request_no TEXT UNIQUE
);
```

Retain `paddle_transaction_id` as an unread historical column; new code reads/writes provider-neutral fields only.

- [ ] **Step 4: Implement entitlement reconciliation**

```ts
export function effectiveEntitlements(rows: EntitlementRow[]): EntitlementRow[] {
  return rows.filter((row) => row.refunded_at === null)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

export async function reconcileEntitlementLedger(accountId: string, db: ConnectDb): Promise<string | null> {
  let expiry: string | null = null;
  for (const row of effectiveEntitlements(await db.listEntitlements(accountId))) {
    expiry = computeExpiry({ currentExpiry: expiry, months: row.months, now: row.created_at });
    if (row.expires_at !== expiry) await db.updateEntitlementExpiry(row.id, expiry);
  }
  return expiry;
}
```

Update D1 expiry sweep/count queries and memory parity to ignore `refunded_at IS NOT NULL`.

- [ ] **Step 5: Verify GREEN and regression behavior**

Run: `npx vitest run workers/scout-connect/src/schema.test.ts workers/scout-connect/src/db.test.ts workers/scout-connect/src/entitlement.test.ts workers/scout-connect/src/grant.test.ts workers/scout-connect/src/provision.test.ts workers/scout-connect/src/expiry-sweep.test.ts`

Expected: PASS, including historical Paddle rows and refund-first/middle/last cases.

- [ ] **Step 6: Commit**

```bash
git add workers/scout-connect/migrations/0006-alipay-payment-orders.sql workers/scout-connect/schema.sql workers/scout-connect/src/db.ts workers/scout-connect/src/db.test.ts workers/scout-connect/src/schema.test.ts workers/scout-connect/src/entitlement.ts workers/scout-connect/src/entitlement.test.ts workers/scout-connect/src/grant.ts workers/scout-connect/src/grant.test.ts
git commit -m "refactor(connect): make entitlement ledger payment-neutral"
```

---

### Task 3: Signed Alipay API client

**Files:**
- Create: `workers/scout-connect/src/alipay-api.ts`
- Create: `workers/scout-connect/src/alipay-api.test.ts`

**Interfaces:**
- Consumes: Task 1 RSA2 helpers and amount normalization
- Produces: `AlipayApi` with `pagePayForm`, `queryTrade`, `closeTrade`, `refundTrade`, `queryRefund`, `verifyNotification`
- Produces: `createAlipayApi({ appId, privateKeyPem, alipayPublicKeyPem, gatewayUrl? }): AlipayApi`

- [ ] **Step 1: Write failing API contract tests**

```ts
it("creates a page-pay form with fixed notify and return URLs", async () => {
  const html = await api.pagePayForm({
    outTradeNo: "MC0123456789ABCDEF",
    totalAmount: "45.00",
    subject: "Mediary Connect 季度",
    notifyUrl: "https://mediaryconnect.app/api/alipay/notify",
    returnUrl: "https://mediaryconnect.app/payment-success?order=ord_abc",
  });
  expect(html).toContain("alipay.trade.page.pay");
  expect(html).toContain("FAST_INSTANT_TRADE_PAY");
  expect(html).toContain("https://openapi.alipay.com/gateway.do");
});
```

Add signed-response fixtures for query success/wait/closed, close, full refund, refund query, malformed JSON, bad signature, wrong order, and 10-second abort.

- [ ] **Step 2: Run test and verify RED**

Run: `npx vitest run workers/scout-connect/src/alipay-api.test.ts`

Expected: FAIL because `AlipayApi` does not exist.

- [ ] **Step 3: Implement the minimal client**

```ts
export interface AlipayApi {
  pagePayForm(input: PagePayInput): Promise<string>;
  queryTrade(outTradeNo: string): Promise<AlipayTradeResult | null>;
  closeTrade(outTradeNo: string): Promise<AlipayCloseResult>;
  refundTrade(input: { outTradeNo: string; outRequestNo: string; refundAmount: string }): Promise<AlipayRefundResult>;
  queryRefund(input: { outTradeNo: string; outRequestNo: string }): Promise<AlipayRefundQueryResult | null>;
  verifyNotification(params: URLSearchParams): Promise<boolean>;
}
```

Use `AbortSignal.timeout(10_000)` for gateway requests. Verify the exact signed response member before accepting any response. Page pay returns a complete minimal auto-submit HTML document; escape every attribute and hidden value.

- [ ] **Step 4: Run test and verify GREEN**

Run: `npx vitest run workers/scout-connect/src/alipay-api.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/scout-connect/src/alipay-api.ts workers/scout-connect/src/alipay-api.test.ts
git commit -m "feat(connect): add signed Alipay API client"
```

---

### Task 4: Checkout creation, same-origin hop, and return UI

**Files:**
- Create: `workers/scout-connect/src/alipay-checkout.test.ts`
- Modify: `workers/scout-connect/src/routes.ts`
- Modify: `workers/scout-connect/src/html/buy-page.ts`
- Modify: `workers/scout-connect/src/html/buy-page.test.ts`
- Modify: `workers/scout-connect/src/html/payment-success-page.ts`
- Modify: `workers/scout-connect/src/html/payment-success-page.test.ts`
- Modify: `workers/scout-connect/src/http.ts`

**Interfaces:**
- Consumes: Task 1 tier registry, Task 2 order DB, Task 3 `AlipayApi.pagePayForm`
- Produces: `POST /api/alipay/checkout`, `GET /alipay/checkout`, `GET /payment-success`, status-polling shell

- [ ] **Step 1: Replace Paddle checkout assertions with failing Alipay behavior tests**

```ts
it("binds checkout to the logged-in account and ignores client amounts", async () => {
  const res = await post("/api/alipay/checkout", { tier: "quarter", total_amount: "0.01" }, session);
  expect(res.status).toBe(200);
  expect(await db.getPaymentOrderById((await res.json()).order_id)).toMatchObject({
    account_id: account.id,
    months: 3,
    total_amount: "45.00",
  });
});

it("renders only Alipay tiers and no Paddle SDK", () => {
  const html = buyPage({ alipayConfigured: true });
  expect(html).toContain("支付宝支付");
  expect(html).not.toContain("Paddle");
  expect(html).not.toContain("cdn.paddle.com");
});
```

Add tests for unauthorized, unknown tier, missing Alipay config -> 503, expired capability, repeated checkout GET reusing the same `out_trade_no`, and return page not trusting query-string status.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run workers/scout-connect/src/alipay-checkout.test.ts workers/scout-connect/src/html/buy-page.test.ts workers/scout-connect/src/html/payment-success-page.test.ts`

Expected: FAIL on Paddle-only routes and rendering.

- [ ] **Step 3: Implement checkout and hop routes**

```ts
const checkoutToken = randomCapability();
const order = await deps.db.insertPaymentOrder({
  id: deps.newPaymentOrderId(),
  checkout_token_sha256: await sha256Hex(checkoutToken),
  account_id: account.id,
  provider: "alipay",
  out_trade_no: deps.newAlipayOutTradeNo(),
  months: tier.months,
  total_amount: tier.totalAmount,
  status: "created",
  created_at: now,
  expires_at: new Date(Date.parse(now) + 20 * 60_000).toISOString(),
  trade_no: null,
  paid_at: null,
  fulfilled_at: null,
  closed_at: null,
  refunded_at: null,
  refund_request_no: null,
});
```

Return `/alipay/checkout?checkout=${checkoutToken}`. The hop loads by the SHA-256 hash of `checkoutToken`, creates the form with fixed production origins derived from the configured root domain, marks `form_issued`, and returns HTML with `no-store` and `form-action https://openapi.alipay.com`.

- [ ] **Step 4: Implement return status shell**

The page polls `/api/alipay/orders/${order.id}/status` and renders only `pending`, `paid_unfulfilled`, `fulfilled`, `closed`, `expired`. On `fulfilled`, redirect to `/console`; no Alipay return field decides success.

- [ ] **Step 5: Run tests and verify GREEN**

Run: `npx vitest run workers/scout-connect/src/alipay-checkout.test.ts workers/scout-connect/src/html/buy-page.test.ts workers/scout-connect/src/html/payment-success-page.test.ts workers/scout-connect/src/session.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add workers/scout-connect/src/alipay-checkout.test.ts workers/scout-connect/src/routes.ts workers/scout-connect/src/html/buy-page.ts workers/scout-connect/src/html/buy-page.test.ts workers/scout-connect/src/html/payment-success-page.ts workers/scout-connect/src/html/payment-success-page.test.ts workers/scout-connect/src/http.ts
git commit -m "feat(connect): add Alipay checkout and return flow"
```

---

### Task 5: Notify, trade-query compensation, and idempotent fulfillment

**Files:**
- Create: `workers/scout-connect/src/alipay-service.ts`
- Create: `workers/scout-connect/src/alipay-service.test.ts`
- Create: `workers/scout-connect/src/alipay-notify.test.ts`
- Modify: `workers/scout-connect/src/routes.ts`

**Interfaces:**
- Consumes: `AlipayApi`, payment-order DB, provider-neutral `grantEntitlement`
- Produces: `acceptAlipayPayment`, `compensateAlipayOrder`, `fulfillAlipayOrder`
- Produces: `POST /api/alipay/notify`, `GET /api/alipay/orders/:id/status`

- [ ] **Step 1: Write failing payment evidence and race tests**

```ts
it("notify and query racing grant exactly one entitlement", async () => {
  const [notify, status] = await Promise.all([
    postSignedNotify(order),
    getOwnedStatus(order.id, session),
  ]);
  expect(notify.status).toBe(200);
  expect((await db.listEntitlements(account.id)).filter((e) => e.payment_provider === "alipay")).toHaveLength(1);
  expect(await statusState(status)).toMatch(/paid_unfulfilled|fulfilled/);
});
```

Add invalid signature, wrong app, wrong amount, wrong order, non-paid status, D1 failure causing non-`success`, query response bad signature, cross-account 404, `WAIT_BUYER_PAY` not cached terminally, and paid-but-first-grant-failed recovery.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run workers/scout-connect/src/alipay-service.test.ts workers/scout-connect/src/alipay-notify.test.ts workers/scout-connect/src/alipay-checkout.test.ts`

Expected: FAIL because notify/status services are missing.

- [ ] **Step 3: Implement shared evidence acceptance and fulfillment**

```ts
export async function fulfillAlipayOrder(order: PaymentOrderRow, deps: AlipayServiceDeps): Promise<PaymentOrderStatus> {
  if (order.status === "fulfilled") return "fulfilled";
  const account = await deps.db.getAccountById(order.account_id);
  if (!account) throw new Error("payment account missing");
  await grantEntitlement({
    accountId: account.id,
    email: account.email,
    months: order.months,
    source: "alipay",
    paymentProvider: "alipay",
    paymentTransactionId: order.out_trade_no,
  }, deps);
  await deps.db.updatePaymentOrder(order.id, { status: "fulfilled", fulfilled_at: deps.now() });
  return "fulfilled";
}
```

Validate evidence before setting `paid`. If grant fails, retain `paid` so notify retry and status query can repair it. D1 uniqueness plus ledger reconciliation supplies concurrency safety.

- [ ] **Step 4: Implement route responses**

Notify reads the capped raw form, verifies, accepts evidence, fulfills, then returns exactly `success`. Status requires session ownership and invokes query compensation only for non-terminal states.

- [ ] **Step 5: Run tests and verify GREEN**

Run: `npx vitest run workers/scout-connect/src/alipay-service.test.ts workers/scout-connect/src/alipay-notify.test.ts workers/scout-connect/src/alipay-checkout.test.ts workers/scout-connect/src/grant.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add workers/scout-connect/src/alipay-service.ts workers/scout-connect/src/alipay-service.test.ts workers/scout-connect/src/alipay-notify.test.ts workers/scout-connect/src/routes.ts
git commit -m "feat(connect): fulfill Alipay payments idempotently"
```

---

### Task 6: Close, full refund, refund query, and immediate entitlement removal

**Files:**
- Create: `workers/scout-connect/src/alipay-admin.test.ts`
- Modify: `workers/scout-connect/src/alipay-service.ts`
- Modify: `workers/scout-connect/src/alipay-service.test.ts`
- Modify: `workers/scout-connect/src/routes.ts`
- Modify: `workers/scout-connect/src/revoke.ts`
- Modify: `workers/scout-connect/src/revoke.test.ts`

**Interfaces:**
- Consumes: `AlipayApi.closeTrade`, `refundTrade`, `queryRefund`; entitlement reconciler; `revokeEndpoint`
- Produces: logged-in close action, `POST /api/admin/alipay/refund`, `GET /api/admin/alipay/refund/:requestNo`

- [ ] **Step 1: Write failing close/refund tests**

```ts
it("full refund removes only that purchase and revokes when no time remains", async () => {
  await seedFulfilledOrder({ months: 3, totalAmount: "45.00" });
  const res = await adminRefund({ order_id: order.id }, ADMIN_TOKEN);
  expect(res.status).toBe(200);
  expect(await currentExpiry(account.id)).toBeNull();
  expect(cf.deleteTunnel).toHaveBeenCalledTimes(1);
});
```

Add admin auth, exact amount, refund response bad signature, repeat refund, refund query, close unpaid, close already-paid -> query path, and refund one of multiple stacked purchases without revoking a still-entitled endpoint.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run workers/scout-connect/src/alipay-admin.test.ts workers/scout-connect/src/alipay-service.test.ts workers/scout-connect/src/revoke.test.ts`

Expected: FAIL on missing routes and refund reconciliation.

- [ ] **Step 3: Implement close and administrator refund**

```ts
const outRequestNo = deps.newAlipayRefundRequestNo();
const refunded = await deps.alipayApi.refundTrade({
  outTradeNo: order.out_trade_no,
  outRequestNo,
  refundAmount: order.total_amount,
});
await deps.db.markEntitlementRefunded("alipay", order.out_trade_no, deps.now());
const remainingExpiry = await reconcileEntitlementLedger(order.account_id, deps.db);
await deps.db.updatePaymentOrder(order.id, {
  status: "refunded",
  refunded_at: deps.now(),
  refund_request_no: outRequestNo,
});
```

If no active entitlement remains, look up the account's active endpoint and call `revokeEndpoint` with an explicit payment-refund audit actor/action. A Cloudflare deletion failure returns a retryable error and leaves the refund/order state observable for repair; it never repeats the Alipay refund with a new request number.

- [ ] **Step 4: Implement refund query and close state convergence**

Query by stored `refund_request_no`, never by arbitrary client amount. Close only an owned unpaid order. When Alipay reports already paid, call query compensation instead of forcing `closed`.

- [ ] **Step 5: Run tests and verify GREEN**

Run: `npx vitest run workers/scout-connect/src/alipay-admin.test.ts workers/scout-connect/src/alipay-service.test.ts workers/scout-connect/src/revoke.test.ts workers/scout-connect/src/expiry-sweep.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add workers/scout-connect/src/alipay-admin.test.ts workers/scout-connect/src/alipay-service.ts workers/scout-connect/src/alipay-service.test.ts workers/scout-connect/src/routes.ts workers/scout-connect/src/revoke.ts workers/scout-connect/src/revoke.test.ts
git commit -m "feat(connect): close and refund Alipay orders"
```

---

### Task 7: Worker wiring, Paddle removal, and compliance content

**Files:**
- Modify: `workers/scout-connect/src/env.ts`
- Modify: `workers/scout-connect/src/index.ts`
- Modify: `workers/scout-connect/src/routes.ts`
- Modify: `workers/scout-connect/src/http.ts`
- Modify: `workers/scout-connect/wrangler.jsonc`
- Modify: `workers/scout-connect/src/content/pricing.md`
- Modify: `workers/scout-connect/src/content/refund.md`
- Modify: `workers/scout-connect/src/content/terms.md`
- Modify: `workers/scout-connect/src/content/contact.md`
- Regenerate: `workers/scout-connect/src/html/compliance-content.gen.ts`
- Delete: `workers/scout-connect/src/paddle-api.ts`
- Delete: `workers/scout-connect/src/paddle-event.ts`
- Delete: `workers/scout-connect/src/paddle-signature.ts`
- Delete: `workers/scout-connect/src/paddle-api-scope.test.ts`
- Delete: `workers/scout-connect/src/paddle-api-status.test.ts`
- Delete: `workers/scout-connect/src/paddle-checkout.test.ts`
- Delete: `workers/scout-connect/src/paddle-config-guard.test.ts`
- Delete: `workers/scout-connect/src/paddle-event.test.ts`
- Delete: `workers/scout-connect/src/paddle-signature.test.ts`
- Delete: `workers/scout-connect/src/paddle-webhook.test.ts`

**Interfaces:**
- Consumes: `createAlipayApi` and all implemented routes
- Produces: Worker `Env` with `ALIPAY_APP_ID`, `ALIPAY_PRIVATE_KEY`, `ALIPAY_ALIPAY_PUBLIC_KEY`, optional `ALIPAY_SELLER_ID`; no `PADDLE_*`

- [ ] **Step 1: Write failing wiring and no-Paddle tests**

```ts
it("contains no active Paddle checkout route or client SDK", () => {
  expect(workerSources()).not.toMatch(/PADDLE_|Paddle\.Checkout|cdn\.paddle\.com|api\/paddle\/webhook/);
});

it("describes Alipay as the only processor without Merchant of Record claims", () => {
  expect(COMPLIANCE_MARKDOWN.pricing).toContain("支付宝");
  expect(COMPLIANCE_MARKDOWN.pricing).not.toContain("Paddle");
  expect(COMPLIANCE_MARKDOWN.terms).not.toContain("Merchant of Record");
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run workers/scout-connect/src/routes.test.ts workers/scout-connect/src/html/buy-page.test.ts workers/scout-connect/src/html/compliance-page.test.ts workers/scout-connect/src/schema.test.ts`

Expected: FAIL because active Paddle source/config/copy remains.

- [ ] **Step 3: Wire Alipay environment and remove Paddle runtime**

```ts
const alipayApi = [env.ALIPAY_APP_ID, env.ALIPAY_PRIVATE_KEY, env.ALIPAY_ALIPAY_PUBLIC_KEY]
  .every((value) => typeof value === "string" && value.trim() !== "")
  ? createAlipayApi({
      appId: env.ALIPAY_APP_ID!,
      privateKeyPem: env.ALIPAY_PRIVATE_KEY!,
      alipayPublicKeyPem: env.ALIPAY_ALIPAY_PUBLIC_KEY!,
    })
  : undefined;
```

Remove Paddle imports, `RouteDeps`, routes, CSP options, wrangler vars, files, and tests. Historical schema fields/data remain.

- [ ] **Step 4: Rewrite and regenerate compliance content**

Pricing states CNY and Alipay only. Terms identify DF Digital as operator/seller without Paddle buyer terms. Refund requests go through support email and return via the original Alipay transaction. Contact copy removes Paddle invoice claims.

Run: `node workers/scout-connect/scripts/generate-content.mjs`

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npx vitest run workers/scout-connect/src/routes.test.ts workers/scout-connect/src/html/buy-page.test.ts workers/scout-connect/src/html/payment-success-page.test.ts workers/scout-connect/src/html/compliance-page.test.ts workers/scout-connect/src/schema.test.ts`

Expected: PASS.

- [ ] **Step 6: Run active-tree residue scan**

Run: `rg -n "PADDLE_|Paddle\.Checkout|cdn\.paddle\.com|/api/paddle/webhook|Merchant of Record" workers/scout-connect/src workers/scout-connect/wrangler.jsonc`

Expected: no active runtime/config/customer-copy matches. Historical migration column comments are permitted only where required to preserve old data.

- [ ] **Step 7: Commit**

```bash
git add workers/scout-connect
git commit -m "refactor(connect): remove Paddle checkout runtime"
```

---

### Task 8: Full verification, sandbox, review, and deployment gates

**Files:**
- Modify only files required by failures found in this task
- Record evidence in the PR body; do not store secrets or raw payment payloads

**Interfaces:**
- Consumes: complete Alipay-only checkout implementation
- Produces: merge-ready PR and explicit list of manual production gates

- [ ] **Step 1: Run focused payment suite**

Run: `npx vitest run workers/scout-connect/src/alipay-crypto.test.ts workers/scout-connect/src/alipay-order.test.ts workers/scout-connect/src/alipay-api.test.ts workers/scout-connect/src/alipay-service.test.ts workers/scout-connect/src/alipay-checkout.test.ts workers/scout-connect/src/alipay-notify.test.ts workers/scout-connect/src/alipay-admin.test.ts`

Expected: PASS.

- [ ] **Step 2: Run repository verification**

Run: `npm run build:workflow`

Run: `npx vitest run`

Run: `npm run typecheck`

Run: `npx tsc -p workers/scout-connect/tsconfig.json`

Expected: all commands exit 0. If `apps/web/**` changed, also run `npx tsc -p apps/web/tsconfig.json` and `npm run build:web`.

- [ ] **Step 3: Run Alipay Skill checklist and sandbox preparation**

Use the current `alipay-aipay` Integration flow for `webpay`. Confirm the Worker reads the validated project sandbox configuration only at runtime and that secrets/config are ignored by Git. Start the local Worker and provide the real browser sandbox checkout entry and both supported payer experience methods. Mark public notify integration pending when no public HTTPS local callback exists.

- [ ] **Step 4: Commit any verification-only fixes**

```bash
git add workers/scout-connect
git commit -m "test(connect): harden Alipay checkout verification"
```

Skip this commit when Step 2 required no source changes.

- [ ] **Step 5: Push and open PR**

```bash
git push -u origin codex/mediary-connect-alipay
gh pr create --base main --head codex/mediary-connect-alipay --title "Replace Mediary Connect Paddle checkout with Alipay" --body $'## Summary\n- replace every active Mediary Connect Paddle checkout path with Alipay web pay\n- preserve prices, entitlement durations, and historical Paddle records\n- add verified notify, query compensation, close, refund, and refund-query flows\n\n## Verification\n- npx vitest run\n- npm run typecheck\n- npx tsc -p workers/scout-connect/tsconfig.json\n\n## Production gates\n- configure Alipay Worker secrets manually\n- apply the D1 migration before traffic cutover\n- complete one non-merchant real-payment acceptance test'
```

The PR body includes test commands/results, migration risk, historical Paddle preservation, secret/manual gates, and sandbox evidence without sensitive values.

- [ ] **Step 6: Wait for CI and current-HEAD Copilot review**

Confirm `build-and-test` is green. Request `@copilot`, wait until the review `commit_id` equals branch HEAD, inspect inline comments and the review body including collapsed low-confidence details, fix only verified findings, rerun affected tests, push, and request a fresh review for the new HEAD.

- [ ] **Step 7: Merge and deploy only after review**

Squash merge with required `Co-Authored-By`. Deploy merged `main` through the repository's Worker deployment path; do not patch production source directly. Apply D1 migration before serving Alipay orders and verify `/buy`, notify route reachability, return page, and status endpoint.

- [ ] **Step 8: Complete manual production gates**

The user writes `ALIPAY_APP_ID`, `ALIPAY_PRIVATE_KEY`, and `ALIPAY_ALIPAY_PUBLIC_KEY` into the Connect Worker secrets and updates the Alipay application for `mediaryconnect.app` if required. A non-merchant payer completes a real ¥45/¥108/¥188 purchase. Verify the exact order becomes `fulfilled`, the same 3/12/24-month entitlement appears, console/provisioning work, and logs contain no secret or raw signed payload.

- [ ] **Step 9: Refund only with separate exact-order authorization**

Do not run a production refund as part of routine smoke testing. If the user explicitly identifies and authorizes a real order, execute the admin refund, verify refund query, entitlement recomputation, endpoint behavior, and original-payment return.
