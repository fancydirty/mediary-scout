import { describe, expect, it } from "vitest";
import type { CfApi } from "./cf-api.js";
import { createTunnelResources } from "./tunnel-resources.js";

function fakeCf(calls: string[], fail: { ingress?: boolean; dns?: boolean; deleteTunnel?: boolean } = {}): CfApi {
  return {
    async createTunnel(name) {
      calls.push(`createTunnel:${name}`);
      return { tunnelId: "tid-scout-fam", token: "plain-token" };
    },
    async getTunnelToken() {
      throw new Error("unexpected getTunnelToken");
    },
    async putTunnelIngress(tunnelId, hostname) {
      calls.push(`ingress:${tunnelId}:${hostname}`);
      if (fail.ingress) throw new Error("cf ingress boom");
    },
    async createDnsCname(slug, tunnelId) {
      calls.push(`dns:${slug}:${tunnelId}`);
      if (fail.dns) throw new Error("cf dns boom");
      return { recordId: "rec-fam" };
    },
    async createAccessApp() {
      throw new Error("unexpected createAccessApp");
    },
    async deleteTunnel(tunnelId) {
      calls.push(`deleteTunnel:${tunnelId}`);
      if (fail.deleteTunnel) throw new Error("delete tunnel boom");
    },
    async deleteDnsRecord(recordId) {
      calls.push(`deleteDns:${recordId}`);
    },
    async deleteAccessApp() {
      throw new Error("unexpected deleteAccessApp");
    },
  };
}

describe("createTunnelResources", () => {
  it("creates tunnel, ingress for the hostname, and the DNS CNAME", async () => {
    const calls: string[] = [];
    const resources = await createTunnelResources(fakeCf(calls), "fam", "fam.mediaryconnect.app");
    expect(resources).toMatchObject({
      tunnelId: "tid-scout-fam",
      token: "plain-token",
      recordId: "rec-fam",
    });
    expect(calls).toEqual([
      "createTunnel:scout-fam",
      "ingress:tid-scout-fam:fam.mediaryconnect.app",
      "dns:fam:tid-scout-fam",
    ]);
  });

  it("deletes the tunnel once and rethrows the DNS error when the CNAME fails", async () => {
    const calls: string[] = [];
    await expect(
      createTunnelResources(fakeCf(calls, { dns: true }), "fam", "fam.mediaryconnect.app"),
    ).rejects.toThrow("cf dns boom");
    expect(calls.filter((call) => call.startsWith("deleteTunnel:"))).toEqual(["deleteTunnel:tid-scout-fam"]);
    expect(calls.some((call) => call.startsWith("deleteDns:"))).toBe(false);
  });

  it("deletes the tunnel and rethrows the ingress error when ingress fails", async () => {
    const calls: string[] = [];
    await expect(
      createTunnelResources(fakeCf(calls, { ingress: true }), "fam", "fam.mediaryconnect.app"),
    ).rejects.toThrow("cf ingress boom");
    expect(calls.filter((call) => call.startsWith("deleteTunnel:"))).toEqual(["deleteTunnel:tid-scout-fam"]);
    expect(calls.some((call) => call.startsWith("dns:"))).toBe(false);
  });

  it("keeps the original error when the compensating delete also fails", async () => {
    const calls: string[] = [];
    await expect(
      createTunnelResources(fakeCf(calls, { dns: true, deleteTunnel: true }), "fam", "fam.mediaryconnect.app"),
    ).rejects.toThrow("cf dns boom");
    // Latch is set only after a successful delete, so the outer catch retries.
    expect(calls.filter((call) => call.startsWith("deleteTunnel:"))).toHaveLength(2);
  });

  it("discard deletes DNS then the tunnel, swallows delete errors, and does not delete the tunnel twice", async () => {
    const calls: string[] = [];
    const cf = fakeCf(calls);
    const resources = await createTunnelResources(cf, "fam", "fam.mediaryconnect.app");
    calls.length = 0;
    cf.deleteDnsRecord = async (recordId) => {
      calls.push(`deleteDns:${recordId}`);
      throw new Error("delete dns boom");
    };
    await expect(resources.discard()).resolves.toBeUndefined();
    expect(calls).toEqual(["deleteDns:rec-fam", "deleteTunnel:tid-scout-fam"]);
    await resources.discard();
    expect(calls.filter((call) => call.startsWith("deleteTunnel:"))).toEqual(["deleteTunnel:tid-scout-fam"]);
  });
});
