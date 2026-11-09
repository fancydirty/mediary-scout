import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import {
  DEFAULT_ACCOUNT_ID,
  InMemoryWorkflowRepository,
  createEpisodeStates,
  createSqliteWorkflowRepository,
  getTrackedSeasonStatusView,
  type EpisodeState,
  type MediaTitle,
  type TrackedSeason,
  type WorkflowRepository,
} from "../src/index.js";

const title: MediaTitle = {
  id: "title_split_test",
  tmdbId: 90001,
  type: "tv",
  title: "跨盘补集剧",
  originalTitle: "Cross Drive Show",
  year: 2026,
  aliases: [],
};

const season: TrackedSeason = {
  id: "season_split_test_s1",
  mediaTitleId: title.id,
  seasonNumber: 1,
  status: "active",
  totalEpisodes: 4,
  latestAiredEpisode: 4,
  latestAiredSource: "metadata",
  qualityPreference: "4K",
  storageDirectoryId: "dir_s1",
};

function makeEpisodes(obtainedCodes: string[]): EpisodeState[] {
  const set = new Set(obtainedCodes);
  return createEpisodeStates({
    trackedSeasonId: season.id,
    seasonNumber: 1,
    totalEpisodes: 4,
    latestAiredEpisode: 4,
  }).map((ep) => ({
    ...ep,
    obtained: set.has(ep.episodeCode),
    verifiedFileIds: set.has(ep.episodeCode) ? [`file_${ep.episodeCode}`] : [],
  }));
}

