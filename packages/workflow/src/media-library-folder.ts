import type { StorageExecutor } from "./ports.js";

function folderYear(year: number | string | null | undefined): string {
  if (year === null || year === undefined || year === "" || year === 0 || year === "0") {
    return "—";
  }
  return String(year);
}

/** Canonical cloud folder name for a title root under Movies/TV/Anime. */
export function mediaLibraryFolderName(input: {
  title: string;
  year: number | string | null | undefined;
  tmdbId: number;
}): string {
  return `${input.title} (${folderYear(input.year)}) {tmdb-${input.tmdbId}}`;
}

/** The `{tmdb-N}` suffix of a new-style folder, or null for a legacy name. */
export function tmdbIdFromMediaLibraryFolderName(name: string): number | null {
  const match = /\{tmdb-(\d+)\}$/.exec(name.trim());
  if (!match?.[1]) return null;
  const tmdbId = Number(match[1]);
  return Number.isSafeInteger(tmdbId) ? tmdbId : null;
}

/** Pre-tmdb-suffix name. Kept so existing pan folders are reused, not duplicated. */
export function legacyMediaLibraryFolderName(input: {
  title: string;
  year: number | string | null | undefined;
}): string {
  return `${input.title} (${folderYear(input.year)})`;
}

/**
 * Find-or-create the title root under a category parent.
 * Prefer the new `{tmdb-N}` name; if only the legacy `Title (Year)` exists, reuse it
 * (do not auto-rename this round).
 */
export async function findExistingMediaLibraryDirectory(input: {
  executor: Pick<StorageExecutor, "listChildDirectories">;
  parentId: string;
  title: string;
  year: number | string | null | undefined;
  tmdbId: number;
}): Promise<string | null> {
  const preferred = mediaLibraryFolderName({
    title: input.title,
    year: input.year,
    tmdbId: input.tmdbId,
  });
  const legacy = legacyMediaLibraryFolderName({ title: input.title, year: input.year });

  const children = await input.executor.listChildDirectories(input.parentId);
  const hitPreferred = children.find((child) => child.name === preferred);
  if (hitPreferred) return hitPreferred.id;
  const hitLegacy = children.find((child) => child.name === legacy);
  if (hitLegacy) return hitLegacy.id;
  return null;
}

export async function ensureMediaLibraryDirectory(input: {
  executor: Pick<StorageExecutor, "createDirectory" | "listChildDirectories">;
  parentId: string;
  title: string;
  year: number | string | null | undefined;
  tmdbId: number;
}): Promise<string> {
  const existing = await findExistingMediaLibraryDirectory(input);
  if (existing) return existing;
  const preferred = mediaLibraryFolderName({
    title: input.title,
    year: input.year,
    tmdbId: input.tmdbId,
  });
  return input.executor.createDirectory({ name: preferred, parentId: input.parentId });
}
