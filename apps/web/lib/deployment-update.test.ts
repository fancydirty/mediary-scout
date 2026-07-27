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

  it("rejects 39-char prefix and non-hex content", () => {
    expect(normalizeCommit(CURRENT.slice(0, 39))).toBeNull();
    expect(normalizeCommit("g".repeat(40))).toBeNull();
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
  const ORIGIN = "https://mediary.example.com";
  const prompt = buildContainerUpgradePrompt({
    currentShort: "1111111",
    latestShort: "2222222",
    origin: ORIGIN,
  });

  it("is written for a cold agent on the laptop, NOT on the deploy machine", () => {
    expect(prompt).toContain("你在我的笔记本上");
    expect(prompt).toContain("部署在另一台机器");
    expect(prompt).not.toContain("这台部署机");
  });

  it("threads the page origin into the SSH-derivation step and the health re-check", () => {
    expect(prompt).toContain(`我通过 ${ORIGIN} 访问`);
    expect(prompt).toContain(`curl -fsS ${ORIGIN}/api/health`);
  });

  it("locates the repo via docker ps + the compose working-dir label, never a guessed path", () => {
    expect(prompt).toContain("docker ps");
    expect(prompt).toContain('{{index .Config.Labels "com.docker.compose.project.working_dir"}}');
  });

  it("verifies HEAD == currentShort BEFORE pulling, and pulls ff-only to latestShort", () => {
    expect(prompt).toContain("git rev-parse --short HEAD");
    expect(prompt).toContain("1111111");
    expect(prompt).toContain("git pull --ff-only");
    expect(prompt).toContain("2222222");
    expect(prompt).toContain("./scripts/deploy.sh");
    expect(prompt).toContain("BUILD_COMMIT");
    expect(prompt).toContain("/api/health");
  });

  it("has explicit stop conditions: unreachable SSH, HEAD mismatch, any failure — no destructive ops", () => {
    expect(prompt).toContain("连不上就停下");
    expect(prompt).toContain("不要继续");
    expect(prompt).toContain("立即停止");
    expect(prompt).toContain("不做任何破坏性操作");
    expect(prompt).toContain("完整日志");
  });

  it("stays within 15 lines", () => {
    expect(prompt.split("\n").length).toBeLessThanOrEqual(15);
  });
});
