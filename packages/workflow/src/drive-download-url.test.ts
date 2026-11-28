import { describe, expect, it, vi } from "vitest";
import {
  buildDriveDownloadCacheKey,
  DriveDownloadLinkCache,
} from "./drive-download-cache.js";
import { GuangYaAuthError, GuangYaClient } from "./guangya-client.js";
import { GuangYaStorageExecutor } from "./guangya-storage-executor.js";
import { Pan115AuthError, Pan115CookieClient } from "./pan115-cookie-client.js";
import { m115Decode, m115Encode, m115GenerateKey } from "./pan115-lixian-cipher.js";
import { Pan123AuthError, Pan123Client, unwrapPan123DownloadParams } from "./pan123-client.js";
import { Pan123StorageExecutor } from "./pan123-storage-executor.js";
import { DriveFileNotFoundError, isDriveFileNotFoundError } from "./ports.js";
import {
  mergeCookies,
  QUARK_PROFILE,
  QuarkAuthError,
  QuarkCookieClient,
  splitSetCookieHeader,
  UC_PROFILE,
} from "./quark-cookie-client.js";
import { assertSafeExternalHttpUrl, isPrivateOrReservedIp } from "./safe-external-url.js";
import { QuarkStorageExecutor } from "./quark-storage-executor.js";
import { Pan115ApiGuard, Storage115Executor } from "./storage-115-executor.js";
import { TianyiAuthError, TianyiClient } from "./tianyi-client.js";
import { TianyiStorageExecutor } from "./tianyi-storage-executor.js";

describe("m115 cipher + 115 getDownloadUrl", () => {
  it("m115Encode produces valid base64 of 128-byte RSA blocks and validates key length", () => {
    const key = m115GenerateKey();
    expect(key.length).toBe(16);
    const encoded = m115Encode(new TextEncoder().encode(JSON.stringify({ pickcode: "abc123" })), key);
    const raw = Buffer.from(encoded, "base64");
    expect(raw.length % 128).toBe(0);
    expect(raw.length).toBeGreaterThanOrEqual(128);
    expect(() => m115Encode(new Uint8Array([1]), new Uint8Array(8))).toThrow(/16-byte/);
    expect(() => m115Decode("AAAA", new Uint8Array(8))).toThrow(/16-byte/);
  });

  it("115 client caches fid->pickcode, forwards player UA, and throws DriveFileNotFoundError when deleted", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const client = new Pan115CookieClient({
      cookie: "UID=12345_A1_1; CID=c1; SEID=s1",
      fetchJson: async (url, init) => {
        calls.push({ url, headers: init.headers });
        if (url.includes("/files/get_info")) {
          if (url.includes("file_id=999999")) {
            return { state: false, errno: 50003, error: "文件不存在" };
          }
          return {
            state: true,
            data: [{ pc: "pick_abc", n: "Movie.mkv", s: "4096000000", play_long: 7200 }],
          };
        }
        return { state: false, errno: 990001, error: "登录超时，请重新登录。" };
      },
    });

    const info = await client.getFileInfo({ fileId: "12345" });
    expect(info).toEqual({
      fileId: "12345",
      pickcode: "pick_abc",
      fileName: "Movie.mkv",
      fileSize: 4096000000,
      durationSeconds: 7200,
    });

    const missing = await client.getFileInfo({ fileId: "999999" });
    expect(missing).toBeNull();

    await expect(client.getDownloadUrl({ fileId: "999999", userAgent: "Infuse/8.0" })).rejects.toSatisfy(
      (err: unknown) => isDriveFileNotFoundError(err) && err.provider === "pan115" && err.fileId === "999999",
    );

    // Dead cookie on downurl surfaces Pan115AuthError (never DriveFileNotFoundError)
    // and passes the exact caller User-Agent to proapi downurl.
    await expect(client.getDownloadUrl({ fileId: "12345", userAgent: "Infuse/8.0" })).rejects.toBeInstanceOf(
      Pan115AuthError,
    );
    const downurlCall = calls.find((c) => c.url.includes("proapi.115.com/app/chrome/downurl"));
    expect(downurlCall?.headers["User-Agent"]).toBe("Infuse/8.0");
  });

  it("Storage115Executor delegates getDownloadUrl preserving `this` binding on real class instances", async () => {
    class StatefulApi {
      private readonly prefix = "https://cdn.115.example/";
      async createFolder() { return "0"; }
      async listItems() { return []; }
      async getDirectoryInfo() { return null; }
      async receiveShare() { return { ok: true, message: "" }; }
      async addOfflineTask() { return { ok: true, message: "" }; }
      async removeOfflineTask() { return { ok: true, message: "" }; }
      async listOfflineTasks() { return []; }
      async moveItems() { return { ok: true, message: "" }; }
      async deleteItems() { return { ok: true, message: "" }; }
      async renameFile() { return { ok: true, message: "" }; }
      async getDownloadUrl(input: { fileId: string; userAgent?: string }) {
        return {
          url: `${this.prefix}${input.fileId}`,
          headers: { "User-Agent": input.userAgent ?? "default" },
          supportsRedirect: true,
          userAgentBound: true,
        };
      }
    }
    const executor = new Storage115Executor({
      api: new StatefulApi(),
      apiGuard: new Pan115ApiGuard({ minDelayMs: 0, maxCallsPerOperation: 10 }),
    });
    const link = await executor.getDownloadUrl({ fileId: "f1", userAgent: "IINA/1.3" });
    expect(link.url).toBe("https://cdn.115.example/f1");
    expect(link.headers["User-Agent"]).toBe("IINA/1.3");
    expect(link.supportsRedirect).toBe(true);
  });
});

