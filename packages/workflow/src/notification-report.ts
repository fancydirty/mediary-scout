import { episodeNumberFromCode } from "./domain.js";
import type {
  EpisodeState,
  MediaType,
  NotificationEvent,
  NotificationReport,
  NotificationReportStatus,
  TrackedSeason,
} from "./domain.js";

/** "S01E13" -> "E13". The season is already in the card's title row. */
function shortCode(code: string): string {
  return code.replace(/^S\d+/, "");
}

function seasonLabel(seasonNumber: number): string {
  return `第 ${seasonNumber} 季`;
}

/** [1,2,3,5] -> "1–3、5". Consecutive runs collapse to a dashed range. */
function formatSeasonRange(seasons: number[]): string {
  const sorted = [...seasons].sort((a, b) => a - b);
  if (sorted.length === 0) {
    return "";
  }
  const groups: string[] = [];
  let start = sorted[0]!;
  let prev = sorted[0]!;
  for (let index = 1; index <= sorted.length; index += 1) {
    const current = sorted[index];
    if (current !== undefined && current === prev + 1) {
      prev = current;
      continue;
    }
    groups.push(start === prev ? `${start}` : `${start}–${prev}`);
    if (current !== undefined) {
      start = current;
      prev = current;
    }
  }
  return groups.join("、");
}

interface SeasonFacts {
  realMissing: string[]; // aired-but-not-obtained, short codes
  seasonFinished: boolean;
  fullyObtained: boolean;
  /** Highest obtained episode number (may exceed the aired cursor → provider-ahead). */
  maxObtainedEpisode: number;
  /** A resource ran ahead of TMDB: we hold episodes past the latest-aired cursor. */
  providerAhead: boolean;
}

function seasonFacts(season: TrackedSeason, episodes: EpisodeState[]): SeasonFacts {
  const aired = episodes.filter((episode) => episode.airStatus === "aired");
  const realMissing = aired.filter((episode) => !episode.obtained).map((episode) => shortCode(episode.episodeCode));
  const obtained = episodes.filter((episode) => episode.obtained);
  const seasonFinished = season.latestAiredEpisode >= season.totalEpisodes;
  const fullyObtained = seasonFinished && realMissing.length === 0 && obtained.length >= season.totalEpisodes;
  const maxObtainedEpisode = obtained.reduce(
    (max, episode) => Math.max(max, episodeNumberFromCode(episode.episodeCode)),
    0,
  );
  const providerAhead = maxObtainedEpisode > season.latestAiredEpisode;
  return { realMissing, seasonFinished, fullyObtained, maxObtainedEpisode, providerAhead };
}

export interface SeasonReportInput {
  titleName: string;
  season: TrackedSeason;
  episodes: EpisodeState[];
  /** Episodes obtained THIS run worth chipping (daily delta). Empty for first-time hauls. */
  newlyObtained?: string[];
  /** Force the no-coverage shape regardless of episode facts. */
  noCoverage?: boolean;
  /** Dominant quality of the landed files (e.g. "2160p"), surfaced in pushes. */
  quality?: string;
  /** Poster/tmdbId/year for richer pushes. */
  meta?: NotificationTitleMeta;
}

/**
 * Single-season report. Never lists unaired episodes as missing — `realMissing`
 * is exactly the aired-but-not-obtained set, so a season waiting on unaired
 * episodes reads as a clean "airing", not as a perpetual gap.
 */
