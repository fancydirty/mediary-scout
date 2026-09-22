# 123网盘外挂字幕落盘（待办②）— 设计

日期：2026-09-21
状态：2026-09-22 真盘 smoke 翻案，按 §8 重设计实施中（本 session 自主拍板；用户可在 PR 里否决任一决策）
分支：`feat/pan123-subtitle`（从 `origin/main` 0a082cc 开）
关联：待办②（记忆 `backlog-2026-09-20-subtitle-budget-and-brands`）、PR #261（定下的字幕端口契约）、`subtitle-completion-feature`（光鸭 #89 先例）

## 1. 目标

让 123网盘用户也拿到外挂中文字幕：`Pan123StorageExecutor` 实现 `transferSubtitleUrl`（能力门控，orchestrator 探到即自动点亮）和 `transferSubtitleUrls`（批量，RealStorageV2 优先用）。用户是 10 年会员，配额不是约束。

## 2. 真机取证（2026-09-21，生产容器内用分支 dist 直打真 123 盘，隔离目录建完即删；5 个探针）

| 事实 | 证据 |
|---|---|
| `v2/offline_download/task/resolve` **接受 assrt http 直链**，返回 `type:"http"`、`name`（URL 路径段解码后的文件名）、`size`、`id`（resource_id）、`files:[{id,name,size}]` | 探针 1：`The Matrix Reloaded.2003.ass` result=0 |
| **一次 resolve 只能一条 URL**：5 条换行拼接 → 顶层 `code:5252 您输入的链接数量超过了限制`；2–3 条 → 只有第一条 result=0，其余 result=1 err_code=3（有时 err_msg「解析失败：暂不支持 TransferEncoding: chunked 链接」，有时空）；同一批失败的 URL 单条重试全成 | 探针 3/4/5 |
| 单条 resolve 连打 10 次（1s 间隔）全成，无限流 | 探针 5 A |
| `submit {resource_list:[…], upload_dir}` → `task_list:[{task_id, result, resource_id}]`；单资源已验；**多资源一次 submit 未验**（探针 3 因 resolve 全败没跑到） | 探针 1/2 |
| 任务行（`offline_download/task/list`）字段：`task_id,name,status,size,third_task_id,downloaded,progress,upload_idr(目标目录),upload_name(目标目录名),type,speed`；**没有落地 fileId** | 探针 1 |
| http 任务 status 0→2 约 7s；文件**直接落在 upload_dir 根**，名字 = resolve 的 `name`；无包装目录 | 探针 1/2 |
| `task/delete` 已完成任务**不删文件**（删前后目录一致） | 探针 2 |
| 同名再落一次 → `name(1).ext`，不覆盖 | 探针 2 |
| assrt 包里可能带 macOS `._xxx.ass` AppleDouble 垃圾（384B），扩展名过滤器放过它 | 探针 2 |
| assrt 本身对这些 URL 返回 Content-Length（非 chunked），err_code=3 是 123 侧多 URL 解析的伴生错，不是 assrt 问题 | 探针 4 |

## 3. 方案

### 3.1 端口契约不变（#261 定下）
- `transferSubtitleUrl(single)` = 能力门控；`transferSubtitleUrls(batch)` = 可选加速，`RealStorageV2` 有则用。123 两个都实现，单文件委托批量（同 115）。

### 3.2 `Pan123Client` 新增两个方法（`pan123-client.ts`）
```ts
/** 一次 submit 多个已 resolve 的资源。返回与 resources 同序的每项结果。 */
submitOfflineResources(input: { resources: Array<{ resourceId: string; fileIds: string[] }>; uploadDirId: string })
  : Promise<Array<{ resourceId: string; taskId: string | null; error: string | null }>>;
/** 按 id 集合读任务行（分页 status_arr [0,1,2,3]，最多 maxPages 页，默认 3）。 */
listOfflineTasks(taskIds: string[], opts?: { maxPages?: number }): Promise<Pan123OfflineTask[]>;
```
- `submitOfflineResources`：body `{resource_list:[{resource_id, select_file_id}], upload_dir}`（同 `submitOffline` 的数字化规则），按 `task_list[i].resource_id` 对回输入；`result≠0` → `error = err_msg || "provider rejected submit"(+err_code)`。顶层 `code≠0` 抛（`signed` 已做）。
- `listOfflineTasks`：复用 `getOfflineTask` 的分页体，改为集合匹配、提前停止（全部找到即停）。`getOfflineTask` 保留（磁力路径在用）。
- `resolveOffline` 不改（单 URL，抛错语义正确）。