describe("Quark & UC getDownloadUrl", () => {
  it("uses desktop downloadUserAgent, merges rotated __puus Set-Cookie, and marks supportsRedirect=false", async () => {
    for (const profile of [QUARK_PROFILE, UC_PROFILE]) {
      let capturedHeaders: Record<string, string> = {};
      const client = new QuarkCookieClient({
        cookie: "__pus=old_pus; __puus=old_puus; __uid=u1",
        profile,
        fetchDownloadResponse: async (_url, init) => {
          capturedHeaders = init.headers;
          return {
            body: {
              code: 0,
              data: [
                {
                  fid: "fid-1",
                  file_name: "Show.S01E01.mkv",
                  size: 2_500_000_000,
                  download_url: `https://dl.${profile.key}.example/video.mkv`,
                },
              ],
            },
            setCookies: [
              "__puus=fresh_puus_token; Path=/; HttpOnly",
              "stale_key=; Max-Age=0; Path=/",
            ],
          };
        },
      });
      const executor = new QuarkStorageExecutor({ client, profile });
      const link = await executor.getDownloadUrl({ fileId: "fid-1" });
      expect(capturedHeaders["User-Agent"]).toBe(profile.downloadUserAgent);
      expect(link.supportsRedirect).toBe(false);
      expect(link.url).toBe(`https://dl.${profile.key}.example/video.mkv`);
      expect(link.headers["Cookie"]).toContain("__puus=fresh_puus_token");
      expect(link.headers["Cookie"]).toContain("__pus=old_pus");
      expect(link.headers["Referer"]).toBe(profile.referer);
      expect(link.headers["User-Agent"]).toBe(profile.downloadUserAgent);
      expect(link.fileSize).toBe(2_500_000_000);
    }
  });

  it("maps file-not-found to DriveFileNotFoundError and 31001 to QuarkAuthError", async () => {
    const notFoundClient = new QuarkCookieClient({
      cookie: "__uid=u1",
      fetchDownloadResponse: async () => ({
        body: { code: 41008, message: "file not found" },
        setCookies: [],
      }),
    });
    await expect(notFoundClient.getDownloadUrl({ fileId: "gone-1" })).rejects.toBeInstanceOf(
      DriveFileNotFoundError,
    );

    const authDeadClient = new QuarkCookieClient({
      cookie: "__uid=u1",
      fetchDownloadResponse: async () => ({
        body: { code: 31001, message: "require login [guest]" },
        setCookies: [],
      }),
    });
    await expect(authDeadClient.getDownloadUrl({ fileId: "fid-1" })).rejects.toBeInstanceOf(QuarkAuthError);
  });

  it("mergeCookies preserves valid cookies on empty Set-Cookie values and removes expired ones", () => {
    const merged = mergeCookies("a=1; b=2; c=3", [
      "a=; Path=/",
      "b=deleted; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
      "c=updated; Path=/",
      "d=new; Max-Age=3600",
    ]);
    expect(merged).toContain("a=1");
    expect(merged).not.toContain("b=");
    expect(merged).toContain("c=updated");
    expect(merged).toContain("d=new");
  });
});

