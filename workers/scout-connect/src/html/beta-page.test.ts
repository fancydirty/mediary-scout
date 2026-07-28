import { describe, it, expect } from "vitest";
import { betaPage } from "./beta-page.js";

const page = betaPage();

describe("betaPage", () => {
  it("is a self-contained zh HTML document with the beta title", () => {
    expect(page.startsWith("<!doctype html>")).toBe(true);
    expect(page).toContain('<html lang="zh">');
    expect(page).toContain('<meta charset="utf-8">');
    expect(page).toContain("<title>Mediary Connect 远程访问 · 内测</title>");
  });

  it("footer links to all five compliance pages", () => {
    for (const path of ["/terms", "/privacy", "/refund", "/pricing", "/contact"]) {
      expect(page).toContain(`href="${path}"`);
    }
  });

  it("renders the honest marketing copy (what it is, pricing, 100 seats)", () => {
    expect(page).toContain("Mediary Connect 远程访问 · 内测");
    // eyebrow 是大写形态，单独钉住——round 1 评审抓到它漏改。
    expect(page).toContain("MEDIARY CONNECT · BETA");
    expect(page).not.toMatch(/SCOUT CONNECT/);
    expect(page).toContain("在外网也能打开家里实例的浏览器界面");
    expect(page).toContain("经 Cloudflare 加密隧道，不开端口、不要公网 IP、不需要域名");
    expect(page).toContain("内容与凭据始终只在你自己的机器上");
    expect(page).toContain("内测期免费");
    expect(page).toContain("创始批 100 席");
    // 定价与母 spec 决策 #3/#4 对齐(季 ¥45 / 年 ¥108 / 创始 ¥88,无月付)。
    expect(page).toContain("季 ¥45 / 年 ¥108");
    expect(page).toContain("创始价 ¥88/年");
    expect(page).not.toContain("¥19/月");
    expect(page).not.toContain("¥199");
    expect(page).not.toContain("¥149");
    expect(page).toContain("先填邮箱，开通时邮件通知");
    // Honesty guardrail: 转存到用户自己的网盘, never "download to our server"
    // or streaming/viewing claims.
    expect(page).not.toMatch(/在线看|在线播放| streaming|下载到服务器/);
  });

  it("step 1: email form posts same-origin to /waitlist with the a11y contract", () => {
    expect(page).toContain('<form id="signup"');
    expect(page).toContain('<label for="email">');
    expect(page).toContain('type="email"');
    expect(page).toContain("required");
    expect(page).toContain('autocomplete="email"');
    // The button keeps an accessible name while pending (aria-label + aria-busy,
    // mirroring apps/web's remote-access-waitlist.tsx pattern).
    expect(page).toMatch(/<button[^>]*id="join"[^>]*aria-label="申请内测席位"[^>]*aria-busy="false"/);
    expect(page).toContain("申请内测席位");
    // Error line is announced assertively.
    expect(page).toMatch(/<p[^>]*id="err"[^>]*role="alert"/);
    // Same-origin relative fetch — no CORS, no absolute URL.
    expect(page).toContain('fetch("/waitlist",');
    expect(page).not.toMatch(/fetch\("https?:/);
  });

  it("step 2: survey section is hidden until signup succeeds; position slot exists", () => {
    expect(page).toMatch(/<section[^>]*id="step-survey"[^>]*hidden/);
    expect(page).not.toMatch(/<section[^>]*id="step-signup"[^>]*hidden/);
    // 你是第 N 位 — N is filled client-side via textContent into #pos.
    expect(page).toContain("你是第 ");
    expect(page).toContain('id="pos"');
    expect(page).toContain("顺便帮个忙（可跳过）");
  });

  it("survey fields: all optional, every input labelled, feedback capped at 500", () => {
    // 愿意付费吗 — radios
    expect(page).toContain("愿意付费吗");
    for (const v of ["willing", "free", "depends"]) {
      expect(page).toContain(`name="willing_to_pay" value="${v}"`);
    }
    expect(page).toContain("愿意");
    expect(page).toContain("只想免费");
    expect(page).toContain("看情况");
    // 心理价位 — radios
    expect(page).toContain("心理价位");
    for (const v of ["q45", "year88", "year108", "cheaper", "unsure"]) {
      expect(page).toContain(`name="price_point" value="${v}"`);
    }
    for (const label of ["季付 ¥45", "创始年付 ¥88", "年付 ¥108", "还是觉得贵", "说不好"]) {
      expect(page).toContain(label);
    }
    // 场景 — checkboxes
    expect(page).toContain("你会在哪些场景用它");
    for (const v of ["progress", "newtask", "config", "all"]) {
      expect(page).toContain(`name="use_cases" value="${v}"`);
    }
    for (const label of ["查进度", "下新任务", "改配置", "都有"]) {
      expect(page).toContain(label);
    }
    // 打赏 + 其他想说的
    expect(page).toContain('name="donate"');
    expect(page).toContain("如果喜欢这个项目，我愿意打赏作者");
    expect(page).toContain('<label for="feedback">');
    expect(page).toMatch(/<textarea[^>]*maxlength="500"/);
    // Buttons
    expect(page).toContain("提交（可选）");
    expect(page).toContain("跳过");
    // Group labels exist (fieldset legends) — every input is labelled.
    expect((page.match(/<fieldset><legend>/g) ?? []).length).toBe(3);
  });

  it("submits the survey same-origin to /waitlist/survey and shows thanks", () => {
    expect(page).toContain('fetch("/waitlist/survey",');
    expect(page).toContain("感谢，开通时邮件通知你。");
    // Survey error line also announced.
    expect(page).toMatch(/<p[^>]*id="survey-err"[^>]*role="alert"/);
  });

  it("has no server-side template holes and injects dynamic text via textContent only", () => {
    // The page is fully static server-side — any "${" would be an unevaluated
    // template hole, any rendered "undefined" a leaked missing value.
    expect(page).not.toContain("${");
    expect(page).not.toContain(">undefined<");
    // Client-side, dynamic values (position, error text) must go through
    // textContent — innerHTML with response data would be an XSS hole. The
    // page therefore does not use innerHTML at all.
    expect(page).not.toContain("innerHTML");
    expect(page).toContain('textContent=String(d.position)');
  });
});

describe("betaPage Turnstile (sitekey configured)", () => {
  // Sitekey 是公开值（随页面和 wrangler.jsonc vars 一起发布），但这里刻意
  // 用「形状合法的假 key」而不是生产实际值：测试断言的是插值行为，不该在
  // widget 轮换时被迫改测试。
  const SITEKEY = "0xAAAAAAAAfixture-key01";
  const withKey = betaPage(SITEKEY);

  it("loads the Turnstile api.js (deferred) and renders the widget inside the signup form", () => {
    expect(withKey).toContain(
      '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" defer></script>',
    );
    expect(withKey).toContain(
      `<div class="cf-turnstile" data-sitekey="${SITEKEY}" data-theme="dark"></div>`,
    );
    // The widget must sit INSIDE <form id="signup"> so the token hidden input
    // is scoped to the signup submit.
    const formStart = withKey.indexOf('<form id="signup"');
    const formEnd = withKey.indexOf("</form>", formStart);
    const widgetAt = withKey.indexOf('class="cf-turnstile"');
    expect(formStart).toBeGreaterThanOrEqual(0);
    expect(widgetAt).toBeGreaterThan(formStart);
    expect(widgetAt).toBeLessThan(formEnd);
  });

  it("submit JS reads the token and posts it as turnstile_token", () => {
    expect(withKey).toContain('document.querySelector("[name=cf-turnstile-response]")');
    expect(withKey).toContain("turnstile_token");
  });

  it("blocks the submit client-side with 人机验证未完成，请稍候 while the token is empty", () => {
    expect(withKey).toContain("人机验证未完成，请稍候");
  });

  it("still renders no template holes with the sitekey interpolated", () => {
    expect(withKey).not.toContain("${");
    expect(withKey).not.toContain(">undefined<");
    expect(withKey).not.toContain("innerHTML");
  });
});

describe("betaPage Turnstile (sitekey absent)", () => {
  it("renders NO turnstile markup at all without a sitekey", () => {
    for (const p of [betaPage(), betaPage(undefined)]) {
      expect(p).not.toContain("cf-turnstile");
      expect(p).not.toContain("challenges.cloudflare.com");
      expect(p).not.toContain("turnstile_token");
      expect(p).not.toContain("人机验证");
    }
  });

  it("empty/whitespace sitekey behaves as absent", () => {
    for (const p of [betaPage(""), betaPage("   ")]) {
      expect(p).not.toContain("cf-turnstile");
      expect(p).not.toContain("challenges.cloudflare.com");
    }
  });

  it("a sitekey outside the real charset is refused (no markup injection via env)", () => {
    // The sitekey is interpolated into an HTML attribute; a malformed env
    // value must degrade to "no widget", never break out of the attribute.
    const p = betaPage('x"><script>alert(1)</script>');
    expect(p).not.toContain("cf-turnstile");
    expect(p).not.toContain("alert(1)");
  });
});
