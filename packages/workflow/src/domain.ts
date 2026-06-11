export type MediaType = "movie" | "tv" | "anime";
export type SeasonStatus = "active" | "completed";
export type LatestAiredSource = "metadata" | "manual" | "unknown";
export type AirStatus = "aired" | "unaired" | "unknown";
export type MetadataStatus = "confirmed" | "provider_ahead" | "storage_only";
export type WorkflowKind = "type2_init" | "type3_monitor";
export type WorkflowStatus = "queued" | "running" | "succeeded" | "failed" | "partial";
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
  episodeCode: string;
  providerFileId: string;
}

export interface NotificationEvent {
  id: string;
  workflowRunId: string;
  kind: string;
  title: string;
  body: string;
  createdAt: string;
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

function episodePartsFromCode(code: string): { seasonNumber: number; episodeNumber: number } {
  const match = /^S(\d{2,})E(\d{2,})$/.exec(code);
  if (!match) {
    throw new Error(`Invalid episode code: ${code}`);
  }
  return {
    seasonNumber: Number(match[1]),
    episodeNumber: Number(match[2]),
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
