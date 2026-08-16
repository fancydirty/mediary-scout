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
  it("persists an Alipay grant under provider-neutral idempotency fields", async () => {
    const db = createMemoryConnectDb();
    const result = await grantEntitlement(
      {
        email: "alipay@example.com",
        months: 3,
        source: "alipay",
        paymentProvider: "alipay",
        paymentTransactionId: "MC202608160001",
      },
      deps(db),
    );

    expect((await db.listEntitlements(result.accountId))[0]).toMatchObject({
      account_id: result.accountId,
      source: "alipay",
      months: 3,
      paddle_transaction_id: null,
    });
  });

  it("binds a paid grant to the existing account and rejects an email mismatch", async () => {
    const db = createMemoryConnectDb();
    await db.insertAccount({
      id: "act_paid",
      email: "paid@example.com",
      paddle_customer_id: null,
      created_at: NOW,
      last_login_at: null,
    });
    const d = deps(db);
    await expect(
      grantEntitlement(
        {
          accountId: "act_paid",
          email: "attacker@example.com",
          months: 3,
          source: "alipay",
          paymentProvider: "alipay",
          paymentTransactionId: "MC-mismatch",
        },
        d,
      ),
    ).rejects.toThrow(/email mismatch/i);
    const applied = await grantEntitlement(
      {
        accountId: "act_paid",
        email: "PAID@example.com",
        months: 3,
        source: "alipay",
        paymentProvider: "alipay",
        paymentTransactionId: "MC-bound",
      },
      d,
    );
    expect(applied.accountId).toBe("act_paid");
  });

  it("首次充值:建账号 + 从当下起算", async () => {
    const db = createMemoryConnectDb();
    const r = await grantEntitlement(
      { email: "a@example.com", months: 12, source: "paddle", paymentProvider: "paddle", paymentTransactionId: "txn_1" },
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
      { email: "b@example.com", months: 3, source: "paddle", paymentProvider: "paddle", paymentTransactionId: "t1" },
      d,
    );
    const second = await grantEntitlement(
      { email: "b@example.com", months: 3, source: "paddle", paymentProvider: "paddle", paymentTransactionId: "t2" },
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
      payment_provider: null,
      payment_transaction_id: null,
      refunded_at: null,
      months: 12,
      created_at: "2025-01-01T00:00:00.000Z",
    });
    const r = await grantEntitlement(
      { email: "c@example.com", months: 3, source: "paddle", paymentProvider: "paddle", paymentTransactionId: "t3" },
      d,
    );
    expect(r.expiresAt).toBe("2026-10-29T12:00:00.000Z"); // 从 NOW 起算
  });

  // 幂等是收钱系统的命门:Paddle 会重投 webhook,重复入账等于白送时长。
  it("同一 paddle_transaction_id 重投不重复入账", async () => {
    const db = createMemoryConnectDb();
    const d = deps(db);
    const first = await grantEntitlement(
      { email: "d@example.com", months: 12, source: "paddle", paymentProvider: "paddle", paymentTransactionId: "txn_dup" },
      d,
    );
    expect(first.applied).toBe(true);
    const replay = await grantEntitlement(
      { email: "d@example.com", months: 12, source: "paddle", paymentProvider: "paddle", paymentTransactionId: "txn_dup" },
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
      { email: "e@example.com", months: 12, source: "paddle", paymentProvider: "paddle", paymentTransactionId: "txn_e" },
      d,
    );
    const replay = await grantEntitlement(
      { email: "e@example.com", months: 12, source: "paddle", paymentProvider: "paddle", paymentTransactionId: "txn_e" },
      d,
    );
    expect(replay.expiresAt).toBe(first.expiresAt);
  });

  it("邮箱大小写与空白归一(同一人不该建两个账号)", async () => {
    const db = createMemoryConnectDb();
    const d = deps(db);
    await grantEntitlement(
      { email: "  MiXeD@Example.COM  ", months: 3, source: "paddle", paymentProvider: "paddle", paymentTransactionId: "t5" },
      d,
    );
    await grantEntitlement(
      { email: "mixed@example.com", months: 3, source: "paddle", paymentProvider: "paddle", paymentTransactionId: "t6" },
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
      { email: "f@example.com", months: 6, source: "manual", paymentProvider: null, paymentTransactionId: null },
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
      { email: "g@example.com", months: 1, source: "manual", paymentProvider: null, paymentTransactionId: null },
      d,
    );
    const second = await grantEntitlement(
      { email: "g@example.com", months: 1, source: "manual", paymentProvider: null, paymentTransactionId: null },
      d,
    );
    expect(second.applied).toBe(true);
    const ents = await db.listEntitlements(second.accountId);
    expect(ents.length).toBe(2);
  });
});

