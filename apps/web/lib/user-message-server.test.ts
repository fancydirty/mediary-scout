import { describe, expect, it } from "vitest";
import {
  createEpisodeStates,
  InMemoryWorkflowRepository,
  movieAnchorSeason,
  pickWorkspaceStorageId,
  queueReplaceRequest,
  type MediaTitle,
  type TrackedSeason,
} from "@media-track/workflow";
import { loadMessageThread, messageRunView, nextPatrolLabel, readTitleMessages, resolveMessageWork, swapBadgeLabel } from "./user-message-server";

const NOW = "2026-09-27T08:00:00.000Z";

const show: MediaTitle = { id: "tmdb_tv_42", tmdbId: 42, type: "tv", title: "Show", originalTitle: "Show", year: 2026, aliases: [] };
const film: MediaTitle = { id: "tmdb_movie_42", tmdbId: 42, type: "movie", title: "Film", originalTitle: "Film", year: 2026, aliases: [] };

function season(titleId: string, seasonNumber: number): TrackedSeason {
  return {
    id: `${titleId}_s${seasonNumber}`,
    mediaTitleId: titleId,
    seasonNumber,
    status: "completed",
    qualityPreference: "4K",
    storageDirectoryId: `dir_s${seasonNumber}`,
    totalEpisodes: 2,
    latestAiredEpisode: 2,
    latestAiredSource: "metadata",
  };
}

/** A finished acquisition that left `s` tracked (all episodes obtained) on `drive`
 *  (undefined = an unbound season, stored with a null drive). */
async function track(repo: InMemoryWorkflowRepository, input: { accountId?: string; drive?: string; title: MediaTitle; s: TrackedSeason }) {
  await repo.saveWorkflowRunSnapshot({
    accountId: input.accountId ?? "acct_1",
    ...(input.drive === undefined ? {} : { connectedStorageId: input.drive }),
    title: input.title,
    season: input.s,
    workflowRun: {
      id: `seed_${input.s.id}_${input.drive ?? "unbound"}`,
      kind: input.title.type === "movie" ? "movie_init" : "type2_init",
      status: "succeeded",
      trackedSeasonId: input.s.id,
      startedAt: "2026-09-01T00:00:00.000Z",
      finishedAt: "2026-09-01T00:00:00.000Z",
      auditEvents: [],
    },
    episodes: createEpisodeStates({
      trackedSeasonId: input.s.id,
      seasonNumber: input.s.seasonNumber,
      totalEpisodes: input.s.totalEpisodes,
      latestAiredEpisode: input.s.latestAiredEpisode,
    }).map((e) => ({ ...e, obtained: true })),
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
  });
}

