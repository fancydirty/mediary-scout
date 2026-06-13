import { describe, expect, it } from "vitest";
import {
  createEpisodeStates,
  FakeAgentNodes,
  FakeResourceProvider,
  FakeStorageExecutor,
  reconcileVerifiedFiles,
  runType3Monitoring,
  type AcquisitionPlanningInput,
  type AcquisitionPlanningResult,
  type MediaTitle,
  type TrackedSeason,
  type VerifiedFile,
} from "../src/index.js";

function qiaochuFixture() {
  const title: MediaTitle = {
    id: "title_qiaochu",
    tmdbId: 289271,
    type: "tv",
    title: "翘楚",
    originalTitle: "翘楚",
    year: 2026,
    aliases: ["Ashes to Crown"],
  };
  const season: TrackedSeason = {
    id: "season_qiaochu_1",
    mediaTitleId: title.id,
    seasonNumber: 1,
    status: "active",
    qualityPreference: "4K",
    storageDirectoryId: "dir_qiaochu_s1",
    totalEpisodes: 24,
    latestAiredEpisode: 14,
    latestAiredSource: "metadata",
  };
  return { title, season };
}

function obtainedFiles(count: number, storageDirectoryId: string): VerifiedFile[] {
  return Array.from({ length: count }, (_, index) => {
    const episode = `S01E${String(index + 1).padStart(2, "0")}`;
    return {
      id: `file_${episode}`,
      storageDirectoryId,
      name: `翘楚.${episode}.mkv`,
      sizeBytes: 1_000_000_000,
      episodeCode: episode,
      providerFileId: `provider_${episode}`,
    };
  });
}

