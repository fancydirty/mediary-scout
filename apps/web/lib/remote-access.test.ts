import { afterEach, describe, expect, it, vi } from "vitest";
import {
  instanceTunnelToken,
  resolveRemoteAccessState,
  scoutConnectBaseUrl,
  accountPasswordHref,
  isWaitlistOpen,
  type RemoteAccessState,
} from "./remote-access";

// 只按 key 保存/还原本套件真正会改的两个变量。**不能**整体替换
// `process.env`：那会换掉对象本体，任何在此之前拿到过旧引用的模块（含先加载的
// 测试文件）会继续读一个已经不再更新的快照。
const prevScoutConnectUrl = process.env.SCOUT_CONNECT_URL;
const prevTunnelToken = process.env.TUNNEL_TOKEN;

afterEach(() => {
  // 原值为 undefined 时必须删除而非跳过，否则本套件设的值会泄漏给后续测试文件
  if (prevScoutConnectUrl !== undefined) {
    process.env.SCOUT_CONNECT_URL = prevScoutConnectUrl;
  } else {
    delete process.env.SCOUT_CONNECT_URL;
  }
  if (prevTunnelToken !== undefined) {
    process.env.TUNNEL_TOKEN = prevTunnelToken;
  } else {
    delete process.env.TUNNEL_TOKEN;
  }
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

describe("scoutConnectBaseUrl（心跳与 waitlist 表单的唯一来源）", () => {
  it("误配的 SCOUT_CONNECT_URL 回落默认，绝不退化成同源相对路径", () => {
    // 仅 trim + 去尾斜杠的话，这些输入会变成空串或相对 URL，
    // 心跳就静默打到实例自己身上，症状还只是「显示降级」，极难排查。
    for (const bad of ["/", "////", "mediaryconnect.app", "://nope", "ftp://x.com"]) {
      process.env.SCOUT_CONNECT_URL = bad;
      const base = scoutConnectBaseUrl();
      expect(base).toBe("https://mediaryconnect.app");
      expect(`${base}/api/instance/status`.startsWith("https://")).toBe(true);
    }
  });

  it("默认生产域名；SCOUT_CONNECT_URL 可覆盖；去掉尾部斜杠", () => {
    delete process.env.SCOUT_CONNECT_URL;
    expect(scoutConnectBaseUrl()).toBe("https://mediaryconnect.app");
    process.env.SCOUT_CONNECT_URL = "https://staging.example.com/";
    expect(scoutConnectBaseUrl()).toBe("https://staging.example.com");
    process.env.SCOUT_CONNECT_URL = "  https://staging.example.com///  ";
    expect(scoutConnectBaseUrl()).toBe("https://staging.example.com");
  });

  it("心跳打的就是 scoutConnectBaseUrl —— 否则预发的报名会写进生产队列", async () => {
    process.env.SCOUT_CONNECT_URL = "https://staging.example.com";
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await resolveRemoteAccessState({ token: "tok" });
    // 表单拿的是同一个函数的返回值（见 remote-access-section.tsx 的透传），
    // 所以只要这里对得上，两条路径就不会分叉。
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `${scoutConnectBaseUrl()}/api/instance/status`,
    );
  });
});

describe("accountPasswordHref（保留 ?w 工作区上下文）", () => {
  it("无 w → 基础链接；有 w → 带上且仍以 #password 收尾", () => {
    expect(accountPasswordHref()).toBe("/settings?tab=account#password");
    const withW = accountPasswordHref("cs_abc");
    expect(withW).toContain("w=cs_abc");
    expect(withW).toContain("tab=account");
    expect(withW.endsWith("#password")).toBe(true);
  });

  it("需要转义的值被正确编码（否则会截断或注入参数）", () => {
    const href = accountPasswordHref("cs_a b&c");
    expect(href).toContain("w=cs_a+b%26c");
    expect(href.endsWith("#password")).toBe(true);
  });
});

describe("isWaitlistOpen（默认关闭的发布开关）", () => {
  it("未设 / 空 / 非 \"1\" → 关闭；只有 \"1\" 才开", () => {
    delete process.env.MEDIA_TRACK_WAITLIST_OPEN;
    expect(isWaitlistOpen()).toBe(false);
    for (const v of ["", "  ", "0", "true", "yes", "on"]) {
      process.env.MEDIA_TRACK_WAITLIST_OPEN = v;
      expect(isWaitlistOpen()).toBe(false);
    }
    process.env.MEDIA_TRACK_WAITLIST_OPEN = "1";
    expect(isWaitlistOpen()).toBe(true);
    process.env.MEDIA_TRACK_WAITLIST_OPEN = "  1  ";
    expect(isWaitlistOpen()).toBe(true);
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
