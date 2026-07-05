# Windows Desktop 设计

日期：2026-07-05
状态：待实现

## 目标

将 macOS 桌面版已有的模式复制到 Windows：同一个 Electron 壳 + SQLite 数据层 + Next standalone server，出 NSIS installer `.exe`。容器版和 macOS 桌面版的全部产品逻辑不变，Windows 只是新增一个打包 target + CI job。

## 范围

- electron-builder.yml 加 `win` target（NSIS）
- release workflow 加 `build-windows` job（`windows-latest` runner）
- `resolveServerEntry` 路径分隔符跨平台（`path.join` 替代硬编码 `/`）
- better-sqlite3 Windows ABI swap（prebuild-install 拉 `win32-x64` prebuild）
- Windows PNG 图标（已有 `build/icon.png`）
- **不做** Windows 代码签名（v1 出未签名 exe，用户 SmartScreen 会提示但可运行；EV 证书是 v2）
- **不做** Windows 专属功能（开机自启在 macOS 已有，Windows 的 `msi` target 是 v2）

## 实现切面

### 1. electron-builder.yml

已有 `win` section（之前手贱加的），需要确认正确：

```yaml
win:
  target:
    - nsis
  icon: build/icon.png
```

### 2. release workflow

在 `release-macos.yml` 同文件加 `build-windows` job，或新建 `release-windows.yml`。推荐同文件不同 job（一个 tag 触发两个平台）：

```yaml
build-windows:
  runs-on: windows-latest
  steps:
    - checkout + tag checkout（同 macOS）
    - npm ci
    - build:web
    - build desktop tsc
    - prebuild-install -r electron -t 33.4.11（自动拉 win32-x64）
    - ABI smoke test（Electron-as-Node 跑 better-sqlite3）
    - npm run dist --workspace @media-track/desktop（无签名 env）
    - upload exe to GitHub Release
```

Windows 不需要证书导入/签名/公证步骤。

### 3. 路径分隔符

`resolveServerEntry` 当前硬编码 `/`：
```ts
return input.isPackaged
  ? `${input.resourcesPath}/app/apps/web/server.js`
  : `${input.repoRoot}/apps/web/.next/standalone/apps/web/server.js`;
```

Windows 上 `process.resourcesPath` 用 `\`，但 Node.js 的 `require`/`import` 两种分隔符都认。**不需要改**——Node 在 Windows 上也能用 `/`。验证方式：CI build + smoke test。

### 4. better-sqlite3 ABI

`prebuild-install -r electron -t 33.4.11` 在 Windows runner 上自动拉 `electron-v130-win32-x64.tar.gz`。不需要额外参数。

### 5. 图标

已有 `build/icon.png`（512x512）。electron-builder Windows target 用 PNG。

## 测试策略

- CI：Windows runner build 成功 + ABI smoke test 通过 + exe 产出
- 真机：下载 exe → 安装 → 启动 → agent.json 生成 → curl API（需要 Windows 机器，v1 可选）

## 明确不做（YAGNI v1）

- Windows 代码签名（EV 证书成本高，SmartScan 警告可忽略）
- MSI target（NSIS 够用）
- Windows 开机自启（macOS 已有 login item，Windows 的注册表自启是 v2）
- ARM64 Windows（市场极小，v1 只出 x64）
