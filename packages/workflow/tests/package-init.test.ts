import { describe, expect, it } from "vitest";
import {
  FakeAgentNodes,
  FakeStorageExecutor,
  InMemoryWorkflowRepository,
  runSeriesPackageInitialization,
  runSeriesPackageInitializationAndPersist,
  type FakePackageTreeFile,
  type MediaTitle,
} from "../src/index.js";

const fixedNow = () => "2026-06-13T00:00:00.000Z";

const breakingBad: MediaTitle = {
  id: "tmdb_tv_1396",
  tmdbId: 1396,
  type: "tv",
  title: "绝命毒师",
  originalTitle: "Breaking Bad",
  year: 2008,
  aliases: ["Breaking Bad"],
};

function packTree(): FakePackageTreeFile[] {
  const files: FakePackageTreeFile[] = [];
  for (let season = 1; season <= 2; season += 1) {
    const count = season === 1 ? 7 : 13;
    for (let episode = 1; episode <= count; episode += 1) {
      const code = `S0${season}E${String(episode).padStart(2, "0")}`;
      files.push({
        path: `pack/绝命毒师 S0${season}(200${7 + season}) 4K/Breaking.Bad.${code}.2160p.mkv`,
        providerFileId: `bb_${code}`,
        sizeBytes: 3_500_000_000,
        episodeCode: code,
      });
    }
  }
  files.push({
    path: "pack/(2013.11)纪录片/No.Half.Measures.1080p.mkv",
    providerFileId: "bb_doc",
    sizeBytes: 5_350_000_000,
  });
  files.push({
    path: "pack/(2019.10)续命之徒：绝命毒师电影/El.Camino.2019.1080p.mkv",
    providerFileId: "bb_movie",
    sizeBytes: 5_570_000_000,
  });
  files.push({ path: "pack/绝命毒师 S01(2008) 4K/Breaking.Bad.S00_海报.jpg", providerFileId: "bb_jpg", sizeBytes: 1_000 });
  return files;
}

describe("runSeriesPackageInitialization", () => {
  it("normalizes a complete-series pack into canonical season directories", async () => {
    const storage = new FakeStorageExecutor({ packageTrees: { staging_1: packTree() } });
    const result = await runSeriesPackageInitialization({
      title: breakingBad,
      seasons: [
        { seasonNumber: 1, totalEpisodes: 7, latestAiredEpisode: 7 },
        { seasonNumber: 2, totalEpisodes: 13, latestAiredEpisode: 13 },
      ],
      stagingDirectoryId: "staging_1",
      storageParentDirectoryId: "library_root",
      storage,
      agents: new FakeAgentNodes(),
      workflowRunId: "run_pack",
    });

    expect(result.status).toBe("succeeded");
    expect(result.seasons).toHaveLength(2);
    const s1 = result.seasons[0]!;
    expect(s1.season.seasonNumber).toBe(1);
    expect(s1.season.storageDirectoryId).toContain("Season 1");
    expect(s1.obtainedEpisodes).toHaveLength(7);
    const s2 = result.seasons[1]!;
    expect(s2.obtainedEpisodes).toHaveLength(13);

    // rejected content stays in staging, never moved or deleted
    expect(result.rejectedFiles.map((file) => file.providerFileId).sort()).toEqual(["bb_doc", "bb_movie"]);
    const remaining = await storage.listTree({ directoryId: "staging_1" });
    expect(remaining.map((file) => file.providerFileId).sort()).toEqual(["bb_doc", "bb_jpg", "bb_movie"]);

    const auditTypes = result.auditEvents.map((event) => event.type);
    expect(auditTypes).toContain("package_plan_created");
    expect(auditTypes).toContain("landing_directory_created");
    expect(result.notification.body).toContain("20");
  });

  it("returns partial and reports gaps when a season is not fully covered", async () => {
    const tree = packTree().filter((file) => file.providerFileId !== "bb_S02E13" && file.providerFileId !== "bb_S02E12");
    const storage = new FakeStorageExecutor({ packageTrees: { staging_1: tree } });
    const result = await runSeriesPackageInitialization({
      title: breakingBad,
      seasons: [
        { seasonNumber: 1, totalEpisodes: 7, latestAiredEpisode: 7 },
        { seasonNumber: 2, totalEpisodes: 13, latestAiredEpisode: 13 },
      ],
      stagingDirectoryId: "staging_1",
      storageParentDirectoryId: "library_root",
      storage,
      agents: new FakeAgentNodes(),
    });

    expect(result.status).toBe("partial");
  });

  it("persists one tracked season snapshot per season", async () => {
    const repository = new InMemoryWorkflowRepository();
    const storage = new FakeStorageExecutor({ packageTrees: { staging_1: packTree() } });
    const result = await runSeriesPackageInitializationAndPersist({
      title: breakingBad,
      seasons: [
        { seasonNumber: 1, totalEpisodes: 7, latestAiredEpisode: 7 },
        { seasonNumber: 2, totalEpisodes: 13, latestAiredEpisode: 13 },
      ],
      stagingDirectoryId: "staging_1",
      storageParentDirectoryId: "library_root",
      storage,
      agents: new FakeAgentNodes(),
      repository,
      workflowRun: { id: "run_pack", startedAt: fixedNow(), finishedAt: fixedNow() },
    });

    expect(result.status).toBe("succeeded");
    const states = await repository.listTrackedSeasonStates();
    expect(states).toHaveLength(2);
    const saved = await repository.getWorkflowRunSnapshot("run_pack_s1");
    expect(saved?.workflowRun.kind).toBe("type1_package_init");
    expect(saved?.obtainedEpisodes).toHaveLength(7);
  });
});
