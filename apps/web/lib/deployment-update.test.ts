import { describe, expect, it } from "vitest";
import {
  buildContainerUpgradePrompt,
  getDeploymentUpdateState,
  normalizeCommit,
} from "./deployment-update";

const CURRENT = "1111111111111111111111111111111111111111";
const LATEST = "2222222222222222222222222222222222222222";

describe("normalizeCommit", () => {
  it("accepts exactly 40 lowercase/uppercase hex chars", () => {
    expect(normalizeCommit(CURRENT.toUpperCase())).toBe(CURRENT);
  });

  it("rejects unknown and short build stamps", () => {
    expect(normalizeCommit("unknown")).toBeNull();
    expect(normalizeCommit("1111111")).toBeNull();
    expect(normalizeCommit(`${CURRENT}junk`)).toBeNull();
  });
});

describe("getDeploymentUpdateState", () => {
  it("marks containers behind when main commit differs", async () => {
    const state = await getDeploymentUpdateState({
      demo: false,
      desktop: false,
      currentCommit: CURRENT,
      fetchLatest: async () => LATEST,
    });
    expect(state).toMatchObject({
      kind: "container",
      behind: true,
      reason: "ok",
      currentShort: "1111111",
      latestShort: "2222222",
    });
  });

  it("is up to date when commits match", async () => {
    const state = await getDeploymentUpdateState({
      demo: false,
      desktop: false,
      currentCommit: CURRENT,
      fetchLatest: async () => CURRENT,
    });
    expect(state.behind).toBe(false);
  });

  it("never asks the demo web deploy to update", async () => {
    const state = await getDeploymentUpdateState({
      demo: true,
      desktop: false,
      currentCommit: CURRENT,
      fetchLatest: async () => LATEST,
    });
    expect(state.kind).toBe("web");
    expect(state.reason).toBe("demo");
    expect(state.behind).toBeNull();
  });

  it("keeps desktop out of the container-upgrade path", async () => {
    const state = await getDeploymentUpdateState({
      demo: false,
      desktop: true,
      currentCommit: CURRENT,
      fetchLatest: async () => LATEST,
    });
    expect(state.kind).toBe("desktop");
    expect(state.reason).toBe("desktop");
  });

  it("fails quiet when the remote probe throws or returns garbage", async () => {
    for (const fetchLatest of [async () => { throw new Error("offline"); }, async () => "junk"]) {
      const state = await getDeploymentUpdateState({
        demo: false,
        desktop: false,
        currentCommit: CURRENT,
        fetchLatest,
      });
      expect(state.behind).toBeNull();
      expect(state.reason).toBe("probe_failed");
    }
  });

  it("fails quiet when BUILD_COMMIT was not stamped", async () => {
    const state = await getDeploymentUpdateState({
      demo: false,
      desktop: false,
      currentCommit: "unknown",
      fetchLatest: async () => LATEST,
    });
    expect(state.reason).toBe("missing_current");
  });
});

describe("buildContainerUpgradePrompt", () => {
  it("contains both commits and requires the self-verifying deploy gate", () => {
    const prompt = buildContainerUpgradePrompt({ currentShort: "1111111", latestShort: "2222222" });
    expect(prompt).toContain("1111111");
    expect(prompt).toContain("2222222");
    expect(prompt).toContain("git pull --ff-only");
    expect(prompt).toContain("./scripts/deploy.sh");
    expect(prompt).toContain("/api/health");
    expect(prompt).toContain("不要绕过校验");
  });
});
