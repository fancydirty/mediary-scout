import { describe, expect, it } from "vitest";
import { createMemoryConnectDb, type ConnectDb } from "./db.js";
import { grantEntitlement, type GrantDeps } from "./grant.js";

const NOW = "2026-07-29T12:00:00.000Z";

function deps(db: ConnectDb, over: Partial<GrantDeps> = {}): GrantDeps {
  // 两个序列必须独立:原先 ent 复用 account 的计数器,同一账号第二次授予会
  // 生成重复 id 撞主键(真实 worker 用 crypto.randomUUID,不会有这个问题)。
  let acct = 0;
  let ent = 0;
  return {
    db,
    now: () => NOW,
    newAccountId: () => `act_${++acct}`,
    newEntitlementId: () => `ent_${++ent}`,
    ...over,
  };
}

describe("grantEntitlement", () => {
  it("首次充值:建账号 + 从当下起算", async () => {
    const db = createMemoryConnectDb();
    const r = await grantEntitlement(
      { email: "a@example.com", months: 12, source: "paddle", paddleTransactionId: "txn_1" },
      deps(db),
    );
    expect(r.applied).toBe(true);
    expect(r.expiresAt).toBe("2027-07-29T12:00:00.000Z");
    const acct = await db.getAccountByEmail("a@example.com");
    expect(acct).not.toBeNull();
  });

  // 续费语义:未到期从旧到期叠加(不浪费剩余时长)。
  it("未到期续费从旧到期叠加", async () => {
    const db = createMemoryConnectDb();
    const d = deps(db);
    await grantEntitlement(
      { email: "b@example.com", months: 3, source: "paddle", paddleTransactionId: "t1" },
      d,
    );
    const second = await grantEntitlement(
      { email: "b@example.com", months: 3, source: "paddle", paddleTransactionId: "t2" },
      d,
    );
    // 2026-10-29 再加 3 个月 → 2027-01-29,而不是从当下起算的 2026-10-29
    expect(second.expiresAt).toBe("2027-01-29T12:00:00.000Z");
  });

  it("已过期则从当下重启(不把断掉的时间补回来)", async () => {
    const db = createMemoryConnectDb();
    const d = deps(db);
    const acct = await db.insertAccount({
      id: "act_old",
      email: "c@example.com",
      created_at: "2025-01-01T00:00:00.000Z",
      login_password_hash: null,
    } as never);
    await db.insertEntitlement({
      id: "ent_old",
      account_id: acct.id,
      expires_at: "2026-01-01T00:00:00.000Z", // 已过期
      source: "manual",
      paddle_transaction_id: null,
      months: 12,
      created_at: "2025-01-01T00:00:00.000Z",
    });
    const r = await grantEntitlement(
      { email: "c@example.com", months: 3, source: "paddle", paddleTransactionId: "t3" },
      d,
    );
    expect(r.expiresAt).toBe("2026-10-29T12:00:00.000Z"); // 从 NOW 起算
  });

  // 幂等是收钱系统的命门:Paddle 会重投 webhook,重复入账等于白送时长。
  it("同一 paddle_transaction_id 重投不重复入账", async () => {
    const db = createMemoryConnectDb();
    const d = deps(db);
    const first = await grantEntitlement(
      { email: "d@example.com", months: 12, source: "paddle", paddleTransactionId: "txn_dup" },
      d,
    );
    expect(first.applied).toBe(true);
    const replay = await grantEntitlement(
      { email: "d@example.com", months: 12, source: "paddle", paddleTransactionId: "txn_dup" },
      d,
    );
    expect(replay.applied, "重投必须被识别为幂等").toBe(false);
    const ents = await db.listEntitlements((await db.getAccountByEmail("d@example.com"))!.id);
    expect(ents.length, "只应有一条时长记录").toBe(1);
  });

  it("重投返回的 expiresAt 是已存在的到期时刻,不是又叠加一次的", async () => {
    const db = createMemoryConnectDb();
    const d = deps(db);
    const first = await grantEntitlement(
      { email: "e@example.com", months: 12, source: "paddle", paddleTransactionId: "txn_e" },
      d,
    );
    const replay = await grantEntitlement(
      { email: "e@example.com", months: 12, source: "paddle", paddleTransactionId: "txn_e" },
      d,
    );
    expect(replay.expiresAt).toBe(first.expiresAt);
  });

  it("邮箱大小写与空白归一(同一人不该建两个账号)", async () => {
    const db = createMemoryConnectDb();
    const d = deps(db);
    await grantEntitlement(
      { email: "  MiXeD@Example.COM  ", months: 3, source: "paddle", paddleTransactionId: "t5" },
      d,
    );
    await grantEntitlement(
      { email: "mixed@example.com", months: 3, source: "paddle", paddleTransactionId: "t6" },
      d,
    );
    const acct = await db.getAccountByEmail("mixed@example.com");
    expect(acct).not.toBeNull();
    const ents = await db.listEntitlements(acct!.id);
    expect(ents.length, "应挂在同一个账号下").toBe(2);
  });

  it("手工授予(admin)不带 paddle_transaction_id 也能工作", async () => {
    const db = createMemoryConnectDb();
    const r = await grantEntitlement(
      { email: "f@example.com", months: 6, source: "manual", paddleTransactionId: null },
      deps(db),
    );
    expect(r.applied).toBe(true);
    const ents = await db.listEntitlements(r.accountId);
    expect(ents[0]?.paddle_transaction_id).toBeNull();
  });

  // 没有 txn id 的多次手工授予不该被幂等误吞(偏唯一索引只覆盖非 null)。
  it("多次手工授予都入账(null txn id 不参与幂等)", async () => {
    const db = createMemoryConnectDb();
    const d = deps(db);
    await grantEntitlement(
      { email: "g@example.com", months: 1, source: "manual", paddleTransactionId: null },
      d,
    );
    const second = await grantEntitlement(
      { email: "g@example.com", months: 1, source: "manual", paddleTransactionId: null },
      d,
    );
    expect(second.applied).toBe(true);
    const ents = await db.listEntitlements(second.accountId);
    expect(ents.length).toBe(2);
  });
});
