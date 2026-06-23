/**
 * The acquisition SKILL — the agent's on-demand manual.
 *
 * This is the original clawd-media-track skill (SKILL.md + references/) LOCALIZED
 * to the V2 sandbox: every mechanic is re-expressed in the sandbox tools
 * (searchResources / transferCandidate / inspectStaging / inspectTargetDir /
 * moveToSeason / deleteFiles / markObtained / flattenMovie / discardStaging /
 * finish / reportNoCoverage) and scoped handles — never raw pan115 calls, raw cids,
 * manual directory creation, or the original Mac/openclaw runtime. The depth and
 * the hard-won lessons are kept; the machinery is translated.
 *
 * It is read on demand (progressive disclosure, the way Vercel/Anthropic agent
 * skills work — name+section first, full body when the situation calls for it)
 * via the readSkill sandbox tool, so the agent has a HARD reference DURING its
 * loop, not just a static system prompt. Embedded as constants (not loose .md)
 * so it ships reliably in the compiled package.
 */

const PROTOCOL = `# Method protocol (read this before you act)

You drive your own observe → act → verify loop through the sandbox tools. "Intelligence" means: read the evidence the tools actually returned and decide in plain words — NOT acting on a hunch, and NOT firing many side effects before you have looked at what landed.

## Evidence → Facts → Decision (at EVERY decision point)
Before any transferCandidate / moveToSeason / deleteFiles / markObtained, lay out an auditable chain:
1. Evidence: the candidates or files the tools returned — ALL of them, with their id and title/name (and size when shown). Never a top-N sample; searchResources and inspectStaging return everything precisely so you judge from everything.
2. Facts (plain words): what each one actually is — which missing episodes a candidate's title covers; for a movie whether it IS this film and year; whether it is transparent (states size/resolution/episodes/group) or opaque.
3. Decision: from those facts, the SMALLEST set of candidates that covers the whole need.
If you cannot state (1) and (2), you may not proceed.

## Decide the covering set, THEN transfer it — do NOT grope one at a time
- searchResources is a DECISION point: search (re-keyword if the first was weak — add the year, the original title, "全集"/"complete") until your gathered candidates can cover the WHOLE need, then STOP searching. Once you can cover the need, more searching is pure waste. EVERY keyword MUST contain the title or an alias — never a bare genre/year fallback like "电影 2026" or "2026 电影": those name no title, only return noise, and the tool REJECTS them. If the title finds nothing after honest re-keywording, that is no-coverage — report it, do not flail at generic keywords.
- Choosing WHICH candidates to transfer is the DECISION; transferring them is EXECUTION. Once you have decided the covering set, transfer those candidates one after another (each is its own transferCandidate call — that is simply how the tool works) WITHOUT searching again in between. NEVER transfer-one → search-again → transfer-one: that is the over-search that hammers 115's call budget.
- After the transfers land, inspectStaging is a DECISION point again: read the TRUE files, then move / dedup / mark.

## No gambling, no "just in case"
- If a candidate's title does not clearly cover a missing episode (or clearly is not this film), treat it as NOT covering and skip it. Do not transfer "to see what is inside" / "先转再说，没有就删" / "万一有隐藏集".
- If a title explicitly limits its range ("更新至03集", "1-3集") and your missing episode is beyond it → skip immediately.
- If you ever transfer something that turns out not to cover, you OWN the cleanup: classify and remove the staging mess with deleteFiles; never leave staging polluted.

## Honesty
A truly-missing item with NO covering resource anywhere — after a real search — is an honest gap: leave it missing (finish / reportNoCoverage) for the next patrol. Never fabricate coverage; never mark something that is not present. The user values an honest failure over a fake success.`;

