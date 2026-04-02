# clawd-media-track Skill

This skill provides complete procedural knowledge for the clawd-media-track media acquisition system.

---

## FIRST ACTIONS (MANDATORY)

Before any clawd-media-track reasoning, method call, or conclusion:

1. Read `01-environment-contract.md`.
2. Read this file completely.
3. Read `03-methods-reference.md`.
4. Determine the task type correctly.
5. Read the matching type checklist before doing task-specific work.
6. Output step-labeled checkpoints exactly as required by the checklist.
7. **STOP before any side-effecting action and wait for explicit user confirmation.**

**DO NOT:**
- conclude "no resource" before query completion and required retries
- skip evidence output
- skip derived facts
- improvise new decision logic outside documented methods/rules
- execute transfer/create/delete/mark actions without explicit user confirmation
- skip post-action verification

If any item above is violated, treat the run as failure and report it honestly.

## ⛔ CRITICAL: New Iteration Rules (READ FIRST)

## ⛔ CRITICAL: No Glue Scripts Between Tools and Decisions

This system is intentionally designed as a loop:

`tool call` → `read full return` → `think (simple, human)` → `decide` → `next tool call`

**"Intelligence" means: read the returned data and make a decision in plain language.**
It does NOT mean writing helper code to "process" or "parse" tool returns.

### Forbidden: Glue Scripts (Hard Ban)

**You MUST NOT write any intermediate processing logic between tool output and your decision.**

This includes (not exhaustive):
- Any string matching/parsing logic: regex, substring checks, `in`, `split`, `find`, `startswith`, `endswith`
- Any number extraction from titles/filenames to infer episodes/coverage (e.g., 2026 → E20, 2160p → E21)
- Any helper functions like `parse_*`, `extract_*`, `is_*`, `match_*`, `normalize_*` that operate on tool output
- Any filtering/sorting/scoring code that decides which links/files "count" without first presenting the full evidence

### Allowed: Minimal Code

The only code you should write is:
- Calling documented methods
- Using `.each()` to collect **all** items into a plain list (no filtering in the callback)
- Printing/indexing items so the decision can be audited

### Tool Output Authority

Tool outputs are the ground truth.
- If you called `pan115.list_video_files()`, you MUST use that returned list to decide what is missing/duplicate.
- If your intuition conflicts with tool output, the tool output wins.

### Type 3 Selection Safety (Low-Overlap First)

In Type 3 (cron monitoring), the primary goal is to obtain missing episodes with minimal risk.

**If a candidate resource clearly covers ONLY the missing episodes (exact range / single episode), you MUST prefer it**
over a massive full-season pack, even if the full-season pack is higher resolution.

Rationale: Massive packs increase duplication + dedup risk and make it easier to hallucinate coverage.
Quality upgrades can be handled later after coverage is complete.

### 115 Directory and Scan Safety

Some 115 operations are low-level enough to damage library structure or trigger rate limits if used carelessly.

Treat the following as protected directories:
- `0`
- `CLAWD_MEDIA_ROOT_CID`
- `MOVIES_CID`
- `TV_SHOWS_CID`
- `ANIME_CID`

Rules:
- `flatten_directory()` is only for final landing directories:
  - movie leaf directories directly under `MOVIES_CID`
  - season leaf directories ending with `Season <number>`
- Never flatten root/media/category directories, even "just to test"
- `list_files()` is shallow by default. Do not attempt recursive scans on protected directories.
- If a method raises `SAFETY_VIOLATION`, stop and report the target/path. Do not retry with nearby CIDs.

### ⛔ Anti-Hallucination Gate: Evidence → Facts → Decision

You cannot prove you "really thought" internally.
So this system requires an auditable chain before any decision.

For EVERY decision point:
1. **Evidence (verbatim)**: list the relevant tool outputs with indices (e.g., `[i] title`, `[i] filename + size + fid`).
2. **Derived facts (plain language)**: write the facts you can justify from that evidence.
   - Example: "Existing episodes: E01, E08"; "Missing episodes: E20-E24".
