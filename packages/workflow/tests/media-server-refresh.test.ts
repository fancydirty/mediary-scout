import { describe, expect, it } from "vitest";
import type { NotificationEvent } from "../src/domain.js";
import {
  extractLandedMediaEvents,
  refreshConfiguredMediaServers,
  refreshEmbyOrJellyfin,
  refreshPlexLibrary,
  validateMediaServerUrl,
  type MediaServerFetch,
} from "../src/media-server-refresh.js";

describe("media-server-refresh", () => {
  describe("validateMediaServerUrl", () => {
    it("accepts http/https URLs without credentials and strips trailing slashes", () => {
      expect(validateMediaServerUrl("http://192.168.100.1:8096///")).toEqual({
        ok: true,
        url: "http://192.168.100.1:8096",
      });
      expect(validateMediaServerUrl("https://emby.example.com/emby/")).toEqual({
        ok: true,
        url: "https://emby.example.com/emby",
      });
    });

    it("rejects non-http schemes, embedded credentials, query/hash, or malformed URLs", () => {
      expect(validateMediaServerUrl("192.168.1.2:8096").ok).toBe(false);
      expect(validateMediaServerUrl("ftp://192.168.1.2:8096").ok).toBe(false);
      expect(validateMediaServerUrl("http://user:pass@192.168.1.2:8096").ok).toBe(false);
      expect(validateMediaServerUrl("http://192.168.1.2:8096?api_key=abc").ok).toBe(false);
    });
  });

  describe("extractLandedMediaEvents", () => {
    const mkNotif = (overrides: Partial<NotificationEvent>): NotificationEvent => ({
      id: "n1",
      workflowRunId: "run_1",
      kind: "tracking_initialized",
      title: "Test",
      body: "Body",
      createdAt: "2026-11-16T01:00:00.000Z",
      ...overrides,
    });

    it("selects only notifications where real files landed this run", () => {
      const movieLanded = mkNotif({
        id: "n_movie",
        kind: "package_initialized",
        report: {
          titleName: "沙丘2",
          seasonLabel: null,
          status: "acquired",
          lines: ["已获取入库"],
          newlyObtained: [],
          realMissing: [],
          tmdbId: 693134,
          mediaType: "movie",
          year: 2024,
        },
      });
      const routinePatrol = mkNotif({
        id: "n_routine",
        kind: "already_current",
        trigger: "scheduled",
        report: {
          titleName: "迷宫饭",
          seasonLabel: "第 1 季",
          status: "airing",
          lines: ["已是最新"],
          newlyObtained: [],
          realMissing: [],
          tmdbId: 200,
          mediaType: "anime",
        },
      });
      const patrolNewEp = mkNotif({
        id: "n_patrol_new",
        kind: "episodes_restored",
        trigger: "scheduled",
        report: {
          titleName: "怪奇物语",
          seasonLabel: "第 5 季",
          status: "airing",
          lines: ["更新 E03"],
          newlyObtained: ["E03"],
          realMissing: [],
          tmdbId: 66732,
          mediaType: "tv",
        },
      });
      const noCov = mkNotif({
        id: "n_nocov",
        kind: "no_coverage",
        report: {
          titleName: "空片",
          seasonLabel: null,
          status: "no_coverage",
          lines: ["暂无资源"],
          newlyObtained: [],
          realMissing: [],
        },
      });
      const failed = mkNotif({
        id: "n_fail",
        kind: "transfer_failed",
        report: {
          titleName: "坏片",
          seasonLabel: null,
          status: "failed",
          lines: ["失败"],
          newlyObtained: [],
          realMissing: [],
        },
      });
      const replaced = mkNotif({
        id: "n_rep",
        kind: "replacement_done",
        report: {
          titleName: "奥德赛",
          seasonLabel: null,
          status: "replaced",
          lines: ["已换成新版本"],
          newlyObtained: [],
          realMissing: [],
          tmdbId: 1368337,
          mediaType: "movie",
        },
      });
      // A routine patrol of an already-complete season also reports `complete` — no file changed.
      const routineComplete = mkNotif({
        id: "n_complete_routine",
        kind: "tracking_completed",
        trigger: "scheduled",
        report: {
          titleName: "已完结剧",
          seasonLabel: "第 1 季",
          status: "complete",
          lines: ["全 1 季已完整获取"],
          newlyObtained: [],
          realMissing: [],
          tmdbId: 300,
          mediaType: "tv",
        },
      });

      const landed = extractLandedMediaEvents([
        movieLanded,
        routinePatrol,
        routineComplete,
        patrolNewEp,
        noCov,
        failed,
        replaced,
      ]);
      expect(landed.map((item) => item.titleName)).toEqual(["沙丘2", "怪奇物语", "奥德赛"]);
    });

    it("coalesces the same title+season appearing twice (per-season records of one run)", () => {
      const mk = (id: string): NotificationEvent => ({
        id,
        workflowRunId: "run_same",
        kind: "episodes_restored",
        title: "某剧",
        body: "",
        createdAt: "2026-11-16T01:00:00.000Z",
        trigger: "scheduled",
        report: {
          titleName: "某剧",
          seasonLabel: "第 1 季",
          status: "airing",
          lines: [],
          newlyObtained: ["E02"],
          realMissing: [],
          mediaType: "tv",
        },
      });
      expect(extractLandedMediaEvents([mk("a"), mk("a_copy")])).toHaveLength(1);
    });
  });

  describe("Emby / Jellyfin / Plex / Webhook adapters", () => {
    it("sends POST /Library/Refresh with X-Emby-Token header for Emby and Jellyfin", async () => {
      const calls: Array<{ url: string; method: string; headers?: Record<string, string> }> = [];
      const fakeFetch: MediaServerFetch = async (url, init) => {
        calls.push({ url, method: init.method, ...(init.headers ? { headers: init.headers } : {}) });
        return { ok: true, status: 204, text: async () => "" };
      };

      await refreshEmbyOrJellyfin({
        kind: "emby",
        baseUrl: "http://192.168.100.1:8096/",
        apiKey: "emby_secret_123",
        fetchImpl: fakeFetch,
      });

      expect(calls).toEqual([
        {
          url: "http://192.168.100.1:8096/Library/Refresh",
          method: "POST",
          headers: { "X-Emby-Token": "emby_secret_123" },
        },
      ]);
    });

    it("discovers Plex sections via JSON or XML and refreshes each library section", async () => {
      const calls: Array<{ url: string; method: string; headers?: Record<string, string> }> = [];
      const fakeFetch: MediaServerFetch = async (url, init) => {
        calls.push({ url, method: init.method, ...(init.headers ? { headers: init.headers } : {}) });
        if (url.endsWith("/library/sections")) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                MediaContainer: {
                  Directory: [
                    { key: "1", title: "Movies" },
                    { key: "2", title: "TV Shows" },
                  ],
                },
              }),
          };
        }
        return { ok: true, status: 200, text: async () => "" };
      };

      const res = await refreshPlexLibrary({
        baseUrl: "http://192.168.100.1:32400/",
        token: "plex_tok_xyz",
        fetchImpl: fakeFetch,
      });

      expect(res.refreshedSections).toBe(2);
      expect(calls.map((c) => c.url)).toEqual([
        "http://192.168.100.1:32400/library/sections",
        "http://192.168.100.1:32400/library/sections/1/refresh",
        "http://192.168.100.1:32400/library/sections/2/refresh",
      ]);
      expect(calls[0]?.headers?.["X-Plex-Token"]).toBe("plex_tok_xyz");
    });

    it("coalesces a batch of landed titles into ONE refresh per configured server + ONE webhook POST", async () => {
      const hitUrls: string[] = [];
      let webhookBody: unknown = null;
      const fakeFetch: MediaServerFetch = async (url, init) => {
        hitUrls.push(url);
        if (url === "https://fnos-bridge.local/hook" && init.body) {
          webhookBody = JSON.parse(init.body);
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ MediaContainer: { Directory: [] } }) };
      };

      const settingsMap = new Map<string, string>([
        ["media_server_emby_url", "http://192.168.100.1:8096"],
        ["media_server_emby_api_key", "ekey"],
        ["media_server_jellyfin_url", "http://192.168.100.1:8097"],
        ["media_server_jellyfin_api_key", "jkey"],
        ["media_server_webhook_url", "https://fnos-bridge.local/hook"],
      ]);

      const out = await refreshConfiguredMediaServers({
        repository: { getSetting: async (k) => settingsMap.get(k) ?? null },
        items: [
          { titleName: "沙丘2", mediaType: "movie", tmdbId: 693134, year: 2024 },
          { titleName: "怪奇物语", seasonLabel: "第 5 季", mediaType: "tv", tmdbId: 66732, newlyObtained: ["E03"] },
        ],
        delayMs: 0,
        fetchImpl: fakeFetch,
      });

      expect(out.refreshed).toEqual(["Emby", "Jellyfin", "入库 Webhook"]);
      expect(out.failures).toEqual([]);
      expect(hitUrls).toEqual([
        "http://192.168.100.1:8096/Library/Refresh",
        "http://192.168.100.1:8097/Library/Refresh",
        "https://fnos-bridge.local/hook",
      ]);
      expect(webhookBody).toMatchObject({
        event: "library.landed",
        test: false,
        items: [
          { titleName: "沙丘2", mediaType: "movie", tmdbId: 693134 },
          { titleName: "怪奇物语", seasonLabel: "第 5 季", mediaType: "tv", newlyObtained: ["E03"] },
        ],
      });
    });


    it("treats zero Plex sections as a real failure (wrong path / proxy login page)", async () => {
      const fakeFetch: MediaServerFetch = async (url) => ({
        ok: true,
        status: 200,
        text: async () => (url.endsWith("/library/sections") ? "<html>login</html>" : ""),
      });
      const settingsMap = new Map<string, string>([
        ["media_server_plex_url", "http://127.0.0.1:32400"],
        ["media_server_plex_token", "tok"],
      ]);
      const out = await refreshConfiguredMediaServers({
        repository: { getSetting: async (k) => settingsMap.get(k) ?? null },
        items: [{ titleName: "x" }],
        delayMs: 0,
        fetchImpl: fakeFetch,
      });
      expect(out.refreshed).toEqual([]);
      expect(out.failures[0]?.server).toBe("Plex");
    });

    it("keeps scanning the remaining Plex sections when one section fails", async () => {
      const refreshed: string[] = [];
      const fakeFetch: MediaServerFetch = async (url) => {
        if (url.endsWith("/library/sections")) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({ MediaContainer: { Directory: [{ key: "1" }, { key: "2" }, { key: "3" }] } }),
          };
        }
        refreshed.push(url);
        return { ok: !url.includes("/sections/2/"), status: url.includes("/sections/2/") ? 500 : 200, text: async () => "" };
      };
      await expect(
        refreshPlexLibrary({ baseUrl: "http://127.0.0.1:32400", token: "tok", fetchImpl: fakeFetch }),
      ).rejects.toThrow(/2/);
      expect(refreshed).toEqual([
        "http://127.0.0.1:32400/library/sections/1/refresh",
        "http://127.0.0.1:32400/library/sections/2/refresh",
        "http://127.0.0.1:32400/library/sections/3/refresh",
      ]);
    });

    it("honours an explicitly cleared URL override instead of falling back to the saved one", async () => {
      const hit: string[] = [];
      const fakeFetch: MediaServerFetch = async (url) => {
        hit.push(url);
        return { ok: true, status: 204, text: async () => "" };
      };
      const settingsMap = new Map<string, string>([
        ["media_server_emby_url", "http://saved.local:8096"],
        ["media_server_emby_api_key", "ekey"],
      ]);
      const out = await refreshConfiguredMediaServers({
        repository: { getSetting: async (k) => settingsMap.get(k) ?? null },
        items: [],
        test: true,
        delayMs: 0,
        overrides: { embyUrl: "" },
        fetchImpl: fakeFetch,
      });
      expect(hit).toEqual([]);
      expect(out.refreshed).toEqual([]);
    });

    it("never leaks tokens/keys in failure messages", async () => {
      const fakeFetch: MediaServerFetch = async () => {
        throw new Error("connect ECONNREFUSED 192.168.100.99:8096 secret_key_leak");
      };
      const settingsMap = new Map<string, string>([
        ["media_server_emby_url", "http://192.168.100.99:8096"],
        ["media_server_emby_api_key", "secret_key_leak"],
      ]);

      const out = await refreshConfiguredMediaServers({
        repository: { getSetting: async (k) => settingsMap.get(k) ?? null },
        items: [{ titleName: "沙丘2" }],
        delayMs: 0,
        fetchImpl: fakeFetch,
      });

      expect(out.refreshed).toEqual([]);
      expect(out.failures).toHaveLength(1);
      expect(out.failures[0]?.error).not.toContain("secret_key_leak");
    });
  });
});