const DEAD_LINKS_BLACK_BOX = `# Dead links, magnets, and black-box resources

## What "landed" means
transferCandidate returns the TRUE materialized files (the system rereads for you). Trust THAT, not your prediction.
- A 115 share that transfers without error has landed.
- A 115 share fails LOUD with a clear reason — the real ones you will see: "链接已过期" (expired), "分享已取消" (cancelled), "访问码错误" (wrong access code), "错误的链接" (bad/malformed link). All = dead. Switch to another covering candidate — a dead link is the NORM, never a reason to give up; try the next resource that covers the need. (For a movie, transferUntilLanded over your ranked 115 shares burns through these dead ones automatically.)
- A magnet can SILENTLY fail: no error, yet nothing materializes. Trust the staging reread — if nothing landed, it is dead; move on to a 秒传-able candidate instead of waiting (the account's value is instant transfer, not a slow download).

## Black-box gate (this is exactly where the 奥本海默 run failed)
"Transparent" = the title states size / resolution / episodes / release group (e.g. "The.Dark.Knight.2008.2160p.BluRay.FGT 16.68GB"). "Black-box / opaque" = a bare name ("名称: 奥本海默") or a vague bundle ("【变形金刚系列】1~5部").
- If a TRANSPARENT candidate clearly covers the need, select ONLY it and STOP. Do NOT also transfer opaque ones "just in case".
- ONLY when ZERO transparent candidate covers the need may you fall back to a black-box one. When you do, your VERY NEXT step after it lands MUST be inspectStaging to VERIFY it actually holds the target (the right film / the missing episodes) — black-box coverage is UNPROVEN until you read the real files.
  - Verified to cover → process it (move / dedup / mark) and finish. Do NOT keep searching for a "better" one.
  - Does not cover → treat it as a dead candidate, clean its staging residue with deleteFiles, try the next.
- For an ongoing show's just-aired episode, a black-box resource whose publish time predates that episode's air time almost certainly does NOT contain it — do not bet on it.`;

const DEAD_LINKS_BLACK_BOX_QUARK = `# Dead links, 转存, and black-box resources (夸克网盘)

## How transfer works on THIS drive (夸克)
The drive is 夸克网盘. Every candidate is a 夸克分享链 (pan.quark.cn/s/<id>) — a 转存分享 (the 115-秒传 equivalent): the system exchanges the share token, lists the share, and saves its files into staging. transferCandidate returns the TRUE materialized files (the system rereads for you). Trust THAT, not your prediction.

## 无磁力 (this is the key difference from 115)
夸克 has NO magnet / offline-download web API. So there are NO magnet candidates here (the resource provider only surfaces 夸克分享链), and a magnet would fail LOUD ("QUARK_NO_MAGNET") if ever forced. There is therefore NO "magnet silently fails / wait for download" nuance at all — every candidate is an instant 转存分享 that either lands or fails loud.

## Fail-loud (a dead / expired / wrong share)
A 夸克分享 fails LOUD with a clear reason — switch to another covering candidate:
- "分享不存在" (code 41006), "分享已取消 / 已失效 / 已过期", "提取码错误 / 需要提取码". All = dead.
A dead link is the NORM, never a reason to give up — try the next 夸克分享 that covers the need. For a movie, transferUntilLanded over your ranked 夸克分享 burns through the dead ones automatically (it relies on this loud failure, exactly like the 115 path).

## Black-box gate (same discipline as 115)
"Transparent" = the title states size / resolution / episodes / release group. "Black-box / opaque" = a bare name or a vague bundle.
- If a TRANSPARENT 夸克分享 clearly covers the need, select ONLY it and STOP. Do NOT also transfer opaque ones "just in case".
- ONLY when ZERO transparent candidate covers may you fall back to a black-box one. When you do, your VERY NEXT step after it lands MUST be inspectStaging to VERIFY it actually holds the target — black-box coverage is UNPROVEN until you read the real files.
  - Verified to cover → process it (move / dedup / mark) and finish. Do NOT keep searching for a "better" one.
  - Does not cover → treat it as a dead candidate, clean its staging residue with deleteFiles, try the next.`;

