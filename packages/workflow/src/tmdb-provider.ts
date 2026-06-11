import type {
  LatestAiredSource,
  MediaTitle,
  MediaType,
  TrackedSeason,
} from "./domain.js";

export interface TmdbFetchInit {
  method: "GET";
  headers: Record<string, string>;
}

export type TmdbFetchJson = (url: string, init: TmdbFetchInit) => Promise<unknown>;

export interface TmdbMetadataProviderOptions {
  readToken: string;
  baseURL?: string;
  language?: string;
  fetchJson?: TmdbFetchJson;
}

export interface TvTrackingTargetInput {
  tmdbId: number;
  mediaType: Extract<MediaType, "tv">;
  seasonNumber: number;
  qualityPreference: string;
  storageDirectoryId: string;
  metadataProvider: TmdbMetadataProvider;
}

export interface PreparedTrackingTarget {
  title: MediaTitle;
  season: TrackedSeason;
  keyword: string;
}

interface TmdbTvDetails {
  id: number;
  name: string;
  original_name: string;
  first_air_date: string;
  number_of_episodes: number;
  last_episode_to_air?: {
    season_number?: number;
    episode_number?: number;
  } | null;
  seasons?: Array<{
    season_number?: number;
    episode_count?: number;
  }>;
}

interface TmdbSeasonDetails {
  season_number: number;
  episodes?: Array<{
    episode_number?: number;
    air_date?: string | null;
  }>;
}

export class TmdbMetadataProvider {
  private readonly readToken: string;
  private readonly baseURL: string;
  private readonly language: string;
  private readonly fetchJson: TmdbFetchJson;

  constructor(options: TmdbMetadataProviderOptions) {
    this.readToken = options.readToken;
    this.baseURL = (options.baseURL ?? "https://api.themoviedb.org/3").replace(/\/+$/, "");
    this.language = options.language ?? "zh-CN";
    this.fetchJson = options.fetchJson ?? defaultFetchJson;
  }

  async getTvDetails(tmdbId: number): Promise<TmdbTvDetails> {
    return parseTvDetails(
      await this.get(`tv/${tmdbId}`, {
        language: this.language,
      }),
    );
  }

  async getTvSeason(tmdbId: number, seasonNumber: number): Promise<TmdbSeasonDetails> {
    return parseSeasonDetails(
      await this.get(`tv/${tmdbId}/season/${seasonNumber}`, {
        language: this.language,
      }),
    );
  }

