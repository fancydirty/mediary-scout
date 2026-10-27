"use client";

import { useEffect, useState, useTransition } from "react";
import { GripVertical } from "lucide-react";
import { saveDriveOrderAction } from "../app/actions";
import { TestConnectionButton } from "./test-connection-button";
import { UnbindStorageButton } from "./unbind-storage-button";

export interface DriveOrderCardItem {
  id: string;
  provider: string;
  providerLabel: string;
  hasBrandSvg: boolean;
  providerUid: string;
  maskedUid: string;
  frozen: boolean;
  provisioned: boolean;
  connectedAt: string | null;
  spaceBadgeText: string;
  spaceOverQuota: boolean;
}

function resolveDriveDotStatus(drive: DriveOrderCardItem): {
  ready: boolean;
  title: string;
  ariaLabel: string;
} {
  if (drive.frozen) {
    return {
      ready: false,
      title: "凭证已失效，重新绑定同一账号即可恢复",
      ariaLabel: "掉线",
    };
  }
  if (drive.provisioned) {
    return {
      ready: true,
      title: "目录已就绪",
      ariaLabel: "就绪",
    };
  }
  return {
    ready: false,
    title: "目录待建",
    ariaLabel: "目录待建",
  };
}

function renderDriveStatusMeta(drive: DriveOrderCardItem) {
  if (drive.frozen) {
    return <span className="tone-amber-text">掉线 · 重新绑定即恢复</span>;
  }
  if (!drive.provisioned) {
    return <span className="tone-amber-text">目录待建</span>;
  }
  if (drive.connectedAt) {
    return <span>{drive.connectedAt.slice(0, 10)} 连接</span>;
  }
  return <span>就绪</span>;
}

export function DriveOrderGrid({ initialDrives }: { initialDrives: DriveOrderCardItem[] }) {
  const [items, setItems] = useState<DriveOrderCardItem[]>(initialDrives);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    setItems(initialDrives);
  }, [initialDrives]);

  const canReorder = items.length > 1;

  function handleDrop(targetId: string) {
    if (!draggedId || draggedId === targetId) {
      setDraggedId(null);
      setDragOverId(null);
      return;
    }
    const fromIdx = items.findIndex((item) => item.id === draggedId);
    const toIdx = items.findIndex((item) => item.id === targetId);
    if (fromIdx < 0 || toIdx < 0) {
      setDraggedId(null);
      setDragOverId(null);
      return;
    }
    const prevItems = items;
    const next = [...items];
    const [moved] = next.splice(fromIdx, 1);
    if (moved) {
      next.splice(toIdx, 0, moved);
    }
    setItems(next);
    setErrorMessage(null);
    setDraggedId(null);
    setDragOverId(null);
    startTransition(async () => {
      try {
        const res = await saveDriveOrderAction(next.map((item) => item.id));
        if (!res.success) {
          setItems(prevItems);
          setErrorMessage(res.message ?? "保存网盘顺序失败");
        }
      } catch (error) {
        setItems(prevItems);
        setErrorMessage(error instanceof Error ? error.message : "保存网盘顺序失败");
      }
    });
  }

  return (
    <>
      {errorMessage ? (
        <p className="tone-amber-text" role="alert">
          {errorMessage}
        </p>
      ) : null}
      <div className="drive-grid" aria-busy={isPending}>
        {items.map((drive, index) => {
          const dot = resolveDriveDotStatus(drive);
          const isDragging = draggedId === drive.id;
          const isDragOver = dragOverId === drive.id && draggedId !== drive.id;
          return (
            <div
              key={drive.id}
              draggable={canReorder}
              onDragStart={(e) => {
                setDraggedId(drive.id);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", drive.id);
              }}
              onDragOver={(e) => {
                if (!canReorder) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dragOverId !== drive.id) {
                  setDragOverId(drive.id);
                }
              }}
              onDragLeave={() => {
                if (dragOverId === drive.id) {
                  setDragOverId(null);
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                handleDrop(drive.id);
              }}
              onDragEnd={() => {
                setDraggedId(null);
                setDragOverId(null);
              }}
              className={`drive-card${drive.frozen ? " is-frozen" : ""}${canReorder ? " is-draggable" : ""}${isDragging ? " is-dragging" : ""}${isDragOver ? " is-drag-over" : ""}`}
            >
              <div className="drive-card-head">
                {canReorder ? (
                  <span
                    className="drive-card-grip"
                    title={`优先级 #${index + 1} · 拖拽调整优先顺序`}
                    aria-label={`优先级 #${index + 1}`}
                  >
                    <GripVertical size={14} aria-hidden />
                  </span>
                ) : null}
                {drive.hasBrandSvg ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    className="drive-card-icon"
                    src={`/brands/${drive.provider}.svg`}
                    alt=""
                    width={26}
                    height={26}
                  />
                ) : (
                  <span className="drive-card-icon-fallback" aria-hidden />
                )}
                <span className="drive-card-name">{drive.providerLabel}</span>
                <span
                  className={`drive-dot ${dot.ready ? "green" : "amber"}`}
                  role="img"
                  title={dot.title}
                  aria-label={dot.ariaLabel}
                />
              </div>
              <div className="drive-card-uid" title={drive.providerUid}>
                {drive.maskedUid}
              </div>
              <div className="drive-card-meta">
                {renderDriveStatusMeta(drive)}
                <span> · </span>
                <span className={drive.spaceOverQuota ? "tone-amber-text" : undefined}>
                  {drive.spaceBadgeText}
                </span>
              </div>
              <div className="drive-card-actions">
                <TestConnectionButton storageId={drive.id} />
                <UnbindStorageButton storageId={drive.id} label={drive.providerLabel} />
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
