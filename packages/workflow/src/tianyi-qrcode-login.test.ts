import { describe, it, expect, vi } from "vitest";
import type {
  TianyiQrSession,
  TianyiQrStatus,
  TianyiQrFetchJson,
  TianyiQrRawFetch,
  TianyiQrRequestInit,
} from "./tianyi-qrcode-login.js";
import { TianyiQrLoginClient } from "./tianyi-qrcode-login.js";

/** A minimal QR session with all phase-machine fields populated. */
function sessionFixture(): TianyiQrSession {
  return {
    uuid: "U",
    encryuuid: "E",
    paramId: "P",
    reqId: "R",
    lt: "L",
    appId: "8025431004",
    clientType: "10020",
    returnUrl: "",
    qrcodeContent: "",
  };
}

// ── pollStatus: THE v1-critical piece (the plan locks this 4-state mapping) ────
describe("TianyiQrLoginClient.pollStatus (v1-critical 4-state mapping)", () => {
  const cases: Array<[number, TianyiQrStatus]> = [
    [-106, "waiting"],
    [-11002, "scanned"],
    [0, "confirmed"],
    [-11001, "expired"],
  ];
  for (const [code, phase] of cases) {
    it(`maps qrcodeLoginState status ${code} → ${phase}`, async () => {
      const fetchJson = vi.fn<TianyiQrFetchJson>(async () => ({
        status: code,
        redirectUrl: code === 0 ? "https://cloud.189.cn/api/portal/loginUrl.action?redirectURL=x" : "",
      }));
      const c = new TianyiQrLoginClient({ fetchJson });
      const r = await c.pollStatus({
        uuid: "U",
        encryuuid: "E",
        paramId: "P",
        reqId: "R",
        lt: "L",
        appId: "8025431004",
        clientType: "10020",
        returnUrl: "",
      });
      expect(r.status).toBe(phase);
    });
  }

  it("carries redirectUrl through on confirmed (needed to exchange the session)", async () => {
    const fetchJson = vi.fn<TianyiQrFetchJson>(async () => ({ status: 0, redirectUrl: "https://cloud.189.cn/grant" }));
    const c = new TianyiQrLoginClient({ fetchJson });
    const r = await c.pollStatus(sessionFixture());
    expect(r.status).toBe("confirmed");
    expect(r.redirectUrl).toBe("https://cloud.189.cn/grant");
  });

  it("treats an unknown status code as still-waiting (never a false-confirm)", async () => {
    const fetchJson = vi.fn<TianyiQrFetchJson>(async () => ({ status: -999 }));
    const c = new TianyiQrLoginClient({ fetchJson });
    expect((await c.pollStatus(sessionFixture())).status).toBe("waiting");
  });

  it("POSTs qrcodeLoginState.do with the exact form fields + Referer/Reqid/lt headers", async () => {
    let seenUrl = "";
    let seenInit: TianyiQrRequestInit | undefined;
    const fetchJson = vi.fn<TianyiQrFetchJson>(async (url: string, init: TianyiQrRequestInit) => {
      seenUrl = url;
      seenInit = init;
      return { status: -106 };
    });
    const c = new TianyiQrLoginClient({ fetchJson });
    await c.pollStatus({
      uuid: "UU",
      encryuuid: "EE",
      paramId: "PP",
      reqId: "RR",
      lt: "LL",
      appId: "8025431004",
      clientType: "10020",
      returnUrl: "https://ret",
    });
    expect(seenUrl).toContain("/api/logbox/oauth2/qrcodeLoginState.do");
    const form = new URLSearchParams(seenInit?.body ?? "");
    expect(form.get("uuid")).toBe("UU");
    expect(form.get("encryuuid")).toBe("EE");
    expect(form.get("paramId")).toBe("PP");
    expect(form.get("appId")).toBe("8025431004");
    expect(form.get("clientType")).toBe("10020");
    expect(form.get("returnUrl")).toBe("https://ret");
    // date format YYYY-MM-DDHH:mm:ss.SSS — day and time with NO separator (spec §登录).
    expect(form.get("date")).toMatch(/^\d{4}-\d{2}-\d{2}\d{2}:\d{2}:\d{2}\.\d{3}$/);
    expect(form.get("timeStamp")).toMatch(/^\d+$/);
    expect(seenInit?.headers?.Reqid).toBe("RR");
    expect(seenInit?.headers?.lt).toBe("LL");
    expect(seenInit?.headers?.Referer).toContain("open.e.189.cn");
  });
});

