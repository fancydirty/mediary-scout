import { importForeignWorkAsMovie } from "./commands.js";
import {
  createEpisodeStates,
  movieAnchorSeason,
  type AcquisitionFailureEvidence,
  type AgentDecision,
  type AuditEvent,
  type EpisodeState,
  type MediaTitle,
  type NotificationEvent,
  type ResourceSnapshot,
  type TrackedSeason,
  type TransferAttempt,
  type WorkflowStatus,
} from "./domain.js";
import { validateMoviePlan } from "./movie-plan-validation.js";
import { buildMovieReport, dominantQuality, formatReportPushText } from "./notification-report.js";
import type { AgentNodes, ResourceProvider, StorageExecutor } from "./ports.js";

const VIDEO_EXTENSION = /\.(mkv|mp4|avi|mov|ts|m2ts|wmv|flv|webm|rmvb|iso)$/i;
const DEFAULT_MAX_MOVIE_PASSES = 4;
/** The movie's single synthetic episode (movie = one-episode season anchor). */
const MOVIE_EPISODE = "S01E01";

function defaultNowIso(): string {
  return new Date().toISOString();
}

export interface MovieWorkflowResult {
  status: WorkflowStatus;
  title: MediaTitle;
  season: TrackedSeason;
  episodes: EpisodeState[];
  resourceSnapshots: ResourceSnapshot[];
  transferAttempts: TransferAttempt[];
  decisions: AgentDecision[];
  notification: NotificationEvent;
  notifications: NotificationEvent[];
  auditEvents: AuditEvent[];
}

/**
 * Movie acquisition (Type 1, one-off — no tracking). Evidence-first: the agent
 * confirms identity (anti-remake) and picks ONE film, then the deterministic
 * harness transfers it (115 share OR magnet — both land immediately) and places
 * the single video under `Movies/Title (Year)/Title (Year).ext`.
 *
 * Transfers genuinely fail (a 115 share can be expired/cancelled or its
 * password mismatched). On failure the harness does NOT give up: it hands the
 * agent that failure evidence and re-plans, so the agent picks the next-best
 * covering candidate, up to maxPasses. Honest no_coverage only when nothing
 * covering remains.
 */