const DEDUP = `# Deduplication (keep the larger, by real size)

Overlapping ranges (1-10, 8-13) or a fuller pack on top of what a season already has WILL create duplicate episodes once you extract. When the same episode has more than one file:
- Group the files by episode (read the real filenames — you understand "[Grp] Show - 04.mkv" is E04; no regex, no suffix tricks).
- Keep the LARGER file (higher bitrate = better quality), delete the smaller. deleteFiles executes your grouping; the system rereads to confirm.
- Size is the ONLY criterion. "Newer" is not better. "Collection pack" is not better. A "(1)" suffix decides nothing.

## Worked example — Life Tree (生命树)
The season dir already holds E01-E12 at ~1.2GB each (high quality). A new pack lands E01-E14 at ~800MB each. Missing was E13-E14.
- WRONG (the real bug): delete E01-E12, keep the new E01-E14 → you deleted the larger/better files.
- RIGHT: for E01-E12 keep the old 1.2GB and delete the new 800MB; for E13-E14 there is only one file each → keep. Final: E01-E12 (1.2GB) + E13-E14 (800MB) = 14 episodes, each the best available.`;

const MOVIE = `# Movie acquisition playbook

A movie is ONE video file. There are no seasons or episodes; its single coverage token is "MOVIE". The landing directory is just "Title (Year)/" and the file goes DIRECTLY in it — there is NO Season folder, NO season distribution, and NO separate staging to discard. You do NOT moveToSeason and you do NOT discardStaging for a movie: the film lands in the movie directory and flattenMovie cleans its wrapper IN PLACE. (Those are TV/anime tools.)

## Identity is the hard part (apply protocol's Evidence → Facts → Decision)
The candidate must be THIS film — not a remake, sequel, prequel, or same-IP different film. Cross-check BOTH title AND year.
- Reject "蝙蝠侠：黑暗骑士崛起" (2012) when the target is "蝙蝠侠：黑暗骑士" (2008).
- Reject a 1990 version when the target is a later remake.
- When identity is unclear, do NOT transfer speculatively.
Reject packs / collections / box sets / multi-part / anything structured like seasons — a movie is a single film. Reject disc images too: a 蓝光原盘 / ISO / BDMV full-disc dump (often 50–100GB+, isVideo=false) is NOT a usable film — you need ONE playable video file (mkv/mp4/ts). Among confirmed identity matches prefer the highest quality VIDEO stated transparently (4K REMUX/video > 1080p > 720p); prefer a 4K REMUX or even a lower-quality video over a 原盘/ISO even when the disc image is nominally higher quality. Magnets and 115 shares both transfer instantly — judge on identity/quality, never on link type.

## Two transfer tools — pick by the situation
- transferCandidate(snapshotId, candidateId): ONE candidate at a time. Use it for a single obvious share, or for a MAGNET (a magnet does NOT fail loud — only the landing point in inspectStaging tells you whether it 秒传'd; so transfer, then inspect).
- transferUntilLanded({candidateIds:[...]}): MOVIE-ONLY. You RANK several 115-share candidates that are all the SAME film (best resource first) and hand the ordered list over; the system tries them in your order and STOPS at the first that 秒传-lands, abandoning the rest. 115 SHARE LINKS ONLY (it relies on the share's loud failure). Why it exists: many 115 shares are dead (链接已过期 / 分享已取消 / 错误的链接 — you will see these constantly), so this burns through the dead ones for you without spending a turn per link.
  - The SET is YOUR semantic choice. A keyword search is a WILDCARD — it mixes in same-named DIFFERENT works (e.g. under "抓娃娃" the movie sits among a 综艺/variety show "姐姐妹妹抓娃娃" and even an unrelated cartoon). NEVER hand it the raw result list — first read every title and include ONLY the ones that are genuinely this film+year. Handing it everything = transferring a wrong work.

## The collapsed loop
search (re-keyword if weak) → decide the ONE correct film and RANK its candidate links (Evidence → Facts → Decision) → transfer it (transferUntilLanded over your ranked 115 shares, or transferCandidate for one share / a magnet) → inspectStaging to read the TRUE files → flattenMovie() AUTOMATICALLY pulls the film AND its subtitles up into the movie directory and removes the wrapper (one call, no per-file selection — a movie is one film, take it all; subtitles MUST land beside the video so the scraper finds them; the wrapper's covers/poster/nfo are discarded with it) → delete any extras (trailers / 花絮 / a bundled different work) with deleteFiles → markObtained(["MOVIE"]) as the LAST step, once the film is in place → finish().

## Worked example — 奥本海默 (the live failure to NOT repeat)
Searching "奥本海默" returns mixed links: a few 115 shares (some 链接已过期 / 分享已取消) and several magnets (some malformed → 错误的链接), most with OPAQUE black-box titles, ~4 dead and 1 good.
- RIGHT: read the titles, keep only the ones that are genuinely this film (drop unrelated same-keyword junk); rank the 115 shares best-first and transferUntilLanded over them — it skips the dead ones and lands the live one; THEN inspectStaging to verify it contains the film; it does → flattenMovie, markObtained MOVIE, finish. A couple of searches, one iterate-transfer, one inspect, done.
- WRONG (what actually happened): after the good resource ALREADY landed, kept searching "奥本海默 2023 mkv" / "Oppenheimer 2023 4K" and transferring more candidates WITHOUT inspecting — over-search, over-transfer, hammering 115. Once a transfer has landed, inspectStaging to verify BEFORE anything else; if it covers, finish.

## Keyword reality (lived)
The provider matches keywords loosely. Best practice: search the BARE title first; adding the year on the first pass is usually NOT best (it can over-narrow — "抓娃娃 2024" returned ZERO here while "抓娃娃" returned dozens, though the year does not always zero results). Add the year, the original/English name, or "全集" only if the first bare-title pass is weak.`;

