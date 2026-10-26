/** Build the string the 光鸭 login QR must encode.
 *
 *  `/v1/auth/device/code` returns `verification_url` WITHOUT a `user_code`:
 *
 *    https://account.guangyapan.com/__/auth/device/?client_id=…&scope=…
 *
 *  The real site appends `&user_code=<user_code>` before handing the value to its
 *  QR canvas (read off the canvas's React props on 2026-10-26 — the rendered
 *  image has a logo in the middle so a decoder can't read it back). Without that
 *  parameter the 光鸭 app resolves the scanned URL to a **404**: `user_code` is
 *  what identifies WHICH pending authorization is being approved.
 *
 *  Live regression: the first version of this feature shipped without it and the
 *  user's very first scan landed on 404.
 */
export function buildGuangYaQrContent(input: {
  verificationUrl: string;
  userCode: string;
}): string {
  const { verificationUrl, userCode } = input;
  if (!userCode) return verificationUrl;
  // Prefer URL/searchParams: string concatenation neither dedupes an existing
  // user_code nor copes with a #fragment if the upstream format ever changes.
  try {
    const url = new URL(verificationUrl);
    url.searchParams.set("user_code", userCode);
    return url.toString();
  } catch {
    const joiner = verificationUrl.includes("?") ? "&" : "?";
    return `${verificationUrl}${joiner}user_code=${encodeURIComponent(userCode)}`;
  }
}
