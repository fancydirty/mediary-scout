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

export class DriveDownloadLinkCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<DriveDownloadLink>>();
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
   *  call `resolve()` once and cache its result. Rejections are never cached. */
  async getOrResolve(
    key: string,
    resolve: () => Promise<DriveDownloadLink>,
  ): Promise<DriveDownloadLink> {
    const cached = this.get(key);
    if (cached) {
      return cached;
    }
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }
    const pending = resolve()
      .then((link) => {
        this.set(key, link);
        return link;
      })
      .finally(() => {
        if (this.inFlight.get(key) === pending) {
          this.inFlight.delete(key);
        }
      });
    this.inFlight.set(key, pending);
    return pending;
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
    this.inFlight.clear();
  }

  size(): number {
    return this.entries.size;
  }
}
