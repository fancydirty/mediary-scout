import { describe, expect, it, vi } from "vitest";

// @ts-expect-error Vitest runtime supports virtual mocks, but v4 typings omit the option.
vi.mock("server-only", () => ({}), { virtual: true });

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("../../app/connect-actions", () => ({}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectWizard, connectSlugReasonText, nextLinkPollDelayMs, paymentOutcome, stepForAccount } from "./connect-wizard";

describe("ConnectWizard expiry time", () => {
  it("renders the expiry in China time whatever timezone the server runs in, so hydration matches", () => {
    const previous = process.env.TZ;
    process.env.TZ = "UTC";
    try {
      const html = renderToStaticMarkup(
        createElement(ConnectWizard, {
          linked: true,
          email: "a@b.c",
          pending: null,
          account: {
            email: "a@b.c",
            active: true,
            expiresAt: "2027-01-03T16:15:29.000Z",
            endpoint: { slug: "x", hostname: "x.mediaryconnect.app", status: "active" },
            checkoutOpen: true,
            tiers: [],
          },
          hasTunnelToken: true,
          passwordSet: true,
        }),
      );
      expect(html).toContain("当前到期时间：2027/01/04 00:15");
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});

describe("ConnectWizard access password on the 接入 step", () => {
  const render = (passwordSet: boolean | "unknown") =>
    renderToStaticMarkup(
      createElement(ConnectWizard, {
        linked: true,
        email: "a@b.c",
        pending: null,
        account: {
          email: "a@b.c",
          active: true,
          expiresAt: "2027-01-03T00:00:00.000Z",
          endpoint: { slug: "x", hostname: "x.mediaryconnect.app", status: "active" },
          checkoutOpen: true,
          tiers: [],
        },
        hasTunnelToken: false,
        passwordSet,
      }),
    );

  it("offers the first-password form only when no password is set", () => {
    expect(render(false)).toContain("先设置访问密码");
  });

  it("says the password state could not be read instead of offering first-time setup, and keeps 接入 off", () => {
    const html = render("unknown");
    expect(html).not.toContain("先设置访问密码");
    expect(html).toContain("暂时读不到访问密码的状态");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>接入<\/button>/);
  });
});

describe("ConnectWizard copy", () => {
  it.each([
    ["reserved", "这个名字被保留了（可能与商标冲突）"],
    ["invalid", "这个名字不符合规则"],
    ["taken", "这个名字已被占用"],
  ])("uses the console wording for %s slugs", (reason, expected) => {
    expect(connectSlugReasonText(reason)).toBe(expected);
  });
});

describe("ConnectWizard step after the account is read", () => {
  const account = (over: Partial<{ active: boolean; endpoint: { slug: string; hostname: string; status: string } | null }>) => ({
    email: "a@b.c",
    active: true,
    expiresAt: "2027-01-03T00:00:00.000Z",
    endpoint: { slug: "x", hostname: "x.mediaryconnect.app", status: "active" },
    checkoutOpen: true,
    tiers: [],
    ...over,
  });

  it("asks for time when the account has none", () => {
    expect(stepForAccount(account({ active: false, endpoint: null }), false)).toBe(3);
  });

  it("asks for a name when time is active but nothing is provisioned", () => {
    expect(stepForAccount(account({ endpoint: null }), false)).toBe(4);
  });

  it("goes straight to connecting when the account already paid and picked a name elsewhere", () => {
    expect(stepForAccount(account({}), false)).toBe(5);
  });

  it("offers renewal once this instance already has its tunnel", () => {
    expect(stepForAccount(account({}), true)).toBe(3);
  });
});

describe("ConnectWizard after a payment is confirmed", () => {
  const account = (endpoint: { slug: string; hostname: string; status: string } | null) => ({
    email: "a@b.c",
    active: true,
    expiresAt: "2027-01-03T00:00:00.000Z",
    endpoint,
    checkoutOpen: true,
    tiers: [],
  });
  const endpoint = { slug: "x", hostname: "x.mediaryconnect.app", status: "active" };

  it("reports a renewal and stays put when this instance's tunnel serves the account's name", () => {
    expect(paymentOutcome(account(endpoint), true)).toEqual({ step: 3, renewal: true });
  });

  it("asks for a name when the account has none, even if an old tunnel token is still here", () => {
    // Another account linked, or the old name was reclaimed after expiry.
    expect(paymentOutcome(account(null), true)).toEqual({ step: 4, renewal: false });
  });

  it("goes on to name or 接入 for a first purchase", () => {
    expect(paymentOutcome(account(null), false)).toEqual({ step: 4, renewal: false });
    expect(paymentOutcome(account(endpoint), false)).toEqual({ step: 5, renewal: false });
  });
});

describe("ConnectWizard link polling delay", () => {
  it("polls at the interval Connect asked for", () => {
    expect(nextLinkPollDelayMs(3_000, 5, false)).toBe(5_000);
  });

  it("backs off by two seconds on slow_down, up to ten seconds", () => {
    expect(nextLinkPollDelayMs(3_000, 3, true)).toBe(5_000);
    expect(nextLinkPollDelayMs(9_000, 3, true)).toBe(10_000);
  });

  it("falls back to three seconds when the interval is missing or nonsense", () => {
    expect(nextLinkPollDelayMs(3_000, undefined, false)).toBe(3_000);
    expect(nextLinkPollDelayMs(3_000, 0, false)).toBe(3_000);
    expect(nextLinkPollDelayMs(3_000, 600, false)).toBe(10_000);
  });
});
