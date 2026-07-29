import { describe, expect, it } from "vitest";
import { createMemoryConnectDb, type ConnectDb } from "./db.js";
import { buildSessionCookie } from "./session.js";
import { handleRequest, type RouteDeps } from "./routes.js";

const BASE = "https://mediaryconnect.app";
const NOW = "2026-07-28T12:00:00.000Z";
const SECRET = "f".repeat(64);

function setup(cfCalls: string[] = []): { deps: RouteDeps; db: ConnectDb } {
  const db = createMemoryConnectDb();
  let epSeq = 0;
  const deps: RouteDeps = {
    db,
    cf: {
      async createTunnel(name: string) {
        cfCalls.push(`createTunnel:${name}`);
        return { tunnelId: `tid-${name}`, token: `tok-${name}` };
      },
      async putTunnelIngress(tunnelId: string) {
        cfCalls.push(`ingress:${tunnelId}`);
      },
      async createDnsCname(slug: string) {
        cfCalls.push(`dns:${slug}`);
        return { recordId: `rec-${slug}` };
      },
      async deleteTunnel(tunnelId: string) {
        cfCalls.push(`deleteTunnel:${tunnelId}`);
      },
      async deleteDnsRecord(recordId: string) {
        cfCalls.push(`deleteDns:${recordId}`);
      },
      async deleteAccessApp() {},
      async getTunnelToken() {
        return "cf-token";
      },
    } as never,
    adminToken: "t",
    rootDomain: "mediaryconnect.app",
    tokenWrapKeyHex: "a".repeat(64),
    now: () => NOW,
    newInviteId: () => "inv_x",
    newEndpointId: () => `ep_${++epSeq}`,
    newAuditId: () => `aud_${epSeq}`,
    newInviteCode: () => "code_x",
    newAccountId: () => "act_x",
    newEntitlementId: () => "ent_x",
    sessionSecret: SECRET,
    sendMagicLink: async () => {},
  };
  return { deps, db };
}

async function cookieFor(accountId: string): Promise<string> {
  return buildSessionCookie(accountId, { secret: SECRET, ttlMs: 3600_000, now: Date.parse(NOW) });
}

async function seedAccount(db: ConnectDb, id: string, expiresAt: string | null): Promise<void> {
  await db.insertAccount({
    id,
    email: `${id}@example.com`,
    paddle_customer_id: null,
    created_at: NOW,
    last_login_at: NOW,
  });
  if (expiresAt !== null) {
    await db.insertEntitlement({
      id: `ent_${id}`,
      account_id: id,
      expires_at: expiresAt,
      source: "manual",
      paddle_transaction_id: null,
      months: 12,
      created_at: NOW,
    });
  }
}

const FUTURE = "2027-07-28T12:00:00.000Z";
const PAST = "2026-01-01T00:00:00.000Z";

function post(slug: string, cookie?: string): Request {
  return new Request(`${BASE}/api/provision`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ slug }),
  });
}

