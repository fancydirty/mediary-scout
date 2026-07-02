import { describe, expect, it, beforeAll, beforeEach, afterEach } from "vitest";
import { DemoReadOnlyError } from "../lib/demo-mode";

// Defense-in-depth: even if the UI is bypassed, side-effectful server actions must
// reject in demo mode. Smoke-checks the gate is wired (one representative action).
describe("server actions honor demo read-only", () => {
  // Importing ./actions pulls in the whole workflow-runtime dependency graph
  // (~5s cold, worse under full-suite load). Load once here with its own wide
  // budget so the tests keep the default 5s timeout without flaking. Safe to
  // import before env is set: the demo gate reads process.env at call time.
  let actions: typeof import("./actions");
  beforeAll(async () => {
    actions = await import("./actions");
  }, 30_000);

  beforeEach(() => {
    process.env.MEDIA_TRACK_DEMO_MODE = "1";
  });
  afterEach(() => {
    delete process.env.MEDIA_TRACK_DEMO_MODE;
  });

  it("testStorageConnectionAction rejects in demo mode", async () => {
    await expect(actions.testStorageConnectionAction("cs_x")).rejects.toBeInstanceOf(
      DemoReadOnlyError,
    );
  });

  it("savePushSettingsAction rejects in demo mode", async () => {
    await expect(actions.savePushSettingsAction({ bark: "x" })).rejects.toBeInstanceOf(
      DemoReadOnlyError,
    );
  });
});
