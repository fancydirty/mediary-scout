import {
  landedSize,
  type MediaType,
  type NotificationReportStatus,
  type WorkflowRepository,
  type WorkflowRunProgress,
} from "@media-track/workflow";
import { distinctSeasons, seasonLabelText } from "./activity-season-label";

// Re-export the pure season-label helpers so existing server-side imports from
// this module keep working. The CANONICAL home is the runtime-free
// `activity-season-label.ts` — the "use client" activity-feed must import from
// there (not here), since this module pulls the Postgres-backed runtime.
export { distinctSeasons, seasonLabelText };

/** One title currently in the pipeline (queued or running). */
export interface ActivityActiveRun {
  runId: string;
  tmdbId: number;
  title: string;
  year: number | null;
  type: MediaType;
  posterPath: string | null;
  /** The snapshot's primary/placeholder season number (`snapshot.season`). May
   *  be a real number even for a whole-show ("全季") run, where it's just the
   *  scope's anchor season — NOT the full set of covered seasons. null only for
   *  movies / season-less snapshots. For display, prefer `seasonNumbers`. */
  seasonNumber: number | null;
  /** The distinct, sorted seasons the run actually covers, derived from its
   *  episode set. This is what the UI labels (e.g. "第 1/2/3/4 季"); a 全季 run
   *  spans many seasons even though `seasonNumber` is a single anchor value. */
  seasonNumbers: number[];
  status: "queued" | "running";
  /** 1-based position among queued items; null for the running one. */
  queuePosition: number | null;
  /** Aired-but-not-obtained episodes still needed. */
  missingCount: number;
  /** Live agent progress (running only). */
  progress: WorkflowRunProgress | null;
}

/** A recently-finished run. The client session-scopes 已完成 by matching these
 *  against the runIds it observed active (see ActivityView.recentCompleted). */
export interface ActivityCompletedItem {
  workflowRunId: string;
  title: string;
  seasonLabel: string | null;
  status: NotificationReportStatus;
  posterPath: string | null;
  /** "每集 约 410 MB" / "体积 1.4 GB"; null when unknown. */
  sizeText: string | null;
  createdAt: string;
}

export interface ActivityView {
  active: ActivityActiveRun[];
  /** Recently-finished runs (newest first). The CLIENT scopes 已完成 to this
   *  browser session by only showing the ones whose runId it observed active —
   *  robust to notification createdAt timing (which ≈ run-start, not finish). */
  recentCompleted: ActivityCompletedItem[];
}

/**
 * Assemble the activity page view: the live queue+running set, plus the recent
 * completed runs (the client decides which to show in 已完成 by matching against
 * runs it watched go active → done; history lives in 通知).
 */
export async function getActivityView(input: {
  repository: Pick<
    WorkflowRepository,
    "listActiveWorkflowRuns" | "listNotifications" | "listTrackedSeasonStates"
  >;
  /** Scope the queue/notifications to one account (§7). Omitted → default. */
  accountId?: string;
  /** Tree model: scope queue/completed to one drive. Omitted/null → account-wide. */
  connectedStorageId?: string | null;
}): Promise<ActivityView> {
  const scope =
    input.accountId === undefined
      ? undefined
      : { accountId: input.accountId, connectedStorageId: input.connectedStorageId ?? null };
  const activeRuns = await input.repository.listActiveWorkflowRuns(scope);

  // Poster backfill source: older notifications predate report.posterPath, so a
  // completed item can lack a poster. The title is still tracked → source the
  // poster from it (by tmdbId, falling back to title name) so 已完成 shows the
  // real poster instead of the text fallback.
  const trackedStates = await input.repository.listTrackedSeasonStates(scope);
  const posterByTmdb = new Map<number, string>();
  const posterByName = new Map<string, string>();
  for (const state of trackedStates) {
    if (state.title.posterPath) {
      posterByTmdb.set(state.title.tmdbId, state.title.posterPath);
      posterByName.set(state.title.title, state.title.posterPath);
    }
  }

  // Queue positions: oldest-queued is position 1 (FIFO, matching the worker).
  const queuedOrder = activeRuns
    .filter((snapshot) => snapshot.workflowRun.status === "queued")
    .sort((a, b) => a.workflowRun.startedAt.localeCompare(b.workflowRun.startedAt))
    .map((snapshot) => snapshot.workflowRun.id);

  const active: ActivityActiveRun[] = activeRuns.map((snapshot) => {
    const status = snapshot.workflowRun.status === "running" ? "running" : "queued";
    const missingCount = snapshot.episodes.filter(
      (episode) => episode.airStatus === "aired" && !episode.obtained,
    ).length;
    const queueIndex = queuedOrder.indexOf(snapshot.workflowRun.id);
    return {
      runId: snapshot.workflowRun.id,
      tmdbId: snapshot.title.tmdbId,
      title: snapshot.title.title,
      year: snapshot.title.year ?? null,
      type: snapshot.title.type,
      posterPath: snapshot.title.posterPath ?? null,
      seasonNumber: snapshot.season.seasonNumber ?? null,
      seasonNumbers: distinctSeasons(snapshot.episodes),
      status,
      queuePosition: status === "queued" && queueIndex >= 0 ? queueIndex + 1 : null,
      missingCount,
      progress: snapshot.workflowRun.progress ?? null,
    };
  });

  // recentCompleted = recent finished-run notifications (one per run), skipping
  // no-op patrol checks. NO time filter — the client session-scopes by matching
  // against the runIds it observed active (notification createdAt ≈ run-start, so
  // a server-side since filter wrongly drops runs the user opened the page after).
  const notifications = await input.repository.listNotifications({
    limit: 30,
    ...(input.accountId
      ? { accountId: input.accountId, connectedStorageId: input.connectedStorageId ?? null }
      : {}),
  });
  const recentCompleted: ActivityCompletedItem[] = notifications
    .filter(
      (notification) => notification.kind !== "already_current" && notification.report !== undefined,
    )
    .map((notification) => {
      const report = notification.report!;
      const size = landedSize(report);
      const posterPath =
        report.posterPath ??
        (report.tmdbId != null ? posterByTmdb.get(report.tmdbId) : undefined) ??
        posterByName.get(report.titleName) ??
        null;
      return {
        workflowRunId: notification.workflowRunId,
        title: report.titleName,
        seasonLabel: report.seasonLabel,
        status: report.status,
        posterPath,
        sizeText: size ? `${size.label} ${size.value}` : null,
        createdAt: notification.createdAt,
      };
    });

  return { active, recentCompleted };
}
