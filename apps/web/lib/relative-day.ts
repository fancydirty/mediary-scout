/** 「今天 06:03」「昨天」「3 天前」「9月2日」 — how the memory notes say when. China time,
 *  matching the rest of the app. `now` comes from the server so SSR and hydration agree. */
const TZ = "Asia/Shanghai";

/** China calendar day as "YYYY-MM-DD", built from formatToParts so it never depends
 *  on a locale's date pattern. */
function dayKey(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Whole days between two "YYYY-MM-DD" keys, computed in UTC (no local-time parsing). */
function dayDiff(a: string, b: string): number {
  const toUtc = (key: string) => {
    const [y, m, d] = key.split("-").map(Number);
    return Date.UTC(y!, m! - 1, d!);
  };
  return Math.round((toUtc(a) - toUtc(b)) / 86_400_000);
}

export function relativeDayLabel(iso: string, nowIso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const days = dayDiff(dayKey(nowIso), dayKey(iso));
  if (days <= 0) {
    const hm = new Intl.DateTimeFormat("zh-CN", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(then);
    return `今天 ${hm}`;
  }
  if (days === 1) return "昨天";
  if (days < 7) return `${days} 天前`;
  const [, month, day] = dayKey(iso).split("-");
  return `${Number(month)}月${Number(day)}日`;
}
