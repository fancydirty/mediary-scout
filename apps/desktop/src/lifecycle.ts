/** A plain, Electron-free description of a tray menu item; main.ts maps it onto a real MenuItem. */
export interface TrayItem {
  id: "open" | "status" | "openAtLogin" | "quit";
  label: string;
  type: "normal" | "checkbox" | "separator";
  enabled: boolean;
  checked?: boolean;
}

export interface TrayMenuState {
  items: TrayItem[];
}

/** Decide what happens when the user closes the main window. Normal use = hide (keep the
 *  server + patrol alive); only a real quit lets the window actually close. */
export function onWindowClose(input: { isQuitting: boolean }): { preventDefault: boolean; hideWindow: boolean } {
  return input.isQuitting
    ? { preventDefault: false, hideWindow: false }
    : { preventDefault: true, hideWindow: true };
}

/** Build the tray menu descriptor from current state. Labels are user-facing (Chinese, to
 *  match the app UI). */
export function trayMenuState(input: { openAtLogin: boolean; serverReady: boolean }): TrayMenuState {
  return {
    items: [
      { id: "open", label: "打开 Mediary Scout", type: "normal", enabled: true },
      // The tray is only created after the server boots, so serverReady=false means the
      // server has STOPPED/crashed — not "starting". Show a stopped label, not a spinner.
      { id: "status", label: input.serverReady ? "● 运行中" : "○ 已停止", type: "normal", enabled: false },
      { id: "openAtLogin", label: "开机自启", type: "checkbox", enabled: true, checked: input.openAtLogin },
      { id: "quit", label: "退出", type: "normal", enabled: true },
    ],
  };
}
