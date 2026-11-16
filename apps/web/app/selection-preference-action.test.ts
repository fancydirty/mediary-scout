import { describe, expect, it, vi } from "vitest";

const state = {
  demo: false,
  accountId: "acct_default",
  settings: new Map<string, string>(),
};

vi.mock("../lib/demo-mode", () => ({
  isDemoMode: () => state.demo,
  assertNotDemo: () => {
    if (state.demo) throw new Error("demo mode");
  },
}));

vi.mock("../lib/workflow-runtime", () => ({
  SELECTION_PREFERENCE_SETTING_KEY: "selection_preference",
  requireAuthenticatedAccountId: async () => {
    if (state.accountId === "acct_unauthenticated") {
      throw new Error("未登录，无法修改设置。");
    }
    return state.accountId;
  },
  getWorkflowRepository: () => ({
    setAccountSetting: async (accountId: string, key: string, value: string) => {
      state.settings.set(`${accountId}:${key}`, value);
    },
  }),
}));

import { saveSelectionPreferenceAction } from "./actions";

describe("saveSelectionPreferenceAction", () => {
  it("saves normalized selection preference per account and allows empty clear", async () => {
    state.demo = false;
    state.accountId = "acct_alice";
    state.settings.clear();

    const ok = await saveSelectionPreferenceAction("  优先 HDR10，避开杜比视界\r\n单部电影小于 25GB  ");
    expect(ok).toEqual({ success: true });
    expect(state.settings.get("acct_alice:selection_preference")).toBe(
      "优先 HDR10，避开杜比视界\n单部电影小于 25GB",
    );

    const cleared = await saveSelectionPreferenceAction("   ");
    expect(cleared).toEqual({ success: true });
    expect(state.settings.get("acct_alice:selection_preference")).toBe("");
  });

  it("rejects text exceeding SELECTION_PREFERENCE_MAX_LENGTH (500 chars)", async () => {
    state.demo = false;
    state.accountId = "acct_alice";
    state.settings.clear();

    const tooLong = "优".repeat(501);
    const res = await saveSelectionPreferenceAction(tooLong);
    expect(res.success).toBe(false);
    expect(res.message).toContain("500");
    expect(state.settings.size).toBe(0);
  });

  it("rejects unauthenticated sentinel without writing", async () => {
    state.demo = false;
    state.accountId = "acct_unauthenticated";
    state.settings.clear();

    const res = await saveSelectionPreferenceAction("优先 4K");
    expect(res.success).toBe(false);
    expect(state.settings.size).toBe(0);
  });
});
