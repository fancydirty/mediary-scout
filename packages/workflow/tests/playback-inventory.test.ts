import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACCOUNT_ID,
  FakeStorageExecutor,
  InMemoryWorkflowRepository,
  SqliteWorkflowRepository,
  createEpisodeStates,
  createSqliteWorkflowRepository,
  runScheduledType3Monitoring,
  type EpisodeState,
  type MediaTitle,
  type TrackedSeason,
  type WorkflowRepository,
} from "../src/index.js";

const title: MediaTitle = {
  id: "title_inv_test",
  tmdbId: 88001,
  type: "tv",
  title: "测试双账剧",
  originalTitle: "Dual Ledger Show",
  year: 2026,
  aliases: [],
};

const season: TrackedSeason = {
  id: `${title.id}_s1`,
  mediaTitleId: title.id,
  seasonNumber: 1,
  status: "active",
  totalEpisodes: 2,
  latestAiredEpisode: 2,
  latestAiredSource: "metadata",
  qualityPreference: "4K",
  storageDirectoryId: "dir_s1",
};

function makeEpisodes(codes: string[]): EpisodeState[] {
  const set = new Set(codes);
  return createEpisodeStates({
    trackedSeasonId: season.id,
    seasonNumber: 1,
    totalEpisodes: 2,
    latestAiredEpisode: 2,
  }).map((ep) => ({
    ...ep,
    obtained: set.has(ep.episodeCode),
    verifiedFileIds: set.has(ep.episodeCode) ? [`fid_${ep.episodeCode}`] : [],
  }));
}

