import { describe, expect, it } from "vitest";
import {
  InMemoryWorkflowRepository,
  type EpisodeState,
  type MediaTitle,
  type PersistWorkflowRunSnapshotInput,
  type TrackedSeason,
  type WorkflowStatus,
} from "@media-track/workflow";
import { getActivityView } from "./activity-view";

function title(tmdbId: number, name: string): MediaTitle {
  return { id: `t${tmdbId}`, tmdbId, type: "tv", title: name, originalTitle: name, year: 2026, aliases: [], posterPath: `/p${tmdbId}.jpg` };
}
function season(titleId: string, seasonNumber: number): TrackedSeason {
  return {
    id: `${titleId}_s${seasonNumber}`,
    mediaTitleId: titleId,
    seasonNumber,
    status: "active",
    qualityPreference: "4K",
    storageDirectoryId: "d",
    totalEpisodes: 12,
    latestAiredEpisode: 6,
    latestAiredSource: "metadata",
  };
}
function episode(seasonNumber: number, episodeNumber: number, trackedSeasonId = "s"): EpisodeState {
  return {
    trackedSeasonId,
    episodeCode: `S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}`,
    airDate: null,
    title: `Episode ${episodeNumber}`,
    airStatus: "aired",
    obtained: false,
    metadataStatus: "confirmed",
    verifiedFileIds: [],
  };
}
function run(input: {
  id: string;
  tmdbId: number;
  name: string;
  status: WorkflowStatus;
  startedAt: string;
  finishedAt?: string;
  episodes?: EpisodeState[];
}): PersistWorkflowRunSnapshotInput {
  const t = title(input.tmdbId, input.name);
  const s = season(t.id, 1);
  return {
    title: t,
    season: s,
    workflowRun: {
      id: input.id,
      kind: "type2_init",
      status: input.status,
      trackedSeasonId: s.id,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt ?? null,
      auditEvents: [],
    },
    episodes: input.episodes ?? [],
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications:
      input.finishedAt !== undefined
        ? [
            {
              id: `n_${input.id}`,
              workflowRunId: input.id,
              kind: "tracking_initialized",
              title: input.name,
              body: "done",
              createdAt: input.finishedAt,
              report: {
                titleName: input.name,
                seasonLabel: "第 1 季",
                status: "complete",
                lines: [],
                newlyObtained: [],
                realMissing: [],
                posterPath: `/p${input.tmdbId}.jpg`,
                fileCount: 12,
                totalBytes: 12 * 410 * 1024 * 1024,
              },
            },
          ]
        : [],
  };
}

describe("getActivityView", () => {
  it("active run over multiple seasons exposes the distinct sorted seasonNumbers", async () => {
    const repo = new InMemoryWorkflowRepository();
    const snap = run({
      id: "r_multi",
      tmdbId: 9,
      name: "Ozark",
      status: "running",
      startedAt: "2026-06-17T00:00:00Z",
      episodes: [episode(1, 1, "t9_s1"), episode(2, 1, "t9_s1"), episode(3, 1, "t9_s1"), episode(4, 1, "t9_s1")],
    });
    await repo.saveWorkflowRunSnapshot(snap);

    const view = await getActivityView({ repository: repo });
    const r = view.active.find((x) => x.runId === "r_multi")!;
    expect(r.seasonNumbers).toEqual([1, 2, 3, 4]);
  });

  it("returns active queued+running runs with queue positions; running carries progress", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.saveWorkflowRunSnapshot(run({ id: "r_run", tmdbId: 1, name: "Running", status: "running", startedAt: "2026-06-17T00:00:00Z" }));
    await repo.saveWorkflowRunSnapshot(run({ id: "r_q1", tmdbId: 2, name: "Queue1", status: "queued", startedAt: "2026-06-17T00:00:01Z" }));
    await repo.saveWorkflowRunSnapshot(run({ id: "r_q2", tmdbId: 3, name: "Queue2", status: "queued", startedAt: "2026-06-17T00:00:02Z" }));
    await repo.updateWorkflowRunProgress("r_run", { activity: "正在转存到网盘…", phase: "transfer", percent: 40, updatedAt: "t" });

    const view = await getActivityView({ repository: repo });

    const running = view.active.find((r) => r.runId === "r_run")!;
    expect(running.status).toBe("running");
    expect(running.progress?.activity).toBe("正在转存到网盘…");
    expect(running.queuePosition).toBeNull();
    const q1 = view.active.find((r) => r.runId === "r_q1")!;
    const q2 = view.active.find((r) => r.runId === "r_q2")!;
    expect(q1.queuePosition).toBe(1);
    expect(q2.queuePosition).toBe(2);
  });

  it("recentCompleted carries finished runs with runId + size, excluding no-op patrol checks (client scopes by observed runs)", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.saveWorkflowRunSnapshot(run({ id: "r_done", tmdbId: 2, name: "Done", status: "succeeded", startedAt: "2026-06-17T00:01:00Z", finishedAt: "2026-06-17T00:01:30Z" }));

    const view = await getActivityView({ repository: repo });

    const done = view.recentCompleted.find((c) => c.title === "Done")!;
    expect(done.workflowRunId).toBe("r_done");
    expect(done.sizeText).toBe("每集 约 410 MB");
  });

  it("backfills a missing recentCompleted poster from the tracked title (old notifications lack posterPath)", async () => {
    const repo = new InMemoryWorkflowRepository();
    const snap = run({ id: "r_old", tmdbId: 7, name: "OldNoPoster", status: "succeeded", startedAt: "2026-06-17T00:02:00Z", finishedAt: "2026-06-17T00:02:30Z" });
    // Simulate an OLD notification written before reports carried posterPath.
    snap.notifications[0]!.report!.posterPath = null;
    await repo.saveWorkflowRunSnapshot(snap);

    const view = await getActivityView({ repository: repo });

    const done = view.recentCompleted.find((c) => c.title === "OldNoPoster")!;
    expect(done.posterPath).toBe("/p7.jpg"); // backfilled from the still-tracked title
  });

  it("scopes active runs to the requested drive (connectedStorageId)", async () => {
    const repo = new InMemoryWorkflowRepository();
    const onA = run({ id: "r_a", tmdbId: 1, name: "Alpha", status: "running", startedAt: "2026-06-19T00:00:00Z" });
    onA.accountId = "acct_default";
    onA.connectedStorageId = "cs_a";
    const onB = run({ id: "r_b", tmdbId: 2, name: "Beta", status: "running", startedAt: "2026-06-19T00:00:00Z" });
    onB.accountId = "acct_default";
    onB.connectedStorageId = "cs_b";
    await repo.saveWorkflowRunSnapshot(onA);
    await repo.saveWorkflowRunSnapshot(onB);

    const viewA = await getActivityView({ repository: repo, accountId: "acct_default", connectedStorageId: "cs_a" });
    expect(viewA.active.map((r) => r.title)).toEqual(["Alpha"]);

    const viewB = await getActivityView({ repository: repo, accountId: "acct_default", connectedStorageId: "cs_b" });
    expect(viewB.active.map((r) => r.title)).toEqual(["Beta"]);
  });
});
