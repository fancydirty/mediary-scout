# 115 API Safety Notes

Media Track should treat 115 as a stateful external system with anti-abuse controls, not as a cheap metadata API.
The product goal is unattended acquisition, so our code must avoid turning sync or verification into a request storm.

## Current Research Snapshot

115 has an official developer platform for personal cloud storage APIs, including upload, download, share, rename,
move, and delete operations: https://open.115.com/

OpenList documents that the 115 Open refresh-token mechanism has IP-based rate limiting:
https://doc.oplist.org/guide/drivers/115_open

AList/OpenList community reports suggest two practical risk categories:

- High-frequency API/listing calls can trigger temporary blocking or "request too frequent" style responses.
- Very large share/list responses can trigger "security threat / access blocked" responses, and the block may affect
  subsequent accesses from the same network for a while.

Useful prior reports:

- https://github.com/AlistGo/alist/issues/7034
- https://github.com/AlistGo/alist/issues/7475
- https://blog.gitcode.com/e2d6be073294a178bc2f93d232a8d8e1.html
- https://alistgo.com/zh/guide/drivers/115.html

These sources are community evidence, not a stable official SLA. The implementation should therefore prefer conservative
guardrails and runtime configurability over hard-coded optimism.

## Product Rules

- Do not scan 115 broadly to discover media. Metadata discovery belongs to TMDB/cache and resource providers.
- Only touch a known target directory for the current workflow run.
- Do not re-list the same directory repeatedly inside one run unless a side effect requires verification.
- Stop immediately on risk-control signals such as `请求过于频繁`, `访问被阻断`, `安全威胁`, `风控`, HTTP 429, or equivalent
  provider messages.
- Prefer small, bounded list responses. If a directory or share is too large, fail closed and ask the workflow to narrow
  scope rather than continuing to enumerate.
- In development, live side-effect tests must be restricted to a dedicated 115 test root directory. The live
  executor factory requires `MEDIA_TRACK_115_TEST_ROOT_CID` or an explicit production write-scope configuration before
  creating folders, transferring resources, moving files, or deleting files.

## Current Code Guard

`Storage115Executor` now accepts a `Pan115ApiGuard`.

The guard provides:

- minimum spacing between 115 API calls;
- per-operation call budget, tiered: transfer-class calls (`receiveShare` /
  `addOfflineTask`) are refused once the count reaches the hard limit minus a
  wrap-up reserve (`PAN115_TRANSFER_RESERVE_CALLS`, 40 → default 300 becomes 260
  for transfers), while listing / moving / deleting / renaming run to the hard
  limit so a run can always move landed files into place and discard staging;
  `transfer()` checks the transfer line first, so a refused transfer spends no
  preparatory calls;
- max list response size;
- risk-message detection;
- circuit breaker behavior after a risk signal.

Subtitle packages (assrt) land as ONE batch: `transferSubtitleUrls` refuses up
front (zero calls) when the package cannot fit before the transfer line, then does
one write-scope check, one depth-1 before-snapshot, N `addOfflineTask`
submissions (stopping after 3 consecutive rejections), polls the staging dir once
per round at depth 1 for every file (stop: all landed / `subtitleMaterializeAttempts`
(default 8) idle rounds / attempts + N rounds / the transfer line), and cancels
the unlanded tasks with a single `task_del`. Cost for N files: worst case = 2N + attempts + 4 (= 2N + 12 at the default
8 attempts: scope check + snapshot + N submissions + at most attempts + N poll
rounds + 2 cancel calls); typical ≈ N + 30 when the package lands within the
idle window. The per-file predecessor cost 20–31 per file (260 calls for a
22-file package on 2026-09-20).
Measured live 2026-09-21 on the real drive: a 168-file package cost 197 calls
(120 landed, 48 timed out and were cancelled), no guard events. Very large
packages are still bounded by the wrap-up reserve, not cheap: budget ≈ N + 30
calls per package when sizing `MEDIA_TRACK_115_MAX_API_CALLS` (do not set it
below ~150 — the fixed 60-call soft headroom and 40-call reserve are subtracted
from it).

`Storage115Executor` also accepts `writeScopeDirectoryIds`.

When configured, mutating operations must target a directory inside one of those
scope roots:

- `createDirectory()` checks the parent directory;
- `transfer()` checks the target directory before listing or receiving a share;
- `flattenDirectory()` still checks for a safe season/movie leaf, then checks
  that the leaf is inside the write scope;