describe("123Pan getDownloadUrl", () => {
  it("resolves bigint-safe numeric FileId via file/info -> download_info -> base64 params -> 302", async () => {
    const bigId = "123456789012345678";
    const encodedParams = Buffer.from("https://dispatch.123pan.example/dl?token=xyz").toString("base64");
    const bodies: string[] = [];
    const client = new Pan123Client({
      token: "tok-123",
      fetchImpl: async (url, init) => {
        if (init.body) bodies.push(init.body);
        if (url.includes("/file/info")) {
          return {
            status: 200,
            text: JSON.stringify({
              code: 0,
              data: {
                infoList: [
                  {
                    FileId: "123456789012345678",
                    FileName: "Ep01.mkv",
                    Size: 900000000,
                    Etag: "md5abc",
                    S3KeyFlag: "181-0",
                    Type: 0,
                    Trashed: 0,
                  },
                ],
              },
            }),
          };
        }
        return {
          status: 200,
          text: JSON.stringify({
            code: 0,
            data: {
              DownloadUrl: `https://download-cdn.123pan.example/dl?params=${encodeURIComponent(encodedParams)}`,
            },
          }),
        };
      },
      resolveRedirect: async (url) => {
        expect(url).toBe("https://dispatch.123pan.example/dl?token=xyz");
        return "https://edge-cdn.123pan.example/final/Ep01.mkv";
      },
    });
    const executor = new Pan123StorageExecutor({ client });
    const link = await executor.getDownloadUrl({ fileId: bigId });
    expect(link.url).toBe("https://edge-cdn.123pan.example/final/Ep01.mkv");
    expect(link.supportsRedirect).toBe(true);
    expect(link.fileName).toBe("Ep01.mkv");
    expect(link.fileSize).toBe(900000000);
    // Verify numeric literal splicing (no quotes around 18-digit int64 FileId)
    expect(bodies[0]).toContain(`"FileId":${bigId}`);
    expect(bodies[1]).toContain(`"fileId":${bigId}`);
  });

  it("throws DriveFileNotFoundError when trashed or absent, and Pan123AuthError on 20101", async () => {
    const trashedClient = new Pan123Client({
      token: "tok",
      fetchImpl: async () => ({
        status: 200,
        text: JSON.stringify({ code: 0, data: { infoList: [{ FileId: 55, Trashed: 1 }] } }),
      }),
    });
    await expect(trashedClient.getDownloadUrl({ fileId: "55" })).rejects.toBeInstanceOf(
      DriveFileNotFoundError,
    );

    const authClient = new Pan123Client({
      token: "tok",
      fetchImpl: async () => ({
        status: 200,
        text: JSON.stringify({ code: 20101, message: "未登录" }),
      }),
    });
    await expect(authClient.getDownloadUrl({ fileId: "55" })).rejects.toBeInstanceOf(Pan123AuthError);
    expect(unwrapPan123DownloadParams("https://plain.example/a.mkv")).toBe("https://plain.example/a.mkv");
  });
});

