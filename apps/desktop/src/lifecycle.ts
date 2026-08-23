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
      // 刻意只用中文短名(不是完整的「巡影 · Mediary Scout」):兄弟项都是
      // 「● 运行中」「开机自启」「退出」这种短标签,塞完整品牌名会突兀。
      // 「与其它应用区分」由托盘 tooltip 承担(main.ts:177,已是完整名)——
      // 那才是悬停时显示的;菜单是点开后才看到的,此时用户已知道点的是谁。
      { id: "open", label: "打开 巡影", type: "normal", enabled: true },
      // The tray is only created after the server boots, so serverReady=false means the
      // server has STOPPED/crashed — not "starting". Show a stopped label, not a spinner.
      { id: "status", label: input.serverReady ? "● 运行中" : "○ 已停止", type: "normal", enabled: false },
      { id: "openAtLogin", label: "开机自启", type: "checkbox", enabled: true, checked: input.openAtLogin },
      { id: "quit", label: "退出", type: "normal", enabled: true },
    ],
  };
}
