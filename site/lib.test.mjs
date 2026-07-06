import { describe, expect, it } from "vitest";
import { detectPlatform, orderDownloads, formatStars, postersFrom } from "./lib.mjs";

describe("detectPlatform", () => {
  it("mac UA → mac", () => { expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("mac"); });
  it("windows UA → win", () => { expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("win"); });
  it("other → other", () => { expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("other"); });
});

describe("orderDownloads", () => {
  const rel = { tag_name: "v1.1.0", assets: [
    { name: "Mediary.Scout-1.1.0-arm64.dmg", browser_download_url: "https://gh/d.dmg" },
    { name: "Mediary.Scout.Setup.1.1.0.exe", browser_download_url: "https://gh/s.exe" }] };
  it("win 平台把 exe 排第一并给出版本号", () => {
    const r = orderDownloads(rel, "win");
    expect(r.version).toBe("v1.1.0");
    expect(r.items[0]).toEqual({ platform: "win", label: "Windows", url: "https://gh/s.exe" });
    expect(r.items[1].platform).toBe("mac");
  });
  it("mac 平台保持 mac 第一", () => {
    const r = orderDownloads(rel, "mac");
    expect(r.items[0].platform).toBe("mac");
  });
  it("资产缺失时回退 Releases 页链接", () => {
    const r = orderDownloads({ tag_name: "v9", assets: [] }, "mac");
    expect(r.items[0].url).toContain("/releases");
  });
  it("release 为 null 时不炸", () => {
    const r = orderDownloads(null, "other");
    expect(r.version).toBe("");
    expect(r.items).toHaveLength(2);
  });
});

describe("formatStars", () => {
  it("966 → 966", () => expect(formatStars(966)).toBe("966"));
  it("1234 → 1.2k", () => expect(formatStars(1234)).toBe("1.2k"));
  it("2000 → 2k（去掉 .0）", () => expect(formatStars(2000)).toBe("2k"));
});

describe("postersFrom", () => {
  it("取 poster_path 非空前 N 个拼 w342 URL，movie/tv 标题都认", () => {
    const data = { results: [{ poster_path: "/a.jpg", title: "甲" }, { poster_path: null }, { poster_path: "/b.jpg", name: "乙" }] };
    expect(postersFrom([data], 2)).toEqual([
      { url: "https://image.tmdb.org/t/p/w342/a.jpg", title: "甲" },
      { url: "https://image.tmdb.org/t/p/w342/b.jpg", title: "乙" }]);
  });
  it("跨 feed 收集且尊重 limit", () => {
    const f1 = { results: [{ poster_path: "/1.jpg", title: "一" }] };
    const f2 = { results: [{ poster_path: "/2.jpg", name: "二" }, { poster_path: "/3.jpg", name: "三" }] };
    expect(postersFrom([f1, f2], 2).map((p) => p.title)).toEqual(["一", "二"]);
  });
  it("坏 feed（null/无 results）跳过不炸", () => {
    expect(postersFrom([null, {}], 5)).toEqual([]);
  });
  it("limit <= 0 返回空数组", () => {
    const data = { results: [{ poster_path: "/a.jpg", title: "甲" }] };
    expect(postersFrom([data], 0)).toEqual([]);
    expect(postersFrom([data], -1)).toEqual([]);
  });
});