describe("runType3Monitoring", () => {
  it("repairs deletion via a failure-evidence re-planning pass, never mechanical fallback", async () => {
    const { title, season } = qiaochuFixture();
    const existingFiles = obtainedFiles(12, season.storageDirectoryId);
    const initialEpisodes = reconcileVerifiedFiles({
      season,
      episodes: createEpisodeStates({
        trackedSeasonId: season.id,
        seasonNumber: season.seasonNumber,
        totalEpisodes: season.totalEpisodes,
        latestAiredEpisode: season.latestAiredEpisode,
      }),
      files: [
        ...existingFiles,
        {
          id: "missing_old_13",
          storageDirectoryId: season.storageDirectoryId,
          name: "old.S01E13.mkv",
          sizeBytes: 1,
          episodeCode: "S01E13",
          providerFileId: "old_13",
        },
        {
          id: "missing_old_14",
          storageDirectoryId: season.storageDirectoryId,
          name: "old.S01E14.mkv",
          sizeBytes: 1,
          episodeCode: "S01E14",
          providerFileId: "old_14",
        },
      ],
    });
    const storage = new FakeStorageExecutor({
      directories: { [season.storageDirectoryId]: existingFiles },
      transferOutcomes: {
        snapshot_1_candidate_1: {
          status: "no_target_change",
          providerMessage: "already transferred elsewhere",
          files: [],
        },
        snapshot_1_candidate_3: {
          status: "succeeded",
          providerMessage: "",
          files: [
            {
              id: "restored_14",
              storageDirectoryId: season.storageDirectoryId,
              name: "翘楚.S01E14.restored.mkv",
              sizeBytes: 5_000_000_000,
              episodeCode: "S01E14",
              providerFileId: "restored_provider_14",
            },
          ],
        },
        snapshot_2_candidate_2: {
          status: "succeeded",
          providerMessage: "",
          files: [
            {
              id: "restored_13",
              storageDirectoryId: season.storageDirectoryId,
              name: "翘楚.S01E13.restored.mkv",
              sizeBytes: 5_000_000_000,
              episodeCode: "S01E13",
              providerFileId: "restored_provider_13",
            },
          ],
        },
      },
    });
    const resourceProvider = new FakeResourceProvider({
      keywordResults: {
        "翘楚 4K": [
          { title: "翘楚 S01E13 primary", episodeHints: ["S01E13"] },
          { title: "翘楚 S01E13 fallback", episodeHints: ["S01E13"] },
          { title: "翘楚 S01E14 fallback", episodeHints: ["S01E14"] },
        ],
      },
    });

    const result = await runType3Monitoring({
      title,
      season,
      episodes: initialEpisodes,
      keyword: "翘楚 4K",
      storageParentDirectoryId: "library_root",
      resourceProvider,
      storage,
      agents: new FakeAgentNodes(),
    });

    expect(result.status).toBe("succeeded");
    expect(result.transferAttempts.map((attempt) => attempt.status)).toEqual([
      "no_target_change",
      "succeeded",
      "succeeded",
    ]);
    expect(result.transferAttempts.map((attempt) => attempt.candidateId)).toEqual([
      "snapshot_1_candidate_1",
      "snapshot_1_candidate_3",
      "snapshot_2_candidate_2",
    ]);
    expect(result.decisions).toHaveLength(2);
    expect(result.resourceSnapshots.map((snapshot) => snapshot.id)).toEqual(["snapshot_1", "snapshot_2"]);
    expect(result.obtainedEpisodes).toContain("S01E13");
    expect(result.obtainedEpisodes).toContain("S01E14");
    expect(result.notification.trigger).toBe("scheduled");
    expect(result.notification.report?.newlyObtained).toEqual(expect.arrayContaining(["E13", "E14"]));
    expect(result.notification.body).toContain("本次新增：E13、E14");
    expect(result.notification.body).toContain("📺 翘楚 第 1 季");
    expect(result.notifications).toEqual([result.notification]);
    expect(result.auditEvents.map((event) => event.type)).toContain("acquisition_pass_incomplete");
  });

  it("never mechanically transfers candidates the agent did not select", async () => {
    const { title, season } = qiaochuFixture();
    const existingFiles = obtainedFiles(12, season.storageDirectoryId);
    const initialEpisodes = reconcileVerifiedFiles({
      season: { ...season, latestAiredEpisode: 13 },
      episodes: createEpisodeStates({
        trackedSeasonId: season.id,
        seasonNumber: season.seasonNumber,
        totalEpisodes: season.totalEpisodes,
        latestAiredEpisode: 13,
      }),
      files: existingFiles,
    });
    const storage = new FakeStorageExecutor({
      directories: { [season.storageDirectoryId]: existingFiles },
      transferOutcomes: {
        snapshot_1_candidate_1: {
          status: "no_target_change",
          providerMessage: "already transferred elsewhere",
          files: [],
        },
        snapshot_1_candidate_2: {
          status: "succeeded",
          providerMessage: "must never be transferred without agent selection",
          files: [
            {
              id: "restored_13",
              storageDirectoryId: season.storageDirectoryId,
              name: "翘楚.S01E13.restored.mkv",
              sizeBytes: 5_000_000_000,
              episodeCode: "S01E13",
              providerFileId: "restored_provider_13",
            },
          ],
        },
      },
    });
    const resourceProvider = new FakeResourceProvider({
      keywordResults: {
        "翘楚 4K": [
          { title: "翘楚 S01E13 primary", episodeHints: ["S01E13"] },
          { title: "翘楚 S01E13 rejected fallback", episodeHints: ["S01E13"] },
        ],
      },
    });

    const result = await runType3Monitoring({
      title,
      season: { ...season, latestAiredEpisode: 13 },
      episodes: initialEpisodes,
      keyword: "翘楚 4K",
      storageParentDirectoryId: "library_root",
      resourceProvider,
      storage,
      agents: new PrimaryThenNoCoverageAgentNodes(),
    });

    expect(result.transferAttempts.map((attempt) => attempt.candidateId)).toEqual(["snapshot_1_candidate_1"]);
    expect(result.transferAttempts.map((attempt) => attempt.status)).toEqual(["no_target_change"]);
    expect(result.obtainedEpisodes).not.toContain("S01E13");
    expect(result.status).toBe("no_coverage");
  });

  it("rejects plans whose selected snapshot was not observed in this run", async () => {
    const { title, season } = qiaochuFixture();
    const initialEpisodes = createEpisodeStates({
      trackedSeasonId: season.id,
      seasonNumber: season.seasonNumber,
      totalEpisodes: season.totalEpisodes,
      latestAiredEpisode: 1,
    });
    const storage = new FakeStorageExecutor({
      directories: { [season.storageDirectoryId]: [] },
      transferOutcomes: {
        snapshot_99_candidate_1: {
          status: "succeeded",
          providerMessage: "stale candidate should never transfer",
          files: [
            {
              id: "stale_file_01",
              storageDirectoryId: season.storageDirectoryId,
              name: "翘楚.S01E01.stale.mkv",
              sizeBytes: 1,
              episodeCode: "S01E01",
              providerFileId: "stale_provider_01",
            },
          ],
        },
      },
    });
    const resourceProvider = new FakeResourceProvider({
      keywordResults: {
        "翘楚 4K": [{ title: "翘楚 S01E01 current", episodeHints: ["S01E01"] }],
      },
    });

    await expect(
      runType3Monitoring({
        title,
        season: { ...season, latestAiredEpisode: 1 },
        episodes: initialEpisodes,
        keyword: "翘楚 4K",
        storageParentDirectoryId: "library_root",
        resourceProvider,
        storage,
        agents: new StaleSnapshotAgentNodes(),
      }),
    ).rejects.toThrow(/not observed in this run/);

    await expect(storage.listVideoFiles(season.storageDirectoryId)).resolves.toEqual([]);
  });

  it("rejects plans that silently omit candidates from the selected snapshot", async () => {
    const { title, season } = qiaochuFixture();
    const initialEpisodes = createEpisodeStates({
      trackedSeasonId: season.id,
      seasonNumber: season.seasonNumber,
      totalEpisodes: season.totalEpisodes,
      latestAiredEpisode: 1,
    });
    const storage = new FakeStorageExecutor({
      directories: { [season.storageDirectoryId]: [] },
      transferOutcomes: {
        snapshot_1_candidate_1: {
          status: "succeeded",
          providerMessage: "current candidate should not transfer after invalid plan",
          files: [
            {
              id: "file_01",
              storageDirectoryId: season.storageDirectoryId,
              name: "翘楚.S01E01.mkv",
              sizeBytes: 1,
              episodeCode: "S01E01",
              providerFileId: "provider_01",
            },
          ],
        },
      },
    });
    const resourceProvider = new FakeResourceProvider({
      keywordResults: {
        "翘楚 4K": [
          { title: "翘楚 S01E01 current", episodeHints: ["S01E01"] },
          { title: "翘楚 S01E01 ignored", episodeHints: ["S01E01"] },
        ],
      },
    });

    await expect(
      runType3Monitoring({
        title,
        season: { ...season, latestAiredEpisode: 1 },
        episodes: initialEpisodes,
        keyword: "翘楚 4K",
        storageParentDirectoryId: "library_root",
        resourceProvider,
        storage,
        agents: new OmittingDispositionAgentNodes(),
      }),
    ).rejects.toThrow(/every candidate/);

    await expect(storage.listVideoFiles(season.storageDirectoryId)).resolves.toEqual([]);
  });

  it("records provider-ahead files without waiting for metadata to catch up", async () => {
    const { title, season } = qiaochuFixture();
    const aheadSeason = { ...season, latestAiredEpisode: 20 };
    const storage = new FakeStorageExecutor({
      directories: { [aheadSeason.storageDirectoryId]: [] },
      transferOutcomes: {
        snapshot_1_candidate_1: {
          status: "succeeded",
          providerMessage: "",
          files: [
            {
              id: "file_20",
              storageDirectoryId: aheadSeason.storageDirectoryId,
              name: "翘楚.S01E20.mkv",
              sizeBytes: 1_000_000_000,
              episodeCode: "S01E20",
              providerFileId: "provider_20",
            },
            {
              id: "file_21",
              storageDirectoryId: aheadSeason.storageDirectoryId,
              name: "翘楚.S01E21.mkv",
              sizeBytes: 1_000_000_000,
              episodeCode: "S01E21",
              providerFileId: "provider_21",
            },
          ],
        },
      },
    });
    const resourceProvider = new FakeResourceProvider({
      keywordResults: {
        "翘楚 4K": [{ title: "翘楚 S01E20-S01E21 4K", episodeHints: ["S01E20", "S01E21"] }],
      },
    });
    const initialEpisodes = createEpisodeStates({
      trackedSeasonId: aheadSeason.id,
      seasonNumber: aheadSeason.seasonNumber,
      totalEpisodes: aheadSeason.totalEpisodes,
      latestAiredEpisode: aheadSeason.latestAiredEpisode,
    });

    const result = await runType3Monitoring({
      title,
      season: aheadSeason,
      episodes: initialEpisodes,
      keyword: "翘楚 4K",
      storageParentDirectoryId: "library_root",
      resourceProvider,
      storage,
      agents: new FakeAgentNodes(),
    });

    expect(result.episodes.find((episode) => episode.episodeCode === "S01E21")).toMatchObject({
      obtained: true,
      metadataStatus: "provider_ahead",
    });
    expect(result.providerAheadEpisodes).toEqual(["S01E21"]);
  });

  it("marks an episode obtained without searching when the target directory already has it", async () => {
    const { title, season } = qiaochuFixture();
    const currentFiles = obtainedFiles(13, season.storageDirectoryId);
    const initialEpisodes = reconcileVerifiedFiles({
      season: { ...season, latestAiredEpisode: 13 },
      episodes: createEpisodeStates({
        trackedSeasonId: season.id,
        seasonNumber: season.seasonNumber,
        totalEpisodes: season.totalEpisodes,
        latestAiredEpisode: 13,
      }),
      files: currentFiles.slice(0, 12),
    });
    const storage = new FakeStorageExecutor({
      directories: { [season.storageDirectoryId]: currentFiles },
    });
    const resourceProvider = new FakeResourceProvider({
      keywordErrors: { "翘楚 4K": "search should not be called" },
      keywordResults: {},
    });

    const result = await runType3Monitoring({
      title,
      season: { ...season, latestAiredEpisode: 13 },
      episodes: initialEpisodes,
      keyword: "翘楚 4K",
      storageParentDirectoryId: "library_root",
      resourceProvider,
      storage,
      agents: new FakeAgentNodes(),
    });

    expect(result.transferAttempts).toEqual([]);
    expect(result.decisions).toEqual([]);
    expect(result.episodes.find((episode) => episode.episodeCode === "S01E13")).toMatchObject({
      obtained: true,
    });
  });

  it("graduates a finished, fully-obtained season to completed so it stops 追更", async () => {
    const { title, season } = qiaochuFixture();
    const finished = { ...season, totalEpisodes: 13, latestAiredEpisode: 13, status: "active" as const };
    const currentFiles = obtainedFiles(13, finished.storageDirectoryId);
    const episodes = reconcileVerifiedFiles({
      season: finished,
      episodes: createEpisodeStates({
        trackedSeasonId: finished.id,
        seasonNumber: finished.seasonNumber,
        totalEpisodes: 13,
        latestAiredEpisode: 13,
      }),
      files: currentFiles,
    });
    const storage = new FakeStorageExecutor({
      directories: { [finished.storageDirectoryId]: currentFiles },
    });

    const result = await runType3Monitoring({
      title,
      season: finished,
      episodes,
      keyword: "翘楚 4K",
      storageParentDirectoryId: "library_root",
      resourceProvider: new FakeResourceProvider({ keywordResults: {} }),
      storage,
      agents: new FakeAgentNodes(),
    });

    expect(result.transferAttempts).toEqual([]);
    // It graduated: status flips to completed (next sweep won't monitor it) and
    // the finale is announced.
    expect(result.season.status).toBe("completed");
    expect(result.notification.kind).toBe("tracking_completed");
  });

  it("returns no_coverage with an honest notification when nothing covers the gap", async () => {
    const { title, season } = qiaochuFixture();
    const existingFiles = obtainedFiles(12, season.storageDirectoryId);
    const initialEpisodes = reconcileVerifiedFiles({
      season: { ...season, latestAiredEpisode: 13 },
      episodes: createEpisodeStates({
        trackedSeasonId: season.id,
        seasonNumber: season.seasonNumber,
        totalEpisodes: season.totalEpisodes,
        latestAiredEpisode: 13,
      }),
      files: existingFiles,
    });
    const storage = new FakeStorageExecutor({
      directories: { [season.storageDirectoryId]: existingFiles },
    });
    const resourceProvider = new FakeResourceProvider({
      keywordResults: {
        "翘楚 4K": [{ title: "无关动画 S01E01", episodeHints: ["S01E01"] }],
      },
    });

    const result = await runType3Monitoring({
      title,
      season: { ...season, latestAiredEpisode: 13 },
      episodes: initialEpisodes,
      keyword: "翘楚 4K",
      storageParentDirectoryId: "library_root",
      resourceProvider,
      storage,
      agents: new FakeAgentNodes(),
    });

    expect(result.status).toBe("no_coverage");
    expect(result.transferAttempts).toEqual([]);
    expect(result.notification.kind).toBe("no_coverage");
    expect(result.notification.body).toContain("📺 翘楚 第 1 季");
    expect(result.notification.report?.status).toBe("no_coverage");
    expect(result.notification.body).toContain("暂未找到可用资源");
    expect(result.auditEvents.map((event) => event.type)).toContain("acquisition_no_coverage");
  });
});