function runSuite(label: string, createRepo: () => Promise<{ repo: WorkflowRepository; close?: () => void }>) {
  describe(`inventory status & playback progress (${label})`, () => {
    it("lazily marks a drive copy missing_on_drive WITHOUT causing patrol to resurrect user-deleted episodes", async () => {
      const { repo, close } = await createRepo();
      try {
        await repo.saveWorkflowRunSnapshot({
          accountId: DEFAULT_ACCOUNT_ID,
          connectedStorageId: "cs_115",
          title,
          season,
          workflowRun: {
            id: "run_init",
            kind: "type2_init",
            status: "succeeded",
            trackedSeasonId: season.id,
            startedAt: "2026-11-20T00:00:00.000Z",
            finishedAt: "2026-11-20T00:01:00.000Z",
            auditEvents: [],
          },
          episodes: makeEpisodes(["S01E01", "S01E02"]),
          resourceSnapshots: [],
          decisions: [],
          transferAttempts: [],
          notifications: [],
        });

        await repo.upsertEpisodeCopies!([
          {
            trackedSeasonId: season.id,
            episodeCode: "S01E01",
            storageId: "cs_115",
            fileIds: ["f1"],
            sizeBytes: 1_500_000_000,
            quality: "4K",
            runId: "run_init",
            recordedAt: "2026-11-20T00:01:00.000Z",
          },
          {
            trackedSeasonId: season.id,
            episodeCode: "S01E02",
            storageId: "cs_115",
            fileIds: ["f2"],
            sizeBytes: 1_600_000_000,
            quality: "4K",
            runId: "run_init",
            recordedAt: "2026-11-20T00:01:00.000Z",
          },
        ]);

        // User deletes E01 on 115 → Virtual Emby lazily marks copy missing_on_drive.
        await repo.setEpisodeCopyFileStatus!({
          trackedSeasonId: season.id,
          episodeCode: "S01E01",
          storageId: "cs_115",
          fileStatus: "missing_on_drive",
          verifiedAt: "2026-11-28T10:00:00.000Z",
        });

        // Physical inventory shows missing_on_drive for E01, present for E02.
        const batch = await repo.listEpisodeCopiesForSeasons!([season.id]);
        expect(batch.find((c) => c.episodeCode === "S01E01")?.fileStatus).toBe("missing_on_drive");
        expect(batch.find((c) => c.episodeCode === "S01E01")?.verifiedAt).toBe("2026-11-28T10:00:00.000Z");
        expect(batch.find((c) => c.episodeCode === "S01E01")?.fileIds).toEqual(["f1"]);
        expect(batch.find((c) => c.episodeCode === "S01E02")?.fileStatus ?? "present").toBe("present");

        // Cross-drive ownership preserves obtained=true (intent) AND surfaces missing_on_drive.
        const ownership = await repo.obtainedEpisodesForSeason!(season.id, DEFAULT_ACCOUNT_ID);
        const e1 = ownership.find((o) => o.episodeCode === "S01E01");
        expect(e1?.obtained).toBe(true);
        expect(e1?.drives[0]?.fileStatus).toBe("missing_on_drive");

        // Daily patrol MUST NOT invoke the model to re-download E01!
        let modelCalled = false;
        const outcomes = await runScheduledType3Monitoring({
          repository: repo,
          resourceProvider: {
            search: async () => ({
              id: "snap_1",
              provider: "fake",
              keyword: "test",
              candidates: [],
              createdAt: "2026-11-28T22:00:00.000Z",
            }),
          },
          storage: new FakeStorageExecutor(),
          model: {
            specificationVersion: "v1",
            provider: "test",
            modelId: "test",
            doGenerate: async () => {
              modelCalled = true;
              throw new Error("patrol must not resurrect user-deleted episode");
            },
            doStream: async () => {
              throw new Error("not used");
            },
          } as never,
          storageParentDirectoryId: "root",
          now: () => "2026-11-28T22:00:00.000Z",
        });
        expect(outcomes).toHaveLength(1);
        expect(modelCalled).toBe(false);

        // Re-upserting the SAME fileIds without fileStatus MUST preserve missing_on_drive tombstone!
        await repo.upsertEpisodeCopies!([
          {
            trackedSeasonId: season.id,
            episodeCode: "S01E01",
            storageId: "cs_115",
            fileIds: ["f1"],
            sizeBytes: 1_000_000_000,
            quality: "4K",
            runId: "run_refresh",
            recordedAt: "2026-11-28T10:30:00.000Z",
          },
        ]);
        const stillMissing = await repo.listEpisodeCopies!(season.id);
        expect(stillMissing.find((c) => c.episodeCode === "S01E01")?.fileStatus).toBe("missing_on_drive");
        expect(stillMissing.find((c) => c.episodeCode === "S01E01")?.verifiedAt).toBe(
          "2026-11-28T10:00:00.000Z",
        );

        // Explicit re-acquisition upserts NEW fileIds → fileStatus heals back to "present".
        await repo.upsertEpisodeCopies!([
          {
            trackedSeasonId: season.id,
            episodeCode: "S01E01",
            storageId: "cs_115",
            fileIds: ["f1_new"],
            sizeBytes: 2_000_000_000,
            quality: "4K",
            runId: "run_reacquire",
            recordedAt: "2026-11-28T11:00:00.000Z",
          },
        ]);
        const healed = await repo.listEpisodeCopies!(season.id);
        expect(healed.find((c) => c.episodeCode === "S01E01")?.fileStatus ?? "present").toBe("present");
        expect(healed.find((c) => c.episodeCode === "S01E01")?.fileIds).toEqual(["f1_new"]);

        // Stale 404 for old fileId ("f1") MUST NOT tombstone the newly-landed single-file copy ("f1_new")!
        await repo.markEpisodeCopyFileMissing!({
          trackedSeasonId: season.id,
          episodeCode: "S01E01",
          storageId: "cs_115",
          fileId: "f1",
          verifiedAt: "2026-11-28T11:15:00.000Z",
        });
        const afterStale = (await repo.listEpisodeCopies!(season.id)).find((c) => c.episodeCode === "S01E01");
        expect(afterStale?.fileStatus ?? "present").toBe("present");
        expect(afterStale?.fileIds).toEqual(["f1_new"]);

        // Multi-file copy: markEpisodeCopyFileMissing prunes ONLY the dead fileId while keeping sibling live!
        await repo.upsertEpisodeCopies!([
          {
            trackedSeasonId: season.id,
            episodeCode: "S01E02",
            storageId: "cs_115",
            fileIds: ["f2_a", "f2_b"],
            sizeBytes: 1_500_000_000,
            quality: "4K",
            runId: "run_init",
            recordedAt: "2026-11-28T00:00:00.000Z",
          },
        ]);
        await repo.markEpisodeCopyFileMissing!({
          trackedSeasonId: season.id,
          episodeCode: "S01E02",
          storageId: "cs_115",
          fileId: "f2_a",
          verifiedAt: "2026-11-28T11:30:00.000Z",
        });
        const afterFirstPrune = (await repo.listEpisodeCopies!(season.id)).find((c) => c.episodeCode === "S01E02");
        expect(afterFirstPrune?.fileIds).toEqual(["f2_b"]);
        expect(afterFirstPrune?.fileStatus ?? "present").toBe("present");

        // Marking the LAST remaining fileId tombstones the whole row.
        await repo.markEpisodeCopyFileMissing!({
          trackedSeasonId: season.id,
          episodeCode: "S01E02",
          storageId: "cs_115",
          fileId: "f2_b",
          verifiedAt: "2026-11-28T11:45:00.000Z",
        });
        const afterLastPrune = (await repo.listEpisodeCopies!(season.id)).find((c) => c.episodeCode === "S01E02");
        expect(afterLastPrune?.fileStatus).toBe("missing_on_drive");
      } finally {
        close?.();
      }
    });

    it("stores, updates, and isolates playback_progress per account with large 64-bit tick values", async () => {
      const { repo, close } = await createRepo();
      try {
        // 2h30m in Emby ticks = 90_000_000_000 (> 32-bit INT_MAX!)
        const ticks = 45_000_000_000;
        const duration = 90_000_000_000;
        await repo.upsertPlaybackProgress!({
          accountId: "acct_a",
          tmdbId: 550,
          mediaType: "movie",
          seasonNumber: 1,
          episodeNumber: 1,
          positionTicks: ticks,
          durationTicks: duration,
          played: false,
          playCount: 0,
          lastPlayedAt: "2026-11-28T09:00:00.000Z",
        });
        await repo.upsertPlaybackProgress!({
          accountId: "acct_a",
          tmdbId: 88001,
          mediaType: "tv",
          seasonNumber: 1,
          episodeNumber: 2,
          positionTicks: 0,
          durationTicks: 27_000_000_000,
          played: true,
          playCount: 1,
          lastPlayedAt: "2026-11-28T10:00:00.000Z",
        });
        await repo.upsertPlaybackProgress!({
          accountId: "acct_b",
          tmdbId: 550,
          mediaType: "movie",
          seasonNumber: 1,
          episodeNumber: 1,
          positionTicks: 10_000_000,
          durationTicks: duration,
          played: false,
          playCount: 0,
          lastPlayedAt: "2026-11-28T11:00:00.000Z",
        });

        const gotA = await repo.getPlaybackProgress!({
          accountId: "acct_a",
          tmdbId: 550,
          mediaType: "movie",
          seasonNumber: 1,
          episodeNumber: 1,
        });
        expect(gotA).toEqual({
          accountId: "acct_a",
          tmdbId: 550,
          mediaType: "movie",
          seasonNumber: 1,
          episodeNumber: 1,
          positionTicks: ticks,
          durationTicks: duration,
          played: false,
          playCount: 0,
          lastPlayedAt: "2026-11-28T09:00:00.000Z",
        });

        const listA = await repo.listPlaybackProgress!("acct_a");
        expect(listA.map((r) => r.tmdbId)).toEqual([88001, 550]); // newest first

        const filteredA = await repo.listPlaybackProgress!("acct_a", { tmdbId: 88001, mediaType: "tv" });
        expect(filteredA.map((r) => r.tmdbId)).toEqual([88001]);

        const listB = await repo.listPlaybackProgress!("acct_b");
        expect(listB).toHaveLength(1);
        expect(listB[0]?.positionTicks).toBe(10_000_000);

        // Atomic insert-if-absent settings + indexed account lookup
        expect(await repo.setSettingIfAbsent!("virtual_emby_server_id", "first_winner")).toBe("first_winner");
        expect(await repo.setSettingIfAbsent!("virtual_emby_server_id", "second_loser")).toBe("first_winner");
        await repo.createAccount({
          id: "acct_lookup",
          username: "lookup_user",
          passwordHash: "",
          groupId: null,
          isOwner: false,
          createdAt: "2026-11-28T00:00:00.000Z",
        });
        expect(await repo.setAccountSettingIfAbsent!("acct_lookup", "virtual_emby_token", "tok_win")).toBe("tok_win");
        expect(await repo.setAccountSettingIfAbsent!("acct_lookup", "virtual_emby_token", "tok_lose")).toBe("tok_win");
        const foundAcct = await repo.findAccountBySetting!("virtual_emby_token", "tok_win");
        expect(foundAcct?.id).toBe("acct_lookup");
        expect(await repo.findAccountBySetting!("virtual_emby_token", "missing")).toBeNull();

        // Duplicate setting across two accounts MUST fail closed (return null, never arbitrarily pick one)
        await repo.createAccount({
          id: "acct_dup",
          username: "dup_user",
          passwordHash: "",
          groupId: null,
          isOwner: false,
          createdAt: "2026-11-28T00:00:00.000Z",
        });
        await repo.setAccountSetting("acct_dup", "virtual_emby_token", "tok_win");
        expect(await repo.findAccountBySetting!("virtual_emby_token", "tok_win")).toBeNull();
      } finally {
        close?.();
      }
    });
  });
}

