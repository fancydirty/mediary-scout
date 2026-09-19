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

const ACCOUNT_ID = "acct_default";

describe("Jev settings actions", () => {
  let repo: InMemoryWorkflowRepository;
  let actions: typeof import("./actions");
  let rt: typeof import("../lib/workflow-runtime");

  beforeEach(async () => {
    delete process.env.MEDIA_TRACK_DEMO_MODE;
    delete process.env.MEDIA_TRACK_MULTI_USER;
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
    vi.doMock("../lib/jev-probe", () => ({ probeJev: probeMock }));
    rt = await import("../lib/workflow-runtime");
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

    it("blank baseUrl falls back to the OpenRouter decisions endpoint", async () => {
      probeMock.mockResolvedValue({ ok: true, model: "m" });
      await actions.saveJevConfigAction({ apiKey: "sk-or-1", baseUrl: "  " });
      expect(probeMock.mock.calls[0]![0].baseUrl).toBe("https://openrouter.ai/api/alpha/decisions");
      expect(await repo.getAccountSetting(ACCOUNT_ID, rt.JEV_BASE_URL_SETTING_KEY)).toBe(
        "https://openrouter.ai/api/alpha/decisions",
      );
    });

    it("probe failure → success:false with the probe message, nothing saved", async () => {
      probeMock.mockResolvedValue({ ok: false, reason: "auth_failed", message: "bad key" });
      await repo.setAccountSetting(ACCOUNT_ID, rt.JEV_API_KEY_SETTING_KEY, "");
      const result = await actions.saveJevConfigAction({ apiKey: "sk-bad", baseUrl: "" });
      expect(result).toEqual({ success: false, message: "bad key" });
      expect(await repo.getAccountSetting(ACCOUNT_ID, rt.JEV_API_KEY_SETTING_KEY)).toBe("");
      expect(await repo.getAccountSetting(ACCOUNT_ID, rt.JEV_HEALTH_SETTING_KEY)).toBeFalsy();
    });

    it("blank apiKey with a key already stored keeps the stored key and re-probes it", async () => {
      probeMock.mockResolvedValue({ ok: true, model: "m" });
      await repo.setAccountSetting(ACCOUNT_ID, rt.JEV_API_KEY_SETTING_KEY, "sk-kept");
      const result = await actions.saveJevConfigAction({ apiKey: "", baseUrl: "" });
      expect(result.success).toBe(true);
      expect(probeMock.mock.calls[0]![0].apiKey).toBe("sk-kept");
      expect(await repo.getAccountSetting(ACCOUNT_ID, rt.JEV_API_KEY_SETTING_KEY)).toBe("sk-kept");
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
});