const TV = `# TV / anime acquisition playbook

You own one OR MORE seasons in scope. The need is "应有 vs 实有 = which episodes are still missing", and it may span several seasons. It is ONE deliberation: keyword strategy, target & season matching, coverage, package normalization, extraction, dedup, marking.

## Season matching
- Season 1 (most Chinese dramas default here): a title without explicit season markers may match — focus on episode coverage ("庆余年 全集", "更新至46集").
- Season 2+ (US/Korean/Japanese dramas): the title MUST explicitly indicate the tracked season. "完结" / "更新至13集" with no season info is probably Season 1 → skip. Only "第二季 ...", "S02E...", "Season 2" count for season 2.
- Worked example — The Pitt (匹兹堡医护前线), tracking Season 2, missing S02E04: "匹兹堡医护前线 完结" (no season → likely S1 → skip); "更新至13集" (no season → skip); "第二季 更新至03集" (S2 but only E01-E03 → does not cover E04 → skip); "第二季 1-6集合集" (S2, covers E04 → TRANSFER).

## Coverage with the FEWEST reliable transfers (and BATCH the decided set)
- If ONE complete / full-season pack covers the whole need, transfer just it and stop searching.
- Otherwise compose the FEWEST non-redundant ranges that cover every missing episode, decide that whole set (Evidence → Facts → Decision), then transfer the set back-to-back (do NOT search again between transfers).
- Worked example — you need 50 episodes and every resource is a single-episode pack: do NOT transfer-one → re-check → transfer-one fifty times (that hammers 115). DECIDE the set of packs that together cover the 50, transfer that decided set in sequence, THEN inspect / dedup / mark once.
- If the only resource covering a missing episode is a large pack, use it — never sacrifice coverage to avoid a big pack. (In the daily patrol specifically, when a small exact-missing resource AND a huge full-season pack both cover, prefer the small exact one — less dedup risk; quality can be upgraded later.)

## Multi-season / complete-series packs
The need may span several seasons and a SINGLE pack ("Breaking Bad Complete Series" / "全五季") may cover them all. Transfer it ONCE, then submit ONE distribution plan that maps the files to EACH season at once: moveToSeason({moves:[{season:1,fileIds:[...]},{season:2,fileIds:[...]}]}) — each video's SUBTITLES ride in the same season's fileIds. Take ONLY still-missing episodes — a season the library already has is NOT recopied (inspectTargetDir(season) shows what each season already holds; recopying a present season is the 莉可丽丝 mistake across seasons). A pack covering seasons beyond the need is fine — take only what is missing, leave the rest in staging.

## Batch distribution (moveToSeason) — plan, ONE call, verify
The move tool is a BATCH plan, not a per-season call. Use it EXACTLY like this:
1. PLAN the whole distribution first (Evidence → Facts → Decision): for EACH still-missing episode write down which staging file id is its video, that video's SUBTITLE file id(s), and which season it belongs to. Confirm the plan covers EXACTLY the missing episodes — nothing already present, no extras.
2. Submit it in ONE call: moveToSeason({moves:[{season:1,fileIds:["videoId","subtitleId",...]},{season:2,fileIds:[...]}]}). Every video's subtitle id sits in the SAME season's fileIds as its video. (A movie omits season entirely.)
3. VERIFY the returned {seasons, staging}: each returned season must hold exactly its missing episodes (+ their subtitles), flat. If a file is misplaced or missing, call moveToSeason again to fix it — moves are cheap (NOT transfer-budget), so distribute-then-verify; do not agonize over a perfect first call.
4. Only once the seasons verify correct: dedup (keep-larger) → markObtained(codes) → discardStaging.

## Messy real packs (lived)
A single "全X集" pack often has INCONSISTENT, watermarked filenames and MIXED quality — e.g. a real 隐秘的角落 全12集 pack held 第1集–第6集 in proper 蓝光1080P (400MB–1GB) but 尝鲜版07–尝鲜版12End in low-quality preview (~150MB), all sprinkled with a 【site.com】 watermark. You map each to its episode by READING the name ("第3集"=E03, "尝鲜版09"=E09, an "End"/"完" marker = the finale) — no regex, no parser. Keep the ORIGINAL names (never rename). If covering the missing episodes only takes proper-quality files, take those; if the only file for a missing episode is a preview/尝鲜版, take it (coverage now, quality upgrades on a later patrol). When two files cover the same episode, dedup keep-larger.

## On patrol / 补缺 — INSPECT THE LANDING POINT FIRST (§6b#8)
The missing-episode list is computed from the DB, and the DB can LAG the disk: a prior run may have already placed an episode on 115, or a crash left files mid-flight, yet the DB still says "missing". So whenever you are补缺 (a daily-patrol / type3 run, or any task that hands you "missing" episodes), your FIRST action — BEFORE any searchResources — is inspectTargetDir for each needed season. Any "missing" episode whose video is ALREADY in its season directory: markObtained it straight from that evidence and remove it from your need; do NOT search or transfer for it. Only the episodes genuinely absent from the landing point go on to search/transfer. (Searching PanSou for files you already have on 115 is wasted budget — exactly the over-search to avoid.)

## Coverage honesty
Only currently-aired, genuinely-missing episodes are obtainable. Unaired future episodes of the latest ongoing season are NOT missing — leave them; the daily patrol gets them when they air. EXCEPTION — provider-ahead (trust a coherent full pack): a real release is often ahead of TMDB, so a coherent full-season pack you transferred can actually deliver episodes BEYOND the aired cursor in your need. Those extra episodes are NOT "unaired with no resource" — THIS pack delivered them, so treat them as ALSO wanted: include them in your moveToSeason plan (with their subtitles) so they land in the season dir and are NOT wiped by discardStaging; then, after inspectTargetDir confirms the real video files landed, markObtained them too. The system records them as provider-ahead (你比 TMDB 抢先拿到) and the frontend shows 超前 — do NOT leave a verified full season half-done at the aired cursor. Hard safety: move+mark ONLY episodes whose files you actually verified landed — NEVER ones a pack merely claims in its title (a "1-24" label is not proof). A truly-missing episode with no covering resource is an honest gap — leave it for the next patrol; never fabricate coverage.

## Clean up & subtitles
Each video's SUBTITLES (.srt / .ass / .ssa / .sub / .idx / .vtt / .sup / .smi; .sub + .idx are a VobSub pair) ride WITH their video in the SAME season's moveToSeason fileIds — they must land beside the video so the scraper finds them; NEVER leave a pack's subtitles behind. After every needed episode (and its subtitles) is moved into its season directory and marked, call discardStaging to wipe the WHOLE staging directory in one shot: leftovers you didn't need — extra episodes, duplicate packs, a bundled different work (e.g. El Camino inside a Breaking Bad pack), covers/nfo — are all discarded wholesale. Keep ONLY what you moved into the seasons; do not isolate or hand-classify residue.`;