describe("resolveMessageWork — the work the engine will look for", () => {
  it("a message posted from the primary drive (page storageId undefined) is keyed by the real drive id and is queueable", async () => {
    const repo = new InMemoryWorkflowRepository();
    await track(repo, { drive: "cs_primary", title: show, s: season(show.id, 1) });
    // What getActiveWorkspaceScope(undefined) resolves on the show page: the primary drive's id.
    const storageId: string | undefined = undefined;
    const scope = { accountId: "acct_1", connectedStorageId: pickWorkspaceStorageId([{ id: "cs_primary", createdAt: NOW }], storageId) };
    expect(scope.connectedStorageId).toBe("cs_primary");

    const work = await resolveMessageWork({ repo, scope, tmdbId: 42, mediaType: "tv" });

    expect(work).toEqual({ accountId: "acct_1", drive: "cs_primary", titleKey: "tmdb_tv_42" });
    await repo.createUserMessage({ ...work!, body: "13、24 集发蓝", episodeTags: ["S01E01"], now: NOW });
    expect((await queueReplaceRequest({ repository: repo, work: work! })).status).toBe("queued");
    // The key the UI plan first used (storageId ?? "") is one the engine never finds.
    expect((await queueReplaceRequest({ repository: repo, work: { ...work!, drive: storageId ?? "" } })).status).toBe("not_tracked");
  });

  it("an unbound season (no drive) resolves to drive \"\" and queues", async () => {
    const repo = new InMemoryWorkflowRepository();
    await track(repo, { title: show, s: season(show.id, 1) });
    // An account with no drive yet: the workspace scope is account-wide.
    const scope = { accountId: "acct_1", connectedStorageId: pickWorkspaceStorageId([], undefined) };

    const work = await resolveMessageWork({ repo, scope, tmdbId: 42, mediaType: "tv" });

    expect(work).toEqual({ accountId: "acct_1", drive: "", titleKey: "tmdb_tv_42" });
    await repo.createUserMessage({ ...work!, body: "换一个", episodeTags: [], now: NOW });
    expect((await queueReplaceRequest({ repository: repo, work: work! })).status).toBe("queued");
  });

  it("a non-primary drive keys by that drive; all of the title's seasons share one work", async () => {
    const repo = new InMemoryWorkflowRepository();
    await track(repo, { drive: "cs_quark", title: show, s: season(show.id, 1) });
    await track(repo, { drive: "cs_quark", title: show, s: season(show.id, 2) });

    const work = await resolveMessageWork({ repo, scope: { accountId: "acct_1", connectedStorageId: "cs_quark" }, tmdbId: 42, mediaType: "tv" });

    expect(work).toEqual({ accountId: "acct_1", drive: "cs_quark", titleKey: "tmdb_tv_42" });
  });

  it("null when the title is not tracked on this drive, or only under another account", async () => {
    const repo = new InMemoryWorkflowRepository();
    await track(repo, { drive: "cs_other", title: show, s: season(show.id, 1) });
    await track(repo, { accountId: "acct_2", drive: "cs_primary", title: show, s: season(show.id, 1) });

    expect(await resolveMessageWork({ repo, scope: { accountId: "acct_1", connectedStorageId: "cs_primary" }, tmdbId: 42, mediaType: "tv" })).toBeNull();
  });

  it("movie and tv ids are separate namespaces", async () => {
    const repo = new InMemoryWorkflowRepository();
    await track(repo, { drive: "cs_primary", title: film, s: movieAnchorSeason({ titleId: film.id, qualityPreference: "4K", storageDirectoryId: "dir_movie" }) });
    const scope = { accountId: "acct_1", connectedStorageId: "cs_primary" };

    expect(await resolveMessageWork({ repo, scope, tmdbId: 42, mediaType: "movie" })).toEqual({
      accountId: "acct_1",
      drive: "cs_primary",
      titleKey: "tmdb_movie_42",
    });
    expect(await resolveMessageWork({ repo, scope, tmdbId: 42, mediaType: "tv" })).toBeNull();
  });

  it("refuses a forged mediaType or tmdbId (server actions get whatever the client sent)", async () => {
    const repo = new InMemoryWorkflowRepository();
    await track(repo, { drive: "cs_primary", title: show, s: season(show.id, 1) });
    const scope = { accountId: "acct_1", connectedStorageId: "cs_primary" };
    const forged = "tv_42_x" as unknown as "tv";

    expect(await resolveMessageWork({ repo, scope, tmdbId: 42, mediaType: forged })).toBeNull();
    expect(await resolveMessageWork({ repo, scope, tmdbId: -42, mediaType: "tv" })).toBeNull();
    expect(await resolveMessageWork({ repo, scope, tmdbId: 4.2, mediaType: "tv" })).toBeNull();
  });
});

