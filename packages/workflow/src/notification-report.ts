import { episodeNumberFromCode } from "./domain.js";
import type {
  EpisodeState,
  MediaType,
  NotificationEvent,
  NotificationReport,
  NotificationReportStatus,
  NotificationTrigger,
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
  /** When nothing landed because transfers were systemically BLOCKED (115 云下载
   *  配额不足 / 登录过期 / 非 VIP), the honest report is "转存失败:<reason>" with
   *  status `failed` — NOT "暂未找到资源" (the resource exists; the account is
   *  blocked). Only meaningful together with noCoverage. See classifyTransferBlock. */
  transferBlockReason?: string | null;
  /** 搜索源本轮全程故障时的原因(见 classifySearchSourceFault)。与
   *  transferBlockReason 同一形制:只在 noCoverage 时有意义,存在则覆盖
   *  「暂未找到可用资源」——源连不上不等于这部片子没有资源(别甩锅)。 */
  searchSourceFaultReason?: string | null;
  /** Real landed video files: count + summed bytes. The card/push show the true
   *  per-episode size from these (总字节 / 文件数), not a claimed quality tag. */
  fileCount?: number;
  totalBytes?: number;
  /** Poster/tmdbId/year for richer pushes. */
  meta?: NotificationTitleMeta;
}

/** Only attach size facts when BOTH are present — a half-known size is omitted,
 *  never guessed (mirrors how an absent quality used to drop the line). */
function sizeFields(input: { fileCount?: number; totalBytes?: number }): {
  fileCount?: number;
  totalBytes?: number;
} {
  return input.fileCount !== undefined && input.totalBytes !== undefined
    ? { fileCount: input.fileCount, totalBytes: input.totalBytes }
    : {};
}

/** The status+lines for a run that obtained nothing. Default = no_coverage
 *  ("暂未找到资源"); when transfers were systemically blocked, it's an honest
 *  `failed` + the real reason (别甩锅 — the resource exists, the account is blocked).
 *  Shared by the TV bridge and the movie workflow so both report identically. */
