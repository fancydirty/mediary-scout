import type {
  ResourceCandidate,
  TransferAttempt,
  TransferStatus,
  VerifiedFile,
} from "./domain.js";
import type { StorageExecutor } from "./ports.js";

const DEFAULT_VIDEO_EXTENSIONS = [
  ".mp4",
  ".mkv",
  ".avi",
  ".mov",
  ".wmv",
  ".flv",
  ".webm",
  ".m4v",
  ".mpg",
  ".mpeg",
  ".ts",
  ".m2ts",
];

const DEFAULT_PAN115_RISK_PATTERNS = [
  /请求.*频繁/,
  /访问.*阻断/,
  /安全威胁/,
  /风控/,
  /频控/,
  /rate\s*limit/i,
  /too\s*many\s*requests/i,
  /throttl/i,
];

type Pan115Operation = keyof Pan115StorageApi;

export interface Pan115Item {
  id?: string | number;
  fid?: string | number;
  file_id?: string | number;
  cid?: string | number;
  name?: string;
  n?: string;
  size?: string | number;
  s?: string | number;
  fc?: string | number;
  isDirectory?: boolean;
}

export interface Pan115DirectoryInfo {
  state: boolean;
  path: Array<{
    cid?: string | number;
    name?: string;
  }>;
}

export interface Pan115ActionResult {
  ok: boolean;
  message: string;
  alreadyTransferred?: boolean;
  code?: number;
}

export interface Pan115StorageApi {
  createFolder(input: { name: string; parentId: string }): Promise<string>;
  listItems(input: { directoryId: string }): Promise<Pan115Item[]>;
  getDirectoryInfo(input: { directoryId: string }): Promise<Pan115DirectoryInfo | null>;
  receiveShare(input: {
    shareCode: string;
    receiveCode: string;
    directoryId: string;
  }): Promise<Pan115ActionResult>;
  addOfflineTask(input: { url: string; directoryId: string }): Promise<Pan115ActionResult>;
  moveItems(input: { fileIds: string[]; targetDirectoryId: string }): Promise<Pan115ActionResult>;
  deleteItems(input: { fileIds: string[] }): Promise<Pan115ActionResult>;
}

export interface Storage115ExecutorOptions {
  api: Pan115StorageApi;
  apiGuard?: Pan115ApiGuard;
  apiGuardOptions?: Pan115ApiGuardOptions;
  protectedDirectoryIds?: string[];
  moviesDirectoryId?: string;
  minVideoSizeBytes?: number;
  videoExtensions?: string[];
}

export type Pan115ApiGuardEventKind =
  | "delay"
  | "budget_exhausted"
  | "risk_detected"
  | "large_list"
  | "circuit_open";

export interface Pan115ApiGuardEvent {
  kind: Pan115ApiGuardEventKind;
  operation: Pan115Operation;
  message: string;
  delayMs?: number;
  callCount?: number;
}

export interface Pan115ApiGuardOptions {
  minDelayMs?: number;
  maxCallsPerOperation?: number;
  maxListItemsPerResponse?: number;
  riskMessagePatterns?: RegExp[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onEvent?: (event: Pan115ApiGuardEvent) => void;
}

export class Pan115RiskControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Pan115RiskControlError";
  }
}

export class Pan115ApiGuard {
  private readonly minDelayMs: number;
  private readonly maxCallsPerOperation: number;
  private readonly maxListItemsPerResponse: number;
  private readonly riskMessagePatterns: RegExp[];
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onEvent: (event: Pan115ApiGuardEvent) => void;
  private lastCallAt: number | null = null;
  private callCount = 0;
  private circuitOpenReason: string | null = null;

  constructor(options: Pan115ApiGuardOptions = {}) {
    this.minDelayMs = options.minDelayMs ?? 0;
    this.maxCallsPerOperation = options.maxCallsPerOperation ?? 80;
    this.maxListItemsPerResponse = options.maxListItemsPerResponse ?? 230;
    this.riskMessagePatterns = options.riskMessagePatterns ?? DEFAULT_PAN115_RISK_PATTERNS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.onEvent = options.onEvent ?? (() => undefined);
  }

