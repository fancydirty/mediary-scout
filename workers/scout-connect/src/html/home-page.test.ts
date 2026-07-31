import { describe, expect, it } from "vitest";
import { homePage } from "./home-page.js";

describe("home page(apex 落地页)", () => {
  it("沿用共享深色主题、品牌条与 favicon", () => {
    const html = homePage();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("--accent:#1ed760");
    expect(html).toContain("color-scheme:dark");
    expect(html).toContain("CONNECT");
    expect(html).toContain('rel="icon"');
    expect(html).not.toContain("color:#222");
  });

  it("承载登录入口 —— 这是付费的必经之路(/api/checkout 强制 session)", () => {
    const html = homePage();
    expect(html).toContain('type="email"');
    expect(html).toContain("发送登录链接");
    // 「为什么不用注册」必须解释,否则用户会疑惑
    expect(html).toContain("为什么没有注册这一步");
  });

  it("价格三档直出首页,不藏 /pricing(我们没有免费档,藏了就流失)", () => {
    const html = homePage();
    for (const p of ["¥45", "¥108", "¥188"]) expect(html).toContain(p);
    expect(html).toContain("无自动续费");
    expect(html).toContain("14 天");
  });

  it("价格卡不做「立即购买」按钮 —— 真实流程是先登录再在控制台付款", () => {
    const html = homePage();
    expect(html).not.toContain("立即购买");
    expect(html).not.toContain("选这个");
    // 必须说清顺序
    expect(html).toContain("不能直接下单");
  });

  it("支付方式只写实际可用的(live API 实测:card/wechat_pay/apple_pay/google_pay)", () => {
    const html = homePage();
    expect(html).toContain("微信支付");
    // 支付宝不在可用列表里 —— 写了是事实错误,也是 MoR 合规风险
    expect(html).not.toContain("支付宝");
  });

  it("四层防误购都在(附加服务不是独立产品)", () => {
    const html = homePage();
    expect(html).toContain("远程访问附加服务");   // ① hero eyebrow
    expect(html).toContain("不是一台云主机");      // ② 定位行
    expect(html).toContain("你是哪一种");          // ③ 闸门
    expect(html).toContain("需自备一台跑着");      // ④ 每张价格卡
  });

  it("讲清 Scout 是什么并外链主站与 demo(三站互链吃索引)", () => {
    const html = homePage();
    expect(html).toContain("自建网盘的媒体获取 agent");
    expect(html).toContain("https://mediaryscout.app");
    expect(html).toContain("demo.mediaryscout.app");
    expect(html).toContain("github.com/fancydirty/mediary-scout");
  });

  it("三类部署提示词都在(用户处境不同,不能只给一份)", () => {
    const html = homePage();
    expect(html).toContain("只装 Scout");
    expect(html).toContain("再接 Connect");
    expect(html).toContain("一次装完");
    // 提示词必须带护栏(学 buildContainerUpgradePrompt)
    expect(html).toContain("立即停止");
    expect(html).toContain("绝不猜");
  });

  it("接入命令与 connect.sh 的真实用法一致", () => {
    const html = homePage();
    expect(html).toContain("connect.sh");
    expect(html).toContain("&lt;取件码&gt;");
    expect(html).toContain("--dir");
  });

  it("SEO:title/description/OG/canonical 齐全(此前全空,连品牌词都吃不住)", () => {
    const html = homePage();
    expect(html).toContain("<title>Mediary Connect — 自托管 Mediary Scout 的远程访问服务</title>");
    expect(html).toContain('name="description"');
    expect(html).toContain('property="og:title"');
    expect(html).toContain('property="og:description"');
    expect(html).toContain('rel="canonical"');
    expect(html).toContain('lang="zh-Hans"');
  });

  it("海报墙有兜底 —— TMDB 代理挂了首屏不能空一片", () => {
    const html = homePage();
    // 内联的兜底海报路径(worker 无静态目录,路径只是字符串,烤进 HTML)
    expect(html).toMatch(/tmdb-proxy\.mediaryscout\.app\/img/);
    // 首屏图必须 eager:lazy 会让首屏空着
    expect(html).toContain('loading="eager"');
  });

  // Copilot round-1 抓到的真 bug:源码里写 `\\n`(双反斜杠)时,模板字符串会
  // 输出**字面的反斜杠 + n**,在页面上渲染成可见的 "\\n" 文本。
  //
  // 注意断言写法:JS 源码里的 "\\\\n" 表示「一个反斜杠 + 字母 n」——
  // 这才是要查的东西。写成 "\\n" 是查真换行符,那永远查不出问题
  // (开发时先写错过一次:注入字面 \\n 后测试照样全绿,等于没保护)。
  it("body 里不含字面反斜杠-n(会渲染成可见文本)", () => {
    const html = homePage();
    // 只查 body 到 <script> 之间:脚本里的 "\\n" 是合法的 JS 转义
    const body = html.slice(html.indexOf("<body>"), html.indexOf("<script>"));
    expect(body.length).toBeGreaterThan(1000);   // 切片不能是空的
    expect(body).not.toContain("\\n");
  });

  it("海报:前 8 张 eager 其余 lazy(全 eager 抢首屏带宽,全 lazy 首屏空一片)", () => {
    const html = homePage();
    const eager = (html.match(/loading="eager"/g) ?? []).length;
    const lazy = (html.match(/loading="lazy"/g) ?? []).length;
    expect(eager).toBe(8);
    expect(lazy).toBeGreaterThan(0);
  });

  it("窄屏 input 必须 flex:none —— flex:1 在 column 方向会把它压成 18px", () => {
    const html = homePage();
    expect(html).toMatch(/\.lrow input[^{]*\{[^}]*flex:none/);
  });

  it("交互脚本:闸门切换 + 登录提交(含 429 限流的可操作文案)", () => {
    const html = homePage();
    expect(html).toContain('aria-expanded');
    expect(html).toContain("/api/auth/magic");
    // 202 是固定契约(不泄露邮箱是否已注册),文案不能说「已注册/未注册」
    expect(html).toContain("res.status === 202");
    expect(html).not.toContain("该邮箱已注册");
    // 限流要给可操作的话,不是「稍后重试」
    expect(html).toContain("res.status === 429");
    expect(html).toContain("过几分钟再试");
  });

  // Copilot round-2:Turnstile 门禁现在关着,但代码保留、随时可开。
  // 首页脚本不带 token 的话,门一开首页登录就稳定 400 "turnstile required"。
  it("登录脚本带上 turnstile token(与 /login 页同款,门禁重开时不会坏)", () => {
    const html = homePage();
    expect(html).toContain("cf-turnstile-response");
    expect(html).toContain("turnstile_token");
  });

  it("400 文案不写死成「邮箱不对」(服务端 400 还可能是缺 token 等)", () => {
    const html = homePage();
    expect(html).not.toContain("这个邮箱地址不对");
  });

  it("<script> 内联安全:提示词里的反引号已转义,不会截断模板字符串", () => {
    const html = homePage();
    // 提示词里有 `docker version` 这类反引号,若未转义会在构建期就炸;
    // 能跑到这里说明没炸。再确认渲染出的是可读的命令而不是被吃掉。
    expect(html).toContain("docker compose up -d");
    expect(html).toContain("docker version");
  });

  // Copilot round-3:用 <p class="h2"> 冒充标题会破坏文档大纲(屏幕阅读器 + SEO),
  // 而这页刚补了 SEO —— 自相矛盾。
  it("章节标题用真 <h2>/<h3>,不用 <p> 冒充", () => {
    const html = homePage();
    expect(html).not.toMatch(/<p class="h[23]"/);
    expect(html).toMatch(/<h2 class="h2"/);
    expect(html).toMatch(/<h3 class="h3"/);
    // 只能有一个 h1
    expect((html.match(/<h1/g) ?? []).length).toBe(1);
  });

  it("页脚合规五链接与运营主体齐全(Paddle MoR 要求)", () => {
    const html = homePage();
    for (const p of ["/pricing", "/terms", "/privacy", "/refund", "/contact"]) {
      expect(html).toContain(`href="${p}"`);
    }
    expect(html).toContain("DF Digital");
    expect(html).toContain("记录商户");
  });
});
