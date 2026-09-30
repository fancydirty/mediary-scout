import { describe, expect, it } from "vitest";
import {
  buildMovieReport,
  buildReplacementReport,
  buildSeasonReport,
  buildSeriesReport,
  createEpisodeStates,
  emptyRunOutcome,
  episodeCode,
  formatBytes,
  formatDailyDigestPushText,
  formatReportPushText,
  landedSize,
  scheduledDigestItems,
  stampReplaceNotification,
  type EpisodeState,
  type NotificationEvent,
  type NotificationReportStatus,
  type TrackedSeason,
} from "../src/index.js";

const MB = 1024 * 1024;
const GB = 1024 * MB;

function scheduledNotification(input: {
  titleName: string;
  seasonLabel: string;
  kind: string;
  newlyObtained: string[];
  realMissing: string[];
  fileCount?: number;
  totalBytes?: number;
}): NotificationEvent {
  const status: NotificationReportStatus =
    input.realMissing.length > 0
      ? "partial"
      : input.kind === "tracking_completed"
        ? "complete"
        : "airing";
  return {
    id: `n_${input.titleName}`,
    workflowRunId: `run_${input.titleName}`,
    kind: input.kind,
    title: `${input.titleName} ${input.seasonLabel}`,
    body: "",
    createdAt: "2026-06-12T20:00:00.000Z",
    trigger: "scheduled",
    report: {
      titleName: input.titleName,
      seasonLabel: input.seasonLabel,
      status,
      lines: input.kind === "tracking_completed" ? ["全部获取，不再追踪"] : ["已获取至最新"],
      newlyObtained: input.newlyObtained,
      realMissing: input.realMissing,
      ...(input.fileCount !== undefined ? { fileCount: input.fileCount } : {}),
      ...(input.totalBytes !== undefined ? { totalBytes: input.totalBytes } : {}),
    },
  };
}

function season(overrides: Partial<TrackedSeason> = {}): TrackedSeason {
  return {
    id: "tmdb_tv_1_s1",
    mediaTitleId: "tmdb_tv_1",
    seasonNumber: 1,
    status: "active",
    qualityPreference: "4K",
    storageDirectoryId: "dir_1",
    totalEpisodes: 16,
    latestAiredEpisode: 12,
    latestAiredSource: "metadata",
    ...overrides,
  };
}

function episodes(input: { season: TrackedSeason; obtained: string[] }): EpisodeState[] {
  const states = createEpisodeStates({
    trackedSeasonId: input.season.id,
    seasonNumber: input.season.seasonNumber,
    totalEpisodes: input.season.totalEpisodes,
    latestAiredEpisode: input.season.latestAiredEpisode,
  });
  const obtained = new Set(input.obtained);
  return states.map((state) => ({ ...state, obtained: obtained.has(state.episodeCode) }));
}

function codes(seasonNumber: number, from: number, to: number): string[] {
  const result: string[] = [];
  for (let episode = from; episode <= to; episode += 1) {
    result.push(episodeCode(seasonNumber, episode));
  }
  return result;
}

describe("formatBytes", () => {
  it("renders MB under a gigabyte and GB at/above it (one decimal)", () => {
    expect(formatBytes(410 * MB)).toBe("410 MB");
    expect(formatBytes(Math.round(1.4 * GB))).toBe("1.4 GB");
    expect(formatBytes(2 * GB)).toBe("2.0 GB");
  });

  it("falls back to KB below a megabyte (never a bare byte count)", () => {
    expect(formatBytes(512 * 1024)).toBe("512 KB");
  });
});

