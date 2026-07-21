import { describe, expect, it } from "vitest";
import {
  pickWorkspaceStorageId,
  resolveQueueStorageChoice,
  WorkspaceNotFoundError,
} from "../src/index.js";

const drives = [
  { id: "csNew", createdAt: "2026-06-10T00:00:00.000Z" },
  { id: "csOld", createdAt: "2026-06-01T00:00:00.000Z" },
];

describe("pickWorkspaceStorageId", () => {
  it("no param → the earliest-created (primary) drive", () => {
    expect(pickWorkspaceStorageId(drives, undefined)).toBe("csOld");
  });
  it("explicit param that the account owns → that drive", () => {
    expect(pickWorkspaceStorageId(drives, "csNew")).toBe("csNew");
  });
  it("explicit param the account does NOT own → throws WorkspaceNotFoundError", () => {
    expect(() => pickWorkspaceStorageId(drives, "csStranger")).toThrowError(WorkspaceNotFoundError);
  });
  it("no drives + no param → null (single-user fresh; root works account-only)", () => {
    expect(pickWorkspaceStorageId([], undefined)).toBeNull();
  });
  it("no drives + explicit param → throws (can't open a workspace that isn't yours)", () => {
    expect(() => pickWorkspaceStorageId([], "csX")).toThrowError(WorkspaceNotFoundError);
  });
});

const queueDrives = [
  { id: "csNew", createdAt: "2026-06-10T00:00:00.000Z", status: "active" },
  { id: "csOld", createdAt: "2026-06-01T00:00:00.000Z", status: "active" },
  { id: "csFrozen", createdAt: "2026-06-05T00:00:00.000Z", status: "frozen" },
];

describe("resolveQueueStorageChoice", () => {
  it("no explicit → earliest by createdAt", () => {
    expect(resolveQueueStorageChoice(queueDrives, undefined)).toEqual({
      id: "csOld",
      frozen: false,
      unknown: false,
    });
  });

  it("no explicit + empty list → null (not unknown)", () => {
    expect(resolveQueueStorageChoice([], null)).toEqual({
      id: null,
      frozen: false,
      unknown: false,
    });
  });

  it("explicit owned active → that id, not frozen", () => {
    expect(resolveQueueStorageChoice(queueDrives, "csNew")).toEqual({
      id: "csNew",
      frozen: false,
      unknown: false,
    });
  });

  it("explicit owned frozen → that id, frozen true", () => {
    expect(resolveQueueStorageChoice(queueDrives, "csFrozen")).toEqual({
      id: "csFrozen",
      frozen: true,
      unknown: false,
    });
  });

  it("explicit unknown → null + unknown (no soft-fallback to primary)", () => {
    expect(resolveQueueStorageChoice(queueDrives, "csGhost")).toEqual({
      id: null,
      frozen: false,
      unknown: true,
    });
  });

  it("explicit unknown with empty list → null + unknown (not passthrough)", () => {
    expect(resolveQueueStorageChoice([], "csGhost")).toEqual({
      id: null,
      frozen: false,
      unknown: true,
    });
  });

  it("no explicit + primary frozen → earliest id with frozen true", () => {
    const onlyFrozen = [
      { id: "csA", createdAt: "2026-06-02T00:00:00.000Z", status: "frozen" },
      { id: "csB", createdAt: "2026-06-01T00:00:00.000Z", status: "frozen" },
    ];
    expect(resolveQueueStorageChoice(onlyFrozen, undefined)).toEqual({
      id: "csB",
      frozen: true,
      unknown: false,
    });
  });
});
