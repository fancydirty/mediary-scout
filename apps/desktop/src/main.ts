import { app, BrowserWindow, Tray, Menu, dialog, nativeImage, type MenuItemConstructorOptions } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import {
  pickFreePort,
  buildServerEnv,
  waitForHealthy,
  httpProbe,
  resolveServerEntry,
} from "./server-launch.js";
import { onWindowClose, trayMenuState, type TrayItem } from "./lifecycle.js";

let serverProc: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let serverBooted = false;

// Single-instance lock: a 2nd launch focuses the existing window instead of
// spawning a second server (which would fight over the SQLite DB + patrol).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // macOS: clicking the Dock icon after the window was closed-to-tray should bring
  // it back (the standard "activate" gesture), not require a relaunch.
  app.on("activate", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.on("before-quit", () => {
    isQuitting = true;
  });
  app.on("will-quit", () => {
    // SIGTERM the server child so it exits cleanly; WAL keeps SQLite durable.
    serverProc?.kill("SIGTERM");
    serverProc = null;
  });

  app.whenReady().then(bootstrap).catch((error: unknown) => {
    dialog.showErrorBox(
      "Mediary Scout",
      `启动失败：${error instanceof Error ? error.message : String(error)}`,
    );
    app.quit();
  });
}

async function bootstrap(): Promise<void> {
  const url = await startServer();
  createWindow(url);
  createTray();
}

async function startServer(): Promise<string> {
  const port = await pickFreePort();
  const sqlitePath = path.join(app.getPath("userData"), "mediary.db");
  const entry = resolveServerEntry({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    // dev: apps/desktop/dist/main.js → repo root is three levels up.
    repoRoot: path.resolve(__dirname, "..", "..", ".."),
  });
  serverProc = spawn(process.execPath, [entry], {
    env: buildServerEnv({ port, sqlitePath, baseEnv: process.env }),
    stdio: "inherit",
  });
  serverProc.on("exit", (code) => {
    const wasBooted = serverBooted;
    serverProc = null;
    serverBooted = false;
    refreshTray(); // reflect the stopped server in the tray menu
    // Only surface an error for an UNEXPECTED exit AFTER a successful boot. A crash
    // DURING startup is already reported by bootstrap()'s catch — don't double-dialog.
    if (!isQuitting && wasBooted) {
      dialog.showErrorBox("Mediary Scout", `服务进程意外退出（code ${code ?? "null"}）。`);
    }
  });
  const url = `http://127.0.0.1:${port}/`;
  // spawn() reports launch failures (missing entry ENOENT, EACCES) via an async "error"
  // event, NOT a throw. Race it against the health wait so a failure fails FAST (surfaced
  // once by bootstrap()'s catch) instead of an unhandled event + a 60s health timeout.
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    serverProc!.once("error", (err) =>
      finish(() => reject(new Error(`无法启动服务进程：${err.message}`))),
    );
    waitForHealthy({ probe: httpProbe(url), timeoutMs: 60_000, intervalMs: 250 }).then(
      () => finish(resolve),
      (err: unknown) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))),
    );
  });
  serverBooted = true;
  return url;
}

function createWindow(url: string): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "Mediary Scout",
    show: true,
  });
  mainWindow.on("close", (event) => {
    const decision = onWindowClose({ isQuitting });
    if (decision.preventDefault) event.preventDefault();
    if (decision.hideWindow) mainWindow?.hide();
  });
  void mainWindow.loadURL(url);
}

// A 22×22 monochrome "play" glyph as a macOS template image (black + alpha; the OS
// recolors it for light/dark menu bars). Embedded as a data URL so the tray is VISIBLE
// with no external asset / packaging step — close-to-tray is the primary lifecycle, so
// an invisible icon would make the app inoperable.
const TRAY_ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAAN0lEQVR42mNgGAUDCf7T0uD/tDSY6hb8x4FpZvB/WhpMkQX/aWX4gBo8NCJv8GeQoVMIjQLqAABeq02ztviApQAAAABJRU5ErkJggg==";

function createTray(): void {
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
  icon.setTemplateImage(true); // macOS: auto-recolor for the menu bar
  tray = new Tray(icon);
  tray.setToolTip("Mediary Scout");
  refreshTray();
}

function refreshTray(): void {
  if (!tray) return;
  const state = trayMenuState({
    openAtLogin: app.getLoginItemSettings().openAtLogin,
    // Use serverBooted, not `serverProc !== null`: the process is non-null the instant
    // spawn() returns (before the health check passes), so serverProc would falsely show
    // "running" during startup / after an early crash.
    serverReady: serverBooted,
  });
  const template: MenuItemConstructorOptions[] = state.items.map((item: TrayItem) => ({
    id: item.id,
    label: item.label,
    type: item.type,
    enabled: item.enabled,
    // Only set `checked` when the item actually has it (exactOptionalPropertyTypes forbids
    // passing an explicit `undefined` to an optional-only prop).
    ...(item.checked !== undefined ? { checked: item.checked } : {}),
    click: () => handleTrayClick(item.id),
  }));
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function handleTrayClick(id: TrayItem["id"]): void {
  if (id === "open") {
    mainWindow?.show();
    mainWindow?.focus();
  } else if (id === "openAtLogin") {
    const next = !app.getLoginItemSettings().openAtLogin;
    app.setLoginItemSettings({ openAtLogin: next });
    refreshTray();
  } else if (id === "quit") {
    isQuitting = true;
    app.quit();
  }
}
