# 115 字幕包一步吃光 API 预算 — 修复设计

日期：2026-09-20
状态：已实施（PR #261，2026-09-21）。本文是实施前的设计记录；实施中经审阅追加的四处决定见 §9
分支：`fix/115-subtitle-budget`（从 `origin/main` c49300c 开）
关联：待办①（记忆 `backlog-2026-09-20-subtitle-budget-and-brands`），事故 run `d98dc4ca-a4ad-483d-bece-4cfd99bc792a`（欺诈游戏 / LIAR GAME 2026，anime，115 盘 `cs_103164004`）

## 1. 问题（一手证据）

生产 `agent_steps.payload.apiCalls`（每步累计 115 调用数）：

| 步 | 工具 | apiCalls |
|---|---|---:|
| 15 | viewSubtitleSnapshot | 33 |
| **16** | **transferSubtitle（assrt 包 136719，22 个 srt）** | **33 → 293，耗时 580s** |
| 17 | transferCandidate（磁力） | 300，中途耗尽 |
| 18–23 | inspectStaging / moveToSeason ×2 / markObtained / discardStaging / finish | 全被 `PAN115_RATE_LIMIT` 拒绝 |

结果：13+2 集视频和 8 个 srt 全滞留 staging，季目录空，DB 却已标 14 集 obtained。

根因不是「字幕包大」，是**字幕落盘的计费模型从没进过 300 次预算的设计**：

1. `Storage115Executor.transferSubtitleUrl` **每个文件独立**：写域校验 1（staging 不是写域根 → `getDirectoryInfo`）+ 提交前深 2 快照（1 + 一级子目录数）+ `addOfflineTask` 1 + 最多 8 轮深 2 轮询 + 未落地再 `listOfflineTasks` 1 + `removeOfflineTask` 1。事故 staging 有 3 个视频包子目录，每轮轮询 = 4 次调用。成功一个 ≈ 20 次，失败一个 = 31 次；8 成 3 败 ≈ 260，对得上账。22 个文件全顺也要 400+。
2. `TaskSandbox.transferSubtitle` 逐文件 for 循环，只有「连续 3 败熔断」，对预算一无所知（StorageV2 端口没有预算概念）。
3. 软提醒（240）只在每步开始注入，一步从 33 跳到 293 没有插话机会；硬上限 300 对所有操作一视同仁，收尾（搬季目录 / 删 staging）和转存共用同一个计数器，转存把收尾的额度吃光。

**读盘取证（2026-09-20，只读 webapi 列目录）**：staging `3522136304546481686` 一层里 8 个 `Liar_Game_epNN.chs/cht.srt` 的父 cid 就是 staging 本身，三个视频包才是子目录。**115 的 http 单文件离线任务直接落在目标目录根，不套包装目录。**

## 2. 目标 / 非目标

目标：
- 一个 N 文件字幕包的 115 调用数从 O(N × 轮询) 降到 O(N + 轮询)：22 文件 ≈ 35–45 次（原 260–440）。
- 无论 agent 怎么花，收尾（inspect / move / delete）永远有额度：转存类调用在硬上限之前的**保留额**处被拒，读/搬/删继续到 300。
- 软 240 / 硬 300 的作者拍板不动，**不调大 300**。
- 模拟器 `Storage115Simulator` 的成本模型同步。
- 光鸭执行器零改动；123（待办②）以后只需实现单文件方法即可点亮，批量是可选加速。

非目标：
- 不做 115 `add_task_urls` 批量提交端点（未在真机验证过，留作后续；N 次 `addOfflineTask` 已够）。
- 不改视频转存的落地窗口。
- 不动生产实例、不动欺诈游戏的脏状态（网盘文件 + DB 14 条 obtained）。
- 不加新的 env 开关（保留额是常量，导出供测试）。

## 3. 方案取舍

| 方案 | 效果 | 取舍 |
|---|---|---|
| (a) 整包批量提交 + 统一轮询 | ~10×，根治字幕路径 | 端口加一个可选批量方法，adapter/sandbox 改调用方式 |
| (b) 预算分层：转存类在 `hard − reserve` 处拒 | 结构性保底，对所有步骤生效 | 只改 `Pan115ApiGuard.assertBudget` 与两个工厂 |
| (c) 轮询深 1 | 每轮 1 次而非 1+子目录数 | 依赖「字幕落根」事实，已取证 |
| 调大 300 | 治标 | 违反作者拍板，且再大的包照样吃光；**否决** |
| sandbox 循环里感知预算 | 能提前停 | StorageV2 不该知道 115 预算；批量后不再需要；**否决** |

采用 (a)+(b)+(c)。可观测性（字幕 attempt 落 transfer_attempts、guard onEvent 接日志）不在本次范围。

## 4. 设计