  async run<T>(operation: Pan115Operation, call: () => Promise<T>): Promise<T> {
    this.assertCircuitClosed(operation);
    await this.applyDelay(operation);
    this.assertBudget(operation);
    this.callCount += 1;
    this.lastCallAt = this.now();

    try {
      const result = await call();
      this.inspectResult(operation, result);
      return result;
    } catch (error) {
      if (error instanceof Pan115RiskControlError) {
        throw error;
      }
      const message = errorMessage(error);
      if (isPan115RiskControlSignal(message, this.riskMessagePatterns)) {
        this.openCircuit(operation, message);
      }
      throw error;
    }
  }

  private assertCircuitClosed(operation: Pan115Operation): void {
    if (!this.circuitOpenReason) {
      return;
    }
    throw new Pan115RiskControlError(
      `PAN115_RATE_LIMIT: circuit breaker open before ${operation}: ${this.circuitOpenReason}`,
    );
  }

  private async applyDelay(operation: Pan115Operation): Promise<void> {
    if (this.minDelayMs <= 0 || this.lastCallAt === null) {
      return;
    }
    const elapsedMs = this.now() - this.lastCallAt;
    const delayMs = Math.max(0, this.minDelayMs - elapsedMs);
    if (delayMs <= 0) {
      return;
    }
    this.onEvent({
      kind: "delay",
      operation,
      delayMs,
      message: `waiting ${delayMs}ms before ${operation}`,
    });
    await this.sleep(delayMs);
  }

  private assertBudget(operation: Pan115Operation): void {
    if (this.callCount < this.maxCallsPerOperation) {
      return;
    }
    const message = `PAN115_RATE_LIMIT: API call budget exhausted before ${operation}; ` +
      `maxCallsPerOperation=${this.maxCallsPerOperation}`;
    this.onEvent({
      kind: "budget_exhausted",
      operation,
      callCount: this.callCount,
      message,
    });
    throw new Pan115RiskControlError(message);
  }

  private inspectResult(operation: Pan115Operation, result: unknown): void {
    if (operation === "listItems" && Array.isArray(result) && result.length > this.maxListItemsPerResponse) {
      this.openCircuit(
        operation,
        `listItems returned ${result.length} items, above maxListItemsPerResponse=${this.maxListItemsPerResponse}`,
        "large_list",
      );
    }

    const actionResult = pan115ActionResultLike(result);
    if (!actionResult) {
      return;
    }
    if (
      actionResult.code === 429 ||
      isPan115RiskControlSignal(actionResult.message, this.riskMessagePatterns)
    ) {
      this.openCircuit(operation, actionResult.message || `115 returned code ${actionResult.code}`);
    }
  }

  private openCircuit(
    operation: Pan115Operation,
    reason: string,
    kind: Pan115ApiGuardEventKind = "risk_detected",
  ): never {
    this.circuitOpenReason = reason;
    this.onEvent({
      kind,
      operation,
      message: reason,
      callCount: this.callCount,
    });
    this.onEvent({
      kind: "circuit_open",
      operation,
      message: reason,
      callCount: this.callCount,
    });
    throw new Pan115RiskControlError(`PAN115_RATE_LIMIT: ${reason}`);
  }
}

interface VideoFact {
  file: VerifiedFile;
  sourceDirectoryId: string;
  sizeBytes: number;
}

export class Storage115Executor implements StorageExecutor {
  private readonly api: Pan115StorageApi;
  private readonly protectedDirectoryIds: Set<string>;
  private readonly moviesDirectoryId: string | null;
  private readonly minVideoSizeBytes: number;
  private readonly videoExtensions: Set<string>;
  private readonly apiGuard: Pan115ApiGuard;
  private nextTransferNumber = 1;