// ── getQrSession: unifyLoginForPC (HTML regex) → getUUID → qrcodeContent ───────
describe("TianyiQrLoginClient.getQrSession (unifyLoginForPC → getUUID)", () => {
  it("parses lt/reqId/paramId, gets a uuid, builds the qrClinentLogin QR content", async () => {
    const rawUrls: string[] = [];
    const rawFetch = vi.fn<TianyiQrRawFetch>(async (url: string) => {
      rawUrls.push(url);
      return {
        status: 200,
        text: `<html><script>var lt = "LT_TOKEN"; var reqId = "REQ_1"; var paramId = "PARAM_9";</script></html>`,
        headers: { get: () => null },
      };
    });
    const jsonUrls: string[] = [];
    const fetchJson = vi.fn<TianyiQrFetchJson>(async (url: string, init: TianyiQrRequestInit) => {
      jsonUrls.push(url);
      expect(init.headers?.Reqid).toBe("REQ_1");
      expect(init.headers?.lt).toBe("LT_TOKEN");
      return { result: "0", uuid: "UUID_ABC", encryuuid: "ENCRY_XYZ" };
    });
    const c = new TianyiQrLoginClient({ fetchJson, rawFetch });
    const s = await c.getQrSession();
    expect(rawUrls[0]).toContain("/api/portal/unifyLoginForPC.action");
    expect(rawUrls[0]).toContain("appId=8025431004");
    expect(jsonUrls[0]).toContain("/api/logbox/oauth2/getUUID.do");
    expect(s.uuid).toBe("UUID_ABC");
    expect(s.encryuuid).toBe("ENCRY_XYZ");
    expect(s.lt).toBe("LT_TOKEN");
    expect(s.reqId).toBe("REQ_1");
    expect(s.paramId).toBe("PARAM_9");
    expect(s.appId).toBe("8025431004");
    expect(s.clientType).toBe("10020");
    expect(s.qrcodeContent).toBe(
      "https://open.e.189.cn/api/account/qrClinentLogin.do?paras=new_uuid=UUID_ABC|8025431004",
    );
  });

  it("also accepts JSON-shaped login params (\"lt\":\"..\") from the page body", async () => {
    const rawFetch = vi.fn<TianyiQrRawFetch>(async () => ({
      status: 200,
      text: `{"lt":"JLT","reqId":"JRQ","paramId":"JPM"}`,
      headers: { get: () => null },
    }));
    const fetchJson = vi.fn<TianyiQrFetchJson>(async () => ({ uuid: "JU", encryuuid: "JE" }));
    const c = new TianyiQrLoginClient({ fetchJson, rawFetch });
    const s = await c.getQrSession();
    expect(s.lt).toBe("JLT");
    expect(s.paramId).toBe("JPM");
    expect(s.uuid).toBe("JU");
  });

  it("throws if the login page carries no lt/paramId (unexpected page)", async () => {
    const rawFetch = vi.fn<TianyiQrRawFetch>(async () => ({
      status: 200,
      text: "<html>nope</html>",
      headers: { get: () => null },
    }));
    const fetchJson = vi.fn<TianyiQrFetchJson>(async () => ({}));
    const c = new TianyiQrLoginClient({ fetchJson, rawFetch });
    await expect(c.getQrSession()).rejects.toThrow(/TIANYI_QR_INIT_FAILED/);
  });

  it("throws if getUUID.do returns no uuid", async () => {
    const rawFetch = vi.fn<TianyiQrRawFetch>(async () => ({
      status: 200,
      text: `lt = "L"; reqId = "R"; paramId = "P";`,
      headers: { get: () => null },
    }));
    const fetchJson = vi.fn<TianyiQrFetchJson>(async () => ({ result: "-1" }));
    const c = new TianyiQrLoginClient({ fetchJson, rawFetch });
    await expect(c.getQrSession()).rejects.toThrow(/TIANYI_QR_UUID_FAILED/);
  });
});

