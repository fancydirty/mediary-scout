import { describe, expect, it } from "vitest";
import {
  MULTI_DRIVE_STAGING_HANDLE,
  MultiDriveStorageV2,
  multiDriveSeasonHandle,
  Storage115Simulator,
  type AcquisitionDriveContext,
  type StorageExecutor,
} from "../src/index.js";

function makeDrive(options: {
  storageId: string;
  provider: string;
  label: string;
  sim: Storage115Simulator;
  space?: { totalBytes: number; usedBytes: number } | null;
  createdDirs?: string[];
  removedDirs?: string[];
}): AcquisitionDriveContext {
  const createdDirs = options.createdDirs ?? [];
  const removedDirs = options.removedDirs ?? [];
  const executor: StorageExecutor = {
    createDirectory: async (input) => {
      createdDirs.push(`${options.storageId}:${input.name}`);
      return options.sim.createDirectory(input);
    },
    listChildDirectories: async () => [],
    listVideoFiles: async () => [],
    listUnparsedVideoFiles: async () => [],
    renameFile: async (input) => options.sim.renameFile(input),
    transfer: async () => ({
      id: "t1",
      workflowRunId: "r1",
      candidateId: "c1",
      status: "succeeded",
      providerMessage: "",
      materializedFileIds: [],
    }),
    flattenDirectory: async () => ({ moved: [], removed: [] }),
    deleteFiles: async (input) => options.sim.deleteFiles(input),
    removeDirectory: async (directoryId) => {
      removedDirs.push(`${options.storageId}:${directoryId}`);
      await options.sim.removeDirectory({ directoryId });
      return { removed: true };
    },
    listTree: async () => [],
    listSubdirectories: async () => [],
    moveFiles: async (input) => options.sim.moveFiles(input),
  };
  return {
    storageId: options.storageId,
    provider: options.provider,
    label: options.label,
    storage: executor,
    parents: { tv: "root", anime: "root", movies: "root" },
    space: options.space ?? { totalBytes: 20 * 1024 ** 4, usedBytes: 1 * 1024 ** 4 },
  };
}