const MISTAKES = `# Worked right/wrong examples (the hard-won lessons)

- 莉可丽丝 over-transfer: a show that HAD one full-season pack, yet the agent searched 16 times and transferred 6 overlapping full-season packs. WRONG. Right: recognize the one full pack covers the need, transfer just it, stop.
- 奥本海默 over-search after success: after the one good (black-box) resource already landed, kept searching + transferring more. WRONG. Right: once a transfer lands, inspectStaging to verify; if it covers, finish.
- Life Tree dedup: deleted the larger/better files because they were "old". WRONG. Right: keep the larger by real size, regardless of new/old.
- El Camino: a different film bundled inside a Breaking Bad pack, auto-mapped to an episode. WRONG. Right: isolate it, never auto-map.
- "Just in case" transfer: transferring a non-covering resource hoping it secretly has the episode. WRONG. Right: skip non-covering titles; if a title says "更新至03集" and you need E04, skip.
- Acting on a hunch: transferring / deleting / marking without first stating Evidence → Facts → Decision. WRONG. Right: state the evidence and the facts, then act.
- Serial single transfers: transfer-one → re-search → transfer-one, repeated, hammering 115. WRONG. Right: decide the covering set, then transfer it back-to-back without re-searching.`;

const SEARCH = `# Keyword strategy by media type (lived PanSou research)

Your per-run input already gives you THIS title's recipe (searchHints). This section is the full map — read it when the injected hint isn't enough or you're unsure.

## Universal laws (every type)
- A single 0 almost NEVER means "no resource": PanSou's API jitters violently — the SAME keyword can swing 0↔900 between consecutive calls (measured: Breaking Bad 0→903; 斗破苍穹/遮天 once reported 0 are really 140-196). On a 0, re-run the SAME keyword 2-3 times before ever concluding empty. Most "0"s are lies.
- Quality is NOT a search word. Putting 4K/1080P/蓝光 into the keyword filters the title match AND skews to same-quality WRONG works. Read quality off the returned titles instead.
- count ≠ relevance: read the top titles to confirm the work itself + full coverage. +year is the safe de-noiser for LIVE-ACTION movies/tv; but anime (日漫/国漫) must NOT use +year (it zeroes, or pulls the same-name live-action).
- Sub-type tokens NEVER go in the query: +美剧/+韩剧/+日剧/+国产剧/+番剧/+动画 almost never help — they zero the pool or top it with noise. The ONLY exceptions: 国漫's +国漫 (a real release tag, for disambiguating same-name live-action) and Chernobyl's +美剧 (the one show whose bare name is always 0).
- The search keyword's LANGUAGE follows the user's subtitle preference. Prefer 中文 subs (the default) → search foreign shows (US/JP/KR drama, anime) by the 中文译名 (Chinese-named resources carry 中字 AND recall better here). Prefer the original language → only then search by the original/English name (huge recall but mostly NO Chinese subs). The English/original name is a fallback for "中文名 still 0 after re-search", and you must then pick the results that carry 中字; if none do, that's weak coverage for a 中文 user.

## Per type (all lead with the BARE 中文 name + hard re-search; tokens are escalation)
- 电影 (movie): first = bare 中文名 (imported films use the common 网盘 译名; sequels keep the Chinese number: 沙丘2/银河护卫队3). On 0, re-search. Same-name trap → +year slice: CN common-char/standing-phrase/TV-substring (默杀→默杀 2024, 抓娃娃→抓娃娃 2024, 孤注一掷→collides w/ a 1969 film); imported generic-series word (蝙蝠侠→蝙蝠侠 2022) and bare-number sequels drifting to a wrong newer same-name (阿凡达2→2025 火与烬, use the subtitled full name 阿凡达水之道). English name ONLY if itself distinctive (Killers of the Flower Moon); common-word English is a disaster (YOLO/Napoleon/Inception/Barbie). AVOID 中文名+画质, +电影.
- 国产剧 (CN tv): first = bare 中文名 (8/10 puts the 全N集/COMPLETE pack on top). On 0, re-search. Common-char name (三体/狂飙/山海情) → +year. Multi-season: the bare name recalls ALL seasons' packs at once — NEVER search season-by-season (庆余年 第二季 collapses to 1). AVOID +国产剧/电视剧 (never helped, only noise), bare English (drowns in US/UK shows), quality words.
- 美剧 (US tv): first = bare 中文译名 (measured: 权力的游戏83/绝命毒师83/怪奇物语129, all on-target WITH 中字; the English name surfaces mostly no-中字 scene packs useless to a 中文 viewer). On 0, re-search (Breaking Bad measured 0↔903). Missing season → 中文名+第N季 (权力的游戏 第八季). English name only as the "中文名 still 0" fallback, then pick the 内封/外挂简繁中字 results. AVOID 中文名+美剧 (measured 0-for-7, pure harm), bare English as the opener (no 中字 + 0↔900 jitter). Chernobyl is the lone exception: bare 中/英 both 0 → 切尔诺贝利 美剧 / 切尔诺贝利 1080P.
- 韩剧 (KR tv): first = bare 中文译名 (stable). On 0, re-search. Common-char (王国/信号) → +year (信号 2016→#1); multi-season → +中文季号 (顶楼 第三季); too-niche translation that won't recall (衣袖红镶边) → English original (The Red Sleeve). AVOID +韩剧 (zeroes 5+/10), common-word English as opener (Kingdom/Penthouse/Signal drown in same-name noise), quality words as opener.
- 日剧 (JP tv): first = bare 中文 COMMON translation — multiple unstable translations is the #1 trap (Silent=静雪, Legal High=胜者即是正义). On 0, re-search. Buried under same-name → English/romaji (静雪→Silent, 非自然死亡→Unnatural); bare name mixing anime → +year (重启人生→重启人生 2023). AVOID +日剧 (zeroes/noise), single-word English (Silent drowned), katakana (AV). Stock blind-spots are real — be willing to declare 无货 (大豆田永久子; 宽松世代 has only the movie) rather than keyword-thrash.
- 日漫 (JP anime): first = bare 中文译名 (9/10 puts a 字幕组 pack on top: LoliHouse/DBD-Raws/喵萌). On 0, re-search 1-2 times (index is flaky: 葬送的芙莉莲 0→117, 莉可丽丝 0→102). Buried by same-name (莉可丽丝 vs an unrelated US show) → standard-spelling romaji (Lycoris Recoil/Jujutsu Kaisen/Frieren; Kimetsu no Yaiba & Bocchi the Rock = 0, spacing is fragile, use only if it hits); pick a season/篇 by READING the already-recalled titles, don't append it to the query (AND-match collapses). AVOID +番剧/+动画 (drops 100+ candidates to 0: 咒术回战 番剧→0), +year (fragile/skewed: 鬼灭2019→19, 间谍2022→0), +4K (→0; for quality read titles or +1080P).
- 国漫 (CN anime): first = bare 中文名 (measured 斗破苍穹140/遮天196 — the research's bare=0 was API jitter, don't trust it). On 0, re-search. 国漫 often shares its name with a live-action/网文: if the bare name is taken over by the live-action/same-name (完美世界→突袭, 凡人修仙传→真人版 on top, 一人之下→异人之下) → add +国漫 to narrow to clean GM-Team season packs (the donghua-only real tag); 一人之下's Chinese name is fully dead (even +国漫=0) → romaji Hitori no Shita; the official English in GM-Team tags (Battle Through the Heavens/Renegade Immortal) is a fallback. AVOID +动画 (mixes JP anime/tv), +番剧/年番/第N季, +year (DANGEROUS: pulls the same-name live-action, e.g. 异人之下).
- 美漫 (US anime): first = bare 中文译名 — the interpunct · matters (哈莉·奎茵→348 clean vs 哈莉奎茵→4 noise); do NOT add spaces inside a tight compound name (变形金刚领袖之证 works, spaced→0). On 0, re-search. <5 hits or all noise → bare English name + Complete/Season (BoJack Horseman/The Simpsons/Futurama/Adventure Time — big recall but mostly no 中字, weak coverage for a 中文 user); fan-slang → full name (爱死机→爱死亡和机器人); want 中字 → Chinese+English probe (探险活宝 Adventure→外挂简繁中英). AVOID +美剧/+动画 (瑞克和莫蒂 50→7, 无敌少侠 127→0), quality words to rescue a 0, romaji/pinyin/invented translations.`;

