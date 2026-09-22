# 115 字幕包 API 预算修复 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让一个 N 文件的 assrt 字幕包在 115 上只花 O(N + 轮询) 次 API 调用（22 文件 ≈ 36 次，原 260–440），并让转存类调用在硬上限之前的保留额处被拒，收尾（搬季目录 / 删 staging）永远有额度。

**Architecture:** 三层。(1) `Pan115ApiGuard` 加「转存保留额」：`receiveShare` / `addOfflineTask` 在 `hard − reserve` 处被拒，其它操作跑到硬上限；两个 115 工厂传入常量 40。(2) `Storage115Executor.transferSubtitleUrls` 整包一次：写域校验 1 + before 快照 1 + N 次提交 + 每轮 1 次深 1 列目录的统一轮询 + 一次批量取消；单文件方法委托批量。(3) `StorageV2` 表面改为批量方法，模拟器成本 1 + N，`RealStorageV2` 有批量用批量、否则逐文件循环 + 连续 3 败熔断（从 sandbox 下沉），sandbox 一次调用整包。

**Tech Stack:** TypeScript (ESM, `.js` import suffix), Vitest 4, npm workspaces. 测试在 `packages/workflow/tests/*.test.ts`；跑单文件用 `npx vitest run <path>`。

**Spec:** `docs/superpowers/specs/2026-09-20-115-subtitle-budget-design.md`（本目录 gitignored，本地可读）。

---

## Global Constraints

- 分支 `fix/115-subtitle-budget`（已从 `origin/main` c49300c 开在本 worktree）。**不碰 `feat/jev-prefilter`，不部署生产，不动欺诈游戏的脏状态。**
- 每个生产代码改动都走 RED → 验证 RED → GREEN → 验证 GREEN。
- 提交**显式列文件**，绝不 `git add -A`（本地草稿会被扫进）。提交信息末尾带 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。
- 不调大 300、不加 env 开关、不改光鸭执行器、不改 orchestrator 能力门控、不改视频转存窗口。
- 现有测试文本断言必须继续成立：硬上限消息含 `maxCallsPerOperation=N` 与 `API call budget exhausted`；`BUDGET_REMINDER` 含 `markObtained` / `discardStaging` / `flattenMovie` / `不是失败|正常|巡检`；`transferSubtitleUrl` 单文件 10 条测试不改。
- 门槛命令（Task 6 全跑）：`npm run typecheck`、`npx tsc -p apps/web/tsconfig.json --noEmit`、`npm run build:workflow`、`npx vitest run`、`npm run lint`。

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/workflow/src/storage-115-executor.ts` | 115 执行器 + `Pan115ApiGuard` + 受保护工厂 | guard 保留额、`PAN115_TRANSFER_RESERVE_CALLS`、`apiTransferCallBudget()`、`transferSubtitleUrls` 批量、单文件委托 |
| `packages/workflow/src/pan115-storage-factory.ts` | bootstrap 工厂 | 传入保留额常量 |
| `packages/workflow/src/acquisition-v2/agent-loop-guards.ts` | 软提醒文案/阈值 | `BUDGET_REMINDER` 加一句 |
| `packages/workflow/src/ports.ts` | `StorageExecutor` 端口 | 可选 `transferSubtitleUrls?` |
| `packages/workflow/src/acquisition-v2/storage-115-simulator.ts` | `StorageV2` 接口 + 模拟器 | `SubtitleLandingResult`、接口改批量、模拟器批量 1 + N |
| `packages/workflow/src/acquisition-v2/real-storage-adapter.ts` | 真执行器 → StorageV2 | 批量优先 / 循环熔断兜底 |
| `packages/workflow/src/acquisition-v2/sandbox.ts` | agent 工具沙盒 | `transferSubtitle` 一次交整包 |
| `docs/115-api-safety-notes.md` | 115 安全笔记 | 记录分层预算 |
| `packages/workflow/tests/pan115-guard-transfer-reserve.test.ts` | 新 | guard 分层测试 |
| `packages/workflow/tests/storage-115-executor.test.ts` | 现有 | 工厂保留额 + 批量账目测试 |
| `packages/workflow/tests/agent-loop-guards.test.ts` | 现有 | 顺序 + 文案测试 |
| `packages/workflow/tests/v2-storage-115-simulator.test.ts` | 现有 | 批量成本测试 |
| `packages/workflow/tests/v2-real-storage-adapter.test.ts` | 现有 | 批量优先 / 熔断迁入 |
| `packages/workflow/tests/v2-sandbox-subtitle.test.ts` | 现有 | 改为批量表面 |

---

### Task 1: `Pan115ApiGuard` 转存保留额 + 两个工厂

**Files:**
- Modify: `packages/workflow/src/storage-115-executor.ts`（`Pan115ApiGuardOptions` ~L164、`Pan115ApiGuard` ~L180–330、`Storage115Executor.apiCallBudget` ~L377、`createProtectedStorage115Executor` ~L1087–1103）
- Modify: `packages/workflow/src/pan115-storage-factory.ts`（bootstrap 工厂 ~L60–80）
- Create: `packages/workflow/tests/pan115-guard-transfer-reserve.test.ts`
- Modify: `packages/workflow/tests/storage-115-executor.test.ts`（在 `describe("Storage115Executor.transferSubtitleUrl"` 之前追加一个 describe）

- [ ] **Step 1: 写 guard 分层的失败测试（新文件）**

```ts
// packages/workflow/tests/pan115-guard-transfer-reserve.test.ts
import { describe, expect, it } from "vitest";
import {
  Pan115ApiGuard,
  Pan115RiskControlError,
  PAN115_TRANSFER_RESERVE_CALLS,
  type Pan115ApiGuardEvent,
} from "../src/index.js";

/** Spend `n` calls on a listing (never transfer-class). */
async function spendListings(guard: Pan115ApiGuard, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await guard.run("listItems", async () => []);
  }
}

