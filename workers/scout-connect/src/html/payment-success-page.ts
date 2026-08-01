import { BRAND_BAR, BRAND_CSS, FAVICON_LINK, THEME_BASE, THEME_TOKENS } from "./theme.js";

/**
 * `/payment-success` —— 支付成功后的中间页。
 *
 * **为什么必须有这个页面:**
 *
 * 微信支付这类**外部跳转**支付方式,用户付完款会被 Paddle 带到它自己的
 * 支付处理域名(redirect-euw1.ppro.com),我们的 `/buy` 页面上的
 * `eventCallback` 完全失效 —— 用户看到的是一个不动的二维码页,
 * 完全不知道支付是否成功。
 *
 * 这个页面由 `/buy` 页里 `Paddle.Checkout.open({ settings: { successUrl } })` 指向,
 * 是**唯一能保证用户看到"支付成功"的地方**。
 *
 * **为什么不直接跳控制台:**
 *
 * 微信支付是**延迟捕获**(Paddle 官方文档:通常立刻,但可能长达 10 分钟)。
 * 直接跳控制台会看到「尚未开通」—— 那正是最伤人的一幕:
 * 刚付完钱,页面告诉你什么都没发生。
 *
 * 所以这个页面明确说:
 * 1. 支付成功了(用户最需要的确认)
 * 2. Paddle 正在处理(解释为什么控制台还没显示)
 * 3. 给一个链接让他自己去看(而不是自动跳转到一个可能显示"未开通"的页面)
 */
export function paymentSuccessPage(): string {
  return `<!doctype html>
<html lang="zh-Hans">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>付款确认中 · Mediary Connect</title>
${FAVICON_LINK}
<meta name="robots" content="noindex">
<style>
${THEME_TOKENS}
${THEME_BASE}
${BRAND_CSS}
main{max-width:560px;margin:0 auto;padding:48px 24px 96px}
h1{font-size:1.75rem;font-weight:900;letter-spacing:-.5px;margin:24px 0 12px}
p{color:var(--text-muted);font-size:15px;margin:12px 0 0;line-height:1.7}
.card{margin-top:28px;padding:24px;border:1px solid var(--border);border-radius:12px;background:var(--bg-surface)}
.ok{display:flex;align-items:center;gap:12px;margin-bottom:16px}
.ok-icon{width:44px;height:44px;border-radius:50%;background:rgba(34,197,94,.15);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.ok-icon svg{width:24px;height:24px;stroke:#22c55e;stroke-width:2.5;fill:none}
.ok-text{font-size:1.1rem;font-weight:800;color:var(--text)}
.btn{display:inline-block;margin-top:20px;padding:12px 24px;border-radius:999px;background:var(--accent);color:#000;font-weight:700;text-decoration:none;font-size:14.5px}
.btn:hover{background:var(--accent-press)}
.note{margin-top:20px;padding:14px 16px;border-radius:10px;background:rgba(255,255,255,.03);border:1px solid var(--border);font-size:13.5px;color:var(--text-muted);line-height:1.65}
a{color:var(--accent)}
.muted{color:var(--text-muted);font-size:13px;margin-top:24px}
</style>
</head>
<body>
<main>
${BRAND_BAR}

<div class="card">
<div class="ok">
<div class="ok-icon" aria-hidden="true">
<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
</div>
<h1 class="ok-text">付款已完成</h1>
</div>

<p><strong>Paddle 已收到你的付款请求。</strong>发票与收据会发到你的邮箱（若成功完成）。</p>

<div class="note">
<strong>时长正在开通中。</strong><br>
微信支付需要 Paddle 完成资金确认,通常几秒内完成,<strong>最多约 10 分钟</strong>。
开通后你的账号会自动获得时长 —— 不需要再做任何操作。
</div>

<a class="btn" href="/console">进入控制台查看 →</a>

<p class="muted">
如果控制台暂时显示「尚未开通」,那是 Paddle 还在处理,<strong>你的付款不会丢失</strong>。
等几分钟刷新一下即可。<br>
超过 15 分钟仍未开通?请<a href="/contact">联系我们</a>,附上付款邮箱,我们会手工补发并核查原因。
</p>
</div>

<p class="muted" style="margin-top:28px">
付款由 Paddle 作为记录商户(Merchant of Record)处理。运营主体 DF Digital。<br>
14 天内无条件全额退款 —— 见<a href="/refund">退款政策</a>。
</p>
</main>
<script>
// ---- 到账后自动进入控制台 ----
// 用户付款后停在这个确认页。时长在 Paddle 捕获完成(webhook 入账)后到账,
// 这里轮询交易状态,completed 一到就自动跳 /console —— 用户不用手动点。
// 到达 /console 时若 webhook 尚未入账,控制台会显示「已付款 · 正在开通」
// 的兜底态,不会出现"尚未开通"。
(function () {
  var txn = new URLSearchParams(location.search).get("txn");
  if (!txn) return;  // 直接访问本页(无交易上下文)不轮询
  // inFlight 锁 + 超时(Copilot round 1):慢网/挂起时避免并发重叠请求或
  // fetch 永久挂起让轮询静默停住。5 秒超时保证锁一定释放。
  function timeoutSignal(ms) {
    if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
    var c = new AbortController();
    setTimeout(function () { c.abort(); }, ms);
    return c.signal;
  }
  var attempts = 0;
  var inFlight = false;
  var timer = null;
  var intervalMs = 3000;
  var poll = async function () {
    if (inFlight) return;
    inFlight = true;
    try {
      attempts++;
      // 微信延迟捕获可到 ~10 分钟:3 分钟后降频继续,不早停(Copilot round 1)。
      if (attempts === 61) {
        clearInterval(timer);
        intervalMs = 15000;
        timer = setInterval(poll, intervalMs);
      }
      var res = await fetch("/api/transaction/" + encodeURIComponent(txn) + "/status", {
        signal: timeoutSignal(5000),
      });
      if (res.status === 401 || res.status === 404) {
        // 未登录/交易不存在:继续轮询没意义,与 /buy 轮询一致 fail-fast
        // (Copilot round 2)。否则无意义请求直到页面关闭。
        clearInterval(timer);
        return;
      }
      if (res.status !== 200) return;  // 503 等可重试状态,继续等
      var data = await res.json();
      if (data && data.status === "completed") {
        clearInterval(timer);
        window.location.href = "/console";
      }
    } catch (e) { /* 网络抖动,下次再试 */ } finally {
      inFlight = false;
    }
  };
  poll();
  timer = setInterval(poll, intervalMs);
})();
</script>
</body>
</html>`;
}