const SECTIONS = {
  protocol: PROTOCOL,
  search: SEARCH,
  "dead-links-black-box": DEAD_LINKS_BLACK_BOX,
  dedup: DEDUP,
  movie: MOVIE,
  tv: TV,
  mistakes: MISTAKES,
} as const;

export type SkillSectionName = keyof typeof SECTIONS;

export const SKILL_SECTION_NAMES = Object.keys(SECTIONS) as SkillSectionName[];

/**
 * The brand-specific transfer / dead-links / black-box manual. The transfer model
 * differs by drive brand (115 秒传/magnet vs 夸克 转存分享链/无磁力), so the
 * "dead-links-black-box" section the agent reads is selected by the run's drive
 * provider. Used both as that on-demand section and as a standalone export.
 */
export function getStorageSkill(provider: string): string {
  if (provider === "quark") {
    return DEAD_LINKS_BLACK_BOX_QUARK;
  }
  if (provider === "pan115") {
    return DEAD_LINKS_BLACK_BOX;
  }
  throw new Error(`unknown storage brand: ${provider}`);
}

/** Read one section of the skill manual on demand, for the run's drive brand
 *  (defaults to 115). The "dead-links-black-box" section is brand-specific; the
 *  rest are shared. Unknown name → a clear error string the agent can recover from. */