function runSuite(label: string, createRepo: () => Promise<{ repo: WorkflowRepository; close?: () => void }>) {
  describe(`cross-drive episode ownership (${label})`, () => {
    it("unions obtained episodes across drives and attaches per-drive copy metadata", async () => {
      const { repo, close } = await createRepo();
      try {
        // Drive 115 has E01, E02
        await repo.saveWorkflowRunSnapshot({
          accountId: DEFAULT_ACCOUNT_ID,
          connectedStorageId: "cs_115",
          title,
          season,
          workflowRun: {
            id: "run_115",
            kind: "type2_init",
            status: "partial",
            trackedSeasonId: season.id,
            startedAt: "2026-10-27T00:00:00.000Z",
            finishedAt: "2026-10-27T00:01:00.000Z",
            auditEvents: [],
          },
          episodes: makeEpisodes(["S01E01", "S01E02"]),
          resourceSnapshots: [],
          decisions: [],
          transferAttempts: [],
          notifications: [],
        });

        // Drive 123 has E03
        await repo.saveWorkflowRunSnapshot({
          accountId: DEFAULT_ACCOUNT_ID,
          connectedStorageId: "cs_123",
          title,
          season: { ...season, storageDirectoryId: "dir_s1_123" },
          workflowRun: {
            id: "run_123",
            kind: "type2_init",
            status: "partial",
            trackedSeasonId: season.id,
            startedAt: "2026-10-27T00:02:00.000Z",
            finishedAt: "2026-10-27T00:03:00.000Z",
            auditEvents: [],
          },
          episodes: makeEpisodes(["S01E03"]),
          resourceSnapshots: [],
          decisions: [],
          transferAttempts: [],
          notifications: [],
        });

        await repo.upsertEpisodeCopies?.([
          {
            trackedSeasonId: season.id,
            episodeCode: "S01E01",
            storageId: "cs_115",
            fileIds: ["f_115_1"],
            sizeBytes: 2_000_000_000,
            quality: "4K",
            runId: "run_115",
            recordedAt: "2026-10-27T00:01:00.000Z",
          },
          {
            trackedSeasonId: season.id,
            episodeCode: "S01E02",
            storageId: "cs_115",
            fileIds: ["f_115_2"],
            sizeBytes: 2_100_000_000,
            quality: "4K",
            runId: "run_115",
            recordedAt: "2026-10-27T00:01:00.000Z",
          },
          {
            trackedSeasonId: season.id,
            episodeCode: "S01E03",
            storageId: "cs_123",
            fileIds: ["f_123_3"],
            sizeBytes: 1_800_000_000,
            quality: "1080P",
            runId: "run_123",
            recordedAt: "2026-10-27T00:03:00.000Z",
          },
        ]);

        const ownership = await repo.obtainedEpisodesForSeason!(season.id, DEFAULT_ACCOUNT_ID);
        const obtained = ownership.filter((o) => o.obtained);
        expect(obtained.map((o) => o.episodeCode)).toEqual(["S01E01", "S01E02", "S01E03"]);
        expect(obtained.find((o) => o.episodeCode === "S01E01")?.drives).toEqual([
          {
            storageId: "cs_115",
            fileIds: ["f_115_1"],
            sizeBytes: 2_000_000_000,
            quality: "4K",
          },
        ]);
        expect(obtained.find((o) => o.episodeCode === "S01E03")?.drives).toEqual([
          {
            storageId: "cs_123",
            fileIds: ["f_123_3"],
            sizeBytes: 1_800_000_000,
            quality: "1080P",
          },
        ]);

        // Unscoped view (connectedStorageId: null) shows 3 obtained, 1 missing (S01E04)
        const view = await getTrackedSeasonStatusView({
          repository: repo,
          trackedSeasonId: season.id,
          scope: {
            accountId: DEFAULT_ACCOUNT_ID,
            connectedStorageId: null,
          },
        });
        expect(view).not.toBeNull();
        expect(view!.obtainedCount).toBe(3);
        expect(view!.missingAiredCount).toBe(1);
        expect(view!.episodes.find((e) => e.episodeCode === "S01E03")?.drives?.[0]?.storageId).toBe(
          "cs_123",
        );
        expect(view!.episodes.find((e) => e.episodeCode === "S01E04")?.obtained).toBe(false);
      } finally {
        close?.();
      }
    });

    it("deduplicates patrolled seasons across drives and passes the cross-drive obtained union to patrol", async () => {
      const { repo, close } = await createRepo();
      try {
        // Drive 115 has E01, E02; Drive 123 has E03, E04 (all 4 episodes obtained across 2 drives!)
        await repo.saveWorkflowRunSnapshot({
          accountId: DEFAULT_ACCOUNT_ID,
          connectedStorageId: "cs_115",
          title,
          season,
          workflowRun: {
            id: "run_115_full",
            kind: "type2_init",
            status: "partial",
            trackedSeasonId: season.id,
            startedAt: "2026-10-27T00:00:00.000Z",
            finishedAt: "2026-10-27T00:01:00.000Z",
            auditEvents: [],
          },
          episodes: makeEpisodes(["S01E01", "S01E02"]),
          resourceSnapshots: [],
          decisions: [],
          transferAttempts: [],
          notifications: [],
        });

        await repo.saveWorkflowRunSnapshot({
          accountId: DEFAULT_ACCOUNT_ID,
          connectedStorageId: "cs_123",
          title,
          season: { ...season, storageDirectoryId: "dir_s1_123" },
          workflowRun: {
            id: "run_123_full",
            kind: "type2_init",
            status: "partial",
            trackedSeasonId: season.id,
            startedAt: "2026-10-27T00:02:00.000Z",
            finishedAt: "2026-10-27T00:03:00.000Z",
            auditEvents: [],
          },
          episodes: makeEpisodes(["S01E03", "S01E04"]),
          resourceSnapshots: [],
          decisions: [],
          transferAttempts: [],
          notifications: [],
        });

        const { runScheduledType3Monitoring, FakeStorageExecutor } = await import("../src/index.js");
        let modelInvoked = false;
        const outcomes = await runScheduledType3Monitoring({
          repository: repo,
          resourceProvider: {
            search: async () => ({
              id: "snap_empty",
              provider: "fake",
              keyword: "test",
              candidates: [],
              createdAt: "2026-10-27T06:00:00.000Z",
            }),
          },
          storage: new FakeStorageExecutor(),
          model: {
            specificationVersion: "v1",
            provider: "test",
            modelId: "test",
            defaultObjectGenerationMode: undefined,
            doGenerate: async () => {
              modelInvoked = true;
              throw new Error("should not invoke model when cross-drive union has all 4 episodes");
            },
            doStream: async () => {
              throw new Error("not used");
            },
          } as never,
          storageParentDirectoryId: "root",
          now: () => "2026-10-27T06:00:00.000Z",
        });

        // Deduplicated to 1 season patrol, and because S01E01-S01E04 are all obtained
        // across cs_115 U cs_123, the patrol records already_current without invoking the LLM!
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]?.status).toBe("ran");
        expect(modelInvoked).toBe(false);
      } finally {
        close?.();
      }
    });

    it("patrols the drive whose row the patrol acts on, even when a completed row on another drive holds more", async () => {
      const { repo, close } = await createRepo();
      try {
        const realSeason: TrackedSeason = { ...season, id: `${title.id}_s1` };
        const make = (codes: string[]) =>
          makeEpisodes(codes).map((ep) => ({ ...ep, trackedSeasonId: realSeason.id }));
        // Quark finished the first three before TMDB added E04; 115 is the active row.
        for (const [drive, status, codes, at] of [
          ["cs_quark", "completed", ["S01E01", "S01E02", "S01E03"], "2026-11-01T00:00:00.000Z"],
          ["cs_115", "active", ["S01E01"], "2026-11-02T00:00:00.000Z"],
        ] as const) {
          await repo.saveWorkflowRunSnapshot({
            accountId: DEFAULT_ACCOUNT_ID,
            connectedStorageId: drive,
            title,
            season: { ...realSeason, status },
            workflowRun: { id: `run_${drive}`, kind: "type2_init", status: "partial", trackedSeasonId: realSeason.id, startedAt: at, finishedAt: at, auditEvents: [] },
            episodes: make([...codes]),
            resourceSnapshots: [],
            decisions: [],
            transferAttempts: [],
            notifications: [],
          });
        }
        const { runScheduledType3Monitoring, FakeStorageExecutor } = await import("../src/index.js");
        let modelCalls = 0;
        const outcomes = await runScheduledType3Monitoring({
          repository: repo,
          resourceProvider: {
            search: async () => ({ id: "snap_empty", provider: "fake", keyword: "test", candidates: [], createdAt: "2026-11-07T00:11:00.000Z" }),
          },
          storage: new FakeStorageExecutor(),
          model: new MockLanguageModelV3({
            doGenerate: async () => {
              modelCalls += 1;
              throw new Error("stop after the agent was reached");
            },
          }),
          storageParentDirectoryId: "root",
          now: () => "2026-11-07T00:11:00.000Z",
        });
        // The active 115 row was patrolled (E04 is missing) instead of being skipped
        // as the completed Quark row would have been.
        expect(outcomes).toHaveLength(1);
        expect(modelCalls).toBeGreaterThan(0);
      } finally {
        close?.();
      }
    });

    // issue #369: an already-current patrol must not write the cross-drive union into
    // the patrolled drive — no phantom copies on a drive with no files, no wiping of
    // the file ids a drive really holds — whichever drive the dedup picks.
    for (const scenario of [
      { name: "files only on the second drive", local115: [] as string[], localQuark: ["S01E01", "S01E02", "S01E03", "S01E04"] },
      { name: "files split across both drives", local115: ["S01E01", "S01E02"], localQuark: ["S01E03", "S01E04"] },
    ]) {
      it(`already-current patrol leaves each drive's own records alone (${scenario.name})`, async () => {
        const { repo, close } = await createRepo();
        // The engine names a season `${title.id}_s${n}`: the records must use that id
        // for the patrol's writes to land on them.
        const realSeason: TrackedSeason = { ...season, id: `${title.id}_s1` };
        try {
          const save = async (drive: string, runId: string, startedAt: string, codes: string[]) => {
            await repo.saveWorkflowRunSnapshot({
              accountId: DEFAULT_ACCOUNT_ID,
              connectedStorageId: drive,
              title,
              season: { ...realSeason, storageDirectoryId: `dir_${drive}` },
              workflowRun: {
                id: runId,
                kind: "type2_init",
                status: "partial",
                trackedSeasonId: realSeason.id,
                startedAt,
                finishedAt: startedAt,
                auditEvents: [],
              },
              episodes: makeEpisodes(codes).map((ep) => ({
                ...ep,
                trackedSeasonId: realSeason.id,
                verifiedFileIds: ep.obtained ? [`${drive}_${ep.episodeCode}`] : [],
              })),
              resourceSnapshots: [],
              decisions: [],
              transferAttempts: [],
              notifications: [],
            });
            await repo.upsertEpisodeCopies?.(
              codes.map((code) => ({
                trackedSeasonId: realSeason.id,
                episodeCode: code,
                storageId: drive,
                fileIds: [`${drive}_${code}`],
                sizeBytes: 1_000,
                quality: null,
                runId,
                recordedAt: startedAt,
              })),
            );
          };
          await save("cs_115", "run_115", "2026-11-06T00:00:00.000Z", scenario.local115);
          await save("cs_quark", "run_quark", "2026-11-06T00:01:00.000Z", scenario.localQuark);
          const copiesBefore = await repo.listEpisodeCopies!(realSeason.id);

          const { runScheduledType3Monitoring, FakeStorageExecutor } = await import("../src/index.js");
          const outcomes = await runScheduledType3Monitoring({
            repository: repo,
            resourceProvider: {
              search: async () => ({ id: "snap_empty", provider: "fake", keyword: "test", candidates: [], createdAt: "2026-11-07T00:11:00.000Z" }),
            },
            storage: new FakeStorageExecutor(),
            model: {
              specificationVersion: "v1",
              provider: "test",
              modelId: "test",
              defaultObjectGenerationMode: undefined,
              doGenerate: async () => {
                throw new Error("an already-current patrol never invokes the model");
              },
              doStream: async () => {
                throw new Error("not used");
              },
            } as never,
            storageParentDirectoryId: "root",
            now: () => "2026-11-07T00:11:00.000Z",
          });
          expect(outcomes).toHaveLength(1);
          expect(outcomes[0]?.status).toBe("ran");

          // episode_copies untouched: no phantom rows, no emptied file ids.
          expect(await repo.listEpisodeCopies!(realSeason.id)).toEqual(copiesBefore);
          // Each drive's own episode_states still say exactly what that drive holds.
          for (const [drive, codes] of [["cs_115", scenario.local115], ["cs_quark", scenario.localQuark]] as const) {
            const state = await repo.getTrackedSeasonState(realSeason.id, { accountId: DEFAULT_ACCOUNT_ID, connectedStorageId: drive });
            expect(state?.episodes.filter((e) => e.obtained).map((e) => e.episodeCode)).toEqual(codes);
            for (const ep of state?.episodes.filter((e) => e.obtained) ?? []) {
              expect(ep.verifiedFileIds).toEqual([`${drive}_${ep.episodeCode}`]);
            }
          }
        } finally {
          close?.();
        }
      });
    }
  });
}

runSuite("InMemory", async () => ({ repo: new InMemoryWorkflowRepository() }));
runSuite("SQLite", async () => {
  const repo = createSqliteWorkflowRepository({ path: ":memory:" });
  return { repo, close: () => repo.close() };
});
