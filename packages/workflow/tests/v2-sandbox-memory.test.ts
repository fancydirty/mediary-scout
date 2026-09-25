import { describe, expect, it } from "vitest";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import { InMemoryWorkflowRepository } from "../src/repository.js";
import { AGENT_MEMORY_LIMITS } from "../src/agent-memory.js";

function sandboxWith(store = new InMemoryWorkflowRepository(), titleKey = "tmdb_tv_1") {
  const sandbox = new TaskSandbox({
    provider: new FakeResourceProviderV2({ results: {} }),
    need: ["S01E01"],
    memory: { store, accountId: "acct_1", titleKey, runId: "run-1", now: () => "2026-09-25T00:00:00.000Z" },
  });
  return { sandbox, store };
}
const e = (over: Record<string, unknown> = {}) => ({ scope: "title", name: "no-2025-year", description: "d", kind: "search", body: "搜 X 0 命中", ...over }) as never;

describe("TaskSandbox memory tools", () => {
  it("writeMemory(title) lands under the BOUND title key — a titleKey in the args is ignored", async () => {
    const { sandbox, store } = sandboxWith();
    await sandbox.writeMemory({ ...(e() as object), titleKey: "tmdb_tv_999" } as never);
    expect(await store.listAgentMemories({ accountId: "acct_1", scope: "title", titleKey: "tmdb_tv_1" })).toHaveLength(1);
    expect(await store.listAgentMemories({ accountId: "acct_1", scope: "title", titleKey: "tmdb_tv_999" })).toHaveLength(0);
    const [row] = await store.listAgentMemories({ accountId: "acct_1", scope: "title", titleKey: "tmdb_tv_1" });
    expect(row!.sourceRunId).toBe("run-1");
  });

  it("deleteMemory can only reach this title or global", async () => {
    const { sandbox, store } = sandboxWith();
    await store.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_tv_2", entry: e() as never, now: "x" });
    await sandbox.writeMemory(e());
    expect(await sandbox.deleteMemory({ scope: "title", name: "no-2025-year" })).toEqual({ deleted: true });
    expect(await store.listAgentMemories({ accountId: "acct_1", scope: "title", titleKey: "tmdb_tv_2" })).toHaveLength(1);
  });

  it("readMemory returns the body; an unknown name is a clear error", async () => {
    const { sandbox } = sandboxWith();
    await sandbox.writeMemory(e({ scope: "global", name: "guangya-empty-shares", kind: "drive" }));
    expect((await sandbox.readMemory({ scope: "global", name: "guangya-empty-shares" })).body).toBe("搜 X 0 命中");
    await expect(sandbox.readMemory({ scope: "global", name: "nope" })).rejects.toThrow(/MEMORY_NOT_FOUND/);
  });

  it("rejects invalid input with the validator's message", async () => {
    const { sandbox } = sandboxWith();
    await expect(sandbox.writeMemory(e({ name: "Bad Name" }))).rejects.toThrow(/MEMORY_INVALID.*name/);
  });

  it("enforces the per-title entry cap (a new name at the cap is refused; overwriting is fine)", async () => {
    const store = new InMemoryWorkflowRepository();
    for (let i = 0; i < AGENT_MEMORY_LIMITS.titleEntriesMax; i += 1) {
      await store.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_tv_1", entry: e({ name: `m-${i}` }) as never, now: "x" });
    }
    const { sandbox } = sandboxWith(store);
    await expect(sandbox.writeMemory(e({ name: "one-more" }))).rejects.toThrow(/MEMORY_FULL/);
    await expect(sandbox.writeMemory(e({ name: "m-0", body: "overwrite" }))).resolves.toBeDefined();
  });

  it("caps changes per run and records audit events without the body", async () => {
    const { sandbox } = sandboxWith();
    for (let i = 0; i < AGENT_MEMORY_LIMITS.changesPerRunMax; i += 1) await sandbox.writeMemory(e({ name: `m-${i}` }));
    await expect(sandbox.writeMemory(e({ name: "m-extra" }))).rejects.toThrow(/MEMORY_RUN_LIMIT/);
    const audit = sandbox.auditTrail().filter((a) => a.type === "memory_written");
    expect(audit).toHaveLength(AGENT_MEMORY_LIMITS.changesPerRunMax);
    expect(JSON.stringify(audit)).not.toContain("搜 X 0 命中");
  });

  it("without a memory binding the tools refuse (no store)", async () => {
    const sandbox = new TaskSandbox({ provider: new FakeResourceProviderV2({ results: {} }), need: [] });
    await expect(sandbox.writeMemory(e())).rejects.toThrow(/MEMORY_UNAVAILABLE/);
  });
});