// ── exchangeSession: getSessionForPC(redirectURL) → 7-field TianyiSession ──────
describe("TianyiQrLoginClient.exchangeSession (getSessionForPC)", () => {
  it("calls getSessionForPC with redirectURL + fixed PC params, returns the 7-field session", async () => {
    let seenUrl = "";
    const fetchJson = vi.fn<TianyiQrFetchJson>(async (url: string) => {
      seenUrl = url;
      return {
        res_code: 0,
        sessionKey: "SK-36",
        sessionSecret: "SS-32",
        accessToken: "AT-32",
        refreshToken: "RT-32",
        familySessionKey: "FSK-43",
        familySessionSecret: "FSS-32",
        loginName: "13800138000",
        keepAlive: 1,
      };
    });
    const c = new TianyiQrLoginClient({ fetchJson });
    const session = await c.exchangeSession(
      sessionFixture(),
      "https://cloud.189.cn/api/portal/loginUrl.action?redirectURL=deep",
    );
    expect(seenUrl).toContain("api.cloud.189.cn/getSessionForPC.action");
    expect(seenUrl).toContain("appId=8025431004");
    expect(seenUrl).toContain("clientType=TELEPC");
    expect(seenUrl).toContain("channelId=web_cloud.189.cn");
    expect(seenUrl).toContain("redirectURL=");
    // One login yields BOTH personal + family credentials (spec §session 字段).
    expect(session).toEqual({
      sessionKey: "SK-36",
      sessionSecret: "SS-32",
      accessToken: "AT-32",
      refreshToken: "RT-32",
      familySessionKey: "FSK-43",
      familySessionSecret: "FSS-32",
      loginName: "13800138000",
    });
  });

  it("throws when getSessionForPC returns no sessionKey (login expired)", async () => {
    const fetchJson = vi.fn<TianyiQrFetchJson>(async () => ({ res_code: -1, res_message: "login expired" }));
    const c = new TianyiQrLoginClient({ fetchJson });
    await expect(c.exchangeSession(sessionFixture(), "https://x")).rejects.toThrow(
      /TIANYI_SESSION_EXCHANGE_FAILED/,
    );
  });
});

// ── loginBySson: SSON cookie fallback (reference-derived, shape-level test) ────
describe("TianyiQrLoginClient.loginBySson (SSON fallback — reference-derived)", () => {
  it("does unifyLoginForPC → loginBySsoCooike(with SSON cookie) → getSessionForPC", async () => {
    const rawUrls: string[] = [];
    const cookies: Array<string | undefined> = [];
    const rawFetch = vi.fn<TianyiQrRawFetch>(async (url: string, init: TianyiQrRequestInit) => {
      rawUrls.push(url);
      if (url.includes("unifyLoginForPC")) {
        return { status: 200, text: `lt = "LT1"; reqId = "RQ1"; paramId = "PM1";`, headers: { get: () => null } };
      }
      cookies.push(init.headers?.Cookie);
      return {
        status: 200,
        text: JSON.stringify({
          result: 0,
          toUrl: "https://cloud.189.cn/api/portal/loginUrl.action?redirectURL=grant",
        }),
        headers: { get: () => null },
      };
    });
    const jsonUrls: string[] = [];
    const fetchJson = vi.fn<TianyiQrFetchJson>(async (url: string) => {
      jsonUrls.push(url);
      return {
        res_code: 0,
        sessionKey: "SK",
        sessionSecret: "SS",
        accessToken: "AT",
        refreshToken: "RT",
        familySessionKey: "FSK",
        familySessionSecret: "FSS",
        loginName: "LOGIN",
      };
    });
    const c = new TianyiQrLoginClient({ fetchJson, rawFetch });
    const session = await c.loginBySson("MY_SSON_COOKIE");
    expect(rawUrls.some((u) => u.includes("unifyLoginForPC"))).toBe(true);
    expect(rawUrls.some((u) => u.includes("loginBySsoCooike"))).toBe(true);
    expect(cookies).toContain("SSON=MY_SSON_COOKIE");
    expect(jsonUrls.some((u) => u.includes("getSessionForPC"))).toBe(true);
    expect(session.sessionKey).toBe("SK");
    expect(session.loginName).toBe("LOGIN");
  });

  it("rejects an empty SSON before touching the network", async () => {
    const rawFetch = vi.fn<TianyiQrRawFetch>(async () => ({ status: 200, text: "", headers: { get: () => null } }));
    const fetchJson = vi.fn<TianyiQrFetchJson>(async () => ({}));
    const c = new TianyiQrLoginClient({ fetchJson, rawFetch });
    await expect(c.loginBySson("  ")).rejects.toThrow(/TIANYI_SSON_LOGIN_FAILED/);
    expect(rawFetch).not.toHaveBeenCalled();
  });

  it("throws when loginBySsoCooike yields no redirect (bad/expired SSON)", async () => {
    const rawFetch = vi.fn<TianyiQrRawFetch>(async (url: string) => {
      if (url.includes("unifyLoginForPC")) {
        return { status: 200, text: `lt = "L"; reqId = "R"; paramId = "P";`, headers: { get: () => null } };
      }
      return { status: 200, text: JSON.stringify({ result: -1, msg: "SSON invalid" }), headers: { get: () => null } };
    });
    const fetchJson = vi.fn<TianyiQrFetchJson>(async () => ({}));
    const c = new TianyiQrLoginClient({ fetchJson, rawFetch });
    await expect(c.loginBySson("BAD")).rejects.toThrow(/TIANYI_SSON_LOGIN_FAILED/);
  });
});