### 3.3 `Pan123StorageExecutor.transferSubtitleUrls`（`pan123-storage-executor.ts`）
新增选项 `subtitleTaskPollMaxPolls?: number`（默认 16）、`subtitleTaskPollIntervalMs?: number`（默认 3000）、`subtitleResolveGapMs?: number`（默认 1000；resolve 之间的间隔，探针 5 A 的节奏），全部可注入、测试传 0/`sleep` no-op。

算法（N 个文件）：
1. **attempt 号**：从共享 `nextTransferNumber` 一次分配 N 个（同 115/光鸭「一文件一号」）。
2. **边界（零 API）**：含 `/`/`\\` → `failed` `SUBTITLE_INVALID_FILENAME`（candidateId 不含原名，同 115/光鸭文案）；包内重名 → `failed` `SUBTITLE_DUPLICATE_FILENAME`。没有有效文件直接返回。
3. **写域**：`assertWithinWriteScope(directoryId, "transfer subtitle")`（同步，derived scope）。
4. **before 快照 1 次**：`client.listFiles(dir)` → 已有 `name → id`。
5. **逐条 resolve**（一次一条，是 123 的硬约束）：`resolveOffline(url)`；成功记 `{resourceId, fileIds, resolvedName}`；抛 `Pan123AuthError` → **rethrow**；其它抛错 → 该文件 `failed`，providerMessage = 错误消息（含 123 的 err_msg，如「暂不支持 TransferEncoding: chunked」）；连续 3 个 resolve 失败 → 停止后续 resolve，其余 `failed` `SUBTITLE_NOT_SUBMITTED: aborted after 3 consecutive resolve failures (last: …)`。每次 resolve 之间 `sleep(subtitleResolveGapMs)`。
6. **提交**：先 `submitOfflineResources` 一次全提；若该调用**抛错**（非 Auth），回退逐资源 `submitOffline`（一次一个）——多资源 submit 未在真机验过，回退是保险。每项 `error` → 该文件 `failed`（providerMessage 固定前缀 `PAN123_OFFLINE_SUBMIT_FAILED: ` + 原文）。
7. **统一轮询**：`listOfflineTasks(pendingTaskIds)` 每轮 1 次；`status 2` → 该文件待验；`status 1` → `failed` 固定文案 `PAN123_OFFLINE_FAILED: offline task failed at progress=N`（**绝不插入 task.name**，同磁力路径的 systemic 词表教训）；`status 0/3` → 继续。全部终态即停；否则最多 `subtitleTaskPollMaxPolls` 轮，轮间 `sleep(interval)`。
8. **认领 1 次**：`client.listFiles(dir)` 一次；对每个 status-2 文件，按 **resolvedName（优先）或 assrt filename** 找 before 里没有的新 id → `succeeded` + `materializedFileIds:[id]`；找不到 → `no_target_change`「SUBTITLE_NOT_LANDED: 任务报告完成但文件不在目标目录」（光鸭同款）；窗口内未终态 → `no_target_change`「SUBTITLE_NOT_LANDED: 离线任务在轮询窗口内未落盘(任务可能迟到,不等)」。
9. **清理**：`deleteOfflineTasks(全部我的 task_id)`（已完成的也删——探针 2 证明不删文件；释放任务列表，与磁力路径一致）。失败只记日志不抛（字幕软目标；磁力路径的 `PAN123_OFFLINE_CLEANUP_FAILED` 是为防视频双落，字幕迟到只是 staging 垃圾）。`Pan123AuthError` 仍 rethrow。
10. 返回与 `files` 同序的 `TransferAttempt[]`（id `${run}_subtitle_${n}`，candidateId `subtitle:${filename}`）。

成本（N 文件，p 轮）：before 1 + N resolve + 1 submit + p 轮询 + 1 认领 + 1 删除 = N + p + 4；22 文件 ≈ 30 次、约 22s（resolve 间隔）+ 轮询。123 无 API 预算护栏（无 `Pan115ApiGuard` 同类），只有 `file/list` 700ms 的服务端限流——本算法只列目录 2 次。