describe("memory tools exposed to the models", () => {
  it("readMemory returns a narrow projection — no ids, account, bound key or run id", async () => {
    const { sandbox } = sandboxWith();
    await sandbox.writeMemory(e({ scope: "global", name: "g1", kind: "drive" }));
    const view = await sandbox.readMemory({ scope: "global", name: "g1" });
    expect(Object.keys(view).sort()).toEqual(["body", "description", "kind", "name", "provider", "scope", "updatedAt"]);
  });

  it("the main acquisition tool set has readMemory (read-only) when memory is bound, and no write/delete", async () => {
    const { buildSandboxToolSet } = await import("../src/acquisition-v2/agent-loop.js");
    const { sandbox } = sandboxWith();
    const names = Object.keys(buildSandboxToolSet(sandbox, {}));
    expect(names).toContain("readMemory");
    expect(names).not.toContain("writeMemory");
    expect(names).not.toContain("deleteMemory");
    const bare = new TaskSandbox({ provider: new FakeResourceProviderV2({ results: {} }), need: [] });
    expect(Object.keys(buildSandboxToolSet(bare, {}))).not.toContain("readMemory");
  });
});

describe("per-run memory quota under concurrent tool calls (Copilot #272 r6)", () => {
  it("parallel writes cannot exceed changesPerRunMax", async () => {
    const { sandbox, store } = sandboxWith();
    const n = AGENT_MEMORY_LIMITS.changesPerRunMax + 3;
    const results = await Promise.allSettled(
      Array.from({ length: n }, (_, i) => sandbox.writeMemory(e({ name: `m-${i}` }))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(AGENT_MEMORY_LIMITS.changesPerRunMax);
    expect(await store.listAgentMemories({ accountId: "acct_1", scope: "title", titleKey: "tmdb_tv_1" })).toHaveLength(AGENT_MEMORY_LIMITS.changesPerRunMax);
    expect(sandbox.memoryChangeCount()).toBe(AGENT_MEMORY_LIMITS.changesPerRunMax);
  });

  it("a failed write or a delete of nothing gives the slot back", async () => {
    const { sandbox } = sandboxWith();
    await expect(sandbox.writeMemory(e({ name: "Bad Name" }))).rejects.toThrow(/MEMORY_INVALID/);
    expect(await sandbox.deleteMemory({ scope: "title", name: "absent" })).toEqual({ deleted: false });
    expect(sandbox.memoryChangeCount()).toBe(0);
  });
});

describe("search history for the reflection digest (Copilot #272 r7)", () => {
  it("keeps every keyword even when two return the same content, and records refusals and errors", async () => {
    const same = [{ id: "c1", title: "Show 1080p", sizeBytes: 1, kind: "share" }];
    const provider = new FakeResourceProviderV2({ results: { Show: same, "Show 2025": same } } as never);
    const sandbox = new TaskSandbox({ provider, need: ["S01E01"], titleTerms: ["Show"] } as never);
    await sandbox.searchResources("Show");
    await sandbox.searchResources("Show 2025");
    await sandbox.searchResources("Show");
    await expect(sandbox.searchResources("2025 电影")).rejects.toThrow();
    const history = sandbox.searchHistory();
    expect(history.map((h) => [h.keyword, h.calls, h.outcome])).toEqual([
      ["Show", 2, "ok"],
      ["Show 2025", 1, "ok"],
      ["2025 电影", 1, "refused"],
    ]);
  });

  it("records a provider error for that keyword", async () => {
    const provider = { search: async () => { throw new Error("PanSou timeout"); } };
    const sandbox = new TaskSandbox({ provider, need: ["S01E01"], titleTerms: ["Show"] } as never);
    await expect(sandbox.searchResources("Show")).rejects.toThrow(/PanSou timeout/);
    expect(sandbox.searchHistory()).toMatchObject([{ keyword: "Show", outcome: "error", note: "PanSou timeout" }]);
  });
});

describe("revisions keep the drive association (Copilot #272 r9)", () => {
  it("an update that omits provider keeps the stored one; an explicit provider still wins", async () => {
    const { sandbox, store } = sandboxWith();
    await sandbox.writeMemory(e({ scope: "global", name: "g", kind: "drive", provider: "guangya" }));
    await sandbox.writeMemory(e({ scope: "global", name: "g", kind: "drive", body: "改过" }));
    let [row] = await store.listAgentMemories({ accountId: "acct_1", scope: "global" });
    expect(row).toMatchObject({ body: "改过", provider: "guangya" });
    await sandbox.writeMemory(e({ scope: "global", name: "g", kind: "drive", provider: "pan123" }));
    [row] = await store.listAgentMemories({ accountId: "acct_1", scope: "global" });
    expect(row!.provider).toBe("pan123");
  });
});

describe("notes are tagged with the run's drive (production e2e 2026-09-25)", () => {
  it("the bound drive tags every write and the model cannot override it", async () => {
    const store = new InMemoryWorkflowRepository();
    const sandbox = new TaskSandbox({
      provider: new FakeResourceProviderV2({ results: {} }),
      need: ["MOVIE"],
      memory: { store, accountId: "acct_1", titleKey: "tmdb_movie_1", runId: "run-1", provider: "pan115", now: () => "2026-09-25T00:00:00.000Z" },
    });
    await sandbox.writeMemory(e({ name: "a", provider: "guangya" }));
    await sandbox.writeMemory(e({ name: "b" }));
    const rows = await store.listAgentMemories({ accountId: "acct_1", scope: "title", titleKey: "tmdb_movie_1" });
    expect(rows.map((r) => [r.name, r.provider]).sort()).toEqual([["a", "pan115"], ["b", "pan115"]]);
  });
});

describe("a drive cannot change another drive's notes (Copilot #273 r1)", () => {
  const bound = (store: InMemoryWorkflowRepository, provider: string) =>
    new TaskSandbox({
      provider: new FakeResourceProviderV2({ results: {} }),
      need: ["MOVIE"],
      memory: { store, accountId: "acct_1", titleKey: "tmdb_movie_1", runId: `run-${provider}`, provider, now: () => "2026-09-25T00:00:00.000Z" },
    });

  it("overwrite and delete of a note tagged with another drive are refused, and the slot is given back", async () => {
    const store = new InMemoryWorkflowRepository();
    await bound(store, "guangya").writeMemory(e({ name: "src", body: "SONYHD 落盘成功" }));
    await bound(store, "guangya").writeMemory(e({ scope: "global", name: "g", kind: "drive", body: "光鸭经验" }));
    const on115 = bound(store, "pan115");
    await expect(on115.writeMemory(e({ name: "src", body: "SONYHD 是假的" }))).rejects.toThrow(/MEMORY_OTHER_DRIVE/);
    await expect(on115.deleteMemory({ scope: "title", name: "src" })).rejects.toThrow(/MEMORY_OTHER_DRIVE/);
    await expect(on115.deleteMemory({ scope: "global", name: "g" })).rejects.toThrow(/MEMORY_OTHER_DRIVE/);
    expect(on115.memoryChangeCount()).toBe(0);
    const [row] = await store.listAgentMemories({ accountId: "acct_1", scope: "title", titleKey: "tmdb_movie_1" });
    expect(row).toMatchObject({ body: "SONYHD 落盘成功", provider: "guangya" });
    expect(await store.listAgentMemories({ accountId: "acct_1", scope: "global" })).toHaveLength(1);
  });

  it("the same drive and untagged notes stay editable", async () => {
    const store = new InMemoryWorkflowRepository();
    await store.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_movie_1", entry: { ...(e({ name: "untagged" }) as object) } as never, now: "t" });
    const on115 = bound(store, "pan115");
    await on115.writeMemory(e({ name: "untagged", body: "115 补充" }));
    await on115.writeMemory(e({ name: "mine" }));
    await on115.writeMemory(e({ name: "mine", body: "改" }));
    expect(await on115.deleteMemory({ scope: "title", name: "mine" })).toEqual({ deleted: true });
  });
});

describe("drive guard is enforced by the store, not only the pre-check (Copilot #273 r2)", () => {
  it("a note re-tagged by another drive AFTER the sandbox read is still not deleted or overwritten", async () => {
    const store = new InMemoryWorkflowRepository();
    await store.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_movie_1", entry: e({ name: "n" }), now: "t" });
    // Another run (guangya) tags the row right after this run lists it.
    const realList = store.listAgentMemories.bind(store);
    store.listAgentMemories = async (input) => {
      const rows = await realList(input);
      await store.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_movie_1", entry: e({ name: "n", body: "光鸭经验", provider: "guangya" }), now: "t2" });
      return rows;
    };
    const sandbox = new TaskSandbox({
      provider: new FakeResourceProviderV2({ results: {} }),
      need: ["MOVIE"],
      memory: { store, accountId: "acct_1", titleKey: "tmdb_movie_1", runId: "r", provider: "pan115", now: () => "t3" },
    });
    await expect(sandbox.writeMemory(e({ name: "n", body: "115 覆盖" }))).rejects.toThrow(/MEMORY_OTHER_DRIVE/);
    await expect(sandbox.deleteMemory({ scope: "title", name: "n" })).rejects.toThrow(/MEMORY_OTHER_DRIVE/);
    const [row] = await realList({ accountId: "acct_1", scope: "title", titleKey: "tmdb_movie_1" });
    expect(row).toMatchObject({ body: "光鸭经验", provider: "guangya" });
  });
});
