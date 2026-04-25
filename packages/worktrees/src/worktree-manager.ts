import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorktreeCreateOptions {
  repoRoot: string;
  taskId: string;
  slug: string;
  baseRef?: string | undefined;
  worktreesRoot?: string | undefined;
  requireCleanBase?: boolean | undefined;
}

export interface WorktreeLease {
  taskId: string;
  branchName: string;
  path: string;
  baseRef: string;
  createdAt: string;
}

export interface WorktreeReleaseOptions {
  repoRoot: string;
  worktreePath: string;
  allowDirty?: boolean | undefined;
  remove?: boolean | undefined;
}

export interface WorktreeReleaseResult {
  dirty: boolean;
  status: string;
  diffSummary: string;
  removed: boolean;
}

export class WorktreeManager {
  public async createLease(options: WorktreeCreateOptions): Promise<WorktreeLease> {
    const repoRoot = path.resolve(options.repoRoot);
    const baseRef = options.baseRef ?? "HEAD";
    const requireCleanBase = options.requireCleanBase ?? true;

    if (requireCleanBase) {
      const status = await git(repoRoot, ["status", "--porcelain"]);
      if (status.stdout.trim().length > 0) {
        throw new Error("Refusing to create worktree from a dirty base repository.");
      }
    }

    const branchName = `llm-mem/${sanitizeSegment(options.taskId)}-${sanitizeSegment(options.slug)}`;
    const worktreesRoot =
      options.worktreesRoot ??
      path.resolve(path.dirname(repoRoot), `${path.basename(repoRoot)}.worktrees`);
    const worktreePath = path.join(worktreesRoot, `${sanitizeSegment(options.taskId)}-${sanitizeSegment(options.slug)}`);

    await mkdir(worktreesRoot, { recursive: true });
    await git(repoRoot, ["worktree", "add", "-b", branchName, worktreePath, baseRef]);

    return {
      taskId: options.taskId,
      branchName,
      path: worktreePath,
      baseRef,
      createdAt: new Date().toISOString()
    };
  }

  public async release(options: WorktreeReleaseOptions): Promise<WorktreeReleaseResult> {
    const repoRoot = path.resolve(options.repoRoot);
    const worktreePath = path.resolve(options.worktreePath);
    const status = await git(worktreePath, ["status", "--porcelain"]);
    const dirty = status.stdout.trim().length > 0;
    const diffSummary = dirty ? (await git(worktreePath, ["diff", "--stat"])).stdout.trim() : "";

    if (dirty && options.allowDirty !== true) {
      throw new Error("Refusing to release a dirty worktree without explicit allowDirty.");
    }

    let removed = false;
    if (options.remove !== false) {
      await git(repoRoot, ["worktree", "remove", worktreePath]);
      removed = true;
    }

    return {
      dirty,
      status: status.stdout,
      diffSummary,
      removed
    };
  }
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function sanitizeSegment(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
