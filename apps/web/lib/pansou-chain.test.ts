import { beforeEach, describe, expect, it } from "vitest";
import { FallbackResourceProvider, PanSouResourceProvider } from "@media-track/workflow";
import {
  buildPanSouProviderChain,
  observeHealth,
  DEFAULT_PANSOU_BASE_URL,
  resolveUserPanSouBaseUrl,
} from "./pansou-chain";

const healthySnapshot = {
  id: "s1",
  provider: "pansou",
  keyword: "k",
  candidates: [],
  createdAt: "2026-08-06T00:00:00.000Z",
  sourceHealth: { status: "healthy" as const, unhealthySources: [] },
};

let seen: boolean[] = [];
beforeEach(() => {
  seen = [];
});

describe("buildPanSouProviderChain", () => {
  it("returns a bare PanSou provider when the user configured no custom source", () => {
    expect(buildPanSouProviderChain({ userBaseURL: "", allowedTypes: [] })).toBeInstanceOf(
      PanSouResourceProvider,
    );
  });

  it("returns a bare PanSou provider when the user's source IS the official one", () => {
    // Nothing to fall back TO — wrapping would just double every failed search.
    expect(
      buildPanSouProviderChain({ userBaseURL: DEFAULT_PANSOU_BASE_URL, allowedTypes: [] }),
    ).toBeInstanceOf(PanSouResourceProvider);
  });

  it("ignores surrounding whitespace when comparing against the official source", () => {
    expect(
      buildPanSouProviderChain({ userBaseURL: `  ${DEFAULT_PANSOU_BASE_URL}  `, allowedTypes: [] }),
    ).toBeInstanceOf(PanSouResourceProvider);
  });

  it("wraps user + official in a fallback chain when a custom source is configured", () => {
    expect(
      buildPanSouProviderChain({ userBaseURL: "http://192.168.1.10:8899", allowedTypes: [] }),
    ).toBeInstanceOf(FallbackResourceProvider);
  });
});

/** 这些用例守的是一个「测试抓不到、只有生产会疼」的回归：装配链若只读 DB 一层，
 *  compose 自带的 pansou 容器（只经 env PANSOU_BASE_URL 注入，DB 为空）会被
 *  静默换成官方公共源。getPanSouBaseUrl 的既有测试仍然全绿 —— 因为那个函数没被
 *  改坏，只是在真正的检索路径上被绕过了。 */
describe("resolveUserPanSouBaseUrl", () => {
  it("prefers the DB setting over env", () => {
    expect(
      resolveUserPanSouBaseUrl(" http://db.example ", { PANSOU_BASE_URL: "http://env.example" }),
    ).toBe("http://db.example");
  });

  it("keeps the env tier when the DB setting is blank (compose 自带 pansou 走这条)", () => {
    expect(resolveUserPanSouBaseUrl(null, { PANSOU_BASE_URL: " http://pansou " })).toBe(
      "http://pansou",
    );
  });

  it("returns empty when neither tier is configured", () => {
    expect(resolveUserPanSouBaseUrl(null, {})).toBe("");
  });
});

describe("observeHealth（告警能否在生产触发的唯一信号来源）", () => {
  it("答话且健康 → 报 healthy=true，快照原样返回", async () => {
    const wrapped = observeHealth(
      { search: async () => healthySnapshot },
      (healthy) => seen.push(healthy),
    );

    const out = await wrapped.search({ keyword: "k" });

    expect(seen).toEqual([true]);
    expect(out).toBe(healthySnapshot);
  });

  it("自报 unreachable → 报 healthy=false", async () => {
    // 保存时探活只会写 "ok"，而事故正是「保存时好的、之后才挂」——
    // 没有这条回写，设置页告警在生产中永远不会亮（Copilot 评审指出）。
    const wrapped = observeHealth(
      {
        search: async () => ({
          ...healthySnapshot,
          sourceHealth: { status: "unreachable" as const, unhealthySources: ["自建搜索源"] },
        }),
      },
      (healthy) => seen.push(healthy),
    );

    await wrapped.search({ keyword: "k" });

    expect(seen).toEqual([false]);
  });

  it("degraded 仍算可用（确实答了话）", async () => {
    const wrapped = observeHealth(
      {
        search: async () => ({
          ...healthySnapshot,
          sourceHealth: { status: "degraded" as const, unhealthySources: ["prowlarr"] },
        }),
      },
      (healthy) => seen.push(healthy),
    );

    await wrapped.search({ keyword: "k" });

    expect(seen).toEqual([true]);
  });

  it("抛错 → 报 false，且异常原样重抛（fallback 层要靠它分类病因）", async () => {
    const boom = new Error("connect ECONNREFUSED");
    const wrapped = observeHealth(
      {
        search: async () => {
          throw boom;
        },
      },
      (healthy) => seen.push(healthy),
    );

    await expect(wrapped.search({ keyword: "k" })).rejects.toBe(boom);
    expect(seen).toEqual([false]);
  });
});
