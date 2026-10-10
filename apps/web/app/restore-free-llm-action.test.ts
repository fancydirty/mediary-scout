import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryWorkflowRepository, FREE_LLM_PRESET, isFreeLlmPreset } from "@media-track/workflow";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/** 「换回免费模型」一键写库：落点/账号域与 saveLlmConfigAction 一致，且必须让
 *  设置页判定回出厂态（生效值逐字 == 出厂预设），已存 API Key 保留不动。 */
describe("restoreFreeLlmAction", () => {
  let repo: InMemoryWorkflowRepository;
  let actions: typeof import("./actions");
  let runtime: typeof import("../lib/workflow-runtime");
  const accountId = "acct_default";

  beforeEach(async () => {
    delete process.env.MEDIA_TRACK_DEMO_MODE;
    repo = new InMemoryWorkflowRepository();
    vi.resetModules();
    vi.doMock("../lib/workflow-runtime", async () => {
      const actual = await vi.importActual<typeof import("../lib/workflow-runtime")>("../lib/workflow-runtime");
      return {
        ...actual,
        getWorkflowRepository: () => repo,
        getCurrentAccountId: async () => accountId,
      };
    });
    actions = await import("./actions");
    runtime = await import("../lib/workflow-runtime");
  });

  it("把出厂预设写进本账号 settings（baseURL 已 normalize），已存 API Key 原样保留", async () => {
    await repo.setAccountSetting(accountId, "llm_base_url", "https://api.deepseek.com/v1");
    await repo.setAccountSetting(accountId, "llm_model_id", "deepseek-chat");
    await repo.setAccountSetting(accountId, "llm_api_key", "sk-keep-me");

    expect(await actions.restoreFreeLlmAction()).toEqual({ success: true });

    expect(await repo.getAccountSetting(accountId, "llm_base_url")).toBe(FREE_LLM_PRESET.baseURL);
    expect(await repo.getAccountSetting(accountId, "llm_model_id")).toBe(FREE_LLM_PRESET.modelId);
    // blank-keep 语义：免费池无 key 直连用不到它；用户再换回自己的服务时 key 还在。
    expect(await repo.getAccountSetting(accountId, "llm_api_key")).toBe("sk-keep-me");
  });

  it("写库后设置页判定回出厂态：生效值 == 出厂预设（source 是 db，但 predicate 必须为真）", async () => {
    await repo.setAccountSetting(accountId, "llm_base_url", "https://api.deepseek.com");
    await repo.setAccountSetting(accountId, "llm_model_id", "deepseek-chat");

    expect(await actions.restoreFreeLlmAction()).toEqual({ success: true });

    // 与设置页同一读法：account-scoped facade（自有行优先、全局行兜底）。
    const scoped = runtime.getAccountScopedSettings(accountId, repo);
    const resolved = await runtime.resolveAgentModelConfig(scoped, {} as unknown as NodeJS.ProcessEnv);
    expect(resolved.source).toBe("db");
    expect(resolved).toMatchObject({ baseURL: FREE_LLM_PRESET.baseURL, modelId: FREE_LLM_PRESET.modelId });
    // 设置页（Task 4）按 isFreeLlmPreset 判定免费档，不按 source —— 点完按钮
    // 界面必须回到出厂态（胶囊「Kilo 免费池」、预填、无按钮）。
    expect(isFreeLlmPreset(resolved)).toBe(true);
  });

  it("只写当前账号的行，别的账号配置不受影响", async () => {
    await repo.setAccountSetting("acct_other", "llm_base_url", "https://api.deepseek.com");
    await repo.setAccountSetting("acct_other", "llm_model_id", "deepseek-chat");

    expect(await actions.restoreFreeLlmAction()).toEqual({ success: true });

    expect(await repo.getAccountSetting(accountId, "llm_base_url")).toBe(FREE_LLM_PRESET.baseURL);
    expect(await repo.getAccountSetting("acct_other", "llm_base_url")).toBe("https://api.deepseek.com");
    expect(await repo.getAccountSetting("acct_other", "llm_model_id")).toBe("deepseek-chat");
  });
});
