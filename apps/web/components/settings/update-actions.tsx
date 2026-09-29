"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { checkForUpdatesAction, saveAutoUpdateAction, startUpdateAction } from "../../app/update-actions";
import { AUTO_UPDATE_HOURS } from "../../lib/auto-update-schedule";
import { copyText } from "../../lib/copy-text";
import { ACTIVE_UPDATER_PHASES as ACTIVE } from "../../lib/update-state";
import type { UpdaterStatus } from "../../lib/updater-client";

const PROGRESS: Record<string, number> = { waiting: 5, backing_up: 15, building: 50, switching: 80, verifying: 92 };

export function UpdateNowButton({ tag, initial }: { tag: string | null; initial: UpdaterStatus }) {
  const [status, setStatus] = useState<UpdaterStatus | null>(initial);
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();
  const running = status ? ACTIVE.has(status.phase) : false;
  // The script waits again right before the swap (phase "waiting" after "building");
  // never let the bar move backwards.
  const shown = useRef(0);
  if (status) shown.current = Math.max(shown.current, PROGRESS[status.phase] ?? 10);

  useEffect(() => {
    if (!running) return;
    let sawDown = false;
    let stopped = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const response = await fetch("/api/update/status", { cache: "no-store" });
          if (!response.ok) throw new Error(String(response.status));
          const next = ((await response.json()) as { updater: UpdaterStatus | null }).updater;
          if (stopped) return;
          const step = nextPollStep(next, sawDown);
          if (step === "reload") window.location.reload();
          else if (step === "wait") {
            // The updater did not answer (it may be restarting): keep the bar and keep polling.
            sawDown = true;
            setMessage("正在重启…");
          } else {
            // The updater answered again: drop any "正在重启…" / click override so its own
            // step text ("正在构建新版本…" 等) shows.
            setMessage("");
            setStatus(next);
          }
        } catch {
          if (stopped) return;
          sawDown = true;
          setMessage("正在重启…");
        }
      })();
    }, 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [running]);

  if (running && status) {
    return (
      <div className="update-progress" role="status">
        <div className="update-muted">{message || status.message}</div>
        <div className="update-bar">
          <i style={{ width: `${shown.current}%` }} />
        </div>
      </div>
    );
  }
  if (!tag) return null;
  return (
    <div className="update-now">
      <button
        type="button"
        className="primary-button"
        disabled={pending}
        onClick={() => {
          startTransition(() => {
            void startUpdateAction(tag).then(
              (result) => {
                // Started, or "busy": another tab or a scheduled update already started one.
                // Either way switch to the progress card and let the poller fetch the real
                // step text ("正在构建新版本…" 等). Not router.refresh(): this component keeps
                // its state across a refresh, and with no tag it would render nothing.
                if (result.ok || result.reason === "busy") {
                  setMessage("");
                  setStatus({
                    ...(status ?? emptyStatus()),
                    phase: "waiting",
                    message: result.ok ? "准备更新…" : "已经在更新了，正在读取进度…",
                  });
                  return;
                }
                setMessage(result.message);
              },
              () => setMessage("连不上更新助手，稍后再试。"),
            );
          });
        }}
      >
        立即更新
      </button>
      {message ? <span className="update-muted">{message}</span> : null}
    </div>
  );
}

/** 「每天自动更新」 and its hour (Beijing time). Every change saves both values at once. */
export function AutoUpdateSwitch({ initial }: { initial: { enabled: boolean; time: string } }) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [time, setTime] = useState(initial.time);
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();

  const save = (next: { enabled: boolean; time: string }) => {
    const previous = { enabled, time };
    setEnabled(next.enabled);
    setTime(next.time);
    setNote("");
    startTransition(async () => {
      try {
        const result = await saveAutoUpdateAction(next.enabled, next.time);
        setNote(result.message);
        if (!result.ok) {
          setEnabled(previous.enabled);
          setTime(previous.time);
        }
      } catch {
        setNote("没保存上，稍后再试。");
        setEnabled(previous.enabled);
        setTime(previous.time);
      }
    });
  };

  return (
    <div className="update-auto-row">
      <label className="service-toggle">
        <input
          type="checkbox"
          role="switch"
          checked={enabled}
          disabled={pending}
          onChange={(event) => save({ enabled: event.target.checked, time })}
        />
        每天自动更新
      </label>
      <select
        className="setting-control"
        value={time}
        disabled={pending}
        aria-label="自动更新的时间（北京时间）"
        onChange={(event) => save({ enabled, time: event.target.value })}
      >
        {AUTO_UPDATE_HOURS.map((hour) => (
          <option key={hour} value={hour}>
            {hour}
          </option>
        ))}
      </select>
      <span className="update-faint">北京时间</span>
      {note ? <span className="update-muted">{note}</span> : null}
    </div>
  );
}

export function CheckUpdatesButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      className="ghost-button"
      disabled={pending}
      onClick={() => {
        startTransition(() => {
          void checkForUpdatesAction().then(
            () => router.refresh(),
            () => undefined,
          );
        });
      }}
    >
      {pending ? "检查中…" : "检查更新"}
    </button>
  );
}

export function CopyCommandButton({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ghost-button"
      onClick={() => {
        void copyText(command).then((ok) => {
          setCopied(ok);
          if (ok) window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "已复制" : "复制"}
    </button>
  );
}

/** What the progress poller does with one /api/update/status answer. A null status is
 *  not "done": the updater may be restarting, and clearing the status would unmount the
 *  poller, which would then never reload the page. */
export function nextPollStep(next: UpdaterStatus | null, sawDown: boolean): "reload" | "wait" | "show" {
  if (!next) return "wait";
  if (sawDown || !ACTIVE.has(next.phase)) return "reload";
  return "show";
}

function emptyStatus(): UpdaterStatus {
  return { phase: "idle", targetTag: null, fromCommit: null, startedAt: null, finishedAt: null, message: "", logTail: "" };
}
