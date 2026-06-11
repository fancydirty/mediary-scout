import { describe, expect, it } from "vitest";
import {
  Pan115ApiGuard,
  Pan115RiskControlError,
  Storage115Executor,
  type Pan115ActionResult,
  type Pan115DirectoryInfo,
  type Pan115Item,
  type Pan115StorageApi,
  type ResourceCandidate,
} from "../src/index.js";

describe("Storage115Executor", () => {
  it("transfers a selected 115 candidate and verifies newly materialized video files", async () => {
    const api = new FakePan115Api({
      shareFiles: {
        abc123: [
          {
            fid: "file_1",
            n: "Show.S01E01.mkv",
            s: "1000000000",
          },
        ],
      },
    });
    const executor = new Storage115Executor({ api });

    const attempt = await executor.transfer({
      workflowRunId: "run_1",
      directoryId: "123",
      candidate: candidateFixture({
        type: "115",
        providerPayload: {
          url: "https://115.com/s/abc123?password=pw",
          rawType: "115",
        },
      }),
    });

    expect(api.receivedShares).toEqual([
      {
        shareCode: "abc123",
        receiveCode: "pw",
        directoryId: "123",
      },
    ]);
    expect(attempt).toMatchObject({
      workflowRunId: "run_1",
      candidateId: "candidate_1",
      status: "succeeded",
      providerMessage: "",
      materializedFileIds: ["file_1"],
    });
    await expect(executor.listVideoFiles("123")).resolves.toEqual([
      {
        id: "file_1",
        storageDirectoryId: "123",
        name: "Show.S01E01.mkv",
        sizeBytes: 1_000_000_000,
        episodeCode: "S01E01",
        providerFileId: "file_1",
      },
    ]);
  });

  it("records duplicate 115 transfers as no target change", async () => {
    const api = new FakePan115Api({
      receiveShareResults: {
        abc123: {
          ok: false,
          message: "资源已转存过(可能在其他目录)，目标目录未新增文件",
          alreadyTransferred: true,
        },
      },
    });
    const executor = new Storage115Executor({ api });

    const attempt = await executor.transfer({
      workflowRunId: "run_1",
      directoryId: "123",
      candidate: candidateFixture({
        type: "115",
        providerPayload: {
          url: "https://115.com/s/abc123?password=pw",
          rawType: "115",
        },
      }),
    });

    expect(attempt).toMatchObject({
      candidateId: "candidate_1",
      status: "no_target_change",
      providerMessage: "资源已转存过(可能在其他目录)，目标目录未新增文件",
      materializedFileIds: [],
    });
  });

  it("adds magnet candidates as offline tasks through 115", async () => {
    const api = new FakePan115Api();
    const executor = new Storage115Executor({ api });

    const attempt = await executor.transfer({
      workflowRunId: "run_1",
      directoryId: "123",
      candidate: candidateFixture({
        type: "magnet",
        providerPayload: {
          url: "magnet:?xt=urn:btih:abcdef",
          rawType: "magnet",
        },
      }),
    });

    expect(api.offlineTasks).toEqual([
      {
        url: "magnet:?xt=urn:btih:abcdef",
        directoryId: "123",
      },
    ]);
    expect(attempt).toMatchObject({
      status: "no_target_change",
      providerMessage: "offline task accepted; no target video materialized yet",
      materializedFileIds: [],
    });
  });

  it("rejects flattening protected directories", async () => {
    const executor = new Storage115Executor({
      api: new FakePan115Api(),
      protectedDirectoryIds: ["0", "tv_root"],
    });

    await expect(executor.flattenDirectory("tv_root")).rejects.toThrow(
      "SAFETY_VIOLATION: refusing to flatten protected directory cid=tv_root",
    );
  });

  it("moves nested videos to a safe season leaf and removes empty child folders", async () => {
    const api = new FakePan115Api({
      directories: {
        season_1: [
          {
            cid: "nested_1",
            n: "Pack",
            fc: "0",
          },
        ],
        nested_1: [
          {
            fid: "nested_file_1",
            n: "Show.S01E02.mkv",
            s: "2000000000",
          },
        ],
      },
      directoryInfo: {
        season_1: {
          state: true,
          path: [
            { cid: "0", name: "root" },
            { cid: "tv_root", name: "TV Shows" },
            { cid: "show_1", name: "Show" },
            { cid: "season_1", name: "Season 1" },
          ],
        },
      },
    });
    const executor = new Storage115Executor({ api, protectedDirectoryIds: ["0", "tv_root"] });

    const result = await executor.flattenDirectory("season_1");

    expect(api.moves).toEqual([
      {
        fileIds: ["nested_file_1"],
        targetDirectoryId: "season_1",
      },
    ]);
    expect(api.deletes).toEqual([
      {
        fileIds: ["nested_1"],
      },
    ]);
    expect(result).toEqual({
      moved: ["nested_file_1"],
      removed: ["nested_1"],
    });
  });

  it("spaces 115 API calls through the configured guard", async () => {
    const api = new FakePan115Api({
      shareFiles: {
        abc123: [
          {
            fid: "file_1",
            n: "Show.S01E01.mkv",
            s: "1000000000",
          },
        ],
      },
    });
    let now = 0;
    const sleeps: number[] = [];
    const guard = new Pan115ApiGuard({
      minDelayMs: 750,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    const executor = new Storage115Executor({ api, apiGuard: guard });

    await executor.transfer({
      workflowRunId: "run_1",
      directoryId: "123",
      candidate: candidateFixture({
        type: "115",
        providerPayload: {
          url: "https://115.com/s/abc123?password=pw",
          rawType: "115",
        },
      }),
    });

    expect(api.listCalls).toEqual(["123", "123"]);
    expect(api.receivedShares).toHaveLength(1);
    expect(sleeps).toEqual([750, 750]);
  });

  it("opens a circuit breaker when 115 returns a risk-control signal", async () => {
    const api = new FakePan115Api({
      receiveShareResults: {
        abc123: {
          ok: false,
          message: "请求过于频繁，请稍后再试",
          code: 429,
        },
      },
    });
    const events: string[] = [];
    const guard = new Pan115ApiGuard({
      onEvent: (event) => events.push(event.kind),
    });
    const executor = new Storage115Executor({ api, apiGuard: guard });

    await expect(
      executor.transfer({
        workflowRunId: "run_1",
        directoryId: "123",
        candidate: candidateFixture({
          type: "115",
          providerPayload: {
            url: "https://115.com/s/abc123?password=pw",
            rawType: "115",
          },
        }),
      }),
    ).rejects.toBeInstanceOf(Pan115RiskControlError);

    await expect(executor.listVideoFiles("123")).rejects.toThrow("circuit breaker open");
    expect(api.listCalls).toEqual(["123"]);
    expect(events).toContain("risk_detected");
    expect(events).toContain("circuit_open");
  });

  it("stops before exceeding the configured 115 API call budget", async () => {
    const api = new FakePan115Api({
      shareFiles: {
        abc123: [
          {
            fid: "file_1",
            n: "Show.S01E01.mkv",
            s: "1000000000",
          },
        ],
      },
    });
    const guard = new Pan115ApiGuard({ maxCallsPerOperation: 2 });
    const executor = new Storage115Executor({ api, apiGuard: guard });

    await expect(
      executor.transfer({
        workflowRunId: "run_1",
        directoryId: "123",
        candidate: candidateFixture({
          type: "115",
          providerPayload: {
            url: "https://115.com/s/abc123?password=pw",
            rawType: "115",
          },
        }),
      }),
    ).rejects.toThrow("API call budget exhausted");
    expect(api.listCalls).toEqual(["123"]);
    expect(api.receivedShares).toHaveLength(1);
  });

  it("stops scanning when a list response is too large for the guard policy", async () => {
    const api = new FakePan115Api({
      directories: {
        big: Array.from({ length: 231 }, (_, index) => ({
          fid: `file_${index}`,
          n: `NonVideo.${index}.txt`,
          s: "100",
        })),
      },
    });
    const guard = new Pan115ApiGuard({ maxListItemsPerResponse: 230 });
    const executor = new Storage115Executor({ api, apiGuard: guard });

    await expect(executor.listVideoFiles("big")).rejects.toThrow(
      "listItems returned 231 items, above maxListItemsPerResponse=230",
    );
    await expect(executor.listVideoFiles("big")).rejects.toThrow("circuit breaker open");
    expect(api.listCalls).toEqual(["big"]);
  });
});

class FakePan115Api implements Pan115StorageApi {
  readonly directories: Record<string, Pan115Item[]>;
  readonly shareFiles: Record<string, Pan115Item[]>;
  readonly receiveShareResults: Record<string, Pan115ActionResult>;
  readonly directoryInfo: Record<string, Pan115DirectoryInfo>;
  readonly receivedShares: Array<{ shareCode: string; receiveCode: string; directoryId: string }> = [];
  readonly offlineTasks: Array<{ url: string; directoryId: string }> = [];
  readonly moves: Array<{ fileIds: string[]; targetDirectoryId: string }> = [];
  readonly deletes: Array<{ fileIds: string[] }> = [];
  readonly listCalls: string[] = [];
  private nextFolder = 1;

  constructor(input: {
    directories?: Record<string, Pan115Item[]>;
    shareFiles?: Record<string, Pan115Item[]>;
    receiveShareResults?: Record<string, Pan115ActionResult>;
    directoryInfo?: Record<string, Pan115DirectoryInfo>;
  } = {}) {
    this.directories = cloneDirectories(input.directories ?? {});
    this.shareFiles = cloneDirectories(input.shareFiles ?? {});
    this.receiveShareResults = { ...(input.receiveShareResults ?? {}) };
    this.directoryInfo = { ...(input.directoryInfo ?? {}) };
  }

  async createFolder(input: { name: string; parentId: string }): Promise<string> {
    const id = `${input.parentId}_${input.name}_${this.nextFolder}`;
    this.nextFolder += 1;
    this.directories[id] = [];
    return id;
  }

  async listItems(input: { directoryId: string }): Promise<Pan115Item[]> {
    this.listCalls.push(input.directoryId);
    return [...(this.directories[input.directoryId] ?? [])];
  }

  async getDirectoryInfo(input: { directoryId: string }): Promise<Pan115DirectoryInfo | null> {
    return this.directoryInfo[input.directoryId] ?? {
      state: true,
      path: [
        { cid: "0", name: "root" },
        { cid: input.directoryId, name: "Season 1" },
      ],
    };
  }

  async receiveShare(input: {
    shareCode: string;
    receiveCode: string;
    directoryId: string;
  }): Promise<Pan115ActionResult> {
    this.receivedShares.push({ ...input });
    const configuredResult = this.receiveShareResults[input.shareCode];
    if (configuredResult) {
      return configuredResult;
    }
    const files = this.shareFiles[input.shareCode] ?? [];
    this.directories[input.directoryId] = [...(this.directories[input.directoryId] ?? []), ...files];
    return { ok: true, message: "" };
  }

  async addOfflineTask(input: { url: string; directoryId: string }): Promise<Pan115ActionResult> {
    this.offlineTasks.push({ ...input });
    return { ok: true, message: "offline task accepted" };
  }

  async moveItems(input: { fileIds: string[]; targetDirectoryId: string }): Promise<Pan115ActionResult> {
    this.moves.push({ fileIds: [...input.fileIds], targetDirectoryId: input.targetDirectoryId });
    const movedItems: Pan115Item[] = [];
    const wantedFileIds = new Set(input.fileIds);
    for (const [directoryId, items] of Object.entries(this.directories)) {
      const remaining: Pan115Item[] = [];
      for (const item of items) {
        const fileId = String(item.fid ?? item.file_id ?? item.id ?? "");
        if (wantedFileIds.has(fileId)) {
          movedItems.push(item);
        } else {
          remaining.push(item);
        }
      }
      this.directories[directoryId] = remaining;
    }
    this.directories[input.targetDirectoryId] = [
      ...(this.directories[input.targetDirectoryId] ?? []),
      ...movedItems,
    ];
    return { ok: true, message: "" };
  }

  async deleteItems(input: { fileIds: string[] }): Promise<Pan115ActionResult> {
    this.deletes.push({ fileIds: [...input.fileIds] });
    return { ok: true, message: "" };
  }
}

function candidateFixture(input: {
  type: ResourceCandidate["type"];
  providerPayload: Record<string, unknown>;
}): ResourceCandidate {
  return {
    id: "candidate_1",
    snapshotId: "snapshot_1",
    index: 0,
    title: "Show S01E01",
    type: input.type,
    source: "pansou",
    episodeHints: ["S01E01"],
    qualityHints: ["4K"],
    providerPayload: input.providerPayload,
  };
}

function cloneDirectories(input: Record<string, Pan115Item[]>): Record<string, Pan115Item[]> {
  return Object.fromEntries(
    Object.entries(input).map(([directoryId, items]) => [
      directoryId,
      items.map((item) => ({ ...item })),
    ]),
  );
}
