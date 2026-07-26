import { describe, it, expect } from "vitest";
import { betaPage } from "./beta-page.js";

const page = betaPage();

describe("betaPage", () => {
  it("is a self-contained zh HTML document with the beta title", () => {
    expect(page.startsWith("<!doctype html>")).toBe(true);
    expect(page).toContain('<html lang="zh">');
    expect(page).toContain('<meta charset="utf-8">');
    expect(page).toContain("<title>Scout Connect 远程访问 · 内测 · Mediary Scout Connect</title>");
  });

  it("renders the honest marketing copy (what it is, pricing, 100 seats)", () => {
    expect(page).toContain("Scout Connect 远程访问 · 内测");
    expect(page).toContain("在外网也能打开家里实例的浏览器界面");
    expect(page).toContain("经 Cloudflare 加密隧道，不开端口、不要公网 IP、不需要域名");
    expect(page).toContain("内容与凭据始终只在你自己的机器上");
    expect(page).toContain("内测期免费");
    expect(page).toContain("创始批 100 席");
    expect(page).toContain("¥19/月 或 ¥199/年");
    expect(page).toContain("创始价 ¥149/年");
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
    for (const v of ["9", "19", "29", "year149", "unsure"]) {
      expect(page).toContain(`name="price_point" value="${v}"`);
    }
    for (const label of ["¥9/月", "¥29/月", "年付 ¥149", "说不好"]) {
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