describe("Pan115ApiGuard transfer reserve (预算分层:转存类在硬上限之前的保留额处被拒)", () => {
  it("reserve 0 (default) is the plain hard cap — transfers run right up to it", async () => {
    const guard = new Pan115ApiGuard({ maxCallsPerOperation: 3 });
    expect(guard.transferCallBudget()).toBe(3);
    await spendListings(guard, 2);
    await guard.run("receiveShare", async () => ({ ok: true, message: "" })); // call #3 allowed
    await expect(guard.run("receiveShare", async () => ({ ok: true, message: "" }))).rejects.toThrow(
      "API call budget exhausted before receiveShare; maxCallsPerOperation=3",
    );
  });

  it("refuses receiveShare / addOfflineTask once callCount reaches hard − reserve, while listing/moving/deleting/renaming run to the hard limit", async () => {
    const guard = new Pan115ApiGuard({ maxCallsPerOperation: 10, transferReserveCalls: 4 });
    expect(guard.transferCallBudget()).toBe(6);
    await spendListings(guard, 6);
    await expect(guard.run("receiveShare", async () => ({ ok: true, message: "" }))).rejects.toBeInstanceOf(
      Pan115RiskControlError,
    );
    await expect(guard.run("addOfflineTask", async () => ({ ok: true, message: "" }))).rejects.toThrow(
      /PAN115_RATE_LIMIT: transfer budget exhausted before addOfflineTask/,
    );
    // Wrap-up class keeps going: 4 more calls fit before the hard limit.
    await guard.run("getDirectoryInfo", async () => null);
    await guard.run("moveItems", async () => ({ ok: true, message: "" }));
    await guard.run("deleteItems", async () => ({ ok: true, message: "" }));
    await guard.run("renameFile", async () => ({ ok: true, message: "" }));
    expect(guard.callsSpent()).toBe(10);
    await expect(guard.run("listItems", async () => [])).rejects.toThrow("maxCallsPerOperation=10");
  });

  it("listOfflineTasks / removeOfflineTask (cleanup) and createFolder are NOT transfer-class", async () => {
    const guard = new Pan115ApiGuard({ maxCallsPerOperation: 5, transferReserveCalls: 3 });
    await spendListings(guard, 2); // at the transfer cutoff (5 − 3 = 2)
    await guard.run("listOfflineTasks", async () => []);
    await guard.run("removeOfflineTask", async () => ({ ok: true, message: "" }));
    await guard.run("createFolder", async () => "id");
    expect(guard.callsSpent()).toBe(5);
  });

  it("a reserve refusal is NOT counted and does NOT open the circuit", async () => {
    const events: Pan115ApiGuardEvent[] = [];
    const guard = new Pan115ApiGuard({ maxCallsPerOperation: 4, transferReserveCalls: 2, onEvent: (e) => events.push(e) });
    await spendListings(guard, 2);
    await expect(guard.run("receiveShare", async () => ({ ok: true, message: "" }))).rejects.toThrow();
    expect(guard.callsSpent()).toBe(2);
    expect(events.map((e) => e.kind)).toEqual(["budget_exhausted"]);
    await guard.run("listItems", async () => []); // circuit still closed
    expect(guard.callsSpent()).toBe(3);
  });

  it("the refusal tells the agent what the remaining calls are for (wrap-up), with the numbers", async () => {
    const guard = new Pan115ApiGuard({ maxCallsPerOperation: 10, transferReserveCalls: 4 });
    await spendListings(guard, 7);
    await expect(guard.run("addOfflineTask", async () => ({ ok: true, message: "" }))).rejects.toThrow(
      /7 of maxCallsPerOperation=10 calls spent.*transfers stop at 6.*remaining 3 calls are reserved for wrap-up.*moveToSeason.*discardStaging/,
    );
  });

  it("transferCallBudget never drops below 1 for a tiny hard limit", () => {
    expect(new Pan115ApiGuard({ maxCallsPerOperation: 2, transferReserveCalls: 40 }).transferCallBudget()).toBe(1);
  });

  it("the shipped reserve keeps the 拍板 ordering: soft 240 < transfer stop 260 < hard 300", () => {
    expect(PAN115_TRANSFER_RESERVE_CALLS).toBe(40);
    const guard = new Pan115ApiGuard({ maxCallsPerOperation: 300, transferReserveCalls: PAN115_TRANSFER_RESERVE_CALLS });
    expect(guard.transferCallBudget()).toBe(260);
  });
});
```

- [ ] **Step 2: 跑，确认失败**

Run: `npx vitest run packages/workflow/tests/pan115-guard-transfer-reserve.test.ts`
Expected: FAIL — `PAN115_TRANSFER_RESERVE_CALLS` 不是导出 / `transferCallBudget is not a function`。

- [ ] **Step 3: 写工厂的失败测试（追加到 `storage-115-executor.test.ts`，放在 `describe("Storage115Executor.transferSubtitleUrl"` 之前）**

```ts
describe("115 factories wire the transfer reserve (收尾永远有额度)", () => {
  it("createProtectedStorage115Executor: transfers stop at hard − PAN115_TRANSFER_RESERVE_CALLS, listings continue", async () => {
    const api = new FakePan115Api({
      directories: { season_1: [] },
      directoryInfo: { season_1: seasonPathInfo("test_root", "season_1") },
    });
    const executor = createProtectedStorage115Executor({
      api,
      env: {
        MEDIA_TRACK_115_TEST_ROOT_CID: "test_root",
        MEDIA_TRACK_115_MAX_API_CALLS: "44", // transfer cutoff = 44 − 40 = 4
        MEDIA_TRACK_115_MIN_DELAY_MS: "1",
      },
    });
    expect(executor.apiCallBudget()).toBe(44);
    expect(executor.apiTransferCallBudget()).toBe(4);
    for (let i = 0; i < 4; i += 1) {
      await executor.listVideoFiles("season_1");
    }
    // transfer(): write-scope check (getDirectoryInfo) + before listing are allowed
    // past the cutoff; the receiveShare itself is refused — nothing is received.
    await expect(
      executor.transfer({
        workflowRunId: "run_1",
        directoryId: "season_1",
        candidate: candidateFixture({
          type: "115",
          providerPayload: { url: "https://115.com/s/abc123?password=pw", rawType: "115" },
        }),
      }),
    ).rejects.toThrow(/transfer budget exhausted before receiveShare/);
    expect(api.receivedShares).toHaveLength(0);
    await executor.listVideoFiles("season_1"); // still allowed (wrap-up class)
  });

  it("createBootstrapPan115CookieStorageExecutor carries the same reserve (kept in sync)", () => {
    const executor = createBootstrapPan115CookieStorageExecutor({ cookie: "UID=1_abc" });
    expect(executor.apiCallBudget()).toBe(300);
    expect(executor.apiTransferCallBudget()).toBe(300 - PAN115_TRANSFER_RESERVE_CALLS);
  });
});
```

并在文件顶部 import 列表加 `PAN115_TRANSFER_RESERVE_CALLS,`（`../src/index.js` 已是来源）。

- [ ] **Step 4: 跑，确认失败**

Run: `npx vitest run packages/workflow/tests/storage-115-executor.test.ts -t "transfer reserve"`
Expected: FAIL（`apiTransferCallBudget is not a function`）。

- [ ] **Step 5: 实现 guard 分层**

在 `packages/workflow/src/storage-115-executor.ts`：

(a) `type Pan115Operation = keyof Pan115StorageApi;` 之后加：

```ts
/** Operations that INGEST new content into the drive (a share receive / an
 *  offline task). These are the calls a transfer reserve refuses first — see
 *  Pan115ApiGuardOptions.transferReserveCalls. Everything else (listing, moving,
 *  deleting, renaming, folder creation, offline-task cleanup) is what a run needs
 *  to WRAP UP, and keeps running to the hard limit. */
const PAN115_TRANSFER_OPERATIONS: ReadonlySet<Pan115Operation> = new Set<Pan115Operation>([
  "receiveShare",
  "addOfflineTask",
]);

/** Calls held back from transfers so the wrap-up (inspectStaging + moveToSeason /
 *  flattenMovie + discardStaging) always fits: default hard 300 → transfers stop
 *  at 260 while listing/moving/deleting run to 300. Sits ABOVE the agent's soft
 *  nudge (240 = 300 − BUDGET_SOFT_HEADROOM) so the agent is warned first and keeps
 *  ~20 calls of its own discretion before the mechanical stop. One wrap-up pass on
 *  a 3-pack staging costs ~15–20 calls (2026-09-20 LIAR GAME run d98dc4ca: a
 *  22-file subtitle package spent 260 calls in ONE step, the wrap-up then hit the
 *  hard limit and 15 episodes stayed in staging); 40 fits one pass and a half. */
export const PAN115_TRANSFER_RESERVE_CALLS = 40;
```

(b) `Pan115ApiGuardOptions` 里 `maxCallsPerOperation?: number;` 之后加：

```ts
  /** Calls held back from TRANSFER-class operations (receiveShare / addOfflineTask):
   *  they are refused once callCount reaches maxCallsPerOperation − this value,
   *  while every other operation keeps running to the hard limit — so a run that
   *  spent its budget on transfers can still move landed files into their season
   *  and discard staging. Default 0 = no tiering (a plain hard cap). */
  transferReserveCalls?: number;
```

(c) `Pan115ApiGuard` 类：字段 `private readonly maxCallsPerOperation: number;` 后加 `private readonly transferReserveCalls: number;`；构造函数 `this.maxCallsPerOperation = ...` 后加 `this.transferReserveCalls = Math.max(0, options.transferReserveCalls ?? 0);`；`callBudget()` 之后加：

```ts
  /** The TRANSFER call budget: receiveShare / addOfflineTask are refused once
   *  callCount reaches this (hard limit minus the wrap-up reserve, never below 1).
   *  Equals callBudget() when no reserve is configured. */
  transferCallBudget(): number {
    return Math.max(1, this.maxCallsPerOperation - this.transferReserveCalls);
  }
```

(d) 替换整个 `private assertBudget(operation: Pan115Operation): void { ... }`：

```ts
  private assertBudget(operation: Pan115Operation): void {
    const limit = PAN115_TRANSFER_OPERATIONS.has(operation)
      ? this.transferCallBudget()
      : this.maxCallsPerOperation;
    if (this.callCount < limit) {
      return;
    }
    // A transfer refused inside the reserve zone gets a message that says what the
    // remaining calls are FOR — the agent reads it as tool output and must switch to
    // wrapping up, not retry. Neither refusal is counted nor opens the circuit.
    const remaining = Math.max(0, this.maxCallsPerOperation - this.callCount);
    const message =
      limit < this.maxCallsPerOperation
        ? `PAN115_RATE_LIMIT: transfer budget exhausted before ${operation}; ` +
          `${this.callCount} of maxCallsPerOperation=${this.maxCallsPerOperation} calls spent, ` +
          `transfers stop at ${limit} and the remaining ${remaining} calls are reserved for wrap-up ` +
          `(moveToSeason / flattenMovie / discardStaging / finish) — do not transfer again, wrap up now`
        : `PAN115_RATE_LIMIT: API call budget exhausted before ${operation}; ` +
          `maxCallsPerOperation=${this.maxCallsPerOperation}`;
    this.onEvent({
      kind: "budget_exhausted",
      operation,
      callCount: this.callCount,
      message,
    });
    throw new Pan115RiskControlError(message);
  }
```

(e) `Storage115Executor.apiCallBudget()` 之后加：

```ts
  /** The TRANSFER call budget (hard limit minus the wrap-up reserve): where
   *  receiveShare / addOfflineTask start being refused. Also the executor's own
   *  stop line for subtitle landing polls — polling must never eat the reserve. */
  apiTransferCallBudget(): number {
    return this.apiGuard.transferCallBudget();
  }
```

(f) `createProtectedStorage115Executor` 的 `apiGuardOptions` 对象里，`maxCallsPerOperation: ... ?? 300,` 之后加：

```ts
      // Wrap-up reserve: transfers stop at maxCallsPerOperation − 40 (default 260),
      // listing/moving/deleting continue to the hard limit. See PAN115_TRANSFER_RESERVE_CALLS.
      transferReserveCalls: PAN115_TRANSFER_RESERVE_CALLS,
```

- [ ] **Step 6: bootstrap 工厂同步**

`packages/workflow/src/pan115-storage-factory.ts`：import 列表加 `PAN115_TRANSFER_RESERVE_CALLS,`（来自 `./storage-115-executor.js`），`createBootstrapPan115CookieStorageExecutor` 的 `apiGuardOptions` 里 `maxCallsPerOperation: ...` 之后加：

```ts
      // Same wrap-up reserve as createProtectedStorage115Executor (kept in sync).
      transferReserveCalls: PAN115_TRANSFER_RESERVE_CALLS,
```

- [ ] **Step 7: 跑，确认通过（含旧测试）**

Run: `npx vitest run packages/workflow/tests/pan115-guard-transfer-reserve.test.ts packages/workflow/tests/storage-115-executor.test.ts packages/workflow/tests/pan115-guard-calls-spent.test.ts`
Expected: 全 PASS。

- [ ] **Step 8: 提交**

```bash
git add packages/workflow/src/storage-115-executor.ts packages/workflow/src/pan115-storage-factory.ts packages/workflow/tests/pan115-guard-transfer-reserve.test.ts packages/workflow/tests/storage-115-executor.test.ts
git commit -m "feat(115): 预算分层——转存类调用在硬上限前 40 次的保留额处被拒,收尾永远有额度

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: 软提醒文案 + 阈值顺序钉死

**Files:**
- Modify: `packages/workflow/src/acquisition-v2/agent-loop-guards.ts`（`BUDGET_REMINDER` ~L47–54）
- Modify: `packages/workflow/tests/agent-loop-guards.test.ts`（`describe("budgetSoftThreshold` 块内追加）

- [ ] **Step 1: 写失败测试**

在 `agent-loop-guards.test.ts` 顶部 import 加 `PAN115_TRANSFER_RESERVE_CALLS,`（来自 `../src/index.js`，与现有 import 同源）。在 `describe("budgetSoftThreshold (derive soft from configured hard)"` 内追加：

```ts
  it("soft nudge fires BELOW the mechanical transfer stop, which sits BELOW the hard limit (240 < 260 < 300)", () => {
    const hard = 300;
    const transferStop = hard - PAN115_TRANSFER_RESERVE_CALLS;
    expect(budgetSoftThreshold(hard)).toBeLessThan(transferStop);
    expect(transferStop).toBeLessThan(hard);
  });
```

在 `describe("budgetReflectionNudge` 内追加：

```ts
  it("reminder tells the agent transfers get refused mechanically inside the reserve (so a refusal reads as 'wrap up', not 'retry')", () => {
    expect(BUDGET_REMINDER).toMatch(/保留额/);
    expect(BUDGET_REMINDER).toContain("transferSubtitle");
  });
```

- [ ] **Step 2: 跑，确认失败**

Run: `npx vitest run packages/workflow/tests/agent-loop-guards.test.ts`
Expected: 新增两条 FAIL（`保留额` 不在文案里）。

- [ ] **Step 3: 改文案**

`BUDGET_REMINDER` 最后一句 `"请立刻稳妥收尾:调用一旦到硬上限会被强制中断,别把预算耗在还没收尾上。"` 之后追加一段字符串：

```ts
  "系统会在硬上限之前的保留额处直接拒绝转存类调用(transferCandidate / transferUntilLanded / transferSubtitle),剩余额度只留给收尾——转存被拒不是让你换一个再试,是必须立刻收尾的信号。";
```

（用 `+` 拼接，保持常量为一个字符串。）

- [ ] **Step 4: 跑，确认通过**

Run: `npx vitest run packages/workflow/tests/agent-loop-guards.test.ts`
Expected: 全 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/workflow/src/acquisition-v2/agent-loop-guards.ts packages/workflow/tests/agent-loop-guards.test.ts
git commit -m "feat(agent-loop): 预算软提醒点明转存会在保留额处被机械拒绝,并钉死 240<260<300

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: 端口可选批量方法 + 115 执行器 `transferSubtitleUrls`

**Files:**
- Modify: `packages/workflow/src/ports.ts`（`transferSubtitleUrl?` 之后）
- Modify: `packages/workflow/src/storage-115-executor.ts`（常量区 ~L10–20；`transferSubtitleUrl` ~L524–650 整段替换）
- Modify: `packages/workflow/tests/storage-115-executor.test.ts`（新 describe，放在 `describe("Storage115Executor.transferSubtitleUrl"` 之后）

- [ ] **Step 1: 写批量行为的失败测试**

追加到 `storage-115-executor.test.ts`（`class FakePan115Api` 之前）：

```ts
describe("Storage115Executor.transferSubtitleUrls (整包一次:1 校验 + 1 快照 + N 提交 + 每轮 1 次深 1 轮询 + 1 次批量取消)", () => {
  function subtitleFiles(n: number): Array<{ url: string; filename: string }> {
    return Array.from({ length: n }, (_, i) => ({
      url: `http://file0.assrt.net/onthefly/1/Show.S01E${String(i + 1).padStart(2, "0")}.srt`,
      filename: `Show.S01E${String(i + 1).padStart(2, "0")}.srt`,
    }));
  }
  /** Land `filename` in `dir` the next time listItems runs (simulates 115's async drop). */
  function landOnNextList(api: FakePan115Api, dir: string, filename: string, fid: string): void {
    const orig = api.listItems.bind(api);
    api.listItems = async (input) => {
      api.directories[dir] = [...(api.directories[dir] ?? []), { fid, n: filename, s: "40KB" }];
      api.listItems = orig;
      return orig(input);
    };
  }

  it("a 3-file package that lands on the first poll costs exactly 1 + 3 + 1 calls (was 3 × (1 + 1 + 1) per-file)", async () => {
    const api = new FakePan115Api({ directories: { stage: [] } });
    api.addOfflineTask = async (input) => {
      const name = input.url.split("/").pop()!;
      api.directories[input.directoryId] = [...(api.directories[input.directoryId] ?? []), { fid: `fid_${name}`, n: name, s: "40KB" }];
      return { ok: true, message: "accepted" };
    };
    const guard = new Pan115ApiGuard({ minDelayMs: 0 });
    const executor = new Storage115Executor({ api, apiGuard: guard, sleep: async () => {} });

    const attempts = await executor.transferSubtitleUrls!({ files: subtitleFiles(3), directoryId: "stage", workflowRunId: "run-b" });

    expect(attempts.map((a) => a.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(attempts.map((a) => a.materializedFileIds)).toEqual([["fid_Show.S01E01.srt"], ["fid_Show.S01E02.srt"], ["fid_Show.S01E03.srt"]]);
    expect(attempts.map((a) => a.candidateId)).toEqual(["subtitle:Show.S01E01.srt", "subtitle:Show.S01E02.srt", "subtitle:Show.S01E03.srt"]);
    expect(new Set(attempts.map((a) => a.id)).size).toBe(3);
    expect(guard.callsSpent()).toBe(5); // before-listing 1 + addOfflineTask 3 + one poll 1
    expect(api.listCalls).toEqual(["stage", "stage"]); // depth 1: the staging dir only, never its subdirs
  });

  it("polls the staging dir at depth 1 — subdirectories (video packs) are never listed", async () => {
    const api = new FakePan115Api({
      directories: { stage: [{ isDirectory: true, cid: "pack_1", n: "Q-Show-2026" }], pack_1: [] },
    });
    api.addOfflineTask = async () => ({ ok: true, message: "accepted" });
    const executor = new Storage115Executor({ api, subtitleMaterializeAttempts: 2, subtitleMaterializePollMs: 1, sleep: async () => {} });

    await executor.transferSubtitleUrls!({ files: subtitleFiles(1), directoryId: "stage", workflowRunId: "run-b" });

    expect(api.listCalls.every((cid) => cid === "stage")).toBe(true);
  });

  it("keeps polling while files keep landing, and gives up after `subtitleMaterializeAttempts` idle polls", async () => {
    const api = new FakePan115Api({ directories: { stage: [] } });
    api.addOfflineTask = async () => ({ ok: true, message: "accepted" });
    let listCalls = 0;
    const orig = api.listItems.bind(api);
    api.listItems = async (input) => {
      listCalls += 1;
      // listing 1 = before; E01 lands on poll 3 (listing 4), E02 on poll 5 (listing 6); E03 never.
      if (listCalls === 4) api.directories["stage"] = [{ fid: "f1", n: "Show.S01E01.srt", s: "1KB" }];
      if (listCalls === 6) api.directories["stage"] = [...api.directories["stage"]!, { fid: "f2", n: "Show.S01E02.srt", s: "1KB" }];
      return orig(input);
    };
    const guard = new Pan115ApiGuard({ minDelayMs: 0 });
    const executor = new Storage115Executor({ api, apiGuard: guard, subtitleMaterializeAttempts: 3, subtitleMaterializePollMs: 1, sleep: async () => {} });

    const attempts = await executor.transferSubtitleUrls!({ files: subtitleFiles(3), directoryId: "stage", workflowRunId: "run-b" });

    expect(attempts.map((a) => a.status)).toEqual(["succeeded", "succeeded", "no_target_change"]);
    // polls: 1,2 idle(2) → 3 lands (idle reset) → 4 idle → 5 lands (reset) → 6,7,8 idle(3) → stop.
    expect(listCalls).toBe(1 + 8);
    // before 1 + submit 3 + polls 8 + cancel listOfflineTasks 1 (no unambiguous match → no task_del)
    expect(guard.callsSpent()).toBe(13);
  });

  it("caps total polls at attempts + files even when landings trickle forever", async () => {
    const api = new FakePan115Api({ directories: { stage: [] } });
    api.addOfflineTask = async () => ({ ok: true, message: "accepted" });
    let listCalls = 0;
    const orig = api.listItems.bind(api);
    api.listItems = async (input) => {
      listCalls += 1;
      // One file lands on EVERY poll from listing 2 on (never idle) — only the cap stops it.
      const n = listCalls - 1;
      if (n >= 1) api.directories["stage"] = [...(api.directories["stage"] ?? []), { fid: `f${n}`, n: `Show.S01E${String(n).padStart(2, "0")}.srt`, s: "1KB" }];
      return orig(input);
    };
    const executor = new Storage115Executor({ api, subtitleMaterializeAttempts: 2, subtitleMaterializePollMs: 1, sleep: async () => {} });

    const attempts = await executor.transferSubtitleUrls!({ files: subtitleFiles(10), directoryId: "stage", workflowRunId: "run-b" });

    expect(listCalls).toBe(1 + 2 + 10); // before + (attempts + files) polls
    expect(attempts.filter((a) => a.status === "succeeded")).toHaveLength(10); // every poll landed one
  });

  it("batch-cancels every unlanded file's queued task in ONE task_del (only unambiguous url matches), after ONE task_lists read", async () => {
    const files = subtitleFiles(4);
    const api = new FakePan115Api({
      directories: { stage: [] },
      offlineTaskList: [
        { infoHash: "h1", name: "a", percentDone: 0, status: 1, statusText: "downloading", url: files[0]!.url },
        { infoHash: "h2", name: "b", percentDone: 0, status: 1, statusText: "downloading", url: files[1]!.url },
        { infoHash: "h2dup", name: "b-stale", percentDone: 0, status: 1, statusText: "downloading", url: files[1]!.url }, // ambiguous → skipped
        // files[2] has no task row → skipped; files[3] lands → not cancelled
      ],
    });
    api.addOfflineTask = async (input) => {
      if (input.url === files[3]!.url) api.directories["stage"] = [{ fid: "f4", n: files[3]!.filename, s: "1KB" }];
      return { ok: true, message: "accepted" };
    };
    const executor = new Storage115Executor({ api, subtitleMaterializeAttempts: 1, subtitleMaterializePollMs: 1, sleep: async () => {} });

    const attempts = await executor.transferSubtitleUrls!({ files, directoryId: "stage", workflowRunId: "run-b" });

    expect(attempts.map((a) => a.status)).toEqual(["no_target_change", "no_target_change", "no_target_change", "succeeded"]);
    expect(api.listOfflineTasksCalls).toBe(1);
    expect(api.removedOfflineHashes).toEqual(["h1"]);
    expect(attempts[0]!.providerMessage).toBe("subtitle offline task accepted but file did not materialize in window");
  });

  it("invalid (path-y) and duplicate filenames fail at the boundary without API calls and without disturbing the others", async () => {
    const api = new FakePan115Api({ directories: { stage: [] } });
    api.addOfflineTask = async (input) => {
      const name = input.url.split("/").pop()!;
      api.directories[input.directoryId] = [...(api.directories[input.directoryId] ?? []), { fid: `fid_${name}`, n: name, s: "1KB" }];
      return { ok: true, message: "accepted" };
    };
    const executor = new Storage115Executor({ api, sleep: async () => {} });

    const attempts = await executor.transferSubtitleUrls!({
      files: [
        { url: "http://x/evil.srt", filename: "sub/evil.srt" },
        { url: "http://x/Show.S01E01.srt", filename: "Show.S01E01.srt" },
        { url: "http://x/dup/Show.S01E01.srt", filename: "Show.S01E01.srt" },
      ],
      directoryId: "stage",
      workflowRunId: "run-b",
    });

    expect(attempts[0]!.status).toBe("failed");
    expect(attempts[0]!.providerMessage).toMatch(/SUBTITLE_INVALID_FILENAME/);
    expect(attempts[0]!.candidateId).not.toContain("/");
    expect(attempts[1]!.status).toBe("succeeded");
    expect(attempts[2]!.status).toBe("failed");
    expect(attempts[2]!.providerMessage).toMatch(/SUBTITLE_DUPLICATE_FILENAME/);
    expect(api.offlineTasks.map((t) => t.url)).toEqual(["http://x/Show.S01E01.srt"]); // exactly one submission
    expect(new Set(attempts.map((a) => a.id)).size).toBe(3);
  });

  it("an all-invalid package returns without touching the API at all", async () => {
    const api = new FakePan115Api({ directories: { stage: [] } });
    const guard = new Pan115ApiGuard({ minDelayMs: 0 });
    const executor = new Storage115Executor({ api, apiGuard: guard });

    const attempts = await executor.transferSubtitleUrls!({ files: [{ url: "http://x/a", filename: "a/b.srt" }], directoryId: "stage", workflowRunId: "run-b" });

    expect(attempts).toHaveLength(1);
    expect(guard.callsSpent()).toBe(0);
  });

  it("stops submitting after 3 consecutive addOfflineTask rejections; the rest are failed as SUBTITLE_NOT_SUBMITTED", async () => {
    const api = new FakePan115Api({ directories: { stage: [] } });
    let submissions = 0;
    api.addOfflineTask = async () => {
      submissions += 1;
      return { ok: false, message: "云下载配额不足" };
    };
    const executor = new Storage115Executor({ api, subtitleMaterializeAttempts: 1, subtitleMaterializePollMs: 1, sleep: async () => {} });

    const attempts = await executor.transferSubtitleUrls!({ files: subtitleFiles(6), directoryId: "stage", workflowRunId: "run-b" });

    expect(submissions).toBe(3);
    expect(attempts.slice(0, 3).map((a) => a.providerMessage)).toEqual(["云下载配额不足", "云下载配额不足", "云下载配额不足"]);
    expect(attempts.slice(3).every((a) => a.status === "failed" && /SUBTITLE_NOT_SUBMITTED.*云下载配额不足/.test(a.providerMessage))).toBe(true);
    expect(api.listOfflineTasksCalls).toBe(0); // nothing was submitted → nothing to cancel
  });

  it("a success resets the rejection counter (mixed flakiness still submits everything)", async () => {
    const api = new FakePan115Api({ directories: { stage: [] } });
    let submissions = 0;
    api.addOfflineTask = async () => {
      submissions += 1;
      return submissions % 3 === 0 ? { ok: true, message: "accepted" } : { ok: false, message: "flaky" };
    };
    const executor = new Storage115Executor({ api, subtitleMaterializeAttempts: 1, subtitleMaterializePollMs: 1, sleep: async () => {} });

    await executor.transferSubtitleUrls!({ files: subtitleFiles(6), directoryId: "stage", workflowRunId: "run-b" });

    expect(submissions).toBe(6);
  });

  it("a guard refusal (budget/circuit) stops submission at once; already-submitted files are still polled", async () => {
    const api = new FakePan115Api({ directories: { stage: [] } });
    api.addOfflineTask = async (input) => {
      const name = input.url.split("/").pop()!;
      api.directories[input.directoryId] = [...(api.directories[input.directoryId] ?? []), { fid: `fid_${name}`, n: name, s: "1KB" }];
      return { ok: true, message: "accepted" };
    };
    // hard 20, reserve 17 → transfers stop at 3: before-listing (1) + 2 submissions reach the cutoff.
    const guard = new Pan115ApiGuard({ minDelayMs: 0, maxCallsPerOperation: 20, transferReserveCalls: 17 });
    const executor = new Storage115Executor({ api, apiGuard: guard, subtitleMaterializeAttempts: 2, subtitleMaterializePollMs: 1, sleep: async () => {} });

    const attempts = await executor.transferSubtitleUrls!({ files: subtitleFiles(5), directoryId: "stage", workflowRunId: "run-b" });

    expect(api.offlineTasks).toHaveLength(2);
    expect(attempts.slice(0, 2).map((a) => a.status)).toEqual(["succeeded", "succeeded"]);
    expect(attempts.slice(2).every((a) => a.status === "failed" && /SUBTITLE_NOT_SUBMITTED.*PAN115_RATE_LIMIT/.test(a.providerMessage))).toBe(true);
  });

  it("polling stops at the transfer budget line instead of eating the wrap-up reserve (graceful miss, not a throw)", async () => {
    const api = new FakePan115Api({ directories: { stage: [] } });
    api.addOfflineTask = async () => ({ ok: true, message: "accepted" });
    // hard 10, reserve 6 → transfer line 4: before 1 + submit 1 = 2, then polls 3, 4 → stop before the 5th call.
    const guard = new Pan115ApiGuard({ minDelayMs: 0, maxCallsPerOperation: 10, transferReserveCalls: 6 });
    const executor = new Storage115Executor({ api, apiGuard: guard, subtitleMaterializeAttempts: 8, subtitleMaterializePollMs: 1, sleep: async () => {} });

    const attempts = await executor.transferSubtitleUrls!({ files: subtitleFiles(1), directoryId: "stage", workflowRunId: "run-b" });

    expect(attempts[0]!.status).toBe("no_target_change");
    expect(attempts[0]!.providerMessage).toMatch(/wrap-up reserve/);
    expect(api.listCalls).toHaveLength(3); // before + 2 polls
    expect(guard.callsSpent()).toBe(5); // + the cleanup task_lists read (allowed: not transfer-class)
  });

  it("transferSubtitleUrl (single) delegates to the batch — same attempt shape, one number per call", async () => {
    const api = new FakePan115Api({ directories: { stage: [] } });
    api.addOfflineTask = async (input) => {
      api.directories[input.directoryId] = [{ fid: "sub_1", n: "Show.S01E01.srt", s: "1KB" }];
      return { ok: true, message: "accepted" };
    };
    const executor = new Storage115Executor({ api, sleep: async () => {} });

    const single = await executor.transferSubtitleUrl!({ url: "http://x/Show.S01E01.srt", filename: "Show.S01E01.srt", directoryId: "stage", workflowRunId: "run-s" });
    const next = await executor.transferSubtitleUrls!({ files: [{ url: "http://x/Show.S01E02.srt", filename: "Show.S01E02.srt" }], directoryId: "stage", workflowRunId: "run-s" });

    expect(single).toMatchObject({ id: "run-s_subtitle_1", candidateId: "subtitle:Show.S01E01.srt", status: "succeeded", materializedFileIds: ["sub_1"] });
    expect(next[0]!.id).toBe("run-s_subtitle_2");
  });
});
```

（`landOnNextList` 若最终没用到就删掉，别留死代码。）

- [ ] **Step 2: 跑，确认失败**

Run: `npx vitest run packages/workflow/tests/storage-115-executor.test.ts -t "transferSubtitleUrls"`
Expected: FAIL（`transferSubtitleUrls is not a function`）。

- [ ] **Step 3: 端口加可选批量方法**

`packages/workflow/src/ports.ts`，`transferSubtitleUrl?(...)` 声明之后追加：

```ts
  /** Batch subtitle landing — submits EVERY file up front and confirms landings
   *  with ONE directory listing per poll round for all of them. Brands whose
   *  per-file cost is dominated by the landing poll (115: the 2026-09-20 LIAR GAME
   *  run spent 260 of 300 calls on one 22-file package) implement it; the V2
   *  adapter uses it when present and otherwise loops transferSubtitleUrl. Returns
   *  one attempt per input file, in input order. Optional: the capability gate stays
   *  transferSubtitleUrl. */
  transferSubtitleUrls?(input: {
    files: Array<{ url: string; filename: string }>;
    directoryId: string;
    workflowRunId: string;
  }): Promise<TransferAttempt[]>;
