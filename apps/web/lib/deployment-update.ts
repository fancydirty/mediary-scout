const COMMIT_RE = /^[0-9a-f]{40}$/i;

export function normalizeCommit(value: string | null | undefined): string | null {
  const commit = value?.trim().toLowerCase() ?? "";
  return COMMIT_RE.test(commit) ? commit : null;
}

export function shortCommit(commit: string | null): string | null {
  return commit ? commit.slice(0, 7) : null;
}
