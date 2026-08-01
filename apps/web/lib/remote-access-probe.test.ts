import { describe, expect, it, vi } from "vitest";
import { probeRemoteAccess } from "./remote-access-probe";

describe("probeRemoteAccess", () => {
  const H = "dirtyfancy.mediaryconnect.app";
  const probe = (status: number, body: unknown = { status: "ok" }) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
    return { fetchMock, result: probeRemoteAccess(H, fetchMock) };
  };

  it("200 + ok body → 可达", async () => {
    const { fetchMock, result } = probe(200);
    await expect(result).resolves.toEqual({ ok: true, detail: "reachable" });
    // 必须 GET 且带超时与 no-store
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://${H}/api/health`);
    expect(init.method ?? "GET").toBe("GET");
    expect(init.signal).toBeDefined();
    expect(init.cache).toBe("no-store");
  });

  it("503 → 隧道通但实例内部有问题(用户该查实例不是隧道)", async () => {
    await expect(probe(503).result).resolves.toEqual({ ok: false, detail: "instance_problem" });
  });

  it("200 但 body 不是 ok(反代登录页陷阱)→ 不可达", async () => {
    // 镜像 remote-access.ts 的"严格判 204"陷阱:反代可能对任何路径回 200 登录页。
    await expect(probe(200, "<html>login page</html>").result).resolves.toEqual({
      ok: false,
      detail: "unreachable",
    });
    await expect(probe(200, { hello: "world" }).result).resolves.toEqual({
      ok: false,
      detail: "unreachable",
    });
  });

  it("fetch 抛错(超时/网络/DNS)→ 不可达,不冒泡", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("boom"); });
    await expect(probeRemoteAccess(H, fetchMock)).resolves.toEqual({
      ok: false,
      detail: "unreachable",
    });
  });

  it("其它 4xx/5xx → 不可达", async () => {
    for (const status of [401, 404, 500, 502]) {
      await expect(probe(status).result).resolves.toEqual({ ok: false, detail: "unreachable" });
    }
  });
});
