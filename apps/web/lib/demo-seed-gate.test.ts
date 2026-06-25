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
  const originalDemoMode = process.env.MEDIA_TRACK_DEMO_MODE;
  const originalDemoSeed = process.env.MEDIA_TRACK_DEMO_SEED;
  beforeEach(() => {
    delete process.env.MEDIA_TRACK_DEMO_MODE;
    // MEDIA_TRACK_DEMO_SEED="0" short-circuits seeding (docker-compose sets it
    // for self-hosting). Clear it so the "demo=1 → seeds" test is deterministic
    // and doesn't depend on whatever the outer test runner inherited.
    delete process.env.MEDIA_TRACK_DEMO_SEED;
  });
  afterEach(() => {
    if (originalDemoMode === undefined) delete process.env.MEDIA_TRACK_DEMO_MODE;
    else process.env.MEDIA_TRACK_DEMO_MODE = originalDemoMode;
    if (originalDemoSeed === undefined) delete process.env.MEDIA_TRACK_DEMO_SEED;
    else process.env.MEDIA_TRACK_DEMO_SEED = originalDemoSeed;
  });

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

  it("respects MEDIA_TRACK_DEMO_SEED=0 even in demo mode (explicit opt-out)", async () => {
    process.env.MEDIA_TRACK_DEMO_MODE = "1";
    process.env.MEDIA_TRACK_DEMO_SEED = "0";
    const repo = new InMemoryWorkflowRepository();
    await ensureDemoSeeded(repo);
    const storages = await repo.listConnectedStorages("acct_default");
    expect(storages.length).toBe(0);
  });
});