`transferSubtitleUrl(single)` = `(await transferSubtitleUrls({files:[…]}))[0]`。

### 3.4 sandbox 边界：过滤 AppleDouble
`sandbox.ts` 字幕文件过滤加 `!file.filename.startsWith("._")`（探针 2 真机看到 `._The Matrix Reloaded.2003.ass` 384B 落盘；`subtitle-completion-feature` 记忆里早有此待修）。品牌无关，一行 + 一测。

### 3.5 UI 文案
- `apps/web/app/settings/page.tsx`：「需网盘支持外链离线（目前：115）」→「需网盘支持外链离线（115 / 光鸭 / 123 支持；夸克、天翼无离线接口不触发）」。
- `apps/web/components/assrt-token-form.tsx`：「115/光鸭支持；夸克暂不触发」→「115 / 光鸭 / 123 支持；夸克、天翼无离线接口不触发。123 的 http 离线下载受该账号离线配额约束（非会员配额很小）」。

### 3.6 不改
orchestrator 门控、skill 文本（SUBTITLE 节品牌无关；123 的 dead-links 节讲的是视频转存）、`transferModelLine`、光鸭/115 执行器、`RealStorageV2`（已批量优先）、`resolveOffline`/`getOfflineTask`/`submitOffline`。

## 4. 错误语义
- `Pan123AuthError` 任何阶段 rethrow（`isBrandStorageAuthError` 在 adapter 也放行）。
- resolve/submit 的 provider 错误 → 该文件 `failed` 带原文（agent 能看到「暂不支持 TransferEncoding」「云下载配额不足」）；`云下载配额不足` 命中 SYSTEMIC 词表但字幕 attempt 不进 transferAttempts，不会触发 systemic stop（与 115 一致）。
- 整包 0 落地 → sandbox 报 `status:"failed"` + 最后一个失败消息（软目标不阻塞视频）。

## 5. 测试
- `pan123-client.test.ts`：`submitOfflineResources` 多资源体形状 + 按 resource_id 对回 + 单项 result≠0 映射 error + bigint 任务 id；`listOfflineTasks` 集合匹配跨页、全部找到提前停、maxPages 封顶。
- `pan123-storage-executor.test.ts` 新 describe `transferSubtitleUrl(s)`：成功落地（resolve→submit→list status 2→listFiles 认领）+ id/candidateId 形状；path-y 名零 API；重名；resolve 抛 provider 错 → 该文件 failed 其余照常；连续 3 resolve 败停止；submit 项 error → failed；status 1 → 固定文案不含 task.name；窗口耗尽 → no_target_change + 删任务；status 2 但目录无该名 → no_target_change；多资源 submit 抛错回退逐个；删除失败不抛；AuthError 在 resolve/poll/list 三处 rethrow；写域拒绝；与 `transfer()` 共享计数器；单文件委托批量；resolvedName 优先于 assrt filename 认领；调用账目（N 文件 = 1 + N + 1 + p + 1 + 1）。
- `v2-sandbox-subtitle.test.ts`：`._` 文件被过滤、零 storage 调用。
- `orchestrator-subtitle.test.ts` 已有「能力门控与品牌无关」——不加。
- 门槛：typecheck / apps/web tsc / build:workflow / vitest / lint。

## 6. 验收
1. 单测账目 22 文件 ≈ 30 次。
2. **真盘 smoke**（生产容器内分支 dist，隔离目录，跑完删）：一个 ≥20 文件的 assrt 包 → 落地数、耗时、每文件状态；顺带验证多资源 submit 是否被接受（决定 §3.3 第 6 步走主路还是回退）。
3. PR + Copilot 清零后合并；不部署 main（随下一发行版）。