describe("MultiDriveStorageV2 — lazy per-drive staging, brand/storageId routing, and hard space gate (C4)", () => {
  it("lazily creates staging and season directories only on the drive that actually receives transfers", async () => {
    const sim115 = new Storage115Simulator({
      packs: { c115: { files: [{ path: "Show.S01E01.mkv", sizeBytes: 1000 }] } },
    });
    const sim123 = new Storage115Simulator({
      packs: { c123: { files: [{ path: "Show.S01E02.mkv", sizeBytes: 1000 }] } },
    });
    const simUc = new Storage115Simulator({ packs: {} });

    const created115: string[] = [];
    const created123: string[] = [];
    const createdUc: string[] = [];

    const drive115 = makeDrive({ storageId: "cs_115", provider: "pan115", label: "115 网盘", sim: sim115, createdDirs: created115 });
    const drive123 = makeDrive({ storageId: "cs_123", provider: "pan123", label: "123网盘", sim: sim123, createdDirs: created123 });
    const driveUc = makeDrive({ storageId: "cs_uc", provider: "uc", label: "UC网盘", sim: simUc, createdDirs: createdUc });

    const coordinator = new MultiDriveStorageV2({
      drives: [drive115, drive123, driveUc],
      target: {
        kind: "tv",
        categoryKey: "tv",
        title: "琅琊榜",
        year: 2015,
        tmdbId: 65756,
        seasons: [1],
        workflowRunId: "run_lazy",
      },
      buildDriveAdapter: (drive) => {
        if (drive.storageId === "cs_115") return sim115;
        if (drive.storageId === "cs_123") return sim123;
        return simUc;
      },
      resolveCandidate: (id) => {
        if (id === "c115") return { url: "https://115.com/s/sw3abcd1234" };
        if (id === "c123") return { url: "https://www.123pan.com/s/Ab-cD_12" };
        return undefined;
      },
    });

    // Before any transfer: ZERO directories created on any drive.
    expect(created115).toEqual([]);
    expect(created123).toEqual([]);
    expect(createdUc).toEqual([]);

    // Transfer 115 candidate → only 115 creates show + staging; Season 01 not created yet!
    const t1 = await coordinator.transferCandidate({
      candidateId: "c115",
      intoDirectoryId: MULTI_DRIVE_STAGING_HANDLE,
    });
    expect(t1.status).toBe("succeeded");
    expect(created115).toEqual([
      "cs_115:琅琊榜 (2015) {tmdb-65756}",
      "cs_115:staging-run_lazy",
    ]);
    expect(created123).toEqual([]);
    expect(createdUc).toEqual([]);

    // Transfer 123 candidate → 123 lazily creates show + staging; UC still untouched!
    const t2 = await coordinator.transferCandidate({
      candidateId: "c123",
      intoDirectoryId: MULTI_DRIVE_STAGING_HANDLE,
    });
    expect(t2.status).toBe("succeeded");
    expect(created123).toEqual([
      "cs_123:琅琊榜 (2015) {tmdb-65756}",
      "cs_123:staging-run_lazy",
    ]);
    expect(createdUc).toEqual([]);

    // inspectStaging via MULTI_DRIVE_STAGING_HANDLE returns scoped file IDs and clean relative paths.
    const stagingTree = await coordinator.listTree({ directoryId: MULTI_DRIVE_STAGING_HANDLE });
    expect(stagingTree.map((f) => ({ id: f.id, path: f.path }))).toEqual([
      { id: "cs_115::file_3", path: "Show.S01E01.mkv" },
      { id: "cs_123::file_3", path: "Show.S01E02.mkv" },
    ]);

    // Move files to Season 01 → each file moves into its own drive's lazily-created Season 01 dir.
    const moved = await coordinator.moveFiles({
      fileIds: [...t1.materializedFileIds, ...t2.materializedFileIds],
      targetDirectoryId: multiDriveSeasonHandle(1),
    });
    expect(moved.moved.length).toBe(2);
    expect(created115).toContain("cs_115:Season 01");
    expect(created123).toContain("cs_123:Season 01");
    expect(createdUc).toEqual([]);
  });

  it("enforces the hard space gate: refuses over-quota drives (negative remaining) and oversized candidates", async () => {
    const simQuark = new Storage115Simulator({
      packs: { cQuark: { files: [{ path: "Ep01.mkv", sizeBytes: 1000 }] } },
    });
    const sim115Small = new Storage115Simulator({
      packs: { cBig115: { files: [{ path: "Remux.mkv", sizeBytes: 50 * 1024 ** 3 }] } },
    });
    const sim115Large = new Storage115Simulator({
      packs: { cBig115: { files: [{ path: "Remux.mkv", sizeBytes: 50 * 1024 ** 3 }] } },
    });

    const createdQuark: string[] = [];
    // Quark over-quota (-1368 GB), like production.
    const driveQuark = makeDrive({
      storageId: "cs_quark",
      provider: "quark",
      label: "夸克网盘",
      sim: simQuark,
      createdDirs: createdQuark,
      space: { totalBytes: 10 * 1024 ** 3, usedBytes: 1378 * 1024 ** 3 },
    });
    // First 115 drive has only 5 GB left; second 115 drive has 20 TB left.
    const drive115Small = makeDrive({
      storageId: "cs_115_small",
      provider: "pan115",
      label: "115 网盘（小号）",
      sim: sim115Small,
      space: { totalBytes: 15 * 1024 ** 3, usedBytes: 10 * 1024 ** 3 },
    });
    const drive115Large = makeDrive({
      storageId: "cs_115_large",
      provider: "pan115",
      label: "115 网盘（大号）",
      sim: sim115Large,
      space: { totalBytes: 40 * 1024 ** 4, usedBytes: 20 * 1024 ** 4 },
    });

    const coordinator = new MultiDriveStorageV2({
      drives: [driveQuark, drive115Small, drive115Large],
      target: {
        kind: "tv",
        categoryKey: "tv",
        title: "三体",
        year: 2023,
        tmdbId: 12345,
        seasons: [1],
        workflowRunId: "run_space",
      },
      buildDriveAdapter: (drive) => {
        if (drive.storageId === "cs_quark") return simQuark;
        if (drive.storageId === "cs_115_small") return sim115Small;
        return sim115Large;
      },
      resolveCandidate: (id) => {
        if (id === "cQuark") return { url: "https://pan.quark.cn/s/1a2B3c4D" };
        if (id === "cBig115") return { url: "https://115.com/s/sw3abcd1234", sizeBytes: 50 * 1024 ** 3 };
        return undefined;
      },
    });

    // Quark is over-quota → hard rejection before any directory is created!
    await expect(
      coordinator.transferCandidate({
        candidateId: "cQuark",
        intoDirectoryId: MULTI_DRIVE_STAGING_HANDLE,
      }),
    ).rejects.toThrow(/SANDBOX_DRIVE_OUT_OF_SPACE.*夸克网盘/);
    expect(createdQuark).toEqual([]);

    // Explicit transfer of 50 GB pack onto the 5 GB 115 drive → hard rejection!
    await expect(
      coordinator.transferCandidate({
        candidateId: "cBig115",
        intoDirectoryId: MULTI_DRIVE_STAGING_HANDLE,
        storageId: "cs_115_small",
      }),
    ).rejects.toThrow(/SANDBOX_DRIVE_OUT_OF_SPACE.*115 网盘（小号）/);

    // Auto-routed transfer of 50 GB pack skips the 5 GB 115 drive and lands on the 20 TB 115 drive!
    const landed = await coordinator.transferCandidate({
      candidateId: "cBig115",
      intoDirectoryId: MULTI_DRIVE_STAGING_HANDLE,
    });
    expect(landed.status).toBe("succeeded");
    expect(coordinator.driveOfFile(landed.materializedFileIds[0]!)).toBe("cs_115_large");
  });

  it("protects unmovedFileIds per drive during cleanupMaterializedStagings", async () => {
    const sim115 = new Storage115Simulator({
      packs: { c115: { files: [{ path: "Ep01.mkv", sizeBytes: 1000 }] } },
    });
    const sim123 = new Storage115Simulator({
      packs: { c123: { files: [{ path: "Ep02.mkv", sizeBytes: 1000 }] } },
    });
    const removed115: string[] = [];
    const removed123: string[] = [];

    const drive115 = makeDrive({ storageId: "cs_115", provider: "pan115", label: "115", sim: sim115, removedDirs: removed115 });
    const drive123 = makeDrive({ storageId: "cs_123", provider: "pan123", label: "123", sim: sim123, removedDirs: removed123 });

    const coordinator = new MultiDriveStorageV2({
      drives: [drive115, drive123],
      target: {
        kind: "tv",
        categoryKey: "tv",
        title: "狂飙",
        year: 2023,
        tmdbId: 999,
        seasons: [1],
        workflowRunId: "run_cleanup",
      },
      buildDriveAdapter: (d) => (d.storageId === "cs_115" ? sim115 : sim123),
      resolveCandidate: (id) =>
        id === "c115"
          ? { url: "https://115.com/s/sw3abcd1234" }
          : { url: "https://www.123pan.com/s/Ab-cD_12" },
    });

    const t1 = await coordinator.transferCandidate({
      candidateId: "c115",
      intoDirectoryId: MULTI_DRIVE_STAGING_HANDLE,
    });
    const t2 = await coordinator.transferCandidate({
      candidateId: "c123",
      intoDirectoryId: MULTI_DRIVE_STAGING_HANDLE,
    });

    // Suppose 115's file failed to move (in unmovedFileIds), while 123's file moved cleanly.
    const keptEvents: Array<{ stagingDirectoryId: string; fileCount: number }> = [];
    await coordinator.cleanupMaterializedStagings({
      unmovedFileIds: new Set(t1.materializedFileIds),
      onLeak: () => {},
      onCleanupUnverified: () => {},
      onKept: (e) => keptEvents.push(e),
    });

    // 115 staging was KEPT (not removed) because it holds an unmoved file; 123 staging was removed!
    expect(removed115).toEqual([]);
    expect(removed123.length).toBe(1);
    expect(keptEvents.length).toBe(1);
    expect(keptEvents[0]!.fileCount).toBe(1);
    expect(t2.materializedFileIds.length).toBe(1);
  });
});
