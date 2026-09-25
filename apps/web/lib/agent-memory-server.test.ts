import { describe, expect, it } from "vitest";
import { InMemoryWorkflowRepository } from "@media-track/workflow";
import {
  AGENT_MEMORY_ENABLED_SETTING_KEY,
  deleteMemoryFromUi,
  isAgentMemoryEnabled,
  listMemoriesForUi,
  makeDriveLabeler,
  memoryStatsForUi,
  toMemoryItem,
} from "./agent-memory-server";

const at = (iso: string) => iso;
const entry = { name: "no-2025-year", description: "「X 2025」0 结果，这部 2026 年才开播", kind: "avoid" as const, body: "搜「X 2025」0 命中" };

describe("agent memory settings + UI server logic", () => {
  it("memory is ON by default and only an explicit '0' turns it off", async () => {
    const repo = new InMemoryWorkflowRepository();
    expect(await isAgentMemoryEnabled(repo, "acct_1")).toBe(true);
    await repo.setAccountSetting("acct_1", AGENT_MEMORY_ENABLED_SETTING_KEY, "0");
    expect(await isAgentMemoryEnabled(repo, "acct_1")).toBe(false);
    await repo.setAccountSetting("acct_1", AGENT_MEMORY_ENABLED_SETTING_KEY, "1");
    expect(await isAgentMemoryEnabled(repo, "acct_1")).toBe(true);
  });

  it("lists a work's notes by (mediaType, tmdbId), scoped to the account", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_tv_7", entry: { scope: "title", ...entry }, now: at("2026-09-25T00:00:00.000Z") });
    await repo.upsertAgentMemory({ accountId: "acct_2", titleKey: "tmdb_tv_7", entry: { scope: "title", ...entry }, now: at("2026-09-25T00:00:00.000Z") });
    expect(await listMemoriesForUi(repo, "acct_1", { scope: "title", mediaType: "tv", tmdbId: 7 })).toHaveLength(1);
    expect(await listMemoriesForUi(repo, "acct_2", { scope: "global" })).toHaveLength(0);
  });

  it("delete removes one note; a missing one reports so", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_tv_7", entry: { scope: "title", ...entry }, now: at("2026-09-25T00:00:00.000Z") });
    const addr = { scope: "title", mediaType: "tv", tmdbId: 7 } as const;
    expect(await deleteMemoryFromUi(repo, "acct_1", addr, entry.name)).toEqual({ success: true });
    expect(await deleteMemoryFromUi(repo, "acct_1", addr, entry.name)).toMatchObject({ success: false });
    expect(await listMemoriesForUi(repo, "acct_1", addr)).toHaveLength(0);
  });

  it("rejects a forged mediaType or tmdbId instead of building a free-form title key", async () => {
    const repo = new InMemoryWorkflowRepository();
    const forged = { scope: "title", mediaType: "x_1_global", tmdbId: 1 } as unknown as Parameters<typeof listMemoriesForUi>[2];
    expect(await listMemoriesForUi(repo, "acct_1", forged)).toEqual([]);
    expect(await deleteMemoryFromUi(repo, "acct_1", forged, "n")).toMatchObject({ success: false });
    expect(await deleteMemoryFromUi(repo, "acct_1", { scope: "title", mediaType: "tv", tmdbId: -1 }, "n")).toMatchObject({ success: false });
  });
});

describe("toMemoryItem — what the detail page shows", () => {
  const base = { id: "m", accountId: "a", scope: "title", titleKey: "tmdb_tv_1", name: "n", description: "日文原名「氷の城壁」能搜到第 10 集以后", body: "evidence", createdAt: "t", updatedAt: "2026-09-25T00:00:00.000Z", lastUsedAt: null, sourceRunId: null } as const;

  it("shows the one-sentence conclusion and a verdict; pre-redesign pitfall reads as avoid", () => {
    expect(toMemoryItem({ ...base, kind: "works", provider: null })).toEqual({
      name: "n", text: base.description, verdict: "works", driveLabel: null, updatedAt: base.updatedAt,
    });
    expect(toMemoryItem({ ...base, kind: "avoid", provider: null }).verdict).toBe("avoid");
    expect(toMemoryItem({ ...base, kind: "pitfall", provider: null }).verdict).toBe("avoid");
    expect(toMemoryItem({ ...base, kind: "search", provider: null }).verdict).toBeNull();
    expect("body" in toMemoryItem({ ...base, kind: "works", provider: null })).toBe(false);
  });

  it("drive tag → the drive's label", () => {
    expect(toMemoryItem({ ...base, kind: "works", provider: "guangya" }).driveLabel).toBe("光鸭云盘");
  });
});

describe("drive labels resolve concrete drives", () => {
  it("storage id → its label, else brand + uid tail; bare brand → brand label; unknown id → unbound", () => {
    const label = makeDriveLabeler([
      { id: "cs_1", provider: "pan115", providerUid: "103164004", label: null },
      { id: "cs_2", provider: "pan115", providerUid: "555500001", label: "朋友的 115" },
    ]);
    expect(label("cs_1")).toBe("115 网盘 …4004");
    expect(label("cs_2")).toBe("朋友的 115");
    expect(label("guangya")).toBe("光鸭云盘");
    expect(label("cs_gone_123")).toBe("已解绑的网盘");
  });
});

describe("memoryStatsForUi — settings page numbers", () => {
  it("counts notes and works, notes added in the last 7 days, and names the latest work", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_tv_1", entry: { scope: "title", ...entry, name: "old" }, now: at("2026-09-01T00:00:00.000Z") });
    await repo.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_tv_1", entry: { scope: "title", ...entry, name: "a" }, now: at("2026-09-24T00:00:00.000Z") });
    await repo.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_tv_2", entry: { scope: "title", ...entry, name: "b" }, now: at("2026-09-25T03:00:00.000Z") });
    repo.getMediaTitleName = async (key) => (key === "tmdb_tv_2" ? "冰之城墙" : null);
    const stats = await memoryStatsForUi(repo, "acct_1", new Date("2026-09-25T04:00:00.000Z"));
    expect(stats).toEqual({
      titleEntries: 3,
      titleWorks: 2,
      globalEntries: 0,
      recentAdded: 2,
      latest: { scope: "title", updatedAt: "2026-09-25T03:00:00.000Z", workTitle: "冰之城墙" },
    });
  });

  it("empty account → zeros and no latest; a failing name lookup does not break the numbers", async () => {
    const repo = new InMemoryWorkflowRepository();
    expect(await memoryStatsForUi(repo, "acct_1", new Date())).toEqual({
      titleEntries: 0, titleWorks: 0, globalEntries: 0, recentAdded: 0, latest: null,
    });
    await repo.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_tv_2", entry: { scope: "title", ...entry }, now: at("2026-09-25T03:00:00.000Z") });
    repo.getMediaTitleName = async () => { throw new Error("db down"); };
    const stats = await memoryStatsForUi(repo, "acct_1", new Date("2026-09-25T04:00:00.000Z"));
    expect(stats.latest).toEqual({ scope: "title", updatedAt: "2026-09-25T03:00:00.000Z", workTitle: null });
  });
});
