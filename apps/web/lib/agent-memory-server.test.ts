import { describe, expect, it } from "vitest";
import { InMemoryWorkflowRepository } from "@media-track/workflow";
import {
  AGENT_MEMORY_ENABLED_SETTING_KEY,
  isAgentMemoryEnabled,
  listMemoriesForUi,
  saveMemoryFromUi,
  deleteMemoryFromUi,
} from "./agent-memory-server";

const now = () => "2026-09-25T00:00:00.000Z";
const entry = { name: "no-2025-year", description: "2026 首播", kind: "search" as const, body: "搜「X 2025」0 命中" };

describe("agent memory settings + UI server logic", () => {
  it("memory is ON by default and only an explicit '0' turns it off", async () => {
    const repo = new InMemoryWorkflowRepository();
    expect(await isAgentMemoryEnabled(repo, "acct_1")).toBe(true);
    await repo.setAccountSetting("acct_1", AGENT_MEMORY_ENABLED_SETTING_KEY, "0");
    expect(await isAgentMemoryEnabled(repo, "acct_1")).toBe(false);
    await repo.setAccountSetting("acct_1", AGENT_MEMORY_ENABLED_SETTING_KEY, "1");
    expect(await isAgentMemoryEnabled(repo, "acct_1")).toBe(true);
  });

  it("lists a work's memory by (mediaType, tmdbId) and the global memory, scoped to the account", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_tv_7", entry: { scope: "title", ...entry }, now: now() });
    await repo.upsertAgentMemory({ accountId: "acct_2", titleKey: "tmdb_tv_7", entry: { scope: "title", ...entry }, now: now() });
    await repo.upsertAgentMemory({ accountId: "acct_1", titleKey: null, entry: { scope: "global", ...entry }, now: now() });
    expect(await listMemoriesForUi(repo, "acct_1", { scope: "title", mediaType: "tv", tmdbId: 7 })).toHaveLength(1);
    expect(await listMemoriesForUi(repo, "acct_1", { scope: "global" })).toHaveLength(1);
    expect(await listMemoriesForUi(repo, "acct_2", { scope: "global" })).toHaveLength(0);
  });

  it("save validates like the agent tool, and edits keep the same row", async () => {
    const repo = new InMemoryWorkflowRepository();
    expect(await saveMemoryFromUi(repo, "acct_1", { scope: "title", mediaType: "movie", tmdbId: 1 }, { ...entry, name: "Bad Name" }, now)).toMatchObject({ success: false });
    expect(await saveMemoryFromUi(repo, "acct_1", { scope: "title", mediaType: "movie", tmdbId: 1 }, entry, now)).toMatchObject({ success: true });
    await saveMemoryFromUi(repo, "acct_1", { scope: "title", mediaType: "movie", tmdbId: 1 }, { ...entry, body: "用户改过" }, now);
    const rows = await listMemoriesForUi(repo, "acct_1", { scope: "title", mediaType: "movie", tmdbId: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe("用户改过");
  });

  it("delete removes only the addressed entry", async () => {
    const repo = new InMemoryWorkflowRepository();
    await saveMemoryFromUi(repo, "acct_1", { scope: "global" }, entry, now);
    await saveMemoryFromUi(repo, "acct_1", { scope: "global" }, { ...entry, name: "keep-me" }, now);
    expect(await deleteMemoryFromUi(repo, "acct_1", { scope: "global" }, "no-2025-year")).toMatchObject({ success: true });
    expect((await listMemoriesForUi(repo, "acct_1", { scope: "global" })).map((m) => m.name)).toEqual(["keep-me"]);
  });

  it("a bad tmdbId in a title address is refused", async () => {
    const repo = new InMemoryWorkflowRepository();
    expect(await saveMemoryFromUi(repo, "acct_1", { scope: "title", mediaType: "tv", tmdbId: -1 }, entry, now)).toMatchObject({ success: false });
  });
});

describe("UI writes respect the same caps as the agent", () => {
  it("a new name at the per-work cap is refused; editing an existing one still works", async () => {
    const { AGENT_MEMORY_LIMITS } = await import("@media-track/workflow");
    const repo = new InMemoryWorkflowRepository();
    const addr = { scope: "title" as const, mediaType: "tv" as const, tmdbId: 9 };
    for (let i = 0; i < AGENT_MEMORY_LIMITS.titleEntriesMax; i += 1) {
      expect(await saveMemoryFromUi(repo, "acct_1", addr, { ...entry, name: `m-${i}` }, now)).toMatchObject({ success: true });
    }
    expect(await saveMemoryFromUi(repo, "acct_1", addr, { ...entry, name: "one-more" }, now)).toMatchObject({ success: false });
    expect(await saveMemoryFromUi(repo, "acct_1", addr, { ...entry, name: "m-0", body: "改" }, now)).toMatchObject({ success: true });
  });
});

describe("UI edits and runtime address checks (Copilot #272 r5)", () => {
  const now = () => "2026-09-25T00:00:00.000Z";
  const entry = { name: "drive-tip", description: "一行摘要", kind: "drive" as const, body: "证据：run x" };

  it("editing an agent-written entry keeps its provider", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.upsertAgentMemory({ accountId: "acct_1", titleKey: null, entry: { scope: "global", ...entry, provider: "guangya" }, now: now() });
    expect(await saveMemoryFromUi(repo, "acct_1", { scope: "global" }, { ...entry, body: "用户改过" }, now)).toMatchObject({ success: true });
    const [row] = await listMemoriesForUi(repo, "acct_1", { scope: "global" });
    expect(row!.body).toBe("用户改过");
    expect(row!.provider).toBe("guangya");
  });

  it("rejects a forged mediaType instead of building a free-form title key", async () => {
    const repo = new InMemoryWorkflowRepository();
    const forged = { scope: "title", mediaType: "x_1_global", tmdbId: 1 } as unknown as Parameters<typeof saveMemoryFromUi>[2];
    expect(await saveMemoryFromUi(repo, "acct_1", forged, entry, now)).toMatchObject({ success: false });
    expect(await listMemoriesForUi(repo, "acct_1", forged)).toEqual([]);
    expect(await deleteMemoryFromUi(repo, "acct_1", forged, "drive-tip")).toMatchObject({ success: false });
  });
});

describe("drive label for the UI", () => {
  it("maps a drive-tagged note to its brand label; untagged → null", async () => {
    const { toMemoryItem } = await import("./agent-memory-server");
    const base = { id: "m", accountId: "a", scope: "global", titleKey: null, name: "n", description: "d", kind: "drive", body: "b", createdAt: "t", updatedAt: "2026-09-25T00:00:00.000Z", lastUsedAt: null, sourceRunId: null } as const;
    expect(toMemoryItem({ ...base, provider: "guangya" }).driveLabel).toBe("光鸭云盘");
    expect(toMemoryItem({ ...base, provider: null }).driveLabel).toBeNull();
  });
});

describe("drive labels resolve concrete drives", () => {
  it("storage id → its label, else brand + uid tail; bare brand → brand label", async () => {
    const { makeDriveLabeler } = await import("./agent-memory-server");
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
