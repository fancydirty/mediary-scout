import { describe, expect, it } from "vitest";
import { probePanSou } from "./pansou-probe";

/** PanSou 正常响应的最小形状:data.results 是数组。探活只看形状,不看命中。 */
function pansouResponse(body: unknown = { data: { results: [] } }, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("probePanSou", () => {
  it("accepts a PanSou-shaped 200", async () => {
    const result = await probePanSou("http://192.168.1.10:8899", {
      fetchImpl: pansouResponse({ data: { results: [{ title: "x" }] } }),
    });
    expect(result).toEqual({ ok: true });
  });

  it("POSTs to /api/search on the given base URL, tolerating a trailing slash", async () => {
    let seenUrl = "";
    let seenMethod = "";
    const result = await probePanSou("http://192.168.1.10:8899/", {
      fetchImpl: (async (url: string, init: RequestInit) => {
        seenUrl = url;
        seenMethod = init.method ?? "";
        return new Response(JSON.stringify({ data: { results: [] } }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(seenUrl).toBe("http://192.168.1.10:8899/api/search");
    expect(seenMethod).toBe("POST");
    expect(result.ok).toBe(true);
  });

  it("reports unreachable when the connection is refused", async () => {
    const result = await probePanSou("http://192.168.1.10:8899", {
      fetchImpl: (async () => {
        throw Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" });
      }) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("reports not_pansou when the address answers with something else (e.g. HTML)", async () => {
    // 这是「填成了别的服务」的真实形态:能连上、200,但不是 PanSou 接口。
    const result = await probePanSou("http://192.168.1.10:8899", {
      fetchImpl: (async () =>
        new Response("<!doctype html><html><body>nginx</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        })) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, reason: "not_pansou" });
  });

  it("reports not_pansou when JSON parses but lacks data.results", async () => {
    const result = await probePanSou("http://192.168.1.10:8899", {
      fetchImpl: pansouResponse({ data: { total: 0 } }),
    });
    expect(result).toMatchObject({ ok: false, reason: "not_pansou" });
  });

  it("reports http_error on a 502", async () => {
    const result = await probePanSou("http://192.168.1.10:8899", {
      fetchImpl: pansouResponse({ data: { results: [] } }, 502),
    });
    expect(result).toMatchObject({ ok: false, reason: "http_error" });
    if (!result.ok) expect(result.message).toContain("502");
  });

  it("gives every failure a non-empty human-readable message", async () => {
    // 保存被拒时用户必须知道「为什么」——这正是原事故里缺失的那句话。
    const failures = await Promise.all([
      probePanSou("http://x", {
        fetchImpl: (async () => {
          throw new Error("boom");
        }) as unknown as typeof fetch,
      }),
      probePanSou("http://x", { fetchImpl: pansouResponse({ nope: true }) }),
      probePanSou("http://x", { fetchImpl: pansouResponse({ data: { results: [] } }, 502) }),
    ]);
    for (const failure of failures) {
      expect(failure.ok).toBe(false);
      if (!failure.ok) {
        expect(failure.message.trim().length).toBeGreaterThan(0);
        expect(failure.message).toContain("未保存");
      }
    }
  });
});
