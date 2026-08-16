import { BRAND_BAR, BRAND_CSS, FAVICON_LINK, THEME_BASE, THEME_TOKENS } from "./theme.js";

/** Alipay browser return shell. It only renders state obtained from our authenticated API. */
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
main{max-width:590px;margin:0 auto;padding:48px 24px 96px}.card{margin-top:34px;padding:28px;border:1px solid var(--border);border-radius:16px;background:var(--bg-surface)}
.state{display:flex;align-items:center;gap:14px}.pulse{width:46px;height:46px;border-radius:50%;background:rgba(30,215,96,.12);border:1px solid rgba(30,215,96,.35);display:grid;place-items:center;color:var(--accent);font-weight:900}.pulse::after{content:"…";transform:translateY(-3px)}
h1{font-size:1.45rem;line-height:1.2;margin:0;font-weight:900}#detail{color:var(--text-muted);font-size:14.5px;line-height:1.75;margin:20px 0 0}.notice{margin-top:20px;padding:14px 16px;border:1px solid var(--border);border-radius:11px;background:rgba(255,255,255,.025);color:var(--text-muted);font-size:13.5px;line-height:1.7}.notice strong{color:var(--text)}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:24px}.btn{display:inline-block;padding:11px 18px;border-radius:999px;background:var(--accent);color:#06150a;font-weight:800;text-decoration:none;font-size:14px}.btn.secondary{background:transparent;color:var(--text);border:1px solid var(--border)}.links{color:var(--text-muted);font-size:13px;margin-top:24px}.links a{color:var(--accent)}
</style>
</head>
<body>
<main>
${BRAND_BAR}
<section class="card">
<div class="state"><span class="pulse" aria-hidden="true"></span><h1 id="title">付款确认中</h1></div>
<p id="detail" role="status">正在向服务端查询订单状态，请不要重复付款。</p>
<div class="notice"><strong>支付宝页面返回不等于到账。</strong>只有服务端确认后才会开通权益；如果支付宝已扣款，请留在此页等待自动更新。</div>
<div class="actions"><a class="btn" href="/console">进入控制台</a><a class="btn secondary" href="/buy">返回购买页</a></div>
<p class="links"><a href="/refund">退款政策</a> · <a href="/contact">联系我们</a></p>
</section>
</main>
<script>
(function () {
  var order = new URLSearchParams(location.search).get("order");
  var title = document.getElementById("title");
  var detail = document.getElementById("detail");
  var timer = null;
  var inFlight = false;

  function stop() {
    if (timer !== null) clearInterval(timer);
  }
  function render(status) {
    if (status === "pending") {
      title.textContent = "付款确认中";
      detail.textContent = "正在等待支付宝服务端确认。请勿重复付款，本页会自动更新。";
      return;
    }
    if (status === "paid_unfulfilled") {
      title.textContent = "付款已确认，正在开通权益";
      detail.textContent = "款项已经确认，系统正在把使用时长写入你的账号。";
      return;
    }
    if (status === "fulfilled") {
      stop();
      title.textContent = "权益已开通";
      detail.textContent = "使用时长已经到账，即将进入控制台。";
      setTimeout(function () { window.location.href = "/console"; }, 700);
      return;
    }
    if (status === "closed") {
      stop();
      title.textContent = "订单已关闭";
      detail.textContent = "这笔订单没有完成付款。你可以返回购买页重新发起。";
      return;
    }
    if (status === "expired") {
      stop();
      title.textContent = "订单已过期";
      detail.textContent = "付款窗口已经过期。如果尚未扣款，请返回购买页重新发起。";
    }
  }
  async function poll() {
    if (!order || inFlight) return;
    inFlight = true;
    var controller = new AbortController();
    var requestTimeout = setTimeout(function () { controller.abort(); }, 8000);
    try {
      var response = await fetch("/api/alipay/orders/" + encodeURIComponent(order) + "/status", {
        signal: controller.signal,
      });
      if (response.status === 401) {
        stop();
        title.textContent = "请先登录";
        detail.innerHTML = "登录后才能查看这笔订单。<a href='/login?next=%2Fpayment-success%3Forder%3D" + encodeURIComponent(order) + "'>前往登录</a>";
        return;
      }
      if (response.status === 404) {
        stop();
        title.textContent = "无法查看订单";
        detail.textContent = "没有找到属于当前账号的订单，请检查登录账号或联系我们。";
        return;
      }
      if (!response.ok) return;
      var data = await response.json();
      if (data && typeof data.status === "string") render(data.status);
    } catch (_) {
      detail.textContent = "网络暂时不可用，系统会继续重试。请勿重复付款。";
    } finally {
      clearTimeout(requestTimeout);
      inFlight = false;
    }
  }
  if (!order) {
    title.textContent = "缺少订单信息";
    detail.textContent = "请从购买页重新发起，或前往控制台查看现有权益。";
    return;
  }
  timer = setInterval(poll, 3000);
  poll();
})();
</script>
</body>
</html>`;
}