describe("Guangya getDownloadUrl", () => {
  it("calls get_res_download_url with auto-refresh and handles missing/auth errors", async () => {
    let refreshed = false;
    let attempt = 0;
    const client = new GuangYaClient({
      accessToken: "expired-at",
      refreshToken: "rt-1",
      deviceId: "dev123",
      onTokensRefreshed: () => {
        refreshed = true;
      },
      fetchImpl: async (url) => {
        if (url.includes("/v1/auth/token")) {
          return new Response(JSON.stringify({ access_token: "fresh-at", refresh_token: "rt-2" }), {
            status: 200,
          });
        }
        attempt += 1;
        if (attempt === 1) {
          return new Response(JSON.stringify({ code: 110, msg: "token expired" }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            msg: "success",
            data: { signedUrl: "https://cdn.guangya.example/movie.mkv", fileName: "movie.mkv", fileSize: 1234 },
          }),
          { status: 200 },
        );
      },
    });
    const executor = new GuangYaStorageExecutor({ client });
    const link = await executor.getDownloadUrl({ fileId: "gy-1" });
    expect(refreshed).toBe(true);
    expect(link.url).toBe("https://cdn.guangya.example/movie.mkv");
    expect(link.supportsRedirect).toBe(true);

    const notFoundClient = new GuangYaClient({
      accessToken: "at",
      refreshToken: "rt",
      fetchImpl: async () => new Response(JSON.stringify({ code: 203, msg: "文件不存在" }), { status: 200 }),
    });
    await expect(notFoundClient.getDownloadUrl({ fileId: "missing" })).rejects.toBeInstanceOf(
      DriveFileNotFoundError,
    );

    const deadClient = new GuangYaClient({
      accessToken: "at",
      refreshToken: "rt",
      fetchImpl: async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 }),
    });
    await expect(deadClient.getDownloadUrl({ fileId: "f1" })).rejects.toBeInstanceOf(GuangYaAuthError);
  });
});

describe("Tianyi getDownloadUrl (PC HMAC API)", () => {
  it("lazily fetches sessionSecret via renewSession, signs HMAC-SHA1, unwraps &amp;/http, and follows 302", async () => {
    let persistedSecret: string | undefined;
    let sawSignature = false;
    const client = new TianyiClient({
      sessionKey: "SK-old",
      accessToken: "AT-1",
      refreshToken: "RT-1",
      onCredentialRefresh: (creds) => {
        persistedSecret = creds.sessionSecret;
      },
      fetchImpl: async (url, init) => {
        if (url.includes("/getSessionForPC.action")) {
          return {
            status: 200,
            text: JSON.stringify({
              sessionKey: "SK-new",
              sessionSecret: "SECRET-HEX",
              accessToken: "AT-1",
              refreshToken: "RT-1",
              loginName: "13800138000",
            }),
          };
        }
        expect(url).toContain("https://api.cloud.189.cn/getFileDownloadUrl.action");
        expect(init.headers["SessionKey"]).toBe("SK-new");
        expect(init.headers["Signature"]).toMatch(/^[A-F0-9]{40}$/);
        sawSignature = true;
        return {
          status: 200,
          text: JSON.stringify({
            res_code: 0,
            fileDownloadUrl: "http://download.cloud.189.cn/file?a=1&amp;b=2",
          }),
        };
      },
      resolveRedirect: async (url) => {
        expect(url).toBe("https://download.cloud.189.cn/file?a=1&b=2");
        return "https://cdn-edge.189.example/video.mkv";
      },
    });
    const executor = new TianyiStorageExecutor({ client });
    const link = await executor.getDownloadUrl({ fileId: "924511245739356595" });
    expect(persistedSecret).toBe("SECRET-HEX");
    expect(sawSignature).toBe(true);
    expect(link.url).toBe("https://cdn-edge.189.example/video.mkv");
    expect(link.supportsRedirect).toBe(true);
  });

  it("maps FileNotFound to DriveFileNotFoundError and dead session to TianyiAuthError", async () => {
    const missingClient = new TianyiClient({
      sessionKey: "SK",
      sessionSecret: "SS",
      accessToken: "AT",
      refreshToken: "RT",
      fetchImpl: async () => ({
        status: 400,
        text: JSON.stringify({ errorCode: "FileNotFound", errorMsg: "文件不存在" }),
      }),
    });
    await expect(missingClient.getDownloadUrl({ fileId: "999" })).rejects.toBeInstanceOf(
      DriveFileNotFoundError,
    );

    const deadClient = new TianyiClient({
      sessionKey: "SK",
      sessionSecret: "SS",
      accessToken: "",
      refreshToken: "",
      fetchImpl: async () => ({
        status: 400,
        text: JSON.stringify({ errorCode: "InvalidSessionKey", errorMsg: "check ip error" }),
      }),
    });
    await expect(deadClient.getDownloadUrl({ fileId: "999" })).rejects.toBeInstanceOf(TianyiAuthError);
  });
});