describe("并发安全:lost update", () => {
  /** 让第一次 listEntitlements 延迟返回,制造「两个请求都在对方写入前读到账本」
   *  的真交错 —— 这正是多实例 worker 同时收到两个 webhook 时会发生的。 */
  function racingDb(base: ConnectDb): ConnectDb {
    let first = true;
    return {
      ...base,
      async listEntitlements(id: string) {
        const rows = await base.listEntitlements(id);
        if (first) {
          first = false;
          await new Promise((r) => setTimeout(r, 20));
        }
        return rows;
      },
    };
  }

  // 修复前:两笔都基于同一个空快照算出 2027-07-29,用户付了 24 个月只拿到 12
  // (已用确定性交错实测复现)。D1 没有跨请求事务,所以靠「写入后从整本账重算
  // 并修正本行」收敛 —— 重算结果与写入顺序无关。
  it("并发两笔不同交易,时长不丢(24 个月全给到)", async () => {
    const db = racingDb(createMemoryConnectDb());
    const d = deps(db);
    await Promise.all([
      grantEntitlement(
        { email: "race@example.com", months: 12, source: "paddle", paymentProvider: "paddle", paymentTransactionId: "t1" },
        d,
      ),
      grantEntitlement(
        { email: "race@example.com", months: 12, source: "paddle", paymentProvider: "paddle", paymentTransactionId: "t2" },
        d,
      ),
    ]);
    const acct = await db.getAccountByEmail("race@example.com");
    const ents = await db.listEntitlements(acct!.id);
    expect(ents.length, "两笔都要入账").toBe(2);
    const max = ents.map((e) => e.expires_at).sort().pop();
    expect(max, "24 个月应到 2028-07-29,而非 2027(少给 12 个月)").toBe(
      "2028-07-29T12:00:00.000Z",
    );
  });

  it("并发三笔:36 个月全给到", async () => {
    const db = racingDb(createMemoryConnectDb());
    const d = deps(db);
    await Promise.all(
      ["a", "b", "c"].map((t) =>
        grantEntitlement(
          { email: "race3@example.com", months: 12, source: "paddle", paymentProvider: "paddle", paymentTransactionId: t },
          d,
        ),
      ),
    );
    const acct = await db.getAccountByEmail("race3@example.com");
    const ents = await db.listEntitlements(acct!.id);
    expect(ents.length).toBe(3);
    expect(ents.map((e) => e.expires_at).sort().pop()).toBe("2029-07-29T12:00:00.000Z");
  });

  // 非并发路径不该被重算改坏。
  it("串行两笔仍是正常叠加(重算不引入回归)", async () => {
    const db = createMemoryConnectDb();
    const d = deps(db);
    await grantEntitlement(
      { email: "seq@example.com", months: 3, source: "paddle", paymentProvider: "paddle", paymentTransactionId: "s1" },
      d,
    );
    const second = await grantEntitlement(
      { email: "seq@example.com", months: 3, source: "paddle", paymentProvider: "paddle", paymentTransactionId: "s2" },
      d,
    );
    expect(second.expiresAt).toBe("2027-01-29T12:00:00.000Z");
  });
});

describe("重投自愈:上次并发收敛失败留下的错值要能修正", () => {
  // 并发收敛发生在 insert 之后、update 之前。若 update 因 D1 抖动失败 →
  // webhook 返回 503 → Paddle 重投 → 走幂等分支。若幂等分支只回读不重算,
  // 那个基于陈旧快照的错值会**永久留下**,用户永久少拿一个周期(实测复现)。
  it("幂等重投会把错的 expires_at 修正为账本真值", async () => {
    const db = createMemoryConnectDb();
    const d = deps(db);
    await grantEntitlement(
      { email: "heal@example.com", months: 12, source: "paddle", paymentProvider: "paddle", paymentTransactionId: "t1" },
      d,
    );
    const acct = await db.getAccountByEmail("heal@example.com");
    // 种一个「上次收敛失败留下的错值行」:基于陈旧快照算的 2027 而非应有的 2028
    await db.insertEntitlement({
      id: "ent_stale",
      account_id: acct!.id,
      expires_at: "2027-07-29T12:00:00.000Z",
      source: "paddle",
      paddle_transaction_id: "t2",
      payment_provider: "paddle",
      payment_transaction_id: "t2",
      refunded_at: null,
      months: 12,
      created_at: NOW,
    });
    const before = (await db.listEntitlements(acct!.id)).map((e) => e.expires_at).sort().pop();
    expect(before, "前置条件:错值存在").toBe("2027-07-29T12:00:00.000Z");

    const replay = await grantEntitlement(
      { email: "heal@example.com", months: 12, source: "paddle", paymentProvider: "paddle", paymentTransactionId: "t2" },
      d,
    );
    expect(replay.applied, "仍是幂等命中").toBe(false);
    expect(replay.expiresAt, "返回账本真值").toBe("2028-07-29T12:00:00.000Z");
    const after = (await db.listEntitlements(acct!.id)).map((e) => e.expires_at).sort().pop();
    expect(after, "DB 里的错值必须被改正").toBe("2028-07-29T12:00:00.000Z");
  });

  it("值已正确时重投不做多余写入", async () => {
    const db = createMemoryConnectDb();
    let updates = 0;
    const counted: ConnectDb = {
      ...db,
      async updateEntitlementExpiry(id: string, exp: string) {
        updates++;
        return db.updateEntitlementExpiry(id, exp);
      },
    };
    const d = deps(counted);
    await grantEntitlement(
      { email: "noop@example.com", months: 12, source: "paddle", paymentProvider: "paddle", paymentTransactionId: "n1" },
      d,
    );
    const baseline = updates;
    await grantEntitlement(
      { email: "noop@example.com", months: 12, source: "paddle", paymentProvider: "paddle", paymentTransactionId: "n1" },
      d,
    );
    expect(updates, "无需修正时不该写").toBe(baseline);
  });

  // 手工授予没有 txn id,幂等分支的自愈靠 txn id 定位,这条路径不该炸。
  it("手工授予(null txn id)的重投路径安全", async () => {
    const db = createMemoryConnectDb();
    const d = deps(db);
    const r1 = await grantEntitlement(
      { email: "man@example.com", months: 1, source: "manual", paymentProvider: null, paymentTransactionId: null },
      d,
    );
    expect(r1.applied).toBe(true);
    const r2 = await grantEntitlement(
      { email: "man@example.com", months: 1, source: "manual", paymentProvider: null, paymentTransactionId: null },
      d,
    );
    expect(r2.applied, "null txn id 不参与幂等,应真入账").toBe(true);
  });
});
