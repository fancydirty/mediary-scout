// apps/web/lib/service-status.test.ts
import { describe, expect, it } from "vitest";
import {
  assrtPills,
  isEnvBackedValue,
  jevPills,
  llmPills,
  pansouPills,
  prowlarrPills,
  tmdbPills,
  type ServicePill,
} from "./service-status";

/** 表驱动：每行一个输入 → 期望的完整胶囊列表（顺序即渲染顺序）。 */
type Case<F extends (...args: never[]) => ServicePill[]> = {
  name: string;
  input: Parameters<F>[0];
  want: ServicePill[];
};

/** 生效值里有一层来自环境变量（DB 留空、env 补位）时追加的中性胶囊。 */
const ENV: ServicePill = { label: "来自环境变量", tone: "neutral" };

describe("isEnvBackedValue", () => {
  it.each([
    { name: "blank DB + effective env value", db: "", effective: "env-value", want: true },
    { name: "whitespace DB + effective env value", db: "  ", effective: "env-value", want: true },
    { name: "DB value wins over env", db: "db-value", effective: "db-value", want: false },
    { name: "no effective value", db: "", effective: undefined, want: false },
  ])("$name", ({ db, effective, want }) => {
    expect(isEnvBackedValue(db, effective)).toBe(want);
  });
});

describe("llmPills（输入 = resolveAgentModelConfig 的生效值）", () => {
  it.each<Case<typeof llmPills>>([
    {
      name: "baseURL + modelId → 已配置 · <modelId 去首尾空白> (on)",
      input: { baseURL: "https://x/v1", modelId: " mimo-v2.5-pro ", fromEnv: false },
      want: [{ label: "已配置 · mimo-v2.5-pro", tone: "on" }],
    },
    {
      name: "只有 baseURL → 配置不全 (warn)",
      input: { baseURL: "https://x/v1", modelId: "", fromEnv: false },
      want: [{ label: "配置不全", tone: "warn" }],
    },
    {
      name: "只有 modelId → 配置不全 (warn)",
      input: { baseURL: "", modelId: "m", fromEnv: false },
      want: [{ label: "配置不全", tone: "warn" }],
    },
    {
      name: "都空 → 未配置 (off)",
      input: { baseURL: "", modelId: "  ", fromEnv: false },
      want: [{ label: "未配置", tone: "off" }],
    },
    {
      name: "有一项来自 env → 状态胶囊后追加 来自环境变量",
      input: { baseURL: "https://env/v1", modelId: "env-model", fromEnv: true },
      want: [{ label: "已配置 · env-model", tone: "on" }, ENV],
    },
    {
      name: "env 只补了一半 → 配置不全 + 来自环境变量",
      input: { baseURL: "https://env/v1", modelId: "", fromEnv: true },
      want: [{ label: "配置不全", tone: "warn" }, ENV],
    },
    {
      name: "未配置时不追加 来自环境变量（没有可归属的值）",
      input: { baseURL: "", modelId: "", fromEnv: true },
      want: [{ label: "未配置", tone: "off" }],
    },
  ])("$name", ({ input, want }) => {
    expect(llmPills(input)).toEqual(want);
  });
});

