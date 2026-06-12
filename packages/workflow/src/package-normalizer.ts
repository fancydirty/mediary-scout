import { episodeCode, type Confidence } from "./domain.js";

export type PackageCoverage =
  | "movie"
  | "single_episode"
  | "episode_range"
  | "single_season"
  | "multi_season_package"
  | "complete_series_package"
  | "unknown";

export type PackageRejectReason = "missing_season" | "missing_episode" | "duplicate_episode";

export interface PackageTreeFile {
  path: string;
  providerFileId: string;
  sizeBytes: number;
}

export interface PackageNormalizationInput {
  title: string;
  year: number;
  files: PackageTreeFile[];
  totalSeasons?: number;
  recognitionMappings?: PackageRecognitionFileMapping[];
}

export interface PackageMoveAction {
  sourcePath: string;
  providerFileId: string;
  sizeBytes: number;
  episodeCode: string;
  targetSeasonNumber: number;
  targetEpisodeNumber: number;
  targetRelativePath: string;
  confidence: Confidence;
  evidence: string[];
}

export interface PackageRejectedFile {
  sourcePath: string;
  providerFileId: string;
  reason: PackageRejectReason;
  message: string;
}

export interface PackageNormalizationPlan {
  coverage: PackageCoverage;
  confidence: Confidence;
  actions: PackageMoveAction[];
  rejectedFiles: PackageRejectedFile[];
  warnings: string[];
}

export interface PackageRecognitionFileEvidence {
  providerFileId: string;
  path: string;
  parsedSeasonNumber: number | null;
  parsedEpisodeNumber: number | null;
  confidence: Confidence;
  evidence: string[];
}

export interface PackageRecognitionInput {
  title: string;
  year: number;
  files: PackageTreeFile[];
  parserEvidence: PackageRecognitionFileEvidence[];
}

export interface PackageRecognitionFileMapping {
  providerFileId: string;
  seasonNumber: number;
  episodeNumber: number;
  confidence: Confidence;
  reason: string;
}

export interface PackageRecognitionDecision {
  node?: string;
  fileMappings: PackageRecognitionFileMapping[];
  rejectedProviderFileIds: string[];
  confidence: Confidence;
  reason: string;
}

export interface PackageRecognitionAgent {
  recognizePackage(input: PackageRecognitionInput): Promise<PackageRecognitionDecision>;
}

interface ParsedPackageFile {
  file: PackageTreeFile;
  seasonNumber: number | null;
  episodeNumber: number | null;
  confidence: Confidence;
  evidence: string[];
}

const VIDEO_EXTENSIONS = new Set(["avi", "m2ts", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "ts", "webm", "wmv"]);

export async function buildAgentAssistedPackageNormalizationPlan(
  input: PackageNormalizationInput & { agents: PackageRecognitionAgent },
): Promise<PackageNormalizationPlan> {
  const deterministicPlan = buildPackageNormalizationPlan(input);
  if (deterministicPlan.confidence !== "low") {
    return deterministicPlan;
  }

  const parserEvidence = collectParserEvidence(input);
  const decision = await input.agents.recognizePackage({
    title: input.title,
    year: input.year,
    files: input.files,
    parserEvidence,
  });

  if (decision.confidence === "low" || decision.fileMappings.length === 0) {
    return {
      ...deterministicPlan,
      warnings: [
        ...deterministicPlan.warnings,
        `agent package recognition did not produce a usable mapping: ${decision.reason}`,
      ],
    };
  }

  const knownProviderFileIds = new Set(input.files.map((file) => file.providerFileId));
  const unknownProviderFileIds = decision.fileMappings
    .map((mapping) => mapping.providerFileId)
    .filter((providerFileId) => !knownProviderFileIds.has(providerFileId));
  if (unknownProviderFileIds.length > 0) {
    return {
      ...deterministicPlan,
      warnings: [
        ...deterministicPlan.warnings,
        `agent package recognition referenced unknown files: ${unknownProviderFileIds.join(", ")}`,
      ],
    };
  }

  return buildPackageNormalizationPlan({
    ...input,
    recognitionMappings: decision.fileMappings,
  });
}