```

- [ ] **Step 4: 实现 115 批量 + 单文件委托**

在 `storage-115-executor.ts` 常量区（`MAX_RECURSIVE_COLLECT_DEPTH` 之后）加：

```ts
/**
 * Depth of the subtitle landing poll. A 115 http offline task saves a single
 * file DIRECTLY under the target directory — no wrapper dir (wrappers are a
 * torrent thing). Read-dir evidence 2026-09-20 (LIAR GAME staging
 * 3522136304546481686): every landed `Liar_Game_epNN.*.srt` had the staging dir
 * itself as parent, the video packs were the only subdirectories. Depth 1 makes
 * each poll exactly ONE listItems call no matter how many packs sit in staging
 * (depth 2 cost 1 + #packs per poll — 4 calls/poll in that run).
 */
const SUBTITLE_LANDING_DEPTH = 1;

/** Consecutive addOfflineTask rejections after which the rest of a subtitle
 *  package is not submitted: a dead assrt mirror or a 115 quota refusal rejects
 *  every file the same way — no point paying a call per file to learn it. */
const SUBTITLE_MAX_CONSECUTIVE_REJECTIONS = 3;
```

替换 `async transferSubtitleUrl(...)` 整个方法（从 `/** Subtitle direct-link landing: submit the http url ...` 注释到方法结束的 `}`）为：

```ts
  /** Subtitle direct-link landing, single file — delegates to the batch so there
   *  is exactly one landing algorithm (the capability gate probes THIS method). */
  async transferSubtitleUrl(input: {
    url: string;
    filename: string;
    directoryId: string;
    workflowRunId: string;
  }): Promise<TransferAttempt> {
    const [attempt] = await this.transferSubtitleUrls({
      files: [{ url: input.url, filename: input.filename }],
      directoryId: input.directoryId,
      workflowRunId: input.workflowRunId,
    });
    return attempt!;
  }

  /** Subtitle direct-link landing for a WHOLE package: submit every http url as a
   *  115 offline task (lixianssp add_task_url accepts http/https/ftp/magnet/ed2k),
   *  then confirm landings by FILE NAME with one depth-1 listing per poll round for
   *  all of them (NOT listVideoFiles — subtitle extensions are invisible there).
   *  Cost for N files and p poll rounds: ≤ 1 (write-scope) + 1 (before) + N + p + 2
   *  (cancel), p ≤ subtitleMaterializeAttempts + N. The per-file predecessor paid
   *  the scope check, the snapshot and the whole poll window PER FILE — 20–31
   *  calls each, 260 for the 22-file LIAR GAME package (run d98dc4ca, 2026-09-20). */
  async transferSubtitleUrls(input: {
    files: Array<{ url: string; filename: string }>;
    directoryId: string;
    workflowRunId: string;
  }): Promise<TransferAttempt[]> {
    // One attempt number per input file, allocated up front in input order from the
    // SHARED transfer counter (video transfers advance it too) — the same "one
    // number per file, consumed unconditionally" invariant as transfer(), so a
    // guard-rejected or failed file burns a slot and ids never collide.
    const firstNumber = this.nextTransferNumber;
    this.nextTransferNumber += input.files.length;
    const attempts: TransferAttempt[] = input.files.map((file, index) => ({
      id: `${input.workflowRunId}_subtitle_${firstNumber + index}`,
      workflowRunId: input.workflowRunId,
      candidateId: `subtitle:${file.filename}`,
      status: "failed",
      providerMessage: "",
      materializedFileIds: [],
    }));

    // Boundary validation (zero API calls): filenames come from an EXTERNAL provider
    // (assrt). A path-y name would pollute the candidateId and make the basename
    // match ambiguous; a duplicate basename could never be told apart from its twin
    // once both land. Soft failures — the sandbox counts them like any other landing
    // failure. The raw filename stays OUT of an invalid id.
    const packageNames = new Set<string>();
    const pending = new Map<number, { url: string; filename: string }>();
    input.files.forEach((file, index) => {
      const attempt = attempts[index]!;
      if (/[\\/]/.test(file.filename)) {
        attempt.candidateId = `subtitle:invalid_name_${firstNumber + index}`;
        attempt.providerMessage =
          "SUBTITLE_INVALID_FILENAME: filename must be a bare name without path separators (路径分隔符)";
        return;
      }
      if (packageNames.has(file.filename)) {
        attempt.providerMessage = "SUBTITLE_DUPLICATE_FILENAME: a same-named file is already in this package";
        return;
      }
      packageNames.add(file.filename);
      pending.set(index, file);
    });
    if (pending.size === 0) {
      return attempts;
    }

    const safeDirectoryId = await this.assertWithinWriteScope(input.directoryId, "transfer subtitle");
    const basenameOf = (path: string): string => path.split("/").pop() ?? path;
    // BEFORE snapshot — one listing for the whole package. Only a same-named file
    // that APPEARS after submission counts: claiming a pre-existing leftover (an
    // earlier attempt's file with the same name) would report success for a
    // transfer that landed nothing.
    const beforeIds = new Set(
      (await this.listTree({ directoryId: safeDirectoryId, maxDepth: SUBTITLE_LANDING_DEPTH }))
        .filter((file) => packageNames.has(basenameOf(file.path)))
        .map((file) => file.providerFileId),
    );

    // Submit everything up front. A rejection (ok:false or a thrown provider error)
    // is per-file; after SUBTITLE_MAX_CONSECUTIVE_REJECTIONS in a row the rest is
    // not submitted. A guard refusal (budget / circuit) stops submission AT ONCE:
    // every later call would be refused the same way and would still pay the pacing
    // delay — the files already submitted are still polled below (listing is
    // allowed up to the hard limit).
    const submitted = new Map<number, { url: string; filename: string }>();
    let consecutiveRejections = 0;
    let abortReason: string | null = null;
    for (const [index, file] of pending) {
      const attempt = attempts[index]!;
      if (abortReason !== null) {
        attempt.providerMessage = `SUBTITLE_NOT_SUBMITTED: ${abortReason}`;
        continue;
      }
      let action: Pan115ActionResult;
      try {
        action = await this.callApi("addOfflineTask", () =>
          this.api.addOfflineTask({ url: file.url, directoryId: safeDirectoryId }),
        );
      } catch (error) {
        const message = errorMessage(error);
        attempt.providerMessage = message;
        if (error instanceof Pan115RiskControlError) {
          abortReason = `submission stopped by the 115 guard (${message})`;
          continue;
        }
        action = { ok: false, message };
      }
      if (!action.ok) {
        attempt.providerMessage = action.message;
        consecutiveRejections += 1;
        if (consecutiveRejections >= SUBTITLE_MAX_CONSECUTIVE_REJECTIONS) {
          abortReason = `aborted after ${SUBTITLE_MAX_CONSECUTIVE_REJECTIONS} consecutive rejections (last: ${action.message})`;
        }
        continue;
      }
      consecutiveRejections = 0;
      submitted.set(index, file);
    }

    // Unified poll: one depth-1 listing per round claims every file that appeared.
    // The first poll is immediate; sleeps happen only BETWEEN polls. Stop when all
    // landed, after subtitleMaterializeAttempts consecutive rounds with nothing new
    // (the single-file window's own patience — a file quiet that long is a miss),
    // or once every file has had one extra round of grace (the hard cap on cost).
    // Never poll past the transfer budget line: the calls beyond it are the
    // wrap-up reserve (with no reserve configured this stops one call short of the
    // hard limit — a graceful miss instead of a throw).
    const maxPolls = this.subtitleMaterializeAttempts + submitted.size;
    let polls = 0;
    let idlePolls = 0;
    let pollStop: string | null = null;
    while (submitted.size > 0) {
      if (this.apiGuard.callsSpent() >= this.apiGuard.transferCallBudget()) {
        pollStop = "subtitle landing poll stopped: 115 call budget reached the wrap-up reserve";
        break;
      }
      let tree: PackageTreeFile[];
      try {
        tree = await this.listTree({ directoryId: safeDirectoryId, maxDepth: SUBTITLE_LANDING_DEPTH });
      } catch (error) {
        pollStop = `subtitle landing poll failed: ${errorMessage(error)}`;
        break;
      }
      polls += 1;
      let landedThisPoll = 0;
      for (const [index, file] of submitted) {
        const hit = tree.find(
          (entry) => basenameOf(entry.path) === file.filename && !beforeIds.has(entry.providerFileId),
        );
        if (hit) {
          const attempt = attempts[index]!;
          attempt.status = "succeeded";
          attempt.materializedFileIds = [hit.providerFileId];
          submitted.delete(index);
          landedThisPoll += 1;
        }
      }
      if (submitted.size === 0) {
        break;
      }
      idlePolls = landedThisPoll > 0 ? 0 : idlePolls + 1;
      if (idlePolls >= this.subtitleMaterializeAttempts || polls >= maxPolls) {
        break;
      }
      await this.sleep(this.subtitleMaterializePollMs);
    }

    // Not everything materialized in the window: 115 queued real background
    // downloads we will not wait for. Best-effort cancel them (task_del) so they
    // can't drop files into staging AFTER the workflow moves on and don't tie up
    // offline-task quota. An http url has no infoHash up front, so resolve each
    // queued task by matching its url in the task list — only on an UNAMBIGUOUS
    // single match (a stale task from a prior run for the same url makes it
    // ambiguous: skip rather than cancel the wrong task). ONE task_lists read and
    // ONE task_del for the whole package. Never fail the attempts over cleanup.
    if (submitted.size > 0) {
      try {
        const tasks = await this.callApi("listOfflineTasks", () => this.api.listOfflineTasks());
        const infoHashes: string[] = [];
        for (const file of submitted.values()) {
          const matches = tasks.filter((task) => task.url === file.url && task.infoHash);
          if (matches.length === 1) {
            infoHashes.push(matches[0]!.infoHash);
          }
        }
        if (infoHashes.length > 0) {
          await this.callApi("removeOfflineTask", () => this.api.removeOfflineTask({ infoHashes }));
        }
      } catch {
        // best-effort cleanup — a failed cancel must never fail the subtitle attempts
      }
      for (const index of submitted.keys()) {
        const attempt = attempts[index]!;
        attempt.status = "no_target_change";
        attempt.providerMessage =
          pollStop ?? "subtitle offline task accepted but file did not materialize in window";
      }
    }
    return attempts;
  }