class PrimaryThenNoCoverageAgentNodes extends FakeAgentNodes {
  override async planAcquisition(input: AcquisitionPlanningInput): Promise<AcquisitionPlanningResult> {
    const snapshot = await input.searchResources({ keyword: input.initialKeyword });
    if (input.failureEvidence.length > 0) {
      return {
        plan: {
          node: "primary_then_no_coverage",
          selectedSnapshotId: null,
          searchedKeywords: [input.initialKeyword],
          candidateDispositions: snapshot.candidates.map((candidate) => ({
            candidateId: candidate.id,
            disposition: "rejected" as const,
            episodes: [],
            reason: "Agent judged remaining candidates as wrong targets.",
          })),
          confidence: "low",
          reason: "No trustworthy candidate remains after failure evidence.",
        },
        snapshots: [snapshot],
        trace: [],
      };
    }
    const [primary, ...rest] = snapshot.candidates;
    if (!primary) {
      throw new Error("Expected at least one candidate");
    }
    return {
      plan: {
        node: "primary_then_no_coverage",
        selectedSnapshotId: snapshot.id,
        searchedKeywords: [input.initialKeyword],
        candidateDispositions: [
          {
            candidateId: primary.id,
            disposition: "selected" as const,
            episodes: [...primary.episodeHints],
            reason: "Primary covers the missing episode.",
          },
          ...rest.map((candidate) => ({
            candidateId: candidate.id,
            disposition: "rejected" as const,
            episodes: [],
            reason: "Agent judged this candidate as a wrong target.",
          })),
        ],
        confidence: "medium",
        reason: "Selected only the trustworthy primary resource.",
      },
      snapshots: [snapshot],
      trace: [],
    };
  }
}

