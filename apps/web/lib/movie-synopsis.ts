/** Overview longer than this (CJK-friendly char count) gets a collapse control. */
export const MOVIE_SYNOPSIS_COLLAPSE_AT = 280;

export function shouldCollapseMovieSynopsis(overview: string): boolean {
  return overview.trim().length > MOVIE_SYNOPSIS_COLLAPSE_AT;
}

export function collapseMovieSynopsis(overview: string): string {
  const text = overview.trim();
  if (text.length <= MOVIE_SYNOPSIS_COLLAPSE_AT) return text;
  return `${text.slice(0, MOVIE_SYNOPSIS_COLLAPSE_AT).trimEnd()}…`;
}