  constructor(options: Storage115ExecutorOptions) {
    this.api = options.api;
    this.apiGuard = options.apiGuard ?? new Pan115ApiGuard(options.apiGuardOptions);
    this.protectedDirectoryIds = new Set(["0", ...(options.protectedDirectoryIds ?? [])]);
    this.moviesDirectoryId = options.moviesDirectoryId ?? null;
    this.minVideoSizeBytes = options.minVideoSizeBytes ?? 10 * 1024 * 1024;
    this.videoExtensions = new Set(
      (options.videoExtensions ?? DEFAULT_VIDEO_EXTENSIONS).map((extension) => extension.toLowerCase()),
    );
  }

  async createDirectory(input: { name: string; parentId: string }): Promise<string> {
    return this.callApi("createFolder", () => this.api.createFolder(input));
  }

  async listVideoFiles(directoryId: string): Promise<VerifiedFile[]> {
    const videos = await this.collectVideos(directoryId, directoryId);
    return videos.map((video) => video.file);
  }

  async transfer(input: {
    workflowRunId: string;
    directoryId: string;
    candidate: ResourceCandidate;
  }): Promise<TransferAttempt> {
    const before = new Set((await this.listVideoFiles(input.directoryId)).map((file) => file.id));
    const action = await this.executeCandidateTransfer(input.candidate, input.directoryId);
    const after = await this.listVideoFiles(input.directoryId);
    const materializedFileIds = after
      .filter((file) => !before.has(file.id))
      .map((file) => file.id);
    const status = transferStatus(action, materializedFileIds);
    const providerMessage = transferMessage(input.candidate, action, status);

    const attempt: TransferAttempt = {
      id: `transfer_${this.nextTransferNumber}`,
      workflowRunId: input.workflowRunId,
      candidateId: input.candidate.id,
      status,
      providerMessage,
      materializedFileIds,
    };
    this.nextTransferNumber += 1;
    return attempt;
  }

  async flattenDirectory(directoryId: string): Promise<{ moved: string[]; removed: string[] }> {
    const safeDirectoryId = await this.assertSafeFlattenTarget(directoryId);
    const videos = await this.collectVideos(safeDirectoryId, safeDirectoryId);
    const moveCandidates = videos.filter(
      (video) => video.sourceDirectoryId !== safeDirectoryId && video.sizeBytes >= this.minVideoSizeBytes,
    );
    const moved = moveCandidates.map((video) => video.file.providerFileId);
    if (moved.length > 0) {
      const result = await this.callApi("moveItems", () =>
        this.api.moveItems({
          fileIds: moved,
          targetDirectoryId: safeDirectoryId,
        }),
      );
      if (!result.ok) {
        return { moved: [], removed: [] };
      }
    }

    const rootItems = await this.callApi("listItems", () => this.api.listItems({ directoryId: safeDirectoryId }));
    const removableDirectoryIds: string[] = [];
    for (const item of rootItems) {
      if (!isDirectory(item)) {
        continue;
      }
      const childDirectoryId = directoryIdFromItem(item);
      if (!childDirectoryId) {
        continue;
      }
      if (!(await this.directoryContainsLargeVideo(childDirectoryId))) {
        removableDirectoryIds.push(childDirectoryId);
      }
    }
    if (removableDirectoryIds.length > 0) {
      const result = await this.callApi("deleteItems", () =>
        this.api.deleteItems({ fileIds: removableDirectoryIds }),
      );
      if (!result.ok) {
        return { moved, removed: [] };
      }
    }

    return { moved, removed: removableDirectoryIds };
  }

  async deleteFiles(input: { directoryId: string; fileIds: string[] }): Promise<{ deleted: string[] }> {
    if (input.fileIds.length === 0) {
      return { deleted: [] };
    }
    const result = await this.callApi("deleteItems", () => this.api.deleteItems({ fileIds: input.fileIds }));
    return { deleted: result.ok ? input.fileIds : [] };
  }

