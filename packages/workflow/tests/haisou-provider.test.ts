import { describe, expect, it } from "vitest";
import { HaisouResourceProvider } from "../src/haisou-provider.js";
import type { HaisouFetchJson } from "../src/haisou-provider.js";

function okResponse(items: unknown[]) {
  return { code: 0, requestId: "idr_api_test", result: { items, pagination: { page: 1, pageSize: 100, total: items.length } } };
}

function provider(fetchJson: HaisouFetchJson, extra?: { allowedTypes?: readonly ("115" | "quark" | "uc" | "tianyi" | "123" | "guangya" | "magnet" | "manual")[] }) {
  return new HaisouResourceProvider({
    apiKey: "idr_test",
    fetchJson,
    now: () => "2026-10-26T00:00:00.000Z",
    ...(extra?.allowedTypes ? { allowedTypes: extra.allowedTypes } : {}),
  });
}

describe("HaisouResourceProvider", () => {
  // Regression pin (found only by a real call, all unit tests passed): idatariver
  // reads the key from the query string. Omitting it returns `code: 1001`, which
  // the provider correctly reports as unreachable — i.e. it looked like "source
  // down" for a client-side mistake.
  it("puts the apikey in the query string, not the body or a header", async () => {
    let seenUrl = "";
    let seenBody = "";
    const p = provider(async (url, init) => {
      seenUrl = url;
      seenBody = init.body;
      return okResponse([]);
    });
    await p.search({ keyword: "沙丘" });
    expect(seenUrl).toContain("apikey=idr_test");
    expect(seenBody).not.toContain("idr_test");
  });

  it("maps the official API shape into candidates (shareUrl + sharePwd + size)", async () => {
    const p = provider(async () => okResponse([
      {
        hsid: "gTK4CPenhs", platform: "quark", platformName: "夸克网盘",
        title: "沙丘", highlightedTitle: '<span class="highlight">沙丘</span>',
        shareUrl: "https://pan.quark.cn/s/d22117a6ffc3", shareCode: "d22117a6ffc3",
        sharePwd: "", fileCount: 3, sizeBytes: 28940407989,
      },
    ]));
    const snap = await p.search({ keyword: "沙丘" });
    expect(snap.provider).toBe("haisou");
    expect(snap.candidates).toHaveLength(1);
    const c = snap.candidates[0]!;
    expect(c.type).toBe("quark");
    expect(c.title).toBe("沙丘");
    expect(c.providerPayload["url"]).toBe("https://pan.quark.cn/s/d22117a6ffc3");
    expect(c.providerPayload["sizeBytes"]).toBe(28940407989);
    // The source has no ISO timestamp; keep it empty rather than inventing one.
    expect(c.providerPayload["datetime"]).toBe("");
  });

  it("strips the <span class=highlight> markup out of the title", async () => {
    const p = provider(async () => okResponse([
      { platform: "115", title: 'a <span class="highlight">沙丘</span> b', shareUrl: "https://115.com/s/abc123", sharePwd: "x1y2" },
    ]));
    const snap = await p.search({ keyword: "沙丘" });
    expect(snap.candidates[0]!.title).toBe("a 沙丘 b");
    expect(snap.candidates[0]!.providerPayload["password"]).toBe("x1y2");
  });

  it("keeps guangya — the platform the official docs don't list but the API serves", async () => {
    const p = provider(async () => okResponse([
      {
        platform: "guangya", title: "沙丘 (1984)",
        shareUrl: "https://www.guangyapan.com/s/1961038051308896266_al17ELaa58LSIYXK",
        shareCode: "1961038051308896266_al17ELaa58LSIYXK", sharePwd: "", fileCount: 1, sizeBytes: 86517323575,
      },
    ]));
    const snap = await p.search({ keyword: "沙丘" });
    expect(snap.candidates).toHaveLength(1);
    expect(snap.candidates[0]!.type).toBe("guangya");
  });

  it("drops platforms this product cannot transfer (xunlei/ali/baidu/yidong…)", async () => {
    const p = provider(async () => okResponse([
      { platform: "xunlei", title: "a", shareUrl: "https://pan.xunlei.com/s/VP4r_ok9Ynpf94_bk17AdwsiA" },
      { platform: "ali", title: "b", shareUrl: "https://www.alipan.com/s/TxDxkWUMcnx" },
      { platform: "baidu", title: "c", shareUrl: "https://pan.baidu.com/s/1VV0f0Cb596Eh3wkSgO1kdQ" },
      { platform: "yidong", title: "d", shareUrl: "https://yun.139.com/shareweb/#/w/i/2wFGYbx5gYgi7" },
      { platform: "quark", title: "keep", shareUrl: "https://pan.quark.cn/s/keepme" },
    ]));
    const snap = await p.search({ keyword: "x" });
    expect(snap.candidates.map((c) => c.providerPayload["url"])).toEqual(["https://pan.quark.cn/s/keepme"]);
  });

  it("validates the URL shape, not just the declared platform (lookalike host)", async () => {
    // Declares quark but points at an attacker host: PanSou's classifier rejects
    // it, and this provider must reject it the same way.
    const p = provider(async () => okResponse([
      { platform: "quark", title: "evil", shareUrl: "https://evil.example.com/pan.quark.cn/s/abc" },
      { platform: "uc", title: "evil-uc", shareUrl: "https://attacker.com/drive.uc.cn/s/x" },
    ]));
    const snap = await p.search({ keyword: "x" });
    expect(snap.candidates).toHaveLength(0);
  });

  it("honours allowedTypes (a 115-only drive must not get quark candidates)", async () => {
    const p = provider(
      async () => okResponse([
        { platform: "quark", title: "q", shareUrl: "https://pan.quark.cn/s/aaa" },
        { platform: "115", title: "1", shareUrl: "https://115.com/s/bbb" },
      ]),
      { allowedTypes: ["115"] },
    );
    const snap = await p.search({ keyword: "x" });
    expect(snap.candidates.map((c) => c.type)).toEqual(["115"]);
  });

  it("reports sourceHealth=unreachable when idatariver returns a non-zero code (1001 missing key / 1005 no balance)", async () => {
    const p = provider(async () => ({ code: 1005, msg: "余额不足" }));
    const snap = await p.search({ keyword: "沙丘" });
    expect(snap.candidates).toHaveLength(0);
    expect(snap.sourceHealth?.status).toBe("unreachable");
    expect(snap.sourceHealth?.unhealthySources).toContain("haisou");
  });

  it("reports sourceHealth=unreachable when the upstream throws", async () => {
    const p = provider(async () => { throw new Error("ECONNREFUSED"); });
    const snap = await p.search({ keyword: "沙丘" });
    expect(snap.sourceHealth?.status).toBe("unreachable");
  });

  it("does not call the network at all when no apikey is configured", async () => {
    let called = false;
    const p = new HaisouResourceProvider({
      apiKey: "",
      fetchJson: async () => { called = true; return okResponse([]); },
    });
    const snap = await p.search({ keyword: "沙丘" });
    expect(called).toBe(false);
    expect(snap.sourceHealth?.status).toBe("unreachable");
  });

  it("gives per-run snapshot ids so a re-acquisition never collides on the PK", async () => {
    const p = provider(async () => okResponse([]));
    const a = await p.search({ keyword: "沙丘", workflowRunId: "run-1" });
    const b = await p.search({ keyword: "沙丘", workflowRunId: "run-2" });
    expect(a.id).not.toBe(b.id);
    // Same keyword, no run: still keyword-specific (empty results must not share one id).
    const c = await p.search({ keyword: "沙丘" });
    const d = await p.search({ keyword: "繁花" });
    expect(c.id).not.toBe(d.id);
  });
});