### 4.1 端口：`StorageExecutor.transferSubtitleUrls?`（`packages/workflow/src/ports.ts`）

```ts
/** 可选的批量变体：一次提交整包，每轮只列一次目录为全部文件认领。
 *  单文件方法 transferSubtitleUrl 仍是能力门控（orchestrator 只探测它）；
 *  轮询成本主导的品牌（115）实现批量，RealStorageV2 有则用之，无则逐文件循环。 */
transferSubtitleUrls?(input: {
  files: Array<{ url: string; filename: string }>;
  directoryId: string;
  workflowRunId: string;
}): Promise<TransferAttempt[]>;   // 与 files 同序、同长，每个文件一条 attempt
```

### 4.2 115 执行器：`transferSubtitleUrls` + 单文件委托

`Storage115Executor.transferSubtitleUrls(input)` 算法（`callApi` 计数以 `Pan115ApiGuard` 为准）：

1. **边界**（零 API）：每个文件分配一个 attempt 号（沿用共享计数器，一文件一号）。含路径分隔符的文件名 → `failed` / `SUBTITLE_INVALID_FILENAME`（与现在相同文案，candidateId 不含原名）。包内重复文件名 → 第二个起 `failed` / `SUBTITLE_DUPLICATE_FILENAME`（同名落地无法区分）。没有有效文件 → 直接返回，不碰 API。
2. **写域校验 1 次**：`assertWithinWriteScope(directoryId, "transfer subtitle")`，整包共用。
3. **before 快照 1 次**：`listTree({ directoryId, maxDepth: SUBTITLE_LANDING_DEPTH })`，记 basename → 已有 fileId 集合。`SUBTITLE_LANDING_DEPTH = 1`，注释写明 2026-09-20 取证（见 §1）。
4. **提交**：按序对每个有效文件 `addOfflineTask`。`ok:false` 计一次拒绝；连续 3 次拒绝后停止提交，其余文件 `failed` / `SUBTITLE_NOT_SUBMITTED: aborted after 3 consecutive rejections (last: …)`。`Pan115RiskControlError`（预算/熔断）→ **立即**停止提交（后续必然同样被拒，省下 minDelay 等待），其余同上标 `SUBTITLE_NOT_SUBMITTED`；已提交的继续轮询。
5. **统一轮询**：首轮立即，之后每轮间隔 `subtitleMaterializePollMs`。每轮 1 次 `listTree` 深 1，按 basename 认领 before 里没有的新 fileId（一文件只认领一次）。终止条件三选一：全部落地；**连续 `subtitleMaterializeAttempts` 轮无新落地**（默认 8 轮 = 单文件时的 42s 语义不变）；总轮数达到 `subtitleMaterializeAttempts + 有效文件数`（兜底上限，每个文件最多多换一轮耐心）；或 **`apiGuard.callsSpent() ≥ apiGuard.transferCallBudget()`**（轮询绝不花进收尾保留额）。
6. **批量取消**（仅有未落地文件时，best-effort try/catch）：`listOfflineTasks` 1 次；每个未落地 url 在任务表里**唯一**匹配才取其 infoHash；有则 `removeOfflineTask({ infoHashes: [...] })` 1 次。未落地文件 → `no_target_change` / `subtitle offline task accepted but file did not materialize in window`（文案不变）。
7. 返回与 `files` 同序的 `TransferAttempt[]`（id `${run}_subtitle_${n}`，candidateId `subtitle:${filename}`）。

`transferSubtitleUrl(single)` = `(await this.transferSubtitleUrls({ files: [file], … }))[0]`，现有 10 个单文件测试语义全保持（逐条核过：窗口选项、宽窗、不认旧同名、无效名不耗 API、成功/失败/未落地/取消/id 唯一）。

成本（N 有效文件，p 轮轮询）：`≤ 1 + 1 + N + p + 2`，`p ≤ 8 + N`。22 文件、10 轮 ≈ 36 次；最坏 2N + 12 = 56。

### 4.3 预算分层：`Pan115ApiGuard` 转存保留额

