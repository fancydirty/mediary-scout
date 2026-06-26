import { describe, expect, it } from "vitest";
import {
  createExecutorForBrand,
  QuarkStorageExecutor,
  Storage115Executor,
} from "../src/index.js";
import { GuangYaStorageExecutor } from "../src/guangya-storage-executor.js";

describe("createExecutorForBrand", () => {
  it("pan115 → Storage115Executor (write scope from scopeCids)", () => {
    const exec = createExecutorForBrand({ provider: "pan115", cookie: "UID=1;CID=2", scopeCids: ["root"] });
    expect(exec).toBeInstanceOf(Storage115Executor);
  });

  it("quark → QuarkStorageExecutor", () => {
    const exec = createExecutorForBrand({ provider: "quark", cookie: "__uid=1", scopeCids: ["ROOT"] });
    expect(exec).toBeInstanceOf(QuarkStorageExecutor);
  });

  it("guangya → GuangYaStorageExecutor (from a token credential blob, no cookie)", () => {
    const exec = createExecutorForBrand({
      provider: "guangya",
      credential: { accessToken: "AT", refreshToken: "RT", deviceId: "d" },
      scopeCids: ["root"],
    });
    expect(exec).toBeInstanceOf(GuangYaStorageExecutor);
  });

  it("unknown provider throws", () => {
    expect(() => createExecutorForBrand({ provider: "baidu", cookie: "x", scopeCids: ["y"] })).toThrowError(
      /unknown storage brand/i,
    );
  });
});
