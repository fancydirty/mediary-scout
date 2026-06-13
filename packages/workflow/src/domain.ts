export type MediaType = "movie" | "tv" | "anime";
export type SeasonStatus = "active" | "completed";
export type LatestAiredSource = "metadata" | "manual" | "unknown";
export type AirStatus = "aired" | "unaired" | "unknown";
export type MetadataStatus = "confirmed" | "provider_ahead" | "storage_only";
export type WorkflowKind = "type1_package_init" | "type2_init" | "type3_monitor" | "movie_init";
export type WorkflowStatus = "queued" | "running" | "succeeded" | "failed" | "partial" | "no_coverage";
export type ResourceType = "115" | "magnet" | "manual";
export type TransferStatus = "succeeded" | "failed" | "no_target_change";
export type Confidence = "low" | "medium" | "high";

export interface MediaTitle {
  id: string;
  tmdbId: number;
  type: MediaType;
  title: string;
  originalTitle: string;
  year: number;
  aliases: string[];
  /** Scraped artwork/metadata — durable product state, read straight from the DB. */
  posterPath?: string | null;
  backdropPath?: string | null;
  overview?: string;
}

export interface TrackedSeason {
  id: string;
  mediaTitleId: string;
  seasonNumber: number;
  status: SeasonStatus;
  qualityPreference: string;
  storageDirectoryId: string;
  totalEpisodes: number;
  latestAiredEpisode: number;
  latestAiredSource: LatestAiredSource;
}

export interface EpisodeState {
  trackedSeasonId: string;
  episodeCode: string;
  airDate: string | null;
  title: string;
  airStatus: AirStatus;
  obtained: boolean;
  metadataStatus: MetadataStatus;
  verifiedFileIds: string[];
}

export interface WorkflowRun {
  id: string;
  kind: WorkflowKind;
  status: WorkflowStatus;
  trackedSeasonId: string;
  startedAt: string;
  finishedAt: string | null;
  auditEvents: AuditEvent[];
}