class StaleSnapshotAgentNodes extends FakeAgentNodes {
  override async planAcquisition(input: AcquisitionPlanningInput): Promise<AcquisitionPlanningResult> {
    const snapshot = await input.searchResources({ keyword: input.initialKeyword });
    return {
      plan: {
        node: "stale_snapshot",
        selectedSnapshotId: "snapshot_99",
        searchedKeywords: [input.initialKeyword],
        candidateDispositions: snapshot.candidates.map((candidate) => ({
          candidateId: candidate.id,
          disposition: "rejected" as const,
          episodes: [],
          reason: "stale decision from a previous search",
        })),
        confidence: "high",
        reason: "stale decision from a previous search",
      },
      snapshots: [snapshot],
      trace: [],
    };
  }
}

class OmittingDispositionAgentNodes extends FakeAgentNodes {
  override async planAcquisition(input: AcquisitionPlanningInput): Promise<AcquisitionPlanningResult> {
    const snapshot = await input.searchResources({ keyword: input.initialKeyword });
    const first = snapshot.candidates[0];
    if (!first) {
      throw new Error("Expected at least one candidate");
    }
    return {
      plan: {
        node: "omitting_disposition",
        selectedSnapshotId: snapshot.id,
        searchedKeywords: [input.initialKeyword],
        candidateDispositions: [
          {
            candidateId: first.id,
            disposition: "selected" as const,
            episodes: [...first.episodeHints],
            reason: "Only judged the first candidate and ignored the rest.",
          },
        ],
        confidence: "high",
        reason: "Truncated judgment.",
      },
      snapshots: [snapshot],
      trace: [],
    };
  }
}

