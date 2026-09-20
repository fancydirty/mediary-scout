import { isGuangYaAuthError } from "./guangya-client.js";
import { isPan115AuthError } from "./pan115-cookie-client.js";
import { isPan123AuthError } from "./pan123-client.js";
import { isQuarkAuthError } from "./quark-cookie-client.js";
import { isTianyiAuthError } from "./tianyi-client.js";

/** Brand netdisk auth failures only (cookie/token dead) — never LLM Unauthorized
 *  or plain Errors. The worker freezes the run's drive on these; every layer in
 *  between must let them through untouched (never soften one into a per-file
 *  "failed" — a dead credential is not a landing miss). */
export function isBrandStorageAuthError(error: unknown): boolean {
  return (
    isPan115AuthError(error) ||
    isQuarkAuthError(error) ||
    isGuangYaAuthError(error) ||
    isTianyiAuthError(error) ||
    isPan123AuthError(error)
  );
}
