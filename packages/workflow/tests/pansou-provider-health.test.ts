import { describe, expect, it } from "vitest";
import { PanSouResourceProvider } from "../src/pansou-provider.js";

// NOTE: PanSou nests links under `result.links[]` (see collectLinkFacts) — a
// result with a top-level `url` yields ZERO facts. The fixture must use the
// real shape or "returns candidates" assertions can never pass.
const OK_RESPONSE = {
  code: 0,
  data: {
    results: [
      {
        title: "示例 S01",
        channel: "telegram-a",
        links: [
          {
            type: "quark",
            url: "https://pan.quark.cn/s/abc123",
            password: "",
            datetime: "2026-08-01",
          },
        ],
      },
    ],
  },
};

describe("PanSouResourceProvider source health", () => {
  it("reports healthy and returns candidates on a good response", async () => {
    const provider = new PanSouResourceProvider({
      baseURL: "http://pansou.test",
      fetchJson: async () => OK_RESPONSE,
      wait: async () => {},
    });

    const snapshot = await provider.search({ keyword: "示例" });

    expect(snapshot.sourceHealth?.status).toBe("healthy");
    expect(snapshot.candidates.length).toBeGreaterThan(0);
  });

  it("reports unreachable instead of an empty no-results snapshot when the FIRST call fails", async () => {
    // The reported bug: PanSou had been down for 6 days and the product kept
    // saying 「暂未找到可用资源」.
    const provider = new PanSouResourceProvider({
      baseURL: "http://pansou.test",
      fetchJson: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8899"), {
          code: "ECONNREFUSED",
        });
      },
      wait: async () => {},
    });

    const snapshot = await provider.search({ keyword: "示例" });

    expect(snapshot.candidates).toEqual([]);
    expect(snapshot.sourceHealth?.status).toBe("unreachable");
  });

  it("reports protocol_error when the endpoint answers but is not PanSou", async () => {
    // Real scenario: the address pointed at a static file server.
    const provider = new PanSouResourceProvider({
      baseURL: "http://pansou.test",
      fetchJson: async () => ({ hello: "i am not pansou" }),
      wait: async () => {},
    });

    const snapshot = await provider.search({ keyword: "示例" });

    expect(snapshot.candidates).toEqual([]);
    expect(snapshot.sourceHealth?.status).toBe("protocol_error");
  });

  it("stays healthy when a LATER poll fails but earlier polls already produced results", async () => {
    // The original catch existed to preserve partial results mid-poll. That must
    // survive: real evidence was already obtained, so the source is not 'down'.
    let call = 0;
    const provider = new PanSouResourceProvider({
      baseURL: "http://pansou.test",
      fetchJson: async () => {
        call += 1;
        if (call === 1) return OK_RESPONSE;
        throw new Error("connection reset mid-poll");
      },
      wait: async () => {},
    });

    const snapshot = await provider.search({ keyword: "示例" });

    expect(snapshot.candidates.length).toBeGreaterThan(0);
    expect(snapshot.sourceHealth?.status).toBe("healthy");
  });

  it("reports healthy with zero candidates when PanSou genuinely has nothing", async () => {
    // The control that must NOT regress: a real empty result is an authoritative
    // 'no resources' answer and must stay distinguishable from a failure.
    const provider = new PanSouResourceProvider({
      baseURL: "http://pansou.test",
      fetchJson: async () => ({ code: 0, data: { results: [] } }),
      wait: async () => {},
    });

    const snapshot = await provider.search({ keyword: "示例" });

    expect(snapshot.candidates).toEqual([]);
    expect(snapshot.sourceHealth?.status).toBe("healthy");
  });

  it("classifies a PanSou error response (code!=0) as unreachable, NOT protocol_error", async () => {
    // code:400 的响应**是 PanSou**(按它的协议应答),只是报了错 —— 限流/参数错。
    // 归 protocol_error 会让用户以为「地址填错了」,而实际上是源侧临时故障。
    const provider = new PanSouResourceProvider({
      baseURL: "http://pansou.test",
      fetchJson: async () => ({ code: 400, message: "bad request" }),
      wait: async () => {},
    });

    const snapshot = await provider.search({ keyword: "示例" });

    expect(snapshot.candidates).toEqual([]);
    expect(snapshot.sourceHealth?.status).toBe("unreachable");
    expect(snapshot.sourceHealth?.status).not.toBe("protocol_error");
  });

  it("keeps polling across attempts (the streaming behaviour must not regress)", async () => {
    // PanSou returns more results on later calls; the provider must not stop at
    // the first non-growing response before attempt 1.
    let call = 0;
    const provider = new PanSouResourceProvider({
      baseURL: "http://pansou.test",
      fetchJson: async () => {
        call += 1;
        return call === 1
          ? OK_RESPONSE
          : {
              code: 0,
              data: {
                results: [
                  ...OK_RESPONSE.data.results,
                  {
                    title: "示例 S02",
                    channel: "telegram-b",
                    links: [
                      {
                        type: "quark",
                        url: "https://pan.quark.cn/s/def456",
                        password: "",
                        datetime: "2026-08-02",
                      },
                    ],
                  },
                ],
              },
            };
      },
      wait: async () => {},
    });

    const snapshot = await provider.search({ keyword: "示例" });

    expect(call).toBeGreaterThan(1);
    expect(snapshot.candidates.length).toBe(2);
    expect(snapshot.sourceHealth?.status).toBe("healthy");
  });
});
