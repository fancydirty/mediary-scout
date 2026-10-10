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

  it("第二次写库（modelId）抛错 → 返回失败，且第一个 key 补偿回滚旧值，不留半切换状态", async () => {
    // 两次 setSetting 之间失败：baseURL 已被覆盖成 Kilo、modelId 仍旧值 ——
    // 无回滚就是持续生效的混合配置（用户不重试不自愈）。
    let failModelIdWrites = false;
    class ModelIdWriteBoom extends InMemoryWorkflowRepository {
      override async setAccountSetting(accountId: string, key: string, value: string): Promise<void> {
        if (failModelIdWrites && key === "llm_model_id") throw new Error("model-id write boom");
        return super.setAccountSetting(accountId, key, value);
      }
    }
    repo = new ModelIdWriteBoom();
    await repo.setAccountSetting(accountId, "llm_base_url", "https://api.deepseek.com/v1");
    await repo.setAccountSetting(accountId, "llm_model_id", "deepseek-chat");
    failModelIdWrites = true;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await actions.restoreFreeLlmAction()).toEqual({ success: false, message: "换回失败，请稍后重试" });

    // 补偿回滚生效：baseURL 回到旧值（不是停在 Kilo），modelId 未被改动。
    expect(await repo.getAccountSetting(accountId, "llm_base_url")).toBe("https://api.deepseek.com/v1");
    expect(await repo.getAccountSetting(accountId, "llm_model_id")).toBe("deepseek-chat");
    // 原始错误照旧进服务端日志（回滚不得掩盖它）。
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
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

/** 设置页免费态 details 文案的承诺：「清空地址保存即恢复默认」。免费态表单
 *  预填出厂值，用户只清空 Base URL 保存时，modelId 仍带着预填的预设模型名
 *  一起提交 —— saveLlmConfigAction 必须落库成整行清空（baseURL 与 modelId
 *  双双空）。只清 baseURL 留下 modelId 会得到半截配置：resolveAgentModelConfig
 *  只对「baseURL 与 modelId 双空」回落免费预设，半截照原样返回、下游 llmConfigError
 *  fail-fast，文案就成了假话（task-4 报告疑虑 1，review 拍板修法）。 */
describe("saveLlmConfigAction 清空地址保存即恢复默认", () => {
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

  // 与设置页同一读法：account-scoped facade + 显式空 env（不掺本进程环境变量）。
  const resolve = async () => {
    const scoped = runtime.getAccountScopedSettings(accountId, repo);
    return runtime.resolveAgentModelConfig(scoped, {} as unknown as NodeJS.ProcessEnv);
  };

  it("出厂态表单只清空 Base URL 保存（modelId 仍传预设模型名）→ 双双清空，回落免费预设", async () => {
    expect(
      await actions.saveLlmConfigAction({ baseURL: "", modelId: FREE_LLM_PRESET.modelId, apiKey: "" }),
    ).toEqual({ success: true });

    // DB 整行清空：{baseURL:"", modelId:预设名} 这种半截行就是本次修的 bug。
    expect(await repo.getAccountSetting(accountId, "llm_base_url")).toBeFalsy();
    expect(await repo.getAccountSetting(accountId, "llm_model_id")).toBeFalsy();
    const resolved = await resolve();
    expect(isFreeLlmPreset(resolved)).toBe(true);
    expect(resolved).toMatchObject({ baseURL: FREE_LLM_PRESET.baseURL, modelId: FREE_LLM_PRESET.modelId });
  });

  it("自带态（deepseek）只清空 Base URL（含纯空白）→ 同样双双清空，回落免费预设", async () => {
    await repo.setAccountSetting(accountId, "llm_base_url", "https://api.deepseek.com/v1");
    await repo.setAccountSetting(accountId, "llm_model_id", "deepseek-chat");

    expect(
      await actions.saveLlmConfigAction({ baseURL: "   ", modelId: "deepseek-chat", apiKey: "" }),
    ).toEqual({ success: true });

    expect(await repo.getAccountSetting(accountId, "llm_base_url")).toBeFalsy();
    expect(await repo.getAccountSetting(accountId, "llm_model_id")).toBeFalsy();
    expect(isFreeLlmPreset(await resolve())).toBe(true);
  });

  it("baseURL 非空时行为不变：baseURL 走 normalize、modelId 照用户输入（trim）存", async () => {
    expect(
      await actions.saveLlmConfigAction({
        baseURL: "https://api.deepseek.com/v1/",
        modelId: "  deepseek-chat  ",
        apiKey: "",
      }),
    ).toEqual({ success: true });

    expect(await repo.getAccountSetting(accountId, "llm_base_url")).toBe("https://api.deepseek.com/v1");
    expect(await repo.getAccountSetting(accountId, "llm_model_id")).toBe("deepseek-chat");
  });
});
