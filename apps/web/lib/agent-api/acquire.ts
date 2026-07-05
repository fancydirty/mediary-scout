import { createTmdbSearchProvider, type MediaSearchProvider } from "@media-track/workflow";
import { getTmdbAccesses, getAccountScopedSettings, queueCandidateTracking } from "../workflow-runtime";

export interface AcquireInput {
  query: string;
  type?: "tv" | "movie" | null;
  season?: number | null;
  storageId?: string | null;
  tmdbId?: number | null;
}

export interface AcquireResult {
  status: "requested" | "already_tracked" | "reserved" | "ambiguous" | "not_found" | "unsupported";
  matched?: { tmdbId: number; title: string; year: number | null; type: "tv" | "movie" };
  candidates?: Array<{ tmdbId: number; title: string; year: number | null; type: "tv" | "movie"; score: number }>;
  message: string;
  workflowRunId?: string | null;
  trackedSeasonId?: string;
}

/**
 * Agent "帮我找 XX" entrypoint: query → TMDB search → score candidates →
 * single best match → queue, or multiple high scores → 409 candidates.
 */
export async function acquireMedia(input: AcquireInput, accountId: string): Promise<AcquireResult> {
  if (input.tmdbId) {
    return queueByTmdbId(input.tmdbId, input.type ?? "tv", input.season, input.storageId);
  }

  const provider = await getTmdbSearchProvider(accountId);
  const results = await provider.searchMedia({ query: input.query });

  if (results.length === 0) {
    return { status: "not_found", message: `TMDB 没搜到「${input.query}」的结果，换个关键词试试。` };
  }

  const filtered = input.type ? results.filter((r) => r.mediaType === input.type) : results;
  if (filtered.length === 0) {
    return {
      status: "not_found",
      message: `没找到类型为 ${input.type} 的「${input.query}」结果。`,
    };
  }

  const queryNorm = input.query.trim().toLowerCase();
  const currentYear = new Date().getFullYear();
  const scored = filtered.map((result, index) => {
    // TMDB returns popularity-ordered results; earlier rank = higher base score.
    let score = Math.max(0, 50 - index * 10);
    const titleNorm = result.title.toLowerCase();
    const originalNorm = result.originalTitle?.toLowerCase() ?? "";
    if (titleNorm === queryNorm || originalNorm === queryNorm) {
      score += 100;
    } else if (titleNorm.includes(queryNorm) || queryNorm.includes(titleNorm)) {
      score += 50;
    }
    if (result.year && result.year >= currentYear - 2) {
      score += 10;
    }
    return { candidate: result, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored[0]!;
  const second = scored[1];

  const isAmbiguous = second !== undefined && top.score > 0 && second.score / top.score > 0.7;

  if (isAmbiguous) {
    return {
      status: "ambiguous",
      message: `「${input.query}」有多个高分匹配，请让用户选择后带 tmdbId 重发请求。`,
      candidates: scored.slice(0, 5).map(({ candidate, score }) => ({
        tmdbId: candidate.tmdbId,
        title: candidate.title,
        year: candidate.year,
        type: candidate.mediaType,
        score: Math.round(score),
      })),
    };
  }

  return queueByTmdbId(top.candidate.tmdbId, top.candidate.mediaType, input.season, input.storageId, {
    title: top.candidate.title,
    year: top.candidate.year,
  });
}

async function queueByTmdbId(
  tmdbId: number,
  type: "tv" | "movie",
  season: number | null | undefined,
  storageId: string | null | undefined,
  matchedTitle?: { title: string; year: number | null },
): Promise<AcquireResult> {
  // candidateId formats from workflow-runtime.ts parsers:
  //   movie: tmdb_movie_<tmdbId>   (parseMovieCandidateId)
  //   tv:    tmdb_tv_<tmdbId>_s<n> (parseTvCandidateId)
  const candidateId =
    type === "movie" ? `tmdb_movie_${tmdbId}` : `tmdb_tv_${tmdbId}_s${season ?? 1}`;

  const result = await queueCandidateTracking(candidateId, storageId ?? undefined);

  const matched = {
    tmdbId,
    title: matchedTitle?.title ?? "",
    year: matchedTitle?.year ?? null,
    type,
  };

  if (result.status === "unsupported") {
    return { status: "unsupported", message: result.message ?? "不支持的获取目标。", matched };
  }
  if (result.status === "already_tracked") {
    return { status: "already_tracked", message: "已在追踪，后台会继续按缺集状态检查。", matched };
  }
  if (result.status === "queued") {
    return {
      status: "requested",
      message: "已加入后台队列，完成后会通知你。",
      matched,
      workflowRunId: result.workflowRunId,
      trackedSeasonId: result.trackedSeasonId,
    };
  }
  return { status: "requested", message: "获取任务已在运行中，不会重复创建。", matched };
}

async function getTmdbSearchProvider(accountId: string): Promise<MediaSearchProvider> {
  const settings = getAccountScopedSettings(accountId);
  const accesses = await getTmdbAccesses(settings);
  return createTmdbSearchProvider(accesses);
}
