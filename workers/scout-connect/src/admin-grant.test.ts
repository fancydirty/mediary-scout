import { describe, expect, it } from "vitest";
import { handleRequest, type RouteDeps } from "./routes.js";
import { createMemoryConnectDb } from "./db.js";

const BASE = "https://mediaryconnect.app";
const ADMIN = "admin-secret-tok";

function baseDeps(): RouteDeps {
  let entSeq = 0;
  return {
    db: createMemoryConnectDb(),
    cf: {} as never,
    adminToken: ADMIN,
    rootDomain: "mediaryconnect.app",
    tokenWrapKeyHex: "a".repeat(64),
    now: () => "2026-07-28T00:00:00.000Z",
    newInviteId: () => "inv_x",
    newEndpointId: () => "ep_x",
    newAuditId: () => "aud_x",
    newInviteCode: () => "code_x",
    newAccountId: () => "act_new",
    newEntitlementId: () => `ent_${++entSeq}`,
    sessionSecret: "f".repeat(64),
    sendMagicLink: async () => {},
  };
}

function grant(body: unknown, token = ADMIN): Request {
  return new Request(`${BASE}/api/admin/grant`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/grant (内测手工授予时长)", () => {
  it("rejects without admin token (401)", async () => {
    const res = await handleRequest(grant({ email: "a@example.com", months: 12 }, "wrong"), baseDeps());
    expect(res.status).toBe(401);
  });

  it("creates the account if absent, then grants months from now", async () => {
    const deps = baseDeps();
    const res = await handleRequest(
      grant({ email: "new@example.com", months: 12, source: "founding" }),
      deps,
    );
    expect(res.status).toBe(200);
    const account = await deps.db.getAccountByEmail("new@example.com");
    expect(account).not.toBeNull();
    const ents = await deps.db.listEntitlements(account!.id);
    expect(ents).toHaveLength(1);
    expect(ents[0]!.expires_at).toBe("2027-07-28T00:00:00.000Z");
    expect(ents[0]!.source).toBe("founding");
  });

  it("stacks on an existing active entitlement", async () => {
    const deps = baseDeps();
    await handleRequest(grant({ email: "x@example.com", months: 12 }), deps);
    await handleRequest(grant({ email: "x@example.com", months: 12 }), deps);
    const account = await deps.db.getAccountByEmail("x@example.com");
    const ents = await deps.db.listEntitlements(account!.id);
    expect(ents).toHaveLength(2);
    // 第二次从第一次的到期时刻叠加 → 2028
    const latest = ents.map((e) => e.expires_at).sort().at(-1);
    expect(latest).toBe("2028-07-28T00:00:00.000Z");
  });

  it("id primary-key collision is a real error, not silently treated as idempotent", async () => {
    // insertEntitlement 只把 paddle_transaction_id 冲突当幂等;id 主键冲突
    // 必须原样抛(否则 webhook 事故被误判成"重复交易"而静默丢失)。
    const deps = baseDeps();
    deps.newEntitlementId = () => "ent_dup"; // 恒返回同一 id → 第二次撞主键
    await handleRequest(grant({ email: "a@example.com", months: 12 }), deps);
    const res = await handleRequest(grant({ email: "a@example.com", months: 12 }), deps);
    // memory 实现对 id 冲突抛错 → handleError 转 500,不是"幂等成功"的 200。
    expect(res.status).toBe(500);
  });

  it("rejects invalid months (400)", async () => {
    const deps = baseDeps();
    for (const months of [0, -1, 0.5, 1000, "x"]) {
      const res = await handleRequest(grant({ email: "a@example.com", months }), deps);
      expect(res.status, `months=${months}`).toBe(400);
    }
  });

  it("rejects invalid email (400)", async () => {
    const res = await handleRequest(grant({ email: "not-an-email", months: 12 }), baseDeps());
    expect(res.status).toBe(400);
  });
});
