import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACCOUNT_ID,
  InMemoryWorkflowRepository,
  episodeCode,
  type EpisodeState,
  type MediaTitle,
  type PersistWorkflowRunSnapshotInput,
  type TrackedSeason,
  type WorkflowRun,
} from "../src/index.js";

/** Minimal valid snapshot for an account, keyed so two accounts never collide. */
function snapshotFor(accountId: string, suffix: string): PersistWorkflowRunSnapshotInput {
  const title: MediaTitle = {
    id: `title_${suffix}`,
    tmdbId: 100,
    type: "tv",
    title: `Show ${suffix}`,
    originalTitle: `Show ${suffix}`,
    year: 2026,
    aliases: [],
  };
  const season: TrackedSeason = {
    id: `season_${suffix}`,
    mediaTitleId: title.id,
    seasonNumber: 1,
    status: "active",
    qualityPreference: "4K",
    storageDirectoryId: "dir_1",
    totalEpisodes: 1,
    latestAiredEpisode: 1,
    latestAiredSource: "metadata",
  };
  const workflowRun: WorkflowRun = {
    id: `run_${suffix}`,
    kind: "type2_init",
    status: "queued",
    trackedSeasonId: season.id,
    startedAt: "2026-06-17T00:00:00.000Z",
    finishedAt: null,
    auditEvents: [],
  };
  const episodes: EpisodeState[] = [
    {
      trackedSeasonId: season.id,
      episodeCode: episodeCode(1, 1),
      airDate: null,
      title: "Episode 1",
      airStatus: "aired",
      obtained: true,
      metadataStatus: "confirmed",
      verifiedFileIds: ["file_1"],
    },
  ];
  return {
    accountId,
    title,
    season,
    workflowRun,
    episodes,
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [
      {
        id: `notif_${suffix}`,
        workflowRunId: workflowRun.id,
        kind: "tracking_initialized",
        title: "init",
        body: "done",
        createdAt: "2026-06-17T00:00:00.000Z",
      },
    ],
  };
}

