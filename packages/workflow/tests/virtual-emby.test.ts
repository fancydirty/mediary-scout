import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ACCOUNT_ID,
  DriveFileNotFoundError,
  EMBY_LIBRARY_IDS,
  InMemoryWorkflowRepository,
  buildEmbyItemId,
  createEpisodeStates,
  createVirtualEmbyPlaybackToken,
  encodeEmbyMediaSourceId,
  ensureVirtualEmbyToken,
  handleVirtualEmbyRequest,
  hashPassword,
  loadVirtualEmbyPlayableCounts,
  regenerateVirtualEmbyToken,
  setVirtualEmbyEnabled,
  type MediaTitle,
  type TrackedSeason,
} from "../src/index.js";

async function seedCatalog(repo: InMemoryWorkflowRepository) {
  await repo.createAccount({
    id: DEFAULT_ACCOUNT_ID,
    username: "owner",
    passwordHash: await hashPassword("secret-pass-123"),
    groupId: null,
    isOwner: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await repo.createAccount({
    id: "acct_guest",
    username: "guest",
    passwordHash: await hashPassword("guest-pass-456"),
    groupId: null,
    isOwner: false,
    createdAt: "2026-01-02T00:00:00.000Z",
  });

  await repo.upsertConnectedStorage({
    id: "cs_115",
    accountId: DEFAULT_ACCOUNT_ID,
    provider: "pan115",
    providerUid: "u115",
    label: "主 115",
    payload: { cookie: "UID=1_A1_1" },
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await repo.upsertConnectedStorage({
    id: "cs_quark",
    accountId: DEFAULT_ACCOUNT_ID,
    provider: "quark",
    providerUid: "uqk",
    label: "夸克盘",
    payload: { cookie: "__uid=q1" },
    createdAt: "2026-01-02T00:00:00.000Z",
  });

  const movieTitle: MediaTitle = {
    id: "tmdb_movie_550",
    tmdbId: 550,
    type: "movie",
    title: "搏击俱乐部",
    originalTitle: "Fight Club",
    year: 1999,
    aliases: [],
    releaseDate: "1999-10-15",
    posterPath: "/fc-poster.jpg",
    backdropPath: "/fc-bg.jpg",
    overview: "Rule #1",
  };
  const movieSeason: TrackedSeason = {
    id: "tmdb_movie_550_movie",
    mediaTitleId: movieTitle.id,
    seasonNumber: 1,
    status: "completed",
    qualityPreference: "4K",
    storageDirectoryId: "dir_m",
    totalEpisodes: 1,
    latestAiredEpisode: 1,
    latestAiredSource: "manual",
  };
  await repo.saveWorkflowRunSnapshot({
    accountId: DEFAULT_ACCOUNT_ID,
    connectedStorageId: "cs_115",
    title: movieTitle,
    season: movieSeason,
    workflowRun: {
      id: "run_m1",
      kind: "movie_init",
      status: "succeeded",
      trackedSeasonId: movieSeason.id,
      startedAt: "2026-11-20T00:00:00.000Z",
      finishedAt: "2026-11-20T00:01:00.000Z",
      auditEvents: [],
    },
    episodes: [
      {
        trackedSeasonId: movieSeason.id,
        episodeCode: "S01E01",
        airDate: "1999-10-15",
        title: "Fight Club",
        airStatus: "aired",
        obtained: true,
        metadataStatus: "confirmed",
        verifiedFileIds: ["f_115_fc"],
      },
    ],
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
  });
  await repo.upsertEpisodeCopies([
    {
      trackedSeasonId: movieSeason.id,
      episodeCode: "S01E01",
      storageId: "cs_115",
      fileIds: ["f_115_fc"],
      sizeBytes: 12_000_000_000,
      quality: "4K",
      runId: "run_m1",
      recordedAt: "2026-11-20T00:01:00.000Z",
    },
    {
      trackedSeasonId: movieSeason.id,
      episodeCode: "S01E01",
      storageId: "cs_quark",
      fileIds: ["f_qk_fc"],
      sizeBytes: 8_000_000_000,
      quality: "1080P",
      runId: "run_m2",
      recordedAt: "2026-11-21T00:01:00.000Z",
    },
  ]);

  const tvTitle: MediaTitle = {
    id: "tmdb_tv_1399",
    tmdbId: 1399,
    type: "tv",
    title: "权力的游戏",
    originalTitle: "Game of Thrones",
    year: 2011,
    aliases: [],
    posterPath: "/got-poster.jpg",
    backdropPath: "/got-bg.jpg",
  };
  const tvSeason: TrackedSeason = {
    id: "tmdb_tv_1399_s1",
    mediaTitleId: tvTitle.id,
    seasonNumber: 1,
    status: "active",
    qualityPreference: "4K",
    storageDirectoryId: "dir_tv",
    totalEpisodes: 3,
    latestAiredEpisode: 3,
    latestAiredSource: "metadata",
  };
  await repo.saveWorkflowRunSnapshot({
    accountId: DEFAULT_ACCOUNT_ID,
    connectedStorageId: "cs_115",
    title: tvTitle,
    season: tvSeason,
    workflowRun: {
      id: "run_tv1",
      kind: "type2_init",
      status: "partial",
      trackedSeasonId: tvSeason.id,
      startedAt: "2026-11-22T00:00:00.000Z",
      finishedAt: "2026-11-22T00:01:00.000Z",
      auditEvents: [],
    },
    episodes: createEpisodeStates({
      trackedSeasonId: tvSeason.id,
      seasonNumber: 1,
      totalEpisodes: 3,
      latestAiredEpisode: 3,
    }).map((ep) => ({
      ...ep,
      obtained: ep.episodeCode !== "S01E03",
      verifiedFileIds: ep.episodeCode !== "S01E03" ? [`f_${ep.episodeCode}`] : [],
    })),
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
  });
  await repo.upsertEpisodeCopies([
    {
      trackedSeasonId: tvSeason.id,
      episodeCode: "S01E01",
      storageId: "cs_115",
      fileIds: ["f_S01E01"],
      sizeBytes: 3_000_000_000,
      quality: "4K",
      runId: "run_tv1",
      recordedAt: "2026-11-22T00:01:00.000Z",
    },
    {
      trackedSeasonId: tvSeason.id,
      episodeCode: "S01E02",
      storageId: "cs_quark",
      fileIds: ["f_S01E02_qk"],
      sizeBytes: 2_500_000_000,
      quality: "1080P",
      runId: "run_tv1",
      recordedAt: "2026-11-22T00:02:00.000Z",
    },
  ]);

  await setVirtualEmbyEnabled(repo, true);
  const ownerToken = await ensureVirtualEmbyToken(repo, DEFAULT_ACCOUNT_ID);
  const guestToken = await ensureVirtualEmbyToken(repo, "acct_guest");
  return { ownerToken, guestToken };
}

function makeReq(
  method: string,
  path: string,
  opts?: {
    token?: string;
    authHeader?: string;
    query?: Record<string, string>;
    body?: unknown;
    userAgent?: string;
  },
) {
  const headers = new Headers();
  if (opts?.token) headers.set("X-Emby-Token", opts.token);
  if (opts?.authHeader) headers.set("X-Emby-Authorization", opts.authHeader);
  if (opts?.userAgent) headers.set("User-Agent", opts.userAgent);
  const query = new URLSearchParams(opts?.query ?? {});
  return {
    method,
    pathSegments: path.replace(/^\/+/, "").split("/").filter(Boolean),
    query,
    headers,
    body: opts?.body,
    origin: "http://192.168.1.10:3000",
  };
}

function statusOf(res: Awaited<ReturnType<typeof handleVirtualEmbyRequest>>): number {
  return res.kind === "proxy" ? 200 : res.status;
}

describe("Virtual Emby Server", () => {
  it("returns 404 for all endpoints when disabled", async () => {
    const repo = new InMemoryWorkflowRepository();
    const res = await handleVirtualEmbyRequest(makeReq("GET", "/System/Info/Public"), {
      repository: repo,
      resolveDownloadLink: vi.fn(),
    });
    expect(res.kind).toBe("json");
    expect(statusOf(res)).toBe(404);
  });

  it("handles public handshake, AuthenticateByName (password + token), token revocation, and account isolation", async () => {
    const repo = new InMemoryWorkflowRepository();
    const { ownerToken, guestToken } = await seedCatalog(repo);
    const ctx = { repository: repo, resolveDownloadLink: vi.fn() };

    // Duplicated /emby/emby prefix normalizes cleanly
    const pub = await handleVirtualEmbyRequest(makeReq("GET", "/emby/System/Info/Public"), ctx);
    expect(pub.kind).toBe("json");
    expect(statusOf(pub)).toBe(200);
    if (pub.kind === "json") {
      expect((pub.body as Record<string, unknown>)["ServerName"]).toContain("Mediary Scout");
      expect((pub.body as Record<string, unknown>)["Id"]).toMatch(/^[0-9a-f]{32}$/);
    }

    // Wrong password rejected (fail-closed)
    const badAuth = await handleVirtualEmbyRequest(
      makeReq("POST", "/Users/AuthenticateByName", { body: { Username: "owner", Pw: "wrong" } }),
      ctx,
    );
    expect(statusOf(badAuth)).toBe(401);

    // Login with scrypt password succeeds and returns account Emby token
    const passAuth = await handleVirtualEmbyRequest(
      makeReq("POST", "/Users/AuthenticateByName", { body: { Username: "owner", Pw: "secret-pass-123" } }),
      ctx,
    );
    expect(statusOf(passAuth)).toBe(200);
    if (passAuth.kind === "json") {
      expect((passAuth.body as Record<string, unknown>)["AccessToken"]).toBe(ownerToken);
    }

    // Login with Emby token as password also succeeds (zero-password single-user path!)
    const tokAuth = await handleVirtualEmbyRequest(
      makeReq("POST", "/Users/AuthenticateByName", { body: { Username: "owner", Pw: ownerToken } }),
      ctx,
    );
    expect(statusOf(tokAuth)).toBe(200);

    // Multi-user isolation: guest sees 0 movies/series, owner sees 1 movie + 1 series
    const ownerCounts = await handleVirtualEmbyRequest(
      makeReq("GET", "/Items/Counts", { token: ownerToken }),
      ctx,
    );
    const guestCounts = await handleVirtualEmbyRequest(
      makeReq("GET", "/Items/Counts", { token: guestToken }),
      ctx,
    );
    if (ownerCounts.kind === "json" && guestCounts.kind === "json") {
      expect((ownerCounts.body as Record<string, number>)["MovieCount"]).toBe(1);
      expect((ownerCounts.body as Record<string, number>)["SeriesCount"]).toBe(1);
      expect((ownerCounts.body as Record<string, number>)["EpisodeCount"]).toBe(2);
      expect((guestCounts.body as Record<string, number>)["MovieCount"]).toBe(0);
    }

    // Regenerating token immediately revokes old token
    const freshToken = await regenerateVirtualEmbyToken(repo, DEFAULT_ACCOUNT_ID);
    const revoked = await handleVirtualEmbyRequest(
      makeReq("GET", "/Items/Counts", { token: ownerToken }),
      ctx,
    );
    expect(statusOf(revoked)).toBe(401);
    const restored = await handleVirtualEmbyRequest(
      makeReq("GET", "/Items/Counts", {
        authHeader: `MediaBrowser Client="Infuse", Device="AppleTV", Token="${freshToken}"`,
      }),
      ctx,
    );
    expect(statusOf(restored)).toBe(200);
  });

  it("serves Views, Items, Latest (bare array), Seasons, Episodes, PlaybackInfo multi-drive sources, and TMDB images", async () => {
    const repo = new InMemoryWorkflowRepository();
    const { ownerToken } = await seedCatalog(repo);
    const ctx = { repository: repo, resolveDownloadLink: vi.fn() };

    const views = await handleVirtualEmbyRequest(
      makeReq("GET", "/Users/u1/Views", { token: ownerToken }),
      ctx,
    );
    expect(statusOf(views)).toBe(200);
    if (views.kind === "json") {
      const items = (views.body as { Items: Array<{ Id: string }> }).Items;
      expect(items.map((i) => i.Id)).toEqual([EMBY_LIBRARY_IDS.movies, EMBY_LIBRARY_IDS.tv]);
    }

    // Latest MUST return a bare array (Infuse / 网易爆米花 contract)
    const latest = await handleVirtualEmbyRequest(
      makeReq("GET", "/Users/u1/Items/Latest", { token: ownerToken, query: { ParentId: EMBY_LIBRARY_IDS.movies } }),
      ctx,
    );
    expect(statusOf(latest)).toBe(200);
    if (latest.kind === "json") {
      expect(Array.isArray(latest.body)).toBe(true);
      expect((latest.body as Array<{ Id: string }>)[0]?.Id).toBe("mov_550");
    }

    // Multi-drive movie exposes both 115 (direct 302) and Quark (proxy) in MediaSources
    const pb = await handleVirtualEmbyRequest(
      makeReq("POST", "/Items/mov_550/PlaybackInfo", { token: ownerToken }),
      ctx,
    );
    expect(statusOf(pb)).toBe(200);
    if (pb.kind === "json") {
      const sources = (pb.body as { MediaSources: Array<{ Name: string; Id: string }> }).MediaSources;
      expect(sources).toHaveLength(2);
      expect(sources[0]?.Name).toContain("主 115");
      expect(sources[0]?.Name).toContain("直链");
      expect(sources[1]?.Name).toContain("夸克盘");
      expect(sources[1]?.Name).toContain("代理");
    }

    // TV episodes span across 115 (E01) and Quark (E02) seamlessly inside one season!
    const eps = await handleVirtualEmbyRequest(
      makeReq("GET", "/Shows/tv_1399/Episodes", { token: ownerToken, query: { Season: "1" } }),
      ctx,
    );
    expect(statusOf(eps)).toBe(200);
    if (eps.kind === "json") {
      const items = (eps.body as { Items: Array<{ Id: string; IndexNumber: number }> }).Items;
      expect(items.map((e) => e.IndexNumber)).toEqual([1, 2]);
    }

    // Poster redirect works without auth header (standard Emby image fetch behavior)
    const poster = await handleVirtualEmbyRequest(makeReq("GET", "/Items/mov_550/Images/Primary"), ctx);
    expect(poster.kind).toBe("redirect");
    if (poster.kind === "redirect") {
      expect(poster.location).toBe("https://image.tmdb.org/t/p/w500/fc-poster.jpg");
    }
  });

  it("streams via 302 for 115, proxies for Quark, and lazily marks missing_on_drive + fails over on 404", async () => {
    const repo = new InMemoryWorkflowRepository();
    const { ownerToken } = await seedCatalog(repo);

    // 1. Direct 302 for 115 forwarding player User-Agent
    const resolveDirect = vi.fn(async ({ storage, fileId, userAgent }) => {
      expect(storage.provider).toBe("pan115");
      expect(fileId).toBe("f_S01E01");
      expect(userAgent).toBe("Infuse/8.0");
      return {
        url: "https://cdn.115.example/ep1.mkv",
        headers: { "User-Agent": "Infuse/8.0" },
        supportsRedirect: true,
        userAgentBound: true,
      };
    });
    const r1 = await handleVirtualEmbyRequest(
      makeReq("GET", "/Videos/ep_tv_1399_1_1/stream", { token: ownerToken, userAgent: "Infuse/8.0" }),
      { repository: repo, resolveDownloadLink: resolveDirect },
    );
    expect(r1.kind).toBe("redirect");
    if (r1.kind === "redirect") {
      expect(r1.location).toBe("https://cdn.115.example/ep1.mkv");
    }

    // 2. Proxy directive for Quark
    const resolveQuark = vi.fn(async ({ storage }) => {
      expect(storage.provider).toBe("quark");
      return {
        url: "https://dl.quark.example/ep2.mkv",
        headers: { Cookie: "__puus=fresh", Referer: "https://pan.quark.cn/" },
        supportsRedirect: false,
      };
    });
    const r2 = await handleVirtualEmbyRequest(
      makeReq("GET", "/Videos/ep_tv_1399_1_2/stream", { token: ownerToken }),
      { repository: repo, resolveDownloadLink: resolveQuark },
    );
    expect(r2.kind).toBe("proxy");

    // 3. Lazy invalidation + cross-drive failover on Fight Club (115 deleted -> falls over to Quark!)
    const resolveFailover = vi.fn(async ({ storage, fileId }) => {
      if (storage.id === "cs_115") {
        throw new DriveFileNotFoundError("pan115", fileId, "deleted by user");
      }
      return {
        url: "https://dl.quark.example/fight-club.mkv",
        headers: { Cookie: "__puus=ok" },
        supportsRedirect: false,
      };
    });
    const r3 = await handleVirtualEmbyRequest(
      makeReq("GET", "/Videos/mov_550/stream", {
        token: ownerToken,
        query: { MediaSourceId: encodeEmbyMediaSourceId("cs_115", "f_115_fc") },
      }),
      { repository: repo, resolveDownloadLink: resolveFailover, now: () => "2026-11-28T12:00:00.000Z" },
    );
    expect(r3.kind).toBe("proxy");
    if (r3.kind === "proxy") {
      expect(r3.storage.id).toBe("cs_quark");
    }
    // Verify 115 copy is now marked missing_on_drive while episode_states.obtained stays true!
    const copies = await repo.listEpisodeCopies("tmdb_movie_550_movie");
    expect(copies.find((c) => c.storageId === "cs_115")?.fileStatus).toBe("missing_on_drive");
    expect(copies.find((c) => c.storageId === "cs_quark")?.fileStatus ?? "present").toBe("present");
    const state = await repo.getTrackedSeasonState("tmdb_movie_550_movie", {
      accountId: DEFAULT_ACCOUNT_ID,
      connectedStorageId: "cs_115",
    });
    expect(state?.episodes[0]?.obtained).toBe(true);
  });

  it("syncs playback progress, Resume, PlayedItems, and NextUp", async () => {
    const repo = new InMemoryWorkflowRepository();
    const { ownerToken } = await seedCatalog(repo);
    const ctx = {
      repository: repo,
      resolveDownloadLink: vi.fn(),
      now: () => "2026-11-28T12:30:00.000Z",
    };

    // Report mid-movie progress (30 min / 120 min)
    const prog = await handleVirtualEmbyRequest(
      makeReq("POST", "/Sessions/Playing/Progress", {
        token: ownerToken,
        body: {
          ItemId: buildEmbyItemId({ kind: "movie", tmdbId: 550 }),
          PositionTicks: 18_000_000_000,
          RunTimeTicks: 72_000_000_000,
        },
      }),
      ctx,
    );
    expect(statusOf(prog)).toBe(204);

    // Resume returns Fight Club
    const resume = await handleVirtualEmbyRequest(
      makeReq("GET", "/Users/u1/Items/Resume", { token: ownerToken }),
      ctx,
    );
    expect(statusOf(resume)).toBe(200);
    if (resume.kind === "json") {
      const items = (resume.body as { Items: Array<{ Id: string; UserData: { PlaybackPositionTicks: number } }> }).Items;
      expect(items).toHaveLength(1);
      expect(items[0]?.Id).toBe("mov_550");
      expect(items[0]?.UserData.PlaybackPositionTicks).toBe(18_000_000_000);
    }

    // Mark S01E01 played → NextUp returns S01E02!
    const played = await handleVirtualEmbyRequest(
      makeReq("POST", "/Users/u1/PlayedItems/ep_tv_1399_1_1", { token: ownerToken }),
      ctx,
    );
    expect(statusOf(played)).toBe(200);

    const nextUp = await handleVirtualEmbyRequest(
      makeReq("GET", "/Shows/NextUp", { token: ownerToken }),
      ctx,
    );
    expect(statusOf(nextUp)).toBe(200);
    if (nextUp.kind === "json") {
      const items = (nextUp.body as { Items: Array<{ Id: string }> }).Items;
      expect(items.map((i) => i.Id)).toEqual(["ep_tv_1399_1_2"]);
    }

    // Stopped report with explicit Played: true (no RunTimeTicks) marks played and clears position
    const stopDone = await handleVirtualEmbyRequest(
      makeReq("POST", "/Sessions/Playing/Stopped", {
        token: ownerToken,
        body: { ItemId: "ep_tv_1399_1_2", PositionTicks: 500_000, Played: true },
      }),
      ctx,
    );
    expect(statusOf(stopDone)).toBe(204);
    const saved = await repo.getPlaybackProgress({
      accountId: DEFAULT_ACCOUNT_ID,
      tmdbId: 1399,
      mediaType: "tv",
      seasonNumber: 1,
      episodeNumber: 2,
    });
    expect(saved?.played).toBe(true);
    expect(saved?.positionTicks).toBe(0);
  });

  it("enforces item-scoped playback tokens, login throttle 429, and accurate playable counts", async () => {
    const repo = new InMemoryWorkflowRepository();
    const { ownerToken } = await seedCatalog(repo);
    const nowIso = "2026-11-28T12:00:00.000Z";
    const nowMs = Date.parse(nowIso);

    const resolveLink = vi.fn(async () => ({
      url: "https://cdn.115.example/movie.mkv",
      headers: {},
      supportsRedirect: true,
    }));

    const scopedTok = createVirtualEmbyPlaybackToken({
      accountId: DEFAULT_ACCOUNT_ID,
      itemId: "mov_550",
      masterToken: ownerToken,
      nowMs,
    });

    // Scoped token works for its exact item stream...
    const okStream = await handleVirtualEmbyRequest(
      makeReq("GET", "/Videos/mov_550/stream", { query: { api_key: scopedTok } }),
      { repository: repo, resolveDownloadLink: resolveLink, now: () => nowIso },
    );
    expect(okStream.kind).toBe("redirect");

    // ...is REJECTED on another item stream...
    const wrongItem = await handleVirtualEmbyRequest(
      makeReq("GET", "/Videos/ep_tv_1399_1_1/stream", { query: { api_key: scopedTok } }),
      { repository: repo, resolveDownloadLink: resolveLink, now: () => nowIso },
    );
    expect(statusOf(wrongItem)).toBe(401);

    // ...is REJECTED on catalog/Views endpoints...
    const wrongRoute = await handleVirtualEmbyRequest(
      makeReq("GET", "/Users/u1/Views", { query: { api_key: scopedTok } }),
      { repository: repo, resolveDownloadLink: resolveLink, now: () => nowIso },
    );
    expect(statusOf(wrongRoute)).toBe(401);

    // ...and is immediately invalidated when master token rotates!
    await regenerateVirtualEmbyToken(repo, DEFAULT_ACCOUNT_ID);
    const afterRotate = await handleVirtualEmbyRequest(
      makeReq("GET", "/Videos/mov_550/stream", { query: { api_key: scopedTok } }),
      { repository: repo, resolveDownloadLink: resolveLink, now: () => nowIso },
    );
    expect(statusOf(afterRotate)).toBe(401);

    // Login throttle blocks with 429 + Retry-After before verifying password
    const throttled = await handleVirtualEmbyRequest(
      makeReq("POST", "/Users/AuthenticateByName", { body: { Username: "owner", Pw: "bad" } }),
      {
        repository: repo,
        resolveDownloadLink: resolveLink,
        loginThrottle: {
          check: () => ({ allowed: false, retryAfterSec: 45 }),
          recordFailure: vi.fn(),
          recordSuccess: vi.fn(),
        },
      },
    );
    expect(statusOf(throttled)).toBe(429);
    if (throttled.kind === "json") {
      expect(throttled.headers?.["Retry-After"]).toBe("45");
    }

    // Playable counts exclude tombstoned copies
    expect(await loadVirtualEmbyPlayableCounts(repo, DEFAULT_ACCOUNT_ID)).toEqual({
      movies: 1,
      series: 1,
      episodes: 2,
    });
    await repo.setEpisodeCopyFileStatus({
      trackedSeasonId: "tmdb_movie_550_movie",
      episodeCode: "S01E01",
      storageId: "cs_115",
      fileStatus: "missing_on_drive",
      verifiedAt: nowIso,
    });
    await repo.setEpisodeCopyFileStatus({
      trackedSeasonId: "tmdb_movie_550_movie",
      episodeCode: "S01E01",
      storageId: "cs_quark",
      fileStatus: "missing_on_drive",
      verifiedAt: nowIso,
    });
    expect(await loadVirtualEmbyPlayableCounts(repo, DEFAULT_ACCOUNT_ID)).toEqual({
      movies: 0,
      series: 1,
      episodes: 2,
    });
  });
});
