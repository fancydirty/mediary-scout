# Cross-Brand Subtitle Link Renewal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Renew short-lived assrt subtitle URLs per bounded chunk so 115, 123, and Guangya subtitle landing does not process a large package with stale links.

**Architecture:** Keep brand-specific landing behavior in the existing `StorageV2.transferSubtitleUrls` adapters. Add a small pure renewal module that assigns stable occurrence keys to subtitle filenames and reconciles each refreshed `detail()` response with the pending package. Make `TaskSandbox.transferSubtitle` sequentially refresh detail and submit one chunk at a time; preserve soft subtitle failures, provider auth errors, and the existing 115 budget guard.

**Tech Stack:** TypeScript, Vitest, `TaskSandbox`, `AssrtProviderPort`, `StorageV2.transferSubtitleUrls`, existing 115/123/Guangya executors.

---

### Task 1: Add pure subtitle chunk identity and reconciliation helpers

**Files:**
- Create: `packages/workflow/src/acquisition-v2/subtitle-renewal.ts`
- Create: `packages/workflow/tests/subtitle-renewal.test.ts`
- Modify: `packages/workflow/src/index.ts` only if the sandbox import boundary requires a public export; otherwise keep the helper internal to the acquisition package.

- [ ] **Step 1: Write failing tests**

Add tests for these exact behaviors:

```ts
import { describe, expect, it } from "vitest";
import {
  indexSubtitleFiles,
  selectSubtitleChunk,
  type IndexedSubtitleFile,
} from "../src/acquisition-v2/subtitle-renewal.js";

const files = (suffix: string) => [
  { filename: "Show.S01E01.ass", url: `https://assrt.test/${suffix}/1` },
  { filename: "Show.S01E01.ass", url: `https://assrt.test/${suffix}/1b` },
  { filename: "Show.S01E02.ass", url: `https://assrt.test/${suffix}/2` },
];

it("gives duplicate filenames stable occurrence keys", () => {
  expect(indexSubtitleFiles(files("old")).map((file) => file.key)).toEqual([
    "Show.S01E01.ass#0",
    "Show.S01E01.ass#1",
    "Show.S01E02.ass#0",
  ]);
});

it("selects the next pending chunk from a refreshed detail response", () => {
  const initial = indexSubtitleFiles(files("old"));
  const refreshed = indexSubtitleFiles(files("fresh"));
  const result = selectSubtitleChunk(initial, refreshed, new Set(initial.map((f) => f.key)), 2);
  expect(result.selected.map((file) => file.url)).toEqual([
    "https://assrt.test/fresh/1",
    "https://assrt.test/fresh/2",
  ]);
  expect(result.missing).toEqual([]);
});

it("reports a pending file missing from a refreshed detail response", () => {
  const initial = indexSubtitleFiles(files("old"));
  const refreshed = indexSubtitleFiles([files("fresh")[0]!, files("fresh")[2]!]);
  const result = selectSubtitleChunk(initial, refreshed, new Set(["Show.S01E01.ass#1"]), 1);
  expect(result.selected).toHaveLength(0);
  expect(result.missing).toEqual(["Show.S01E01.ass#1"]);
});
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
npx vitest run packages/workflow/tests/subtitle-renewal.test.ts
```

Expected: FAIL because `subtitle-renewal.ts` and its exports do not exist.

- [ ] **Step 3: Implement the minimal helper**

Define:

```ts
export interface IndexedSubtitleFile {
  key: string;
  filename: string;
  url: string;
}

export function indexSubtitleFiles(files: Array<{ filename: string; url: string }>): IndexedSubtitleFile[];
export function selectSubtitleChunk(
  initial: IndexedSubtitleFile[],
  refreshed: IndexedSubtitleFile[],
  pending: ReadonlySet<string>,
  chunkSize: number,
): { selected: IndexedSubtitleFile[]; missing: string[] };
```

Use `filename#occurrence` as the key. Preserve initial package order. A refreshed file is usable only when its key is still pending; select at most `chunkSize`. Do not fall back to an old URL when a key is absent from the refreshed response.

- [ ] **Step 4: Run the focused tests and confirm GREEN**

