/**
 * Storage brand registry — the per-(account, drive) capabilities the worker and
 * web share, keyed by `connected_storages.provider`. Replaces the old global
 * `MEDIA_TRACK_STORAGE_ADAPTER==="115"` switch: dispatch is now per-drive, so one
 * account can hold a 115 drive and a quark drive side by side (tree model).
 *
 * NOTE: `createExecutor` deliberately does NOT live here — building a protected
 * executor needs env (write-scope CIDs) + the apps/web protected wrapper, which
 * the pure workflow package must not import. apps/web owns the factory
 * (`createExecutorForBrand`); this registry holds only the pure, brand-identity
 * capabilities (uid parsing, auth-error classification, applicable resource kinds).
 */
import { parsePan115Uid } from "./account-credentials.js";
import type { ResourceType } from "./domain.js";
import { isGuangYaAuthError, parseGuangYaUid } from "./guangya-client.js";
import { isPan115AuthError } from "./pan115-cookie-client.js";
import { isQuarkAuthError, parseQuarkUid } from "./quark-cookie-client.js";

export type StorageProvider = "pan115" | "quark" | "guangya";
export type ResourceProviderKind = "pansou-115" | "pansou-quark" | "pansou-magnet" | "prowlarr";

export interface StorageBrand {
  provider: StorageProvider;
  /** Display name shown in the UI (switcher chip, settings tab). */
  label: string;
  /** Extract the instance-wide-unique account id from a credential cookie. */
  parseUid: (cookie: string) => string | null;
  /** Whether an error is this brand's dead-cookie signal (drives freeze on it). */
  isAuthError: (err: unknown) => boolean;
  /** Resource providers applicable to this brand. Quark has no magnet web API, so
   *  it omits "prowlarr" — magnet stays 115-only. */
  resourceProviderKinds: ResourceProviderKind[];
  /** Whether to strengthen the Chinese-subs soft default for this brand. When true,
   *  the agent prompt emphasizes that Chinese-titled resources from this drive are
   *  more likely to carry Chinese subs (these are Chinese-world drives where resources
   *  mostly come from the Chinese community). Set to false for magnet-only drives. */
  assumeChineseSubsFromChineseTitle: boolean;
}

export const STORAGE_BRANDS: StorageBrand[] = [
  {
    provider: "pan115",
    label: "115 网盘",
    parseUid: parsePan115Uid,
    isAuthError: isPan115AuthError,
    resourceProviderKinds: ["pansou-115", "prowlarr"],
    assumeChineseSubsFromChineseTitle: true,
  },
  {
    provider: "quark",
    label: "夸克网盘",
    parseUid: parseQuarkUid,
    isAuthError: isQuarkAuthError,
    resourceProviderKinds: ["pansou-quark"],
    assumeChineseSubsFromChineseTitle: true,
  },
  {
    provider: "guangya",
    label: "光鸭云盘",
    parseUid: parseGuangYaUid,
    isAuthError: isGuangYaAuthError,
    resourceProviderKinds: ["pansou-magnet", "prowlarr"],
    assumeChineseSubsFromChineseTitle: false,
  },
];

/**
 * Map a brand's resource-provider kinds to the PanSou link types its acquisitions
 * may transfer. A 夸克 drive can only save 夸克 share links; a 光鸭(磁力) drive can
 * only offline-download magnets; a 115 drive takes both 115 links and magnets.
 * Pure + brand-table-driven so the resource assembly stays testable.
 */
export function allowedResourceTypesForKinds(kinds: readonly string[]): ResourceType[] {
  if (kinds.includes("pansou-quark")) {
    return ["quark"];
  }
  if (kinds.includes("pansou-magnet")) {
    return ["magnet"];
  }
  return ["115", "magnet"];
}

export function getStorageBrand(provider: string): StorageBrand {
  const brand = STORAGE_BRANDS.find((b) => b.provider === provider);
  if (!brand) {
    throw new Error(`unknown storage brand: ${provider}`);
  }
  return brand;
}

/** Whether a provider string names a registered brand (used to widen the old
 *  `provider==="pan115"` filters to "any registered brand"). */
export function isRegisteredStorageProvider(provider: string): provider is StorageProvider {
  return STORAGE_BRANDS.some((b) => b.provider === provider);
}

/** Whether a brand can use Prowlarr (磁力/PT) — 115 yes, 夸克 no (no magnet API).
 *  Settings hides the Prowlarr block when no connected drive supports it. Safe on
 *  unknown providers (returns false, never throws). */
export function brandSupportsProwlarr(provider: string): boolean {
  return (
    isRegisteredStorageProvider(provider) &&
    getStorageBrand(provider).resourceProviderKinds.includes("prowlarr")
  );
}
