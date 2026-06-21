import { describe, expect, it } from "vitest";
import { createEpisodeStates, InMemoryWorkflowRepository } from "../src/index.js";
import type { MediaTitle, PersistWorkflowRunSnapshotInput, TrackedSeason, WorkflowStatus } from "../src/index.js";

const ACCOUNT = "acct_default";
const STORAGE_A = "cs_a";
const STORAGE_B = "cs_b";

function tvSnapshot(opts: {
  tmdbId: number;
  seasonNumber: number;
  storageId: string;
  status?: WorkflowStatus;
}): PersistWorkflowRunSnapshotInput {
  const { tmdbId, seasonNumber, storageId, status = "succeeded" } = opts;
  const titleId = `tmdb_tv_${tmdbId}`;
  const seasonId = `${titleId}_s${seasonNumber}`;
  const title: MediaTitle = {
    id: titleId,
    tmdbId,
    type: "tv",
    title: `Show ${tmdbId}`,
    originalTitle: `Show ${tmdbId}`,
    year: 2026,
    aliases: [],
  };
  const season: TrackedSeason = {
    id: seasonId,
    mediaTitleId: titleId,
    seasonNumber,
    status: status === "succeeded" ? "completed" : "active",
    qualityPreference: "4K",
    storageDirectoryId: "dir",
    totalEpisodes: 1,
    latestAiredEpisode: 1,
    latestAiredSource: "metadata",
  };
  const terminal = status !== "queued" && status !== "running";
  return {
    accountId: ACCOUNT,
    connectedStorageId: storageId,
    title,
    season,
    workflowRun: {
      id: `run_${seasonId}_${storageId}_${status}`,
      kind: "type2_init",
      status,
      trackedSeasonId: seasonId,
      startedAt: "2026-06-21T00:00:00.000Z",
      finishedAt: terminal ? "2026-06-21T00:01:00.000Z" : null,
      auditEvents: [],
    },
    episodes: createEpisodeStates({
      trackedSeasonId: seasonId,
      seasonNumber,
      totalEpisodes: 1,
      latestAiredEpisode: 1,
    }).map((episode) => ({ ...episode, obtained: status === "succeeded" })),
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
  };
}

async function seed(snaps: PersistWorkflowRunSnapshotInput[]): Promise<InMemoryWorkflowRepository> {
  const repo = new InMemoryWorkflowRepository();
  for (const snap of snaps) await repo.saveWorkflowRunSnapshot(snap);
  return repo;
}

const scope = (storageId: string) => ({ accountId: ACCOUNT, connectedStorageId: storageId });

describe("untrackTitle (InMemory)", () => {
  it("整剧取消:删本盘该剧所有季,媒体库不再含它", async () => {
    const repo = await seed([
      tvSnapshot({ tmdbId: 100, seasonNumber: 1, storageId: STORAGE_A }),
      tvSnapshot({ tmdbId: 100, seasonNumber: 2, storageId: STORAGE_A }),
    ]);

    const result = await repo.untrackTitle(100, scope(STORAGE_A));

    expect(result).toEqual({ status: "untracked", removedSeasons: 2 });
    expect(await repo.listTrackedSeasonStates(scope(STORAGE_A))).toHaveLength(0);
  });

  it("单季取消:只删该季,其余季保留", async () => {
    const repo = await seed([
      tvSnapshot({ tmdbId: 100, seasonNumber: 1, storageId: STORAGE_A }),
      tvSnapshot({ tmdbId: 100, seasonNumber: 2, storageId: STORAGE_A }),
    ]);

    const result = await repo.untrackTitle(100, scope(STORAGE_A), 1);

    expect(result).toEqual({ status: "untracked", removedSeasons: 1 });
    const states = await repo.listTrackedSeasonStates(scope(STORAGE_A));
    expect(states.map((s) => s.season.seasonNumber)).toEqual([2]);
  });

  it("分盘隔离:取消 A 盘不影响 B 盘同剧", async () => {
    const repo = await seed([
      tvSnapshot({ tmdbId: 100, seasonNumber: 1, storageId: STORAGE_A }),
      tvSnapshot({ tmdbId: 100, seasonNumber: 1, storageId: STORAGE_B }),
    ]);

    await repo.untrackTitle(100, scope(STORAGE_A));

    expect(await repo.listTrackedSeasonStates(scope(STORAGE_A))).toHaveLength(0);
    expect(await repo.listTrackedSeasonStates(scope(STORAGE_B))).toHaveLength(1);
  });

  it("在途 running 拒绝:返回 in_flight,零删除", async () => {
    const repo = await seed([
      tvSnapshot({ tmdbId: 100, seasonNumber: 1, storageId: STORAGE_A, status: "running" }),
    ]);

    const result = await repo.untrackTitle(100, scope(STORAGE_A));

    expect(result).toEqual({ status: "in_flight", removedSeasons: 0 });
    expect(await repo.listTrackedSeasonStates(scope(STORAGE_A))).toHaveLength(1);
  });

  it("未追踪:返回 not_found", async () => {
    const repo = await seed([]);
    const result = await repo.untrackTitle(999, scope(STORAGE_A));
    expect(result).toEqual({ status: "not_found", removedSeasons: 0 });
  });
});
