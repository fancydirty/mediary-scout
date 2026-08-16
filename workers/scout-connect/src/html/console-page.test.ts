import { describe, expect, it } from "vitest";
import type { AccountRow, EndpointRow, EntitlementRow } from "../db.js";
import { consolePage } from "./console-page.js";

const NOW = "2026-07-28T00:00:00.000Z";
const BASE = "https://mediaryconnect.app";

const account: AccountRow = {
  id: "act_1",
  email: "buyer@example.com",
  paddle_customer_id: null,
  created_at: NOW,
  last_login_at: NOW,
};

function ent(expires_at: string): EntitlementRow {
  return {
    id: "ent_1",
    account_id: "act_1",
    expires_at,
    source: "manual",
    paddle_transaction_id: null,
    payment_provider: null,
    payment_transaction_id: null,
    refunded_at: null,
    months: 3,
    created_at: NOW,
  };
}

const endpoint: EndpointRow = {
  id: "ep_1",
  invite_id: "inv_1",
  slug: "dirtyfancy",
  hostname: "dirtyfancy.mediaryconnect.app",
  cf_tunnel_id: "tid",
  cf_access_app_id: null,
  cf_access_policy_id: null,
  cf_dns_record_id: "dns_1",
  status: "active",
  token_sha256: "x",
  token_ciphertext: null,
  token_shown_at: null,
  last_seen_at: null,
  created_at: NOW,
  revoked_at: null,
  account_id: "act_1", grace_until: null, suspended_at: null, purge_after: null,
};

function base(over: Partial<Parameters<typeof consolePage>[0]>) {
  return consolePage({
    account,
    entitlements: [],
    endpoint: null,
    baseUrl: BASE,
    rootDomain: "mediaryconnect.app",
    now: NOW,
    ...over,
  });
}

describe("console page — shared dark theme", () => {
  it("is a full dark-themed document with brand bar, favicon, and the account email", () => {
    const html = base({});
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("--accent:#1ed760");
    expect(html).toContain("color-scheme:dark");
    expect(html).toContain("CONNECT");
    expect(html).toContain('rel="icon"');
    expect(html).toContain("buyer@example.com");
  });
});

describe("console page — not entitled", () => {
  it("shows a 尚未开通 badge and an 开通 CTA, no access area", () => {
    const html = base({ entitlements: [] });
    expect(html).toContain("尚未开通");
    expect(html).toContain('href="/pricing"');
    expect(html).not.toContain("获取接入命令");
  });
});

describe("console page — 到期三态(不再把已付费过期误报成尚未开通)", () => {
  it("宽限期中显示「宽限期中 · 剩 N 天」,不显示尚未开通", () => {
    // 到期 7-29,now 7-31 → 宽限中,剩约 5 天
    const html = base({
      entitlements: [ent("2026-07-29T00:00:00.000Z")],
      endpoint: null,
      now: "2026-07-31T00:00:00.000Z",
    });
    expect(html).toContain("宽限期中");
    expect(html).toContain("剩 ");
    expect(html).not.toContain("尚未开通");
  });

  // Copilot round-1 指出:daysLeftInGrace 在截止瞬间返回 0,用 `>0` 会把仍在
  // 宽限的用户误报成已过期。必须与 cron 的 <= 语义一致。
  it("宽限截止的精确瞬间仍显示「宽限期中」(与 cron 边界语义一致)", () => {
    // 到期 7-23 → 宽限到 7-30 00:00:00;now 就是那个精确瞬间
    const html = base({
      entitlements: [ent("2026-07-23T00:00:00.000Z")],
      endpoint: null,
      now: "2026-07-30T00:00:00.000Z",
    });
    expect(html, "截止瞬间仍属宽限期,不该误报成已过期").toContain("宽限期中");
    expect(html).not.toContain("已过期");
  });

  it("宽限期已过显示「已过期 · 续期即恢复」,不误报成尚未开通", () => {
    // 到期 7-01,now 7-31 → 宽限早过
    const html = base({
      entitlements: [ent("2026-07-01T00:00:00.000Z")],
      endpoint: null,
      now: "2026-07-31T00:00:00.000Z",
    });
    expect(html).toContain("已过期");
    expect(html).toContain("续期即恢复");
    expect(html).not.toContain("尚未开通");
  });

  it("从未付费才是「尚未开通」", () => {
    const html = base({ entitlements: [] });
    expect(html).toContain("尚未开通");
    expect(html).not.toContain("宽限期中");
    expect(html).not.toContain("已过期");
  });
});

