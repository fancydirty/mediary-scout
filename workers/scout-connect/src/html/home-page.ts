import { BRAND_BAR, BRAND_CSS, FAVICON_LINK, THEME_BASE, THEME_TOKENS } from "./theme.js";
import { FALLBACK_POSTERS, POSTER_BASE } from "./home-posters.js";

/**
 * 顶栏 GitHub 图标。inline 而非外链:一个 icon 不值一次请求。
 *
 * **不显示 star 数**:worker 是服务端渲染,拿 star 要么构建期烤死(会过期)、
 * 要么运行时打 GitHub API(给每次首页访问加一次外部依赖 + 失败要兜底)。
 * 主站是纯前端、可以异步拉,这里不划算 —— 只放图标 + "GitHub" 字样。
 */
const GH_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-2.91-.88-2.91-2.9 0-.58.21-1.05.55-1.42-.05-.14-.24-.71.05-1.47 0 0 .6-.19 1.96.73a5.6 5.6 0 0 1 1.5-.2c.51 0 1.02.07 1.5.2 1.36-.93 1.96-.73 1.96-.73.29.76.1 1.33.05 1.47.34.37.55.84.55 1.42 0 2.03-1.13 2.7-2.92 2.9.29.26.55.75.55 1.51 0 1.09-.01 1.98-.01 2.25 0 .21.15.46.55.38A7.99 7.99 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>';

/** 首屏立刻要出现的海报数(4 列 × 2 行)。见 posterWall 的取舍说明。 */
const EAGER_POSTERS = 8;

/**
 * Hero 海报墙。
 *
 * **前 8 张 eager,其余 lazy**。两头都踩过:
 * - 全 lazy → 首屏空一片(开发时实测上排全是空框)。海报墙是首屏视觉主体,
 *   它不出现等于 hero 右半边是空的。
 * - 全 eager → 28 个图片请求与关键 CSS/HTML 抢带宽,慢网下拖慢首次渲染。
 *
 * 折中:第一屏可见的两行(4 列 × 2)eager,下面的交给 lazy —— 它们本来就在
 * 遮罩淡出区,晚一点出现看不出来。
 */
function posterWall(): string {
  const imgs = FALLBACK_POSTERS.map(
    (p, i) =>
      `<img src="${POSTER_BASE}${p}" alt="" loading="${i < EAGER_POSTERS ? "eager" : "lazy"}">`,
  ).join("");
  return `<div class="hero-r" aria-hidden="true"><div class="pw">${imgs}</div></div>`;
}

