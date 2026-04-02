## Quick Reference: Module Methods

All imports below assume the active Python session can resolve modules from `./scripts/`.
Do not invent alternate wrappers if the modules already exist there.

### tmdb_client.py

```python
from tmdb_client import TMDBClient
tmdb = TMDBClient()

# Search
results = tmdb.search("太平年")  # Returns {"movie": [...], "tv": [...]}
# ⚠️ STOP - Output `movie_count=<n>, tv_count=<n>, selected_type=<movie|tv>`

# Get TV details
details = tmdb.get_tv_details(tmdb_id=279446)
# ⚠️ STOP - Output `in_production=<bool>, latest_episode=<n>, total_episodes=<n>`

# Get season episodes
eps = tmdb.get_season_episodes(tmdb_id=279446, season_number=1)
# ⚠️ STOP - Output `episodes=[{season,episode,air_date}, ...]` and `episode_count=<n>`

# Discovery methods
tmdb.get_popular_movies(page=1)
tmdb.get_trending_movies(time_window="week")  # day or week
tmdb.get_trending_tv(time_window="week")
tmdb.get_now_playing_movies(page=1)
tmdb.get_upcoming_movies(page=1)
tmdb.get_popular_tv(page=1)
tmdb.get_on_the_air_tv(page=1)
tmdb.get_airing_today_tv(page=1)

# Advanced discovery with filtering
tmdb.discover_movies(
    sort_by="vote_average.desc",
    vote_count_gte=1000,
    year_from="1990",
    year_to="1999",
    genre_id=878,
    pages=3
)
tmdb.discover_tv(sort_by="vote_average.desc", vote_count_gte=100, pages=3)

# Genre lists
tmdb.get_movie_genres()  # Returns {28: "动作", 12: "冒险", ...}
tmdb.get_tv_genres()
```

`TMDBClient()` reads `TMDB_READ_TOKEN` from environment by default.

**Common Genre IDs**: 28=动作, 12=冒险, 16=动画, 35=喜剧, 80=犯罪, 18=剧情, 10749=爱情, 878=科幻, 53=惊悚, 27=恐怖

---

### pansou_client.py

```python
from pansou_client import PansouClient
pansou = PansouClient()

# Search
result = pansou.search("太平年")
# Returns: {"115": [...], "magnet": [...]} - raw result lists
# ⚠️ STOP - Output `115_count=<n>, magnet_count=<n>` via len(result["115"]), len(result["magnet"])

# Extract all links for evidence
links_115 = pansou.extract_all_links(result["115"], link_type="115")
# Output: 🔍 EXTRACT RESULT: X links found
# ⚠️ STOP - Must use .each() to iterate ALL
all_115 = []
links_115.each(lambda i, link: all_115.append(link))
# Output: ✅ Successfully processed all X links

# Freeze the current decision window for later planning
snapshot_115 = pansou.extract_link_snapshot(result["115"], link_type="115")

# Extract magnet links
links_magnet = pansou.extract_all_links(result["magnet"], link_type="magnet")
# Output: 🔍 EXTRACT RESULT: X links found
# ⚠️ STOP - Must use .each() to iterate ALL
all_magnets = []
links_magnet.each(lambda i, link: all_magnets.append(link))
# Output: ✅ Successfully processed all X links

# Freeze the current decision window for later planning
snapshot_magnet = pansou.extract_link_snapshot(result["magnet"], link_type="magnet")

# Same normalized keyword is cached briefly to stabilize result ordering
same_result = pansou.search("太平年")
```

`PansouClient()` reads `PANSOU_BASE_URL` from environment by default.

**Link dict format**: `{"title": "...", "type": "115/magnet", "url": "...", "password": "...", "source": "..."}`

**Keyword Rules**:

### For TV Shows (剧集)
- Must be Chinese (no SXXEXX, no "第X集")
- Can include "第X季" (e.g., "咒术回战 第三季")
- **NO season info in first search** (see Strategy below)

### For Movies (电影)
- **Use movie name ONLY, do NOT include year**
- Can try both Chinese and English names
- **NO year in search keyword** - it filters out valid results

```python
# ✅ CORRECT: Movie search - name only, NO year
result = pansou.search("侠影之谜")
result = pansou.search("Batman Begins")

# ❌ WRONG: Do NOT include year in movie search
result = pansou.search("侠影之谜 2005")      # Don't do this!
result = pansou.search("Batman Begins 2005") # Don't do this!
```

**Why**: Most resources don't include year in title. Adding year filters out valid results.

