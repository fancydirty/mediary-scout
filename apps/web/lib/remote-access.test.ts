import { afterEach, describe, expect, it, vi } from "vitest";
import {
  instanceTunnelToken,
  instanceConnectHostname,
  resolveRemoteAccessState,
  scoutConnectBaseUrl,
  accountPasswordHref,
  CONNECT_SITE_URL,
  consoleUrl,
  type RemoteAccessState,
  requestConnectLogin,
} from "./remote-access";

// 只按 key 保存/还原本套件真正会改的两个变量。**不能**整体替换
// `process.env`：那会换掉对象本体，任何在此之前拿到过旧引用的模块（含先加载的
// 测试文件）会继续读一个已经不再更新的快照。
const prevScoutConnectUrl = process.env.SCOUT_CONNECT_URL;
const prevTunnelToken = process.env.TUNNEL_TOKEN;
const prevConnectHostname = process.env.MEDIARY_CONNECT_HOSTNAME;

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
  if (prevConnectHostname !== undefined) {
    process.env.MEDIARY_CONNECT_HOSTNAME = prevConnectHostname;
  } else {
    delete process.env.MEDIARY_CONNECT_HOSTNAME;
  }
  vi.unstubAllGlobals();
});

describe("resolveRemoteAccessState", () => {
  it("无 TUNNEL_TOKEN → not_provisioned，且**不发心跳**", async () => {
    const sendHeartbeat = vi.fn(async () => "ok" as const);
    const state = await resolveRemoteAccessState({ token: undefined, sendHeartbeat });
    expect(state).toEqual({ kind: "not_provisioned" });
    // 没 token 就没身份可报——发了只会向 worker 暴露一台未开通实例的存在。
    expect(sendHeartbeat).not.toHaveBeenCalled();
  });

  it("空串 / 纯空白 token 视同未开通（.env 里 TUNNEL_TOKEN= 就是这形状）", async () => {
    const sendHeartbeat = vi.fn(async () => "ok" as const);
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
      sendHeartbeat: async () => "ok",
    });
    expect(state).toEqual({ kind: "active", hostname: null });
  });

  it("调用方能提供本地已知 hostname 时透传", async () => {
    const state = await resolveRemoteAccessState({
      token: "tok",
      hostname: "s1.mediaryconnect.app",
      sendHeartbeat: async () => "ok",
    });
    expect(state).toEqual({ kind: "active", hostname: "s1.mediaryconnect.app" });
  });

  it("心跳 401（token 不是我们发的，比如作者自带的旧隧道）→ not_provisioned，露出报名入口", async () => {
    // 关键修复:有 TUNNEL_TOKEN 但 worker 不认(401)= 不是 Mediary Connect 开通的,
    // 应显示未开通 + 报名入口,而不是「已开通但状态未知」。
    const state = await resolveRemoteAccessState({
      token: "someone-elses-tunnel-token",
      sendHeartbeat: async () => "unauthorized",
    });
    expect(state).toEqual({ kind: "not_provisioned" });
  });

  it("心跳网络失败（超时/5xx，非 401）→ active_degraded,不劝退已开通用户重排队", async () => {
    const state = await resolveRemoteAccessState({
      token: "tok",
      sendHeartbeat: async () => "unreachable",
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
    // 抛错按不可达处理（degraded），不当成 401——网络炸了不该劝用户重排队。
    expect(state).toEqual({ kind: "active_degraded" });
  });

  it("token 绝不出现在返回的 state 里（这东西会被序列化进 RSC 载荷）", async () => {
    const token = "super-secret-connector-token";
    const states: RemoteAccessState[] = [
      await resolveRemoteAccessState({ token, sendHeartbeat: async () => "ok" }),
      await resolveRemoteAccessState({ token, sendHeartbeat: async () => "unreachable" }),
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

  it("默认心跳：401（worker 不认这个 token）→ not_provisioned，露出报名入口", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })));
    expect(await resolveRemoteAccessState({ token: "not-ours" })).toEqual({ kind: "not_provisioned" });
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

describe("CONNECT_SITE_URL（设置页跳转链接的唯一来源）", () => {
  it("指向 apex 而非已退役的 beta 子域", () => {
    // 内测报名页已退役(301 到 apex):apex 现在有完整的登录+购买路径,
    // 用户不需要先「报名内测」再等邀请。这条钉住别再指回 beta.*。
    expect(CONNECT_SITE_URL).toBe("https://mediaryconnect.app");
    expect(CONNECT_SITE_URL).not.toContain("beta.");
    expect(CONNECT_SITE_URL.endsWith("/")).toBe(false);
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

describe("instanceConnectHostname（connect.sh 写进 .env 的本地域名来源）", () => {
  it("正常值 → 返回小写 hostname", () => {
    process.env.MEDIARY_CONNECT_HOSTNAME = "dirtyfancy.mediaryconnect.app";
    expect(instanceConnectHostname()).toBe("dirtyfancy.mediaryconnect.app");
  });

  it("带空白/大写 → normalize", () => {
    process.env.MEDIARY_CONNECT_HOSTNAME = "  Dirtyfancy.MediaryConnect.App  ";
    expect(instanceConnectHostname()).toBe("dirtyfancy.mediaryconnect.app");
  });

  it("缺失/空串 → null（早期接入的实例没有这行，UI 回落到不给链接）", () => {
    delete process.env.MEDIARY_CONNECT_HOSTNAME;
    expect(instanceConnectHostname()).toBeNull();
    process.env.MEDIARY_CONNECT_HOSTNAME = "   ";
    expect(instanceConnectHostname()).toBeNull();
  });

  it("畸形值一律 null——绝不把怪东西拼进 href", () => {
    for (const bad of [
      "https://x.example.com",       // 带协议
      "x.example.com/path",          // 带路径
      "localhost",                   // 无 TLD
      "no dots",                     // 空格
      "-bad.example.com",            // 以连字符开头
      'x.example.com" onload="evil', // 引号注入
      "a..b.example.com",            // 连续点(宽松正则会放过)
      "bad-.example.com",            // label 以连字符结尾(宽松正则会放过)
      "a.b.example.c",               // TLD 只有 1 位
      ".example.com",                // 以点开头
    ]) {
      process.env.MEDIARY_CONNECT_HOSTNAME = bad;
      expect(instanceConnectHostname(), bad).toBeNull();
    }
  });
});

describe("consoleUrl", () => {
  it("指向控制台登录页（魔法链接入口）", () => {
    expect(consoleUrl()).toBe("https://mediaryconnect.app/login");
  });

  // 不能写死生产域名:本模块的既定设计是 worker base 只有一个来源
  // (scoutConnectBaseUrl)。SCOUT_CONNECT_URL 指向预发/自建 worker 时,若控制台
  // 链接仍钉在生产,用户会被从预发实例送去生产控制台——那里没有他这台机器的
  // 记录,看起来就是「开通了但控制台查不到」。
  it("跟随 SCOUT_CONNECT_URL（预发/自建 worker 不会被送去生产控制台）", () => {
    process.env.SCOUT_CONNECT_URL = "https://connect.test";
    expect(consoleUrl()).toBe("https://connect.test/login");
  });

  it("SCOUT_CONNECT_URL 误配（漏协议/只有斜杠）时回落生产,不产出相对路径", () => {
    process.env.SCOUT_CONNECT_URL = "mediaryconnect.app";
    expect(consoleUrl()).toBe("https://mediaryconnect.app/login");
    process.env.SCOUT_CONNECT_URL = "///";
    expect(consoleUrl()).toBe("https://mediaryconnect.app/login");
  });
});

describe("requestConnectLogin(设置页内发起 Connect 登录)", () => {
  const ok202 = () => new Response(null, { status: 202 });

  it("202 → ok,提示里带上邮箱", async () => {
    const r = await requestConnectLogin("a@b.com", (async () => ok202()) as typeof fetch);
    expect(r.ok).toBe(true);
    expect(r.message).toContain("a@b.com");
  });

  it("邮箱形状不对时不发请求(省一次跨网往返)", async () => {
    let called = 0;
    const spy = (async () => { called += 1; return ok202(); }) as typeof fetch;
    for (const bad of ["", "  ", "nope", "x".repeat(300)]) {
      const r = await requestConnectLogin(bad, spy);
      expect(r.ok).toBe(false);
    }
    expect(called).toBe(0);
  });

  it("429 给可操作的话,不说「稍后重试」", async () => {
    const r = await requestConnectLogin("a@b.com", (async () =>
      new Response("{}", { status: 429 })) as typeof fetch);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("过几分钟");
  });

  // 实例可能装在没有外网的内网里 —— 这个失败要说清是「连不上外网」,
  // 而不是含糊的「失败了」,否则用户会去查邮箱地址。
  it("网络异常 → 提示检查外网连通性", async () => {
    const r = await requestConnectLogin("a@b.com", (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("外网");
  });

  it("打的是 worker 的 /api/auth/magic,body 只有 email", async () => {
    let seen: { url: string; body: unknown } | null = null;
    await requestConnectLogin("a@b.com", (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), body: JSON.parse(String(init?.body)) };
      return ok202();
    }) as unknown as typeof fetch);
    expect(seen!.url).toContain("/api/auth/magic");
    expect(seen!.body).toEqual({ email: "a@b.com" });
  });
});

// 组件层的异常路径:项目没有 React 渲染测试基建(无 @testing-library),
// 不为一条 catch 引入不成比例的依赖 —— 改用源码断言钉住它。
// 这条测的是「server action throw 时用户能看到提示」,而那正是
// 单元测试覆盖不到、只能靠代码结构保证的部分。
describe("ConnectLoginForm 的异常处理(源码断言)", () => {
  it("startTransition 里 catch 了 server action 的异常", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../components/settings/connect-login-form.tsx", import.meta.url),
      "utf8",
    );
    // action 会 throw:demo 门禁(DemoReadOnlyError)、Next 运行时错误、
    // 部署不一致导致 action 找不到。不 catch 的话界面上什么都不会变。
    expect(src).toContain("try {");
    expect(src).toContain("} catch {");
    expect(src).toMatch(/catch\s*\{[^}]*setMsg\(/);
  });

  // Copilot round-3:role="status" 是 polite —— 失败时屏幕阅读器可能等到
  // 下一次停顿才读,视障用户会以为提交成功了。失败原因(邮箱错/限流/
  // 连不上外网)都是必须**立即**知道并据此改操作的东西,要用 assertive。
  it("反馈按成败切换 role(成功 status / 失败 alert)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../components/settings/connect-login-form.tsx", import.meta.url),
      "utf8",
    );
    expect(src).toContain('role={msg.ok ? "status" : "alert"}');
    // 别退回固定 status
    expect(src).not.toContain('role="status"');
  });

  // Copilot round-4:required 让浏览器在空提交时**本地**拦住,
  // 不白跑一次 server action 才提示;name 让自动填充认得出邮箱字段。
  it("邮箱输入框有 name 与 required", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../components/settings/connect-login-form.tsx", import.meta.url),
      "utf8",
    );
    expect(src).toContain('name="email"');
    expect(src).toMatch(/\n\s+required\n/);
  });
});