Run the same Vitest command. Expected: all helper tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/workflow/src/acquisition-v2/subtitle-renewal.ts packages/workflow/tests/subtitle-renewal.test.ts
git commit -m "feat(subtitle): add stable chunk renewal helpers"
```

### Task 2: Make TaskSandbox renew detail per chunk

**Files:**
- Modify: `packages/workflow/src/acquisition-v2/sandbox.ts:954-1030`
- Modify: `packages/workflow/tests/v2-sandbox-subtitle.test.ts`

- [ ] **Step 1: Add failing sandbox tests**

Add a provider whose `detail(candidateId)` returns a full package on the first call and a fresh URL set on the second call. Add a storage fake that records every `transferSubtitleUrls` input. Assert:

1. a package of `SUBTITLE_RENEWAL_CHUNK_SIZE + 1` files calls `detail()` twice;
2. the second storage call receives only fresh URLs;
3. each storage call receives no more than the chunk size;
4. a detail refresh returning no matching file stops later submissions and preserves earlier landed filenames;
5. the result includes chunk diagnostics without exposing URL values.

The first test must fail on the current one-detail implementation because it makes one detail call and sends every file at once.

- [ ] **Step 2: Run the focused test and confirm RED**

```bash
npx vitest run packages/workflow/tests/v2-sandbox-subtitle.test.ts -t "renew|chunk|refresh"
```

Expected: the new multi-chunk assertions fail against the one-shot implementation.

- [ ] **Step 3: Implement the sequential renewal loop**

Import the pure helpers and define:

```ts
export const SUBTITLE_RENEWAL_CHUNK_SIZE = 24;
```

Inside `transferSubtitle`:

1. call `detail()` once and filter the package exactly as today;
2. index the initial list and create a pending key set;
3. use the initial response for the first chunk; while pending keys remain after that first chunk, call `detail(candidateId)` again before each subsequent chunk:
   - reconcile refreshed files against pending keys;
   - if no selected file exists, append a soft error and stop;
   - call the unchanged `storage.transferSubtitleUrls` with selected `url/filename` pairs;
   - associate each returned result with the selected key by array order;
   - remove selected keys from pending regardless of success, so the same stale/failed file is never blindly retried;
   - accumulate `landedFilename` values and the last provider error;
4. return the existing `status/landedFilenames/error` plus non-sensitive diagnostics: `chunksProcessed`, `chunksTotal`, `unattemptedCount`.

For a package at or below the chunk size with unique basenames, the initial detail response is also the first chunk response; do not make a redundant second detail call. Duplicate basenames stay in separate adapter calls to honor each brand's filename contract. Preserve all existing soft-failure and auth-error behavior.

- [ ] **Step 4: Run focused tests and mutate the renewal**

Run:

```bash
npx vitest run packages/workflow/tests/subtitle-renewal.test.ts packages/workflow/tests/v2-sandbox-subtitle.test.ts
```

Then temporarily remove the per-chunk `detail()` call and rerun the focused suite; the fresh-URL assertion must fail. Restore the implementation before proceeding.

- [ ] **Step 5: Commit**

```bash
git add packages/workflow/src/acquisition-v2/sandbox.ts packages/workflow/tests/v2-sandbox-subtitle.test.ts
git commit -m "feat(subtitle): renew assrt links per landing chunk"
```

### Task 3: Verify adapter contracts and budget behavior

**Files:**
- Modify only tests if a regression is found:
  - `packages/workflow/tests/storage-115-executor.test.ts`
  - `packages/workflow/tests/guangya-storage-executor.test.ts`
  - `packages/workflow/src/pan123-storage-executor.test.ts`

- [ ] **Step 1: Run existing brand suites**

```bash
npx vitest run   packages/workflow/tests/storage-115-executor.test.ts   packages/workflow/tests/guangya-storage-executor.test.ts   packages/workflow/src/pan123-storage-executor.test.ts
```

Expected: existing 115 budget reserve, Guangya per-file failure/auth, and 123 immediate-submit tests stay green.

- [ ] **Step 2: Add only necessary contract regressions**

If the renewal integration exposes a mismatch, add a failing test before changing code:

- 115: a chunk still invokes `transferSubtitleUrls` and its budget preflight can refuse the chunk without bypass.
- 123: every selected file is still resolved/submitted immediately and a fresh chunk URL is used.
- Guangya: consecutive failures still abort within the existing cap; a quota error remains a provider message and is not converted into no-resource.

Do not add a brand-specific daily quota counter.

- [ ] **Step 3: Run the brand suites again and commit any required test-only adjustments**

```bash
git add packages/workflow/tests
git commit -m "test(subtitle): preserve brand adapter and budget contracts"
```

### Task 4: Full verification and isolated smoke preparation

**Files:**
- Modify: `docs/PROJECT-STATUS.md` (local ignored ledger only, after verification)
- Create temporary smoke scripts only under `scratchpad/`; do not commit credentials or URLs.

- [ ] **Step 1: Run repository gates**

```bash
npm run build:workflow
npm run typecheck
npx tsc -p apps/web/tsconfig.json --noEmit
npm run lint
npx vitest run
npm run build:web
```

Expected: zero failures; record the test count.

- [ ] **Step 2: Run isolated provider-level smoke**

Use one fresh detail response per chunk and a non-production isolated directory:

- 123: at least 40 subtitle files, verify chunk 2 receives URLs from its later detail response and all landed files are claimed, including duplicate names.
- 115: a large package or a deterministic executor harness, verify each chunk performs a fresh detail and the budget reserve remains available for move/cleanup.
- Guangya: a package large enough to cross a chunk boundary, verify no chunk reuses a stale URL; record quota errors separately if the test account returns one.

Do not run against the production library or modify user-owned staging.

- [ ] **Step 3: Update the local status ledger**

Append the spec, PR/branch, focused evidence, full gates, and smoke result to `docs/PROJECT-STATUS.md`. Keep the release note that merged code is not deployed until the user’s next release window.

- [ ] **Step 4: Commit implementation state and open PR**

```bash
git status --short
git push -u origin feat/cross-brand-subtitle-renewal
gh pr create --base main --head feat/cross-brand-subtitle-renewal   --title "feat(subtitle): renew assrt links per landing chunk"   --body-file /tmp/cross-brand-subtitle-pr-body.md
```

Then attach the PR artifact, trigger the Copilot review loop, resolve every materialized thread, and squash-merge only when the current HEAD review and CI are clean.