describe("POST /api/provision (自助开通)", () => {
  it("401 without session", async () => {
    const { deps } = setup();
    const res = await handleRequest(post("alice"), deps);
    expect(res.status).toBe(401);
  });

  it("402 without any entitlement — and burns ZERO CF calls", async () => {
    const cfCalls: string[] = [];
    const { deps, db } = setup(cfCalls);
    await seedAccount(db, "act_1", null);
    const res = await handleRequest(post("alice", await cookieFor("act_1")), deps);
    expect(res.status).toBe(402);
    expect(cfCalls).toHaveLength(0);
  });

  it("402 with an EXPIRED entitlement — zero CF calls", async () => {
    const cfCalls: string[] = [];
    const { deps, db } = setup(cfCalls);
    await seedAccount(db, "act_1", PAST);
    const res = await handleRequest(post("alice", await cookieFor("act_1")), deps);
    expect(res.status).toBe(402);
    expect(cfCalls).toHaveLength(0);
  });

  it("400 on an invalid/reserved slug — zero CF calls", async () => {
    const cfCalls: string[] = [];
    const { deps, db } = setup(cfCalls);
    await seedAccount(db, "act_1", FUTURE);
    const cookie = await cookieFor("act_1");
    expect((await handleRequest(post("Admin!", cookie), deps)).status).toBe(400);
    expect((await handleRequest(post("admin", cookie), deps)).status).toBe(400);
    expect(cfCalls).toHaveLength(0);
  });

  it("success: 200 { hostname }, endpoint gets account_id and NO invite_id", async () => {
    const { deps, db } = setup();
    await seedAccount(db, "act_1", FUTURE);
    const res = await handleRequest(post("alice", await cookieFor("act_1")), deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ hostname: "alice.mediaryconnect.app" });
    // 响应绝不含 token/agentPrompt(决策 #10/#12)
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("token");
    expect(raw).not.toContain("agentPrompt");
    expect(raw).not.toContain("tok-");

    const ep = await db.getActiveEndpointByAccountId("act_1");
    expect(ep?.account_id).toBe("act_1");
    expect(ep?.invite_id).toBeNull();
    expect(ep?.slug).toBe("alice");
    // token 不落库
    expect(ep?.token_ciphertext).toBeNull();
  });

  it("409 slug taken when another endpoint owns the slug — and burns no extra CF calls", async () => {
    const cfCalls: string[] = [];
    const { deps, db } = setup(cfCalls);
    await seedAccount(db, "act_1", FUTURE);
    await seedAccount(db, "act_2", FUTURE);
    expect((await handleRequest(post("alice", await cookieFor("act_1")), deps)).status).toBe(200);
    const afterFirst = cfCalls.length;
    const res = await handleRequest(post("alice", await cookieFor("act_2")), deps);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: string }).error).toBe("slug taken");
    // 预检在 CF 编排之前:冲突绝不烧隧道/DNS 资源。
    expect(cfCalls.length).toBe(afterFirst);
  });

  it("409 already provisioned when the account already has a live endpoint — zero extra CF calls", async () => {
    const cfCalls: string[] = [];
    const { deps, db } = setup(cfCalls);
    await seedAccount(db, "act_1", FUTURE);
    const cookie = await cookieFor("act_1");
    expect((await handleRequest(post("alice", cookie), deps)).status).toBe(200);
    const afterFirst = cfCalls.length;
    const res = await handleRequest(post("second", cookie), deps);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: string }).error).toBe("already provisioned");
    expect(cfCalls.length).toBe(afterFirst);
  });

  it("401 on a stale session whose account no longer exists (fail closed)", async () => {
    const { deps } = setup();
    const res = await handleRequest(post("alice", await cookieFor("act_ghost")), deps);
    expect(res.status).toBe(401);
  });

  it("invite provisioning still works unchanged (regression: the old path)", async () => {
    const { deps, db } = setup();
    await db.insertInvite({
      id: "inv_1",
      code: "code_1",
      invitee_label: null,
      email: "invitee@example.com",
      slug: null,
      status: "pending",
      created_at: NOW,
      provisioned_at: null,
      revoked_at: null,
    });
    const res = await handleRequest(
      new Request(`${BASE}/api/admin/invites/inv_1/provision`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer t" },
        body: JSON.stringify({ slug: "bob" }),
      }),
      deps,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // 邀请流保留旧返回形状(reveal 流还活着)
    expect(body.hostname).toBe("bob.mediaryconnect.app");
    expect(typeof body.token).toBe("string");
    const ep = await db.getEndpointByInviteId("inv_1");
    expect(ep?.invite_id).toBe("inv_1");
    expect(ep?.account_id).toBeNull();
  });
});

