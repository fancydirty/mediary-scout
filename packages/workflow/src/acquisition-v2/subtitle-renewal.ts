export interface IndexedSubtitleFile {
  key: string;
  filename: string;
  url: string;
}

/** Assign a stable occurrence key so duplicate filenames remain distinct across detail refreshes. */
export function indexSubtitleFiles(files: Array<{ filename: string; url: string }>): IndexedSubtitleFile[] {
  const occurrences = new Map<string, number>();
  return files.map((file) => {
    const occurrence = occurrences.get(file.filename) ?? 0;
    occurrences.set(file.filename, occurrence + 1);
    return { ...file, key: `${file.filename.replaceAll("#", "##")}#${occurrence}` };
  });
}

/** Select the next pending chunk using only the freshly minted URLs. */
export function selectSubtitleChunk(
  initial: IndexedSubtitleFile[],
  refreshed: IndexedSubtitleFile[],
  pending: ReadonlySet<string>,
  chunkSize: number,
): { selected: IndexedSubtitleFile[]; missing: string[] } {
  const size = Math.max(1, Math.floor(chunkSize));
  const refreshedByKey = new Map(refreshed.map((file) => [file.key, file]));
  const pendingFiles = initial.filter((file) => pending.has(file.key));
  const selectedKeys = new Set<string>();
  const selectedNames = new Set<string>();
  for (const original of pendingFiles) {
    if (selectedKeys.size >= size) break;
    if (selectedNames.has(original.filename)) continue;
    selectedKeys.add(original.key);
    selectedNames.add(original.filename);
  }
  const selected: IndexedSubtitleFile[] = [];
  const missing: string[] = [];
  for (const original of pendingFiles) {
    if (!selectedKeys.has(original.key)) continue;
    const fresh = refreshedByKey.get(original.key);
    if (fresh) selected.push(fresh);
    else missing.push(original.key);
  }
  return { selected, missing };
}