**Keyword Search Strategy (CRITICAL)**:

### For TV Shows - Search WITHOUT Season First

**ALWAYS start with show name ONLY, do NOT include season number in first search**

```python
# ✅ CORRECT: First search - show name only, NO season
result = pansou.search("匹兹堡医护前线")

# ❌ WRONG: Do NOT include season in first search
result = pansou.search("匹兹堡医护前线 第二季")  # Don't do this!
```

**Why**: Many resources don't include season info in title. Searching with season may miss them.

**TV Show Search Flow**:
1. Search without season → Check coverage
2. If insufficient, retry WITH season → Check coverage  
3. Try traditional Chinese → Check coverage
4. Give up if still no coverage

### For Movies - Search WITHOUT Year

**ALWAYS use movie name ONLY, do NOT include year**

```python
# ✅ CORRECT: Movie name only
result = pansou.search("侠影之谜")
result = pansou.search("Batman Begins")

# ❌ WRONG: Do NOT include year
result = pansou.search("侠影之谜 2005")      # Filters out valid results!
result = pansou.search("Batman Begins 2005") # Filters out valid results!
```

**Why**: Most movie resources don't include year in title. Adding year:
- Filters out valid results
- Returns fewer matches
- May miss best quality versions

**Movie Search Flow**:
1. Search Chinese name → Verify title matches
2. Search English name → Verify title matches
3. Compare results from both searches
4. Select best quality from verified matches

### Key Rules

| Media Type | Search Rule | Example |
|------------|-------------|---------|
| **TV Shows** | NO season in first search | "匹兹堡医护前线" NOT "...第二季" |
| **Movies** | NO year in search | "侠影之谜" NOT "...2005" |
| **Both** | Verify title matches BEFORE transfer | Skip "蝙蝠侠家族" for "黑暗骑士" |
| **Both** | NO transfer if no valid resources | Report "No valid resources found" |

**TV Show Example Flow**:
```
Missing: S02E04
Search 1: "匹兹堡医护前线" (no season) → 5 results, check coverage
Search 2: "匹兹堡医护前线 第二季" (with season) → 3 more results
Search 3: "匹茲堡醫護前線" (traditional) → 2 more results
Decision: One resource covers E01-E06 → Transfer ✅
```

**Movie Example Flow**:
```
Target: 黑暗骑士 (The Dark Knight)
Search 1: "黑暗骑士" → Check titles, verify matches
Search 2: "The Dark Knight" → Check titles, verify matches
Decision: Select best quality from verified matches → Transfer ✅
```

---

## ⛔ CRITICAL: Resource Title Verification (BEFORE Transfer)

**Before ANY transfer, you MUST verify the resource title matches the target show.**

### Verification Rules

| Title Pattern | Action | Example |
|--------------|--------|---------|
| Contains target show name | ✅ MUST evaluate for transfer (cite title index) | "黑暗骑士 4K HDR" for "黑暗骑士" |
| Similar/variant name | ✅ MUST evaluate for transfer (cite title index) | "The Dark Knight" for "黑暗骑士" |
| Completely unrelated | ❌ SKIP immediately | "蝙蝠侠家族" for "黑暗骑士" |
| Wrong show entirely | ❌ SKIP immediately | "The Road" for "黑暗骑士" |

### Forbidden Excuses

❌ **NEVER use these excuses to transfer mismatched resources:**
- "虽然标题不对但可能是别名" → NO, verify first
- "先转存看看内容" → NO, verify title first
- "不同的磁力可能有不同内容" → NO, title must match
- "需要不同的hash" → NO, irrelevant if title is wrong

### Correct Workflow

```python
# Step 1: Extract all links
links = pansou.extract_all_links(result["magnet"], "magnet")
all_links = []
links.each(lambda i, link: all_links.append(link))

# Step 2: Show evidence (NO filtering logic)
# Print ALL titles with indices, so the decision is auditable.
for i, link in enumerate(all_links):
    print(f"[{i}] {link['title']}")

# Step 3: Decide in plain language
# - Pick indices of links whose titles clearly refer to the target show.
# - Explain WHY each chosen title matches (use common sense, not parsing code).
# - Explain WHY each rejected title is wrong.

# Step 4: Create an immutable transfer plan once from the SAME snapshot
chosen_indices = []  # Filled after Step 3 decision (indices are evidence only)
snapshot = pansou.extract_link_snapshot(result["magnet"], "magnet")
plan = snapshot.create_transfer_plan(chosen_indices, keyword="太平年")
results = pan115.execute_transfer_plan(plan=plan, save_dir_id=folder_id)
```

