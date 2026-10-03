import { describe, expect, it, vi } from "vitest";

// @ts-expect-error Vitest runtime supports virtual mocks, but v4 typings omit the option.
vi.mock("server-only", () => ({}), { virtual: true });

import { connectSlugReasonText, nextLinkPollDelayMs, stepForAccount } from "./connect-wizard";

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
