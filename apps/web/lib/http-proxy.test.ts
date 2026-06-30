import { describe, expect, it, vi } from "vitest";
import { configureHttpProxyFromEnv } from "./http-proxy";

describe("configureHttpProxyFromEnv — opt-in proxy for outbound fetch (undici ignores HTTP_PROXY by default)", () => {
  it("installs an EnvHttpProxyAgent dispatcher when HTTP_PROXY is set", () => {
    const setDispatcher = vi.fn();
    const agent = { kind: "agent" } as unknown as import("undici").Dispatcher;
    const makeAgent = vi.fn(() => agent);

    const result = configureHttpProxyFromEnv(
      { HTTP_PROXY: "http://172.17.0.1:7890" },
      { setDispatcher, makeAgent },
    );

    expect(makeAgent).toHaveBeenCalledTimes(1);
    expect(setDispatcher).toHaveBeenCalledWith(agent);
    expect(result.enabled).toBe(true);
    expect(result.proxyUrl).toBe("http://172.17.0.1:7890");
  });

  it("honors HTTPS_PROXY and the lowercase variants", () => {
    for (const key of ["HTTPS_PROXY", "http_proxy", "https_proxy"]) {
      const setDispatcher = vi.fn();
      const result = configureHttpProxyFromEnv(
        { [key]: "http://proxy:8080" },
        { setDispatcher, makeAgent: () => ({}) as unknown as import("undici").Dispatcher },
      );
      expect(result.enabled, key).toBe(true);
      expect(setDispatcher, key).toHaveBeenCalledOnce();
    }
  });

  it("does NOTHING when no proxy env var is set (zero impact on the default direct-fetch path)", () => {
    const setDispatcher = vi.fn();
    const makeAgent = vi.fn();

    const result = configureHttpProxyFromEnv({}, { setDispatcher, makeAgent });

    expect(makeAgent).not.toHaveBeenCalled();
    expect(setDispatcher).not.toHaveBeenCalled();
    expect(result.enabled).toBe(false);
  });

  it("ignores a blank/whitespace-only proxy value (treats it as unset)", () => {
    const setDispatcher = vi.fn();
    const result = configureHttpProxyFromEnv(
      { HTTP_PROXY: "   " },
      { setDispatcher, makeAgent: () => ({}) as unknown as import("undici").Dispatcher },
    );
    expect(result.enabled).toBe(false);
    expect(setDispatcher).not.toHaveBeenCalled();
  });
});