### Real Example - What Went Wrong

**Target**: "黑暗骑士" (The Dark Knight)

**Search Results**:
- "蝙蝠侠家族[全集]-全集打包.1080p.HD中字.mp4" 
- "The Road：1的悲剧[全集]-05.720p.HD中字.mp4"

**Agent's WRONG action**: Transferred both because "need different hashes"

**Result**: 
- "蝙蝠侠家族" = 10-episode TV series (completely wrong)
- "The Road" = Unrelated drama (completely wrong)

**CORRECT action**: 
- Both titles clearly don't match "黑暗骑士"
- Report: "❌ No valid resources found"
- STOP, do not transfer

---

## ⛔ CRITICAL: Resource Selection Strategy (After Title Verification)

**After verifying titles match, you MUST select the BEST quality resource, NOT the first one.**

### Selection Priority (In Order)

| Priority | Criteria | Action |
|----------|----------|--------|
| 1 | File size | **Select LARGEST file** - size = quality |
| 2 | Release group | Prefer: FGT, SPARKS, CiNEFiLE, HiFi (high quality) |
| 3 | Audio track | Prefer: DTS, Dolby TrueHD > AC3 > AAC |
| 4 | Resolution | 4K > 1080p > 720p (but size matters more) |

### Forbidden: First-Match Selection

❌ **NEVER select the first matching resource without comparing:**

```python
# ❌ WRONG: First match
for link in all_links:
    # "Looks plausible" is NOT enough.
    # Picking the first plausible resource without comparing all candidates is forbidden.
    # (This example is intentionally incomplete - do NOT implement matching helpers.)
    pan115.transfer(url=link["url"], save_dir_id=folder_id)  # WRONG! Just picks first one
    break
```

### Correct: Compare All, Select Best

```python
# ✅ CORRECT: Show all candidates, then decide in plain language
for i, link in enumerate(all_links):
    print(f"[{i}] {link['title']}")

# STOP: In plain language, explain which titles match the target.
# Then, compare quality using obvious evidence in the title (e.g., explicit "16.68GB" vs "2.1GB",
# "2160p" vs "1080p", BluRay vs WEB-DL) WITHOUT writing parsing/matching code.

chosen_index = None  # Fill ONLY after the plain-language decision above.
if chosen_index is not None:
    chosen_url = all_links[chosen_index]["url"]  # bind once
    print(f"Selected index: {chosen_index}")
    pan115.transfer(url=chosen_url, save_dir_id=folder_id)
```

### Type 1 vs Type 2 Selection Strategy

**Type 1 (Movies / Completed Series)**: Prioritize QUALITY
- You will watch this ONCE, get the best version
- Compare ALL resources, select LARGEST file
- Never settle for "good enough" quality

**Type 2 (Ongoing Series)**: Prioritize COVERAGE
- Missing episodes > quality (for now)
- Get any version that covers missing episodes
- Can upgrade quality later when better resources appear

### Real Example - What Went Wrong

**Target**: "黑暗骑士" (The Dark Knight) - **Type 1 (Movie)**

**Valid Resources Found** (after title verification):
1. "黑暗骑士.1080p.国英双语.mkv" - 2.1GB (first in list)
2. "The.Dark.Knight.2008.1080p.BluRay.ALLiANCE.mkv" - 12.07GB
3. "The.Dark.Knight.2008.2160p.BluRay.FGT.mkv" - 16.68GB ⭐ **BEST**

**Agent's WRONG action**: 
- Treated Type 1 as Type 2 ("coverage over quality")
- Selected #1 (first match) because "it covers the movie"
- Result: Got 2.1GB compressed version

**CORRECT action**: 
- Recognize this is Type 1 (movie, one-time watch)
- Compare all 3 valid resources
- Select FGT 16.68GB (largest, best quality)
- Transfer best quality version

### File Size = Quality Reference

| Size | Typical Quality | Selection Priority |
|------|----------------|-------------------|
| > 15GB | 4K + DTS/TrueHD | ⭐⭐⭐ Highest |
| 8-15GB | 1080p + high bitrate | ⭐⭐⭐ High |
| 4-8GB | 1080p standard | ⭐⭐ Medium |
| 2-4GB | 1080p compressed | ⭐ Low |
| < 2GB | 720p or heavily compressed | ❌ Avoid if larger exists |

---

### pan115_client.py

