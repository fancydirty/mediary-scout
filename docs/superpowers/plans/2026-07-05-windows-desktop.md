# Windows Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Windows NSIS installer build to the release pipeline, sharing the same Electron + SQLite + Next standalone architecture as macOS.

**Architecture:** Same codebase — add `win` target to electron-builder.yml, add `build-windows` job to the release workflow on a `windows-latest` runner. No code changes needed (Node handles `/` on Windows; prebuild-install auto-detects platform).

**Tech Stack:** electron-builder v25 (NSIS target), GitHub Actions windows-latest runner, prebuild-install (win32-x64 Electron ABI), @electron/fuses (RunAsNode)

---

### Task 1: Add Windows icon

**Files:**
- Create: `apps/desktop/build/icon.png` (already exists from macOS work)

- [ ] **Step 1: Verify icon.png exists**

Run: `ls -lh apps/desktop/build/icon.png`
Expected: file exists, ~236K

- [ ] **Step 2: Commit if not already tracked**

```bash
git add apps/desktop/build/icon.png
git commit -m "build(desktop): add PNG icon for Windows target"
```

### Task 2: Configure electron-builder win target

**Files:**
- Modify: `apps/desktop/electron-builder.yml`

- [ ] **Step 1: Add win section**

Append to electron-builder.yml after the `mac:` section:

```yaml
win:
  target:
    - nsis
  icon: build/icon.png
```

- [ ] **Step 2: Verify yml syntax**

Run: `npx electron-builder --config apps/desktop/electron-builder.yml --help`
Expected: no config parse error

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/electron-builder.yml
git commit -m "build(desktop): add Windows NSIS target"
```

### Task 3: Add Windows job to release workflow

**Files:**
- Modify: `.github/workflows/release-macos.yml` (rename conceptually but keep filename for git history)

- [ ] **Step 1: Add build-windows job**

Add after the `build-macos` job in the same workflow file:

```yaml
  build-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      - name: Checkout tag commit (workflow_dispatch)
        if: github.event_name == 'workflow_dispatch'
        run: |
          git fetch --tags
          if (git rev-parse "refs/tags/${{ inputs.tag }}" 2>$null) {
            git checkout "${{ inputs.tag }}"
          } else {
            Write-Error "Tag ${{ inputs.tag }} does not exist"
            exit 1
          }
        shell: pwsh

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - run: npm ci

      - name: Build Next standalone server
        run: npm run build:web

      - name: Build desktop TypeScript
        run: npm run build --workspace @media-track/desktop

      - name: Swap better-sqlite3 to Electron ABI
        working-directory: apps/web/.next/standalone/node_modules/better-sqlite3
        run: npx prebuild-install -r electron -t ${{ env.ELECTRON_VERSION }}

      - name: Verify ABI swap actually happened
        run: |
          "const Database = require(process.env.GITHUB_WORKSPACE + '/apps/web/.next/standalone/node_modules/better-sqlite3'); new Database(':memory:').exec('CREATE TABLE t(x)'); console.log('ABI_OK modules=' + process.versions.modules);" | Out-File -Encoding utf8 /tmp/abi-check.js
          $env:ELECTRON_RUN_AS_NODE = "1"
          & "$(npm root)/electron/dist/electron.exe" /tmp/abi-check.js
        shell: pwsh

      - name: Package Windows installer
        run: npm run dist --workspace @media-track/desktop
        env:
          CSC_LINK: ""
          CSC_KEY_PASSWORD: ""

      - name: Determine release tag
        id: tag
        shell: bash
        run: |
          if [ "${{ github.event_name }}" = "workflow_dispatch" ]; then
            echo "tag=${{ inputs.tag }}" >> "$GITHUB_OUTPUT"
          else
            echo "tag=${GITHUB_REF#refs/tags/}" >> "$GITHUB_OUTPUT"
          fi

      - name: Upload installer to GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ steps.tag.outputs.tag }}
          target_commitish: ${{ github.sha }}
          files: apps/desktop/dist-app/*.exe
          generate_release_notes: true
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/release-macos.yml
git commit -m "ci: add Windows build job to release workflow"
```

### Task 4: Verify build locally (if possible)

- [ ] **Step 1: Run tsc to verify no type errors**

Run: `npx tsc --noEmit -p apps/desktop/tsconfig.json`
Expected: exit 0

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: all pass (no Windows-specific code changed)

- [ ] **Step 3: Commit any fixes if needed**

### Task 5: PR + Copilot review + merge

- [ ] **Step 1: Push branch + create PR**

```bash
git push -u origin feat/windows-desktop
gh pr create --title "feat(desktop): Windows NSIS installer + CI job" --body "..."
gh api repos/fancydirty/mediary-scout/pulls/<N>/requested_reviewers -f 'reviewers[]=copilot-pull-request-reviewer[bot]' -X POST
```

- [ ] **Step 2: Wait for Copilot review, fix all complaints, re-review until 0 new comments**

- [ ] **Step 3: Merge (squash + delete branch)**

- [ ] **Step 4: Re-tag v1.0.0 → CI builds both macOS + Windows → both DMG and EXE in Release**