export function buildPackageNormalizationPlan(input: PackageNormalizationInput): PackageNormalizationPlan {
  const recognitionMappings = new Map(
    (input.recognitionMappings ?? []).map((mapping) => [mapping.providerFileId, mapping]),
  );
  const parsedFiles = input.files.filter(isVideoFile).map((file) => parsePackageFile(file, recognitionMappings));
  const incompleteFiles = parsedFiles.filter(
    (file) => file.seasonNumber === null || file.episodeNumber === null,
  );
  const completeFiles = parsedFiles.filter(
    (file): file is ParsedPackageFile & { seasonNumber: number; episodeNumber: number } =>
      file.seasonNumber !== null && file.episodeNumber !== null,
  );
  const duplicateEpisodeCodes = findDuplicateEpisodeCodes(completeFiles);

  if (duplicateEpisodeCodes.size > 0) {
    return {
      coverage: "unknown",
      confidence: "low",
      actions: [],
      rejectedFiles: [
        ...completeFiles
          .filter((file) => duplicateEpisodeCodes.has(episodeCode(file.seasonNumber, file.episodeNumber)))
          .map((file) => rejectedFile(file, "duplicate_episode")),
        ...incompleteFiles.map((file) => rejectedFile(file, missingReason(file))),
      ],
      warnings: ["duplicate episode mappings require a safer choice before package normalization"],
    };
  }

  const rejectedFiles = incompleteFiles.map((file) => rejectedFile(file, missingReason(file)));
  const actions = completeFiles
    .map((file) => toMoveAction(input, file))
    .sort((left, right) => {
      return (
        left.targetSeasonNumber - right.targetSeasonNumber ||
        left.targetEpisodeNumber - right.targetEpisodeNumber ||
        left.sourcePath.localeCompare(right.sourcePath)
      );
    });

  // Unmapped video files do NOT block the cleanly parsed ones: real packs
  // legitimately contain documentaries, bundled movies, and extras that must
  // stay in staging as rejected files. Low confidence keeps the agent
  // recognition pass in the loop so misnamed episodes get a chance to be
  // mapped; whatever the agent does not claim remains rejected, never moved.
  // (Duplicate episode mappings still fail closed above — a duplicate may be
  // a parser misidentification and needs agent resolution before any action.)
  return {
    coverage: rejectedFiles.length > 0 ? "unknown" : classifyCoverage(actions, input.totalSeasons),
    confidence: rejectedFiles.length > 0 ? "low" : planConfidence(actions, rejectedFiles),
    actions,
    rejectedFiles,
    warnings: rejectedFiles.length > 0 ? ["some video files could not be mapped to season/episode identity"] : [],
  };
}

function collectParserEvidence(input: PackageNormalizationInput): PackageRecognitionFileEvidence[] {
  return input.files.filter(isVideoFile).map((file) => {
    const parsed = parsePackageFile(file, new Map());
    return {
      providerFileId: file.providerFileId,
      path: file.path,
      parsedSeasonNumber: parsed.seasonNumber,
      parsedEpisodeNumber: parsed.episodeNumber,
      confidence: parsed.confidence,
      evidence: parsed.evidence,
    };
  });
}