describe("console page — entitled but no endpoint yet", () => {
  it("renders the inline slug form wired to /api/slug/check + /api/provision (no dead link)", () => {
    const html = base({
      entitlements: [ent("2027-07-28T00:00:00.000Z")],
      endpoint: null,
    });
    expect(html).toContain("有效");
    expect(html).toContain("选择专属地址");
    expect(html).toContain('id="slug"');
    expect(html).toContain(".mediaryconnect.app");
    expect(html).toContain('"/api/slug/check?s="');
    expect(html).toContain('"/api/provision"');
    // 旧死链占位必须消失
    expect(html).not.toContain("/pricing#slug");
    // 未开出 endpoint,不该出现接入区
    expect(html).not.toContain("获取接入命令");
  });
});

describe("console page — entitled with active endpoint (v2 prompt-primary)", () => {
  const html = base({
    entitlements: [ent("2027-07-28T00:00:00.000Z")],
    endpoint,
  });

  it("makes the AI prompt the primary action (big box + copy button)", () => {
    expect(html).toContain("把下面这段交给你的 AI 助手");
    expect(html).toContain("获取接入命令");
    expect(html).toContain("复制提示词");
    expect(html).toContain("dirtyfancy.mediaryconnect.app");
  });

  it("demotes the raw curl command into a 或手动 <details> fold", () => {
    expect(html).toContain("<details>");
    expect(html).toContain("或者：我能直接操作那台机器");
    // 折叠区里放裸命令占位（真码由客户端注入）
    expect(html).toContain("connect.sh");
  });

  it("NEVER embeds a tunnel token; only the client-fetched claim code fills the placeholder", () => {
    expect(html).not.toMatch(/TUNNEL_TOKEN=/);
    expect(html).not.toContain(endpoint.token_sha256 === "x" ? "TUNNEL_TOKEN" : "");
    // 服务端渲染时提示词里是占位符，不是真码
    expect(html).toContain("__MEDIARY_CLAIM_CODE__");
    expect(html).toContain('"/api/claim-code"');
    expect(html).toContain("15 分钟");
  });

  it("ships the copy + generate client script only in this state", () => {
    expect(html).toContain("navigator.clipboard");
    // 未开通态不应带脚本
    const inactive = base({ entitlements: [], endpoint });
    expect(inactive).not.toContain("navigator.clipboard");
  });
});

describe("consolePage 报到时间", () => {
  // 用现成的 base() + 注入的 NOW —— 不猜入参形状,也不依赖真实时钟。
  const render = (last_seen_at: string | null, now: string = NOW) =>
    base({ endpoint: { ...endpoint, last_seen_at }, entitlements: [ent("2027-01-01T00:00:00.000Z")], now });
  const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();

  it("有报到记录 → 显示相对时间", () => {
    const html = render(ago(5 * 60_000));
    expect(html).toContain("你的实例上次向这里报到");
    expect(html).toContain("5 分钟前");
  });

  it("从未报到（null）→ 整行不渲染", () => {
    // 刚开通还没接入的用户看到「从未报到」会以为出错了,而那正是此刻的正常状态。
    expect(render(null)).not.toContain("上次向这里报到");
  });

  it("措辞不暗示入站可达 —— 这是这一行存在的全部意义", () => {
    // last_seen_at 只证明「实例 → 控制面」(出站)。cloudflared 挂了但容器活着时,
    // 它照样显示「刚刚」。写成「隧道正常」就是拿恒真指标冒充健康检查。
    const html = render(ago(60_000));
    for (const lie of ["隧道正常", "隧道已连接", "远程访问正常", "连接正常"]) {
      expect(html).not.toContain(lie);
    }
  });

  it("时钟不同步（未来时间）显示「刚刚」而非负数", () => {
    const html = render(new Date(Date.parse(NOW) + 5 * 60_000).toISOString());
    expect(html).toContain("刚刚");
    expect(html).not.toContain("-5 分钟");
  });

  it("向下取整：119 秒是「1 分钟前」", () => {
    expect(render(ago(119_000))).toContain("1 分钟前");
  });
});