describe("landedSize", () => {
  it("shows real per-episode size for a series (total / file count), never a claimed quality", () => {
    const report = buildSeasonReport({
      titleName: "一人之下",
      season: season({ totalEpisodes: 12, latestAiredEpisode: 12 }),
      episodes: episodes({ season: season({ totalEpisodes: 12, latestAiredEpisode: 12 }), obtained: codes(1, 1, 12) }),
      fileCount: 12,
      totalBytes: 12 * 410 * MB,
    });
    expect(landedSize(report)).toEqual({ label: "每集", value: "约 410 MB" });
  });

  it("shows the total volume for a movie (one file)", () => {
    const movie = buildMovieReport("周处除三害", undefined, { fileCount: 1, totalBytes: Math.round(1.4 * GB) });
    expect(landedSize(movie)).toEqual({ label: "体积", value: "1.4 GB" });
  });

  it("is undefined when size facts are missing or zero (omit, never guess)", () => {
    expect(landedSize(buildMovieReport("奥本海默"))).toBeUndefined();
    expect(
      landedSize(
        buildMovieReport("空", undefined, { fileCount: 0, totalBytes: 0 }),
      ),
    ).toBeUndefined();
  });

  it("carries fileCount/totalBytes onto the report so renderers can read them", () => {
    const movie = buildMovieReport("周处除三害", { posterPath: "/p.jpg", tmdbId: 996154, mediaType: "movie", year: 2024 }, { fileCount: 1, totalBytes: 2 * GB });
    expect(movie).toMatchObject({ posterPath: "/p.jpg", tmdbId: 996154, year: 2024, fileCount: 1, totalBytes: 2 * GB });
  });

  it("flags a 中文字幕 fallback landing (no confirmed 中字) and stays silent otherwise", () => {
    const fb = buildMovieReport("环太平洋", undefined, undefined, true);
    expect(fb.lines.some((l) => l.includes("可能无中文字幕"))).toBe(true);
    const normal = buildMovieReport("环太平洋", undefined, undefined, false);
    expect(normal.lines.some((l) => l.includes("可能无中文字幕"))).toBe(false);
    expect(buildMovieReport("环太平洋").lines.some((l) => l.includes("可能无中文字幕"))).toBe(false);
  });
});

describe("transferBlockReason — honest report when transfers were blocked (not no_coverage)", () => {
  const s = season({ totalEpisodes: 12, latestAiredEpisode: 1 });
  it("buildSeasonReport: noCoverage + block reason → status failed + 转存失败 line (not 暂未找到资源)", () => {
    const report = buildSeasonReport({
      titleName: "心灵奇旅",
      season: s,
      episodes: episodes({ season: s, obtained: [] }),
      noCoverage: true,
      transferBlockReason: "云下载配额不足，请升级VIP",
    });
    expect(report.status).toBe("failed");
    expect(report.lines.join("")).toContain("转存失败");
    expect(report.lines.join("")).toContain("配额");
    expect(report.lines.join("")).not.toContain("暂未找到");
  });

  it("buildSeasonReport: noCoverage WITHOUT block reason → unchanged no_coverage", () => {
    const report = buildSeasonReport({
      titleName: "无源片",
      season: s,
      episodes: episodes({ season: s, obtained: [] }),
      noCoverage: true,
    });
    expect(report.status).toBe("no_coverage");
    expect(report.lines.join("")).toContain("暂未找到");
  });

  it("buildSeriesReport: noCoverage + block reason → status failed + 转存失败 line", () => {
    const report = buildSeriesReport({
      titleName: "某剧",
      seasons: [],
      noCoverage: true,
      transferBlockReason: "登录超时，请重新登录。",
    });
    expect(report.status).toBe("failed");
    expect(report.lines.join("")).toContain("转存失败");
    expect(report.lines.join("")).toContain("登录");
  });
});