export async function runMovieAcquisition(input: {
  title: MediaTitle;
  keyword: string;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  agents: AgentNodes;
  workflowRunId?: string;
  stagingParentDirectoryId: string;
  moviesParentDirectoryId: string;
  maxPasses?: number;
  now?: () => string;
}): Promise<MovieWorkflowResult> {
  const workflowRunId = input.workflowRunId ?? "run_movie";
  const now = input.now ?? defaultNowIso;
  const maxPasses = input.maxPasses ?? DEFAULT_MAX_MOVIE_PASSES;
  const auditEvents: AuditEvent[] = [];
  const resourceSnapshots: ResourceSnapshot[] = [];
  const transferAttempts: TransferAttempt[] = [];
  const failureEvidence: AcquisitionFailureEvidence[] = [];
  const stagingDirectoryIds: string[] = [];

  const anchor = (storageDirectoryId: string): { season: TrackedSeason; episodes: EpisodeState[] } => {
    const season = movieAnchorSeason({
      titleId: input.title.id,
      qualityPreference: "4K",
      storageDirectoryId,
    });
    return {
      season,
      episodes: createEpisodeStates({
        trackedSeasonId: season.id,
        seasonNumber: 1,
        totalEpisodes: 1,
        latestAiredEpisode: 1,
      }),
    };
  };

  const finish = async (input2: {
    status: WorkflowStatus;
    kind: string;
    storageDirectoryId: string;
    obtained: boolean;
    reportLines?: string[];
    reportStatus?: "acquired" | "no_coverage";
    quality?: string;
  }): Promise<MovieWorkflowResult> => {
    // The chosen video has already been moved into Movies/Title (Year); every
    // staging dir now holds only junk (samples, the wrapping folder, unchosen
    // lower-quality dupes). Remove them so the library parent stays clean and we
    // don't hoard duplicates. Best-effort — never fail acquisition over cleanup.
    for (const stagingId of stagingDirectoryIds) {
      try {
        await input.storage.removeDirectory(stagingId);
      } catch {
        // ignore — cleanup is best-effort
      }
    }
    const { season, episodes } = anchor(input2.storageDirectoryId);
    const finalEpisodes = episodes.map((episode) => ({ ...episode, obtained: input2.obtained }));
    const baseReport = buildMovieReport(input.title.title, input2.quality);
    const report =
      input2.reportStatus === "no_coverage"
        ? { ...baseReport, status: "no_coverage" as const, lines: input2.reportLines ?? baseReport.lines }
        : baseReport;
    const notification: NotificationEvent = {
      id: `notification_${workflowRunId}`,
      workflowRunId,
      kind: input2.kind,
      title: input.title.title,
      body: formatReportPushText(report),
      createdAt: now(),
      trigger: "user",
      report,
    };
    return {
      status: input2.status,
      title: input.title,
      season,
      episodes: finalEpisodes,
      resourceSnapshots,
      transferAttempts,
      decisions: [],
      notification,
      notifications: [notification],
      auditEvents,
    };
  };

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const planning = await input.agents.planMovieAcquisition({
      title: input.title.title,
      aliases: input.title.aliases,
      year: input.title.year,
      qualityPreference: "4K",
      initialKeyword: input.keyword,
      failureEvidence,
      searchResources: async ({ keyword }) => input.resourceProvider.search({ keyword }),
    });
    for (const snapshot of planning.snapshots) {
      if (!resourceSnapshots.some((existing) => existing.id === snapshot.id)) {
        resourceSnapshots.push(snapshot);
      }
    }

    const validated = validateMoviePlan({ plan: planning.plan, snapshots: planning.snapshots });
    if (validated.selectedCandidate === null) {
      // The agent found nothing covering this pass — stop and report honestly.
      auditEvents.push({
        type: "acquisition_no_coverage",
        message: `No covering movie resource for ${input.title.title} (pass ${pass + 1})`,
      });
      return await finish({
        status: "no_coverage",
        kind: "no_coverage",
        storageDirectoryId: "",
        obtained: false,
        reportStatus: "no_coverage",
        reportLines: ["暂未找到可用资源 · 将持续尝试"],
      });
    }
    const candidate = validated.selectedCandidate;

    const stagingDirectoryId = await input.storage.createDirectory({
      name: `staging-${workflowRunId}-movie-p${pass + 1}`,
      parentId: input.stagingParentDirectoryId,
    });
    stagingDirectoryIds.push(stagingDirectoryId);
    const attempt = await input.storage.transfer({
      workflowRunId,
      directoryId: stagingDirectoryId,
      candidate,
    });
    transferAttempts.push(attempt);

    const tree = await input.storage.listTree({ directoryId: stagingDirectoryId });
    const videos = tree
      .filter((file) => VIDEO_EXTENSION.test(file.path) && !/sample/i.test(file.path))
      .sort((left, right) => right.sizeBytes - left.sizeBytes);

    if (videos.length === 0) {
      // Transfer failed (expired/cancelled share, wrong password, dead magnet).
      // Record evidence and let the next pass pick a different covering resource.
      failureEvidence.push({
        candidateId: candidate.id,
        candidateTitle: candidate.title,
        transferStatus: attempt.status,
        providerMessage: attempt.providerMessage,
        episodesStillMissing: [MOVIE_EPISODE],
      });
      auditEvents.push({
        type: "acquisition_pass_incomplete",
        message: `Movie transfer pass ${pass + 1} did not materialize a video (${attempt.providerMessage || attempt.status})`,
        data: { candidateId: candidate.id, candidateTitle: candidate.title, status: attempt.status },
      });
      continue;
    }

    // A resource may flatten into several videos (feature + 花絮/特典/版本/sample).
    // Exactly one is the film. "Largest" is a poor proxy, so when there is more
    // than one, the AGENT picks the main feature at the best quality; the
    // workflow keeps that file and DELETES the rest (no leftover junk, no
    // wasted space — converge on a single highest-quality master).
    let master = videos[0]!;
    let extras: string[] = [];
    let masterReason = "";
    if (videos.length > 1) {
      const selection = await input.agents.selectMovieMasterFile({
        title: input.title.title,
        year: input.title.year,
        candidates: videos.map((video) => ({
          providerFileId: video.providerFileId,
          name: video.path,
          sizeBytes: video.sizeBytes,
        })),
      });
      const chosen = videos.find((video) => video.providerFileId === selection.keepFileId);
      // Degrade gracefully if the agent returns an id not among the staged
      // videos (hallucination/typo): keep the largest rather than aborting an
      // acquisition whose resource DID transfer.
      master = chosen ?? videos[0]!;
      masterReason = chosen ? selection.reason : `selection id not staged; kept largest`;
      extras = videos.filter((video) => video.providerFileId !== master.providerFileId).map((v) => v.providerFileId);
    }

    const masterQuality = dominantQuality([master.path]);
    // Import (move the master OUT of staging) FIRST, then prune extras — so a
    // failed import never deletes extras and orphans the master.
    const imported = await importForeignWorkAsMovie({
      storage: input.storage,
      providerFileIds: [master.providerFileId],
      movieTitle: input.title.title,
      year: input.title.year,
      moviesParentDirectoryId: input.moviesParentDirectoryId,
    });
    if (extras.length > 0) {
      await input.storage.deleteFiles({ directoryId: stagingDirectoryId, fileIds: extras });
      auditEvents.push({
        type: "movie_master_selected",
        message: `Kept main feature (${masterReason}); deleted ${extras.length} extra file(s)`,
        data: { keepFileId: master.providerFileId, deletedFileIds: extras, reason: masterReason },
      });
    }
    auditEvents.push({
      type: "movie_landed",
      message: `${input.title.title} (${input.title.year}) landed`,
      data: { movieDirectoryId: imported.movieDirectoryId, movedFileIds: imported.movedFileIds },
    });
    return await finish({
      status: "succeeded",
      kind: "package_initialized",
      storageDirectoryId: imported.movieDirectoryId,
      obtained: true,
      ...(masterQuality ? { quality: masterQuality } : {}),
    });
  }

  // Every pass's selection failed to materialize.
  auditEvents.push({
    type: "acquisition_no_coverage",
    message: `All ${maxPasses} movie acquisition passes failed for ${input.title.title}`,
  });
  return await finish({
    status: "no_coverage",
    kind: "no_coverage",
    storageDirectoryId: "",
    obtained: false,
    reportStatus: "no_coverage",
    reportLines: ["资源转存均未落地 · 将持续尝试"],
  });
}
