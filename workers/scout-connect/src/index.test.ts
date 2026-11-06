import { describe, expect, it, vi } from "vitest";
import { createMemoryConnectDb } from "./db.js";
import type { RouteDeps } from "./routes.js";
import { resolveEmailTransport, runScheduledMaintenance } from "./index.js";
import { createMagicLinkSender } from "./magic-link-sender.js";

describe("resolveEmailTransport & createMagicLinkSender", () => {
  it("prefers EMAIL binding over RESEND_API_KEY and sends via binding", async () => {
    const send = vi.fn(async () => ({ messageId: "msg_magic_1" }));
    const transport = resolveEmailTransport({
      EMAIL: { send },
      RESEND_API_KEY: "resend-key",
    });
    expect(typeof transport).toBe("object");
    await createMagicLinkSender(transport)("bob@example.com", "https://mediaryconnect.app/auth/callback?t=123&x=\"bad\"");
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: { email: "noreply@mediaryconnect.app", name: "Mediary Connect" },
        to: "bob@example.com",
        subject: "Mediary Connect 登录链接",
        html: expect.stringContaining("&quot;bad&quot;"),
      }),
    );
  });

  it("falls back to RESEND_API_KEY when EMAIL binding is absent, and throws if both are missing", () => {
    expect(resolveEmailTransport({ RESEND_API_KEY: "re_123" })).toBe("re_123");
    expect(() => resolveEmailTransport({})).toThrow("EMAIL binding or RESEND_API_KEY is required");
  });
});

describe("scheduled maintenance", () => {
  it("runs expired instance-link retention with a seven-day cutoff and bounded batch", async () => {
    const db = createMemoryConnectDb();
    let received: { cutoffIso: string; limit: number } | null = null;
    const base = db;
    const deps = {
      db: {
        ...base,
        async deleteInstanceLinkRequestsExpiredBefore(cutoffIso: string, limit: number) {
          received = { cutoffIso, limit };
          return 0;
        },
      },
      cf: {} as never,
      adminToken: "admin",
      rootDomain: "mediaryconnect.app",
      tokenWrapKeyHex: "0".repeat(64),
      now: () => "2026-10-10T00:00:00.000Z",
      newInviteId: () => "inv_1",
      newEndpointId: () => "ep_1",
      newAuditId: () => "aud_1",
      newInviteCode: () => "code_1",
      newAccountId: () => "act_1",
      newEntitlementId: () => "ent_1",
      sessionSecret: "a".repeat(64),
      sendMagicLink: async () => {},
      sendInstanceLinkEmail: async () => {},
    } as RouteDeps;
    await runScheduledMaintenance(deps, { live: false });
    expect(received).toEqual({ cutoffIso: "2026-10-03T00:00:00.000Z", limit: 1000 });
  });

  it("keeps deleting full batches until one comes back short, up to ten batches a run", async () => {
    const run = async (backlog: number) => {
      let remaining = backlog;
      let calls = 0;
      const base = createMemoryConnectDb();
      const deps = {
        db: {
          ...base,
          async deleteInstanceLinkRequestsExpiredBefore(_cutoffIso: string, limit: number) {
            calls += 1;
            const deleted = Math.min(limit, remaining);
            remaining -= deleted;
            return deleted;
          },
        },
        cf: {} as never,
        adminToken: "admin",
        rootDomain: "mediaryconnect.app",
        tokenWrapKeyHex: "0".repeat(64),
        now: () => "2026-10-10T00:00:00.000Z",
        newInviteId: () => "inv_1",
        newEndpointId: () => "ep_1",
        newAuditId: () => "aud_1",
        newInviteCode: () => "code_1",
        newAccountId: () => "act_1",
        newEntitlementId: () => "ent_1",
        sessionSecret: "a".repeat(64),
        sendMagicLink: async () => {},
        sendInstanceLinkEmail: async () => {},
      } as RouteDeps;
      await runScheduledMaintenance(deps, { live: false });
      return { calls, remaining };
    };
    expect(await run(2500)).toEqual({ calls: 3, remaining: 0 });
    expect(await run(3000)).toEqual({ calls: 4, remaining: 0 });
    expect(await run(25_000)).toEqual({ calls: 10, remaining: 15_000 });
  });
});