describe("容量闸门(CF 隧道 1000 硬上限)", () => {
  /** 造 n 条占配额的 endpoint 行。用 insertEndpoint 直插,不走 CF。 */
  async function fillCapacity(db: ConnectDb, n: number, status = "active"): Promise<void> {
    for (let i = 0; i < n; i++) {
      await db.insertEndpoint({
        id: `fill_${status}_${i}`,
        invite_id: null,
        slug: `fill-${status}-${i}`,
        hostname: `fill-${status}-${i}.mediaryconnect.app`,
        cf_tunnel_id: `t_${i}`,
        cf_access_app_id: null,
        cf_access_policy_id: null,
        cf_dns_record_id: `d_${i}`,
        status,
        // NOT NULL(schema.sql:28)。memory 实现不校验约束,但保持与真 schema
        // 一致才能避免 parity 盲区(capacity.test.ts 就因此踩过一次)。
        token_sha256: `sha_${i}`,
        token_ciphertext: null,
        token_shown_at: null,
        last_seen_at: null,
        created_at: NOW,
        revoked_at: null,
        account_id: null,
        grace_until: null,
        suspended_at: null,
        purge_after: null,
      } as never);
    }
  }

  it("未达上限正常开通", async () => {
    const calls: string[] = [];
    const { deps, db } = setup(calls);
    await seedAccount(db, "act_ok", "2027-01-01T00:00:00.000Z");
    await fillCapacity(db, 989);
    const res = await handleRequest(post("undercap", await cookieFor("act_ok")), deps);
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.startsWith("createTunnel"))).toBe(true);
  });

  it("达到 990 时返回 503 at capacity", async () => {
    const { deps, db } = setup();
    await seedAccount(db, "act_full", "2027-01-01T00:00:00.000Z");
    await fillCapacity(db, 990);
    const res = await handleRequest(post("overcap", await cookieFor("act_full")), deps);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "at capacity" });
  });

  // 这是本测试的核心:超限时若已经建了隧道,就会真的吃掉 CF 配额,
  // 而且补偿失败还会留下孤儿资源。必须**零 CF 调用**。
  it("超限时不得调用任何 CF API(零副作用)", async () => {
    const calls: string[] = [];
    const { deps, db } = setup(calls);
    await seedAccount(db, "act_zero", "2027-01-01T00:00:00.000Z");
    await fillCapacity(db, 990);
    const res = await handleRequest(post("nocf", await cookieFor("act_zero")), deps);
    expect(res.status).toBe(503);
    expect(calls, `不该有任何 CF 调用,实际: ${calls.join(", ")}`).toEqual([]);
  });

  // 402(无时长)必须比 503(容量满)更早判:否则一个过期用户在满容量时
  // 会看到「售罄」,误以为是我们的问题、而不是他该续期。
  it("无有效时长时先返回 402,而不是 503", async () => {
    const { deps, db } = setup();
    await seedAccount(db, "act_exp", "2026-01-01T00:00:00.000Z"); // 已过期
    await fillCapacity(db, 990);
    const res = await handleRequest(post("expired", await cookieFor("act_exp")), deps);
    expect(res.status).toBe(402);
  });

  it("revoked 行不占配额:990 条 revoked 仍可开通", async () => {
    const { deps, db } = setup();
    await seedAccount(db, "act_rev", "2027-01-01T00:00:00.000Z");
    await fillCapacity(db, 990, "revoked");
    const res = await handleRequest(post("afterrevoke", await cookieFor("act_rev")), deps);
    expect(res.status).toBe(200);
  });

  // CF 侧删除失败 → 隧道可能还在 → 偏保守计入,宁可少卖不可超卖。
  it("revoke_failed 偏保守计入,占满即拒", async () => {
    const { deps, db } = setup();
    await seedAccount(db, "act_rf", "2027-01-01T00:00:00.000Z");
    await fillCapacity(db, 990, "revoke_failed");
    const res = await handleRequest(post("rf", await cookieFor("act_rf")), deps);
    expect(res.status).toBe(503);
  });
});

