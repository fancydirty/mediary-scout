"use client";

import { LoaderCircle, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { untrackTitleAction } from "../app/actions";
import { isDemoModeClient } from "../lib/demo-mode";

/**
 * 取消追踪按钮。整剧(无 seasonNumber)成功后跳回媒体库;单季成功后 refresh 留在原页。
 * 两步确认(危险操作);demo 只读模式不渲染。storageId 必填透传当前工作区——取消必须
 * 作用在用户正在看的那块盘,不能误删主盘。不碰网盘文件(纯应用侧忘记追踪)。
 */
export function UntrackButton({
  tmdbId,
  storageId,
  seasonNumber,
  basePath,
  label = "取消追踪",
}: {
  tmdbId: number;
  /** Tree model: the active workspace drive. REQUIRED (value may be undefined = primary). */
  storageId: string | undefined;
  /** Given → untrack only this season; omitted → the whole show on this drive. */
  seasonNumber?: number | undefined;
  /** Library path to return to after a whole-show untrack ("/" or "/w/<id>"). */
  basePath: string;
  label?: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Read-only demo: management actions aren't offered.
  if (isDemoModeClient()) return null;

  const run = () => {
    startTransition(async () => {
      const result = await untrackTitleAction({
        tmdbId,
        storageId,
        ...(seasonNumber !== undefined ? { seasonNumber } : {}),
      });
      if (result.status === "untracked" && seasonNumber === undefined) {
        // Whole-show untracked → it's gone from the library; go there to show it.
        router.push(`${basePath}?tab=library`);
        return;
      }
      setMessage(result.message);
      setConfirming(false);
      router.refresh();
    });
  };

  if (message) {
    return (
      <span className="untrack-note" role="status">
        {message}
      </span>
    );
  }

  if (!confirming) {
    return (
      <button
        type="button"
        className="ghost-button danger"
        disabled={isPending}
        onClick={() => setConfirming(true)}
      >
        <Trash2 size={13} aria-hidden />
        {label}
      </button>
    );
  }

  return (
    <span className="untrack-confirm">
      <span className="untrack-note">取消后从媒体库移除，网盘文件保留（重新获取可秒传恢复）。</span>
      <button type="button" className="ghost-button danger" disabled={isPending} onClick={run}>
        {isPending ? <LoaderCircle size={13} className="spin" aria-hidden /> : null}
        确认取消追踪
      </button>
      <button type="button" className="ghost-button" disabled={isPending} onClick={() => setConfirming(false)}>
        再想想
      </button>
    </span>
  );
}
