import { describe, expect, it, vi } from "vitest";
import { FallbackResourceProvider } from "../src/fallback-provider.js";
import type { ResourceProvider } from "../src/ports.js";
import type { ResourceSnapshot } from "../src/domain.js";
import { PanSouProtocolError } from "../src/resource-source-health.js";

function snapshotWith(over: Partial<ResourceSnapshot>): ResourceSnapshot {
  return {
    id: "s",
    provider: "stub",
    keyword: "k",
    candidates: [],
    createdAt: "2026-08-06T00:00:00.000Z",
    ...over,
  };
}

function okProvider(id: string): ResourceProvider {
  return {
    search: async () =>
      snapshotWith({
        id,
        sourceHealth: { status: "healthy", unhealthySources: [] },
        candidates: [
          {
            id: `${id}_c1`,
            snapshotId: id,
            index: 0,
            title: "命中",
            type: "quark",
            source: id,
            providerPayload: { url: `https://pan.quark.cn/s/${id}` },
          },
        ],
      }),
  };
}

function deadProvider(status: "unreachable" | "protocol_error" = "unreachable"): ResourceProvider {
  return {
    search: async () =>
      snapshotWith({ id: "dead", sourceHealth: { status, unhealthySources: ["pansou"] } }),
  };
}

describe("FallbackResourceProvider", () => {
  it("uses the primary and never touches the secondary when the primary is healthy", async () => {
    const secondary = okProvider("official");
    const spy = vi.spyOn(secondary, "search");
    const provider = new FallbackResourceProvider({
      primary: { name: "user", provider: okProvider("user") },
      secondary: { name: "official", provider: secondary },
    });
    const snapshot = await provider.search({ keyword: "k" });
    expect(snapshot.id).toBe("user");
    expect(spy).not.toHaveBeenCalled();
  });

  it("falls back to the secondary when the primary is unreachable", async () => {
    const provider = new FallbackResourceProvider({
      primary: { name: "user", provider: deadProvider() },
      secondary: { name: "official", provider: okProvider("official") },
    });
    const snapshot = await provider.search({ keyword: "k" });
    expect(snapshot.id).toBe("official");
    expect(snapshot.candidates.length).toBe(1);
  });

  it("falls back when the primary is a protocol_error too (wrong address, not just down)", async () => {
    const provider = new FallbackResourceProvider({
      primary: { name: "user", provider: deadProvider("protocol_error") },
      secondary: { name: "official", provider: okProvider("official") },
    });
    const snapshot = await provider.search({ keyword: "k" });
    expect(snapshot.id).toBe("official");
  });

  it("marks the result degraded after a fallback so the primary's outage stays visible", async () => {
    // The search succeeded, but the user's configured source is broken and they
    // must still be told — silently limping along is how a misconfiguration
    // survives for weeks (it survived six days in the reported case).
    const provider = new FallbackResourceProvider({
      primary: { name: "user", provider: deadProvider() },
      secondary: { name: "official", provider: okProvider("official") },
    });
    const snapshot = await provider.search({ keyword: "k" });
    expect(snapshot.sourceHealth?.status).toBe("degraded");
    expect(snapshot.sourceHealth?.unhealthySources).toEqual(["user"]);
  });

  it("reports unreachable when BOTH sources are down", async () => {
    const provider = new FallbackResourceProvider({
      primary: { name: "user", provider: deadProvider() },
      secondary: { name: "official", provider: deadProvider() },
    });
    const snapshot = await provider.search({ keyword: "k" });
    expect(snapshot.sourceHealth?.status).toBe("unreachable");
    expect(snapshot.candidates).toEqual([]);
  });

  it("falls back when the primary throws outright", async () => {
    const throwing: ResourceProvider = {
      search: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      },
    };
    const provider = new FallbackResourceProvider({
      primary: { name: "user", provider: throwing },
      secondary: { name: "official", provider: okProvider("official") },
    });
    const snapshot = await provider.search({ keyword: "k" });
    expect(snapshot.id).toBe("official");
    expect(snapshot.sourceHealth?.status).toBe("degraded");
  });

  it("keeps the primary's protocol_error visible after falling back (not flattened to unreachable)", async () => {
    // 「地址填错了」and「源挂了」need different remedies. A bare `catch` on the
    // fallback path would discard the cause and the UI would tell a user with a
    // typo'd URL that their source is down.
    const provider = new FallbackResourceProvider({
      primary: { name: "user", provider: deadProvider("protocol_error") },
      secondary: { name: "official", provider: okProvider("official") },
    });
    const snapshot = await provider.search({ keyword: "k" });
    expect(snapshot.sourceHealth?.status).toBe("degraded");
    expect(snapshot.sourceHealth?.unhealthySources).toEqual(["user"]);
  });

  it("preserves protocol_error as the total-failure cause when the primary THREW it", async () => {
    // The cause must survive an exception too, not just a self-reported status —
    // that is the path a bare `catch { return null }` silently destroys.
    const throwingProtocol: ResourceProvider = {
      search: async () => {
        throw new PanSouProtocolError("not a PanSou payload");
      },
    };
    const provider = new FallbackResourceProvider({
      primary: { name: "user", provider: throwingProtocol },
      secondary: { name: "official", provider: deadProvider("protocol_error") },
    });
    const snapshot = await provider.search({ keyword: "k" });
    expect(snapshot.sourceHealth?.status).toBe("protocol_error");
    expect(snapshot.candidates).toEqual([]);
  });

  it("does NOT fall back when the primary is healthy but genuinely empty", async () => {
    // Critical distinction: an authoritative "no results" must not trigger a
    // second, slower search — that would double the cost of every miss.
    const empty: ResourceProvider = {
      search: async () =>
        snapshotWith({ id: "user", sourceHealth: { status: "healthy", unhealthySources: [] } }),
    };
    const secondary = okProvider("official");
    const spy = vi.spyOn(secondary, "search");
    const provider = new FallbackResourceProvider({
      primary: { name: "user", provider: empty },
      secondary: { name: "official", provider: secondary },
    });
    const snapshot = await provider.search({ keyword: "k" });
    expect(snapshot.id).toBe("user");
    expect(snapshot.candidates).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("does NOT fall back when the primary lacks a sourceHealth field (back-compat)", async () => {
    const legacy: ResourceProvider = { search: async () => snapshotWith({ id: "user" }) };
    const secondary = okProvider("official");
    const spy = vi.spyOn(secondary, "search");
    const provider = new FallbackResourceProvider({
      primary: { name: "user", provider: legacy },
      secondary: { name: "official", provider: secondary },
    });
    const snapshot = await provider.search({ keyword: "k" });
    expect(snapshot.id).toBe("user");
    expect(spy).not.toHaveBeenCalled();
  });
});
