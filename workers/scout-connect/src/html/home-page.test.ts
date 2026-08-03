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

  // ---- 结构化数据(SEO 基线审计:此前无 JSON-LD,搜索引擎无法把
  // Scout ↔ Connect 识别成同一品牌下的产品与增值服务)----
  it("JSON-LD 存在且可解析,声明 Product/Service + Offer", () => {
    const html = homePage();
    const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
    expect(m, "首页缺少 JSON-LD").not.toBeNull();
    const data = JSON.parse(m![1]) as { "@graph": Array<Record<string, unknown>> };
    const types = data["@graph"].map((n) => n["@type"]);
    expect(types).toContain("Product");
  });

  it("JSON-LD 覆盖页面可见的**全部三档**价格(Copilot #231:漏了两年档 ¥188)", () => {
    // 定价区可见三档:季 ¥45 / 年 ¥108 / 两年 ¥188。JSON-LD 少一档会让富结果
    // 呈现不完整的价格区间(最低价误导),且结构化数据与可见内容不符。
    const html = homePage();
    const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
    const raw = m![1];
    for (const price of ["45", "108", "188"]) {
      expect(html, `页面应可见 ¥${price}`).toContain(`¥${price}`);
      expect(raw, `JSON-LD 应含 price ${price}`).toContain(`"price":"${price}"`);
    }
    expect(raw).toContain('"priceCurrency":"CNY"');
    // offers 条数必须与可见档位数一致 —— 多一条或少一条都算不一致
    const offers = JSON.parse(raw) as { "@graph": Array<{ offers?: unknown[] }> };
    const product = offers["@graph"].find((n) => Array.isArray(n.offers));
    expect(product?.offers).toHaveLength(3);
  });

  it("JSON-LD 用 isRelatedTo 把 Connect 指回 Mediary Scout 主站(品牌实体串联)", () => {
    const html = homePage();
    const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
    expect(m![1]).toContain("https://mediaryscout.app/");
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

  // Copilot round-4:/api/auth/magic 恒返回 202(不泄露注册状态),
  // 所以「成功」不代表邮箱写对了。永久 disabled 会让拼错地址的用户
  // 必须刷新页面才能更正 —— 而他此刻正等着收信,不会想到刷新。
  it("202 之后表单要交还给用户(恒 202,拼错邮箱也要能改)", () => {
    const html = homePage();
    const i = html.indexOf("res.status === 202");
    const seg = html.slice(i, i + 500);
    expect(seg).toContain("input.disabled = false");
    expect(seg).toContain("改一下邮箱重发");
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

  // Copilot round-5:本目录其它五个页面(login/buy/console/compliance/beta)
  // 都用 <main> 作主体容器,只有这页用 <div> —— 缺 landmark,屏幕阅读器
  // 少一个跳转锚点。注意 .apex 必须保持 div:它是主题作用域 + 容器查询根,
  // nav/footer 也要吃它的 token,把它改成 main 会让 nav/footer 落进 main 里。
  it("有 <main> landmark,且 nav/footer 在它之外", () => {
    const html = homePage();
    expect((html.match(/<main[ >]/g) ?? []).length).toBe(1);
    expect(html).toContain("</main>");
    const iNav = html.indexOf("<nav");
    const iMain = html.indexOf("<main");
    const iClose = html.indexOf("</main>");
    const iFoot = html.indexOf("<footer");
    expect(iNav).toBeLessThan(iMain);
    expect(iClose).toBeLessThan(iFoot);
  });

  // 线上真 bug(测试全绿但页面坏):.apex a 是类+标签(特异性 0,1,1),
  // 压过纯类 .btn(0,1,0) —— 主 CTA 文字变绿色 = 绿底绿字,按钮看起来是空的。
  // 用户截图发现:海报墙左边缘是一条硬直线。真因不是渐变曲线不够柔,
  // 而是 overflow:hidden 把超出容器的海报**直接裁掉**(实测容器左边界 x=743、
  // 网格从 x=641 开始,中间 102px 被硬裁),裁切边是真实竖线 ——
  // ::after 盖渐变只在容器内部生效,管不到它。必须用 mask 让元素自身淡出。
  // 用户发现:海报被截断成横条。TMDB 海报是标准 2:3 竖版(实测 342x513),
  // 而写死 height:104px 会渲染成 159x124(比例 1.28)—— object-fit:cover
  // 把上下裁掉约 62%,只剩中间一条,海报变成认不出的色块。
  it("海报用 aspect-ratio 2/3,不写死 height(否则竖版被裁成横条)", () => {
    const html = homePage();
    // **断言前必须剥掉 CSS 注释** —— 注释就写在这条声明内部,
    // 而我的说明文字里含「写死 height:104px」这几个字。开发时连踩两次:
    // ① 宽正则命中注释;② 缩到声明内仍命中(注释在声明里)。
    const css = html.replace(/\/\*[\s\S]*?\*\//g, "");
    const decl = css.match(/\.pw img\{([^}]*)\}/)?.[1] ?? "";
    expect(decl).toContain("aspect-ratio:2 / 3");
    expect(decl).toContain("height:auto");
    expect(decl).not.toMatch(/height:\d+px/);
    // 窄屏那条也不能写死
    expect(css).not.toContain(".pw img{height:74px}");
  });

  it("海报墙用 mask-image 四边淡出(渐变盖不住 overflow 裁切边)", () => {
    const html = homePage();
    // 水平 + 垂直两层,相乘
    expect(html).toContain("mask-composite:intersect");
    expect(html).toContain("-webkit-mask-composite:source-in");
    // 四个方向都要淡:只做水平的话上/右边界仍是硬线。
    // **正则要排除 -webkit- 前缀**:直接写 /mask-image:/ 会匹配到
    // `-webkit-mask-image:`(子串包含),那样即便标准属性被删掉测试照样绿,
    // Firefox 上的退化就测不出来。用负向后顾锁住无前缀那条。
    // 断言要落在**同一条声明**内(分号前):否则 toContain 只要文件里任何地方
    // 出现 180deg 就过,而无前缀的 mask-image 可能只剩水平那层(Firefox 退化)。
    const decl = (prefix: string) => {
      const re = new RegExp(`${prefix}mask-image:([^;]*);`);
      return html.match(re)?.[1] ?? "";
    };
    for (const p of ["(?<!-webkit-)", "-webkit-"]) {
      const d = decl(p);
      expect(d, `${p}mask-image 缺水平层`).toContain("linear-gradient(90deg,transparent");
      expect(d, `${p}mask-image 缺垂直层`).toContain("linear-gradient(180deg,transparent");
    }
  });

  // Copilot round-3:桌面 mask 是「从左淡入」(让左侧文字区干净),
  // 但窄屏是单列、海报在文字上方的横条 —— 水平淡入会吃掉横条左半边。
  // 实测 392px 下若不在 @container 里覆盖,mask 仍带 90deg。
  it("窄屏覆盖 mask 为纵向淡出(桌面的水平淡入在横条上是错的)", () => {
    const html = homePage();
    const i = html.indexOf("@container (max-width:760px)");
    expect(i).toBeGreaterThan(0);
    const seg = html.slice(i, i + 2600);
    expect(seg).toContain("linear-gradient(180deg,#000 0%,#000 55%,transparent 100%)");
    // 覆盖必须同时给两个前缀,否则 Firefox 仍吃桌面那套
    expect(seg).toContain("-webkit-mask-image:linear-gradient(180deg");
  });

  it("按钮文字色用 .apex 前缀覆盖(否则被 .apex a 的绿色压掉)", () => {
    const html = homePage();
    // 必须带 .apex 前缀才压得住
    expect(html).toContain(".apex .btn{color:var(--brand-ink)}");
    expect(html).toContain(".apex .btn2{color:var(--tx-1)}");
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
