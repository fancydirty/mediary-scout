import { describe, expect, it } from "vitest";
import {
  ensureMediaLibraryDirectory,
  legacyMediaLibraryFolderName,
  mediaLibraryFolderName,
} from "../src/media-library-folder.js";
import { FakeStorageExecutor } from "../src/fakes.js";

describe("mediaLibraryFolderName", () => {
  it("formats Title (Year) {tmdb-id}", () => {
    expect(mediaLibraryFolderName({ title: "2001太空漫游", year: 1968, tmdbId: 62 })).toBe(
      "2001太空漫游 (1968) {tmdb-62}",
    );
  });

  it("falls back year to em-dash when missing or zero", () => {
    expect(mediaLibraryFolderName({ title: "X", year: null, tmdbId: 1 })).toBe("X (—) {tmdb-1}");
    expect(mediaLibraryFolderName({ title: "X", year: 0, tmdbId: 1 })).toBe("X (—) {tmdb-1}");
    expect(legacyMediaLibraryFolderName({ title: "X", year: undefined })).toBe("X (—)");
  });
});

describe("ensureMediaLibraryDirectory", () => {
  it("creates the new-format name when parent is empty", async () => {
    const executor = new FakeStorageExecutor();
    const id = await ensureMediaLibraryDirectory({
      executor,
      parentId: "movies_root",
      title: "盗梦空间",
      year: 2010,
      tmdbId: 27205,
    });
    const kids = await executor.listChildDirectories("movies_root");
    expect(kids).toEqual([{ id, name: "盗梦空间 (2010) {tmdb-27205}" }]);
  });

  it("reuses legacy Title (Year) without creating a duplicate", async () => {
    const executor = new FakeStorageExecutor();
    const legacyId = await executor.createDirectory({
      name: "盗梦空间 (2010)",
      parentId: "movies_root",
    });
    const id = await ensureMediaLibraryDirectory({
      executor,
      parentId: "movies_root",
      title: "盗梦空间",
      year: 2010,
      tmdbId: 27205,
    });
    expect(id).toBe(legacyId);
    const kids = await executor.listChildDirectories("movies_root");
    expect(kids).toHaveLength(1);
    expect(kids[0]!.name).toBe("盗梦空间 (2010)");
  });

  it("prefers the new-format name when both could exist", async () => {
    const executor = new FakeStorageExecutor();
    await executor.createDirectory({ name: "Show (2024)", parentId: "tv_root" });
    const preferredId = await executor.createDirectory({
      name: "Show (2024) {tmdb-99}",
      parentId: "tv_root",
    });
    const id = await ensureMediaLibraryDirectory({
      executor,
      parentId: "tv_root",
      title: "Show",
      year: 2024,
      tmdbId: 99,
    });
    expect(id).toBe(preferredId);
  });
});