describe("buildSeasonReport", () => {
  it("reads as airing when all AIRED episodes are obtained but unaired remain", () => {
    const s = season({ totalEpisodes: 16, latestAiredEpisode: 12 });
    const report = buildSeasonReport({
      titleName: "凡人修仙传",
      season: s,
      episodes: episodes({ season: s, obtained: codes(1, 1, 12) }),
    });
    expect(report.status).toBe("airing");
    // The 4 unaired episodes are NOT a gap.
    expect(report.realMissing).toEqual([]);
    expect(report.lines[0]).toContain("已获取至最新第 12 集");
  });

  it("reports what we hold, not the aired cursor, when the resource is ahead of TMDB (资源超前)", () => {
    // TMDB says only 1 episode aired, but a full-season resource landed all 12.
    const s = season({ totalEpisodes: 12, latestAiredEpisode: 1 });
    const report = buildSeasonReport({
      titleName: "躲在超市后门抽烟的两人",
      season: s,
      episodes: episodes({ season: s, obtained: codes(1, 1, 12) }),
    });
    expect(report.status).toBe("airing");
    expect(report.realMissing).toEqual([]);
    // NOT "已获取至最新第 1 集" — it must surface the 12 episodes actually in hand.
    expect(report.lines[0]).toContain("已获取至第 12 集");
    expect(report.lines[0]).toContain("资源超前");
  });

  it("lists only aired-but-not-obtained episodes as missing", () => {
    const s = season({ totalEpisodes: 16, latestAiredEpisode: 12 });
    // Obtained everything aired except E05.
    const obtained = codes(1, 1, 12).filter((code) => code !== episodeCode(1, 5));
    const report = buildSeasonReport({
      titleName: "灿烂的她",
      season: s,
      episodes: episodes({ season: s, obtained }),
      newlyObtained: [episodeCode(1, 10)],
    });
    expect(report.status).toBe("partial");
    expect(report.realMissing).toEqual(["E05"]);
    expect(report.newlyObtained).toEqual(["E10"]);
  });

  it("reads as complete when a finished season is fully obtained", () => {
    const s = season({ totalEpisodes: 12, latestAiredEpisode: 12, status: "completed" });
    const report = buildSeasonReport({
      titleName: "庆余年",
      season: s,
      episodes: episodes({ season: s, obtained: codes(1, 1, 12) }),
    });
    expect(report.status).toBe("complete");
    expect(report.lines[0]).toContain("已完整获取");
  });

  it("renders the no-coverage shape", () => {
    const s = season();
    const report = buildSeasonReport({ titleName: "迷雾追踪", season: s, episodes: episodes({ season: s, obtained: [] }), noCoverage: true });
    expect(report.status).toBe("no_coverage");
    expect(report.lines[0]).toContain("暂未找到");
  });
});

describe("buildSeriesReport", () => {
  it("rolls completed seasons into a range and keeps the airing season separate", () => {
    const completed = [1, 2, 3, 4].map((number) =>
      season({ id: `tmdb_tv_1_s${number}`, seasonNumber: number, totalEpisodes: 8, latestAiredEpisode: 8, status: "completed" }),
    );
    const airing = season({ id: "tmdb_tv_1_s5", seasonNumber: 5, totalEpisodes: 8, latestAiredEpisode: 5 });
    const report = buildSeriesReport({
      titleName: "怪奇物语",
      seasons: [
        ...completed.map((s) => ({ season: s, episodes: episodes({ season: s, obtained: codes(s.seasonNumber, 1, 8) }) })),
        { season: airing, episodes: episodes({ season: airing, obtained: codes(5, 1, 5) }) },
      ],
    });
    expect(report.status).toBe("airing");
    expect(report.lines[0]).toBe("第 1–4 季已完整获取");
    expect(report.lines[1]).toContain("第 5 季");
    expect(report.lines[1]).toContain("已获取至最新第 5 集");
  });

  it("collapses an all-complete contiguous series to 全 N 季", () => {
    const all = [1, 2, 3, 4, 5].map((number) =>
      season({ id: `tmdb_tv_1_s${number}`, seasonNumber: number, totalEpisodes: 8, latestAiredEpisode: 8, status: "completed" }),
    );
    const report = buildSeriesReport({
      titleName: "黑袍纠察队",
      seasons: all.map((s) => ({ season: s, episodes: episodes({ season: s, obtained: codes(s.seasonNumber, 1, 8) }) })),
    });
    expect(report.status).toBe("complete");
    expect(report.lines[0]).toBe("全 5 季已完整获取");
  });
});

