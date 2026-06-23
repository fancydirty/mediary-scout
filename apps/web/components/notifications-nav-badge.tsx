"use client";

import { useEffect, useState } from "react";
import { isDemoModeClient } from "../lib/demo-mode";
import { DEMO_ACQUIRED_EVENT, demoSessionNotifications, listDemoAcquisitions } from "../lib/demo-session";
import { getLastSeen } from "../lib/notifications-seen";

/** Unread count on the 通知 nav: notifications newer than this browser's last-seen
 *  watermark. Clears when the 通知 page is opened (which advances the watermark).
 *  In demo mode, this session's acquisitions are client-only (no DB row), so they
 *  are counted too — by the same last-seen diff (their cards carry data-created-at,
 *  so opening 通知 advances the watermark past them and clears the badge). */
export function NotificationsNavBadge({ storageId }: { storageId?: string | undefined }) {
  const [count, setCount] = useState(0);
  const [demoUnread, setDemoUnread] = useState(0);

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

  useEffect(() => {
    if (!isDemoModeClient()) {
      return;
    }
    const recompute = () => {
      const lastSeen = getLastSeen();
      const unread = demoSessionNotifications(listDemoAcquisitions()).filter(
        (n) => n.createdAt > lastSeen,
      ).length;
      setDemoUnread(unread);
    };
    recompute();
    const id = window.setInterval(recompute, 2000);
    window.addEventListener(DEMO_ACQUIRED_EVENT, recompute);
    return () => {
      window.clearInterval(id);
      window.removeEventListener(DEMO_ACQUIRED_EVENT, recompute);
    };
  }, []);

  const total = count + demoUnread;
  if (total === 0) {
    return null;
  }
  return <span className="nav-badge nav-badge-alert">{total}</span>;
}
