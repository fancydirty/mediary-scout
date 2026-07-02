/**
 * The 网盘连接 section-header badge, derived from ALL connected drives — not just
 * 115. Issue #93: the header used getPan115ConnectionStatus() alone, so a user
 * whose only drive is 光鸭/夸克 saw a permanent misleading 未连接 while the
 * per-drive rows right below showed their drive as fine. Pure so it's testable;
 * the page feeds it the drives list plus the legacy .env-115 flag (an env cookie
 * predates connected_storages rows and deserves its distinct label).
 */
export interface DriveConnectionBadge {
  tone: "green" | "amber";
  label: string;
}

export function driveConnectionBadge(input: {
  envConnected: boolean;
  drives: Array<{ status: "active" | "frozen" }>;
}): DriveConnectionBadge {
  const active = input.drives.filter((drive) => drive.status === "active").length;
  if (active > 0) {
    return { tone: "green", label: `已连接 ${active} 块盘` };
  }
  if (input.drives.length > 0) {
    return { tone: "amber", label: "已连接但掉线" };
  }
  if (input.envConnected) {
    return { tone: "green", label: "已连接（.env）" };
  }
  return { tone: "amber", label: "未连接" };
}