export function buildSeasonReport(input: SeasonReportInput): NotificationReport {
  const { realMissing, fullyObtained, maxObtainedEpisode, providerAhead } = seasonFacts(
    input.season,
    input.episodes,
  );
  const newlyObtained = (input.newlyObtained ?? []).map(shortCode);
  const label = seasonLabel(input.season.seasonNumber);

  if (input.noCoverage) {
    return {
      titleName: input.titleName,
      seasonLabel: label,
      status: "no_coverage",
      lines: ["暂未找到可用资源 · 将持续尝试"],
      newlyObtained: [],
      realMissing,
      ...(input.meta ?? {}),
    };
  }

  let status: NotificationReportStatus;
  let lines: string[];
  if (fullyObtained) {
    status = "complete";
    lines = [`全 ${input.season.totalEpisodes} 集已完整获取，不再追踪`];
  } else if (realMissing.length > 0) {
    status = "partial";
    lines = newlyObtained.length > 0 ? ["本次有新增，仍有已播集数待补"] : ["已获取部分已播集，仍有缺集待补"];
  } else if (providerAhead) {
    // 资源超前: a full/ahead-of-schedule resource landed episodes past TMDB's
    // latest-aired cursor. Report what we actually hold, not the aired count.
    status = "airing";
    lines = [`已获取至第 ${maxObtainedEpisode} 集 · 资源超前于已播，后续更新自动追踪`];
  } else {
    status = "airing";
    lines =
      newlyObtained.length > 0
        ? ["已获取至最新 · 后续更新自动追踪"]
        : [`已获取至最新第 ${input.season.latestAiredEpisode} 集 · 后续更新自动追踪`];
  }

  return {
    titleName: input.titleName,
    seasonLabel: label,
    status,
    lines,
    newlyObtained,
    realMissing,
    ...(input.quality ? { quality: input.quality } : {}),
    ...(input.meta ?? {}),
  };
}

export interface SeriesReportSeasonInput {
  season: TrackedSeason;
  episodes: EpisodeState[];
}

/**
 * Multi-season "get everything" rollup: completed seasons collapse to a range,
 * still-airing seasons each get a "已获取至最新第 N 集 · 后续自动追踪" line, and
 * seasons with genuine aired gaps name the gap.
 */
export function buildSeriesReport(input: {
  titleName: string;
  seasons: SeriesReportSeasonInput[];
  noCoverage?: boolean;
  meta?: NotificationTitleMeta;
}): NotificationReport {
  if (input.noCoverage) {
    return {
      titleName: input.titleName,
      seasonLabel: null,
      status: "no_coverage",
      lines: ["暂未找到可用资源 · 将持续尝试"],
      newlyObtained: [],
      realMissing: [],
      ...(input.meta ?? {}),
    };
  }

  const complete: number[] = [];
  const airing: { seasonNumber: number; latestAired: number }[] = [];
  const partial: { seasonNumber: number; missing: string[] }[] = [];
  for (const entry of input.seasons) {
    const facts = seasonFacts(entry.season, entry.episodes);
    if (facts.fullyObtained) {
      complete.push(entry.season.seasonNumber);
    } else if (facts.realMissing.length > 0) {
      partial.push({ seasonNumber: entry.season.seasonNumber, missing: facts.realMissing });
    } else {
      airing.push({ seasonNumber: entry.season.seasonNumber, latestAired: entry.season.latestAiredEpisode });
    }
  }

  const lines: string[] = [];
  if (complete.length > 0) {
    const isContiguousFromOne =
      airing.length === 0 &&
      partial.length === 0 &&
      complete.length === Math.max(...complete) &&
      Math.min(...complete) === 1;
    lines.push(
      isContiguousFromOne
        ? `全 ${complete.length} 季已完整获取`
        : `第 ${formatSeasonRange(complete)} 季已完整获取`,
    );
  }
  for (const entry of airing) {
    lines.push(`第 ${entry.seasonNumber} 季 · 已获取至最新第 ${entry.latestAired} 集 · 后续自动追踪`);
  }
  for (const entry of partial) {
    lines.push(`第 ${entry.seasonNumber} 季 · 仍缺 ${entry.missing.join("、")} 待后续获取`);
  }

  const status: NotificationReportStatus =
    airing.length === 0 && partial.length === 0 ? "complete" : partial.length > 0 ? "partial" : "airing";

  return {
    titleName: input.titleName,
    seasonLabel: null,
    status,
    lines,
    newlyObtained: [],
    realMissing: partial.flatMap((entry) => entry.missing),
    ...(input.meta ?? {}),
  };
}

/** Title metadata for richer pushes (poster image + tap-through link). */
export interface NotificationTitleMeta {
  posterPath?: string | null;
  tmdbId?: number;
  mediaType?: MediaType;
  year?: number;
}

/** Movie / one-off: nothing to track, just acquired. */
export function buildMovieReport(titleName: string, quality?: string, meta?: NotificationTitleMeta): NotificationReport {
  return {
    titleName,
    seasonLabel: null,
    status: "acquired",
    lines: ["已获取入库"],
    newlyObtained: [],
    realMissing: [],
    ...(quality ? { quality } : {}),
    ...(meta ?? {}),
  };
}