  private async executeCandidateTransfer(
    candidate: ResourceCandidate,
    directoryId: string,
  ): Promise<Pan115ActionResult> {
    const url = stringValue(candidate.providerPayload["url"]);
    if (!url) {
      return { ok: false, message: "candidate providerPayload.url is required" };
    }

    if (url.startsWith("magnet:?xt=urn:btih:")) {
      return this.callApi("addOfflineTask", () => this.api.addOfflineTask({ url, directoryId }));
    }

    if (url.startsWith("https://115.com/s/") || url.startsWith("https://115cdn.com/s/")) {
      const parsed = parseShareUrl(url);
      if (!parsed) {
        return { ok: false, message: "invalid 115 share link" };
      }
      const payloadPassword = stringValue(candidate.providerPayload["password"]);
      return this.callApi("receiveShare", () =>
        this.api.receiveShare({
          shareCode: parsed.shareCode,
          receiveCode: payloadPassword || parsed.receiveCode,
          directoryId,
        }),
      );
    }

    return { ok: false, message: `unsupported 115 transfer url: ${url.slice(0, 50)}` };
  }

  private async assertSafeFlattenTarget(directoryId: string): Promise<string> {
    const normalized = normalizeDirectoryId(directoryId);
    if (this.protectedDirectoryIds.has(normalized)) {
      throw new Error(`SAFETY_VIOLATION: refusing to flatten protected directory cid=${normalized}`);
    }

    const info = await this.callApi("getDirectoryInfo", () => this.api.getDirectoryInfo({ directoryId: normalized }));
    if (!info?.state) {
      throw new Error(`SAFETY_VIOLATION: unable to verify flatten target cid=${normalized}`);
    }

    const pathNames = info.path.map((part) => stringValue(part.name)).filter((name) => name.length > 0);
    const pathIds = info.path.map((part) => stringValue(part.cid)).filter((cid) => cid.length > 0);
    const joinedPath = pathNames.length > 0 ? pathNames.join("/") : "(unknown)";
    if (pathNames.length < 3) {
      throw new Error(
        "SAFETY_VIOLATION: flatten target must be a movie leaf or season leaf directory; " +
          `path=${joinedPath}`,
      );
    }

    const leafName = pathNames[pathNames.length - 1] ?? "";
    if (/^Season\s+\d+$/i.test(leafName)) {
      return normalized;
    }

    const parentId = pathIds[pathIds.length - 2] ?? "";
    const parentName = pathNames[pathNames.length - 2] ?? "";
    const isMovieLeaf = Boolean(this.moviesDirectoryId && parentId === this.moviesDirectoryId);
    const isMovieNameFallback = parentName === "Movies" && pathNames.length >= 4;
    if (!isMovieLeaf && !isMovieNameFallback) {
      throw new Error(
        "SAFETY_VIOLATION: flatten target must be a movie leaf under MOVIES_CID " +
          "or end with 'Season <number>'; " +
          `path=${joinedPath}`,
      );
    }

    return normalized;
  }

  private async directoryContainsLargeVideo(directoryId: string): Promise<boolean> {
    const videos = await this.collectVideos(directoryId, directoryId);
    return videos.some((video) => video.sizeBytes >= this.minVideoSizeBytes);
  }

  private async collectVideos(rootDirectoryId: string, currentDirectoryId: string): Promise<VideoFact[]> {
    const items = await this.callApi("listItems", () => this.api.listItems({ directoryId: currentDirectoryId }));
    const videos: VideoFact[] = [];
    for (const item of items) {
      if (isDirectory(item)) {
        const childDirectoryId = directoryIdFromItem(item);
        if (childDirectoryId) {
          videos.push(...(await this.collectVideos(rootDirectoryId, childDirectoryId)));
        }
        continue;
      }

      const file = verifiedFileFromItem(item, rootDirectoryId, this.videoExtensions);
      if (file) {
        videos.push({
          file,
          sourceDirectoryId: currentDirectoryId,
          sizeBytes: file.sizeBytes,
        });
      }
    }
    return videos;
  }

  private async callApi<T>(operation: Pan115Operation, call: () => Promise<T>): Promise<T> {
    return this.apiGuard.run(operation, call);
  }
}

export function isPan115RiskControlSignal(message: string, patterns = DEFAULT_PAN115_RISK_PATTERNS): boolean {
  return patterns.some((pattern) => pattern.test(message));
}