runSuite("InMemory", async () => ({ repo: new InMemoryWorkflowRepository() }));
runSuite("SQLite", async () => {
  const repo = createSqliteWorkflowRepository({ path: ":memory:" });
  return { repo, close: () => repo.close() };
});

describe("SQLite legacy episode_copies migration", () => {
  it("auto-adds file_status and verified_at columns to pre-existing SQLite DBs", async () => {
    const req = createRequire(import.meta.url);
    const Database = req("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE episode_copies (
        tracked_season_id text NOT NULL,
        episode_code text NOT NULL,
        storage_id text NOT NULL,
        file_ids text NOT NULL,
        size_bytes integer,
        quality text,
        run_id text NOT NULL,
        recorded_at text NOT NULL,
        PRIMARY KEY (tracked_season_id, episode_code, storage_id)
      );
      INSERT INTO episode_copies VALUES ('s1', 'S01E01', 'cs_1', '["f1"]', 100, '4K', 'r1', '2026-10-01T00:00:00.000Z');
    `);
    const repo = new SqliteWorkflowRepository(db);
    try {
      const copies = await repo.listEpisodeCopies("s1");
      expect(copies).toHaveLength(1);
      expect(copies[0]?.fileStatus ?? "present").toBe("present");
      expect(copies[0]?.verifiedAt ?? null).toBeNull();
      await repo.setEpisodeCopyFileStatus({
        trackedSeasonId: "s1",
        episodeCode: "S01E01",
        storageId: "cs_1",
        fileStatus: "missing_on_drive",
        verifiedAt: "2026-11-28T12:00:00.000Z",
      });
      const updated = await repo.listEpisodeCopies("s1");
      expect(updated[0]?.fileStatus).toBe("missing_on_drive");
      expect(updated[0]?.verifiedAt).toBe("2026-11-28T12:00:00.000Z");
    } finally {
      repo.close();
    }
  });
});
