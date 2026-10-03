import { describe, expect, it, vi } from "vitest";

// @ts-expect-error Vitest runtime supports virtual mocks, but v4 typings omit the option.
vi.mock("server-only", () => ({}), { virtual: true });

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("../../app/connect-actions", () => ({}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectWizard, connectSlugReasonText, nextLinkPollDelayMs, paymentOutcome, probeVerdict, stepForAccount } from "./connect-wizard";

describe("ConnectWizard reachability probe after 接入", () => {
  it("stops on success, and stops with the instance to blame when the tunnel answers 503", () => {
    expect(probeVerdict({ ok: true, detail: "reachable" })).toBe("reachable");
    // A 503 came back through the tunnel: the tunnel works, the instance does not.
    expect(probeVerdict({ ok: false, detail: "instance_problem" })).toBe("instance_problem");
  });

  it("keeps trying while the name does not answer yet", () => {
    expect(probeVerdict({ ok: false, detail: "unreachable" })).toBe("retry");
    expect(probeVerdict({ ok: false, detail: "no_hostname" })).toBe("retry");
  });
});

describe("ConnectWizard with a payment page open while the account cannot be read", () => {
  it("still offers the payment page and 不付了 next to 重试", () => {
    const html = renderToStaticMarkup(
      createElement(ConnectWizard, {
        linked: true,
        email: "a@b.c",
        pending: null,
        account: null,
        hasTunnelToken: false,
        passwordSet: true,
        pendingOrder: { orderId: "ord_1", checkoutUrl: "https://pay.example/ord_1" },
      }),
    );
    expect(html).toContain("暂时读不到 Mediary Connect 账号信息");
    expect(html).toContain('href="https://pay.example/ord_1"');
    expect(html).toMatch(/<button[^>]*>不付了<\/button>/);
  });
});

describe("ConnectWizard while waiting for the email confirmation", () => {
  it("offers a way back to use another address or send again", () => {
    const html = renderToStaticMarkup(
      createElement(ConnectWizard, {
        linked: false,
        email: null,
        pending: { email: "typo@example.com", verifyCode: "ABCD", expiresAt: "2999-01-01T00:00:00.000Z" },
        account: null,
        hasTunnelToken: false,
        passwordSet: true,
      }),
    );
    expect(html).toContain("确认码：ABCD");
    expect(html).toMatch(/<button[^>]*>换个邮箱或重新发送<\/button>/);
  });
});

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

describe("ConnectWizard when this instance's tunnel serves another name", () => {
  const account = {
    email: "a@b.c",
    active: true,
    expiresAt: "2027-01-03T00:00:00.000Z",
    endpoint: { slug: "new", hostname: "new.mediaryconnect.app", status: "active" },
    checkoutOpen: true,
    tiers: [],
  };

  it("goes to 接入 for the linked account's name instead of treating the old tunnel as its own", () => {
    expect(stepForAccount(account, true, "old.mediaryconnect.app")).toBe(5);
    expect(paymentOutcome(account, true, "old.mediaryconnect.app")).toEqual({ step: 5, renewal: false });
  });

  it("treats the tunnel as the account's own when the names match", () => {
    expect(stepForAccount(account, true, "new.mediaryconnect.app")).toBe(3);
    expect(paymentOutcome(account, true, "new.mediaryconnect.app")).toEqual({ step: 3, renewal: true });
  });

  it("keeps trusting the tunnel when this instance does not know its name (connected by an older connect.sh)", () => {
    expect(stepForAccount(account, true, null)).toBe(3);
    expect(paymentOutcome(account, true, null)).toEqual({ step: 3, renewal: true });
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
