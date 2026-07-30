import { describe, expect, it } from "vitest";
import { createMemoryConnectDb, type ConnectDb } from "./db.js";
import { sweepExpiredEndpoints, type SweepDeps } from "./expiry-sweep.js";
import type { CfApi } from "./cf-api.js";

const NOW = "2026-07-30T12:00:00.000Z";

function fakeCf(calls: string[]): CfApi {
  return {
    async createTunnel() {
      return { tunnelId: "t", token: "tok" };
    },
    async getTunnelToken() {
      return "tok";
    },
    async putTunnelIngress() {},
    async createDnsCname() {
      return { recordId: "r" };
    },
    async createAccessApp() {
      return { appId: "a", policyId: "p" };
    },
    async deleteTunnel(id: string) {
      calls.push(`delTunnel:${id}`);
    },
    async deleteDnsRecord(id: string) {
      calls.push(`delDns:${id}`);
    },
    async deleteAccessApp(id: string) {
      calls.push(`delAccess:${id}`);
    },
  } as unknown as CfApi;
}

function setup(over: Partial<SweepDeps> = {}): {
  db: ConnectDb;
  deps: SweepDeps;
  cfCalls: string[];
  emails: { to: string; subject: string }[];
} {
  const db = createMemoryConnectDb();
  const cfCalls: string[] = [];
  const emails: { to: string; subject: string }[] = [];
  let n = 0;
  const deps: SweepDeps = {
    db,
    cf: fakeCf(cfCalls),
    now: () => NOW,
    newAuditId: () => `aud_${++n}`,
    sendEmail: async (input) => {
      emails.push({ to: input.to, subject: input.subject });
    },
    ...over,
  };
  return { db, deps, cfCalls, emails };
}

async function seed(
  db: ConnectDb,
  id: string,
  email: string,
  expiresAt: string | null,
  status = "active",
): Promise<void> {
  await db.insertAccount({
    id: `acct_${id}`,
    email,
    paddle_customer_id: null,
    created_at: NOW,
    last_login_at: null,
  });
  if (expiresAt !== null) {
    await db.insertEntitlement({
      id: `ent_${id}`,
      account_id: `acct_${id}`,
      expires_at: expiresAt,
      source: "manual",
      paddle_transaction_id: null,
      months: 12,
      created_at: NOW,
    });
  }
  await db.insertEndpoint({
    id,
    invite_id: null,
    slug: id,
    hostname: `${id}.mediaryconnect.app`,
    cf_tunnel_id: `t_${id}`,
    cf_access_app_id: null,
    cf_access_policy_id: null,
    cf_dns_record_id: `d_${id}`,
    status,
    token_sha256: `sha_${id}`,
    token_ciphertext: null,
    token_shown_at: null,
    last_seen_at: null,
    created_at: NOW,
    revoked_at: null,
    account_id: `acct_${id}`,
    grace_until: null,
    suspended_at: null,
    purge_after: null,
  } as never);
}