describe("无时长态 = 购买入口(不是死链)", () => {
  // 这一整块是补债:线上曾经是 `<a href="/pricing">开通</a>`,而 /pricing 是纯
  // 说明页、零结账入口 —— 整条付款路径断了,后端 /api/checkout 从来没有调用方。
  // 用户截图才发现。所有自动化测试当时都是绿的,因为没人测这一态。
  const TIERS = [
    { priceId: "pri_q", months: 3, label: "季度", price: "¥45", featured: false, note: "3 个月" },
    { priceId: "pri_y", months: 12, label: "年度", price: "¥108", featured: true, note: "12 个月 · 折月付 ¥9" },
    { priceId: "pri_2y", months: 24, label: "两年", price: "¥188", featured: false, note: "24 个月" },
  ];
  const noTime = (tiers = TIERS) => base({ entitlements: [], endpoint: null, tiers });

  it("三档都渲染成带 price_id 的按钮", () => {
    const html = noTime();
    for (const t of TIERS) {
      expect(html).toContain(`data-price="${t.priceId}"`);
      expect(html).toContain(t.price);
    }
  });

  it("绝不再出现「跳 /pricing 就算完事」的死链按钮", () => {
    // 这是本次 bug 的精确复现条件:一个 class="btn" 的链接指向 /pricing。
    // 页脚那个「定价」文字链是正常的,所以只禁按钮形态。
    const html = noTime();
    expect(html).not.toMatch(/class="btn"[^>]*href="\/pricing"/);
    expect(html).not.toMatch(/href="\/pricing"[^>]*class="btn"/);
  });

  it("有下单脚本,且真的打 /api/checkout", () => {
    const html = noTime();
    expect(html).toContain("/api/checkout");
    expect(html).toContain("price_id");
    // 拿到 checkout_url 后必须真跳过去,否则等于建了交易却不结账。
    expect(html).toContain("checkout_url");
    expect(html).toContain("window.location.href");
  });

  it("年度是主推档(用户拍板),且只有一个主推", () => {
    const html = noTime();
    // 只数**按钮上**的,不数 CSS 规则里的 —— 样式表里也有 .tier-featured,
    // 直接数字符串会把它算进去(第一版就踩了)。
    expect(html).toContain("tier-featured");
    expect(html.match(/class="tier tier-featured"/g)?.length).toBe(1);
    // 主推标记必须落在年度那颗按钮上,不能飘到别档。
    const yearBtn = html.slice(html.indexOf('data-price="pri_y"'));
    expect(yearBtn.slice(0, 400)).toContain("¥108");
  });

  it("白名单为空 → 不给假按钮,老实说不可用", () => {
    // 假按钮点下去必然吃 /api/checkout 的 503。让用户点一下才发现,是最差体验。
    const html = base({ entitlements: [], endpoint: null, tiers: [] });
    expect(html).not.toContain("data-price");
    expect(html).toContain("购买通道暂时不可用");
    // 也不该注入脚本 —— 那会对不存在的 .tier 做 querySelectorAll(空数组,不崩,
    // 但白挂一段死代码)。
    expect(html).not.toContain("/api/checkout");
  });

  it("三种失败各有不同的下一步动作", () => {
    const html = noTime();
    // 「请重试」对 session 过期毫无用处 —— 必须让他重新登录。
    expect(html).toContain("401");
    expect(html).toContain("重新登录");
    expect(html).toContain("503");
  });

  it("防连点:点击后禁用所有按钮", () => {
    // 不禁的话用户连点三下就在 Paddle 建三笔 draft 交易。
    expect(noTime()).toContain("disabled=true");
  });

  it("已有有效时长时不显示购买按钮", () => {
    const html = base({
      entitlements: [ent("2027-01-01T00:00:00.000Z")],
      endpoint: null,
      tiers: TIERS,
    });
    expect(html).not.toContain("data-price");
  });

  it("标明预付/不自动续费与退款政策", () => {
    // 合规与预期管理:这是一次性付款,不是订阅。必须在下单按钮旁边就说清。
    const html = noTime();
    expect(html).toContain("不自动续费");
    expect(html).toContain("/refund");
  });
});