```python
from pan115_client import Pan115Client
pan115 = Pan115Client()

# Create folder
folder_id = pan115.create_folder(name="Folder Name", parent_id="0")
# ⚠️ STOP - Output `folder_id=<cid>` (non-null)

# List files (returns FileCollection - must use .each())
files = pan115.list_files(cid="0")
# Default is depth=1 (shallow current-level listing only)
# ⚠️ Protected directories (root/media/category CIDs) reject depth>1

files = pan115.list_files(cid="some-show-dir", depth=2)
# Explicit deeper traversal for non-protected directories only
# Output: 📁 FILES: X items found
# ⚠️ STOP - Must use .each() to iterate ALL
all_files = []
files.each(lambda i, f: all_files.append(f))

# List video files (returns FileCollection - must use .each())
videos = pan115.list_video_files(cid=folder_id, depth=3)
# Output: 📁 VIDEO_FILES: X items found
# ⚠️ STOP - Must use .each() to iterate ALL
all_videos = []
videos.each(lambda i, v: all_videos.append(v))

# Transfer resource
success, msg = pan115.transfer(url=url, save_dir_id=folder_id)
# ⚠️ STOP - Output `success=<bool>, msg=<text>` from transfer result

# Flatten directory
result = pan115.flatten_directory(dir_id=folder_id)
# ⚠️ STOP - Output `moved=<n>, removed=<n>` and require both numeric

# Snapshot-based dedup delete (SAFE)
snap = pan115.list_video_files_snapshot(cid=folder_id, depth=3)
all_videos = []
snap.each(lambda i, v: all_videos.append(v))

# Decide duplicate indices using intelligence (same episode, smaller file)
indices_to_delete = [0, 2, 5]

# Preview from the SAME snapshot
preview = pan115.preview_snapshot_deletions(indices=indices_to_delete, snapshot=snap)

# Apply delete from the SAME snapshot (executed by fid internally)
result = pan115.delete_snapshot_files(indices=indices_to_delete, snapshot=snap)
# Returns:
# {
#   "ok": bool,
#   "code": "OK" | "NOOP" | "SNAPSHOT_ALREADY_USED" | "DELETE_FAILED" | ...,
#   "deleted": [...],
#   "failed": [...],
#   "skipped": [...]
# }
# ⚠️ STOP - Output `ok=<bool>, code=<str>, deleted=<n>, failed=<n>`

### Return Code Contract (MANDATORY)

When handling `delete_snapshot_files(...)`, use `result["ok"] + result["code"]` as the source of truth:

| code | ok | Meaning | Required Action |
|------|----|---------|-----------------|
| `OK` | `true` | Delete applied successfully | Continue workflow |
| `NOOP` | `true` | Nothing to delete (invalid/empty indices after filtering) | Continue; do NOT retry blindly |
| `DRY_RUN` | `true` | Preview-only run, no deletion performed | If you intend to delete, run one real apply on same snapshot |
| `SNAPSHOT_ALREADY_USED` | `false` | Snapshot was already consumed by previous apply | Re-list with `list_video_files_snapshot` and re-decide indices |
| `DELETE_FAILED` | `false` | Batch delete failed | Enter Recovery: create NEW snapshot, re-evaluate once (RetryBudget=2); do NOT call apply again on same snapshot |
| `INVALID_INPUT` | `false` | Snapshot/indices input invalid | Enter Recovery: fix call arguments, re-run from last verified step; do NOT guess |

**Critical**:
- Do NOT interpret `ok=false` as "method missing" or "async not finished".
- Do NOT retry apply on the same snapshot after `SNAPSHOT_ALREADY_USED` / `DELETE_FAILED`.
- If you need another attempt, create a NEW snapshot first.

### Dedup Method Anti-Mix Rule (MANDATORY)

In **Step 9 dedup**, use snapshot APIs only.

- ✅ Allowed in Step 9: `list_video_files_snapshot` → `preview_snapshot_deletions` → `delete_snapshot_files`
- ❌ Forbidden in Step 9: `list_video_files` as the source list for delete decisions

Reason: mixing `list_video_files` with snapshot delete flow can cause evidence/delete source mismatch.

# Get file info
info = pan115.get_file_info(cid=folder_id)

# Get path
path = pan115.get_path(cid=folder_id)
```

`Pan115Client()` reads `PAN115_COOKIE` from environment by default.

**⚠️ CRITICAL: Snapshot-based Deletion Safety**

Dedup deletion now uses snapshot APIs. Agent still decides duplicate indices by intelligence,
but execution is bound to snapshot and performed by fid.