describe("sweepExpiredEndpoints —— 到期状态机执行层", () => {
  it("时钟坏(NaN now)整轮中止,绝不碰任何资源", async () => {
    const { db, deps, cfCalls } = setup({ now: () => "BAD" });
    await seed(db, "ep1", "a@e.com", "2026-07-01T00:00:00.000Z"); // 已过期
    await expect(sweepExpiredEndpoints(deps)).rejects.toThrow("non-finite now");
    expect(cfCalls).toEqual([]);
  });

  it("dry-run 默认:不删任何 CF 资源、不发邮件,只记审计", async () => {
    const { db, deps, cfCalls, emails } = setup(); // live 未传 = false
    await seed(db, "ep_remind", "remind@e.com", "2026-08-06T12:00:00.000Z"); // 7 天后
    await seed(db, "ep_grace", "grace@e.com", "2026-07-29T00:00:00.000Z"); // 宽限中
    await seed(db, "ep_expired", "expired@e.com", "2026-07-01T00:00:00.000Z"); // 已回收
    const r = await sweepExpiredEndpoints(deps);
    expect(r.dryRun).toBe(true);
    expect(r.scanned).toBe(3);
    expect(cfCalls, "dry-run 不得删任何 CF 资源").toEqual([]);
    // dry-run 即便传了 sendEmail 也不得真发 —— 这是最关键的护栏。
    expect(emails, "dry-run 不得发邮件").toEqual([]);
    expect(r.reclaimed, "dry-run 不计真回收").toBe(0);
    const audits = await db.listAudits();
    expect(audits.some((a) => a.action === "expiry.remind.7d")).toBe(true);
    expect(audits.some((a) => a.action === "expiry.in_grace")).toBe(true);
    expect(audits.some((a) => a.action === "expiry.would_reclaim")).toBe(true);
  });

  it("live:到期前 7 天发提醒邮件", async () => {
    const { db, deps, emails } = setup({ live: true });
    await seed(db, "ep1", "remind@e.com", "2026-08-06T12:00:00.000Z");
    await sweepExpiredEndpoints(deps);
    expect(emails).toEqual([
      { to: "remind@e.com", subject: "Mediary Connect 将于 7 天后到期" },
    ]);
  });

  it("live:到期前 1 天发最后提醒", async () => {
    const { db, deps, emails } = setup({ live: true });
    await seed(db, "ep1", "last@e.com", "2026-07-31T12:00:00.000Z");
    await sweepExpiredEndpoints(deps);
    expect(emails).toEqual([{ to: "last@e.com", subject: "Mediary Connect 明天到期" }]);
  });

  it("live:宽限期满真删 DNS 和隧道,并记 reclaimed", async () => {
    const { db, deps, cfCalls } = setup({ live: true });
    await seed(db, "ep1", "old@e.com", "2026-07-01T00:00:00.000Z"); // 宽限早过
    const r = await sweepExpiredEndpoints(deps);
    expect(r.reclaimed).toBe(1);
    expect(cfCalls.some((c) => c.startsWith("delDns"))).toBe(true);
    expect(cfCalls.some((c) => c.startsWith("delTunnel"))).toBe(true);
    const audits = await db.listAudits();
    expect(audits.some((a) => a.action === "expiry.reclaimed")).toBe(true);
  });

  it("live:未到期不发邮件,宽限中不真删", async () => {
    const { db, deps, cfCalls, emails } = setup({ live: true });
    await seed(db, "ep_active", "act@e.com", "2026-09-01T00:00:00.000Z"); // 还早
    await seed(db, "ep_grace", "grace@e.com", "2026-07-29T00:00:00.000Z"); // 宽限中
    const r = await sweepExpiredEndpoints(deps);
    expect(emails, "宽限中不该收到提醒邮件").toEqual([]);
    expect(cfCalls, "宽限中不该真删").toEqual([]);
    expect(r.reclaimed).toBe(0);
  });

  it("删除失败时记 error,继续处理其它行,不中断整轮", async () => {
    const db = createMemoryConnectDb();
    const cfCalls: string[] = [];
    let n = 0;
    const failingCf: CfApi = {
      ...fakeCf(cfCalls),
      async deleteDnsRecord() {
        throw new Error("cf dns delete failed");
      },
      async deleteTunnel(id: string) {
        cfCalls.push(`delTunnel:${id}`);
      },
    };
    const deps: SweepDeps = {
      db,
      cf: failingCf,
      now: () => NOW,
      newAuditId: () => `aud_${++n}`,
      live: true,
    };
    await seed(db, "ep_fail", "fail@e.com", "2026-07-01T00:00:00.000Z");
    await seed(db, "ep_ok", "ok@e.com", "2026-07-01T00:00:00.000Z");
    const r = await sweepExpiredEndpoints(deps);
    // 一个失败不中断整轮
    expect(r.errors.length).toBeGreaterThan(0);
    // 但失败那行不静默消失
    expect(r.errors.some((e) => e.endpointId === "ep_fail")).toBe(true);
  });

  it("revoked / 无账号的 endpoint 不参与巡检", async () => {
    const { db, deps, cfCalls } = setup({ live: true });
    await seed(db, "ep_rev", "rev@e.com", "2026-07-01T00:00:00.000Z", "revoked");
    const r = await sweepExpiredEndpoints(deps);
    expect(r.scanned, "revoked 不该进扫描面").toBe(0);
    expect(cfCalls).toEqual([]);
  });

  // Copilot round-1 指出:catch 里 continue 会让「提醒过」在审计里消失。
  // 审计是事后核对「是否通知到用户」的唯一依据 —— 邮件失败恰恰更需要留痕。
  it("邮件发送失败:仍记 reminder 审计,且带上失败原因", async () => {
    const { db, deps } = setup({
      live: true,
      sendEmail: async () => {
        throw new Error("resend down");
      },
    });
    await seed(db, "ep1", "bounce@e.com", "2026-08-06T12:00:00.000Z");
    const r = await sweepExpiredEndpoints(deps);
    expect(r.errors.some((e) => e.action === "email")).toBe(true);
    const audits = await db.listAudits();
    const a = audits.find((x) => x.action === "expiry.remind.7d");
    expect(a, "提醒审计不能被跳过").toBeDefined();
    expect(a?.detail_json).toContain('"email_status":"failed"');
    expect(a?.detail_json).toContain("email_error");
  });

  it("邮件成功时审计记 email_sent:true,不带 email_error", async () => {
    const { db, deps } = setup({ live: true });
    await seed(db, "ep1", "ok@e.com", "2026-08-06T12:00:00.000Z");
    await sweepExpiredEndpoints(deps);
    const a = (await db.listAudits()).find((x) => x.action === "expiry.remind.7d");
    expect(a?.detail_json).toContain('"email_status":"sent"');
    expect(a?.detail_json).not.toContain("email_error");
  });

  it("无 entitlement 的账号按 expired 处理(未付费却占着隧道)", async () => {
    const { db, deps, cfCalls } = setup({ live: true });
    await seed(db, "ep1", "nopay@e.com", null);
    const r = await sweepExpiredEndpoints(deps);
    expect(cfCalls.some((c) => c.startsWith("delTunnel"))).toBe(true);
    expect(r.reclaimed).toBe(1);
  });
});

