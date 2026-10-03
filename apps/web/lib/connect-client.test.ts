import { beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Vitest runtime supports virtual mocks, but v4 typings omit the option.
vi.mock("server-only", () => ({}), { virtual: true });

import {
  checkConnectSlug,
  createConnectCheckout,
  exchangeClaimCode,
  getConnectAccount,
  getConnectOrderStatus,
  issueClaimCode,
  pollInstanceLink,
  provisionConnectSlug,
  revokeInstanceLink,
  startInstanceLink,
} from "./connect-client";

const BASE = "https://connect.test";
const CREDENTIAL = "ic_secret";

function response(body: unknown, status = 200): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fetchOnce(expected: (url: string, init: RequestInit) => void, body: unknown, status = 200): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    expected(url, init);
    return response(body, status);
  }) as typeof fetch;
}

function jsonBody(init: RequestInit): unknown {
  return JSON.parse(String(init.body));
}

function auth(init: RequestInit): string {
  return String(header(init, "authorization"));
}

function header(init: RequestInit, name: string): string | undefined {
  const headers = init.headers as Record<string, string>;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

describe("connect-client", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("starts an instance link with the expected request and validates the response", async () => {
    const result = await startInstanceLink("owner@example.com", {
      baseUrl: BASE,
      fetchImpl: fetchOnce(
        (url, init) => {
          expect(url).toBe(`${BASE}/api/instance-link/start`);
          expect(init.method).toBe("POST");
          expect(header(init, "content-type")).toBe("application/json");
          expect(jsonBody(init)).toEqual({ email: "owner@example.com" });
          expect(init.signal).toBeDefined();
        },
        { pollSecret: "poll", verifyCode: "7K3P", expiresAt: "2026-10-03T00:30:00.000Z", interval: 3 },
        202,
      ),
    });
    expect(result).toEqual({
      ok: true,
      pollSecret: "poll",
      verifyCode: "7K3P",
      expiresAt: "2026-10-03T00:30:00.000Z",
      interval: 3,
    });
  });

  it("maps any bad start request response to bad_email", async () => {
    const result = await startInstanceLink("not-an-email", {
      baseUrl: BASE,
      fetchImpl: fetchOnce(() => {}, { unexpected: true }, 400),
    });
    expect(result).toEqual({ ok: false, reason: "bad_email", message: "请输入有效的邮箱地址。" });
  });

  it("polls an instance link without auth and preserves pending and approved states", async () => {
    const pending = await pollInstanceLink("poll", {
      baseUrl: BASE,
      fetchImpl: fetchOnce(
        (url, init) => {
          expect(url).toBe(`${BASE}/api/instance-link/poll`);
          expect(init.method).toBe("POST");
          expect(jsonBody(init)).toEqual({ pollSecret: "poll" });
          expect((init.headers as Record<string, string>).authorization).toBeUndefined();
        },
        { status: "pending" },
      ),
    });
    expect(pending).toEqual({ ok: true, status: "pending" });

    const approved = await pollInstanceLink("poll", {
      baseUrl: BASE,
      fetchImpl: fetchOnce(() => {}, { status: "approved", credential: CREDENTIAL, email: "owner@example.com" }),
    });
    expect(approved).toEqual({ ok: true, status: "approved", credential: CREDENTIAL, email: "owner@example.com" });
  });

  it("revokes a credential with bearer auth", async () => {
    const result = await revokeInstanceLink(CREDENTIAL, {
      baseUrl: BASE,
      fetchImpl: fetchOnce(
        (url, init) => {
          expect(url).toBe(`${BASE}/api/instance-link/revoke`);
          expect(init.method).toBe("POST");
          expect(auth(init)).toBe(`Bearer ${CREDENTIAL}`);
          expect(init.body).toBeUndefined();
        },
        { ok: true },
      ),
    });
    expect(result).toEqual({ ok: true });
  });

  it("reads the account with all nested fields validated", async () => {
    const account = {
      email: "owner@example.com",
      active: true,
      expiresAt: "2027-01-03T04:58:55.825Z",
      endpoint: { slug: "owner", hostname: "owner.mediaryconnect.app", status: "active" },
      checkoutOpen: true,
      tiers: [{ id: "year", label: "年度", months: 12, price: "108.00", featured: true }],
    };
    const result = await getConnectAccount(CREDENTIAL, {
      baseUrl: BASE,
      fetchImpl: fetchOnce(
        (url, init) => {
          expect(url).toBe(`${BASE}/api/account`);
          expect(init.method).toBe("GET");
          expect(auth(init)).toBe(`Bearer ${CREDENTIAL}`);
        },
        account,
      ),
    });
    expect(result).toEqual({ ok: true, ...account });
  });

  it("creates checkout with tier and return URL", async () => {
    const result = await createConnectCheckout(CREDENTIAL, "year", "http://scout/settings?tab=remote", {
      baseUrl: BASE,
      fetchImpl: fetchOnce(
        (url, init) => {
          expect(url).toBe(`${BASE}/api/checkout`);
          expect(init.method).toBe("POST");
          expect(auth(init)).toBe(`Bearer ${CREDENTIAL}`);
          expect(jsonBody(init)).toEqual({ tier: "year", returnUrl: "http://scout/settings?tab=remote" });
        },
        { checkoutUrl: "https://pay.test/order", orderId: "ord_1" },
      ),
    });
    expect(result).toEqual({ ok: true, checkoutUrl: "https://pay.test/order", orderId: "ord_1" });
  });

  it("gets an order status", async () => {
    const result = await getConnectOrderStatus(CREDENTIAL, "ord_1", {
      baseUrl: BASE,
      fetchImpl: fetchOnce(
        (url, init) => {
          expect(url).toBe(`${BASE}/api/orders/ord_1/status`);
          expect(auth(init)).toBe(`Bearer ${CREDENTIAL}`);
        },
        { status: "fulfilled" },
      ),
    });
    expect(result).toEqual({ ok: true, status: "fulfilled" });
  });

  it("checks and provisions a slug", async () => {
    const checked = await checkConnectSlug(CREDENTIAL, "my-name", {
      baseUrl: BASE,
      fetchImpl: fetchOnce(
        (url, init) => {
          expect(url).toBe(`${BASE}/api/slug/check?s=my-name`);
          expect(auth(init)).toBe(`Bearer ${CREDENTIAL}`);
        },
        { available: false, reason: "taken", suggestions: ["my-name-2"] },
      ),
    });
    expect(checked).toEqual({ ok: true, available: false, reason: "taken", suggestions: ["my-name-2"] });

    const provisioned = await provisionConnectSlug(CREDENTIAL, "my-name", {
      baseUrl: BASE,
      fetchImpl: fetchOnce(
        (url, init) => {
          expect(url).toBe(`${BASE}/api/provision`);
          expect(init.method).toBe("POST");
          expect(auth(init)).toBe(`Bearer ${CREDENTIAL}`);
          expect(jsonBody(init)).toEqual({ slug: "my-name" });
        },
        { hostname: "my-name.mediaryconnect.app" },
      ),
    });
    expect(provisioned).toEqual({ ok: true, hostname: "my-name.mediaryconnect.app" });
  });

  it("maps provision status codes to contract reasons regardless of error body", async () => {
    const noEntitlement = await provisionConnectSlug(CREDENTIAL, "my-name", {
      baseUrl: BASE,
      fetchImpl: fetchOnce(() => {}, { anything: "else" }, 402),
    });
    expect(noEntitlement).toEqual({ ok: false, reason: "no_entitlement", message: "请先购买有效时长。" });

    const badSlug = await provisionConnectSlug(CREDENTIAL, "my-name", {
      baseUrl: BASE,
      fetchImpl: fetchOnce(() => {}, { anything: "else" }, 400),
    });
    expect(badSlug).toEqual({ ok: false, reason: "bad_slug", message: "这个名字格式不对，请换一个。" });

    const atCapacity = await provisionConnectSlug(CREDENTIAL, "my-name", {
      baseUrl: BASE,
      fetchImpl: fetchOnce(() => {}, { error: "at capacity" }, 503),
    });
    expect(atCapacity).toEqual({ ok: false, reason: "at_capacity", message: "暂时售罄，请稍后再试。" });
  });

  it("keeps the two expected provision conflict mappings", async () => {
    const alreadyProvisioned = await provisionConnectSlug(CREDENTIAL, "my-name", {
      baseUrl: BASE,
      fetchImpl: fetchOnce(() => {}, { error: "already provisioned" }, 409),
    });
    expect(alreadyProvisioned).toMatchObject({ ok: false, reason: "already_provisioned" });

    const slugTaken = await provisionConnectSlug(CREDENTIAL, "my-name", {
      baseUrl: BASE,
      fetchImpl: fetchOnce(() => {}, { error: "slug taken" }, 409),
    });
    expect(slugTaken).toMatchObject({ ok: false, reason: "slug_taken" });
  });

  it("issues and exchanges a claim code", async () => {
    const issued = await issueClaimCode(CREDENTIAL, {
      baseUrl: BASE,
      fetchImpl: fetchOnce(
        (url, init) => {
          expect(url).toBe(`${BASE}/api/claim-code`);
          expect(init.method).toBe("POST");
          expect(auth(init)).toBe(`Bearer ${CREDENTIAL}`);
          expect(init.body).toBeUndefined();
        },
        { code: "claim-code", expires_at: "2026-10-03T00:10:00.000Z" },
      ),
    });
    expect(issued).toEqual({ ok: true, code: "claim-code", expires_at: "2026-10-03T00:10:00.000Z" });

    const exchanged = await exchangeClaimCode("claim-code", {
      baseUrl: BASE,
      fetchImpl: fetchOnce(
        (url, init) => {
          expect(url).toBe(`${BASE}/api/claim/exchange`);
          expect(init.method).toBe("POST");
          expect((init.headers as Record<string, string>).authorization).toBeUndefined();
          expect(jsonBody(init)).toEqual({ code: "claim-code" });
        },
        { hostname: "my-name.mediaryconnect.app", token: "tunnel-token" },
      ),
    });
    expect(exchanged).toEqual({ ok: true, hostname: "my-name.mediaryconnect.app", token: "tunnel-token" });
  });

  it("rejects an exchanged hostname the rest of the app could not use", async () => {
    // Same hostname contract as remote-access: the last label is an alphabetic TLD.
    for (const hostname of ["a.b", "name.example.1"]) {
      const exchanged = await exchangeClaimCode("claim-code", {
        baseUrl: BASE,
        fetchImpl: fetchOnce(() => {}, { hostname, token: "tunnel-token" }),
      });
      expect(exchanged.ok).toBe(false);
    }
  });

  it("says an order is not found when Connect does not know it for this account", async () => {
    const result = await getConnectOrderStatus(CREDENTIAL, "ord_other", {
      baseUrl: BASE,
      fetchImpl: fetchOnce(() => {}, { error: "not found" }, 404),
    });
    expect(result).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("maps generic Connect failures without echoing secrets", async () => {
    const secret = `${CREDENTIAL}-do-not-echo`;
    const unauthorized = await getConnectAccount(secret, {
      baseUrl: BASE,
      fetchImpl: fetchOnce(() => {}, { error: "unauthorized" }, 401),
    });
    expect(unauthorized).toMatchObject({ ok: false, reason: "unauthorized" });
    expect(JSON.stringify(unauthorized)).not.toContain(secret);

    const limited = await startInstanceLink("owner@example.com", {
      baseUrl: BASE,
      fetchImpl: fetchOnce(() => {}, { error: "too_many_requests" }, 429),
    });
    expect(limited).toEqual({ ok: false, reason: "rate_limited", message: "请求太频繁了，过几分钟再试。" });

    const offline = await exchangeClaimCode("claim-code", {
      baseUrl: BASE,
      fetchImpl: (async () => {
        throw new Error(`offline ${secret}`);
      }) as typeof fetch,
    });
    expect(offline).toEqual({
      ok: false,
      reason: "unreachable",
      message: "连不上 Mediary Connect，检查这台机器能不能访问外网。",
    });
    expect(JSON.stringify(offline)).not.toContain(secret);
  });

  it("maps 401, 429, and network failures consistently for every call", async () => {
    const calls = [
      () => startInstanceLink("owner@example.com"),
      () => pollInstanceLink("poll"),
      () => revokeInstanceLink(CREDENTIAL),
      () => getConnectAccount(CREDENTIAL),
      () => createConnectCheckout(CREDENTIAL, "year", undefined),
      () => getConnectOrderStatus(CREDENTIAL, "ord_1"),
      () => checkConnectSlug(CREDENTIAL, "owner"),
      () => provisionConnectSlug(CREDENTIAL, "owner"),
      () => issueClaimCode(CREDENTIAL),
      () => exchangeClaimCode("claim-code"),
    ];
    for (const call of calls) {
      const unauthorized = await callWithStatus(call, 401);
      expect(unauthorized).toMatchObject({ ok: false, reason: "unauthorized" });
      const limited = await callWithStatus(call, 429);
      expect(limited).toMatchObject({ ok: false, reason: "rate_limited", message: "请求太频繁了，过几分钟再试。" });
      const offline = await callWithFetch(call, (async () => {
        throw new Error("offline");
      }) as typeof fetch);
      expect(offline).toMatchObject({ ok: false, reason: "unreachable" });
    }
  });

  it("rejects a successful response with the wrong shape", async () => {
    const result = await pollInstanceLink("poll", {
      baseUrl: BASE,
      fetchImpl: fetchOnce(() => {}, { status: "approved", credential: "missing-email" }),
    });
    expect(result).toMatchObject({ ok: false, reason: "failed" });
  });

  it("treats a malformed response body as failed, while a timeout stays unreachable", async () => {
    const malformed = await getConnectAccount(CREDENTIAL, {
      baseUrl: BASE,
      fetchImpl: (async () => ({
        status: 200,
        json: async () => {
          throw new Error("malformed");
        },
      })) as unknown as typeof fetch,
    });
    expect(malformed).toMatchObject({ ok: false, reason: "failed" });

    const timeout = await getConnectAccount(CREDENTIAL, {
      baseUrl: BASE,
      fetchImpl: (async () => ({
        status: 200,
        json: async () => {
          throw new DOMException("timed out", "TimeoutError");
        },
      })) as unknown as typeof fetch,
    });
    expect(timeout).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("does not expose HTTP status codes in user-facing failures", async () => {
    const result = await getConnectAccount(CREDENTIAL, {
      baseUrl: BASE,
      fetchImpl: fetchOnce(() => {}, { error: "unexpected" }, 503),
    });
    expect(result).toMatchObject({ ok: false, reason: "failed" });
    expect(JSON.stringify(result)).not.toContain("503");
  });
});

async function callWithStatus(call: () => Promise<unknown>, status: number): Promise<unknown> {
  return callWithFetch(call, (async () => response(undefined, status)) as typeof fetch);
}

async function callWithFetch(call: () => Promise<unknown>, fetchImpl: typeof fetch): Promise<unknown> {
  // The call closures above use the default options; this helper temporarily
  // routes global fetch so each branch exercises the real request wrapper.
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await call();
  } finally {
    globalThis.fetch = original;
  }
}
