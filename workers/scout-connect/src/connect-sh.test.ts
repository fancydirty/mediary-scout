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
  });

  it("is servable over the beta host too (curl | sh 从任一入口)", async () => {
    const res = await handleRequest(new Request("https://beta.mediaryconnect.app/connect.sh"), deps());
    expect(res.status).toBe(200);
  });
});