function parsePackageFile(
  file: PackageTreeFile,
  recognitionMappings: Map<string, PackageRecognitionFileMapping>,
): ParsedPackageFile {
  const recognitionMapping = recognitionMappings.get(file.providerFileId);
  if (recognitionMapping !== undefined) {
    return {
      file,
      seasonNumber: positiveIntegerOrNull(recognitionMapping.seasonNumber),
      episodeNumber: positiveIntegerOrNull(recognitionMapping.episodeNumber),
      confidence: recognitionMapping.confidence,
      evidence: ["agent_package_recognition", recognitionMapping.reason],
    };
  }

  const pathSegments = file.path.split(/[\\/]+/).filter(Boolean);
  const fileName = pathSegments.at(-1) ?? file.path;
  const parentSegments = pathSegments.slice(0, -1).reverse();
  const fromFileName = parseSeasonEpisode(fileName);
  const parentSeason = firstNumber(parentSegments.map(parseSeasonNumber));
  const episodeOnly = parseEpisodeNumber(fileName);
  const seasonNumber = fromFileName?.seasonNumber ?? parentSeason;
  const episodeNumber = fromFileName?.episodeNumber ?? episodeOnly;
  const evidence: string[] = [];

  if (fromFileName) {
    evidence.push("filename_season_episode");
  }
  if (!fromFileName && parentSeason !== null) {
    evidence.push("parent_season");
  }
  if (!fromFileName && episodeOnly !== null) {
    evidence.push("filename_episode");
  }

  return {
    file,
    seasonNumber,
    episodeNumber,
    confidence: fromFileName ? "high" : "medium",
    evidence,
  };
}

function parseSeasonEpisode(value: string): { seasonNumber: number; episodeNumber: number } | null {
  const sxe = /(?:^|[^\dA-Za-z])S(\d{1,2})[ ._-]*E(\d{1,3})(?:[^\dA-Za-z]|$)/i.exec(value);
  if (sxe?.[1] && sxe[2]) {
    return { seasonNumber: Number(sxe[1]), episodeNumber: Number(sxe[2]) };
  }

  const oneX = /(?:^|[^\dA-Za-z])(\d{1,2})x(\d{1,3})(?:[^\dA-Za-z]|$)/i.exec(value);
  if (oneX?.[1] && oneX[2]) {
    return { seasonNumber: Number(oneX[1]), episodeNumber: Number(oneX[2]) };
  }

  return null;
}

function parseSeasonNumber(value: string): number | null {
  const seasonWord = /Season[ ._-]*(\d{1,2})/i.exec(value);
  if (seasonWord?.[1]) {
    return Number(seasonWord[1]);
  }

  const compactSeason = /(?:^|[^\dA-Za-z])S(\d{1,2})(?:[^\dA-Za-z]|$)/i.exec(value);
  if (compactSeason?.[1]) {
    return Number(compactSeason[1]);
  }

  const chineseSeason = /第\s*([一二三四五六七八九十两\d]{1,3})\s*季/u.exec(value);
  if (chineseSeason?.[1]) {
    return numberFromChineseOrDigits(chineseSeason[1]);
  }

  return null;
}

function parseEpisodeNumber(value: string): number | null {
  const episodeMarker = /(?:^|[^\dA-Za-z])(?:EP?|Episode)[ ._-]*(\d{1,3})(?:[^\dA-Za-z]|$)/i.exec(value);
  if (episodeMarker?.[1]) {
    return Number(episodeMarker[1]);
  }

  const chineseEpisode = /第\s*([一二三四五六七八九十两\d]{1,3})\s*[集话話]/u.exec(value);
  if (chineseEpisode?.[1]) {
    return numberFromChineseOrDigits(chineseEpisode[1]);
  }

  const baseName = stripExtension(value);
  for (const token of baseName.split(/[ ._-]+/)) {
    if (/^\d{1,3}$/.test(token)) {
      return Number(token);
    }
  }

  return null;
}

