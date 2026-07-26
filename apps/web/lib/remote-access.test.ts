import { afterEach, describe, expect, it, vi } from "vitest";
import {
  instanceTunnelToken,
  resolveRemoteAccessState,
  type RemoteAccessState,
} from "./remote-access";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

describe("resolveRemoteAccessState", () => {
  it("无 TUNNEL_TOKEN → not_provisioned，且**不发心跳**", async () => {
    const sendHeartbeat = vi.fn(async () => true);
    const state = await resolveRemoteAccessState({ token: undefined, sendHeartbeat });
    expect(state).toEqual({ kind: "not_provisioned" });
    // 没 token 就没身份可报——发了只会向 worker 暴露一台未开通实例的存在。
    expect(sendHeartbeat).not.toHaveBeenCalled();
  });

  it("空串 / 纯空白 token 视同未开通（.env 里 TUNNEL_TOKEN= 就是这形状）", async () => {
    const sendHeartbeat = vi.fn(async () => true);
    for (const token of ["", "   "]) {
      expect(await resolveRemoteAccessState({ token, sendHeartbeat })).toEqual({
        kind: "not_provisioned",
      });
    }
    expect(sendHeartbeat).not.toHaveBeenCalled();
  });

  it("心跳 204 → active（hostname 无本地来源时为 null，绝不臆造）", async () => {
    const state = await resolveRemoteAccessState({
      token: "tok",
      sendHeartbeat: async () => true,
    });
    expect(state).toEqual({ kind: "active", hostname: null });
  });

  it("调用方能提供本地已知 hostname 时透传", async () => {
    const state = await resolveRemoteAccessState({
      token: "tok",
      hostname: "s1.mediaryconnect.app",
      sendHeartbeat: async () => true,
    });
    expect(state).toEqual({ kind: "active", hostname: "s1.mediaryconnect.app" });
  });

  it("心跳失败（非 204）→ active_degraded", async () => {
    const state = await resolveRemoteAccessState({
      token: "tok",
      sendHeartbeat: async () => false,
    });
    expect(state).toEqual({ kind: "active_degraded" });
  });

  it("心跳抛错（网络不可达）→ active_degraded，不冒泡炸掉整页 SSR", async () => {
    const state = await resolveRemoteAccessState({
      token: "tok",
      sendHeartbeat: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(state).toEqual({ kind: "active_degraded" });
  });

  it("token 绝不出现在返回的 state 里（这东西会被序列化进 RSC 载荷）", async () => {
    const token = "super-secret-connector-token";
    const states: RemoteAccessState[] = [
      await resolveRemoteAccessState({ token, sendHeartbeat: async () => true }),
      await resolveRemoteAccessState({ token, sendHeartbeat: async () => false }),
      await resolveRemoteAccessState({
        token,
        sendHeartbeat: async () => {
          throw new Error(`failed for ${token}`); // 连报错串里的 token 也不能漏出去
        },
      }),
    ];
    for (const state of states) {
      expect(JSON.stringify(state)).not.toContain(token);
    }
  });

  it("默认心跳：Bearer 头 + POST + no-store，204 判成功", async () => {
    process.env.SCOUT_CONNECT_URL = "https://connect.test";
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const state = await resolveRemoteAccessState({ token: "tok-abc" });

    expect(state).toEqual({ kind: "active", hostname: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://connect.test/api/instance/status");
    expect(init.method).toBe("POST");
    expect(init.cache).toBe("no-store");
    // 契约是 Authorization: Bearer <token> 头，不是 JSON body。
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tok-abc");
    expect(init.body).toBeUndefined();
  });

  it("默认心跳 base URL 缺省为生产 worker", async () => {
    delete process.env.SCOUT_CONNECT_URL;
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await resolveRemoteAccessState({ token: "tok" });

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://mediaryconnect.app/api/instance/status");
  });

  it("默认心跳：401（token 已吊销）→ active_degraded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })));
    expect(await resolveRemoteAccessState({ token: "revoked" })).toEqual({ kind: "active_degraded" });
  });

  it("默认心跳：200 也算失败——契约明确是 204 无 body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    expect(await resolveRemoteAccessState({ token: "tok" })).toEqual({ kind: "active_degraded" });
  });

  it("默认心跳：fetch 抛错 → active_degraded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    expect(await resolveRemoteAccessState({ token: "tok" })).toEqual({ kind: "active_degraded" });
  });
});

describe("心跳超时（SSR 渲染路径上的硬要求）", () => {
  it("带 AbortSignal —— 项目硬规则「新外部 HTTP 一律带超时」", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await resolveRemoteAccessState({ token: "tok" });
    const init = fetchMock.mock.calls[0]?.[1];
    // 没有 signal 的话，worker「卡住但不报错」会把整个 /settings 渲染挂死
    expect(init?.signal).toBeDefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("超时被中止 → 降级，不向渲染路径抛错", async () => {
    // AbortSignal.timeout 到期时 fetch 抛 TimeoutError；必须被吞成 degraded
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }),
    );
    await expect(resolveRemoteAccessState({ token: "tok" })).resolves.toEqual({
      kind: "active_degraded",
    });
  });
});

describe("instanceTunnelToken", () => {
  it("读 TUNNEL_TOKEN 并 trim", () => {
    process.env.TUNNEL_TOKEN = "  tok  ";
    expect(instanceTunnelToken()).toBe("tok");
  });

  it("未设 / 空串 / 纯空白 → undefined", () => {
    delete process.env.TUNNEL_TOKEN;
    expect(instanceTunnelToken()).toBeUndefined();
    process.env.TUNNEL_TOKEN = "";
    expect(instanceTunnelToken()).toBeUndefined();
    process.env.TUNNEL_TOKEN = "   ";
    expect(instanceTunnelToken()).toBeUndefined();
  });
});
