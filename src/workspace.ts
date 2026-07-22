import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileMtime, getBranchName, getHeadSha, repoName, scanAgainstCheckpoint, scanAgainstHead, type FilePair } from "./git.js";
import type { ChangedFile, FileContents, ReviewCheckpoint, ReviewMode, WorkspaceState } from "./types.js";

export class WorkspaceModel {
  private mode: ReviewMode = "checkpoint";
  private checkpoint: ReviewCheckpoint | null;
  private readonly initialHead: string | null;
  private pairsByMode = new Map<ReviewMode, Map<string, FilePair>>();
  private previousFingerprints = new Map<string, string>();
  private recentAt = new Map<string, number>();
  private branch: string | null = null;

  private constructor(
    private readonly pi: ExtensionAPI,
    readonly repoRoot: string,
    checkpoint: ReviewCheckpoint | null,
    initialHead: string | null,
  ) {
    this.checkpoint = checkpoint;
    this.initialHead = initialHead;
  }

  static async create(pi: ExtensionAPI, repoRoot: string, checkpoint: ReviewCheckpoint | null): Promise<WorkspaceModel> {
    return new WorkspaceModel(pi, repoRoot, checkpoint, await getHeadSha(pi, repoRoot));
  }

  get currentMode(): ReviewMode {
    return this.mode;
  }

  get currentCheckpoint(): ReviewCheckpoint | null {
    return this.checkpoint;
  }

  setMode(mode: ReviewMode): void {
    this.mode = mode;
  }

  setCheckpoint(checkpoint: ReviewCheckpoint): void {
    this.checkpoint = checkpoint;
    this.recentAt.clear();
    this.previousFingerprints.clear();
    this.pairsByMode.clear();
  }

  private checkpointBaseline(): Pick<ReviewCheckpoint, "headSha" | "overrides"> {
    return this.checkpoint ?? { headSha: this.initialHead, overrides: {} };
  }

  async refresh(agentPaths: string[] = [], initializeRecent = false): Promise<WorkspaceState> {
    const [checkpointPairs, headPairs, branch] = await Promise.all([
      scanAgainstCheckpoint(this.pi, this.repoRoot, this.checkpointBaseline()),
      scanAgainstHead(this.pi, this.repoRoot),
      getBranchName(this.pi, this.repoRoot),
    ]);
    this.branch = branch;
    this.pairsByMode.set("checkpoint", new Map(checkpointPairs.map((pair) => [pair.path, pair])));
    this.pairsByMode.set("head", new Map(headPairs.map((pair) => [pair.path, pair])));

    const nextFingerprints = new Map(checkpointPairs.map((pair) => [pair.path, pair.fingerprint]));
    if (initializeRecent && this.recentAt.size === 0) {
      await Promise.all(checkpointPairs.map(async (pair) => {
        this.recentAt.set(pair.path, await fileMtime(this.repoRoot, pair.path) || Date.now());
      }));
    }

    const now = Date.now();
    for (const path of agentPaths) {
      const pair = nextFingerprints.get(path);
      if (pair != null && pair !== this.previousFingerprints.get(path)) this.recentAt.set(path, now);
    }
    for (const [path, fingerprint] of nextFingerprints) {
      if (agentPaths.includes(path) && fingerprint !== this.previousFingerprints.get(path)) this.recentAt.set(path, now);
    }
    for (const path of [...this.recentAt.keys()]) {
      if (!nextFingerprints.has(path)) this.recentAt.delete(path);
    }
    this.previousFingerprints = nextFingerprints;
    return this.state();
  }

  state(): WorkspaceState {
    const toChangedFile = (pair: FilePair): ChangedFile => ({
      path: pair.path,
      status: pair.status,
      fingerprint: pair.fingerprint,
      recentAt: this.recentAt.get(pair.path),
    });
    const files = [...(this.pairsByMode.get(this.mode)?.values() ?? [])].map(toChangedFile);
    const pendingFiles = [...(this.pairsByMode.get("checkpoint")?.values() ?? [])].map(toChangedFile);
    const recentPaths = [...this.recentAt.entries()]
      .filter(([path]) => this.pairsByMode.get("checkpoint")?.has(path))
      .sort((a, b) => b[1] - a[1])
      .map(([path]) => path);

    return {
      repoRoot: this.repoRoot,
      repoName: repoName(this.repoRoot),
      branch: this.branch,
      mode: this.mode,
      hasCheckpoint: this.checkpoint != null,
      checkpointCreatedAt: this.checkpoint?.createdAt,
      files,
      pendingFiles,
      recentPaths,
    };
  }

  getFile(path: string, mode: ReviewMode): FileContents {
    const pair = this.pairsByMode.get(mode)?.get(path);
    if (pair == null) throw new Error(`${path} is no longer changed in this mode.`);
    return {
      path,
      mode,
      fingerprint: pair.fingerprint,
      originalContent: pair.originalContent,
      modifiedContent: pair.modifiedContent,
    };
  }

  checkpointChangedPaths(): string[] {
    return [...(this.pairsByMode.get("checkpoint")?.keys() ?? [])];
  }
}
