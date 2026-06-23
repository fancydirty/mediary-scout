import { describe, expect, it } from "vitest";
import { classifyTransferBlock, isSystemicTransferBlockMessage } from "../src/acquisition-v2/transfer-block.js";
import type { TransferAttempt } from "../src/domain.js";

function attempt(over: Partial<TransferAttempt>): TransferAttempt {
  return {
    id: "a",
    workflowRunId: "run",
    candidateId: "c",
    status: "failed",
    providerMessage: "",
    materializedFileIds: [],
    ...over,
  };
}

describe("classifyTransferBlock", () => {
  it("flags a systemic 云下载配额 block (nothing landed)", () => {
    const block = classifyTransferBlock([
      attempt({ providerMessage: "云下载配额不足，请升级VIP获得赠送配额或购买云下载配额！" }),
      attempt({ providerMessage: "云下载配额不足，请升级VIP获得赠送配额或购买云下载配额！" }),
    ]);
    expect(block).not.toBeNull();
    expect(block!.reason).toContain("配额");
  });

  it("flags an auth/login block", () => {
    const block = classifyTransferBlock([attempt({ providerMessage: "登录超时，请重新登录。" })]);
    expect(block).not.toBeNull();
    expect(block!.reason).toContain("登录");
  });

  it("does NOT flag dead-link failures (expired/cancelled/bad link)", () => {
    expect(
      classifyTransferBlock([
        attempt({ providerMessage: "链接已过期" }),
        attempt({ providerMessage: "分享已取消" }),
        attempt({ providerMessage: "错误的链接" }),
      ]),
    ).toBeNull();
  });

  it("returns null when any transfer succeeded (something landed)", () => {
    expect(
      classifyTransferBlock([
        attempt({ status: "failed", providerMessage: "云下载配额不足" }),
        attempt({ status: "succeeded", providerMessage: "下载成功", materializedFileIds: ["f1"] }),
      ]),
    ).toBeNull();
  });

  it("returns null for no attempts (truly searched-but-found-nothing)", () => {
    expect(classifyTransferBlock([])).toBeNull();
  });

  it("flags a block even when mixed with dead links (account still can't transfer)", () => {
    const block = classifyTransferBlock([
      attempt({ providerMessage: "链接已过期" }),
      attempt({ providerMessage: "云下载配额不足，请升级VIP" }),
    ]);
    expect(block).not.toBeNull();
    expect(block!.reason).toContain("配额");
  });

  it("ignores non-failed attempts — a no_target_change carrying a matching message must NOT flag a block", () => {
    expect(
      classifyTransferBlock([
        attempt({ status: "no_target_change", providerMessage: "云下载配额不足" }),
      ]),
    ).toBeNull();
  });
});

describe("isSystemicTransferBlockMessage (per-message predicate, reused by the sandbox)", () => {
  it("is true for systemic account messages (quota / VIP / login / auth)", () => {
    expect(isSystemicTransferBlockMessage("云下载配额不足，请升级VIP获得赠送配额")).toBe(true);
    expect(isSystemicTransferBlockMessage("登录超时，请重新登录。")).toBe(true);
    expect(isSystemicTransferBlockMessage("PAN115_AUTH_FAILED: 登录超时")).toBe(true);
    expect(isSystemicTransferBlockMessage("额度已用完")).toBe(true);
  });

  it("is false for dead-link messages (they iterate to the next candidate, not stop)", () => {
    expect(isSystemicTransferBlockMessage("链接已过期")).toBe(false);
    expect(isSystemicTransferBlockMessage("分享已取消")).toBe(false);
    expect(isSystemicTransferBlockMessage("错误的链接")).toBe(false);
    expect(isSystemicTransferBlockMessage("分享不存在")).toBe(false);
  });

  it("is false for empty / whitespace / undefined", () => {
    expect(isSystemicTransferBlockMessage("")).toBe(false);
    expect(isSystemicTransferBlockMessage("   ")).toBe(false);
    expect(isSystemicTransferBlockMessage(undefined)).toBe(false);
    expect(isSystemicTransferBlockMessage(null)).toBe(false);
  });
});