describe("formatReportPushText", () => {
  it("renders title, lines, and chips as emoji text", () => {
    const report = buildMovieReport("奥本海默");
    const text = formatReportPushText(report);
    expect(text).toContain("📺 奥本海默");
    expect(text).toContain("已获取入库");
  });

  it("includes new and missing episodes in the push body", () => {
    const s = season({ totalEpisodes: 16, latestAiredEpisode: 12 });
    const obtained = codes(1, 1, 12).filter((code) => code !== episodeCode(1, 5));
    const report = buildSeasonReport({
      titleName: "灿烂的她",
      season: s,
      episodes: episodes({ season: s, obtained }),
      newlyObtained: [episodeCode(1, 10)],
    });
    const text = formatReportPushText(report);
    expect(text).toContain("本次新增：E10");
    expect(text).toContain("缺集：E05");
  });

  it("renders per-episode size for a series and total volume for a movie", () => {
    const s = season({ totalEpisodes: 12, latestAiredEpisode: 12 });
    const seriesText = formatReportPushText(
      buildSeasonReport({
        titleName: "一人之下",
        season: s,
        episodes: episodes({ season: s, obtained: codes(1, 1, 12) }),
        fileCount: 12,
        totalBytes: 12 * 410 * MB,
      }),
    );
    expect(seriesText).toContain("🎞 每集：约 410 MB");

    const movieText = formatReportPushText(
      buildMovieReport("周处除三害", undefined, { fileCount: 1, totalBytes: Math.round(1.4 * GB) }),
    );
    expect(movieText).toContain("🎞 体积：1.4 GB");
    // The unreliable claimed-quality line is gone for good.
    expect(movieText).not.toContain("画质");
  });

  it("omits the size line when size facts are absent (never a bare 🎞)", () => {
    expect(formatReportPushText(buildMovieReport("奥本海默"))).not.toContain("🎞");
  });
});

describe("formatDailyDigestPushText", () => {
  it("merges a sweep into one digest: changed shows detailed, unchanged collapsed", () => {
    const text = formatDailyDigestPushText([
      scheduledNotification({ titleName: "翘楚", seasonLabel: "第 1 季", kind: "episodes_restored", newlyObtained: ["E13"], realMissing: [] }),
      scheduledNotification({ titleName: "灿烂的她", seasonLabel: "第 2 季", kind: "episodes_restored", newlyObtained: ["E10"], realMissing: ["E05"] }),
      scheduledNotification({ titleName: "庆余年", seasonLabel: "第 2 季", kind: "tracking_completed", newlyObtained: [], realMissing: [] }),
      scheduledNotification({ titleName: "迷雾追踪", seasonLabel: "第 1 季", kind: "already_current", newlyObtained: [], realMissing: [] }),
    ]);
    // No "每日巡检" header line in the body — the push title field carries it.
    expect(text).not.toContain("📺 每日巡检");
    expect(text).toContain("翘楚 第 1 季");
    expect(text).toContain("E13");
    expect(text).toContain("灿烂的她 第 2 季");
    expect(text).toContain("E05");
    expect(text).toContain("庆余年 第 2 季");
    // Unchanged shows are NAMED, not just counted, so the digest is informative.
    expect(text).toContain("其余已是最新：迷雾追踪");
  });

  it("reports no updates when nothing changed", () => {
    const text = formatDailyDigestPushText([
      scheduledNotification({ titleName: "迷雾追踪", seasonLabel: "第 1 季", kind: "already_current", newlyObtained: [], realMissing: [] }),
    ]);
    expect(text).toContain("无更新");
  });

  it("renders markdown (bold names, bullet list) so the push isn't a flat blob", () => {
    const text = formatDailyDigestPushText([
      scheduledNotification({ titleName: "翘楚", seasonLabel: "第 1 季", kind: "episodes_restored", newlyObtained: ["E13"], realMissing: [] }),
    ]);
    expect(text).toContain("**翘楚 第 1 季**"); // bold name renders on Server酱
    expect(text).toMatch(/^- /m); // markdown bullet, not a "·" text prefix
  });

  it("appends per-episode size to a changed show's digest line when known", () => {
    const text = formatDailyDigestPushText([
      scheduledNotification({
        titleName: "一人之下",
        seasonLabel: "第 6 季",
        kind: "episodes_restored",
        newlyObtained: ["E04"],
        realMissing: [],
        fileCount: 12,
        totalBytes: 12 * 410 * MB,
      }),
    ]);
    expect(text).toContain("约 410 MB");
  });

  it("a film the patrol landed keeps its own lines and its size in the digest", () => {
    const report = buildMovieReport("沙丘", undefined, { fileCount: 1, totalBytes: Math.round(5.2 * GB) }, true);
    const text = formatDailyDigestPushText([
      { id: "n_dune", workflowRunId: "run_dune", kind: "movie_init", title: "沙丘", body: "", createdAt: "2026-10-01T22:10:00.000Z", trigger: "scheduled", report },
    ]);
    expect(text).toContain("- **沙丘** — 已获取入库 · ⚠️ 可能无中文字幕(兜底) · 5.2 GB");
  });

  it("a film the patrol still cannot find reads as not found yet", () => {
    const report = { ...buildMovieReport("黄金时段"), ...emptyRunOutcome() };
    const text = formatDailyDigestPushText([
      { id: "n_prime", workflowRunId: "run_prime", kind: "no_coverage", title: "黄金时段", body: "", createdAt: "2026-10-01T22:10:00.000Z", trigger: "scheduled", report },
    ]);
    expect(text).toContain("- **黄金时段** — 暂未找到可用资源 · 将持续尝试");
  });

  it("a changed show with no episode delta shows its concrete progress line, not a vague 已更新", () => {
    const text = formatDailyDigestPushText([
      scheduledNotification({ titleName: "达顿牧场", seasonLabel: "第 1 季", kind: "episodes_restored", newlyObtained: [], realMissing: [] }),
    ]);
    expect(text).toContain("已获取至最新"); // report.lines[0], the real progress
    expect(text).not.toContain("已更新");
  });
});

