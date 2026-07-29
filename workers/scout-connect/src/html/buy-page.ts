import { BRAND_BAR, BRAND_CSS, FAVICON_LINK, THEME_BASE, THEME_TOKENS } from "./theme.js";

/**
 * `/buy` —— Paddle 的 **default payment link** 落地页。
 *
 * 这个页面存在的唯一理由是 Paddle 的机制:每笔交易的支付链接由
 * 「default payment link + `?_ptxn=<交易ID>`」拼成。Paddle 后台必须填一个
 * default payment link 才能创建任何交易(错误码
 * `transaction_default_checkout_url_not_set`),而那个页面必须加载 Paddle.js
 * 并根据 `_ptxn` 打开结账窗。
 *
 * 注意它**不是**营销页:定价说明在 /pricing。这里只负责把交易 ID 交给
 * Paddle.js。用户正常路径是从控制台点购买 → Paddle 生成带 `_ptxn` 的链接
 * → 落到这里 → 结账窗自动弹出。
 *
 * 无 token / 无 `_ptxn` 时**不留白页**:给出明确指引并链回 /pricing 与控制台,
 * 否则用户(和 Paddle 审核员)看到的是一个空页面,像是坏了。
 */
export function buyPage(input: {
  paddleClientToken?: string | undefined;
  /** "sandbox" | "production"。sandbox 时 Paddle.js 需显式设置环境。 */
  paddleEnvironment?: string | undefined;
}): string {
  const token = input.paddleClientToken?.trim();
  const env = input.paddleEnvironment?.trim() === "sandbox" ? "sandbox" : "production";
  // token 是公开的 client-side token(设计上就要下发到浏览器),但仍需安全内联。
  // **JSON.stringify 不够**:它不转义 `/`,所以 token 里的 `</script>` 会原样
  // 输出,提前闭合 <script> 并把后续内容当 HTML 解析(实测可注入 <img onerror>)。
  // 追加把 `<` 转成 \u003c —— JS 字符串字面量里等价,但 HTML 解析器再也看不到
  // `</script`。可利用性低(token 来自 wrangler vars,能改它的人已有更强手段),
  // 但这是真实的转义缺陷,而非理论风险。
  const tokenLiteral = JSON.stringify(token ?? "").replace(/</g, "\\u003c");
  const configured = token !== undefined && token !== "";

  return `<!doctype html>
<html lang="zh-Hans">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>结账 · Mediary Connect</title>
${FAVICON_LINK}
<!-- 结账中转页不该被搜索引擎收录:它只在带 _ptxn 时有意义 -->
<meta name="robots" content="noindex">
<style>
${THEME_TOKENS}
${THEME_BASE}
${BRAND_CSS}
main{max-width:560px;margin:0 auto;padding:48px 24px 96px}
h1{font-size:1.5rem;font-weight:900;letter-spacing:-.5px;margin:24px 0 8px}
p{color:var(--text-muted);font-size:14.5px;margin:10px 0 0;line-height:1.65}
.card{margin-top:24px;padding:20px;border:1px solid var(--border);border-radius:12px;background:var(--bg-surface)}
.btn{display:inline-block;margin-top:18px;padding:11px 20px;border-radius:999px;background:var(--accent);color:#000;font-weight:700;text-decoration:none;font-size:14px}
.btn:hover{background:var(--accent-press)}
a{color:var(--accent)}
.muted{color:var(--text-muted);font-size:13px}
#status{font-family:var(--mono);font-size:12px;color:var(--text-muted);margin-top:16px}
</style>
</head>
<body>
<main>
${BRAND_BAR}
<h1>结账</h1>
<div class="card">
<p id="hint">正在打开支付窗口…</p>
<p id="status" role="status"></p>
<noscript><p>支付需要 JavaScript。请开启后刷新本页。</p></noscript>
</div>
<p class="muted" style="margin-top:22px">
价格与档位见 <a href="/pricing">定价</a> · 退款政策见 <a href="/refund">退款政策</a>（14 天无理由）<br>
付款由 Paddle 作为记录商户（Merchant of Record）处理，发票与收据由 Paddle 出具。运营主体 DF Digital。
</p>
<p class="muted">遇到问题？<a href="/contact">联系我们</a>，或回到 <a href="/login">控制台</a>。</p>
</main>
${configured ? '<script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script>' : ""}
<script>
(function () {
  var hint = document.getElementById("hint");
  var status = document.getElementById("status");
  function fail(msg) {
    hint.textContent = "无法打开支付窗口。";
    status.textContent = msg;
  }
  // _ptxn 由 Paddle 在生成支付链接时附加。没有它说明用户直接访问了本页,
  // 而不是从购买流程过来的——给指引,不要留白页。
  var txn = new URLSearchParams(location.search).get("_ptxn");
  ${
    configured
      ? `if (!window.Paddle) { fail("支付组件加载失败，请检查网络或稍后重试。"); return; }
  try {
    window.Paddle.Environment.set(${JSON.stringify(env)});
    window.Paddle.Initialize({ token: ${tokenLiteral} });
  } catch (e) {
    fail("支付组件初始化失败：" + (e && e.message ? e.message : String(e)));
    return;
  }
  if (!txn) {
    hint.textContent = "这个页面用于完成付款。";
    status.textContent = "请从定价页或控制台发起购买。";
    return;
  }
  try {
    window.Paddle.Checkout.open({ transactionId: txn });
    hint.textContent = "支付窗口已打开。";
    status.textContent = "";
  } catch (e) {
    fail("打开支付窗口失败：" + (e && e.message ? e.message : String(e)));
  }`
      : `// 未配置 PADDLE_CLIENT_TOKEN:结账尚未启用。明确说明而不是假装在加载。
  hint.textContent = "结账功能尚未开放。";
  status.textContent = txn ? "支付通道配置中，请稍后重试。" : "请先在定价页了解档位。";`
  }
})();
</script>
</body>
</html>`;
}
