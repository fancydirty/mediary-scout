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

describe("PanSouResourceProvider zero-hit response shape", () => {
  // Real PanSou (fish2018/pansou model/response.go): `Results` is tagged
  // `json:"results,omitempty"`, so a search with ZERO hits serialises as
  // `{"code":0,"message":"success","data":{"total":0}}` — no `results` key at all.
  // Verified live 2026-09-19 against both the self-hosted container and the
  // official so.252035.xyz. Treating that as "not a PanSou payload" turned every
  // legitimate miss into a false 「搜索源连不上/配置有问题」 alert for 12 days.
  const ZERO_HIT_RESPONSE = { code: 0, message: "success", data: { total: 0 } };

  it("treats {code:0,data:{total:0}} (results omitted) as healthy with no candidates", async () => {
    const provider = new PanSouResourceProvider({
      baseURL: "http://pansou.test",
      fetchJson: async () => ZERO_HIT_RESPONSE,
      wait: async () => {},
    });

    const snapshot = await provider.search({ keyword: "zzqxv_nonexistent" });

    expect(snapshot.candidates).toEqual([]);
    expect(snapshot.sourceHealth?.status).toBe("healthy");
  });

  it("still flags protocol_error when data lacks BOTH results and total", async () => {
    // Keep the original guard: a JSON blob with a `code` of 0 but no PanSou
    // data fields at all is still "not PanSou" (e.g. some other service's envelope).
    const provider = new PanSouResourceProvider({
      baseURL: "http://pansou.test",
      fetchJson: async () => ({ code: 0, data: { something: "else" } }),
      wait: async () => {},
    });

    const snapshot = await provider.search({ keyword: "示例" });

    expect(snapshot.candidates).toEqual([]);
    expect(snapshot.sourceHealth?.status).toBe("protocol_error");
  });

  it("flags protocol_error when results is PRESENT but not an array, even with a numeric total", async () => {
    // Copilot (#259 r1): a numeric `total` must not mask a malformed `results`.
    // Without this guard a non-iterable value reaches collectLinkFacts' for...of and
    // throws a TypeError → misclassified as `unreachable` (「源挂了」) instead of
    // `protocol_error` (「那不是 PanSou」); an iterable string would silently yield
    // zero facts and read as a healthy miss.
    for (const results of [{}, "garbage", 42, true]) {
      const provider = new PanSouResourceProvider({
        baseURL: "http://pansou.test",
        fetchJson: async () => ({ code: 0, data: { total: 1, results } }),
        wait: async () => {},
      });

      const snapshot = await provider.search({ keyword: "示例" });

      expect(snapshot.candidates).toEqual([]);
      expect(snapshot.sourceHealth?.status).toBe("protocol_error");
    }
  });

  it("treats results:null like an omitted results (zero hits), not as malformed", async () => {
    // encoding/json emits `null` for a nil slice when a build lacks `omitempty`;
    // that is "no list", not a broken one — same handling as the omitted key.
    const provider = new PanSouResourceProvider({
      baseURL: "http://pansou.test",
      fetchJson: async () => ({ code: 0, data: { total: 0, results: null } }),
      wait: async () => {},
    });

    const snapshot = await provider.search({ keyword: "示例" });

    expect(snapshot.candidates).toEqual([]);
    expect(snapshot.sourceHealth?.status).toBe("healthy");
  });
});
