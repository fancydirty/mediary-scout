/**
 * Short-TTL + singleflight in-memory cache for resolved cloud-drive download links.
 *
 * Why singleflight matters: video players (Infuse, 网易爆米花, VidHub, IINA) fire
 * 2–4 concurrent Range probes on playback start (`bytes=0-1`, `bytes=0-65535`,
 * `bytes=tail`). Deduplicating in-flight resolutions prevents hammering 115/Quark
 * APIs simultaneously and shaves seconds off first-frame start time.
 */
import type { DriveDownloadLink } from "./ports.js";

export const DEFAULT_DOWNLOAD_LINK_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_CACHE_ENTRIES = 500;

interface CacheEntry {
  link: DriveDownloadLink;
  expiresAt: number;
}

export interface DriveDownloadCacheKeyInput {
  storageId: string;
  provider: string;
  fileId: string;
  userAgent?: string;
}

/** Build a cache key: 115 CDN links are strictly User-Agent-bound, so they key on
 *  `(storageId, fileId, provider, userAgent)`; all other 5 drives share across UAs. */
export function buildDriveDownloadCacheKey(input: DriveDownloadCacheKeyInput): string {
  const uaKey = input.provider === "pan115" ? (input.userAgent?.trim() ?? "") : "*";
  return `${input.storageId}\u0000${input.fileId}\u0000${input.provider}\u0000${uaKey}`;
}

interface InFlightEntry {
  promise: Promise<DriveDownloadLink>;
  controller: AbortController;
  waiters: number;
}

export class DriveDownloadLinkCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, InFlightEntry>();
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number;
  private readonly now: () => number;

  constructor(options?: {
    maxEntries?: number;
    defaultTtlMs?: number;
    now?: () => number;
  }) {
    this.maxEntries = options?.maxEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    this.defaultTtlMs = options?.defaultTtlMs ?? DEFAULT_DOWNLOAD_LINK_TTL_MS;
    this.now = options?.now ?? Date.now;
  }

  get(key: string): DriveDownloadLink | null {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    // Refresh insertion order for simple LRU eviction.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.link;
  }

  set(key: string, link: DriveDownloadLink, ttlMs?: number): void {
    const effectiveTtl = ttlMs ?? link.ttlMs ?? this.defaultTtlMs;
    if (effectiveTtl <= 0 || this.maxEntries <= 0) {
      return;
    }
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }
    this.entries.set(key, { link, expiresAt: this.now() + effectiveTtl });
  }

  /** Return a fresh cached link, join an already in-flight resolution for `key`, or
   *  call `resolve(sharedSignal)` once and cache its result. Rejections are never cached.
   *  When callers pass `signal`, the underlying `sharedSignal` is aborted ONLY when EVERY
   *  concurrent waiter sharing the in-flight entry has aborted — never disrupting sibling callers. */
  async getOrResolve(
    key: string,
    resolve: (signal: AbortSignal) => Promise<DriveDownloadLink>,
    signal?: AbortSignal,
  ): Promise<DriveDownloadLink> {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("Download link resolution aborted");
    }
    const cached = this.get(key);
    if (cached) {
      return cached;
    }
    let entry = this.inFlight.get(key);
    if (entry?.controller.signal.aborted) {
      entry = undefined;
    }
    if (!entry) {
      const controller = new AbortController();
      let rawPending: Promise<DriveDownloadLink>;
      try {
        rawPending = resolve(controller.signal);
      } catch (error) {
        return Promise.reject(error);
      }
      let created: InFlightEntry | undefined;
      const pending = rawPending
        .then((link) => {
          if (!controller.signal.aborted) {
            this.set(key, link);
          }
          return link;
        })
        .finally(() => {
          if (created && this.inFlight.get(key) === created) {
            this.inFlight.delete(key);
          }
        });
      // Prevent unhandled rejection if every waiter aborted before `pending` settles.
      pending.catch(() => undefined);
      created = { controller, waiters: 0, promise: pending };
      this.inFlight.set(key, created);
      entry = created;
    }

    entry.waiters += 1;
    if (!signal) {
      return entry.promise.finally(() => {
        entry!.waiters = Math.max(0, entry!.waiters - 1);
      });
    }

    return new Promise<DriveDownloadLink>((resolveWaiter, rejectWaiter) => {
      let settled = false;
      const releaseWaiter = (aborted: boolean) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        entry!.waiters = Math.max(0, entry!.waiters - 1);
        if (aborted && entry!.waiters === 0) {
          if (this.inFlight.get(key) === entry) {
            this.inFlight.delete(key);
          }
          entry!.controller.abort(signal.reason);
        }
      };
      const onAbort = () => {
        releaseWaiter(true);
        rejectWaiter(signal.reason ?? new Error("Download link resolution aborted"));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      entry!.promise.then(
        (link) => {
          releaseWaiter(false);
          resolveWaiter(link);
        },
        (err) => {
          releaseWaiter(false);
          rejectWaiter(err);
        },
      );
    });
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }

  /** Evict all cached entries (across any UA) for a specific `(storageId, fileId)`. */
  invalidateFile(storageId: string, fileId: string): void {
    const prefix = `${storageId}\u0000${fileId}\u0000`;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }
  }

  clear(): void {
    this.entries.clear();
    const pendingEntries = [...this.inFlight.values()];
    this.inFlight.clear();
    for (const entry of pendingEntries) {
      entry.controller.abort(new Error("Download link cache cleared"));
    }
  }

  size(): number {
    return this.entries.size;
  }
}