describe("DriveDownloadLinkCache", () => {
  it("deduplicates concurrent resolutions (singleflight), separates 115 UAs, and expires by TTL", async () => {
    let now = 1_000_000;
    const cache = new DriveDownloadLinkCache({ now: () => now, defaultTtlMs: 60_000 });

    const k115A = buildDriveDownloadCacheKey({
      storageId: "cs_1",
      provider: "pan115",
      fileId: "f1",
      userAgent: "Infuse/8",
    });
    const k115B = buildDriveDownloadCacheKey({
      storageId: "cs_1",
      provider: "pan115",
      fileId: "f1",
      userAgent: "IINA/1.3",
    });
    expect(k115A).not.toBe(k115B);

    const k123A = buildDriveDownloadCacheKey({
      storageId: "cs_2",
      provider: "pan123",
      fileId: "f1",
      userAgent: "Infuse/8",
    });
    const k123B = buildDriveDownloadCacheKey({
      storageId: "cs_2",
      provider: "pan123",
      fileId: "f1",
      userAgent: "IINA/1.3",
    });
    expect(k123A).toBe(k123B);

    const resolver = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 15));
      return { url: "https://cdn.example/f1", headers: {}, supportsRedirect: true, ttlMs: 5_000 };
    });

    // Three concurrent probes → single upstream call
    const [r1, r2, r3] = await Promise.all([
      cache.getOrResolve(k115A, resolver),
      cache.getOrResolve(k115A, resolver),
      cache.getOrResolve(k115A, resolver),
    ]);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(r1.url).toBe("https://cdn.example/f1");
    expect(r2).toBe(r1);
    expect(r3).toBe(r1);

    // Advance past 5s TTL → resolves again
    now += 6_000;
    await cache.getOrResolve(k115A, resolver);
    expect(resolver).toHaveBeenCalledTimes(2);

    // invalidateFile removes entries for all UAs of that file
    cache.set(k115B, { url: "https://cdn.example/f1-b", headers: {}, supportsRedirect: true });
    cache.invalidateFile("cs_1", "f1");
    expect(cache.get(k115A)).toBeNull();
    expect(cache.get(k115B)).toBeNull();

    // Provider disambiguates identical (storageId, fileId) keys, and maxEntries<=0 never inserts
    const kSameIdQuark = buildDriveDownloadCacheKey({ storageId: "s_shared", provider: "quark", fileId: "f1" });
    const kSameIdUc = buildDriveDownloadCacheKey({ storageId: "s_shared", provider: "uc", fileId: "f1" });
    expect(kSameIdQuark).not.toBe(kSameIdUc);

    const zeroCache = new DriveDownloadLinkCache({ maxEntries: 0 });
    zeroCache.set(kSameIdQuark, { url: "https://cdn.example/a", headers: {}, supportsRedirect: false });
    expect(zeroCache.size()).toBe(0);
  });
});