3. **Decision (constrained)**: pick actions ONLY based on the derived facts.

If you cannot produce (1) + (2), you MUST NOT proceed.

#### Transfer Binding Rule (mandatory)

For transfer decisions, indices are evidence only; execution input must be stable identifiers.

- Extract links exactly once into a `LinkSnapshot` for the current decision window.
- After deciding, create an immutable `TransferPlan` immediately from that same snapshot: `plan=snapshot.create_transfer_plan([...], keyword=...)`.
- Transfer step MUST execute only that plan via `pan115.execute_transfer_plan(plan=plan, ...)`.
- Do not execute via `all_links[i]`, raw re-extracted strings, or freshly rebound indices at execution time.
- Between decision and transfer, do NOT re-extract/re-list/re-sort links.

Forbidden patterns:
- Re-running `extract_all_links(...).each(...)` between decision and transfer.
- `pan115.transfer(url=all_links[i]["url"], ...)` in execution step.
- `pan115.transfer(url="<raw string>", ...)` with an unbound URL.
- Re-searching the same keyword and creating a fresh snapshot/plan after the decision step.
- Any "decide on [i], then re-fetch and execute [i]" flow.

Short-term search stability:
- `pansou.search()` caches the same normalized keyword for a short TTL and returns the same result ordering during that window.
- This is a stabilizer for repeated same-keyword searches, not a substitute for `TransferPlan`.

#### Side-effect Verification (mandatory)

Any side-effect MUST be followed by a re-read verification step:
- After `transfer`: `list_video_files` again, and state what changed (new files / episodes)
- After `delete_*`: list again, and confirm kept vs deleted matches your plan
- Before `mark_obtained`: verify the episodes exist in the directory NOW (not "should exist")

### Unattended Type 3 Output Rule

In unattended cron runs, keep output focused and complete.
- Focused means no preamble/self-talk.
- Focused does NOT mean evidence truncation.
- Do NOT output long preambles (skill evaluation / confidence tables / self-talk)
- Do NOT paste large parts of this document
- Output evidence and decisions using the checklist step format

**Hard output contract (unattended runs):**
- Your first line of output MUST start with `[Type 3 - Step 1]` (or `Evidence:` if you are using the short Evidence/Decision format).
- If you output anything else before that (skill evaluation blocks, confidence tables, meta planning), treat it as a failure.

If you already read this file in the current run:
- Do NOT print "\uD83D\uDCD6 \u8C03\u7528 skill: clawd-media-track" again in the logs
- Proceed directly to `[Type 3 - Step N]` outputs

### ALL Collection Methods Return Protected Collections

The following methods now return **protected collection objects** that **FORCE full iteration**:

| Method | Returns | Protection |
|--------|---------|------------|
| `pansou.extract_all_links()` | `LinkCollection` | ❌ No slicing, ❌ No for-loop |
| `pan115.list_files()` | `FileCollection` | ❌ No slicing, ❌ No for-loop |
| `pan115.list_video_files()` | `FileCollection` | ❌ No slicing, ❌ No for-loop |
| `pan115.list_video_files_snapshot()` | `FileSnapshot` | ❌ No slicing, ❌ No for-loop, one-time delete apply |

### Correct Usage - Use `.each()` Method

```python
# ✅ CORRECT: Use .each() to iterate ALL items
links = pansou.extract_all_links(result["magnet"], "magnet")
# Output: 🔍 EXTRACT RESULT: 49 links found

all_links = []
links.each(lambda i, link: all_links.append(link))
# Output: ✅ Successfully processed all 49 links

# Now all_links contains ALL 49 links - analyze coverage
```

### Forbidden - Will Raise Errors

```python
# ❌ FORBIDDEN: Slicing
links[:5]  # ValueError: Slicing is NOT allowed!

# ❌ FORBIDDEN: For-loop
for link in links:  # ValueError: Direct iteration is NOT allowed!
    print(link)

# ❌ FORBIDDEN: Lazy callback
links.each(lambda i, link: print(link) if i < 5 else None)  # Wrong! Only processes first 5
```