describe("dry-run 的护栏即便给了发信器也成立", () => {
  it("传了 sendEmail 但 live=false,邮件仍一封都不发", async () => {
    const { db, deps, emails } = setup({ live: false });
    await seed(db, "ep1", "a@e.com", "2026-08-06T12:00:00.000Z");
    await sweepExpiredEndpoints(deps);
    expect(emails).toEqual([]);
  });
});

describe("email_status 必须客观准确(Copilot round-2)", () => {
  // 早先用 emailFailed===null && live 会在「live 但没配发信器」时记成 sent:true,
  // 而发送根本没发生 —— 审计记录客观上就是错的。
  it("live 但没配发信器 → skipped,不是 sent", async () => {
    const { db, deps } = setup({ live: true, sendEmail: undefined });
    await seed(db, "ep1", "noe@e.com", "2026-08-06T12:00:00.000Z");
    await sweepExpiredEndpoints(deps);
    const a = (await db.listAudits()).find((x) => x.action === "expiry.remind.7d");
    expect(a?.detail_json, "发送没发生不该报 sent").toContain('"email_status":"skipped"');
    expect(a?.detail_json).not.toContain('"email_status":"sent"');
  });

  it("dry-run → dry_run,不进入 sent/failed/skipped 任何一类", async () => {
    const { db, deps } = setup({ live: false });
    await seed(db, "ep1", "dr@e.com", "2026-08-06T12:00:00.000Z");
    await sweepExpiredEndpoints(deps);
    const a = (await db.listAudits()).find((x) => x.action === "expiry.remind.7d");
    expect(a?.detail_json).toContain('"email_status":"dry_run"');
  });
});