function pan115ActionResultLike(value: unknown): Pan115ActionResult | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const maybeResult = value as Partial<Pan115ActionResult>;
  if (typeof maybeResult.ok !== "boolean") {
    return null;
  }
  const result: Pan115ActionResult = {
    ok: maybeResult.ok,
    message: typeof maybeResult.message === "string" ? maybeResult.message : "",
  };
  if (maybeResult.alreadyTransferred !== undefined) {
    result.alreadyTransferred = maybeResult.alreadyTransferred;
  }
  if (maybeResult.code !== undefined) {
    result.code = maybeResult.code;
  }
  return result;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "";
}

function transferStatus(action: Pan115ActionResult, materializedFileIds: string[]): TransferStatus {
  if (!action.ok) {
    return action.alreadyTransferred ? "no_target_change" : "failed";
  }
  return materializedFileIds.length > 0 ? "succeeded" : "no_target_change";
}

function transferMessage(
  candidate: ResourceCandidate,
  action: Pan115ActionResult,
  status: TransferStatus,
): string {
  if (action.message) {
    if (candidate.type === "magnet" && status === "no_target_change") {
      return `${action.message}; no target video materialized yet`;
    }
    return action.message;
  }
  if (candidate.type === "magnet" && status === "no_target_change") {
    return "offline task accepted; no target video materialized yet";
  }
  if (status === "no_target_change") {
    return "transfer accepted; no target video materialized yet";
  }
  return "";
}

function parseShareUrl(url: string): { shareCode: string; receiveCode: string } | null {
  const match = /\/s\/([A-Za-z0-9]+)(?:\?([^#]+))?/.exec(url);
  if (!match?.[1]) {
    return null;
  }
  const params = new URLSearchParams(match[2] ?? "");
  return {
    shareCode: match[1],
    receiveCode: params.get("password") ?? "",
  };
}

function verifiedFileFromItem(
  item: Pan115Item,
  storageDirectoryId: string,
  videoExtensions: Set<string>,
): VerifiedFile | null {
  const name = itemName(item);
  if (!isVideoName(name, videoExtensions)) {
    return null;
  }
  const episodeCode = episodeCodeFromName(name);
  if (!episodeCode) {
    return null;
  }
  const providerFileId = fileIdFromItem(item);
  if (!providerFileId) {
    return null;
  }
  return {
    id: providerFileId,
    storageDirectoryId,
    name,
    sizeBytes: numberValue(item.size ?? item.s),
    episodeCode,
    providerFileId,
  };
}

function isDirectory(item: Pan115Item): boolean {
  if (item.isDirectory !== undefined) {
    return item.isDirectory;
  }
  if (item.fc === "0" || item.fc === 0) {
    return true;
  }
  return item.cid !== undefined && item.fid === undefined && item.file_id === undefined;
}

function directoryIdFromItem(item: Pan115Item): string {
  return stringValue(item.cid ?? item.id);
}

function fileIdFromItem(item: Pan115Item): string {
  return stringValue(item.fid ?? item.file_id ?? item.id);
}

function itemName(item: Pan115Item): string {
  return stringValue(item.name ?? item.n);
}

function isVideoName(name: string, videoExtensions: Set<string>): boolean {
  const lower = name.toLowerCase();
  return Array.from(videoExtensions).some((extension) => lower.endsWith(extension));
}

function episodeCodeFromName(name: string): string | null {
  const seasonEpisodeMatch = /[Ss](\d{1,2})[Ee](\d{1,3})/.exec(name);
  if (seasonEpisodeMatch?.[1] && seasonEpisodeMatch[2]) {
    return `S${seasonEpisodeMatch[1].padStart(2, "0")}E${seasonEpisodeMatch[2].padStart(2, "0")}`;
  }

  const chineseEpisodeMatch = /第\s*(\d{1,3})\s*集/.exec(name);
  if (chineseEpisodeMatch?.[1]) {
    return `S01E${chineseEpisodeMatch[1].padStart(2, "0")}`;
  }

  return null;
}

function normalizeDirectoryId(directoryId: string): string {
  const normalized = directoryId.trim();
  if (!normalized) {
    throw new Error("directoryId must not be empty");
  }
  return normalized;
}

function stringValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
