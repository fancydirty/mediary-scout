## Type 1 Execution Checklist

For movies or completed series with full collection available.

## Type 1 Hard Contract (Read Before Step 1)

- **MUST** output progress in `[Type 1 - Step N]` format.
- **MUST** wait for query completion before deciding that no resource exists.
- **MUST** show evidence before every critical decision.
- **MUST** bind `chosen_urls` before execution and use only bound URLs for transfer.
- **MUST** stop for explicit user confirmation before Step 5+ side effects (`create_folder`, `transfer`, `flatten`, `delete`, `mark`).
- **MUST** verify side effects with re-read checks.
- **DO NOT** skip `08-directory-and-mistakes.md` when directory placement matters.
- **DO NOT** improvise Type 2 logic inside a Type 1 task.

If any item above is violated, stop and report failure instead of continuing.

```
□ Step 1: TMDB Search
  └── tmdb.search("名称")
  └── ⚠️ STOP - Output `result_count=<n>` and require `result_count >= 1`

□ Step 2: Get Details (if TV)
  └── tmdb.get_tv_details(tmdb_id)
  └── ⚠️ STOP - Output `total_episodes=<n>` (from `number_of_episodes`)
  └── ⚠️ STOP - Confirm in_production=False, all episodes aired

□ Step 3: Pansou Search
  └── pansou.search("名称")
  └── ⚠️ STOP - Output `count_115=<n>, count_magnet=<n>` from search result

□ Step 4: Extract Links
  └── links = pansou.extract_all_links(result["115"], "115")
  └── all_links = []
  └── links.each(lambda i, link: all_links.append(link))
  └── snapshot = pansou.extract_link_snapshot(result["115"], "115")
  └── ⚠️ STOP - Output `covered_missing=[...]` and `uncovered_missing=[...]` using title-index evidence
  └── plan = snapshot.create_transfer_plan(chosen_indices, keyword="名称")
  └── ⚠️ STOP - Output `chosen_indices=[...]` and `plan.snapshot_id=<id>` (plan must come from SAME `snapshot`; no re-extract)
  └── **Type 1 vs Type 2 Selection Strategy**:
      └── **Type 1** (Movies/Completed): Compare ALL resources, select LARGEST
          └── Compare file sizes explicitly (evidence-first). Do NOT write sorting/parsing helpers.
          └── Select best quality (FGT > ALLiANCE > generic)
      └── **Type 2** (Ongoing): Get any resource that covers missing episodes
          └── Coverage > quality for missing episodes
          └── Can upgrade quality later

□ Step 5: Create Media Directory
  └── media_dir = pan115.create_folder(name="名称 (年份)", parent_id=parent_cid)
  └── ⚠️ STOP - Output `media_dir=<cid>` (non-null)

□ Step 6: Create Season Directory (if TV)
  └── season_dir = pan115.create_folder(name="Season 1", parent_id=media_dir)
  └── ⚠️ STOP - Output `season_dir=<cid>` (non-null)

□ Step 7: Batch Transfer
  └── Execute only the `TransferPlan` created in Step 4
  └── `pan115.execute_transfer_plan(plan=plan, save_dir_id=...)`
  └── Do NOT re-run extract/list before transfer
  └── Record success/msg for each
  └── ⚠️ STOP - Output `transfer_ok_count=<n>` and per-link `success/msg`

□ Step 8: Flatten Directory
  └── TV/Anime: `pan115.flatten_directory(dir_id=season_dir)`
  └── Movies: `pan115.flatten_directory(dir_id=media_dir)`
  └── ⚠️ STOP - Output `moved=<n>, removed=<n>` and require both fields present
  └── NOTE: `flatten_directory()` is synchronous and may take a long time on big folders.
      It prints `[FLATTEN] ...` output (with flush + heartbeat). Do NOT background-poll or kill it.

□ Step 9: List and Deduplicate
      └── snap = pan115.list_video_files_snapshot(cid=season_dir, min_size_gb=0.2)
      └── all_videos = []
      └── snap.each(lambda i, v: all_videos.append(v))
  └── ⚠️ STOP - Output `file_episode_map={index:episode_key}` (semantic mapping, not suffix pattern)
  └── ⚠️ STOP - Output `duplicate_groups={episode:[indices...]}` and `candidate_delete_indices=[...]`
  └── Identify duplicate indices (same episode, smaller file)
  └── If duplicates found:
      └── **PREVIEW first (MANDATORY)**:
          └── preview = pan115.preview_snapshot_deletions(indices=[...], snapshot=snap)
          └── Review preview["to_delete"] and preview["to_keep"]
          └── ⚠️ STOP - Output `planned_indices=[...]` and `preview.to_delete[].index=[...]`; require exact match
      └── result = pan115.delete_snapshot_files(indices=[...], snapshot=snap)
  └── ⚠️ STOP - Output `ok=<bool>, code=<str>, deleted=<n>, failed=<n>` (SNAPSHOT_ALREADY_USED means rerun with new snapshot)
  └── verify_snap = pan115.list_video_files_snapshot(cid=season_dir, min_size_gb=0.2)
  └── ⚠️ STOP - Output `duplicate_groups_after={episode:[indices...]}` and require all groups size == 1

□ Step 10: Final Verification
  └── videos = pan115.list_video_files(cid=season_dir)
  └── final_videos = []
  └── videos.each(lambda i, v: final_videos.append(v))
  └── ⚠️ STOP - Output `duplicate_groups_after={episode:[indices...]}` and require all groups size == 1
```

---
