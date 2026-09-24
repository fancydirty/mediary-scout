import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryWorkflowRepository } from "@media-track/workflow";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/** The memory actions write shared state, so an unauthenticated caller (the
 *  acct_unauthenticated sentinel) must be refused — same guard as unbindStorageAction. */
describe("agent memory actions — authentication", () => {
  let repo: InMemoryWorkflowRepository;
  let actions: typeof import("./actions");
  let accountId = "acct_default";

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
        requireAuthenticatedAccountId: async () => {
          if (accountId === actual.UNAUTHENTICATED_ACCOUNT_ID) throw new actual.UnauthenticatedAccountError();
          return accountId;
        },
      };
    });
    actions = await import("./actions");
  });

  const entry = { name: "no-2025-year", description: "d", kind: "search" as const, body: "b" };

  it("an authenticated caller can toggle, save and delete", async () => {
    accountId = "acct_default";
    expect(await actions.setAgentMemoryEnabledAction(false)).toMatchObject({ success: true });
    expect(await actions.saveAgentMemoryAction({ scope: "global" }, entry)).toMatchObject({ success: true });
    expect(await actions.deleteAgentMemoryAction({ scope: "global" }, entry.name)).toMatchObject({ success: true });
  });

  it("the unauthenticated sentinel is refused and nothing is written", async () => {
    const { UNAUTHENTICATED_ACCOUNT_ID } = await vi.importActual<typeof import("../lib/workflow-runtime")>("../lib/workflow-runtime");
    accountId = UNAUTHENTICATED_ACCOUNT_ID;
    expect(await actions.setAgentMemoryEnabledAction(false)).toMatchObject({ success: false });
    expect(await actions.saveAgentMemoryAction({ scope: "global" }, entry)).toMatchObject({ success: false });
    expect(await actions.deleteAgentMemoryAction({ scope: "global" }, entry.name)).toMatchObject({ success: false });
    expect(await repo.getAccountSetting(UNAUTHENTICATED_ACCOUNT_ID, "agent_memory_enabled")).toBeNull();
    expect(await repo.listAgentMemories({ accountId: UNAUTHENTICATED_ACCOUNT_ID, scope: "global" })).toHaveLength(0);
  });
});
