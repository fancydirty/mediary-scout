import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { InMemoryWorkflowRepository } from "@media-track/workflow";

// isDemoMode reads process.env.MEDIA_TRACK_DEMO_MODE at call time. We toggle it
// per test to prove the gate.
async function ensureDemoSeeded(repo: InstanceType<typeof InMemoryWorkflowRepository>) {
  // Re-import each time so the module-level demoSeedPromise memo doesn't leak
  // across tests (it would otherwise remember the first call's result forever).
  vi.resetModules();
  const mod = await import("./workflow-runtime");
  return mod.ensureDemoSeeded(repo);
}

describe("ensureDemoSeeded — gated on isDemoMode", () => {
  const original = process.env.MEDIA_TRACK_DEMO_MODE;
  beforeEach(() => { delete process.env.MEDIA_TRACK_DEMO_MODE; });
  afterEach(() => { if (original === undefined) delete process.env.MEDIA_TRACK_DEMO_MODE; else process.env.MEDIA_TRACK_DEMO_MODE = original; });

  it("does NOT seed a fresh self-hosted instance (empty DB, not demo mode)", async () => {
    const repo = new InMemoryWorkflowRepository();
    await ensureDemoSeeded(repo);
    // No demo drives should have been inserted into any account.
    const storages = await repo.listConnectedStorages("acct_default");
    expect(storages.length).toBe(0);
    // And no tracked seasons.
    const tracked = await repo.listTrackedSeasonStates({ accountId: "acct_default", connectedStorageId: null });
    expect(tracked.length).toBe(0);
  });

  it("DOES seed when MEDIA_TRACK_DEMO_MODE=1 (the public demo deploy)", async () => {
    process.env.MEDIA_TRACK_DEMO_MODE = "1";
    const repo = new InMemoryWorkflowRepository();
    await ensureDemoSeeded(repo);
    const storages = await repo.listConnectedStorages("acct_default");
    expect(storages.length).toBeGreaterThan(0);
    // The demo drives are named demo115/demoquark.
    const providers = storages.map((s) => s.providerUid).sort();
    expect(providers).toContain("demo115");
    expect(providers).toContain("demoquark");
  });
});
