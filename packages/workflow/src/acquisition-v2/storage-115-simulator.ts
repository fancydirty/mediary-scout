/**
 * In-memory 115 simulator for the Acquisition V2 rebuild — the deterministic
 * backend the sandbox tools and acceptance tests run against (Phase 0). It
 * models the real 115 behaviors that bit us: transfers MATERIALIZE files nested
 * inside the resource's own directory (hence flatten), name collisions on move
 * become `name (1).ext`, and the per-operation API budget (the 逆鳞) fails loud.
 *
 * Built test-first, one capability at a time. No real 115, ever.
 */

export interface SimTreeFile {
  /** Stable file id (provider file id analogue). */
  id: string;
  /** Path relative to the queried directory, e.g. "[Group] Show S01/Show - 01.mkv". */
  path: string;
  sizeBytes: number;
  isVideo: boolean;
}

export interface TransferAttemptResult {
  status: "succeeded" | "failed";
  materializedFileIds: string[];
}

/** What a candidate transfer would land — files keyed by their path relative to
 *  the staging dir (paths with "/" model the pack's own wrapper directory). */
export interface PackSpec {
  files: Array<{ path: string; sizeBytes: number }>;
}

interface Dir {
  id: string;
  name: string;
  parentId: string | null;
}

interface File {
  id: string;
  name: string;
  parentId: string;
  sizeBytes: number;
}

const VIDEO_EXTENSIONS = /\.(mkv|mp4|avi|ts|m2ts|mov|flv|wmv)$/i;

export class Storage115Simulator {
  private readonly dirs = new Map<string, Dir>();
  private readonly files = new Map<string, File>();
  private readonly packs: Map<string, PackSpec>;
  private sequence = 0;

  constructor(options: { packs?: Record<string, PackSpec>; rootId?: string } = {}) {
    const rootId = options.rootId ?? "root";
    this.dirs.set(rootId, { id: rootId, name: "root", parentId: null });
    this.packs = new Map(Object.entries(options.packs ?? {}));
  }

  async createDirectory(input: { name: string; parentId: string }): Promise<string> {
    if (!this.dirs.has(input.parentId)) {
      throw new Error(`SIM_DIR_NOT_FOUND: parent ${input.parentId}`);
    }
    const id = this.nextId("dir");
    this.dirs.set(id, { id, name: input.name, parentId: input.parentId });
    return id;
  }

  /** Transfer a candidate's pack into a directory: materialize its files,
   *  creating the pack's own wrapper subdirectories as needed. An unknown
   *  candidate is a dead share — failed, nothing materialized. */
  async transferCandidate(input: {
    candidateId: string;
    intoDirectoryId: string;
  }): Promise<TransferAttemptResult> {
    if (!this.dirs.has(input.intoDirectoryId)) {
      throw new Error(`SIM_DIR_NOT_FOUND: target ${input.intoDirectoryId}`);
    }
    const pack = this.packs.get(input.candidateId);
    if (!pack) {
      return { status: "failed", materializedFileIds: [] };
    }
    const materializedFileIds: string[] = [];
    for (const file of pack.files) {
      const segments = file.path.split("/").filter((segment) => segment.length > 0);
      const name = segments.pop() ?? file.path;
      const dirId = this.ensurePath(input.intoDirectoryId, segments);
      const id = this.nextId("file");
      this.files.set(id, { id, name, parentId: dirId, sizeBytes: file.sizeBytes });
      materializedFileIds.push(id);
    }
    return { status: "succeeded", materializedFileIds };
  }

  /** Recursive, path-preserving snapshot of everything under a directory. */
  async listTree(input: { directoryId: string }): Promise<SimTreeFile[]> {
    if (!this.dirs.has(input.directoryId)) {
      throw new Error(`SIM_DIR_NOT_FOUND: ${input.directoryId}`);
    }
    const out: SimTreeFile[] = [];
    const walk = (dirId: string, prefix: string): void => {
      for (const file of this.files.values()) {
        if (file.parentId === dirId) {
          out.push({
            id: file.id,
            path: `${prefix}${file.name}`,
            sizeBytes: file.sizeBytes,
            isVideo: VIDEO_EXTENSIONS.test(file.name),
          });
        }
      }
      for (const dir of this.dirs.values()) {
        if (dir.parentId === dirId) {
          walk(dir.id, `${prefix}${dir.name}/`);
        }
      }
    };
    walk(input.directoryId, "");
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Move files (by id) into a target directory. 115 never overwrites: a name
   *  already present in the target is materialized as `base (1).ext` — the very
   *  collision that turns overlapping packs into duplicate episodes. */
  async moveFiles(input: { fileIds: string[]; targetDirectoryId: string }): Promise<{ moved: string[] }> {
    if (!this.dirs.has(input.targetDirectoryId)) {
      throw new Error(`SIM_DIR_NOT_FOUND: ${input.targetDirectoryId}`);
    }
    const moved: string[] = [];
    for (const fileId of input.fileIds) {
      const file = this.files.get(fileId);
      if (!file) {
        throw new Error(`SIM_FILE_NOT_FOUND: ${fileId}`);
      }
      file.name = this.collisionFreeName(input.targetDirectoryId, file.name);
      file.parentId = input.targetDirectoryId;
      moved.push(fileId);
    }
    return { moved };
  }

  async deleteFiles(input: { fileIds: string[] }): Promise<{ deleted: string[] }> {
    const deleted: string[] = [];
    for (const fileId of input.fileIds) {
      if (this.files.delete(fileId)) {
        deleted.push(fileId);
      }
    }
    return { deleted };
  }

  private collisionFreeName(directoryId: string, name: string): string {
    const taken = new Set(
      [...this.files.values()].filter((file) => file.parentId === directoryId).map((file) => file.name),
    );
    if (!taken.has(name)) {
      return name;
    }
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let suffix = 1; ; suffix += 1) {
      const candidate = `${base} (${suffix})${ext}`;
      if (!taken.has(candidate)) {
        return candidate;
      }
    }
  }

  private ensurePath(parentId: string, segments: string[]): string {
    let current = parentId;
    for (const segment of segments) {
      const existing = [...this.dirs.values()].find(
        (dir) => dir.parentId === current && dir.name === segment,
      );
      if (existing) {
        current = existing.id;
        continue;
      }
      const id = this.nextId("dir");
      this.dirs.set(id, { id, name: segment, parentId: current });
      current = id;
    }
    return current;
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_${this.sequence}`;
  }
}