### Why This Matters

**Before**: Agent could `links[:5]` and miss 44 resources, leading to incomplete coverage analysis.

**After**: Agent MUST see all 49 links to make intelligent decisions about which resources cover which episodes.

### Anti-Rationalization Rule (Hard)

No convenience excuse can override checklist or evidence requirements.

**Forbidden rationalizations (same severity as evidence truncation):**
- "This is just a test/demo/quick check"
- "I can merge these steps, it's obvious"
- "I will sample first N items, then decide"
- "Result looks fine, no need to re-verify"

**Fail-fast trigger:** if you detect any of the above thoughts, enter Recovery Mode first:
- `Recovery: RationalizationDetected`
- `Step=<N>`
- `Reason=<exact excuse>`
- `RollbackPoint=<last verified step>`
- `CorrectiveAction=<what you will do now to resume compliantly>`

Only report `Task Failed: RationalizationDetected` if recovery is non-recoverable after retries (RetryBudget=2).

### Evidence Completeness Rule (Hard)

After collecting items into a normal list (e.g., `all_links`, `all_videos`),
you are still required to keep evidence complete.

**Forbidden evidence truncation patterns (same severity as slicing protected collections):**

```python
# ❌ FORBIDDEN: Truncate evidence list before printing/analysis
all_videos[:15]

# ❌ FORBIDDEN: Print only first N
for v in all_videos[:15]:
    print(v)

# ❌ FORBIDDEN: Hide the rest
print(f"... and {len(all_videos)-15} more")

# ❌ FORBIDDEN: Early break/top-N loop
for i, v in enumerate(all_videos):
    if i >= 15:
        break
```

**Required behavior:**
- If the checklist says "Print EVERY ...", print every item with index.
- If output is long, split into multiple blocks/pages, but do not hide any item.

---

## ⛔ CRITICAL: Method Constraints

### Rule 1: ONLY USE DOCUMENTED METHODS

**You may ONLY call methods explicitly listed in this document.**

If a method is not in the "Quick Reference: Module Methods" section below, **IT DOES NOT EXIST**.

### Rule 2: METHOD NOT FOUND? RE-READ THIS DOCUMENT

If you call a method and get "method does not exist" or "AttributeError":
1. **Stop the current call and classify as recoverable**
2. **Re-read this SKILL.md** from the "Quick Reference" section
3. **Find the correct method name** - do not guess alternatives
4. **Copy the exact method signature** from the documentation
5. **Retry with the corrected method and continue the task**

Do NOT invent method names based on "what should exist".

### Rule 3: INSTANT TRANSFER - NO WAITING

**Both 115 share links AND magnet links are INSTANT transfers.**

115 has a massive resource library. When you call `transfer()` (auto-routes for both 115 and magnet):
- The transfer completes **immediately** (within seconds)
- Files appear **instantly** in the target directory
- There is **NO download queue**, **NO waiting period**, **NO progress to check**

**Correct workflow:**
```python
success, msg = pan115.transfer(url=url, save_dir_id=save_dir_id)
if success:
    pan115.flatten_directory(dir_id=save_dir_id)  # Flatten immediately
    files = pan115.list_video_files(cid=save_dir_id)  # Verify immediately
    # Done - files are already there
```

### Rule 4: Verify Before Calling

Before calling ANY method:
1. Is this method listed in "Quick Reference"?
2. Did I copy the exact method name and parameters?
3. Am I assuming something "should" exist?

**If unsure, re-read this document. Do not guess.**

---

## 🛡️ 诚实原则 (Integrity)

**用户欣赏诚实的失败，厌恶虚假的成功。**

- **❌ 绝对禁止**：为了让报告“好看”而掩盖错误、隐瞒未完成的步骤、或者偷偷 kill 进程。
- **✅ 正确做法**：先进入 Recovery 模式纠正并继续（RetryBudget=2）；仅在不可恢复时报告 "Task Failed: [原因]"。
- **记住**：技术错误可以修，诚信崩塌没得救。如实汇报是最安全的策略。