```

- [ ] **Step 5: 跑，确认新旧测试全过**

Run: `npx vitest run packages/workflow/tests/storage-115-executor.test.ts`
Expected: 全 PASS——含原有 `describe("Storage115Executor.transferSubtitleUrl"` 的 10 条（窗口选项、宽窗、不认旧同名、无效名不耗 API、成功/失败/未落地/取消/id 唯一）。若 `landOnNextList` 未使用，删掉它。

- [ ] **Step 6: 类型检查**

Run: `npm run typecheck`
Expected: 无错误（`transferSubtitleUrls` 在 `StorageExecutor` 上是可选，`Storage115Executor implements StorageExecutor` 仍成立）。

- [ ] **Step 7: 提交**

```bash
git add packages/workflow/src/ports.ts packages/workflow/src/storage-115-executor.ts packages/workflow/tests/storage-115-executor.test.ts
git commit -m "feat(115): 字幕包整包一次落盘——1 校验 + 1 快照 + N 提交 + 每轮 1 次深 1 轮询 + 1 次批量取消

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `StorageV2` 批量表面 + 模拟器成本 + `RealStorageV2` 批量优先 / 循环熔断

**Files:**
- Modify: `packages/workflow/src/acquisition-v2/storage-115-simulator.ts`（接口 `StorageV2` ~L64–94；`transferSubtitleUrl` ~L190–207）
- Modify: `packages/workflow/src/acquisition-v2/real-storage-adapter.ts`（`transferSubtitleUrl` ~L133–160）
- Modify: `packages/workflow/tests/v2-storage-115-simulator.test.ts`（追加 describe）
- Modify: `packages/workflow/tests/v2-real-storage-adapter.test.ts`（追加 describe + `RecordingExecutor` 加可选批量）

本任务**保留** `StorageV2.transferSubtitleUrl`（Task 5 才从接口移除），只新增 `transferSubtitleUrls`，保证每步都能 typecheck。

- [ ] **Step 1: 写模拟器批量成本的失败测试**

追加到 `v2-storage-115-simulator.test.ts`：

```ts
describe("Storage115Simulator — transferSubtitleUrls (batch cost 1 + N, same 口径 as transferCandidate)", () => {
  it("lands every file of the package, in order, and spends 1 + N budget", async () => {
    const sim = new Storage115Simulator({ apiBudget: 5 });
    const dir = await sim.createDirectory({ name: "staging", parentId: "root" }); // spent 1
    const results = await sim.transferSubtitleUrls({
      files: [
        { url: "http://x/a.srt", filename: "a.srt" },
        { url: "http://x/b.srt", filename: "b.srt" },
        { url: "http://x/c.srt", filename: "c.srt" },
      ],
      intoDirectoryId: dir,
    }); // 1 + 3 → spent 5 = budget, still fine
    expect(results.map((r) => r.filename)).toEqual(["a.srt", "b.srt", "c.srt"]);
    expect(results.every((r) => r.status === "succeeded" && r.materializedFileIds.length === 1)).toBe(true);
    await expect(sim.listTree({ directoryId: dir })).rejects.toThrow("PAN115_RATE_LIMIT"); // the 6th call overruns
  });

  it("dispatches through the per-file seam so tests can script individual outcomes", async () => {
    class Scripted extends Storage115Simulator {
      override async transferSubtitleUrl(input: { url: string; filename: string; intoDirectoryId: string }): Promise<TransferAttemptResult> {
        if (input.filename === "b.srt") return { status: "failed", materializedFileIds: [], providerMessage: "dead link" };
        return super.transferSubtitleUrl(input);
      }
    }
    const sim = new Scripted();
    const dir = await sim.createDirectory({ name: "staging", parentId: "root" });
    const results = await sim.transferSubtitleUrls({
      files: [{ url: "http://x/a", filename: "a.srt" }, { url: "http://x/b", filename: "b.srt" }],
      intoDirectoryId: dir,
    });
    expect(results.map((r) => r.status)).toEqual(["succeeded", "failed"]);
    expect(results[1]!.providerMessage).toBe("dead link");
  });
});
```

文件顶部 import 加 `type TransferAttemptResult`（来自 `../src/acquisition-v2/storage-115-simulator.js`，与现有 `Storage115Simulator` 同源）。

- [ ] **Step 2: 跑，确认失败**

Run: `npx vitest run packages/workflow/tests/v2-storage-115-simulator.test.ts`
Expected: 新 describe FAIL（`transferSubtitleUrls is not a function`）。

- [ ] **Step 3: 实现接口 + 模拟器**

`storage-115-simulator.ts`：

(a) `export interface TransferAttemptResult { ... }` 之后加：

```ts
/** One file's outcome inside a subtitle package landing (StorageV2.transferSubtitleUrls). */
export interface SubtitleLandingResult extends TransferAttemptResult {
  filename: string;
}
```

(b) `StorageV2` 接口里，现有 `transferSubtitleUrl(...)` 声明之后追加：

```ts
  /** Subtitle direct-link landing for a WHOLE package: each file's url and the
   *  bare filename it should land under. One result per input file, in input
   *  order. Batch is the production path — a per-file loop pays the landing poll
   *  once per file (the 2026-09-20 LIAR GAME run spent 260 of its 300 115 calls
   *  on one 22-file package); a batch polls the directory once per round for all
   *  of them. No workflowRunId here: run identity is the ADAPTER's business. */
  transferSubtitleUrls(input: {
    files: Array<{ url: string; filename: string }>;
    intoDirectoryId: string;
  }): Promise<SubtitleLandingResult[]>;
```

(c) 模拟器 `transferSubtitleUrl` 的 doc 注释改为：

```ts
  /** Single-file landing — the per-file SEAM (kept public so tests can seed staging
   *  and script individual outcomes by overriding it); transferSubtitleUrls below
   *  dispatches through it, so those overrides apply to the batch too. */
```

并在其后追加：

```ts
  /** Batch landing — the StorageV2 surface. Cost model: 1 for the package's shared
   *  overhead (write-scope check + before snapshot on the real 115) + 1 per file —
   *  the same "one call per file it touches" 口径 as transferCandidate's
   *  1 + files.length. */
  async transferSubtitleUrls(input: {
    files: Array<{ url: string; filename: string }>;
    intoDirectoryId: string;
  }): Promise<SubtitleLandingResult[]> {
    if (!this.dirs.has(input.intoDirectoryId)) {
      throw new Error(`SIM_DIR_NOT_FOUND: target ${input.intoDirectoryId}`);
    }
    this.spendBudget(1);
    const results: SubtitleLandingResult[] = [];
    for (const file of input.files) {
      const result = await this.transferSubtitleUrl({
        url: file.url,
        filename: file.filename,
        intoDirectoryId: input.intoDirectoryId,
      });
      results.push({ filename: file.filename, ...result });
    }
    return results;
  }
```

- [ ] **Step 4: 跑模拟器测试，确认通过；typecheck 会因 `RealStorageV2` 未实现而失败——先别跑，继续 Step 5**

Run: `npx vitest run packages/workflow/tests/v2-storage-115-simulator.test.ts`
Expected: PASS。

- [ ] **Step 5: 写 adapter 的失败测试**

在 `v2-real-storage-adapter.test.ts`：

(a) `RecordingExecutor` 加可选批量：构造函数 `opts` 类型加 `subtitleBatch?: boolean; subtitleFail?: (filename: string) => string | null`，并加字段与方法：

```ts
  subtitleSingleCalls: string[] = [];
  subtitleBatchCalls: Array<{ files: string[]; directoryId: string; workflowRunId: string }> = [];
```

把现有 `async transferSubtitleUrl(...)` 改为：

```ts
  async transferSubtitleUrl(input: { url: string; filename: string; directoryId: string; workflowRunId: string }): Promise<TransferAttempt> {
    this.subtitleSingleCalls.push(input.filename);
    const failure = this.opts.subtitleFail?.(input.filename) ?? null;
    return {
      id: `${input.workflowRunId}_subtitle_${this.subtitleSingleCalls.length}`,
      workflowRunId: input.workflowRunId,
      candidateId: `subtitle:${input.filename}`,
      status: failure === null ? "succeeded" : "failed",
      providerMessage: failure ?? "",
      materializedFileIds: failure === null ? [`sub_${input.filename}`] : [],
    };
  }
```

在类里加（`subtitleBatch` 为 true 时才存在——用 TS 的可选方法做不到按实例存在，所以在**构造函数末尾**按 opts 删除方法）：

```ts
  transferSubtitleUrls?: (input: { files: Array<{ url: string; filename: string }>; directoryId: string; workflowRunId: string }) => Promise<TransferAttempt[]>;
```

构造函数体改为：

```ts
  constructor(private readonly opts: { status?: TransferAttempt["status"]; message?: string; tree?: PackageTreeFile[]; removeOk?: boolean; subtitleBatch?: boolean; subtitleFail?: (filename: string) => string | null } = {}) {
    if (opts.subtitleBatch) {
      this.transferSubtitleUrls = async (input) => {
        this.subtitleBatchCalls.push({ files: input.files.map((f) => f.filename), directoryId: input.directoryId, workflowRunId: input.workflowRunId });
        return input.files.map((file, index) => {
          const failure = this.opts.subtitleFail?.(file.filename) ?? null;
          return {
            id: `${input.workflowRunId}_subtitle_${index + 1}`,
            workflowRunId: input.workflowRunId,
            candidateId: `subtitle:${file.filename}`,
            status: failure === null ? ("succeeded" as const) : ("no_target_change" as const),
            providerMessage: failure ?? "",
            materializedFileIds: failure === null ? [`sub_${file.filename}`] : [],
          };
        });
      };
    }
  }
```

(b) 追加 describe：

```ts
describe("RealStorageV2.transferSubtitleUrls — batch-first, per-file fallback with the consecutive-failure abort", () => {
  const files = (n: number) => Array.from({ length: n }, (_, i) => ({ url: `http://x/${i}.srt`, filename: `E${i}.srt` }));

  it("uses the executor's batch method when present: ONE call with every file, results in order, run id from the adapter", async () => {
    const executor = new RecordingExecutor({ subtitleBatch: true, subtitleFail: (name) => (name === "E1.srt" ? "did not materialize" : null) });
    const { storage } = adapter(executor);

    const results = await storage.transferSubtitleUrls({ files: files(3), intoDirectoryId: "staging" });

    expect(executor.subtitleBatchCalls).toEqual([{ files: ["E0.srt", "E1.srt", "E2.srt"], directoryId: "staging", workflowRunId: "run-7" }]);
    expect(executor.subtitleSingleCalls).toEqual([]);
    expect(results.map((r) => [r.filename, r.status])).toEqual([["E0.srt", "succeeded"], ["E1.srt", "failed"], ["E2.srt", "succeeded"]]);
    expect(results[1]!.providerMessage).toBe("did not materialize");
    expect(results[0]!.materializedFileIds).toEqual(["sub_E0.srt"]);
  });

  it("falls back to the per-file method when the executor has no batch (光鸭 today)", async () => {
    const executor = new RecordingExecutor();
    const { storage } = adapter(executor);

    const results = await storage.transferSubtitleUrls({ files: files(2), intoDirectoryId: "staging" });

    expect(executor.subtitleSingleCalls).toEqual(["E0.srt", "E1.srt"]);
    expect(results.every((r) => r.status === "succeeded")).toBe(true);
  });

  it("per-file fallback aborts after 3 consecutive failures instead of hammering the whole filelist (每次失败都烧真 API)", async () => {
    const executor = new RecordingExecutor({ subtitleFail: () => "dead link" });
    const { storage } = adapter(executor);

    const results = await storage.transferSubtitleUrls({ files: files(10), intoDirectoryId: "staging" });

    expect(executor.subtitleSingleCalls).toHaveLength(3);
    expect(results.slice(0, 3).map((r) => r.providerMessage)).toEqual(["dead link", "dead link", "dead link"]);
    expect(results.slice(3).every((r) => r.status === "failed")).toBe(true);
    expect(results[9]!.providerMessage).toMatch(/已连续 3 个字幕文件落盘失败,提前中止\(剩余 7 个未尝试\).*最后错误: dead link/);
  });

  it("per-file fallback: a success in between resets the counter (mixed flakiness still lands everything)", async () => {
    let n = 0;
    const executor = new RecordingExecutor({ subtitleFail: () => (++n % 3 === 0 ? null : "flaky") });
    const { storage } = adapter(executor);

    const results = await storage.transferSubtitleUrls({ files: files(6), intoDirectoryId: "staging" });

    expect(executor.subtitleSingleCalls).toHaveLength(6);
    expect(results.filter((r) => r.status === "succeeded").map((r) => r.filename)).toEqual(["E2.srt", "E5.srt"]);
  });

  it("per-file fallback treats a thrown executor error as that file's failure (counts toward the abort)", async () => {
    class Throwing extends RecordingExecutor {
      override async transferSubtitleUrl(): Promise<TransferAttempt> {
        throw new Error("PAN115_LIST_ITEMS_FAILED: boom");
      }
    }
    const { storage } = adapter(new Throwing());

    const results = await storage.transferSubtitleUrls({ files: files(4), intoDirectoryId: "staging" });

    expect(results.slice(0, 3).every((r) => r.status === "failed" && r.providerMessage === "PAN115_LIST_ITEMS_FAILED: boom")).toBe(true);
    expect(results[3]!.providerMessage).toMatch(/已连续 3 个/);
  });

  it("neither path records subtitle attempts into attempts() (snapshot-persistence invariant)", async () => {
    for (const subtitleBatch of [true, false]) {
      const { storage } = adapter(new RecordingExecutor({ subtitleBatch }));
      await storage.transferSubtitleUrls({ files: files(2), intoDirectoryId: "staging" });
      expect(storage.attempts()).toEqual([]);
    }
  });

  it("throws REAL_STORAGE_NO_SUBTITLE_SUPPORT when the executor has neither method", async () => {
    class NoSubtitles extends RecordingExecutor {
      constructor() {
        super();
        // @ts-expect-error — simulate a brand without the capability
        this.transferSubtitleUrl = undefined;
      }
    }
    const { storage } = adapter(new NoSubtitles());
    await expect(storage.transferSubtitleUrls({ files: files(1), intoDirectoryId: "staging" })).rejects.toThrow("REAL_STORAGE_NO_SUBTITLE_SUPPORT");
  });
});
```

- [ ] **Step 6: 跑，确认失败**

Run: `npx vitest run packages/workflow/tests/v2-real-storage-adapter.test.ts`
Expected: 新 describe FAIL（`storage.transferSubtitleUrls is not a function`）。

- [ ] **Step 7: 实现 `RealStorageV2.transferSubtitleUrls`**

`real-storage-adapter.ts`：

(a) import 里 `type SimTreeFile, type StorageV2, type TransferAttemptResult` 加 `type SubtitleLandingResult`。

(b) `const PAN115_SHARE_URL = ...` 之后加：

```ts
/** Consecutive per-file landing failures after which the rest of a package is
 *  skipped on the per-file fallback path. Each failed landing costs real drive
 *  API calls (offline task + materialization polls + cleanup) and a dead assrt
 *  package fails file after file the same way; a success resets the counter so
 *  mixed flakiness still lands. A brand with a batch method owns this policy
 *  itself (115 stops SUBMITTING after 3 rejections and polls once per round). */
