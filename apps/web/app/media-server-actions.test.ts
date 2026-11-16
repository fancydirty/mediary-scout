import { describe, expect, it, vi } from "vitest";

const state = {
  demo: false,
  isOwner: true,
  accountId: "acct_default",
  settings: new Map<string, string>(),
};

vi.mock("../lib/demo-mode", () => ({
  isDemoMode: () => state.demo,
  assertNotDemo: () => {
    if (state.demo) throw new Error("demo mode");
  },
}));

vi.mock("../lib/settings-attention-server", () => ({
  resolveCurrentIsOwner: async () => state.isOwner,
}));

vi.mock("../lib/workflow-runtime", () => ({
  requireAuthenticatedAccountId: async () => {
    if (state.accountId === "acct_unauthenticated") {
      throw new Error("未登录");
    }
    return state.accountId;
  },
  getAccountScopedSettings: (accountId: string) => ({
    getSetting: async (key: string) => state.settings.get(`${accountId}:${key}`) ?? null,
  }),
  getWorkflowRepository: () => ({
    getAccountSetting: async (accountId: string, key: string) =>
      state.settings.get(`${accountId}:${key}`) ?? null,
    setAccountSetting: async (accountId: string, key: string, value: string) => {
      state.settings.set(`${accountId}:${key}`, value);
    },
  }),
}));

import {
  clearMediaServerChannelAction,
  saveMediaServerSettingsAction,
  testMediaServerRefreshAction,
} from "./actions";

describe("media server settings actions (owner-gated)", () => {
  it("denies non-owner accounts with zero writes and zero outbound requests", async () => {
    state.demo = false;
    state.isOwner = false;
    state.accountId = "acct_bob";
    state.settings.clear();

    const saveRes = await saveMediaServerSettingsAction({
      embyUrl: "http://192.168.1.2:8096",
      embyApiKey: "abc",
    });
    expect(saveRes.success).toBe(false);
    expect(saveRes.message).toContain("站主");
    expect(state.settings.size).toBe(0);

    const testRes = await testMediaServerRefreshAction({
      embyUrl: "http://127.0.0.1:9",
      embyApiKey: "abc",
    });
    expect(testRes.success).toBe(false);
    expect(testRes.message).toContain("站主");
  });

  it("requires an API key / token when saving a new server URL, preserves existing key on blank, and clears cleanly", async () => {
    state.demo = false;
    state.isOwner = true;
    state.accountId = "acct_default";
    state.settings.clear();

    const missingKey = await saveMediaServerSettingsAction({
      embyUrl: "http://192.168.100.1:8096/",
    });
    expect(missingKey.success).toBe(false);
    expect(missingKey.message).toContain("Emby");

    const ok = await saveMediaServerSettingsAction({
      embyUrl: "http://192.168.100.1:8096/",
      embyApiKey: "secret_token_1",
      delaySeconds: 15,
    });
    expect(ok).toEqual({ success: true });
    expect(state.settings.get("acct_default:media_server_emby_url")).toBe("http://192.168.100.1:8096");
    expect(state.settings.get("acct_default:media_server_emby_api_key")).toBe("secret_token_1");
    expect(state.settings.get("acct_default:media_server_refresh_delay_sec")).toBe("15");

    // Updating URL without retyping key keeps stored key
    const updateUrl = await saveMediaServerSettingsAction({
      embyUrl: "http://192.168.100.2:8096/",
    });
    expect(updateUrl).toEqual({ success: true });
    expect(state.settings.get("acct_default:media_server_emby_url")).toBe("http://192.168.100.2:8096");
    expect(state.settings.get("acct_default:media_server_emby_api_key")).toBe("secret_token_1");

    // Clearing Emby wipes both URL and key
    const cleared = await clearMediaServerChannelAction("emby");
    expect(cleared).toEqual({ success: true });
    expect(state.settings.get("acct_default:media_server_emby_url")).toBe("");
    expect(state.settings.get("acct_default:media_server_emby_api_key")).toBe("");
  });
});