const STATUS_EMOJI: Record<NotificationReportStatus, string> = {
  complete: "🎉",
  acquired: "✅",
  airing: "📈",
  partial: "🟡",
  no_coverage: "🔍",
};

/**
 * Plain-text rendering of a report for push channels (Bark/Server酱/企微/webhook).
 * Same data the web feed renders as chips, decorated with emoji for chat-style
 * surfaces.
 */
export function formatReportPushText(report: NotificationReport): string {
  const head = report.seasonLabel ? `${report.titleName} ${report.seasonLabel}` : report.titleName;
  const parts: string[] = [`📺 ${head}`, ""];
  for (const line of report.lines) {
    parts.push(`${STATUS_EMOJI[report.status]} ${line}`);
  }
  if (report.newlyObtained.length > 0) {
    parts.push(`✅ 本次新增：${report.newlyObtained.join("、")}`);
  }
  if (report.realMissing.length > 0) {
    parts.push(`🔴 缺集：${report.realMissing.join("、")}`);
  }
  if (report.quality) {
    parts.push(`🎞 画质：${report.quality}`);
  }
  return parts.join("\n");
}

/**
 * The dominant quality across landed files, for notifications. Picks the
 * highest tier present (4K/2160p > 1080p > 720p …); empty when none is stated.
 */
export function dominantQuality(fileNames: string[]): string | undefined {
  const tiers = [
    { label: "2160p", re: /\b(2160p|4k|uhd)\b/i },
    { label: "1080p", re: /\b1080p\b/i },
    { label: "720p", re: /\b720p\b/i },
    { label: "480p", re: /\b480p\b/i },
  ];
  for (const tier of tiers) {
    if (fileNames.some((name) => tier.re.test(name))) {
      return tier.label;
    }
  }
  return undefined;
}

/** {@link dominantQuality} over file records — the common workflow case, so the
 *  callers don't each repeat `files.map((f) => f.name)`. */
export function dominantQualityOfFiles(files: { name: string }[]): string | undefined {
  return dominantQuality(files.map((file) => file.name));
}

/**
 * One consolidated digest for a whole scheduled sweep, so a daily routine
 * pushes a single message instead of one per show. Shows that changed get a
 * detail line; shows checked with nothing to do collapse into a tail count.
 */
export function formatDailyDigestPushText(notifications: NotificationEvent[]): string {
  const withReport = notifications.filter((notification) => notification.report !== undefined);
  const changed = withReport.filter((notification) => notification.kind !== "already_current");
  const unchanged = withReport.length - changed.length;

  const lines: string[] = ["📺 每日巡检", ""];
  if (changed.length === 0) {
    lines.push(`本次巡检无更新，已检查 ${withReport.length} 部追踪剧集。`);
    return lines.join("\n");
  }

  for (const notification of changed) {
    const report = notification.report;
    if (report === undefined) {
      continue;
    }
    const head = report.seasonLabel ? `${report.titleName} ${report.seasonLabel}` : report.titleName;
    const quality = report.quality ? ` · ${report.quality}` : "";
    let detail: string;
    if (notification.kind === "tracking_completed") {
      // Even a finale should say WHICH episodes were the last to land + quality,
      // so a single push carries real information, not just "追完".
      const gained = report.newlyObtained.length > 0 ? `（补齐 ${report.newlyObtained.join("、")}）` : "";
      detail = `🎉 追完，全部获取${gained}${quality}`;
    } else {
      const segments: string[] = [];
      if (report.newlyObtained.length > 0) {
        segments.push(`新增 ${report.newlyObtained.join("、")}${quality}`);
      }
      if (report.realMissing.length > 0) {
        segments.push(`缺 ${report.realMissing.join("、")}`);
      }
      detail = segments.join(" · ") || "已更新";
    }
    lines.push(`· ${head} — ${detail}`);
  }

  if (unchanged > 0) {
    // Name the shows checked-with-nothing-to-do, don't just count them.
    const names = withReport
      .filter((notification) => notification.kind === "already_current")
      .map((notification) => notification.report?.titleName)
      .filter((name): name is string => Boolean(name));
    lines.push("");
    lines.push(
      names.length > 0 ? `其余已是最新：${names.join("、")}` : `其余 ${unchanged} 部已是最新。`,
    );
  }
  return lines.join("\n");
}
