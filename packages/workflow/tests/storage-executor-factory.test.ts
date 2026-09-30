import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExecutorForBrand,
  QuarkStorageExecutor,
  Storage115Executor,
  STORAGE_BRANDS,
} from "../src/index.js";
import { GuangYaStorageExecutor } from "../src/guangya-storage-executor.js";
import { Pan123StorageExecutor } from "../src/pan123-storage-executor.js";
import { TianyiStorageExecutor } from "../src/tianyi-storage-executor.js";
import * as barrel from "../src/index.js";

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

  it("tianyi → TianyiStorageExecutor (from a token credential blob, no cookie)", () => {
    const exec = createExecutorForBrand({
      provider: "tianyi",
      credential: { sessionKey: "SK", accessToken: "AT", refreshToken: "RT" },
      scopeCids: ["s1"],
    });
    expect(exec).toBeInstanceOf(TianyiStorageExecutor);
  });

  it("tianyi constructs across the optional paths (familySessionKey / onCredentialRefresh present and absent)", () => {
    // exactOptionalPropertyTypes pin: the factory must not set optional client
    // options to `undefined` — both shapes must construct.
    const bare = createExecutorForBrand({
      provider: "tianyi",
      credential: { sessionKey: "SK", accessToken: "AT", refreshToken: "RT" },
      scopeCids: ["s1"],
    });
    expect(bare).toBeInstanceOf(TianyiStorageExecutor);

    const full = createExecutorForBrand({
      provider: "tianyi",
      credential: {
        sessionKey: "SK",
        accessToken: "AT",
        refreshToken: "RT",
        familySessionKey: "FSK",
      },
      scopeCids: ["s1"],
      onCredentialRefresh: () => {},
    });
    expect(full).toBeInstanceOf(TianyiStorageExecutor);
  });

  it("pan123 → Pan123StorageExecutor (from a token credential blob, no cookie)", () => {
    const exec = createExecutorForBrand({
      provider: "pan123",
      credential: { token: "TK" },
      scopeCids: ["s1"],
    });
    expect(exec).toBeInstanceOf(Pan123StorageExecutor);
  });

  it("pan123 constructs when the credential is missing or empty (token falls back to '')", () => {
    const empty = createExecutorForBrand({ provider: "pan123", credential: {}, scopeCids: ["s1"] });
    expect(empty).toBeInstanceOf(Pan123StorageExecutor);

    const absent = createExecutorForBrand({ provider: "pan123", scopeCids: ["s1"] });
    expect(absent).toBeInstanceOf(Pan123StorageExecutor);
  });

  it("barrel exports the three pan123 modules (client / qrcode login / executor)", () => {
    expect(barrel.Pan123StorageExecutor).toBe(Pan123StorageExecutor);
    expect(typeof barrel.Pan123Client).toBe("function");
    expect(typeof barrel.Pan123QrLoginClient).toBe("function");
  });

  it("barrel exports the three tianyi modules (client / qrcode login / executor)", () => {
    expect(barrel.TianyiStorageExecutor).toBe(TianyiStorageExecutor);
    expect(typeof barrel.TianyiClient).toBe("function");
    expect(typeof barrel.TianyiQrLoginClient).toBe("function");
  });

  it("unknown provider throws", () => {
    expect(() => createExecutorForBrand({ provider: "baidu", cookie: "x", scopeCids: ["y"] })).toThrowError(
      /unknown storage brand/i,
    );
  });
});

describe("STORAGE_BRANDS writeScope", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A staging recovery walks down from the category dirs only on "listed" drives. A brand
  // marked "parents" whose executor really checks listings would refuse every recovery
  // write (2026-09-30 production), so the registry value is checked against the executor.
  for (const brand of STORAGE_BRANDS) {
    it(`${brand.provider} (${brand.writeScope}): the executor checks writes the way the registry says`, async () => {
      const fetchMock = vi.fn(async () => {
        throw new Error("offline (test)");
      });
      vi.stubGlobal("fetch", fetchMock);
      const executor = createExecutorForBrand({
        provider: brand.provider,
        cookie: "UID=1_A1_2;CID=2;SEID=3;__uid=1",
        credential: { token: "TK", accessToken: "AT", refreshToken: "RT", sessionKey: "SK" },
        scopeCids: ["scope-root"],
        env: {},
      });
      const error: unknown = await executor.removeDirectory("never-listed").then(
        () => null,
        (rejected: unknown) => rejected,
      );
      expect(error).not.toBeNull();
      if (brand.writeScope === "listed") {
        // Refused from what this executor has listed, without asking the drive.
        expect(String(error)).toMatch(/WRITE_SCOPE_VIOLATION/);
        expect(fetchMock).not.toHaveBeenCalled();
      } else {
        // Looked the directory up on the drive before deciding.
        expect(fetchMock).toHaveBeenCalled();
      }
    });
  }
});
