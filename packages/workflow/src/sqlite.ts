import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import {
  episodeNumberFromCode,
  type AgentDecision,
  type EpisodeState,
  type MediaTitle,
  type NotificationEvent,
  type ResourceSnapshot,
  type TrackedSeason,
  type TransferAttempt,
  type WorkflowKind,
  type WorkflowRun,
} from "./domain.js";
import {
  claimWorkflowRun,
  cloneWorkflowValue,
  compareTrackedSeasonStates,
  expireWorkflowRun,
  isActiveWorkflowStatus,
  type PersistedWorkflowRunSnapshot,
  type PersistWorkflowRunSnapshotInput,
  type ReserveWorkflowRunInput,
  type TrackedSeasonState,
  validateWorkflowRunSnapshot,
  withDerivedEpisodeSummaries,
  workflowSnapshotFromReservation,
  type WorkflowRunReservationResult,
  type WorkflowRepository,
} from "./repository.js";

export function initializeWorkflowSqliteSchema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS media_titles (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tracked_seasons (
      id TEXT PRIMARY KEY,
      media_title_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      FOREIGN KEY (media_title_id) REFERENCES media_titles(id)
    );

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      tracked_season_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      FOREIGN KEY (tracked_season_id) REFERENCES tracked_seasons(id)
    );

    CREATE TABLE IF NOT EXISTS episode_states (
      tracked_season_id TEXT NOT NULL,
      episode_code TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (tracked_season_id, episode_code),
      FOREIGN KEY (tracked_season_id) REFERENCES tracked_seasons(id)
    );

    CREATE TABLE IF NOT EXISTS resource_snapshots (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      payload TEXT NOT NULL,
      FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id)
    );

    CREATE TABLE IF NOT EXISTS agent_decisions (
      workflow_run_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      snapshot_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (workflow_run_id, ordinal),
      FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id),
      FOREIGN KEY (snapshot_id) REFERENCES resource_snapshots(id)
    );

    CREATE TABLE IF NOT EXISTS transfer_attempts (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      candidate_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id)
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      payload TEXT NOT NULL,
      FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id)
    );
  `);
}

export class SQLiteWorkflowRepository implements WorkflowRepository {
  constructor(private readonly database: DatabaseSync) {
    initializeWorkflowSqliteSchema(database);
  }

  async saveWorkflowRunSnapshot(input: PersistWorkflowRunSnapshotInput): Promise<void> {
    validateWorkflowRunSnapshot(input);
    const snapshot = cloneWorkflowValue(input);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.replaceWorkflowRunSnapshot(snapshot);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async reserveWorkflowRun(input: ReserveWorkflowRunInput): Promise<WorkflowRunReservationResult> {
    const snapshot = cloneWorkflowValue(workflowSnapshotFromReservation(input));
    validateWorkflowRunSnapshot(snapshot);

    let committed = false;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.expireStaleActiveWorkflowRuns(input);

      if (input.blockIfTitleHasActiveRun === true) {
        const titleActive = this.selectWorkflowRunsForTitle(snapshot.season.mediaTitleId)
          .filter((workflowRun) => isActiveWorkflowStatus(workflowRun.status))
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
        if (titleActive) {
          this.database.exec("COMMIT");
          committed = true;
          const activeSnapshot = await this.getWorkflowRunSnapshot(titleActive.id);
          if (!activeSnapshot) {
            throw new Error(`Missing active workflow run ${titleActive.id}`);
          }
          return {
            status: "already_active",
            snapshot: activeSnapshot,
          };
        }
      }

      const activeRun = this.selectWorkflowRuns(snapshot.season.id)
        .filter(
          (workflowRun) =>
            workflowRun.kind === snapshot.workflowRun.kind && isActiveWorkflowStatus(workflowRun.status),
        )
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
      if (activeRun) {
        this.database.exec("COMMIT");
        committed = true;
        const activeSnapshot = await this.getWorkflowRunSnapshot(activeRun.id);
        if (!activeSnapshot) {
          throw new Error(`Missing active workflow run ${activeRun.id}`);
        }
        return {
          status: "already_active",
          snapshot: activeSnapshot,
        };
      }

      const existingEpisodes = this.selectEpisodeStates(snapshot.season.id);
      if (input.blockIfEpisodeStatesExist === true && existingEpisodes.length > 0) {
        this.database.exec("COMMIT");
        committed = true;
        return {
          status: "already_has_episode_state",
          episodes: existingEpisodes,
        };
      }

      this.replaceWorkflowRunSnapshot(snapshot);
      this.database.exec("COMMIT");
      committed = true;
      return {
        status: "reserved",
        snapshot: withDerivedEpisodeSummaries(cloneWorkflowValue(snapshot)),
      };
    } catch (error) {
      if (!committed) {
        this.database.exec("ROLLBACK");
      }
      throw error;
    }
  }

  async getWorkflowRunSnapshot(workflowRunId: string): Promise<PersistedWorkflowRunSnapshot | null> {
    const workflowRun = this.selectPayload<WorkflowRun>("SELECT payload FROM workflow_runs WHERE id = ?", workflowRunId);
    if (!workflowRun) {
      return null;
    }

    const season = this.selectPayload<TrackedSeason>(
      "SELECT payload FROM tracked_seasons WHERE id = ?",
      workflowRun.trackedSeasonId,
    );
    if (!season) {
      throw new Error(`Missing tracked season ${workflowRun.trackedSeasonId} for workflow run ${workflowRun.id}`);
    }

    const title = this.selectPayload<MediaTitle>(
      "SELECT payload FROM media_titles WHERE id = ?",
      season.mediaTitleId,
    );
    if (!title) {
      throw new Error(`Missing media title ${season.mediaTitleId} for tracked season ${season.id}`);
    }

    return withDerivedEpisodeSummaries({
      title,
      season,
      workflowRun,
      episodes: this.selectEpisodeStates(season.id),
      resourceSnapshots: this.selectPayloads<ResourceSnapshot>(
        "SELECT payload FROM resource_snapshots WHERE workflow_run_id = ? ORDER BY ordinal",
        workflowRun.id,
      ),
      decisions: this.selectPayloads<AgentDecision>(
        "SELECT payload FROM agent_decisions WHERE workflow_run_id = ? ORDER BY ordinal",
        workflowRun.id,
      ),
      transferAttempts: this.selectPayloads<TransferAttempt>(
        "SELECT payload FROM transfer_attempts WHERE workflow_run_id = ? ORDER BY ordinal",
        workflowRun.id,
      ),
      notifications: this.selectPayloads<NotificationEvent>(
        "SELECT payload FROM notifications WHERE workflow_run_id = ? ORDER BY ordinal",
        workflowRun.id,
      ),
    });
  }

  async claimNextQueuedWorkflowRun(input: {
    kind: WorkflowKind;
    now: string;
  }): Promise<PersistedWorkflowRunSnapshot | null> {
    let committed = false;
    let claimedRunId: string | null = null;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const queuedRun = this.selectPayloads<WorkflowRun>("SELECT payload FROM workflow_runs")
        .filter((workflowRun) => workflowRun.kind === input.kind && workflowRun.status === "queued")
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
      if (!queuedRun) {
        this.database.exec("COMMIT");
        committed = true;
        return null;
      }

      const claimedRun = claimWorkflowRun(queuedRun, input.now);
      this.upsertWorkflowRun(claimedRun);
      claimedRunId = claimedRun.id;
      this.database.exec("COMMIT");
      committed = true;
    } catch (error) {
      if (!committed) {
        this.database.exec("ROLLBACK");
      }
      throw error;
    }

    if (!claimedRunId) {
      return null;
    }
    return this.getWorkflowRunSnapshot(claimedRunId);
  }

  async findActiveWorkflowRun(input: {
    trackedSeasonId: string;
    kind: WorkflowKind;
  }): Promise<PersistedWorkflowRunSnapshot | null> {
    const workflowRuns = this.selectPayloads<WorkflowRun>(
      "SELECT payload FROM workflow_runs WHERE tracked_season_id = ?",
      input.trackedSeasonId,
    )
      .filter((workflowRun) => workflowRun.kind === input.kind && isActiveWorkflowStatus(workflowRun.status))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const latest = workflowRuns[0];
    return latest ? this.getWorkflowRunSnapshot(latest.id) : null;
  }

  async listActiveWorkflowRuns(): Promise<PersistedWorkflowRunSnapshot[]> {
    const runs = this.selectPayloads<WorkflowRun>("SELECT payload FROM workflow_runs")
      .filter((workflowRun) => isActiveWorkflowStatus(workflowRun.status))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const snapshots: PersistedWorkflowRunSnapshot[] = [];
    for (const run of runs) {
      try {
        const snapshot = await this.getWorkflowRunSnapshot(run.id);
        if (snapshot) {
          snapshots.push(snapshot);
        }
      } catch {
        // Orphaned/inconsistent run (e.g. its tracked season was deleted out
        // from under it) — skip it rather than crash callers like the library's
        // in-progress list.
      }
    }
    return snapshots;
  }

  async getTrackedSeasonState(trackedSeasonId: string): Promise<TrackedSeasonState | null> {
    const season = this.selectPayload<TrackedSeason>(
      "SELECT payload FROM tracked_seasons WHERE id = ?",
      trackedSeasonId,
    );
    if (!season) {
      return null;
    }

    const title = this.selectPayload<MediaTitle>(
      "SELECT payload FROM media_titles WHERE id = ?",
      season.mediaTitleId,
    );
    if (!title) {
      throw new Error(`Missing media title ${season.mediaTitleId} for tracked season ${season.id}`);
    }

    return {
      title,
      season,
      episodes: this.selectEpisodeStates(season.id),
    };
  }

  async listTrackedSeasonStates(): Promise<TrackedSeasonState[]> {
    const seasons = this.selectPayloads<TrackedSeason>("SELECT payload FROM tracked_seasons");
    return seasons
      .map((season) => {
        const title = this.selectPayload<MediaTitle>(
          "SELECT payload FROM media_titles WHERE id = ?",
          season.mediaTitleId,
        );
        if (!title) {
          throw new Error(`Missing media title ${season.mediaTitleId} for tracked season ${season.id}`);
        }
        return {
          title,
          season,
          episodes: this.selectEpisodeStates(season.id),
        };
      })
      .sort(compareTrackedSeasonStates);
  }

  async listEpisodeStates(trackedSeasonId: string): Promise<EpisodeState[]> {
    return this.selectEpisodeStates(trackedSeasonId);
  }

  async listNotifications(input?: { limit?: number }): Promise<NotificationEvent[]> {
    const rows = this.database
      .prepare("SELECT payload FROM notifications")
      .all() as Array<{ payload: string }>;
    const all = rows.map((row) => JSON.parse(row.payload) as NotificationEvent);
    all.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return all.slice(0, input?.limit ?? 100);
  }

  async getSetting(key: string): Promise<string | null> {
    const row = this.database
      .prepare("SELECT value FROM app_settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.database
      .prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)")
      .run(key, value);
  }

  private upsertMediaTitle(title: MediaTitle): void {
    this.database
      .prepare("INSERT OR REPLACE INTO media_titles (id, payload) VALUES (?, ?)")
      .run(title.id, toJson(title));
  }

  private upsertTrackedSeason(season: TrackedSeason): void {
    this.database
      .prepare("INSERT OR REPLACE INTO tracked_seasons (id, media_title_id, payload) VALUES (?, ?, ?)")
      .run(season.id, season.mediaTitleId, toJson(season));
  }

  private upsertWorkflowRun(workflowRun: WorkflowRun): void {
    this.database
      .prepare("INSERT OR REPLACE INTO workflow_runs (id, tracked_season_id, payload) VALUES (?, ?, ?)")
      .run(workflowRun.id, workflowRun.trackedSeasonId, toJson(workflowRun));
  }

  private deleteWorkflowRunChildren(workflowRunId: string, trackedSeasonId: string): void {
    this.database.prepare("DELETE FROM notifications WHERE workflow_run_id = ?").run(workflowRunId);
    this.database.prepare("DELETE FROM transfer_attempts WHERE workflow_run_id = ?").run(workflowRunId);
    this.database.prepare("DELETE FROM agent_decisions WHERE workflow_run_id = ?").run(workflowRunId);
    this.database.prepare("DELETE FROM resource_snapshots WHERE workflow_run_id = ?").run(workflowRunId);
    this.database.prepare("DELETE FROM episode_states WHERE tracked_season_id = ?").run(trackedSeasonId);
  }

  private replaceWorkflowRunSnapshot(snapshot: PersistWorkflowRunSnapshotInput): void {
    this.upsertMediaTitle(snapshot.title);
    this.upsertTrackedSeason(snapshot.season);
    this.upsertWorkflowRun(snapshot.workflowRun);
    this.deleteWorkflowRunChildren(snapshot.workflowRun.id, snapshot.season.id);
    this.insertEpisodeStates(snapshot.season.id, snapshot.episodes);
    this.insertResourceSnapshots(snapshot.workflowRun.id, snapshot.resourceSnapshots);
    this.insertAgentDecisions(snapshot.workflowRun.id, snapshot.decisions);
    this.insertTransferAttempts(snapshot.workflowRun.id, snapshot.transferAttempts);
    this.insertNotifications(snapshot.workflowRun.id, snapshot.notifications);
  }

  private expireStaleActiveWorkflowRuns(input: ReserveWorkflowRunInput): void {
    if (!input.staleActiveRunStartedBefore) {
      return;
    }
    const snapshot = workflowSnapshotFromReservation(input);
    const staleRuns = this.selectWorkflowRuns(snapshot.season.id).filter(
      (workflowRun) =>
        workflowRun.kind === snapshot.workflowRun.kind &&
        isActiveWorkflowStatus(workflowRun.status) &&
        workflowRun.startedAt < input.staleActiveRunStartedBefore!,
    );
    for (const staleRun of staleRuns) {
      const expiredRun = expireWorkflowRun(staleRun, input.staleFinishedAt ?? snapshot.workflowRun.startedAt);
      this.upsertWorkflowRun(expiredRun);
      this.database.prepare("DELETE FROM episode_states WHERE tracked_season_id = ?").run(snapshot.season.id);
    }
  }

  private insertEpisodeStates(trackedSeasonId: string, episodes: EpisodeState[]): void {
    const insert = this.database.prepare(
      "INSERT INTO episode_states (tracked_season_id, episode_code, payload) VALUES (?, ?, ?)",
    );
    for (const episode of episodes) {
      insert.run(trackedSeasonId, episode.episodeCode, toJson(episode));
    }
  }

  private insertResourceSnapshots(workflowRunId: string, snapshots: ResourceSnapshot[]): void {
    // Snapshot ids are content-addressed, so the SAME id can legitimately recur
    // across runs (and within a batch). `OR IGNORE` keeps persistence idempotent
    // on the id instead of crashing the whole run on a duplicate.
    const insert = this.database.prepare(
      "INSERT OR IGNORE INTO resource_snapshots (id, workflow_run_id, ordinal, payload) VALUES (?, ?, ?, ?)",
    );
    snapshots.forEach((snapshot, ordinal) => {
      insert.run(snapshot.id, workflowRunId, ordinal, toJson(snapshot));
    });
  }

  private insertAgentDecisions(workflowRunId: string, decisions: AgentDecision[]): void {
    const insert = this.database.prepare(
      "INSERT INTO agent_decisions (workflow_run_id, ordinal, snapshot_id, payload) VALUES (?, ?, ?, ?)",
    );
    decisions.forEach((decision, ordinal) => {
      insert.run(workflowRunId, ordinal, decision.snapshotId, toJson(decision));
    });
  }

  private insertTransferAttempts(workflowRunId: string, attempts: TransferAttempt[]): void {
    const insert = this.database.prepare(
      "INSERT INTO transfer_attempts (id, workflow_run_id, ordinal, candidate_id, payload) VALUES (?, ?, ?, ?, ?)",
    );
    attempts.forEach((attempt, ordinal) => {
      insert.run(attempt.id, workflowRunId, ordinal, attempt.candidateId, toJson(attempt));
    });
  }

  private insertNotifications(workflowRunId: string, notifications: NotificationEvent[]): void {
    const insert = this.database.prepare(
      "INSERT INTO notifications (id, workflow_run_id, ordinal, payload) VALUES (?, ?, ?, ?)",
    );
    notifications.forEach((notification, ordinal) => {
      insert.run(notification.id, workflowRunId, ordinal, toJson(notification));
    });
  }

  private selectPayload<T>(sql: string, ...parameters: string[]): T | null {
    const row = this.database.prepare(sql).get(...parameters);
    return row ? parsePayload<T>(row["payload"]) : null;
  }

  private selectPayloads<T>(sql: string, ...parameters: string[]): T[] {
    return this.database.prepare(sql).all(...parameters).map((row) => parsePayload<T>(row["payload"]));
  }

  private selectWorkflowRuns(trackedSeasonId: string): WorkflowRun[] {
    return this.selectPayloads<WorkflowRun>(
      "SELECT payload FROM workflow_runs WHERE tracked_season_id = ?",
      trackedSeasonId,
    );
  }

  private selectWorkflowRunsForTitle(mediaTitleId: string): WorkflowRun[] {
    return this.selectPayloads<WorkflowRun>(
      "SELECT wr.payload AS payload FROM workflow_runs wr " +
        "JOIN tracked_seasons ts ON wr.tracked_season_id = ts.id " +
        "WHERE ts.media_title_id = ?",
      mediaTitleId,
    );
  }

  private selectEpisodeStates(trackedSeasonId: string): EpisodeState[] {
    return this.selectPayloads<EpisodeState>(
      "SELECT payload FROM episode_states WHERE tracked_season_id = ?",
      trackedSeasonId,
    ).sort((a, b) => episodeNumberFromCode(a.episodeCode) - episodeNumberFromCode(b.episodeCode));
  }
}

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

function parsePayload<T>(payload: SQLOutputValue | undefined): T {
  if (typeof payload !== "string") {
    throw new Error("Expected SQLite payload column to be text");
  }
  return JSON.parse(payload) as T;
}