1. **No index drift in execution** - indices are converted to fid from the SAME snapshot
2. **Double apply protection** - second apply on same snapshot returns `ok=False`, `code="SNAPSHOT_ALREADY_USED"`
3. **No hard exception in workflow** - method returns structured result instead of throwing fatal errors

**Safe Usage Pattern:**
```python
# ✅ CORRECT: Get snapshot -> Determine indices -> Preview -> Apply (same snapshot)
snap = pan115.list_video_files_snapshot(cid=folder_id)
all_videos = []
snap.each(lambda i, v: all_videos.append(v))

# Determine which indices to delete (based on current all_videos)
indices_to_delete = [1, 3, 5]  # Example: identified duplicates

# Preview then apply
preview = pan115.preview_snapshot_deletions(indices=indices_to_delete, snapshot=snap)
result = pan115.delete_snapshot_files(indices=indices_to_delete, snapshot=snap)
print(result["ok"], result["code"], result["deleted"], result["failed"])
```

**❌ DANGEROUS Pattern (NEVER DO THIS):**
```python
# ❌ WRONG: Re-fetching and re-deciding inside same delete workflow
snap = pan115.list_video_files_snapshot(cid=folder_id)
all_videos = []
snap.each(lambda i, v: all_videos.append(v))
indices_to_delete = [1, 3, 5]

# First apply
r1 = pan115.delete_snapshot_files(indices=indices_to_delete, snapshot=snap)

# ❌ WRONG: Apply second time on same snapshot
r2 = pan115.delete_snapshot_files(indices=indices_to_delete, snapshot=snap)
# r2 -> {"ok": False, "code": "SNAPSHOT_ALREADY_USED", ...}
# This is a protected failure. Re-list and re-decide if needed.
```

### Using Preview for Safety

**Step 1: Preview before delete (MANDATORY)**
```python
# Get snapshot list (single source of truth for this dedup step)
snap = pan115.list_video_files_snapshot(cid=save_dir_id, min_size_gb=0.2)
all_videos = []
snap.each(lambda i, v: all_videos.append(v))

# Determine indices to delete
indices_to_delete = [3, 5, 7]  # Your logic here

# PREVIEW first - no actual deletion
preview = pan115.preview_snapshot_deletions(indices=indices_to_delete, snapshot=snap)

print("Files to DELETE:")
for f in preview["to_delete"]:
    print(f"  [{f['index']}] {f['name']} ({f['size_gb']}GB)")

print("\nFiles to KEEP:")
for f in preview["to_keep"]:
    print(f"  [{f['index']}] {f['name']} ({f['size_gb']}GB)")

# ⚠️ STOP - Output `planned_indices=[...]` and `preview.to_delete[].index=[...]`; require exact match
# If correct, proceed to actual deletion (same snapshot):
result = pan115.delete_snapshot_files(indices=indices_to_delete, snapshot=snap)
```

**Step 2: Delete with built-in preview**
```python
# delete_snapshot_files prints preview before deleting
result = pan115.delete_snapshot_files(indices=indices_to_delete, snapshot=snap)
# Output shows:
# ⚠️  SNAPSHOT DELETE PREVIEW - Please verify before proceeding
# 📁 Files to DELETE (14 files):
#    1. file1.mkv
#    2. file2.mkv
# ...
# ✅ Successfully deleted 14 files
```

---

### database.py

```python
from database import Database
db = Database()

# Add show for tracking
show_id = db.add_show(
    tmdb_id=279446,
    name="太平年",
    season=1,
    year=2026,
    category="tv",
    quality_pref="4K",
    total_episodes=48
)
# ⚠️ STOP - Output `show_id=<value>` (non-null integer)

# Update save directory
db.update_save_dir(show_id=show_id, save_dir_id="folder_cid")
# ⚠️ STOP - Output `updated=<count>` and require `updated >= 1`

# Sync with TMDB (get missing episodes)
# 内置进度条 [1/N] 和网络错误自动重试（3次/指数退避），无需手动处理超时
from tmdb_client import TMDBClient
tmdb = TMDBClient()
shows = db.sync_all(tmdb_client=tmdb)
# ⚠️ STOP - Output `shows_with_missing=[{show_id,missing[]}, ...]` from sync_all

# Mark episodes as obtained
db.mark_obtained(show_id=show_id, episode_codes=["S01E01", "S01E02"])
# ⚠️ STOP - Output `marked=<count>` and `episode_codes=[...]`

# Delete show tracking
db.delete_show(show_id=show_id)
# ⚠️ STOP - Output `deleted_show_id=<id>` and verify it is absent from `sync_all` result
```

---