describe("runType3Monitoring dedup", () => {
  it("deletes smaller duplicates after overlapping transfers and keeps episodes obtained", async () => {
    const { title, season } = qiaochuFixture();
    const repairSeason = { ...season, latestAiredEpisode: 14 };
    const existingFiles: VerifiedFile[] = [
      ...obtainedFiles(12, season.storageDirectoryId),
      {
        id: "small_e13",
        storageDirectoryId: season.storageDirectoryId,
        name: "翘楚.S01E13.720p.mkv",
        sizeBytes: 500_000_000,
        episodeCode: "S01E13",
        providerFileId: "small_e13",
      },
    ];
    const initialEpisodes = reconcileVerifiedFiles({
      season: repairSeason,
      episodes: createEpisodeStates({
        trackedSeasonId: season.id,
        seasonNumber: season.seasonNumber,
        totalEpisodes: season.totalEpisodes,
        latestAiredEpisode: 14,
      }),
      files: existingFiles,
    });
    const storage = new FakeStorageExecutor({
      directories: { [season.storageDirectoryId]: existingFiles },
      transferOutcomes: {
        snapshot_1_candidate_1: {
          status: "succeeded",
          providerMessage: "",
          files: [
            {
              id: "big_e13",
              storageDirectoryId: season.storageDirectoryId,
              name: "翘楚.S01E13.2160p.mkv",
              sizeBytes: 5_000_000_000,
              episodeCode: "S01E13",
              providerFileId: "big_e13",
            },
            {
              id: "file_e14",
              storageDirectoryId: season.storageDirectoryId,
              name: "翘楚.S01E14.2160p.mkv",
              sizeBytes: 5_000_000_000,
              episodeCode: "S01E14",
              providerFileId: "file_e14",
            },
          ],
        },
      },
    });
    const resourceProvider = new FakeResourceProvider({
      keywordResults: {
        "翘楚 4K": [{ title: "翘楚 S01E13-S01E14 4K包", episodeHints: ["S01E13", "S01E14"] }],
      },
    });

    const result = await runType3Monitoring({
      title,
      season: repairSeason,
      episodes: initialEpisodes,
      keyword: "翘楚 4K",
      storageParentDirectoryId: "library_root",
      resourceProvider,
      storage,
      agents: new FakeAgentNodes({
        packageRecognition: {
          node: "test_dedup_confirm",
          fileMappings: [
            { providerFileId: "small_e13", seasonNumber: 1, episodeNumber: 13, confidence: "high", reason: "filename" },
            { providerFileId: "big_e13", seasonNumber: 1, episodeNumber: 13, confidence: "high", reason: "filename" },
          ],
          rejectedProviderFileIds: [],
          confidence: "high",
          reason: "both files are episode 13",
        },
      }),
    });

    expect(result.status).toBe("succeeded");
    const finalFiles = await storage.listVideoFiles(season.storageDirectoryId);
    const e13Files = finalFiles.filter((file) => file.episodeCode === "S01E13");
    expect(e13Files.map((file) => file.id)).toEqual(["big_e13"]);
    const e13State = result.episodes.find((episode) => episode.episodeCode === "S01E13");
    expect(e13State).toMatchObject({ obtained: true, verifiedFileIds: ["big_e13"] });
    const auditTypes = result.auditEvents.map((event) => event.type);
    expect(auditTypes).toContain("dedup_plan_created");
    expect(auditTypes).toContain("dedup_verified");
  });
});