describe("已付款但未入账 = 必须说钱没丢(事故防线)", () => {
  // 事故复盘:用户微信付了 ¥45,webhook 因签名密钥配错而全部 401,他回到控制台
  // 看到「尚未开通」。付了钱,界面像没付过。真实用户会直接开退款争议。
  const TIERS = [
    { priceId: "pri_y", months: 12, label: "年度", price: "¥108", featured: true, note: "12 个月" },
  ];
  const pending = (n: number) =>
    base({ entitlements: [], endpoint: null, tiers: TIERS, pendingPaidCount: n });
  const justPaid = () =>
    base({ entitlements: [], endpoint: null, tiers: TIERS, justPaid: true });

  it("Paddle 确认已付款 → 绝不显示「尚未开通」", () => {
    // 这是整条防线最核心的一条断言:那句话是事故里最伤人的一幕。
    const html = pending(1);
    expect(html).not.toContain("尚未开通");
    expect(html).toContain("已付款");
  });

  it("明确告诉用户钱不会丢", () => {
    const html = pending(1);
    expect(html).toContain("付款不会丢失");
  });

  it("不提支付宝 —— Paddle 不支持它,写了就是说谎", () => {
    // 第一版文案写了「微信支付与支付宝」。Paddle 在中国只支持 WeChat Pay,
    // 没有 Alipay(PR #209 已为此清过一轮合规页,我又在新文案里犯了同一个错)。
    for (const h of [pending(1), justPaid()]) {
      expect(h).not.toContain("支付宝");
      expect(h).not.toContain("Alipay");
    }
  });

  it("购买区不吹不存在的支付方式", () => {
    // Paddle 后台勾了全部方式,但结账页按地区显示 —— 对中国用户实际就是微信。
    // 所以主推微信 + 信用卡,并说明「按地区显示」,不逐个列 Apple/Google Pay。
    const html = pending(0);
    expect(html).toContain("微信支付");
    expect(html).not.toContain("支付宝");
  });

  it("解释延迟到账,并给出具体时间上限", () => {
    // 不给上限的「请稍候」等于没说 —— 用户不知道该等 10 秒还是一小时。
    const html = pending(1);
    expect(html).toContain("延迟到账");
    expect(html).toContain("10 分钟");
  });

  it("给出超时后的求助路径,并承认这是我们的问题", () => {
    const html = pending(1);
    expect(html).toContain("15 分钟");
    expect(html).toContain("/contact");
    expect(html).toContain("我们这边的问题");
    // 退款兜底也要在场:用户此刻最坏的预期就是钱白花了。
    expect(html).toContain("/refund");
  });

  it("待入账时不显示购买按钮(防重复付款)", () => {
    // 这条最要紧:显示购买按钮会让一个已经付过款的人再付一次。
    const html = pending(1);
    expect(html).not.toContain("data-price");
  });

  it("刚付款(?paid=1)但 Paddle 还没确认 → 也要安抚", () => {
    // 微信是延迟捕获,跳回来那一刻 Paddle 往往还没标 paid。
    // 这个空窗不安抚,用户看到的就是「尚未开通」。
    const html = justPaid();
    expect(html).not.toContain("尚未开通");
    expect(html).toContain("正在确认");
    expect(html).not.toContain("data-price");
  });

  it("有刷新按钮,且刷新时去掉 ?paid=1", () => {
    // 不去掉的话「刚付款」这个软状态会永远粘着,即使付款其实失败了,
    // 用户也一直看到「正在确认」—— 那是另一种形式的说谎。
    const html = justPaid();
    expect(html).toContain('id="recheck"');
    expect(html).toContain('"/console"');
    expect(html).not.toContain("/console?paid=1");
  });

  it("不做持续轮询(每次都要打 Paddle API)", () => {
    const html = pending(1);
    expect(html).not.toContain("setInterval");
    expect(html).toContain("setTimeout");
  });

  it("pendingPaidCount=0 且非 justPaid → 正常显示购买按钮", () => {
    const html = pending(0);
    expect(html).toContain("data-price");
    expect(html).toContain("尚未开通");
  });

  it("已有有效时长时,pendingPaidCount 不干扰正常显示", () => {
    // 续费场景:老用户还有时长,同时买了新的。不能把他打回待入账态。
    const html = base({
      entitlements: [ent("2027-01-01T00:00:00.000Z")],
      endpoint: null,
      tiers: TIERS,
      pendingPaidCount: 1,
    });
    expect(html).toContain("有效");
    expect(html).not.toContain("付款不会丢失");
  });
});
