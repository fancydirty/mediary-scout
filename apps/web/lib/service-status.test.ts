// apps/web/lib/service-status.test.ts
import { describe, expect, it } from "vitest";
import {
  assrtPills,
  jevPills,
  llmPills,
  pansouPills,
  prowlarrPills,
  tmdbPills,
} from "./service-status";

describe("llmPills", () => {
  it("baseURL + modelId → 已配置 · <modelId> (on)", () => {
    expect(llmPills({ baseURL: "https://x/v1", modelId: "mimo-v2.5-pro" })).toEqual([
      { label: "已配置 · mimo-v2.5-pro", tone: "on" },
    ]);
  });
  it("只填其一 → 配置不全 (warn)", () => {
    expect(llmPills({ baseURL: "https://x/v1", modelId: "" })).toEqual([{ label: "配置不全", tone: "warn" }]);
    expect(llmPills({ baseURL: "", modelId: "m" })).toEqual([{ label: "配置不全", tone: "warn" }]);
  });
  it("都空 → 未配置 (off)", () => {
    expect(llmPills({ baseURL: "", modelId: "  " })).toEqual([{ label: "未配置", tone: "off" }]);
  });
});

describe("jevPills", () => {
  const base = { apiKeySet: true, healthy: true, active: true, model: "jev-1.13.0" };
  it("生效中 + 模型名", () => {
    expect(jevPills(base)).toEqual([
      { label: "生效中", tone: "on" },
      { label: "jev-1.13.0", tone: "neutral" },
    ]);
  });
  it("有 key、探活过、未启用 → 已关闭 (off)", () => {
    expect(jevPills({ ...base, active: false })).toEqual([
      { label: "已关闭", tone: "off" },
      { label: "jev-1.13.0", tone: "neutral" },
    ]);
  });
  it("有 key 但没探活过 → 待测试 (warn)，不显示模型", () => {
    expect(jevPills({ apiKeySet: true, healthy: false, active: false, model: null })).toEqual([
      { label: "待测试", tone: "warn" },
    ]);
  });
  it("无 key → 未配置 (off)，即使残留 model 也不显示", () => {
    expect(jevPills({ apiKeySet: false, healthy: false, active: false, model: "stale" })).toEqual([
      { label: "未配置", tone: "off" },
    ]);
  });
  it("model 为空串/null 不追加胶囊", () => {
    expect(jevPills({ ...base, model: "" })).toEqual([{ label: "生效中", tone: "on" }]);
    expect(jevPills({ ...base, model: null })).toEqual([{ label: "生效中", tone: "on" }]);
  });
});

describe("tmdbPills", () => {
  it("有 key → 直连 (on)；无 key → 代理兜底 (neutral)", () => {
    expect(tmdbPills({ apiKeySet: true })).toEqual([{ label: "直连 · 自己的 Key", tone: "on" }]);
    expect(tmdbPills({ apiKeySet: false })).toEqual([{ label: "代理兜底", tone: "neutral" }]);
  });
});

describe("pansouPills", () => {
  it("填了地址 → 自定义实例 (on)", () => {
    expect(pansouPills({ baseURL: "http://192.168.1.1:8888", isDesktop: false, health: null })).toEqual([
      { label: "自定义实例", tone: "on" },
    ]);
  });
  it("留空：桌面端 → 公共默认实例；服务器 → 内置实例（都是 neutral）", () => {
    expect(pansouPills({ baseURL: "", isDesktop: true, health: "" })).toEqual([{ label: "公共默认实例", tone: "neutral" }]);
    expect(pansouPills({ baseURL: "", isDesktop: false, health: "ok" })).toEqual([{ label: "内置实例", tone: "neutral" }]);
  });
  it("最近探活 unhealthy → 追加 连不上 (warn)；ok/空 不追加", () => {
    expect(pansouPills({ baseURL: "http://x", isDesktop: false, health: "unhealthy" })).toEqual([
      { label: "自定义实例", tone: "on" },
      { label: "连不上", tone: "warn" },
    ]);
    expect(pansouPills({ baseURL: "http://x", isDesktop: false, health: "ok" })).toHaveLength(1);
  });
});

describe("prowlarrPills", () => {
  it("URL + key → 已接入 (on) + 仅磁力盘 (neutral)", () => {
    expect(prowlarrPills({ baseURL: "http://x:9696", apiKeySet: true })).toEqual([
      { label: "已接入", tone: "on" },
      { label: "仅磁力盘", tone: "neutral" },
    ]);
  });
  it("只有其一 → 配置不全 (warn)", () => {
    expect(prowlarrPills({ baseURL: "http://x:9696", apiKeySet: false })[0]).toEqual({ label: "配置不全", tone: "warn" });
    expect(prowlarrPills({ baseURL: "", apiKeySet: true })[0]).toEqual({ label: "配置不全", tone: "warn" });
  });
  it("都无 → 未接入 (off)，仍带 仅磁力盘", () => {
    expect(prowlarrPills({ baseURL: "", apiKeySet: false })).toEqual([
      { label: "未接入", tone: "off" },
      { label: "仅磁力盘", tone: "neutral" },
    ]);
  });
});

describe("assrtPills", () => {
  it("有 token → 已配置 (on)；无 → 未配置 (off)", () => {
    expect(assrtPills({ tokenSet: true })).toEqual([{ label: "已配置", tone: "on" }]);
    expect(assrtPills({ tokenSet: false })).toEqual([{ label: "未配置", tone: "off" }]);
  });
});
