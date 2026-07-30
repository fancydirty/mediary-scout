import { describe, expect, it } from "vitest";
import { slugFormHtml } from "./slug-form.js";
import { slugFormScript } from "./slug-form-script.js";

const INPUT = { rootDomain: "mediaryconnect.app" };

describe("slugFormHtml —— 方向 B 的静态骨架", () => {
  const html = slugFormHtml(INPUT);

  it("活体域名预览为主角(预览在输入框之前,垂直布局,域名后缀服务端渲染)", () => {
    expect(html).toContain('id="slug-preview"');
    // 垂直布局:预览名为主体,完整地址在 preview-tail 里
    expect(html).toContain('id="preview-name"');
    expect(html).toContain('id="preview-tail-name"');
    expect(html).toContain('.mediaryconnect.app');
    // 预览必须先于输入框出现(视觉主体)
    expect(html.indexOf("slug-preview")).toBeLessThan(html.indexOf('id="slug"'));
  });

  it("是真 <form> 而非裸 input+button(回车可提交)", () => {
    expect(html).toContain('<form id="slug-form"');
    expect(html).toContain('type="submit"');
    expect(html).not.toContain('type="button" id="provision"');
  });

  it("输入框带 iOS 防大写与小写净化所需属性", () => {
    expect(html).toContain('autocapitalize="off"');
    expect(html).toContain('inputmode="latin"');
    expect(html).toContain('autocomplete="off"');
  });

  it("内联状态图标占位在输入框内", () => {
    expect(html).toContain('id="slug-state"');
  });

  it("逐条打勾的规则清单(4 条)", () => {
    expect(html).toContain('data-rule="chars"');
    expect(html).toContain('data-rule="edge"');
    expect(html).toContain('data-rule="len"');
    expect(html).toContain('data-rule="free"');
    expect((html.match(/data-rule="/g) ?? []).length).toBe(4);
  });

  it("无障碍:label 关联、aria-describedby、aria-invalid、role=status", () => {
    expect(html).toContain('aria-describedby="slug-msg"');
    expect(html).toContain('aria-invalid="false"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="专属地址前缀"');
  });

  it("候选 chip 容器存在(客户端填),不带 innerHTML 注入面", () => {
    expect(html).toContain('id="slug-suggest"');
    // 服务端骨架里不能有候选名(那些由客户端用 textContent 填)
  });

  it("按钮初始禁用,文案是占位(客户端在可用时复述完整域名)", () => {
    expect(html).toContain(">开通</button>");
    expect(html).toContain("disabled");
  });
});

describe("slugFormScript —— 客户端交互", () => {
  const script = slugFormScript("mediaryconnect.app");

  it("输入即净化:回写 sanitizeSlug 后的值(消灭显示与结果的漂移)", () => {
    expect(script).toContain("sanitizeSlug");
    expect(script).toContain("input.value=clean");
    expect(script).toContain("if(clean!==raw)");
  });

  it("域名注入做了 JSON 转义(防引号截断)", () => {
    expect(script).toContain('const DOMAIN="mediaryconnect.app"');
  });

  it("可用时按钮复述完整域名", () => {
    expect(script).toContain('btn.textContent="开通 "+slug+"."+DOMAIN');
  });

  it("开通中显示加载态", () => {
    expect(script).toContain('btn.textContent="正在开通…"');
  });

  it("校验错误说清差在哪,不说「稍后重试」", () => {
    expect(script).toContain("这个名字不符合规则，请检查后再试");
    expect(script).toContain("这个名字被保留了");
    expect(script).toContain("已被占用");
  });

  it("429(限流)有专门提示", () => {
    expect(script).toContain("rateLimited");
    expect(script).toContain("操作太频繁");
  });

  it("售罄(at capacity)有专门提示", () => {
    expect(script).toContain('e==="at capacity"');
    expect(script).toContain("暂时售罄");
  });

  it("回车走原生 form 提交(不需要手写回车监听)", () => {
    expect(script).toContain('form.addEventListener("submit"');
    expect(script).toContain("ev.preventDefault()");
  });

  it("查重期间显示 spinner,过期响应丢弃", () => {
    expect(script).toContain('setState("spin"');
    expect(script).toContain("mySeq!==seq");
  });

  it("候选 chip 可点且用 textContent(无 XSS)", () => {
    expect(script).toContain("b.textContent=name");
    expect(script).not.toContain("suggest.innerHTML");
  });
});
