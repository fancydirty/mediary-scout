import { describe, expect, it } from "vitest";
import { CompositeResourceProvider } from "../src/composite-provider.js";
import type { ResourceProvider } from "../src/ports.js";
import type { ResourceSnapshot } from "../src/domain.js";
import { PanSouProtocolError } from "../src/resource-source-health.js";

function stubProvider(over: Partial<ResourceSnapshot> = {}): ResourceProvider {
  return {
    search: async () => ({
      id: "s1",
      provider: "stub",
      keyword: "k",
      candidates: [],
      createdAt: "2026-08-06T00:00:00.000Z",
      ...over,
    }),
  };
}

function throwingProvider(message: string, code?: string): ResourceProvider {
  return {
    search: async () => {
      throw code ? Object.assign(new Error(message), { code }) : new Error(message);
    },
  };
}

describe("CompositeResourceProvider source health", () => {
  it("is healthy when all members answered", async () => {
    const composite = new CompositeResourceProvider({
      providers: [
        { name: "pansou", provider: stubProvider() },
        { name: "prowlarr", provider: stubProvider() },
      ],
    });
    const snapshot = await composite.search({ keyword: "k" });
    expect(snapshot.sourceHealth?.status).toBe("healthy");
    expect(snapshot.sourceHealth?.unhealthySources).toEqual([]);
  });

  it("is degraded and names the dead member when one throws", async () => {
    const composite = new CompositeResourceProvider({
      providers: [
        { name: "pansou", provider: stubProvider() },
        { name: "prowlarr", provider: throwingProvider("boom", "ECONNREFUSED") },
      ],
    });
    const snapshot = await composite.search({ keyword: "k" });
    expect(snapshot.sourceHealth?.status).toBe("degraded");
    expect(snapshot.sourceHealth?.unhealthySources).toEqual(["prowlarr"]);
  });

  it("is unreachable when every member is down", async () => {
    const composite = new CompositeResourceProvider({
      providers: [
        { name: "pansou", provider: throwingProvider("boom", "ECONNREFUSED") },
        { name: "prowlarr", provider: throwingProvider("boom", "ETIMEDOUT") },
      ],
    });
    const snapshot = await composite.search({ keyword: "k" });
    expect(snapshot.sourceHealth?.status).toBe("unreachable");
    expect(snapshot.sourceHealth?.unhealthySources).toEqual(["pansou", "prowlarr"]);
  });

  it("reads a member's OWN unhealthy self-report even though it did not throw", async () => {
    // PanSou reports unreachable via sourceHealth rather than by throwing (Task 2),
    // so reading only the Promise status would miss it entirely.
    const composite = new CompositeResourceProvider({
      providers: [
        {
          name: "pansou",
          provider: stubProvider({
            sourceHealth: { status: "unreachable", unhealthySources: ["pansou"] },
          }),
        },
        { name: "prowlarr", provider: stubProvider() },
      ],
    });
    const snapshot = await composite.search({ keyword: "k" });
    expect(snapshot.sourceHealth?.status).toBe("degraded");
    expect(snapshot.sourceHealth?.unhealthySources).toEqual(["pansou"]);
  });

  it("never reports unreachable while candidates were actually returned", async () => {
    // 自相矛盾的快照:成员自报 degraded(内部有子源挂了)但确实给了候选。若把
    // degraded 压成 unreachable,整体会变成「有候选却说一个都没取回」,agent
    // 会读到一句假话。Copilot 评审指出的这一点。
    const degradedWithCandidate: ResourceProvider = {
      search: async () => ({
        id: "s1",
        provider: "stub",
        keyword: "k",
        createdAt: "2026-08-06T00:00:00.000Z",
        sourceHealth: { status: "degraded", unhealthySources: ["prowlarr"] },
        candidates: [
          {
            id: "c1",
            snapshotId: "s1",
            index: 0,
            title: "命中",
            type: "quark",
            source: "pansou",
            providerPayload: { url: "https://pan.quark.cn/s/abc" },
          },
        ],
      }),
    };
    const composite = new CompositeResourceProvider({
      providers: [{ name: "pansou", provider: degradedWithCandidate }],
    });

    const snapshot = await composite.search({ keyword: "k" });

    expect(snapshot.candidates.length).toBe(1);
    expect(snapshot.sourceHealth?.status).not.toBe("unreachable");
  });

  it("preserves protocol_error when it is the single cause of total failure", async () => {
    // 「地址填错了」and「源挂了」need different user action, so the distinction
    // must survive the merge (see mergeSourceHealth).
    const composite = new CompositeResourceProvider({
      providers: [
        {
          name: "pansou",
          provider: stubProvider({
            sourceHealth: { status: "protocol_error", unhealthySources: ["pansou"] },
          }),
        },
      ],
    });
    const snapshot = await composite.search({ keyword: "k" });
    expect(snapshot.sourceHealth?.status).toBe("protocol_error");
  });

  it("preserves a member's degraded signal (not folded to healthy)", async () => {
    // 两次 Copilot 评审的合流结论:degraded 折成 healthy 会让「部分证据」看起来
    // 像「完整证据」,把本 PR 要消灭的静默误导从另一端放回来。这个信号对上层
    // 判断「能不能下『没找到』结论」至关重要。
    const degradedProvider: ResourceProvider = {
      search: async () => ({
        id: "s1",
        provider: "stub",
        keyword: "k",
        createdAt: "2026-08-06T00:00:00.000Z",
        sourceHealth: { status: "degraded", unhealthySources: ["官方搜索源"] },
        candidates: [],
      }),
    };
    const composite = new CompositeResourceProvider({
      providers: [{ name: "pansou", provider: degradedProvider }],
    });

    const snapshot = await composite.search({ keyword: "k" });

    expect(snapshot.sourceHealth?.status).toBe("degraded");
  });

  it("preserves protocol_error when a member THROWS PanSouProtocolError", async () => {
    // 硬编码 unreachable 会把「地址指向了别的服务」压成「源挂了」,用户拿到
    // 错误的处置建议(Copilot 评审的 suppressed 意见)。
    const throwingProtocol: ResourceProvider = {
      search: async () => {
        throw new PanSouProtocolError("not a PanSou payload");
      },
    };
    const composite = new CompositeResourceProvider({
      providers: [{ name: "pansou", provider: throwingProtocol }],
    });

    const snapshot = await composite.search({ keyword: "k" });

    expect(snapshot.sourceHealth?.status).toBe("protocol_error");
  });

  it("treats a member with NO sourceHealth field as healthy (back-compat)", async () => {
    const composite = new CompositeResourceProvider({
      providers: [{ name: "legacy", provider: stubProvider() }],
    });
    const snapshot = await composite.search({ keyword: "k" });
    expect(snapshot.sourceHealth?.status).toBe("healthy");
  });

  it("still merges candidates from the surviving member when another is down", async () => {
    // Health reporting must not cost us the results we DID get.
    const withCandidate = stubProvider({
      candidates: [
        {
          id: "c1",
          snapshotId: "s1",
          index: 0,
          title: "命中",
          type: "quark",
          source: "pansou",
          providerPayload: { url: "https://pan.quark.cn/s/abc" },
        },
      ],
    });
    const composite = new CompositeResourceProvider({
      providers: [
        { name: "pansou", provider: withCandidate },
        { name: "prowlarr", provider: throwingProvider("boom", "ECONNREFUSED") },
      ],
    });
    const snapshot = await composite.search({ keyword: "k" });
    expect(snapshot.candidates.length).toBe(1);
    expect(snapshot.sourceHealth?.status).toBe("degraded");
  });
});