function toMoveAction(
  input: PackageNormalizationInput,
  file: ParsedPackageFile & { seasonNumber: number; episodeNumber: number },
): PackageMoveAction {
  const code = episodeCode(file.seasonNumber, file.episodeNumber);
  const extension = fileExtension(file.file.path);
  const safeTitle = sanitizePathSegment(input.title);

  return {
    sourcePath: file.file.path,
    providerFileId: file.file.providerFileId,
    sizeBytes: file.file.sizeBytes,
    episodeCode: code,
    targetSeasonNumber: file.seasonNumber,
    targetEpisodeNumber: file.episodeNumber,
    targetRelativePath: `${safeTitle} (${input.year})/Season ${pad2(file.seasonNumber)}/${safeTitle}.${code}.${extension}`,
    confidence: file.confidence,
    evidence: file.evidence,
  };
}

function classifyCoverage(actions: PackageMoveAction[], totalSeasons: number | undefined): PackageCoverage {
  if (actions.length === 0) {
    return "unknown";
  }

  const seasons = new Set(actions.map((action) => action.targetSeasonNumber));

  if (totalSeasons !== undefined && totalSeasons > 1 && seasons.size >= totalSeasons) {
    const coversEveryKnownSeason = Array.from({ length: totalSeasons }, (_, index) => index + 1).every((season) =>
      seasons.has(season),
    );
    if (coversEveryKnownSeason) {
      return "complete_series_package";
    }
  }

  return seasons.size > 1 ? "multi_season_package" : "single_season";
}

function planConfidence(actions: PackageMoveAction[], rejectedFiles: PackageRejectedFile[]): Confidence {
  if (actions.length === 0 || rejectedFiles.length > 0) {
    return "low";
  }

  return actions.every((action) => action.confidence === "high") ? "high" : "medium";
}

function rejectedFile(file: ParsedPackageFile, reason: PackageRejectReason): PackageRejectedFile {
  return {
    sourcePath: file.file.path,
    providerFileId: file.file.providerFileId,
    reason,
    message: rejectionMessage(reason),
  };
}

function missingReason(file: ParsedPackageFile): PackageRejectReason {
  return file.seasonNumber === null ? "missing_season" : "missing_episode";
}

function rejectionMessage(reason: PackageRejectReason): string {
  switch (reason) {
    case "duplicate_episode":
      return "Multiple files map to the same episode code.";
    case "missing_episode":
      return "The file does not expose a reliable episode number.";
    case "missing_season":
      return "The file does not expose a reliable season number.";
  }
}

function findDuplicateEpisodeCodes(
  files: Array<ParsedPackageFile & { seasonNumber: number; episodeNumber: number }>,
): Set<string> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const code = episodeCode(file.seasonNumber, file.episodeNumber);
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }

  return new Set(Array.from(counts.entries()).filter(([, count]) => count > 1).map(([code]) => code));
}

function firstNumber(values: Array<number | null>): number | null {
  for (const value of values) {
    if (value !== null) {
      return value;
    }
  }

  return null;
}

function numberFromChineseOrDigits(value: string): number | null {
  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  const digits: Record<string, number> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    两: 2,
  };

  if (value === "十") {
    return 10;
  }

  const tenIndex = value.indexOf("十");
  if (tenIndex >= 0) {
    const left = value.slice(0, tenIndex);
    const right = value.slice(tenIndex + 1);
    const tens = left === "" ? 1 : digits[left];
    const ones = right === "" ? 0 : digits[right];
    return tens === undefined || ones === undefined ? null : tens * 10 + ones;
  }

  return digits[value] ?? null;
}

function isVideoFile(file: PackageTreeFile): boolean {
  return VIDEO_EXTENSIONS.has(fileExtension(file.path).toLowerCase());
}

function fileExtension(path: string): string {
  const fileName = path.split(/[\\/]+/).at(-1) ?? path;
  const lastDot = fileName.lastIndexOf(".");
  return lastDot >= 0 ? fileName.slice(lastDot + 1) : "";
}

function stripExtension(path: string): string {
  const lastDot = path.lastIndexOf(".");
  return lastDot >= 0 ? path.slice(0, lastDot) : path;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function positiveIntegerOrNull(value: number): number | null {
  return Number.isInteger(value) && value > 0 ? value : null;
}