describe("formatDailyDigestPushText source tags", () => {
  it("suffixes each show line with ' · 来自<盘名>' from the id→label map", () => {
    const notif = scheduledNotification({
      titleName: "斗破苍穹",
      seasonLabel: "第 5 季",
      kind: "episodes_restored",
      newlyObtained: ["E06"],
      realMissing: [],
    });
    const map = new Map([[notif.id, "115 网盘"]]);
    const out = formatDailyDigestPushText([notif], { sourceLabelById: map });
    expect(out).toContain("· 来自115 网盘");
  });
  it("no opts → identical to current (no 来自 suffix)", () => {
    const notif = scheduledNotification({
      titleName: "斗破苍穹",
      seasonLabel: "第 5 季",
      kind: "episodes_restored",
      newlyObtained: ["E06"],
      realMissing: [],
    });
    expect(formatDailyDigestPushText([notif])).not.toContain("来自");
  });
});

describe("buildReplacementReport — a user-requested replace run", () => {
  it("names what was replaced and what is still being looked for, never 入库 or a size", () => {
    const report = buildReplacementReport({
      titleName: "黄泉使者",
      movie: false,
      results: [
        { episode: "S01E13", outcome: "replaced" },
        { episode: "S01E24", outcome: "not_found" },
      ],
    });
    expect(report).toMatchObject({ status: "replaced", lines: ["换好 1 集（E13），1 集还在找（E24）"] });
    expect(report.fileCount).toBeUndefined();
    expect(formatReportPushText(report)).not.toMatch(/入库|获取完成/);
  });

  it("keeps the season in the code when the episodes span seasons", () => {
    const report = buildReplacementReport({
      titleName: "Show",
      movie: false,
      results: [
        { episode: "S01E02", outcome: "replaced" },
        { episode: "S02E05", outcome: "replaced" },
      ],
    });
    expect(report.lines).toEqual(["换好 2 集（S01E02、S02E05）"]);
  });

  it("an episode the user asked for that had no old file is 换好, not also 新增; a real gap still is 新增", () => {
    // E13 was declared file-less, so it was in the pre-run missing set and lands in
    // newlyObtained too; E14 is a genuinely new episode.
    const report = buildReplacementReport({
      titleName: "黄泉使者",
      movie: false,
      results: [{ episode: "S01E13", outcome: "replaced" }],
      newlyObtained: ["S01E13", "S01E14"],
    });
    expect(report.lines).toEqual(["换好 1 集（E13）", "新增 E14"]);
    expect(report.newlyObtained).toEqual(["S01E14"]);
  });

  it("a movie: replaced vs still looking", () => {
    expect(buildReplacementReport({ titleName: "奥德赛", movie: true, results: [{ episode: "MOVIE", outcome: "replaced" }] })).toMatchObject({
      status: "replaced",
      lines: ["已换成新版本"],
    });
    expect(buildReplacementReport({ titleName: "奥德赛", movie: true, results: [{ episode: "MOVIE", outcome: "not_found" }] })).toMatchObject({
      status: "no_coverage",
      lines: ["还没找到可以换的版本 · 巡检时接着找"],
    });
  });

  it("nothing replaced but a plain gap landed: not no_coverage — it says what was added", () => {
    const report = buildReplacementReport({
      titleName: "Show",
      movie: false,
      results: [{ episode: "S01E13", outcome: "not_found" }],
      newlyObtained: ["S01E25"],
    });
    expect(report.status).not.toBe("no_coverage");
    expect(report.lines).toEqual(["新增 E25", "1 集还在找（E13）"]);
    expect(report.newlyObtained).toEqual(["S01E25"]);
  });

  it("replaced and a plain gap landed: both are named", () => {
    const report = buildReplacementReport({
      titleName: "Show",
      movie: false,
      results: [{ episode: "S01E13", outcome: "replaced" }],
      newlyObtained: ["S01E25"],
    });
    expect(report).toMatchObject({ status: "replaced", lines: ["换好 1 集（E13）", "新增 E25"] });
  });

  it("nothing replaced because transfers were blocked says so", () => {
    const report = buildReplacementReport({
      titleName: "Show",
      movie: false,
      results: [{ episode: "S01E01", outcome: "not_found" }],
      transferBlockReason: "云下载配额不足",
    });
    expect(report).toMatchObject({ status: "failed", lines: ["转存失败:云下载配额不足"] });
  });
});

