"use client";

import { useEffect, useState } from "react";

/** Live count of Settings attention items. Hidden at zero.
 *  Mobile nav + desktop footer each mount one instance; only the instance
 *  matching the current breakpoint polls (same 860px switch as the sidebar). */
export function SettingsAttentionBadge({
  storageId,
  visibleWhen,
}: {
  storageId?: string | undefined;
  visibleWhen: "mobile" | "desktop";
}) {
  const [visible, setVisible] = useState(false);
  const [count, setCount] = useState(0);
  const [severity, setSeverity] = useState<"warning" | "blocker" | null>(null);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 860px)");
    const sync = () => {
      setVisible(visibleWhen === "mobile" ? mq.matches : !mq.matches);
    };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [visibleWhen]);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    const poll = async () => {
      try {
        const url = storageId
          ? `/api/settings/attention?w=${encodeURIComponent(storageId)}`
          : "/api/settings/attention";
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as {
          count?: number;
          severity?: "warning" | "blocker" | null;
        };
        if (!alive) return;
        setCount(typeof data.count === "number" ? data.count : 0);
        setSeverity(data.severity === "blocker" || data.severity === "warning" ? data.severity : null);
      } catch {
        // keep last
      }
    };
    void poll();
    const id = setInterval(() => void poll(), 8000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [storageId, visible]);

  if (!visible || count <= 0) return null;
  const tone = severity === "blocker" ? "nav-badge-alert" : "nav-badge-warning";
  return <span className={`nav-badge ${tone}`}>{count}</span>;
}
