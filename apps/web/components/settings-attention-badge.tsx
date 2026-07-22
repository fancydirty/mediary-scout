"use client";

import { useEffect, useState } from "react";

/** Live count of Settings attention items. Hidden at zero. Desktop footer + mobile
 *  tab both mount this; CSS decides placement (inline vs icon overlay). */
export function SettingsAttentionBadge() {
  const [count, setCount] = useState(0);
  const [severity, setSeverity] = useState<"warning" | "blocker" | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch("/api/settings/attention", { cache: "no-store" });
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
  }, []);

  if (count <= 0) return null;
  const tone = severity === "blocker" ? "nav-badge-alert" : "nav-badge-warning";
  return <span className={`nav-badge ${tone}`}>{count}</span>;
}
