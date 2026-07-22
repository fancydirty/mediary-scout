"use client";

import { useEffect, useRef, useState } from "react";

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
  // Bumped when hidden so late poll responses from a previous visible window are ignored.
  const epochRef = useRef(0);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 860px)");
    const sync = () => {
      const next = visibleWhen === "mobile" ? mq.matches : !mq.matches;
      setVisible(next);
      if (!next) {
        epochRef.current += 1;
        // Drop stale count so a later resize doesn't flash an old badge.
        setCount(0);
        setSeverity(null);
      }
    };
    sync();
    // Older Safari only has addListener/removeListener on MediaQueryList.
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", sync);
      return () => mq.removeEventListener("change", sync);
    }
    mq.addListener(sync);
    return () => mq.removeListener(sync);
  }, [visibleWhen]);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const epochAtStart = epochRef.current;
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
        if (!alive || epochRef.current !== epochAtStart) return;
        setCount(typeof data.count === "number" ? data.count : 0);
        setSeverity(data.severity === "blocker" || data.severity === "warning" ? data.severity : null);
      } catch {
        // keep last
      } finally {
        // Self-schedule so slow requests never overlap.
        if (alive && epochRef.current === epochAtStart) {
          timer = setTimeout(() => void poll(), 8000);
        }
      }
    };
    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [storageId, visible]);

  if (!visible || count <= 0) return null;
  const tone = severity === "blocker" ? "nav-badge-alert" : "nav-badge-warning";
  return <span className={`nav-badge ${tone}`}>{count}</span>;
}