## 7. 决策记录
- 一次一条 resolve 是硬约束（探针 3/5 三次复现 5252/err3），不做「先试批量再回退」——白花一次失败调用。
- 多资源 submit 主路 + 逐个回退：submit 的批量能力未验，但 body 本来就是数组；回退保证正确性。
- 删所有任务（含已完成）：磁力路径先例 + 探针 2 证明不删文件。
- 不做 upload_name/重命名落地：123 http 任务不接受指定名（任务行的 upload_name 是目录名），落地名 = resolve name；改名交给 agent 的 renameSubtitle（现有流程）。
- 不加 API 预算护栏：123 无 300 次一类的账号级预算模型；节奏用 1s resolve 间隔 + 3s 轮询。

## 8. 2026-09-22 真盘 smoke 翻案 → 重设计（取代 §3.2 的 submitOfflineResources 与 §3.3 第 5–9 步）

### 8.1 smoke 结果
生产容器内用分支 dist 直打真 123 盘（隔离目录，跑完即删）：assrt 包 671164（老友记 S3 Netflix，75 个 srt）→ **0 落盘**。59 个 `no_target_change`（轮询窗口内未落盘）、3 个 resolve `err_code=3`、13 个因连续 3 次 resolve 失败被中止；81 次调用、360 s。多资源 submit 没抛错，回退路径没触发。

### 8.2 三轮诊断探针（都自清理）坐实的事实
| 事实 | 证据 |
|---|---|
| **assrt 下载直链约 5 分钟过期**：同一 URL 在 detail() 后 0/2/4 分钟 HTTP 200、6/8 分钟 HTTP 402（xml） | 探针 6 E；assrt 官方文档：「请不要保存下载地址，因为每次生成的下载地址都是唯一的而且具有一定的有效时间」 |
| **123 在 submit 时才去下载**：resolve 后等 300 s 再 submit → 任务 6 s 内 status 1 | 探针 7 T |
| **resolve 每条约 5–6 s**（123 服务端去抓 assrt），75 条逐条 resolve ≈ 6–7 分钟 → 一次性 submit 时直链早已过期 | 探针 7 M、探针 8 P |
| **一次 submit 20 个资源：返回 20 个 task_id（result 全 0），任务却从未出现在 task/list，6 分钟零落盘**——静默失败；一次 5–6 个正常（6–12 s 落盘） | 探针 7 M vs 探针 6 B、探针 8 L6/L10 |
| **逐文件 resolve → 立即单资源 submitOffline**：24 个里 23 个提交（1 个 resolve err_code=3），139 s 提交完，23/23 status 2、按名认领 23/23，每个在自己 submit 后 6–12 s 落盘 | 探针 8 P |
| task/list **新任务排在第 1 页最前**（newest-first） | 探针 6 D |
| resolve 的 err_code=3 有一部分是瞬时的（assrt 对来自同一方的突发请求回 503：同 IP 15 个并发 GET → 13 个 503） | 探针 4/5/7 S/8 L10 |

### 8.3 新算法（N 个文件）
1–4 不变（attempt 号、边界、写域、before 快照 1 次）。
5. **逐文件流水线**（顺序）：对每个待处理文件——
   - 若已中止 → `failed` `SUBTITLE_NOT_SUBMITTED: <中止原因>`；
   - 若距批次开始已超过 `subtitleSubmitWindowMs`（默认 210 000，直链约 5 分钟有效，留余量；只拦**开始**，已开始的文件的 resolve+重试可略超窗口，余量覆盖）→ `failed` `SUBTITLE_NOT_SUBMITTED: 字幕直链约 5 分钟过期,整包太大,有效期内只提交了前 K 个;本文件未尝试`；K=0 且有过失败时改为 `…有效期内一个文件都没提交成功(最近一次失败: <原文>);本文件未尝试`（「整包太大」此时不成立，最近一次失败才是可行动的事实）；K=0 且一个文件都没来得及尝试（准备步骤就超了窗口）时为 `…开始提交前有效期已过;本文件未尝试`；
   - `resolveOffline(url)`；非鉴权失败 → `sleep(subtitleResolveRetryDelayMs=2000)` 后**重试一次**；仍失败 → 该文件 `failed`（provider 原文）；
   - 提交前再核一次：距批次开始已超过 `subtitleLinkLifetimeMs`（默认 240 000，直链被观测到仍存活的最长时间）→ 不提交，`failed` `SUBTITLE_NOT_SUBMITTED: 字幕直链约 5 分钟过期,本文件解析完成时已超过 240 秒,提交也会落空;本文件未提交`（窗口只拦开始，两次 60 s 超时的 resolve 可能跨过直链寿命）；
   - 立即 `submitOffline({resourceId, fileIds, uploadDirId})`（单资源，磁力路径与探针 8 都验证过）；非鉴权失败 → `failed` `PAN123_OFFLINE_SUBMIT_FAILED: …`（client 消息已带此前缀时不重复加）；成功 → 记下 task。
   - **一个计数器管「没拿到任务的文件」**：resolve 死或 submit 被拒都 +1，满 3 → 中止（`aborted after 3 consecutive files failed to submit (last: …)`）；只有**建成任务**才清零（resolve 成功但 submit 被拒不清零）。审查补：非会员离线配额耗尽时每个 submit 都被拒，只数 resolve 失败的话整包会空跑满 210 s，agent 还被告知「整包太大」。
