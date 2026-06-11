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
- In development, live side-effect tests must be restricted to a dedicated 115 test root directory. The future live
  adapter should require `MEDIA_TRACK_115_TEST_ROOT_CID` or an explicit production write-scope configuration before
  creating folders, transferring resources, moving files, or deleting files.

## Current Code Guard

`Storage115Executor` now accepts a `Pan115ApiGuard`.

The guard provides:

- minimum spacing between 115 API calls;
- per-operation call budget;
- max list response size;
- risk-message detection;
- circuit breaker behavior after a risk signal.

The current guard is pure TypeScript and tested with fake APIs. It does not call the real 115 API.

## Live Adapter Direction

When the real 115 adapter is added, it should:

- pass a conservative `Pan115ApiGuard` configuration;
- expose guard events to workflow audit logs;
- set list page sizes below the configured max response budget;
- keep a short-lived per-run cache for directory listings;
- refuse live write operations unless the target path is inside the configured write scope;
- use the user's own 115 credentials, while product-level TMDB/resource-provider credentials remain server-side.