export interface AuditEvent {
  type: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface ResourceCandidate {
  id: string;
  snapshotId: string;
  index: number;
  title: string;
  type: ResourceType;
  source: string;
  episodeHints: string[];
  qualityHints: string[];
  providerPayload: Record<string, unknown>;
}

export interface ResourceSnapshot {
  id: string;
  provider: string;
  keyword: string;
  candidates: ResourceCandidate[];
  createdAt: string;
}

export interface AgentDecision {
  node: string;
  snapshotId: string;
  selectedCandidateIds: string[];
  episodeMapping: Record<string, string[]>;
  providerAheadEpisodeMapping: Record<string, string[]>;
  rejectedCandidateIds: string[];
  confidence: Confidence;
  reason: string;
}

export type CandidateDispositionKind = "selected" | "rejected" | "uncertain";

export interface CandidateDisposition {
  candidateId: string;
  disposition: CandidateDispositionKind;
  /** Episode codes this candidate covers; required non-empty for "selected". */
  episodes: string[];
  reason: string;
}

export interface AcquisitionPlan {
  node: string;
  /** Snapshot id observed in this planning run, or null when nothing covers the need. */
  selectedSnapshotId: string | null;
  searchedKeywords: string[];
  candidateDispositions: CandidateDisposition[];
  confidence: Confidence;
  reason: string;
}

export interface AcquisitionFailureEvidence {
  candidateId: string;
  candidateTitle: string;
  transferStatus: TransferStatus;
  providerMessage: string;
  episodesStillMissing: string[];
}

export interface TransferAttempt {
  id: string;
  workflowRunId: string;
  candidateId: string;
  status: TransferStatus;
  providerMessage: string;
  materializedFileIds: string[];
}

export interface VerifiedFile {
  id: string;
  storageDirectoryId: string;
  name: string;
  sizeBytes: number;
  /**
   * The parsed episode code, or null for videos whose name exposes none (e.g.
   * movies). A file is a video by virtue of its media EXTENSION; the episode
   * code is optional metadata layered on top — TV coverage/dedup ignore nulls.
   */
  episodeCode: string | null;
  providerFileId: string;
}

/** Where a notification's run was triggered from — drives feed grouping. */
export type NotificationTrigger = "user" | "scheduled";

/**
 * Semantic state of an acquisition, surfaced to the user without the internal
 * Type 1/2/3 taxonomy. Crucially, `partial` means an AIRED episode is still
 * missing — unaired episodes never make a report look incomplete.
 */
export type NotificationReportStatus =
  | "complete" // completed series/season, fully obtained — graduated, no longer tracking
  | "acquired" // movie / one-off fully acquired
  | "airing" // still airing; obtained up to the latest aired episode, future auto-tracked
  | "partial" // a genuine aired gap remains
  | "no_coverage"; // nothing found yet

/**
 * Structured acquisition report. The single source of wording: the web feed
 * renders it as native UI (status pill + chips) and the push channels render it
 * as emoji text — both are pure functions of this object.
 */
export interface NotificationReport {
  titleName: string;
  /** "第 1 季" for a single season; null for a whole-series rollup or a movie. */
  seasonLabel: string | null;
  status: NotificationReportStatus;
  /** 1–2 concise summary lines, e.g. ["已获取至最新第 12 集 · 后续更新自动追踪"]. */
  lines: string[];
  /** Episodes obtained THIS run (the daily-sweep additions). */
  newlyObtained: string[];
  /** Aired-but-not-obtained genuine gaps. Never includes unaired episodes. */
  realMissing: string[];
  /** Dominant quality of what actually landed (e.g. "2160p"), for richer pushes. */
  quality?: string;
}

export interface NotificationEvent {
  id: string;
  workflowRunId: string;
  kind: string;
  title: string;
  body: string;
  createdAt: string;
  /** Absent on legacy/foreign-work events; generators set it going forward. */
  trigger?: NotificationTrigger;
  report?: NotificationReport;
}

export function episodeCode(seasonNumber: number, episodeNumber: number): string {
  return `S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}`;
}

export function episodeNumberFromCode(code: string): number {
  const match = /^S\d{2}E(\d{2,})$/.exec(code);
  if (!match) {
    throw new Error(`Invalid episode code: ${code}`);
  }
  return Number(match[1]);
}

export function episodePartsFromCode(code: string): { seasonNumber: number; episodeNumber: number } {
  const match = /^S(\d{2,})E(\d{2,})$/.exec(code);
  if (!match) {
    throw new Error(`Invalid episode code: ${code}`);
  }
  return {
    seasonNumber: Number(match[1]),
    episodeNumber: Number(match[2]),
  };
}

/**
 * A movie persists as a degenerate single-"episode" season anchor so it reuses
 * the whole tracked-season machinery (repository, library wall, notifications)
 * with no parallel type system. The user never sees the anchor — only "已入库".
 * status is `completed` (no monitoring) and there is no real airing concept.
 */
export function movieAnchorSeason(input: {
  titleId: string;
  qualityPreference: string;
  storageDirectoryId: string;
}): TrackedSeason {
  return {
    id: `${input.titleId}_movie`,
    mediaTitleId: input.titleId,
    seasonNumber: 1,
    status: "completed",
    qualityPreference: input.qualityPreference,
    storageDirectoryId: input.storageDirectoryId,
    totalEpisodes: 1,
    latestAiredEpisode: 1,
    latestAiredSource: "manual",
  };
}

export function createEpisodeStates(input: {
  trackedSeasonId: string;
  seasonNumber: number;
  totalEpisodes: number;
  latestAiredEpisode: number;
}): EpisodeState[] {
  return Array.from({ length: input.totalEpisodes }, (_, index) => {
    const episodeNumber = index + 1;
    return {
      trackedSeasonId: input.trackedSeasonId,
      episodeCode: episodeCode(input.seasonNumber, episodeNumber),
      airDate: null,
      title: `Episode ${episodeNumber}`,
      airStatus: episodeNumber <= input.latestAiredEpisode ? "aired" : "unaired",
      obtained: false,
      metadataStatus: "confirmed",
      verifiedFileIds: [],
    };
  });
}

export function reconcileVerifiedFiles(input: {
  season: TrackedSeason;
  episodes: EpisodeState[];
  files: VerifiedFile[];
}): EpisodeState[] {
  const byCode = new Map(input.episodes.map((episode) => [episode.episodeCode, { ...episode }]));

  for (const file of input.files) {
    if (file.storageDirectoryId !== input.season.storageDirectoryId) {
      continue;
    }
    // Episode-less videos (movies, unparsed names) are real files but cannot map
    // to a TV episode — coverage tracking ignores them.
    if (file.episodeCode === null) {
      continue;
    }

    const existing = byCode.get(file.episodeCode);
    const episodeNumber = episodeNumberFromCode(file.episodeCode);
    const metadataStatus: MetadataStatus =
      existing?.metadataStatus ?? (episodeNumber > input.season.latestAiredEpisode ? "provider_ahead" : "storage_only");
    const next: EpisodeState = existing ?? {
      trackedSeasonId: input.season.id,
      episodeCode: file.episodeCode,
      airDate: null,
      title: file.episodeCode,
      airStatus: episodeNumber <= input.season.latestAiredEpisode ? "aired" : "unknown",
      obtained: false,
      metadataStatus,
      verifiedFileIds: [],
    };

    byCode.set(file.episodeCode, {
      ...next,
      obtained: true,
      metadataStatus: episodeNumber > input.season.latestAiredEpisode ? "provider_ahead" : next.metadataStatus,
      verifiedFileIds: Array.from(new Set([...next.verifiedFileIds, file.id])),
    });
  }

  return Array.from(byCode.values()).sort((a, b) => {
    const aParts = episodePartsFromCode(a.episodeCode);
    const bParts = episodePartsFromCode(b.episodeCode);
    return aParts.seasonNumber - bParts.seasonNumber || aParts.episodeNumber - bParts.episodeNumber;
  });
}