export function readSkillSection(section: string, provider: string = "pan115"): string {
  if (section === "dead-links-black-box") {
    return getStorageSkill(provider);
  }
  const body = (SECTIONS as Record<string, string>)[section];
  if (body === undefined) {
    return `Unknown skill section "${section}". Available sections: ${SKILL_SECTION_NAMES.join(", ")}.`;
  }
  return body;
}

/**
 * The index a given agent embeds in its system prompt: which sections to read
 * up front and which to re-read when a situation arises. Each agent is pointed
 * ONLY at the sections in its responsibility — the movie agent is not handed the
 * tv playbook and vice versa — plus the shared protocol/dead-links/dedup/mistakes.
 */
export function skillIndexForAgent(agent: "movie" | "tv"): string {
  const own = agent; // "movie" or "tv"
  return `You have a domain skill manual. Read a section on demand with readSkill({ section: "<name>" }) — do not act from memory when a section covers your situation.
Read NOW, before you start: "protocol" (the Evidence→Facts→Decision + decide-the-covering-set-then-batch method) and "${own}" (your acquisition playbook).
Re-read the moment you hit it: "search" (your first searches return junk / 0 / wrong works — the per-media-type keyword recipes), "dead-links-black-box" (a transfer fails, or every candidate title is opaque), "dedup" (the same episode lands more than once), "mistakes" (worked right/wrong examples).
Available sections: protocol, ${own}, search, dead-links-black-box, dedup, mistakes.`;
}
