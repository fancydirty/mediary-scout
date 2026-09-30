import { describe, expect, it, vi } from "vitest";
import { bindRecoveryDirectories } from "../src/acquisition-v2/directory-lifecycle.js";
import type { Pan123Client, Pan123Item } from "../src/pan123-client.js";
import { Pan123StorageExecutor } from "../src/pan123-storage-executor.js";

/**
 * 123 / 光鸭 / 天翼 check writes against a DERIVED scope: a directory is a write target
 * only if this executor created it or listed it under a scope root (the drive's
 * category dirs). 2026-09-30 production: a staging_recovery on 123 got
 * WRITE_SCOPE_VIOLATION on every delete — it adopted the janitor's show and staging
 * ids without walking down to them from a category, so the leftover was never cleaned.
 */
const folder = (id: string, name: string): Pan123Item => ({ id, name, size: 0, etag: "", isFolder: true });

function drive(): Record<string, Pan123Item[]> {
  return {
    tv: [folder("show-other", "Other (2020)")],
    anime: [folder("show", "黄泉使者 (2026) {tmdb-260463}")],
    show: [folder("season", "Season 01"), folder("staging", "staging-3f1c")],
    season: [],
    staging: [],
  };
}

function executorOver(dirs: Record<string, Pan123Item[]>) {
  const trash = vi.fn(async () => {});
  const moveFiles = vi.fn(async () => {});
  const listFiles = vi.fn(async (id: string) => dirs[id] ?? []);
  const client = {
    listFiles,
    createFolder: vi.fn(async () => "created"),
    trash,
    moveFiles,
  };
  const executor = new Pan123StorageExecutor({
    client: client as unknown as Pan123Client,
    writeScopeDirectoryIds: ["tv", "anime"],
    sleep: async () => {},
  });
  return { executor, trash, moveFiles, listFiles };
}

const target = { showDirectoryId: "show", stagingDirectoryId: "staging", seasons: [1], categoryDirectoryIds: ["tv", "anime"] };

describe("bindRecoveryDirectories on a derived-scope drive (123)", () => {
  it("walks down from the category so the leftover staging dir can be removed", async () => {
    const { executor, trash } = executorOver(drive());

    const dirs = await bindRecoveryDirectories({ executor, ...target });

    expect(dirs).toMatchObject({ showDirectoryId: "show", stagingDirectoryId: "staging", seasonDirectoryIds: { 1: "season" } });
    await expect(executor.removeDirectory("staging")).resolves.toEqual({ removed: true });
    expect(trash).toHaveBeenCalledWith([{ id: "staging", isFolder: true }]);
  });

  it("the season directory it found is a move target", async () => {
    const { executor, moveFiles } = executorOver(drive());

    await bindRecoveryDirectories({ executor, ...target });

    await executor.moveFiles({ fileIds: ["f1"], targetDirectoryId: "season" });
    expect(moveFiles).toHaveBeenCalledWith({ fileIds: ["f1"], targetParentId: "season" });
  });

  it("stops at the category that holds the show (123 rate-limits listings)", async () => {
    const dirs = drive();
    dirs.tv = [folder("show", "黄泉使者 (2026) {tmdb-260463}")];
    dirs.anime = [];
    const { executor, listFiles } = executorOver(dirs);

    await bindRecoveryDirectories({ executor, ...target });

    expect(listFiles.mock.calls.map(([id]) => id)).toEqual(["tv", "show"]);
  });

  it("a show folder no longer under any category stops the recovery before the agent runs", async () => {
    const dirs = drive();
    dirs.anime = []; // moved away after the janitor saw it
    const { executor, trash, listFiles } = executorOver(dirs);

    await expect(bindRecoveryDirectories({ executor, ...target })).rejects.toThrow(/STAGING_RECOVERY_UNREACHABLE/);

    // The show was not listed, so nothing under it became writable.
    expect(listFiles.mock.calls.map(([id]) => id)).toEqual(["tv", "anime"]);
    await expect(executor.removeDirectory("staging")).rejects.toThrow(/WRITE_SCOPE_VIOLATION/);
    expect(trash).not.toHaveBeenCalled();
  });

  it("a staging dir no longer under the show stops the recovery before the agent runs", async () => {
    const dirs = drive();
    dirs.show = [folder("season", "Season 01")]; // the leftover is gone
    const { executor } = executorOver(dirs);

    await expect(bindRecoveryDirectories({ executor, ...target })).rejects.toThrow(/STAGING_RECOVERY_UNREACHABLE/);
  });
});