describe("stampReplaceNotification — who queued the replace run decides how it is pushed", () => {
  const base = (status: NotificationReportStatus, kind = "replacement_done"): NotificationEvent => ({
    id: "n1",
    workflowRunId: "run_1",
    kind,
    title: "Show",
    body: "x",
    createdAt: "2026-09-26T08:00:00.000Z",
    trigger: "user",
    report: { titleName: "Show", seasonLabel: null, status, lines: ["x"], newlyObtained: [], realMissing: [] },
  });

  it("a patrol-queued run joins the scheduled digest; a user-queued one stays individual", () => {
    expect(stampReplaceNotification(base("replaced"), { trigger: "scheduled", routineIfNothingReplaced: false })).toMatchObject({ trigger: "scheduled", kind: "replacement_done" });
    expect(stampReplaceNotification(base("replaced"), { trigger: "user", routineIfNothingReplaced: false })).toMatchObject({ trigger: "user", kind: "replacement_done" });
  });

  it("a pending-only run that replaced nothing is routine (already_current); a failure or a replacement never is", () => {
    const notice = { trigger: "scheduled" as const, routineIfNothingReplaced: true };
    expect(stampReplaceNotification(base("no_coverage"), notice).kind).toBe("already_current");
    expect(stampReplaceNotification(base("replaced"), notice).kind).toBe("replacement_done");
    expect(stampReplaceNotification(base("failed", "transfer_failed"), notice).kind).toBe("transfer_failed");
    expect(stampReplaceNotification(base("no_coverage"), { ...notice, routineIfNothingReplaced: false }).kind).toBe("replacement_done");
  });

  it("a run that landed a newly aired episode is never routine, whatever its status", () => {
    const notice = { trigger: "scheduled" as const, routineIfNothingReplaced: true };
    const grew = base("no_coverage");
    grew.report = { ...grew.report!, newlyObtained: ["S01E25"] };
    expect(stampReplaceNotification(grew, notice).kind).toBe("replacement_done");
  });
});

describe("scheduledDigestItems", () => {
  const n = (kind: string, trigger: "user" | "scheduled"): NotificationEvent => ({
    id: `${kind}_${trigger}`,
    workflowRunId: "r",
    kind,
    title: "t",
    body: "b",
    createdAt: "2026-09-26T08:00:00.000Z",
    trigger,
  });

  it("the sweep digest goes out even when nothing changed", () => {
    expect(scheduledDigestItems([n("already_current", "scheduled")], { skipIfOnlyRoutine: false })).toHaveLength(1);
  });

  it("a queue drain skips a digest that would only say nothing changed", () => {
    expect(scheduledDigestItems([n("already_current", "scheduled"), n("replacement_done", "user")], { skipIfOnlyRoutine: true })).toEqual([]);
    expect(
      scheduledDigestItems([n("already_current", "scheduled"), n("replacement_done", "scheduled")], { skipIfOnlyRoutine: true }).map((x) => x.kind),
    ).toEqual(["already_current", "replacement_done"]);
  });
});
