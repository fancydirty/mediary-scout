import { describe, expect, it } from "vitest";
import { handleRequest, type RouteDeps } from "./routes.js";
import { createMemoryConnectDb } from "./db.js";

const BASE = "https://mediaryconnect.app";

function deps(): RouteDeps {
  return {
    db: createMemoryConnectDb(),
    cf: {} as never,
    adminToken: "t",
    rootDomain: "mediaryconnect.app",
    tokenWrapKeyHex: "a".repeat(64),
    now: () => "2026-07-28T00:00:00.000Z",
    newInviteId: () => "inv_x",
    newEndpointId: () => "ep_x",
    newAuditId: () => "aud_x",
    newInviteCode: () => "code_x",
    newAccountId: () => "act_x",
    newEntitlementId: () => "ent_x",
    sessionSecret: "f".repeat(64),
    sendMagicLink: async () => {},
  };
}

describe("GET /connect.sh", () => {
  it("serves the接入脚本 as shell text", async () => {
    const res = await handleRequest(new Request(`${BASE}/connect.sh`), deps());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/x-shellscript");
    const body = await res.text();
    expect(body).toContain("#!/bin/sh");
    // 关键内容:带 --profile tunnel、轮询 /api/health、凭码换 token
    expect(body).toContain("docker compose --profile tunnel up -d");
    expect(body).toContain("/api/claim/exchange");
    expect(body).toContain("/api/health");
    // 客户端取件码字符集守卫(挡住带引号/空格的误粘,免得 JSON 拼坏被误诊)
    expect(body).toContain("[^A-Za-z0-9_.-]");
    // 分级报错:403 撤销 与 400 过期 区分
    expect(body).toContain("endpoint not active");
  });

  it("is servable over the beta host too (curl | sh 从任一入口)", async () => {
    const res = await handleRequest(new Request("https://beta.mediaryconnect.app/connect.sh"), deps());
    expect(res.status).toBe(200);
  });

  it("rewrites WORKER_BASE default to the request origin (self-consistent per host)", async () => {
    // 生产主机:默认仍是生产 origin。
    const prod = await (await handleRequest(new Request(`${BASE}/connect.sh`), deps())).text();
    expect(prod).toContain('WORKER_BASE="${MEDIARY_CONNECT_BASE:-https://mediaryconnect.app}"');

    // 不同主机(staging/preview):默认改写成该主机,不再硬打生产 API。
    const staging = await (
      await handleRequest(new Request("https://staging.example.com/connect.sh"), deps())
    ).text();
    expect(staging).toContain('WORKER_BASE="${MEDIARY_CONNECT_BASE:-https://staging.example.com}"');
    // 功能性默认已改写;头部注释里的示例 URL(mediaryconnect.app)不影响运行。
    expect(staging).not.toContain("MEDIARY_CONNECT_BASE:-https://mediaryconnect.app");
  });
});