describe("unparsed video file rescue", () => {
  function initialEpisodesFor(season: TrackedSeason, files: VerifiedFile[]) {
    return reconcileVerifiedFiles({
      season,
      episodes: createEpisodeStates({
        trackedSeasonId: season.id,
        seasonNumber: season.seasonNumber,
        totalEpisodes: season.totalEpisodes,
        latestAiredEpisode: season.latestAiredEpisode,
      }),
      files,
    });
  }

  it("rescues an agent-confirmed unparsed file by canonical rename instead of re-acquiring", async () => {
    const { title, season } = qiaochuFixture();
    // E01-E13 parseable; E14 exists but its name exposes no episode code.
    const existingFiles = obtainedFiles(13, season.storageDirectoryId);
    const storage = new FakeStorageExecutor({
      directories: { [season.storageDirectoryId]: existingFiles },
      unparsedFiles: {
        [season.storageDirectoryId]: [
          { providerFileId: "weird_e14", name: "QiaoChu.FourTeen.4K.mkv", sizeBytes: 2_000_000_000 },
        ],
      },
    });
    let planCalls = 0;
    const agents = new (class extends FakeAgentNodes {
      override async planAcquisition(input: AcquisitionPlanningInput): Promise<AcquisitionPlanningResult> {
        planCalls += 1;
        return super.planAcquisition(input);
      }
    })({
      packageRecognition: {
        node: "test_rescue",
        fileMappings: [
          {
            providerFileId: "weird_e14",
            seasonNumber: 1,
            episodeNumber: 14,
            confidence: "high",
            reason: "FourTeen is episode 14 of this title",
          },
        ],
        rejectedProviderFileIds: [],
        confidence: "high",
        reason: "single unparsed file maps to E14",
      },
    });

    const result = await runType3Monitoring({
      title,
      season,
      episodes: initialEpisodesFor(season, existingFiles),
      keyword: "翘楚 4K",
      storageParentDirectoryId: "library_root",
      resourceProvider: new FakeResourceProvider({ keywordResults: {} }),
      storage,
      agents,
    });

    expect(planCalls).toBe(0);
    expect(result.status).toBe("succeeded");
    expect(result.notification.kind).toBe("already_current");
    const files = await storage.listVideoFiles(season.storageDirectoryId);
    const rescued = files.find((file) => file.id === "weird_e14");
    expect(rescued).toMatchObject({ episodeCode: "S01E14", name: "翘楚.S01E14.mkv" });
    expect(result.auditEvents.map((event) => event.type)).toContain("unparsed_file_rescued");
  });

  it("keeps unconfirmed unparsed files untouched, surfaces a warning, and acquires honestly", async () => {
    const { title, season } = qiaochuFixture();
    const existingFiles = obtainedFiles(13, season.storageDirectoryId);
    const storage = new FakeStorageExecutor({
      directories: { [season.storageDirectoryId]: existingFiles },
      unparsedFiles: {
        [season.storageDirectoryId]: [
          { providerFileId: "mystery_file", name: "random-extra-thing.mkv", sizeBytes: 700_000_000 },
        ],
      },
      transferOutcomes: {
        snapshot_1_candidate_1: {
          status: "succeeded",
          providerMessage: "",
          files: [
            {
              id: "file_S01E14",
              storageDirectoryId: "set_by_fake",
              name: "翘楚.S01E14.mkv",
              sizeBytes: 1_000_000_000,
              episodeCode: "S01E14",
              providerFileId: "provider_S01E14",
            },
          ],
        },
      },
    });

    const result = await runType3Monitoring({
      title,
      season,
      episodes: initialEpisodesFor(season, existingFiles),
      keyword: "翘楚 4K",
      storageParentDirectoryId: "library_root",
      resourceProvider: new FakeResourceProvider({
        keywordResults: {
          "翘楚 4K": [{ title: "翘楚 S01E14 4K", episodeHints: ["S01E14"], qualityHints: ["4K"] }],
        },
      }),
      storage,
      // default recognition: low confidence, nothing mapped
      agents: new FakeAgentNodes(),
    });

    expect(result.status).toBe("succeeded");
    expect(result.obtainedEpisodes).toContain("S01E14");
    const stillUnparsed = await storage.listUnparsedVideoFiles(season.storageDirectoryId);
    expect(stillUnparsed.map((file) => file.providerFileId)).toEqual(["mystery_file"]);
    expect(result.auditEvents.map((event) => event.type)).toContain("unparsed_files_present");
  });
});
