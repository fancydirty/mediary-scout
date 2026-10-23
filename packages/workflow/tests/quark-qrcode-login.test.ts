import { describe, expect, it } from "vitest";
import { QuarkQrLoginClient, UC_QR_PROFILE } from "../src/index.js";

describe("QuarkQrLoginClient", () => {
  it("getToken returns token + a su.quark.cn qrcode URL", async () => {
    const client = new QuarkQrLoginClient({
      fetchJson: async (url) => {
        expect(url).toContain("uop.quark.cn/cas/ajax/getTokenForQrcodeLogin");
        expect(url).toContain("client_id=532");
        return { status: 2000000, data: { members: { token: "TK123" } } };
      },
    });
    const s = await client.getToken();
    expect(s.token).toBe("TK123");
    expect(s.qrcodeContent).toContain("su.quark.cn");
    expect(s.qrcodeContent).toContain("token=TK123");
  });

  it("pollStatus maps confirmed (2000000 + service_ticket)", async () => {
    const client = new QuarkQrLoginClient({
      fetchJson: async (url) => {
        expect(url).toContain("getServiceTicketByQrcodeToken");
        expect(url).toContain("token=TK123");
        return { status: 2000000, message: "ok", data: { members: { service_ticket: "ST999" } } };
      },
    });
    const r = await client.pollStatus({ token: "TK123" });
    expect(r.status).toBe("confirmed");
    expect(r.serviceTicket).toBe("ST999");
  });

  it("pollStatus maps waiting when no ticket yet", async () => {
    const client = new QuarkQrLoginClient({ fetchJson: async () => ({ status: 50004001, message: "wait", data: {} }) });
    expect((await client.pollStatus({ token: "x" })).status).toBe("waiting");
  });

  it("pollStatus maps expired on an expiry message", async () => {
    const client = new QuarkQrLoginClient({ fetchJson: async () => ({ status: 50004002, message: "token expired", data: {} }) });
    expect((await client.pollStatus({ token: "x" })).status).toBe("expired");
  });

  it("exchangeCookie assembles the drive cookie from accumulated Set-Cookie, requires __pus + uid", async () => {
    const hops = [
      {
        status: 302,
        setCookie: ["__pus=PUS1; Path=/; HttpOnly", "__uid=AARtUID; Path=/"],
        location: "https://pan.quark.cn/account/callback?x=1",
      },
      { status: 200, setCookie: ["__kps=KPS1; Path=/", "__ktd=KTD1; Path=/"], location: null },
    ];
    let i = 0;
    const client = new QuarkQrLoginClient({
      rawFetch: async () => {
        const hop = hops[i++]!;
        return {
          status: hop.status,
          headers: {
            getSetCookie: () => hop.setCookie,
            get: (n: string) => (n.toLowerCase() === "location" ? hop.location : null),
          },
        };
      },
    });
    const out = await client.exchangeCookie("ST999");
    expect(out.cookie).toContain("__pus=PUS1");
    expect(out.cookie).toContain("__uid=AARtUID");
    expect(out.cookie).toContain("__kps=KPS1");
    expect(out.providerUid).toBe("AARtUID");
  });

  it("exchangeCookie throws when no __pus arrives", async () => {
    const client = new QuarkQrLoginClient({
      rawFetch: async () => ({
        status: 200,
        headers: { getSetCookie: () => ["foo=bar"], get: () => null },
      }),
    });
    await expect(client.exchangeCookie("ST")).rejects.toThrow(/QUARK_QR_EXCHANGE_FAILED/);
  });
});

describe("UC QR login over the same family client", () => {
  it("getToken hits api.open.uc.cn with client_id=381 and builds the UC QR (1_n0ZCv, NOT 夸克's 4_eMHBJ)", async () => {
    const client = new QuarkQrLoginClient({
      profile: UC_QR_PROFILE,
      fetchJson: async (url) => {
        expect(url).toContain("api.open.uc.cn/cas/ajax/getTokenForQrcodeLogin");
        expect(url).toContain("client_id=381");
        // uop.uc.cn does not resolve — this is the whole reason UC needs a profile.
        expect(url).not.toContain("uop.uc.cn");
        return { status: 2000000, data: { members: { token: "UCTK" } } };
      },
    });
    const s = await client.getToken();
    expect(s.token).toBe("UCTK");
    expect(s.qrcodeContent).toContain("su.uc.cn/1_n0ZCv");
    expect(s.qrcodeContent).toContain("token=UCTK");
    expect(s.qrcodeContent).toContain("client_id=381");
    // Scanning 夸克's QR path on UC would open the 夸克 app and never log into UC.
    expect(s.qrcodeContent).not.toContain("4_eMHBJ");
  });

  it("redeems the ticket at drive.uc.cn/account/info (not pan.quark.cn)", async () => {
    const seen: string[] = [];
    const client = new QuarkQrLoginClient({
      profile: UC_QR_PROFILE,
      rawFetch: async (url) => {
        seen.push(url);
        return {
          status: 200,
          headers: {
            getSetCookie: () => ["__pus=UCPUS; Path=/", "__uid=UCUID123; Path=/"],
            get: () => null,
          },
        };
      },
    });
    const result = await client.exchangeCookie("TICKET1");
    expect(seen[0]).toContain("drive.uc.cn/account/info?st=TICKET1");
    expect(seen[0]).not.toContain("pan.quark.cn");
    expect(result.providerUid).toBe("UCUID123");
    expect(result.cookie).toContain("__pus=UCPUS");
  });

  it("collects UC's own cookie keys (_UP_* / ctoken) that 夸克 does not use", async () => {
    const client = new QuarkQrLoginClient({
      profile: UC_QR_PROFILE,
      rawFetch: async () => ({
        status: 200,
        headers: {
          getSetCookie: () => [
            "__pus=P; Path=/",
            "__uid=U1; Path=/",
            "_UP_A4A_11_=A11; Path=/",
            "_UP_F7E_8D_=F7E; Path=/",
            "ctoken=CT; Path=/",
          ],
          get: () => null,
        },
      }),
    });
    const { cookie } = await client.exchangeCookie("T");
    expect(cookie).toContain("_UP_A4A_11_=A11");
    expect(cookie).toContain("_UP_F7E_8D_=F7E");
    expect(cookie).toContain("ctoken=CT");
  });

  it("uses UC_QR_ error codes so logs name the right brand", async () => {
    const client = new QuarkQrLoginClient({
      profile: UC_QR_PROFILE,
      fetchJson: async () => ({ status: 2000000, data: {} }),
    });
    await expect(client.getToken()).rejects.toThrow(/UC_QR_TOKEN/);
  });

  it("defaults to the 夸克 profile so every pre-UC caller is unchanged", async () => {
    const client = new QuarkQrLoginClient({
      fetchJson: async (url) => {
        expect(url).toContain("uop.quark.cn");
        return { status: 2000000, data: { members: { token: "T" } } };
      },
    });
    const s = await client.getToken();
    expect(s.qrcodeContent).toContain("su.quark.cn");
  });
});
