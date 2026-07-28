import type { AccountRow, EntitlementRow } from "../db.js";
import { isEntitlementActive } from "../entitlement.js";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

/** 最新到期时刻 = entitlements 里 expires_at 最大者。 */
function latestExpiry(entitlements: EntitlementRow[]): string | null {
  let latest: string | null = null;
  for (const e of entitlements) {
    if (latest === null || Date.parse(e.expires_at) > Date.parse(latest)) {
      latest = e.expires_at;
    }
  }
  return latest;
}

export function consolePage(input: {
  account: AccountRow;
  entitlements: EntitlementRow[];
  now: string;
}): string {
  const expiry = latestExpiry(input.entitlements);
  const active = isEntitlementActive(expiry, input.now);
  const statusLine = active
    ? `<p class="status ok">✅ 有效 · 到期 ${esc(expiry!.slice(0, 10))}</p>`
    : `<p class="status none">尚未开通（无有效时长）</p>`;
  const cta = active
    ? `<a class="btn" href="/pricing">续期</a>`
    : `<a class="btn" href="/pricing">开通</a>`;

  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>控制台 · Mediary Connect</title>
<style>
body{font-family:system-ui,sans-serif;max-width:640px;margin:3rem auto;padding:0 1.2rem;color:#222;line-height:1.7}
h1{font-size:1.5rem}
.card{border:1px solid #e5e5e5;border-radius:12px;padding:1.2rem 1.4rem;margin:1.5rem 0}
.status{font-size:1.05rem;font-weight:600}
.status.ok{color:#169c46}
.status.none{color:#a00}
.btn{display:inline-block;margin-top:.6rem;padding:.55rem 1.2rem;border-radius:999px;background:#1ed760;color:#06210f;font-weight:700;text-decoration:none}
.email{color:#666;font-size:.92rem}
footer{margin-top:3rem;font-size:.85rem;color:#666}
footer a{color:#666}
</style>
</head>
<body>
<main>
<h1>Mediary Connect 控制台</h1>
<p class="email">${esc(input.account.email)}</p>
<div class="card">
${statusLine}
${cta}
</div>
</main>
<footer>
<a href="/pricing">定价</a> · <a href="/terms">服务条款</a> · <a href="/privacy">隐私政策</a> · <a href="/refund">退款政策</a> · <a href="/contact">联系我们</a>
</footer>
</body>
</html>`;
}
