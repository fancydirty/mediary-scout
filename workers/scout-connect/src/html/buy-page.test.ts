import { describe, expect, it } from "vitest";
import { buyPage } from "./buy-page.js";

const CONFIGURED = { paddleClientToken: "live_abc123", paddleEnvironment: "production" };

describe("buyPage (Paddle default payment link 落地页)", () => {
  it("配好 token 时加载 Paddle.js 并按 _ptxn 打开结账", () => {
    const html = buyPage(CONFIGURED);
    expect(html).toContain("https://cdn.paddle.com/paddle/v2/paddle.js");
    expect(html).toContain("_ptxn");
    expect(html).toContain("Paddle.Checkout.open");
    expect(html).toContain('"live_abc123"');
  });

  // Paddle.Environment.set() 官方定义为「只用于切到 sandbox」,不调用时默认生产,
  // go-live checklist 要求上线前移除。显式 set("production") 非受支持用法,
  // 可能抛错 → 结账 100% 失败。故:sandbox 必须有,生产必须没有。
  it("只有 sandbox 才调 Environment.set,生产环境一律不调", () => {
    expect(buyPage({ ...CONFIGURED, paddleEnvironment: "sandbox" })).toContain(
      'Paddle.Environment.set("sandbox")',
    );
    for (const envVal of [undefined, "production", "", "SaNdBoX-typo", "live"]) {
      const html = buyPage({ ...CONFIGURED, paddleEnvironment: envVal });
      expect(html, `env=${String(envVal)} 不该调 Environment.set`).not.toContain(
        "Paddle.Environment.set",
      );
    }
  });

  // 大小写/空白不敏感:配成 "SANDBOX" 若静默变生产,沙箱测试会打到生产账号。
  it("环境值解析大小写与空白不敏感", () => {
    for (const envVal of ["SANDBOX", " sandbox ", "Sandbox"]) {
      expect(buyPage({ ...CONFIGURED, paddleEnvironment: envVal }), envVal).toContain(
        'Paddle.Environment.set("sandbox")',
      );
    }
  });

  // 未配置时白页最糟:用户与 Paddle 审核员都会以为坏了。
  it("未配置 token 时不加载 Paddle.js,并明确说明结账未开放", () => {
    for (const input of [{}, { paddleClientToken: "" }, { paddleClientToken: "   " }]) {
      const html = buyPage(input);
      expect(html, "不应加载 paddle.js").not.toContain("cdn.paddle.com");
      expect(html, "应明确说明").toContain("结账功能尚未开放");
      expect(html).not.toContain("Paddle.Checkout.open");
    }
  });

  // 早先这条断言写成 toContain(JSON.stringify(token)),而 JSON.stringify
  // **不转义 `/`** —— 断言恰好通过,却完全没测到脚本截断。改为直接检查产物:
  // 页面里不得出现多余的 </script>,注入的标签不得进入 HTML。
  it("token 里的 </script> 被转义,不能提前闭合脚本或注入标签", () => {
    const evil = 'tok</script><img src=x onerror=alert(1)>';
    const html = buyPage({ paddleClientToken: evil });
    // 正常页面只有固定数量的 </script>;注入成功会多出一个
    const baseline = (buyPage({ paddleClientToken: "clean" }).match(/<\/script>/g) ?? []).length;
    const withEvil = (html.match(/<\/script>/g) ?? []).length;
    expect(withEvil, "不得多出 </script>").toBe(baseline);
    expect(html, "注入的标签不得进入 HTML").not.toContain("<img src=x");
    // 但转义后的字面量仍须保留 token 原值(\u003c 在 JS 字符串里等价于 <)
    expect(html).toContain("\\u003c/script>");
  });

  it("结账中转页不该被收录,且给出定价/退款/联系的出口", () => {
    const html = buyPage(CONFIGURED);
    expect(html).toContain('name="robots" content="noindex"');
    expect(html).toContain('href="/pricing"');
    expect(html).toContain('href="/refund"');
    expect(html).toContain('href="/contact"');
  });

  // Paddle domain review:实体名与 MoR 关系要在结账路径上可见。
  it("写明 DF Digital 与 Paddle 作为记录商户", () => {
    const html = buyPage(CONFIGURED);
    expect(html).toContain("DF Digital");
    expect(html).toContain("Merchant of Record");
  });

  it("无 JS 时有 noscript 提示", () => {
    expect(buyPage(CONFIGURED)).toContain("<noscript>");
  });
});

