import { parsePan123ShareUrl } from "../pan123-storage-executor.js";
import { parseQuarkShareUrl, parseUcShareUrl } from "../quark-storage-executor.js";
import { parseTianyiShareUrl } from "../tianyi-storage-executor.js";
import { deadLinkKey } from "./dead-links.js";

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
