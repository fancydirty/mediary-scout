import { normalizeScope, type WorkflowScope } from "./workflow-scope.js";
import {
  DEFAULT_ACCOUNT_ID,
  episodeNumberFromCode,
  type AirStatus,
  type CrossDriveEpisodeOwnership,
  type EpisodeState,
  type MetadataStatus,
} from "./domain.js";
import type { WorkflowRepository } from "./repository.js";

export type EpisodeDisplayState = "obtained" | "provider_ahead" | "missing_aired" | "unaired" | "unknown";

export interface EpisodeStatusCell {
  episodeCode: string;
  airStatus: AirStatus;
  obtained: boolean;
  metadataStatus: MetadataStatus;
  verifiedFileCount: number;
  displayState: EpisodeDisplayState;
  /** Connected drives holding a copy of this episode (populated when reading cross-drive union). */
  drives?: CrossDriveEpisodeOwnership["drives"];
}

export interface TrackedSeasonStatusView {
  titleId: string;
  title: string;
  trackedSeasonId: string;
  seasonNumber: number;
  totalEpisodes: number;
  latestAiredEpisode: number;
  obtainedEpisodes: string[];
  missingAiredEpisodes: string[];
  providerAheadEpisodes: string[];
  obtainedCount: number;
  missingAiredCount: number;
  episodes: EpisodeStatusCell[];
}

export async function getTrackedSeasonStatusView(input: {
  repository: WorkflowRepository;
  trackedSeasonId: string;
  /** Legacy account-only scope (no drive filter). Prefer `scope`. */
  accountId?: string;
  /** Full (account, drive) scope — deliberately NOT `ScopeArg`, so a bare
   *  accountId string cannot be passed here and silently drop the drive filter.
   *  The same season can be tracked on several drives with different episode
   *  states; an unscoped lookup returns an arbitrary drive's copy (Postgres:
   *  first row; in-memory: latest run across drives) — the 123 醒来 detail page
   *  showed the 115 copy's 0/22 while the card correctly said 21/22. Callers
   *  rendering a specific workspace MUST pass its connectedStorageId. */
  scope?: WorkflowScope;
}): Promise<TrackedSeasonStatusView | null> {
  const state = await input.repository.getTrackedSeasonState(
    input.trackedSeasonId,
    input.scope ?? input.accountId,
  );
  if (!state) {
    return null;
  }

  const normalized = normalizeScope(input.scope ?? input.accountId);
  let episodes = [...state.episodes];
  const driveMap = new Map<string, CrossDriveEpisodeOwnership["drives"]>();

  // When no specific drive is pinned (`connectedStorageId === null`), compute the
  // cross-drive union across all drives of the account so an episode obtained on
  // any connected drive counts as obtained and carries its drive ownership list.
  if (normalized.connectedStorageId === null && input.repository.obtainedEpisodesForSeason) {
    const union = await input.repository.obtainedEpisodesForSeason(
      input.trackedSeasonId,
      normalized.accountId ?? DEFAULT_ACCOUNT_ID,
    );
    const byCode = new Map(episodes.map((e) => [e.episodeCode, { ...e }]));
    for (const row of union) {
      driveMap.set(row.episodeCode, row.drives);
      const existing = byCode.get(row.episodeCode);
      if (existing) {
        if (row.obtained) {
          existing.obtained = true;
          if (existing.verifiedFileIds.length === 0) {
            existing.verifiedFileIds = row.drives.flatMap((d) => d.fileIds);
          }
          if (row.metadataStatus === "provider_ahead") {
            existing.metadataStatus = "provider_ahead";
          }
        }
      } else if (row.obtained) {
        byCode.set(row.episodeCode, {
          trackedSeasonId: input.trackedSeasonId,
          episodeCode: row.episodeCode,
          airDate: null,
          title: row.episodeCode,
          airStatus: row.metadataStatus === "provider_ahead" ? "unknown" : "aired",
          obtained: true,
          metadataStatus: row.metadataStatus,
          verifiedFileIds: row.drives.flatMap((d) => d.fileIds),
        });
      }
    }
    episodes = [...byCode.values()];
  } else if (normalized.connectedStorageId !== null) {
    const copies = input.repository.listEpisodeCopies
      ? await input.repository.listEpisodeCopies(input.trackedSeasonId)
      : [];
    const copyByCode = new Map(
      copies
        .filter((c) => c.storageId === normalized.connectedStorageId)
        .map((c) => [c.episodeCode, c]),
    );
    for (const ep of episodes) {
      if (ep.obtained) {
        const copy = copyByCode.get(ep.episodeCode);
        driveMap.set(ep.episodeCode, [
          {
            storageId: normalized.connectedStorageId,
            fileIds: copy && copy.fileIds.length > 0 ? [...copy.fileIds] : [...ep.verifiedFileIds],
            sizeBytes: copy?.sizeBytes ?? null,
            quality: copy?.quality ?? null,
          },
        ]);
      }
    }
  }

  episodes.sort((a, b) => episodeNumberFromCode(a.episodeCode) - episodeNumberFromCode(b.episodeCode));
  const cells = episodes.map((ep) => {
    const cell = toEpisodeStatusCell(ep);
    const drives = driveMap.get(ep.episodeCode);
    return drives && drives.length > 0 ? { ...cell, drives } : cell;
  });
  const obtainedEpisodes = cells
    .filter((episode) => episode.obtained)
    .map((episode) => episode.episodeCode);
  const missingAiredEpisodes = cells
    .filter((episode) => episode.displayState === "missing_aired")
    .map((episode) => episode.episodeCode);
  const providerAheadEpisodes = cells
    .filter((episode) => episode.displayState === "provider_ahead")
    .map((episode) => episode.episodeCode);

  return {
    titleId: state.title.id,
    title: state.title.title,
    trackedSeasonId: state.season.id,
    seasonNumber: state.season.seasonNumber,
    totalEpisodes: state.season.totalEpisodes,
    latestAiredEpisode: state.season.latestAiredEpisode,
    obtainedEpisodes,
    missingAiredEpisodes,
    providerAheadEpisodes,
    obtainedCount: obtainedEpisodes.length,
    missingAiredCount: missingAiredEpisodes.length,
    episodes: cells,
  };
}

function toEpisodeStatusCell(episode: EpisodeState): EpisodeStatusCell {
  return {
    episodeCode: episode.episodeCode,
    airStatus: episode.airStatus,
    obtained: episode.obtained,
    metadataStatus: episode.metadataStatus,
    verifiedFileCount: episode.verifiedFileIds.length,
    displayState: displayStateForEpisode(episode),
  };
}

function displayStateForEpisode(episode: EpisodeState): EpisodeDisplayState {
  if (episode.obtained && episode.metadataStatus === "provider_ahead") {
    return "provider_ahead";
  }
  if (episode.obtained) {
    return "obtained";
  }
  if (episode.airStatus === "aired") {
    return "missing_aired";
  }
  if (episode.airStatus === "unaired") {
    return "unaired";
  }
  return "unknown";
}
