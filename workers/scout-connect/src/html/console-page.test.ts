import { describe, expect, it } from "vitest";
import type { AccountRow, EndpointRow, EntitlementRow } from "../db.js";
import { consolePage } from "./console-page.js";

const NOW = "2026-07-28T00:00:00.000Z";
const BASE = "https://mediaryconnect.app";

const account: AccountRow = {
  id: "act_1",
  email: "buyer@example.com",
  paddle_customer_id: null,
  created_at: NOW,
  last_login_at: NOW,
};

function ent(expires_at: string): EntitlementRow {
  return {
    id: "ent_1",
    account_id: "act_1",
    expires_at,
    source: "manual",
    paddle_transaction_id: null,
    months: 3,
    created_at: NOW,
  };
}

const endpoint: EndpointRow = {
  id: "ep_1",
  invite_id: "inv_1",
  slug: "dirtyfancy",
  hostname: "dirtyfancy.mediaryconnect.app",
  cf_tunnel_id: "tid",
  cf_access_app_id: null,
  cf_access_policy_id: null,
  cf_dns_record_id: "dns_1",
  status: "active",
  token_sha256: "x",
  token_ciphertext: null,
  token_shown_at: null,
  last_seen_at: null,
  created_at: NOW,
  revoked_at: null,
  account_id: "act_1", grace_until: null, suspended_at: null, purge_after: null,
};

function base(over: Partial<Parameters<typeof consolePage>[0]>) {
  return consolePage({
    account,
    entitlements: [],
    endpoint: null,
    baseUrl: BASE,
    rootDomain: "mediaryconnect.app",
    now: NOW,
    ...over,
  });
}

describe("console page — shared dark theme", () => {
  it("is a full dark-themed document with brand bar, favicon, and the account email", () => {
    const html = base({});
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("--accent:#1ed760");
    expect(html).toContain("color-scheme:dark");
    expect(html).toContain("CONNECT");
    expect(html).toContain('rel="icon"');
    expect(html).toContain("buyer@example.com");
  });
});

describe("console page — not entitled", () => {
  it("shows a 尚未开通 badge and an 开通 CTA, no access area", () => {
    const html = base({ entitlements: [] });
    expect(html).toContain("尚未开通");
    expect(html).toContain('href="/pricing"');
    expect(html).not.toContain("获取接入命令");
  });
});

describe("console page — entitled but no endpoint yet", () => {
  it("renders the inline slug form wired to /api/slug/check + /api/provision (no dead link)", () => {
    const html = base({
      entitlements: [ent("2027-07-28T00:00:00.000Z")],
      endpoint: null,
    });
    expect(html).toContain("有效");
    expect(html).toContain("选择专属地址");
    expect(html).toContain('id="slug"');
    expect(html).toContain(".mediaryconnect.app");
    expect(html).toContain('"/api/slug/check?s="');
    expect(html).toContain('"/api/provision"');
    // 旧死链占位必须消失
    expect(html).not.toContain("/pricing#slug");
    // 未开出 endpoint,不该出现接入区
    expect(html).not.toContain("获取接入命令");
  });
});

describe("console page — entitled with active endpoint (v2 prompt-primary)", () => {
  const html = base({
    entitlements: [ent("2027-07-28T00:00:00.000Z")],
    endpoint,
  });

  it("makes the AI prompt the primary action (big box + copy button)", () => {
    expect(html).toContain("把下面这段交给你的 AI 助手");
    expect(html).toContain("获取接入命令");
    expect(html).toContain("复制提示词");
    expect(html).toContain("dirtyfancy.mediaryconnect.app");
  });

  it("demotes the raw curl command into a 或手动 <details> fold", () => {
    expect(html).toContain("<details>");
    expect(html).toContain("或者：我能直接操作那台机器");
    // 折叠区里放裸命令占位（真码由客户端注入）
    expect(html).toContain("connect.sh");
  });

  it("NEVER embeds a tunnel token; only the client-fetched claim code fills the placeholder", () => {
    expect(html).not.toMatch(/TUNNEL_TOKEN=/);
    expect(html).not.toContain(endpoint.token_sha256 === "x" ? "TUNNEL_TOKEN" : "");
    // 服务端渲染时提示词里是占位符，不是真码
    expect(html).toContain("__MEDIARY_CLAIM_CODE__");
    expect(html).toContain('"/api/claim-code"');
    expect(html).toContain("15 分钟");
  });

  it("ships the copy + generate client script only in this state", () => {
    expect(html).toContain("navigator.clipboard");
    // 未开通态不应带脚本
    const inactive = base({ entitlements: [], endpoint });
    expect(inactive).not.toContain("navigator.clipboard");
  });
});