describe("/buy 的 CSP 必须放行 Paddle,其余页面必须维持最严", () => {
  it("/buy 放行 cdn.paddle.com 与 *.paddle.com(否则 100% 收不到钱)", async () => {
    const { handleRequest } = await import("../routes.js");
    const { createMemoryConnectDb } = await import("../db.js");
    const res = await handleRequest(new Request("https://mediaryconnect.app/buy"), {
      db: createMemoryConnectDb(),
      cf: {} as never,
      adminToken: "t",
      rootDomain: "mediaryconnect.app",
      now: () => "2026-07-29T00:00:00.000Z",
    } as never);
    // URL 带交易 ID,不得被缓存(也避免「结账未开放」旧页面被复用)
    expect(res.headers.get("cache-control")).toBe("no-store");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("https://cdn.paddle.com");
    // 结账 UI 是 iframe;图标若被 default-src 'none' 挡掉,窗口看起来像坏了
    expect(csp).toMatch(/frame-src[^;]*paddle\.com/);
    expect(csp).toMatch(/img-src[^;]*paddle\.com/);
    expect(csp).toMatch(/connect-src[^;]*paddle\.com/);
    // 仍不放宽 frame-ancestors(那是"谁能嵌入本页")
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("非 /buy 页面不得出现 paddle 来源(不为一个页面放宽全站)", async () => {
    const { handleRequest } = await import("../routes.js");
    const { createMemoryConnectDb } = await import("../db.js");
    const deps = {
      db: createMemoryConnectDb(),
      cf: {} as never,
      adminToken: "t",
      rootDomain: "mediaryconnect.app",
      now: () => "2026-07-29T00:00:00.000Z",
    } as never;
    for (const path of ["/terms", "/pricing", "/refund", "/"]) {
      const res = await handleRequest(new Request(`https://mediaryconnect.app${path}`), deps);
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp, `${path} 不应放行 paddle`).not.toContain("paddle.com");
      // 但 img-src 必须存在:每页都带 data: URI favicon,default-src 'none'
      // 会把它挡掉(Copilot round-3 指出的既有缺陷)。
      expect(csp, `${path} 必须允许 data: favicon`).toContain("img-src 'self' data:");
    }
  });
});

describe("付款完成后必须有出路(真实事故的回归防线)", () => {
  // 事故:用户微信扫码付了 ¥45,Paddle 结账窗停在原地,界面「像是我没扫过码
  // 付过款一样」。根因是我们既没传 settings.successUrl 也没传 eventCallback ——
  // Paddle 文档写明这两者之一是必需的,否则它付完不知道去哪,只能停着。
  const html = () => buyPage({ paddleClientToken: "live_tok", paddleEnvironment: "production" });

  it("Initialize 带 eventCallback", () => {
    expect(html()).toContain("eventCallback");
  });

  it("监听 checkout.completed 并跳 /payment-success", () => {
    // 与轮询路径统一跳转目标(确认中间页),不再跳 /console?paid=1(Copilot round 9)。
    const h = html();
    expect(h).toContain("checkout.completed");
    expect(h).toContain("/payment-success");
  });

  it("付款失败也说话,并明确「没有扣款」", () => {
    // 之前这一路也是静默的。用户会以为按钮坏了然后反复点。
    const h = html();
    expect(h).toContain("checkout.payment.failed");
    expect(h).toContain("没有扣款");
  });

  it("明说微信支付可能要等几分钟(延迟捕获)", () => {
    // 官方文档:授权后捕获「通常立刻,但可能长达 10 分钟」。
    // 不说清楚,用户会在这几分钟里以为付款失败了。
    expect(html()).toContain("10 分钟");
  });

  it("跳转前先给一句「正在开通」,不直接把人丢回控制台", () => {
    // 直接跳的话,若 webhook 还没入账,用户看到的是「尚未开通」——
    // 那正是事故里最伤人的一幕:付完钱,回到控制台,显示尚未开通。
    const h = html();
    expect(h).toContain("正在开通");
  });

  it("未配置 token 时不注入 eventCallback(没有 Paddle.js 可挂)", () => {
    const h = buyPage({});
    expect(h).not.toContain("eventCallback");
    expect(h).toContain("结账功能尚未开放");
  });

  it("checkout.completed 必须先关 overlay 再跳转(两次真实 bug)", () => {
    // 第一次事故:没有 eventCallback,用户付完款 overlay 停在原地不动。
    // 第二次事故:加了 eventCallback 但没关 overlay,setTimeout 里的跳转
    // 在 iframe 里执行 —— 被沙箱阻止或被 overlay 挡住,用户仍看到二维码不动。
    //
    // 正确顺序:close() → setTimeout → location.href。这样用户看到 overlay 关闭,
    // 然后看到页面上的「正在开通」提示,1.8 秒后跳 /payment-success。
    const output = buyPage(CONFIGURED);
    
    // 必须有 close() 调用
    expect(output).toContain("window.Paddle.Checkout.close()");
    
    // 且 close() 必须在 location.href 之前(否则跳转发生时 overlay 还开着)
    const closeIdx = output.indexOf("window.Paddle.Checkout.close()");
    const timeoutIdx = output.indexOf("setTimeout(");
    const hrefIdx = output.indexOf('window.location.href = "/payment-success"');
    expect(closeIdx).toBeGreaterThan(-1);
    expect(timeoutIdx).toBeGreaterThan(-1);
    expect(hrefIdx).toBeGreaterThan(-1);
    // close() 必须在 setTimeout 外面（立即执行），href 在 setTimeout 里面
    expect(closeIdx).toBeLessThan(timeoutIdx);
    expect(timeoutIdx).toBeLessThan(hrefIdx);
  });

  it("successUrl 必须带交易 ID(确认页靠它轮询到账后自动跳控制台)", () => {
    const output = buyPage(CONFIGURED);
    expect(output).toMatch(/successUrl:[^,}]*\/payment-success\?txn=/);
  });

  it("Checkout.open 必须带 settings.successUrl(微信支付唯一救命参数)", () => {
    // **三次真实事故都栽在这一条。** 微信支付付完款,Paddle 把用户带到它自己的
    // 处理域名(redirect-euw1.ppro.com),本页的 eventCallback 完全失效 ——
    // 它只在 overlay 内有效。用户看到一个不动的二维码,不知道是否付款成功。
    //
    // 前两次修的都是 overlay 内的路径(eventCallback、Checkout.close),
    // 第三次把 success_url 加到了 API 的 transaction.checkout —— **那个字段
    // 不存在**,Paddle 静默忽略(实测:创建交易的响应里没有 settings)。
    //
    // 只有 Paddle.Checkout.open 的 settings.successUrl 才真正生效。
    const output = buyPage(CONFIGURED);
    expect(output).toContain("successUrl");
    expect(output).toContain("/payment-success");

    // successUrl 必须在 Checkout.open 的**参数**里,不是只在注释里提一句。
    // 注意:不能用 indexOf("successUrl") 定位 —— 注释里也写了这个词
    // (注释会进产物),会命中注释而不是代码。查带冒号的实际赋值。
    expect(output).toMatch(/Paddle\.Checkout\.open\(\{[\s\S]{0,200}successUrl:/);
  });

  it("指向 /payment-success 而非直接跳 /console", () => {
    // 微信支付是延迟捕获(官方:通常立刻,但可能长达 10 分钟)。
    // 直接跳控制台会看到「尚未开通」—— 刚付完钱,页面告诉你什么都没发生。
    const output = buyPage(CONFIGURED);
    // 只查实际赋值,不查注释(注释里也提到了 /console,会误命中)。
    expect(output).toMatch(/successUrl:[^,}]*payment-success/);
    expect(output).not.toMatch(/successUrl:[^,}]*\/console/);
  });
});