describe("account scoping (InMemory)", () => {
  it("listTrackedSeasonStates returns only the account's seasons, with accountId surfaced", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.saveWorkflowRunSnapshot(snapshotFor("acct_a1", "a1"));
    await repo.saveWorkflowRunSnapshot(snapshotFor("acct_a2", "a2"));

    const a1 = await repo.listTrackedSeasonStates("acct_a1");
    const a2 = await repo.listTrackedSeasonStates("acct_a2");

    expect(a1.map((s) => s.season.id)).toEqual(["season_a1"]);
    expect(a1.every((s) => s.accountId === "acct_a1")).toBe(true);
    expect(a2.map((s) => s.season.id)).toEqual(["season_a2"]);
    expect(a2.some((s) => s.season.id === "season_a1")).toBe(false);
  });

  it("getWorkflowRunSnapshot is account-scoped (other account → null)", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.saveWorkflowRunSnapshot(snapshotFor("acct_a1", "a1"));
    expect((await repo.getWorkflowRunSnapshot("run_a1", "acct_a1"))?.accountId).toBe("acct_a1");
    expect(await repo.getWorkflowRunSnapshot("run_a1", "acct_a2")).toBeNull();
  });

  it("listNotifications is account-scoped", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.saveWorkflowRunSnapshot(snapshotFor("acct_a1", "a1"));
    await repo.saveWorkflowRunSnapshot(snapshotFor("acct_a2", "a2"));
    const a1 = await repo.listNotifications({ accountId: "acct_a1" });
    expect(a1.map((n) => n.id)).toEqual(["notif_a1"]);
  });

  it("listRecentNotificationsWithAccount tags each notification with its owning account (cross-account, for per-account push)", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.saveWorkflowRunSnapshot(snapshotFor("acct_a1", "a1"));
    await repo.saveWorkflowRunSnapshot(snapshotFor("acct_a2", "a2"));
    const tagged = await repo.listRecentNotificationsWithAccount();
    const byNotif = new Map(tagged.map((entry) => [entry.notification.id, entry.accountId]));
    expect(byNotif.get("notif_a1")).toBe("acct_a1");
    expect(byNotif.get("notif_a2")).toBe("acct_a2");
  });

  it("listRecentNotificationsWithAccount applies since before limit so pre-cutoff noise cannot crowd out the window", async () => {
    const repo = new InMemoryWorkflowRepository();
    const base = snapshotFor("acct_push", "base");
    // 90 after the cutoff + 90 before. Newest-first without a since filter returns
    // 100 rows that still mix in 10 pre-cutoff events. The fixed API must drop those
    // first, then apply the limit, leaving only the 90 post-cutoff events.
    const after = Array.from({ length: 90 }, (_, index) => ({
      id: `after_${String(index).padStart(3, "0")}`,
      workflowRunId: base.workflowRun.id,
      kind: "already_current" as const,
      title: `after ${index}`,
      body: "ok",
      createdAt: new Date(Date.parse("2026-07-21T12:00:00.000Z") + (index + 1) * 1000).toISOString(),
    }));
    const before = Array.from({ length: 90 }, (_, index) => ({
      id: `before_${String(index).padStart(3, "0")}`,
      workflowRunId: base.workflowRun.id,
      kind: "already_current" as const,
      title: `before ${index}`,
      body: "ok",
      createdAt: new Date(Date.parse("2026-07-21T11:00:00.000Z") + index * 1000).toISOString(),
    }));
    await repo.saveWorkflowRunSnapshot({ ...base, notifications: [...after, ...before] });

    const since = "2026-07-21T12:00:00.000Z";
    const tagged = await repo.listRecentNotificationsWithAccount({ since, limit: 100 });
    expect(tagged).toHaveLength(90);
    expect(tagged.every((entry) => entry.notification.createdAt >= since)).toBe(true);
    expect(tagged.some((entry) => entry.notification.id.startsWith("before_"))).toBe(false);
  });

  it("omitting accountId falls back to the default account (single-user, fail-closed)", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.saveWorkflowRunSnapshot(snapshotFor(DEFAULT_ACCOUNT_ID, "d"));
    // No accountId arg → defaults to acct_default, sees the default account's data.
    const states = await repo.listTrackedSeasonStates();
    expect(states.map((s) => s.season.id)).toEqual(["season_d"]);
  });

  it("account settings are isolated per account", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.setAccountSetting("acct_a1", "preferred_language", "中文");
    await repo.setAccountSetting("acct_a2", "preferred_language", "English");
    expect(await repo.getAccountSetting("acct_a1", "preferred_language")).toBe("中文");
    expect(await repo.getAccountSetting("acct_a2", "preferred_language")).toBe("English");
    expect(await repo.getAccountSetting("acct_a1", "missing")).toBeNull();
  });

  it("upsertConnectedStorage never lets a second account steal an existing 网盘 (UNIQUE provider,uid)", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.upsertConnectedStorage({
      id: "cs_a",
      accountId: "a1",
      provider: "pan115",
      providerUid: "U",
      payload: { cookie: "c1" },
      createdAt: "t",
    });
    // a2 tries to bind the SAME physical 网盘 (same provider+uid) → must NOT steal
    // ownership or overwrite a1's cookie (spec: 他账号已绑 = 拒绝).
    await repo.upsertConnectedStorage({
      id: "cs_b",
      accountId: "a2",
      provider: "pan115",
      providerUid: "U",
      payload: { cookie: "c2" },
      createdAt: "t2",
    });
    const found = await repo.findConnectedStorageByUid("pan115", "U");
    expect(found?.accountId).toBe("a1");
    expect((found?.payload as { cookie: string }).cookie).toBe("c1");
    // a1 re-scanning its OWN 网盘 still refreshes the cookie.
    await repo.upsertConnectedStorage({
      id: "cs_a",
      accountId: "a1",
      provider: "pan115",
      providerUid: "U",
      payload: { cookie: "c3" },
      createdAt: "t",
    });
    expect(((await repo.findConnectedStorageByUid("pan115", "U"))?.payload as { cookie: string }).cookie).toBe("c3");
  });

  it("connected storage uniqueness: lookup by (provider, uid) returns the owner", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.upsertConnectedStorage({
      id: "cs1",
      accountId: "a1",
      provider: "pan115",
      providerUid: "U",
      payload: { cookie: "c" },
      createdAt: "t",
    });
    const found = await repo.findConnectedStorageByUid("pan115", "U");
    expect(found?.accountId).toBe("a1");
    expect(found?.id).toBe("cs1");
    expect(await repo.findConnectedStorageByUid("pan115", "other")).toBeNull();
    expect((await repo.listConnectedStorages("a1")).map((c) => c.id)).toEqual(["cs1"]);
    expect(await repo.listConnectedStorages("a2")).toEqual([]);
  });
});