---

## System Overview

clawd-media-track automates media acquisition: **TMDB → Pansou → 115 Cloud Storage**

Three resource types:
- **Type 1**: One-time acquisition (movies / completed series with full coverage)
- **Type 2**: Tracking initialization (ongoing series / completed but incomplete coverage)
- **Type 3**: Scheduled monitoring (sub-agent cron job)

## Core Principle

**Main Agent handles Type 1 & 2. Sub-agent only handles Type 3 cron tasks.**

Never delegate Type 1 or Type 2 to sub-agents. Main agent must execute directly.

---

## Working Directory

**Project location**: the current clawd-media-track skill repository root.

All module files live under `./scripts/`.

**Before executing ANY code**, you MUST:
```bash
cd <resource-tracker-repo-root>
```

**115 Auth**:

115 authentication is provided by environment-backed configuration.

Do NOT hardcode cookies. Do NOT pass secrets manually if constructor defaults already read them.

✅ Correct:
```python
pan115 = Pan115Client()  # no args
```

---

## Virtual Environment

All scripts MUST be executed within the virtual environment. 
Use `./.venv/bin/python` instead of `python` or `python3`.

---


## Execution Rules

### 执行透明原则

执行任何 Type 1/2/3 任务时，必须按 Checklist 汇报每一步：

**格式**：`[Type X - Step N] 动作 → 结果`

**示例**：
```
[Type 2 - Step 1] TMDB搜索 "太平年" → 找到 tmdb_id=279446
[Type 2 - Step 3] Pansou搜索 → 115: 5条, 磁力: 12条
[Type 2 - Step 4] 提取链接 → 共17条，分析覆盖情况...
[Type 2 - Step 7] 转存 3 个资源 → 2成功, 1过期
[Type 2 - Step 8] 扁平化 → 移动5文件，删除2文件夹
```

**禁止**：
- 跳步（每个 Checklist 项都要汇报）
- 静默执行多步后才汇报
- 只汇报最终结果

**无人值守模式（Type 3 Sub-Agent / Cron）额外禁止：**
- 不要输出大段“Skill Evaluation / Knowledge Confidence Check / 我将要做什么”之类的前置废话
- 不要重复粘贴整份规则或整份 Checklist
- 只输出证据与决策：严格按 `[Type 3 - Step N] 动作 → 结果` 推进

---

### One Step = One Decision Point

**NOT one method call = one step**

```python
# ❌ WRONG: Multi-step script (forbidden)
result = pansou.search("太平年")
links = pansou.extract_all_links(result["magnet"], "magnet")
for link in links:  # This will error anyway
    pan115.transfer(link["url"], folder_id)

# ✅ CORRECT: Step by step with decision points

# Step 1: Search
result = pansou.search("太平年")
# ⚠️ STOP - Output `result_count=<n>` and require `result_count >= 1`

# Step 2: Extract and analyze ALL links
links = pansou.extract_all_links(result["magnet"], "magnet")
# Output shows: 🔍 EXTRACT RESULT: 49 links found
all_links = []
links.each(lambda i, link: all_links.append(link))
# Output shows: ✅ Successfully processed all 49 links
# ⚠️ STOP - Now analyze all 49 links to determine coverage

# Step 3: Intelligent decision (agent's value!)
# Based on all 49 links, decide which 9 resources provide best coverage
# This is where agent intelligence matters

# Step 4: Execute transfers (can batch, this is execution not decision)
for url in selected_urls:  # These are already-decided URLs
    pan115.transfer(url=url, save_dir_id=folder_id)
    # Simple success check, no complex decision needed
```

### When to Stop vs When to Batch

| Action | Stop? | Reason |
|--------|-------|--------|
| Search results | ✅ STOP | Need to see what exists |
| Extract links | ✅ STOP | Must see all to analyze coverage |
| Analyze coverage | ✅ STOP | Agent intelligence decision point |
| Transfer selected | ❌ Can batch | Already decided, just execute |
| Verify results | ✅ STOP | Need to check what actually landed |

---