- `deleteFiles()` checks the declared target directory, re-lists verified videos,
  and refuses to delete file ids that are not present in that target.

This is the product-side replacement for the old skill's prompt-level warning
that agents must not flatten or delete in the wrong directory.

`createProtectedStorage115Executor()` is now the required construction path for
live 115 execution. It fails closed unless either:

- `MEDIA_TRACK_115_TEST_ROOT_CID` is configured for development/smoke tests; or
- `MEDIA_TRACK_115_WRITE_SCOPE_CIDS` is configured with an explicit comma-separated
  production write scope.

The factory also marks `MEDIA_TRACK_115_TEST_ROOT_CID`, `CLAWD_MEDIA_ROOT_CID`,
`MOVIES_CID`, `TV_SHOWS_CID`, `ANIME_CID`, and any
`MEDIA_TRACK_115_PROTECTED_CIDS` values as protected flatten targets.

The Next.js worker can opt into this boundary with
`MEDIA_TRACK_STORAGE_ADAPTER=115`. That path now builds a cookie-backed
`Pan115CookieClient`, then wraps it with the protected executor factory. It
requires `PAN115_COOKIE` plus `MEDIA_TRACK_115_TEST_ROOT_CID` or explicit
`MEDIA_TRACK_115_WRITE_SCOPE_CIDS`.

The current guard is pure TypeScript and tested with fake APIs. The cookie HTTP
client is also tested with injected fake fetch functions before any live smoke
test.

One boundary remains explicit: magnet/offline-task execution is not live-ready
yet. The current cookie client returns `PAN115_OFFLINE_TASK_UNIMPLEMENTED`
because 115's modern offline-task endpoint uses an encrypted payload. Share-link
transfer, listing, directory creation, move, and delete are the first live-client
surface.

## Development Smoke Result

On 2026-06-12, the cookie client and protected executor completed a minimal live
smoke against the user's dedicated 115 `test` root:

- one read-only root listing found `test` at cid `3351918746607287913`;
- `Storage115Executor.createDirectory()` created
  `media-track-smoke-2026-06-12T06-19-30` under that test root;
- `Storage115Executor.listVideoFiles()` confirmed the new directory contained no
  video files;
- no share transfer, magnet/offline task, flatten, move, or delete operation was
  executed.

The smoke exercised the cookie HTTP client through the protected executor path,
including API guard spacing.

On 2026-06-12, a second live smoke exercised the full PanSou -> 115 share
receive -> verify-files chain inside the same 115 `test` root:

- keyword: `翘楚 4K`;
- PanSou returned 24 candidates;
- `Storage115Executor.createDirectory()` created
  `media-track-transfer-smoke-2026-06-12T06-29-02` at cid
  `3449645110499737015`;
- `runPan115ShareAdapterSmoke()` exercised the adapter-only harness against the
  first 115 share candidate and it succeeded;
- final verification found one materialized video:
  `翘楚.2026 - S01E15 - 第 15 集 - 2160p.WEB-DL.HDR10.HEVC.60fps.HQ.AAC 2.0.{tmdb-289271}.mkv`;
- no flatten, move, delete, or magnet/offline-task operation was executed.

This smoke also reproduced the provider-ahead edge case: the resource provider
already exposed `S01E15`, even though metadata may lag behind. The workflow must
continue to reconcile verified storage files against metadata instead of
assuming TMDB is always the newest source of truth.

This harness is intentionally not production fallback logic. Product transfers
must execute candidates selected by an agent decision node, then feed provider
errors and target-directory verification back into the workflow evidence. Raw
PanSou ordering is not allowed to decide which fallback resource gets side
effects.

## Live Adapter Direction

When the real 115 adapter is added, it should:

- keep passing a conservative `Pan115ApiGuard` configuration;
- expose guard events to workflow audit logs;
- set list page sizes below the configured max response budget;
- keep a short-lived per-run cache for directory listings;
- refuse live write operations unless the target path is inside the configured write scope;
- keep `MEDIA_TRACK_115_TEST_ROOT_CID` as the default development write scope;
- use the user's own 115 credentials, while product-level TMDB/resource-provider credentials remain server-side.
- add encrypted offline-task payload support before treating magnet resources as
  live-transfer ready.