describe("loadMessageThread", () => {
  const work = { accountId: "acct_1", drive: "cs_primary", titleKey: "tmdb_tv_42" };

  it("lists the work's messages newest first without withdrawn ones, with only what the card shows", async () => {
    const repo = new InMemoryWorkflowRepository();
    const first = await repo.createUserMessage({ ...work, body: "第一条", episodeTags: ["S01E13"], now: "2026-09-27T01:00:00.000Z" });
    const gone = await repo.createUserMessage({ ...work, body: "撤回的", episodeTags: [], now: "2026-09-27T02:00:00.000Z" });
    const latest = await repo.createUserMessage({ ...work, body: "第二条", episodeTags: [], now: "2026-09-27T03:00:00.000Z" });
    await repo.withdrawUserMessage({ accountId: work.accountId, id: gone.id, now: NOW });
    // Another work's message stays out.
    await repo.createUserMessage({ ...work, titleKey: "tmdb_tv_7", body: "别的剧", episodeTags: [], now: NOW });

    const view = await loadMessageThread(repo, work);

    expect(view.messages).toEqual([
      { id: latest.id, body: "第二条", episodeTags: [], status: "pending", urgent: false, createdAt: "2026-09-27T03:00:00.000Z", processedAt: null, reply: null },
      { id: first.id, body: "第一条", episodeTags: ["S01E13"], status: "pending", urgent: false, createdAt: "2026-09-27T01:00:00.000Z", processedAt: null, reply: null },
    ]);
    expect(view.busy).toBe(false);
  });

  it("an answered message carries when it was answered, with the reply", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.createUserMessage({ ...work, body: "换", episodeTags: [], now: "2026-09-27T01:00:00.000Z" });
    await repo.claimUserMessages({ ...work, runId: "run_1", now: "2026-09-27T01:10:00.000Z" });
    await repo.finishUserMessages({ runId: "run_1", reply: { results: [], oldFiles: [], runId: "run_1", unidentified: true }, now: "2026-09-27T01:31:00.000Z" });

    const [answered] = (await loadMessageThread(repo, work)).messages;

    expect(answered).toMatchObject({ status: "done", processedAt: "2026-09-27T01:31:00.000Z", reply: { runId: "run_1", unidentified: true } });
  });

  it("待换 episodes come back sorted; busy while a run holds a message", async () => {
    const repo = new InMemoryWorkflowRepository();
    const m = await repo.createUserMessage({ ...work, body: "换 24、3", episodeTags: [], now: NOW });
    await repo.addPendingReplacements({ ...work, episodes: ["S01E24", "S01E03"], messageId: m.id, now: NOW });
    await repo.claimUserMessages({ ...work, runId: "run_1", now: NOW });

    const view = await loadMessageThread(repo, work);

    expect(view.pendingReplacements).toEqual(["S01E03", "S01E24"]);
    expect(view.busy).toBe(true);
    expect(view.messages[0]).toMatchObject({ status: "processing" });
  });

  it("each 待换 row carries the message that asked and when — what 撤销 after 不换了 puts back", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.addPendingReplacements({ ...work, episodes: ["S01E24"], messageId: "msg_b", now: "2026-09-26T02:00:00.000Z" });
    await repo.addPendingReplacements({ ...work, episodes: ["S01E03"], messageId: "msg_a", now: "2026-09-25T01:00:00.000Z" });

    const view = await loadMessageThread(repo, work);

    expect(view.pendingRows).toEqual([
      { episode: "S01E03", messageId: "msg_a", requestedAt: "2026-09-25T01:00:00.000Z" },
      { episode: "S01E24", messageId: "msg_b", requestedAt: "2026-09-26T02:00:00.000Z" },
    ]);
  });
});