describe("控制台在满容量时的呈现", () => {
  async function fill(db: ConnectDb, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await db.insertEndpoint({
        id: `c_${i}`, invite_id: null,
        slug: `c-${i}`, hostname: `c-${i}.mediaryconnect.app`,
        cf_tunnel_id: `t${i}`, cf_access_app_id: null, cf_access_policy_id: null,
        cf_dns_record_id: `d${i}`, status: "active",
        // NOT NULL(schema.sql:28)。memory 实现不校验约束,但保持与真 schema
        // 一致才能避免 parity 盲区(capacity.test.ts 就因此踩过一次)。
        token_sha256: `sha_${i}`, token_ciphertext: null, token_shown_at: null,
        last_seen_at: null, created_at: NOW, revoked_at: null,
        account_id: null, grace_until: null, suspended_at: null, purge_after: null,
      } as never);
    }
  }

  async function console_(db: ConnectDb, deps: RouteDeps, accountId: string): Promise<string> {
    const res = await handleRequest(
      new Request(`${BASE}/console`, { headers: { cookie: await cookieFor(accountId) } }),
      deps,
    );
    expect(res.status).toBe(200);
    return res.text();
  }

  // 让用户输完名字、点开通、才吃 503 是最差的体验(他会以为名字填错了)。
  it("满容量时不渲染 slug 表单,而是说明售罄并给退款出口", async () => {
    const { deps, db } = setup();
    await seedAccount(db, "act_c1", "2027-01-01T00:00:00.000Z");
    await fill(db, 990);
    const html = await console_(db, deps, "act_c1");
    expect(html).toContain("暂时售罄");
    expect(html).toContain("你的时长不会流失");
    expect(html).toContain('href="/refund"'); // 已付费,必须给退款出口
    expect(html, "不该渲染 slug 输入框").not.toContain('id="slug"');
  });

  it("未满容量正常渲染 slug 表单", async () => {
    const { deps, db } = setup();
    await seedAccount(db, "act_c2", "2027-01-01T00:00:00.000Z");
    await fill(db, 989);
    const html = await console_(db, deps, "act_c2");
    expect(html).toContain('id="slug"');
    expect(html).not.toContain("暂时售罄");
  });

  // 已开通用户不受配额影响 —— 满容量也不该干扰他的接入区。
  it("已开通用户在满容量时仍看到自己的接入区", async () => {
    const calls: string[] = [];
    const { deps, db } = setup(calls);
    await seedAccount(db, "act_c3", "2027-01-01T00:00:00.000Z");
    const ok = await handleRequest(post("mine", await cookieFor("act_c3")), deps);
    expect(ok.status).toBe(200);
    await fill(db, 990); // 事后占满
    const html = await console_(db, deps, "act_c3");
    expect(html).toContain("mine.mediaryconnect.app");
    expect(html).not.toContain("暂时售罄");
  });
});

describe("容量计数的调用时机(避免无谓的全表 COUNT)", () => {
  /** 包一层 db,记录 countLiveEndpoints 被调用次数。 */
  function counting(db: ConnectDb): { db: ConnectDb; hits: () => number } {
    let n = 0;
    const wrapped: ConnectDb = {
      ...db,
      async countLiveEndpoints() {
        n++;
        return db.countLiveEndpoints();
      },
    };
    return { db: wrapped, hits: () => n };
  }

  async function openConsole(deps: RouteDeps, accountId: string): Promise<number> {
    const res = await handleRequest(
      new Request(`${BASE}/console`, { headers: { cookie: await cookieFor(accountId) } }),
      deps,
    );
    return res.status;
  }

  // 无有效时长的用户在 console-page 走早返回分支,压根用不到 atCapacity。
  // 为他们跑一次全表 COUNT 纯属浪费(Copilot round-1 指出)。
  it("无有效时长时不查容量", async () => {
    const { deps, db } = setup();
    await seedAccount(db, "act_np", "2026-01-01T00:00:00.000Z"); // 已过期
    const c = counting(db);
    expect(await openConsole({ ...deps, db: c.db }, "act_np")).toBe(200);
    expect(c.hits(), "过期用户不该触发 COUNT").toBe(0);
  });

  it("有时长且未开通时才查容量", async () => {
    const { deps, db } = setup();
    await seedAccount(db, "act_el", "2027-01-01T00:00:00.000Z");
    const c = counting(db);
    expect(await openConsole({ ...deps, db: c.db }, "act_el")).toBe(200);
    expect(c.hits()).toBe(1);
  });

  it("已开通用户不查容量(不受配额影响)", async () => {
    const { deps, db } = setup();
    await seedAccount(db, "act_done", "2027-01-01T00:00:00.000Z");
    expect((await handleRequest(post("done", await cookieFor("act_done")), deps)).status).toBe(200);
    const c = counting(db);
    expect(await openConsole({ ...deps, db: c.db }, "act_done")).toBe(200);
    expect(c.hits(), "已开通用户不该触发 COUNT").toBe(0);
  });
});