describe("jevPills（apiKeySet = getJevConfig 的生效 key 是否存在）", () => {
  const base = { apiKeySet: true, healthy: true, active: true, model: "jev-1.13.0", fromEnv: false };
  it.each<Case<typeof jevPills>>([
    {
      name: "生效中 + 模型名",
      input: base,
      want: [
        { label: "生效中", tone: "on" },
        { label: "jev-1.13.0", tone: "neutral" },
      ],
    },
    {
      name: "有 key、探活过、未启用 → 已关闭 (off)",
      input: { ...base, active: false },
      want: [
        { label: "已关闭", tone: "off" },
        { label: "jev-1.13.0", tone: "neutral" },
      ],
    },
    {
      name: "有 key 但没探活过 → 待测试 (warn)，不显示模型",
      input: { apiKeySet: true, healthy: false, active: false, model: null, fromEnv: false },
      want: [{ label: "待测试", tone: "warn" }],
    },
    {
      name: "无 key → 未配置 (off)，即使残留 model 也不显示",
      input: { apiKeySet: false, healthy: false, active: false, model: "stale", fromEnv: false },
      want: [{ label: "未配置", tone: "off" }],
    },
    {
      name: "model 为空串不追加胶囊",
      input: { ...base, model: "" },
      want: [{ label: "生效中", tone: "on" }],
    },
    {
      name: "model 为 null 不追加胶囊",
      input: { ...base, model: null },
      want: [{ label: "生效中", tone: "on" }],
    },
    {
      name: "key 来自 env → 来自环境变量 排在最后（模型名之后）",
      input: { ...base, fromEnv: true },
      want: [
        { label: "生效中", tone: "on" },
        { label: "jev-1.13.0", tone: "neutral" },
        ENV,
      ],
    },
    {
      name: "env key 还没测过 → 待测试 + 来自环境变量",
      input: { apiKeySet: true, healthy: false, active: false, model: null, fromEnv: true },
      want: [{ label: "待测试", tone: "warn" }, ENV],
    },
    {
      name: "无 key 时 fromEnv 不生效",
      input: { apiKeySet: false, healthy: false, active: false, model: null, fromEnv: true },
      want: [{ label: "未配置", tone: "off" }],
    },
  ])("$name", ({ input, want }) => {
    expect(jevPills(input)).toEqual(want);
  });
});

describe("tmdbPills（与 getTmdbAccesses 同序：DB Key → env TMDB_READ_TOKEN → 代理）", () => {
  it.each<Case<typeof tmdbPills>>([
    {
      name: "DB 里有自己的 Key → 直连 (on)",
      input: { userKeySet: true, envKeySet: false },
      want: [{ label: "直连 · 自己的 Key", tone: "on" }],
    },
    {
      name: "DB 与 env 都有 → 直连，先用 DB 那层，不标 来自环境变量",
      input: { userKeySet: true, envKeySet: true },
      want: [{ label: "直连 · 自己的 Key", tone: "on" }],
    },
    {
      name: "只有 env TMDB_READ_TOKEN → 直连 + 来自环境变量",
      input: { userKeySet: false, envKeySet: true },
      want: [{ label: "直连 · 自己的 Key", tone: "on" }, ENV],
    },
    {
      name: "都没有 → 代理兜底 (neutral)",
      input: { userKeySet: false, envKeySet: false },
      want: [{ label: "代理兜底", tone: "neutral" }],
    },
  ])("$name", ({ input, want }) => {
    expect(tmdbPills(input)).toEqual(want);
  });
});

describe("pansouPills（dbBaseURL / envBaseURL = resolveUserPanSouBaseUrl 的两层）", () => {
  it.each<Case<typeof pansouPills>>([
    {
      name: "DB 填了地址 → 自定义实例 (on)",
      input: { dbBaseURL: "http://192.168.1.1:8888", envBaseURL: "", health: null },
      want: [{ label: "自定义实例", tone: "on" }],
    },
    {
      name: "DB 优先：DB 有值时 env 那层不参与，也不标 来自环境变量",
      input: { dbBaseURL: "http://192.168.1.1:8888", envBaseURL: "http://pansou", health: null },
      want: [{ label: "自定义实例", tone: "on" }],
    },
    {
      name: "DB 空、env 指向自带容器 http://pansou → 内置实例 (neutral)",
      input: { dbBaseURL: "", envBaseURL: "http://pansou", health: "ok" },
      want: [{ label: "内置实例", tone: "neutral" }],
    },
    {
      name: "自带容器带端口也算内置；DB 只有空白也算没填",
      input: { dbBaseURL: "  ", envBaseURL: "http://pansou:8888", health: "" },
      want: [{ label: "内置实例", tone: "neutral" }],
    },
    {
      name: "DB 空、env 指向别的实例 → 自定义实例 + 来自环境变量",
      input: { dbBaseURL: "", envBaseURL: "https://pansou.example.com", health: null },
      want: [{ label: "自定义实例", tone: "on" }, ENV],
    },
    {
      name: "DB 显式填官方默认（带尾斜杠）→ 公共默认实例",
      input: { dbBaseURL: "https://so.252035.xyz/", envBaseURL: "", health: null },
      want: [{ label: "公共默认实例", tone: "neutral" }],
    },
    {
      name: "env 指向官方默认 → 公共默认实例 + 来自环境变量",
      input: { dbBaseURL: "", envBaseURL: "https://so.252035.xyz/", health: null },
      want: [{ label: "公共默认实例", tone: "neutral" }, ENV],
    },
    {
      name: "env 值不是合法 URL（不抛）→ 按非内置处理",
      input: { dbBaseURL: "", envBaseURL: "pansou", health: null },
      want: [{ label: "自定义实例", tone: "on" }, ENV],
    },
    {
      name: "两层都空 → 公共默认实例 (neutral)",
      input: { dbBaseURL: "", envBaseURL: "", health: "" },
      want: [{ label: "公共默认实例", tone: "neutral" }],
    },
    {
      name: "最近探活 unhealthy → 追加 连不上 (warn)",
      input: { dbBaseURL: "http://x", envBaseURL: "", health: "unhealthy" },
      want: [
        { label: "自定义实例", tone: "on" },
        { label: "连不上", tone: "warn" },
      ],
    },
    {
      name: "env 自定义 + unhealthy → 连不上 排在 来自环境变量 之后",
      input: { dbBaseURL: "", envBaseURL: "https://pansou.example.com", health: "unhealthy" },
      want: [{ label: "自定义实例", tone: "on" }, ENV, { label: "连不上", tone: "warn" }],
    },
    {
      name: "探活 ok 不追加",
      input: { dbBaseURL: "http://x", envBaseURL: "", health: "ok" },
      want: [{ label: "自定义实例", tone: "on" }],
    },
  ])("$name", ({ input, want }) => {
    expect(pansouPills(input)).toEqual(want);
  });
});