- `Pan115ApiGuardOptions.transferReserveCalls?: number`，默认 **0**（裸 guard 行为不变，现有小预算测试不受影响）。
- 转存类操作 = `receiveShare` | `addOfflineTask`（引入新内容的调用）。`assertBudget(op)`：转存类在 `callCount ≥ max(1, hard − reserve)` 时抛 `Pan115RiskControlError`；其它操作（`listItems` / `getDirectoryInfo` / `moveItems` / `deleteItems` / `renameFile` / `createFolder` / `listOfflineTasks` / `removeOfflineTask`）沿用硬上限。
- 拒绝**不开熔断、不计数**（与现有硬上限拒绝一致）。消息保留 `PAN115_RATE_LIMIT:` 前缀（smoke 脚本按它匹配），正文说明：已花 X/硬上限，转存在 Y 处停止，剩余 Z 次只留给 moveToSeason / flattenMovie / discardStaging，别再转存、立刻收尾。事件 kind 沿用 `budget_exhausted`。
- 新访问器 `transferCallBudget()`；执行器内部用它做 §4.2 第 5 条的轮询止损。
- 常量 `PAN115_TRANSFER_RESERVE_CALLS = 40`，两个工厂（`createProtectedStorage115Executor`、`createBootstrapPan115CookieStorageExecutor`）都传入。数值依据：一次收尾 ≈ inspectStaging（1 + 子目录）+ moveToSeason（staging 列 ×2 + 搬 + 季目录列）+ discardStaging（写域 1 + 删 1 + harness 回读 1）≈ 15–20 次；40 容得下一次半。
- 阈值顺序（加测试钉死）：软 240 < 转存止 260 < 硬 300。软提醒仍先于机械拒绝，agent 在 240–260 之间保留自主裁量。
- `BUDGET_REMINDER` 追加一句：转存类调用会在硬上限之前的保留额处被系统直接拒绝，剩余额度只留给收尾。现有断言（markObtained / 不是失败 / discardStaging / flattenMovie）不变。

### 4.4 StorageV2 表面与模拟器（`storage-115-simulator.ts`）

- `StorageV2.transferSubtitleUrl` **替换为** `transferSubtitleUrls(input: { files: Array<{url; filename}>; intoDirectoryId }): Promise<Array<{ filename: string } & TransferAttemptResult>>`。接口只有批量一个生产路径，不留两条会漂移的路。
- `Storage115Simulator` 保留 **public** `transferSubtitleUrl`（单文件，测试注入点，不在接口上），`transferSubtitleUrls` = `spendBudget(1)`（整包共享开销）后逐文件调 `this.transferSubtitleUrl`（每个 1）。成本 1 + N，与 `transferCandidate` 的 `1 + files.length` 同一口径。测试里 `class X extends Storage115Simulator { override transferSubtitleUrl }` 的脚本化仍通过虚分派生效。

### 4.5 `RealStorageV2.transferSubtitleUrls`（`real-storage-adapter.ts`）

```
executor.transferSubtitleUrls 存在 → 一次调用，结果按序映射（attempt.status === "succeeded" ? succeeded : failed，带 providerMessage）
否则 executor.transferSubtitleUrl 存在 → 逐文件循环 + 连续 3 败熔断（从 sandbox 下沉）
否则 → throw REAL_STORAGE_NO_SUBTITLE_SUPPORT
```
熔断后未尝试的文件标 `failed`，providerMessage = 现有中文文案「已连续 3 个字幕文件落盘失败,提前中止(剩余 K 个未尝试)。字幕是软目标——不要重试,带着已落的继续,或直接只交付视频。 最后错误: …」。字幕 attempt 仍**不进** `attempts()`（快照校验不变量）。

### 4.6 `TaskSandbox.transferSubtitle`（`sandbox.ts`）

前置校验（storage/provider/快照/detail/扩展名过滤/zip-only）不变。之后**一次** `storage.transferSubtitleUrls({ files, intoDirectoryId: staging })`：`landedFilenames` = succeeded 的文件名（按序）；`error` = 最后一个 failed 的 providerMessage；没落地且无消息 → 现有兜底文案。返回形状 `{status, landedFilenames, error?}` 不变，agent 工具描述不变。

### 4.7 不变的部分

orchestrator 能力门控（`typeof executor.transferSubtitleUrl === "function"`）、光鸭执行器、skill 文本、`transferSubtitle` 工具 schema、`transfer()` 视频窗口、`agent-trace-sink` 的 apiCalls 记录。

## 5. 错误处理与边界

- 批量中单个文件的任何失败都不影响其它文件；整包 0 落地 = `failed`（软目标，不阻塞视频）。
- 预算拒绝在提交阶段：立即停提交、照常轮询已提交的、照常取消未落地的（取消是非转存类，允许到硬上限）。
- 轮询止损用 `transferCallBudget()`：裸 guard（reserve 0）等价于「到硬上限前一刻停」，把本会抛出的 `PAN115_RATE_LIMIT` 变成优雅的 `no_target_change`。
- `alreadyTransferred`（任务已存在）沿用今天的处理：算 ok、照常轮询、未落地照常按 url 唯一匹配取消。
- `listOfflineTasks` 只读第一页，与现状一致。

## 6. 测试计划（TDD，每条先红后绿）

