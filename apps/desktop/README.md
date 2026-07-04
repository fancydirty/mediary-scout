# Mediary Scout — macOS desktop build

This package wraps the Next standalone server in an Electron shell and packages a
signed, notarized `.dmg`. The Electron main process (`src/main.ts`) spawns the
Next server as a Node child (`ELECTRON_RUN_AS_NODE`) and points a `BrowserWindow`
at it.

> **This build must be run on macOS** with Xcode command-line tools and an Apple
> Developer account. It cannot be produced on Linux/Windows (no code-signing, no
> `.dmg` target, native modules must match the target ABI).

## Layout that packaging relies on

`resolveServerEntry` (in `src/server-launch.ts`) resolves the packaged server to:

```
<process.resourcesPath>/app/apps/web/server.js
= Contents/Resources/app/apps/web/server.js
```

`electron-builder.yml`'s `extraResources` produces exactly that:

| from (relative to `apps/desktop`) | to (relative to `Contents/Resources`) | result |
| --- | --- | --- |
| `../web/.next/standalone` | `app` | `app/apps/web/server.js`, `app/node_modules/…`, `app/packages/workflow/dist/…` |
| `../web/.next/static` | `app/apps/web/.next/static` | static assets (not copied into standalone by Next) |
| `../web/public` | `app/apps/web/public` | public assets |

## Build steps (run from repo root unless noted)

### 1. Install (scripts enabled — downloads Electron + builds native modules)

```bash
npm install
```

### 2. Build the Next standalone server

```bash
npm run build:web
```

Produces `apps/web/.next/standalone/apps/web/server.js` (plus a traced
`node_modules`, including `better-sqlite3`).

### 3. ⚠️ Rebuild the BUNDLED better-sqlite3 for Electron's ABI (the key gotcha)

The server child runs under **Electron-as-Node**, so every native `.node` it
loads must match **Electron's** ABI — not the build machine's system Node. Next
traces a *copy* of `better-sqlite3` into the standalone bundle at
`apps/web/.next/standalone/node_modules/better-sqlite3`, and that copy is built
for system Node. It must be rebuilt for the pinned Electron version's ABI or the
server child crashes on launch (`ERR_DLOPEN_FAILED` / wrong `NODE_MODULE_VERSION`).

`electron-builder`'s `npmRebuild: true` only rebuilds `apps/desktop/node_modules`
— it does **not** touch the standalone copy. Do it explicitly:

```bash
# --module-dir points at the dir CONTAINING node_modules (the standalone root).
# @electron/rebuild reads the Electron version from apps/desktop automatically;
# if it can't, pass --version <electron-version> (currently pinned ^33).
npx @electron/rebuild \
  -f \
  -w better-sqlite3 \
  --module-dir apps/web/.next/standalone
```

Verify the rebuilt binary's ABI matches Electron 33 before packaging (optional
sanity check):

```bash
find apps/web/.next/standalone/node_modules/better-sqlite3 -name '*.node'
```

### 4. Signing / notarization environment (NEVER commit these)

From your Apple Developer account, export before packaging:

```bash
# Code-signing identity (one of):
export CSC_LINK="/absolute/path/to/DeveloperIDApplication.p12"   # base64 or file path
export CSC_KEY_PASSWORD="<p12 password>"
# …or reference an identity already in the login keychain:
# export CSC_NAME="Developer ID Application: Your Name (TEAMID)"

# Notarization (electron-builder v25 `mac.notarize: true` reads these):
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # app-specific pw, NOT your Apple ID pw
export APPLE_TEAM_ID="A1B2C3D4E5"                          # 10-char team id
```

### 5. Package the signed, notarized dmg

```bash
npm run dist --workspace @media-track/desktop
```

Output lands in `apps/desktop/dist-app/`.

## Unsigned local smoke build (validate layout before signing)

To confirm the resource layout / server boot without a signing identity, disable
automatic identity discovery so electron-builder skips signing (and therefore
notarization):

```bash
export CSC_IDENTITY_AUTO_DISCOVERY=false
npm run dist --workspace @media-track/desktop
```

The resulting app is unsigned (Gatekeeper will warn), but you can open it to
verify the server child starts and the window loads. Do **not** ship this build.

## Notes

- `hardenedRuntime: true` + `build/entitlements.mac.plist` are required for
  notarization. The entitlements include
  `com.apple.security.cs.disable-library-validation` so the hardened-runtime
  child can load better-sqlite3's non-Apple-signed `.node`.
- Steps 2 and 3 must run **before** step 5 — packaging copies the standalone
  bundle as-is; it does not rebuild the bundled native module for you.
