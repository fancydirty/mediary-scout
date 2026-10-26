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

// Cookies are bearer credentials. The redemption chain is followed manually, so
// these two behaviours are ours to guarantee — both were flagged by review.
describe("exchangeCookie — redirect confinement and cookie deletion", () => {
  function hop(status: number, setCookie: string[], location: string | null) {
    return {
      status,
      headers: {
        getSetCookie: () => setCookie,
        get: (n: string) => (n.toLowerCase() === "location" ? location : null),
      },
    };
  }

  it("refuses to send the jar off the brand's hosts", async () => {
    const seen: Array<string | undefined> = [];
    const client = new QuarkQrLoginClient({
      rawFetch: async (_url, init) => {
        seen.push(init.headers?.["Cookie"]);
        // First hop sets a good cookie, then redirects to an attacker host.
        return hop(302, ["__pus=PUS1; Path=/", "__uid=AARtUID; Path=/"], "https://evil.example.com/steal");
      },
    });
    await expect(client.exchangeCookie("ST")).rejects.toThrow(/left 夸克 hosts .*evil\.example\.com/);
    // The jar never reached the foreign host: only the FIRST hop was fetched.
    expect(seen).toHaveLength(1);
  });

  it("allows a subdomain of an allowed host but not lookalikes", async () => {
    const ok = new QuarkQrLoginClient({
      rawFetch: async (url) => {
        if (url.includes("passport.quark.cn")) {
          return hop(200, ["__pus=PUS1; Path=/", "__uid=AARtUID; Path=/"], null);
        }
        return hop(302, [], "https://passport.quark.cn/x");
      },
    });
    await expect(ok.exchangeCookie("ST")).resolves.toMatchObject({ providerUid: "AARtUID" });

    const bad = new QuarkQrLoginClient({
      rawFetch: async () => hop(302, [], "https://evilquark.cn/x"),
    });
    await expect(bad.exchangeCookie("ST")).rejects.toThrow(/left/);
  });

  it("treats an epoch-expiry empty cookie as a delete (what UC really sends for a spent ticket)", async () => {
    const client = new QuarkQrLoginClient({
      rawFetch: async () =>
        hop(
          200,
          [
            // Good value first, then the deletion signal UC returns for a used ticket.
            "__uid=AARtUID; Path=/",
            "__pus=; Path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; domain=.uc.cn",
          ],
          null,
        ),
    });
    await expect(client.exchangeCookie("ST")).rejects.toThrow(/QUARK_QR_EXCHANGE_FAILED/);
  });

  it("does not let a bare empty value clobber a good cookie from an earlier hop", async () => {
    const hops = [
      hop(302, ["__pus=PUS1; Path=/", "__uid=AARtUID; Path=/"], "https://pan.quark.cn/next"),
      // No expiry marker: an ordinary empty attr, NOT a deletion. Must not wipe.
      hop(200, ["__pus=; Path=/"], null),
    ];
    let i = 0;
    const client = new QuarkQrLoginClient({ rawFetch: async () => hops[i++]! });
    const out = await client.exchangeCookie("ST");
    expect(out.cookie).toContain("__pus=PUS1");
  });
});

describe("isDeletion edge cases (malformed attributes must not delete)", () => {
  function hop(setCookie: string[]) {
    return {
      status: 200,
      headers: {
        getSetCookie: () => setCookie,
        get: () => null,
      },
    };
  }

  it.each(["Max-Age", "Max-Age=", "max-age=  "])(
    "an empty %s attribute does not delete a live cookie",
    async (attr) => {
      const client = new QuarkQrLoginClient({
        rawFetch: async () => hop(["__pus=PUS1; Path=/", "__uid=AARtUID; Path=/", `__pus=; ${attr}`]),
      });
      // `Number("")` is 0 — without the guard this reads as "delete" and the
      // jar loses __pus, turning a valid scan into EXCHANGE_FAILED.
      const out = await client.exchangeCookie("ST");
      expect(out.cookie).toContain("__pus=PUS1");
    },
  );

  it("still honours a real max-age=0 deletion", async () => {
    const client = new QuarkQrLoginClient({
      rawFetch: async () => hop(["__pus=PUS1; Path=/", "__uid=AARtUID; Path=/", "__pus=; Max-Age=0"]),
    });
    await expect(client.exchangeCookie("ST")).rejects.toThrow(/QUARK_QR_EXCHANGE_FAILED/);
  });
});

describe("redirect allowlist — protocol and host confusion", () => {
  function hop(location: string) {
    return {
      status: 302,
      headers: {
        getSetCookie: () => [] as string[],
        get: (n: string) => (n.toLowerCase() === "location" ? location : null),
      },
    };
  }

  it.each([
    ["http://pan.quark.cn/x", "plain-HTTP downgrade would leak the cookie in clear"],
    ["javascript://pan.quark.cn/%0a", "non-HTTP scheme"],
    ["//evil.com/x", "protocol-relative resolves off-host"],
    ["https://quark.cn.evil.com/x", "suffix confusion"],
    ["https://evilquark.cn/x", "prefix confusion"],
  ])("refuses %s (%s)", async (location) => {
    const client = new QuarkQrLoginClient({ rawFetch: async () => hop(location) });
    await expect(client.exchangeCookie("ST")).rejects.toThrow(/left 夸克 hosts/);
  });
});

describe("isDeletion — a past (non-epoch) expiry also clears", () => {
  function hop(setCookie: string[]) {
    return { status: 200, headers: { getSetCookie: () => setCookie, get: () => null } };
  }

  it("deletes on an already-past expiry that is not the epoch", async () => {
    // Servers clear with any past date, not only 1970. Only watching for the
    // epoch would leave the stale cookie in the jar.
    const client = new QuarkQrLoginClient({
      rawFetch: async () =>
        hop(["__pus=PUS1; Path=/", "__uid=AARtUID; Path=/", "__pus=; Expires=Wed, 01 Jan 2025 00:00:00 GMT"]),
    });
    await expect(client.exchangeCookie("ST")).rejects.toThrow(/QUARK_QR_EXCHANGE_FAILED/);
  });

  it("does NOT delete on a future expiry with an empty value", async () => {
    const future = new Date(Date.now() + 86_400_000).toUTCString();
    const client = new QuarkQrLoginClient({
      rawFetch: async () => hop(["__pus=PUS1; Path=/", "__uid=AARtUID; Path=/", `__pus=; Expires=${future}`]),
    });
    const out = await client.exchangeCookie("ST");
    expect(out.cookie).toContain("__pus=PUS1");
  });
});