export function homePage(): string {
  return `<!doctype html>
<html lang="zh-Hans">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mediary Connect — 自托管 Mediary Scout 的远程访问服务</title>
<meta name="description" content="Mediary Connect 用 Cloudflare 加密隧道,把你自己部署的 Mediary Scout 实例发布到一个专属域名:无需公网 IP、无需端口转发、无需自备域名。媒体内容与网盘凭证始终留在你自己的机器上。预付时长制,无自动续费,14 天无理由退款。">
<link rel="canonical" href="https://mediaryconnect.app/">
<!-- 结构化数据:让搜索引擎把 Connect 识别成「Mediary Scout 的增值服务」而不是
     一个孤立域名(品牌实体串联),并声明真实价格。价格必须与页面可见价格一致
     —— 结构化数据与可见内容不符是明确违规,有测试守着。 -->
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Product","@id":"https://mediaryconnect.app/#product","name":"Mediary Connect","url":"https://mediaryconnect.app/","description":"为自托管的 Mediary Scout 实例提供远程访问:一条 Cloudflare 加密隧道 + 专属域名,无需公网 IP、端口转发或自备域名。","brand":{"@type":"Brand","name":"Mediary"},"isRelatedTo":{"@type":"SoftwareApplication","name":"Mediary Scout","url":"https://mediaryscout.app/"},"offers":[{"@type":"Offer","name":"季度(3 个月)","price":"45","priceCurrency":"CNY","url":"https://mediaryconnect.app/pricing","availability":"https://schema.org/InStock"},{"@type":"Offer","name":"年度(12 个月)","price":"108","priceCurrency":"CNY","url":"https://mediaryconnect.app/pricing","availability":"https://schema.org/InStock"}]},{"@type":"Organization","@id":"https://mediaryconnect.app/#org","name":"DF Digital","url":"https://mediaryconnect.app/","sameAs":["https://github.com/fancydirty/mediary-scout","https://mediaryscout.app/"]}]}</script>
<meta property="og:site_name" content="Mediary Connect">
<meta property="og:type" content="website">
<meta property="og:url" content="https://mediaryconnect.app/">
<meta property="og:title" content="Mediary Connect — 自托管 Mediary Scout 的远程访问服务">
<meta property="og:description" content="一条 Cloudflare 加密隧道,让你在任何设备的浏览器打开自己家的 Mediary Scout 面板。不用公网 IP,不用开端口,不用买域名。内容始终留在你自己的机器上。">
<meta property="og:locale" content="zh_CN">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Mediary Connect — 自托管 Mediary Scout 的远程访问服务">
<meta name="twitter:description" content="一条 Cloudflare 加密隧道,让你在任何设备的浏览器打开自己家的 Mediary Scout 面板。不用公网 IP,不用开端口,不用买域名。">
${FAVICON_LINK}
<style>
${THEME_TOKENS}
${THEME_BASE}
${BRAND_CSS}

/* ── 本页局部 token:把设计稿的命名映射到共享 theme 的值 ──────────────
   刻意**不改** theme.ts 的全局变量名 —— 那会波及登录/控制台/合规五页。
   这里只是本页的别名 + 补齐 theme 没有的层级(色阶步长、alpha 边框)。 */
.apex{
  --bg-0:var(--bg-base);
  --bg-1:#161816; --bg-2:#1a1c1a; --bg-3:#1f211f;
  /* 边框全部用白色 alpha。原来用实色 #4d4d4d,对比度 2.101 —— 实测是
     Linear 生产值的 1.69 倍,装饰比正文还抢眼。.06 叠出 1.17,与之同档。 */
  --line-faint:rgba(255,255,255,.04);
  --line:rgba(255,255,255,.06);
  --line-strong:rgba(255,255,255,.14);
  --tx-1:#f5f5f5; --tx-2:var(--text-muted); --tx-3:#8a8f98; --tx-4:#6a6a6a;
  --brand:var(--accent); --brand-ink:#111312;
  --brand-tint:rgba(30,215,96,.07); --brand-line:rgba(30,215,96,.24);
  --s-2:16px;--s-3:24px;--s-4:32px;--s-5:48px;--s-6:64px;--s-7:96px;--s-8:128px;
  --r-panel:16px; --r-big:28px; --r-pill:9999px;
  --shell:1080px; --gutter:clamp(20px,5vw,46px);
  --ease:cubic-bezier(.215,.61,.355,1);
  container-type:inline-size;   /* 布局按容器宽度响应,不是视口 */
}
.apex{max-width:var(--shell);margin:0 auto;line-height:1.75}
.apex a{color:var(--brand);text-decoration:none}
/* **必须用 .apex 前缀**:上面的「.apex a」(类+标签,特异性 0,1,1)会压过
   纯类选择器(0,1,0)。线上实测主 CTA 的文字变成绿色 = 绿底绿字,整个按钮
   看起来是空的。同一个特异性坑在本文件已踩过第三次(h2 reset、a、btn),
   凡是要覆盖「.apex a」的规则都得带 .apex 前缀。 */
.apex .btn{color:var(--brand-ink)}
.apex .btn2{color:var(--tx-1)}
.apex .lg{color:var(--tx-1)}
.apex .gh{color:var(--tx-2)}
.apex a:hover{text-decoration:underline}
.apex .num{font-variant-numeric:tabular-nums}

/* 顶栏 */
.nav{display:flex;align-items:center;gap:16px;padding:15px var(--gutter);
  border-bottom:1px solid var(--line-faint)}
.nav .brand{margin:0;padding:0}
.nv{display:flex;gap:18px;margin-left:auto;align-items:center;font-size:13.5px}
.nv a{color:var(--tx-2)}
.gh{display:inline-flex;align-items:center;gap:6px;color:var(--tx-2)!important;
  font:500 12.5px/1 var(--mono)}
.gh svg{width:14px;height:14px;fill:currentColor}
.gh .st{color:var(--tx-3)}
.lg{color:var(--tx-1)!important;box-shadow:inset 0 0 0 1px var(--line);
  border-radius:var(--r-pill);padding:7px 16px;font-weight:600;
  transition:box-shadow .16s var(--ease)}
.lg:hover{box-shadow:inset 0 0 0 1px var(--line-strong);text-decoration:none}

/* 无边框 section 是主结构:留白+排版划分,不用盒子堆叠 */
.sec{padding:var(--s-8) var(--gutter)}
.sec+.sec{padding-top:var(--s-7)}
.eb{font:500 11.5px/1.4 var(--mono);letter-spacing:.1em;text-transform:uppercase;
  color:var(--tx-3);margin:0 0 14px}
.apex h1{margin:0 0 20px;font-size:clamp(30px,4.4vw,52px);font-weight:600;
  line-height:1.18;letter-spacing:-.018em}  /* 中文负字距 ≤.02em,再大会粘字 */
/* h2/h3 是**真标题标签**(语义化:屏幕阅读器与文档大纲需要),样式全由
   .h2/.h3 显式定义 —— 它们已经覆盖了 margin/font-size/font-weight/
   line-height,所以浏览器默认值不会露出来。
   **不要**再加「.apex h2{...}」这种 reset:类+标签的特异性(0,1,1)高于
   纯类(0,1,0),reset 会反过来盖掉 .h2 —— 开发时踩过,h2 变成 16px/400。 */
.h2{margin:0 0 10px;font-size:clamp(22px,2.8vw,31px);font-weight:600;
  line-height:1.3;letter-spacing:-.01em}
.h3{margin:0 0 6px;font-size:19px;font-weight:500;line-height:1.45}
.lead{color:var(--tx-2);font-size:17px;line-height:1.7;max-width:52ch;margin:0 0 22px}
.lead b{color:var(--tx-1);font-weight:500}
.note{color:var(--tx-2);font-size:14.5px;max-width:56ch;margin:0 0 20px}

/* 雕刻分隔线(1px 亮 + 1px 黑,造受光/投影的物理感) */
.rule{border:0;margin:0;height:2px;background:transparent}
.rule::before,.rule::after{content:'';display:block;height:1px}
.rule::before{background:rgba(255,255,255,.07)}
.rule::after{background:#000}
.rf{border:0;height:1px;margin:0;
  background:linear-gradient(90deg,transparent,var(--line) 18%,var(--line) 82%,transparent)}

/* ── Hero 两栏:左文案 / 右海报墙 ── */
.hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,.82fr);
  gap:var(--s-6);align-items:center;padding:var(--s-8) 0 var(--s-8) var(--gutter)}
.hero-l{min-width:0;position:relative;z-index:2}
.hero-r{position:relative;min-width:0;align-self:stretch;overflow:hidden;
  pointer-events:none;
  /* **关键**:用 mask 让元素自身淡出,而不是靠 ::after 盖一层渐变。
     盖渐变解决不了硬边 —— overflow:hidden 会把超出容器的海报**直接裁掉**,
     裁切边是一条真实的竖线,而渐变只在容器内部生效、管不到它。
     实测:容器左边界 x=743,海报网格从 x=641 开始,中间 102px 被硬裁。
     mask 作用在元素合成阶段,连裁切边一起淡掉。 */
  /* 两层 mask 相乘(mask-composite:intersect):水平从左淡入 + 垂直上下淡出。
     必须四边都淡 —— 只做水平的话,容器上边界和右边界的裁切边同样是硬线
     (实测顶部 y=68、右侧 x=1226 各留一条)。右侧留 92% 而非 100%:
     它贴着 section 边缘,完全不淡会切出直角。 */
  -webkit-mask-image:
    linear-gradient(90deg,transparent 0%,rgba(0,0,0,.35) 14%,rgba(0,0,0,.8) 40%,#000 70%,#000 92%,rgba(0,0,0,.55) 100%),
    linear-gradient(180deg,transparent 0%,#000 12%,#000 88%,transparent 100%);
  -webkit-mask-composite:source-in;
          mask-image:
    linear-gradient(90deg,transparent 0%,rgba(0,0,0,.35) 14%,rgba(0,0,0,.8) 40%,#000 70%,#000 92%,rgba(0,0,0,.55) 100%),
    linear-gradient(180deg,transparent 0%,#000 12%,#000 88%,transparent 100%);
          mask-composite:intersect;
  /* 向右出血到 section 边缘。**不能用 calc(50% - 50vw)** —— 那个 50% 相对
     父元素(窄网格子项)算,实测溢出到 right=1573 而视口 1280,会出横向滚动条。 */
  margin-top:calc(var(--s-8) * -1);margin-bottom:calc(var(--s-8) * -1);
  margin-right:calc(var(--gutter) * -1)}
.pw{position:absolute;inset:-8%;display:grid;grid-template-columns:repeat(4,1fr);
  gap:6px;transform:rotate(-2deg) scale(1.14);
  animation:drift 26s ease-in-out infinite alternate}
.pw img{width:100%;
  /* **必须用 aspect-ratio,不能写死 height。** TMDB 海报是标准 2:3 竖版
     (实测 342x513,比例 0.67),而写死 height:104px 会让它渲染成 159x124
     (比例 1.28)—— object-fit:cover 于是把上下裁掉约 62%,只剩中间一条,
     海报变成认不出的色块。让高度跟着宽度按 2:3 算,内容才完整。 */
  aspect-ratio:2 / 3;height:auto;
  object-fit:cover;border-radius:5px;display:block;
  /* 压暗:海报是背景,不能抢标题。.52 是配合上面两层调出来的 ——
     mask 右端(92%→100%)只从 #000 淡到 .55、::after 右侧只压 .18,
     也就是右侧遮得很轻;图本身若不压暗就会比左侧亮太多,像两张拼接的图。 */
  opacity:.52}
@keyframes drift{
  from{transform:rotate(-2deg) scale(1.14) translate3d(0,0,0)}
  to{transform:rotate(-2deg) scale(1.14) translate3d(-10px,-16px,0)}}
@media (prefers-reduced-motion:reduce){.pw{animation:none}}
/* 压暗层:把海报的色调拉回底色,让它读起来是背景而不是内容。
   **只管色调,不管边缘** —— 四边淡出全部由 .hero-r 的 mask-image 负责
   (见那里的注释:渐变盖不住 overflow 的裁切边)。
   数值从左到右 .5 → .28 → .18:左侧压重是因为文字区在那边,
   右侧留浅一点让海报还能看清是海报。 */
.hero-r::after{content:"";position:absolute;inset:0;pointer-events:none;
  background:linear-gradient(90deg,rgba(17,19,18,.5) 0%,rgba(17,19,18,.28) 45%,rgba(17,19,18,.18) 100%)}
.hero-r::before{content:"";position:absolute;inset:0;z-index:1;pointer-events:none;
  background:radial-gradient(80% 60% at 85% 15%,rgba(30,215,96,.14),transparent 70%)}

/* 假地址栏:把交付物具象化(纯 CSS,零成本) */
.ub{display:flex;align-items:center;gap:10px;max-width:420px;padding:12px 15px;
  margin:0 0 20px;border-radius:10px;background:var(--bg-2);
  box-shadow:inset 0 0 0 1px var(--line)}
.ub code{font:400 13.5px/1 var(--mono);color:var(--tx-1)}
.ub .sl{color:var(--brand);font-weight:600}
.pos{max-width:56ch;margin:0 0 26px;font-size:14.5px;color:var(--tx-2);line-height:1.7}
.pos b{color:var(--tx-1);font-weight:500}
.pos code{font:400 13px/1 var(--mono);color:var(--brand);background:var(--brand-tint);
  padding:2px 6px;border-radius:4px}
.row{display:flex;align-items:center;gap:18px;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;min-height:44px;padding:0 24px;border:0;
  border-radius:var(--r-pill);background:var(--brand);color:var(--brand-ink);
  font:600 15px/1 var(--font);cursor:pointer;
  transition:filter .16s var(--ease),transform .16s var(--ease)}
.btn:hover{filter:brightness(1.1);text-decoration:none}
.btn:active{transform:scale(.97)}
.btn2{display:inline-flex;align-items:center;min-height:44px;padding:0 22px;
  background:transparent;color:var(--tx-1);border:0;
  box-shadow:inset 0 0 0 1px var(--line);border-radius:var(--r-pill);
  font:500 14.5px/1 var(--font);transition:box-shadow .16s var(--ease)}
.btn2:hover{box-shadow:inset 0 0 0 1px var(--line-strong);text-decoration:none}
.micro{font:400 12.5px/1.7 var(--mono);color:var(--tx-4);margin:18px 0 0}

/* 通栏带:打断居中流,制造章节感 */
.band{width:100%;padding:var(--s-7) var(--gutter);background:var(--bg-1);
  border-top:1px solid var(--line-faint);border-bottom:1px solid var(--line-faint)}

/* Scout 说明:终端演示窗 */
.win{margin:var(--s-4) 0 0;border-radius:12px;overflow:hidden;background:#0b0c0b;
  box-shadow:inset 0 0 0 1px var(--line)}
.wdots{display:flex;gap:6px;padding:11px 13px;border-bottom:1px solid var(--line-faint)}
.wdots i{width:9px;height:9px;border-radius:50%;display:block}
.wdots i:nth-child(1){background:var(--err)}
.wdots i:nth-child(2){background:#e0a33a}
.wdots i:nth-child(3){background:var(--brand)}
.wbody{padding:15px 16px;font:400 12.5px/2 var(--mono);color:var(--tx-2)}
.wbody .ln{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wbody .ok{color:var(--brand);font-weight:600}
.wbody .dim{color:var(--tx-4)}
.vidwrap{margin:var(--s-4) 0 0;border-radius:12px;overflow:hidden;
  box-shadow:inset 0 0 0 1px var(--line);background:#0b0c0b}
.vidwrap video{display:block;width:100%;height:auto}
.flow{display:grid;grid-template-columns:repeat(4,1fr);gap:var(--s-4);margin:var(--s-5) 0 0}
.fl{padding-top:14px;border-top:1px solid var(--line)}
.fl .n{font:500 11px/1 var(--mono);letter-spacing:.1em;color:var(--brand);margin:0 0 8px}
.fl b{display:block;font-size:14.5px;font-weight:600;margin:0 0 5px}
.fl p{margin:0;font-size:13px;color:var(--tx-2);line-height:1.6}
.drives{display:flex;align-items:center;gap:var(--s-3);flex-wrap:wrap;
  margin:var(--s-4) 0 0;padding:16px 18px;border-radius:12px;background:var(--bg-2)}
.drives .lbl{font:500 11.5px/1 var(--mono);letter-spacing:.08em;color:var(--tx-3)}
.drives .dv{font-size:13px;color:var(--tx-2)}
.endorse{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:var(--s-4) 0 0}
.endorse .p{font:500 11.5px/1 var(--mono);color:var(--tx-2);padding:5px 10px;
  border-radius:var(--r-pill);background:var(--bg-2);box-shadow:inset 0 0 0 1px var(--line)}

/* 闸门三选一 */
.gate{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:20px 0 0}
.gc{padding:15px 17px;border-radius:12px;background:var(--bg-2);cursor:pointer;
  box-shadow:inset 0 0 0 1px var(--line);transition:box-shadow .16s var(--ease);
  border:0;text-align:left;font:inherit;color:inherit;width:100%}
.gc:hover{box-shadow:inset 0 0 0 1px var(--brand-line)}
.gc[aria-expanded="true"]{background:var(--brand-tint);box-shadow:inset 0 0 0 1px var(--brand)}
.gc p{margin:0;font-weight:600;font-size:14px}
.gopen{margin:12px 0 0;padding:18px 20px;border-radius:12px;background:var(--bg-2)}
.gopen p{color:var(--tx-2);font-size:14px;margin:0 0 9px}
.gopen p:last-child{margin:0}
.gopen b{color:var(--tx-1);font-weight:500}
.gopen[hidden]{display:none}

/* 边界双栏:不用「不」字墙 */
.bd2{display:grid;grid-template-columns:1fr 1fr;gap:var(--s-6) var(--s-5);margin:var(--s-5) 0 0}
.bcol h3{font:500 12px/1.4 var(--mono);letter-spacing:.09em;text-transform:uppercase;
  color:var(--tx-3);margin:0 0 4px}
.bcol .sub{font-size:13px;color:var(--tx-4);margin:0 0 var(--s-3)}
.bl{list-style:none;margin:0;padding:0}
.bl li{padding:14px 0;border-top:1px solid var(--line-faint);font-size:14px;
  color:var(--tx-2);line-height:1.65}
.bl li:first-child{border-top:0;padding-top:0}
.bl li b{display:block;color:var(--tx-1);font-weight:500;margin-bottom:3px}

/* 步骤:大序号锚点 + hairline,不用卡片 */
.steps{list-style:none;counter-reset:s;margin:var(--s-5) 0 0;padding:0}
.steps>li{counter-increment:s;display:grid;grid-template-columns:auto 1fr;
  gap:var(--s-4);padding:var(--s-5) 0;border-top:1px solid var(--line-faint)}
.steps>li::before{content:counter(s,decimal-leading-zero);
  font:500 12.5px/1 var(--mono);letter-spacing:.1em;color:var(--tx-4);padding-top:.7em}
.steps>li.z::before{content:"00";color:var(--brand)}
.steps .h3{margin-bottom:5px}
.steps p{margin:0;color:var(--tx-2);font-size:14px}
.cmd{position:relative;margin:12px 0 0;padding:13px 15px;border-radius:10px;
  background:#0b0c0b;box-shadow:inset 0 0 0 1px var(--line);
  font:400 12px/1.6 var(--mono);color:#d6d6d6;overflow-x:auto;white-space:nowrap}
.pr{margin:12px 0 0;padding:15px 17px;border-radius:12px;background:var(--bg-2);
  box-shadow:inset 0 0 0 1px var(--line)}
.pr .ph{display:flex;align-items:center;gap:9px;margin:0 0 10px}
.pr .ph span{font:500 11px/1 var(--mono);letter-spacing:.09em;text-transform:uppercase;
  color:var(--tx-3)}
.pr pre{margin:0;font:400 11.5px/1.75 var(--mono);color:var(--tx-2);
  white-space:pre-wrap;word-break:break-word}
.pr pre b{color:var(--tx-1);font-weight:600}

/* 价格:无描边,靠色阶 */
.pg{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:var(--s-4) 0 0}
.pc{position:relative;display:flex;flex-direction:column;padding:18px 17px;
  border-radius:var(--r-panel);background:var(--bg-2)}
.pc.f{background:var(--brand-tint);box-shadow:inset 0 0 0 1px var(--brand-line)}
.pc.f::before{content:'';position:absolute;inset:0 0 auto;height:1px;
  background:linear-gradient(90deg,transparent,var(--brand),transparent)}
.pbg{position:absolute;top:-8px;right:14px;background:var(--brand);color:var(--brand-ink);
  font:700 9.5px/1 var(--mono);letter-spacing:.06em;padding:4px 9px;border-radius:var(--r-pill)}
.pn{font-size:12.5px;color:var(--tx-3);margin:0 0 8px}
.pa{font:300 34px/1 var(--font);letter-spacing:-.03em;margin:0;font-variant-numeric:tabular-nums}
.pp{font:400 11.5px/1.5 var(--mono);color:var(--tx-4);margin:7px 0 0}
.pq{font-size:11px;color:var(--tx-4);margin:12px 0 0;padding-top:11px;
  border-top:1px solid var(--line-faint);line-height:1.5}
.pfoot{margin:var(--s-4) 0 0;padding-left:var(--s-3);border-left:2px solid var(--brand-line)}
.pfoot p{font-size:13.5px;color:var(--tx-2);margin:0 0 9px}
.pfoot p:last-child{margin:0}
.pfoot b{color:var(--tx-1);font-weight:500}

/* 登录 */
.login{margin:var(--s-5) 0 0;padding:24px;border-radius:var(--r-big);
  background:var(--bg-2);box-shadow:inset 0 0 0 1px var(--line)}
.lrow{display:flex;gap:10px;margin:16px 0 0}
.lrow input{flex:1;height:50px;border:0;border-radius:10px;background:var(--bg-0);
  box-shadow:inset 0 0 0 1px var(--line);color:var(--tx-1);padding:0 16px;
  font:400 15px/1 var(--font);outline:none}
.lrow input::placeholder{color:var(--tx-4)}
.lrow input:focus{box-shadow:inset 0 0 0 1px var(--brand)}
.lrow .btn{height:50px;white-space:nowrap}
.qa{margin:20px 0 0}
.qa dt{font-weight:600;font-size:14px;margin:0 0 5px;color:var(--tx-1)}
.qa dd{margin:0 0 16px;font-size:13.5px;color:var(--tx-2);line-height:1.7}
.qa dd:last-child{margin:0}
.qa dd b{color:var(--tx-1);font-weight:500}
.lmsg{margin:12px 0 0;font-size:13px;color:var(--tx-3)}
.lmsg[hidden]{display:none}

/* 诚实说明 */
.hon p{color:var(--tx-2);font-size:14.5px;margin:0 0 12px;max-width:60ch;line-height:1.75}
.hon p:last-child{margin:0}
.hon b{color:var(--tx-1);font-weight:500}
.sign{margin:var(--s-4) 0 0;padding-top:var(--s-3);
  border-top:1px solid var(--line-faint);font-size:13px;color:var(--tx-3)}

.ft{padding:var(--s-5) var(--gutter) var(--s-6);border-top:1px solid var(--line-faint);
  font-size:12.5px;color:var(--tx-4);line-height:2}
.ft a{color:var(--tx-3)}

/* ── 响应式:用 @container(按容器宽度)而非 @media(按视口)。
      设计稿的窄框与真手机因此得到同一套布局。 ── */
@container (max-width:1000px){
  .bd2{grid-template-columns:1fr;gap:var(--s-5)}
  .pg{grid-template-columns:repeat(2,1fr)}
  .flow{grid-template-columns:repeat(2,1fr);gap:var(--s-4)}
  .hero{grid-template-columns:minmax(0,1fr) minmax(0,.62fr);gap:var(--s-5)}
}
@container (max-width:760px){
  .hero{grid-template-columns:1fr;padding:var(--s-5) var(--gutter) var(--s-6);gap:var(--s-4)}
  /* 窄屏:海报墙压成顶部装饰带,遮罩改成**纵向**淡出。
     必须显式覆盖 mask —— 桌面那套是「从左淡入」(为了让左侧文字区干净),
     但窄屏是单列、海报在文字**上方**的横条,水平淡入会把横条左半边吃掉。
     实测 392px 下若不覆盖,mask 仍带 90deg。 */
  .hero-r{order:-1;margin:calc(var(--s-5) * -1) calc(var(--gutter) * -1) var(--s-2);
    height:150px;align-self:auto;
    -webkit-mask-image:linear-gradient(180deg,#000 0%,#000 55%,transparent 100%);
            mask-image:linear-gradient(180deg,#000 0%,#000 55%,transparent 100%);
    -webkit-mask-composite:source-over;
            mask-composite:add}
  /* 窄屏同理:不写死高度,让 aspect-ratio 继续生效(装饰带靠容器 height 裁) */
  .pw img{height:auto}
  .hero-r::after{background:linear-gradient(180deg,rgba(17,19,18,.55) 0%,
    rgba(17,19,18,.2) 40%,var(--bg-0) 100%)}
  .gate,.pg,.flow{grid-template-columns:1fr}
  .gate{gap:8px}
  .sec{padding:var(--s-5) var(--gutter) var(--s-6)}
  .sec+.sec{padding-top:var(--s-5)}
  .band{padding:var(--s-6) var(--gutter)}
  .apex h1{font-size:1.72rem;line-height:1.24}
  .lead{font-size:15px}
  .ub{max-width:100%}
  .ub code{font-size:12px;word-break:break-all}
  .nv{gap:11px}
  .nv .hm{display:none}
  .lg{padding:6px 13px;white-space:nowrap;flex:none}
  .gh{flex:none}
  /* 登录区纵向堆叠。**关键**:基础样式的 flex:1 在 column 方向作用于「高度」,
     flex-basis:0% 会把 input 压成内容高(实测 18px),此时 height 完全失效 ——
     连 inline style 都压不住。必须先 flex:none。 */
  .lrow{flex-direction:column;gap:10px}
  .lrow input,.lrow .btn{width:100%;box-sizing:border-box;flex:none}
  .lrow input,.lrow .btn{height:48px}
  .lrow .btn{justify-content:center}
  .login{padding:18px}
  .steps>li{grid-template-columns:1fr;gap:8px;padding:var(--s-4) 0}
  .steps>li::before{padding-top:0}
  .cmd{white-space:pre-wrap;word-break:break-all;font-size:11.5px}
  .pr pre{font-size:11px}
  .wbody{font-size:11.5px;line-height:1.9}
  .drives{gap:12px;padding:14px}
  .row .btn2{width:100%;justify-content:center}
}

</style>
</head>
<body>
<!-- .apex 是主题作用域 + 容器查询根(container-type),nav/footer 也要吃它的
     token 与响应式断点,所以它包住三者;main 只包主内容 —— 与本目录其它
     页面(login/buy/console/compliance/beta)一致的 landmark 结构。 -->
<div class="apex">

  <nav class="nav">
    ${BRAND_BAR}
    <div class="nv">
      <a href="#boundary" class="hm">边界</a>
      <a href="#pricing" class="hm">定价</a>
      <a href="https://github.com/fancydirty/mediary-scout" class="gh" target="_blank" rel="noopener">${GH_ICON}<span class="st num">GitHub</span></a>
      <a href="/login" class="lg">登录</a>
    </div>
  </nav>

  <main>
  <section class="sec hero">
    <div class="hero-l">
      <p class="eb">Mediary Scout 远程访问附加服务</p>
      <h1>家里的 Scout,<br>只能在家里看。</h1>
      <p class="lead">你已经把 Mediary Scout 跑在自己的 NAS 或软路由上了。Mediary Connect 给它一个专属域名,从外网直接打开 —— 不用给路由器开端口,不用 DDNS,不用公网 IP。<b>你的内容和凭据只在你和你的设备之间走,隧道两端加密,中间我们看不到。</b></p>
      <div class="ub"><code><span class="sl">你选的名字</span>.mediaryconnect.app</code></div>
      <p class="pos">Connect 是<b>一条通道</b>,不是一台云主机。它连接的是你自己那台机器上的 Scout —— 一条 <code>docker compose up</code> 的距离,下面有可以直接丢给 AI 的部署提示词。还没跑起来也没关系,往下第二个入口就是给你的。</p>
      <div class="row">
        <a href="#connect" class="btn">看看怎么接入</a>
        <a href="#pricing" class="btn2">我已经在跑 → 看定价</a>
      </div>
      <p class="micro">季 ¥45 / 年 ¥108 · 一次性付费,无自动续费 · 14 天无理由退款 · 邮箱登录,无需注册</p>
    </div>
    ${posterWall()}
  </section>

  <hr class="rule">

  <section class="sec">
    <p class="eb">先说清楚 Scout 是什么</p>
    <h2 class="h2">自建网盘的媒体获取 agent</h2>
    <p class="lead">指定一部影视,agent 跨源检索、择优、转存进<b>你自己的网盘</b>、回读核对,并持续追踪缺集。<b>凭证据,不凭感觉。</b>AGPL 开源,桌面版双击即用,也可 docker 自部署。</p>

    <div class="win">
      <div class="wdots"><i></i><i></i><i></i></div>
      <div class="wbody">
        <div class="ln">▸ 跨源检索 · 命中 <span class="num">37</span> 个候选</div>
        <div class="ln">▸ 择优 · 2160p · 中文字幕 · 体积合理</div>
        <div class="ln">▸ 转存至你的网盘 · <span class="dim">不经本地磁盘</span></div>
        <div class="ln">▸ 回读核对 · 完整无损</div>
        <div class="ln ok">✓ 已入库 &nbsp;·&nbsp; S01 · <span class="num">8</span>/<span class="num">12</span></div>
      </div>
    </div>

    <div class="flow">
      <div class="fl"><p class="n">01</p><b>检索与指定</b><p>搜到目标,点获取。agent 接管,你无需值守。</p></div>
      <div class="fl"><p class="n">02</p><b>择优</b><p>按画质、中文字幕、去重与真伪逐一筛选;<b>没有合格资源就如实报告</b>,不塞垃圾。</p></div>
      <div class="fl"><p class="n">03</p><b>转存与核对</b><p>秒传 / 离线转存进你的网盘,不占本地磁盘;转存后回读真实文件,确认完整无损。</p></div>
      <div class="fl"><p class="n">04</p><b>持续追踪</b><p>季级状态机记录缺集;定时巡检只在有新集时唤起 agent 补齐。</p></div>
    </div>

    <div class="drives">
      <span class="lbl">转存进你自己的</span>
      <span class="dv">115</span>
      <span class="dv">夸克</span>
      <span class="dv">光鸭</span>
      <span class="dv">123</span>
      <span class="dv">天翼</span>
      <span class="dv">五家网盘,任选</span>
    </div>

    <div class="endorse">
      <span class="p">阮一峰《科技爱好者周刊》推荐</span>
      <span class="p">HelloGitHub 收录</span>
    </div>

    <div class="row" style="margin-top:var(--s-5)">
      <a href="https://mediaryscout.app" class="btn2">Scout 官网 · 免费自部署 →</a>
      <a href="https://demo.mediaryscout.app" class="btn2" rel="nofollow">打开只读 Demo</a>
    </div>
    <p class="micro">Scout 本体开源免费,局域网内用不着付一分钱。Connect 卖的只是「从外网也能打开」这一段。</p>
  </section>

  <hr class="rf">

  <section class="sec">
    <h2 class="h2">你是哪一种?</h2>
    <p class="note">Connect 是附加服务。它需要一个已经在运行的 Scout 实例才有东西可连。</p>
    <div class="gate">
      <button class="gc" type="button" aria-expanded="true" aria-controls="g1"><p>我已经在跑 Scout</p></button>
      <button class="gc" type="button" aria-expanded="false" aria-controls="g2"><p>还没部署,但想试试</p></button>
      <button class="gc" type="button" aria-expanded="false" aria-controls="g3"><p>我想找在线追剧工具</p></button>
    </div>
    <div class="gopen" id="g1">
      <p><b>那就是最省事的情况。</b>选个时长,用你自己的邮箱登录,域名当天就能用。接入一共三步,最长的一步是等 cloudflared 拉镜像。</p>
    </div>
    <div class="gopen" id="g2" hidden>
      <p><b>顺序是:先把 Scout 跑起来</b>(开源、免费,和付不付钱无关),确认它在局域网里能用,再回来买通道。</p>
      <p>一台常开的小机器就够:群晖/威联通、软路由、迷你主机、旧笔记本都行。<a href="https://github.com/fancydirty/mediary-scout">部署文档 →</a></p>
      <p>买了但发现装不起来?<b>14 天内无理由全额退款</b>,不问原因,用过也退。</p>
    </div>
    <div class="gopen" id="g3" hidden>
      <p><b>那 Connect 帮不上你。</b>它不托管实例、不替你下载,付款之后也不会出现一个能直接登录的网站 —— 你拿到的是一条通往你自己机器的隧道;如果那台机器上什么都没有,域名就指向空气。</p>
      <p>想要的是「注册就能用」的服务,Connect 不是它,别花这个钱。想自己搭一台?<a href="https://github.com/fancydirty/mediary-scout">部署文档在这儿</a>,那部分完全免费。</p>
    </div>
  </section>

  <section class="band" id="boundary">
    <p class="eb">边界</p>
    <h2 class="h2">它碰不到什么,又需要你有什么</h2>
    <div class="bd2">
      <div class="bcol">
        <h3>它碰不到什么</h3>
        <p class="sub">不是承诺,是架构决定的</p>
        <ul class="bl">
          <li><b>你的媒体内容</b>看不到、存不下、转不走。隧道两端加密,技术上没有中间人这个位置。</li>
          <li><b>你的网盘账号</b>Connect 完全接触不到,凭据一直在你自己的机器上。</li>
          <li><b>你的登录密码</b>门禁是 Scout 自己的,第一次打开时由你设定,我们这边没有副本。</li>
        </ul>
      </div>
      <div class="bcol">
        <h3>它需要你有什么</h3>
        <p class="sub">一次准备,之后不用再想</p>
        <ul class="bl">
          <li><b>一台常开的机器</b>群晖/威联通、软路由、迷你主机、旧笔记本都行,上面跑着 Scout。</li>
          <li><b>搜索和下载由你的 Scout 自己完成</b>Connect 不参与这一步,它只负责让你从外面够得着。</li>
          <li><b>域名是你选的,永久保留</b>到期不释放给别人,退款也不释放。换机器重跑一行命令就恢复。</li>
        </ul>
      </div>
    </div>
  </section>

  <section class="sec" id="connect">
    <h2 class="h2">接入:三步,一行命令</h2>
    <p class="note">从零开始的话,第 0 步不花钱、也不经过我们。</p>
    <ol class="steps">
      <li class="z">
        <div>
          <h3 class="h3">先把 Scout 跑起来</h3>
          <p>开源免费,和付不付钱无关。不想自己读文档的话,挑一个丢给你的 AI agent(Claude Code / Codex / opencode 都行)。<b>三种情况分开写好了,选你的那个。</b></p>
      <div class="pr">
        <div class="ph"><span>① 只装 Scout(还没买 Connect)</span></div>
<pre>你在我的电脑上。我要在一台机器上部署 Mediary Scout(自托管媒体获取 agent)。

0. 先问我:这台机器是本机还是远程?远程的话要 SSH 目标(主机名/IP/端口/用户)。
   连不上就停下问我,<b>绝不猜地址乱试</b>。
1. 确认 docker 与 docker compose 可用:\`docker version &amp;&amp; docker compose version\`。
   缺就先装(问我操作系统,不要自作主张换包管理器)。
2. 选一个<b>数据盘</b>目录(不要装在系统盘的临时目录),
   \`git clone https://github.com/fancydirty/mediary-scout\` 并 cd 进去。
3. \`cp .env.example .env\`,然后<b>逐项问我</b>要这些值,不要编造、不要留占位符:
   - 网盘凭据(115/夸克/光鸭/123/天翼 任选其一起步)
   - LLM:base URL + API key + 模型名(任意 OpenAI 兼容服务)
   - TMDB_READ_TOKEN(没有就告诉我去哪申请)
4. \`docker compose up -d\`(首次构建要几分钟)。
5. <b>验证(缺一不可)</b>:
   - \`docker compose ps\` 所有服务 running/healthy
   - \`curl -fsS http://localhost:3300/api/health\` 返回 status ok
     (这条走真实 DB 读路径,DB 没起来会 503)
   任一不过就<b>视为部署失败</b>,不要跟我说「装好了」。
6. 用浏览器打开 \`http://&lt;这台机器的局域网IP&gt;:3300\`,
   首次进入会让设置访问密码 —— 提醒我自己设,你不要替我设。

任何一步失败:<b>立即停止</b>,把完整日志给我。
不做任何破坏性操作:不 force push、不删容器/卷、不 \`docker system prune\`、
不改我 .env 里已有的值。</pre>
      </div>
      <div class="pr">
        <div class="ph"><span>② 已有 Scout,再接 Connect</span></div>
<pre>你在我的电脑上。Mediary Scout 已经在另一台机器上跑着了,
我要给它接上 Mediary Connect(远程访问隧道)。取件码:&lt;粘贴你的取件码&gt;

0. 先定位部署机:我平时通过 http://&lt;局域网IP&gt;:3300 访问它。
   从这个地址推出 SSH 目标,端口和用户不确定就问我;连不上停下问我。
1. 在部署机上 \`docker ps\` 找到 Mediary Scout 的 web 容器。
2. \`docker inspect &lt;容器&gt; --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}'\`
   拿到部署目录并 cd 进去。<b>确认该目录下有 docker-compose.yml 和 .env</b>,
   不是就停下问我(别在错的目录里写文件)。
3. 在这个目录下跑:
   \`curl -fsSL https://mediaryconnect.app/connect.sh | sh -s -- &lt;取件码&gt;\`
   (脚本会用取件码换隧道凭据、原子写入 .env、用 --profile tunnel 起 cloudflared)
   取件码 <b>15 分钟有效、用完即弃</b>;报「已过期」就回控制台重新生成一个给我。
4. <b>验证(缺一不可)</b>:
   - \`docker compose ps\` 里 cloudflared 已 running
   - \`curl -fsS https://&lt;我的名字&gt;.mediaryconnect.app/api/health\` 返回 status ok
   脚本自己会轮询到隧道真通才报成功;它说失败就是失败,不要替它下结论。
5. 顺手确认原有服务没被碰坏:\`curl -fsS http://localhost:3300/api/health\` 仍然 ok。

任何一步失败:<b>立即停止</b>并把完整日志给我。
特别注意:<b>不要手动改 .env 里的隧道字段</b>(脚本负责),
不要删除或重建 web 容器,不要 \`docker compose down -v\`。</pre>
      </div>
      <div class="pr">
        <div class="ph"><span>③ 没装过 Scout,已买 Connect,一次装完</span></div>
<pre>你在我的电脑上。我要在一台机器上从零装好 Mediary Scout,
再接上 Mediary Connect 远程访问。取件码:&lt;粘贴你的取件码&gt;

<b>顺序很重要:Scout 必须先在局域网里验证通过,才能接隧道。</b>
先做完 A 段并让我确认,再做 B 段。

── A 段:装 Scout ──
0. 先问我:本机还是远程?远程要 SSH 目标。连不上停下问我,绝不猜。
1. \`docker version &amp;&amp; docker compose version\`,缺就先装(问我操作系统)。
2. 选数据盘目录,\`git clone https://github.com/fancydirty/mediary-scout\`,cd 进去。
3. \`cp .env.example .env\`,逐项问我要:网盘凭据、LLM base URL/key/模型、
   TMDB_READ_TOKEN。<b>不要编造任何值</b>。
4. \`docker compose up -d\`。
5. 验证:\`docker compose ps\` 全部 running/healthy
   且 \`curl -fsS http://localhost:3300/api/health\` 返回 ok。
6. 让我用局域网 IP 打开一次、设好访问密码,<b>等我回复确认后再继续</b>。
   (访问密码是我自己设的,你不要替我设 —— 它是我实例的唯一门禁)

── B 段:接 Connect ──
7. 仍在同一目录下:
   \`curl -fsSL https://mediaryconnect.app/connect.sh | sh -s -- &lt;取件码&gt;\`
   取件码 15 分钟有效;过期就让我回控制台重新生成。
8. 验证:\`docker compose ps\` 里 cloudflared running,
   且 \`curl -fsS https://&lt;我的名字&gt;.mediaryconnect.app/api/health\` 返回 ok。
9. 复核局域网访问没被影响:\`curl -fsS http://localhost:3300/api/health\` 仍 ok。

任何一步失败:<b>立即停止</b>,把完整日志给我,不要绕过。
不做破坏性操作:不 force push、不删容器/卷、不 prune、
不手改 .env 的隧道字段、不 \`docker compose down -v\`。</pre>
      </div>
        </div>
      </li>
      <li>
        <div>
          <h3 class="h3">买时长,并用你自己的邮箱登录</h3>
          <p>顺序是<b>先登录再付款</b> —— 时长要记在账号上,而不是记在你用的那张卡上(很多人用公司卡或家人的卡)。</p>
        </div>
      </li>
      <li>
        <div>
          <h3 class="h3">在控制台里选一个名字</h3>
          <p>实时查重,选定后永久属于你。付款后在控制台完成,不占用别人的名额。</p>
        </div>
      </li>
      <li>
        <div>
          <h3 class="h3">在跑 Scout 的机器上跑一行</h3>
          <div class="cmd">curl -fsSL https://mediaryconnect.app/connect.sh | sh -s -- &lt;取件码&gt;</div>
          <p style="margin-top:11px">部署目录不在当前路径时,末尾加 <code>--dir /path/to/deploy</code>。脚本凭取件码换隧道凭据、原子写入 .env、起 cloudflared,轮询到隧道真通才报成功。取件码 15 分钟有效、用完即弃,<b>我们不存你的 token</b>。</p>
          <p style="margin-top:8px;color:var(--tx-4);font-size:12.5px">这行要在跑 Scout 的那台机器上执行,不是在手机上。</p>
        </div>
      </li>
    </ol>
  </section>

  <hr class="rf">

  <section class="sec" id="pricing">
    <h2 class="h2">定价</h2>
    <p class="note"><b>14 天无理由退款,用过也退,不问原因。</b>预付时长,一次付清,不自动续费。</p>
    <div class="pg">
      <div class="pc"><p class="pn">季度</p><p class="pa">¥45</p><p class="pp">3 个月</p><p class="pq">需自备一台跑着<br>Scout 的机器</p></div>
      <div class="pc f"><span class="pbg">最常选</span><p class="pn">年度</p><p class="pa">¥108</p><p class="pp">12 个月 · ¥9/月</p><p class="pq">需自备一台跑着<br>Scout 的机器</p></div>
      <div class="pc"><p class="pn">两年</p><p class="pa">¥188</p><p class="pp">24 个月 · ¥7.8/月</p><p class="pq">需自备一台跑着<br>Scout 的机器</p></div>
    </div>
    <div class="pfoot">
      <p><b>怎么买:</b>先在下面用邮箱登录,进控制台后选档位付款、再选你的域名。<b>不能直接下单</b> —— 时长必须记在一个账号上,所以登录在前。</p>
      <p><b>不自动续费</b>:到期前邮件提醒,不续就自然到期,不会再扣一分钱。到期后 7 天宽限,之后域名停止解析 —— 你的实例本身不受任何影响。</p>
      <p>结账由 <b>Paddle</b> 完成,支持<b>微信支付</b>与信用卡(也支持 Apple Pay / Google Pay)。你的账单上会显示 Paddle 的名字,这是正常的 —— Paddle 是本服务的记录商户(MoR),收据与退款入口都在它的邮件里。</p>
    </div>
  </section>

  <section class="sec" id="start" style="padding-top:0">
    <div class="login">
      <h2 class="h2" style="font-size:1.35rem">开始</h2>
      <p class="note" style="margin-bottom:0">输入邮箱,我们发一个登录链接给你。登录后就能在控制台里买时长、选域名。</p>
      <form class="lrow" id="magic" novalidate>
        <input type="email" name="email" placeholder="your@email.com" inputmode="email" autocomplete="email" required aria-label="邮箱">
        <button type="submit" class="btn">发送登录链接</button>
      </form>
      <p class="lmsg" id="lmsg" role="status" hidden></p>
      <dl class="qa">
        <dt>为什么没有注册这一步?</dt>
        <dd>因为你输入邮箱的那一刻它就完成了。第一次输入,账号就用这个邮箱建好;之后输入同一个邮箱,就是登录。没有密码 —— 也就没有密码可以泄露。</dd>
        <dt>用哪个邮箱有讲究吗?有。</dt>
        <dd><b>时长记在你登录用的邮箱名下,不记在付款的那张卡上。</b>所以用公司卡、家人的卡付款都没问题 —— 顺序是:先用你自己的邮箱登录,再去结账。</dd>
      </dl>
    </div>
  </section>

  <section class="band hon">
    <p class="eb">该说的话</p>
    <p>Cloudflare Tunnel 本身免费。如果你有自己的 CF 账号和一个域名,完全可以自己搭出一条一样的通道 —— 我们的开源文档里就写了怎么做。</p>
    <p>这里卖的是省事:不用买域名(约 ¥70/年)、不用配 DNS、不用维护证书轮换,以及一个稳定运营、不跑路的承诺。<b>能自己搞定的人,建议自己搞。</b></p>
    <p>剩下的人 —— 不想再多养一个要操心的东西的人 —— 这 ¥45 一季买的就是「这件事从此不用你想」。</p>
    <p class="sign">Mediary Scout 与 Connect 由我一个人开发维护,Connect 的收入用来养 Scout 的持续开发。代码在 <a href="https://github.com/fancydirty/mediary-scout">GitHub</a> 上,你可以自己看它是不是真的只把数据留在本地。</p>
  </section>

  </main>

  <footer class="ft">
    Mediary Connect · 自托管 <a href="https://mediaryscout.app">Mediary Scout</a> 的远程访问服务<br>
    <a href="/pricing">定价</a> · <a href="/terms">服务条款</a> · <a href="/privacy">隐私政策</a> · <a href="/refund">退款政策</a> · <a href="/contact">联系我们</a> · <a href="https://github.com/fancydirty/mediary-scout">GitHub</a><br>
    运营主体 DF Digital · 付款由 Paddle 作为记录商户(Merchant of Record)处理
  </footer>

</div>
<script>
(function(){
  // 闸门:三选一,点谁展开谁。用 button + aria-expanded/hidden 而非纯 CSS ——
  // 屏幕阅读器要能知道哪块是展开的。
  var btns = Array.prototype.slice.call(document.querySelectorAll(".gc"));
  btns.forEach(function(b){
    b.addEventListener("click", function(){
      btns.forEach(function(o){
        var open = o === b;
        o.setAttribute("aria-expanded", open ? "true" : "false");
        var panel = document.getElementById(o.getAttribute("aria-controls"));
        if (panel) panel.hidden = !open;
      });
    });
  });

  // 登录:POST /api/auth/magic。固定 202 契约(不泄露邮箱是否已注册),
  // 所以成功文案不能说「已注册/未注册」,只说「已发送」。
  var form = document.getElementById("magic");
  var msg = document.getElementById("lmsg");
  if (!form || !msg) return;
  function say(t){ msg.textContent = t; msg.hidden = false; }
  form.addEventListener("submit", function(e){
    e.preventDefault();
    var input = form.querySelector("input[name=email]");
    var btn = form.querySelector("button");
    var email = (input.value || "").trim();
    // 只做最粗的形状检查:真正的校验在服务端(EMAIL_RE)。
    // 这里拦一下纯粹是省一次往返,不是安全边界。
    if (email.indexOf("@") < 1 || email.length > 254) { say("请输入一个有效的邮箱地址。"); return; }
    input.disabled = true; btn.disabled = true;
    say("正在发送…");
    // Turnstile 门禁目前在生产是关的(challenges.cloudflare.com 在中国大陆
    // 不可靠),但代码保留、随时可开。**必须带上 token** —— 与 /login 页同款
    // 写法:门一开,不带 token 的请求会稳定 400 "turnstile required"。
    // 页面上没有 widget 时 querySelector 返回 null,payload 就只有 email。
    var payload = { email: email };
    var tsEl = document.querySelector("[name=cf-turnstile-response]");
    if (tsEl && tsEl.value) payload.turnstile_token = tsEl.value;
    fetch("/api/auth/magic", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function(res){
      if (res.status === 202) {
        say("已发送到 " + email + "。点邮件里的链接就登录了,链接只能用一次。没收到?检查垃圾邮件,或改一下邮箱重发。");
        // **不 return**:成功后也要把表单交还给用户。
        // /api/auth/magic 为了不泄露注册状态**恒返回 202**,所以「成功」不代表
        // 邮箱写对了 —— 拼错的地址同样是 202。永久 disabled 会让用户必须
        // 刷新页面才能更正,而他此刻正等着收信,不会想到去刷新。
        input.disabled = false; btn.disabled = false;
        return;
      }
      // 429 是限流(发信入口的替代防线),要给可操作的话而不是「稍后重试」。
      if (res.status === 429) { say("请求太频繁了,过几分钟再试。"); }
      // 服务端 400 有多种成因(邮箱形状不对、缺 turnstile token…),
      // 不能一律说「邮箱不对」—— 那会把用户的排查方向带偏。
      else if (res.status === 400) { say("这个请求没被接受。检查邮箱地址,或刷新页面重试。"); }
      else { say("发送失败了,请稍后再试。"); }
      input.disabled = false; btn.disabled = false;
    }).catch(function(){
      say("网络不通,检查一下连接再试。");
      input.disabled = false; btn.disabled = false;
    });
  });
})();
</script>
</body>
</html>`;
}