6. **统一轮询**：`listOfflineTasks(未终态 taskIds)` 每轮 1 次，最多 `subtitleTaskPollMaxPolls` 轮、轮间 `sleep(subtitleTaskPollIntervalMs)`；status 2 → 待认领；status 1 → `failed` 固定文案 `PAN123_OFFLINE_FAILED: offline task failed at progress=N`（绝不插 task.name）；0/3/没找到 → 继续等。非鉴权轮询错误**容忍**：连续 3 次才停止轮询（不抛）。全部终态即停。轮询因错误提前放弃时，认领前补等到「最后一次 submit 后 15 s」（最多 15 s，墙钟回拨也不会放大）（每个文件在自己 submit 后 6–12 s 落盘；不补等的话尾巴会被判未落、随后被清理取消）。
7. **以目录为准认领（1 次 listFiles）**：凡提交成功且不是 status 1 的文件（含 status 2、仍在等、task/list 里找不到的）都参与认领：在 before 里没有的新文件中**分层、一对一**匹配：resolvedName → assrt 文件名 → 两者的 123 编号双胞胎 `stem(n).ext`（123 从不覆盖，同名已在目录时落成 `name(1).ext`；整包被窗口截断后重跑正是这种情况）；每一层对**所有**任务跑完才进下一层，避免某任务的兜底抢走另一任务的精确命中；找到 → `succeeded`（目录是事实，任务行不是）；找不到 → status 2 的写 `SUBTITLE_NOT_LANDED: 任务报告完成但文件不在目标目录`，其余写 `SUBTITLE_NOT_LANDED: 离线任务在轮询窗口内未落盘(已放弃等待)`（不再承诺「任务已删除」：删除失败会被吞，这句话可能不实）。认领列目录非鉴权失败 → 这些文件 `no_target_change` 并带错误原文（不抛）。
8. **清理放 finally**：`deleteOfflineTasks(本批创建的全部 taskId)`，非鉴权错误吞掉；鉴权错误只在主流程正常结束时抛出（不覆盖主流程已抛的错误）。
9. 删除 `Pan123Client.submitOfflineResources` 及其测试（多资源 submit 在 20 条规模静默失败，留着是陷阱）；`listOfflineTasks` 保留（注释补「newest-first 实测」）。执行器选项 `subtitleResolveGapMs` 删除（resolve 本身 ~6 s，不需要额外间隔），新增 `subtitleSubmitWindowMs`、`subtitleResolveRetryDelayMs`、`now`（可注入时钟，测试用）。

成本：before 1 + 每文件 resolve 1(+1 重试) + submit 1 + p 轮询 + 认领 1 + 删除 1 ≈ 2N + p + 3（「1 次列目录」是 ⌈条目数/100⌉ 个请求——listFiles 按 100 分页，两次列目录都必须完整：before 不全会让同名旧文件被认领，新文件可能落在任一页）；耗时 ≈ N × 6 s + 尾部 ~10 s。窗口内大约能提交 35 个文件。

### 8.4 跨品牌遗留（不在本 PR）
直链过期对所有品牌都成立：115 的 168 文件 smoke「120 落 / 48 超窗」很可能同因；光鸭逐文件落盘在大包上也会撞。根治要在 sandbox 层分块，并在分块间重新 detail() 续签直链（需跳过已落文件、别打乱 #261 的 115 预算账）——记入 backlog。