const MAX_CONSECUTIVE_SUBTITLE_FAILURES = 3;
```

(c) 现有 `transferSubtitleUrl` 方法之后加：

```ts
  /** Whole-package subtitle landing. Batch-capable executor (115) → one call;
   *  otherwise (光鸭) loop the per-file method under the consecutive-failure
   *  abort. Either way the attempts stay OUT of attempts(): their synthetic
   *  `subtitle:<filename>` candidateIds belong to no snapshot, and persisting them
   *  would abort the run's snapshot save after the video already landed. */
  async transferSubtitleUrls(input: {
    files: Array<{ url: string; filename: string }>;
    intoDirectoryId: string;
  }): Promise<SubtitleLandingResult[]> {
    const toResult = (filename: string, attempt: TransferAttempt): SubtitleLandingResult => ({
      filename,
      status: attempt.status === "succeeded" ? "succeeded" : "failed",
      materializedFileIds: attempt.materializedFileIds,
      ...(attempt.providerMessage ? { providerMessage: attempt.providerMessage } : {}),
    });
    if (this.executor.transferSubtitleUrls) {
      const attempts = await this.executor.transferSubtitleUrls({
        files: input.files,
        directoryId: input.intoDirectoryId,
        workflowRunId: this.workflowRunId,
      });
      return input.files.map((file, index) => toResult(file.filename, attempts[index]!));
    }
    if (!this.executor.transferSubtitleUrl) {
      throw new Error("REAL_STORAGE_NO_SUBTITLE_SUPPORT: this storage brand has no transferSubtitleUrl");
    }
    const results: SubtitleLandingResult[] = [];
    let consecutiveFailures = 0;
    let lastError: string | undefined;
    let abortMessage: string | null = null;
    for (let i = 0; i < input.files.length; i += 1) {
      const file = input.files[i]!;
      if (abortMessage !== null) {
        results.push({ filename: file.filename, status: "failed", materializedFileIds: [], providerMessage: abortMessage });
        continue;
      }
      let result: SubtitleLandingResult;
      try {
        result = toResult(
          file.filename,
          await this.executor.transferSubtitleUrl({
            url: file.url,
            filename: file.filename,
            directoryId: input.intoDirectoryId,
            workflowRunId: this.workflowRunId,
          }),
        );
      } catch (error) {
        result = {
          filename: file.filename,
          status: "failed",
          materializedFileIds: [],
          providerMessage: error instanceof Error ? error.message : String(error),
        };
      }
      results.push(result);
      if (result.status === "succeeded") {
        consecutiveFailures = 0;
        continue;
      }
      consecutiveFailures += 1;
      if (result.providerMessage) {
        lastError = result.providerMessage;
      }
      if (consecutiveFailures >= MAX_CONSECUTIVE_SUBTITLE_FAILURES) {
        const remaining = input.files.length - i - 1;
        abortMessage =
          `已连续 ${MAX_CONSECUTIVE_SUBTITLE_FAILURES} 个字幕文件落盘失败,提前中止(剩余 ${remaining} 个未尝试)。` +
          `字幕是软目标——不要重试,带着已落的继续,或直接只交付视频。${lastError ? ` 最后错误: ${lastError}` : ""}`;
      }
    }
    return results;
  }