describe("OCR hardening regressions (cipher, SSRF, transport errors, Set-Cookie)", () => {
  it("rejects truncated RSA ciphertext in m115Decode", () => {
    const key = m115GenerateKey();
    expect(() => m115Decode(Buffer.alloc(64, 1).toString("base64"), key)).toThrow(/multiple of 128/);
  });

  it("Pan115CookieClient.getFileInfo throws transient error (never null) on malformed state:true payload", async () => {
    const client = new Pan115CookieClient({
      cookie: "UID=1_A_1",
      fetchJson: async () => ({ state: true, data: [] }),
    });
    await expect(client.getFileInfo({ fileId: "999" })).rejects.toThrow(/PAN115_FILE_INFO_FAILED/);
  });

  it("Pan123Client preserves literal + in base64 params, ignores ENOTFOUND DNS errors, and blocks SSRF targets", async () => {
    // Standard base64 with '+' in query string:
    const target = "https://cdn.123pan.example/dl?sig=a+b&x=1";
    const b64WithPlus = Buffer.from(target, "utf8").toString("base64");
    expect(unwrapPan123DownloadParams(`https://dl.123pan.cn/x?params=${b64WithPlus}`)).toBe(target);

    // DNS ENOTFOUND must NOT become DriveFileNotFoundError
    const dnsFailClient = new Pan123Client({
      token: "tok",
      fetchImpl: async () => {
        throw new Error("getaddrinfo ENOTFOUND www.123pan.com");
      },
    });
    const err = await dnsFailClient.getDownloadUrl({ fileId: "42" }).catch((e) => e);
    expect(isDriveFileNotFoundError(err)).toBe(false);

    // Private/loopback redirect Location is blocked (SSRF guard)
    const ssrfClient = new Pan123Client({
      token: "tok",
      fetchImpl: async (url) => {
        if (url.includes("/file/info")) {
          return {
            status: 200,
            text: JSON.stringify({
              code: 0,
              data: { infoList: [{ FileId: 42, FileName: "a.mkv", Size: 100, Etag: "e", S3KeyFlag: "s", Type: 0 }] },
            }),
          };
        }
        if (url.includes("/file/download_info")) {
          return {
            status: 200,
            text: JSON.stringify({ code: 0, data: { DownloadUrl: "https://cdn.123pan.cn/dispatch" } }),
          };
        }
        return { status: 302, text: "", location: "http://169.254.169.254/latest/meta-data" };
      },
    });
    await expect(ssrfClient.getDownloadUrl({ fileId: "42" })).rejects.toThrow(/private\/internal/);
  });

  it("splitSetCookieHeader splits multiple cookies while preserving commas inside Expires dates (including terminal Expires)", () => {
    const combined =
      "__puus=abc123; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/, other=val; Max-Age=3600";
    expect(splitSetCookieHeader(combined)).toEqual([
      "__puus=abc123; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/",
      "other=val; Max-Age=3600",
    ]);
    const terminalExpires =
      "a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT, __puus=rotated; Path=/";
    expect(splitSetCookieHeader(terminalExpires)).toEqual([
      "a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT",
      "__puus=rotated; Path=/",
    ]);
  });

  it("safe-external-url allows fc/fd public DNS names while blocking IPv6 ULA and IPv4-mapped loopback literals", () => {
    expect(assertSafeExternalHttpUrl("https://fcdn.189.cn/video.mkv", "TEST")).toBe("https://fcdn.189.cn/video.mkv");
    expect(assertSafeExternalHttpUrl("https://fd.123pan.cn/video.mkv", "TEST")).toBe("https://fd.123pan.cn/video.mkv");
    expect(() => assertSafeExternalHttpUrl("http://[fc00::1]/secret", "TEST")).toThrow(/private\/internal/);
    expect(() => assertSafeExternalHttpUrl("http://[::ffff:127.0.0.1]/secret", "TEST")).toThrow(/private\/internal/);
    expect(isPrivateOrReservedIp("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateOrReservedIp("8.8.8.8")).toBe(false);
  });

  it("TianyiClient blocks loopback/private download URLs", async () => {
    const client = new TianyiClient({
      sessionKey: "SK",
      sessionSecret: "SS",
      accessToken: "AT",
      refreshToken: "RT",
      fetchImpl: async () => ({
        status: 200,
        text: JSON.stringify({ res_code: 0, fileDownloadUrl: "http://127.0.0.1:8080/internal" }),
      }),
    });
    await expect(client.getDownloadUrl({ fileId: "123" })).rejects.toThrow(/private\/internal/);
  });
});