export function emptyRunOutcome(
  transferBlockReason?: string | null,
  searchSourceFaultReason?: string | null,
): { status: NotificationReportStatus; lines: string[] } {
  if (transferBlockReason && transferBlockReason.trim()) {
    // 转存受阻优先于搜索源故障:能走到转存说明资源已经找到了,用户手上的问题是
    // 「配额/登录/VIP」这种立刻可动手的事;而搜索源故障那句只会让他去查一个其实
    // 已经工作过的源。给最靠近用户下一步动作的那条。
    return { status: "failed", lines: [`转存失败:${transferBlockReason.trim()}`] };
  }
  if (searchSourceFaultReason && searchSourceFaultReason.trim()) {
    // 别甩锅:源连不上不等于这部片子没有资源。报 failed 而非 no_coverage ——
    // no_coverage 会把它归进「确实没有、继续等」那一桶,而这是系统故障,用户
    // 看一眼就该知道去修配置/等源恢复,而不是以为片源不存在。
    return { status: "failed", lines: [searchSourceFaultReason.trim()] };
  }
  return { status: "no_coverage", lines: ["暂未找到可用资源 · 将持续尝试"] };
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
      ...emptyRunOutcome(input.transferBlockReason, input.searchSourceFaultReason),
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
    ...sizeFields(input),
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
  /** See SeasonReportInput.transferBlockReason — honest 转存失败 when blocked. */
  transferBlockReason?: string | null;
  /** See SeasonReportInput.searchSourceFaultReason — honest 搜索源故障. */
  searchSourceFaultReason?: string | null;
  meta?: NotificationTitleMeta;
  fileCount?: number;
  totalBytes?: number;
}): NotificationReport {
  if (input.noCoverage) {
    return {
      titleName: input.titleName,
      seasonLabel: null,
      ...emptyRunOutcome(input.transferBlockReason, input.searchSourceFaultReason),
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
    ...sizeFields(input),
    ...(input.meta ?? {}),
  };
}

/**
 * The report of a replace_request run (a user asked for a different resource). Never
 * "入库/获取完成": the old files are still there, so the only news is which episodes
 * got a new version and which are still being looked for. No landed size either —
 * the directories now hold old + new files, so a size would double-count.
 */
export function buildReplacementReport(input: {
  titleName: string;
  movie: boolean;
  results: Array<{ episode: string; outcome: "replaced" | "not_found" }>;
  /** Episodes that were plain gaps and landed in the same run (TV only). */
  newlyObtained?: string[];
  transferBlockReason?: string | null;
  searchSourceFaultReason?: string | null;
  meta?: NotificationTitleMeta;
}): NotificationReport {
  const replaced = input.results.filter((r) => r.outcome === "replaced").map((r) => r.episode);
  const pending = input.results.filter((r) => r.outcome === "not_found").map((r) => r.episode);
  // An episode the user asked for that had no old file was a gap before the run, so it
  // also shows up as newly obtained — it is news once, as 换好, never also as 新增.
  const newlyObtained = (input.newlyObtained ?? []).filter((code) => !replaced.includes(code));
  const base = {
    titleName: input.titleName,
    seasonLabel: null,
    newlyObtained,
    realMissing: [],
    ...(input.meta ?? {}),
  };
  if (replaced.length === 0 && newlyObtained.length === 0) {
    // Nothing new landed: an honest block/source-fault reason beats "not found".
    const outcome = emptyRunOutcome(input.transferBlockReason, input.searchSourceFaultReason);
    if (outcome.status === "failed") return { ...base, ...outcome };
    return {
      ...base,
      status: "no_coverage",
      lines: [input.results.length === 0 ? "这次没有换任何文件" : "还没找到可以换的版本 · 巡检时接着找"],
    };
  }
  if (input.movie) {
    return { ...base, status: "replaced", lines: ["已换成新版本"] };
  }
  // "E13" when every episode is in one season (the card names the show); full codes otherwise.
  const seasons = new Set([...replaced, ...pending, ...newlyObtained].map((code) => code.replace(/E\d+$/, "")));
  const label = (codes: string[]) => codes.map((code) => (seasons.size === 1 ? shortCode(code) : code)).join("、");
  const stillLooking = pending.length > 0 ? `${pending.length} 集还在找（${label(pending)}）` : null;
  const added = newlyObtained.length > 0 ? `新增 ${label(newlyObtained)}` : null;
  if (replaced.length === 0) {
    // A work with 待换 episodes is patrolled only through this run, so a newly aired
    // gap lands here: that is news, never "还没找到". Nothing was replaced, though,
    // so the status is the ordinary "new episodes landed" one, not "replaced".
    return { ...base, status: "airing", lines: [added!, ...(stillLooking ? [stillLooking] : [])] };
  }
  const line = `换好 ${replaced.length} 集（${label(replaced)}）` + (stillLooking ? `，${stillLooking}` : "");
  return { ...base, status: "replaced", lines: [line, ...(added ? [added] : [])] };
}

/**
 * How a replace run's notification is pushed, set by who queued it. A run the
 * patrol queued reports into the daily digest (`scheduled`) instead of pushing on
 * its own every sweep; one the user asked for (现在处理, the urgent scan) stays
 * `user`. A patrol re-check of 待换 episodes with no new message that replaced
 * nothing is routine (`already_current`): the notification page folds it into the
 * 例行巡检 card and the digest lists it under 其余已是最新. Failures, actual
 * replacements and newly landed episodes are never downgraded.
 */
export function stampReplaceNotification(
  notification: NotificationEvent,
  notice: { trigger: NotificationTrigger; routineIfNothingReplaced: boolean },
): NotificationEvent {
  const report = notification.report;
  const routine =
    notice.routineIfNothingReplaced && report?.status === "no_coverage" && report.newlyObtained.length === 0;
  return { ...notification, trigger: notice.trigger, ...(routine ? { kind: "already_current" } : {}) };
}

/**
 * The scheduled notifications that make up one digest push. The sweep always
 * sends its digest (even "本次巡检无更新"). A queue drain runs patrol-queued replace
 * runs one by one after the sweep: a digest there that would only say "nothing
 * changed" is skipped, else every such run would push a lone 每日巡检.
 */
export function scheduledDigestItems(
  notifications: NotificationEvent[],
  opts: { skipIfOnlyRoutine: boolean },
): NotificationEvent[] {
  const scheduled = notifications.filter((notification) => notification.trigger === "scheduled");
  if (opts.skipIfOnlyRoutine && scheduled.every((notification) => notification.kind === "already_current")) return [];
  return scheduled;
}

/** Title metadata for richer pushes (poster image + tap-through link). */
export interface NotificationTitleMeta {
  posterPath?: string | null;
  tmdbId?: number;
  mediaType?: MediaType;
  year?: number;
}

/** Movie / one-off: nothing to track, just acquired. */
export function buildMovieReport(
  titleName: string,
  meta?: NotificationTitleMeta,
  size?: { fileCount: number; totalBytes: number },
  /** Movie 中文字幕软兜底: landed a raw-name match without a confirmed 中字 track
   *  (中字 budget exhausted) — surface it so the user can add subs / re-seek. */
  subtitleFallback = false,
): NotificationReport {
  return {
    titleName,
    seasonLabel: null,
    status: "acquired",
    lines: subtitleFallback ? ["已获取入库", "⚠️ 可能无中文字幕(兜底)"] : ["已获取入库"],
    newlyObtained: [],
    realMissing: [],
    ...sizeFields(size ?? {}),
    ...(meta ?? {}),
  };
}

const STATUS_EMOJI: Record<NotificationReportStatus, string> = {
  complete: "🎉",
  acquired: "✅",
  airing: "📈",
  partial: "🟡",
  no_coverage: "🔍",
  failed: "❌",
  retrying: "⚠️",
  replaced: "🔁",
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
  const size = landedSize(report);
  if (size) {
    parts.push(`🎞 ${size.label}：${size.value}`);
  }
  return parts.join("\n");
}

/** Human-readable byte size: KB below 1 MB, whole MB below 1 GB, else GB to one
 *  decimal. Video files are large, so MB/GB is the common case. */
export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  if (mb < 1024) {
    return `${Math.round(mb)} MB`;
  }
  return `${(mb / 1024).toFixed(1)} GB`;
}