  private async get(path: string, query: Record<string, string>): Promise<unknown> {
    const url = `${this.baseURL}/${path}?${new URLSearchParams(query).toString()}`;
    return this.fetchJson(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.readToken}`,
        "Content-Type": "application/json;charset=utf-8",
      },
    });
  }
}

export function createTmdbMetadataProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TmdbMetadataProvider {
  const readToken = env.TMDB_READ_TOKEN;
  if (!readToken) {
    throw new Error("TMDB_READ_TOKEN is required to create TmdbMetadataProvider");
  }
  return new TmdbMetadataProvider({ readToken });
}

export async function prepareTrackingTarget(input: TvTrackingTargetInput): Promise<PreparedTrackingTarget> {
  const [details, seasonDetails] = await Promise.all([
    input.metadataProvider.getTvDetails(input.tmdbId),
    input.metadataProvider.getTvSeason(input.tmdbId, input.seasonNumber),
  ]);
  const titleId = `tmdb_tv_${details.id}`;
  const title = normalizeTitle(details.name);
  const totalEpisodes = totalEpisodesForSeason(details, seasonDetails, input.seasonNumber);
  const latestAiredEpisode = latestAiredEpisodeForSeason(details, seasonDetails, input.seasonNumber);
  const latestAiredSource: LatestAiredSource = "metadata";

  return {
    title: {
      id: titleId,
      tmdbId: details.id,
      type: "tv",
      title,
      originalTitle: normalizeTitle(details.original_name) || title,
      year: yearFromDate(details.first_air_date),
      aliases: aliasList(title, details.original_name),
    },
    season: {
      id: `${titleId}_s${input.seasonNumber}`,
      mediaTitleId: titleId,
      seasonNumber: input.seasonNumber,
      status: latestAiredEpisode >= totalEpisodes ? "completed" : "active",
      qualityPreference: input.qualityPreference,
      storageDirectoryId: input.storageDirectoryId,
      totalEpisodes,
      latestAiredEpisode,
      latestAiredSource,
    },
    keyword: `${title} ${input.qualityPreference}`.trim(),
  };
}

async function defaultFetchJson(url: string, init: TmdbFetchInit): Promise<unknown> {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
  });
  if (!response.ok) {
    throw new Error(`TMDB request failed with HTTP ${response.status}`);
  }
  return response.json();
}

function parseTvDetails(value: unknown): TmdbTvDetails {
  if (!isRecord(value)) {
    throw new Error("TMDB TV details response must be an object");
  }
  return {
    id: numberValue(value["id"]),
    name: stringValue(value["name"]),
    original_name: stringValue(value["original_name"]),
    first_air_date: stringValue(value["first_air_date"]),
    number_of_episodes: numberValue(value["number_of_episodes"]),
    last_episode_to_air: isRecord(value["last_episode_to_air"])
      ? optionalEpisodePointer(value["last_episode_to_air"])
      : null,
    seasons: Array.isArray(value["seasons"])
      ? value["seasons"].filter(isRecord).map(optionalSeasonSummary)
      : [],
  };
}

function parseSeasonDetails(value: unknown): TmdbSeasonDetails {
  if (!isRecord(value)) {
    throw new Error("TMDB season response must be an object");
  }
  return {
    season_number: numberValue(value["season_number"]),
    episodes: Array.isArray(value["episodes"])
      ? value["episodes"].filter(isRecord).map(optionalSeasonEpisode)
      : [],
  };
}

function optionalEpisodePointer(value: Record<string, unknown>): {
  season_number?: number;
  episode_number?: number;
} {
  const pointer: {
    season_number?: number;
    episode_number?: number;
  } = {};
  const seasonNumber = optionalNumberValue(value["season_number"]);
  if (seasonNumber !== undefined) {
    pointer.season_number = seasonNumber;
  }
  const episodeNumber = optionalNumberValue(value["episode_number"]);
  if (episodeNumber !== undefined) {
    pointer.episode_number = episodeNumber;
  }
  return pointer;
}

function optionalSeasonSummary(value: Record<string, unknown>): {
  season_number?: number;
  episode_count?: number;
} {
  const summary: {
    season_number?: number;
    episode_count?: number;
  } = {};
  const seasonNumber = optionalNumberValue(value["season_number"]);
  if (seasonNumber !== undefined) {
    summary.season_number = seasonNumber;
  }
  const episodeCount = optionalNumberValue(value["episode_count"]);
  if (episodeCount !== undefined) {
    summary.episode_count = episodeCount;
  }
  return summary;
}

function optionalSeasonEpisode(value: Record<string, unknown>): {
  episode_number?: number;
  air_date?: string | null;
} {
  const episode: {
    episode_number?: number;
    air_date?: string | null;
  } = {};
  const episodeNumber = optionalNumberValue(value["episode_number"]);
  if (episodeNumber !== undefined) {
    episode.episode_number = episodeNumber;
  }
  episode.air_date = typeof value["air_date"] === "string" ? value["air_date"] : null;
  return episode;
}

function totalEpisodesForSeason(
  details: TmdbTvDetails,
  seasonDetails: TmdbSeasonDetails,
  seasonNumber: number,
): number {
  const seasonEpisodeCount = details.seasons?.find((season) => season.season_number === seasonNumber)?.episode_count;
  return seasonEpisodeCount ?? seasonDetails.episodes?.length ?? details.number_of_episodes;
}

function latestAiredEpisodeForSeason(
  details: TmdbTvDetails,
  seasonDetails: TmdbSeasonDetails,
  seasonNumber: number,
): number {
  const lastEpisode = details.last_episode_to_air;
  if (lastEpisode?.season_number === seasonNumber && lastEpisode.episode_number !== undefined) {
    return lastEpisode.episode_number;
  }
  return Math.max(
    0,
    ...(seasonDetails.episodes ?? [])
      .filter((episode) => episode.air_date !== null && episode.air_date !== "")
      .map((episode) => episode.episode_number ?? 0),
  );
}

function normalizeTitle(value: string): string {
  return value.trim();
}

function aliasList(title: string, originalTitle: string): string[] {
  const normalizedOriginal = normalizeTitle(originalTitle);
  if (!normalizedOriginal || normalizedOriginal === title) {
    return [];
  }
  return [normalizedOriginal];
}

function yearFromDate(value: string): number {
  const match = /^(\d{4})/.exec(value);
  return match ? Number(match[1]) : 0;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
