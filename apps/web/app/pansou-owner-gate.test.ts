import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryWorkflowRepository } from "@media-track/workflow";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/**
 * issue #366 回归：`savePanSouBaseUrlAction` 的探活是服务端向调用者给的任意地址
 * 发请求，多用户下非站主账号（乃至单用户下隧道来的匿名哨兵）不得触发。门禁用
 * resolveCurrentIsOwner —— 它的判定口径（哨兵非站主、单用户=隐式站主、多用户看
 * is_owner）已在 settings-attention-server.test.ts 锁死，这里只锁 Action 接线。
 */
describe("savePanSouBaseUrlAction — owner gate (issue #366)", () => {
  let repo: InMemoryWorkflowRepository;
  let accountId: string;
  let probeCalls: string[];
  let actions: typeof import("./actions");

  beforeEach(async () => {
    delete process.env.MEDIA_TRACK_DEMO_MODE;
    delete process.env.MEDIA_TRACK_MULTI_USER;
    repo = new InMemoryWorkflowRepository();
    accountId = "acct_default";
    probeCalls = [];
    await repo.upsertConnectedStorage({ id: "cs_primary", accountId: "acct_default", provider: "pan115", providerUid: "1001", payload: {}, createdAt: "2026-09-01T00:00:00.000Z" });
    vi.resetModules();
    vi.doMock("../lib/workflow-runtime", async () => {
      const actual = await vi.importActual<typeof import("../lib/workflow-runtime")>("../lib/workflow-runtime");
      return {
        ...actual,
        getWorkflowRepository: () => repo,
        getCurrentAccountId: async () => accountId,
      };
    });
    // 探活打的是真实网络：测试里替换成记录调用而不发请求（权限门禁本身与探活结果无关）。
    vi.doMock("../lib/pansou-probe", async () => {
      const actual = await vi.importActual<typeof import("../lib/pansou-probe")>("../lib/pansou-probe");
      return {
        ...actual,
        probePanSou: async (baseURL: string) => {
          probeCalls.push(baseURL);
          return { ok: true } as const;
        },
      };
    });
    actions = await import("./actions");
  }, 30_000);

  it("单用户站主（acct_default）可以保存，探活通过后写入账号设置", async () => {
    const result = await actions.savePanSouBaseUrlAction("http://pansou.internal:8888");
    expect(result).toEqual({ success: true });
    expect(probeCalls).toEqual(["http://pansou.internal:8888"]);
    expect(await repo.getAccountSetting("acct_default", "pansou_base_url")).toBe("http://pansou.internal:8888");
  });

  it("匿名哨兵（单用户隧道访客）被拒绝，不探活、不写库", async () => {
    accountId = "acct_unauthenticated";
    const result = await actions.savePanSouBaseUrlAction("http://169.254.169.254/x");
    expect(result).toEqual({ success: false, message: "只有站主可以修改网盘搜索源。" });
    expect(probeCalls).toEqual([]);
    expect(await repo.getAccountSetting("acct_unauthenticated", "pansou_base_url")).toBeNull();
  });

  it("多用户下非站主账号被拒绝，不探活、不写库", async () => {
    process.env.MEDIA_TRACK_MULTI_USER = "1";
    await repo.createAccount({ id: "acct_member", username: "member", passwordHash: "x", groupId: null, isOwner: false, createdAt: "2026-09-01T00:00:00.000Z" });
    accountId = "acct_member";
    const result = await actions.savePanSouBaseUrlAction("http://10.0.0.1:9999");
    expect(result).toEqual({ success: false, message: "只有站主可以修改网盘搜索源。" });
    expect(probeCalls).toEqual([]);
    expect(await repo.getAccountSetting("acct_member", "pansou_base_url")).toBeNull();
  });
});