```

- [ ] **Step 8: 跑，确认通过 + typecheck**

Run: `npx vitest run packages/workflow/tests/v2-real-storage-adapter.test.ts packages/workflow/tests/v2-storage-115-simulator.test.ts && npm run typecheck`
Expected: 全 PASS，typecheck 无错。

- [ ] **Step 9: 提交**

```bash
git add packages/workflow/src/acquisition-v2/storage-115-simulator.ts packages/workflow/src/acquisition-v2/real-storage-adapter.ts packages/workflow/tests/v2-storage-115-simulator.test.ts packages/workflow/tests/v2-real-storage-adapter.test.ts
git commit -m "feat(v2): StorageV2 批量字幕落盘表面——模拟器成本 1+N,真执行器批量优先/逐文件循环带连续 3 败熔断

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: sandbox 一次交整包；接口去掉单文件方法

**Files:**
- Modify: `packages/workflow/src/acquisition-v2/sandbox.ts`（`transferSubtitle` ~L896–985）
- Modify: `packages/workflow/src/acquisition-v2/storage-115-simulator.ts`（`StorageV2` 接口去掉 `transferSubtitleUrl`）
- Modify: `packages/workflow/src/acquisition-v2/real-storage-adapter.ts`（删掉单文件方法）
- Modify: `packages/workflow/tests/v2-sandbox-subtitle.test.ts`
- Modify: `packages/workflow/tests/v2-real-storage-adapter.test.ts`（删旧单文件测试 `keeps subtitle transfers OUT of attempts()`——已被 Task 4 的 `neither path records` 覆盖）

