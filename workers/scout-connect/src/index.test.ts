import { describe, expect, it } from "vitest";
import { createMemoryConnectDb } from "./db.js";
import type { RouteDeps } from "./routes.js";
import { runScheduledMaintenance } from "./index.js";

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
});
