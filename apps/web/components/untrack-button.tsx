"use client";

import { LoaderCircle, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { untrackTitleAction } from "../app/actions";
import { isDemoModeClient } from "../lib/demo-mode";

/**
 * 取消追踪按钮。整剧(无 seasonNumber)成功后跳回媒体库;单季成功后 refresh 留在原页
 * (该季变回未追踪、本组件随之卸载)。两步确认(危险操作);demo 只读模式不渲染。
 * storageId 必填透传当前工作区——取消必须作用在用户正在看的那块盘。mediaKind 区分
 * movie/tv 命名空间(同一数字 id 可同时是电影和剧集),避免误删同 id 的另一类。
 * 不碰网盘文件(纯应用侧忘记追踪)。
 */
export function UntrackButton({
  tmdbId,
  storageId,
  mediaKind,
  seasonNumber,
  basePath,
  label = "取消追踪",
}: {
  tmdbId: number;
  /** Tree model: the active workspace drive. REQUIRED (value may be undefined = primary). */
  storageId: string | undefined;
  /** Disambiguate TMDB movie/tv id namespaces (same number can be both). */
  mediaKind: "movie" | "tv";
  /** Given → untrack only this season; omitted → the whole show on this drive. */
  seasonNumber?: number | undefined;
  /** Library path to return to after a whole-show untrack ("/" or "/w/<id>"). */
  basePath: string;
  label?: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  // A non-success outcome (in_flight / not_found) shown next to the button — NOT
  // in place of it, so the user can retry without leaving the page.
  const [message, setMessage] = useState<string | null>(null);

  // Read-only demo: management actions aren't offered.
  if (isDemoModeClient()) return null;

  const run = () => {
    startTransition(async () => {
      const result = await untrackTitleAction({
        tmdbId,
        storageId,
        mediaKind,
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

  return (
    <span className="untrack-confirm">
      {confirming ? (
        <>
          <span className="untrack-note">取消后从媒体库移除，网盘文件保留（重新获取可秒传恢复）。</span>
          <button type="button" className="ghost-button danger" disabled={isPending} onClick={run}>
            {isPending ? <LoaderCircle size={13} className="spin" aria-hidden /> : null}
            确认取消追踪
          </button>
          <button
            type="button"
            className="ghost-button"
            disabled={isPending}
            onClick={() => setConfirming(false)}
          >
            再想想
          </button>
        </>
      ) : (
        <button
          type="button"
          className="ghost-button danger"
          disabled={isPending}
          onClick={() => {
            setMessage(null);
            setConfirming(true);
          }}
        >
          <Trash2 size={13} aria-hidden />
          {label}
        </button>
      )}
      {message ? (
        <span className="untrack-note" role="status">
          {message}
        </span>
      ) : null}
    </span>
  );
}
