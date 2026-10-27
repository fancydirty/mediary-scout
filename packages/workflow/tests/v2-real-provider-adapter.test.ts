import { describe, expect, it } from "vitest";
import { CandidateRegistry } from "../src/acquisition-v2/candidate-registry.js";
import { RealResourceProviderV2 } from "../src/acquisition-v2/real-provider-adapter.js";
import type { ResourceProvider } from "../src/ports.js";
import type { ResourceSnapshot, SnapshotPrefilter } from "../src/domain.js";

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

function prefilterOf(overrides: Partial<SnapshotPrefilter> & Pick<SnapshotPrefilter, "status">): SnapshotPrefilter {
  return {
    provider: "jev",
    model: "m",
    scores: {},
    dropped: [],
    thresholds: { dropBelow: 0.3, uncertainBelow: 0.7 },
    durationMs: 1,
    ...overrides,
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
    // Short run-local aliases, not the provider's long ids.
    expect(snapshot.id).toBe("s1");
    expect(snapshot.candidates).toEqual([
      { id: "s1-1", title: "莉可丽丝 全集 1080p" },
    ]);
    // The run id is threaded so content-addressed snapshots don't collide across runs.
    expect(calls[0]).toEqual({ keyword: "莉可丽丝 全集", workflowRunId: "run-1" });
    // The real candidate (with its share payload) is recorded so the storage
    // adapter can transfer it later by id — the agent never sees the raw url.
    // Resolvable by both the alias the agent was shown and the real id.
    expect(registry.get("s1-1")?.providerPayload).toEqual({ url: "https://115.com/s/abc", receiveCode: "x1" });
    expect(registry.get("cand_a")).toBe(registry.get("s1-1"));
    // Persisted snapshots keep the real ids.
    expect(adapter.snapshots()[0]!.id).toBe("snap_real_1");
    expect(adapter.snapshots()[0]!.candidates[0]!.id).toBe("cand_a");
  });

  it("gives each new snapshot the next alias and a repeated snapshot the same one", async () => {
    const other: ResourceSnapshot = { ...realSnapshot(), id: "snap_real_2", candidates: realSnapshot().candidates.map((c) => ({ ...c, id: "cand_b", snapshotId: "snap_real_2" })) };
    let n = 0;
    const provider: ResourceProvider = { search: async () => (n++ === 1 ? other : realSnapshot()) };
    const adapter = new RealResourceProviderV2({ provider, registry: new CandidateRegistry(), workflowRunId: "run-1" });
    expect((await adapter.search("a")).id).toBe("s1");
    expect((await adapter.search("b")).id).toBe("s2");
    expect((await adapter.search("c")).candidates[0]!.id).toBe("s1-1");
  });

  it("keeps a candidate's alias when dead-link filtering removes an earlier neighbour", async () => {
    const base = realSnapshot().candidates[0]!;
    const snapshot: ResourceSnapshot = {
      ...realSnapshot(),
      candidates: [
        { ...base, id: "dead", providerPayload: { url: "https://115.com/s/deadcode" } },
        { ...base, id: "live", index: 1, providerPayload: { url: "https://115.com/s/livecode" } },
      ],
    };
    const adapter = new RealResourceProviderV2({
      provider: { search: async () => snapshot },
      registry: new CandidateRegistry(),
      workflowRunId: "run-1",
      deadLinkStore: { recordDeadLink: async () => {}, listDeadLinkKeys: async () => ["115:deadcode"] },
    });
    expect((await adapter.search("k")).candidates.map((c) => c.id)).toEqual(["s1-2"]);
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

    // The agent only ever sees the live candidate, under its position alias.
    expect(view.candidates.map((c) => c.id)).toEqual(["s1-1"]);
    // The persisted snapshot reflects the filtered view (no dead candidates), and
    // the dead ones are never recorded in the registry (the agent can't transfer them).
    expect(adapter.snapshots()[0]!.candidates.map((c) => c.id)).toEqual(["live"]);
    expect(registry.get("live")).toBeDefined();
    expect(registry.get("dead_share")).toBeUndefined();
    expect(registry.get("dead_magnet")).toBeUndefined();
  });

  it("a failing dead-link read fails the search instead of showing the recorded dead links again (never fails open)", async () => {
    const snapshotWithDead: ResourceSnapshot = {
      ...realSnapshot(),
      candidates: [
        { ...realSnapshot().candidates[0]!, id: "live", providerPayload: { url: "https://115.com/s/livecode" } },
        { ...realSnapshot().candidates[0]!, id: "dead_share", providerPayload: { url: "https://115.com/s/deadcode" } },
      ],
    };
    const registry = new CandidateRegistry();
    const adapter = new RealResourceProviderV2({
      provider: { search: async () => snapshotWithDead },
      registry,
      workflowRunId: "run-1",
      deadLinkStore: {
        recordDeadLink: async () => {},
        listDeadLinkKeys: async () => {
          throw new Error("db down");
        },
      },
      // The rejected list reads fine: it is the dead-link read that must not fail open.
      rejectedResources: { list: async () => [] },
    });

    await expect(adapter.search("k1")).rejects.toThrow("db down");
    // Nothing of the failed search reached the agent's registry or the persisted snapshots.
    expect(registry.get("dead_share")).toBeUndefined();
    expect(adapter.snapshots()).toEqual([]);
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

    expect(view.candidates.map((c) => c.id)).toEqual(["s1-1"]);
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
    expect(candidate.id).toBe("s1-1");
    expect(candidate.title).toBe("莉可丽丝 全集 1080p");
  });

  it("carries an applied prefilter's scores and dropped count to the V2 snapshot", async () => {
    const scores = { cand_a: 0.52 };
    const provider: ResourceProvider = {
      search: async () => ({
        ...realSnapshot(),
        prefilter: prefilterOf({ status: "applied", scores, dropped: [{ id: "x", title: "y", score: 0.1 }] }),
      }),
    };
    const adapter = new RealResourceProviderV2({
      provider,
      registry: new CandidateRegistry(),
      workflowRunId: "run-1",
    });

    const view = await adapter.search("莉可丽丝 全集");

    // Keyed by the alias the agent sees, so the ⚠ lands on the right row.
    expect(view.prefilterScores).toEqual({ "s1-1": 0.52 });
    // Shallow copy: the V2 view must not share the persisted snapshot's object.
    expect(view.prefilterScores).not.toBe(scores);
    expect(view.prefilterDropped).toBe(1);
  });

  it("counts adult-content drops in prefilterDropped so an all-porn result is not an empty search", async () => {
    const provider: ResourceProvider = {
      search: async () => ({
        ...realSnapshot(),
        prefilter: prefilterOf({
          status: "applied",
          scores: {},
          dropped: [{ id: "x", title: "y", score: 0.1 }],
          nsfwDropped: [{ id: "p1", title: "porn", score: 0.99 }, { id: "p2", title: "porn2", score: 0.97 }],
        }),
      }),
    };
    const adapter = new RealResourceProviderV2({ provider, registry: new CandidateRegistry(), workflowRunId: "run-1" });
    const view = await adapter.search("出入平安");
    expect(view.prefilterDropped).toBe(3);
  });

  it("omits both prefilter fields when the prefilter failed (fail-open, nothing dropped)", async () => {
    const provider: ResourceProvider = {
      search: async () => ({
        ...realSnapshot(),
        prefilter: prefilterOf({ status: "failed", reason: "timeout" }),
      }),
    };
    const adapter = new RealResourceProviderV2({
      provider,
      registry: new CandidateRegistry(),
      workflowRunId: "run-1",
    });

    const view = await adapter.search("莉可丽丝 全集");

    expect(view.prefilterScores).toBeUndefined();
    expect(view.prefilterDropped).toBeUndefined();
  });

  it("omits both prefilter fields when the prefilter was skipped", async () => {
    const provider: ResourceProvider = {
      search: async () => ({ ...realSnapshot(), prefilter: prefilterOf({ status: "skipped" }) }),
    };
    const adapter = new RealResourceProviderV2({
      provider,
      registry: new CandidateRegistry(),
      workflowRunId: "run-1",
    });

    const view = await adapter.search("莉可丽丝 全集");

    expect(view.prefilterScores).toBeUndefined();
    expect(view.prefilterDropped).toBeUndefined();
  });

  it("omits both prefilter fields when no prefilter ran at all", async () => {
    const provider: ResourceProvider = { search: async () => realSnapshot() };
    const adapter = new RealResourceProviderV2({
      provider,
      registry: new CandidateRegistry(),
      workflowRunId: "run-1",
    });

    const view = await adapter.search("莉可丽丝 全集");

    expect(view.prefilterScores).toBeUndefined();
    expect(view.prefilterDropped).toBeUndefined();
  });

  it("sets postedAt only when providerPayload.datetime is a real date (year ≥ 2000)", async () => {
    const base = realSnapshot().candidates[0]!;
    const snapshot: ResourceSnapshot = {
      ...realSnapshot(),
      candidates: [
        { ...base, id: "dated", providerPayload: { url: "https://www.123pan.com/s/Ab-cD_12", datetime: "2026-04-06T08:00:00Z" } },
        { ...base, id: "unknown", index: 1, providerPayload: { url: "https://www.123pan.com/s/unknown", datetime: "0001-01-01T00:00:00Z" } },
        { ...base, id: "garbage", index: 2, providerPayload: { url: "https://www.123pan.com/s/garbage", datetime: "not-a-date" } },
        { ...base, id: "impossible", index: 3, providerPayload: { datetime: "2026-02-31T00:00:00Z" } },
      ],
    };
    const adapter = new RealResourceProviderV2({
      provider: { search: async () => snapshot },
      registry: new CandidateRegistry(),
      workflowRunId: "run-1",
    });

    const view = await adapter.search("莉可丽丝 全集");

    expect(view.candidates.map((c) => ({ id: c.id, postedAt: c.postedAt }))).toEqual([
      { id: "s1-1", postedAt: "2026-04-06" },
      { id: "s1-2", postedAt: undefined },
      { id: "s1-3", postedAt: undefined },
      { id: "s1-4", postedAt: undefined },
    ]);
  });

  it("annotates drive and driveLabel only when the snapshot contains multiple distinct brands/channels", async () => {
    const base = realSnapshot().candidates[0]!;
    const multiSnapshot: ResourceSnapshot = {
      ...realSnapshot(),
      candidates: [
        { ...base, id: "c115", type: "115", providerPayload: { url: "https://115.com/s/sw3abcd1234" } },
        { ...base, id: "cQuark", index: 1, type: "quark", providerPayload: { url: "https://pan.quark.cn/s/1a2B3c4D", sizeBytes: 4_200_000_000 } },
        { ...base, id: "cMag", index: 2, type: "magnet", providerPayload: { url: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567" } },
      ],
    };
    const adapter = new RealResourceProviderV2({
      provider: { search: async () => multiSnapshot },
      registry: new CandidateRegistry(),
      workflowRunId: "run-1",
    });

    const view = await adapter.search("莉可丽丝 全集");
    expect(view.candidates).toEqual([
      { id: "s1-1", title: "莉可丽丝 全集 1080p", drive: "115", driveLabel: "115" },
      { id: "s1-2", title: "莉可丽丝 全集 1080p", drive: "quark", driveLabel: "夸克", sizeBytes: 4_200_000_000 },
      { id: "s1-3", title: "莉可丽丝 全集 1080p", drive: "magnet", driveLabel: "磁力" },
    ]);
  });
});
