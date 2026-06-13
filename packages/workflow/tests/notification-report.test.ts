import { describe, expect, it } from "vitest";
import {
  buildMovieReport,
  buildSeasonReport,
  buildSeriesReport,
  createEpisodeStates,
  dominantQuality,
  episodeCode,
  formatDailyDigestPushText,
  formatReportPushText,
  type EpisodeState,
  type NotificationEvent,
  type NotificationReportStatus,
  type TrackedSeason,
} from "../src/index.js";

function scheduledNotification(input: {
  titleName: string;
  seasonLabel: string;
  kind: string;
  newlyObtained: string[];
  realMissing: string[];
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

describe("resource quality in notifications", () => {
  it("picks the highest quality tier present across file names", () => {
    expect(dominantQuality(["Off.Campus.S01E01.2160p.AMZN.WEB-DL.mkv"])).toBe("2160p");
    expect(dominantQuality(["Show.S01E01.1080p.mkv", "Show.S01E02.720p.mkv"])).toBe("1080p");
    expect(dominantQuality(["Movie.4K.UHD.BluRay.mkv"])).toBe("2160p");
    expect(dominantQuality(["plain.mkv"])).toBeUndefined();
  });

  it("surfaces the acquired quality in the push so the message isn't bare", () => {
    const movie = buildMovieReport("周处除三害", "2160p");
    expect(movie.quality).toBe("2160p");
    expect(formatReportPushText(movie)).toContain("🎞 画质：2160p");
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
});

describe("formatDailyDigestPushText", () => {
  it("merges a sweep into one digest: changed shows detailed, unchanged collapsed", () => {
    const text = formatDailyDigestPushText([
      scheduledNotification({ titleName: "翘楚", seasonLabel: "第 1 季", kind: "episodes_restored", newlyObtained: ["E13"], realMissing: [] }),
      scheduledNotification({ titleName: "灿烂的她", seasonLabel: "第 2 季", kind: "episodes_restored", newlyObtained: ["E10"], realMissing: ["E05"] }),
      scheduledNotification({ titleName: "庆余年", seasonLabel: "第 2 季", kind: "tracking_completed", newlyObtained: [], realMissing: [] }),
      scheduledNotification({ titleName: "迷雾追踪", seasonLabel: "第 1 季", kind: "already_current", newlyObtained: [], realMissing: [] }),
    ]);
    expect(text).toContain("每日巡检");
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
    expect(text).toContain("每日巡检");
    expect(text).toContain("无更新");
  });
});
