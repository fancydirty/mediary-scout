import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryWorkflowRepository } from "@media-track/workflow";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

/**
 * The settings actions for the Jev prefilter. The load-bearing behaviour is
 * probe-before-save: a key that cannot reach a live decisions endpoint is never
 * written, so the prefilter cannot end up "enabled" while failing open on every
 * search. The probe module is mocked — these tests touch no network.
 */
const probeMock = vi.fn();

const prevDemo = process.env.MEDIA_TRACK_DEMO_MODE;
const prevMultiUser = process.env.MEDIA_TRACK_MULTI_USER;
// The save action resolves the EFFECTIVE key (account → global → env), so these
// two env vars are part of the fixture and must be isolated per test.
const prevJevKey = process.env.JEV_API_KEY;
const prevJevBaseUrl = process.env.JEV_BASE_URL;

const ACCOUNT_ID = "acct_default";

describe("Jev settings actions", () => {
  let repo: InMemoryWorkflowRepository;
  let actions: typeof import("./actions");
  let rt: typeof import("../lib/workflow-runtime");
  // Imported AFTER vi.resetModules() so the class identity matches the one the
  // freshly-loaded actions module throws (a statically imported copy would not).
  let demo: typeof import("../lib/demo-mode");

  beforeEach(async () => {
    delete process.env.MEDIA_TRACK_DEMO_MODE;
    delete process.env.MEDIA_TRACK_MULTI_USER;
    delete process.env.JEV_API_KEY;
    delete process.env.JEV_BASE_URL;
    probeMock.mockReset();
    repo = new InMemoryWorkflowRepository();
    vi.resetModules();
    vi.doMock("../lib/workflow-runtime", async () => {
      const actual = await vi.importActual<typeof import("../lib/workflow-runtime")>(
        "../lib/workflow-runtime",
      );
      return {
        ...actual,
        getWorkflowRepository: () => repo,
        getCurrentAccountId: async () => ACCOUNT_ID,
      };
    });
    // Only the network call is faked; validateJevBaseUrlFormat is a pure function
    // and stays real, so the action's cheap-check-before-probe order is exercised.
    vi.doMock("../lib/jev-probe", async () => {
      const actual = await vi.importActual<typeof import("../lib/jev-probe")>("../lib/jev-probe");
      return { ...actual, probeJev: probeMock };
    });
    rt = await import("../lib/workflow-runtime");
    demo = await import("../lib/demo-mode");
    actions = await import("./actions");
  });

  afterEach(() => {
    vi.doUnmock("../lib/workflow-runtime");
    vi.doUnmock("../lib/jev-probe");
    vi.resetModules();
    if (prevDemo !== undefined) process.env.MEDIA_TRACK_DEMO_MODE = prevDemo;
    else delete process.env.MEDIA_TRACK_DEMO_MODE;
    if (prevMultiUser !== undefined) process.env.MEDIA_TRACK_MULTI_USER = prevMultiUser;
    else delete process.env.MEDIA_TRACK_MULTI_USER;
    if (prevJevKey !== undefined) process.env.JEV_API_KEY = prevJevKey;
    else delete process.env.JEV_API_KEY;
    if (prevJevBaseUrl !== undefined) process.env.JEV_BASE_URL = prevJevBaseUrl;
    else delete process.env.JEV_BASE_URL;
  });

  describe("saveJevConfigAction", () => {
    it("probes before saving; success writes key/url/health=ok/enabled=1", async () => {
      probeMock.mockResolvedValue({ ok: true, model: "typesafe/jev-1.13" });
      const result = await actions.saveJevConfigAction({
        apiKey: " sk-or-1 ",
        baseUrl: " https://openrouter.ai/api/alpha/decisions ",
      });
      expect(result.success).toBe(true);
      expect(await repo.getAccountSetting(ACCOUNT_ID, rt.JEV_API_KEY_SETTING_KEY)).toBe("sk-or-1");
      expect(await repo.getAccountSetting(ACCOUNT_ID, rt.JEV_BASE_URL_SETTING_KEY)).toBe(
        "https://openrouter.ai/api/alpha/decisions",
      );
      expect(await repo.getAccountSetting(ACCOUNT_ID, rt.JEV_HEALTH_SETTING_KEY)).toBe("ok");
      expect(await repo.getAccountSetting(ACCOUNT_ID, rt.JEV_PREFILTER_ENABLED_SETTING_KEY)).toBe("1");
      // probed with the TRIMMED values that are about to be stored, not the raw input
      expect(probeMock.mock.calls[0]![0]).toEqual({
        apiKey: "sk-or-1",
        baseUrl: "https://openrouter.ai/api/alpha/decisions",
      });
    });

    it("blank baseUrl probes the default but stores \"\" (no override), same as Prowlarr", async () => {
      probeMock.mockResolvedValue({ ok: true, model: "m" });
      await actions.saveJevConfigAction({ apiKey: "sk-or-1", baseUrl: "  " });
      expect(probeMock.mock.calls[0]![0].baseUrl).toBe("https://openrouter.ai/api/alpha/decisions");
      // Storing the default STRING would freeze today's endpoint into the DB and
      // shadow a later env JEV_BASE_URL; blank means "no override".
      expect(await repo.getAccountSetting(ACCOUNT_ID, rt.JEV_BASE_URL_SETTING_KEY)).toBe("");
    });

    it("reports the model the probe resolved, so the user sees WHAT answered", async () => {
      probeMock.mockResolvedValue({ ok: true, model: "typesafe/jev-1.13" });
      const result = await actions.saveJevConfigAction({ apiKey: "sk-or-1", baseUrl: "" });
      expect(result.success).toBe(true);
      expect(result.message).toContain("typesafe/jev-1.13");
    });

    // The 已设置 placeholder comes from the EFFECTIVE config (account → global →
    // env). A blank save that only looked at the account row would answer
    // 「需要 API Key」 for a key the UI just said was set — and an env-only
    // deployment could never activate, since enabled/health are DB-only.
    it("env-only key: blank save probes the env key and activates without writing it", async () => {
      process.env.JEV_API_KEY = "sk-env";
      probeMock.mockResolvedValue({ ok: true, model: "m" });
      const result = await actions.saveJevConfigAction({ apiKey: "", baseUrl: "" });
      expect(result.success).toBe(true);
      expect(probeMock.mock.calls[0]![0].apiKey).toBe("sk-env");
      // the env key is NOT copied into the DB — only what the user typed is written
      expect(await repo.getAccountSetting(ACCOUNT_ID, rt.JEV_API_KEY_SETTING_KEY)).toBeFalsy();
      expect(await repo.getAccountSetting(ACCOUNT_ID, rt.JEV_HEALTH_SETTING_KEY)).toBe("ok");
      expect(await repo.getAccountSetting(ACCOUNT_ID, rt.JEV_PREFILTER_ENABLED_SETTING_KEY)).toBe("1");
    });

    it("global-scope key: blank save probes the instance-wide key", async () => {
      await repo.setSetting(rt.JEV_API_KEY_SETTING_KEY, "sk-global");
      probeMock.mockResolvedValue({ ok: true, model: "m" });
      const result = await actions.saveJevConfigAction({ apiKey: "", baseUrl: "" });
      expect(result.success).toBe(true);
      expect(probeMock.mock.calls[0]![0].apiKey).toBe("sk-global");
    });

    // A missing scheme would otherwise cost an 8s probe and come back as the
    // vague 「连不上」 — the real problem is the format (same rule as PanSou).
    it("malformed baseUrl is refused by format before any probe is spent", async () => {
      const result = await actions.saveJevConfigAction({ apiKey: "sk-or-1", baseUrl: "ftp://x" });
      expect(result.success).toBe(false);
      expect(result.message).toContain("http://");
      expect(probeMock).not.toHaveBeenCalled();
    });

    it("probe failure → success:false with the probe message, nothing saved", async () => {
      probeMock.mockResolvedValue({ ok: false, reason: "auth_failed", message: "bad key" });
      await repo.setAccountSetting(ACCOUNT_ID, rt.JEV_API_KEY_SETTING_KEY, "");
      const result = await actions.saveJevConfigAction({ apiKey: "sk-bad", baseUrl: "" });
      expect(result).toEqual({ success: false, message: "bad key" });
      expect(await repo.getAccountSetting(ACCOUNT_ID, rt.JEV_API_KEY_SETTING_KEY)).toBe("");
      expect(await repo.getAccountSetting(ACCOUNT_ID, rt.JEV_HEALTH_SETTING_KEY)).toBeFalsy();
    });

    it("blank apiKey with a key already stored re-probes it and leaves the row untouched", async () => {
      probeMock.mockResolvedValue({ ok: true, model: "m" });
      await repo.setAccountSetting(ACCOUNT_ID, rt.JEV_API_KEY_SETTING_KEY, "sk-kept");
      const writes = vi.spyOn(repo, "setAccountSetting");
      const result = await actions.saveJevConfigAction({ apiKey: "", baseUrl: "" });
      expect(result.success).toBe(true);
      expect(probeMock.mock.calls[0]![0].apiKey).toBe("sk-kept");
      expect(await repo.getAccountSetting(ACCOUNT_ID, rt.JEV_API_KEY_SETTING_KEY)).toBe("sk-kept");
      // only what the user TYPED is written: a blank field rewrites nothing
      expect(
        writes.mock.calls.filter(([, key]) => key === rt.JEV_API_KEY_SETTING_KEY),
      ).toHaveLength(0);
      writes.mockRestore();
    });

    it("blank apiKey and nothing stored → success:false 需要 API Key, no probe", async () => {
      await repo.setAccountSetting(ACCOUNT_ID, rt.JEV_API_KEY_SETTING_KEY, "");
      const result = await actions.saveJevConfigAction({ apiKey: "", baseUrl: "" });
      expect(result.success).toBe(false);
      expect(result.message).toContain("API Key");
      expect(probeMock).not.toHaveBeenCalled();
    });
  });

  describe("clearJevConfigAction / setJevPrefilterEnabledAction", () => {
    const allKeys = () => [
      rt.JEV_API_KEY_SETTING_KEY,
      rt.JEV_BASE_URL_SETTING_KEY,
      rt.JEV_HEALTH_SETTING_KEY,
      rt.JEV_PREFILTER_ENABLED_SETTING_KEY,
    ];

    it("clear blanks all four keys", async () => {
      for (const key of allKeys()) await repo.setAccountSetting(ACCOUNT_ID, key, "x");
      expect((await actions.clearJevConfigAction()).success).toBe(true);
      for (const key of allKeys()) expect(await repo.getAccountSetting(ACCOUNT_ID, key)).toBe("");
    });

    it("toggle writes \"1\"/\"0\"", async () => {
      expect((await actions.setJevPrefilterEnabledAction(false)).success).toBe(true);
      expect(await repo.getAccountSetting(ACCOUNT_ID, rt.JEV_PREFILTER_ENABLED_SETTING_KEY)).toBe("0");
      expect((await actions.setJevPrefilterEnabledAction(true)).success).toBe(true);
      expect(await repo.getAccountSetting(ACCOUNT_ID, rt.JEV_PREFILTER_ENABLED_SETTING_KEY)).toBe("1");
    });
  });

  // Defense in depth: the form is hidden in demo mode, but the server boundary is
  // what actually decides. Mirrors actions.demo.test.ts.
  describe("demo read-only gate", () => {
    it("all three Jev actions reject in demo mode", async () => {
      process.env.MEDIA_TRACK_DEMO_MODE = "1";
      await expect(
        actions.saveJevConfigAction({ apiKey: "sk-or-1", baseUrl: "" }),
      ).rejects.toBeInstanceOf(demo.DemoReadOnlyError);
      await expect(actions.clearJevConfigAction()).rejects.toBeInstanceOf(demo.DemoReadOnlyError);
      await expect(actions.setJevPrefilterEnabledAction(true)).rejects.toBeInstanceOf(
        demo.DemoReadOnlyError,
      );
      expect(probeMock).not.toHaveBeenCalled();
    });
  });
});