describe("prowlarrPills（输入 = getProwlarrConfig 的生效值）", () => {
  const MAGNET_ONLY: ServicePill = { label: "仅磁力盘", tone: "neutral" };
  it.each<Case<typeof prowlarrPills>>([
    {
      name: "URL + key → 已接入 (on)，仅磁力盘 恒在最后",
      input: { baseURL: "http://x:9696", apiKeySet: true, fromEnv: false },
      want: [{ label: "已接入", tone: "on" }, MAGNET_ONLY],
    },
    {
      name: "只有 URL → 配置不全 (warn)",
      input: { baseURL: "http://x:9696", apiKeySet: false, fromEnv: false },
      want: [{ label: "配置不全", tone: "warn" }, MAGNET_ONLY],
    },
    {
      name: "只有 key → 配置不全 (warn)",
      input: { baseURL: "", apiKeySet: true, fromEnv: false },
      want: [{ label: "配置不全", tone: "warn" }, MAGNET_ONLY],
    },
    {
      name: "都无 → 未接入 (off)，仍带 仅磁力盘",
      input: { baseURL: "", apiKeySet: false, fromEnv: false },
      want: [{ label: "未接入", tone: "off" }, MAGNET_ONLY],
    },
    {
      name: "有一项来自 env → 状态、来自环境变量、仅磁力盘",
      input: { baseURL: "http://prowlarr:9696", apiKeySet: true, fromEnv: true },
      want: [{ label: "已接入", tone: "on" }, ENV, MAGNET_ONLY],
    },
    {
      name: "env 只补了一半 → 配置不全 + 来自环境变量 + 仅磁力盘",
      input: { baseURL: "http://prowlarr:9696", apiKeySet: false, fromEnv: true },
      want: [{ label: "配置不全", tone: "warn" }, ENV, MAGNET_ONLY],
    },
    {
      name: "未接入时不追加 来自环境变量",
      input: { baseURL: "", apiKeySet: false, fromEnv: true },
      want: [{ label: "未接入", tone: "off" }, MAGNET_ONLY],
    },
  ])("$name", ({ input, want }) => {
    expect(prowlarrPills(input)).toEqual(want);
  });
});

describe("assrtPills", () => {
  it("有 token → 已配置 (on)；无 → 未配置 (off)", () => {
    expect(assrtPills({ tokenSet: true })).toEqual([{ label: "已配置", tone: "on" }]);
    expect(assrtPills({ tokenSet: false })).toEqual([{ label: "未配置", tone: "off" }]);
  });
});
