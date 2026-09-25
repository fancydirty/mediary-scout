/** 「今天 06:03」「昨天」「3 天前」「9月2日」 — how the memory notes say when. China time,
 *  matching the rest of the app. `now` comes from the server so SSR and hydration agree. */
const TZ = "Asia/Shanghai";

function dayKey(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

export function relativeDayLabel(iso: string, nowIso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const days = Math.round((Date.parse(dayKey(nowIso)) - Date.parse(dayKey(iso))) / 86_400_000);
  if (days <= 0) {
    const hm = new Intl.DateTimeFormat("zh-CN", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(then);
    return `今天 ${hm}`;
  }
  if (days === 1) return "昨天";
  if (days < 7) return `${days} 天前`;
  const [, month, day] = dayKey(iso).split("-");
  return `${Number(month)}月${Number(day)}日`;
}
