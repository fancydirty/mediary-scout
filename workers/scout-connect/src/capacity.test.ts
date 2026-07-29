import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createD1ConnectDb,
  createMemoryConnectDb,
  type ConnectDb,
  type D1Database,
  type EndpointRow,
} from "./db.js";
import { CAPACITY_LIMIT } from "./capacity.js";

/**
 * 容量闸门测试。
 *
 * 背景:CF 隧道硬上限 **1000/账号,所有套餐一致(含 Enterprise)**,官方
 * account-limits 页面 + CF 员工社区回复双重确认;hostname routes 另有 1000
 * 且与 tunnel 共享配额,所以真实上限就是 1000 个用户。
 *
 * 撞上限的后果不是降级而是**收了钱交不了货**:用户付款 → 过 entitlement 门禁
 * → 在 cf.createTunnel 拿到 CF 报错 → 走完补偿事务 → 看到「开通失败,请稍后
 * 重试」(而重试永远不会成功)。
 */

function endpoint(over: Partial<EndpointRow>): EndpointRow {
  // 先算成局部变量再复用:原先 hostname 用 `over.slug ?? "x"`,不传 slug 时
  // slug 是随机的、hostname 却固定成 x.mediaryconnect.app —— 两者不一致,且
  // 第二次调用就撞 hostname UNIQUE。token_sha256 同理会退化成 sha_x。
  const id = over.id ?? crypto.randomUUID();
  const slug = over.slug ?? `s${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    invite_id: null,
    slug,
    hostname: over.hostname ?? `${slug}.mediaryconnect.app`,
    cf_tunnel_id: "t1",
    cf_access_app_id: null,
    cf_access_policy_id: null,
    cf_dns_record_id: "d1",
    status: over.status ?? "active",
    // NOT NULL(schema.sql:28)。memory 实现不校验约束,真 SQLite 会拒——
    // parity 测试因此顺带发现了原 helper 造的是生产里非法的行。
    token_sha256: `sha_${id}`,
    token_ciphertext: null,
    token_shown_at: null,
    last_seen_at: null,
    created_at: "2026-07-29T00:00:00.000Z",
    revoked_at: null,
    account_id: over.account_id ?? null,
    grace_until: over.grace_until ?? null,
    suspended_at: over.suspended_at ?? null,
    purge_after: null,
    ...over,
  } as EndpointRow;
}

async function seed(db: ConnectDb, rows: Partial<EndpointRow>[]): Promise<void> {
  for (const [i, r] of rows.entries()) {
    await db.insertEndpoint(endpoint({ slug: `slug${i}`, hostname: `slug${i}.mediaryconnect.app`, ...r }));
  }
}

describe("测试 helper 自身的正确性", () => {
  // 原 helper 的默认 hostname 与 slug 不一致(hostname 固定 x.…),连续两条就撞
  // UNIQUE;而真 SQLite 才会拒,memory 实现不会 —— 又一处 parity 盲区。
  it("不传 slug 时 slug 与 hostname 自洽,可连续插多条", async () => {
    const db = realD1();
    await db.insertEndpoint(endpoint({}));
    await db.insertEndpoint(endpoint({}));
    expect(await db.countLiveEndpoints()).toBe(2);
    const all = await db.listEndpoints();
    for (const r of all) {
      expect(r.hostname, "hostname 必须由自身 slug 派生").toBe(`${r.slug}.mediaryconnect.app`);
    }
  });
});

describe("countLiveEndpoints —— 计数语义(决定卖不卖得出去)", () => {
  it("空库为 0", async () => {
    expect(await createMemoryConnectDb().countLiveEndpoints()).toBe(0);
  });

  it("active 计入", async () => {
    const db = createMemoryConnectDb();
    await seed(db, [{ status: "active" }, { status: "active" }]);
    expect(await db.countLiveEndpoints()).toBe(2);
  });

  // 这两种是**时间戳态**:schema 注释明确「grace/suspended 是时间戳态,
  // status 仍 'active' 所以天然算占用」。它们确实还占着 CF 隧道,漏计就会超卖。
  it("宽限期中(grace_until 有值)仍占隧道,必须计入", async () => {
    const db = createMemoryConnectDb();
    await seed(db, [{ status: "active", grace_until: "2026-08-05T00:00:00.000Z" }]);
    expect(await db.countLiveEndpoints()).toBe(1);
  });

  it("已停用但隧道未删(suspended_at 有值、status 仍 active)必须计入", async () => {
    const db = createMemoryConnectDb();
    await seed(db, [{ status: "active", suspended_at: "2026-08-05T00:00:00.000Z" }]);
    expect(await db.countLiveEndpoints()).toBe(1);
  });

  // revoked 的隧道已在 CF 侧删除,不占配额 —— 计入会导致「明明有余量却显示售罄」。
  it("revoked 不计入(隧道已删,不占配额)", async () => {
    const db = createMemoryConnectDb();
    await seed(db, [{ status: "active" }, { status: "revoked" }, { status: "revoked" }]);
    expect(await db.countLiveEndpoints()).toBe(1);
  });

  // revoke_failed = CF 侧删除失败,隧道**可能还在**。偏保守计入:
  // 宁可少卖(可人工核查),不可超卖(撞 CF 上限就是收钱交不了货)。
  it("revoke_failed 偏保守计入(CF 侧可能还在)", async () => {
    const db = createMemoryConnectDb();
    await seed(db, [{ status: "revoke_failed" }]);
    expect(await db.countLiveEndpoints()).toBe(1);
  });
});

describe("CAPACITY_LIMIT", () => {
  it("是 990,与 CF 硬上限 1000 留 10 条运维余量", () => {
    expect(CAPACITY_LIMIT).toBe(990);
    // 绝不能等于或超过 1000:撞上就是付了钱开不出来
    expect(CAPACITY_LIMIT).toBeLessThan(1000);
  });
});

/** 真 SQLite 上跑生产 D1 语句(与 schema.test.ts 同款适配器)。 */
function d1Over(sqlite: Database.Database): D1Database {
  return {
    prepare(query: string) {
      const stmt = sqlite.prepare(query);
      let bound: unknown[] = [];
      const api = {
        bind(...values: unknown[]) {
          bound = values;
          return api;
        },
        async first<T>(): Promise<T | null> {
          return (stmt.get(...bound) as T | undefined) ?? null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          return { results: stmt.all(...bound) as T[] };
        },
        async run(): Promise<unknown> {
          const info = stmt.run(...bound);
          return { meta: { changes: info.changes } };
        },
      };
      return api;
    },
  };
}

function realD1(): ConnectDb {
  const schema = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "schema.sql"),
    "utf8",
  );
  const sqlite = new Database(":memory:");
  sqlite.exec(schema);
  return createD1ConnectDb(d1Over(sqlite));
}

/**
 * D1 与 memory 两份实现的一致性(parity)。
 *
 * 这是**必须实测**的:两份实现是分别手写的(一个 SQL `status IN (...)`,一个
 * JS filter),漂移的后果是本地测试全绿而生产超卖。endpoints.status 经全仓核实
 * 只有三个取值:active(插入时)、revoked、revoke_failed(见 db.ts 的两条 UPDATE);
 * provisioned/pending 属 invites 表,waiting 属 waitlist 表,与本计数无关。
 */
describe("countLiveEndpoints D1↔memory parity", () => {
  // status 的联合类型只有三个值,类型系统本身就印证了白名单的完备性。
  type Status = EndpointRow["status"];
  const cases: { name: string; rows: { status: Status; grace?: string; susp?: string }[] }[] = [
    { name: "空库", rows: [] },
    { name: "全 active", rows: [{ status: "active" }, { status: "active" }] },
    { name: "全 revoked", rows: [{ status: "revoked" }, { status: "revoked" }] },
    { name: "全 revoke_failed", rows: [{ status: "revoke_failed" }] },
    {
      name: "混合三态 + 时间戳态",
      rows: [
        { status: "active" },
        { status: "active", grace: "2026-08-05T00:00:00.000Z" },
        { status: "active", susp: "2026-08-05T00:00:00.000Z" },
        { status: "revoked" },
        { status: "revoke_failed" },
      ],
    },
  ];

  for (const c of cases) {
    it(`${c.name} → 两实现结果相同`, async () => {
      const results: number[] = [];
      for (const db of [realD1(), createMemoryConnectDb()]) {
        for (const [i, r] of c.rows.entries()) {
          await db.insertEndpoint(
            endpoint({
              id: `p_${i}`,
              slug: `p-${i}`,
              hostname: `p-${i}.mediaryconnect.app`,
              status: r.status,
              grace_until: r.grace ?? null,
              suspended_at: r.susp ?? null,
            }),
          );
        }
        results.push(await db.countLiveEndpoints());
      }
      expect(results[0], `D1=${results[0]} memory=${results[1]}`).toBe(results[1]);
    });
  }

  it("混合态的绝对值也正确(active×3 + revoke_failed×1 = 4)", async () => {
    const db = realD1();
    const mix: EndpointRow["status"][] = ["active", "active", "active", "revoke_failed", "revoked"];
    for (const [i, st] of mix.entries()) {
      await db.insertEndpoint(
        endpoint({ id: `q_${i}`, slug: `q-${i}`, hostname: `q-${i}.mediaryconnect.app`, status: st }),
      );
    }
    expect(await db.countLiveEndpoints()).toBe(4);
  });
});