describe("messageRunView — what the work's active run means for its messages", () => {
  const work = { accountId: "acct_1", drive: "cs_primary", titleKey: "tmdb_tv_42" };
  const scope = { accountId: "acct_1", connectedStorageId: "cs_primary" };

  /** A tracked show with one message on the primary drive. */
  async function seeded() {
    const repo = new InMemoryWorkflowRepository();
    await track(repo, { drive: "cs_primary", title: show, s: season(show.id, 1) });
    await repo.createUserMessage({ ...work, body: "换", episodeTags: [], now: NOW });
    return repo;
  }

  it("a running replace run: its live line feeds the ticker, and a newer urgent message waits for it", async () => {
    const repo = await seeded();
    const queued = await queueReplaceRequest({ repository: repo, work });
    await repo.claimNextQueuedWorkflowRun({ kind: "replace_request", now: NOW });
    await repo.updateWorkflowRunProgress(queued.workflowRunId!, { activity: "正在搜索资源：Show 13", phase: "search", percent: 30, updatedAt: NOW });

    expect(messageRunView(await repo.listActiveWorkflowRuns(scope), work)).toEqual({ running: true, activity: "正在搜索资源：Show 13", waitsForRun: true });
  });

  it("a replace run that is only queued takes every waiting message along when it starts: nothing to wait for", async () => {
    const repo = await seeded();
    await queueReplaceRequest({ repository: repo, work });

    expect(messageRunView(await repo.listActiveWorkflowRuns(scope), work)).toEqual({ running: false, activity: null, waitsForRun: false });
  });

  it("another kind of run on the title holds the work lock: urgent messages go after it", async () => {
    const repo = await seeded();
    const s2 = season(show.id, 2);
    await repo.saveWorkflowRunSnapshot({
      accountId: "acct_1",
      connectedStorageId: "cs_primary",
      title: show,
      season: s2,
      workflowRun: { id: "run_s2", kind: "type2_init", status: "running", trackedSeasonId: s2.id, startedAt: NOW, finishedAt: null, auditEvents: [] },
      episodes: createEpisodeStates({ trackedSeasonId: s2.id, seasonNumber: 2, totalEpisodes: 2, latestAiredEpisode: 2 }),
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });

    expect(messageRunView(await repo.listActiveWorkflowRuns(scope), work)).toEqual({ running: false, activity: null, waitsForRun: true });
  });

  it("runs of another title, or of this title on another drive, do not count", async () => {
    const repo = await seeded();
    const other: MediaTitle = { ...show, id: "tmdb_tv_7", tmdbId: 7 };
    await track(repo, { drive: "cs_primary", title: other, s: season(other.id, 1) });
    await repo.createUserMessage({ ...work, titleKey: other.id, body: "换", episodeTags: [], now: NOW });
    await queueReplaceRequest({ repository: repo, work: { ...work, titleKey: other.id } });
    await repo.claimNextQueuedWorkflowRun({ kind: "replace_request", now: NOW });
    await track(repo, { drive: "cs_quark", title: show, s: season(show.id, 1) });
    await repo.createUserMessage({ ...work, drive: "cs_quark", body: "换", episodeTags: [], now: NOW });
    await queueReplaceRequest({ repository: repo, work: { ...work, drive: "cs_quark" } });
    await repo.claimNextQueuedWorkflowRun({ kind: "replace_request", now: NOW });

    // Account-wide listing: both runs are in it, neither is this work's.
    const runs = await repo.listActiveWorkflowRuns({ accountId: "acct_1", connectedStorageId: null });
    expect(runs).toHaveLength(2);
    expect(messageRunView(runs, work)).toEqual({ running: false, activity: null, waitsForRun: false });
  });
});