- [ ] **Step 1: 改 sandbox 测试到批量表面**

`v2-sandbox-subtitle.test.ts`：

(a) 把 `it("resolves the candidate's detail filelist and lands each file via storage.transferSubtitleUrl"` 改为：

```ts
  it("resolves the candidate's detail filelist and hands the WHOLE package to storage.transferSubtitleUrls in ONE call", async () => {
    const provider = new FakeResourceProviderV2({ results: { title: [] } });
    class CountingBatch extends Storage115Simulator {
      batches: string[][] = [];
      override async transferSubtitleUrls(input: { files: Array<{ url: string; filename: string }>; intoDirectoryId: string }) {
        this.batches.push(input.files.map((f) => f.filename));
        return super.transferSubtitleUrls(input);
      }
    }
    const storage = new CountingBatch({ packs: {} });
    const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
    const sandbox = new TaskSandbox({ provider, storage, stagingDirectoryId, targetSeasonDirectoryIds: {}, need: [] });
    const files = [
      { filename: "Breaking.Bad.S02E01.ass", url: "http://file0.assrt.net/onthefly/713570/-/1/a.ass?api=1" },
      { filename: "Breaking.Bad.S02E02.ass", url: "http://file0.assrt.net/onthefly/713570/-/2/b.ass?api=1" },
    ];
    await sandbox.primeSubtitleSnapshot("BB", makeAssrtProvider([{ id: 713570, title: "BB S02", lang: "英 简 双语" }], { 713570: files }));

    const result = await sandbox.transferSubtitle({ candidateId: 713570 });

    expect(result.status).toBe("succeeded");
    expect(result.landedFilenames).toEqual(["Breaking.Bad.S02E01.ass", "Breaking.Bad.S02E02.ass"]);
    expect(storage.batches).toEqual([["Breaking.Bad.S02E01.ass", "Breaking.Bad.S02E02.ass"]]); // one call, whole package
  });
```

