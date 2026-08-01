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
 * 环境切换:Paddle 官方定义该方法「仅用于切到 sandbox」,不调用时 Paddle.js
 * 默认生产,且 go-live checklist 要求上线前移除。显式传 production 不是受支持
 * 的用法(可能抛错 → 结账 100% 失败),故本页仅在 sandbox 时注入该调用。
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
  // 大小写/空白不敏感(与 routes.ts 处理 ?lang= 一致):配成 "SANDBOX" 不该
  // 静默变成生产——那会让沙箱测试打到生产账号。
  const isSandbox = input.paddleEnvironment?.trim().toLowerCase() === "sandbox";
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
  // **共享"已安排跳转"标志**(Copilot round 9):页面里的两条完成路径
  // (Paddle 事件回调 与 轮询命中 paid/completed)都可能触发跳转,必须只跳
  // 一次 —— 否则两次 location.href 互相覆盖,落点不确定。
  // (注意:此处注释不能出现回调字样 —— 未配置分支的产物会被测试断言
  //  not.toContain,注释会误命中,本项目已多次栽在这。)
  var redirectScheduled = false;
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
    ${isSandbox ? 'window.Paddle.Environment.set("sandbox");' : "// production: 环境默认即生产,刻意不做任何环境切换调用"}
    window.Paddle.Initialize({
      token: ${tokenLiteral},
      // **必须有 eventCallback 或 successUrl,否则付完款界面一动不动。**
      // 这是一次真实事故的修复:用户微信扫码付了 ¥45,Paddle 结账窗停在原地,
      // 界面「像是我没扫过码付过款一样」。Paddle 的行为是对的 —— 我们从没告诉过
      // 它付完要去哪(既没传 successUrl 也没传 eventCallback),它只能停着。
      //
      // 用 eventCallback 而不是 successUrl,因为微信支付是**延迟捕获**:
      // checkout.completed 触发时钱可能还没真正到账(官方文档:通常立刻,
      // 但**可能长达 10 分钟**)。我们要在跳转前先给一句「正在开通」,
      // 而不是把用户丢到一个显示「尚未开通」的控制台 —— 那正是这次事故里
      // 最伤人的一幕:付完钱,回到控制台,看到「尚未开通」。
      eventCallback: function (event) {
        if (!event || typeof event.name !== "string") return;
        if (event.name === "checkout.completed") {
          // 与轮询路径统一:只跳一次,都跳 /payment-success(确认中间页)。
          if (redirectScheduled) return;
          redirectScheduled = true;
          hint.textContent = "支付成功,正在开通…";
          // 微信支付是延迟捕获,到账可能要几分钟。说清楚,别让人干等。
          status.textContent = "正在确认到账(微信支付最多需要 10 分钟)。即将前往确认页。";
          
          // ---- 必须先关 overlay,否则跳转会被卡住(真实 bug)----
          //
          // 第二次真实事故:用户微信扫码付款后,Paddle overlay 还停在二维码页,
          // 「像是我没扫过码付过款一样」。checkout.completed **确实触发了**,
          // 但 window.location.href 在 overlay 的 iframe 里执行 ——
          // 跳转被 iframe 沙箱阻止,或者只是 overlay 挡住了整个页面。
          //
          // Paddle.Checkout.close() 必须在跳转前调 —— 否则用户看到二维码停着不动,
          // 会以为失败了,重复付款,或者来投诉「钱扣了但没开通」。
          try { window.Paddle.Checkout.close(); } catch (e) { /* 已经关了也无妨 */ }
          
          // 留 1.8 秒让用户看到这句话再跳。跳过去后确认页显示「正在开通」。
          setTimeout(function () { window.location.href = "/payment-success?txn=" + encodeURIComponent(txn); }, 1800);
        } else if (event.name === "checkout.payment.failed") {
          // 付款失败也必须说话。之前这里同样是静默的。
          hint.textContent = "这笔支付没有成功。";
          status.textContent = "没有扣款。可以换一种支付方式再试,或联系我们。";
        }
      },
    });
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
    // **settings.successUrl 是微信支付唯一的救命参数。**
    //
    // 三次真实事故都栽在这:微信支付付完款,Paddle 把用户带到它自己的处理域名
    // (redirect-euw1.ppro.com),本页的 eventCallback **完全失效** ——
    // 它只在 overlay 内有效。用户看到一个不动的二维码,不知道是否付款成功。
    //
    // 第一次修:加 eventCallback(只覆盖 overlay 内的路径,微信仍然断)。
    // 第二次修:加 Checkout.close()(同样只在 overlay 内)。
    // 第三次修:把 success_url 加到 API 的 transaction.checkout —— **那个字段
    //          不存在**,Paddle 静默忽略(实测:响应里没有 settings)。
    //
    // 正解在这里:Paddle.Checkout.open 的 settings.successUrl。
    // 官方文档 paddle-js/methods/paddle-checkout-open 明确列了这个参数。
    // (注意:这段在模板字符串里,注释**不能写反引号** —— 会提前终止模板。
    //  这个坑本项目已踩过两次。)
    //
    // 指向 /payment-success 而非 /console:微信支付是**延迟捕获**(官方:通常
    // 立刻,但可能长达 10 分钟)。直接跳控制台会看到「尚未开通」—— 那是最伤人
    // 的一幕:刚付完钱,页面告诉你什么都没发生。
    // ---- 打开结账前先查一次状态 ----
    // 真实事故:刷新 /buy 带 ?_ptxn= 会重新弹结账窗,而交易可能已完成 ——
    // 用户看到"又回到付款页面"。已完成的交易应直接跳 /payment-success。
    (async function () {
      try {
        var pre = await fetch("/api/transaction/" + encodeURIComponent(txn) + "/status", {
          signal: timeoutSignal(3000),
        });
        if (pre.status === 200) {
          var preData = await pre.json();
          if (preData && (preData.status === "paid" || preData.status === "completed")) {
            window.location.href = "/payment-success?txn=" + encodeURIComponent(txn);
            return;
          }
        }
      } catch (e) { /* 查询失败就正常弹结账窗,轮询兜底 */ }
      openCheckout();
    })();
    function openCheckout() {
      window.Paddle.Checkout.open({
        transactionId: txn,
        // 带交易 ID:/payment-success 需要它来轮询确认到账后自动跳 /console。
        settings: { successUrl: location.origin + "/payment-success?txn=" + encodeURIComponent(txn) },
      });
      hint.textContent = "支付窗口已打开。";
      status.textContent = "";
    }

    // ---- 自建轮询:微信支付的唯一可靠出路 ----
    //
    // 第四次真实事故:微信支付是延迟捕获,授权与 Paddle 确认之间有几分钟窗口。
    // 窗口内 Paddle 前端不跳转、checkout.completed 不发、successUrl 不触发 ——
    // 用户看到"付了钱但页面没反应",感觉被骗。上述三条路(Paddle 的 successUrl、
    // eventCallback、服务端捕获)全都在 Paddle 手里,我们控制不了它的前端轮询。
    //
    // 所以**自己轮询**:每 3 秒查一次 /api/transaction/<id>/status,一旦
    // paid/completed 就关 overlay、跳 /payment-success。这不再依赖 Paddle 前端
    // 是否跳转 —— 只要 Paddle 服务端确认了钱,我们就能把用户接走。
    //
    // 轮询不硬超时:微信支付授权可能发生在任意时间(实测:页面 10:44 打开,
    // 用户 12:13 才付款,12:18 捕获 —— 若 10 分钟就停,付款时轮询早死了)。
    // 10 分钟后降频到 15 秒继续监听,直到页面关闭或交易完成。
    // 交易 ID 来自 URL,归属校验在服务端做。
    //
    // AbortSignal.timeout 降级(与 site/main.js 同款):旧浏览器不支持
    // AbortSignal.timeout,直接调用会抛 TypeError → 轮询永远发不出去且被
    // catch 吞掉,用户又回到"付了钱但页面没反应"。优先用原生,否则
    // AbortController + setTimeout。
    function timeoutSignal(ms) {
      if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
      var controller = new AbortController();
      setTimeout(function () { controller.abort(); }, ms);
      return controller.signal;
    }
    (function pollTransaction() {
      var attempts = 0;
      // **inFlight 锁**(Copilot round 2):setInterval + async 下,某次请求/
      // 解析超过 3 秒时下一次 tick 仍会触发 → 并发重叠请求,放大上游抖动与
      // API 调用。上一轮未结束就跳过本轮;结束后释放锁(含异常路径)。
      var inFlight = false;
      var timer = null;
      var intervalMs = 3000;
      // **不硬超时**(真实事故修复):轮询窗口按页面打开起算,而微信支付授权
      // 可能发生在任意时间(实测:页面 10:44 打开,用户 12:13 才付款,12:18
      // 捕获 —— 若 10 分钟就停,付款时轮询早死了)。10 分钟后降频到 15 秒
      // 继续监听,直到页面关闭。
      var poll = async function () {
        if (inFlight) return;
        inFlight = true;
        try {
          attempts++;
          if (attempts === 201) {
            clearInterval(timer);
            intervalMs = 15000;
            timer = setInterval(poll, intervalMs);
            hint.textContent = "支付已提交,正在确认到账…";
            status.textContent = "付款后页面会自动确认并跳转。如果已经付款,请稍候 —— 你的付款不会丢失;超过 15 分钟仍未开通请联系我们。";
          }
          // AbortSignal.timeout:fetch 挂起不返回时(某些网络条件下不 reject),
          // inFlight 锁会永久占住、轮询永久停住且页面无提示(Copilot round 7)。
          // 5 秒超时,保证锁一定释放。超时走 catch → 下次 tick 重试。
          var res = await fetch("/api/transaction/" + encodeURIComponent(txn) + "/status", {
            signal: timeoutSignal(5000),
          });
          if (res.status === 401) {
            // 登录过期:继续轮询也没用,明确告诉用户重新登录。
            clearInterval(timer);
            hint.textContent = "登录状态已过期。";
            status.textContent = "请刷新页面重新登录后,在控制台查看开通状态。你的付款不会丢失。";
            return;
          }
          if (res.status === 404) {
            // 交易不存在/不属于当前账号:继续轮询没意义。多半是会话换人了。
            clearInterval(timer);
            hint.textContent = "这笔交易无法确认。";
            status.textContent = "请回到控制台重新发起购买;若已付款,请联系我们核对。";
            return;
          }
          if (res.status === 503) {
            // 503 分两种(见端点):checkout not configured = 配置缺失,重试
            // 也没用,立即停并提示;temporarily unavailable = 上游抖动,重试。
            var body503 = null;
            try { body503 = await res.json(); } catch (e) { /* 读不到就当抖动 */ }
            if (body503 && body503.error === "checkout not configured") {
              clearInterval(timer);
              hint.textContent = "支付通道暂时不可用。";
              status.textContent = "请稍后刷新页面重试;持续不可用请联系我们。你的付款不会丢失。";
              return;
            }
            return;
          }
          var data = await res.json();
          if (data && (data.status === "paid" || data.status === "completed")) {
            // 与 eventCallback 路径共享标志:只跳一次。
            if (redirectScheduled) { clearInterval(timer); return; }
            redirectScheduled = true;
            clearInterval(timer);
            hint.textContent = "支付成功,正在开通…";
            status.textContent = "正在确认到账(微信支付最多需要 10 分钟)。即将前往确认页。";
            try { window.Paddle.Checkout.close(); } catch (e) { /* 已经关了也无妨 */ }
            setTimeout(function () { window.location.href = "/payment-success?txn=" + encodeURIComponent(txn); }, 1800);
          }
        } catch (e) { /* 网络抖动,下次再试 */ } finally {
          // 释放锁:clearInterval 后 finally 仍会跑,但 timer 已停,无副作用。
          inFlight = false;
        }
      };
      // 先建 interval 再立即跑一次(Copilot round 3):若先 poll(),首轮命中
      // 401/404/completed 时 clearInterval(timer) 清不掉 null,interval 仍会
      // 创建继续请求,覆盖已写入的提示。
      timer = setInterval(poll, intervalMs);
      // 页面加载立即查一次:付款发生在轮询启动前的场景(如刷新后交易已完成)
      // 也能马上抓住,不用等第一个 3 秒 tick。
      poll();
    })();
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