/**
 * The size line a card/push should show for a report — the TRUE landed volume,
 * not a claimed quality tag. A movie (status "acquired", one file) shows its
 * total volume; a series shows the real per-episode average (总字节 / 文件数, what
 * exposed "几百 MB 不是 4K"). Undefined when size facts are absent — omit, never
 * guess (the same contract the old quality line used).
 */
export function landedSize(report: NotificationReport): { label: string; value: string } | undefined {
  const { fileCount, totalBytes } = report;
  if (fileCount === undefined || totalBytes === undefined || fileCount <= 0 || totalBytes <= 0) {
    return undefined;
  }
  if (report.status === "acquired") {
    return { label: "体积", value: formatBytes(totalBytes) };
  }
  return { label: "每集", value: `约 ${formatBytes(totalBytes / fileCount)}` };
}

/**
 * One consolidated digest for a whole scheduled sweep, so a daily routine
 * pushes a single message instead of one per show. Shows that changed get a
 * detail line; shows checked with nothing to do collapse into a tail count.
 */
export function formatDailyDigestPushText(
  notifications: NotificationEvent[],
  opts?: { sourceLabelById?: Map<string, string> },
): string {
  const withReport = notifications.filter((notification) => notification.report !== undefined);
  const changed = withReport.filter((notification) => notification.kind !== "already_current");
  const unchanged = withReport.length - changed.length;

  // No "每日巡检" header line: the push's title field already carries it, and a
  // repeated heading rendered a duplicate title under it (same fix as the movie
  // notification). The body is just the per-show list.
  if (changed.length === 0) {
    return `本次巡检无更新，已检查 ${withReport.length} 部追踪剧集。`;
  }

  const lines: string[] = [];
  for (const notification of changed) {
    const report = notification.report;
    if (report === undefined) {
      continue;
    }
    const head = report.seasonLabel ? `${report.titleName} ${report.seasonLabel}` : report.titleName;
    const size = landedSize(report);
    const sizeSuffix = size ? ` · ${size.value}` : "";
    let detail: string;
    if (notification.kind === "tracking_completed") {
      // Even a finale should say WHICH episodes were the last to land + size,
      // so a single push carries real information, not just "追完".
      const gained = report.newlyObtained.length > 0 ? `（补齐 ${report.newlyObtained.join("、")}）` : "";
      detail = `🎉 追完，全部获取${gained}${sizeSuffix}`;
    } else if (report.status === "acquired") {
      // A film the patrol landed has no episodes: its own lines (入库, a 字幕兜底
      // warning) and its size, as its single push would have said.
      detail = `${report.lines.join(" · ")}${sizeSuffix}`;
    } else {
      const segments: string[] = [];
      if (report.newlyObtained.length > 0) {
        segments.push(`新增 ${report.newlyObtained.join("、")}${sizeSuffix}`);
      }
      if (report.realMissing.length > 0) {
        segments.push(`缺 ${report.realMissing.join("、")}`);
      }
      // No episode delta this sweep → fall back to the report's concrete progress
      // line ("已获取至最新第 6 集"), never a content-free "已更新".
      detail = segments.join(" · ") || report.lines[0] || "已是最新";
    }
    // Markdown: bold name + bullet, so Server酱 renders a real list, not a flat
    // text blob (desp is markdown; bare "·" lines read as a wall of plain text).
    // Source-drive suffix only present when the push layer passes the map (≥2 drives).
    const source = opts?.sourceLabelById?.get(notification.id);
    const sourceSuffix = source ? ` · 来自${source}` : "";
    lines.push(`- **${head}** — ${detail}${sourceSuffix}`);
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