describe("readTitleMessages — the detail page's message decorations", () => {
  const primary = async () => ({ accountId: "acct_1", connectedStorageId: "cs_primary" });

  it("reads the thread of the work the page is on, what its run is doing, and the patrol times", async () => {
    const repo = new InMemoryWorkflowRepository();
    await track(repo, { drive: "cs_primary", title: show, s: season(show.id, 1) });
    const m = await repo.createUserMessage({ accountId: "acct_1", drive: "cs_primary", titleKey: show.id, body: "换", episodeTags: [], now: NOW });

    const read = await readTitleMessages({ repo, scope: primary, tmdbId: 42, mediaType: "tv", sweepTimes: async () => ["06:00", "21:00"] });

    expect(read?.thread.messages.map((x) => x.id)).toEqual([m.id]);
    expect(read?.run).toEqual({ running: false, activity: null, waitsForRun: false });
    expect(read?.sweepTimes).toEqual(["06:00", "21:00"]);
  });

  it("unified workspace (connectedStorageId: null): keeps thread messages and 待换 visible even when the title is tracked across multiple drives", async () => {
    const repo = new InMemoryWorkflowRepository();
    const s = movieAnchorSeason({ titleId: film.id, qualityPreference: "4K", storageDirectoryId: "dir_movie" });
    await track(repo, { drive: "cs_pan123", title: film, s });
    // Message was filed while only cs_pan123 tracked the film
    const m = await repo.createUserMessage({ accountId: "acct_1", drive: "cs_pan123", titleKey: film.id, body: "画质太差", episodeTags: [], now: NOW });
    // Later a side-run tracked the film on cs_103164004 too (which sorts before cs_pan123)
    await track(repo, { drive: "cs_103164004", title: film, s });

    const read = await readTitleMessages({
      repo,
      scope: async () => ({ accountId: "acct_1", connectedStorageId: null }),
      tmdbId: 42,
      mediaType: "movie",
      sweepTimes: async () => ["06:00"],
    });

    expect(read?.thread.messages.map((x) => x.id)).toEqual([m.id]);
  });

  it("null when the title is not tracked on this drive", async () => {
    const repo = new InMemoryWorkflowRepository();

    expect(await readTitleMessages({ repo, scope: primary, tmdbId: 42, mediaType: "tv", sweepTimes: async () => [] })).toBeNull();
  });

  it("a failed read logs one short line and leaves the decorations out instead of failing the page", async () => {
    const repo = new InMemoryWorkflowRepository();
    await track(repo, { drive: "cs_primary", title: show, s: season(show.id, 1) });
    const broken = {
      listTrackedSeasonStates: repo.listTrackedSeasonStates.bind(repo),
      listPendingReplacements: repo.listPendingReplacements.bind(repo),
      listActiveWorkflowRuns: repo.listActiveWorkflowRuns.bind(repo),
      listUserMessages: async () => {
        throw new Error(`relation "user_messages" does not exist ${"x".repeat(2000)}`);
      },
    };
    const lines: string[] = [];

    const read = await readTitleMessages({ repo: broken, scope: primary, tmdbId: 42, mediaType: "tv", sweepTimes: async () => [], log: (line) => lines.push(line) });

    expect(read).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("user_messages");
    expect(lines[0]!.length).toBeLessThan(300);
  });

  it("a failed workspace or settings lookup is caught the same way", async () => {
    const repo = new InMemoryWorkflowRepository();
    await track(repo, { drive: "cs_primary", title: show, s: season(show.id, 1) });
    const lines: string[] = [];
    const failing = async (): Promise<never> => {
      throw new Error("connect ECONNREFUSED");
    };

    expect(await readTitleMessages({ repo, scope: failing, tmdbId: 42, mediaType: "tv", sweepTimes: async () => [], log: (line) => lines.push(line) })).toBeNull();
    expect(await readTitleMessages({ repo, scope: primary, tmdbId: 42, mediaType: "tv", sweepTimes: failing, log: (line) => lines.push(line) })).toBeNull();
    expect(lines).toHaveLength(2);
  });
});

describe("nextPatrolLabel", () => {
  it("names today's next patrol, else tomorrow's first (明早 before noon)", () => {
    expect(nextPatrolLabel(["06:00", "21:00"], "14:02")).toBe("今天 21:00");
    expect(nextPatrolLabel(["06:00"], "14:02")).toBe("明早 06:00");
    expect(nextPatrolLabel(["06:00"], "05:00")).toBe("今天 06:00");
    expect(nextPatrolLabel(["23:30"], "23:40")).toBe("明天 23:30");
  });
});

describe("swapBadgeLabel — the 待换 badge beside the title", () => {
  it("counts a show's 待换 episodes; none → no badge", () => {
    expect(swapBadgeLabel("tv", [])).toBeNull();
    expect(swapBadgeLabel("tv", ["S01E24"])).toBe("1 集待换");
    expect(swapBadgeLabel("tv", ["S01E03", "S02E01"])).toBe("2 集待换");
  });

  it("a film says 待换资源 only while the film itself is 待换", () => {
    expect(swapBadgeLabel("movie", ["MOVIE"])).toBe("待换资源");
    expect(swapBadgeLabel("movie", [])).toBeNull();
  });
});