- `tests/pan115-guard-transfer-reserve.test.ts`（新）：reserve 0 = 旧行为；reserve 40/hard 300 → 260 后 receiveShare/addOfflineTask 拒、listItems/moveItems/deleteItems/renameFile/getDirectoryInfo/listOfflineTasks/removeOfflineTask 放行到 300；拒绝不计数、不开熔断；消息含 `PAN115_RATE_LIMIT` + 收尾说明；`transferCallBudget()` 钳 ≥1；事件 kind。
- `tests/agent-loop-guards.test.ts`：软 < 转存止 < 硬 的顺序；`BUDGET_REMINDER` 新句子 + 旧断言。
- `tests/storage-115-executor.test.ts`：工厂传入保留额（小预算 env 下转存被拒、列目录仍行）；批量调用账目（3 文件全落 = before 1 + 提交 3 + 轮询 1）；空闲耐心（落一个后其余按 attempts 轮停）；总轮数兜底；批量取消一次 list + 一次 remove 携全部唯一匹配 hash、0/多匹配不取消；重复文件名；无效文件名零 API 且不影响其它；连续 3 拒停提交；guard 拒绝立即停提交且已提交的照常轮询；轮询在 `transferCallBudget` 处止损；单文件委托批量；attempt 号一文件一号按序唯一；结果与输入同序。现有 10 条单文件测试不改、必须仍绿。
- `tests/v2-real-storage-adapter.test.ts`：有批量方法优先用（一次调用、全量文件、按序映射）；无则循环 + 连续 3 败熔断（3 次调用、其余带「连续」文案）+ 成功重置计数；两条路都不进 `attempts()`；都没有 → `REAL_STORAGE_NO_SUBTITLE_SUPPORT`。
- `tests/v2-sandbox-subtitle.test.ts`：整包一次交给 storage（子类计数 `transferSubtitleUrls` 调用 1 次、files 长度 N）；部分成功 / 过滤 / zip-only / 快照校验保留；原「连续 3 败」两条迁到 adapter。
- `tests/v2-storage-115-simulator.test.ts`：批量成本 1 + N，预算不足中途抛 `PAN115_RATE_LIMIT`。
- 全绿门槛：`npm run typecheck`、`tsc -p apps/web/tsconfig.json`、`npm run build:workflow`、vitest 全量。

## 7. 验收

1. 单测账目：22 文件全落 ≤ 40 次；22 文件 10 落 12 未落 ≤ 60 次。
2. Live（**不用生产实例**）：本地 dev 或桌面端连真 115，跑一条需要外挂字幕、assrt 包 ≥ 20 文件的获取（欺诈游戏包 136719 有 22 个 srt），查 `agent_steps.apiCalls`：transferSubtitle 一步 ≤ 60 次，整场远低于 300，收尾（moveToSeason / discardStaging）正常。若本机无法安全连真 115（cookie 归属/设备风险），停下报告，由用户在桌面端跑。
3. PR + Copilot 评审清零后合并；不部署 main，随下一发行版（待办① + Jev 可体验）一起发。

## 8. 决策记录（用户可否决）

- 保留额 40（非 60）：让软提醒 240 先于机械拒绝 260，保住 agent 20 次裁量。
- 常量而非 env：避免又一个没人文档化的开关；要调直接改常量。
- StorageV2 接口只留批量：单文件留在模拟器上当测试注入点。
- 熔断策略下沉到 adapter：谁知道一次失败的成本，谁决定何时止损。
- 轮询深 1：基于本次取证，若 115 将来把 http 文件套包装目录，后果是字幕软失败（视频不受影响），可接受。

## 9. 实施中追加的决定（审阅抓出，与 §4 有出入处以本节为准）

1. **预检替代「轮询止于转存线」的饥饿场景**：§4.2 第 5 条的轮询止损单独看正确，但与「提交被保留额截停」组合时会让已提交文件一轮都轮不到（callsSpent 恰好停在转存线）。改为在任何 API 调用之前预检 `needed = 2 + N + subtitleMaterializeAttempts ≤ transferCallBudget − callsSpent`，装不下则整包零调用拒绝（`SUBTITLE_BUDGET_INSUFFICIENT`）；轮询止损保留为纯兜底，且到线即停不多睡一轮。
2. **`transfer()` 首行先查转存线**（`Pan115ApiGuard.assertTransferBudget`），被拒的视频转存不再白花写域校验与 before 快照；转存线钳在 `[0, hard]`（reserve ≥ hard 时无转存额度；hard=0 时转存与列目录同样被拒）。
3. **适配器批量路径**：executor 返回的 attempts 数量必须与输入文件数一致（`REAL_STORAGE_SUBTITLE_BATCH_ARITY`，契约违反保持抛出）；批量层面的普通抛错（写域违规、快照列目录失败）映射为全文件 `failed`，与逐文件回退路径的软失败形状对称。
4. **品牌鉴权错误永不软化**：`Pan115AuthError` / `GuangYaAuthError` 等（共享谓词 `isBrandStorageAuthError`，从 worker.ts 抽出）在执行器的提交/轮询/取消三个 catch 与适配器的两个 catch 里一律 rethrow——凭证死了不是落盘失败。

