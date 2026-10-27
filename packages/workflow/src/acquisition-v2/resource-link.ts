import type { ResourceType } from "../domain.js";
import { parseGuangYaShareUrl } from "../guangya-client.js";
import { parsePan123ShareUrl } from "../pan123-storage-executor.js";
import { parseQuarkShareUrl, parseUcShareUrl } from "../quark-storage-executor.js";
import { parsePan115ShareUrl } from "../storage-115-executor.js";
import type { StorageProvider } from "../storage-brands.js";
import { parseTianyiShareUrl } from "../tianyi-storage-executor.js";
import { deadLinkKey } from "./dead-links.js";

/**
 * Derive a candidate's resource channel / drive brand from its share or magnet URL.
 * Uses the exact same URL parsers as the storage executors so classification and
 * transfer execution can never drift apart.
 */
export function brandOfUrl(url: string): Exclude<ResourceType, "manual"> | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (/^magnet:/i.test(trimmed)) return "magnet";
  if (parsePan115ShareUrl(trimmed) !== null) return "115";
  if (parseQuarkShareUrl(trimmed) !== null) return "quark";
  if (parseUcShareUrl(trimmed) !== null) return "uc";
  if (parsePan123ShareUrl(trimmed) !== null) return "123";
  if (parseTianyiShareUrl(trimmed) !== null) return "tianyi";
  if (parseGuangYaShareUrl(trimmed) !== null) return "guangya";
  return null;
}

/**
 * Map a candidate resource type ("115" | "quark" | "uc" | "123" | "tianyi" | "guangya")
 * to its storage provider key, or null for protocol-level channels ("magnet" / "manual")
 * that can be served by multiple drive brands.
 */
export function storageProviderForResourceType(type: ResourceType | string | undefined): StorageProvider | null {
  switch (type) {
    case "115":
    case "pan115":
      return "pan115";
    case "quark":
      return "quark";
    case "uc":
      return "uc";
    case "123":
    case "pan123":
      return "pan123";
    case "tianyi":
      return "tianyi";
    case "guangya":
      return "guangya";
    default:
      return null;
  }
}

/** Short agent-facing Chinese label for a candidate's resource type or drive brand. */
export function candidateDriveLabel(type: ResourceType | string | undefined): string | undefined {
  switch (type) {
    case "115":
    case "pan115":
      return "115";
    case "quark":
      return "夸克";
    case "uc":
      return "UC";
    case "123":
    case "pan123":
      return "123";
    case "tianyi":
      return "天翼";
    case "guangya":
      return "光鸭";
    case "magnet":
      return "磁力";
    default:
      return undefined;
  }
}

/**
 * A resource's link identity for the user's rejections and the recorded episode sources:
 * every link a drive transfers by. deadLinkKey's (115 share, magnet, 光鸭 share) plus the
 * 夸克 / 123 / 天翼 share links — dead-link tracking leaves those out on purpose (its death
 * rules are 115 / magnet / 光鸭 ones), but a rejection must follow them, or on those drives
 * no rejected copy is ever refused by its link. The executors' own parsers, so a passcode or
 * fragment never makes the same share look like another.
 */
export function resourceLinkKey(url: string): string | null {
  const known = deadLinkKey(url);
  if (known) return known.key;
  const quark = parseQuarkShareUrl(url);
  if (quark) return `quark:${quark.pwdId}`;
  const uc = parseUcShareUrl(url);
  if (uc) return `uc:${uc.pwdId}`;
  const pan123 = parsePan123ShareUrl(url);
  if (pan123) return `pan123:${pan123.shareKey}`;
  const tianyi = parseTianyiShareUrl(url);
  if (tianyi) return `tianyi:${tianyi.shareCode}`;
  return null;
}
