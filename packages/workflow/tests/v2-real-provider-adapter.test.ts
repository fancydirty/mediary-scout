import { describe, expect, it } from "vitest";
import { CandidateRegistry } from "../src/acquisition-v2/candidate-registry.js";
import { RealResourceProviderV2 } from "../src/acquisition-v2/real-provider-adapter.js";
import type { ResourceProvider } from "../src/ports.js";
import type { ResourceSnapshot } from "../src/domain.js";

function realSnapshot(): ResourceSnapshot {
  return {
    id: "snap_real_1",
    provider: "pansou",
    keyword: "莉可丽丝 全集",
    createdAt: "2026-06-14T00:00:00.000Z",
    candidates: [
      {
        id: "cand_a",
        snapshotId: "snap_real_1",
        index: 0,
        title: "莉可丽丝 全集 1080p",
        type: "115",
        source: "pansou",
        providerPayload: { url: "https://115.com/s/abc", receiveCode: "x1" },
      },
    ],
  };
}

describe("RealResourceProviderV2 — pansou → ResourceProviderV2 adapter", () => {
  it("maps a real snapshot to the V2 shape and records candidates in the registry", async () => {
    const calls: Array<{ keyword: string; workflowRunId?: string }> = [];
    const provider: ResourceProvider = {
      search: async (input) => {
        calls.push(input);
        return realSnapshot();
      },
    };
    const registry = new CandidateRegistry();
    const adapter = new RealResourceProviderV2({ provider, registry, workflowRunId: "run-1" });

    const snapshot = await adapter.search("莉可丽丝 全集");

    // V2 shape: id/keyword/candidates with only the fields the agent judges from.
    expect(snapshot.id).toBe("snap_real_1");
    expect(snapshot.candidates).toEqual([
      { id: "cand_a", title: "莉可丽丝 全集 1080p" },
    ]);
    // The run id is threaded so content-addressed snapshots don't collide across runs.
    expect(calls[0]).toEqual({ keyword: "莉可丽丝 全集", workflowRunId: "run-1" });
    // The real candidate (with its share payload) is recorded so the storage
    // adapter can transfer it later by id — the agent never sees the raw url.
    const recorded = registry.get("cand_a");
    expect(recorded?.providerPayload).toEqual({ url: "https://115.com/s/abc", receiveCode: "x1" });
  });

  it("records every candidate across multiple searches (registry accumulates)", async () => {
    const provider: ResourceProvider = { search: async () => realSnapshot() };
    const registry = new CandidateRegistry();
    const adapter = new RealResourceProviderV2({ provider, registry, workflowRunId: "run-1" });

    await adapter.search("k1");
    expect(registry.get("cand_a")).toBeDefined();
    expect(registry.get("missing")).toBeUndefined();
  });

  it("filters out known-dead candidates before the agent sees them (#15)", async () => {
    const snapshotWithDead: ResourceSnapshot = {
      ...realSnapshot(),
      candidates: [
        { ...realSnapshot().candidates[0]!, id: "live", providerPayload: { url: "https://115.com/s/livecode" } },
        { ...realSnapshot().candidates[0]!, id: "dead_share", providerPayload: { url: "https://115cdn.com/s/deadcode?password=x" } },
        { ...realSnapshot().candidates[0]!, id: "dead_magnet", type: "magnet", providerPayload: { url: "magnet:?xt=urn:btih:edef9b0fc91c9ccdf5b3e43f6cc5278160e81dd5" } },
      ],
    };
    const deadKeys = ["115:deadcode", "magnet:edef9b0fc91c9ccdf5b3e43f6cc5278160e81dd5"];
    const deadLinkStore = {
      recordDeadLink: async () => {},
      listDeadLinkKeys: async () => deadKeys,
    };
    const provider: ResourceProvider = { search: async () => snapshotWithDead };
    const registry = new CandidateRegistry();
    const adapter = new RealResourceProviderV2({ provider, registry, workflowRunId: "run-1", deadLinkStore });

    const view = await adapter.search("k1");

    // The agent only ever sees the live candidate.
    expect(view.candidates.map((c) => c.id)).toEqual(["live"]);
    // The persisted snapshot reflects the filtered view (no dead candidates), and
    // the dead ones are never recorded in the registry (the agent can't transfer them).
    expect(adapter.snapshots()[0]!.candidates.map((c) => c.id)).toEqual(["live"]);
    expect(registry.get("live")).toBeDefined();
    expect(registry.get("dead_share")).toBeUndefined();
    expect(registry.get("dead_magnet")).toBeUndefined();
  });

  it("carries an unreachable sourceHealth through to the V2 snapshot (Task 9)", async () => {
    const provider: ResourceProvider = {
      search: async () => ({
        ...realSnapshot(),
        candidates: [],
        sourceHealth: { status: "unreachable", unhealthySources: ["pansou"] },
      }),
    };
    const adapter = new RealResourceProviderV2({
      provider,
      registry: new CandidateRegistry(),
      workflowRunId: "run-1",
    });

    const view = await adapter.search("莉可丽丝 全集");

    // 源挂了必须穿过 V2 边界。丢了它,沙箱就无法把「源故障」与「确实没有」区分开。
    expect(view.sourceHealth).toEqual({ status: "unreachable", unhealthySources: ["pansou"] });
  });

  it("carries a healthy sourceHealth verbatim (pass-through, not dropped)", async () => {
    const provider: ResourceProvider = {
      search: async () => ({ ...realSnapshot(), sourceHealth: { status: "healthy", unhealthySources: [] } }),
    };
    const adapter = new RealResourceProviderV2({
      provider,
      registry: new CandidateRegistry(),
      workflowRunId: "run-1",
    });

    const view = await adapter.search("莉可丽丝 全集");

    expect(view.sourceHealth).toEqual({ status: "healthy", unhealthySources: [] });
  });

  it("omits sourceHealth when the domain snapshot has none (old providers keep working)", async () => {
    const provider: ResourceProvider = { search: async () => realSnapshot() };
    const adapter = new RealResourceProviderV2({
      provider,
      registry: new CandidateRegistry(),
      workflowRunId: "run-1",
    });

    const view = await adapter.search("莉可丽丝 全集");

    expect(view.sourceHealth).toBeUndefined();
  });

  it("dead-link filtering still works when sourceHealth is present (regression guard)", async () => {
    const base = realSnapshot();
    const snapshotWithDead: ResourceSnapshot = {
      ...base,
      candidates: [
        { ...base.candidates[0]!, id: "live", providerPayload: { url: "https://115.com/s/livecode" } },
        { ...base.candidates[0]!, id: "dead_share", providerPayload: { url: "https://115cdn.com/s/deadcode?password=x" } },
      ],
      sourceHealth: { status: "degraded", unhealthySources: ["prowlarr"] },
    };
    const deadLinkStore = {
      recordDeadLink: async () => {},
      listDeadLinkKeys: async () => ["115:deadcode"],
    };
    const registry = new CandidateRegistry();
    const adapter = new RealResourceProviderV2({
      provider: { search: async () => snapshotWithDead },
      registry,
      workflowRunId: "run-1",
      deadLinkStore,
    });

    const view = await adapter.search("k1");

    expect(view.candidates.map((c) => c.id)).toEqual(["live"]);
    expect(view.sourceHealth).toEqual({ status: "degraded", unhealthySources: ["prowlarr"] });
    expect(adapter.snapshots()[0]!.candidates.map((c) => c.id)).toEqual(["live"]);
    expect(registry.get("dead_share")).toBeUndefined();
  });

  it("agent-facing candidate exposes only id and title (no hints) — Task 3", async () => {
    const provider: ResourceProvider = { search: async () => realSnapshot() };
    const registry = new CandidateRegistry();
    const adapter = new RealResourceProviderV2({ provider, registry, workflowRunId: "run-1" });

    const snapshot = await adapter.search("莉可丽丝 全集");

    const candidate = snapshot.candidates[0]!;
    expect(Object.keys(candidate).sort()).toEqual(["id", "title"]);
    expect(candidate.id).toBe("cand_a");
    expect(candidate.title).toBe("莉可丽丝 全集 1080p");
  });
});
