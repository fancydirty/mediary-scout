"use client";

import { useEffect, useState } from "react";
import { getLastSeen } from "../lib/notifications-seen";

/** Unread count on the 通知 nav: notifications newer than this browser's last-seen
 *  watermark. Clears when the 通知 page is opened (which advances the watermark). */
export function NotificationsNavBadge({ storageId }: { storageId?: string | undefined }) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const url = storageId
          ? `/api/notifications/meta?w=${encodeURIComponent(storageId)}`
          : "/api/notifications/meta";
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { createdAts?: string[] };
        const lastSeen = getLastSeen();
        const unread = (data.createdAts ?? []).filter((createdAt) => createdAt > lastSeen).length;
        if (alive) setCount(unread);
      } catch {
        // transient
      }
    };
    void poll();
    const id = setInterval(() => void poll(), 8000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [storageId]);

  if (count === 0) {
    return null;
  }
  return <span className="nav-badge nav-badge-alert">{count}</span>;
}