(b) 删除 `describe("subtitle snapshot evidence + failure bounding"` 里的两条 `it("aborts after 3 consecutive landing failures ..."` 与 `it("a success in between resets the consecutive-failure counter"`（已迁到 adapter 测试），保留 `viewSubtitleSnapshot renders vote score` 那条。

(c) 追加一条：

```ts
  it("surfaces the LAST failed file's providerMessage as error (the adapter's abort message rides here)", async () => {
    const provider = new FakeResourceProviderV2({ results: { title: [] } });
    class Scripted extends Storage115Simulator {
      override async transferSubtitleUrl(input: { url: string; filename: string; intoDirectoryId: string }): Promise<TransferAttemptResult> {
        if (input.filename === "E0.ass") return { status: "failed", materializedFileIds: [], providerMessage: "first" };
        if (input.filename === "E2.ass") return { status: "failed", materializedFileIds: [], providerMessage: "已连续 3 个字幕文件落盘失败,提前中止(剩余 0 个未尝试)。" };
        return super.transferSubtitleUrl(input);
      }
    }
    const storage = new Scripted({ packs: {} });
    const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
    const sandbox = new TaskSandbox({ provider, storage, stagingDirectoryId, targetSeasonDirectoryIds: {}, need: [] });
    const files = Array.from({ length: 3 }, (_, i) => ({ filename: `E${i}.ass`, url: `http://x/${i}.ass` }));
    await sandbox.primeSubtitleSnapshot("t", makeAssrtProvider([{ id: 7, title: "t", lang: "" }], { 7: files }));

    const result = await sandbox.transferSubtitle({ candidateId: 7 });

    expect(result.status).toBe("succeeded"); // E1 landed
    expect(result.landedFilenames).toEqual(["E1.ass"]);
    expect(result.error).toMatch(/连续/);
  });
```

其余测试（partial success、non-subtitle 过滤、zip-only、rename 系列用 `storage.transferSubtitleUrl` 在模拟器上播种）不改——它们用的是模拟器 public seam。

- [ ] **Step 2: 跑，确认失败**

Run: `npx vitest run packages/workflow/tests/v2-sandbox-subtitle.test.ts`
Expected: 新/改的两条 FAIL（sandbox 仍逐文件调 `transferSubtitleUrl`，`batches` 为空）。

- [ ] **Step 3: 改 sandbox**

`sandbox.ts` 的 `transferSubtitle`：把从 `const landedFilenames: string[] = [];` 到 `return { status: ..., landedFilenames, ...(lastError ? { error: lastError } : {}) };` 之前的整段（含 `MAX_CONSECUTIVE_FAILURES` 循环）替换为：

```ts
    // The WHOLE package goes to storage in one call: the storage layer knows what a
    // landing costs on its brand (115 submits everything then polls the dir once per
    // round; a per-file brand loops under its own consecutive-failure abort), the
    // sandbox only reads back per-file outcomes. The 2026-09-20 LIAR GAME run spent
    // 260 of its 300 115 calls looping this per file — the wrap-up then hit the hard
    // limit with 15 episodes still in staging.
    const results = await this.storage.transferSubtitleUrls({
      files: subtitleFiles.map((file) => ({ url: file.url, filename: file.filename })),
      intoDirectoryId: this.stagingDirectoryId,
    });
    const landedFilenames = results.filter((result) => result.status === "succeeded").map((result) => result.filename);
    // Surface WHY (the last failure's message — for a per-file abort that is the
    // "已连续 N 个失败,提前中止" notice) so the agent can decide, never retry blindly.
    let lastError = [...results].reverse().find((result) => result.status !== "succeeded" && result.providerMessage)?.providerMessage;
```

保留原有的：

```ts
    if (landedFilenames.length === 0 && lastError === undefined) {
      lastError = "subtitle transfer failed (no files landed, no provider message)";
    }
    return {
      status: landedFilenames.length > 0 ? "succeeded" : "failed",
      landedFilenames,
      ...(lastError ? { error: lastError } : {}),
    };
```

方法的 doc 注释里 "submits each file's url" 改为 "hands the whole package to storage.transferSubtitleUrls"。

- [ ] **Step 4: 接口收口**

(a) `storage-115-simulator.ts` 的 `StorageV2` 接口删除 `transferSubtitleUrl(...)` 声明（模拟器类上的方法保留，doc 已说明是 seam）。

(b) `real-storage-adapter.ts` 删除 `async transferSubtitleUrl(...)` 单文件方法（连同其注释），只留 `transferSubtitleUrls`。

(c) `v2-real-storage-adapter.test.ts` 删除 `it("keeps subtitle transfers OUT of attempts() so they can't fail snapshot persistence validation"`（Task 4 已覆盖两条路径）。

- [ ] **Step 5: 跑相关测试 + typecheck**

Run: `npx vitest run packages/workflow/tests/v2-sandbox-subtitle.test.ts packages/workflow/tests/v2-real-storage-adapter.test.ts packages/workflow/tests/v2-subtitle.test.ts packages/workflow/tests/orchestrator-subtitle.test.ts packages/workflow/tests/v2-sandbox-transfer-until-landed.test.ts && npm run typecheck`
Expected: 全 PASS；typecheck 无错（`grep -rn "storage.transferSubtitleUrl(" packages/workflow/src` 应为空）。

- [ ] **Step 6: 提交**

```bash
git add packages/workflow/src/acquisition-v2/sandbox.ts packages/workflow/src/acquisition-v2/storage-115-simulator.ts packages/workflow/src/acquisition-v2/real-storage-adapter.ts packages/workflow/tests/v2-sandbox-subtitle.test.ts packages/workflow/tests/v2-real-storage-adapter.test.ts
git commit -m "feat(sandbox): transferSubtitle 整包一次交给 storage,连续失败熔断下沉到 adapter,StorageV2 只留批量方法

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: 文档 + 全量门槛

**Files:**
- Modify: `docs/115-api-safety-notes.md`（"## Current Code Guard" 列表）

- [ ] **Step 1: 文档**

`docs/115-api-safety-notes.md` 里 `- per-operation call budget;` 改为：

```md
- per-operation call budget, tiered: transfer-class calls (`receiveShare` /
  `addOfflineTask`) are refused once the count reaches the hard limit minus a
  wrap-up reserve (`PAN115_TRANSFER_RESERVE_CALLS`, 40 → default 300 becomes 260
  for transfers), while listing / moving / deleting / renaming run to the hard
  limit so a run can always move landed files into place and discard staging;
```

并在该列表后追加一段：

```md
Subtitle packages (assrt) land as ONE batch: `transferSubtitleUrls` does one
write-scope check, one before-snapshot, N `addOfflineTask` submissions, then
polls the staging dir once per round at depth 1 for every file, and cancels the
unlanded tasks with a single `task_del`. Cost ≤ 2N + 12 for N files (the per-file
predecessor cost 20–31 per file: 260 calls for a 22-file package on 2026-09-20).
```

- [ ] **Step 2: 全量门槛**

Run（逐条，全部必须干净）：

```bash
npm run typecheck
npx tsc -p apps/web/tsconfig.json --noEmit
npm run build:workflow
npx vitest run
npm run lint
```

Expected: 全部 0 错误、vitest 全绿。任何红先修再继续。

- [ ] **Step 3: 账目复核（写在提交信息里）**

Run: `npx vitest run packages/workflow/tests/storage-115-executor.test.ts -t "transferSubtitleUrls" --reporter=verbose 2>&1 | tail -20`
确认「3 文件 = 5 次」「trickle 10 文件 = 13 次列目录」两条在列。

- [ ] **Step 4: 提交**

```bash
git add docs/115-api-safety-notes.md
git commit -m "docs(115): 记录预算分层与字幕整包落盘的成本模型

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage**：§4.1 端口 → Task 3 Step 3；§4.2 批量算法（边界/写域 1/快照 1/提交+3 拒停/guard 立即停/统一轮询三停条件+预算止损/批量取消/同序返回/单文件委托）→ Task 3 Step 4 + 测试逐条；§4.3 分层（默认 0、转存类集合、消息、不计数不熔断、`transferCallBudget`、常量 40、两工厂、顺序、文案）→ Task 1 + Task 2；§4.4 接口批量 + 模拟器 1+N + seam → Task 4 Step 3、Task 5 Step 4；§4.5 adapter 批量优先/循环熔断/不进 attempts → Task 4 Step 7；§4.6 sandbox → Task 5 Step 3；§6 测试文件全部对应；§7 验收 1（账目）→ Task 3/6；§7 验收 2（live）在计划之外由主 session 做。
- **Placeholder scan**：`landOnNextList` 明确说了未用即删。无 TBD。
- **Type consistency**：`transferSubtitleUrls` 三处签名——端口 `{files, directoryId, workflowRunId} → TransferAttempt[]`；StorageV2 `{files, intoDirectoryId} → SubtitleLandingResult[]`；模拟器/adapter 同 StorageV2。`apiTransferCallBudget()`（执行器）vs `transferCallBudget()`（guard）命名与 `apiCallBudget()`/`callBudget()` 的既有配对一致。`PAN115_TRANSFER_RESERVE_CALLS` 由 `storage-115-executor.ts` 导出、经 `index.ts` 的 `export *` 可见，测试与 factory 都从那里取。
