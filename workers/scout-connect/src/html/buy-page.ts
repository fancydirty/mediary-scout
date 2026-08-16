import { ALIPAY_TIERS } from "../alipay-order.js";
import { BRAND_BAR, BRAND_CSS, FAVICON_LINK, THEME_BASE, THEME_TOKENS } from "./theme.js";

export function buyPage(input: { alipayConfigured: boolean }): string {
  const tiers = Object.values(ALIPAY_TIERS)
    .map(
      (tier) => `<article class="tier${tier.featured ? " featured" : ""}">
${tier.featured ? '<span class="badge">最划算</span>' : ""}
<h2>${tier.label}</h2>
<div class="price">${tier.price}</div>
<p>${tier.months} 个月 Mediary Connect 使用时长</p>
<button type="button" data-tier="${tier.id}"${input.alipayConfigured ? "" : " disabled"}>支付宝支付</button>
</article>`,
    )
    .join("\n");

  const checkoutScript = input.alipayConfigured
    ? `<script>
(function () {
  var status = document.getElementById("status");
  var buttons = Array.prototype.slice.call(document.querySelectorAll("button[data-tier]"));
  function setBusy(busy) {
    buttons.forEach(function (button) { button.disabled = busy; });
  }
  buttons.forEach(function (button) {
    button.addEventListener("click", async function () {
      var tier = button.getAttribute("data-tier");
      if (!tier) return;
      setBusy(true);
      status.textContent = "正在创建支付宝订单…";
      try {
        var response = await fetch("/api/alipay/checkout", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tier: tier }),
        });
        if (response.status === 401) {
          location.href = "/login?next=%2Fbuy";
          return;
        }
        var data = await response.json();
        if (!response.ok || !data || typeof data.checkout_url !== "string" ||
            !data.checkout_url.startsWith("/alipay/checkout?checkout=")) {
          throw new Error("checkout unavailable");
        }
        location.href = data.checkout_url;
      } catch (_) {
        status.textContent = "暂时无法打开支付宝，请稍后重试或联系我们。";
        setBusy(false);
      }
    });
  });
})();
</script>`
    : "";

  return `<!doctype html>
<html lang="zh-Hans">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>支付宝结账 · Mediary Connect</title>
${FAVICON_LINK}
<meta name="robots" content="noindex">
<style>
${THEME_TOKENS}
${THEME_BASE}
${BRAND_CSS}
main{max-width:940px;margin:0 auto;padding:48px 24px 96px}
.intro{max-width:650px;margin:34px auto 0;text-align:center}.intro h1{font-size:clamp(2rem,5vw,3.25rem);line-height:1.08;margin:0;font-weight:900;letter-spacing:-1.5px}.intro p{color:var(--text-muted);font-size:15px;margin:14px 0 0}
.tiers{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-top:38px;align-items:stretch}
.tier{position:relative;padding:25px 22px 22px;border:1px solid var(--border);border-radius:16px;background:var(--bg-surface);display:flex;flex-direction:column}.tier.featured{border-color:var(--accent);box-shadow:0 0 0 1px rgba(30,215,96,.15),0 16px 42px rgba(0,0,0,.25)}
.badge{position:absolute;top:-12px;right:18px;padding:4px 11px;border-radius:999px;background:var(--accent);color:#071b0d;font-size:12px;font-weight:900}.tier h2{font-size:17px;margin:0}.price{font-size:2.2rem;font-weight:900;letter-spacing:-1px;margin-top:12px}.tier p{color:var(--text-muted);font-size:13.5px;line-height:1.6;min-height:44px}
button{width:100%;margin-top:auto;padding:12px 18px;border:0;border-radius:999px;background:var(--accent);color:#06150a;font:inherit;font-size:14px;font-weight:850;cursor:pointer}button:hover:not(:disabled){background:var(--accent-press)}button:disabled{cursor:not-allowed;opacity:.45}
#status{min-height:24px;margin:22px 0 0;text-align:center;color:var(--text-muted);font-size:13.5px}.notice{max-width:680px;margin:28px auto 0;padding:17px 19px;border:1px solid var(--border);border-radius:12px;background:rgba(255,255,255,.025);color:var(--text-muted);font-size:13.5px;line-height:1.7}.notice strong{color:var(--text)}
.links{text-align:center;color:var(--text-muted);font-size:13px;margin-top:25px}.links a{color:var(--accent)}
@media(max-width:700px){.tiers{grid-template-columns:1fr}.tier p{min-height:auto}.intro{margin-top:28px}}
</style>
</head>
<body>
<main>
${BRAND_BAR}
<section class="intro">
<h1>选择使用时长</h1>
<p>价格保持不变，一次付款，不自动续费。付款完成后，原有账号权益与开通流程保持不变。</p>
</section>
<section class="tiers" aria-label="Mediary Connect 支付宝价格档位">
${tiers}
</section>
<p id="status" role="status">${input.alipayConfigured ? "付款将跳转至支付宝安全页面。" : "支付宝结账暂未开放，请稍后再试。"}</p>
<div class="notice"><strong>付款后请回到本页等待确认。</strong>支付宝回跳只代表浏览器已返回，系统会通过支付宝服务端结果核实到账并自动开通权益。请勿重复付款。</div>
<p class="links"><a href="/refund">退款政策</a> · <a href="/contact">联系我们</a> · <a href="/console">返回控制台</a></p>
<noscript><p id="status">支付需要 JavaScript，请开启后刷新本页。</p></noscript>
</main>
${checkoutScript}
</body>
</html>`;
}
